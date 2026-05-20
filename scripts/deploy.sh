#!/usr/bin/env bash
# deploy.sh — guard-railed Cloudflare deploy for woo.
#
# Phases: preflight → build → deploy → postflight. Any failure aborts loud.
# Overrides exist for hotfix flows but should not be the default path.
#
# Usage: scripts/deploy.sh [--dry-run] [--dirty] [--allow-branch=<x>]
#                          [--skip-tests] [--skip-postflight] [--skip-smoke]
#                          [--help]
#
# --skip-smoke skips only the cross-actor walkthrough smoke at the end of
# postflight (healthz / auth / ws / mcp routing still run). Use for
# emergency redeploys when the walkthrough is flaky against the new
# deploy but the worker-level checks pass. Equivalent to WOO_DEPLOY_SMOKE=0.
#
# --dry-run validates the deploy without uploading: runs preflight gates and
# build, then `wrangler deploy --dry-run` (no upload, no version id, no
# postflight). Implies leniency on dirty tree / unpushed HEAD and skips the
# CF token + secret-list checks, which only matter for a real upload.

set -euo pipefail

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
BOLD=$'\033[1m'; DIM=$'\033[2m'; NC=$'\033[0m'

ALLOW_DIRTY=0
ALLOW_BRANCH=""
SKIP_TESTS=0
SKIP_POSTFLIGHT=0
SKIP_SMOKE=0
DRY_RUN=0
EXPECTED_BRANCH="main"
WORKER_URL="${WOO_WORKER_URL:-https://woah.generalbusiness.ai}"
POSTFLIGHT_TIMEOUT="${WOO_POSTFLIGHT_TIMEOUT:-45}"
# --no-install forces resolution to the project-local wrangler pinned in
# package.json/package-lock.json. Without it, npx silently downloads whatever
# wrangler version is current at execution time, which can change deploy
# validation, migration handling, or output parsing independent of this repo.
WRANGLER=(npx --no-install wrangler)

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
}

banner() { echo; echo "${BOLD}== $* ==${NC}"; }
ok()     { echo "  ${GREEN}ok${NC}    $*"; }
warn()   { echo "  ${YELLOW}warn${NC}  $*"; }
fail()   { echo "  ${RED}FAIL${NC}  $*" >&2; exit 1; }

# Postflight retry helper. Curl-only probe + status-code accept-set, retried
# with linear backoff. Worker rollout to Cloudflare's edge isn't instantaneous,
# so a single-shot postflight check can race a stale-version response (e.g.
# /mcp POST returning 405 from a still-cached SPA-fallback view, or
# /api/auth wizard claim returning a propagation-quirk 405 instead of 401).
# The check waits up to ~12s for the new version to be reachable from the
# probing edge before declaring failure. Each attempt obeys POSTFLIGHT_TIMEOUT
# individually; total wall-time = attempts * POSTFLIGHT_TIMEOUT in the worst
# case, but typically completes on the first attempt.
#
# Usage:
#   retry_status_until <expected_status> <method> <url> [curl-args...]
#   echo "$RETRY_BODY"  # last response body
# Returns 0 if a probe matched the expected status, 1 otherwise.
retry_status_until() {
  local expected="$1"; shift
  local method="$1"; shift
  local url="$1"; shift
  local attempts=6
  local sleep_seconds=2
  local body status
  for ((i = 1; i <= attempts; i++)); do
    body=$(curl -sS --max-time "$POSTFLIGHT_TIMEOUT" -X "$method" -w '\n%{http_code}' "$url" "$@" 2>/dev/null) || body=""
    status="${body##*$'\n'}"
    RETRY_BODY="${body%$'\n'*}"
    if [[ "$status" == "$expected" ]]; then
      RETRY_STATUS="$status"
      RETRY_ATTEMPTS="$i"
      return 0
    fi
    [[ $i -lt $attempts ]] && sleep "$sleep_seconds"
  done
  RETRY_STATUS="$status"
  RETRY_ATTEMPTS="$attempts"
  return 1
}

