# Outliner — design

> **v2.0.0 — ordered-edge index (structural authority change).** Tree shape
> and sibling order are now the **sole** responsibility of ONE room-owned edge
> cell per item: `$outline_item.__ordered_edge = { parent, rank }`, where
> `rank` is a base-62 **fractional-rank** string (`src/core/fractional-rank`).
> Siblings sort by plain string compare of their ranks; there is **no dense
> `.position` and no renumber**. The removed `.parent` / `.position` item
> props are replaced by this single edge. A mutation reads its parent's
> ordering via the owner-computed `ordered_children(parent)` projection (ONE
> bounded value, not an O(N) sibling scan) and writes exactly ONE edge cell —
> so an `add`/`move`/`reorder`/`remove` stays O(1) in sibling count and under
> the 64 KiB net warm-envelope even at 120+ children (the pre-v2 add tripped
> the ceiling past ~17 items). User-visible behaviour and every observation /
> `list_items` shape are unchanged — `parent_id`, `index`, `from/to_index`,
> `reparented_to`, `has_children` are now **derived** from edges. Sections
> below that describe the v1 `.parent`/`.position`/renumber mechanics are
> superseded by this model; see `notes/2026-07-13-outliner-edge-index-v2.md`.
> The v1→v2 data migration (deriving edges from legacy `(parent, position)`)
> is stage 4 (`migration-v1-to-v2.json` currently a documented stub).

A persisted shared hierarchy of short text items, with extremely minimal
UI: tab movement, collapse/expand, drag-reorder within siblings,
drag-drop across the tree, an undo button, and a per-item hidden
checkbox (with a client-side toggle to show hidden alongside visible).
Like other `$space` surfaces, it carries an embedded chat panel.

## Classes

| Class | Parent | Description |
|---|---|---|
| `$outline_item` | `$note` | One tree node. Text lives in the inherited `.text` slot; `.parent` points at another item in the same outliner (or `null` for top-level); `.position` is a 1-indexed sibling rank (siblings carry contiguous `1..N`); `.hidden` is a per-item flag. Optional `.name` distinguishes nodes for `$match`. **Not portable**: overrides inherited `.portable` to `false` for room `take` UX, and also overrides `:moveto` so direct movement cannot put it anywhere except an `$outliner` or `$nowhere`. Removal recycles. |
| `$outliner` | `$room` | Holds items in `.contents`; tracks per-actor focus and per-actor single-level undo in side maps. Tree shape and item state live on the items themselves. |

Items are first-class objects (objref-addressable), matching the
`$pin < $note` / kanban-card pattern. This keeps content/permissions
inherited from `$note` and lets chat verbs resolve item names through
`$match:match_object`. Scale target is **thousands of items per
outliner**; we'll profile and trim if/when a real workload exceeds that.

**Items own their own placement.** An `$outline_item` knows where it
sits — its parent pointer, its sibling-order key, and its hidden flag
are all properties on the item, not maps on the outliner. The outliner
is just the container that scopes them: when you ask "what's the tree?",
you scan `contents(outliner)` and group by `.parent`. This avoids the
two-place invariant (item-side parent vs. outliner-side child list) and
matches how the rest of the system models containment — `$pin.color`
lives on the pin, `$task.obligations` on the task, not on their host
spaces.

## Class graph

```
$thing
  ├── $portable
  │     └── $note
  │           └── $outline_item        (catalogs/outliner)
  │                 .parent            objref | null — another item in the same outliner, or null for top-level
  │                 .position          int — 1-indexed sibling rank (dense)
  │                 .hidden            bool — per-item hidden flag
  │                 .portable          bool = false (overrides inherited $portable default)
  │                 :moveto override   rejects targets that aren't $outliner (or recycling)
  │                 :recycle handler   defensive tree cleanup for direct recycle(item)
  └── $space
        └── $room                     (catalogs/chat)
              └── $outliner            (catalogs/outliner)
                    .contents holds $outline_item descendants and present actors
                    .focus_by_actor     per-actor focus into the tree
                    .last_undo          per-actor single inverse-op slot
                    .mount_room         standard space mount pattern
```

Like `$pinboard`/`$kanban_board`, `$outliner` is not a subclass of any
"document" abstraction — it reads as one because it is a room-shaped
space with look, exit, speech, and movement-hook behavior.

Its `room_roster()` presentation verb adapts the substrate's compact,
owner-authoritative projection. It does not enumerate `present_actors(this)`,
because a distributed planning shard need not materialize every collaborator's
actor cluster.

## Data shapes

| Property | On | Purpose |
|---|---|---|
| `text` | `$outline_item` (inherited) | The item's text. Markdown string; usually a single line, unrestricted. |
| `name` / `description` / `writers` | `$outline_item` (inherited from `$note`) | Standard note shape. |
| `portable` | `$outline_item` (override of `$portable.portable`) | `false`. Gives generic room `take` a normal "not carryable" answer before it reaches `:moveto`; the `:moveto` override remains the authoritative guard for direct move paths. |
| `parent` | `$outline_item` | `objref \| null`. Parent item in the same outliner, or `null` for top-level. Default `null`. `perms: "r"`. |
| `position` | `$outline_item` | `int`. Sibling rank under `.parent`; siblings of the same parent carry a contiguous dense `1..N` numbering after any mutation. Default `0` (re-stamped on enterfunc). `perms: "r"`. |
| `hidden` | `$outline_item` | `bool`. Default `false`. Flag is set only on items the user explicitly hid — descendant visual hiding is computed client-side. `perms: "r"`. |
| `contents` | `$outliner` (built-in) | Items currently in the tree, plus present actors. |
| `focus_by_actor` | `$outliner` | `map<str, objref \| null>`. Per-actor focus. Missing or `null` = root. Actor `enterfunc` clears a non-root stored focus, but it does not write an already-root/no-entry slot. Exit is observation-only for this map; stale entries are reset on the actor's next movement into the outliner or pruned by a later focus write against the compact owner roster, so durability is harmless. `perms: "r"`. |
| `last_undo` | `$outliner` | `map<str, map \| null>`. **Single-level undo**: one slot per actor holding the inverse of their most recent mutation, or `null`/missing if there's nothing to undo. Each new mutation overwrites the slot. `:undo` applies the slot and clears it. Actor `enterfunc` wipes an existing slot so every fresh visit starts empty; exit is observation-only for this map, and later undo writes prune entries for actors absent from the compact owner roster. `perms: "r"`. |
| `mount_room` | `$outliner` | Optional room hosting the outliner for room-level activity events and for seeding the demo instance's return exit. Same shape as `$pinboard.mount_room`. `perms: "r"`. |

