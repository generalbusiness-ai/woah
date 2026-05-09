---
name: prog
version: 0.2.2
spec_version: v1
license: MIT
description: Builder and programmer tooling for in-world authoring.
keywords:
  - authoring
  - builder
  - programmer
  - mcp
---

# prog — builder/programmer tooling catalog

This directory holds the design for the `prog` catalog: the developer
experience surface for agents and people who shape a live woo world. The
manifest installs builder/programmer player classes through the normal
local-catalog index; no MCP special case is required.

See [DESIGN.md](DESIGN.md) for the app design and behavior contract.

## Core Split

The catalog deliberately preserves the LambdaCore split between builder and
programmer capabilities.

**Builder** class verbs shape object structure and data:

- create ordinary objects
- move or reparent owned objects
- recycle owned objects
- set ordinary property values
- inspect/search object structure without source-centric output

Builder class membership is delegable without granting programmer authority.
The operation checks are class/parent/owner/quota checks: the actor must inherit
from `$builder` (or be wizard), own the target where appropriate, use a fertile
parent, and satisfy deployment policy. A world can
reparent a helper actor, object factory, catalog instance, or trusted agent to
`$builder` without letting that actor install code.

**Programmer** class verbs author executable behavior and schema-like metadata:

- resolve the verb that would actually run
- inspect own/inherited verbs and readable source
- dry-run verb source installs for diagnostics
- install verb source for real
- adjust property definitions/perms
- enter a room-like verb editor for collaborative source edits
- trace later invocations

Programmer authority is the dangerous capability: installed verbs capture
`progr`, so changing source changes what authority future calls run under.
Inheriting from `$programmer` exposes the interface; the `programmer` or
`wizard` flag remains the hard authority fact.

The two MCP surfaces are inherited by actors:

- `$builder < $player`
- `$programmer < $builder`

MCP does not special-case either one. The actor object is always reachable, so
an actor whose parent chain includes `$builder` sees builder tools on itself;
an actor whose parent chain includes `$programmer` sees programmer tools on
itself. The normal `tool_exposed` mechanism lists each inherited surface.

## Promotion path

The catalog ships once these are in place:

1. **Engine builtins**, with authority checked against the invoking actor and
   the wrapper verb's definer, not the wrapper verb's `progr`. When this catalog
   is installed by `$wiz`, `progr` is `$wiz` for every wrapper call; using it as
   authority would be a privilege escalation bug. The core builtin does not
   hardcode `$builder` or `$programmer`; it requires the actor to inherit the
   class that actually defined the wrapper verb.

   Builder builtins:

   - `builder_create_object(parent, opts)`
   - `builder_chparent(id, parent, opts)` — `opts.dry_run=true` is the
     LambdaCore `@check-chparent` shape
   - `recycle(id, opts)` — universal builtin. RC2 (wizard or owner of `id`)
     gates authority on the calling `progr`. `opts.dry_run=true` returns the
     impact set without mutation; `opts.force=true` bypasses the §RC3a
     empty-children safety check; `opts.force_reserved=true` (wizard only)
     bypasses the §RC6 reserved-list and terminates live actor sessions.
   - `builder_set_property(id, name, value, opts)` — ordinary data value only
   - `builder_inspect(id, opts)` — no source output
   - `builder_search(query, opts)` — object/property channels only

   Programmer builtins:

   - `programmer_inspect(id, opts)` — source-aware, read-filtered
   - `programmer_resolve_verb(id, descriptor)`
   - `programmer_list_verb(id, descriptor, opts)` — readable source and
     metadata for one slot; no bytecode
   - `programmer_search(query, opts)` — may include readable source
   - `programmer_install_verb(id, descriptor, source, opts)` — refuses
     `opts.perms`; source header is canonical; `opts.dry_run=true` validates
     the exact install without mutation
   - `programmer_set_verb_info(id, descriptor, opts)` — metadata-only edit for
     aliases, arg spec, direct/tool exposure, and permission bits
   - `programmer_set_property_info(id, name, opts)`
   - `edit_verb(id, descriptor, opts)` — door into `the_verb_editor`
   - `programmer_trace(id, verb, opts)` — v1.1

