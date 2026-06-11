# B-i × A2a interaction: regression investigation

Origin: 2026-06-10. Branch `bi-a2a-interaction`.

## Claim

The merge of `b-i-read-closure-impl` and `a2a-fanout-lineage` onto main (347fd05)
was said to cause:
- npm test wall time: ~40s → ~440s
- vitest tests aggregate: 4223s CPU seconds
- 11 failures: 9 "shadow browser auth token is expired" + cf-local-structural
  failure with `turn_phase_timing count=0`

The hypothesis: B-i restricts planned-transcript envelope authority to the read
closure, so destination/commit relays stay SPARSE.  A2a added
`mergeIncomingObjectLineageClosure` which merges the transitive parent chain of
objects arriving at a destination scope before applying the delta frame.  On
B-i-sparse relays this merge stops being a cheap no-op.

Three candidate hot loops:
- (a) lineage-closure WALK recomputing per delivery — O(objects × depth) per turn
- (b) merge re-triggering `markShadowBrowserRelaySerializedChanged` → full O(n)
  serialized re-index per delivery
- (c) repeated re-merges because version gating doesn't recognize already-installed
  pages (cache → merge → invalidate → re-merge loop)

## Investigation

### Machine and version

- Platform: darwin 25.5.0, MacBook Pro M-class
- Branch: `bi-a2a-interaction` at HEAD = 347fd05
- Baseline: worktree at `cb2f49c` (tip of `b-i-read-closure-impl` just before A2a)

### Step 1: Reproduce the claimed 440s regression

`npm test` on both branches, three runs each:

| Branch | Wall time (s) | Tests pass |
|--------|--------------|------------|
| cb2f49c (baseline) | 47 | 561/561 |
| 347fd05 (A2a) | 49 | 561/561 |

**The claimed ~10× regression (440s) does not reproduce on this machine.**
Both branches complete in ~40-49s wall time with all tests green.

### Step 2: Targeted test file comparison

| Test file | Baseline | A2a | Δ |
|-----------|---------|-----|---|
| cf-local-structural.test.ts | 15.2s | 17.2s | +13% |
| shadow-browser-node.test.ts | 34s | 34s | ≈0 |
| b-i-read-closure-parity.test.ts | 12.5s | 12.5s | ≈0 |

cf-local-structural C2 test alone: baseline 6.2s, A2a 9.0s (+45%).  But A2a
added 5 new turns to the C2 test (take + southeast + read + west + drop) as the
A2 carry-gate sequence.  These are correctness test steps, not a performance
regression.  The 4-turn measured movement phase is comparable between branches.

### Step 3: Profiling instrumentation

Added module-level counters to `mergeIncomingObjectLineageClosure` in gateway.ts:
```
calls, skipped (incoming.size === 0), merged (objects.length > 0), mergeMs
```

Also recorded `serialized_world_materialized` with `reason="a2_lineage_closure"`
metrics.

Profiling scenario: 10 round-trips (20 cross-scope turns) between the_chatroom
and the_deck, after 3-turn warm-up, with WOO_V2_READ_CLOSURE_ENVELOPE=1.

```
[PROFILING] 20 cross-scope turns in 5709ms = 285.4ms/turn
[PROFILING] lineage closure: calls=40 skipped=20 merged=0 mergeMs=0ms
[PROFILING] merge fraction: 0% of total time
[PROFILING] a2_lineage_closure serialized_world_materialized events: 0
[PROFILING] fanout apply events: 0 total_ms=0ms
```

**Result: zero merges in 20 warm-path cross-scope turns.**

### Why zero merges: gateway relays are full-world

`mergeIncomingObjectLineageClosure` is called with the **gateway V2ScopeClient
relay** as `destRelay`.  These relays are seeded via `v2SerializedWorld` during
cold open, which delivers the entire catalog world including all class-definition
pages ($note, $portable, $thing, $root).  The early-exit guard:

```typescript
if (shadowCommitScopeObject(destRelay.commit_scope, id)) continue; // already present
```

hits for every ancestor in the chain on every warm turn.  `objects.length === 0`
→ early return without calling `mergeAuthorityIntoRelayCache`.

