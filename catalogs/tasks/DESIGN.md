# tasks — design

Task-as-obligation-list coordination, as specified in
[notes/2026-05-06-task-obligation-model.md](../../notes/2026-05-06-task-obligation-model.md).

## Classes

| Class | Parent | Description |
|---|---|---|
| `$task_registry` | `$space` | Board / kanban / factory. Authors policy and mints `$task` children. Self-hosted. |
| `$task` | `$note` | Work item with an obligation cursor and role-gated handoff. Inherits `$note`'s `text`/`name`/`description`/writers shape. |

## State machine

A `$task` carries `obligations: list<{key, met, evidence?}>` snapshotted at
create time. `:cursor()` returns the first unmet, non-orphaned obligation
resolved against `registry.obligations[key]`. `ready(t)` is true when
`wait_for` is empty and `cursor(t)` exists.

Lifecycle verbs:

- `:claim()` — actor at the registry pulls the task to themselves
- `:handoff(target)` — current holder hands the task to another role-holder
- `:release()` — current holder returns the task to the registry
- `:pass(evidence?)` — advance the cursor; auto-releases when complete
- `:reject(i, why)` — rewind a previously-met obligation
- `:wait(cond)` — append a wait_for entry
- `:yield(spec)` — spawn a related task (optional `blocking` adds a
  `child_complete` wait)
- `:drop_terminal(why)` — terminal abandonment

## Movement is the lease

`task.location` is who's working on it. A new `transition_intent`
property is set transiently by each lifecycle verb before its `move(...)`,
and cleared after; `:acceptable` rejects any move where `transition_intent`
isn't set, which prevents generic substrate `take`/`give`/`drop` from
bypassing the lifecycle bookkeeping.

## Policy authoring

`$task_registry` ships empty. Operators populate roles, obligations,
and policies via the admin verbs:

- `:set_role(name, info)` / `:remove_role(name)`
- `:set_obligation(key, info)` / `:remove_obligation(key)` (fans out
  `obligation_orphaned` to affected in-flight tasks)
- `:set_policy(kind, keys)` / `:remove_policy(kind)`

For tests and dev iteration, `:seed_minimal_policy(actor)` populates a
`doer` / `do:it` / `task` fixture.

Authority for admin verbs: substrate object owner + wizard.

## Replacement, not migration

This catalog supersedes `@local:taskspace` (v0.3). The previous catalog
is removed in the same change; no data migration. Existing demo worlds
re-seed `the_bug_board` from scratch.

## Cross-references

- [notes/2026-05-06-task-obligation-model.md](../../notes/2026-05-06-task-obligation-model.md) — full v1 spec, schemas, implementation contract
- [catalogs/note/DESIGN.md](../note/DESIGN.md) — `$note` parent class
