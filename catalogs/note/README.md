---
name: note
version: 2.0.0
spec_version: v1
license: MIT
description: Generic note class — portable text-bearing things, modeled after LambdaMOO's $note (#9). Identity (name), cosmetic flavour (description), markdown content (text). Subclass for richer per-note behavior.
keywords:
  - note
  - text
  - markdown
  - portable
---

# note

Generic note class for woo. Modeled after LambdaCore's `$note` (#9): three
explicit slots, three verb paths, no heuristic that mixes them.

A note is a movable text-bearing thing — like a piece of paper. Pick one
up, drop it, post it on a board, take it off, put it in a chest. Read it,
edit the text, replace the text. The note keeps its identity wherever it
goes.

A note has three explicit slots:

| Slot | Field | What for |
|---|---|---|
| **identity** | `name` (inherited from `$root`) | Inventory listing; verb-targeting; the short label that distinguishes one note from another. |
| **cosmetic** | `description` (inherited from `$root`) | What `look at note` shows. Optional; left empty by default. |
| **content** | `text` (string, markdown by convention, capped at 262144 characters) | What `read note` shows. The payload. |

The substrate never derives one from another. Producers set `name` and
`text` at creation. Authors edit `name` and `text`. The cosmetic
description is set explicitly when wanted, otherwise left empty.

See [DESIGN.md](DESIGN.md) for the app design and behavior contract.

## Class

`$note < $portable < $thing < $root`

Properties: `.text` (string, perms `""`, capped at 262144 characters),
`.writers` (list of additional writer objects beyond the owner).
Identity (`.name`) and cosmetic (`.description`) are inherited from
`$root`.

## Verbs

```
:text                   permission-checking getter for the full text
:text_summary(limit)    bounded display summary {lines, length, preview, truncated}
:read                   show the text and emit a note_read observation
:set_text(str)          replace the entire text (writers only); enforces 262144-char cap
:write(line)            append a line (writers only); inserts a newline if non-empty
:erase                  clear the text (writers only)
:add_writer(who)        add a writer (owner or wizard only)
:rm_writer(who)         remove a writer (owner or wizard only)
:is_readable_by(actor)  default true; override in subclasses to restrict
:is_writable_by(actor)  owner, .writers entries, or wizard
:look / :look_self      standard look surface (title, description, text_length, location)
```

Writer-list changes emit `note_writers_changed` with the current
`writers` list so pinboard/card UIs can update edit controls from
observations.

`:title` is inherited from `$root` and just returns `this.name`. There
is no first-line-is-title heuristic.

`.text` is private (`perms: ""`); always go through `:text()` for full
body reads, or `:text_summary(limit)` for bounded display previews. The
private property keeps `$encrypted_note` and other privacy-respecting
subclasses possible without changing callers — they override the verbs
rather than touching `.text` directly.

## Use it

```moo
let note = create($note, { name: "Tea recipe" });
note:set_text("1. Boil water.\n2. Add tea.");
note:read();
```

LambdaMOO-style line editing also works:

```moo
note:write("3. Drink.");          // appends with a newline
note:erase();                     // clear
```

## Subclassing

The `pinboard` catalog ships `$pin < $note` adding `.color`. The
`dispenser` catalog ships `$dispensed_note < $note` adding back-references
to the producing block. The `taskspace` catalog ships `$task < $note`
where `text` carries the markdown task description. Other natural
subclasses: `$voting_note` (adds vote counts), `$ephemeral_note`
(auto-recycles after a TTL), `$encrypted_note` (overrides
`:is_readable_by` with key check). Each adds verbs/properties; the base
shape stays the same.

## Breaking change from v1.0.0

v1.0.0 (the previous shipped version) joined `.text` into a single string
but kept LambdaMOO's `:title()`, `:delete(line)`, and `:match_names()`
verbs as inline DSL with no size cap. v2.0.0 keeps the same property
shape (`text: str`, `writers: list<obj>`) but tightens the contract:

- `.text` is now capped at **262144 characters** (256 KiB). `:set_text`
  and `:write` raise `E_INVARG` if the resulting body would exceed the
  cap. The cap protects the per-edit log/observation/WS broadcast cost
  from arbitrary growth.
- `:title()` is dropped; the inherited `:title` on `$root` returns
  `this.name` directly. The pre-v1 first-line-is-title heuristic was
  already gone in v1; v2 removes the verb itself.
- `:delete(line)` is dropped; line numbers are not a primary concept on
  a single-string body. Edit by `:set_text` or `:write`/`:erase`.
- `:add_writer(who)` / `:rm_writer(who)` are added; owner/wizard-gated
  ACL management for the existing `.writers` list. They emit
  `note_writers_changed` so UIs can update edit affordances without a
  full rehydration.
- `:look_self` returns `text_length` (character count) instead of
  `lines`; line counts are reachable via `:text_summary`.
- New `note_writers_changed` schema declared.

The catalog migration in `migration-v1-to-v2.json` drops the obsolete
`:title` and `:delete` verb definitions from any installed v1 worlds;
the new shape is otherwise reinstalled by the standard catalog update
path.

### v0.x → v1.0.0 (historical)

v0.x had `text: list<str>` and a `:title()` heuristic that prepended the
first text line onto the name. v1.0.0 joined the list into a single
string and dropped the heuristic. The `migration-v0-to-v1.json`
transform handles existing v0.x worlds.

## Future

- `:encrypt(key)` / `:decrypt(key)` — LambdaCore-style locked notes.
- `:mailme(actor)` — once a `$mail_recipient` catalog exists.
- `:render_text(profile)` — ANSI/text-mode rendering of the markdown body.
