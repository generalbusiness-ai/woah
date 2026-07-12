/**
 * Query the dataset-backed net canary envelope from Workers Analytics Engine.
 *
 * Tail is diagnostic-only under load: Cloudflare samples it before the
 * consumer sees the records. This tool reads the METRICS dataset directly,
 * applies AE's adaptive-sampling weight, and fails closed when the acceptance
 * sample or health envelope is insufficient.
 *
 *   CF_ACCOUNT_ID=... CF_ANALYTICS_TOKEN=... npm run metrics:net-ae -- \
 *     --dataset woo_v1_net_canary --from 2026-07-11T18:00:00Z --min-turns 500
 *
 * Add `--watch --min-seconds 120 --max-seconds 600` during a cutover bake.
 * Watch mode polls a growing window, aborts immediately on integrity
 * incidents, and fails closed if sufficient healthy evidence never arrives.
 */

type AeRow = Record<string, unknown>;

export type NetAeReport = {
  summary: AeRow[];
  turns: AeRow[];
  authorities: AeRow[];
  incidents: AeRow[];
};

export type NetAeLimits = {
  minTurns: number;
  maxErrorRate: number;
  maxWallP99Ms: number;
  maxQueueP99Ms: number;
  minGatewayShards: number;
  minElasticGuests: number;
};

const DEFAULT_LIMITS: NetAeLimits = {
  minTurns: 500,
  maxErrorRate: 0.01,
  maxWallP99Ms: 500,
  maxQueueP99Ms: 1_000,
  minGatewayShards: 2,
  minElasticGuests: 1
};

const WEIGHT = "_sample_interval * double2";

export type NetAeWatchDecision = {
  state: "wait" | "pass" | "abort";
  failures: string[];
};

function assertDataset(dataset: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(dataset)) throw new Error(`invalid Analytics Engine dataset: ${JSON.stringify(dataset)}`);
  return dataset;
}

function timeWhere(from: number, to: number): string {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error("metrics window must have finite from < to");
  return `timestamp >= toDateTime(${Math.floor(from)}) AND timestamp < toDateTime(${Math.ceil(to)})`;
}

export function buildTurnSql(dataset: string, from: number, to: number): string {
  return [
    "SELECT",
    "  index1 AS host_key,",
    `  SUM(${WEIGHT}) AS samples,`,
    `  SUMIf(${WEIGHT}, blob8 != 'accepted') AS errors,`,
    `  SUMIf(${WEIGHT}, blob9 = 'E_RPC_TIMEOUT') AS rpc_timeouts,`,
    `  quantileWeighted(0.5)(double5, toUInt32(${WEIGHT})) AS wall_p50,`,
    `  quantileWeighted(0.95)(double5, toUInt32(${WEIGHT})) AS wall_p95,`,
    `  quantileWeighted(0.99)(double5, toUInt32(${WEIGHT})) AS wall_p99,`,
    `  quantileWeighted(0.99)(double4, toUInt32(${WEIGHT})) AS queue_p99,`,
    `  quantileWeighted(0.99)(double6, toUInt32(${WEIGHT})) AS rpc_p99,`,
    `  quantileWeighted(0.99)(double7, toUInt32(${WEIGHT})) AS rpc_max_p99,`,
    `  SUM(${WEIGHT} * double10) / SUM(${WEIGHT}) AS mean_attempt,`,
    `  SUM(${WEIGHT} * double11) AS reconstructions,`,
    `  SUM(${WEIGHT} * double9) / SUM(${WEIGHT}) AS mean_sync_rpc`,
    `FROM ${assertDataset(dataset)}`,
    `WHERE ${timeWhere(from, to)} AND blob1 = 'net_turn_structure'`,
    "GROUP BY host_key",
    "ORDER BY host_key"
  ].join("\n");
}

/** One global distribution for acceptance. Per-shard p99s are useful
 * diagnostics but are not composable and become unstable when AE assigns a
 * large adaptive-sampling weight to one row on a lightly used shard. */
