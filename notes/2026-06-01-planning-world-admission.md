# 2026-06-01 — PlanningWorld admission gate (tighten the architecture)

Origin: the cross-scope `who` name regression (`tests/worker/cf-repository.test.ts`)
turned out to be a *class* of bug — stale `name=id` presentation stubs leaking into
the world the VM plans against. Three independent layers all expressed the same
defect (see `2026-06-01-a4-regression-stop.md`, passes 5–7). The directive: stop
patching symptoms; make the bad state structurally *unrepresentable*.

## The invariant (target)

> Only provenance-checked, admissible cells may enter the world the Tiny VM
> plans/executes against. A presentation stub (e.g. `name === id`) is never an
> admissible planning cell. A missing cell stays missing (→ `E_NEED_STATE`), it is
> never synthesized to keep going.

This is the VTN0 coherence invariant pushed down to the executable representation:
"a derived copy is never a write-authority source" becomes a property of the *type
system + one admission gate*, not of scattered merge call-sites.

## Architecture (user-directed, 2026-06-01)

1. **Type the planning input.** The VM boundary must not accept an arbitrary
   `SerializedWorld`. Introduce (at minimum a brand):
   - `PresentationWorld` — may contain id/name stubs, degraded display data.
   - `PlanningWorld` — only admissible cells, each carrying provenance.
   - `AuthoritativeWorld` — owner execution/commit authority.
   Minimum viable: `type PlanningWorld = Brand<SerializedWorld, "PlanningWorld">` plus
   a parallel `pageProvenance: Map<cellKey, AuthorityPageProvenance>` (provenance is
   currently DROPPED when `serializedWorldFromAuthoritySlice` flattens a cell slice
   to a bare `SerializedWorld`). Only the admission gate may brand.

2. **One admission point.** All local planning materialization goes through one
   function:
   ```
   buildPlanningWorld({ authoritativePages, projectionPages, checkpointPages, presentationStubs })
   ```
   Rules:
   - authoritative page → admissible, may overwrite the matching cell.
   - projection page → admissible only with `source` (+ `source_head`/coverage where applicable).
   - cache/checkpoint page → admissible only if coverage proves freshness.
   - presentation stub → NEVER admissible as a planning cell.
   - missing cell → stays missing.
   No other code path may `objects.push(...)` / `objectsById.set(...)` into a planning world.

3. **Miss is the default.** A VM read of an absent cell becomes structured
   `E_NEED_STATE { missing_atoms }`. The `submitTurnIntent` retry loop then (1)
   repairs from the owner/retained page source, (2) retries with an admissible
   world, or (3) delegates / fails over budget. It must NEVER synthesize a planning
   object to keep going. (The miss→repair machinery already exists — see surface map
   §5 — the work is to remove the synthesis escape hatches that pre-empt it.)

4. **Tests assert the boundary, not just the bug.** Keep the `who` symptom test; add
   invariant tests for the whole class:
   - a `name=id` stub cannot satisfy an `object_lineage` read;
   - a projection page can FILL an absent planning cell;
   - a projection page cannot OVERWRITE authoritative state;
   - a newer admissible projection repairs an older projection only if provenance rules allow;
   - first-open relay after fanout cannot seed planning with presentation stubs;
   - every planning-world cell has provenance/coverage or is rejected pre-VM.

5. **CI gate.** `assertPlanningWorldAdmissible(world)` run in worker tests +
   authority gates, rejecting: lineage cells with no provenance; `name===id` stubs
   used as planning lineage unless actually authoritative; projection/cache cells
   lacking `source_head`; contents/presence cells with unknown coverage; any object
   minted by a known presentation-stub constructor.

## Mapped surface (Explore, 2026-06-01)

**The ONE narrow VM boundary:**
- `runShadowTurnCallTranscript(serializedBefore: SerializedWorld, call, options)` —
  `src/core/shadow-turn-call.ts:61` → calls `createWorldFromSerialized`
  (`src/core/bootstrap.ts:525`). This is the single ingress for planning-phase VM
  execution. Selected by `submitTurnIntent` (`src/core/executor.ts:468`) via
  `options.clientSerialized(client)`.
- Read-only twin: `validateTranscriptAgainstSerializedWorld`
  (`src/core/effect-transcript.ts:257`).

