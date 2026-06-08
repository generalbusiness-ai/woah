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

Fix validation after patching authority-slice materialization:

- `npm run test:files -- tests/authority-slice-shape.test.ts tests/worker/cf-local-structural.test.ts`
  passed, 16 tests.
- `npm run smoke:cf-local` passed, 1 file, 4 tests, Vitest duration 33.10s.

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

## Interpretation

The deployed failure was a correctness blocker in sparse authority-slice
materialization, not a timeout. The performance profile still points to the
same scaling center as CF-local smoke: authority-slice reconstruction and
commit-scope envelope RPC dominate warm turn latency, with deployed wall time
roughly an order of magnitude higher than local CF shape.
