// net-metrics-report — the NC8 canary dashboard, offline half
// (spec/operations/net-cutover.md NC8). Aggregates `woo.metric` lines
// into the series the deploy/canary decision reads: turn structure
// (wall/RPC percentiles, retry and reconstruction rates, budget
// refusals), authority submits (hot scopes, fanout volume), push/scan
// audience costs, outbox health (abandonments = named divergence),
// scheduler lag, and the degraded-path counters.
//
//   wrangler tail --format json | npx tsx scripts/net-metrics-report.ts
//   npx tsx scripts/net-metrics-report.ts capture.log [--json]
//
// Input tolerance: any text stream — raw workerd logs, wrangler-tail
// JSON events, vitest output — anything carrying `woo.metric {…}`
// substrings. Unparseable lines are skipped, never fatal.
import { readFileSync } from "node:fs";

type Metric = Record<string, unknown> & { kind?: string };

/**
 * Reviewer finding 7: the previous balanced-brace scan silently missed
 * Cloudflare tail's shape — `{logs:[{message:["woo.metric","{…}"]}]}` —
 * where the metric JSON is a STRING ELEMENT of a message array (and
 * escaped when the whole event is re-stringified). The extractor is now
 * structural first: each input line parses as JSON when it can, and
 * every string found while walking the value tree is scanned for
 * `woo.metric {…}` payloads (so both tail events and raw workerd/vitest
 * lines feed the same path). Exported for tests.
 */
export function extractMetrics(text: string): Metric[] {
  const metrics: Metric[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let structural: unknown = null;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        structural = JSON.parse(trimmed);
      } catch {
        structural = null;
      }
    }
    if (structural !== null) collectFromValue(structural, metrics);
    else collectFromString(trimmed, metrics);
  }
  return metrics;
}

/** Walk a parsed tail event: message arrays carry console args as
 * strings ("woo.metric" followed by the JSON payload string, or one
 * concatenated string); nested objects/arrays walk recursively. */
