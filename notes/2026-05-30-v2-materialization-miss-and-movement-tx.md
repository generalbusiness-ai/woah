# 2026-05-30 — v2 materialization-miss + movement-as-transaction

Origin: the cross-actor MCP smoke `the_garden` `E_OBJNF` failure, traced to a
real invariant hole in the v2 sparse-executor / missing_state repair loop. This
note records the proof, the spec decisions, what has LANDED on this branch, and
the remaining sequence. It is a work description, not normative — the normative
text is in `spec/protocol/v2-turn-network.md` §VTN8.1 and §VTN10.1.

## Status (this branch: scope-executor-atomguard)

- **DONE & verified:** §VTN8.1 + §VTN10.1 spec text; the materialization-miss
  fix; the regression tests. This is a correctness checkpoint, not a smoke fix:
  it is **NOT deployed**, and the non-browser executor and live fanout paths are
  not wired yet.
- **DONE in-process:** MV-A: explicit placement transaction fences let a
  movement transcript commit under a transaction scope different from
  `transcript.scope`, with stale plans rejected at the transaction head.
- **DONE as a transport seam:** planned-exec submission can route a movement
  transcript to a caller-selected transaction scope after fresh planning, while
  keeping `TurnKey.scope` as the VM execution scope and seeding authority for
  the fenced cells.
- **DONE as an executor seam:** default durable intent envelopes now execute as
  guarded exec requests with static call keys instead of the authoritative
  relay fast path. `missing_state` replies feed the next authority refresh by
  extracting object ids from missing atom preimages, so a transitive
  materialization miss can drive an outer hydrate/retry instead of committing a
  buried `E_OBJNF`.
- **NEXT:** Wire the placement transaction selector into the production
  non-browser movement path, then fanout.

## The proof (conclusive, in-process)

`tests/scope-executor-garden-probe.test.ts` reproduced the prod failure exactly
(same VM trace: `exit_deck_south:move` pc 76 → `:invoke` → `the_deck:go` →
`the_deck:south`, `E_OBJNF object not found: the_garden`).

- **CASE A** — full-state executor runs `the_deck:south` in one turn. It is
  inherently **multi-scope**: the transcript writes `contents:the_deck`,
  `contents:the_garden`, and `location:guest_1`. `the_garden` is reached
  transitively via `exit_deck_south.dest`, not named in the call.
- **CASE B (before fix)** — sparse executor missing `the_garden`: `transfers: 0`,
  `result.ok: true`, `frame.op: "applied"`, the `E_OBJNF` buried as a `$error`
  observation, actor stranded in `the_deck`. **Silent corruption.**

Root cause: `WooWorld.object(id)` threw raw `E_OBJNF` **before** emitting any
recorder event, so the atom guard (`ShadowStateGuardTurnRecorder`, only converts
recorder *events* into `E_NEED_STATE`) never saw the miss. The design invariant
"every state miss becomes a pre-execution missing_state" had a false
precondition: a bare object-lookup miss did not reach the guard.

The browser-edge path was never affected (it executes against a full-closure
authoritative slice). The hole was specific to sparse/guarded executors — the
non-browser (MCP/agent) path A3 created.

## Spec decisions (landed)

1. **§VTN10.1 — object lookup miss = materialization miss.** Under guarded
   execution, an absent-id lookup MUST emit a lifecycle materialization probe
   (recorder-visible) → `missing_state` → cell-page repair → whole-turn retry,
   *before* any `E_OBJNF`. Semantic `E_OBJNF` only after repair proves true
   absence/unauthorization against the owning authority. **Full-closure**
   authoritative executors are exempt (note: keyed on owning the full *closure*,
   not the full *scope slice* — a source-scope executor complete for `the_deck`
   still legitimately misses `the_garden` and is NOT exempt). Probe is generic
   substrate behavior, NOT move-specific, NOT catalog-aware. A lifecycle repair
   transfers the object's full materialization closure and grants read/write atom
   coverage for the installed cells; this is coverage, not write authority.
   Transitive move-target prediction is an optional routing optimization only.

2. **§VTN8.1 — movement is a placement transaction.** A move touches
   `location:actor` + `contents:source` + `contents:dest` across two scopes; the
   destination is often transitive (exit.dest). **MV-A** (combined/fenced
   movement scope over all placement cells) is chosen as the production rule.
   MV-B (single-scope with a known destination-contents lost-update race) is a
   written non-prod fallback only — we do not spend engineering on it, because it
   knowingly ships the "works until two actors" race we are trying to stop
   producing.

## Landed implementation (§VTN10.1)

