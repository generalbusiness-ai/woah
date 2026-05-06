---
date: 2026-05-03
status: draft
---

# Persistent conversation

> Part of the [woo specification](../../SPEC.md). Layer: **catalogs**.
> A catalog-design spec for conversational features on `$space`
> descendants. The substrate primitives this depends on (features,
> sequenced calls, applied frames, replay, audience override) are
> normative in [semantics/features.md](../semantics/features.md),
> [semantics/space.md](../semantics/space.md), and
> [semantics/sequenced-log.md](../semantics/sequenced-log.md).

How a `$space` records, or deliberately does not record, public
conversation. The user-facing affordance is the same in both modes:
chat is a UI to the current space. If the current space is a pinboard,
then `say hello` speaks in the pinboard, `drop note` drops the note
onto the pinboard, and the pinboard's own placement and movement
semantics remain authoritative.

The persistence choice is a feature choice:

```
$conversational
  ephemeral chat feature for any $space

$persistent_conversational
  durable chat feature for any $space

$chatroom
  convenience space with $conversational attached

$persistent_chatroom < $chatroom
  convenience space with persistent conversation composed for you
```

`$persistent_chatroom` is useful, but it is not the core abstraction.
The core abstraction is "this space has a conversational surface,"
with either ephemeral or persistent durability.

---

## PC1. Motivation

Today's `$conversational` feature (catalog `chat`) is *ephemeral*.
`:say`, `:emote`, and similar are direct-callable: they emit
observations to current subscribers and are not appended to the
space's sequenced log. A new actor entering sees nothing of what was
said before; an actor whose WebSocket dropped briefly misses anything
emitted during the gap.

That's the right default for casual spaces: direct `:say` is fast
(~50 ms) and avoids the per-utterance cost of sequencing. The same
affordances are useful in spaces that are not chatrooms: a taskspace,
a pinboard, a dubspace, or another application surface can attach
`$conversational` and gain a current-space chat UI without becoming
a room subclass.

Several real cases need the opposite durability trade-off:

- A board meeting or recurring sync where decisions matter.
- A support channel where transcripts are part of the audit trail.
- A long-running async discussion (chat-as-forum) where activity is
  the space's primary state.
- A code-review, taskspace, or pinboard where messages should be
  co-ordered with mutations to the work.

For these, the space itself should hold the record, not the
WebSocket fan-out at any given moment.

---

## PC2. Mechanism: direct vs sequenced verbs

`$space`'s call lifecycle ([space.md §S2](../semantics/space.md#s2-call-lifecycle))
distinguishes two paths:

- **Direct call**: executes immediately on the host, emits live
  observations, returns. Not appended to the sequenced log. Cheap
  (~50 ms warm), ephemeral.
- **Sequenced call**: routes through the space's `:call`, which
  appends a message to the `$sequenced_log` ancestor's log, applies
  the verb in a transactional frame, and broadcasts the resulting
  observations. More expensive (~400-700 ms warm), durable.

The runtime selects the path from a verb's metadata, specifically the
`direct_callable: bool` field set at install time. (The `d` character
in a perm string is one signal an authoring tool may use to ask for
direct-callable, but the normative truth is the boolean field on the
installed verb. A spec or migration that asserts "make this verb
sequenced" should set `direct_callable: false` explicitly rather than
rely on perms-string parsing.) When `direct_callable` is false, every
caller must reach the verb through the space's `:call`; attempting a
direct call raises `E_DIRECT_DENIED`.

This gives the persistent-conversation design its mechanism:
`$persistent_conversational` provides the same public utterance verbs
as `$conversational`, but marks durable utterance verbs
`direct_callable: false`. The consumer space's existing log then
stores the utterances next to the rest of that space's sequenced
activity.

---

## PC3. Feature shape

`$conversational` and `$persistent_conversational` are features that
may be attached to any `$space` descendant per
[features.md](../semantics/features.md). Feature lookup runs after
the consumer's parent chain, so a conversational feature fills in
missing verbs but does not override the space's native behavior.

That precedence is intentional. On a pinboard, `:post`, `:take`,
`:drop`, `:enter`, `:leave`, and `:enterfunc` remain pinboard
behavior. The chat UI sends commands to the current space; the
space decides whether a note is acceptable and where it lands.

**Shared affordance.** Both features provide the same public chat
surface:

| Verb | Observation type | Meaning |
|---|---|---|
| `:say(text)` | `said` | Public utterance in the current space. |
| `:emote(text)` | `emoted` | Public action. |
| `:pose(text)` | `posed` | Public stylized utterance. |
| `:quote(text)` | `quoted` | Public quotation. |
| `:say_as(style, text)` | `said_as` | Public styled speech (no recipient). |

**Durability difference.**

| Feature | Public utterance route | History |
|---|---|---|
| `$conversational` | direct-callable; live-only | no durable transcript |
| `$persistent_conversational` | sequenced through the current space's `:call` | `:history()` filters the current space's replay |

**Verbs that stay direct** (private speech, view, and compatibility planning; see
PC6 for the privacy reasoning on tell/say_to):

| Verb | Why stays direct |
|---|---|
| `:tell(recipient, text)` | Private directed message; not part of public history. |
| `:say_to(recipient, text)` | Same; recipient-directed speech. |
| `:look`, `:who` | Read-only view, if supplied by the feature rather than the consumer. |
| `:history(limit, before_seq)` | Read-only transcript query for persistent spaces. |
| `:command_plan`, `:command` | Compatibility planning/command surface. Browser text input uses wire `op:"command"` so the server can choose direct vs sequenced without a catalog round trip. |

The durable utterance bodies should otherwise match `$conversational`:
same observation shape, same permission gates, same return values.

---

## PC4. Convenience classes

`$chatroom` and `$persistent_chatroom` are convenience classes, not
separate affordance models.

```
$chatroom
  features: [$conversational]

$persistent_chatroom < $chatroom
  features: [$persistent_conversational]
```

A catalog may implement the persistent convenience class by attaching
`$persistent_conversational`, by redefining the inherited public
utterance verbs with `direct_callable: false`, or by another
catalog-authoring mechanism that produces the same installed verb
metadata. The normative behavior is the metadata and current-space
semantics, not a particular authoring trick.

Instance composition is equally valid:

```
the_pinboard.features = [$transparent]
```

or:

```
the_pinboard.features = [$persistent_conversational]   // if no acoustic forwarding is needed
```

For an embedded board that should keep the acoustic behavior of
`$transparent`, the durable catalog should provide the corresponding
persistent transparent feature rather than stacking two features with
overlapping speech verbs.

The generic `$pinboard` class should remain able to stand alone.
Attaching conversation to a demo instance is an instance-level
composition choice unless the pinboard catalog explicitly chooses
otherwise.

### PC4.1 The two features are mutually exclusive on a consumer

`$conversational` and `$persistent_conversational` define the same
public utterance verbs. By [features.md §FT2](../semantics/features.md#ft2-verb-lookup-with-features),
when both are attached to the same consumer, *the first feature in
list order whose chain defines the verb wins*. A consumer that has
`features: [$conversational, $persistent_conversational]` resolves
`:say` to `$conversational`'s direct version, and the persistent
intent is silently lost.

A migration that swaps ephemeral for persistent (or vice versa)
MUST remove the outgoing feature before adding the incoming one:

```
the_lobby:remove_feature($conversational)
the_lobby:add_feature($persistent_conversational)
```

A consumer that ends up with both attached SHOULD be considered
misconfigured; the persistent feature's installer (or a host repair
pass) MAY refuse to attach if the ephemeral feature is already
present, and vice versa.

### PC4.2 Class-level feature attachment

