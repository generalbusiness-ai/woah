# Blocks and plugs

A `$block` is an in-world object that bridges Port to an external
system: a weather feed, a database, an LLM, a sensor, a research
agent. It sits in a room like any other object — fixed at its
declared location — and exposes the external system's data and
behavior as ordinary Port properties and verbs.

The external side is the **plug**. A plug is a process — Python,
TypeScript, anything that speaks WebSocket — running outside Port.
It authenticates as the block's actor (via apikey), pushes data into
the block's properties, and answers verb calls (`:ask`, `:order`,
custom).

This section describes the architecture, how to use blocks that
exist, and how to write a plug for a new block.

## Pages

- **[using-blocks.md](using-blocks.md)** — interacting with blocks
  that already exist: reading data, calling verbs, freshness.
- **[writing-a-plug.md](writing-a-plug.md)** — the external connection
  contract; building a plug for a new block.

## Mental model

```
   ╭───────╮     ws + apikey     ╭───────╮
   │ plug  │ ◀────────────────▶ │ Port  │
   │       │     pushes props   │ block │ ── seen by other actors
   ╰───────╯     answers verbs  ╰───────╯       in its room
       │
       └── reaches outside (HTTP, DB, LLM, sensor, ...)
```

The block is **the surface**. The plug is **the source of truth**.
Other actors in the world don't talk to the plug; they talk to the
block. The plug doesn't see other actors directly; it sees the block's
verb queue and pushes property writes.

This is a presentation/bridge layer over an outside system, not the
system itself. The analogy is cube.js: the block is the published
surface; the actual data lives upstream. Many blocks; many plugs;
one shape vocabulary.

## Why blocks are different from regular objects

`$block` adds a few constraints over a generic `$thing`:

- **Anchored.** A block can't be moved. `:moveto` raises `E_PERM`
  except for wizards. Use it as fixed installation: a wall display,
  a piece of furniture, a vending machine.
- **Own host per instance.** Each block runs in its own host (own
  Durable Object in the production profile). Eviction, persistence,
  and observation log are isolated. A chatty block doesn't slow down
  its room.
- **Live-only data writes.** Property pushes from the plug ride the
  **live** observation route, not sequenced. They don't enter the
  space log. This keeps high-frequency blocks (a ticker, a sensor)
  from bloating logs.
- **Plug-authored data, owner-authored config.** Data properties are
  read-only to non-plug actors. Config properties (e.g., `place` on
  a weather block, `system_prompt` on a horoscope dispenser) are
  writable by the block's owner.
- **Authenticated principal.** The plug holds an apikey credential
  scoped to the block's actor. Apikey is an ordinary Port identity —
  the substrate doesn't have a "plug" concept; it just sees an
  authenticated actor that happens to write the block's properties.

Everything else is normal Port: properties, verbs, observations,
ownership. Subclasses can add arbitrary public verbs that mutate
block-internal state, take user input, or produce artifacts. That's
how `$dispenser_block` (a `$block` subclass) implements the
"order a horoscope, receive a `$note` in your inventory" pattern.

## Where the design lives

- [`../../notes/2026-05-05-block-and-plug.md`](../../notes/2026-05-05-block-and-plug.md)
  — the full design discussion. Read this if you're going deeper.
- [`../../catalogs/block/`](../../catalogs/block/) — `$block` and
  `$dispenser_block` base classes.
- [`../../catalogs/blocks-demo/`](../../catalogs/blocks-demo/) — the
  bundled `$weather_block` and `$horoscope_block` instances.
- [`../../catalogs/dispenser/DESIGN.md`](../../catalogs/dispenser/DESIGN.md)
  — the dispenser pattern (parked-task delivery, `$note` minting).
- [`../../catalogs/weather/`](../../catalogs/weather/) and
  [`../../catalogs/horoscope/`](../../catalogs/horoscope/) — example
  plug code for the bundled demos.

## When to reach for a block

Use a block when you have data or behavior that **lives outside Port**
and you want it presented inside the world. Examples:

- **Live data feeds** — weather, market data, sensor readings, a
  status board.
- **Long-running synthesis** — an LLM-driven research agent that
  produces a report on demand.
- **Bridges to external systems** — a vending machine that calls a
  payment API, a ticket dispenser that calls an issue tracker.

When NOT to use a block:

- **Pure in-world behavior** — a contraption that has internal state
  and verbs but no external dependency. Just write a normal
  `$thing` subclass with verbs. The "interactive toy" pattern
  predates `$block` and is still the right shape for self-contained
  objects.
- **Things that need to move around** — blocks are anchored.
- **Things that need to be cheap to instantiate** — each block has
  its own host, which is heavier than a regular object.
