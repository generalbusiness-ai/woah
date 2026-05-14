# Using blocks

A block looks like a normal object in your room. You see it through
`look at`, you call its verbs, you read its properties. The fact that
its data comes from an external plug is mostly invisible — the
freshness indicator and the "block is unplugged" error are the only
signals that this is anything other than an ordinary object.

## Discovering blocks in a room

```
look
```

Blocks appear in the room's contents alongside other objects. The
room description usually includes a brief mention; `:describe()` on
the block tells you everything else.

```
woo_call("the_weather", "describe", [])
```

Returns the block's properties (data and config), readable verbs, and
parent class. Identifying a block:

- Its parent chain includes `$block`.
- It's anchored (can't be moved).
- It typically has a `last_pushed_at` property and a class-defined
  freshness window.

## Reading data

Block data is just properties. Read them like any other property:

```
woo_call("the_weather", "describe", [])
# look at result.properties.current
```

Or via REST:

```
GET /api/objects/the_weather/properties/current
```

The values are whatever the plug pushed. For a weather block, you
might see:

```
{
  "current": {temperature: 18, condition: "partly cloudy", ts: 1730000000000},
  "forecast": [...hourly entries...],
  "history":  [...hourly entries...],
  "last_pushed_at": 1730000000000,
  "place": "Mountain View, CA"
}
```

## Freshness

Whether the data is current is **derived**, not stored. The runtime
checks `last_pushed_at` against the block's class-defined freshness
window:

| Block class | Typical window |
|---|---|
| `$weather_block` | 90 minutes |
| Ticker / sensor | 60 seconds |
| Horoscope dispenser | (n/a — generates on demand) |

If the data is stale, the block's `:describe()` may include a
freshness flag, and rich UI clients show a "stale" indicator. The
data is still there; it's just been a while.

For a **persistent** plug (one that holds an open connection
continuously), the indicator may also reflect whether the plug is
currently attached. An attached-but-failing-to-fetch plug shows
"plugged in, errors" rather than just "stale."

## Calling block verbs

Two common verbs many blocks expose:

```
woo_call("<block>", "ask", ["<free-text query>"])
```

Forwards a free-form query to the plug. The plug answers asynchronously
(synchronous if it's a fast computation; via observation push if
it's slow). Used for conversational blocks: "ask the weather block
about tomorrow," "ask the database block for the count of users."

```
woo_call("<dispenser-block>", "order", ["<request>"])
```

Specific to `$dispenser_block`: enqueues an order, returns a ticket.
The plug picks up the order, generates the result, and `:deliver`s
it as a `$note` into your inventory.

Other verbs depend on the block's class — read `:describe()` to see
what's available.

## What "the block is unplugged" means

If the block's plug isn't currently connected and you call a verb
that needs the plug (`:ask`, `:order` with no queue, etc.), the
verb may raise an error or return a fallback ("plug is offline").
The block's data properties are still readable — they're whatever
was last pushed — but you can't get fresh answers.

For a scheduled-mode plug (one that pushes hourly and disconnects in
between), this is normal. The block holds the last-pushed data; the
plug isn't there to answer queries between push windows.

For a persistent-mode plug, "unplugged" means something is wrong —
the plug crashed, lost network, or got rate-limited. The block's
owner sees this and decides whether to investigate.

## Observation route

When a plug pushes a property, the block emits a `block_data`
observation:

```
{
  "type": "block_data",
  "source": "<block>",
  "name": "<property-name>",
  "value": <the new value>,
  "kind": "data" | "config",
  "ts": <ms>
}
```

The audience is the block's room (and any actor focused on the
block). Other actors in the room see the data update live — a
ticker block updates everyone watching it without anyone having to
poll.

Sequenced observations (from a `$dispenser_block`'s `:order` /
`:deliver` flow) ride the normal space log — they're durable,
replayable, and indexed by seq.

## Configuration changes

If you own a block, you can write its config properties. The plug
**listens** for config changes (it observes the block's room) and
reacts:

```
woo_call("the_weather", "set_place", ["New York, NY"])
```

(The exact verb depends on the block. Some expose a single
`:configure(map)`; some expose per-property setters; some have you
write directly via the property-setter verb the block defines.)

The plug sees a `block_data` observation with `kind: "config"`,
notices the property changed, and adjusts. For the weather block,
the next push will fetch New York instead of Mountain View.

## Permissions

| Action | Who |
|---|---|
| Read block data properties | Anyone with read on the block. Usually public. |
| Read block config properties | Same. |
| Write block config | The owner. |
| Write block data | Only the plug (acting as the block's actor). |
| Call public verbs (`:ask`, `:order`) | Anyone, subject to the verb's perms. |
| Recycle the block | Owner or wizard. |

A non-owner trying to write a config property gets `E_PERM`. The
substrate doesn't know this is a "block" — it's just normal
property-write permission, with the property's owner being the block
itself (which the plug authenticates as).

## When blocks misbehave

If a block looks broken (stale data, errored verb calls, no response
to changes), the troubleshooting order:

1. Check freshness. `last_pushed_at` tells you when the plug last
   pushed. If it's been a long time, the plug is probably down.
2. Check the block's room observations. Recent `block_data` events
   tell you what the plug is doing.
3. If the plug is yours, look at its logs. The plug speaks the
   normal woah wire format and gets normal woah error responses.
4. If the plug isn't yours, contact whoever owns the block (it's in
   `:describe().owner`).

For the next level — writing or fixing a plug — see
[writing-a-plug.md](writing-a-plug.md).
