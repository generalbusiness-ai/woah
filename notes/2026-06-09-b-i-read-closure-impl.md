# B-i read-closure envelopes — implementation note

Origin: 2026-06-09. Plan item B-i.  
Spec: `spec/protocol/v2-turn-network.md §VTN8.3`, `spec/protocol/cell-authority.md §CA14.18`.  
Design brief: `notes/2026-06-09-b-i-read-closure-design.md`.

## What was built

Planned-transcript (cross-scope, movement) commit envelopes previously shipped
the full scope-wide authority slice (~690 KB in the test world, ~1.7 MB p95
deployed). Only the transcript-touched cells are validated, so ~60–70% was
wasted. B-i restricts the envelope authority to the **read closure**:

```
read_closure(turn) =
    pages( actor row
         ∪ submitting-session rows
         ∪ read_set(transcript)            // incl. permission/policy reads
         ∪ write_preimages(transcript) )
  ∪ lineage_closure(objects of those pages)
```

with verb_bytecode pages stripped from lineage-only ancestors (ancestors that
appear in the closure only because they're in the parent chain, not because they
were directly read or written). This reduces envelope size from ~690 KB to
~175–226 KB for a movement turn (21–38% of the full slice, well below 256 KB).

## Files changed

**Core:**
- `src/core/authority-slice.ts`: added `filterAuthorityToReadClosure` — filters
  a cell-slice authority to the closure objects + lineage expansion, stripping
  `verb_bytecode` pages from lineage-only ancestors.
- `src/core/executor.ts`: added `executorTranscriptReadClosureObjectIds` —
  collects write-touched + read-touched + state-probe + writer.progr/definer
  objects from a transcript; used to build closure IDs for planned-transcript
  commits. Updated `closureContext` in `submitTurnIntent` to use this instead
  of just `authorityObjectIds`.

**Gateway:**
- `src/mcp/gateway.ts`: added `closureMcpEnvelopeBody` (exported) — applies
  `filterAuthorityToReadClosure` to planned-transcript envelopes when closure
  mode is active. Added `readClosureEnvelope?: boolean` to `McpV2ClientHooks`.
  `submitEnvelope` branches on `hooks.readClosureEnvelope`.

**Worker:**
- `src/worker/persistent-object-do.ts`: added `WOO_V2_READ_CLOSURE_ENVELOPE`
  to the `Env` type and threaded it as `readClosureEnvelope: envFlag(...)` in
  the hooks setup (next to `slimWarmEnvelope`).

**Config:**
- `wrangler.smoke.toml`: added `WOO_V2_READ_CLOSURE_ENVELOPE = "1"` in the
  smoke lane (not in production wrangler.toml).

**Types:**
- `src/core/types.ts`: extended `mcp_envelope_slim_reseed` metric kind to
  include `mode: "closure"`.

**Tests:**
- `tests/b-i-read-closure-parity.test.ts` (new): corpus parity, absent-cell
  failure path, version gate (stale page not displacing fresher row), repair
  round-trip equivalence, lane parity (flag off/on → same verdict stream +
  final location), byte ceiling (< 256 KB enforced).
- `tests/worker/cf-local-structural.test.ts`: added `WOO_V2_READ_CLOSURE_ENVELOPE`
  to harness env; flipped C2 cross-scope envelope bytes gate from TRACKED → ENFORCED.
- `package.json`: added `tests/b-i-read-closure-parity.test.ts` to the curated
  `npm test` file list.

**Spec:**
- `spec/protocol/v2-turn-network.md §VTN8.3`: status line flipped to
  "implemented, flag-gated"; parity gate section updated to note that
  `post_state_hash` differs between full and closure scopes (different world
  sizes — expected behavior, not a parity violation).
- `spec/protocol/cell-authority.md §CA14.18`: same correction; status note added.

## Key findings during implementation

1. **transcript.reads must be in closure**: `transcriptTouchedObjectIds` only
   collects write-touched objects (writes/creates/moves). The validator also
   checks `transcript.reads[*].cell.object` version consistency, so reads must
   be included. New function `executorTranscriptReadClosureObjectIds` adds these.

2. **writer.progr/definer objects must be in closure**: `validateShadowWriteAuthorityIndex`
   checks `serializedObject(index, writer.progr)` for each write — the program
   object (class/verb definer) must be present. These are not in transcript reads
   or writes directly. Added writer.progr, .definer, .thisObj, .caller to the
   closure ID set.

3. **verb_bytecode stripping for lineage-only ancestors**: Without this, 8
   closure objects produced ~200 pages (~295 KB) due to verb bytecodes for
   ancestor classes ($chatroom, $room, $exit, $wiz, etc.). Lineage-only ancestors
   only need object_live, object_lineage, property_cell pages — the validator
   walks them for property-def resolution, not for verb execution. Stripping
   verb_bytecode from lineage-only ancestors reduces closure to 146–163 pages
   (~175–226 KB, well below 256 KB).

4. **Corpus parity: post_state_hash differs (expected)**: The full scope and
   closure scope start from different world sizes (full has all scope objects,
   closure has only the closure subset). The `post_state_hash` will therefore
   differ even when both accept — this is correct behavior since the CommitScopeDO
   only applies the transcript to the rows it holds. The parity property is
   about the verdict (accept/reject + reason), not the post-state hash.

## Validation results

- `npm run typecheck`: clean
- `npm run test:files -- tests/b-i-read-closure-parity.test.ts`: 6/6 pass
- `npm test`: 552/552 pass (40 test files)
- `npm run test:files -- tests/worker/cf-local-structural.test.ts`: 5/5 pass
  - C2 cross-scope bytes gate: max ~226 KB, target 256 KB, ENFORCED

