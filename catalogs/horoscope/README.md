---
name: horoscope
version: 0.1.0
spec_version: v1
license: MIT
description: Horoscope vending-machine block — a $dispenser_block subclass driven by a small Workers-AI LLM.
keywords:
  - block
  - dispenser
  - horoscope
  - llm
  - demo
---

# horoscope

A `$horoscope_block` is a `$dispenser_block` subclass — the demo
artifact-producing block. You `:order` a request (e.g. `"scorpio"`) and
a `$dispensed_note` lands in your inventory carrying a generated
horoscope.

The plug Worker lives at [`plug/`](plug/). It runs on a short cron
trigger, reads `pending_orders` via the apikey-bound REST surface,
calls Workers AI (`@cf/meta/llama-3.2-1b-instruct`) with
`system_prompt + request`, and calls `:deliver(order_id, body)`.

See [DESIGN.md](DESIGN.md) for design notes.

## Properties

| Name | Tier | Notes |
|---|---|---|
| `system_prompt` | owner | Persona / instructions the LLM runs under. Inherited from `$dispenser_block`. |
| `rate_limit_seconds` | owner | Per-requester order interval. Default 60s. Inherited from `$dispenser_block`. |
| `pending_orders` | self | Queue of pending orders. Plug-managed. |
| `last_pushed_at` | self | Plug heartbeat timestamp. `0` means the machine presents as disconnected. |
| `last_error` | self | Last plug drain error, if any. |

## Look Surface

`:look_self()` reports `connected` / `disconnected`, queue count, and a
usage line. From a room command surface, use:

```text
order horoscope scorpio
order horoscope "the launch review"
```

The command returns a ticket immediately; the generated note appears when
the plug next drains the queue.

## Provisioning

```text
@create_instance $horoscope_block as the_deck_horoscope location: the_deck
:set_property("system_prompt", "You are a wry, slightly weary fortune-teller. Reply with two short sentences for the asker's sign or topic.")
:set_property("description", "A horoscope vending machine on the deck. It hums faintly.")
:mint_apikey("horoscope-cf-worker-prod")
# paste secret into wrangler secret put WOO_APIKEY
# wrangler deploy from catalogs/horoscope/plug
```

After deploy, `:order("scorpio")` returns immediately with a ticket;
within ~60s a note arrives in the requester's inventory.
