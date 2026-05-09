# Objects and inventory

You can pick objects up, carry them between rooms, give them to other
actors, and put them down. Objects you carry stay with you; their
verbs come along (your inventory contributes to your reachable scope).

The verbs here come from `$portable` (the carryable trait) and the
chat-catalog room verbs.

## Picking things up

```
take lamp
get lamp
```

Calls `<here>:take(<lamp>)`. The room resolves "lamp" against its
contents, then moves the matched object into your inventory. If the
object isn't `$portable` (or has refused with `:can_be_attached_by`),
the call raises an error.

For agents:

```
woo_call("$here", "take", ["the_lamp"])
```

You can also pass an object id directly: `woo_call("$here", "take",
["#01HX..."])`.

A successful take produces:
- A `taken` observation in your queue (and broadcast to the room,
  excluding you — the broadcast says `<you> picks up <lamp>`).
- The lamp's `location` updates to your actor.
- The lamp's verbs join your reachable scope.

## Putting things down

```
drop lamp
```

Calls `<here>:drop(<lamp>)`. Moves the object from your inventory to
the room. Reverses the visibility of `take`.

## Giving an object to someone

```
give lamp to alice
```

Calls `<lamp>:give(<alice>)` (or the equivalent route). Transfers
ownership of the in-room object from you to the named actor.

Not all objects accept gifts; the recipient's class can refuse
(`:acceptable(target)` returns false), or the donor can be denied
(`:can_be_attached_by`).

## Examining things

```
look at lamp
examine lamp
```

The `look at` form calls the room's match-and-look path, which ends
up at the target's `:look_self()` (chat catalog's convention) or
`:describe()` (the universal substrate verb, defined on
`$root_object`).

`describe()` returns structured metadata: id, name, parent, owner,
location, anchor, flags, modified, properties (those readable to
you), verbs (those readable to you), declared schemas, children,
contents. It's the discoverability surface — every object answers
`:describe()`, and the runtime guarantees it's always reachable.

For agents:

```
woo_call("the_lamp", "describe", [])
```

This is your foundation for *any* unfamiliar object. If you encounter
an object you've never seen before, calling `:describe()` on it is
the right first move.

## Notes — text payloads

The note catalog adds `$note`, an object whose primary content is a
markdown text body.

A `$note` has three independent text slots:

| Slot | Meaning |
|---|---|
| `name` | Listing label. What `inventory` shows. Short. |
| `description` | Cosmetic flavour. What `look at` shows. |
| `text` | The markdown payload. What `read` shows. |

Don't conflate them — a long `description` will make your inventory
unreadable; a short `text` defeats the purpose.

```
read <note>
```

Calls `<note>:read()`. Returns the markdown body for rendering.
Agents calling this through MCP receive the markdown verbatim in
`structuredContent.result.text`; the client decides whether to
render or display raw.

```
write <note>
```

Opens the note for editing (in clients that support it). Requires
write permission on the note.

```
erase <note>
```

Clears the note's text payload. Requires write permission.

The format property (`note.format`) is `"plain"` or `"markdown"`,
defaulting to plain when unset. Markdown notes get title extraction
from the first H1; plain notes use the first line. See
[../reference/text-format.md](../reference/text-format.md).

## Other objects you'll meet

The chat catalog and demoworld seed a small bestiary in the reference
deployment. You'll typically see (vary by world):

- **`the_cockatoo`** — a `$chatroom` resident with `:squawk` and
  related verbs. Ambient flavor.
- **Furniture** — `$furniture` descendants (couches, lamps, hot
  tubs). Fixed in place; some you can `enter` (a hot tub is itself
  a small `$chatroom`).
- **Notes** in inventory — `$note` instances and their subclasses
  (`$pin`, `$task`).
- **Blocks** — `$block` descendants displaying external data. See
  [../blocks-and-plugs/](../blocks-and-plugs/).

When in doubt, `:describe()` an object to see its parent chain and
its readable verbs. The verb list tells you what you can do.

## Permissions and what to expect when they fail

You'll see specific error codes on failure:

| Error | Meaning |
|---|---|
| `E_PERM` | Authority gate failed. Most often: you tried to mutate a property you don't own. |
| `E_RECMOVE` | Containment cycle (object ending up inside itself). |
| `E_NACC` | Anchored or otherwise immovable. `$block` descendants raise this on `:moveto`. |
| `E_INVARG` | Bad argument shape (wrong type, wrong count). |
| `E_OBJNF` | Target object not found / not visible to you. |
| `E_PROPNF` | Named property doesn't exist. |
| `E_VERBNF` | Named verb doesn't exist. |

Agents seeing one of these in `isError: true` should `:describe()` the
target and the surrounding room to recover context, then either ask
the user / try a different approach / give up gracefully.

## Inventory introspection

Your own inventory is just `$me.contents`:

```
woo_call("$me", "describe", [])
# result.contents is your inventory
```

There's typically also a chat-catalog `inventory` verb that produces a
human-readable rendering for chat clients; agents usually want the
structured form from `:describe()`.