2. **LambdaCore-aligned command semantics**:
   - public wrappers behave like LambdaCore's task-permission helpers: the
     invoking actor is the authority, not the catalog installer
   - `$programmer` inherits from `$builder`, matching LambdaCore's
     `programmer ⊂ builder` stack
   - object resolution/search is actor-scoped, like `player:my_match_object`;
     room matching must not redirect builder/programmer targets
   - verb authoring preserves the conceptual split between `@verb`
     (metadata/arg spec) and `@program` (source install), even when MCP offers a
     combined `install_verb` convenience
   - verbs are ordered slots, not a name-keyed map; duplicate names are legal,
     name descriptors resolve to the first matching slot, and integer
     descriptors address a 1-based slot directly
   - property authoring preserves the split between ordinary value setting and
     definition/perms changes; builder gets value setting, programmer gets
     definition/perms
   - inspection borrows from `@show`, `@display`, and `@prospectus`: own vs
     inherited members, ownership, flags, location, contents, children,
     instances, and impact hints

3. **Inverse indexes** in the repository / Directory layer:
   - parent -> children (so `inspect.children` is not a local-world walk)
   - feature -> attached_to (so `inspect.attached_to` works for features)
   - search-token tables (object name, verb name/source, property name/value)

4. Keep the catalog in the bundled local-catalog index. The install path
   installs `$builder` and `$programmer` as player classes and reparents `$wiz`
   to `$programmer` so the bootstrap administrator naturally has the surface.

## Surfaces

### Builder tools

| verb | role |
| --- | --- |
| `look()` | Surface map for agents. |
| `inspect(id, opts?)` | Structure/data view: parent, children, contents, location, flags, properties. No source. |
| `search(query, opts?)` | Bounded search across object names and property channels. No source. |
| `create(parent, opts?)` | New ordinary object owned by the invoking actor. `opts: {name?, description?, location?, fertile?}`. No `owner` option. |
| `chparent(id, parent, opts?)` | Re-parent within owner/fertile/cycle rules. Actor objects must stay under actor-derived parents. `opts.dry_run=true` checks only. |
| `recycle(id, opts?)` | Destroy owned objects (wizard-or-owner); `opts.dry_run=true` reports affected objects only. |
| `set_property(id, name, value, opts?)` | Set ordinary data values; no executable source or permission metadata. |

### Programmer tools

| verb | role |
| --- | --- |
| `look()` | Surface map for agents. |
| `inspect(id, opts?)` | Source-aware live call-tree shape with read filters. |
| `resolve_verb(id, descriptor)` | Where the verb actually resolves and the walk that got there. |
| `list_verb(id, descriptor, opts?)` | Readable source and metadata for one slot. |
| `search(query, opts?)` | Bounded grep including readable verb source when requested. |
| `install_verb(id, descriptor, source, opts?)` | Check and install source atomically. `opts.dry_run=true` returns diagnostics and would-install metadata without mutation. |
| `set_verb_info(id, descriptor, opts?)` | Metadata-only edit for aliases, arg spec, exposure flags, and perms. |
| `set_property_info(id, name, opts?)` | Define/update property metadata, perms, defaults, and type hints. |
| `edit_verb(id, descriptor, opts?)` | Enter the verb editor room for a per-actor source-buffer session. |
| `trace(id, verb_name, opts?)` | Next-N-invocations source-span trace. v1.1. |
| `eval(source, opts?)` | Compile and run a Woo expression (`opts.mode="expr"`, default) or statement block (`opts.mode="stmts"`) under the invoking actor's `progr`. `opts.dry_run=true` compiles only. Chat alias: `;expr` and `;;stmts`. |

### Editor tools

These tools are visible on `the_verb_editor` only while the actor is in the
editor room.

| verb | role |
| --- | --- |
| `what()` | Summarize the current edit session. |
| `view(opts?)` / `list(opts?)` | Return the current buffer, optionally line-numbered. |
| `replace(text)` | Replace the whole buffer. |
| `insert(line, text)` | Insert one line before a 1-based line number. |
| `delete(start, end?)` | Delete a 1-based inclusive line range. |
| `dry_run()` | Validate the buffer through the normal install path without mutation. |
| `save()` | Install the buffer if the expected version still matches, then leave. |
| `pause()` | Leave the editor while keeping the session. |
| `abort()` | Discard the session and leave. |

## Why `install_verb(..., {dry_run: true})` exists

The authoring surface should not expose a separate bytecode-facing compile
tool. Agents and IDEs still need a mutation-free way to ask "would this source
install here, and what are the diagnostics?" That is `install_verb` with
`dry_run: true`.

Using the install path for dry-run matters because correctness is not just
syntax. The check must include:

- actor authority over the target object
- descriptor/slot resolution
- duplicate-name and `append` semantics
- `mode` (`define`, `set_code`, `upsert`)
- `expected_version`
- parsed source header metadata
- source diagnostics

