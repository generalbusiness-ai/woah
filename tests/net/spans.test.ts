/**
 * AU8 span emission: sampling semantics (adopted flag wins; minted
 * gated deterministically), the turn span tree, and the OTLP/JSON
 * payload mapping (hex ids, nano times, status codes).
 */
import { describe, expect, it } from "vitest";
import { mintSampleDecision, otlpTracePayload, spanSampled, turnSpans, type NetSpan } from "../../src/net/spans";
import { mintTraceContext } from "../../src/net/trace";
import type { TraceContext } from "../../src/net/trace";

const SAMPLED = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const UNSAMPLED = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00";
const adopted = (traceparent: string): TraceContext => ({ traceparent, origin: "adopted" });
const minted = (traceparent: string): TraceContext => ({ traceparent, origin: "minted" });

describe("spanSampled (one decision, encoded in the flags — review finding 2)", () => {
  it("reads the W3C sampled flag uniformly for adopted and minted contexts", () => {
    expect(spanSampled(adopted(SAMPLED))).toBe(true);
    expect(spanSampled(adopted(UNSAMPLED))).toBe(false);
    expect(spanSampled(minted(SAMPLED))).toBe(true);
    expect(spanSampled(minted(UNSAMPLED))).toBe(false);
  });
  it("absent or malformed context never samples", () => {
    expect(spanSampled(undefined)).toBe(false);
    expect(spanSampled({ traceparent: "junk", origin: "minted" })).toBe(false);
  });
  it("mintSampleDecision: off at 0, always at 1", () => {
    expect(mintSampleDecision(0)).toBe(false);
    expect(mintSampleDecision(1)).toBe(true);
  });
  it("mintTraceContext encodes the decision in the flags", () => {
    expect(mintTraceContext(true).traceparent.endsWith("-01")).toBe(true);
    expect(mintTraceContext(false).traceparent.endsWith("-00")).toBe(true);
    expect(mintTraceContext().traceparent.endsWith("-00")).toBe(true); // default: unsampled
  });
});

describe("turnSpans", () => {
  it("root spans queue + wall (review finding 1) and every child is contained in it", () => {
    const spans = turnSpans({
      trace: adopted(SAMPLED),
      now_ms: 10_000,
      wall_ms: 100,
      queue_ms: 20,
      rpc_ms: 30,
      status: "ok",
      attributes: { "woo.customer": "acct_a", "woo.scope": "room:r" }
    });
    expect(spans).toHaveLength(3);
    const [root, queue, rpc] = spans;
    expect(root).toMatchObject({
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      parent_span_id: "00f067aa0ba902b7",
      name: "net.turn",
      start_ms: 9_880, // now - wall - queue: the wall clock starts AFTER the queue wait
      end_ms: 10_000
    });
    expect(queue).toMatchObject({ name: "net.turn.queue", parent_span_id: root.span_id, start_ms: 9_880, end_ms: 9_900 });
    expect(rpc).toMatchObject({ name: "net.turn.rpc", parent_span_id: root.span_id, start_ms: 9_900, end_ms: 9_930 });
    for (const child of [queue, rpc]) {
      expect(child.start_ms).toBeGreaterThanOrEqual(root.start_ms);
      expect(child.end_ms).toBeLessThanOrEqual(root.end_ms);
    }
  });

  it("children are clamped inside the root even when reported buckets overrun", () => {
    const spans = turnSpans({
      trace: adopted(SAMPLED),
      now_ms: 1_000,
      wall_ms: 10,
      queue_ms: 5,
      rpc_ms: 500, // pathological report: rpc bucket larger than the wall
      status: "ok",
      attributes: {}
    });
    const root = spans[0];
    for (const child of spans.slice(1)) {
      expect(child.start_ms).toBeGreaterThanOrEqual(root.start_ms);
      expect(child.end_ms).toBeLessThanOrEqual(root.end_ms);
    }
  });

  it("minted contexts root the tree at the CARRIED span id (review finding 2: scope spans attach to it)", () => {
    const spans = turnSpans({
      trace: minted(SAMPLED),
      now_ms: 100,
      wall_ms: 10,
      queue_ms: 0,
      rpc_ms: 0,
      status: "error",
      attributes: {}
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]?.parent_span_id).toBeUndefined();
    expect(spans[0]?.span_id).toBe("00f067aa0ba902b7"); // the minted context's own span id
    expect(spans[0]?.status).toBe("error");
  });
});

describe("otlpTracePayload (OTLP/HTTP JSON mapping)", () => {
  it("emits hex ids, nano times, status codes, links, and resource attributes", () => {
    const span: NetSpan = {
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      span_id: "00f067aa0ba902b7",
      name: "net.commit",
      start_ms: 1,
      end_ms: 2.5,
      status: "error",
      attributes: { "woo.scope": "room:r", "woo.seq": 7 },
      links: [{ trace_id: "aaaabbbbccccddddeeeeffff00001111", span_id: "1234567890abcdef" }]
    };
    const payload = otlpTracePayload([span], { service: "woo-net", instance: "gw-1" }) as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string }> };
        scopeSpans: Array<{ spans: Array<Record<string, unknown>> }>;
      }>;
    };
    const out = payload.resourceSpans[0];
    expect(out.resource.attributes.map((a) => a.key)).toEqual(["service.name", "service.instance.id"]);
    const otlp = out.scopeSpans[0].spans[0];
    expect(otlp).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      name: "net.commit",
      startTimeUnixNano: "1000000",
      endTimeUnixNano: "2500000",
      status: { code: 2 },
      links: [{ traceId: "aaaabbbbccccddddeeeeffff00001111", spanId: "1234567890abcdef" }]
    });
    expect(otlp.attributes).toEqual([
      { key: "woo.scope", value: { stringValue: "room:r" } },
      { key: "woo.seq", value: { doubleValue: 7 } }
    ]);
    // JSON-clean (TR3 discipline: plain data end to end).
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });
});
