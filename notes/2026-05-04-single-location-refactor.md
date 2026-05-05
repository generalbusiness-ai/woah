# Single-location refactor — session as acting subject

## Context

woo carries three containment-ish properties: `location` (LambdaMOO
physical containment), `anchor` (feature-space membership), and
`presence_in` (multi-presence list). The split was added to make the
SPA's tabbed UX work without breaking LambdaMOO grammar. It's a
non-LambdaMOO deviation, and the recent dubspace dispatch bug
(`canSeeCommandObject` reaching to the wrong axis because three
properties answer "is this thing reachable from here?") shows the cost.

Verified online against LambdaCore: there is one `.location` per
object; `$room:announce_all` iterates `this:contents()` and tells
each. Patterns from "sit on the couch" (couch is a $container the
player moves into) to "alcove with acoustic transparency" (a custom
sub-room that overrides `:announce_all` to also forward to its
parent) all use `.location` as the single truth.

**Note on forwarding.** The "echo to parent room" idea is *not* in
generic LambdaCore — `$room:announce_all` does not forward upward.
It's a pattern individual subclasses adopt by overriding
`:announce_all`. In woo we codify that pattern as catalog features:
`$transparent` for two-way acoustic transparency and
`$semitransparent` for a cone-of-silence space that hears the parent
but does not forward local speech outward. That's woo catalog
composition, not LambdaMOO inheritance.

## Direction

- Non-actor objects keep single `.location` (LambdaMOO).
- "Where am I" lifts to the **session**, not the actor. Each session
  has exactly one `current_location` and acts only there.
- Actors can be in more than one place because they can have more
  than one live session. `actor.locations` is the deduplicated union
  over the actor's live sessions — derived, not stored.
- Acoustic transparency: embedded spaces attach `chat:$transparent`.
  Public speech is observed locally and forwarded upward via
  `location(this)`. Parent room announcements call
  `:hear_parent_announce` on contained spaces that opt in. Spaces can
  attach `chat:$semitransparent` to hear the parent without forwarding
  local public speech outward.

## Current implementation status

Implemented with compatibility adjustments: `presence_in` has been removed
from the seed schema, local boot migration drops stale installed
`presence_in` definitions/values, and bundled catalog behavior does not read or
write it. Movement goes through `moveto(actor, space)`, which updates the
calling session's `current_location` and the space's authoritative
`session_subscribers` entries. `space.subscribers` remains an actor-level
projection for compatibility with room UI and woocode.

`anchor` removal is split. User-facing reachability no longer treats
`anchor` as a command-visibility axis; `canSeeCommandObject` uses session
location, contents, inventory, focus, and caller-room location/contents only.
The substrate `anchor` field remains for atomicity/routing of coordination
clusters until a separate storage/routing migration replaces it.

## Six invariants

The implementation gap is larger than a verb-rename. The invariants
below have to be spelled out before coding starts.

### Invariant 1: session identity is threaded through every call

`CallContext` (src/core/types.ts and src/core/world.ts:82) currently
has no session field. Every site that constructs a CallContext or
takes a verb call has to start carrying it.

**Substrate changes:**

- `CallContext` gains `session: string | null`. Null is for
  unauthenticated/internal/replay paths.
- `WooWorld.directCall(target, message, ...)` takes a session id
  parameter, threads it into the constructed CallContext.
- `WooWorld.applyCall(...)` similarly takes a session id (sequenced
  calls also need session attribution; replay sets it to null).
- The `dispatch` builtin invocation path inherits `session` from the
  caller's CallContext (an inner verb call sees the same session as
  the outer one).
- WebSocket gateway (src/worker/persistent-object-do.ts and
  src/server/dev-server.ts WS host bindings) stops discarding
  `session.id` before calling `world.directCall`; passes it through.
- MCP host (src/mcp/host.ts:645) same treatment.
- REST `/api/objects/<id>/calls/<verb>` (src/core/protocol.ts) reads
  the session from auth headers (already does), passes it into
  `world.directCall`.

**Wire/protocol:**

- No client-visible change. The session is already on the WS/REST
  attach side; we just stop dropping it on the way to the verb body.
- Internal RPC across hosts (the `/__internal/ws-call` cross-host
  bridge) carries `session` in the call envelope.

