// /admin/ — operator-facing stats panel.
//
// Routing is wired in `src/worker/index.ts`: any `/admin/*` request goes
// here before the SPA fallback. The page lives in this file as a string
// so we don't add a separate asset deploy step or race with the SPA's
// catchall route.
//
// Endpoints:
//   GET /admin/              — HTML page (HTTP Basic gated)
//   GET /admin/series        — JSON time-series, proxies AE SQL API
//
// Auth model: HTTP Basic, single user `admin`, password from
// `env.ADMIN_PASSWORD`. Fails closed when the secret is unset (503).
// Constant-time string compare; nothing fancier — this is an operator
// panel, not an end-user surface.
//
// Spec: see spec/reference/cloudflare.md §R10.1 (the AE slot map) and
// notes/2026-05-17-admin-stats.md (the step-by-step plan).

import type { Env } from "./persistent-object-do";

const REALM = "woah-admin";
const ADMIN_USER = "admin";

export async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  // Fail closed when the admin secret isn't set. Surfacing as 503 (not
  // 401) so operators don't think "wrong password" — they need to set
  // the secret before /admin/ is usable at all.
  if (!env.ADMIN_PASSWORD) {
    return jsonResponse({ error: { code: "E_ADMIN_DISABLED", message: "ADMIN_PASSWORD is unset; run `wrangler secret put ADMIN_PASSWORD`" } }, 503);
  }

  const authed = checkBasicAuth(request, env.ADMIN_PASSWORD);
  if (!authed) {
    return new Response("Authentication required", {
      status: 401,
      headers: { "www-authenticate": `Basic realm="${REALM}", charset="UTF-8"` }
    });
  }

  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    return new Response(ADMIN_HTML, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // No caching — the dashboard is operator-grade; we'd rather
        // ship an updated HTML on next deploy than ship a stale shell.
        "cache-control": "no-store"
      }
    });
  }

  if (url.pathname === "/admin/series") {
    return await handleSeries(request, env, url);
  }

  if (url.pathname === "/admin/footprint") {
    return await handleFootprint(request, env, url);
  }

  return jsonResponse({ error: { code: "E_NOT_FOUND", message: `no /admin/ route for ${url.pathname}` } }, 404);
}

// ─── Auth ──────────────────────────────────────────────────────────────

function checkBasicAuth(request: Request, expectedPassword: string): boolean {
  const header = request.headers.get("authorization");
  if (!header || !header.toLowerCase().startsWith("basic ")) return false;
  let decoded: string;
  try {
    decoded = atob(header.slice("basic ".length).trim());
  } catch {
    return false;
  }
  const colon = decoded.indexOf(":");
  if (colon < 0) return false;
  const user = decoded.slice(0, colon);
  const pass = decoded.slice(colon + 1);
  // Compare both fields in constant time. A wrong user must not leak
  // password length through early exit.
  return constantTimeEqual(user, ADMIN_USER) && constantTimeEqual(pass, expectedPassword);
}

function constantTimeEqual(a: string, b: string): boolean {
  // Compare on byte arrays so multi-byte characters don't short-circuit.
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  const len = Math.max(ea.length, eb.length);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  }
  return diff === 0;
}

// ─── /admin/series ─────────────────────────────────────────────────────
//
// Query string:
//   metric=count|sum_ms|p95_ms|sum_count    (default: count)
//   groupBy=host_key|kind|scope|class|route|method|phase|what|status|error|target|verb|tool|host|actor|path|reason|error_detail
//                                            (default: host_key)
//   from=<unix-seconds-or-iso>              (default: now - 1h)
//   to=<unix-seconds-or-iso>                (default: now)
//   bucket=1m|5m|1h                         (default: 1m)
//   filter.<dim>=<value>                    (optional, repeatable)
//
// Returns:
//   { metric, groupBy, from, to, bucket, series: [ { key, points: [[unix, value], ...] } ] }
//
// AE SQL spec: index1 is host_key; blob1..blob16 follow the slot map in
// metrics-sink.ts; double1..double3 are ms, sample_rate, count. The
// `_sample_interval` column is AE's own adaptive-sampling multiplier;
// `SUM(_sample_interval * doubleN)` reconstructs sums under both AE
// and our manual sampling layers.

const ALLOWED_GROUP_BY: Record<string, string> = {
  host_key: "index1",
  kind: "blob1",
  scope: "blob2",
  class: "blob3",
  route: "blob4",
  method: "blob5",
  phase: "blob6",
  what: "blob7",
  status: "blob8",
  error: "blob9",
  target: "blob10",
  verb: "blob11",
  tool: "blob12",
  host: "blob13",
  actor: "blob14",
  path: "blob15",
  reason: "blob16",
  error_detail: "blob17"
};

const BUCKET_SECONDS: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "1h": 3600
};

