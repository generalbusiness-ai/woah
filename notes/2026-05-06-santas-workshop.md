# Santa's workshop — design notes

A framework for coding agents, layered on top of the workflow model
in [2026-05-04-task-workflow-model.md](2026-05-04-task-workflow-model.md)
and the workflow primitive in
[spec/operations/workflows.md](../spec/operations/workflows.md).

## Position

Kanban hides the thing that matters in coding work: at each phase, the
*artifact* is different. Backlog has a brief. Design has a spec. Plan
has a step list. Implement has a branch. Verify has evidence. Integrate
has a merge. Phases are not statuses — they are slots, and each phase's
output is the next phase's input. A task in `design` has no plan yet;
that is not a missing field, it is the literal definition of being in
design.

The workflow model already gives us stages, transitions, and per-stage
features. Santa's workshop is the recognition that for coding work,
two more things matter:

1. **The task carries typed artifacts**, one per phase, accumulating
   as the task moves forward.
2. **The stage carries instructions**, which combine with the task's
   brief to form the agent's prompt for that phase.

That is the whole new idea. Everything else is the existing workflow
substrate with a default wiring.

## $workshop and $workshop_task

```
$workshop < $workflow            // catalog-installed
$workshop_task < $task           // brief + artifact slots + reviews
```

A `$workshop` ships with the canonical six stages already wired:

```
backlog → design → plan → implement → verify → integrate
```

Each stage has a `:submit` (artifact ready), `:approve` (advance), and
`:revise(notes)` (reject with feedback) verb. Plus the standard
`:take` / `:drop` from the underlying task model. No setup required;
the workshop is usable the moment the catalog installs.

`$workshop_task`'s schema:

| Field | Meaning |
|---|---|
| `brief: str` | The original problem statement. Immutable. The user's ask. |
| `design: ref<$note> \| null` | Output of design phase. |
| `plan: ref<$note> \| null` | Output of plan phase. |
| `change_ref: str \| null` | Branch / PR / commit reference. Output of implement phase. |
| `verification: ref<$note> \| null` | Evidence: test runs, screenshots, logs. Output of verify phase. |
| `reviews: map<phase_name, list<review>>` | Per-phase review log; see below. |
| `block_on_children: bool` | If true, outbound transitions gate on `all_children_done`. Default false. |

Slots are typed and named for the default phases. Workshops with
different shapes either subclass `$workshop_task` to add slots, or
use a free-form `artifacts: map<str, ref>` map at the cost of typed
access. Default convention covers the 80% case; bespoke workshops
opt out cleanly.

## Tasks as prompts

When an agent `:take`s a workshop task, the workshop assembles a prompt
from these inputs and returns it as an observation:

- `task.brief` — always
- `task.<artifact_for_current_stage>` if non-null — what the agent has
  to work with
