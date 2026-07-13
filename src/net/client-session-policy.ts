/** Shared public-session lifetime policy. The browser embeds the default in a
 * retry bearer, so client and gateway must import one value or valid retries
 * become fail-closed 400s after an otherwise harmless server-side change. */
export const CLIENT_SESSION_TTL_DEFAULT_MS = 30 * 60_000;
export const CLIENT_SESSION_TTL_MIN_MS = 60_000;
export const CLIENT_SESSION_TTL_MAX_MS = 24 * 60 * 60_000;

export function clampClientSessionTtl(raw: unknown): number {
  const ttl = typeof raw === "number" && Number.isFinite(raw) ? raw : CLIENT_SESSION_TTL_DEFAULT_MS;
  return Math.min(CLIENT_SESSION_TTL_MAX_MS, Math.max(CLIENT_SESSION_TTL_MIN_MS, ttl));
}
