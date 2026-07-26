# Help Demo

The help catalog provides LambdaMOO-shaped in-world help without adding a web UI. Help is ordinary object behavior: player `:help` searches a list of help databases, and each database resolves and renders topics through verbs.

## Classes

| Class | Parent | Description |
|---|---|---|
| `$generic_help_db` | `$thing` | Generic help database. Stores topic values, resolves exact and abbreviated topic names, renders compact output, records misses. |

### `$generic_help_db` API

`$generic_help_db` stores a `topics` map and a bounded `missed_topics` list. Its public verbs are:

- `:find_topics(topic?)` returns exact or abbreviated topic matches.
- `:get_topic(topic?, remaining_dbs?)` returns rendered help output.
- `:dump_topic(topic)` returns the raw stored topic value.
- `:record_miss(topic)` records missing lookup terms for later documentation work.

The seeded `$help` instance is the global baseline database. Catalogs can add additional database objects and register them by appending to `$system.help_dbs`; objects and spaces can also expose contextual databases through their inherited `.help` property.

The first-light database verbs are native-backed. Their DSL source bodies are intentionally explicit `/* native */` stubs so verb inspection does not present an incomplete shadow implementation as the behavior that actually runs. The native path is the authority for topic matching, directive expansion, and miss recording until the DSL has the remaining help primitives.

## Topic Values

Plain strings and lists of strings render directly. Directive lists reserve their first element:

- `["*index*", title]` renders the database topic index.
- `["*pass*", topic]` asks the next database in the search path.
- `["*forward*", topic]` redirects within the current database.
- `["*objectdoc*", obj]` renders `obj:look_self()`.
- `["*verbdoc*", obj, verb]` renders source-level verb documentation when the reader can read that verb source; otherwise it reports that the source is not readable.

`*subst*` and maintainer tooling are deferred.

## Seeded topics and the MCP surface

Several baseline topics (`self` with its `suit`/`me` aliases, `tools`, `focus`,
`wait`, `building`) describe the tool surface an MCP agent actually sees. They
are the only in-band orientation an agent gets, so an inaccuracy here is
misinformation delivered directly into an agent's decision loop, not a
cosmetic docs bug. Two constraints follow:

- **Never name a tool that does not exist.** v0.1.1 told agents to call
  `woo_focus`, `woo_unfocus`, and `focus_list`, none of which are on the
  surface, and named `wait` rather than `woo_wait`.

  A tool exists only if its verb is **bytecode-backed and `tool_exposed`**.
  Both halves matter and each has already caused a wrong topic: every `$actor`
  native (`focus`, `unfocus`, `focus_list`, `wait`) carries
  `tool_exposed: true` yet is never published, because `mcpObjectToolDrafts`
  advertises only `verb_bytecode` cells; and `$programmer:trace` is ordinary
  woocode but `tool_exposed: false`, so it is equally unreachable.

  Coverage matches the two shapes a claim can take.
  `tests/worker/net-mcp-agent-surface.test.ts` checks both `woo_*` tokens and
  `<you>__verb` claims against the live `tools/list` names; the
  "help topics only name prog-catalog verbs that are tool-exposed" case in
  `tests/catalogs.test.ts` catches verbs named in prose. A topic may name an
  absent tool only to deny it exists, in a sentence containing
  "There is no ..." — that phrasing is what the scanner uses to tell a denial
  from a claim, so keep denials in one such sentence.
- **Editing the manifest is not enough for deployed worlds.** Seed-hook
  properties are *initial* values; `reconcileSeedObject` never overwrites an
  existing own property. A topic-text change therefore needs a boot migration
  (`2026-07-25-help-mcp-topics` in `src/core/local-catalogs.ts`) to reach
  already-installed worlds. That migration replaces a topic only when its
  stored value still matches the shipped default byte-for-byte, so an
  operator's edits survive.

## Search Path

The player verb searches:

1. The actor and local parent chain.
2. The actor's current space and local parent chain.
3. The global database list in `$system.help_dbs`.

Invalid or unreadable `.help` values are ignored. Exact matches win; leading `@` is ignored; dashes and underscores compare equivalently; prefix abbreviations are accepted when unambiguous.
