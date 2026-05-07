# Tasks as obligation lists — a state-machine framing

## Context

We have a backlog scattered across `notes/`, specs, `~/play/keep/later/todo.txt`,
bug reports, and ad-hoc todos. The goal: a small, flexible state machine that
many agents — each with their own memory and roles — can use to pick up work,
hand it off, and yield further work as they go.

A prior note, [`2026-05-04-task-workflow-model.md`](2026-05-04-task-workflow-model.md),
frames workflows as a graph of `$space`s with tasks moving between stages and
policy attached as features. This note is an *alternative framing* at a smaller
abstraction level: each task carries its own ordered list of obligations, and
the "state" of a task is the cursor over that list. Forced role-gated handoffs
fall out of the substrate's `:acceptable` chain.

This design assumes the `$note` reshape proposed in
[`2026-05-06-note-fields.md`](2026-05-06-note-fields.md): explicit `name`
(identity / inventory listing) plus markdown `body` (content), with
`description` as a cosmetic auto-default. Field references below use that
shape. **Open: $note structure discussion** — see that note for the
migration plan and tradeoffs.

## Two prototypes

```
$task_registry < $space        # board, factory, kanban, editing surface
$task          < $note         # a work item minted by a registry
```

Both fertile. The registry is the only object that needs editing to set up a
board; the task is the only object that moves through a lifecycle.

