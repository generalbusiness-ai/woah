# Acts kernel: one record, many work surfaces

*Origin: 2026-07-21; compacted after two review rounds the same day.
Historical design note. The accepted contract is now normative in
[`spec/semantics/acts.md`](../spec/semantics/acts.md). This note records the
prototype reasoning and evidence; where wording differs, the spec governs.
Defines the content model for "the work"
in a room — schema-validated acts on the sequenced log, work surfaces
derived as projections — as four contracts plus one thin vertical
slice (Tasks on `$case`). Rationale, composition model, meta-process,
and deferred extensions live in the companion note
[`2026-07-21-acts-composition-vision.md`](2026-07-21-acts-composition-vision.md).*

*Builds on `2026-07-12-case-gravity-unified-model.md` (case = room) and
`2026-07-12-security-caserooms-design-approach.md`.*

*Prototype status (2026-07-21, worktree branch `worktree-acts-kernel`):
the kernel proof is BUILT and green on the in-memory lane — both core
seams (`event_schema` builtin; `ts` on `replay()`), the `acts` catalog
(`$acts` feature, `$projection` + `:rebuild_from`, `$task_board`,
`$case` domain verbs, journal-as-log-read), and
`tests/acts-kernel.test.ts` covering lifecycle, emission-authority
refusals, fail-closed atomicity (a refused fold rolls back the minted
artifact with the turn — verified), and the rebuild invariant. `npm
test` green. Implementation findings folded into the sketches below:
fold input carries the envelope seq (§2.4); `$space` instances own-seed
`features: []`, so the `$acts` feature mounts per instance at
`:initialize` while a class-level attach satisfies the installer's
static this-call resolution. RETARGET (user decision, same day): **Outliner replaces
Tasks as the first real migration target** — user-ready, its net repair
loop is the model's motivating bug, and the facade note already chose
it as the client's first adopter; casework keeps the tasks-shaped
proof. **Dispenser migrates next as the first plug-backed consumer;
Tasks follows.** Split landed: `acts` is the generic
kernel; `casework` is the temporary proof catalog. Outliner phase 1
landed (validated guarded emission on the five structural verbs against
the existing `outline_item_*` schemas; unions/null earned in the shape
vocabulary; `:act` tolerates consumers without projections; wire shape
now envelopes payload — client reducers migrate in the adoption chunk
and must tolerate both shapes for aged deployed definitions; the
`enterfunc` capture echo stays a plain observe because it can run under
another space's turn — cross-space capture emission is a v1.5 routing
question). Tier C first data (in-memory): act turn 1.31×/1.20×
baseline p50/p99 — inside the ≤1.5× proposal; +0.32ms per extra fold
(~6% vs ~5% target); storage ~224 B/row, 228KB whole-map rewrite at
1000 rows. RESOLVED (2026-07-22): the outliner tree question landed as
a **relation-checkpoint projection** — `$outline_meta` consumes the
five structural acts, keeps no rows (the `__ordered_edge` relation
stays the current-state authority; carve-out 3 in §1), and
`$outliner:tree_view` returns the substrate tree plus the
`structure_at_seq` checkpoint; undo's `_restore_item` re-emits the
added act so restores advance it. Legacy genesis is empty by construction:
deployed relations remain authoritative, the checkpoint begins at 0, and
the first v3 structural act makes it current. RESOLVED (2026-07-22): Net
replay reads exact pages from the semantic room's Scope authority; that
authority durably appends accepted sequenced entries with its seq/ts, and
pages participate in normal local-or-attested read validation. A fresh
`$outline_meta` rebuild converges to the live watermark through a sparse
Net planner, while real workerd proves the same durable page repair over
SQLite/RPC (26/26). RESOLVED (2026-07-22): Outliner client adoption uses the
generic semantic-view facade over `tree_view`; full structural parity, legacy
genesis, stale-read rejection, and deletion accounting are pinned. Outstanding:
the Dispenser and Tasks migrations and E4/E5 gate. Tier C's Outliner read/fanout
lane is now concrete: real workerd/Net, 1,000 rows, eight principals, three Act
invalidation waves; warm p50/p95 92/101 ms, 145,485–145,491-byte responses,
32–36 ms mutation-to-all-seven-peer-push (276–278-byte Act frames), and
904–928 ms invalidation-to-current wall time (p95 928 ms), inside the declared
1.5 s / 512 KiB / 5 s pilot budgets. Two generic Net corrections were required
to make that claim honest: direct semantic reads validate without committing a
new scope head, and byte-identical repeated cell reads collapse to one wire
proof. The ordered queue is §7.1.*

