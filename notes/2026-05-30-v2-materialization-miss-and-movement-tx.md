# 2026-05-30 — v2 materialization-miss + movement-as-transaction

> **PARTIALLY SUPERSEDED (2026-05-31).** The **VTN10.1 materialization-miss**
> work below is still valid and landed. The **MV-A / `#placement` movement**
> portions are **withdrawn** — `#placement` had no durable snapshot and broke
> prod, and more fundamentally it kept room membership as one shared cell.
> Movement is replaced by `spec/protocol/cell-authority.md` (location-as-truth,
> per-member contents projection); see
> `notes/2026-05-30-cell-authority-convergence.md` and the remediation plan in
> `notes/2026-05-31-cell-authority-perf-plan.md`. Read the `#placement` sections
> here as historical record only.

Origin: the cross-actor MCP smoke `the_garden` `E_OBJNF` failure, traced to a
real invariant hole in the v2 sparse-executor / missing_state repair loop. This
note records the proof, the spec decisions, what has landed on main, and the
remaining sequence. It is a work description, not normative — the normative text
is in `spec/protocol/v2-turn-network.md` §VTN8.1 and §VTN10.1.

## Status (main after `6d6f2b5`)

- **DONE & verified:** §VTN8.1 + §VTN10.1 spec text; the materialization-miss
  fix; the regression tests. This is a correctness checkpoint and measurement
  deploy candidate, not the final placement architecture.
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
- **DONE as production-shaped wiring:** MCP and REST non-browser durable
  movement paths use planned-exec, route placement-bearing transcripts through
  the deployment-local `#placement` commit scope, and carry the accepted
  placement fence so cross-scope fanout/apply rejects unfenced movement.
- **CURRENT LIMIT:** `#placement` is intentionally one global movement
  authority. It is the simplest correct MV-A prototype and a useful measurement
  checkpoint, but it is not the scalable end-state.
- **NEXT:** measure the global `#placement` path in the deployed smoke, then
  tighten §VTN12 live delivery and implement the overlap-preserving sharded
  placement plan below only if the global authority becomes a measured limit.

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
The production-shaped MCP and REST paths now choose/open that transaction scope
after fresh execution reveals movement writes. The remaining boundary is scale
and live delivery: `#placement` serializes correctly, but deliberately serializes
all movement through one authority while §VTN12 delivery is still converging.

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
  absence facts for cells on objects the slice has. Repair now grants the
  negative lookup atoms for the inherited lookup path in one transfer, rather
  than spending one transfer round per ancestor before feature verbs can run.
- A read lifecycle atom for an object absent from the anchor cannot be granted
  without pages. Cell-page transfer filters that atom out and the network
  returns `missing_state` to the caller. Write lifecycle atoms remain grantable
  for object creation, where the new object is absent from pre-turn state by
  design.

MCP guarded intents also use fresh envelope ids for authority-repair retries.
Without that, CommitScopeDO's idempotency cache replays the first
`missing_state` reply and the caller never observes the repaired authority.
Guarded intent execution has a larger but still bounded in-process state
transfer budget than browser planned-exec, because it starts from a static call
key and discovers catalog dispatch/properties while it runs.

## MCP accepted-frame audience delivery

Accepted-frame fanout now carries the computed session/actor audience in the
fanout body and returns the same audience to the origin gateway's local
accepted-frame router. Receiving MCP shards route by explicit session id first,
so a peer session still receives movement observations when its local
`session.activeScope` is briefly stale. The CF regression test forces that
stale local state and asserts both the fanout body audience and the queued
`entered` observation.

## Remaining sequence (in order)

1. **Measurement deploy readout.** Use the deployed smoke to measure
   `#placement` open/envelope CPU, queueing, stale-head retry rate, repair
   attempts, commit rejection reasons, and movement fanout delivery. Do not
   infer scalability from local tests alone.
2. **Fanout follow-through.** MCP accepted-frame routing now uses explicit
   session audiences, but full §VTN12 convergence still needs the browser/live
   socket side and any remaining Directory-backed audience selection tightened.
3. **Placement overlap sharding.** Keep global `#placement` until metrics justify
   sharding. When they do, implement the overlap-preserving plan below. Do not
   replace `#placement` with a naive hash of the moved actor, source, or
   destination; those selectors lose the required overlap property.

## Placement overlap/shard implementation plan

### Non-negotiable invariant

For every placement transaction, define its placement cells as:

