---
status: draft
---

# Cell authority, movement projection, and authority migration

This document specifies how durable state authority is located in the v2 node
network: which node may accept a write to a given cell, how movement is
represented so that hundreds of independent actors can move against overlapping
objects without a shared serialization point, and how authority for genuinely
shared cells may migrate toward activity.

It is **draft**, but it is intended to constrain the prototype rebuild. The
validation and routing rules here should not change casually once implemented.

## CA1. Scope and relationship to other sections

This section is the normative home for first-class cell authority. It builds on
and, in one place, supersedes earlier draft text:

- **Supersedes VTN8.1 (movement as a placement transaction).** The MV-A
  "combined/fenced placement transaction" and the synthetic `#placement` commit
  scope are withdrawn. Movement under this section commits exactly one
  authoritative cell (CA3) and never routes through a placement owner. VTN8.1
  remains in the document only as a record of the withdrawn approach and MUST
  NOT be implemented.
- **Builds on VTN10.1 (object-lookup misses are materialization misses).**
  Movement still discovers transitive read state (exits, destinations) through
  guarded materialization repair.
- **Builds on VTN12 (state plane) and VTN13 (live plane).** Movement delivery
  uses the session/audience table, not a globally consistent current-location
  read.

The governing rules of this section are:

```text
Location is truth.  Contents are projection.  Rooms observe.
Views gossip.  Route records decide.  Owners commit.
```

## CA2. Two kinds of cell

Every durable datum is exactly one of:

- an **authoritative cell** — has exactly one active write authority; or
- a **projection cell** — a read model derived from one or more authoritative
  cells or accepted events, owned for convenience by a consumer, never the truth.

```ts
type AuthoritativeCellKey =
  | `lineage:${ObjRef}`
  | `live:location:${ObjRef}`
  | `prop:${ObjRef}.${string}`
  | `verb:${ObjRef}.${string}`;

type ProjectionCellKey =
  | `projection:contents:${ObjRef}/${ObjRef}`    // room / member
  | `projection:presence:${ObjRef}/${string}/${string}`; // container / projection / member key
```

An implementation MUST be able to tell, for any cell it reads, transfers, or
commits, which of the two kinds it is. A projection cell MUST NOT be used as a
write-authority source, and an authoritative cell MUST NOT be silently
overwritten from a projection or a partial view.

`live:contents:<room>` as a single mutable list cell is **retired**. A
compatibility adapter MAY expose `contents(room)` as an ordered array, but it
MUST assemble that array from projection rows and MUST carry provenance marking
it a projection (CA11).

## CA3. The movement invariant

`live:location:<object>` is the single source of truth for physical placement.

A move commits **exactly one** authoritative write:

```text
live:location:<object> : old_parent -> new_parent
```

The write authority for that cell is the **moved object's own home** sequencer —
not a room, not a placement shard. This has three consequences the
implementation MUST preserve:

1. **Movement is naturally distributed.** Each object/actor has its own home, so
   N actors moving produce N independent single-owner commits. There is no owner
   that serializes movement across unrelated objects.

2. **Contention resolves at the contested object.** Two actors that both attempt
   `take(sword)` both write `live:location:sword` at the sword's home; that home
   serializes them, one commit wins on the location version, the other receives
   a retryable stale-head/`E_STALE_AUTHORITY`. The thing being fought over is the
   consistency point — which is correct. The model relocates contention to the
   natural boundary; it does not remove it.

3. **Moving a container is O(1).** Location is parent-relative. Moving a bag
   rewrites only `live:location:<bag>`; objects whose location is the bag keep
   their location and move transitively. An implementation MUST NOT rewrite the
   location cells of contained objects when their container moves.

The move's authority owner MAY change only through the general migration
protocol (CA10); ordinary movement of an object between parents does **not**
migrate the object's location authority — that authority follows the object.

