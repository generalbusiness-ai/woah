import { describe, expect, it, vi } from "vitest";
import {
  gatewaySqlFamily,
  instrumentGatewaySql,
  type GatewayStorageWriteMetric
} from "../../src/worker/net/gateway-storage";

describe("gateway physical storage accounting", () => {
  it("classifies table writes without exposing SQL bind values", () => {
    expect(gatewaySqlFamily("INSERT INTO net_gateway_cell (key) VALUES (?)")).toBe("cell");
    expect(gatewaySqlFamily("UPDATE net_gateway_scope SET seen_seq = ?")).toBe("scope");
    expect(gatewaySqlFamily("DELETE FROM net_gateway_relation WHERE key = ?")).toBe("relation");
    expect(gatewaySqlFamily(
      "CREATE INDEX IF NOT EXISTS net_gateway_relation_member ON net_gateway_relation (relation, member)"
    )).toBe("relation");
  });

  it("uses cursor rowsWritten, coalesces a synchronous burst, and omits zero-row attempts", async () => {
    const cursors = [
      { rowsWritten: 9, toArray: () => [] },
      { rowsWritten: 0, toArray: () => [] },
      { rowsWritten: 0, toArray: () => [{ key: "x" }] }
    ];
    const raw = { exec: vi.fn(() => cursors.shift()) };
    const metrics: GatewayStorageWriteMetric[] = [];
    const sql = instrumentGatewaySql(raw, (metric) => metrics.push(metric));

    sql.exec("INSERT INTO net_gateway_relation (key) VALUES (?)", "secret-value");
    sql.exec("UPDATE net_gateway_cell SET body = ? WHERE key = ?", "private-body", "x");
    sql.exec("SELECT key FROM net_gateway_cell WHERE key = ?", "x");
    await Promise.resolve();

    expect(metrics).toEqual([
      { kind: "net_gateway_storage_write", what: "relation", phase: "insert", rows: 9, status: "written" }
    ]);
    expect(JSON.stringify(metrics)).not.toContain("secret-value");
    expect(JSON.stringify(metrics)).not.toContain("private-body");
  });
});
