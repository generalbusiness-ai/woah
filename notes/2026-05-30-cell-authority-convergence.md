# 2026-05-30 - cell authority convergence and movement projection

Origin: the `#placement` MV-A production regression and the follow-up analysis
of why the partial implementation became hard to reason about.

This note supersedes the earlier "movement cells migrate to placement" framing.
That framing was wrong: it tried to fix a dual-write representation by adding a
second sequencer outside the room and actor sequencers. The durable movement
model should instead delete the redundant write.

This is a work description, not normative spec text. The normative home for the
design is `spec/protocol/cell-authority.md`, with `spec/protocol/v2-turn-network.md`
retaining VTN8.1 only as superseded history and VTN10.1 as the guarded
materialization-repair rule this design still relies on.

## Status

- The current `placement-synthetic-snapshot` worktree has been redirected away
  from the old synthetic-placement frame and now implements the movement
  checkpoint described here.
- The synthetic `#placement` scope and MV-A fenced movement transaction remain
  useful incident evidence, but they are withdrawn from the runtime movement
  path.
- Movement commits `live:location:<object>` at the moved object's authority.
  Room contents and live subscriber surfaces are compatibility projections
  maintained from accepted movement events.
- Movement must not introduce an owner that serializes writes to room membership
  across unrelated room or actor sequencers.
- Route records, route epochs, provenance diagnostics, and migration still
  matter for the general cell-authority problem. They are intentionally not the
  default movement commit mechanism, and they remain follow-up substrate work.

## The constraint

There are two legitimate kinds of serialization and one illegitimate kind.

Legitimate:

- Per-scope sequencing. A room with many actors saying or doing sequenced room
  actions must order those events at the room sequencer.
- Per-object sequencing. `live:location:<actor>` naturally serializes at the
  actor or object home. Many actors have many independent homes.

Illegitimate:

- A second owner that serializes writes to a membership cell across unrelated
  scopes, such as a placement shard owning `the_deck.contents` outside the room
  sequencer. That is a hidden global-ish coordinator and is unsustainable.

The `#placement` regression happened because the implementation inferred
authority from "which serialized world happens to contain the cell." The later
placement-shard framing improved the metadata, but it still kept the wrong
shape for movement: one mutable room membership cell that many actors must
write.

## Root cause: movement was dual-written

The old model stored room membership twice:

- `live:location:<actor>` says where the actor is.
- `live:contents:<room>` is a mutable list saying who is in the room.

A move therefore appeared to require writes in multiple scopes:

- update the actor's location;
- remove the actor from the source room contents;
- add the actor to the destination room contents.

That representation creates the lost-update race. The attempted fixes then
became either:

- cross-DO two-phase commit; or
- migration to a shared placement owner.

Both are worse than the real fix. Room membership should not be an authoritative
single list cell. It should be a projection of object locations, keyed by member.

## Movement invariant

`live:location:<object>` is the single source of truth for physical placement.

A move commits exactly one authoritative movement write:

```text
live:location:<actor> = old_room -> new_room
```

The authority for that write is the moved object's natural home sequencer. A
browser actor's own move therefore goes to the browser actor's home authority;
an MCP actor's own move goes to that actor/session/object authority. Routine
actor movement is naturally distributed by actor.

Room contents are derived:

```text
contents(room) = { object | live:location:<object> == room }
```

For efficiency, room contents are materialized as a projection, but the
projection is keyed by member:

```text
projection:contents:<room>/<member>
```

Each projection row is derived from one source cell:

```text
source = live:location:<member>
```

Concurrent moves into the same room update different projection keys. There is
no single mutable room-contents list to lose updates.

## Consequences for movement

Movement does not require:

- `#placement`;
- a placement shard that owns room contents;
- MV-A fenced multi-cell movement transactions;
- cross-scope writes to source and destination room contents.

Movement still requires:

- read closure repair for transitive state such as exits and destinations;
- validation of read dependencies used to decide the move;
- a sequenced authoritative write to the moved object's location;
- durable movement events that feed room projections and live delivery.

The commit owner for the move validates that the planned read dependencies are
still acceptable. If the executor planned from stale destination, exit, or actor
state, the commit rejects or returns retryable stale authority. It does not
repair correctness by writing room contents.

## Browser and MCP execution

Execution ownership and commit ownership are separate.

Browser execution stays first-class:

- the browser VM plans locally against cached executable state;
- missing cells are repaired through VTN10.1 guarded materialization;
- the browser submits a transcript/proposal for the actor's location write;
- the authoritative actor/object home accepts or rejects the write;
- accepted events reconcile browser projections through fanout.

The browser is never a durable authority owner and never a migration
participant for ordinary movement.

MCP/server actors should converge on the same shape. They need a capable
distributed executor near the actor/session or scope, not a shared placement VM.
The executor runs the whole turn under guarded repair; the authoritative
location owner commits the movement write.

