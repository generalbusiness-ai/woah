# horoscope — design notes

## Concept

The smallest viable demo of the `$dispenser_block` pattern: an
LLM-driven vending machine. It exists to validate the queue → plug →
delivery loop end-to-end with a real generative model and a real CF
Worker, without any horoscope-specific machinery in the substrate.
The class object is a fertile template: behavior and owner tools live on
`$horoscope_block`, while deployed machines are ordinary non-fertile
instances.

## Why this catalog is tiny

Everything about the dispenser pattern lives in `$dispenser_block`:

- `:order` / `:deliver` / `:cancel` / `:next_pending` / `:status`
- the persistent `pending_orders` queue
- the per-requester rate limit
- the `$dispensed_note` output type with back-references
- requester text on accepted orders and delivered notes

`$horoscope_block` only declares "this is the persona-driven LLM
variant" — its only configuration is `system_prompt` (inherited) and
the inherited dispenser limit knobs. Owners and wizards use narrow
configuration verbs (`set_system_prompt`, `set_rate_limits`,
`set_queue_limits`) rather than the raw generic `$block:set_property`
surface. No `tone` property. No `house_style`. No follow-up URL. The
plug picks the prompt-and-request shape, the queue lives on the block,
and the note in your hand is how you know it's done.

## Plug

`catalogs/horoscope/plug/` — a CF Worker that:

1. Authenticates as the block actor via `apikey:` (Worker secret).
2. Polls / wakes via the directed `text` hint emitted by `:order`.
3. Reads the next entry via live/read-only `:next_pending()`; the plug
   caches `system_prompt` briefly so empty cron ticks do not cold-read the
   block host every minute.
4. Calls Workers AI: `@cf/meta/llama-3.2-1b-instruct` with
   `messages: [{role: "system", content: block.system_prompt},
                {role: "user",   content: order.request}]`.
5. Calls `:deliver(order_id, name, text, description)` with the derived listing name (e.g. `"Horoscope: Scorpio"`), the model's reply as the note text, and a short cosmetic look-at description (e.g. `A horoscope reading the machine produced for "scorpio". Try \`read\` to see what it says.`). Per LambdaCore `$note`, the description is what `look` shows; the text is what `read` returns.

Failure modes set `last_error` via `:set_properties` so `:look` surfaces
the trouble. Empty ticks throttle the `last_pushed_at` heartbeat; delivery
and error ticks still write immediately.

## Model choice

`@cf/meta/llama-3.2-1b-instruct` — smallest instruction-tuned text
model on Workers AI (1B params). At ~300–400 output tokens per
horoscope, one order costs roughly $0.0001 — negligible. If output
quality feels under-cooked we can move to `llama-3.2-3b-instruct`
without touching the catalog.

## Out of scope for v0.1

- Streaming output (the plug calls `:deliver` only with the full body).
- Multi-turn conversation (each order is independent).
- Source citations / structured output.
- Charging or quotas (rate limit per requester is the only throttle).

See [`notes/2026-05-05-block-and-plug.md`](../../notes/2026-05-05-block-and-plug.md)
for the broader pattern.