async function handleSeries(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) {
    return jsonResponse({
      error: {
        code: "E_AE_NOT_CONFIGURED",
        message: "CF_ANALYTICS_TOKEN secret and CF_ACCOUNT_ID var must both be set to query Analytics Engine"
      }
    }, 503);
  }

  const params = url.searchParams;
  const metric = (params.get("metric") ?? "count").toLowerCase();
  const groupBy = params.get("groupBy") ?? "host_key";
  const bucket = params.get("bucket") ?? "1m";
  const bucketSeconds = BUCKET_SECONDS[bucket];
  if (!bucketSeconds) {
    return jsonResponse({ error: { code: "E_INVARG", message: `bucket must be one of: ${Object.keys(BUCKET_SECONDS).join(", ")}` } }, 400);
  }
  const groupColumn = ALLOWED_GROUP_BY[groupBy];
  if (!groupColumn) {
    return jsonResponse({ error: { code: "E_INVARG", message: `groupBy must be one of: ${Object.keys(ALLOWED_GROUP_BY).join(", ")}` } }, 400);
  }
  const metricExpr = metricExpression(metric);
  if (!metricExpr) {
    return jsonResponse({ error: { code: "E_INVARG", message: "metric must be one of: count, sum_ms, p95_ms, sum_count" } }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const fromSeconds = parseTime(params.get("from"), now - 3600);
  const toSeconds = parseTime(params.get("to"), now);
  if (fromSeconds >= toSeconds) {
    return jsonResponse({ error: { code: "E_INVARG", message: "from must be < to" } }, 400);
  }
  if (toSeconds - fromSeconds > 14 * 24 * 3600) {
    // AE keeps 90 days, but a single chart that wide is useless and runs
    // the query expensive. Operators who want a wider span should pick a
    // coarser bucket later.
    return jsonResponse({ error: { code: "E_INVARG", message: "from/to window must be ≤ 14 days" } }, 400);
  }

  const filters = buildFilters(params);
  const dataset = env.WOO_AE_DATASET ?? "woo_v1_prod";
  const sql = buildSeriesSql({ dataset, metricExpr, groupColumn, bucketSeconds, fromSeconds, toSeconds, filters });

  const aeResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`,
      "content-type": "text/plain"
    },
    body: sql
  });
  if (!aeResponse.ok) {
    const detail = await safeText(aeResponse);
    return jsonResponse({
      error: { code: "E_AE_QUERY_FAILED", message: `AE returned ${aeResponse.status}`, detail }
    }, 502);
  }
  const parsed = await parseAeResponse(aeResponse);
  const series = groupByKey(parsed);

  return jsonResponse({
    metric,
    groupBy,
    from: fromSeconds,
    to: toSeconds,
    bucket,
    series
  });
}

// ─── /admin/footprint ──────────────────────────────────────────────────
//
// One sample-aware aggregate per `groupBy` value over the chosen window.
// Used by the dashboard's footprint table to show, for each DO class
// (or any other axis), how much traffic it took and how slow / how
// error-prone it was. Single AE query, no time-bucketing — this is the
// summary view; the by-time view lives in /admin/series.
//
// Query string:
//   groupBy=<dim>      (default: class)
//   from=<unix-or-iso> (default: now - 1h)
//   to=<unix-or-iso>   (default: now)
//   limit=<int>        (default: 50, max 200)
//   filter.<dim>=v     (optional, repeatable)
//
// Returns:
//   { groupBy, from, to, rows: [ { key, samples, p50_ms, p95_ms, error_rate } ] }

async function handleFootprint(_request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) {
    return jsonResponse({
      error: { code: "E_AE_NOT_CONFIGURED", message: "CF_ANALYTICS_TOKEN secret and CF_ACCOUNT_ID var must both be set to query Analytics Engine" }
    }, 503);
  }

  const params = url.searchParams;
  const groupBy = params.get("groupBy") ?? "class";
  const groupColumn = ALLOWED_GROUP_BY[groupBy];
  if (!groupColumn) {
    return jsonResponse({ error: { code: "E_INVARG", message: `groupBy must be one of: ${Object.keys(ALLOWED_GROUP_BY).join(", ")}` } }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const fromSeconds = parseTime(params.get("from"), now - 3600);
  const toSeconds = parseTime(params.get("to"), now);
  if (fromSeconds >= toSeconds) {
    return jsonResponse({ error: { code: "E_INVARG", message: "from must be < to" } }, 400);
  }
  if (toSeconds - fromSeconds > 14 * 24 * 3600) {
    return jsonResponse({ error: { code: "E_INVARG", message: "from/to window must be ≤ 14 days" } }, 400);
  }

  let limit = Number(params.get("limit") ?? 50);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  if (limit > 200) limit = 200;

  const filters = buildFilters(params);
  const dataset = env.WOO_AE_DATASET ?? "woo_v1_prod";
  const sql = buildFootprintSql({ dataset, groupColumn, fromSeconds, toSeconds, filters, limit });

  const aeResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, "content-type": "text/plain" },
    body: sql
  });
  if (!aeResponse.ok) {
    const detail = await safeText(aeResponse);
    return jsonResponse({ error: { code: "E_AE_QUERY_FAILED", message: `AE returned ${aeResponse.status}`, detail } }, 502);
  }

  const body = await aeResponse.json() as { data?: Array<Record<string, unknown>> };
  // Mirror parseAeResponse's defensive guard. AE's SQL API normally
  // returns `data: [...]`, but a malformed query or a future format
  // change could surface a non-array (or missing) `data` field. Treat
  // that as an empty result rather than crashing the request with an
  // unhandled TypeError → 500.
  const data = Array.isArray(body.data) ? body.data : [];
  const rows = data.map((row) => ({
    key: String(row.k ?? ""),
    samples: Number(row.samples ?? 0),
    p50_ms: Number(row.p50 ?? 0),
    p95_ms: Number(row.p95 ?? 0),
    error_rate: Number(row.err_rate ?? 0)
  }));

  return jsonResponse({ groupBy, from: fromSeconds, to: toSeconds, rows });
}

interface FootprintSqlInput {
  dataset: string;
  groupColumn: string;
  fromSeconds: number;
  toSeconds: number;
  filters: Array<{ column: string; value: string }>;
  limit: number;
}

function buildFootprintSql(input: FootprintSqlInput): string {
  const { dataset, groupColumn, fromSeconds, toSeconds, filters, limit } = input;
  const filterSql = filters.map(({ column, value }) => `${column} = ${sqlString(value)}`).join(" AND ");
  const where = [
    `timestamp >= toDateTime(${fromSeconds})`,
    `timestamp < toDateTime(${toSeconds})`,
    filterSql
  ].filter(Boolean).join(" AND ");
  // Sample-aware aggregates — `_sample_interval * double2` is the
  // per-point reconstruction multiplier (AE adaptive sampling × our
  // 1-in-N manual sampling). `quantileWeighted` lets us recover an
  // accurate latency percentile even after sampling. The `blob8 =
  // 'error'` selector picks up only the status=error rows for the
  // error-rate ratio.
  return [
    `SELECT`,
    `  ${groupColumn} AS k,`,
    `  SUM(_sample_interval * double2) AS samples,`,
    `  quantileWeighted(0.5)(double1, toUInt32(_sample_interval * double2)) AS p50,`,
    `  quantileWeighted(0.95)(double1, toUInt32(_sample_interval * double2)) AS p95,`,
    `  SUM(_sample_interval * double2 * (blob8 = 'error')) / SUM(_sample_interval * double2) AS err_rate`,
    `FROM ${dataset}`,
    `WHERE ${where}`,
    `GROUP BY k`,
    `ORDER BY samples DESC`,
    `LIMIT ${limit}`
  ].join("\n");
}

function metricExpression(metric: string): string | null {
  // _sample_interval is AE's own adaptive sample multiplier; double2 is
  // our manual sampling multiplier. Multiplying both reconstructs the
  // true population from a sampled point.
  switch (metric) {
    case "count":     return "SUM(_sample_interval * double2)";
    case "sum_ms":    return "SUM(_sample_interval * double2 * double1)";
    case "p95_ms":    return "quantileWeighted(0.95)(double1, toUInt32(_sample_interval * double2))";
    case "sum_count": return "SUM(_sample_interval * double2 * double3)";
    default:          return null;
  }
}

function parseTime(value: string | null, fallback: number): number {
  if (value === null || value === "") return fallback;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) {
    // Numbers > 10^11 are treated as ms; smaller are seconds.
    return asNumber > 1e11 ? Math.floor(asNumber / 1000) : Math.floor(asNumber);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed / 1000);
}

