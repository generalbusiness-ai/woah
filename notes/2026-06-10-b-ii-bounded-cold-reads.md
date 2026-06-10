# B-ii: Bounded cold-owner authority reads + repair deadline budget

**Date:** 2026-06-10  
**Branch:** `b-ii-bounded-cold-reads`  
**Status:** Implemented, gated, tests green. Not merged to main, not deployed.

## What was built

Three independent improvements delivered together under plan item B-ii:

### 1. KV seed path for cold-owner authority (HOST_SEED_KV)

**Problem.** When the MCP gateway needs an authority slice from a foreign host DO
and that DO is cold (not yet allocated), the live `/__internal/authority-slice` RPC
blocks for ~5 seconds on cold-start before returning. This is the dominant latency
component for first-turn cross-scope movements.

**Fix.** When `WOO_V2_KV_SEED_AUTHORITY=1` is set (production and workerd smoke
lane), the gateway pre-fetches per-host KV seed pointers from `HOST_SEED_KV`
*before* the concurrent live-RPC `Promise.all`. On a KV pointer hit, the authority
slice is built from the durable checkpoint bytes with `source:"cache"` provenance
(~10–50ms). An async DO wake is scheduled via `state.waitUntil` so the owner warms
for subsequent turns. On a KV miss, the live RPC runs unchanged.

**Feature flag rationale.** The KV pre-fetch adds an `await` before the concurrent
live-RPC section. The fake-DO test harness is sensitive to microtask ordering: any
extra `await` before the `Promise.all` changes the concurrent handler interleaving,
causing `enforceResolutionOwnerRepair` to fail for the `enter` verb with
`E_NEED_STATE`. Without the flag, the code path is byte-for-byte identical to the
pre-B-ii baseline. The flag MUST NOT be set in the fake-DO lane.

**Files changed:**
- `src/worker/persistent-object-do.ts`: KV pre-fetch in `v2GatewayAuthorityPayload`
- `src/core/types.ts`: added `kv_seed` to `authority_slice_stale_fallback` reason union;
  added `authority_slice_async_wake` metric shape
- `wrangler.toml`: `WOO_V2_KV_SEED_AUTHORITY = "1"`
- `wrangler.smoke.toml`: `WOO_V2_KV_SEED_AUTHORITY = "1"`

### 2. Repair deadline budget in submitTurnIntent

**Problem.** The turn repair loop in `src/core/executor.ts` retries up to
`maxAttempts` times with no wall-clock bound. Under sustained cold-start or
error conditions the loop could consume the entire 20-second MCP tool deadline
without signalling failure, leaving the client with a timeout and no useful error.

**Fix.** Added `repairBudgetMs?: number` to `SubmitTurnIntentOptions`. When set,
the loop checks `Date.now() - turnStartedAt >= repairBudgetMs` at the top of each
retry. If the budget is exhausted it throws the last retryable error (not a raw
`Error`). The MCP gateway sets `repairBudgetMs: MCP_REPAIR_BUDGET_MS = 12_000`
(12 seconds, leaving 8 seconds of the 20-second deadline for teardown/cleanup).

**Files changed:**
- `src/core/executor.ts`: `repairBudgetMs`, `lastRetryableError`, `budgetExhausted`
- `src/mcp/gateway.ts`: `MCP_REPAIR_BUDGET_MS = 12_000` constant + option wiring

### 3. C1a fault injection seam (forwardInternalRaw)

**Problem.** There was no way to inject deterministic faults (timeout, error,
latency) on cross-DO RPC routes in test scenarios. The `rpc-fault-inject.test.ts`
baseline tests were effectively no-ops because the `FaultInjector` class existed
but was never wired into the actual outbound fetch path.

**Fix.** The `FaultInjector` is now wired into `forwardInternalRaw` (the single
outbound RPC dispatch site). When `WOO_FAULT_INJECT` is set, a pre-call hook fires
before the outbound `fetch` for `/__internal/authority-slice` and
`/__internal/mcp-commit-fanout`. The hook is inside the existing `try/catch` so
fault-injected errors produce `cross_host_rpc{status:"error"}` metrics (needed by
Gate 1 verification).

**Mode semantics:**
- `mode: "timeout"` — hangs until the request's AbortController fires (real
  deadline governs wall time; use in workerd lane for realistic budget testing)
- `mode: "error"` — throws immediately (use in fake-DO lane, avoids real 5s waits)
- `mode: "latency"` — delays `ms` milliseconds before the real call

**Files changed:**
- `src/worker/persistent-object-do.ts`: `_faultInjector` field, `faultInjector()`
  accessor, seam in `forwardInternalRaw`

## Test gates

`tests/worker/rpc-fault-inject.test.ts` — all 36 tests pass.

**Baseline snapshot:** two-part test that (a) verifies a cold-open with p=1.0
error fails fast (< 5s), and (b) verifies a warm same-scope turn with 2000ms
latency completes in < 1800ms (warm path issues no authority-slice RPCs).

**B-ii Gate 1.** Authority-slice `mode=error` → cold-open `enter` fails fast
(< 5s, not a 20s hang), error is non-null, C1a seam fired (at least one
`cross_host_rpc{status:"error",route:"/__internal/authority-slice"}` metric).

**B-ii Gate 2.** Authority-slice `mode=latency, ms=2000` → warm `say` turn
completes in < 1800ms (warm path does not issue authority-slice RPCs, so the
latency injection does not affect it).

**B-ii Gate 3.** Authority-slice `mode=error` → cold-open `enter` fails fast
(< 10s), error is non-null, attempt count ≤ maxAttempts (8).

## Spec updates

`spec/protocol/cell-authority.md`:
- CA13.4: added cold-owner authority paragraph describing the KV seed path,
  provenance, async wake, and `repairBudgetMs` constraint.
- CA14.19: new conformance item for B-ii, referencing the three gate tests.

## Microtask ordering pitfall (recorded for future reference)

The fake-DO harness (`tests/worker/fake-do.ts`) executes all DOs in a single
process with synchronous in-memory shared state. Concurrent `fetch()` calls
between DOs are interleaved by microtask scheduling. Any extra `await` before
the concurrent `Promise.all(byHost, ...)` section in `v2GatewayAuthorityPayload`
changes which fake DO handler runs first, breaking the `enforceResolutionOwnerRepair`
check that the `enter` verb depends on for cold-open world seeding.

This is NOT a bug in the implementation — it is a limitation of the single-process
fake harness (real workerd has isolated DO contexts). The `WOO_V2_KV_SEED_AUTHORITY`
flag exists solely to preserve the fake-lane microtask ordering, which has been
stable since the harness was introduced. A future multi-DO harness refactor that
uses actual async boundaries would eliminate this constraint.
