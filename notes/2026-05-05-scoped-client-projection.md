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

### `GET /api/catalogs/ui`

Returns installed catalog UI metadata only: aliases, catalog names, versions,
UI manifests, module entries, and integrity metadata. It should be version or
ETag cacheable. Catalog UI code loading remains separate from actor state.

The existing catalog endpoints can remain for wizard/admin/catalog-management
flows; this endpoint is the ordinary browser boot path.

### Move and enter results

`$room:enter`, `$exit:move`, and equivalent mounted-space entry verbs should
return a self-contained room update. Preserve `room` as the room id for
backward compatibility; add `here` as the snapshot and retire
`look_deferred`.

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

Observations that name out-of-scope objects should include display summaries
when the UI needs names. The client should not chase arbitrary refs through a
global object map.

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
- Add `/api/me`.
- Add `/api/catalogs/ui`.
- Add `here` to movement/entry results while keeping `room` and
  `look_deferred` for old clients.
- Add tests for `/api/me`, room snapshot shape, and move-result `here`.

### Phase 2: framework projection completion

- Add `ingestSnapshot(scope, objects)`.
- Add projection subscriptions.
- Add optimistic call options to `WooContext.call`, `directCall`, and `send`.
- Add reconciliation by call id and by explicit optimistic id.
- Move pinboard pending-patch helpers onto generic optimistic patches.

### Phase 3: client scoped-state flag

- Add a client flag that boots from `/api/me`.
- Render chat/current room from `state.here`.
- Replace move handling with atomic `state.here = result.here`.
- Keep `/api/state` fallback available during this phase.

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
- `/api/me` routes current room snapshots cross-host.
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
- Applied/task/replay/live frames do not schedule global state refreshes.
- The current room UI is driven by `session.current_location` and `here`, not
  by scanning all rooms for `subscribers`.
- Move/enter results hydrate `here` without a follow-up `:look`.
- Dubspace controls, pinboard notes, taskspace items, and chat room UI all read
  through the framework effective projection.
- Optimistic/live-preview behavior is generic and documented in the component
  framework, not pinboard-specific.
- `/api/state` is legacy/debug-only.
- Tests cover the server snapshots, projection layering, and the known
  snap-back/bounce regressions.

