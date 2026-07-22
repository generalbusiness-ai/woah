# Security case-workrooms: design approach

*Origin: 2026-07-12. Planning note, not a spec. Proposes how to run the design
task for a security-operations "case workroom" domain on woo — the domain
model, the sequencing, and the pattern-language extraction — grounded in a
capability survey of the current substrate and catalogs.*

*Amended 2026-07-21: the mechanics layer is superseded by the acts
kernel (`2026-07-21-acts-projection-model.md`) and its companion
(`2026-07-21-acts-composition-vision.md`). Specifically: queues/rollup
now run on acts + projections; the Phase 2/3 "zero core changes" claim
is stale (the kernel closes two narrow generic read gaps — the
already-specified `event_schema` builtin and the persisted timestamp
on `$space:replay()` results); the Phase 3 slice
narrows to **single-room scope for v1** (case + board + journal +
adversarial lane), with router, queue projections, rollup, and cluster
mechanics at the named v1.5 milestone (vision §5.3); the provenance
strategy's E4/E5 obligations are seated in the v1 proof (kernel §2.5,
gate 9); patterns 24–30 extend the seed list (vision §5.8).*

*Amended 2026-07-22: external integrations now follow the case-local block
model developed from the GitHub repository-workspace example in
`2026-07-22-repository-workspaces-and-content-connectors.md`. A case may
contain zero or more blocks, one per bound external record. A provider
installation/factory verifies transport and instantiates those blocks, but
does not become the user-facing singleton through which every case operation
must pass. External credentials are delegated, never copied into instances.
The body below reconciles the obsolete `$case_file`, relation-row queue,
zero-core-change, and over-large v1 slice descriptions.*

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
| External-system interaction | block/plug pattern (`catalogs/block/DESIGN.md`) for a case-local external-record principal; Acts + outbox projections for durable inbound meaning and outbound intent |
| Async delegation with receipts | dispenser order/deliver queue (`catalogs/dispenser/DESIGN.md`): durable `pending_orders`, idempotent `:deliver`, rate limits |
| Agents as participants | MCP surface (`spec/protocol/mcp.md`): one connection→session→actor, no authority elevation; `tool_exposed` verbs of *reachable objects* become the agent's tools — an agent standing in a case room sees exactly that case's action surface |
| Artifacts (evidence, findings, runbooks) | `$note` three-slot pattern + `.writers` ACL convention; outliner for hierarchy/timeline; pinboard for spatial boards |
| Role vocabulary | `notes/2026-05-08-roles.md` already names Reporter / Triage / Investigator / Reviewer |
| Specialization without forking UX | prototype inheritance + catalog `depends`; UI component model where "the server is the model" (`spec/protocol/ui-component-model.md`) |

Confirmed gaps (found/not-found, from the same survey):

1. **No archival/seal/freeze** — lifecycle is `recycle()` (destructive) or a
   workflow terminal status. No immutable "closed case" primitive.
2. **No generic connector ingress contract** — ingestion requires a
   per-source plug worker or apikey-bound client; signature verification,
   delivery deduplication, reconciliation, and bounded raw-payload retention
   are not yet a shared adapter contract.
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
8. **No delegated connector credential** — apikeys currently bind one
   external session to one block actor. A provider plug servicing many
   case-local binding blocks needs either per-block credentials with a proven
   cardinality envelope, or a scoped delegation mechanism that cannot widen
   the installation's authority.

So the design task is mostly **composition and naming**: pick the domain
mappings, close a small number of gaps at the right layer, build one honest
vertical slice, and only then extract the pattern language from what worked.

## The load-bearing domain decision: one case class + gravity

*(Revised 2026-07-12 — the earlier case-file/case-room hybrid is withdrawn;
it reproduced the Jira/Slack seam internally and its one-way hinge
misdescribed case dynamics. Full design:
`2026-07-12-case-gravity-unified-model.md`.)*

**Every accepted woo case is a `$case < $room` from birth.** An external
alert, ticket, incident, or request is not automatically a case: the router
may attach it to an existing case or fold it as an occurrence before any room
is minted. Once accepted as a case, however, it is already a room because it
may need discussion, a checklist, or task breakdown, and "might" must cost
nothing. Two loads follow: dormant cases must cost approximately a stored
object (explicit measurement gate in the slice), and **escalation is
accretion, not transition** — capability attaches in place via feature
composition (`$coordination` on the room, the chat-catalog `.features`
idiom), identity and transcript never break.