## What remains (not in scope for B-i)

- Enabling the flag in production wrangler.toml (separate deploy decision).
- Smoke metrics via `smoke:cf-dev --measure` (requires workerd; log reduction
  expected to match the ~60-75% byte reduction seen in the local test).
- Repair path enhancement: currently repair adds `repairObjectIds` to the full
  authority payload; with closure mode active, the repair re-fetches only the
  mismatched cells. The current implementation already threads `repairObjectIds`
  through the closure context, so it naturally picks up the repair cells.

## Stalled-agent diagnosis thread — RESOLVED (2026-06-10)

The prior agent suspected a reference-handling inconsistency between
`mergeAuthoritySessions` and `mergeAuthorityCellPages` vs `stateMatchesSerializedRefs`.
After full investigation, this is the verdict:

### Verdict: REFUTED as a standalone bug

The reference-handling in `mergeAuthoritySessions` is correct: when it replaces
`serialized.sessions` (line 591 of authority-slice.ts), `changed = true`, and
`markShadowBrowserRelaySerializedChanged` is always called, which calls
`markShadowCommitScopeSerializedChanged` → `createShadowCommitScopeState(scope.serialized)`
— this rebuilds `state.serializedRefs` from the CURRENT (newly replaced) arrays.
So the subsequent `ensureSerializedSession` → `serializedFor` finds
`!serializedDirty && stateMatchesSerializedRefs(...)` = true and returns without
materializing.

The competing hypothesis (missing session row → ensure-session rebuild) is also
**REFUTED**: `filterAuthorityToReadClosure` includes the submitting session via
`sessionSet.has(s.id)` (sessions array line 534 of authority-slice.ts), and the
actor's session is also included via `expandedIds.has(s.actor)` since the actor
object appears in the transcript moves. The session row is always present in the
closure.

### Actual root cause

The `serialized_world_materialized reason=commit_scope_ensure_session` events
that appeared in the structural test's measured warm turns were a **downstream
symptom of the A1 session-lifecycle bug** (commit 283d8fd), not a B-i read-closure
bug. The mechanism:

1. Without A1 fix: `markSessionClosed → removeSessionPresence` tried to write-through
   to cached objects the gateway shard did not own (e.g. `the_pinboard` after a
   tool-scope connect). This threw E_OBJNF, aborting `closeMcpWooSession` BEFORE
   the Directory unregister. The session remained in the CommitScopeDO's state.

2. On subsequent warm turns: the stale session's `activeScope` might differ from
   the incoming closure envelope's session row (if the actor had moved). The
   `mergeAuthoritySessions` path detected a JSON difference, replaced
   `serialized.sessions`, called `markShadowBrowserRelaySerializedChanged`, which
   rebuilt the indexed state with `serializedDirty = false`. But there was also
   a residual code path: if `serializedDirty = true` (from a prior accepted commit)
   AND `mergeAuthorityIntoRelayCache` found NO changes (all session/object content
   identical), the dirty flag persisted, causing `ensureSerializedSession →
   serializedFor` to materialize.

3. The C2 test's measured phase showed seq=0 materializations at
   `scope=guest_1` — these were cold-open phase materializations that are EXPECTED
   and are correctly excluded from the warm-turn gate (which only checks metrics
   collected AFTER `logSpy.mockClear()`). No materializations appeared in the
   measured movement metrics once sessions were properly managed.

### Fix

Merging the A1 branch (`a1-session-lifecycle`, commit 283d8fd) into
`b-i-read-closure-impl` (merge commit 02a7283) resolves the issue. The A1 fix
ensures session-close cleanup only mutates objects whose durable home is the
current host, so `closeMcpWooSession` completes successfully and the CommitScopeDO
does not retain stale sessions.

### Runner-discrepancy answer

Before the A1 merge:
- `npm test:files -- cf-local-structural.test.ts`: PASSES (the warm-turn gate
  was not triggered because the C2 test creates two fresh sessions that are
  never closed during the test body; the A1 bug only manifests on the
  DELETE/close path).
- `npm run test:worker`: FAILS — but not the structural test. The failure is
  `cf-local-walkthrough.test.ts` (the A1 DELETE-resume regression). The
  structural test itself was passing in both runners.

The described failure ("npm test green, test:worker failed the structural test")
was imprecise: `test:worker` failed because it includes the walkthrough test
(not in the `npm test` curated list), not because the structural test itself had
a different result between runners. The curated `npm test` list intentionally
excludes `cf-local-walkthrough.test.ts` (it runs under `gate:authority`/`smoke:cf-local`).

With `isolate: false` in vitest.config.ts, `localCatalogReservoirs` and
`hostSeedKvNamespaces` (module-level Maps in `persistent-object-do.ts`) are shared
between test files in the same Vitest worker thread. This is safe: both caches are
keyed by catalog config hash and are content-deterministic. They speed up subsequent
test files (cached bytecode compilation) without causing incorrect behavior.

### Validation (post A1 merge)

- `npm run typecheck`: clean
- `npm run test:files -- tests/worker/cf-local-structural.test.ts tests/b-i-read-closure-parity.test.ts`: 11/11 pass
  - C2 ENFORCED: warm same-scope bytes = 0; cross-scope bytes < 256 KB; dangling refs = 0
  - B-i parity: 6/6 (strict `accepted-post_state_hash` assertion from commit 57e0ba8 preserved)
- `npm test`: 558/558 pass (41 test files, including session-lifecycle 8/8)
- `npm run test:worker`: 276/276 pass (19 files)
- `npm run smoke:cf-dev`: 12/13 steps pass, 1 tracked-fail (carry-across-rooms → A2), exit 0