function buildFilters(params: URLSearchParams): Array<{ column: string; value: string }> {
  const filters: Array<{ column: string; value: string }> = [];
  for (const [key, value] of params) {
    if (!key.startsWith("filter.")) continue;
    const dim = key.slice("filter.".length);
    const column = ALLOWED_GROUP_BY[dim];
    if (!column) continue;
    filters.push({ column, value });
  }
  return filters;
}

interface SqlInput {
  dataset: string;
  metricExpr: string;
  groupColumn: string;
  bucketSeconds: number;
  fromSeconds: number;
  toSeconds: number;
  filters: Array<{ column: string; value: string }>;
}

function buildSeriesSql(input: SqlInput): string {
  const { dataset, metricExpr, groupColumn, bucketSeconds, fromSeconds, toSeconds, filters } = input;
  const filterSql = filters.map(({ column, value }) => `${column} = ${sqlString(value)}`).join(" AND ");
  const where = [
    `timestamp >= toDateTime(${fromSeconds})`,
    `timestamp < toDateTime(${toSeconds})`,
    filterSql
  ].filter(Boolean).join(" AND ");
  // intDiv(toUInt32(timestamp), bucket) * bucket → start-of-bucket as
  // unix seconds. Bucketed time goes into the SELECT (column `t`) and
  // GROUP BY together with the chosen group dimension.
  return [
    `SELECT`,
    `  intDiv(toUInt32(timestamp), ${bucketSeconds}) * ${bucketSeconds} AS t,`,
    `  ${groupColumn} AS k,`,
    `  ${metricExpr} AS v`,
    `FROM ${dataset}`,
    `WHERE ${where}`,
    `GROUP BY t, k`,
    `ORDER BY t ASC`,
    `LIMIT 10000`
  ].join("\n");
}