**Compat for verbs that don't care about session:** `ctx.session ===
null` is fine. Verbs only consult it when they're explicitly doing
session-scoped work (move, current_location read, etc).

### Invariant 2: subscribers are derived from session currents, not actor ids

Today `space.subscribers` is `list<obj>` (actor refs). For a single
actor with two sessions in the same space, naive add-on-:enter /
remove-on-:leave breaks: one session leaving removes the actor, the
other session is starved.

**Choice (recommended):** make the subscribers index session-shaped.

- Underlying storage: `space.session_subscribers: list<{session: str,
  actor: obj}>` (or two parallel lists, or a map). One entry per live
  session-in-space.
- Derived view: `space.subscribers: list<obj>` (actor union, dedup)
  — this is what catalogs and the SPA already consult; preserve the
  shape.
- `:enter` adds `{session: ctx.session, actor: ctx.actor}` if not
  already present for that session.
- `:leave` removes by session id.
- Session reaped (timeout, explicit logout) → drop all the session's
  rows across all spaces.

**Implementation mechanism for the derived view:** since woo
properties are stored own + inherited defaults (src/core/world.ts:510),
not computed, we can't make `subscribers` itself derived without
adding a synthetic-property mechanism. Two acceptable paths:

- **(a) Store both.** `session_subscribers` is the authoritative
  list; `subscribers` is a denormalized actor-set kept in sync by
  the same write path. Write amplification ×2; reads stay direct.
  Mirror is rebuilt on session reap. Likely the right choice: it's
  what existing readers already expect.
- **(b) Make `subscribers` a builtin.** Replace the property read
  with a `subscribers(space)` builtin that derives at read time.
  Cleaner conceptually, but requires migration of every catalog read
  (lots of places).

Lean toward (a). The mirror cost is small; readers don't migrate.

**Refcount alternative considered and rejected:** a per-actor refcount
in the subscribers list ("guest_3 ×2") would also work and is smaller,
but loses the session→space mapping needed for "which session is
where" queries (e.g. resolving `@join`).

### Invariant 3: `location(target)` returns the calling session's current when target is the calling actor; otherwise the stored mirror

Catalog verbs read `location(actor)` to mean "where am I right now."
A pure stored mirror (only updated by primary moves) gives the wrong
answer for a *secondary* session: if I'm acting from session 2 in the
dubspace while session 1 (primary) is on the deck, `location(me)`
must return the dubspace, not the deck — otherwise `:give`, command
planning, room-scoped match, etc. all operate against the wrong
room.

So `location` has one specific context-sensitive case:

| Caller context | `location(target)` returns |
|---|---|
| target is non-actor | stored `target.location` (LambdaMOO; unchanged) |
| target is actor, `target === ctx.actor`, `ctx.session != null` | `current_location()` (the calling session's current) |
| target is actor, `target !== ctx.actor` (cross-actor) | stored `target.location` (the *mirror*: primary session's current) |
| target is actor, no session context (replay/internal) | stored `target.location` (last-known mirror) |

The stored field exists on every object including actors, and is a
real LambdaMOO-shaped value. Writers (the substrate during primary
moves; programmatic `:moveto`; reap-promotion) keep it consistent.
Cross-actor reads are stable — secondary-session wandering doesn't
flicker the value.

The session-scoped self-read is the *only* deviation from "ordinary
property". It is in the builtin handler, not in the property layer
— there's no synthetic-property machinery. Verbs that explicitly
want "where this calling session is" can call `current_location()`
directly (Invariant 5); `location(self)` is sugar for the same
thing.

### Invariant 4: `all_locations(target)` is a builtin

The secondary affordance for callers that need the full session-union
(audience routing for inbound observations, `@join` resolution, the
SPA tab strip's "what tabs do I have open"): `all_locations(target)`
returns the dedup list of `current_location` across the target
actor's live sessions. For non-actor objects: `[obj.location]` (or
`[]` if location is null).

`all_locations` is a builtin, not a property — it's derived from the
session table on every read.

Catalogs that read `actor.presence_in` must migrate to
`all_locations(actor)`, `current_location()`, or `location(actor)`
depending on intent. In the landed path, `presence_in` is removed from the
seed schema and stale installed rows are deleted by local boot migration.

### Invariant 5: `current_location()` and `session_location(session_id)` are explicit builtins

`ctx.session` is a string (or null), not an object — so
`ctx.session.current_location` is sloppy notation. Concretely:

- **`current_location()`** — no args. Returns
  `session_location(ctx.session)` for the calling session. If
  `ctx.session === null`, returns `null` (replay/internal callers
  see no location). This is the canonical builtin for "where is this
  session?"
- **`session_location(session_id)`** — explicit lookup by session id.
  For wizard tools, audience routing, `@join` resolution. Returns
  null for unknown/dead session.
- **`current_session()`** — returns `ctx.session` (string or null) for
  the calling session. Useful when a verb wants to thread the
  session id into a substrate call (subscribers index, audience
  set).

`location(self)` falls back to `current_location()` per the table in
Invariant 3.

### Invariant 6: `:moveto` for actors is session-scoped; oldest-live session is primary; mirror writes follow

Two pieces here, tied together because they're inseparable.

**Primary session rule.**

When an actor has multiple live sessions:

- The **primary session** is the oldest (lowest `started`
  timestamp; tiebreak by session id lexicographically — stable,
  deterministic).
- `actor.location` mirrors the primary session's
  `current_location`. Only primary moves update the mirror;
  secondary sessions navigate freely without disturbing it.
- **Promotion on reap**: when the primary session is reaped (timeout,
  logout, gone), the next-oldest live session becomes primary, and
  `actor.location := newPrimary.current_location`. If no sessions
  remain, `actor.location` stays at last-known.
- **New-session default current**: when a session connects, default
  `session.current_location := actor.location`. New tabs/MCP tools
  land where the primary is, then can navigate independently.

Why oldest, not most-recently-moved: stability. The user's "main"
tab/shell is whoever connected first; secondary tabs are scratchpads.
Cross-actor reads of `location(other_actor)` shouldn't flicker as
the other actor's secondary tabs wander.

**`moveto` builtin dispatch.**

- **Object target** (`isa($actor)` false): LambdaMOO sequence —
  source `:exitfunc(obj)`, dest `:acceptable(obj)`, dest
  `:enterfunc(obj)`, update `obj.location` and contents Sets, emit
  `taken`/`dropped`/`entered` observations as appropriate.
- **Actor target** (`isa($actor)` true): session-scoped path. Moves
  only the calling session. Runs `current.exitfunc(actor)`,
  `X.acceptable(actor)`, `X.enterfunc(actor)`. Updates
  `session.current_location := X`. Updates session-keyed subscribers
  index for both spaces. **If the calling session is primary**, also
  atomically writes `actor.location := X`. Emits `entered` to
  X.subscribers and `left` to current.subscribers (LambdaCore
  self-suppressing audience — bystanders see it; the actor's own
  command output is the call result or a separate `text`
  observation).
- **Wizard `@moveto user X`** — deferred eject-shape, moves *all* sessions of
  `user` to X. Iterates the user's live sessions, runs the
  session-scoped path for each. Primary's move writes the mirror. This is not
  implemented in the current pass.

- **No-session callers** (`ctx.session === null`: replay, internal
  RPC, programmatic-not-via-a-session paths) take the **direct
  mirror path**: write `actor.location := X` directly; do *not*
  invoke session-scoped enter/exit hooks; do *not* update any
  session's current. The actor "appears" at X. This is the safe
  default — replay must be deterministic and can't synthesize
  session context that didn't exist when the call originally ran.

- **`acceptable` / `enterfunc` / `exitfunc` signatures unchanged.**
  These verbs receive `(actor)` like today. If a hook needs to know
  which session is moving (e.g. a private room rejecting non-primary
  tabs), it calls `current_session()` / `primary_session(actor)`
  inside the verb body. No new positional argument.

Same builtin name (`moveto`); runtime dispatches by target type.

## Future target shape (under the invariants)

### Non-actor objects

- `location: ObjRef | null` — single, LambdaMOO-shaped.
- `anchor` removal remains deferred; the landed pass keeps the field.

### Actors

- `location: ObjRef | null` — stored field. Mirrored from the
  primary session's current on every primary-session move
  (Invariant 6). Cross-actor reads see this value.
- `all_locations(actor)` builtin returns the derived session-currents
  union when needed (audience routing, `@join`, SPA tab strip).
- Catalog verbs reading `location(actor)`:
  - For `actor === ctx.actor`, the builtin returns
    `current_location()` (the calling session's place) — so `:give`,
    `:take`, command planning, etc. all see the right room when a
    secondary session is acting (Invariant 3).
  - For `actor !== ctx.actor`, the builtin returns the stored mirror.

### Session

- New persisted field `current_location: ObjRef`.
- Set on session create (default: `actor.location` — new tab lands
  where the primary is).
- Mutated by session-scoped `:moveto`, `enter`, `go`, `out`. If this
  session is the actor's primary, the same write atomically updates
  `actor.location`.
- Persists across socket detach/reattach. Reconnect resumes where
  left.
- Reaped: removed from subscribers across all spaces; the
  session-subscribers mirror is updated.

### Acoustic transparency features

```
feature $transparent < $conversational {
  verb :say(text) rxd {
    pass(text);                             // local occupants
    if (location(this) && isa(location(this), $space)) {
      observe_to_space(location(this), { type: "said", actor: actor, text: text });
    }
  }
}

