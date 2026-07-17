# Cases unified: every case is a room; gravity is the first-class mechanism

*Origin: 2026-07-12. Supersedes the case-file/case-room hybrid in
`2026-07-12-security-caserooms-design-approach.md` §"load-bearing domain
decision". Direction set in review: unify the case object, and promote
routing/collection — the "gravitational" dynamics of escalation — to a
first-class design element with explicit split/unwind.*

## Why the hybrid was wrong

The `$case_file`/`$case_room` split reproduced, inside one system, exactly
the Jira/Slack fracture the project exists to dissolve — a "record thing" and
a "talk thing" joined by a one-way hinge. Systems with that seam accumulate
damage at it: content stranded on the wrong side, duplicated state, an
escalation ceremony that loses history. And the hinge misdescribes real case
dynamics. A significant incident is not a work item that once crossed a
threshold; it is a **gravitational center** that forms over time — duplicate
alerts fall into it, sub-cases form around it, external assignments orbit it
— and that later **unwinds**: follow-ups spin out, satellites detach, the
center seals. A single transition can't carry that. The lifecycle is
topology and attention changing continuously, not a status flipping once.

## The unified model

**One spine: `$case < $room`.** Every external thing — alert, incident,
helpdesk report, provisioning request — is a case-room from birth, because
any of them might come to need a discussion thread, a checklist, or a task
breakdown, and the cost of "might" must be near zero. There is no promotion
to a different class, ever.

Two consequences, both loads the design must carry explicitly:

1. **Cost proportional to mass.** A case that never attracts attention must
   cost approximately a stored object: no hydration, no presence machinery,
   no client weight. woo's architecture already points this way (cold
   objects/hosts cost storage; DOs hydrate on touch), but it becomes a
   *stated engineering requirement* with a measurement gate in the slice
   (mint 1k cases; measure storage, mint latency, and that dormant cases
   stay cold). If dormant rooms turn out heavy, the fix is making rooms
   cheaper — not reintroducing a second class.

