# Live Event Fan-Out Clone Reduction

Origin: 2026-05-20 performance follow-up.

`publishShadowBrowserLiveEvent` previously cloned each live event once for
relay history, then cloned it again for every matching browser cache. That made
event fan-out cost grow with subscriber count even when every cache stored the
same immutable event body.

The publish path now clones once at the trust boundary, recursively freezes that
cache copy, stores it in relay history, and shares the same frozen object with
all matching browser caches. Coalescing still replaces array slots and trimming
still removes old array heads; neither mutates event contents.

Regression coverage:

- a focused shadow-browser-node test publishes one event to three matching
  subscribers, verifies `structuredClone` runs once, verifies relay history and
  every subscriber cache share the same event object, verifies the event and
  nested observation body are frozen, and verifies later mutation of the caller's
  original input does not affect cached state.
- the existing coalesced live-event fan-out test still covers replacement
  semantics and non-advancement of committed state.

No spec change was needed; this is an internal cache representation optimization.
