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

report(metrics, events);

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
    depth += braceDeltaOutsideStrings(line);
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

function braceDeltaOutsideStrings(line) {
  let delta = 0;
  let inString = false;
  let escaped = false;
  for (const ch of line) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") delta += 1;
    else if (ch === "}") delta -= 1;
  }
  return delta;
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

function report(metrics, events) {
  if (metrics.length === 0) {
    console.log("(no woo.metric events found in tail log)");
  }
  console.log(`# analyze-smoke-tail: ${metrics.length} woo.metric events`);

  reportInvocationWallTime(events);
  if (metrics.length === 0) return;
  reportPerHost(metrics);
  reportColdStart(metrics);
  reportSeedDelivery(metrics);
  reportCrossHostRpc(metrics);
  reportVerbDispatch(metrics);
  reportTurnPhaseTiming(metrics);
  reportMcpDispatchTiming(metrics);
  reportObservationRouting(metrics);
  reportSlowHandlers(metrics);
  reportErrors(metrics);
}

function reportInvocationWallTime(events) {
  section("Cloudflare invocation wall/cpu");
  const byRoute = new Map();
  for (const event of events) {
    const hasWall = typeof event.wallTime === "number";
    const hasCpu = typeof event.cpuTime === "number";
    if (!hasWall && !hasCpu) continue;
    const route = eventRoute(event);
    const entrypoint = event.entrypoint || (event.executionModel === "stateless" ? "Worker" : "?");
    const key = `${entrypoint} ${route}`;
    const bucket = byRoute.get(key) || { wall: [], cpu: [], errors: 0, statuses: new Map() };
    if (hasWall) bucket.wall.push(event.wallTime);
    if (hasCpu) bucket.cpu.push(event.cpuTime);
    const status = event.event?.response?.status;
    if (typeof status === "number") bucket.statuses.set(status, (bucket.statuses.get(status) || 0) + 1);
    if (event.outcome && event.outcome !== "ok") bucket.errors += 1;
    byRoute.set(key, bucket);
  }

  console.log(`  ${pad("entry route", 62)} ${pad("count", 6)} ${pad("err", 4)} ${pad("wall_p95", 8)} ${pad("wall_max", 8)} ${pad("cpu_p95", 7)} ${pad("status", 12)}`);
  const rows = Array.from(byRoute.entries())
    .map(([key, bucket]) => ({
      key,
      wall: summarize(bucket.wall),
      cpu: summarize(bucket.cpu),
      errors: bucket.errors,
      statuses: Array.from(bucket.statuses.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, n]) => `${s}:${n}`).join(" ")
    }))
    .sort((a, b) => b.wall.sum - a.wall.sum);
  for (const row of rows.slice(0, 30)) {
    console.log(`  ${pad(row.key, 62)} ${num(row.wall.count)} ${num(row.errors, 4)} ${num(row.wall.p95, 8)} ${num(row.wall.max, 8)} ${num(row.cpu.p95, 7)} ${pad(row.statuses, 12)}`);
  }
}

