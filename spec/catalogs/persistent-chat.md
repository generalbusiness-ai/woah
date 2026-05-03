---
date: 2026-05-03
status: draft
---

# Persistent chat

> Part of the [woo specification](../../SPEC.md). Layer: **catalogs**.
> A class-design spec for `$persistent_chatroom`, a bundled catalog
> class. The substrate primitives this depends on (sequenced calls,
> applied frames, replay, audience override) are normative in
> [semantics/space.md](../semantics/space.md) and
> [semantics/sequenced-log.md](../semantics/sequenced-log.md).

How a `$space`-descended class records every public utterance in its
sequenced log, so newcomers can see history, transcripts can be
exported, and the room is the durable source of truth for "what was
said here." The worked example is a chatroom (`$persistent_chatroom`),
which is intended to ship as a normative class in the bundled `chat`
catalog.

---

## PC1. Motivation

Today's `$chatroom` (catalog `chat`) is *ephemeral*. `:say`,
`:emote`, and similar are direct-callable: they emit observations to
current subscribers and are not appended to the space's sequenced log.
A new actor entering sees nothing of what was said before; an actor
whose WebSocket dropped briefly misses anything emitted during the
gap.

That's the right default for casual rooms — direct `:say` is fast
(~50 ms) and avoids the per-utterance cost of sequencing. But several
real cases need the opposite trade-off:

- A board meeting or recurring sync where decisions matter.
- A support channel where transcripts are part of the audit trail.
- A long-running async discussion (chat-as-forum) where activity is
  the room's primary state.
- A code-review or pairing room where messages reference specific
  verb versions and need to be co-archived with the work.

For these, the room itself should hold the record, not the WebSocket
fan-out at any given moment.

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
  observations. More expensive (~400–700 ms warm), durable.

The runtime selects the path from a verb's metadata, specifically the
`direct_callable: bool` field set at install time. (The `d` character
in a perm string is one signal an authoring tool may use to ask for
direct-callable, but the normative truth is the boolean field on the
installed verb. A spec or migration that asserts "make this verb
sequenced" should set `direct_callable: false` explicitly rather than
rely on perms-string parsing.) When `direct_callable` is false, every
caller must reach the verb through the space's `:call`; attempting a
direct call raises `E_DIRECT_DENIED`.

This gives the persistent-chatroom design its mechanism: take the
public utterance verbs from `$conversational` and re-define them on
a subclass with `direct_callable: false`. The substrate handles log
append, applied-frame broadcast, and replay automatically.

---

## PC3. Class shape

```
$persistent_chatroom < $chatroom
```

No new properties. No new substrate state. The class exists to
override the public utterance verbs' direct-callable flag.

**Verbs that flip to sequenced** (set `direct_callable: false` on the
subclass override):

| Verb | Observation type | Why sequenced |
|---|---|---|
| `:say(text)` | `said` | Public utterance; the canonical "speech in the room." |
| `:emote(text)` | `emoted` | Public action; "$X waves" belongs in the transcript. |
| `:pose(text)` | `posed` | Public stylized utterance. |
| `:quote(text)` | `quoted` | Public quotation; deliberate citation belongs in record. |
| `:say_as(style, text)` | `said_as` | Public styled speech (no recipient). |

**Verbs that stay direct** (private speech, navigation, view; see
PC5 for the privacy reasoning on tell/say_to):

| Verb | Why stays direct |
|---|---|
| `:tell(recipient, text)` | Private directed message; not part of public history. |
| `:say_to(recipient, text)` | Same; recipient-directed speech. |
| `:look`, `:who` | Read-only view. |
| `:enter`, `:leave` | Navigation; presence changes happen via `set_presence` side-effect. |
| `:viewport`, `:command_plan`, `:command` | UI/planning surface. |

Verb bodies for the sequenced overrides are otherwise unchanged from
`$conversational`'s — same observation shape, same permission gates,
same return values.

---

## PC4. Timestamps inside sequenced verbs

