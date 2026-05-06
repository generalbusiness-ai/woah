# Chat Demo

A canonical MOO surface — rooms, presence, talk, emote, tell — built as a feature-object composition rather than a `$space` subclass. Sits alongside dubspace/taskspace/IDE; can also embed inside them.

## Classes

| Class | Parent | Description |
|---|---|---|
| `$match` | `$thing` | Chat-shaped text-to-action scaffold. |
| `$failed_match` | `$thing` | Sentinel returned when no visible object matches. |
| `$ambiguous_match` | `$thing` | Sentinel returned when multiple visible objects match. |
| `$room` | `$space` | LambdaCore-shaped room base. Holds contents, present actors, exit lookup, and announce/tell fanout. |
| `$exit` | `$thing` | First-class room exit. Carries aliases and movement messages; invokes the moveto path. |
| `$chatroom` | `$room` | Standalone chat-room class. Conversational behavior comes from `$conversational`. |
| `$portable` | `$thing` | Carryable room object. Moves between room contents and actor inventory without changing host placement. |
| `$furniture` | `$thing` | Fixed room furnishing. Appears in look output but is not carryable. |

## Goal

Show that woo's MOO-shaped composition works in practice: chat behavior is a *feature*, not an inheritance, so any `$space` can opt into it by attaching `$conversational` or one of its acoustic variants (`$transparent`, `$semitransparent`) to its `features` list.

This is the demo that retires the question "do feature objects pull their weight?" If the chat experiment composes cleanly with the other demos, the answer is yes.

## Surface

- Two or more actors connected to a shared room.
- Free-text input bar; output is a chronological text feed.
- Presence list visible.
- MOO-like text input parsed by the room: speech forms (`"hi`, `:waves`, `/tell`, backtick directed speech), room commands (`look`, `who`), direction verbs (`se`, `east`, `out`), and object commands (`look cockatoo`, `enter tub`, `teach bird "hello"`).
- Enter/exit notifications when actors join or leave.
- A "join taskspace as room" mode where the same chat client renders against `the_taskspace` instead of a standalone `$chatroom`. Same verbs, same observations.

## Call discipline

