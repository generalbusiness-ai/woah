# Acts: composition model, change model, and deferred extensions

*Origin: 2026-07-21. Companion to
[`2026-07-21-acts-projection-model.md`](2026-07-21-acts-projection-model.md)
(the kernel contracts and first slice). This note carries the rationale
and vision: why acts are the application-layer composition model, how
change lands in each layer, the practice meta-process, the red-team
findings, and the designs for extensions the kernel deliberately
defers. Nothing here is v1 scope.*

---

## 1. The composition model (the reconciler question)

Prompted by: "the react reconciler gave you a spine you could attach
components against… unsure what that is for agents yet. skills? what's
even the composition model there?"

React's load-bearing gift was the *element* — a tiny universal IR that
everything compiles to and one runtime reconciles against the world.
Skills-as-markdown have no IR, which is why agent-framework composition
feels unsolved: two skills have no shared medium their outputs meet in.
In woo the medium exists — the sequenced log:

| woo | React |
|---|---|
| act | element (the IR) |
| feature (vocabulary + projections + verbs + norms) | component |
| grow-in-place mount | component mounting |
| cluster topology; act routing along edges | the tree; propagation |
| fold dispatch + relation pipeline | reconciler/renderer |

**In-room composition**: features mount on a space and contribute act
types, projections, verbs, and prose norms. Each fold owns its rows, so
features cannot write-conflict; the only hazard is semantic vocabulary
overlap, and inter-feature dependencies are declared act types — the
dependency graph is data. A new surface is a new fold over existing
acts: zero new writers.

**Cross-room composition** (deferred; design in §5.3): acts propagate
along cluster edges, landing as acts in the destination's log, folded
there. Queues and team boards are registry-space projections fed by
routed acts — gravity G4 made mechanical. The model is the same at
every level: local folds, act routing along edges, folds again.

**The skills answer**: yes, the world should contain the procedural
knowledge that agent-skills represent, on a hardening gradient — prose
norm an agent reads → workflow `requires` predicate → deterministic
verb — with the act vocabulary as the stable interface while the
implementation migrates code-ward (the `native()` → woocode
direction-of-travel discipline, one level up). A skill is a feature
package; the library workstream is skill discovery; export is skill
portability; in-world editability is skill evolution in the place where
it is used. Domain-specificity — what makes real skills valuable — is
what location-scoped tool surfaces already provide.

**The agent role statement** maps onto the spine: "manage the growing
context" = emit topology and digest acts (`spin_out`, `fold_into`,
`context.digest_written` referencing a minted summary note) —
compaction with a durable, social, auditable form. "Build runtime
infrastructure for the next thing" = move an act's handling down the
hardening gradient while the act type stays fixed.

## 2. How change lands, per layer

| Layer | A change is… | It lands as… | Guarded by… |
|---|---|---|---|
| Substrate (`src/core`) | VM/log/transport semantics | git + spec + deploy | test lanes, smoke ladder |
| Acts kernel | schema/emission/fold-dispatch semantics | catalog version + migration table | catalog tests; the world audits, never executes |
| Catalog practice code | verbs, schemas, folds | version bump; seed/epoch machinery on net | migration decision table; export/library round trip |
| In-world practice objects | builder schemas, folds, verbs, policies | ordinary sequenced mutations (extensibility WS1) | ownership, quota, transcript |
| Per-room configuration | mounted features, schema set, norms notes | sequenced management calls, recorded in the log | ownership; later workflow predicates |
| The work | acts on case logs | the base mechanism | schema validation, emission authority, folds |

The bottom four rows are one mechanism at increasing stability; the
cost of change is proportional to the stability of the layer it lands
in, every layer's change is transcripted with provenance, and the
conveyor between layers — prose → predicate → verb, in-world → catalog
— is operated by the same case machinery it carries.

Supporting rules:

- **Rebuild is execution-independent** (kernel §2.1): recorded
  observations are the rebuild input, so verb changes never invalidate
  projections; old acts are data. Frames stamping verb provenance
  (plus source hash) make "which version of the practice handled this
  case" a data query — process archaeology with the same evidence
  quality as the work itself, unrecoverable in Jira-config-land or
  skill-markdown-land.
- **Folds are replaced, never mutated.** v1: a fold change is a new
  catalog version re-seeding the projection. Later (§5.2): genesis-
  based blue-green replacement in place.
- **Schemas ride the supersedes edge**: additive = new version;
  breaking = new type + `supersedes` + catalog migration entry.
  Promotion of an in-world schema to a catalog is a rename edge, not a
  migration cliff. A vocabulary-lint projection makes drift visible
  in-world.

