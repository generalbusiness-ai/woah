# 2026-06-04 — MCP ensure/submit fast path

## Context

The previous prod measurements showed the remaining MCP write-turn wall was
not local VM/serialization work. `turn_phase_timing` attributed the wall to
`authority` plus `submit`, and the local P1.1 pre-apply gate saved doomed-round
CPU without moving the turn wall. The next useful fix is therefore not another
local apply shortcut: it is to remove avoidable sequential RPC from the
`ensure_client -> submit` path and instrument what remains.

## What changed

1. `turn_phase_timing` now accepts optional `ensure_detail_ms` and
   `submit_detail_ms` maps. These preserve the coarse phase totals while naming
   expensive substeps.

2. MCP Worker submit now reports:
   - `worker.commit_scope_envelope_rpc`
   - `worker.post_accept_delivery`
   - `worker.gateway_projection_cache_apply`

   This separates "CommitScopeDO accepted the envelope slowly" from "origin
   post-accept work was slow" in smoke-tail analysis.

3. The MCP gateway speculatively prewarms the likely relocation commit scope.
   For durable calls where `target === scope` and the actor is not the scope,
   it starts an actor-scope `head_session.v1` open before local planning proves
   the B6 relocation. This is intentionally non-fatal and does not change
   commit semantics: transcript-based commit-scope selection, authority
   refresh, expected-head validation, and retry still run normally.

4. `mcp_relocation_prewarm` records the speculative open's scope, actor commit
   scope, target, verb, duration, and status. The data-path analyzer classifies
   it as request wall time, and the smoke-tail analyzer prints subphase maps.

## Local validation

- `npm run test:files -- tests/v2-mcp-e2e.test.ts` passed after correcting the
  guard to include MCP durable `direct` calls. This matters because `woo_call
  the_chatroom enter` arrives as `route: "direct"` even though it relocates to
  the actor commit scope after planning. The e2e test now also asserts that the
  second enter's commit-phase ensure records `commit.session_open_cached: 0`,
  so the local guard proves the prewarm is consumed by commit ensure rather
  than merely emitted as a metric.
- `npm run test:files -- tests/v2-mcp-e2e.test.ts tests/worker/cf-local-structural.test.ts tests/analyze-data-path-costs.test.ts tests/executor.test.ts`
  passed: 4 files, 37 tests.
- `npm run typecheck` passed.
- `npm run smoke:cf-local:structural` passed: 1 file, 2 tests.
- `npm test` passed: guards plus 28 files, 369 tests.

The local tests prove the mechanism starts actor-scope opens before the planned
commit envelope and that the new metrics are emitted. They do not prove the
Cloudflare smoke now clears the 20s timeout; that still needs one deployed
tail-backed run.

## Risk and next measurement

The prewarm guard is intentionally structural rather than verb-name based. It
may start an actor-scope head/session open for a durable room-object call that
ultimately does not relocate. That is bounded by existing per-scope initializer
coalescing and is safer than hardcoding catalog verbs in the gateway. Prod
measurement should verify that prewarm moves actor-scope open cost out of the
turn's critical wait and that `submit_detail_ms.worker.commit_scope_envelope_rpc`
is the remaining dominant submit label if the turn still times out.
