---
date: 2026-04-29
status: partial
---

# Workflows

> Part of the [woo specification](../../SPEC.md). Layer: **operations**.

The pattern for state-machine-shaped coordination on a `$space`. Tasks (or any work-bearing object) progress through named states; the space gates transitions on roles and entrance conditions. Generalizes beyond a task registry: review pipelines, approval chains, deployment gates, content moderation.

Workflows are *not* a runtime primitive. They are a pattern built on existing `$space`, properties, verbs, and the per-claimer / per-role discipline from [identity.md §I7.1](../semantics/identity.md#i71-the-per-claimer-update-pattern).

---

## WF1. The workflow value

A workflow is a value (a map per [values.md §V2](../semantics/values.md#v2-canonical-json-encoding)) with this shape:

```js
{
  initial:     str,                      // initial state name
  states:      list<str>,                // all valid states
  transitions: list<TransitionRule>      // allowed transitions
}

TransitionRule = {
  from:      str,                        // source state
  to:        str,                        // destination state
  role?:     str,                        // role property name on the work item that the actor must match
  requires?: { ... }                     // entrance conditions; see WF3
}
```

Workflows are values, not objects. They serialize and deserialize cleanly, can be inspected, can be passed around. A class declares a default workflow value; per-instance overrides are possible but unusual.

---

## WF2. Workflow on a space

A `$space`-descended class declares a `workflow` property whose default is a workflow value. Items in spaces of that class consult the workflow when transitioning.

Example: a `$design_review_registry` class has `workflow` defaulting to:

```js
{
  initial: "design",
  states: ["design", "design-review", "implementation", "implementation-review", "done"],
  transitions: [
    { from: "design",                to: "design-review",         role: "performer", requires: { min_artifacts: 1 } },
    { from: "design-review",         to: "design",                role: "reviewer" },
    { from: "design-review",         to: "implementation",        role: "reviewer" },
    { from: "implementation",        to: "implementation-review", role: "performer", requires: { min_artifacts: 1 } },
    { from: "implementation-review", to: "implementation",        role: "reviewer" },
    { from: "implementation-review", to: "done",                  role: "reviewer" }
  ]
}
```

Items in such a space get a `status` property initialized to the workflow's `initial`; the gated `:set_status` verb (see §WF5) consults the workflow for transition rules. Note: this is a separate design pattern from the v1 `tasks` catalog, which uses an obligation cursor (`:claim`, `:pass`, …) rather than a named-state machine. A `$workflow_space` would extend `$space` directly, not `$task_registry`.

---

## WF3. Entrance conditions (`requires`)

A transition's `requires` is a small predicate-shaped map. Built-in predicate keys:

| Key | Meaning |
|---|---|
| `min_artifacts: int` | Item has at least N entries in its `artifacts` list. |
| `min_requirements_checked: int` | At least N requirements with `checked: true`. |
| `requires_role_set: str` | The named role property on the item is non-null. |
| `custom: { verb, args }` | Call a custom verb on the item; transition allowed iff the verb returns truthy. |

`requires` predicates are checked in the order listed; the first failed condition determines the rejection (`E_TRANSITION_REQUIRES`, with the failed key as `value`).

Custom predicates are the escape hatch — anything the built-ins can't express becomes a verb the item exposes.

---

## WF4. Roles and gating

Roles are actor-typed properties on the work item — exactly the I7.1 pattern. Common roles:

- `performer` — does the work; authorized for forward transitions.
- `reviewer` — reviews the work; authorized for approve / reject transitions.
- `requestor` — set at creation; usually audit-only, not gated for transitions.

A transition's `role` field names a property on the item. The gate is `actor == this.<role>` — where `actor` is the *calling actor* (the verb's frame `actor` field, the principal that initiated the call), **not** `progr` (the verb's compile-time owner, a code-authority concept per [permissions.md §11.4](../semantics/permissions.md#114-effective-permission)). Workflow role gates are about who is making the call right now, not about who wrote the code.

If the role property is null (e.g., reviewer not set), transition rejects with `E_TRANSITION_ROLE_UNSET`. Wizards bypass the role gate via `is_wizard(actor)`; the bypass is logged.

---

## WF5. The gated `:set_status`

A `$workflow_task` subclass (a peer of `$task`, not an extension of v1 `$task`) integrates the workflow check on its `:set_status`:

```woo
verb $workflow_task:set_status(status) {
  let workflow = this.space.workflow;
  let from     = this.status;
  let to       = status;

  let transition = find_transition(workflow, from, to);
  if (transition == null) {
    raise(E_TRANSITION, "no transition: " + from + " -> " + to);
  }

  if (transition.role != null) {
    let role_actor = this[transition.role];
    if (role_actor == null) raise(E_TRANSITION_ROLE_UNSET);
    if (actor != role_actor && !is_wizard(actor)) {
      raise(E_PERM, "not in role " + transition.role);
    }
  }

  if (transition.requires != null) {
    check_requires(this, transition.requires);
  }

  this.status = status;
  emit(this.space, { type: "status_changed", source: this, from, to });
}
```

The v1 `tasks` catalog does not include `$workflow_task`: it picks the obligation-cursor model instead, where state is the position in an ordered obligation list rather than a named state in a transition graph. A workflow-bearing class is a peer pattern that catalogs may build on top of `$space` when a named-state machine is the better fit.

`:transition(to)` is offered as ergonomic sugar — equivalent to `:set_status(to)` but reads better in agent code.

Wizard repair: `wiz:force_set_status(item, status)` bypasses the workflow check entirely. Logged as a wizard action.

---

## WF6. Workflow placement: per-space or per-class

Two placements:

- **Per-space (recommended).** The workflow is a property on the space's class. All items in a given space use the same workflow. Cleanest for "this is how we do design reviews; everyone follows the same flow."
- **Per-class.** Different `$task` subclasses use different workflows. Useful when one space hosts mixed kinds of work (a project that does both design tasks and incident tickets).

For the demo: per-space. Production deployments often want multiple workflows; per-class is a refinement, not a replacement.

---

## WF7. Workflow-aware listings

Agent and human flows benefit from listing verbs that surface work state:

```
$workflow_space:items_in_state(state)         -> list<obj>
$workflow_space:items_for_role(role, actor)   -> list<obj>
$workflow_space:items_unfilled(role)          -> list<obj>
```

These are pure introspection — built on `:children()` walks plus property filters. Each space implements them in a few lines.

For agents, the typical loop:

```
1. items = space:items_unfilled("performer")
2. for item in items: item:claim_role("performer")
3. ... do work, attach artifacts ...
4. item:transition("design-review")
5. wait for next iteration
```

Reviewer agents do the symmetric flow against `items_in_state("design-review")` filtered by `items_for_role("reviewer", $me)`.

---

## WF8. Beyond task registries

Same pattern, different domains:

- **Verb-edit review pipelines** in worktrees: `draft → submitted → approved | rejected → merged`.
- **Approval chains** for quota grants: `requested → reviewed → granted | denied`.
- **Deployment gates**: `staging → canary → prod` (example pattern used in Cloudflare mode).
- **Content moderation**: `posted → flagged → reviewed → published | hidden`.

Each is a `$workflow_space` subclass with a domain-specific workflow value. The runtime stays uniform; per-domain logic is in the workflow value plus domain-specific verbs.

---

## WF9. What's not in workflow primitives

- **Computed branches.** Workflows are state-name based; "if X then go to Y else Z" requires a custom verb that computes the target state and calls `:transition`. Pattern works; not a built-in.
- **Time-based transitions.** "After 24h, auto-cancel" is achievable via forked tasks that call `:transition` after `suspend`. Not built-in.
- **Sub-workflows / nested state machines.** One workflow per item; composition via separate items linked by reference.
- **Workflow versioning.** A workflow value lives on a class; changing the workflow affects future transitions. Existing in-flight items may have their `status` not match a state in the new workflow; `:transition` rejects until repair. Migration is a deliberate operator action — typically a worktree that updates the workflow value paired with a `migrate_property` to map old states to new.

These are deferred refinements. The current pattern — named workflows with role gates and entrance conditions — is enough for the design-review-implementation example and most real coordination cases.

---

## WF10. Errors

| Code | Meaning |
|---|---|
| `E_TRANSITION` | No transition rule from `from` to `to`. |
| `E_TRANSITION_ROLE_UNSET` | The transition requires a role; that role property on the item is null. |
| `E_TRANSITION_REQUIRES` | An entrance condition failed; `value` carries the failed predicate key. |
| `E_CAPABILITY` | Claimer's capability tier is below the item's required tier (see WF11). |

These are domain errors emitted by `:set_status` / `:transition` / `:claim_role` verbs in workflow-bearing classes. They surface to clients as `op: "applied"` with a `$error` observation, per the standard space failure semantics.

---

## WF11. Capability gating for agent claims

When a workflow-bearing space coordinates AI agents, the role gate is not enough: a low-tier agent shouldn't claim a task that needs a stronger model, even if the role is unfilled. Two small property additions — one on the work item, one on the agent — close this loop without new runtime machinery.

### Item properties

A workflow-aware item may declare:

| Property | Type | Meaning |
|---|---|---|
| `capability` | `"low"` \| `"medium"` \| `"high"` \| null | Minimum claimer tier; null means no constraint. |
| `token_budget` | int \| null | Estimated tokens to complete the work. Advisory. |

Both default to null. Items without these fields claim freely under any tier — the pre-WF11 behavior.

### Agent class: `$ai_agent`

A `$ai_agent` is a `$player` subclass that declares its provisioned tier:

| Property | Type | Meaning |
|---|---|---|
| `model` | str | Model identifier (e.g. `"claude-haiku-4-5"`, `"claude-opus-4-7"`). Logged for audit; not interpreted by the runtime. |
| `capability` | `"low"` \| `"medium"` \| `"high"` | This agent's tier. |

`$ai_agent` is a project-level convention, not a universal class. Operators map concrete models to tiers themselves; the runtime only compares strings against the fixed ordering `low < medium < high`.

Tag-set capabilities (`["code", "vision", "long-ctx"]`) are deferred. Anything finer-grained than the three-tier scalar can be expressed via a `custom` predicate per [WF3](#wf3-entrance-conditions-requires).

### Claim-time enforcement

The workflow-aware `:claim_role` verb gates on capability:

```woo
verb $workflow_task:claim_role(role) {
  if (this[role] != null && this[role] != actor) {
    raise(E_CONFLICT, "role already filled");
  }
  if (this.capability != null) {
    let agent_tier = actor.capability;
    if (capability_lt(agent_tier, this.capability) && !is_wizard(actor)) {
      raise(E_CAPABILITY, "actor tier " + str(agent_tier) +
                          " below required " + this.capability);
    }
  }
  this[role] = actor;
  emit(this.space, { type: "role_claimed", source: this, role, actor });
}
```

`capability_lt(a, b)` returns true iff `a` is a strictly lower tier than `b`. A null `agent_tier` is treated as below all tiers — actors without a declared capability fail the check unless they are wizards. Humans who want to claim agent-tagged work either run as wizards or expose their own `capability: "high"`.

`token_budget` is **not** enforced by the runtime. It surfaces in listings so agents (or their schedulers) can avoid claiming work that would exceed their per-call budget. Operators who want hard enforcement add it via a `custom` predicate.

### Filtered listings

The standard listing verbs gain an optional capability filter:

```
$workflow_space:items_unfilled(role, max_capability?)  -> list<obj>
$workflow_space:items_for_role(role, actor)            -> list<obj>   (unchanged)
$workflow_space:items_in_state(state, max_capability?) -> list<obj>
```

When `max_capability` is set, only items with `capability ≤ max_capability` (or null) are returned. The conventional agent loop:

```
items = $workflow_space:items_unfilled("performer", $me.capability)
```

— and the agent only sees what it is allowed to claim.

### What this does not do

- **No automatic dispatch.** The runtime does not push tasks to agents; agents poll. Push-style assignment is a scheduler layered on top.
- **No budget accounting.** `token_budget` is a hint; the runtime does not track actual consumption against it. Real metering belongs to an observability layer.
- **No per-task model pinning.** A task's `capability` says "at least this tier"; it does not name a specific model. Operators with stricter requirements add a `model_required: str` property and a custom predicate.