## 3. The meta-process: practices

"Discover best practice and iterate it" runs on the same rails. A
**practice** is a thing in the world:

- **Package**: a feature — vocabulary + projections + verbs + norms
  note (its current position on the hardening gradient).
- **Home**: a library entry (`spec/catalogs/library.md`) plus a home
  room. Mounting the practice on a room creates an *adoption edge* to
  the home.
- **Discovery** = instrumentation-by-vocabulary: the practice ships its
  own `practice.metrics` projection (cycle time per obligation,
  rejection rate, prose-escalation frequency — the best signal that a
  norm wants hardening into a verb). Metric and feedback acts route
  along adoption edges to the home — the gravity cluster topology
  reused, structure-travels-chatter-stays verbatim. The home room is a
  coordination center whose satellites are its adoption sites.
- **Iteration** = an improvement `$case` whose subject is the
  practice's library entry, evidence = routed metrics
  (provenance-chained), work products = sequenced edits to the
  practice's objects. Review is an approval workflow on that case:
  promotion gated by `requires` predicates (*rebuild invariant passes*,
  *N adoption-days at version*).
- **Rollout** = per-room `practice.upgraded {from, to}` acts —
  mechanically the fold-replacement dance. Version skew is a projection
  over adoption edges. Canary = upgrade one room, watch its metrics
  against the fleet. Rollback is the same act reversed.
- **Extraction** = a `spin_out` variant whose deliverable is a feature
  package seeded from the originating case's actual vocabulary usage,
  with the transcript linked as the pattern's Alexander-form example —
  the secops Phase-4 anti-goal ("no pattern without a working example")
  made a permanent mechanism.

The recursion grounds out: improving the improvement process is another
practice. The fixed point is case tooling improving case tooling — the
outer reflective layer is not a second system watching the first; it is
this system, standing one room over.

**Where it honestly does not close**: the acts kernel cannot rewrite
itself while running, and the substrate is git-land. The world hosts
the *deliberation, evidence, and audit* of changes at those layers; the
execution vector is the ordinary catalog/deploy path. This matches
spec-is-source-of-truth rather than fighting it.

## 4. Where it breaks (red-team)

**Perf first, at exactly the place the system already breaks; storage
second, through write amplification rather than volume; expressiveness
holds best, with three named walls.**

