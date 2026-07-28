# Builder and programmer

woah's authoring surface is split into two roles, ported directly from
LambdaCore: **builder** (shape the object graph and data) and
**programmer** (author executable behavior). Both are persistent
classes, not special harness objects — and they double as attachable
*features*. An actor **carries** a surface either by descending from it
(the classic player-class shape) or by having it attached as a feature.
Either way, it sees the surface's tools on itself; there is no separate
"tool object" to focus.

```
$player
  └─ $builder       (shape: create, chparent, recycle, set_property, inspect, search)
       └─ $programmer (code: install_verb, set_verb_info, edit_verb, eval, ...)

agent_42 isa $agent          (kind stays put)
agent_42.features = [$programmer]   (surface composed on)
```

Promote an actor by attaching the surface — its kind never changes. The
normal path is a provisioning verb on the owning `$human`, which attaches
the surface, sets the `programmer` flag, and consumes quota together:

```
$human:promote_agent_to_programmer(<agent>)
```

or provision it programmer-ready in one step with
`$human:create_agent(name, purpose, true)`. Do **not** reparent an actor
into `$programmer`: that would strip the ancestry that records what kind
of principal it is (`$agent`, `$human`). Demote with
`$human:demote_agent_from_programmer(<agent>)`, which removes the surface,
clears the flag, and frees the quota slot.

> **Surface note.** These provisioning verbs are native account-management
> operations, not woocode tools. Promote/demote runs in-memory, on local-SQLite,
> and over the Net through the `/net-api/turn` doorway. A fresh signup anchors
> the whole family (account + human + agents) into one cluster, so the account
> counter and the agent flag commit atomically. On the live Net profile this is
> supported only for a fully anchored family (fresh signup, cutover import, or a
> family repaired before cutover); a family deployed BEFORE anchoring stays split
> — a new agent alone does not repair it — and its promote/demote refuses cleanly
> (`E_CATALOG_MUTATION`) rather than half-applying. See
> [provisioning.md](../../spec/identity/provisioning.md) for the exact boundary
> and the local-SQLite repair migration. Because the verbs are **native**, the
> Net MCP gateway — which advertises only bytecode-backed, `tool_exposed` verb
> pages — does not expose them as MCP tools, so `woo_call` cannot reach them over
> Net; drive them through `/net-api/turn` or the account surface instead.

## Why two classes

The split keeps **building authority** delegable without granting
**programmer authority**. A trusted helper actor can be a `$builder`
and create / move / recycle objects all day without being able to
install code. Programmer authority is the dangerous surface because
installed verbs capture `progr` — the verb's owner at install time —
and that's the authority future calls run under.

Carrying a surface controls the *visible* tool set. The `programmer`
and `wizard` flags remain the hard authority facts: without the
programmer flag, `$programmer`'s source-authoring verbs return `E_PERM`
even though they're listed as tools. Surface and flag are independent —
a surface without the flag lists tools that refuse every mutation, and
the flag without a surface produces no tools at all.

## Two ways to drive both surfaces

Each verb in the catalog has two faces:

- **An MCP-tool form** (`inspect`, `create`, `install_verb`, etc.) —
  takes structured args, returns structured results. Right for
  agents and IDEs.
- **A chat command form** (`@inspect`, `@create`, `@verb`, etc.) —
  parses a free-text command line, prints a human-readable result.
  Right for typing in a chat panel.

Both forms route through the same underlying builtin and apply the
same authority checks. Picking one is purely UX.

The chat-command names are LambdaCore-aligned (`@create`, `@verbs`,
`@chmod`). If you've seen LambdaMOO before, the muscle memory
transfers.

## Builder surface ($builder)

**MCP tools:**

| Verb | Purpose |
|---|---|
| `look()` | Surface map for agents — what's available here. |
| `inspect(id, opts?)` | Structure/data view: parent, children, contents, location, flags, properties. No source. |
| `search(query, opts?)` | Bounded search across object names and property channels. No source. |
| `create(parent, opts?)` | New ordinary object owned by the invoking actor. `opts: {name?, description?, location?, fertile?}`. `location` defaults to **you** — a new object lands in your inventory. |
| `chparent(id, parent, opts?)` | Reparent within owner/fertile/cycle rules. `opts.dry_run=true` checks only (LambdaCore's `@check-chparent`). |
| `recycle(id, opts?)` | Destroy owned objects (wizard or owner). `opts.dry_run=true` reports affected objects without mutation. |
| `set_property(id, name, value, opts?)` | Set ordinary data values. No executable source or perm metadata. |

**Chat commands:**

| Command | Verb behind it |
|---|---|
| `@contents [obj]` | `contents_command` — list `obj`'s contents (or your location's). |
| `@parents obj` | `parents_command` — `obj` plus its ancestor chain to `$root`. |
| `@kids obj` | `kids_command` — direct children. |
| `@create parent named name[,alias…]` | `create_command` — create a child of `parent`, place in inventory. |
| `@set obj.prop to value` | `set_command` — set an existing property's value. Will not auto-create properties. |
| `@recycle obj` | `recycle_command` — destroy `obj`. |