POSTFLIGHT_SESSIONS=()
cleanup_postflight_sessions() {
  local sid status
  for sid in "${POSTFLIGHT_SESSIONS[@]:-}"; do
    [[ -n "$sid" ]] || continue
    status=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' \
      -X DELETE "$WORKER_URL/api/session" \
      -H "authorization: Session $sid" 2>/dev/null || true)
    if [[ "$status" != "200" && "$status" != "401" && "$status" != "404" ]]; then
      warn "postflight session cleanup for $sid returned $status"
    fi
  done
}
trap cleanup_postflight_sessions EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)          DRY_RUN=1 ;;
    --dirty)            ALLOW_DIRTY=1 ;;
    --allow-branch=*)   ALLOW_BRANCH="${1#--allow-branch=}" ;;
    --skip-tests)       SKIP_TESTS=1 ;;
    --skip-postflight)  SKIP_POSTFLIGHT=1 ;;
    --skip-smoke)       SKIP_SMOKE=1 ;;
    -h|--help)          usage; exit 0 ;;
    *)                  fail "unknown flag: $1 (try --help)" ;;
  esac
  shift
done

# Dry-run has no upload, no published version, and no postflight target,
# so the working-tree / push-state gates are irrelevant — relax them.
if [[ $DRY_RUN -eq 1 ]]; then
  ALLOW_DIRTY=1
  SKIP_POSTFLIGHT=1
fi

cd "$(dirname "$0")/.."

# ===========================================================================
banner "Preflight"
# ===========================================================================

# branch
current_branch=$(git rev-parse --abbrev-ref HEAD)
if [[ -n "$ALLOW_BRANCH" ]]; then
  [[ "$current_branch" == "$ALLOW_BRANCH" ]] \
    || fail "expected branch '$ALLOW_BRANCH', got '$current_branch'"
  warn "deploying from non-main branch: $current_branch"
elif [[ "$current_branch" != "$EXPECTED_BRANCH" ]]; then
  fail "on branch '$current_branch'; expected '$EXPECTED_BRANCH' — pass --allow-branch=$current_branch to override"
fi
ok "branch: $current_branch"

# clean working tree
if [[ -n "$(git status --porcelain)" ]]; then
  if [[ $ALLOW_DIRTY -eq 1 ]]; then
    warn "deploying with uncommitted changes"
  else
    git status --short
    fail "working tree dirty — commit, stash, or pass --dirty to override"
  fi
else
  ok "working tree clean"
fi

# HEAD pushed
local_head=$(git rev-parse HEAD)
remote_head=$(git ls-remote origin "$current_branch" 2>/dev/null | awk '{print $1}' | head -1)
if [[ -z "$remote_head" ]]; then
  if [[ $ALLOW_DIRTY -eq 1 ]]; then
    warn "remote branch origin/$current_branch missing — first push?"
  else
    fail "remote branch origin/$current_branch not found — push or pass --dirty"
  fi
elif [[ "$local_head" != "$remote_head" ]]; then
  if [[ $ALLOW_DIRTY -eq 1 ]]; then
    warn "local HEAD ($local_head) differs from origin/$current_branch ($remote_head)"
  else
    fail "local HEAD not pushed — git push, or pass --dirty to override"
  fi
fi
ok "git: HEAD=${local_head:0:10} pushed"

# wrangler must resolve to the project-local pinned version. `npx --no-install`
# refuses to download; if this fails the operator hasn't run `npm install`.
wrangler_version=$("${WRANGLER[@]}" --version 2>&1) \
  || fail "local wrangler not installed — run: npm install"
ok "wrangler: $(echo "$wrangler_version" | tail -1) (project-local)"

# CF token + secrets are only needed for a real upload.
if [[ $DRY_RUN -eq 1 ]]; then
  warn "dry-run: skipping cf token + secret-list checks"