feature $semitransparent < $conversational {
  verb :hear_parent_announce(ignore, text) rxd {
    for listener in this.subscribers {
      if (!(listener in ignore)) tell(listener, text);
    }
  }
}
```

Default for dubspace, pinboard, taskspace is `chat:$transparent`.
Bare `$room` doesn't forward upward. Concrete cone-of-silence spaces
(for example a rain curtain inside a hot tub) attach
`chat:$semitransparent`: they hear parent announcements through
`:hear_parent_announce`, while their local speech stays local.

## Verb semantics (session-scoped)

| Verb | session.current_location | actor.locations (derived) |
|---|---|---|
| `enter <X>` | := X | replace this session's slot in the union |
| `go <dir>` / cardinal | := destination | same |
| `out` from embedded transparent space | := this.location | same |
| `out` from top-level room | := destination via `out` exit | same |
| Verb-context `:moveto(actor, X)` | := X (calling session) | same |
| Wizard `@moveto user X` | := X (all sessions) | becomes `[X]` |
| Programmatic `:moveto(obj, X)` for non-actor obj | n/a | n/a |

## Match scope and verb visibility

- `matchObjectForActorAsync` walks `current_location.contents` (+
  actor inventory). Single-axis. The session is always defined for
  command parsing (commands come in via WS/REST/MCP, all of which
  carry session).
- `canSeeCommandObject` drops `anchor` as a visibility axis. It keeps a narrow
  caller-room location/contents check for verbs dispatched through a room, so
  remote command planning can see objects physically in that room without
  restoring feature-space reachability.

## Observation routing

Fan-out is currently actor-keyed: the runtime computes
`audienceActors` / `observationAudiences` (`src/core/types.ts:91`,
consumed at `src/worker/persistent-object-do.ts:1546` and
`src/mcp/host.ts:152`), and each actor's sockets all receive
matching frames. With session-keyed presence, that's too coarse — a
secondary tab in the dubspace shouldn't receive frames meant for the
primary tab on the deck.

**Contract change.** Direct-result and applied frames carry an
additional, session-targeted hint. Field names follow the existing
TS-side camelCase convention (`audienceActors`,
`observationAudiences` in `src/core/types.ts`) — wire and TS stay
aligned:

```
{
  result, observations,
  audienceActors:        [actor, ...],
  observationAudiences:  [[actor, ...], ...],
  audienceSessions:      [sessionId, ...],
  observationSessionAudiences: [[sessionId, ...], ...]
}
```

The actor-keyed fields stay (compat hint for transports that haven't
rolled forward). The session-keyed fields are the authoritative
filter once transports support them.

**Audience computation.** For each broadcast observation, the
runtime collects:

1. The set of session ids currently subscribed to the source space
   (via the session-keyed subscribers index — Invariant 2).
2. Plus session ids subscribed to any space the source forwards to
   via `:announce_all` chain (acoustic transparency).
3. Minus self-suppressed sessions per `events.md §12.7.3` (the
   actor's own command output is delivered through the call result
   or a separate text observation; bystander sessions get the
   broadcast).

Result: a per-observation list of `session_id` recipients.

**Transport behavior.** WS host / MCP gateway iterates
`audience_sessions` (preferred) and pushes each frame to that
session's specific socket. Falls back to `audience_actors` →
all-sockets-for-actor when the session list is absent (transitional
compat). Sockets are session-bound (one socket attaches one session
on connect; see "Same-browser multi-tab" open question).

**Inbound view.** A session with `current_location = X` receives any
frame whose `audience_sessions` contains it. Multi-tab in one
browser does *not* mean both tabs see everything — each tab is its
own session, only sees what its current_location subscribes it to.

**Outbound** (this session emits speech): observation source space is
`current_location()`; the runtime broadcasts to the
session-subscribers of that space, then forwards up the
`:announce_all` chain to the parent's session-subscribers.

## What this changes, by surface

### Substrate (`src/core/world.ts`, `src/core/types.ts`,
`src/core/tiny-vm.ts`, `src/core/protocol.ts`)

- `CallContext` gains `session: string | null`. Threaded through
  `directCall`, `applyCall`, dispatch, native handlers (Invariant 1).
- `Session` gains `current_location: ObjRef`. Persisted. Default on
  create: `actor.location` (Invariant 6).
- `subscribers` index becomes session-keyed (with actor-set mirror
  for back-compat readers; Invariant 2).
- `location` builtin gets the self-session branch (Invariant 3): if
  target is the calling actor and a session is in context, return
  `current_location()`; otherwise read the stored property.
- New builtins (Invariants 4, 5):
  - `current_location()` — calling session's current.
  - `current_session()` — calling session id (or null).
  - `session_location(session_id)` — explicit lookup.
  - `all_locations(target)` — dedup union for actors; singleton for
    non-actors.
  - `primary_session(actor)` — oldest-live tiebroken by id (used
    internally by the mirror-write path; exposed for catalogs that
    need it for `@join`).
- `moveto` builtin dispatches on `isa($actor)` (Invariant 6): actor
  target → session-scoped path with mirror-write-when-primary;
  non-actor target → LambdaMOO object path.
- Direct-result / applied frame schemas gain
  `audienceSessions: ObjRef[]` and
  `observationSessionAudiences: ObjRef[][]` (`src/core/types.ts`,
  matching existing camelCase convention). Actor-keyed fields stay
  as transitional compat hints.
- `canSeeCommandObject` and `matchObjectForActorAsync` simplify to
  LambdaMOO grammar (single axis: calling session's
  `current_location.contents` plus actor inventory).
- Observation audience computation drops the multi-axis logic and
  uses session-subscribers + forwarder chain.
- Transports (`src/worker/persistent-object-do.ts:1546`,
  `src/mcp/host.ts:152`, `src/server/dev-server.ts` WS host) consume
  `audience_sessions` (preferred) with `audience_actors` fallback.
  Sockets are session-bound at attach.
- Presence-index machinery rebuilt around session-keyed subscribers.

### Catalogs

- **chat**: `$room:enter` — call session-scoped `:moveto(actor,
  this)` (which updates session.current and subscribers, fires
  hooks, emits observations). `$room:leave` — `:moveto(actor,
  this.location || actor.home || $nowhere)` (or whatever the eject
  destination is). Drop direct presence_in writes. Keep
  `chat:$transparent` / `chat:$semitransparent` acoustic features.
- **dubspace**: `$dubspace < $space`, seed `the_dubspace` attaches
  `chat:$transparent`. Control `anchor` removal is deferred with the
  substrate routing migration; control `location` is the containment axis.
- **pinboard**: `$pinboard < $space`, seed `the_pinboard` attaches
  `chat:$transparent`. Sticky-note `location` becomes `the_pinboard`.
  `$pin` anchor removal is deferred with the substrate routing migration.
- **taskspace**: same `$space` + `chat:$transparent` seed pattern.

### SPA (`src/client/main.ts`)

- Tab strip is per-session monitor. Each tab represents a viewable
  location. The "active" tab is the session's current_location;
  switching tabs = navigating the session there.
- Multi-presence within one browser requires per-tab session
  tokens. See open question.
- Where-am-I indicator: title bar shows `current_location` for the
  active tab.
- All `actorPresentInSpace` checks collapse to "is `space` in
  `all_locations(actor)`".

### Spec

- `spec/semantics/core.md` — note the LambdaMOO alignment; remove
  `presence_in` rows and clarify that `anchor` is atomic/routing scope, not
  command reachability.
- `spec/semantics/events.md` §12.7 — replace multi-axis audience
  build with subscribers + forwarder chain.
- `spec/semantics/bootstrap.md` — session record has
  `current_location`; chat catalog docs list `chat:$transparent` and
  `chat:$semitransparent` as feature-level acoustic conventions.
- `spec/semantics/builtins.md` — `location` self-session branch
  (Invariant 3); new `current_location()`, `current_session()`,
  `session_location(id)`, `all_locations(target)`,
  `primary_session(actor)` (Invariants 4, 5).
- `spec/semantics/events.md` §12.7 — add `audienceSessions` and
  `observationSessionAudiences` (camelCase, matches TS) to the
  result schema; transports prefer session-keyed; actor-keyed kept
  as transitional compat.
- `spec/semantics/identity.md` — session-scoped current_location.
- New brief: `spec/semantics/projection.md` — feature-spaces
  project contents; no separate membership axis.

## Migration

1. **Add acoustic transparency features.** `chat:$transparent`
   inherits `$conversational` and forwards public local speech upward;
   `chat:$semitransparent` inherits `$conversational` and only exposes
   the parent-announcement hook. `$room:announce_all_but` fans parent
   announcements into contained spaces that implement
   `:hear_parent_announce`.
2. **Add `session: string | null` to `CallContext`. Thread through
   `directCall`/`applyCall`/native handlers.** Keep null where the
   path doesn't have a session yet (replay/internal); fix WS/MCP/REST
   to pass it. **No semantic change yet** — it's just a field.
3. **Add `current_location` to `Session`.** Persist. Default on
   create: `actor.location`. Implement primary-session rule
   (oldest-live + tiebreak by id); on every primary-session move,
   atomically write `actor.location := session.current_location`.
   On primary reap, promote next-oldest and re-mirror.
4. **Add session-keyed subscribers index plus actor-set mirror.**
   Update `:enter`/`:leave`/session-reap to maintain both. Cross-host
   moves are **eventually consistent**, same model as today: each
   host write is an independent RPC; a partial failure leaves stale
   rows that the existing lazy-scrub path repairs on read (the same
   conformance shape we already have for stale subscriber ghosting). No
   two-phase / compensation transaction. Reuses
   `subscribersBroadcastAcrossHosts`.
5. **Add the location-family builtins.**
   - `current_location()` / `current_session()` /
     `session_location(id)`.
   - `all_locations(target)`.
   - `primary_session(actor)`.
   - Update `location` builtin's actor self-read to call
     `current_location()` (Invariant 3).
   - **`presence_in` is removed.** Substrate drops the seed schema field and
     local boot migration deletes stale installed rows. Catalog readers migrate
     to `location(actor)`, `current_location()`, or `all_locations(actor)`
     depending on intent.
6. **Add session-targeted audience to direct-result / applied
   frames.** `audience_sessions` and
   `observation_session_audiences` populated by the runtime.
   Transports (WS / MCP) prefer the session list; fall back to the
   actor list. Sockets bind session at attach. (No catalog or SPA
   changes yet — this just adds the metadata.)
7. **Update `moveto` builtin to dispatch on `isa($actor)`.**
   Actor target → session-scoped path; non-actor target → existing
   object path. The session-scoped path writes the mirror when
   primary (Invariant 6).
8. **Bump catalogs / local-boot repair** with the feature-based
   embedded-space convention and container/location migrations:
   - Attach `chat:$transparent` to the dubspace, pinboard, and
     taskspace seed consumers.
   - Anchor-to-location storage migration is deferred. Catalogs attach
     acoustic transparency via features rather than inheritance.
   - Sticky notes: location becomes the_pinboard.
   - `:enter`/`:leave` chat verbs use the new session-scoped
     `:moveto` path; drop `presence_in` writes.
9. **Substrate verb-visibility cleanup**: drop `anchor` as a visibility axis
   in `canSeeCommandObject`; retain only session reachability and a narrow
   caller-room location/contents check for room-dispatched verbs. Audience
   computation is session-targeted with feature-based forwarding.
10. **SPA**: tab navigation = session move. Per-tab session model
    when ready (see open question).

Each step independently shippable. SPA now treats session current location as
authoritative for chat/pinboard presence and does not depend on
`presence_in`.

## What does NOT change

- `:tell`/`:say`/`:emote`/`:say_to` chat verbs — same shapes, same
  emissions. Audience scoping is now single-axis with explicit
  forwarding.
- `:on_say_to(text)` input-handler hook on objects — same;
  backtick-speech `` `filter 500 `` works once the session is in
  the dubspace.
