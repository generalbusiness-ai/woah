# Note Demo

Generic notes — portable text-bearing things, modeled after LambdaMOO's
`$note` (#9). The base shape is text plus permissions; subclasses add
behavior (pinboard pins, recipe notes, voting notes, decision logs).

## Classes

| Class | Parent | Description |
|---|---|---|
| `$note` | `$portable` | Movable text artifact. Text is a list of strings, one per line; writability gated by owner, the writers list, or wizard. |

## Goal

A first-class movable artifact with editable text. Notes can be created,
read, edited, picked up, dropped, posted onto bulletin boards, taken off
again, and recycled — all using ordinary `moveto`/`take`/`drop`
infrastructure. The note keeps its identity across moves; references,
observations, and editor handoff all work without copy.

## Class

```
$note < $portable < $thing
  .text     list<str>   perms ""   — one string per line; private (verb-only access)
  .writers  list<obj>   perms "r"  — additional writers besides .owner
```

`.text` is `perms ""` deliberately. Direct property reads are denied;
the public API for full note bodies is the `:text()` verb, which gates via
`:is_readable_by`. Bounded display surfaces use `:text_summary(limit)`.
This keeps the property model open for `$encrypted_note < $note` and
similar privacy-respecting subclasses without changing callers — they use
overridable note verbs rather than reading `.text` directly.

Properties inherited from `$portable`:
- `.portable = true` — eligible for `:take`/`:drop` between rooms and
  inventories without changing host placement.

## Verbs

| Verb | Purpose |
| --- | --- |
| `text` | Permission-checking getter for `.text`. Public API for callers that don't run as wizards. |
| `text_summary(limit)` | Permission-checking bounded display summary. Base implementation returns line count, first-line preview, and truncation flag without expanding unbounded note bodies. Subclasses that transform text for readers should override this alongside `:text()`. |
| `read` / `r@ead` | Call `:text()`, emit a `note_read` observation, return the text. |
| `set_text(lines)` | Replace text. Permission: `:is_writable_by(actor)`. |
| `write(line)` | Append a line. Permission: `:is_writable_by(actor)`. |
| `erase` / `er@ase` | Clear text. Permission: `:is_writable_by(actor)`. |
| `delete(line)` / `del@ete` / `rem@ove` | Remove one 1-based line. Permission: `:is_writable_by(actor)`. |
| `is_readable_by(actor)` | Default `true`. Override in subclasses to restrict. |
| `is_writable_by(actor)` | Owner, members of `.writers`, or wizard. |
| `look` / `look_self` | Standard space/thing look surface. Returns preview title, line count, and current location. |
| `title` | Object name plus a bounded preview of the first readable text line when present, so multiple notes in one room can be distinguished and matched without expanding long note bodies into inventory or room summaries. |

## What is intentionally absent in v0.1

- **Encryption** (`:encrypt`/`:decrypt`). LambdaCore has it; we'll add when
  there's a use case.
- **`mailme` / `@mailme`**. Requires `$mail_recipient`; deferred to a
  future mail catalog.
- **`@notedit`**. Will land as part of `editor-rooms.md` (the `$note_editor`
  is one specialization of `$generic_editor`). The note doesn't need to
  know about editors; the editor knows how to read/write `.text`.

## Design notes

### Why `< $portable`

Every note is a movable thing. We want `take note from board`, `drop note
in room`, `put note in chest`, `post note on board` to all work uniformly.
`$portable` already encodes the cross-host-safe-move semantics. Inheriting
it gives notes those guarantees for free and reuses the existing
`room_take`/`room_drop` natives.

### Why `is_readable_by`/`is_writable_by` are verbs, not properties

Verbs let subclasses override based on context (encryption key matching
on `$encrypted_note`, voting-state on `$voting_pin`, time-of-day for
`$ephemeral_note`). A boolean property would force every subclass to
maintain a flag.

### Why default-public-read

Most notes in social use are signs, posters, recipes, lists — public.
Subclasses needing privacy (`$encrypted_note`, `$private_note`) override
`:is_readable_by` to gate.

### Why `note_read` and `note_edited` schemas

Per-note observability is the whole point of first-class notes. Boards
that mirror posts to a `$mail_recipient` listen for these and forward.

## Cross-references

- `lambdamoo-mail-and-boards.md` — the LambdaMOO inspiration: notes,
  bulletin boards, mail recipients as three distinct surfaces.
- `lambdamoo-editors.md` — the `$note_editor` pattern that v0.2 will use
  for `@notedit`.
- `catalogs/pinboard/DESIGN.md` — first concrete subclass (`$pin < $note`)
  via the pinboard redesign.
