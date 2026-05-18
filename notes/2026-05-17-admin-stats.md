# Admin stats panel — implementation plan

Goal: a `/admin/` page on the woah worker that shows traffic per logical
component (worker, DO, in-world object, commit-scope) with click-to-window
drill-in, backed by Workers Analytics Engine. Minimal storage, no extra DO.

## Step 1 — emission spine (this branch)

Every `woo.metric` event already carries the dimensions a dashboard wants
(`host_key`, `scope`, `class`, `kind`, `method`/`route`/`phase`, `status`,
`error`, `ms`). The three DOs each have a private `emitMetric` that
funnels everything to console; we dual-write to AE there.

- `wrangler.toml` declares `[[analytics_engine_datasets]]` with binding
  `METRICS` and dataset `woo_v1_prod` (names match
  `spec/reference/cloudflare.md §R10.1` and §R14.3). The commented
  staging block gets a matching binding pointing at `woo_v1_staging`
  so a future `wrangler deploy --env staging` doesn't silently lose
  metrics.
- `src/worker/metrics-sink.ts` owns the AE write path. Declares a local
  structural type for the AE binding (rather than relying on the global
  `@cloudflare/workers-types` type) because `tests/internal-auth.test.ts`
  pulls `internal-auth.ts` into the default tsconfig that excludes
  worker-only types.
- Each DO's `emitMetric` calls `writeMetricToAnalytics(...)` before its
  existing `console.log`. Constructor-time emissions (which used a direct
  `console.log` literal) also get a `writeConstructorMetricToAnalytics(...)`
  side-call so the dashboard sees DO cold-starts.

### Index choice — `host_key`

AE indexes one field. Two effects:

1. `WHERE indexes['host_key'] = ...` is the only filter pushdown — every
   other field is a scan.
2. AE's adaptive sampling boundary is per-index-value. A noisy host
   (`world`, `mcp-gateway-0`) burns its own sampling budget without
   polluting quieter hosts (`the_horoscope`).

The dashboard's primary pivot is "by component" so this aligns naturally.
We accept that group-by-`kind` charts are noisier on rare kinds during
high-volume bursts; the trade goes the right way.

### Sampling

Console-tail is unchanged. AE writes are:

| Kind | Behavior |
|---|---|
| `shadow_apply_step` / `shadow_gateway_apply_step` with `phase != "total"` | Dropped — `total` carries the same info for a dashboard, per-phase is 10x amplification. |
| `storage_direct_write`, `storage_flush` | 1-in-10 sampled. Multiplier stored as `doubles[1]` so queries can `SUM(double1)` instead of `count()`. |
| Anything with `status:"error"` or non-empty `error` field | Always written, never sampled. |
| Everything else | Written 1:1. |

Errors override the sampled-kind rule. Dashboard error panes must reflect
ground truth even during a burst.

### AE schema (stable — `/admin/stats` hard-codes these slot positions)

See `spec/reference/cloudflare.md §R10.1` for the normative slot map.
Summary: 16 blobs + 3 doubles, fixed-width. Empty axes occupy their
slot. The slot positions never reorder or repurpose; new axes get a NEW
slot.

```
indexes[0] = host_key

blobs[0]   = kind
blobs[1]   = scope          (commit-scope / space)
blobs[2]   = class          (DO class)
blobs[3]   = route          (do_handler.route, cross_host_rpc.route)
blobs[4]   = method         (do_handler.method, mcp_request.method)
blobs[5]   = phase          (shadow_*_step, startup_storage, init phase)
blobs[6]   = what           (storage_direct_write.what)
blobs[7]   = status
blobs[8]   = error
blobs[9]   = target         (direct_call.target, dispatch_resolved.target)
blobs[10]  = verb           (applied/direct_call/dispatch_resolved verb)
blobs[11]  = tool           (mcp_request.tool)
blobs[12]  = host           (cross_host_rpc/dispatch_resolved/host_schema_sync host)
blobs[13]  = actor          (mcp_tool_refresh_*, dispatch_resolved)
blobs[14]  = path           (dispatch_resolved.path: local|read|mutating)
blobs[15]  = reason         (shadow_commit_rejected.reason, mcp_tool_refresh_*.reason,
                             rest_v2_in_process_fallback.reason)

doubles[0] = ms
doubles[1] = sample_rate    (1, or the 1-in-N multiplier)
doubles[2] = count          (kind-specific primary: rows | audience_size |
                             observations | fanout | hosts | objects)
```

### Coverage

`tests/worker/metrics-sink.test.ts` pins:

- per-phase drop vs total-kept
- 1-in-10 sample rate on storage kinds, full rate on everything else
- error override (no sampling)
- slot order in the AE payload
- AE-binding-undefined no-op
- AE write failure swallowed (a broken AE must never throw into the worker)
- constructor convenience uses the same slot conventions

The full vitest suite (934 tests) is unaffected by the change.

## Step 2 — `/admin/` UI (next branch)

Out of scope here. Sketch:

- HTTP Basic auth, single fixed user `admin`, password from
  `env.ADMIN_PASSWORD` (Cloudflare secret).
- `/admin/series?metric=...&groupBy=host_key|scope|class|kind&from=&to=&bucket=`
  proxies to the AE SQL API with `Account Analytics:Read`.
- Three pivots (host_key / scope / class), one error-rate chart, one
  footprint table (per-DO-class p50/p95/error%).
- Click-drag a chart → URL hash carries the window → all panels re-query.
- "Look deeper" produces a `wrangler tail` command preset for the window.

## Decisions still open

- AE write quotas: monitor first deploy. If `storage_direct_write` at 1/10
  is still hot, drop to 1/100 (multiplier change only, no other code).
- Whether to emit a `shadow_apply_step:total` for envelopes that previously
  only emitted per-phase (today's `total` row is already emitted; verify
  on first deploy that we don't end up with double-counting).