The current `$conversational` verb bodies set `ts: now()` on the
emitted observation. For sequenced verbs, the canonical "when this
happened" is the **applied frame's timestamp** (carried alongside
each frame in the log per [sequenced-log.md
§SL3](../semantics/sequenced-log.md#sl3-message-shape)), not the
verb body's `now()` call.

Two reasons to prefer the frame timestamp:

- **Replay parity.** `:replay()` returns the captured applied frames
  directly (it does not re-execute the verb), so the frame timestamp
  is what every reader sees. Verb-body `now()` is captured at apply
  time and stored alongside the frame, so it agrees with the frame
  timestamp in v1 — but a future change that re-runs verbs against
  recorded inputs would diverge.
- **Single source of truth.** Frame timestamp is the operator's
  authority for ordering. A verb that disagrees with its frame's
  timestamp is a bug surface waiting to happen.

The persistent-chatroom override SHOULD therefore reference the
frame timestamp (available to verb bodies as the applied frame's
`ts`, surfaced via the call context — exact accessor name TBD by
the DSL/runtime; for v1 the verb body MAY continue to call `now()`
and accept the small risk that the value matches at apply time).

This is a class-level cleanup, not a substrate change.

---

## PC5. Directed messages stay private

`:tell(recipient, text)` and `:say_to(recipient, text)` deliver
**directed** observations: in `$conversational` today they emit
`{type: "told", from, to, text}` / `{type: "said_to", actor, to,
text}` to the current room broadcast, with the runtime fanning out
to subscribers. In an ephemeral room these messages reach the
sender, the recipient, and any present subscribers; observers in
the same room can see them happen because the broadcast isn't
audience-restricted.

A persistent chatroom that sequenced these verbs would write
private content into the public log. Once in the log,
`:history()` would return them to any caller — a real privacy
leak.

The chosen v1 policy: **persistent chatrooms are public-only.**
`:tell` and `:say_to` stay direct (ephemeral, not logged).
Operators and class authors who need durable directed messages
should use a different durable channel (mail catalog when it
exists, or a per-actor log pattern), not the room's transcript.

A future audience-aware history implementation could relax this
by filtering `:history()` per caller — only returning observations
the caller was a member of the audience for at the time of
emission. That requires every applied frame's observations to
carry a verifiable audience list and the history filter to enforce
it. Not in v1; deferred to a follow-up that adds an explicit
"audience-scoped replay" primitive on `$space`.

---

## PC6. History via `$space:replay`

`$space:replay(from_seq, limit)` is already substrate ([space.md
§S5](../semantics/space.md#s5-replay)): it returns sequenced applied
frames including the observations each frame emitted. A persistent
chatroom needs no new storage to expose chat history — just a verb
that reads a window of replay and filters to utterance types.

**`:history()` returns the most recent N utterances by default.**
`:replay(0, N)` reads from the *start* of the log; for "show me the
last 50" the verb must compute the tail window from `next_seq`:

```woo
verb $persistent_chatroom:history(limit, before_seq) rxd {
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
  "tail of the log." Older history is fetched by passing the seq
  of the oldest entry from the previous response.
- The `tail_window = limit * 4` heuristic absorbs non-utterance
  frames (catalog updates, schema-plan applies, future
  internal-system events). If the window is too small, the result
  is short; the client retries with `before_seq` set to the oldest
  returned `seq` and accumulates. A future `:replay_tail(limit)`
  primitive on `$space` would remove the heuristic.

`:history()` itself is direct-callable (`rxd`) — reading isn't an
utterance and there's no benefit to logging "$X looked at history."

---

## PC7. Newcomer history-on-enter (deferred)

A frequent UX want: when a user enters the room, immediately show
them the last N utterances. The natural pattern is to override
`:enter` so it sends a private replay to just the joining actor
after delegating to the parent `:enter`.

**This pattern is deferred** because:

- The Woo DSL's `pass(args)` super-call (LambdaMOO-style) is not
  yet documented as supported, so a clean "delegate to
  $chatroom:enter, then add my hook" override isn't expressible.
  Reimplementing `$chatroom:enter` verbatim on the subclass works
  but ties the persistent class to the parent's exact body.
- The room's `:enter` signature in `$conversational` doesn't
  obviously take a `who` arg in current source; the surface needs
  reconciliation.
- `_audience_override` semantics for replayed observations need
  PC8 nailed down first.

Pragmatic v1: clients that want post-enter backlog **call
`:history()` after `:enter` returns**. Two round-trips, no
substrate or DSL changes. When DSL super-call lands and the
`:enter` signature stabilizes, the auto-replay version becomes a
single-RPC ergonomic improvement; until then the explicit-call
pattern is the contract.

---

## PC8. Audience override and replay

`_audience_override` ([events.md §13](../semantics/events.md#13-schemas))
limits a broadcast to a specified audience, not the full subscriber
set. Two scenarios use it; only one is in scope here:

- **Direct verb emits with `_audience_override`.** Already works:
  `:history()` is direct-callable, runs locally, emits observations
  with `_audience_override: [actor]`, the gateway broadcaster
  honours the override at fan-out time. Used by the deferred PC7
  flow.
- **Replay rebroadcasts a sequenced applied frame.** Not in v1.
  The current `:replay()` primitive returns frames as **data**, not
  as broadcasts. A history-fetching client iterates the result and
  decides whether to render. The substrate does not re-broadcast
  historic observations; `_audience_override` on stored frame
  observations is informational only.

If a future feature adds "rebroadcast a recorded frame to a
specific audience," that primitive will need to define
`_audience_override` semantics for replayed frames. Out of scope
for `$persistent_chatroom` v1.

---

## PC9. Command planning and `:command`

`$conversational:command_plan(text)` parses input ("hi" → `:say("hi")`,
"/me waves" → `:emote("waves")`, etc.) and returns a plan with
`route: "direct"` for utterance verbs because today they are
direct-callable.

A `$persistent_chatroom` whose `:say` is sequenced needs the planner
to return `route: "sequenced"` instead, otherwise clients will try
to direct-call and hit `E_DIRECT_DENIED`.

Two ways to fix it:

1. **Override `:command_plan` on `$persistent_chatroom`.** Re-emit
   each utterance plan with `route: "sequenced", space: this`.
   Class-local, doesn't touch `$conversational`. Verbose if many
   plans need adjusting.
2. **Make the base `$conversational:command_plan` consult the
   verb's `direct_callable` flag at plan time.** Look up the
   target verb on `match_verb`, set route from that flag.
   Generalizes; benefits any future class that flips
   direct-callability on inherited verbs.

Option 2 is preferred. The base planner already calls `match_verb`
for unrecognised verbs (the catch-all path); extending it to
respect `direct_callable` for the recognised ones is a small,
self-contained change in `chat`. `$persistent_chatroom` then needs
no `:command_plan` override at all.

`:command(text)` (the executor) consumes the plan and dispatches.
Today it dispatches `route: "direct"` plans inline and **returns**
non-direct plans without executing — so a client that hits a
sequenced plan must either:

- Call `the_room:call({...plan})` itself, OR
- Expect `:command` to do the dispatch.

The cleaner contract is that **clients consume the plan and
dispatch**. This matches taskspace's existing client behaviour and
keeps `:command` from needing two execution paths. The SPA already
implements this pattern for taskspace; the persistent-chat work
just relies on the same path. No `:command` override on
`$persistent_chatroom` needed.

---

## PC10. Trade-offs

| | `$chatroom` (direct) | `$persistent_chatroom` (sequenced) |
|---|---|---|
| Per-utterance latency (warm) | ~50 ms | ~400–700 ms |
| Log size growth | none | one frame per public utterance |
| Newcomer history | empty | `:history()` returns the tail |
| Disconnect recovery | observations lost during gap | recoverable via `:history(before_seq)` from last seen |
| Storage cost | minimal | scales with public-utterance volume |
| Private tells | private, ephemeral (same as chat) | **still** private, ephemeral (PC5) |
| Suitable for | banter, casual chat, dub jam | meetings, support, forums |

The latency difference comes from the inbound/outbound RPC chain
sequenced calls take. A user in fast back-and-forth chat will feel
the room as "laggy" if it's persistent. A user in a meeting room
will not notice 700 ms of latency on each spoken sentence.

Both classes coexist; the operator picks per-room based on purpose.

---

## PC11. Storage growth and retention

Every public utterance is one applied frame with its observation
payload. Rough size: ~500 bytes per "said," scaling linearly. A
busy room with 1,000 utterances/day grows ~500 KB/day, ~180 MB/year.

The substrate provides no automatic retention policy. Retention
strategies operators MAY adopt (none in v1):

- **Indefinite.** Acceptable for low-volume rooms.
- **Time-windowed.** A wizard verb drops log entries older than a
  threshold. Replay returns the truncated tail.
- **Snapshot-and-truncate.** Periodic summaries replace older
  entries.

The class ships with no retention; operator policy applies. A
`:trim_history` mechanism is a follow-up.

---

## PC12. Migration of existing rooms

Switching an existing `$chatroom` instance to
`$persistent_chatroom` is a `chparent`:

```
chparent(the_lobby, "$persistent_chatroom")
```

This is a **breaking change for clients that hardcode direct
`:say` POSTs.** After the chparent, those POSTs raise
`E_DIRECT_DENIED`. Operators MUST do one of:

- Update every client to consume `:command_plan`'s plan and
  dispatch through `:call` for sequenced plans (the recommended
  pattern under PC9 option 2).
- Coordinate the chparent with a client deploy that handles the
  new route.

Past utterances in the original `$chatroom` instance remain
absent from `:history()` — they were never in the log; only
post-chparent utterances appear. A reverse migration
(persistent → ephemeral) `chparent`s back; past sequenced
utterances stay in the log but become inaccessible via the
class's `:history()`.

The forward migration should pair with a deploy-coordinated
client update; informal "flip the parent and see" runs into the
direct-denied storm.

---

## PC13. Choosing this vs `$chatroom`

A heuristic for catalog authors and operators:

- **Default to `$chatroom`.** Direct `:say` is fast and matches
  the casual-room expectation. The bundled Living Room, Deck,
  and Hot Tub are `$chatroom`.
- **Use `$persistent_chatroom` when at least one of these is true**:
  - The room hosts decisions, agreements, or commitments where
    "what was said" matters after the conversation ends.
  - Expected message volume is low enough that per-utterance
    latency isn't a UX problem (rule of thumb: fewer than ~10
    messages/minute by the same speaker).
  - Newcomers should be able to catch up on what happened before
    they arrived.
  - Auditability is a requirement (support, compliance,
    governance).

Mixed worlds are normal. A Living Room (`$chatroom`) and a
Conference Room (`$persistent_chatroom`) coexist; an actor moves
between them and sees the appropriate latency/persistence trade
in each.

---

## PC14. What's not in v1

- **Auto-replay-on-enter** (PC7). Deferred until DSL super-call
  and the `:enter` signature stabilise. Clients call `:history()`
  after `:enter` for now.
- **Audience-scoped history** (PC5). Tells/say_to remain direct
  in v1 to keep history public-only. Per-caller filtered replay
  is a follow-up.
- **Tail-replay primitive** (PC6). `:history()` uses a tail
  heuristic over `:replay`; a `$space:replay_tail(limit)` would
  be cleaner and avoids the headroom multiplier.
- **Frame-timestamp accessor in verb bodies** (PC4). v1 verbs
  call `now()`; the gap to frame `ts` is ms-level at apply time
  and harmless until replay re-runs verbs (which v1 does not).
- **Retention / `:trim_history`** (PC11).
- **Encrypted persistent chat.** Ciphertext-in-log + per-recipient
  decryption is a separate identity story.
- **Edit / delete past utterances.** Records are immutable in v1;
  corrections are emitted as new utterances referencing the
  original by `seq`.
- **Cross-room transcripts.** Per-room replay is the only access
  pattern; "all my activity" requires a cross-host index.
- **Server-side full-text search of transcripts.** Index
  externally via backup tooling.
- **Rebroadcast historic frames.** `:replay()` returns data;
  re-emitting recorded observations as new broadcasts is out of
  scope (PC8).