CA3 is the `relocation` case of the **general write-set-derived commit-scope
selection** ([v2-turn-network.md §VTN8.2](v2-turn-network.md#vtn82-commit-scope-chosen-by-the-turns-write-set)).
A pure single-object move (the write set is only that object's `location` cells)
commits at the object's own scope, off the room sequencer. A turn that also
writes a room-owned cell commits at the planning scope, which serializes that
shared cell; the actor-location write rides along atomically. Conformance CA14.3
(two actors entering one room both retain membership) is exercised concurrently
by the `gate:authority` walkthrough's B6 step.

## CA4. Contents as a per-member projection

Room (and container) contents are derived:

```text
contents(parent) = { object | live:location:<object> == parent }
```

For efficiency, contents are materialized as projection rows keyed by member:

```text
projection:contents:<parent>/<member>   <- derived from live:location:<member>
```

Because each row is keyed by the member and derived from that member's own
authoritative location cell, **concurrent placement changes touch disjoint
projection keys**. There is no shared mutable list, so the lost-update race that
motivated MV-A cannot occur.

Projection maintenance rules (all MUST):

- **Durable owner delivery.** A movement commit's source and destination
  container owners MUST receive enough of the accepted movement event to update
  their contents projections, even when the committing scope emits no full
  projection row for that foreign container. A projection-write-through path
  that partitions only by emitted row owner MUST therefore add the move's
  source/destination container owners to the durable fanout and let each owner
  rebuild its own membership row from the accepted move. Non-owner hosts may
  cache such rows, but MUST NOT persist ownership of a container they merely
  cache.
- **Idempotent application.** Applying the same accepted movement event twice
  MUST NOT create duplicate membership. Application is keyed by movement event id
  or by the member's `live:location` source version.
- **Monotonic by source version.** An out-of-order or replayed older movement
  event MUST NOT roll a member's projection state behind a newer source location
  version already observed for that member.
- **Cold ≠ empty.** A brand-new parent legitimately has no members. But a parent
  whose projection store is absent or known-incomplete MUST repair or fetch
  authoritative projection state, or report an explicit degraded/loading state.
  It MUST NOT synthesize `[]` and render "present: nobody" from a cache miss.

The projection is a read model for `look`, `who`, parser resolution among
visible objects, audience calculation when fresh enough, and compatibility
`contents()` readers. It is never an authority over any member's location.

Compatibility property cells that expose membership/presence projections MUST
declare that role in property metadata, not by reserved property name. The
declaration identifies the projection key:

```ts
type PresenceProjectionDef =
  | { kind: "presence"; key: "actor" }
  | { kind: "presence"; key: "session"; sessionField: string; actorField: string };
```

Core validation may use this declaration to reconcile a same-turn movement
against the projected read, but it MUST NOT hardcode catalog property names such
as `subscribers` or a fixed row shape. Catalogs own the property names and, for
session-keyed projections, the row field names. A property with list-shaped
values but no declaration remains an ordinary order-sensitive property cell.

> **Open question (CA15-a):** rebuilding a parent's contents projection after
> projection-store loss, for inert (sessionless) members, without global
> enumeration. `contents` is a reverse index; there is no scan. See CA15.

## CA5. Movement commit protocol

1. The executor plans the verb against cached executable state.
2. Transitive read state (`exit.dest`, destination acceptability, source state)
   is repaired through VTN10.1 guarded materialization.
3. The executor submits the turn transcript/proposal to the authority for
   `live:location:<moved object>`.
4. The location owner validates the move's **read dependencies** and the moved
   object's current location version.
5. The location owner commits the new location and emits one accepted movement
   event (CA8).
6. Source and destination projection owners apply idempotent, monotonic
   projection updates keyed by member (CA4).
7. Gateway/session routing delivers observations by audience/session table (CA8).
8. Browser/MCP holders reconcile local projections from the accepted event.

**Read-dependency validation (CA5.4) is bounded to quasi-static topology.** The
read deps of a move — exits, lineage, the destination's `acceptable` verb — are
near-static; the owner validates them by cached or route-checked read-version.
The owner MUST reject (or return retryable `E_STALE_AUTHORITY`) if a read
dependency's version advanced after planning. The owner MUST NOT attempt to
repair correctness by writing room contents. Dynamic *set-state* dependencies
(capacity, occupancy) are explicitly **not** validated here; they are only
enforceable under room-anchored movement (CA7).

## CA6. Default consistency model: actor-anchored movement

By default, a move is anchored at the moved object's home, and the resulting
`entered`/`left` events are **not** entries in any room's sequenced log. They are
externally-originated events merged into each room's observable stream by the
live plane.

Implementations and catalog authors MUST treat this as the default semantic:

- There is **no defined order** between a room-sequenced event (e.g. a `say`
  committed at the room) and a movement event originating at an actor's home.
- There is **no set-invariant enforcement** over membership: capacity,
  uniqueness, and mutual-exclusion constraints are *not* honored by the default
  model, because there is no shared serialization point for the set.

This is the deliberate scalability tradeoff that keeps the 100-overlapping-actors
case on the distributed path. Catalogs needing stronger guarantees use CA7.

## CA7. Room-anchored movement (opt-in)

A room (or other container) MAY opt a class of placement changes into being
sequenced **at that container's own sequencer**. This is the single mechanism
for both stronger guarantees:

- **Set invariants.** When arrivals are sequenced at the destination, the
  destination's sequencer is the arbiter and MAY enforce capacity, uniqueness,
  or mutual exclusion by accepting or rejecting the arrival at commit. A
  capacity-1 room sequencing arrivals admits exactly one of two racing entrants;
  the loser receives a retryable rejection.
- **Ordering.** Arrivals sequenced at the room are ordered relative to that
  room's other sequenced events (a `say` and an `entered` have a defined order).

Room-anchored movement is still the **room's own sequencer**, never a shared
placement owner — the CA-wide constraint holds. It is an explicit per-container
upgrade declared in catalog data/verb metadata, never the default, and it
applies only to the containers that declare it. Under room-anchored movement the
move's authoritative write set includes the room's arrival-log cell in addition
to `live:location:<actor>`; both commit at the room sequencer for that move.

An implementation MUST keep actor-anchored (CA6) as the default and MUST NOT
globally promote movement to room-anchored.

## CA8. Live delivery and transitive presence

Two distinct accepted-transcript effects drive distinct projections. A physical
`object_move` (the actor's `live:location` write) drives **containment**
projections (`object.contents`). A first-class **session active-scope
transition** drives **presence** projections (the session/actor subscriber lists)
and session-row materialization. For actors, materializers also use the
transition as a CA4 membership-mirror repair edge: if a sparse physical move says
`$nowhere -> new_room` while the session transition says `old_room -> new_room`,
the actor is removed from `old_room.contents` and added to `new_room.contents`.
This repairs derived contents, not `live:location` authority. Presence is keyed
by *session placement*, not physical containment, so the transition is recorded
whenever a session's active scope changes — **including a no-op physical enter**
(the actor was already in the room) — and its reliable `from`/`to` replace a
possibly-sparse move's `from`:

```ts
type SessionScopeTransition = {
  session: string;
  actor: ObjRef;
  from: ObjRef | null;
  to: ObjRef | null;
};
```

The transition is **implemented** (`TranscriptSessionScopeTransition` on the
effect transcript): recorded by the substrate on every active-scope change,
carried in the transcript hash, included in affected fanout scopes and projection
write-through, and applied by every materializer (indexed commit-scope state,
per-host object slice, in-place gateway). It is validation-exempt from CA3
object-cell write authority (routing/presence state, not an authoritative cell)
but **not** trust-exempt: it is validated structurally (it must name the turn's
session and actor, and its `from` must agree with authoritative session pre-state
where locally knowable). A move alone no longer drives presence; presence
projections are recomputed per-shard from the transition, so a peer's partial
whole-row snapshot can never clobber another shard's disjoint presence rows.

A movement commit emits a durable movement event carrying enough for both
projection owners and gateway session tables:

```ts
type MovementCommitted = {
  actor: ObjRef;
  from: ObjRef | null;
  to: ObjRef | null;
  location_cell: `live:location:${ObjRef}`;
  source_version: string;
  commit_head: ScopeHead;
  event_id: string;
};
```

- Live routing MUST use the VTN12/VTN13 session/audience table, not Directory
  `current_location` as the hot-path fanout key. The movement event is precisely
  the change that invalidates location-derived routing, so routing MUST NOT
  depend on a globally consistent current-location read at fanout time. The
  audience for a space is therefore the live sessions whose `activeScope` equals
  that space (the session table), unioned with the durable presence projection
  for back-compat — a session born in its home room with no enter turn is present
  via the session table even though no transition ever wrote its projection row.
- **Transitive presence** (a player inside a vehicle inside a room) MUST be
  resolved through the session table's cached effective-room, updated on
  movement, NOT by walking `live:location` cells across homes per delivered
  event. Movement of any object in a member's containment chain updates that
  member's effective-room entry.

Projection owners and live delivery are two consumers of the same accepted
movement event; neither is the authority for the movement write.

## CA9. Browser and MCP execution

Execution ownership and commit ownership are separate.

- The **browser** plans optimistically against cached executable state, repairs
  missing cells via VTN10.1, and submits a transcript/proposal for the actor's
  location write. The authoritative home accepts or rejects. The browser is
  **never** a durable authority owner and **never** a migration participant for
  ordinary movement; it reconciles its projections from accepted events.
- **MCP/server actors** converge on the same shape: a capable distributed
  executor near the actor/session runs the whole turn under guarded repair, and
  the authoritative location owner commits the write.
- A commit owner executing a turn directly is a **fallback** for clients with no
  capable executor. It MUST NOT become the mainstream path, and it MUST obtain
  its read closure through guarded materialization (VTN10.1) rather than
  requiring a pre-seeded scope snapshot. (The withdrawn `#placement` design
  failed precisely because it required a snapshot it never had; CA9 forbids
  reintroducing that requirement.)

## CA10. First-class authority for shared cells

Movement is special because location authority follows the object. Other
authoritative cells — a hot shared object's property, a child-collection owner,
a verb/lineage cell whose operational home should move — MAY migrate toward
activity under one explicit protocol.

Every authoritative durable cell has exactly one active authority record,
independent of value carriers and projections:

```ts
type CellAuthorityRecord = {
  cell: AuthoritativeCellKey;
  owner: ScopeRef | NodeRef;
  route_epoch: number;
  version: string;
  parent_owner?: ScopeRef | NodeRef;
  state: "active" | "moving";
  moving?: { from: ScopeRef | NodeRef; to: ScopeRef | NodeRef; token: string; lease_until_ms: number };
};
```

### CA10.1 Route epoch vs owner head — two distinct questions

The route record's CAS answers only *who owns this cell*. The owner scope's
existing head (and per-cell version) answers *which value history a write
validated against*. They MUST remain distinct and MUST NOT become competing
value-concurrency tokens:

- A value commit changes the owner head/version; it never changes `route_epoch`.
- A migration changes `route_epoch`; it never changes the value history without
  an owner install/commit proof.

A durable write MUST check both: (1) the route record is still
`active(owner, route_epoch)` for every written authoritative cell, and (2) the
owner head/per-cell version matches the planned read/write provenance.

### CA10.2 Route home shards

```text
home(authoritative_cell_key) = hash(authoritative_cell_key) mod N  (CellRouteDO shards)
```

Route homes store only authority records — not world objects, projections,
catalog bytecode, or session queues. Properties (all MUST hold):

- any node computes the home shard locally from the cell key;
- route resolution for a turn is proportional to cells touched, not world size;
- planning resolves routes cache-first (local cache → gossip hint → route-home
  read on miss/suspected-stale/migration/commit-validation);
- write validation batches route-home checks by shard and touches only written
  authoritative cells.

The migration **target** for a cell MUST be a deterministic function of the
**cell**, not of the turn that triggered migration. (A target keyed by the
triggering `(actor, source, dest)` would let a shared cell ping-pong between
targets on alternating turns and churn through the `moving` state. This is a
withdrawn earlier idea; CA10.2 forbids it.)

### CA10.3 Migration protocol (per cell, idempotent, lease-recovered)

1. **Resolve** the authoritative cells to be written, cache-first.
2. **Lock** each cell in sorted `cell_key` order via route-home CAS
   `active(A,e) -> moving(A->B, e+1, token, lease_until)`. On CAS failure,
   release/expire, reread, retry. Sorted order prevents batch deadlock.
3. **Export** from old owner `{cell,value,version,route_epoch:e,token,proof}`;
   the old owner freezes writes for that cell while `moving`.
4. **Install** at new owner iff token, prior epoch, exported version, and proof
   all match. Install is idempotent by `(cell, route_epoch, token)`.
5. **Commit route** via CAS `moving(...) -> active(B, e+1, version)`. After this,
   writes to the old owner return `E_MOVED { owner: B, route_epoch: e+1 }`.
6. **Forwarding tombstone** at the old owner, bounded, for stale-cache repair —
   not authority.
7. **Recovery:** if the lease expires before route commit, the home reverts to
   `active(A,e)`, the old owner unfreezes, and the new owner keeps any installed
   value only as an inactive cache page.

Movement (CA3–CA5) MUST NOT use this protocol for room contents. It uses the
single `live:location:<object>` write plus projections.

## CA11. Provenance and stale-authority diagnostics

Every planned, transferred, stored, and diagnostic cell carries provenance:

```ts
type CellRecord = {
  cell: AuthoritativeCellKey | ProjectionCellKey;
  owner?: ScopeRef | NodeRef;          // authoritative cells
  route_epoch?: number;                // authoritative cells
  owner_head?: ScopeHead;
  source_version?: string;             // projection cells: the source it derived from
  value_ref?: StatePageRef;
  value_inline?: WooValue;
  source: "authoritative" | "projection" | "fallback" | "cache" | "gossip";
};
```

Commit mismatch MUST be reported with explicit authority provenance rather than
an opaque version mismatch:

```text
E_STALE_AUTHORITY {
  cell, planned_owner, planned_route_epoch, planned_owner_head,
  actual_owner, actual_route_epoch, actual_owner_head, source
}
```

For projection mismatches, diagnostics MUST report the source cell and source
version, not present the projection as the truth. Provenance is the first
shippable increment (CA16) and is what makes failures legible — the withdrawn
`#placement` failure surfaced only as `E_INTERNAL "#<Object>"` for lack of it.

### CA11.1 Gateway authority checkpoints

An implementation MAY keep an in-memory per-scope authority checkpoint to avoid
reconstructing a full planning slice on every warm turn. Such a checkpoint is a
planning cache, not a new authority source. *(Implementation status: the
Cloudflare profile removed its in-memory per-scope checkpoint in A5 — measurement
showed it was not delivering warm hits and it was a second, divergent
materialization of the durable gateway projection cache, which remains the
cross-turn read model. The rules below still bind any implementation that keeps
such a checkpoint.)*

- The checkpoint MUST carry `source: "cache"` provenance and a non-null owner
  head sequence for the scope it represents.
- The checkpoint MUST NOT be stored or refreshed from a degraded slice that used
  `fallback`, `gossip`, or timeout-derived rows. Stale rows may be served for a
  single planning attempt, but they do not become the next warm checkpoint.
- Accepted same-scope projection tails MAY advance a checkpoint only when the
  accepted sequence is strictly greater than the checkpoint watermark. Older or
  duplicate tails are no-ops.
- Accepted writes from a different scope that touch any covered cell MUST
  invalidate the checkpoint unless exact per-cell route epochs prove the write
  is irrelevant. A scope-local sequence number is not meaningful for a foreign
  scope.
- A checkpoint hit MAY merge fresh volatile overlays, such as Directory session
  rows or the local session actor's live cell, into the served planning payload.
  These overlays MUST NOT be persisted back into the checkpoint.
- If a warm request reaches beyond the checkpoint's covered cells, the gateway
  SHOULD repair only the missing cell/object ids and merge them into the
  checkpoint cache. It MUST NOT fall back to a full per-turn authority slice
  merely because the checkpoint is incomplete.
- A warm request that has no existing checkpoint MAY perform one full
  authority refresh to seed the checkpoint. Health metrics MUST distinguish this
  sticky seed from repeated `warm_turn_refresh` reconstruction so operators can
  tell a one-time warmup from continued per-turn fan-in.
- A sparse transport gateway that executes a local planning VM MUST perform the
  applicable checkpoint hit/repair/seed before VM planning begins, not only
  before commit submission. Local routing stubs whose parent/class lineage is
  incomplete are cache hints, not authority rows; serving them as authority can
  convert a repairable missing page into a local `E_OBJNF`/`E_VERBNF`.
- The checkpoint MUST also be bounded by retained cell/object count, not only
  by checkpoint count. If a repair would push the checkpoint beyond that local
  budget, the gateway may serve the repaired payload for the current attempt,
  but it MUST NOT store the oversized union or emit a sticky-repair health
  signal.
- Authority-slice page references MUST carry a page-level `source` discriminator
  (A3): the authority-slice builder cannot construct a slice without declaring,
  per page, whether it is the owner's authoritative row or a
  cache/projection/fallback/gossip derivation. A gateway TRUSTS a remote page as
  authority ONLY when `source == "authoritative"` and `source_host` is the
  responding owner. Cache/fallback/projection/gossip pages MAY fill a local gap
  for planning, but MUST NOT override a local or fresher owner row and MUST NOT
  be treated as a write-authority source. This is the typed enforcement of CA2's
  "a projection cell MUST NOT be used as a write-authority source": provenance is
  load-bearing, not advisory. (A3.2 extends the same refusal into the VM planning
  read path; A3.1 establishes it at the authority-slice merge boundary.)
  The `source` field is mandatory at the type level on an authority page ref
  (distinct from an execution-transfer page ref, which omits it), so EVERY
  constructor — including the bridge that converts a legacy object-row slice
  into cell pages — must stamp provenance. A bridge or merge step that cannot
  prove a page is the owner's current authoritative row MUST stamp a
  non-authoritative source (e.g. `fallback`) rather than fabricate
  `authoritative`; the page can still fill a planning gap but is never trusted
  as write-authority.
- Authority-slice combination and merge MUST resolve a per-cell contest by
  provenance precedence, NOT by slice arrival order: rank
  `authoritative > projection > cache > fallback > gossip`. An authoritative cell
  is never displaced by a derived page; among equal-rank derived pages a later
  (fresher) contribution wins. Additionally, a **presentation stub** — an
  `object_lineage` page whose `name` equals its object id — is never admissible as
  planning identity for a real object: it MUST NOT win a contest against a named
  page of equal rank, and a named lineage page (any source) MUST repair a current
  `name===id` cell whose recorded provenance is not `authoritative`, even when that
  cell entered the planning world via a non-provenance-recording seed (its
  provenance is then unknown and treated as repairable, not as protected
  authority). This is the combine/merge expression of "a derived copy is never a
  write-authority source" (CA2/VTN0) and of the PlanningWorld admission rule
  (presentation stubs are inadmissible). A planning materialization that seeds a
  relay/commit-scope world directly from a serialized snapshot MUST capture the
  per-cell provenance of that seed's authority slice, so a seeded stub does not
  default to protected-authority and block its own repair.
- The admission rule is ENFORCED at the planning/VM boundary — the single point
  where a materialized world becomes the VM's readable world — not merely at the
  merge. When the planning world carries a presentation stub for a tracked identity
  cell, the boundary MUST refuse it. Refusal is by REPAIR, not a hard fail: the
  boundary raises a repairable missing-state (`E_NEED_STATE`) naming the stubbed
  object so the turn-submission retry loop refreshes that object's authority and
  re-plans against the named identity. Only a stub that survives the bounded repair
  retry (identity genuinely unresolvable) fails the turn — which is the correct loud
  signal, never a silently-served id-as-name. The refusal covers EVERY tracked cell
  (object_lineage AND object_live), not lineage alone. A non-stub cell whose
  provenance is unknown (`missing_provenance`) is likewise refused-by-repair on any
  path that opts in (`enforceMissingProvenance`) — required of a path whose planning
  worlds are universally provenance-tagged. The sparse gateway is such a path: it
  records provenance on every authority merge AND on accepted-frame application, so
  it enforces missing_provenance; any residual under-tagged cell self-heals on first
  touch (the repair's refreshed authority records its provenance, so it converges)
  rather than serving silently. The browser holder relay likewise records per-cell
  provenance — comprehensively at seed and incrementally on accepted-frame
  application — and so also enforces missing_provenance. A path that is authoritative
  by construction (owner full-state / bootstrap snapshot) declares its cells trusted
  and is not subject to missing_provenance. Substrate refs (the `$`-prefixed
  namespace) are named by their ref by convention and are not presentation stubs.
- Implementations MUST bound checkpoint count by memory policy, for example an
  LRU cap. A gateway must never accumulate one full slice per scope forever.

Commit validation remains authoritative: a write planned from a checkpoint can
still be rejected by the owner head/cell-version checks.

### CA11.2 Quasi-static topology pre-seeding (cold-start)

CA5.4 establishes that a move's read dependencies — a room's `exits`, the lineage
of the objects those exits reference, and the destination's `acceptable` verb —
are **quasi-static topology**. On a cold transport gateway these dependencies are
the dominant remaining cost: planning a turn in a served scope traces that scope's
`exits` property to its one-hop neighbor rooms, finds their `object_lineage`
absent locally, and pays a synchronous cross-host `authority-slice` RPC per
neighbor owner (the measured `~2.8s authority-slice → <neighbor>` on a cold
`enter`). This is not inherent: the topology is known, near-static, and small.

A node MAY **pre-seed the bounded one-hop topology closure** of the scopes it
serves so that planning resolves these read dependencies locally. The closure is
defined exactly, and is bounded by a served scope's exit fan-degree — never
transitive, never global:

- For each served scope `S`: `S`'s own `object_lineage` and its `exits`
  property cell.
- The **exit objects** named by `S.exits`: their `object_lineage` and the
  property cells a move reads (`source`, `dest`, and the movement message
  cells). Exit *verb bytecode* is NOT included — `enter` does not traverse an
  exit; it is delivered with the catalog class graph.
- The **one-hop exit-destination rooms** reached through each exit's `dest`:
  their `object_lineage` **only**. Their `exits`, `object_live`/contents, and
  verb bytecode are explicitly NOT pre-seeded — those are second-hop topology
  the entered turn never reads (the next turn in the neighbor repairs them
  normally).

This closure is **owner-deferring projection material, never authority.** It is
governed by the CA11 provenance rules with no exception:

- Each pre-seeded page MUST carry a non-authoritative `source` (`projection` or
  `cache`) and `source_host` set to the **real owner** of the object, discovered
  from the catalog topology at seed-build time — never the seeding node. A node
  MUST NOT advertise a pre-seeded topology page as `authoritative`, and the
  universal class-lineage support set (`MCP_GATEWAY_ACTOR_SUPPORT_ROOTS`, kept to
  `$actor`/`$thing` and their closure to the lineage top) MUST NOT be broadened
  to carry scope or catalog-instance lineage. Scope-instance topology reaches a
  node ONLY through this owner-deferring path. These are two orthogonal,
  separately-guarded invariants.
- By the CA11 precedence ranking (`authoritative > projection > cache > fallback
  > gossip`), an owner's authoritative row always displaces a pre-seeded page,
  and a pre-seeded page never displaces an authoritative row. The owner-sourced
  admission already unconditionally accepts an `authoritative` page from the
  responding owner even for an id the node already holds, so a repair turn that
  fetches the owner's row refreshes the pre-seeded page.
- Each pre-seeded page MUST carry the **cell version it was minted at**. This is
  the staleness hinge: a move's CA5.4 read-dependency validation runs against the
  owner, so a topology edit that advanced a pre-seeded cell's version after
  planning is detected at the owner and returned as `E_STALE_AUTHORITY`
  (CA11), forcing repair-then-replan. A pre-seeded page therefore **never
  produces silent wrong movement** — at worst one retry on the rare edit.
- **Occupancy transition: a pre-seeded scope that becomes a served/commit scope
  MUST revert entirely to owner authority for that turn.** A pre-seed carries
  only the lineage-only neighbor closure (no `exits`/live cells); it is correct
  for a *neighbor* a turn merely reads, but it MUST NOT stand in for a scope the
  actor now occupies and commits against. A node MUST NOT export a pre-seeded row
  as a local authority row for an id that is a current served scope (an actor's
  active scope): that id is fetched fresh from its owner, so the commit-scope
  open seed and any planning snapshot carry the owner's full row (with `exits`),
  never the lineage-only pre-seed. Concretely: a pre-seeded `the_deck` lets a
  turn *entering `the_chatroom`* resolve `the_deck` locally as a neighbor, but
  once an actor occupies `the_deck` and moves *out* of it, `the_deck` is a served
  scope and its authority — including `exits` — comes from its owner. (Eviction
  of the resident pre-seed is NOT required and is forbidden as a churn source;
  the resident row may remain as a gap-filler for *other* actors who still hold
  `the_deck` only as a neighbor — it simply must not be *exported as authority*
  for the occupant.)
- **Movement-destination repair (the dual of the occupancy transition).** A scope
  becomes "served" not only when it is an actor's active scope *before* planning,
  but also when the VM resolves it as the **movement destination** *during*
  planning (the destination is `exit.dest`, known only after the VM runs, so it
  cannot be in the pre-plan served set). A node that pre-seeds topology MUST,
  before it commits a move, verify the destination's lineage/live provenance: if
  the destination stands locally only as a non-authoritative pre-seed
  (`projection`/`cache`/…), the move boundary MUST raise a repairable
  `E_NEED_STATE` naming the destination, and the repair pass MUST issue an
  **owner-required** authority refresh (a `missing_state_repair` pass that
  disables topology refresh-suppression and the seeded-id local-export exclusion
  for the named ids) so the owner's exits-bearing row is fetched and, by CA11
  precedence, displaces the pre-seed before the move re-plans. A plain
  repair that merely re-requests the id is insufficient — without the
  owner-required refresh the suppression would re-serve the same pre-seed and the
  move would loop. This check is OPT-IN: only a planning path that *has* the
  force-owner repair (the gateway) enables it; holder paths that plan
  optimistically against derived rows and reconcile by their own protocol (the
  browser, REST relay) attach provenance but do not enforce it.
- **Deterministic movement-destination prefetch.** Some movement destinations are
  not actually dynamic: a room direction verb can be read from the room's
  declarative `exits[verb].dest`, and mounted tool `leave`/`out` verbs often name
  the mount room or actor home before the VM runs. A gateway MAY owner-prefetch
  those specific source/destination rows before planning so the movement-
  destination guard passes on attempt 1. This is only a latency optimization: if
  the destination cannot be proven from local declarative data, or if catalog code
  chooses a different destination dynamically, the VM guard and
  `missing_state_repair` path above remain the correctness mechanism.
- **Catalog classes are seeded FULL; only instances are lineage-only.** The
  destination *rooms* in the closure are seeded lineage-only (dynamic instances,
  repaired to owner on the occupancy transition above). But the shared
  catalog-**class** chain (`$exit`/`$room`/`$chatroom`/`$space`/…) is STATIC graph
  data whose verbs the planning VM must dispatch (`$exit:invoke`,
  `$room:acceptable`/`enterfunc`); it MUST be seeded with its verbs (like the
  universal actor-support closure), or a cold move fails `E_VERBNF` AND the
  lineage-only seed would suppress the fetch of the real class. The classes remain
  owner-deferring `projection` provenance (the owner's class row still wins), but
  carry their verbs so dispatch resolves locally.

**Accepted bounded read-staleness window.** A pure read that is not a
version-validated commit — for example listing a room's exits in a `look` — MAY
observe a stale pre-seeded topology page between a topology edit and the next
move that re-validates the dependency at the owner. This window is exactly the
CA6 quasi-static-topology semantics (read dependencies of movement are validated
at commit, not on every read) and is a deliberate, accepted behavior, not a
correctness violation: the very next move repairs it. An implementation MUST NOT
"fix" this by promoting a pre-seeded page to authority or by validating every
read against the owner.

**Conformance (CA14).** A node that pre-seeds topology MUST satisfy:

1. A cold turn that *reads* a served scope's one-hop neighbor `object_lineage`
   resolves it locally and performs NO cross-host `authority-slice` RPC for that
   neighbor. (Zero-fetch holds for the cold READ, NOT for the moment of
   occupancy — see 6.)
2. An owner-authoritative row for a pre-seeded object displaces the pre-seeded
   page in planning.
3. A pre-seeded page NEVER displaces an owner-authoritative row, and is never
   served as a write-authority source.
4. A topology edit at the owner produces `E_STALE_AUTHORITY`/read-version retry
   (then a correct re-planned move), never a silently-applied wrong move.
5. The bounded read-staleness window of behavior 4 is the only observable effect
   of a stale pre-seeded page on a pure read; it is repaired by the next move.
6. A move INTO a pre-seeded neighbor (the occupancy transition) DOES use owner
   authority before commit — either via deterministic owner prefetch before
   planning, or via a `missing_state_repair` owner-required refresh after the VM
   proves the destination. Deterministic prefetch is declared by catalog verb
   metadata, not by transport-layer knowledge of command words or catalog
   property conventions: the runtime may interpret generic `authority.prefetch`
   references such as the current scope, target, actor, property paths, and
   fallback lists, but the property names and destination rules come from the
   verb declaration. The optimization is for cold topology reads; the moment of
   occupancy correctly pays one owner fetch.

## CA12. Representation alignment

One primary key shape MUST span layers: route records, SQL rows, state-transfer
pages, in-memory indexed state, transcript reads/writes, and diagnostics.

- Route resolution returns route/cell records, not full object slices.
- Planning fetches exactly the needed cells plus explicit materialization
  closure.
- Active commit scopes index by cell key first; object views are lazy adapters.
- Projection updates apply changed projection rows incrementally.
- Directory/session data publishes exact session/presence/projection rows, not
  partial object-shaped live pages.
- A cell-page transfer MUST be installable into durable storage without first
  constructing a full `SerializedWorld`. `SerializedWorld` is a
  compatibility/export view at protocol edges, not the hot-path assembly format.
- Any cell-page transfer or filtered authority slice that carries a page for an
  object MUST also carry that object's `object_lineage` page as reconstruction
  support, unless the receiver already holds the object. A lineage page included
  only for reconstruction does not by itself grant write authority; provenance
  and commit validation still determine the authority of each cell.

### CA12.1 Page coverage

The legacy `object_live` page bundles location, children, and contents, which
lets a sparse Directory/session patch masquerade as a complete room live page.
Implementations MUST either split live state into exact cell/projection coverage
(`live:location:<obj>`, per-member `projection:contents:<room>/<member>`) or
forbid sparse use of object-level live pages until the split exists.

### CA12.2 Page-hash canonicalization (verb_bytecode is line_map-blind)

A state page's identity hash and its page reference hash MUST be computed from a
single canonical preimage, so that two pages that are equivalent for execution
and validation hash identically regardless of representation-only differences.

For a `verb_bytecode` page the canonical preimage MUST exclude the verb
`line_map` (the pc→source-position map). `line_map` is authoring/diagnostic
metadata, consumed only by stack-trace formatting, and its presence MUST NOT
change a page's identity. Concretely:

- The same verb page with a populated `line_map` and with an empty `line_map`
  MUST produce the same page hash and the same page-ref `hash`.
- All page hashing, page-ref construction, and transfer verification MUST route
  through this one canonical preimage. A node MUST NOT recompute a page hash by
  any path that includes `line_map`, and verification MUST compare pages by this
  canonical hash, never by deep content equality that would observe `line_map`.
- Because the hash is line_map-blind, a sender MAY omit `line_map` from a
  delivered `verb_bytecode` page (inline or referenced) and the receiver's
  ref/hash verification still accepts it. Execution uses `bytecode`; a receiver
  that lacks `line_map` degrades gracefully to position-less stack frames and
  MAY recompile `line_map` from `source` on demand (see the host-seed delivery
  contract, which already strips `line_map`). `source`/`bytecode`/`source_hash`
  MUST be preserved.
- The page-ref `bytes` field reports the actual delivered page size and so MAY
  differ between a line_map-bearing and a line_map-stripped copy of the same
  page; it is a size hint, not part of page identity, and is never used to
  reject a page.

Changing this canonicalization changes every `verb_bytecode` page hash, so the
first deployment that adopts it triggers a one-time reseed convergence (cold
satellites re-fetch pages under the new hashes via the existing
`E_SNAPSHOT_REQUIRED`/missing-page repair path). This is self-healing and
requires no migration, but it is a fleet-wide convergence cost that MUST be
expected on rollout.

## CA13. Performance and hot-spot scalability

Two scaling axes are both first-class, not one primary and one edge case:

- **Many locations.** Each block/object is bound to a single DO; locations
  scale out across DOs. This axis is inherent and unproblematic.
- **A single hot location.** Agents and humans are mobile but routinely perform
  extended *coordinated* work within one room, and crowds enter and leave one
  room. A single block bound to one DO MUST NOT degrade catastrophically under
  high single-room activity. This is the hard axis this section governs.

The governing principle: **a room DO's load MUST be proportional to the rate of
genuinely shared-state mutation in that room, never to the rate of activity in
it.** Most "activity" is not shared-state mutation and MUST be kept off the room
sequencer.

Per-turn routing/commit work MUST be bounded by the turn —
`O(cells_in_turn + route_shards_touched)` — and MUST NOT be `O(world)`,
`O(objects_in_scope)`, or `O(active_sessions)`.

### CA13.1 Decomposing load on a hot room

Three distinct pressures, with their required bounds:

1. **Entering and leaving (membership churn).** Under actor-anchored movement
   (CA3, CA6), an enter or leave commits `live:location:<actor>` at the *actor's*
   home and writes **zero** cells at the room. A flash crowd entering a room
   therefore imposes no writes on the room's sequencer. The room only *observes*
   the accepted movement events and updates its contents projection — per-member
   key puts/deletes (CA4), which an implementation MUST be able to **coalesce**
   (apply a batch of accepted movement events in one transaction, and notify
   occupants of a batched membership delta rather than one fanout per arrival).
   Required: membership churn costs `O(churn)` cheap projection writes at the
   room, coalescible, and `0` room-sequencer commits.

2. **Fanout fan-degree.** Every observable room event must reach occupants. The
   room DO MUST NOT iterate `O(occupants)` deliveries itself. Delivery MUST be
   shard-distributed through the VTN12/VTN13 session/audience table: the room
   publishes once per event to the set of *gateway shards* holding occupant
   sessions, and each shard delivers locally to its slice. Fan-degree at the room
   is `O(distinct occupant shards)`, bounded by shard count, not by occupant
   count. An implementation MUST NOT keep an `O(occupants)` subscriber list at
   the room that it walks per event.

3. **Sequenced shared-state writes.** Genuinely shared mutations — a shared
   board, a room prop two agents both change — serialize at the room's one
   sequencer. This is the room's irreducible consistency cost. It MUST stay
   *linear* in the shared-mutation rate (no superlinear amplification), and the
   architecture's job is to keep this set small: see CA13.2.

### CA13.2 Keeping the room sequencer carrying only shared mutations

Operations that are *not* shared-state mutations MUST NOT be committed at the
room sequencer:

- **Movement** is actor-anchored (CA3) — already off the room.
- **Speech and per-actor effects** (`say`, emotes, per-actor observations)
  SHOULD be anchored at the speaker/actor home and delivered by fanout (CA13.1.2),
  not committed as room-sequenced state. A room's chat throughput is then bounded
  by fanout distribution, not by one sequencer. A catalog MAY opt a specific
  utterance class into room-sequencing when a strict total order is genuinely
  required, accepting the single-DO ceiling for that class.

After this, the room sequencer's commit rate equals the rate of true shared-state
change, which for most rooms is low even when occupancy and chatter are high.

### CA13.3 Escape hatches when one DO is genuinely the ceiling

When even the shared-mutation rate of one logical hot spot exceeds a single DO,
the design distributes it **without** introducing a shared owner outside a
sequencer:

- **Hot shared object (coordinated work).** A board/document/whiteboard under
  heavy multi-agent editing distributes its write load by **per-cell authority
  migration (CA10)**: distinct cells of the object acquire distinct active
  owners, so concurrent edits to different parts commit at different homes. Cell
  granularity bounds the parallelism; no single DO carries the whole object's
  write rate.
- **Hot room (shared-mutation rate).** A logical room MAY be sharded into
  sub-scopes (interest groups / regions), each its own sequencer, with
  cross-shard awareness via projection and fanout. Each shard remains a single
  sequencer; the constraint of CA holds. This is an explicit per-room upgrade,
  not the default.

Both escape hatches reuse machinery already in this spec (CA10 migration; CA4
projection; CA8 fanout). Neither reintroduces a placement-style shared owner.

### CA13.4 Reads and cold starts

- `look`/`who` and parser resolution MUST be served from a room contents
  projection / edge cache, never by re-reading authoritative location cells
  across homes and never by `O(world)` scan. When a sparse execution holder
  (for example an MCP gateway shard) only has a non-authoritative projection of
  that contents cell, it MUST repair/fetch the room owner's contents projection
  before using the cell for a final visibility or object-resolution decision.
  A full occupant render is `O(result_size)` and SHOULD be paginatable for very
  crowded rooms.
- The first interaction with a cold parent pays projection fetch/repair once
  (CA4); steady-state reads take no route-home RPC.

### CA13.5 Forbidden degradation modes

An implementation MUST NOT exhibit, on any hot-room path:

- `O(occupants)` work at the room DO per event (fanout MUST shard — CA13.1.2);
- `O(occupants²)` (e.g. every occupant re-reading full room/membership state on
  every change);
- `O(world)` or `O(objects_in_scope)` enumeration anywhere on the movement,
  projection, fanout, or read path;
- room-sequencer commits proportional to movement or speech rate (CA13.2);
- a single shared mutable membership/contents cell that all entrants write
  (the withdrawn MV-A failure mode).

Conformance for this section is exercised by hot-room load cases in the
multi-DO harness (CA14.15): a room with many occupants and high enter/leave
churn must hold room-sequencer commit rate flat (≈ shared-mutation rate) while
membership and fanout scale with shard count, not occupant count.

## CA14. Conformance behaviors

An implementation conforms when these hold (each requires an automated test;
several require a multi-DO harness, CA16):

1. A move commits exactly `live:location:<actor>` as authoritative; it writes
   neither source nor destination contents.
2. No movement commit routes through `#placement` or a room-contents placement
   shard.
3. Two actors moving into the same room both commit independently and both
   appear in the projection; no lost membership is possible.
4. Duplicate accepted movement events do not duplicate contents rows.
5. An older movement event cannot roll a projection back behind a newer observed
   source location version.
6. A cold `look` with no contents projection repairs/fetches or returns
   degraded; it never renders an empty room from a cache miss.
7. Browser execution proposes a single actor-location write and reconciles from
   the accepted event; it never owns or migrates.
8. MCP/server execution uses guarded read repair and commits at the location
   owner, not a shared placement executor.
9. Movement observations deliver through the session/audience table, not
   Directory `current_location` as the hot-path key.
10. A room-anchored container enforces its set invariant: a capacity-1 room
    admits exactly one of two racing entrants and orders arrivals against its
    own sequenced events.
11. A sparse Directory/session patch cannot erase contents projections or
    authoritative location cells.
12. Stale/fallback planned cells report planned vs actual owner/route/source.
13. For general authoritative cells, concurrent migration attempts produce one
    active owner and retryable losers; an expired `moving` lease reverts; a write
    to a moved-from owner returns `E_MOVED`.
14. Movement planning/commit/projection update does not materialize a whole
    `SerializedWorld` or scan all objects in a scope when exact keys are known.
15. The conformance suite runs with separate DOs for actor homes, room
    projection owners, route homes, and commit scopes — not a single process.
16. Projection-mode write-through of a cross-host move durably repairs the
    foreign source/destination container owner's `contents` projection from the
    accepted move, even when that host receives no full object projection row;
    a non-owner cached copy must remain a no-op for durable persistence.
17. **Hot-room load (CA13).** With many occupants and high enter/leave churn in
    one room: room-sequencer commit rate stays ≈ the shared-state-mutation rate
    (independent of occupancy, movement, and chat rate); fanout fan-degree scales
    with occupant *shard* count, not occupant count; and no movement, projection,
    fanout, or read path performs `O(occupants²)`, `O(world)`, or
    `O(objects_in_scope)` work.

## CA15. Open questions

- **CA15-a — projection rebuild without enumeration.** `contents(parent)` is a
  reverse index. Steady-state projection rows are durable and survive restart; a
  new parent is legitimately empty. After projection-store loss, actor members
  are recoverable from the session table (bounded by active sessions), but inert
  members are not without a reverse index or a "repair on next touch" rule. The
  spec does not yet mandate a rebuild mechanism; an implementation MUST at least
  detect incompleteness (CA4 cold≠empty) rather than silently report an empty
  parent. A durable per-parent membership log (fed by accepted movement events)
  is the leading candidate and should be evaluated against CA13.
- **CA15-b — room-anchored declaration surface.** The exact catalog metadata by
  which a container opts into CA7, and whether it can scope the opt-in to
  specific move kinds (arrivals only, departures, item placement), is unspecified.

## CA16. Cloudflare realization and rollout

- A new Durable Object class (working name `CellRouteDO`) holds route records,
  hash-sharded by authoritative cell key. Adding the binding is a CF DO-class
  migration (`npm run cf:migrations`); it MUST be added before any route-backed
  authority code ships.
- A **multi-DO local test harness** is a prerequisite, not an afterthought: the
  single-process walkthrough cannot observe cross-DO authority gaps and did not
  catch the `#placement` no-snapshot failure. CA14.15 depends on it.

Recommended order (correctness-first, each independently shippable):

1. This spec section, reviewed.
2. Provenance tags on planner snapshots + `E_STALE_AUTHORITY` (CA11) — before any
   route shards; immediate observability.
3. Split `object_live` into exact cell/projection coverage (CA12.1).
4. Shared key shapes for authoritative and projection cells (CA2).
5. Cell-keyed storage/read APIs beside the `SerializedWorld` adapters (CA12).
6. Movement transcript/write construction commits only the location cell (CA3).
7. Per-`(parent, member)` projection storage + idempotent, monotonic event
   application (CA4).
8. Movement delivery through the VTN12 session/audience table (CA8).
9. Browser/MCP execution submit movement as location commits and reconcile from
   accepted events (CA9).
10. Remove the `#placement` movement path and MV-A code from the evidence
    worktree before merging any successor.
11. Route-home records and migration for non-movement authoritative cells (CA10)
    only after movement is clean and tested.
12. Room-anchored movement opt-in (CA7) once the default path is proven.
13. Re-enable REST/MCP/browser movement smoke against the projection-backed path.

## Non-goals for the first implementation

- General migration of all object properties.
- Global route enumeration; using `world` or Directory as a global cell oracle.
- Treating gossip as authoritative.
- Placement ownership for room contents; cross-DO 2PC for ordinary movement.
- Promoting movement to room-anchored by default.
