/**
 * Review finding 6: the OTLP exporter is bounded and failure-isolated —
 * timeout via abort, in-flight cap with a counted drop policy, and a
 * failed push never escapes past the defer boundary.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportSpans, otlpExportState, spanSampleRate } from "../../src/worker/net/span-export";
import type { NetSpan } from "../../src/net/spans";

const SPAN: NetSpan = {
  trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
  span_id: "00f067aa0ba902b7",
  name: "net.turn",
  start_ms: 1,
  end_ms: 2,
  status: "ok",
  attributes: {}
};
const RESOURCE = { service: "woo-test", instance: "t-1" };

/** A Host.defer that runs the task and records its settlement — the
 * production defer catches into a metric; here we surface it. */
function harnessDefer() {
  const settled: Array<Promise<{ ok: boolean; error?: string }>> = [];
  return {
    settled,
    defer: (task: () => Promise<void>) => {
      settled.push(task().then(() => ({ ok: true })).catch((err) => ({ ok: false, error: String(err) })));
    }
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("exportSpans OTLP push", () => {
  it("no endpoint → logs only, no fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harnessDefer();
    exportSpans({}, h, [SPAN], RESOURCE);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("woo.span", expect.any(String));
  });

  it("pushes the batch and settles ok on 200", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harnessDefer();
    exportSpans({ WOO_OTLP_ENDPOINT: "https://collector/v1/traces" }, h, [SPAN], RESOURCE);
    expect(await Promise.all(h.settled)).toEqual([{ ok: true }]);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://collector/v1/traces");
    expect((init.signal as AbortSignal).aborted).toBe(false);
    expect(JSON.parse(String(init.body)).resourceSpans).toBeDefined();
  });

  it("a rejected push settles as a caught failure (never escapes the defer boundary)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("no", { status: 503 }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harnessDefer();
    exportSpans({ WOO_OTLP_ENDPOINT: "https://collector/v1/traces" }, h, [SPAN], RESOURCE);
    const [result] = await Promise.all(h.settled);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/otlp push failed: 503/);
  });

  it("a hung collector is aborted at the deadline and the in-flight slot is released", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          (init?.signal as AbortSignal).addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harnessDefer();
    exportSpans({ WOO_OTLP_ENDPOINT: "https://collector/v1/traces" }, h, [SPAN], RESOURCE);
    expect(otlpExportState().inflight).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(6_000);
    const [result] = await Promise.all(h.settled);
    expect(result.ok).toBe(false);
    expect(otlpExportState().inflight).toBe(0);
  });

  it("saturating the in-flight bound drops batches (counted) instead of queueing them", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const releases: Array<() => void> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(() => resolve(new Response("{}", { status: 200 })));
        })
    );
    const h = harnessDefer();
    const droppedBefore = otlpExportState().dropped;
    for (let i = 0; i < 12; i += 1) {
      exportSpans({ WOO_OTLP_ENDPOINT: "https://collector/v1/traces" }, h, [SPAN], RESOURCE);
    }
    expect(otlpExportState().inflight).toBeLessThanOrEqual(8);
    expect(otlpExportState().dropped).toBeGreaterThan(droppedBefore);
    // Drain so later tests start clean.
    for (const release of releases) release();
    await Promise.all(h.settled);
  });
});

describe("spanSampleRate", () => {
  it("parses the 1-in-N env, treating absent/garbage/zero as off", () => {
    expect(spanSampleRate({})).toBe(0);
    expect(spanSampleRate({ NET_SPAN_SAMPLE: "0" })).toBe(0);
    expect(spanSampleRate({ NET_SPAN_SAMPLE: "junk" })).toBe(0);
    expect(spanSampleRate({ NET_SPAN_SAMPLE: "100" })).toBe(100);
  });
});
