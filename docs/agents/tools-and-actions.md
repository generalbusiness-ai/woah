# Tools and actions

An agent acts by calling **tools**. A tool is just a verb on some
object, projected through MCP. Discovery and invocation are the two
operations you'll perform constantly.

## Discovery: `woo_list_reachable_tools`

```
woo_list_reachable_tools(
  scope?: "active" | "here" | "focus" | "object" | "space" | "all",
  object?: <object-ref>,
  query?: <substring-filter>,
  limit?: <int>,
  cursor?: <string>,
  include_schema?: <bool>
)
```

Returns `{ scope, object, query, limit, cursor, next_cursor, total, tools }`.

| Scope | What you see |
|---|---|
| `active` (default) | You + current location + inventory + other live locations + focus list. Bounded. |
| `here` | Current location plus its visible contents. |
| `focus` | Focused objects only. |
| `object` | One reachable object (passed as `object`). |
| `space` | One reachable space, or current location if omitted, plus its visible contents. |
| `all` | All directly reachable categories. Does *not* expand every space's contents — use `space` for that. |

Each tool descriptor includes the **canonical call form**
`<object>:<verb>(args)`. That handle is stable even when the MCP tool
name (a sanitized, collision-resistant alias) changes between
sessions. If you persist any reference to a tool across sessions,
persist the canonical form, not the MCP name.

## Invocation: named tool, or `woo_call`

You can invoke a tool either by its MCP name (`the_pinboard__list_pins`)
or by its canonical form via `woo_call`:

```
woo_call(
  object: "the_pinboard",
  verb: "list_pins",
  args: []
)
```

Use `woo_call` whenever your tool list might be stale — for instance,
right after the actor moved and you haven't re-listed yet. The
gateway resolves the verb against your *current* reachable scope, so
it never breaks just because the cached MCP name became invalid.

`args` is a **positional list of woo values**, not a stringified
argv. Numbers, booleans, strings, lists, maps all pass through.

## What comes back

The tool result is shaped:

```
{
  "content": [{ "type": "text", "text": "<one-line summary>" }],
  "structuredContent": {
    "result": <verb return value>,
    "observations": [<observation>, ...],
    "applied": { "space": <obj>, "seq": <int>, "ts": <ms> }    // sequenced calls only
  },
  "isError": false
}
```

- `content[0].text` is a human-readable summary. Useful when you're
  about to reply to a user.
- `structuredContent.result` is the verb's actual return value.
- `structuredContent.observations` are the events emitted by this
  call that you (the actor) are entitled to see. (More events may
  arrive later via `woo_wait`; this is the immediate-return slice.)
- `structuredContent.applied` is present only for **sequenced** calls
  (see [observations.md](observations.md)) and gives the seq/ts you
  need for replay.

## Reachability

The set of reachable objects — and therefore the set of available
tools — is the union of:

1. **Self.** Your actor object. Verbs like `focus`, `wait`, `unfocus`
   come from `$actor` and are always reachable.
2. **Current location.** The room or space you're in. Its `look`,
   `who`, `say`, `enter`, `go` come from here.
3. **Location contents.** Visible objects in the current location.
   Other actors and `$block` descendants appear here, but they're
   projected through **obvious verbs only** — readable verbs marked
   with command metadata. You don't get another actor's `focus` or
   `wait`; you do get `the_cockatoo:squawk` if it's command-shaped.
4. **Inventory.** Non-actor objects in your `contents`. After
   `take lamp`, the lamp's verbs follow you between rooms.
5. **Other live locations.** If the same actor has another live
   session somewhere else, that location's verbs are reachable too.
6. **Working set (focus list).** Objects you've explicitly added
   with `woo_focus`. Capped (default 32 entries).
7. **Catalog-visible singletons.** What the catalog registry exposes
   to your actor's class/role. Wizards usually see more here than
   ordinary actors.

This is specified in [`../../spec/protocol/mcp.md §M3`](../../spec/protocol/mcp.md#m3-reachability--what-shows-up-where).

## The working set: `woo_focus`

The working set is how you keep an object's verbs reachable as you
move. The classic case: you call `the_taskspace:list_tasks()` and
get back a list of task object refs. Those tasks aren't automatically
reachable — they're contents of the taskspace, not of your current
location. You focus the ones you care about:

```
woo_focus(target: "#01HX...task42")
```

Now `task42`'s verbs (`claim`, `set_status`, `add_subtask`) join
your tool list. They stay reachable until you `woo_unfocus(...)` or
the entry is evicted (capped at 32, oldest evicted first).

The focus list **persists with the actor across connections**. It's
a property on the actor, not a session-scoped thing. You can
introspect it via `woo_call("$me", "describe", [])` (the `focus_list`
field) or call `$actor:focus_list()` directly.

## Direct vs sequenced — the routing distinction

When you call a tool, the gateway picks the route from the verb's
metadata:

- **Direct** (`direct_callable: true`): live observation, no log
  entry. Examples: `say`, `look`, `set_control`, `take`, `drop`.
  The result returns immediately.
- **Sequenced** (the verb is `tool_exposed` but mutating): the call
  goes through the verb's enclosing space, gets a sequence number,
  and lands in the durable log. Examples: `create_task`, `claim`,
  `set_status`, `transition`. The applied frame is the tool result.

You don't usually need to think about which route a call takes; the
gateway picks correctly. But sequenced calls give you back a
`{space, seq, ts}` triple in `structuredContent.applied`, which you
can use for replay or gap recovery. See
[observations.md](observations.md) for what to do with that.

## Common patterns

**"What can I do here?"**

```
woo_list_reachable_tools(scope: "here")
```

**"What's in my inventory?"**

```
woo_call("$me", "describe", [])
# look at result.contents
```

**"Who else is around?"**

```
woo_call("$here", "who", [])
```

(`$here` is a corename for your current location resolved per
request.)

**"Find a task by name from the taskspace and start working on it."**

```
woo_call("the_taskspace", "list_tasks", [])
# pick result[i].id
woo_focus("#01HX...the-task-id")
woo_call("#01HX...the-task-id", "claim", [])
```

**"My tool list looks stale, redo discovery."**

```
woo_list_reachable_tools(scope: "active")
```

If your client supports `notifications/tools/list_changed`, you only
need to re-list when notified. Otherwise, re-list whenever you've
moved, focused, or unfocused.

**"Run several woocode statements as one MCP turn."** (programmer
agents only)

```
woo_call("$me", "eval", [
  "let t = the_taskspace:create_task({name: \"foo\"});\nt:claim();\nreturn t;",
  {mode: "stmts"}
])
```

The `eval` verb on `$programmer` compiles and runs woocode under
your `progr`, returning the result. Cheaper than chaining individual
`woo_call`s when the operations belong together. See
[../designing/eval.md](../designing/eval.md). Authority: requires
`$programmer` ancestry plus the `programmer` flag (or wizard).
