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
//   groupBy=host_key|kind|scope|class|route|method|phase|what|status|error|target|verb|tool|host|actor|path|reason
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
  reason: "blob16"
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
// Minimal first-light shell: one chart, one pivot, last hour. Step 2b
// will add the other pivots, the click-drag window, and the
// tail-command export.

const ADMIN_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>woah admin</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: system-ui, sans-serif; margin: 1rem; color: #222; }
    h1 { font-size: 1.2rem; margin: 0 0 0.5rem; }
    .controls { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem; flex-wrap: wrap; }
    select, button { padding: 0.25rem 0.5rem; font: inherit; }
    canvas { max-width: 100%; height: 320px; background: #fafafa; border: 1px solid #ddd; }
    .legend { font-size: 0.85rem; margin-top: 0.5rem; display: flex; gap: 1rem; flex-wrap: wrap; }
    .swatch { display: inline-block; width: 10px; height: 10px; margin-right: 4px; vertical-align: middle; }
    .status { font-size: 0.85rem; color: #666; margin-top: 0.5rem; min-height: 1rem; }
    .status.error { color: #b00; }
  </style>
</head>
<body>
  <h1>woah admin — traffic (last hour, 1-minute buckets)</h1>
  <div class="controls">
    <label>group by
      <select id="groupBy">
        <option value="host_key" selected>host_key</option>
        <option value="kind">kind</option>
        <option value="class">class</option>
        <option value="status">status</option>
      </select>
    </label>
    <label>metric
      <select id="metric">
        <option value="count" selected>count</option>
        <option value="sum_ms">sum_ms</option>
        <option value="p95_ms">p95_ms</option>
      </select>
    </label>
    <button id="refresh">refresh</button>
  </div>
  <canvas id="chart" width="800" height="320"></canvas>
  <div class="legend" id="legend"></div>
  <div class="status" id="status"></div>
  <script>
    // Palette tuned so adjacent series remain distinguishable even
    // when stacked. Picked from Cloudflare's brand-neutral discrete
    // palette so re-skinning is a search-and-replace.
    const COLORS = ["#1f77b4","#ff7f0e","#2ca02c","#d62728","#9467bd","#8c564b","#e377c2","#7f7f7f","#bcbd22","#17becf"];

    async function load() {
      const groupBy = document.getElementById('groupBy').value;
      const metric = document.getElementById('metric').value;
      const status = document.getElementById('status');
      status.textContent = 'loading…';
      status.classList.remove('error');
      try {
        const params = new URLSearchParams({ groupBy, metric, bucket: '1m' });
        const r = await fetch('/admin/series?' + params.toString());
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error((body.error && body.error.message) || ('HTTP ' + r.status));
        }
        const data = await r.json();
        draw(data);
        status.textContent = 'ok — ' + data.series.length + ' series, window ' + data.from + '…' + data.to;
      } catch (err) {
        status.textContent = String(err);
        status.classList.add('error');
      }
    }

    function draw(data) {
      const canvas = document.getElementById('chart');
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
      canvas.width = cssW * dpr;
      canvas.height = cssH * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, cssW, cssH);

      // Build the union of bucket timestamps so the x-axis is continuous
      // even when some series have gaps.
      const tSet = new Set();
      for (const s of data.series) for (const [t] of s.points) tSet.add(t);
      const ts = [...tSet].sort((a, b) => a - b);
      if (ts.length === 0) return;
      const valueAt = (s, t) => {
        // Series points are already (t, v); use a Map lookup for speed
        // when series are dense.
        if (!s._byT) { s._byT = new Map(s.points); }
        return s._byT.get(t) || 0;
      };

      const padL = 50, padR = 10, padT = 10, padB = 24;
      const w = cssW - padL - padR;
      const h = cssH - padT - padB;
      let maxV = 0;
      for (const t of ts) {
        let stack = 0;
        for (const s of data.series) stack += valueAt(s, t);
        if (stack > maxV) maxV = stack;
      }
      if (maxV <= 0) maxV = 1;

      const xAt = i => padL + (w * i) / Math.max(1, ts.length - 1);
      const yAt = v => padT + h - (h * v) / maxV;

      // Stacked area, top-down (top series painted last so it sits on top).
      const stackTops = new Array(ts.length).fill(0);
      data.series.forEach((s, idx) => {
        const color = COLORS[idx % COLORS.length];
        ctx.beginPath();
        for (let i = 0; i < ts.length; i++) {
          const top = stackTops[i] + valueAt(s, ts[i]);
          const x = xAt(i), y = yAt(top);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        for (let i = ts.length - 1; i >= 0; i--) {
          const x = xAt(i), y = yAt(stackTops[i]);
          ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fillStyle = color + 'cc';
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.stroke();
        for (let i = 0; i < ts.length; i++) stackTops[i] += valueAt(s, ts[i]);
      });

      // Axes.
      ctx.strokeStyle = '#aaa';
      ctx.beginPath();
      ctx.moveTo(padL, padT);
      ctx.lineTo(padL, padT + h);
      ctx.lineTo(padL + w, padT + h);
      ctx.stroke();

      ctx.fillStyle = '#666';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(String(Math.round(maxV)), 2, padT + 10);
      ctx.fillText('0', padL - 12, padT + h);
      ctx.fillText(new Date(ts[0] * 1000).toLocaleTimeString(), padL, padT + h + 14);
      ctx.fillText(new Date(ts[ts.length - 1] * 1000).toLocaleTimeString(), padL + w - 50, padT + h + 14);

      // Legend.
      const legend = document.getElementById('legend');
      legend.innerHTML = '';
      data.series.forEach((s, idx) => {
        const span = document.createElement('span');
        const sw = document.createElement('span');
        sw.className = 'swatch';
        sw.style.background = COLORS[idx % COLORS.length];
        span.appendChild(sw);
        span.appendChild(document.createTextNode(s.key || '(empty)'));
        legend.appendChild(span);
      });
    }

    document.getElementById('refresh').addEventListener('click', load);
    document.getElementById('groupBy').addEventListener('change', load);
    document.getElementById('metric').addEventListener('change', load);
    load();
  </script>
</body>
</html>`;
