# 2026-06-01 — STOP: A4 introduced a cross-scope `who` regression; A5 not committed

## Status
- Committed on `mobile-heap-a0a1`: A0+A1 (`edd748e`), A2 (`f1abc0b`), A3.1 (`6c532eb`,
  `f5499ab`), A3.2 (`ff285ba`), A4 (`187177f` + cleanup `8f5490f`).
- **A5 is implemented but UNCOMMITTED** (working tree: types.ts, mcp/gateway.ts,
  persistent-object-do.ts, two worker tests). It is clean on its own — see below.

## The regression (A4, not A5)
`tests/worker/cf-repository.test.ts` — "fans accepted cross-scope moves to MCP
shards in the destination room":
- **PASSES 63/63 at A0+A1 tip `edd748e`.**
- **FAILS at A4 tip `8f5490f`** (2 failures incl. this one).
- Fails identically with A5 on top → **A5 is not the cause; A4 is.**

Symptom: after a cross-room move, the destination `the_deck:who` roster returns
the local actor (`guest_1`) with `name === id` (unresolved) instead of its display
name. Assertion at cf-repository.test.ts:3100.

Mechanism: before A4, a stale presence/contents read caused a commit REJECTION;
the rejection→retry did a full authority refresh that *incidentally* materialized
the actor's name row on the sparse destination shard. A4 (correctly) stopped the
projection read from gating the commit — removing that accidental repair and
EXPOSING a genuine gap: the destination shard never actually materializes the
moved-into actor's authoritative name/lineage row. This is CA4 "cold ≠ empty —
repair, don't synthesize": A4 made the read non-blocking (right) but the required
materialization is missing.

## Why it slipped
A4 was gated on `npm test` + `gate:authority`, neither of which includes
`cf-repository.test.ts`. Per AGENTS.md, worker-shape changes require
`npm run test:worker` — it was not run for A4. **A4's "green" was incomplete.**
The worker lane caught it as soon as it ran (during A5 validation).

## Required fix (before A4/A5 can be called done)
On the sparse destination shard, a cross-scope move must MATERIALIZE the
moved actor's authoritative lineage/name cell (CA5 movement commit / VTN10.1
guarded materialization), so `who`/roster name resolution does not depend on the
removed validation-rejection side effect. Then re-validate with `test:worker`
(and gate:authority). Likely lands as part of A4 (its true completion) or a small
A4.1.

## A5 (held, not committed)
A5 deletes the in-memory `authorityCheckpoints` (second apply path + RAM cache of
the projection cache): the catch-up apply (`updateAuthorityCheckpointsFromProjectionWrites`),
hit/store/seed/repair helpers, the field/type/constants, the `warm_checkpoint_*`
metric reasons, the `checkpointHead` option, and the step-2c checkpoint tests.
typecheck 0, npm test 260, gate:authority green — but it sits on the cracked A4,
so it is NOT committed. Re-run `test:worker` after the A4 fix, then commit A5.

## Process correction for the rest of the sequence
Every A/B step that touches the worker/authority/validation path MUST run
`npm run test:worker` (not just `npm test` + `gate:authority`) before commit.
The curated `npm test` list does not cover cf-repository / cross-scope worker shape.

## Update (2026-06-01, second pass)

Applied the user-specified projection-materialization fix and unit-tested it, but
the cf-repository cross-scope regression PERSISTS. Empirical trace found the gap
is one layer deeper than projection emission.

