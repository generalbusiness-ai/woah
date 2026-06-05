#!/usr/bin/env node
// analyze-data-path-costs -- classify smoke-tail metrics by data movement and
// serialization cost. This complements analyze-smoke-tail.mjs: that script
// explains time, while this one explains which observed events move, rewrite,
// reformat, or merely route data.

import { readFileSync } from "node:fs";

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("usage: node scripts/analyze-data-path-costs.mjs <tail.log> [tail2.log ...]");
  process.exit(2);
}

const CLASSIFICATION = {
  applied: {
    bucket: "commit_log",
    signal: "space, seq, verb, ms",
    endState: "Catalog log/application event; accepted frame remains the durable authority."
  },
  turn_phase_timing: {
    bucket: "request_wall_time",
    signal: "attempts, authority_calls, and per-phase ms (ensure/authority/serialize/plan_build/vm/submit)",
    endState: "Phase attribution for a turn; steady state is attempts=1 with authority+submit bounded by the turn's write set, local compute (serialize/plan_build/vm) negligible."
  },
  mcp_dispatch_timing: {
    bucket: "request_wall_time",
    signal: "method, cold_world, and per-step ms (get_world/forward/handle/register)",
    endState: "/mcp wrapper steps outside the turn; warm dispatch is small, DELETE teardown is best-effort, and a slow DELETE is contention behind a slow POST, not intrinsic cost."
  },
  mcp_relocation_prewarm: {
    bucket: "request_wall_time",
    signal: "scope, commit_scope, target, verb, ms, status",
    endState: "Speculative actor commit-scope head/session open for relocation-shaped MCP turns; normal commit validation remains authoritative."
  },
  broadcast: {
    bucket: "fanout",
    signal: "obs_count and audience_size",
    endState: "Route accepted/live payloads; no VM state transfer."
  },
  commit_reply_replay: {
    bucket: "idempotency",
    signal: "mode, scope, ms, bytes",
    endState: "Measure cached reply hit rate before keeping or moving reply-envelope persistence."
  },
  authority_slice_omitted: {
    bucket: "network_policy",
    signal: "host and object_count",
    endState: "Legacy omission event; current policy should prefer authority_slice_stale_fallback."
  },
  authority_slice_stale_fallback: {
    bucket: "network_policy",
    signal: "host, object_count, and reason",
    endState: "Owner read was skipped/timed out; local last-known rows kept so commit validation arbitrates freshness."
  },
  authority_slice_content_expansion: {
    bucket: "seed_cache",
    signal: "roots, objects, hosts, cap",
    endState: "Bounded pre-plan identity expansion from direct scope contents; replace with B7/projection warm-fill once steady-state warm turns need no reconstruction."
  },
  authority_tail: {
    bucket: "authority_append",
    signal: "tail_rows_written, tail_rows_pruned, tail_bytes_retained",
    endState: "Accepted-frame and transcript tails append new rows and prune by bounded horizon; no retained-tail rewrite."
  },
  browser_activity: {
    bucket: "browser_projection",
    signal: "phase, path, bytes, count, status",
    endState: "Client cache/projection work should consume checkpoints, tails, and projection deltas."
  },
  browser_metrics_log_sampled: {
    bucket: "browser_projection",
    signal: "suppressed browser metric log count",
    endState: "Instrumentation only; high suppression indicates browser_activity volume, not a separate data path."
  },
  compose_look: {
    bucket: "projection_read",
    signal: "present_count, contents_count, remote_titles, remote_describe_batches",
    endState: "Read projection summaries/descriptors without opening executable VM state."
  },
  cross_host_rpc: {
    bucket: "network_rpc",
    signal: "route, host, ms, status",
    endState: "Hot-path RPC must have a same-host last-known fallback; payloads should be frames, deltas, checkpoints, tails, or projection rows."
  },
  cross_host_rpc_start: {
    bucket: "network_rpc",
    signal: "route and host only",
    endState: "Start marker only; no serialization by itself."
  },
  direct_call: {
    bucket: "vm_execution",
    signal: "target, verb, observations, status, projection_bytes",
    endState: "Execution emits EffectTranscript; authority appends accepted frame and updates touched projection rows."
  },
  dispatch_resolved: {
    bucket: "routing",
    signal: "target, verb, host, path",
    endState: "Dispatch should route to the owning host; route shape decides whether WORLD remains a bottleneck."
  },
  dangling_parent_ref: {
    bucket: "data_integrity",
    signal: "start, missing, tombstoned",
    endState: "Repair orphaned projection rows through migration/cleanup, not hot-path fallback."
  },
  directory_sessions_for_scopes: {
    bucket: "session_binding",
    signal: "scopes, sessions, ms, status",
    endState: "Presence recovery reads bounded Directory session rows; failures should degrade to stale or empty rosters, not block commits."
  },
  do_constructor: {
    bucket: "cold_activation",
    signal: "class and ms",
    endState: "Constructor cost remains; must not trigger full state reformat."
  },
  do_handler: {
    bucket: "request_wall_time",
    signal: "route, host_key, ms",
    endState: "Wall-time wrapper; underlying events determine data movement."
  },
  host_schema_sync: {
    bucket: "reconciliation",
    signal: "planned/skipped",
    endState: "Eliminate from hot cold-load path; schema/catalog changes use explicit migration or projection rebuild."
  },
  host_seed_cache: {
    bucket: "seed_cache",
    signal: "host, status, reason, ms",
    endState: "Host seed cache remains bootstrap-only; normal catch-up uses checkpoint/tail."
  },
  host_seed_kv_restore_miss: {
    bucket: "seed_cache",
    signal: "cache, host, reason, ms",
    endState: "Bytecode-free KV misses fall back to signed authority seed; drift must not persist corrupt SQL."
  },
  kv_catalog_reservoir_build: {
    bucket: "seed_cache",
    signal: "catalog_key, objects, verbs, ms, status",
    endState: "Reservoir build is isolate-local cache fill, not per-user operation state transfer."
  },
  host_task_done: {
    bucket: "scheduler",
    signal: "label, ms, status",
    endState: "Queue lifecycle only; no authority data shape."
  },
  host_task_enqueue: {
    bucket: "scheduler",
    signal: "label, queue_depth",
    endState: "Queue lifecycle only."
  },
  host_task_start: {
    bucket: "scheduler",
    signal: "label, queued_ms",
    endState: "Queue lifecycle only."
  },
  host_task_blocked: {
    bucket: "scheduler",
    signal: "current_label, current_elapsed_ms, queue_depth",
    endState: "Diagnostic for serialized host-task wedges; should disappear when hot paths stop blocking hosts."
  },
  host_task_long_running: {
    bucket: "scheduler",
    signal: "label and elapsed_ms",
    endState: "Diagnostic for operations exceeding the host-task watchdog; investigate before optimizing around it."
  },
  init: {
    bucket: "cold_activation",
    signal: "phase and ms",
    endState: "World init should install checkpoint/tail or projection rows, not merge seeds."
  },
  mcp_fanout: {
    bucket: "fanout",
    signal: "shards, observations, affected_scopes",
    endState: "Fan out accepted frame, ProjectionDeltaSummary, and fanout observations; gateway consumes rows, not executable state."
  },
  mcp_gateway_rebind: {
    bucket: "session_binding",
    signal: "sessions_rebound",
    endState: "Session queue binding remains; not a state serialization surface."
  },
  mcp_observation_routed: {
    bucket: "fanout",
    signal: "queues_scanned and deliveries",
    endState: "Observation routing remains queue-local."
  },
  mcp_remote_commit_received: {
    bucket: "fanout_apply",
    signal: "scope, seq, observations, queue_count",
    endState: "Remote shards route observations and apply ProjectionDeltaSummary into projection-row cache."
  },
  mcp_remote_live_received: {
    bucket: "fanout_apply",
    signal: "scope, observations, queue_count",
    endState: "Live event routing remains non-durable."
  },
  mcp_request: {
    bucket: "request_wall_time",
    signal: "method, tool, ms",
    endState: "Transport wrapper; tool list/call/wait events determine data movement."
  },
  mcp_tool_refresh_skipped: {
    bucket: "tool_projection",
    signal: "reason, transcript",
    endState: "Refresh decision should use transcript/projection delta indexes."
  },
  mcp_tool_refresh_taken: {
    bucket: "tool_projection",
    signal: "reason, transcript",
    endState: "Refresh should update tool-surface projection rows, not enumerate executable state."
  },
  mcp_tool_resolve: {
    bucket: "tool_projection",
    signal: "object, verb, status",
    endState: "Resolve from actor, session, object, and tool-surface projection rows."
  },
  gateway_projection_apply: {
    bucket: "fanout_apply",
    signal: "rows, projection_bytes, source",
    endState: "Gateway consumes row-body-complete projection writes instead of running compatibility transcript apply."
  },
  gateway_projection_cache_write: {
    bucket: "fanout_apply",
    signal: "gateway_projection_rows_written, gateway_projection_bytes, source",
    endState: "Gateway projection SQL rows replace gateway mirror-world maintenance for accepted fanout."
  },
  gateway_tool_surface_source_rows: {
    bucket: "tool_projection",
    signal: "scope, object, rows, scope_rows, shard_rows, cap, shard_cap, saturated",
    endState: "Tool-surface reverse-index growth is measured and capped; saturated scopes fall back to session manifests or owner refresh."
  },
  moveto_actor: {
    bucket: "vm_effect",
    signal: "actor, from, to",
    endState: "Movement remains a transcript move/write; projection delta names actor, session, contents, and log rows."
  },
  rest_v2_in_process_fallback: {
    bucket: "routing_fallback",
    signal: "reason, scope, target, route, persistence",
    endState: "Fallback is exceptional; normal live/durable dispatch should route through explicit host/authority paths."
  },
  session_reap: {
    bucket: "background_session",
    signal: "inspected, reaped, guest_reaped, credential_reaped",
    endState: "Emit one metric per reap sweep only when reaped>0, with inspected/reaped counts; not per inspected session."
  },
  serialized_world_materialized: {
    bucket: "compat_transform",
    signal: "reason, scope, seq, objects, sessions, logs, ms",
    endState: "Only explicit legacy/export/checkpoint/execution boundaries materialize SerializedWorld; normal accepted commit does not."
  },
  same_host_fallback: {
    bucket: "tool_projection",
    signal: "route, host, rows, reason",
    endState: "Hot descriptor reads return bounded same-host projection data when an owner refresh is unavailable."
  },
  shadow_apply_step: {
    bucket: "commit_apply",
    signal: "phase, objects, creates, writes, projection_bytes, serialized_world_materialized",
    endState: "Apply once, return row ops, and skip eager SerializedWorld materialization on normal commits."
  },
  shadow_commit_accepted: {
    bucket: "authority_append",
    signal: "scope, seq, fanout",
    endState: "Becomes accepted frame append."
  },
  shadow_commit_rejected: {
    bucket: "authority_append",
    signal: "scope, reason",
    endState: "Rejected frames remain control-plane events; successful commits append accepted frames."
  },
  commit_scope_multi: {
    bucket: "routing",
    signal: "scope, owners, verb",
    endState: "B6 flags a turn whose write set spans >=2 distinct non-planning authority owners; it commits at the planning scope for now and is counted here. B8 route homes decide combined/minted scope vs clean retryable conflict."
  },
  authority_slice_reconstructed: {
    bucket: "seed_cache",
    signal: "reason, scope, object_count, page_count, source_host",
    endState: "Per-turn authority-slice reconstruction (warm_turn_refresh) is replaced by content-addressed read-through warm cache-fill (B7) plus checkpoint/tail catch-up; steady-state warm turns reconstruct nothing."
  },
  authority_slice_partition: {
    bucket: "cross_host",
    signal: "host, reason, object_count, objects",
    endState: "Ids a turn could not resolve locally, partitioned to a remote owner (real RPC or snapshot fallback). CA11.2 topology pre-seeding drives a served scope's one-hop neighbor lineage OUT of this partition; a residual partition for a neighbor on a cold READ is a pre-seed gap. An occupancy move legitimately partitions its destination once (missing_state_repair)."
  },
  scope_topology_seed: {
    bucket: "seed_cache",
    signal: "scopes, seeded",
    endState: "CA11.2 bounded one-hop topology closure merged into a gateway shard's cold world (lineage-only neighbor rooms + full catalog-class chain) so cold moves resolve neighbor lineage locally instead of a cross-host authority-slice. Bounded by served-scope x exit fan-degree; not a steady-state cost."
  },
  shadow_gateway_apply_step: {
    bucket: "compat_transform",
    signal: "phase, objects, properties, writes",
    endState: "Remove gateway mirror-world apply; consume accepted frame plus ProjectionDeltaSummary into projection cache."
  },
  shadow_open_executable_seed_bytes: {
    bucket: "known_bytes",
    signal: "bytes, pages, inline_pages",
    endState: "Replace normal catch-up executable seed transfer with checkpoint/tail batch transfer."
  },
  shadow_transcript_anomaly: {
    bucket: "data_integrity",
    signal: "scope, route, reason, object",
    endState: "Transcript vocabulary should cover durable side effects without anomalies."
  },
  state_projection: {
    bucket: "projection_read",
    signal: "objects, remote_hosts, ms",
    endState: "Projection reads should use materialized rows and bounded descriptor RPCs."
  },
  startup_storage: {
    bucket: "cold_storage",
    signal: "phase, objects/properties/sessions/writes/source",
    endState: "Host seed merge leaves the normal user path; checkpoint/tail handles scope state."
  },
  storage_direct_write: {
    bucket: "storage_rows",
    signal: "what, rows, projection_bytes",
    endState: "Normal turns write accepted frame plus touched projection rows; broad rewrites only during checkpoint/migration."
  },
  storage_direct_write_log_sampled: {
    bucket: "storage_rows",
    signal: "suppressed direct-write log count",
    endState: "Instrumentation only; high suppression indicates row-write volume."
  },
  storage_flush: {
    bucket: "storage_rows",
    signal: "rows and bytes by family",
    endState: "Flushes remain proportional to touched projection rows and indexes."
  },
  storage_full_save: {
    bucket: "full_snapshot",
    signal: "rows, objects, properties, verbs, sessions",
    endState: "Not on /v2/envelope or warm /v2/open; checkpoint/bootstrap/migration only; must not rewrite append-only tails."
  },
  subscribers_write: {
    bucket: "state_write",
    signal: "space, size, delta",
    endState: "Subscriber state should be small session/projection/live-shard state."
  },
  v2_envelope: {
    bucket: "commit_request",
    signal: "reply, fanout, full_save, ms, projection_bytes, reply_hit",
    endState: "Envelope writes accepted frame and touched rows; reply SQL write must be measured or moved off hot path."
  },
  v2_host_apply_fanout: {
    bucket: "fanout_apply",
    signal: "hosts, touched, ms",
    endState: "Send accepted frame plus ProjectionDeltaSummary; avoid reconstructing authority slices or running gateway-world apply."
  },
  v2_open: {
    bucket: "known_bytes",
    signal: "executable_transfer_bytes/pages/cache",
    endState: "Open transfers checkpoint/tail batches; checkpoint build must not cause unbounded single-flight waits."
  },
  v2_open_step: {
    bucket: "known_bytes",
    signal: "read_json bytes and open_seed_json_bytes",
    endState: "Open request/response bodies shrink to head negotiation plus checkpoint/tail batch."
  },
  v2_state_transfer: {
    bucket: "known_bytes",
    signal: "transfer_mode, full_save, status, ms",
    endState: "State transfer should be checkpoint/tail batch, not full executable seed."
  },
  v2_ws_close: {
    bucket: "transport",
    signal: "scope, node, code, clean, ms",
    endState: "Transport lifecycle only; state transfer cost is in open/frame metrics."
  },
  v2_ws_error: {
    bucket: "transport",
    signal: "scope, node, error, ms",
    endState: "Transport error diagnostic; should not define authority data shape."
  },
  v2_ws_open: {
    bucket: "transport",
    signal: "scope, node, actor, ms",
    endState: "Transport lifecycle only; authority data is checkpoint/tail/projection."
  },
  v2_ws_reject: {
    bucket: "transport",
    signal: "scope, node, error, ms",
    endState: "Transport rejection diagnostic; should not define authority data shape."
  }
};

