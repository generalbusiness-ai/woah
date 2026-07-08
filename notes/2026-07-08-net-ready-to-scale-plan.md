# Net ready-to-scale implementation plan (ordered)

Date: 2026-07-08. Branch `net-predeploy`. Turns the risk register
(`notes/2026-07-07-net-predeploy-scale-migration-risks.md`, Register A+B)
into an ordered, testable implementation plan.

**Bar:** the first new deploy must be architecturally ready-to-scale. Every
phase does the two moves together — remove a small-world assumption AND
land the simpler shape (they point the same way) — and each is gated by an
**asymptotic invariant**, not an SLO. No phase reopens the v2 freeze.

**Definition of done for the first deploy:** Phases 0–5 green on
`load:net-dev`, plus Phase 6's session shard-hint stamped (multi-shard
routing may follow). That is the honest ready-to-scale line: no O(world)
assumption remains, and adding a shard later is a routing change, not a
data migration.

---

## Phase 0 — the measuring stick: `load:net-dev` asymptotic gate

Build the acceptance bar first so every later phase is TDD: it starts RED
(documents today's O(view)/O(sessions) reality) and each phase flips one
invariant green.

- Extend the workerd smoke harness (`scripts/net-smoke-*`) into a load
  driver parameterized by: rooms `R`, sessions/room `S`, off-room sessions
  `X`, cold-open, outbox backlog `B`, scheduled-due burst `D`.
- Instrument counters (reuse D2 `net_turn_structure` `sync_rpc`/
  `reconstructions`; ADD: `plan_cells`, `presence_scan_rows` per fanout,
  `closure_bytes`/`closure_pages`, `outbox_drain_rows` per pass).
- **`plan_cells` is MANDATORY and sourced from the exact cell array passed
  to `planningWorldFromCells`** (today `storeCells(snapshot)` — the whole
  view), NOT inferred from `readClosureCells` after planning (review #5).
  The existing structure counters (attempt/bytes/sync_rpc/writes/
  reconstructions, `gateway-do.ts:634`) do not see the resident-view
  clone/rebuild CPU at all; and counting the post-hoc read closure would
  already look small today, hiding the very O(view) cost the red baseline
  must show. Count the planner INPUT, not its output.
- Assert INVARIANTS (ratios across two world sizes), not absolute times:
  - `plan_cells` and warm `sync_rpc` **flat as view size grows** (Phase 1);
  - `presence_scan_rows` ~ room occupants, **flat as `X` grows** (Phase 2);
  - `outbox_drain_rows`/pass **bounded as `B` grows** (Phase 3);
  - `closure_bytes` **bounded as scope size grows** (Phase 4).
- Deliverable: `npm run load:net-dev`, added to the pre-deploy gate list.
- Simplicity: one scenario, ratio assertions; reuses the existing D2 metric
  as the plan-cost proxy.

## Phase 1 — the spine: slice-based planning (remove O(view) plan CPU)

Today `plan.ts:94` `view.clone()` copies ALL cells and `:98`
`planningWorldFromCells(storeCells(snapshot))` builds the world from ALL of
them, every turn → O(view). Make it O(read-set):

- Compute the turn's **seed slice** with an explicit slice builder — NOT
  a one-shot `lineageClosureKeys` (review #3: that helper is ONE-HOP,
  `cells.ts:281`; transitive lineage needs the fixed-point loop
  `scope-do.ts:949`). The builder must include, so a warm turn dispatches
  in attempt 1 with zero miss→pull rounds:
  1. **fixed-point lineage closure** of actor + session + target (loop
     `lineageClosureKeys` to convergence, per `scope-do.ts:949`);
  2. the actor/session **live + session cells**;
  3. the target's **dispatch chain**: `verb_bytecode` pages + property-def
     cells up the parent/class chain (bytecode is stored as per-object
     cells, `bridge.ts:107`), so inherited verbs/props resolve locally
     rather than as a repair round.
- **Slice-clone** for the fix-6 consistent snapshot (clone only the built
  slice's keys, not the whole store), preserving the version-laundering
  guarantee for the slice.
- Build the planning world from the **slice**, run sparse. A read the verb
  makes outside the seed is already a CO2.6 miss → `E_MISSING_STATE`
  (`translateSparsePlanningThrow`) → the existing repair loop pulls those
  keys (`refreshCells`) and retries with the enlarged slice. Warm turns
  (slice resident in the view) converge in attempt 1.
- **View residency is unchanged** — this cut targets per-turn CPU only; the
  resident mirror is a separate (memory/sharding) concern. Lower risk,
  highest leverage.
- Simplicity: the planner stops reconstructing the whole world per turn;
  it plans against what the turn touches. `readClosureCells` (`plan.ts:253`)
  already models the actual read set — reuse its shape for the seed.
- Invariant (Phase 0): `plan_cells`/warm `sync_rpc` flat as view grows.
- Tests: extend the D2 `net-turn-structure` gate to assert `plan_cells` ~
  read-set on a large-view fixture; and a **large-UNRELATED-view test**
  (many resident cells the turn never touches) that still commits in
  **attempt 1 with 0 reconstructions** (review #3) — proving both that warm
  = O(slice) not O(view) AND that the slice builder is complete enough for
  dispatch. `load:net-dev` plan invariant green.
- Risk: an incomplete seed turns a warm turn into extra miss→pull rounds
  (the attempt-1 test is the guard). The dispatch-chain + fixed-point
  lineage seed covers the common case; the bounded repair budget covers the
  tail; the load gate quantifies cold-round count.

STATUS (2026-07-08): the slice machinery is LANDED and proven for
same-scope / topology / obj-ref turns — `load:net-dev` went green
(plan_cells 1256→flat-across-view-size), and a curated unit proof lives in
`tests/net/plan.test.ts` ("slice-based planning (Phase 1 — the spine)":
slice excludes 300 unrelated objects and commits to the identical
post-state). The gateway flag `slicePlanning` is GATED OFF (commented in
`planOnce`) pending one gap: a cross-scope TRANSITION turn (session moveto
into another room) takes repair rounds under slicing that perturb the
presence-mirror high-water and drop a `session_presence` row (net-ws). The
seed must cover the transition turn's read set — the receiver-driven move
chain (`obj:moveto`/`target:acceptable`/`exitfunc`/`enterfunc`) plus the
from/to rooms' occupancy the presence derivation touches — so the turn
stays attempt-1 warm (no repair) before the flag flips on. Design realized:
keep the full consistent `view.clone()` (fix-6 intact) but build the
planning WORLD from the seed slice, growing it FROM the snapshot on a miss
(no RPC); a fixed-point obj-ref expansion seeds referenced objects' full
cells so the engine's frame-attributed property miss can't strand a ref.

## Phase 2 — presence by-scope (remove O(sessions) fanout scan)

`pushObservations` scans the whole presence table (`gateway-do.ts:1658`,
no owner predicate) then filters in JS (`:1671`).

- **Do NOT filter on the raw `owner` column** (review #1): a relation row's
  `owner` is an OBJECT id (`ws_annex`) but the fanout body carries a SCOPE
  name (`room:ws_annex`); today the scan bridges them via
  `classifier.scopeOf(row.owner)` + fallback `room:${row.owner}`
  (`gateway-do.ts:1671`), so `WHERE owner=body.scope` would miss every
  valid occupant. Instead **materialize `owner_scope` at mirror-write
  time** and filter `WHERE relation='session_presence' AND owner_scope=?`,
  index `(relation, owner_scope)`. (`owner_scope` is a new column →
  schema-before-data, Phase 5 discipline.) Computing it once at write also
  removes the per-fanout classifier walk.
- Invariant: `presence_scan_rows` ~ occupants, flat as off-room `X` grows.
- Simplicity: SQL does the filtering against a precomputed scope; the JS
  classifier loop per fanout goes away entirely.
- Tests: many off-room sessions, assert scan rows bounded; AND a fanout
  whose `body.scope` uses the `room:<object>` convention still reaches the
  room's occupants (guards the owner-id vs scope-name bridge).

## Phase 3 — bounded outbox + scheduled (remove O(backlog)/burst)

Outbox has no due/status index and no `next_attempt_at_ms`
(`scope-do.ts:369`); drain reads all pending for a route (`:1160`), retry
scans all pending (`:1280`). Scheduled has no due index (`:171`) and moves
all due rows in one alarm txn (`:632`).

- Add `next_attempt_at_ms` to `net_scope_outbox` + index `(status,
  next_attempt_at_ms)`; drain/retry via due-indexed **bounded `LIMIT`
  batches**, updating only attempted rows, re-arming if more remain.
- Scheduled: add a due-time index; process a **bounded batch** per alarm +
  immediate re-arm when more is due.
- Schema columns/indexes MUST land before any state exists (cf-do-0004
  freeze) — so this precedes deploy regardless of the throughput work.
- Invariant: `outbox_drain_rows`/pass and alarm work bounded under `B`/`D`.
- Simplicity: a stuck destination or due-burst can no longer turn every
  later request into O(backlog) work.

## Phase 4 — paged/targeted closure (remove unpaged sync copy)

Cold warming does `keys:["*"]` (`gateway-do.ts:1764`) enumerating all store
keys + relations (`scope-do.ts:779/834`) synchronously.

- Client-path warming pulls **targeted** CELL keys (leverages Phase 1's
  seed slice), not `["*"]`. Reserve full-closure cell copy for
  repair/maintenance with byte/page budgets + continuations.
- **Preserve CO13 roster backfill** (review #2): `selfSubscribe` relies on
  the FULL pull today precisely because full closure carries the scope's
  standing relation rows — the pull is what back-fills peer presence after
  subscribe (`gateway-do.ts:1707`), and the scope emits relation rows only
  on a full closure (`scope-do.ts:976`, `wantAll`). Dropping the `["*"]`
  pull would silently starve the mirror of the roster. So the targeted
  warming MUST still backfill relations: add a **relation-only backfill
  after subscribe** (or a targeted closure mode that carries the scope's
  relation pages, paged, without copying all cells). Targeting applies to
  CELLS; the scope's relation rows still backfill on subscribe.
- Invariant: `closure_bytes`/`closure_pages` bounded on cold open.
- Simplicity: first-touch cost tracks what the session needs, not scope
  size.
- Test: a session subscribing AFTER peers are present still sees the roster
  under targeted (non-`["*"]`) warming.

## Phase 5 — durable-format & contract stamps (Register B; before-data track)

Cheap, independent, and **must all be in before any namespace holds data**
(cf-do-0004 / no migration path). Runs in PARALLEL with Phases 1–4; gate is
"all present before deploy," not a strict order slot.

- **`schema_version`** row in `net_scope_meta` + a new `net_gateway_meta`
  at construction (`v:1`). One branch point for all future durable
  evolution; doubles as the migration ledger. Simpler than probe-based
  bespoke migrations.
- **Consume `catalog_epoch` from `/net/head`** (`gateway-do.ts:513/779`
  currently discard it) → fail-fast/reseed instead of a plan→submit→reseed
  budget grind to `E_BUDGET`. Decide reseed-vs-refuse for the hydration
  hard-throw (`scope.ts:203`) now, while the epoch is uniform.
- **Freeze the v1 contract**: the `.v1` `kind` tags are decorative (no
  receiver checks them) so evolution is additive-field only; pin the
  `/net-api` + WS field names (add-only, never rename) with a test, and add
  a **golden-hash test** over `canonicalJson`/`cellVersion` of
  representative cell values (serialization drift → world-wide `E_BUDGET`
  read-mismatch storm on a rolling deploy).
- **Forbid no-expiry session cells** at mint (assert `expiresAt`) — the
  reaper arms only on expiry (`scope-do.ts:807`) and there is no external
  GC.

## Phase 6 — shard-enablement (scale = routing change, not migration)

- **Stamp a resolvable shard hint into the session id at mint** (Register A
  last bullet). This must ship in the FIRST deploy so live sessions are
  routable after a future shard — session ids otherwise carry no lineage
  and cannot be re-sharded.
- **Delimiter-safe encoding** (review #4): session ids are `s_${hex}`
  (`gateway-do.ts:1279`) and cell keys are colon-delimited with
  `objectOfCellKey` assuming object ids never contain `:` (`cells.ts:51`,
  `gateway-do.ts:284`). The hint MUST forbid `:` — e.g.
  `s_${shard}_${hex}` with `_` separators (or a fixed-width shard prefix)
  so `sessionCellKey`/`objectOfCellKey` parsing is unaffected. Add tests
  around `sessionCellKey`, `objectOfCellKey`, WS tickets, and
  `/net-api/turn` with a hinted session id.
- Multi-shard `/net-api` routing keyed on the hint — enabled by Phase 1
  (the gateway no longer needs the world resident). May land after the
  first deploy; the hint may not.
- Invariant: adding a shard requires no data migration (hint resolves the
  session's cluster).

---

## Cross-cutting gate (every phase)

1. Flip/keep its `load:net-dev` invariant green.
2. Keep the correctness gates green: `npm test` (748), `test:worker`,
   `smoke:net-dev` 24/24, `e2e:net` 2/2, typecheck.
3. Hold or REDUCE complexity — prefer deletion; the scalable shape should be
   the smaller one. Update the spec (coherence.md CO10/CO12) where behavior
   changes.

## Dependencies & order

- **Phase 0** first (measuring stick).
- **Phase 1** next (the spine; unblocks 4 and 6).
- **Phases 2, 3, 5** are largely independent and interleave with 1.
- **Phase 4** after 1. **Phase 6** hint anytime; routing after 1.
- Schema-adding parts of **2 (`owner_scope`), 3, 5, 6** must precede any
  live data (cf-do-0004 freeze).

First-deploy ready-to-scale = Phases 0–5 green + Phase 6 hint stamped.