- LambdaMOO `:tell(text...)` output contract on `$player` —
  unchanged.

## Resolved decisions

- **Per-tab session model.** One session per WebSocket attach. Same
  identity, distinct session record bound to the socket. Substrate
  gets a small session-bind handshake at attach (the SPA passes
  whatever session id it has in `sessionStorage`; gateway rebinds
  if the id is live, mints fresh otherwise).
- **Close vs refresh disambiguation.** Browsers don't reliably
  distinguish "tab closed" from "tab refreshed". The substrate
  doesn't try. WS detach starts a short reap timer (default 30s);
  if a fresh attach with the same session id arrives within that
  window, it rebinds and the reap timer is cancelled. Else the
  session is reaped. 30s easily covers a refresh; closing the tab
  and walking away pays a half-minute of stale subscribers entries
  before they clean up — fine. The same TTL covers brief network
  blips and laptop-lid-close-and-reopen. (Wizard-tunable; the
  existing `lastDetachAt + N` reap path is the same machinery.)
- **`@join <user>` order.** Primary-first walk over
  `all_locations(X)`: oldest session's current first, then remaining
  sessions ordered by `started`. Each step calls
  `space:accept_join(...)`; first true wins. Spec must lock the
  order so behavior is deterministic.
- **`presence_in` removal.** Removed from the seed schema and deleted by local
  boot migration for upgraded worlds. Third-party catalogs should use
  `current_location()`, `location(actor)`, or `all_locations(actor)` depending
  on intent.
