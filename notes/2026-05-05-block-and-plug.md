# `$block` and the plug pattern

Date: 2026-05-05

## Concept

A `$block` is an in-world actor that presents data sourced from outside woo.
It has a fixed location (a "smart window," a wall display, a sensor readout).
Its in-world behavior is read-only from anyone except its bound plug: any UI
can render it because everything it shows is regular `WooValue` properties.

The plug is an outside-world process — typically Python, on-prem or in cloud,
not in a CF DO — that authenticates as the block's actor, pushes data via the
WebSocket API by writing to the block's properties, and either disconnects or
stays attached. Each plug has its own apikey credential.

This is **a presentation layer over a data source**, not the data source. The
analogy is cube.js: the block is a published surface; the actual data lives
upstream wherever the plug points. Many blocks; many plugs; one shape
vocabulary so any UI can render any block.

Plug connection modes:

- **Scheduled / disconnected.** Plug connects on a schedule (e.g., hourly),
  pushes, disconnects. Most blocks. Cheap.
- **Persistent.** Plug holds a long-lived WS, either because it pushes
  frequently (a sensor, a ticker) or because it must answer `:ask` queries
  on demand. While unplugged, conversational queries fail with "block is
  unplugged" and the block falls back to last-pushed data.

A block can be either; the same `$weather_block` class can run in scheduled
mode for the basic forecast and in persistent mode if you want to ask it
about other locations or hours.

## The two concrete first examples

- **Weather block** (`$weather_block`). A "smart window" in the living room.
  Plug calls `tomorrow.io` for the configured location; sets `current`
  (scalar), `forecast` (series, hourly out N hours), `history` (series,
  hourly back N hours), `last_pushed_at`. Default mode: hourly push +
  disconnect. Optional persistent mode: plug stays connected to answer
  `:ask("what's the weather in NYC?")`. Class-specific config props
  (location, units, forecast_hours) are owner-writable.
- **Database block.** A general MongoDB / PostgreSQL plug. Plug holds the
  connection string; pushes named result sets as table-shaped properties.
  Adds `:ask` for free-form natural-language query forwarded to the plug.
  Likely persistent mode by default since queries are interactive.

## In-world model

`$block` is an actor with the following constraints:

- **Anchored.** `:moveto` raises `E_PERM`. `:acceptable(target)` returns false
  except for wizard. The block is fixed at its declared `home`. Same shape as
  catalog-installed furniture; formalize as a `$block` mixin.
- **Own DO per instance.** `host_placement: "self"` on every `$block`
  descendant instance. Each block is independent at the substrate level —
  its eviction, persistence, and observation log are isolated.
- **No history, no sequence.** Property writes ride the **live** observation
  route, not sequenced. They do not enter the space log; reconnects re-read
  the current property values. Blocks with frequent updates do not bloat
  the log, and `/api/me` cursors do not need to track them.
- **Stays put when offline.** Properties persist across plug disconnect.
  Looking at an offline block shows last-set data plus a freshness indicator.
- **Plugged-in is derived, not stored.** Computed from `last_pushed_at` and a
  per-class freshness window (weather: 90 min; ticker: 60s). For persistent
  plugs the indicator also reflects whether a session is currently attached
  (so an attached-but-failing-to-fetch plug shows "plugged in, errors"
  rather than "stale"). No boolean prop.
