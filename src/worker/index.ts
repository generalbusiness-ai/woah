// Worker entry — splits routing between Durable Objects and Workers Assets.
//
// Global API, /healthz, /v2/turn-network/ws      -> world/gateway DO.
// Object REST calls                             → world/gateway DO v2 executor.
// Object REST reads                             → Directory-resolved host DO.
// Everything else                                → env.ASSETS.fetch (the bundled SPA from ./dist).

import type { Env } from "./persistent-object-do";
import { signInternalRequest } from "./internal-auth";
import { sessionActiveScopeFromRecord, wooError } from "../core/types";
import { handleAdmin } from "./admin";

export { PersistentObjectDO } from "./persistent-object-do";
export { DirectoryDO } from "./directory-do";
export { CommitScopeDO } from "./commit-scope-do";

const WORLD_HOST = "world";
const DIRECTORY_HOST = "directory";
const INTERNAL_ORIGIN = "https://woo.internal";
const MAX_JSON_BODY_BYTES = 1 * 1024 * 1024;
const MCP_SESSION_HEADER = "mcp-session-id";
const MCP_GATEWAY_SHARD_PREFIX = "mcp-gateway-";
const DEFAULT_MCP_GATEWAY_SHARDS = 32;

function isApiPath(pathname: string): boolean {
  return (
    pathname === "/healthz" ||
    pathname === "/v2/turn-network/ws" ||
    pathname === "/v2/session/mint" ||
    pathname === "/mcp" ||
    pathname === "/connect" ||
    pathname.startsWith("/api/")
  );
}

export default {
  async fetch(request: Request, env: Env, _ctx: unknown): Promise<Response> {
    const url = new URL(request.url);

    // Strip any x-woo-internal-* / x-woo-host-key the public client tried to
    // inject; those headers are reserved for trusted gateway → DO forwarding.
    request = sanitizePublicHeaders(request);

    if (url.pathname.startsWith("/__internal/")) {
      return jsonResponse({ error: wooError("E_NOSESSION", "internal routes require a signed internal request") }, 401);
    }

    if (request.method === "POST" && url.pathname === "/api/auth") {
      const response = await forwardToHost(env, WORLD_HOST, request);
      await registerAuthResponse(env, response.clone());
      return response;
    }

    if (url.pathname === "/mcp") {
      return forwardToMcpGateway(env, request);
    }

    const objectRoute = parseObjectRoute(url.pathname);
    if (objectRoute) {
      // v2 REST calls execute from the gateway snapshot and commit through
      // CommitScopeDO. Routing calls to the target host would reintroduce v1's
      // stale per-host cache problem for cross-host inventory and movement.
      const host = objectRoute.rest[0] === "calls"
        ? WORLD_HOST
        : await resolveHostForObjectRoute(env, request, objectRoute);
      const routed = await withDirectorySession(env, request);
      const response = await forwardToHost(env, host, routed);
      if (host !== WORLD_HOST && request.method === "POST" && objectRoute.rest[0] === "calls") {
        await broadcastRoutedCall(env, request, response.clone(), host);
      }
      return response;
    }

    if (isApiPath(url.pathname)) {
      return forwardToHost(env, WORLD_HOST, await withDirectorySession(env, request));
    }

    // /admin/* must run before the SPA fallback so the asset's
    // not-found-handling=single-page-application doesn't swallow it.
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return handleAdmin(request, env, url);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    // Static assets binding missing — operator hasn't built the SPA bundle.
    // Fail loud so it surfaces, rather than silently returning the API 404.
    return new Response(
      JSON.stringify({ error: { code: "E_NO_ASSETS", message: "no SPA bundle deployed; run `npm run build` before `wrangler deploy`" } }),
      { status: 503, headers: { "content-type": "application/json; charset=utf-8" } }
    );
  }
};

async function resolveHostForObjectRoute(
  env: Env,
  request: Request,
  route: { id: string; rest: string[] }
): Promise<string> {
  let id = route.id;
  let fallback = WORLD_HOST;

  if (request.method === "POST" && route.rest.length === 2 && route.rest[0] === "calls") {
    // We only peek at a cloned body here. The original Request is still
    // forwarded below, and later header-wrapping uses `new Request(request, …)`
    // without consuming the stream. If this path grows more body readers,
    // buffer once explicitly instead of adding another clone.
    const body = await readJson(request.clone());
    if (typeof body.space === "string" && body.space) {
      const spaceRoute = await resolveDirectoryObject(env, body.space, WORLD_HOST);
      id = body.space;
      fallback = spaceRoute.host;
    }
  }

  if (id === "$me") {
    const session = await resolveRequestSession(env, request);
    if (session?.actor) id = session.actor;
  }

  const routeInfo = await resolveDirectoryObject(env, id, fallback);
  return routeInfo.host || fallback;
}

