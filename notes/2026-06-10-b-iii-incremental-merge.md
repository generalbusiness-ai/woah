# B-iii: Incremental Relay Merge

**Date:** 2026-06-10
**Branch:** b-iii-incremental-merge
**Status:** Implemented, all gates green

## Problem

Every authority merge into a relay called `markShadowBrowserRelaySerializedChanged`
unconditionally, even when the merge installed nothing new. That function rebuilds the
commit-scope state index (`createShadowCommitScopeState` — an O(n) walk over all objects
in the serialized world), which was then immediately discarded on no-op warm turns.

Two distinct improvements were needed:

1. **No-op elimination** (mandatory): when a merge installs nothing new (same version
   hashes re-delivered), skip all dirty-marking and index rebuild entirely.

2. **Incremental index update** (target improvement): when a merge DOES change rows,
   update only the changed rows in `objectsById`/`sessionsById` instead of rebuilding
   the full O(n) index via `createShadowCommitScopeState`.

## Investigation Findings

The code already had `if (changed) markShadowBrowserRelaySerializedChanged(relay)` in
the original `mergeAuthorityIntoRelayCache`, so the no-op case was partially handled.
But `mergeSerializedAuthoritySlice` uses a fingerprint-based change check (`stableShadowJson`
comparison of the full before/after content). The key subtlety:

`mergeAuthorityCellPages` replaces `serialized.objects` with a NEW array even when the
CONTENT is unchanged (when there are incoming pages to evaluate, even if they produce the
same result). This new array has different reference identity. When `mergeSerializedAuthoritySlice`
returns `false` (fingerprint identical) but `serialized.objects` was replaced, the
`state.serializedRefs.objects` cached in the commit scope still pointed to the OLD array.
On the next `serializedFor` call, `stateMatchesSerializedRefs` saw this reference mismatch
and triggered an O(n) materialization from the state maps.

The symptom: `serialized_world_materialized scope=guest_1 reason=commit_scope_ensure_session`
during warm movement turns — appearing for the actor's home CommitScopeDO because
`head_session.v1` opens supply no authority slice (so the no-authority path in
`refreshSessionAuth` ran without triggering a full rebuild) while a prior merge had left
stale array refs.

## Implementation

### `src/core/authority-slice.ts`

Added `changedObjectIds?: Set<ObjRef>` and `changedSessionIds?: Set<string>` to
`MergeSerializedAuthorityOptions`. The merge functions populate these when provided:
- `mergeAuthoritySessions`: adds session IDs whose JSON changed
- `mergeAuthorityObjectRows`: adds object IDs for new/changed rows
- `mergeAuthorityCellPages`: adds object IDs from `changedPages` (including new scaffolding)

### `src/core/shadow-commit-scope.ts`

Added `applyAuthorityMergeToCommitScopeState(scope, changedObjectIds, changedSessionIds)`:
an O(k) incremental update (k = changed row count) that:
- Updates counter scalars from the current serialized
- Patches `state.objectsById` for each changed/removed object ID
- Patches `state.sessionsById` for each changed/removed session ID
- Sets `state.serializedRefs = serializedRefs(scope.serialized)` to capture the new array refs
- Clears `scope.serializedDirty`

This function is O(k) where the old `markShadowCommitScopeSerializedChanged` was O(n).

### `src/core/shadow-relay-cache.ts`

Rewrote `mergeAuthorityIntoRelayCache`:

1. **Pre-merge snapshot**: capture `preObjects = serialized.objects` and
   `preSessions = serialized.sessions` BEFORE the merge runs.

2. **ID tracking**: allocate `changedObjectIds`/`changedSessionIds` sets when
   `!alreadyDirty` (dirty scope already has a pending full rebuild; no point tracking).

3. **Changed path** (`changed=true`):
   - `!alreadyDirty`: call `applyAuthorityMergeToCommitScopeState` (O(k)), then
     `invalidateShadowBrowserRelaySerializedCaches` (generation bump + WeakMap evict).
   - `alreadyDirty`: fall through to `markShadowBrowserRelaySerializedChanged` (O(n) full
     rebuild as before — the dirty flag means the state already has pending changes that
     must be fully re-synced from the state maps).

4. **No-op path** (`changed=false`) with ref-replacement fix:
   - `refsReplaced = !alreadyDirty && (serialized.objects !== preObjects || serialized.sessions !== preSessions)`
   - If `refsReplaced`: call `applyAuthorityMergeToCommitScopeState` with empty sets
     to update `serializedRefs` only — O(1), no Map updates. This fixes the
     `stateMatchesSerializedRefs` mismatch without a full rebuild.
   - Either way: return `false` (no generation bump, no dirty-mark, semantics unchanged).

## Root-Cause Bug

The subtlest part: `mergeAuthorityCellPages` replaces `serialized.objects` even when the
net content is unchanged. The fingerprint check in `mergeSerializedAuthoritySlice`
correctly returns `false` for content-identical merges, but the array reference is new.
Without the `refsReplaced` check, this would leave stale refs in `state.serializedRefs`
and trigger a spurious `serialized_world_materialized` on the next `serializedFor` call.

The existing `markShadowBrowserRelaySerializedChanged` (the old code) called
`createShadowCommitScopeState` which always rebuilt refs from scratch — it accidentally
fixed this by brute force. The incremental path must explicitly handle ref-replacement
as a special case.

## Gates

All gates green:
- `npm run typecheck`: clean
- `npm test` (573→582 tests): 582/582 passing (9 new tests in `tests/b-iii-incremental-merge.test.ts`)
- `npm run test:worker` (286 tests): 286/286 passing (structural gate passes with no spurious materializations)
- `npm run smoke:cf-dev` ×2: 13/13 both runs

## Performance Numbers (from benchmark test)

The benchmark measures the ratio of full-rebuild cost vs incremental cost for a 200-object
world, single object updated. Results vary by CI environment:

| Metric | Value |
|---|---|
| World size | 200 objects |
| Full rebuild (markShadowCommitScopeSerializedChanged) | O(200) Map rebuilds |
| Incremental (applyAuthorityMergeToCommitScopeState, 1 changed) | O(1) Map entry |
| Required ratio for test pass | > 3x |
| Warm no-op re-deliveries prevented (per turn) | ~1-3 full rebuilds |

The structural test (`tests/worker/cf-local-structural.test.ts`) enforces zero
`serialized_world_materialized` events during measured warm movement turns — this is
the deployment-quality gate. It passed 6/6 after the ref-replacement fix.
