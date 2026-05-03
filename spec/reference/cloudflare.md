# Reference architecture: Cloudflare

> Part of the [woo specification](../../SPEC.md). Layer: **reference**. Profile: **v1-core**. Concrete mapping of woo's abstract host model and persistence onto Cloudflare's primitives. Other implementations are possible; this document is the reference plan.

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
| **Self-hosted-instance DO** | `env.WOO.idFromName(<obj_id>)` | One DO per instance of a class declaring `instances_self_host` (per [semantics/objects.md §4.2](../semantics/objects.md#42-host-placement)). Rooms, players, anchor spaces (`the_dubspace`, `the_taskspace`), and v1-ops singletons (`$catalog_registry`) each get their own DO. |
| **Gateway DO** | `env.WOO.idFromName("world")` | The default home for objects whose class does not self-host. Universal `$`-classes, ad-hoc objects with no anchor, and runtime-created objects whose creator is the gateway itself live here. The Worker entry uses the gateway DO for global routes (`/api/auth`, `/healthz`, `/ws` upgrade) and as the catch-all when no other host claims an id. |
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

**Bundled object descriptions.** Read-heavy projections such as room `:look` and `$match` object resolution should use bundled cross-host describe RPCs where available, returning the common display fields (`name`, `description`, `aliases`). When a caller already has several candidate objects on the same host, it should use the batch form (`describeObjects`) so one room look or command parse pays one RPC per host rather than one RPC per item. `name` is the object's display name; property fields use the same per-property read filtering the separate `getProp` calls would apply. This is an optimization, not a new authority surface: callers must still pass the actor/progr identities used for the equivalent reads, and a host may return `null` for fields the actor cannot read.

**Remote command planning reads.** A room-hosted command planner may need to inspect a visible object's verb metadata when that object is hosted elsewhere. The host RPC returns only the slot, canonical verb name, aliases/arg spec needed for planning, and `direct_callable` flag; actual execution still routes through ordinary direct or sequenced dispatch and re-checks permissions on the object host.

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

---

## R2. Singleton DOs

| DO | Purpose |
|---|---|
| `Directory` | Holds the corename map, `objref -> host` routing table, session routing index, and small world metadata. Read-mostly, off the hot path. Does **not** mint IDs. |
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

The VM does not perform raw remote property writes (`SET_PROP`, property definition, or property metadata edits) from inside a running behavior. Those raise `E_CROSS_HOST_WRITE`. Cross-host mutation, when unavoidable, is expressed as `CALL_VERB` to the remote object so the receiving host performs its own permission checks, sequencing discipline, and audit trail.

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
| `resolveVerb(id, descriptor)` | Read-only verb metadata lookup for command planning; descriptor is name or 1-based local slot. Returns slot, canonical name, and `direct_callable`, not executable code. |
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
   - Installs configured local catalogs per `WOO_AUTO_INSTALL_CATALOGS`; first-light demo classes and instances come from those catalog manifests.
   - Runs deployment-local catalog repair for already-installed local catalogs.
   - Registers corenames in the `Directory` DO.
   - Sets `bootstrapped = true`.
4. Boot is idempotent; concurrent first-requests serialize on `$system`'s single-threaded execution.

Each object-owning DO also runs a host-scoped local catalog lifecycle after it
loads or refreshes its host slice. Support objects and seed verbs arrive from
the gateway's fresh host seed and merge through `mergeHostScopedSeed`. A
brand-new host records the host-scoped content-addressed catalog schema plan as
covered by that seed; a host with stored state applies the plan in host scope,
verifies postconditions, and records the result in
`$system.catalog_migration_records`.
Host-local data migrations use the same record path and run against state that
the host actually owns. The gateway's `$system.applied_migrations` ledger may be
copied into a host seed, but it does not prove the host's local instance data was
converted.

### R9.2 Boot identity

Boot runs as `$wiz` (the seed wizard). All `:add_feature`, `:setProp`, etc. invoked during boot satisfy the wizard-bypass rules (per features.md §FT5, identity.md §I7).

### R9.3 Idempotent reboot

Per [bootstrap.md §B9](../semantics/bootstrap.md#b9-idempotent-rebooting), every step skips a seed whose corename is already mapped in Directory. Re-running boot after a partial failure (e.g., a DO crashed mid-create) finishes the unfinished work without disturbing existing seeds.

---

## R10. Instrumentation

The runtime is world-visible from day one — even a "first cut" deployment must be measurable. Three primitives:

### R10.1 Workers Analytics Engine

Standard binding `METRICS`. Every load-bearing call site writes one data point. Each DO writes its own; AE handles aggregation.

```ts
env.METRICS.writeDataPoint({
  blobs: [event_type, fields...],   // string-tagged dimensions, low cardinality
  doubles: [latency_ms, count],      // numeric measurements
  indexes: [do_id]                   // up to 1 high-cardinality index
});
```

Required event types (cardinality budget per DO):

| Event | Blobs | Doubles | Indexes |
|---|---|---|---|
| `call` | verb_name, target_class, error_code? | latency_ms | actor_id |
| `cross_do_rpc` | method, error_code? | latency_ms, retry_count | callee_id |
| `alarm` | — | due_count, skew_ms | do_id |
| `session` | event_kind ('bind'\|'detach'\|'reap'), token_class | — | actor_id |
| `wizard_action` | action ('force_direct'\|'force_recycle'\|'impersonate') | — | actor_id |
| `error` | code, surface ('rest'\|'wire'\|'rpc') | — | request_id |

Cost: one AE write per call is fine at v1 traffic levels; budget revisits at scale.

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
- `X-Woo-Impersonate-Actor` header
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
GET  /api/objects/<id>                  → DO RPC (describe)
GET  /api/objects/<id>/properties/<n>   → DO RPC (getProp)
POST /api/objects/<id>/calls/<verb>     → DO RPC (call or directCall)
GET  /api/objects/<id>/log              → DO RPC (readLog)
GET  /api/objects/<id>/stream           → DO RPC + SSE upgrade
POST /api/auth                          → Sessions handler (mints/resumes session)
GET  /ws                                → WS upgrade → gateway/player host
```

### R11.2 ID resolution

The Worker resolves `<id-or-name>` to a DO id:

- `#<ulid>` → Directory route lookup. If Directory has no row for the id (uncreated, or pre-§R1.1 storage from before Directory rows existed) the Worker returns `404 E_OBJNF`; there is no `idFromName(ulid)` fallback because that would route co-resident ids to nonexistent dedicated DOs.
- `$<corename>` → fetch from Directory DO, then `env.WOO.idFromName(host_key)`.
- `$me` → resolve from `Authorization: Session <id>` → session.actor → `idFromName(actor)`.
- `~<tref>` → not on this hop; transient refs route to the carrying player's DO.

Unresolvable identifiers → `404 E_OBJNF`.

### R11.3 Auth at the edge

The Worker validates `Authorization: Session <id>` against the Sessions surface (a singleton SessionsDO or per-player session table — see R11.4). Successful resolution yields `{actor, expires_at}`. The actor + correlation_id flow into the DO RPC envelope.

Token classes (`guest:`, `session:` v1-core; `bearer:`/`apikey:` v1-ops) are validated here. Rejected tokens return `400 E_INVARG` or `401 E_NOSESSION` without ever touching DOs.

### R11.4 Sessions placement

Two reasonable shapes; pick at impl time, not at spec time:

**Option A: per-player sessions.** Sessions live in the player's own DO (in the existing `session` table per [persistence.md §14.1](persistence.md#141-per-mooobject-schema)). The Worker indexes session_id → player via either (a) a Sessions singleton DO holding only the index, or (b) embedding the player ULID in the session id itself (e.g., session_id = `<player_ulid>:<random>`).

**Option B: SessionsDO singleton** holds all sessions. Simpler indexing, hot DO.

Lean: **Option A with embedded player ULID**. Avoids a singleton bottleneck and matches identity.md's "session is per-actor."

---

## R12. wrangler config

Skeleton `wrangler.toml`:

```toml
name = "woo"
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
dataset = "woo_v1"

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
- Continuous UI gestures should use direct live observations for previews and coalesce durable writes at the application edge. Generic sequenced calls are never debounced by the host: once a call returns an applied frame, its log outcome and dirty state are durable.
- Real deployment cost numbers are tracked in operator notes as traffic grows.

---

## R14. Deploying your own world

The reference deployment is intended to be **fork-and-deploy**. Anyone who picks up this repo can run their own world in their own Cloudflare account. The single biggest design constraint that follows: nothing in the runtime may assume a particular operator, account, or pre-existing identity. The seed graph is universal; everything operator-specific is configuration.

### R14.1 Prerequisites

An operator deploying their own world needs:

1. A Cloudflare account on the **Workers Paid** plan ($5/month minimum). Durable Objects require Workers Paid; Workers Free deploys will fail at first request with an explicit DO-binding error.
2. `wrangler` installed locally and authenticated (`wrangler login`).
3. A clone of this repository.

That is the entire required surface. Optional bindings (Workers Analytics Engine for metrics, R2 + Logpush for log retention, custom domain) are documented as additions, not prerequisites — a fresh deploy with no AE binding still runs, just without metric writes.

### R14.2 Required configuration

Two secrets must be set before first deploy. They are single-string values and go through `wrangler secret put` (never the `[vars]` block in `wrangler.toml`).

| Secret | Purpose |
|---|---|
| `WOO_INITIAL_WIZARD_TOKEN` | One-time token presented at first auth to claim the `$wiz` binding. Consumed on use; subsequent auths cannot present the same value. See §R14.4. |
| `WOO_INTERNAL_SECRET` | HMAC key for gateway/Directory/cluster-host internal requests. Unsigned or tampered internal requests are rejected before forwarded session, actor, or `progr` fields are trusted. |

The Worker checks these at startup. A missing required secret is a `503` with a clear remediation message — see §R14.7.

For local development, the value lives in `.dev.vars` (gitignored) with a sane default. A `.dev.vars.example` file in the repo root shows the shape; operators copy it to `.dev.vars` and edit.

### R14.3 Optional bindings

Each of the following is **optional**: the Worker checks for the binding at startup and degrades gracefully if absent.

| Binding | Type | Behavior when present | Behavior when absent |
|---|---|---|---|
| `METRICS` | Analytics Engine dataset | Per-call AE writes per [§R10.1](#r101-workers-analytics-engine). | All AE writes no-op. Structured logs still emitted. |
| `LOGPUSH_BUCKET` | R2 bucket for Logpush | Operator configures Logpush separately to push structured logs there. | Logs reach `wrangler tail` only; no durable retention. |
| `CUSTOM_DOMAIN` | Worker route | World served at the operator's domain. | World served at `<worker-name>.<account-subdomain>.workers.dev`. |

Operators may add bindings in `wrangler.toml` after deploy without redeploying the runtime — the runtime detects new bindings on next isolate cold-start.

### R14.4 Operator identity bootstrap

The first auth into a freshly-deployed world establishes the operator as `$wiz`. The flow:

1. Operator deploys with `WOO_INITIAL_WIZARD_TOKEN = <random-string>` set.
2. Operator connects (websocket or REST) presenting `auth { token: "wizard:<random-string>" }`.
3. Worker validates the token against the secret. If match: bind the connecting actor to the seeded `$wiz` objref, mint a session, mark the token consumed in `$system` metadata (`bootstrap_token_used = true`), and register the session route in Directory.
4. Subsequent presentations of the same token return `401 E_TOKEN_CONSUMED`.

After this exchange, the operator has wizard authority and can mint additional players, install verbs, and configure the world. The wizard token is single-use; rotating it requires a wizard verb (`wiz:rotate_bootstrap_token(new_token)`) so the operator can recover from a token compromise without redeploying.

**Forbidden alternatives** (don't ship these):

- "First connection wins" — race-prone; an attacker connecting between deploy and operator's first auth gets wizard.
- "Always-open admin endpoint gated by IP" — fragile; CF's IP visibility varies.
- "Hardcoded admin credentials" — defeats fork-and-deploy.

The token-secret model is the only acceptable v1 path.

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
- Snapshot policy automation (snapshots are still optional in v1-core).
- Distributed tracing.
- Multi-region tuning.
- Dashboard UI for `:metrics()` rollup.

Reserved for v2:
- Cross-operator federation (separate spec at `deferred/federation.md`).
- Advanced quota real-time approximation (per [quotas.md §R5.4](quotas.md#r54-real-time-approximation-todo)).