All item-state properties and outliner-side maps are `perms: "r"` (public
read, owner+wizard direct-write). Mutations route through verbs.

### Data model assessment

The chosen model stays item-owned: `.parent`, `.position`, `.hidden`, and
the inherited note fields live on each `$outline_item`. The outliner stores
only visit-scoped side maps (`focus_by_actor`, `last_undo`) plus its normal
`.contents`. This is still the simplest durable model for v0:

- **No outliner-side child list.** A separate `children_by_parent` map would
  speed reads only if maintained perfectly, but every move/remove would then
  have a two-place invariant. Scanning `contents(this)` and grouping by
  `.parent` is acceptable for the target size (thousands of items), and it
  keeps one source of truth for tree shape.
- **No subtree records.** Removing a row keeps its direct children visible by
  reparenting them. Undo captures only the removed row and its direct child
  attachments; deeper descendants ride along because they remain attached to
  those children. A durable subtree table would add complexity without a v0
  user-visible need.
- **Single-level undo is a real simplification.** `last_undo` replaces a
  stack, which avoids pruning large per-actor arrays and makes reconnect
  behavior easy: clear the one slot from movement hooks.
- **Focus remains server-side.** It is not just UI chrome: chat `add` uses
  the actor's focus as the default parent. Keeping it on the outliner gives
  all clients and command paths the same current focus.
- **Defensive recycle cleanup is behavior, not another data structure.**
  Direct `recycle(item)` is possible through programmer/builder surfaces, so
  `$outline_item:recycle` delegates to the containing outliner's `_detach_item`
  helper before the substrate tombstones the item. That preserves the tree
  invariant without introducing a second index.

Two model refinements are adopted in this draft:

- `$outline_item.portable = false`, in addition to `:moveto`, so generic
  room `take` rejects with the normal non-carryable path.
- The remove-undo capture stores both the former integer `index` and the
  opaque `position`. Restore uses the captured `position` when it is still
  free under the captured parent; otherwise it recomputes from `index`.

### Tree invariants

For every `$outline_item i` whose `location == outliner`:
- `i.parent` is either `null` or another `$outline_item j` with
  `j.location == outliner` (parent must live in the same outliner).
- `i.parent` is not `i`, and `i.parent` is not a descendant of `i`
  (no cycles).
- `i.position` is a positive integer; siblings (same `.parent`) have
  distinct positions forming a contiguous `1..N` sequence, and render
  in ascending position order.

`:move_item` enforces all three before writing. Tests assert the
invariants after every mutation on a fixture.

### About `position` (sibling rank)

`position` is a 1-indexed integer rank within a sibling list. Siblings
of the same parent always carry a **contiguous dense numbering** —
after any mutation, the parent's N children have positions
`1, 2, …, N` in their visible order, with no gaps.

This is simpler than a fractional / CRDT-style scheme and well-matched
to the per-parent sibling counts typical of outlines (tens, not
thousands). Cost of a move/insert/reorder is O(N_siblings) writes
under the affected parent — bounded by the user's working set, not by
the whole outliner.

**The re-stamp helper.** `$outliner:_renumber_siblings(parent_id, ordered)`
is the internal path that writes `item.position`. Callers pass the desired
sibling order; the helper assigns each item a fresh `1..N` position directly
with catalog-owner authority. It deliberately does not call the public
`item:set_position` presence gate, because composers can run during repair,
replay, or session-scope churn where the actor's physical presence row is not
the authority being exercised.

Composers (`add_item`, `move_item`, `reorder_item`, `_restore_item`)
prepare the desired sibling order and then call `:_renumber_siblings`
once per affected parent. Cross-parent moves call it twice (source
and destination).

**Integer-index ↔ position conversion.**
`move_item(item, parent, index)` takes an integer `index` in
`0..N_siblings_after_move` (where 0 means "at the start"). The
composer:
1. Builds the new sibling order: remove `item` from its current
   sibling list under its current parent, then insert it under
   `parent` at slot `index`.
2. Validates `0 ≤ index ≤ N`; raises `E_INDEX` otherwise.
3. Calls `_renumber_siblings(old_parent)` if cross-parent, then
   `_renumber_siblings(new_parent)`.

Positions are mostly opaque from outside the catalog — clients
receive the derived integer `index` (0-based) in observations and
`list_items` output, mirroring the `position` (1-based) modulo the
indexing convention. (We expose 0-based `index` because that's what
the verb arguments use; the 1-based `position` is an internal
invariant.)

## Verbs

### Item (`$outline_item`)

Inherits the full `$note` surface (`read`, `set_text`, `write`, `erase`,
`add_writer`, `rm_writer`, `is_readable_by`, `is_writable_by`, `look`).
Adds these item-local verbs:

| Verb | Perms | Purpose |
|---|---|---|
| `moveto(target)` (override) | core | Accepts only `$outliner` targets and `$nowhere` (recycling). Any other target — including an actor's inventory — raises `E_NOT_PORTABLE`. This is what makes the class not-carryable. Re-dispatches through the default move chain when the target is permitted, so `:acceptable` / `:exitfunc` / `:enterfunc` still run on the outliners. |
| `recycle()` | core notification | Defensive cleanup for direct `recycle(item)`. If `location(this)` is an `$outliner`, calls `location(this):_detach_item(this, {emit: true, clear_item: true})` before substrate recycle bookkeeping tombstones the item. This is the same detach path used by `remove_item`, `eject_item`, and `exitfunc`; direct recycle does not get undo, but it must not leave children pointing at a tombstoned parent. |
| `set_hidden(hidden)` | actor present in this item's outliner / item author / wizard | Pure property write. Sets `.hidden`. Validates. **Does not emit an observation and does not write the undo slot** — that's the composer's job. |
| `set_position(position)` | actor present in this item's outliner | Pure property write. Validates positive integer for items remaining in an outliner; `0` is the transient cleared-placement marker used by `_detach_item` before an item leaves or is recycled. No observation, no undo. |
| `set_parent(new_parent)` | actor present in this item's outliner | Pure property write. Validates same-outliner and no-cycle. No observation, no undo. |

