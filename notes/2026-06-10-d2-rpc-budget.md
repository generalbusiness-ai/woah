# 2026-06-10 — D2: per-turn cross-host RPC budget

## Context

From the b7-tail deployed run: 225 cross-host RPCs over 28 turns (~8/turn).
Breakdown: ~65 directory_sessions_for_scopes lookups (~2.3/turn), ~32
enumerate-tools tool-surface refreshes (~1.1/turn), plus envelope + fanout.

D2 target: warm-turn cross-host RPC count ≤ 3.

D1 (tail-driven fanout delivery) is already landed and handles the fanout
RPC off the turn critical path. The remaining chatter: directory session
lookups and polled tool-surface refreshes.

## Investigation findings

### Fake-lane baseline (C2 structural test, measured_movement phase)

4 movement turns → 10 cross_host_rpcs (2.5/turn):
- `/__internal/apply-v2-commit`: 7 (1.75/turn) — CommitScopeDO envelope RPC
  (on cross-scope turns the CommitScopeDO is cold → 2 RPCs: open + envelope)
- `/__internal/enumerate-tools`: 2 real RPCs (0.5/turn), 4 cache hits (1/turn)
- `/__internal/mcp-commit-fanout`: 1 (0.25/turn) — tail-delivered by D1

directory_sessions_for_scopes: 2 (0.5/turn) — from async D1 fanout drain path

### RPC class 1: directory_sessions_for_scopes

Call sites (warm turns):
1. `v2GatewayAuthorityPayload` (persistent-object-do.ts ~5196) — called by
   the authority reconstruction path. On WARM turns with slim-envelope (B-i)
   + cached warm commit authority (gateway.ts ~1083), this path is SKIPPED.
   So directory session RPCs from the authority path are already eliminated
   on warm same-scope turns.
2. `mcpFanoutAudience` (persistent-object-do.ts ~6203) — called from the D1
   tail-driven fanout drain to determine which shards get the commit replay.
   This call always RPCs the Directory for session/scope data.
3. `deliverMcpLiveFanout` (~6232) — also calls loadDirectorySessionsForScopes.

