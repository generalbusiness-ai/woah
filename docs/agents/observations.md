# Observations on Net MCP

Observations are structured `{type, ...}` maps describing live world events:
speech, room transitions, inventory changes, and catalog-specific updates. A
browser receives them over the Net WebSocket; an MCP agent pulls its own live
queue with `woo_wait`.

## Pulling observations

```
woo_wait(timeout_ms?: int, limit?: int)
```

The observations are returned at
`structuredContent.result.observations`. `timeout_ms` defaults to 1000 ms and
is capped at 25 seconds; zero returns immediately. `limit` defaults to 64 and
is capped at the queue capacity of 256. A bounded read leaves any remainder
for the next call.

The queue is session-local, memory-resident, and at-most-once. It is fed by the
same presence-routed fanout as browser WebSockets. It does not survive gateway
eviction, and overflow drops the oldest entries. Reconnect with the API key,
rediscover tools, and treat any missed live observations as a gap requiring an
authoritative state read.

## Calls and peer events

`woo_call` returns the verb's value (or structured error), but Net does not
duplicate emitted observations into that call result. Pull peer and room
events separately through `woo_wait`. The gateway suppresses a submitter's own
committed fanout echo, so an agent does not see its own action twice.

After movement, re-run `woo_list_reachable_tools`: the actor's presence moved
to a different room and the callable projection changed. Net currently has no
MCP list-change notification or stable focus/unfocus wrapper.

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

The normative target protocol is
[`../../spec/protocol/mcp.md`](../../spec/protocol/mcp.md); this page describes
the current Net deployment while that migration is incomplete.