**Perf.** Every act adds validation + fold fan-out to a sequenced turn
on a single-threaded lane (space.md §S9). NC8's original 2026-07-20
bake (hot-room wall p99 2920ms against the then-500ms target, without
fold machinery) established that hot-room turn cost is the binding
constraint. Main now batches the durable `/fanout` lane and evaluates
it under the re-scoped p95 ≤750ms / p99 ≤5s envelope. The first Acts
canary predates that batching, so its 513/1944/2634ms p50/p95/p99 is
not an Acts-overhead result; the merged fanout mechanisms must be
remeasured before attribution. Rules, not hopes: **acts are for coordination-rate facts**
(~1/s sustained per room; machine-rate signals aggregate at ingress —
the router's occurrence-ledger, gravity G1, is the pressure valve);
rollup fan-in makes coordination centers the bottleneck (batching,
`rollup` reserved for low-rate types, digest coalescing at
satellites); a budget-exhausting fold fails the write, hence the
payload-or-declared-cap fold contract and measured act-rate ceilings (kernel gate
5). The mitigation backlog is the same backlog NC8 already owes —
one instrumentation effort, not two.

**Storage.** Rows-as-one-map-prop is O(rows) write amplification per
act — tolerable only under row_cap; substrate per-row relation storage
is the model's first substrate ask, adopted behind the `view()` seam.
A `*`-consuming journal fold would duplicate the whole log into a prop
(struck in the first draft; the journal is a paged log read). Log
truncation (SL3) bounds rebuild to the projection's seed horizon —
honest, and the audit plane (spec/operations/audit.md, hash-chained R2
segments) retains the full stream: **in-world projections are
prospective; the audit plane is retrospective.** k projections ≈ k×
state; hence the per-room cap.

**Expressiveness.** (1) No cross-room atomicity: rules spanning rooms
are convergence properties with compensation acts, never invariants —
Big-World discipline showing through; some Jira-class transactional
guarantees can only be converged upon; the pattern language must say
so. (2) Projections are prospective; ad-hoc historical queries
("all acts by actor X across cases") are global enumeration, refused —
the audit plane is the escape hatch. (3) Upcasters accumulate in
folds: rebuild hands old payloads to today's fold; a replacement whose
seed post-dates the old versions is the shedding mechanism.

Net: nothing breaks the core claim — single-writer folds over recorded
acts. What breaks is treating acts as free events (perf), map-props as
a database (storage), or rooms as a query engine (expressiveness).

## 5. Deferred extensions (designs on record)

Each is coherent, none is a kernel prerequisite. Review lessons that
shaped them are noted — they are constraints on the future design, not
history for its own sake.

### 5.1 Actor emission and in-world schemas

Public `emit_act(type, payload)` (sequenced, tool-exposed) restricted
to descriptors with `emission: "actor"` **and** an actor-owned
namespace prefix — agents record digests and custom-vocabulary acts;
domain facts remain forgery-proof behind domain verbs. In-world
`declare_schema` mints actor-namespaced descriptors through the same
introspection surface the kernel reads; promotion to catalog is the
export path with `supersedes`. Open: team namespace grants (interacts
with `$team` being partial).

### 5.2 Dynamic attachment, genesis, blue-green fold replacement

Attach/detach as authorized sequenced management verbs. Every
attachment records a genesis: `{since, seed, seed_basis: "empty" |
{projection, at_seq}, fold_hash, schema_ids}`. Rebuild invariant from
genesis; late attach is honest-empty or seeded from a named basis;
v1→v2 replacement seeds from v1's rows at cutover and equivalence is
claimed from the basis onward; `fold_hash` makes in-place fold
mutation detectable. Required before user-authored or practice-shipped
projections can arrive at runtime.

### 5.3 Cross-room act routing — the named **v1.5** milestone

Promoted from an open-ended deferral to a named milestone, because the
secops slice beyond one room is stranded without it: router,
triage/team queues, rollup, and practice adoption edges all depend on
it. v1 secops is single-room scope; v1.5 is this section, built as one
piece.

**Routing contract.** Unit of routing: the ordered batch of routable
acts from one origin entry, enumerated from the committed
`observations` array (identity `(room, seq, index)` — never an ordinal
in the act body). Delivery at-least-once via the outbox lane; effect
exactly-once by identity key; per-origin order preserved; `path`
hop-cap and cycle refusal. Routed acts land as acts in the destination
log with origin identity in the payload envelope. This makes registry
queues, rollup (structure travels, chatter stays), and adoption edges
mechanical.

**Router redesign (fixing a one-rule violation in the gravity note).**
G1's TTL'd correlation indexes were directly-written coordination
state — the very pattern the kernel forbids. Corrected: the router is
an `$ingress_space < $space` whose log records ingestion acts
(`ingest.received`, `ingest.minted`, `ingest.attached`,
`ingest.folded`), and the **correlation index is a projection** — rows
`{key → case ref, seen_at_seq}`, folded from those acts. TTL falls out
naturally: folds have no clock, so expiry is view-time filtering by
entry timestamp, with optional sweep acts on the CO16 scheduled-turn
lane when rows must actually be evicted. Poisoned-correlation
adversarial fixtures (attacker-shaped alert engineered to attach to an
existing case) gate here: router decisions are inspectable acts with
the triggering event's `external` ref in the chain.

**Case birth.** `:act` requires a sequenced turn on the case's own log
with `caller == this`, so the router cannot emit the case's opening
act. Sequence: the router's mint verb creates the case (inert seed
state), records `ingest.minted` on its own log, and issues a sequenced
call to the new case's `:open(...)` domain verb via the outbox — which
emits `case.opened` as the case's first entry. The pre-open window is
inert by construction and ordered by the lane.