**Planning-world construction (must route through `buildPlanningWorld`):**
- `serializedWorldFromAuthoritySlice` (`authority-slice.ts:82`) — slice→world; **drops provenance** (the key leak).
- `combineSerializedAuthoritySlices` (`authority-slice.ts:131`) — slice merge; last-slice-wins by page_ref key (root of layer 3).
- `mergeSerializedAuthoritySlice` / `mergeAuthorityCellPages` (`authority-slice.ts`) — in-place merge; now provenance-aware for object_lineage/object_live (layer-1 fix landed).
- `serializedFor` / `serializedWorldFromCommitScopeState` (`shadow-commit-scope.ts:332/974`).
- `mcpGatewayShardSerializedWorld` / `mcpGatewayStubObject` (`persistent-object-do.ts:6532/6639`) — **presentation-stub constructors** (`name = displayName ?? actor`, `name = scope`).
- `ensureInternalActor` (`persistent-object-do.ts:3775`) — `createObject({name: actor})` stub.

**Provenance plumbing (exists):** `AuthorityPageProvenance` / `AuthorityPageSource`
(`shadow-state-pages.ts:76/78`), `stampAuthorityPageRef`, `withAuthorityPageProvenance`,
and the newly-added `ShadowCommitScope.cellProvenance` + `cellProvenanceFromAuthoritySlice`
(`authority-slice.ts`). Dropped at `serializedWorldFromAuthoritySlice` and `serializedFor`.

**Miss path (exists):** raise at `shadow-turn-call.ts:170` / `tiny-vm.ts:743`; reply
shape at `shadow-turn-exec.ts:1369`; repair loop `executor.ts:450–573`
(`executorObjectIdsFromMissingState` → `authorityPayload(scope, repairIds)` → retry).

**Guards/gates:** `scripts/guard-*.mjs` (run by `npm run test:guards`); add the new
admissibility guard to the worker lane (`npm run test:worker`) and `gate:authority`.

## How the three `who`-bug layers map onto this

- **Layer 1** (merge refusal, FIXED): the merge now ranks provenance for
  lineage/live cells — a property `buildPlanningWorld` will own.
- **Layer 2** (Directory null-overwrite of `display_name`, FIXED): hardening; keep.
- **Layer 3** (combine last-wins picks the stale `name=id` page): a presentation
  stub is winning admission. Under the new architecture it is **inadmissible** —
  `buildPlanningWorld` rejects a `name===id` lineage page when a named
  projection/authoritative page exists, and the gate fails if one slips through.
  This is the structural fix that subsumes the layer-3 patch.

## Phased plan (ratchet, like A1/gate:authority — never hard-break 260 tests at once)

- **P1 — provenance-carrying PlanningWorld + gate in DISCOVERY mode.** Add the
  `PlanningWorld` brand + `pageProvenance` side-channel; write
  `assertPlanningWorldAdmissible` that COLLECTS violations (no throw) and a
  KNOWN_ADMISSION_DEBT allow-list seeded from the current surface. Run it at the
  `runShadowTurnCallTranscript` boundary. Inventory the real violation set.
- **P2 — single admission point.** Introduce `buildPlanningWorld(...)`; route
  `serializedWorldFromAuthoritySlice` + the gateway/commit-scope materializations
  through it; stop dropping provenance. Drive the layer-3 case (stale lineage page)
  out — the `who` test goes green here.
- **P3 — brand enforcement + miss-is-default.** `runShadowTurnCallTranscript`
  accepts only `PlanningWorld`; remove synthesis escape hatches so an absent cell
  yields `E_NEED_STATE` (repair loop already consumes it). Shrink the allow-list.
- **P4 — boundary invariant tests + flip the gate to hard-fail.** Allow-list empties;
  `assertPlanningWorldAdmissible` throws. Run `test:worker` + `gate:authority`; align
  spec (VTN0 / projection-cache PC / CA admissibility).

Same rule as the A-sequence: the allow-list may only SHRINK; every step keeps
`npm test` + `gate:authority` green; worker-shape changes MUST run `npm run test:worker`.

## Current worktree state (uncommitted)
- Layer-1 provenance retrofit: `authority-slice.ts`, `executor.ts`,
  `shadow-commit-scope.ts`, `mcp/gateway.ts`, `worker/commit-scope-do.ts`.
- Layer-2 Directory preserve: `directory-do.ts`.
- typecheck 0; `npm test` 260/260. `who` test still red (layer 3 → P2). All probes reverted.

## Update (2026-06-01 — review findings addressed; P3 runtime wiring in discovery mode)

Reviewer findings on the landed fix, both addressed:

**Finding 1 (merge asymmetry) — FIXED.** `mergeAuthorityCellPages` handled only the
repair direction (current stub → incoming named) and `authorityPageMayReplaceCurrent`
used `>=`, so an equal-rank projection *stub* could overwrite a named lineage. Added
the symmetric inverse guard: a non-authoritative incoming `object_lineage` page whose
`name===id` never displaces a named current cell. Now symmetric with the combine
tiebreak. Tests: tests/authority-slice-shape.test.ts +2 (stub-incoming refused;
named repairs unknown-provenance stub).