function collectFromValue(value: unknown, out: Metric[]): void {
  if (typeof value === "string") {
    collectFromString(value, out);
    return;
  }
  if (Array.isArray(value)) {
    // The exact console-args shape: ["woo.metric", "{...}"] — the
    // payload string follows the marker with no marker text of its own.
    for (let i = 0; i < value.length; i += 1) {
      if (value[i] === "woo.metric" && typeof value[i + 1] === "string") {
        try {
          out.push(JSON.parse(value[i + 1] as string) as Metric);
          i += 1;
          continue;
        } catch {
          // fall through to the generic walk
        }
      }
      collectFromValue(value[i], out);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectFromValue(entry, out);
  }
}

/** Scan one decoded string for `woo.metric {…}` payloads (raw logs).
 * A string that is ITSELF JSON (a re-stringified tail event — loggers
 * love to re-quote) unwraps back into the structural walk, however
 * deep the nesting goes. */
function collectFromString(text: string, out: Metric[]): void {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      collectFromValue(JSON.parse(trimmed), out);
      return;
    } catch {
      // not JSON — fall through to the marker scan
    }
  }
  const marker = "woo.metric";
  let index = 0;
  while ((index = text.indexOf(marker, index)) !== -1) {
    const braceStart = text.indexOf("{", index);
    if (braceStart === -1) break;
    let depth = 0;
    let end = -1;
    let inString = false;
    for (let i = braceStart; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") i += 1;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break;
    try {
      out.push(JSON.parse(text.slice(braceStart, end + 1)) as Metric);
    } catch {
      // not a metric payload — skip
    }
    index = end + 1;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function series(values: number[]): { count: number; p50: number; p95: number; p99: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? 0
  };
}

function numbers(metrics: Metric[], field: string): number[] {
  return metrics.map((m) => m[field]).filter((v): v is number => typeof v === "number");
}

export function buildReport(metrics: Metric[]): Record<string, unknown> {
  const byKind = new Map<string, Metric[]>();
  for (const metric of metrics) {
    if (typeof metric.kind !== "string") continue;
    byKind.set(metric.kind, [...(byKind.get(metric.kind) ?? []), metric]);
  }
  const kind = (name: string) => byKind.get(name) ?? [];

  const turns = kind("net_turn_structure");
  const retried = turns.filter((m) => typeof m.attempt === "number" && m.attempt > 1);
  const reconstructed = turns.filter((m) => typeof m.reconstructions === "number" && m.reconstructions > 0);

  const submits = kind("net_scope_submit");
  const submitsByScope = new Map<string, number>();
  for (const submit of submits) {
    const scope = String(submit.scope ?? "?");
    submitsByScope.set(scope, (submitsByScope.get(scope) ?? 0) + 1);
  }
  const hottest = [...submitsByScope.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  const drains = kind("net_scope_outbox_drain_pass");
  const sum = (rows: Metric[], field: string) => rows.reduce((n, m) => n + (typeof m[field] === "number" ? (m[field] as number) : 0), 0);

  return {
    // --- the turn envelope (gateway) ---
    turns: {
      total: turns.length,
      wall_ms: series(numbers(turns, "wall_ms")),
      rpc_ms: series(numbers(turns, "rpc_ms")),
      sync_rpc: series(numbers(turns, "sync_rpc")),
      rpc_depth: series(numbers(turns, "rpc_depth")),
      plan_cells: series(numbers(turns, "plan_cells")),
      envelope_bytes: series(numbers(turns, "envelope_bytes")),
      retry_rate: turns.length > 0 ? retried.length / turns.length : 0,
      reconstruction_rate: turns.length > 0 ? reconstructed.length / turns.length : 0
    },
    // --- authority serialization (hot scopes) ---
    submits: {
      total: submits.length,
      ms: series(numbers(submits, "ms")),
      outbox_enqueued: sum(submits, "outbox_enqueued"),
      hottest_scopes: hottest.map(([scope, count]) => ({ scope, count }))
    },
    // --- fanout & audience cost ---
    push: {
      total: kind("net_push").length,
      audience: series(numbers(kind("net_push"), "audience")),
      frames: sum(kind("net_push"), "frames")
    },
    presence_scan_rows: series(numbers(kind("net_presence_scan"), "presence_scan_rows")),
    // --- outbox health (abandoned = named divergence: page on sustained > 0) ---
    outbox: {
      drain_passes: drains.length,
      delivered: sum(drains, "delivered"),
      failed: sum(drains, "failed"),
      abandoned: sum(drains, "abandoned") + kind("net_scope_outbox_abandoned").length
    },
    // --- scheduler ---
    scheduled: {
      dispatched: kind("net_scope_scheduled_turn_dispatched").length,
      lag_ms: series(numbers(kind("net_scope_scheduled_turn_dispatched"), "lag_ms"))
    },
    // --- degraded/divergence counters (each nonzero deserves a look) ---
    incidents: {
      fanout_gaps: kind("net_fanout_gap").length,
      install_degraded: kind("net_turn_install_degraded").length + kind("net_session_open_install_degraded").length,
      seed_lag: kind("net_seed_lag").length,
      pin_overrides: kind("net_turn_selection_pin_override").length,
      adopt_conflicts: kind("net_adopt_conflict").length,
      sessions_reaped: kind("net_session_reaped").length
    }
  };
}

/**
 * The abort signals over a report (V3 finding 6: evaluated the same way
 * for a bounded batch and for each streaming interval — a canary must
 * detect a divergence DURING the bake, not only after its input closes).
 * `emptyIsAbort` off in --watch's early intervals (no turns yet ≠ dead
 * feed); the batch path requires a minimum sample.
 */
export function abortSignals(
  report: ReturnType<typeof buildReport>,
  metricLines: number,
  options: { emptyIsAbort?: boolean } = {}
): string[] {
  const r = report as {
    outbox: { abandoned: number };
    incidents: { fanout_gaps: number };
    turns: { total: number; retry_rate: number };
  };
  const alerts: string[] = [];
  if (options.emptyIsAbort && metricLines === 0) {
    alerts.push("ABORT-SIGNAL: 0 metric lines parsed — the tail shape, worker, or filter is wrong (--allow-empty to override)");
  } else if (options.emptyIsAbort && r.turns.total === 0) {
    alerts.push("ABORT-SIGNAL: no net_turn_structure samples — the canary saw no turns (--allow-empty to override)");
  }
  if (r.outbox.abandoned > 0) alerts.push(`ABORT-SIGNAL: ${r.outbox.abandoned} outbox abandonment(s) — named divergence`);
  if (r.incidents.fanout_gaps > 0) alerts.push(`ABORT-SIGNAL: ${r.incidents.fanout_gaps} fanout gap(s)`);
  if (r.turns.total >= 20 && r.turns.retry_rate > 0.2) {
    alerts.push(`ABORT-SIGNAL: retry rate ${(r.turns.retry_rate * 100).toFixed(0)}% > 20%`);
  }
  return alerts;
}

async function readInput(path: string | undefined): Promise<string> {
  if (path) return readFileSync(path, "utf8");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * V3 finding 6: --watch INCREMENTAL mode for the bake's long-running
 * `wrangler tail | net-metrics-report --watch`. Parses stdin line by
 * line as it arrives, prints a rolling report every `--interval` seconds
 * (default 30), and EXITS 2 THE MOMENT a divergence signal fires (an
 * abandonment / fanout gap / sustained retry) — it does not wait for the
 * pipe to close. `--min-turns` / `--min-seconds` gate the final
 * exit-0-only-if-enough-evidence rule when the stream ends cleanly.
 */
async function runWatch(intervalMs: number, minTurns: number, minSeconds: number): Promise<void> {
  const metrics: Metric[] = [];
  let carry = "";
  const startedAt = Date.now();
  const evaluate = (final: boolean): void => {
    const report = buildReport(metrics);
    const turns = (report as { turns: { total: number } }).turns.total;
    console.error(`[watch ${Math.round((Date.now() - startedAt) / 1000)}s] ${metrics.length} metrics, ${turns} turns`);
    // Divergence signals abort IMMEDIATELY, mid-bake.
    const diverged = abortSignals(report, metrics.length, { emptyIsAbort: false });
    if (diverged.length > 0) {
      for (const alert of diverged) console.error(alert);
      console.log(JSON.stringify({ metric_lines: metrics.length, ...report }, null, 2));
      process.exit(2);
    }
    if (final) {
      console.log(JSON.stringify({ metric_lines: metrics.length, ...report }, null, 2));
      const elapsedS = (Date.now() - startedAt) / 1000;
      const shortfalls: string[] = [];
      if (turns < minTurns) shortfalls.push(`only ${turns} turns (need ${minTurns})`);
      if (elapsedS < minSeconds) shortfalls.push(`only ${Math.round(elapsedS)}s (need ${minSeconds}s)`);
      if (shortfalls.length > 0) {
        console.error(`ABORT-SIGNAL: insufficient canary evidence — ${shortfalls.join(", ")}`);
        process.exit(2);
      }
    }
  };
  const ticker = setInterval(() => evaluate(false), intervalMs);
  try {
    for await (const chunk of process.stdin) {
      carry += (chunk as Buffer).toString("utf8");
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) collectFromLine(line, metrics);
    }
    if (carry.trim()) collectFromLine(carry, metrics);
  } finally {
    clearInterval(ticker);
  }
  evaluate(true);
}

/** One input line → metrics (the extractMetrics per-line logic, exposed
 * for the streaming path). */
function collectFromLine(line: string, out: Metric[]): void {
  for (const metric of extractMetrics(line)) out.push(metric);
}

const invokedDirectly = process.argv[1]?.endsWith("net-metrics-report.ts") === true;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback: number): number => {
    const i = args.indexOf(name);
    if (i === -1) return fallback;
    const value = Number(args[i + 1]);
    return Number.isFinite(value) ? value : fallback;
  };
  if (args.includes("--watch")) {
    void runWatch(flag("--interval", 30) * 1000, flag("--min-turns", 50), flag("--min-seconds", 120)).catch((err) => {
      console.error(String(err));
      process.exit(1);
    });
  } else {
    const json = args.includes("--json");
    const file = args.find((arg) => !arg.startsWith("--") && Number.isNaN(Number(arg)));
    const allowEmpty = args.includes("--allow-empty");
    const minTurns = flag("--min-turns", 0);
    readInput(file)
      .then((text) => {
        const metrics = extractMetrics(text);
        const report = buildReport(metrics);
        if (json) {
          console.log(JSON.stringify({ metric_lines: metrics.length, ...report }, null, 2));
        } else {
          console.log(`net-metrics-report: ${metrics.length} metric lines`);
          console.log(JSON.stringify(report, null, 2));
        }
        // Finding 7: NO DATA IS NOT GREEN. Fail closed on empty/foreign
        // input; the batch path also enforces --min-turns when set.
        const alerts = abortSignals(report, metrics.length, { emptyIsAbort: !allowEmpty });
        const turns = (report as { turns: { total: number } }).turns.total;
        if (minTurns > 0 && turns < minTurns) {
          alerts.push(`ABORT-SIGNAL: only ${turns} turns sampled (need --min-turns ${minTurns})`);
        }
        for (const alert of alerts) console.error(alert);
        if (alerts.length > 0) process.exit(2);
      })
      .catch((err) => {
        console.error(String(err));
        process.exit(1);
      });
  }
}
