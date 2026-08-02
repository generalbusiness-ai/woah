import { describe, expect, it } from "vitest";
import { assertDisposableCanaryName, canaryCleanupConfig } from "../scripts/net-canary-cleanup";

describe("Net canary cleanup safety", () => {
  it("refuses production and names outside the canary namespace", () => {
    for (const name of ["woah", "woah-production", "preview", "canary", "WOAH-CANARY", "productioncanary", "canaryproduction"]) {
      expect(() => assertDisposableCanaryName(name), name).toThrow();
    }
    expect(() => assertDisposableCanaryName("woah-net-canary")).not.toThrow();
    expect(() => assertDisposableCanaryName("woah-net-canary-acts")).not.toThrow();
  });

  it("preserves creation history and appends deletion for every SQLite class", () => {
    const generated = canaryCleanupConfig({
      worker: "woah-net-canary-test",
      accountId: "a".repeat(32),
      templateText: [
        'name = "woah-net-canary"',
        "[[migrations]]",
        'tag = "v1"',
        'new_sqlite_classes = ["NetGatewayDO", "NetScopeDO"]',
        "[[migrations]]",
        'tag = "v2"',
        'new_sqlite_classes = ["NetAuditDO"]',
        "[[migrations]]",
        'tag = "v3"',
        'new_classes = ["LegacyCanaryDO"]'
      ].join("\n")
    });
    expect(generated.deletedClasses).toEqual(["LegacyCanaryDO", "NetAuditDO", "NetGatewayDO", "NetScopeDO"]);
    expect(generated.text).toContain('tag = "v1"');
    expect(generated.text).toContain('tag = "canary-storage-cleanup-v1"');
    expect(generated.text).toContain(
      'deleted_classes = ["LegacyCanaryDO","NetAuditDO","NetGatewayDO","NetScopeDO"]'
    );
    expect(generated.text).not.toContain("[[durable_objects.bindings]]");
  });
});
