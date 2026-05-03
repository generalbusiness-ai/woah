# Performance Hotspots: Granular Work Through Broad Paths

Date: 2026-05-02

Context: after the dirty-slice persistence work, a one-property `set_control`
call now persists only `the_dubspace.next_seq`, the changed control property,
and the log outcome. This note lists other places with the same smell: one
small operation fans out through a broad persistence, RPC, enumeration, or UI
refresh path.

## Highest-Leverage Candidates

### 1. Browser `/api/state` Full Refresh After Small Events

Shape:

- Client WebSocket `applied`, `task`, and `replay` handlers call `refresh()`.
- Pinboard/dubspace live observations also call `refresh()`.
- `refresh()` fetches `/api/state`, and `world.state(actor)` enumerates every
  object and every visible property before the SPA projects chat/dubspace/
  pinboard/taskspace.

Why it matters:

- One note move, slider commit, room enter, or task status update can rebuild
  the full browser state tree.
- Cost multiplies by connected browser clients.
- As catalogs become installable, this becomes unbounded: the SPA only needs
  the active app projection, but the endpoint ships the whole world.

Good next shape:

- Add `state_projection` metrics: build ms, object count, property count, JSON
  bytes.
- Stop unconditional refresh after every applied frame. Apply observations
  locally where the observation already carries the changed state.
- Add scoped state endpoints/projections: `chat`, `dubspace`, `pinboard`,
  `taskspace`, `object?id=...`, eventually catalog-declared renderer state.
- Debounce remaining full refreshes per client. Full refresh is recovery, not
  the normal live update path.

### 2. Remote Look / Match Metadata Is One RPC Per Object

Shape:

- `composeRoomLook()` gathers room contents and calls `lookEntryFor()` per
  visible item.
- **Fixed in current worktree:** remote items can use `describeObjects()`, which
  batches `name`/`description`/`aliases` reads by host for both room look and
  command matching.

Why it matters:

- A room with 20 visible objects on the same remote host still costs up to 20
  internal fetches.
- This is exactly the "small room look through expensive granular calls" shape.

Good next shape:

- Keep extending the same batch-read pattern to future inspector projections.
- Use `cross_host_rpc` and `compose_look.remote_describe_batches` metrics to
  confirm one room look pays one describe RPC per remote host.

Instrumentation gap:

- Existing `compose_look` now logs `remote_titles`,
  `remote_describe_batches`, `contents_count`, and ms. Exact CF subrequest
  counts can be confirmed through `cross_host_rpc` route counts.

### 3. Cold Route Resolution Is Serial Per Object

Shape:

- `hostForObject()` memoizes within one operation and `routeCache` memoizes
  across operations on a DO.
- Cold paths still call Directory one object at a time.
- MCP enumeration groups `enumerateRemoteTools()` by host, but it first
  resolves each candidate ID individually.

Why it matters:

- Tool listing, room matching, and look projections can start from many object
  IDs.
- On a cold DO, route lookup can become N Directory fetches before the useful
  batched work even starts.

Good next shape:

- Add Directory `/resolve-objects` and bridge `hostsForObjects(ids, memo)`.
- Callers that already have an ID list should resolve all routes in one
  Directory RPC, update `routeCache`, then group by host.
- Emit `route_resolution` metrics: ids requested, cache hits, directory RPCs,
  ms.

### 4. Movement / Containment Still Persists Whole Objects

Shape:

- `moveObjectOwned()` changes one object's `location`, then mirrors old/new
  container contents.
- `mirrorContents()` updates one contents edge but persists the whole container
  object.
- `createObject()` persists the new object, parent, and location with
  `saveObject()`.
- `chparent`, object creation, and room take/drop are all logically edge/header
  updates but still fall through whole-object persistence for some slices.

Why it matters:

- Rooms and players are likely to accumulate contents.
- A simple `take lamp` should be: update one object header and two contents
  edges. Today the storage shape can still be: rewrite the moved object and
  rewrite containers.

Good next shape:

- Extend dirty tracking beyond properties:
  - dirty object header / location (`saveObjectInfo` or `setObjectLocation`)
  - dirty content edge (`addContent` / `removeContent`)
  - dirty child edge (`addChild` / `removeChild`)
  - dirty verb (`saveVerb` / `deleteVerb`)
  - dirty schema (`saveEventSchema` / `deleteEventSchema`)
