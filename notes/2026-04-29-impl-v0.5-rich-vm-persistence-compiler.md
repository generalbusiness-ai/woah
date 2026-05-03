# Implementation v0.5 Plan

## Purpose

v0.5 is the bridge from first-light demos to a platform that can run real object
programs. The important boundary is that a richer VM can be built and tested in
memory before durable task parking exists, but durable async semantics must not
be claimed until persistence and scheduling land.

## v0.5a: Rich VM, In Memory

Deliver a self-contained TypeScript VM that runs against the existing in-memory
world and preserves the current T0 fixture behavior.

Scope:

- Full call frames for bytecode execution.
- Stack, locals, literals, args, actor/player/caller/progr/verb metadata.
- Arithmetic, comparison, logic, list/map/string hot-path opcodes.
- Structured control flow and loop opcodes.
- Local `CALL_VERB` and `PASS`.
- Exception handlers with `TRY_PUSH`, `TRY_POP`, and `RAISE`.
- Tick, wall-time, and simple monotone memory metering.
- Per-opcode tests plus end-to-end bytecode programs.

Explicit non-scope:

- Durable `SUSPEND`, `FORK`, and `READ`.
- Cross-host RPC.
- Durable task queues, alarms, or parked continuation storage.

For v0.5a, async parking opcodes must have stable instruction shapes but either
raise a clear unsupported-durable-task error or run only in explicitly marked
local test mode. The default runtime should not pretend these are durable.

The dubspace and taskspace demos keep using T0 fixtures and native handlers
until richer authored objects need the expanded opcode set.

## v0.5b: Repository and SQLite Durability

Introduce a repository boundary and implement both in-memory and local SQLite
backends.

Scope:

- Object metadata, properties, property definitions, verbs, sessions, and space
  logs through a repository interface.
- SQLite schema scoped by `object_id`, matching the persistence spec.
- Anchor-cluster storage and transaction boundaries.
- Idempotent bootstrap over durable storage.
- Restart preserves object state and space sequence state.
- Replay after restart.
- Snapshot read/write if this milestone claims v1-ops continuity categories.
- Durable task table and local scheduler for `SUSPEND`, `FORK`, and `READ`.

This is where parked tasks become semantically meaningful. Local timers are
acceptable for the local backend; Cloudflare alarms come later with the host
adapter.

## v0.5c: DSL Compiler

Replace the regex-shaped T0 source compiler with a real lexer/parser/codegen
pipeline that emits the v0.5 VM bytecode set.

Scope:

- Lexer and parser for the agreed Woo source profile.
- Codegen for rich VM bytecode.
- Source spans and line maps.
- Structured diagnostics.
- JSON bytecode fallback remains available for low-level debugging.

Status: landed as M1 — see `src/core/dsl-compiler.ts` (1200+ lines, commit
`82e2e0c`) and `notes/impl-dsl-compiler-m1.md` for scope detail. M1 covers the
acceptance-test surface: locals, arithmetic, conditionals, loops, verb calls,
`pass`, `try`/`except`, and structured diagnostics with spans. M1.1 pressure-
ring items (line maps to source spans, dynamic index opcodes, string-interp
lowering, native-to-source migration of seed verbs) are tracked in the M1
notes.

## v0.5d: Conformance Harness

Add a small cross-backend conformance runner once the repository boundary exists.

Minimum categories:

- Sequenced call lifecycle and rollback.
- Message replay and gap recovery.
- Restart reconstruction.
- VM arithmetic/control-flow/exception behavior.
- `CALL_VERB` and inherited `PASS`.
- Metering failures.
- Durable task resume once v0.5b owns task parking.

Status: landed as `tests/conformance.test.ts`. The harness runs backend-visible
world semantics against `InMemoryObjectRepository` and SQLite using the same
cases. JSON-folder remains covered as import/export, not live storage. The VM
opcode matrix still lives in `tests/vm.test.ts`; fold it into this harness only
when there is a second VM backend to compare.

The harness should run the same semantic cases against the in-memory and SQLite
backends. That prevents "SQLite exists" from becoming weaker than "SQLite
preserves the specified behavior."

## Current Implementation Status

Implemented so far:

- v0.5a rich in-memory VM slice: arithmetic/control/list/map/string opcodes,
  loops, local `CALL_VERB`, inherited `PASS`, exceptions, `STR_INTERP`, and
  tick/memory/wall-time metering.
- Bytecode-to-bytecode `CALL_VERB` and `PASS` now run on an explicit in-memory
  VM frame stack instead of recursive JS calls. Nested exceptions unwind through
  VM frames into caller handlers. This is the execution-model bridge needed
  before `SUSPEND` and `READ` can serialize continuations.
- VM frame stacks now have a concrete serialized shape and a hydration runner.
  Focused tests prove a stored two-frame call stack can be resumed in-process.
