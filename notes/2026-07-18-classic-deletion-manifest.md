# Classic/v2 stack deletion manifest (execution spec)

Date: 2026-07-18. Branch `prenet-removal`. Deploy entry moves to
`src/worker/net-only-index.ts`. Import graph traced from the KEEP roots
(`net-only-index.ts`, net client boot via the `.net-only` factory, `src/net/**`,
`src/worker/net/**`, `src/mcp/net-stdio*.ts`, `src/server/net-dev.ts`) + KEEP test
lanes. The classic DELETE set is a closed subgraph after one tsconfig alias fix.

**No merge, no deploy, no running the deleted_classes migration against prod.**
Keep every gate green at each phase: `npm run typecheck` (BOTH tsconfigs),
`npm test`, `npm run test:worker`, `npm run cf:migrations:check`,
`npm run build:net-only`.

## Corrections to the raw manifest (apply these)

- **`src/worker/admin.ts` = KEEP, `src/worker/net-default.ts` = KEEP.** The
  net-only entry imports `handleAdmin`/`AdminEnv` (net-only-index.ts:12,60) and
  `admin.ts` imports `netDefaultEnabled` from `net-default.ts`. The "/admin has no
  net coverage" flag is RESOLVED — `tests/worker/net-only-entry.test.ts` covers
  /admin on net (503 disabled / 401 unauth / 410 retired). Keep `admin.test.ts`
  too (it still passes; the classic-purge branch is exercised selector-off — but
  since net-default is now the only remaining caller shape, confirm its assertions
  still hold or trim the selector-off case).
- **GitHub "taps" (`src/core/catalog-taps.ts`, `src/server/github-taps.ts`,
  `tests/tap-install.test.ts`) = DELETE, and it is a real capability retirement.**
  Not reachable from any net root; net installs via `src/net/install.ts` + the
  `/net-install/` doorway. Update `spec/discovery/catalogs.md` to mark GitHub taps
  retired (classic-only) rather than silently dropping it.

## KEEP — trap list (classic-named, net-shared; deleting breaks prod)

`src/core/effect-transcript.ts` (net/transcript.ts:36), `shadow-commit-scope.ts`
(net/transcript.ts:37), `shadow-turn-call.ts` (net/bridge.ts:46,
gateway-do.ts:90), `shadow-turn-exec.ts` (client v2-browser-messages ← main.ts:28),
`shadow-scope-head.ts`, `shadow-state-pages.ts` (repository.ts ← net/identity.ts),
`shadow-cell-version.ts`, `shadow-known-page-cache.ts`, `authority-slice.ts`,
`turn-commit/effects/key/recorder/replay.ts`, `projection-delta.ts`,
`remote-bridge-transcript-policy.ts`, `src/client/v2-browser-messages.ts`,
`v2-browser-optimistic-lifecycle.ts`, `scoped-projection.ts`,
`v2-browser-worker-factory.net-only.ts`, `src/worker/metrics-sink.ts`,
`internal-auth.ts`, `src/server/sqlite-repository.ts`, `json-folder-repository.ts`,
`src/core/sql-shape.ts`, `src/client/env.d.ts`. Plus KEEP `admin.ts`,
`net-default.ts` (see corrections).

## DELETE — source (39; admin.ts & net-default.ts removed from the raw list)

Worker: `index.ts`, `persistent-object-do.ts`, `directory-do.ts`,
`commit-scope-do.ts`, `cf-repository.ts`, `metric-errors.ts`, `rpc-fault-inject.ts`.
MCP: `mcp/gateway.ts`, `mcp/host.ts`, `mcp/server.ts`, `mcp/stdio.ts` (KEEP
net-stdio*.ts). Server: `dev-server.ts`, `dev-v2-helpers.ts`, `dump-json.ts`,
`github-taps.ts` (KEEP net-dev.ts, sqlite/json repos). Client: all
`v2-browser-{cache,delegation,execution-cache,holder-install,intent-policy,
journal,local-turn,url,worker,worker-factory}.ts` (KEEP v2-browser-messages,
v2-browser-optimistic-lifecycle, the .net-only factory). Core: `executor.ts`,
`object-host-write-through.ts`, `v2-fanout-projection.ts`, `v2-reply-predicates.ts`,
`v2-shadow-apply.ts`, `shadow-browser-node.ts`, `shadow-relay-cache.ts`,
`shadow-relay-tail.ts`, `shadow-turn-network.ts`, `shadow-envelope.ts`,
`protocol.ts`, `catalog-taps.ts`, `browser-open-seed-contract.ts`,
`browser-activity-metric-fields.ts`.

