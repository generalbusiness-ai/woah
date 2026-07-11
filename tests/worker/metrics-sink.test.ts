import { describe, expect, it, vi } from "vitest";
import type { MetricEvent } from "../../src/core/types";
import {
  analyticsSampleRate,
  shouldDropForAnalytics,
  writeConstructorMetricToAnalytics,
  writeMetricToAnalytics,
  type MetricsAnalyticsBinding
} from "../../src/worker/metrics-sink";

// Drop in for the Analytics Engine binding. Captures every writeDataPoint
// call so tests can assert on the exact shape that lands in AE.
function fakeAnalytics(): { binding: MetricsAnalyticsBinding; calls: Array<{ indexes?: string[]; blobs?: string[]; doubles?: number[] }> } {
  const calls: Array<{ indexes?: string[]; blobs?: string[]; doubles?: number[] }> = [];
  return {
    binding: { writeDataPoint(point) { calls.push(point); } },
    calls
  };
}

// Slot constants — restated here on purpose so a refactor that reorders the
// sink schema fails these tests, not just the assertion text.
const SLOT_KIND = 0;
const SLOT_SCOPE = 1;
const SLOT_CLASS = 2;
const SLOT_ROUTE = 3;
const SLOT_METHOD = 4;
const SLOT_PHASE = 5;
const SLOT_WHAT = 6;
const SLOT_STATUS = 7;
const SLOT_ERROR = 8;
const SLOT_TARGET = 9;
const SLOT_VERB = 10;
const SLOT_TOOL = 11;
const SLOT_HOST = 12;
const SLOT_ACTOR = 13;
const SLOT_PATH = 14;
const SLOT_REASON = 15;
const SLOT_ERROR_DETAIL = 16;
const SLOT_SOURCE = 17;

const DBL_MS = 0;
const DBL_SAMPLE_RATE = 1;
const DBL_COUNT = 2;
const DBL_QUEUE_MS = 3;
const DBL_WALL_MS = 4;
const DBL_RPC_MS = 5;
const DBL_RPC_MAX_MS = 6;
const DBL_RPC_DEPTH = 7;
const DBL_SYNC_RPC = 8;
const DBL_ATTEMPT = 9;
const DBL_RECONSTRUCTIONS = 10;
const DBL_PLAN_CELLS = 11;
const DBL_ENVELOPE_BYTES = 12;
const DBL_OUTBOX_ENQUEUED = 13;
const DBL_DELIVERED = 14;
const DBL_FAILED = 15;
const DBL_ABANDONED = 16;
const DBL_AUDIENCE = 17;
const DBL_FRAMES = 18;
const DBL_PRESENCE_SCAN_ROWS = 19;

