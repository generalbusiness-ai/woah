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

Commit `9d84257` deployed to Cloudflare version
`30b552e8-4730-4f64-a195-394fa991caf0` after active-scope MCP owner-refresh
repair. The deploy preflight, tests, build, and postflight checks passed, but
the built-in deployed smoke failed 8/10: pinboard timed out at the step
watchdog, and tasks reported `E_INTERNAL fresh turn produced no recording:
the_chatroom:southeast: E_VERBNF verb not found`. A tail-captured follow-up
failed 7/10, with `pinboard:add_note reaches peer` passing at 59,478 ms,
`outliner:enter result includes a roster row for alice` timing out at the
60,006 ms step watchdog, `outliner:add_item reaches peer` losing the MCP
session after reset, and tasks finding the recovery actor outside `the_deck`.

Ignored raw artifacts for the `30b552e8` deployed run:

- `.woo/smoke-measurements/deploy-30b552e8-9d84257-20260608T2040Z/tail.log`
- `.woo/smoke-measurements/deploy-30b552e8-9d84257-20260608T2040Z/smoke.log`
- `.woo/smoke-measurements/deploy-30b552e8-9d84257-20260608T2040Z/smoke-run-1.log`
- `.woo/smoke-measurements/deploy-30b552e8-9d84257-20260608T2040Z/analyze-smoke-tail.txt`
- `.woo/smoke-measurements/deploy-30b552e8-9d84257-20260608T2040Z/analyze-data-path-costs.txt`

Commit `ddaa183` deployed to Cloudflare version
`eec932ee-fd88-441e-8087-506d77a8642b` after preserving pre-recording repair
errors and raising the smoke step watchdog. The deploy preflight, tests, build,
and postflight checks passed. The deploy script's built-in smoke failed 7/10
with two 20s `/mcp` timeouts and one outliner `E_PERM` after reset. A
tail-captured follow-up improved to 9/10: all chat, movement, mug, pinboard,
and outliner steps passed, while tasks failed with `E_VERBNF verb not found:
the_chatroom:southeast`.

Ignored raw artifacts for the `eec932ee` deployed run:

- `.woo/smoke-measurements/deploy-eec932ee-ddaa183-20260608T2102Z/tail.log`
- `.woo/smoke-measurements/deploy-eec932ee-ddaa183-20260608T2102Z/smoke.log`
- `.woo/smoke-measurements/deploy-eec932ee-ddaa183-20260608T2102Z/smoke-run-1.log`
- `.woo/smoke-measurements/deploy-eec932ee-ddaa183-20260608T2102Z/analyze-smoke-tail.txt`
- `.woo/smoke-measurements/deploy-eec932ee-ddaa183-20260608T2102Z/analyze-data-path-costs.txt`

Commit `121cd46` deployed to Cloudflare version
`d8e30ba2-7141-498c-b570-932f9eb25637` after converting pre-recording sparse
verb/object misses into missing-state repair. The deploy preflight, tests,
build, and postflight checks passed. The deploy script's built-in smoke failed
8/10: pinboard reported `E_OBJNF object not found: the_pinboard`, and tasks
reported `E_VERBNF verb not found: the_chatroom:southeast`. A tail-captured
follow-up improved to 9/10: pinboard and outliner passed, while tasks still
failed on `the_chatroom:southeast`.

Ignored raw artifacts for the `d8e30ba2` deployed run:

- `.woo/smoke-measurements/deploy-d8e30ba2-121cd46-20260608T2129Z/tail.log`
- `.woo/smoke-measurements/deploy-d8e30ba2-121cd46-20260608T2129Z/smoke.log`
- `.woo/smoke-measurements/deploy-d8e30ba2-121cd46-20260608T2129Z/smoke-run-1.log`
- `.woo/smoke-measurements/deploy-d8e30ba2-121cd46-20260608T2129Z/analyze-smoke-tail.txt`
- `.woo/smoke-measurements/deploy-d8e30ba2-121cd46-20260608T2129Z/analyze-data-path-costs.txt`

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

Fourth root cause: the deployed reset path can open a fresh sparse gateway
state where `the_chatroom` is absent locally. `runShadowTurnCallOnWorldTranscript`
previously preserved only pre-recording `E_NEED_STATE`, wrapping
pre-recording `E_OBJNF` and `E_VERBNF` in an opaque
`fresh turn produced no recording` error. That stripped the code/value pair the
scope executor needs to refresh authority and retry. Shadow turn calls now
preserve `E_NEED_STATE`, `E_OBJNF`, and `E_VERBNF` when they are raised before
the recorder opens.

Fifth finding: the pinboard and outliner step watchdog trips were not single
stuck verb calls. The `outliner:enter` turn itself completed in 9,959 ms, but
the smoke step bundled several serial deployed movements and drains before the
assertion: `alice.leave pinboard` about 14.7s, `bob.leave pinboard` about 8.1s,
`alice west` about 9.1s, `bob west` about 12.7s, and `the_outline:enter` about
10s. The walkthrough now keeps the 20s per-RPC stuck-request guard but raises
the step envelope to an env-configurable 120s default.

