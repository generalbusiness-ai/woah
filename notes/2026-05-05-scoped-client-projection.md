# Scoped client projection and immediate UI model

Date: 2026-05-05

## Context

The browser client currently treats `/api/state` as the load-bearing model of
the world. That is wrong in two ways:

- **Cost:** every applied/task/replay frame schedules a debounced refresh that
  fetches the whole actor-readable world and rebuilds chat/dubspace/pinboard/
  taskspace projections by scanning global object maps.
- **Correctness:** a broad cross-host snapshot can lag behind the call result
  and observations that just reached the browser. The deck -> hot tub bounce was
  a visible instance: stale presence made the client re-enter the room the
  session had just left.

The replacement is a bounded client model:

- `self`: the actor object and direct actor state.
- `session`: current session id, actor, `current_location`, and
  `all_locations`.
- `here`: the current room/space snapshot, shallow and actor-filtered.
- `inventory`: shallow summaries of carried objects.
- `catalogs`: UI declarations and module metadata, cached by version/ETag.
- `overlays`: explicit app/tool surfaces such as pinboard, dubspace, or
  taskspace, fetched only when opened or restored.

The server remains the canonical model. The browser owns an **effective
projection** for the mounted neighborhood:

```
canonical scoped snapshot
  < sequenced observation patches
  < live preview patches
  < optimistic patches
```

All production UI reads should go through that effective projection. Raw
snapshot objects are inputs to the projection, not a component API.

Layering is per field, not per subject. A read of `control.props.cutoff`
returns the highest-priority non-expired layer that defines `props.cutoff`; a
live cutoff preview must not shadow a sequenced rename of the same control.
Within a layer family, the same optimistic id replaces itself. Distinct
optimistic ids that write the same field use last-write-wins by application
time; distinct fields merge.

## Current status

The cross-host session-record gap has been closed: call envelopes and Directory
session routes carry `current_location`, and receiving hosts upsert forwarded
session state before dispatch. Worker-routed smoke covers chatroom -> deck ->
hot tub with coherent `/api/state.session.current_location` and
`entered.origin`.

`src/client/framework.ts` already contains the start of the client projection:
canonical, sequenced, live, and optimistic layers; observation reducers; frame
state; and overlay actions. Pinboard already uses optimistic patches to avoid
snap-back during move/resize. Dubspace has partial live-preview support, but
rendering and audio still read from legacy `state.world` in several paths. The
next work is to make this projection the standard path instead of a pinboard
special case.

## Server API shape

### `GET /api/me`

Initial hydration and reconnect recovery. This is the replacement for normal
SPA use of `/api/state`.

Return shape:

```ts
type MeSnapshot = {
  server_time: number;
  cursor: ProjectionCursor;
  self: ObjectSummary;
  session: {
    id: string;
    actor: ObjRef;
    current_location: ObjRef | null;
    all_locations: ObjRef[];
  };
  here: RoomSnapshot | null;
  inventory: ObjectSummary[];
  overlays?: Record<string, OverlayHandle>;
};
```

`/api/me` should be served by the session-owning/gateway path, but any
cross-host `here` reads must route to the current room's host. It must not scan
or serialize the full world.

### Stream-snapshot binding

`/api/me` is also the reconnect anchor. It must return a cursor that binds the
snapshot to the sequenced observation stream:

```ts
type ProjectionCursor = {
  spaces: Record<ObjRef, { next_seq: number }>;
  overlays?: Record<string, { subject: ObjRef; surface: string; next_seq?: number }>;
  live: { resumable: false };
};
```

The cursor covers the union of the session's `current_location`, the resolved
`here.id`, and every restored overlay subject. Each `next_seq` is the first
sequenced frame the client should request after applying the snapshot. Cursor
metadata is system-scoped, not an actor property read. An actor may be entitled
to receive/replay observations from a space even when that space's internal
`next_seq` property is not readable as an ordinary property. Overlay snapshots
that are backed by a sequenced space must carry the same kind of cursor.
Live/non-sequenced frames are lossy in v1; reconnect recovery reasserts durable
live-derived state by rehydrating `/api/me` and any restored overlay snapshots.
Preview-only state may disappear across reconnect.

