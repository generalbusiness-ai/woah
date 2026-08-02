---
name: horoscope
version: 0.4.0
spec_version: v1
license: MIT
description: Workers-AI artifact dispenser built on the Acts-backed Dispenser contract.
keywords:
  - block
  - dispenser
  - horoscope
  - llm
---

# horoscope

`$horoscope_block < $dispenser_block` is the small end-to-end example of an
external producer. A requester orders a sign or topic; the plug calls Workers
AI; a `$dispensed_note` arrives in the requester’s inventory.

The catalog adds only the LLM-facing configuration and presentation. Dispenser
owns the bounded queue, Acts, retry receipts, and delivery transaction.

## Plug flow

The Worker in [`plug/`](plug/) authenticates as the block with an apikey,
briefly caches `system_prompt`, polls `next_pending()`, generates the body,
fills the allocated note, and then delivers its reference:

```text
prepare_artifact(order_id, name, text, description)  # direct
deliver(order_id, note)                              # sequenced
```

`name` is the inventory label, `description` is the cosmetic `look` text, and
`text` is the markdown returned by `read`. Generated prose never enters the
room log. The plug uses a stable delivery idempotency key; Dispenser’s domain
receipt handles later retries.

## Configuration

| Verb | Meaning |
|---|---|
| `set_system_prompt(prompt)` | Set the model persona/instructions. |
| `set_rate_limits(requester_seconds, block_seconds)` | Set cooldowns; zero disables either interval. |
| `set_queue_limits(max_pending, max_chars)` | Lower the hard caps; zero selects 50 rows / 200 characters. |

Only the owner or a wizard may configure the block. The plug uses the
inherited lifecycle recording verbs for attempts, heartbeats, and failures; it
cannot write queue state.

`look_self()` reports the shared durable `plug_status` and the
projection-backed pending count. From a room:

```text
order horoscope scorpio
order horoscope "the launch review"
```

## Provisioning

```text
@create_instance $horoscope_block as the_deck_horoscope location: the_deck
:set_system_prompt("You are a wry fortune-teller. Reply in two short sentences.")
:mint_apikey("horoscope-cf-worker-prod")
```

Store the complete `apikey:<id>:<secret>` value as the Worker’s `WOO_APIKEY`
secret and set `BLOCK_ID` to the instance id. See [DESIGN.md](DESIGN.md) and
the [plug README](plug/README.md).
