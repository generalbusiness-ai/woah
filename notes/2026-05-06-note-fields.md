# `$note` fields — title, description, body

## The bug

Dispensed horoscope notes render their full content in inventory listings
because the `$note:title()` heuristic computes `name + ": " + first_line`
and the dispenser puts the entire horoscope into a single-line `text`.
When `name` is the default and `text` is one long string, the inventory
title is the whole horoscope.

```
> i
You are carrying:
  Horoscope: Capricorn Today is a good day for retrying network requests
  with exponential backoff. Tomorrow brings opportunities to refactor...
```

The `:look_self` path is fine — it returns `lines: <count>`, not the body.
But the title heuristic is the visible failure, and it's the same
mechanism every `$note` subclass inherits.

## Current shape

From [`catalogs/note/manifest.json`](../catalogs/note/manifest.json):

```
$note < $portable
  properties:
    text:    list<str>     # one entry per line
    writers: list<obj>
  verbs:
    :title()       → name + ": " + text[1] if any, else name
    :look()        → :look_self
    :look_self()   → { id, title, description, lines, location }
    :text()        → returns the line list (perm-gated)
    :read()        → :text() + emits note_read observation
    :set_text(lines), :write(line), :erase(), :delete(line)
    :is_readable_by, :is_writable_by
```

The shape is "lines of text," with title derived heuristically and
description inherited from `$thing`. There is no separate title field
and no markdown awareness.

`$dispensed_note < $note` adds `produced_by`, `produced_at`. Its
`:deliver` path on `$dispenser_block` does:

```
note.text = [body]            # whole horoscope body becomes text[1]
moveto(note, requester)
```

— and the title heuristic does the rest of the damage.

## How LambdaMOO handled this

LambdaCore separated three slots, each with its own verb:

| Slot | Field | When it's shown |
|---|---|---|
| **name / aliases** | `name`, `aliases` | inventory line; "you see X here"; verb-targeting |
| **description** | `description` | `look at note` — cosmetic |
| **content** | `text` (on `$note`) | `read note` — the payload |

```
> i
You are carrying:
  a folded slip of paper.

> look at slip
A folded slip of paper, slightly damp.
There is something written on it.

> read slip
"Capricorn: Today is a good day for ..."
```

Three explicit slots, three verb paths, no overlap. LambdaMOO did *not*
use a "first-line-is-title" heuristic — every slot was set explicitly.
That discipline is what kept verbs working cleanly across the thousands
of objects in a typical core.

## Three options for woo

### A. Single `text`, derive title from first line/heading (today's design)

`text` is a list of lines; `:title()` returns `name + ": " + text[1]`.

**Pros:** minimal model, markdown-friendly if `text[1]` happens to be
`# Title`.
**Cons:** fragile — any setter that drops a long body into a single
`text` line produces an unreadable inventory title; programmatic
construction has to remember to put a heading; description slot is
unused; verbs that want to render the body separately have nothing to
work with.

This is the option that is currently shipping, and it is the option
that produced the horoscope bug.

### B. Two explicit fields: `name` + `body`

Add `body: str` (or `body: list<str>`) as the content; require `name`
to be set explicitly; drop the title heuristic.

**Pros:** explicit; matches Notion/JIRA/GitHub-issue ergonomics; no
heuristic to misfire; markdown-natural for `body`.
**Cons:** drops the cosmetic `description` slot that LambdaMOO had;
`look at note` and inventory both fall through to `name`. For
productivity-shaped objects (tasks, dispensed notes) that's fine; for
MUD-shaped ones it's a regression.

### C. Three fields: `name` + `description` + `body` (LambdaMOO triad)

Full LambdaMOO discipline.

**Pros:** clean slot per verb; cosmetic flavour available.
**Cons:** description is often redundant in productivity contexts;
one more thing to set on every note.

### D. Two fields with description auto-default (recommended)

`name` (inherited identity slot) + `body: str` (markdown). Description
falls back to a generic auto-formula on `$note`, but is overridable per
instance for MUD-style flavour.

```
$note properties:
  body: str              # markdown content
  writers: list<obj>

$note verbs:
  :title()        → self.name                # NO heuristic; just the name
  :description()  → self.description if set
                     else "a {self:kind_label}: '{self.name}'"
  :look_self()    → { id, name, description, body_length, location }
  :read()         → self.body
  :set_body(str)  → write the body
```

**Pros:** explicit at the productive minimum; cosmetic slot still
available when wanted; UIs and `look at` always have something sensible
to show; no heuristic on body.
**Cons:** the auto-description formula has to be chosen — but a
one-liner like `"a {kind} note: '{name}'"` covers 95%, and overriding
is a normal `:set_description` call.

## Recommendation: D

Concretely:

- Replace `text: list<str>` with `body: str` (plain string, markdown by
  convention). The `list<str>` shape was a LambdaMOO-era convenience
  for line-oriented editing; markdown handles structure better and
  doesn't force a list representation on every consumer.
- Drop the `name + ": " + first_line` heuristic in `:title()`. Title is
  just `self.name`. Period. Inventory rendering uses `name`. Always.
