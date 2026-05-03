# impl-v0: first-light

Date: 2026-04-29
Commit: `14e474c`

This is a snapshot of what is currently built in `src/`. It documents the first runnable cut. As the implementation moves forward (toward v0.5 with full VM + persistence + DSL compiler, and Cloudflare deployment), this doc becomes a historical record of the first runnable cut.

The forward-looking specification continues to live under `spec/`. This notes doc is *what was built*; the spec is *what we are building toward*.

---

## What's built

### Core runtime (`src/core/`)

- **`types.ts`** — value model (scalar, list, map, error), object / verb / property types, message and observation envelopes, T0 bytecode and frame types, session type.
- **`tiny-vm.ts`** — T0 opcode dispatcher implementing the subset specified in [spec/semantics/tiny-vm.md](../spec/semantics/tiny-vm.md): `PUSH_LIT`/`LOCAL`/`THIS`/`ACTOR`/`SPACE`/`SEQ`/`MESSAGE`/`ARG`, `POP`, `DUP`, `MAP_GET`, `MAKE_MAP`, `MAKE_LIST`, `EQ`, `GET_PROP`, `SET_PROP`, `OBSERVE`, `JUMP`, `JUMP_IF_FALSE`, `RETURN`, `FAIL`.
- **`fixtures.ts`** — five canonical T0 bytecode fixtures (`set_value`, `set_prop`, `set_control`, `claim`, `set_status`) matching tiny-vm.md "Concrete Fixtures."
- **`world.ts`** — in-memory `WooWorld` implementing the full `$space:call` lifecycle (validate → authorize → sequence → dispatch → commit/rollback → applied frame), idempotent retry cache (5 min TTL), introspection (`describe`, `properties`, `verbs`, `property_info`, `verb_info`), and native handlers for taskspace and dubspace domain verbs.
- **`bootstrap.ts`** — seed graph creation: `$system`, `$root`, `$actor`, `$player`, `$wiz`, `$sequenced_log`, `$space`, `$thing`, `$catalog`, `$catalog_registry`, `$nowhere`, plus local catalog install for chat/taskspace/dubspace and a guest pool of 8 players.
- **`authoring.ts`** — `compileVerb` (T0 source regex-based compiler + JSON bytecode fallback), `installVerb` with `expected_version` check, versioned property definition.

### Server (`src/server/dev-server.ts`)

- Vite middleware mode for the SPA.
- HTTP API: `/api/state`, `/api/object`, `/api/compile`, `/api/install`, `/api/property`.
- WebSocket at `/ws` accepting `op: "auth"`, `op: "call"`, `op: "ping"`.
- `applied` frames broadcast to all connected sockets.

### Client (`src/client/main.ts`)

- Single-file SPA with three tabs: Dubspace, Taskspace, IDE.
- Dubspace: 4 loop slots, filter, delay, scene save/recall; Web Audio with oscillators when "Audio" is enabled.
- Taskspace: hierarchical task tree, claim/release, status, requirements, comments, artifacts.
- IDE: object inspector, verb editor with compile/install, test-call.
- Observations panel showing recent applied frames.

### Tests (`tests/core.test.ts`)

8 tests, all passing:

- Bootstraps the seed graph.
- Sequences calls and emits observations.
- Idempotent retry returns the same applied frame.
- Failed behavior keeps seq, rolls back mutations, emits `$error`.
- Creates hierarchical tasks; soft-DoD `done_premature`.
- Prevents conflicting claims with `E_CONFLICT`.
- Compiles T0 source, installs with `expected_version`, rejects stale version.
- JSON bytecode fallback verifier; versioned property defs.

---

## Demo surface

The demos this cut implements continue to be specified at the spec layer:

- [catalogs/dubspace/DESIGN.md](../catalogs/dubspace/DESIGN.md) — what the dubspace demo provides.
- [catalogs/taskspace/DESIGN.md](../catalogs/taskspace/DESIGN.md) — what the taskspace demo provides.
- [spec/authoring/minimal-ide.md](../spec/authoring/minimal-ide.md) — what the minimal IDE provides.

The demo specs are the contract; this notes doc records that the implementation in `src/` meets the contract as of this cut.

---

## What's not built

The following are spec'd but not implemented in this historical cut:

- **Full VM** beyond T0: no `CALL_VERB`, `PASS`, exception handling (`TRY_PUSH`/`TRY_POP`/`RAISE`), `FORK`, `SUSPEND`, `READ`, arithmetic ops, control flow beyond `JUMP`/`JUMP_IF_FALSE`, list/map mutation ops beyond what the demo needs.
- **Persistence** — the world is in-memory; restart loses state.
- **Cloudflare deployment** — current is a Node + Vite dev server.
- **DSL compiler** — the current `compileT0Source` is regex-based; supports only the demo verb shape (assignments, one observe, return).
- **Worktrees, migrations, backups, deployments, observability.**
- **Credentialed auth** (bearer / OAuth) — only guest tokens.
- **Teams, catalogs, debugging, conformance suite.**
- **Federation** — neither the deferred v2 design nor the early subset.
- **`session:<id>` resume** — sessions exist server-side but the token is not surfaced to clients in a way that lets them resume.
- **Presence-filtered applied broadcast** — currently broadcasts to all connected sockets.
- **`replay` over the wire** — the native handler exists; not yet callable from clients.

---

## Known issues at this cut

- **`EQ` opcode uses `JSON.stringify`** for equality, which makes maps with the same keys in different insertion order compare as not equal. Violates [values.md §V3](../spec/semantics/values.md#v3-equality).
- **`isObjRef` heuristic** in `types.ts` is too broad (any string containing `_` qualifies); appears unused, should be removed or tightened.
- **`restoreProps` rollback** restores all properties of all objects on behavior failure (O(world)); should be cluster-scoped per [space.md §S3](../spec/semantics/space.md#s3-failure-rules-normative).
- **HTTP API has no auth gate** — any client reaching the dev server can install verbs.
- **Idempotency cache never evicts** — bounded by 5-minute TTL on read but the Map grows; needs a periodic sweep beyond demo.
- **`attachedSockets`** isn't populated correctly (uses socket count as id token).
- **`broadcastApplied`** fans out to every socket regardless of presence in the relevant space.

---

## What this cut proves

- The actor model + locally-sequenced messages design works end-to-end.
- T0 VM bytecode can carry real verb behavior, with seeded fixtures and authored T0 source both running.
- Two browser clients coordinate through one `$space` and see ordered observations.
- Soft-DoD, claim-conflict, idempotent retry, behavior-failure rollback all behave per spec.
- The minimal IDE loop (inspect → edit T0 source → compile → install with version check → test) lands.

This is enough to demonstrate the platform claim ("persistent programmable objects plus locally sequenced messages") in a runnable form. The next cuts add durability, the full VM, and CF deployment.

---

## Where to go next

The intermediate v0.5 cut (between this first-light and v1-core proper) is roughly:

- v0.5a — full VM, in-memory, with tests.
- v0.5b — persistence (local SQLite via repository abstraction).
- v0.5c — real DSL compiler producing the full opcode set.
- v0.5d / v1-core release — Cloudflare deployment via DO storage backend implementing the same repository interface.

CF and persistence don't have to ship together: the repository abstraction in v0.5b lets local-SQLite and DO-SQLite both be backends behind the same interface. Local persistence is a faster dev/test target; CF is the production target.
