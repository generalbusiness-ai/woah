# Writing a plug

A plug is an external process that authenticates as a block's actor,
pushes data into the block's properties, and answers calls to the
block's verbs. From woah's perspective, a plug is just an authenticated
agent for a block — there's no special "plug" type in the substrate.

This page covers what a plug needs to do. The two demo plugs
([`weather`](../../catalogs/weather/) and
[`horoscope`](../../catalogs/horoscope/)) are good reference
implementations.

## Connect

Production plugs use the net client surface. Keep the block-bound apikey in
the plug's secret store, mint a session with `POST /net-api/session` and
`Authorization: Bearer apikey:<id>:<secret>`, then use that same credential
plus the returned session for exact cell reads and `/net-api/turn` calls.
Operational verbs do not need to be exposed as MCP tools.

## What apikey to use

Each block has an associated **apikey** that authenticates as the
block's actor (not as the block's *owner*). The apikey is created
when the block is provisioned — typically the block's owner mints
it once and configures the plug with it.

Apikey provisioning is administrative; the spec is
[`../../spec/identity/auth.md §A3.5`](../../spec/identity/auth.md#a35-apikey-credentials).
For a deployment, you'd typically have a bootstrapping script that
generates the apikey and stores it in the plug's environment.

**Don't reuse apikeys across plugs.** A plug authenticates as the
block; its blast radius is whatever the block's actor can do. If
your weather plug's apikey leaks, you don't want it also writing
to the horoscope dispenser.

## Push data

Once authenticated, the plug calls `:set_property` on the block through a
sequenced net turn:

```json
{
  "session": "<net-session>",
  "idempotency_key": "<stable-correlation-id>",
  "target": "<block-id>",
  "verb": "set_property",
  "args": ["current", {"temperature": 18, "condition": "partly cloudy"}]
}
```

(Or `set_properties({...})` to push multiple at once.) The block's
class defines these verbs as plug-only — only the actor that owns
the block (i.e., the plug) can write data properties.

Each `:set_property` call:

1. Updates the property value.
2. Updates `last_pushed_at`.
3. Emits a `block_data` observation to the block's room and to
   anyone focused on the block.

An accepted response has `reply.status: "accepted"` and carries the verb's
`result` and observations. A rejected response carries a named error.

## Drain queued work

Dispenser-style blocks persist requests in a catalog-defined queue. A
scheduled plug calls the block's private queue-drain verb (for example
`:next_pending`), processes the returned order, then calls the matching
completion verb:

```json
{
  "session": "<net-session>",
  "idempotency_key": "deliver:<request_id>",
  "target": "<block>",
  "verb": "ask_reply",
  "args": ["<request_id>", {"answer": "..."}]
}
```

The block routes the answer back to the requester (typically by minting an
artifact and emitting a directed observation). Queue verbs can remain hidden
from MCP discovery because the actor-bound plug invokes them through net turns.

The exact shape (`ask_request` / `ask_reply`, or
`order_placed` / `deliver`) is class-defined. Read the block's
class source and the dispenser pattern in
[`../../catalogs/dispenser/DESIGN.md`](../../catalogs/dispenser/DESIGN.md).

## React to config changes

Config properties are owner-writable. Scheduled plugs read the exact required
`property_cell:<block>:<name>` cells through `/net-api/cell` on each tick (or
through a short, explicit cache). Persistent plugs may additionally use the
net WebSocket observation feed as an invalidation signal, but must re-read
authoritative cells after a change.

## Connection modes

Two patterns:

**Scheduled / disconnected.** The plug connects, pushes a batch of
data, disconnects. Wakes up on a schedule (cron). Cheap. Right for
data that doesn't need real-time response: weather (hourly), daily
reports, batch updates.

While disconnected, the block holds the last-pushed data. `:ask`
calls fail with "block is unplugged" or fall back to cached data
depending on the class.

**Persistent.** The plug runs as a long-lived service with reconnect and
retry logic. Right for high-frequency data (a ticker, a sensor) or for
blocks that need to answer queries on demand (an LLM-backed research
agent).

A class can support either; the same `$weather_block` runs in
scheduled mode for the basic forecast and could run in persistent
mode if you wanted to ask it about other locations or hours.

## Idempotency and retry

Use a stable `idempotency_key` on every `/net-api/turn`. If you lose the
connection mid-call, re-send with the same key; the committing scope returns
the recorded result instead of executing the effect twice.

For a scheduled push, **don't push the same data twice with the
same `last_pushed_at`** — the timestamp is your truth-of-recency
marker. Either pick a new timestamp on retry, or skip the retry
entirely if the data didn't change.

## Errors the plug should expect

| Error | Plug's response |
|---|---|
| `E_PERM` on `set_property` | The apikey isn't authoritative for this block. Configuration error; doesn't go away by retry. |
| Connection close | Reconnect with backoff. Resume from the last successful push. |
| `E_OBJNF` on the block target | The block was recycled. Stop. |
| `E_INVARG` | Bad argument shape. Fix and resend. |
| Rate-limit / quota | Backoff and retry. |

The plug is responsible for its own external-side errors (the upstream
API is down, the LLM is rate-limited). The plug decides how to
present them in the block: write a `status: "error"` config-style
property, push the last good data with a stale timestamp, etc.

## A minimal plug skeleton

In rough pseudo-code (real implementations have reconnection,
backoff, observability):

```python
token = "apikey:<id>:<secret>"
session = post("https://deployment/net-api/session", {}, bearer=token)["session"]

while True:
    data = fetch_external()
    post("https://deployment/net-api/turn", {
        "target": "the_my_block",
        "verb": "set_properties",
        "args": [{"current": data, "last_pushed_at": now_ms()}],
        "session": session,
        "idempotency_key": stable_tick_key(),
    }, bearer=token)
    sleep_until_next_schedule()
```

For a persistent plug, you'd add a receive loop processing `event`
frames — `ask_request`, `order_placed`, config changes — and
sending replies.

For a real implementation, see
[`../../catalogs/weather/`](../../catalogs/weather/) (scheduled CF
Worker) and [`../../catalogs/horoscope/`](../../catalogs/horoscope/)
(LLM-backed dispenser).

## Where this all comes from

The block-and-plug architecture emerged from the design discussion in
[`../../notes/2026-05-05-block-and-plug.md`](../../notes/2026-05-05-block-and-plug.md).
It generalizes the LambdaMOO "interactive toy" idiom (a contraption
publishing state and verbs) by adding an external authenticated
principal that writes the data via apikey. Subclasses add their own
verbs and behaviors; the base class just publishes data and runs
the room observations.
