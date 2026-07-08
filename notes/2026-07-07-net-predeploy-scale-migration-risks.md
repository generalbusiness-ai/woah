# Net pre-deploy risk register — scale + migration/supportability

Date: 2026-07-07. Branch `net-predeploy`. Inputs: an external scale/
asymptotic review (6 findings) + three grounded investigations (durable
schema, wire contracts, topology/cutover). All claims spot-verified
against code; DDL confirmed.

## The spine: one root, many symptoms

Most of the scale findings are **one architectural fact** with several
faces: **the single `/net-api` gateway shard depends on a monolithic warm
image, and planning is not slice-based.** Concretely:

- `/net-api/*` → one stable DO (`index.ts` `NET_API_GATEWAY_SHARD="net-api"`);
  session mint and turn must land on the same DO (session ids carry no
  lineage, CO14), so it can't be sharded without a session→cluster story.
- `ensureView()` hydrates every known cell into memory; then EVERY plan
  does `view.clone()` (`plan.ts:94` — copies all cells) and rebuilds a
  full serialized planning world from all of them (`plan.ts:98` →
  `bridge.ts:276` `storeCells` iterates all keys). A warm turn is
  **O(gateway-view), not O(read-set)** — directly contradicting
  coherence.md:356 (no O(world)).
- Fanout presence delivery scans the whole mirrored presence table
  (`gateway-do.ts:1658` `WHERE relation='session_presence'`, no owner
  predicate) and classifies each row in JS (`:1671`). One room message is
  **O(all mirrored sessions)**, not O(room occupants) — and on one shard,
  "all mirrored sessions" = the whole deployment.

Directional fix (the pre-cutover spine): make planning slice-based
(actor/session/target/lineage/read-closure only), so the gateway stops
needing the whole world resident; THEN shard `/net-api`. Everything in
"Gate 2" below is downstream of this.

## Three gates, not one

The staging deploy is **measurement-only, single-shard, fresh namespace,
small seeded world** (plan §8). That reframes the reviewer's "Blocker":
the O(world) costs are not blockers for a *small-world measurement*
deploy — that deploy is the instrument to quantify them. But some risks
bite regardless of scale, and some schema shapes are far cheaper to lay
down before any namespace holds live data. Hence three gates.

---

### GATE 0 — bake in NOW (cheap today, needs a cross-DO data migration later)

There is **no `schema_version` column, no version envelope, and no
`applied_migrations` ledger anywhere in `src/net`/`src/worker/net`** — and
DO class table shapes freeze under `cf-do-0004` the moment the namespace
holds state (no cross-DO data-migration tool exists; only per-DO recreate
idioms like the `net_scope_subscribers` PK rebuild). So every one of these
is ~minutes now and a per-DO-recreate-under-load (or impossible) later:

1. **Stamp `schema_version`** in `net_scope_meta` and a new
   `net_gateway_meta` at construction (`v:1`). One row each. Opens the door
   for ALL future durable evolution and doubles as the migration ledger.
   Today an incompatible shape change to `net_scope_*` (authority, not
   rebuildable) has no branch point and no rebuild.
2. **Decide the `catalog_epoch` policy** before data exists. Today a store
   epoch mismatch is a **hard throw** on hydration (`scope.ts:203-207`,
   "refuse until that path exists") and a live mismatch is terminal
   `E_EPOCH_MISMATCH` with no walk-forward wired (M6 spec-version migration
   deferred). First deploy is uniform so it can't bite yet — but decide
   refuse-vs-reseed now, and adopt the rule: never bump epoch + change cell
   shapes in one deploy without an ordered scope walk.
3. **Consume the `catalog_epoch` already returned by `/net/head`**
   (`gateway-do.ts` discards it at :513/:779/etc.). One-line change: turns a
   future epoch-skew from a per-turn plan→submit→reseed budget-grind into an
   immediate fail-fast/reseed signal. Highest-leverage code hedge for the
   second deploy, free to land now.
4. **Presence query by scope.** The `owner` column already exists on
   `net_gateway_relation`; push the room filter into SQL (add
   `AND owner = ?` / index `(relation, owner)`) so `pushObservations` stops
   being whole-table. Few lines, removes the fanout cliff without any
   topology change, and fixes the query shape before data.
5. **Outbox + scheduled due-time schema.** Add `next_attempt_at_ms` +
   indexed due queries to `net_scope_outbox` and a due-time index to
   `net_scope_scheduled` NOW (columns/indexes are frozen by cf-do-0004
   once live). The bounded-batch *logic* (Gate 1) can follow; the *columns*
   should exist before data.
