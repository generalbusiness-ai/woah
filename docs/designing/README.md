# Designing objects

This section covers what you need to make new things in a Port world:
spawning a new object, giving it properties, writing verbs, packaging
the whole thing into a catalog so others can install it, and the
programmer surfaces (eval, the editor room) you'll use along the way.

Authoring is split into two roles, ported directly from LambdaCore:
**builder** (shape the object graph and data) and **programmer**
(author executable behavior). Both are ordinary player classes, not
special harness objects. See
**[builder-and-programmer.md](builder-and-programmer.md)** for the
overview before diving into the per-task pages below.

## Pages

- **[builder-and-programmer.md](builder-and-programmer.md)** — the
  two roles, the full tool tables (MCP + chat `@`-commands), and the
  authority gates.
- **[creating-objects.md](creating-objects.md)** — `$builder:create`,
  `$builder:chparent`, `$builder:set_property`, plus the
  `@create` / `@set` / `@recycle` chat commands.
- **[programming-verbs.md](programming-verbs.md)** — the
  `$programmer:install_verb` flow, the T0 DSL subset, the
  `@verb` / `@args` / `@chmod` chat commands.
- **[eval.md](eval.md)** — `$programmer:eval` and the chat aliases
  `;` (expression) and `;;` (statements).
- **[verb-editor.md](verb-editor.md)** — the `$verb_editor` room
  workflow for buffer-style editing.
- **[catalogs.md](catalogs.md)** — packaging classes into a catalog,
  the manifest shape, install discipline.

## Authoring authority

To **create or modify objects** (builder surface):

- Your actor must inherit from `$builder` (or be wizard).
- The parent class must be `fertile` (anyone can derive from it),
  or you must own the parent.
- For mutating an existing object: you must own it (or be wizard).

To **author code** (programmer surface):

- Your actor must inherit from `$programmer` (which inherits from
  `$builder`).
- You must have the `programmer` flag, **or** be a wizard.
- You must own the object whose verb/property you're authoring (or
  be wizard).

Class membership controls the *visible* tool surface; the
`programmer` and `wizard` flags are the hard authority facts.
Reparenting an actor into `$builder` exposes builder tools without
granting code authority — that's the whole point of the split.

Guests typically can't author. Bearer- or apikey-authenticated actors
can be promoted at deploy time via the actor provisioning rules in
[`../../spec/identity/provisioning.md`](../../spec/identity/provisioning.md).

## Two paths to authoring

**Path A: in a running world.** You connect, you call the authoring
verbs (`$builder:create`, `$programmer:install_verb`, `$programmer:eval`,
or the chat-command equivalents) on objects in place. Changes are
immediate. Useful for experimentation, custom one-offs, or live
operations.

**Path B: in a catalog.** You write your classes as DSL source in a
catalog manifest, ship it, and worlds install it through the
catalog registry. Changes are versioned, migration-aware, and
deployable across many worlds. This is the right shape for anything
shared.

The mechanics are mostly the same. A catalog install is "for each
class in the manifest, run create + define properties + install
verbs." Doing it by hand once is fine; doing it for many worlds, you
want a catalog.

## Three ways to drive the authoring surface

| Surface | Best for |
|---|---|
| **Chat `@`-commands** (`@create`, `@verb`, `@chmod`, `@list`, …) | Humans typing in a chat panel. LambdaCore muscle memory. |
| **Chat eval `;` / `;;`** | Programmers wanting one-liner woocode in chat. |
| **MCP tools** (`woo_call("$me", "install_verb", ...)`, etc.) | Agents and IDEs. Structured args, structured results. |

All three route through the same underlying builtins and apply the
same authority checks.

## Where the spec lives

- [`../../spec/authoring/minimal-ide.md`](../../spec/authoring/minimal-ide.md)
  — the IDE primitives and authoring verbs.
- [`../../spec/authoring/editor-rooms.md`](../../spec/authoring/editor-rooms.md)
  — LambdaCore-style editor-room pattern (in-world collaborative
  editing).
- [`../../spec/semantics/language.md`](../../spec/semantics/language.md)
  — the DSL: types, syntax, semantics.
- [`../../spec/semantics/tiny-vm.md`](../../spec/semantics/tiny-vm.md)
  — the T0 VM subset that today's authoring uses.
- [`../../spec/semantics/permissions.md`](../../spec/semantics/permissions.md)
  — substrate-level perms; see also
  [../reference/permissions.md](../reference/permissions.md) for
  catalog-level conventions (`$perm`, the `is_*_by` family).
- [`../../spec/discovery/catalogs.md`](../../spec/discovery/catalogs.md)
  — the catalog install contract.
- [`../../catalogs/prog/DESIGN.md`](../../catalogs/prog/DESIGN.md)
  — the prog catalog's design rationale and LambdaCore alignment.
