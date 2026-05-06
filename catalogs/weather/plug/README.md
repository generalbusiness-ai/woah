# Weather plug

Cloudflare Worker that fetches weather from [tomorrow.io](https://tomorrow.io)
and writes it into a `$weather_block` instance via the woo REST API.

This is the outside-world half of the weather block. The catalog half (the
`$weather_block` class, manifest, UI components) lives elsewhere in
`catalogs/weather/`.

## What it does

Cron-triggered hourly. Each tick:

1. POSTs to `/api/auth` with the actor-bound apikey for the weather block.
2. GETs the block's `place` property (e.g. `"Mountain View, CA"`).
3. Fetches tomorrow.io realtime + hourly-forecast endpoints.
4. POSTs `:set_properties` with `current` (scalar shape), `forecast` (series
   shape), and `last_pushed_at`.
5. Disconnects.

If the block has no `place` configured, or tomorrow.io errors, the plug writes
the failure into `last_error` on the block so the UI can render "stale, last
attempt errored: …". Recognized failure modes:

- `tomorrow.io rate-limited (retry after Ns) — free plan caps 25/hour, 500/day`
- `tomorrow.io rejected the API key — check TOMORROW_IO_API_KEY`
- generic per-call message on other transport / parse failures

The Worker fails the whole tick when tomorrow.io errors; the cron retries
hourly. No backoff state — `last_error` is the operator's only signal.

## Tomorrow.io free-plan budget

Each tick costs **2 API calls** (realtime + forecast). Free-plan caps:

| Limit | Per-block cost | Notes |
|---|---|---|
| 25 calls / hour | 2 / 25 | One or two blocks per key fits |
| 500 calls / day | 48 / 500 | A dozen blocks per key hits the daily cap |
| 3 calls / second | 2 (sequential) | Plug never fans out, so this is irrelevant |

Production demo: one weather block in the living room runs at ~10% of the
hourly free-plan budget and ~10% of the daily budget. Plenty of headroom.

## Setup

```bash
npm install
```

Configure the block on the woo side first (owner sets `place`, then mints an
apikey via `:mint_apikey`). Take the secret and:

```bash
wrangler secret put WOO_APIKEY            # apikey:<id>:<secret>
wrangler secret put TOMORROW_IO_API_KEY   # https://app.tomorrow.io/development/keys
```

Edit `wrangler.toml` to set `[vars] WOO_BASE_URL` and `[vars] BLOCK_ID`.

```bash
wrangler deploy
```

## Trigger manually

The Worker also accepts `POST /` (no body required) for first-light wiring or
for "I just changed the place, refresh now":

```bash
curl -X POST https://<worker-url>/
```

## Monitoring

Each tick emits two structured JSON log lines (start + ok or start + error):

```json
{"ts":"...","event":"tick_start","trigger":"cron","block":"the_weather_block"}
{"ts":"...","event":"tick_ok","trigger":"cron","block":"the_weather_block",
 "place":"Mountain View, CA","fetched_at":1735000000000,"duration_ms":612}
```

On failure the second line is `tick_error` with a `category` so you can grep
for the failure mode without parsing free-text:

| `category` | Cause | Fix |
|---|---|---|
| `woo:E_NOSESSION` | woo rejected the apikey | check `WOO_APIKEY` secret |
| `woo:E_NO_PLACE` | block has no `place` set | owner runs `:set_property("place", "City")` |
| `tomorrow:auth` | tomorrow.io rejected the API key | check `TOMORROW_IO_API_KEY` secret |
| `tomorrow:rate_limit` | hit the free-plan ceiling | wait, or upgrade |
| `tomorrow:<status>` | other tomorrow.io HTTP error | inspect `message` |
| `unknown` | network / parse / runtime error | inspect `message` |

To tail in real time:

```bash
CLOUDFLARE_API_TOKEN=$(cat ~/.config/cloudflare/woo.token) \
  npx wrangler tail --format pretty
```

CF Workers Analytics also reports failed-vs-succeeded scheduled invocations
on the dashboard. Combined with the log breadcrumbs that's enough to answer
"is the plug healthy and which way did it break?"

## Testing

Unit tests use a mocked fetch — no real woo or tomorrow.io needed. The
logging tests stub `console.log` and assert the breadcrumb shape.

```bash
npm test
```

## Running locally without Cloudflare

The same tick logic runs as a plain Node script, useful for development
against `npm run dev` or for offline smoke-testing. Copy `.env.example`
to `.env`, fill in the four required values, then:

```bash
# one-shot tick (exit code reflects success/failure)
npm run plug:once

# loop on PLUG_INTERVAL_SEC (default 60s)
npm run plug
```

Both scripts call the same `runLoggedWeatherTick` exported from
`src/index.ts`, so behavior and logging match the deployed Worker
exactly. The local runner adds two extra log events:
`{event: "loop_start", interval_sec, block}` and
`{event: "loop_stop", signal}` on SIGINT/SIGTERM.