## Tests: MIGRATE first (contract survives), then DELETE the classic set

MIGRATE (repoint, keep in lane): `tests/worker/internal-headers.test.ts` →
`net-only-index` `sanitizePublicHeaders`; `tests/worker/net-install-doorway.test.ts`
→ `net-only-index` `handleNetInstall` + `NetOnlyEnv`; `tests/catalogs.test.ts`
install harness `mcp/host` → `src/net/install.ts` (LOAD-BEARING catalog-migration
gate — must land before `mcp/host.ts` is deleted); `tests/cf-do-migrations.test.ts`
→ drop the 3 classic classes from bound/active, add the `deleted_classes` assertion.

DELETE the classic test set (contracts covered per contract-matrix rows 3–8):
all `v2-browser-*`, `shadow-*`, `dev-v2-*`, `mcp.test.ts`, `mcp-warm-authority`,
`v2-mcp-e2e`, `smoke/v2-mcp-smoke`, `session-lifecycle`, `executor.test.ts`,
`object-host-write-through`, `worker/metric-errors`, `worker/net-cutover-routing`,
`worker/net-smoke-doorway`, `worker/rpc-fault-inject`, `worker/cf-local-*`,
`worker/cf-repository`, `worker/directory-*`, `worker/d2-rpc-budget`,
`worker/v2-cost-budget`, `worker/gateway-projection-cache`,
`worker/commit-scope-checkpoint-tail`, `worker/scope-topology-seed`,
`worker/host-teardown`, `worker/net-cutover-freeze`, `a2-fanout-lineage-closure`,
`b-i-read-closure-parity`, `b-iii-incremental-merge`, `authority-slice-shape`,
`scope-executor-garden-probe`, `v2-fanout-projection`, `v2-reply-predicates`,
`v2-turn-network-spec`, `v2-shadow-apply`, `projection-create-contents`,
`session-scope-presence`, `browser-localdev-perf`, `onboarding`,
`scoped-client-projection`, `auth-credentials`, `tap-install`,
`object-repository`(if classic-repo-only), `recycle`/`outliner-migration`(only if
they import a DELETE module — re-verify; keep if substrate). Re-verify each against
the trap list before rm.

## wrangler.toml + migration

`main` → `src/worker/net-only-index.ts`. Remove bindings WOO/PersistentObjectDO,
DIRECTORY/DirectoryDO, COMMIT_SCOPE/CommitScopeDO (keep SCOPE_NET, GATEWAY_NET).
Run `npm run cf:migrations` to append (all three were `new_sqlite_classes`;
wrangler drops both kinds via `deleted_classes`):

```
[[migrations]]
tag = "cf-do-0007"
deleted_classes = [ "CommitScopeDO", "DirectoryDO", "PersistentObjectDO" ]
```

`wrangler.smoke.toml` still points at the classic entry — repoint to
net-only-index (net classes only) or retire it with the classic smoke scripts.

## package.json + guards

Remove scripts: `dev:classic`, `mcp:stdio:classic`, `dump:json`, `test:classic`,
`test:worker:classic`, `test:worker:all`, `smoke:cf-local*`, `smoke:cf-dev`,
`smoke:mcp`, `gate:authority`, `load:cf-dev`, `e2e:cf`, `plugs:bootstrap:v2`
(verify demo-plugs script). Edit `test`/`test:worker` lanes to drop deleted files
and keep the migrated ones. tsconfig.json:16 `#v2-browser-worker-factory` →
`./src/client/v2-browser-worker-factory.net-only.ts`. Update guards:
`guard-client-imports.mjs` (drop v2-browser-worker), `guard-layering.mjs` (drop
mcp/host, mcp/gateway rules), `guard-local-catalog-runtime-boundary.mjs` (drop
dev-server/commit-scope-do/persistent-object-do allowlist). Keep
`check-net-only-build.mjs`.

## Safe order (typecheck green at each phase → commit each)

1. tsconfig alias → .net-only factory. (sever the one KEEP→DELETE edge)
2. Migrate the 4 KEEP-lane/substrate tests; drop deleted files from lanes.
3. Delete all classic TEST files.
4. Delete the 39 classic SOURCE files (leaves-up if incremental).
5. Guards + wrangler + cf:migrations + package.json + spec (taps, catalogs).
6. Validate all gates incl. build:net-only.
