---
name: dispenser
version: 0.2.1
spec_version: v1
license: MIT
description: Dispenser block base class — a $block subclass that produces $dispensed_note artifacts in response to public :order requests. The plug supplies the note's listing name and markdown text via :deliver(order_id, name, text).
keywords:
  - block
  - dispenser
  - queue
  - artifact
---

# dispenser

A `$dispenser_block` is a `$block` subclass for the case where the plug
*produces a moving artifact* rather than just publishing data. The
canonical example is a vending machine: the requester `:order`s
something, the plug processes it outside woo, and a `$dispensed_note`
arrives in the requester's inventory.

See [DESIGN.md](DESIGN.md) for the queue-and-deliver pattern and
sequencing details.

## Properties

### Owner-writable (configuration)

| Name | Default | Notes |
|---|---|---|
| `system_prompt` | `""` | Persona / configuration handed to the plug. Subclasses may extend the writable_owner list with their own knobs. |
| `rate_limit_seconds` | `60` | Per-requester minimum interval between orders. |
| `block_cooldown_seconds` | `5` | Block-wide minimum interval between any two orders, even from different requesters. |
| `max_pending_orders` | `50` | Queue length cap. `0` means unbounded. |
| `max_request_chars` | `200` | Per-request size cap. `0` means unbounded. |

### Plug-writable (data)

| Name | Notes |
|---|---|
| `pending_orders` | Authoritative queue. Plug reads via `:next_pending()` and clears via `:deliver()`. |
| `next_order_seq` | Monotonic id counter for `order_id` minting. |
| `last_request_at` | Per-requester timestamp map for rate-limit enforcement. |
| `last_order_at` | Block-wide timestamp for cooldown enforcement. |

## Verbs

| Verb | Caller | Notes |
|---|---|---|
| `:order(request)` | public | Checks request size, queue cap, block cooldown, and requester rate limit; appends to `pending_orders`, tells the requester it was accepted, returns `{order_id, queued, text, ts}`, emits `order_placed` (sequenced when invoked through space-call). |
| `:deliver(order_id, name, text)` | block actor (plug) or wizard | Idempotent. Removes the entry, creates a `$dispensed_note` with the supplied `name` (the inventory listing label) and markdown `text`, owned by the block, moves it to the requester, and tells them the note arrived. Emits `delivered`. Both `name` and `text` are required strings; `text` is subject to the 262144-char cap on `$note.text`. |
| `:cancel(order_id)` | requester / owner / wizard | Removes the entry, emits `canceled`. |
| `:next_pending()` | block actor (plug) or wizard | Returns the oldest queued entry, or `null`. |
| `:status(order_id)` | public | Returns `{state: "queued", ts}` or `{state: "unknown"}`. |

## Output: `$dispensed_note`

A `$note` subclass with `produced_by` (the producing block) and
`produced_at` (epoch ms) back-references. The note arrives in the
requester's inventory; the room sees a sequenced `delivered`
observation describing the event for bystanders. The requester also gets
a direct text observation when the note lands.

## Subclassing

Concrete dispensers (e.g. `$horoscope_block`) extend the writable_owner
list with their own knobs and may override `:order` to validate
domain-specific input. The base class handles queueing, flood caps,
delivery, and back-reference plumbing.
