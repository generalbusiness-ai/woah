# `$block` and the plug pattern

Date: 2026-05-05

## Concept

A `$block` is an in-world actor that bridges woo to an outside-world data
source or system. It has a fixed location (a "smart window," a wall
display, a sensor readout, a vending machine). Its data values come from
upstream — woo is not the source of truth, the plug is — but the block
exposes a normal woo surface: properties, verbs, perms, observations.

The plug is an outside-world process — Python, Rust, TypeScript, or
anything else that can speak the WS API — running on-prem or in cloud, not
in a CF DO. It authenticates as the block's actor, pushes data by writing
the block's properties, and answers query/command verbs the block exposes.
Each plug has its own apikey credential. Python is convenient for the
example plugs because it speaks databases, APIs, and ML stacks easily; the
choice of language has nothing to do with the substrate.

The plug doesn't have to be a deterministic data fetcher. It can be an LLM
agent driving the block: a research-report vending machine, a conversational
database, a long-running synthesis tool. From woo's side, all plugs look the
same — they just speak the WS API.

This is **a presentation/bridge layer over an outside system**, not the
system itself. The analogy is cube.js: the block is a published surface;
the actual data and behavior live upstream. Many blocks; many plugs; one
shape vocabulary so any UI can render any block.

### What "read-only" means

Most data props are read-only to non-plug actors: the values come from
upstream, only the plug authors them. But blocks can also be interactive in
the normal woo sense:

- **Config / control props** are owner-writable (`writable_owner`). The
  weather block's `place` (which city to fetch), the database block's
  `connection_alias`, a vending machine's `prompt_template`. The plug
  observes its own block's prop-write observations and reacts to control
  changes. (Config props must not collide with substrate-reserved names
  like `location`, `home`, `aliases`.)
- **Query / command verbs** are public (or per-class). `:ask` forwards a
  free-form query to the plug. `:order` enqueues work for the plug. These
  create reactive plug behavior without bypassing the read-only-data
  invariant.
- **Subclass-level interactivity** is allowed. A `$block` subclass can ship
  arbitrary public verbs that mutate its own state, take actor input, or
  produce artifacts (notes, files, other objects). The base class just
  publishes data; subclasses extend the contract.

So the invariant is sharper: **the substrate doesn't author the data, but
the substrate fully owns the surface**. That's what makes blocks composable
with the rest of woo.

### Relationship to the LambdaMOO interactive-toy idiom

The "publishes state with rich in-world verbs and observations" part of
`$block` is not new — it's the LambdaMOO interactive-toy pattern. A
generic contraption (LambdaMOO `#4528`) ships verbs like `pull`,
`activate`, `do_interaction` and per-instance state pools (charm shapes,
colors, non sequiturs, year-by-year usage history); a player invokes a
verb in-world, the contraption picks a new variant, updates state,
announces. The Underground Cowsino (`#1249`) is the same idiom at room
scale — 25 verbs and 25 properties for banking, accounts, games, all
mutated in-world.

What `$block` adds is the **external authenticated principal** writing
data via apikey: a long-lived non-actor process pushes state into the
object from outside. Everything else — anchored placement, subclass
verbs, owner-set config, observations on state change, rich UI bound to
properties — is just the toy pattern.

Implication: don't re-invent the toy idiom. `$block` specializes it for
the external-source case. Subclasses that want pure in-world
interactivity (no plug, just verbs that mutate self-state) are doing
exactly what generic contraption did, on the woo substrate.

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

## Scope: what we will actually build

Two base classes, two demo instances. Everything else is open-ended in
this note but explicitly out of scope for now.

**Base classes**

- `$block` — anchored data-display actor. Live property writes from a
  plug; canonical shape vocabulary; owner-writable config; no sequencing
  in the base.
- `$dispenser_block` — `$block` subclass that produces artifacts. Adds
  the parked-task `:order` / `:deliver` pattern, sequenced
  `order_placed` / `delivered` events, and `$note` creation with
  back-references.

**Demo instances**

- **Weather block** (`$weather_block`, in the living room). Plug calls
  `tomorrow.io` for the configured `place` (an owner-writable string like
  "Mountain View, CA"); sets `current` (scalar), `forecast` (series,
  hourly out N hours), `history` (series, hourly back N hours),
  `last_pushed_at`. Scheduled mode: hourly push + disconnect.
