# weather — design notes

## Concept

`$weather_block` is the canonical first `$block` subclass: a clear
example of "owner sets the upstream key, plug pushes the data, UI
renders the canonical kinds without weather-specific code." It also
exercises the `scalar`, `table`, and `series` shapes simultaneously.

## Property mapping (plug → block)

The plug fetches tomorrow.io's `weather/realtime` and `weather/forecast`
endpoints for the configured `place`, then maps the response into the
block's three data props. Each value carries its `kind` so the generic
`<woo-block>` element can render it; specialized weather UIs can choose
to override per property.

```text
current   →  { kind: "scalar", value: 72.4, unit: "°F", label: "current_temp" }
forecast  →  { kind: "table",
               columns: [{name: "hour"}, {name: "temp"}, {name: "precip"}],
               rows: [[1, 72, 0], [2, 71, 0.1], ...] }
history   →  { kind: "series",
               series: [
                 { name: "temp",     unit: "°F", points: [[ts, 71], ...] },
                 { name: "humidity", unit: "%",  points: [[ts, 60], ...] }
               ] }
```

The plug also writes `last_pushed_at` (epoch ms of the most recent
successful push) and clears or sets `last_error` based on the upstream
result. Both inherit from `$block`'s `writable_self` list.

## Owner-writable config

`place`, `units`, `forecast_hours` are gated by `writable_owner`. The
plug subscribes to its own block's room — when an owner sets a config
prop, the resulting `block_data` observation reaches the plug; the next
poll cycle picks up the new value. (The plug also re-reads config on
each cycle, so a missed observation is harmless — the queue-as-truth
shape applies here too.)

## Connection mode

Scheduled / disconnected. The plug Worker has a cron trigger (hourly).
On each fire it:

1. Authenticates via `apikey:<id>:<secret>`.
2. Reads `place`, `units`, `forecast_hours` from the block.
3. Calls tomorrow.io.
4. Calls `:set_properties({current, forecast, history, last_pushed_at})`
   in a single bundle.
5. Disconnects.

Failure paths set `last_error` and skip the data write; `:look` surfaces
the freshness state for operators.

## Out of scope for v0.1

- Rich charting in the UI (the generic `<woo-block>` series renderer is
  intentionally minimal — last value plus point count).
- Multiple places per block (one block, one location; spawn another
  block for another location).
- Push-on-config-change (cron is enough for the demo).
- Persistent-WS mode (no real-time data here).

See [`notes/2026-05-05-block-and-plug.md`](../../notes/2026-05-05-block-and-plug.md)
for the broader pattern.