const all = [];
for (const path of paths) {
  const metrics = metricsFromTail(readFileSync(path, "utf8"));
  all.push({ path, metrics });
}

for (const item of all) reportFile(item.path, item.metrics);
if (all.length > 1) reportFile("ALL INPUTS", all.flatMap((item) => item.metrics));

function metricsFromTail(text) {
  const events = parseTailEvents(text);
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
        // ignore malformed metric lines
      }
    }
  }
  return metrics;
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
      try { out.push(JSON.parse(buf.join("\n"))); } catch { /* skip */ }
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

function reportFile(label, metrics) {
  console.log("");
  console.log("# Data-path cost analysis: " + label);
  console.log("");
  console.log(`metrics: ${metrics.length}`);
  console.log(`kinds: ${new Set(metrics.map((m) => m.kind)).size}`);
  reportKnownBytes(metrics);
  reportRows(metrics);
  reportTransformSurfaces(metrics);
  reportSuccessCostSummary(metrics);
  reportToolSurfaceSourceRows(metrics);
  reportRpc(metrics);
  reportVerbTraces(metrics);
  reportMetricVolume(metrics);
  reportCoverage(metrics);
}

function reportKnownBytes(metrics) {
  const openReadJson = sum(metrics.filter((m) => m.kind === "v2_open_step" && m.phase === "read_json"), "bytes");
  const openSeedStep = sum(metrics.filter((m) => m.kind === "v2_open_step" && m.phase === "open_seed_json_bytes"), "bytes");
  const openSeed = sum(metrics.filter((m) => m.kind === "v2_open"), "executable_transfer_bytes");
  const openPages = sum(metrics.filter((m) => m.kind === "v2_open"), "executable_transfer_pages");
  const openInlinePages = sum(metrics.filter((m) => m.kind === "v2_open"), "executable_transfer_inline_pages");
  const opens = metrics.filter((m) => m.kind === "v2_open");
  const misses = opens.filter((m) => m.executable_transfer_cache === "miss").length;
  section("Known serialized byte costs");
  console.log(`v2_open request JSON bytes:       ${formatBytes(openReadJson)} (${openReadJson} bytes)`);
  console.log(`v2_open executable seed bytes:    ${formatBytes(openSeed)} (${openSeed} bytes)`);
  console.log(`v2_open seed bytes by step:       ${formatBytes(openSeedStep)} (${openSeedStep} bytes)`);
  console.log(`v2_open executable pages:         ${openPages} pages (${openInlinePages} inline)`);
  console.log(`v2_open executable cache misses:  ${misses}/${opens.length}`);
  const byScope = groupBy(opens, (m) => m.scope || "?");
  console.log("");
  console.log("| scope | opens | misses | seed bytes | pages |");
  console.log("|---|---:|---:|---:|---:|");
  for (const [scope, rows] of [...byScope].sort((a, b) => sum(b[1], "executable_transfer_bytes") - sum(a[1], "executable_transfer_bytes"))) {
    console.log(`| ${scope} | ${rows.length} | ${rows.filter((m) => m.executable_transfer_cache === "miss").length} | ${sum(rows, "executable_transfer_bytes")} | ${sum(rows, "executable_transfer_pages")} |`);
  }
}

