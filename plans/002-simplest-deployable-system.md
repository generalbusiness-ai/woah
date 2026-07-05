# Plan 002 — The Simplest Deployable System (the coherence layer)

Status: TODO (approved for execution 2026-07-05; owner approved all §8
decisions)
Priority: P1 · Effort: XL · Depends on: 001 (closed out by this plan's v2
freeze — see below)

## What this is

The full plan text lives in **`notes/2026-07-04-simplest-system-plan.md`**
(rev 3), argued from the staged analysis
`notes/2026-07-04-simplest-system-0{0..4}-*.md`. This file is the execution
registration; read the note fully before starting. Summary of the decision:

- **Keep** the world engine (substrate, `world.ts` object model, catalogs,
  local modes, base client) wholesale.
- **New-build** the distribution layer as `src/net/` ("the coherence
  layer", ~9.3k LOC target): one turn pipeline, three Host bindings
  (in-process / workerd / SQLite), five named state copies, the divergence
  taxonomy as its error enum, CA3/CA4 movement with ride-along, durable
  continuations at the scope sequencer.
- **Delete** the v2 layer (~34k LOC, 12 flags, 3 DO classes) at Phase-5
  cutover, after fault-injection + aged-world lanes prove the new path.

## Phases (each independently landable; gates in the plan note)

0. Ratify `spec/protocol/coherence.md` + SLOs (spec only).
1. `TurnEngine` seam: injected `TurnEffects` interface in `world.ts`
   (nine v2 modules, ~100 inline hook sites); v2 keeps running through it.
2. `src/net/` host-agnostic, built against the ported v2 validation corpus,
   with a differential gate vs v2 on the shared smoke scenario.
3. CF hosts + multi-DO fault-injection harness + aged-world lane —
   **before any deploy**.
4. Transports (one `submitTurn` primitive) + client projection-feed cutover.
5. Fresh-namespace deploy with the identity export/import and the
   write-freeze cutover protocol; postflight; then the deletion commits.

## STOP conditions

- Any phase exit gate failing is a stop — do not proceed on partial green.
- The Phase-2 differential gate diverging (v2 vs `src/net/` verdict/state
  mismatch on the shared scenario) is a stop until root-caused: it means
  either a v2 bug (document it) or a new-layer bug (fix it) — never skip.
- No v2 state-path deploys for the duration (standing freeze, approved).
- Phase-5 cutover requires the §8 written reset inventory and the import
  verification (zero dangling refs) before the route switch.

## Relationship to Plan 001

Plan 001's local/workerd baseline landed (candidate note 2026-06-29;
deployed baseline passed after the `b8e55f9` cycle, per owner review
2026-07-05). Its remaining tail — further deployed classification and
state-path fixes on the v2 path — is subsumed and frozen by this plan's
approved v2 freeze. 001 is closed as DONE-by-supersession; its validation
regime (curated gates, three lanes, tail-metric postflight) carries forward
here unchanged.
