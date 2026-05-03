---
name: help
version: 0.1.0
spec_version: v1
license: MIT
description: In-world help database classes.
depends: []
keywords:
  - help
  - documentation
  - catalog
---

# Help

Source catalog for in-world help databases.

Defines `$generic_help_db` and a seeded `$help` database with the baseline first-light topics. The player-facing `:help` verb is universal player behavior; this catalog supplies the topic store it searches.

See [DESIGN.md](DESIGN.md) for the design and behavior contract.
