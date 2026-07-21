# acts — design

The acts-kernel proof: one authoritative record of coordination state per
room (its sequenced log of schema-validated acts), with every work surface
derived as a projection fold. Design note:
[notes/2026-07-21-acts-projection-model.md](../../notes/2026-07-21-acts-projection-model.md)
(contracts §2, Tasks proof §5, gates §6); rationale and deferred extensions in
[notes/2026-07-21-acts-composition-vision.md](../../notes/2026-07-21-acts-composition-vision.md).

## The one rule

Every stored row of coordination state is written by exactly one path: a
projection `:fold(act)` inside the same sequenced turn that recorded the act.
Two carve-outs stay object-authoritative and are **joined at view time, never
mirrored**: artifact content (`$note` name/text) and physical location (the
lease). Rows store seqs, not timestamps; times resolve from the log.

## Classes

| Class | Parent | Role |
|---|---|---|
| `$acts` (feature) | `$thing` | Internal emission primitive `:act(type, payload)` + `_validate_payload`. Mounted per consumer instance ($space instances own-seed an empty `features` list; a consumer-catalog class-level attach satisfies the installer's static this-call resolution). |
| `$projection` | `$thing` | `consumes` + `:fold` + `rows` + `:view`/`:view_row` + incremental idempotent `:rebuild_from`. `rows`/`consumes`/`row_cap`/`at_seq`/`rebuild_scan_seq` are perms-empty: only catalog-author verbs write them. |

Domain classes, schemas, and concrete projections live in consuming
catalogs — the proof set (`$case`, `$task_board`, `$kind_lanes`, the
`tasks.*` schemas) is in `catalogs/casework/`, retired when the real
tasks migration lands.

## Emission contract (enforced, tested)

`:act` requires `seq >= 1 && space == this` (direct routes carry `seq == -1`)
and `caller == this` (only room verbs emit). Payloads validate against
`event_schema(this, type)` — the closed flat shape subset (`obj`, `str`,
`bool`, `int`, `float`, `num`, `list`, `map`), every declared key required,
undeclared keys refused. Folds receive the act plus its envelope `seq`
injected by the kernel (live) or by `:rebuild_from` (recorded); the observed
act body stays free of envelope fields.

**Fail-closed**: any fold failure aborts the entire turn via the outer
behavior savepoint — the entry commits as `applied_ok: false` carrying only
its `$error` observation, and the fold writes AND the domain verb's physical
effects (including a minted artifact) roll back together. `E_QUOTA` at
`row_cap` is the declared refuse-overflow policy.

**Rebuild**: `fold(recorded acts) == rows`, exercised by
`$projection:rebuild_from(space, from_seq)` — rebuild input is the recorded
observations, never verb re-execution, so verb changes cannot invalidate a
projection. Failed entries contribute nothing.

## Core seams used

Exactly two generic read completions (see the kernel note §2.2/§2.3):
`event_schema(obj, type)` (introspection-spec'd builtin, now implemented) and
the persisted `ts` on `$space:replay()` results.

## Proof status

v0.1.0 is the kernel proof, in-memory lane: `tests/acts-kernel.test.ts`
covers the seams, the lifecycle, emission authority, fail-closed atomicity,
and the rebuild invariant. Not yet: the full tasks-catalog field migration
and parity golden (kernel note §5.3), the workerd lane, client kanban
adoption, act-rate/storage budget measurements (§8 Tier C), and everything
the vision note defers (actor emission, dynamic attach/genesis, routing,
practices).
