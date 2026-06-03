# 2026-05-31 — cell-authority step 2 post-deploy measurement

Companion to `notes/2026-05-31-cell-authority-perf-plan.md`. Records the prod
measurement after step 2 (2a instrument, 2b checkpoint, 2c catch-up, 2d
cell-keyed repair) merged to main `dbca310` and deployed.

## Deploy

- Prod version: `f5873df7-0942-4d53-853b-d2d42a144300` (= main `dbca310`).
- Preflight green: typecheck, 261 tests, DO migrations aligned, secrets present.
- `npm run deploy` exited 1, but only on the **postflight smoke gate** — the
  publish itself succeeded (uploaded, triggers deployed, healthz ok / 325 objects).
- No DO-class binding change → `cf:migrations:check` was a no-op. No migration
  needed for this change (checkpoint state is in-memory only).

## Measurement

Run: `smoke:walkthrough:tail`, artifacts in
`.woo/smoke-measurements/step2-postdeploy-20260531T194730Z/`. 7548 woo.metric
events, 1369 tail events. Single run (RUNS=1).

### Smoke result: 7/9 (baseline `b7915524` was 4/9)

Two failures, both real (confirmed by trace, not flakes):

| step | error | trace |
|---|---|---|
| pinboard:add_note reaches peer | `E_VERBNF: reachable MCP tool not found: the_pinboard:add_note` | peer session cannot resolve a catalog verb on its room |
| tasks: cross-room `entered` reaches peer | `E_OBJNF: object not found: the_garden` | `exit_deck_south:move → the_garden`; destination room absent from executing shard's slice |

### Step-2 acceptance budgets — NOT met

**`authority_slice_reconstructed` reason buckets** (the 2a instrumentation that
the whole step is measured against):

| reason | count | meaning |
|---|---:|---|
| slice_served | 31 | source-host serving slices to gateways |
| **warm_turn_refresh** | **30** | full per-turn reconstruction — target was ~0 |
| warm_checkpoint_caught_up | 24 | 2c tail catch-up fired |
| warm_checkpoint_hit | 8 | 2b clean checkpoint hit |
| warm_checkpoint_repaired | 3 | 2d bounded repair fired |
| cold_open | 1 | expected |

The checkpoint machinery is alive (caught_up/hit/repaired all non-zero), but
`warm_turn_refresh` is still the dominant warm path → checkpoint hit-rate is too
low; coverage misses keep falling through to full reconstruction. 2b/2c/2d work
but are not yet displacing the expensive path at the rate the plan requires.

**`dangling_parent_ref` still 544** (step 1's named root cause; budget said
"after step 2: zero total"):

| missing | count | kind |
|---|---:|---|
| $chatroom | 322 | catalog class (scope-instance lineage) |
| $note | 168 | catalog class |
| $outliner | 32 | catalog class |
| $space | 22 | bootstrap scope class |

All four are scope-instance → catalog-class lineage dangles
(`the_chatroom → $chatroom`, etc.). The plan put scope/class lineage on the
authority slice (step 2's job, deliberately excluded from the step-1 universal
support set). It is **still not reaching the gateway shards.** This is almost
certainly the direct cause of both smoke failures: missing class lineage →
verb/object resolution degrades to not-found.

### Latency / pressure (unchanged-to-marginal)

- `Worker POST /mcp` wall p95 ≈ 10.8s, max ≈ 16.9s. Per-turn 5–28s.
- 317 cross-host round trips; `/__internal/authority-slice → the_chatroom` 16×
  (15.7s aggregate), still the per-turn fan-in.
- **No RPC timeouts** (0 err across all fanout/authority-slice routes) — the
  fanout acceptance gate (no `mcp-commit-fanout` timeout) is met.
- No SerializedWorld-materialization regression (8 events, all legit boundaries).

## Verdict

Step 2 moved smoke 4/9 → 7/9 and eliminated fanout timeouts, but did **not** meet
its two headline budgets: `dangling_parent_ref` is unchanged and
`warm_turn_refresh` is not driven down. The structural cause —
scope/catalog-class lineage (`$chatroom`, `$note`, `$outliner`) absent from
executor-shard slices — survives the checkpoint/repair path and is the blocker
for the final 2/9.

**Not rolled back.** Prod has no users, healthz green, failures are functional
(verb/object not found) not corruption.

## Next

Diagnose why scope/catalog-class lineage is missing from gateway-shard authority
slices despite 2b/2c/2d. Candidate: the checkpoint and the repair fetch carry
the requested object's own pages but not its parent class's `verb_bytecode` /
lineage pages, so a sparse shard that never independently materialized
`$chatroom`/`$note` still can't resolve inherited verbs. If so, the repair-id
set (2d) must close over parent-class lineage, or scope lineage must ride the
checkpoint explicitly. This is the same cross-shard staleness/coverage residual
flagged in the 2d code review.
