# Deployed smoke metrics

Date: 2026-06-08
Branch: `main`
Base URL: `https://woah1.generalbusiness.ai`

## Result

Commit `c98f947` deployed to Cloudflare version
`280ae9e3-16dc-49b8-a389-c68886b3d0e9`. The deployment preflight, build,
health checks, auth checks, WebSocket check, wizard claim check, and `/mcp`
routing check passed.

The deployed smoke walkthrough failed 8/10:

- `pinboard:add_note reaches peer` failed with `E_INTERNAL state page set
  missing lineage page for the_deck`.
- `tasks: cross-room entered reaches peer` failed with `E_INTERNAL fresh turn
  produced no recording: the_chatroom:southeast: E_VERBNF verb not found`.

Ignored raw artifacts:

- `.woo/smoke-measurements/deploy-280ae9e3-c98f947-20260608T1950Z/tail.log`
- `.woo/smoke-measurements/deploy-280ae9e3-c98f947-20260608T1950Z/smoke.log`
- `.woo/smoke-measurements/deploy-280ae9e3-c98f947-20260608T1950Z/analyze-smoke-tail.txt`
- `.woo/smoke-measurements/deploy-280ae9e3-c98f947-20260608T1950Z/analyze-data-path-costs.txt`

Commit `a978cfe` deployed to Cloudflare version
`ec5e3cf0-d3ec-4466-9e6a-8b1176adec68` after adding inline-lineage
materialization support. The deploy preflight, tests, build, and postflight
checks passed, but the deployed smoke failed with the same 8/10 summary. That
proved the production payload was not merely dropping a lineage ref while
retaining the inline lineage page.

Commit `2bcf337` deployed to Cloudflare version
`0499b8ce-a46d-463b-a142-fda4e5b9c11a` after lineage-closing combined
authority slices. The deploy preflight, tests, build, and postflight checks
passed. The deployed smoke improved to 9/10: pinboard passed, while
`tasks: cross-room entered reaches peer` still failed when resolving
`the_chatroom:southeast`.

Ignored raw artifacts for the 9/10 deployed run:

- `.woo/smoke-measurements/deploy-0499b8ce-2bcf337-20260608T2020Z/tail.log`
- `.woo/smoke-measurements/deploy-0499b8ce-2bcf337-20260608T2020Z/smoke.log`
- `.woo/smoke-measurements/deploy-0499b8ce-2bcf337-20260608T2020Z/analyze-smoke-tail.txt`
- `.woo/smoke-measurements/deploy-0499b8ce-2bcf337-20260608T2020Z/analyze-data-path-costs.txt`

## Correctness Finding

The pinboard blocker happened before VM execution during scope/session
materialization. Tail metrics recorded `mcp_relocation_prewarm` failures for
`the_deck:enter` and `the_pinboard:enter` with `state page set missing lineage
page for the_deck`; the corresponding `turn_phase_timing` rows had
`outcome=error`, `authority_calls=0`, and all time in ensure-client work.

Root cause: `serializedWorldFromAuthoritySlice` filtered `inline_pages` strictly
to hashes present in the final `page_refs`. That can discard an inline
`object_lineage` page that was retained as fill-only scaffolding for changed
pages, causing `mergeShadowStatePagesIntoSerialized` to reject the sparse page
set.

Second root cause: combined authority payloads could also include projection
support cells, especially Directory/session `object_live` scope contents, for an
object whose `object_lineage` never survived into any slice. Such a payload
cannot be materialized as a standalone seed at all. `combineSerializedAuthoritySlices`
now lineage-closes the final cell slice by dropping non-lineage cells for
objects that lack any lineage ref, preserving actor/scope support only when an
identity page also co-travels.

Third root cause: after the lineage fix, the remaining deployed failure moved
to MCP tool resolution before VM planning. Tail rows showed
`mcp_tool_resolve` for `the_chatroom:southeast` with `active_scope` and
`actor_location` both set to `the_chatroom`, but `status=miss` and
`miss_reason=not_reachable`. The gateway had a sparse local active-scope row
for `the_chatroom`; because that row did not look remote, the local
`resolveReachableTool` branch returned a verb miss without asking the owner for
a fresh tool surface. The MCP host now gives active-scope local verb misses one
bounded owner refresh before reporting the tool gone.

Fix validation after patching authority-slice materialization:

- `npm run test:files -- tests/authority-slice-shape.test.ts tests/worker/cf-local-structural.test.ts`
  passed, 16 tests.
- `npm run smoke:cf-local` passed, 1 file, 4 tests, Vitest duration 33.10s.

Additional validation after lineage-closing combined authority slices:

- `npm run test:files -- tests/authority-slice-shape.test.ts` passed, 15 tests.
- `npm run test:files -- tests/worker/cf-local-structural.test.ts tests/worker/gateway-projection-cache.test.ts`
  passed, 28 tests.
- `npm run smoke:cf-local` passed, 1 file, 4 tests, Vitest duration 35.14s.
- `npm test` passed after stabilizing the browser-worker integration helper
  timeout, 29 files and 375 tests.

Additional validation after active-scope MCP owner refresh:

