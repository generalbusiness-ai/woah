---
date: 2026-05-01
status: implemented
---

# Failures

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**.

The consolidated failure model. Most of these rules appear in their primary contexts — host invariants, space lifecycle, task scheduling, persistence atomicity, wire protocol. This document aggregates them, fills the gaps between, and is the single page operators and implementers consult when something goes wrong.

---

## F1. Vocabulary

Distinguish:

- **Reject.** The runtime declined to act. No state change. Caller sees an err. Normal flow control.
- **Abort.** The runtime started acting and stopped. Some state changes may have been rolled back; the abort itself is observable.
- **Crash.** An unexpected condition; the runtime cannot recover within the operation. Recovery may require operator intervention or restart.
- **Timeout.** An operation waited too long for a response. The runtime gave up and returned to the caller.
- **Loss.** A side-effect was attempted but cannot be confirmed delivered. Best-effort semantics; caller may observe staleness.

These are not all "errors" in the colloquial sense. Reject is normal; crash is operational.

---

## F2. Failure modes — master table

Each row cites its primary doc. This document only adds context not already covered there.

| Mode | Trigger | Caller observes | Runtime does | Other observers | Recovery | Primary spec |
|---|---|---|---|---|---|---|
| Validation failure | malformed message, types wrong | `op:"error"` w/ `E_INVARG` | no `seq`, no log | nothing | client retries valid call | [space.md §S2.1, S3.1](space.md#s2-the-call-lifecycle) |
| Authorization failure | actor not allowed through space | `op:"error"` w/ `E_PERM` | no `seq`, no log | nothing | depends on policy | [space.md §S2.2, S3.1](space.md#s2-the-call-lifecycle) |
| Behavior failure | verb body raises | `op:"applied"` with `$error` observation | seq advanced, mutations rolled back | applied frame with error | re-author verb; replay-safe | [space.md §S3.2](space.md#s3-failure-rules-normative) |
| Tick exhaustion | task exceeds tick budget | `$error` `E_TICKS` in applied | as behavior failure | applied with error | refactor verb; monotone budget | [vm.md §8.4](vm.md#84-tick-metering) |
| Memory exhaustion | task exceeds memory cap | `$error` `E_MEM` in applied | as behavior failure | applied with error | refactor verb; monotone budget | [vm.md §8.5](vm.md#85-memory-metering) |
| Wall-time exceeded | task exceeds wall budget | `$error` `E_TIMEOUT` in applied | as behavior failure | applied with error | refactor verb; monotone clock | [vm.md §8.7](vm.md#87-wall-time-budget) |
| Cross-host RPC timeout | receiver doesn't reply within deadline | `E_TIMEOUT` | originating task aborts; no cleanup of receiver | possible torn target state | retry with same id; gap recovery | [hosts.md §3.4 (6)](../protocol/hosts.md#34-host-rpc-invariants) |
| Host wait-for cycle | awaited host RPC would re-enter a host already in the request chain | `E_HOST_CYCLE` | RPC rejected before adding the wait edge | no new remote side effects | return deltas, schedule a later message, or refactor to local dispatch | [hosts.md §3.5](../protocol/hosts.md#35-host-wait-for-graph-and-reentrancy) |
| Receiver crash mid-call | host crashes during behavior | `E_TIMEOUT` to originator | receiver tasks not in `task` table are lost; in-table tasks survive | possibly partial mutations on target | tooling-driven cleanup | [hosts.md §3.4 (5)](../protocol/hosts.md#34-host-rpc-invariants) |
| Originator crash/hibernation mid-RPC | host disappears while awaiting reply | n/a | uncheckpointed running task is lost; no applied frame returned | local pre-commit state restored by restart | caller retry | [tasks.md §16.3](tasks.md#163-cross-host-rpc) |
| Network partition | originator can't reach receiver | `E_TIMEOUT` | originator times out; receiver may still apply | receiver may complete | retry; gap recovery covers any duplicate | [hosts.md §3.4 (6)](../protocol/hosts.md#34-host-rpc-invariants) |
| Duplicate RPC retry | client retries with same `id` | identical `applied` frame | correlation-id cache hit; no new seq | nothing | automatic | [v2-turn-network.md §VTN4](../protocol/v2-turn-network.md#vtn4-message-envelope) |
| Bytecode version skew | task resumes against incompatible bytecode | `E_VERSION` in applied | task aborts cleanly; never silently runs old code | applied with error | re-issue against current code | [hosts.md §3.4 (4)](../protocol/hosts.md#34-host-rpc-invariants) |
| Storage write failure (call commit) | persistent storage rejects before the final call commit completes | `op:"error"` w/ `E_STORAGE` | call rejected; **no durable seq advance**; nothing committed to log | nothing | client retry; investigate operator-side | (this doc, §F6) |
| Storage write failure (during behavior) | storage fails during verb body | `op:"applied"` w/ `$error E_STORAGE` | mutations rolled back; seq stays in log | applied with error | behavior-failure semantics; investigate operator-side | (this doc, §F6) |
| Quota exceeded | per-task / per-owner / per-space cap hit | `E_QUOTA` in applied | call rejected before behavior runs | nothing | wait, request more quota | [permissions.md §11.7](permissions.md#117-storage-quotas-and-accounting), [tasks.md §16.7](tasks.md#167-fork-and-suspend-caps) |
| Inbound rate limit | client over `connection_*` budget | `op:"error"` w/ `E_RATE` | excess frames dropped at the transport | nothing | client backoff | [v2-turn-network.md §VTN19.3](../protocol/v2-turn-network.md#vtn193-ping-idle-and-backpressure) |
| Outbound overflow | client can't keep up with applied stream | transport gap/error | accepted-frame queue overflow | nothing | client reconnects and uses `space:replay` / VTN9 catch-up | [v2-turn-network.md §VTN19.3](../protocol/v2-turn-network.md#vtn193-ping-idle-and-backpressure) |
| Recycled object reference | call to a now-recycled object | `E_OBJNF` | rejected at routing | nothing | use a different ref; remove stale ref from caller | (this doc, §F7) |
| Cycle in `task:move` | parent ∈ descendants(task) | `E_RECMOVE` | rejected before mutation | nothing | check first; rebuild path | [tasks DESIGN.md](../../catalogs/tasks/DESIGN.md) |
| Federation disabled (v1) | non-local origin in single-world build | `E_FED_DISABLED` | rejected at parse/dispatch | nothing | use local refs | [federation.md §24.11](../deferred/federation.md#2411-v1-reservations) |
| Browser disconnect mid-call | client websocket drops while host_call in flight | n/a (server recovers) | `host_call` returns `E_GONE` to originating host | server treats as gone | session reconnect; gap recovery | [browser-host.md §18.5](../protocol/browser-host.md#185-disconnect) |
| Schema version mismatch (boot) | world's recorded spec version newer than runtime | runtime refuses to boot | log + halt | nothing | upgrade runtime | [migrations.md §M6](../operations/migrations.md) |
| Migration mid-flight failure | batch fails during data migration | error logged, migration paused | partial migration recorded | applied for completed batches; not for incomplete | resume migration; idempotent transform replays safely | [migrations.md §M5](../operations/migrations.md) |

---

## F3. Validation, authorization, and behavior failure

The space-level failure rules in [space.md §S3](space.md#s3-failure-rules-normative) are normative. Summary:

1. **Pre-sequence failures (validate, authorize)** do not advance `seq`. From other observers' view, the call did not happen.
2. **Post-sequence failures (behavior raises, ticks/memory/wall-time exhausted)** do advance `seq`. The message stays in the log; mutations and observations from the failed body are rolled back; an `applied` frame carries a single `$error` observation.
3. **Cross-cluster mutations from inside a verb body are not in the rollback scope.** Authors of call-handler verbs avoid them; if used, they must be idempotent, and partial failures may leave torn state across hosts.

These rules together preserve replay determinism: the log is faithful, the rolled-back state is recoverable, and observers see one coherent story.

---

## F4. Cross-host failures and the migration invariants

The invariants in [hosts.md §3.4](../protocol/hosts.md#34-host-rpc-invariants) and [hosts.md §3.5](../protocol/hosts.md#35-host-wait-for-graph-and-reentrancy) cover the cross-host failure surface:

1. One-task-one-host.
2. Idempotency via correlation id.
3. Originator authoritative for transient-host returns.
4. Bytecode versioning on serialized tasks.
5. Mid-task host crash leaves only `task`-table-resident state.
6. No synchronous host cycles; `host_chain` prevents `A -> B -> A` and `A -> A` waits.

The failure-mode table above maps these to concrete observables. Two follow-up notes:

**Receiver-side state torn by mid-call crash.** When a host crashes mid-verb-body, mutations within the host's atomic boundary that *did* commit before the crash are durable; mutations that hadn't committed are lost. The originator sees `E_TIMEOUT`; the target host's next access reveals whatever did or didn't commit. This is the "torn state" that authors of cross-cluster handlers must bound — typically by structuring mutations so partial completion is forward-progress (mark step N done before starting step N+1) rather than partial corruption.

**Duplicate-reply suppression.** A duplicate reply with a known `correlation_id` is dropped silently. There is no notification to the originator that a duplicate was suppressed; from the originator's view, the original reply is what arrived.

---

## F5. Resource failures

Tick, memory, and wall-time exhaustion ([vm.md §8.4–§8.7](vm.md#8-bytecode-and-vm)) are post-sequence behavior failures: the message is in the log, mutations roll back, an `$error` observation surfaces. Because the budgets are monotone within a task, catching one and continuing doesn't get a fresh budget.

Quota failures (per-owner storage, per-task creation, per-object/per-owner parked tasks, per-task fork count) are *pre-action* rejections: the budget check fires before the would-be-allocation, so no partial state results. `E_QUOTA` carries enough context (which quota, current vs limit) for the caller to surface a useful message.

Tick weights for cross-host operations (`GET_PROP` remote 100, `CALL_VERB` remote 500) are how the tick budget catches RPC-amplification — a verb that fans 1000 prop reads across remote objects spends 100k ticks before the bodies even run, and tip-stops itself.

---

## F6. Storage and persistence failures

The persistence layer (`spec/reference/persistence.md`) gives per-write atomicity. A sequenced call runs on an async behavior path with an in-memory behavior savepoint, then commits the final local state and log outcome in one host transaction ([cloudflare.md §R3.4](../reference/cloudflare.md#r34-transactions-and-rollback-scope)). A verb body is *not* atomic across yield points; cross-DO ops give other tasks the chance to interleave. Storage-level failures fall into two categories with **distinct, definite semantics**:

**Call-commit storage failure.** If persistent storage fails before the final call commit completes — including durable seq allocation, log insert, outcome update, dirty object writes, or final commit — the call is rejected: `op:"error"` with code `E_STORAGE`. **No durable `seq` is visible.** Nothing is committed to the log. From all replay readers and subscribers, the call did not happen.

**Behavior storage rejection.** If user-visible behavior reaches a storage-backed primitive that raises a recoverable `E_STORAGE` before the final commit, the failure is treated as a behavior failure: `op:"applied"` with a `$error E_STORAGE` observation, behavior mutations rolled back to the savepoint, and the message committed at its assigned `seq` with `applied_ok = false`. Same shape as any other behavior failure.

The cases are deliberately disjoint. The runtime never reaches a state where "seq durably advanced but the message is not durably in the log" — that combination is impossible by construction. If the final commit succeeds, the seq, message, outcome, and local state are durable together; if it aborts, the seq was never visible.

Other storage incidents:

- **Storage corruption (read returns inconsistent data).** Detection is best-effort. The host crashes loudly rather than returning corrupt values to user code. Recovery is operator-driven (restore from backup, run integrity checks); the spec does not define automatic repair.
- **Crash mid-opcode.** SQLite gives all-or-nothing per storage opcode; a crash leaves either the pre or post state, not a partial. Cross-opcode rollback within a verb body is provided by the runtime behavior savepoint until the final commit.

`E_STORAGE` is reserved for spec-internal storage rejections; `E_QUOTA` is the user-facing "you ran out of allowed space" signal. User code should not commonly see `E_STORAGE`; if it does, it's an operational signal.

---

## F7. Lifecycle failures

**Recycled object refs.** A ref to a recycled object resolves to nothing. Calls raise `E_OBJNF`; reads of property values where the object is the value raise `E_OBJNF` only if the caller dereferences. Storing a ref to a recycled object is allowed (the value stays in the property); the staleness is observable only at use. Best practice: callers that hold long-lived refs check `is_recycled(obj)` before relying on them.

**Recycle of an object with anchored descendants.** Disallowed at runtime. `recycle(obj)` raises `E_NACC` if any object's `anchor` is `obj` (transitively). The wizard recycles bottom-up.

**Recycle of an object holding parked tasks.** The parked tasks are killed (E_INTRPT delivered to handlers if any). Recycle proceeds.

**Host teardown after recycle.** When a recycle drains a DO's hosted-payload count to zero ([recycle.md §RC11](recycle.md#rc11-host-teardown-after-recycle)), the DO enters a `tearing_down` state and then calls `state.storage.deleteAll()`. Requests that race the teardown raise `E_HOST_RECYCLED`. Cold-loaded DOs whose id appears in Directory's `inherited_tombstone` table also raise `E_HOST_RECYCLED`. Callers that do not distinguish between "gone-just-now" and "long-since-recycled" treat `E_HOST_RECYCLED` as equivalent to `E_OBJNF`. `is_recycled(<id>)` returns true for any ULID covered by an inherited tombstone.

**Browser-host disconnect mid-call.** [browser-host.md §18.5](../protocol/browser-host.md#185-disconnect) covers this: in-flight `host_call`s return `E_GONE`; tasks awaiting reads on the player remain for the grace period; sessions persist for the broader timeout.

---

## F8. Versioning failures

Bytecode version mismatches (§F4 invariant 4) abort the affected task with `E_VERSION`. The runtime never silently runs an old task against a new bytecode or vice versa.

Schema version mismatches at world boot ([migrations.md §M6](../operations/migrations.md)) refuse to boot — the runtime declines to load a world whose recorded spec version is newer than the runtime understands. Older worlds may be migrated forward by applying recorded migrations from the catalog.

For schema changes that happen during a world's lifetime (a property def's type narrows, a verb's signature changes), the worktree+migrations flow is the path: develop the change in a worktree, run the migration, promote. See [worktrees.md](../operations/worktrees.md) and [migrations.md](../operations/migrations.md).

---

## F9. Connection and protocol failures

The wire layer surfaces these directly:
- `E_RATE` — inbound exceeded the per-connection rate limit.
- `E_OVERFLOW` — outbound queue overflowed; client should use replay.
- `E_NOSESSION` — client presented a `session:<id>` token that's no longer valid; treat as a fresh login.
- Authentication-token rejections — surface via `op:"error"` with the underlying err code (`E_PERM` or `E_INVARG`).

Reconnect: the client uses VTN9 catch-up and, for REST/SSE surfaces, `space:replay(from, limit)` for gap recovery rather than relying on the removed v1 sync/history protocol frame ([v2-turn-network.md §VTN9](../protocol/v2-turn-network.md#vtn9-catch-up-and-applied-frames)).

---

## F10. What's not a failure

For clarity:

- **Receiver gracefully declined.** A verb that returns an err map (without `raise()`) has not failed; the call applied successfully and the err is just the return value.
- **Subscriber dropped an event.** Receiver-side coalescing of live observations from direct calls (events.md §12.6) is not a failure; it's the contract.
- **Dead-letter delivery.** A persistent emit to an unreachable target ends up on the emitter's audit object; not a failure, an audit affordance.
- **Wizard-bypass action recorded.** A wizard using their flag to bypass a check is not a failure; if a wizard audit log exists, it records the bypass for review.

These non-failures still produce observable signals; treating them as failures would surface noise to users who don't need it.

---

## F11. What's deferred

- **A failure-injection test harness** that exercises every row in §F2 against the live runtime. Belongs to the conformance suite work in [tooling/conformance.md](../tooling/conformance.md), still TBD.
- **Operator runbooks** keyed off specific failure modes. Belongs to [operations/observability.md](../operations/observability.md), still TBD.
- **Automatic rollback after run-of-failures.** A circuit-breaker pattern that disables a misbehaving verb after N consecutive failures. Useful but deferred; the deterministic-replay model already prevents catastrophic divergence.