The WS reconnect path should eventually accept the client's last cursor during
auth/connect. If the server can replay the gap, it may reply `{ resumed: true }`
and skip `/api/me`; otherwise the client must full-hydrate with `/api/me` and
then replay from the returned cursor. Until that handshake exists, reconnect
always hydrates and then replays from the cursor.

### `GET /api/catalogs/ui`

Returns installed catalog UI metadata only: aliases, catalog names, versions,
UI manifests, module entries, and integrity metadata. It should be version or
ETag cacheable and should honor `If-None-Match` with `304`. Catalog UI code
loading remains separate from actor state.
Phase 1 exposes bundled/local catalog UI only. Remote catalog UI needs a signed
module URL and integrity policy before it can appear here.

The endpoint may include installed-catalog `objects` and `seeds` maps for
resolution/debugging, but browser code should not choose runtime subjects from
these seed ids. Component/frame selection should use the routed subject and its
class/features.

The existing catalog endpoints can remain for wizard/admin/catalog-management
flows; this endpoint is the ordinary browser boot path.

### Move and enter results

`$room:enter`, `$exit:move`, and equivalent mounted-space entry verbs should
return a self-contained room update. Preserve `room` as the room id for
backward compatibility; add `here` as the snapshot. During the compatibility
window, direct results are recognized as movement-shaped only when they are an
object map with `room: ObjRef` and `here_request: true`; an unrelated verb that
happens to return a `room` field should not trigger snapshot enrichment.
`look_deferred` is legacy and remains only for old clients. Retire it once old
clients are gone.

```ts
type MoveResult = {
  room: ObjRef;
  here: RoomSnapshot;
  from?: ObjRef | null;
  exit?: string;
};
```

The client should atomically replace `state.here` and ingest the `here`
objects into the projection from this result. There should be no follow-up
`:look` round trip in the normal move path.

For cross-host moves, the returned `here` snapshot must be reconciled with the
move result, even if host effects are still deferred. If the presented session's
current location resolves to the returned `here.id`, the moving actor must be
present in `here.present_actors` before the client renders the move result.

### `RoomSnapshot`

The room snapshot is a shallow, actor-filtered vicinity projection:

```ts
type RoomSnapshot = {
  id: ObjRef;
  name: string;
  parent?: ObjRef;
  features?: ObjRef[];
  description?: string | null;
  exits: Array<{
    id: ObjRef;
    name: string;
    aliases?: string[];
    direction?: string;
    dest?: ObjRef | null;
  }>;
  present_actors: ObjectSummary[];
  contents: ObjectSummary[];
  props?: Record<string, WooValue>;
};
```

`ObjectSummary` should carry enough class/feature data for frame resolution and
component matching:

```ts
type ObjectSummary = {
  id: ObjRef;
  name: string;
  parent?: ObjRef | null;
  ancestors: ObjRef[]; // root -> immediate parent
  features?: ObjRef[];
  owner?: ObjRef;
  location?: ObjRef | null;
  aliases?: string[];
  description?: string | null;
  props?: Record<string, WooValue>;
  catalogState?: Record<string, Record<string, WooValue>>;
};
```

Properties are permission-filtered. Summary fields used only for matching or
frame resolution should be intentionally included by the snapshot builder, not
discovered by arbitrary client object reads.

`ancestors` is required for client-side frame/component resolution. The client
must not recover class distance by reading `state.world.objects[parent]`.

### Snapshot permissions

Snapshot builders are not verbs. They use the presented session actor as the
read principal and apply ordinary property read permissions:

- readable properties carry their value;
- unreadable properties are present as `null` when included in `props`;
- wizard/bypass sessions get the same bypass they get for property reads;
- object summary reads are direct projection reads and do not run
  acceptable/enterfunc-style hooks.

Observations remain audience-filtered by the server; snapshot permissions only
describe the initial/reconnect projection.

Identity fields in `ScopedObjectSummary` (`id`, `name`, `parent`, `ancestors`,
`features`, `owner`, `location`) are intentionally summary fields rather than
ordinary property reads. v1 treats them as public once the object is in the
reader's scoped projection. The access-control boundary is whether the object
appears in `self`, `here`, `inventory`, or an overlay snapshot.

