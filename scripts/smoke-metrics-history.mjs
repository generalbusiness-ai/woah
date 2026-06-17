#!/usr/bin/env node
// smoke-metrics-history -- convert one or more smoke measurement directories
// into stable per-run rows for trend charting. It reads raw smoke.log/tail.log
// artifacts, writes JSON + CSV for durable history, and renders a small-multiple
// SVG chart for quick human review.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const DEFAULT_ROOT = ".woo/smoke-measurements";

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const inputs = args.inputs.length > 0 ? args.inputs : [DEFAULT_ROOT];
const runDirs = discoverRunDirs(inputs, args.match);
if (runDirs.length === 0) {
  console.error(`No smoke measurement runs found under: ${inputs.join(", ")}`);
  process.exit(1);
}

let rows = runDirs
  .map((dir) => summarizeRun(dir))
  .filter((row) => row.tail_events > 0 || row.smoke_attempted > 0)
  .sort((a, b) => a.sort_ts - b.sort_ts || a.run_id.localeCompare(b.run_id));

if (args.limit !== null && rows.length > args.limit) rows = rows.slice(rows.length - args.limit);
if (rows.length === 0) {
  console.error("Smoke measurement directories were found, but none contained tail or smoke data.");
  process.exit(1);
}

const outDir = resolve(args.outDir || join(".woo", "smoke-metrics-history", timestampForPath(new Date())));
mkdirSync(outDir, { recursive: true });

const jsonPath = join(outDir, "summary.json");
const csvPath = join(outDir, "summary.csv");
const chartPath = join(outDir, "chart.svg");

writeFileSync(jsonPath, JSON.stringify({ generated_at: new Date().toISOString(), runs: rows }, null, 2) + "\n");
writeFileSync(csvPath, toCsv(rows));
writeFileSync(chartPath, renderSvg(rows, { title: args.title || "Cloudflare Smoke Metrics History" }));

printSummary(rows, { outDir, jsonPath, csvPath, chartPath });

function parseArgs(argv) {
  const out = { inputs: [], outDir: null, limit: null, match: null, title: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--out" || arg === "-o") out.outDir = requireValue(argv, ++i, arg);
    else if (arg === "--limit") out.limit = Number.parseInt(requireValue(argv, ++i, arg), 10);
    else if (arg === "--match") out.match = requireValue(argv, ++i, arg);
    else if (arg === "--title") out.title = requireValue(argv, ++i, arg);
    else out.inputs.push(arg);
  }
  if (out.limit !== null && (!Number.isFinite(out.limit) || out.limit < 1)) {
    console.error("--limit must be a positive integer");
    process.exit(2);
  }
  return out;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) {
    console.error(`${flag} requires a value`);
    process.exit(2);
  }
  return value;
}

function printHelp() {
  console.log(`usage: node scripts/smoke-metrics-history.mjs [measurement-root-or-run-dir ...] [options]

Options:
  --out, -o <dir>   output directory for summary.json, summary.csv, chart.svg
  --limit <n>       chart/summarize only the latest n discovered runs
  --match <text>    include only run directory names containing text
  --title <text>    SVG chart title

If no input is supplied, ${DEFAULT_ROOT} is scanned. Inputs may be a root
directory containing smoke run directories or a specific run directory with a
tail.log/smoke.log file.`);
}

function discoverRunDirs(inputs, match) {
  const dirs = new Map();
  for (const input of inputs) {
    const path = resolve(input);
    if (!existsSync(path)) continue;
    const stat = statSync(path);
    if (!stat.isDirectory()) continue;
    if (isRunDir(path)) {
      maybeAdd(path);
      continue;
    }
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = join(path, entry.name);
      if (isRunDir(child)) maybeAdd(child);
    }
  }
  return [...dirs.values()];

  function maybeAdd(dir) {
    if (match && !basename(dir).includes(match)) return;
    dirs.set(resolve(dir), resolve(dir));
  }
}

function isRunDir(dir) {
  return existsSync(join(dir, "tail.log")) || existsSync(join(dir, "smoke.log")) || existsSync(join(dir, "smoke-run-1.log"));
}

