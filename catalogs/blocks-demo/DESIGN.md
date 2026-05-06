# blocks-demo — design notes

## Why a separate catalog

The class catalogs (`block`, `weather`, `dispenser`, `horoscope`) define
the *shapes*. Real deployments bring their own block instances — a
production world will not have `the_weather` and `the_horoscope` named
explicitly. This catalog isolates the demo placement so:

- Production deployments can install only the class catalogs.
- The demo path stays a one-line install (`installLocalCatalogs(world,
  ["blocks-demo"])` pulls in dispenser/weather/horoscope/demoworld
  transitively).
- New demos (a database block, a ticker block) can land as additional
  small bundles without touching the class catalogs.

## Placement

| Instance | Class | Room | Why |
|---|---|---|---|
| `the_weather` | `$weather_block` | `the_chatroom` (the "living room") | Ambient: visible from where everyone hangs out. Default place is Mountain View, CA — owner can `:set_property("place", ...)` to relocate. |
| `the_horoscope` | `$horoscope_block` | `the_deck` | Vending-machine ambience reads better outdoors; deck is a standing-around space rather than a sitting-down space. |

Both are anchored (the `$block` base class enforces `:moveto` raises and
`:acceptable` returns false), so `home: location` and `anchor` form the
permanent fixture.

## Plug wiring (post-install)

The seed hooks create the in-world objects. The plug Workers are
deployed separately because they live outside woo:

```bash
# In a session as the catalog owner (or wizard):
$ woo>  the_weather:mint_apikey("weather-cf-worker-prod")
   { id: "ak_…", secret: "<one-time>" }

$ cd catalogs/weather/plug
$ wrangler secret put WOO_APIKEY            # apikey:<id>:<secret>
$ wrangler secret put TOMORROW_IO_API_KEY
$ wrangler deploy

$ woo>  the_horoscope:mint_apikey("horoscope-cf-worker-prod")
   { id: "ak_…", secret: "<one-time>" }

$ cd catalogs/horoscope/plug
$ wrangler secret put WOO_APIKEY
$ wrangler deploy
```

After deploy, the weather panel ticks hourly; the horoscope machine
fulfills `:order` requests on a one-minute cron.

## Reconfiguration

The owner of the block writes config props in-world:

```text
@describe the_weather as "A small bronze weather panel ..."
the_weather:set_property("place", "Tokyo, JP")
the_weather:set_property("units", "metric")
the_horoscope:set_property("system_prompt", "...new persona...")
```

The plugs read config every cycle, so changes take effect on the next
tick (within ~60 minutes for weather; within ~1 minute for horoscope).
