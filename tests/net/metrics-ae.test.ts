import { describe, expect, it } from "vitest";
import {
  buildAuthoritySql,
  buildIncidentSql,
  buildTurnSql,
  evaluateNetAeReport,
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
    expect(buildAuthoritySql("woo_v1_canary", 100, 200)).toContain("double14");
    expect(buildIncidentSql("woo_v1_canary", 100, 200)).toContain("net_guest_provisioned");
  });

  it("rejects dataset injection and invalid windows", () => {
    expect(() => buildTurnSql("x; DROP TABLE y", 100, 200)).toThrow("invalid Analytics Engine dataset");
    expect(() => buildTurnSql("woo_v1_canary", 200, 100)).toThrow("from < to");
  });

  it("accepts a distributed, error-free envelope with elastic admission", () => {
    const report: NetAeReport = {
      turns: [
        { host_key: "net-gateway:net-api-0", samples: 300, errors: 0, rpc_timeouts: 0, queue_p99: 120 },
        { host_key: "net-gateway:net-api-1", samples: 300, errors: 0, rpc_timeouts: 0, queue_p99: 180 }
      ],
      authorities: [],
      incidents: [{ kind: "net_guest_provisioned", samples: 4 }]
    };
    expect(evaluateNetAeReport(report)).toEqual([]);
  });

  it("fails closed on insufficient, concentrated, or divergent evidence", () => {
    const report: NetAeReport = {
      turns: [{ host_key: "net-gateway:net-api-0", samples: 20, errors: 4, rpc_timeouts: 2, queue_p99: 1400 }],
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
    expect(failures.join("\n")).toContain("queue p99");
    expect(failures.join("\n")).toContain("only 1 gateway shard");
    expect(failures.join("\n")).toContain("outbox delivery failure");
    expect(failures.join("\n")).toContain("outbox abandonment");
    expect(failures.join("\n")).toContain("fanout gap");
  });
});
