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
blobs[16]  = error_detail   (bounded diagnostic detail for uncoded internal errors)

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

## Step 2a — `/admin/` UI scaffolding (shipped)

- HTTP Basic auth, single fixed user `admin`, password from
  `env.ADMIN_PASSWORD` (Cloudflare secret). Fails closed at 503 when
  the secret is unset.
- `/admin/series?metric=...&groupBy=…&from=&to=&bucket=&filter.…`
  proxies to the AE SQL API with `Account Analytics:Read`.
- Inline HTML page (no separate asset deploy step). First-light shell
  was a single chart with a pivot selector.

## Step 2b — multi-chart dashboard

- Three pivot charts side-by-side (host_key / kind / class) sharing
  one time window — the dashboard's "who, what, where" frame.
- Error-rate chart below them: `status=error` rows, grouped by kind.
- Footprint table below that: per-axis `samples` / `p50_ms` / `p95_ms`
  / `error_rate` for the same window. Axis is selectable
  (class / host_key / route / verb / kind).
- New endpoint `/admin/footprint?groupBy=&from=&to=&filter.=&limit=`
  serves the table — single AE query returning sample-aware aggregates
  (`quantileWeighted(0.5)` and `quantileWeighted(0.95)` over
  `_sample_interval × double2`, so latency percentiles survive both
  AE's adaptive sampling and our 1-in-N manual sampling). Default
  `LIMIT 50`, clamped to `[1, 200]`.
- URL hash carries the lens: `#from=<unix>&to=<unix>&filter.host_key=…`
  so a refresh stays put and links are shareable. No hash → sliding
  window of `range` seconds ending now; range chips (15m/1h/6h/24h/7d)
  reset to sliding.
- Click-drag on any chart sets a new explicit window.
- Click a legend swatch or footprint row pins a filter on its axis;
  filter chips render at the top and clear with ×.
- "Copy wrangler tail" button copies a `wrangler tail woah --search`
  command string with the active filter values, for live drill-in.
- Auto-bucket picker — 1m for ≤2h, 5m for ≤24h, else 1h. Keeps
  charts at ~30–120 data points without operator tuning.
- Sliding-window refresh every 30s; frozen windows are static.

### 2b coverage

`tests/worker/admin.test.ts` now also pins `/admin/footprint`:

- 503 when AE token/account unset.
- 400 on unknown groupBy and on from ≥ to.
- Happy path returns sample-aware aggregates with the expected slot
  mapping (`blob3 AS k` for class, `blob8 = 'error'` for the error
  numerator, `_sample_interval * double2` for the weight).
- Limit clamped to `[1, 200]`.
- Filters land in the WHERE clause with the correct column mapping.
- 502 when AE itself errors.

## Decisions still open

- AE write quotas: monitor first deploy. If `storage_direct_write` at 1/10
  is still hot, drop to 1/100 (multiplier change only, no other code).
- Whether to emit a `shadow_apply_step:total` for envelopes that previously
  only emitted per-phase (today's `total` row is already emitted; verify
  on first deploy that we don't end up with double-counting).