async function forwardToHost(env: Env, host: string, request: Request): Promise<Response> {
  // Don't strip x-woo-internal-* here — withDirectorySession may have set
  // them upstream so the target DO can bind the session via
  // ensureSessionForActor. Inbound public copies are stripped once at the
  // gateway entry by sanitizePublicHeaders.
  const headers = new Headers(request.headers);
  headers.set("x-woo-host-key", host);
  const routed = await signInternalRequest(env, new Request(request, { headers }));
  const id = env.WOO.idFromName(host);
  try {
    return await env.WOO.get(id).fetch(routed);
  } catch (err) {
    return jsonResponse({ error: { code: "E_INTERNAL", message: `routed host ${host} failed: ${errorMessage(err)}` } }, 500);
  }
}

async function forwardToMcpGateway(env: Env, request: Request): Promise<Response> {
  const sessionId = request.headers.get(MCP_SESSION_HEADER)?.trim();
  if (!sessionId) {
    // First-request MCP auth can mint a new woo session, so it remains on the
    // canonical world gateway. Once the MCP session id exists, later requests
    // are stable-hashed to shard DOs and resume from Directory session state.
    return forwardToHost(env, WORLD_HOST, request);
  }
  const session = await resolveSessionId(env, sessionId);
  const routed = session ? withSessionHeaders(request, session) : request;
  return forwardToHost(env, mcpGatewayShardHost(env, sessionId), routed);
}

async function withDirectorySession(env: Env, request: Request): Promise<Request> {
  const session = await resolveRequestSession(env, request);
  if (!session) return request;
  return withSessionHeaders(request, session);
}

function withSessionHeaders(
  request: Request,
  session: { session_id: string; actor: string; expires_at: number; token_class: string; active_scope?: string | null; apikey_id?: string | null }
): Request {
  const headers = cleanInternalHeaders(request.headers);
  headers.set("x-woo-internal-session", session.session_id);
  headers.set("x-woo-internal-actor", session.actor);
  headers.set("x-woo-internal-expires-at", String(session.expires_at));
  headers.set("x-woo-internal-token-class", session.token_class);
  if (session.active_scope) headers.set("x-woo-internal-active-scope", session.active_scope);
  if (session.active_scope) headers.set("x-woo-internal-current-location", session.active_scope);
  if (session.apikey_id) headers.set("x-woo-internal-apikey-id", session.apikey_id);
  return new Request(request, { headers });
}

async function registerAuthResponse(env: Env, response: Response): Promise<void> {
  if (!response.ok) return;
  try {
    const body = await response.json() as Record<string, unknown>;
    if (typeof body.session !== "string" || typeof body.actor !== "string") return;
    await directoryPost(env, "/register-session", {
      session_id: body.session,
      actor: body.actor,
      expires_at: Number(body.expires_at ?? Date.now() + 5 * 60_000),
      token_class: body.token_class === "guest" || body.token_class === "apikey" ? body.token_class : "bearer",
      active_scope: sessionActiveScope(body),
      current_location: sessionActiveScope(body),
      apikey_id: typeof body.apikey_id === "string" && body.apikey_id.length > 0 ? body.apikey_id : null
    });
    await directoryPost(env, "/register-objects", {
      routes: [{ id: body.actor, host: WORLD_HOST, anchor: null }]
    });
  } catch {
    // Auth succeeded; Directory registration is best-effort for this response.
    // Subsequent object routes without a Directory session will fail closed on
    // the target host rather than silently impersonating.
  }
}

async function broadcastRoutedCall(env: Env, request: Request, response: Response, host: string): Promise<void> {
  if (!response.ok) return;
  try {
    const body = await response.json() as Record<string, unknown>;
    await registerSessionLocationFromCall(env, request, body);
    if (body.op === "applied") {
      await registerObjectsFromApplied(env, body, host);
      await forwardToHost(env, WORLD_HOST, new Request(`${INTERNAL_ORIGIN}/__internal/broadcast-applied`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ frame: body })
      }));
      return;
    }
    if (Array.isArray(body.observations)) {
      await forwardToHost(env, WORLD_HOST, new Request(`${INTERNAL_ORIGIN}/__internal/broadcast-live-events`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          audience: host,
          audience_actors: body.audience_actors,
          observation_audiences: body.observation_audiences,
          observations: body.observations
        })
      }));
    }
  } catch {
    // Best-effort live fan-out only. The sequenced frame is already durable on
    // the routed host; clients can recover via replay/state aggregation.
  }
}

async function registerSessionLocationFromCall(env: Env, request: Request, body: Record<string, unknown>): Promise<void> {
  const result = body.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return;
  const room = (result as Record<string, unknown>).room;
  if (typeof room !== "string" || !room) return;
  const session = await resolveRequestSession(env, request);
  if (!session) return;
  await directoryPost(env, "/register-session", {
    session_id: session.session_id,
    actor: session.actor,
    expires_at: session.expires_at,
    token_class: session.token_class,
    active_scope: room,
    current_location: room,
    apikey_id: session.apikey_id ?? null
  });
}

