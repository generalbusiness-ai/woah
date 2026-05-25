# Performance Architecture Status

Updated 2026-05-23.

This note started as the plan for the first major v2 performance
refactor. The first three refactors have now landed, so the note is
updated to separate completed architecture from the next measured work.

## Completed Refactors

### 1. Shared turn submission

The planned "v2 turn gateway" is now the shared `submitTurnIntent(...)`
path in `src/core/executor.ts`.

Transport adapters are thinner than before:

- Worker REST live and durable turn submission go through
  `submitTurnIntent`.
- MCP v2 intent submission goes through `submitTurnIntent`.
- Dev REST and dev WS share authority/envelope helpers from the same
  substrate path.
- Worker WS still accepts pre-built socket envelopes in its transport
  handler, but uses the same authority payload contract for
  CommitScopeDO posts.

This removed the old spread of routing, authority refresh, retry,
reply-decoding, and fanout decisions across REST, MCP, WS, Worker, and
browser-adjacent paths. The current implementation name is
`executor.ts`; older notes may still call the same boundary
`v2-turn-gateway.ts`.

### 2. Transcript-first durable execution

Durable planning and commit-scope execution now collect frame,
recording, and transcript without exporting a full executor post-world
on every durable turn.

Snapshotting execution remains where full serialized state is still the
right boundary:

- live-persistence session state;
- no-commit fallback;
- repair and cold-open state transfer;
- diagnostics;
- tests that intentionally inspect serialized post-state.

Commit scopes still construct authoritative post-state by applying the
transcript. The important win is that normal durable turns stopped doing
full executor-world export as their hot-path result.

### 3. Indexed commit-scope state

`ShadowCommitScopeState` in `src/core/shadow-commit-scope.ts` is now the
authoritative in-memory shape behind the existing commit-scope API.
Commit scopes keep object, session, and log indexes while retaining
`SerializedWorld` snapshots for current transport/cache boundaries.

Moved onto the indexed path:

- authoritative durable commit application;
- post-state validation;
- touched-state receipt hashes;
- accepted-frame cache application;
- MCP cross-scope propagation;
- Worker row-delta persistence.

The durable commit-scope hot path no longer reports the old full-array
`clone_world`, `index_objects`, or `sort_objects` phases for
property-write commits. It clones touched object rows and applies
session/log updates through maps.

Remaining compatibility cost: adapters still read, export, and
occasionally replace `commit_scope.serialized`. Those mutations reindex
through `markShadowBrowserRelaySerializedChanged`. A later resident
scope/lazy-snapshot slice should make serialized export less eager once
browser and executor cache contracts stop requiring immediate full
snapshots.

### 4. Cell authority slices

Authority slices now support `woo.authority_slice.cells.shadow.v1` in
`src/core/authority-slice.ts`, and Worker open/envelope paths exercise
that shape. Legacy object-row slices still exist for compatibility, but
the current direction is versioned cell pages with cell/page hashes
rather than whole object rows as the normal transfer unit.

The authority-slice timeout fallback work also added correlation logging
and omission metrics. Later production traces showed that individual
cross-host RPC timeouts were not the active bottleneck in that probe;
serial cold-start and repeated slice fetches were.

### 5. Projection deltas

Accepted-frame projection transfer now carries
`woo.scope_projection_patch.shadow.v1` patches when the receiver already
has the base projection. Browser cache and Worker paths can update from
accepted transcript/projection deltas instead of requiring a full
projection rebuild for every accepted frame.

### 6. Host seed KV cache

The seed cache path is now content-addressed and bytecode-free in local
main:

- `seed-current:${host}` points to `seed:${host}:${digest}`;
- `mcp-gateway-world-current` points to
  `mcp-gateway-world:${digest}`;
- KV payloads use explicit bytecode-free kinds;
- bytecode is restored from local SQL first, then bundled-catalog
  reservoirs compiled in the same runtime;
- restore drift is visible through `host_seed_kv_restore_miss`;
- one-time per-isolate reservoir build cost is visible through
  `kv_catalog_reservoir_build`.

Authoritative DO responses still carry executable bytecode and remain
the fallback for fresh, edited, non-bundled, or mismatched verbs.

The attempted source-only seed path was rejected. Recompiling arbitrary
seed source synchronously on the cold-load path reproduced the slow
cold-start behavior this cache is meant to remove.

### 7. Host routing pressure off WORLD

Recent work also reduced avoidable WORLD pressure outside the original
three-refactor plan:

- live REST calls can skip CommitScopeDO where the live route is the
  correct execution mode;
- object-call REST routes dispatch to the object's resolved host;
- `$block` now defaults to `host_placement: "self"`, so block instances
  such as `the_horoscope` route to their own host in current code.

Production still needs smoke/tail confirmation after the bytecode-free
KV change and block self-hosting are deployed together. Until that tail
exists, the next bottleneck should be treated as unknown.

## Current Assessment