A derived `$task_registry` overrides one verb — `:create_task` — and may mint
something other than `$task` (for instance a `$poll < $note` reusing the
registry's role/obligation machinery for a non-cursor lifecycle). Most
specializations stay within the `$task` lineage.

## What lives on `$task_registry`

```
properties:
  roles:        map<role_name → {description, owners?}>
  obligations:  map<key → {role, criterion, replaced_by?}>
  policies:     map<kind → list<key>>          # ordered policy per kind
  default_workspace?: scratch | dir:<path> | worktree

verbs:
  :create_task(kind, name, body, labels?, priority?, effort?) → minted
  :acceptable(thing)        # only takes my own children home
  :exitfunc(thing, dest)    # if a task tries to leave somewhere illegal, redirect home
  :listing(filter?)         # enumerate child tasks with summary fields, for any UI to consume
  :describe_kind(k)         # render policy with criteria
  :look                     # render the registry's roles/obligations/policies in text
```

The registry IS the catalog and IS the policy registry. They're the same
property bag and edited together. Roles, obligations, and policies are
*properties*, not objects-in-world: cheaper, simpler, still tombstone-able via
`replaced_by` on an obligation entry.

## What lives on `$task`

```
properties (in addition to $note's name, body, description, location, parent
            — see open: $note structure discussion):
  parent:       $task_registry      # immutable, set at create
  kind:         str                 # immutable
  obligations:  list<{key, met, evidence?}>   # snapshot of policy at create
  wait_for:     list<Condition>
  links:        list<{to, role}>    # parent / precondition / discovered-by / followup / relates-to
  log:          list<LogEntry>      # append-only
  priority, effort, labels

verbs:
  :acceptable(target)  # true iff target is an $actor with cursor.role,
                       # or target is self.parent
  :cursor              → resolved {key, role, criterion} via parent.obligations
  :pass(evidence?)
  :reject(i, why)
  :wait(cond)
  :yield(spec)
  :release             → moveto(self, parent)
  :drop_terminal(why)
```

**Movement is the lease.** `task.location` is who's working on it. `take` /
`give` / `drop` are the substrate's existing verbs; the cursor's role-gating
is enforced by `:acceptable`. No separate `lease` field, no separate `status`.

**Live criterion, frozen structure.** The obligation list is snapshotted at
creation (which keys, in what order). The criterion text is read live through
`parent.obligations[key].criterion`, so editing a criterion propagates to all
in-flight tasks. Tombstones via `replaced_by` if a key is retired.

## State machine

```
cursor(t)   = first o in t.obligations where ¬o.met
ready(t)    = wait_for empty ∧ ¬terminal(t) ∧ cursor(t) exists
complete(t) = all obligations met
terminal(t) = drop_terminal was called

claim:
  pre   ready(t) ∧ t.location = t.parent ∧ cursor(t).role ∈ actor.roles
  via   take t  →  moveto(t, actor)  (gated by :acceptable both sides)

step (any of pass/reject/wait/yield/release/drop_terminal):
  pre   t.location = caller
  effect log += entry; outcome-specific field change
  pass:        cursor(t).met = true; cursor(t).evidence = ev
  reject(i):   t.obligations[i].met = false  (i strictly < cursor index)
  wait(c):     t.wait_for += c
  yield(s):    t.parent:create_task(s.kind, ..., link_ctx); link both sides
  release:     moveto(t, t.parent)
  drop_terminal: terminal(t) = true; moveto(t, t.parent)
```

Invariants: one location per task; cursor advances monotonically except via
`reject`; log is append-only; `complete(t) ⇒ task is at parent`.

## How a user creates a task

A user (human or agent) holds zero, one, or many `$task_registry` objects in
their world. They have a board open — say `$bug_board < $task_registry` — and
they want to file a new bug.

**The simple way (one-liner):**

```
$bug_board:create_task("auth retry races", "intermittent 401 on token refresh", labels: [auth])
```

That's it. The registry:

1. picks `kind = "bug"` from its first policy if not given (or you pass `kind: "bug"` explicitly to disambiguate)
2. snapshots `policies["bug"]` into the new task's `obligations` list, each `met=false`
3. sets `parent = $bug_board`, `location = $bug_board`
4. logs `{actor: caller, outcome: created, ts: now}` as the first log entry
5. returns the task, which lands ready in the `$bug_board` kanban under
   "ready → triager" (because `cursor.role = triager`).

**The conversational way (in-world):**

```
@bug_board: create-task "auth retry races"
> Created T-1042 [bug]. Cursor: triage:confirm — needs a triager.
```

A `$task_registry` derivative ships a `:create_task_from_text` convenience
that infers `kind` from a tag in the title (`#bug`, `#chore`) or from the
default kind on this registry. Same minting underneath.

**From an existing source (filed bug, todo line):**

The registry can ingest. `$bug_board:create_task_from_url(url)` for a GitHub
issue, `$bug_board:create_task_from_file(path, line)` for a `todo.txt` line.
Either way it's `:create_task(...)` underneath; the source becomes a label or
a `links` entry of role `relates-to`.

**Picking the right registry:**

Every world has at least one registry visible from the user's location, and
likely several specialized ones (`$bug_board`, `$feature_board`, `$ops_board`).
The registry is the policy boundary: filing a bug into `$feature_board` is a
category error rejected at `:create_task` time (`kind ∉ self.policies`).

## How a user creates a related task while working on another

Three shapes, all from the holder of the in-progress task. The substrate
provides the verb; the registry decides what gets minted and how it's linked.

### 1. Loose spawn — "I noticed this in passing"

Independent task, no effect on the current one beyond a back-link.

```
T-1042:yield(loose, kind: "bug",
  name: "race in retry path",
  because: "saw this while reading the auth retry code")
```

Effect:

- mints a fresh task via `T-1042.parent:create_task(...)`
- adds an edge to `T-1042.links` with role `discovered-by`, pointing at the new task
- adds a back-edge on the new task with role `discovered-by`, pointing at T-1042
- the new task's first log entry includes `because: "saw this while ..."`,
  `spawned_from_obligation: implement:fix` if T-1042 was on that obligation
- T-1042 carries on; the new task lands ready in its registry's kanban

### 2. Blocking spawn — "I need to split this"

Children must finish before the parent can complete.

```
T-1042:yield(blocking, kind: "chore", name: "extract retry helper", link: "parent")
```

Effect:

- mints the child as above
- adds `links += {to: child, role: parent}` on T-1042
- adds `wait_for += {child_complete: child_id}` on T-1042
- T-1042 cannot pass any further obligation while the child is outstanding;
  the next `:pass` will refuse until `wait_for` clears

The same shape covers preconditions: a `precondition` link role for siblings
that are *not* part of the parent's scope but must finish first (e.g. a
security review).

