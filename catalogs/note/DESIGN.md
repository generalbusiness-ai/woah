# Note Demo

Generic notes — portable text-bearing things, modeled after LambdaMOO's
`$note` (#9). The shape is three explicit slots: identity, cosmetic
description, and a markdown text. Subclasses add behaviour (pinboard
pins, dispensed notes, tasks, voting notes, decision logs).

## Classes

| Class | Parent | Description |
|---|---|---|
| `$note` | `$portable` | Movable text artifact. `.text` is markdown; `.name` is the listing slot; `.description` is the cosmetic look-at slot. Writability gated by owner, the writers list, or wizard. |

## Goal

A first-class movable artifact with editable markdown content. Notes can
be created, read, edited, picked up, dropped, posted onto bulletin
boards, taken off again, and recycled — all using ordinary
`moveto`/`take`/`drop` infrastructure. The note keeps its identity
across moves; references, observations, and editor handoff all work
without copy.

## Class

```
$note < $portable < $thing < $root
  .name         str (inherited from $root)   — listing identity (set by author/producer)
  .description  str (inherited from $root)   — cosmetic look-at flavour (optional)
  .text         str   perms ""                — markdown content; private (verb-only)
  .writers      list<obj>   perms "r"         — additional writers besides .owner
```

`.text` is `perms ""` deliberately. Direct property reads are denied;
the public API is the `:text()` verb, which gates via
`:is_readable_by`. This keeps the property model open for
`$encrypted_note < $note` and similar privacy-respecting subclasses
without changing callers — they already go through the verb.

Properties inherited from `$portable`:
- `.portable = true` — eligible for `:take`/`:drop` between rooms and
  inventories without changing host placement.

## The three-slot rule

> A `$note` has a name, an optional cosmetic description, and a markdown
> text. The name is what you call it; the description is what it looks
> like; the text is what it says. Inventory uses name; `look` uses
> description; `read` uses text. Never confuse them.

- **`name`** is the **listing token**: short, unambiguous in context.
  Producer sets it at creation; author sets it at edit time. Substrate
  never guesses it from text content.
- **`description`** is the **`look at note` rendering**. Defaults to
  empty (so `look at note` falls through to whatever the inheriting
  surface chooses); authors can override for flavour
  (`"a small folded slip of paper, slightly damp"`).
- **`text`** is the **payload**. Markdown by convention. Multiple
  paragraphs, headings, lists, links. Read via `:read`; rendered by the
  UI; unmolested by the title path.

## Verbs

| Verb | Purpose |
| --- | --- |
| `text` | Permission-checking getter for `.text`. Public API for non-wizard callers. |
| `read` / `r@ead` | Call `:text()`, emit a `note_read` observation, return the text. |
| `set_text(str)` | Replace text. Enforces a 65536-char cap. Permission: `:is_writable_by(actor)`. |
| `write(line)` / `w@rite` | LambdaMOO-style append-line. Inserts a newline before the line if the text is non-empty. Enforces the same 65536-char cap as `:set_text`. Permission: `:is_writable_by(actor)`. |
| `erase` / `er@ase` | LambdaMOO-style clear. Sets the text to `""`. Permission: `:is_writable_by(actor)`. |
| `add_writer(who)` / `rm_writer(who)` | Manage `.writers`. Owner or wizard only. |
| `is_readable_by(actor)` | Default `true`. Override in subclasses to restrict. |
| `is_writable_by(actor)` | Owner, members of `.writers`, or wizard. |
| `look` / `look_self` | Inherited from `$root` for `look`; `:look_self` returns `{id, title, description, text_length, location}`. The text body is *not* in the look surface — it's read-via-:read. |
| `title` | Inherited from `$root`; returns `this.name`. No heuristic. |

## Bounding the body

`.text` is capped at 65536 characters. Both `:set_text` and `:write` raise
`E_INVARG` if the resulting text would exceed the cap. This is the
single point of bound enforcement; downstream renderers and the room
command matcher rely on it (e.g., `:look_self` returns `text_length`
without truncation, the matcher splits `text` per line for noun-phrase
matching). The cap is large enough for human-authored notes and small
LLM outputs; truly long content belongs in a different artifact class
that streams or paginates.

## What is intentionally absent

- **Encryption** (`:encrypt`/`:decrypt`). LambdaCore has it; we'll add when
  there's a use case. `text: perms ""` plus an `:is_readable_by`
  override is enough for `$encrypted_note < $note` whenever it lands.
- **`mailme` / `@mailme`**. Requires `$mail_recipient`; deferred.
- **`:delete(line)`**. Line numbers stop making sense when the body is
  a single string. Use `:set_text` to replace, or `:write`/`:erase` for
  append/clear.

## Design notes

### Why three slots, not one

LambdaMOO's `$note` had `name + description + text` and three verb
paths (`look at`, `read`, plus `name`-based inventory listing). Each
slot has one job. Pre-v0.2 woo combined them with a "title is
name + ': ' + first line of text" heuristic, which produced unreadable
inventory titles whenever a text was a long single string (the
horoscope/dispensed-note bug). The fix is to restore the discipline:
three slots, three verb paths, no overlap.

### Why `text: str` and not `list<str>`

Single string is simplest and markdown-natural. List-of-paragraphs is
friendlier for incremental append but forces every consumer to handle a
list shape. `:write(line)` covers the LambdaMOO append-line case while
keeping the storage a single string.

### Why `< $portable`

Every note is a movable thing. `take note from board`, `drop note in
room`, `put note in chest`, `post note on board` all work uniformly.
`$portable` already encodes the cross-host-safe-move semantics.

### Why `is_readable_by`/`is_writable_by` are verbs, not properties

Verbs let subclasses override based on context (encryption key matching
on `$encrypted_note`, voting-state, time-of-day for `$ephemeral_note`).
A boolean property would force every subclass to maintain a flag.

### Why default-public-read

Most notes in social use are signs, posters, recipes, lists — public.
Subclasses needing privacy (`$encrypted_note`, `$private_note`) override
`:is_readable_by` to gate.

### Why `note_read` and `note_edited` schemas

Per-note observability is the whole point of first-class notes. Boards
that mirror posts to a `$mail_recipient` listen for these and forward.

## Cross-references

- `notes/2026-05-06-note-fields.md` — the design exploration that drove
  the v0.2 reshape (option D: `name` + `description` + `text`).
- `lambdamoo-mail-and-boards.md` — the LambdaMOO inspiration: notes,
  bulletin boards, mail recipients as three distinct surfaces.
- `catalogs/pinboard/DESIGN.md` — first concrete subclass (`$pin < $note`).
- `catalogs/dispenser/DESIGN.md` — `$dispensed_note < $note` and the
  factory contract.
- `catalogs/taskspace/DESIGN.md` — `$task < $note` where text is the
  markdown task description.
