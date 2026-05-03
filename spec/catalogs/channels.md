---
date: 2026-05-03
status: draft
---

# Channels

> Part of the [woo specification](../../SPEC.md). Layer: **catalogs**.
> A class-design spec for Slack/Discord-style persistent conversation
> channels. Builds on the persistent-conversational feature
> ([persistent-conversation.md](persistent-conversation.md)) for
> durable utterances; adds membership, visibility tiers, deterministic
> DM uniqueness, and one-way promotion (dm → group → public).

How woo represents named conversation channels with explicit membership.
Three tiers — direct messages between exactly two actors, named groups
between an explicit set, and discoverable public channels open to
anyone — sharing one underlying class hierarchy and one durable
log. The DM tier is *unique by construction* via deterministic
corenames; promotion is one-way from DM through group to public, with
the room's identity and sequenced log preserved across the transition.

This spec is a v1 draft. Several decisions (history-visibility on
join, demotion, invite authority) have a chosen position in the
conformance section but are flagged in CH13 as worth revisiting if
real usage shows the picks were wrong.

---

## CH1. Motivation

Today's chat surface is room-shaped: actors enter `$chatroom`
instances, speak, and leave. Membership is implicit (whoever happens
to be present); history is ephemeral (per `$conversational`); names
are catalog-seeded. That works for the bundled Living Room demo but
doesn't model:

- A persistent two-person conversation that the participants come
  back to over days or weeks.
- An explicit "team" or "group" with a fixed member roster and shared
  history that survives anyone leaving.