### Snapshot construction cost

Room and inventory snapshots must not become N remote calls per visible object.
Phase 1 includes a bulk summary host RPC:

```text
POST /__internal/object-summaries { read_actor, ids[] }
```

Snapshot builders group refs by host and request one summary batch per remote
host. The same path is used for `here.present_actors`, `here.contents`, exits
that point at remote objects, and `inventory`. Host bridges must support scoped
object summaries; falling back to plain `describeObject` is not sufficient
because summaries need `ancestors` for client frame resolution. A gateway-side
summary cache keyed by object id plus a version signal (`modified`, feature
version, or a future explicit summary version) is a follow-up optimization; it
must be invalidated by renamed/described/feature-changed observations.

### Overlay snapshots

Tool surfaces are fetched explicitly, not bundled into `/api/me` by default.

Candidate endpoints:

```text
GET /api/overlays/pinboard?id=<board>
GET /api/overlays/dubspace?id=<space>
GET /api/overlays/taskspace?id=<space>
```

Or, if the catalog UI model is ready, a generic form:

```text
GET /api/objects/<id>/ui-snapshot?surface=<surface>
```

The generic form is cleaner long-term. The per-tool endpoints are acceptable as
an implementation bridge if they call shared snapshot builders and produce the
same projection input shape.

`/api/me.overlays` can optionally list engaged/restorable overlays:

```ts
type OverlayHandle = {
  subject: ObjRef;
  surface: string;
  restore?: boolean;
};
```

That lets reconnect reopen a tool without preloading every tool snapshot.

### Legacy `/api/state`

Keep `/api/state` during migration for:

- debug/IDE/global object inspection,
- tests that still assert whole-world projection behavior,
- recovery while the new client path is behind a flag.

It should stop being called by production UI boot, movement, and ordinary
observation handling. Longer-term, make it wizard/debug-only or replace it
with paged object-browser APIs.

## Observation contract

After boot, room state changes should arrive through observations. If a fact is
visible in `here`, the mutation that changes it must emit enough observation
data for the client projection to update without refetching the world.

Audit targets:

- `entered` / `left`: update `here.present_actors`; carry actor summary and
  room ids.
- `taken` / `dropped` / `given`: update `here.contents` and `inventory`; carry
  item summary.
- `described` / `renamed`: update visible object summary fields.
- exit creation/removal/change: update `here.exits`.
- feature attach/detach: update summary features for frame/component matching.
- pinboard note add/edit/move/resize/delete: update the pinboard overlay
  projection.
- dubspace `control_changed`, `gesture_progress`, transport/loop events:
  update dubspace overlay/control projections.
- task create/status/claim/close: update taskspace overlay projections.
- `$error`: surface the error through the surface that issued the call. Chat
  input commands show the error in the chat panel; overlay verbs show it in the
  overlay. Reducers must not silently drop sequenced `$error` observations.

Observations that name out-of-scope objects should include display summaries
when the UI needs names. The client should not chase arbitrary refs through a
global object map.

When a call result contains a replacement snapshot, such as `MoveResult.here`,
the framework ingests that snapshot before running reducers for observations
from the same frame. Reducers must tolerate observations whose subject is no
longer the current `here` or whose destination has not been mounted.

## Client model

Replace the current `state.world` production model with:

```ts
type AppProjectionState = {
  self: ObjectSummary | null;
  session: MeSnapshot["session"] | null;
  here: RoomSnapshot | null;
  inventory: ObjectSummary[];
  catalogs: CatalogUiIndex;
  overlays: Record<string, unknown>;
};
```

The raw response from `/api/me` should be immediately ingested into the
framework projection:

```ts
ui.ingestSnapshot({ scope: "me", objects: [self, ...inventory] });
ui.ingestSnapshot({ scope: "here", objects: roomSnapshotObjects(here) });
```

Equivalent overlay loads use:

```ts
ui.ingestSnapshot({ scope: "overlay:pinboard:<id>", objects });
```