- every moved object's `location` cell;
- every source room `contents` cell;
- every destination room `contents` cell;
- movement-coupled presence cells such as `subscribers` and
  `session_subscribers` when the transcript writes them.

Any two accepted placement transactions that touch at least one identical
placement cell MUST be serialized by a common authority/fence before either
commit is published. A conflict must surface as a retryable `stale_head` /
prepared-transaction conflict, never as a successful independent commit that can
drop a room membership.

This makes several tempting shard selectors invalid:

- shard by moved object: two actors entering the same destination do not share a
  moved object, but they do share `contents:destination`;
- shard by destination: two actors leaving the same source for different
  destinations share `contents:source`;
- shard by source: two actors entering the same destination from different
  sources share `contents:destination`;
- shard by unordered `(source,destination)` pair: transactions `A->B` and
  `B->C` share `contents:B` but would route to different pair shards.

A single-shard selector that preserves arbitrary endpoint overlap degenerates
to connected placement components. That is safe, but in a connected world it is
equivalent to global `#placement`. Real sharding therefore needs either
component authorities with explicit component-merge semantics, or a
multi-participant transaction protocol over per-cell/bucket authorities.

### Chosen direction

Use a staged path:

1. Keep global `#placement` as the deployed correctness baseline.
2. Add a selector abstraction while it still returns global `#placement`.
3. Add a multi-participant placement transaction model behind a feature flag.
4. Only then shard placement cells into participant buckets.

This avoids a hidden correctness regression while letting the code and spec move
toward a scalable authority layout.

### Phase 0 — instrument the global authority

Add or confirm metrics on every placement-bearing submit:

- `placement_tx` with transaction id, scope, cell count, moved object count,
  source count, destination count, presence-cell count, attempt, and accepted /
  conflict status;
- `placement_tx_latency` split by open, plan, repair, envelope, commit apply,
  fanout, and projection write;
- `placement_tx_conflict` with `stale_head`, `write_fence_missing`,
  `read_version_mismatch`, and retry-exhausted buckets;
- `placement_tx_queue` / DO overload indicators for `#placement`;
- p50/p95/max for `#placement` `/v2/open` and `/v2/envelope`.

Exit criteria before sharding work starts: at least one smoke/tail run shows
`#placement` is a material cost or contention source. If it is not, spend the
next engineering cycle on §VTN12 and gateway authority assembly instead.

### Phase 1 — selector abstraction, no behavior change

Introduce a transport-neutral selector:

```ts
type PlacementAuthorityPlan =
  | { mode: "single"; scope: ObjRef }
  | { mode: "participants"; coordinator: ObjRef; participants: PlacementParticipant[] };
```

For now:

- `selectPlacementAuthority(transaction)` always returns
  `{ mode: "single", scope: "#placement" }`;
- MCP/REST planned-exec and in-process executor paths call the selector instead
  of directly referencing `SHADOW_PLACEMENT_TRANSACTION_SCOPE`;
- accepted commits continue to carry the exact transaction cells;
- tests assert the selector is invoked after fresh execution, not before, so it
  sees the actual placement write set.

This phase is a refactor only. Any behavior change here is a bug.

### Phase 2 — spec the participant transaction shape

Extend §VTN8.1 before implementation:

- current single-authority `#placement` remains valid;
- a participant transaction carries:
  - a stable transaction id;
  - the complete placement cell list;
  - the participant bucket for each cell;
  - the expected head/version for each participant bucket;
  - the accepted participant positions after commit;
- receivers reject cross-scope apply if any required placement cell is absent
  from the transaction or if participant evidence is incomplete.

Keep `TurnKey.scope` as the execution scope. Placement authority remains a
post-execution commit decision because the complete write set is known only
after the VM runs and repair converges.

### Phase 3 — participant bucket model

Map each placement cell key to a bucket:

```text
bucket = #placement-bucket:<stable-hash(cellKey) % N>
```

The bucket, not the room or actor, owns the serialization fence for that cell.
Transactions touching multiple placement cells therefore touch multiple buckets.
This preserves overlap because two transactions sharing a cell always share that
cell's bucket. Hash collisions only over-serialize, which is safe.

Start with a small fixed `N` behind configuration. Do not change `N` without a
migration plan; bucket id is part of the durable authority identity.

### Phase 4 — durable coordinator protocol

Implement participant mode as a real transaction protocol, not best-effort
multi-apply:

1. Coordinator receives the fully planned transcript and placement transaction.
2. Coordinator computes participant buckets and writes a durable coordinator row
   with status `preparing`, transcript hash, placement cells, and participant
   list.
