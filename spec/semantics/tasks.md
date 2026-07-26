---
date: 2026-07-24
status: partial — §16.1/§16.3/§16.4 implemented; §16.2 points at scheduling
---

# Task lifecycle

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**.

Covers the task state machine, cross-host RPC continuations, and killing
tasks. Deferred execution — running something later — is
[scheduling.md](scheduling.md) for authors and
[protocol/coherence.md §CO16](../protocol/coherence.md#co16-scheduled-turns)
for mechanism.

> **History.** Until 2026-07-24 this document specified single-host parked
> tasks: `SUSPEND` serialized a VM stack into a `task` row, `FORK` spawned a
> delayed task on the forking object's host, `READ` parked one awaiting
> player input, and a host scheduler alarm resumed them. It was marked
> `status: implemented`; it was not. The VM opcodes, the durable rows, and
> the resume machinery all existed, but nothing ever called the resume
> path — the alarm handler that drove it belonged to the pre-Net stack and
> went away with it. Worse, under the coherence layer a `fork()` executes
> in the gateway's *planning* world and the effect transcript has no field
> to carry a parked task, so the row died at the transcript boundary in any
> case. Woocode could call `fork()`; nothing happened; no error was
> raised. No catalog had used it. The machinery was deleted on 2026-07-25
> and the capability is replaced by scheduled turns.

---

## 16. Task lifecycle

### 16.1 States

```
created → running → done
              ↓
     awaiting_rpc (cross-host call)
              ↓
           running (reply arrives)
```

A task is a serializable activation stack: the unit of execution. It is
created by an inbound call, runs to completion, and is done. The only
in-flight wait a task has is a cross-host verb call (§16.3), and that wait
is held in memory, not parked durably.

There is no `suspended` state and no `awaiting_read` state. A verb body
runs to completion within its turn or it fails; a turn is atomic (CO2.2).
Work that must happen later is a *separate, later turn* — see §16.2.

### 16.2 Deferred execution

To make something happen later, arm a scheduled turn:
[scheduling.md](scheduling.md). It fires as a fresh committed turn in the
same scope, with its own sequence number and its own transcript, which is
what keeps replay honest: no state changes between two sequenced frames
without a sequenced frame of its own.

This replaces the older `suspend`-in-place model, and it is a better fit
for the same reasons the coherence layer exists. A parked VM stack is a
durable object whose meaning depends on the code that produced it, so it
outlives verb edits badly; a scheduled turn names a verb and arguments and
resolves them when it fires. A parked stack also pins its host, which a
distributed world cannot promise across a year of wall-clock time.

`suspend()`'s other use — checkpointing a long mutation so a host crash
does not lose all of it ([protocol/hosts.md §3](../protocol/hosts.md)) — is
no longer a thing an author arranges. Turn atomicity means a committed turn
is durable when it is accepted; a long piece of work is a sequence of
committed turns, each individually durable.

> **Open, and load-bearing.** Scheduled turns rest on host alarms firing
> reliably across multi-day boundaries, and on scope state being fully
> reconstructible from durable storage alone after hibernation. Neither has
> been tested past the short horizons the smoke lanes cover, and the
> 365-day scheduling horizon (CO16.7) assumes both. The workerd lane cannot
> answer this; it is deploy-only.

### 16.3 Cross-host RPC

`CALL_VERB` to a remote object is an awaited host RPC:

1. Origin keeps the caller continuation in memory and sends
   `{target, name, args, ctx, correlation_id}` to the receiver host.
2. Receiver runs the callee frame under the caller's authority and returns
   `{correlation_id, result, observations}`.
3. Origin pushes the result onto its top frame's stack and appends the
   returned observations to the current frame.

A parked RPC task is not persisted. If the origin host crashes while
awaiting the reply, the in-memory task is lost like any other uncheckpointed
running task; the turn simply does not commit. Idempotency on retry is per
[protocol/hosts.md §3.4](../protocol/hosts.md#34-host-rpc-invariants) — a
duplicate request with the same correlation id returns the cached reply
rather than re-executing.

### 16.4 Killing tasks

`kill_task(task_id)` (a builtin, wizard or owner only) moves the task to a
terminal state and deletes its row. Any in-flight RPC reply is discarded on
receipt.

Cancelling *future* work is `cancel_schedule`
([scheduling.md §SC2](scheduling.md#sc2-signatures)), not `kill_task`:
a pending scheduled turn is not a task, it is a durable intention to start
one.