6. **Freeze the v1 wire/field-name contract + golden-hash test.** No
   receiver checks the `.v1` `kind` tags (they're decorative) — evolution
   MUST be additive-field, never a version-gate, and coherence correctness
   is `cellVersion = hash(canonicalJson(value))` equality across two
   independently-versioned CO5 copies. A serialization change to any cell
   value silently breaks read-version equality → non-converging
   `read_version_mismatch` → terminal `E_BUDGET`, world-wide, for the skew
   window. Cheap hedge: a golden-hash test over `canonicalJson`/
   `cellVersion` of representative cell values, and pin the `/net-api` + WS
   field names (add-only, never rename).
7. **Forbid no-expiry session cells at mint.** The reaper arms only on
   `expiresAt` (`scope-do.ts:807-808` skips no-expiry); a no-expiry session
   cell + its presence rows is never reaped and there is no external GC.
   `/net-api` already clamps TTL, so assert `expiresAt` present on every
   session cell to close the hole the internal seed path leaves open.
8. **(Optional) shard hint in the session id** at mint, unused today, so a
   future re-shard has a lineage to route on instead of a data migration.

---

### GATE 1 — can bite the MEASUREMENT deploy itself (not scale-gated)

Amplifiers under outage/backlog/burst, and correctness holes — a small
world can still hit these:

- **Outbox drain O(backlog) under a stuck destination** (scale #3). Drain
  reads all pending for a route, retry scans all pending
  (`scope-do.ts:1160/1280`, no index). A blocked planner/gateway turns
  every later request/alarm into O(backlog) CPU. Needs bounded `LIMIT`
  batches + due-indexed queries (schema from Gate 0.5) + a kill-switch.
- **Scheduled burst in one alarm txn** (scale #5). All due rows moved to
  outbox in one alarm (`scope-do.ts:632`); a due-burst can exceed one DO
  turn budget. Needs bounded batch + immediate re-arm when more remains.
- **Reaping holes** (topology #4): no-expiry sessions (Gate 0.7 closes it)
  and abandoned foreign-presence removes (inert residue, documented).
- **Cell-value hash drift** (wire R1) only bites on a *rolling* (second)
  deploy, not the first uniform one — but the golden-hash test (Gate 0.6)
  is the cheap pre-emptive guard.

---

### GATE 2 — blocks SCALING TRAFFIC & the production CUTOVER (the measurement deploy exists to quantify these)

NOT blockers for a small-world measurement deploy; must be instrumented by
it and resolved before real-size traffic/cutover:

- **O(view) warm planning** (scale #1) — the headline debt. Real, confirmed
  (`plan.ts:94/98`), contradicts coherence.md:356. Small on a small world;
  quantify the view-size→latency slope at staging. Fix = slice-based
  planning before scaling. This is the O(world) regression the whole
  rebuild was meant to erase and hasn't yet.
- **O(sessions) presence scan** (scale #2 / topology #1) — quantify at
  staging; Gate 0.4 is the cheap partial hedge.
- **Unpaged synchronous full closure** on cold open/first turn (scale #4):
  `keys:["*"]` reseed enumerates all store keys + relations. Quantify;
  page/target the client-warming path later, reserve full closure for
  repair with byte/page budgets.
- **Single shard, no online re-shard for LIVE sessions** (topology #1):
  session ids carry no lineage, so a new shard can't resolve an existing
  session's cell. Only drain-by-TTL works. Downstream of the spine.
- **Irreversible cutover** (topology #2): once the route flips and users
  write, rollback discards all net-namespace writes (no delta-replay, by
  design). Accepted/documented; keep the write-freeze total and the bake
  window short.
- **Frozen DO class identities** (topology #3), **SqliteHost dropped /
  doc-false** for non-CF self-hosting (topology #5), **partial identity
  import** (topology #6, well-guarded by abort-on-dangling).

---

### GATE 3 — the meta-gap: no net load gate (scale #6)

There is **no net-specific asymptotic/load gate**; `load:cf-dev` is
v2-oriented. Before the measurement deploy's numbers can be *trusted or
gated on*, add `load:net-dev`: vary rooms / sessions / off-room presence /
cold gateway open / outbox backlog / scheduled burst, and assert
**asymptotic invariants first** (plan cost ~ read-set not view; fanout scan
rows ~ room occupants not total sessions; closure bytes bounded; outbox
drain rows bounded) — not production SLOs. This arguably PRECEDES the
measurement deploy: it gives the deploy invariants to check against, and
several invariants (presence scan bounded, plan slice bounded) are exactly
the Gate-2 items the deploy is meant to characterize.

## Recommended sequencing

1. **Gate 0** (bake-in-now, cheap, before any namespace holds data) — do
   these on `net-predeploy` before the staging deploy.
2. **Gate 3** `load:net-dev` with asymptotic invariants — before or
   alongside the measurement deploy, so its numbers mean something.
3. **Measurement staging deploy** — small world, instrumented; quantify the
   Gate-2 slopes (view size, presence scan, closure bytes) and confirm Gate
   1 amplifiers don't wedge.
4. **Gate 1** bounded batches/kill-switches — before any deploy that could
   see a stuck destination or a due-burst (arguably before staging).
5. **Gate 2** slice-based planning → then shard — the pre-cutover project;
   the measurement deploy sizes it.

Nothing here re-opens the v2 freeze. Gate 0 + Gate 3 are the
option-preserving, cheap-now work; the reviewer's "Blocker" (#1) is a
cutover/scale blocker the measurement deploy is designed to measure, not a
blocker for that deploy — provided it stays small-world and instrumented.
