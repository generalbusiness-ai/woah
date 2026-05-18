
## Decision - first significant refactoring

Start with a shared v2 turn gateway, before the resident-VM or row-map
rewrites.

This is the right first refactor because dev WS, REST, MCP, Worker, and browser
shim paths already duplicate scope routing, authority refresh, relay lifetime,
retry decisions, transcript application, and fanout shaping. That duplication
has produced real cross-scope/auth drift. Centralizing ingress first gives the
later hot execution and row-index work one path to optimize instead of several
nearly-equivalent paths to keep in sync.

Initial boundary:

- Add a transport-neutral `submitTurnIntent(...)` gateway surface with
  host-provided hooks for relay/client lookup, authority export, envelope
  submission, local transcript application, and fanout delivery.
- The gateway owns scope/target routing, authority-slice construction,
  open/refresh behavior, live vs durable dispatch, retry on missing state or
  stale heads, reply decoding, and frame shaping.
- Adapters keep only transport concerns: parsing the incoming request/frame,
  authenticating or carrying the token/session, and sending the final transport
  response.
- Preserve current execution semantics first. Existing `runShadowTurnCall`,
  serialized snapshots, and CommitScopeDO envelope handling remain underneath
  this gateway until ingress behavior is single-sourced.

First implementation slice:

1. Extract shared authority payload construction, relay repair/retry
   classification, and successful reply-to-frame conversion.
2. Move REST durable/live and MCP intent submission onto that shared code.
3. Move dev WS/dev REST and Worker WS through the same gateway hook surface.

Primary verification targets:

- `tests/dev-v2-cross-scope-routing.test.ts`
- `tests/v2-mcp-e2e.test.ts`
- Worker REST v2 cases in `tests/worker/cf-repository.test.ts`
- `tests/worker/v2-cost-budget.test.ts`

Implemented in this worktree:

- Added `src/core/v2-turn-gateway.ts` as the shared substrate module for v2
  ingress mechanics: authority payload export, serialized authority merge,
  explicit turn-row planning, retry classification, retry envelope ids, intent
  and exec envelope construction, reply decoding, and the `submitTurnIntent`
  retry loop.
- Moved Worker REST live and durable turn submission onto `submitTurnIntent`.
  Durable REST still plans locally before posting to the authoritative commit
  scope, preserving cross-scope commit routing.
- Moved MCP v2 intent submission onto `submitTurnIntent` while preserving
  CommitScopeDO-side planning and MCP-local accepted-frame caching.
- MCP authority refresh now intentionally includes the actor row with the
  scope and target rows, matching the shared REST/WS authority-id planner.
- Moved dev REST envelope construction and dev WS explicit authority-row
  selection onto the shared helpers. Worker WS still handles pre-built socket
  envelopes in its transport handler, but uses the shared authority payload
  contract for CommitScopeDO posts.
- No resident-world, row-map, or cell-slice semantics were changed in this
  slice.

Second implementation slice:

- Added transcript-only shadow turn execution alongside the existing
  snapshotting runner. Durable planning and commit-scope execution now collect
  frame/recording/transcript without exporting a full executor post-world.
- Kept snapshotting execution for live-persistence session state, no-commit
  fallback, repair/cold-open state transfer, diagnostics, and tests that need a
  serialized post-state.
- Commit scopes still construct authoritative post-state by applying the
  transcript. The concrete win is avoiding a full executor post-world export on
  every durable turn: active demo/catalog scopes already serialize 100+ object
  rows, and that export was the dominant per-turn allocation source before
  commit application. Commit application still rebuilds indexes from serialized
  arrays; the row-map commit-scope work remains the next substrate bottleneck.

Third implementation slice:

- Added an indexed `ShadowCommitScopeState` behind the existing commit-scope
  API. Commit scopes now keep object, session, and log indexes as the
  authoritative in-memory shape while retaining `SerializedWorld` snapshots for
  current transport/cache boundaries.
- Moved authoritative durable commit application, post-state validation,
  touched-state receipt hashes, accepted-frame cache application, MCP
  cross-scope propagation, and Worker row-delta persistence onto the indexed
  state path. Commit validation now reads through the existing object index and
  builds per-object property/version maps lazily for the cells touched by the
  transcript.
- The durable commit-scope hot path no longer reports the old full-array
  `clone_world`, `index_objects`, or `sort_objects` phases for property-write
  commits. It clones only touched object rows and applies session/log updates
  through maps. Sequenced-turn log updates no longer deep-clone the full log
  entry list, but they still copy the scope log array while full serialized
  snapshots are the head-hash boundary; removing that remaining O(N_log) copy
  belongs with lazy full-snapshot/head hashing.
- Compatibility boundary: adapters still read and sometimes mutate
  `commit_scope.serialized`; those mutations now reindex via
  `markShadowBrowserRelaySerializedChanged`. A later resident-scope slice can
  make serialized export lazier once browser/executor cache contracts stop
  requiring immediate full snapshots.

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
