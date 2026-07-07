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
4. CO14 sessions (mint + authorize + transition folding) — DONE
   (branch net-phase35). A session is a cell whose value is the bridge's
   SerializedSession row (ONE shape; task vocabulary expires_at/
   created_at/scope = expiresAt/started/activeScope). Session cells are
   a net-only transcript-cell kind widened at the bridge
   (src/net/transcript.ts) — v2's RecordedCell and its exhaustive
   switches stay frozen; only mintSessionSubmit and the plan.ts fold
   produce them, and engine-kind write collapsing still delegates to
   v2's finalWritesByCell byte-identically. src/net/sessions.ts carries
   the library (mint / validate / authorizeSessionSubmit); NetScopeDO
   wires authorize with ownership = holds-the-cell minus rider residue.
   plan.ts folds BOTH the session read (every submit that names a
   session carries a validatable read — CO14's read-closure rule made
   real) and the transition write (prior row + activeScope, before
   scope selection so routing sees it); session cells classify by the
   calling actor everywhere (route/attest/riders/refresh — the
   partitionCells rule). Gateway /net/session-open mints via a DIRECT
   submit (no phantom verb) with a stale_head-only retry and installs
   the cell. Sequenced turns must name a session; direct-route
   tooling turns stay session-less until Phase-4 transports.
   Two engine seams found and documented (spec CO14 caveat):
   (a) hydrateSession coerces a null/unknown activeScope to the actor's
   current location, so transitions only record when the turn moves the
   session to a DIFFERENT scope — the lane's session turn enters a
   second room (annex) for exactly this reason; (b) presence prop
   writes (subscribers/session_subscribers) ride the transcript as
   projection writes, so a pure session-entry turn's only AUTHORITY
   write is the folded session cell and route.ts retargets it to the
   actor's cluster (CA3 pure session movement) with the presence deltas
   delivered to the rooms via /net/relate. Lane: session-open →
   sequenced fold turn → GET /net/relation session_presence roster at
   the annex — 12/12. Fanout-audience-from-presence wiring stays with
   Phase 4 (spec CO13 note updated).
5. CO16 scheduled execution — DONE (branch net-phase35); closes CO2.8.
   Subscribers carry a role (fanout | planner; PK (destination, role),
   legacy destination-only tables recreate-migrated in place with
   existing rows as fanout). At alarm time the scope moves each due
   turn ATOMICALLY from the scheduled row family to a durable
   /plan-scheduled outbox row in one transaction (row ids keyed by a
   durable dispatch counter — scheduled dispatch never advances the
   head), addressed to the lexicographically FIRST planner-role
   subscriber; failover is the outbox lane's retry/backoff/abandon
   policy, no election. The planner gateway (POST /net/plan-scheduled)
   runs the NORMAL turn machinery under the stable
   sched:<id>:<at_logical_time> idempotency key — at-least-once
   delivery + the committing scope's reply cache = fired exactly once;
   a 200 (accepted or terminal-rejected) deletes the sender's row. Cold
   planner views pull-on-miss (sending scope, catalog closure, the call
   actor's cluster — each only when no high-water exists); scheduled
   turns run SESSION-LESS as actor-authority direct-route turns per
   CO14's sessions-absent rule (until VTN18.2's authority field). No
   planner → parked + the named net_scope_scheduled_turn_fired metric;
   a late planner subscription arms an immediate wake. Tests:
   tests/worker/net-scheduled.test.ts (7 — atomic move, parked state,
   late-planner wake, crash-window survival, legacy-table migration,
   deterministic pick, and the end-to-end planner suite with redelivery
   idempotency + cold-view convergence). Lane: the workerd smoke's
   metric-only scheduled step became the full path — planner subscribe,
   schedule the bump fixture ~2s out, poll the room's counter cell for
   the committed effect — 12/12.

**Phase 3.5 COMPLETE.** All five items landed on branch net-phase35:
(1) CO2.3 rider attestation + owner-sequenced adoption, (2) CO15
derived topology (partitionCells + catalog scope), (3) CO13 relations +
/net/relate, (4) CO14 session cells (mint + authorize + transition
folding), (5) CO16 scheduled-turn execution.

Each landed spec-first, then code, with lane coverage extended to a
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

Additional evidence recorded during CO14 (2026-07-07): four full-suite
runs (npm test x3, test:worker x1) each failed 3-5 heavy v2 files with a
DISJOINT set every run (scope-executor-garden-probe, object-host-write-
through, b-i-read-closure-parity, dev-v2-durable-turn-parity, mcp-warm-
authority, shadow-browser-node, cf-local-structural, cf-repository,
rpc-fault-inject, v2-browser-worker.integration across the four runs);
every failure is timeout-shaped (60s test timeouts, internal 5s RPC
timeouts, one assertion that is a timeout-message artifact), every file
passes in isolation, and one test:worker run on a quiet machine passed
all 26 files/330 tests. Zero imports from src/net in any failing file
(verified by grep). The proportionate-budget-bump recommendation above
stands and is now overdue — still its own commit, not this one.
