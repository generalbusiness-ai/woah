# Security case-workrooms: design approach

*Origin: 2026-07-12. Planning note, not a spec. Proposes how to run the design
task for a security-operations "case workroom" domain on woo — the domain
model, the sequencing, and the pattern-language extraction — grounded in a
capability survey of the current substrate and catalogs.*

## The problem, restated

Security teams coordinate resolution work across tools that each get half the
job: Slack-class channels give realtime swarming but no structure, weak
traceability, awkward cross-org rooms, and no lifecycle; Jira-class trackers
give structure and audit but no live cooperative presence. The work itself
spans wildly different lifetimes and cardinalities — thousands of SIEM alerts
a day, a handful of month-long breach war-rooms a year — plus helpdesk
reports, provisioning requests, remediation and hardening tasks. Increasingly
the participants are not all human: large parts of the work are delegated to
agents and specialized functions.

The thesis: a MOO-shaped world — persistent objects, prototype inheritance,
rooms with presence, a sequenced replay-deterministic transcript, and agents
as first-class residents — is the right unifying substrate. What's missing is
(a) the domain catalog, and (b) a **pattern language** that makes designing in
this idiom teachable, because "MOO customization" is unfamiliar next to Jira
workflow schemes or conventional OO.

## Survey verdict: composition problem, not construction problem

A capability sweep (2026-07-12) found that most required mechanisms already
exist, scattered across catalogs and spec:

| Case-workroom need | Existing affordance |
|---|---|
| Live room w/ presence, chat, geography | chat catalog: `$room < $space`, chat as *feature* composition |
| Durable, replayable case record | sequenced `$space` log (`spec/semantics/sequenced-log.md`); durability follows route: `$space:call` frames are audit/replay-visible, direct calls are live-only (`events.md §12.6`) |
| Work item with assignment semantics | tasks catalog: `$task < $note`, obligation-list state machine, movement-as-lease gated by `:acceptable` |
| Workflow / approval gating | `spec/operations/workflows.md`: state machine on `$space` with roles + `requires` predicates — its own examples are "review pipelines, approval chains" |
| External source ingestion | block/plug pattern (`catalogs/block/DESIGN.md`): anchored actor + apikey'd external worker; weather (poller) and horoscope (LLM producer) are existence proofs |
| Async delegation with receipts | dispenser order/deliver queue (`catalogs/dispenser/DESIGN.md`): durable `pending_orders`, idempotent `:deliver`, rate limits |
| Agents as participants | MCP surface (`spec/protocol/mcp.md`): one connection→session→actor, no authority elevation; `tool_exposed` verbs of *reachable objects* become the agent's tools — an agent standing in a case room sees exactly that case's action surface |
| Artifacts (evidence, findings, runbooks) | `$note` three-slot pattern + `.writers` ACL convention; outliner for hierarchy/timeline; pinboard for spatial boards |
| Role vocabulary | `notes/2026-05-08-roles.md` already names Reporter / Triage / Investigator / Reviewer |
| Specialization without forking UX | prototype inheritance + catalog `depends`; UI component model where "the server is the model" (`spec/protocol/ui-component-model.md`) |

Confirmed gaps (found/not-found, from the same survey):

1. **No archival/seal/freeze** — lifecycle is `recycle()` (destructive) or a
   workflow terminal status. No immutable "closed case" primitive.
2. **No generic inbound webhook receiver** — ingestion requires a per-source
   plug worker or apikey-bound client.
3. **DSL-level scheduling not exposed** — substrate has FORK/SUSPEND and the
   scheduled-turn/outbox lane (`coherence.md §CO16`), but no woocode-visible
   SLA timer.
4. **Coarse access control** — owner/writers convention + wizard bypass;
   per-verb capabilities explicitly deferred (`permissions.md §11.6`). A
   need-to-know breach room strains this.
5. **No cross-org identity** — single namespace per deployment; federation is
   v2-deferred. `$team` is partial.
6. **`$kanban_board` is design-only** — a triage board must build it.
7. Directed-observation types are a closed set (`events.md §12.7.1`); new
   case observation types are broadcast-typed unless the spec is amended.

So the design task is mostly **composition and naming**: pick the domain
mappings, close a small number of gaps at the right layer, build one honest
vertical slice, and only then extract the pattern language from what worked.

## The load-bearing domain decision: one case class + gravity

*(Revised 2026-07-12 — the earlier case-file/case-room hybrid is withdrawn;
it reproduced the Jira/Slack seam internally and its one-way hinge
misdescribed case dynamics. Full design:
`2026-07-12-case-gravity-unified-model.md`.)*

**Every case is a `$case < $room` from birth** — alert, incident, helpdesk
report, provisioning request — because any of them may come to need a
discussion thread, a checklist, or a task breakdown, and "might" must cost
nothing. Two loads follow: dormant cases must cost ~a stored object
(explicit measurement gate in the slice), and **escalation is accretion, not
transition** — capability attaches in place via feature composition
(`$coordination` on the room, the chat-catalog `.features` idiom), identity
and transcript never break.

