# CF-local smoke metrics

Date: 2026-06-08
Branch: `main`

## Result

`npm run smoke:cf-local` passed twice:

- Timed gate run: 1 file, 4 tests, Vitest duration 32.54s, task timer 33s.
- Metrics-capture run: 1 file, 4 tests, Vitest duration 32.81s.

Raw ignored artifacts:

- `.woo/cf-local-smoke-20260608T1919Z.log`
- `.woo/cf-local-smoke-20260608T1919Z.summary.json`
- `.woo/cf-local-smoke-20260608T1922Z.instrumented.log`
- `.woo/cf-local-smoke-20260608T1922Z.spy-metrics.ndjson`
- `.woo/cf-local-smoke-20260608T1922Z.combined-metrics.json`
- `.woo/cf-local-smoke-20260608T1922Z.summary.json`

The combined metrics profile includes 4,090 `woo.metric` events across 52
kinds. It combines Vitest stdout metrics with temporarily captured `console.log`
spy metrics from the main cross-shard walkthrough and stale-Directory pressure
probe.

## Performance Summary

Turn phase metrics:

- `turn_phase_timing`: 34 turns, total 27,532 ms, mean 810 ms, p50 689 ms,
  p95 1,851 ms, max 2,322 ms.
- Phase share of summed turn wall time: authority 47%, ensure-client 30%,
  submit 21%, VM 2%, serialize and plan-build effectively 0%.
- Attempts: mean 1, p95 2, max 3. Authority calls track attempts: mean 1,
  p95 2, max 3.

Largest target/verb totals:

| target:verb | count | mean ms | p95 ms | max ms | attempts | auth mean | submit mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| `the_deck:west` | 5 | 1,149 | 2,312 | 2,322 | 1 | 443 | 209 |
| `the_chatroom:southeast` | 7 | 757 | 1,618 | 1,625 | 1 | 387 | 195 |
| `the_chatroom:enter` | 4 | 989 | 1,042 | 1,044 | 1 | 147 | 98 |
| `the_garden:south` | 2 | 1,444 | 1,524 | 1,533 | 3 | 563 | 129 |
| `the_outline:enter` | 2 | 816 | 951 | 966 | 1 | 152 | 107 |
| `the_outline:leave` | 2 | 812 | 845 | 849 | 2 | 494 | 133 |
| `the_pinboard:enter` | 2 | 750 | 870 | 883 | 1 | 121 | 94 |
| `the_deck:south` | 2 | 716 | 753 | 757 | 2 | 357 | 115 |
| `the_pinboard:leave` | 2 | 711 | 717 | 718 | 2 | 400 | 103 |

Subphase detail:

- Ensure subphase total is dominated by `planning.seed_authority`
  (2,784 ms over 11 events) and `planning.initial.open_rpc`
  (2,530 ms over 11 events).
- Submit subphase total is dominated by `worker.commit_scope_envelope_rpc`
  (3,995 ms over 34 events). `worker.post_accept_delivery` contributes
  765 ms.

MCP dispatch metrics:

- `mcp_dispatch_timing`: 97 requests.
- Warm POST: 85 requests, mean 404 ms, p50 257 ms, p95 1,559 ms,
  max 2,402 ms. Warm POST wall is almost entirely handler time; p95
  `get_world_ms` is 10 ms.
- Cold POST: 7 requests, mean 246 ms, p95 874 ms, max 935 ms. Cold POST wall is
  startup/get-world dominated.
- Warm DELETE: 5 requests, mean 8 ms, max 9 ms.

Cold/startup metrics:

- `init/world`: 16 events, p95 774 ms, max 931 ms.
- `startup_storage/mcp_gateway_snapshot_fetch`: 4 events, p95 790 ms, max
  929 ms.
- `startup_storage/host_seed_fetch`: 17 events, mean 38 ms, p95 82 ms,
  max 96 ms.

Cross-host RPC:

- Largest summed RPC families are authority-slice fetches:
  `/__internal/authority-slice -> world` 1,689 ms over 26 calls,
  `-> the_chatroom` 1,443 ms over 10 calls, and `-> the_deck` 1,350 ms
  over 10 calls.
- Commit apply RPCs are much smaller: `-> the_deck` 373 ms over 19 calls,
  `-> the_chatroom` 206 ms over 20 calls, `-> world` 195 ms over 31 calls.

Storage and transfer metrics:

- `storage_full_save`: 14 events, 15,843 rows.
- `storage_direct_write`: 269 events, 1,168 rows. Object writes dominate row
  volume: 750 rows; property writes: 324 rows; session writes: 82 rows.
- `v2_envelope`: 34 events, mean 98 ms, p95 139 ms, max 186 ms. Reply bytes sum
  2,156,446; projection bytes sum 121,041; max fanout 2.
- `v2_open`: 19 events, mean 135 ms, p95 251 ms, max 371.513 ms. Executable
  transfer sum 3,433,410 bytes across 2,788 pages.

Pressure and correctness signals:

- Max Directory sessions returned: 2.
- Max fanout shards: 1.
- Max audience session shards: 1.
- MCP gateway constructors: 4.
- Commit rejections: 0.
- `dangling_parent_ref`: 0.

## Interpretation

No smoke blocker was found. The error-status metrics in the profile are
accounted for:

- `E_SNAPSHOT_REQUIRED` is the documented compatibility open path for an older
  or empty commit authority, after which callers retry with a materialized seed.
- `E_NEED_STATE` appears on sparse MCP planning turns and matches the documented
  bounded read-boundary repair path for room contents, visibility, and movement
  transitive state. The affected turns later submit, and there are no commit
  rejections.
- The single `mcp_request` error is the deliberate stale `tools/list` check after
  Alice's session has been closed.

The main performance signal is not a correctness failure: multi-attempt sparse
planning repair still dominates the slow movement/tool-leave turns. Authority
slice fetches and initial planning opens are the current wall-time center.