The chat parser is LambdaCore-shaped: word ordering, `to`, `named`,
`,`-separated alias lists. Errors are notify-and-bail (one line back
to the speaker), routed through `$command_utils:object_match_failed`
when the failure is a missing/ambiguous target.

## Programmer surface ($programmer)

Programmer inherits everything from `$builder`, then adds:

**MCP tools:**

| Verb | Purpose |
|---|---|
| `inspect(id, opts?)` | Source-aware view (overrides builder's). |
| `resolve_verb(id, descriptor)` | Where the verb actually resolves and the parent walk that found it. |
| `list_verb(id, descriptor, opts?)` | Readable source and metadata for one slot. |
| `search(query, opts?)` | Bounded grep including readable verb source when requested. |
| `install_verb(id, descriptor, source, opts?)` | Check and install source atomically. `opts.dry_run=true` returns diagnostics without mutation. See [programming-verbs.md](programming-verbs.md). |
| `set_verb_info(id, descriptor, opts?)` | Metadata-only edit for aliases, arg spec, exposure flags, perms. |
| `set_property_info(id, name, opts?)` | Define/update property metadata (perms, defaults, type hints). |
| `edit_verb(id, descriptor, opts?)` | Door into `the_verb_editor` room. See [verb-editor.md](verb-editor.md). |
| `eval(source, opts?)` | Compile and run woocode under your `progr`. See [eval.md](eval.md). |
| `force_recycle(id, opts?)` | Wizard-only forced recycle (children/contents/reserved). See [../wizard/recycle.md](../wizard/recycle.md). |
| `trace(id, verb_name, opts?)` | Next-N invocations source-span trace. **Not implemented and deliberately not tool-exposed** — advertising a tool that can only raise is a trap, so it appears in no `tools/list`. Until it lands, debug with `list_verb` (exact source), `eval` (run an expression under your own authority), and the `trace` frames every raised error carries (`{obj, verb, definer, line, column}`). |

**Chat commands:**

| Command | Verb behind it |
|---|---|
| `@verbs obj` | `verbs_command` — list own verb names. |
| `@properties obj` (alias `@props`) | `properties_command` — list own property names. |
| `@property obj.name [value]` | `property_command` — add a new property with optional initial value. |
| `@rmproperty obj.name` (alias `@rmprop`) | `rmproperty_command` — remove a property defined on `obj`. |
| `@verb obj:name[,alias…] [dobj [prep [iobj]]]` | `verb_command` — add a stub verb to `obj`. |
| `@args obj:verb [dobj prep iobj]` | `args_command` — set or show the dobj/prep/iobj specifier. |
| `@rmverb obj:verb` | `rmverb_command` — delete a verb defined on `obj`. |
| `@rename obj[:verb] to newname` | `rename_command` — rename a verb (object branch deferred). |
| `@list obj:verb` | `list_command` — dump verb source with line numbers. |
| `@chmod target perms` | `chmod_command` — change verb or property perms. Accepts `rxd` or `+r-x`. |
| `@chown target owner` | `chown_command` — wizard-only owner change. |

The eval chat aliases (`;expr` / `;;stmts`) are also part of this
surface. They're documented in [eval.md](eval.md).

## Authority gates, summarized

The programmer-surface verbs all open with the same check, in
woocode:

```
if (!has_flag(actor, "wizard")) {
  if (actor == $programmer) { raise E_PERM; }
  if (!has_surface(actor, $programmer)) { raise E_PERM; }
  if (!has_flag(actor, "programmer")) { raise E_PERM; }
}
set_task_perms(actor);
```

So you need **all** of:

1. The actor is a wizard, **OR**
2. The actor *carries* the `$programmer` surface — through ancestry or
   an attached feature, which `has_surface` checks — but is not the
   `$programmer` class object itself, **AND**
3. The actor has the `programmer` flag.

The `set_task_perms(actor)` line then drops the wrapper's authority from
the `$wiz` verb owner down to the actor, so the substrate enforces the
actor's own ownership on everything that follows. Builder verbs use the
same shape with `has_surface(actor, $builder)` and object ownership, but
without the `programmer`-flag requirement.

## Target resolution

Builder/programmer commands resolve targets through the **actor's
own** match policy (LambdaCore's `player:my_match_object`), not the
room's. The room owner must not be able to redirect what an
authoring tool edits. MCP tools take object refs directly and skip
match resolution entirely.

## Where to read more

- [programming-verbs.md](programming-verbs.md) — the source
  install flow in detail.
- [eval.md](eval.md) — `;` and `;;` chat aliases plus the `eval`
  tool.
- [verb-editor.md](verb-editor.md) — the editor-room workflow.
- [creating-objects.md](creating-objects.md) — `create` /
  `chparent` / `set_property` in detail.
- [../reference/permissions.md](../reference/permissions.md) — the
  `$perm` package and the `is_*_by` convention used by catalog
  classes that gate their own operations.
- [`../../catalogs/prog/DESIGN.md`](../../catalogs/prog/DESIGN.md)
  — catalog rationale and LambdaCore alignment notes.
