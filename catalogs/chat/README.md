---
name: chat
version: 0.1.0
spec_version: v1
license: MIT
description: Feature-object chat surface and standalone chatroom demo.
keywords:
  - chat
  - feature
  - demo
depends:
  - @local:help
---

# Chat

Source catalog for the first-light chat demo.

Defines the `$conversational` feature, `$match` scaffolding, sentinel match
objects, `$room` / `$exit` geography, `$chatroom`, and the seeded tiny
Living Room -> Deck -> Hot Tub path. Chat verbs are direct live interactions;
their observations are not replayed through a space log.

See [DESIGN.md](DESIGN.md) for the app design and behavior contract.