2. **Escalation is accretion, not transition.** What changes when a case
   "becomes serious" is expressed with mechanisms that don't break identity:
   - **Feature composition** (the chat catalog's `.features` idiom): a
     `$coordination` feature attaches to the case-room in place — situation
     channel, role board, comms cadence — the way any `$space` opts into
     chat. Same object, same ref, same transcript, more capability. The
     "hinge" objection dissolves mechanically: nothing moves, nothing
     converts.
   - **Cluster edges** (below): the case grows typed connections to the
     things it has captured.

## Gravity: the four first-class routing/collection elements

### G1 — The Router: mint-or-attach at ingress

Correlation is a first-class policy object, not connector code. A
`$case_router` sits between each source block (or the airlock) and the
world, and decides per arriving event: **mint** a new case, **attach** to an
existing one (same host, same campaign, same user — declared correlation
keys), or **drop/fold** (pure duplicate → an occurrence count + provenance
ref on the existing case, no new object). This is where per-alert-room
cardinality is controlled — dedup happens *before* minting, not by triaging
thousands of empty rooms.

Big-World check: correlation must not be a global query. Each router owns
bounded, TTL'd **correlation indexes** (key → open case ref, e.g. "open case
for host X in the last 72h") maintained at attach/mint/seal time. Lookup is
an explicit read of an owned index object, never a world scan.

### G2 — The Cluster: typed edges, walkable topology

A case cluster is explicit topology between case-rooms, in the native MOO
idiom: **edges are exits** (plus relation rows for projection). Edge types:

- `part_of` — sub-case ↔ coordination center (the load-bearing one)
- `duplicate_of` — sealed pointer from a folded case to its survivor
- `related` — evidence-level association, no routing consequence
- `assigned_out` — delegation to an external party, realized as an edge to a
  block (ServiceNow ticket, partner team) with the order/deliver pattern
  carrying the round-trip and the export manifest carrying provenance

Because edges are exits, the incident cluster is *walkable*: a responder in
the coordination room sees exits to sub-cases and steps into one; an agent's
MCP tool surface shifts room by room (least-location intact — an agent in a
sub-case does not thereby reach the whole cluster). Edges are objects:
creation and removal are sequenced acts in both rooms' transcripts, so the
accretion history *is* audit data.

Big-World check: clusters are bounded and explicit — rollup and presence
aggregation walk the edge list of one room, never enumerate the world.

### G3 — Rollup: structure travels, chatter stays

Routing along `part_of` edges follows one rule: **structured events
propagate; free conversation does not.** State changes, findings, action
orders, sealing — the schema'd observations — auto-forward up the cluster
(and situation broadcasts fan down), appearing in the center's sequenced log
with their source ref. Room chat stays local; a human (or agent) escalates
prose deliberately via `:report_up`, a sequenced act with named authorship.
This keeps the coordination room legible at fan-in (an incident with forty
sub-cases must not receive forty rooms' chatter), keeps fanout costs
proportional to real signal, and — with the provenance model — means
everything arriving in the center carries its origin chain.

Rollup rows are the relation-pipeline shape (authoritative fact → derived
relation row → view), which is already the substrate's stated architectural
direction for contents/presence/rosters.

### G4 — Queues are projections, not containers

With cases as rooms, nothing "moves into" a queue. A triage queue, a team
board, "my cases", "everything in this incident" are **views over relation
rows** (status, assignment, cluster membership, age), rendered by registry
spaces you stand in. Assignment itself becomes a relation + obligation
(claim/handoff/release keep tasks-catalog *semantics*; the lease is a
sequenced relation write rather than physical movement). Movement-as-lease
is not lost — it moves down a level, where it's natural: checklist items and
task breakdowns *inside* a case are `$task < $note` objects, physically
handed between actors, exactly as the tasks catalog built it.

Big-World check: each view projects from bounded inputs (a team's router
indexes, one cluster's edges) — no global case enumeration anywhere.

## Lifecycle dynamics (the hinge, replaced)

A case's life is a trajectory in three mostly-independent dimensions:
**attention** (presence, subscribers), **structure** (artifacts, tasks,
features attached), and **connectivity** (cluster edges). "Escalation" and
"de-escalation" are gradients along them. Orthogonally, the **governance
state machine** (workflows.md: open → triaged → contained → resolved →
sealed, with role-gated `requires` predicates) provides the auditable
control points. Keeping social lifecycle and governance state separate is
deliberate: the war-room that's quiet for a week hasn't changed state; the
alert that resolves in forty seconds never grew mass.

Named dynamics, all sequenced verbs on `$case`:

- **Accrete** (`:attach_to(center)` / router attach): edge built, rollup
  begins, correlation index updated. The *first* case of an incident usually
  **grows in place** — coordination feature attached, satellites accrete
  around it, transcript continuity unbroken. Minting a fresh center is also
  expressible (many peer duplicates, no privileged seed) — same edge
  mechanics, choice per situation, not per architecture.
- **Merge / fold** (`:fold_into(survivor)`): duplicate's artifacts move to
  the survivor (provenance intact), the folded case seals with a
  `duplicate_of` tombstone edge — history preserved, both transcripts record
  the act, later readers who land on the duplicate get redirected context.
- **Spin out** (`:spin_out(spec)`): the unwind primitive. A follow-up case
  (hardening task, policy fix, post-mortem action) mints with selected
  artifacts *moved or referenced* (provenance chains pointing back through
  the incident), a `related` edge for the record, and independent life —
  explicitly *not* `part_of`, so the sealed incident doesn't remain a live
  routing center.
- **Detach / de-escalate**: `part_of` edge removed (sequenced in both
  rooms); coordination features can detach as attention drains; the center
  eventually seals with its satellite history intact in the transcript.

## Interaction with the provenance strategy

Unification strengthens it. Edges carry provenance (an `attach` records who
or which router connected what, on what correlation evidence — poisoned
correlation is itself a threat: an attacker crafting alerts to fall into an
existing case inherits that case's audience). Folding moves artifacts with
chains intact. Rollup rows carry source refs, so nothing arrives in a
coordination room label-free. Router decisions are `system`-labeled acts
with the triggering event's `external` ref in the chain — correlation is
inspectable evidence, not magic.

## Pattern-language updates

Replaces/amends the seed list (approach note §Phase 4):

- ~~2. Work-Item Lease~~ → **2. Lease-by-Movement (intra-case)** — physical
  handoff for tasks *inside* a case; case assignment is a sequenced
  relation, not movement.
- ~~3. Escalate-to-Room~~ → **3. Grow-in-Place** — capability accretes via
  features; identity and transcript never break.
- 1 stays, sharpened: **Queue-as-Projection** — views over relation rows;
  nothing is "in" a queue.
- New: **19. Mint-or-Attach Router** — correlation as an owned policy object
  with bounded TTL'd indexes. **20. Cluster-as-Topology** — typed edges are
  exits; the incident is walkable; edge changes are sequenced in both rooms.
  **21. Structure-Travels-Chatter-Stays** — rollup forwards schema'd events;
  prose crosses only by named, sequenced act. **22. Fold-with-Tombstone** —
  merge preserves both transcripts and leaves a redirecting edge.
  **23. Spin-Out** — unwind mints independent follow-ups with back-pointing
  provenance, not dangling sub-cases.

## Slice implications (amends Phase 3)

The vertical slice becomes: source block → router (one mint, one attach, one
fold against seeded correlation) → triage via queue-projection → analyst
claims (relation lease) → case grows in place (coordination feature) →
second alert accretes as `part_of` satellite → agent-resident enrichment in
the satellite, finding rolls up to the center with provenance → approver
gates an action order → spin-out of one follow-up case → center seals.
Plus the cost gate: mint 1k dormant cases, measure storage/latency/coldness.
Plus the adversarial lane unchanged, with one addition: a poisoned-
correlation fixture (attacker-shaped alert engineered to attach to an
existing case) asserting router decisions are inspectable and gated by
declared keys only.

This is a bigger slice than the hybrid's. Worth it: it exercises every
gravity mechanism once, and the pattern language depends on those examples.

## Open decisions

1. **Are `part_of` edges strictly a tree, or a DAG?** Tree (recommended for
   v1: one coordination center per case at a time; re-parenting is
   detach+attach, both sequenced) vs DAG (a sub-case serving two incidents —
   real in cross-campaign situations, but rollup fan-out and audience
   questions compound; defer until an archetype demands it).
2. **Rollup transport: relation rows + projection, or observation
   forwarding?** Projection-pipeline (recommended: aligns with the
   substrate's relation direction, replay-derivable, no double-write) vs
   forwarding observations as new sequenced entries in the center (simpler
   today, but duplicates authority and can drift). Interacts with how much
   of the relation pipeline exists when the slice is built — may start as
   forwarding with a planned migration, if so, say so in the catalog DESIGN.
3. **Does the router live per-source, per-queue/team, or per-deployment?**
   Per-source with team-level policy composition (recommended: bounds
   indexes naturally, matches block ownership) vs centralized (simpler
   mental model, becomes a Big-World singleton pressure point).
4. **Dormant-case representation.** Full `$case` room object per event
   post-router (recommended baseline; the router's fold path is the volume
   valve) vs an occurrence-ledger on a survivor case for high-frequency
   repeats (already implied by fold — the question is whether *first*
   occurrences of noisy-but-distinct signatures also fold into a per-
   signature rollup case rather than minting; probably yes, as router
   policy, not as a new object kind).