Routing/collection is the first-class mechanism — four elements:
**Router** (mint-or-attach-or-fold correlation at ingress, with bounded
TTL'd indexes, no global queries); **Cluster** (typed edges — `part_of`,
`duplicate_of`, `related`, `assigned_out` — realized as exits, so the
incident is walkable topology and edge changes are sequenced in both rooms);
**Rollup** (structure travels, chatter stays: schema'd events forward along
`part_of`; prose crosses only by named `:report_up`); **Queues as
projections** (views over relation rows; nothing "moves into" a queue;
assignment is a sequenced relation, while movement-as-lease survives one
level down for tasks *inside* a case). Lifecycle is a trajectory in
attention × structure × connectivity — accrete, fold-with-tombstone,
spin-out, detach — with the governance state machine kept orthogonal.

Everything else hangs off that spine:

- **The record is the transcript.** Case-significant verbs route sequenced
  (`$space:call`) so they land in the replay-deterministic log; ambient chat
  can stay live, or the room class opts into durable chat
  (`persistent-conversation.md`). Traceability is structural, not an export
  job — this is the concrete advantage over Slack and the thing to protect in
  every later design decision.
- **Sources are blocks.** A SIEM connector is a `$block` subclass; its plug
  worker authenticates as the block's actor and mints `$case_file`s into the
  queue. Helpdesk intake, EDR, mail-report ingestion are more plugs — the
  ingestion pattern is uniform even when the sources aren't.
- **Delegation is order/deliver.** "Enrich this indicator", "compute blast
  radius", "draft comms" are dispenser-style work orders; the deliverable is
  a `$finding_note` minted into the case. Long-running agent work stays
  outside the world's turn budget by construction.
- **Agents are residents.** An MCP-connected agent joins the room as an
  actor; its tool surface is the room's `tool_exposed` verbs — scoped
  capability *by location* rather than by config. HITL is then not a bolt-on:
  humans and agents share the same room, record, and verbs.

## Proposed sequence

**Phase 0 — Design brief (paper).** Name the case archetypes on two axes —
lifetime (minutes→months) × cardinality (thousands/day→few/year) — plus
participant mix (human-only ↔ mostly-agent): SIEM alert, SIEM incident,
helpdesk report, provisioning request, remediation task, blast-radius
investigation, breach war-room. Extend the roles note with SOC roles
(reporter, triage analyst, case owner/IC, responder, approver, scribe-agent,
auditor). Define "unified experience" as a checklist: one identity, one
presence model, one record shape, one delegation pattern, one client shell;
specialization allowed only in room class, artifact classes, workflow policy,
and frames.

**Phase 1 — Domain model (paper, short).** Commit the unified case model
above; write the class map (`secops` catalog: `$case < $room`,
`$case_router`, cluster edge classes on `$exit`, `$triage_view` registry,
`$evidence_note`, `$finding_note`, `$timeline` reusing outliner,
`$alert_source_block`, `$work_order` dispenser generalization, the
`$coordination` feature) with explicit `depends: [chat, note, tasks, block,
dispenser, perm]`. Every class states which existing mechanism it reuses; a class that
reuses nothing is a design smell.

**Phase 2 — Gap dispositions.** Each survey gap gets an explicit layer
decision (catalog convention now / substrate roadmap / defer), so the slice
doesn't silently smuggle domain into `src/core`:

| Gap | v1 disposition | Roadmap |
|---|---|---|
| Seal/archive | workflow terminal status + perm-catalog write-deny on closed cases | substrate seal/freeze primitive, spec'd properly |
| Webhook ingress | per-source plug workers (weather pattern) | generic signature-verified webhook receiver minting block writes |
| SLA timers | plug-driven clock (a block whose worker polls due-times and pokes the queue) | expose scheduled-turn lane to DSL — likely the highest-value substrate ask |
| Need-to-know ACL | room membership *is* access; `.writers` on artifacts; document limits honestly | capability model (`§11.6` un-defer), driven by breach-room paper design |
| Cross-org | out of scope; single-org SOC is the v1 user; avoid contracts that assume it | federation v2 |
| Kanban | build `$kanban_board` (design exists in pinboard DESIGN.md) as part of the slice | — |

**Phase 3 — Vertical slice (build).** One scenario end-to-end, in a `secops`
catalog, zero core changes: SIEM plug → router (one mint, one attach, one
fold against seeded correlation) → triage via queue-projection kanban →
analyst claims (relation lease) → case grows in place (`$coordination`
feature) → second alert accretes as `part_of` satellite → enrichment agent
(MCP resident) works the satellite, finding rolls up with provenance →
approver gates an action order via workflow predicate → one follow-up
spin-out → center seals; transcript replay is the case record. Plus the cost
gate: mint 1k dormant cases, measure storage/latency/coldness. UI: triage
projection frame + case frame (chat region, evidence board, timeline,
cluster map).
This slice deliberately touches every mechanism the pattern language will
need to name. It also carries an adversarial lane: fixtures seeded with
prompt-injection payloads, gating on the provenance/taint strategy in
`2026-07-12-caseroom-provenance-taint-strategy.md` (labels survive the
pipeline; no unapproved `$action_order`; quarantine envelope unspoofable).