The commit owner may execute a turn only as a fallback path for clients that do
not have a capable executor. That fallback must not become the mainstream
architecture.

## Room projections

Room owners observe movement events and maintain local projection rows:

```text
delete projection:contents:<old_room>/<actor>
put    projection:contents:<new_room>/<actor>
```

Projection updates are idempotent by movement event identity or by
`live:location:<actor>` source version. A duplicate accepted movement event
must not create duplicate membership. An out-of-order movement event must not
roll a projection back behind the source location version it already observed.

The room projection is not an independent authority over the actor's location.
It is a read model used for:

- `look`;
- `who`;
- parser resolution among visible objects;
- audience calculation when room-local projection is fresh enough;
- compatibility views for old object-shaped `contents` readers.

Presence projection properties are declared by property metadata, not by core
knowledge of names such as `subscribers` or `session_subscribers`. The current
compatibility runtime marks a property definition with
`presenceProjection: { kind: "presence", key: "actor" }` or
`presenceProjection: { kind: "presence", key: "session", sessionField, actorField }`.
Transcript validation uses that declaration to reconcile same-turn movement
reads; properties without the declaration remain ordinary property cells even
when their values look like membership lists.

A cold or missing projection is not the same as an empty room. If
`projection:contents:<room>/*` is absent or known incomplete, the room must
repair or fetch an authoritative projection source, or report an explicit
degraded/loading state. It must not synthesize `[]` and render "Present:
nobody" from absence of cache.

## Live delivery

Movement commits emit durable movement events with enough information for both
rooms and gateway session tables:

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

Live delivery should use the VTN12 session/audience table, not Directory
`current_location` as the hot-path routing key. The movement event is exactly
the change that invalidates location-derived routing, so live routing must not
depend on a globally consistent current-location read at fanout time.

Room projections and live delivery are related consumers of the same accepted
movement event. Neither is the authority for the movement write.

## Strong room effects

A sequenced verb that needs "everyone in the room right now" runs at the room
sequencer against the room's projection state at that room sequence. A move that
commits after that room sequence is not included. This is the normal race one
expects in a distributed world.

If a catalog needs stricter semantics, that room or verb can opt into a stronger
protocol: for example, arrivals are acknowledged into the room's own sequenced
log before the room effect treats the actor as present. That is an explicit
per-room consistency upgrade. It is not the default movement model, and it is
still the room's own sequencer, not a shared placement owner.

## Authoritative cells and projection cells

Use separate names for authoritative cells and derived projection rows.

```ts
type AuthoritativeCellKey =
  | `lineage:${ObjRef}`
  | `live:location:${ObjRef}`
  | `prop:${ObjRef}.${string}`
  | `verb:${ObjRef}.${string}`;

type ProjectionCellKey =
  | `projection:contents:${ObjRef}/${ObjRef}`;
```

`live:contents:<room>` as one authoritative mutable list should be retired. A
compatibility adapter may expose `contents(room)` as an array, but it should
assemble from projection rows and carry provenance that says it is a projection.

The old `object_live` page is too coarse because it bundles:

- object location;
- children;
- contents.

That bundling lets a sparse Directory/session patch look like a complete room
live page. Split live pages into exact cells, or forbid sparse use of
object-level live pages until the split exists.

## Provenance

Every planned, transferred, stored, and diagnostic cell should carry provenance:

```ts
type CellRecord = {
  cell: AuthoritativeCellKey | ProjectionCellKey;
  owner?: ScopeRef | NodeRef;
  route_epoch?: number;
  owner_head?: ScopeHead;
  source_version?: string;
  value_ref?: StatePageRef;
  value_inline?: WooValue;
  source: "authoritative" | "projection" | "fallback" | "cache" | "gossip";
};
```

For authoritative cells, `owner` and `route_epoch` identify write authority.
For projection cells, `source_version` identifies the authoritative source cell
or accepted event that produced the projection.

Commit mismatch diagnostics should report stale authority explicitly:

```text
E_STALE_AUTHORITY {
  cell,
  planned_owner,
  planned_route_epoch,
  planned_owner_head,
  actual_owner,
  actual_route_epoch,
  actual_owner_head,
  source
}
```

For projection mismatches, diagnostics should report the source cell and source
version rather than pretending the projection owns the truth.

## Route records still matter

The movement correction does not delete the general authority-migration goal.
Some authoritative cells may still migrate toward activity:

- a hot shared object's property;
- a child collection whose natural owner changes;
- a verb or lineage cell whose operational home moves.

For those cells, the core rule remains:

```text
Views gossip. Route records decide. Owners commit.
```

Every authoritative durable cell has one active authority record. The authority
record is independent of value carriers and projections.

