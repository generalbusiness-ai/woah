# Pinboard

The first prototype had notes as text properties on a pinboard.

But now the design is more extensible and MOO-like:

* notes become first-class movable objects (`$pin < $note`)
* pinboard is a $space-shaped directory with per-pin layout
* kanban is a similar container to pinboard, but with different layout semantics.

> **Kanban status: design-only.** `$kanban_board` is described in this
> document but is not yet in `manifest.json` — the class, verbs, schemas,
> and `the_kanban` seed instance are pending implementation. Pinboard
> (`$pin`, `$pinboard`) is shipped and live.

## Classes

| Class | Parent | Description |
|---|---|---|
| `$pin` | `$note` | Pinboard note. `$note` subclass with an optional `.color`; remembers its color across moves. |
| `$pinboard` | `$room` | Spatial bulletin board. Holds `$note` descendants in `.contents` and tracks per-pin layout (x/y/w/h/z) keyed by pin object id. |
| `$kanban_board` | `$space` | Ordered-column board. Holds `$note` descendants as cards, including `$pin`, but tracks them in ordered lists within columns instead of freeform x/y layout. |

## Why redesign

LambdaMOO's bulletin-board pattern (notes as first-class `$thing`s, board
as a `$thing`-container with an acceptable filter and an audit-log)
generalizes cleanly. v0.1 had to reinvent every primitive — note ids,
take/move/edit semantics, permissions, observations — inside the board's
own verbs. v0.2 inherits all of that from `$portable`, `$note`, and
`$space`.  You can move `$pin` objects anywhere in the system if you like,
carry them from pinboard to kanban and back again.

## UI

The catalog declares `pinboard.board` as `<woo-pinboard-board>` in
`ui/pinboard-board.ts`. The component owns the board markup: create form,
canvas, notes, minimap, presence panel, and embedded mini-chat mount point. The
SPA host supplies scoped projection data, verb-call services, and the current
pinboard view; drag/resize gesture plumbing remains host-owned until the frame
action model carries those gestures directly.

Browser clients route Pinboard through v2. Activating the Pinboard tab moves the
actor to the board with the normal actor `moveto` path, so durable board
presence remains the authorization precondition for sequenced note/layout edits
without a component-level Enter/Leave control. Viewport telemetry and read-only
note hydration execute on the v2 direct plane with `live`; create, edit,
recolor, layout, take, and drop execute on the commit plane. The embedded
mini-chat also uses the catalog command planner over v2 so command aliases
remain catalog-owned instead of being parsed in client code.

The browser renders immediately from structural projection: board layout,
projected pin ids, note placement, color, and presence overlays. If that
projection identifies a note but does not carry readable note text, the SPA uses
the shared coalesced view hydrator to call `list_notes` once for the current
missing-text signature and writes the result into `pinboard_note` catalogState.
That catalog view state outranks later weaker generic projection, so a stale or
partial projection snapshot cannot blank note text that was already learned from
observations or `list_notes`.

Pinboard actor movement intentionally requests only the deferred room refresh
needed by the browser. It does not require a full nested board payload:
post-commit projection reads are ordinary transcript reads, and a board-mounted
parent-room snapshot can otherwise read the board's post-increment `next_seq`
while validating against the pre-commit head. The browser already refreshes the
board overlay through the v2 state plane.

## Class graph

Two independent inheritance trees, each rooted under `$thing`:

```
$thing
  ├── $portable               (catalogs/chat)
  │     └── $note             (catalogs/note)
  │           └── $pin        (catalogs/pinboard, adds .color)
  └── $space                  (core)
        └── $room             (catalogs/chat)
          ├── $pinboard       (catalogs/pinboard)
          │    .contents holds $note descendants and actors currently inside
          │    .layout map keyed by pin obj id → {x,y,w,h,z}
          │    .next_z, .palette, .viewport, .mount_room
          │    presence semantics from $room
          └── $kanban_board   (catalogs/pinboard)
               .contents holds $note descendants
               .columns list of {id, title, cards[]} (ordered)
               .next_column_id, .mount_room
               presence semantics from $room
```

`$pinboard` is not a subclass of any "physical board" abstraction — it
behaves like one because room look, exits, movement hooks, say, and page
apply wherever `$room` descendants live. The board reads as physical
because it shares those behaviors, not because of cross-tree inheritance.

## Data shapes

