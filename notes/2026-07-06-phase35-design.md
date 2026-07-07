# Phase 3.5 design — the four coherence.md sections + CO2.3 amendment

Date: 2026-07-06. Status: drafted after the Phase-3 hardening pass
(fixes 1-8 landed, workerd lane 8/8); the normative versions of these
sections live in spec/protocol/coherence.md (CO13-CO16 + the CO2.3
amendment) — this note carries the rationale and sequencing. Design
inputs: notes/2026-07-06-rider-read-integrity.md and the three-review
verdict of 2026-07-06 (owner + two agent passes).

## A. CO2.3 amendment — rider integrity (ride-along with proof)

Per notes/2026-07-06-rider-read-integrity.md, options A+B composed:

1. **Attestation at plan time.** When a planned turn reads rider
   (foreign-anchored) cells, the gateway fetches an attestation from each
   owner scope during planning: `{cells: [{key, version}], owner_head,
   attested_at}` via `POST /net/attest {keys}` (async, off the validation
   path). The submit carries attestations as a sibling field (like
   rider_destinations; the sequencer types stay closed).
2. **Shared-scope validation.** The committing scope validates rider
   reads against the attestation (local, sync) instead of skipping them:
   read.version must equal the attested version. No attestation for a
   rider read → reject `rider_unattested` (terminal, named). `owns` still
   scopes what the sequencer validates against its own store.
3. **Owner-sequenced adoption.** /net/adopt applies rider writes as
   owner-ordered events (never raw install): if owner's current version
   == the attested prior → clean apply. Else → **named conflict**
   (`net_adopt_conflict`), owner-wins, counted; the room's copy is marked
   derived (already in the interim guard). The residual tear (room
   post-state embeds a value the owner refused) is bounded by the
   attestation window, observable by the conflict count, and healed by
   the room's next read-version mismatch on that cell; CA10 route
   migration eliminates it later. This is stated in the spec as an
   explicit, measured limitation — not silence.

## B. CO13 — Relations and the projection applier (CO9 concretized)

**One write path per fact; relations are derived rows delivered to their
owners.**

- A relation row is `relation:<name>:<owner>:<member>` with a small JSON
  body; stored in a new scope row family (`net_scope_relation`) at the
  scope that OWNS the relation's owner object; mirrored into gateway
  views for client reads; fanned to subscribers like cells (FanoutBody
  gains `relations?: RelationDelta[]`).
- **The applier lives at the committing scope.** On accept, the scope
  derives relation deltas from the transcript: `projectionWrites`
  (contents add/remove), moves (contents of source/destination parents),
  and session-scope transitions (presence). Deltas whose owner object is
  anchored to ANOTHER scope are delivered to that owner via the durable
  outbox (`POST /net/relate`, idempotent by (from_scope, seq) like
  adopt); the owner applies them to its relation family and refans to
  its own subscribers.
- `contents(parent) = {object | live:location:object == parent}` stays
  the definitional truth (CA4); the relation rows are its materialized
  form, rebuildable by scanning live cells at the owner (the repair
  path, bounded by scope size).
- Audience for fanout observations = the `session_presence` relation
  (owner = the space, members = sessions) filtered through live
  subscriptions — replacing "every subscriber gets everything".

## C. CO14 — Session authority and auth at the net surface

- **A session is a cell** (`session:<id>`), authoritative at the ACTOR's
  cluster scope (sessions are actor-anchored). Minting is a normal
  commit at that scope (single write path).
- **Gateway authenticates, scope authorizes.** The gateway validates
  client credentials against identity cells (the `$system` api_keys map
  lives in the catalog scope closure — section D) and mints/refreshes
  the session cell via a turn. Every subsequent submit carries the
  session read in its read closure; CO4 step 1 (`authorize`) checks the
  session cell's presence/expiry/actor-binding — a cell read like any
  other, validated by the session's owner via the same rider-attestation
  machinery when the commit scope differs.
- **sessionScopeTransition folds into a session-cell write at plan time**
  (bridge translates the recorded transition into a session cell write in
  the transcript), so presence derives from committed cells (CO13
  presence relation) — the CA8 lesson carried into net, and the dropped
  Phase-2 commitment discharged.

## D. CO15 — Topology, partitioning, and catalog install

- **Anchor derivation is a pure function of lineage cells.** Lineage
  payloads already carry `anchor`. `scopeOf(object)` = walk
  lineage.anchor to its root: actor root → `cluster:<actor>`; space root
  → `room:<space>`; no anchor → the catalog scope (below). The gateway
  builds its classifier from the view's lineage cells — request-supplied
  anchors/shared retire (they remain only in the lane fixtures).
- **The catalog scope.** A distinguished scope (`catalog`) owns the
  shared substrate: `$system`, `$root`, class lineage, verb bytecode,
  identity maps. Its closure is read-mostly, replicated to every gateway
  (KV seed at install), and universally receiver-known in transfers —
  class chains never reship (the CO7 assumes_known mechanism gets its
  production population). Writes to catalog cells happen only through
  the install pipeline (a sequenced commit at `catalog` + catalog_epoch
  bump → every consumer reseeds via E_STALE_EPOCH — the aged-world lane
  is the proof).
