# Horoscope design

Horoscope is intentionally a thin `$dispenser_block` specialization. It proves
the full queue → authenticated external work → artifact path with a real
Cloudflare Worker and model, without adding horoscope knowledge to the
substrate.

The base Dispenser supplies:

- sequenced `order`, `deliver`, and `cancel` operations plus direct,
  one-shot artifact preparation;
- the bounded `$dispenser_queue` Acts projection;
- authorization and dropped-reply receipts;
- `$dispensed_note` creation and delivery; and
- requester notifications.

Horoscope supplies only `system_prompt`, narrow owner configuration verbs, a
health-oriented `look_self`, and the plug.

## External plug

The Worker authenticates as the block actor, then:

1. reads `system_prompt` through a short in-isolate cache;
2. calls `next_pending()` through Net;
3. sends the prompt and bounded request to
   `@cf/meta/llama-3.2-1b-instruct`;
4. derives the note’s listing name and look description;
5. fills the preallocated note through direct `prepare_artifact(...)`; and
6. calls sequenced `deliver(order_id, note)` with a stable key.

This split is an authority boundary, not transport ceremony: generated prose
belongs to the artifact and never appears in the durable room transcript.

Queue state is never exposed as a writable block property. `last_pushed_at` and
`last_error` remain direct plug-writable diagnostics because they describe
external service health, not work coordination.

AI failures produce a bounded fallback note so one poisoned generation cannot
stall the queue. Permanent delivery errors cancel the order; transient errors
leave it pending for the next tick.

Streaming, multi-turn conversation, citations, charging, TTLs, and dead-letter
states are outside this example. They should be added as explicit domain facts
only when a real product policy requires them.
