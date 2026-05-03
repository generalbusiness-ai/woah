# Pinboard

The first prototype had notes as text properties on a pinboard.

But now the design is more extensible and MOO-like:

* notes become first-class movable objects (`$pin < $note`)
* pinboard is a $space-shaped directory with per-pin layout
* kanban is a similar container to pinboard, but with different layout semantics.

## Classes

| Class | Parent | Description |
|---|---|---|
| `$pin` | `$note` | Pinboard note. `$note` subclass with an optional `.color`; remembers its color across moves. |
| `$pinboard` | `$space` | Spatial bulletin board. Holds `$note` descendants in `.contents` and tracks per-pin layout (x/y/w/h/z) keyed by pin object id. |
| `$kanban_board` | `$space` | Ordered-column board. Holds `$note` descendants as cards, including `$pin`, but tracks them in ordered lists within columns instead of freeform x/y layout. |

## Why redesign

LambdaMOO's bulletin-board pattern (notes as first-class `$thing`s, board
as a `$thing`-container with an acceptable filter and an audit-log)
generalizes cleanly. v0.1 had to reinvent every primitive — note ids,
take/move/edit semantics, permissions, observations — inside the board's
own verbs. v0.2 inherits all of that from `$portable`, `$note`, and
`$space`.  You can move `$pin` objects anywhere in the system if you like,
carry them from pinboard to kanban and back again.

## Class graph

Two independent inheritance trees, each rooted under `$thing`:

```
$thing
  ├── $portable               (catalogs/chat)
  │     └── $note             (catalogs/note)
  │           └── $pin        (catalogs/pinboard, adds .color)
  └── $space                  (core)
        └── $pinboard         (catalogs/pinboard)
        └── $kanban_board     (catalogs/pinboard)
                              .contents holds $note descendants
                              .layout map keyed by pin obj id
                              .columns list with ordered card refs
                              .palette / .viewport
                              presence semantics from $space
```

`$pinboard` is not a subclass of any "physical board" abstraction — it
behaves like one because the chat surface (look/enter/leave/say/page)
applies wherever `$space` descendants live. The board reads as physical
because it shares those verbs, not because of cross-tree inheritance.

## Data shapes

| Property | On | Purpose |
| --- | --- | --- |
| `text` | `$note` (inherited) | The actual content. List of strings. |
| `writers` | `$note` (inherited) | Who else can edit besides owner. |
| `color` | `$pin` | `null` or a string. Frontend renders white when null. |
| `contents` | `$pinboard` (built-in) | Pins currently on the board. |
| `layout` | `$pinboard` | Map keyed by pin obj id → `{x, y, w, h, z}`. |
| `next_z` | `$pinboard` | Z-index counter for stacking. |
| `palette` | `$pinboard` | Allowed colors when `add_note` accepts a color. `white` is accepted as UI shorthand for `null`, not stored. |
| `viewport` | `$pinboard` | Default viewport dimensions for clients. |
| `mount_room` | `$pinboard` | Optional room that hosts this pinboard for room-level activity events. |
| `contents` | `$kanban_board` (built-in) | Pins currently on the kanban board. |
| `columns` | `$kanban_board` | Ordered list of column records: `{id, title, cards}`. |
| `next_column_id` | `$kanban_board` | Monotone counter for generated stable column ids. |
| `mount_room` | `$kanban_board` | Optional room that hosts this kanban board for room-level activity events. |

Kanban boards default to three columns:

```
[
  { id: "todo", title: "To Do", cards: [] },
  { id: "doing", title: "Doing", cards: [] },
  { id: "done", title: "Done", cards: [] }
]
```

Column ids are stable operation targets. Titles are display labels and may be
renamed without changing card identity or history.

## Verbs

### Pin (`$pin`)

Inherits everything from `$note` (`read`, `write`, `set_text`, `erase`,
`is_readable_by`, `is_writable_by`, `look`). Adds:

- `set_color(color)` — write `.color`. `null` clears (frontend renders white);
  `"white"` is normalized to `null`.
  Permission: `:is_writable_by(actor)`.

### Pinboard (`$pinboard`)

| Verb | Purpose |
| --- | --- |
| `look` / `look_self` | Standard space look surface; returns the joined view (pins + layout + presence). |
| `enter` / `leave` | Subscribe/unsubscribe from incremental observations. |
| `viewport(x, y, w, h, scale)` | Frontend telemetry for client-side panning/zoom. |
| `list_notes` | Returns `[{ id, name, text, color, owner, writers, x, y, w, h, z }]` joining contents + layout. |
| `acceptable(object)` | Returns `isa(object, $note)`. Gates `:moveto` into the board. |
| `enterfunc(object)` | Called by core when a note arrives. Allocates default layout if missing; fires `pin_added`. |
| `exitfunc(object)` | Called when a note leaves. Removes its layout entry; fires `pin_removed`. |
| `post(pin)` | Convenience: `moveto(pin, this)` after the type check. Same effect as `pin:moveto(this)`. |
| `take(pin)` | Move pin to the actor's inventory. **Note-controller-only**: pin author or wizard. Board owners use `:eject` for curation; this verb does not grant board-owner authority. |
| `eject(pin)` | Move pin to the actor's inventory. **Curator path**: board owner or wizard only. Use this to remove someone else's pin from your board. |
| `move_pin(pin, x, y)` | Update layout. Brings the pin to top z. |
| `resize_pin(pin, w, h)` | Update layout. |
| `add_note(text, color?, x?, y?, w?, h?)` | Composite: `create($pin) + post + set_text + optional set_color + apply layout`. Backwards-compatible entry point. |

### Kanban board (`$kanban_board`)

`$kanban_board` is installed by the same `pinboard` catalog because it reuses
the same note/card substrate. It is a separate class, not a mode on
`$pinboard`: pinboards own freeform spatial layout, while kanban boards own
ordered column layout.

| Verb | Purpose |
| --- | --- |
| `look` / `look_self` | Standard space look surface; returns board title, columns, cards, and presence. |
| `enter` / `leave` | Subscribe/unsubscribe from incremental observations. |
| `list_columns` | Returns `[{ id, title, cards: [{ id, name, text, color?, owner, writers }] }]`. |
| `add_column(title, index?)` | Insert a new empty column. Generates a stable id from `next_column_id`. |
| `rename_column(column_id, title)` | Change display title only. |
| `delete_column(column_id)` | Delete an empty column. Raises `E_COLUMN_NOT_EMPTY` if the column has cards. |
| `move_column(column_id, index)` | Reorder columns. |
| `acceptable(object)` | Returns `isa(object, $note)`, matching `$pinboard`. `$pin` cards are the common case but not required. |
| `enterfunc(object)` | Called by core when a pin arrives. Adds the pin to the default column if it is not already in any column; fires `kanban_card_added`. |
| `exitfunc(object)` | Called when a pin leaves. Removes it from every column; fires `kanban_card_removed`. |
| `post_card(note, column_id, index?)` | Convenience: move an existing `$note` descendant onto this board and place it in a column. |
| `add_card(column_id, text, color?, index?)` | Composite: `create($pin) + post_card + set_text + optional set_color`. Always creates a `$pin`; use `post_card` for existing `$note` descendants. |
| `move_card(pin, column_id, index)` | Move a card to a column and position, removing it from its previous column first. |
| `reorder_card(pin, index)` | Reorder a card inside its current column. |
| `remove_card(pin)` | Move the pin to the actor's inventory. Same authority split as pinboard `take`. |
| `eject_card(pin)` | Curator path: board owner or wizard removes someone else's card. |

Kanban errors:

