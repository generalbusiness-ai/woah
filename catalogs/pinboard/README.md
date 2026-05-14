---
name: pinboard
version: 0.4.1
spec_version: v1
license: MIT
description: Spatial bulletin board demo built from first-class $pin < $note objects. Pins use the v0.2 $note shape (name + description + text, where text is a single markdown string); the board owns layout independent of note content.
depends:
  - @local:chat
  - @local:note
keywords:
  - notes
  - coordination
  - demo
---

# Pinboard

Source catalog for the first-light spatial note coordination demo.

Defines a pinboard class and seeded `the_pinboard` instance mounted in the chat
world. The pinboard is a located object and its own `$space`; notes on the board
are first-class `$pin < $note` objects, with layout stored by the board.

See [DESIGN.md](DESIGN.md) for the app design and behavior contract.
