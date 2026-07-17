/**
 * AU2 trace-context contract (spec/operations/audit.md): strict W3C
 * parse, adopt-or-mint (invalid never rejects), child derivation, and
 * the durable-row normalization guard.
 */
import { describe, expect, it } from "vitest";
import {
  adoptOrMintTraceContext,
  childTraceContext,
  mintTraceContext,
  normalizeTraceContext,
  parseTraceparent
} from "../src/net/trace";

const VALID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("parseTraceparent", () => {
  const rejects: Array<[string, string | null | undefined]> = [
    ["absent", undefined],
    ["null", null],
    ["empty", ""],
    ["garbage", "not-a-traceparent"],
    ["short trace id", "00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01"],
    ["uppercase hex", "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01"],
    ["all-zero trace id", "00-00000000000000000000000000000000-00f067aa0ba902b7-01"],
    ["all-zero span id", "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01"],
    ["reserved version ff", "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"],
    ["version 00 with trailing field", `${VALID}-extra`]
  ];
  for (const [label, header] of rejects) {
    it(`rejects ${label}`, () => {
      expect(parseTraceparent(header)).toBeNull();
    });
  }

  it("parses a valid header", () => {
    expect(parseTraceparent(VALID)).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      flags: "01"
    });
  });

  it("accepts a future version with trailing fields (W3C forward-compat)", () => {
    const future = `cc-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-what-ever`;
    expect(parseTraceparent(future)?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });
});

describe("adoptOrMintTraceContext (the AU2 adopt/mint matrix)", () => {
  it("adopts a valid inbound header verbatim, carrying tracestate opaque", () => {
    const ctx = adoptOrMintTraceContext(VALID, "vendor=opaque,other=x");
    expect(ctx).toEqual({ traceparent: VALID, tracestate: "vendor=opaque,other=x", origin: "adopted" });
  });

  it("mints on absent header", () => {
    const ctx = adoptOrMintTraceContext(undefined);
    expect(ctx.origin).toBe("minted");
    expect(parseTraceparent(ctx.traceparent)).not.toBeNull();
  });

  it("mints on malformed header (never rejects)", () => {
    const ctx = adoptOrMintTraceContext("00-bad-bad-01", "vendor=x");
    expect(ctx.origin).toBe("minted");
    // tracestate is meaningless without a valid traceparent: dropped.
    expect(ctx.tracestate).toBeUndefined();
  });

  it("drops oversize tracestate rather than truncating", () => {
    const ctx = adoptOrMintTraceContext(VALID, "v=" + "x".repeat(600));
    expect(ctx.origin).toBe("adopted");
    expect(ctx.tracestate).toBeUndefined();
  });

  it("mints distinct contexts per call", () => {
    expect(mintTraceContext().traceparent).not.toBe(mintTraceContext().traceparent);
  });
});

describe("childTraceContext", () => {
  it("keeps trace id, flags, tracestate; changes span id", () => {
    const parent = adoptOrMintTraceContext(VALID, "vendor=x");
    const child = childTraceContext(parent);
    const p = parseTraceparent(parent.traceparent)!;
    const c = parseTraceparent(child.traceparent)!;
    expect(c.traceId).toBe(p.traceId);
    expect(c.flags).toBe(p.flags);
    expect(c.spanId).not.toBe(p.spanId);
    expect(child.tracestate).toBe("vendor=x");
    expect(child.origin).toBe("adopted");
  });
});

describe("normalizeTraceContext (durable-row guard)", () => {
  it("round-trips a valid context", () => {
    const ctx = adoptOrMintTraceContext(VALID, "vendor=x");
    expect(normalizeTraceContext(JSON.parse(JSON.stringify(ctx)))).toEqual(ctx);
  });

  const bad: Array<[string, unknown]> = [
    ["null", null],
    ["array", [VALID]],
    ["missing origin", { traceparent: VALID }],
    ["bad origin", { traceparent: VALID, origin: "copied" }],
    ["malformed traceparent", { traceparent: "nope", origin: "adopted" }]
  ];
  for (const [label, value] of bad) {
    it(`returns null for ${label}`, () => {
      expect(normalizeTraceContext(value)).toBeNull();
    });
  }
});

describe("future-version suffix discipline (review fix P2c)", () => {
  const base = "cc-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  it("rejects a bare suffix glued to the flags", () => {
    expect(parseTraceparent(`${base}evil`)).toBeNull();
    expect(parseTraceparent(`${base}_`)).toBeNull();
  });
  it("accepts exactly-55 future version and dash-delimited extra fields", () => {
    expect(parseTraceparent(base)).not.toBeNull();
    expect(parseTraceparent(`${base}-extra-fields`)).not.toBeNull();
  });
  it("adoptOrMint mints (never adopts) a glued-suffix header", () => {
    expect(adoptOrMintTraceContext(`${base}evil`).origin).toBe("minted");
  });
});
