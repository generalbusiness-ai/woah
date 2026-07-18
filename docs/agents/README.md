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

## The Net loop

```
list dynamic tools
   ↓
call one through woo_call
   ↓
pull peer observations through woo_wait
   ↓
re-list on tools/list_changed
   ↓
repeat
```

Dynamic object tools are the primary surface. Three stable controls support
compact discovery, stale-metadata recovery, and observation polling:

| Tool | Purpose |
| --- | --- |
| `woo_list_reachable_tools(scope?, object?, query?, limit?, cursor?, include_schema?)` | Page and filter canonical descriptors in structural context. |
| `woo_call(object, verb, args?)` | Invoke one reachable verb through the Net turn path. |
| `woo_wait(timeout_ms?, limit?)` | Long-poll live observations queued for this session. |

Net publishes schema-backed dynamic named tools. It deliberately does not use
MCP focus/unfocus wrappers. It advertises `listChanged:true` and sends the
standard session-specific notification after navigation or containment changes;
re-list when the notification arrives.

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
