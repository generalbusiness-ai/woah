# C1a: RPC-seam fault injection

Origin: 2026-06-09. Plan item C1a from
[2026-06-09-cf-cross-scope-architecture-plan.md](2026-06-09-cf-cross-scope-architecture-plan.md)
(Track C, required before the Track B deploy).

## What existed

The plan noted that fault-injection plumbing "partially exists" from the
stable-baseline review, specifically:

- `src/core/object-host-write-through.ts` has an `onRemoteForward` concept
  (doc comment mentions "fault-injectable transport") but no runtime fault hook.
- `tests/worker/cf-local-walkthrough.test.ts` has `mcpCommitFanoutDelayMs`
  and `directorySessionsForScopesDelayMs` options on `createCfSmokeHarness` —
  these are latency knobs but test-local, not env-driven, and limited to the
  walkthrough harness.
- Neither the `/__internal/authority-slice` nor the `/v2/envelope` seams had
  any injection point.

## What was added

### `src/worker/rpc-fault-inject.ts` (new)

A self-contained fault injection engine for the worker/test layer. Key API:

- `FaultInjector.fromEnv(envValue)` — parse `WOO_FAULT_INJECT`; returns a
  no-op injector when unset (fast-path for production).
- `fi.applyPreCall(route, signal?)` — apply latency/timeout/error faults
  before an RPC call. Uses the caller's AbortController signal so `mode=timeout`
  is bounded by the existing RPC deadline.
- `fi.applyKillAfterCommit()` — post-commit hook; throws `KillAfterCommitError`
  when configured, independently of the pre-call counter.
- `KillAfterCommitError` — sentinel exception type for D1's hook point.

Determinism controls: `p` (probability) and `nth` (1-based call counter).
Both are deterministic (no `Date.now()`-based randomness). Pre-call specs
(`latency`/`timeout`/`error`) and `kill_after_commit` use separate counters
so `nth` fires on the Nth call to the relevant hook, not the Nth call to any
hook.

Layering: `src/worker/` only. `src/core/` has no knowledge of route names,
fault modes, or env config. The module imports only `wooError` from core types.

### `src/worker/persistent-object-do.ts` (modified)

Three changes:

1. `WOO_FAULT_INJECT?: string` added to `Env` type.
2. Lazy `_faultInjector` field + `faultInjector()` accessor (parsed once per
   DO lifetime).
3. **authority-slice seam** — in `forwardInternalRaw`, after the AbortController
   is created: checks if path is `/__internal/authority-slice` or
   `/__internal/mcp-commit-fanout` and calls `fi.applyPreCall(faultRoute, controller.signal)`.
   The signal is passed so `mode=timeout` resolves (with `E_TIMEOUT`) when the
   existing RPC deadline fires, not after an unbounded hang.
4. **envelope seam (pre-call)** — in `v2CommitScopePost`, before the
   CommitScopeDO fetch: calls `fi.applyPreCall("envelope")` when path is
   `/v2/envelope`. No signal is passed here (the CommitScopeDO call does not
   have a gateway-side AbortController); `mode=timeout` would hang indefinitely
   and is not recommended for the fake-DO lane. Use `mode=error` for fast tests.

### `src/worker/commit-scope-do.ts` (modified)

Three changes:

1. `WOO_FAULT_INJECT?: string` added to `CommitScopeEnv`.
2. Lazy `_faultInjector` field + `faultInjector()` accessor.
3. **kill_after_commit seam** — in the `/v2/envelope` handler, after
   `saveFullIfNeeded`/`saveEnvelopeDelta` (durable persist), before
   `fanoutEnvelopes` and the response: calls `this.faultInjector().applyKillAfterCommit()`.
   Guards on `receipt.fresh` so idempotent replays do not re-fire the kill.
   When `KillAfterCommitError` is thrown, the catch block returns a
   `{"error":{"code":"E_KILL_AFTER_COMMIT",...}}` 500 response and emits
   a `v2_envelope error=E_KILL_AFTER_COMMIT` metric (distinct from generic
   errors so tests can assert durability vs delivery separately).

## Config format

`WOO_FAULT_INJECT` is a JSON array of `FaultSpec` objects:

```typescript
type FaultSpec = {
  route: "authority-slice" | "envelope" | "mcp-commit-fanout";
  mode: "latency" | "timeout" | "error" | "kill_after_commit";
  ms?: number;   // delay in ms; required for latency
  p?: number;    // probability [0,1]; default 1.0
  nth?: number;  // fire on Nth call only (1-based); default = all
};
```

Examples:
```json
[{"route":"authority-slice","mode":"timeout"}]
[{"route":"envelope","mode":"latency","ms":200,"p":0.5}]
[{"route":"envelope","mode":"kill_after_commit","nth":1}]
[{"route":"authority-slice","mode":"error","nth":1},{"route":"mcp-commit-fanout","mode":"latency","ms":50}]
```

