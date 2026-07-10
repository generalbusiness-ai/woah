// Reviewer finding 7: the canary tool must parse Cloudflare tail's REAL
// shape — {logs:[{message:["woo.metric","{…}"]}]} — and never report
// green on zero data. The extractor is exercised against the tail shape
// (message-array args, concatenated single-string args, and an escaped
// re-stringified event), the raw workerd line shape, and garbage.
import { describe, expect, it } from "vitest";
import { buildReport, extractMetrics } from "../scripts/net-metrics-report";

const TURN = { kind: "net_turn_structure", scope: "room:x", attempt: 1, sync_rpc: 3, wall_ms: 40, rpc_ms: 12, ts: 1 };

describe("extractMetrics (finding 7)", () => {
  it("parses the Cloudflare tail event shape: console args as message[] entries", () => {
    const event = JSON.stringify({
      outcome: "ok",
      scriptName: "woo",
      logs: [
        { message: ["woo.metric", JSON.stringify(TURN)], level: "log", timestamp: 1 },
        { message: ["woo.metric", JSON.stringify({ kind: "net_push", scope: "room:x", audience: 4, frames: 4, observations: 1, ts: 2 })], level: "log", timestamp: 2 }
      ],
      eventTimestamp: 3
    });
    const metrics = extractMetrics(event);
    expect(metrics.map((metric) => metric.kind)).toEqual(["net_turn_structure", "net_push"]);
    expect(metrics[0].wall_ms).toBe(40);
  });

  it("parses message entries where the console line arrived as ONE concatenated string", () => {
    const event = JSON.stringify({
      logs: [{ message: [`woo.metric ${JSON.stringify(TURN)}`], level: "log", timestamp: 1 }]
    });
    expect(extractMetrics(event)).toHaveLength(1);
  });

  it("parses a DOUBLY-stringified tail event (the escaped shape that defeated the old scanner)", () => {
    const inner = JSON.stringify({ logs: [{ message: ["woo.metric", JSON.stringify(TURN)] }] });
    // e.g. `wrangler tail` output piped through a logger that re-quotes.
    const outer = JSON.stringify({ raw: inner });
    expect(extractMetrics(outer)).toHaveLength(1);
  });

  it("still parses raw workerd/vitest lines, and skips garbage without throwing", () => {
    const text = [
      `woo.metric ${JSON.stringify(TURN)}`,
      "plain log line",
      "woo.metric {not json",
      `[wrangler:info] GET / 200 — woo.metric ${JSON.stringify({ kind: "net_presence_scan", scope: "room:x", presence_scan_rows: 2, ts: 3 })}`
    ].join("\n");
    const metrics = extractMetrics(text);
    expect(metrics.map((metric) => metric.kind)).toEqual(["net_turn_structure", "net_presence_scan"]);
  });

  it("reports zero on empty/foreign input — the caller fails closed on it", () => {
    expect(extractMetrics("")).toHaveLength(0);
    expect(extractMetrics(JSON.stringify({ logs: [{ message: ["hello"] }] }))).toHaveLength(0);
    const report = buildReport([]);
    expect((report as { turns: { total: number } }).turns.total).toBe(0);
  });
});
