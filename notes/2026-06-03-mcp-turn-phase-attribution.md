# 2026-06-03 — MCP turn phase attribution (Slice 1)

## Why

Smoke run against prod deploy `f8968c04` failed 9/10, timeout-dominated on
MCP. The decisive number was **CPU**, not wall: `PersistentObjectDO POST /mcp`
cpu_p95 **14664ms** (wall_p95 21030ms), `DELETE /mcp` cpu_p95 **22437ms** (wall
max 49007ms). On Cloudflare, awaiting a cross-DO `fetch()` does not count as
CPU, so 14.6s is real in-DO compute — and the existing `do_handler`/`mcp_request`
metrics only wrap the *whole* request, so we could not say whether that compute
is authority reconstruction/fan-in vs local serialize/plan-build/VM vs the
commit-envelope RPC. Two independent reviewers split on whether to go straight
at B7 (a wall/RPC fix) or CA12/CA13 (a CPU fix). We cannot choose without
attribution. This slice instruments first; it changes no turn behaviour.

## What landed

1. **`turn_phase_timing`** (core `submitTurnIntent`, so MCP/dev/browser all get
   it). Charges each turn's wall time across the loop phases — `ensure_client`,
   `authority` (+`authority_calls`), `serialize`, `plan_build`, `vm`, `submit` —
   summed across repair attempts, with `attempts` and `outcome`. One metric per
   turn via the already-threaded `onMetric`. Reading the split: local-compute
   phases (serialize+plan_build+vm) vs wall-bound phases (authority+submit)
   separates the 14.6s CPU from RPC wait; `attempts > 1` shows the repair loop
   multiplying everything.

2. **`mcp_dispatch_timing`** (worker `PersistentObjectDO` `/mcp` block). Splits
   the wrapper steps *outside* `submitTurnIntent` — `get_world` (cold flagged),
   `forward`, `handle`, `register` — and stamps `method`. This is the
   instrument-first answer to the 22s-CPU DELETE teardown (DELETE never enters
   `submitTurnIntent`, so `turn_phase_timing` does not cover it).

3. **Analyzer** (`analyze-smoke-tail.mjs`): per-verb phase table + a
   "phase share of summed turn wall time" rollup, and a POST-vs-DELETE dispatch
   table. Both degrade gracefully when the tail predates the instrumentation.

4. **Harness halt-on-cascade** (`smoke-walkthrough.ts`): once the gateway is
   timeout-saturated, every step times out and its reset times out, polluting
   the run with misleading secondary errors. Halts after 2 consecutive
   timeout-class failures. `isTimeoutDetail` classifies saturation timeouts
   (MCP POST timeout, RPC deadline, step watchdog) but NOT real protocol/content
   failures (a waitFor "timeout after Nms waiting for matching observation" is a
   fanout gap, not saturation, and must not trigger a halt).

## Verification

- typecheck clean (both tsconfigs); `npm test` 362 green.
- `tests/executor.test.ts`: new case asserts `turn_phase_timing` shape.
- `tests/smoke-walkthrough-harness.test.ts`: classifier + halt-error cases.
- `tests/worker/cf-local-walkthrough.test.ts` (the `smoke:cf-local` gate):
  added assertions that BOTH metrics fire on the real DO path —
  `turn_phase_timing` (numeric phases, ≥1 committed), `mcp_dispatch_timing` for
  POST **and** DELETE. Proves the instruments are not blind.

## Findings already surfaced (NOT changed here — evidence-driven Slice 2)

- **commit-fanout is already non-fatal + bounded** (per-host try/catch → warn,
  `hostReadRpcTimeoutMs`). But `deliverMcpCommitFanout` does `await
  Promise.all(...)` over shards on the synchronous commit path
  (`persistent-object-do.ts` ~5085), so a slow shard adds up to the RPC timeout
  to the turn. Deferring to `waitUntil` changes delivery ordering — wait for the
  `submit_ms` evidence before doing it.
- **DELETE re-registers instead of unregistering.** On `DELETE /mcp`,
  `registerMcpSessionRoute` runs against a 204 (response.ok) and, because
  `closeSession` does not drop `world.sessions`, calls `registerSessionRoute`
  (a Directory RPC) on teardown. The REST path unregisters via `onSessionEnded`;
  the MCP DELETE path does not. Smells like a bug, but it is one Directory RPC
  (wall), so it does not explain 22s CPU — let `mcp_dispatch_timing` localize
  the cost (`get_world` cold vs `forward` vs `handle` vs `register`) before
  fixing.

## Next

Deploy this slice, run ONE tail-backed smoke, read the phase share + dispatch
table. That decides Slice 2: B7-load-bearing (if authority/submit dominate) vs
CA12/CA13 cheap paths (if serialize/plan_build/vm dominate) vs the DELETE/fanout
amplifier fixes above.