function eventRoute(event) {
  const method = event.event?.request?.method || "?";
  const rawUrl = event.event?.request?.url;
  if (typeof rawUrl !== "string") return `${method} ?`;
  try {
    return `${method} ${new URL(rawUrl).pathname}`;
  } catch {
    return `${method} ${rawUrl}`;
  }
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
    if (metricFailed(m)) bucket.errors += 1;
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
  // host_seed_fetch with source=kv|digest_hit|do reflects whether the
  // KV cache (Lever B) is serving cold-load seeds, the local slice was
  // already current, or the DO RPC fallback was needed.
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
    if (metricFailed(m)) bucket.errors += 1;
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
    if (metricFailed(m)) bucket.errors += 1;
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

function reportTurnPhaseTiming(metrics) {
  section("Turn phase attribution (submitTurnIntent)");
  // turn_phase_timing (Slice 1) charges each turn's wall time to its phases.
  // This is the headline for "where does the 14.6s /mcp CPU go": compare the
  // local-compute phases (serialize + plan_build + vm) against the wall-bound
  // phases (authority reconstruction/fan-in + submit-envelope RPC). `attempts`
  // > 1 means the repair loop re-ran and multiplied every phase. `auth#` is the
  // count of authorityPayload calls (each a potential cross-host slice fetch).
  const byVerb = new Map();
  const totals = { total: [], ensure: [], auth: [], serial: [], build: [], vm: [], submit: [], attempts: [], authCalls: [] };
  const ensureDetails = new Map();
  const submitDetails = new Map();
  const addDetails = (target, details) => {
    if (!details || typeof details !== "object" || Array.isArray(details)) return;
    for (const [label, value] of Object.entries(details)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const bucket = target.get(label) || [];
      bucket.push(value);
      target.set(label, bucket);
    }
  };
  for (const m of metrics) {
    if (m.kind !== "turn_phase_timing") continue;
    const key = `${m.target || "?"}:${m.verb || "?"} (${m.outcome || "?"})`;
    const bucket = byVerb.get(key) || { total: [], ensure: [], auth: [], serial: [], build: [], vm: [], submit: [], attempts: [], authCalls: [] };
    bucket.total.push(m.total_ms || 0);
    bucket.ensure.push(m.ensure_client_ms || 0);
    bucket.auth.push(m.authority_ms || 0);
    bucket.serial.push(m.serialize_ms || 0);
    bucket.build.push(m.plan_build_ms || 0);
    bucket.vm.push(m.vm_ms || 0);
    bucket.submit.push(m.submit_ms || 0);
    bucket.attempts.push(m.attempts || 0);
    bucket.authCalls.push(m.authority_calls || 0);
    byVerb.set(key, bucket);
    totals.ensure.push(m.ensure_client_ms || 0);
    totals.auth.push(m.authority_ms || 0);
    totals.serial.push(m.serialize_ms || 0);
    totals.build.push(m.plan_build_ms || 0);
    totals.vm.push(m.vm_ms || 0);
    totals.submit.push(m.submit_ms || 0);
    addDetails(ensureDetails, m.ensure_detail_ms);
    addDetails(submitDetails, m.submit_detail_ms);
  }
  if (byVerb.size === 0) {
    console.log("  (no turn_phase_timing metrics — deploy must include Slice 1 instrumentation)");
    return;
  }
  // Columns are mean ms per phase so the dominant phase is obvious at a glance;
  // total shows mean + p95 so tail turns are visible.
  console.log(`  ${pad("target:verb (outcome)", 34)} ${pad("n", 4)} ${pad("att", 4)} ${pad("auth#", 5)} ${pad("tot.mean", 8)} ${pad("tot.p95", 7)} ${pad("ensure", 6)} ${pad("auth", 6)} ${pad("serial", 6)} ${pad("build", 6)} ${pad("vm", 6)} ${pad("submit", 6)}`);
  const rows = Array.from(byVerb.entries())
    .map(([k, b]) => ({ key: k, b, tot: summarize(b.total) }))
    .sort((a, b) => b.tot.sum - a.tot.sum);
  for (const row of rows) {
    const b = row.b;
    const mean = (arr) => Math.round(summarize(arr).mean);
    console.log(`  ${pad(row.key, 34)} ${num(row.tot.count, 4)} ${num(mean(b.attempts), 4)} ${num(mean(b.authCalls), 5)} ${num(row.tot.mean, 8)} ${num(row.tot.p95, 7)} ${num(mean(b.ensure))} ${num(mean(b.auth))} ${num(mean(b.serial))} ${num(mean(b.build))} ${num(mean(b.vm))} ${num(mean(b.submit))}`);
  }
  // Aggregate phase share across all turns: which phase owns the wall budget.
  const sum = (arr) => arr.reduce((a, c) => a + c, 0);
  const phaseSums = {
    ensure: sum(totals.ensure), auth: sum(totals.auth), serial: sum(totals.serial),
    build: sum(totals.build), vm: sum(totals.vm), submit: sum(totals.submit)
  };
  const grand = Object.values(phaseSums).reduce((a, c) => a + c, 0) || 1;
  console.log("");
  console.log("  phase share of summed turn wall time across all turns:");
  for (const [k, v] of Object.entries(phaseSums).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${pad(k, 8)} ${num(v, 8)} ms  ${num(Math.round((v / grand) * 100), 4)}%`);
  }
  const printDetail = (title, details) => {
    if (details.size === 0) return;
    console.log("");
    console.log(`  ${title}:`);
    const rows = Array.from(details.entries())
      .map(([label, values]) => ({ label, stats: summarize(values) }))
      .sort((a, b) => b.stats.sum - a.stats.sum)
      .slice(0, 20);
    for (const row of rows) {
      console.log(`    ${pad(row.label, 38)} ${num(row.stats.sum, 8)} ms  mean ${num(row.stats.mean, 6)}  p95 ${num(row.stats.p95, 6)}  n=${row.stats.count}`);
    }
  };
  printDetail("ensure subphase detail", ensureDetails);
  printDetail("submit subphase detail", submitDetails);
}

function reportMcpDispatchTiming(metrics) {
  section("MCP dispatch wrapper timing (POST vs DELETE)");
  // mcp_dispatch_timing (Slice 1) charges the /mcp DO wrapper steps that sit
  // OUTSIDE submitTurnIntent. For DELETE (teardown, the worst smoke endpoint)
  // this is the whole cost; for POST it is the cold-load + session-forward +
  // route-register overhead added on top of the turn itself.
  const byMethod = new Map();
  for (const m of metrics) {
    if (m.kind !== "mcp_dispatch_timing") continue;
    const key = `${m.method || "?"}${m.status === "error" ? " ERR" : ""}${m.cold_world ? " (cold)" : ""}`;
    const bucket = byMethod.get(key) || { total: [], getWorld: [], forward: [], handle: [], register: [] };
    bucket.total.push(m.total_ms || 0);
    bucket.getWorld.push(m.get_world_ms || 0);
    bucket.forward.push(m.forward_ms || 0);
    bucket.handle.push(m.handle_ms || 0);
    bucket.register.push(m.register_ms || 0);
    byMethod.set(key, bucket);
  }
  if (byMethod.size === 0) {
    console.log("  (no mcp_dispatch_timing metrics — deploy must include Slice 1 instrumentation)");
    return;
  }
  console.log(`  ${pad("method", 16)} ${pad("n", 4)} ${pad("tot.p95", 7)} ${pad("tot.max", 7)} ${pad("getWorld", 8)} ${pad("forward", 7)} ${pad("handle", 7)} ${pad("register", 8)}`);
  const rows = Array.from(byMethod.entries())
    .map(([k, b]) => ({ key: k, b, tot: summarize(b.total) }))
    .sort((a, b) => b.tot.sum - a.tot.sum);
  for (const row of rows) {
    const b = row.b;
    const p95 = (arr) => summarize(arr).p95;
    console.log(`  ${pad(row.key, 16)} ${num(row.tot.count, 4)} ${num(row.tot.p95, 7)} ${num(row.tot.max, 7)} ${num(p95(b.getWorld), 8)} ${num(p95(b.forward), 7)} ${num(p95(b.handle), 7)} ${num(p95(b.register), 8)}`);
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
    if (!metricFailed(m)) continue;
    const code = m.error || (m.status === "timeout" ? "timeout" : "(unspecified)");
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

function metricFailed(metric) {
  return metric.status === "error" || metric.status === "timeout";
}