function sqlString(value: string): string {
  // AE SQL supports single-quoted strings with backslash escaping. The
  // only chars we need to escape for safety are single-quote and
  // backslash; everything else can pass through. Inputs come from
  // operator-supplied URL parameters but we already restricted the
  // column names to a fixed allowlist, so the only risk is the value
  // injecting into the string literal.
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

interface AeRow { t: number; k: string; v: number }

async function parseAeResponse(response: Response): Promise<AeRow[]> {
  const body = await response.json() as { data?: Array<Record<string, unknown>>; meta?: unknown };
  if (!body.data || !Array.isArray(body.data)) return [];
  return body.data.map((row) => ({
    t: Number(row.t ?? 0),
    k: String(row.k ?? ""),
    v: Number(row.v ?? 0)
  }));
}

function groupByKey(rows: AeRow[]): Array<{ key: string; points: Array<[number, number]> }> {
  const byKey = new Map<string, Array<[number, number]>>();
  for (const row of rows) {
    let arr = byKey.get(row.k);
    if (!arr) { arr = []; byKey.set(row.k, arr); }
    arr.push([row.t, row.v]);
  }
  return [...byKey.entries()]
    .map(([key, points]) => ({ key, points }))
    .sort((a, b) => sumValues(b.points) - sumValues(a.points));
}

function sumValues(points: Array<[number, number]>): number {
  let s = 0;
  for (const [, v] of points) s += v;
  return s;
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "";
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

// ─── HTML page ─────────────────────────────────────────────────────────
//
// Multi-chart dashboard:
//   - Three pivot charts side-by-side (host_key / kind / class) sharing
//     a single time window — so an operator sees who, what, and where
//     in one glance.
//   - One error-rate chart (status:error rows, by kind) for the same
//     window.
//   - A footprint table (per-class samples / p50 / p95 / error%) below.
//   - URL hash carries the window (`#from=…&to=…&filter.…`) so a
//     refresh keeps the lens and links can be shared.
//   - Click-drag on any chart sets a new window; preset range chips
//     (15m / 1h / 6h / 24h / 7d) clear it back to "from now".
//   - Click a legend swatch to filter every chart and the table to that
//     key. The active filter shows as a chip; click × to clear.
//   - "Copy wrangler tail" button writes a `wrangler tail woah` command
//     to the clipboard tuned for the current filter set (the live tool;
//     can't time-travel, but does narrow the noise).

const ADMIN_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>woah admin</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      --fg: #222;
      --muted: #777;
      --border: #ddd;
      --bg: #fafafa;
      --error: #b00;
      --accent: #1f77b4;
    }
    body { font-family: system-ui, sans-serif; margin: 1rem; color: var(--fg); }
    h1 { font-size: 1.1rem; margin: 0 0 0.5rem; }
    h2 { font-size: 0.85rem; margin: 0 0 0.25rem; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .bar { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.75rem; }
    .bar select, .bar button, .bar input { padding: 0.25rem 0.5rem; font: inherit; }
    .chip { display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.15rem 0.5rem; border: 1px solid var(--border); border-radius: 999px; background: white; font-size: 0.85rem; cursor: pointer; }
    .chip.active { background: var(--accent); color: white; border-color: var(--accent); }
    .filter-chip { background: #fff7d6; border-color: #d8c050; }
    .filter-chip .x { color: var(--muted); font-weight: bold; cursor: pointer; padding: 0 0.25rem; }
    .grid { display: grid; gap: 1rem; grid-template-columns: repeat(3, minmax(0, 1fr)); }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
    .panel { border: 1px solid var(--border); padding: 0.5rem; background: var(--bg); }
    canvas { display: block; width: 100%; height: 180px; background: white; cursor: crosshair; }
    canvas.wide { height: 200px; }
    .legend { font-size: 0.75rem; margin-top: 0.25rem; display: flex; gap: 0.5rem; flex-wrap: wrap; max-height: 4.5em; overflow: auto; }
    .legend .item { display: inline-flex; align-items: center; gap: 0.25rem; cursor: pointer; padding: 0 0.25rem; }
    .legend .item:hover { background: #eee; }
    .swatch { display: inline-block; width: 10px; height: 10px; vertical-align: middle; }
    .status { font-size: 0.8rem; color: var(--muted); margin-top: 0.5rem; min-height: 1em; }
    .status.error { color: var(--error); }
    table.footprint { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
    table.footprint th, table.footprint td { padding: 0.25rem 0.5rem; border-bottom: 1px solid var(--border); text-align: right; }
    table.footprint th:first-child, table.footprint td:first-child { text-align: left; }
    table.footprint tr.clickable:hover { background: #eef; cursor: pointer; }
    .meta { font-size: 0.75rem; color: var(--muted); }
  </style>
</head>
<body>
  <h1>woah admin</h1>
  <div class="bar">
    <span class="meta">range:</span>
    <button class="chip range" data-range="900">15m</button>
    <button class="chip range" data-range="3600">1h</button>
    <button class="chip range" data-range="21600">6h</button>
    <button class="chip range" data-range="86400">24h</button>
    <button class="chip range" data-range="604800">7d</button>
    <span class="meta" id="window-label" style="margin-left:0.5rem;"></span>
    <span style="flex:1;"></span>
    <button id="copy-tail" title="Copy a wrangler tail command tuned for the current filter">copy wrangler tail</button>
  </div>
  <div class="bar" id="filters" style="min-height:1.5rem;">
    <!-- active filters render here -->
  </div>

  <div class="grid">
    <div class="panel">
      <h2>by host_key</h2>
      <canvas data-pivot="host_key"></canvas>
      <div class="legend" data-pivot-legend="host_key"></div>
    </div>
    <div class="panel">
      <h2>by kind</h2>
      <canvas data-pivot="kind"></canvas>
      <div class="legend" data-pivot-legend="kind"></div>
    </div>
    <div class="panel">
      <h2>by class</h2>
      <canvas data-pivot="class"></canvas>
      <div class="legend" data-pivot-legend="class"></div>
    </div>
  </div>

  <div class="panel" style="margin-top:1rem;">
    <h2>errors (status=error, by kind)</h2>
    <canvas id="errors" class="wide"></canvas>
    <div class="legend" id="errors-legend"></div>
  </div>

  <div class="panel" style="margin-top:1rem;">
    <h2 id="footprint-header">footprint by class</h2>
    <div class="bar" style="margin-bottom:0.25rem;">
      <span class="meta">group by:</span>
      <select id="footprint-axis">
        <option value="class" selected>class</option>
        <option value="host_key">host_key</option>
        <option value="route">route</option>
        <option value="verb">verb</option>
        <option value="kind">kind</option>
      </select>
    </div>
    <table class="footprint" id="footprint">
      <thead><tr><th>key</th><th>samples</th><th>p50 ms</th><th>p95 ms</th><th>err %</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>

  <div class="status" id="status"></div>

  <script>
    // ─── Palette ────────────────────────────────────────────────────
    // 20-colour qualitative palette (Tableau 20). Enough to keep small
    // top-N legends distinguishable even when host_key cardinality
    // grows.
    const COLORS = [
      "#1f77b4","#ff7f0e","#2ca02c","#d62728","#9467bd",
      "#8c564b","#e377c2","#7f7f7f","#bcbd22","#17becf",
      "#aec7e8","#ffbb78","#98df8a","#ff9896","#c5b0d5",
      "#c49c94","#f7b6d2","#c7c7c7","#dbdb8d","#9edae5"
    ];
    // Stable colour assignment by key — keeps a host's colour the same
    // across reloads even if its rank shifts.
    const COLOR_CACHE = new Map();
    function colorFor(key) {
      if (!COLOR_CACHE.has(key)) {
        let h = 0;
        for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
        COLOR_CACHE.set(key, COLORS[Math.abs(h) % COLORS.length]);
      }
      return COLOR_CACHE.get(key);
    }

    // ─── URL hash state ────────────────────────────────────────────
    // Window state and active filters live in location.hash so a
    // refresh keeps the lens and operators can share a URL.
    //   from=<unix>&to=<unix>&filter.host_key=…&filter.kind=…
    // Empty/missing from/to → "last 1h from now-on-load".
    function readState() {
      const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
      const params = new URLSearchParams(hash);
      const fromRaw = params.get('from');
      const toRaw = params.get('to');
      const filters = {};
      for (const [k, v] of params) if (k.startsWith('filter.')) filters[k.slice(7)] = v;
      const range = Number(params.get('range') || '3600');
      return {
        from: fromRaw ? Number(fromRaw) : null,
        to: toRaw ? Number(toRaw) : null,
        range,
        filters
      };
    }
    function writeState(state) {
      const params = new URLSearchParams();
      if (state.from && state.to) {
        params.set('from', String(state.from));
        params.set('to', String(state.to));
      } else if (state.range) {
        params.set('range', String(state.range));
      }
      for (const [k, v] of Object.entries(state.filters || {})) params.set('filter.' + k, v);
      const s = params.toString();
      const target = s ? '#' + s : '';
      if (location.hash !== target) history.replaceState(null, '', location.pathname + (s ? '#' + s : ''));
    }
    function resolveWindow(state) {
      // Explicit window in hash wins; otherwise a sliding window of
      // state.range seconds ending now (computed at each reload, so
      // a parked "1h" view keeps rolling forward).
      if (state.from && state.to) return { from: state.from, to: state.to, sliding: false };
      const now = Math.floor(Date.now() / 1000);
      return { from: now - state.range, to: now, sliding: true };
    }
    function pickBucket(spanSeconds) {
      // Auto-bucket: aim for ~30–120 buckets per chart. AE happily
      // serves any of these; finer is just chart noise.
      if (spanSeconds <= 2 * 3600) return '1m';
      if (spanSeconds <= 24 * 3600) return '5m';
      return '1h';
    }

    // ─── Fetching ──────────────────────────────────────────────────
    function buildSeriesQS(opts) {
      const qs = new URLSearchParams({
        groupBy: opts.groupBy,
        metric: opts.metric || 'count',
        bucket: opts.bucket,
        from: String(opts.from),
        to: String(opts.to)
      });
      for (const [k, v] of Object.entries(opts.filters || {})) qs.set('filter.' + k, v);
      if (opts.extraFilter) qs.set('filter.' + opts.extraFilter[0], opts.extraFilter[1]);
      return qs;
    }
    async function fetchSeries(opts) {
      const r = await fetch('/admin/series?' + buildSeriesQS(opts).toString());
      if (!r.ok) throw new Error('HTTP ' + r.status + ' on /admin/series');
      return await r.json();
    }
    async function fetchFootprint(opts) {
      const qs = new URLSearchParams({ groupBy: opts.groupBy, from: String(opts.from), to: String(opts.to) });
      for (const [k, v] of Object.entries(opts.filters || {})) qs.set('filter.' + k, v);
      const r = await fetch('/admin/footprint?' + qs.toString());
      if (!r.ok) throw new Error('HTTP ' + r.status + ' on /admin/footprint');
      return await r.json();
    }

    // ─── Chart drawing ─────────────────────────────────────────────
    // One stacked-area chart per pivot. data.series is already sorted
    // descending by total; the top 9 paint coloured, the rest fold into
    // a grey "other" band so the chart stays legible at high cardinality.
    const MAX_VISIBLE = 9;
    function compactSeries(series) {
      if (series.length <= MAX_VISIBLE + 1) return { kept: series, other: null };
      const kept = series.slice(0, MAX_VISIBLE);
      const restPoints = new Map();
      for (const s of series.slice(MAX_VISIBLE)) {
        for (const [t, v] of s.points) restPoints.set(t, (restPoints.get(t) || 0) + v);
      }
      const other = { key: '(other ' + (series.length - MAX_VISIBLE) + ')', points: [...restPoints.entries()].sort((a,b) => a[0]-b[0]) };
      return { kept, other };
    }

    function drawArea(canvas, data, opts) {
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
      canvas.width = cssW * dpr; canvas.height = cssH * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr); ctx.clearRect(0, 0, cssW, cssH);

      const tSet = new Set();
      for (const s of data.series) for (const [t] of s.points) tSet.add(t);
      const ts = [...tSet].sort((a, b) => a - b);
      const padL = 40, padR = 6, padT = 6, padB = 18;
      const w = cssW - padL - padR;
      const h = cssH - padT - padB;

      // Axes always visible — gives the eye an empty-state cue.
      ctx.strokeStyle = '#ccc';
      ctx.beginPath();
      ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + h); ctx.lineTo(padL + w, padT + h);
      ctx.stroke();
      if (ts.length === 0) {
        ctx.fillStyle = '#bbb';
        ctx.font = '11px system-ui';
        ctx.fillText('no data in window', padL + 8, padT + h / 2);
        return { ts: [], xAt: () => 0 };
      }

      const valueAt = (s, t) => {
        if (!s._byT) { s._byT = new Map(s.points); }
        return s._byT.get(t) || 0;
      };

      let maxV = 0;
      for (const t of ts) {
        let stack = 0;
        for (const s of data.series) stack += valueAt(s, t);
        if (stack > maxV) maxV = stack;
      }
      if (maxV <= 0) maxV = 1;

      const xAt = i => padL + (w * i) / Math.max(1, ts.length - 1);
      const yAt = v => padT + h - (h * v) / maxV;
      const stackTops = new Array(ts.length).fill(0);
      data.series.forEach((s, idx) => {
        const color = s.key.startsWith('(other') ? '#bbb' : colorFor(s.key);
        ctx.beginPath();
        for (let i = 0; i < ts.length; i++) {
          const top = stackTops[i] + valueAt(s, ts[i]);
          const x = xAt(i), y = yAt(top);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        for (let i = ts.length - 1; i >= 0; i--) ctx.lineTo(xAt(i), yAt(stackTops[i]));
        ctx.closePath();
        ctx.fillStyle = color + 'cc';
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.stroke();
        for (let i = 0; i < ts.length; i++) stackTops[i] += valueAt(s, ts[i]);
      });

      ctx.fillStyle = '#666'; ctx.font = '10px system-ui';
      ctx.fillText(String(Math.round(maxV)), 2, padT + 9);
      ctx.fillText('0', padL - 10, padT + h);
      ctx.fillText(new Date(ts[0] * 1000).toLocaleTimeString(), padL, padT + h + 12);
      ctx.fillText(new Date(ts[ts.length - 1] * 1000).toLocaleTimeString(), padL + w - 40, padT + h + 12);

      // Snapshot the painted chart in raw pixels so bindZoom can repaint
      // it under each pointermove overlay without rebuilding from data.
      // putImageData operates in canvas pixel space (ignores transform),
      // so the snapshot rectangle uses canvas.width/height, not cssW/cssH.
      try { canvas._snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height); } catch {}

      return { ts, xAt, padL, padR, padT, padB, w, h, cssW, cssH };
    }

    function renderLegend(node, series, opts) {
      node.innerHTML = '';
      for (const s of series) {
        const item = document.createElement('span');
        item.className = 'item';
        const sw = document.createElement('span');
        sw.className = 'swatch';
        sw.style.background = s.key.startsWith('(other') ? '#bbb' : colorFor(s.key);
        item.appendChild(sw);
        item.appendChild(document.createTextNode(s.key || '(empty)'));
        // Clicking a legend entry pins it as a filter across every chart.
        item.addEventListener('click', () => {
          if (s.key.startsWith('(other')) return;
          opts.onPick(s.key);
        });
        node.appendChild(item);
      }
    }

    // ─── Click-drag zoom ───────────────────────────────────────────
    // Pointer-down → record x; pointer-move → paint overlay; pointer-up
    // → convert pixel range back to time and apply.
    function bindZoom(canvas, getGeom, onZoom) {
      let downX = null;
      canvas.addEventListener('pointerdown', (e) => {
        const rect = canvas.getBoundingClientRect();
        downX = e.clientX - rect.left;
        canvas.setPointerCapture(e.pointerId);
      });
      canvas.addEventListener('pointermove', (e) => {
        if (downX === null) return;
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const geom = getGeom();
        if (!geom || !geom.ts.length) return;
        // Restore the chart from the snapshot captured at end of paint
        // (drawArea stashes it on canvas._snapshot). Without this, every
        // pointermove stacks another translucent rect onto the canvas
        // and a long drag paints a visibly darkening stripe.
        const ctx = canvas.getContext('2d');
        if (canvas._snapshot) ctx.putImageData(canvas._snapshot, 0, 0);
        ctx.save();
        ctx.fillStyle = 'rgba(31,119,180,0.18)';
        ctx.strokeStyle = '#1f77b4';
        ctx.lineWidth = 1;
        const ox = Math.min(downX, x);
        const ow = Math.abs(x - downX);
        ctx.fillRect(ox, geom.padT, ow, geom.h);
        ctx.strokeRect(ox + 0.5, geom.padT + 0.5, Math.max(0, ow - 1), Math.max(0, geom.h - 1));
        ctx.restore();
      });
      const finish = (e) => {
        if (downX === null) return;
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const geom = getGeom();
        // Capture downX into a local before nulling. Reading downX in the
        // expression below after assigning downX = null would (silently)
        // always resolve to x and reduce every drag to a zero-width
        // selection — silent breakage with no test coverage.
        const down = downX;
        downX = null;
        if (!geom || !geom.ts.length) return;
        const a = Math.min(down, x), b = Math.max(down, x);
        // Restore the chart so any in-flight overlay rect from pointermove
        // doesn't linger after pointerup. The next render() will redraw
        // anyway when zoom triggers, but on a sub-threshold drag the
        // chart should clean up immediately.
        if (canvas._snapshot) canvas.getContext('2d').putImageData(canvas._snapshot, 0, 0);
        if (b - a < 6) return;  // ignore accidental drags
        const tFromPx = (px) => {
          // Inverse of xAt: px = padL + w * i / (n-1)  → i = (px - padL) * (n-1) / w
          const i = Math.max(0, Math.min(geom.ts.length - 1, Math.round((px - geom.padL) * (geom.ts.length - 1) / geom.w)));
          return geom.ts[i];
        };
        // Buckets are start-of-bucket; the right edge of the last
        // selected bucket is one bucket-width after its timestamp.
        // Pull bucket width from the timestamp delta when there are
        // ≥2 points; otherwise default to 60s.
        const bucketDelta = geom.ts.length >= 2 ? (geom.ts[1] - geom.ts[0]) : 60;
        const newFrom = tFromPx(a);
        const newTo = tFromPx(b) + bucketDelta;
        onZoom(newFrom, newTo);
      };
      canvas.addEventListener('pointerup', finish);
      canvas.addEventListener('pointercancel', finish);
    }

    // ─── Main render ───────────────────────────────────────────────
    let lastWindow = null;
    let geometriesByPivot = new Map();
    let errorsGeom = null;

    async function render() {
      const state = readState();
      writeState(state);
      const win = resolveWindow(state);
      lastWindow = win;
      const bucket = pickBucket(win.to - win.from);
      const status = document.getElementById('status');
      status.textContent = 'loading ' + (win.sliding ? 'sliding ' : '') + 'window ' + new Date(win.from*1000).toLocaleString() + ' → ' + new Date(win.to*1000).toLocaleString() + ', bucket ' + bucket + '…';
      status.classList.remove('error');

      updateRangeChips(state, win);
      updateFiltersChips(state);
      updateWindowLabel(win, bucket);

      const opts = { from: win.from, to: win.to, bucket, filters: state.filters };
      try {
        const [hostKeys, kinds, classes, errors, footprint] = await Promise.all([
          fetchSeries({ ...opts, groupBy: 'host_key' }),
          fetchSeries({ ...opts, groupBy: 'kind' }),
          fetchSeries({ ...opts, groupBy: 'class' }),
          fetchSeries({ ...opts, groupBy: 'kind', metric: 'count', extraFilter: ['status', 'error'] }),
          fetchFootprint({ groupBy: document.getElementById('footprint-axis').value, from: win.from, to: win.to, filters: state.filters })
        ]);
        paintPivot('host_key', hostKeys, state);
        paintPivot('kind', kinds, state);
        paintPivot('class', classes, state);
        paintErrors(errors, state);
        paintFootprint(footprint);
        status.textContent = 'ok — ' + new Date(win.from*1000).toLocaleString() + ' → ' + new Date(win.to*1000).toLocaleString();
      } catch (err) {
        status.textContent = String(err);
        status.classList.add('error');
      }
    }

    function paintPivot(pivot, data, state) {
      const canvas = document.querySelector('canvas[data-pivot="' + pivot + '"]');
      const legend = document.querySelector('[data-pivot-legend="' + pivot + '"]');
      const { kept, other } = compactSeries(data.series);
      const seriesForChart = other ? kept.concat([other]) : kept;
      const geom = drawArea(canvas, { ...data, series: seriesForChart }, {});
      geometriesByPivot.set(pivot, geom);
      renderLegend(legend, seriesForChart, {
        onPick: (key) => {
          state.filters[pivot] = key;
          writeState(state);
          render();
        }
      });
      // Bind zoom once per canvas (idempotent — checks a marker).
      if (!canvas._zoomBound) {
        canvas._zoomBound = true;
        bindZoom(canvas, () => geometriesByPivot.get(pivot), (from, to) => {
          const s = readState();
          s.from = from; s.to = to;
          writeState(s);
          render();
        });
      }
    }

    function paintErrors(data, state) {
      const canvas = document.getElementById('errors');
      const legend = document.getElementById('errors-legend');
      const { kept, other } = compactSeries(data.series);
      const seriesForChart = other ? kept.concat([other]) : kept;
      const geom = drawArea(canvas, { ...data, series: seriesForChart }, {});
      errorsGeom = geom;
      renderLegend(legend, seriesForChart, {
        onPick: (key) => {
          state.filters.kind = key;
          state.filters.status = 'error';
          writeState(state);
          render();
        }
      });
      if (!canvas._zoomBound) {
        canvas._zoomBound = true;
        bindZoom(canvas, () => errorsGeom, (from, to) => {
          const s = readState();
          s.from = from; s.to = to;
          writeState(s);
          render();
        });
      }
    }

    function paintFootprint(data) {
      const tbody = document.querySelector('#footprint tbody');
      tbody.innerHTML = '';
      document.getElementById('footprint-header').textContent = 'footprint by ' + data.groupBy;
      if (!data.rows.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 5; td.style.color = '#999'; td.textContent = '(no data)';
        tr.appendChild(td); tbody.appendChild(tr);
        return;
      }
      for (const row of data.rows) {
        const tr = document.createElement('tr');
        tr.className = 'clickable';
        tr.addEventListener('click', () => {
          const s = readState();
          s.filters[data.groupBy] = row.key;
          writeState(s);
          render();
        });
        tr.innerHTML = '<td>' + (escapeHtml(row.key) || '<span style="color:#999">(empty)</span>') + '</td>'
          + '<td>' + Math.round(row.samples) + '</td>'
          + '<td>' + Math.round(row.p50_ms) + '</td>'
          + '<td>' + Math.round(row.p95_ms) + '</td>'
          + '<td>' + (row.error_rate * 100).toFixed(2) + '</td>';
        tbody.appendChild(tr);
      }
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;' }[c]));
    }

    // ─── Controls ──────────────────────────────────────────────────
    function updateRangeChips(state, win) {
      const chips = document.querySelectorAll('.chip.range');
      chips.forEach(c => {
        const r = Number(c.dataset.range);
        c.classList.toggle('active', win.sliding && state.range === r);
      });
    }
    function updateWindowLabel(win, bucket) {
      const label = document.getElementById('window-label');
      const span = win.to - win.from;
      const human = span < 3600 ? Math.round(span/60) + 'm' : span < 86400 ? (span/3600).toFixed(1) + 'h' : (span/86400).toFixed(1) + 'd';
      label.textContent = 'window: ' + human + ' • bucket: ' + bucket + (win.sliding ? '' : ' • frozen');
    }
    function updateFiltersChips(state) {
      const container = document.getElementById('filters');
      container.innerHTML = '';
      const keys = Object.keys(state.filters);
      if (!keys.length) {
        const muted = document.createElement('span');
        muted.className = 'meta';
        muted.textContent = 'no filters';
        container.appendChild(muted);
        return;
      }
      for (const k of keys) {
        const chip = document.createElement('span');
        chip.className = 'chip filter-chip';
        chip.appendChild(document.createTextNode(k + ' = ' + state.filters[k]));
        const x = document.createElement('span');
        x.className = 'x';
        x.textContent = '×';
        x.addEventListener('click', () => {
          delete state.filters[k];
          writeState(state);
          render();
        });
        chip.appendChild(x);
        container.appendChild(chip);
      }
    }

    document.querySelectorAll('.chip.range').forEach(c => {
      c.addEventListener('click', () => {
        const s = readState();
        s.range = Number(c.dataset.range);
        s.from = null; s.to = null;
        writeState(s);
        render();
      });
    });
    document.getElementById('footprint-axis').addEventListener('change', render);
    window.addEventListener('hashchange', render);
    document.getElementById('copy-tail').addEventListener('click', async () => {
      const state = readState();
      // wrangler tail filters by --search (substring against the log
      // line). We string-join filter values into one search term so a
      // typical narrow filter (e.g. host_key=the_chatroom) zeroes in on
      // its emissions. wrangler tail can't time-travel, so the user
      // gets a live tail tuned to the same filter axis they were
      // looking at; copy → paste into a terminal.
      const terms = Object.values(state.filters);
      const search = terms.length ? ' --search ' + JSON.stringify(terms.join(' ')) : '';
      const cmd = 'npx --no-install wrangler tail woah --format pretty' + search;
      try {
        await navigator.clipboard.writeText(cmd);
        const status = document.getElementById('status');
        status.textContent = 'copied: ' + cmd;
        status.classList.remove('error');
      } catch {
        const status = document.getElementById('status');
        status.textContent = cmd;
        status.classList.add('error');
      }
    });

    // ─── First paint ───────────────────────────────────────────────
    render();
    // Light auto-refresh on sliding windows so the dashboard breathes.
    setInterval(() => {
      const state = readState();
      if (!state.from || !state.to) render();
    }, 30000);
  </script>
</body>
</html>`;