- `stage.instructions` — phase-specific guidance ("design phase: produce
  a markdown design doc; do not write code; consult these specs…")
- `task.reviews[current_stage]` — what reviewers have said this round
- `task.parent.brief` if set — context for forks (see below)

This is the lever that makes phases real for agents. Same task, same
agent, different phase → different work. The agent runtime does not
need any new mechanism: a verb returns the assembled string, the agent
reads it, the agent acts.

`stage.instructions` is a `str` property on each stage. Default values
ship with the catalog; per-workshop overrides are trivial (set the
property on a stage instance).

## Iteration is intra-stage

A design getting reviewed three times before it advances does not
cause three location changes. The location stays `design` throughout.
What changes per round:

- `task.design` — the artifact (latest version)
- `task.reviews["design"]` — appended `{by, decision, notes, ts}`

```
:submit              → records "submitted" in reviews
:approve             → advance to next stage; gate on latest review = approve
:revise(notes)       → append revise+notes; task stays put
```

`stage:acceptable` for the outbound transition reads
`latest(task.reviews[stage]).decision == "approve"`.

The workshop view of a task shows the review rounds as a vertical
timeline within a phase; the kanban projection just sees one card
sitting in `design`. Iteration is real but not expressed as churn
across columns.

A round-robin of review-and-revise can run agent-to-agent:
performer agent submits, reviewer agent approves or revises, performer
re-takes the task on revise. No new mechanism — this is the existing
take/drop loop with the artifact and review log carrying the state.

## Side-quests via :fork

```
task:fork(brief: str, blocking: bool) -> $workshop_task
```

Creates a child workshop_task in the workshop's `backlog` with
`parent = current_task`. If `blocking == true`, the parent's outbound
transitions gate on `all_children_done(parent)`. If false, parent
advances freely and the child stands alone with provenance.

Use case: a reviewer in `design-review` finds three issues, two of
which are out of scope. They `:fork` two non-blocking tasks for the
out-of-scope work and one blocking task for the in-scope issue. The
parent stays put until the blocking child resolves; the non-blocking
children land in backlog and don't pin the parent.

`block_on_children` is a per-task flag, defaulting false. A blocking
fork sets the parent's flag and notes the child id; resolving the last
blocking child clears the flag.

## What this is not

- **Not a CI system.** Verify-phase evidence may link to CI runs, but
  the gate is "reviewer approves," not "build green." A CI gate is a
  stack-on `$ci_gate` feature on the verify or integrate stage —
  exactly the workflow-features pattern.
- **Not an agent runtime.** The agent is whatever actor is logged in.
  Workshop hands them the right prompt at the right phase. Routing
  tasks to specific agents is `:give`, already in the substrate.
- **Not a project manager.** No deadlines, sprints, or capacity
  planning. Pure flow.
- **Not a worktree manager.** `change_ref` is a string; the workshop
  doesn't create or manage branches. A `$worktree_aware` feature could
  add that, but it's optional.

## Capability gating

Inherits from
[workflows.md §WF11](../spec/operations/workflows.md#wf11-capability-gating-for-agent-claims).
A workshop task may declare `capability: "low" | "medium" | "high"`;
the underlying workflow gating prevents lower-tier agents from
claiming. No workshop-specific addition needed.

The natural pattern for coding work:

- `design` stage → high tier (architectural reasoning)
- `plan` stage → medium
- `implement` stage → medium or high depending on size
- `verify` stage → low or medium
- `integrate` stage → human or high tier

Per-stage tier defaults could be a `$workshop_tier_default` feature;
not required for v1.

## Minimal additions on top of $workflow

Six items, all sitting cleanly on existing substrate:

1. **`$workshop < $workflow`** preset with the six default stages and
   transitions. Catalog-installed.
2. **`$workshop_task < $task`** with typed artifact slots and
   `reviews` map.
3. **`stage.instructions: str`** on each stage in a workshop.
4. **`:submit` / `:approve` / `:revise(notes)`** triad as default
   per-stage verbs.
5. **`:fork(brief, blocking)`** verb on `$workshop_task`.
6. **Prompt-assembly verb** (`task:agent_prompt() -> str`) returning
   the concatenated prompt for the current stage.

Plus the SPA workshop view (vertical pipeline through one task) as a
sibling to the kanban view.

## Default phase instructions (sketch)

These are catalog-installable defaults, not normative. Per-workshop
override is expected and easy.

| Stage | Instructions (gist) |
|---|---|
| `backlog` | Triage: clarify the brief, decide if this should advance. No artifact required. |
| `design` | Produce a markdown design doc. Capture problem, approach, alternatives, tradeoffs. Do not write production code. |
| `plan` | Produce a step list keyed to the design. Each step is a verifiable change. Identify gates and rollback. |
| `implement` | Execute the plan. Each step → a commit on the task's branch. Update tests with each step. |
| `verify` | Run tests, exercise the feature, attach evidence. Flag regressions. |
| `integrate` | Land the change. Update specs and docs. Remove dead code. |

## Open questions

### Subclassing for non-coding workshops

Strict typed slots fit coding work; an RFC workflow or a
research-heavy task wants different slots. Strict default + free-form
`artifacts: map<str, ref>` escape hatch via subclass is the current
plan. Worth validating against a second concrete workshop shape before
freezing.

### Review identity

A review's `by` field — is that always the actor that called `:revise`
or `:approve`, or a stamped reviewer role? For two-reviewer signoff
(per workflow features), the review log needs reviewer identity per
entry. Use `actor` from the verb frame; reviewers without a declared
role still appear, just unrolled.

### Prompt assembly authority

`task:agent_prompt()` is a verb on the task. Should the agent runtime
auto-fetch this on `:take`, or does the agent have to call it? Auto on
`:take` is more ergonomic but couples the workshop to the agent
runtime. Explicit call is cleaner; the agent's harness adds one line.
Prefer explicit; revisit if it bites.

### Multi-agent coordination within a stage

If the implement stage spans several days and several agents, the
review log captures handoffs but does the *artifact* state? `change_ref`
points at a single branch; if two agents push to it, the state is in
git. Probably fine — git is the substrate for the implementation
artifact, just as `$note` is the substrate for the design artifact.

## Migration shape

1. Land `$workshop` and `$workshop_task` in a new `workshop` catalog
   sitting next to `taskspace`.
2. Wire one default workshop instance per world for "ambient"
   coding work — the analogue of `$default_workflow` in the workflow
   model.
3. Build the SPA workshop view (vertical artifact pipeline). Kanban
   over a workshop's stages remains a valid alternative projection.
4. Ship default phase instructions as catalog property defaults; keep
   them editable per workshop instance.
5. Add the prompt-assembly verb and document it in the agent-runtime
   integration.

Each step independently shippable. Existing taskspace and pinboard
keep working unchanged.