```ts
type CellAuthorityRecord = {
  cell: AuthoritativeCellKey;
  owner: ScopeRef | NodeRef;
  route_epoch: number;
  version: string;
  parent_owner?: ScopeRef | NodeRef;
  state: "active" | "moving";
  moving?: {
    from: ScopeRef | NodeRef;
    to: ScopeRef | NodeRef;
    token: string;
    lease_until_ms: number;
  };
};
```

The route shard's CAS token answers:

```text
who owns this authoritative cell?
```

The owner scope's existing head answers:

```text
which value history did this write validate against?
```

A durable write checks both:

1. the cell route record is still active for the expected owner and route epoch;
2. the owner scope head or per-cell version matches the planned read/write
   provenance.

Route epoch changes when ownership moves. Owner head changes when values
commit. They must be carried together but must not become competing value
concurrency tokens.

## Route home shards

Use deterministic route homes for authoritative cells:

```text
home(authoritative_cell_key) = hash(authoritative_cell_key) mod N CellRouteDO shards
```

Route homes store authority records. They do not store world objects, room
projections, catalog bytecode, or session queues.

Properties:

- any node can compute the home shard locally from the cell key;
- resolving routes for a turn is proportional to cells touched, not world size;
- planning reads route information from cache/gossip first;
- route-home reads happen on cache miss, stale redirect, migration, or write
  validation;
- write validation batches route-home checks by shard and touches only written
  authoritative cells.

Complexity target:

```text
O(number_of_cells_in_turn + number_of_route_shards_touched)
```

Not:

```text
O(world)
O(objects_in_scope)
O(active_sessions)
```

## General migration protocol

Migration is per authoritative cell. Batches are an optimization over per-cell
migration, not the source of truth.

### 1. Resolve

The target node resolves every authoritative cell it intends to write.
Resolution is cache-first:

1. local authoritative route cache;
2. fresh gossip hint;
3. route-home read on miss or suspected stale route.

### 2. Lock

For each cell, in sorted `cell_key` order, the migration coordinator asks the
cell's route home to CAS:

```text
active(owner=A, route_epoch=e)
  -> moving(from=A, to=B, route_epoch=e+1, token=t, lease_until=...)
```

If any CAS fails, release acquired locks or let them expire, reread routes, and
retry. Sorted order prevents local deadlock when batching cells.

### 3. Export

The old owner exports:

```ts
{
  cell,
  value,
  version,
  route_epoch: e,
  token: t,
  proof
}
```

The old owner freezes writes for that cell while the route is moving.

### 4. Install

The new owner installs only if:

- the token matches;
- the prior route epoch matches;
- the exported version matches the route record;
- the proof validates under deployment authority.

Install is idempotent by `(cell, route_epoch, token)`.

### 5. Commit route

The route home CASes:

```text
moving(from=A, to=B, route_epoch=e+1, token=t)
  -> active(owner=B, route_epoch=e+1, version=v)
```

After this point, writes to the old owner return
`E_MOVED { owner: B, route_epoch: e+1 }`.

### 6. Forwarding tombstone

The old owner keeps a bounded tombstone for stale-cache repair. The tombstone is
not authority.

### 7. Recovery

If the lease expires before route commit:

- the home shard reverts to `active(owner=A, route_epoch=e)`;
- the old owner unfreezes writes;
- the new owner may keep the installed value only as an inactive cache page.

Movement does not use this migration protocol for room contents. It uses the
single authoritative `live:location:<object>` write plus room projections.

## Movement protocol

The simplest movement protocol is:

1. The executor plans the verb against cached executable state.
2. Missing transitive read state, such as `exit.dest`, is repaired by VTN10.1
   guarded materialization.
3. The executor submits the turn transcript/proposal to the authority for
   `live:location:<actor>`.
4. The location owner validates read dependencies and the actor's current
   location version.
5. The location owner commits the new location and emits one accepted movement
   event.
6. Source and destination room projection owners apply idempotent projection
   updates keyed by member.
7. Gateway/session routing delivers observations by audience/session table.
8. Browser/MCP holders reconcile local projections from the accepted event.

The move writes one authoritative cell. Projection updates may be delayed or
replayed without changing the committed movement truth.

## Stored/serialized/active alignment

Use one primary key shape across layers:

- route records;
- SQL rows;
- state-transfer pages;
- in-memory indexed state;
- transcript reads/writes;
- diagnostics.

Avoid designs that store object-shaped rows, serialize page-shaped rows, then
rebuild object-shaped active state before every plan. `SerializedWorld` should
become a compatibility/export view at protocol edges, not the hot-path state
assembly format.

Practical rules:

- Route resolution returns route records or cell records directly, not full
  object slices.
