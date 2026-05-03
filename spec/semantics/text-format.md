---
date: 2026-05-03
status: draft
---

# Text format

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**.

How text-bearing objects declare and consume content-format conventions for
rendering. Defines the `.format` property vocabulary, unset/default
semantics, derived view extraction (title, preview), and the substrate's
deliberate ignorance of any specific markup language.

---

## TF1. Motivation

Several object classes carry text payloads that clients render to users:

- `$note.text` — list of strings, body content of a portable note ([catalogs/note](../../catalogs/note/DESIGN.md)).
- `$generic_help_db` topic values — strings, lists of strings, or directive lists ([catalogs/help](../../catalogs/help/DESIGN.md)).
- Future text-bearing classes (`$mailbox` messages, `$forum_post`, `$wiki_page`, etc.).

Until this contract existed, runtime and renderers tacitly assumed text was
plain — clients rendered verbatim, truncated at fixed widths, and offered no
formatting affordance. That's fine for one-line sticky notes; it stops
working when anyone wants a heading, a numbered list, or a link.

The minimum useful change: let a text-bearing object opt into a richer
content format, declared as a property the renderer reads. The substrate
stays format-ignorant; clients carry the rendering weight.

---

## TF2. The `.format` property

A text-bearing class **may** define a `.format` property whose value is a
string from a small open vocabulary. The substrate-recognised values:

| Value | Meaning |
|---|---|
| `"plain"` | Render literally; whitespace preserved; no markup interpretation. |
| `"markdown"` | CommonMark-flavoured markdown source. Renderer parses for headings, lists, links, code, emphasis, etc. The specific dialect (CommonMark / GFM / a renderer-private superset) is renderer policy. |

Reserved for future use: `"html"`, `"asciidoc"`, `"org"`, `"rst"`. Catalog
publishers SHOULD NOT introduce private values without documenting them;
clients that don't recognise a format MUST fall back to `"plain"` (render
literally) rather than fail.

**Unset semantics.** A text-bearing object whose `.format` property is
missing, `null`, or absent from the class definition is rendered as
`"plain"`. This preserves backward compatibility with every existing
instance and class definition that predates this convention. Importantly,
the *class default* and the *unset interpretation* are different things:

- A class MAY default `.format` to `"markdown"` in its property definition;
  newly-created instances inherit that default.
- An object whose `.format` property does not exist at all (or whose value
  is `null`) is treated as `"plain"` by every renderer regardless of class.

`$note` defaults `.format` to `"markdown"` in its catalog definition —
new notes are rich-text by default. Older `$note` instances created
before the property existed see no class default and therefore render as
`"plain"`. Clients SHOULD NOT auto-upgrade legacy text by guessing format.

---

## TF3. Substrate stays format-ignorant

Three corollaries:

- The runtime stores the source as-is. `$note.text` remains `list<str>`,
  character-for-character what the author entered. No normalisation,
  no rendering, no AST.
- `:text()` returns the source. Callers that want rendered output
  use a separate verb (none today; if needed, a future
  `$content_renderer` feature object — see TF8).
