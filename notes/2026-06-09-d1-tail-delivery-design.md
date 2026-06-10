# D1 tail-driven delivery — design + implementation brief (wave 3)

Origin: 2026-06-09. Plan item D1 of
[2026-06-09-cf-cross-scope-architecture-plan.md](2026-06-09-cf-cross-scope-architecture-plan.md).
Normative contract: VTN9.1 (`spec/protocol/v2-turn-network.md`), added on
this branch. This note is the wave-3 implementation brief.

## Why

`deliverV2Fanout` is awaited on the caller's reply path
(`src/worker/persistent-object-do.ts` ~1755, inside the gateway `envelope`
hook): mean 533 ms / p95 2.3 s of every deployed turn is spent delivering
observations to OTHER shards before the actor hears their own result. It
also couples actor latency to audience size, which CA13 forbids at scale.
Naively deferring with `waitUntil` would open a crash window (reply sent,
fanout lost on eviction); the durable relay tail (persist-before-ack,
`v2_relay_tail`, e7b3daa) already holds everything needed to make delivery
resumable, so the tail becomes the outbox.

## Where the seams are

- `src/worker/persistent-object-do.ts` ~1750-1775: gateway `envelope` hook —
  the `await deliverV2Fanout(...)` to move off the reply path. NOTE: the
  envelope result currently folds delivery outputs into the reply
  (`local_host_materialized`, `accepted_audience`) — identify which of these
  the CALLER actually needs synchronously (the actor's own materialization
  does need to precede the reply; peer shard delivery does not) and split
  `deliverV2Fanout` accordingly: local/self effects stay synchronous,
  remote fanout moves to the drain.
- `src/worker/commit-scope-do.ts` `acceptAndFanoutBrowserTranscript` and the
  `/v2/envelope` handler (~495-530): the CommitScopeDO side fanout; the C1a
  `kill_after_commit` hook sits exactly at the boundary this change makes
  safe (post-durable-save, pre-fanout).
- `src/core/shadow-relay-tail.ts` + the `v2_relay_tail` SQLite table: the
  durable tail. Add a per-destination cursor table
  (`v2_fanout_cursor(destination, seq)`); the drain walks
  tail rows > cursor per destination, sends, advances.
- Receiver idempotency already exists: `durableProjectionHeadSeq` sequencing
  fallback and idempotent projection application (CA4). Verify with a test
  rather than assuming (redeliver a frame twice; assert no duplicate rows).

## Implementation order (flag `WOO_V2_TAIL_DELIVERY`)

1. Split `deliverV2Fanout`: synchronous local/self effects vs remote fanout
   list construction. No behavior change; reply fields preserved.
2. Cursor table + drain function on the scope host (gateway shard and
   CommitScopeDO have the relevant tails — confirm which component owns
   which destination class today by reading `deliverV2Fanout`).
3. Flag on: reply returns after durable save + local effects; drain runs via
   post-reply continuation; on activation (constructor/first fetch), if any
   cursor < tail head, schedule a drain (this is the crash-recovery path).
4. Bounded backoff + `fanout_redelivery` metric; far-behind destinations
   repaired via existing catch-up/state-transfer instead of replay.
5. Tail pruning interaction: tail rows must not be pruned past the minimum
   cursor (extend the retention rule; the B-iv tail budget work must read
   the cursor floor).

## Gates (all pre-deploy)

- **Crash-window conformance (the headline)**: C1a `kill_after_commit`
  (nth=1) in the workerd lane → caller success; peer shows no delivery;
  next activation of the scope (any request) triggers drain; peer
  converges. Deterministic test, curated or worker lane.
- Redelivery idempotency: drain the same row twice → no duplicate effects.
- Lane behavior: cf-local structural gate — `post_accept_delivery` no
  longer appears in the submit critical-path subphases on warm turns
  (extend the C2 structural assertions); scenario peer-visibility steps
  still pass in cf-local + cf-dev twice.
- Ordering: per-destination order preserved under a 3-frame burst test.
- Metrics: deployed measurement after rollout must show turn submit p95
  drop ≈ the delivery share and peer latency < 1 s (plan Track D targets).

## Non-goals

- No change to WHAT is delivered (A2a owns payload completeness).
- No change to receiver application semantics.
- Browser WS push path stays as-is; this is the cross-shard fanout seam.

## Review checklist

- [ ] Reply fields the caller needs synchronously are preserved (diff the
      envelope reply shape before/after under flag).
- [ ] Cursor floor respected by tail pruning (test).
- [ ] kill_after_commit conformance test green in workerd lane.
- [ ] No new sync cross-DO RPC inside the turn (B-ii rule).
- [ ] VTN9.1 status flipped to "implemented (flag-gated)".