else
  if [[ -z "${CLOUDFLARE_API_TOKEN:-}" && -f "$HOME/.config/cloudflare/woo.token" ]]; then
    CLOUDFLARE_API_TOKEN=$(cat "$HOME/.config/cloudflare/woo.token")
    export CLOUDFLARE_API_TOKEN
  fi
  [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] \
    || fail "CLOUDFLARE_API_TOKEN unset and ~/.config/cloudflare/woo.token missing"
  ok "cf token present"

  secret_list=$("${WRANGLER[@]}" secret list 2>&1) \
    || fail "wrangler secret list failed:\n$secret_list"
  for required in WOO_INITIAL_WIZARD_TOKEN WOO_INTERNAL_SECRET; do
    echo "$secret_list" | grep -q "\"$required\"" \
      || fail "wrangler secret '$required' not set — run: npx --no-install wrangler secret put $required"
    ok "secret: $required set"
  done
fi

# Durable Object class-history migrations are CF deployment bookkeeping. The
# check keeps wrangler.toml's final migrated class set aligned with bindings.
npm run cf:migrations:check >/dev/null 2>&1 \
  || fail "CF DO migration history is out of sync — run: npm run cf:migrations"
ok "cf do migrations aligned"

# typecheck (cheap; runs prebuild catalog index regen)
npm run typecheck >/dev/null 2>&1 || fail "typecheck failed — run: npm run typecheck"
ok "typecheck clean"

# tests
if [[ $SKIP_TESTS -eq 1 ]]; then
  warn "skipping npm test"
else
  test_out=$(npm test 2>&1) || { echo "$test_out" | tail -30; fail "tests failed"; }
  ok "tests pass ($(echo "$test_out" | grep -oE 'Tests +[0-9]+ passed' | head -1))"
fi

# ===========================================================================
banner "Build"
# ===========================================================================

build_out=$(npm run build 2>&1) \
  || { echo "$build_out" | tail -20; fail "build failed"; }
ok "spa bundled to dist/"

# ===========================================================================
banner "Deploy"
# ===========================================================================

if [[ $DRY_RUN -eq 1 ]]; then
  deploy_out=$("${WRANGLER[@]}" deploy --dry-run 2>&1) \
    || { echo "$deploy_out" | tail -30; fail "wrangler deploy --dry-run failed"; }
  echo "$deploy_out" | tail -10 | sed "s/^/  ${DIM}|${NC} /"
  ok "wrangler dry-run validated bundle + bindings (no upload)"
  echo
  echo "${GREEN}${BOLD}dry-run ok${NC} (nothing deployed)"
  exit 0
fi

deploy_out=$("${WRANGLER[@]}" deploy 2>&1) \
  || { echo "$deploy_out" | tail -30; fail "wrangler deploy failed"; }
echo "$deploy_out" | tail -8 | sed "s/^/  ${DIM}|${NC} /"
version_id=$(echo "$deploy_out" | grep -oE 'Current Version ID: [a-f0-9-]+' | awk '{print $4}')
[[ -n "$version_id" ]] || fail "wrangler deploy returned no version id (output above)"
ok "version: $version_id"

# ===========================================================================
banner "Postflight"
# ===========================================================================

if [[ $SKIP_POSTFLIGHT -eq 1 ]]; then
  warn "skipping postflight verification"
  echo
  echo "${GREEN}${BOLD}deploy ok${NC} version=$version_id url=$WORKER_URL"
  exit 0
fi

# /healthz
healthz=$(curl -sS --max-time "$POSTFLIGHT_TIMEOUT" "$WORKER_URL/healthz") \
  || fail "healthz request failed"
echo "$healthz" | grep -q '"ok":true' || fail "healthz body unhealthy: $healthz"
ok "healthz: $healthz"

# Unsigned public access to the reserved internal namespace must fail before
# any DO handler trusts forwarded authority. Signed internal calls are
# exercised below by /api/state aggregation when routed hosts are present.
internal_status=$(curl -sS --max-time "$POSTFLIGHT_TIMEOUT" -o /dev/null -w '%{http_code}' \
  "$WORKER_URL/__internal/state") \
  || fail "unsigned internal route probe failed"
[[ "$internal_status" == "401" ]] \
  || fail "unsigned internal route returned $internal_status (expected 401)"
ok "unsigned internal route rejected: 401"

# guest auth
auth_out=$(curl -sS --max-time "$POSTFLIGHT_TIMEOUT" -X POST "$WORKER_URL/api/auth" \
  -H 'content-type: application/json' -d '{"token":"guest:"}')