Sixth root cause: preserving pre-recording `E_VERBNF` made the error visible to
the caller, but `executeShadowTurnCallOrNeedState` still classified only thrown
`E_NEED_STATE` as repairable. The `eec932ee` tail showed
`mcp_tool_resolve` correctly hitting `the_chatroom:southeast`, followed by two
pre-recorder direct-call `E_VERBNF` failures in the executable sparse world.
The executor now converts a thrown `E_VERBNF` that matches the requested target
verb into a `read:cell:verb:<target>:<verb>` missing atom, and converts a thrown
`E_OBJNF` into a lifecycle missing atom, so cell-page repair hydrates the
dispatch closure before retrying.

Seventh root cause: the missing-atom repair could fetch the target instance
and actor, but an inherited tool call also needs the object that defines the
verb and the class rows that connect the target to that definition. In the
`d8e30ba2` tail, `mcp_tool_resolve` hit `the_chatroom:southeast`; the first
direct call failed with `E_VERBNF`, relocation prewarm succeeded, missing-state
repair fetched `the_chatroom` and `guest_1`, and the retry still failed with
`E_VERBNF`. Locally, `southeast` resolves on `$room`, not `the_chatroom`.
Remote tool descriptors now carry the defining object and source support rows,
and MCP dispatch threads those through the gateway so sparse relays owner-fetch
support such as `$room` from `world` before executing inherited tools.
The same definer lookup is applied to obvious-projection tools so support rows
follow class lineage rather than the verb's code owner.

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

Validation after preserving pre-recording sparse repair errors and widening the
smoke step envelope:

- `npm run test:files -- tests/scope-executor-garden-probe.test.ts tests/smoke-walkthrough-harness.test.ts`
  passed, 8 tests.
- `npm run test:files -- tests/mcp.test.ts tests/scope-executor-garden-probe.test.ts tests/smoke-walkthrough-harness.test.ts tests/worker/cf-local-structural.test.ts`
  passed, 75 tests.
- `npm run smoke:cf-local` passed, 1 file, 4 tests, Vitest duration 33.85s.
- `npm test` passed, 29 files and 376 tests.
- `npm run typecheck` passed both TypeScript configs.

Validation after converting pre-recording sparse verb/object misses into
missing-state repair:

- `npm run test:files -- tests/shadow-turn-exec.test.ts -t "pre-recording sparse verb miss"`
  passed, 1 test.
- `npm run test:files -- tests/shadow-turn-exec.test.ts tests/mcp.test.ts tests/scope-executor-garden-probe.test.ts tests/smoke-walkthrough-harness.test.ts tests/worker/cf-local-structural.test.ts`
  passed, 105 tests.
- `npm run smoke:cf-local` passed, 1 file, 4 tests, Vitest duration 40.98s.
- `npm test` passed, 29 files and 377 tests.
- `npm run typecheck` passed both TypeScript configs.

Validation after threading inherited tool definers/support rows through MCP
dispatch:

- `npm run test:files -- tests/mcp.test.ts tests/worker/scope-topology-seed.test.ts`
  passed, 70 tests. The topology regression asserts that an inherited
  `the_chatroom:southeast` call owner-prefetches `$room` from `world`.
- `npm run smoke:cf-local` passed, 1 file, 4 tests, Vitest duration 33.87s.
- `npm run test:files -- tests/v2-browser-worker.integration.test.ts -t "keeps an accepted reply when its bundled executable transfer fails capsule validation"`
  passed after the full gate first exposed a one-off timeout in that unrelated
  browser-worker case.
- `npm test` passed, 29 files and 377 tests.
- `npm run typecheck` passed both TypeScript configs.
- `npm run test:worker` passed, 16 files and 236 tests, 5 skipped.

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

The tail-captured deployed run after active-scope MCP owner refresh found 700
Cloudflare tail events and 2,679 `woo.metric` rows.

Cloudflare invocation timing:

- Worker `POST /mcp`: 70 requests, 3 errors, p95 13,695 ms, max 15,309 ms.
- PersistentObjectDO `POST /mcp`: 69 requests, 1 error, p95 13,675 ms, max
  15,256 ms, CPU p95 8,257 ms.
- CommitScopeDO `POST /v2/envelope`: 21 requests, p95 1,990 ms, max 2,027 ms.
- PersistentObjectDO `POST /__internal/authority-slice`: 55 requests, p95
  860 ms, max 1,120 ms.
- Worker/PersistentObjectDO `DELETE /mcp`: p95 3,761 ms, max 7,248 ms.

Turn phase attribution across reported turns:

- Submit: 92,119 ms, 56% of summed turn wall time.
- Authority planning: 40,785 ms, 25%.
- Ensure-client: 32,927 ms, 20%.

Largest deployed costs:

- `worker.commit_scope_envelope_rpc`: 87,425 ms, p95 7,255 ms.
- `/__internal/authority-slice -> world`: 25 calls, 18,786 ms summed.
- `/__internal/authority-slice -> the_deck`: 12 calls, 8,354 ms summed.
- `/__internal/authority-slice -> the_chatroom`: 9 calls, 6,223 ms summed.
- `/__internal/mcp-commit-fanout -> mcp-gateway-6`: one 5,000 ms timeout.