- Planning fetches exactly needed cells plus explicit materialization closure.
- Active commit scopes index by cell key first; object views are lazy adapters.
- Projection updates apply changed projection rows incrementally.
- Directory/session data publishes exact session/presence/projection rows, not
  partial object-shaped live pages.
- Catalog-visible projection properties carry metadata declaring their
  projection role and key shape, so validation/storage code does not branch on
  catalog property names.
- A cell-page transfer should be installable into durable storage without first
  constructing a full `SerializedWorld`.

## Testing requirements

The movement checkpoint needs tests for:

1. **Movement single-write.** A move transcript commits exactly
   `live:location:<actor>` as authoritative movement state and does not write
   source or destination room contents. Implemented in the current checkpoint.
2. **No placement owner.** A movement commit does not route through `#placement`
   or a room-contents placement shard. Implemented in the current checkpoint.
3. **Two actors, same destination.** Concurrent moves by two actors into the
   same room both commit independently and both appear in the room projection;
   no lost membership is possible. Implemented in-process in the current
   checkpoint.
4. **Projection idempotency.** Duplicate accepted movement events do not create
   duplicate contents rows.
5. **Projection ordering.** An older movement event cannot roll a room
   projection back behind a newer observed source location version.
6. **Cold projection read.** A cold `look` with no room contents projection
   repairs/fetches projection state or returns degraded/loading; it never
   renders an empty room from missing cache.
7. **Browser move.** Browser VM execution proposes a single actor-location
   write and reconciles from the accepted movement event. Covered at the local
   turn layer; broader deployed-browser smoke remains follow-up.
8. **MCP move.** MCP/server execution uses guarded read repair and commits at
   the actor/object location owner, not at a shared placement executor. Covered
   by local Worker/MCP regression tests in the current checkpoint.
9. **Live routing.** Movement observations are delivered through the
   session/audience table and do not depend on Directory `current_location` as
   the hot-path fanout key.
10. **Strong room effect.** A room-sequenced effect uses the room projection
    snapshot at that room sequence; moves accepted after that sequence are not
    included.
11. **Sparse Directory patch.** Session roster recovery cannot erase room
    contents projections or authoritative location cells.
12. **Provenance diagnostics.** Stale/fallback planned cells report planned and
    actual owner/route/source information.
13. **Route record CAS.** For general authoritative cells, concurrent migration
    attempts produce one active owner and retryable losers.
14. **No full-scope assembly.** Movement planning/commit/projection update does
    not materialize an entire `SerializedWorld` or scan all objects in a scope
    when exact cell keys are known.
15. **Multi-DO authority harness.** A local test runs with separate fake DOs for
    actor homes, room projection owners, route homes, and commit scopes. The
    single-process walkthrough is not enough.

## Implementation order

1. Write the normative VTN section for movement-as-location and contents as
   per-member projection. Done as `spec/protocol/cell-authority.md`.
2. Add provenance tags to planner snapshots and commit mismatch diagnostics.
3. Split `object_live` into exact live-cell/projection coverage, or forbid
   sparse use of object-level live pages until the split exists.
4. Define shared key shapes for authoritative cells and projection cells.
5. Add cell-keyed storage/read APIs beside existing object-shaped
   `SerializedWorld` adapters.
6. Change movement transcript/write construction so movement commits only the
   actor/object location cell. Done for the compatibility object-shaped runtime.
7. Add room projection storage keyed by `(room, member)` and idempotent
   movement-event application. Partially done through member-safe projection
   application on the current serialized/projection caches; exact cell-keyed
   storage remains future work.
8. Route live movement delivery through the VTN12 session/audience table.
   Partially done for the current Worker/MCP paths.
9. Update browser and MCP execution paths to submit movement as actor-location
   commits and reconcile projections from accepted events. Done for the current
   checkpoint paths under test.
10. Remove the synthetic `#placement` movement path and MV-A fenced movement
    transaction code from the retained worktree before merging any successor.
    Done operationally for movement; generic transaction compatibility code
    remains inert and should be either removed or renamed when a real non-MV-A
    multi-cell transaction model exists.
11. Add route-home records and migration for non-movement authoritative cells
    only after the movement representation is clean and tested.
12. Re-enable REST/MCP/browser movement smoke against the projection-backed
    movement path.

## Non-goals for the first implementation

- General migration of all object properties.
- Global route enumeration.
- Using Directory as a global cell owner.
- Treating gossip as authoritative.
- Making `world` the route oracle for all cells.
- Using placement ownership for room contents.
- Cross-DO 2PC for ordinary movement.

## Design summary

The clean movement rule is:

```text
Location is truth. Contents are projection. Rooms observe.
```

The broader cell-authority rule remains:

```text
Views gossip. Route records decide. Owners commit.
```

Together these keep the browser/local-VM path viable, preserve naturally
distributed actor movement, and leave first-class route migration available for
cells whose true authority should move toward activity.
