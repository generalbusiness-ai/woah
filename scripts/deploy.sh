#!/usr/bin/env bash
# deploy.sh — guard-railed Cloudflare deploy for woo.
#
# Phases: preflight → build → deploy → postflight. Any failure aborts loud.
# Overrides exist for hotfix flows but should not be the default path.
#
# Usage: scripts/deploy.sh [--dry-run] [--dirty] [--allow-branch=<x>]
#                          [--skip-tests] [--skip-postflight] [--help]
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
DRY_RUN=0
EXPECTED_BRANCH="main"
WORKER_URL="${WOO_WORKER_URL:-https://woo.inguz.workers.dev}"
POSTFLIGHT_TIMEOUT="${WOO_POSTFLIGHT_TIMEOUT:-45}"

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
}

banner() { echo; echo "${BOLD}== $* ==${NC}"; }
ok()     { echo "  ${GREEN}ok${NC}    $*"; }
warn()   { echo "  ${YELLOW}warn${NC}  $*"; }
fail()   { echo "  ${RED}FAIL${NC}  $*" >&2; exit 1; }

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

  secret_list=$(npx wrangler secret list 2>&1) \
    || fail "wrangler secret list failed:\n$secret_list"
  for required in WOO_INITIAL_WIZARD_TOKEN WOO_INTERNAL_SECRET; do
    echo "$secret_list" | grep -q "\"$required\"" \
      || fail "wrangler secret '$required' not set — run: npx wrangler secret put $required"
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
  deploy_out=$(npx wrangler deploy --dry-run 2>&1) \
    || { echo "$deploy_out" | tail -30; fail "wrangler deploy --dry-run failed"; }
  echo "$deploy_out" | tail -10 | sed "s/^/  ${DIM}|${NC} /"
  ok "wrangler dry-run validated bundle + bindings (no upload)"
  echo
  echo "${GREEN}${BOLD}dry-run ok${NC} (nothing deployed)"
  exit 0
fi

deploy_out=$(npx wrangler deploy 2>&1) \
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

# WebSocket handshake: upgrade, auth as guest, await op:session, close.
# Read-only — auth creates a guest session row but mutates nothing else.
# Catches WS regressions that REST routes happen to bypass (Phase 2.2 class).
ws_url="${WORKER_URL/https:/wss:}/ws"
ws_session=$(node --input-type=module -e "
  import { WebSocket } from 'ws';
  const ws = new WebSocket('$ws_url');
  const t = setTimeout(() => { console.error('timeout'); process.exit(1); }, Number('$POSTFLIGHT_TIMEOUT') * 1000);
  ws.on('open', () => ws.send(JSON.stringify({ op: 'auth', token: 'guest:postflight' })));
  ws.on('message', (data) => {
    try {
      const f = JSON.parse(String(data));
      if (f.op === 'session') { clearTimeout(t); console.log(f.session); ws.close(); process.exit(0); }
      if (f.op === 'error') { clearTimeout(t); console.error('ws error frame: ' + JSON.stringify(f.error)); process.exit(1); }
    } catch {}
  });
  ws.on('error', (err) => { clearTimeout(t); console.error('socket: ' + err.message); process.exit(1); });
" 2>&1) || fail "ws handshake failed: $ws_session"
[[ "$ws_session" =~ ^session-[0-9a-f]{32}$ ]] || fail "ws handshake unexpected reply: $ws_session"
POSTFLIGHT_SESSIONS+=("$ws_session")
ok "ws handshake: session=$ws_session"

# Wizard claim with a decoy token. On a claimed world this returns
# E_TOKEN_CONSUMED; on a fresh world it returns a token-rejected error.
# Either way the real WOO_INITIAL_WIZARD_TOKEN is not consumed and the
# response is 401 — proves the bootstrap-claim path is wired.
wiz_status=$(curl -sS --max-time "$POSTFLIGHT_TIMEOUT" -o /dev/null -w '%{http_code}' \
  -X POST "$WORKER_URL/api/auth" \
  -H 'content-type: application/json' \
  -d '{"token":"wizard:woo-postflight-decoy"}')
[[ "$wiz_status" == "401" ]] \
  || fail "wizard decoy claim returned $wiz_status (expected 401; if 200, the real token was consumed!)"
ok "wizard claim path: 401 (decoy rejected, real token untouched)"

echo
echo "${GREEN}${BOLD}deploy ok${NC} version=$version_id url=$WORKER_URL"
