# Simplest Deployable System — Stage 3: Decision Ledger

Date: 2026-07-04. Series: see `2026-07-04-simplest-system-00-method.md`.
Evidence pass over prior plans, postmortems, and `git log` on `main` @ `b8e55f9`.

## 3.1 The plan lineage (one continuous program, not competing plans)

**mobile-heap A0-A5/B6-B10 (06-01) → stable-baseline Phases 0-5 (06-09) →
cross-scope A/B/C/D tracks (06-09) → state-epoch E1-E5 (06-11) → Plan 001
functional baseline (06-28)** — each supersedes the previous plan's open front
while keeping its landed base. `spec/protocol/cell-authority.md` is the durable
design artifact; CA16 is its rollout ledger.

## 3.2 Settled decisions (do not re-litigate)

- **Cell-authority is the target model**: location-as-truth,
  contents-as-projection (A4), transcript as sole authority with one applier
  (A2), provenance + content-addressed cells (A3), every non-authority view is
  a content-addressed read-through (A5).
- **Actor-anchored movement is the default** (CA6); room-anchored is a
  deferred opt-in (CA7).
- **Commit scope is chosen by write-set** (B6, landed `791f754`).
- **State transfer is verifiable cache-fill, never write authority** (B7 =
  VTN0 claim 5; warm-fill landed `0f4bedc`/`a452ddd`, closure mode retired).
- **Epoch-stamped self-healing reseed is the convergence mechanism** (E1;
  E1.1 catalog-stamped scope repair epoch landed `6059df8`).
- **Validation regime**: three-lane smoke ladder with one shared scenario;
  curated-gate rule (every new gate must be in `npm test`'s list); deploy
  postflight = walkthrough + tail-metric thresholds (rule adopted after
  `555f9935` shipped on a smoke pass alone).
- **Rejected**: source-only seeds (regressed, reverted); cross-DO 2PC for
  ordinary movement (CA10.2); placement-ownership for room contents (MV-A
  withdrawn); gossip as authoritative.

## 3.3 The genuinely open front

| Item | Status | Why it matters |
|---|---|---|
| **E2** named divergence taxonomy | not done (partial: terminal state-path metric `8da599d`) | every postmortem since 06-14 names it prerequisite to the next state-path deploy |
| **E3** aged-world test lane | not done | "would have caught every deploy-only failure"; agreed gate before further deploys; Plan 001 Step 7 |
| **E4** megafile decomposition (`world.ts` 12.4k, `persistent-object-do.ts` 9.2k) | not done | "where every fix collides" |
| **E5** one write path per fact (relation pipeline) | not done | the re-enable condition for D2a; the class behind deploy-#5's three unmasked failures |
| **B10** delete the checkpoint→catch-up→repair→seed ladder + static routes | **BLOCKED** on B7/B8 prod wiring proof | the completion vision of the whole mobile-heap program — the end-state IS the simple system |
| D3a browser optimism on CF | built, never enabled in any deployed/smoke config; known `sendEncoded()` silent-drop defect | CF browser path unvalidated |
| CA12.1 cell-keyed storage split, CA13 hot-room fanout sharding | deferred behind C4 load-gate tripwire | the scale levers, deliberately parked while contention is low |
| CA14.15 multi-DO harness | acknowledged prerequisite, not built | single-process walkthrough cannot substitute |

## 3.4 Lessons from failed deploys (what escaped each lane)

1. **cf-local is not Cloudflare** — the fake collapses all DOs into one
   process; lineage-propagation failures *cannot manifest* (deploy `c3359e16`).
2. **cf-dev (workerd) passes steps that fail on deploy** — one process, fast
   RPC, local host-seed merge fills lineage; cross-colo/cold-owner timeout is
   a **deploy-only** class until fault injection (C1a seams exist:
   `src/worker/rpc-fault-inject.ts`) is wired into an aged-world lane (E3).
3. **Terminal errors mask divergence** — deploy #5's capsule-head fix
   *unmasked* three pre-existing cross-scope gaps (E_NOSESSION, E_OBJNF,
   E_REPAIR_BUDGET); aborting before commit had been hiding them.
4. **Smoke pass ≠ healthy** — `555f9935` regression shipped without
   tail-metric postflight.
5. **Curated-gate blindness recurs** — `npm test` = 44/195 files; bit A4
   (`who` regression), dev-v2-commit, shadow-browser-node.

## 3.5 Open contradictions the final plan must resolve

1. **B10 deletion vs. flag-field permanence.** The mobile-heap end-state
   deletes the checkpoint/repair/seed ladder; but every later plan *builds on*
   that scaffolding (KV cold seeds, E1 reseed flows, `WOO_V2_*` flags). Nobody
   has decided converge-then-delete vs. keep-as-permanent-substrate. *The
   "simplest system" question is exactly this question.*
2. **Functional-first (Plan 001) vs. convergence-first (E-plan).** Plan 001
   permits a deploy at Step 5 before the E2/E3 gates it names at Step 7; the
   06-16 session-presence verdict says E2+E3 come first. Sequencing conflict.
3. **D2a is both landed and gated on unbuilt E5** — audience-from-projection
   shipped (`25d3987`) then pulled behind a completeness invariant
   (`e573626`) provable only after E5.
4. **cf-dev relied on as gate while documented blind** to the dominant
   deploy-only failure class.

## 3.6 What the notes say about rebuild-vs-evolve

Uniformly **evolve-by-subtraction**: substrate "largely sound"; every
diagnosis is deliberately anti-rewrite ("four root causes, not forty bugs";
"one architectural debt, five faces"); the prescription is convergence onto
ONE mechanism and retirement of parallel paths. The intended end-state is the
B10 vision — a clean deterministic mobile heap with **no compensating
mechanisms** — reached by deletion, not replacement. E4 decomposition is the
only "rebuild-shaped" item and is framed as incremental seam extraction.

**Implication for the final plan:** the new-build question is not
"rebuild woo?" but "is the shortest path to the B10 end-state through the
existing v2 flag-field code, or through a fresh implementation of the
cell-authority spec behind the same seams, with the old path deleted rather
than converged?" Stage 2 (essence-vs-accident) and Stage 4 (LOC/coupling)
carry that decision.
