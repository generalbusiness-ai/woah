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

## RESULT — deployed f9e509c7, one tail-backed smoke (the fork is resolved)

Deployed to prod as `f9e509c7-43a6-48ff-aacb-ff09439d27dc` (skip-smoke; rollback
target `f8968c04`). One tail-backed run, halted clean after 2 timeouts (~40s vs
the old ~5min — the halt works, zero secondary-error pollution).

Phase attribution, `the_chatroom:enter` (3 turns, halt-limited):

```
target:verb (outcome)   n  att auth#  tot.mean tot.p95 ensure auth   serial build vm  submit
the_chatroom:enter      3   6   11     43192   63803    294  16162    0     0    0   26735
phase share:  submit 62% | auth 37% | ensure 1% | serial/build/vm 0%
```

Dispatch timing:
```
method        n  tot.p95 getWorld forward handle register
POST         12   7068      0       0     7003    138
POST (cold)   7    865    583       0       0     283
DELETE        4     95      0       0       0      95
DELETE(cold)  3    100     37       0       0      66
```

**Findings (evidence, not inference):**

1. **Turn wall = 62% submit (commit-envelope RPC) + 37% authority
   reconstruction + 1% ensure. LOCAL COMPUTE (serialize/plan_build/vm) = 0%.**
   The fork is resolved: it is the authority + commit path, NOT local
   per-turn compute. CA12/CA13 *local* cheap-paths would buy ~nothing.
2. **The repair loop runs ~2 attempts/turn** (att=6 over 3 turns; auth#≈3.7/turn).
   Each attempt redoes authority + submit, so the repair DOUBLES the two
   dominant phases. Killing the 2nd attempt is the single biggest lever, and
   its root cause is first-attempt authority incompleteness → E_NEED_STATE —
   i.e. the same gap B7 warm-fill closes.
3. **DELETE's own dispatch work is ~95ms** (not 22s). The invocation table's
   DELETE wall ~27s / cpu ~15.6s is contention/queueing behind the in-flight
   20s POST turn on the same DO — head-of-line blocking, not intrinsic teardown
   cost. "Fixing DELETE" (waitUntil) will not help; making the POST turn fast
   unblocks it. (The earlier blind-fix instinct would have wasted effort.)
4. **Cold-load is cheap** (getWorld cold 583ms) — cold-start is solved; not the
   problem.
5. The CF `cpuTime` (POST /mcp cpu_p95 11.4s) does NOT correspond to
   gateway-local turn compute (which is 0). It is the commit-side work reached
   *through* submit — CommitScopeDO `/v2/envelope` cpu_p95 5.4s doing
   commit-apply over ~10.8k indexed objects (per the data-path analyzer),
   multiplied by the repair attempts. So commit-apply indexing (a CA12/13
   *server-side* cost) lives INSIDE the 62% submit, behind the ×2 repair.

**Slice 2, evidence-ordered:**
- P1 — eliminate the repair-loop 2nd attempt by making first-attempt authority
  complete (B7 warm cache-fill / pre-plan authority completeness). Halves
  submit+auth at a stroke.
- P1 — B7 load-bearing: stop per-turn authority-slice reconstruction
  (37%, ~3.7 calls/turn).
- P2 — commit-apply indexing on CommitScopeDO (the 5.4s inside submit); only
  bites after the ×2 repair amplification is removed.
- No direct DELETE fix needed (contention symptom of the slow POST).

Artifacts: `.woo/smoke-measurements/deploy-f9e509c7-20260603T144736Z/`.

Follow-up polish: `analyze-data-path-costs.mjs` still lists `turn_phase_timing`
/ `mcp_dispatch_timing` as UNCLASSIFIED (only `analyze-smoke-tail.mjs` was
taught the new kinds); classify them there too when convenient.

## Slice 2 progress — head fix deployed (88751797), deeper layer found

Deployed branch through f9e509c7 → 511215ff → 88751797 (all instrumentation +
the head fix + review fixes). Tail-smoke after 88751797 still fails (2 enter
timeouts, halted). Phase data shows the head fix WORKS for its layer but a
second layer remains:

- Layer 1 (FIXED): stale_head. expected@0 now appears once per scope, not 8×.
  submitTurnIntent adopts the conflict's `current` head on retry (applyHead).
- Layer 2 (STILL FAILING): `read version mismatch guest_N.name: transcript=0
  actual=1` — 61/run — drives the remaining 8-attempt grind. The planning world
  reads the ACTOR's own name@0 while the commit scope has @1. Cross-shard
  authority freshness: the actor's display name was committed via one gateway
  shard; this enter lands on a different shard whose reconstructed authority
  slice for the actor lags at @0. The repair refetches via the authority-slice
  reconstruction (a lagging owner/projection source), NOT the commit scope's
  committed cell versions, so it never converges.

This is the core B7 warm-fill / authority-source problem: the gateway must plan
against authority sourced from (or warm-filled by) the commit scope, not a
reconstruction that lags it. Tasks #1–#3 are layers of ONE authority-freshness
problem, deeper than the initial framing. Layer 2 is the real remaining work and
is architecturally significant — paused for direction before a large change.
