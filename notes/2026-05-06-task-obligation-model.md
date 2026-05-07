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

This design builds on `$note` as implemented in
[`catalogs/note/manifest.json`](../catalogs/note/manifest.json). The
relevant slots `$task` inherits:

- `name` — listing identity / inventory token (inherited from `$root`).
  Bounded inventory titles are computed by `:title()`, which renders
  `name + ": " + first-line-preview` via `:text_summary`.
- `description` — inherited cosmetic look-at flavour (from `$thing`);
  notes leave it empty by default.
- `text: str` — a single string (markdown-by-convention, default `""`),
  `perms ""` (verb-only access). Public read goes through `:text()`
  (gated by `:is_readable_by`); bounded display goes through
  `:text_summary(limit)` which returns `{lines, preview, truncated}`
  by splitting on `\n` internally. There is no per-property hard cap
  on note text storage today; effective bounds come from the per-frame
  VM `max_memory` budget.

Edit paths: `:set_text(body)` (replace; requires a string, raises
`E_INVARG` otherwise), `:write(line)` (append a line, joining with
`\n`), `:erase` (clear to `""`), `:delete(line)` (remove one 1-based
line — the verb splits on `\n`, drops the line, joins the rest),
`:add_writer(who)` / `:rm_writer(who)` (manage `.writers`). All edit
paths gate on `:is_writable_by`.

Substrate consumers that fan out across many notes (room/inventory
titles, match-name expansion) pass a `max_chars` hint to `dispatch(...)`
to bound per-call cost.

`$task` inherits this single-string shape directly. UIs that present a
markdown textarea pass the textarea contents straight to
`registry:create_task(...)` or `task:set_text(...)`. v1 ships no
markdown convenience layer — the
task uses `$note`'s edit verbs verbatim.

Field references below use this shape.

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
  obligations:  map<key → {role, criterion}>
  policies:     map<kind → list<key>>          # ordered policy per kind

verbs:
  :create_task(kind, name, text, labels?, source?) → minted
                            # text is the markdown body — a single string
                            # passed through to $note:set_text. Sort/group
                            # keys like priority and effort are policy-defined,
                            # not core arguments. source is an opaque
                            # provenance pointer (URL, ticket id, free text)
                            # stored on the task and surfaced by UIs;
                            # see "DO placement" below for v1 placement.
  :acceptable(thing)        # only takes my own children home
  :exitfunc(thing, dest)    # if a task tries to leave somewhere illegal, redirect home
  :listing(filter?)         # enumerate child tasks with summary fields,
                            # by scanning self.contents for $task instances
                            # that match the filter. Cheap when tasks are
                            # colocated (the v1 default).
  :available_actions(t, actor) → list   # legal verbs for this actor right now
  :holds_role(actor, name) → bool
                            # registry-scoped membership predicate. True iff
                            # actor is in roles[name].owners (or is wizard).
                            # The single source of truth for "does this actor
                            # hold this role on this registry?" — used by
                            # claim, :acceptable, :listing(holder), and
                            # :available_actions.
  :describe_kind(k)         # default: dump policy[k] as a list; UIs override
                            # for richer rendering
  :look                     # inherited from $space; default renders roles/policies
```

The registry IS the catalog and IS the policy registry. They're the same
property bag and edited together. Roles, obligations, and policies are
*properties*, not objects-in-world: cheaper, simpler. Editing an obligation
in place propagates the new criterion to every in-flight task that
references the key.

**Specializations layer on top of this base.** A few common extensions:

- `$ingest_registry < $task_registry` — adds `:create_task_from_text`,
  `:create_task_from_url`, `:create_task_from_file` and tag inference
  (`#bug`, `#chore`). Pure ergonomics over `:create_task`.
- `$versioned_registry < $task_registry` — re-introduces `replaced_by` on
  obligation entries when a world genuinely needs to retire a key while
  keeping in-flight tasks frozen on the old criterion. The base accepts
  in-place edits and lets the new criterion go live.

Worlds that need wizard overrides beyond the day-one minimum
(`override_pass`, `override_drop`) layer their own admin surface as
ordinary verbs that emit the appropriate `task_logged` entries — the
substrate doesn't predefine an admin mixin.

## What lives on `$task`

```
properties (in addition to $note's name, text: str, description,
            writers, location):
  registry:     $task_registry      # owning registry; immutable, set at create.
                                    # This is the model-level "home" — distinct
                                    # from the substrate's inheritance parent
                                    # ($task), which is unrelated.
  kind:         str                 # immutable
  obligations:  list<{key, met, evidence?}>   # snapshot of policy at create
  wait_for:     list<Condition>
  links:        list<{to, role}>    # role: parent | precondition (state-machine)
  log:          list<LogEntry>      # append-only
  labels:       list<str>           # optional admission/filter tags
  source?:      str | map           # opaque provenance pointer (URL,
                                    # ticket id, free text). Stored and
                                    # surfaced by UIs; not interpreted by
                                    # the model. v1 does no dedup on it.
  terminal:     bool                # default false; set true by :drop_terminal
  created_at:   int                 # ms epoch, set at create
  last_change:  int                 # ms epoch, bumped by every lifecycle verb
  transition_intent?: str           # transient: set by a lifecycle verb just
                                    # before its moveto, cleared after.
                                    # The movement gate (see :acceptable below)
                                    # rejects any move where this isn't set,
                                    # which prevents generic take/give/drop
                                    # from bypassing the lifecycle bookkeeping.

verbs (the v1 lifecycle surface — every transition goes through one
of these; none rely on substrate move-hooks that don't exist yet):
  :acceptable(target)  # gate. False unless this.transition_intent is
                       # set AND (target == this.registry OR
                       # this.registry:holds_role(target, cursor(self).role)).
                       # The transition_intent requirement is what makes
                       # generic take/give/drop refuse — they don't go
                       # through a lifecycle verb, so the intent is null.
  :cursor              → resolved {key, role, criterion} via this.registry.obligations
  :claim()             # actor takes the task; runs :acceptable;
                       # sets transition_intent = "claim" before moveto;
                       # appends "claimed" log; emits task_claimed; bumps last_change
  :handoff(actor)      # current holder hands the task to another actor;
                       # transition_intent = "handoff"; emits task_moved
  :release()           # current holder returns the task to the registry;
                       # transition_intent = "release";
                       # calls moveto(self, self.registry); emits task_released
  :pass(evidence?)     # advances cursor; emits task_passed; bumps last_change
  :reject(i, why)      # rewinds; emits task_rejected; bumps last_change
  :wait(cond)          # appends a wait_for entry; emits task_waited
  :yield(spec)         # spawns a related task; emits task_yielded
  :drop_terminal(why)  # terminal abandonment;
                       # transition_intent = "terminal"; sets terminal=true;
                       # calls moveto(self, self.registry);
                       # emits task_dropped + task_returned_home
```

**Movement is the lease.** `task.location` is who's working on it.
Role-gating is enforced by `:acceptable`. No separate `lease` field,
no separate `status`.

**Movement only happens through explicit task verbs**, and the
`transition_intent` property is the executable gate that enforces it.
`:claim`, `:handoff`, `:release`, and `:drop_terminal` each:

1. Verify the precondition (correct location, role membership, etc.)
2. Set `this.transition_intent = "<kind>"` (e.g. `"claim"`)
3. Call `moveto(self, target)`. The substrate calls
   `target:acceptable(this)` and `this:acceptable(target)`. The
   `$task:acceptable` override checks both `transition_intent` (must
   be set) and the role chain.