| Property | On | Purpose |
| --- | --- | --- |
| `text` | `$note` (inherited) | The actual content. Markdown string. |
| `writers` | `$note` (inherited) | Who else can edit besides owner. |
| `color` | `$pin` | `null` or a string. Frontend renders white when null. |
| `contents` | `$pinboard` (built-in) | Pins currently on the board, plus actors who have entered it. Note-listing and layout verbs filter to `$note` descendants. |
| `layout` | `$pinboard` | Map keyed by pin obj id → `{x, y, w, h, z}`. |
| `next_z` | `$pinboard` | Z-index counter for stacking. |
| `palette` | `$pinboard` | Allowed colors when `add_note` accepts a color. `white` is accepted as UI shorthand for `null`, not stored. |
| `viewport` | `$pinboard` | Default viewport dimensions for clients. |
| `mount_room` | `$pinboard` | Optional room that hosts this pinboard for room-level activity events. |
| chat feature | `the_pinboard` seed instance | The bundled demo board attaches ephemeral `chat:$transparent`. Utterances are live observations, not durable pinboard log entries, and public speech is also heard in the containing room. When `$persistent_conversational` lands, the seed hook can swap to the durable transparent variant. |
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
renamed without changing card identity or history. `column.cards` stores
ordered objref lists internally; the `list_columns` verb returns a joined
view (per-card text/color/owner inlined) rather than the raw refs.

**Default column.** When a card arrives via `enterfunc` without a
caller-chosen target column (`moveto` from outside, drag-drop in a future UI,
recovery during migration), it lands in the column at index 0 — the leftmost
column. A board must have at least one column for `enterfunc` to succeed; on
an empty-column board, `enterfunc` raises `E_NO_COLUMN` and the move is
rejected. Boards always seed with three columns so this is only reachable if
the board owner has explicitly deleted them all.

**Caller-chosen column placement.** `post_card(card, column_id, index?)` and
`add_card(column_id, …)` first complete a `moveto` (which fires `enterfunc`,
landing the card in the default column), then immediately call the kanban's
own `move_card(card, column_id, index?)` to relocate it into the chosen
column. Two observations are emitted in that case (`kanban_card_added` from
the default column, then `kanban_card_moved` to the target). Frontends that
care about a single "added at column X" event should consume
`kanban_card_added` only when the source column id is the default and treat
the immediately-following `kanban_card_moved` as the authoritative final
placement, OR debounce per-card events within one applied frame's seq.

This is the chosen resolution of three plausible designs (a per-card
"next column" hint stashed before `moveto`; a default-then-relocate flow;
or `enterfunc` skipping the placement when a target was set). The
default-then-relocate flow keeps `enterfunc` self-contained — it doesn't
need to read transient state from a sibling verb — at the cost of one extra
observation per card add.

## Verbs

### Pin (`$pin`)

Inherits everything from `$note` (`read`, `set_text`, `write`, `erase`,
`add_writer`, `rm_writer`, `is_readable_by`, `is_writable_by`, `look`).
Adds:

- `set_color(color)` — write `.color`. `null` clears (frontend renders white);
  `"white"` is normalized to `null`.
  Permission: `:is_writable_by(actor)`.

### Pinboard (`$pinboard`)

