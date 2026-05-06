---
name: weather
version: 0.1.0
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

See [DESIGN.md](DESIGN.md) for the mapping to canonical block kinds and
the plug's lifecycle.

## Properties

### Owner-writable (configuration)

| Name | Default | Notes |
|---|---|---|
| `place` | `""` | Location string the plug passes to the upstream API (e.g. `"Mountain View, CA"`). |
| `units` | `"metric"` | `"metric"` or `"imperial"`. |
| `forecast_hours` | `12` | How many hours of forecast the plug should fetch. |

### Plug-writable (data)

| Name | Kind | Notes |
|---|---|---|
| `current` | `scalar` | Headline current temperature with unit and label. |
| `forecast` | `table` | Hourly forecast: columns + rows. |
| `history` | `series` | Recent observed values as a series. |
| `last_pushed_at` | int | Inherited from `$block`; epoch ms of last plug push. |
| `last_error` | str/null | Inherited from `$block`; most recent fetch failure. |

## Provisioning

```text
@create_instance $weather_block as the_living_room_weather location: the_living_room
:set_property("place", "Mountain View, CA")
:set_property("units", "imperial")
:mint_apikey("weather-cf-worker-prod")
# paste the resulting secret into wrangler secret put WOO_APIKEY
# wrangler deploy from catalogs/weather/plug
```

The plug Worker lives at [`plug/`](plug/). It runs on a Cloudflare cron
schedule (hourly) and uses the REST `/api/objects/<id>/calls/<verb>`
surface to push data via apikey-bound session.