`.features` is per-instance state ([features.md §FT1](../semantics/features.md#ft1-the-features-property));
classes do not currently carry features themselves. The shorthand
`$persistent_chatroom features: [$persistent_conversational]` above
is descriptive of the **intended instance state**, not a class-level
field that exists today. Two routes for catalogs that want every
instance of a convenience class to start with the right feature:

- **Seed-hook attachment.** The catalog ships an `attach_feature`
  seed_hook for each seeded instance of the convenience class,
  alongside the `create_instance` hook. Works today; verbose for
  catalogs that seed many such instances.
- **Class-default features (substrate change, deferred).** Extend
  the class definition to carry a `default_features: [feature_ref]`
  list that the runtime auto-applies at `create()` time and at
  catalog install for fresh seeds. Touches
  [objects.md §10](../semantics/objects.md#10-properties)
  (object creation defaults) and
  [features.md §FT5](../semantics/features.md#ft5-adding-and-removing-features)
  (attach lifecycle); not in v1.

For v1, convenience-class catalogs use seed-hook attachment.

---

## PC5. Timestamps inside sequenced verbs

The current `$conversational` verb bodies set `ts: now()` on the
emitted observation. For sequenced verbs, the canonical "when this
happened" is the **applied frame's timestamp** (carried alongside
each frame in the log per [sequenced-log.md
§SL3](../semantics/sequenced-log.md#sl3-message-shape)), not the
verb body's `now()` call.

Two reasons to prefer the frame timestamp:

- **Replay parity.** `:replay()` returns the captured applied frames
  directly (it does not re-execute the verb), so the frame timestamp
  is what every reader sees.
- **Single source of truth.** Frame timestamp is the operator's
  authority for ordering. A verb that disagrees with its frame's
  timestamp is a bug surface waiting to happen.

`$persistent_conversational` SHOULD therefore reference the frame
timestamp (available to verb bodies as the applied frame's `ts`,
surfaced via the call context; exact accessor name TBD by the
DSL/runtime). For v1 the verb body MAY continue to call `now()` and
accept the small risk that the value matches at apply time.

---

## PC6. Directed messages stay private

`:tell(recipient, text)` and `:say_to(recipient, text)` deliver
**directed** observations: in `$conversational` today they emit
`{type: "told", from, to, text}` / `{type: "said_to", actor, to,
text}` to the current space broadcast. In an ephemeral space these
messages are live-only.

A persistent feature that sequenced these verbs would write private
content into the public space log. Once in the log, `:history()`
would return them to any caller unless history became
audience-aware.

The chosen v1 policy: **persistent conversation is public-only.**
`:tell` and `:say_to` stay direct (ephemeral, not logged). Operators
and catalog authors who need durable directed messages should use a
different durable channel (mail catalog when it exists, or a
per-actor log pattern), not the current space's public transcript.

A future audience-aware history implementation could relax this by
filtering `:history()` per caller: only returning observations the
caller was a member of the audience for at the time of emission. That
requires every applied frame's observations to carry a verifiable
audience list and the history filter to enforce it. Not in v1;
deferred to a follow-up that adds an explicit "audience-scoped
replay" primitive on `$space`.

---

## PC7. History via `$space:replay`

`$space:replay(from_seq, limit)` is already substrate ([space.md
§S5](../semantics/space.md#s5-replay)): it returns sequenced applied
frames including the observations each frame emitted. A persistent
conversation needs no new storage to expose chat history; it reads
a window of the current space's replay and filters to utterance
types.

This matters for embedded spaces. A persistent pinboard transcript
shares the pinboard log with board mutations. `:history()` returns
only utterances; full replay still exposes the board's applied
frames. The shared log gives one total order between "moved note"
and "said this."

**`:history()` returns the most recent N utterances by default.**
`:replay(0, N)` reads from the *start* of the log; for "show me the
last 50" the verb must compute the tail window from `next_seq`:

```woo
verb $persistent_conversational:history(limit, before_seq) rxd {
  if (typeof(limit) != "number") { limit = 50; }
  let cap = this.next_seq;
  if (typeof(before_seq) == "number") { cap = before_seq; }
  let tail_window = limit * 4;     // headroom for non-utterance frames
  let from = cap - tail_window;
  if (from < 0) { from = 0; }
  let utter_types = ["said", "said_as", "emoted", "posed", "quoted"];
  let out = [];
  for frame in this:replay(from, tail_window) {
    if (frame.seq >= cap) { break; }
    for obs in frame.observations {
      if (obs.type in utter_types) { out = out + [obs]; }
    }
  }
  // tail-take last `limit`
  if (length(out) > limit) { out = out[length(out) - limit + 1..length(out)]; }
  return out;
}
```

- `limit` (default 50): how many utterances to return.
- `before_seq` (optional): page back from this seq. Omitted means
  "tail of the log." Older history is fetched by passing the seq of
  the oldest entry from the previous response.
- The `tail_window = limit * 4` heuristic absorbs non-utterance
  frames (board edits, catalog updates, schema-plan applies, future
  internal-system events). If the window is too small, the result is
  short; the client retries with `before_seq` set to the oldest
  returned `seq` and accumulates. A future `:replay_tail(limit)`
  primitive on `$space` would remove the heuristic.

`:history()` itself is direct-callable (`rxd`): reading is not an
utterance and there is no benefit to logging "$X looked at history."

---

## PC8. Newcomer history-on-enter

A frequent UX want: when a user enters a persistent conversational
space, immediately show them the last N utterances.

For v1, clients that want post-enter backlog **call `:history()`
after `:enter` returns**. This is the right contract for feature
composition because features do not override parent-chain verbs. If
the consumer space already defines `:enter`, as pinboard does, that
space keeps ownership of its entry behavior.

A future space may explicitly call a feature hook from its own
`:enter`, or the DSL may grow a stable super-call/hook pattern. That
would be an ergonomic improvement, not a change to the persistence
model.

---

## PC9. Audience override and replay

`_audience_override` ([events.md §13](../semantics/events.md#13-schemas))
limits a broadcast to a specified audience, not the full subscriber
set. Two scenarios use it; only one is in scope here:

- **Direct verb emits with `_audience_override`.** Already works:
  `:history()` is direct-callable, runs locally, emits observations
  with `_audience_override: [actor]`, and the gateway broadcaster
  honors the override at fan-out time. A future auto-history hook
  could use this.
- **Replay rebroadcasts a sequenced applied frame.** Not in v1.
  The current `:replay()` primitive returns frames as **data**, not
  as broadcasts. A history-fetching client iterates the result and
  decides whether to render. The substrate does not re-broadcast
  historic observations; `_audience_override` on stored frame
  observations is informational only.

If a future feature adds "rebroadcast a recorded frame to a specific
audience," that primitive will need to define `_audience_override`
semantics for replayed frames. Out of scope for v1.

---

## PC10. Command planning and `:command`

The chat UI is a command UI to the current space. It is not a command
UI to a sidecar chat object. If the current space is `the_pinboard`,
then explicit speech such as `say hi` or `"hi"` becomes
`the_pinboard:say(...)`; object commands such as `drop note` resolve
in the pinboard context and dispatch to the pinboard's own verbs.

`$conversational:command_plan(text)` parses explicit command input (`say hi`
and `"hi"` -> `:say("hi")`, `/me waves` -> `:emote("waves")`, etc.) and
returns a plan. Bare unmatched text is not implicit speech; it plans through
the actor-owned `:huh` path and yields a private `I don't understand that.`
response. The planner MUST determine route from the target verb's
installed `direct_callable` metadata:

- `$conversational:say` plans as `route: "direct"`.
- `$persistent_conversational:say` plans as
  `route: "sequenced", space: this`.
- Consumer/object verbs also use their own `direct_callable`
  metadata. A non-chat command in the chat UI is still a command
  to the current space.

This route calculation belongs in the base planner, not in a
`$persistent_chatroom` override. The base planner already calls
`match_verb` for the catch-all path; recognized chat forms should
use the same metadata check.

Browser clients send free text as wire `op:"command"` with the active command
space and raw text. The server consumes the plan and dispatches:

- direct plans call the target verb directly and return `op:"result"`;
- sequenced plans call `plan.space:call({...plan})` and return `op:"applied"`.

The catalog-level `:command(text)` verb remains a compatibility command surface
for older direct callers. It consumes the same plan shape: direct plans execute
inline and sequenced plans return the applied/error frame from the resolved
command space. Browser clients still use wire `op:"command"` to avoid an extra
catalog call.

The SPA already implements this pattern for taskspace; persistent
conversation relies on the same route-aware client behavior.

---

## PC11. Trade-offs

| | `$conversational` | `$persistent_conversational` |
|---|---|---|
| User affordance | chat in current space | chat in current space |
| Per-utterance latency (warm) | ~50 ms | ~400-700 ms |
| Log size growth | none | one frame per public utterance |
| Newcomer history | empty | `:history()` returns the tail |
| Disconnect recovery | observations lost during gap | recoverable via `:history(before_seq)` from last seen |
| Storage cost | minimal | scales with public-utterance volume |
| Private tells | private, ephemeral | private, ephemeral |
| Suitable for | banter, casual chat, dub jam | meetings, support, forums, persistent workspaces |

The latency difference comes from the inbound/outbound RPC chain
sequenced calls take. A user in fast back-and-forth chat will feel
the persistent feature as "laggy" if used for casual chatter. A user
in a meeting room or board discussion will not notice 700 ms of
latency on each spoken sentence.

Both features coexist; the operator or catalog author picks per space
based on purpose.

---

## PC12. Storage growth and retention

Every persistent public utterance is one applied frame with its
observation payload. Rough size: ~500 bytes per "said," scaling
linearly. A busy space with 1,000 utterances/day grows ~500 KB/day,
~180 MB/year.

The substrate provides no automatic retention policy. Retention
strategies operators MAY adopt (none in v1):

- **Indefinite.** Acceptable for low-volume spaces.
- **Time-windowed.** A wizard verb drops log entries older than a
  threshold. Replay returns the truncated tail.
- **Snapshot-and-truncate.** Periodic summaries replace older
  entries.

The feature ships with no retention; operator policy applies. A
`:trim_history` mechanism is a follow-up.

---

## PC13. Migration and composition

Switching an existing chatroom instance from ephemeral to persistent
conversation may be represented as a convenience-class `chparent`:

```
chparent(the_lobby, "$persistent_chatroom")
```

or as feature composition on the existing space:

```
the_lobby:remove_feature($conversational)
the_lobby:add_feature($persistent_conversational)
```

The reverse operation swaps the feature back. The remove-before-add
ordering is required per PC4.1; attaching both leaves the consumer
with ephemeral semantics by feature-list order.

This is a **breaking change for clients that hardcode direct `:say`
POSTs.** After persistence is enabled, those POSTs raise
`E_DIRECT_DENIED`. Operators MUST do one of:

- Update every browser client to send wire `op:"command"` for text input, or
  update non-browser clients to use an equivalent server-side command executor
  rather than hardcoding direct `:say` calls.
- Coordinate the feature/class change with a client deploy that
  handles the new route.

Past utterances from the ephemeral feature remain absent from
`:history()`; they were never in the log. Post-migration utterances
appear. A reverse migration leaves past sequenced utterances in the
space log, but they are no longer exposed by the ephemeral feature.

For embedded applications, prefer instance composition. For example,
the demo pinboard may attach `$persistent_conversational` so chat is
inside the board, while the generic `$pinboard` class remains usable
without chat.

---

## PC14. Choosing the feature

A heuristic for catalog authors and operators:

- **Default to `$conversational`.** Direct `:say` is fast and
  matches casual-chat expectations. The bundled Living Room, Deck,
  Hot Tub, and ephemeral embedded chats can use this.
- **Use `$persistent_conversational` when at least one of these is
  true**:
  - The space hosts decisions, agreements, or commitments where
    "what was said" matters after the conversation ends.
  - Expected message volume is low enough that per-utterance latency
    is not a UX problem (rule of thumb: fewer than ~10 messages/minute
    by the same speaker).
  - Newcomers should be able to catch up on what happened before they
    arrived.
  - Auditability is a requirement (support, compliance, governance).
  - Chat should be durably co-ordered with space mutations.

Mixed worlds are normal. A Living Room may use `$conversational`; a
Conference Room may use `$persistent_conversational`; the demo
pinboard may choose either feature based on whether the transcript is
part of the demo's durable state.

---

## PC15. What's not in v1

- **Auto-replay-on-enter** (PC8). Clients call `:history()` after
  `:enter` for now.
- **Audience-scoped history** (PC6). Tells/say_to remain direct in
  v1 to keep history public-only. Per-caller filtered replay is a
  follow-up.
- **Tail-replay primitive** (PC7). `:history()` uses a tail heuristic
  over `:replay`; a `$space:replay_tail(limit)` would be cleaner and
  avoids the headroom multiplier.
- **Frame-timestamp accessor in verb bodies** (PC5). v1 verbs call
  `now()`; the gap to frame `ts` is ms-level at apply time and
  harmless until replay re-runs verbs (which v1 does not).
- **Retention / `:trim_history`** (PC12).
- **Encrypted persistent chat.** Ciphertext-in-log + per-recipient
  decryption is a separate identity story.
- **Edit / delete past utterances.** Records are immutable in v1;
  corrections are emitted as new utterances referencing the original
  by `seq`.
- **Cross-space transcripts.** Per-space replay is the only access
  pattern; "all my activity" requires a cross-host index.
- **Server-side full-text search of transcripts.** Index externally
  via backup tooling.
- **Rebroadcast historic frames.** `:replay()` returns data;
  re-emitting recorded observations as new broadcasts is out of
  scope (PC9).
