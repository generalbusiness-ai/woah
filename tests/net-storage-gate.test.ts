import { describe, expect, it, vi } from "vitest";
import {
  evaluateDurableObjectStorage,
  queryWorkerDurableObjectStorage,
  workerDurableObjectNamespaces,
  type DurableObjectStorageReport
} from "../scripts/cloudflare-do-storage";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("Durable Object storage billing gate", () => {
  it("resolves current namespace ids by worker instead of trusting stale configuration", async () => {
    const fetchImpl = vi.fn(async () => json({
      success: true,
      result_info: { page: 1, total_pages: 1 },
      result: [
        { id: "gw", name: "canary/NetGatewayDO", class: "NetGatewayDO", script: "canary" },
        { id: "scope", name: "canary/NetScopeDO", class: "NetScopeDO", script: "canary" },
        { id: "audit", name: "canary/NetAuditDO", class: "NetAuditDO", script: "canary" },
        { id: "prod", name: "woah/NetGatewayDO", class: "NetGatewayDO", script: "woah" }
      ]
    })) as unknown as typeof fetch;
    const rows = await workerDurableObjectNamespaces({ accountId: "a", token: "t", worker: "canary", fetchImpl });
    expect(rows.map((row) => row.id)).toEqual(["audit", "gw", "scope"]);
  });

  it("aggregates rows and requests by namespace/object for a bounded window", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/namespaces")) {
        return json({
          success: true,
          result: [
            { id: "gw", name: "canary/NetGatewayDO", class: "NetGatewayDO", script: "canary" },
            { id: "scope", name: "canary/NetScopeDO", class: "NetScopeDO", script: "canary" },
            { id: "audit", name: "canary/NetAuditDO", class: "NetAuditDO", script: "canary" }
          ],
          result_info: { page: 1, total_pages: 1 }
        });
      }
      const request = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { namespaceId?: string };
      };
      const namespaceId = request.variables?.namespaceId;
      return json({
        data: { viewer: { accounts: [{
          durableObjectsPeriodicGroups: namespaceId === "gw"
            ? [
              { dimensions: { objectId: "g1", name: "net-api-0", namespaceId }, sum: { rowsWritten: 9 } },
              { dimensions: { objectId: "g1", name: "net-api-0", namespaceId }, sum: { rowsWritten: 3 } }
            ]
            : namespaceId === "scope"
              ? [{ dimensions: { objectId: "s1", name: "room:x", namespaceId }, sum: { rowsWritten: 4 } }]
              : [],
          durableObjectsInvocationsAdaptiveGroups: namespaceId === "gw"
            ? [{ dimensions: { objectId: "g1", namespaceId }, sum: { requests: 5 } }]
            : namespaceId === "scope"
              ? [{ dimensions: { objectId: "s1", namespaceId }, sum: { requests: 2 } }]
              : []
        }] } }
      });
    }) as unknown as typeof fetch;

    const report = await queryWorkerDurableObjectStorage({
      accountId: "a",
      token: "t",
      worker: "canary",
      from: "2026-08-02T00:00:00Z",
      to: "2026-08-02T01:00:00Z",
      fetchImpl
    });
    expect(report.totalRowsWritten).toBe(16);
    expect(report.totalRequests).toBe(7);
    expect(report.objects.map(({ name, rowsWritten, requests, periodicSamples }) => ({
      name,
      rowsWritten,
      requests,
      periodicSamples
    }))).toEqual([
      { name: "net-api-0", rowsWritten: 12, requests: 5, periodicSamples: 2 },
      { name: "room:x", rowsWritten: 4, requests: 2, periodicSamples: 1 }
    ]);
  });

  it("fails on total and per-object budgets and fails closed without invocation evidence", () => {
    const report: DurableObjectStorageReport = {
      worker: "canary",
      from: "a",
      to: "b",
      namespaces: [],
      totalRowsWritten: 120,
      totalRequests: 10,
      objects: [{
        namespaceId: "gw",
        namespace: "canary/NetGatewayDO",
        className: "NetGatewayDO",
        objectId: "g1",
        name: "net-api-0",
        rowsWritten: 90,
        requests: 10,
        periodicSamples: 1
      }]
    };
    expect(evaluateDurableObjectStorage(report, { maxRowsWritten: 100, maxRowsWrittenPerObject: 80 })).toEqual({
      state: "violation",
      failures: [
        "worker rows written 120 > 100",
        "canary/NetGatewayDO/net-api-0 rows written 90 > 80"
      ]
    });
    expect(evaluateDurableObjectStorage({ ...report, totalRequests: 0 }, {
      maxRowsWritten: 1000,
      maxRowsWrittenPerObject: 1000
    }).state).toBe("incomplete");
    expect(evaluateDurableObjectStorage({
      ...report,
      objects: [{ ...report.objects[0], periodicSamples: 0 }]
    }, {
      maxRowsWritten: 1000,
      maxRowsWrittenPerObject: 1000
    })).toEqual({
      state: "incomplete",
      failures: ["canary/NetGatewayDO/net-api-0 had invocations but no periodic storage sample"]
    });
  });
});