function reportRows(metrics) {
  const full = metrics.filter((m) => m.kind === "storage_full_save");
  const direct = metrics.filter((m) => m.kind === "storage_direct_write");
  const projectionBytes = sumProjectionBytes(metrics);
  section("Storage row costs");
  console.log(`storage_full_save count: ${full.length}`);
  console.log(`storage_full_save rows:  ${sum(full, "rows")}`);
  console.log(`  objects=${sum(full, "objects")} properties=${sum(full, "properties")} verbs=${sum(full, "verbs")} sessions=${sum(full, "sessions")} logs=${sum(full, "logs")}`);
  console.log(`storage_direct_write rows: ${sum(direct, "rows")} across ${direct.length} metrics`);
  console.log(`observed projection bytes: ${formatBytes(projectionBytes)} (${projectionBytes} bytes; requires projection_bytes/body_bytes instrumentation)`);
  console.log("");
  console.log("| direct write kind | events | rows | projection bytes |");
  console.log("|---|---:|---:|---:|");
  for (const [what, rows] of [...groupBy(direct, (m) => m.what || "?")].sort((a, b) => sum(b[1], "rows") - sum(a[1], "rows"))) {
    console.log(`| ${what} | ${rows.length} | ${sum(rows, "rows")} | ${sumProjectionBytes(rows)} |`);
  }
}