4. On return (or in a `try`/`finally`), clear
   `this.transition_intent`.
5. Append the matching `LogEntry` to `log[]`, bump `last_change`, and
   emit the matching observation.

A generic substrate `take`, `give`, or `drop` against a `$task` ends
up calling `moveto` directly without setting `transition_intent`. The
acceptance check then fails (`transition_intent` is null), the
substrate refuses the move, no log entry or observation runs. The
typed verbs are the only way to move a task; the gate is enforced by
the substrate's existing `moveto` chain rather than by a new hook.

The `transition_intent` property lives on the task (storage-backed),
but its lifecycle is verb-local: every lifecycle verb pairs the set
with a clear so the intent never persists past the verb's frame. A
crash mid-verb leaves a stale intent; the next legitimate lifecycle
verb overwrites it. The gate accepts that minor staleness rather than
introducing a new transient-state primitive.

**Live criterion, frozen structure.** The obligation list is snapshotted at
creation (which keys, in what order). The criterion text is read live through
`registry.obligations[key].criterion`, so editing a criterion propagates to
all in-flight tasks. Worlds that need to retire a key while leaving
in-flight tasks frozen on the old criterion use `$versioned_registry`,
which re-introduces `replaced_by`.

**Sort/group keys live in the policy, not on `$task`.** `priority`, `effort`,
and any other ranking signals a kanban view wants are registry-defined: a
`$kanban_registry` declares them as part of its policy and `:create_task`
fills them in. The base `$task` doesn't carry them so worlds that don't
sort-by-priority don't pay for the shape.

**Link `role` is a freeform string.** Two values carry state-machine
weight: `"parent"` (cancellation cascade if parent is dropped) and
`"precondition"` (blocks `:pass` until the linked task is complete).
Anything else is stored verbatim and ignored by the state machine; UIs
and registries layer their own conventions over the rest. There is no
hardcoded catalogue of roles in the base.

**Source provenance.** `source?` is an opaque pointer the model
stores but does not interpret. UIs surface it as a "filed from \<source\>"
affordance when present (e.g., a GitHub issue URL, a Slack permalink, a
free-text "Hugh mentioned in standup"). v1 does not dedup against it,
does not enforce a shape, and does not maintain a typed bridge index;
those concerns arrive when ingest tooling does, at which point this
field grows a typed shape and a registry-side dedup verb. Until then,
keep it simple.

## State machine

```
cursor(t)   = first o in t.obligations where ¬o.met ∧ ¬orphaned(o)
ready(t)    = wait_for empty ∧ ¬terminal(t) ∧ cursor(t) exists
complete(t) = all obligations met (and none orphaned)
terminal(t) = drop_terminal was called
orphaned(o) = o.key ∉ t.registry.obligations  (key was removed after snapshot)

t:claim():
  pre   ready(t) ∧ t.location = t.registry ∧
        t.registry:holds_role(actor, cursor(t).role)
  via   moveto(t, actor)  (gated by :acceptable both sides);
        log += {outcome: "claimed", ...}; emit task_claimed

t:handoff(target):
  pre   t.location = caller ∧ t.registry:holds_role(target, cursor(t).role)
  via   moveto(t, target); log "claimed" on target's behalf;
        emit task_moved

t:release():
  pre   t.location = caller
  via   moveto(t, t.registry); log "released"; emit task_released

step (any of pass/reject/wait/yield/drop_terminal):
  pre   t.location = caller
  effect log += entry; outcome-specific field change
  pass:        cursor(t).met = true; cursor(t).evidence = ev
  reject(i):   t.obligations[i].met = false  (i strictly < cursor index)
  wait(c):     t.wait_for += c
  yield(s):    t.registry:create_task(s.kind, ..., link_ctx); link both sides
  drop_terminal: terminal(t) = true; moveto(t, t.registry);
                 emit task_dropped + task_returned_home
```

Invariants: one location per task; cursor advances monotonically except via
`reject`; log is append-only; `complete(t) ⇒ task is at registry`.

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
3. sets `registry = $bug_board`, `location = $bug_board`
4. logs `{actor: caller, outcome: created, ts: now}` as the first log entry
5. returns the task, which lands ready in the `$bug_board` kanban under
   "ready → triager" (because `cursor.role = triager`).

**The conversational way (in-world):**

```
@bug_board: create-task "auth retry races"
> Created T-1042 [bug]. Cursor: triage:confirm — needs a triager.
```

An `$ingest_registry < $task_registry` adds `:create_task_from_text` —
infers `kind` from a tag in the title (`#bug`, `#chore`) or from the
default kind on this registry. Same minting underneath.

**From an existing source (filed bug, todo line):**

`$ingest_registry` also exposes `:create_task_from_url(url)` for a GitHub
issue and `:create_task_from_file(path, line)` for a `todo.txt` line.
Either way it's `:create_task(...)` underneath; the source becomes a label
or a `links` entry whose `role` is whatever string the registry chooses
(`"source"`, `"imported-from"`, etc. — pick a convention).

## How a user creates a related task while working on another

`:yield` is one verb with one shape. The holder of the in-progress
task calls it; the registry mints the child and links the two:

```
T-1042:yield({ kind: "chore",
               name: "extract retry helper",
               text: "...",
               blocking: true,            # default false
               because: "needed to fix T-1042" })
```

Effect:

- mints a fresh child via `T-1042.registry:create_task(...)`
- adds `T-1042.links += { to: child, role: "parent" }` and a back-edge
  on the child with `role: "parent"` pointing at T-1042
- if `blocking: true`, also adds `T-1042.wait_for += { kind: "child_complete",
  task: child }` so T-1042's next `:pass` refuses until the child
  completes
- the child's first log entry includes `because: "..."` when supplied
- T-1042 stays where it is; the child lands ready at its registry

Two cases the v1 shape *doesn't* cover, deferred until a real workflow
needs them:

- **Obligation-extending spawn** (appending a new obligation to the
  current task, bound to the child as evidence). Useful for
  cross-cutting reviews (security sign-off, accessibility check) but
  v1 doesn't enable it.
- **Cross-registry yield** (mint the child on a different registry).
  v1 always mints into `T-1042.registry`; cross-registry coordination
  is out of scope.

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
- `t:acceptable(actor)` — true iff `t.registry:holds_role(actor, cursor(t).role)`

For a task being released:

- `$task_registry:acceptable(t)` — true iff `t.registry == self`
- `t:acceptable(t.registry)` — always true (registry is always a valid home)

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

A human picks up the task with the same `:claim` / `:handoff` / `:pass`
flow as any agent. Humans aren't special; they're just role-holders
with an interactive UI.

## Spawning, links, and shapes

Links are entries in the task's `links` property:

```
$task.links: list<{ to: $task, role: str }>
```

There is no `Edge` object — "link" and the entries of `links[]` are the
same thing. `role` is a freeform string. The model imposes no hardcoded
catalogue of roles; worlds and UIs use whatever strings they find
useful.

**Two roles do carry state-machine semantics**, because the engine reads
them in `:reject`/`:pass`/`:drop_terminal` paths:

- `"parent"` — child is part of parent's scope. If parent is `:drop_terminal`'d,
  children with this back-edge are cancelled.
- `"precondition"` — blocks `:pass` until the linked task reaches `complete`.
  Not in parent's scope; not cancelled with parent.

