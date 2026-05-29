import { describe, expect, it } from "vitest";

import { raceWithAbort } from "../scripts/smoke-walkthrough";

describe("smoke walkthrough harness", () => {
  it("aborts the in-flight step body when the watchdog fires", async () => {
    let observedAbort = false;
    const startedAt = Date.now();

    await expect(raceWithAbort(async (signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          observedAbort = true;
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        }, { once: true });
      });
    }, 10, "step deadline")).rejects.toThrow("step deadline");

    expect(observedAbort).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it("does not abort work that finishes before the watchdog", async () => {
    let observedAbort = false;

    const result = await raceWithAbort(async (signal) => {
      signal.addEventListener("abort", () => {
        observedAbort = true;
      }, { once: true });
      return 42;
    }, 1000, "step deadline");

    expect(result).toBe(42);
    expect(observedAbort).toBe(false);
  });
});