- `src/core/world.ts`: `shadowExecutionGuardActive` flag + `setShadowExecutionGuard()`;
  `object(id)` miss branch emits `recordTurnStateProbe({kind:"lifecycle", object:id})`
  before throwing, **only** when `shadowExecutionGuardActive && activeTurnRecorder`.
- `src/core/world.ts`: guarded sequenced-call preamble lookups translate
  pre-recording `E_OBJNF` into the same lifecycle `E_NEED_STATE`, so a missing
  scope/actor object does not escape as "fresh turn produced no recording".
- `src/core/shadow-turn-call.ts`: `runShadowTurnCallOnWorldTranscript` arms the
  flag only in guarded mode (`allowed_atom_hashes` present) and clears it in a
  `finally` (never leaks to a later authoritative run; never swallows the
  propagating `E_NEED_STATE`).
- `src/core/shadow-turn-exec.ts`: lifecycle cell-page repair materializes the
  full object closure (lineage/live, own property cells, own verb cells,
  inherited property definition pages) and grants read/write atom coverage for
  those installed cells. This prevents reduced-key repair from stalling one cell
  at a time.
- A thrown in-run `E_NEED_STATE` reaches `transcript.error` via
  `withTurnRecording`'s catch → `turn_finish{ok:false,error}` →
  `effectTranscriptFromRecordedTurn` → `missingAtomsFromNeedStateTranscript`.
  (Spec calls this recorder event `outcome`; the code calls it `turn_finish` —
  equivalent wiring.)

Verified: garden-probe passes with three cases. CASE B now uses a genuinely
reduced key and sparse destination subtree; it repairs in three bounded rounds
(`the_garden`, `exit_garden_north`, `exit_garden_south`), has no silent E_OBJNF,
the executor frame enters `the_garden`, and the repaired turn commits under an
explicit `#placement` transaction scope. CASE C proves a preamble miss returns
structured `missing_state` instead of a raw E_OBJNF/no-recording throw.

## The §VTN8.1 boundary, made exact by the fix

After VTN10.1 heals materialization and cell-page repair carries the current
property versions, MV-A gives the commit plane the missing concurrency token:
the transaction scope's head. The in-process harness now commits the repaired
deck->garden move under `#placement`; without the explicit fence, the same
cross-scope submit is rejected before it can publish unfenced placement writes.
The production boundary that remains is **wire-in**, not core validation:
non-browser submissions still need to choose/open the placement transaction
scope when a fresh execution reveals movement writes.

## Non-browser guarded intent seam

The durable intent path no longer executes default server-assisted intents
through the authoritative relay fast path. It builds a static `TurnKey` from
the call's routing/acceptance atoms and runs it through the normal exec-request
path with the atom guard active. To avoid turning every complete-slice turn into
a repair round, the relay executor pre-authorizes the atoms represented by the
serialized slice it actually materializes; absent referenced objects still
surface as lifecycle `missing_state`.

Two subtleties are now pinned by tests:

- Negative materialized cells (for example an inherited verb lookup that misses
  on an intermediate class) can be granted by cell-page repair; they are real
  absence facts for cells on objects the slice has.
- A read lifecycle atom for an object absent from the anchor cannot be granted
  without pages. Cell-page transfer filters that atom out and the network
  returns `missing_state` to the caller. Write lifecycle atoms remain grantable
  for object creation, where the new object is absent from pre-turn state by
  design.

## Remaining sequence (in order)

1. **MV-A production selector.** The core transaction boundary and planned-exec
   seam exist; the next production step is to decide and enable the placement
   authority selector for non-browser submissions, then carry that accepted
   transaction scope through user-visible frame/fanout routing.
2. **Non-browser executor path completion.** The default intent envelope now
   uses guarded execution and outer authority repair, but production movement
   still needs the transaction selector above before the deck->garden class of
   moves can be considered fixed end-to-end.
3. **Fanout (P2).** Build the §VTN12 audience session-table delivery path; remove
   Directory `current_location` as the hot-path delivery key for movement
   observations (`subscriber_shards: 0` is the symptom the audience table was
   specified but never built).

## Artifacts

- `tests/scope-executor-garden-probe.test.ts` — CASE A (multi-scope proof) +
  CASE B (VTN10.1 recovery + MV-A commit acceptance).
- `tests/shadow-placement-transaction.test.ts` — MV-A stale-head contention and
  missing-fence rejection tests.
- `spec/protocol/v2-turn-network.md` §VTN8.1, §VTN10.1.
- `src/core/world.ts`, `src/core/shadow-turn-call.ts` — the VTN10.1 fix.
- `src/core/executor.ts` — planned-exec transaction-scope seam and
  missing-state authority retry.
- `src/core/shadow-browser-node.ts`, `src/core/turn-key.ts` — static intent key
  plus guarded default relay executor.