async function registerObjectsFromApplied(env: Env, _frame: Record<string, unknown>, host: string): Promise<void> {
  const id = env.WOO.idFromName(host);
  const request = await signInternalRequest(env, new Request(`${INTERNAL_ORIGIN}/__internal/object-routes`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-woo-host-key": host
    },
    body: "{}"
  }));
  const response = await env.WOO.get(id).fetch(request);
  if (!response.ok) return;
  const parsed = await response.json();
  const routes = Array.isArray(parsed)
    ? parsed.filter((route) => route && typeof route === "object" && !Array.isArray(route) && (route as Record<string, unknown>).host === host)
    : [];
  if (routes.length > 0) await directoryPost(env, "/register-objects", { routes });
}

async function resolveRequestSession(env: Env, request: Request): Promise<{ session_id: string; actor: string; expires_at: number; token_class: string; active_scope?: string | null; current_location?: string | null; apikey_id?: string | null } | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Session\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  return resolveSessionId(env, match[1]);
}

async function resolveSessionId(env: Env, sessionId: string): Promise<{ session_id: string; actor: string; expires_at: number; token_class: string; active_scope?: string | null; current_location?: string | null; apikey_id?: string | null } | null> {
  try {
    const body = await directoryPost(env, "/resolve-session", { session_id: sessionId }) as Record<string, unknown>;
    const session = body.session;
    if (!session || typeof session !== "object") return null;
    const record = session as Record<string, unknown>;
    if (typeof record.session_id !== "string" || typeof record.actor !== "string") return null;
    const activeScope = sessionActiveScope(record);
    return {
      session_id: record.session_id,
      actor: record.actor,
      expires_at: Number(record.expires_at ?? 0),
      token_class: typeof record.token_class === "string" ? record.token_class : "bearer",
      active_scope: activeScope,
      current_location: activeScope,
      apikey_id: typeof record.apikey_id === "string" && record.apikey_id.length > 0 ? record.apikey_id : null
    };
  } catch {
    return null;
  }
}

function mcpGatewayShardHost(env: Env, sessionId: string): string {
  const shards = mcpGatewayShardCount(env);
  return `${MCP_GATEWAY_SHARD_PREFIX}${stableHash(sessionId) % shards}`;
}

function mcpGatewayShardCount(env: Env): number {
  const raw = Number(env.WOO_MCP_GATEWAY_SHARDS ?? DEFAULT_MCP_GATEWAY_SHARDS);
  return Number.isInteger(raw) && raw > 0 && raw <= 256 ? raw : DEFAULT_MCP_GATEWAY_SHARDS;
}

function stableHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function sessionActiveScope(record: Record<string, unknown>): string | null {
  return sessionActiveScopeFromRecord(record);
}

async function resolveDirectoryObject(env: Env, id: string, fallbackHost: string): Promise<{ id: string; host: string; anchor: string | null }> {
  const body = await directoryPost(env, "/resolve-object", { id, fallback_host: fallbackHost }) as Record<string, unknown>;
  return {
    id: typeof body.id === "string" ? body.id : id,
    host: typeof body.host === "string" ? body.host : fallbackHost,
    anchor: typeof body.anchor === "string" ? body.anchor : null
  };
}

async function directoryPost(env: Env, path: string, body: Record<string, unknown>): Promise<unknown> {
  const id = env.DIRECTORY.idFromName(DIRECTORY_HOST);
  const request = await signInternalRequest(env, new Request(`${INTERNAL_ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body)
  }));
  const response = await env.DIRECTORY.get(id).fetch(request);
  const parsed = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(parsed));
  return parsed;
}

function cleanInternalHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  for (const name of Array.from(headers.keys())) {
    const lower = name.toLowerCase();
    if (lower.startsWith("x-woo-internal-") || lower === "x-woo-host-key" || lower === "x-woo-task-chain") {
      // x-woo-task-chain is behavior-bearing on the receiver (it can
      // bypass the host queue when matched against the running task's
      // chain id; see WooWorld.hostDispatch). The gateway mints fresh
      // chain ids in forwardInternalRaw — public clients have no
      // legitimate use for the header and it must not survive the
      // public→internal trust boundary.
      headers.delete(name);
    }
  }
  return headers;
}

function sanitizePublicHeaders(request: Request): Request {
  const headers = cleanInternalHeaders(request.headers);
  return new Request(request, { headers });
}

function parseObjectRoute(pathname: string): { id: string; rest: string[] } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "objects" || !parts[2]) return null;
  return {
    id: decodeURIComponent(parts[2]),
    rest: parts.slice(3).map((part) => decodeURIComponent(part))
  };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(await readLimitedBody(request)));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) throw err;
    return {};
  }
}

async function readLimitedBody(request: Request): Promise<ArrayBuffer> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) throw wooError("E_RATE", `request body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_JSON_BODY_BYTES) throw wooError("E_RATE", `request body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
  return body;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
