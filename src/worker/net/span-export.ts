/**
 * Span export (audit.md AU8): every sampled span goes to the `woo.span`
 * structured-log channel (R10.2 — Logpush/tail ships it anywhere); when
 * the operator configures WOO_OTLP_ENDPOINT, the batch is additionally
 * pushed as OTLP/HTTP JSON off the reply path (Host.defer — failures
 * land in net_deferred_task_error, never on the request). Best-effort
 * by design: spans are telemetry; the audit trail's guarantees live in
 * the /audit lane, not here (AU6 vs AU8).
 */
import type { Host } from "../../net/host";
import { logSpan, otlpTracePayload, type NetSpan } from "../../net/spans";

export type SpanExportEnv = {
  /** OTLP/HTTP traces endpoint (e.g. https://collector/v1/traces). */
  WOO_OTLP_ENDPOINT?: string;
  /** 1-in-N sampling for MINTED traces (adopted traces follow their
   * caller's sampled flag). Absent/0 = spans off for minted traces. */
  NET_SPAN_SAMPLE?: string;
};

export function spanSampleRate(env: SpanExportEnv): number {
  const rate = Number(env.NET_SPAN_SAMPLE ?? 0);
  return Number.isFinite(rate) && rate > 0 ? Math.floor(rate) : 0;
}

export function exportSpans(
  env: SpanExportEnv,
  host: Pick<Host, "defer">,
  spans: readonly NetSpan[],
  resource: { service: string; instance: string }
): void {
  if (spans.length === 0) return;
  for (const span of spans) logSpan(span);
  const endpoint = env.WOO_OTLP_ENDPOINT;
  if (!endpoint) return;
  host.defer(async () => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(otlpTracePayload(spans, resource))
    });
    if (!response.ok) {
      throw new Error(`otlp push failed: ${response.status}`);
    }
  });
}
