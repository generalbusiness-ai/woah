# Implementation: Cloudflare Deploy

## Purpose

Bridge the working in-process runtime to a deployable Cloudflare Workers + Durable Objects implementation. The semantic substrate is shipped; the CF-specific transport layer is not. This note tracks the gap between `spec/reference/cloudflare.md` (forward-looking spec) and `src/` (current code).

The goal of "live" is: a fork-and-deploy world per `cloudflare.md §R14`, with the bundled demos installable as local catalogs, instrumented enough to debug remotely, and operator-claimable via the wizard-token flow. Full v1-ops surface (worktrees, conformance, etc.) is post-deploy.

## Scope

Required for first deploy:
- §R1 host mapping (existing routing model is the deployment target).
- §R2 `Directory` singleton DO.
- §R3 `ObjectRepository` implementation against `state.storage.sql`.
- §R5/§R6.1 cross-DO RPC for inheritance lookups and verb dispatch (non-yielding shape only).
- §R7 alarm-based parked-task resume.
- §R8 WebSocket hibernation.
- §R9 first-request bootstrap.
- §R10.1–§R10.4 instrumentation (AE writes, structured logs, per-DO `:metrics()`, wizard audit).
- §R11 Worker entry routing.
- §R12 `wrangler.toml`.
- §R14 fork-and-deploy operator flow: required secrets, wizard claim, failure modes.

Deferred to v1.1+:
- §R6.2 mid-call SUSPEND across DOs (already explicitly deferred in spec).
- `QuotaAccountant` DO real-time accounting (table scaffolded; daily alarm pass skipped at first).
- §R10.5 distributed tracing.
- Multi-region tuning beyond CF defaults.
- Private GitHub tap auth/cache policy (public GitHub tap install/update is wired).
- Snapshot policy automation (manual snapshot only).

## Phases

Suggested order. Each phase ends at a runnable checkpoint (typecheck + tests).

### Phase 1: CF backend `ObjectRepository`

Implement `src/worker/cf-repository.ts` against `state.storage.sql`. Mirror `src/server/sqlite-repository.ts` shape; the schema in `spec/reference/persistence.md §14.1` is identical. Includes `transaction()` (CF `state.storage.transactionSync`) and `savepoint()` (SQL SAVEPOINT).