**SLA timers** (minor, recorded so it doesn't vanish): ages resolved
at view time cannot *fire* anything. Breach detection needs sweep/timer
acts on the CO16 scheduled-turn lane (or the plug-clock stand-in from
the approach note's Phase 2) emitting `sla.breached` into the case —
another projection consumer, not a new mechanism.

### 5.4 Fold-failure isolation (stall/repair)

Deliberately **absent** from the kernel: v1 is fail-closed (any fold
failure aborts the turn) because (a) Woo has only the outer behavior
savepoint (src/core/world.ts:4594) — a caught raise would commit a
half-mutated projection; and (b) quarantine-on-raise contradicts
raise-to-refuse: a board raising E_QUOTA to refuse an act must abort
the turn, not stall the board while the act's physical effects commit
— that would recreate the exact two-authority split the model removes.
If untrusted projections are ever admitted, isolation needs a nested
savepoint or pure-return reducers (fold returns new rows; kernel
installs on success) — choose then, with this contradiction as the
test case.

### 5.5 Facade view generation

For projection-backed views, the client semantic-view facade
registration (read = `view()`, invalidateOn = `consumes`, completeness
pinned to `at_seq`) is derived from the projection declaration by an
explicit generation step in the catalog UI module. This amends the
2026-07-16 facade note (which specifies hand-registered definitions);
the amendment lands there when this extension is built. Stalled/error
surfaces map to the facade's error-with-last-data state.

### 5.6 `case.digest` and practice metrics

Bounded summary folds (fixed key set): open counts, latest finding,
last activity — the agent-orientation surface on entry, and the
per-practice metrics feed (§3). Deferred only because the slice must
stay thin; both are ordinary projections with nothing novel.

### 5.7 Migration order: outliner → dispenser → tasks → rest

Stated so the sequence is a decision, not drift:

1. **Outliner** — landed as the first real consumer. Its structural
   relation remains substrate-authoritative; the acts projection supplies
   the completeness checkpoint without mirroring tree rows.
2. **Dispenser** — landed as the first plug-backed consumer. Its typed Net
   verbs emit from the anchored block onto the containing room log; the plug
   never emits raw acts. One bounded projection owns pending membership,
   order allocation, admission indexes, and terminal receipts. Delivery
   preallocates a room-anchored note, the plug fills it directly, and the
   sequenced transition records only that reference. SQLite v0 genesis, dropped-reply
   idempotency, adversarial authority, fail-closed artifact rollback, and a
   meaningful sparse-Net rebuild are covered. Approval and failure acts wait
   for a real policy transition rather than being invented by the base class.
3. **Tasks** — next. The temporary casework slice has proved the kernel; the
   real migration must prove full field disposition, state-machine parity,
   client Kanban conversion, E4/E5 approval safety, and deletion delta.
4. **Workflows** — `workflows.md` predates acts: `:set_status` writes
   a status prop directly. It should emit `workflow.status_changed`
   acts (status becomes a fold target), which matters doubly because
   the practice-promotion workflow (§3) leans on exactly those
   predicates. Spec amendment lands when the acts contracts promote.
5. **Rest** (pinboard order state and later coordination surfaces) — each
   per the same playbook, opportunistically.

### 5.8 Pattern-language additions (acts era)

Extending the secops seed list (1–23; same rule — none ships without a
working example):

24. **Act-as-IR** — the schema'd act is the composition medium;
    features meet in the log, not in each other's state.
25. **Single-Writer Fold** — every coordination row has exactly one
    writer: a fold in the emitting turn.
26. **Fail-Closed Turn** — a fold failure aborts act, rows, and
    physical effects together; refusal-by-raise is the overflow
    contract.
27. **View-Time Join** — carve-outs (artifact content, physical
    location) are read at view time, never mirrored into rows.
28. **Journal-is-the-Log** — never materialize a copy of the whole
    log; page it.
29. **Index-as-Projection** — correlation/lookup state folds from
    ingestion acts; TTL is view-time filtering or sweep acts (§5.3).
30. **Status-is-an-Act** — lifecycle state is fold-derived from
    sequenced status acts, never a directly-written property (§5.7).

## 6. Requirements on the in-world editing surface

The acts design mostly *de-risks* the `prog` surface, then imposes a
short list of obligations. What it gives for free: execution-
independent rebuild means live verb editing cannot corrupt history
(old acts are data; every projection stays rebuildable through any
verb rewrite), and the emission guards make the REPL harmless to
domain facts (`$programmer:eval` runs unpersisted on a direct route —
`seq == -1` and `caller != this` both hold — so eval'd code reads
everything and forges nothing).

Requirements, ordered by when they bite:

**v1 (with the kernel slice):**

1. **Fold discipline awareness**: verbs marked as folds refuse the
   plain `edit_verb` path (in-place fold change is forbidden); the
   editor points at the catalog-version route now, and later offers
   genesis replacement (§5.2) as a first-class fork-seed-cutover flow.
   `fold_hash` detects violations; the editor prevents them.
2. **Fold purity lint at `install_verb`** for fold-class verbs: refuse
   `now()`/`random()`/foreign reads — the in-world analog of the
   repo's guard scripts.
3. **Vocabulary introspection in examine**: a builder or agent
   standing in a room sees its act types, shapes, versions, emission
   modes (the `event_schema` surface). The vocabulary is the room's
   interface documentation; the editor is where it is read.
4. **Edits land on the right log, legibly**: room configuration
   (attach/mount/declare) sequences on the room's log; class code
   edits land on the class's owning scope. Every edit answers "whose
   transcript records this."
5. **The editor is an E4 mediated read path**: board/journal/payload
   display in the editor uses the same labeled-value accessors and
   quarantine enveloping as `view()` — one bare-string editor panel
   is the forgotten accessor.

**v1.5+ (with dynamic attachment and `declare_schema`):**

6. **Fold preview harness**: run a candidate fold over recorded acts
   in a read-only sandbox, show resulting rows before attach — cheap
   because rebuild is execution-independent. Doubles as the
   rebuild-invariant checker and the review evidence for practice
   promotion. (Eval provides compute-without-persistence; this adds
   bounded log read + rows-copy.)
7. **Schema version immutability at the surface**: re-editing an
   emitted-against version's shape is refused; the flow mints v2.

**The deepest requirement — staged edits, organized around
complete-feature packages.** `edit_verb` today installs immediately;
the practices loop wants agents drafting folds, verbs, and schema
revisions, agent output is `derived` (E3), and installed *code* is the
ultimate effector (T3). Rather than staging individual edits, the unit
of proposal/review/install is the **feature package** (vocabulary +
projections + verbs + norms). This collapses four lifecycles into one:

- a *proposal* is a draft version of a package — coherent by
  construction, `derived`-labeled, inert until mounted;
- *review* is practice promotion (§3): purity lint, fold preview over
  recorded acts, rebuild invariant — run against the package, so the
  reviewer sees the whole capability, never a lone verb diff;
- *install* is a mount/upgrade — one sequenced management act per
  room, which *is* the §5.2 genesis replacement flow, atomic and
  fail-closed; the interface check (room vocabulary satisfies the
  package's `consumes`/depends) happens once, at mount;
- *export/library/catalog* serialize and promote the same unit.

Consequences, accepted: installed objects are never edited — you edit
the draft of the next version (per-verb staging metadata is replaced
by a live/draft distinction; `fold_hash` shrinks to a mount-time
check; the discipline mirrors Net epoch immutability, CO15, and the
tap-repositioning "bundle composition" insight at room scale, with no
epoch machinery because room-mounted definitions are ordinary object
state). Small-change friction lands exactly where the hardening
gradient wants it: prose norms are artifacts, edited directly, free;
room policy is sequenced config acts; code is a package version —
friction proportional to authority, the §2 change-model enforced
rather than described. The approval boundary is **room ownership**,
not the machinery: eval and the preview harness install nothing and
stay free, builders mount their own drafts in their own spaces without
review; approval binds only where authority is shared. The draft's
concrete form is the export set (EX1–EX10) held as an in-world
workspace object tree — the export artifact becomes the working
representation, not output-only, and mounting reuses its
reference-classification and install path.

Net symmetry: the design has exactly two IRs — the **act** (unit of
work) and the **feature package** (unit of capability change) —
completing the React mapping honestly: element and component, and
mounting a component is literally mounting a package.
`edit_verb`-on-a-shared-room disappears as a concept; the editing
surface edits drafts and mounts packages.

**UX principles: preserving dynamic mutability.** The package
discipline costs the live-tinkering experience only if the UX is
careless (noted 2026-07-21). Principles, binding on the surface:

1. **Hot reload in owned space.** Draft auto-mounts on every save in
   rooms you own — you experience editing the live thing; the package
   boundary is invisible until the sharing boundary. (React's own
   arc: the component model didn't kill liveness; Fast Refresh
   restored it atop the disciplined unit.)
2. **Ambient versioning.** No "cut a version" gesture in flow; every
   save is a draft revision, and a version crystallizes automatically
   at the sharing boundary, system-named. Ceremony proportional to
   audience; zero at audience-of-one.
3. **Edit-in-place as a gesture.** In a shared room, "edit this verb"
   opens the next version's draft pre-seeded with current source —
   one gesture, a redirect never perceived as a refusal.
4. **Personal overlay, honest limit.** Read paths, previews, and
   direct/eval calls can route through your draft per-session (the
   fold preview harness is the read half). Shared authority cannot be
   overlaid — sequenced acts are real for everyone or no one — and
   that limit is the design's point (E5), not a UX defect.
5. **Prose and config stay hot everywhere.** The friction gradient
   keeps norms/policy/room-shaping as direct live edits; the everyday
   "world is clay" experience lives mostly there, untouched.
6. **Witnessed change beats silent change.** In shared rooms, a mount
   is an act in the transcript — "Alice mounted tasks v3" is seen,
   inspectable, rollbackable. LambdaMOO's silent verb swaps were
   disorienting in shared spaces; converting mutation from silent to
   witnessed makes the shared world feel more alive, not less.

**Bookkeeping**: fold-written rows charge the projection owner's
storage quota (rows grow from other actors' acts), so attaching a
projection is a standing quota commitment the editor should surface
as projected cost.