function summarizeRun(dir) {
  const runId = basename(dir);
  const smoke = parseSmokeLog(dir);
  const identity = parseIdentity(runId, smoke);
  const tailPath = join(dir, "tail.log");
  const events = existsSync(tailPath) ? parseTailEvents(readFileSync(tailPath, "utf8")) : [];
  const metrics = collectMetrics(events);
  const invocations = summarizeInvocations(events);
  const turns = summarizeTurns(metrics);
  const recon = summarizeReconstructions(metrics);
  const repairs = summarizeRepairs(metrics, turns);
  const divergence = summarizeStatePathDivergence(metrics);
  const ownerPrefetch = summarizeOwnerPrefetch(metrics);
  const data = summarizeDataPath(metrics);
  const rpc = summarizeRpc(metrics);

  return {
    run_id: runId,
    dir,
    sort_ts: identity.sortTs,
    timestamp: identity.timestamp,
    deploy_short: identity.deployShort,
    commit: identity.commit,
    label: identity.label,
    smoke_passed: smoke.passed,
    smoke_attempted: smoke.attempted,
    smoke_failed: smoke.failed,
    smoke_duration_ms: smoke.durationMs,
    smoke_failures: smoke.failures,
    tail_events: events.length,
    metric_events: metrics.length,
    worker_mcp_post_count: invocations.workerPost.count,
    worker_mcp_post_p95_ms: statValue(invocations.workerPost, "p95"),
    worker_mcp_post_max_ms: statValue(invocations.workerPost, "max"),
    do_mcp_post_count: invocations.doPost.count,
    do_mcp_post_p95_ms: statValue(invocations.doPost, "p95"),
    do_mcp_post_max_ms: statValue(invocations.doPost, "max"),
    turn_count: turns.count,
    turn_total_sum_ms: statValue(turns.total, "sum"),
    turn_total_p50_ms: statValue(turns.total, "p50"),
    turn_total_p95_ms: statValue(turns.total, "p95"),
    turn_total_max_ms: statValue(turns.total, "max"),
    turn_submit_p95_ms: statValue(turns.submit, "p95"),
    turn_ensure_p95_ms: statValue(turns.ensure, "p95"),
    turn_authority_p95_ms: statValue(turns.authority, "p95"),
    phase_ensure_sum_ms: statValue(turns.ensure, "sum"),
    phase_authority_sum_ms: statValue(turns.authority, "sum"),
    phase_submit_sum_ms: statValue(turns.submit, "sum"),
    phase_local_sum_ms: turns.count > 0 ? turns.localSum : null,
    phase_ensure_share_pct: turns.phaseShares.ensure,
    phase_authority_share_pct: turns.phaseShares.authority,
    phase_submit_share_pct: turns.phaseShares.submit,
    phase_local_share_pct: turns.phaseShares.local,
    turn_attempts_avg: turns.attemptsAvg,
    turn_attempts_max: statValue(turns.attempts, "max"),
    turns_attempts_gt1: turns.attemptsGt1,
    repair_attempts: repairs.count,
    repair_commit_rejected: repairs.byReason.commit_rejected || 0,
    repair_missing_state: repairs.byReason.missing_state || 0,
    shadow_commit_rejected: repairs.shadowCommitRejected,
    state_path_divergence: divergence.count,
    state_path_e_repair_budget: divergence.byCode.E_REPAIR_BUDGET || 0,
    state_path_e_need_state: divergence.byCode.E_NEED_STATE || 0,
    state_path_e_objnf: divergence.byCode.E_OBJNF || 0,
    state_path_e_verbnf: divergence.byCode.E_VERBNF || 0,
    state_path_e_nosession: divergence.byCode.E_NOSESSION || 0,
    state_path_missing_live_session: divergence.byCause.missing_live_session || 0,
    state_path_lookup_missing_object: divergence.byCause.lookup_missing_object || 0,
    state_path_stale_commit_state: divergence.byCause.stale_commit_state || 0,
    recon_total: recon.total,
    recon_pages_total: recon.pagesTotal,
    recon_cold_open: recon.byReason.cold_open || 0,
    recon_warm_turn_refresh: recon.byReason.warm_turn_refresh || 0,
    recon_missing_state_repair: recon.byReason.missing_state_repair || 0,
    recon_slice_served: recon.byReason.slice_served || 0,
    recon_trigger_scope_seed: recon.byTrigger.scope_seed || 0,
    recon_trigger_owner_prefetch: recon.byTrigger.owner_prefetch || 0,
    recon_trigger_pre_plan_repair: recon.byTrigger.pre_plan_repair || 0,
    recon_trigger_turn_commit: recon.byTrigger.turn_commit || 0,
    owner_prefetch_events: ownerPrefetch.events,
    owner_prefetch_requested: ownerPrefetch.requested,
    owner_prefetch_warm_local: ownerPrefetch.warmLocal,
    owner_prefetch_warm_donor: ownerPrefetch.warmDonor,
    owner_prefetch_residue: ownerPrefetch.residue,
    cross_host_rpc_count: rpc.count,
    cross_host_rpc_timeouts: rpc.timeouts,
    cross_host_rpc_p95_ms: statValue(rpc.ms, "p95"),
    cross_host_rpc_max_ms: statValue(rpc.ms, "max"),
    authority_slice_rpc_count: rpc.authoritySlice.count,
    authority_slice_rpc_timeouts: rpc.authoritySlice.timeouts,
    enumerate_tools_rpc_count: rpc.enumerateTools.count,
    fanout_rpc_count: rpc.fanout.count,
    same_host_fallback_count: data.sameHostFallbacks,
    v2_envelope_count: data.envelope.count,
    v2_request_bytes_p50: statValue(data.requestBytes, "p50"),
    v2_request_bytes_p95: statValue(data.requestBytes, "p95"),
    v2_request_bytes_max: statValue(data.requestBytes, "max"),
    v2_reply_bytes_p95: statValue(data.replyBytes, "p95"),
    projection_bytes: data.projectionBytes,
    tail_rows_written: data.tailRowsWritten,
    tail_bytes_retained_max: data.tailBytesRetainedMax,
    storage_full_save_rows: data.storageFullSaveRows,
    storage_direct_write_rows: data.storageDirectWriteRows
  };
}

