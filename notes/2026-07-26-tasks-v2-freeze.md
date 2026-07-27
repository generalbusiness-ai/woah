# Tasks v2 freeze

Date: 2026-07-26. Status: **frozen for review** — this note fixes the design
surface for the Tasks migration to the Acts kernel (adoption queue item 2,
[2026-07-21-acts-projection-model.md](2026-07-21-acts-projection-model.md) §7.1).
Implementation begins against this note; the normative kernel contract stays
[`spec/semantics/acts.md`](../spec/semantics/acts.md), and the catalog's
DESIGN.md restates the frozen shapes when the code lands. Everything here
follows the one rule: every stored row of coordination state is written by
exactly one path — a projection fold inside the same sequenced turn that
recorded the act — with artifact content, physical location, and substrate
relations joined at view time, never mirrored.

## 1. What stays (unchanged commitments)

- The verb surface: `claim / handoff / release / pass / reject / wait / yield /
  drop_terminal`, plus registry policy authoring (`set_role`,
  `set_obligation`, `set_policy`, `seed_minimal_policy`, removals) and
  `create_task`.
- Movement-as-lease: `task.location` is who's working on it;
  `transition_intent` + `:acceptable` gating keeps generic `take`/`give`/`drop`
  from bypassing the lifecycle. The lease is one of the three view-time joins —
  the board row stores no holder and no `claimed` flag.
- `$task < $note`: `name`, `description`, `text` stay artifact authority.
- Obligation-cursor semantics: the cursor is computed, never stored.
- Every task stays anchored to its registry; folds and joins remain inside one
  anchor cluster.
- Registry config (`roles`, `obligations`, `policies`) stays authoritative
  registry properties. Config is policy, not per-item coordination state; rows
  snapshot obligations at open, and orphan detection stays a view-time
  computation, exactly as v1 behaves.

## 2. Emission mechanics: the registry-mediated emitter

The dispenser emits as an anchored actor (`space == location(this)`), but a
claimed task's *location is the holder*, so the ACT3 anchored-actor form
cannot carry task lifecycle facts. Tasks v2 therefore uses the space-composer
form through an internal registry emitter:

- `$task_registry` mounts `$acts` and owns the sequenced log; every task is
  anchored to its registry, so every sequenced lifecycle verb on a `$task`
  already executes on the registry's log (`space == registry`).
- A lifecycle verb on `$task` calls `this.registry:_record_task_act(type,
  payload)`. The internal emitter verifies `caller` is a live `$task` with
  `caller.registry == this`, verifies the payload's `task` field names the
  caller, and then invokes `this:act(type, payload)` — satisfying ACT3's
  `caller == composer, space == this`.
- `_record_task_act` has no public execute permission; the caller guard is the
  authority boundary (underscore naming and permission bits alone are not
  privacy — same discipline as `$acts:act` itself). The adversarial gate
  drives it directly and through a metadata-bypassing wizard programmer.

This is a pattern within the existing ACT3 contract, not a kernel change.

## 3. Act vocabulary (concise, versioned)

Twelve live types plus two migration-only types, all `version: 1`, declared in
the tasks manifest `schemas` block on `$task_registry`. Envelope carries
`space, seq, actor, ts, verb` — payloads never repeat them (ACT1). Payload
strings are bounded (§5); prose belongs on artifacts or in `tell(...)` lines.

