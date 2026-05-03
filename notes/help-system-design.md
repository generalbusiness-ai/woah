# Help System Design Sketch

This note sketches the first in-world help system. It intentionally follows the
LambdaMOO help model unless woo has a concrete reason to diverge. See
`notes/lambdamoo-help-system.md` for the reference behavior.

## Goals

- `help`, `?`, `info`, `information`, and `@help` work as ordinary in-world
  player commands.
- Help is discoverable from the actor's class chain and current space, not from
  hardcoded application names.
- Catalogs can contribute help by installing help DB objects, registering global
  DBs through `$system.help_dbs`, and attaching contextual DBs through `.help`
  properties.
- No web UI is required. Results are returned to the caller and emitted as
  directed observations for chat/MCP clients.

## Model

A help database is any object implementing:

- `:find_topics(topic?)` -> matching topic names, or all visible topics when
  no topic is provided.
- `:get_topic(topic, remaining_dbs?)` -> list of output lines, or `1` if the DB
  already emitted output itself.
- `:dump_topic(topic)` -> raw topic text for maintainers and editor tooling.

The standard `$generic_help_db` stores static topics in a `topics` map whose
keys are topic names and whose values are strings or lists of strings. The map
shape is deliberate for v1: source can enumerate it cheaply with `keys()` and
catalog manifests can install/update it as one coherent content value. It also
supports small directive values:

- `["*index*", title]`
- `["*pass*", topic, ...rest]`
- `["*forward*", topic, ...rest]`
- `["*objectdoc*", obj]`
- `["*verbdoc*", obj, verb]`

Defer LambdaMOO's `*subst*` expression-evaluation directive. It is useful, but
not essential for first light and adds unnecessary authority surface.

## Search Path

The help command builds an ordered DB list from:

1. the actor object;
2. each parent in the actor class chain through `$player`;
3. the actor's current space, if any;
4. each parent in that space's class chain through `$space` / `$room`;
5. the global DB list in `$system.help_dbs`.

Each object may define `.help` as one help DB object or a list of help DB
objects. Invalid or unreadable entries are ignored.

This gives local help naturally:

- `$builder.help = $builder_help`
- `$programmer.help = $programmer_help`
- `$room.help = $room_help`
- `the_pinboard.help = the_pinboard_help`

## Matching

Topic lookup should be forgiving, matching LambdaMOO's user-facing behavior:

- exact matches win;
- optional leading `@` may be added or omitted;
- dash and underscore are equivalent;
- prefix abbreviations are accepted;
- ambiguous abbreviations return a sorted list of candidate topics;
- empty topic returns the top-level help index, not every topic.

Misses are recorded for maintainers. A simple first version appends
`{topic, actor, ts}` to the first available help DB's `missed_topics` list.

## Placement

The player-facing entry verb should be universal player behavior, not a demo
catalog rule. The generic DB class and concrete help databases can still ship
as a local `help` catalog.

That split keeps the command stable while preserving catalog ownership of
content:

- `$player:help` knows how to build the search path and tell the rendered lines
  to the caller.
- `$generic_help_db` knows how to find and render topics.
- catalog help DBs own their topic text.

The first-light implementation is native-backed for `$player:help` and the
generic DB verbs. Their DSL source bodies are explicit `/* native */` stubs, not
shadow implementations. `*verbdoc*` may resolve a verb by name, but it only
includes source when the requesting actor could read that verb source through
the normal verb-read permission rule.

## First Slice

Build only:

- `$generic_help_db`;
- `$help`;
- `$player:help` / aliases `?`, `info`, `information`, `@help`;
- `help`, `help <topic>`, and `help index`;
- static `topics` map values;
- `*index*`, `*pass*`, `*forward*`, `*objectdoc*`, and `*verbdoc*`;
- missed-topic recording.

Leave for later:

- web UI;
- `*subst*`;
- full maintainer tooling;
- import of a large existing help corpus;
- editor integration beyond `:dump_topic`.
