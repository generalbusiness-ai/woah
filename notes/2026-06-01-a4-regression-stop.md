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

## Update (2026-06-01, fifth pass — ROOT CAUSE FOUND; prior plan invalidated)

Ran fresh probes (reverted) on the failing `cf-repository` cross-scope `who` test
at tip `82b4148`. The probes OVERTURN the 3rd/4th-pass conclusions and the handoff
plan. **Everything upstream is correct; the name is lost in the relay MERGE.**

### Measured facts (console.error probes, focused cf-repository test)
1. `v2GatewayAuthorityPayload` is called MANY times for the who turn — NOT 0. The
   4th-pass "0 calls" measurement was simply wrong (probed a stale build/symbol).
   The who turn DOES flow: host.ts `direct(directorySessionScopes=[the_deck])`
   (reads_room_presence) → gateway `v2AuthorityPayload` → DO hook (POD:1536) →
   `v2GatewayAuthorityPayload` → `authorityPayloadFromCachedAuthority` →
   `mcpGatewayDirectorySessionCellSlice`.
2. On Alice's shard (mcp-gateway-2) at the who turn:
   - Directory session for guest_1 (Bob) HAS `displayName:"Guest 1"`, scope the_deck. ✅
   - `mcpGatewayDirectorySessionCellSlice` emits guest_1 lineage with `name:"Guest 1"`. ✅
   - `this.world` has guest_1 as `name:"Guest 1"`, loc the_deck. ✅
   So the directory-stub-name hypothesis (handoff) is FALSE: the slice already
   carries the correct name. The proposed overlay-from-projection fix changes nothing.
3. `mergeV2AuthorityIntoScopeClient` for the_deck relay: `beforeName:"guest_1"`,
   authority carries guest_1 `object_lineage`, `afterName:"guest_1"`. The correct
   lineage page is REFUSED by the merge.
4. The pre-existing relay stub: `{name:"guest_1", parent:"$player", owner:"guest_1",
   location:"the_deck", props:[] then [["home","$nowhere"]]}` — the
   `mcpGatewayStubObject` signature. Note props gap-FILL works (home appears) while
   the lineage cell does NOT — refusal is per-cell on the already-present lineage.

### ROOT CAUSE (confirmed in code)
`mergeAuthorityCellPages` (src/core/authority-slice.ts:385):
```
if (ref.source !== "authoritative" && current) continue;
```
The directory cell slice stamps lineage `source:"projection"` (POD:6497). The relay
already holds a stale `guest_1` stub (`current` present), so the A3.2 refusal blocks
the correct "Guest 1" lineage. The rule "projection MUST NOT override existing" is
treating a stale PROJECTION-sourced stub as if it were authoritative — the planning
world carries no per-cell provenance, so the merge can't tell stub from owner.

Two coupled defects:
(a) UPSTREAM: a `name=id` lineage stub gets seeded into the_deck relay (from an
    earlier directory gap-fill / contents materialization before displayName was
    available), and
(b) the refusal then makes that stub permanently un-repairable by a fresher
    projection lineage carrying the real name.

### Why the 2nd-pass "directory preserve display_name" revert was premature
That fix targets (a)'s symptom but the test still fails because (b) blocks repair
once ANY stub exists. Fixing only one half cannot turn the test green.

### Fix options (architecturally significant — STOPPED for guidance)
- **Opt 1 (narrow, upstream):** never seed a `name=id` lineage stub — ensure the
  first materialization of guest_1@the_deck carries displayName (move
  re-registration must resolve/preserve the actor's real name even on a sparse
  world). If no stub is ever seeded, the refusal never triggers. Needs to confirm
  the exact first-seed moment.
- **Opt 2 (relax refusal / A3.2 retrofit):** track per-cell provenance in the
  planning world so a projection page may overwrite an existing NON-authoritative
  cell (only `authoritative` is immutable-from-projection). Correct long-term;
  this is the explicitly-deferred large retrofit; touches the CI-load-bearing
  merge primitive (blast radius across gateway/REST/browser/checkpoint).
- **Opt 3:** make `mcpGatewayStubObject` emit a lineage whose name, when no
  displayName is known, is marked so a real lineage can replace it — but the
  refusal keys on cell PRESENCE, so this still needs a merge change.

Leaning Opt 1 (keep the merge primitive intact), but the choice depends on whether
the stub's first seed can be made always-correct without the provenance retrofit.

## Update (2026-06-01, sixth pass — FULL causal chain pinned; it's a stale "cache" stub, not a missing seed)

Probed the exact seed origin (all probes reverted, tree clean). The stale name is
NOT a first-seed of a missing cell and NOT from the Directory stub path
(`mcpGatewayShardSerializedWorld` was NEVER called for guest_1 without displayName).
It is a stale **cross-host "cache"** row admitted at relay-open.