### Feature spaces vs `here`

`session.current_location` is the acting location for verbs. `here` is the
primary room context for the shell and room chat. When the current location is
a feature/tool space mounted inside another room, the client resolves `here` to
the nearest containing space whose class chain includes `$room`/`$chatroom` and
loads the feature space as an overlay. In that case `session.current_location`
and `here.id` intentionally diverge.

Chat input binds to the active surface's space, not blindly to `here.id`.
Examples:

- ordinary room view: active surface is `here`, so chat sends to `here.id`;
- pinboard overlay: main tool commands go to the pinboard, while the embedded
  room chat component can explicitly bind to the pinboard's chat space or to
  the parent room depending on the frame declaration.

`ClientProjection.ingestWorld()` can remain temporarily for compatibility, but
the new API should be `ingestSnapshot()`. Snapshot ingestion must only replace
canonical objects in that scope; it must not clear unrelated scopes, and it
must not overwrite live/optimistic layers.

## Standard component read path

Components and controls should read objects only through `WooContext.observe`
or a subscribed equivalent:

```ts
const control = woo.observe(controlId);
const cutoff = Number(control?.props.cutoff ?? 0);
```

They should not read:

- `state.world.objects[id]`,
- `state.world.dubspace[id]`,
- `state.world.pinboard.notes`,
- globally scanned metadata like `buildChatMeta(world)`.

The frame host constructs a bounded neighborhood for each component. A
component may observe only refs in that neighborhood; widening scope is a frame
or overlay decision, not a component escape hatch.

## Optimistic and live-preview controls

Pinboard's local "do not snap back" behavior should become the generic
interaction path.

Call APIs should accept first-class optimistic options:

```ts
type ProjectionCallOptions = {
  optimistic?: {
    id?: string;
    patches: ProjectionPatch[];
    ttlMs?: number;
    reconcile?: "drop_on_applied" | "drop_on_error" | "keep_until_changed";
  };
};
```

Examples:

```ts
woo.directCall(board, "move_pin", [pin, x, y], {
  optimistic: {
    id: `pinboard:${pin}:move`,
    patches: [{ subject: pin, catalogState: { pinboard_note: { x, y } } }]
  }
});
```

```ts
woo.directCall(space, "preview_control", [control, "cutoff", value], {
  optimistic: {
    id: `dubspace:${control}:cutoff`,
    patches: [{ subject: control, props: { cutoff: value } }],
    reconcile: "keep_until_changed",
    ttlMs: 1600
  }
});
```

For continuous gestures, use live preview layers keyed by
`(type, subject, field)` so independent fields do not clobber each other. For
durable calls, associate optimistic patches with the outgoing call id when
possible. On applied frame, reducers run first, then the framework clears or
retains the optimistic layer according to the reconciliation rule. On error,
the framework clears the patch and surfaces the error.

Dubspace is the first non-pinboard proof point. The visual controls and audio
engine should both read effective values from `ui.observe(controlId)`. A
command such as ``filter 500`` and a pointer drag should update the same
effective projection and therefore the same rendering/audio path.

## Deleting global scans

Remove these production patterns:

- `refresh()` after every applied/task/replay frame.
- `scheduleRefresh()` as ordinary live-update handling.
- `buildChatMeta`, `buildDubspaceMeta`, `buildTaskspaceMeta`,
  `buildPinboardMeta` scanning the whole object map.
- `chatRoom()` derived from "first room whose subscribers contains actor".
- control renderers reading raw `state.world` maps.

Replacement rules:

- current room is `state.session.current_location` plus the current `here`
  snapshot;
- active surface comes from the current object's class/features and frame
  resolution;
- overlays are explicit;
- observation reducers update the projection;
- reconnect calls `/api/me` once, then replay catches up sequenced gaps.

## Sequencing plan

### Phase 1: server primitives, no client behavior change

- Add snapshot builders for `ObjectSummary`, `RoomSnapshot`, inventory, and
  overlay subjects.
- Add `/api/me` with cursor/watermark.
- Add `/api/catalogs/ui`.
- Add `here` to movement/entry results while keeping `room` and
  `look_deferred` for old clients.
