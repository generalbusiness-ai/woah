import { wooError } from "../core/types";

export type InternalAuthEnv = {
  WOO_INTERNAL_SECRET?: string;
};

const INTERNAL_TS_HEADER = "x-woo-internal-ts";
const INTERNAL_BODY_SHA_HEADER = "x-woo-internal-body-sha256";
const INTERNAL_SIGNATURE_HEADER = "x-woo-internal-signature";
const INTERNAL_SKEW_MS = 5 * 60_000;
// SHA-256 of empty input, base64url encoded.
const EMPTY_SHA256 = "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU";

export async function signInternalRequest(env: InternalAuthEnv, request: Request): Promise<Request> {
  const secret = requireSecret(env);
  const body = await requestBodyBytes(request);
  const headers = new Headers(request.headers);
  const ts = String(Date.now());
  const bodySha = await sha256(body);
  headers.set(INTERNAL_TS_HEADER, ts);
  headers.set(INTERNAL_BODY_SHA_HEADER, bodySha);
  headers.delete(INTERNAL_SIGNATURE_HEADER);
  headers.set(INTERNAL_SIGNATURE_HEADER, await hmac(secret, canonical(request, headers)));
  return rebuildRequest(request, headers, body);
}

export async function verifyInternalRequest(env: InternalAuthEnv, request: Request): Promise<void> {
  const secret = requireSecret(env);
  const headers = request.headers;
  const signature = headers.get(INTERNAL_SIGNATURE_HEADER);
  const ts = Number(headers.get(INTERNAL_TS_HEADER) ?? NaN);
  const statedBodySha = headers.get(INTERNAL_BODY_SHA_HEADER);
  if (!signature || !Number.isFinite(ts) || !statedBodySha) {
    throw wooError("E_NOSESSION", "missing internal request signature");
  }
  if (Math.abs(Date.now() - ts) > INTERNAL_SKEW_MS) {
    throw wooError("E_PERM", "stale internal request signature");
  }
  const body = await requestBodyBytes(request);
  const actualBodySha = await sha256(body);
  if (actualBodySha !== statedBodySha) {
    throw wooError("E_PERM", "internal request body hash mismatch");
  }
  const expected = await hmac(secret, canonical(request, headers));
  if (!constantTimeEqual(signature, expected)) {
    throw wooError("E_PERM", "invalid internal request signature");
  }
}

function requireSecret(env: InternalAuthEnv): string {
  if (!env.WOO_INTERNAL_SECRET) {
    throw wooError("E_BOOTSTRAP_TOKEN_MISSING", "set WOO_INTERNAL_SECRET via wrangler secret put");
  }
  return env.WOO_INTERNAL_SECRET;
}

function canonical(request: Request, headers: Headers): string {
  const url = new URL(request.url);
  // Closed list by design: every authority-bearing or
  // behavior-bearing x-woo-* header must be added here before any
  // sender or receiver relies on it. `x-woo-task-chain` belongs in
  // this list because the receiver bypasses the host queue when its
  // value matches a running task's chain id (see WooWorld.hostDispatch
  // re-entrancy short-circuit) — without HMAC binding, an attacker
  // who could plant the right value would interleave a behavior with
  // an in-flight one. Internal DO traffic is signed end-to-end so the
  // practical exposure is low, but we want defense in depth: any
  // header that influences scheduling is part of the canonical
  // string.
  const signedHeaders = [
    "x-woo-host-key",
    "x-woo-internal-session",
    "x-woo-internal-actor",
    "x-woo-internal-expires-at",
    "x-woo-internal-token-class",
    "x-woo-task-chain",
    INTERNAL_TS_HEADER,
    INTERNAL_BODY_SHA_HEADER
  ];
  return [
    request.method.toUpperCase(),
    `${url.pathname}${url.search}`,
    ...signedHeaders.map((name) => `${name}:${headers.get(name) ?? ""}`)
  ].join("\n");
}

async function requestBodyBytes(request: Request): Promise<Uint8Array> {
  if (request.method === "GET" || request.method === "HEAD") return new Uint8Array();
  return new Uint8Array(await request.clone().arrayBuffer());
}

function rebuildRequest(request: Request, headers: Headers, body: Uint8Array): Request {
  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : arrayBufferFromBytes(body)
  });
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return base64url(new Uint8Array(signature));
}

async function sha256(data: Uint8Array): Promise<string> {
  if (data.byteLength === 0) return EMPTY_SHA256;
  const digest = await crypto.subtle.digest("SHA-256", arrayBufferFromBytes(data));
  return base64url(new Uint8Array(digest));
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
