# Help Demo

The help catalog provides LambdaMOO-shaped in-world help without adding a web UI. Help is ordinary object behavior: player `:help` searches a list of help databases, and each database resolves and renders topics through verbs.

## Classes

`$generic_help_db < $thing` stores a `topics` map and a bounded `missed_topics` list. Its public verbs are:

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

## Search Path

The player verb searches:

1. The actor and local parent chain.
2. The actor's current space and local parent chain.
3. The global database list in `$system.help_dbs`.

Invalid or unreadable `.help` values are ignored. Exact matches win; leading `@` is ignored; dashes and underscores compare equivalently; prefix abbreviations are accepted when unambiguous.
