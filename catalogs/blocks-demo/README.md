---
name: blocks-demo
version: 0.2.0
spec_version: v1
license: MIT
description: DEPRECATED no-op stub. Block demo seeds moved into demoworld in 0.2 as part of the demoworld-dependency-inversion. Install demoworld for the block demos.
keywords:
  - block
  - demo
  - deprecated
---

# blocks-demo (deprecated)

This catalog is a no-op stub kept for install-list backwards compatibility.

The_weather and the_horoscope seeds moved into the
[demoworld](../demoworld/manifest.json) catalog when demoworld became the
sink of the demo-instance dependency graph. Catalogs that define classes
no longer depend on demoworld; demoworld depends on them, and a
[`scripts/guard-catalog-layering.mjs`](../../scripts/guard-catalog-layering.mjs)
guard now enforces that direction.

To get the block demos: install `demoworld` instead of `blocks-demo`.

See [DESIGN.md](DESIGN.md) for the historical context.
