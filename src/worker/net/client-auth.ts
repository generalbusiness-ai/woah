/**
 * Client authentication for the /net-api surface (Plan 002 Phase 4
 * item 2; coherence.md CO14 "credential authentication against identity
 * cells in the catalog scope closure").
 *
 * The token is the existing woo apikey credential (`apikey:<id>:<secret>`),
 * verified against the catalog identity cell
 * `property_cell:$system:api_keys`. The salt/hash scheme is EXACTLY the
 * one core auth uses (src/core/world.ts authApiKey), reimplemented
 * narrowly here because the net layer must never import world.ts:
 *
 *   stored record: { hash, salt, actor, label, created_at, revoked_at? }
 *   verification:  constantTimeEqual(hashSource(`${salt}:${secret}`), hash)
 *
 * Core checks deliberately NOT mirrored (documented, not implied): actor
 * existence and deactivation are engine-state checks with no cell-level
 * equivalent at the gateway; an unresolvable actor surfaces downstream as
 * E_MISSING_STATE when the session open tries to classify it, never as a
 * silent accept. last_seen_at touch (a world write) is likewise a core
 * concern — the net path records liveness through session cells instead.
 *
 * Every failure is a ClientAuthError: the caller maps it to HTTP 401 with
 * {error:{code:"E_NOSESSION", ...}} — the same named-refusal vocabulary
 * core auth uses for credential failures.
 */
import { constantTimeEqual, hashSource } from "../../core/source-hash";

/** Named client-auth failure; always an HTTP 401 E_NOSESSION upstream. */
export class ClientAuthError extends Error {
  readonly code = "E_NOSESSION";
  constructor(
    message: string,
    readonly detail: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "ClientAuthError";
  }
}

export type ClientCredential = { id: string; secret: string };

/**
 * Parse the client credential off a request's headers. Accepted carriers,
 * authorization header winning when both are present:
 *
 *   authorization: Bearer apikey:<id>:<secret>
 *   x-woo-api-key: apikey:<id>:<secret>     (the `apikey:` prefix optional)
 *
 * A bearer token WITHOUT the `apikey:` prefix is refused namedly: other
 * token classes (bearer session import) are the Phase-5 identity story,
 * and silently treating one as an apikey would mask the misconfiguration.
 *
 * `queryToken` (Phase 4 item 3) is a LAST-resort carrier the caller opts
 * into for the ONE route that needs it: WebSocket upgrades, where the
 * browser (and Node-native) WebSocket API cannot set request headers —
 * the same reason the v2 WS route carries `?token=`. It must be the FULL
 * `apikey:<id>:<secret>` form (the prefix names the token class, exactly
 * the bearer rule) and rides TLS like everything else; headers always
 * win when present, so no HTTP client is ever pushed toward the URL
 * carrier.
 */
export function parseClientCredential(headers: Headers, queryToken?: string | null): ClientCredential {
  const auth = headers.get("authorization")?.trim() ?? "";
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(auth);
  let token: string | null = null;
  if (bearerMatch) {
    const raw = bearerMatch[1].trim();
    if (!raw.startsWith("apikey:")) {
      throw new ClientAuthError("bearer credential must be apikey:<id>:<secret> (other token classes are Phase-5)", {
        reason: "unsupported_token_class"
      });
    }
    token = raw.slice("apikey:".length);
  } else {
    const headerKey = headers.get("x-woo-api-key")?.trim();
    if (headerKey) token = headerKey.startsWith("apikey:") ? headerKey.slice("apikey:".length) : headerKey;
  }
  if (!token && queryToken) {
    const raw = queryToken.trim();
    if (!raw.startsWith("apikey:")) {
      throw new ClientAuthError("query token must be apikey:<id>:<secret> (other token classes are Phase-5)", {
        reason: "unsupported_token_class"
      });
    }
    token = raw.slice("apikey:".length);
  }
  if (!token) {
    throw new ClientAuthError(
      "missing credential: send `authorization: Bearer apikey:<id>:<secret>` (or `x-woo-api-key`)",
      { reason: "missing_credential" }
    );
  }
  const colon = token.indexOf(":");
  const id = colon >= 0 ? token.slice(0, colon) : "";
  const secret = colon >= 0 ? token.slice(colon + 1) : "";
  if (!id || !secret) {
    throw new ClientAuthError("apikey token must be apikey:<id>:<secret>", { reason: "malformed_credential" });
  }
  return { id, secret };
}

/**
 * Verify a credential against the api_keys identity map (the VALUE slot
 * of `property_cell:$system:api_keys`) and resolve the bound actor.
 * Mirrors world.ts authApiKey's checks in order: record presence/shape,
 * required fields, soft-delete (revoked_at — revoked records stay in the
 * map for audit but reject), then the constant-time hash comparison.
 * Unknown-id and revoked deliberately share one message, as core does.
 */
export function verifyApiKeyCredential(map: unknown, credential: ClientCredential): { actor: string } {
  const record =
    map && typeof map === "object" && !Array.isArray(map)
      ? (map as Record<string, unknown>)[credential.id]
      : undefined;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new ClientAuthError("apikey not found or revoked", { reason: "unknown_or_revoked" });
  }
  const r = record as Record<string, unknown>;
  const salt = String(r.salt ?? "");
  const expected = String(r.hash ?? "");
  const actor = String(r.actor ?? "");
  if (!salt || !expected || !actor) {
    throw new ClientAuthError("apikey record is malformed", { reason: "malformed_record" });
  }
  if (r.revoked_at != null) {
    throw new ClientAuthError("apikey not found or revoked", { reason: "unknown_or_revoked" });
  }
  const presented = hashSource(`${salt}:${credential.secret}`);
  if (!constantTimeEqual(presented, expected)) {
    throw new ClientAuthError("apikey secret rejected", { reason: "secret_rejected" });
  }
  return { actor };
}
