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

**Three independent bugs are at work. All three need fixing.** Bug C
is the dominant production cause (it explains symptom 4 and contributes
to 1 and 2); A and B remain visible after C is fixed and must land with
it. The order below is investigative, not priority.

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

## Bug B — client: `entered` / `left` chat-presence updates are not space-filtered

`src/client/main.ts` `receiveLiveEvent` (lines 3094–3102).

The space-of-observation filter (`fromCurrentRoom = !observationRoom ||
observationRoom === chatRoom()`) is applied only to `looked`/`who`
(line 3096). `entered` and `left` (3097–3102) unconditionally mutate
`state.chatPresent`:

```ts
if (type === "entered" && ...) state.chatPresent = [...state.chatPresent, actor];
if (type === "left" && ...)    state.chatPresent = state.chatPresent.filter(...);
```

There is also a vocabulary nit that has bitten this filter elsewhere:
observation "space" is **not** consistently named `room`. Movement
events use `room`, but `pinboard_entered`/`pinboard_left` and
`note_added` carry `board`, and many emit `source` instead (or in
addition). The client must normalize before comparing to `chatRoom()`.
The review branch already does this via `chatObservationSpace` at
`src/client/chat-state.ts:8` — looking up `room`, `space`, `board`, `source` in
order. Apply the same helper here.

Concrete failure path: Alice in the_chatroom does `southeast` to leave
for the_deck.
- The turn emits two observations:
  `{type:"left", room:the_chatroom, source:the_chatroom, ...}` and
  `{type:"entered", room:the_deck, source:the_deck, ...}`.
- Both observations are bundled in the delta transcript and delivered
  to Bob (subscribed to the_chatroom). The transcript is not
  per-recipient audience-filtered on the wire (see Bug A note).
- Bob processes them in transcript order:
  - `left`  → remove Alice from `state.chatPresent` ✓
  - `entered` (space = the_deck!) → re-add Alice to `state.chatPresent` ✗
- Bob also gets a misleading "Alice entered." chat line — the line is
  pushed unconditionally by `pushChatLine` at line 3120.

Net effect: presence sidebar still shows Alice after she has left, and
the chat shows "Alice left." immediately followed by "Alice entered."
A later `look` fully refreshes `state.chatPresent` from the room
roster (line 3411 — `result.roster` path), so the sidebar self-heals.

This explains symptoms (1) and (3).

Note: `applyScopedChatObservation` (line 3152) *does* filter via
`room !== state.scopedProjection.here.id` (line 3155, falling back to
`source`), so `state.scopedProjection.here.roster` is correct. The bug
is specifically in the parallel `state.chatPresent` update at
3097–3102 — and it should use the same normalized lookup, not just
`observation.room`.

## Why a stale observation reaches Bob at all

The wire path bundles the entire transcript in the delta transfer
(`buildShadowBrowserDeltaTransfer` →
`v2AppliedFrameFromTranscript` puts `transcript.observations` straight
into `frame.observations`). Per-observation audience is computed
server-side in `world.ts` `observationAudienceActors` (line 7693), but
the WS commit-fanout path discards that and ships the full transcript
to every subscriber of `position.scope`. Client filters per-space.

