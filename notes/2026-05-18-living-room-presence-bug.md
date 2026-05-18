# Living-room enter/leave fanout bug — root-cause notes

Investigation 2026-05-18 (worktree: main on /Users/hughpyle/play/woo).

User-visible symptoms

1. Two guests in the_chatroom; one leaves; others not notified (presence
   sidebar still shows the leaver as present).
2. Guest moves back into the_chatroom; nobody is notified at all.
3. Browser's presence list does not refresh until the receiving player
   does another action (e.g. `look`).
4. Same shape in pinboard: two guests in a board, one adds a note, the
   other does not see the new pin.

Two independent bugs combine to produce these symptoms.

## Bug A — server: WS commit fanout is single-scope only

`src/worker/commit-scope-do.ts` `fanoutEnvelopes` (lines 345–377).

For an accepted durable commit, the fanout iterates only browsers
subscribed to `body.commit.position.scope` — the scope the turn was
submitted to (the actor's scope at turn start).

A `:move` (exit) or `:enter`/`:leave` turn writes effects against TWO
scopes — the source room and the destination room — but the commit's
`position.scope` is only one of them. Browsers in the *other* scope are
on a different `CommitScopeDO` and are never iterated by this fanout,
so they get no delta envelope at all.

The MCP path already has this concept right:
`affectedMcpFanoutScopes(scope, transcript)` in
`src/worker/persistent-object-do.ts:3660` adds `move.from` and `move.to`
to the scope set. The WS browser fanout has no equivalent — the
`relay.subscriptions.get(body.commit.position.scope)?.has(browser.node)`
gate at line 356 is single-scope by construction.

Concrete failure path: Alice in the_deck does `west` to re-enter
the_chatroom.
- Turn submitted to the_deck (Alice's scope at start of turn).
- Commit accepted at the_deck. `position.scope = the_deck`.
- the_deck's CommitScopeDO fanout iterates *its* browsers (only Alice).
- Bob is attached to the_chatroom's CommitScopeDO — never iterated.
- Bob receives nothing — no `entered`, no roster change.

This explains symptom (2) entirely.

## Bug B — client: `entered` / `left` chat-presence updates are not room-filtered

`src/client/main.ts` `receiveLiveEvent` (lines 3094–3102).

The room-of-observation filter (`fromCurrentRoom = !observationRoom ||
observationRoom === chatRoom()`) is applied only to `looked`/`who`
(line 3096). `entered` and `left` (3097–3102) unconditionally mutate
`state.chatPresent`:

```ts
if (type === "entered" && ...) state.chatPresent = [...state.chatPresent, actor];
if (type === "left" && ...)    state.chatPresent = state.chatPresent.filter(...);
```

Concrete failure path: Alice in the_chatroom does `southeast` to leave
for the_deck.
- The turn emits two observations: `{type:"left", room:the_chatroom,...}`
  and `{type:"entered", room:the_deck,...}`.
- Both observations are bundled in the delta transcript and delivered
  to Bob (subscribed to the_chatroom). The transcript is not
  per-recipient audience-filtered on the wire.
- Bob processes them in transcript order:
  - `left`  → remove Alice from `state.chatPresent` ✓
  - `entered` (room = the_deck!) → re-add Alice to `state.chatPresent` ✗
- Bob also gets a misleading "Alice entered." chat line — the line is
  pushed unconditionally by `pushChatLine` at line 3120.

Net effect: presence sidebar still shows Alice after she has left, and
the chat shows "Alice left." immediately followed by "Alice entered."
A later `look` fully refreshes `state.chatPresent` from the room
roster (line 3411 — `result.roster` path), so the sidebar self-heals.

This explains symptoms (1) and (3).

Note: `applyScopedChatObservation` (line 3152) *does* room-filter via
`room !== state.scopedProjection.here.id` (line 3155), so
`state.scopedProjection.here.roster` is correct. The bug is
specifically in the parallel `state.chatPresent` update at 3097–3102.

## Why a stale observation reaches Bob at all

The wire path bundles the entire transcript in the delta transfer
(`buildShadowBrowserDeltaTransfer` →
`v2AppliedFrameFromTranscript` puts `transcript.observations` straight
into `frame.observations`). Per-observation audience is computed
server-side in `world.ts` `observationAudienceActors` (line 7693), but
the WS commit-fanout path discards that and ships the full transcript
to every subscriber of `position.scope`. Client filters per-room.

This is also why MCP commits emit a separate
`deliverMcpCommitFanout` per affected scope (each shard reduces the
observation list to that shard's audience) — the WS path simply does
not have the equivalent reduction.

## Bug C — worker: CommitScopeDO hibernation drops every browser subscription

This is the most impactful bug; it explains both the pinboard symptom
(4) and probably contributes to (1).

`src/worker/commit-scope-do.ts`:
- `relayFor` (line 239) rebuilds the relay from SQL via `loadSnapshot`.
- `loadSnapshot` (line 472) restores meta, accepted frames, transcript
  tail, recently_seen, recent_replies — but it does **not** load
  `relay.browsers` or `relay.subscriptions`. They are created empty by
  `createShadowBrowserRelayShim` (`src/core/shadow-browser-node.ts:420-421`)
  and have no SQL backing.
- `/v2/open` (line 115) is the *only* path that calls
  `openShadowBrowserScope` → `subscribeShadowBrowserNode`, registering
  a browser in `relay.browsers` and `relay.subscriptions`.
- `/v2/envelope` (line 159) builds a transient `browserFor(...)` per
  request via `createShadowBrowserClient` (not `openShadowBrowserScope`)
  — does **not** subscribe.

What happens when a Cloudflare DO hibernates and the next message wakes
it up: storage rehydrates, but the in-memory `relay.browsers` /
`relay.subscriptions` are empty until each browser's WS reconnects
through `/v2/open`. Bob's WebSocket is still open on the gateway DO and
his client has no reason to reconnect, so no fresh `/v2/open` ever
arrives.

`fanoutEnvelopes` (line 354):
```ts
for (const browser of relay.browsers.values()) {   // empty post-hibernation
  if (browser.node === originNode) continue;
  if (relay.subscriptions.get(...)?.has(...) !== true) continue;
  ...
}
```
Empty Map → empty fanout array.

In `deliverV2Fanout` (`persistent-object-do.ts:2956`):
- For **live transcripts** (no commit), `sendV2LiveTranscriptFanout`
  supplements from the gateway DO's own WebSocket attachments by scope
  (line 2974, covered by the test at
  `tests/worker/cf-repository.test.ts:40`). The bug is masked here.
- For **durable commits** (line 2978–2987), there is **no equivalent
  supplement.** The only delivery path is `sendV2Fanout(fanout)` —
  if `fanout` is empty, nothing goes out to WebSocket clients.

So `:add_note`, `:enter`, `:leave`, `:move`, `:set_text`, and every
other sequenced verb silently fails to fan out to other browsers when
the relevant CommitScopeDO has hibernated since the last `/v2/open`.

The originator still sees their own result because the reply envelope
is returned directly to their WS (`persistent-object-do.ts:2693`):
```ts
if (result.reply) ws.send(result.reply);
```
This matches the user's report exactly: Alice adds a note, sees it on
*her* board; Bob sees nothing on his.

For the same-scope living-room case (Bob in the_chatroom while Alice
leaves), the same mechanism applies: if the_chatroom's CommitScopeDO
hibernated between Bob's enter and Alice's leave, Bob gets nothing.
A subsequent `look` makes things appear because (a) `look` is durable
on the same scope and gets a fresh delta from a now-warm DO, and (b)
look's result carries a roster that overwrites `state.chatPresent`.

In-process tests do not catch this — `publishShadowBrowserAcceptedFrame`
(in-process publish path used by `executeShadowBrowserTurn`) reads
the same in-memory `relay.browsers` that was just populated in the
same test by `openShadowBrowserScope`. There is no test that simulates
DO restart between open and envelope.

### Suggested fix shape (Bug C)

Two viable directions:

1. **Persist `relay.browsers` / `relay.subscriptions`.** Add a SQL row
   table keyed by `(node, scope)` written during
   `subscribeShadowBrowserNode` / on `/v2/open`, deleted in
   `webSocketClose` (via a new RPC from gateway to commit-scope), and
   loaded into the Map during `loadSnapshot`. Trade-off: requires a
   close-time RPC and risks stale rows if the gateway crashes.

2. **Supplement durable-commit fanout from gateway sockets, like the
   live path already does.** In `deliverV2Fanout`'s committed branch,
   after `sendV2Fanout(fanout)`, fall back to iterating
   `this.state.getWebSockets()` filtered by `att.scope === scope`
   (minus origin and minus nodes already delivered) and build the
   delta envelope for each missing browser using the same
   `buildShadowBrowserDeltaTransfer` the commit-scope-do uses. Needs
   the gateway to obtain the accepted frame's `serialized` view —
   either by passing it in the `/v2/envelope` response, or by going
   through the CommitScopeDO once more to build per-recipient
   transfers. Trade-off: more cross-DO traffic per turn.

(2) is consistent with the live-path supplement and avoids new
persistence; (1) makes `relay.browsers` durable like the other relay
state and avoids supplement complexity. (2) is probably faster to
land.

## Suggested fixes (separately verifiable)

Server (Bug A):
- In `commit-scope-do.ts`, after a successful commit, also notify
  peer scopes named in `transcript.moves` (and possibly
  `transcript.writes` against `session_subscribers`). Either by
  forwarding the accepted frame to those peers' CommitScopeDOs so
  they can re-fanout to their own browsers, or by gateway-level
  per-scope fanout mirroring `affectedMcpFanoutScopes`. The wire
  payload for each receiving scope should be reduced to that scope's
  observations only (use `world.computeDirectLiveAudiences`).

Client (Bug B):
- Apply the same `fromCurrentRoom` gate to the `entered` / `left`
  branches at `main.ts:3097-3102`. Also gate the chat-line push for
  `entered`/`left` whose `room` is not the current chat room, so
  Bob no longer sees "Alice entered." when Alice entered some other
  room.

Both fixes are needed: A alone leaves the sidebar inconsistent after
a same-scope leave (because of B); B alone leaves the destination
room silent (because of A).