- Use these in move, mirror, create, chparent, verb install, and schema edits.
- Keep `saveObject()` as bootstrap/import fallback and as "object shape changed
  too broadly" escape hatch.

Instrumentation gap:

- `storage_flush` should eventually split `objects` into `object_headers`,
  `content_edges`, `child_edges`, `verbs`, and `schemas`.

### 5. Deferred Host Effects Are Multiple Cross-Host Fetches

Shape:

- A cross-host room movement can defer several effects: actor presence, space
  subscriber, owner move, contents mirrors.
- `applyDeferredHostEffects()` applies each effect separately.

Why it matters:

- This was already visible in the room-transition depth-limit work.
- The semantic shape is a batch: "apply these host-local mirror/presence
  changes after the behavior settles." Sending each as a separate RPC pays the
  fixed internal-fetch cost repeatedly.

Good next shape:

- Add `HostBridge.applyEffects(effects)` grouped by destination host.
- Add `/__internal/apply-effects`, with one host transaction/savepoint per
  host-local batch.
- Preserve the current semantics: these are cache/presence/mirror effects, not
  a new cross-host atomic transaction.

### 6. MCP Tool Listing Still Enumerates Before Paging

Shape:

- `listTools()` computes the full filtered tool list, then slices by cursor.
- Remote enumeration can return descriptors for selected IDs and expanded
  space contents, then the gateway filters/dedupes.
- The recent digest fix stopped the list_changed storm, but explicit
  `tools/list` can still be broad.

Why it matters:

- Tool lists grow with world size, catalog count, focused spaces, and task
  objects.
- MCP clients may call `tools/list` often, and large responses are expensive
  for both CF and the model context.

Good next shape:

- Cache tool-list pages per session/scope/query using the existing digest as
  invalidation.
- Make remote enumeration page-aware or query-aware so remote hosts do not
  compute descriptors the client will not receive.
- Keep `woo_call` / `woo_tools_for` as the compact path for agents that know
  roughly what object they want.

Instrumentation gap:

- Add `mcp_tool_list` metric: scope, selected IDs, remote IDs, descriptors
  built, returned tools, JSON bytes, ms.

### 7. Object Route Publishing Scans the Whole World

Shape:

- After an applied frame on the world host, `registerIncrementalObjectRoutes()`
  calls `world.objectRoutes()`.
- `objectRoutes()` scans every object and computes placement for all of them.

Why it matters:

- Most applied frames do not create self-hosted objects.
- Route registration is recovery/bootstrap work plus object-creation work, not
  every-call work.

Good next shape:

- Track route dirtiness when objects are created or `host_placement` changes.
- Register only newly self-hosted objects/anchors from the dirty route set.
- Keep full `objectRoutes()` for boot recovery and diagnostics.

### 8. Session Reap / Active-List Cleanup Scans All Objects

Shape:

- Guest/session cleanup walks every object to remove the actor from `operators`
  lists and clears focus/presence state.

Why it matters:

- This is not hot during normal interaction, but churny MCP/browser sessions can
  make it visible.
- It also writes live-ish state into persistent properties.

Good next shape:

- Keep reverse indexes for active lists (`actor -> spaces/operators/focus`) or
  move this state toward a live/session-state table.
- At minimum, emit `session_reap` metrics: scanned objects, mutated lists,
  writes, ms.

## Suggested Next Implementation Batch

1. Add read-path metrics:
   `state_projection`, `remote_describe_many`/`remote_describe_rpc_count`,
   `route_resolution`, and `mcp_tool_list`.
2. Implement `describeObjects` batching. This is low-risk, reuses an existing
   permission shape, and improves both room look and command matching.
3. Implement Directory batch route resolution. This compounds with
   `describeObjects` and MCP enumeration.
4. Implement containment/header dirty slices. This is the storage analogue of
   the property dirty-slice work and should make movement/create/chparent cheap.
5. Stop browser full-state refresh as the default live-update path.

The highest immediate confidence win is `describeObjects` + batch route
resolution: it attacks the deployed cross-host UX path without changing object
semantics. The highest eventual cost win is scoped browser state, because every
connected UI currently pays for global projection after small updates.
