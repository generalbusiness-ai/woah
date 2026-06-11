# State legibility and stable iteration — the epoch plan

Origin: 2026-06-11, after the deploy-cycle retrospective. Successor to
[2026-06-09-cf-cross-scope-architecture-plan.md](2026-06-09-cf-cross-scope-architecture-plan.md)
(whose tracks landed: lanes at 13/13 incl. cross-room carry, deployed happy
path 17–35s → 2–8s, repair cascade → bounded error). What repeatedly did NOT
land is **deployed convergence**, and the failure record is uniform enough to
be a diagnosis.

## Diagnosis: divergence among unmanaged copies of state

Every change of the past two weeks that failed in production failed the same
way: it updated one copy of the world's state and production diverged in a
copy outside the model. The same logical world exists in ~seven
materializations — world-host world, per-scope CommitScopeDO worlds
(snapshot + tail), gateway sparse worlds, gateway SQL projection cache,
relay caches, KV host seeds, browser relay/IDB — and nothing states which
copies exist, what updates each, and what bounds their divergence. The
terminal example: catalog repairs and bootstrap migrations update the
world-host world only; CommitScopeDO scope worlds stay frozen at their
snapshot epoch, and the repair loop cannot reconcile them because conflict
replies repair the planner, never the commit scope's own durable state
(2026-06-11 analysis, reproducible with one wizard `look`).

Compounding factors:
- **Repair-as-diagnosis**: all divergences present identically (loops,
  budgets, timeouts); which invariant broke is archaeology.
- **Lanes test freshness; production is aged**: the missing fidelity
  dimension is time, not network realism.

## The plan

### E1. Epoch discipline (the core; first deliverable = CommitScopeDO stamp)
Every durable artifact carries the epoch of the inputs that produced it;
every consumer checks the stamp; mismatch is a NAMED, SELF-HEALING event
(the existing reseed flows), never silent divergence.

- **E1.1 (now): catalog-stamp CommitScopeDO snapshots/checkpoints.**
  `bundledCatalogEpoch()` = stable hash of the bundled catalog manifests
  (build-time constant — catalog changes ship with deploys, so a code-level
  hash is the correct epoch). Persist it with the scope snapshot/checkpoint;
  on open/rehydrate, missing or mismatched stamp ⇒ the existing
  `E_SNAPSHOT_REQUIRED` reseed + full-body retry. Scope COMMIT HISTORY is
  preserved; the rebuilt serialized state starts a new head epoch (the
  `ScopeHead.epoch` field exists for exactly this). Old prod snapshots have
  no stamp ⇒ every aged scope DO self-heals on first touch after deploy —
  this fix IS the deployed-world repair.
- **E1.2: same stamp on KV host seeds** (extends Fix 2's invalidation to a
  pull-side check) **and the gateway SQL projection cache**.
- **E1.3: browser caches** (IDB execution/relay caches already carry version
  fields — verify they include the catalog epoch; D3 hydration work
  consumes this).
- **E1.4: the pre-merge checklist question**: "does this change alter the
  meaning of any persisted artifact? then bump its epoch and write the
  reseed." Add to AGENTS.md before-merge list.

### E2. Named divergence taxonomy
Boundary detection instead of loop exhaustion: commit validation and apply
paths emit distinct codes/metrics — `E_STALE_EPOCH` (scope state predates
catalog epoch), missing-instance, verb-version skew — and the repair loop
retries only what is transient. Two days of deployed archaeology becomes
one tail line.

### E3. The aged-world lane (the gate that catches this class pre-deploy)
Build a world THROUGH history in workerd: install catalogs@N-1, run traffic
so scope DOs/sessions/checkpoints accumulate, upgrade to current bundles,
run the shared scenario. Gate deploys on it. Every deploy-only failure of
the past two weeks would have been caught here. Keep aged fixtures as a
library; a sanitized prod snapshot is a stretch goal.

### E4. Decompose the megafiles along the real seams
`world.ts` (12k lines, 9 hand-invalidated indices) and
`persistent-object-do.ts` are where every fix collides. Seams: scope-state
store (snapshot/checkpoint/tail + epochs), turn pipeline,
projection/relation pipeline, session lifecycle, fanout/delivery. Each
module states its invariants in its header and owns gates for them. This is
also what makes delegated iteration reliable: small modules with named
invariants.

### E5. One write path per fact
Finish the relation-pipeline direction: contents, rosters, audiences as
derived relations off one authoritative event stream (this is what makes
D2a's audience completeness PROVABLE — its re-enable condition).

## Sequencing
1. **E1.1 now** (this branch) → deploy → walkthrough expected 10/10 → full
   metrics capture vs the b7-tail baseline (the program's deferred verdict).
2. E2 + E1.2 next (small, mostly metric/code labeling).
3. E3 the lane (before the next behavior-changing deploy).
4. E4 decomposition incrementally, one seam at a time, each behind the
   existing gate set; E5 rides the projection-seam extraction.
5. E1.3/E1.4 alongside.

## Rules
Unchanged from the prior plan: worktree per task, mechanical gates named in
briefs and unconditional, orchestrator re-verifies the decisive gate,
structural arguments beat passing runs, machine-contention check before
trusting red, foreground agents for long work, commit per milestone.