| Verb | Purpose |
| --- | --- |
| `look` / `look_self` | Standard space look surface; returns the joined view (pins + layout + presence). |
| room movement / `out` | Actors arrive through the substrate `moveto` chain, normally from browser tab activation or an exit. `out` is the inherited room command resolved through an exit whose destination is seeded by the world catalog. `$pinboard` defines no public lifecycle verbs of its own. |
| `viewport(x, y, w, h, scale)` | Frontend telemetry for client-side panning/zoom. |
| `list_notes` | Returns `[{ id, name, text, color, owner, writers, x, y, w, h, z }]` joining contents + layout. |
| `acceptable(object)` | Returns `isa(object, $note) || isa(object, $actor)`. Notes and actors can enter; layout verbs ignore actors. |
| `enterfunc(object)` | Called by core when an object arrives. For actors, emits `pinboard_entered` plus mounted-room activity. For notes, allocates default layout if missing and fires `pin_added`. |
| `exitfunc(object)` | Called when an object leaves. For actors, emits `pinboard_left` plus mounted-room activity. For notes, removes its layout entry and fires `pin_removed`. |
| `post(pin)` | Convenience: `moveto(pin, this)` after the type check. Same effect as `pin:moveto(this)`. |
| `drop(object)` | Sequenced room-style convenience for a carried note. Resolves the carried object, requires `location(pin) == actor`, and calls `moveto(pin, this)`, so `enterfunc` owns placement. |
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
| Verb | Perms | Purpose |
| --- | --- | --- |
| `look` / `look_self` | anyone | Standard space look surface; returns board title, columns (joined card view), and presence. See *Return shapes* below. |
| `enter` / `leave` | anyone | Subscribe/unsubscribe from incremental observations. |
| `list_columns` | anyone | Returns the columns + joined card view. See *Return shapes*. |
| `add_column(title, index?)` | board owner / wizard | Insert a new empty column. Generates a stable id from `next_column_id`. Emits `kanban_column_added`. |
| `rename_column(column_id, title)` | board owner / wizard | Change display title only. Emits `kanban_column_renamed`. |
| `delete_column(column_id)` | board owner / wizard | Delete an empty column. Raises `E_COLUMN_NOT_EMPTY` if the column has cards. Emits `kanban_column_deleted`. |
| `move_column(column_id, index)` | board owner / wizard | Reorder columns. Emits `kanban_column_moved`. |
| `acceptable(object)` | anyone | Returns `isa(object, $note)`, matching `$pinboard`. `$pin` cards are the common case but not required. |
| `enterfunc(card)` | core | Called by core when a card arrives. Places it in the default column (column 0) if not already in any column; raises `E_NO_COLUMN` on a board with zero columns. Emits `kanban_card_added`. |
| `exitfunc(card)` | core | Called when a card leaves `contents`. Removes it from every column. Emits `kanban_card_removed`. |
| `post_card(card, column_id, index?)` | anyone present | Convenience: move an existing `$note` descendant onto this board, then `move_card` it into the chosen column. Two observations: `kanban_card_added` (default column from `enterfunc`) followed by `kanban_card_moved` to the target. |
| `add_card(column_id, text, color?, index?)` | anyone present | Composite: `create($pin) + post_card + set_text + optional set_color`. Always creates a `$pin`; use `post_card` for existing `$note` descendants. |
| `move_card(card, column_id, index?)` | anyone present | Move a card to a column at the given index, removing it from its previous column first. Idempotent: moving to the card's current column-and-index is a no-op (no observation, no error). Emits `kanban_card_moved` when the column changes. |
| `reorder_card(card, index)` | anyone present | Reorder a card inside its current column. Idempotent at current index. Emits `kanban_card_reordered` (distinct from `kanban_card_moved` so frontends can animate intra-column reorders separately). |
| `remove_card(card)` | card author / wizard | Move the card to the actor's inventory. Controller path; matches pinboard `:take`. |
| `eject_card(card)` | board owner / wizard | Curator path: removes someone else's card from the board. |

Kanban errors:

| Error | Meaning |
| --- | --- |
| `E_NO_COLUMN` | Column id does not exist (or `enterfunc` ran on a board with zero columns). |
| `E_COLUMN_NOT_EMPTY` | Attempted to delete a column with one or more cards. |
| `E_DUP_CARD` | Card is already on this board (`post_card` of a card already in `contents` — use `move_card` instead). Same-column-and-index moves do NOT raise this; they're no-ops. |
| `E_NO_CARD` | Card is not present on this board. |
| `E_INDEX` | Target index is out of range. |

Kanban invariants:

- Each column id is unique within one board.
- A card appears in at most one column on this board.
- A card cannot be in two `$kanban_board.contents` simultaneously — that's
  just `moveto` semantics, restated for the kanban contract: moving a card
  from one kanban to another removes it from the source's `contents` and
  thus from all columns of the source.
- Card order is the list order inside `column.cards`.
- A non-empty column cannot be deleted.
- Moving a card between columns removes it from the old column before inserting into the new one.
- `contents` and column membership stay synchronized: a card in any column is in `contents`, and a card leaving `contents` is removed from all columns.
- Recycling a card object (`@recycle pin`) fires the receiver's
  `:on_recycle` chain, which includes the kanban's `exitfunc`, removing the
  card from every column before the object is destroyed. The `kanban_card_removed`
  observation precedes the recycle observation.

### Return shapes

`look_self` returns:

```ts
{
  id:           ObjRef,             // the kanban board
  title:        str,                // .name
  description:  str | null,
  columns:      [                   // ordered by column index
    {
      id:    str,                   // stable column id
      title: str,                   // display title
      cards: [
        {
          id:       ObjRef,         // pin / note objref
          name:     str,            // card.name (presentation only)
          text:     str,            // markdown body; empty string if actor cannot read
          color:    str | null,     // null on non-$pin cards
          owner:    ObjRef,
          writers:  [ObjRef]
        }, …
      ]
    }, …
  ],
  present_actors: [ObjRef]          // compatibility actor ids for existing clients
}
```