export function buildTurnSummarySql(dataset: string, from: number, to: number): string {
  return [
    "SELECT",
    `  SUM(${WEIGHT}) AS samples,`,
    `  SUMIf(${WEIGHT}, blob8 != 'accepted') AS errors,`,
    `  SUMIf(${WEIGHT}, blob9 = 'E_RPC_TIMEOUT') AS rpc_timeouts,`,
    `  quantileWeighted(0.5)(double5, toUInt32(${WEIGHT})) AS wall_p50,`,
    `  quantileWeighted(0.95)(double5, toUInt32(${WEIGHT})) AS wall_p95,`,
    `  quantileWeighted(0.99)(double5, toUInt32(${WEIGHT})) AS wall_p99,`,
    `  quantileWeighted(0.99)(double4, toUInt32(${WEIGHT})) AS queue_p99,`,
    `  max(double5) AS wall_max`,
    `FROM ${assertDataset(dataset)}`,
    `WHERE ${timeWhere(from, to)} AND blob1 = 'net_turn_structure'`
  ].join("\n");
}

export function buildAuthoritySql(dataset: string, from: number, to: number): string {
  return [
    "SELECT",
    "  index1 AS host_key,",
    "  blob2 AS scope,",
    `  SUM(${WEIGHT}) AS samples,`,
    `  quantileWeighted(0.95)(double1, toUInt32(${WEIGHT})) AS submit_p95,`,
    `  quantileWeighted(0.99)(double1, toUInt32(${WEIGHT})) AS submit_p99,`,
    `  SUM(${WEIGHT} * double14) AS outbox_enqueued`,
    `FROM ${assertDataset(dataset)}`,
    `WHERE ${timeWhere(from, to)} AND blob1 = 'net_scope_submit'`,
    "GROUP BY host_key, scope",
    "ORDER BY samples DESC",
    "LIMIT 100"
  ].join("\n");
}

export function buildIncidentSql(dataset: string, from: number, to: number): string {
  const kinds = [
    "net_rpc",
    "net_turn_queue_refused",
    "net_scope_outbox_delivery_failed",
    "net_scope_outbox_abandoned",
    "net_scope_outbox_drain_pass",
    "net_fanout_gap",
    "net_turn_install_degraded",
    "net_session_open_install_degraded",
    "net_guest_provision_install_degraded",
    "net_guest_provisioned",
    "net_self_subscribe_failed",
    "net_adopt_conflict"
  ].map((kind) => `'${kind}'`).join(", ");
  return [
    "SELECT",
    "  blob1 AS kind,",
    "  blob2 AS scope,",
    "  blob9 AS error,",
    `  SUM(${WEIGHT}) AS samples,`,
    `  SUM(${WEIGHT} * double15) AS delivered,`,
    `  SUM(${WEIGHT} * double16) AS failed,`,
    `  SUM(${WEIGHT} * double17) AS abandoned`,
    `FROM ${assertDataset(dataset)}`,
    `WHERE ${timeWhere(from, to)} AND blob1 IN (${kinds})`,
    "GROUP BY kind, scope, error",
    "ORDER BY kind, scope, error"
  ].join("\n");
}