- **Wizard `@moveto user X`.** Deferred. The intended shape moves all sessions
  to X (LambdaMOO-equivalent eject intent), but no verb/test is landed in this
  pass.
- **Subscribers storage path.** (a) Store
  `session_subscribers` authoritative + `subscribers` actor-set
  mirror. No reader migration. Write amplification ×2 is fine.
- **Session liveness drives subscribers.** A session leaving (reap,
  logout) drops its subscribers entries across all spaces. There's
  no "keep subscribers stable across detach window" carve-out —
  that's an axis of complexity we don't need. The persistent UX
  ("close laptop, come back, still in the dubspace") comes from
  `actor.location` being the mirror, *not* from the session
  lingering. When the user re-auths, the fresh session defaults to
  `actor.location` and they land back where they were. Guest-shaped
  reap behavior (`on_disfunc`, send-home) is unchanged and
  orthogonal.
- **Acoustic depth.** No cycle protection in v1. Forwarding stops
  when `this.location` is null or isn't a `$space`. Cycles are
  configuration bugs.

## Remaining open questions

### Session-bind handshake details

What does the per-tab attach look like on the wire? Probably an
`op: "attach"` frame with `{ token: ..., reuse_session?: string }`.
If `reuse_session` matches a live session for the identity, attach
to it (e.g. browser refresh re-binds to its prior session). Else
mint a fresh session. SPA passes a session id it generated; if the
gateway has it on file the tab continues, otherwise it's a fresh
tab. Worth a short protocol section in `spec/protocol/sessions.md`.

