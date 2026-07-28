/**
 * The public origin of an edge request, carried across the edge → Durable
 * Object hop, and the MCP `Origin` admission rule that reads it.
 *
 * Why this module exists
 * ----------------------
 * `handleNetApi` in `net-only-index.ts` rewrites the forwarded URL to
 * `https://do/<path>` before dispatching into a DO — the DO addresses itself by
 * its own opaque name, not by the public hostname. That rewrite is deliberate,
 * but it destroys the one fact an `Origin` check needs: what the *browser*
 * thought it was talking to. A DO comparing `Origin` against its own request
 * URL compares a public origin against `https://do`, which no browser can ever
 * match — so every real browser is refused and every headless client (an
 * attacker trivially is one) passes. That inversion is the defect this module
 * repairs.
 *
 * Trust model
 * -----------
 * `x-woo-internal-public-origin` is an EDGE ASSERTION. The `x-woo-internal-`
 * prefix is load-bearing: `sanitizePublicHeaders` deletes every header with
 * that prefix from the inbound public request as the first act of
 * `fetch()`, and `handleNetApi` deletes it again before setting it. A client
 * therefore cannot forge it; only the Worker can state it, and it states
 * `new URL(request.url).origin` — the origin the edge itself was addressed at.
 *
 * The header is meaningful ONLY on the unsigned public forward hop
 * (edge → gateway DO). No internal-signed doorway sets or reads it, so it is
 * deliberately absent from the `canonical()` signed-header list in
 * `internal-auth.ts`: there is no signed request whose behaviour it changes.
 *
 * What an attacker can and cannot assert
 * --------------------------------------
 * CAN: any `Origin` value at all, from any non-browser client. Origin checking
 * has never constrained non-browser callers and does not here — credentials
 * (`Mcp-Token` / `Mcp-Session-Id`) are what authorize those. What this check
 * buys is that a *hostile web page* cannot drive a victim's browser (and the
 * victim's ambient session) into this endpoint, because the browser, not the
 * page, writes `Origin`.
 * CANNOT: forge `x-woo-internal-public-origin` (stripped twice), or make a
 * browser send an `Origin` it does not own.
 *
 * Why the endpoint origin must itself be vetted (DNS rebinding)
 * -------------------------------------------------------------
 * Deriving "same origin" from the request's own `Host` is only sound when
 * `Host` is authenticated. Under DNS rebinding the attacker's page at
 * `http://evil.test` resolves to a loopback address; the browser then sends
 * `Host: evil.test` AND `Origin: http://evil.test` — self-consistent, so a
 * naive same-origin rule would admit it. Two cases are safe:
 *   - `https:` — the hostname is TLS-authenticated. A rebound request cannot
 *     present a certificate this edge would serve for the attacker's name.
 *   - a loopback literal host over `http:` — a rebinding page's `Host` is its
 *     own routable name, never `localhost`/`127.0.0.1`/`[::1]`.
 * Anything else (plain `http:` on a routable name) is NOT a trustworthy
 * same-origin reference, and browsers are refused there — fail closed.
 */

/** Edge-asserted public origin. Prefix chosen so `sanitizePublicHeaders`
 * already strips any inbound forgery; see the module comment. */
export const PUBLIC_ORIGIN_HEADER = "x-woo-internal-public-origin";

/**
 * Rebuild `headers` for the edge → DO forward: drop any client-supplied copy of
 * the trusted header, then assert the real public origin.
 *
 * SECURITY, and it rests on a subtle API behaviour — do not "simplify" this
 * without reading the whole paragraph. `Headers.set` REPLACES every existing
 * value of that name; `Headers.append` would ADD one, leaving a forged inbound
 * value in the list. The DO then reads the header with `Headers.get`, which for
 * a multi-valued name returns the values joined with ", " — so with `append` a
 * client sending `x-woo-internal-public-origin: https://evil.example` would
 * make the DO see `https://evil.example, https://woah1...`, which parses as
 * nothing and (correctly, but silently) fails closed for EVERY browser: the
 * production bug, reintroduced by a one-word edit. `set` is what makes the
 * edge's assertion authoritative.
 *
 * Three layers defeat a forged inbound copy, and they are not redundant with
 * each other in the ways that matter:
 *   1. `set` above — the value the DO reads is the edge's, whatever arrived.
 *   2. the explicit `delete` — states the invariant where the value becomes
 *      trusted, and is the layer that survives a future refactor of (1).
 *   3. `sanitizePublicHeaders` stripping the `x-woo-internal-` prefix as the
 *      first act of `fetch()` — the only layer that still holds if some future
 *      route forwards a public request WITHOUT coming through here. This is why
 *      the header name must keep that prefix; a test pins it.
 */
