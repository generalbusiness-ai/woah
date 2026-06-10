---
name: outliner
version: 1.0.0
spec_version: v1
license: MIT
description: Shared hierarchical text outliner. Items are first-class $outline_item < $note objects with parent / position / hidden; the outliner is an $outliner < $room that scopes the tree and carries per-actor focus and single-level undo from movement hooks. Chat commands are 'add', 'hide <item>', 'focus [<item>]'.
depends:
  - @local:chat
  - @local:note
keywords:
  - outline
  - notes
  - coordination
  - tree
---

# Outliner

A persisted shared hierarchy of short text items. Each row is a tree
node; users collaborate on a single outline together.

This catalog defines the `$outline_item` and `$outliner` classes and
seeds no instances of its own. The bundled `the_outline` instance —
mounted in the Living Room (`the_chatroom`) — is seeded by the
[demoworld](../demoworld/manifest.json) catalog, which depends on
this one. Worlds that want the outliner with their own room layout
install `outliner` directly and create their own `$outliner` instance.

## Chat verbs

In an outliner, chat input understands three commands:

- `add <text>` — append a new item under your current focus.
- `hide <item>` — mark the item as hidden. (Pass the item by name; the
  command does not implicitly use focus.)
- `focus <item>` / `focus` — set or clear your focus into the tree. A
  bare `focus` resets to the root, so subsequent `add` commands create
  top-level items.

Everything else (tab movement into the outliner, collapse/expand,
drag-reorder, drag-drop reparent, inline text editing, the hidden
checkbox, the show-hidden toggle, the undo button, and the embedded
minichat) is in the UI overlay.

## Items are not carryable

Outline items override `$portable.portable` to `false` and override
`:moveto` so direct movement cannot put them anywhere except an
`$outliner` (or `$nowhere` for recycling). You can't pick an item up
into your inventory or drop it in a room. To delete a row, use
`remove_item`. The class-level `:recycle` handler also runs the same
detach + reparent logic if anyone bypasses `remove_item` and recycles
an item directly, so children never end up pointing at a tombstone.

## Undo

Single-level: every mutation overwrites the actor's `last_undo` slot;
`undo()` consumes it. Slot is cleared by actor movement into and out of
the outliner, so a fresh visit always starts empty regardless of how the
prior session ended.

See [DESIGN.md](DESIGN.md) for the full behavior contract — class
shapes, verb signatures, observation envelopes, undo capture, the
sibling-rank renumbering scheme, and the test plan.
