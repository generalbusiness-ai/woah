---
name: note
version: 0.1.0
spec_version: v1
license: MIT
description: Generic note class — portable text-bearing things, modeled after LambdaMOO's $note. Subclass for richer per-note behavior.
keywords:
  - note
  - text
  - portable
---

# note

Generic note class for woo.

A note is a movable text-bearing thing — like a piece of paper. Pick one
up, drop it, post it on a board, take it off, put it in a chest. Read it,
write a line, erase it. The note keeps its identity wherever it goes.

See [DESIGN.md](DESIGN.md) for the app design and behavior contract.

## Class

`$note < $portable < $thing`

Properties: `.text` (list of strings), `.writers` (list of additional
writer objects beyond the owner).

## Verbs

```
:text                   permission-checking getter for the text content
:read                   show the text and emit a note_read observation
:set_text(lines)        replace the entire text (writers only)
:write(line)            append one line (writers only)
:delete(line)           remove one line (writers only); alias :remove
:erase                  clear the text (writers only)
:is_readable_by(actor)  default true; override in subclasses to restrict
:is_writable_by(actor)  owner, .writers entries, or wizard
:look / :look_self      standard look surface (preview title, line count, location)
:title                  name plus first readable text line when present
```

`.text` is private (`perms: ""`); always go through `:text()` from
non-wizard callers. This keeps `$encrypted_note` and other
privacy-respecting subclasses possible without changing callers.

## Use it

```
@create $note named "Recipe"
write "1. Boil water." on Recipe
write "2. Add tea." on Recipe
read Recipe
```

Or in code:

```moo
let note = create($note);
note:set_text(["1. Boil water.", "2. Add tea."]);
note:read();
```

## Subclassing

The `pinboard` catalog ships `$pin < $note` adding `.color`. Other natural
subclasses: `$voting_note` (adds vote counts and `:vote(actor, choice)`),
`$ephemeral_note` (auto-recycles after a TTL), `$timestamped_note`
(auto-prepends a date on each `:write`), `$encrypted_note` (overrides
`:is_readable_by` with key check). Each adds verbs/properties; the base
shape stays the same.

## Future

- `:encrypt(key)` / `:decrypt(key)` — LambdaCore-style locked notes.
- `:mailme(actor)` — once a `$mail_recipient` catalog exists.
- `@notedit <note>` — when the editor-rooms work lands.
