// Workers Analytics Engine emission for `woo.metric` events.
//
// Every DO already calls `console.log("woo.metric", ...)` on every event;
// this module adds a second sink that writes the same events to Analytics
// Engine so the /admin/stats panel can query historical counts and
// percentiles without depending on a tail-time consumer.
//
// Design choices (see notes/2026-05-17-admin-stats.md and
// spec/reference/cloudflare.md §R10.1):
//
//   - `host_key` is the single AE index. AE samples adaptively per
//     index value, so a noisy host (e.g. `mcp-gateway-0`) burns its own
//     sampling budget without polluting quieter hosts' fidelity. This
//     also matches the dashboard's primary pivot: "by component".
//
//   - We drop per-phase `shadow_apply_step` and
//     `shadow_gateway_apply_step` writes — the `total` phase carries
//     the same information for a dashboard and the per-phase records
//     are a 10x amplification of every envelope. Console-tail still
//     gets them for ad-hoc debugging.
//
//   - We sub-sample `storage_direct_write` and `storage_flush` 1-in-10
//     and store the multiplier as `doubles[1]` so dashboard queries can
//     reconstruct totals: `SUM(double1)` instead of `count()`.
//
//   - Any event with `status === "error"` or a non-empty `error` field
//     bypasses sampling entirely. The dashboard's error pane must
//     reflect ground truth even during a burst.
//
//   - Write failures are swallowed. A metric write must never throw
//     into the request path.

import type { MetricEvent } from "../core/types";

// Structural type for the Workers Analytics Engine binding we use. Declared
// locally (rather than referencing the global `AnalyticsEngineDataset` from
// `@cloudflare/workers-types`) so this file and its consumers can be type-checked
// under the default tsconfig that excludes the Worker-only types but is pulled
// in by test files importing through `src/worker/internal-auth`.
export interface MetricsAnalyticsBinding {
  writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}

// Whether to drop this event before writing to AE. Console-tail is
// unaffected; the per-phase apply steps are still visible there.
export function shouldDropForAnalytics(event: MetricEvent): boolean {
  if (event.kind === "shadow_apply_step" && event.phase !== "total") return true;
  if (event.kind === "shadow_gateway_apply_step" && event.phase !== "total") return true;
  return false;
}

// Inverse sample rate ("1-in-N") for AE writes. Errors are always 1.
// The multiplier is also stored on the data point so dashboard queries
// can multiply back up at query time.
export function analyticsSampleRate(event: MetricEvent): number {
  const e = event as { status?: string; error?: unknown };
  if (e.status === "error" || (typeof e.error === "string" && e.error.length > 0)) return 1;
  if (event.kind === "storage_direct_write") return 10;
  if (event.kind === "storage_flush") return 10;
  return 1;
}

// AE slot positions for `MetricEvent` are stable — every dashboard query
// hard-codes them. New axes get a NEW slot; the existing slot indices
// must not be reordered or repurposed. See spec/reference/cloudflare.md
// §R10.1 for the canonical schema and the per-`kind` field mapping.
const BLOB_SLOTS = 18;
const DOUBLE_SLOTS = 3;

// Per-kind "primary count" extraction. The double goes into doubles[2] so
// dashboard queries can `SUM(double2)` to get totals without knowing which
// kind they're aggregating over. Kinds that carry no natural primary count
// (do_constructor, init, etc.) leave it at 0. Diagnostic anomaly kinds use
// one event as the count so dashboards can sum incidents directly.
function primaryCount(event: MetricEvent): number {
  const e = event as Record<string, unknown>;
  switch (event.kind) {
    case "storage_direct_write":
    case "storage_flush":
    case "storage_full_save":
      return typeof e.rows === "number" ? e.rows : 0;
    case "broadcast":
      return typeof e.audience_size === "number" ? e.audience_size : 0;
    case "direct_call":
      return typeof e.observations === "number" ? e.observations : 0;
    case "mcp_fanout":
      return typeof e.observations === "number" ? e.observations : 0;
    case "directory_sessions_for_scopes":
      return typeof e.sessions === "number" ? e.sessions : 0;
    case "v2_envelope":
      return typeof e.fanout === "number" ? e.fanout : 0;
    case "v2_host_apply_fanout":
      return typeof e.hosts === "number" ? e.hosts : 0;
    case "gateway_tool_surface_source_rows":
      return typeof e.rows === "number" ? e.rows : 0;
    case "authority_slice_reconstructed":
      return typeof e.object_count === "number" ? e.object_count : 0;
    case "authority_slice_content_expansion":
      return typeof e.objects === "number" ? e.objects : 0;
    case "shadow_open_executable_seed_bytes":
      return typeof e.bytes === "number" ? e.bytes : 0;
    case "v2_open_step":
    case "browser_activity":
      return typeof e.bytes === "number" ? e.bytes
        : typeof e.count === "number" ? e.count
          : typeof e.records === "number" ? e.records
            : 0;
    case "shadow_transcript_anomaly":
      return 1;
    case "startup_storage":
      return typeof e.objects === "number" ? e.objects : (typeof e.routes === "number" ? e.routes : 0);
    case "kv_catalog_reservoir_build":
      return typeof e.verbs === "number" ? e.verbs : 0;
    case "shadow_apply_step":
    case "shadow_gateway_apply_step":
      return typeof e.objects === "number" ? e.objects : 0;
    default:
      return 0;
  }
}

