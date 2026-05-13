import type { ObjRef, WooValue } from "./types";

export type ShadowEnvelopeAuth = {
  mode: "session" | "anonymous_advisory" | "same_deployment_mac" | "signature";
  key_id?: string;
  signature?: string;
  mac?: string;
  claims?: Record<string, WooValue>;
  token?: string;
};

export type ShadowEnvelope<T = WooValue> = {
  v: 2;
  type: string;
  id: string;
  from: string;
  to?: string;
  actor?: ObjRef;
  session?: string;
  reply_to?: string;
  sent_at?: number;
  expires_at?: number;
  auth: ShadowEnvelopeAuth;
  trace?: string;
  body: T;
};

const MAX_SHADOW_ENVELOPE_BYTES = 1024 * 1024;
const SHADOW_TEXT_ENCODER = new TextEncoder();
// The codec is type-neutral across production and shadow suffixes. Relay
// policy decides which accepted wire types are legal in each direction.
const KNOWN_SHADOW_TYPES = new Set([
  "woo.transport.hello.v1",
  "woo.transport.ping.v1",
  "woo.transport.pong.v1",
  "woo.transport.error.v1",
  "woo.subscribe.v1",
  "woo.catchup.request.v1",
  "woo.catchup.reply.v1",
  "woo.live.event.v1",
  "woo.live.event.shadow.v1",
  "woo.state.transfer.v1",
  "woo.state.transfer.shadow.v1",
  "woo.turn.exec.request.shadow.v1",
  "woo.turn.exec.reply.shadow.v1",
  "woo.commit.accepted.shadow.v1",
  "woo.commit.conflict.shadow.v1"
]);

// The codec is deliberately socket-free: tests and later WebSocket handlers use
// the same validation path, so transport bugs show up before a real server lands.
export function encodeEnvelope<T>(env: ShadowEnvelope<T>): string {
  validateEnvelope(env);
  const encoded = JSON.stringify(env);
  if (shadowEnvelopeByteLength(encoded) > MAX_SHADOW_ENVELOPE_BYTES) {
    throw new Error("shadow envelope too large");
  }
  return encoded;
}

export function decodeEnvelope<T = WooValue>(str: string): ShadowEnvelope<T> {
  if (shadowEnvelopeByteLength(str) > MAX_SHADOW_ENVELOPE_BYTES) {
    throw new Error("shadow envelope too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(str);
  } catch (err) {
    throw new Error(`malformed shadow envelope JSON: ${(err as Error).message}`);
  }
  validateEnvelope(parsed);
  return parsed as ShadowEnvelope<T>;
}

// Keep this validator structural and conservative. Unknown message types are
// rejected here so callers cannot accidentally treat new wire behavior as a
// harmless advisory frame.
function validateEnvelope(value: unknown): asserts value is ShadowEnvelope {
  if (!isRecord(value)) throw new Error("shadow envelope must be an object");
  if (value.v !== 2) throw new Error("unsupported shadow envelope version");
  if (typeof value.type !== "string" || value.type.length === 0) throw new Error("shadow envelope type is required");
  if (!KNOWN_SHADOW_TYPES.has(value.type)) throw new Error(`unknown shadow envelope type: ${value.type}`);
  if (typeof value.id !== "string" || value.id.length === 0) throw new Error("shadow envelope id is required");
  if (typeof value.from !== "string" || value.from.length === 0) throw new Error("shadow envelope from is required");
  if ("to" in value && typeof value.to !== "string") throw new Error("shadow envelope to must be a string");
  if ("actor" in value && typeof value.actor !== "string") throw new Error("shadow envelope actor must be a string");
  if ("session" in value && typeof value.session !== "string") throw new Error("shadow envelope session must be a string");
  if ("reply_to" in value && typeof value.reply_to !== "string") throw new Error("shadow envelope reply_to must be a string");
  if ("sent_at" in value && typeof value.sent_at !== "number") throw new Error("shadow envelope sent_at must be a number");
  if ("expires_at" in value && typeof value.expires_at !== "number") throw new Error("shadow envelope expires_at must be a number");
  if (!("auth" in value)) throw new Error("shadow envelope auth is required");
  validateAuth(value.auth);
  if (!("body" in value)) throw new Error("shadow envelope body is required");
  if (isRecord(value.body) && typeof value.body.kind === "string" && value.body.kind !== value.type) {
    throw new Error(`shadow envelope body kind mismatch: type=${value.type} body=${value.body.kind}`);
  }
}

function validateAuth(value: unknown): asserts value is ShadowEnvelopeAuth {
  if (!isRecord(value)) throw new Error("shadow envelope auth must be an object");
  if (!["session", "anonymous_advisory", "same_deployment_mac", "signature"].includes(String(value.mode))) {
    throw new Error("shadow envelope auth mode is invalid");
  }
  if (value.mode === "session" && typeof value.token !== "string") {
    throw new Error("shadow envelope session auth token is required");
  }
  if ("claims" in value && !isRecord(value.claims)) throw new Error("shadow envelope auth claims must be an object");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function shadowEnvelopeByteLength(value: string): number {
  return SHADOW_TEXT_ENCODER.encode(value).byteLength;
}