**Observation and undo discipline.** The outliner-specific item write
verbs (`set_hidden`, `set_position`, `set_parent`) are public/controller-safe
property writers. They do not emit observations and do not write the actor's
`last_undo` slot — they don't know which composer call they were part of, and
emitting from here would either double-fire (when called from a composer that
also emits) or fire single property-write events that lose composer-level
intent (e.g. an `outline_item_moved` collapsed into separate parent and
position writes). The internal `_renumber_siblings` helper is the exception:
it writes `.position` directly after a composer has built a validated sibling
order. Composers on the outliner emit exactly one structural observation per
user-facing operation and write the slot exactly once. Text is the exception:
inherited `$note:set_text` remains the single source of the `note_edited`
observation. The UI and chat never call outliner-specific item write verbs
directly; everything routes through the outliner surface.

### Outliner (`$outliner`)

| Verb | Perms | Purpose |
|---|---|---|
| `look` / `look_self` | anyone | Standard space look surface; returns title, full joined tree, presence. |
| room movement / `out` | inherited | Actors arrive through the substrate `moveto` chain, normally from browser tab activation or an exit. `out` is the inherited room command resolved through an exit whose destination is seeded by the world catalog. `$outliner` defines no public lifecycle verbs of its own. |
| `list_items()` | anyone | Joined depth-first view: `[{id, name, text, parent_id, index, hidden, owner, writers, has_children}, …]`. Built by the generic `object_tree_rows` substrate helper from the catalog-owned shape: scan `contents(this)`, keep `$outline_item` descendants, group by `.parent`, sort each group by `.position`, and walk depth-first. `index` is the derived sibling index. Items the actor cannot read return `text: ""`. The helper exists because building this large joined view with repeated woocode list concatenation exceeds the VM memory model on thousand-item outlines. |
| `acceptable(object)` | anyone | `isa(object, $outline_item) \|\| isa(object, $actor)`. |
| `enterfunc(object)` | core | For actors: reset a non-root `focus_by_actor[actor]` to root, clear that actor's undo slot if present, and emit `outliner_entered` plus mounted-room activity. A first entry at implicit root does not materialize a `focus_by_actor` row, avoiding no-op shared-map conflicts between independent actors. For items: if `item.parent` is unset (fresh item from `create` or a cross-outliner move), leave it at `null` (top-level). If set, validate it points to another item in this outliner — raise `E_INVARG` otherwise. If `item.position` is unset or empty, allocate a position past the last sibling. Emit `outline_item_added`. |
| `exitfunc(object)` | core | For actors: emit `outliner_left` plus mounted-room activity without mutating `focus_by_actor` or `last_undo`. Fresh-visit cleanup happens on the next `enterfunc`; keeping exit observation-only avoids shared-map conflicts on cross-scope movement commits. For items leaving this outliner by `moveto`, calls `_detach_item(object, {emit: true, clear_item: true})`. This reparents direct children to the item's former parent, clears the moving item's `.parent` and `.position` so a destination outliner can place it as top-level, and emits `outline_item_removed`. Recycle does not call `exitfunc`; the item-level `:recycle` handler calls the same helper. |
| `add_item(text, parent_id?, index?)` | anyone present | Composite: `create($outline_item, {owner: actor, parent: parent_id, position: <computed>}) + set_text + moveto(item, this)`. `parent_id` defaults to caller's focus (or `null` if focus is root). `index` chooses where among siblings; default is end. Emits `outline_item_added`. Sets caller's `last_undo` slot to `{verb: "remove_item", args: [new_item]}`. |
| `set_item_text(item, text)` | item author / writers / wizard | Composite: capture old text for undo, call `item:set_text(text)`, and let inherited `$note:set_text` emit `note_edited`. The outliner does not re-emit text changes. Sets caller's `last_undo` slot to `{verb: "set_item_text", args: [item, old_text]}`. |
| `move_item(item, new_parent_id, index?)` | anyone present | Re-parent and/or reorder. `new_parent_id == null` means root. Validates same-outliner and no-cycle (raises `E_CYCLE` if `new_parent_id` is `item` or a descendant). Builds the target sibling order around `index`, calls `item:set_parent(new_parent_id)`, then uses `_renumber_siblings` to assign positions. Idempotent at current `(parent, index)`: no-op. Emits **exactly one** `outline_item_moved`. Sets caller's `last_undo` slot to `{verb: "move_item", args: [item, old_parent, old_index]}`. |
| `reorder_item(item, index)` | anyone present | Intra-sibling reorder. Same as `move_item` with the current parent, but emits the distinct `outline_item_reordered` so UIs can animate intra-sibling motion separately. Idempotent. Sets caller's `last_undo` slot to `{verb: "reorder_item", args: [item, old_index]}`. |
| `hide(item, hidden)` | anyone present | Sole user-facing surface for hidden-toggling. Calls `item:set_hidden(hidden)`, emits `outline_item_hidden`, and sets caller's `last_undo` slot to `{verb: "hide", args: [item, !hidden]}`. Idempotent. The UI checkbox and chat `hide` both route here, never to `item:set_hidden` directly. |
| `_detach_item(item, opts?)` | internal | Shared cleanup helper. Validates `location(item) == this`, snapshots direct children, reparents them to `item.parent` with fresh adjacent positions, optionally clears `item.parent = null` and `item.position = ""`, and optionally emits one `outline_item_removed`. Idempotent enough for recycle paths: if there are no direct children left, it only performs the remaining clear/emit work requested by `opts`. |
| `remove_item(item)` | item owner / wizard | Controller path. Captures the full restorable state — see "Undo capture" below — then calls `recycle(item)`. `$outline_item:recycle` calls `_detach_item` before the item is tombstoned, so children are reparented on the same cleanup path used by direct recycle. Sets caller's `last_undo` slot to `{verb: "_restore_item", args: [<captured_state>]}` after recycle succeeds. The restored item from undo is a *new* objref. |
| `eject_item(item)` | outliner owner / wizard | Curator path: bypasses author-only gate. Same recycle path as `remove_item`, except eject does *not* touch the ejecting curator's `last_undo` slot. |
| `_restore_item(state)` | (internal; called only by undo) | Re-create an item from a captured state record. Creates with `{owner, name, description, writers, parent, position, hidden}` set, calls `set_text`, then `moveto`. Uses the captured `position` if free under the captured parent; otherwise recomputes from captured `index`. Then for each child captured in `state.children`, moves it back under the restored item at its captured position. Emits a single `outline_item_added` for the restored item and one `outline_item_moved` per re-parented child. Returns the new item objref. |
| `undo()` | actor | Read the actor's `last_undo` slot, clear it, dispatch the inverse op. Emits `outline_undone` with the consumed record. No-op (and no observation) if the slot is empty. |
| `focus_on(item?)` | actor | Set `focus_by_actor[actor] = item` (or `null` if no arg). Validates that `item` is in this outliner. Emits `outline_focus_changed` directed to the actor only. |

