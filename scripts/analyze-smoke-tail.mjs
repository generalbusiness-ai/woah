#!/usr/bin/env node
// analyze-smoke-tail — per-host / per-object metrics analysis from a
// wrangler tail JSON log. Reads woo.metric events emitted during a
// smoke run and produces aggregations that show where time and load
// concentrate, which is more useful for tuning than the pass/fail rate.
//
// Usage:
//   node scripts/analyze-smoke-tail.mjs [path]
//   cat tail.log | node scripts/analyze-smoke-tail.mjs
//   (with a Wrangler tail running) wrangler tail --format=json > tail.log
//      npm run smoke:walkthrough
//      node scripts/analyze-smoke-tail.mjs tail.log
//
// Or use scripts/smoke-with-tail.sh as a one-shot orchestrator.
//
// Output sections:
//   - Per-host summary (request counts, mean/p50/p95 ms, errors).
//   - Cold-start phases (do_constructor, init, cf_repository_load).
//   - Seed delivery (host_seed_fetch + mcp_gateway_snapshot_fetch) by
//     source (kv/do).
//   - Cross-host RPCs (cross_host_rpc) by route and host.
//   - Verb dispatch by (target, verb): count, latency, applied/error
//     ratios.
//   - Observation routing (mcp_observation_routed) by scope: queues
//     scanned vs deliveries.
//   - Slow handlers (do_handler with ms > threshold).
//
// All counts are derived from JSON-formatted tail entries; this script
// makes no assumptions about how the smoke run was driven.

import { readFileSync } from "node:fs";

const argPath = process.argv[2];
const raw = argPath
  ? readFileSync(argPath, "utf8")
  : readFileSync(0, "utf8");

const events = parseTailEvents(raw);
const metrics = collectMetrics(events);

report(metrics);

// --- parsing ---------------------------------------------------------------

function parseTailEvents(text) {
  // wrangler tail --format=json emits one event per request, each as a
  // multi-line JSON object (pretty-printed) separated by blank lines.
  // Reassemble by tracking brace depth.
  const out = [];
  const lines = text.split("\n");
  let buf = [];
  let depth = 0;
  for (const line of lines) {
    if (buf.length === 0) {
      if (line.trimStart().startsWith("{")) buf.push(line);
      else continue;
    } else {
      buf.push(line);
    }
    for (const ch of line) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    if (buf.length > 0 && depth === 0) {
      try {
        out.push(JSON.parse(buf.join("\n")));
      } catch {
        // skip malformed
      }
      buf = [];
    }
  }
  return out;
}

function collectMetrics(events) {
  const metrics = [];
  for (const e of events) {
    const ts = e.eventTimestamp || 0;
    for (const log of e.logs || []) {
      const msg = log.message || [];
      if (msg.length < 2 || msg[0] !== "woo.metric") continue;
      let parsed;
      try { parsed = JSON.parse(msg[1]); } catch { continue; }
      parsed._tail_ts = log.timestamp || ts;
      metrics.push(parsed);
    }
  }
  return metrics;
}

