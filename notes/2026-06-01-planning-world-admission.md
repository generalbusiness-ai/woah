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