export function withPublicOrigin(headers: Headers, publicUrl: URL): Headers {
  const forwarded = new Headers(headers);
  forwarded.delete(PUBLIC_ORIGIN_HEADER);
  forwarded.set(PUBLIC_ORIGIN_HEADER, publicUrl.origin);
  return forwarded;
}

/** Serialized origin (`scheme://host[:port]`) of a candidate value, or null if
 * it is absent, unparseable, or opaque. `"null"` is what a sandboxed iframe or
 * a redirected cross-origin request sends; it is not a same-origin claim. */
function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null") return null;
  try {
    const origin = new URL(trimmed).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/** Loopback names a rebinding page cannot put in its own `Host`. `.localhost`
 * is included because RFC 6761 reserves the whole TLD to loopback. */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost"
    || host.endsWith(".localhost")
    || host === "127.0.0.1"
    || host === "[::1]"
    || host === "::1";
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

type EndpointOrigin = { origin: string; loopback: boolean };

/**
 * The edge-asserted origin, admitted as a same-origin reference only when its
 * own hostname is authenticated (`https:`) or is a loopback literal. See the
 * module comment for why plain `http:` on a routable name is rejected.
 */
function trustedEndpointOrigin(raw: string | null | undefined): EndpointOrigin | null {
  const origin = normalizeOrigin(raw);
  if (origin === null) return null;
  const url = new URL(origin);
  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol === "https:") return { origin, loopback };
  if (url.protocol === "http:" && loopback) return { origin, loopback };
  return null;
}

/** Operator-configured extra origins (`WOO_MCP_ALLOWED_ORIGINS`), comma or
 * whitespace separated. Empty by default: no hostname is compiled in. */
export function parseAllowedOrigins(configured: string | undefined): string[] {
  if (!configured) return [];
  return configured
    .split(/[,\s]+/)
    .map((entry) => normalizeOrigin(entry))
    .filter((entry): entry is string => entry !== null);
}

export type McpOriginDecision = "allow" | "refuse";

/**
 * The MCP `Origin` admission rule.
 *
 * ABSENT `Origin` ⇒ allow. This is not a loophole being preserved out of
 * habit: Streamable HTTP's normal clients (stdio bridges, CLI agents, server
 * runtimes) send no `Origin`, and refusing them would break every legitimate
 * non-browser MCP client while stopping no attacker — anyone who can omit a
 * header can also send an arbitrary one. The check exists to constrain
 * browsers, which cannot lie about `Origin`, and it is applied wherever the
 * header appears. Credentials, not `Origin`, authorize a call.
 *
 * PRESENT `Origin` ⇒ must equal the trusted endpoint origin, or a configured
 * extra origin, or (loopback endpoints only) any loopback origin — that last
 * clause is what keeps `npm run dev` working, where Vite serves the page on
 * :5173 and proxies to workerd on another loopback port, so the browser's
 * `Origin` and the Worker's `Host` legitimately differ. It cannot widen a
 * deployed endpoint: there the endpoint origin is not loopback.
 */
export function mcpOriginDecision(input: {
  origin: string | null | undefined;
  publicOrigin: string | null | undefined;
  configured?: string | undefined;
}): McpOriginDecision {
  if (input.origin === null || input.origin === undefined) return "allow";
  const origin = normalizeOrigin(input.origin);
  // A malformed or opaque `Origin` was sent by a browser and is not a
  // same-origin claim, so it is refused rather than treated as absent.
  if (origin === null) return "refuse";
  const endpoint = trustedEndpointOrigin(input.publicOrigin);
  if (endpoint !== null && origin === endpoint.origin) return "allow";
  if (parseAllowedOrigins(input.configured).includes(origin)) return "allow";
  if (endpoint !== null && endpoint.loopback && isLoopbackOrigin(origin)) return "allow";
  return "refuse";
}