| Error | Meaning |
| --- | --- |
| `E_NO_COLUMN` | Column id does not exist. |
| `E_COLUMN_NOT_EMPTY` | Attempted to delete a column with one or more cards. |
| `E_DUP_CARD` | Card is already present where the operation would add it. |
| `E_NO_CARD` | Card is not present on this board. |
| `E_INDEX` | Target index is out of range. |

Kanban invariants:

- Each column id is unique within one board.
- A card appears in at most one column.
- Card order is the list order inside `column.cards`.
- A non-empty column cannot be deleted.
- Moving a card between columns removes it from the old column before inserting into the new one.
- `contents` and column membership stay synchronized: a card in any column is in `contents`, and a card leaving `contents` is removed from all columns.

## Permissions story

Properties:

- `$note.text` is `perms: ""` — direct property reads denied. The public
  API is the `:text()` verb, which gates via `:is_readable_by(actor)`.
  Subclasses (e.g. `$encrypted_note`) override the gate. This is the
  LambdaCore convention: text moves through a permission-checked verb,
  never via property access.
- `$pin.color`, `$pinboard.layout`, `$pinboard.next_z` are `perms: "r"`
  — public read, owner+wizard write only. All mutations route through
  verbs (`:set_color`, `:move_pin`, `:resize_pin`, `:enterfunc`,
  `:exitfunc`); no direct-write footguns.
- `$note.writers`, `$pinboard.palette/viewport/mount_room` are `perms: "r"`.

Verbs:

- **Editing pin text**: `:is_writable_by(actor)` → owner / writers /
  wizard.
- **Recoloring a pin**: same as editing (writes via `:set_color`).
- **Posting a pin onto a board**: anyone present at the board. The
  `:acceptable` filter is type-only (`isa(obj, $note)`).
- **Posting a note onto a kanban board**: anyone present at the board. The
  `:acceptable` filter matches pinboard and accepts any `$note` descendant.
  `$pin` is still the normal card class because it carries optional `.color`.
- **Taking your own pin off (`:take`)**: pin author or wizard. Board
  owner does NOT use `:take` for someone else's pin — they use `:eject`.
  This mirrors LambdaMOO's split: `take` is the controller-only path,
  `eject` is the curator path.
- **Ejecting someone else's pin (`:eject`)**: board owner or wizard.
- **Moving / resizing a pin's layout**: anyone present (it's spatial
  rearrangement, not content). Could tighten if needed.
- **Renaming / adding / moving kanban columns**: board owner or wizard.
- **Deleting kanban columns**: board owner or wizard, and only when empty.
- **Moving / reordering kanban cards**: anyone present. This is board
  organization, not content editing.

## Lifecycle

```
create $pin
   ↓ board:post(pin)              moves pin into board.contents
        :acceptable(pin)         → isa $note? yes
        moveto via core
        board:enterfunc(pin)     → allocate layout, fire pin_added
   ↓ pin:set_text(["Buy groceries"])
   ↓ pin:set_color("yellow")
   ⋮
   board:move_pin(pin, 200, 150)  update layout, fire pin_moved
   ⋮
   board:take(pin)                check perms, moveto pin → actor
        board:exitfunc(pin)      → remove layout entry, fire pin_removed
   pin is now in actor.contents
   ⋮
actor can:
     drop pin                     (in current room — needs $portable, which $note inherits)
     post pin on another_board    moveto pin → another_board
     @recycle pin                 if author or wizard
```

Kanban lifecycle:

```
create $pin
   ↓ kanban:add_card("todo", "Write the spec")
        create pin
        pin:set_text(["Write the spec"])
        kanban:post_card(pin, "todo")
        moveto via core
        kanban:enterfunc(pin)       → ensure column membership, fire kanban_card_added
   ⋮
   kanban:move_card(pin, "doing", 1)
        remove pin from old column
        insert pin into doing.cards at index 1
        fire kanban_card_moved
   ⋮
   kanban:rename_column("doing", "In Progress")
        update title only
        fire kanban_column_renamed
   ⋮
   kanban:delete_column("done")
        succeeds only if done.cards is empty
   ⋮
   kanban:remove_card(pin)
        move pin to actor inventory
        kanban:exitfunc(pin)        → remove from all columns, fire kanban_card_removed
```