Routing/collection is the first-class mechanism — four elements:
**Router** (mint-or-attach-or-fold correlation at ingress, with bounded
TTL'd indexes, no global queries); **Cluster** (typed edges — `part_of`,
`duplicate_of`, `related`, `assigned_out` — realized as exits, so the
incident is walkable topology and edge changes are sequenced in both rooms);
**Rollup** (structure travels, chatter stays: schema'd events forward along
`part_of`; prose crosses only by named `:report_up`); **Queues as
projections** (registry spaces consume routed case acts; nothing "moves into"
a queue; assignment is act-derived coordination state, while
movement-as-lease survives one level down for tasks *inside* a case).
Lifecycle is a trajectory in
attention × structure × connectivity — accrete, fold-with-tombstone,
spin-out, detach — with the governance state machine kept orthogonal.

Everything else hangs off that spine:

- **The woo case record is the transcript.** Case-significant verbs route sequenced
  (`$space:call`) so they land in the replay-deterministic log; ambient chat
  can stay live, or the room class opts into durable chat
  (`persistent-conversation.md`). Connected systems remain authoritative for
  their own tickets, alerts, incidents, approvals, and automation runs. Woo
  records what those external facts mean to this case, plus local decisions
  and requested effects; it does not claim to replace every external audit
  record.
- **External records are blocks in the room.** A Jira ticket, Sentinel
  incident, ServiceNow change, or SOAR playbook run appears as its own
  `$block` instance located in the case. The block exposes the record's
  bounded current view and permitted operations where humans and agents can
  naturally reach it. Provider factories and plugs handle transport and
  credentials behind that local surface.
- **Delegation is order/deliver.** "Enrich this indicator", "compute blast
  radius", "draft comms" are dispenser-style work orders; the deliverable is
  a `$finding_note` minted into the case. Long-running agent work stays
  outside the world's turn budget by construction.
- **Agents are residents.** An MCP-connected agent joins the room as an
  actor; its tool surface is the room's `tool_exposed` verbs — scoped
  capability *by location* rather than by config. HITL is then not a bolt-on:
  humans and agents share the same room, record, and verbs.

## External records are case-local blocks

The interaction surface should be local even when credential management is
shared. The unit is **one block per external-record binding**, not one block
per provider and not rigidly one block per case. A case can contain several
tickets, alerts, incidents, change requests, affected configuration items, or
automation runs; an entirely local case can contain none.

```text
$jira_factory_block                      provider installation boundary
  receives verified webhook wakeups
  reconciles canonical Jira state
  asks router: mint | attach | fold
  instantiates case-local blocks

$case < $room
  $jira_ticket_block PROJ-123            origin/remediation ticket
  $sentinel_incident_block INC-456       detection/incident
  $servicenow_change_block CHG-789       governed change
  local tasks, evidence, findings, acts, projections
```

### Three distinct roles

| Role | Identity and responsibility | Cardinality |
|---|---|---|
| **Provider prototype** | `$jira_ticket_block`, `$siem_incident_block`, and peers define verbs, bounded data shape, rendering hints, and policy hooks. They contain no installation secret. | one per installed catalog version |
| **Installation/factory** | A configured block/plug pair for one tenant, project, workspace, or security boundary verifies transport, owns bounded routing indexes, reconciles provider state, and provisions record blocks. It is not a global singleton. | sharded by an operator-chosen external authority boundary |
| **Record block** | A concrete external record and Woo principal, physically located in its owning case. It carries stable external identity, relationship, freshness, and permitted operations, but no external secret. | zero or more per case; potentially many per installation |

The factory is an administrative and transport boundary, not the ordinary
case interaction path. Once a record block is in a case, people and agents
address it directly: inspect the ticket, request a transition, add a comment,
refresh current state, or run an allowed response action. Its verbs enter
through typed case verbs; the block or plug never emits raw acts.

Conceptually, each record block carries bounded identity and state:

```text
$external_record_block < $block
  provider_code          bounded catalog-defined code
  installation_ref       opaque non-secret authority boundary
  external_type          ticket | alert | incident | change | run | ci | ...
  external_id            provider-stable opaque id
  observed_version       opaque compare/reconciliation token
  freshness              current | stale | unavailable

case binding projection row, keyed by block
  relationship           origin | tracks | remediation | approval |
                         detection | automation_run | affected_ci | ...
  bound_seq              case act that admitted the binding
  last_meaningful_seq    latest external fact folded by this case
```

Display keys and URLs may accompany the stable ID but are not identity.
External prose, webhook bodies, attachments, logs, and large field sets are
tainted referenced artifacts or lazy bounded resources, not block properties
or inline act payloads. Connector-written block fields are an
object-authoritative cache of current external state and freshness, like
other `$block` data; the case projection does not mirror them. Conversely,
the binding's local relationship and meaning are act-derived coordination
state and are not direct-writable block properties.

### Factory and ingress flow

A Jira factory can create a case room for a new ticket, but it must not encode
"one ticket, one room" as connector behavior. Routing and correlation remain
domain policy:

```text
verified webhook wakeup
  → enqueue and deduplicate the delivery
  → fetch/reconcile canonical external record
  → router lookup by stable external identity and declared correlation keys
  → decide mint | attach | fold
  → mint case if needed
  → instantiate the provider block in the chosen case
  → call a typed case verb
  → record semantic act and projection changes
```

Webhook deliveries are hints, not authority. Retries deduplicate by delivery
identity; reconciliation deduplicates domain effects by external record and
version. Provider-owned indexes are bounded and sharded with the installation
boundary; there is no world-wide external-ID lookup.

### Credentials and delegated authority

Instantiation copies behavior, not secrets. A Jira OAuth token, SIEM service
credential, SOAR credential, or authenticated remote URL remains in the
plug's secret store. It is never a prototype property, instance property,
act, observation, artifact, or rendered error.

The record block nevertheless has its own Woo authority. The initial
implementation may mint one Woo apikey per record block if the dormant-key
and revocation costs pass the cardinality gate. The preferable scale shape is
a short-lived or narrowly scoped delegation: the installation plug may speak
for a named set of record blocks and verbs, but cannot mint arbitrary acts,
escape its installation, or inherit room-member authority. Handoff or
revocation changes the Woo capability; it never copies the external token.

Outbound changes use desired intent rather than optimistic mirroring:

```text
typed case request
  → external.change_requested act
  → command/outbox projection
  → provider plug performs an authorized API operation
  → typed success/failure callback
  → webhook or reconciliation confirms observed external state
```

Each integration declares a field/operation authority matrix. Jira workflow
transitions, SIEM incident status, SOAR actions, ITIL approvals, and Woo case
governance are not interchangeable `status` fields. A provider relation may
propose a Woo transition; it does not silently cause one.

### Consolidation and hierarchy

- **Duplicate tickets/cases:** an observed external `duplicate_of` relation
  may propose a Woo fold. On acceptance, move the duplicate's record block to
  the survivor, seal the old case with its tombstone edge, and record the
  rehome in both transcripts. Preserve each external identity; do not merge
  or clone writable blocks.
- **Epic/parent hierarchy:** record the provider's hierarchy separately from
  Woo `part_of`. Policy may propose corresponding case-cluster edges, but an
  epic relationship does not automatically acquire Woo rollup, audience, or
  lifecycle semantics.
- **Several records in one case:** ordinary and expected. Each block states
  why it is present through its relationship code.
- **One record relevant to several cases:** keep one canonical writable block
  in its owning case. Other cases use typed references or case edges. If
  read-only shadows are later required, mark them explicitly and never allow
  competing writers for one external record.
- **Post-seal updates:** the external system may continue changing after a
  Woo case seals. Policy admits the observation as a sealed-case addendum,
  proposes reopen, or leaves only the connector's current view updated; it
  never rewrites the sealed transcript.

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
`$external_record_block < $block`, provider record-block prototypes,
installation/factory blocks, `$work_order` dispenser generalization, and the
`$coordination` feature) with explicit `depends: [acts, chat, note, tasks,
block, dispenser, perm]`. Every class states which existing mechanism it
reuses; a class that reuses nothing is a design smell.

**Phase 2 — Gap dispositions.** Each survey gap gets an explicit layer
decision (catalog convention now / substrate roadmap / defer), so the slice
doesn't silently smuggle domain into `src/core`:

| Gap | v1 disposition | Roadmap |
|---|---|---|
| Seal/archive | workflow terminal status + perm-catalog write-deny on closed cases | substrate seal/freeze primitive, spec'd properly |
| Connector ingress | per-provider factory plugs: verify, enqueue, reconcile, then call typed verbs | shared bounded connector envelope/dedup/reconciliation contract outside domain catalogs; no provider knowledge in core |
| Connector delegation | per-record Woo apikey only if cardinality/revocation gate passes | scoped, short-lived installation-to-record-block delegation |
| SLA timers | plug-driven clock (a block whose worker polls due-times and pokes the queue) | expose scheduled-turn lane to DSL — likely the highest-value substrate ask |
| Need-to-know ACL | room membership *is* access; `.writers` on artifacts; document limits honestly | capability model (`§11.6` un-defer), driven by breach-room paper design |
| Cross-org | out of scope; single-org SOC is the v1 user; avoid contracts that assume it | federation v2 |
| Kanban | Acts-backed task/queue projection and semantic frame | — |

**Phase 3 — Evidence-producing vertical slices (build).** Keep the Acts
adoption order explicit rather than hiding v1.5 mechanics inside v1:

1. **v1, single room:** one case with Acts-backed tasks, board, journal,
   evidence, review, and approved action proposal. Include the adversarial
   fixtures from `2026-07-12-caseroom-provenance-taint-strategy.md`: labels
   survive the pipeline; no unapproved `$action_order`; the quarantine
   envelope is unspoofable. This is the kernel's case-shaped proof, not yet an
   external-system integration.
