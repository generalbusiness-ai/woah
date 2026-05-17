
• Best Opportunities

1. Unify all turn ingress behind one v2 “turn gateway” module

Right now dev WS, REST, MCP, Worker, and browser shims each carry pieces of routing, authority slice refresh, relay lifetime, token mapping, fanout, and
retry behavior. That is where the recent cross-scope/auth drift came from.

Create one transport-neutral submitTurnIntent(...) path that owns:

- scope/target routing
- authority-slice construction
- relay/client lookup
- token/session auth refresh
- live vs durable mode
- stale-head retry policy
- fanout/catchup reply shaping

Then dev WS, REST, MCP, and Worker become thin adapters. This retains distributed commit scopes, but removes the duplicated operational logic. Performance
gain comes from fewer full relay refreshes, fewer stale retries, less duplicate serialization, and much less bug-chasing around drift.

Primary refs: src/server/dev-server.ts:470, src/worker/persistent-object-do.ts:2624, src/mcp/gateway.ts:441.

2. Stop treating SerializedWorld as the hot execution representation

The current shadow turn runner imports a full world before execution and exports a full world afterward: src/core/shadow-turn-call.ts:42. That is
architecturally clean for replay, but expensive as the hot path.

Keep SerializedWorld as archive/transfer format. For hot execution, use a resident commit-scope VM/world with:

- transaction/savepoint rollback
- recorder-based transcript extraction
- touched-object dirty tracking
- transcript-based commit application

The strong distributed VM base stays intact: turns still execute against a scope authority and commit by transcript. The simplification is removing full
import/export from every turn. This is likely the biggest performance win: moving from roughly O(world objects + logs) per turn toward O(touched objects +
touched cells).

3. Make row/object indexes primary inside commit scopes

Commit application already tries to avoid trusting executor snapshots and applies transcripts authoritatively, but it still rebuilds maps from serialized
arrays on each apply: src/core/shadow-commit-scope.ts:324. Likewise projections build transient indexes over serialized.objects: src/core/shadow-browser-
node.ts:1245.

A simpler architecture is:

- commit scope owns Map<ObjRef, SerializedObject> as the in-memory primary
- row storage mirrors that shape
- sorted objects[] is only produced for export/debug/backups
- object/session/log indexes are maintained incrementally

This aligns with the row-shaped DO direction and avoids repeated array -> map -> array churn.

4. Turn authority slices into versioned cell patches, not object-row refreshes

exportAuthoritySlice currently exports whole object rows for session actors, active rooms, carried items, and explicit target rows: src/core/
world.ts:6010. That is good enough, but it grows quickly and forces callers to know which rows matter.

A cleaner model:

- caller declares {scope, target, actor, session}
- shared authority planner computes required cells
- payload carries cell versions and only changed cell values
- commit scope merges by cell/version

This preserves distributed authority while shrinking payloads and eliminating duplicated “which extra rows do I include?” logic.

5. Separate projection state from executable state more aggressively

Projection/display paths should not need executable closure state. The spec already distinguishes projection and execution state; lean into that.

For browser/tool UI:

- scope projections are maintained from accepted transcripts and explicit projection manifests
- read-only display uses object summaries/room snapshots/batched describes
- VM execution is only used for actual turns or catalog-defined computed projection hooks

This reduces UI refresh cost and cross-host read fanout while keeping full VM semantics for behavior.

6. Promote transcript/cell delta as the universal internal format

The architecture already wants this: accepted frames must not carry full post-state, and commit scope owns current state (spec/protocol/v2-turn-
network.md:768). Make that rule more pervasive internally:

- turn execution returns transcript + touched cells
- commit applies transcript
- fanout sends accepted frame + projection delta
- caches update from the same delta
- full snapshots only for cold open, repair, backup, and diagnostics

That simplifies both performance and reasoning: fewer formats, fewer trust boundaries.

Suggested Order

1. Build the shared transport-neutral turn gateway first. It attacks correctness drift immediately.
2. Move dev WS, REST, and MCP onto it without changing semantics.
3. Replace hot SerializedWorld import/export with resident commit-scope execution.
4. Convert commit-scope internals from serialized arrays to indexed row maps.
5. Shrink authority slices from object rows toward versioned cells.