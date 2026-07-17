/**
 * W3C trace context for the net layer (spec/operations/audit.md AU2).
 *
 * The durable and wire representation is the W3C header strings VERBATIM
 * — `{trace_id, span_id}` alone would lose the flags byte and vendor
 * tracestate, so the full context travels and is stored in every durable
 * row that continues work (outbox rows, rider envelopes, scheduled
 * turns). `tracestate` is carried opaque and never parsed.
 *
 * Invalid or absent inbound context NEVER rejects a turn: the gateway
 * mints a fresh root (`origin: "minted"`). The sampled flag governs ops
 * span export only; audit-trail behavior ignores it (AU2/AU6).
 *
 * Layering: pure data + WebCrypto randomness. No platform imports, no
 * Host access — usable from src/net/, gateways, and tests alike.
 */

export type TraceContext = {
  /** W3C: "00-<32 hex trace_id>-<16 hex span_id>-<2 hex flags>". */
  traceparent: string;
  /** W3C tracestate, carried opaque. */
  tracestate?: string;
  /** Whether the context was adopted from the caller or minted here. */
  origin: "adopted" | "minted";
};

/** Parsed view of a traceparent header. Internal consumers only need the
 * ids for AE stamping and span links; the durable form stays the string. */
export type ParsedTraceparent = {
  traceId: string;
  spanId: string;
  flags: string;
};

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/**
 * Strict W3C parse. Returns null for anything malformed — including the
 * all-zero trace or span id, which the spec forbids — and for the
 * reserved version ff. Unknown future versions are accepted per W3C
 * (parse the known prefix) as long as the known fields are well-formed.
 */
export function parseTraceparent(header: string | null | undefined): ParsedTraceparent | null {
  if (!header) return null;
  // Future versions may append fields after the flags; W3C says parse the
  // first four fields and ignore the rest for versions > 00.
  const m = TRACEPARENT_RE.exec(header) ?? TRACEPARENT_RE.exec(header.slice(0, 55));
  if (!m) return null;
  const [, version, traceId, spanId, flags] = m;
  if (version === "ff") return null;
  if (version === "00" && header.length !== 55) return null;
  if (traceId === "00000000000000000000000000000000") return null;
  if (spanId === "0000000000000000") return null;
  return { traceId, spanId, flags };
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Mint a fresh root context. The sampled flag is set: woo's own spans
 * are sample-governed downstream at export, not at mint (AU2). */
export function mintTraceContext(): TraceContext {
  return {
    traceparent: `00-${randomHex(16)}-${randomHex(8)}-01`,
    origin: "minted"
  };
}

/**
 * The single entry point for inbound context (REST/MCP `traceparent`
 * header, WS turn-frame `trace` field): adopt when valid, mint when
 * absent or malformed. A tracestate without a valid traceparent is
 * dropped (W3C: tracestate is meaningless alone).
 */
export function adoptOrMintTraceContext(
  traceparent: string | null | undefined,
  tracestate?: string | null
): TraceContext {
  const parsed = parseTraceparent(traceparent);
  if (!parsed) return mintTraceContext();
  const ctx: TraceContext = { traceparent: traceparent as string, origin: "adopted" };
  // Bound the opaque carry: W3C caps combined tracestate at 512 chars of
  // list-members; anything larger is droppable by spec, and we drop
  // rather than truncate (truncation could corrupt a member).
  if (tracestate && tracestate.length <= 512) ctx.tracestate = tracestate;
  return ctx;
}

/**
 * Derive a same-trace child context: a new span id under the same trace
 * id, preserving flags and tracestate. Used when a durable row continues
 * the work and its consumer needs a distinct span identity to link from
 * (AU2 async causality: new trace + LINK for fanout/alarm/scheduled; a
 * synchronous in-turn hop stays in-trace via this child derivation).
 */
export function childTraceContext(parent: TraceContext): TraceContext {
  const parsed = parseTraceparent(parent.traceparent);
  if (!parsed) return mintTraceContext();
  const child: TraceContext = {
    traceparent: `00-${parsed.traceId}-${randomHex(8)}-${parsed.flags}`,
    origin: parent.origin
  };
  if (parent.tracestate) child.tracestate = parent.tracestate;
  return child;
}

/** Serializable guard for durable rows: accepts only the exact
 * TraceContext shape (used by envelope validators — a malformed carried
 * context degrades to minted rather than rejecting the row's work). */
export function normalizeTraceContext(value: unknown): TraceContext | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.traceparent !== "string" || !parseTraceparent(v.traceparent)) return null;
  if (v.origin !== "adopted" && v.origin !== "minted") return null;
  const out: TraceContext = { traceparent: v.traceparent, origin: v.origin };
  if (typeof v.tracestate === "string" && v.tracestate.length <= 512) out.tracestate = v.tracestate;
  return out;
}