- **Has an owner.** The actor who created the block. Owner can write
  configuration properties; the plug (acting as the block's actor) can
  write data properties; everyone else is read-only.

## Outside-world model

A plug is a small program that:

1. Connects to woo over WebSocket using an `apikey:` credential bound to the
   block's actor identity.
2. Calls `:set_property(name, value)` or `:set_properties({...})` on its block.
3. Optionally listens for verbs targeted at the block (for `:ask`-style query
   forwarding).
4. Disconnects (or stays attached, idle, if it wants).

A plug can run anywhere with network egress to woo: a laptop, a small VM, a
shared "plug container." It does not run inside a CF DO.

The **plug container** is a separate, simple Python process supervisor. It
reads a `plugs.yaml`, spawns one coroutine per plug, restarts on failure.
The container does not know woo concepts; it just runs N independent plug
clients.

## Auth: actor-bound apikey

Today's `apikey:` is wizard-equivalent and not actor-scoped. Extend it:

- The auth registry stores `apikey` records as `(id, secret_hash, actor)`.
- `authenticate("apikey:<id>:<secret>")` returns a session whose `actor` is
  the registered actor and whose perms are exactly that actor's perms.
- A token can be wizard-bound (existing behavior) or block-bound (new).
- Tokens are minted by `:mint_apikey()` on the block (wizard-only call).
- Rotation is a new `:rotate_apikey()` that mints a fresh token and
  invalidates the prior one. Plug operator pastes the new token into its
  config and restarts.

The plug session has exactly the block's perms — no more, no less. A
compromised plug can corrupt its block's data, nothing else.

## Verbs

Core `$block` verbs (most exposed via MCP `tool_exposed: true`):

- `:set_property(name, value)` — plug or wizard only. Writes one property,
  emits one live observation.
- `:set_properties(values)` — plug or wizard only. Bulk write, atomic, one
  observation. Avoids the N-round-trip pattern weather plugs would otherwise
  invent.
- `:get_data(name)` — for "detail tier" properties not shipped in
  `RoomSnapshot.contents` summary. Direct call; UI mounts and fetches lazily.
- `:look()` — public. Shows name, freshness derived from `last_pushed_at`,
  and a short description. The chat-level inspect of a block.
- `:mint_apikey()`, `:rotate_apikey()` — wizard only.
- `:ask(query)` — **trait, not part of `$block`**. Database block opts in.
  Parked-task pattern: the verb emits a `query` observation, the plug answers
  via `:answer(id, result)`, the parked task wakes. Timeout returns
  `E_TIMEOUT`. Most blocks don't need this and shouldn't pollute the agent
  tool list with it.

Property writability tiers are **enumerated in the class manifest**:

```json
{
  "writable_owner": ["location", "units", "forecast_hours", "label", "theme"],
  "writable_self":  ["current", "forecast", "history", "last_pushed_at",
                     "last_error"]
}
```

- `writable_owner` — set by the block's owner (creator) at create / move /
  reconfigure time. These are the per-class config knobs (the weather
  block's location and units; the database block's connection alias).
  Subclasses extend this list with class-specific config.
- `writable_self` — set by the plug, authenticated as the block's actor.
  These are the data props the UI renders.
- Everything else (`home`, `aliases`, `description`, system props) — wizard
  only. A compromised plug cannot overwrite these. A confused owner cannot
  either.

`:set_property[ies]` consults the appropriate list based on the calling
session's relationship to the block (owner vs self vs other). The substrate
enforces; the catalog declares.

## Data shape vocabulary

Cube.js works because every consumer knows the shape vocabulary. For blocks,
declare a small set of **canonical collection kinds** that generic UIs can
render without class-specific code. Strawman:

```ts
// table-shaped
{ kind: "table", columns: [{name, type}], rows: [[...]] }

// time-series
{ kind: "series", series: [{name, unit, points: [[ts, value], ...]}] }

// scalar with units
{ kind: "scalar", value: 72, unit: "°F", label: "current_temp" }

// geo
{ kind: "geo", points: [{lat, lon, props}] }
```

Block classes declare property schemas in the manifest:

```json
"properties": [
  { "name": "current_temp", "kind": "scalar", "unit": "°F" },
  { "name": "forecast",     "kind": "table",  "columns": [...] }
]
```

Generic `<woo-block>` custom element renders any of these. Specialized d3
components per class override when a richer view is wanted. Plug authors map
their backend shape into one of these kinds.

This is what makes "any UI can render just properties" actually true.

## Observation route

Property writes from the plug emit live observations:

```ts
{ type: "block_data", block: id, name, value, kind?, ts }
```

Audience: the block and the room it anchors. Reducer (default): patch
`projection.observe(block).props[name] = value`. Per-class reducers can do
extra work (animations, derived props) but the default is one line.

Live route means: not in the space log, not sequenced, no replay. A reconnect
just re-reads the current property values via `/api/me`'s `here.contents`
summary plus on-demand `:get_data` fetches.

## Property visibility tiers

With own-DO-per-block, each block in a room is a cross-host summary read
during `RoomSnapshot.contents`. With ten blocks in a room, that is ten
parallel host-bridge calls. To keep this bounded:

- **Summary tier.** Always inline in `RoomSnapshot.contents[].props`. Bounded
  to a few hundred bytes per block (name, kind, headline value, unit,
  `last_pushed_at`).
- **Detail tier.** Behind `:get_data(name)` direct call. Mounted UI fetches
  detail when the block surface is actually visible/focused.

Block class manifests declare which props belong to which tier. The substrate
filters `RoomSnapshot` accordingly. A block whose summary props exceed a few
hundred bytes is a manifest authoring error.

## Topology summary

```
+-------------------+     apikey ws      +-----------------+
| Plug container    |  <--------------> | Per-block DO    |
| (Python, on-prem) |  set_properties   | (CF DO, "self") |
| weather plug      |  block_data live  |   props         |
| mongo plug        |  observations     |   verbs         |
| ...               |                   +--------+--------+
+-------------------+                            |
                                                 | anchored
                                                 v
                                       +---------+---------+
                                       | Room DO           |
                                       |  (the_living_room)|
                                       |  contents include |
                                       |  block summaries  |
                                       +-------------------+
```

## Persistent-WS blocks: scaling

A "live" or persistent block is one whose plug holds a long-lived WS
connection (high-rate data, on-demand `:ask`, or both). At ten of these the
substrate doesn't notice. At ten thousand, several costs need explicit
attention.

### Connection plane

Plug WS connections terminate at the gateway worker. CF Workers cap concurrent
connections per instance, but the **hibernating WebSocket API** is the right
shape: an idle WS sits at near-zero cost; the DO behind it can hibernate
without dropping the socket; a message wakes the DO. That converts the cost
from "always-on connection count" to "active push rate."

Implication: a quiet ticker (1 push/min) at 10k blocks costs ~10k tiny wakeups
spread over a minute. A noisy ticker (10 push/sec) at 100 blocks costs 1000
wakeups/sec — DOs stay warm. Match plug cadence to the class's actual data
freshness need; the cost gradient is steep.

### Per-DO storage write rate

`:set_property` persists. CF DO storage has a per-DO write throughput ceiling
(transactional, sub-millisecond at low rates, much slower under contention).
A 10Hz plug writing five props per push = 50 writes/sec to one DO, into the
range where storage becomes the bottleneck.

Add an **ephemeral property tier**: properties marked `ephemeral: true` live
in the DO's in-memory map only, never persist. On DO eviction they are gone;
the plug's next push re-populates them. For high-rate live data this is the
correct semantics — the data is upstream-of-truth, the block is a cache.

```json
"properties": [
  { "name": "current_price", "kind": "scalar", "ephemeral": true },
  { "name": "history",       "kind": "series", "ephemeral": false }
]
```

The substrate skips the storage write for ephemeral props. Cold DO returns
last-persisted data + the "unplugged" indicator until the plug catches up.

### Observation fan-out

Live observations don't enter the space log, so write cost is bounded. But
fan-out is still O(audience) per push. A block in `the_chatroom` with 50
subscribers, pushing 10Hz, generates 500 frames/sec from one block. Ten such
blocks: 5000 frames/sec.

Three mitigations, in order of complexity:

1. **Audience cache.** The room DO already computes audience for live
   observations. Memoize the audience list per `(space, version)` and reuse
   until membership changes. Eliminates per-push audience recomputation.
2. **Focused-audience tier.** Live observations from a high-rate block go
   only to subscribers who have **focused** the block in the last N seconds
   (the `woo_focus` mechanism already exists). The block emits "focused
   actor entered/left audience" events; the audience set is dynamic. Idle
   observers in the same room don't get the firehose.
3. **Pub/sub split.** If a block pushes at >1Hz to >100 subscribers, peel
   the live channel out of the substrate-routed observation path entirely
   and ship it through CF Pub/Sub or a dedicated WebSocket fan-out DO. Use
   the substrate for sequenced events only. Defer until measurement
   demands it.

Most blocks won't need any of this. (1) is cheap and worth doing
preemptively. (2) is the right answer for things like dashboards in busy
rooms. (3) is for genuinely demanding cases.

### Cross-host audience for live blocks

Block-DO pushes; audience lives on the room-DO. Computing audience requires
a cross-host read each time, *unless* subscribers are mirrored. Use the
existing space_subscriber mirror, refreshed on subscribe/unsubscribe events.
The block-DO holds a local view of the room's subscribers and fans out
locally. Already the pattern for cross-host space audiences; nothing new
needed for blocks.

### Reconnect storms

Gateway eviction or rolling deploy disconnects every persistent plug
simultaneously. Without backoff + jitter on the plug side, all 10k plugs
reconnect within the first second. The plug container must implement
randomized backoff (e.g., 1–60s uniform jitter on first attempt, exponential
on subsequent failures). Server-side: rate-limit reconnect-auth at the
gateway to a sane per-second ceiling.

### Per-plug DO cold-start cost

Each block's DO has its own bootstrap (catalog state hydrate, session record
re-create). At 10k blocks across several rooms, simultaneous cold start
under traffic produces a thundering herd. Practical mitigations:

- Lazy mount: a block's DO only cold-starts when its data is actually read
  (someone enters the room and `RoomSnapshot.contents` reaches it, or its
  plug pushes). Idle blocks stay hibernated.
- Bootstrap leanness: `$block` and its descendants should compile to small
  woocode. Heavy class state lives at runtime, not at bootstrap.

### Numbers we should validate

Before committing to "every block its own DO" at scale, run a smoke test:

- 1000 blocks, each with a persistent plug pushing 1 small property/min.
  Measure: WS overhead, DO hibernation behavior, observation fan-out CPU,
  storage write rate.
- 10 blocks, each pushing 10 props/sec. Measure: per-DO storage saturation,
  audience-fan-out cost, plug-side backpressure.
- 1 block pushing 100Hz with `ephemeral: true`. Measure: with no storage
  writes, where does the next bottleneck land?

These three points cover the cost regimes: many-quiet, few-loud, single-very-loud.
Without them the design's "own DO per block" choice is taken on faith.

## Owner and creation

Block creation is just `@create_instance $weather_block`. The standard
authoring/builder verbs apply. After creation, the owner sets configuration
properties (`location`, `units`, ...) using `:set_property` (their session,
their actor as `caller`, the prop in `writable_owner`).

Then the owner mints an apikey via `:mint_apikey()` (wizard-only or
owner-only — see open decisions) and pastes the token into the plug
container's config. The plug starts; data appears.

