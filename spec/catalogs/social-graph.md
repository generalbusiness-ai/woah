---
date: 2026-05-12
status: draft
---

# Social graph

> Part of the [woo specification](../../SPEC.md). Layer: **catalogs**.
> Class-level spec for player-to-player social relationships: following
> (one-sided presence tracking), blocking (communication gating), and the
> player directory (opt-in name → actor lookup). Builds on
> [`$player`](../../src/core/bootstrap.ts) and the credentialed identity
> model in [spec/identity/auth.md](../identity/auth.md).

The social graph is deliberately minimal at this layer. Woo does not model
"friendship" as a bidirectional confirmed relationship. It models two
independent, asymmetric lists — **following** and **blocked** — that a player
controls unilaterally, plus an opt-in **directory** for name-to-actor lookup.
The design draws from LambdaMOO's `@gag` / `@refuse` precedent (see SG8) but
makes following an explicit first-class concept that LambdaMOO never had.

---

## SG1. Scope

This spec covers:

- `$player.following` and related verbs (SG2–SG3)
- `$player.blocked` and related verbs (SG4–SG5)
- Interaction rules: what follow/block do and don't affect (SG6)
- Presence events delivered to followers (SG7)
- `$player_directory`: opt-in name → actor lookup (SG9)
- Privacy and privacy-hiding behaviour (SG10)

Out of scope here:
- DM channels between players (`$dm_channel` — see
  [channels.md](channels.md))
- Teams and role-based membership ([spec/identity/teams.md](../identity/teams.md))
- Federation / cross-world identity ([spec/deferred/federation.md](../deferred/federation.md))

---

## SG2. Follow

**Follow** is a one-sided declaration: "I want to know when this actor is
online." It requires no consent from the followed actor and sends no
notification to them. It is the building block for a friends list.

Properties on `$player`:

```
player.following: list<obj>     // actors I follow; ordered by follow time
player.following_limit: int     // max list length; default 500
```

Verbs:

```
player:follow(target)
  // Adds target to following if not already present and list is not full.
  // target must be a valid, non-recycled $player descendant.
  // Guests MUST NOT follow (E_PERM). A guest actor's following list is
  // always empty and the verb raises E_PERM.
  // Returns true if added, false if already following.

player:unfollow(target)
  // Removes target from following. No-op if not present.

player:following_list()
  // Returns a projection of the following list:
  // [{actor, name, connected}] where connected is the last-known
  // connection state (may be stale projection, not authoritative).
```

`follow()` does NOT require the target to have a credentialed account. You can
follow any valid actor by ref, including bots and service actors. The follow is
stored by objref, not by account or username. If the actor is recycled, its ref
stays in the list as a stale entry; `following_list()` marks it `valid: false`.

---

## SG3. Unfollow

`unfollow()` removes the actor from the following list. No notification to the
unfollowed actor. If the actor is also in `blocked`, unfollowing has no effect
on the block (the two lists are independent).

---

## SG4. Block

**Block** is a one-sided communication gate: "I do not want to receive
communication from this actor, and I do not want them to know my presence
status." Blocking is silent — the blocked actor receives no notification and
no indication that their messages are not reaching you.

Properties on `$player`:

```
player.blocked: list<obj>       // actors I have blocked; unordered
player.blocked_limit: int       // max list length; default 500
```

Verbs:

```
player:block(target)
  // Adds target to blocked list. If target is in following, removes it
  // from following first. Returns true if added, false if already blocked.

player:unblock(target)
  // Removes target from blocked list. Does not restore a prior follow.
```

Blocking enforces the following gates (see SG6 for details):

1. **Output silencing**: output originating from a blocked actor's turns is
   not delivered to the blocking player. This mirrors LambdaMOO `@gag`.
2. **Inbound communication refusal**: page, whisper, and `tell()` calls
   targeting the blocking player and originating from a blocked actor are
   silently dropped. The sender receives no acknowledgement or error. This
   extends LambdaMOO's `@refuse page` / `@refuse whisper`.
3. **Presence opacity**: the blocking player's connection state is not
   included in presence queries or presence events visible to the blocked
   actor. See SG10 for v1 limitations.
4. **Implicit unfollow**: adding to blocked removes from following.

---

## SG5. LambdaMOO social primitives — verified from live DB

