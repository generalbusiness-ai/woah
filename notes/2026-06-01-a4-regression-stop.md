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