- Add tests for `/api/me`, room snapshot shape, and move-result `here`.
- Add a minimal debug/smoke consumer that can hydrate `/api/me` behind a flag.
  This prevents the server shape from landing without any client pressure.

Phase 1 closeout risks to carry forward:

- Default `npm test` can be a misleading signal under current load because the
  repository has many per-test 5s timeouts. The Phase 1 work verified cleanly
  with capped workers and a larger timeout:
  `npx vitest run tests --pool=threads --testTimeout=30000 --maxWorkers=1`.
  This mitigation belongs in config/scripts for the default release gate;
  longer-term, split/retime the slow tests.
- The production SPA still has the old global-state path: `/api/state`,
  `scheduleRefresh()`, `build*Meta()` scans, `ensureSpacePresence()`, and many
  `state.world.objects` reads. Phase 1 adds the scoped API but does not remove
  the bounce/snap-back class of bugs until Phase 3/5 switch production reads.
- Frame resolution now has enough data in scoped summaries (`ancestors`), but
  current client frame/class-distance code still reads the global object map.
  Phase 2/3 must move frame resolution to scoped summaries before `/api/state`
  can leave the production path.
- Optimistic/live/sequenced reconciliation must be per-field, not per-subject.
  A live dubspace gesture must not shadow an unrelated sequenced rename, and a
  stale snapshot must not erase an optimistic pin move.
- Feature-space routing remains easy to confuse: `here` is the containing room,
  while the active surface may be `the_pinboard`, `the_dubspace`, or another
  feature space. Chat inputs and mini-chats should target the active surface's
  declared space; ordinary room chat targets `here.id`.
- Room snapshots with remote contents or present actors are real cross-host
  work. Phase 1 has bulk summary RPC coverage, but future phases should watch
  cache/invalidation strategy before making scoped snapshots frequent.

### Phase 2: framework projection completion

Status: implemented in `src/client/framework.ts`, with the production SPA
still mostly on the legacy renderers.

- `ClientProjection.ingestSnapshot(scope, objects)` replaces only that
  canonical scope and preserves unrelated scopes.
- Projection subscriptions notify observers when snapshot, sequenced, live,
  optimistic, or expiry changes affect a ref.
- `ProjectionCallOptions` can attach optimistic patches to `call`,
  `directCall`, and `send`-shaped host APIs.
- Optimistic layers are associated with the outgoing call id and may also use
  an explicit stable optimistic id. Reconciliation currently supports
  `drop_on_applied`, `drop_on_error`, and `keep_until_changed`.
- Sequenced reducers clear only the fields they update from live/optimistic
  layers, so an applied `feedback` change does not erase an unrelated live
  `wet` preview.
- Pinboard move/resize now goes through generic optimistic call options
  instead of a pinboard-only pending-patch map.

Open after Phase 2: `WooContext.subscribeObservations()` is still a spec-level
contract, not an implemented component API, and the SPA still uses
`ingestWorld()` as a compatibility bridge until Phase 3 boots from `/api/me`.

### Phase 3: client scoped-state flag

Status: initial opt-in slice implemented behind `?scopedProjection` (also
accepted as `?api=me`). The legacy `/api/state` path remains the default.

- The flagged client boots and reconnects from `/api/me` plus
  `/api/catalogs/ui`, using `ETag`/`If-None-Match` for the catalog UI index.
- The flagged client builds a small compatibility shell from `self`,
  `session`, `here`, `inventory`, and catalog UI metadata instead of fetching
  `/api/state`.
- The framework ingests `/api/me` as scoped snapshots (`me`, `here`, and
  restored overlay handles).
- The flagged client sends its last cursor on WS auth. v1 server auth replies
  `resumed: false`, so the client hydrates `/api/me` and then requests replay
  from the returned cursor.
- In scoped mode, `scheduleRefresh()` is disabled; applied/task/replay frames
  no longer cause `/api/state` fetches.
- Chat/current-room selectors read the scoped `here` snapshot and session
  locations in scoped mode.
- Direct move/enter results that carry `here` atomically replace the scoped
  `here` snapshot before rendering.
