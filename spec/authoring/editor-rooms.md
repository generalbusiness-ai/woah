---
date: 2026-05-02
status: draft
---

# Editor Rooms

> Part of the Woo authoring specification. Working draft.

The authoring environment is itself a world object. Following LambdaCore, an
editor is a room-like object: an actor enters it, runs ordinary verbs there, and
leaves or resumes later. There is no separate workshop abstraction and no
special coordination layer for agent teams.

## E1. Principle

An editor room adds only editor-specific state and verbs:

- which actor has which edit session
- what object/member that session targets
- buffer text or structured edit state
- dirty/version state
- diagnostics from dry-run or install
- save/abort/pause/resume lifecycle

Everything else comes from the objects the editor already is or contains:

- presence comes from room/space membership
- `say`, `emote`, `look`, and `who` come from the room/chat feature
- actor-local working-set verbs come from the actor when a catalog uses them
- observations are ordinary emitted observations
- MCP tools are available because the editor is the active space, is directly
  contained by it, or is in the actor's inventory

This keeps task-local communication visible in the world. If several agents are
inside `$verb_editor`, their coordination is room-local conversation and
observations, not a hidden MCP side channel.

## E2. Shape

The first authoring catalog should define:

```
$generic_editor < $space-or-room
  $verb_editor < $generic_editor
```

`$generic_editor` owns the session lifecycle and basic buffer operations.
`$verb_editor` specializes target parsing, dry-run, install, and diagnostics for
verb source.

The exact parent depends on the deployed room model. In a chat-shaped world it
should be a room so text commands resolve naturally by current location. In a
non-chat world it may inherit from `$space` plus whatever conversational feature
provides the same verbs. The required property is not "chat"; it is ordinary
room-like dispatch and presence.

## E3. Sessions

An editor session is per actor. The first version should allow at most one live
session per actor per editor object, matching LambdaCore's simple invariant.

Minimum session fields:

```
{
  actor: obj,
  target: obj,
  kind: "verb",
  descriptor: str | int,
  slot: int | null,
  expected_version: int | null,
  buffer: str,
  dirty: bool,
  diagnostics: list<map>,
  started_at: int,
  updated_at: int,
  previous_location: obj | null
}
```

The edited object does **not** move into the editor. "Bring this into the
editor" means create or resume a session pointing at that object/member. The
object's world location, host placement, contents, and room behavior are not
changed by editing.

Session storage may begin as an editor property containing value records. If
shared sessions or large buffers become important, session objects can be
introduced later without changing the room model.
That storage is editor-owned implementation state. Actors mutate it only through
editor verbs; direct property writes to the whole session map are not part of
the authoring surface.

## E4. Lifecycle

The verb-editor flow:

1. `invoke(target, descriptor)` or an equivalent command resolves the target
   using actor-scoped authoring lookup, not room matching.
2. The editor checks that the actor may see the target and may attempt the
   requested authoring operation.
3. If the actor already has a dirty session, the editor refuses or asks the
   actor to `pause`, `save`, or `abort` first.
4. The actor is moved into the editor room and `previous_location` is recorded.
5. The editor loads source into the session buffer and records the target's
   current version.
6. Editing verbs mutate only the session buffer.
7. `dry_run` validates through the same install path that `save` uses, but
   mutates no target object.
8. `save` installs source with optimistic version checking, records diagnostics
   on failure, and exits on success.
9. `pause` leaves the room without deleting the session.
10. `abort` deletes the session and returns the actor to the previous location.

Disconnect does not inherently kill a session. Session cleanup is a policy on
the editor object, not a connection lifecycle side effect.

## E5. Commands And Tools

The first `$generic_editor` command set should stay small:

- `view` / `list` — show buffer, optionally with line numbers
- `replace` — replace whole buffer text
- `insert` / `delete` — line-oriented edits for text clients and agents
- `dry_run` — validate without mutation
- `save` — commit editor-specific target mutation
- `pause` — leave and keep session
- `abort` — discard and leave
- `what` — describe the actor's current session

MCP does not need a separate "collaboration" surface. When the actor is in the
editor room, ordinary dynamic tool reachability exposes the editor's verbs, the
actor's verbs, and any focused target refs. Agents can use `say`/`emote`/`wait`
from the existing room and actor surfaces.

The MCP entry path should mirror LambdaCore's `@edit` shape: a programmer
surface verb is the door, and the editor room owns the session once entered.
For example:

1. The actor calls an always-reachable programmer verb such as
   `edit_verb(target, descriptor)`.
2. That verb resolves the target using actor-scoped authoring lookup and calls
   `$verb_editor:invoke(...)`.
3. `$verb_editor:invoke(...)` records or resumes the actor's session and moves
   the actor into the editor room.
4. The actor's reachable MCP tool set changes because `actor.location` is now
   the editor room.
5. A tool-list refresh exposes editor-room verbs such as `view`, `replace`,
   `dry_run`, `save`, `pause`, `abort`, and `what`.

The editor tools are not globally visible. They appear for the same reason room
exits or room-local commands appear: the actor is there.

The seeded editor instance should not live in an ordinary room or any shared
`$space`; otherwise every actor at that location would see editor tools before
entering. `$nowhere` is acceptable precisely because it is not space-like and is
not a reachability container. The programmer door is the reachability
transition.

## E6. Verb Editor

`$verb_editor` specializes `$generic_editor` with:

- target fields: `{target, descriptor, slot, expected_version}`
- load: `programmer_list_verb(target, descriptor)`
- dry-run: `programmer_install_verb(target, descriptor, buffer, {dry_run: true, expected_version})`
- save: `programmer_install_verb(target, descriptor, buffer, {expected_version})`
- diagnostics: the structured source diagnostics returned by install dry-run or
  save

The editor should not expose bytecode. It is a source-level room.

The existing programmer tools remain useful outside the editor room. The editor
room is the collaborative authoring environment; the programmer class is the
capability/tool surface.

## E7. Local Or Browser Editors

A browser IDE or external editor may render the same session more richly, but it
must still drive the same editor-room verbs. The browser is not a second
authoring backend. It is a client view over:

- the actor's current editor session
- editor observations
- room-local communications
- source diagnostics

If a future protocol streams buffer deltas, those deltas still target the editor
session first. `save` remains the single path that mutates the target object.

## E8. Non-Goals

- No explicit workshop room.
- No global authoring chat.
- No hidden MCP-only coordination channel.
- No real-time collaborative text editing in the first version.
- No bytecode/disassembler in the normal editor.
- No target-object movement into the editor.
