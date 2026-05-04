# CF host-boundary smoke

## Context

Recent work reduced ambient Durable Object storage writes and moved more
demo behavior back into woocode. The next risk was whether the Worker entry,
Directory routing, host-scoped Durable Object slices, and deferred host effects
still compose on production-shaped paths.

## What landed

`tests/worker/cf-repository.test.ts` now includes a Worker-routed smoke test
that uses the fake Durable Object SQL/storage harness rather than an in-process
`WooWorld` shortcut. The test exercises:

- `POST /api/auth` through the gateway and Directory session registration.
- `the_chatroom:enter()` and `the_chatroom:southeast()` through object-route
  resolution.
- `the_deck:take("towel")`, `the_hot_tub:enter()`, and
  `the_hot_tub:drop("towel")` across self-hosted room/object boundaries.
- `the_pinboard:enter()`.
- Sequenced pinboard calls with `space: "the_pinboard"`:
  `add_note`, `move_pin`, target-note `set_text`, and direct `list_notes`.

This covers the main first-light cross-host workflow at the Worker/Directory
boundary without requiring external Cloudflare credentials.

## Still not covered

This is not a real Miniflare/workerd or deployed-worker smoke. The fake harness
models `state.storage.sql` and `transactionSync`, but does not exercise
workerd-specific request scheduling, hibernation, or Cloudflare networking
behavior. Keep a live-deploy or Miniflare smoke as a separate operational gate
before treating the production profile as fully validated.
