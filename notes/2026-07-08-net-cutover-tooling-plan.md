# Net cutover operational runbook

Date: 2026-07-08; re-baselined 2026-07-12.

This is the current operator runbook for the owner-run production cutover.
Implementation history remains in Git. The normative behavior and rollback
contract are in `spec/operations/net-cutover.md` NC1-NC8; that spec wins on
any disagreement.

## Current state

- `net-cutover` contains the complete dual-stack Worker and the accepted
  single-region initial-stability fixes. Production still selects v2 and its
  net namespace is empty.
- The accepted isolated canary served 30 guests, including 22 elastic guests,
  and accepted 600/600 turns across eight gateway shards. AE-weighted global
  latency was p50 173 ms, p95 349 ms, p99 397 ms; queue p99 was 0 ms; no
  timeout, retry, reconstruction, outbox failure, abandonment, or fanout gap
  was observed. See `notes/2026-07-11-net-canary-envelope.md`.
- Public selection is **not DNS**. The same Worker owns both stacks.
  `WOO_NET_DEFAULT=1` makes the browser select `/net-api` and maps public
  `/mcp` to `/net-api/mcp`. With the value absent/false, both remain v2.
- v2 REST (`/api/*`), `/connect`, and `/v2/*` are not compatibility-mapped.
  They remain frozen after selection. Known consumers must migrate first.

## Open gates

These must be closed before public selection, even if the branch is merged and
the dual-stack Worker is redeployed with net selection off:

1. **Real identity rehearsal.** Exercise carried production identity against
   an isolated namespace and prove one real apikey plus one real account
   password. An unfrozen export proves identity shape only; it does not prove
   the acknowledged freeze fence. A full rehearsal requires either a brief
   owner-approved v2 freeze or an independently consistent production snapshot.
