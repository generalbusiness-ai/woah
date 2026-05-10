---
name: tasks
version: 1.0.0
spec_version: v1
license: MIT
description: Task-as-obligation-list coordination. Replaces the v0.3 $taskspace demo with a registry/task model where each task carries an ordered obligation list, role-gated handoffs fall out of :acceptable, and movement is the lease.
depends:
  - @local:chat
  - @local:note
keywords:
  - tasks
  - kanban
  - workflow
---

# tasks

Task coordination for woo, modelled as obligation lists with cursor advancement.

## Classes

- `$task_registry < $space` — board / factory / kanban surface. Authors policy
  (roles, obligations, policies-per-kind) and mints `$task` children.
- `$task < $note` — work item with an obligation cursor, role-gated handoff
  via `:acceptable`, and movement-as-lease semantics.

See [DESIGN.md](DESIGN.md) for the model and the
[v1 design note](../../notes/2026-05-06-task-obligation-model.md) for the full spec.

## Quick tour

```
# Operator boots a fresh registry — empty by default
the_taskboard:set_role("triager", { description: "Triages bugs", owners: [@alice] })
the_taskboard:set_obligation("triage:confirm",
                             { role: "triager", criterion: "Bug reproduces." })
the_taskboard:set_policy("bug", ["triage:confirm"])

# File a bug
let t = the_taskboard:create_task("bug", "auth retry races",
                                  "intermittent 401 on token refresh", [], null)

# Triager picks it up and moves the cursor
t:claim()
t:pass({ commit: "abc123" })
# task auto-releases when last obligation passes
```

For tests and dev iteration, `:seed_minimal_policy(actor)` populates a
one-role / one-obligation / one-policy fixture (`doer` / `do:it` / `task`)
sufficient to exercise create→claim→pass→release end to end.

## Replaces

This catalog supersedes `@local:taskspace`. The old catalog directory
is removed in the same change; there is no data migration. Existing
demo worlds drop their `the_taskspace` instance, the `$taskspace`
class, and the orphan registry record on cold init via the
`2026-05-10-taskspace-drop` local-boot migration, and re-seed with
`the_taskboard` from this catalog's seed hook.