### Done (committed): emit the moved object's authoritative row
`projectionWritesForIndexedApply` (src/core/shadow-commit-scope.ts) now unions
`transcript.moves[].object` into the row-emission set, so an accepted move emits
an `objects` upsert carrying the moved object's REAL authoritative SerializedObject
(name + lineage), not just the touched source/destination contents rows. New unit
test in tests/shadow-commit-scope.test.ts ("emits an authoritative object upsert
for a move-only transcript") proves it: a move-only transcript now yields an
`objects/<mover>/upsert` with `name === "Mover"`. typecheck 0; unit 7/7.

### Still failing — the consumer half is not wired
`cf-repository.test.ts` cross-scope `who` still shows the moved actor with
`name === id`. Root cause, confirmed in code (persistent-object-do.ts:693-696
comment): the gateway projection cache (`gateway_projection_object`) is
WRITE-ONLY for descriptor/catch-up purposes — "Auth and execution still use the
authoritative paths, not these stale-tolerant rows." The gateway TURN world that
`who` executes against is built purely from Directory session STUBS
(`mcpGatewayShardSerializedWorld`, name = `displayName ?? actor`). The moved
actor's Directory session has no display_name on the sparse destination shard
(displayNameForDirectorySession resolves against a world lacking the name), so the
stub renders the raw id. The authoritative row my fix emits lands in a cache that
the `who` turn-world never reads.

### The remaining work (this is the deferred A5 read-through, now load-bearing)
Make the gateway projection-cache object rows a READ-THROUGH into the gateway
turn-world (or into roster/who resolution), so an authoritative row delivered by
fanout overrides the Directory stub. This is exactly the "read-through over the
durable gateway projection cache" A5 deferred — except the cf-repository
regression shows it is not just a latency optimization; it is required for
cross-scope name/lineage correctness. Tried and REVERTED a narrower Directory
display_name-preserve fix (directory-do.ts): it did not resolve the case because
the move re-registers with a null display_name resolved against the sparse
destination world, and the stub path is the reader regardless.

Validate the eventual fix with: focused cf-repository test, npm run test:worker,
gate:authority.

## Update (2026-06-01, third pass — read-through attempt, MEASURED dead-ends)

Attempted the user-directed read-through (gateway projection-cache rows preferred
over Directory stubs in mcpGatewayDirectorySessionCellSlice / v2GatewayAuthorityPayload).
Built it, it typechecks — but PROBES proved it is NOT on the path the cf-repository
`who` exercises, so it does not move the test. REVERTED it (persistent-object-do.ts
back to HEAD) to avoid carrying unvalidated code. The committed producer fix
(9aec612, moved-object row in projection_writes) remains.

### Measured facts (console.log probes, focused cf-repository test)
1. `gatewayProjectionObjectRows` (my read-through reader): **0 calls** during the
   whole test. The read-through I added is never reached.
2. `v2GatewayAuthorityPayload`: **0 calls** during the whole test. So the stale
   actor name does NOT flow through that function in this harness — the user's
   pointer (Directory session slice at ~6480, reached via v2GatewayAuthorityPayload)
   is not the reader for THIS failure.
3. The live `who` turn (persistence:"live", route:"direct") goes
   invokeV2Direct → invokeV2 → submitTurnIntent with prePlanAuthority:true, and
   PLANS against `serializedFor(client.relay.commit_scope)` (gateway.ts:631) — the
   per-scope RELAY world, not `this.world` and not v2GatewayAuthorityPayload.
4. Fanout: `applyRemoteAccepted` (gateway.ts:399-411) applies the accepted frame to
   `client.relay.commit_scope` ONLY when `this.v2Scopes.get(scope)` exists. The
   move's accepted frame is scoped to the MOVER's own scope (bobActor). Alice's
   shard has a relay open for `the_deck` (where she is), NOT for bobActor, so the
   move frame finds no matching relay and never updates the_deck's relay world.
   The unconditional `applyGatewayProjectionWrites` (411) updates `this.world` (so
   `this.world` does get "Guest 1"), but the_deck RELAY world that `who` reads
   does not.

### Therefore the real reader/gap (next focused pass should target exactly this)
The live turn plans against `serializedFor(the_deck relay.commit_scope)`. That
relay world is updated by accepted frames for the_deck's scope, but a cross-scope
MOVE commits under the moved actor's scope, so the destination relay never learns
the moved actor's authoritative row. Fix options to evaluate:
  (a) On fanout, when an accepted frame's projection_writes touch an actor that is
      a member of another OPEN relay's scope on this shard, apply those object rows
      into that relay's commit_scope world too (not just this.world).
  (b) Make `serializedFor(relay.commit_scope)` for the plan overlay this.world's
      fanout-updated rows / the gateway projection cache for member actors
      (read-through at the relay-plan boundary, gateway.ts:631).
Option (a) keeps one writer per relay world; option (b) is a read-through. Either
must keep provenance non-authoritative and not override an owner row. Validate
with the focused cf-repository test FIRST (it does exercise this path), then
test:worker, then gate:authority.

### Status correction
A5 IS committed (2ded457) — earlier note text saying "A5 uncommitted" is stale.

## Update (2026-06-01, fourth pass — option (a) implemented; upstream delivery gap found)

Implemented option (a) per direction: accepted frames now materialize their
row-body-complete projection_writes + movement projection into AFFECTED open relay
caches WITHOUT advancing those relays' heads.
- New `applyAcceptedProjectionToCommitScopeCache(scope, accepted, transcript)` in
  shadow-commit-scope.ts (returns true if it applied authority rows; no head move).
- `McpGateway.propagateTranscriptToOtherScopes` now takes the accepted commit,
  bounds targets to `affectedTranscriptScopes(...)` (move from/to, creates,
  contents/presence), and applies projection rows via the new helper (falling
  back to transcript replay only when the frame carries no authority rows).
- Both callers (applyRemoteAccepted, handleAcceptedReply) pass the accepted commit.
- Kept the existing this.world projection apply; this is the relay-cache companion.

Gates with option (a): typecheck 0, npm test 260, gate:authority green. It breaks
nothing. But it does NOT move the cf-repository cross-scope `who` test, and probes
show why: the propagation never runs for that test.

### Evidence map (console.log probes, focused cf-repository test) — paths ELIMINATED
All of these recorded **0 calls** during the failing `who` test:
1. `gatewayProjectionObjectRows` (3rd-pass read-through) — 0.
2. `v2GatewayAuthorityPayload` — 0. (so the stale name is NOT via the authority
   slice / Directory-session slice path the earlier direction targeted.)
3. `McpGateway.propagateTranscriptToOtherScopes` (option a, gateway relays) — 0.
4. `McpGateway.acceptRemoteV2Commit` — 0.
5. worker `/__internal/mcp-commit-fanout` handler (persistent-object-do.ts:3124) — 0.

### The real upstream gap (next pass starts HERE)
The test's WOO namespace stub (cf-repository.test.ts ~2905) records every
`/__internal/mcp-commit-fanout` request (fanoutHosts/fanoutRequests) AND delegates
to the real `object.fetch`. The test asserts `fanoutHosts` contains aliceShard, so
the move's commit fanout IS sent to Alice's shard. Yet the receiving DO's
`/__internal/mcp-commit-fanout` handler logs 0 calls. So between "fanout request
recorded by the stub" and "handler 3124 executes on the receiver" the request is
not reaching the handler (candidate causes to probe next, in order):
  - internal-auth rejection of the signed fanout request on the receiver,
  - the move commit fanout being sent but the receiver routing it elsewhere
    (different pathname / method), or
  - the assertion's aliceShard fanout being an EARLIER non-move fanout, with the
    move's commit fanout never selecting aliceShard as a target (audience vs
    affected-scope selection in deliverMcpCommitFanout:5353 —
    `audienceShardSet.size > 0 ? [] : mcpShardHostsForScopes(affectedScopes)`:
    when an audience exists it fans out ONLY to audience shards and SKIPS the
    affected room shards; if Alice is not in the move-observation audience, her
    destination-room shard never gets the move commit).
The last bullet is the leading hypothesis: probe deliverMcpCommitFanout's `hosts`
set for the move commit and confirm whether aliceShard is included.

### Decision
Option (a) is correct, on-design, and gate-clean, so it is COMMITTED (flagged)
rather than reverted — it is the consumer half and will be needed once the
upstream delivery reaches the receiver. The cf-repository test remains red pending
the upstream fanout-target/delivery fix. This is the same "necessary but not
sufficient" situation as the producer fix: two correct halves, one upstream
delivery gap still open.
