# A2a: Lineage-closed fanout delivery

Origin: 2026-06-10. Implements plan item A2 from
[2026-06-09-cf-cross-scope-architecture-plan.md](2026-06-09-cf-cross-scope-architecture-plan.md).

## Problem

`propagateTranscriptToOtherScopes` (gateway.ts ~1533 before this change) applied
only the transcript delta to affected destination scopes via
`applyAcceptedFrameToDerivedRelayCache`. The delta included the moved object's
location change but NOT its class lineage (the transitive parent chain).

Result: the destination relay could see the object's live state (location = dest
scope) but parentWalkLookup returned null when resolving any verb, because the
relay lacked the class rows ($note, $portable, $thing, $root). The symptom was
`dangling_parent_ref` metric + `E_VERBNF`/`E_OBJNF` on any sequenced verb
dispatched after a cross-scope move.

Smoke failure #1 (b7-tail run): `the_pinboard:add_note` unreachable on the
gateway shard because the tool surface enumeration found only 7 rows (the shard
lacked the object's catalog-class lineage).

## Fix

Three helpers in `gateway.ts` (~311–470):

1. **`incomingObjectIds(destScope, transcript, originLookup)`**
   Collects objects arriving in `destScope` via `transcript.moves` (including
   the actor's carried inventory, one level deep) and `transcript.creates`.

2. **`transitiveParentIds(startId, objectsById)`**
   Walks the parent chain of `startId` from the origin relay, returning all
   ancestor ids. Cycle-safe.

3. **`mergeIncomingObjectLineageClosure(destScope, transcript, originRelay, destRelay, metric)`**
   For each object incoming to `destScope`, collects all transitive ancestor
   pages that are ABSENT from the destination relay, builds a `cache`-provenance
   cell slice, and merges it into the destination relay before
   `applyAcceptedFrameToDerivedRelayCache`. Idempotent: same hash → skip.
   CA11: a later owner-authoritative row displaces the fill.

Called in `propagateTranscriptToOtherScopes` before the delta frame for each
affected non-origin scope.

## Adjudications

### the_mug: $portable → $note

The C3 carry-across-rooms gate verb is `read`. Verified:
- `read` is defined on `$note` (catalogs/note/manifest.json, verb #4),
  `direct_callable: true`, `persistence: "live"`.
- `$portable` (catalogs/chat/manifest.json) has only `give`. No `read`.
- A `$portable` mug has no `read` verb — C3's claimed "passed with $portable"
  was inaccurate; it tested a different code path.
- Change justified: the mug needs to be `$note` for the gate to exercise the
  correct class chain ($note → $portable → $thing → $root).
- The `$note` schema requires `text` (str, default "") and `writers`
  (list<obj>, default []); both added to the demoworld manifest instance.

### Why the carry step can't drop at the deck

`the_deck:drop ["mug"]` uses `$match:match_object("mug", actor)` which checks
alice's `contents` list in the deck relay's planning snapshot. The mug is IN
alice's inventory (set by the take committed at chatroom scope), but that take
transaction was never propagated to the deck relay (affectedTranscriptScopes
returns [chatroom, alice] for mug.move(chatroom→alice); alice is not a space,
so the deck relay receives no fanout). The drop fails E_INVARG "not carrying mug".

This is a SEPARATE live-state gap (alice.contents propagation) from the lineage
gap A2 fixes. The carry scenario restores via walk west + drop in chatroom
(chatroom relay has accurate alice.contents from the take commit).

### Planning relay vs. commit-side-only delivery

The KEY INSIGHT from predecessors: the carry-step failure involves TWO relays.
The GATEWAY shard's planning relay (held in `v2Scopes.get(scope)`) is
what matters for planning. The mergeIncomingObjectLineageClosure fix is applied
in `propagateTranscriptToOtherScopes`, which runs when the ORIGIN scope's commit
is accepted. This updates the GATEWAY's in-memory relay for the destination scope
(the planning relay), not just the CommitScopeDO's persisted state. This is
sufficient: the gateway uses its in-memory relay snapshot for turn planning.

If the fix were applied only at CommitScopeDO accept time (inside the DO itself),
the gateway's planning relay would remain stale until the next full authority
reseed. Commit-side-only delivery is insufficient.

## Gates flipped

| Gate | Before | After | Evidence |
|------|--------|-------|---------|
| `dangling_parent_ref` in cf-local-structural C2 | ENFORCED (movement only) | ENFORCED (movement + carry) | 5/5 pass |
| `carry-across-rooms` in CF_DEV_TRACKED_FAIL_STEPS | TRACKED → A2 | Removed (ENFORCED) | removed from map |
| `includeTakeDrop` in cf-local-walkthrough | false | true | flip comment |
| `includeCarryAcrossRooms` in cf-local-walkthrough | false | true | flip comment |
| A2 unit tests in npm test | absent | present | package.json |

## Pre-existing walkthrough flake

`cf-local-walkthrough` `move:southeast emits 'left' to bob` fails ~33% of runs
on both main (post-B-i) and this worktree. Root cause: after B6 concurrent moves,
`activeScopeForSession` transiently returns null for bob's session, causing
`routeShadowAcceptedFrame` to not deliver the `left` observation. This predates
A2 and is not introduced by it. The structural test and A2 unit tests are the
reliable gates; the walkthrough's intermittent failure is a known pre-existing issue.

## Files changed

- `src/mcp/gateway.ts`: 3 helpers + call in `propagateTranscriptToOtherScopes`
- `tests/a2-fanout-lineage-closure.test.ts`: 3 tests (integration + 2 unit)
- `package.json`: curated test list
- `catalogs/demoworld/manifest.json`: the_mug $portable→$note + text/writers props
- `tests/v2-browser-local-turn.test.ts`: take mug→lamp (mug now $note, match_names reads text)
- `tests/worker/cf-local-structural.test.ts`: carry phase + dangling gate ENFORCED
- `tests/worker/cf-local-walkthrough.test.ts`: flags ON
- `scripts/smoke-cf-dev.ts`: carry-across-rooms removed from TRACKED_FAIL_STEPS
- `scripts/smoke/scenario.ts`: carry step uses read (A2 gate) + restore via chatroom
- `spec/protocol/cell-authority.md`: CA4 implementation status
