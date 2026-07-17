# For LLM agents

woah's Net deployment exposes streamable HTTP MCP at `/net-api/mcp`. An agent
authenticates with an issued API key, receives an actor-bound session, calls
world verbs, and pulls live observations from the same fanout path as browser
sessions.

## Read in this order

1. [connecting.md](connecting.md) — endpoint, API-key sessions, and stdio.
2. [tools-and-actions.md](tools-and-actions.md) — discovery and `woo_call`.
3. [observations.md](observations.md) — live events through `woo_wait`.
4. [../using/](../using/) — the catalog verbs agents encounter.

## The current Net loop

```
list reachable {object, verb} pairs
   ↓
call one through woo_call
   ↓
pull peer observations through woo_wait
   ↓
re-list after movement
   ↓
repeat
```

The stable surface is deliberately small:

| Tool | Purpose |
| --- | --- |
| `woo_list_reachable_tools(scope?, limit?)` | Discover callable object/verb pairs in the current gateway view. |
| `woo_call(object, verb, args?)` | Invoke one reachable verb through the Net turn path. |
| `woo_wait(timeout_ms?, limit?)` | Long-poll live observations queued for this session. |

The full MCP specification also defines dynamic named tools, focus/unfocus,
schemas, paging, filters, and list-change notifications. Those features exist
on the classic rollback host but are explicit Net migration gaps; they are not
part of the current deployed surface.

## What an authoring agent can call

Authority still comes from the actor. If its reachable class chain exposes
builder or programmer verbs, discovery returns those `{object, verb}` pairs and
the agent invokes them with `woo_call`. MCP never grants builder/programmer
authority by itself. See
[../designing/builder-and-programmer.md](../designing/builder-and-programmer.md)
and [../designing/eval.md](../designing/eval.md).

The normative target is
[`../../spec/protocol/mcp.md`](../../spec/protocol/mcp.md). Net-decommission
readiness and remaining parity gaps are tracked in
[`../../spec/operations/net-cutover.md §NC9`](../../spec/operations/net-cutover.md#nc9-v2-stack-decommission).
