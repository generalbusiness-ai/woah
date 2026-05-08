# Horoscope plug

Cloudflare Worker that drains a `$horoscope_block`'s order queue, calls a
small Workers AI model, and delivers the result as a `$note` to the orderer.

This is the outside-world half of the horoscope vending machine. The catalog
half (the `$horoscope_block` class extending `$dispenser_block`, manifest, UI
components) lives elsewhere in `catalogs/horoscope/`.

## What it does

Cron-triggered every minute. Each tick:

1. POSTs to `/api/auth` with the actor-bound apikey for the block.
2. GETs the block's `system_prompt` (one property read).
3. Loops up to `MAX_ORDERS_PER_TICK`:
   - POSTs `:next_pending` — if `null`, exits the loop.
   - Runs `@cf/meta/llama-3.2-1b-instruct` on Workers AI with
     `system_prompt + request`.
   - POSTs `:deliver(order_id, name, text)` — `name` is built from the
     order request (`scorpio` → `"Horoscope: Scorpio"`) so the inventory
     listing reads cleanly; `text` is the markdown content. The block
     creates a `$note` with that name and text, moves it to the
     orderer's inventory, and tells the orderer it arrived.

Errors during AI generation leave the order on the queue and are reported in
the tick's response body. The block's TTL handles abandoned orders. `:deliver`
is idempotent on `order_id`, so retries are safe.

## Why REST, not MCP

The plug's calls are operational (queue drain, artifact production), not
agent tool discovery. REST hits woo's perm system directly without going
through MCP's `tool_exposed` gate, which keeps `:next_pending` and
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

curl -fsS "$WOO_BASE_URL/api/auth" \
  -H "content-type: application/json" \
  --data "{\"token\":\"$WOO_APIKEY\"}"
```

Success returns `token_class: "apikey"` and `actor` equal to the
horoscope block. `E_NOSESSION` means the token is malformed, unknown,
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
