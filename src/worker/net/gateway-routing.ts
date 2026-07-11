import { sessionShardHint, ticketShardHint } from "../../net/session-id";

export const LEGACY_NET_GATEWAY_SHARD = "net-api";
export const DEFAULT_NET_GATEWAY_SHARDS = 1;
export const MAX_NET_GATEWAY_SHARDS = 64;

export function parseNetGatewayShardCount(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) return DEFAULT_NET_GATEWAY_SHARDS;
  return Math.min(value, MAX_NET_GATEWAY_SHARDS);
}

export function netGatewayShardName(index: number, count: number): string {
  return count === 1 ? LEGACY_NET_GATEWAY_SHARD : `${LEGACY_NET_GATEWAY_SHARD}-${index}`;
}

export type NetGatewayRouteInput = {
  pathname: string;
  searchParams: URLSearchParams;
  headers: Headers;
  bodyText?: string;
  shardCount: number;
  /** Entropy supplied by the edge for truly anonymous first requests. */
  anonymousKey: string;
};

/** Select a configured gateway without creating an untrusted named DO. */
export function routeNetGateway(input: NetGatewayRouteInput): string {
  const body = parseObject(input.bodyText);
  const hintedSession = firstString(
    input.headers.get("mcp-session-id"),
    bearerSession(input.headers.get("authorization")),
    input.searchParams.get("session"),
    body?.session
  );
  const sessionHint = hintedSession ? sessionShardHint(hintedSession) : null;
  if (sessionHint && validShardHint(sessionHint, input.shardCount)) return sessionHint;

  const ticket = input.pathname === "/net-api/ws" ? input.searchParams.get("ticket") : null;
  const ticketHint = ticket ? ticketShardHint(ticket) : null;
  if (ticketHint && validShardHint(ticketHint, input.shardCount)) return ticketHint;

  const credentialKey = firstString(
    apiKeyId(input.headers.get("authorization")),
    apiKeyId(input.headers.get("x-woo-api-key")),
    apiKeyId(input.headers.get("mcp-token"))
  );
  const email = input.pathname === "/net-api/login" && typeof body?.email === "string"
    ? body.email.trim().toLowerCase()
    : "";
  const key = credentialKey ? `apikey:${credentialKey}` : email ? `email:${email}` : input.anonymousKey;
  return netGatewayShardName(stableHash(key) % input.shardCount, input.shardCount);
}

function validShardHint(hint: string, count: number): boolean {
  if (hint === LEGACY_NET_GATEWAY_SHARD) return true;
  if (!hint.startsWith(`${LEGACY_NET_GATEWAY_SHARD}-`)) return false;
  const index = Number(hint.slice(LEGACY_NET_GATEWAY_SHARD.length + 1));
  return Number.isSafeInteger(index) && index >= 0 && index < count;
}

function parseObject(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function bearerSession(value: string | null): string | null {
  const match = /^Bearer\s+session:(.+)$/i.exec(value?.trim() ?? "");
  return match?.[1]?.trim() || null;
}

function apiKeyId(value: string | null): string | null {
  if (!value) return null;
  const raw = value.trim().replace(/^Bearer\s+/i, "").replace(/^apikey:/, "");
  const colon = raw.indexOf(":");
  return colon > 0 ? raw.slice(0, colon) : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === "string" && value.length > 0) return value;
  return null;
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
