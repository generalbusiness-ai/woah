# Simplest Deployable System — Stage 0: Method & Decision Criteria

Date: 2026-07-04
Series: `2026-07-04-simplest-system-*.md` — staged analysis toward an
implementation-ready plan for the simplest, most elegant deployable woo that
meets the scalability and performance goals.
Input: `notes/2026-07-04-architecture-review-handoff.md` (the variance ledger).
Output: final plan in `notes/2026-07-04-simplest-system-plan.md`.

## The question being answered

Not "how do we fix deployed CF" (prior plans answer that incrementally) but:
**what is the minimal coherent system that delivers the project's goals, and
what is the shortest defensible path to it — evolve, extract, or new-build,
per layer?** The user's framing explicitly removes the migration bias: if the
clear path for a layer is new-build, say so.

## Method

Four parallel evidence passes, each producing a stage note:

1. **Goals** (stage 1): every *stated* scalability/performance target, with
   citations — and where no target exists, name the gap. A "simplest system
   that meets the goals" is unfalsifiable until the goals are numbers.
2. **Essence vs accident** (stage 2): the v2 turn/commit network's load-bearing
   invariants (what any replacement must keep) vs mechanism that exists only
   for historical or band-aid reasons.
3. **Decision ledger** (stage 3): what prior plans (E1–E5, CA-series, A/B/C
   tracks, B7–B10) already decided, landed, deferred, or withdrew — so the plan
   builds on decisions instead of re-litigating them.
4. **Keep/rebuild inventory** (stage 4): LOC + coupling audit splitting the
   codebase into keep-as-is / extract / rewrite / discard.

Synthesis then makes the evolve-vs-new-build call **per layer**, not globally.

## Decision criteria for evolve vs new-build (per layer)

A layer is a **new-build** candidate when all four hold:

- **C1 — Invariant clarity:** its essential semantics are small and fully
  enumerable (we can state what a replacement must guarantee on one page).
- **C2 — Accident dominance:** most of its code exists to serve its own
  history (flags, repair of self-inflicted divergence, parallel copies) rather
  than the semantics.
- **C3 — Blast containment:** it can be replaced behind an existing seam
  without rewriting its consumers (substrate, catalogs, clients).
- **C4 — Migration burden exceeds build burden:** walking existing deployed
  state forward costs more than reseeding/reinstalling into the new shape.
  (woo has an unusual asset here: the world is *installable from catalogs* —
  a fresh world is cheap; only user-authored state needs carrying.)

A layer is an **evolve** candidate when its semantics are sound and the debt
is additive (guards, decomposition, spec promotion).

## What "simplest and most elegant" is taken to mean (evaluation rubric)

- **One write path per fact.** Every durable fact has exactly one
  authoritative writer; everything else is a derived, rebuildable view.
- **Enumerable state copies.** Every materialization of world state is named,
  has a stated freshness bound, and a stated reseed path. "Seven unmanaged
  copies" is the anti-goal.
- **One turn pipeline.** One implementation of intent → plan → commit →
  fanout, parameterized by transport and deployment mode — not three drifting
  call sites and a fake.
- **Substrate stays host-agnostic.** VM/compiler/object model/catalogs run
  identically in-memory, SQLite, and CF; distribution is a layer they don't
  know about.
- **No flag fields as architecture.** Feature flags are for rollout, not for
  holding two designs in superposition indefinitely.
- **Deletable by design.** Prefer designs where the old mechanism can be
  removed entirely, over designs where both must be maintained.

## Constraints taken as fixed (not re-opened)

- Cloudflare Workers + Durable Objects is the production profile
  (spec/reference/cloudflare.md); in-memory and local SQLite modes remain.
- The substrate/superstructure split and catalog install path are settled and
  correct (handoff §1–§2: "largely sound", "genuinely well-factored").
- Big-World discipline: no global enumeration, no node holds the whole world.
- Spec-first development discipline continues to apply to whatever is built.

## Stage notes in this series

- `-00-method.md` (this note)
- `-01-goals.md` — stated targets and target gaps
- `-02-essence-vs-accident.md` — v2 network invariants vs mechanism
- `-03-decision-ledger.md` — prior plans: landed/deferred/withdrawn
- `-04-keep-rebuild-inventory.md` — LOC/coupling split of the codebase
- `-plan.md` — the implementation-ready plan
