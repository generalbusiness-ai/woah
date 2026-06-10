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
