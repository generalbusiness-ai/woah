---
date: 2026-05-02
status: implemented
---

# Introspection

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**.

The minimum agent/developer-facing API for "what is this object, and what can I do with it?" — the contract that lets agents discover affordances without hardcoded knowledge of a world's verbs.

This document specifies the *convention* (a `:describe()` verb on `$root` that every descendant inherits) plus the underlying builtins. The wire layer surfaces these as ordinary v2 or REST calls; no special protocol is required.

---

## N1. The `:describe()` convention

Every object inheriting from `$root` exposes a `:describe()` verb. Default behavior, defined on `$root` and inherited:

```ts
verb $root:describe() rxd {
  return {
    id:          this.id,
    parents:     parents(this),       // chain root-ward, not including this
    name:        this.name,
    description: this.description,
    properties:  properties(this),    // list of name strings
    verbs:       verbs(this),         // list of name strings
    schemas:     declared_schemas(this), // list of declared event types
    children:    children(this),      // direct inheritance children
    contents:    this.contents        // direct containment children, if any
  };
}
```

`:describe()` is `rxd` — readable by anyone who can call it. The default body uses introspection builtins (N3); subclasses may override to expose richer or more curated information.

A client or agent that wants to know what's possible on `#42` calls `#42:describe()` and gets a self-documenting response. No external schema registry is required.

---

## N2. Object-class extensions

Class-specific introspection extends the base shape. Conventions, not enforced:

### `$space:describe()`

Adds:
- `next_seq`: int
- `subscribers_count`: int
- `last_snapshot_seq`: int
- `recent_message_count`: int (e.g., last 100)

### `$task_registry:describe()`

Inherits `$space:describe()`, adds:
- `task_count`: int (total tasks in the space)
- `open_count`, `claimed_count`, `in_progress_count`, `blocked_count`, `done_count`: int

### `$task:describe()`

Inherits `$root:describe()`. The materialized state surfaces naturally because `properties(this)` lists the task's slots — but a curated form helps:

```ts
verb $task:describe() rxd {
  let base = pass();
  base.summary = {
    title:       this.title,
    status:      this.status,
    assignee:    this.assignee,
    requirement_count: length(this.requirements),
    requirement_done:  count_checked(this.requirements),
    subtask_count:     length(this.subtasks)
  };
  return base;
}
```

---

## N3. Underlying builtins

The introspection convention is built on these builtins (existing or near-existing):

| Builtin | Returns | Notes |
|---|---|---|
| `properties(obj)` | list<str> | Names of all properties visible on `obj` (including inherited definitions). |
| `verbs(obj)` | list<str> | Callable verb names visible on `obj`; duplicate local slots with the same name may appear more than once when an implementation exposes the raw slot list. |
| `parents(obj)` | list<obj> | Inheritance chain root-ward, excluding `obj` itself. |
| `children(obj)` | list<obj> | Direct inheritance children of `obj`. |
| `is_a(obj, class)` | bool | Whether `class` appears in `parents(obj)` or equals `obj`; host-transparent for valid cross-host object refs. |
| `verb_info(obj, descriptor)` | map | `{slot, name, owner, perms, arg_spec}` for the resolved verb on `obj`; descriptor is a name or 1-based local slot. |
| `property_info(obj, name)` | map | `{owner, perms, defined_on, type_hint, has_value}`. |
| `declared_schemas(obj)` | list<str> | Event types this object has declared schemas for. |
| `event_schema(obj, type)` | map | The declared schema for a specific event type. |

All are read-only; none mutate state. Permission for `:describe()` and the underlying builtins is "any actor that can read the object" — wizard-only properties are listed but their values are redacted. Reads of redacted values raise `E_PERM`.

---

## N4. Listing-shape verbs

For collections an agent might want to enumerate, the convention is a verb returning a list:

| Pattern | Example | Purpose |
|---|---|---|
| `:list_X()` | `$task_registry:list_tasks()` | All members of category X. |
| `:open_X()` | `$task_registry:open_tasks()` | Filtered to a domain-specific status. |
| `:by_X(value)` | `$task_registry:by_assignee(actor)` | Filtered by predicate. |

These are application code, not runtime. The convention exists so agents can reason: "if I'm looking at a `$task_registry`, I expect `:list_tasks()` and the open/claimed/done variants."

For very large collections, paginate: `:list_tasks(offset, limit)` returning `{items, total, has_more}`.

---

## N5. The agent's introspection loop

A typical first interaction for a fresh agent:

```
1. agent authenticates, gets actor objref and session id
2. agent inspects the session state (`active_scope`) or calls the actor's location tools
3. agent calls the current space's `:describe()`
4. agent sees verbs available on the space
5. agent calls space's listing verb (e.g. :list_tasks)
6. for each interesting object, agent calls obj:describe() to see its verbs
7. agent calls a verb via a v2 turn intent or REST object call
```

This loop requires no out-of-band knowledge about the world. It works on dubspace, tasks, future demos. The schema-discovery part (`event_schema(obj, type)`) lets agents construct valid event payloads when they need to reason about possible observations.

---

## N6. What's deferred

- **Verb argument schemas.** `verb_info` returns `arg_spec` (the MOO-style `(dobj prep iobj)` triple) but not full typed signatures (`{title: str, description: str}`). Adding typed signatures is a value-model question for the authoring spec.
- **Permission preview.** "What can I do here as me?" requires evaluating perm checks ahead of time. Agents currently learn by trying and seeing `E_PERM`. A `can_call(actor, obj, verb)` builtin is a candidate for v2.
- **Wizard-only schemas.** Some objects expose different shapes to different actors. Currently schemas are flat; per-actor visibility is deferred.
- **Type-rich property values.** `property_info` returns `type_hint` as a hint, not a contract. Stronger typing comes with the value-model evolution.

These are the natural extensions when authoring tooling appears. The contract above is enough for an agent to operate any well-formed woo world without prior knowledge.
