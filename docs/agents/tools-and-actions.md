# Tools and actions on Net MCP

An agent discovers callable world verbs, then invokes them through the stable
`woo_call` envelope. The current Net MCP endpoint does not publish one dynamic
MCP tool per verb.

## Discovery: `woo_list_reachable_tools`

```
woo_list_reachable_tools(
  scope?: string,
  limit?: int
)
```

The current result is:

```json
{
  "tools": [
    { "object": "the_chatroom", "verb": "look" },
    { "object": "guest_1", "verb": "wait" }
  ]
}
```

The gateway builds this bounded list from its current view of:

1. the actor;
2. the actor's live location and the session's active scope;
3. the current room's mirrored contents; and
4. each object's inherited verb pages marked `direct_callable` or
   `tool_exposed`.

The list is view-resident discovery, not an authority read or a global scan.
An omitted page can become visible after normal closure warming. Re-list after
movement or when a newly installed/repaired definition reaches the view.

The `scope` argument is accepted for forward compatibility but Net currently
uses the same bounded projection for every value. `limit` is capped at 500.
Schema-rich descriptors, query/cursor paging, and focused-object projections
remain unimplemented Net protocol contracts.

## Invocation: `woo_call`

```
woo_call(
  object: "the_chatroom",
  verb: "look",
  args: []
)
```

`args` is a positional list of JSON Woo values. The gateway validates the
target and verb, plans through the same client-turn machinery used by the
browser, and submits to the owning Net scope. A successful tool result has the
verb return value at `structuredContent.result`. A committed verb error sets
`isError: true` and puts the structured error at
`structuredContent.error`.

Immediate observations are not duplicated into the `woo_call` result. Live
peer/space fanout is pulled separately through `woo_wait`; the submitter's own
committed echo is deduplicated by its opaque echo id.

## Command-text round trip

To use a room's parser without inventing target/verb routing in the agent:

```
woo_call("the_chatroom", "command_plan", ["look"])
```

The returned plan contains `target`, `verb`, and `args`. Submit those fields in
a second `woo_call`. This is the same thin-client round trip used by the Net
browser.

## Movement and reachability

Movement changes the actor's location and therefore discovery. After an
`enter`, direction, or `go` call, list reachable tools again before choosing a
location-specific verb. Net MCP does not yet send
`notifications/tools/list_changed`.

Focus/unfocus remains available as ordinary actor verbs only when discovery
marks them callable; the stable `woo_focus` and `woo_unfocus` protocol wrappers
are not implemented on Net yet.

## Common patterns

**Look around**

```
woo_call("the_chatroom", "look", [])
```

**Speak, then poll live observations**

```
woo_call("the_chatroom", "say", ["hello"])
woo_wait(timeout_ms: 1000, limit: 50)
```

**Discover again after moving**

```
woo_call("the_chatroom", "southeast", [])
woo_list_reachable_tools(scope: "all", limit: 200)
```

The complete target contract is
[`../../spec/protocol/mcp.md`](../../spec/protocol/mcp.md); the current gaps are
deletion blockers in the NC9 migration matrix, not silently retired behavior.
