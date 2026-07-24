import { describe, expect, it } from "vitest";
import {
  buildAuthoritySql,
  buildIncidentSql,
  buildTurnSql,
  buildTurnSummarySql,
  evaluateNetAeReport,
  evaluateNetAeWatch,
  immediateNetAeFailures,
  parseNetAeLimits,
  type NetAeReport
} from "../../scripts/net-metrics-ae";

describe("net Analytics Engine canary report", () => {
  it("queries the additive net slots with adaptive-sampling weights", () => {
    const turn = buildTurnSql("woo_v1_canary", 100, 200);
    expect(turn).toContain("_sample_interval * double2");
    expect(turn).toContain("double5"); // wall_ms
    expect(turn).toContain("double4"); // queue_ms
    expect(turn).toContain("blob9 = 'E_RPC_TIMEOUT'");
    expect(turn).toContain("blob1 = 'net_turn_structure'");
    expect(buildTurnSummarySql("woo_v1_canary", 100, 200)).not.toContain("GROUP BY host_key");
    expect(buildAuthoritySql("woo_v1_canary", 100, 200)).toContain("double14");
    const incident = buildIncidentSql("woo_v1_canary", 100, 200);
    expect(incident).toContain("net_guest_provisioned");
    expect(incident).toContain("GROUP BY kind, scope, error");
  });

  it("rejects dataset injection and invalid windows", () => {
    expect(() => buildTurnSql("x; DROP TABLE y", 100, 200)).toThrow("invalid Analytics Engine dataset");
    expect(() => buildTurnSql("woo_v1_canary", 200, 100)).toThrow("from < to");
  });

  it("rejects malformed or out-of-range acceptance thresholds", () => {
    expect(() => parseNetAeLimits((name) => name === "--min-turns" ? "NaN" : undefined)).toThrow("--min-turns");
    expect(() => parseNetAeLimits((name) => name === "--min-gateway-shards" ? "0" : undefined)).toThrow("--min-gateway-shards");
    expect(parseNetAeLimits((name) => name === "--max-error-rate" ? "0" : undefined)).toEqual({ maxErrorRate: 0 });
  });

  it("accepts a distributed, error-free envelope with elastic admission — including an episodic platform tail under the timeout ceiling (2026-07-22 re-scope)", () => {
    const report: NetAeReport = {
      // wall_p99 2800 is an episode-struck tail: accepted, because the
      // 500ms bound applies at p95 and p99 is gated by the RPC-timeout
      // ceiling with zero actual timeouts.
      summary: [{ samples: 600, errors: 0, rpc_timeouts: 0, wall_p95: 320, wall_p99: 2800, queue_p99: 160 }],
      turns: [
        { host_key: "net-gateway:net-api-0", samples: 300, wall_p99: 700 },
        { host_key: "net-gateway:net-api-1", samples: 300, wall_p99: 310 }
      ],
      authorities: [],
      incidents: [{ kind: "net_guest_provisioned", samples: 4 }]
    };
    expect(evaluateNetAeReport(report)).toEqual([]);
  });

  it("fails closed on insufficient, concentrated, or divergent evidence", () => {
    const report: NetAeReport = {
      summary: [{ samples: 20, errors: 4, rpc_timeouts: 2, wall_p95: 900, wall_p99: 6800, queue_p99: 1400 }],
      turns: [{ host_key: "net-gateway:net-api-0", samples: 20 }],
      authorities: [],
      incidents: [
        { kind: "net_turn_queue_refused", samples: 3 },
        { kind: "net_scope_outbox_delivery_failed", samples: 2 },
        { kind: "net_scope_outbox_abandoned", samples: 1, abandoned: 1 },
        { kind: "net_fanout_gap", samples: 1 }
      ]
    };
    const failures = evaluateNetAeReport(report);
    expect(failures.join("\n")).toContain("only 20 turns");
    expect(failures.join("\n")).toContain("turn error rate");
    expect(failures.join("\n")).toContain("RPC timeout");
    expect(failures.join("\n")).toContain("wall p95");
    expect(failures.join("\n")).toContain("wall p99");
    expect(failures.join("\n")).toContain("queue p99");
    expect(failures.join("\n")).toContain("only 1 gateway shard");
    expect(failures.join("\n")).toContain("outbox delivery failure");
    expect(failures.join("\n")).toContain("outbox abandonment");
    expect(failures.join("\n")).toContain("fanout gap");
  });

  it("watches until both duration and evidence are sufficient", () => {
    const report: NetAeReport = {
      summary: [{ samples: 600, errors: 0, rpc_timeouts: 0, wall_p99: 280, queue_p99: 160 }],
      turns: [
        { host_key: "net-gateway:net-api-0", samples: 300 },
        { host_key: "net-gateway:net-api-1", samples: 300 }
      ],
      authorities: [],
      incidents: [{ kind: "net_guest_provisioned", samples: 4 }]
    };
    expect(evaluateNetAeWatch(report, {}, 60, 120, 600).state).toBe("wait");
    expect(evaluateNetAeWatch(report, {}, 120, 120, 600)).toEqual({ state: "pass", failures: [] });
  });

  it("aborts integrity incidents immediately and insufficient evidence at the deadline", () => {
    const incident: NetAeReport = {
      summary: [{ samples: 10, rpc_timeouts: 1 }],
      turns: [],
      authorities: [],
      incidents: []
    };
    expect(immediateNetAeFailures(incident)).toContain("1 RPC timeout(s)");
    expect(evaluateNetAeWatch(incident, {}, 1, 120, 600).state).toBe("abort");

    const insufficient: NetAeReport = { summary: [{ samples: 20 }], turns: [], authorities: [], incidents: [] };
    const deadline = evaluateNetAeWatch(insufficient, {}, 600, 120, 600);
    expect(deadline.state).toBe("abort");
    expect(deadline.failures.join("\n")).toContain("only 20 turns");
  });
});