// --- helpers ---------------------------------------------------------------

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function summarize(values) {
  if (values.length === 0) return { count: 0, mean: 0, p50: 0, p95: 0, max: 0, sum: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    mean: Math.round(sum / sorted.length),
    p50: Math.round(quantile(sorted, 0.5)),
    p95: Math.round(quantile(sorted, 0.95)),
    max: sorted[sorted.length - 1],
    sum: sum
  };
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function num(n, width = 6) {
  return String(n).padStart(width);
}

function section(title) {
  console.log("");
  console.log("=".repeat(78));
  console.log(title);
  console.log("=".repeat(78));
}

// --- aggregations ----------------------------------------------------------

function report(metrics) {
  if (metrics.length === 0) {
    console.log("(no woo.metric events found in tail log)");
    return;
  }
  console.log(`# analyze-smoke-tail: ${metrics.length} woo.metric events`);

  reportPerHost(metrics);
  reportColdStart(metrics);
  reportSeedDelivery(metrics);
  reportCrossHostRpc(metrics);
  reportVerbDispatch(metrics);
  reportObservationRouting(metrics);
  reportSlowHandlers(metrics);
  reportErrors(metrics);
}

function reportPerHost(metrics) {
  section("Per-host activity");
  // Bucket do_handler events by host_key — that's the "this host
  // received a request" surface. Latency is on `ms`.
  const byHost = new Map();
  for (const m of metrics) {
    if (m.kind !== "do_handler") continue;
    const h = m.host_key || "?";
    const bucket = byHost.get(h) || { ms: [], errors: 0, routes: new Map() };
    bucket.ms.push(m.ms || 0);
    if (m.status === "error") bucket.errors += 1;
    const r = m.route || "?";
    bucket.routes.set(r, (bucket.routes.get(r) || 0) + 1);
    byHost.set(h, bucket);
  }

  console.log(`  ${pad("host", 22)} ${pad("reqs", 6)} ${pad("err", 4)} ${pad("mean", 6)} ${pad("p50", 6)} ${pad("p95", 6)} ${pad("max", 6)}  top routes`);
  const rows = Array.from(byHost.entries())
    .map(([h, b]) => ({ host: h, stats: summarize(b.ms), errors: b.errors, routes: b.routes }))
    .sort((a, b) => b.stats.sum - a.stats.sum);
  for (const row of rows) {
    const topRoutes = Array.from(row.routes.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([r, n]) => `${r}(${n})`)
      .join(" ");
    console.log(`  ${pad(row.host, 22)} ${num(row.stats.count)} ${num(row.errors, 4)} ${num(row.stats.mean)} ${num(row.stats.p50)} ${num(row.stats.p95)} ${num(row.stats.max)}  ${topRoutes}`);
  }
}

function reportColdStart(metrics) {
  section("Cold-start phases");
  // do_constructor + startup_storage (cf_repository_load etc.) +
  // init (mcp_gateway, world) together describe how a DO got from
  // zero to ready.
  const phases = new Map();
  for (const m of metrics) {
    let key = null;
    if (m.kind === "do_constructor") key = `do_constructor/${m.class || "?"}`;
    else if (m.kind === "init") key = `init/${m.phase || "?"}`;
    else if (m.kind === "startup_storage") key = `startup_storage/${m.phase || "?"}`;
    if (!key) continue;
    const bucket = phases.get(key) || [];
    bucket.push({ ms: m.ms || 0, host: m.host_key || "?" });
    phases.set(key, bucket);
  }
  console.log(`  ${pad("phase", 45)} ${pad("count", 6)} ${pad("mean", 6)} ${pad("p95", 6)} ${pad("max", 6)}`);
  const rows = Array.from(phases.entries())
    .map(([k, b]) => ({ key: k, stats: summarize(b.map((x) => x.ms)) }))
    .sort((a, b) => b.stats.max - a.stats.max);
  for (const row of rows) {
    console.log(`  ${pad(row.key, 45)} ${num(row.stats.count)} ${num(row.stats.mean)} ${num(row.stats.p95)} ${num(row.stats.max)}`);
  }
}

function reportSeedDelivery(metrics) {
  section("Seed delivery (cold-load fast path)");
  // host_seed_fetch with source=kv|do reflects whether the KV cache
  // (Lever B) is serving cold-load seeds vs the DO RPC fallback.
  // mcp_gateway_snapshot_fetch is the analogous metric for MCP shards.
  const byBucket = new Map();
  for (const m of metrics) {
    if (m.kind !== "startup_storage") continue;
    if (m.phase !== "host_seed_fetch" && m.phase !== "mcp_gateway_snapshot_fetch" && m.phase !== "host_seed_fetch_kv_miss") continue;
    const key = `${m.phase}/${m.source || (m.phase.endsWith("kv_miss") ? "miss" : "?")}`;
    const bucket = byBucket.get(key) || [];
    bucket.push(m.ms || 0);
    byBucket.set(key, bucket);
  }
  console.log(`  ${pad("phase/source", 45)} ${pad("count", 6)} ${pad("mean", 6)} ${pad("p95", 6)} ${pad("max", 6)}`);
  for (const [k, ms] of byBucket) {
    const s = summarize(ms);
    console.log(`  ${pad(k, 45)} ${num(s.count)} ${num(s.mean)} ${num(s.p95)} ${num(s.max)}`);
  }
}

function reportCrossHostRpc(metrics) {
  section("Cross-host RPCs");
  // cross_host_rpc is the sender-side measurement of an outbound
  // signed internal request to another DO. Grouping by route shows
  // which RPCs dominate and which take longest.
  const byRoute = new Map();
  for (const m of metrics) {
    if (m.kind !== "cross_host_rpc") continue;
    const key = `${m.route || "?"}→${m.host || "?"}`;
    const bucket = byRoute.get(key) || { ms: [], errors: 0 };
    bucket.ms.push(m.ms || 0);
    if (m.status === "error") bucket.errors += 1;
    byRoute.set(key, bucket);
  }
  console.log(`  ${pad("route → host", 60)} ${pad("count", 6)} ${pad("err", 4)} ${pad("mean", 6)} ${pad("p95", 6)} ${pad("max", 6)}`);
  const rows = Array.from(byRoute.entries())
    .map(([k, b]) => ({ key: k, stats: summarize(b.ms), errors: b.errors }))
    .sort((a, b) => b.stats.sum - a.stats.sum);
  for (const row of rows.slice(0, 20)) {
    console.log(`  ${pad(row.key, 60)} ${num(row.stats.count)} ${num(row.errors, 4)} ${num(row.stats.mean)} ${num(row.stats.p95)} ${num(row.stats.max)}`);
  }
}

function reportVerbDispatch(metrics) {
  section("Verb dispatch (target:verb)");
  // direct_call / applied / dispatch_resolved show per-verb activity
  // on the originating host. Useful for spotting hot verbs and slow
  // verbs.
  const byVerb = new Map();
  for (const m of metrics) {
    if (m.kind !== "direct_call" && m.kind !== "applied") continue;
    const key = `${m.target || "?"}:${m.verb || "?"}/${m.kind}`;
    const bucket = byVerb.get(key) || { ms: [], errors: 0, observations: 0 };
    bucket.ms.push(m.ms || 0);
    bucket.observations += m.observations || 0;
    if (m.status === "error") bucket.errors += 1;
    byVerb.set(key, bucket);
  }
  console.log(`  ${pad("target:verb/kind", 55)} ${pad("count", 6)} ${pad("err", 4)} ${pad("obs", 5)} ${pad("mean", 6)} ${pad("p95", 6)} ${pad("max", 6)}`);
  const rows = Array.from(byVerb.entries())
    .map(([k, b]) => ({ key: k, stats: summarize(b.ms), errors: b.errors, observations: b.observations }))
    .sort((a, b) => b.stats.sum - a.stats.sum);
  for (const row of rows.slice(0, 25)) {
    console.log(`  ${pad(row.key, 55)} ${num(row.stats.count)} ${num(row.errors, 4)} ${num(row.observations, 5)} ${num(row.stats.mean)} ${num(row.stats.p95)} ${num(row.stats.max)}`);
  }
}

function reportObservationRouting(metrics) {
  section("Observation routing");
  // mcp_observation_routed shows how many sessions saw each observation.
  // queues_scanned=0 means the shard has no MCP sessions bound for that
  // scope (typical when fanout reaches the wrong shard).
  // queues_scanned>0 && deliveries=0 is an audience-filter drop.
  const byScope = new Map();
  for (const m of metrics) {
    if (m.kind !== "mcp_observation_routed") continue;
    const key = `${m.scope || "?"}/${m.route || "?"}`;
    const bucket = byScope.get(key) || { count: 0, scanned: 0, delivered: 0, empty: 0, drop: 0 };
    bucket.count += 1;
    bucket.scanned += m.queues_scanned || 0;
    bucket.delivered += m.deliveries || 0;
    if ((m.queues_scanned || 0) === 0) bucket.empty += 1;
    else if ((m.deliveries || 0) === 0) bucket.drop += 1;
    byScope.set(key, bucket);
  }
  console.log(`  ${pad("scope/route", 35)} ${pad("count", 6)} ${pad("scanned", 8)} ${pad("delivered", 9)} ${pad("empty", 6)} ${pad("drop", 5)}`);
  for (const [k, b] of byScope) {
    console.log(`  ${pad(k, 35)} ${num(b.count)} ${num(b.scanned, 8)} ${num(b.delivered, 9)} ${num(b.empty, 6)} ${num(b.drop, 5)}`);
  }
}

function reportSlowHandlers(metrics, thresholdMs = 1000) {
  section(`Slow handlers (do_handler ms > ${thresholdMs})`);
  const slow = metrics
    .filter((m) => m.kind === "do_handler" && (m.ms || 0) > thresholdMs)
    .sort((a, b) => (b.ms || 0) - (a.ms || 0));
  console.log(`  ${pad("host", 22)} ${pad("route", 45)} ${pad("ms", 6)} status`);
  for (const m of slow.slice(0, 30)) {
    console.log(`  ${pad(m.host_key || "?", 22)} ${pad(m.route || "?", 45)} ${num(m.ms)} ${m.status || "?"}`);
  }
  if (slow.length > 30) console.log(`  ... (${slow.length - 30} more)`);
}

function reportErrors(metrics) {
  section("Errors");
  const byCode = new Map();
  for (const m of metrics) {
    if (m.status !== "error") continue;
    const code = m.error || "(unspecified)";
    const where = `${m.kind || "?"}/${m.route || m.phase || ""}`;
    const key = `${code} ${where}`;
    byCode.set(key, (byCode.get(key) || 0) + 1);
  }
  if (byCode.size === 0) {
    console.log("  (no error-status metrics)");
    return;
  }
  for (const [k, n] of Array.from(byCode.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${num(n, 4)}  ${k}`);
  }
}
