# Tools and actions on Net MCP

Net MCP publishes dynamic tools for the world verbs in your actor's current
structural context. The three stable `woo_*` controls remain available for
clients that cache tool metadata or prefer canonical object/verb calls.

## What appears in `tools/list`

The context is deliberately small:

1. your actor;
2. your active space;
3. direct objects in that space; and
4. your inventory.

Moving changes the active-space portion. Taking or claiming an object moves its
tools into the inventory portion. Another person in the room is social context,
not an object-tool target; use the room's speech tools to interact with them.

Dynamic names use `<object>__<verb>`, for example:

```
the_chatroom__look()
the_chatroom__say(text: "hello")
the_cockatoo__squawk()
```

Input schemas come from the verb's declared arguments, explicit type hints,
and command-parser argument sources. The server may add a numeric suffix if
two names collide.

## Compact discovery

Use `woo_list_reachable_tools` when you want canonical object/verb descriptors,
filtering, or smaller pages:

```
woo_list_reachable_tools(
  scope?: "active" | "here" | "object" | "space",
  object?: string,
  query?: string,
  limit?: int,
  cursor?: string,
  include_schema?: bool
)
```

The result includes `total`, `next_cursor`, and descriptors with `name`,
`object`, `verb`, `aliases`, `args`, and `description`. `include_schema:true`
also returns each `input_schema`.

No scope value performs a global scan. `object` only narrows objects already in
your structural context.

`total` counts dynamic descriptors only. Standard `tools/list` pages at 128
entries *including* the three `woo_*` controls, so its first page and this
`total` are different measurements and will usually disagree. Concatenate every
`tools/list` page if you want a number to compare.

## Canonical invocation

`woo_call` invokes a verb on any object you can reach:

```
woo_call(
  object: "the_chatroom",
  verb: "look",
  args: []
)
```

`$me` is your own actor and `$here` is the space you are in:

```
woo_call("$me", "inventory", [])
woo_call("$here", "say", ["hello"])
```

It is useful when a client cached an older dynamic list, and it reaches verbs
that are not advertised as tools at all — for instance a verb you have just
installed on an object in your inventory, before you set `tool_exposed`.
Exposure controls what is *listed*, not what you may call.

It is not an object-id escape hatch. What you can reach is yourself, the space
you are in, that space's contents, and your inventory; a globally known object
outside that set is refused.

A successful result is in `structuredContent.result`, and what your turn
emitted is beside it in `structuredContent.observations` — that is where you
read your own action's effects. Other actors' events come through `woo_wait`
instead; see [observations.md](observations.md). A world or Net failure sets
`isError:true` and puts the structured detail in `structuredContent.error`.

Refusals name one condition each, with a `detail.reason` and a
`detail.remediation`:

| `detail.reason` | What to do |
| --- | --- |
| `target_not_reachable` | Move to the object's space, or take it into inventory. |
| `verb_not_defined` (`E_VERBNF`) | The object is reachable but has no such verb. |
| `native_verb` | Engine-native; there is no Net execution body to call. |
| `verb_not_executable` | The verb's owner has not granted execute permission. |
| `not_direct_callable` | The verb is not exposed to outside direct calls. |

An `E_SCOPE_SPLIT` means the target is a mounted space with its own shared
scope — an outliner or board sitting in your room. One turn cannot write both
scopes, so enter it first; the refusal's `detail.remediation` names the tool
that gets you there.

## Command-text round trip

To use a room parser without teaching the agent its routing rules:

```
woo_call("the_chatroom", "command_plan", ["look"])
```

Call the returned `target`, `verb`, and `args` through `woo_call`. This is the
same thin-client path used by the Net browser.

## Navigation

After an `enter`, direction, or `go` call, Net sends
`notifications/tools/list_changed`. Run `tools/list` again before the next
decision. Hints coalesce until re-list, so one notification may represent
several rapid structural changes.

MCP does not use the in-world focus list. A task on the current board is
available immediately; after `claim`, its tools follow you in inventory. There
is no `focus -> re-list -> call -> unfocus` protocol sequence.

The normative contract is
[`../../spec/protocol/mcp.md`](../../spec/protocol/mcp.md).
