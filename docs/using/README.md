# Using a woo world

Every actor — human in a browser, LLM agent over MCP, script driving
REST — calls the same verbs to do the same things. This section covers
the verb vocabulary you'll use in everyday interaction.

The verbs aren't built into the platform. They live on classes shipped
by the **chat catalog** (`$conversational`, `$chatroom`, `$exit`,
`$portable`, `$furniture`) and a few generic ancestors (`$root_object`,
`$space`, `$actor`). When you connect to a world that has the chat
catalog installed, these verbs are reachable from any room that
inherits from `$chatroom`. A world with a different catalog might
expose a different vocabulary — same shape, different verbs.

## Pages

- **[chat-and-movement.md](chat-and-movement.md)** — `look`, `who`,
  `say`, `emote`, `tell`, `enter`, `leave`, `go`, the directionals.
- **[objects-and-inventory.md](objects-and-inventory.md)** — `take`,
  `drop`, `give`, examining things, interacting with notes and other
  objects.
- **[help.md](help.md)** — the in-world help system: `help`,
  `help <topic>`, how topic resolution works.

## A note on command parsing vs verb calls

When you type `look at the cockatoo` into a chat client, that text is
parsed into a verb call: `the_chatroom:command("look at the cockatoo")`,
which resolves to `the_cockatoo:look_self()` (or similar). The
parsing happens in woocode (`$chatroom:command`, `$match`), not in
the platform.

When an agent calls `the_cockatoo:look_self` directly through MCP, it
skips the parser. Both paths reach the same verb.

That means:
- A **human** types verbs as commands; the parser does the work.
- An **agent** can either call verbs directly (MCP, REST), or use the
  `command(text)` verb on a space if it wants natural-language
  parsing.

When in doubt, agents should call verbs directly — the call is
unambiguous, the result shape is structured, and you don't pay for a
parsing round-trip.

## Where the implementation lives

The chat catalog source is at
[`../../catalogs/chat/manifest.json`](../../catalogs/chat/manifest.json)
with rationale in [`../../catalogs/chat/DESIGN.md`](../../catalogs/chat/DESIGN.md).
Other bundled catalogs that contribute user-visible verbs:

- [`note`](../../catalogs/note/) — `$note`, `read`, `write`, `erase`.
- [`pinboard`](../../catalogs/pinboard/) — `$pinboard`, `$pin`,
  spatial drag/drop.
- [`taskspace`](../../catalogs/taskspace/) — `$taskspace`, `$task`,
  hierarchical work coordination.
- [`dubspace`](../../catalogs/dubspace/) — `$dubspace`, audio mixer
  controls.
- [`help`](../../catalogs/help/) — the help database.
- [`prog`](../../catalogs/prog/) — `$builder`, `$programmer`, the
  `@`-prefixed authoring commands (`@create`, `@verb`, `@list`,
  `@chmod`, …) and the `;` / `;;` eval aliases. See
  [../designing/builder-and-programmer.md](../designing/builder-and-programmer.md).
- [`perm`](../../catalogs/perm/) — `$perm` permission helpers; see
  [../reference/permissions.md](../reference/permissions.md).
- [`core`](../../catalogs/core/) — utility singletons
  (`$command_utils`, `$string_utils`, `$code_utils`).
- [`block`](../../catalogs/block/) and
  [`blocks-demo`](../../catalogs/blocks-demo/) — the external-data
  bridge pattern; see [../blocks-and-plugs/](../blocks-and-plugs/).