## Where each seam hook lives

| Route | Hook location | File:function | Hook type |
|---|---|---|---|
| `authority-slice` | In `forwardInternalRaw`, after AbortController setup | `persistent-object-do.ts` ~6418 | pre-call |
| `mcp-commit-fanout` | In `forwardInternalRaw`, after AbortController setup | `persistent-object-do.ts` ~6418 | pre-call |
| `envelope` pre-call | In `v2CommitScopePost`, before CommitScopeDO fetch | `persistent-object-do.ts` ~4785 | pre-call |
| `envelope` kill_after_commit | In `/v2/envelope` handler, after durable save | `commit-scope-do.ts` ~495 | post-commit |

## Tests

`tests/worker/rpc-fault-inject.test.ts` — registered in curated `npm test` list.

29 tests:

- **FaultInjector unit tests** (parse, determinism, applyPreCall, applyKillAfterCommit):
  `p=1.0`, `p=0.0`, `nth=1`, `nth=2`, error/latency/timeout/kill modes, counter
  independence between pre-call and post-commit hooks.
- **Seam isolation**: fault configured for route A does not fire on route B.
- **Baseline snapshot (B-ii gate prerequisite)**: authority-slice error during
  cold scope seeding produces `cross_host_rpc` error metrics. The test documents
  current behavior ("at least one error metric fires") and instructs B-ii to
  update it to "exactly one, bounded." Uses `mode=error` (instant) not
  `mode=timeout` (5s RPC deadline wait) in the fake-DO lane.
- **kill_after_commit (D1 gate foundation)**: configure `nth=1` kill on the
  envelope seam; alice's enter fails from the gateway's perspective; CommitScopeDO
  emits `v2_envelope error=E_KILL_AFTER_COMMIT`; bob does not receive delivery;
  nth=2 turn (retry) succeeds normally.
- **mcp-commit-fanout error mode**: fanout errors are swallowed (best-effort);
  actor's turn succeeds.
- **mcp-commit-fanout latency mode**: turn succeeds with 50ms fanout delay.

## How D1's gate will use kill_after_commit

Plan item D1 moves peer delivery off the actor's reply path. The commit must
be durable before the reply; peer fanout must not block it. This opens a
crash window: if the DO evicts between reply and fanout, delivery is lost.

D1's fix is tail-driven delivery: an outbox drained from the persisted relay
tail (`v2_relay_tail` from e7b3daa), redelivered idempotently on rehydrate.

The kill_after_commit seam supports D1's gate like this:

1. Configure `{"route":"envelope","mode":"kill_after_commit","nth":1}`.
2. Run a 2-actor turn that commits to the CommitScopeDO.
3. The kill fires: commit is durable, delivery is suppressed.
4. Rehydrate the CommitScopeDO (re-create it from the same SQLite storage).
5. Assert the relay tail contains the unsent commit frame.
6. Trigger the redelivery path (D1's outbox drain) and assert the peer receives
   the observation.

Steps 4-6 are D1's implementation scope. The current test (step 3) is the
pre-condition gate.

## Wrangler smoke lane

`wrangler.smoke.toml` has a commented stub for `WOO_FAULT_INJECT` under `[vars]`.
To run a fault-injection scenario against the real workerd lane:

```toml
WOO_FAULT_INJECT = '[{"route":"authority-slice","mode":"timeout"}]'
```

Then run `npm run smoke:cf-dev`. This is the right lane for B-ii validation
(mode=timeout with real cross-DO RPC and real 5s deadline).

## Limitations and items for senior review

1. **Envelope pre-call has no AbortController signal**: `v2CommitScopePost` does
   not create an AbortController before calling CommitScopeDO. `mode=timeout`
   on the envelope pre-call seam (gateway side) would hang indefinitely. The
   test documentation uses `mode=error` for the fake-DO lane. For the workerd
   lane, timeout mode on envelope is safe because the MCP request's own timeout
   (not from an AbortController we control here) bounds the request.

2. **kill_after_commit counter independence**: The pre-call and post-commit hooks
   use separate call counters by design (`nextPreCallFault` skips
   `kill_after_commit` specs; `applyKillAfterCommit` only walks kill specs).
   This means `nth` for `kill_after_commit` counts COMMITTED envelopes, while
   `nth` for pre-call modes counts all `/v2/envelope` calls (including no-ops
   that don't commit). This is intentional and documented in the code.

3. **Fake-DO lane limitation for authority-slice cascade**: in the fake-DO lane
   all DOs share one process, so the "5s cold-owner timeout cascade" is a code
   path test only — not a wall-clock stress test. Real cascade validation
   requires the workerd lane with `mode=timeout`.
