# casework — design

The acts-kernel proof catalog, split out of `acts` (2026-07-21 review:
the kernel must stay generic). Carries the `$case` proof room, the
`tasks.*` schema declarations, and the two proof projections
(`$task_board`, `$kind_lanes`). See `catalogs/acts/DESIGN.md` for the
kernel contracts and `notes/2026-07-21-acts-projection-model.md` for
the design.

**Temporary by design.** The real tasks-catalog migration (kernel note
§5) is the first production consumer of the kernel: it takes ownership
of the task schemas and board, `$task_registry` becomes the case-shaped
space, and this catalog then retires along with its proof classes. Do
not grow it.