sid=$(echo "$auth_out" | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).session||"")}catch{console.log("")}})')
[[ -n "$sid" ]] || fail "auth failed: $auth_out"
POSTFLIGHT_SESSIONS+=("$sid")
ok "auth: session=$sid"

# /api/state — exercises gateway + cluster aggregate. Capture the body so
# we can pick a live non-universal object id for the cluster-route check
# below without hardcoding any catalog name.
state_body=$(curl -sS --max-time "$POSTFLIGHT_TIMEOUT" \
  "$WORKER_URL/api/state" -H "authorization: Session $sid")
# Avoid `echo … | head -c 2 | grep` here — pipefail trips when the body is
# large enough that echo gets SIGPIPE before head closes the pipe.
[[ "${state_body:0:1}" == "{" ]] \
  || fail "/api/state did not return JSON: $(printf '%s' "$state_body" | head -c 200)"
ok "/api/state: 200 ($(printf '%s' "$state_body" | wc -c | tr -d ' ') bytes)"

# universal-class describe via gateway (no catalog assumption)
wiz_body=$(curl -sS --max-time "$POSTFLIGHT_TIMEOUT" "$WORKER_URL/api/objects/\$wiz" \
  -H "authorization: Session $sid")
echo "$wiz_body" | grep -q '"id":"$wiz"' \
  || fail "describe \$wiz failed: $wiz_body"
ok "describe \$wiz: ok"

# Cluster routing: discover one non-universal id from /api/state's objects
# map and describe it. Skips $-prefixed core classes and the actor itself,
# so it lands on a catalog-installed instance if any are present. No
# catalog-name literal anywhere in this script (per F050).
sample_target=$(node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    try {
      const state = JSON.parse(s);
      const actor = state.actor ?? null;
      const ids = Object.keys(state.objects ?? {});
      const pick = ids.find(id => !id.startsWith("$") && id !== actor);
      if (pick) console.log(pick);
    } catch {}
  })
' <<< "$state_body" || true)
if [[ -n "$sample_target" ]]; then
  sample_body=$(curl -sS --max-time "$POSTFLIGHT_TIMEOUT" \
    "$WORKER_URL/api/objects/$sample_target" -H "authorization: Session $sid")
  echo "$sample_body" | grep -q "\"id\":\"$sample_target\"" \
    || fail "describe $sample_target failed: $sample_body"
  ok "describe $sample_target: ok (catalog-routed describe round-trip)"
else
  warn "no non-universal object in /api/state; skipped cluster-route check"
fi

