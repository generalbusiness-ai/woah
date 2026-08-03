import { describe, expect, it } from "vitest";
import {
  DEFAULT_CANARY_MAX_ROWS_WRITTEN,
  DEFAULT_CANARY_MAX_ROWS_WRITTEN_PER_OBJECT,
  resolveCanaryStorageGateOptions,
  storageWindowEndAfterMetricsSettle
} from "../scripts/net-canary-load";

const credentials = { CF_ACCOUNT_ID: "account", CF_ANALYTICS_TOKEN: "token" };

describe("deployed canary storage gate options", () => {
  it("infers a workers.dev script and applies the bounded defaults", () => {
    const options = resolveCanaryStorageGateOptions([], "https://woah-net-canary.example.workers.dev", credentials);
    expect(options.worker).toBe("woah-net-canary");
    expect(options.maxRowsWritten).toBe(DEFAULT_CANARY_MAX_ROWS_WRITTEN);
    expect(options.maxRowsWrittenPerObject).toBe(DEFAULT_CANARY_MAX_ROWS_WRITTEN_PER_OBJECT);
    expect(options.skip).toBe(false);
  });

  it("fails closed for a custom domain without attribution or credentials", () => {
    expect(() => resolveCanaryStorageGateOptions([], "https://canary.example.test", credentials))
      .toThrow("--storage-worker is required");
    expect(() => resolveCanaryStorageGateOptions(
      ["--storage-worker", "woah-net-canary"],
      "https://canary.example.test",
      {}
    )).toThrow("CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN are required");
  });

  it("requires an explicit reason for diagnostic bypass and validates every numeric bound", () => {
    expect(() => resolveCanaryStorageGateOptions(["--skip-storage-gate"], "https://canary.example.test", {}))
      .toThrow("--skip-storage-gate requires");
    expect(resolveCanaryStorageGateOptions(
      ["--skip-storage-gate", "--skip-storage-gate-reason", "local parser check"],
      "https://canary.example.test",
      {}
    )).toMatchObject({ skip: true, skipReason: "local parser check" });
    expect(() => resolveCanaryStorageGateOptions(
      ["--storage-metrics-delay-ms", "NaN"],
      "https://woah-net-canary.example.workers.dev",
      credentials
    )).toThrow("non-negative integers");
  });

  it("captures the billing window end after the metrics-settle delay", async () => {
    const order: string[] = [];
    const end = await storageWindowEndAfterMetricsSettle(
      120_000,
      async (delayMs) => { order.push(`wait:${delayMs}`); },
      () => {
        order.push("now");
        return new Date("2026-08-02T20:02:00.000Z");
      }
    );
    expect(order).toEqual(["wait:120000", "now"]);
    expect(end).toBe("2026-08-02T20:02:00.000Z");
  });
});