### 3. Obligation-extending spawn — "this gap should be visible on me"

Adds an obligation to the current task, bound to the new child as evidence,
appended *after* the cursor. Makes the cross-cut visible in the role's queue
for this task, not just on the child.

```
T-1042:yield(obligation, kind: "security-review",
  obligation_key: "review:security_signed_off",
  link: "precondition")
```

Effect:

- mints the new task (a `security-review` task on whatever registry handles
  those — could be the same registry or a sibling)
- appends `{key: "review:security_signed_off", met: false, evidence: {child}}`
  to T-1042's obligations, after the cursor
- adds the precondition link both ways
- the obligation can only `:pass` once the child is `complete`

The append-after-cursor rule preserves the monotonic cursor invariant.

### Movement and acceptance during spawn

The yielding actor still holds T-1042 (its location is the actor). The newly
minted child lands at *its* registry's home, not the actor's inventory. If
the actor wants to also pick up the child immediately, they `take` it
through the same role-gated `:acceptable` check.

## Forced handoff

The substrate's `moveto(thing, target)` calls `target:acceptable(thing)`.
Both directions of the chain run:

- `target:acceptable(thing)` — does the destination accept this thing?
- `thing:acceptable(target)` — does the thing accept this destination?

For a task moving to an `$actor`:

- `$actor:acceptable(t)` — by default actors accept anything; a derived actor
  could refuse tasks of certain kinds
- `t:acceptable(actor)` — true iff `cursor(t).role ∈ actor.roles`

For a task being released:

- `$task_registry:acceptable(t)` — true iff `t.parent == self`
- `t:acceptable(parent)` — always true (parent is always a valid home)

For any other destination:

- `t:acceptable(other)` — false; movement refused

If an actor disconnects, becomes idle, or otherwise exits the world while
holding a task, the registry's `:exitfunc` (or a periodic reclaim verb)
moves the task home. "Tasks can't get lost" is just the union of those rules.

## Human-in-the-loop

No separate primitive. Two shapes already cover it:

- An obligation whose role is `human-*` (or `reviewer` held only by humans)
  parks the cursor; the queue projection `{ t : ready(t) ∧ cursor(t).role startsWith "human" }`
  is what a "needs human" tile renders.
- `wait(human-signal)` for free-floating pauses unrelated to the cursor.

A human picks up the task with the same `take` / `give` / `:pass` flow as any
agent. Humans aren't special; they're just role-holders with an interactive UI.

## Spawning, links, and shapes

`Edge` shape:

```
Edge = { to: $task, role: "parent" | "precondition" | "discovered-by" | "followup" | "relates-to" }
```

Five link roles. They differ in semantics for queries and for cancellation
behaviour, not in the machine itself:

- `parent` — child is part of parent's scope; if parent is dropped, cancel children
- `precondition` — sibling that must finish first; not in parent's scope; not cancelled with parent
- `discovered-by` — informational only
- `followup` — informational with a soft "do later" hint
- `relates-to` — soft pointer

## UI surface for humans

Kanban is **not** a property or verb on the registry — it's a UI component's
rendering and interaction discipline. The registry's job is to expose its
state honestly; the UI's job is layout, affordance, and binding interactions
to verb calls.

This section names what the model must expose, what the default kanban UI
does with it, and how human gestures (drag, reorder, edit) map to verbs.

### What the model exposes

For any UI (kanban, list, detail, graph, search) to render reactively:

- **Children enumeration.** `$task_registry:listing(filter?)` returns task
  summaries: id, name, kind, priority, effort, labels, location, age,
  cursor `{key, role, criterion}`, terminal state, wait_for shape, link
  count. Filters on kind, role, holder, labels, terminal-or-not.
- **Per-task detail.** `$task:summary` returns the same shape; `$task:full`
  adds the obligation list with met/evidence per entry, the log, and the
  resolved links.
- **Available actions for me.** `$task:available_actions(actor)` returns
  the list of verb calls this actor can legally make right now —
  computed from cursor role, lease state, and the actor's roles.
  This is what powers grayed-out / hidden buttons in the UI without each
  client re-deriving the rules.
- **Live observations.** `task_minted`, `task_claimed`, `task_passed`,
  `task_rejected`, `task_yielded`, `task_returned_home`,
  `task_dropped` emitted on the registry's space. UIs subscribe and
  refresh affected rows. Property-change observations on individual tasks
  cover inline edits.

The model never knows the UI exists. Every projection (kanban, list, graph)
is built from these four surfaces.

### Default kanban layout

Columns are derived from task state, not stored as data:

| Column | Predicate |
|---|---|
| **Ready** | `t.location = registry ∧ ¬terminal(t) ∧ wait_for empty` |
| **Waiting** | `t.location = registry ∧ wait_for non-empty` |
| **In flight** (one swim-lane per holder) | `t.location is $actor` |
| **Done** | `complete(t)` |
| **Dropped** | `terminal(t) ∧ ¬complete(t)` |

Within **Ready**, sub-group by `cursor.role` so the verifier sees their
queue distinctly from the implementer's. Within each sub-group, sort by
`priority / effort + age_bonus + tag_affinity`. Cards show: `name`,
cursor's role and obligation key, priority dot, top label or two, age.

A "needs human" tile collapses Ready entries whose `cursor.role` starts
with `human-` into a single attention-grabbing column.

### Group-by axes

A top selector switches what the columns represent. Same data,
re-bucketed; cards animate between columns.

| Group by | Columns become |
|---|---|
| **State** (default) | Ready / Waiting / In flight / Done / Dropped |
| **Role** | one per cursor role with non-empty Ready set |
| **Holder** | one per actor currently holding tasks |
| **Kind** | one per kind |
| **Priority** | bucketed P0/P1/P2/P3 |
| **Cursor obligation** | one per obligation key — granular triage |

### Filtering, paging, live updates

**Filter chips** narrow the corpus *before* grouping: actor, role, kind,
labels (multi), status (multi; defaults exclude Done/Dropped), age,
"mine" toggle. Free-text search flattens columns into a ranked list
while active.

**Paging per column.** Top N by sort; "load more" within the column.
Header shows total count even when only N are rendered.

**Live updates** reconcile against model observations. Mints slide in;
claims animate the card to the holder's lane (or fade if filtered out
under the new state); passes re-animate when grouping changes the
column; rejects flash; drops slide to Dropped/Done. Live events for
hidden tasks (filtered out, paged off-screen) update silently and post
a "+N since you opened this" badge at the column top.

### Claim as soft edit-lock

Holding a task lights up the action bar (Pass / Reject / Wait / Spawn
/ Drop) and the prominent edit affordances (inline `name`, labels).
**State-machine outcomes require the lease** — those buttons hide for
non-holders; the model enforces it. **Descriptive metadata edits**
(`name`, `body`, labels, priority) are permission-based, not
lease-based: non-holders can still edit but see a soft "you're not
holding this — Bob is" warning. Conflicts resolve last-write-wins; no
pessimistic blocking.

### Bulk select and attention tiles

Cmd-click for multi-select; a floating bar offers bulk priority change,
label add, drop-terminal. Per-card failure surfaces inline.

A "needs human" drawer is always visible on the right edge regardless
of grouping — lists tasks whose `cursor.role` starts with `human-`,
sorted by age. A "stalled / aged ready" tile pages the same way when
no role-holder is claiming work that has been ready past threshold.

