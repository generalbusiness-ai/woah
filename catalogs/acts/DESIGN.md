# acts — design

Normative contract: [`spec/semantics/acts.md`](../../spec/semantics/acts.md).

The acts-kernel proof: one authoritative record of coordination state per
room (its sequenced log of schema-validated acts), with every work surface
derived as a projection fold. Historical design note:
[notes/2026-07-21-acts-projection-model.md](../../notes/2026-07-21-acts-projection-model.md)
(contracts §2, Tasks proof §5, gates §6); rationale and deferred extensions in
[notes/2026-07-21-acts-composition-vision.md](../../notes/2026-07-21-acts-composition-vision.md).

## The one rule

Every stored row of coordination state is written by exactly one path: a
projection `:fold(act)` inside the same sequenced turn that recorded the act.
Three carve-outs stay authoritative outside projection rows and are **joined
at view time, never mirrored**: artifact content (`$note` name/text), physical
location (the lease), and substrate relations already maintained by a single
writer. A relation-checkpoint projection may add vocabulary and a completeness
watermark, but no copied rows. Rows store seqs, not timestamps; times resolve
from the log.

## Classes

| Class | Parent | Role |
|---|---|---|
| `$acts` (feature) | `$thing` | Internal, non-`x` emission primitive `:act(type, payload)` + `_validate_payload`. Both validate their caller; underscore naming and `direct_callable:false` alone are not privacy. Mounted per consumer instance ($space instances own-seed an empty `features` list; a consumer-catalog class-level attach satisfies the installer's static this-call resolution). |
| `$projection` | `$thing` | `source_space` composer binding + `log_space` sequenced-log binding + `consumes` + internal `:fold` + `rows` + `:view`/`:view_row` + incremental idempotent `:rebuild_from`. Bindings and projection state are perms-empty. `fold` has no public execute permission and accepts only its composer, including during composer-mediated rebuild. |

Domain classes, schemas, and concrete projections live in consuming
catalogs — the proof set (`$case`, `$task_board`, `$kind_lanes`, the
`tasks.*` schemas) is in `catalogs/casework/`, retired when the real
tasks migration lands.

## Emission contract (enforced, tested)

`:act` requires `seq >= 1`, `caller == this`, and either `space == this` for a
space composer or `space == location(this)` for a catalog-owned anchored actor.
Direct routes carry `seq == -1`. It also lacks `x`: the caller guard is the
semantic authority boundary, while the permission bit prevents public
sequenced ingress from reaching it. Every attached projection must bind
`p.source_space == this` and `p.log_space == space`; each concrete fold accepts
only that composer.
`rebuild_from` cannot supply a fold input: it asks the bound source's internal
replay helper to derive inputs from recorded observations and call the fold.
Payloads validate against
`event_schema(this, type)` — the closed flat shape vocabulary (`obj`, `str`,
`bool`, `int`, `float`, `num`, `list`, `map`, `null`, with `a|b` unions —
earned by the outliner migration), every declared key required,
undeclared keys refused; `str` refuses live object refs. Folds receive the Act
plus recorded envelope `seq`, `actor`, and composer `source`, injected
identically live and by `:rebuild_from`; the observed semantic body stays free
of envelope fields.

**Fail-closed**: any fold failure aborts the entire turn via the outer
behavior savepoint — the entry commits as `applied_ok: false` carrying only
its `$error` observation, and the fold writes AND the domain verb's physical
effects (including a minted artifact) roll back together. `E_QUOTA` at
`row_cap` is the declared refuse-overflow policy.

**Rebuild**: `fold(recorded acts) == rows`, exercised by
`$projection:rebuild_from(log_space, page_budget)` — rebuild input is the
recorded observations after the projection's scanned watermark, never verb
re-execution, so verb changes cannot invalidate a projection. The requested log
must equal the immutable `log_space` binding. Failed entries contribute
nothing.

## Core seams used

The kernel itself uses two generic read completions (see the kernel note
§2.2/§2.3):
`event_schema(obj, type)` (introspection-spec'd builtin, now implemented) and
the persisted `ts` on `$space:replay()` results. Outliner's authority audit
also forced one generic moveto correction: container hooks receive the moving
object as `caller`, allowing catalog lifecycle guards to authenticate substrate
dispatch. That is a third branch-level core change, not an Acts read seam.

## Proof status

v0.1.0 proved the kernel in memory; Outliner then proved a real
relation-checkpoint consumer. Net replay is also closed: a fresh Outliner
projection rebuilds from the room authority's durable log through a sparse
planner, with page attestation and real-workerd SQLite/RPC repair covered.
Outliner parity/deletion and the production-shaped scale gate are closed: at
1,000 rows and eight independent viewers, workerd measured 101 ms warm-read
p95 initially; the authority-hardening rerun measured 100 ms, ~145.5 KiB
responses, 48 ms mutation-to-seven-peer-push p95, and 940 ms
invalidation-to-current p95. Direct semantic reads validate without advancing
authority, and exact repeated read proofs are deduplicated on the submit wire.
Dispenser is now the second consumer and first plug-backed proof: typed Net
verbs emit internally from an anchored actor, `$dispenser_queue` replaces the
directly written queue, dropped replies have transport and bounded domain
idempotency, SQLite v0 genesis is covered, and a fresh projection rebuilds all
meaningful state through the sparse Net replay path. Tasks follows with the
full field migration and parity golden (kernel note §5.3).
Still open: client kanban adoption and the vision note's deferred actor emission,
dynamic attach/genesis, routing, and practices.