### Complete chain (deck-scoped probes)
1. the_deck's OWNER host holds a stale guest_1 stub (name=id). Its
   `/__internal/authority-slice` handler (persistent-object-do.ts:3244) stamps every
   non-owned page `source: world.objectHostKey(ref.object) === hostKey ? "authoritative" : "cache"`
   → guest_1 ships as **`source:"cache"`, name="guest_1"**.
2. Relay open: the who turn's `ensureV2ScopeClient` → `initializeV2ScopeClient`
   (gateway.ts:744) → `v2SerializedWorld([the_deck, guest_2])` (NO directorySessionScopes)
   → `v2GatewayAuthorityPayload(world,[the_deck,guest_2],{})`. Probe at the return:
   `g1Name:"guest_1", g1Source:"cache", localSliceHasG1:false` — guest_1 comes from
   the REMOTE owner slice (gap-fill, not this shard's this.world, which has "Guest 1").
3. `createShadowCommitScope({node:"mcp-v2-relay:the_deck", serialized})` is BORN with
   guest_1 name="guest_1" (confirmed via createShadowCommitScope probe + stack).
4. who-turn prePlan refresh (directorySessionScopes=[the_deck]) builds the directory
   slice with guest_1 `source:"projection"`, name="Guest 1" (correct).
5. `mergeAuthorityCellPages:385` `ref.source(projection)!=="authoritative" && current` →
   REFUSE. Stale "cache" name survives; `who` renders `guest_1`.

Notably: option-(a) `applyProjectionWrites`/`applyMovementProjection` and
`commitShadowCommitScopeState` NEVER fired for the_deck with the bad name — so the
bad row is established purely at the relay-open SEED, by direct serialized
materialization (`serializedWorldFromAuthoritySlice`), not by any post-open apply.

### What this sharpens about the fix (user-approved Opt 2 scoped provenance retrofit)
The precedence rule must order **cache vs projection**, not just projection-vs-projection:
- The relay cell's recorded provenance at seed = **"cache"** (stale cross-host copy).
- The repair page = **"projection"** (live Directory presence assertion, CA12.1).
- Required ranking: authoritative > projection > cache > fallback > gossip/unknown.
  authoritative is never overwritten by non-auth; a non-auth page replaces an
  existing non-auth cell iff rank(incoming) >= rank(current) and hashes differ.
- Provenance must be CAPTURED at BOTH cell-materialization entry points for the relay,
  because `serializedWorldFromAuthoritySlice` drops `AuthorityPageRef.source`:
    (i) `createShadowCommitScope` seed — capture from the slice's page_refs;
    (ii) `mergeAuthorityCellPages` — record from `ref.source`;
   (plus own-scope accepted commits = authoritative; option-(a) applies = their write provenance).
  With both captured, default-unknown can stay conservative (authoritative-protected)
  without re-blocking this bug.

### Task #1 (pin first-seed) — DONE. Proceeding to implement the scoped retrofit (object_lineage + object_live).

## Update (2026-06-01, seventh pass — IMPLEMENTED the provenance retrofit; cross-scope `who` is a 3-LAYER bug)

User approved Opt 2 as a *scoped provenance retrofit*. Implemented it, plus a
Directory hardening fix. typecheck 0; `npm test` 260/260 (no regressions). BUT the
focused `cf-repository` cross-scope `who` test is STILL red — single-run tracing
proved the bug has THREE independent layers; the retrofit fixes layer 1 only.

### Layer 1 — provenance refusal in the planning-world merge (FIXED, on-design)
`mergeAuthorityCellPages` (authority-slice.ts:385) refused a `projection` lineage
from repairing a stale `cache` stub because the planning world carried no per-cell
provenance. Implemented the approved retrofit:
- `MergeSerializedAuthorityOptions.cellProvenance?: Map<cellKey, AuthorityPageProvenance>`
  (optional; omitted callers keep the original CI-safe rule).
- `ShadowCommitScope.cellProvenance` field; rank authoritative>projection>cache>fallback>gossip;
  `authorityPageMayReplaceCurrent` (never non-auth over authoritative; non-auth
  replaces non-auth only at >= rank); unknown current defaults to authoritative
  (protected). Scoped to object_lineage+object_live (`cellProvenanceFromAuthoritySlice` exported).
- Wired the relay merges that own a durable planning cache: gateway
  `mergeV2AuthorityIntoScopeClient` and CommitScopeDO `refreshSessionAuth`.
Verified: when a relay holds a stale `cache` stub and a `projection` "Guest 1"
arrives, the relay now applies "Guest 1" (FIXDBG2). This is correct and necessary.

### Layer 2 — Directory null-overwrite of display_name (FIXED, hardening)
directory-do.ts `registerSession` did `INSERT OR REPLACE` with the incoming
`display_name`, so a re-registration resolved on a SPARSE shard (null) erased a
good name. Now preserves an existing non-null name across a null update
(`effectiveDisplayName`). Confirmed Directory ends with guest_1 "Guest 1"@the_deck.
(Necessary correctness fix; insufficient alone.)

### Layer 3 — authority-COMBINE picks the stale-named page (NOT YET FIXED; the live blocker)
Decisive single-run trace (probes reverted):
- Directory row: "Guest 1"@the_deck ✅. Wire `/sessions-for-scopes`: delivers "Guest 1" ✅.
- `mcpGatewayDirectorySessionCellSlice` emits guest_1 = "Guest 1" (projection) ✅.
- BUT the final `v2GatewayAuthorityPayload` output for the_deck has TWO guest_1
  object_lineage inline pages — `["guest_1","Guest 1"]` — and the WINNING
  `page_ref` (source projection) points to **"guest_1"**. The executor (CommitScopeDO)
  therefore plans against name="guest_1" and `room_roster` (reads `item.name`)
  renders the id.
- `combineSerializedAuthoritySlices` dedups page_refs by key with LAST-slice-wins
  (slice order), keeping all inline pages by hash. A stale-named guest_1 lineage
  page is ordered after the fresh directory "Guest 1" for this cell key, so the
  stale ref wins. The merge-layer provenance rank does NOT apply here — combine is
  ordered, not provenance-ranked.

### Why the retrofit alone can't be green
The VM executes against the CommitScopeDO relay seeded/merged from the COMBINED
authority. If the combined authority's winning guest_1 lineage ref is the stale
"guest_1" page (layer 3), the merge never sees a "Guest 1" page to prefer. Layers
1+2 are real and fixed; layer 3 gates the test.

### Options for layer 3 (decision needed — beyond the approved scoped retrofit)
(a) Make `combineSerializedAuthoritySlices` provenance/quality-aware per cell key
    (prefer authoritative>projection>cache>fallback; among equal, a deterministic
    freshness/tiebreak) instead of pure slice-order last-wins. Unifies with layer 1
    but touches the shared combine primitive (gateway/REST/browser/checkpoint).
(b) Fix slice ORDER so the fresh directory projection is combined after the stale
    cache/remote contribution for actor identity cells (narrower, but order-coupling
    is fragile).
(c) Eliminate the stale `name=id` guest_1 lineage from the assembled authority at
    source (don't admit a `cache`/stub identity page for an actor the directory
    projection already names).

State on worktree (uncommitted): layer-1 retrofit (authority-slice.ts, executor.ts,
shadow-commit-scope.ts, mcp/gateway.ts, worker/commit-scope-do.ts) + layer-2
(directory-do.ts). All probes reverted. Needs a layer-3 decision before the test
can pass; then test:worker + gate:authority + provenance unit tests + spec.

## Update (2026-06-01, eighth pass — RESOLVED; cross-scope `who` green, gates green)

The cf-repository cross-scope `who` test PASSES (63/63). Full fix = the provenance
architecture across all three layers + two plumbing fixes the trace exposed:

1. Layer 1 — `mergeAuthorityCellPages` provenance precedence (cellProvenance on
   ShadowCommitScope; authoritative never displaced; non-auth replaces non-auth by rank).
2. Layer 2 — Directory `registerSession` preserves a non-null `display_name` across
   a sparse-shard null update.
3. Layer 3 — `combineSerializedAuthoritySlices` now resolves per-cell contests by
   provenance RANK (not slice order), with a presentation-stub tiebreak: a named
   lineage page beats an equal-rank `name=id` stub.
4. Seed provenance capture — the CommitScopeDO relay is seeded directly via
   `createShadowBrowserRelayShim` (bypassing the recording merge); `initializeRelay`
   now captures `cellProvenance` from the seed authority slice, so a seeded
   `name=id` cache stub records `cache` (repairable) instead of defaulting to
   protected-authority.
5. Stub-repair clause — in `mergeAuthorityCellPages`, a NAMED `object_lineage` page
   repairs a current `name===id` stub whose recorded provenance is not authoritative
   (covers the unknown-provenance seed case). This is the merge-side form of the
   PlanningWorld admission rule.

Gates: typecheck 0 · `npm test` 267/267 (planning-world.test.ts added to the curated
list) · `tests/worker/cf-repository.test.ts` 63/63 · `npm run test:worker` 202 passed
/5 skipped · `gate:authority` 2/2. Spec CA11 updated with the provenance-precedence +
stub-inadmissibility + seed-capture rules.

Architecture status: P1 (admission gate module + invariant tests) committed; P2's
behavioral core (provenance-ranked combine/merge, seed capture, stub repair) done and
green. Remaining (P3 brand-enforce the VM boundary + miss-is-default escape-hatch
removal; P4 flip `assertPlanningWorldAdmissible` to hard-fail + wire into CI + full
spec/VTN0 alignment) tracked as follow-up tasks — they harden the invariant but are
not required for the regression fix, which is complete and gated.