- `npm run test:files -- tests/mcp.test.ts -t "active-scope local projection"`
  passed, 1 test.
- `npm run test:files -- tests/mcp.test.ts` passed, 65 tests.
- `npm run test:files -- tests/authority-slice-shape.test.ts tests/mcp.test.ts tests/worker/cf-local-structural.test.ts tests/worker/gateway-projection-cache.test.ts`
  passed, 108 tests.
- `npm run smoke:cf-local` passed, 1 file, 4 tests, Vitest duration 34.63s.
- `npm test` passed, 29 files and 375 tests.
- `npm run typecheck` passed both TypeScript configs.

## Performance Summary

Tail capture found 722 Cloudflare tail events and 2,713 `woo.metric` rows.

Cloudflare invocation timing:

- Worker `POST /mcp`: 70 requests, p95 10,985 ms, max 17,086 ms.
- PersistentObjectDO `POST /mcp`: 69 requests, p95 11,210 ms, max 17,208 ms,
  CPU p95 6,085 ms.
- CommitScopeDO `POST /v2/envelope`: 19 requests, p95 2,045 ms, max 2,293 ms.
- PersistentObjectDO `POST /__internal/authority-slice`: 53 requests, p95
  1,854 ms, max 2,163 ms.
- CommitScopeDO `POST /v2/open`: 11 requests, p95 1,007 ms, max 1,060 ms.

Turn phase attribution across 21 reported turns:

- Submit: 78,879 ms, 49% of summed turn wall time.
- Ensure-client: 52,652 ms, 32%.
- Authority planning: 31,035 ms, 19%.
- VM, serialization, and plan-build were effectively 0%.

Largest subphase totals:

- `worker.commit_scope_envelope_rpc`: 72,926 ms over 18 events, p95 5,662 ms.
- `commit.initializer_wait`: 29,330 ms over 8 events, p95 4,864 ms.
- `planning.seed_authority`: 14,502 ms over 15 events, p95 1,394 ms.
- `commit.seed_authority`: 6,603 ms over 3 events, p95 2,848 ms.
- `worker.post_accept_delivery`: 5,953 ms over 18 events, p95 728 ms.

Cross-host RPC pressure:

- `/__internal/authority-slice -> world`: 25 calls, 17,989 ms summed.
- `/__internal/authority-slice -> the_chatroom`: 16 calls, 12,222 ms summed.
- `/__internal/authority-slice -> the_deck`: 6 calls, 4,505 ms summed.
- `/__internal/enumerate-tools -> the_chatroom`: 12 calls, 3,333 ms summed.
- `/__internal/apply-v2-commit -> the_chatroom`: 16 calls, 2,764 ms summed.

Data-path costs:

- `storage_full_save`: 1 event, 4,864 rows.
- `storage_direct_write`: 126 events, 1,147 rows.
- Observed projection bytes: 1.56 MiB.
- Cross-host round trips: 147.
- Same-host fallback count: 28.
- Remote owner refresh count: 23.
- Tool-surface reverse-index source rows requested: 210; cap-hit events: 0.

The 9/10 deployed run after lineage closure found 706 Cloudflare tail events
and 2,733 `woo.metric` rows.

Cloudflare invocation timing:

- Worker `POST /mcp`: 67 requests, p95 11,404 ms, max 14,362 ms.
- PersistentObjectDO `POST /mcp`: 66 requests, p95 11,543 ms, max 14,401 ms,
  CPU p95 6,655 ms.
- CommitScopeDO `POST /v2/envelope`: 24 requests, p95 1,909 ms, max 2,108 ms.
- PersistentObjectDO `POST /__internal/authority-slice`: 50 requests, p95
  1,943 ms, max 2,850 ms.
- CommitScopeDO `POST /v2/open`: 9 requests, p95 1,381 ms.

Turn phase attribution across reported turns:

- Submit: 80,756 ms, 53% of summed turn wall time.
- Ensure-client: 36,681 ms, 24%.
- Authority planning: 36,323 ms, 24%.

Largest deployed costs:

- `worker.commit_scope_envelope_rpc`: 75,723 ms, p95 5,579 ms.
- `commit.initializer_wait`: 23,126 ms.
- `planning.seed_authority`: 10,845 ms.
- `/__internal/authority-slice -> world`: 22 calls, 10,307 ms summed.
- `/__internal/authority-slice -> the_chatroom`: 12 calls, 9,512 ms summed.

Data-path costs:

- `storage_full_save`: 2 events, 9,735 rows.
- `storage_direct_write`: 122 metric rows, 987 data rows.
- Observed projection bytes: 1.78 MiB.
- Cross-host round trips: 160.
- Same-host fallback count: 23.
- Remote owner refresh count: 35.
- Tool-surface reverse-index source rows requested: 470; cap-hit events: 0.

## Interpretation

The deployed failure was a correctness blocker in sparse authority-slice
materialization, not a timeout. The performance profile still points to the
same scaling center as CF-local smoke: authority-slice reconstruction and
commit-scope envelope RPC dominate warm turn latency, with deployed wall time
roughly an order of magnitude higher than local CF shape.
