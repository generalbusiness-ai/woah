---
date: 2026-05-03
status: partial
---

# Reference architecture: Cloudflare

> Part of the [woo specification](../../SPEC.md). Layer: **reference**. Concrete mapping of woo's abstract host model and persistence onto Cloudflare's primitives. Other implementations are possible; this document is the reference plan.

---

## R1. Host mapping

| Abstract host (semantics) | Concrete (Cloudflare) |
|---|---|
| Edge | Worker isolate, per-request |
| Persistent | Durable Object — see §R1.1 for the three DO classes (self-hosted-instance, gateway, service). One DO per *self-hosting* woo object; co-resident objects share the host of their creator. |
| Transient | Browser tab JavaScript runtime |

### R1.1 Routing

DO instances fall into three classes, all of which use the same `PersistentObjectDO` Durable Object class — they differ only by what they host, not by their server-side code.

| Class | Naming | Hosts |
|---|---|---|
| **Self-hosted-instance DO** | `env.WOO.idFromName(<obj_id>)` | One DO per instance of a class declaring `instances_self_host` (per [semantics/objects.md §4.2](../semantics/objects.md#42-host-placement)). Rooms, players, anchor spaces (`the_dubspace`, `the_taskboard`), and operational singletons (`$catalog_registry`) each get their own DO. |
| **Gateway DO** | `env.WOO.idFromName("world")` | The default home for objects whose class does not self-host. Universal `$`-classes, ad-hoc objects with no anchor, and runtime-created objects whose creator is the gateway itself live here. The Worker entry uses the gateway DO for global routes (`/api/auth`, `/healthz`, `/v2/turn-network/ws` upgrade) and as the catch-all when no other host claims an id. |
| **Service DO** | `env.DIRECTORY.idFromName("directory")` and similar | Singletons for routing and bookkeeping. See [§R2](#r2-singleton-dos). |

**Routing precedence.** The runtime resolves an object id to a host in order:

1. If the object's `host_placement` property is `"self"`, the id is its own host (the runtime materialization of `instances_self_host` from [semantics/objects.md §4.2](../semantics/objects.md#42-host-placement)).
2. Else if the object's `anchor` (transitively) resolves to a self-hosted host, route to that anchor's host.
3. Else, the object has a fixed Directory route stamped at `create()` and never changed thereafter. The route is the **executing host** that ran the create call: for runtime-created objects, the persistent host whose verb body invoked `create`; for seeded/bootstrap objects, the gateway (or whichever host the catalog explicitly nominates).

The executing host is **not** the verb's `progr`. `progr` is permission identity (set at compile time, carried in every frame); the executing host is the physical DO running the call. A wizard helper verb invoked from a player's host runs on the player's host and creates objects co-resident with the player, not with the wizard.

`location` does not participate in routing. A carryable object's host is fixed at creation; routing of a request for that object never consults `location`.

The runtime stores the resolved id-to-host map in **Directory** ([§R2](#r2-singleton-dos)) so the Worker entry can answer the lookup without contacting the owning DO. Self-hosted instances register themselves on first call; co-resident instances are registered by their executing host at create time. Directory rows are immutable once written for a given id (because placement is immutable for a given id) — so Directory is read-mostly, write-rare, off the hot path.

**Carryable objects do not migrate.** When an object's `location` changes (a player carries a book between rooms, then puts it on a table), neither its host nor its Directory row changes. The book's storage stays on the host that created it; the moving host writes the object's `location` field locally and uses cross-DO RPC to update the source and target container's `contents` cache (see §R1.7). This avoids subtree migration, two-phase storage, and Directory fences for ordinary movement.

**Cross-DO RPC** uses the DO stub returned from `idFromName`. The stub's methods are the inter-host RPC surface (verb dispatch, property read/write, version-checked artifact fetch, and the contents-mirror updates described below). Every awaited cross-DO RPC carries the host wait-for guard from [protocol/hosts.md §3.5](../protocol/hosts.md#35-host-wait-for-graph-and-reentrancy): `correlation_id`, `host_chain`, and `route_class`.

**Operation-scoped memoization.** Within one verb execution, the origin host may memoize id-to-host resolutions and read-only cross-DO fetches (`getProp`, `location`, `contents`, bundled object description, verb metadata) by promise. The memo dies with the execution frame; it is not a TTL cache and must not be reused by later calls. Reads inside one execution are therefore a frame-scoped snapshot: if the same frame mutates remote state through dispatch and then repeats a memoized read, the earlier read may be returned. This removes duplicate fetches inside one `:look`, movement, command parse, or agent tool resolution without serving stale world state across operations.

**Read RPC timeouts.** Read-only cross-DO RPCs used for projections, room snapshots, object summaries, command matching, and tool discovery are bounded. A slow or cold remote host must not hold the caller host's single-threaded queue long enough to starve unrelated commands.

Timeout fallback is operation-classed:

- **Semantic reads** (`getProp`, `location`, `contents`, verb metadata, ancestry) fail with `E_TIMEOUT` when the caller needs the value to decide behavior, permission, routing, or a mutation. Callers must not guess.
- **Presentation reads** may degrade only for expected read-availability failures (`E_TIMEOUT`, stale/missing remote object refs such as `E_OBJNF`) and optional-field misses. The fallback is omission or id-only display: omit timed-out remote room members/exits/tools, omit missing summaries, or show the object id as a title. Permission and programming errors remain visible unless the API is explicitly an optional filtered read.
- **Command matching** may use local candidates and id-only remote candidates when metadata is unavailable. If the remote object's verb metadata is unavailable, the planner treats that object as not matching and produces the ordinary `huh` plan; it does not invent a verb route.
- **Room snapshots** keep the local room shell and omit timed-out remote members/exits. If the room owner itself is remote and unavailable, the snapshot may degrade to absent (`here: null` in `/api/me`) only for expected read-availability errors; permission, type, and internal errors must propagate.
- **Mutating RPCs** are not silently timed out by this read budget because a late owner write would create ambiguous state.

**Bundled object descriptions.** Read-heavy projections such as room `:look` and `$match` object resolution should use bundled cross-host describe RPCs where available, returning the common display fields (`name`, `description`, `aliases`). When a caller already has several candidate objects on the same host, it should use the batch form (`describeObjects`) so one room look or command parse pays one RPC per host rather than one RPC per item. `name` is the object's display name; property fields use the same per-property read filtering the separate `getProp` calls would apply. This is an optimization, not a new authority surface: callers must still pass the actor/progr identities used for the equivalent reads, and a host may return `null` for fields the actor cannot read.

**Remote command planning reads.** A room-hosted command planner may need to inspect a visible object's verb metadata when that object is hosted elsewhere. Command planning must ask the owning host for all verb candidates whose canonical name or aliases match the command token, not just the first runtime-resolved verb: command aliases intentionally overlap, such as `look` and `look_at`, and the planner filters candidates by `arg_spec.command`. The host RPC returns only the slot, canonical verb name, aliases/arg spec needed for planning, and `direct_callable` flag; actual execution still routes through ordinary direct or sequenced dispatch and re-checks permissions on the object host.

### R1.7 Contents-mirror invariants

Every container — a room, a table, a mailbox — maintains its own `contents` set as the cached inverse of `obj.location`. Across DOs, that invariant is distributed:

- The **source of truth** is `obj.location` on the object's own DO. Every move primitive writes this field transactionally on the host that owns the object.
- The **container cache** is `container.contents`, a set of object **ids** (`ObjRef[]`) maintained on the container's host. The container does not store cached titles, hosts, or display data; only ids.
- **Move RPCs use owner-mutation deltas.** The object's owner host writes `obj.location` and returns `{old_location, location}` plus any mirror deltas. It must not synchronously call a container host already present in the request's `host_chain`; doing so would create an `A -> B -> A` wait cycle. The initiating host applies local mirror deltas for containers it owns after the owner write succeeds. Mirror updates to hosts not in the chain may be sent as one-way cache updates; if they fail, cache drift is tolerated.
- **Rendering enriches at read time.** When a verb such as `:look` walks `contents`, it resolves each member's host via Directory and dispatches `:title()` (and any other display verbs) per-host. Because routes are fixed, a given member's host can be resolved from cache without a Directory round-trip in the common case.
- **Cache drift is tolerated.** If a push fails, the cache is stale; rendering looks wrong until reconciled. A reconcile sweep — triggered on `:look` or by periodic policy — verifies each cache entry by querying the member's actual `location` (via the member's own host) and prunes ghosts. Routing and correctness are unaffected by cache drift; only rendering is.

This keeps the **Directory scoped to id-to-host routing** rather than expanding it into a centralized containment ledger. Move-frequency writes flow to the affected containers, not to Directory; Directory writes happen only at object creation (placement is immutable thereafter, per §R1.1).

**Player movement** between rooms (`go north`) does not migrate the player's storage. The player has its own DO; `player.location = next_room` is a local write on the player's DO, plus two cross-DO RPCs to update each room's subscriber list. Inventory items, anchored to the player or carried in `player.contents`, stay on the player's DO and travel with the player by reference (their `location` continues to point at the player; the rooms never see them).

**Take and drop** are pure `location` writes plus a pair of contents-mirror RPCs. The object never moves between DOs; only its `location` field changes (on the object's own DO) and the source and target containers update their caches.

### R1.2 ID allocation

ULIDs are minted in-process by whichever DO is creating a child object. No central allocator on the hot path. See [../semantics/objects.md §5.5](../semantics/objects.md#55-id-allocation) for the abstract algorithm.

### R1.3 Edge worker entry

A single Cloudflare Worker handles inbound HTTP/WebSocket and dispatches:
- `wss://world.example/connect` → routed to the connecting player's DO via session token.
- HTTP API endpoints (admin, world boot, etc.) routed to the appropriate singleton DO.

### R1.4 Hibernation

DOs hibernate after periods of inactivity. WebSocket connections survive hibernation via Cloudflare's hibernating WebSocket API; per-connection state up to 2 KiB serializes via `serializeAttachment()`.

### R1.5 Alarm-based scheduling

Suspended tasks (`SUSPEND`, `FORK`, `READ`-with-timeout) are durable on the parking DO via SQLite + a DO alarm set at the earliest resume time. On alarm fire, the DO wakes and resumes all due tasks. See [../semantics/tasks.md §16](../semantics/tasks.md#16-task-lifecycle-and-suspension).

### R1.6 Connection routing

Each WebSocket connects to its player's DO directly (singleton-per-player). The Worker performs auth then forwards the upgraded WebSocket to the appropriate DO via `fetch` with the WebSocket attached.

### R1.8 Teardown

When a recycle drains a DO's hosted *payload* count to zero (host-scoped
support copies do not count — see [../semantics/recycle.md §RC11.1](../semantics/recycle.md#rc111-trigger)),
the DO migrates its tombstone roster to the Directory (via
`POST /__internal/inherit-tombstones`) and calls
`state.storage.deleteAll()`. Storage is deallocated atomically; the
in-memory instance is evicted on the next idle. **The DO id remains
reachable**: a stale stub can re-activate an empty instance under the
same id, and that activation must hit the cold-load guard below. This is
the only place in the substrate that uses `deleteAll`. See
[../semantics/recycle.md §RC11](../semantics/recycle.md#rc11-host-teardown-after-recycle)
for the full sequence and [persistence.md §14.2.2](persistence.md#1422-inherited-tombstones-after-host-teardown)
for the Directory's inherited-tombstone authority.

A DO whose storage is empty at cold-load (i.e. a stale stub reached a DO
that previously tore down) MUST consult Directory's `inherited_tombstone`
before running any cold-load seed (§R9.1). If the DO's own id appears as
`former_host`, the DO refuses all inbound requests with `E_HOST_RECYCLED`
and does not write any storage rows; it remains empty and is evicted on
the next idle. (Directory lookups for ULIDs covered by inherited
tombstones answer `E_OBJNF` directly — see [persistence.md §14.2.2](persistence.md#1422-inherited-tombstones-after-host-teardown).
The two codes intentionally differ: `E_HOST_RECYCLED` flags the dead-DO
race; `E_OBJNF` flags a stale ULID dereference.)

`DEFAULT_OBJECT_HOST` (the world DO that hosts `$wiz`, `$system`,
`$catalog_registry`, …) is exempt: its hosted set always contains the
bootstrap floor, so the trigger never fires. The Directory DO itself
also never tears down.

---

## R2. Singleton DOs

| DO | Purpose |
|---|---|
| `Directory` | Holds the corename map, `objref -> host` routing table, session routing index, inherited tombstones from torn-down hosts (per [persistence.md §14.2.2](persistence.md#1422-inherited-tombstones-after-host-teardown)), and small world metadata. Read-mostly, off the hot path. Does **not** mint IDs. |
| `QuotaAccountant` | Periodic eventually-consistent accounting. See [quotas.md](quotas.md). |
| `$system` (`#0`) | Bootstrap object. Holds corename properties. |

Wizard ops requiring DO enumeration (cleanup, stats, dump) go via the CF management plane, not the runtime API.

---

## R3. Per-object repository interface

Each `PersistentObjectDO` owns the SQLite rows for one object or one anchor cluster (per [§R1.1](#r11-routing)). The runtime accesses storage exclusively through this interface; the CF backend implements it against `state.storage.sql`, and other backends (in-memory, local SQLite) implement the same interface so the runtime is transport-agnostic.

> **Canonical reference**: [`src/core/repository.ts`](../../src/core/repository.ts) is the source of truth for `ObjectRepository`. This section mirrors it; if the two diverge, the TS file wins and this section is to be updated.

Operations are scoped to *this DO's hosted set*. Cross-DO operations go through the RPC surface (§R5), not through this interface.

### R3.1 Method set

```ts
interface ObjectRepository {
  // Transactions / unit of work ----------------------------------------------
  // Wrap the final local state/log write so it commits atomically or rolls back.
  // The async behavior body has already completed before this transaction opens.
  // CF uses storage.transactionSync; in-memory backends snapshot-and-restore;
  // local SQLite uses BEGIN/COMMIT/ROLLBACK.
  transaction<T>(fn: () => T): T;
  // Nested rollback scope inside the current transaction. Used by repository-
  // local maintenance and migrations; runtime behavior rollback is an in-memory
  // world savepoint because behavior may await cross-host RPC.
  savepoint<T>(fn: () => T): T;

  // Object identity & metadata -----------------------------------------------
  loadObject(id: ObjRef): SerializedObject | null;
  saveObject(obj: SerializedObject): void;
  deleteObject(id: ObjRef): void;          // recycle path
  listHostedObjects(): ObjRef[];

  // Properties (per-name granularity) ----------------------------------------
  loadProperty(id: ObjRef, name: string): SerializedProperty | null;
  saveProperty(id: ObjRef, prop: SerializedProperty): void;
  deleteProperty(id: ObjRef, name: string): void;
  listPropertyNames(id: ObjRef): string[];

  // Verbs (per-name granularity) ---------------------------------------------
  loadVerb(id: ObjRef, name: string): SerializedVerb | null;
  saveVerb(id: ObjRef, verb: SerializedVerb): void;
  deleteVerb(id: ObjRef, name: string): void;
  listVerbNames(id: ObjRef): string[];

  // Inheritance / containment (denormalized; see persistence.md §14.1) -------
  loadChildren(id: ObjRef): ObjRef[];
  addChild(id: ObjRef, child: ObjRef): void;
  removeChild(id: ObjRef, child: ObjRef): void;
  loadContents(id: ObjRef): ObjRef[];
  addContent(id: ObjRef, child: ObjRef): void;
  removeContent(id: ObjRef, child: ObjRef): void;

  // Event schemas ------------------------------------------------------------
  loadEventSchemas(id: ObjRef): [string, Record<string, WooValue>][];
  saveEventSchema(id: ObjRef, type: string, schema: Record<string, WooValue>): void;
  deleteEventSchema(id: ObjRef, type: string): void;

  // $sequenced_log surface ---------------------------------------------------
  // Two-step inside one commit transaction: appendLog inserts the row;
  // recordLogOutcome updates it with observations, applied_ok, and optional
  // error before commit.
  // See §R3.2 below.
  appendLog(space: ObjRef, actor: ObjRef, message: Message): { seq: number; ts: number };
  recordLogOutcome(space: ObjRef, seq: number, applied_ok: boolean, observations?: Observation[], error?: ErrorValue): void;
  saveCommittedLogEntry(space: ObjRef, entry: SpaceLogEntry): void;
  readLog(space: ObjRef, from: number, limit: number): LogReadResult;
  currentSeq(space: ObjRef): number;
  saveSpaceSnapshot(snapshot: SpaceSnapshotRecord): void;
  loadLatestSnapshot(space: ObjRef): SpaceSnapshotRecord | null;
  truncateLog(space: ObjRef, covered_seq: number): number;

  // Sessions (credential metadata only — see identity.md §I2) ----------------
  loadSession(session_id: string): SerializedSession | null;
  saveSession(record: SerializedSession): void;
  deleteSession(session_id: string): void;
  loadExpiredSessions(now: number): SerializedSession[];

  // Parked tasks (see tasks.md §16) ------------------------------------------
  saveTask(task: ParkedTaskRecord): void;
  deleteTask(id: string): void;
  loadTask(id: string): ParkedTaskRecord | null;
  loadDueTasks(now: number): ParkedTaskRecord[];
  loadAwaitingReadTasks(player: ObjRef): ParkedTaskRecord[];   // FIFO order
  earliestResumeAt(): number | null;

  // Host-scoped counters (atomic read-and-increment) -------------------------
  nextCounter(name: string): number;

  // Bootstrap meta -----------------------------------------------------------
  loadMeta(key: string): string | null;
  saveMeta(key: string, value: string): void;
}
```

### R3.2 Sequenced log commit

`$space:call` ([space.md §S2](../semantics/space.md#s2-the-call-lifecycle)) runs on a single async path. The host serializes behavior executions, reserves `seq = next_seq` in memory for sequenced calls, runs the behavior with an in-memory rollback savepoint, then opens one storage `transaction(fn)` to commit the final local state and log outcome.

The repository still surfaces the log as two calls, but both happen during that final commit transaction:

1. **`appendLog(space, actor, message)`** — inserts the message row and advances durable `next_seq`. Returns `{seq, ts}`. The runtime verifies that returned `seq` matches its in-memory reservation; a mismatch is `E_STORAGE`.
2. **`recordLogOutcome(space, seq, applied_ok, observations?, error?)`** — updates the same row with replayable observations and the behavior outcome before the transaction commits.

The transient `applied_ok IS NULL` state exists only inside the open commit transaction. A committed log row always has `applied_ok = true` or `applied_ok = false`; replay never sees a pending row.

### R3.3 Crash recovery footnote

If the host crashes before the final commit transaction, no in-flight row is committed and no applied frame has been returned. If it crashes during the final commit transaction, the storage layer rolls the whole commit forward or back atomically. If a backend ever finds a committed row with `applied_ok IS NULL`, that is storage corruption or an old-format migration bug. It should refuse new calls on that log and surface `E_STORAGE` for operator repair rather than guessing at replay.

### R3.4 Transactions and rollback scope

The runtime's behavior rollback scope is an in-memory world savepoint, not a storage transaction. That is the essential simplification: cross-host property reads and `CALL_VERB` can be awaited without pretending the whole behavior body is inside `state.storage.transactionSync`.

```
await hostQueue.enqueue(async () => {
  validateAndAuthorize(message);
  const seq = reserveNextSeqInMemory(space);
  const observations = [];

  try {
    await withWorldSavepoint(async () => {
      await runVerbBody(..., observations);
    });
    outcome = { applied_ok: true, observations };
  } catch (err) {
    restoreWorldSavepoint();
    const error = normalizeError(err);
    outcome = { applied_ok: false, observations: [errorObservation(error)], error };
  }

  repo.transaction(() => {
    const appended = repo.appendLog(space, actor, message);
    assert(appended.seq === seq);
    repo.recordLogOutcome(space, seq, outcome.applied_ok, outcome.observations, outcome.error);
    flushDirtyObjectsAndTasks();
  });
});
```

The caller receives an applied frame only after the final commit succeeds. If commit fails, the runtime restores the pre-call in-memory state and returns `op:"error"` with `E_STORAGE`; no durable seq is visible.

Cross-anchor-cluster mutations (cross-DO RPCs from inside the verb body) are **not** in the rollback scope, per [space.md §S3.4](../semantics/space.md#s3-failure-rules-normative). Verb authors avoid them in sequenced flows; if they must, they accept the torn-state risk.

The VM routes ordinary remote property-value writes (`SET_PROP`) to the
owning host, which performs the same permission checks and durable write it
would perform for a local assignment. Property definition, property metadata
edits, and lifecycle operations still raise `E_CROSS_HOST_WRITE` when they
would cross hosts; those operations are authoring/lifecycle changes rather than
ordinary object state writes.

---

## R4. Storage schema pointer

The concrete CF SQLite encoding lives in [persistence.md](persistence.md). The schema is not the runtime contract; [`ObjectRepository`](../../src/core/repository.ts) in §R3 is the contract. Backends may encode rows differently as long as they satisfy that interface.

---

## R5. Cross-DO RPC surface

`PersistentObjectDO` exposes a public method set callable from other DOs (and the Worker). All RPCs carry caller authority (`progr`, `actor`) and a correlation id; all return either a result or an `ErrorValue` per [values.md §V7](../semantics/values.md#v7-errors).

| Method | Purpose |
|---|---|
| `getProp(id, name, expected_version?)` | Property read with lazy version check ([persistence.md §15.3](persistence.md#153-lazy-version-check)). Returns `{value, version, perms}` or `E_PROPNF`/`E_PERM`. |
| `describeObject(id, actor)` / `describeObjects(ids, actor)` | Bundled read of display `name`, actor-readable `description`, and actor-readable `aliases` for look/match projections. Batch form returns a map keyed by id and is preferred when multiple candidate ids are already known. |
| `resolveVerb(id, descriptor)` | Read-only single-verb metadata lookup; descriptor is name or 1-based local slot. Returns slot, canonical name, `arg_spec`, and `direct_callable`, not executable code. Runtime dispatch uses this single resolution shape. |
| `commandVerbCandidates(id, name)` | Read-only command-planning metadata lookup. Returns every local ancestry/feature verb whose canonical name or aliases match `name`, preserving local planner order, with `arg_spec` (including command metadata) and `direct_callable`. Command planning filters this list by `arg_spec.command`; execution still uses ordinary dispatch. |
| `contents(id)` | Read a container's contents mirror for look/match projections. |
| `getVerb(id, descriptor, expected_version?)` | Verb fetch for the cross-host bytecode cache. Returns `{slot, bytecode, version, owner, perms, definer}`. |
| `getAncestorChain(id, expected_version?)` | Chain walk for cache population. |
| `setProp(id, name, value, expected_version)` | Versioned write; `E_VERSION` on stale. |
| `defineVerb(id, ...args, expected_version)` | Authoring; same versioning. |
| `dispatchCall(message, frame_envelope)` | Cross-host verb dispatch (§R6). |
| `appendLog(space, message)` | `$sequenced_log:append`; atomic seq allocation. |
| `readLog(space, from, limit)` | `$sequenced_log:read`. |
| `subscribe(space, observer_do, observer_actor)` | Register observer for applied-frame fan-out. |
| `recycle(id, force?)` | Object destruction per [recycle.md](../semantics/recycle.md). |

Transport: CF Workers RPC (`env.WOO.get(id).method(...)`). Each DO method is `async`; cross-DO awaits show up as task yield points.

### R5.1 RPC envelope

Every cross-DO RPC carries:

```ts
interface RpcEnvelope<T> {
  correlation_id: string;        // for idempotent retry + tracing
  host_chain: string[];          // wait-for-cycle guard, protocol/hosts.md §3.5
  route_class: "read" | "dispatch" | "owner_mutation" | "mirror" | "broadcast";
  caller_do: ObjRef;             // origin DO (anchor root)
  caller_actor: ObjRef;          // task.actor (sticky)
  caller_progr: ObjRef;          // current frame's progr
  payload: T;
}
```

The receiver verifies `caller_progr` for permission gates; `caller_actor` is recorded in any `applied` frame the call produces.

If the receiver's host id already appears in `host_chain`, accepting the call
would create a synchronous wait cycle; the receiver rejects before running
behavior with `E_HOST_CYCLE`. The Worker/DO adapter should normally catch the
cycle before issuing the fetch; the receiver-side check is the backstop for
stale or hand-written internal routes.

---

## R6. Cross-DO verb dispatch

When a verb call resolves to a target object on a different DO, dispatch is an awaited host RPC. The origin keeps the caller continuation; the receiver runs the callee frame and returns the result plus observations.

### R6.1 Non-yielding cross-DO calls (v1 baseline)

For v1 the cross-DO call is a single RPC round-trip:

1. Caller serializes the current frame (`SerializedVmFrame` per [tiny-vm.md](../semantics/tiny-vm.md)).
2. RPC to target DO via `dispatchCall(message, frame_envelope)`.
3. Target hydrates a fresh frame, runs the verb body to completion, captures observations.
4. Target returns `{result, observations, applied_seq?}` to caller.
5. Caller resumes its own frame at the call site.

The caller's task is *not* yielded mid-call — it's the same `await` shape as a local call. Observations from the cross-DO call land in the caller's `applied` frame if the caller is itself in a `$space:call` flow.

### R6.2 Cross-DO calls may not park (v1 normative)

A cross-DO call that attempts `SUSPEND`, `READ`, or `FORK`-with-delay inside the target verb body raises `E_CROSSDO_PARKING_UNSUPPORTED` and unwinds the cross-DO RPC. The caller's frame surfaces the error in its own `try`/`except` chain (or as a `$error` observation if the call was sequenced).

The rule is enforced on the target side: when the VM detects a parking opcode running under a hydrated cross-DO frame, it raises before persisting any task state. This keeps cross-DO RPCs bounded — a target can't stash a continuation on disk that the caller is waiting for.

The restriction is intentional, not a TODO. Long-lived cross-DO awaits would require either (a) callbacks, (b) durable cross-DO continuations, or (c) tolerance for hour+-long DO RPC sleeps — all of which add complexity that v1 doesn't need. v1.1 may relax this with a callback-shaped `awaitable_call` opcode if real use cases emerge.

**Workaround for authors who need cross-DO async**: structure the work as a sequenced call to a space the target object owns. Sequencing produces an applied frame the caller can poll for; no synchronous wait inside the verb body.

### R6.3 Loops and fanout

A verb that calls `$audience.in(room):tell(msg)` on N players hits N DOs in parallel via `Promise.all`. The runtime should batch where possible but the contract is "N independent RPCs."

---

## R7. Alarm-based parked-task resume

DOs replace the local 250ms scheduler poll with native alarms.

### R7.1 Scheduling

After every operation that adds/removes a parked task (FORK, SUSPEND, READ, deliverInput, runDueTasks), the DO computes `min(resume_at)` over all `state == 'suspended'` tasks and calls `state.storage.setAlarm(min_resume_at)`. If no suspended tasks remain, the alarm is cleared.

`READ` tasks (state `'awaiting_read'`) without an explicit timeout do **not** schedule alarms — they wake on `deliverInput`, not on time.

### R7.2 Firing

CF invokes `alarm()` on the DO when the scheduled time arrives. The handler:

1. Loads all tasks where `resume_at <= now AND state == 'suspended'`.
2. Resumes each (per [tasks.md §16.2](../semantics/tasks.md#162-suspend-across-host-eviction)).
3. Computes the new `min(resume_at)` and reschedules.

Alarm fire is best-effort timely (sub-second under normal load; can drift under DO contention). Track skew via instrumentation (§R10).

### R7.3 Idempotency

Alarm scheduling is idempotent — `setAlarm(t)` overrides any previous alarm. Concurrent task adds/removes on the same DO compute the new minimum after the mutation; whoever's last wins, which is correct.

---

## R8. WebSocket hibernation

Per [§R1.4](#r14-hibernation), DOs use CF's hibernating WebSocket API.

### R8.1 Accept

When a Worker forwards an upgraded WS to a DO via `fetch` with `webSocket: ws`:

```ts
state.acceptWebSocket(ws, [tag]);          // tag is per-class identifier
ws.serializeAttachment({
  session_id: string,
  actor: ObjRef,
  socket_id: string                         // host-local; rebuilt on wake
});
```

The attachment must be ≤2 KiB. We carry only the session id + actor + a host-local socket id; the session credential record itself lives in the DO's `session` table.

### R8.2 Hibernation

The DO can hibernate freely between messages. On wake (inbound message, alarm, or RPC), CF calls the appropriate handler. The WS attachment survives via `ws.deserializeAttachment()`.

### R8.3 Message handlers

```ts
async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void>
async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void>
async webSocketError(ws: WebSocket, error: unknown): Promise<void>
```

`webSocketClose` triggers connection drop per [identity.md §I6.1](../semantics/identity.md#i61-connection-close): set `session.last_detach_at`, do *not* reap immediately.

### R8.4 Connection-attached actor binding

The connection's actor is read from the attachment, not from any persistent property. Per identity.md, attached_sockets is intentionally not persisted — connection state is in-memory only on the player host.

---

## R9. Bootstrap on Cloudflare

The seed graph from [bootstrap.md](../semantics/bootstrap.md) materializes the first time a request hits the world.

### R9.1 First-request path

1. Worker receives an inbound request.
2. Worker calls `env.DIRECTORY.get(idFromName("$system"))` (the singleton `$system` DO).
3. `$system` DO checks its `bootstrapped` flag. If false:
   - Acquires its own storage transaction.
   - Materializes universal classes by RPC-creating each — `$root`, `$actor`, `$player`, `$wiz`, `$guest`, `$sequenced_log`, `$space`, `$thing`. Each landed via `env.WOO.get(idFromName(corename)).create(...)`.
   - Installs configured local catalogs per `WOO_AUTO_INSTALL_CATALOGS`; bundled demo classes and instances come from those catalog manifests.
   - Runs deployment-local catalog repair for already-installed local catalogs.
   - Registers corenames in the `Directory` DO.
   - Sets `bootstrapped = true`.
4. Boot is idempotent; concurrent first-requests serialize on `$system`'s single-threaded execution.

Each object-owning DO also runs a host-scoped local catalog lifecycle when
it cold-loads its host slice. Support objects and seed verbs arrive from
the gateway's fresh host seed and merge through `mergeHostScopedSeed`,
governed by the rule in [../protocol/host-seeds.md](../protocol/host-seeds.md).
A brand-new host records the host-scoped content-addressed catalog schema
plan as covered by that seed; a host with stored state applies the plan in
host scope, verifies postconditions, and records the result in
`$system.catalog_migration_records`. When a fresh gateway seed was
available, the host re-runs the merge after the host-scoped lifecycle so
gateway-authoritative state stays current and receiver-hosted lifecycle
mutations are preserved (host-seeds.md §HS5). Host-local data migrations
use the same record path and run against state the host actually owns;
the gateway's `$system.applied_migrations` ledger may be copied into a
host seed, but it does not prove the host's local instance data was
converted.

When `HOST_SEED_KV` is configured, the Worker writes content-addressed
cache entries for host seeds. The KV bytes omit `verb.bytecode` and
include per-verb bytecode hashes; cold readers restore exact bytecode
from local SQL or bundled-catalog reservoirs before using the cache. A
missing or mismatched hash is a cache miss and falls back to the signed
DO response, which still carries full bytecode. The cold reader emits
`kv_catalog_reservoir_build` when it has to build the per-isolate
bundled-catalog reservoir and `host_seed_kv_restore_miss` when a KV
entry is absent or cannot be restored.

Host-seed KV pointer and bytes keys are also namespaced by the bundled local
catalog fingerprint. The content digest alone is not sufficient across deploys:
a bytecode-free stale KV payload can otherwise restore old bundled verb bytecode
from the satellite's own local SQL. A catalog-fingerprint miss forces the
satellite to fetch the gateway's current `/__internal/host-seed` response, while
ordinary code-only deploys keep the same namespace and retain cache locality.

Resident DO instances also persist the last bundled local catalog fingerprint
they reconciled. If a live in-memory world observes a new fingerprint after a
Worker deploy, it repairs before serving the request: the gateway host reruns
local catalog install/repair, and satellite hosts fetch and merge the gateway's
current signed host seed before marking the fingerprint current. The satellite
repair bypasses the KV accelerator because a stale resident gateway can have
written a bytecode-free KV seed under the same catalog fingerprint before the
repairing deploy. This closes the resident-world case where a deploy changes
bundled verb source but the DO keeps serving an already-loaded host slice.

A wizard may ask the gateway to refresh live object hosts with
`POST /api/admin/refresh-host-seeds`. The gateway exports each requested
host-scoped seed and sends it to the owning DO. The receiving host merges that
seed into its live world and persists only when the merge changed state. This
live refresh treats the gateway seed as authoritative and does not run manifest
repair on the partial host slice; host-local lifecycle repair remains a
cold-load responsibility. When a wizard supplies an explicit `hosts` list, names
that do not match any routed object host are reported as skipped with
`reason = "unmatched_host"`.

### R9.2 Boot identity

Boot runs as `$wiz` (the seed wizard). All `:add_feature`, `:setProp`, etc. invoked during boot satisfy the wizard-bypass rules (per features.md §FT5, identity.md §I7).

### R9.3 Idempotent reboot

Per [bootstrap.md §B9](../semantics/bootstrap.md#b9-idempotent-rebooting), every step skips a seed whose corename is already mapped in Directory. Re-running boot after a partial failure (e.g., a DO crashed mid-create) finishes the unfinished work without disturbing existing seeds.

---

## R10. Instrumentation

The runtime is world-visible from day one — even a "first cut" deployment must be measurable. Three primitives:

### R10.1 Workers Analytics Engine

Standard binding `METRICS`, dataset `woo_v1_<env>` (e.g. `woo_v1_prod`).
Every load-bearing call site emits a `MetricEvent` (`src/core/types.ts`);
each DO funnels its events through `src/worker/metrics-sink.ts` which
both `console.log`s and writes one data point to AE. AE handles
aggregation; the `/admin/stats` panel queries the AE SQL API.

```ts
env.METRICS.writeDataPoint({
  blobs:   [/* fixed-width 17-slot dimension map; see "Slot map" below */],
  doubles: [/* fixed-width 3-slot numeric map; see "Slot map" below */],
  indexes: [host_key]                  // the only high-cardinality index
});
```

#### Index choice — `host_key`

`host_key` identifies the DO/logical component the metric came from
(`world`, `the_chatroom`, `the_deck`, `directory`, `mcp-gateway-N`,
each `the_<instance>`). AE's adaptive sampling boundary is per-index
value, so a burst on one host doesn't degrade the fidelity of quieter
hosts. This also matches the dashboard's primary pivot — "by component".

#### Slot map (stable; the `/admin/stats` query layer hard-codes positions)

The slot map is fixed-width: every data point fills all 18 blobs and 3
doubles. Axes the event doesn't carry land as empty strings (blob) or 0
(double). New axes get a NEW slot; existing slots are never reordered
or repurposed.

| Slot | Field | Source on `MetricEvent` |
|---|---|---|
| `blobs[0]`  | `kind`      | every event |
| `blobs[1]`  | `scope`     | `v2_*`, `shadow_*`, `mcp_fanout`, `direct_call`, … |
| `blobs[2]`  | `class`     | `do_constructor`, `do_handler` |
| `blobs[3]`  | `route`     | `do_handler.route`, `cross_host_rpc.route`, `shadow_*_step.route`, browser turn route |
| `blobs[4]`  | `method`    | `do_handler.method`, `mcp_request.method`, browser IndexedDB/WebSocket method |
| `blobs[5]`  | `phase`     | `shadow_*_step.phase`, `startup_storage.phase`, `init.phase`, `v2_open_step.phase`, `browser_activity.phase` |
| `blobs[6]`  | `what`      | `storage_direct_write.what`, browser cache/IndexedDB store |
| `blobs[7]`  | `status`    | `"ok" \| "error" \| "timeout"` |
| `blobs[8]`  | `error`     | error code (`E_*`) |
| `blobs[9]`  | `target`    | `direct_call.target`, `dispatch_resolved.target`, falls back to `dangling_parent_ref.start` |
| `blobs[10]` | `verb`      | `applied.verb`, `direct_call.verb`, `dispatch_resolved.verb` |
| `blobs[11]` | `tool`      | `mcp_request.tool` |
| `blobs[12]` | `host`      | `cross_host_rpc.host`, `dispatch_resolved.host`, `host_schema_sync.host` |
| `blobs[13]` | `actor`     | `mcp_tool_refresh_*.actor`, `dispatch_resolved.actor` |
| `blobs[14]` | `path`      | `dispatch_resolved.path`: `local \| read \| mutating`; browser frame/activity path |
| `blobs[15]` | `reason` / `mode` | `mcp_tool_refresh_*.reason`, `shadow_commit_rejected.reason`, `rest_v2_in_process_fallback.reason`, `commit_reply_replay.mode`, `shadow_transcript_anomaly.reason`, browser fallback/cache reason |
| `blobs[16]` | `error_detail` | bounded diagnostic detail for uncoded internal errors |
| `blobs[17]` | `source`    | `browser_activity.source` (`main` or `v2_browser_worker`) |
| `doubles[0]` | `ms`         | latency, when present |
| `doubles[1]` | `sample_rate`| 1 by default, or the 1-in-N multiplier (see "Sampling" below) |
| `doubles[2]` | `count`      | primary kind-specific count: `rows`, `audience_size`, `observations`, `fanout`, `hosts`, `objects`, `bytes`, or anomaly event count |

The canonical event union is `MetricEvent` in `src/core/types.ts`. That
union is the source of truth for which kinds exist and which fields they
carry; this spec only describes how those fields project onto AE slots.

`authority_slice_reconstructed` partitions the authority-slice cost that used to
appear as opaque `/mcp` wall time. Its `reason` value is written to `blobs[15]`
and MUST distinguish warm turn refresh, cold open, missing-state repair,
source-host slice service, warm checkpoint hit, warm checkpoint catch-up, and
warm checkpoint repair. `object_count` and `page_count` size the served slice;
the primary AE count slot uses the object count. After B7, warm MCP planning
SHOULD NOT emit owner-fan-in `warm_turn_refresh` work before every turn; a
one-attempt warm turn should have at most the bounded commit-refresh authority
payload, usually with snapshot fallback on the first envelope attempt. This
event remains the gate for [cell-authority.md §CA11.1](../protocol/cell-authority.md#ca111-gateway-authority-checkpoints):
healthy warm turns should move away from repeated pre-plan `warm_turn_refresh`
fan-in, same-scope projection tails should emit `warm_checkpoint_caught_up`,
checkpoint coverage misses should emit `warm_checkpoint_repaired` only when the
repaired checkpoint is stored and will turn the next matching request into
`warm_checkpoint_hit`, first warm refreshes that seed a bounded checkpoint
should emit `warm_checkpoint_seeded`, and stale-fallback/timeout/over-budget
rows must not be stored as checkpoints.

#### Sampling

Console-tail is unaffected (it sees every emission). AE-side sampling:

- **Dropped (never written):** `shadow_apply_step` and
  `shadow_gateway_apply_step` records whose `phase != "total"`. The
  `total` phase carries the same dashboard-visible information; the
  per-phase records are ~10× amplification per envelope.
- **1-in-10:** `storage_direct_write`, `storage_flush`. The multiplier
  (10) is recorded in `doubles[1]` so dashboard queries can reconstruct
  totals — e.g. `SUM(double2 * double1)` for sampled-up sums.
- **Always written:** any event with `status:"error"` or a non-empty
  `error` field, regardless of kind. Dashboard error panes must reflect
  ground truth even during a burst.
- **1:1:** everything else.

AE write failures are swallowed inside the sink. A broken AE binding
must never propagate into the request path.

#### Cost

One AE write per `MetricEvent` is fine at v1 traffic levels; the
sampling rules above keep the storage-write hot kinds within the free
100k-writes-per-dataset-per-day budget. Each environment (`woo_v1_prod`,
`woo_v1_staging`) has its own quota.

Startup storage instrumentation is emitted by the DO/repository wrapper before the `WooWorld` metrics hook exists. It covers repository schema migration, repository load/save, host-seed fetch (`host_seed_fetch`), Directory schema setup, Directory object-route registration (`directory_register_objects`), and Directory session-route registration (`directory_register_session`). Both Directory register phases include a `writes` count distinguishing diff-deduped no-ops (`writes: 0`) from actual row writes; downstream metric consumers can monitor that ratio to confirm dedup is healthy.

Browser activity instrumentation is first-class because v2 open latency spans
the browser cache, the network, the gateway, and CommitScopeDO. The browser
worker posts `browser_activity` batches to `/api/browser-metrics`; the gateway
authenticates the session, overwrites the actor with the session actor, and
emits them under host key `browser`. Required activity coverage includes
worker commands, WebSocket connect/readiness/send, frame decode/process, cache
mutation kind, IndexedDB store/mode transactions, execution-cache rebuilds,
local turn planning, state repair requests, main-thread projection apply, and
render. These metrics are diagnostic only and must never add UI back-pressure:
the client batches posts, bounds the pre-session queue, and the gateway applies
a per-session one-second sampling window before writing browser metrics. A noisy
tab is capped to one browser-metric POST per second and drops oldest queued
diagnostics beyond the local hard cap.

`v2_open_step` splits aggregate `/v2/open` wall time across both authority
planes. CommitScopeDO phases cover request verification/read, relay lookup,
session seeding, head/session persistence, browser relay construction, shadow
open, executable seed construction/digest/install, full-save, checkpoint/tail
packaging, checkpoint continuation stale, checkpoint pending, asynchronous
checkpoint build, and response encoding. The gateway
WebSocket phases cover authority payload construction, CommitScopeDO open RPC,
and WebSocket frame encoding/sends for hello, legacy display transfer,
checkpoint/tail transfer chunks, executable transfer, and ads.

Cold-restart skip paths emit dedicated phases when the gateway recognizes that no work is needed:

- `directory_register_objects_skip` — gateway computed a SHA-256 of its current object-route set, found it identical to the persisted `published_routes_digest` meta value, and bypassed the Directory `register-objects` RPC entirely. Carries `routes` (count compared) but no `writes`. Absence of any `directory_register_objects` metric on a cold restart with this skip emitted is the actual savings (~one signed RPC + Directory transaction per cold gateway boot).

### R10.2 Structured logs

`console.log` lines are JSON, captured by Logpush → R2 (default) or external sink (Datadog/Honeycomb if configured). Mandatory shape:

```json
{
  "ts": 1714435200000,
  "level": "info|warn|error",
  "event": "snake_case_event_name",
  "do_id": "01HXYZ...",
  "request_id": "uuid",
  "fields": { ... }
}
```

`request_id` propagates from Worker through every cross-DO RPC envelope (§R5.1) so a single user request can be reconstructed across DOs.

### R10.3 Per-DO `:metrics()` introspection

Every persistent object exposes a direct-callable `:metrics()` returning a rolling-window counter snapshot:

```ts
{
  calls_total: int,                   // since DO last initialized
  calls_window_60s: int,
  errors_total: int,
  errors_window_60s: int,
  parked_tasks: int,
  storage_bytes: int,                 // from state.storage.sql.databaseSize
  alarms_fired_total: int,
  last_alarm_skew_ms: int,
  uptime_ms: int                      // since last hibernation wake
}
```

Wizards aggregate via `wiz:world_metrics()` which fans out via Directory + presence walk.

### R10.4 Wizard audit

Every `is_wizard` bypass site emits a `wizard_action` event (§R10.1) AND a structured log line at `info` level. Bypass sites covered:
- `X-Woo-Force-Direct: 1` header
- `X-Woo-Impersonate-Actor` header on trusted internal DO requests; the public gateway strips this header and public REST uses the body `actor` field instead
- Wizard force-recycle of forbidden objects
- Wizard force-set-status (workflow gate bypass)
- Manual `$system:rebuild_seeds`

Audit is mandatory; no per-deployment opt-out.

### R10.5 What's not in v1 instrumentation

- Distributed tracing with span trees (deferred; structured logs + `request_id` give partial coverage).
- Continuous profiling.
- User-facing dashboards (the `:metrics()` introspection is the API; the dashboard is downstream).

---

## R11. Worker entry

The Worker is a thin router. Business logic lives in DOs.

### R11.1 Routes

```
GET  /                                  → static asset (index.html)
GET  /api/objects/<id>                  → DO RPC (describe), routed to <id>'s host
GET  /api/objects/<id>/properties/<n>   → DO RPC (getProp), routed to <id>'s host
POST /api/objects/<id>/calls/<verb>     → DO RPC (v2 executor), routed to <id>'s host (Directory-resolved; falls back to gateway). Durable verbs commit through CommitScopeDO from the originating host; live verbs run in-process on the receiving host without CommitScopeDO.
GET  /api/objects/<id>/log              → DO RPC (readLog), routed to <id>'s host
GET  /api/objects/<id>/stream           → 410 E_GONE (retired)
POST /api/auth                          → Sessions handler (mints/resumes session) — gateway host
GET  /v2/turn-network/ws                → v2 WS upgrade → gateway host
POST /mcp                               → first request on gateway host; established sessions route to MCP gateway shard
```

`/api/objects/<id>/calls/<verb>` was previously forced to the `world`
gateway host on the rationale that v2 REST calls run against a gateway
snapshot. That constraint was relaxed in the block-self-hosting work
(see `notes/2026-05-22-horoscope-blocking-world.md` and
`notes/2026-05-22-decomposed-kv-seed-cache.md`). Two architectural
shifts keep routed-call execution safe:

- Live verbs (declared `arg_spec.command.persistence: "live"`) bypass
  CommitScopeDO and execute in-process against the receiving DO's
  local world. No round-trip and no consistency loss because the verb
  reads only its host's own slice.
- Durable verbs still go through CommitScopeDO. CommitScopeDO is the
  authority for ordering; the submitting host's snapshot is a planner
  input that CommitScopeDO validates before accept. The originating
  host's `writeThroughV2CommitToObjectHosts.localApplied` branch
  applies the transcript to its own SQL when it owns the touched
  objects; non-local touched objects still receive
  `/__internal/apply-v2-commit` fanout.

MCP streamable-HTTP traffic is deliberately not pinned to the singleton
`world` gateway after initialization. The first request has no MCP session id
yet and may mint a woo session, so it runs on `world`. Once the client presents
`Mcp-Session-Id`, the Worker resolves the Directory session record, forwards
that authority in signed internal headers, and stable-hashes the MCP session id
to `mcp-gateway-<n>`. A shard cold-loads only the Directory session rows whose
`mcp_shard` matches its host key plus the universal actor-support lineage needed
for the session actor's own MCP control tools. The Directory query is indexed
and paged by `mcp_shard`; a shard must rebind every returned live session, not
re-hash the id and silently discard rows it just loaded. Directory session rows
preserve the original session start time, actor display name, and the actor's
MCP `focus_list`, so a sparse reload does not change primary-session ordering,
degrade roster names to ids, or drop focused tool surfaces. It rebinds MCP
queues from those rows and fetches object authority lazily through the v2
authority-slice path when a turn actually needs it. Verbs that render room
presence declare `reads_room_presence: true`; sparse shards consult that verb
metadata to request Directory session rows for candidate room scopes rather than
branching on catalog command words. It must not import a full `world` snapshot
to resume transport state, and it must not publish or cache object routes from
those sparse rows except for exact ids whose owner was resolved through
Directory. Actual durable turn execution still
commits through `CommitScopeDO`.

Directory presence is leased separately from auth validity. Each
`session_route` carries a `last_seen_at` timestamp distinct from `expires_at`:
`expires_at` is the auth-validity gate (24h for apikey/bearer, the guest TTL for
guests) and `resolve-session` continues to gate on it alone, so a valid-but-idle
session keeps authenticating. The presence readers that feed room co-presence
and MCP fanout — `/sessions-for-scopes`, `/mcp-shards-for-scopes`, and
`/mcp-sessions-for-shard` — additionally require `last_seen_at` within a presence
window (`PRESENCE_LIVE_WINDOW_MS`, matching the in-memory
`IDLE_PRESENCE_LIVE_WINDOW_MS`). Without this split, a long-lived apikey route
lingers as "present" for its full auth lease after its client is gone, which
over-broadens fanout (one cold gateway shard woken per stale row) and bloats the
turn authority payload that `reads_room_presence` verbs pull. The lease is
refreshed ONLY by valid client ingress: `register-session` carries
`touch_presence` (true for MCP/auth ingress — `DELETE /mcp` and client-aborted
requests are excluded before that call), and an internal re-registration
(fanout/replay rewriting a routing column) MUST send `touch_presence: false` so
it cannot extend a stale row's lease — and, for a brand-new route, that
non-ingress write leases no presence at all (the row becomes present only once
real ingress touches it). For an ALREADY-ESTABLISHED MCP session the presence
touch happens at ingress, BEFORE the transport handler runs, not only on the
post-response registration: `gateway.handle` can block for the whole `woo_wait`
window, and live (non-durable) fanout has no replay, so a session whose lease
lapsed while idle must be republished as present before it starts waiting or a
peer's observation during the wait would be dropped. New-session creation and
post-turn detail/scope changes are still published by the post-response
registration. Touches are throttled at both layers: a gateway-local in-memory
W/2 cache prevents an established session from paying a pre-dispatch Directory
RPC on every turn, and Directory's durable W/2 throttle preserves the
`register-session` dedupe's write-storm protection across DO lifetimes and
shards. Presence for delivery and presence for display stay separate: durable
subscribers ride the commit-scope subscriber/fanout path and catch up by replay,
so an idle-but-live session that has fallen out of the presence window is not
kept room-present for its whole auth lease.

`DELETE /mcp` is a session end, not a heartbeat. When an established MCP session
is routed to a shard, the shard closes the local transport queue, drops local
session/tool cache rows, forwards a signed internal end-session request to
`world`, and unregisters the Directory `session_route`. The `/mcp` wrapper must
not run the normal post-response `register-session` path for that 204 response:
doing so would resurrect a closed route and leave temporary guest actors in
durable room contents until a later reap. Operators may use either
wizard-gated `POST /api/admin/purge-inactive-guests` or Basic-auth-gated
`POST /admin/purge-inactive-guests`; both run the same WORLD lifecycle reset
and delete expired Directory session routes. Because MCP smoke and other
stateless clients can strand unexpired guest rows after a client timeout, the
operator purge also uses a short inactivity cutoff for detached guest sessions:
WORLD reaps matching guest sessions and Directory deletes guest `session_route`
rows whose `updated_at` is older than the cutoff, regardless of the transport
that first registered the row. This stricter rule is limited to the operator
recovery path; normal request/session liveness continues to use the guest TTL
and grace windows.

Sparse MCP session projection may include Directory-derived actor
lineage/properties and scope presence rows as `projection` authority pages. It
must not treat Directory's `current_location` as actor movement truth. To satisfy
planning admission for peer session actors whose identity is present but whose
owner live row has not been fetched, shards may include an empty actor
`object_live` placeholder stamped only as `fallback`; accepted-frame cache rows
and owner-authoritative rows outrank that placeholder and replace it before any
durable movement state is trusted. A Directory row whose actor identity would be
only a `name == id` presentation stub MUST NOT be published as projected
authority or as a projected room-content member; a session row is usable by
planning only when the same slice carries an admissible actor identity. The
shared relay cache applies the same rule to derived `cache` rows: old
presentation stubs are pruned from objects, contents, sessions, and cell
provenance before a planning world is built.

MCP turns plan warm-cache-first. A sparse gateway shard does not perform an
unconditional pre-plan authority refresh on every turn. When the PlanningWorld
admission gate or local verb lookup proves the relay cache is missing state, the
repair path may expand a target scope's direct `contents` to fetch owner
authority for those contained objects, capped at 128 objects. This is a bounded
identity/read repair for room-roster planning surfaces such as occupant names;
it must not become global enumeration, and it is not applied to commit-refresh
fan-in. After an accepted MCP or REST commit, the gateway installs any
`accepted_write_cells` `cell_pages` transfer from the reply into the relay cache
as `source:"cache"` so the following turn can plan from the accepted state
without pre-plan owner fan-in.

`CommitScopeDO` is the durable authority for v2 scope heads. On first open for
a scope it materializes the gateway-supplied authority seed into row-shaped DO
SQLite state: one row per materialized object, one row per session, one row per
sequenced log entry, and small metadata/tail tables for the head, counters,
accepted frames, transcript tail, idempotency keys, and cached replies. New
opens seed from `woo.authority_slice.cells.shadow.v1`, whose `page_refs` name
exact object-lineage, live-object, property-cell, and verb-bytecode page hashes
and whose `inline_pages` carry the page values needed for a cold relay. The
legacy single `v2_commit_scope_meta.serialized` blob column and `/v2/open`
`serialized` request field are compatibility inputs: a gateway MAY retry with a
materialized seed snapshot when an older or empty commit authority rejects an
authority-only open with `E_SNAPSHOT_REQUIRED`. After a legacy scope opens
successfully, the DO rewrites the state into row tables and clears the blob
value. Once the relay has been durably materialized, later session opens for the
same scope SHOULD omit `serialized` and rely on the persisted rows plus the
request authority slice.

CommitScopeDO snapshots are materialized planning caches, not independent
owners of live session presence. Each signed `/v2/open`, `/v2/envelope`, and
`/v2/state-transfer` request carries the current authority slice: live session
rows, versioned cells for session actors, the sessions' active rooms, explicit
turn scope/target rows, and their required owner/class/feature/catalog support
cells. The DO refreshes those cells before planning or serving recipient-bound
transfer state so cross-scope movement accepted by one CommitScopeDO is visible
to the next scope without a full-world transfer.
Session rows are valid authority only with their actor object row present in the
same merged planning snapshot. Gateways and CommitScopeDOs MUST omit or prune
dangling session rows before exposing presence to catalog code; projected
presence must never make `present_actors()` return an object ref that cannot be
dereferenced.

Per-envelope authority refresh may fall back to the gateway's last-known rows
when a remote owner times out. This is a stale-read fallback, not an authority
promotion: if the stale rows drive a write or conflict-sensitive read, the
transcript's version checks produce the normal stale/mismatch retry path. The
gateway may still include the submitting actor's local authority row and
actor-class ancestry when those rows are explicit request roots and the gateway
is the actor's Directory-resolved owner. Sparse MCP gateway shards are the
exception: they MUST NOT self-certify a locally loaded actor stub as owner
authority for identity/name or ordinary property cells. They route explicit
actor roots to the Directory-resolved owner for current cells, preserve only
their local session actor `object_live` page as shard-owned live state, and may
carry bounded actor-local support properties such as `home` and `focus_list` as
non-authoritative projection material. If the owner is unreachable, the stale
fallback remains retryable through transcript version checks rather than being
promoted to owner truth.
For MCP sessions whose scope has already completed `/v2/open`, the gateway may
take the same stale-row fallback proactively: it sends live session/actor
authority and local last-known object-owner rows instead of waking those owners
on every envelope. This optimization is not valid for first-open seeding or any
path that is still constructing the CommitScopeDO's durable planning snapshot.

For durable MCP calls whose target is exactly the room/scope object and whose
actor is distinct from that scope, a gateway MAY start a `head_session.v1` open
for the actor scope before local planning proves a B6 relocation. This is a
latency overlap only: it does not select the commit scope, does not make the
actor scope authoritative for the turn, and must be safe to ignore if it fails.
The normal transcript-based commit-scope selection, authority refresh, expected
head validation, and retry path still run before any commit is accepted. The
gateway records the speculative open as `mcp_relocation_prewarm`.

Accepted v2 commits do not rewrite the full world. The commit applies the
transcript to indexed commit-scope state, marks any legacy `SerializedWorld`
cache dirty, and the storage transaction upserts only projection rows named by
the `ApplyResult`: touched objects, sessions, logs, counters, snapshots,
parked tasks, tombstones, and tool surfaces. The normal accepted path MUST NOT
materialize a full `SerializedWorld`; that export is reserved for explicit
legacy/export/checkpoint/execution boundaries. This keeps steady-state commit
storage cost proportional to the turn delta, not to the scope's world size.
Cold opens still write O(authority-seed-size) rows once for a new or migrated
scope.

After `CommitScopeDO` accepts a v2 commit, the origin `PersistentObjectDO` must
synchronously materialize the accepted transcript or row-body-complete
projection writes into every routed object host whose rows were touched by the
commit. The signed internal `POST /__internal/apply-v2-commit` endpoint prefers
the `projection_writes` field when present; otherwise it falls back to applying
the transcript to the receiver's host-owned slice. In either mode it persists
only changed object/property/log/session rows.
The origin must complete this write-through before returning a clean applied
REST/MCP/WS result; if any object host rejects or times out, the caller receives
a retryable error rather than an applied frame whose public object reads would
be stale. The endpoint is idempotent for replayed accepted transcripts.

The Directory `session_route` row records the active MCP shard in `mcp_shard`
after that shard has actually handled the session. Directory exposes only the
scope-filtered signed query `POST /mcp-shards-for-scopes` with
`{scopes: [objref...]}`. It returns shards with live sessions whose
`current_location`/`active_scope` matches any requested scope. Origins must not
broadcast accepted transcripts to every active MCP shard: unrelated cold shards
must not be woken just to discard a replay outside their sessions' affected
scopes.

When a turn is accepted, the origin delivers normal local WebSocket fanout and
also POSTs to affected MCP shards through signed
`POST /__internal/mcp-commit-fanout` with `{scope, origin_session, commit,
transcript}`. `commit` is a `woo.commit.accepted.shadow.v1`; `transcript` is
the matching `woo.effect_transcript.shadow.v1`. Affected shards include
CommitScope fanout recipients and shards with sessions in scopes touched by
transcript moves, creates, contents writes, or presence-list writes. Remote
MCP shard delivery is outside the submit critical path: after the accepted
commit is durable and local write-through/fanout has completed, the origin may
schedule the Directory audience/shard lookup and `/__internal/mcp-commit-fanout`
with Durable Object `waitUntil`.
Runtimes without a background-lifetime primitive may fall back to synchronous
delivery, but they must not weaken the durable object-host write-through rule
above. Failed remote MCP fanout is logged and retried by later replay/open
paths; it does not roll back the accepted commit.
Remote shards consume `commit.projection_writes` plus the accepted transcript
into their gateway projection cache when present, repairing cached container
`contents` from moves/creates when the full container row is absent. They expand
`commit.projection_delta.tool_surface_sources` against their local tool-surface
reverse index to evict stale descriptor cache rows, and any transcript-derived
cached contents repair also invalidates descriptor rows for that container.
They must also apply those row-body-complete projection writes to their
in-memory routing cache without persistence before queue fanout, because MCP
delivery predicates read session active scopes, subscriber rows, and local
reachability from that volatile `WooWorld`. The exception is `sessions` rows:
an MCP shard must persist accepted session projection writes in its local
session table as the hibernation-resilient routing hint for `active_scope`.
Object/log/tool projection ownership remains in the gateway projection cache;
persisting the session row does not make the shard authoritative for object
state. If projection writes are absent, shards fall back to the legacy
transcript/snapshot apply path for materialized rows, but may still consume
marker-only tool-surface invalidations. This keeps co-present MCP sessions
observable across shard boundaries without making any shard authoritative for
durable world state.

MCP submit instrumentation must split the `submit` phase enough to distinguish
the commit-scope envelope RPC from post-accept delivery and gateway projection
cache application. In Worker-shaped runtimes these labels are
`worker.commit_scope_envelope_rpc`, `worker.post_accept_delivery`, and
`worker.gateway_projection_cache_apply` inside `turn_phase_timing.submit_detail_ms`.

`/v2/open` supports an opt-in checkpoint/tail protocol by request body
negotiation: `open_protocol: "checkpoint_tail.v1"`, `known_head`, and bounded
transfer budgets. If the known head is covered by the retained tail and every
retained frame has projection row bodies, `CommitScopeDO` returns frame
transfers, split by continuation when the encoded transfer would exceed the
byte budget. Otherwise it returns projection checkpoint pages and the retained
frame tail as cache seed, also split by continuation when needed. Continuations
are pinned to the retained export id/head/hash; a stale continuation returns
`E_CHECKPOINT_CONTINUATION_STALE`. Legacy `/v2/open` responses remain the
default while checkpoint/tail negotiation is off. `WOO_V2_CHECKPOINT_TAIL_OPEN`
enables the CommitScopeDO body-field protocol for trusted callers.
`WOO_BROWSER_PROJECTION_HOLDER` is the independent browser-holder rollback gate:
when it is off, browser WebSocket open/envelope requests do not ask CommitScopeDO
for browser-profile rows. Browser checkpoint/tail opens are narrower again:
because checkpoint pages sent to browser holders must be browser-profiled,
`WOO_V2_BROWSER_CHECKPOINT_TAIL_OPEN` requires both `WOO_BROWSER_PROJECTION_HOLDER`
and `WOO_V2_CHECKPOINT_TAIL_OPEN`. With either browser gate off, browser opens use
the legacy display transfer even when CommitScopeDO can serve checkpoint/tail to
server-side callers.

The gateway's durable projection-row SQL cache for accepted fanout is always on.
It persists each accepted commit's projection delta (scope head, touched object
rows, and scope-membership rows), persists and serves `ToolSurfaceProjectionRow`
descriptor rows, and serves cached tool surfaces or a session's last
`SessionToolManifest` when an owner descriptor refresh times out. The
`WOO_GATEWAY_PROJECTION_CACHE`, `WOO_TOOL_SURFACE_PROJECTION_ROWS`, and
`WOO_V2_SAME_HOST_STALE_FALLBACK` rollback flags that gated this during rollout
were removed once the path became unconditional. Applying a projection delta is
idempotent by scope head: a duplicate envelope replay or a redelivered fanout
frame whose position is already reflected in the cache is a no-op, so replays
cost zero durable writes. `WOO_TOOL_SURFACE_SOURCE_INDEX_MAX_ROWS`
caps reverse-index rows per gateway scope, defaulting to 10,000 rows.
`WOO_TOOL_SURFACE_SOURCE_INDEX_MAX_SHARD_ROWS` caps reverse-index rows per
gateway shard, defaulting to 40,000 rows. When either cap is hit, the gateway
stores the descriptor row as stale, marks the active scope saturated, and avoids
adding source-index entries, so descriptor reads fall back to the session
manifest or an owner refresh instead of relying on an unbounded invalidation
index.

`WOO_V2_EXECUTION_CAPSULE` controls a separate MCP/REST execution-open
optimization. When enabled, a gateway that already has a local execution view
for a durable scope may submit the next `/v2/envelope` with
`execution_capsule.kind == "woo.execution_capsule.v1"` instead of first calling
legacy executable `/v2/open`. If the matching `CommitScopeDO` has no durable
snapshot, it returns `E_SNAPSHOT_REQUIRED`; rollout callers then perform the
legacy seed bootstrap and retry without the capsule. This flag does not change
checkpoint/tail projection catch-up and does not add a Cloudflare Durable Object
class migration. Planned-transcript commits are not eligible for this shortcut:
when the chosen commit scope differs from the planned transcript's turn-key
scope, the gateway must first open the chosen scope with
`open_protocol: "head_session.v1"`, adopt its current head, and submit the
transcript envelope without `execution_capsule`. Warm head/session opens carry
only session rows and never build executable seed transfers; cold scopes may
retry the same protocol with a seed snapshot. The envelope payload must include
the bound MCP session row in the request `sessions` field and in
`authority.sessions`; otherwise the selected CommitScopeDO cannot derive
the browser-session auth claim for a session that only the gateway shard has seen.

Live no-commit v2 transcripts follow the same MCP shard discovery and are sent
through signed `POST /__internal/mcp-live-fanout` with `{scope,
origin_session, transcript}`. Remote shards do not apply these transcripts as
durable state; they route the observations into MCP wait queues and deduplicate
by transcript hash so internal retries do not double-deliver chat.

Remote shards deduplicate accepted fanout by `(scope, seq)` using a bounded LRU.
For scopes the shard has opened through its v2 relay, accepted commits are
applied in relay-head order only: a commit with `seq == head.seq + 1` applies,
newer commits wait in a bounded per-scope pending buffer, and already-applied
older commits are dropped. Pending entries are aged and capped so a hot shard
cannot grow without bound if an earlier frame never arrives. Scopes that the
shard has not opened have no local relay head, so they fall back to immediate
best-effort cache apply.

### R11.2 ID resolution

The Worker resolves `<id-or-name>` to a DO id:

- `#<ulid>` → Directory route lookup. If Directory has no row for the id (uncreated, or pre-§R1.1 storage from before Directory rows existed) the Worker returns `404 E_OBJNF`; there is no `idFromName(ulid)` fallback because that would route co-resident ids to nonexistent dedicated DOs.
- `$<corename>` → fetch from Directory DO, then `env.WOO.idFromName(host_key)`.
- `$me` → resolve from `Authorization: Session <id>` → session.actor → `idFromName(actor)`.
- `~<tref>` → not on this hop; transient refs route to the carrying player's DO.

Unresolvable identifiers → `404 E_OBJNF`.

### R11.3 Auth at the edge

The Worker validates `Authorization: Session <id>` against the Sessions surface (a singleton SessionsDO or per-player session table — see R11.4). Successful resolution yields `{actor, expires_at, active_scope}`. The actor, current session active scope, and correlation id flow into the DO RPC envelope. Transitional envelopes may also carry `current_location` as a legacy alias.

Token classes (`guest:`, `session:`, `bearer:`, `apikey:`) are validated here. Rejected tokens return `400 E_INVARG` or `401 E_NOSESSION` without ever touching DOs.

### R11.4 Sessions placement

Two reasonable shapes; pick at impl time, not at spec time:

**Option A: per-player sessions.** Sessions live in the player's own DO (in the existing `session` table per [persistence.md §14.1](persistence.md#141-per-mooobject-schema)). The Worker indexes session_id → player via either (a) a Sessions singleton DO holding only the index, or (b) embedding the player ULID in the session id itself (e.g., session_id = `<player_ulid>:<random>`).

**Option B: SessionsDO singleton** holds all sessions. Simpler indexing, hot DO.

Lean: **Option A with embedded player ULID**. Avoids a singleton bottleneck and matches identity.md's "session is per-actor."

The Directory's session routing row is a routing cache, not the canonical session record, but it mirrors the session's `active_scope` so object-routed REST calls can seed the target host's session record before dispatch. The current SQLite column name remains `current_location` until a storage migration is justified. WebSocket and internal host-to-host calls carry the same value in the forwarded call body/context.

---

## R12. wrangler config

Skeleton `wrangler.toml`:

```toml
name = "woah"
main = "src/worker/index.ts"
compatibility_date = "2026-04-01"
compatibility_flags = ["nodejs_als"]

[[durable_objects.bindings]]
name = "WOO"
class_name = "PersistentObjectDO"

[[durable_objects.bindings]]
name = "DIRECTORY"
class_name = "DirectoryDO"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["PersistentObjectDO"]

[[migrations]]
tag = "v2"
new_sqlite_classes = ["DirectoryDO"]

[[analytics_engine_datasets]]
binding = "METRICS"
dataset = "woo_v1_prod"

[observability]
enabled = true
head_sampling_rate = 1.0
```

`new_sqlite_classes` (vs `new_classes`) opts into the new SQLite-backed DO storage (per CF's 2026 default for new projects). All persistence schemas in [persistence.md](persistence.md) target this storage shape.

The repository verifies this class-history ledger with
`scripts/sync-wrangler-do-migrations.mjs`. The script compares current
`durable_objects.bindings` against the final class set produced by the ordered
`[[migrations]]` history, appending deterministic `cf-do-NNNN` create entries
for new classes when run with `--write`.

Logpush configuration is per-account, not in wrangler — `wrangler logpush create` or via dashboard, targeting an R2 bucket.

---

## R13. Cost notes

- Every persistent object is a DO with its own SQLite footprint. Idle DOs hibernate to ~zero idle cost.
- Per-DO 1k req/sec soft cap means a single hot object naturally rate-limits incoming traffic. Adversarial saturation against one object cannot bring down the world.
- AE writes are inexpensive; one per call site is well under cost concern at v1 traffic.
- DO storage cost is per-object SQLite size; small objects (~few KB) are nearly free.
- DO SQLite billing counts rows written, including deletes and index updates. Runtime commits must therefore flush only dirty object/property/session/task slices, not the whole host graph, and should emit `storage_flush` metrics so operators can find write-amplified verbs.
- `CommitScopeDO` follows the same cost discipline for v2 authority state: a cold scope open writes the initial row-shaped world, while accepted envelopes write only the transcript-touched object rows and small commit-tail/idempotency rows. A return to full-world blob rewrites on each commit is non-conforming for the Cloudflare reference.
- Continuous UI gestures should use direct live observations for previews and coalesce durable writes at the application edge. Generic sequenced calls are never debounced by the host: once a call returns an applied frame, its log outcome and dirty state are durable.
- Real deployment cost numbers are tracked in operator notes as traffic grows.

---

## R14. Deploying your own world

The reference deployment is intended to be **fork-and-deploy**. Anyone who picks up this repo can run their own world in their own Cloudflare account. The single biggest design constraint that follows: nothing in the runtime may assume a particular operator, account, or pre-existing identity. The seed graph is universal; everything operator-specific is configuration.

For command-level rollout steps and local bootstrap, use [DEPLOY.md](../../DEPLOY.md).

### R14.1 Prerequisites

An operator deploying their own world needs:

1. A Cloudflare account on the **Workers Paid** plan ($5/month minimum). Durable Objects require Workers Paid; Workers Free deploys will fail at first request with an explicit DO-binding error.
2. `wrangler` installed locally and authenticated (`wrangler login`).
3. A clone of this repository.

That is the entire required surface. Optional bindings (Workers Analytics Engine for metrics, R2 + Logpush for log retention, custom domain) are documented as additions, not prerequisites — a fresh deploy with no AE binding still runs, just without metric writes.

### R14.2 Required configuration

Two secrets must be set before first deploy. A third secret is required before enabling self-service signup. They are single-string values and go through `wrangler secret put` (never the `[vars]` block in `wrangler.toml`).

| Secret | Purpose |
|---|---|
| `WOO_INITIAL_WIZARD_TOKEN` | One-time token presented at first auth to claim the `$wiz` binding. Consumed on use; subsequent auths cannot present the same value. See §R14.4. |
| `WOO_INTERNAL_SECRET` | HMAC key for gateway/Directory/cluster-host internal requests. Unsigned or tampered internal requests are rejected before forwarded session, actor, or `progr` fields are trusted. |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile siteverify secret for `/api/signup`. Required only for self-service signup; requests fail closed when unset. |

The Worker checks bootstrap/internal secrets at startup. A missing signup secret is reported on `/api/signup` with `E_PERM` — see §R14.7.

For local development, the value lives in `.dev.vars` (gitignored) with a sane default. A `.dev.vars.example` file in the repo root shows the shape; operators copy it to `.dev.vars` and edit.

### R14.3 Optional bindings

Each of the following is **optional**: the Worker checks for the binding at startup and degrades gracefully if absent.

| Binding | Type | Behavior when present | Behavior when absent |
|---|---|---|---|
| `METRICS` | Analytics Engine dataset | Per-call AE writes per [§R10.1](#r101-workers-analytics-engine). | All AE writes no-op. Structured logs still emitted. |
| `LOGPUSH_BUCKET` | R2 bucket for Logpush | Operator configures Logpush separately to push structured logs there. | Logs reach `wrangler tail` only; no durable retention. |

Operators may add bindings in `wrangler.toml` after deploy without redeploying the runtime — the runtime detects new bindings on next isolate cold-start.

#### R14.3.1 Custom domain

Optional, and not a binding. By default the world is served at
`<worker-name>.<account-subdomain>.workers.dev`. To serve it at an
operator-owned hostname, add a `routes` entry to `wrangler.toml`:

```toml
routes = [
  { pattern = "<your-host>", custom_domain = true }
]
```

`custom_domain = true` attaches the hostname directly to the Worker:
the next `wrangler deploy` registers the route, Cloudflare creates the
DNS record on the zone, and a TLS certificate is provisioned
automatically. The zone must be on the same Cloudflare account as the
Worker. The `workers.dev` URL continues to serve in parallel, which is
useful for canary smoke tests during a cutover.

The reference deployment ships its production route block in the
committed `wrangler.toml` as a working example; a fork-and-deploy
operator replaces `<your-host>` with their own hostname (or deletes the
block to keep serving on `workers.dev` only).

### R14.4 Operator identity bootstrap

The bootstrap-token contract — single-use semantics, error vocabulary, rotation, and forbidden alternatives — is mode-neutral and lives in [auth.md §A11](../identity/auth.md#a11-initial-wizard-bootstrap).

In Cloudflare mode the secret is provisioned via:

```sh
wrangler secret put WOO_INITIAL_WIZARD_TOKEN
```

The Worker reads it at request time, compares byte-equal against the presented `wizard:<random-string>` token, binds the connecting actor to seeded `$wiz`, mints a session, sets `$system.bootstrap_token_used = true`, and registers the session route in Directory. Subsequent presentations of the same token return `401 E_TOKEN_CONSUMED`.

### R14.5 ID determinism status

Per [objects.md §5.5](../semantics/objects.md#55-id-allocation), the long-term target is deterministic object-id allocation from per-world entropy. The current v1 Worker does **not** implement that allocator and does **not** read `WOO_SEED_PHRASE`.

Current deploy semantics:

- Seeded core and catalog objects keep the IDs declared by their seed data.
- Runtime-created persistent objects keep the IDs committed in storage.
- Re-running bootstrap is idempotent because existing objects are discovered and preserved, not because a seed phrase remints the same graph.

Seeded deterministic ULID allocation remains deferred. Until it lands, `WOO_SEED_PHRASE` is not a deploy requirement and must not be presented to operators as a portability or collision-resistance guarantee.

### R14.6 First-deploy and upgrade discipline

**First deploy** (`wrangler deploy` against an empty CF environment):

1. Worker code uploaded; DO classes registered with the migration `tag = "v1"`.
2. First request triggers bootstrap (per [§R9](#r9-bootstrap-on-cloudflare)).
3. Operator runs the wizard-bootstrap exchange (§R14.4).
4. World is live.

Fresh Worker namespaces must not include historical `deleted_classes` or
`renamed_classes` entries for classes that were never deployed in that
namespace. Those entries are valid only as append-only upgrade history for the
specific Worker that previously created the source classes. A renamed or
replacement namespace such as the reference `woah` deployment starts with a
create-only class ledger for its current Durable Object bindings.

**Pulling upstream changes**:

When operators pull updates from this repository and redeploy, the migration tags must be ordered consistently — never rewrite history. Specifically:

- Each `[[migrations]]` block in `wrangler.toml` represents a deploy generation.
- New tags append; old tags persist in the operator's deployed history.
- DO class renames use `renamed_classes`; class deletions use `deleted_classes`. Both are append-only.
- Operators who fork and diverge their migration history cannot cleanly merge upstream changes — document this clearly.

**Upgrade rule for repo maintainers**: never edit existing `[[migrations]]`
blocks. Use `scripts/sync-wrangler-do-migrations.mjs` to verify or append
deterministic CF DO tags such as `cf-do-0006`. These identities are Cloudflare
class-history bookkeeping; they are not catalog versions and not
`$system.spec_version`.

Operators verify the source-controlled class-history ledger with
`npm run cf:migrations:check` before deploy and confirm application from
Wrangler/Cloudflare deploy output. Woo catalog installs and updates have their
own runtime audit path through `$catalog_registry`; CF DO class migrations are a
separate platform ledger.

Deploy postflight SHOULD warm `world`, MCP gateway shards, and a bounded sample
of routed catalog instance hosts before running cross-actor smoke. This is not a
substitute for measuring cold-start cost; it prevents the smoke's behavioral
assertions from consuming the deployment's first serialized Durable Object
activation while still improving the first-user path after a successful deploy.

### R14.7 Failure modes

A misconfigured deploy must fail loudly, not silently. The Worker's startup check:

| Condition | Response |
|---|---|
| `WOO_INITIAL_WIZARD_TOKEN` unset on a fresh world (no `bootstrap_token_used`) | Every request returns `503` with body `{ error: { code: "E_BOOTSTRAP_TOKEN_MISSING", message: "set WOO_INITIAL_WIZARD_TOKEN via wrangler secret put" } }` |
| `WOO_INTERNAL_SECRET` unset | Every request returns `503` with body `{ error: { code: "E_BOOTSTRAP_TOKEN_MISSING", message: "set WOO_INTERNAL_SECRET via wrangler secret put" } }` |
| Workers Free plan (no DO support) | `503` with body `{ error: { code: "E_DO_UNAVAILABLE", message: "Durable Objects require Workers Paid plan" } }` |

A working deploy never returns `503` for these reasons. Operators see them only if they skipped a setup step.

### R14.8 What's not in v1 fork support

Reserved for later:

- **Multi-tenancy in a single deploy.** One deploy = one world. Hosting many isolated worlds in a single CF account requires either separate Worker deployments (already supported by CF, no woo work needed) or a deeper isolation model (deferred).
- **Operator-to-operator world handoff.** Transferring a world from one CF account to another involves DO data export and object-id preservation. Possible via the JSON-folder dump format ([persistence.md](persistence.md) implicit), but not yet a documented flow.
- **Auto-scaling / multi-region tuning.** CF picks the closest region per DO automatically; v1 does not expose region pinning.
- **Federated worlds.** Out of scope for v1; reserved for v2 (see [federation.md](../deferred/federation.md)).
- **Metered billing / per-world cost dashboards.** Operators consult their CF dashboard.

---

## R15. v1 scope vs deferred

Required for first deploy:
- §R1, §R3, §R4, §R5, §R6.1, §R6.2, §R7, §R8, §R9, §R10.1–R10.4, §R11, §R12.
- Single-region (CF picks closest region per DO).

Deferred to v1.1+:
- Callback-shaped cross-DO async (`awaitable_call` or equivalent) that relaxes §R6.2.
- QuotaAccountant DO (table scaffolded; alarm skipped at first; raise `E_QUOTA` only on hard caps from inline writes).
- Snapshot policy automation for spaces that choose manual snapshot triggers.
- Distributed tracing.
- Multi-region tuning.
- Dashboard UI for `:metrics()` rollup.

Reserved for v2:
- Cross-operator federation (separate spec at `deferred/federation.md`).
- Advanced quota real-time approximation (per [quotas.md §R5.4](quotas.md#r54-real-time-approximation-todo)).