### Chat verbs

Three command words declared with `"command"` directives, dispatched
through the catalog command planner that pinboard already uses. Chat
commands use small wrapper verbs so their `args_from` shape can differ
from the structural direct-call surface:

All four `command` directives carry `"persistence": "durable"` —
they mutate persistent outliner state (`add`, `hide`) or persistent
per-actor state stored on the outliner (`focus`):

| Word | Verb | Command grammar | Behavior |
|---|---|---|---|
| `add` | `:add(text)` | `dobj: "string", args_from: ["argstr"], persistence: "durable"` | Calls `add_item(text)` under caller's focus. Empty text → `E_INVARG`. |
| `hide` | `:hide_command(item)` | `dobj: "object", prep: "any", iobj: "any", args_from: ["dobj_prefix"], persistence: "durable"` | Requires `<item>`. Calls `hide(item, true)`. Missing dobj does not match this command pattern and falls through to normal huh handling. Hiding via chat does not depend on or alter focus. |
| `focus <item>` | `:focus_command(item)` | `dobj: "object", prep: "any", iobj: "any", args_from: ["dobj_prefix"], persistence: "durable"` | Calls `focus_on(item)`. |
| `focus` | `:focus_root_command()` | `dobj: "none", prep: "none", iobj: "none", args_from: [], persistence: "durable"` | Calls `focus_on(null)`. |

These are the only outliner-specific chat verbs; everything else (room
movement, drag, collapse, undo button, the show-hidden toggle,
single-item hide via checkbox) is UI-driven against the normal room and
structural verb surface.

## Focus

Per-(actor, outliner) state. Stored on the outliner rather than the
actor because:
- it's scoped to this space (an actor can be present in multiple
  outliners; each has its own focus);
- it resets when the actor moves into the outliner, so it doesn't need
  to outlive the visit;
- the outliner already holds per-actor undo state, so the movement-hook
  lifecycle matches.

`outline_focus_changed` is **directed to the focusing actor only**
(observation envelope sets `to: actor`). Other clients don't need to
render someone else's focus position — keeps the broadcast cost zero
and matches the "extremely minimal UI" requirement.

## Undo