Data-path costs:

- `storage_full_save`: 1 event, 4,872 rows.
- `storage_direct_write`: 132 metric rows, 1,372 data rows.
- Observed projection bytes: 1.20 MiB.
- Cross-host round trips: 148.
- Same-host fallback count: 30.
- Remote owner refresh count: 24.
- Tool-surface reverse-index source rows requested: 398; cap-hit events: 0.

The tail-captured deployed run after preserving pre-recording repair errors
found 802 Cloudflare tail events and 3,146 `woo.metric` rows.

Cloudflare invocation timing:

- Worker `POST /mcp`: 71 requests, 0 errors, p95 12,711 ms, max 15,307 ms.
- PersistentObjectDO `POST /mcp`: 69 requests, 0 errors, p95 13,554 ms, max
  15,765 ms, CPU p95 7,627 ms.
- CommitScopeDO `POST /v2/envelope`: 25 requests, p95 2,094 ms, max 2,542 ms.
- PersistentObjectDO `POST /__internal/authority-slice`: 65 requests, p95
  1,009 ms, max 2,364 ms.
- PersistentObjectDO `POST /__internal/mcp-commit-fanout`: 31 requests, p95
  304 ms, max 4,830 ms.

Turn phase attribution across reported turns:

- Submit: 108,530 ms, 51% of summed turn wall time.
- Authority planning: 69,455 ms, 32%.
- Ensure-client: 35,854 ms, 17%.

Largest deployed costs:

- `worker.commit_scope_envelope_rpc`: 99,427 ms, p95 5,526 ms.
- `worker.post_accept_delivery`: 9,103 ms, p95 698 ms.
- `/__internal/authority-slice -> world`: 28 calls, 20,350 ms summed.
- `/__internal/authority-slice -> the_chatroom`: 14 calls, 12,941 ms summed.
- `/__internal/authority-slice -> the_deck`: 12 calls, 7,988 ms summed.
- `/__internal/mcp-commit-fanout -> mcp-gateway-25`: 8 calls, 1 timeout,
  6,112 ms summed, max 5,000 ms.

Data-path costs:

- `storage_full_save`: 1 event, 4,877 rows.
- `storage_direct_write`: 127 metric rows, 986 data rows.
- Observed projection bytes: 1.93 MiB.
- Cross-host round trips: 183.
- Same-host fallback count: 37.
- Remote owner refresh count: 28.
- Tool-surface reverse-index source rows requested: 214; cap-hit events: 0.

The tail-captured deployed run after missing-state repair found 817 Cloudflare
tail events and 3,177 `woo.metric` rows.

Cloudflare invocation timing:

- Worker `POST /mcp`: 71 requests, p95 13,100 ms, max 18,874 ms.
- PersistentObjectDO `POST /mcp`: 69 requests, p95 13,148 ms, max 18,850 ms,
  CPU p95 8,628 ms.
- CommitScopeDO `POST /v2/envelope`: 28 requests, p95 2,118 ms, max 2,636 ms.
- PersistentObjectDO `POST /__internal/authority-slice`: 71 requests, p95
  2,042 ms, max 2,538 ms.
- PersistentObjectDO `POST /__internal/mcp-commit-fanout`: one timeout.

Turn phase attribution across reported turns:

- Submit: 113,172 ms, 51% of summed turn wall time.
- Authority planning: 68,169 ms, 31%.
- Ensure-client: 39,850 ms, 18%.

Largest deployed costs:

- `/__internal/authority-slice -> world`: 30 calls, max 833 ms.
- `/__internal/authority-slice -> the_deck`: 15 calls, max 1,816 ms.
- `/__internal/authority-slice -> the_chatroom`: 15 calls, max 1,598 ms.
- `/__internal/authority-slice -> the_outline`: 5 calls, max 1,935 ms.
- `/__internal/mcp-commit-fanout`: one timeout.

Correctness detail from the final tasks failure:

- `mcp_tool_resolve` hit `the_chatroom:southeast`.
- First `direct_call` failed with `E_VERBNF`.
- `mcp_relocation_prewarm` succeeded in 4,703 ms.
- Missing-state repair fetched `the_chatroom` and `guest_1`.
- Retry still failed with `E_VERBNF`, confirming inherited definer/support
  hydration was the remaining gap.

## Interpretation

The deployed failure was a correctness blocker in sparse authority-slice
materialization first, then sparse MCP repair propagation. The performance
profile still points to the same scaling center as CF-local smoke:
authority-slice reconstruction and commit-scope envelope RPC dominate warm turn
latency, with deployed wall time roughly an order of magnitude higher than
local CF shape. The `30b552e8` run also showed that the 60s smoke step watchdog
was too close to the deployed end-to-end latency envelope for steps that
intentionally serialize several cross-shard operations. The `eec932ee` run
narrowed the remaining tasks failure to executable sparse-state repair:
resolution and tool-surface reachability were correct, but the target verb cell
was not hydrated before dispatch retry. The `d8e30ba2` run narrowed that again:
the target and actor were repairable, but inherited verb support did not travel
as an owner-prefetch root.
