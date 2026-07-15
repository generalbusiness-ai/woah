# Horoscope plug

Cloudflare Worker that drains a `$horoscope_block`'s order queue, calls a
small Workers AI model, and delivers the result as a `$note` to the orderer.

This is the outside-world half of the horoscope vending machine. The catalog
half (the `$horoscope_block` class extending `$dispenser_block`, manifest, UI
components) lives elsewhere in `catalogs/horoscope/`.

## What it does

Cron-triggered every minute. Each tick:

1. Reuses a cached woo session if one is still warm in this CF isolate
   (apikey-class sessions are valid for 24h; the plug re-authenticates
   only when the cached session is within 1h of expiry, or when the
   isolate cold-started). Otherwise POSTs to `/net-api/session` with the
   actor-bound apikey for the block. The `tick_ok` log line carries
   `auth: "warm" | "cold"` so the cache hit rate is greppable from
   `wrangler tail`.
2. Reads the block's exact `system_prompt` cell through a short in-isolate TTL cache
   (`SYSTEM_PROMPT_TTL_MS`, default 5 minutes). Owner changes may take a
   few ticks to reach a warm plug isolate; cold starts still read it once.
3. Loops up to `MAX_ORDERS_PER_TICK`:
   - POSTs `:next_pending` — if `null`, exits the loop.
   - Runs `@cf/meta/llama-3.2-1b-instruct` on Workers AI with
     `system_prompt + request`.
   - POSTs `:deliver(order_id, name, text, description)` — `name` is
     built from the order request (`scorpio` → `"Horoscope: Scorpio"`)
     so the inventory listing reads cleanly; `text` is the markdown
     content shown by `read`; `description` is a one-line look-at
     flavour (`A horoscope reading the machine produced for "scorpio".
     Try \`read\` to see what it says.`) shown by `look`, per the
     LambdaCore `$note` slot split. The block creates a `$note` with
     those fields, moves it to the orderer's inventory, and tells the
     orderer it arrived.

Failure handling:

- **AI generation failed** (rate limit, model timeout, empty response) — the
  plug delivers a placeholder note instead so the queue drains, and writes
  an `ai fallback: <reason>` line to `last_error` so `:look_self` reflects
  the degraded mode.
- **`:deliver` raised a permanent code** (`E_INVARG`, `E_PERM`, `E_VERBNF`,
  `E_TYPE`, `E_RANGE`) — retrying with the same data won't change the
  outcome, so the plug calls the catalog's plug-actor `:cancel` path to
  peel the order off the queue head. The user gets nothing for that order;
  the trail is in `last_error`.
- **Anything else** (`E_TIMEOUT`, `E_INTERNAL`, `E_GATEWAY`, 5xx, transport
  failure) — treated as transient. The order stays on the queue and the
  plug stops the tick. The next cron retries.
- **`E_NOSESSION`** — the apikey-bound session no longer authenticates;
  the plug stops the tick and the next cron re-auths.

`:deliver` is idempotent on `order_id`, so retries are safe.

`last_pushed_at` is a health heartbeat, not a work record. Empty ticks only
write it when `HEARTBEAT_INTERVAL_MS` has elapsed (default 5 minutes);
ticks that delivered an order or need to surface `last_error` still write
immediately.

## Why net turns, not MCP

The plug's calls are operational (queue drain, artifact production), not
agent tool discovery. Authenticated net turns enforce woo permissions without
going through MCP's `tool_exposed` gate, which keeps `:next_pending` and
`:deliver` hidden from agent tool listings while the block's apikey-bound
session can still call them. See `src/mcp-client.ts` for an MCP-attached
variant kept for the day we want event-driven (`woo_wait`) drain instead
of cron polling — at that point we'd flip the catalog to mark the
relevant verbs `tool_exposed: true` and switch the plug to use that
client.

## Setup

```bash
npm install
```

Configure the block on the woo side first (owner sets `description` and calls
`:set_system_prompt`, then mints an apikey via `:mint_apikey`). Take the
secret and:

```bash
wrangler secret put WOO_APIKEY            # apikey:<id>:<secret>
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

Success returns `actor` equal to the horoscope block and a net `session`.
`E_NOSESSION` means the token is malformed, unknown,
secret-mismatched, or revoked. Use the full `apikey:<id>:<secret>`
token; `apikey:<secret>` is not the documented token form.

`wrangler.toml` carries public `[vars]` for `WOO_BASE_URL`, `BLOCK_ID`,
`MAX_TOKENS`, and `MAX_ORDERS_PER_TICK`; secrets still go through
`wrangler secret put`.

```bash
wrangler deploy
```

## Trigger manually

The Worker accepts `POST /` (no body required) for first-light wiring or for
"I just placed an order, deliver now":

```bash
curl -X POST https://<worker-url>/
```

## Model choice

`@cf/meta/llama-3.2-1b-instruct` — smallest instruction-tuned model on Workers
AI (1B params, ~$0.20 per million output tokens). At 200–350 output tokens per
horoscope, ≈ $0.0001 per order. If output quality feels under-cooked, swap to
`@cf/meta/llama-3.2-3b-instruct` in `src/horoscope.ts`.

## Monitoring

Each tick emits structured JSON log lines: `tick_start`, one
`order_delivered` or `order_error` per processed queue entry, then `tick_ok`
or `tick_error`:

```json
{"ts":"...","event":"tick_start","trigger":"cron","block":"the_horoscope_block"}
{"ts":"...","event":"order_delivered","block":"the_horoscope_block",
 "order_id":"ord_42","requester":"guest_5","body_chars":312}
{"ts":"...","event":"tick_ok","trigger":"cron","block":"the_horoscope_block",
 "delivered":1,"errors":0,"duration_ms":7184}
```

On failure the relevant line carries a `category` for grep-friendly triage:

| `category` | Where | Cause | Fix |
|---|---|---|---|
| `woo:E_NOSESSION` | `tick_error` | woo rejected the apikey | check `WOO_APIKEY` |
| `woo:<code>` | `order_error` | block raised on `:next_pending` or `:deliver` | inspect `message` |
| `ai` | `order_error` | `generateHoroscope` threw (model timeout, quota, etc.) | inspect `message` |
| `unknown` | either | network / parse / runtime error | inspect `message` |

Per-order events let a tail-grep for `order_error` answer "did any orders
fail in the last hour?" without scanning every tick. `tick_ok.errors` is the
count for the same tick.

To tail in real time:

```bash
CLOUDFLARE_API_TOKEN=$(cat ~/.config/cloudflare/woo.token) \
  npx wrangler tail --format pretty
```

CF Workers Analytics reports failed-vs-succeeded scheduled invocations on
the dashboard.

## Testing

Unit tests use a mocked fetch (scripted JSON-RPC replies) plus a mocked
Workers AI binding — no real woo or AI inference needed. The logging tests
stub `console.log` and assert the breadcrumb shape and the category of each
failure mode.

```bash
npm test
```
