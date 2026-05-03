# Push-mode `observe_to_space` for cross-host audience fanout

## Problem

`WooWorld.observeToSpace(ctx, space, event)` (`src/core/world.ts:2612`) is the
runtime entry for verbs that emit an observation into a *different* space than
the one currently executing the verb. The bundled pinboard demo is the most
visible caller: when a pin is added to `the_pinboard`, the `enterfunc` body
fans out a `pinboard_activity` event to `mount_room` (in production:
`demoworld:the_deck`) so anyone subscribed to the deck sees the activity.

When `space` lives on a different host than the executing verb, the current
implementation does:

```ts
const subscribers = await this.getPropChecked(ctx.progr, space, "subscribers", ctx.hostMemo);
if (Array.isArray(subscribers)) {
  observation._audience_override = subscribers.filter(...);
}
ctx.observe(observation);
```

That is a synchronous cross-host RPC during the verb body. In the production
trace of a single warm `add_note` (commit `38fda29`, version `1937452e`), the
trip cost was ~10ms — the second of two `remote-get-prop` calls in the
critical path of a 580ms verb.

The reason it's an RPC at all: the pinboard host doesn't know who is currently
subscribed to the deck. Subscribers can change at any time (every enter/leave
mutates the list), so caching the value would risk stale fanout.

## Push-mode design

Instead of *pulling* the audience to the originator and broadcasting from
there, *push* the observation to the host that owns the audience and let it
fan out locally:

1. New internal RPC route on `PersistentObjectDO` (worker) and equivalent on
   the local-SQLite/in-memory hosts: `/__internal/remote-observe-to-space`.
   Body: `{ space: ObjRef, event: Observation, originator?: { actor, progr, host } }`.
2. In `observeToSpace`, when `remote = await this.remoteHostForObject(space, ctx.hostMemo)`
   returns a non-local host:
   - Skip the `getPropChecked` fetch.
   - Skip the local `ctx.observe(observation)` branch entirely (no
     `_audience_override`).
   - Send the observation to `remote` via the new RPC.
3. The receiving DO:
   - Verifies `space` is a `$space` instance it actually hosts.
   - Reads its own subscribers list (local property read — free).
   - Builds the same observation payload it would have emitted if the verb
     had run locally, with `_audience_override` set from its local
     subscribers, and pushes it onto its own broadcast queue.
   - Returns ack (or error).

## Trade-offs

**Wins:**

- Eliminates the 10ms cross-host get_prop on every cross-host
  `observe_to_space`. Saves the same per-call cost as a property cache hit
  but with no staleness risk.
- Subscribers list never crosses host boundaries — the audience-owning host
  is the only authority for who is currently subscribed. Conceptually
  cleaner than the pull-then-broadcast model.
- Generalizes: any future cross-host fanout (notifications, audit broadcast,
  etc.) gains the same property automatically.

**Costs:**

- A new internal RPC route to design, document, and test.
- The receiving host needs a way to enqueue an observation without an
  active `CallContext`. Today `ctx.observe` is only callable from inside a
  verb. This needs a small new "observation injection" path on `WooWorld`
  that synthesizes the broadcast envelope on behalf of a remote caller.
- Authority/audit: who is "calling" the broadcast on the receiving host?
  The originator's `progr` should still be honored (the event came from
  *that* code path). Need to plumb originator metadata through the RPC.
- Fire-and-forget vs awaited:
  - **Fire-and-forget** (CF Worker `ctx.waitUntil`): verb doesn't pay the
    RPC cost at all. Observation might be lost on transport failure;
    acceptable for non-essential activity events but not for anything
    that affects sequenced state.
  - **Awaited**: verb pays one RPC (~25ms typical) — same magnitude as the
    current pull, just one round-trip instead of two phases. Still a win
    because the fanout work is local to the audience host, not bottlenecked
    on the originator's storage flush.
  - Pragmatic: start with awaited (simpler, keeps the verb's "I emitted
    this" semantics correct). Move to fire-and-forget for clearly
    non-essential events later, gated by a flag on the call site.

## Why this isn't shipped now

Every piece — new RPC, observation-injection on the receiving side, originator
metadata plumbing, fire-and-forget abstraction — is doable but needs careful
spec/test coverage. The 10ms savings per cross-host `observe_to_space` doesn't
justify rushing it past the property-read cache (`crossHostPropCache` shipped
2026-05-03), which catches a wider class of cross-host calls and is
substantially simpler.

## Order to do this in

1. Wire the RPC route on `PersistentObjectDO` first; smoke-test with a unit
   test that exercises a remote observation.
2. Add the substrate-side injection method on `WooWorld` (e.g.,
   `injectRemoteObservation(space, event, originator)`).
3. Switch `observeToSpace` to use the new path when `remote` is set.
4. Add a vitest case that exercises a multi-host world and confirms the
   audience receives the observation without a `getPropChecked` for
   subscribers.
5. Deploy with `wrangler deploy --dry-run` first; the audience-owning host
   schema is unchanged, so no DO migration needed.
6. Optional follow-up: gate fire-and-forget on a per-call flag and use it
   for the bundled `pinboard_activity` and `dubspace_activity` paths where
   loss-on-transport-failure is acceptable.

## Related files

- `src/core/world.ts:2612` — current `observeToSpace`.
- `src/worker/persistent-object-do.ts:421-440` — current bridge
  `getPropChecked` (with the new property cache).
- `spec/semantics/events.md` — observation contract; would need an addendum
  for cross-host fanout semantics.
- `spec/protocol/hosts.md` — host RPC catalog; new route documented here.