The returned shape is source-level: `ok`, `diagnostics[]`, parsed header
metadata, selected/would-create slot, and source spans/line-column positions.

It must not expose bytecode, opcodes, literal pools, stack depth, VM internals,
or source hashes as part of the normal MCP surface. On `dry_run: true`, the
runtime performs all validation and returns what would happen; it does not bump
versions, install source, alter aliases/tool flags, or emit install
observations. On ordinary install failure it returns the same diagnostic shape
and also mutates nothing.

Builder dry-runs use the same convention but do not compile source. The first
required cases are `chparent(..., {dry_run: true})`, mirroring LambdaCore's
`@check-chparent`, and `recycle(..., {dry_run: true})`, which returns the
objects and references that would be affected.

## LambdaCore reference points

LambdaCore splits this area across `$builder` (`@create`, `@recycle`,
`@chparent`, `@setprop`, `@audit`, `@prospectus`) and `$programmer`
(`@verb`, `@program`, `@property`, `@chmod`, `@args`, `@rmverb`,
`@rmproperty`, `@list`, `@show`, `@display`, `@grep`, `@forked`, `@kill`,
`eval`). Woo should retain the authority split even if an IDE chooses to render
both tool groups in one screen.

The key LambdaCore rule to preserve is target resolution. Virtual-world verbs
use the room's matching policy; builder/programmer verbs use the actor's own
matching policy (`player:my_match_object`) because the room owner must not
decide what object an authoring tool edits. Woo's MCP tools receive objrefs
directly, but search, future text aliases, and any name-to-ref helper must
follow the actor-scoped rule.

LambdaCore also treats source install as a two-step workflow: define the verb's
metadata (`@verb`) and then install code (`@program`). Verbs are addressed by
name for convenience or by 1-based verb number when duplicate names/arg specs
make a name ambiguous. MCP can present a single `install_verb` tool for the
common case, but the engine builtin still needs separate modes for define-only,
set-code-only, and upsert so agents do not accidentally rewrite metadata when
they meant only to reprogram a body. Metadata-only edits live behind
`set_verb_info`, so `@args` and `@chmod`-style operations do not require a
source reinstall.

## Reachability

The actor object is always in MCP reachability. Agents do not focus a separate
tool object; they inherit the tools. Reparent an actor to `$builder` to expose
builder verbs. Reparent an actor to `$programmer` to expose programmer verbs.
Granting the `programmer` flag is a separate act: without it, the programmer
verbs are visible but source-authoring builtins return `E_PERM`.

## Editor Rooms

The eventual rich authoring environment is an editor room, not a workshop or a
second backend. A `$verb_editor` is room-like: actors enter it, use ordinary
room/player communication while there, and hold per-actor edit sessions that
point at target objects and verb slots. The target object stays in place.

`the_verb_editor` may sit in `$nowhere` because `$nowhere` is not space-like and
is not a reachability container. It must not be seeded in an ordinary room or
shared `$space`. The programmer `edit_verb` door moves the actor into the
editor; normal reachability then exposes editor-room tools.

The editor contributes only editor-specific verbs: load/view buffer, edit
buffer, dry-run, save, pause, abort, and "what am I editing?" Presence, chat,
`wait`, focus, and observations come from the existing room, actor, and space
surfaces. See [../../spec/authoring/editor-rooms.md](../../spec/authoring/editor-rooms.md).

## What's deliberately not here

- **Bytecode or VM tools in v1**. The authoring surface is source-level.
  Diagnostics and traces use source spans. Add a separate expert-only
  disassembler later only if operators need runtime debugging at that level.
- **`$no_one`-style sandboxed eval**. Programmer `eval` runs under the invoking
  actor's `progr` and is the largest authority surface in the catalog; it is
  gated by `assertProgrammerActor` (wizard or progbit + `$programmer` ancestry).
  A powerless reduced-authority eval (LambdaCore's `$no_one`) is a separate
  safety story and is not yet provided.
- **`profile`**. The metric stream already covers it; promote when an agent
  explicitly asks.
- **Refactor primitives** (`rename_verb`, `rename_property`). Dynamic dispatch
  makes "find callers" lossy; `search` is the honest substitute.
- **Wizard/programmer flag changes**. Privilege flags remain a wizard/admin
  surface, not builder/programmer self-service.
- **A workshop room**. Convention layer above the tools — authors will use
  whatever room they like. The editor itself is a room when editing needs a
  shared place.