### How does the SPA generate / store its per-tab session id

Stored in `sessionStorage` (per-tab) or `localStorage` (shared)?
`sessionStorage` is per-browser-tab and survives refresh — exactly
the granularity we want. Tabs minted before the multi-tab change
don't have an id; first attach mints one. Browsers without
`sessionStorage` fall back to a single shared session.

### "primary session reaped while user is mid-action" race

Session A (primary) is reaping; session B (secondary) issues a move
just as A is being torn down. Order matters: if A's reap fires
first, B is now primary, B's move writes the mirror. If B's move
fires first, B is still secondary, mirror unchanged; then A reaps,
B promotes, mirror gets re-set to B's *current* current. Both
outcomes are sound — same end state. Worth a sentence in the spec.

## Why now

1. The dubspace dispatch bug is structurally the consequence of
   three properties answering "is this thing reachable from here?"
   Single axis means one answer.
2. The forthcoming workflow/task design adds *more* feature-spaces
   (workflows, stages). Doing that on top of the multi-axis model
   compounds the inconsistency. Doing it after this collapse means
   every new space is a normal LambdaMOO nested room.

## Done when

Concrete acceptance tests, one per substantive behavior. Each step
in the migration sequence carries the relevant rows; the whole
refactor is "done" when all are green.

- **Self-session location.** A secondary session in the dubspace
  reads `location(me) === the_dubspace`, even when the primary
  session is on the deck.