---

## 1. The lever and the one rule

A case is not a room plus a task registry plus a board plus a timeline,
each keeping its own version of the work. It has one durable spine: the
room's sequenced log of typed, schema-validated acts. A task list,
kanban board, queue, timeline, digest, or audit view is a projection of
that spine. The discipline is one sentence:

> **Every stored row of coordination state is written by exactly one
> path: a projection fold over an act, applied inside the same
> sequenced turn that recorded the act.** No verb writes a membership
> list, status, order, or assignment directly; no read ever
> scans-and-recomputes.

Three things remain object-authoritative by design, and projections
must not mirror them:

1. **Artifact content** — `$note` name/description/text. Acts reference
   documents; rows never copy their fields.
2. **Physical location** — the substrate `moveto` relation (the tasks
   lease). Rows never store a holder; reads derive it (§5.2).
3. **Substrate-owned relations** — e.g. the outliner's
   `__ordered_edge`, written directly by the domain verbs and read
   through owner-computed builtins (`object_tree_rows`,
   `ordered_children`/`ordered_neighbors`). The relation already has
   exactly one writer per fact; a projection that folded the same acts
   into its own rows would be the second authority. Projections
   **checkpoint** such relations (a *relation-checkpoint projection*:
   watermark + any act-derived indexes the relation can't answer) and
   never copy them.

Substrate backing: `$sequenced_log` atomic append (SL2), per-entry
recorded `observations` (`SpaceLogEntry`, src/core/types.ts:579), the
outer behavior savepoint around sequenced dispatch
(src/core/world.ts:4594), deterministic replay (SL3), snapshots.

The invariant, per projection — scoped to **projection-owned state**
(`rows` plus auxiliary fold state; NOT the carve-outs above, which the
fold never writes and a rebuild therefore never reconstructs):

```
fold(recorded acts since the projection's seed, in (seq,index) order) == rows
```

For a relation-checkpoint projection this reads: rebuilding the
recorded acts reconstructs the *checkpoint*, not the relation — the
relation stays the current-state authority, while the act log is the
semantic/audit authority for acted transitions.

Rebuild input is the **recorded** observations — never re-execution of
verbs. Verb changes cannot invalidate a projection; only fold changes
can, and v1 forbids in-place fold changes (a fold change is a new
catalog version re-seeding the projection).

Why this rule: every recorded work-surface sync bug is two authorities
for one fact — the outliner E_BUDGET repair loop, the contents-order
mismatch, the pinboard peer-share failure. Tasks shows the pattern at
rest: `_tracked_tasks`, per-task `log` props, and `valid()`-guarded scans,
even though its verbs already emit act-shaped observations. The kernel
does not invent another record; it makes that record authoritative and
turns every other representation into a fold.

---

## 2. The four contracts

### 2.1 Act

```
{ "type": "tasks.claimed",     // namespace.name
  "version": 1,                // schema version, immutable per version
  "payload": { "task": #123, "holder": #45 } }
```

The **envelope is the log entry**: room, seq, actor, timestamp, verb
provenance — never duplicated into the body. **Act identity is
(room, seq, index)**: the act's position among act-typed observations
in the committed entry's `observations` array. No ordinal field, no
per-turn counter, no transient state; anything that needs identity
(routing, dedupe — deferred) enumerates the committed array after
acceptance.

### 2.2 Schema

V1 uses the event-schema mechanism that already exists: manifest
`schemas` entries have the current `{on, type, shape}` form, and
emission resolves the shape through the case's class/feature chain.
Every v1 act is an internal domain act at schema version 1. Public
emission, rollup metadata, multiple live versions, supersedes edges,
and actor-declared schemas are extensions, not kernel prerequisites.
Lookup precedence matches verb dispatch: the case/class chain first,
then features in declared order. The proof catalog declares each type
once.

V1 act validation uses a closed, flat subset of the existing shape
vocabulary: `obj`, `str`, `bool`, `int`, `float`, `num`, `list`, and
`map`. Every declared key is required; undeclared keys are refused.
Optional/union tags, typed collections, nested shapes, and
class-constrained refs remain advisory until an act needs them.

Schema lookup needs one small, generic core completion: implement the
introspection spec's existing `event_schema(obj, type) -> shape`
builtin. `world.schemas()` currently exposes names only
(`src/core/world.ts:2877`), although the installer already persists the
shapes. No manifest change and no installer change are needed for the
proof slice.

Catalog epochs make the installed shape immutable while an epoch is
active (CO15). During the proof, changing a shape or fold means a new
catalog version and a fresh projection. Reseeding a live projection
is deliberately deferred until one real migration requires it.

### 2.3 Projection

```
consumes: [act types]
:fold(act)    — deterministic given (projection state, act); sole writer
                of ALL projection state; O(payload); no foreign reads;
                no wall clock; must update at_seq from act["seq"]
:view(opts)   — the one authoritative bounded read
                → { page, at_seq, has_more }
:rebuild_from(space, from_seq)
              — operator rebuild: re-folds recorded acts (skipping
                failed entries), never re-executes verbs; owner/wizard
rows          — keyed map prop; row_cap (v1 default 1000); overflow
                policy is refuse (raise), which aborts the act's turn
at_seq        — seq of the last folded act; view pins completeness to it
```

**Auxiliary fold state is permitted** (decided by the Tier B.3 trial,
which hit this immediately): a projection may keep fold-private state
beside `rows` — e.g. a per-task index when the consumed payloads don't
carry the row key's dimension — provided the fold is the sole writer of
*all* of it. The rebuild invariant quantifies over the whole projection
state, not just the viewed rows, and the conformance test asserts both.
The alternative (denormalizing payloads so every act carries every
dimension) is refused: payload shapes serve the domain fact, not any
particular projection. **Every auxiliary structure declares its own cap
and retention policy** (review finding 3): `$kind_lanes.task_states` is
bounded by `aux_cap` (E_QUOTA refuse) and evicted on the terminal
transition — safe only because the domain state machine refuses
transitions out of terminal phases. Auxiliary write amplification is
part of the Tier C storage measurement.

Contract points sharpened by the prototype review (2026-07-21):

- **`at_seq` means "seq of the last act this projection consumed"** — a
  conservative completeness watermark, not the room's head seq. Two
  projections on one room legitimately show different `at_seq` after a
  turn only one of them consumes.
- **`:rebuild_from` is incremental, idempotent, and bounded**: it
  resumes past `max(at_seq, rebuild_scan_seq)`, processes one replay
  page per call, and returns `{at_seq, scanned_seq, done}` for caller
  loops. Repeated calls never double-fold (the first cut double-counted
  on a second call — caught by review). Reset/reseed of a non-pristine
  projection belongs to the deferred genesis replacement, not rebuild.
- **`:view` pages with a continuation cursor** (`opts.after` = previous
  page's `cursor`; a stale cursor yields an empty page).
- **Exact payload typing**: a `"str"` field refuses live object refs
  (refs are strings at the VM level; an object must not pass as a
  code/label) and `"obj"` requires a live ref.

**Same-anchor, trusted, bounded, fail-closed:**

- *Same-anchor*: the projection lives in the case's anchor cluster, so
  SL2 atomicity covers fold writes. Enforced at seed.
- *Trusted*: v1 projections come only from catalog seed. `rows`,
  `consumes`, `row_cap`, and the case's `projections` property use
  `perms ""`; only catalog-author code can write them. There is no
  dynamic attach surface; attach authority, genesis records, and
  blue-green fold replacement are deferred extensions.
- *Fail-closed*: **any fold failure aborts the entire turn.** The
  existing outer savepoint rolls back the act, all fold writes, and
  the domain verb's physical effects together — correct atomicity for
  free. There is no catch, no stall state, no partial-mutation hazard
  (Woo has no nested savepoint, so a caught raise would commit half a
  fold's writes), and no contradiction between "raise to refuse"
  (E_QUOTA on row_cap) and act durability: a refused act leaves
  nothing, including no physical move. Isolation machinery returns
  only if/when untrusted user-authored projections are admitted.

Timestamps: rows store **seqs** (`opened_seq`, `last_change_seq`),
never times. `:view()` resolves times from the corresponding log
entries for the requested page and computes ages there — folds stay
deterministic with no clock access and no timestamp duplication. This
requires one read-surface completion: include the log entry's already
persisted `ts` in `$space:replay()` results; the native wrapper
currently omits it.

### 2.4 Space-local emission

The stateless `$acts` feature supplies one internal primitive; mounted
on a case, its effective surface is `$case:act`. v1 has no public
emission surface (actor-namespace `emit_act` is deferred):

```
verb :act(type, payload) rx {
  /* INTERNAL: not direct-callable, not a command, not tool-exposed.
     Frame-global guards (src/core/dsl-compiler.ts:122); direct routes
     carry seq == -1 (src/core/world.ts:4426), so seq >= 1 proves a
     sequenced entry, space == this proves it is THIS room's log, and
     caller == this restricts emission to this room's own verbs. */
  if (seq < 1 || space != this) {
    raise { code: "E_INVARG", message: "acts require a sequenced turn on this room" };
  }
  if (caller != this) {
    raise { code: "E_PERM", message: "acts are emitted by room verbs only" };
  }
  let d = event_schema(this, type);        /* §2.2 core completion */
  if (d == null) {
    raise { code: "E_INVARG", message: "unknown act type", value: type };
  }
  this:_validate_payload(d, payload);      /* flat shape check */
  let act = { "type": type, "version": 1, "payload": payload };
  /* Folds receive the act plus its envelope seq, injected here (live)
     or by :rebuild_from (recorded). The observed act body stays free of
     envelope fields — the log entry is the envelope. */
  let fold_input = { "type": type, "version": 1, "payload": payload, "seq": seq };
  for p in this.projections {
    if (type in p.consumes) { p:fold(fold_input); }  /* no catch: fail-closed */
  }
  observe(act);                            /* recorded in this entry */
  return act;
}
```

*(Prototype 2026-07-21: the fold-input injection above is load-bearing —
a fold that reads the `seq` frame global instead cannot be rebuilt
outside a sequenced turn, and the rebuild-invariant test catches it.)*

One outer transaction; no recovery state. State-transition logic lives
on the case. Public task verbs keep today's object-shaped UX, but become
thin delegates: `$task:claim()` calls
`this.registry:_claim_task(this)`, and the case verb validates the board
row, requires `caller == task` and `task.registry == case`, performs the
lease move, then calls `this:act(...)`. The nested
call into `:act` therefore has `caller == case`; task objects never
receive a general emission capability. Every domain fact is emitted by
the case verb that performed the transition.

`this.projections` and the schema set are **program configuration**,
like verbs and features — not coordination state, and not self-folded
(the first draft's self-projecting kernel registry was conceptual
overfitting). v1 seeds them from the catalog; management verbs are
deferred with dynamic attachment.

### 2.5 Provenance: authority in the envelope, trust on the content

The log envelope is the unforgeable authority record: actor, target,
verb, room, and sequence say who caused the act and through which
trusted program. The act body does not repeat that information and has
no caller-supplied trust label. A payload field named `provenance` is
ordinary data; it cannot alter the envelope.

Content trust remains where the secops strategy put it: on artifacts
(E1 tamper-proof labels, E2 taint-at-ingress). Acts and board rows carry
artifact refs. Unbounded human or external prose must be an artifact,
not an inline act string; inline strings are bounded identifiers or
codes validated by their domain verb. This prevents a structurally
authentic `tasks.closed` act from laundering an attacker-controlled
explanation through a field intended for an outcome code.

The proof exposes exactly two E4 mediated reads: `board:view()` joins
artifact fields such as `task.name`, and `case.journal()` renders a
paged, filtered act stream. Both dereference artifacts through their
author-authority accessor and serialize external/derived text in the
E4 quarantine envelope. Public actor emission remains deferred;
before it ships, consumers must derive its authority class from the
committed envelope and referenced artifacts, never from a payload
label.

---

## 3. The `$case` v1 slice

Two catalog layers keep the dependency line clean. `acts` has no
domain or UI dependencies; it supplies `$projection` and the stateless
`$acts` feature (`:act`, `_validate_payload`). The proof catalog defines
`$case < $room`, mounts `$acts` plus Tasks, and depends on `[acts, chat,
note, dispenser, perm]`. It exercises the target Tasks representation
in fresh worlds. Scope, exactly:

1. catalog-seeded domain schemas (manifest `schemas` block, §2.2);
2. internal domain emission (§2.4);
3. the `tasks.board` projection (§5);
4. `case.journal(from_seq, frame_limit, types)` as one bounded
   `$space:replay()` page filtered to acts; its cursor advances by
   frames, not matches. The log already is the journal, so a journal
   fold would only duplicate it;
5. one propose → approve → deliver path composed from the existing
   dispenser and permission mechanisms, so the E5 adversarial gate is
   real rather than vacuous; the acts kernel owns none of it;
6. fail-closed atomicity throughout;
7. Tasks field-disposition and behavior-parity tests (§5.3).

The proof claim is deliberately small:

> For every successful lifecycle turn, its log entry contains the
> complete ordered act set for that transition, and the board rows
> equal its fold. Artifact content and task location remain unmirrored.
> For every rejected or failed sequenced turn, the failed call outcome
> remains in the log, but no act observation, board mutation, or
> physical effect survives.

Scope notes:

- **v1 agents contribute through domain verbs only** (claim, pass,
  propose) — they have no free emission surface until `emit_act`
  (vision §5.1), and their tool surface is the case's `tool_exposed`
  verbs (E6 least-location, unchanged).
- **`$task_registry` target disposition**: tasks schemas + board become
  mountable on `$case`; the registry survives as a case-shaped policy
  author (roles/obligations/policies), without list-prop storage. The
  proof exercises this representation only in fresh cases.
- **The proof slice creates fresh cases only.** It does not upgrade an
  installed Tasks world. Replacing the bundled Tasks representation is
  a separate major-version rollout: specify an idempotent baseline act
  or equivalent genesis rule, ship the required catalog migration, and
  exercise it on local SQLite before claiming upgrade safety. The proof
  must not smuggle that unresolved migration into its invariant.
- **The secops slice narrows to single-room scope for v1** (one case:
  board, journal, adversarial fixtures). Router, triage/team queue
  projections, rollup, and adoption edges all depend on cross-room
  routing — promoted to the named **v1.5** milestone (vision §5.3),
  not silently assumed.

Deferred, with designs recorded in the vision note: actor-declared
schemas and public `emit_act`; **v1.5** — cross-room act routing with
the router-as-space redesign and queue projections; dynamic projection
attachment; genesis/blue-green fold replacement; stall/repair
isolation; facade view generation; practice adoption/metrics
machinery; `case.digest`.

---

## 4. Manifest schemas (real shape)

```json
"schemas": [
  { "on": "$case", "type": "tasks.opened",
    "shape": { "task": "obj", "kind": "str", "labels": "list",
               "obligations": "list" } },
  { "on": "$case", "type": "tasks.claimed",
    "shape": { "task": "obj", "holder": "obj" } },
  { "on": "$case", "type": "tasks.passed",
    "shape": { "task": "obj", "obligation": "str" } },
  { "on": "$case", "type": "tasks.closed",
    "shape": { "task": "obj", "outcome_code": "str" } }
]
```

(Also: `tasks.handed_off`, `tasks.released`, `tasks.rejected`,
`tasks.waiting`, `tasks.wait_cleared`, `tasks.linked`,
`tasks.dropped` — same form.) This is the existing manifest shape; v1
adds no schema metadata.

---

## 5. The Tasks proof

### 5.1 What stays

Verb surface (`claim/handoff/release/pass/reject/wait/yield/drop`),
movement-as-lease with `transition_intent`/`:acceptable` gating, and
the obligation-cursor semantics. `$task < $note` keeps: `name`,
`description`, `text` (artifact content), its location (the lease),
and `registry`. Every task stays anchored to its case while location
changes, keeping board folds and bounded joins inside one anchor
cluster.

### 5.2 Board rows: coordination state only

```
rows[task_id] = {
  "task": <ref>,
  "kind": str, "labels": list,
  "obligations": list,          // snapshotted at open, cursor advanced
  "waits": list, "links": list,
  "phase": "active" | "closed" | "dropped",
  "opened_seq": int, "last_change_seq": int
}
```

No `name` (artifact content), no `holder`/`claimed` (physical
location), no timestamps (§2.3). `:view(args)` joins per requested
page — bounded by page size: `task.name`, `location(task)` (→ derived
holder: claimed iff location ≠ the case), resolved times/ages from the
`*_seq` entries, and the computed cursor role. There is no
lease-agreement invariant to maintain **because there is only one
lease fact** — the join reads it.

**Domain verbs validate lifecycle transitions against the board row,
not physical facts alone — this is contract, enforced now** (review
finding 1, 2026-07-21: the first cut's `claim` checked only location,
and since `close_task` returns the task home, close→claim committed
`{phase: closed, claimed: true}`). Every lifecycle verb reads the
authoritative row (`$case:_board_row`) and refuses `E_TRANSITION` out
of terminal phases. Fold defensiveness against "impossible" sequences
is therefore *not* a substitute for the domain state machine; folds may
still guard, but the domain refuses first — and terminal-phase
enforcement is what makes auxiliary-state eviction (§2.3) safe.

Fold sketch (illustrative):

```
verb :fold(act) rx {
  let ty = act["type"]; let p = act["payload"];
  if (ty == "tasks.opened") {
    if (length(this.rows) >= this.row_cap) {
      raise { code: "E_QUOTA", message: "board row cap" };  /* aborts turn */
    }
    this.rows[tostr(p["task"])] = {
      "task": p["task"], "kind": p["kind"], "labels": p["labels"],
      "obligations": p["obligations"], "waits": [], "links": [],
      "phase": "active", "opened_seq": act["seq"], "last_change_seq": act["seq"] };
  } else if (ty == "tasks.passed") {
    /* mark p["obligation"] met in row obligations */
  } else if (ty == "tasks.closed") {
    /* phase = "closed" */
  }
  /* claimed/handed_off/released touch only last_change_seq: the lease
     move is the authoritative fact; waiting/linked update their lists */
  let row = this.rows[tostr(p["task"])];
  row["last_change_seq"] = act["seq"];
  this.rows[tostr(p["task"])] = row;
}
```

*(Prototype note: the DSL has function-scoped locals — no shadowing —
`args` is a reserved frame-global name, and map mutation goes through a
local with whole-property write-back; the working fold is in
`catalogs/acts/manifest.json` on the `acts-kernel` worktree branch.)*

### 5.3 Field disposition and parity

| Today | Under acts |
|---|---|
| `_tracked_tasks` registry list prop | gone — board rows are the roster |
| per-task `obligations`/`wait_for`/`links`/`terminal`/`labels`/`kind` props | board row fields |
| per-task `log` list prop | gone — recorded acts |
| `created_at`/`last_change` props | `opened_seq`/`last_change_seq` + view-time resolution |
| `:listing` scan | `board:view()` |
| `observe({type:"task_created",…})` fire-and-forget | `this:act("tasks.opened", …)` |

Every lifecycle verb emits its act in the same turn as its physical
effect; a lifecycle verb with no act is a review-blocking defect.

Parity tests:

1. **Listing golden**: `board:view()` (with joins) supplies every
   field of today's `:listing` contract — task, name, kind, labels,
   location, cursor_role, wait_for_count, terminal, complete,
   link_count, age, last_change — asserted against the current
   implementation's output shape.
2. **Rebuild**: `fold(recorded acts) == rows` after the full scripted
   lifecycle; repeated after mutating a lifecycle verb's source
   (rebuild is execution-independent).

---

## 6. Gates

1. **Rebuild and write authority** — §5.3(2), per projection; direct
   writes to rows or projection configuration are refused even for the
   owning actor.
2. **Core read seams**: `event_schema()` obeys class/feature precedence
   and returns a defensive copy of the installed shape; `replay()`
   includes the persisted `ts` without changing pagination.
3. **Emission authority**: unsequenced (direct) `:act` refused;
   non-room caller refused; sequenced call on another room's log
   (`space != this`) refused; unknown type refused. Each refusal
   leaves no act observation and no row. A direct refusal creates no
   log entry; a refusal reached through a sequenced call remains as a
   failed entry containing only its error outcome.
4. **Fail-closed atomicity**: a raising fold (E_QUOTA at row_cap; an
   induced error) aborts the whole turn — the failed call entry remains,
   but it records no act observation, writes no row, and applies **no
   physical move**. Kill-between-append-and-commit leaves no
   half-materialized state (SL2; test it anyway).
5. **Tasks parity golden** — §5.3(1), after every lifecycle verb.
6. **Bounds**: row_cap refusal behavior; act-rate ceiling measured on
   the workerd lane (one case, board + journal reads, scripted
   lifecycle load) and recorded as a stated budget — hot-room turn
   cost is the system's known binding constraint (NC8).
7. **Client regression**: kanban renders from `board:view()`; peer
   mutation visible cross-user (the pinboard failure as a named
   regression test). Act observations do **not** route to the chat
   panel: they land in the generic observation surface unless a
   `ChatFormatterRegistry` entry opts a type in — asserted, so the old
   both-lists lesson doesn't resurface as chat noise.
8. **Cold-case cost**: 1k bare cases, without a tasks projection,
   remain cold. The proof case receives its board at seed; dynamic
   accretion is not part of v1.
9. **Adversarial (E4/E5 lane, merged from the provenance strategy)**:
   fixtures seed a labeled task artifact whose `name` carries prompt
   injection and forged envelope delimiters. Assert: the act carries
   only its artifact ref; `board:view()` and `case.journal` serve the
   text only in the E4 quarantine envelope (embedded delimiters escaped
   or nonce-wrapped); injection in a bounded identifier/code field is
   refused; an undeclared `provenance` key is refused, while any
   schema-declared field with that name remains inert data and cannot
   alter the log envelope; and poisoned input may at worst produce a
   proposal — no `$action_order` is approved or delivered, and no
   external effect occurs without the human approval required by E5.
   (Poisoned-correlation fixtures belong to the v1.5 router gates.)

## 7. Adoption queue and deferred decisions

### 7.1 Ordered adoption queue

Net replay is complete: a sparse planner repairs from the semantic room's
durable authority log; the exact Outliner rebuild test and real-workerd
storage/RPC lane are green. Outliner closure is also complete: the generic
reactive semantic-view facade now reads `tree_view`, parity is pinned after
every structural verb, and an upgraded outline with pre-v3 rows is pinned at
`structure_at_seq: 0` with no minted projection. Deletion accounting is honest:
the element lost its item hydrator, four generation/scheduling fields, and
three item-hydration methods, replaced by one shared `WooViewController`; the
catalog UI file is nevertheless +21 physical lines (146 added/125 removed)
because it now owns the view declaration/result validator and closes the
previously missed `note_writers_changed` path. The useful delta is eight
bespoke lifecycle concepts removed and one shared controller added, not a
claimed net-LoC reduction.

1. **Migrate Dispenser.** Keep Net-authenticated `:order`, `:deliver`, and
   `:cancel` as the public surface; emit fixed acts internally; replace the
   directly-written queue and admission maps with `$dispenser_queue`; carry
   the delivered note by reference; and prove dropped-reply idempotency,
   legacy genesis, full-state rebuild, deterministic rotating-requester
   eviction, an absolute queue cap, zero extra queue writers, and a net
   deletion delta. The field disposition and non-goals are explicit in
   [`catalogs/dispenser/DESIGN.md`](../catalogs/dispenser/DESIGN.md#acts-migration-next-major).
2. **Migrate Tasks.** Retire the temporary casework proof through the full
   field-disposition, parity-golden, client-kanban, and deletion-delta gates
   in §5.
3. **Close the remaining release gates.** Run the E4/E5 adversarial lane,
   cold-case measurement, and workerd Tier C budgets.

### 7.2 Kernel decisions deferred

1. **Shape-language depth**: flat key → type-tag now; when
   optionality/nesting/class-constrained refs are needed, does
   validation stay woocode (`_validate_payload`) or become generic.
2. **Rows storage**: map-prop write amplification is O(rows) per act —
   acceptable under row_cap; substrate per-row relation storage is the
   model's first substrate ask, adopted later behind the `view()`
   seam.
3. **Per-task history**: filtered journal (`payload.task == t`) needs
   an index or per-key retention to stay bounded — decide when the
   task detail panel is built.

---

## 8. Measuring success

The gates (§6) prove the kernel *correct*; they do not prove the lever
*worth it*. The prototype answers three questions, in tiers, plus
names its own falsifiers.

**Tier B.3 RESULT (2026-07-21, worktree branch, commit `cdb09fb`)**: a
fresh agent — inputs restricted to this note, the installed manifest,
the test harness, and the DSL spec; no kernel-implementation access —
authored `$kind_lanes` (per-kind lane counts). **Green on the first
run, zero fix iterations, zero edits to existing classes/verbs/schemas**
— the zero-new-writers composition claim held, and the fold it wrote is
contract-clean (sole writer, injected seq, state-machine guards making
crafted/repeat act sequences idempotent). Its insufficiency report
drove note corrections: the auxiliary-fold-state decision (§2.3, the
one genuine contract gap — it hit it immediately), `at_seq` and
`:rebuild_from`/`:view` shapes added to the §2.3 contract, and the
§5.2 sketch's frame-global-seq bug (found independently by the rebuild
test). **Scope of the claim, precisely** (prototype review): the trial proves
*fold-authoring* composition — no domain verbs, schemas, or existing
folds changed. It does **not** yet prove *installable package*
composition: the trial attached `$kind_lanes` via privileged test-only
`world.setProp` against the protected `projections` property. That half
of the claim waits on dynamic attachment (vision §5.2) or catalog-seed
delivery of a second projection. A follow-up review round
(2026-07-21, commit `2f40e71`) closed three contract defects the proof
exposed — the domain state machine (close→claim was committable),
rebuild idempotence/boundedness, and auxiliary-state caps+eviction —
all now in §2.3/§5.2 and tested; fold defensiveness is thereby *not* a
substitute for domain enforcement, which is stated as contract.

### 8.1 Tier A — correct (binary)

All §6 gates pass on both lanes (in-memory and workerd). Necessary,
not sufficient.

### 8.2 Tier B — the lever pays (comparative; the actual point)

1. **Deletion delta.** The migrated tasks catalog is *net smaller*
   than today's (excluding the `acts` kernel itself, which is shared
   infrastructure), and the drift-defense inventory goes to zero:
   `_tracked_tasks`, per-task `log` props, `valid()`-guarded scans,
   and the kanban's bespoke hydration controller all deleted. Metric:
   LoC and concept count before/after, plus write-paths-per-
   coordination-fact — which must be exactly 1, checked by reading
   every property write in the migrated manifest.
2. **The motivating bug class cannot be reproduced.** A concurrency
   hammer on the workerd net lane — 3–5 actors driving ~100 mixed
   lifecycle acts against one case — produces: zero repair loops or
   non-convergent reads (the outliner failure shape), and all clients
   converging to identical rows at the same `at_seq` (the pinboard
   failure shape). This is the strongest claim the design makes;
   test it under fire, not just in unit gates.
3. **The second surface is cheap — and teachable.** After the board
   passes, add one more projection (per-kind lane counts, or a small
   digest): zero domain-verb edits, zero edits to existing folds,
   small (order ~50 lines of woocode) — and authored by someone or
   something *other than the kernel's author, working only from this
   note*. An agent authoring it from the note is the ideal form: that
   measures the pattern-language goal directly (review iterations to
   a correct fold is the score).

### 8.3 Tier C — budgets recorded (numbers, not pass/fail)

**First data (2026-07-21, in-memory lane, `scripts/bench-acts-kernel.ts`,
n=300/config — relative indicators; workerd produces the budgets):**
baseline `say` turn p50 3.91ms / p99 6.80ms; `open_task` with the board
fold p50 5.11ms / p99 8.12ms (**1.31× / 1.20× baseline — inside the
≤1.5× proposal**); adding the second projection costs ~0.32ms/turn
(**~6% marginal fold cost vs the ~5% target — close, and now measured**).
Storage: ~224 B/row linear; at 1000 rows each act rewrites ~228KB — the
whole-map write amplification quantified, confirming per-row relation
storage as the first substrate ask. (claim/close pair samples were
single-shot and noisy; measure properly on workerd.)

Recorded as stated budgets that set the v1.5 envelope:

- Act-emitting turn cost p50/p99 with the board mounted, against a
  bare sequenced-turn baseline on the same lane. Acceptance proposal:
  ≤1.5× baseline p99, and fold cost ≤ ~5% of the turn budget
  (headroom for more projections). Hot-room turn cost is the known
  binding constraint (NC8) — this number is the one that matters.
- `board:view()` page read vs. today's `:listing` scan — should win
  or tie.
- Storage: bytes/act-entry, bytes/row, and observed per-act write
  amplification at 10/100/1000 rows (the map-prop cost curve that
  motivates deferred decision 2).
- The act-rate knee (gate 6) and the 1k-cold-cases result (gate 8).

### 8.4 Discipline and decision yield

- **Core-change count.** The design claims exactly two generic read
  seams (`event_schema`, `ts` on `replay()`). Success = no third core
  change; any additional core edit is a *discovered seam*, documented
  with its layering justification, and counts against the "small
  generic completion" claim.
- **Deferred decisions get evidence.** The prototype resolves §7.2(1)
  (where shape validation lives) from experience, and produces the
  measured cost curve for §7.2(2).

### 8.5 Falsifiers (outcomes that revise or kill)

- The migrated tasks catalog is *bigger or hairier* than today's —
  the lever fails its own simplification claim.
- Fold overhead pushes hot-room p99 materially past baseline — the
  fold-dispatch design needs the native hook before v1.5, or the
  model retreats to fewer, coarser projections.
- View-time joins (name/location/ts per page row) blow the read
  budget at normal page sizes — the carve-out rule needs a cache
  design it currently refuses.
- The rebuild invariant is *flaky* (a determinism leak in fold or
  replay) — stop; that is a kernel contract bug, not a tuning issue.
- The closed flat shape subset cannot express the tasks payloads —
  the shape language earns richness earlier than planned.