## Seed instance

The pinboard catalog should seed one kanban board instance alongside
`the_pinboard`:

| Object | Class | Location | Mount room | Purpose |
| --- | --- | --- | --- | --- |
| `the_kanban` | `$kanban_board` | `demoworld:the_chatroom` | `demoworld:the_chatroom` | Living Room kanban board with the default `To Do` / `Doing` / `Done` columns. |

This keeps the first kanban surface visible in the Living Room, while the
existing spatial `the_pinboard` remains mounted on the Deck.

## Core dependencies

Pinboard v0.2 depends on three platform primitives that now exist in v0:

- `moveto(obj, target)` is the hook-respecting user move path. It runs the
  receiver's `:acceptable`, old container `:exitfunc`, and new container
  `:enterfunc`.
- `isa(obj, ancestor)` lets `:acceptable` filter by class without naming
  catalog internals in core.
- `create(parent, options)` accepts an options map with `owner`, `name`,
  `description`, `aliases`, `location`, `fertile`, and `recyclable`.

## Migration from v0.1

Bundled deployments run a one-time local boot migration:

1. Reconcile the pinboard catalog to install `$pin`, the new `$pinboard`
   properties, and the v0.2 verbs.
2. For each existing board, read legacy `.notes` records.
3. Create a `$pin` for each record, owned by the record author when that
   actor still exists and otherwise by the board owner.
4. Copy text, color, and layout into the new pin/layout shape.
5. Delete legacy `.notes` and `.next_note_id` instance overrides.

Remote tap installs should eventually express the same transformation as a
catalog migration step; the bundled catalog uses TS-side boot migration because
this is a one-time local state repair.

## Frontend implications

UI is hardcoded in the SPA, not part of the catalog.

- `list_notes` shape is unchanged on the wire (still
  `[{ id, text, color, x, y, w, h, z, author? }]` — minor field renames),
  so existing pinboard SPA can stay close.
- `pin.color = null` displays white. Existing palette dropdown may send
  `"white"` for the white swatch; the verb stores it as `null`.
- New observations: `pin_added`, `pin_removed`, `pin_moved`, `pin_resized`,
  `pin_recolored`. The umbrella `pinboard_activity` is still emitted for
  room-level summaries.
- Kanban frontend should not consume `layout`. It consumes `list_columns`
  and renders columns in array order and cards in `cards` order.
- Kanban observations: `kanban_column_added`, `kanban_column_renamed`,
  `kanban_column_deleted`, `kanban_column_moved`, `kanban_card_added`,
  `kanban_card_removed`, `kanban_card_moved`, plus `pin_recolored` /
  note edit observations inherited from `$pin` / `$note`.

## What's not in

- **Encryption** on pins. Comes with `$encrypted_note < $note` later.
- **`@notedit pin`** — needs the editor-rooms work.
- **Voting pins, ephemeral pins, timestamped pins** — these become trivial
  `$pin` subclasses once people want them. None are in v0.2.
- **Kanban swimlanes, WIP limits, assignees, due dates, task semantics.**
  Those either belong to later `$pin` subclasses or to `taskspace`; first-cut
  kanban is only ordered columns over shared `$pin` notes.

## Open questions

- Multi-line pin text. v0.1's single-line model becomes a list-of-strings
  via `$note.text`. Frontend needs to render multi-line.
- Should `move_pin` and `resize_pin` require board-presence (`enter`)?
  v0.1 didn't. Probably fine.
- Auto-recycle on `:eject` instead of moving to actor inventory? The
  ejecting actor may not want a stranger's pin in their inventory.
  Possibly: eject moves to a "trash" container per-board with a TTL.
- `add_card` intentionally creates only `$pin`. Other `$note` subclasses can
  still appear on the board through `post_card`.
