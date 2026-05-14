# Session, subscription, and roster semantics

## Status

Design note before implementation. This supersedes the parts of
`2026-05-04-single-location-refactor.md` and the current specs that treat
`space.subscribers` as a live-session projection or as a universal body mirror.

The corrected model is catalog-agnostic at the substrate layer and
catalog-specific at the roster layer.

## The two questions

Every room-like or workspace-like surface has two separate questions:

1. **Who appears here?** This is the render/API question. Browser panels,
   MCP/REST look output, `who`, and scoped projections need a stable roster.
2. **Who hears this?** This is the live-delivery question. Applied frames and
   live observations need a session audience.

These questions have different sources of truth. Conflating them is the bug.

- Roster is a per-class catalog contract: `$chatroom`, `$pinboard`, and
  `$dubspace` may all answer "who appears here" differently.
- Live delivery is session-subscription state: `space.session_subscribers`,
  filtered by observation routing.

No client, tool, or catalog should reach into an old `subscribers` list and
guess which question it is answering.

## Three substrate concepts

The substrate owns three catalog-agnostic facts:

| Concept | Source of truth | Cardinality | Used for |
|---|---|---|---|
| **Active scope** | `session.active_scope` | zero or one scope per session | Command parsing, default scope, focused pane. |
| **Subscriptions** | `space.session_subscribers`; exposed as `session.subscribed_spaces` | many spaces per session | Live/applied frame delivery. |
| **Connection status** | session registry + `lastInputAt` | derived per actor | Awake, idle, sleeping presentation. |

Body placement is not a substrate invariant. `actor.location` exists as ordinary
object containment. Embodied catalogs use it; workspace catalogs can ignore it.
The substrate does not keep `session.active_scope` and `actor.location` in
lockstep.

`session.active_scope` may be null. A session can authenticate or observe a
workspace before it has a command focus. UI focus changes write
`active_scope` through a session-scope operation; catalog verbs such as
`enter()` may also set it as part of their explicit behavior. The implementation
PR should rename `session.currentLocation` / `session.current_location` to
`session.active_scope`; until then, the old names are legacy aliases for command
focus, not body placement.

Subscriptions need a session-side view as well as the existing space-side rows.
`space.session_subscribers` remains the delivery index, while
`session.subscribed_spaces` is the introspection/UI shape: "these are the spaces
this session is listening to." A UI can then say: "subscribed to pinboard X and
pinboard Y, with chat room C as the active scope."

Traditional MOO behavior is one important catalog shape: a disconnected
character can remain physically in a room, render as `tty (disconnected) is
here`, and answer `look tty` with `tty is sleeping`. A workspace shape is also
valid: the same actor may be listed on two pinboards because the same session is
subscribed to both. In both cases, connection status comes from the same
substrate builtins.

## Verb contracts

The stable representation should be at the verb-contract level, not in one
substrate function that pretends every catalog means the same thing by
"present."

### `$space:room_roster()`

Returns the canonical render/API shape for "who appears here." It is a verb
contract with class-specific implementations.

Suggested return shape:

```ts
[
  { id: "pat", name: "Pat", presence: "awake", idle_seconds: 12 },
  { id: "tty", name: "tty", presence: "sleeping" }
]
```

Return rows have a stable wire contract:

- Required: `id`, `name`, and `presence`.
- `presence` is one of `"awake"`, `"idle"`, or `"sleeping"`.
- Optional: `idle_seconds`, catalog-specific display fields, and catalog-specific
  capability hints. Optional fields must not change the meaning of `presence`.

Default examples:

- `$chatroom:room_roster()` returns actors whose physical `location == this`,
  enriched with `is_connected(actor)` / `idle_seconds(actor)`.
- `$pinboard:room_roster()` returns distinct actors from
  `this.session_subscribers`, enriched with connection status.
- `$dubspace:room_roster()` probably follows the pinboard/workspace shape:
  distinct subscribed actors, not physical bodies.

Browser look panels, MCP tools, REST snapshots, scoped projections, `look`, and
`who` should all call this verb or use a projection-time analogue with the same
contract. No tool should invent its own roster by reading implementation
properties.

### `$space:live_audience(observation?)`

Returns the session audience for live delivery. The default implementation is
the same for most spaces:

1. read `this.session_subscribers`;
2. drop sessions that do not exist or are no longer eligible for live delivery;
3. apply observation routing rules (`_audience_override`, directed `to`/`from`,
   self-suppression, opt-outs);
4. return live session ids/endpoints for delivery.

Catalogs can override for exotic delivery models, but most should inherit the
default. The default implementation delegates to the existing
`observationAudienceActors` routing logic; the verb is the catalog-facing
contract, not a parallel audience engine. Renderers must not use this to answer
"who appears here."

## UI presence model

Interfaces should present roster status and live focus as separate signals:

- Grey or muted indicator: the actor is in the roster but `presence` is
  `"sleeping"`.
- Green or live indicator: the actor is in the roster and has at least one live
  session subscribed to this surface.
- Blue or focused indicator: this surface is the viewer's `session.active_scope`
  or, when exposed for other actors, another session's active scope.

The exact iconography is UI policy, but the distinctions are not. A pinboard may
show only live collaborators at first, or later choose to show non-live actors
with muted presence. If it shows them, it should use the same roster contract and
presence meanings as chat.

## Retire `space.subscribers`

`space.subscribers` is the ambiguous term. It has meant "actors here",
"listeners", and "projection of live sessions" at different times.

The target model removes it from the semantic contract.

- Existing worlds may still carry the property until migration cleans it up.
- Repair migrates it; new code must not read it; the property is removed from
  bundled catalog semantics once repair is complete.
