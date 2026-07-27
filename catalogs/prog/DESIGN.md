# Prog Demo

The programmer experience is an in-world authoring surface for agents and
people. It keeps LambdaCore's `$builder` / `$programmer` authority split. The
surface objects are persistent classes that double as attachable *features*: an
actor gains the tools by having the surface composed onto it, not by being
reparented into it. Kind stays in the actor's own ancestry (`$agent` stays an
`$agent`), and the surface is an independent axis — see
[provisioning.md AP4](../../spec/identity/provisioning.md#ap4-class-model-normative)
and [features.md FT8](../../spec/semantics/features.md#ft8-patterns).

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

- `$builder` exposes object/data operations to actors that *carry* it — through
  ancestry (legacy `$builder` descendants) or as an attached feature: inspect,
  search, create, chparent, recycle, and set_property.
- `$programmer < $builder` exposes source/metadata operations to actors that
  carry it: inspect, resolve_verb, list_verb, search, install_verb,
  set_verb_info, set_property_info, edit_verb, and trace. Attaching
  `$programmer` provides the builder surface too, since it inherits `$builder`.

Every wrapper guards with `has_surface(actor, <surface>)`, which is true when
the actor carries the surface through either path, so a feature-composed actor
and a legacy descendant resolve identically. Builder authority is delegable
without programmer authority. Programmer authority is still gated by the actor's
`programmer` or `wizard` flag because installed verbs capture `progr` and change
future execution authority. The surface controls the *visible* tool set;
progbit/wizbit remain the hard authority facts. Wrappers drop task permissions
to the actor (`set_task_perms(actor)`) after the guard, so substrate operations
run as the actor rather than the `$wiz` verb owner.

Promotion is a feature attach, never a reparent. The catalog publishes its
surface reference to `$system.programmer_surface`; the AP6 provisioning verbs
read that property and attach/remove the surface atomically with the flag and
quota. The wizard identity `$wiz` carries `$programmer` the same way — as a
feature — and keeps `$wiz isa $player`.

Builder `create(parent, opts?)` creates objects owned by the invoking actor.
There is no `owner` option in the builder surface. Creating on behalf of another
actor is a wizard/admin operation, not ordinary delegated building.

`opts.location` defaults to the invoking actor, matching LambdaCore's `@create`
(`move(object, player)` at L42). Placement is not cosmetic: structural context —
inventory, or the space you occupy and its contents — is what makes an object
visible to `look`, to the client, and to an MCP session's tool resolver. An
object created into no container exists only as a returned id, so a verb
installed on it could never become a tool, and `create → install_verb → invoke`
could not close. `location: null` remains the explicit way to ask for that.
The default is applied here in woocode rather than inside
`builder_create_object`: the native stays a generic placement primitive
(carrying the presence and cross-host checks), while "a builder's output lands
in the builder's hands" is surface policy, visible in the manifest where an
agent reading the tool can see it. The `@create` command path keeps its
post-create `moveto` — it is a faithful LambdaCore port and runs the receiver
chain — so the two paths differ deliberately: `create` places atomically,
`@create` places through `:acceptable`.

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

### Status over Net (2026-07-26)

The editor had no Net or worker coverage until
`tests/worker/net-verb-editor.test.ts`. Proving it surfaced six defects — five
on the distributed path and one authorization gap — all now fixed; the full
loop works end-to-end over Net.

1. *Fixed.* The seeded instance lives in its own scope, which an ordinary turn
   never warms, so it was absent from the turn's world and `isa(editor, $space)`
   answered false — `edit_verb` raised `E_TYPE`. `edit_verb` now declares
   `authority.prefetch: [{ ref: "the_verb_editor" }, { arg: 0 }]`. Because the
   editor is named in the verb body rather than passed in, no derived prefetch
   root could reach it; the literal form was added for exactly this shape.
   **Aged worlds:** the gateway resolves the prefetch from the PERSISTED verb
   page, and deployment alone never updates durable definitions
   (spec/operations/net-cutover.md) — an already-installed world keeps failing
   until the operator runs the signed definition repair:
   `npm run repair:net-definitions -- <worker-base-url> '$programmer:edit_verb'`.
   `tests/worker/net-verb-editor-aged.test.ts` proves the aged failure, the
   repair, its idempotence, and the repaired entry/leave loop.
2. *Fixed.* Entering moved the actor's body but not its session: for a
   space-like destination `updatePresence` sets `activeScope` as a side effect,
   so the CA8 `session_scope` event was recorded as a no-op, and over Net only
   that event becomes the committed session cell the MCP active scope is read
   from. Every editor verb answered "tool is not available in this session
   context". `moveEditorActor` now captures the prior scope before the presence
   update.
3. *Fixed.* `pause`, `save`, and `abort` all move the actor OUT of the editor.
   The turn commits in `room:the_verb_editor` (the call target's scope) and the
   move writes the session cell, which is owned by the actor's cluster — so the
   plan-time fold makes the turn both read AND write a foreign session cell.
   `authorizeSessionSubmit` took the mint-write branch first and never recorded
   the committing room's `session_presence` checkpoint as proof of the folded
   read, so CO4 step 7 refused the commit `rider_unattested`. This was never a
   design gap: CO14's local-proof rule (spec/protocol/coherence.md, "A room
   authority has one equivalent local proof") already sanctions exactly this
   proof, and applies whether or not the same turn writes the replacement row —
   the written value is validated separately by the mint rule. The fix records
   that proof in the write branch (`src/net/sessions.ts`); a commit anywhere
   other than the active room still requires the ordinary CO2.3 owner
   attestation.
4. *Fixed.* Once (3) let a save commit at all, the commit was silently
   non-durable: `programmerInstallVerb` — reachable only through the editor
   machinery since the catalog verbs inlined the pipeline — mutated the
   planning world via `addVerb` without recording the authored verb read/write
   the way the `*ForActor` builtins do. The accepted transcript carried no verb
   cell, nothing rode to the target's anchor scope, and `save` reported ok
   while the live verb kept its old body. The fix records the page read
   (optimistic conflict pin) and the written page there.
5. *Fixed.* `moveEditorActor` relocated the body unconditionally, so a
   SECONDARY session entering or leaving the editor dragged the shared body
   with it, bypassing ordinary movement's primary-session gate
   (spec/semantics/moveto.md M2.1 step 7). Editor movement now keys exit
   presence by the moving session's active scope and physically relocates only
   from the actor's primary session (or the sessionless object-graph fallback).
6. *Fixed (authorization, not Net-specific).* `programmerInstallVerb` checked
   only object authorship, so a non-wizard programmer could edit_verb →
   replace → save a $wiz-owned verb on an object they own — modifying it and
   taking ownership — where `set_verb_code` and ordinary `install_verb`
   refuse. The install path now enforces the verb-owner rule (wizard, or the
   actor owns the existing verb) at save and dry-run, an update preserves the
   verb's existing owner instead of chowning to the installer, and
   `editorInvoke` refuses at the door so a session that can never save does
   not open (spec/authoring/editor-rooms.md E4 step 2;
   `tests/authoring.test.ts` "refuses editor and install access…").

The full loop — enter, edit, pause, resume, save, and the edited verb running
with its new behavior — is exercised over the authoritative Net turn path by
`tests/worker/net-verb-editor.test.ts`, including the secondary-session gate.

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
direct-call transaction, which rolls back property writes and placement
changes; the chat layer then renders the error frame. Catching the
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

## In-world commands

The `@`-prefixed verbs are the LambdaCore-shaped chat surface. Each is a
near line-for-line port from LambdaCore #217 / #6 / #218 / #630 with
divergences documented inline in the verb source. Surface gates mirror
the MCP-tool gates above.

| Command | Class | Purpose |
|---|---|---|
| `@contents [obj]` | `$builder` | Lists `obj`'s contents (or location's if no arg). |
| `@parents obj` | `$builder` | Lists `obj` plus its ancestor chain to `$root`. |
| `@kids obj` | `$builder` | Lists direct children of `obj`. |
| `@create parent named name[,alias…]` | `$builder` | Creates a child of `parent` and places it in inventory. |
| `@set obj.prop to value` | `$builder` | Sets an existing property's value. Will not auto-create properties. |
| `@recycle obj` | `$builder` | Destroys `obj` (LambdaCore #630). |
| `@verbs obj` | `$programmer` | Lists own verb names on `obj`. |
| `@properties obj` (alias `@props`) | `$programmer` | Lists own property names on `obj`. |
| `@property obj.name [value]` | `$programmer` | Adds a new property with optional initial value. |
| `@rmproperty obj.name` (alias `@rmprop`) | `$programmer` | Removes a property defined on `obj`. |
| `@verb obj:name[,alias…] [dobj [prep [iobj]]]` | `$programmer` | Adds a stub verb to `obj`. |
| `@args obj:verb [dobj prep iobj]` | `$programmer` | Sets or shows the dobj/prep/iobj specifier. |
| `@rmverb obj:verb` | `$programmer` | Deletes a verb defined on `obj`. |
| `@rename obj[:verb] to newname` | `$programmer` | Renames a verb or object (property branch deferred). |
| `@list obj:verb` | `$programmer` | Dumps verb source with line numbers (stub; full LambdaCore @list deferred). |
| `@chmod target perms` | `$programmer` | Changes verb or property perms (object branch deferred). Accepts `rxd` or `+r-x`. |
| `@chown target owner` | `$programmer` | Wizard-only owner change for verb or property (object branch deferred). |

## Deferred

- `trace` is declared but returns `E_NOT_IMPLEMENTED` until source-span tracing
  is wired for live calls.
- Full search indexes are deferred; the first version may use bounded local
  scans.
- Shared live buffers are deferred; first editor-room sessions are per actor.
- `@list` ranges, `with parens`/`without numbers` toggles, and `all` to walk
  the ancestor chain are deferred (the stub dumps source verbatim).
- `@rename` for properties needs override-migration on descendants; the
  current port emits a clear pointer.
- `@chmod` / `@chown` object branches need substrate primitives
  (`set_object_owner`, uniform per-object flag string); the current ports
  emit pointers to existing flag-management mechanisms.
- `@verb` / `@property` `<perms> [<owner>]` trail awaits
  `$string_utils:prefix_to_value` and `$string_utils:match_player`.