This is also why MCP commits emit a separate
`deliverMcpCommitFanout` per affected scope (each shard reduces the
observation list to that shard's audience) — the WS path simply does
not have the equivalent reduction. Fixing Bug A and Bug C properly
makes this leak go away on the wire so the client doesn't need to
treat its space filter as a safety net.

## Bug C — worker: CommitScopeDO hibernation drops every browser subscription

**This is the dominant production failure.** It alone explains the
pinboard symptom (4); combined with B it explains (1); combined with
A it explains (2). It must ship; it is not optional.

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

When a Cloudflare DO hibernates and the next message wakes it up:
storage rehydrates, but `relay.browsers` / `relay.subscriptions` are
empty until each browser's WS reconnects through `/v2/open`. Bob's
WebSocket is still open on the gateway DO and his client has no reason
to reconnect, so no fresh `/v2/open` ever arrives.

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
This matches the production report exactly: Alice adds a note, sees it
on *her* board; Bob sees nothing on his.

In-process tests do not catch this — `publishShadowBrowserAcceptedFrame`
(in-process publish path used by `executeShadowBrowserTurn`) reads
the same in-memory `relay.browsers` that was just populated in the
same test by `openShadowBrowserScope`. There is no test that simulates
DO restart between open and envelope.

## Fix shape (all three bugs are required)

These three changes are independent of one another in code but
load-bearing together. Landing only Bug C still leaves Bob with a
broken sidebar after a same-scope leave (Bug B) and silence on the
destination room of a cross-scope move (Bug A).

### Bug C — gateway-owned durable fanout (mandatory)

Naive "filter gateway sockets by `att.scope === scope` and reuse
`buildShadowBrowserDeltaTransfer`" is **too narrow** and reintroduces
the audience leak Bug A flags:
- It covers only the origin scope, repeating Bug A in a different
  layer.
- A naked `buildShadowBrowserDeltaTransfer(...)` ships the full
  transcript (Bug A's audience leak) and produces a transfer signed
  for `recipient = "*"`, not the receiving browser.

The correct shape:

1. Gateway owns durable browser fanout. It already owns the WebSocket
   attachments (the singleton world gateway DO) and is the only place
   that knows which sockets are live right now. CommitScopeDO becomes
   responsible for *producing* recipient-bound transfers; the gateway
   is responsible for *delivering* them.

2. Fan out across **affected scopes**, not just `position.scope`.
   Reuse `affectedMcpFanoutScopes(scope, transcript)` (or hoist it to
   a shared module) so movement, contents writes against
   `session_subscribers`/`subscribers`, and other cross-scope effects
   reach the destination scope's browsers too. This kills Bug A.

3. Compute per-observation audience server-side and ship only the
   observations each recipient is supposed to see. The hook is
   `world.computeDirectLiveAudiences` (`src/core/world.ts:7658`),
   already designed for this. The reduction can live on the
   CommitScopeDO that owns the affected scope (it has authoritative
   subscribers/presence) and is returned to the gateway alongside the
   recipient-bound transfer.

4. CommitScopeDO serves recipient-bound projection transfers. The
   gateway asks each affected scope's CommitScopeDO for "transfer for
   browser X bound to session Y at head H" (instead of constructing
   delta transfers gateway-side). That preserves the proof signature
   (`recipient` argument to `signShadowBrowserStateTransfer`) and the
   per-recipient projection viewer (which controls `viewer.actor` and
   inventory/self in `shadowScopeProjection`).

5. Browser subscriptions remain in-memory only on CommitScopeDO
   (acceptable now that the gateway, which has the real liveness
   signal in `state.getWebSockets()`, drives fanout). Persisting them
   to SQL is a possible alternative path but is harder: it needs a
   close-time RPC from gateway to commit-scope, and risks stale rows
   if the gateway crashes mid-disconnect.

Current PR implementation note: until cross-scope state authorities are
kept current for each affected scope, the gateway must request projection
transfers only for browsers attached to the commit scope. Peer-scope
browsers still receive audience-filtered live events, but not a state
transfer signed by the origin commit scope; otherwise a transfer can have
`transfer.scope` for one room and `to.scope`/`seq` from another.

The result is a single durable-fanout pipeline that simultaneously:
- Fixes Bug C (gateway has the real liveness signal — hibernation of
  CommitScopeDO no longer hides browsers).
- Fixes Bug A (affected-scope fanout reaches both source and dest).
- Removes the wire audience leak that motivates Bug B's safety-net
  filter (per-observation audiences are computed before the wire).

### Bug A — covered by Bug C's fix

The fix shape above subsumes Bug A: affected-scope fanout reaches
peer scopes. Don't ship a separate narrower fix for A; doing so
locks in single-scope routing that the broader fix has to walk back.

### Bug B — normalize observation space

Even with C in place reducing observations per recipient, the client
still drives the chat sidebar from a flat list and should not regress
if a stale observation arrives via any path (REST replay, MCP fanout,
optimistic local apply, future transport additions). Concretely:

- In `src/client/main.ts:3097-3102`, gate the `entered`/`left`
  branches with the same `fromCurrentRoom` test the
  `looked`/`who` branch uses (line 3096).
- Compute `observationRoom` via the normalized helper
  `chatObservationSpace(observation)` — the review branch already
  exposes one at `src/client/chat-state.ts:8` that walks `room` → `space` →
  `board` → `source`. Use that, not `observation.room` alone.
- Apply the same gate when deciding whether to push a chat line for
  `entered`/`left` (line 3120 path) so a remote-room move never
  shows up as "Alice entered." in Bob's the_chatroom feed.
- Audit other observation handlers in `receiveLiveEvent` that key on
  `observation.room` for the same normalization gap.

## Test coverage to add

- Worker test that simulates `CommitScopeDO` hibernation between
  `/v2/open` and `/v2/envelope`. Two browsers in `the_pinboard`; new
  `CommitScopeDO` instance handles Alice's `add_note` envelope; assert
  Bob receives the live `note_added` and a commit-scope state transfer.
  This is the test that would have caught Bug C.
- Worker test for cross-scope move fanout: Alice moves between rooms;
  assert source-room browsers receive `left`, destination-room browsers
  receive `entered`, and peer-scope browsers do not receive a state
  transfer from the origin scope DO. Catches Bug A and the
  transfer-scope/head mismatch.
- Client unit test in `receiveLiveEvent`: given a `left` observation
  for `the_chatroom` followed by an `entered` for `the_deck`, when
  `chatRoom() === the_chatroom`, `state.chatPresent` ends without the
  actor and no "entered" chat line is pushed. Catches Bug B.
