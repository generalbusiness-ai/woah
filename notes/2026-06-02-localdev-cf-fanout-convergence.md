# Localdev ↔ CF fanout convergence (drift item #2)

Goal: localdev browser fanout should make recipient-routing decisions through
the SAME affected-scope / per-peer-scope model the Cloudflare worker uses, so a
fanout-routing bug surfaces locally instead of only in a CF smoke test.

## The drift (correctness-hiding)

CF browser fanout for a COMMITTED turn (`persistent-object-do.ts
sendV2CommitTranscriptFanout`):
1. recompute per-observation audiences authoritatively:
   `world.computeDirectLiveAudiences(commitScope, observations)`.
2. build live events: `shadowLiveEventsForTranscriptRelay(from, transcript)`
   then `withComputedLiveAudience(event, actors[i], sessions[i])` — drops events
   with no addressable recipient.
3. deliver, per local socket `att` (peer identified by `{sessionId, actor,
   scope}`): send every event where `shadowLiveEventMatchesPeerScope(event,
   att)`; AND if `att.scope === commitScope`, also send a projection
   state-transfer (catch-up) for that peer.
   Plus cross-shard reach via the CommitScopeDO-computed `result.fanout` and the
   MCP directory fanout.

Dev browser fanout for a COMMITTED turn (`dev-server.ts sendDevV2Fanout`):
- iterates ONLY `origin.relay.browsers` (the commit-scope relay) and delivers a
  delta-transfer to nodes where
  `relay.subscriptions.get(commit.position.scope).has(node)`.
- sends **no live events at all** for committed turns; recipients are decided by
  a `relay.subscriptions` registry keyed on the commit scope, NOT by each peer's
  bound scope; affected scopes (a move's src/dest rooms) and per-observation
  directed/session audiences are ignored.

Consequence: a committed turn whose observations should reach co-present peers
(e.g. a move's `entered`/`left`, or any durable observation in a room) reaches
the right peers in CF but, in dev, is folded into a state delta to commit-scope
subscribers only — so a peer in the destination room sees nothing as a live
observation. This is the "observation shows up but not in chat" /
"peer-not-seeing-observation" class, invisible locally today.

Dev is a single process with per-scope relays but one global socket set, so its
fanout must be the UNION of CF's per-DO delivery + CF's cross-shard fanout:
iterate ALL connected peers across scopes; a peer's "shard" is its bound scope.

## Convergence: one shared decision primitive

Extract the pure recipient-routing decision into `src/core/v2-fanout-projection.ts`
so BOTH the worker and dev call the identical function (no parallel logic to
drift):

- `buildV2FanoutLiveEvents(from, transcript, audiences)` → `ShadowLiveEvent[]`
  — `shadowLiveEventsForTranscriptRelay` + `withComputedLiveAudience` per index,
  dropping null-audience events. (audiences from `computeDirectLiveAudiences`,
  computed by each host on its own world — async stays host-side.)
- `planV2BrowserFanout({events, commitScope, peers, originNode,
  alreadyDeliveredNodes})` → `{ liveDeliveries: {node, events}[],
  stateTransferNodes: string[] }`. Pure. `peers: {node, sessionId, actor,
  scope}[]`. A peer gets the events matching `shadowLiveEventMatchesPeerScope`;
  a peer with `scope === commitScope` is a state-transfer target. Origin and
  already-delivered nodes are excluded.

Worker `sendV2CommitTranscriptFanout` is refactored to call both (its socket I/O
+ `/v2/state-transfer` fetch stay); behavior-preserving, guarded by
`test:worker` + `gate:authority` + the v2 browser integration test.

Dev `sendDevV2Fanout` (commit path) calls both over ALL connected peers
(new global `v2BrowsersByNode` registry), sends live events per peer, and sends
the in-process delta (`buildShadowBrowserDeltaTransferForBrowser`) to
state-transfer targets. Live-turn path converges on the same per-peer-scope
matching.

## Tests
- unit (parity): `planV2BrowserFanout` + `buildV2FanoutLiveEvents` over
  representative transcripts (same-scope commit; cross-room move with
  entered/left; a directed/private observation; live turn) → exact deliveries.
- dev integration: two sockets in different rooms; a move; assert the
  destination-room peer receives the `entered` live event and the source-room
  peer the `left` — the OLD subscription-of-commit-scope code delivers neither.

Out of scope (later items): #3 object-host write-through, MCP directory fanout
parity, reconnect/checkpoint-tail.

## STATUS — DONE

Landed. The shared decision primitives `buildV2FanoutLiveEvents` +
`planV2BrowserFanout` live in `v2-fanout-projection.ts` (pure, unit-tested in
`v2-fanout-projection.test.ts`). The worker's `sendV2CommitTranscriptFanout`
calls them (behavior-preserving; guarded by test:worker + gate:authority +
v2-browser-worker.integration). Localdev's `sendDevV2Fanout` now delegates the
whole decision to `planDevV2BrowserFanout` (dev-v2-helpers.ts — the testable
composition: computeDirectLiveAudiences + the two shared primitives), iterating
a new global `v2BrowsersByNode` registry so committed turns emit CF-shaped live
events to co-present peers across every affected scope + a projection delta to
commit-scope peers; the old delta-only-to-commit-scope-subscribers path and the
separate `sendDevV2LiveFanout` are gone. `tests/dev-v2-fanout.test.ts` pins the
fix against a REAL world's authoritative presence: a committed cross-room move's
`left`/`entered` reach the source/destination room peers (old path delivered
neither), directed observations stay private, live turns route by peer scope
with no state-transfer. Gates: typecheck (both tsconfigs) · npm test 326/326 ·
gate:authority 2/2 · test:worker 202 · test:full 1431 passed / 5 skipped / 0
failed. No spec change: behavior matches the existing CF reference; this is an
internal refactor that makes localdev share the worker's decision code.

NEXT: #3 localdev object-host write-through through the CF abstraction.