**Finding 2 (gate was test-only) — runtime wiring landed (discovery mode).**
`assertPlanningWorldAdmissible`/`collectPlanningWorldViolations` now RUN at the VM
boundary: `runShadowTurnCallTranscript` takes optional `planningProvenance` +
`onAdmissionViolation`; `submitTurnIntent` threads `clientPlanningProvenance`; the MCP
gateway supplies `client.relay.commit_scope.cellProvenance` and logs violations
(`woo.planning_world_inadmissible`). So the gate is no longer test-only — it observes
real planning.

Discovery findings:
- The stub rule had a false-positive class: `$`-prefixed substrate refs (system
  singletons, catalog classes) are named by their ref by convention, so `name===id`
  there is legitimate. Refined `isStubLineage` to exclude the `$` namespace (a
  convention-level check, not a per-object branch — layering-clean). After this,
  the worker lane reports ZERO admission violations.
- Attempting to ENFORCE (throw on `presentation_stub_lineage`) failed 1 worker test
  + gate:authority, even though the discovery pass was clean — because a stub
  admission is TRANSIENT (shard-ordering dependent) and REPAIRABLE: the
  submitTurnIntent retry loop refreshes authority and re-plans. A hard throw at the
  boundary pre-empts that repair and converts a repairable transient into a failure.

**Therefore P4 enforcement requirement (now explicit and required, per the reviewer):**
inadmissibility must drive REPAIR (treated like `E_NEED_STATE`: refresh authority,
retry), NOT a hard fail. Enforcement = route `presentation_stub_lineage` through the
repair loop, then flip; `missing_provenance` enforcement waits on universal per-cell
provenance coverage across all seed/snapshot paths. Until P4, the invariant is
OBSERVED at runtime (discovery) but not yet CONTINUALLY ENFORCED — stated plainly.

Gates (discovery mode): typecheck 0 · npm test 267/267 · cf-repository 63/63 ·
test:worker 202 passed/5 skipped · gate:authority 2/2 · planning-world 8/8 ·
authority-slice-shape 12/12.

## Update (2026-06-01 — P4 COMPLETE: runtime enforcement is repair-driven and live)

Enforcement landed, and crucially NOT as a hard fail (which the discovery pass proved
breaks repairable transients). The VM boundary `runShadowTurnCallTranscript`, when a
caller threads `planningProvenance`, now:
- reports every admission violation (observability), and
- for a `presentation_stub_lineage`, RAISES a repairable `E_NEED_STATE` naming the
  stubbed object BEFORE the VM runs. The `submitTurnIntent` repair loop extracts the
  id (`cell:lifecycle:<id>` preimage), refreshes that object's authority, and
  re-plans against the named identity. Only a stub surviving the bounded repair
  retry fails the turn (correct loud signal). `missing_provenance` stays non-fatal
  (reported) until universal per-cell provenance coverage.

Why repair-driven, not hard-fail: a hard throw failed test:worker + gate:authority
on a transient (shard-ordering) stub admission, because the throw pre-empted the
retry that would have repaired it. Routing through `E_NEED_STATE` makes the
transient self-heal while a genuine unresolvable identity still fails loudly.

Validation:
- Deterministic proof: tests/planning-world.test.ts +2 — a stub planning world makes
  the boundary raise E_NEED_STATE naming the object; no-provenance threading is inert.
- Stress: cf-repository who 6×, gate:authority 8×, all green under enforcement
  (where the hard-throw variant had failed). test:worker 202 passed/5 skipped.
- Spec: cell-authority CA11 now states boundary enforcement is repair-driven, the
  missing_provenance non-fatal carve-out, and the `$`-namespace exclusion.

Gates: typecheck 0 · npm test 270/270 · cf-repository 63/63 · test:worker 202/5-skip ·
gate:authority 2/2 (×8) · planning-world 10/10 · authority-slice-shape 12/12.

### Status of the architecture (P1–P4)
- P1 (gate module + invariant tests) — DONE.
- P2 (provenance carried through combine/merge/seed; layer-3 fixed) — DONE.
- P3 (runtime wiring at the boundary; provenance threaded gateway→submitTurnIntent→
  boundary) — DONE for the gateway planning path.