function reportTransformSurfaces(metrics) {
  section("Transformation surfaces");
  const gatewayTotals = metrics.filter((m) => m.kind === "shadow_gateway_apply_step" && m.phase === "total");
  const applyTotals = metrics.filter((m) => m.kind === "shadow_apply_step" && m.phase === "total");
  console.log(`gateway apply totals: ${gatewayTotals.length} events; objects scanned=${sum(gatewayTotals, "objects")} properties seen=${sum(gatewayTotals, "properties")} writes=${sum(gatewayTotals, "writes")} creates=${sum(gatewayTotals, "creates")}`);
  console.log(`commit apply totals:  ${applyTotals.length} events; objects indexed=${sum(applyTotals, "objects")} writes=${sum(applyTotals, "writes")} creates=${sum(applyTotals, "creates")}`);
  console.log("");
  console.log("| surface | scope | events | objects | properties | writes | creates |");
  console.log("|---|---|---:|---:|---:|---:|---:|");
  for (const [key, rows] of [...groupBy(gatewayTotals, (m) => `gateway|${m.scope || "?"}`)]) {
    const [, scope] = key.split("|");
    console.log(`| gateway cache apply | ${scope} | ${rows.length} | ${sum(rows, "objects")} | ${sum(rows, "properties")} | ${sum(rows, "writes")} | ${sum(rows, "creates")} |`);
  }
  for (const [key, rows] of [...groupBy(applyTotals, (m) => `commit|${m.scope || "?"}`)]) {
    const [, scope] = key.split("|");
    console.log(`| commit apply | ${scope} | ${rows.length} | ${sum(rows, "objects")} |  | ${sum(rows, "writes")} | ${sum(rows, "creates")} |`);
  }
}

