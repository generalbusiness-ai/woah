---
name: dispenser
version: 1.0.0
spec_version: v1
license: MIT
description: Acts-backed artifact dispenser with a bounded, rebuildable queue projection.
keywords:
  - block
  - dispenser
  - queue
  - artifact
  - acts
---

# dispenser

`$dispenser_block` is the catalog base for asynchronous artifact producers.
A requester orders work, an authenticated external plug performs it, and the
block delivers a `$dispensed_note` to the requester.

Dispenser v1 uses Acts for the durable coordination facts. The block is an
anchored actor composer; its containing room owns the sequenced log; one
`$dispenser_queue` projection owns queue membership, admission indexes,
order-id allocation, and terminal receipts. Plugs call typed domain verbs
through Net and cannot emit or fold Acts directly.

## Domain operations

| Verb | Caller | Result |
|---|---|---|
| `order(request)` | authenticated requester | Validates admission, allocates an empty artifact, records `dispenser.ordered`, and returns a ticket. |
| `next_pending()` | block actor or wizard | Returns the oldest pending request without changing it. |
| `prepare_artifact(order_id, name, text, description)` | block actor or wizard | Direct, one-shot fill of the order’s exact preallocated artifact; retry returns the same reference. |
| `deliver(order_id, note)` | block actor or wizard | Moves that prepared artifact and records only its reference in `dispenser.delivered`. |
| `cancel(order_id)` | requester, owner, block actor, or wizard | Records `dispenser.canceled`. Unauthorized callers receive the same `unknown` answer as an absent id. |
| `status(order_id)` | authenticated caller | Returns queued or terminal state only to the requester and operators; otherwise `unknown`. |

`order`, `deliver`, and `cancel` require a sequenced turn on
`location(block)`. Direct and wrong-room mutations fail.
`prepare_artifact` requires a direct turn: generated prose is an artifact
write, not a room-log message. Order allocation, delivery movement, Acts, and
every fold are fail-closed.

After the first Act, even an operator cannot move the block to another room:
the queue is bound to that room log. A future relocation operation must
transfer both authorities explicitly.

## Bounds

Owner settings may lower, never remove, the catalog ceilings:

| Setting | Default | Hard ceiling |
|---|---:|---:|
| `max_pending_orders` | 50 | 50 rows |
| `max_request_chars` | 200 | 200 characters |
| `rate_limit_seconds` | 60 | `0` disables the requester interval |
| `block_cooldown_seconds` | 5 | `0` disables the block interval |

`0` for either `max_*` selects its hard ceiling; it does not mean unbounded.
The projection also caps requester-rate entries and terminal receipts at 50
each and evicts them deterministically by oldest Act sequence, then key.
Prepared artifact name, description, and body are capped at 256, 4,096, and
262,144 characters respectively.

Pending request text is the work input and remains inline within the 200
character ceiling. `dispenser.ordered` includes the preallocated artifact
reference. Generated prose crosses only `prepare_artifact`; the sequenced
delivery message and Act carry `order_id` plus the note reference.

## Retry contract

If the direct preparation reply is lost, a fresh-key retry returns the same
one-shot artifact. The plug reuses `plug:deliver:<block>:<order>` as the Net
idempotency key for the sequenced transition.
A same-key retry returns the recorded acceptance and commits nothing; the
gateway may omit the application result on that replay. A later fresh-key
retry is resolved by the projection’s bounded receipt and returns the original
note reference with `duplicate: true`. No retry can mint a second artifact
while that receipt is retained.

## Upgrade from v0

`migration-v0-to-v1.json` renames the old direct queue fields to private legacy
inputs. The first sequenced mutation atomically:

1. records the preserved next-order counter as `dispenser.genesis`;
2. allocates an empty artifact and records each pending row in stored order as
   `dispenser.legacy_ordered`;
3. folds the complete v1 projection; and
4. clears the legacy inputs.

Before that mutation, `next_pending` and `status` can still expose legacy work
to its requester or the plug. Rate-limit history deliberately expires at
cutover. A legacy queue above 50 rows or containing a request above 200
characters refuses cutover with `E_QUOTA`; a wizard must repair that private
legacy input before retrying. Nothing is truncated and no projection state is
seeded behind `fold`.

Dropping a `$dispensed_note` into a room recycles it and emits the live
`note_dispersed` observation. Moving it to an actor or container works
normally.

See [DESIGN.md](DESIGN.md) for the authority and migration rationale.