- Cross-host serialisation is unchanged. `.format` is just another
  property; it serialises as a string per [values.md §V2](values.md#v2-canonical-json-encoding).

Server-side rendering is a deferred capability (TF8). Until it lands,
every client renders independently. Clients that disagree on flavour
(CommonMark vs. GFM table extensions) will render the same source
slightly differently — accepted as the cost of staying out of the
substrate.

---

## TF4. Title and preview extraction

Many surfaces (kanban card titles, pin previews, room listings, mailbox
sender/subject) want a short form of a note's content. The substrate
provides no separate title property; clients derive title and preview
from `(:text(), .format)`:

| Format | Title rule | Preview rule |
|---|---|---|
| `"plain"` | First non-blank line of `:text()`. | Concatenate `:text()` lines with spaces; truncate to renderer's width budget. |
| `"markdown"` | First H1 line (`# heading`) if present; else first non-blank line of source with markup stripped. | First paragraph (up to first blank line) rendered to plain string, truncated. |

These are **renderer conventions**, not part of the wire contract. A
class MAY override by defining its own `:title()` and `:preview()` verbs
that compute what it wants. Pinboard pins, kanban cards, and help
topics SHOULD use the conventions above unless the class has a
domain-specific reason to differ.

Why no separate `.title` property: a class with both `.title` and `.text`
splits the source of truth. When the user edits the body and changes the
H1, the title must either re-derive (auto-sync; foot-gun on user-typed
titles) or stay stale (manual sync; annoying). Title-as-derived-view
keeps a single source.

---

## TF5. Editing affordances

How a client lets a user mutate `.text` is presentation policy, not
substrate. Two patterns are established:

- **Edit-in-place.** Small text input overlaid on the rendered preview.
  Appropriate for `format: "plain"` content where source and rendered
  form match closely.
- **Modal editor.** Full-screen or popup editor with split source /
  preview. Required for `format: "markdown"` (and any future rich
  format) where source and rendered form differ enough that in-place
  editing produces visual confusion.

Catalogs MAY ship verbs that drive editing flows (`:edit_in_room`,
etc.) but the substrate has no opinion. The
[`editor-rooms.md`](../authoring/editor-rooms.md) mechanism is a
candidate substrate for collaborative multi-actor editing once that
demand exists; v1 clients implement modals locally.

---

## TF6. Frontmatter

YAML / TOML frontmatter (`---\nkey: value\n---`) at the start of a
markdown document is a **content** convention in v1, not parsed
metadata. Renderers MAY hide or pretty-print the fence; the substrate
stores it as part of `.text`. Lifting specific fields (title, tags,
due dates) into derived properties is deferred (TF8) until a
downstream catalog has a clear use; committing now to a frontmatter
contract risks shipping the wrong shape.

---

## TF7. Search and indexing

Plain-text search over `:text()` matches source-with-markup. For
markdown notes this means `**important**` matches differently from
`important`. Acceptable in v1; mitigations if it becomes friction:

- Lazy-rendering at query time and matching the rendered text.
- A cached `.plain_index` derived property maintained at write time.
- A `:rendered_text()` verb that returns markup-stripped content for
  index consumers.

None are in v1; substrate-level search facilities (help DB matching,
future full-text) operate on raw source.

---

## TF8. Deferred

- **Server-side rendering.** A `$content_renderer` feature object that
  returns a normalised AST or HTML. Useful for consistent presentation
  across clients, PDF export, and search indexing. Out of v1.
- **Frontmatter as object metadata.** Lifting `title`, `tags`, `due`
  fields from a YAML preamble into woo properties on the note. Useful
  but waits for a concrete consumer.
- **Format negotiation.** A client declaring "I only render plain"
  and the runtime auto-converting markdown to a plain-text view is
  not in v1. Today's policy: client renders or falls back to plain.
- **Editor rooms for notes.** A `$note_editor` parallel to
  `$verb_editor` ([prog catalog](../../catalogs/prog/DESIGN.md)) for
  collaborative editing. Out of v1; SPA modals suffice.
- **Per-actor format preference.** An actor preference like "I want
  every note rendered as plain regardless of `.format`" is a client
  setting in v1, not a substrate property.

---

## TF9. Conformance

A runtime conforms to this section if:

1. `.format` on text-bearing objects is treated as an opaque property
   — no parsing, no normalisation, no rendering at the substrate
   layer.
2. Missing or null `.format` is interpreted as `"plain"` by any code
   that branches on format.
3. `:text()` returns the raw source as authored.

Renderers (clients) conform if:

1. They recognise at least `"plain"` and `"markdown"`.
2. Unrecognised format values are rendered as `"plain"` (TF2).
3. Title and preview extraction follow TF4 unless the class overrides
   via `:title()` / `:preview()` verbs.

---

## TF10. Where this applies

| Class | `.format` default | Notes |
|---|---|---|
| `$note` | `"markdown"` (catalog default) | Pinboard pins, kanban cards, future note subclasses inherit. |
| `$generic_help_db` topic values | n/a (per-topic value) | Topic values are strings or lists of strings; no per-topic format property today. New topics SHOULD be authored as markdown by convention; renderers SHOULD render help content as markdown by default once renderers support it. Property-level format may be added later if topics gain richer storage shape. |
| `$pin` | inherits from `$note` | No override — `$pin` adds `.color`, not a format change. |
| Future: `$forum_post`, `$wiki_page`, `$mailbox` | `"markdown"` recommended | Rich-text-first authoring is the default expectation for new text-bearing classes. |

A class that ships a `.format` property MUST document its default in
its DESIGN doc and follow the unset-means-plain rule for migration
safety.
