# Net pre-deploy risk register — ready-to-scale is the deploy bar

Date: 2026-07-07 (reframed 2026-07-08). Branch `net-predeploy`. Inputs: an
external scale/asymptotic review (6 findings) + three grounded
investigations (durable schema, wire contracts, topology/cutover). All
claims spot-verified against code; DDL confirmed.

## Frame: the first new deploy must be architecturally ready-to-scale

Not "deploy small, measure, scale later." That earlier gate/sequencing
framing is wrong for two reasons:

1. **The rebuild exists to shed O(world).** Plan 002 is the *simplest-
   system* rebuild whose whole point was escaping v2's per-turn world-
   assembly. A first deploy that still clones the entire gateway view per
   turn and scans every session per fanout re-baptizes the exact debt we
   are replacing — under a fresh namespace we then cannot cleanly migrate
   off.
2. **"Scale later" has no path.** The findings below show topology and
   schema **freeze the moment the namespace holds state**: DO classes and
   table shapes lock under `cf-do-0004`; session ids carry no lineage
   (CO14) so live sessions cannot be re-sharded; there is no cross-DO data
   migration and no `schema_version` to branch on. Small-world assumptions
   baked in at deploy are not deferred debt — they are permanent until a
   from-scratch cutover.

So one discipline, applied aggressively **at every stage**, two moves:

- **(A) Remove small-world assumptions.** Any cost that scales with view
  size, total session count, outbox backlog, or closure size — rather than
  with the turn's actual work — is a defect to fix *before* deploy, not a
  number to measure after.
- **(B) Orient toward simplicity.** Here the scalable shape is almost
  always the *simpler* one: a turn that plans against its read-closure is
  simpler than one that reconstructs the whole world; an indexed by-scope
  query is simpler than a whole-table scan plus JS filter; a version stamp
  is simpler than probe-based bespoke migrations and a hard-throw epoch.
  Scale and simplicity point the same way. Where they seem to diverge,
  take the simpler design and make it scale.

(A) and (B) are the same direction. This section replaces the earlier
"three gates / measure-then-scale" sequencing.

## The one assumption to remove: the monolithic warm image

Most findings are one architectural fact with several faces: **the single
`/net-api` gateway shard depends on a monolithic warm image, and planning
is not slice-based.**

- `/net-api/*` → one stable DO (`index.ts` `NET_API_GATEWAY_SHARD="net-api"`);
  session mint and turn must land on the same DO (session ids carry no
  lineage), so it cannot shard without a session→cluster story.
- `ensureView()` hydrates every known cell into memory; then EVERY plan
  does `view.clone()` (`plan.ts:94`, copies all cells) and rebuilds a full
  serialized planning world from all of them (`plan.ts:98` →
  `bridge.ts:276` `storeCells` iterates all keys). A warm turn is
  **O(view), not O(read-set)** — contradicting coherence.md:356.
- Fanout scans the whole mirrored presence table (`gateway-do.ts:1658`,
  `WHERE relation='session_presence'`, no owner predicate) and classifies
  each row in JS (`:1671`): **O(all mirrored sessions)**, not O(room
  occupants) — and on one shard that is the whole deployment.

Removing it — slice-based planning so the gateway never needs the world
resident — is simultaneously the scale fix and the simplification, and it
is the precondition for sharding. Everything in "assumptions to remove"
below is a face of it.

## Register (A): small-world assumptions to remove

Cost that scales with the wrong thing. Each line: the assumption, then the
simpler ready-to-scale shape.

- **O(view) warm planning** — `plan.ts:94`/`:98`, `bridge.ts:276`. Plan
  against the turn's read-closure (actor/session/target/lineage), not the
  whole view. Simpler: no full-world reconstruction per turn.
- **O(sessions) presence scan** — `gateway-do.ts:1658`. Query by scope; the
  `owner` column already exists on `net_gateway_relation`, so add
  `AND owner=?` / index `(relation, owner)`. Simpler: SQL does the filter,
  not a JS classifier loop.
- **Unpaged synchronous full closure** — `keys:["*"]` reseed enumerates all
  store keys + relations (`scope-do.ts:779/834`) on cold open/first turn.
  Targeted + paged client-path warming; reserve full closure for repair
  with byte/page budgets and continuations.
