# weather — design notes

## Concept

`$weather_block` is the canonical first `$block` subclass: a clear
example of "owner sets the upstream key, plug pushes the data, UI
renders the canonical kinds without weather-specific code." It also
exercises the `scalar`, `table`, and `series` shapes simultaneously.
The class object is a fertile template: behavior and owner tools live on
`$weather_block`, while deployed panels are ordinary non-fertile instances.

## Property mapping (plug → block)

The plug fetches tomorrow.io's `weather/realtime` and `weather/forecast`
endpoints for the configured `place`, then maps the response into the
block's three data props. `place` is the owner-configured town name or zip
code; the plug sends that value upstream and the block displays that same
value. `timezone` is the IANA zone used by the plug to write local
observation time text onto `current.observed_at_text`. If the upstream API
does not recognize `place`, the plug writes a helpful `last_error` instead
of inventing a fallback display location.
Each value carries its `kind` so the generic `<woo-block>` element can
render it; specialized weather UIs can choose to override per property.

```text
current   →  { kind: "scalar", value: 72.4, unit: "°F",
               label: "current_temperature", weather_code: 1000 }
forecast  →  { kind: "series",
               series: [{ name: "temperature", unit: "°F", points: [[ts, 71], ...] }],
               hourly: [{ time: ts, temperature: 71,
                          precipitation_probability: 5, weather_code: 1000 }, ...] }
history   →  { kind: "series",
               series: [
                 { name: "temp",     unit: "°F", points: [[ts, 71], ...] },
                 { name: "humidity", unit: "%",  points: [[ts, 60], ...] }
               ] }
```

The plug also writes `last_pushed_at` (epoch ms of the most recent
successful push) and clears or sets `last_error` based on the upstream
result. It also writes `config_state`: `confirmed` after a successful
fetch for the current location/timezone, or `error` for configuration
failures such as an invalid timezone or an upstream "unknown place"
response. These inherit from `$block`'s `writable_self` list.

## Owner-writable config

`place`, `timezone`, `units`, `forecast_hours` are gated by
`writable_owner`. Owners and wizards use narrow exposed verbs
(`set_location`, `set_units`, `set_forecast_hours`) rather than the raw
generic `$block:set_property` surface. `set_location` performs only local
shape checks, writes `place` and `timezone`, clears stale `last_error`, and
marks `config_state.status` as `pending`. The plug owns the semantic checks:
IANA timezone validation and source-API location failures all report back
through `config_state` and `last_error`.

The plug subscribes to its own block's room — when an owner sets a config
prop, the resulting `block_data` observation reaches the plug; the next
poll cycle picks up the new value. (The plug also re-reads config on each
cycle, so a missed observation is harmless — the queue-as-truth shape
applies here too.)

## Draft UI

The weather catalog ships a small `title-badge` component,
`weather.badge` / `<woo-weather-badge>`, declared in its manifest. The web
client mounts title badges in the chat room title bar when the current room's
contents include a matching object. In the demo deployment this means the
Living Room title bar shows the living-room weather block's current condition
and temperature to the right of "Living Room"; rooms without a weather block
show no badge.

The badge is only presentation. It reads the projected `$weather_block`
summary, primarily `current`, `forecast`, `config_state`, `place`, and
`last_error`. The plug writes `current.weather_code` from the realtime source
API so the badge can choose a compact condition icon without inferring weather
from temperature. If the UI module is missing or the component fails, ordinary
`:title()` / `:look_self()` remain the authoritative text surfaces.

## Connection mode

Scheduled / disconnected. The plug Worker has a cron trigger (hourly).
On each fire it:

1. Authenticates via `apikey:<id>:<secret>`.
2. Reads `place`, `timezone`, `units`, `forecast_hours` from the block.
3. Calls tomorrow.io.
4. Calls `:set_properties({current, forecast, history, last_pushed_at, config_state})`
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