- New catalog code should use `room_roster()` for render/API and
  `live_audience()` / `session_subscribers` for delivery.
- Catalogs that need a listener set should declare a typed property with a
  domain name, such as `listeners`, `operators`, `watchers`, or a
  catalog-specific field.

A compatibility shim without an end date is not compatibility; it is a second
authority source.

## Multi-context behavior

Use the no-primary-mirror model.

Sessions never move a body by themselves. `session.active_scope` is a
session's active command/projection context. `actor.location` changes only by
ordinary catalog behavior, such as `moveto(actor, room)`.

Consequences:

- An embodied actor has one physical body location because object containment
  has one location.
- Multiple sessions for the same actor may have different active scopes.
- One session may subscribe to multiple spaces at once.
- Entering an embodied room must run catalog behavior that calls
  `moveto(actor, room)` explicitly. On the v2 durable path, the commit scope
  owns that movement.
- Opening or observing a workspace can subscribe the session without moving the
  actor's body.

This removes the drift-prone rule where a "primary session" silently mirrors
into `actor.location`.

## Side-by-side workspace example

The side-by-side pinboard case needs no special mechanism:

1. Open pinboards X and Y in two panes: session S adds `{ session: S, actor }`
   to both `X.session_subscribers` and `Y.session_subscribers`.
2. `X:room_roster()` and `Y:room_roster()` both list the actor, because
   pinboards define roster by subscribed actors.
3. Live edits to X fan out to S; live edits to Y also fan out to S.
4. `session.active_scope` is whichever pane has command-input focus, or a
   wrapper/chat context if the UI chooses that.
5. The actor's body, if any, is unaffected and can still appear in a chatroom
   roster via `$chatroom:room_roster()`.

The actor is genuinely "present" in three places because "present" is not a
substrate primitive. The chatroom means body occupancy; the pinboards mean live
workspace subscription.

## MOO-shaped defaults

- Disconnect removes or disables live delivery for the detached session. It does
  not move the actor.
- In an embodied room catalog, a disconnected actor remains in
  `room_roster(actor.location)` and renders as sleeping.
- Idle is presentation state derived from `presence_status(actor)` and
  `idle_seconds(actor)`. The awake/idle/sleeping threshold is a shared
  substrate policy so roster rows stay consistent; exact wording remains
  catalog/UI policy.
- Moving home after disconnect is catalog/world policy, usually `on_disfunc`,
  `@home`, guest reset, or a timed task. It is not a substrate invariant.
- Non-player actors do not automatically need sleeping/awake presentation.
  LambdaMOO puts that behavior on `$player:look_self`; woo should keep the same
  default boundary unless a catalog opts in.

## Catalog authority

Catalogs decide who may emit text or observations.

**Embodied local speech** (`say`, `emote`, ordinary room chat) normally requires
the actor to physically occupy the room, or `session.active_scope` to be the room
when the catalog wants session-scoped behavior. Room announcements, system
messages, page-like delivery, and authorized outside actors can have different
rules. Do not hardcode "must have a live session in this room" into substrate
speech or observation machinery.

The substrate should provide building blocks such as `contents`,
`session_subscribers_for`, `presence_status`, `is_connected`, and
`idle_seconds`; the catalog chooses how to assemble them.

## Migration and repair

Existing worlds may have stale `subscribers` rows that were created as live
session mirrors. Repair must not blindly rebuild rosters from live sessions;
that would erase sleeping embodied characters.

Repair should:

1. remove `session_subscribers` rows whose sessions do not exist or are no
   longer eligible for live delivery;
2. leave actor physical placement alone unless guest reset or disconnect-home
   policy moves it;
3. implement `room_roster()` on bundled room/workspace classes;
4. flag ambiguous legacy `subscribers` rows where no class-specific roster rule
   explains the row;
5. remove `subscribers` from bundled catalog semantics after repair code no
   longer needs it.

For bundled chat rooms, roster comes from actors whose `location` is the room.
For bundled workspaces such as pinboard and dubspace, roster comes from distinct
actors in `session_subscribers`.

## Behavior under test

These are the minimum invariants for implementation:

1. **Disconnect leaves embodied bodies.** After `auth(); chatroom:enter();
   disconnect()`, `$chatroom:room_roster()` lists the actor as sleeping,
   `chatroom.session_subscribers` does not list the detached session, and
   `observe_to_space(chatroom, ev)` does not deliver to that session.
2. **Workspace roster follows subscription.** Subscribing session S to pinboard
   X makes `X:room_roster()` list S's actor without changing `actor.location`.
3. **One session, many subscriptions.** One session subscribed to pinboards X
   and Y receives live delivery from both, and both rosters list the actor.
4. **Active scope is single.** Changing command focus updates
   `session.active_scope` without changing the subscription set or moving the
   actor's body.
5. **Two sessions do not clone a body.** With two sessions for the same actor in
   different active scopes, embodied catalogs still show the actor in exactly
   one physical room roster.
6. **Enter moves explicitly.** A chatroom `enter()` that calls
   `moveto(actor, room)` updates `actor.location`, `session.active_scope`,
   and live subscription together on the durable path.
7. **Observer context is not occupancy.** A session subscribed to a room as an
   observer receives permitted live frames but does not make the actor appear in
   an embodied room roster unless that catalog's `room_roster()` says so.
8. **Announcements bypass embodied-speech assumptions.** An authorized object or
   outside actor can announce into a room; delivery uses `live_audience()`, not
   a hardcoded physical-presence check.
9. **Legacy repair does not erase sleepers.** A world with a disconnected actor
   physically in a chatroom and no live session rows still renders the actor in
   `$chatroom:room_roster()` after repair.
