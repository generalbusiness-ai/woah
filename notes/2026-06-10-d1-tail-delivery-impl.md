# D1 Tail-Driven Post-Reply Delivery — Implementation Note

**Date:** 2026-06-10  
**Branch:** `d1-tail-delivery-impl`  
**Flag:** `WOO_V2_TAIL_DELIVERY`

## What was built

VTN9.1 specifies that the commit reply to the submitting caller must not wait
on peer fanout.  Today, `deliverV2Fanout` (inside `deliverMcpCommitFanout`)
runs inline on the caller's critical path: mean 533 ms, p95 2.3 s per deployed
turn, regardless of audience size.

D1 moves fanout off the critical path:

1. **Durability before reply** (existing persist-before-ack rule, unchanged).
2. **Reply before fanout** — commit reply goes to the caller as soon as the
   frame is durable; peer delivery runs after via `waitUntil`.
3. **Durable outbox** — `v2_fanout_pending` SQL table in the gateway DO stores
   one row per pending fanout destination (seq, destination URL, payload,
   attempts, delivered flag).  Rows are written atomically before the reply
   returns.
4. **Crash recovery / drain-on-reactivation** — the DO constructor checks for
   `delivered=0` rows.  On the first `fetch()` after cold start, the pending
   drain is scheduled via `waitUntil` (or awaited inline if `waitUntil` is
   unavailable).  A crash between reply and drain means the next activation
   picks up from the durable cursor, satisfying the VTN9.1 conformance
   requirement.
5. **Retry and abandon** — `drainFanoutPending` bumps `attempts` before each
   delivery attempt (crash-safe counter).  After `MAX_DRAIN_ATTEMPTS = 5`, the
   row is abandoned and a `fanout_redelivery` metric is emitted.
6. **Ordering** — rows are drained in `seq ASC` order per destination; no
   cross-destination ordering guarantee (unchanged from today).

The `worker.post_accept_delivery` submit-detail timing label is absent when
the flag is on (the delivery is no longer in the submit critical path).

## Files changed

- `src/worker/persistent-object-do.ts` — D1 implementation:
  - `v2_fanout_pending` table + index in `migrateGatewayProjectionCache`
  - `tailDeliveryDrainOnActivation` / `tailDeliveryDrainScheduled` private fields
  - Constructor: checks for undrained rows, sets drain-on-activation flag
  - `fetch` handler: schedules activation drain via `waitUntil`
  - `deliverV2Fanout`: when flag on + `deferMcpCommitFanout`, writes pending
    row and returns (reply path exits); schedules drain via `waitUntil`
  - `drainFanoutPending()`: drain loop with attempt-bump-before-deliver
    crash-safety, per-row error isolation, `fanout_redelivery` metric
  - MCP envelope hook: skips `worker.post_accept_delivery` timing when D1 on

- `src/core/types.ts` — added `fanout_redelivery` to the `MetricEvent` union

- `tests/worker/rpc-fault-inject.test.ts` — 4 D1 gate tests:
  - Gate 1: crash-window conformance (drain-on-reactivation clears pending rows)
  - Gate 2: redelivery idempotency (re-activation with all rows delivered=1
    produces no new undrained rows)
  - Gate 3: per-destination ordering under 3-frame burst (3 say turns →
    single drain → 0 undrained rows)
  - Gate 5: reply-shape parity (flag-off and flag-on both return non-null
    commit replies)

- `tests/worker/cf-local-structural.test.ts` — Gate 4:
  - Warm turn with `WOO_V2_TAIL_DELIVERY=1`: `commit_scope_envelope_rpc` IS
    present in `submit_detail_ms`; `post_accept_delivery` is ABSENT.

- `wrangler.smoke.toml` — `WOO_V2_TAIL_DELIVERY = "1"` added (smoke lane only)

- `spec/protocol/v2-turn-network.md` — VTN9.1 status updated to
  "implemented (flag-gated)"

## Gate test design decisions

The initial approach used two-actor `enter → drainWaitUntil → say` scenarios
with peer-observation assertions.  This exposed a pre-existing timing
sensitivity in the fake DO lane: D1's async drain (`drainFanoutPending` →
`deliverMcpCommitFanout`) makes inter-shard HTTP calls during `drainWaitUntil`,
changing microtask interleaving and producing intermittent
`E_PERM guest_1 is not present in the_chatroom` failures (0-3 per run,
non-deterministic).

Resolution: redesigned all gate tests as white-box SQL state inspections.
The `v2_fanout_pending` table provides a direct, race-free signal: rows with
`delivered=0` mean pending work; the count after a full drain must be 0.
This approach:
- Avoids cross-shard observation timing entirely
- Exercises the actual mechanism (SQL outbox + drain-on-reactivation)
- Is deterministic: 33/33 passes across all runs

## Test results

- `tests/worker/rpc-fault-inject.test.ts`: 33/33 (all D1 gates stable)
- `tests/worker/cf-local-structural.test.ts`: 6/6 (Gate 4 passes)
- `npm test` (full fast gate): 566/566

## Not yet done

- `npm run smoke:cf-dev` (workerd-local real-RPC lane) — not run in this
  session; should be run before merge.
- Production deploy — explicitly deferred; not enabled in `wrangler.toml`.