`list_columns` returns just the `columns` field above (same per-card joined view).

`room_roster()` is the canonical v2 presentation roster. Pinboard is a
workspace, not an embodied room, so its roster rows are distinct actors from
`session_subscribers`, enriched as `{id, name, presence, idle_seconds?}`.
`live_audience(observation?)` is the separate delivery contract and returns
live subscribed session ids after the substrate observation routing rules run.
Future UI/API code should prefer `room_roster()` over `present_actors` or
`subscribers`.

**Unreadable cards.** When the calling actor cannot read a card's text
(`note:is_readable_by(actor) → false`), the card still appears in the
joined view but `text` is `[]`. `name`, `color`, `owner`, `writers`, `id`
remain visible — the card's *presence* on the board is not a secret;
only its content is gated. This matches `$pinboard:list_notes` behavior.

### Observation shapes

All kanban observations carry `source` (the board), `actor`, and `ts` per
the standard envelope. Type-specific fields below:

| `type` | Additional fields |
| --- | --- |
| `kanban_column_added` | `column_id: str`, `title: str`, `index: int` |
| `kanban_column_renamed` | `column_id: str`, `title: str` (new title) |
| `kanban_column_deleted` | `column_id: str` |
| `kanban_column_moved` | `column_id: str`, `index: int` (new index) |
| `kanban_card_added` | `card: ObjRef`, `column_id: str`, `index: int` |
| `kanban_card_removed` | `card: ObjRef` |
| `kanban_card_moved` | `card: ObjRef`, `from_column: str`, `to_column: str`, `index: int` |
| `kanban_card_reordered` | `card: ObjRef`, `column_id: str`, `from_index: int`, `to_index: int` |

These should land in `manifest.json` as `schemas[].on === "$kanban_board"`
entries when the implementation ships, mirroring `$pinboard`'s schema list.

The non-kanban `$pinboard` schemas cover board presence and layout:
`pinboard_entered`, `pinboard_left`, `pinboard_viewport`, `pin_added`,
`pin_removed`, `pin_moved`, `pin_resized`, `note_added`, and
`pinboard_activity`. Board/layout observations carry `board` so a scoped
client can reduce them into the correct overlay without consulting global
world state. Pin-level events (`pin_recolored` and `$note` edit observations)
propagate through `$pin`/`$note` regardless of which board the pin lives on.

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
- **Moving / reordering kanban cards** (`move_card`, `reorder_card`): anyone
  present. This is board organization, not content editing.
- **Removing your own card from a kanban** (`remove_card`): card author or
  wizard. Mirrors pinboard `:take`.
- **Ejecting someone else's card from a kanban** (`eject_card`): board owner
  or wizard. Mirrors pinboard `:eject`.
- **`add_card` (creates `$pin`) intentionally only mints `$pin`s.** A
  publisher who wants `$voting_note` or `$timestamped_note` cards on a
  kanban must `create($voting_note, ...) + post_card(card, column)` —
  there's no kanban-side factory for non-`$pin` note subclasses.

## Lifecycle

```
create $pin
   ↓ board:post(pin)              moves pin into board.contents
        :acceptable(pin)         → isa $note? yes
        moveto via core
        board:enterfunc(pin)     → allocate layout, fire pin_added
   ↓ pin:set_text("Buy groceries")
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
kanban:add_card("doing", "Write the spec")
        create $pin (the new card)
        card:set_text("Write the spec")
        kanban:post_card(card, "doing")
            moveto card → kanban
            kanban:enterfunc(card) → place in column 0 (default), emit kanban_card_added
            kanban:move_card(card, "doing", null) → relocate, emit kanban_card_moved
   ⋮
   kanban:move_card(card, "review", 1)
        remove card from "doing"
        insert into "review".cards at index 1
        emit kanban_card_moved {from_column: "doing", to_column: "review", index: 1}
   ⋮
   kanban:reorder_card(card, 0)
        intra-column reorder within the card's current column
        emit kanban_card_reordered {column_id, from_index, to_index: 0}
   ⋮
   kanban:rename_column("doing", "In Progress")
        update title only, emit kanban_column_renamed
   ⋮
   kanban:delete_column("done")
        succeeds only if done.cards is empty, else E_COLUMN_NOT_EMPTY
        emit kanban_column_deleted
   ⋮
   kanban:remove_card(card)             # author / wizard path
        moveto card → actor.inventory
        kanban:exitfunc(card) → remove from all columns, emit kanban_card_removed
```

## Seed instance

