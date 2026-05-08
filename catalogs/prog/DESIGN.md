# Prog Demo

The programmer experience is an in-world authoring surface for agents and
people. It keeps LambdaCore's `$builder` / `$programmer` authority split while
making both surfaces ordinary player classes.

## Classes

| Class | Parent | Description |
|---|---|---|
| `$builder` | `$player` | Builder player class. Object/data tools: create, chparent, recycle, set_property, inspect, search. |
| `$programmer` | `$builder` | Programmer player class. Source-aware tools: resolve_verb, install_verb, edit_verb, source listing, traces. |
| `$generic_editor` | `$space` | Room-like editor base. Owns per-actor edit sessions and source-buffer lifecycle verbs. |
| `$verb_editor` | `$generic_editor` | Verb-source editor room. Saves through the same source-level install path used by MCP tools. |

## Goal

Let an actor with the right capability shape the live object graph through MCP:
inspect, create, set data, install source, and adjust metadata without leaving
the world. The same tools can later back a browser IDE, but MCP is the first
product surface.

## Surfaces

- `$builder < $player` exposes object/data operations on actors inheriting from
  it: inspect, search, create, chparent, recycle, and set_property.
- `$programmer < $builder` exposes source/metadata operations on actors
  inheriting from it: inspect, resolve_verb, list_verb, search, install_verb,
  set_verb_info, set_property_info, edit_verb, and trace.

Builder authority is delegable without programmer authority. Programmer
authority is still gated by the actor's programmer or wizard flag because
installed verbs capture `progr` and change future execution authority. Class
membership controls the visible tool surface; progbit/wizbit remain the hard
authority facts. The core builtins check the wrapper verb's actual definer, so
the runtime does not need catalog-specific object names baked into source code.

Builder `create(parent, opts?)` creates objects owned by the invoking actor.
There is no `owner` option in the builder surface. Creating on behalf of another
actor is a wizard/admin operation, not ordinary delegated building.

Builder `chparent(id, parent, opts?)` follows LambdaCore's player-class safety:
actor/player objects can only be reparented under actor-derived classes. Moving
an actor out of the actor hierarchy is wizard/admin repair, not delegated
building.

## Source-Level Contract

Programmers do not see bytecode, opcodes, literal pools, stack depth, or VM
internals. `install_verb(..., {dry_run: true})` is the mutation-free diagnostic
path; it exercises the same authority, slot-resolution, version, and source
header checks as a real install.

## Editor Rooms

The richer programmer experience should follow LambdaCore's editor-room model
instead of introducing a separate workshop. A `$verb_editor` is a room-like
object. Actors enter it to edit; the edited object stays where it already is.
The actor's session records target object, verb descriptor or slot, expected
version, buffer, dirty state, and diagnostics.
The `sessions` property is an editor-owned implementation slot; actors interact
through editor verbs, not by writing the session map directly.

The seeded editor instance may sit in `$nowhere` because `$nowhere` is not
space-like and is not a reachability container. The invariant is that it is not
seeded in an ordinary room or any shared `$space`. It becomes reachable when
`edit_verb` moves the actor into it, and disappears from the actor's MCP tool
set again after `save`, `pause`, or `abort` moves the actor back.

Task-local communication between a team of agents comes from ordinary room and
actor behavior: presence, `say`, `emote`, `wait`, focus, and observations. The
editor adds only editor-specific session verbs such as `view`, `replace`,
`dry_run`, `save`, `pause`, `abort`, and `what`.

The browser IDE is a client view over the same editor-room session. MCP uses
the same verbs because the actor is in or focused on the editor room. There is
no hidden MCP-only coordination channel and no target-object movement into the
editor.

See [../../spec/authoring/editor-rooms.md](../../spec/authoring/editor-rooms.md).

## Eval

`$programmer:eval(source, opts?)` is the LambdaCore `eval` analogue. It compiles
the supplied source through the same DSL pipeline as `programmer_install_verb`
but does not persist the verb; instead the substrate `programmer_eval` builtin
runs the wrapped bytecode in a CallContext where `progr = caller`, so the code
runs with the invoking programmer's authority — never the catalog installer's.
`opts.mode = "expr"` (the default) wraps the source as `return <source>;`, so a
single expression like `the_chatroom:say("hi")` works. `opts.mode = "stmts"`
runs the source verbatim as a verb body. `opts.dry_run = true` compiles and
returns diagnostics without running anything.

Chat aliases: `;expr` and `;;stmts`, dispatched in the speech-prefix planner
to `actor:eval` so any actor inheriting from `$programmer` can use the chat
panel as a CLI. eval is `tool_exposed` so MCP agents see it as a tool, with
documentation that explains it can stand in for individual `woo_call`
invocations: a programmer agent can write `;target:verb(arg1, arg2)` from a
single `eval` tool instead of round-tripping through the gateway's generic
`woo_call` for each call.

Authority is the same hard surface as the rest of `$programmer`:
`assertProgrammerActor` requires wizard, or `$programmer` ancestry plus the
`programmer` flag. A non-programmer who reaches the verb via inheritance gets
`E_PERM`. Compile errors return `{ok: false, diagnostics: [...]}` because no
body ran. Runtime errors thrown by the eval body propagate up to the outer
direct-call transaction, which rolls back property writes, placement changes,
and parked tasks; the chat layer then renders the error frame. Catching the
error and returning a structured map would have committed partial mutations
(e.g. a `create(...)` followed by a `1/0` would leave the new object behind),
so the transactional contract is preferred even though it means chat shows a
plain error rather than a structured diagnostic.

## LambdaCore Alignment

- Builder commands use actor-scoped target resolution, not room matching.
- Reparent dry-run mirrors LambdaCore's `@check-chparent`.
- Verb descriptors are names or 1-based ordered slots, so duplicate names can
  be inspected and edited precisely.
- Metadata-only edits (`set_verb_info`) are separate from source installs, like
  LambdaCore's `@args` / `@chmod` split from `@program`.
- `eval` is on `$programmer` (LambdaCore's `$prog`), not `$builder`. Chat
  prefix `;` matches LambdaCore convention; `;;` runs a statement block.
- Editor rooms use ordinary room dispatch and presence. The editor session
  points at the target object/member; it does not move the target object.

## Deferred

- `trace` is declared but returns `E_NOT_IMPLEMENTED` until source-span tracing
  is wired for live calls.
- Full search indexes are deferred; the first version may use bounded local
  scans.
- Shared live buffers are deferred; first editor-room sessions are per actor.