// Best-effort AE write. Callers should still log to console; AE is a
// statistics-only sink.
//
// Slot map (the /admin/stats query layer hard-codes these positions; see
// spec/reference/cloudflare.md §R10.1):
//
//   indexes[0]  = host_key       (DO identity / logical component; the only
//                                 high-cardinality AE-indexed field)
//   blobs[0]    = kind
//   blobs[1]    = scope          commit-scope / space (`direct_call.audience`-style
//                                fields fall under `target`/`actor` instead).
//   blobs[2]    = class          DO class (PersistentObjectDO|DirectoryDO|CommitScopeDO)
//   blobs[3]    = route          do_handler.route, cross_host_rpc.route
//   blobs[4]    = method         do_handler.method, mcp_request.method
//   blobs[5]    = phase          shadow_*_step.phase, startup_storage.phase, init.phase,
//                                v2_open_step.phase, browser_activity.phase
//   blobs[6]    = what           storage_direct_write.what, browser cache/IDB store
//   blobs[7]    = status         "ok" | "error" | "timeout"
//   blobs[8]    = error          error code (E_*, or wooError().code)
//   blobs[9]    = target         direct_call.target, dispatch_resolved.target,
//                                dangling_parent_ref.start (in-world object)
//   blobs[10]   = verb           applied.verb, direct_call.verb,
//                                dispatch_resolved.verb
//   blobs[11]   = tool           mcp_request.tool
//   blobs[12]   = host           cross_host_rpc.host, dispatch_resolved.host,
//                                host_schema_sync.host
//   blobs[13]   = actor          mcp_tool_refresh_*.actor, dispatch_resolved.actor
//   blobs[14]   = path           dispatch_resolved.path: "local"|"read"|"mutating",
//                                browser frame/activity path
//   blobs[15]   = reason/mode    mcp_tool_refresh_*.reason, shadow_commit_rejected.reason,
//                                rest_v2_in_process_fallback.reason,
//                                commit_reply_replay.mode,
//                                shadow_transcript_anomaly.reason,
//                                browser fallback/cache reason
//   blobs[16]   = error_detail   bounded diagnostic detail for uncoded errors
//   blobs[17]   = source         browser_activity.source ("main"|"v2_browser_worker")
//   doubles[0]  = ms             latency (when present)
//   doubles[1]  = sample_rate    1 (default) or the 1-in-N multiplier
//   doubles[2]  = count          primary kind-specific count: rows |
//                                audience_size | observations | fanout |
//                                hosts | objects | bytes | anomaly events
//                                (see primaryCount above)
export function writeMetricToAnalytics(
  event: MetricEvent,
  hostKey: string,
  analytics: MetricsAnalyticsBinding | undefined
): void {
  if (!analytics) return;
  if (shouldDropForAnalytics(event)) return;

  const rate = analyticsSampleRate(event);
  if (rate > 1 && Math.random() * rate >= 1) return;

  const e = event as Record<string, unknown>;
  const ms = typeof e.ms === "number" ? e.ms : 0;

  // Fixed-length arrays so AE columns stay aligned even when an event
  // doesn't carry a given axis. Empty strings are how AE expresses "n/a"
  // in a stable slot.
  const blobs = new Array<string>(BLOB_SLOTS).fill("");
  const doubles = new Array<number>(DOUBLE_SLOTS).fill(0);

  blobs[0] = String(event.kind ?? "");
  blobs[1] = stringOrEmpty(e.scope);
  blobs[2] = stringOrEmpty(e.class);
  blobs[3] = stringOrEmpty(e.route);
  blobs[4] = stringOrEmpty(e.method);
  blobs[5] = stringOrEmpty(e.phase);
  blobs[6] = stringOrEmpty(e.what);
  blobs[7] = stringOrEmpty(e.status);
  blobs[8] = stringOrEmpty(e.error);
  // `dangling_parent_ref` reports the orphan's anchor as `start`, not
  // `target`; surface it on the same axis so the dashboard can group
  // "objects touched / missing" without a special-case query.
  blobs[9] = stringOrEmpty(e.target ?? e.start ?? e.missing);
  blobs[10] = stringOrEmpty(e.verb);
  blobs[11] = stringOrEmpty(e.tool);
  blobs[12] = stringOrEmpty(e.host);
  blobs[13] = stringOrEmpty(e.actor);
  blobs[14] = stringOrEmpty(e.path);
  blobs[15] = stringOrEmpty(e.reason ?? e.mode);
  blobs[16] = stringOrEmpty(e.error_detail);
  blobs[17] = stringOrEmpty(e.source);

  doubles[0] = ms;
  doubles[1] = rate;
  doubles[2] = primaryCount(event);

  try {
    analytics.writeDataPoint({ indexes: [hostKey], blobs, doubles });
  } catch {
    // AE writes are best-effort. A failure must never break the worker.
  }
}

// Convenience for callers that don't have a `MetricEvent` value handy
// (the literal-`console.log` constructor paths). Kept narrow so it
// can't drift from `writeMetricToAnalytics`.
export function writeConstructorMetricToAnalytics(
  klass: "PersistentObjectDO" | "DirectoryDO" | "CommitScopeDO",
  ms: number,
  hostKey: string,
  analytics: MetricsAnalyticsBinding | undefined
): void {
  writeMetricToAnalytics({ kind: "do_constructor", class: klass, ms }, hostKey, analytics);
}

function stringOrEmpty(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}