function parseIdentity(runId, smoke) {
  const tsMatch = runId.match(/(\d{8}T\d{4,6}Z)/);
  const timestamp = smoke.startedAt || (tsMatch ? timestampToIso(tsMatch[1]) : null);
  const sortTs = timestamp ? Date.parse(timestamp) : mtimeSortFallback(runId);
  const parts = runId.split("-");
  let deployShort = "";
  let commit = "";
  let label = "";
  if (parts[0] === "deploy" && parts.length >= 2) {
    deployShort = parts[1] || "";
    if (/^[0-9a-f]{6,}$/i.test(parts[2] || "")) {
      commit = parts[2];
      label = parts.slice(3).filter((part) => !/^\d{8}T\d{4,6}Z$/.test(part)).join("-");
    } else {
      label = parts.slice(2).filter((part) => !/^\d{8}T\d{4,6}Z$/.test(part)).join("-");
    }
  }
  return { timestamp, sortTs, deployShort, commit, label };
}

function mtimeSortFallback(runId) {
  const digits = runId.match(/(\d{8})/);
  if (!digits) return 0;
  const s = digits[1];
  return Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
}

function timestampToIso(value) {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{0,2})Z$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, sec] = match;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec || "0"))).toISOString();
}

function parseSmokeLog(dir) {
  const smokePath = existsSync(join(dir, "smoke.log")) ? join(dir, "smoke.log") : join(dir, "smoke-run-1.log");
  if (!existsSync(smokePath)) return emptySmoke();
  const text = readFileSync(smokePath, "utf8");
  const startedAt = text.match(/^started_at=(.+)$/m)?.[1]?.trim() || null;
  const finishedAt = text.match(/^finished_at=(.+)$/m)?.[1]?.trim() || null;
  const summary = text.match(/summary:\s+(\d+)\/(\d+)\s+steps attempted passed,\s+(\d+)\s+failed/);
  const stepMatches = [...text.matchAll(/^\s+(ok|FAIL)\s+(.+)\s+\((\d+)ms\)(?::\s*(.*))?$/gm)];
  const steps = stepMatches.map((match) => ({
    status: match[1] === "ok" ? "ok" : "fail",
    name: match[2],
    ms: Number(match[3]),
    message: match[4] || ""
  }));
  const passed = summary ? Number(summary[1]) : steps.filter((step) => step.status === "ok").length;
  const attempted = summary ? Number(summary[2]) : steps.length;
  const failed = summary ? Number(summary[3]) : steps.filter((step) => step.status === "fail").length;
  return {
    startedAt,
    finishedAt,
    passed,
    attempted,
    failed,
    durationMs: steps.reduce((sum, step) => sum + step.ms, 0),
    failures: steps.filter((step) => step.status === "fail").map((step) => ({ name: step.name, ms: step.ms, message: step.message }))
  };
}

