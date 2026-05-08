# dispenser — design notes

## The pattern

A `$dispenser_block` decouples the request from the work:

1. Requester calls `:order(request)` — the verb appends a record to
   `pending_orders`, mints an `order_id`, and returns synchronously
   with `{order_id, queued: true, text, ts}`. It also tells the requester
   that the order was accepted. The verb does NOT wait for the plug.
2. The plug (a CF Worker, or any apikey-bound WS/REST client) drains
   the queue at its own cadence — either on a cron tick or in response
   to a directed `text` wakeup hint emitted by `:order` (best-effort).
   It calls `:next_pending()` to read the oldest record.
3. The plug processes the request *outside woo* (LLM, API call,
   compute) and calls `:deliver(order_id, name, text)`. The plug
   supplies the `name` (the inventory listing label, e.g.
   `"Horoscope: Capricorn"`) and the `text` (markdown content). The
   verb removes the entry, creates a `$dispensed_note` owned by the
   block with that name, calls `:set_text(text)` to write the markdown
   payload (subject to the 262144-char cap on `$note.text`), and moves the
   note to the requester's inventory.
4. The requester sees the note arrive — that's the visible delivery.
   The requester also receives a direct text observation; the room sees a
   sequenced `delivered` observation for bystanders.

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

`:deliver(order_id, name, text)` is keyed on `order_id`. If the plug
retries after a partial failure (network error after the deliver
landed), the second call returns
`{order_id, delivered: false, reason: "unknown_or_already_delivered"}`
rather than producing a duplicate note.

## Why the plug supplies `name`

LambdaMOO's `$note` keeps three slots — `name` (listing identity),
`description` (cosmetic look-at flavour), and `text` (the readable
content) — and they never mix. v0.1 of this catalog dispensed notes
whose `name` was unset and whose body was injected as a single `text`
list-line, so the inherited title heuristic concatenated
`name + ": " + text[1]` and the entire horoscope rendered into the
inventory listing.

v0.2 hands name responsibility to the producer. The plug knows the
request, the order, and the text, so it knows how to label the
artifact: `"Horoscope: Capricorn"`, `"Recipe of the day: Earl Grey"`,
or whatever fits the dispenser kind. The block stores the name on the
note's identity slot and calls `:set_text(text)` for the markdown
content. Inventory shows the name; `read note` shows the text. Same as
LambdaMOO.

A subclass that prefers to compute the name from request+text in-world
(rather than at the plug) can expose a `:default_note_name(request,
text)` hook and have the plug consult it before calling `:deliver`,
but the contract on the block stays the same: name is required.

## Admission limits

Per-requester interval enforced by `rate_limit_seconds` (default 60s).
The verb consults `this.last_request_at[requester]` and rejects with
`E_RATE_LIMIT` if too soon, including a `retry_in_seconds` hint in the
error value. Set `rate_limit_seconds` to `0` to disable.

Three owner-writable caps cover the cases a requester-level limit cannot:
`block_cooldown_seconds` (default 5) throttles the block across all
requesters, `max_pending_orders` (default 50) bounds the queue, and
`max_request_chars` (default 200) bounds each request body. Set the
cooldown to `0` to disable it; set either `max_*` value to `0` for
unbounded.

All checks run *before* the queue append, so rejected orders do not
pollute the queue. The mutating queue append lives in an internal helper
verb and is not direct-callable; public callers enter through `:order`.

## Sequencing

`order_placed`, `delivered`, and `canceled` are emitted via
`observe_to_space(location(this), ...)` — they are sequenced when the
verb is invoked through `$space:call` (the normal command path) and
live when invoked via direct call. In v0.1 the room-level command path
makes `:order` and `:cancel` sequenced; `:deliver` is plug-driven via
direct call, so the `delivered` observation is live. The note arrival
in the requester's inventory is durable regardless; direct requester text
is a live notification and may not survive a reconnect.

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
- A persistent "subscribe to delivery" affordance — the requester gets a
  live text notification and sees the note in inventory; room bystanders
  see the sequenced observation. No additional durable notification API in
  v0.1.

See [`notes/2026-05-05-block-and-plug.md`](../../notes/2026-05-05-block-and-plug.md)
for the full pattern.