- **Install pipeline.** `partitionCells(world)` in the bridge splits an
  exported/bootstrap world by the anchor walk: catalog cells → catalog
  scope; rooms + room-anchored → room scopes; actors + carried →
  cluster scopes. Deployment = per-partition /net/seed + KV seed writes.
  This is also the Phase-5 fresh-install path (identity import lands in
  the catalog scope).

## E. CO16 — Scheduled-turn execution

- The scope remains the durable home and the waker (CO2.8 unchanged);
  **a registered planner gateway executes**. `/net/subscribe` gains a
  `role: "fanout" | "planner"`; at alarm time the scope POSTs each due
  turn to a planner (`/net/plan-scheduled {scheduled_turn, scope}`),
  which runs the normal turn machinery with idempotency key
  `sched:<id>:<at_logical_time>` — exactly-once via the scope's reply
  cache. Delivery uses the durable outbox (at-least-once + idempotent =
  fired exactly once).
- No planner registered → the turn stays parked with a named metric
  (non-destructive peek — the hardening Fix 8a behavior becomes the
  specified no-planner state).
- Engine-side `schedules`/`cancellations` transcript fields (VTN18.2)
  remain deferred until the DSL exposes scheduling; /net/schedule is the
  substrate surface; this is stated in the spec.

## Sequencing (Phase 3.5)

1. CO2.3 amendment + /net/attest + owner-sequenced adopt — DONE
   (a2655d1, 8ba00ff).
2. CO15 topology (anchor derivation + catalog scope + partitionCells) —
   DONE (branch net-phase35). src/net/topology.ts is the pure anchor
   walk: root's parent chain reaching $actor → cluster:<root>, reaching
   $space → room:<root>; $-prefixed roots and anchorless non-actor/
   non-space roots → catalog. The gateway derives its classifier from
   VIEW lineage and routes by the `scope:<scopeName>` convention;
   request anchors/shared/scopes are demoted to lane overrides; catalog
   lineage rides receiver-known in plan envelopes (class chains never
   reship). Three scopes (room, cluster, catalog) are now the default
   proving fixture: the differential's multi-scope scenario seeds its
   sequencers from partitionCells with a topology.ts classifier, and the
   workerd lane partitions a bootstrap world into room/cluster/catalog
   DOs and drives /net/turn with NO request topology — 8/8. The
   install-pipeline KV-seeding of the catalog closure stays with the
   install work item (named TODO in topology.ts).
3. CO13 relations (applier + /net/relate + contents/presence) — DONE
   (branch net-phase35). src/net/relations.ts derives contents/presence
   deltas from accepted transcripts (one write path — the committing
   scope's applier); ScopeStore gained the sixth row family
   (net_scope_relation); local deltas apply in the accept transaction and
   ride FanoutBody.relations; foreign deltas ride the reply
   (relations_foreign) and the shell delivers durable /net/relate rows
   ((from_scope, seq) idempotent, separate high-water from /adopt). Two
   decisions the spec text was refined to state: relate application is
   OWNER-SEQUENCED (head advances once per applied batch so the refan
   rides a real seq under the subscribers' CO2.5 gate), and
   relation-owner topology ships as the gateway's relate_destinations
   submit sibling (the rider_destinations rule — the sequencer never
   learns anchors). The gateway mirrors rows into net_gateway_relation
   under the fanout seq high-water; GET /net/relation is the who/
   contents read primitive. Fanout audiences FROM presence stay with
   CO14 (sessions are not cells yet). Lane: the workerd smoke commits a
   cross-scope move at the real actor's cluster and reads the room
   roster off the gateway — 9/9. Unblocks look/who and audience.
4. CO14 sessions (mint + authorize + transition folding) — unblocks
   Phase-4 transports.
5. CO16 scheduled execution — closes CO2.8.
Each lands spec-first, then code, with lane coverage extended to a
three-scope topology (room, cluster, catalog) as the new default fixture.

## Gate-flake evidence (2026-07-07, recorded during CO15)

The heavy v2 fake-DO tests (cf-local-walkthrough cross-shard movement,
structural/budget probes) are timing-marginal under sustained machine
load: repeated A/B runs show nondeterministic 30/60s timeouts on BOTH
net-phase35 HEAD (2 fails / 5 runs of cf-local-walkthrough) AND base
f5e6acb (1 fail / 3 runs), with the failing set varying run to run and
no import path from the CO15 diff into any failing file. Same class as
the 2026-06-16 canary-timeout triage (budget vs latency, not a wedged
path). If this keeps biting local gates, the proportionate fix is a
dedicated budget bump for the fake-lane walkthrough in its own commit —
not silently, and not mixed into feature work.
