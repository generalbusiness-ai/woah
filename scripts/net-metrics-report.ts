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

function extractMetrics(text: string): Metric[] {
  const metrics: Metric[] = [];
  const marker = "woo.metric";
  let index = 0;
  while ((index = text.indexOf(marker, index)) !== -1) {
    const braceStart = text.indexOf("{", index);
    if (braceStart === -1) break;
    // Balanced-brace scan: tail formats embed the JSON in larger lines
    // (and escape it inside strings) — a lazy regex under- or over-eats.
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
    const raw = text.slice(braceStart, end + 1);
    try {
      // Tail JSON double-encodes log args; try the raw slice, then an
      // unescaped variant.
      metrics.push(JSON.parse(raw) as Metric);
    } catch {
      try {
        metrics.push(JSON.parse(raw.replace(/\\"/g, '"')) as Metric);
      } catch {
        // not a metric payload — skip
      }
    }
    index = end + 1;
  }
  return metrics;
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

async function readInput(path: string | undefined): Promise<string> {
  if (path) return readFileSync(path, "utf8");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const invokedDirectly = process.argv[1]?.endsWith("net-metrics-report.ts") === true;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const file = args.find((arg) => !arg.startsWith("--"));
  readInput(file)
    .then((text) => {
      const metrics = extractMetrics(text);
      const report = buildReport(metrics);
      if (json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      console.log(`net-metrics-report: ${metrics.length} metric lines`);
      console.log(JSON.stringify(report, null, 2));
      // The NC8 abort criteria, evaluated inline so a canary check is one
      // command (the runbook documents the thresholds).
      const r = report as { outbox: { abandoned: number }; incidents: { fanout_gaps: number }; turns: { total: number; retry_rate: number } };
      const alerts: string[] = [];
      if (r.outbox.abandoned > 0) alerts.push(`ABORT-SIGNAL: ${r.outbox.abandoned} outbox abandonment(s) — named divergence`);
      if (r.incidents.fanout_gaps > 0) alerts.push(`ABORT-SIGNAL: ${r.incidents.fanout_gaps} fanout gap(s)`);
      if (r.turns.total >= 20 && r.turns.retry_rate > 0.2) {
        alerts.push(`ABORT-SIGNAL: retry rate ${(r.turns.retry_rate * 100).toFixed(0)}% > 20%`);
      }
      for (const alert of alerts) console.error(alert);
      if (alerts.length > 0) process.exit(2);
    })
    .catch((err) => {
      console.error(String(err));
      process.exit(1);
    });
}