- P4 (repair-driven enforcement + CI + spec) — DONE for the gateway planning path:
  `presentation_stub_lineage` enters the repair loop as `E_NEED_STATE`; the residual
  unrepairable stub hard-fails. This is the step "enter the repair loop like
  E_NEED_STATE, then the gate can flip to hard-fail" — landed in `867bfa1`.

### The regression-fixed bar is met; the continual-guarantee bar is NOT yet
Enforcement is real but **path-scoped**: it fires only where a caller threads
`planningProvenance` (today: the gateway planning pass via `submitTurnIntent`). It is
therefore NOT yet a universal/permanent invariant gate. Per review direction this is
**Phase-A hardening** — required before leaning on the gate as a continual guarantee,
and an explicit prerequisite before Phase B (B6–B10) builds on top of it. No Phase-A
redesign and no Phase-B reordering; only this prerequisite is made explicit:

> Phase B MUST NOT start on top of discovery-only / path-scoped admission. Before
> B6/B7/B8, the PlanningWorld admission-violation path must drive repair/retry (DONE
> on the gateway path) AND the boundary must be enforceable across every VM-execution
> entry point (REMAINING below).

Phase-A hardening backlog (close before relying on the gate permanently):
1. **Coverage**: thread `planningProvenance` into every VM-execution entry point, not
   just the gateway planning pass — the CommitScopeDO's own execution, REST, and the
   browser node. Until then the gate is blind on those paths.
2. **Compile-time brand**: `runShadowTurnCallTranscript(world: PlanningWorld)` + a
   single `buildPlanningWorld` constructor, so no path can pass a raw `SerializedWorld`
   (turns "threaded everywhere" from a convention into a type guarantee).
3. **`missing_provenance` → fatal** once every seed/snapshot path records per-cell
   provenance. Today only the relay merge/seed paths do, so the non-stub coverage
   rule stays observe-only to avoid false rejects of untagged-but-valid cold cells.

## Update (2026-06-01 — review P1/P2 + hardening #9/#10 done; #11 mechanism done, flip coverage-gated)

Review items fixed:
- P1: stub-ness is now classified independently of provenance — an unprovenanced
  `name===id` (non-`$`) lineage is `presentation_stub_lineage` (enters repair), not
  demoted to non-fatal missing_provenance.
- P2: submitTurnIntent enforcement depends ONLY on planningProvenance;
  onAdmissionViolation is independent optional observability.

#9 + #10 (brand + coverage) — DONE:
- `runShadowTurnCallTranscript`/`runShadowTurnCall` accept ONLY a branded
  `PlanningWorld`; the sole producers are `buildPlanningWorld` (gated) and
  `authoritativePlanningWorld` (owner/local; untagged cells trusted via
  defaultProvenanceSource). `markPlanningWorld` is module-private. No path can run the
  VM against a raw SerializedWorld — a type-level guarantee.
- Every serialized→VM caller routed: gateway planning (gated + repair loop), browser
  holder planning (gated, stub-only), client local turn + REST in-process
  (authoritative), all test call sites (authoritative). CommitScopeDO execution runs
  on a pre-built world; its authority ENTERS via refreshSessionAuth's provenance-aware
  merge (stub-repair), so it is enforced at the merge layer.
- Stub rule (the bug class) is now fatal-by-repair on EVERY gated path.

#11 (missing_provenance → fatal) — MECHANISM DONE; flip COVERAGE-GATED (off):
- `buildPlanningWorld({ enforceMissingProvenance })` + a `submitTurnIntent` /
  gateway pass-through implement the flip per-path. Default OFF.
- Enabling it empirically proved universal coverage is NOT yet achieved:
  * browser holder relay records no per-cell provenance (materializes from accepted
    frames, not a provenance-bearing merge) — 22 browser tests would reject;
  * the 4-shard `cf-local-walkthrough` surfaces a tracked cell whose provenance is
    not recorded by every seed/fanout source even after repair — gate:authority would
    reject.
- Therefore the flip stays OFF (per the task's own "after universal coverage"
  condition). The remaining coverage work (the prerequisite to flip #11 on):
  1. Record per-cell provenance on the browser relay's frame/seed materialization.
  2. Close the cross-shard seed/fanout provenance-recording gap the walkthrough
     surfaces (a tracked cell reaching a gateway plan untagged).
  Once both land, flip by setting `enforceMissingProvenance: true` on the gateway
  submitTurnIntent (and browser) — no other change.

Gates: typecheck 0 · npm test 274/274 · test:worker 202 passed/5 skipped ·
gate:authority 2/2 · planning-world 14/14 · authority-slice-shape 12/12.
(Pre-existing test:full failures unrelated to this work — stale analyzer metric-kind
list + dev-server materialization — predate session start 82b4148.)
