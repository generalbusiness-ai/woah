# 2026-05-30 — v2 materialization-miss + movement-as-transaction

Origin: the cross-actor MCP smoke `the_garden` `E_OBJNF` failure, traced to a
real invariant hole in the v2 sparse-executor / missing_state repair loop. This
note records the proof, the spec decisions, what has LANDED on this branch, and
the remaining sequence. It is a work description, not normative — the normative
text is in `spec/protocol/v2-turn-network.md` §VTN8.1 and §VTN10.1.

## Status (this branch: scope-executor-atomguard)

- **DONE & verified:** §VTN8.1 + §VTN10.1 spec text; the materialization-miss
  fix; the regression test. Checkpoint commit follows. **NOT deployed** — it is
  a correctness checkpoint, not a smoke fix (the move still cannot durably
  commit; see §VTN8.1 / MV-A below).
- **NEXT:** MV-A (movement as one fenced placement transaction), then the
  non-browser executor path, then fanout.

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
   substrate behavior, NOT move-specific, NOT catalog-aware. Transitive
   move-target prediction is an optional routing optimization only.

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
- `src/core/shadow-turn-call.ts`: `runShadowTurnCallOnWorldTranscript` arms the
  flag only in guarded mode (`allowed_atom_hashes` present) and clears it in a
  `finally` (never leaks to a later authoritative run; never swallows the
  propagating `E_NEED_STATE`).
- A thrown in-run `E_NEED_STATE` reaches `transcript.error` via
  `withTurnRecording`'s catch → `turn_finish{ok:false,error}` →
  `effectTranscriptFromRecordedTurn` → `missingAtomsFromNeedStateTranscript`.
  (Spec calls this recorder event `outcome`; the code calls it `turn_finish` —
  equivalent wiring.)

Verified: garden-probe 2 passed (CASE B: 1 repair round, transfer preimage
exactly `read:cell:lifecycle:the_garden`, no silent E_OBJNF, executor frame
enters `the_garden`); shadow-turn-exec 25 passed; shadow-browser-node 49 passed
(authoritative path unaffected — flag never leaks); typecheck clean.

## The §VTN8.1 boundary, made exact by the fix

After VTN10.1 heals materialization, the durable commit of the move is
**`commit_rejected`** (NOT `ok`, NOT `missing_state`, NOT silent applied) with
`read/write version mismatch the_garden.* transcript=0 actual=1`: the executor
rebuilt `the_garden`'s freshly-paged cells at version 0 while the anchor holds
them at v1+. This is exactly the cross-scope placement-transaction problem MV-A
addresses. CASE B pins this boundary: it permits `ok` (forward-compatible for
when MV-A lands) but, while not-ok, requires `commit_rejected` — forbidding
regression to `missing_state` or a silent applied frame.

## Remaining sequence (in order)

1. **MV-A in-process.** `the_deck:south` after repair must commit atomically
   over `location:actor`, `contents:the_deck`, `contents:the_garden`, plus
   session/presence placement state — one fenced placement transaction across
   the two room scopes. Add a **contention test**: two actors moving into/out of
   the same destination from stale heads either serialize or get a clean
   retryable conflict, never lost destination membership.
2. **Non-browser executor path.** Make MCP/agent turns execute whole on a
   capable scope/commit executor with guarded materialization repair. Gateway
   stops assembling executable authority; it supplies session/auth/live routing
   only. This is where the perf wall (resolve-object storms, authority-slice
   fan-in) is actually removed.
3. **Fanout (P2).** Build the §VTN12 audience session-table delivery path; remove
   Directory `current_location` as the hot-path delivery key for movement
   observations (`subscriber_shards: 0` is the symptom the audience table was
   specified but never built).

## Artifacts

- `tests/scope-executor-garden-probe.test.ts` — CASE A (multi-scope proof) +
  CASE B (VTN10.1 recovery + VTN8.1 commit boundary).
- `spec/protocol/v2-turn-network.md` §VTN8.1, §VTN10.1.
- `src/core/world.ts`, `src/core/shadow-turn-call.ts` — the VTN10.1 fix.