*(Verified by live MCP inspection of LambdaMOO, May 2026.)*

LambdaMOO's social graph was built across several inherited player classes, not
all in `$player` (#6) core. The full mechanism spans:

### Gag — `$player` (#6) core

Properties: `gaglist` (list of player/object refs), `object_gaglist` (derived).
Verbs: `@gag`, `@ungag`, `@listgag`, `gag_p()`, `@gag-site` (site-block for guests).

`@gag` is purely an **output filter** enforced in `$player:tell`. Gagging stops
you from seeing any output originating from a gagged player's turns: speech,
emotes, whispers. It does NOT prevent the gagged player from paging you,
whispering to you, or moving you. It is silent and one-sided — the gagged
player receives no indication.

`@gag-site` extends this to ban all guests from the same IP/site as a named
guest, with an expiry duration. Site identity is kept confidential.

### Refuse — Frand's player class (#3133)

`@refuse` is defined on `#3133`, inherited down a long chain ending at
`$player`, not defined on `$player` itself.

Properties on `#3133`:
- `refused_actions: {}` — which actions are refused globally (from everyone)
- `refused_origins: {}` — per-player refusals
- `refused_until: {}` — expiry timestamps per refusal
- `refused_extra: {}` — additional refusal metadata
- `default_refusal_time: 604800` — 1 week default expiry (seconds)
- `report_refusal: 0|1` — opt-in: notify the refusing player when a refusal fires
- `page_refused_msg`, `whisper_refused_msg`, `mail_refused_msg` — configurable messages
- `spurned_objects: {}` — objects (not players) whose actions are refused

Refusable actions (from `me:refusable_actions()`):
```
{"page", "whisper", "move", "join", "accept", "mail",
 "politics", "entry", "flames", "theft"}
```

Key semantics:
- `@refuse page whisper from X` — per-player, expires after `default_refusal_time`
- `@refuse page` (no "from") — global, refuses from everyone
- Refusals are **time-limited by default** (one week). You can specify a
  longer duration: `@refuse page from X for 3 months`.
- `@refusal-reporting on` — the refusing player is notified when a refusal
  fires. This is opt-in; by default refusals are silent.
- `move` refusal prevents a player from teleporting you via programmed exits.
  Normal (unprogrammed) exits are unaffected.
- `join` refusal only works in rooms that explicitly support it.
- `theft` and `entry` are later additions not in all player classes.
- `flames` and `politics` are mail-list moderation controls.

### Pals — SSSPC (#40099, third-party player class)

`pals` is a property on Sick's Slightly Sick Player Class, **not** on `$player`
core. It is just a list of player refs with no automatic presence integration.

Verbs: `@add-pals`, `@remove-pals`, `@list-pals`, `@who-pals`, `@online-pals`.

`@online-pals` and `@who-pals` are **pull queries** — you run them manually to
see which pals are connected. There is no push notification when a pal connects.
LambdaMOO never had automatic "your friend just connected" notifications.

### Anti-spoofing — `$player` core

`paranoid: 0|1|2` property; `@paranoid`, `@check`, `@sweep` verbs.
- Level 0: normal.
- Level 1: records recent messages with originator identity; `@check` reviews them.
- Level 2: every message is prefixed with sender name and object number live.

### Mapping to Woo

| LambdaMOO mechanism | Data | Woo equivalent |
|---|---|---|
| `@gag` + `gaglist` | Per-player output filter, permanent until removed | `block()` gate 1 (output silencing) |
| `@refuse page/whisper` from X | Per-player, time-limited, opt-in reporting | `block()` gate 2 (inbound comm refusal). Woo is permanent, not time-limited. Woo is always silent. |
| `@refuse move` | Prevents being teleported by X | Out of scope v1; `moveto` hooks cover consent |
| `@refuse join` | Bars X from entering your room (room must support it) | Out of scope v1 |
| `@refuse accept` | Refuses objects handed/teleported to you by X | Out of scope v1 |
| `@refuse mail` | Refuses MOOmail from X | Out of scope until mail system exists |
| `@refuse theft` | Prevents X taking objects from you | Out of scope v1 |
| `@refuse entry` | Later addition; room-specific entry control | Out of scope v1 |
| `spurned_objects` | Refuse actions from specific objects, not players | No equivalent in v1 |
| `pals` (SSSPC) | Friend list, pull presence only | `$player.following` (with push presence — improved) |
| `@paranoid` | Anti-spoofing via message logging | Not needed: Woo observations carry typed `source`+`actor` fields |
| (no equivalent) | Automatic "pal connected" notification | `follow()` + `player_connected` live event — new in Woo |

**Key divergences from LambdaMOO:**

1. `@gag` (output-only) and `@refuse page/whisper` (inbound-only) are separate
   in LambdaMOO. Woo `block()` unifies them. If you only want output filtering
   without blocking inbound (the `@gag`-only case), that is not served in v1.
   A separate `mute()` can be added if the use-case is confirmed.

2. LambdaMOO `@refuse` is **time-limited** by default (1 week). Woo `block()`
   is **permanent** until explicitly removed. Time-limited blocking is a
   potential future addition but not in v1.

3. LambdaMOO `@refuse` has **opt-in notification** (`@refusal-reporting on`):
   the refusing player is told when a refusal fires. Woo `block()` is always
   silent — the blocking player receives no notification and the blocked player
   receives no indication.

4. LambdaMOO had no automatic presence push. Woo `follow()` adds push presence
   events (`player_connected` / `player_disconnected`) that LambdaMOO never had.

---

## SG6. Interaction rules

**What follow does:**

- You receive `player_connected` and `player_disconnected` live events when a
  followed actor's connection state changes (see SG7).
- You can call `followed_actor:connection_status()` to get their current state
  as a projection (may be stale).
- No other effects. Following does not grant access to their location, their
  inventory, or their messages.

**What block does:**

| Gate | What is blocked | Enforcement site |
|---|---|---|
| Output | Any observation routed to the blocking player where `observation.actor` matches a blocked actor | `$player:tell` / observation delivery; checked before delivery |
| Page | `$player:page(blocking_player, ...)` when caller's actor is in blocked list | The `page` verb; drops silently |
| Whisper | `$player:whisper(blocking_player, ...)` when caller's actor is in blocked list | The `whisper` verb; drops silently |
| Tell | `tell(blocking_player, ...)` when `actor` in the call context is in blocked list | `$player:tell` check |
| DM channel | Messages in `$dm_channel` shared between blocker and blocked are not delivered | `$dm_channel:say` checks member block lists before delivering |
| Presence | See SG10 | Presence event routing |

**What block does not do:**

- Block does not remove the blocked actor from shared spaces. They may still
  be in the same room; you just don't hear them and they don't hear you (if
  they've also blocked you, or more precisely, they don't hear output from
  their own observations reaching a blocked player — they still emit
  observations to the room).
- Block does not prevent the blocked actor from reading your publicly
  readable properties if they have object access.
- Block does not prevent them from seeing room-level descriptions that happen
  to include your name.
- Block is not wizard-overridable by default. A wizard can still use `tell()`
  and other admin paths because those bypass the presence-check model, but
  content-originating observations from a wizard who is on your blocked list
  are still silenced from your view.

**Follow + block interaction:**

- `block(X)` implies `unfollow(X)` if X was followed.
- `follow(X)` is rejected with `E_PERM` if X is in blocked list (must
  unblock first).
- Following someone does not confer any special two-way visibility; if they
  have you blocked, your presence events are still withheld from them.

---

## SG7. Presence events

When a followed actor's connection state changes, a `player_connected` or
`player_disconnected` live event is emitted to their followers.

```ts
// Observation shapes:
{ type: "player_connected",    source: actor, actor: actor, ts: number }
{ type: "player_disconnected", source: actor, actor: actor, ts: number }
```

These are **live events** (not committed turns). They are best-effort, may be
dropped under backpressure, and are not replayed through catch-up. Clients that
need authoritative presence state should call `actor:connection_status()` on
reconnect to refresh their view.

The routing audience for a `player_connected` event is:
```
actor.following_reverse_index ∩ (not actor.blocked)
```

`following_reverse_index` is a derived set: all actors who currently follow
this actor. It is maintained lazily by the `follow()` and `unfollow()` verbs
on the followed actor's node (by emitting a reverse-index update observation
when called). The reverse index is **not** durable state of `$player` — it
is a projection maintained by the session infrastructure for event routing.