- **Subscriber co-occupancy.** Two sessions of the same actor enter
  the same room. One session leaves; the other remains a
  subscriber. The room's `who` shows the actor.
- **Session-targeted broadcast.** Speech in the dubspace is
  delivered to sessions whose `current_location` is the dubspace;
  not delivered to other sessions of the same actor whose current
  is elsewhere. Acoustic forwarding from `chat:$transparent` to its
  parent works (parent's session-subscribers also receive).
- **Semitransparent cone of silence.** A contained space with
  `chat:$semitransparent` hears parent announcements; speech inside
  that contained space is not forwarded to the parent audience.
- **Cross-host move with lazy repair.** An actor on host A moves
  from a space on host B to a space on host C; subscribers update
  on B and C; if the B-side write fails, a subsequent read on B
  triggers lazy scrub and the stale row is removed. (Same as
  today's actor-presence ghost handling.)
- **Reconnect resumption.** Covered by `tests/core.test.ts`.
  Session detaches; within the reap window, fresh attach with the
  same session id rebinds; current location preserved. Outside the
  window, fresh session defaults to `actor.location` (the mirror);
  the actor lands at the primary's last known place.
- **Primary promotion.** Covered by `tests/core.test.ts`. Three
  sessions, oldest reaped; next-oldest becomes primary;
  `actor.location` re-mirrors to its current.
- **Wizard `@moveto user X`.** OPEN: moves all of user's sessions to X;
  cross-actor reads of `location(user)` see X.
- **No catalog-authored `presence_in` writes.** Bundled catalogs
  install on a fresh world without direct `presence_in` mutation, and a local
  boot migration removes stale `presence_in` schema/value rows from upgraded
  worlds.
- **Pinboard session gating.** The browser pinboard gates editing/publishing on
  `session.current_location === the_pinboard`, not the board's projected
  subscriber/present list.
- **Catalog correctness for the dubspace bug.** `` `filter 500 ``
  works for any session whose current is the_dubspace, regardless
  of whether the actor's primary session is the dubspace, the deck,
  or anywhere else.

These map to vitest cases (most live in
`tests/catalogs.test.ts` / `tests/conformance.test.ts` / new
session-presence tests). Each migration step lands the cases
relevant to it.

## Original implementation plan

The six invariants and the resolved decisions were the implementation
green light. The plan below is historical; the landed implementation removes
`presence_in` immediately but keeps substrate `anchor` for atomic routing.

Order of work (matches the migration sequence):

1. Acoustic transparency features + parent announcement hook.
2. `CallContext.session` plumbing (no semantic change).
3. `Session.current_location` + primary-session rule + mirror.
4. Session-keyed subscribers + cross-host atomicity check.
5. Location-family builtins + deprecate direct `presence_in` use.
6. Session-targeted audience on result/applied frames.
7. `moveto` dispatch on `isa($actor)`.
8. Catalog v0.2.0 (`:enter`/`:leave` use new path; anchor-to-location storage migration deferred).
9. Verb-visibility cleanup (anchor bypass removed; narrow caller-room location/contents check retained).
10. SPA per-tab session model.

I'll start at 1, stop after each step for review.
