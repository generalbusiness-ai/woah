/**
 * Ops span emission (audit.md AU2/AU8).
 *
 * The data model is literal OTel — 128-bit hex trace ids, 64-bit hex
 * span ids, span links, `woo.*` semantic attributes — but NOT the OTel
 * SDK (AU8: isolate lifecycles and best-effort exporters disqualify it
 * in-process). Spans are emitted as `woo.span` structured log lines
 * (the R10.2 channel — Logpush/tail ships them to any converter) and,
 * when the operator configures an OTLP endpoint, batched into an
 * OTLP/HTTP JSON payload pushed off the reply path.
 *
 * Sampling (AU2): the W3C sampled flag governs span EXPORT only —
 * audit records are minted regardless. An adopted context carries its
 * caller's flag; minted contexts are gated by NET_SPAN_SAMPLE (1-in-N;
 * 0/absent = spans off for minted traces). Deterministic by trace id so
 * one trace samples consistently across gateway and scope.
 *
 * Emission sites read timings the pipeline already measures (the turn
 * structure report, the scope submit clock) — no new clocks on hot
 * paths. Per-Host.rpc child spans are DEFERRED: the gateway processes
 * turns concurrently, so parenting rpc spans needs explicit context
 * threading through the seam (TR1), not an ambient field that races.
 * Wrong parents are worse than absent spans.
 */
import { parseTraceparent, type TraceContext } from "./trace";

export type SpanStatus = "ok" | "error";

export type NetSpan = {
  trace_id: string; // 32 hex
  span_id: string; // 16 hex
  parent_span_id?: string;
  name: string;
  /** Wall-clock ms. OTLP conversion scales to unix nanos. */
  start_ms: number;
  end_ms: number;
  status: SpanStatus;
  /** Flat string/number attributes (woo.* semconv). */
  attributes: Record<string, string | number>;
  /** AU2 async causality: span LINKS to other trace contexts. */
  links?: Array<{ trace_id: string; span_id: string }>;
};

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

export function mintSpanId(): string {
  return randomHex(8);
}

/**
 * Should spans be exported for this context? Adopted contexts follow
 * the caller's sampled flag verbatim (their trace, their decision).
 * Minted contexts sample 1-in-N deterministically by trace id, so every
 * producer that sees the trace makes the same call.
 */
export function spanSampled(trace: TraceContext | undefined, sampleRate: number): boolean {
  if (!trace) return false;
  const parsed = parseTraceparent(trace.traceparent);
  if (!parsed) return false;
  if (trace.origin === "adopted") return (parseInt(parsed.flags, 16) & 0x01) === 0x01;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return false;
  const rate = Math.floor(sampleRate);
  if (rate <= 1) return true;
  let hash = 0x811c9dc5;
  for (let i = 0; i < parsed.traceId.length; i += 1) {
    hash ^= parsed.traceId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % rate === 0;
}

/** Emit one span on the structured-log channel (R10.2). The `woo.span`
 * marker is the ship-filter for Logpush/tail converters. */
export function logSpan(span: NetSpan): void {
  console.log("woo.span", JSON.stringify(span));
}

/**
 * OTLP/HTTP JSON (v1 trace service) payload for a span batch. Ids are
 * hex per the OTLP/JSON mapping; times are unix nanoseconds as strings.
 * Self-contained — no OTel dependency (AU8).
 */
export function otlpTracePayload(
  spans: readonly NetSpan[],
  resource: { service: string; instance: string }
): Record<string, unknown> {
  const attr = (key: string, value: string | number) => ({
    key,
    value: typeof value === "number" ? { doubleValue: value } : { stringValue: value }
  });
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [attr("service.name", resource.service), attr("service.instance.id", resource.instance)]
        },
        scopeSpans: [
          {
            scope: { name: "woo.net" },
            spans: spans.map((span) => ({
              traceId: span.trace_id,
              spanId: span.span_id,
              ...(span.parent_span_id ? { parentSpanId: span.parent_span_id } : {}),
              name: span.name,
              kind: 1, // SPAN_KIND_INTERNAL
              startTimeUnixNano: String(Math.round(span.start_ms * 1e6)),
              endTimeUnixNano: String(Math.round(span.end_ms * 1e6)),
              status: { code: span.status === "ok" ? 1 : 2 },
              attributes: Object.entries(span.attributes).map(([key, value]) => attr(key, value)),
              ...(span.links && span.links.length > 0
                ? { links: span.links.map((link) => ({ traceId: link.trace_id, spanId: link.span_id })) }
                : {})
            }))
          }
        ]
      }
    ]
  };
}

/**
 * Build the turn span tree from the gateway's structure report: one
 * root `net.turn` span plus phase children reconstructed from the
 * measured millisecond buckets (queue wait, rpc time inside the wall).
 * The parent span id is the CALLER's span (from the adopted
 * traceparent) so the tree hangs under the customer's own trace.
 */
export function turnSpans(input: {
  trace: TraceContext;
  now_ms: number; // end of the turn (producer clock)
  wall_ms: number;
  queue_ms: number;
  rpc_ms: number;
  status: SpanStatus;
  attributes: Record<string, string | number>;
}): NetSpan[] {
  const parsed = parseTraceparent(input.trace.traceparent);
  if (!parsed) return [];
  const root: NetSpan = {
    trace_id: parsed.traceId,
    span_id: mintSpanId(),
    // Adopted context: hang under the caller's span. Minted: root.
    ...(input.trace.origin === "adopted" ? { parent_span_id: parsed.spanId } : {}),
    name: "net.turn",
    start_ms: input.now_ms - input.wall_ms,
    end_ms: input.now_ms,
    status: input.status,
    attributes: input.attributes
  };
  const spans: NetSpan[] = [root];
  let cursor = root.start_ms;
  const phase = (name: string, ms: number): void => {
    if (!Number.isFinite(ms) || ms <= 0) return;
    spans.push({
      trace_id: root.trace_id,
      span_id: mintSpanId(),
      parent_span_id: root.span_id,
      name,
      start_ms: cursor,
      end_ms: cursor + ms,
      status: "ok",
      attributes: {}
    });
    cursor += ms;
  };
  phase("net.turn.queue", input.queue_ms);
  phase("net.turn.rpc", input.rpc_ms);
  return spans;
}
