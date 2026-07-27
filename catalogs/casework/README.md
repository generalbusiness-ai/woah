---
name: casework
version: 0.2.0
spec_version: v1
license: MIT
description: Proof-of-kernel catalog for acts - $case rooms whose task lifecycle is recorded as tasks.* acts, projected by $task_board (per-task rows, view-time joins) and $kind_lanes (per-kind counts with bounded auxiliary state). Also the worked example for scheduling: an unclaimed task escalates on a deadline that claiming cancels. Temporary by design - the real tasks-catalog migration supersedes it.
depends:
  - @local:acts
  - @local:chat
  - @local:note
  - @local:scheduling
keywords:
  - acts
  - proof
  - escalation
---

# casework

The acts-kernel proof catalog (see [DESIGN.md](DESIGN.md)). Exercises the four
kernel contracts end to end: guarded emission, single-writer folds,
fail-closed atomicity, and rebuild from recorded observations.
It is also the worked example for [scheduling](../scheduling/README.md).
`open_task` takes an optional escalation window and arms a deadline keyed to
the task it minted; `claim` cancels it; `escalate_task` records
`tasks.escalated` — but only after re-checking that the task is still
unclaimed, because cancellation is best-effort and a race can still deliver
the timer after somebody took the work.

Temporary: retires when the tasks migration lands. Prefer excluding it
from production world defaults - it exists for gates, not users.