The pinboard catalog defines `$pin`, `$pinboard`, and (when shipped)
`$kanban_board` but seeds no instances of its own. The bundled
`the_pinboard` instance — mounted on the Deck (`the_deck`) — is seeded
by the [demoworld](../demoworld/manifest.json) catalog, which depends
on pinboard. When `$kanban_board` ships, its bundled `the_kanban`
instance will likewise live in demoworld:

| Object | Class | Location | Mount room | Purpose |
| --- | --- | --- | --- | --- |
| `the_kanban` | `$kanban_board` | `the_chatroom` | `the_chatroom` | Living Room kanban board with the default `To Do` / `Doing` / `Done` columns (added to demoworld's `seed_hooks` when the class lands). |

The dependency direction is enforced one-way:
[`scripts/guard-catalog-layering.mjs`](../../scripts/guard-catalog-layering.mjs)
rejects any catalog (other than demoworld itself) that declares
`@local:demoworld` in its `depends`. A world that wants the pinboard
classes with a different room layout installs `pinboard` directly and
creates its own `$pinboard` / `$kanban_board` instances.

## Core dependencies

Pinboard v0.2 depends on three platform primitives that now exist in v0:

- `moveto(obj, target)` is the hook-respecting user move path. It runs the
  receiver's `:acceptable`, old container `:exitfunc`, and new container
  `:enterfunc`.
- `isa(obj, ancestor)` lets `:acceptable` filter by class without naming
  catalog internals in core.
- `create(parent, options)` accepts an options map with `owner`, `name`,
  `description`, `aliases`, `location`, and `fertile`.

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

The current UI renderer still lives in the SPA, but scoped clients consume the
catalog's observations and `list_notes`/snapshot shapes through the shared
client projection rather than through a full-world snapshot model.

- `list_notes` shape is unchanged on the wire (still
  `[{ id, text, color, x, y, w, h, z, author? }]` — minor field renames),
  so existing pinboard SPA can stay close.
- `pin.color = null` displays white. Existing palette dropdown may send
  `"white"` for the white swatch; the verb stores it as `null`.
- Board observations: `pinboard_entered`, `pinboard_left`,
  `pinboard_viewport`, `pin_added`, `pin_removed`, `pin_moved`,
  `pin_resized`, and `note_added`. The umbrella `pinboard_activity` is still
  emitted for room-level summaries. Pin color/text changes arrive through
  `pin_recolored` and the note catalog's `note_edited`.
- Movement-hook board observations (`pinboard_entered`, `pinboard_left`,
  `pin_added`, `pin_removed`) carry `source: board` so clients subscribed to the
  board receive entry, exit, pin-add, and pin-removal events even when the actor
  or note is moving to a different destination room.
- Kanban frontend should not consume `layout`. It consumes `list_columns`
  and renders columns in array order and cards in `cards` order.
- Kanban observations: `kanban_column_added`, `kanban_column_renamed`,
  `kanban_column_deleted`, `kanban_column_moved`, `kanban_card_added`,
  `kanban_card_removed`, `kanban_card_moved`, `kanban_card_reordered`,
  plus `pin_recolored` / note edit observations inherited from
  `$pin` / `$note`. Wire shapes are normative in the *Observation shapes*
  section above.

## What's not in

- **Encryption** on pins. Comes with `$encrypted_note < $note` later.
- **`@notedit pin`** — needs the editor-rooms work.
- **Voting pins, ephemeral pins, timestamped pins** — these become trivial
  `$pin` subclasses once people want them. None are in v0.2.
- **Kanban swimlanes, WIP limits, assignees, due dates, task semantics.**
  Those either belong to later `$pin` subclasses or to `tasks`; first-cut
  kanban is only ordered columns over shared `$pin` notes.

## Open questions

- Multi-line pin text. v0.1's single-line model becomes a list-of-strings
  via `$note.text`. Frontend needs to render multi-line.
- Should `move_pin` and `resize_pin` require board-presence (actor location in the board)?
  v0.1 didn't. Probably fine.
- Auto-recycle on `:eject` instead of moving to actor inventory? The
  ejecting actor may not want a stranger's pin in their inventory.
  Possibly: eject moves to a "trash" container per-board with a TTL.
- The two-event sequence on `add_card` / `post_card` (`kanban_card_added`
  to default column, then `kanban_card_moved` to the chosen column) keeps
  `enterfunc` self-contained but means UIs see a card "appear" in column 0
  for a frame before it relocates. Acceptable today; if it becomes
  visually janky, switch to a per-call hint mechanism so `enterfunc` can
  read the target column directly. Frontend can also coalesce events
  within one applied frame.
