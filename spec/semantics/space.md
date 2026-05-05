---
date: 2026-04-30
status: implemented
---

# Spaces

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**.

`$space` is woo's coordination workhorse: a `$sequenced_log` subclass that adds dispatch, session-scoped presence, and observation broadcast on top of the underlying append-only sequence primitive. This document is the normative behavior of `$space:call` and the related lifecycle. The lower-level append/read primitive lives in [sequenced-log.md](sequenced-log.md). The conceptual framing is in [core.md §C4–§C6](core.md).

The split: `$sequenced_log` provides atomically-allocated seqs and a durable message log; `$space` provides the dispatch loop, the audience model, and the applied-frame contract. Almost every coordination use case is a `$space`; alternative subclasses ([sequenced-log.md §SL6](sequenced-log.md#sl6-other-plausible-subclasses)) are possible without runtime changes.

---

## S1. The contract

`$space` is a `$sequenced_log` subclass whose role is to dispatch sequenced messages: assign each a seq via the host append primitive, run the target verb, and broadcast the resulting applied frame. Anything else a space does — audience routing, snapshots, scenes — is either a per-app extension built on top, or part of §S6/§S7 below.

A space has the inherited fields from `$sequenced_log` ([sequenced-log.md §SL1](sequenced-log.md#sl1-contract)) — `next_seq`, `last_snapshot_seq`, the durable log — plus:

| Field | Meaning |
|---|---|
| `session_subscribers` | list<map>; authoritative live-session audience entries, each `{session, actor}`. |
| `subscribers` | list<obj>; compatibility actor set derived from `session_subscribers`. Older catalog/UI code may read it, but new behavior should not write it directly. |

Spaces may carry additional materialized state — the dubspace's `delay_feedback`, a chat room's `topic`. That state is the result of applying messages.

---

## S2. The call lifecycle

`$space:call(message)` is the entry point. The runtime applies the following steps:

1. **Validate the message.** Required fields present (per [values.md §V10](values.md#v10-message-and-sequenced-message-serialization)); types match. If validation fails, raise `E_INVARG`. *No `seq` is assigned.*
2. **Authorize the actor.** Check that `message.actor` may call through this space. If denied, raise `E_PERM`. *No `seq` is assigned.*
3. **Reserve `seq`.** The host serializes calls for this `$sequenced_log` and reserves `seq = next_seq` in memory. No applied frame is visible yet. The durable log row and final `next_seq` write are committed after the behavior outcome is known — see [reference/cloudflare.md §R3.2](../reference/cloudflare.md#r32-sequenced-log-commit). If storage fails before commit, the call is rejected pre-sequence with `E_STORAGE` and no durable seq is visible — see [failures.md §F6](failures.md#f6-storage-and-persistence-failures).
4. **Resolve the target verb.** Use the standard verb lookup rule on `message.target` ([objects.md §9.1](objects.md#91-lookup): parent chain, then feature lookup where applicable). If not found, the call moves directly to step 8 (apply failure) with `E_VERBNF`.
5. **Run the behavior.** Execute the verb's bytecode (T0 or full VM) inside the runtime's behavior savepoint. The behavior may read/write properties on objects in the same anchor cluster (atomic), call other verbs (recursive within cluster), await permitted cross-host reads/calls, and emit observations.
6. **On success:** commit mutations from step 5; observations from step 5 are queued for delivery; the verb return value is retained as the caller-only `result` field on the live applied frame and on the immediate REST response.
7. **On parked continuation:** if the behavior executes `SUSPEND`, `READ`, or another operation that parks the VM stack, commit the parking record and any mutations before the parking point, then deliver the applied frame for this message. The later wake/input is a new sequenced message (normally a runtime `$resume` frame; see [tasks.md §16.2](tasks.md#162-suspend-across-host-eviction) and [§16.6](tasks.md#166-read-tasks)) with a fresh seq allocated at resume time.
8. **On failure (any raised err during step 5):** roll back mutations from step 5; the message remains in the log at its assigned `seq`; an `error` observation is queued describing the failure.
9. **Deliver `applied` frame.** Push `{op: "applied", id?, space, seq, message, observations, result?, audience_sessions?, observation_session_audiences?}` to the live sessions present in the space (per [protocol/wire.md §17.4](../protocol/wire.md#174-the-applied-push-model)). `result` is present only for the originating caller; replay, SSE, MCP broadcast queues, and other observers receive the durable public shape without `result`. Actor-level `subscribers` is a compatibility projection, not the authoritative fan-out key.

---

## S3. Failure rules (normative)

The six questions of failure semantics, answered:

1. **Validation failure (steps 1, 2).** `seq` does not advance. The caller receives `op: "error"` with the err. No log entry. No applied frame. From other observers' perspective, the call did not happen.
2. **Behavior failure (step 8).** `seq` was already assigned at step 3; the message stays in the log. Mutations from step 5 are rolled back atomically. Any observations emitted before the failure are also discarded — emit is part of the rolled-back set. The applied frame is delivered with a single error observation in `observations`.
3. **Partial mutations across the anchor cluster.** Rolled back atomically. Anchor placement ([objects.md §4.1](objects.md#41-anchor-and-atomicity-scope)) is what makes this possible — the cluster is one host, one transaction.
4. **Mutations outside the anchor cluster.** A call from inside step 5 to an object on a different host is a cross-host RPC; it is *not* in the rollback scope. Authors of call-handler verbs should avoid them. If they must, use idempotent operations and accept that partial failure may leave torn state across hosts.
5. **Replay determinism.** Behaviors must be deterministic given `(message, target_state, anchor_cluster_state)`. Reads of `now()`, `random()`, or non-anchored-object state break replay. Replaying the log must produce the same materialized state.
6. **Failure observation shape.** An err value (V7) emitted as an observation alongside the applied frame:

   ```
   { type: "$error", code: "E_VERBNF", message: "...", value: ... }
   ```

   The `$` prefix marks it as a runtime envelope; user code can handle `:on_$error` or filter by `type`.

---

## S4. Determinism and replay

Replay reconstructs materialized state by re-applying logged messages in seq order from the most recent snapshot (S7). For replay to converge:

- Call-handler verbs must be deterministic given `(message, target_state, anchor_cluster_state)`.
- No reads from non-anchored objects.
- No wall-clock or RNG inside the handler.
- No cross-host RPC inside the handler.

Verbs that need non-determinism (random colors, server timestamps) live *outside* call-handlers — they can be normal verbs called via direct dispatch, or they can capture the value at call time and pass it in `message.body`.

The runtime does not enforce determinism; violations show up as replay divergence. Tooling can help (replay-and-diff against current state) once the implementation exists.

---

## S5. The log

The log is inherited from `$sequenced_log`; semantics live in [sequenced-log.md §SL2](sequenced-log.md#sl2-the-native-host-operations). Storage shape is in [reference/persistence.md](../reference/persistence.md) (`space_message` table); semantically a list indexed by seq.

- **Reads:** `space:replay(from_seq, limit)` is the object-visible wrapper over the host log read operation. See [events.md §12.8](events.md#128-sequenced-calls-with-gap-recovery) for the paging pattern subscribers use.
- **Writes:** only step 3 of `$space:call` appends — and it does so via the host append primitive, not by direct mutation of `next_seq`.
- **Truncation:** older entries may be truncated when superseded by a snapshot (§S7). Truncation is a host-local optimization; semantically a truncated entry is "covered by snapshot S, which represents the materialized state at seq ≤ K."

---

## S6. History and audit

The log is the audit trail. Wizards can read it; ordinary actors can read entries they are authorized for, per the space's permission policy on `replay`.

The log records **messages** — the things that caused state changes. Observations emitted while applying a sequenced message are captured in that message's `applied` frame ([§S2](#s2-the-call-lifecycle) step 9) and are replay-visible as consequences of the message that produced them.

Observations from **direct calls** to verbs on this space (e.g., `the_room:say("hi")`, when `:say` is direct-callable) are *not* in the log. They flow live to the space's session audience and are gone after delivery, per [events.md §12.6](events.md#126-observation-durability-follows-invocation-route). Being a `$space` does not make every emit on the object durable; the route of the emitting verb does.

---

## S7. Snapshots

A space may take periodic snapshots: a captured materialized state plus the seq it represents. Snapshot mechanics are application-level — the runtime does not impose a policy — but the convention is:

```
verb $space:snapshot() rxd {
  let state = this:capture_materialized_state();
  // store (seq = this.next_seq - 1, state, hash) in space_snapshot
  // optionally truncate space_message rows with seq <= snapshot.seq
}
```

Reload follows: load the latest snapshot, then `replay(snapshot.seq + 1, limit)` paged until current. Subscribers far behind use the same path.

Snapshots are content-addressable via replay-canonical encoding ([values.md §V8](values.md#v8-replay-canonical-form)): two snapshots with the same materialized state hash to the same bytes regardless of insertion order.

### S7.1 Snapshot policy

Snapshots are optional for small or short-lived spaces: a sequencer can run without them when replay-from-1 is cheap.

Snapshots are required for deployments and features that need bounded replay, because:
- Worktree creation requires a snapshot for sandbox seeding ([worktrees.md §W4](../operations/worktrees.md#w4-sandboxes)).
- Replay debugging requires snapshot+forward-replay reconstruction ([debugging.md §D6](../tooling/debugging.md#d6-replay-debugging)).
- Backup export depends on snapshot+log composition ([backups.md §B2](../operations/backups.md#b2-world-export-format)).
- Conformance includes snapshot reconstruction tests ([conformance.md §CF3](../tooling/conformance.md#cf3-required-categories)).

**Triggering convention.** Short-lived spaces (e.g., the dubspace demo, where the log is bounded by control surface complexity) can skip snapshots entirely — replay from seq 1 is cheap. Long-lived spaces (e.g., the taskspace demo, where the log accumulates over weeks) need snapshots so late-joining clients and agents have a reasonable reload path. The recommended trigger is **every K calls or M minutes idle**, whichever comes first — defaults `K = 256`, `M = 10`. Concretely:

```
verb $space:on_applied(_event) {
  if (this.next_seq - this.last_snapshot_seq >= 256) {
    this:snapshot();
  }
}

// plus a forked timer that calls :snapshot() if idle
```

Both triggers are application code; the runtime does not impose either. The values are tunable per-space.

---

## S8. Anchor and atomicity

A space and the objects whose state it coordinates **should** share an anchor cluster ([objects.md §4.1](objects.md#41-anchor-and-atomicity-scope)). The dubspace example: `$mix`, `#delay`, `#channel`, `#scene` all anchor on `$mix`. Their state lives on one host; `$space:call` mutates them as one atomic transaction.

If a space's coordinated objects are *not* in its anchor cluster, mutations to them from inside step 5 are cross-host calls and lose the atomicity guarantee (S3.4). The spec does not prevent this configuration but documents it as an anti-pattern: a space's authority over its state requires they share fate.

---

## S9. Single-threaded by construction

A space's `call` verb runs serially — one call at a time through validate, sequence, apply-or-park, and deliver before the next call begins. This is the per-actor single-threaded model from [protocol/hosts.md §3](../protocol/hosts.md#3-hosts-and-execution-model) applied to spaces.

The host's input gate is held during a call; the runtime's "release on await" mode is *not* used for `$space:call`. Implementations must enforce this; without it, the seq order is meaningless.

Parking a continuation is not "awaiting inside the call." The current message has completed its sequenced apply by writing a durable parked-task record. When the continuation wakes, it re-enters the space as a new sequenced message (`$resume` or the target verb named by a space-targeted `FORK`). The original seq records that the task parked; the later seq records the effect of resuming.

---

## S10. Patterns built on $space

Built on `$space` without runtime extension:

- **Rooms** (`$room < $space`): coordinated participants, presence, speech.
- **Dubspaces** (`$dubspace < $space`): coordinated control surface for shared sound.
- **Documents** (`$document < $space`): coordinated text editing with sequenced operations.
- **Game sessions** (`$session < $space`): turn order is just seq order.

A space adds domain-specific behavior on top of the generic call lifecycle. The spec stops at the lifecycle; everything above is application code.
