# Per-turn authority cost: the line_map lever (2026-06-09)

## Goal
Reduce per-turn MCP authority cost, using `smoke:cf-dev --measure` as the
before/after instrument. Prod symptom: ~17–35s/turn, dominated by authority
assembly + the ~1.9 MB envelope slice.

## What the instrument established (corrected from the pass-level headline)
Per-turn detail (`smoke:cf-dev --measure`, workerd-local) showed:
- The **warm cheap-path already works**: a repeat turn on an already-touched
  scope is `ensure_client==0` — free. The pass-level "warm≈cold" was an artifact
  of opening new sessions each pass (re-paying per-scope first-touch).
- Cost concentrates in (a) **first-touch scope seeding** (`seed_authority`, full
  slice per scope/session) and (b) **owner_prefetch on movement** (21
  `warm_turn_refresh` reconstructions/pass). Both are genuine first-fetches, not
  redundant warm refreshes.
- The dominant **byte** cost is the authority slice itself, sent full (~1.8 MB)
  on cross-scope / `planned_transcript_commit` turns (most movement), which
  `slimMcpEnvelopeBody` deliberately never slims (it is the validation seed for
  cells absent from the dest's durable snapshot).

## The lever: verb `line_map` = 59% of slice bytes
Measured the demo-world export (2.64 MB, 118 objects, 359 verbs):

| verb field | bytes | share |
|---|---|---|
| **line_map** | 1,551,810 | **58.8%** |
| bytecode | 480,483 | 18.2% |
| source | 248,753 | 9.4% |
| arg_spec | 15,655 | 0.6% |

`line_map` (pc → source line/col) is **debug-only**: consumed solely by
stack-trace formatting in `tiny-vm.ts:1479` (guarded; tolerates absence). The VM
dispatches on `bytecode`. The codebase already knows this — host-seed delivery
strips `line_map` via `stripAuthoringMetadataFromObject` (`world.ts:11869`), and
satellites recompile it from `source` on demand
(`catalog-installer.ts` line_map repair). So the per-turn authority slice
re-carrying full `line_map` for catalog **class** verbs (which the satellite
already holds, stripped, from host-seed) is redundant wire/CPU cost.

## Attempt + why it failed (gate caught a real regression)
Tried the obvious one-line strip: `exportAuthoritySlice` →
`this.exportObjects(ids).map(stripVerbLineMapsFromObject)` (line_map only, no
redaction). Result: `typecheck` + `npm test` (384) **passed**, but
`smoke:cf-local` **failed** — `move:southeast emits 'left' to bob` timed out:
the cross-actor `left` fanout never arrived.

Root cause: the authority **page content** that gets content-hashed includes the
serialized verb rows (with `line_map`). Stripping `line_map` only at delivery
(`exportAuthoritySlice`) while the owner computes its authoritative head hash
from the full rows makes the delivered page hash diverge from the owner's →
read-version / page-hash mismatch on the move's verb reads → commit
validation/fanout breaks. Host-seed gets away with stripping because its merge
uses `normalizeVerbForCompare` (bootstrap.ts:700), which **ignores** `line_map`;
the per-turn cell-authority path hashes raw page content and does not.

Reverted to green.

## The bounded next change (correctness-critical — do deliberately)
Make verb-cell / authority **page-content hashing `line_map`-blind
consistently**, at both the authoritative-head computation and delivery, so
owner-hash == delivered-hash == satellite-stored-hash (the satellite already runs
line_map-stripped from host-seed). Candidate seam: strip `line_map` inside
`buildSerializedAuthorityCellSlice` (`src/core/authority-slice.ts:142`) /
wherever page content is canonicalized for hashing — NOT at the delivery edge.
Then re-apply the strip and confirm `warm_turn_refresh`/`request_bytes` drop on
`--measure` with `smoke:cf-local` + `smoke:cf-dev` + deploy smoke all green.

Risk: this touches the cell-authority hashing core that commit validation depends
on. A subtle mismatch can pass local gates (single-process, no cross-colo) and
break prod commit validation — the exact class the smoke harness cannot fully
catch locally (deploy-only). Treat as its own careful pass with the deploy smoke
as the final gate; do not rush it onto the end of unrelated work.

Expected payoff if landed: ~50–59% reduction in per-turn authority-slice bytes,
which maps to prod latency as bytes × cross-colo RTT on every cross-scope turn.