| Act | Shape | Emitted by |
|---|---|---|
| `tasks.opened` | `{task: obj, kind: str, labels: list, obligations: list}` | `create_task` (same turn as the mint) |
| `tasks.claimed` | `{task: obj}` | `claim` (same turn as the lease move) |
| `tasks.handed_off` | `{task: obj, to: obj}` | `handoff` |
| `tasks.released` | `{task: obj}` | `release`, and the auto-release on completion |
| `tasks.passed` | `{task: obj, obligation: str, evidence_code: str\|null}` | `pass` |
| `tasks.rejected` | `{task: obj, obligation: str, why: str}` | `reject` |
| `tasks.waited` | `{task: obj, condition: map}` — condition is the closed §5 vocabulary, not an arbitrary map | `wait`, and `yield` with `blocking` |
| `tasks.wait_cleared` | `{task: obj, condition: map}` | the registry's child-completion hook (v1 `_on_release` cleared silently; under Acts a row write with no act is a review-blocking defect) |
| `tasks.yielded` | `{task: obj, child: obj, blocking: bool}` | `yield` |
| `tasks.relabeled` | `{task: obj, labels: list}` | `set_labels` |
| `tasks.dropped` | `{task: obj, why: str}` | `drop_terminal` |
| `tasks.closed` | `{task: obj, outcome_code: str}` | the completing `pass` turn (explicit act; the fold never derives completion) |
| `tasks.genesis` | `{row_count: int}` | migration only |
| `tasks.legacy_opened` | `{task: obj, kind: str, labels: list, obligations: list, phase: str}` | migration only (the migration turn's actor is not the historical opener, so phase rides the payload) |

Disposition of the seventeen v1 observation types:

| v1 observation | v2 disposition |
|---|---|
| `task_created` | `tasks.opened` |
| `task_claimed` / `task_released` | `tasks.claimed` / `tasks.released` — the lease move stays the physical authority; these acts are the journal fact and the row's `last_change_seq` bump |
| `task_moved` | **retired** — handoff gets `tasks.handed_off`; other moves are lease physics, already observable as substrate movement |
| `task_passed` / `task_rejected` / `task_waited` / `task_yielded` / `task_dropped` | `tasks.passed` / `.rejected` / `.waited` / `.yielded` / `.dropped` |
| `task_returned_home` | **retired** — the auto-return is lease physics; `tasks.released`/`tasks.closed` carry the coordination fact |
| `obligation_orphaned` | **retired** — orphan status is computed at view time from row snapshot vs registry config, exactly as v1 computes it |
| `registry_role_changed` / `registry_obligation_changed` / `registry_policy_changed` | **stay plain observations** — registry config is authoritative property state, not projection input; no fold consumes them |
| `task_renamed` | **retired as a tasks fact** — `name` is artifact authority; the note catalog's own edit observation carries client invalidation |
| `task_relabeled` | `tasks.relabeled` |

## 4. Projection shape

`$task_board < $projection`, bound at seed to its registry (`source_space ==
log_space == the registry`). Sole writer of:

```
rows[task_id] = {
  "task": <ref>,
  "kind": str, "labels": list,
  "obligations": list,          // [{key, met}] snapshot at open, cursor advanced by folds;
                                // evidence_code is a journal fact (tasks.passed), never row state
  "waits": list, "links": list,
  "phase": "active",
  "opened_seq": int, "last_change_seq": int
}
receipts[task_id] = { "task": <ref>, "phase": "closed" | "dropped", "closed_seq": int }
```

The closing/dropping fold evicts the full row into its compact receipt (§5) —
terminal state is a receipt, never a retained row. No name, no holder, no
timestamps (seqs resolve from the log). The domain
verbs validate lifecycle transitions against the authoritative row and refuse
`E_TRANSITION` out of terminal phases — fold defensiveness is not a substitute
for the domain state machine (review finding 1, 2026-07-21).

- `view(args)` joins per requested page: `task.name`, `location(task)` (→
  derived holder), resolved times from `*_seq`, computed cursor role — and
  supplies every field of today's `:listing` contract for **active** tasks
  (the parity golden). Terminal tasks list from their receipts with reduced
  fields (task, phase, resolved close time, artifact-joined name); this is a
  **documented parity divergence** — v1 retained full terminal rows, v2 trades
  them for the provable envelope (§5).
- `view_row(task)` is the single-task form; `:detail` becomes a thin wrapper
  over `view_row` plus the artifact join.
- `rebuild_from` is source-mediated recorded-observation replay (ACT6),
  asserted equal to live rows after the full scripted lifecycle and again
  after mutating a lifecycle verb's source.
- `$kind_lanes` (per-kind lane counts, the Tier-B.3 composition proof) ships
  as the optional second fold if the kanban needs lane counts; it composes with
  zero edits to existing writers or it does not ship.
- Act observations do **not** route to the chat panel; they land in the
  generic observation surface unless a `ChatFormatterRegistry` entry opts a
  type in. v2 opts in none.

## 5. Row and storage bound (decision D1, D2)

**Storage**: rows stay a map property with whole-property write-back. The
write amplification is O(rows) per act and every write re-ships the cell, so
the wire ceiling — not the 256 KiB value cap — is the binding constraint. The
dispenser's saturated 50-row proof measured ~48.3 KiB against the 64 KiB warm
envelope, and task rows are fatter than dispenser rows: review of the first
freeze draft showed that 50 full rows at the draft's per-field caps already
serialize to ~62 KiB before cell and proof metadata. Per-field caps alone
therefore do not prove the envelope. Two structural changes make the
arithmetic provable instead of hopeful:

1. **An enforced per-row byte ceiling.** A serialized (canonical-JSON) active
   row must not exceed **768 bytes**. The domain verb validates before
   emitting; the fold refuses `E_INVARG` as the backstop. This is the load-
   bearing bound — the per-field caps below exist to make normal rows land
   well under it, not to prove the total.
2. **Terminal rows are compact receipts, not retained full rows.** The
   `tasks.closed`/`tasks.dropped` fold **evicts** the full row and writes
   `receipts[task_id] = {task, phase, closed_seq}` (≤ 96 bytes). Retaining
   full terminal rows is what made the draft's 100-row shape exceed the
   envelope.

**Bounds (contract, not defaults)**:

| State | Cap | Overflow |
|---|---:|---|
| serialized active row | 768 bytes | refuse `E_INVARG` at the verb; fold backstop |
| active rows per registry | 40 | refuse `E_QUOTA` at `tasks.opened` fold |
| terminal receipts | 50 | deterministic oldest-`closed_seq` eviction |
| obligations per task (row stores `{key, met}` only) | 8 | refuse at `create_task` |
| `kind` / obligation `key` / label | 24 / 32 / 16 chars; ≤ 4 labels | refuse `E_INVARG` |
| `evidence_code` / `why` (journal-only; never in rows) | 64 / 200 chars | refuse `E_INVARG` (prose goes on the artifact) |
| `waits` / `links` per task | 4 / 8 | refuse `E_INVARG` |

Wait conditions are **not arbitrary maps**: the `condition` value is a closed
vocabulary — `{"kind": "child_complete", "task": <obj>}` or
`{"kind": "external", "key": str≤32}` — enforced by the `wait` verb and by
`_validate_payload` (the flat shape-tag language cannot express a closed map
union, so the woocode validator carries it; the act schema tag stays `map`).

Worst-case arithmetic under these bounds: 40 active rows × 768 B = 30,720 B,
plus 50 receipts × 96 B = 4,800 B, plus map syntax — the coordination cells
stay under ~36 KiB, inside the dispenser-proven ~48 KiB budget with the
envelope's transcript/submit overhead accounted. The production-shaped
saturated-envelope regression (40 worst-case active rows + 50 receipts,
envelope < 64 KiB) remains a release gate and is the arbiter: **if the
measured envelope contradicts this arithmetic, the caps come down; they do
not go up without the measurement.**

Forty active tasks per registry is the honest capacity of this storage form; a
registry is a case room, not a company backlog, and registries scale
horizontally (Big-World discipline). **The named upgrade path is substrate
per-row relation storage behind the unchanged `view()` seam** — the model's
first substrate ask (§7.2.2), aligned with the generic
fact→relation-row→compatibility-view direction already used by the contents
pipeline. Adopting it later raises the cap without touching the vocabulary,
the fold contract, or the client; it is explicitly **not** part of the v2
release unit.

## 6. History retention (decision D3)

- The per-task `log` list property is **dropped**. The sequenced log is the
  history; `rebuild_from` proves it is sufficient.
- v2 ships **no per-task history projection**. A filtered journal read
  (`payload.task == t`) without an index is an unbounded scan, so `:detail`
  returns current state only (row + artifact join), and the registry `journal`
  read stays the paged room-log view.
- When the task detail panel is built, per-task history becomes bounded
  fold-private auxiliary state under the ACT4/§2.3 caps-and-eviction rules —
  a capped `recent[task_id]` ring written by the same folds. That is the
  committed mechanism; building it now is deliberately excluded.

## 7. Complete field disposition

"Retired" below means: renamed to `legacy_*` by the CT14 structural migration,
served-from only until that registry's genesis, and physically dropped only by
a later cleanup migration after fleet-wide genesis is proven (§8) — never
destroyed while it is still the genesis seed.

`$task_registry`:

| Property | Disposition |
|---|---|
| `roles`, `obligations`, `policies` | stay (authoritative config; plain observations on change) |
| `_tracked_tasks` | **retired** → `legacy_tracked_tasks` — board rows are the roster; `listing` reads `board:view()` |

`$task`:

| Property | Disposition |
|---|---|
| `registry` | stays (anchor back-ref; emitter validation) |
| `kind`, `obligations`, `wait_for`, `links`, `labels`, `terminal` | **retired** → `legacy_*` — board row fields (`terminal` → `phase`; row obligations store `{key, met}` only) |
| `log` | **retired** → `legacy_log` — recorded acts are the history |
| `created_at`, `last_change` | **retired** → `legacy_*` — `opened_seq` / `last_change_seq` + view-time resolution |
| `source` | **retired** → `legacy_source` — provenance belongs to the log envelope; the v1 property was write-only convenience |
| `transition_intent` | stays (transient lease-gate mechanism, never coordination state) |
| `$note` inheritance (`name`/`description`/`text`/writers) | stays (artifact authority) |

Verb disposition: `cursor`, `detail`, `listing`, `available_actions`,
`_task_complete` become reads over `board:view_row` / row state; every
lifecycle verb gains its same-turn act; `_on_release` gains
`tasks.wait_cleared`; a lifecycle verb with no act is a review-blocking
defect.

## 8. Migration (v1 → v2, CT14)

Major-version bump `1.x` → `2.0.0` with `migration-v1-to-v2.json` shipped next
to the manifest. **CT14's step vocabulary is declarative** — renames, drops,
adds, `reindex_ordered_edges`, and `transform_property`'s declarative op set
are implemented; what remains deferred is inline/`custom` transform execution
(`rename_class` likewise) — and catalog updates run under the catalog
registry's sequencer, not each world room's. So the stateful walk (emitting
acts and running folds on each registry's own log) cannot be a CT14 step, and
the first freeze draft's "one sequenced turn per registry that emits acts,
folds rows, then drops the old properties" was not implementable (and its
drops would have destroyed the seed state). The shape that IS implementable
is the dispenser's proven two-part cutover, reused exactly:

1. **CT14 structural part (non-destructive)**: rename the v1 coordination
   properties to `legacy_*` (`_tracked_tasks` → `legacy_tracked_tasks`; the
   per-task `kind`/`obligations`/`wait_for`/`links`/`labels`/`terminal`/
   `log`/`created_at`/`last_change` likewise), add the v2 properties
   (`acts_initialized`, `projections` binding seat), and install the v2 verb
   pages. **Nothing is dropped.** The legacy properties are the genesis seed
   and remain until a later cleanup migration lands after fleet-wide genesis
   is proven — the dispenser retains its `legacy_*` properties the same way.
2. **Lazy woocode genesis, per registry, under its own sequencer**: the first
   sequenced lifecycle touch of a registry (or an explicit operator-invocable
   sequenced `initialize_board`) runs `_ensure_board`, the analogue of the
   dispenser's `_ensure_acts`. In that registry's own sequenced turn it emits
   `tasks.genesis`, then one `tasks.legacy_opened` per valid legacy task
   (phase in the payload — the genesis turn's actor and time are not
   historical), folds the rows, and marks `acts_initialized`.
3. **Legacy mode is a complete operating mode, not a read shim.** While
   `acts_initialized` is false, the v2 verb pages run **both reads and
   mutations** against the `legacy_*` properties with v1 semantics verbatim,
   emitting the v1 plain observations so existing clients keep working — the
   dispenser's legacy fallback pattern, extended to the whole lifecycle
   surface. This is what makes the over-cap case safe (next item): a registry
   that cannot reach genesis is not write-frozen; it simply keeps being a v1
   registry.
4. **Bounds refuse genesis atomically, without destruction and without a
   retry storm**: a registry whose legacy state exceeds the §5 caps (more
   than 40 active tasks, an over-wide field, a nonconforming wait condition)
   refuses genesis, records a `genesis_blocked` marker naming the violation
   (with a plain observation for operators), and continues in legacy mode.
   While the marker is set, lifecycle touches do **not** re-attempt genesis —
   no per-turn retry cost. Genesis is re-attempted only by the explicit
   sequenced `initialize_board`, which clears the marker, re-validates, and
   either completes genesis or re-records the refusal; the operator path is
   therefore: drain/repair the registry below the caps (in legacy mode),
   then `initialize_board`. Truncation and behind-the-fold seeding are
   forbidden.
5. Idempotent: genesis re-entry on an initialized registry is a no-op
   (`acts_initialized` + genesis receipt); partial-failure recovery re-enters
   safely because the marker commits in the same fold-carrying turn.
6. Test-run on a local SQLite woo before merge (repo migration rule), plus a
   vitest walking a populated v1 world through rename → lazy genesis and
   asserting the parity golden against the pre-migration `:listing` output,
   and an over-cap case that proves: genesis refuses and records
   `genesis_blocked`; legacy **mutations** (`claim`/`pass`/`create_task`)
   still commit afterward; subsequent touches skip the genesis attempt; and
   `initialize_board` succeeds after the registry is drained below the caps.
7. Consumers accept both observation shapes during the rolling interval, as
   the walkthrough already does for outliner and dispenser; the client keeps
   the v1 handlers until the deployed world's registries have all reached
   genesis.

The casework proof catalog (`$case`, `tasks.*` proof schemas, `$task_board`,
`$kind_lanes`) retires from the bundle in the same release; existing-world
casework retirement is a separate initiative (adoption item 6) and explicitly
not part of this unit.

## 9. Release unit and gates

One release unit: catalog v2 + client semantic-view adoption (kanban renders
from `board:view()` through the shared `WooViewController`, peer mutation
visible cross-user) + the §6 gates of the projection-model note instantiated
for Tasks — rebuild/write-authority, emission authority (including the
wizard-bypass variant against `_record_task_act`), fail-closed atomicity
(raising fold aborts lease move and artifact mint together), parity golden,
bounds (row caps + act-rate budget on the workerd lane), client regression,
cold-case cost (1k bare registries stay cold), saturated-envelope regression,
and the E4/E5 adversarial lane (injection-bearing task names served only in
the quarantine envelope; undeclared `provenance` keys refused). Canary and
bake follow as their own step (adoption item 5), after the dispenser bake.

## 10. Exclusions (deliberate)

- No named-state workflow machine — the obligation cursor stays. `$workflow_*`
  remains the separate WF pattern; WF5 is amended to emit an Act so its first
  adopter lands inside the vocabulary discipline (see the spec change).
- No approval, TTL, failure, or dead-letter transitions; add facts only when a
  real domain policy earns them.
- No dynamic projection attachment; the board binds at seed/genesis.
- No cross-registry yields: `yield` refuses a child kind whose registry is not
  the parent's (v1 already mints in-registry; v2 states it).
- No arbitrary wait conditions: the closed §5 condition vocabulary only; a new
  wait kind is a schema'd vocabulary change, not a payload liberty.
- No destructive migration drops: `legacy_*` properties survive until the
  post-genesis cleanup migration (§8).
- No per-task history projection in v2 (§6).
- No substrate relation storage in v2 (§5) — named upgrade, not scope.
- No chat routing for `tasks.*` acts.

## Decisions locked by this freeze

1. **D1 storage**: map-prop rows now; substrate per-row relations later behind
   `view()` (supersedes §7.2.2's open question with the envelope math).
2. **D2 bounds** (revised after review — the draft's 50 full active + 50 full
   terminal rows serialized past the envelope): an enforced 768-byte
   serialized-row ceiling, 40 active rows, terminal rows evicted to ≤ 96-byte
   compact receipts (50, deterministic eviction), closed wait-condition
   vocabulary, evidence out of rows; the saturated-envelope gate is the
   arbiter and caps only ever come down from measurement.
3. **D3 history**: log dropped; journal is history; per-task panel history is
   deferred fold-private aux state.
4. **D4 emission**: registry-mediated internal emitter (`_record_task_act`)
   under ACT3's space-composer form; no kernel change.
5. **D5 completion**: explicit `tasks.closed` in the completing pass turn;
   folds never derive completion.
6. **D6 config**: registry role/obligation/policy changes stay plain
   observations; rows insulate via open-time snapshot; orphan status stays
   view-computed.
7. **D7 migration** (revised twice after review — CT14's declarative steps
   are implemented but inline/`custom` execution is not, and updates run
   under the catalog registry's sequencer): two-part cutover — CT14
   structural renames to `legacy_*` (non-destructive) plus per-registry lazy
   woocode genesis under each registry's own sequencer, the dispenser's
   `_ensure_acts` precedent. Legacy mode is a complete operating mode: reads
   AND mutations run v1 semantics verbatim until genesis, so an over-cap
   registry is never write-frozen — it records `genesis_blocked` once (no
   per-turn retry) and re-attempts only via explicit `initialize_board`
   after operator drain/repair.