function number(row: AeRow, field: string): number {
  const value = Number(row[field] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export function evaluateNetAeReport(report: NetAeReport, limits: Partial<NetAeLimits> = {}): string[] {
  const wanted = { ...DEFAULT_LIMITS, ...limits };
  const global = report.summary[0] ?? {};
  const total = number(global, "samples");
  const errors = number(global, "errors");
  const timeouts = number(global, "rpc_timeouts");
  const wallP99 = number(global, "wall_p99");
  const queueP99 = number(global, "queue_p99");
  const gatewayShards = new Set(report.turns.filter((row) => number(row, "samples") > 0).map((row) => String(row.host_key ?? ""))).size;
  const incident = (kind: string) => report.incidents
    .filter((row) => row.kind === kind)
    .reduce((sum, row) => sum + number(row, "samples"), 0);
  const outboxAbandoned = report.incidents.reduce((sum, row) => sum + number(row, "abandoned"), 0);

  const failures: string[] = [];
  if (total < wanted.minTurns) failures.push(`only ${total} turns recorded; need ${wanted.minTurns}`);
  if (total > 0 && errors / total > wanted.maxErrorRate) {
    failures.push(`turn error rate ${((errors / total) * 100).toFixed(2)}% exceeds ${(wanted.maxErrorRate * 100).toFixed(2)}%`);
  }
  if (timeouts > 0 || incident("net_rpc") > 0) failures.push(`${Math.max(timeouts, incident("net_rpc"))} RPC timeout(s)`);
  if (wallP99 > wanted.maxWallP99Ms) failures.push(`global wall p99 ${wallP99}ms exceeds ${wanted.maxWallP99Ms}ms`);
  if (queueP99 > wanted.maxQueueP99Ms) failures.push(`global queue p99 ${queueP99}ms exceeds ${wanted.maxQueueP99Ms}ms`);
  if (gatewayShards < wanted.minGatewayShards) failures.push(`only ${gatewayShards} gateway shard(s) carried turns; need ${wanted.minGatewayShards}`);
  if (incident("net_guest_provisioned") < wanted.minElasticGuests) {
    failures.push(`only ${incident("net_guest_provisioned")} elastic guest(s) observed; need ${wanted.minElasticGuests}`);
  }
  if (incident("net_turn_queue_refused") > 0) failures.push(`${incident("net_turn_queue_refused")} queue refusal(s)`);
  if (incident("net_scope_outbox_delivery_failed") > 0) {
    failures.push(`${incident("net_scope_outbox_delivery_failed")} outbox delivery failure(s)`);
  }
  if (incident("net_scope_outbox_abandoned") > 0 || outboxAbandoned > 0) failures.push("outbox abandonment observed");
  if (incident("net_fanout_gap") > 0) failures.push(`${incident("net_fanout_gap")} fanout gap(s)`);
  for (const kind of ["net_turn_install_degraded", "net_session_open_install_degraded", "net_guest_provision_install_degraded", "net_self_subscribe_failed", "net_adopt_conflict"]) {
    if (incident(kind) > 0) failures.push(`${incident(kind)} ${kind} incident(s)`);
  }
  return failures;
}

/** Incidents that are never made acceptable by collecting more samples. */
export function immediateNetAeFailures(report: NetAeReport): string[] {
  const global = report.summary[0] ?? {};
  const incident = (kind: string) => report.incidents
    .filter((row) => row.kind === kind)
    .reduce((sum, row) => sum + number(row, "samples"), 0);
  const failures: string[] = [];
  const timeouts = Math.max(number(global, "rpc_timeouts"), incident("net_rpc"));
  if (timeouts > 0) failures.push(`${timeouts} RPC timeout(s)`);
  if (incident("net_turn_queue_refused") > 0) failures.push(`${incident("net_turn_queue_refused")} queue refusal(s)`);
  if (incident("net_scope_outbox_delivery_failed") > 0) failures.push(`${incident("net_scope_outbox_delivery_failed")} outbox delivery failure(s)`);
  const abandoned = incident("net_scope_outbox_abandoned") + report.incidents.reduce((sum, row) => sum + number(row, "abandoned"), 0);
  if (abandoned > 0) failures.push("outbox abandonment observed");
  if (incident("net_fanout_gap") > 0) failures.push(`${incident("net_fanout_gap")} fanout gap(s)`);
  for (const kind of ["net_turn_install_degraded", "net_session_open_install_degraded", "net_guest_provision_install_degraded", "net_self_subscribe_failed", "net_adopt_conflict"]) {
    if (incident(kind) > 0) failures.push(`${incident(kind)} ${kind} incident(s)`);
  }
  return failures;
}

/** Pure watch-state evaluator, separated from polling so its fail-closed
 * timing and incident behavior are unit-testable. */
export function evaluateNetAeWatch(
  report: NetAeReport,
  limits: Partial<NetAeLimits>,
  elapsedSeconds: number,
  minSeconds: number,
  maxSeconds: number
): NetAeWatchDecision {
  const immediate = immediateNetAeFailures(report);
  if (immediate.length > 0) return { state: "abort", failures: immediate };
  const failures = evaluateNetAeReport(report, limits);
  if (elapsedSeconds >= minSeconds && failures.length === 0) return { state: "pass", failures: [] };
  if (elapsedSeconds >= maxSeconds) {
    return { state: "abort", failures: failures.length > 0 ? failures : [`healthy evidence did not satisfy minimum bake duration ${minSeconds}s`] };
  }
  return { state: "wait", failures };
}

async function query(account: string, token: string, sql: string): Promise<AeRow[]> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
    body: sql
  });
  if (!response.ok) throw new Error(`Analytics Engine query failed (${response.status}): ${await response.text()}`);
  const body = await response.json() as { data?: unknown };
  if (!Array.isArray(body.data)) throw new Error("Analytics Engine response omitted data[]");
  return body.data as AeRow[];
}

async function queryReport(account: string, token: string, dataset: string, from: number, to: number): Promise<NetAeReport> {
  const [summary, turns, authorities, incidents] = await Promise.all([
    query(account, token, buildTurnSummarySql(dataset, from, to)),
    query(account, token, buildTurnSql(dataset, from, to)),
    query(account, token, buildAuthoritySql(dataset, from, to)),
    query(account, token, buildIncidentSql(dataset, from, to))
  ]);
  return { summary, turns, authorities, incidents };
}