- **Outbox drain O(backlog)** — `net_scope_outbox` has `PRIMARY KEY(route,
  id)` and no due-time/status index and no `next_attempt_at_ms`
  (`scope-do.ts:369`); drain reads all pending for a route (`:1160`), retry
  scans all pending (`:1280`). A stuck destination turns every later
  request/alarm into O(backlog). Add `next_attempt_at_ms`, due-indexed
  bounded `LIMIT` batches, update only rows attempted.
- **Scheduled burst** — `net_scope_scheduled(id, body)` with no due index
  (`scope-do.ts:171`); all due rows move to outbox in one alarm txn
  (`:632`). Due-indexed bounded batch + immediate re-arm when more remains.
- **Single monolithic shard** — downstream of slice-based planning: shard
  `/net-api` once the gateway no longer holds the world. Needs a
  session→cluster resolution (stamp a resolvable shard hint into the
  session id at mint).

## Register (B): simplicity / honesty debts to remove (no "later")

Hidden complexity or claims that break once state is live.

- **No `schema_version` / migration ledger anywhere** in `src/net`/
  `src/worker/net`; authority tables (`net_scope_*`) are not rebuildable
  and store bare JSON with no envelope. Stamp `v:1` in `net_scope_meta` +
  a new `net_gateway_meta` at construction. Simpler and honest: one branch
  point instead of probe-based bespoke migrations (e.g. the
  `net_scope_subscribers` PK-rebuild idiom).
- **`catalog_epoch` hard-throw hydration** (`scope.ts:203`, "refuse until
  that path exists") + **`/net/head` discards the epoch it already
  returns** (`gateway-do.ts:513/779`). Consume the epoch from `/net/head`
  to fail fast / reseed instead of grinding a plan→submit→reseed budget to
  terminal `E_BUDGET`; decide reseed-vs-refuse before any state exists.
  Rule: never bump epoch + change cell shapes in one deploy without an
  ordered scope walk.
- **Decorative `.v1` kind tags** — no receiver checks them (grep confirms),
  so evolution MUST be additive-field, never a version-gate. Coherence
  correctness is `cellVersion = hash(canonicalJson(value))` equality across
  two independently-versioned CO5 copies; a serialization change to any
  cell value silently breaks read-version equality → non-converging
  `read_version_mismatch` → terminal `E_BUDGET` world-wide for the skew
  window. Add a golden-hash test over `canonicalJson`/`cellVersion` and
  freeze the `/net-api` + WS field names (add-only, never rename).
- **No-expiry session cells never reaped** — the reaper arms only on
  `expiresAt` (`scope-do.ts:807`), and there is no external GC. Forbid
  no-expiry session cells at mint (assert `expiresAt` present).

## Ready-to-scale acceptance bar

What proves the small-world assumptions are actually gone: a net load gate
(`load:net-dev`) asserting **asymptotic invariants** — not production SLOs —
*before* deploy. There is none today; `load:cf-dev` is v2-oriented.
Invariants to gate on:

- plan cost ~ turn read-set, **independent of view size**;
- fanout scan rows ~ room occupants, **independent of total sessions**;
- closure bytes/pages **bounded** on cold open;
- outbox drain rows **bounded** under backlog.

These are the deploy bar. The deploy ships when the invariants hold — not
when a small seeded world happens to be fast.

## Separate axis: cutover mechanics (not small-world assumptions)

Real pre-deploy items, orthogonal to (A)/(B), kept here so they are not
lost:

- **Irreversible cutover** — once the route flips and users write, rollback
  discards all net-namespace writes (no delta-replay, by design). Keep the
  write-freeze total and the bake window short.
- **Frozen DO class identities** under `cf-do-0004` — treat class names and
  `net_scope_*`/`net_gateway_*` table shapes as final before the namespace
  holds data (which is *why* the register-(B) schema stamps and register-(A)
  indexes must land first).
- **Partial identity import** — well-guarded by abort-on-dangling; add a
  count reconciliation vs live `$system.api_keys` cardinality so nothing is
  silently excluded from the reachable-graph walk.
- **SqliteHost dropped** — `host.ts:13` advertises a durable local-SQLite
  net mode that has no implementation. Either implement it against the
  existing seam or strike the claim before it becomes a support commitment.

Nothing here reopens the v2 freeze. This IS the simplest-system direction —
carried through into the first deploy instead of deferred past it.
