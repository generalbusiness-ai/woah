---
name: weather
version: 0.1.2
spec_version: v1
license: MIT
description: Weather block class — a $block subclass driven by an external plug that fetches tomorrow.io and pushes current, forecast, and history.
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

See [DESIGN.md](DESIGN.md) for the mapping to canonical block kinds and
the plug's lifecycle.

## Properties

### Owner-writable (configuration)

| Name | Default | Notes |
|---|---|---|
| `place` | `""` | Town name or zip code. The plug passes this to the upstream API, and the block displays this same value. |
| `timezone` | `""` | IANA timezone, e.g. `America/Los_Angeles`; the plug uses it to write local observation time text. |
| `units` | `"metric"` | `"metric"` or `"imperial"`. |
| `forecast_hours` | `12` | How many hours of forecast the plug should fetch. |
| `config_state` | `{status: "unconfigured"}` | Plug confirmation state for the current location/timezone. |

## Owner Tools

`$weather_block` exposes narrow configuration verbs on each instance:

| Verb | Notes |
|---|---|
| `set_location(place, timezone)` | Sets `place` and `timezone` together, clears stale errors, and marks `config_state.status` as `pending` until the plug confirms them. |
| `set_units(units)` | Accepts `metric` or `imperial`. |
| `set_forecast_hours(hours)` | Stores a rounded value from 1 to 168. |

Only the block owner or a wizard can use these verbs. The generic
`$block:set_property` / `:set_properties` surface remains hidden from MCP
tools; plug sessions still use it for data writes. Semantic validation
stays in the plug: timezone values must be real IANA timezone names, and
invalid values are rejected when the plug runs.

### Plug-writable (data)

| Name | Kind | Notes |
|---|---|---|
| `current` | `scalar` | Headline current temperature with unit, label, observed time text, and source `weather_code`. |
| `forecast` | `series` | Hourly forecast with temperature points and hourly detail rows. |
| `history` | `series` | Recent observed values as a series. |
| `last_pushed_at` | int | Inherited from `$block`; epoch ms of last plug push. |
| `last_error` | str/null | Inherited from `$block`; most recent fetch failure. |
| `config_state` | map | `pending`, `confirmed`, or config-specific `error` state for the owner-set location/timezone. |

## Look Surface

`:title()` renders the current scalar reading directly, for example
`Temperature in Mountain View CA: 72°F`. `:look_self()` renders a sentence:
`The weather panel shows that the temperature in Mountain View CA was 72°F
at May 6, 2026, 9:01 AM PDT.` The plug formats this from the observation
timestamp and the block's `timezone`; `:look_self()` does not show the raw
`last_pushed_at` epoch.

## UI

The catalog declares `weather.badge`, a compact `title-badge` component for
room title bars. The bundled web client mounts it next to the current room name
when a room contains a `$weather_block`; the demo Living Room is the intended
initial placement. The badge reads projected block data and falls back
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

curl -fsS "$WOO_BASE_URL/api/auth" \
  -H "content-type: application/json" \
  --data "{\"token\":\"$WOO_APIKEY\"}"
```

The response should include `actor` equal to the weather block and
`token_class: "apikey"`. Use the full `apikey:<id>:<secret>` token;
`apikey:<secret>` is not the documented token form.

The plug Worker lives at [`plug/`](plug/). It runs on a Cloudflare cron
schedule (hourly) and uses the REST `/api/objects/<id>/calls/<verb>`
surface to push data via apikey-bound session.