- A discoverable channel where any actor in the world can join and
  contribute (#general, #help, #announcements).

A real chat product needs all three. `$channel` provides the class
hierarchy; the `$persistent_conversational` feature provides the
sequenced utterance surface. Together they cover the Slack/Discord
shape for v1, deferring threading, mentions, read state, and a few
subtler interactions to follow-ups.

---

## CH2. Class hierarchy

```
$channel < $persistent_chatroom
  .members:    list<map>           # [{actor, joined_seq, role?}, …]
  .visibility: "private" | "public"
  .creator:    obj                 # the actor who minted the channel
  
$dm_channel < $channel
  invariant: length(.members) == 2
  .visibility forced "private"
  registered under $system.dm_<sorted_a>_<sorted_b> (CH4)
  
$group_channel < $channel
  member-limited; .visibility forced "private"
  optional .name for display
  
$public_channel < $channel
  .visibility forced "public"
  registered in $system.public_channels (CH7)
  required .name (display name + address)
```

`$persistent_chatroom` provides the conversational surface (`:say`,
`:emote`, `:pose`, `:quote`, `:say_as`, `:history`). `$channel` adds
membership and visibility primitives. The three subclasses constrain
the membership invariants and visibility per their tier.

`.members` is a list of records, not a flat list of objrefs, because
each member needs a `joined_seq` (CH6) and may carry a per-member
role (CH13).

---

## CH3. Membership model

```
member record: {
  actor:       ObjRef,             # required
  joined_seq:  int,                # the channel.next_seq at time of join
  role?:       "owner" | "member"  # optional, see CH13
}
```

A channel exposes membership through accessor verbs:

| Verb | Returns | Notes |
|---|---|---|
| `:members()` | list of `{actor, role?}` | Hides `joined_seq` from non-wizards. |
| `:is_member(actor)` | bool | |
| `:member_count()` | int | |
| `:member_record(actor)` | map or null | Full record; wizard or self. |

Mutation goes through `:invite()`, `:join()`, `:leave()`, `:kick()`
(CH8). Every membership change is itself a sequenced utterance
emission so it appears in `:history()` as a structured event:

| `type` | Fields |
|---|---|
| `member_joined` | `{channel, actor, joined_seq}` |
| `member_left` | `{channel, actor, left_seq, reason: "left"|"kicked"}` |
| `channel_promoted` | `{channel, from_class, to_class, ts}` |

These join the public-utterance types (`said`, `emoted`, etc.)
already in the room's log.

---

## CH4. DM uniqueness via deterministic corename

A direct-message channel between two actors is **unique by
construction**: given a pair, there is at most one $dm_channel
holding that exact pair as members at any time. The mechanism is
a derived corename in `$system`:

```
corename:  dm_<min_objref>_<max_objref>
mapping:   $system.<corename> → channel objref
```

`$me:dm_with(other)` resolves the corename:

```woo
verb $actor:dm_with(other) rxd {
  if (other == this) {
    // Self-DM allowed by default (CH9). Catalog MAY override to refuse.
  }
  let names = sort_objrefs([this, other]);
  let key = "dm_" + names[1] + "_" + names[2];
  let existing = $system:resolve_corename(key);
  if (existing != null) { return existing; }
  let dm = create($dm_channel, {
    name:    "",                   // DMs have no display name
    creator: this,
    members: [
      { actor: this,  joined_seq: 0 },
      { actor: other, joined_seq: 0 }
    ],
    visibility: "private"
  });
  $system:register_corename(key, dm);
  return dm;
}
```

`$me:dm_with(other)` is the canonical entry point. Both participants
compute the same corename and reach the same channel.

The actor objrefs in the corename are concrete ids — corenames if
the actors have them, else seed names, else ULIDs (per
[routing.md §AR2](../protocol/routing.md#ar2-url-form)). Sorting is
lexicographic on the id string. Two actors with stable corenames
produce a stable channel address; two guest actors with reused
runtime ids produce an address that may collide across guest
sessions if the substrate ever recycles ids — this is acceptable
because guests are short-lived by design and DMs anchored to ephemeral
guests are themselves ephemeral.

---

## CH5. Promotion

Promotion is one-way and explicit: dm → group → public. Each step is
a `chparent` plus targeted side-effects.

### CH5.1 dm → group

Triggered automatically when `$dm_channel:invite(actor)` is called
(the DM has exactly 2 members; adding a third violates the dm
invariant). Steps:

1. `chparent(this, $group_channel)`.
2. **Unmap the dm corename.** `$system:unregister_corename("dm_<a>_<b>")`.
   This is the load-bearing step for "subsequent `dm_with(a, b)`
   creates a fresh DM" — the corename is freed.
3. Append the new member record to `.members` with current
   `next_seq` as `joined_seq`.
4. Emit `member_joined` and `channel_promoted` observations.

### CH5.2 group → public

Explicit operator action: `$group_channel:promote_to_public(name)`.
Owner-only (CH8). Steps:

1. Validate `name` is unique in `$system.public_channels`.
2. `chparent(this, $public_channel)`.
3. Set `.visibility = "public"`.
4. Set `.name = name`.
5. **Register in the public-channels index.**
   `$system:register_public_channel(name, this)`.
6. Emit `channel_promoted` observation.

### CH5.3 Demotion (deferred)

public → group and group → dm/private demotions are not in v1 (CH14).
They are real but messy: people may have shared messages publicly
already, references may be in flight, and the corename uniqueness
property doesn't trivially restore for dm-direction. A demotion spec
needs to land before `:promote_to_public()` is widely used or every
channel becomes a one-way trip.

---

## CH6. History visibility per-member

When Carol joins alice + bob's DM-turned-group, what does her
`:history()` return?

**Chosen v1 rule: from-join.** A member's `:history()` returns only
utterances and channel events with `seq >= caller.joined_seq`. Per-
member `joined_seq` tracking is mandatory for this filter (CH3).

```woo
verb $channel:history(limit, before_seq) rxd {
  let me = $channel:member_record(actor);
  if (me == null && this.visibility != "public") {
    raise { code: "E_PERM", message: "not a member" };
  }
  let from_seq = me == null ? 0 : me.joined_seq;
  // ... existing tail-window scan from persistent-conversation PC7,
  //     plus an `obs.seq >= from_seq` filter
}
```

Why from-join over alternatives:

- **Full-history (every member sees everything from time zero)**:
  simplest, most transparent. Rejected because alice and bob's
  pre-Carol DM conversation is suddenly visible to Carol when she
  joins, which they may not have intended.
- **Fork on promotion**: the original DM stays frozen; promotion
  creates a NEW group with no carried-over history. Rejected because
  the user-described feel is "same room, just bigger" — the channel
  identity and stable URL should survive promotion.

Edge cases for v1:

- **Rejoining**: a member who left and was re-invited gets a new
  `joined_seq` for the rejoin; their `:history()` filter uses the
  highest `joined_seq` across rejoins. Earlier participation history
  remains hidden post-rejoin. (Worth revisiting per CH13.)
- **Public channels**: `:history()` is callable by non-members
  (visibility is public). Non-members see history from `seq = 0` —
  public channels are public from time zero. Members still see from
  their `joined_seq` for consistency, but for public channels the
  difference is moot since both views are unrestricted.
- **Promotion seq boundary**: pre-promotion DM history is filtered
  by `joined_seq` for new members of the promoted group — alice/bob
  see everything (joined_seq = 0); Carol sees from her join. The
  `channel_promoted` observation itself appears in the log at the
  promotion seq, so Carol's view starts cleanly with that boundary
  marker.

---

## CH7. Discoverability of public channels

`$system.public_channels` is a property: a map keyed by display name
to channel objref.

```
$system.public_channels: map<str, obj>
  e.g. { "general": <objref>, "help": <objref>, "announce": <objref> }
```

Three accessors live on `$system`:

| Verb | Purpose |
|---|---|
| `:list_public_channels()` rxd | Returns `[{name, channel, member_count, description?}]`. Direct-callable; anyone can call. |
| `:resolve_public_channel(name)` rxd | Returns the objref or null. |
| `:register_public_channel(name, channel)` r | Wizard or `$channel:promote_to_public` only. Sequenced. |

Public-channel discovery is intentionally a flat namespace per
deployment. Hierarchy / categories / tagging are deferred (CH14).
Sorting and pagination are client-side concerns over the
`:list_public_channels()` result.

The public-channel name is also a discoverable corename:
`$system.<name>` resolves to the channel. URLs work both ways
(`/objects/$general` and `/objects/<channel-objref>` resolve the
same object per [routing.md §AR2](../protocol/routing.md#ar2-url-form)).

---

## CH8. Verb surface

| Class | Verb | Perms | Behavior |
|---|---|---|---|
| `$actor` | `:dm_with(other)` rxd | self only | Find or create the DM with `other`. CH4. |
| `$channel` | `:members()` rxd | member or wizard | List of `{actor, role?}`. |
| `$channel` | `:is_member(actor)` rxd | anyone | Returns bool. |
| `$channel` | `:member_count()` rxd | anyone | Returns int. |
| `$channel` | `:join()` r (sequenced) | public-only; private raises E_PERM | Adds caller to `.members`. Emits `member_joined`. |
| `$channel` | `:invite(actor)` r | member | Adds `actor` to `.members`. On `$dm_channel`, also promotes (CH5.1). On `$public_channel` is a no-op alias for "actor joins" (caller authority not required). |
| `$channel` | `:leave()` r | self | Removes caller from `.members`. Emits `member_left {reason: "left"}`. |
| `$channel` | `:kick(actor)` r | creator or wizard | Removes `actor`. Emits `member_left {reason: "kicked"}`. |
| `$group_channel` | `:promote_to_public(name)` r | creator or wizard | CH5.2. Validates `name` uniqueness. |
| `$dm_channel` | `:invite(actor)` r | both DM members | Promotes (CH5.1) + invites. |

`$channel:invite` chooses behavior by class:

```woo
verb $channel:invite(actor) r {
  if (parent(this) == $dm_channel) {
    chparent(this, $group_channel);
    $system:unregister_corename(this:dm_corename());
    observe({ type: "channel_promoted", channel: this,
              from_class: "$dm_channel", to_class: "$group_channel",
              ts: now() });
  }
  // common path: append member, emit observation
  let now_seq = this.next_seq;
  this.members = this.members + [{ actor: actor, joined_seq: now_seq }];
  observe({ type: "member_joined", channel: this,
            actor: actor, joined_seq: now_seq, ts: now() });
  return true;
}
```

Membership-mutation verbs are **sequenced** (per the persistent-chat
contract — they're durable events the room records). Read verbs are
direct.

---

## CH9. Self-DMs

`$me:dm_with($me)` is allowed by default. It creates a `$dm_channel`
with two member entries pointing at the same actor — a notes-to-self
channel where the only participant is the caller. The deterministic
corename collapses to `dm_<self>_<self>`, which is unambiguous.

Catalogs that want to forbid self-DMs MAY override `$actor:dm_with`
to raise `E_INVARG` when `other == this`. The default v1 contract
permits it because it's a useful pattern (private journal, scratch
notes) and the cost of supporting it is zero.

---

## CH10. Interaction with existing chatrooms

`$channel` does not replace `$persistent_chatroom`; it specializes it.
A bundled-demo room like `the_chatroom` (a `$chatroom` instance) can:

- Stay a $chatroom (ephemeral, no membership). No change.
- Be `chparent`-ed to `$public_channel` and have its corename
  registered in `$system.public_channels`. Past ephemeral utterances
  are not in the log; post-promotion utterances are. Membership
  starts empty; actors join via `:join()`.

The bundled demo seeds (Living Room, Deck, Hot Tub) stay
$chatroom-shaped in the demoworld catalog. Operators who want a
demoworld channel surface seed `$public_channel` instances explicitly.

---

## CH11. Trade-offs and storage

Storage cost per channel scales with utterance volume + membership
events. A two-person DM with 50 messages/day is ~25 KB/day, ~9 MB/year.
A 30-member group with 500 messages/day plus join/leave churn is
~250 KB/day, ~90 MB/year. A high-traffic public channel can grow
materially; CH14 lists retention as a deferred concern shared with
persistent-conversation.

Latency: every membership change and every public utterance is a
sequenced call (~400–700 ms warm). A user typing in a fast back-and-
forth DM will feel the same latency as in any persistent chatroom —
this is the cost of durability. Acceptable for slow-conversation use
cases (the pattern Slack/Discord cover); a real-time-feeling DM
needs a different approach (auto-degraded ephemeral mode, or
batched-flush — both deferred).

---

## CH12. Conformance

A catalog conforms to this spec if it provides:

1. The four classes in CH2 with the stated invariants.
2. `$actor:dm_with(other)` with the deterministic-corename behavior in
   CH4.
3. Per-member `joined_seq` tracking and the from-join `:history`
   filter in CH6.
4. Sequenced membership-mutation verbs (`:invite`, `:join`, `:leave`,
   `:kick`) emitting the observation types in CH3.
5. The public-channel index at `$system.public_channels` with the
   accessors in CH7.
6. One-way promotion (CH5) with corename unmapping on dm → group.

A client conforms if it surfaces the channel hierarchy in a way that
respects per-member visibility (a non-member of a private channel
must not see the channel's history or membership through this client)
and uses `:dm_with`/`:join`/`:invite` rather than constructing
channel objects directly.

---

## CH13. Open decisions parked for v1

These have a chosen position in the v1 spec but are worth revisiting
if real usage shows the picks were wrong.

- **History-on-join policy.** From-join filter (CH6). Alternatives:
  full-history; fork-on-promotion. From-join wins on privacy +
  identity-preservation but costs per-member state.
- **Invite authority in groups.** Any-member can invite (Slack
  default). Alternatives: creator-only; role-based. v1 picks
  any-member; CH3's optional `role` field is the seed for richer
  policies later.
- **Naming policy.** DMs unnamed (UI synthesizes "Alice & Bob");
  groups optional name; public required name and unique. Alternative:
  every channel named, including DMs. v1 picks unnamed-DMs because
  the deterministic corename already names the relationship.
- **Demotion (CH5.3).** Out of v1. Real but tangled; needs its own
  pass once the v1 model is shipped.
- **Rejoin-history.** A member who left and rejoined sees only from
  their highest `joined_seq`. Alternative: re-grant access to all
  pre-leave history they previously had. v1 picks the simpler rule.
- **Self-DM.** Allowed (CH9). Alternative: forbid as nonsensical.
  v1 allows for the scratch-notes use case.
- **Where `:dm_with` lives.** On `$actor` (so it's a personal
  affordance). Alternative: a wizard verb on `$system`. v1 picks
  `$actor` to match the user-driven flow ("I want to DM this
  person").
- **Owner / role model.** v1 has only `creator` (the original
  minter); `kick` and `promote_to_public` are gated on creator-or-
  wizard. Alternatives: role-based (admin/moderator/member);
  delegated-owner via a second property. v1 keeps it simple to avoid
  shipping a half-baked role hierarchy.

---

## CH14. What's not in v1

- **Threading.** Reply threads inside a channel — explicitly out per
  the originating ask. A thread is itself a kind of nested
  conversation; it can land as a separate `$thread` class linked
  from a parent message, when the SPA UX is ready.
- **Mentions / `@`-references.** Highlighting messages that name a
  specific actor; per-actor "you were mentioned" indexes. Useful but
  out of scope.
- **Read state.** "Last seen seq" per actor per channel for unread
  badges. Naturally lives on the actor (`$actor.channel_seen: map<obj,
  int>`) per CH13's general philosophy; not specced here.
- **Demotion** (CH5.3).
- **Cross-deployment channels.** DMs and channels are per-deployment;
  cross-world chat is federation v2.
- **Search across channels.** "Find all messages mentioning X."
  Cross-room indexing; out of scope.
- **Retention / `:trim_history`.** Same concern as
  persistent-conversation PC12; deferred there.
- **Encrypted channels.** Per-channel keys with member-key delivery;
  separate identity story.
- **Categories / hierarchy / tagging for public channels.** Flat
  namespace in v1.
- **Auto-archive on inactivity.** A retention/archival concern;
  defer with retention.
- **Channel-scoped permissions** (only some members can speak; only
  some can invite). v1 has any-member-can-invite + creator-can-kick;
  richer policy needs the role model that's deferred in CH13.
- **Voice / video / presence beacons** beyond what `$space`
  presence already provides.
- **Bots / programmatic-channel members.** A `$bot` or service
  account is just an actor with the right credentials; no special
  channel support needed. Worth a paragraph in a follow-up if usage
  diverges.