3. Coordinator sends `prepare(txn)` to participants in sorted bucket order.
4. Each participant validates its expected head and the subset of cells it owns,
   then records a durable prepared row with expiry and returns a reservation.
5. If any participant rejects, coordinator sends `abort(txn)` to prepared
   participants and returns a retryable conflict.
6. After all prepare responses are present, coordinator marks the transaction
   `committing`.
7. Coordinator sends `commit(txn)` to every participant. Participants advance
   their bucket heads exactly once for that transaction id and record the
   participant accepted position idempotently.
8. Coordinator records `accepted` only after all participant commits are durable,
   then publishes the accepted frame/fanout/projection.
9. Recovery on coordinator restart resumes `preparing` / `committing`
   transactions from durable rows. Prepared participant rows expire only if the
   coordinator never entered `committing`; once `committing`, recovery must
   finish commit, not abort.

No accepted frame is emitted until all participant commits are durable. That is
the line that prevents partial movement publication.

### Phase 5 — apply/fanout compatibility

Accepted frames must remain consumable by existing clients:

- single-authority commits carry the current `position` and `transaction`;
- participant commits carry a coordinator `position` plus participant positions;
- `shadowCommitTransactionCoversTranscript` grows a participant-aware check;
- gateway projection cache and browser holder install use the accepted frame's
  transaction evidence, not the current host's local guess;
- fanout audience remains transcript-derived and does not route by placement
  bucket.

The live plane should not depend on where the movement transaction committed.
That keeps §VTN12 separable from placement sharding.

### Phase 6 — rollout and migration

Roll out in one-way guarded stages:

1. Ship selector abstraction returning global `#placement`.
2. Ship participant schema and no-op read paths while writes still use
   `#placement`.
3. Enable participant mode in local/dev only; run contention and smoke suites.
4. Enable participant mode for a small test world or admin-only token class.
5. Enable participant mode for production with a kill switch that returns the
   selector to global `#placement`.

Do not attempt to migrate historical `#placement` accepted frames. They remain
valid under the single-authority transaction shape. New participant frames start
at participant bucket seq 1 and carry their own evidence. Replay/apply code must
accept both shapes.

### Phase 7 — required tests

Tests must fail under naive sharding:

- two actors enter the same destination from different sources concurrently;
- two actors leave the same source for different destinations concurrently;
- one actor receives two concurrent movement plans through different exits;
- `A->B` and `B->C` overlap on `contents:B` and serialize;
- participant prepare conflict aborts all prepared participants with no accepted
  frame;
- coordinator crash after prepare but before commit recovers by aborting;
- coordinator crash after marking `committing` recovers by finishing commit;
- duplicate commit messages to participants are idempotent;
- cross-scope apply rejects participant frames missing a required cell;
- browser, MCP, and REST all consume both single-authority and participant
  accepted frames.

Cloud-shaped tests must include Durable Object re-instantiation between prepare
and commit to prove recovery is durable, not just in-memory.

### Phase 8 — deployment acceptance

Participant sharding is deployable only when:

- full local suite and local smoke pass;
- CF smoke is at least as stable as global `#placement`;
- no partial movement frame can be observed in forced-crash tests;
- `placement_tx_conflict` conflicts are retryable and bounded;
- p95 movement latency improves or `#placement` queue/overload pressure is
  eliminated enough to justify the added protocol complexity.

If the metrics do not justify that complexity, keep global `#placement` and
spend the next work on live delivery and gateway authority removal.

## Artifacts

- `tests/scope-executor-garden-probe.test.ts` — CASE A (multi-scope proof) +
  CASE B (VTN10.1 recovery + MV-A commit acceptance).
- `tests/shadow-placement-transaction.test.ts` — MV-A stale-head contention and
  missing-fence rejection tests.
- `spec/protocol/v2-turn-network.md` §VTN8.1, §VTN10.1.
- `src/core/world.ts`, `src/core/shadow-turn-call.ts` — the VTN10.1 fix.
- `src/core/executor.ts` — planned-exec transaction-scope seam and
  missing-state authority retry.
- `src/mcp/gateway.ts`, `src/worker/persistent-object-do.ts` — production-shaped
  MCP/REST planned-exec wiring through `#placement`.
- `src/core/shadow-browser-node.ts`, `src/core/turn-key.ts` — static intent key
  plus guarded default relay executor.
- `tests/mcp.test.ts`, `tests/worker/cf-repository.test.ts` — explicit
  session-audience accepted-frame routing, including stale receiving-shard
  session state.