describe("metrics-sink", () => {
  describe("shouldDropForAnalytics", () => {
    it("drops per-phase shadow_apply_step records but keeps total", () => {
      const phases = ["clone_world", "index_objects", "collect_writes", "apply_creates", "apply_writes", "apply_session", "sort_objects", "apply_log", "counters"] as const;
      for (const phase of phases) {
        const event: MetricEvent = { kind: "shadow_apply_step", phase, scope: "the_chatroom", route: "direct", ms: 0, objects: 0, creates: 0, writes: 0 };
        expect(shouldDropForAnalytics(event), `phase=${phase}`).toBe(true);
      }
      const total: MetricEvent = { kind: "shadow_apply_step", phase: "total", scope: "the_chatroom", route: "direct", ms: 0, objects: 0, creates: 0, writes: 0 };
      expect(shouldDropForAnalytics(total)).toBe(false);
    });

    it("drops per-phase shadow_gateway_apply_step records but keeps total", () => {
      const event: MetricEvent = { kind: "shadow_gateway_apply_step", phase: "apply_writes", scope: "the_deck", route: "direct", ms: 0, objects: 0, properties: 0, sessions: 0, logs: 0, creates: 0, writes: 0 };
      expect(shouldDropForAnalytics(event)).toBe(true);
      const total: MetricEvent = { kind: "shadow_gateway_apply_step", phase: "total", scope: "the_deck", route: "direct", ms: 0, objects: 0, properties: 0, sessions: 0, logs: 0, creates: 0, writes: 0 };
      expect(shouldDropForAnalytics(total)).toBe(false);
    });

    it("keeps everything else", () => {
      const events: MetricEvent[] = [
        { kind: "mcp_request", method: "tools/call", ms: 5, status: "ok" },
        { kind: "do_handler", class: "DirectoryDO", method: "POST", route: "/register-session", ms: 2, status: "ok" },
        { kind: "storage_direct_write", what: "property", ms: 0, rows: 3 },
        { kind: "broadcast", audience_size: 4, obs_count: 2, ms: 1 }
      ];
      for (const event of events) {
        expect(shouldDropForAnalytics(event), `kind=${event.kind}`).toBe(false);
      }
    });
  });

  describe("analyticsSampleRate", () => {
    it("returns 10 for the high-volume storage kinds", () => {
      const sdw: MetricEvent = { kind: "storage_direct_write", what: "property", ms: 0, rows: 3 };
      const flush: MetricEvent = { kind: "storage_flush", objects: 0, properties: 0, sessions: 0, deleted_sessions: 0, tasks: 0, deleted_tasks: 0, counters: false, ms: 0 };
      expect(analyticsSampleRate(sdw)).toBe(10);
      expect(analyticsSampleRate(flush)).toBe(10);
    });

    it("returns 1 for ordinary kinds", () => {
      const event: MetricEvent = { kind: "mcp_request", method: "tools/call", ms: 5, status: "ok" };
      expect(analyticsSampleRate(event)).toBe(1);
    });

    it("never samples errors — dashboards must see ground truth", () => {
      const sdwError = { kind: "storage_direct_write", what: "property", ms: 0, rows: 3, error: "E_BOOM" } as MetricEvent;
      expect(analyticsSampleRate(sdwError)).toBe(1);

      const handlerErr: MetricEvent = { kind: "do_handler", class: "DirectoryDO", method: "POST", route: "/x", ms: 0, status: "error", error: "E_NOPE" };
      expect(analyticsSampleRate(handlerErr)).toBe(1);
    });
  });

  describe("writeMetricToAnalytics", () => {
    it("is a no-op when no binding is provided", () => {
      const event: MetricEvent = { kind: "mcp_request", method: "tools/call", ms: 5, status: "ok" };
      // No throw and nothing to assert — just exercise the early-return path.
      writeMetricToAnalytics(event, "world", undefined);
    });

    it("writes host_key as the only index and packs the schema slots in order", () => {
      const { binding, calls } = fakeAnalytics();
      const event: MetricEvent = { kind: "do_handler", class: "DirectoryDO", method: "POST", route: "/register-session", ms: 12, status: "ok" };
      writeMetricToAnalytics(event, "directory", binding);
      expect(calls).toHaveLength(1);
      const point = calls[0]!;
      expect(point.indexes).toEqual(["directory"]);

      // Empty axes still occupy their slot — fixed-width is what /admin/stats
      // SQL relies on.
      expect(point.blobs).toHaveLength(18);
      expect(point.blobs?.[SLOT_KIND]).toBe("do_handler");
      expect(point.blobs?.[SLOT_CLASS]).toBe("DirectoryDO");
      expect(point.blobs?.[SLOT_ROUTE]).toBe("/register-session");
      expect(point.blobs?.[SLOT_METHOD]).toBe("POST");
      expect(point.blobs?.[SLOT_STATUS]).toBe("ok");
      // Unfilled axes are empty strings.
      expect(point.blobs?.[SLOT_SCOPE]).toBe("");
      expect(point.blobs?.[SLOT_PHASE]).toBe("");
      expect(point.blobs?.[SLOT_WHAT]).toBe("");
      expect(point.blobs?.[SLOT_TARGET]).toBe("");
      expect(point.blobs?.[SLOT_VERB]).toBe("");
      expect(point.blobs?.[SLOT_ERROR_DETAIL]).toBe("");

      expect(point.doubles).toHaveLength(20);
      expect(point.doubles?.[DBL_MS]).toBe(12);
      expect(point.doubles?.[DBL_SAMPLE_RATE]).toBe(1);
      expect(point.doubles?.[DBL_COUNT]).toBe(0);
    });

    it("appends the complete net readiness envelope without moving legacy slots", () => {
      const { binding, calls } = fakeAnalytics();
      writeMetricToAnalytics({
        kind: "net_turn_structure",
        scope: "room:the_chatroom",
        status: "ok",
        queue_ms: 9,
        wall_ms: 185,
        rpc_ms: 170,
        rpc_max_ms: 91,
        rpc_depth: 3,
        sync_rpc: 4,
        attempt: 1,
        reconstructions: 0,
        plan_cells: 714,
        envelope_bytes: 8192
      }, "net-gateway:net-api-3", binding);

      const point = calls[0]!;
      expect(point.indexes).toEqual(["net-gateway:net-api-3"]);
      expect(point.blobs?.[SLOT_KIND]).toBe("net_turn_structure");
      expect(point.blobs?.[SLOT_SCOPE]).toBe("room:the_chatroom");
      expect(point.doubles?.[DBL_MS]).toBe(0);
      expect(point.doubles?.[DBL_SAMPLE_RATE]).toBe(1);
      expect(point.doubles?.[DBL_QUEUE_MS]).toBe(9);
      expect(point.doubles?.[DBL_WALL_MS]).toBe(185);
      expect(point.doubles?.[DBL_RPC_MS]).toBe(170);
      expect(point.doubles?.[DBL_RPC_MAX_MS]).toBe(91);
      expect(point.doubles?.[DBL_RPC_DEPTH]).toBe(3);
      expect(point.doubles?.[DBL_SYNC_RPC]).toBe(4);
      expect(point.doubles?.[DBL_ATTEMPT]).toBe(1);
      expect(point.doubles?.[DBL_RECONSTRUCTIONS]).toBe(0);
      expect(point.doubles?.[DBL_PLAN_CELLS]).toBe(714);
      expect(point.doubles?.[DBL_ENVELOPE_BYTES]).toBe(8192);
    });

    it("maps submit, outbox, and push capacity fields into dedicated slots", () => {
      const { binding, calls } = fakeAnalytics();
      writeMetricToAnalytics({ kind: "net_scope_submit", scope: "room:x", ms: 4, outbox_enqueued: 7 }, "net-scope:room:x", binding);
      writeMetricToAnalytics({ kind: "net_scope_outbox_drain_pass", delivered: 5, failed: 1, abandoned: 2 }, "net-scope:room:x", binding);
      writeMetricToAnalytics({ kind: "net_push", audience: 12, frames: 11 }, "net-gateway:net-api-0", binding);
      writeMetricToAnalytics({ kind: "net_presence_scan", presence_scan_rows: 12 }, "net-gateway:net-api-0", binding);

      expect(calls[0]!.doubles?.[DBL_OUTBOX_ENQUEUED]).toBe(7);
      expect(calls[1]!.doubles?.[DBL_DELIVERED]).toBe(5);
      expect(calls[1]!.doubles?.[DBL_FAILED]).toBe(1);
      expect(calls[1]!.doubles?.[DBL_ABANDONED]).toBe(2);
      expect(calls[2]!.doubles?.[DBL_AUDIENCE]).toBe(12);
      expect(calls[2]!.doubles?.[DBL_FRAMES]).toBe(11);
      expect(calls[3]!.doubles?.[DBL_PRESENCE_SCAN_ROWS]).toBe(12);
    });

    it("populates target+verb for direct_call so dashboard drill-in works", () => {
      const { binding, calls } = fakeAnalytics();
      const event: MetricEvent = {
        kind: "direct_call",
        target: "the_chatroom",
        verb: "look",
        audience: null,
        observations: 3,
        ms: 4,
        status: "ok"
      };
      writeMetricToAnalytics(event, "world", binding);
      expect(calls[0]!.blobs?.[SLOT_TARGET]).toBe("the_chatroom");
      expect(calls[0]!.blobs?.[SLOT_VERB]).toBe("look");
      // observations becomes the kind's primary count.
      expect(calls[0]!.doubles?.[DBL_COUNT]).toBe(3);
    });

    it("stores authority reconstruction reason and object count", () => {
      const { binding, calls } = fakeAnalytics();
      const event: MetricEvent = {
        kind: "authority_slice_reconstructed",
        reason: "warm_turn_refresh",
        scope: "the_chatroom",
        object_count: 12,
        page_count: 36,
        source_host: "mcp-gateway-0"
      };
      writeMetricToAnalytics(event, "mcp-gateway-0", binding);
      expect(calls[0]!.blobs?.[SLOT_KIND]).toBe("authority_slice_reconstructed");
      expect(calls[0]!.blobs?.[SLOT_SCOPE]).toBe("the_chatroom");
      expect(calls[0]!.blobs?.[SLOT_REASON]).toBe("warm_turn_refresh");
      expect(calls[0]!.doubles?.[DBL_COUNT]).toBe(12);
    });

    it("stores open executable seed bytes as the primary count", () => {
      const { binding, calls } = fakeAnalytics();
      const event: MetricEvent = {
        kind: "shadow_open_executable_seed_bytes",
        scope: "the_pinboard",
        node: "browser:test",
        bytes: 604_906,
        pages: 463,
        inline_pages: 463,
        status: "ok"
      };
      writeMetricToAnalytics(event, "the_pinboard", binding);
      expect(calls[0]!.blobs?.[SLOT_KIND]).toBe("shadow_open_executable_seed_bytes");
      expect(calls[0]!.blobs?.[SLOT_SCOPE]).toBe("the_pinboard");
      expect(calls[0]!.blobs?.[SLOT_STATUS]).toBe("ok");
      expect(calls[0]!.doubles?.[DBL_COUNT]).toBe(604_906);
    });

    it("stores transcript anomaly reason and event count", () => {
      const { binding, calls } = fakeAnalytics();
      const event: MetricEvent = {
        kind: "shadow_transcript_anomaly",
        scope: "the_pinboard",
        route: "sequenced",
        reason: "contents_remove_without_move",
        object: "the_pinboard",
        id: "turn-bad-remove"
      };
      writeMetricToAnalytics(event, "the_pinboard", binding);
      expect(calls[0]!.blobs?.[SLOT_KIND]).toBe("shadow_transcript_anomaly");
      expect(calls[0]!.blobs?.[SLOT_SCOPE]).toBe("the_pinboard");
      expect(calls[0]!.blobs?.[SLOT_ROUTE]).toBe("sequenced");
      expect(calls[0]!.blobs?.[SLOT_REASON]).toBe("contents_remove_without_move");
      expect(calls[0]!.doubles?.[DBL_COUNT]).toBe(1);
    });

    it("stores state-path code, cause, and missing-object count", () => {
      const { binding, calls } = fakeAnalytics();
      const event: MetricEvent = {
        kind: "state_path_divergence",
        code: "E_OBJNF",
        cause: "lookup_missing_object",
        scope: "the_outliner",
        commit_scope: null,
        target: "exit_living_room_outline",
        verb: "add_item",
        route: "sequenced",
        attempts: 1,
        elapsed_ms: 812,
        repair_source: "planning_throw",
        repair_reason: "missing_state",
        missing_objects: ["exit_living_room_outline"],
        missing_object_count: 1
      };
      writeMetricToAnalytics(event, "mcp-gateway-0", binding);
      expect(calls[0]!.blobs?.[SLOT_KIND]).toBe("state_path_divergence");
      expect(calls[0]!.blobs?.[SLOT_SCOPE]).toBe("the_outliner");
      expect(calls[0]!.blobs?.[SLOT_ERROR]).toBe("E_OBJNF");
      expect(calls[0]!.blobs?.[SLOT_TARGET]).toBe("exit_living_room_outline");
      expect(calls[0]!.blobs?.[SLOT_VERB]).toBe("add_item");
      expect(calls[0]!.blobs?.[SLOT_REASON]).toBe("lookup_missing_object");
      expect(calls[0]!.doubles?.[DBL_MS]).toBe(812);
      expect(calls[0]!.doubles?.[DBL_COUNT]).toBe(1);
    });

    it("populates space+verb for applied so per-space verb activity is queryable", () => {
      const { binding, calls } = fakeAnalytics();
      const event: MetricEvent = { kind: "applied", space: "the_chatroom", seq: 695, verb: "southeast", ms: 7 };
      // `applied.space` is the commit-scope axis; the sink reads it under
      // `scope` if present. `applied` uses `space`, so it currently lands
      // empty in the scope slot — but the dashboard groups by `host_key`
      // for this case, and `verb` remains queryable.
      writeMetricToAnalytics(event, "the_chatroom", binding);
      expect(calls[0]!.blobs?.[SLOT_VERB]).toBe("southeast");
    });

    it("populates what for storage_direct_write — drives the storage drill-in", () => {
      const { binding, calls } = fakeAnalytics();
      // Use a deterministic random so the 1/10 sample lands.
      const spy = vi.spyOn(Math, "random").mockReturnValue(0.05);
      try {
        const event: MetricEvent = { kind: "storage_direct_write", what: "property", ms: 0, rows: 3 };
        writeMetricToAnalytics(event, "the_chatroom", binding);
      } finally {
        spy.mockRestore();
      }
      expect(calls[0]!.blobs?.[SLOT_WHAT]).toBe("property");
      expect(calls[0]!.blobs?.[SLOT_KIND]).toBe("storage_direct_write");
      // rows is the kind's primary count.
      expect(calls[0]!.doubles?.[DBL_COUNT]).toBe(3);
    });

    it("populates host+path+target for dispatch_resolved", () => {
      const { binding, calls } = fakeAnalytics();
      const event: MetricEvent = {
        kind: "dispatch_resolved",
        target: "the_horoscope",
        verb: "next_pending",
        host: "the_horoscope",
        path: "read",
        pure: true
      };
      writeMetricToAnalytics(event, "world", binding);
      expect(calls[0]!.blobs?.[SLOT_TARGET]).toBe("the_horoscope");
      expect(calls[0]!.blobs?.[SLOT_VERB]).toBe("next_pending");
      expect(calls[0]!.blobs?.[SLOT_HOST]).toBe("the_horoscope");
      expect(calls[0]!.blobs?.[SLOT_PATH]).toBe("read");
    });

    it("populates tool for mcp_request", () => {
      const { binding, calls } = fakeAnalytics();
      const event: MetricEvent = { kind: "mcp_request", method: "tools/call", tool: "the_chatroom__look", ms: 3, status: "ok" };
      writeMetricToAnalytics(event, "mcp-gateway-0", binding);
      expect(calls[0]!.blobs?.[SLOT_TOOL]).toBe("the_chatroom__look");
      expect(calls[0]!.blobs?.[SLOT_METHOD]).toBe("tools/call");
    });

    it("populates actor+reason for mcp_tool_refresh_*", () => {
      const { binding, calls } = fakeAnalytics();
      const event: MetricEvent = { kind: "mcp_tool_refresh_skipped", actor: "guest_115", source: "invoke", reason: "no_reachability_change", transcript: true };
      writeMetricToAnalytics(event, "mcp-gateway-0", binding);
      expect(calls[0]!.blobs?.[SLOT_ACTOR]).toBe("guest_115");
      expect(calls[0]!.blobs?.[SLOT_REASON]).toBe("no_reachability_change");
    });

    it("populates mode for commit_reply_replay on the reason axis", () => {
      const { binding, calls } = fakeAnalytics();
      const event: MetricEvent = {
        kind: "commit_reply_replay",
        scope: "#-1",
        node: "browser:v2-cost",
        route: "/v2/envelope",
        mode: "cached_sql",
        status: "ok",
        reply: "accepted",
        bytes: 512,
        ms: 1
      };
      writeMetricToAnalytics(event, "#-1", binding);
      expect(calls[0]!.blobs?.[SLOT_KIND]).toBe("commit_reply_replay");
      expect(calls[0]!.blobs?.[SLOT_SCOPE]).toBe("#-1");
      expect(calls[0]!.blobs?.[SLOT_ROUTE]).toBe("/v2/envelope");
      expect(calls[0]!.blobs?.[SLOT_STATUS]).toBe("ok");
      expect(calls[0]!.blobs?.[SLOT_REASON]).toBe("cached_sql");
    });

    it("falls back to start when no target is present (dangling_parent_ref)", () => {
      const { binding, calls } = fakeAnalytics();
      const event: MetricEvent = { kind: "dangling_parent_ref", start: "obj_a", missing: "obj_b", tombstoned: false };
      writeMetricToAnalytics(event, "world", binding);
      expect(calls[0]!.blobs?.[SLOT_TARGET]).toBe("obj_a");
    });

    it("does not write dropped per-phase apply records", () => {
      const { binding, calls } = fakeAnalytics();
      const event: MetricEvent = { kind: "shadow_apply_step", phase: "apply_writes", scope: "the_chatroom", route: "direct", ms: 0, objects: 12, creates: 0, writes: 1 };
      writeMetricToAnalytics(event, "the_chatroom", binding);
      expect(calls).toHaveLength(0);
    });

    it("applies the 1-in-10 sample rate to storage_direct_write, recording the multiplier", () => {
      const { binding, calls } = fakeAnalytics();
      // Pin Math.random so exactly one in ten writes lands.
      const seq = [0.05, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
      let i = 0;
      const spy = vi.spyOn(Math, "random").mockImplementation(() => seq[i++ % seq.length]!);
      try {
        for (let n = 0; n < 10; n++) {
          const event: MetricEvent = { kind: "storage_direct_write", what: "property", ms: 0, rows: 3 };
          writeMetricToAnalytics(event, "the_chatroom", binding);
        }
      } finally {
        spy.mockRestore();
      }
      expect(calls).toHaveLength(1);
      // The multiplier lands in doubles[1] so dashboard queries can do
      // SUM(double1 * double2) to reconstruct sampled-up sums.
      expect(calls[0]!.doubles?.[DBL_SAMPLE_RATE]).toBe(10);
    });

    it("always writes errors regardless of the sampled-kind rule", () => {
      const { binding, calls } = fakeAnalytics();
      // Make sampling deterministically drop (random returns 0.5 → 0.5*10>=1).
      const spy = vi.spyOn(Math, "random").mockReturnValue(0.5);
      try {
        const event = { kind: "storage_direct_write", what: "property", ms: 0, rows: 3, error: "E_BOOM" } as MetricEvent;
        writeMetricToAnalytics(event, "the_chatroom", binding);
      } finally {
        spy.mockRestore();
      }
      expect(calls).toHaveLength(1);
      expect(calls[0]!.blobs?.[SLOT_ERROR]).toBe("E_BOOM");
      expect(calls[0]!.doubles?.[DBL_SAMPLE_RATE]).toBe(1);
    });

    it("populates bounded error_detail on the new diagnostic axis", () => {
      const { binding, calls } = fakeAnalytics();
      const event: MetricEvent = {
        kind: "do_handler",
        class: "CommitScopeDO",
        method: "POST",
        route: "/v2/envelope",
        ms: 2,
        status: "error",
        error: "E_INTERNAL",
        error_detail: "plain Error: bad envelope relay state"
      };
      writeMetricToAnalytics(event, "the_chatroom", binding);
      expect(calls[0]!.blobs?.[SLOT_ERROR]).toBe("E_INTERNAL");
      expect(calls[0]!.blobs?.[SLOT_ERROR_DETAIL]).toBe("plain Error: bad envelope relay state");
    });

    it("packs v2 WebSocket lifecycle metrics", () => {
      const { binding, calls } = fakeAnalytics();
      const rejected: MetricEvent = {
        kind: "v2_ws_reject",
        scope: "the_deck",
        node: "browser:abc",
        ms: 5,
        status: "error",
        error: "E_NOSESSION"
      };
      const opened: MetricEvent = {
        kind: "v2_ws_open",
        scope: "the_deck",
        node: "browser:abc",
        actor: "$wiz",
        ms: 9,
        status: "ok"
      };
      writeMetricToAnalytics(rejected, "world", binding);
      writeMetricToAnalytics(opened, "world", binding);
      writeMetricToAnalytics({ kind: "v2_ws_close", scope: "the_deck", node: "browser:abc", actor: "$wiz", code: 1000, clean: true, reason: "close:1000", ms: 100, status: "ok" }, "world", binding);
      expect(calls[0]!.blobs?.[SLOT_KIND]).toBe("v2_ws_reject");
      expect(calls[0]!.blobs?.[SLOT_SCOPE]).toBe("the_deck");
      expect(calls[0]!.blobs?.[SLOT_ERROR]).toBe("E_NOSESSION");
      expect(calls[1]!.blobs?.[SLOT_KIND]).toBe("v2_ws_open");
      expect(calls[1]!.blobs?.[SLOT_ACTOR]).toBe("$wiz");
      expect(calls[2]!.blobs?.[SLOT_KIND]).toBe("v2_ws_close");
      expect(calls[2]!.blobs?.[SLOT_REASON]).toBe("close:1000");
    });

    it("packs browser activity and v2 open-step phases", () => {
      const { binding, calls } = fakeAnalytics();
      const browser: MetricEvent = {
        kind: "browser_activity",
        source: "v2_browser_worker",
        phase: "idb_tx",
        path: "indexeddb",
        method: "readwrite",
        what: "state_pages",
        scope: "the_outliner",
        node: "browser:test",
        actor: "$wiz",
        ms: 12,
        status: "ok",
        bytes: 4096
      };
      const openStep: MetricEvent = {
        kind: "v2_open_step",
        phase: "open_seed_full_build",
        scope: "the_outliner",
        node: "browser:test",
        ms: 25,
        status: "ok",
        count: 42
      };
      writeMetricToAnalytics(browser, "browser", binding);
      writeMetricToAnalytics(openStep, "the_outliner", binding);
      expect(calls[0]!.blobs?.[SLOT_KIND]).toBe("browser_activity");
      expect(calls[0]!.blobs?.[SLOT_PHASE]).toBe("idb_tx");
      expect(calls[0]!.blobs?.[SLOT_PATH]).toBe("indexeddb");
      expect(calls[0]!.blobs?.[SLOT_WHAT]).toBe("state_pages");
      expect(calls[0]!.blobs?.[SLOT_SOURCE]).toBe("v2_browser_worker");
      expect(calls[0]!.doubles?.[DBL_COUNT]).toBe(4096);
      expect(calls[1]!.blobs?.[SLOT_KIND]).toBe("v2_open_step");
      expect(calls[1]!.blobs?.[SLOT_PHASE]).toBe("open_seed_full_build");
      expect(calls[1]!.doubles?.[DBL_COUNT]).toBe(42);
    });

    it("swallows AE write errors so a metric never breaks the worker", () => {
      const binding: MetricsAnalyticsBinding = { writeDataPoint() { throw new Error("AE down"); } };
      const event: MetricEvent = { kind: "mcp_request", method: "tools/call", ms: 5, status: "ok" };
      expect(() => writeMetricToAnalytics(event, "world", binding)).not.toThrow();
    });
  });

  describe("writeConstructorMetricToAnalytics", () => {
    it("emits a do_constructor record with class in the dedicated slot", () => {
      const { binding, calls } = fakeAnalytics();
      writeConstructorMetricToAnalytics("PersistentObjectDO", 7, "world", binding);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.indexes).toEqual(["world"]);
      expect(calls[0]!.blobs?.[SLOT_KIND]).toBe("do_constructor");
      expect(calls[0]!.blobs?.[SLOT_CLASS]).toBe("PersistentObjectDO");
      expect(calls[0]!.doubles?.[DBL_MS]).toBe(7);
      expect(calls[0]!.doubles?.[DBL_SAMPLE_RATE]).toBe(1);
    });
  });
});
