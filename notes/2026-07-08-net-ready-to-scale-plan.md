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
  `reconstructions`; ADD: `plan_cells` = cells fed to the planning world,
  `presence_scan_rows` per fanout, `closure_bytes`/`closure_pages`,
  `outbox_drain_rows` per pass).
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

- Compute the turn's **seed slice**: actor + session + target + their
  `lineageClosureKeys` (`cells.ts:281`) — the statically-knowable reads.
- **Slice-clone** for the fix-6 consistent snapshot (clone only seed keys,
  not the whole store), preserving the version-laundering guarantee for the
  slice.
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
  read-set on a large-view fixture; `load:net-dev` plan invariant green.
- Risk: cold turns may take extra miss→pull rounds. Mitigate with a
  complete seed (actor/session/target/lineage covers the common case) and
  the bounded repair budget; the load gate quantifies cold-round count.

## Phase 2 — presence by-scope (remove O(sessions) fanout scan)

`pushObservations` scans the whole presence table (`gateway-do.ts:1658`,
no owner predicate) then filters in JS (`:1671`).

- Push the filter into SQL: `WHERE relation='session_presence' AND
  owner=?`, add index `(relation, owner)` on `net_gateway_relation` (the
  `owner` column already exists, `:381`).
- Invariant: `presence_scan_rows` ~ occupants, flat as off-room `X` grows.
- Simplicity: SQL does the filtering; the JS classifier loop shrinks to the
  room's own rows. Small, independent, high value.
- Test: many off-room sessions; assert scan rows bounded.

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

- Client-path warming pulls **targeted** keys (leverages Phase 1's seed
  slice), not `["*"]`. Reserve full closure for repair/maintenance with
  byte/page budgets + continuations.
- Invariant: `closure_bytes`/`closure_pages` bounded on cold open.
- Simplicity: first-touch cost tracks what the session needs, not scope
  size.

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
- Schema-adding parts of **3, 5, 6** must precede any live data.

First-deploy ready-to-scale = Phases 0–5 green + Phase 6 hint stamped.
