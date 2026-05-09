# The verb editor

`the_verb_editor` is a room. To edit a verb, an actor walks into the
room (the programmer's `edit_verb` tool moves them); while there,
they see a small set of editor verbs — `view`, `replace`, `insert`,
`delete`, `dry_run`, `save`, `pause`, `abort`, `what`. The target
object stays where it already is; the editor just keeps a per-actor
**source buffer** pointed at it.

This is the LambdaCore editor-room model. Other actors can join the
same room (presence, chat, observations all work normally there).
Sessions are per-actor, so two programmers in the editor at once
each have their own buffer.

The class is `$verb_editor < $generic_editor < $space`. A bundled
seed instance lives in `$nowhere` so the editor doesn't show up as
a regular room in any space.

## Entering: `edit_verb`

```
woo_call("$me", "edit_verb", [<obj-id>, <verb-descriptor>, opts?])
```

The programmer-surface verb. It:

1. Resolves the verb (descriptor: a name, or an integer 1-based
   slot).
2. Captures the current source and the verb's `expected_version`.
3. Creates an editor session for you keyed on (target, descriptor).
4. Moves your actor into `the_verb_editor` room.

After this call, your reachable tool list shifts to include the
editor verbs.

## Editor session verbs

While you're in the editor:

| Verb | Purpose |
|---|---|
| `what()` | Summarize the current edit session: target, descriptor, expected version, dirty state. |
| `view(opts?)` / `list(opts?)` | Return the current buffer. `opts.numbered: true` for line-numbered output. |
| `replace(text)` | Replace the whole buffer with `text`. |
| `insert(line, text)` | Insert `text` before 1-based `line`. |
| `delete(start, end?)` | Delete a 1-based inclusive line range. `end` defaults to `start`. |
| `dry_run()` | Validate the buffer through the normal install path. Returns the same diagnostic shape as `install_verb({dry_run: true})`. No mutation. |
| `save()` | Install the buffer. Refuses if `expected_version` no longer matches. On success, the actor leaves the room. |
| `pause()` | Leave the editor room without discarding the session. The buffer is preserved; come back via `edit_verb` on the same target. |
| `abort()` | Discard the session and leave. Buffer is gone. |

A session is private to the actor — you can `view` your own buffer,
not someone else's. The `sessions` property on the editor is an
implementation slot; don't write to it directly.

## Typical flow

```
woo_call("$me", "edit_verb", ["the_lamp", "turn_on"])

# now in the editor room

woo_call("the_verb_editor", "view", [{numbered: true}])
# returns the current source

woo_call("the_verb_editor", "replace", ["verb turn_on()\n  this.lit = true\n  observe({type: \"say\", text: \"click\"})\nendverb"])

woo_call("the_verb_editor", "dry_run", [])
# returns {ok: true, diagnostics: [], ...}

woo_call("the_verb_editor", "save", [])
# installs and moves you out
```

For chat clients, `replace` is awkward (multi-line text in a chat
input is ugly). Editor rooms are friendlier from an MCP agent or
from a browser IDE that opens the buffer in a real editor. The
chat path is fine for small fixes; for larger edits, drive it
programmatically.

## Concurrency: `expected_version`

When `edit_verb` opens a session, it records the verb's current
version. On `save`, the substrate checks: if the verb's version has
moved (someone else edited it), `save` refuses with
`E_VERSION_MISMATCH`.

The recovery move is to `view` (your buffer is still good), exit
with `pause`, re-`edit_verb` (which captures the new version and
shows you the new source), and merge the changes by hand. Future
versions of the editor may add a smarter merge; today the discipline
is "small, fast edits — long-running buffers are likely to stale."

## Why a room and not a tool

A few reasons.

**Presence works.** Two programmers in the editor at once can see
each other (`who`), talk (`say`), and watch each other's actions in
the room. That's collaborative editing without any new
infrastructure.

**Reachability is the right primitive.** When you're in the editor,
the editor's verbs are reachable on it (it's your current
location). When you leave (save, pause, abort), they go away. No
explicit "subscribe" / "unsubscribe" — just walking in and out.

**The target doesn't move.** The verb you're editing stays attached
to its object; the actor moves. That keeps the rest of the world
stable while you edit.

**Browser IDE is the same surface.** A future rich web IDE just
opens the same editor session through normal MCP/REST verbs. There's
no separate IDE-only protocol.

## What's not yet in the editor

- **Shared live buffers** (two programmers editing the same
  buffer simultaneously) are deferred. First-version sessions are
  per-actor.
- **Multi-target sessions** (editing several verbs in one session)
  are deferred. One session per (target, descriptor).
- **Undo history** is deferred. `replace`, `insert`, `delete` are
  one-way until `save` or `abort`.

The room model is friendly to all of these — they'd land as new
verbs on the editor, not protocol changes.

## Where to read more

- [`../../catalogs/prog/DESIGN.md`](../../catalogs/prog/DESIGN.md)
  §"Editor Rooms" — design rationale.
- [`../../spec/authoring/editor-rooms.md`](../../spec/authoring/editor-rooms.md)
  — the normative editor-room model.
- [eval.md](eval.md) — alternative for one-shot edits and
  exploration.
- [programming-verbs.md](programming-verbs.md) — the install path
  the editor `save` calls into.