**Single-level undo.** Each mutating verb stores one inverse-op record
in the caller's `last_undo` slot. The record is `{verb: <str>, args:
[<...>]}`; `:undo` reads the slot, clears it, and dispatches that verb
with the recorded args. There is no stack — every new mutation
overwrites the slot, so an actor can only undo their most recent
operation.

- Slot is cleared on actor `enterfunc`; actor `exitfunc` is observation-only so
  cross-scope movement does not contend on the shared undo map. Any undo write
  prunes entries for actors not currently in `contents(this)`. A crashed or
  exited session leaves at most one stale record, which is discarded on the
  actor's next movement into the outliner.
- Undo dispatch does **not** write a new inverse — undo is one-way.
  (After an undo, the slot is empty; you can't redo.) Convention:
  every composer verb takes an optional final boolean argument
  `_no_store` (defaults `false`). When set `true`, the verb performs
  its work and emits its observation but skips the
  `last_undo[actor] := …` write. `:undo` dispatches with
  `dispatch(this, slot.verb, slot.args + [true])`. Composers that
  internally call other composers (e.g. `_restore_item` calling
  `move_item` per child) pass `_no_store = true` down so child calls
  don't clobber the parent's logical inverse mid-restore.
- Concurrent edits: last-writer-wins. If actor A moves item X and
  actor B then moves item X, A's `:undo` will replay "move X back to
  old position" against the current world, which may be surprising.
  Accepted trade-off for v0.

Stored inverses by verb:

| Forward op | Slot value |
|---|---|
| `add_item(text, p, i)` returning `item` | `{verb: "remove_item", args: [item]}` |
| `remove_item(item)` | `{verb: "_restore_item", args: [<captured state>]}` (see capture below); restored item is a *new* objref. |
| `eject_item(item)` | (does not touch the slot) |
| `move_item(item, new_p, new_i)` | `{verb: "move_item", args: [item, old_p, old_i]}` |
| `reorder_item(item, new_i)` | `{verb: "reorder_item", args: [item, old_i]}` |
| `hide(item, h)` | `{verb: "hide", args: [item, !h]}` |
| `set_item_text(item, text)` | `{verb: "set_item_text", args: [item, old_text]}` |

`eject_item` does not write the curator's slot — curation is not an
"edit my work" operation, and overwriting an ongoing edit's undo
record with an ejection inverse would surprise the curator. If the
original author wants their item back, they can re-add it.

### Undo capture for `remove_item`

A row removed is more than `(text, parent, index)` — it's a row with
state, possibly with children. The captured state record is:

```ts
{
  text:         str,                 // item.text at removal time
  name:         str,                 // item.name
  description:  str,                 // item.description
  writers:      [ObjRef],            // item.writers (snapshot)
  hidden:       bool,                // item.hidden
  owner:        ObjRef,              // item.owner (so restore re-owns correctly)
  parent_id:    ObjRef | null,       // former parent
  position:     int,                 // former 1-indexed sibling rank
  index:        int,                 // former sibling index
  children: [                        // direct children, in original sibling order
    { item: ObjRef, position: int }, // each child's pre-remove 1-indexed rank
    ...
  ]
}
```

At remove time, `remove_item` reparents the captured children to
`parent_id` (so they remain visible). At undo time, `_restore_item`:

1. Creates a new `$outline_item` with the captured `{owner, name,
   description, writers, parent_id, position, hidden}`. If `position`
   is now occupied under `parent_id`, it computes a fresh position from
   the captured `index`. `set_text` writes the text.
2. For each `(child, old_position)`, calls `move_item` to put the
   child back under the new item at its original position, restoring
   the subtree shape.
3. Emits one `outline_item_added` for the restored row, then one
   `outline_item_moved` per re-parented child.

Edge cases:
- If a captured child was itself recycled after the original remove,
  the restore skips that child silently. The remaining siblings still
  land back under the restored item.
- If a captured child has since been moved elsewhere (different parent
  or different outliner), the restore takes it back — last-writer-wins
  applies, same rule as `move_item` undo.
- `writers` snapshot uses captured objrefs; if a writer was recycled
  before undo, it's filtered out of the new writers list.

The user-visible promise is: **undoing `remove_item` restores the row
and its direct children to their pre-remove visible state, modulo
concurrent edits and a new objref on the row**. Deeper descendants
were never removed (they were attached to the captured children, not
to the removed item itself, by `_detach_item`'s child reparenting), so
they ride along.

## Show-hidden

Client-local toggle (UI state). The server emits the `hidden` flag in
every joined view and in `outline_item_hidden` observations; the client
decides whether to render hidden items, render them dimmed, etc.

Hidden items hide their descendants visually too, computed in the
client by walking up the parent chain. The server flag stays only on
the item the user clicked, which keeps the data minimal and makes
"unhide just this node" trivially correct.

## Observation shapes

All carry the standard `source` (= the outliner), `actor`, `ts` envelope.

| `type` | Additional fields |
|---|---|
| `outliner_entered` | `outliner: ObjRef`, `origin: ObjRef`, `text: str` |
| `outliner_left` | `outliner: ObjRef`, `destination: ObjRef`, `text: str` |
| `outline_item_added` | `item: ObjRef`, `parent_id: ObjRef \| null`, `index: int`, `text: str` |
| `outline_item_removed` | `item: ObjRef`, `reparented_to: ObjRef \| null` |
| `outline_item_moved` | `item: ObjRef`, `from_parent: ObjRef \| null`, `from_index: int`, `to_parent: ObjRef \| null`, `to_index: int` |
| `outline_item_reordered` | `item: ObjRef`, `parent_id: ObjRef \| null`, `from_index: int`, `to_index: int` |
| `outline_item_hidden` | `item: ObjRef`, `hidden: bool` |
| `outline_focus_changed` | `item: ObjRef \| null`; envelope `to: actor` (directed) |
| `outline_undone` | `inverse_op: {verb: str, args: list}` |
| `outliner_activity` | `outliner: ObjRef`, `text: str` (umbrella for room-level summaries when `mount_room` is set) |

Item text edits flow through the inherited `note_edited` observation;
the outliner does not re-emit text changes.

## Errors

| Error | Meaning |
|---|---|
| `E_NO_ITEM` | Target item is not in this outliner's tree. |
| `E_CYCLE` | Move would make `item` a descendant of itself. |
| `E_INDEX` | Target index is out of range for the destination's child list. |
| `E_INVARG` | Bad arg (e.g. empty `add` text, chat `hide` with no dobj, `move_item` to a parent in a different outliner). |
| `E_PERM` | Caller lacks permission for the verb (text edit, owner-gated remove). |
| `E_NOT_PORTABLE` | `$outline_item:moveto` rejected a target that isn't an `$outliner` or `$nowhere`. |

## Permissions

Properties:
- `$outline_item.text` — inherited `perms: ""`. Public API is `:text()` /
  `:set_text(text)`; gated by `:is_readable_by(actor)` /
  `:is_writable_by(actor)`. Standard `$note` convention.
- `$outline_item.parent` / `.position` / `.hidden` — `perms: "r"`. Public
  mutations route through `set_parent`, `set_position`, and `set_hidden`;
  internal composer renumbering writes `.position` directly with catalog
  owner authority after validating the desired sibling order.
- `$outliner.focus_by_actor` / `.last_undo` / `.mount_room` —
  `perms: "r"`. Verbs are the only mutators.

Verbs:
- **Cross-outliner moves via direct `moveto`**: item owner /
  source-outliner owner / wizard. The `$outline_item:moveto`
  override accepts `$outliner` targets type-wise, but only authorized
  actors may complete the move; otherwise raises `E_PERM`. (The
  composer `move_item` always rejects a target parent in a different
  outliner with `E_INVARG` regardless of authority — it's a
  same-outliner operation by design.)
- **Editing item text** (`set_item_text`, item-level `:set_text`):
  item owner / writers / wizard.
- **Structural ops** (`add_item`, `move_item`, `reorder_item`, `hide`,
  chat `add`/`hide`/`focus`): anyone present. Same rationale as
  pinboard's layout verbs — organization, not content.
- **Removing your own item** (`remove_item`): item owner / wizard.
  Mirrors pinboard `:take` — except removal *recycles* the item rather
  than handing it back, because `$outline_item` is not portable.
- **Ejecting someone else's item** (`eject_item`): outliner owner /
  wizard. Same recycle semantics as `remove_item`.
- **Undo** (`undo`): each actor operates on their own `last_undo`
  slot only. An actor can't undo someone else's edit through this
  verb. (Owners who need to revert curatorial decisions use direct
  verbs, not undo.)
- **Cannot be carried**: `$outline_item:moveto(target)` raises
  `E_NOT_PORTABLE` if `target` is not an `$outliner` (or `$nowhere` for
  recycling). Substrate `take`/`give`/`drop` cannot extract an item
  from its outliner. Cross-outliner moves *are* permitted; ejected
  items are recycled, not pocketed.

## Lifecycle

```
outliner:add_item("Buy groceries")
    create $outline_item with owner=actor, parent=null, position=<pastEnd>
    item:set_text("Buy groceries")          # inherited note_edited observation
    moveto(item, outliner)
        $outline_item:moveto(outliner) — target is $outliner, allowed
        outliner:acceptable(item) — true
        outliner:enterfunc(item)
            validate item.parent (null is fine)
            emit outline_item_added {parent_id: null, index: <derived>}
    set last_undo[actor] = {verb: "remove_item", args: [item]}
   ⋮