Reconfiguration is the same path: `:set_property` on a config prop. If a
config change requires the plug to re-fetch (e.g., `location` change),
either:

- The plug subscribes to observations on its own block and reacts to a
  `block_config_changed` observation by re-fetching;
- Or the substrate emits `:reconfigure(prop_name, new_value)` as a sequenced
  observation the plug listens for.

The first is simpler — the plug already gets observations for any `:set_property`
call, including its own, so it can filter by who-set-it.

Class-specific config props are declared in the class manifest's
`writable_owner` list. Subclasses extend the parent's list. The weather block
adds `location`, `units`, `forecast_hours`; the database block adds
`connection_alias`, `default_collection`. Generic block UIs render an
"owner config" panel dynamically from the manifest; class-specific UIs can
override.

## Open decisions

These need explicit answers before or during implementation. Each is small
on its own; together they shape the contract.

1. **Apikey extension semantics.** Confirm the existing `apikey:` table can
   carry `(actor, perms_class)` cleanly, or whether a parallel `block:`
   token class is less invasive. Either works; pick one.
2. **Property schema validation.** Should the substrate validate writes
   against the declared kind/columns, or trust the plug? Probably validate
   on write with a clear error so the plug fails loud during development.
3. **Summary vs detail boundary enforcement.** Is the few-hundred-byte
   summary cap enforced by the substrate (truncate or reject), or by
   convention (manifest-author discipline)? Lean toward enforced.
4. **`:ask` parking timeout default.** 30s? Per-class overridable? Probably
   class-level with a 30s default.
5. **Concurrent plug sessions per block.** First-mover-wins, last-write-wins,
   or reject? Lean reject (an apikey with one active session at a time;
   second connect closes the first). Avoids racing writers.
9. **Who can mint a plug apikey?** Wizard only (safer), or owner of the
   block (more ergonomic for end-users)? Lean owner — minting a key for a
   block you own is the natural flow, and the token's perms are bounded to
   that block. Wizard retains override.
10. **Ephemeral property semantics under detach.** When a plug detaches from
    a block with ephemeral props, do the in-memory values stay until DO
    eviction, or clear immediately? Lean stay-until-eviction; UI shows
    "stale" via freshness, value is still last-known.
11. **Audience tier for high-rate blocks.** Default: room-wide audience.
    Per-class opt-in to focused-only audience? Or always focused-only for
    `ephemeral: true` props? Decide before the first 10Hz block ships.
12. **Reconfigure protocol.** Plug listens to its own block's observations
    and reacts to owner-set config changes (preferred), or substrate emits
    a typed `:reconfigure` event? First is simpler; lean first.
6. **Plug observability.** The block's `:look` shows freshness. Does it also
   show the plug's last error? Probably yes — a `last_error` property the
   plug writes when fetch fails, surfaces in `:look` as "stale, last
   attempt errored: <msg>."
7. **Generic vs class-specific UI ordering.** When both exist, which wins?
   Catalog UI manifest already has a frame-resolution distance; class-specific
   should outrank generic. Confirm this works for the block frame surface.