2. **Global presence semantics.** *(Code complete; deployed confirmation
   remains.)* The global enumerations are removed: `who_all` is
   presence-scoped (`active_actors` of the caller's room), `connected_players`
   is retired (tombstoned `_dead_connected_players`), and `join_player`
   resolves only an explicit `$player` ref (no `this.objects` scan). No-arg
   `@who` lists the caller's co-present room roster. Sparse planning consumes
   exact session/lineage/live projections carried by the room authority's
   owner-sequenced `session_presence` rows; a regression test rehydrates a
   gateway without the peer's cluster cells and still returns both actors with
   no per-occupant RPC. **Remaining (owner-gated):** run
   `load:net-canary -- --enforce-who` against
   a deployed multi-shard canary and confirm every guest returns the complete
   co-present roster (the driver now enters all guests into one room and fails
   on any partial or inconclusive result). This is a deploy-only signal the
   workerd-local lanes cannot produce.
3. **Deployed scale envelope.** Measure per-shard saturation, sustained rate,
   a room larger than 30 occupants, geographically separated traffic, cold vs
   warm shard attribution, memory/growth during a soak, and recovery after
   induced RPC delay. The 1.78 s maximum in the accepted run is unattributed.
4. **Compatibility inventory.** Confirm no production caller still requires
   v2 REST, `/connect`, or `/v2/*` after the switch. Public MCP and the browser
   are mapped; the other contracts are not.

Deletion readiness now has an executable structural gate: `npm run
build:net-only` builds the SPA without the v2 browser-worker asset and dry-runs
`src/worker/net-only-index.ts`, whose only DO exports/bindings are
`NetGatewayDO` and `NetScopeDO`. This proves the replacement stack can bundle
without the large v2 server implementations; it does not close the functional
backlog in `notes/2026-07-12-v2-compat-inventory.md`.

Native Gap-0 ports are not an availability gate. Native verb definitions ride
net verb cells and execute through planning-world native capabilities; the
remaining ports in `notes/2026-07-12-gap0-native-ports-followup.md` are
layering work. Their global-enumeration semantics can still be a gate, as above.

## Pre-merge baseline

Run from a clean `net-cutover` worktree:

```sh
npm run typecheck
npm test
npm run test:worker
npm run build:net-only
npm run smoke:cf-dev
npm run smoke:net-dev
npm run install:net-dev
npm run smoke:net-mcp
npm run e2e:net
```

Review `git diff main...net-cutover`, specs, docs, migrations, and dead code.
Fast-forward merge only after the branch and origin are aligned. Do not modify
or discard unrelated files in the main worktree.

## Dual-stack production baseline

After an explicitly approved merge and deploy:

1. Ensure `WOO_NET_DEFAULT` and `WOO_WRITE_FREEZE` are absent.
2. Deploy through `npm run deploy`; this is a shared Worker deploy, not a
   net-only action.
3. Verify `/healthz`, the v2 browser, v2 MCP walkthrough, and
   `/client-config -> {"net":false}`.
4. Verify `/net-api/guest` still returns `E_NOT_INSTALLED` on the pristine
   production net namespace.
5. Record Worker version, commit, and rollback version.

## Isolated identity rehearsal

Use a standalone Wrangler config with no `routes`; never use `[env.canary]`
under the production config. Store artifacts under ignored
`cutover-artifacts/`; `identity-export.ts` writes mode 0600.

For a shape-only rehearsal, `--allow-unfrozen` is permitted and must be marked
non-fence evidence. For a full rehearsal, first hold both freeze halves using
the commands below, export, install into a fresh isolated namespace, prove both
credential classes, then clear both halves. Never seed rehearsal data into the
production target namespace.

The export contains hashes/verifiers, not plaintext probes. Read the real
apikey and password from the owner at operation time. Keep them out of argv:

```sh
read -sr WOO_VERIFY_APIKEY; export WOO_VERIFY_APIKEY
read -sr WOO_VERIFY_PASSWORD; export WOO_VERIFY_PASSWORD
```

## Scaling canary

Deploy only `wrangler.net-canary.template.toml` with a dedicated KV namespace
and no custom-domain routes. Drive at least 500 turns and all configured shards;
for `who_all` acceptance, use enough guests to guarantee multiple shards and
pass `--enforce-who`.

```sh
npx wrangler deploy -c wrangler.net-canary.template.toml
npm run load:net-canary -- --base-url https://<canary>.workers.dev \
  --actors 30 --rounds 10 --requests-per-actor 2 --enforce-who
CF_ACCOUNT_ID=... CF_ANALYTICS_TOKEN=... npm run metrics:net-ae -- \
  --dataset woo_v1_net_canary --from <ISO_START> --min-turns 500
npx wrangler delete -c wrangler.net-canary.template.toml
```

Tail is diagnostic only. It is sampled under load and cannot satisfy an
acceptance envelope.

## Production cutover

Owner-run, in order. Define `BASE=https://woah1.generalbusiness.ai` and a unique
`GEN=cutover-<UTC timestamp>`. Record every command, response, Worker version,
namespace, epoch, and watermark in the cutover receipt.

### 0. Preflight

- All open gates above are closed with linked evidence.
- The deployed commit equals the reviewed commit; `WOO_NET_DEFAULT` is off.
- The production net namespace is fresh; install refuses are as expected.
- Rollback version and responsible operators are present.
- AE token/account access is proven before the maintenance window.

### 1. Freeze v2: both halves

Set the instant configuration half:

```sh
npx wrangler secret put WOO_WRITE_FREEZE
# enter: 1
```

Set the persisted CAS half using the signed operator tool:

```sh
WOO_INTERNAL_SECRET=... npm run cutover:freeze -- \
  --base-url "$BASE" --generation "$GEN" --expected-generation none
```

Wait at least 15 seconds for cached host verdicts. Confirm a v2 mutation and
new session return `503 E_MAINTENANCE`; `/healthz`, `/admin`, `/net-api`, and
signed `/net-install` remain reachable.

### 2. Export the quiescent identity

```sh
mkdir -p cutover-artifacts
WOO_INTERNAL_SECRET=... npx tsx scripts/identity-export.ts \
  --base-url "$BASE" --out cutover-artifacts/identity-export.json
```

The tool reads twice and writes only when full-world watermarks match. A first
mismatch can be cold housekeeping; wait and retry. A persistent mismatch means
the fence is not holding: stop. Record the echoed generation and watermark.

### 3. Install, verify, activate

```sh
read -sr WOO_VERIFY_APIKEY; export WOO_VERIFY_APIKEY
read -sr WOO_VERIFY_PASSWORD; export WOO_VERIFY_PASSWORD
WOO_INTERNAL_SECRET=... npx tsx scripts/net-install.ts \
  --base-url "$BASE" --identity cutover-artifacts/identity-export.json
unset WOO_VERIFY_APIKEY WOO_VERIFY_PASSWORD
```

`WOO_VERIFY_APIKEY` is `apikey:<id>:<secret>` and
`WOO_VERIFY_PASSWORD` is `email:password`. Both probes must mint through the
real net surfaces. Any failure deactivates before aborting. Once a probe commits,
`E_SEED_COMMITTED` makes recovery a fresh namespace, not an installer rerun.

### 4. Public selection

```sh
npx wrangler secret put WOO_NET_DEFAULT
# enter: 1
```

Do not change DNS. Verify `/client-config -> {"net":true}` with `no-store`, a
fresh browser reaches the identity door, public `/mcp` initializes through
`woo-net`, guest and carried-account chat work, and v2 REST remains frozen.
The first successful net session/turn is the point of no return.

### 5. AE bake

Start from a timestamp captured immediately before selection:

```sh
CF_ACCOUNT_ID=... CF_ANALYTICS_TOKEN=... npm run metrics:net-ae -- \
  --dataset woo_v1_prod --from <ISO_START> --watch \
  --min-seconds 120 --max-seconds 600 --min-turns 500 \
  --max-error-rate 0.01 --max-wall-p99-ms 500 \
  --max-queue-p99-ms 1000 --min-gateway-shards 2
```

The watch aborts immediately on RPC timeout, queue refusal, outbox failure or
abandonment, fanout gap, degraded install/adoption, or related integrity signal.
It passes only after both duration and the complete evidence envelope are met,
and exits 2 at the deadline if AE remains insufficient. Run the deployed MCP
walkthrough and real-browser cross-user scenario during the window.

### 6. Rollback or commit

Before the first net write only, disable public selection, then clear both
freeze halves:

```sh
npx wrangler secret delete WOO_NET_DEFAULT
WOO_INTERNAL_SECRET=... npm run cutover:freeze -- \
  --base-url "$BASE" --generation none --expected-generation "$GEN"
npx wrangler secret delete WOO_WRITE_FREEZE
```

After the first net write, rollback would discard authoritative data and is
forbidden; use forward recovery. After the bake passes, retain frozen v2 for
the agreed audit period, archive the receipt securely, then explicitly approve
retirement/deletion.