**v1 limitation**: the reverse index is maintained in-memory on the actor's
session host. It does not survive host restart. On reconnect, the client is
responsible for refreshing its presence view. A durable reverse index is
deferred to v2 infrastructure.

---

## SG8. LambdaMOO notes

LambdaMOO's social primitives were almost entirely defensive:

- `gaglist` (property): list of players whose output you filter
- `object_gaglist` (property): list of non-player objects whose output you filter
- `@gag` / `@ungag` / `@listgag`: manage the two lists
- `@refuse moves`: block being moved by others
- `@refuse page`, `@refuse whisper`, `@refuse mail`: block specific comm types
- No "friends" or "following" concept; the social graph was entirely negative

The `@gag` mechanism filtered at `$player:tell` — LambdaMOO's universal
output primitive. Every message to a player went through `:tell`; if the
message originator was in the recipient's gag list, it was silently discarded.
`gag_p()` was the helper predicate for this check.

The `@refuse` variants were separate from `@gag` and targeted specific
interaction verbs. A gagged player could still page or whisper you (their
attempt would succeed from their perspective); `@refuse page` was needed to
prevent receiving pages. Woo's `block()` unifies both into a single mechanism.

LambdaMOO had no concept of tracking who is online. The `@who` command listed
all connected players globally — a luxury that does not scale to big-world
and is not available in Woo's distributed model.

