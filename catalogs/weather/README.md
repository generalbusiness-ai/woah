---
name: weather
version: 1.1.0
spec_version: v1
license: MIT
description: Weather block class — a $block subclass driven by an external plug that fetches tomorrow.io and pushes a flat current scalar, a 14-entry per-day rollup, and a column-major hourly time-series spanning the past week through the next week. v1.1 adds an `:ask` chat verb backed by `current.local_date` and `daily[*].weekday`.
keywords:
  - block
  - weather
  - plug
  - demo
---

# weather

A `$weather_block` is a `$block` subclass that displays weather data
fetched by an external plug Worker. The plug authenticates as the block's
actor via an apikey credential, calls a hosted weather API on a schedule,
and pushes the result into the block's `writable_self` properties; the
block's owner configures *where* and *how* via `writable_owner` props.
The class object `$weather_block` is fertile: builders can create new
weather panel instances under it, and each instance inherits the
owner/wizard configuration verbs.

See [DESIGN.md](DESIGN.md) for the property surface (three internally
consistent props written in one bundle), the d3-friendly column-major
chart payload, and the plug's lifecycle.

## Properties

### Owner-writable (configuration)

| Name | Default | Notes |
|---|---|---|
| `place` | `""` | Town name or zip code. The plug passes this to the upstream API, and the block displays this same value. |
| `timezone` | `""` | IANA timezone, e.g. `America/Los_Angeles`; the plug uses it to render local observation time text and to bucket daily rollups. |
| `units` | `"metric"` | `"metric"` or `"imperial"`. |
| `config_state` | `{status: "unconfigured"}` | Plug confirmation state for the current location/timezone. |

## Owner Tools

`$weather_block` exposes narrow configuration verbs on each instance:

| Verb | Notes |
|---|---|
| `set_location(place, timezone)` | Sets `place` and `timezone` together, clears stale errors, and marks `config_state.status` as `pending` until the plug confirms them. |
| `set_units(units)` | Accepts `metric` or `imperial`. |

Only the block owner or a wizard can use these verbs. The generic
`$block:set_property` / `:set_properties` surface remains hidden from MCP
tools; plug sessions still use it for data writes. Semantic validation
stays in the plug: timezone values must be real IANA timezone names, and
invalid values are rejected when the plug runs.

### Plug-writable (data)

Three internally-consistent props, written in one `:set_properties` bundle
so a reader never sees a torn snapshot:

| Name | Shape | Notes |
|---|---|---|
| `current` | small flat map | `temperature`, `temperature_unit`, `humidity`, `weather_code`, `observed_at` (ms epoch), `observed_at_text` (plug-rendered timezone-aware string), `local_date` (YYYY-MM-DD in the configured timezone, used by `:ask` to resolve "today"). Read by chat verbs and the badge. |
| `daily` | list of small maps (~14) | One entry per covered day, ordered ascending by `date` (YYYY-MM-DD in the configured timezone). Each carries `weekday` (3-letter lowercase, e.g. `"thu"`), pre-computed min/max/mean per metric, and `precip_total`. Read by chat verbs that summarize the week. |
| `timeseries` | column-major map | `anchor`, `t0`, `step`, `units`, `fields[name].{unit,agg,values}`. ~336 hourly samples spanning ±7 days, one homogeneous array per metric for d3. Read only by the chart UI. |
| `last_pushed_at` | int | Inherited from `$block`; epoch ms of last plug push. |
| `last_error` | str/null | Inherited from `$block`; most recent fetch failure. |
| `config_state` | map | `pending`, `confirmed`, or config-specific `error` state for the owner-set location/timezone. |

## Look Surface

`:title()` renders the current scalar reading directly, for example
`Temperature in Mountain View CA: 72°F`. `:look_self()` renders a sentence:
`The weather panel shows that the temperature in Mountain View CA was 72°F
at May 6, 2026, 9:01 AM PDT.` The plug formats this from the observation
timestamp and the block's `timezone`; `:look_self()` does not show the raw
`last_pushed_at` epoch. The look return also exposes `daily` for verbs
that need a per-day summary; `timeseries` is intentionally projected
separately and is not in the look return.

## Chat: `ask weather <when>`

`:ask` answers a one-line summary for a date the user names in chat:

```text
> ask weather today
Weather today (2026-05-09) in Seattle: 14°C to 22°C
> ask weather tomorrow
Weather tomorrow (2026-05-10) in Seattle: 15°C to 23°C
> ask weather thursday
Weather thu (2026-05-14) in Seattle: 18°C to 26°C
> ask weather 5/12
Weather tue (2026-05-12) in Seattle: 16°C to 24°C
```

Accepted forms: `today` / `now`, `tomorrow`, `yesterday`, weekday names
(full or 3-letter, case-insensitive), `M/D` / `M-D` (resolved against
`current.local_date`'s year, with a one-year roll-over fallback for the
December/January boundary), and `YYYY-MM-DD`. Out-of-window queries get
a polite "no data" message; unrecognised input gets a usage hint listing
the accepted forms.

Resolution is pure string matching against `current.local_date` and
`daily[*].date` / `daily[*].weekday` — the plug stamps both at push
time, so the verb runs without any IANA timezone math in the VM.

## UI

The catalog declares `weather.badge`, a compact `title-badge` component for
room title bars. The bundled web client mounts it next to the current room name
when a room contains a `$weather_block`; the demo Living Room is the intended
initial placement. The badge reads projected `current` data and falls back
silently if the UI module is unavailable.

## Provisioning

```text
@create_instance $weather_block as the_living_room_weather location: the_living_room
:set_location("Mountain View CA", "America/Los_Angeles")
:set_units("imperial")
:mint_apikey("weather-cf-worker-prod")
# paste the resulting secret into wrangler secret put WOO_APIKEY
# wrangler deploy from catalogs/weather/plug
```

Validate the minted token before storing it:

```bash
export WOO_BASE_URL="https://woo.example.com"
export WOO_APIKEY="apikey:<id>:<secret>"

curl -fsS "$WOO_BASE_URL/net-api/session" \
  -H "Authorization: Bearer $WOO_APIKEY" \
  -H "content-type: application/json" \
  --data '{}'
```

The response should include `actor` equal to the weather block and
a net `session`. Use the full `apikey:<id>:<secret>` token;
`apikey:<secret>` is not the documented token form.

The plug Worker lives at [`plug/`](plug/). It runs on a Cloudflare cron
schedule (hourly) and uses authenticated `/net-api/turn` calls to push data
via an apikey-bound session.
