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
