---
name: chat
version: 0.2.4
spec_version: v1
license: MIT
description: Foundational chat primitives — conversational/acoustic features, $match scaffolding, $room/$exit geography, $chatroom/portable/furniture base classes. No demo instances; install @local:demoworld for those.
keywords:
  - chat
  - feature
  - demo
depends:
  - @local:help
---

# Chat

Source catalog for the first-light chat demo.

Defines the `$conversational`, `$transparent`, and `$semitransparent` features,
`$match` scaffolding, sentinel match objects, `$room` / `$exit` geography, the `$chatroom` template, and the
`$portable` / `$furniture` base classes. **No instances are seeded** — the
bundled Living Room → Deck → Hot Tub demo lives in the separate
`@local:demoworld` catalog. Chat verbs are direct live interactions; their
observations are not replayed through a space log.

See [DESIGN.md](DESIGN.md) for the app design and behavior contract.