outliner:add_item("milk", parent_id: groceries, index: 0)
    create $outline_item with parent=groceries, position=<midpoint before first sibling>
    same enterfunc + observation flow
    last_undo[actor] is now {verb: "remove_item", args: [milk]}  (previous slot overwritten)
   ⋮
outliner:move_item(milk, dairy_aisle, null)   # drag-drop
    validate target outliner == this; reject cross-outliner
    validate no cycle (dairy_aisle not a descendant of milk)
    compute new position at end of dairy_aisle's children
    milk:set_parent(dairy_aisle)
    milk:set_position(<new>)
    emit outline_item_moved {from_parent: groceries, from_index, to_parent: dairy_aisle, to_index}
    last_undo[actor] := {verb: "move_item", args: [milk, groceries, old_index]}   # overwrites add inverse
   ⋮
outliner:hide(milk, true)                     # chat or UI checkbox
    milk:set_hidden(true)               # pure property write, no observation
    emit outline_item_hidden            # emitted by the composer, once
    last_undo[actor] := {verb: "hide", args: [milk, false]}   # overwrites move inverse
   ⋮
outliner:undo()                               # actor clicks the button
    read+clear last_undo[actor]; dispatch outliner:hide(milk, false) in no-store mode
    emit outline_undone {inverse_op: {...}}
    last_undo[actor] is now empty — clicking undo again is a no-op
   ⋮
outliner:remove_item(milk)                    # cleanup comes from $outline_item:recycle, not :exitfunc
    capture full state for the inverse:
      {text, name, description, writers, owner, hidden,
       parent_id: groceries, position: milk.position, index: <derived>,
       children: [{item: c1, position: c1.position}, {item: c2, position: c2.position}, ...]}
    recycle(milk)
        substrate :recycle handler runs (if any)
        $outline_item:recycle()
            location(milk):_detach_item(milk, {emit: true, clear_item: true})
                for each direct child c of milk:
                    new_pos = midpoint near milk.position under groceries
                    c:set_parent(groceries)
                    c:set_position(new_pos)
                milk:set_parent(null)
                milk:set_position("")
                emit outline_item_removed {reparented_to: groceries}
        recycleObjectLocal:
          - children of milk's *inheritance* are grafted up
          - milk.contents (none) is displaced; milk.location is left as-is
            while the object is torn down — no :exitfunc fires
        milk is destroyed
    last_undo[actor] := {verb: "_restore_item", args: [<captured state>]}
   ⋮