function reportSuccessCostSummary(metrics) {
  const v2Envelopes = metrics.filter((m) => m.kind === "v2_envelope");
  const authorityTail = metrics.filter((m) => m.kind === "authority_tail");
  const gatewayProjection = metrics.filter((m) => m.kind === "gateway_projection_apply" || m.kind === "gateway_projection_cache_write");
  const fanoutProjection = gatewayProjection.filter((m) => m.source === "fanout");
  const hostFanout = metrics.filter((m) => m.kind === "v2_host_apply_fanout");
  const checkpointTransfers = metrics.filter((m) =>
    (m.kind === "v2_open_step" || m.kind === "browser_activity") &&
    typeof m.transfer_mode === "string" &&
    m.transfer_mode.startsWith("checkpoint_tail")
  );
  const checkpointBuild = metrics.filter((m) => m.kind === "v2_open_step" && m.phase === "checkpoint_build");
  const checkpointPackaging = metrics.filter((m) => m.kind === "v2_open_step" && m.phase === "checkpoint_tail_packaging");
  const ownerRefresh = metrics.filter((m) => m.kind === "cross_host_rpc" && m.route === "/__internal/enumerate-tools");
  const roundTrips = metrics.filter((m) => m.kind === "cross_host_rpc");
  const sameHostFallbacks = metrics.filter((m) => m.kind === "same_host_fallback");

  const tailRowsWritten = sum(authorityTail, "tail_rows_written") + sum(v2Envelopes, "tail_rows_written");
  const tailBytesRetained = Math.max(max(authorityTail, "tail_bytes_retained"), max(v2Envelopes, "tail_bytes_retained"));

  section("Success-criteria cost summary");
  console.log("| field | value | evidence metrics |");
  console.log("|---|---:|---|");
  console.log(`| frame bytes | ${sumFlexible(metrics, ["frame_bytes", "accepted_frame_bytes"])} | frame_bytes/accepted_frame_bytes when emitted |`);
  console.log(`| projection rows touched | ${sum(gatewayProjection, "rows") + sum(hostFanout, "touched")} | gateway_projection_* rows + v2_host_apply_fanout.touched |`);
  console.log(`| projection bytes | ${sumProjectionBytes(metrics)} | projection_bytes/gateway_projection_bytes/body_bytes/row_bytes |`);
  console.log(`| fanout rows touched | ${sum(fanoutProjection, "rows") + sum(hostFanout, "touched")} | fanout gateway projection rows + host write-through touched |`);
  console.log(`| checkpoint transfer bytes | ${sum(checkpointTransfers, "bytes")} | checkpoint_tail transfer v2_open_step/browser_activity bytes |`);
  console.log(`| tail rows written | ${tailRowsWritten} | authority_tail + v2_envelope tail_rows_written |`);
  console.log(`| tail bytes retained | ${tailBytesRetained} | max authority_tail/v2_envelope tail_bytes_retained |`);
  console.log(`| checkpoint build ms | ${sum(checkpointBuild, "ms")} | v2_open_step phase=checkpoint_build |`);
  console.log(`| checkpoint packaging ms | ${sum(checkpointPackaging, "ms")} | v2_open_step phase=checkpoint_tail_packaging |`);
  console.log(`| same-host fallback count | ${sameHostFallbacks.length} | same_host_fallback events |`);
  console.log(`| remote owner refresh count | ${ownerRefresh.length} | cross_host_rpc route=/__internal/enumerate-tools |`);
  console.log(`| cross-host round trips | ${roundTrips.length} | cross_host_rpc events |`);
}

