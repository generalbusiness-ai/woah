# Help Demo

The help catalog provides LambdaMOO-shaped in-world help without adding a web UI. Help is ordinary object behavior: player `:help` searches a list of help databases, and each database resolves and renders topics through verbs.

## Classes

| Class | Parent | Description |
|---|---|---|
| `$generic_help_db` | `$thing` | Generic help database. Stores topic values, resolves exact and abbreviated topic names, renders compact output. |

### `$generic_help_db` API

`$generic_help_db` stores a `topics` map. Its public verbs are:

- `:find_topics(topic?)` returns exact or abbreviated topic matches, or every topic name when the query is empty.
- `:get_topic(topic?, remaining_dbs?)` returns rendered help output.
- `:dump_topic(topic)` returns the raw stored topic value.

**A help lookup never writes.** v0.x also carried `:record_miss(topic)` and a
bounded `missed_topics` list, recording unknown topics for later documentation
work. Nothing ever read that list back, and on a Net world the write is refused:
`$help` is installed catalog state, so an ordinary turn writing
`property_cell:$help:missed_topics` is rejected with `E_CATALOG_MUTATION`. That
refusal is a *turn verdict*, decided at commit, so the `try`/`except` around the
`record_miss` dispatch could not catch it — a guest asking for an unknown topic
got an invariant dump instead of an answer. v1.0.0 drops both the verb and the
property (`migration-v0-to-v1.json`) and returns the topic list in the reply
instead, which is what the asker needed anyway.

A miss returns `{ok: false, status: "not_found", topic, topics, lines}`, where
`topics` is the union of every reachable database's topic names and `lines`
renders as `No help available for "x".` followed by `Topics: ...`.

The seeded `$help` instance is the global baseline database. Catalogs can add additional database objects and register them by appending to `$system.help_dbs`; objects and spaces can also expose contextual databases through their inherited `.help` property.

The first-light database verbs are native-backed. Their DSL source bodies are intentionally explicit `/* native */` stubs so verb inspection does not present an incomplete shadow implementation as the behavior that actually runs. The native path is the authority for topic matching and directive expansion until the DSL has the remaining help primitives.

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
- **Editing the manifest is not enough for deployed worlds.** Plain seed
  properties are *initial* values; `reconcileSeedObject` never overwrites an
  existing own property. The topics therefore ship as a `merge_map`
  `set_property` seed hook (spec §CT5.4): the hook's `value` is the current
  wording, and its `supersedes` block declares the v0.1.1 values as
  replaceable. A topic is replaced only while its stored value still matches
  a superseded default byte-for-byte, so an operator's edits survive. The
  same declaration serves every lane, with different vehicles:
  - **Fresh worlds** seed the full map when the hook runs at install.
  - **Aged local/classic worlds** heal on the next cold init: the boot drift
    pass verifies the merge against the stored value, reports the unsatisfied
    hook as `seed_property_drift`, and re-applies (`tests/catalogs.test.ts`,
    including a SQLite round trip).
  - **Aged Net worlds do NOT self-heal** — a Scope DO cold start rehydrates
    durable cells as-is, and deployment never rewrites them. Delivery there is
    the signed operator repair, run once after the deploy that carries the
    new manifest: `npm run repair:net-seed-properties -- <worker>`
    (net-cutover.md §NC5; proven end-to-end by
    `tests/worker/net-help-topics-aged.test.ts`).
  Any future topic-text change inherits this pattern: update the hook's
  `value`, move the previous shipped values into `supersedes`, and run the
  Net repair after deploy.

## Search Path

The player verb searches:

1. The actor and local parent chain.
2. The actor's current space and local parent chain.
3. The global database list in `$system.help_dbs`.

Invalid or unreadable `.help` values are ignored. Exact matches win; leading `@` is ignored; dashes and underscores compare equivalently; prefix abbreviations are accepted when unambiguous.
