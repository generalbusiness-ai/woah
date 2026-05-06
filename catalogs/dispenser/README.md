---
name: dispenser
version: 0.1.0
spec_version: v1
license: MIT
description: Dispenser block base class — a $block subclass that produces $dispensed_note artifacts in response to public :order requests.
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

### Plug-writable (data)

| Name | Notes |
|---|---|
| `pending_orders` | Authoritative queue. Plug reads via `:next_pending()` and clears via `:deliver()`. |
| `next_order_seq` | Monotonic id counter for `order_id` minting. |
| `last_request_at` | Per-requester timestamp map for rate-limit enforcement. |

## Verbs

| Verb | Caller | Notes |
|---|---|---|
| `:order(request)` | public | Appends to `pending_orders`, returns `{order_id, queued, ts}`, emits `order_placed` (sequenced when invoked through space-call). Rejects with `E_RATE_LIMIT` if the requester ordered within `rate_limit_seconds`. |
| `:deliver(order_id, body)` | block actor (plug) or wizard | Idempotent. Removes the entry, creates a `$dispensed_note`, moves it to the requester. Emits `delivered`. |
| `:cancel(order_id)` | requester / owner / wizard | Removes the entry, emits `canceled`. |
| `:next_pending()` | block actor (plug) or wizard | Returns the oldest queued entry, or `null`. |
| `:status(order_id)` | public | Returns `{state: "queued", ts}` or `{state: "unknown"}`. |

## Output: `$dispensed_note`

A `$note` subclass with `produced_by` (the producing block) and
`produced_at` (epoch ms) back-references. The note arrives in the
requester's inventory; the room sees a sequenced `delivered`
observation describing the event for bystanders.

## Subclassing

Concrete dispensers (e.g. `$horoscope_block`) extend the writable_owner
list with their own knobs and may override `:order` to validate
domain-specific input. The base class handles queueing, rate-limiting,
delivery, and back-reference plumbing.