Tests: extend `tests/conformance.test.ts` with a CF-storage backend variant if a test harness for CF storage is feasible (Cloudflare's Miniflare supports `state.storage.sql`). If not, leave as a future addition — the unit-level guarantees are covered by the spec.

### Phase 2: Worker entry + DO classes

`src/worker/index.ts`: route parsing per §R11.1, ID resolution per §R11.2, auth header per §R11.3, sessions placement per §R11.4. Current slice uses Directory's `session_id -> actor` index; embedded-player session ids remain a later optimization.

`src/worker/persistent-object-do.ts`: `PersistentObjectDO` class wrapping the existing `WooWorld` against `CFObjectRepository`. Hosts the world gateway and routed anchor-cluster DOs with the same class. Hosts WebSockets via `acceptWebSocket` (§R8).

`src/worker/directory-do.ts`: `DirectoryDO` singleton. Read-mostly routing table for seeded corenames/object refs, plus `session_id -> actor` routing for forwarded object calls.

### Phase 3: First-request bootstrap

`src/worker/bootstrap.ts`: §R9.1 first-request path. Worker checks `$system` DO's `bootstrapped` flag (via `loadMeta`); if false, runs the universal-class bootstrap and any `WOO_AUTO_INSTALL_CATALOGS` entries; sets `bootstrapped=true`. Idempotent. The shipped `wrangler.toml` sets `WOO_AUTO_INSTALL_CATALOGS = ""`, so fork-and-deploy starts as a clean core world unless the operator opts into bundled catalogs before deploy.

Operator claim flow (§R14.4): `POST /api/auth` accepting `wizard:<token>` matches against `WOO_INITIAL_WIZARD_TOKEN` env var; first match consumes the token (sets `world_meta.bootstrap_token_used = true`); subsequent presentations return 401.

### Phase 4: Alarms + WS hibernation

§R7: replace the dev server's `setInterval(runDueTasks, 250)` with per-DO alarms. Each DO computes `min(resume_at)` after every parked-task mutation and calls `state.storage.setAlarm(t)`; the `alarm()` handler runs due tasks.

§R8: WebSocket hibernation. `state.acceptWebSocket(ws)` + `serializeAttachment({session_id, actor, socket_id})`. Survives DO hibernation. `webSocketMessage`/`webSocketClose`/`webSocketError` handlers.

### Phase 5: Instrumentation

`src/instrument.ts`: §R10. Three primitives wired:

- AE binding (`env.METRICS.writeDataPoint`) for `call`, `cross_do_rpc`, `alarm`, `session`, `wizard_action`, `error` events. Optional — degrades to no-op when binding is absent.
- Structured `console.log` lines: `{ts, level, event, do_id, request_id, fields}`. `request_id` propagated through the cross-DO RPC envelope.
- Per-DO `:metrics()` direct-callable verb returning rolling counters.

Wizard-action audit on `X-Woo-Force-Direct`, `X-Woo-Impersonate-Actor`, `wiz:force_recycle`, `wiz:force_set_status`, `$system:rebuild_seeds`, etc.

### Phase 6: Wrangler config + first deploy

`wrangler.toml` per §R12 skeleton. `[[migrations]]` tag `v1` creates `PersistentObjectDO`; `tag = "v2"` creates `DirectoryDO` (append-only migration history). AE dataset binding optional. `[observability]` enabled.

`DEPLOY.md` already exists; verify the operator path against the live deploy. End-to-end smoke: deploy → set secrets → first auth as wizard → install desired catalogs → exercise any installed catalog UI from the bundled client.

### Phase 7 (landed locally): catalog tap install/update over GitHub

The local Node server and Cloudflare Worker now have `/api/tap/install`, `/api/tap/update`, and `GET /api/taps`. The shared helper in `src/core/catalog-taps.ts` resolves GitHub refs, fetches `manifest.json` and `README.md`, computes SHA-256 hashes, and dispatches `$catalog_registry:install` or `$catalog_registry:update`. Major updates fetch `migration-v<from>-to-v<to>.json` and pass it to the registry call. Worker-side fetches are bounded (manifest/migration 256 KiB, README 512 KiB, eight subrequests per operation) and emit structured `woo.catalog` logs. Private repo tokens and content-hash caching remain deferred.

## Current Implementation Status

Substrate landed (works in-process):

- `ObjectRepository` interface in `src/core/repository.ts` with full method set + `transaction()` + `savepoint()`.
- In-memory and local SQLite repositories (`src/core/repository.ts` `InMemoryObjectRepository`, `src/server/sqlite-repository.ts`).
- Sequenced log commit split (`appendLog` + `recordLogOutcome`) guarded against committed-pending rows. The async behavior path completes before the final storage transaction opens.
- DSL compiler M1 (`src/core/dsl-compiler.ts`) — recompile-on-import works for catalogs.
- REST API with six endpoints (`src/server/dev-server.ts` for the local Node target).
- Wire ops `direct`/`result`/`event` over WebSocket.
- Identity three-layer model (actor/session/connection); session table is credential-only, connection state in-memory.
- Local + GitHub catalog install/update path; manifests for chat/dubspace/taskspace ship in `catalogs/`. GitHub tap helper lives in `src/core/catalog-taps.ts` and is wired through `POST /api/tap/install`, `POST /api/tap/update`, and `GET /api/taps`. Wizard auth via `wizard:<WOO_INITIAL_WIZARD_TOKEN>`.
- 181/181 tests pass; typecheck clean (split: main + `tsconfig.worker.json`).

Phase 0 (toolchain smoke test) — landed:

- `wrangler.toml` skeleton proved the Worker toolchain before DO bindings landed.
- `src/worker/index.ts` stub Worker — JSON heartbeat for any path.
- `tsconfig.worker.json` scopes `@cloudflare/workers-types` to the worker tree only.
- Live at `https://woo.hughpyle.workers.dev/`. Token-mint flow proven (`woo` API token created with the six required permission groups; `wrangler whoami` succeeds).

Phase 1 (CF backend `ObjectRepository`) — landed:

- `src/worker/cf-repository.ts`. Mirrors `LocalSQLiteRepository` through the shared SQL shape in `src/core/sql-shape.ts`: schema statements, legacy rebuild statements, row decoders, object-flag encoding, and verb-flag serialization live in one place. The wrapping changes:
  - `state.storage.sql.exec(...)` cursor API instead of better-sqlite3 prepared statements.
  - `state.storage.transactionSync(fn)` for atomicity (raw `BEGIN`/`COMMIT`/`ROLLBACK` aren't allowed via `sql.exec` on CF).
  - **`savepoint(fn)` also uses `state.storage.transactionSync(fn)`** — when called inside an outer transaction it nests as an implicit savepoint. Raw SQL `SAVEPOINT`/`ROLLBACK TO`/`RELEASE` are forbidden through `sql.exec` per CF docs and have been removed.
- `CFObjectRepository implements ObjectRepository, WorldRepository`. `load()` walks per-object tables to reconstruct a `SerializedWorld` for cross-hibernation hydration. `save()` clears the tables and re-inserts via per-object methods inside one transaction, matching `LocalSQLiteRepository.save()` so `createWorld()`'s post-bootstrap whole-world flush works on CF.
- Pending-log-outcome assertion at outer-only commit boundary (matches local backend).
- `tests/worker/cf-repository.test.ts` exercises `CFObjectRepository` through a DurableObjectState-shaped `sql.exec`/`transactionSync` adapter: bootstrap/reload, nested savepoint rollback, remote-room command resolution on CF-backed hosts, and a gateway + Directory regression for Worker-side GitHub tap install publishing a self-hosted object before host-seed fetch. Full cluster-host integration still needs Miniflare or live-deploy coverage.

Phase 2 (Worker entry + DO class) — landed:

- `src/worker/persistent-object-do.ts` (~750 lines). `PersistentObjectDO` wraps `WooWorld`+`CFObjectRepository` for both the `world` gateway and Directory-routed anchor-cluster hosts. The gateway runs bootstrap + operator-selected catalog auto-install (`WOO_AUTO_INSTALL_CATALOGS`; empty by default on CF); cluster hosts load/prune host-scoped serialized slices exported by the gateway, then run host-scoped local catalog repair and data migrations for the objects they own. REST routes include `/healthz`, `/api/auth` on the gateway (with `wizard:<WOO_INITIAL_WIZARD_TOKEN>` claim flow), authenticated `/api/state` aggregate, `/api/objects/{id}` describe, `/api/objects/{id}/properties/{name}`, `/api/objects/{id}/calls/{verb}` (sequenced + direct), `/api/objects/{id}/log`, `/api/taps`, `/api/tap/install`, and `/api/tap/update`. Fail-loud 503 for missing `WOO_INITIAL_WIZARD_TOKEN` or `WOO_INTERNAL_SECRET` per §R14.7. SSE streams (`/stream`) still return 501 `E_NOT_IMPLEMENTED`.
- `src/worker/directory-do.ts`. `DirectoryDO` singleton with SQLite tables for `objref -> host` routes and `session_id -> actor` session routing. It starts empty and learns object placement from generic route tables exported by the world/hosts; chat stays on the gateway until player-DO fan-out/presence indexing exists.
- `src/worker/index.ts`. Worker entry now routes global API/WS traffic to `env.WOO.idFromName("world")`, object REST routes through Directory, and best-effort broadcasts routed applied frames back through the gateway so WebSocket clients see REST-agent mutations live.
- `wrangler.toml`. `[[durable_objects.bindings]] name = "WOO" class_name = "PersistentObjectDO"` and `name = "DIRECTORY" class_name = "DirectoryDO"`. `[[migrations]] tag = "v1" new_sqlite_classes = ["PersistentObjectDO"]`; `tag = "v2" new_sqlite_classes = ["DirectoryDO"]`. `compatibility_flags = ["nodejs_compat"]` (needed by `node:crypto` in `src/core/source-hash.ts`).
- `tsconfig.worker.json` adds `node` to `types` so the worker tsconfig sees `node:crypto` types.
- **Live deploy**: `https://woo.hughpyle.workers.dev/`. `WOO_INITIAL_WIZARD_TOKEN` set via `wrangler secret put`; set `WOO_INTERNAL_SECRET` before deploying this HMAC batch. `WOO_SEED_PHRASE` is no longer a runtime requirement until deterministic object-id allocation lands. Earlier smoke tests used bundled catalog auto-install; new CF defaults start clean unless `WOO_AUTO_INSTALL_CATALOGS` is edited before deploy. Permission gates (`E_DIRECT_DENIED` for non-`direct_callable` verbs) enforced.

Phase 2.1 (bundled SPA via Workers Assets) — landed:

- `wrangler.toml` `[assets] directory = "./dist", binding = "ASSETS", not_found_handling = "single-page-application"`. Deploy now requires `npm run build` first to populate `dist/` (Vite outputs ~50 KiB gzipped: index.html + assets/index-*.{js,css}).
- `src/worker/index.ts` routes global API/WS traffic to the gateway DO, object REST routes through Directory, and falls through to `env.ASSETS.fetch(request)` for everything else. 503 `E_NO_ASSETS` if the binding is missing (operator forgot to build).
- `Env` interface gains optional `ASSETS: Fetcher`.
- Live verification: `https://woo.hughpyle.workers.dev/` serves the SPA shell; navigating the four tabs (chat / dubspace / taskspace / IDE) renders against the live world.

Phase 2.2 (WebSocket upgrade with hibernation) — landed:

- Pulled forward from Phase 4 because the chat tab opened a WS to `/ws` and saw the connection refused on the Phase 2 deploy.
- `src/worker/persistent-object-do.ts` `fetch()` handles `GET /ws` with `Upgrade: websocket`: creates a `WebSocketPair`, accepts the server side via `state.acceptWebSocket()` (CF hibernation API), returns the client side in a 101.
- Per-socket state `{sessionId, actor, socketId}` lives in `ws.serializeAttachment()` so it survives DO hibernation.
- `webSocketMessage(ws, msg)`: ports the dev-server WS frame dispatch — handles `op: auth, ping, call, direct, input, replay`. Same shape as `dev-server.ts` lines 95–179.
- `webSocketClose` / `webSocketError`: cleanup detaches from the world's `attachedSockets` registry.
- Broadcast helpers (`broadcastApplied`, `broadcastTaskResult`, `broadcastLiveEvents`, `broadcastLiveEvent`) iterate `state.getWebSockets()` instead of the in-memory `Map` the local dev-server uses; presence-filtered fan-out for applied frames; directed-to/from filtering for live observations.
- Live verification: chat works end-to-end. Two browser tabs see each other's `enter`/`leave`/`said`/`emoted` events broadcast correctly.

Phase 2.3 (first multi-DO routing slice) — landed:

- `DirectoryDO` now exists as a separate SQLite-backed Durable Object. It learns object routes from the world/host route tables and tracks `session_id -> actor` for forwarded object calls.
- Worker object routes resolve through Directory. Sequenced REST calls route by `body.space` when present, so `/api/objects/the_taskspace/calls/create_task` with `space: "the_taskspace"` lands on the `the_taskspace` DO. Direct calls and object/property/log reads route by the object id in the URL.
- The `world` DO remains the gateway for `/api/auth`, `/ws`, `/healthz`, `/api/taps`, `/api/tap/install`, and bundled `/api/state` aggregation.
- WebSocket clients still connect to the gateway DO. The gateway forwards `op: call`, `op: direct`, and `op: replay` to the Directory-selected host when needed, using internal routes on `PersistentObjectDO`.
- Routed REST applied frames and direct-call live observations are best-effort broadcast back through the gateway so connected browser clients see REST-agent mutations live. Durability remains on the space host; clients can recover sequenced calls via replay/state aggregation if live fan-out fails.
- `/api/state` is now authenticated and aggregates dubspace/taskspace state from their routed hosts. Object descriptions inside the payload are actor-filtered; demo app state maps are raw convenience data for the bundled client, not the production REST surface.
- The gateway asks routed hosts for their route table after applied frames and registers any objects owned by that host. Runtime-created anchored tasks route back to the taskspace host without observation-type-specific routing code.
- Current routed hosts: dubspace and taskspace anchor clusters route to their own hosts; the standalone chat room stays on `world` until player-DO fan-out / cross-host presence indexing exists.
- Verification: `npm run typecheck`, `npm test` (98/98), `npm run build`, `npx wrangler deploy --dry-run`, and Playwright smoke against a fresh SQLite DB all pass.

Phase 2.4 (host-scoped cluster loader) — landed:

- Non-gateway `PersistentObjectDO` instances no longer run `createWorld({ catalogs })`. On first load, a cluster asks the gateway for `exportHostScopedWorld(host)` and persists that slice. On later loads, it prunes any existing stored world to the same host scope before enabling incremental persistence.
- Host slices contain hosted objects, parent/classes/features needed for local verb resolution, bytecode literal object references, subscriber actor objects for hosted spaces, and hosted logs/snapshots/tasks. They do not include unrelated bundled demo objects, `$catalog_registry` install history, or gateway sessions.
- Cluster `/api/auth` and `/ws` now fail loud; the gateway remains the only public auth and WebSocket host. Forwarded internal calls create a minimal local actor/session if the actor was not already in the host slice.
- Runtime-created object ids now include their anchor-derived scope (`obj_<scope>_<n>`) so independent hosts do not mint the same `obj_1` name.
- Verification for this phase was superseded by later runs; current local verification is tracked in the latest work notes and `TECH_DEBT_AUDIT.md`.

Phase 2.5 (single async runtime path + cross-host dispatch bridge) — landed locally:

- `WooWorld.call`, `directCall`, `dispatch`, parked-task resume, and VM execution are async end to end. There is no sync compatibility path for behavior execution.
- The host bridge is async: `hostForObject`, `getPropChecked`, and `dispatch` may await routed host work. VM `GET_PROP`, `CALL_VERB`, and `PASS` await through that bridge; property writes/definition edits to remote objects still raise `E_CROSS_HOST_WRITE`.
- Behavior executions serialize through a per-world host queue (sequenced calls, direct calls, and parked-task resumes). Sequenced calls reserve `seq` in memory, run the awaited behavior under an in-memory behavior savepoint, then commit dirty local state plus `appendLog`/`recordLogOutcome` in one repository transaction. This is the clear async shape; it replaces the earlier "run behavior inside a sync storage transaction" sketch.
- Repository-backed commits track dirty objects/properties/sessions/tasks/counters while persistence is paused, then flush only those slices at the commit boundary. This is load-bearing for Cloudflare SQLite row-write cost: the runtime no longer rewrites every hosted object after each sequenced/direct operation, and property-only verbs use `saveProperty()` instead of full object rewrites. `storage_flush` metrics expose the slice counts per flush.
- Worker hosts expose internal `/__internal/remote-get-prop` and `/__internal/remote-dispatch` routes. Routed dispatch returns both the verb result and emitted observations so the origin frame preserves live/replay observations.
- Verification in the current worktree: `npm test` (181/181), `npm run typecheck`, `npm run build`, and `git diff --check` pass.

Verb-flag persistence fix (storage-layer bug, both backends) — landed:

- Both `LocalSQLiteRepository` and `CFObjectRepository` had a pre-existing schema bug: the `verb` table had no `flags` column, so `direct_callable` and `skip_presence_check` were silently dropped on save and reset to undefined on load. Locally invisible because the in-memory state from initial bootstrap survived in the same process; on CF every fresh DO instance re-hydrated from storage and lost the flags, so calls to chat verbs returned `E_DIRECT_DENIED`.
- Schema gains `flags TEXT NOT NULL DEFAULT '{}'`. `save()` and `saveVerb()` write shared `verbFlagsJson(verb)` output; the shared row decoder reads the JSON and sets the booleans on the reconstituted `VerbDef`.
- `ensureColumn` migration adds the column on existing local SQLite databases.
- CFObjectRepository.migrate() detects "verb table exists without flags column" and drops every table; the next `createWorld()` sees empty storage and runs fresh bootstrap + catalog auto-install. One-time wipe; operator re-claims wizard via the same `WOO_INITIAL_WIZARD_TOKEN` secret. (Local SQLite dev databases keep their data but with empty flags — operator can `rm .woo/dev.sqlite` and restart for a clean re-bootstrap if needed.)

## Still open

In dependency order:

- **Object-locality containment RPCs landed; deployed smoke still needed**: `moveObjectChecked()` routes to the object's host, writes `location` there, and mirrors old/new container `contents` through internal Worker routes. The conformance harness covers the in-process bridge across memory/SQLite backends. Still prove the same path under Miniflare/live CF and finish route stamping for runtime-created non-anchored objects.
- **Room-count/cost tracking**: the chat catalog currently seeds three self-hosted room instances (`the_chatroom`, `the_deck`, `the_hot_tub`). DOs hibernate cheaply, but every new self-hosted room is another possible storage/alarm/socket locus. Keep this visible as demo catalogs grow beyond first-light.
- **Alarms** for parked tasks. Replaces the 250ms `setInterval` only on the CF target; local dev keeps the poll. (WS hibernation landed in Phase 2.2; alarms are the remaining piece of original Phase 4.)
- **SSE stream** (`/api/objects/{id}/stream`) on the Worker. Returns 501 placeholder; browser clients use the WebSocket path. SSE matters for HTTP-only agent integrations.
- **Authoring REST endpoints** in the Worker: `/api/compile`, `/api/install`, `/api/property`, `/api/property/value`, and `/api/authoring/objects/{create,move,chparent}`. The IDE tab can read object descriptions but cannot author verbs or object lifecycle changes against the deployed world. dev-server has the Node implementations; needs Web-standard ports.
- **`wiz:rotate_bootstrap_token` verb** on `$system`. Spec'd in §R14.4; impl pending.
- **Deployed cross-DO smoke for mid-verb RPC**: the async `HostBridge` and Worker internal routes are wired locally, but need a live CF/Miniflare exercise that proves a verb on one host can read/call another host and surface observations correctly.
- **Authenticated internal forwarding headers landed locally**: the public Worker strips inbound `x-woo-internal-*` headers before forwarding, and gateway/cluster/Directory internal calls now carry an HMAC over method/path/body hash plus forwarded authority headers. Set `WOO_INTERNAL_SECRET` before the next deploy.
- **General object-route registration**: Directory has `/register-objects`, initial gateway bootstrap publishes `world.objectRoutes()` for every real object id (self-hosted/anchored objects route to their host; unplaced objects route to `world`), and applied frames trigger a generic incremental publish for newly-created objects. Host-internal lookups use no fallback so aliases like `tub` do not become fake object routes. Remaining gap: non-gateway hosts still need broader create-object placement callbacks for future object-creation APIs that bypass the gateway.
- **Aggregate health**: `/healthz` is gateway-local. Add a Directory/host fan-out health endpoint when routed-host liveness needs to be operator-visible.
- **Verb-lookup cache** (`ancestor_verb_cache`, `ancestor_prop_cache`). Schema exists in `persistence.md §14.1`; population on cross-DO miss is unimplemented.
- **`src/instrument.ts`** with AE writes, structured logs, per-DO `:metrics()`.
- **Full Worker/DO conformance harness** via Miniflare. `tests/worker/cf-repository.test.ts` now covers `CFObjectRepository` plus a gateway + Directory tap-route regression through DurableObjectState-shaped fakes; the remaining gap is real cluster-host integration under Miniflare or live CF.

## Known acceptable shortcuts

- **Mid-call SUSPEND across DOs raises `E_CROSSDO_PARKING_UNSUPPORTED`** per §R6.2. v1.1 may relax.
- **No tap caching.** Every install/update fetches fresh from GitHub. §CT4.
- **Public GitHub taps only.** Private repository auth and manifest/content caching are deferred.
- **Quota accounting is hard-cap-on-write only.** Daily-alarm pass deferred. §R5.4.
- **No multi-region tuning.** CF picks the closest region per DO automatically.
- **No distributed tracing.** Structured logs + `request_id` propagation across cross-DO RPCs cover the audit trail.
- **No snapshot policy automation.** Operators trigger snapshots manually (or via a verb on `$space`); CF-side automation is post-v1.
- **No full Worker/DO conformance harness** until Miniflare or equivalent is wired. The repository-level CF storage shape is covered by `tests/worker/cf-repository.test.ts`; gateway/Directory/cluster routing still needs integration coverage.
- **Worker-level rate limiting via Cloudflare's built-in protection.** No application-level rate-limit beyond `wire.md §17.5` outbound queue / inbound burst caps.

## Open questions

1. **Sessions placement.** Current slice uses Directory's `session_id -> actor` table. Lean from §R11.4 still points toward embedded player ids for long-term removal of a session lookup hop; decide before player-DO routing.
2. **`world.ts` decomposition.** The Worker can route top-level calls now, but `WooWorld` still assumes local class/verb availability and local dispatch within a host. Light refactor (cluster-aware dispatch + remote definition cache) vs. full decomposition along TECH_DEBT_AUDIT F001 lines remains open.
3. **Storage transaction boundaries** at CF: repository-local savepoint behavior is now covered by a DurableObjectState-shaped adapter, but still needs a Miniflare/DO probe against real `state.storage.sql` semantics.

## Reference

- `spec/reference/cloudflare.md` is the forward-looking spec; sections R1–R15.
- `spec/reference/persistence.md §14.1` is the SQLite schema both backends target.
- `src/core/repository.ts` is the canonical TS source for `ObjectRepository`.
- `DEPLOY.md` documents the operator-facing flow.
- `notes/impl-v0.5-rich-vm-persistence-compiler.md` covered the predecessor milestone (in-process VM + persistence + DSL compiler); items there are landed.