- The scoped replay cursor advances on every sequenced frame the client sees,
  so a reconnect after movement does not replay from the original boot cursor.

Open after this slice: sequenced command results still do not carry return
values in applied frames, so only direct move/enter paths can apply
`result.here` directly. Replay observation reduction is basic and chat-focused.
The scoped `here.present_actors` reducer currently handles `entered` and
`left`; actor summary updates such as renames/descriptions still need generic
summary reducers. The `adaptScopedWorld` object map is a compatibility shim
for legacy renderers and is intentionally not the full world.
Dubspace, pinboard, and taskspace still need Phase 4 overlay snapshots before
the flagged client can replace the production UI end to end.

### Phase 4: migrate controls and overlays

- Migrate dubspace controls/audio to `ui.observe`.
- Migrate pinboard rendering to generic projection state.
- Migrate taskspace to overlay snapshot plus observation reducers.
- Migrate mini-chat/current-room UI to `here` and observation reducers.

### Phase 5: remove legacy production path

- Delete ordinary `scheduleRefresh()` calls.
- Delete production global metadata scans.
- Make `/api/state` debug/IDE-only.
- Remove compatibility `look_deferred` handling when all clients consume
  `here`.

## Tests

Server tests:

- `/api/me` returns only self/session/here/inventory and not global objects.
- `/api/me` returns `cursor.spaces[here.id].next_seq` and object summaries
  include `ancestors`.
- `/api/me` routes current room snapshots cross-host.
- `/api/me` batches remote object summaries for present actors, contents, and
  inventory.
- chatroom -> deck -> hot tub move result includes `here` and correct
  `entered.origin`.
- stale cross-host presence cannot make `/api/me.session.current_location`
  regress.
- room snapshot filters unreadable properties.

Framework/client tests:

- stale snapshot ingestion cannot override active optimistic or live layers.
- dubspace command update and gesture preview read through the same effective
  projection.
- pinboard move/resize uses generic optimistic patches, not pinboard-only
  pending state.
- move result replaces `here` atomically and does not call `/api/state`.
- reconnect calls `/api/me`, ingests scoped snapshots, and replays gaps.
- `/api/me` + WS race: observations emitted after the snapshot cursor are
  replayed exactly once, with no missing or duplicate state.

Regression tests:

- deck -> hot tub does not bounce back to deck.
- `filter 500` updates dubspace UI and audio without a second UI gesture.
- moving a pin does not snap back before applied confirmation.
- mini-chat sends to the current `here.id`, not a stale room inferred from
  subscribers.

## Migration and compatibility

No persistent world migration is required for the client projection work by
itself. It changes browser state shape and REST response additions.

Compatibility requirements:

- Keep `/api/state` until the SPA no longer depends on it.
- After Phase 5, gate `/api/state` as wizard/debug-only or replace it with
  paged IDE/object-browser APIs.
- Keep `room` in move results.
- Keep `look_deferred` until the old client path is removed.
- Additive `/api/me` and `/api/catalogs/ui` routes should not break agents or
  existing REST clients.
- If `RoomSnapshot` includes new catalog-derived fields, they are read
  projections, not stored schema changes.

If a catalog changes observation payloads or object property conventions to
support this, evaluate catalog-local migrations separately under the normal
migration table in `AGENTS.md`.

## Done when

- Normal SPA boot does not call `/api/state`.
- `/api/me` provides cursor/watermark data and object `ancestors` sufficient
  for replay and frame resolution without a global object map.
- Applied/task/replay/live frames do not schedule global state refreshes.
- The current room UI is driven by `session.current_location` and `here`, not
  by scanning all rooms for `subscribers`.
- Chat input targets the active surface's declared space, with ordinary room
  chat using `here.id`.
- Move/enter results hydrate `here` without a follow-up `:look`.
- Dubspace controls, pinboard notes, taskspace items, and chat room UI all read
  through the framework effective projection.
- Optimistic/live-preview behavior is generic and documented in the component
  framework, not pinboard-specific.
- `/api/state` is legacy/debug-only.
- Tests cover the server snapshots, projection layering, and the known
  snap-back/bounce regressions.