# WebSocket handshake: upgrade to the v2 turn-network endpoint (the legacy
# /ws was removed 2026-05-15 and now returns 410). Re-uses the REST $sid as
# the bearer token, expects the server to emit a transport-hello followed
# by the initial state-transfer envelope. Read-only — the existing session
# is just attached to a fresh socket. Catches WS regressions that REST
# routes happen to bypass (gateway socket plumbing, v2 envelope codec).
ws_base="${WORKER_URL/https:/wss:}/v2/turn-network/ws"
ws_state=$(WS_BASE="$ws_base" WS_SID="$sid" WS_TIMEOUT="$POSTFLIGHT_TIMEOUT" node --input-type=module -e "
  import { WebSocket } from 'ws';
  const url = new URL(process.env.WS_BASE);
  url.searchParams.set('token', 'session:' + process.env.WS_SID);
  url.searchParams.set('node', 'postflight-' + Date.now());
  const ws = new WebSocket(url.toString(), 'woo-v2.turn-network.json');
  const t = setTimeout(() => { console.error('timeout'); process.exit(1); }, Number(process.env.WS_TIMEOUT) * 1000);
  let sawHello = false;
  ws.on('message', (data) => {
    try {
      const env = JSON.parse(String(data));
      if (env.type === 'woo.transport.hello.v1') sawHello = true;
      if (env.type === 'woo.state.transfer.shadow.v1') {
        if (!sawHello) { clearTimeout(t); console.error('state-transfer arrived before transport-hello'); process.exit(1); }
        clearTimeout(t);
        console.log('hello+transfer');
        ws.close();
        process.exit(0);
      }
      if (env.type === 'woo.transport.error.v1') {
        clearTimeout(t); console.error('error frame: ' + JSON.stringify(env.body)); process.exit(1);
      }
    } catch {}
  });
  ws.on('error', (err) => { clearTimeout(t); console.error('socket: ' + err.message); process.exit(1); });
" 2>&1) || fail "v2 ws handshake failed: $ws_state"
[[ "$ws_state" == "hello+transfer" ]] || fail "v2 ws handshake unexpected: $ws_state (expected 'hello+transfer')"
ok "ws handshake (/v2/turn-network/ws): hello + state-transfer"

# Wizard claim with a decoy token. On a claimed world this returns
# E_TOKEN_CONSUMED; on a fresh world it returns a token-rejected error.
# Either way the real WOO_INITIAL_WIZARD_TOKEN is not consumed and the
# response is 401 — proves the bootstrap-claim path is wired. Retried
# via retry_status_until because CF edge rollout can momentarily serve
# a stale view (we hit a 405 here once on 2026-05-18 during the
# run_worker_first=true deploy propagation).
if retry_status_until 401 POST "$WORKER_URL/api/auth" \
    -H 'content-type: application/json' \
    -d '{"token":"wizard:woo-postflight-decoy"}'; then
  ok "wizard claim path: 401 (decoy rejected, real token untouched) [attempts=$RETRY_ATTEMPTS]"
else
  fail "wizard decoy claim returned $RETRY_STATUS after $RETRY_ATTEMPTS attempts (expected 401; if 200, the real token was consumed!)"
fi

# Lock-in for the Worker-first routing invariant. /mcp must not be
# served by the SPA static-asset fallback — that would return 405 on
# POST. Cheap insurance against a future wrangler.toml change quietly
# undoing `run_worker_first = true`. A bare initialize request with no
# session yields a 200 JSON-RPC response; 4xx is acceptable (probe
# without protocol negotiation) as long as it is NOT 405.
if retry_status_until 200 POST "$WORKER_URL/mcp" \
    -H 'mcp-token: guest:postflight' \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"postflight","version":"1"},"capabilities":{}}}'; then
  ok "mcp routing: 200 (worker-first invariant intact) [attempts=$RETRY_ATTEMPTS]"
else
  # 405 specifically means the SPA static-asset fallback caught the
  # request — the worker never ran. Other non-200 statuses indicate a
  # different issue (auth, etc.) and would surface a clearer error.
  fail "POST /mcp returned $RETRY_STATUS after $RETRY_ATTEMPTS attempts (expected 200; 405 means the SPA fallback intercepted — check wrangler.toml run_worker_first)"
fi

# Cross-actor smoke. The single-call MCP routing check above only verifies
# that the worker is reachable; it does not exercise commit-scope open,
# cross-host authority-slice RPCs, cross-room moves, or peer observation
# fan-out — every one of which can regress while healthz + routing still
# reply 200. That blind spot is what let prod deploy `555f9935` (the
# authority-slice cell rewrite) ship with cold-open RPCs blowing past the
# 5s HOST_READ_RPC_TIMEOUT ceiling. The walkthrough is the cheapest
# real-world coverage we have; allow operators to skip it (env override or
# --skip-smoke) for emergency redeploys.
if [[ "${WOO_DEPLOY_SMOKE:-1}" == "0" || $SKIP_SMOKE -eq 1 ]]; then
  warn "deploy smoke skipped (WOO_DEPLOY_SMOKE=0 or --skip-smoke)"
else
  if WOO_SMOKE_BASE_URL="$WORKER_URL" npx --no-install tsx scripts/smoke-walkthrough.ts > /tmp/woo-deploy-smoke.log 2>&1; then
    ok "smoke walkthrough: 9/9 cross-actor steps passed"
  else
    tail -20 /tmp/woo-deploy-smoke.log
    fail "smoke walkthrough failed against $WORKER_URL (see /tmp/woo-deploy-smoke.log). Roll back with: npx wrangler rollback --version-id <previous>"
  fi
fi

echo
echo "${GREEN}${BOLD}deploy ok${NC} version=$version_id url=$WORKER_URL"
