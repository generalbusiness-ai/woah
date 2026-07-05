# Plan 002 Phase 2 kickoff — building `src/net/` (the coherence layer)

Date: 2026-07-05. Contract: `spec/protocol/coherence.md` (CO1–CO12).
Registration: `plans/002-simplest-deployable-system.md`. Branch: `coherence-spec`.
Status at kickoff: Phase 0 (spec) and Phase 1 (TurnEffects seam, `fb5319a`)
are committed; all gates green (npm test 596, worker 306, full 1680,
smoke:cf-dev 13/13).

## Build order (each step lands with its tests; red-to-green)

1. **`errors.ts`** — the CO6 taxonomy as a closed discriminated union +
   constructors + `isRetryable()`. No dependencies. The taxonomy gate
   (CO12.7) starts here: nothing in `src/net/` may throw outside this enum.
2. **`cells.ts`** — CellStore: typed pages with mandatory provenance
   (`authoritative | derived | seed | echo`), content addressing
   (reuse `hashSource` from `src/core/source-hash.ts`), epoch stamps
   `(scope_head, catalog_epoch)` (CO8). Lineage-closure enforced at the
   serialization boundary (CO7: a transfer that doesn't close over
   `object_lineage` does not serialize — `E_LINEAGE` is an assert).
3. **`transcript.ts`** — the EffectTranscript schema (CO3). Apply =
   deterministic re-application of recorded writes to a cell-store clone.
   **Discovery (2026-07-05): the implemented v2 transcript kind is
   `woo.effect_transcript.shadow.v1`** (`src/core/effect-transcript.ts:68`),
   not VTN7's `woo.effect_transcript.v1`, and its field shape differs from
   the spec draft (`route`, `seq`, `call` pick, `stateProbes`,
   `sessionScopeTransition`, `projectionWrites`; `TranscriptCell =
   RecordedCell` from turn-recorder). Consequences:
   - `transcript.ts` consumes the **implemented** shape (type-imported —
     this is the single allowed v2 bridge file) so the differential gate
     compares like with like;
   - coherence.md CO3 needs a one-line correction when transcript.ts
     lands: the CO3 schema is the *target* shape; the bridge consumes
     shadow.v1 until Phase-5 deletion, at which point the kind string
     graduates to `woo.effect_transcript.v1`;
   - the apply mapping is TranscriptCell(RecordedCell) → net cellKey —
     write the translation table in transcript.ts next to the code.
4. **`scope.ts`** — the sequencer: head, epoch, CO4 validation order
   (steps 1–11 with the doomed-round short-circuit bounds), reply/seen
   idempotency, bounded recovery tail, scheduled-turn queue + parked-task
   rows (CO2.8) with an alarm interface on the Host.
5. **`host.ts`** — the Host interface (`rpc`, `storage`, `deferred`,
   `clock`, `alarm`) + **InProcessHost** only (Phase 2 scope).
6. **`route.ts`** — write-set → scope selection with the CA3 ride-along
   rule and `E_SCOPE_SPLIT` for two-shared-scope write sets (CO2.3).
7. **`outbox.ts`** — durable fanout rows, at-least-once, per-scope order,
   receiver no-op by head (CO2.7).
8. **`plan.ts`** — gateway planner: runs the world engine (via the Phase-1
   `TurnEffects`/`TurnEngine` seam) against a CellStore view, emits the
   transcript + read-closure envelope (CO7, byte ceilings enforced here).
9. **Differential gate** — `scripts/smoke/scenario.ts` through v2
   (fake lane) and `src/net/` (InProcessHost); compare committed state +
   observation streams turn-by-turn (CO12.4).

## Design decisions fixed now (do not re-litigate mid-build)

- **Cell model**: a cell is `{ key: CellKey, page: Page, version: string,
  provenance: Provenance, stamp: EpochStamp }`. CellKey reuses the
  planning-cell vocabulary (`object_live`, `object_lineage`,
  `verb_bytecode`, session/log kinds) so read-closures translate 1:1
  from what the engine already records via TurnEffects.
- **Scope state is cells, not `SerializedWorld`.** The CA12 lesson: the
  compatibility view on the hot path was the largest design/impl gap in
  v2. `src/net/` never constructs a whole-world image; exports for
  diagnostics go through an explicit boundary function.
- **Validation reuses semantics, not code**: the VTN8 order is
  re-implemented over the cell store; the v2 helpers in
  `shadow-commit-scope.ts` remain untouched (they still serve v2 until
  Phase-5 deletion). Where a helper is pure schema logic (e.g.
  `finalWritesByCell`), importing it from the v2 module is allowed **via
  transcript.ts only** — one bridge file, so Phase-5 deletion has one
  place to cut.
- **No flags.** Configuration is budgets and Host bindings (CO7).
- **Tests-first**: port the assertions (not the harnesses) of the v2
  validation corpus — `tests/worker/v2-cost-budget.test.ts` (budget
  gates), commit-validation cases in `tests/worker/` (idempotency,
  stale-head, read-version, post-state mismatch), D1 outbox gates
  (ordering, redelivery idempotency, backoff) — into
  `tests/net/*.test.ts` against InProcessHost. New files must go into
  the **curated `npm test` list** (curated-gate rule).

## What Phase 2 explicitly does NOT touch

- No CF DO shells, no wrangler changes (Phase 3).
- No transport rewiring, no client changes (Phase 4).
- No v2 code deletion or modification beyond the Phase-1 seam (Phase 5).
- v2 remains the production path throughout; the standing v2 freeze
  (approved 2026-07-05) covers deploys, not this parallel build.

## Progress log (update as steps land)

- [x] 1. errors.ts + tests (`70e0838`)
- [x] 2. cells.ts + tests — CellStore with role-enforced CI, canonical
      content addressing, epoch reseed, lineage-closed transfers with
      receiver-known closure
- [x] 3. transcript.ts + tests — bridge of implemented shadow.v1 shape,
      RecordedCell→net-cell translation table, clone-apply with v2
      finalWritesByCell parity, contents→projection routing, deterministic
      post-state version; CO3 bridge note added to coherence.md
- [x] 4. scope.ts + tests — ScopeSequencer: CO4 order (verdict-reasons
      reply model, terminal-vs-retryable split, incomplete never
      relabelled), idempotent replies, rolling head digest, bounded
      recovery tail, CO2.8 scheduled queue with nextAlarmAt/dueTurns;
      planner-parity post_state_version comparison
- [ ] 5. host.ts (InProcessHost)
- [ ] 6. route.ts + ride-along tests
- [ ] 7. outbox.ts + D1-ported gates
- [ ] 8. plan.ts + envelope byte gates
- [ ] 9. differential gate