function reportToolSurfaceSourceRows(metrics) {
  const sourceRows = metrics.filter((m) => m.kind === "gateway_tool_surface_source_rows");
  section("Tool-surface reverse-index sizing");
  console.log(`gateway_tool_surface_source_rows events: ${sourceRows.length}`);
  if (sourceRows.length === 0) {
    console.log("No tool-surface reverse-index metrics were observed.");
    return;
  }
  console.log(`source rows requested: ${sum(sourceRows, "rows")}`);
  console.log(`cap-hit events: ${sourceRows.filter((m) => m.saturated === true).length}`);
  console.log("");
  console.log("| scope | events | objects | source rows requested | max scope rows | scope cap | max shard rows | shard cap | cap hits | saturation reasons |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const [scope, rows] of [...groupBy(sourceRows, (m) => m.scope || "?")]
    .sort((a, b) => max(b[1], "scope_rows") - max(a[1], "scope_rows") || a[0].localeCompare(b[0]))) {
    const objects = new Set(rows.map((m) => m.object || "?")).size;
    const reasons = [...new Set(rows.filter((m) => m.saturated === true).map((m) => m.saturation_reason || "unknown"))].join(",") || "";
    console.log(`| ${scope} | ${rows.length} | ${objects} | ${sum(rows, "rows")} | ${max(rows, "scope_rows")} | ${max(rows, "cap")} | ${max(rows, "shard_rows")} | ${max(rows, "shard_cap")} | ${rows.filter((m) => m.saturated === true).length} | ${reasons} |`);
  }
}