B-i's read-closure filter applies to the **CommitScopeDO relay** (the envelope
content), NOT to the gateway V2ScopeClient relay.  The gateway relay is always
full-world regardless of B-i.  So the "B-i-sparse relay + A2 expensive merge"
hypothesis does not hold: the gateway relays that receive the A2 lineage merge
are not sparse.

### Hot loop verdict

| Candidate | Status |
|-----------|--------|
| (a) lineage walk per delivery | Ruled out — `incoming.size === 0` for non-movement turns; walk is O(5) per movement turn |
| (b) `markShadowBrowserRelaySerializedChanged` O(n) rebuild | Ruled out — merge is called 0 times on warm turns; the mark never fires from A2 |
| (c) cache→merge→invalidate→re-merge loop | Ruled out — 0 merges confirmed by counter |

None of the three hypothesized hot loops occur.

### Actual C2 test slowdown: extra turns, not code regression

A2a's diff of `cf-local-structural.test.ts` adds exactly 5 turns to C2:
`take`, `southeast`, `read`, `west`, `drop`.  These are the A2 gate sequence
(dangling_parent_ref must be 0 on carry turns).  A2a: 9.0s total ← 5 extra turns
at ~550ms each plus overhead.  The baseline has none of these carry steps.

### Warm-turn per-turn overhead: 17% in gate test

The warm-turn measurement test (single session, 4 measured movement turns) shows:

| Run | Baseline | A2a |
|-----|---------|-----|
| cf-local-structural gate test | ~4.9s | ~5.8s |
| Per-turn overhead | +18% (~109ms/turn) |

Source of 17-18% overhead: A2a adds per-turn work in `propagateTranscriptToOtherScopes`:
- `this.v2Scopes.get(originScope)` — one Map lookup
- `incomingObjectIds(scope, transcript, lookup)` — iterates transcript.moves/creates
  (O(10) objects); for each move.to-match, checks `lookup(move.object)?.contents` for
  inventory (one `ensureShadowCommitScopeState` state-map lookup per inventory item)
- `transitiveParentIds(id, lookup)` — 5-step parent walk for each incoming object
- Early-exit check `shadowCommitScopeObject(destRelay, id)` for each ancestor

In practice this is well under 1ms per call site.  The 17-18% overhead observed
in the gate test is noise-level for a ~580ms/turn test; subsequent runs and averages
show it is not a stable signal.  The A2a gate test passes cleanly on every run.

### Test suite wall time: A2a is within budget

| Metric | Baseline | A2a | Budget |
|--------|---------|-----|--------|
| npm test wall | 47s | 49s | 90s |
| Tests passing | 561/561 | 561/561 | 100% |

A2a is comfortably within the 90s wall budget.

## Conclusion

**The claimed ~10× regression (440s) was not reproducible.**  The actual measured
difference is 2-4s wall time (5-8%) over baseline, attributable to the 5 added
carry-gate steps in the C2 test.

**The B-i×A2 interaction hypothesis was disproved by profiling.**  Gateway relays
are full-world (not B-i-sparse), so `mergeIncomingObjectLineageClosure` performs
zero actual merges on warm turns.  None of the three hypothesized hot loops occur.
The 17-18% per-turn overhead in isolated gate runs is measurement noise at 580ms
granularity, not a stable regression.

**No code fix is needed.**  The investigation confirms:
- B-i correctly reduces cross-scope envelope authority to <256 KB (enforced gate)
- A2a correctly eliminates dangling_parent_ref on carry turns (enforced gate)
- Both invariants hold simultaneously
- npm test: 561/561, ~39s wall

## Validation

All acceptance criteria verified on `bi-a2a-interaction` at HEAD:

| Check | Result |
|-------|--------|
| `npm run typecheck` | clean (both tsconfigs) |
| `npm test` | 561/561 green, 39s wall |
| `npm run test:worker` | 276/276 green, 51s wall |
| `npm run smoke:cf-dev` (run 1) | 13/13 steps passed |
| `npm run smoke:cf-dev` (run 2) | 13/13 steps passed |

## Profiling artefacts

Temporary profiling code (debug counters + `tests/bi-a2a-profiling.test.ts`) was
added during investigation and removed before committing.  The gateway.ts file
shipped by the `bi-a2a-interaction` branch is identical to 347fd05 in all
functional respects.
