# dispenser — design notes

## The pattern

A `$dispenser_block` decouples the request from the work:

1. Requester calls `:order(request)` — the verb appends a record to
   `pending_orders`, mints an `order_id`, and returns synchronously
   with `{order_id, queued: true, ts}`. The verb does NOT wait for the
   plug.
2. The plug (a CF Worker, or any apikey-bound WS/REST client) drains
   the queue at its own cadence — either on a cron tick or in response
   to a directed `text` wakeup hint emitted by `:order` (best-effort).
   It calls `:next_pending()` to read the oldest record.
3. The plug processes the request *outside woo* (LLM, API call,
   compute) and calls `:deliver(order_id, body)`. The verb removes the
   entry, creates a `$dispensed_note` with the body, and moves it to
   the requester's inventory.
4. The requester sees the note arrive — that's the visible delivery.
   The room sees a sequenced `delivered` observation for bystanders.

## Why a queue and not parked tasks

Cross-DO parking is not supported in v1
([R6.2](../../spec/reference/cloudflare.md)) and even when fork/suspend
lands in the VM the plug would still need a queue for the parts that
happen outside woo. The queue is authoritative: lost wakeup hints don't
matter because the plug catches up on the next poll.

`:order` is not a parked-task style verb. It's a "ticket-then-go"
pattern: the request is durable, the work is asynchronous, the result
is delivered as an artifact rather than a return value.

## Idempotency

`:deliver(order_id, ...)` is keyed on `order_id`. If the plug retries
after a partial failure (network error after the deliver landed), the
second call returns
`{order_id, delivered: false, reason: "unknown_or_already_delivered"}`
rather than producing a duplicate note.

## Rate limiting

Per-requester interval enforced by `rate_limit_seconds` (default 60s).
The verb consults `this.last_request_at[requester]` and rejects with
`E_RATE_LIMIT` if too soon, including a `retry_in_seconds` hint in the
error value. Set `rate_limit_seconds` to `0` to disable.

The check runs *before* the queue append, so a flooded requester does
not pollute the queue with rejected orders.

## Sequencing

`order_placed`, `delivered`, and `canceled` are emitted via
`observe_to_space(location(this), ...)` — they are sequenced when the
verb is invoked through `$space:call` (the normal command path) and
live when invoked via direct call. In v0.1 the room-level command path
makes `:order` and `:cancel` sequenced; `:deliver` is plug-driven via
direct call, so the `delivered` observation is live. The note arrival
in the requester's inventory is durable regardless — bystander chatter
about delivery is the only thing that may not survive a reconnect.

## TTL on pending orders (deferred)

A long-offline plug can accumulate ghost orders. The design note's
"order TTL" enhancement (auto-deliver an "unattended" note for orders
older than N seconds) is deferred to a future revision. For v0.1 the
expectation is the plug's apikey, deployment health, and rate-limit
keep the queue small.

## What this catalog does NOT include

- Concrete dispensers (`$horoscope_block`) ship in their own catalogs.
- The plug process — that's an external CF Worker, deployed
  independently.
- TTL / retry / dead-letter shapes (deferred).
- A "subscribe to delivery" affordance — the requester sees the note
  arrive in their inventory; room bystanders see the sequenced
  observation. No additional notification API in v0.1.

See [`notes/2026-05-05-block-and-plug.md`](../../notes/2026-05-05-block-and-plug.md)
for the full pattern.