**Phase 4 — Extract the pattern language (paper, from evidence).** Only after
the slice works. Write each pattern in Alexander form — context, forces,
solution, example *from the slice*, counter-example — so it guides
domain-driven design rather than restating API docs. Seed list (mostly
*naming* mechanisms that already exist, which is exactly why extraction beats
invention):

1. **Queue-as-Projection** — views over relation rows, rendered by
   registries you stand in; nothing is "in" a queue; no global enumeration.
2. **Lease-by-Movement (intra-case)** — physical handoff with `:acceptable`
   gating for tasks *inside* a case; case assignment is a sequenced
   relation.
3. **Grow-in-Place** — capability accretes via feature composition;
   identity and transcript never break.
4. **Sequenced Transcript is the Record** — route audit-significant verbs
   via `$space:call`; the log is the deliverable, not a side effect.
5. **Block-and-Plug Ingress** — every external source is an anchored actor
   plus an authenticated outside worker.
6. **Order/Deliver Delegation** — durable ticket out, idempotent deliverable
   back; never park a turn on external latency.
7. **Agent-as-Resident** — agents join as actors; location scopes their tool
   surface; HITL = shared room.
8. **Feature-not-Subclass** — cross-cutting behavior (chat, loggability)
   attaches via `.features`.
9. **Three-Slot Artifact** — name/description/text discipline for every
   document object.
10. **Roles-as-Policy** — obligations and workflow `requires` predicates, not
    per-verb ACL sprawl.
11. **Terminal-Status Seal** — closure is a workflow state plus write-deny,
    until a substrate seal exists.
12. **Projection View** — frames render server projections; components never
    own case state.

Patterns 13–18 (Taint-at-Ingress, Tamper-Proof Label, Quarantine Envelope,
Propose-don't-Act, Airlock Intake, Vouch-to-Trust) come from the provenance /
injection-resistance strategy in
`2026-07-12-caseroom-provenance-taint-strategy.md`. Patterns 19–23
(Mint-or-Attach Router, Cluster-as-Topology, Structure-Travels-Chatter-Stays,
Fold-with-Tombstone, Spin-Out) come from the unified gravity model in
`2026-07-12-case-gravity-unified-model.md`.

Where the language lives: `docs/patterns/` (user-facing, teaching-oriented)
with cross-references into the normative spec, since spec/ is reserved for
implemented normative contracts.

**Phase 5 — Validate by paper-designing the neighbors.** Test the language by
designing 2–3 adjacent use cases *on paper, without new substrate*: helpdesk
report intake (different source, same queue patterns), access-provisioning
approval chain (workflows.md's own motivating example), breach war-room with
need-to-know (deliberately chosen to stress the ACL gap). Every place the
paper design hits a wall becomes a named, prioritized substrate roadmap item
— that is what "principled extension" means operationally: expansion pressure
discovered by the pattern language, resolved at the right layer, never by a
domain special-case in core.

## Anti-goals

- **No domain in `src/core`.** The whole design is superstructure; if a slice
  step seems to need a core change, it needs a *generic* primitive with a
  spec section, or a different design.
- **Not a Jira clone, not a Slack clone.** The differentiators to protect:
  live presence + structurally durable record in one place; agents as
  residents; specialization by inheritance instead of per-tool configuration.
- **No pattern language before the slice.** Patterns are extracted, not
  invented; a pattern without a working example from Phase 3 doesn't ship.
- **No speculative multi-org machinery.** Single-namespace SOC first; keep
  contracts federation-compatible by not *assuming* org-global truths, but
  build nothing for it.

## Open decisions (self-contained, for review)

1. ~~Case-file/case-room hybrid vs alternatives~~ — **RESOLVED 2026-07-12:
   unified.** Every case is a `$case < $room`; escalation is accretion
   (features + cluster edges), never a class transition; router fold is the
   volume valve; dormant-case cost is a measured slice gate. Rationale and
   the follow-on open decisions (tree-vs-DAG edges, rollup transport, router
   placement, dormant representation) live in
   `2026-07-12-case-gravity-unified-model.md`.
2. **First slice source: SIEM alert vs helpdesk report.** SIEM (recommended)
   exercises volume, machine ingestion, and enrichment agents — the most
   pattern-dense path; helpdesk is more human-shaped but duplicates less of
   what later phases must prove.
3. **Substrate asks in v1 scope?** Strictly zero core changes (recommended —
   plug-driven timers and terminal-status seal are honest v1 stand-ins, and
   Phase 5 produces a better-justified roadmap), vs pulling DSL scheduling
   forward now because SLA timers are so central to the domain. If the
   plug-clock proves too awkward in the slice, that's the evidence to pull it
   forward.
4. **Where the demo/seed placements live.** A `secops-demo` seed catalog
   depending on `secops` (recommended, mirroring the demoworld one-way
   layering rule) vs seeding inside `secops` itself.