function emptySmoke() {
  return { startedAt: null, finishedAt: null, passed: 0, attempted: 0, failed: 0, durationMs: 0, failures: [] };
}

function parseTailEvents(text) {
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
        // Ignore partial or malformed tail events; raw logs are still preserved.
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
  for (const event of events) {
    const eventTs = event.eventTimestamp || 0;
    for (const log of event.logs || []) {
      const msg = log.message || [];
      if (msg.length < 2 || msg[0] !== "woo.metric") continue;
      try {
        const metric = JSON.parse(msg[1]);
        metric._tail_ts = log.timestamp || eventTs;
        metrics.push(metric);
      } catch {
        // Ignore malformed metric payloads.
      }
    }
  }
  return metrics;
}

function summarizeInvocations(events) {
  const workerPost = [];
  const doPost = [];
  for (const event of events) {
    if (eventRoute(event) !== "POST /mcp" || typeof event.wallTime !== "number") continue;
    if (event.entrypoint === "PersistentObjectDO") doPost.push(event.wallTime);
    else if (event.entrypoint === "Worker" || event.executionModel === "stateless") workerPost.push(event.wallTime);
  }
  return { workerPost: summarize(workerPost), doPost: summarize(doPost) };
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

function summarizeTurns(metrics) {
  const turns = metrics.filter((m) => m.kind === "turn_phase_timing");
  const total = summarize(values(turns, "total_ms"));
  const ensure = summarize(values(turns, "ensure_client_ms"));
  const authority = summarize(values(turns, "authority_ms"));
  const submit = summarize(values(turns, "submit_ms"));
  const localSum = sum(turns, "serialize_ms") + sum(turns, "plan_build_ms") + sum(turns, "vm_ms");
  const attemptValues = values(turns, "attempts");
  const attempts = summarize(attemptValues);
  const denom = total.sum || 0;
  return {
    count: turns.length,
    total,
    ensure,
    authority,
    submit,
    localSum,
    attempts,
    attemptsAvg: attemptValues.length > 0 ? round(attemptValues.reduce((acc, value) => acc + value, 0) / attemptValues.length, 2) : null,
    attemptsGt1: turns.filter((m) => numberField(m, "attempts") > 1).length,
    phaseShares: {
      ensure: denom > 0 ? percent(ensure.sum, denom) : null,
      authority: denom > 0 ? percent(authority.sum, denom) : null,
      submit: denom > 0 ? percent(submit.sum, denom) : null,
      local: denom > 0 ? percent(localSum, denom) : null
    }
  };
}

function summarizeReconstructions(metrics) {
  const rows = metrics.filter((m) => m.kind === "authority_slice_reconstructed");
  return {
    total: rows.length,
    pagesTotal: sum(rows, "page_count"),
    byReason: countBy(rows, (m) => m.reason || "unknown"),
    byTrigger: countBy(rows, (m) => m.trigger || "untagged")
  };
}

function summarizeRepairs(metrics, turns) {
  const rows = metrics.filter((m) => m.kind === "turn_repair_attempt");
  return {
    count: rows.length,
    byReason: countBy(rows, (m) => m.reason || "unknown"),
    shadowCommitRejected: metrics.filter((m) => m.kind === "shadow_commit_rejected").length,
    turnsAttemptsGt1: turns.attemptsGt1
  };
}

function summarizeStatePathDivergence(metrics) {
  const rows = metrics.filter((m) => m.kind === "state_path_divergence");
  return {
    count: rows.length,
    byCode: countBy(rows, (m) => m.code || "unknown"),
    byCause: countBy(rows, (m) => m.cause || "unknown")
  };
}

function summarizeOwnerPrefetch(metrics) {
  const rows = metrics.filter((m) => m.kind === "mcp_owner_prefetch");
  return {
    events: rows.length,
    requested: sum(rows, "requested"),
    warmLocal: sum(rows, "warm_local"),
    warmDonor: sum(rows, "warm_donor"),
    residue: sum(rows, "residue")
  };
}

function summarizeDataPath(metrics) {
  const envelope = metrics.filter((m) => m.kind === "v2_envelope");
  const authorityTail = metrics.filter((m) => m.kind === "authority_tail");
  return {
    envelope: { count: envelope.length },
    requestBytes: summarize(values(envelope, "request_bytes")),
    replyBytes: summarize(values(envelope, "reply_bytes")),
    projectionBytes: sumProjectionBytes(metrics),
    tailRowsWritten: sum(envelope, "tail_rows_written") + sum(authorityTail, "tail_rows_written"),
    tailBytesRetainedMax: Math.max(max(envelope, "tail_bytes_retained"), max(authorityTail, "tail_bytes_retained")),
    storageFullSaveRows: sum(metrics.filter((m) => m.kind === "storage_full_save"), "rows"),
    storageDirectWriteRows: sum(metrics.filter((m) => m.kind === "storage_direct_write"), "rows"),
    sameHostFallbacks: metrics.filter((m) => m.kind === "same_host_fallback").length
  };
}

function summarizeRpc(metrics) {
  const rows = metrics.filter((m) => m.kind === "cross_host_rpc");
  const byRoute = (route) => rows.filter((m) => m.route === route);
  const authoritySlice = byRoute("/__internal/authority-slice");
  const enumerateTools = byRoute("/__internal/enumerate-tools");
  const fanout = byRoute("/__internal/mcp-commit-fanout");
  return {
    count: rows.length,
    timeouts: rows.filter(metricFailed).length,
    ms: summarize(values(rows, "ms")),
    authoritySlice: { count: authoritySlice.length, timeouts: authoritySlice.filter(metricFailed).length },
    enumerateTools: { count: enumerateTools.length, timeouts: enumerateTools.filter(metricFailed).length },
    fanout: { count: fanout.length, timeouts: fanout.filter(metricFailed).length }
  };
}

function metricFailed(metric) {
  return metric.status === "error" || metric.status === "timeout";
}

function sum(rows, field) {
  return rows.reduce((acc, row) => acc + numberField(row, field), 0);
}

function values(rows, field) {
  return rows
    .map((row) => row?.[field])
    .filter((value) => typeof value === "number" && Number.isFinite(value));
}

function max(rows, field) {
  return rows.reduce((acc, row) => Math.max(acc, numberField(row, field)), 0);
}

function numberField(row, field) {
  const value = row?.[field];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sumProjectionBytes(metrics) {
  return metrics.reduce((total, metric) => total +
    numberField(metric, "projection_bytes") +
    numberField(metric, "gateway_projection_bytes") +
    numberField(metric, "body_bytes") +
    numberField(metric, "row_bytes"), 0);
}

function countBy(rows, keyFn) {
  const out = {};
  for (const row of rows) {
    const key = keyFn(row);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function summarize(values) {
  const finite = values.filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (finite.length === 0) return { count: 0, sum: 0, mean: 0, p50: 0, p95: 0, max: 0 };
  const sumValue = finite.reduce((acc, value) => acc + value, 0);
  return {
    count: finite.length,
    sum: Math.round(sumValue),
    mean: Math.round(sumValue / finite.length),
    p50: Math.round(quantile(finite, 0.5)),
    p95: Math.round(quantile(finite, 0.95)),
    max: finite[finite.length - 1]
  };
}

function statValue(stats, field) {
  return stats.count > 0 ? stats[field] : null;
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function percent(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function toCsv(rows) {
  const columns = [
    "timestamp", "run_id", "deploy_short", "commit", "label",
    "smoke_passed", "smoke_attempted", "smoke_failed", "smoke_duration_ms",
    "tail_events", "metric_events",
    "worker_mcp_post_p95_ms", "worker_mcp_post_max_ms", "do_mcp_post_p95_ms", "do_mcp_post_max_ms",
    "turn_count", "turn_total_p50_ms", "turn_total_p95_ms", "turn_total_max_ms",
    "turn_submit_p95_ms", "turn_ensure_p95_ms", "turn_authority_p95_ms",
    "phase_ensure_share_pct", "phase_authority_share_pct", "phase_submit_share_pct", "phase_local_share_pct",
    "turn_attempts_avg", "turn_attempts_max", "turns_attempts_gt1",
    "repair_attempts", "repair_commit_rejected", "repair_missing_state", "shadow_commit_rejected",
    "state_path_divergence", "state_path_e_repair_budget", "state_path_e_need_state", "state_path_e_objnf",
    "state_path_e_verbnf", "state_path_e_nosession", "state_path_missing_live_session",
    "state_path_lookup_missing_object", "state_path_stale_commit_state",
    "recon_total", "recon_cold_open", "recon_warm_turn_refresh", "recon_missing_state_repair", "recon_slice_served",
    "recon_trigger_scope_seed", "recon_trigger_owner_prefetch", "recon_trigger_pre_plan_repair", "recon_trigger_turn_commit",
    "owner_prefetch_requested", "owner_prefetch_warm_local", "owner_prefetch_warm_donor", "owner_prefetch_residue",
    "cross_host_rpc_count", "cross_host_rpc_timeouts", "cross_host_rpc_p95_ms", "cross_host_rpc_max_ms",
    "authority_slice_rpc_count", "authority_slice_rpc_timeouts", "enumerate_tools_rpc_count", "fanout_rpc_count",
    "same_host_fallback_count",
    "v2_envelope_count", "v2_request_bytes_p50", "v2_request_bytes_p95", "v2_request_bytes_max", "v2_reply_bytes_p95",
    "projection_bytes", "tail_rows_written", "tail_bytes_retained_max", "storage_full_save_rows", "storage_direct_write_rows"
  ];
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvValue(row[column])).join(","));
  return lines.join("\n") + "\n";
}

function csvValue(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function renderSvg(rows, { title }) {
  const margin = { left: 86, right: 28, top: 58, bottom: 56 };
  const panelHeight = 116;
  const panelGap = 26;
  const panels = [
    panel("Smoke pass count", "steps", [
      lineSeries("passed", (r) => r.smoke_passed, "#111111"),
      lineSeries("attempted", (r) => r.smoke_attempted, "#9a9a9a"),
      barSeries("failed", (r) => r.smoke_failed, "#c4514a")
    ]),
    panel("Turn p95 latency", "seconds", [
      lineSeries("turn", (r) => r.turn_total_p95_ms / 1000, "#111111"),
      lineSeries("MCP POST", (r) => r.worker_mcp_post_p95_ms / 1000, "#5b6f94")
    ]),
    panel("Phase share of turn wall", "percent", [
      stackedShareSeries("ensure", (r) => r.phase_ensure_share_pct, "#c9c9c9"),
      stackedShareSeries("authority", (r) => r.phase_authority_share_pct, "#7f9db8"),
      stackedShareSeries("submit", (r) => r.phase_submit_share_pct, "#333333")
    ], { yMax: 100, stacked: true }),
    panel("Authority-slice reconstructions", "count", [
      lineSeries("total", (r) => r.recon_total, "#111111"),
      lineSeries("warm refresh", (r) => r.recon_warm_turn_refresh, "#c4514a"),
      lineSeries("owner prefetch", (r) => r.recon_trigger_owner_prefetch, "#5f8f58")
    ]),
    panel("Repair loop pressure", "count", [
      lineSeries("repair attempts", (r) => r.repair_attempts, "#111111"),
      lineSeries("turns >1 attempt", (r) => r.turns_attempts_gt1, "#c4514a")
    ]),
    panel("Envelope request p95", "MiB", [
      lineSeries("request p95", (r) => r.v2_request_bytes_p95 / (1024 * 1024), "#111111"),
      lineSeries("request max", (r) => r.v2_request_bytes_max / (1024 * 1024), "#9a9a9a")
    ]),
    panel("Cross-host RPCs", "count", [
      lineSeries("all", (r) => r.cross_host_rpc_count, "#111111"),
      lineSeries("authority-slice", (r) => r.authority_slice_rpc_count, "#5b6f94"),
      lineSeries("timeouts", (r) => r.cross_host_rpc_timeouts, "#c4514a")
    ])
  ];
  const chartWidth = Math.max(1080, margin.left + margin.right + rows.length * 76);
  const plotWidth = chartWidth - margin.left - margin.right;
  const height = margin.top + margin.bottom + panels.length * panelHeight + (panels.length - 1) * panelGap;
  const x = (index) => margin.left + (rows.length === 1 ? plotWidth / 2 : (index / (rows.length - 1)) * plotWidth);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${chartWidth}" height="${height}" viewBox="0 0 ${chartWidth} ${height}">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<text x="${margin.left}" y="28" font-family="Arial, sans-serif" font-size="18" font-weight="700" fill="#111">${escapeXml(title)}</text>`,
    `<text x="${margin.left}" y="48" font-family="Arial, sans-serif" font-size="12" fill="#555">${rows.length} run${rows.length === 1 ? "" : "s"}; generated ${escapeXml(new Date().toISOString())}</text>`
  ];

  panels.forEach((p, panelIndex) => {
    const top = margin.top + panelIndex * (panelHeight + panelGap);
    renderPanel(parts, p, rows, { top, height: panelHeight, margin, plotWidth, x });
  });

  const labelY = height - 24;
  rows.forEach((row, index) => {
    const label = row.commit || row.deploy_short || String(index + 1);
    parts.push(`<text transform="translate(${x(index)},${labelY}) rotate(-38)" text-anchor="end" font-family="Arial, sans-serif" font-size="10" fill="#444">${escapeXml(label)}</text>`);
  });
  parts.push(`</svg>`);
  return parts.join("\n") + "\n";
}

function panel(title, unit, series, options = {}) {
  return { title, unit, series, ...options };
}

function lineSeries(label, value, color) {
  return { type: "line", label, value, color };
}

function barSeries(label, value, color) {
  return { type: "bar", label, value, color };
}

function stackedShareSeries(label, value, color) {
  return { type: "stacked-share", label, value, color };
}

function renderPanel(parts, p, rows, geom) {
  const { top, height, margin, plotWidth, x } = geom;
  const values = p.series
    .flatMap((series) => rows.map((row) => numericValue(series.value(row))))
    .filter((value) => value !== null);
  const yMax = p.yMax || niceMax(Math.max(1, ...values));
  const y = (value) => top + height - (Math.max(0, value) / yMax) * height;

  parts.push(`<line x1="${margin.left}" y1="${top + height}" x2="${margin.left + plotWidth}" y2="${top + height}" stroke="#bdbdbd" stroke-width="1"/>`);
  parts.push(`<line x1="${margin.left}" y1="${top}" x2="${margin.left + plotWidth}" y2="${top}" stroke="#eeeeee" stroke-width="1"/>`);
  parts.push(`<text x="18" y="${top + 15}" font-family="Arial, sans-serif" font-size="12" font-weight="700" fill="#111">${escapeXml(p.title)}</text>`);
  parts.push(`<text x="18" y="${top + 32}" font-family="Arial, sans-serif" font-size="10" fill="#666">${escapeXml(p.unit)}</text>`);
  parts.push(`<text x="${margin.left - 8}" y="${top + 4}" text-anchor="end" font-family="Arial, sans-serif" font-size="10" fill="#777">${formatAxis(yMax)}</text>`);
  parts.push(`<text x="${margin.left - 8}" y="${top + height + 3}" text-anchor="end" font-family="Arial, sans-serif" font-size="10" fill="#777">0</text>`);

  if (p.stacked) renderStackedShares(parts, p, rows, { top, height, y, x });
  for (const series of p.series.filter((item) => item.type === "bar")) renderBars(parts, series, rows, { top, height, y, x });
  for (const series of p.series.filter((item) => item.type === "line")) renderLine(parts, series, rows, { y, x });

  let legendX = margin.left + plotWidth - 8;
  for (const series of [...p.series].reverse()) {
    const label = series.label;
    const textWidth = label.length * 6 + 20;
    legendX -= textWidth;
    parts.push(`<rect x="${legendX}" y="${top + 5}" width="10" height="10" fill="${series.color}" opacity="${series.type === "bar" ? "0.65" : "1"}"/>`);
    parts.push(`<text x="${legendX + 14}" y="${top + 14}" font-family="Arial, sans-serif" font-size="10" fill="#333">${escapeXml(label)}</text>`);
  }
}

function renderBars(parts, series, rows, { top, height, y, x }) {
  const barWidth = Math.max(8, Math.min(24, rows.length === 1 ? 24 : Math.abs(x(1) - x(0)) * 0.34));
  rows.forEach((row, index) => {
    const value = numericValue(series.value(row));
    if (value === null) return;
    const barTop = y(value);
    parts.push(`<rect x="${x(index) - barWidth / 2}" y="${barTop}" width="${barWidth}" height="${top + height - barTop}" fill="${series.color}" opacity="0.65"/>`);
  });
}

function renderLine(parts, series, rows, { y, x }) {
  const points = rows.map((row, index) => {
    const value = numericValue(series.value(row));
    return value === null ? null : { x: round(x(index)), y: round(y(value)) };
  });
  let segment = [];
  const flush = () => {
    if (segment.length > 1) {
      parts.push(`<polyline points="${segment.map((point) => `${point.x},${point.y}`).join(" ")}" fill="none" stroke="${series.color}" stroke-width="2"/>`);
    }
    segment = [];
  };
  for (const point of points) {
    if (point === null) flush();
    else segment.push(point);
  }
  flush();
  rows.forEach((row, index) => {
    const value = numericValue(series.value(row));
    if (value === null) return;
    parts.push(`<circle cx="${round(x(index))}" cy="${round(y(value))}" r="2.5" fill="${series.color}"/>`);
  });
}

function renderStackedShares(parts, panel, rows, { top, height, y, x }) {
  const barWidth = Math.max(12, Math.min(28, rows.length === 1 ? 28 : Math.abs(x(1) - x(0)) * 0.42));
  rows.forEach((row, index) => {
    let cursor = top + height;
    const seriesRows = panel.series
      .filter((item) => item.type === "stacked-share")
      .map((series) => ({ series, value: numericValue(series.value(row)) }));
    if (!seriesRows.some((item) => item.value !== null)) return;
    for (const { series, value: rawValue } of seriesRows) {
      const value = Math.max(0, rawValue || 0);
      const segmentTop = y((top + height - cursor) / height * 100 + value);
      parts.push(`<rect x="${x(index) - barWidth / 2}" y="${segmentTop}" width="${barWidth}" height="${cursor - segmentTop}" fill="${series.color}"/>`);
      cursor = segmentTop;
    }
  });
}

function numericValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function niceMax(value) {
  if (value <= 10) return 10;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  if (normalized <= 2) return 2 * magnitude;
  if (normalized <= 5) return 5 * magnitude;
  return 10 * magnitude;
}

function formatAxis(value) {
  if (value >= 1024 * 1024) return `${round(value / (1024 * 1024), 1)}M`;
  if (value >= 1000) return `${round(value / 1000, 1)}k`;
  return String(round(value, 1));
}

function printSummary(rows, paths) {
  const latest = rows[rows.length - 1];
  console.log(`# smoke-metrics-history: ${rows.length} run${rows.length === 1 ? "" : "s"}`);
  console.log(`out: ${paths.outDir}`);
  console.log(`json: ${paths.jsonPath}`);
  console.log(`csv: ${paths.csvPath}`);
  console.log(`chart: ${paths.chartPath}`);
  console.log("");
  console.log(`latest: ${latest.run_id}`);
  console.log(`  smoke: ${latest.smoke_passed}/${latest.smoke_attempted} passed (${latest.smoke_failed} failed)`);
  console.log(`  turn p95: ${formatMaybeMs(latest.turn_total_p95_ms)}; MCP POST p95: ${formatMaybeMs(latest.worker_mcp_post_p95_ms)}`);
  console.log(`  reconstructions: ${latest.recon_total} total, warm_turn_refresh=${latest.recon_warm_turn_refresh}, owner_prefetch=${latest.recon_trigger_owner_prefetch}`);
  console.log(`  repairs: attempts=${latest.repair_attempts}, turns_attempts_gt1=${latest.turns_attempts_gt1}`);
  console.log(`  envelope request p95: ${formatMaybeBytes(latest.v2_request_bytes_p95)}; cross-host RPCs=${latest.cross_host_rpc_count}`);
}

function formatMaybeMs(value) {
  return typeof value === "number" ? `${value} ms` : "n/a";
}

function formatMaybeBytes(value) {
  return typeof value === "number" ? formatBytes(value) : "n/a";
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${round(bytes / (1024 * 1024), 2)} MiB`;
  if (bytes >= 1024) return `${round(bytes / 1024, 1)} KiB`;
  return `${bytes} B`;
}

function round(value, digits = 0) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function timestampForPath(date) {
  return date.toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/, "Z");
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}
