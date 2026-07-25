---
name: casework
version: 0.1.1
spec_version: v1
license: MIT
description: Proof-of-kernel catalog for acts - $case rooms whose task lifecycle is recorded as tasks.* acts, projected by $task_board (per-task rows, view-time joins) and $kind_lanes (per-kind counts with bounded auxiliary state). Temporary by design - the real tasks-catalog migration supersedes it.
depends:
  - @local:acts
  - @local:chat
  - @local:note
keywords:
  - acts
  - proof
---

# casework

The acts-kernel proof catalog (see [DESIGN.md](DESIGN.md)). Exercises the four
kernel contracts end to end: guarded emission, single-writer folds,
fail-closed atomicity, and rebuild from recorded observations.
Temporary: retires when the tasks migration lands. Prefer excluding it
from production world defaults - it exists for gates, not users.
