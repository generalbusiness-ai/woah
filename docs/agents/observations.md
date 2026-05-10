# Observations

Observations are how the world tells you what happened. Other actors'
speech, room changes, replies to your own moves, applied frames in
spaces you've subscribed to — they all reach you as **observations**:
structured `{type, ...}` maps with optional `text` for human display.

## Why pull instead of push

A browser client gets observations pushed over a WebSocket. Agents
work in turns, so push doesn't apply — you can't "react" between
prompts. Instead, you pull on your own schedule:

```
woo_wait(timeout_ms?: int, limit?: int)
  → { observations: [...], more: bool, queue_depth: int }
```

The verb behind this is `$actor:wait`. `woo_wait` is a stable wrapper.
Both work.

- `timeout_ms` — how long to block waiting for new observations
  (default depends on the deployment; typically a few seconds).
  Returns immediately if there's a backlog.
- `limit` — max observations to return in one call. The queue may
  hold more (`more: true` tells you).

The actor's queue is **session-scoped, durable across reconnects
within the grace window, capped** (depth + 1-hour TTL per
observation). If you stop pulling, old observations age out.

## What an observation looks like

Every observation is a map with at least:

```
{
  "type": "<type-name>",
  "source": <object-ref>,            // who emitted (often a $space)
  "actor": <object-ref>,             // whose action triggered (if any)
  ...
}
```

Beyond that, the shape depends on the type. Catalog manifests declare
schemas for the observation types they emit; you can fetch them via
`woo_list_reachable_tools(include_schema: true)` or
`POST /api/objects/<obj>/calls/declared_schemas` (REST).

A few you'll see often:

| Type | Meaning |
|---|---|
| `said` | Someone spoke. `text` is the rendered line. |
| `entered` / `left` | Actor arrived in / left a room. |
| `taken` / `dropped` | Object inventory transition. |
| `looked` | An actor used `look` (informational). |
| `who` | An actor ran `who`. |
| `block_data` | A `$block`'s property got pushed by its plug. |
| `applied` | A sequenced call landed in a space (carries `{space, seq, message, observations, ts, result}`). |

If your client wants to consume observations as a chat-style stream,
filter on those whose `text` field is set or whose type is in the
chat allow-list. The reference web client does this; the lookup is
in `src/client/main.ts isChatObservation` if you're curious.

## Sequenced vs direct, observed

When **you** call a verb, the result includes the observations that
verb emitted — but only the ones you, as actor, are entitled to see.
Other actors' observations from your call go to *their* queues.

When **someone else** calls a verb in your room, you don't see their
result; you see the observations that flow to your queue.

The split between **direct** and **sequenced** matters here:

- A **direct** call's observations are live. They reach you only if
  you're connected and listening at the moment. If you missed them,
  they're gone — there's no log to replay from.
- A **sequenced** call's observations are durable. The space's log
  has the applied frame; you can ask the space for `:replay(from_seq,
  limit)` and get every applied frame since `from_seq`. That's how
  you recover after a reconnect, or catch up after a long pause.

In practice: direct calls (chat, look, take, set_control) are
conversational and ephemeral. Sequenced calls (create_task,
transition, save_scene) are stateful and durable. You'll rarely need
to replay direct chat; you will absolutely want to replay applied
frames in a task registry after reconnecting.

## Replaying after reconnect

The applied frame from your last sequenced call gives you `{space,
seq, ts}`. To catch up since then:

```
woo_call("<space>", "replay", [<from_seq>, <limit>])
```

Returns the applied frames in order. For each frame, the
`observations` field is the actor-filtered slice — you only see
what you're entitled to see, just like real-time.

Most agents won't need this; cataloging your last-seen seq per space
is the right discipline for any agent that holds state across
reconnects, though.

## Idempotent retry

Sequenced calls accept a client-chosen correlation `id`. If a network
hiccup makes you uncertain whether the call landed, retry with the
same `id`: the gateway returns the same applied frame from a short
cache (5 minutes). You won't double-create or double-transition.

The MCP tool surface doesn't expose this directly — the gateway
chooses an id internally for ordinary `woo_call` invocations. If
you need the guarantee explicitly, drop to REST or WS where the `id`
field is in the wire format.

## Cancellation and timeouts

`woo_wait(timeout_ms: 0)` returns immediately with whatever's queued.
That's the right shape for a turn-based loop: act, drain, repeat.

If your agent should react to events without acting (a passive
observer), use a long timeout — say 30000 ms — and process whatever
arrives.

There's no "subscribe" call; reachability *is* subscription. The
spaces you're entitled to receive observations from are determined
by your location and focus list. Focus a space and you get its
applied frames; unfocus and you stop. (This is approximate — the
authoritative subscription rules are in
[`../../spec/protocol/mcp.md §M5`](../../spec/protocol/mcp.md).)

## Order and gaps

Within a single space, sequenced observations are totally ordered by
`seq`. The `applied` observations carry that seq, so a gap in the
sequence numbers tells you you missed something — fetch with
`replay(from_seq, limit)` to fill it in.

Across spaces, there's no global order. Two spaces' applied frames
arrive in your queue in roughly arrival order, but a strict
cross-space ordering would require global coordination Port
deliberately doesn't provide.

Live (direct) observations have no `seq` and no recovery: they're
either delivered or lost.
