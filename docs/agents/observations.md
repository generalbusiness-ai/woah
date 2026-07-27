# Observations on Net MCP

Observations are structured `{type, ...}` maps describing live world events:
speech, room transitions, inventory changes, and catalog-specific updates. A
browser receives them over the Net WebSocket; an MCP agent pulls its own live
queue with `woo_wait`.

## Pulling observations

```
woo_wait(timeout_ms?: int, limit?: int)
```

The reply is `{observations, gap}` at `structuredContent.result`.
`timeout_ms` defaults to 1000 ms and is capped at 25 seconds; zero returns
immediately. `limit` defaults to 64 and is capped at the queue capacity of 256.
A bounded read leaves any remainder for the next call.

The queue is session-local, memory-resident, and at-most-once. It is fed by the
same presence-routed fanout as browser WebSockets. It does not survive gateway
eviction, and overflow drops the oldest entries.

## The `gap` flag

`gap` answers one question: can the gateway still prove your queue has been
continuous since your last drain?

- `gap: false` — it can. Everything fanned out to you since your last wait is
  in `observations`.
- `gap: true` — it cannot. The gateway restarted, your session state was
  evicted, or the bounded buffer overflowed. Observations may have been lost.

`gap` is a continuity claim, not a count: it never tells you *how many* events
were missed, because nothing durable recorded them. It is conservative — a
restart raises it whether or not anything was actually queued — and one-shot:
the reply that carries `gap: true` clears it.

On `gap: true`, re-orient with an authoritative read (`look`, `who`) rather
than assuming you heard everything. It is also worth re-listing tools: the same
event that lost your queue lost your descriptor baseline.

## Calls and peer events

`woo_call` returns the verb's value (or structured error), but Net does not
duplicate emitted observations into that call result. Pull peer and room
events separately through `woo_wait`. The gateway suppresses a submitter's own
committed fanout echo, so an agent does not see its own action twice.

After `notifications/tools/list_changed`, re-run standard `tools/list` (or
`woo_list_reachable_tools`): the actor's presence or containment context
changed and the callable projection may be different. This is a live
session-specific hint, not an observation in `woo_wait`; focus is not part of
the MCP context model.

## Common shapes

Catalog manifests define the exact event schemas. Common types include:

| Type | Meaning |
| --- | --- |
| `said` | Someone spoke; `text` is the rendered line. |
| `entered` / `left` | An actor arrived in or left a room. |
| `taken` / `dropped` | An inventory transition. |
| `looked` / `who` | Informational room responses. |
| `block_data` | A block's external data changed. |

Within one sequenced scope, frames may carry a scope and sequence number.
There is no global order across scopes. The current Net MCP adapter does not
provide the classic host's durable queue metadata, inline `applied` result,
or protocol-level replay helper; those remain explicit parity decisions under
[`net-cutover.md` §NC9](../../spec/operations/net-cutover.md#nc9-v2-stack-decommission).

## A simple agent loop

```
woo_call("the_chatroom", "say", ["hello"])
woo_wait(timeout_ms: 1000, limit: 50)
```

For a passive live observer, repeat waits with a timeout at or below 25
seconds. For a turn-based agent, use `timeout_ms: 0` after each action and keep
draining until the returned observation list is empty.

The normative protocol is
[`../../spec/protocol/mcp.md`](../../spec/protocol/mcp.md).
