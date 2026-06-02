# 2026-06-02 — localdev↔CF drift convergence (durable turn path, #1)

User-prioritized drift fix. Ordering: (1) durable turn path, (2) fanout topology,
(3) object-host write-through, (4) checkpoint-tail/idempotency/reconnect,
(5) browser projection-holder. Prioritize drift that can HIDE correctness bugs.
Chosen approach for #1: **extract a testable in-process primitive, prove it, then
swap the live dev path and delete the simulation.**

## The drift (confirmed by code map)

localdev REST (`devRestV2Turn`, dev-server.ts:550) and WS (`handleV2ShadowFrame`,
~582) run the **browser-relay in-process path**
(`handleShadowBrowserTurnExecEnvelope` → `executeShadowTurnCallAcrossInProcessNetwork`)
then layer `materializeDevV2CommitLocally` + `sendDevV2Fanout`. They do **not**
call `submitTurnIntent`.

CF REST (`persistent-object-do.ts:restV2Turn`, ~4716) and MCP
(`mcp/gateway.ts:executeV2Call`, ~613) call `submitTurnIntent` (executor.ts:464):
sparse planning on a gateway relay → planning-provenance admission gate
(`enforceMissingProvenance`) → authority repair loop → commit-scope selection →
commit-scope **envelope** → accepted commit → write-through + fanout. The
CommitScopeDO `/v2/envelope` handler (commit-scope-do.ts:379) is itself
`receiveShadowBrowserEnvelopeReceipt` + `handleShadowBrowserTurnExecEnvelope` on a
relay — i.e. **the same browser-relay machinery dev already uses on its commit
side.**

**So the drift is COVERAGE, not result.** Both end at the same authoritative
commit. But dev's relay is seeded **full-world** (`v2RelayForScope`:452,
`world.exportWorld()`), so CF's sparse gateway machinery — repair loop, admission
gate, commit-scope selection, envelope contract — **never fires** in dev. Dev
tests therefore cannot catch sparse-authority / repair-loop / planning-provenance
/ cross-scope-commit bugs, which is exactly the bug class behind prior regressions.

Note: dev ALREADY uses the CF authority-merge contract (`refreshDevV2RelaySessions`
→ `executorAuthorityPayload` + `mergeAuthorityIntoRelayCache` with per-cell
provenance, dev-server.ts:465–487). The missing pieces are only (a) the sparse
seed and (b) the `submitTurnIntent` gateway in front.

## The primitive to build (testable, isolated)

`executeInProcessV2DurableTurn(world, gatewayRelay, commitRelay, call, node, onMetric)`
in a new core/dev module. Mirror the CF `restV2Turn` closures verbatim:

- **ensureClient(scope, attempt)** → the **sparse GATEWAY** relay client
  `{ node, relay: gatewayRelay, nextTurn }`. The gateway relay is seeded sparse
  (bootstrap lineage only, NOT `world.exportWorld()`), so planning hits
  `E_NEED_STATE` and the repair loop fires. Its `commit_scope.head` must be
  SYNCED to the commit relay head at ensureClient (the CF "open" sync:
  `gatewayRelay.commit_scope.head = commitRelay.commit_scope.head`), else the
  `expected`-head check at commit yields stale_head.
- **clientNode / clientHead** = gateway client node / `relay.commit_scope.head`.
- **clientSerialized** = `serializedFor(gatewayRelay.commit_scope, { reason: "dev_turn_plan", metric })`.
- **clientPlanningProvenance** = `gatewayRelay.commit_scope.cellProvenance ?? new Map()`.
- **enforceMissingProvenance: true** + **onAdmissionViolation** = warn (mirror REST).
- **authorityPayload(scope, ids)** = `executorAuthorityPayload(world, ids)` (the
  full-world authority source; this is what the repair loop pulls from).
- **applyAuthority(client, authority)** = `mergeAuthorityIntoRelayCache(client.relay, authority.authority, { preserveSessionActorLive: true, clone: true, reason: "dev_apply_authority" })`
  + `markShadowBrowserRelaySerializedChanged`.
- **submitEnvelope(scope, body)** = the in-process CommitScopeDO equivalent on the
  **authoritative commit relay**: build/get a relay browser, then
  `receiveShadowBrowserEnvelopeReceipt(commitBrowser, body.envelope)` +
  `await handleShadowBrowserTurnExecEnvelope(commitBrowser, receipt, { onMetric })`,
  then return `{ reply: <encoded ShadowEnvelope<ShadowTurnExecReply>> }` shaped so
  `decodeExecutorReply(result.reply)` decodes it. **Plumbing to verify against
  commit-scope-do.ts:404–419:** how `turnReply` is encoded into the
  `CommitScopeEnvelopeResponse.reply` (replyForReceiverProfile/encodeEnvelope) —
  match that exactly so submitTurnIntent's `decodeExecutorReply` round-trips.
