# Text format: `.format`

Text-bearing classes (`$note`, `$pin`, `$task`, and any subclass that
ships a textual payload) follow a uniform convention for declaring
how their text should be rendered.

## The property

```
.format    "plain" | "markdown"
```

Defined on the class that introduces text content. Default is
`"plain"` when unset (an empty/missing `.format` is treated as plain
text). Markdown content uses CommonMark.

This is normative behavior; the spec is
[`../../spec/semantics/text-format.md`](../../spec/semantics/text-format.md).

## Why it's a separate property

Two reasons.

First, **store the source verbatim**. The substrate doesn't parse
markdown; it stores whatever string the writer set. Renderers parse
on the way out. A note doesn't lose its `*emphasis*` to substrate
processing.

Second, **renderers can choose to ignore it**. A chat client that
doesn't render markdown shows the raw text. A rich client renders.
Both produce a sensible result.

## Title and preview extraction

Markdown text gets two render-time helpers from the convention:

- **Title** — the first H1 heading (`# Title`). If there's no H1,
  fall back to the first non-blank line.
- **Preview** — the first paragraph.

Plain text:

- **Title** — the first non-blank line.
- **Preview** — the first chunk of lines, line-wrapped, up to a
  reasonable preview length.

The chat catalog's `inventory` listing, the pinboard's pin labels,
the task registry's task summaries — all use these to produce concise
displays without truncating arbitrary characters.

## How clients decide

A client rendering a `$note`-derived object reads `.format`:

- `"markdown"` → render with a markdown parser. Show headings, lists,
  emphasis, links.
- `"plain"` (or unset) → render as preformatted text. Don't try to
  parse anything.

If you're building a renderer, fail closed: when in doubt, treat it
as plain. A markdown-rendered plain-text payload is a worse failure
mode than a plain-rendered markdown payload.

## How writers should choose

If your text has structure — headings, lists, links — set `.format`
to `"markdown"` and write CommonMark.

If your text is one paragraph or a few lines of free prose, leave
`.format` unset (or set it to `"plain"`). Markdown buys you nothing
when there's no structure to render.

If your text is a fragment that doesn't make sense rendered (a JSON
blob, a URL, a search query), leave it `"plain"`.

## The three-slot rule on `$note` and descendants

A `$note` separates three independent text fields:

| Field | Used for | Format-aware? |
|---|---|---|
| `name` | Listing label (inventory, room contents). Short. | No — always plain. |
| `description` | What `look at` shows. Cosmetic flavor. | No — always plain. |
| `text` | The body. The thing `read` shows. | Yes — `.format` applies. |

Don't conflate. A long `description` makes inventory unreadable; a
short `text` defeats the point. The `.format` property only governs
`text`.

`$pin` (in pinboard), `$task` (in tasks), and any other
text-bearing subclass follows the same rule: a separate name, a
short cosmetic description, a `.format`-aware body.

## Limits and validation

The substrate doesn't validate that markdown content is well-formed
CommonMark. It also doesn't validate that plain text has no
markdown-looking characters. The format declaration is a hint to
renderers; the substrate's job is just to store the bytes.

If your application needs guarantees ("this note must parse as valid
markdown"), enforce them in the verb that writes the text, before
calling `set_property_value`.