8. **Block placement primitives.** Today catalog manifests pin blocks via
   `home: the_living_room`. For runtime placement (`@create $weather_block
   in the_kitchen`) the standard authoring tools should already cover it,
   but worth a smoke test.

## Build order

1. **Actor-bound apikey.** Extend auth registry to record `(id, hash, actor)`
   and have `authenticate` return a session with that actor and its perms.
   Test: a non-wizard apikey can call its actor's verbs and nothing else.
2. **`$block` parent class.** Anchored verbs (`:moveto` raises,
   `:acceptable` wizard-only); `:set_property`, `:set_properties`,
   `:get_data`, `:look`; `:mint_apikey`, `:rotate_apikey`.
   `writable_self` and `writable_owner` enforcement.
3. **Live route for `block_data` observations.** Reuse the dubspace-preview
   path; emit one observation per `:set_property[ies]` call.
4. **Canonical kinds and generic `<woo-block>`.** Ship `table | series |
   scalar | geo` recognized in the catalog UI registry. Generic component
   renders any of them; falls back to text dump for unknown kinds.
5. **Property visibility tiers.** Manifest-declared summary vs detail. The
   `RoomSnapshot.contents` builder filters; substrate enforces the size cap.
6. **Ephemeral property tier.** `ephemeral: true` skips persistence. Cold
   DO returns last-persisted (or absent) data; plug repopulates on next push.
7. **Weather block + Python plug.** End-to-end. Catalog ships the class,
   manifest, generic + class-specific UI, and the plug script as a sibling
   artifact. Scheduled mode first; persistent mode + `:ask` second.
8. **Plug container.** Separate small repo. `plugs.yaml`; spawn one
   coroutine per entry; supervise restarts; randomized reconnect backoff;
   opaque to woo concepts.
9. **Audience cache for live observations.** Memoize per `(space, version)`.
   Validate via a small load test (10 blocks, 10Hz, 50 subscribers).
10. **Database block.** Mongo or Postgres plug. Forces table and series
    shapes through real-world data. Adds `:ask` as a trait, parked-task
    pattern, with `E_TIMEOUT`. Persistent mode by default.
11. **Scaling smoke tests.** The three-point grid in the scaling section.
    Don't ship the design as production-ready until those numbers are known.

Steps 1–4 are the minimum vertical slice. Step 1 is the actual blocker —
the rest is straightforward catalog work once auth is right.

## Deferred

- **Externalized blob storage** for the database block's "huge result set"
  case. Today everything fits in props; the day a query returns multi-MB
  data, we need a content-addressable blob store. Worth designing the
  primitive before the second large-data plug forces it.
- **Block composition / dashboards.** A "dashboard block" that aggregates
  data from N widget blocks. Pure woocode read of other blocks' props; no
  new substrate. The interesting question is layout — `$dashboard_block`
  vs `$widget_block` as size hints in the catalog UI manifest. Defer until
  one is actually wanted.
- **Pub/sub for very-high-fanout blocks.** If a block sustainably pushes
  >1Hz to >100 subscribers, peel its live channel out of the
  substrate-routed observation path and ship it through CF Pub/Sub or a
  dedicated fan-out DO. Defer until measurement demands it; (1) and (2)
  in the scaling section likely cover real workloads.
- **Connection-mode hint.** A class-level declaration `connection_mode:
  "scheduled" | "persistent" | "either"` would let the substrate make
  smarter hibernation/audience choices and let the UI render "expected
  always-on" vs "expected hourly" indicators differently. Defer; can be
  inferred from `ephemeral: true` props for now.
- **Block-to-block subscription.** A dashboard listening to widget blocks'
  `block_data` observations. Mostly a client-projection concern — the
  framework reducer already supports patching arbitrary subjects.
- **Cross-version plug ↔ block compatibility.** Plug declares its supported
  block-class versions; mismatches surface in `:look` as "incompatible
  plug." Defer until the first breaking schema change.

## Why "presentation, not source" matters

The block does not store history, does not query upstream, does not own the
data lifecycle. It is the published shape — last write wins, freshness is a
timestamp, missing data is a UI fallback. This makes:

- the substrate small (no new persistence model, no new query engine);
- plugs trivial to write (auth, push, done);
- UIs uniform (one shape vocabulary);
- the world coherent under partial failure (plug down ≠ world down).

Composition (dashboards, derived metrics, dataflow) is a layer above this
that reads block surfaces. Keep that layer outside `$block` itself; the
substrate just publishes shapes, and downstream consumers — woocode verbs,
client components, agents via MCP — compose them.
