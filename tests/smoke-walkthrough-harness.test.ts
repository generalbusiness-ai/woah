import { describe, expect, it } from "vitest";

import { isTimeoutDetail, SmokeCascadeHalt, raceWithAbort } from "../scripts/smoke-walkthrough";

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

  it("classifies gateway-saturation timeouts but not real protocol errors", () => {
    // These are the failure messages that should drive the cascade halt: a
    // saturated gateway times out the MCP POST, the per-RPC deadline, or the
    // step watchdog.
    expect(isTimeoutDetail("MCP POST https://woah1.generalbusiness.ai/mcp timed out after 20000ms")).toBe(true);
    expect(isTimeoutDetail("MCP request exceeded 20000ms deadline")).toBe(true);
    expect(isTimeoutDetail('step "enter:chatroom" exceeded 60000ms watchdog')).toBe(true);

    // Real protocol / content failures must NOT count — they are genuine
    // assertion failures, not gateway saturation, and should be reported
    // individually rather than triggering a halt. In particular a waitFor
    // "timeout after Nms waiting for matching observation" is a fanout/delivery
    // gap (the call succeeded; the expected observation never arrived), so it
    // must not be misread as a saturation timeout.
    expect(isTimeoutDetail("timeout after 5000ms waiting for matching observation")).toBe(false);
    expect(isTimeoutDetail('I don\'t see "mug" here.')).toBe(false);
    expect(isTimeoutDetail("reachable MCP tool not found: the_outline:add_item")).toBe(false);
    expect(isTimeoutDetail("MCP session not found; reinitialize")).toBe(false);
    expect(isTimeoutDetail(undefined)).toBe(false);
  });

  it("carries the consecutive-timeout count on the cascade-halt error", () => {
    const halt = new SmokeCascadeHalt(2);
    expect(halt).toBeInstanceOf(Error);
    expect(halt.name).toBe("SmokeCascadeHalt");
    expect(halt.count).toBe(2);
    expect(halt.message).toContain("2 consecutive timeout-class failures");
  });
});