Any other string is stored verbatim and ignored by the state machine.
Common conventions a UI might display (`"discovered-by"`, `"followup"`,
`"relates-to"`, `"origin"`, …) are conventions, not contracts. A
registry that wants to enforce a specific role vocabulary can do so in
its own `:on_create_request` / `:yield` overrides; the base does not.

## UI surface for humans

Kanban is **not** a property or verb on the registry — it's a UI component's
rendering and interaction discipline. The registry's job is to expose its
state honestly; the UI's job is layout, affordance, and binding interactions
to verb calls.

This section names what the model must expose, what the default kanban UI
does with it, and how human gestures (drag, reorder, edit) map to verbs.

The examples below assume a `$kanban_registry < $task_registry` whose
policy declares the sort/group keys the kanban shows (`priority`, `effort`,
and similar). The base `$task_registry` doesn't carry those fields — a
registry that doesn't sort-by-priority simply leaves them out of its
policy and the UI computes ranks from `age` alone.

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
- **Live observations.** `task_created`, `task_claimed`, `task_passed`,
  `task_rejected`, `task_yielded`, `task_returned_home`,
  `task_dropped`, `task_logged` emitted on the registry's space. UIs subscribe and
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
(`name`, `text`, labels, priority) are permission-based, not
lease-based: non-holders can still edit but see a soft "you're not
holding this — Bob is" warning. `text` edits go through `:set_text`
(which runs the writers-list check), not a direct property write.
Conflicts resolve last-write-wins; no pessimistic blocking.

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
| Ready (role I hold) → my swim-lane | `:claim()` |
| My swim-lane → Home | `:release()` |
| My swim-lane → another actor (with cursor role) | `:handoff(actor)` |
| My swim-lane → Done column | only valid if cursor is at last obligation; otherwise refused. Otherwise: a "Pass" button is the right affordance, not a drag |
| My swim-lane → Dropped column | `:drop_terminal(reason)` (modal asks for reason) |
| Within a column, reorder | priority bump (see below) |
| Pulling a Done back into Ready | refused; spawn a new task with a link back to the Done one instead |

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

