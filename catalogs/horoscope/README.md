---
name: horoscope
version: 0.2.0
spec_version: v1
license: MIT
description: Horoscope vending-machine block — a $dispenser_block subclass driven by a small Workers-AI LLM. The plug derives a clean inventory name (`Horoscope: Scorpio`) from the request and delivers it alongside the markdown body.
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
`$horoscope_block` is a fertile template: behavior and owner tools live
on the class, while deployed horoscope machines are ordinary instances.

The plug Worker lives at [`plug/`](plug/). It runs on a short cron
trigger, reads `pending_orders` via the apikey-bound REST surface,
calls Workers AI (`@cf/meta/llama-3.2-1b-instruct`) with
`system_prompt + request`, and calls `:deliver(order_id, name, text,
description)` with a derived listing name (e.g. `"Horoscope: Scorpio"`),
the LLM reply as the note text, and a one-line look-at description so
`look <note>` returns the LambdaCore-style cosmetic flavour while
`read <note>` returns the body.

See [DESIGN.md](DESIGN.md) for design notes.

## Properties

| Name | Tier | Notes |
|---|---|---|
| `system_prompt` | owner | Persona / instructions the LLM runs under. Inherited from `$dispenser_block`. |
| `rate_limit_seconds` | owner | Per-requester order interval. Default 60s. Inherited from `$dispenser_block`. |
| `pending_orders` | self | Queue of pending orders. Plug-managed. |
| `last_pushed_at` | self | Plug heartbeat timestamp. `0` means the machine presents as disconnected. |
| `last_error` | self | Last plug drain error, if any. |

## Owner Tools

`$horoscope_block` exposes narrow configuration verbs on each instance:

| Verb | Notes |
|---|---|
| `set_system_prompt(prompt)` | Sets the LLM persona/instructions. |
| `set_rate_limits(requester_seconds, block_seconds)` | Sets per-requester and block-wide cooldowns. Use `0` to disable either. |
| `set_queue_limits(max_pending_orders, max_request_chars)` | Sets queue length and request-size caps. Use `0` for unbounded. |

Only the block owner or a wizard can use these verbs. The generic
`$block:set_property` / `:set_properties` surface remains hidden from MCP
tools; plug sessions still use it for queue bookkeeping.

## Look Surface

`:look_self()` reports `connected` / `disconnected`, queue count, and a
usage line. From a room command surface, use:

```text
order horoscope scorpio
order horoscope "the launch review"
```

The command returns a ticket immediately and tells the requester the order
was accepted. The generated note appears when the plug next drains the
queue; delivery also sends the requester a text notification.

## Provisioning

```text
@create_instance $horoscope_block as the_deck_horoscope location: the_deck
:set_system_prompt("You are a wry, slightly weary fortune-teller. Reply with two short sentences for the asker's sign or topic.")
:set_property("description", "A horoscope vending machine on the deck. It hums faintly.")
:mint_apikey("horoscope-cf-worker-prod")
# paste secret into wrangler secret put WOO_APIKEY
# wrangler deploy from catalogs/horoscope/plug
```

Validate the minted token before storing it:

```bash
export WOO_BASE_URL="https://woo.example.com"
export WOO_APIKEY="apikey:<id>:<secret>"

curl -fsS "$WOO_BASE_URL/api/auth" \
  -H "content-type: application/json" \
  --data "{\"token\":\"$WOO_APIKEY\"}"
```

The response should include `actor` equal to the horoscope block and
`token_class: "apikey"`. Use the full `apikey:<id>:<secret>` token;
`apikey:<secret>` is not the documented token form.

After deploy, `:order("scorpio")` returns immediately with a ticket;
within ~60s a note arrives in the requester's inventory.