function reportRpc(metrics) {
  section("Cross-host RPC pressure");
  const rpcs = metrics.filter((m) => m.kind === "cross_host_rpc");
  console.log("| route | host | count | timeouts | ms sum | max ms | data-path treatment |");
  console.log("|---|---|---:|---:|---:|---:|---|");
  for (const [key, rows] of [...groupBy(rpcs, (m) => `${m.route || "?"}|${m.host || "?"}`)].sort((a, b) => sum(b[1], "ms") - sum(a[1], "ms"))) {
    const [route, host] = key.split("|");
    console.log(`| ${route} | ${host} | ${rows.length} | ${rows.filter((m) => m.status === "timeout").length} | ${sum(rows, "ms")} | ${max(rows, "ms")} | ${rpcTreatment(route)} |`);
  }
}

function reportVerbTraces(metrics) {
  section("Observed verb traces");
  const calls = metrics.filter((m) => m.kind === "direct_call");
  console.log("| target:verb | count | observations | projection bytes | statuses | end-state durable data |");
  console.log("|---|---:|---:|---:|---|---|");
  for (const [key, rows] of [...groupBy(calls, (m) => `${m.target || "?"}:${m.verb || "?"}`)].sort((a, b) => a[0].localeCompare(b[0]))) {
    const statuses = [...new Set(rows.map((m) => m.status || "?"))].join(",");
    console.log(`| ${key} | ${rows.length} | ${sum(rows, "observations")} | ${sumProjectionBytes(rows)} | ${statuses} | ${verbTreatment(key)} |`);
  }
}