function positiveNumber(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number`);
  return parsed;
}

function numericOption(raw: string | undefined, label: string, minimum: number): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minimum) throw new Error(`${label} must be a finite number >= ${minimum}`);
  return parsed;
}

export function parseNetAeLimits(value: (name: string) => string | undefined): Partial<NetAeLimits> {
  const minTurns = numericOption(value("--min-turns"), "--min-turns", 1);
  const maxErrorRate = numericOption(value("--max-error-rate"), "--max-error-rate", 0);
  const maxWallP99Ms = numericOption(value("--max-wall-p99-ms"), "--max-wall-p99-ms", 1);
  const maxQueueP99Ms = numericOption(value("--max-queue-p99-ms"), "--max-queue-p99-ms", 0);
  const minGatewayShards = numericOption(value("--min-gateway-shards"), "--min-gateway-shards", 1);
  const minElasticGuests = numericOption(value("--min-elastic-guests"), "--min-elastic-guests", 0);
  return {
    ...(minTurns !== undefined ? { minTurns } : {}),
    ...(maxErrorRate !== undefined ? { maxErrorRate } : {}),
    ...(maxWallP99Ms !== undefined ? { maxWallP99Ms } : {}),
    ...(maxQueueP99Ms !== undefined ? { maxQueueP99Ms } : {}),
    ...(minGatewayShards !== undefined ? { minGatewayShards } : {}),
    ...(minElasticGuests !== undefined ? { minElasticGuests } : {})
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };
  const account = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_ANALYTICS_TOKEN;
  if (!account || !token) throw new Error("CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN are required");
  const dataset = value("--dataset") ?? "woo_v1_net_canary";
  const watch = args.includes("--watch");
  const now = Date.now() / 1000;
  const parseTime = (raw: string | undefined, fallback: number): number => {
    if (!raw) return fallback;
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(raw) / 1000;
    if (!Number.isFinite(parsed)) throw new Error(`invalid time: ${raw}`);
    return parsed;
  };
  const fromRaw = value("--from");
  if (watch && fromRaw === undefined) throw new Error("--from is required with --watch so the bake cannot include stale evidence implicitly");
  const from = parseTime(fromRaw, now - 15 * 60);
  if (watch && value("--to") !== undefined) throw new Error("--to cannot be combined with --watch; the watch window grows to the current time");
  const to = parseTime(value("--to"), now);
  const limits = parseNetAeLimits(value);
  if (!watch) {
    const report = await queryReport(account, token, dataset, from, to);
    console.log(JSON.stringify({ dataset, from, to, ...report }, null, 2));
    const failures = evaluateNetAeReport(report, limits);
    for (const failure of failures) console.error(`ABORT-SIGNAL: ${failure}`);
    if (failures.length > 0) process.exitCode = 2;
    return;
  }

  const minSeconds = positiveNumber(value("--min-seconds"), 120, "--min-seconds");
  const maxSeconds = positiveNumber(value("--max-seconds"), 600, "--max-seconds");
  const intervalMs = positiveNumber(value("--interval-ms"), 10_000, "--interval-ms");
  if (maxSeconds < minSeconds) throw new Error("--max-seconds must be >= --min-seconds");
  const started = Date.now();
  for (;;) {
    const pollTo = Date.now() / 1000;
    const report = await queryReport(account, token, dataset, from, pollTo);
    const elapsed = (Date.now() - started) / 1000;
    const decision = evaluateNetAeWatch(report, limits, elapsed, minSeconds, maxSeconds);
    const samples = number(report.summary[0] ?? {}, "samples");
    console.error(`AE-WATCH: state=${decision.state} elapsed=${Math.floor(elapsed)}s samples=${samples} pending=${decision.failures.join("; ") || "none"}`);
    if (decision.state !== "wait") {
      console.log(JSON.stringify({ dataset, from, to: pollTo, elapsed_seconds: elapsed, ...report }, null, 2));
      for (const failure of decision.failures) console.error(`ABORT-SIGNAL: ${failure}`);
      if (decision.state === "abort") process.exitCode = 2;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

if (process.argv[1]?.endsWith("net-metrics-ae.ts")) {
  void main().catch((err) => {
    console.error(String(err));
    process.exitCode = 1;
  });
}