- Default `:description()` returns an auto-formula referencing the
  object's kind label and name. Subclasses or instances can set
  `description` explicitly for cosmetic flavour.
- `:read()` returns `body`. UIs render markdown. Text-mode transports
  may eventually grow a `:render_text(profile)` for ANSI-formatted
  output; for v1 the raw markdown is fine.
- Replace line-editing verbs (`:write`, `:erase`, `:delete`,
  `:set_text`) with `:set_body(str)` and `:append_body(str)`. Editing
  individual lines was a LambdaMOO ergonomic for terminal-edit
  workflows; in the SPA the editor handles markdown directly. If a
  text-mode line-editor is needed later it can be a wrapping verb.

### What `name` is for, precisely

`name` is the **listing token**: short, unambiguous in context. For
horoscope notes it's `"Horoscope reading"` or `"Horoscope: Capricorn"`.
For tasks it's the task title — `"auth retry races"`. For pinboard
notes it's whatever the author types in the title field.

`name` is **never** derived from body content. The producer sets it
at creation. The author sets it at edit time. The substrate never
guesses.

### What `description` is for

The `look at note` rendering. Defaults to something like
`"a Horoscope Note: 'Horoscope: Capricorn'"` — explicit about the
class, repeats the name. Authors can override for flavour
(`"a small folded slip of paper, slightly damp"` for MUD-style notes).

For productivity objects nobody overrides it; the default is enough.
For MUD-style objects the override gives back full LambdaMOO
ergonomics.

### What `body` is for

The actual content. Markdown by convention. Multiple paragraphs,
headings, lists, links. Read via `:read`; rendered by the UI;
unmolested by the title path.

## Migration shape

This is a `$note` schema change, which per the
[migration table](../AGENTS.md#migrations) means:

1. **Catalog version migration** for the `note` catalog: bump to
   `v0.2.0`, ship `migration-v0.1-to-v0.2.json` next to `manifest.json`.
   The migration:
   - adds `body: str` defaulting to `""`
   - copies existing `text: list<str>` into `body` joined with newlines
   - removes `text` after copy
   - is idempotent (rerun copies an empty text into the existing body
     only if body is empty)
2. **Downstream catalog updates** (must be a coordinated bump or each
   downstream catalog migrates independently as it consumes v0.2):
   - `$dispenser_block:deliver` sets `note.name` (from a producer-supplied
     label) and `note.body = body`. Drop the `note.text = [body]` line.
   - `$horoscope_block` supplies the name (`"Horoscope: " + sign` or just
     `"Horoscope reading"`).
   - Any other note producer in any catalog — same change: set name,
     set body.
3. **Bootstrap local-boot migration** if `$note` is delivered in the
   bootstrap seed — record the migration tag in
   `$system.applied_migrations` so reboots don't redo the work.
4. **Tests** in `tests/catalogs.test.ts` for the v0.1→v0.2 migration:
   - existing `text: ["a", "b"]` becomes `body: "a\nb"`
   - empty `text: []` becomes `body: ""`
   - rerun is no-op if `body` already set
5. The migration must be **test-run on a local SQLite woo** before
   merge per AGENTS.md.

## Implications elsewhere

- **`$task < $note`** (the task-obligation model) gains the same shape
  for free: `name` is the task title, `body` is the markdown
  description. Cards in the kanban use `name`; the detail panel renders
  `body`. No "first line is title" mistake.
- **`$dispensed_note`** producers (currently horoscope) become
  responsible for setting `name`. The block class is the natural place:
  `$dispenser_block:deliver` accepts a `name` argument, or derives it
  from `:default_note_name(order, body)` which the subclass overrides.
- **Pinboard / kanban / taskspace UIs** that today read `text` switch
  to reading `body`; line-count display becomes character-count or
  paragraph-count, or just goes away.
- **Help / documentation notes** in any catalog: same migration, same
  shape. No more "title is the first line of help."

## A clean rule

> A `$note` has a name, an optional cosmetic description, and a markdown
> body. The name is what you call it; the description is what it looks
> like; the body is what it says. Inventory uses name; `look` uses
> description; `read` uses body. Never confuse them.

Producers set name and body. Authors edit name and body. The substrate
never guesses any of them from the others.

## Open questions

- **`body: str` vs `body: list<str>`.** A single string is simplest and
  markdown-natural. A list-of-paragraphs is friendlier for incremental
  append. Default to `str`; revisit if append patterns get awkward.
- **Where does the producer-supplied name live in `:deliver`?** Either a
  required arg on `:deliver(order_id, name, body)` or a method
  `:default_note_name(...)` that the dispenser subclass overrides.
  Either works; arg is more explicit.
- **Auto-description formula.** Worth a small registry of templates by
  class label, or hand-roll per-class? Hand-roll is fine until there
  are five+ note subclasses.
- **Existing line-editor workflows.** Are any text-mode users today
  using `:write`/`:delete` on notes? If so, keep them as facade verbs
  that translate to body-string manipulations. If not, drop them.