The original "Best Opportunities" list is mostly implemented:

| Original item | Current status |
|---|---|
| Shared transport-neutral turn gateway | Done as `submitTurnIntent(...)` in `src/core/executor.ts`. |
| Stop full post-world export on hot durable execution | Done for normal durable turns; snapshots remain for cold-open, repair, diagnostics, and live-persistence boundaries. |
| Make row/object indexes primary inside commit scopes | Done inside `ShadowCommitScopeState`; serialized export is still an eager compatibility boundary. |
| Turn authority slices into versioned cell patches | Implemented as cell authority slices; continue only if tail data shows authority fetches remain material. |
| Separate projection state from executable state | Partly done through projection patches and accepted-frame cache updates. Further work depends on measured projection rebuild cost. |
| Promote transcript/cell delta as the internal format | Partly done. Transcript and cell/projection deltas are now common, but full snapshots still exist at cold-open, repair, cache, and hash boundaries. |

The architecture has moved from "remove obvious duplicated hot work" to
"find the largest remaining serialized/cross-host boundary from tail
data and remove that one."

## Next Steps By Priority

### P0 - Confirm the deployed shape with smoke tail

No more performance architecture should be chosen from the old plan until
the current code is measured in production.

After deploy approval, deploy current main, run
`scripts/smoke-with-tail.sh`, and inspect the tail for:

- `the_horoscope` calls no longer running on `host_key:"world"`;
- corresponding horoscope calls running on `host_key:"the_horoscope"`;
- `host_seed_kv_restore_miss` reasons, especially hash or reservoir
  drift;
- `kv_catalog_reservoir_build` frequency and first-hit cost;
- top `world` `do_handler` events by `ms`;
- repeated serial authority-slice reads for the same scope/host during
  one user turn.

The output of that run decides the next implementation target.

### P1 - Fix the largest remaining WORLD blocker

If the next tail still shows long `world` handlers, fix the largest
measured route first. Likely candidates are actor allocation, session
mint, commit fanin, or another polling subject that still routes through
WORLD.

If the shape is actor/session/fanin, resume the actor-hosting work:
actors and their hot session/commit paths should move off WORLD the same
way blocks moved off WORLD. The goal is not merely lower latency; it is
to stop one long request from blocking unrelated world coordination.

### P2 - Make full snapshots lazy or incremental

The remaining broad substrate cost is the `SerializedWorld` compatibility
boundary. Indexed commit scopes removed full array churn from the commit
hot path, but full serialized snapshots still exist for transfer, cache,
diagnostics, and head-hash boundaries.

Next work in this lane:

- identify every remaining per-turn `serializedWorldFromCommitScopeState`
  or equivalent full export;
- separate head/hash materialization from full snapshot materialization;
- avoid copying the full scope log array for sequenced log updates;
- keep full snapshots for cold-open, repair, backup, and diagnostics
  only.

This is the natural continuation of the first three refactors, but it
should wait behind any measured WORLD-blocking route.

### P3 - Coalesce serial authority-slice refetches if they still show up

The current inflight coalescer dedupes concurrent identical reads. It
does not dedupe the pattern where one slice fetch finishes and a later
phase in the same user turn re-fetches the same host/scope immediately.

If smoke/tail still shows repeated serial authority-slice reads for the
same scope, add a short settled-entry TTL to the coalescer or carry a
per-turn authority cache through the submission path. Keep this bounded:
the cache should dedupe one user-turn cascade, not become a long-lived
authority source.

### P4 - Continue projection/executable separation where measured

Projection patches are in place. Further projection work should be
driven by evidence that UI refresh, MCP tool-list refresh, or browser
cache catchup is still rebuilding more executable state than needed.

Possible follow-up:

- explicit projection manifests for common scope summaries;
- read-only describe/room-summary batches that avoid VM execution;
- stricter separation between executable closure state and display state.

### P5 - Revisit class-decomposed KV only if KV size becomes the bottleneck

Bytecode-free content-addressed whole-seed KV is the active seed-cache
shape. Class-decomposed KV remains a plausible storage optimization, but
it should not be the next step unless metrics show KV value size, KV read
latency, or push-refresh size is again a material bottleneck.

The explicit non-goal remains: do not reintroduce source-only cold-load
recompilation as a fallback for missing bytecode.

### P6 - Consolidate canonical JSON helpers

The bytecode hash path added another local canonical JSON helper. Merge
it with the existing canonical JSON logic in `world.ts` and the bootstrap
digest path before this area grows another variant. This is cleanup, not
a performance priority.

## No Longer Next Steps

Do not plan new work for these items as if they were unstarted:

- building the shared turn gateway;
- moving REST and MCP onto the shared turn path;
- adding indexed commit-scope row maps;
- adding cell authority slices;
- adding accepted-frame projection patches;
- making `the_horoscope` self-hosted in code;
- source-only seed payloads.

The next architecture step should be selected from current production
tail evidence, not from this historical backlog.