The chat verbs use the **direct live interaction** pattern from [core.md §C13](../../spec/semantics/core.md#c13-call-discipline). Each row classifies one verb across the two axes from [core.md §C12.1](../../spec/semantics/core.md#c121-two-orthogonal-axes); observation durability follows from the route automatically.

| Verb | Route | Mutation |
|---|---|---|
| `:say` / `:emote` | direct | none |
| `:tell` | direct | none — delivered only to recipient |
| `:look` / `:who` | direct (read) | none |
| direction verbs / `:go` | direct | actor presence/location |
| `:take` / `:drop` | direct | object location |
| `:give` (on `$portable`) | direct | object location; private — no room broadcast |
| `:enter` / `:leave` | direct | session current location and `$space.session_subscribers` |
| `:command_plan` | direct parser | none; returns the concrete route/target/verb/args |
| `:command` | direct dispatcher | compatibility wrapper for direct-only plans |

Because the chat verbs route directly, every observation they emit is live-only by [events.md §12.6](../../spec/semantics/events.md#126-observation-durability-follows-invocation-route): pushed to the room's session audience, never stored. A late-joining client sees no scrollback. This matches MOO's `notify()` semantics. Object commands that mutate state can still route through the room's sequenced log; for example `teach bird "hello"` plans as a `$space:call` against the cockatoo, so the mutation and observation are replay-visible.

**Why direct, not sequenced.** Real-time chat is fire-and-forget; replaying the log to reconstruct utterances would impose a coordinated-write cost on every message. The space's sequenced log remains for state mutations that *do* need replay (a taskspace's `:claim`, `:transition`); chat traffic flows past it.

> Being a `$space` does not mean every verb on the object is sequenced ([core.md §C12](../../spec/semantics/core.md#c12-direct-messages-vs-space-mediated-messages)). A `$chatroom` is a `$space` and a feature consumer; chat verbs run as direct calls and never enter the room's sequence log. Saying something does not advance `next_seq`.

**Logged variant (opt-in).** A world that wants auditable chat picks one of:

- **Sequenced via `$space:call`.** Authors call `$chatroom:call({verb: "say", args: ["hi"]})` instead of `$chatroom:say("hi")`. The call is now sequenced; the verb body's `emit` lands in the resulting `applied` frame's observations and is replay-visible per [events.md §12.6](../../spec/semantics/events.md#126-observation-durability-follows-invocation-route).
- **Sequenced via subclass override.** A `$chatroom_logged < $chatroom` overrides `:say` to call `this:append({type: "said", actor, text})` first, making utterances entries on the space's log even when the verb itself is invoked directly.

Either way is **application-level opt-in**, per the "logged social interaction" pattern. The default chat surface stays direct.

## The `$conversational` feature

A feature object (per [features.md](../../spec/semantics/features.md)) carrying the chat verbs. Attached to any `$space` that wants to act as a room.

| Verb | Args | Purpose |
|---|---|---|
| `:say(text)` | str | Public utterance. Emits `said {actor, text}` to the room audience (live; not stored). |
| `:say_to(recipient, text)` | obj, str | Directed public utterance from backtick syntax (`` `recipient text ``). For player recipients, emits `said_to` to the room audience except the recipient, and a targeted `text` observation whose body is `<speaker name> [to you] <text>`. If the recipient is the speaker, no targeted text is emitted and the public `said_to` remains visible to the speaker. For non-player recipients that define `:on_say_to(text)`, dispatches to `recipient:on_say_to(text)` so the object can interpret the utterance as a command (e.g. `` `filter 500 `` calls `filter_1:on_say_to("500")`). The hook name is distinct from `$player:tell` so the LambdaMOO output contract on players is not overloaded. |
| `:say_as(style, text)` | str, str | Styled public utterance from `[style] text`. Emits `said_as`. |
| `:emote(text)` | str | Third-person action. Emits `emoted {actor, text}`. |
| `:pose(text)` / `:quote(text)` / `:self(text)` | str | Small LambdaCore-flavored speech forms for `]`, `|`, and `<`. |
| `:tell(recipient, text)` | obj, str | Directed message; emits `told {from: actor, to: recipient, text}` to recipient only. |
| `:look()` rxd | — | Thin wrapper over `this:look_at(this)`. The target owns `:look_self()`; the chat feature owns the private `looked` observation and text rendering. |
| `:look_at(target)` rxd | obj | Dispatches `target:look_self()`, emits private `looked` to the caller, and returns the structured view. `look <target>` routes here even when the target has no `:look` wrapper. |
| `:who()` rxd | — | Returns the present-actor list and emits a private `who` observation to the caller. |
| `:enter(actor?)` | obj? | Moves the calling session into the room; when the room is itself contained in another room, `enter tub` resolves the contained room object and invokes this verb on it. Emits room-originated `entered` to the entered room and, when moving from another room, room-originated `left` to the old room. |
| `:leave(actor?)` | obj? | Moves the calling session home and emits room-originated `left`. |
| `:huh(text, reason?)` | str, str? | Emits a parse-failure observation. |
| `:command_plan(text)` | str | Parses text into `{route, space?, target, verb, args, cmd}`. |
| `:command(text)` | str | Compatibility wrapper for direct plans; richer clients should call `:command_plan` and then execute the plan. |

Most `$conversational` verbs are portable source, including the command planner. `$match` still uses trusted local native implementation hints for tokenizer/object-matcher primitives. Public tap installs ignore those hints and still compile the source fallback.

## Acoustic Features

`$transparent < $conversational` is the embedded-space variant used by
Dubspace, Pinboard, and Taskspace. It inherits the normal chat parser and
overrides public speech forms so each utterance is observed locally and also
forwarded to `location(this)`. It also implements `:hear_parent_announce`, so
announcements in the containing room are heard inside.

The speech overrides use `pass(...)` to invoke `$conversational`'s
emit-locally body and then add a single `observe_to_space(parent, ...)` for
the upward forward — keeping the local-emit logic in one place so the two
classes don't drift.

The `:announce_all_but(ignore, text, origin?)` chain takes an optional
`origin` parameter. When `$transparent` forwards an announcement upward, it
passes `this` as `origin`. The parent's `$room:announce_all_but` skips that
origin during its `contents(this)` iteration, then probes the remaining
contents for the `:hear_parent_announce` protocol with `$match:match_verb`.
This is deliberately protocol-based rather than `isa(item, $space)`: rooms
may contain cross-host objects, and synchronous class checks are host-local.
Listeners in the originating space therefore don't get the announcement twice
(once from the local loop, once from the parent looping back via
`:hear_parent_announce`). Cycle protection by construction.

**Multi-session, multi-location actors** (the LambdaMOO single-actor model
extended for the SPA's multi-tab UX, see
[identity.md](../../spec/semantics/identity.md)): an actor with one session
in the dubspace and another in the chatroom will see a `said` observation
delivered to *each* session. The dubspace tab shows it routed via the
dubspace audience; the chat tab shows it routed via the chatroom audience.
Same line, two feeds, intentional. The feed in each tab reflects what its
session hears in the room it's actually in.

`$semitransparent < $conversational` is the cone-of-silence variant: it hears
parent announcements through `:hear_parent_announce`, but inherited public
speech stays local. Concrete contained rooms can attach it for cases like a
rain curtain around a hot tub.

Room entry/exit (`:enter`, `:leave`) is source woocode on `$conversational`.
Geographic movement belongs to `$room` and `$exit` below. The core only
supplies generic primitives: `moveto`, `observe_to_space`, `tell`, and
`location`. Carrying objects with `:take` and `:drop` is source
woocode on `$room`: the matcher remains a trusted primitive, but portable
checks, user-facing text, `moveto`, and `taken` / `dropped` observations are
catalog-authored behavior.

`:give(recipient)` lives on `$portable` (the LambdaMOO pattern: the verb is
on the carryable, dispatched via the matched dobj). The chat planner
recognises `give <thing> to <person>` (also `at`, also `hand`) and routes
to `dobj:give(iobjstr)`. The verb body validates the giver is holding
the item, matches the recipient in `location(actor)`, calls `:moveto` so
the recipient's `:acceptable` hook gates the transfer, and confirms the
move landed before tell-ing the giver and recipient. Transfers are
private — no room-wide observation, matching LambdaMOO's `$thing:give`.

Inside each verb body: `this` = the consumer space (the room being talked in), `definer` = the `$conversational` feature, `progr` = the feature's owner. Observations are routed to `this`'s session audience, not to the feature object's audience (which would be empty).

## Observation schemas

`$conversational` declares schemas for each observation type so consumers (UIs, agents, conformance tests) have a contract on payload shape. Schemas describe shape only ([events.md §13](../../spec/semantics/events.md#13-schemas)); durability follows the route of the verb that emits each observation. All chat verbs are direct, so all observations below reach the room session audience as live `event` frames, never as `applied` frames.

```woo
declare_event $conversational "said"    { source: obj, actor: obj, text: str };
declare_event $conversational "said_to" { source: obj, actor: obj, to: obj, text: str, _audience_override?: list<obj> };
declare_event $conversational "said_as" { source: obj, actor: obj, style: str, text: str };
declare_event $conversational "emoted"  { source: obj, actor: obj, text: str };
declare_event $conversational "posed"   { source: obj, actor: obj, text: str };
declare_event $conversational "quoted"  { source: obj, actor: obj, text: str };
declare_event $conversational "self_pointed" { source: obj, actor: obj, text: str };
declare_event $conversational "told"    { source: obj, from:  obj, to:   obj, text: str };
declare_event $conversational "entered" { source: obj, actor: obj, room: obj, origin?: obj, exit?: str, text: str };
declare_event $conversational "left"    { source: obj, actor: obj, room: obj, destination?: obj, exit?: str, text: str };
declare_event $conversational "looked"  { source: obj, actor: obj, to: obj, room: obj, text: str, look: map };
declare_event $conversational "who"     { source: obj, actor: obj, to: obj, room: obj, present_actors: list<obj>, text: str };
declare_event $conversational "huh"     { source: obj, actor: obj, text: str, reason?: str };
```

| Type | Payload | Notes |
|---|---|---|
| `said` | `{source, actor, text}` | Public utterance. |
| `said_to` / `said_as` | directed/styled speech payloads | Backtick and `[style]` forms. |
| `emoted` | `{source, actor, text}` | Third-person action. |
| `posed` / `quoted` / `self_pointed` | `{source, actor, text}` | Alternate speech forms. |
| `told` | `{source, from, to, text}` | Delivered only to `to`. |
| `entered` / `left` | room-originated presence payloads | Presence transitions. These follow the LambdaCore room pattern: the room tells its own occupants, and the moving actor is excluded from the room announcement. |
| `looked` / `who` | private payloads with `to: actor` | Room-generated output for commands whose display text should not be client-derived. |
| `huh` | `{source, actor, text, reason?}` | Unparseable input. |

Live observations flow over the wire as `op: "event"` frames ([wire.md §17.2](../../spec/protocol/wire.md#172-server--client)) or as SSE `event: event` entries; clients render them in the same chronological feed as applied frames but they are not part of `:replay` history.

## The room and exit classes

The chat catalog defines the LambdaCore-shaped geography layer separately from
the conversational feature:

```
$room < $space
  exits: map<str, $exit>
  :look_self()
  :announce() / :announce_all() / :announce_all_but()
  :match_exit(name)
  direction verbs / :go(exit)
  :take(name) / :drop(name)

$exit < $thing
  source, dest
  nogo_msg, onogo_msg
  leave_msg, oleave_msg
  arrive_msg, oarrive_msg
  :invoke()
  :move(who)

$chatroom < $room
  features: [$conversational]            // attached at boot
```

The standalone demo uses `$chatroom` as a small room class, close to LambdaCore's room model:

- exits are first-class objects addressed by the room's `exits` map;
- exit names and aliases live on the `$exit` object; local seed/repair expands the room's `exits` map from those aliases so catalog authors do not repeat them in two places;
- blocked exits are `$exit` objects with `nogo_msg` / `onogo_msg`;
- rooms may be contained in other rooms, so `enter tub` is ordinary object-command dispatch;
- room contents are real objects, including fixed furnishings and portable things.

The `exits` map is a v1 implementation shortcut. LambdaMOO stores a room's
exits as a list of exit objects and scans each exit's `.name` / `.aliases`,
returning `$ambiguous_match` if multiple exits claim the same text. Woo keeps
the map for now, but the exit object remains the single source of truth for
aliases; duplicate alias claims are catalog errors during seed/repair.

Unlike LambdaCore's `$room:enterfunc`, movement does not automatically render
the destination room inside the same server turn. `$exit:move()` returns
`here_request: true` and legacy `look_deferred: true` with the destination
room. Scoped clients consume the enriched `here` snapshot; old clients and
agents can still follow a successful movement result by calling `:look()` on
that room.

The room's chat behavior still comes from `$conversational`; exits and carrying are room mechanics, not feature mechanics.

For embedded mode, `the_taskspace` (a `$taskspace`) gets the transparent chat feature attached at boot:

```
the_taskspace.features = [$transparent]
```

Now `the_taskspace:say("starting standup")` works. The utterance is a direct call, so the `said` observation is live-only — pushed to taskspace's session audience, separate from the taskspace's own sequenced log of task mutations.

## Seeded Rooms And Things

The local chat catalog seeds a tiny LambdaHouse-shaped path: `Living Room -> Deck -> Hot Tub`. The living room contains a couch, lamp, mug, and cockatoo; the deck contains the visible hot tub room and a towel. The couch is fixed furniture. The lamp, mug, and towel are portable, and moving them changes `location` without changing host placement.

This is intentionally not a full LambdaCore clone. It is the smallest room/object/exits slice that proves the same object model can support MOO-like navigation and carrying before builder tools exist.

The current implementation uses the host contents-mirror primitive: the
object's owning host updates `location`, then old/new container hosts update
their `contents` caches by RPC. Portables do not become self-hosted just because
they move between rooms or inventories.

## The cockatoo (cheap imitation of LambdaMOO #1479)

`$cockatoo` lives in `the_chatroom` as a small static-feeling resident. It has a `phrases` list and `:squawk()` picks one at random via the `random(n)` builtin; `:teach(phrase)` extends the list; `:gag()` / `:ungag()` toggle a muzzle that swaps squawks for `*muffled noises*` observations. `:pluck()`, `:shake()`, `:feed()` are flavor verbs.

Because it is anchored to the living room, the cockatoo is intentionally absent from the deck and hot tub. A later roaming/roosting version can make it visible across the tiny house, but that should be scheduled behavior rather than location magic.

What's intentionally not (yet) here: **self-driven timer chatter**. The canonical LambdaMOO cockatoo activated and squawked on a fork loop with a random delay. Woo's runtime supports parked/forked tasks, but the DSL does not yet expose `fork(seconds) { ... }` or a `schedule(seconds, target, verb, args)` builtin. Once it does, the cockatoo will become the first useful demo of woo's parked-task system: install a watchdog verb that schedules itself, with random interval and random phrase pick. Until then, squawking is actor-driven only.

**When the timer lands, gate it on presence.** A cockatoo that schedules a wakeup every N seconds against an empty room would keep the chatroom DO out of CF hibernation indefinitely — DO billing is by active wall time, so a continuously-self-squawking bird in an unattended room is a money-burning bird. Cheap mitigation, also true to the LambdaMOO `@activate` pattern: start the fork loop on `:enter` when the session audience transitions from 0 → 1, cancel the next scheduled fork on `:leave` when it goes back to 0. That keeps DO wake-ups proportional to session presence rather than wall clock; an empty chatroom hibernates as it would without the cockatoo.

**Determinism if the wake path is sequenced.** If the scheduled wake fires through `the_chatroom`'s sequenced log so other clients see the same squawk on replay, calling `random()` *inside* the resumed handler breaks replay determinism (per [space.md](../../spec/semantics/space.md)). Capture randomness at *schedule time* — the scheduler picks the next phrase and the next interval and passes both as args/body to the scheduled message — rather than re-rolling on the wake. That mirrors the LambdaMOO `fork` pattern, where the next-scheduled call is itself the value chosen at this tick.

**UI discovery still partial.** `$conversational:look()` delegates to the
room's `$room:look_self()`, so REST/WS callers and the chat client see composed
room contents. Verb-discovery via `:describe()` on a selected object is still
tracked at [LATER.md](../../LATER.md); for now players discover object verbs by
trying MOO-like text commands.

## Renderer

A transient browser host that:

1. Authenticates as a `$player` (existing flow, [identity.md](../../spec/semantics/identity.md)).
2. Calls `target_room:enter()` to join.
3. Subscribes to the room's stream (`/api/objects/{room}/stream`).
4. Renders observations as text lines:
   - `said {actor, text}` → `actor.name says, "text"`
   - `emoted {actor, text}` → `actor.name text`
   - `told {from, text}` → `from.name tells you, "text"` (only delivered to recipient)
   - `entered/left` → render the room-supplied `text`.
   - `looked/who` → render the room-supplied `text`.
   - `huh {text}` → `I don't understand "text".`
5. Sends free-text input as `target_room:command_plan(text)`, then executes the returned route. Direct plans use `op:"direct"`; sequenced plans use `$space:call`.

Same client speaks against `$chatroom` and against `$taskspace` — the verb set is identical, the renderer doesn't care.

## $match interaction

Free-text input goes through the `$match`-shaped parser and command-pattern
planner per [match.md §MA4](../../spec/semantics/match.md#ma4-command-parsing).
`$conversational:command_plan(text)` is a thin compatibility wrapper over
`$match:plan_command(text, this)`. The planner lowers the parsed `cmd` map into
ordinary verb arguments using each verb's `arg_spec.command` metadata.

The command policy is catalog-owned metadata plus small object verbs. Core
provides the tokenizer, cross-host object/verb matching, command-pattern
matching, and route selection; the chat catalog declares that `:foo` means
emote, `/tell` means private speech, bare text means `:say`, and object commands
such as `give lamp to Pat` dispatch on the carried object.

The parser is location-scoped rather than tied to where the actor object lives.
If the actor is in a room hosted elsewhere, `here`, room contents, and actor
inventory still resolve from the room and object model. If a visible object
lives with another host, the planner reads only its display metadata and
verb/direct-callability/arg-spec metadata, then leaves execution to normal direct or
sequenced dispatch.

```woo
verb $conversational:command_plan(text) rxd {
  return $match:plan_command(text, this);
}
```

The explicit lowering still matters because `:say(text: str)` and
`:tell(recipient: obj, message: str)` are ordinary verb signatures, not
parser-shaped. Verbs declare their lowering through `arg_spec.command`.

This is what stress-tests `$match`: a real chat surface using the parser end-to-end. Bugs in pattern matching, preposition handling, or feature-aware verb lookup surface as misrouted commands, observable in the demo.

## Embedded mode

The same chat client connecting to `the_taskspace` shows:
- The taskspace's chat (`said`, `emoted`, `entered`, `left` live observations).
- The taskspace's task-state changes (`task_created`, `status_changed`, etc.) as applied frames in the *same* feed.

Two streams, one timeline. The renderer distinguishes by observation type but renders both as text lines. This is what makes "chat embedded inside a workspace" not a separate UI mode — it's the same UI, with one extra feature attached.

## Scope cuts

Out of scope for this demo:

- Channels and richer world geography beyond the tiny LambdaHouse path.
- IRC-style modes/ops, kick/ban.
- Threading, replies, edits, reactions, typing indicators.
- Logged chat history, search, scrollback beyond the live session.
- Direct messages outside a room (DMs as a separate space).
- Spell correction, fuzzy matching beyond `$match`'s prefix rule.
- Voice or media. Text only.

Reserved as natural follow-ons:

- A logged `$chatroom_logged` variant that overrides `:say` to sequence through the log.
- More complete `$exit` behavior (doors, keys, locks, open/close).
- A `$mail_recipient` feature for asynchronous messages between disconnected actors.

## Why this demo exists

Three reasons:

1. **Stress-test composition.** Feature objects are a load-bearing piece of MOO that woo just inherited. The chat demo proves they work, with concrete consumer classes (`$chatroom`, `$taskspace`) sharing one feature implementation.
2. **Brings `$match` into use.** The text-to-action pipeline scaffolded in [match.md](../../spec/semantics/match.md) gets exercised end-to-end. Bugs surface as misparsed commands.
3. **Agents talk to each other.** The motivation: agents coordinating via verbal exchanges in a room, possibly attached to their workflow's taskspace. Chat is the protocol; presence is the rendezvous.

Together with dubspace and taskspace, chat completes a triangle:
- Dubspace: low-latency, sensory, shared UI state.
- Taskspace: long-lived, inspectable, agent-friendly coordination state.
- Chat: live, social, presence-anchored conversation — the canonical MOO surface, working the same primitives.