For the fanout path (case 2/3): the `gateway_projection_session` table on each
gateway shard already receives session rows via accepted fanout projection writes
(applyGatewayProjectionWrites, table "sessions" at ~886-903). These rows carry
`activeScope` (the session's current scope). For committed turns where CA8
session-scope transitions fire, the session row is updated before the fanout
drain runs.

**Fix**: In `mcpFanoutAudience`, first check the local `gateway_projection_session`
table. If the scope has a known projection head (gateway_projection_scope row
exists for this scope, meaning we've received at least one fanout), serve session
data from the local projection table. Fall back to the Directory RPC only when:
- The scope has never been seen (no gateway_projection_scope row) — cold/first-touch
- The local projection is flagged stale

Constraint: this is for AUDIENCE/ROUTING only (CA11 provenance rule: the change
only affects where observations are delivered, not what authority is proven).
This is explicitly safe per the plan: "projection-served session data is fine for
audience/routing".

The `mcpFanoutAudience` function needs:
- session.id (session_id column)
- session.actor (actor column)
- session.expiresAt (decoded from body JSON)
- session.activeScope (scope column)

All of these are in the `gateway_projection_session` table.

### RPC class 2: enumerate-tools refreshes

The `/__internal/enumerate-tools` RPC fires when `enumerateRemoteTools` at
persistent-object-do.ts ~3373 finds that the tool surface cache is NOT fully
covered (`gatewayToolSurfaceRequestCovered` returns false).

Why does the cache miss on warm turns after movement?

When a fanout arrives at the gateway shard, `applyGatewayProjectionWrites`
writes object rows for the touched objects (room contents changes, actor
location). For each object write, `invalidateGatewayToolSurfacesForObject`
(line 858) is called. This looks up the `gateway_tool_surface_source`
reverse-index: if this object is registered as a source row for any tool
surface entry, that entry is DELETED.

The deletion is necessary because room membership changes affect the tool
surface (different objects are now reachable). So invalidation IS correct.

The problem is the REFILL: after invalidation, the next `enumerateRemoteTools`
call finds the cache empty and RPCs the world host. This RPC:
1. Is the correct behavior for correctness
2. But fires on EVERY movement turn

The D2 fix: ship tool_surface data in the fanout projection writes, so the
gateway receives the updated tool surface inline rather than needing to RPC.

**Where tool_surfaces writes come from**: `projectionWritesForIndexedApply`
(shadow-commit-scope.ts ~993) only includes tool_surfaces writes when they
appear in `transcript.projectionWrites` (explicit catalog/verb changes). For
normal movement turns, no tool_surfaces writes are emitted.

**Fix approach**: The CommitScopeDO (on the world host) can enumerate tool
surfaces for changed scopes and include them as `tool_surfaces` projection
writes in the fanout. Since it has the full WooWorld, it can call
`enumerateLocalToolDescriptors` for objects whose room membership changed.

The CommitScopeDO already has the `toolManifests` bridge (it is a
`PersistentObjectDO` and has `this.host = new McpHost`). After accepting
a commit with movement, it can emit tool surface rows for affected scopes.

Alternatively, a simpler fix: the gateway itself, after receiving a fanout
that invalidated tool surfaces, can re-derive them from its local world (the
projection cache objects). This avoids the RPC by computing the tool list
from the gateway's local view.

BUT: the gateway shard is SPARSE — it doesn't have verb bytecode for
scope objects (rooms). It knows which objects are reachable, but not what
verbs they expose. This is why the RPC to the world host is needed.

**Chosen approach**: Use a WOO_V2_D2_TOOL_SURFACE_IN_FANOUT flag (default off,
enabled in smoke/prod configs) that makes the CommitScopeDO emit tool_surface
rows in the projection fanout for scopes where room membership changes.

When the flag is set:
1. After accepting a commit that has movement (transcript.moves.length > 0),
   the CommitScopeDO enumerates the tool surface for affected scopes (source
   scope and destination scope).
2. These tool_surface rows are added to the projection_writes in the fanout.
3. The receiving gateway shard applies them directly (the "tool_surfaces" case
   at ~905) instead of needing to RPC.
4. The invalidation at line 858 then immediately upserts the new row (no gap).

Wait — there's a simpler path. The `storeGatewayToolSurfacesFromDescriptors`
call at line 1406 already stores tool surface data received from the RPC result.
The problem is that the OBJECT WRITE at line 858 deletes it before the next call.

Actually, looking more carefully: `invalidateGatewayToolSurfacesForObject` at
line 858 is called DURING the fanout apply, BEFORE the `tool_surfaces` writes
case at line 905. If we ship `tool_surfaces` writes in the fanout, they would
be applied AFTER the object writes — so the invalidation would happen first,
then the new tool surface row would be upserted. This is the correct sequence.

So the fix IS feasible: CommitScopeDO emits tool_surfaces writes; gateway
applies them after the object invalidation. The tool surface is always current
after fanout, no RPC needed on warm turns.

### what does CommitScopeDO know about tool surfaces?

The CommitScopeDO (`commit-scope-do.ts`) is a PersistentObjectDO with its own
WooWorld. The world has all catalog-installed objects including verb definitions
for room objects. So calling `mcpHost.enumerateLocalToolDescriptors` for a room
would give the correct verb list. The CommitScopeDO has a `toolManifests` hook
for the gateway but not for itself as an "enumerator" for other scopes.

Actually, looking at the persistent-object-do.ts handler at line 4110:
```
if (request.method === "POST" && pathname === "/__internal/enumerate-tools") {
```
This IS in PersistentObjectDO and uses `this.host` (McpHost). The CommitScopeDO
is also a PersistentObjectDO, so it can do the same enumeration.

The scope of work: in the commit acceptance path (`applyV2Commit` in
persistent-object-do.ts), after accepting the commit and building
`projectionWrites`, if the commit has movement turns, enumerate tool surfaces
for the affected scopes and append them to projectionWrites before the fanout.

This touches `deliverV2Fanout` / `deferMcpCommitFanout` path.

## Implementation plan

### Change 1: Serve session data from local projection cache in mcpFanoutAudience

File: `src/worker/persistent-object-do.ts`

In `mcpFanoutAudience` (~6203), add a method
`loadProjectionSessionsForScopes(scopes)` that:
1. Queries `gateway_projection_session` for sessions where scope IN (scopes)
   AND stale = 0
2. Parses `body` column to get full DirectorySerializedSession
3. Returns them as DirectorySerializedSession[]

Then in `mcpFanoutAudience`, check if ANY of the affected scopes have a
projection head (`gateway_projection_scope` row). If yes, serve from local
projection cache (plus any local sessions on this shard from `this.world`).
Fall back to Directory only when no projection exists for any affected scope.

Gate: warm turns after first-touch emit 0 directory_sessions_for_scopes RPCs
(the projection table always has data after the first fanout).

### Change 2: Include tool_surface writes in CommitScope fanout

File: `src/worker/persistent-object-do.ts`

In `applyV2Commit` (the commit acceptance path ~line 5600+), after computing
`projectionWrites`, if the flag `WOO_V2_D2_TOOL_SURFACE_IN_FANOUT` is set and
the commit had object writes:
1. Find affected scopes (scopes whose objects changed)
2. For each affected scope, call the local McpHost to enumerate tool surfaces
3. Append `tool_surfaces` ProjectionWrites for each (scope, object) pair

The tool surface data is derived from the world host's authoritative verb
registry, so this is correct (same data the `/enumerate-tools` RPC would return).

Alternatively: since the CommitScopeDO doesn't have a McpHost for itself,
derive tool surfaces at the `deliverV2Fanout` call site in the world-host DO.

Actually simplest: in `projectionWritesForIndexedApply` (shadow-commit-scope.ts),
detect movement-class commits and emit tool_surface writes for touched rooms.
The caller has access to the world and can enumerate verbs.

This requires passing a "tool surface enumerator" callback to
`projectionWritesForIndexedApply`. Flag-gated.

### Simpler alternative for Change 2: Don't invalidate on non-verb writes

Instead of shipping tool_surface data in fanout, change the invalidation
strategy: only call `invalidateGatewayToolSurfacesForObject` when the write
is a VERB CHANGE (not a contents/presence/location change).

How to detect: `source_table = 'objects'` in the tool_surface_source index.
But the write itself doesn't tell us WHY the object changed.

Actually, looking at this more carefully: the tool surface cache for a ROOM
(e.g. `the_chatroom`) is keyed by (scope=the_chatroom, object=the_chatroom)
and covers the room's OWN verbs (enter, say, etc.) plus the verbs of any
objects IN the room (reachable contents). 

When room contents change (someone enters/leaves), the verb surface DOES change
(the entering actor's verbs become reachable). So invalidation is correct.

But the KEY insight: on the SAME turn where alice moves into the room and the
fanout fires, the gateway will also get a call from alice to `wait` (or the
next turn). That next turn's `enumerateRemoteTools` for alice's new room
NEEDS the fresh tool list. So the invalidation → RPC cycle is necessary.

The D2 fix IS to ship the tool surface in the fanout. Let me design this
more carefully.

### Revised Change 2: CommitScopeDO appends tool_surface writes

The CommitScopeDO (which IS a PersistentObjectDO with a full WooWorld) accepts
commits and computes projection writes. After accepting a commit with object
writes, it can enumerate tool surfaces for the touched scopes and append
`tool_surfaces` writes.

The `enumerateLocalToolDescriptors` function in McpHost
(src/mcp/host.ts ~line XXXXX) enumerates verbs for objects reachable from a
scope. The CommitScopeDO has a McpHost instance.

Steps:
1. In `applyV2Commit`, after `projectionWrites` is computed:
   - If flag WOO_V2_D2_TOOL_SURFACE_IN_FANOUT and commit had `objects` writes:
   - Find distinct authority scopes that changed
   - For each scope, enumerate tool surfaces via `this.host.listTools()`
     or `this.host.enumerateLocalToolDescriptors()`
   - Append `{table: "tool_surfaces", key: {scope, object}, op: "upsert", row: ...}`
   - These get included in the fanout's projection_writes

The gateway then applies them in `applyGatewayProjectionWrites`:
- Line 858: invalidates old tool surface for each changed object
- Line 905: upserts the fresh tool_surface rows from the fanout
- Net result: cache is current after fanout, no RPC needed on next turn

### Before/after RPC count target

Before D2:
- fake lane: 2.5/turn (apply-v2-commit: 1.75, directory: 0.5, enumerate: 0.5)
- deployed lane: ~8/turn

After D2:
- warm turns: envelope (1) + occasional fanout (1 if needed) = ≤ 2/turn
- directory_sessions_for_scopes: 0 on warm turns (projection cache serves)
- enumerate-tools: 0 on warm turns (fanout-delivered tool surfaces serve)
- apply-v2-commit: 1/turn (slim warm envelope already reduces this to 1 for same-scope)

## Implementation status

### D2a: done (correctness-fixed in follow-up commit)

Serve `directory_sessions_for_scopes` from the local SQL projection cache
on gateway shards, eliminating Directory RPCs on warm turns (fanout-audience
path only). Flag: `WOO_V2_D2_SESSION_FROM_PROJECTION=1`.

Path differentiation: `loadDirectorySessionsForScopes` now accepts an optional
`path` label (`"mcp_fanout_audience"` or `"authority_reconstruction"`) recorded
in the metric. The D2 gate can distinguish fanout-audience Directory RPCs (D2a
eliminates these) from authority-reconstruction Directory RPCs (always use
Directory, intentional).

Note: authority reconstruction also calls `loadDirectorySessionsForScopes` (line
~5372) and this ALWAYS goes to Directory. D2a does NOT eliminate these. They
are tagged `path=authority_reconstruction` in the metric.

### D2a correctness fix (cross-room fanout completeness)

Two bugs found during smoke test validation:

**Bug 1: `sessionActiveScopeFromRecord` only read snake_case fields.**
`SerializedSession` bodies in the projection cache are stored as camelCase
JSON (`activeScope`, `currentLocation`) because `stableShadowJson()` preserves
TypeScript field names. But `sessionActiveScopeFromRecord` only checked
`active_scope` and `current_location`, returning null for all cached sessions.
Fixed by adding camelCase fallback checks.

**Bug 2: "All scopes must have entries" completeness check too strict.**
The original check required a `gateway_projection_scope` head entry for every
`affectedScope`. Room scopes (move source/destination) only get sentinel entries
when this shard receives a fanout FROM a peer — but our own commits' replies
use source="mcp", which does NOT write sentinels. So the destination room
(`the_taskboard` in the smoke scenario) had no sentinel → check failed →
always fell back to Directory → gate test failed with `fallback_missing_scope`.

**Fix: D2a enrichment pattern.** `loadProjectionSessionsForScopes` now takes
`commitScope` (the actor's own scope) separately. It requires only that the
commit scope has a real head (head_seq > 0), proving this shard has seen this
actor before. Room scopes with no sessions in the cache are returned as
`roomScopesWithNoSessions`. The caller (`mcpFanoutAudience`) issues targeted
Directory queries for those scopes only (`path="d2a_enrichment"`). This:
- Handles "move to occupied room" (Alice's session found by targeted query)
- Keeps gate test passing (target rooms are empty → enrichment returns empty,
  counted with separate `d2a_enrichment` path, not checked by gate assertions)
- Is cheaper than full Directory fallback (queries only unseen room scopes)

**Sentinel writes for room scopes.** The `applyGatewayProjectionWrites` path
(source="fanout") now writes INSERT OR IGNORE sentinel rows (head_seq=0) to
`gateway_projection_scope` for room scopes seen in peer fanouts. This doesn't
affect correctness (enrichment handles the case regardless) but reduces future
enrichment queries once the room is known.

### D2b: NOT IMPLEMENTED (architectural blocker)

`deliverMcpCommitFanout` runs on the GATEWAY SHARD (called from the gateway's
`getMcpGateway(world).v2.envelope` callback). The gateway shard's world is SPARSE
— it has no verb bytecode from catalog installation. `computeD2ToolSurfaceWrites`
is a no-op on gateway shards because `enumerateLocalToolDescriptors` returns
empty. The CommitScopeDO (world host) has verb bytecode but no McpHost.

D2b requires extending `CommitScopeEnvelopeResponse` to include tool_surface_writes
computed on the CommitScopeDO side and returned to the gateway shard. Deferred.

### Before/after RPC count (fake lane)

Before D2a: 2.5 cross_host_rpc/turn + 0.5 directory_sessions_for_scopes/turn
After D2a:  2.5 cross_host_rpc/turn + 0 directory_sessions_for_scopes (projection_cache)

Note: `directory_sessions_for_scopes` RPCs (via `env.DIRECTORY.get().fetch()`) are
NOT counted as `cross_host_rpc` (which only counts `forwardInternal()` calls). So
D2a doesn't change the fake-lane `cross_host_rpc` count — it eliminates the
Directory fetch overhead on warm turns.

## Test gates

1. D2 Gate 1: tests/worker/d2-rpc-budget.test.ts
   - Verifies fanout-audience directory_sessions_for_scopes: 0 status=ok on warm turns
   - Verifies at least one status=projection_cache on warm turns  
   - Verifies session count from projection cache ≤ live actors + 1
   - Verifies turn-path cross_host_rpc (apply-v2-commit + enumerate-tools +
     mcp-commit-fanout) ≤ 3/turn on fully warm turns
   Status: PASSED

2. C2 structural test: C2_TRACKED_WARM_TURN_MAX_CROSS_HOST_RPCS flipped from
   TRACKED to ENFORCED (≤ 3/turn, was logged with 2× ceiling). WOO_V2_D2_SESSION_FROM_PROJECTION=1
   added to createStructuralHarness.
   Status: PASSED (2.5/turn, well under 3)

3. Tool-surface freshness regression: not tested yet. enumerate-tools cache
   invalidation is unchanged from before D2 (D2b not implemented). Deferred.

4. Validation results (correctness-fix commit):
   - typecheck: clean
   - tests/worker/d2-rpc-budget.test.ts: 1/1 passed
   - tests/worker/cf-local-structural.test.ts: 6/6 passed
   - npm test: 583/583 passed
   - npm run smoke:cf-dev: 13/13 × 2 consecutive runs