### Drag / drop → verb

Every drag is a transition. The UI computes valid drop targets from the
source's `available_actions(me)` and disables the rest. Concretely:

| Drag | Verb |
|---|---|
| Ready (role I hold) → my swim-lane | `take` (`moveto(t, me)`) |
| My swim-lane → Home | `:release` |
| My swim-lane → another actor (with cursor role) | `give` |
| My swim-lane → Done column | only valid if cursor is at last obligation; otherwise refused. Otherwise: a "Pass" button is the right affordance, not a drag |
| My swim-lane → Dropped column | `:drop_terminal(reason)` (modal asks for reason) |
| Within a column, reorder | priority bump (see below) |
| Pulling a Done back into Ready | refused; use spawn-followup instead |

Drags that don't have a verb (e.g. arbitrary positions across columns) get
a hover refusal cue. The UI doesn't invent transitions the model rejects.

### Buttons / explicit actions

Some transitions are bad as drags because they need extra input:

- **Pass** — a button on the held task. Opens a small modal: optional
  evidence (commit hash, a link, free text). Calls `:pass(evidence)`.
  Advances the cursor; if that was the last obligation, the task slides
  into Done.
- **Reject** — a button visible to actors holding the cursor role *after*
  any earlier obligation. Opens a picker over satisfied obligations and a
  "why" field. Calls `:reject(i, why)`. The chosen obligation flips
  `met = false`; cursor rewinds.
- **Wait** — a button to add a `wait_for` condition without leaving the
  cursor. Opens a picker (other-task / approval-name / external-signal).
- **Spawn** — opens the spawn modal: shape (loose / blocking /
  obligation-extending), kind, link role, `because` text. On submit
  calls `:yield(spec)` and creates the appropriate links.
- **Drop** — terminal abandonment. Modal asks for reason; calls
  `:drop_terminal`.

### Reordering and priority

Within a column, **drag-to-reorder** updates the task's `priority` so its
new rank-by-priority matches the drop position. There is no separate
"manual order" list on the model; drag-reorder is just inline priority
editing. Two constraints:

- The default sort is `priority / effort + age + tag_affinity`. Drag
  bumps `priority`; effort/age stay the same. The UI may re-rank
  immediately even if the new value would land slightly off — the model
  is the truth.
- If a viewer wants their own pinned order (different from the global
  rank), that's a **per-user UI preference**, stored on the user's view
  config, not on the task. The model stays canonical.

### Inline edit

Editable fields, by writability tier:

| Field | Editor |
|---|---|
| `name`, `body` | task author or registry owners |
| `labels` | author, holder (current lease), or owners |
| `priority`, `effort` | author, holder, or owners |
| `kind` | nobody — immutable |
| `obligations[*].met / evidence` | only via `:pass` / `:reject` / overrides |
| Registry's `roles` / `obligations` / `policies` maps | registry owners only |

Inline edits are property writes; observations propagate the changes to
every connected UI. The state machine is untouched.

### Compose new

