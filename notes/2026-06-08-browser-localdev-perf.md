# Browser/localdev perf — exact metrics (deploy 13c849b baseline)

Measured from a REAL run: worktree dev-server on :5273 (isolated DB, WOO_METRICS=on),
turn-heavy e2e `smoke.spec.ts:1084` ("two browser agents execute locally"), ~21.5s.
Parsed dev-server stdout `woo.metric` lines.

## Hypothesis CORRECTED by metrics
`serialized_world_materialized = 0` across the whole run. The dev-server does NOT
re-serialize the world per turn — the earlier materialize-then-redirty hypothesis is
WRONG. The real cost is BROWSER-side (v2-browser-worker.ts).

## The real top issues (browser_activity, sorted)
| phase | count | ms_sum | bytes_sum | category |
|---|---:|---:|---:|---|
| **idb_tx** | **1048** | 2170 | — | unnecessary DB activity (per-row IDB txns) |
| state_transfer_request | 13 | **3182** | 522,281 | repeated transmission of overlapping state |
| cache_mutation | 61 | 33 | 1,691,809 | repeated/overlapping cache writes |
| frame_decode | 36 | 5 | 1,328,153 | parsing overlapping frame data |
| frame_process | 33 | 77 | 1,238,792 | transform of overlapping frame data |
| websocket_send | 19 | 2 | 554,153 | — |
| execution_cache_build | 69 | 900 | — | repeated execution-cache rebuilds |
| command | 9 | 2834 | — | command planning |
| (browser_activity total) | 1417 | — | — | — |

## Top 3 to fix (magnitude + clarity)
1. **idb_tx storm: 1048 IndexedDB transactions — dominated by redundant READONLY
   reads** (NOT per-row writes; cachedStatePagesByHash is already a single getAll).
   Exact by-store breakdown: meta 182 (165 readonly), transcript_tail 130 (123 ro),
   state_pages 124 (113 ro), execution_checkpoints 122 (121 ro), execution_transfers
   90 (73 ro), tentative_turns 81, pending 77, projection_rows 53, ... Each `tx()`
   (v2-browser-worker.ts:2468) opens its own single-store IDB transaction. The hot
   keys (meta/head, checkpoints, transcript tail) are re-read from IndexedDB on
   nearly every operation with no in-memory memoization, and the rebuild churn (#3)
   multiplies it. FIX: memoize the hot reads in memory (invalidate on the
   corresponding write), and/or batch multi-store reads into one transaction.
   Target: 1048 → low hundreds. (Two earlier hypotheses — dev-server re-serialize,
   per-page read storm — were both REFUTED by the metrics. Memoization must be done
   carefully: stale in-memory caches are the hazard.)
2. **state_transfer_request: 13 requests, 522KB, 3.2s.** Browser re-requests state
   transfers that re-send overlapping cells. FIX: dedupe / request only the missing
   page refs (a transfer should not re-fetch cells the browser already holds).
3. **execution_cache_build: 69 rebuilds, 0.9s** (+ frame_decode/process re-parsing
   ~1.3MB each). The browser rebuilds its execution cache too often. FIX: memoize /
   rebuild only when the executable inputs actually change.

## Test expansion (the "detailed metrics" deliverable)
The e2e smoke already collects browser_activity. Add perf-regression assertions on
the per-run counts (idb_tx, state_transfer_request, execution_cache_build) so a
regression toward the storm/overlap fails the gate. (Browser-side metrics need the
real e2e; the in-process tests/browser-localdev-perf.test.ts confirms the CORE path
materializes 0 — useful as the "core is lean" guard.)

## Resolution (worktree browser-localdev-perf)

### Issue #1 — idb_tx storm: ADDRESSED (two changes)
1. **meta write-through cache** (v2-browser-worker.ts). putMeta is the sole writer of
   the small `meta` store and keys are scope/session-specific, so an in-memory
   write-through cache stays authoritative for this dedicated worker. Measured: meta
   idb_tx 182/run (165 readonly) -> ~37 (~11 readonly), **-82%**.
2. **Retire the dead execution_checkpoints store.** Its WRITE path was removed in
   0e3b1c5 but the READ path survived, so getExecutionCheckpoint was called ~130x/run
   and ALWAYS returned undefined (nothing wrote the store). Removed the store, accessors,
   the always-false transcriptCoveredByCheckpoint guard, the inert skip_checkpoint_build
   option, and all the dead checkpoint plumbing (type, params, compose stat, status
   field). Measured: execution_checkpoints idb_tx 122-132/run -> **0** (store gone).
   Behavior unchanged (checkpoint was provably always undefined at runtime).

### Issue #3 — execution_cache_build churn: ADDRESSED
**Epoch-keyed memo for executionCacheForScope.** The cache is a pure function of three
IDB stores (execution transfers, state pages, committed transcript tail) plus the holder
authority. A module-level `executionInputEpoch` is bumped by every leaf writer to those
stores; the cache is memoized by (scope, epoch, authority). The dominant redundant caller
was cache_status polling, which rebuilt the whole cache (twice — also via
canReconstructExecutionNode) on every poll. Measured in the turn-saturated e2e: **27 of
~80 builds (~34%) served from the memo** with zero IDB reads; the hit rate is higher under
idle status-polling, which this turn-heavy test minimizes. The epoch is sampled BEFORE the
reads so a write landing mid-read makes the entry born-stale (rebuilt next call) — never a
torn read served to the local VM.

### Issue #2 — state_transfer overlap: INVESTIGATED, largely already mitigated
The page-CONTENT overlap is already eliminated server-side: requestStateTransfer sends
`known_page_hashes`, and the responder (shadow-turn-exec.ts ~471) marks already-held pages
`inline:false` and omits them from `inline_pages`. The residual cost is (a) per-round
re-send of atom preimages + page_refs metadata for the full granted closure, and (b) the
multi-round repair loop itself (13 repairs / ~10 turns, ~3.5s). Both live on the shared
AUTHORITATIVE transfer path (byte-identical with Cloudflare) and the cold-cache repair
storm is a known, deep area (see b7_state_transfer_warmfill, divergent_session_state_race).
A safe, targeted browser-side fix is not available without a larger authoritative-path
change, so it is deliberately left for dedicated work rather than forced here.

### Tests
- tests/v2-browser-worker.integration.test.ts: the state-page-read test now asserts BOTH
  the batching invariant (cold build = one bulk getAll) AND the memo invariant (a redundant
  cache_status does not re-read state pages).
- e2e/smoke.spec.ts ("two browser agents execute locally"): structural perf-regression
  guards — execution_checkpoints reads == 0 (dead store stays dead), meta readonly < 40
  (cache holds, no storm), and >= 1 execution_cache_build memo hit (memo active).
- Gates: typecheck clean; 67 browser-suite tests; npm test (375); npm test post-memo (375).