- **Horoscope vending machine** (`$horoscope_block`, on the deck). A
  `$dispenser_block`. You `:order("scorpio")` (or some other prompt)
  and a few seconds later receive a `$note` containing the horoscope.
  Plug is a tiny LLM. The system prompt is a property on the block —
  owner-writable — so the same plug code drives whatever character the
  machine is configured to be.

These two demos exercise: scheduled push, owner config, sequenced order
flow, parked-task delivery, note-as-output with back-reference, and CF
Worker-hosted plugs end-to-end. Nothing else is required to validate the
pattern.

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

## Credential management

This is the single most important operational topic and gets its own
section. Plug credentials live outside woo (in the Worker's environment)
and the lifecycle has to be deliberate.

### What's already there

`apikey:` is already actor-bound:

- `$system.api_keys[<id>] = { hash, salt, actor, label, created_at }`
  — actor field has been there from the start
  (`src/core/world.ts:1005, 1014–1018`).
- `authenticate("apikey:<id>:<secret>")` resolves the record and returns a
  session via `createSessionForActor(actor, "apikey")`
  (`src/core/world.ts:983–1002`). The session's perms are exactly the
  actor's perms.
- `$system:create_api_key(actor, label?)` and `:revoke_api_key(id)` exist
  as wizard-only natives (`src/core/bootstrap.ts:404–406`).
- Tokens are opaque random secrets; salt + hash on disk, plaintext shown
  exactly once at mint.

So **actor-bound apikey is not the blocker**. What still needs to land:

### What's missing

- **Owner minting.** `create_api_key` is `canBypassPerms`-gated (wizard
  only). For blocks, the block's owner must be able to mint a key for
  *that block's actor*. New verb on `$block`:
  `:mint_apikey(label)` — caller must be `this.owner` or wizard, target
  is `this`. Calls into a less-restrictive variant of `createApiKey` that
  permits "owner of target" rather than "wizard only."
- **Durable `revoked_at`.** Today `revoke_api_key` deletes the record
  (`src/core/world.ts:1028`). For audit and observability, mark
  `revoked_at: <ts>` instead and have `authApiKey` reject records with a
  non-null `revoked_at`. List/inspect APIs return both live and revoked
  records.
- **Session teardown on revoke.** Today the doc-string explicitly says
  "Existing sessions minted from this key persist until their TTL"
  (`src/core/bootstrap.ts:405`). For a real revocation story (suspected
  leak), revoke must walk the session table and close any session whose
  apikey id matches. Add an `apikey_id` field on apikey-class sessions so
  this lookup is O(sessions) and trivially correct.
- **`last_seen_at`.** Each successful `authApiKey` should write
  `record.last_seen_at = Date.now()`. Surfaces in `:list_apikeys` and on
  the block's `:look` ("plug last seen 2 minutes ago"). Needed both for
  ops debugging and as the durable basis for the freshness indicator
  when a plug disconnects between pushes.
- **KDF upgrade.** Today `hashSource` is a fast hash
  (`src/core/world.ts:1000, 1012`). For credential storage that should be
  argon2 or scrypt with sane parameters. Migration: existing records keep
  the old hash format, are upgraded on next successful authenticate.
- **Owner-facing UX.** The `$block:mint_apikey` flow should return the
  secret in a structured form the owner can paste verbatim into
  `wrangler secret put`. The block's `:look` should surface "configured /
  active / stale / never seen" states cleanly. `:list_apikeys` for owner
  scope (returns only keys for actors the caller owns).

### Provisioning flow

Owner-driven. The block is the unit of credential management.

1. Owner creates the block: `@create_instance $horoscope_block`.
2. Owner sets configuration props: `:set_property("system_prompt", ...)`,
   `:set_property("description", ...)`.
3. Owner mints the plug credential:
   ```
   :mint_apikey(label: "horoscope-cf-worker-prod")
   → { id: "ak_…", secret: "…visible-once…" }
   ```
4. Owner pastes the secret into the plug Worker's secret store:
   ```
   wrangler secret put WOO_APIKEY
   ```
5. Owner deploys: `wrangler deploy`. Plug starts, connects, begins
   pushing/listening.

The secret never appears in source control, never appears in logs, never
appears in `:look` output. Only at the response to `:mint_apikey`. If the
owner missed it, mint again.

### Rotation

Two calls: `:mint_apikey` (creates new) followed by `:revoke_apikey(old_id)`
once the new Worker deploy is live. The intermediate window (multiple keys
active) is fine — the substrate is happy with N concurrent valid keys.
Blue/green deploy is the natural pattern.

Rotation triggers:

- Suspected leak.
- Periodic policy (90-day expiry per organization standards, configurable
  per-token; expired tokens reject with a clear `E_AUTH_EXPIRED` error so
  Worker logs surface it).
- Owner change (when a block changes hands; see below).

### Revocation

Three paths:

- **Explicit**: `:revoke_apikey(id)` by owner or wizard. Sets
  `revoked_at`; subsequent `authenticate` calls reject.
- **Block destruction**: when the block is recycled, all its keys revoke.
- **Owner change**: transferring block ownership rotates all keys
  automatically; the prior owner's pasted secrets stop working.

Revocation is immediate and durable. The session table is also walked: any
live session authenticated under the revoked token is closed.

### Storage at rest

- **Server-side**: `secret_hash` only, never plaintext. Argon2 or scrypt
  with sane parameters. Store revocation timestamps for audit (we don't
  delete records — an absent record and a revoked record are distinct).
- **Plug-side**: CF Worker secrets (encrypted at rest by CF, accessible
  only to the deployed Worker). For non-CF deployments, the operator's
  local secret manager — the contract is "the plug can read it, no one
  else can."
- **Owner-side**: never. Owners paste once and forget. If they need to
  re-paste, they rotate.

### Observability

Operators (and owners) need to see credential state to debug "why isn't
this plug working":

- `:list_apikeys()` — owner/wizard. Returns
  `[{id, label, created_at, last_seen_at, revoked_at}]`. No secret.
- `:look()` on the block surfaces the freshest `last_seen_at` across all
  active keys; a stale `last_seen_at` plus an active key means
  "configured but plug not running."
- The auth path records `last_seen_at` on each successful authenticate.

For the Worker side, log lines on connect failure should include the
`E_AUTH_*` error code so operators see "expired" vs "revoked" vs
"unknown id" without ambiguity.

### Open questions

- **Who can mint?** Owner, or wizard only? Lean owner — the token's authority
  is bounded to the block they own, so there's no escalation. Wizard
  retains override.
- **Single-active-key vs many?** Lean many (allows zero-downtime rotation,
  blue/green Worker deploys). The single-session-per-key constraint stops
  racing writers regardless.
- **Per-key perms tier?** Today: token = full block perms. Could later add
  per-key scopes ("this key can only call `:set_property`, not
  `:mint_apikey`") for defense-in-depth. Defer until needed.

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

### Property writability tiers — what's actually new

Property writes today are governed by per-property `r/w/c` permission
letters and the property's `owner`, with wizard bypass. The principal
that matters is the verb's `progr`, plus the calling actor for
ownership-bypass. There is **no current notion of "the calling session's
actor IS this object" or "the calling actor is this object's owner"** as
a write-gate axis. So the tier model is a real schema and
permission-model addition, not just a catalog declaration.

Required pieces, in order of where they land:

1. **Catalog manifest schema.** New optional keys on a class declaration:
   ```json
   {
     "writable_owner": ["place", "units", "forecast_hours"],
     "writable_self":  ["current", "forecast", "history",
                        "last_pushed_at", "last_error"]
   }
   ```
   Both lists name properties defined on the class (or inherited).
   Subclass declarations *extend* the parent's lists; they don't replace
   them.

2. **Installer validation.** Catalog install rejects:
   - Names that collide with substrate-reserved props (`location`,
     `home`, `aliases`, `description`, `parent`, `owner`, `name`, etc.).
   - Names not actually defined on the class chain.
   - The same name appearing in both lists (each prop is in at most one
     tier).
   - A class that declares either tier but doesn't inherit from `$block`
     (the tier model is `$block`-only).

3. **Runtime enforcement point.** A new check in the property-write
   pipeline (the `setPropForActor`-equivalent path), gated by class
   inheritance from `$block`. Pseudo:
   ```
   if not isa(target, $block): use existing perm rules.
   else if name in writable_self_chain(target):
     allow iff session.actor == target  // plug case
   else if name in writable_owner_chain(target):
     allow iff session.actor == target.owner  // owner case
   else:
     fall through to existing perm rules.   // wizard, etc.
   ```
   The two new axes are "session.actor == target" and
   "session.actor == target.owner" — neither exists as a perm primitive
   today.

4. **Tests.** Per tier:
   - Plug-actor session can write `writable_self` props on its own
     block, fails on others' blocks, fails on `writable_owner` props.
   - Owner session can write `writable_owner` props on blocks they own,
     fails on others' blocks, fails on `writable_self` props.
   - Stranger fails on both tiers.
   - Wizard bypasses both.
   - Tier inheritance: subclass tiers union with parent tiers.
   - Manifest-validation negatives: collision, undefined name, both-tier
     name, non-`$block` class.

5. **Migration.** New permission axis means existing `$block`-installed
   instances (none yet) are fine; but if the tier defaults change later,
   re-installs need to adjust. Spec the upgrade path now even though no
   migrations are due in v1.

### Property writability — short version

```json
{
  "writable_owner": ["place", "units", "forecast_hours", "label"],
  "writable_self":  ["current", "forecast", "history", "last_pushed_at",
                     "last_error"]
}
```

- `writable_owner` — owner sets, e.g. `place` and `units` on the weather
  block. Subclasses extend.
- `writable_self` — plug sets via apikey-bound session.
- Everything else — wizard only. Substrate-reserved props
  (`location`, `home`, `aliases`, `description`) cannot appear in
  either list.

`:set_property[ies]` consults the lists based on the calling session's
relationship to the block (owner vs self vs other). The substrate
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

Base `$block` property writes from the plug emit live observations:

```ts
{ type: "block_data", block: id, name, value, kind?, ts }
```

**Audience routing.** A block is an `$actor`, not a `$space`. Per
`spec/semantics/events.md` §12.7, default audience is the source space if
`observation.source` is a `$space` descendant, else the call's space
argument. Without an explicit override, observations from a verb running
on the block reach nobody — there's no room-shaped audience attached.

`:set_property[ies]` therefore routes explicitly:

```woo
observe_to_space(location(this), {
  type: "block_data", block: this, name, value, kind, ts: now()
});
```

The block's containing room (`location(this)`) is the audience. People in
the room see the data update; people elsewhere don't. This is a verb-body
choice, not a substrate change — the primitive already exists.

Reducer (default): patch `projection.observe(block).props[name] = value`.
Per-class reducers can do extra work (animations, derived props) but the
default is one line.

Live route means: not in the space log, not sequenced, no replay. A
reconnect just re-reads the current property values via `/api/me`'s
`here.contents` summary plus on-demand `:get_data` fetches.

**Plug receive path.** A plug session authenticated as the block actor is
**not automatically subscribed** to the block's room. So `block_data`
observations routed to `location(this)` don't reach the plug by default.
That's correct: the plug doesn't need to receive its own writes.

For events the plug *does* need (new orders on a dispenser block), use
the **directed `text` observation** path
(`spec/semantics/events.md §12.7.1`): `tell(this, payload)` queues a
`text` observation to all sessions whose actor is `this` — i.e., all
attached plug sessions, on whatever DO holds those sessions. This is
already a substrate primitive and works cross-DO.

The structured payload rides as the observation's body (a string with
embedded JSON, since the v1 `text` shape is string-only). The plug
parses it, treats it as a wakeup hint, and goes to the queue
(`:next_pending` or `pending_orders`) for the authoritative read. A
future spec amendment can add a directed-structured-event type if this
proves common; for now the queue-as-truth design means string-shaped
wakeups are sufficient.

### Sequencing is per-class

The base class is live-only — that matches the "no history" semantics of
data display. Subclasses opt into sequenced observations for events that
must survive reconnect:

- A vending-machine block emits `order_placed` and `delivered` as
  **sequenced**. An order placed during a brief disconnect should still be
  fulfilled when the client reconnects.
- A long-running task block emits `task_started` and `task_finished` as
  **sequenced**, while progress ticks ride live.
- A weather block stays purely live — no event matters enough to replay;
  if you missed the 3pm push, you can re-look and get the current value.

This is not a substrate change; it's a verb-author choice. Base
`:set_property` calls the live observe path; subclass verbs can call
`observe_to_space(this, …)` directly for events that need sequencing.
Document this in the `$block` class doc-string so subclass authors
understand the default and the override.

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
+--------------------+   apikey ws    +-----------------+
| Plug Worker        | <----------->  | Per-block DO    |
| (CF Worker)        | set_properties | (CF DO, "self") |
| weather-plug       | block_data     |   props         |
| horoscope-plug     | live obs       |   verbs         |
+--------------------+                +--------+--------+
                                               |
                                               | anchored
                                               v
                                     +---------+---------+
                                     | Room DO           |
                                     |  (the_deck etc.)  |
                                     |  contents include |
                                     |  block summaries  |
                                     +-------------------+
```

Each plug is its own CF Worker, deployed independently with `wrangler`. The
plug's apikey is a Worker secret. Cron-triggered Workers handle the
scheduled-push case (weather); fetch-event or persistent-WS Workers handle
the on-demand case (horoscope's `:order` listener).

This keeps the blast radius small (one plug crashes, others are unaffected),
the deploy story simple (`wrangler deploy` per plug repo), and the demo
self-contained on the same provider as woo. Alternative hosting (GCP, a
shared Python container, on-prem) remains possible — the WS API doesn't
care where the plug runs — but isn't part of the build plan.

## Agentic plugs and the queue-and-deliver pattern

A plug is just an authenticated WS client. Deterministic (weather),
reactive (database), or agentic (LLM-driven dispenser) — all identical
from the substrate's view; only cadence and behavior differ.

`fork` / `suspend` parking is planned but not yet in the VM. Even when
it lands, cross-DO parking won't be the v1 shape (R6.2). Either way,
the dispenser pattern below doesn't need it — and the entire pattern is
woocode.

`pending_orders` on the block is the authoritative queue:

1. `:order(request)` appends a record, returns `{order_id, queued: true}`
   synchronously.
2. Plug session (connected as the block actor) sees the new work via
   polling `pending_orders` or via a directed `text` wakeup hint
   (`tell(this, payload)`). Wakeup is optional; queue is the truth.
3. Plug processes outside woo, calls `:deliver(order_id, body)`.
4. `:deliver` removes the entry, creates a `$note`, moves it to the
   orderer's inventory.
5. The note arriving in the orderer's hand is the delivery signal.

Idempotency: `:deliver` is keyed on `order_id`. Lost wakeups don't
matter — the plug catches up from the queue on next poll.

## `$dispenser_block`: the artifact-producing subclass

A `$block` subclass for cases where the plug produces a moving artifact
rather than updating display data.

**Added properties**

- `writable_owner`: `system_prompt` (subclasses extend).
- `writable_self` (plug-writable): `pending_orders` — a list of
  `{order_id, requester, request, ts}` records. Authoritative queue.

**Added verbs**

- `:order(request)` — public. Appends a record to `pending_orders` with a
  fresh `order_id`. Returns `{order_id, queued: true}` synchronously —
  no parking, no awaiting plug work. Emits sequenced
  `{type: "order_placed", order_id, requester, request, ts}` to the
  block's containing room (`observe_to_space(location(this), …)`).
  Optionally emits a directed `text` wakeup to `this` (the block actor)
  so plug sessions see "new work" without waiting for the next poll
  cycle. The wakeup is a hint; the queue is the truth.
- `:deliver(order_id, body)` — plug-only (writable_self perms applied as
  a verb-call gate). Idempotent on `order_id`. Removes the matching
  entry from `pending_orders`, creates a `$note` with `body`, sets
  `produced_by = this` and `produced_at = now()`, moves the note into
  the original requester's inventory. Emits sequenced
  `{type: "delivered", order_id, note: id, ts}` to
  `location(this)`. The note's arrival in the orderer's inventory is
  what they actually see; the sequenced event is for room bystanders
  ("the machine just dispensed something for guest_5").
- `:cancel(order_id)` — requester, owner, or wizard. Removes the entry;
  emits `{type: "canceled", order_id, ts}`.
- `:next_pending()` — plug-only. Returns the oldest queued record (or
  `null`). Convenience for plugs that prefer pulling one item at a time
  rather than walking the whole list.
- `:status(order_id)` — public. Returns the queue entry, or
  `{state: "unknown"}` if not present (it's been delivered or canceled).

The output `$note` carries `produced_by` and `produced_at`. UI renders a
"from: <block name>" chip that links back. That's it for the back-reference
story in v1; richer note interactivity is open-ended.

`order_placed` and `delivered` are **sequenced** so a reconnect during an
order doesn't lose room-visible activity. The queue itself survives any
disconnect — it's a real persisted property — so the plug catches up by
reading state on next poll regardless of which observations it missed.

Why a note instead of a self-prop: notes are portable, have UI/perms
already, and survive multiple orders. The block is a thin producer.

### Horoscope demo

`$horoscope_block` extends `$dispenser_block`. Lives on the deck.

- The owner sets two things: `description` (what the machine looks like)
  and `system_prompt` (what persona it speaks with).
- You `:order("scorpio")` (or whatever). The verb returns immediately
  with `{order_id, queued: true}`; your request is now in the block's
  `pending_orders` queue.
- The plug Worker (woken by a directed `text` hint or its own cron poll)
  reads the next entry, runs `@cf/meta/llama-3.2-1b-instruct` on Workers
  AI with `system_prompt + request`, calls `:deliver(order_id, body)`.
- A `$note` lands in your inventory. That's the visible delivery.

Model choice: `@cf/meta/llama-3.2-1b-instruct` is the smallest
instruction-tuned text-generation model on Workers AI (1B params, ~$0.20
per million output tokens). At ~300–400 tokens output per horoscope, one
order costs roughly $0.0001 — negligible for the demo, well-shaped for
"follow a small system prompt and produce a paragraph or two." If the
output ever feels under-cooked we can move up to `llama-3.2-3b-instruct`
without changing anything else.

That's the whole demo. No `tone`, no `house_style`, no `follow_up_url`
— the plug picks the prompt-and-request shape, the queue lives on the
block, and the note in your hand is how you know it's done. The whole
pattern is woocode plus a small
Worker.

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

The mitigation here is an **ephemeral property tier** — properties that
live in the DO's in-memory map only, skipping persistence — but this is
explicitly **not** demo-path work. It's a substrate feature, not a base-
class flag, because it touches:

- Repository serialization (skip writes for keys flagged ephemeral).
- DO eviction semantics (in-memory only — values disappear on eviction
  and reappear on next plug push).
- `/api/me` / `RoomSnapshot` summary contents (do ephemeral values appear
  in summaries served to a freshly-connecting client? probably yes, with
  a "transient" marker so renderers can tell).
- The client projection `observe()` layering (canonical layer holds
  in-memory transients with no persisted backing; reconnect doesn't
  revive them, only the next plug push does).

Neither demo (weather hourly push, horoscope on-demand order) is in the
high-rate regime that requires this. **Ephemeral is deferred** until a
demo or workload genuinely needs it. The shape sketched here is for
future reference:

```json
"properties": [
  { "name": "current_price", "kind": "scalar", "ephemeral": true },
  { "name": "history",       "kind": "series", "ephemeral": false }
]
```

When the time comes: a property declared `ephemeral: true` skips the
storage write, lives in memory until eviction, gets a transient flag in
summaries; cold DO returns last-persisted (or absent) data with the
"unplugged" indicator until the plug catches up.

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
simultaneously. Plug Workers must implement randomized backoff (1–60s
uniform jitter on first attempt, exponential on subsequent failures).
Server-side: rate-limit reconnect-auth at the gateway to a sane per-second
ceiling. The first-class plug-Worker template should bake this in.

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
properties (`place`, `units`, ...) using `:set_property` (their session,
their actor as `caller`, the prop in `writable_owner`).

Then the owner mints an apikey via `:mint_apikey()` and pastes the secret
into the plug Worker's secret store (see Credential management).
`wrangler deploy` and the plug starts.

Reconfiguration is the same path: `:set_property` on a config prop. If a
config change requires the plug to re-fetch (e.g., `place` change),
either:

- The plug subscribes to observations on its own block and reacts to a
  `block_config_changed` observation by re-fetching;
- Or the substrate emits `:reconfigure(prop_name, new_value)` as a sequenced
  observation the plug listens for.

The first is simpler — the plug already gets observations for any `:set_property`
call, including its own, so it can filter by who-set-it.

Class-specific config props are declared in the class manifest's
`writable_owner` list. Subclasses extend the parent's list. Generic block
UIs render an "owner config" panel dynamically from the manifest;
class-specific UIs can override.

## Open decisions

Things to settle as the build lands. Most have a leaning already.

1. **Owner-mint authorization.** Today `$system:create_api_key` is
   wizard-only via `canBypassPerms` (`src/core/world.ts:1006`). For
   block-owner minting we either (a) split into a new
   `createBlockApiKey(actor, target, label)` that permits "owner of
   target," or (b) generalize `createApiKey` to accept an authorization
   predicate. Lean (a) — narrower surface, easier to audit. Wizard
   retains the broader `:create_api_key` for non-block actors.
2. **Property schema validation.** Validate writes against declared kind?
   Lean yes — fails loud during plug development.
3. **Summary vs detail size enforcement.** Substrate-enforced cap, or
   convention. Lean enforced (truncate-and-warn, not reject).
4. **Order TTL default.** Entries in `pending_orders` that the plug
   never picks up should expire — otherwise a long-offline plug
   accumulates ghost orders. Lean: 1 hour TTL on horoscope (configurable
   per-class). Expired entries get a `:deliver`-equivalent that produces
   a "machine was unattended" note rather than silently vanishing.
5. **Concurrent plug sessions per apikey.** Reject second connect (single
   active session per key) or allow many for blue/green deploy? Lean
   allow-many at the apikey level, single-session-per-block enforced
   separately if at all.
6. **Who can mint a plug apikey?** Owner. Wizard override.
7. **Ephemeral prop semantics** — deferred until needed. When it lands:
   stay until DO eviction; UI marks stale; don't clear on detach. (Not
   on the demo path; weather and horoscope persist normally.)
8. **Reconfigure protocol.** Plug is NOT auto-subscribed to its own
   block's room audience. Two viable shapes: (a) plug re-reads
   `system_prompt` (and any other config) on every poll cycle / order
   processing — fresh state, no observation needed; (b) `:set_property`
   on a `writable_owner` prop additionally emits a directed `text`
   wakeup to `this`. Lean (a) — simpler, matches the queue-as-truth
   pattern. (b) is a perf nicety if reconfigure latency matters.
9. **Plug observability.** `last_error` is a `writable_self` prop the plug
   writes on failure; `:look` surfaces it. Already implied; confirm.
10. **Generic vs class-specific UI ordering.** Frame resolution distance
    handles this; class-specific outranks generic. Smoke test.

## Build order

What we will actually do, in order.

1. **Apikey ops gap.** Actor-bound apikeys already exist. What's missing,
   and is the actual blocker:
   - Owner-minting: a `$block:mint_apikey(label)` verb gated on
     `caller == this.owner` (not wizard-only).
   - Durable `revoked_at` instead of map-delete; `authApiKey` rejects
     records with non-null `revoked_at`.
   - Session teardown on revoke: walk the session table, close any
     session whose `apikey_id` matches.
   - `last_seen_at`: write on each successful `authApiKey`.
   - KDF upgrade: `hashSource` → argon2/scrypt; legacy records upgraded
     on next successful authenticate.
   - `:list_apikeys` scoped to "keys for actors I own" for non-wizards.
   This is auth-package work, not a new token class.
2. **`$block` base class** + the `writable_owner` / `writable_self`
   schema and runtime enforcement. Substrate work, not just woocode:
   - Catalog manifest schema additions for the two tier lists.
   - Installer validation (collision with reserved names, well-formed
     lists, `$block` ancestry check).
   - Runtime gate in the property-write path: new principal-checks
     "session.actor == target" and "session.actor == target.owner" as
     the new perm axes.
   - Tests per tier (plug, owner, stranger, wizard, subclass tier
     inheritance, manifest-validation negatives).
   - Plus the woocode: anchored verbs (`:moveto` raises, `:acceptable`
     wizard-only); `:set_property`, `:set_properties`, `:get_data`,
     `:look`; live observation route for `block_data`; summary/detail
     tier filtering for `RoomSnapshot`. **Ephemeral props are NOT in
     this step** — see open decision 7.
3. **Canonical kinds and generic `<woo-block>` UI.** `scalar | series |
   table | geo` recognized; generic component renders any of them;
   text-dump fallback for unknown kinds.
4. **`$weather_block` + Worker plug.**
   - Catalog: class, manifest, owner-config panel, current/forecast/history
     props.
   - Plug: CF Worker with cron trigger, hourly. Reads tomorrow.io,
     pushes via WS, disconnects.
   - Demo: weather block in the living room, working end-to-end.
5. **`$dispenser_block` base class.** Queue-and-deliver pattern (no
   parked tasks): `:order` appends to `pending_orders` and returns a
   ticket synchronously; `:deliver(order_id, body)` removes the entry
   and creates a `$note` moved to the requester. Sequenced
   `order_placed` / `delivered` observations routed to `location(this)`.
   Optional directed `text` wakeup to plug sessions. `:cancel`,
   `:next_pending`, `:status`. Order TTL.
6. **`$horoscope_block` + Worker plug.**
   - Catalog: class extending `$dispenser_block`. One owner-writable
     `system_prompt`. Description via the base block.
   - Plug: CF Worker. On wakeup (`text` hint or cron), reads
     `pending_orders` (or `:next_pending`), runs
     `@cf/meta/llama-3.2-1b-instruct` on Workers AI with
     `system_prompt + request`, calls `:deliver`. Idempotent on
     `order_id`.
   - Demo: horoscope machine on the deck, end-to-end.
7. **Audience cache for live observations.** Memoize per
   `(space, version)`. Validate with a small smoke (10 blocks, 1Hz,
   10 subscribers — sized to demo workloads, not the persistent-WS
   scaling section's hypothetical 10Hz × 50).
8. **Credential-management UX polish.** `:list_apikeys` and `:look`
   surface `last_seen_at` clearly; expired/revoked errors carry distinct
   `E_AUTH_*` codes; rotation flow documented in catalog README.

Steps 1–4 are the weather demo. Steps 5–6 are the horoscope demo. Step 1
is the actual blocker — once apikey is right, the catalogs are
straightforward.

The persistent-WS scaling work, the database block, the dashboard
composition, and the audience-tier escalation paths are explicitly **not**
in this build. Their write-up exists so the design is anticipating them,
not so we build them now.

## Open-ended (not in build, here for orientation)

These are real opportunities the design anticipates but doesn't commit to.
The note keeps them so future iteration has a starting point, not so we
ship them.

- **Database block.** Mongo / Postgres plug with `:ask` forwarding to a
  real query engine. Validates persistent mode, exercises table/series
  shapes through real-world data. Forces the externalized blob storage
  question if results get large.
- **Externalized blob storage.** Content-addressable blob store for
  multi-MB plug payloads. Property holds a handle; bytes live in R2 or
  similar. Needed when the first big-data plug arrives.
- **Block composition / dashboards.** A "dashboard block" reading other
  blocks' props. Pure woocode; no new substrate. Layout (`$dashboard_block`
  vs `$widget_block`) is a UI manifest size-hint question.
- **Pub/sub for very-high-fanout blocks.** Peel live channels out of the
  substrate-routed observation path for >1Hz × >100-subscriber cases.
  Audience cache + focused-audience tier likely cover real workloads
  first.
- **Connection-mode hint.** Class-level
  `connection_mode: "scheduled" | "persistent" | "either"` for smarter
  hibernation and UI cues. Inferable from `ephemeral: true` for now.
- **Interactive notes.** First-version dispenser notes carry only
  back-reference props. Later, notes can carry verbs (`:cite_section`,
  `:expand`) that route back to the producing block, building citation
  graphs. The substrate already supports this; defer until something
  wants it.
- **Plug as full agent runtime.** When the plug is an LLM doing tool use,
  the tool surface might want to include other woo verbs (the agent
  reaching back into the world). Block-as-actor has its perms, not the
  requester's — a real auth story to design before agentic plugs become
  common.
- **Cross-version plug ↔ block compatibility.** Plug declares supported
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
