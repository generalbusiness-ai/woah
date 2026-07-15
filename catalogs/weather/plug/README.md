# Weather plug

Cloudflare Worker that fetches weather from [tomorrow.io](https://tomorrow.io)
and writes it into a `$weather_block` instance via woo's net API.

This is the outside-world half of the weather block. The catalog half (the
`$weather_block` class, manifest, UI components) lives elsewhere in
`catalogs/weather/`.

## What it does

Cron-triggered hourly. Each tick:

1. POSTs to `/net-api/session` with the actor-bound apikey for the weather block.
2. Reads the block's exact owner-set config cells (`place`, `timezone`, `units`).
3. Fetches three tomorrow.io endpoints in parallel: `weather/realtime`,
   `weather/forecast` (1h+1d timesteps), and `weather/history/recent`
   (1h+1d timesteps).
4. POSTs a sequenced `/net-api/turn` for `:set_properties` with `current` (flat scalar bundle, including
   `local_date` — the calendar date in the configured timezone at
   observation time, used by the block's chat verbs to resolve "today"),
   `daily` (per-day rollup array, each entry stamped with a 3-letter
   `weekday` for matching "thursday" without TZ math in the VM),
   `timeseries` (column-major ±7d hourly chart payload), `last_pushed_at`,
   `last_error`, and `config_state` — all in a single bundle so a reader
   never sees a torn snapshot.
5. Disconnects.

If the block has no `place` configured, has an invalid timezone, or
tomorrow.io rejects the place, the plug writes `config_state.status = "error"`
and a readable `last_error` on the block. On success it writes
`config_state.status = "confirmed"`. Timezone values must be valid IANA
timezone names; the plug does not do alias matching. Non-config source
failures, such as rate limits or auth errors, still update `last_error`.
Recognized failure modes:

- `owner has not configured a valid timezone - use an IANA timezone such as America/Los_Angeles`
- `tomorrow.io rate-limited (retry after Ns) — free plan caps 25/hour, 500/day`
- `tomorrow.io rejected the API key — check TOMORROW_IO_API_KEY`
- generic per-call message on other transport / parse failures

The Worker fails the whole tick when tomorrow.io errors; the cron retries
hourly. `last_error` is the operator-facing signal; `config_state` tells the
block owner whether the latest location/timezone has been confirmed.

## Tomorrow.io free-plan budget

Each tick costs **3 API calls** (realtime + forecast + history/recent),
issued in parallel. Free-plan caps:

| Limit | Per-block cost | Notes |
|---|---|---|
| 25 calls / hour | 3 / 25 | ~6 blocks per key on hourly cron |
| 500 calls / day | 72 / 500 | ~5 blocks per key on hourly cron |
| 3 calls / second | 3 (parallel) | Right at the burst cap; no headroom for retries within a tick |

Production demo: one weather block in the living room runs at ~12% of the
hourly free-plan budget and ~14% of the daily budget. Drop the cron to
every 3-4 hours, or shard keys per block, to host more blocks behind one
key.

## Setup

```bash
npm install
```

Configure the block on the woo side first with `:set_location(place,
timezone)`, then mint an apikey via `:mint_apikey`. The block marks the new
location as pending; the plug confirms or rejects it on the next run. Take
the secret and:

```bash
wrangler secret put WOO_APIKEY            # apikey:<id>:<secret>
wrangler secret put TOMORROW_IO_API_KEY   # https://app.tomorrow.io/development/keys
```

Validate `WOO_APIKEY` against woo before storing it:

```bash
export WOO_BASE_URL="https://woo.example.com"
export WOO_APIKEY="apikey:<id>:<secret>"

curl -fsS "$WOO_BASE_URL/net-api/session" \
  -H "Authorization: Bearer $WOO_APIKEY" \
  -H "content-type: application/json" \
  --data '{}'
```

Success returns `actor` equal to the weather block and a net `session`.
`E_NOSESSION` means the token is malformed, unknown, secret-
mismatched, or revoked. Use the full `apikey:<id>:<secret>` token;
`apikey:<secret>` is not the documented token form.

Deployment-specific public values live in `wrangler.toml` under `[vars]`:
`WOO_BASE_URL` and `BLOCK_ID`. The repo bootstrap script updates those public
vars. Secrets still go through `wrangler secret put`. If provisioning manually,
set the secrets before deploy:

```bash
wrangler secret put WOO_APIKEY
wrangler secret put TOMORROW_IO_API_KEY
wrangler secret put TRIGGER_SECRET
```

```bash
wrangler deploy
```

## Trigger manually

The Worker also accepts `POST /` (no body required) for first-light wiring or
for "I just changed the place, refresh now". Manual triggers require the
shared trigger secret:

```bash
curl -X POST https://<worker-url>/ \
  -H "Authorization: Bearer $TRIGGER_SECRET"
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
| `weather_config:E_NO_PLACE` | block has no `place` set | owner runs `:set_location("City", "America/Los_Angeles")` |
| `weather_config:E_BAD_TIMEZONE` | block timezone is empty or not recognized | owner runs `:set_location` with an IANA timezone |
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