2. **v1.25, case-local connector:** bind a Jira-shaped fixture record to an
   existing case as a local block. Prove bounded refresh, webhook retry and
   missed-webhook reconciliation, an approved outbound transition through an
   outbox, conflict handling, post-seal update policy, and that no secret or
   unbounded external body enters acts. This needs no cross-room routing.
3. **v1.5, gravity:** factory plug → router (one mint, one attach, one fold)
   → provider block in the selected case → triage queue projection → second
   alert accretes as a satellite → structured rollup → gated SOAR-style action
   → spin-out → seal. Include duplicate-ticket rehome, epic-hierarchy proposal,
   poisoned correlation, and the 1k dormant-case/block cost gate.

The UI grows with the same sequence: case frame first (chat, evidence, tasks,
journal), then local external-record blocks and their status/actions, then
triage projection and cluster map.

**Phase 4 — Extract the pattern language (paper, from evidence).** Only after
the relevant slice works. Write each pattern in Alexander form — context, forces,
solution, example *from the slice*, counter-example — so it guides
domain-driven design rather than restating API docs. Seed list (mostly
*naming* mechanisms that already exist, which is exactly why extraction beats
invention):

1. **Queue-as-Projection** — registry spaces fold routed acts into bounded
   views; nothing is "in" a queue and no global enumeration is required.
2. **Lease-by-Movement (intra-case)** — physical handoff with `:acceptable`
   gating for tasks *inside* a case; case assignment is a sequenced
   relation.
3. **Grow-in-Place** — capability accretes via feature composition;
   identity and transcript never break.
4. **Sequenced Transcript is the Woo Record** — route audit-significant
   verbs via `$space:call`; distinguish the local case record from connected
   systems' independently authoritative records.
5. **Case-Local External Block** — each bound external record is a reachable
   actor in its owning case; the installation/factory stays behind the local
   interaction surface.
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

Candidate patterns 31–34 come from the connector slice: **Factory-not-
Singleton** (sharded installation boundary manufactures local bindings),
**Instantiate Authority, Never Secrets**, **External Relation Proposes
Topology**, and **Rehome, Don't Clone** (one writable block per external
record survives consolidation).

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
- **No copied provider credentials.** Prototypes and case-local record blocks
  contain behavior, identity, and bounded state; external secrets stay in the
  plug's secret store.
- **No one-ticket/one-case invariant.** Routing may attach or fold before
  minting, and one case may coordinate several external records.
- **No automatic topology mirroring.** Jira hierarchy, SIEM correlation, and
  ITIL relations are evidence and proposals until case policy accepts their
  Woo consequences.

## Open decisions (self-contained, for review)

1. ~~Case-file/case-room hybrid vs alternatives~~ — **RESOLVED 2026-07-12:
   unified.** Every case is a `$case < $room`; escalation is accretion
   (features + cluster edges), never a class transition; router fold is the
   volume valve; dormant-case cost is a measured slice gate. Rationale and
   the follow-on open decisions (tree-vs-DAG edges, rollup transport, router
   placement, dormant representation) live in
   `2026-07-12-case-gravity-unified-model.md`.
2. ~~**First slice source: SIEM alert vs helpdesk report.**~~ **RESOLVED
   2026-07-22:** neither belongs in the single-room v1 proof. Use a
   Jira-shaped fixture for the v1.25 round-trip connector contract, then SIEM
   for the v1.5 volume/router slice and SOAR for the gated-effect slice. This
   separates synchronization, correlation scale, and dangerous action.
3. **Further substrate asks?** The Acts proof has already closed its two
   narrow generic read gaps. Keep provider/domain knowledge out of core.
   Delegated connector credentials and DSL scheduling advance only if the
   per-record-key and plug-clock measurements demonstrate a generic need.
4. **Where the demo/seed placements live.** A `secops-demo` seed catalog
   depending on `secops` (recommended, mirroring the demoworld one-way
   layering rule) vs seeding inside `secops` itself.
5. **Connector delegation shape.** Can dormant per-record apikeys meet the
   cardinality, rotation, and revocation envelope, or does the installation
   principal need a new scoped delegation primitive? The latter must preserve
   the record block as the visible actor and must not grant arbitrary
   actor-impersonation.
6. **Shared external record.** Is one owning case plus typed references
   sufficient, or do real workflows require read-only shadow blocks in other
   rooms? Do not admit shadows until an archetype demonstrates that a
   case-to-case edge is inadequate.
7. **External hierarchy acceptance.** Which Jira epic/duplicate, SIEM
   incident/alert, and ITIL parent/change relationships may auto-propose or
   auto-apply Woo topology under policy? Default to proposal; earn automation
   separately for each relationship and authority boundary.
