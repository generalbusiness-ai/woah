---
name: dubspace
version: 1.0.2
spec_version: v1
license: MIT
description: Shared dub-mix sound space demo objects.
keywords:
  - audio
  - demo
  - space
---

# Dubspace

Source catalog for the first-light collaborative sound demo.

Defines the dubspace class, control classes, and the seeded `the_dubspace`
instance with four loop slots, one mixer channel, filter, delay, percussion
loop, and default scene. All coordinated shared-state changes are intended to
flow through `the_dubspace` as sequenced calls.

See [DESIGN.md](DESIGN.md) for the app design and behavior contract.
