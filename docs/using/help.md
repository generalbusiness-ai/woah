# In-world help

Every world ships an in-world help system reachable as a verb on the
actor (or, equivalently, on the player's location):

```
help
help <topic>
```

The help is **woocode** — a normal catalog feature. Worlds without the
help catalog won't have it; the reference deployment ships it.

## How topic resolution works

When you run `help <topic>`, the search walks a path of help
databases:

1. **Your actor's** help database (and its parent chain).
2. **Your current location's** help database (and its parent chain).
3. The **global** registry at `$system.help_dbs`.

Each database is a `$generic_help_db` instance. The first one that
recognizes the topic (exact match, then prefix-abbreviation match)
returns. If nothing matches, you get a "no such topic" message.

This means a chatroom can ship its own help (e.g., a tutorial room
with topics specific to its objects), and falling through to the
global registry covers everything else.

## Listing topics

```
help
```

With no argument, the database returns its top-level **index**: a
short list of topics it knows about. Drill in with `help <topic>`.

## Topic content directives

Help topics are usually plain text or markdown, but they can also
return a small set of **directives** that the help machinery acts on:

| Directive | Effect |
|---|---|
| `["*index*"]` | "Show the database's topic list." |
| `["*pass*", "<topic>"]` | "Forward to the next database in the search path." |
| `["*forward*", "<topic>"]` | "Resolve `<topic>` within this same database." |
| `["*objectdoc*", <obj>]` | "Render `<obj>:look_self()` as the answer." |
| `["*verbdoc*", <obj>, "<verb>"]` | "Render `<obj>:<verb>`'s source (permission-filtered)." |

The interesting ones are `objectdoc` and `verbdoc`: they let a help
topic say "the answer is the actual object" or "the answer is the
actual verb source." That's how `help cockatoo` can show a specific
object's description, and `help look` can show the verb's own
docstring.

## What to expect from `help` for a given concept

A topic in the global database that points at an object will usually
render the object's `:describe()` summary plus any flavor text the
help author added. A topic for a verb will render the verb's source
docstring (the leading comment block of the source) plus its
arguments and aliases.

For agents: the help system is convenient, but it's not the only path
to discovery. `:describe()` on any object returns structured
metadata directly, without involving the help DB. Use `:describe`
when you want machine-readable; use `help` when you want
human-readable narrative or a topic that doesn't map to one object.

## Adding help topics

If you own a `$generic_help_db` instance, you can add topics by
calling its writer verbs (the exact shape varies by deployment;
typically `:add_topic(name, body)`). Help authors usually start by
copying an existing `:get_topic` body and editing it — the directive
shape is straightforward once you've seen one.

The catalog source for the help database lives at
[`../../catalogs/help/`](../../catalogs/help/) with design rationale
in `DESIGN.md` there.

## Caveats

- Help topic readability follows ordinary verb-source readability:
  if you can't read the verb's source, `verbdoc` directive renders
  blank.
- The help catalog is **not** a substitute for the user docs you're
  reading now. It's instance-local and meant to surface things that
  matter inside *this particular* world (this room, this NPC, this
  custom verb). General platform questions belong in these docs.
