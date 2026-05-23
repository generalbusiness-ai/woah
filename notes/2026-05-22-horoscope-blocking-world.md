# the_horoscope polling blocks WORLD

Discovered while measuring Lever B's KV-fronted seed cache on prod
deploy `9a9e95c0` (commit `03fa936`).

## Status update (2026-05-23)

The smallest fix described below has landed in code: commit `2e52f05`
made `$block` instances self-hosted by default, and current Worker tests
assert that `the_horoscope` routes to host `the_horoscope` rather than
`world`.

Treat this note as a historical diagnosis until production smoke/tail
confirms the deployed route shape. Confirmation criteria:

- no `do_handler` events on `host_key:"world"` for
  `/api/objects/the_horoscope/calls/*`;
- corresponding horoscope calls appear on `host_key:"the_horoscope"`;
- `scripts/smoke-with-tail.sh` no longer reports horoscope routes as
  the largest WORLD handlers.

If horoscope still appears under WORLD after deploy, the next action is
route repair or deploy verification, not a new cache change. Once
horoscope is gone from WORLD, sort remaining `world` `do_handler`
latencies and fix the next measured blocker.

## What the metrics show

A single smoke run captured 25 `do_handler` events with `ms > 2000`,
clustered around two routes on the `world` host:

```
host=world  route=/api/objects/the_horoscope/calls/set_properties  ms=26434
host=world  route=/api/objects/the_horoscope/calls/next_pending    ms=19459
host=world  route=/api/objects/the_horoscope/calls/set_properties  ms=20738
host=world  route=/api/objects/the_horoscope/calls/next_pending    ms=9423
host=world  route=/api/objects/the_horoscope/calls/set_properties  ms=15784
... (20+ more in the 5-25s range)
```

`the_horoscope` is the polling subject that the weather plug uses:
`next_pending` is a long-poll for work to do; `set_properties`
pushes the result. Both currently dispatch on `world` because
`the_horoscope` is hosted there by default.

## Why it matters

Cloudflare Durable Objects are single-threaded per instance. While
WORLD is inside a 19-second `next_pending` call, every other request
that needs WORLD waits behind it. `next_pending` and `set_properties`
appear interleaved (one starts as another ends) so WORLD is
effectively pinned for tens of seconds at a time.

Concrete impact on the smoke walkthrough: MCP requests that need any
WORLD work (host-seed fallback, apply-v2-commit fanin, actor
allocation, session mint) hit the 20-second MCP POST timeout. The
Lever B KV cache avoids waking WORLD for *cold satellite* seed reads
— so 100% of seed fetches now hit KV at ~100 ms — but the smoke
itself still tries to touch WORLD via apply-v2-commit, and that path
sits behind the horoscope queue.

## Confirmation that KV helped where it could

Before Lever B (commit `b75aaa8`):
  mcp_gateway_snapshot_fetch  avg 1183 ms  max 6647 ms
  host_seed_fetch             avg ~500 ms  max ~3 s

After Lever B (commit `03fa936`):
  mcp_gateway_snapshot_fetch  avg 98 ms    max 351 ms   (100% KV)
  host_seed_fetch             avg 138 ms   max 358 ms   (100% KV)

The seed-delivery paths are ~10x faster. They're no longer the
bottleneck.

## What to do

`the_horoscope` shouldn't be hosted on WORLD. Options ranked by
leverage:

1. **Move polling to its own DO.** Easiest. `the_horoscope` gets
   `host_placement: self`, its own routing, its own execution
   context. WORLD stops being on the polling critical path.

2. **Async queue model.** `next_pending` returns immediately with
   whatever's queued; the plug polls every N seconds instead of
   long-polling. Eliminates the long-blocking call entirely. Bigger
   refactor.

3. **Move plugs entirely off WORLD.** Treat plug coordination as a
   separate concern (a plug-coordinator DO) so the same pattern
   doesn't accumulate on WORLD as new plug subjects appear.

Option 1 is the smallest change with the biggest immediate win:
WORLD goes back to being a thin coordination point for actors and
catalog state, not a polling coordinator.

## Connection to Step 2 (actor DO)

This is also part of why Step 2 (actor hosting off WORLD) was on
the cost-reduction roadmap. The same pattern recurs: WORLD becomes
a synchronization point for any object whose lifecycle requires
coordinated polling or fanin. Decomposing polling subjects onto
their own DOs is structurally similar to decomposing actors.

After fixing horoscope, the next likely bottleneck is whatever the
next-largest blocking call on WORLD is. Same diagnostic: run smoke,
sort `do_handler` events on `world` by `ms`, look at the routes.
