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
room description usually includes a brief mention; `:look_self()` or
the ordinary inspection surface provides the rest.

```
woo_call("the_weather", "look_self", [])
```

Identifying a block:

- Its parent chain includes `$block`.
- It's anchored (can't be moved).
- It typically has a `last_pushed_at` property and a class-defined
  freshness window.

## Reading data

Block data is just properties. Read them like any other property:

```
woo_call("the_weather", "get_data", ["current"])
```

External clients that need exact values use the Net cell-read surface
documented in [writing-a-plug.md](writing-a-plug.md). There is no
block-specific property REST API.

The values are whatever the plug pushed. For a weather block, you
might see:

```
{
  "current": {temperature: 18, condition: "partly cloudy", ts: 1730000000000},
  "daily": [...daily entries...],
  "timeseries": {time: [...], temperature: [...]},
  "last_pushed_at": 1730000000000,
  "place": "Mountain View, CA"
}
```

## Freshness

The base block stores `last_pushed_at`; it does not impose one universal
freshness policy. A concrete class or client derives freshness from that
timestamp according to the source's expected update interval:

| Block class | Typical window |
|---|---|
| `$weather_block` | 90 minutes |
| Ticker / sensor | 60 seconds |
| Horoscope dispenser | (n/a — generates on demand) |

If the data is stale, the concrete block's look result or rich UI may
show a stale indicator. The stored value remains readable. Connection
presence is not a substitute for freshness: a connected plug can have
an unhealthy upstream source, and a scheduled plug is normally
disconnected between successful pushes.

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
  "block": "<block>",
  "name": "<property-name>",
  "value": <the new value>,
  "ts": <ms>
}
```

The audience is the block's containing space. Connected actors may see
the update immediately, but fanout is best-effort. Consumers recover
after reconnect by reading current block state; `block_data` is not a
replicated-state or complete-history contract.

The production Net call is sequenced in its committing scope. Typed
coordination flows such as a `$dispenser_block`'s order and delivery use
their catalog's durable acts and projections; raw externally
authoritative values remain block properties.

## Configuration changes

If you own a block, use the class's configuration verbs:

```
woo_call("the_weather", "set_location", ["New York, NY", "America/New_York"])
```

(The exact verb depends on the block. Some expose a single
`:configure(map)`; some expose per-property setters; some have you
write directly via the property-setter verb the block defines.)

A scheduled plug re-reads the exact configuration cells it needs on
each tick. A persistent plug may use `block_data` as an invalidation
hint, but still re-reads authoritative cells before acting. For the
weather block, the next tick fetches New York rather than the previous
location.

## Permissions

| Action | Who |
|---|---|
| Read block data properties | Anyone with read on the block. Usually public. |
| Read block config properties | Same. |
| Write block config | The owner. |
| Write block data | Only the plug (acting as the block's actor). |
| Call public verbs (`:ask`, `:order`) | Anyone, subject to the verb's perms. |
| Recycle the block | Owner or wizard. |

A non-owner trying to write configuration gets `E_PERM`. The substrate
doesn't know a special plug type: `$block:set_property[ies]` applies the
class's `:is_writable_by_property` policy, distinguishing the owner from
the block actor authenticated by the plug.

## When blocks misbehave

If a block looks broken (stale data, errored verb calls, no response
to changes), the troubleshooting order:

1. Check freshness. `last_pushed_at` tells you when the plug last
   pushed. If it's been a long time, the plug is probably down.
2. Check `last_error` and recent room observations for hints. Do not
   assume the observation stream is a complete activity log.
3. If the plug is yours, look at its logs. The plug speaks the
   normal woah wire format and gets normal woah error responses.
4. If the plug isn't yours, contact whoever owns the block (it's in
   `:describe().owner`).

For the next level — writing or fixing a plug — see
[writing-a-plug.md](writing-a-plug.md).