| Field | Editor | Write path |
|---|---|---|
| `name` | task author or registry owners | property write |
| `text` | task author, members of `.writers`, or wizard | `:set_text(body)` / `:write(line)` / `:erase` / `:delete(line)` |
| `labels` | author, holder (current lease), or owners | property write |
| `priority`, `effort` (when declared by the registry's policy) | author, holder, or owners | property write |
| `kind` | nobody — immutable | — |
| `obligations[*].met / evidence` | only via `:pass` / `:reject` / overrides | step verbs |
| Registry's `roles` / `obligations` / `policies` maps | registry owners / wizard | not via the kanban — see [§Registry admin UI](#registry-admin-ui) |

Most inline edits are property writes; observations propagate the changes
to every connected UI. `text` is the exception: it routes through
`$note:set_text` so the writers-list check lands once. The state
machine is untouched by either path.

### Compose new

The "+ New task" affordance opens a form: kind picker (drawn from
`registry.policies`), name, optional `text` (markdown textarea), labels,
priority, effort. Submit calls `:create_task(...)`. The new card lands
in Ready
under its `cursor.role` sub-group. (UI may label the `name` field
"Title" since that's the familiar UX term; the model field is `name`.)

For tasks composed *while another is held* (the related-task case), the
Spawn button is preferred — it carries `because` context and link
metadata that plain `:create_task` does not.

### Other views — same surface, different layout

The same `:listing` + per-task `:summary` is enough to power:

- **List view.** Flat sortable table; useful for triage and bulk editing.
- **My queue.** `t : ready(t) ∧ t.registry:holds_role(me, cursor.role) ∧ lease = none`
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

## Registry admin UI

A second human-oriented UI, distinct from the task kanban: the surface
that registry owners use to edit `roles`, `obligations`, and
`policies`. Admin-only — gated by `registry.owner` (the substrate
object-owner field) or `wizard` flag — and deliberately small.
Functional, required, as simple as possible:
three editable lists.

### Three panels

The admin UI is three panels (tabs, columns, or sections — UI choice).
Each panel is a list with inline editing.

**Roles** — entries in `registry.roles`:

```
+ Add role

triager
  description: "Confirms reproductions and labels severity"
  owners:      [@alice, @bob, @carol]
  [edit] [remove]
```

**Obligations** — entries in `registry.obligations`:

```
+ Add obligation

triage:confirm
  role:      triager        ← picker, drawn from registry.roles
  criterion: "Bug reproduces; severity assigned."
  [edit] [remove]
```

**Policies** — entries in `registry.policies`:

```
+ Add kind

bug
  triage:confirm  →  implement:fix  →  review:approved  →  verify:closed
                                                    [add] [reorder] [remove]
```

The policy panel renders the obligation list as an ordered chain. Each
slot is a picker over `registry.obligations` keys. Drag-to-reorder maps
to `:set_policy(kind, new_keys)`.

### Verbs the admin UI calls

The admin UI doesn't write the maps directly — it calls wrapper verbs
that enforce referential integrity and emit observations:

```
$task_registry:set_role(name, info)
$task_registry:remove_role(name)
$task_registry:set_obligation(key, info)
$task_registry:remove_obligation(key)
$task_registry:set_policy(kind, keys)
$task_registry:remove_policy(kind)
```

See [§v1 schemas](#v1-schemas) for the typed signatures and the rejected
cases (e.g. removing a role still referenced by an obligation).

### Live propagation

Editing an obligation's `criterion` text updates the live read on
`registry.obligations[key].criterion` for every in-flight task that
references the key — exactly the "live criterion, frozen structure"
property described in §What lives on `$task`. The admin UI surfaces
this with a small caveat ("This text is shown live to N tasks currently
on this obligation") so an editor knows the audience.

Renaming a key (= remove + set with a new name) is a structural change
the admin UI refuses inline; it offers an explicit "rename and migrate"
modal that walks tasks' frozen `obligations[]` arrays and rewrites the
key in each. Out of scope for v1; the v1 admin UI does not support
rename, only edit-in-place of role / criterion / owners.

### What's deliberately absent from the admin UI

- **Test runs / dry-run validation.** Edits are immediate; mistakes are
  visible in the kanban. No staging environment for policy changes.
- **Version history / diff view.** The registry's mint audit and the
  observation stream carry the change record; an admin who needs to
  audit policy edits reads observations or `mint_audit`.
- **Bulk import/export.** v1 ships none; deferred to a CLI tool.
- **Per-actor role grant UI elsewhere.** Role membership is a registry
  property (`role.owners`) so the registry's admin UI is the only place
  to grant roles. Actors don't carry editable role lists.

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

## Reference (post-v1)

The sections below are design context, not v1 scope. They sketch what
the model becomes when scaling, recycle integration, factory-contract
extraction, and ingest tooling all land. v1 implementations should not
build any of this; v1 reviewers can use it to check that the simpler
v1 design hasn't painted itself into a corner.

### Relation to `recycle()`

The substrate now has [`recycle(obj)`](../spec/semantics/recycle.md) as the
object-destruction primitive: irreversible, ULID-tombstoning, `:recycle`
handler dispatched, dangling refs tolerated as `E_OBJNF` on dereference.
This is distinct from the model's `:drop_terminal`, and the spec keeps
both for different jobs.

| Concern | `:drop_terminal(why)` | `recycle(t)` |
|---|---|---|
| Layer | State-machine transition | Substrate primitive |
| What it changes | `terminal=true`, `moveto(t, t.registry)`, log entry | Tombstone, storage rows deleted, parent/location chains broken |
| Reversible | Through wizard `override_pass` (rare) | Never |
| Audit log | Preserved on `t` | Gone with the object |
| Reciprocal `links[]` on other tasks | Stay live; UI shows `t` as dropped | Become dangling refs; `is_recycled` checks render "(recycled)" placeholders |
| When to use | The work is abandoned but the record matters | The task is being purged for storage / privacy reasons, accepting audit-log loss |

Day-to-day terminal abandonment is `:drop_terminal`. `recycle()` is for GC
of long-terminal tasks (a registry-level sweep on a schedule), or for
operator-driven purges where the audit log is genuinely unwanted.

#### `:recycle` handlers

`$task` defines `:recycle()` to:

- emit `task_recycled` on the registry's space so subscribers can clear UI
  rows and any cached projections;
- make **one** cross-DO call to the owning registry —
  `registry:on_task_recycled(self)` — to drop the entry from
  `children_index`. This is explicitly permitted by the anchor-cluster
  rule for `$task` because each task is on its own DO and the registry
  is the natural cluster boundary;
- accept that reciprocal `links[]` entries on linked tasks are now
  dangling — UIs check `is_recycled(edge.to)` at render time rather than
  trying to walk back-edges synchronously during the recycle.

The handler does *not* try to recycle linked tasks or mutate their
state. Cascading would violate the one-cross-DO-call permission and
would touch other anchor clusters; links cross registries and roles
freely, so a task recycle that walked them would multiply hops without
bound. Linked tasks observe their reciprocal references as
`E_OBJNF` on dereference per the standard recycle contract.

`$task_registry` defines `:recycle()` to refuse-by-cascade: drain its own
children first by calling `recycle(child)` for each, then `pass(@args)`.
This honours the "tasks come home" contract — recycling a registry while
it still has children would otherwise leave them stranded at `$nowhere`
(per RC3 step 4), where their `:acceptable` chain has no parent to
return to. Owners who want to keep the children alive should `chparent`
or move them to a sibling registry first.

#### Spawning a child of a recycled parent

`:yield` consults `t.registry.obligations` and `t.registry.policies`. If
the registry has been recycled mid-flight, the calling task surfaces
`E_OBJNF` on the property read; the model treats this as a terminal
condition for the child task and raises out of `:yield`. UIs route this
to the same "registry is gone" tile that handles dead-wait detection in
the [health view](#health-view).

#### `is_recycled` in queries

The pathologies table in [§Health view](#health-view) gains one row
implicitly: any predicate that walks a ref should bracket the read with
`is_recycled(ref)` so a tombstoned target surfaces as a separate
"orphaned reference" symptom rather than a generic dead-wait. The model
doesn't add new fields for this — the substrate's tombstone state is the
source of truth.

### Relation to `$block` / `$dispenser_block` — the factory contract

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

#### The shared factory contract

Both objects must implement the same set of concerns at the entry point and
around their children. Names them once so future factories don't reinvent:

| Concern | Shape |
|---|---|
| **Idempotency** | Caller-supplied dedup key on the create/order verb; re-issued requests are no-ops. For `$task_registry` v1, idempotency is the caller's job (a bridge that needs dedup keeps its own outbound side-table). Registry-side dedup arrives when ingest tooling does |
| **Per-requester rate limit** | Minimum interval between requests by the same caller |
| **Entrypoint cooldown** | Minimum interval between any two requests, regardless of caller |
| **Payload bounds** | Max size of a request; max depth of pending/ready set. `$note` carries no per-property cap today; bounds come from the per-frame VM `max_memory`. A registry can clamp at admission with a `max_text_lines` or `max_text_chars` policy and raise `E_INVARG` before minting |
| **Acceptance narrowing** | `:acceptable(thing)` true iff `thing.registry == self` (or whatever "home" property the factory uses); no foreign children |
| **Children come home** | `:exitfunc(thing, dest)` redirects to `self` if `dest` is illegal |
| **Audit of mints** | Append-only log of `{verb, requester, child, ts, key?}` |
| **Sequenced observation** | `*_created` / `*_returned_home` observations on the right cadence (the `_minted` naming used in earlier drafts is retired in favour of the `task_created` already in tree) |
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
- `task_created` / `task_returned_home` are sequenced observations.
- `:on_release(child)` runs whenever a held task lands back at the registry
  (drop, disconnect, idle reclaim) — the place to clear a stale lease, push
  a `released` log entry, and notify the kanban view.

#### Why a feature, not a base class

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

#### Not yet — but name it now

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

### Per-task DO decentralization

Once a v1 board has saturated its DO (per-DO storage, per-DO request
ceiling, hot-spot lock contention), the model moves toward "millions
of small DOs" by giving each task its own DO. Outline of the work:

- **`:create_task` accepts `placement?`** — `"own"` (new DO) becomes
  the default; `"with_registry"` is the legacy/low-volume opt-out.
  The substrate must expose per-instance `host_placement` at runtime
  creation time, which today is only set at seed time.
- **Registry holds `children_index`** — a denormalized projection of
  child tasks (id, name, kind, location, cursor_role, terminal,
  complete, age, source, labels) so `:listing` doesn't fan out reads
  to N task DOs. The index is eventually consistent: a task's `:pass`
  fires an observation back to the registry which patches the row.
- **`:on_lease_changed(t, from, to)` registry hook** — fired by
  `$task`'s lifecycle verbs after each move, used to keep the index
  current and to write the registry-side audit. Default behaviour
  patches the matching row.
- **Cross-DO hop accounting** — `actor → task:pass` is one hop;
  `task:yield → registry → new task DO` is two; cross-registry yield
  is three. Strong consistency on the task's own state lives on its
  own DO; `:listing` reflects the eventually-consistent projection.
- **Recycle locality boundary** — `$task:recycle` is granted exactly
  one cross-DO call to its registry (`registry:on_task_recycled`) to
  drop the index entry. Other cross-cluster mutations stay forbidden;
  reciprocal `links[]` on linked tasks become dangling refs that
  surface as `E_OBJNF` on dereference.
- **Failure modes** — index staleness in `:listing` (UIs render the
  task's own state on focus when consistency matters), per-task `log[]`
  growth (a `log_max_entries` policy on the registry caps it), the
  substrate gap of runtime per-instance `host_placement` (reserved but
  unimplemented in v1).

The v1 colocated model is intentionally a stepping stone: every
contract above is reachable by adding hooks and a denormalized index,
without rewriting the state machine.

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

## Replacing `$taskspace`

`catalogs/taskspace` is a flat-status, single-holder coordination demo
that grew organically: free-form requirements, an `assignee` field as
the only handoff signal, no role gating, no spawn semantics. It was
useful as the first cut at "tasks in woo" but is the wrong shape to
extend into the obligation/cursor model — the data shapes diverge at
nearly every field.

**This work is a replacement, not an evolution.** When the new model
lands, the demo gains a task-based kanban (under a new catalog —
likely `tasks/` or similar; name TBD) and `catalogs/taskspace/` is
deleted in the same change. No data migration: the existing
`the_taskspace` instance is dropped along with the catalog. The bundled
demo seed switches over to the new registry.

The new catalog declares its own observations from scratch:
`task_created`, `task_claimed`, `task_passed`, `task_rejected`,
`task_yielded`, `task_returned_home`, `task_dropped`, `task_logged`,
`task_moved`. None of taskspace's events (`status_changed`,
`requirement_added`, `requirement_checked`, `done_premature`,
`subtask_added`, `message_added`, `task_released`) carry across — they
were modelling the wrong things. UIs that subscribed to taskspace get
nothing from the new catalog without adopting the new event names; the
demo UI is rewritten alongside the model.

The tree view in `taskspace-workspace.ts` is also deleted. The demo's
default task surface becomes the kanban described in
[§UI surface for humans](#ui-surface-for-humans). If a hierarchy view
is wanted later, it can be added against the new model's `links[]`
with role `parent` — but no automatic carry-over of the existing tree
component.

What survives, conceptually rather than as code: `$task < $note` (the
in-tree note is the right base — `text: str`, the `:title()` /
`:text_summary` machinery, and writers-list permissioning),
and the broad idea that a space-like container
coordinates child tasks. Everything else — flat-status enum,
`assignee`-as-lease, free-form requirements, hand-rolled subtask
wiring — is rewritten.

## v1 schemas

Every type the prose names is defined here so implementation has one
contract to read. Substrate-level value shapes (`$obj`, `$actor`, `int`,
`str`, `map`, `list`) follow [values.md](../spec/semantics/values.md).

### `LogEntry`

```
LogEntry = {
  ts:              int       # ms epoch
  actor:           $actor    # who performed the step
  outcome:         str       # see reserved outcomes below
  obligation_key?: str       # for outcomes that target an obligation
  evidence?:       map       # outcome-specific (e.g. {commit, link, free_text})
  why?:            str       # free-form justification (reject, drop, override)
  link_ctx?:       { to: $task, role: str }   # for "yielded" entries
}
```

Reserved outcomes (extensible — derived registries can add their own):

| outcome | written by |
|---|---|
| `"created"` | `:create_task` |
| `"claimed"` | `:claim` (or `:handoff` on the receiving side) |
| `"released"` | `:release` |
| `"passed"` | `:pass` |
| `"rejected"` | `:reject` |
| `"waited"` | `:wait` |
| `"yielded"` | `:yield` (carries `link_ctx`) |
| `"wait_cleared"` | `:approve`, `:resolve_external`, child completion |
| `"dropped"` | `:drop_terminal` |
| `"returned_home"` | `:exitfunc` / idle reclaim |
| `"override:pass"` | wizard override that marks an obligation met |
| `"override:drop"` | wizard override that drops a task terminal |

### `Condition` (entries in `wait_for[]`)

v1 ships one `Condition` shape — the only one needed for blocking
spawn:

```
Condition = { kind: "child_complete", task: $task }
```

Clears when the linked task transitions to `complete`. Logs
`"wait_cleared"` on the parent.

Other shapes (approval, external signal, deadline, task-returned-home)
are good follow-ups but expand UI and lifecycle paths beyond what
`:yield(blocking: true)` needs. Defer until a workflow actually asks
for them; the discriminated-union shape is preserved so adding more
kinds later is a non-breaking extension.

### `YieldSpec` (input to `:yield`)

```
YieldSpec = {
  kind:       str
  name:       str
  text?:      str
  labels?:    list<str>
  because?:   str          # carried into the child's first log entry
  blocking?:  bool         # default false. If true, parent gains
                           # wait_for += {kind: "child_complete", task: child}
}

:yield(spec: YieldSpec) → { child: $task, link_role: "parent" }
```

The link role on both sides of the spawn is always `"parent"` in v1.
Obligation-extending spawn and `"precondition"` link role are deferred.

### `ListingFilter` and `ListingEntry`

```
ListingFilter = {
  kind?:        str | list<str>
  role?:        str | list<str>            # cursor.role
  holder?:      $actor | list<$actor> | "any" | null
                                            # null → location is registry
                                            # "any" → any holder
  labels?:      list<str>                  # all listed must be present
  has_source?: bool                        # filter by source presence
  terminal?:   bool                         # default: only non-terminal
  ready_only?: bool                         # default: false
  age_min_ms?: int
  paging?:     { cursor?: str, limit?: int = 50 }
}

ListingEntry = {
  task:           $task
  name:           str
  kind:           str
  labels:         list<str>
  location:       $obj
  cursor:         { key: str, role: str, criterion: str } | null
  wait_for_count: int
  source?:        str | map                # opaque, surfaced by UI
  age_ms:         int
  terminal:       bool
  complete:       bool
  link_count:     int
}

:listing(filter?: ListingFilter) →
  { entries: list<ListingEntry>, next_cursor?: str, total?: int }
```

### `AvailableAction` (return shape of `:available_actions`)

```
AvailableAction = {
  verb:            str            # one of: "claim", "handoff", "release",
                                  #   "pass", "reject", "wait", "yield",
                                  #   "drop_terminal"
  label?:          str            # UI hint
  args?:           list<{ name: str, type: str, required: bool }>
}

:available_actions(t: $task, actor: $actor) → list<AvailableAction>
```

Returns the lifecycle verbs that `actor` can legally call right now
given `t.location`, `cursor.role`, and `t.registry:holds_role(actor,
…)`. Actions the actor cannot perform are **omitted, not refused** —
the UI doesn't render them at all rather than showing them disabled
with a reason.

There are no `"take"` / `"give"` entries: those are substrate verbs
that bypass `transition_intent` and would be refused by `:acceptable`.
The model's exposed handoff path is `:handoff(actor)`.

### Observation payloads

All observations emit on the registry's `$space`, sequenced through the
existing space chain.

```
{ type: "task_created",       task: $task, registry: $task_registry,
  name: str, kind: str, source?: str | map, by: $actor, ts: int }

{ type: "task_claimed",       task: $task, actor: $actor, ts: int }

{ type: "task_released",      task: $task, actor: $actor, ts: int }

{ type: "task_moved",         task: $task, from: $obj, to: $obj,
  actor: $actor, ts: int }

{ type: "task_passed",        task: $task, obligation_key: str,
  actor: $actor, evidence?: map, ts: int }

{ type: "task_rejected",      task: $task, obligation_key: str,
  actor: $actor, why: str, ts: int }

{ type: "task_waited",        task: $task, actor: $actor,
  condition: Condition, ts: int }

{ type: "task_yielded",       task: $task, actor: $actor, child: $task,
  blocking: bool, because?: str, ts: int }

{ type: "task_returned_home", task: $task, reason: str, ts: int }
                                                           # reason ∈
                                                           # "released"
                                                           # "drop_terminal"
                                                           # "exitfunc"
                                                           # "reclaimed"

{ type: "task_dropped",       task: $task, why: str, actor: $actor,
  ts: int }

{ type: "task_logged",        task: $task, entry: LogEntry, ts: int }
                                  # fires for every log[] append; subscribers
                                  # may dedup against the more specific event

{ type: "task_recycled",      task: $task, ts: int }
                                  # emitted from $task:recycle handler
                                  # before storage destruction

{ type: "registry_role_changed",       registry: $task_registry,
  name: str, before?: RoleInfo, after?: RoleInfo,
  actor: $actor, ts: int }

{ type: "registry_obligation_changed", registry: $task_registry,
  key: str, before?: ObligationInfo, after?: ObligationInfo,
  actor: $actor, ts: int }

{ type: "registry_policy_changed",     registry: $task_registry,
  kind: str, before?: list<str>, after?: list<str>,
  actor: $actor, ts: int }

{ type: "obligation_orphaned",         task: $task,
  obligation_key: str, ts: int }
                              # fires for every affected in-flight task
                              # when :remove_obligation runs
```

`before` is null on add; `after` is null on remove. Tasks that
reference an edited obligation read the new criterion live on next
`:cursor` resolution; the observation lets UIs refresh without polling.
`obligation_orphaned` is fan-out: one event per affected task, on each
task's own space, so per-task subscribers see the orphan transition
without subscribing to the registry's full edit stream.

### Registry admin verbs

Wrapper verbs called by the admin UI — see
[§Registry admin UI](#registry-admin-ui) for the human surface. All
gate on `actor == this.owner` (the substrate's object owner field, set
at create) **or** `has_flag(actor, "wizard")`. The registry doesn't
maintain a separate `owners` property; ordinary substrate ownership is
the admin authority. Each emits the matching `registry_*_changed`
observation on success.

```
RoleInfo       = { description: str, owners?: list<$actor> }
ObligationInfo = { role: str, criterion: str }

:set_role(name: str, info: RoleInfo) → void
                              # add or update; raises E_INVARG if role name
                              # is empty or info.role doesn't match a string

:remove_role(name: str) → void
                              # raises E_CONSTRAINT if any obligation's
                              # role field references this name

:set_obligation(key: str, info: ObligationInfo) → void
                              # raises E_INVARG if info.role is not a key
                              # in registry.roles

:remove_obligation(key: str) → void
                              # raises E_CONSTRAINT if any policy's key list
                              # references this key

:set_policy(kind: str, keys: list<str>) → void
                              # raises E_INVARG if any element of keys is
                              # not a key in registry.obligations

:remove_policy(kind: str) → void
                              # always allowed; existing tasks of this kind
                              # keep their snapshotted obligations[]
```

**Orphaned-obligation semantics.** Tasks snapshot only
`{key, met, evidence?}` per obligation; `role` and `criterion` are
resolved live through `t.registry.obligations[key]`. If
`:remove_obligation(key)` runs while an in-flight task references the
key, that obligation entry becomes **orphaned**:

- `orphaned(o)` predicate is true iff `o.key ∉ t.registry.obligations`.
- `:cursor` skips orphaned entries when picking the active obligation.
  If every unmet entry is orphaned, `cursor(t)` returns `null` and
  `ready(t)` is false; the task is parked.
- Reading `cursor(t).role` / `cursor(t).criterion` on an orphaned entry
  is undefined — UIs render "(orphaned obligation: no longer defined)"
  rather than calling those fields.
- `:pass` raises `E_INVARG` on an orphaned cursor (cannot resolve role
  to permission-check). `:reject` is allowed against earlier non-orphan
  entries. `:wait` is allowed (decoupled from cursor).
- `:available_actions(t, actor)` on an orphaned-cursor task returns
  only the wizard escape hatches — `override_pass` and `drop_terminal`
  — for actors who can call them. Other holders see no actions.
- An `obligation_orphaned` observation fires for every affected task
  when the registry's `:remove_obligation` runs, so subscribed UIs
  can flip the badge without polling.
- The admin uses `override_pass` to mark the orphaned obligation met
  (which advances the cursor past it), or accepts that the task is
  permanently parked and uses `drop_terminal`.

In-flight tasks are unaffected by `:remove_policy` — their
`obligations[]` was snapshotted at create time, so the policy
disappearing from the registry has no in-flight effect. Only
`:remove_obligation` can produce orphans.

### Lifecycle and movement hook signatures

Default-no-op handlers on `$task_registry` — override seams for derived
registries. Each is dispatched within the same sequenced frame as the
triggering verb; observations fire after the hook returns. Hook errors
are caught and emitted as `$registry_hook_error`; the triggering
operation continues.

```
:on_create_request(req: CreateTaskRequest) → void  # before admission
:on_mint(t: $task, req: CreateTaskRequest) → void  # after task is located
:on_release(t: $task) → void                       # when t lands at registry
:on_terminal(t: $task, why: str) → void            # after :drop_terminal

CreateTaskRequest = {
  kind:       str
  name:       str
  text:       str               # markdown body; passes through to $note:set_text
  labels?:    list<str>
  source?:    str | map         # opaque; see $task.source
  requester:  $actor
  ts:         int
}
```

The lifecycle verbs on `$task` (`:claim`, `:handoff`, `:release`,
`:pass`, `:reject`, `:drop_terminal`) emit observations and call the
hooks above directly. There is no substrate move-hook dependency: every
task transition runs through one of these verbs.

### Role membership

The `$task_registry.roles` map's `owners` field is the **authoritative
grant list** for that role on this registry. Actors do not carry a
`.roles` property — there is no global role list, no cache to keep
warm, no stale-projection class of bug. The single membership predicate
is the registry verb `:holds_role(actor, name)`:

```
$task_registry.roles: map<role_name → {
  description: str
  owners?:     list<$actor>     # v1: actors only. $group expansion deferred
                                # until a $group catalog object exists.
}>

:holds_role(actor, name) → bool
  # true iff actor ∈ roles[name].owners, or actor is wizard.
  # Returns false if name is not a key in roles, or if actor is null.
  # Post-v1: extend to expand $group entries before membership check.
```

Every place in the model that asks "does this actor hold this role?"
calls `:holds_role`: the `claim` precondition, `$task:acceptable`,
`:listing(holder=…)` filters, `:available_actions`, and the
"my queue" projection. UIs may cache the result of a recent
`:holds_role` call on the client for fast button-state checks, but the
registry's call is the source of truth.

Roles are **registry-scoped**: the same `triager` name on `$bug_board`
and `$security_board` is two distinct roles with potentially different
membership. Cross-registry spawns inherit no role grants — the child's
cursor role is resolved against *its* registry's `:holds_role`, not the
parent's.

### DO placement (v1)

**Tasks are colocated with their registry in v1.** Each
`$task_registry` instance is `host_placement: "self"` (self-hosted DO);
its child `$task` instances live in the same DO. `:listing` enumerates
the registry's `contents` directly — no denormalized index, no patch
observations, no eventual consistency. Strong consistency on every
read.

This trades scale headroom for v1 simplicity. A single registry's host
DO holds the registry plus all its tasks: their `log[]`, `obligations[]`,
`links[]`, `wait_for[]`, and `$note` text. Hits Cloudflare's per-DO
ceilings (storage, ~1000 req/s) when a board grows large; that's the
operational signal to invest in per-task DOs.

**Per-task DOs are post-v1.** The hooks that would be needed —
runtime per-instance `host_placement` at `:create_task` time, a
denormalized `children_index` patched by movement observations, the
`:on_lease_changed` registry hook, and the recycle-cluster boundary
work — are all sketched in
[Reference: per-task DO decentralization](#reference-per-task-do-decentralization)
below for when the scaling signal arrives. The `placement?` argument
on `:create_task` is reserved but not exposed in v1.

**Cross-registry move stays out of v1.** A task can't `chparent` to a
different registry because its `obligations[]` was snapshotted from
the old registry's policy. v1 simply doesn't support relocating a
task to a different registry; if needed, recycle and re-create.

**Failure modes acknowledged:**

- **Per-DO storage growth.** A registry's DO holds every child task's
  `log[]`, which grows over each task's lifecycle. There is no log
  size cap today; a `log_max_entries` policy on the registry is a v1
  follow-up. Until then, abandon the board and re-seed when it gets
  too large — the same operational pattern as a saturated $space.
- **Per-DO request rate.** All task verb calls on tasks of one board
  go through that board's DO. ~1000 req/s is the ceiling. v1 demos
  are far below that; production scale is post-v1.

### v1 `$bug_board` ships empty

The v1 demo seeds a `$bug_board` instance with **no roles, no
obligations, no policies**. Operators populate them through the
[Registry admin UI](#registry-admin-ui) — that is, the admin UI is the
authoring surface for the shipped policy, not a post-hoc edit
mechanism.

This deliberately avoids freezing a particular bug-flow shape into the
catalog seed. The first user to bring up a board iterates roles and
obligations in the UI until the kanban looks right; the resulting
policy is whatever they built. Capturing a "stock policy" in the seed
would short-circuit that exercise.

### Test / dev fixture

Tests and local-dev iterations can't wait for a human in the admin UI.
The catalog ships a `seed_minimal_policy(registry, actor)` fixture
verb (callable from test setup or a `--dev` boot flag) that populates
the registry with a tiny policy sufficient to drive the
create→claim→pass→release/drop loop end-to-end:

```
roles:
  doer: { description: "Does the work", owners: [actor] }

obligations:
  "do:it": { role: "doer", criterion: "Done." }

policies:
  "task": ["do:it"]
```

One role, one obligation, one policy, one kind. The fixture is **not**
the shipped policy — it exists only so create/claim/pass/release have
a working surface in vitest and `npm run dev`. Any real demo runs the
admin UI to author a richer policy.

The fixture is idempotent (re-running on a populated registry is a
no-op) and refuses to run on a non-empty registry unless explicitly
forced. Tests that want a different shape call the admin verbs
(`:set_role`, `:set_obligation`, `:set_policy`) directly rather than
expanding the fixture.

## v1 implementation contract

Pseudocode for a worker. Catalog DSL flavour, comments where the runtime
has subtleties. Tick budgets and exact error codes follow the substrate;
this section nails down behaviour, not bookkeeping.

### `$task_registry` properties

```
properties:
  roles:        map<role_name → { description: str, owners?: list<$actor> }>
                                # default: empty map
  obligations:  map<key → { role: str, criterion: str }>
                                # default: empty map
  policies:     map<kind → list<key>>
                                # default: empty map
```

Inherited from `$space`: `contents`, `name`, `description`, `owner`, …

No `children_index`, no `mint_audit`, no `default_workspace`. v1 reads
state directly off `contents`.

### `$task` properties

```
properties (in addition to inherited $note slots):
  registry:           $task_registry   # immutable; set at create
  kind:               str              # immutable; set at create
  obligations:        list<{ key: str, met: bool, evidence?: map }>
                                       # snapshot of policies[kind] at create
  wait_for:           list<Condition>  # default []
  links:              list<{ to: $task, role: str }>  # default []
  log:                list<LogEntry>   # append-only
  labels:             list<str>        # default []
  source?:            str | map        # opaque
  terminal:           bool             # default false
  created_at:         int              # ms epoch, set at create
  last_change:        int              # ms epoch, bumped on every lifecycle verb
  transition_intent?: str              # transient: "claim" | "handoff" | "release" | "terminal" | null
```

### `$task_registry:create_task(kind, name, text, labels?, source?)`

```
verb :create_task(kind, name, text, labels?, source?)
  rx
{
  // Authority: any actor with read on the registry can call create_task.
  // Tighten via :on_create_request override if a registry wants stricter
  // admission (rate limit, role check, etc).

  if (typeof(kind) != "string" || !(kind in this.policies)) {
    raise { code: "E_INVARG", message: "unknown kind", value: kind };
  }
  if (typeof(name) != "string" || name == "") {
    raise { code: "E_INVARG", message: "name required" };
  }
  if (typeof(text) != "string") {
    raise { code: "E_INVARG", message: "text must be a string" };
  }

  this:on_create_request({ kind, name, text, labels, source,
                           requester: actor, ts: now() });

  let t = create($task, {
    owner: actor,
    name: name,
    location: this              // colocated; same DO
  });
  t.registry      = this;
  t.kind          = kind;
  t.labels        = labels ? labels : [];
  t.source        = source;
  t.obligations   = [];
  for k in this.policies[kind] {
    t.obligations = t.obligations + [{ key: k, met: false }];
  }
  t.wait_for      = [];
  t.links         = [];
  t.log           = [{
    ts:      now(),
    actor:   actor,
    outcome: "created"
  }];
  t.terminal      = false;
  t.created_at    = now();
  t.last_change   = now();

  t:set_text(text);             // delegates to $note:set_text(body)

  observe({
    type:     "task_created",
    task:     t,
    registry: this,
    name:     name,
    kind:     kind,
    source:   source,
    by:       actor,
    ts:       now()
  });

  this:on_mint(t, { kind, name, text, labels, source,
                    requester: actor, ts: now() });
  return t;
}
```

### `$task` lifecycle pattern

Every lifecycle verb that moves the task uses the same wrapper:

```
verb :_authorized_moveto(target, intent_kind)
  rx
{
  // Internal helper. Sets transition_intent, calls moveto, clears
  // intent in finally. Caller does the precondition check.
  this.transition_intent = intent_kind;
  try {
    moveto(this, target);     // substrate runs :acceptable on both sides
  } finally {
    this.transition_intent = null;
  }
}
```

`$task:acceptable` reads `transition_intent`:

```
verb :acceptable(target)
  rxd
{
  if (!this.transition_intent) {
    return false;             // generic take/give/drop blocked here
  }
  if (target == this.registry) {
    return true;              // returning home is always allowed
  }
  if (!isa(target, $actor)) {
    return false;
  }
  let cur = this:cursor();
  if (cur == null) {
    return false;             // orphaned cursor: can't claim
  }
  return this.registry:holds_role(target, cur.role);
}
```

### `$task:claim()`

```
verb :claim()
  rx
{
  if (this.location != this.registry) {
    raise { code: "E_INVARG", message: "task is not at its registry", value: this.location };
  }
  if (this.terminal) {
    raise { code: "E_INVARG", message: "task is terminal" };
  }
  let cur = this:cursor();
  if (cur == null || length(this.wait_for) > 0) {
    raise { code: "E_INVARG", message: "task is not ready" };
  }
  if (!this.registry:holds_role(actor, cur.role)) {
    raise { code: "E_PERM", message: "actor does not hold cursor role" };
  }
  this:_authorized_moveto(actor, "claim");
  this.log         = this.log + [{ ts: now(), actor: actor, outcome: "claimed" }];
  this.last_change = now();
  observe({ type: "task_claimed", task: this, actor: actor, ts: now() });
}
```

### `$task:handoff(target)`

```
verb :handoff(target)
  rx
{
  if (this.location != actor) {
    raise { code: "E_PERM", message: "only the holder can handoff" };
  }
  if (!isa(target, $actor)) {
    raise { code: "E_INVARG", message: "handoff target must be an actor" };
  }
  let cur = this:cursor();
  if (cur == null) {
    raise { code: "E_INVARG", message: "task has no live cursor" };
  }
  if (!this.registry:holds_role(target, cur.role)) {
    raise { code: "E_PERM", message: "target does not hold cursor role" };
  }
  let from = this.location;
  this:_authorized_moveto(target, "handoff");
  this.log         = this.log + [{ ts: now(), actor: actor, outcome: "claimed" }];
  this.last_change = now();
  observe({ type: "task_moved", task: this, from: from, to: target,
            actor: actor, ts: now() });
}
```

### `$task:release()`

```
verb :release()
  rx
{
  if (this.location != actor && !has_flag(actor, "wizard")) {
    raise { code: "E_PERM", message: "only the holder or a wizard can release" };
  }
  this:_authorized_moveto(this.registry, "release");
  this.log         = this.log + [{ ts: now(), actor: actor, outcome: "released" }];
  this.last_change = now();
  observe({ type: "task_released", task: this, actor: actor, ts: now() });
  this.registry:on_release(this);
}
```

### `$task:pass(evidence?)` and `:reject(i, why)`

```
verb :pass(evidence?)
  rx
{
  if (this.location != actor) {
    raise { code: "E_PERM", message: "only the holder can pass" };
  }
  let cur = this:cursor();
  if (cur == null) {
    raise { code: "E_INVARG", message: "no live cursor (orphan or complete)" };
  }
  if (length(this.wait_for) > 0) {
    raise { code: "E_INVARG", message: "task has unresolved wait_for" };
  }
  // find cursor index
  let i = 0;
  let next = [];
  let advanced = false;
  for o in this.obligations {
    if (!advanced && !o["met"] && o["key"] == cur["key"]) {
      next = next + [{ key: o["key"], met: true, evidence: evidence }];
      advanced = true;
    } else {
      next = next + [o];
    }
  }
  this.obligations = next;
  this.log         = this.log + [{
    ts: now(), actor: actor, outcome: "passed",
    obligation_key: cur["key"], evidence: evidence
  }];
  this.last_change = now();
  observe({ type: "task_passed", task: this, obligation_key: cur["key"],
            actor: actor, evidence: evidence, ts: now() });
}

verb :reject(i, why)
  rx
{
  if (this.location != actor) {
    raise { code: "E_PERM", message: "only the holder can reject" };
  }
  if (typeof(i) != "number" || i < 1 || i > length(this.obligations)) {
    raise { code: "E_RANGE", message: "obligation index out of range" };
  }
  let target = this.obligations[i];
  if (!target["met"]) {
    raise { code: "E_INVARG", message: "obligation is not met; nothing to rewind" };
  }
  let next = [];
  let j = 1;
  for o in this.obligations {
    if (j == i) {
      next = next + [{ key: o["key"], met: false }];
    } else {
      next = next + [o];
    }
    j = j + 1;
  }
  this.obligations = next;
  this.log         = this.log + [{
    ts: now(), actor: actor, outcome: "rejected",
    obligation_key: target["key"], why: why
  }];
  this.last_change = now();
  observe({ type: "task_rejected", task: this, obligation_key: target["key"],
            actor: actor, why: why, ts: now() });
}
```

### `$task:drop_terminal(why)`

```
verb :drop_terminal(why)
  rx
{
  if (this.location != actor && !has_flag(actor, "wizard")) {
    raise { code: "E_PERM", message: "only the holder or a wizard can drop" };
  }
  this.terminal = true;
  this:_authorized_moveto(this.registry, "terminal");
  this.log         = this.log + [{
    ts: now(), actor: actor, outcome: "dropped", why: why
  }];
  this.last_change = now();
  observe({ type: "task_dropped", task: this, why: why, actor: actor, ts: now() });
  observe({ type: "task_returned_home", task: this, reason: "drop_terminal",
            ts: now() });
  this.registry:on_terminal(this, why);
}
```

### `$task:wait(cond)` and `:yield(spec)`

`:wait(cond)` appends to `wait_for` and emits `task_waited`.
`:yield(spec)` calls `this.registry:create_task(...)`, links the two
tasks, and (when `spec.blocking`) appends a `child_complete` Condition
to `this.wait_for`. The pseudocode follows the same shape as `:pass`
above; the key invariants:

- `:yield` only mints into `this.registry` (no cross-registry yield in v1).
- `links += { to: child, role: "parent" }` on parent;
  `child.links += { to: parent, role: "parent" }` after the child is
  created.

### `$task_registry:listing(filter?)`

```
verb :listing(filter?)
  rxd
{
  let entries = [];
  for x in contents(this) {
    if (!isa(x, $task)) { continue; }
    if (!this:_passes_filter(x, filter)) { continue; }
    entries = entries + [this:_summarize(x)];
  }
  // ... sort, page, return { entries, next_cursor?, total? }
}
```

`_passes_filter` and `_summarize` are private helpers; their logic is
just the field-by-field match against `ListingFilter` / construction
of `ListingEntry` from the v1 schemas section.

### `$task_registry:holds_role(actor, name)`

```
verb :holds_role(actor, name)
  rxd
{
  if (!actor) { return false; }
  if (has_flag(actor, "wizard")) { return true; }
  if (!(name in this.roles)) { return false; }
  let info = this.roles[name];
  let ow   = info["owners"];
  if (!ow) { return false; }
  return actor in ow;
}
```

### Wait-clearing on child completion

When a child task transitions to `complete` (its last obligation passes),
the registry's `:on_release(child)` handler — fired when the child lands
back at the registry on its final `:release` — sweeps `wait_for[]` on
each task whose `links` reference the child:

```
for t in contents(this) {
  if (!isa(t, $task)) { continue; }
  let new_wait = [];
  let cleared = false;
  for c in t.wait_for {
    if (c["kind"] == "child_complete" && c["task"] == child &&
        all_obligations_met(child)) {
      cleared = true;
      // skip — this clears
    } else {
      new_wait = new_wait + [c];
    }
  }
  if (cleared) {
    t.wait_for = new_wait;
    t.log = t.log + [{ ts: now(), actor: $wiz, outcome: "wait_cleared",
                       evidence: { task: child } }];
    t.last_change = now();
  }
}
```

This is the only `wait_for` shape v1 supports; richer Conditions arrive
later with their own clearing paths.

## Open questions

- **Reject scope.** When the verifier rejects, can they rewind further than the
  immediately-prior obligation? Default: any earlier obligation; they name it.
- **One registry or many.** Default: many (per board / per team). Tasks are
  always scoped to their owning registry. Cross-registry spawns are normal —
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

1. Define `$task_registry < $space` and `$task < $note` in a `tasks`
   catalog. Tasks live colocated with their registry — no per-task
   placement, no `children_index`, no `:on_lease_changed`.
2. Implement the lifecycle verbs:
   - `$task_registry:create_task`, `:listing` (scans contents),
     `:holds_role`, `:available_actions`, plus the admin verbs
     (`:set_role` / `:remove_role` / `:set_obligation` /
     `:remove_obligation` / `:set_policy` / `:remove_policy`).
   - `$task:claim`, `:handoff`, `:release`, `:pass`, `:reject`,
     `:wait`, `:yield`, `:drop_terminal`, `:cursor`, `:acceptable`.
   The state machine plus admin surface is ~250 lines of woocode.
3. Seed a `$bug_board` instance with **no roles, obligations, or
   policies**. Operators populate them through the admin UI as the
   first thing they do.
4. Two UI components:
   - **Kanban / list view** for task work — renders columns from
     `:listing` filters and binds drag-targets to `:claim` / `:handoff`
     / `:pass` / etc.
   - **Registry admin UI** — three-panel editor over `roles`,
     `obligations`, and `policies` (the only way to author the policy
     in v1).
5. One agent harness that subscribes to registry observations, queries
   ready tasks for the roles it holds (via `:holds_role`), calls
   `:claim`, runs the work, calls `:pass` / `:reject` / `:yield`.

Everything else — selection scoring, idle reclaim, broader `wait_for`
conditions, ingest bridges, per-task DOs, recycle GC, dashboards — is
post-v1 and reachable by additive change on the same shape.