- **onMetric** = forward to `world.recordMetric`.

Post-submission (mirror restV2Turn:4825–4829): `local_frame` → return frame; else
write-through (`materializeDevV2CommitLocally` → later the CF-shaped
`applyV2CommittedTranscript`, item #3) + fanout (later CF-shaped affected-scope
routing, item #2), then `restFrameFromTurnReply`.

## Test (the gate, write FIRST)

`tests/dev-v2-durable-turn-parity.test.ts`:
1. Build a world; run a durable turn (e.g. `the_dubspace:set_control`) through the
   primitive with a **sparse** gateway relay.
2. Assert the **repair loop fired** (authorityPayload called ≥1 with non-empty
   ids, or a repair-attempt metric) — proves dev now exercises the sparse path.
3. Assert the commit is accepted and the transcript/post-state equals the
   direct-path result (`runShadowTurnCall` + `submitShadowCommit`) — parity.
4. Assert the admission gate is on (a presentation-stub/missing-provenance case
   raises E_NEED_STATE and is repaired, not silently planned).
5. Negative: a cold gateway with NO authority source fails as missing_state
   (proves sparseness is real, not a hidden full-world seed).

## #1a DONE (commit 1b8f71e): primitive built + tested in isolation.

## Then swap (#1b) — careful, enumerate every branch; NOT rushed

The swap is NOT purely mechanical. Each branch is correctness-sensitive and
`devRestV2Turn`/`handleV2ShadowFrame` have **no direct test coverage** (test:full
does not hit them), so the swap must land with a tested apply-wrapper, not on
test:full alone.

**Add infra:** `v2GatewayRelaysByScope` map + `v2GatewayRelayForScope(scope)`
seeded SPARSE (bootstrap-only), distinct from the authoritative
`v2RelayForScope`. Plus a tested wrapper `executeDevV2DurableTurnFrame`
(= primitive + write-through → frame) so the apply path is unit-tested.

**REST (`devRestV2Turn`) branches:**
- `persistence: "live"` → must NOT go through the committing primitive (CF routes
  live to `restV2TurnInProcess`). Keep a live branch on the existing in-process
  path (no commit).
- durable → `executeDevV2DurableTurnFrame(world, gatewayRelay, commitRelay, call,
  node)`; then fanout via a **commit-relay-bound** origin browser
  (`sendDevV2Fanout(origin, submitted.replyEnvelope)`).
- `submitted.kind === "local_frame"` (planning error) → the old path threw via
  `restFrameFromTurnReply` (!ok); preserve that (throw, REST handler maps to error).
- `submitted` with null reply → throw E_INTERNAL (mirror CF).
- commit_rejected reply → `restFrameFromTurnReply` throws; preserve.

**WS (`handleV2ShadowFrame`) — the SUBTLE one (NOT yet swapped; REST done at 52aefdc).**
The reply sent back over the socket is a `ShadowEnvelope<ShadowTurnExecReply>`
addressed to the WS client: `to: node`, `from: relay`, `auth: { session token }`,
and crucially `reply_to` = the **original WS intent envelope id** (the SPA drains
`pendingNetworkTurns` on it). The primitive's `submitEnvelope` builds its OWN exec
envelope internally and returns a reply addressed to internal nodes with
`reply_to` = that exec envelope — wrong addressing AND wrong reply_to for the WS
client. So the WS swap must **reconstruct** the socket reply from
`submitted.reply` (the body) + WS addressing + the original intent id, not forward
`submitted.replyEnvelope`. Plus the WS path has the state-transfer
(`handleShadowBrowserStateTransferEnvelope`) and cross-scope routing branches to
preserve. **Gate before swapping:** a test asserting the WS-bound reply has
`reply_to === original intent envelope id` and correct addressing (the SPA-drain
contract), since a bug here hangs the live SPA's wait cursor. Until then WS stays
on the existing browser-relay path.

Keep `gate:authority` + `test:full` green throughout. Then items #2 (fanout) and
#3 (write-through) refine the post-commit half toward CF's affected-scope/session
routing and object-host write-through abstraction; #4 reconnect/idempotency;
#5 browser.
