---
name: dispenser
version: 0.2.3
spec_version: v1
license: MIT
description: Dispenser block base class — a $block subclass that produces $dispensed_note artifacts in response to public :order requests. The plug supplies the note's listing name, markdown text, and optional one-line look-at description via :deliver(order_id, name, text, description).
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

The current v0.2 catalog stores the queue directly. Its next major migration
keeps the same typed plug verbs but makes a `$dispenser_queue` acts
projection the sole writer of pending rows. Plugs use those verbs through
Net; they do not emit raw acts. See the design note for the migration
contract and legacy-genesis gate.

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
| `:order(request)` | public | Checks request size, queue cap, block cooldown, and requester rate limit; appends to `pending_orders`, tells the requester it was accepted, returns `{order_id, queued, text, ts}`, and emits `order_placed`. Net calls are sequenced; legacy direct calls are live. |
| `:deliver(order_id, name, text, description)` | block actor (plug) or wizard | Idempotent. Removes the entry, creates a `$dispensed_note` owned by the block with the supplied `name` (inventory listing label), markdown `text` (what `read` returns, capped at 262144 chars by `$note.set_text`), and optional `description` (the one-line cosmetic look-at flavour; per LambdaCore `$note`, this is what `look` shows — pass null/empty to leave it unset). `name` and `text` are required strings. Moves the note to the requester, tells them it arrived, and emits `delivered`. |
| `:cancel(order_id)` | requester / owner / plug / wizard | Removes the entry, emits `canceled`. The plug (block-actor session, authenticated via apikey) can cancel its own pending orders so a poisoned queue head doesn't block delivery of every following order. |
| `:next_pending()` | block actor (plug) or wizard | Returns the oldest queued entry, or `null`. It mutates nothing and emits no act; the Net plug path still runs it as a sequenced turn, while legacy direct polling is live. |
| `:status(order_id)` | public | Returns `{state: "queued", ts}` or `{state: "unknown"}`. |

## Output: `$dispensed_note`

A `$note` subclass with `produced_by` (the producing block) and
`produced_at` (epoch ms) back-references. The note arrives in the
requester's inventory; a Net-backed delivery records the `delivered`
observation in the room's sequenced turn for bystanders. Connected-client
fanout and the requester's direct text are best-effort.

Dispensed notes are ephemeral: dropping one into a `$space` recycles it
and emits `note_dispersed` ("X drops Y, which disperses in a puff of
smoke."). Hand-offs to other actors or containers move normally.

## Subclassing

Concrete dispensers (e.g. `$horoscope_block`) extend the writable_owner
list with their own knobs and may override `:order` to validate
domain-specific input. The base class handles queueing, flood caps,
delivery, and back-reference plumbing.