function reportMetricVolume(metrics) {
  section("Metric volume and noise checks");
  const byKind = [...groupBy(metrics, (m) => m.kind || "?")]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const sessionReap = byKind.find(([kind]) => kind === "session_reap")?.[1].length ?? 0;
  const percent = metrics.length > 0 ? (sessionReap / metrics.length * 100).toFixed(1) : "0.0";
  console.log(`session_reap metrics: ${sessionReap}/${metrics.length} (${percent}%)`);
  console.log("");
  console.log("| kind | count | share | measurement note |");
  console.log("|---|---:|---:|---|");
  for (const [kind, rows] of byKind.slice(0, 8)) {
    const share = metrics.length > 0 ? `${(rows.length / metrics.length * 100).toFixed(1)}%` : "0.0%";
    const note = kind === "session_reap"
      ? "If high, fix reap instrumentation before using metric counts as cost evidence."
      : "";
    console.log(`| ${kind} | ${rows.length} | ${share} | ${note} |`);
  }
}

function reportCoverage(metrics) {
  section("Observed metric-kind coverage");
  const byKind = groupBy(metrics, (m) => m.kind || "?");
  const unknown = [];
  console.log("| kind | count | bucket | cost signal | end-state treatment |");
  console.log("|---|---:|---|---|---|");
  for (const [kind, rows] of [...byKind].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    const c = CLASSIFICATION[kind];
    if (!c) unknown.push(kind);
    console.log(`| ${kind} | ${rows.length} | ${c?.bucket || "UNCLASSIFIED"} | ${c?.signal || ""} | ${c?.endState || ""} |`);
  }
  if (unknown.length > 0) {
    console.error(`\nUnclassified metric kinds: ${unknown.join(", ")}`);
    process.exitCode = 1;
  }
}

function rpcTreatment(route) {
  if (route === "/__internal/enumerate-tools") return "Read same-host tool-surface projection cache first; owner RPC refresh timeout returns stale rows, not failure.";
  if (route === "/__internal/authority-slice") return "Replace authority slice reconstruction with checkpoint/tail transfer.";
  if (route === "/__internal/apply-v2-commit") return "Send accepted frame plus ProjectionDeltaSummary and touched projection rows only; no receiver rediscovery.";
  if (route === "/__internal/mcp-commit-fanout") return "Send accepted frame/fanout observations; gateway consumes projection rows, not executable state.";
  if (route === "/__internal/mcp-live-fanout") return "Live observations only.";
  if (route === "/__internal/space-audience-sessions") return "Audience query; minimize by session projection rows/indexes, not world transfer.";
  return "Route-specific; classify by payload before optimizing.";
}

function verbTreatment(key) {
  if (key.includes(":say")) return "Live/direct transcript observations only unless catalog marks durable.";
  if (key.includes(":enter") || key.includes(":leave") || key.includes(":west") || key.includes(":southeast")) return "Transcript + accepted frame + touched actor/session/contents projection rows.";
  if (key.includes(":add_item") || key.includes(":add_note")) return "Transcript + accepted frame + created object/container projection rows + fanout observations.";
  if (key.includes(":next_pending") || key.includes(":set_properties")) return "Self-hosted block transcript + touched projection rows; no whole object or WORLD snapshot.";
  return "Transcript if durable; live observation only if live.";
}

function section(title) {
  console.log("");
  console.log("## " + title);
  console.log("");
}

function sum(rows, field) {
  return rows.reduce((acc, row) => acc + number(row[field]), 0);
}

function sumProjectionBytes(rows) {
  return rows.reduce((acc, row) => acc + projectionBytes(row), 0);
}

function sumFlexible(rows, fields) {
  return rows.reduce((acc, row) => acc + Math.max(...fields.map((field) => number(row[field]))), 0);
}

function projectionBytes(row) {
  const explicit = number(row.projection_bytes);
  if (explicit) return explicit;
  const gateway = number(row.gateway_projection_bytes);
  if (gateway) return gateway;
  const body = number(row.body_bytes);
  if (body) return body;
  return number(row.row_bytes);
}

function max(rows, field) {
  return rows.reduce((acc, row) => Math.max(acc, number(row[field])), 0);
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function groupBy(rows, fn) {
  const out = new Map();
  for (const row of rows) {
    const key = fn(row);
    const list = out.get(key);
    if (list) list.push(row);
    else out.set(key, [row]);
  }
  return out;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}