- v0.5b first durable slice: repository serialization boundary, in-memory
  repository, local SQLite repository, dev-server SQLite boot, restart recovery
  for objects/sessions/space logs, snapshot read/write.
- Parked task storage and local scheduling foundation:
  - `task` table in SQLite and `parkedTasks` in the serialized world.
  - JSON folder full dumps include `tasks.json`; partial dumps omit parked
    tasks and remain non-loadable as complete worlds.
  - `FORK` schedules a durable delayed same-host verb call. When the parked task
    has a `space`, wakeup synthesizes a fresh message and feeds it through the
    normal `$space:call` path. The wake effect gets its own sequence number at
    fire time, so replay sees both the original scheduling call and the later
    fired call.
  - Off-space parked tasks remain host-only. They are for internal bookkeeping
    and must not mutate space-anchored state.
  - The dev server runs due tasks on a local timer and broadcasts sequenced wake
    frames or host-only task observations to present actors.
  - `SUSPEND` parks a serialized VM continuation. When the parked continuation
    wakes in a space, the runtime appends a sequenced `$resume` frame whose body
    names the parked task and carries the serialized continuation, then hydrates
    and resumes the VM stack.
  - `READ` parks a serialized VM continuation with `state='awaiting_read'` and
    `awaiting_player` set. The next input for that player resumes the oldest
    waiting task FIFO with the input value pushed onto the operand stack.
    Space-owned reads resume through a sequenced `$resume` frame whose body
    records `kind: "vm_read"` and the delivered input value.
- Sequencing decision for suspended space continuations:
  - A suspended continuation that belongs to a space must resume through a
    sequenced resume frame, not hidden durable side state.
  - The frame allocates a new sequence number at resume time and names the
    parked task/continuation being resumed.
  - This matches delayed `FORK`: the original call records the scheduling or
    suspension event; the later wake/resume is a second replay-visible event.
  - Host-only continuations remain possible for internal bookkeeping, but they
    must not mutate space-anchored state.
- JSON folder persistence/dump format:
  - `manifest.json` identifies `format: "woo-json-folder"`, version, counters,
    object files, log files, snapshot files, and whether the dump is partial.
  - `objects/<encoded-objref>.json` stores one serialized object per file.
  - `sessions.json` stores sessions for full dumps.
  - `tasks.json` stores parked tasks for full dumps.
  - `logs/<encoded-space>.json` stores replay logs per space for full dumps.
  - `snapshots/<encoded-space>.json` stores snapshots per space for full dumps.
  - Partial object dumps contain only selected object files and are explicitly
    not loadable as a complete world repository.

Landed after the first v0.5 notes pass:

- Repository-backed operations for the local runtime. `WooWorld` now enables
  incremental persistence after bootstrap when the repository implements
  `ObjectRepository`: object/session/task/snapshot changes use per-object
  methods, and sequenced calls/resumes use `transaction()` plus behavior
  `savepoint()`. Whole-world `save()` remains a startup/bootstrap compatibility
  path and a JSON-folder import/export shape, not the hot mutation path.
- Cross-backend conformance harness. The suite covers sequenced call lifecycle,
  behavior-failure rollback, idempotency, replay, direct-vs-sequenced
  observations, restart reconstruction, sessions/reap, parked `FORK` and `READ`
  tasks, taskspace hierarchy, and source authoring/version checks across memory
  and SQLite.

Still open:

- READ disconnect grace-period handling and task killing for sessions that stay
  detached past the identity.md grace window.
- Lower-latency or alarm-backed scheduler wakeups. The local dev scheduler uses
  `setInterval(..., 250)` to scan due tasks, so a `FORK` with a delay shorter
  than the poll cadence can slip up to ~250ms past `resume_at`. Production needs
  alarm-backed scheduling (Cloudflare DO alarms or equivalent) that fires at
  exactly the next-due `resume_at`.
- DSL compiler M1.1 pressure-ring items: full source-span line maps, dynamic
  index opcodes for `controls[name] = value` source authoring, string-interp
  lowering to `STR_INTERP`, and migrating one seed verb from native to authored
  source as the smoke test. (M1 itself is landed; see §v0.5c.)
- Failure-injection conformance for crash-mid-transaction recovery. The current
  backends reject pending log outcomes before commit; a simulated-crash backend
  is still needed to exercise storage interruption at each transaction boundary.

Known acceptable shortcuts:

- Memory accounting is intentionally monotone and rough. It estimates strings as
  two bytes per character and does not refund budget on pop or scope exit.
- `TRY_PUSH`/`TRY_POP` balance is enforced only at runtime today; stronger
  static balance checks belong with codegen/verifier hardening.
- `CALL_VERB`/`PASS` recursion is capped by the VM frame stack so runaway calls
  fail as `E_CALL_DEPTH` instead of overflowing the JS stack. Native dispatch
  still uses the existing synchronous `world.dispatch` path.