---

## SG9. Player directory

`$player_directory` is a catalog-installed singleton that maps actor names
and account usernames to actor refs. Opt-in; not all players are listed.

```
$player_directory:register(actor, username)
  // Registers actor under username. Called by the auth system on
  // credentialed login if the player has not opted out.
  // Guests are never registered.

$player_directory:unregister(actor)
  // Removes the registration. Called on account deletion or opt-out.

$player_directory:lookup(query) → list<{actor, name, username?}>
  // Returns at most 10 matching results by prefix-match on name or
  // username. Does not return actors who have blocked the caller.
  // Does not return actors who have set privacy.visible = false.
```

The directory is a bounded service, not a global scan. In a big world the
directory is eventually a federated catalog but in v1 it is a single
`$player_directory` object. The lookup verb returns only public information
(name and objref); callers get nothing more without the target's consent.

A player opts out by calling `$player_directory:unregister(self)` or setting
`player.directory_visible = false`. Default for credentialed players is
`true`; default for guests is always `false`.

---

## SG10. Privacy and presence hiding

**v1 behaviour:**

- A player's connection state is readable via `actor:connection_status()` by
  anyone who has their objref. There is no per-actor access control on this
  in v1.
- Block prevents the blocking player from seeing presence events from blocked
  actors (gate: the blocked actor is excluded from the follower audience).
- Block does NOT prevent the blocked actor from seeing the blocking player's
  presence events in v1. Presence hiding (block → blocked actor cannot see
  your presence) requires a reverse block index and is deferred.
- `$player_directory:lookup()` excludes blocked actors from results for the
  caller (they can't find you via directory if you've blocked them). This is
  the only v1 presence-hiding guarantee.

**v2 / deferred:**

- Durable reverse block index allowing presence hiding
- Per-actor privacy settings (`privacy.visible = false` suppresses all
  presence events to all non-followers)
- `@who` equivalent scoped to shared spaces, not global

---

## SG11. What's deferred

- **Mute** (output-only block, without communication refusal). Useful for
  "I find you noisy but I still want you to be able to DM me." Add if the
  use-case arises.
- **`@refuse moves`** — physical-movement consent. Covered by `moveto` hooks
  if needed; not modeled here.
- **Presence hiding for blocked** — requires durable reverse index (SG10).
- **Global who-list** — not available; deliberately excluded by Big-World
  discipline.
- **Mutual-follow confirmation** ("friend request") — no bilateral state in
  v1; follow is one-sided. A bilateral confirmed-friends tier can be added
  as a feature on top of mutual follows.
- **Federation** — following/blocking across worlds. Reserved for
  [federation.md](../deferred/federation.md).
- **Reporting / moderation integration** — block list as input to a moderation
  workflow. Out of scope at this layer.
- **Account-level contacts** (vs. per-character) — follow/block currently
  lives on `$player`, not `$account`. Multi-character users have independent
  lists per character. Account-level social state is deferred until
  multi-character semantics are stable.
