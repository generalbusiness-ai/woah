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
 * The record helper only verifies the credential bytes. Before session mint,
 * the gateway separately resolves the actor's authority cells and mirrors
 * core's deactivation checks for the actor, human account, and recursive
 * agent-owner chain. An unresolvable owner fails closed. `last_seen_at` touch
 * remains a world-write concern; Net records bounded liveness through its
 * session cells and audit instead.
 *
 * Every failure is a ClientAuthError: the caller maps it to HTTP 401 with
 * {error:{code:"E_NOSESSION", ...}} — the same named-refusal vocabulary
 * core auth uses for credential failures.
 */
import { constantTimeEqual, hashSource } from "../../core/source-hash";

/** Named client-auth failure; always an HTTP 401 E_NOSESSION upstream. */
export class ClientAuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(
    message: string,
    readonly detail: Record<string, unknown> = {},
    // Defaults keep every existing throw (authentication failures) at
    // E_NOSESSION/401; the B1 authorization denials pass E_PERM/403.
    code = "E_NOSESSION",
    status = 401
  ) {
    super(message);
    this.name = "ClientAuthError";
    this.code = code;
    this.status = status;
  }
}

export type ClientCredential =
  | { kind: "apikey"; id: string; secret: string }
  /** The identity-door bearer (the formerly-documented Phase-5 hole):
   * a session minted by /net-api/login, /net-api/guest, or
   * /net-api/session is itself the credential for subsequent calls —
   * the SAME trust shape the MCP adapter has used since phase i
   * (initialize authenticates, mcp-session-id carries). The gateway
   * validates the session cell and derives the actor from it. */
  | { kind: "session"; session: string };

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
  const classify = (raw: string, carrier: string): ClientCredential => {
    if (raw.startsWith("session:")) {
      const session = raw.slice("session:".length);
      if (!session) throw new ClientAuthError("session token must be session:<id>", { reason: "malformed_credential" });
      return { kind: "session", session };
    }
    if (!raw.startsWith("apikey:")) {
      throw new ClientAuthError(`${carrier} credential must be apikey:<id>:<secret> or session:<id>`, {
        reason: "unsupported_token_class"
      });
    }
    const token = raw.slice("apikey:".length);
    const colon = token.indexOf(":");
    const id = colon >= 0 ? token.slice(0, colon) : "";
    const secret = colon >= 0 ? token.slice(colon + 1) : "";
    if (!id || !secret) {
      throw new ClientAuthError("apikey token must be apikey:<id>:<secret>", { reason: "malformed_credential" });
    }
    return { kind: "apikey", id, secret };
  };

  const auth = headers.get("authorization")?.trim() ?? "";
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearerMatch) return classify(bearerMatch[1].trim(), "bearer");
  const headerKey = headers.get("x-woo-api-key")?.trim();
  if (headerKey) {
    // The x-woo-api-key carrier is apikey-only by definition; the prefix
    // stays optional for compatibility.
    const raw = headerKey.startsWith("apikey:") ? headerKey : `apikey:${headerKey}`;
    return classify(raw, "x-woo-api-key");
  }
  if (queryToken) return classify(queryToken.trim(), "query");
  throw new ClientAuthError(
    "missing credential: send `authorization: Bearer apikey:<id>:<secret>` (or `Bearer session:<id>`, or `x-woo-api-key`)",
    { reason: "missing_credential" }
  );
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
  if (credential.kind !== "apikey") {
    // Assert class: callers route session credentials through the
    // session-cell validation path (gateway clientApi), never here.
    throw new ClientAuthError("credential is not an apikey", { reason: "unsupported_token_class" });
  }
  const record =
    map && typeof map === "object" && !Array.isArray(map)
      ? (map as Record<string, unknown>)[credential.id]
      : undefined;
  return verifyApiKeyRecord(record, credential);
}

/** Verify one exact actor-owned lookup row. Keeping the record-level helper
 * beside the legacy-map wrapper guarantees both authorities use identical
 * refusal ordering and constant-time hash comparison. */
export function verifyApiKeyRecord(record: unknown, credential: ClientCredential): { actor: string } {
  if (credential.kind !== "apikey") {
    throw new ClientAuthError("credential is not an apikey", { reason: "unsupported_token_class" });
  }
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

// ---------------------------------------------------------------------------
// The identity door (§8 "humans re-authenticate by password"): password
// verification against carried $account cells. The scheme is EXACTLY
// core's (world.ts hashPassword/verifyPassword), reimplemented narrowly
// per this module's discipline (never import world.ts). The stored
// `password_hash` is self-describing — `pbkdf2-sha256:<iterations>:
// <salt-hex>:<digest-hex>` — so verification needs no other account
// fields; the minimum-iterations floor mirrors core's anti-downgrade
// rule (a weaker-than-current encoding never verifies).
// ---------------------------------------------------------------------------

const PASSWORD_PBKDF2_ITERATIONS = 600_000;
const PASSWORD_PBKDF2_KEY_BITS = 256;
/** V3 finding 7: an UPPER bound on verifier iterations. A carried (or
 * malicious) hash encoding a huge iteration count would turn one login
 * into an unbounded CPU sink; anything above this ceiling never
 * verifies (fail closed — the same posture as the minimum floor). Sized
 * well above the 600k floor so a legitimate future re-hash has room. */
const PASSWORD_PBKDF2_ITERATIONS_MAX = 4_000_000;
/** V3 finding 7: strict credential byte limits. Email/password are
 * attacker-controlled and rate-limiter keys; a megabyte email would
 * bloat the limiter map and the account scan. Rejected before any
 * derivation or limiter keying. */
export const MAX_EMAIL_BYTES = 254; // RFC 5321 address ceiling
export const MAX_PASSWORD_BYTES = 1024;

/** v2 parity: account lookup is BY EMAIL, lowercased and trimmed. */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Constant-time-compared PBKDF2-SHA256 verify of a self-describing
 * encoded hash. Returns false (never throws) on any malformed encoding —
 * the caller owns the single fail-closed "invalid email or password". */
export async function verifyPasswordCredential(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split(":");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  const salt = parts[2];
  const expected = parts[3];
  if (
    !Number.isSafeInteger(iterations) ||
    iterations < PASSWORD_PBKDF2_ITERATIONS ||
    iterations > PASSWORD_PBKDF2_ITERATIONS_MAX ||
    !salt ||
    !expected
  ) {
    return false;
  }
  const subtle = (globalThis as unknown as { crypto: { subtle: SubtleCrypto } }).crypto.subtle;
  const keyMaterial = await subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const saltBytes = new Uint8Array(salt.length / 2);
  for (let i = 0; i < saltBytes.length; i += 1) saltBytes[i] = Number.parseInt(salt.slice(i * 2, i * 2 + 2), 16);
  const bits = await subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes.buffer as ArrayBuffer, iterations },
    keyMaterial,
    PASSWORD_PBKDF2_KEY_BITS
  );
  const actual = [...new Uint8Array(bits)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return constantTimeEqual(actual, expected);
}
