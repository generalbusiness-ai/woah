# B-ii: Bounded cold-owner authority reads + repair deadline budget

**Date:** 2026-06-10  
**Branch:** `b-ii-bounded-cold-reads`  
**Status:** Implemented, gated, tests green. Not merged to main, not deployed.

## Post-mortem: CA11 provenance violation (smoke:cf-dev 0/13)

### What failed

`npm run smoke:cf-dev` = 0/13 steps twice. Every step failed on the first
`enter` turn with:

```
E_NEED_STATE: contents needs owner-authoritative contents for the_chatroom
```

### Root cause

B-ii's KV seed path in `v2GatewayAuthorityPayload` served `source:"cache"` KV
authority **unconditionally** for all remote hosts — including during
`missing_state_repair` passes, where owner-authoritative data is required.

The sequence:

1. `enter the_chatroom` triggers `enforceResolutionOwnerRepair` (gateway opt-in).
2. `assertResolutionContentsOwnerAuthority` reads the destination room's
   `object_live` cell provenance. The KV seed served `source:"cache"`.
3. The check requires `source:"authoritative"` — raises `E_NEED_STATE`.
4. The repair loop sets `reconstructionReason = "missing_state_repair"` →
   `forceOwnerRefresh = true` and issues a fresh authority fetch.
5. BUT: `forceOwnerRefresh` only controlled the **local seed export exclusion**
   (the topology seed suppression path). The KV serve path checked neither
   `forceOwnerRefresh` nor `forceOwnerObjectIds`. KV served cache provenance again.
6. Step 2 fired again → same E_NEED_STATE → loop exhausted `maxAttempts` (8)
   → every turn failed.

### Why the fake lane didn't catch it

The fake-DO harness does NOT set `WOO_V2_KV_SEED_AUTHORITY`. The flag was
intentionally absent because the pre-B-ii note (correctly) identified that the
flag's extra `await` broke the fake-lane microtask ordering. But "we route around
it in the fake lane" was the architecture signalling the design was wrong: the
flag must be SAFE to enable everywhere, not something to hide.

### Why it only manifested in workerd

`wrangler.smoke.toml` sets `WOO_V2_KV_SEED_AUTHORITY = "1"`. Workerd has real
per-DO storage and the KV namespace is wired. This was the KV path's first real
exercise.

### The fix

Gate the KV serve path on whether the host has owner-required objects:

- If `forceOwnerRefresh = true` (entire pass is owner-required): skip KV for ALL
  hosts. Use live RPC.
- If any object in a host's set is in `forceOwnerObjectIds`: skip KV for that host.

Additionally: for owner-required live RPCs that time out (cold owner), do NOT
swallow the timeout as a stale fallback even when `tolerateRemoteFailures = true`.
Swallowing leaves the objects absent from the slice → same E_NEED_STATE loop.
Instead: fire async wake (owner warms for next turn) and propagate so the
repair-budget check surfaces a clean retryable error.

### What "cache provenance" means under CA11

CA11 provenance precedence: `authoritative > projection > cache > fallback > gossip`.
The KV checkpoint carries `source:"cache"` because it is a pre-built snapshot, not
a live owner read. By CA11.2, a movement-destination or contents-resolution guard
that requires owner-authoritative state MUST NOT be satisfied by a cache row.
This is load-bearing: the whole CA11.2 guard exists precisely to prevent stale
topology from silently permitting wrong moves. Serving KV here violates the
invariant CA11 was built to enforce.

### Where KV seed now applies vs not

**KV DOES serve:**
- Non-owner-required pre-plan passes (`reconstructionReason` = `warm_turn_refresh`
  or `cold_open`, no `forceOwnerRefresh`, object not in `forceOwnerObjectIds`)
- Topology neighbor lineage fetches (the quasi-static topology pre-seed path)
- Any path where cache provenance is explicitly tolerated under CA11 precedence

**KV does NOT serve:**
- `missing_state_repair` passes (`forceOwnerRefresh = true`)
- Any host whose object set contains an individually owner-required id
  (`forceOwnerObjectIds`)
- On a timeout for owner-required live RPCs (propagated, not swallowed)

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

`tests/worker/rpc-fault-inject.test.ts` — all 38 tests pass.

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

**B-ii Gate 4** (new, provenance fix). `WOO_V2_KV_SEED_AUTHORITY` flag enabled
in the fake-DO lane → `enter` succeeds (no CA11 provenance loop), subsequent
warm `say` also succeeds. Gate validates the flag is safe in ALL lanes.

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

The original B-ii implementation responded to this by leaving `WOO_V2_KV_SEED_AUTHORITY`
off in the fake lane, routing around the ordering sensitivity. The post-mortem
recognized this as the architecture signalling the design was wrong: the flag's
extra `await` broke the fake lane because the underlying provenance invariant was
violated. Once the CA11 provenance fix landed (KV never serves owner-required reads),
Gate 4 confirms `enter` works correctly with the flag on in the fake lane — the
provenance loop is eliminated, and the extra `await` no longer causes incorrect behavior.

The `WOO_V2_KV_SEED_AUTHORITY` flag now has a narrower role: it gates the KV
pre-fetch `await` to avoid unnecessary async overhead in environments where no KV
is configured. The flag SHOULD be set in wrangler.toml and wrangler.smoke.toml
(production and workerd lanes). It is NOT required to be absent from the fake lane;
future test setups may enable it to exercise the KV hit/miss path in-process.
