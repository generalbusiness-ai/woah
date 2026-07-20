/**
 * AU8 span emission: sampling semantics (adopted flag wins; minted
 * gated deterministically), the turn span tree, and the OTLP/JSON
 * payload mapping (hex ids, nano times, status codes).
 */
import { describe, expect, it } from "vitest";
import { otlpTracePayload, spanSampled, turnSpans, type NetSpan } from "../../src/net/spans";
import type { TraceContext } from "../../src/net/trace";

const SAMPLED = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const UNSAMPLED = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00";
const adopted = (traceparent: string): TraceContext => ({ traceparent, origin: "adopted" });
const minted = (traceparent: string): TraceContext => ({ traceparent, origin: "minted" });

describe("spanSampled (AU2: sampled flag governs export only)", () => {
  it("adopted contexts follow the caller's flag verbatim", () => {
    expect(spanSampled(adopted(SAMPLED), 0)).toBe(true);
    expect(spanSampled(adopted(UNSAMPLED), 1)).toBe(false);
  });
  it("minted contexts are off without a rate, always-on at 1, deterministic at N", () => {
    expect(spanSampled(minted(SAMPLED), 0)).toBe(false);
    expect(spanSampled(minted(SAMPLED), 1)).toBe(true);
    const at100 = spanSampled(minted(SAMPLED), 100);
    expect(spanSampled(minted(SAMPLED), 100)).toBe(at100); // same trace, same verdict
  });
  it("absent or malformed context never samples", () => {
    expect(spanSampled(undefined, 1)).toBe(false);
    expect(spanSampled({ traceparent: "junk", origin: "minted" }, 1)).toBe(false);
  });
});

describe("turnSpans", () => {
  it("hangs the root under the caller's span for adopted contexts and lays phases inside the wall", () => {
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
      start_ms: 9_900,
      end_ms: 10_000
    });
    expect(queue).toMatchObject({ name: "net.turn.queue", parent_span_id: root.span_id, start_ms: 9_900, end_ms: 9_920 });
    expect(rpc).toMatchObject({ name: "net.turn.rpc", parent_span_id: root.span_id, start_ms: 9_920, end_ms: 9_950 });
  });

  it("minted contexts root the tree (no parent) and zero phases are elided", () => {
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
