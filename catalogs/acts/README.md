---
name: acts
version: 0.2.1
spec_version: v1
license: MIT
description: Acts kernel - the generic layer only. The $acts feature gives a space or catalog-owned anchored actor an internal, schema-validated, fail-closed act-emission primitive on its bound sequenced log; $projection is the base for single-writer folds with bounded cursor-paged views and incremental idempotent rebuild.
depends: []
keywords:
  - acts
  - projection
  - kernel
---

# acts

One authoritative record of coordination state per room - its sequenced
log of schema-validated acts - with work surfaces derived as projection
folds. Design: `notes/2026-07-21-acts-projection-model.md`; contracts
and findings: [DESIGN.md](DESIGN.md). Domain classes and concrete projections live
in consuming catalogs (`casework` is the proof; `outliner` is the first
real consumer). Builder's guide:
[docs/designing/acts-and-projections.md](../../docs/designing/acts-and-projections.md).