outliner:undo()                               # restore milk
    read+clear last_undo[actor]; dispatch _restore_item(<captured state>) in no-store mode
        create $outline_item with full state restored, set_text
        emit outline_item_added for the new item
        for each captured child still living:
            move_item(child, new_milk, child's old position-derived index)   # no-store
            emits outline_item_moved each
    emit outline_undone
   ⋮
take milk                                     # someone tries the take verb
    generic room take sees milk.portable == false and rejects as not carryable
    if a direct caller bypasses take and calls moveto(milk, actor),
      $outline_item:moveto(actor) raises E_NOT_PORTABLE
      the move never reaches the outliner's exitfunc
```

## Seed instance

| Object | Class | Location | Mount room | Purpose |
|---|---|---|---|---|
| `the_outline` | `$outliner` | `the_chatroom` | `the_chatroom` | Empty starter outliner mounted in the Living Room alongside `the_pinboard` and `the_dubspace`. |

The seed lives in **`catalogs/demoworld/manifest.json`** (not in
outliner's own manifest). Outliner's `depends` is just `@local:chat`
and `@local:note`; demoworld depends on `@local:outliner` and creates
`the_outline` in its own `seed_hooks` with `location: "the_chatroom"`.
This direction is enforced by
[`scripts/guard-catalog-layering.mjs`](../../scripts/guard-catalog-layering.mjs):
catalogs may not depend on `demoworld`. To ship the outliner in a
custom world, install `outliner` and create your own `$outliner`
instance — no demoworld dependency.

## UI

Outliner follows the standard tool workspace contract in
[`docs/reference/tool-ui.md`](../../docs/reference/tool-ui.md): a
`space-workspace` frame with an outliner main-region component and the
shared `chat:chat.space-mini` chat-region component. It should be read
as another example of the same model used by Pinboard, Dubspace, and
Tasks, not as a separate client-side integration pattern.

The catalog ships a `<woo-outliner-tree>` web component in
`ui/outliner-tree.ts`. The SPA renders it as the active component for
a dedicated **Outliner** tab (between Tasks and Inspector). Routing:

- `installBundledCatalogUi` (`src/client/main.ts`) imports the
  outliner module and manifest so the custom element is defined and
  the observation handlers + chat formatters register.
- `renderOutliner()` emits the `<woo-outliner-tree data-outliner-tree>`
  tag, resolved via `toolFrameComponentTag(outlinerSpace(), …)`.
- `mountOutlinerComponent()` sets `subject` and `woo` on the element
  and lets it render from projection. If the generic projection has the
  tree structure but not readable note text, the component uses the shared
  coalesced view hydrator to call `list_items` once for that missing-text
  signature.

The component treats projection as structural data: ids, parent,
position, hidden state, and roster are cheap to render immediately. The
joined `list_items` view is the semantic display authority for item text,
because `$note.text` readability is catalog-defined and generic
projection may omit it. Structural observations patch the local model so
normal add/edit/move turns stay responsive; weaker projection snapshots
must not erase text learned from observations or `list_items`. Tab state,
presence, and route URLs follow the same shape as Pinboard / Tasks
(`outliner` view hint, `routedSubjects.outliner`,
`scopedToolSubject("outliner")`).

The full `ui` block:

```jsonc
{
  "ui": {
    "abi": "woo-ui/v1",
    "modules": [
      { "id": "outliner-ui", "entry": "ui/outliner-tree.ts" }
    ],
    "components": [
      {
        "id": "outliner.tree",
        "module": "outliner-ui",
        "tag": "woo-outliner-tree",
        "surface": "main",
        "subject": "$outliner",
        "neighborhood": {
          "include": ["subject", "contents", "session_subscribers", "actor"]
        }
      }
    ],
    "frames": [
      {
        "id": "outliner.tree",
        "subject": "$outliner",
        "view": "default",
        "layout": "space-workspace",
        "regions": {
          "main": [{ "component": "outliner.tree", "subject": "this" }],
          "chat": [{ "component": "chat:chat.space-mini", "subject": "this" }]
        }
      }
    ],
    "observation_handlers": [
      {
        "module": "outliner-ui",
        "types": [
          "outliner_entered",
          "outliner_left",
          "outline_item_added",
          "outline_item_removed",
          "outline_item_moved",
          "outline_item_reordered",
          "outline_item_hidden",
          "outline_focus_changed",
          "outline_undone",
          "note_edited"
        ]
      }
    ],
    "chat_formatters": [
      {
        "module": "outliner-ui",
        "types": ["outliner_entered", "outliner_left", "outliner_activity"]
      }
    ]
  }
}
```

`note_edited` is in the handler list because item text updates flow
through `$note`'s inherited observation rather than an outliner-side
event.

The `frames` block declares `outliner.tree` as the main-region
component and `chat:chat.space-mini` as the chat-region component for
any `$outliner` instance. `toolFrameComponentTag` reads the frame's main
component when the SPA renders the Outliner tab, then writes
`subject` + `woo` on the tag and lets the component self-hydrate from
there. Once the actor is present in the outliner, the component uses
the shared ambient companion helpers from `src/client/framework.ts` to
render the same shell/slot used by Pinboard, Dubspace, and Tasks. The
host mounts the shared minichat component into that slot.

The component owns:

- Tree rendering with collapse/expand triangles. **Collapse state is
  client-local** (per-tab); not part of the server-side hierarchy. The
  user expects different collapse states in different tabs/sessions
  and doesn't want their open-folder choices broadcast.
- No Enter/Leave controls. The host moves the actor into the outliner
  when the Outliner tab becomes active; the component only renders the
  workspace and its tool controls. When present, the host mounts the
  shared minichat into the component's ambient companion slot.
- **Click-row-to-select, click-again-to-edit.** Selection in the
  browser UI is **client-local** — a per-tab affordance for "the row I'm
  pointing at right now," not round-tripped through the server. A single
  click on an unselected row selects it (no network call); a click on
  the already-selected row enters inline text editing — single-line
  input, commit on blur or Enter, routes to `set_item_text`. There is
  no separate focus button; the row itself is the affordance.
- **Create-in-place.** When a row is selected, the top "add an item…"
  form is hidden and the selected row carries a `+` button. Clicking
  it opens an inline new-child editor immediately below the selected
  row at the next indent level — making it visually obvious where the
  new item will land. Submitting calls `add_item(text, parent_id)`
  with the selected row id passed **explicitly**, so the browser UI
  does not depend on the actor's server-side focus. Pressing Escape
  or submitting empty text cancels. When nothing is selected the top
  add form is shown (no per-row `+`).
- **Clearing selection.** A "clear selection" button appears in the
  toolbar while a row is selected; pressing Escape with no editor open
  does the same thing. Both are pure client-side state resets.

### UI selection vs. server-side focus

The browser UI's selection state and `$outliner.focus_by_actor` are
**two separate capabilities** that happen to share a similar shape:

- **Server-side focus** (`focus_by_actor`, `:focus_on`, the chat
  `focus` command) is the parent default used by `:add(text)` and the
  natural way for chat/MCP users to express "where I'm working" when
  they don't have a live click-to-select gesture available. It is
  persisted on the outliner, visible to other clients via
  `outline_focus_changed`, and survives across the actor's session.
- **Browser UI selection** is per-tab, never sent to the server,
  invisible to other clients, and resets on tab close. It exists so
  the user can click a row to point at it and get immediate visual
  feedback without paying network latency on every selection.

Clicking a row in the browser UI does **not** call `:focus_on` and
does **not** alter the server-side focus map. Chat `add` and MCP
`add(text)` continue to use the server-side focus default; the
browser UI's add-child path passes its parent explicitly. The two
states can diverge — that is intentional. If you switch from chat to
browser (or vice versa) you re-establish "where I'm working" via the
new tool's idiom.

Other component-owned surfaces:

- Drag/drop on each row. Drop targets: above/below siblings (calls
  `reorder_item`) and onto a node (calls `move_item` with that node
  as new parent, index = end). Visual indicator only between rows.
- Hidden checkbox on each row. Routes to `outliner:hide(item, on)` — never to `item:set_hidden` directly. (Item-side write verbs are internal building blocks that don't emit observations or write the undo slot; only the outliner-side composer is on the user-facing path.)
- Show-hidden toggle (client-local). **On by default** so the per-row
  hide checkbox reads as a "mark hidden" affordance (strikethrough +
  muted text) rather than appearing to delete the row. Turning the
  toggle off hides items whose `hidden` flag is true and recursively
  hides their descendants.
- Undo button. Routes to `undo`. Always enabled; the verb is a no-op
  (no observation, no state change) when the slot is empty, so the
  client doesn't need to track slot state.
- Embedded chat mount point.

Client wire path: pinboard/kanban-pattern. `list_items` for hydration;
incremental observations applied as reducers. v2 commit plane for
mutations; v2 direct plane for read-only hydration.

## Frontend implications

- New observation types must be added to BOTH `isChatObservation` and
  `chatSystemText` in `src/client/main.ts` if they should surface in the
  chat panel. Defaults: `outliner_entered` / `outliner_left` route to
  chat (mirror `pinboard_entered` / `pinboard_left`); the structural
  events (`outline_item_added`, etc.) do not — they're tree-overlay
  events, not conversational. `outline_focus_changed` is directed to
  the focusing actor only and does not appear in chat.
- `framework.ts` `registerCoreObservationHandlers` does not need new
  entries; tree state is owned by the `<woo-outliner-tree>` component,
  not by the framework's generic patcher.

## Core dependencies

Primitives used here are already in v0:

- `moveto(obj, target)` — receiver-driven move with `:acceptable` /
  `:exitfunc` / `:enterfunc` chain.
- `isa(obj, ancestor)` — `:acceptable` type filter.
- `create(parent, options)` — for `add_item`.
- `recycle(obj)` — for `remove_item` / `eject_item`; `$outline_item:recycle`
  performs catalog cleanup before substrate tombstoning.

No new core surface required. No new DO bindings (uses existing
`$space` infrastructure). Demoworld seeds the sample outliner's in/out
exits; custom worlds that mount an outliner should do the same.

## Migrations

`v1.0.0` promotes `$outliner` from `$space` to `$room`, removes the
class-owned public `enter`/`leave`/`out` lifecycle verbs, and uses
movement hooks plus room exits instead. The catalog ships
`migration-v0-to-v1.json`; no local-boot migration, DO migration, or
spec-version bump is required.

## Tests

`tests/outliner.test.ts` covers:
- tree invariants after every mutation kind on a 10-item fixture
  (parent points to a same-outliner item or null; no cycles; sibling
  positions distinct)
- cycle rejection (`E_CYCLE`) on `move_item` (item → self, item →
  descendant)
- cross-outliner-parent rejection (`E_INVARG`) on `move_item`
- index bounds (`E_INDEX`) on `move_item` / `reorder_item`
- `$outline_item:moveto` rejects actor / room / other non-outliner
  targets with `E_NOT_PORTABLE`; `.portable == false` makes generic
  room `take` reject through the normal non-carryable path, and direct
  `moveto(item, actor)` still cannot pry an item out of its outliner
- `remove_item` reparents an item's direct children to the item's
  former parent through `$outline_item:recycle` / `_detach_item`, and
  emits `outline_item_removed` exactly once. Explicitly assert the
  children remain valid after recycle (their `.parent` points at the
  former parent, not at a tombstoned objref).
- direct `recycle(item)` from outside `remove_item` is also covered:
  `$outline_item:recycle` must run `_detach_item`, so the tree invariants
  still hold even without undo capture.
- direct cross-outliner `moveto(item, other_outliner)` (where the item changes outliners)
  drives `exitfunc` on the source outliner and `enterfunc` on the
  destination; assert observation pair and orphan reparenting on
  source side
- chat verbs: `add` resolves against actor focus; `hide_command` requires
  an explicit dobj and receives it via `args_from: ["dobj_prefix"]`;
  `focus_command` focuses an explicit item; `focus_root_command` handles
  bare `focus`
- per-actor focus and undo isolation (two actors in the same outliner
  must not see each other's undo or focus state)
- undo of each mutating verb returns the **visible state** to its
  pre-op shape, including:
  - `set_item_text` restores prior text
  - `hide` flips the flag back
  - `move_item` / `reorder_item` put the item back at old (parent, index)
  - `remove_item` restores text + name + description + writers +
    hidden + children, with children correctly under the restored
    item at their pre-remove positions
  (Modulo: the restored item has a new objref; concurrent edits since
  the op may make the result visibly different from a literal world
  rewind — last-writer-wins, accepted.)
- **single-level**: a second mutation overwrites the slot, so an
  earlier mutation can no longer be undone. Test: do A, do B, undo →
  state matches after-A; undo again → no-op, no observation.
- after `:undo` clears the slot, a follow-up `:undo` is a no-op and
  does not emit `outline_undone`.
- `eject_item` does not touch the curator's `last_undo` slot.
- `last_undo` cleared by actor movement into the outliner; actor exit leaves
  stale slots for the next entry/write cleanup rather than contending on the
  shared map during cross-scope moves.
- pruning: writing the slot drops entries belonging to actors not
  currently in `contents(this)`
- `hidden` flag is only set on the explicitly-flagged item
  (descendants' `.hidden` are untouched)
- `list_items` shape (joined view) and depth-first order
- text read-gate hides text but not the row

Performance test: build a 2000-item outliner, assert `list_items` and
tail `add_item` complete without exhausting VM memory. If latency becomes
the hot path on large outliners, revisit the joined-view shape
(incremental snapshots, paged listings, text-omitted skeletons with
on-demand text fetch).

## What's not in

- **Redo**. Not requested; can come later. The undo records carry
  enough information to support redo if needed (`{verb, args}` is
  itself the forward op once you've undone it).
- **Cross-session undo persistence**. Slot is cleared on actor entry and exit hooks.
- **Server-side collapse state**. Client-local only.
- **Server-side show-hidden state**. Client-local only.
- **Multi-select / bulk move**. v0 moves one item at a time.
- **Indentation by drag-rightward**. Drag-onto-parent is the only
  reparent gesture. Promote/demote keyboard shortcuts could come later.
- **Inline rich text / multi-line editing surface**. Single-line input
  in v0; long text wraps but isn't a markdown editor. Item text is
  still markdown-rendered on read.
- **Item-level subscriptions / "watch this branch"**. No notifications.

## Open questions

One design choice left explicitly open:

1. **Reparenting on remove.** v0 reparents an item's children to its
   former parent. Alternative: pull the entire subtree out with the
   removed item (so removing a parent recycles its children too). The
   current choice matches "remove this row" UX (children survive); a
   future `remove_subtree` verb covers the other intent if needed.