The "+ New task" affordance opens a form: kind picker (drawn from
`registry.policies`), name, optional body (markdown), labels, priority,
effort. Submit calls `:create_task(...)`. The new card lands in Ready
under its `cursor.role` sub-group. (UI may label the `name` field
"Title" since that's the familiar UX term; the model field is `name`.)

For tasks composed *while another is held* (the related-task case), the
Spawn button is preferred — it carries `because` context and link
metadata that plain `:create_task` does not.

### Other views — same surface, different layout

The same `:listing` + per-task `:summary` is enough to power:

- **List view.** Flat sortable table; useful for triage and bulk editing.
- **My queue.** `t : ready(t) ∧ cursor.role ∈ me.roles ∧ lease = none`
  for me to claim, plus `t : t.location = me` for tasks I already hold.
- **Backlog aging.** Ready tasks sorted by age — to spot work nobody is
  picking up.
- **Health view.** The pathology queries from the next section, each
  rendered as a tile with its matching task list.
- **Detail view.** One task in focus: header, obligation list with
  criteria and evidence, log timeline, links graph, action bar of
  `available_actions(me)`.
- **Graph view.** Tasks as nodes, links as edges, coloured by registry
  and shaped by kind. Useful for understanding decomposition / spawn
  patterns. Cheap; just `:listing` + edge enumeration.

### Notifications

A UI for an actor with claimed tasks should surface state events that
affect them: a task they hold gets `reject`ed (something they passed has
been undone elsewhere — though `reject` rewinds *before* cursor by
definition, so this only happens if they were holding earlier and
re-take), a task they're `wait_for`ing on completes, an `override:*`
operation runs on a task they own. Reuse the standard $space observation
chain; the UI subscribes once.

### What's deliberately UI-only

- **Column definitions.** The UI decides what counts as a column.
- **Sort order within column.** The default exists, but the UI can
  honour user preference.
- **Pinned task order per viewer.** Lives in user view config, not on
  tasks.
- **Filtering chips.** UI state. Persisted in browser, not in the world.
- **Card density / colour scheme.** Pure rendering.
- **Undo of UI gestures.** The model's audit log is authoritative; UI
  may offer a soft undo that issues compensating verbs (e.g.
  released-by-mistake → re-take), but every "undo" is a real verb
  call, not a hidden state revert.

## Health view

Pathologies are queries on the same model. None require new fields:

| Symptom | Query |
|---|---|
| Stalled lease | `t.location is $actor ∧ now - t.last_change > T` |
| Awaiting human | `ready(t) ∧ cursor(t).role startsWith "human"` |
| Dead wait | `t.wait_for contains a terminal/dropped task` |
| Aged ready | `ready(t) ∧ now - t.last_change > T'` |
| Reject loop | `count(reject events on obligation_i) > K` |
| Spawn explosion | `depth(t.links via parent) > N` |
| Backpressure | `count(ready ∧ cursor.role = R)` |

`last_change` is a denormalized timestamp on the task, updated by every step.
Cheap; avoids walking the log.

## Intervention model

Every intervention is a `step`-like operation, logged with the human as actor
and an `override:*` outcome. Audit trail is automatic.

- `reclaim(t)` — clear a stale lease (often automated)
- `override_pass(t, i)` — wizard marks an obligation met; evidence reason mandatory
- `override_reject(t, i)` — wizard rewinds beyond what a reviewer would
- `override_drop(t)` — terminal abandonment
- `override_clear_wait(t, c)` — a wait that will never fire
- `override_extend(t, [keys])` — append obligations after cursor
- `override_relink(t, edge_change)` — fix wrong parent / precondition
- `reassign_lease(t, actor)` — take from one, give to another (must hold cursor role)

Permission gating is whatever the surrounding world enforces (registry owners,
wizard role, task author). The model just records who did what.

## Comparison with Hermes Kanban v1

Hermes ships a working dispatcher with a flat status enum and free-form tasks;
their `workflow_template_id` and `current_step_key` columns are reserved for v2
to add exactly the structure this note proposes. Things to take from Hermes if
we build:

- per-attempt **runs** records (a row per claim/release cycle with summary,
  metadata, evidence) — richer than our log alone
- explicit **workspace** (`scratch | dir:<path> | worktree`) on the task,
  allocated at claim, torn down at terminal
- a real **dispatcher** loop (timer-based reclaim of stale leases, promotion
  of `ready` tasks, spawn-failure circuit breaker)
- a `blocked` queue projection even though the model doesn't store an enum

Things this model adds that Hermes defers:

- role-gated handoff at the obligation level (their assignee is a profile name; nothing forces a verifier to be different from the worker)
- `reject` as a first-class transition with a defined rewind semantics
- kind → obligation list as an authored recipe, single source of truth
- HITL with no extra primitive (just role membership)

## Relation to `$block` / `$dispenser_block` — the factory contract

`$block` is the **bridge between worlds**: an anchored actor whose external
plug authenticates and pushes data into the block's `writable_self` surface.
`$dispenser_block` is a `$block` subclass that adds a **factory + queue**
shape on top of the bridge — `:order` tickets a request, the plug delivers
later, and a `$dispensed_note` is minted to the requester's inventory.

`$task_registry` is a different point in the design space: a factory
*without* the bridge. The work is done by in-world agents handing tasks
across roles, not by an external plug. The minted thing is a
multi-actor, multi-handoff `$task`, not a one-shot artifact.

So the family tree is:

```
$block               ← bridges to outside worlds (plug pushes data)
  └─ $dispenser_block ← + factory + queue + delivers an artifact
$task_registry       ← factory + multi-actor lifecycle (no bridge)
```

`$dispenser_block` and `$task_registry` are siblings *with respect to factory
behavior*; they differ on what they bridge to (an external plug vs. a
community of role-holders) and on what the minted thing's lifecycle looks
like (one-shot deliver vs. cursor-driven handoff).

### The shared factory contract

Both objects must implement the same set of concerns at the entry point and
around their children. Names them once so future factories don't reinvent:

| Concern | Shape |
|---|---|
| **Idempotency** | Caller-supplied dedup key on the create/order verb; re-issued requests are no-ops |
| **Per-requester rate limit** | Minimum interval between requests by the same caller |
| **Entrypoint cooldown** | Minimum interval between any two requests, regardless of caller |
| **Payload bounds** | Max size of a request; max depth of pending/ready set |
| **Acceptance narrowing** | `:acceptable(thing)` true iff `thing.parent == self`; no foreign children |
| **Children come home** | `:exitfunc(thing, dest)` redirects to `self` if `dest` is illegal |
| **Audit of mints** | Append-only log of `{verb, requester, child, ts, key?}` |
| **Sequenced observation** | `*_minted` / `*_returned_home` observations on the right cadence |
| **Lifecycle hooks** | `:on_create_request`, `:on_mint`, `:on_release`, `:on_terminal` as override seams |
| **Released/Reclaimed semantics** | What happens when a held child is dropped, the holder disconnects, or a hold becomes stale |

`$dispenser_block` already implements most of these for the queue case
(`rate_limit_seconds`, `block_cooldown_seconds`, `max_pending_orders`,
`max_request_chars`, idempotent `:deliver`, `order_placed` / `delivered`
observations). `$task_registry` should implement the same set, with the
specifics adapted to its lifecycle:

- `:create_task` runs the same admission checks (idempotency key,
  per-requester rate limit, cooldown, payload bounds) before minting.
- `:acceptable` and `:exitfunc` enforce the "tasks come home" property.
- The mint log is the registry's own audit, separate from per-task logs.
- `task_minted` / `task_returned_home` are sequenced observations.
- `:on_release(child)` runs whenever a held task lands back at the registry
  (drop, disconnect, idle reclaim) — the place to clear a stale lease, push
  a `released` log entry, and notify the kanban view.

### Why a feature, not a base class

The bridge / non-bridge split forces an inheritance choice:

```
$dispenser_block < $block          (a fixed object in a room)
$task_registry  < $space           (a container with contents/presence)
```

`$block` and `$space` are siblings. A `$factory < ?` parent class would have
to live above the divergence and become so generic it loses its meaning, or
force one of the two out of its natural lineage. Single-inheritance is the
constraint.

The right tool in woo is a **feature/attachment**, the same mechanism
already used by `$conversational` and the May-04 stage features. A
`$factory_behavior` feature contributes the contract above as verbs and
properties; both `$dispenser_block` and `$task_registry` *attach* it without
sharing a parent class:

```
$factory_behavior   (feature)
  properties:  rate_limit_seconds, block_cooldown_seconds,
               max_pending, max_request_chars, last_request_at,
               last_mint_at, audit, seen_keys
  verbs:       :check_admission(requester, payload, key?)
               :record_mint(requester, child, key?)
               :acceptable_child(child)
               :exitfunc(child, dest)               -- redirect home if illegal
               :on_release(child)                   -- moveto child to self
               :emit_mint_observation(child)
               :on_create_request, :on_mint, :on_terminal  (default no-ops)
```

### Not yet — but name it now

We have two examples (`$dispenser_block`, `$task_registry`). The rule of
three says wait for a third independent factory before extracting; the
seams will be wrong otherwise — most likely around `:on_release` and the
queued-vs-cursor distinction.

Concrete plan:

1. Document the contract above as the normative checklist for any factory.
2. Build `$task_registry` implementing it locally; copy helpers from
   `$dispenser_block` where the code is identical. Tolerate ~50 lines of
   duplication.
3. When a third factory pattern shows up (`$ledger`, `$recipe_book`,
   `$generator`, …), extract `$factory_behavior` from the now-real seams.

The cheap version is *naming* the contract; the expensive version is
*mechanizing* it. Name it now; mechanize when reality forces it.

## Comparison with the May-04 workflow-of-spaces note

| Aspect | May-04 workflow model | This note |
|---|---|---|
| Where state lives | Task's `location` (a `$stage`) | Task's `obligations[]` cursor; `location` is the lease |
| Where policy lives | Features attached to stages | Properties on the registry |
| Cross-cutting | Stack features at a stage | Spawn sibling tasks, linked by `wait_for` |
| Substrate dependency | Heavy: spaces, features, `moveto` | Light: only `moveto` and acceptance chain |
| Sweet spot | In-world coordination workflows | Backlog grinder; agents picking from a queue |

Both can coexist. The cleaner long-term position is to drop the
workflow-of-spaces machinery and use this; the May-04 idea was a useful
exploration but adds more substrate weight for the same outcomes.

## Open questions

- **`$note` structure.** This design uses `name` (identity / inventory) +
  `body` (markdown content) on the parent `$note`. That reshape is itself
  open — see [`2026-05-06-note-fields.md`](2026-05-06-note-fields.md) for
  the proposal, the migration plan, and the four options compared.
  Resolution there is a prerequisite to landing the model here as
  written.
- **Reject scope.** When the verifier rejects, can they rewind further than the
  immediately-prior obligation? Default: any earlier obligation; they name it.
- **One registry or many.** Default: many (per board / per team). Tasks are
  always scoped to their parent registry. Cross-registry spawns are normal —
  T-1042 in `$bug_board` can yield a `security-review` task whose parent is
  `$security_board`. Links cross registries freely.
- **Workspace allocation.** A registry's `default_workspace` could allocate a
  worktree at `:claim` and tear it down at `terminal`. Hermes-style. Worth
  grafting on later.
- **Per-attempt runs.** A `runs[]` list on the task (or sibling table) with
  one entry per claim/release cycle. Adds structured re-entry context.
- **Memory.** Per-agent memory is orthogonal. Tasks don't carry it; agents do.
  The log is the shared record.

## Smallest working slice

1. Define `$task_registry < $space` and `$task < $note` in a `tasks` catalog.
2. Implement the verbs above. The state machine is ~150 lines of woocode.
3. Hand-author one registry instance, `$bug_board`, with stock roles
   (`triager`, `implementer`, `reviewer`, `verifier`) and stock policies
   (`bug`, `chore`, `feature`, `refactor`, `spike`).
4. One agent harness that subscribes to registry changes, queries
   `ready` tasks for its roles, calls `take`, runs, calls `:pass`/`:reject`/etc.
5. The kanban projection is the existing `$taskspace` view, generalized to
   render obligation-cursor state.

Everything else — selection scoring, idle reclaim, external `wait_for`
conditions, history queries, dashboards — is incremental on the same shape.
