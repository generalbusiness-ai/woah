---
name: demoworld
version: 0.1.0
spec_version: v1
license: MIT
description: First-light demo world. Seeds the Living Room / Deck / Hot Tub setting with portable props, a sulphur-crested cockatoo, and every bundled demo instance (the_dubspace and its controls, the_pinboard, the_outline, the_weather, the_horoscope). Sinks the demo-instance dependency graph — nothing depends on demoworld.
depends:
  - @local:chat
  - @local:tasks
  - @local:outliner
  - @local:pinboard
  - @local:dubspace
  - @local:weather
  - @local:horoscope
keywords:
  - demo
  - first-light
  - world
---

# demoworld

The seed catalog for woo's first-light demo. It does not define core
behavior — the chat catalog does that. demoworld only contributes one
class (`$cockatoo`) and a populated room set so the bundled client has
somewhere to land, plus every bundled demo's instance placement.

What demoworld seeds:

- Four `$chatroom` instances: `the_chatroom` (Living Room), `the_deck`,
  `the_hot_tub`, and `the_garden`.
- `$exit` instances wiring them together, including the steps that lead
  south from the deck into the garden and the gravelled path south from
  the garden to `tasks:the_taskboard` ("Santa's workshop").
- Four `$portable`/`$furniture` props: `the_couch`, `the_lamp`,
  `the_towel`, `the_mug`.
- One `$cockatoo` instance (`the_cockatoo`) on the mantelpiece.
- `$conversational` attached to each of the rooms.
- **The bundled demo instances**: `the_outline` (`$outliner`),
  `the_pinboard` (`$pinboard`), `the_dubspace` (`$dubspace`) plus its
  four loops, channel, filter, delay, drum loop, and default scene,
  `the_weather` (`$weather_block`), `the_horoscope`
  (`$horoscope_block`). Each gets `chat:$transparent` attached.

The dependency direction is one-way: demoworld depends on every
class catalog whose instance it owns; nothing depends on demoworld.
[`scripts/guard-catalog-layering.mjs`](../../scripts/guard-catalog-layering.mjs)
rejects any catalog that declares `@local:demoworld` in its
`depends`. To ship a new demo instance, the class catalog defines
classes/verbs only; demoworld adds a `seed_hook` and gains
`@local:<new-catalog>` in its own depends.

A world that wants the class libraries but its own room layout
installs the class catalogs directly and skips this one.

See [DESIGN.md](DESIGN.md) for the room layout and how to add a new
demo instance.
