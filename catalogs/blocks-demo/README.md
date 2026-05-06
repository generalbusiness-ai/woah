---
name: blocks-demo
version: 0.1.0
spec_version: v1
license: MIT
description: Demo seed instances for the $block pattern — a weather panel in the chatroom and a horoscope machine on the deck.
keywords:
  - block
  - demo
  - weather
  - horoscope
---

# blocks-demo

Bundles the two demo block instances:

- **`the_weather`** — a `$weather_block` anchored in `the_chatroom`, the
  default place is `Mountain View, CA`, units imperial, 12h forecast.
- **`the_horoscope`** — a `$horoscope_block` anchored on `the_deck`, with
  a wry-fortune-teller `system_prompt` and the default 60s rate limit.

This catalog is pure seed-hook wiring; it adds no classes or verbs.
Install when you want the demo ambience pre-populated. Skip if you want
to create block instances by hand via `@create_instance`.

See [DESIGN.md](DESIGN.md) for placement rationale and how to wire the
plugs.
