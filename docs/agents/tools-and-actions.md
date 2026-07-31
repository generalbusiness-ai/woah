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
and command-parser argument sources.

**The schema is enforced, not decorative.** Your arguments are checked against
it before anything runs: a missing required argument or one of the wrong type
is refused with an `E_INVARG` naming the parameter, what was expected, and
what to do about it — and nothing happens in the world, so a refusal is always
safe to fix and retry. Extra properties the tool does not declare are ignored
rather than refused, so you can decorate a call with your own bookkeeping
fields; but that also means a *misspelled* argument name reads as "missing",
and the refusal lists the unrecognized names so you can spot the typo.

**Whatever the schema says is exactly what is enforced** — in both
directions. Anything it permits is accepted, and nothing it omits is secretly
required, so you can comply by reading it alone. An optional argument may be
omitted or passed as `null`, and its published type says so (`["string",
"null"]`). Where a value has a real format rule the schema carries it too:
`minLength` where a name cannot be empty, and `pattern` on `operation_id`.
The `arguments` field itself must be a JSON object keyed by parameter name —
or omitted when the tool takes none. Sending it as a string, a list, a number,
or `null` is refused rather than read as "no arguments".

`woo_call` is checked the same way once its target verb resolves: too few or
too many positional arguments, or one of the wrong type, are refused before
the call runs. The exception is a verb declared in the command form
(`verb :look(any any any)`), which declares no argument list for the server to
check against — those calls are passed through, and the verb itself decides.

Object ids are sanitized into tool names — anything outside letters, digits,
and `_` becomes `_` — so two different objects can want the same name (`a-b`
and `a_b` both give `a_b`). When that happens the server adds a numeric suffix
(`a_b__ping`, `a_b__ping_2`). The suffix is assigned across everything you can
reach, so **filtering or paging never changes a name**: the same verb on the
same object is always advertised under the same name, whether you saw it in
`tools/list`, in `woo_list_reachable_tools` with a `scope` or `query`, or on
page three. Calling the name you were given always reaches the object you were
shown. Names can be re-ranked when your context changes (you move, something
arrives) — that is what `notifications/tools/list_changed` tells you about, so
re-list when you get one.

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

`$me` is your own actor and `$here` is the space you are in. Verb names may be
abbreviated exactly as they can in a command: if a verb lists `l@ook` among its
aliases, `"l"`, `"lo"` and `"look"` all reach it. If you have not been placed
anywhere yet — a brand-new agent has not — `$here` names nothing and is
refused with `no_active_scope`; move somewhere first.

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
| `verb_order_unavailable` | Several verbs answer to that abbreviation and their order is undecidable — name one exactly. |
| `native_verb` | Engine-native; there is no Net execution body to call. |
| `verb_not_executable` | The verb's owner has not granted execute permission. |
| `not_direct_callable` | The verb is not exposed to outside direct calls. |
| `missing_required_argument` | Supply the named argument; `detail.expected` gives its type. |
| `argument_type_mismatch` | Re-send the named argument as `detail.expected`. |
| `too_many_arguments` | `detail.declared` lists the arguments the verb actually takes. |
| `argument_too_short` | The value is below the published `minLength` — usually an empty string where a name was needed. |
| `argument_pattern_mismatch` | The value does not match the published `pattern`; `detail.pattern` is the exact rule. |
| `invalid_arguments_object` | `arguments` must be a JSON object keyed by parameter name, or omitted entirely. |

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

## The collapsed profile (opt-in)

Everything above describes the default surface. An alternative *collapsed*
surface is available per session, and the two never mix: a session sees one or
the other.

Select it with a request header on every call to `/net-api/mcp`:

```
woo-mcp-profile: collapsed
```

or, through the stdio bridge, by setting `WOO_MCP_PROFILE=collapsed` in the
environment your MCP client spawns it with.

**What changes.** Verbs that every object in view shares — the ones inherited
from a base class or an attached feature — become ONE tool each, named by the
verb, taking the object as an argument:

```
look()                                    # the space you are in
look(target: "the_mug")
say(text: "hello")
set_description(target: "the_mug", desc: "…")
go(exit: "southeast")                     # absorbs north, out, and the rest
```

Verbs distinctive to one object keep the familiar `<object>__<verb>` name,
because there the object *is* the meaning:

```
the_cockatoo__squawk()
the_weather__ask(day: "tomorrow")
```

A verb a catalog declares for itself keeps its own name even when a universal
tool shares it — `the_cockatoo__look` and `look` both exist, and they are
different verbs.

A workspace sitting in your space shows no tools of its own until you enter it.
Enter it the way you always did, through the universal entry verb with the
workspace as the target.

Standing in the seeded Living Room this is 47 tools instead of 146.

**Reading the world.** This profile also serves MCP resources, which are the
efficient way to orient:

| URI | What |
|---|---|
| `woo://here` | the space you are in: exits, contents, mounted workspaces, roster |
| `woo://here/exits` | exits with stable ids, aliases, destination, and `traversable` |
| `woo://here/roster` | who is present |
| `woo://me` | your actor |
| `woo://me/inventory` | what you are carrying |
| `woo://object/{id}` | any object you can reach |

`resources/list` never changes as you move — the URIs are stable and their
contents move with you. Read `woo://here` again after a move rather than
expecting a new resource to appear.

`traversable: false` means the world advertises that exit and it will not move
you. Whether that is a locked door or a joke is for you to find out.

If your client ignores resources, `woo_read(uri)` returns the same payload as
a tool call.

The normative contract is
[`../../spec/protocol/mcp.md`](../../spec/protocol/mcp.md); the collapsed
profile is §M9.
