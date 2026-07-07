# Rider-read integrity: the ride-along gap (Phase-3 review finding)

Date: 2026-07-06. Status: FULL DESIGN A+B IMPLEMENTED (a2655d1 +
8ba00ff): plan-time /net/attest attestations validated at the committing
scope (rider_unattested terminal), owner-sequenced adoption with head
advance + owner-subscriber fanout. Earlier interim-guard status: LANDED (Phase-3 hardening pass,
branch net-phase3): /net/adopt now CASes each cell against the prior
version the committing turn observed (transcript read version, falling
back to the committing scope's pre-commit residue copy), owner-wins on
mismatch with a `net_adopt_conflict` metric, and the committing scope's
rider residue re-stamps `derived` at every closure exit. `owns` is wired
in the shell (lineage-in-store fixed-assignment rule). The full design
(A: owner attestation at plan time + B: owner-sequenced adoption policy)
remains open for Phase-3.5 — the residual tear (the room transcript's
embedded stale rider value) is still an accepted, NAMED inconsistency.

## The defect

CO2.3's ride-along lets a shared scope commit writes to rider
(foreign-anchored) cells. Three pieces combine into a lost-update hazard:

1. `owns` (src/net/scope.ts:105,197) makes the shared scope SKIP
   validation of reads on rider-owned cells — deliberately, since it
   cannot attest cells it does not hold (CO2.4 is per-authority).
2. Rider WRITES still commit at the shared scope (CA3 ride-along).
3. Adoption (/net/adopt; scope-do.ts) installs those cells into the
   owner's authority store with only (from_scope, seq) idempotency — no
   owner-head check, no per-cell CAS.

Failure scenario: gateway plans from a stale actor cell → shared scope
accepts (the actor read is unvalidated by anyone) → adoption overwrites
the actor scope's NEWER authoritative cell. CO2.4 violated end-to-end;
nobody ever attested the rider read. The differential harness modeled
adoption as a raw `owner.store.install` (tests/net/differential.test.ts
:367), which is exactly the unchecked path.

## Why this is structural, not a bug in one function

A turn that writes a room cell AND an actor cell needs both sequencers'
integrity guarantees, but commits at one. This is the deferred CA10
cross-scope problem; v2 avoided it by NOT having per-cell fixed owners at
validation time (the committing scope was the authority for everything it
committed, reconciled by projection). net's scope-is-object-home model
surfaces the seam honestly — which is good — but Phase 3 shipped the
ride-along without closing it.

## Fix design space (decision needed; spec-level, CO2.3 amendment)

A. **Owner attestation at plan time + validation at the shared scope.**
   The gateway fetches `{cell, version, owner_head}` attestations for
   rider reads during planning (one async owner RPC — off the validation
   path, Big-World safe). The shared scope validates rider reads against
   the attestation instead of skipping them. Bounded staleness: the
   attestation window.

B. **Adoption becomes owner-sequenced, never an install.** /net/adopt
   stops installing at-version and instead APPLIES the rider write as an
   owner-ordered mini-commit (the owner is ALWAYS the serializer of its
   own cells; adoption joins its queue). With A, the owner compares the
   attested prior version: match → clean apply; mismatch → the owner
   moved inside the window → named divergence event
   (`net_adopt_conflict`) with a POLICY decision: owner-wins-and-flag vs
   apply-anyway-ordered-after. Either way the event is named and counted
   — never a silent overwrite. Note the residual tear: the room's
   transcript already embedded the stale rider value in its post-state;
   a conflict therefore requires either a compensating room write or an
   accepted, NAMED inconsistency until CA10 route migration exists.

C. **Reject-until-proof (interim hard line).** Shared scopes reject
   ride-along submits whose transcripts READ rider cells (writes without
   reads — pure "stamp the actor" effects — stay allowed, CAS'd at
   adopt). Movement keeps working when the actor-location write does not
   depend on a stale actor read; anything else must restructure or wait
   for A+B.

Recommendation: A + B together (attestation + owner-sequenced adopt with
named conflicts) — they compose, neither needs sync cross-DO work inside
validation, and C's restriction falls out as the behavior when an
attestation is absent. Add the reviewer's negative test: actor scope
advances between plan and shared-scope submit → the turn must NOT
silently clobber (either rejected via attestation mismatch or surfaced
as a named adopt conflict).

## Interim guard (must land before merge)

Even before the full design: /net/adopt gains a per-cell prior-version
CAS against the shipped cells' stamps, with mismatches emitting
`net_adopt_conflict` (owner-wins) instead of overwriting. That converts
the silent lost-update into a named, counted divergence — the CO6
discipline — while A+B are designed properly.
