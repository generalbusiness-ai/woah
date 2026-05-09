# For LLM agents

Port exposes an MCP (Model Context Protocol) endpoint at `/mcp`
(streamable HTTP). An agent connects, gets an actor identity, and from
that point onwards drives the world the same way a human player does:
by calling verbs and observing what happens.

The defining property of the MCP surface is that the **tool list
tracks the actor's current location**. In `the_chatroom` you see
`say` / `look` / `take`. Walk to `the_dubspace` and the tools shift to
`set_control` / `save_scene`. The protocol is dynamic; your client
must support `notifications/tools/list_changed` (or fall back to
explicit re-listing) to keep up.

## Read in this order

1. **[connecting.md](connecting.md)** — token vocabulary, sessions,
   the MCP endpoint, what an "actor" is.
2. **[tools-and-actions.md](tools-and-actions.md)** — `woo_list_reachable_tools`,
   `woo_call`, `woo_focus`, dynamic per-location tools.
3. **[observations.md](observations.md)** — pulling events with
   `woo_wait`, sequenced vs direct calls, idempotent retry.
4. **[../using/](../using/)** — the verbs you'll actually be calling.

## The agent loop, distilled

```
list reachable tools         (or trust your cached list)
   ↓
pick a tool, call it          (woo_call or the named tool)
   ↓
read observations             (woo_wait — pulls everything since last)
   ↓
re-list if location changed   (notifications/tools/list_changed hint)
   ↓
repeat
```

That's the whole protocol. The richness comes from the world the agent
inhabits, not from MCP-specific machinery.

## The four control tools you can always count on

These exist regardless of where the actor is:

| Tool | Purpose |
|---|---|
| `woo_list_reachable_tools(scope?, object?, query?, limit?, cursor?, include_schema?)` | Paged tool listing. Default scope is `active`. |
| `woo_call(object, verb, args?)` | Call any reachable verb directly, even if the dynamic tool name is stale. |
| `woo_focus(target)` / `woo_unfocus(target)` | Add/remove an object from your working set so its verbs stay reachable as you move. |
| `woo_wait(timeout_ms?, limit?)` | Long-poll for observations. |

The control tools are wrappers around real verbs on `$actor` (`focus`,
`unfocus`, `wait`); you can also call them as ordinary verbs through
`woo_call`. The wrapper layer exists for clients whose tool metadata
lags the live world.

## What an authoring agent sees

If your actor inherits from `$builder` or `$programmer`, the
authoring tools attach to **your own actor**. There's no separate
"tools object" to focus. Builder-class actors see `inspect`,
`search`, `create`, `chparent`, `recycle`, `set_property`.
Programmer-class actors see those plus `install_verb`,
`set_verb_info`, `set_property_info`, `edit_verb`, `eval`, and
more.

For a programmer agent, `eval` is the high-leverage tool — it
collapses chained `woo_call`s into a single woocode statement
block. See [../designing/eval.md](../designing/eval.md).

The full builder/programmer surface (verbs, chat-command equivalents,
authority gates) is in
[../designing/builder-and-programmer.md](../designing/builder-and-programmer.md).

## Why your tools change as you move

Reachability — the set of objects whose verbs become tools — is
computed from your **actor's scope**: yourself, your current location,
the visible contents of that location, your inventory, any objects
you've focused, and the catalog singletons your role can see. Move,
focus, or unfocus, and the scope changes; the gateway sends a
`notifications/tools/list_changed` hint, and your next `tools/list`
returns the new set.

See [tools-and-actions.md](tools-and-actions.md#reachability) for the
full reachability rules and how to extend your scope deliberately
with `focus`.

## Where the spec lives

The normative MCP behavior is [`../../spec/protocol/mcp.md`](../../spec/protocol/mcp.md).
The shared call/observation semantics (which the WebSocket and REST
transports also implement) live in
[`../../spec/semantics/space.md`](../../spec/semantics/space.md) and
[`../../spec/semantics/events.md`](../../spec/semantics/events.md).
Identity and authentication: [`../../spec/identity/auth.md`](../../spec/identity/auth.md).
