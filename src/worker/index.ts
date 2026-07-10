// Worker entry — splits routing between Durable Objects and Workers Assets.
//
// Global API, /healthz, /v2/turn-network/ws      → world/gateway DO.
// /net-api/*  (Phase-4 client surface)           → GATEWAY_NET stable shard
//                                                  (client-credentialed; see
//                                                  handleNetApi).
// Object REST calls and reads                    → Directory-resolved host DO
//                                                  (calls/Y formerly forced
//                                                  to world; see /api/objects
//                                                  block below for rationale).
// Everything else                                → env.ASSETS.fetch (the bundled SPA from ./dist).

import type { Env } from "./persistent-object-do";
import { signInternalRequest, verifyInternalRequest } from "./internal-auth";
import { sessionActiveScopeFromRecord, wooError } from "../core/types";
import { handleAdmin } from "./admin";
import { resolveNetDestination, type NetBindingsEnv } from "./net/workerd-host";

export { PersistentObjectDO } from "./persistent-object-do";
export { DirectoryDO } from "./directory-do";
export { CommitScopeDO } from "./commit-scope-do";
// Plan 002 coherence layer (spec/protocol/coherence.md): new classes
// beside the v2 ones; no production route reaches them until Phase 5.
export { NetScopeDO } from "./net/scope-do";
export { NetGatewayDO } from "./net/gateway-do";

const WORLD_HOST = "world";
const DIRECTORY_HOST = "directory";
const INTERNAL_ORIGIN = "https://woo.internal";
const MAX_JSON_BODY_BYTES = 1 * 1024 * 1024;
/** Body cap for the /net-smoke lane doorway (fix 8c): bounded, but wide
 * enough for /net/seed's full-world cell closure (see handleNetSmoke). */
const NET_SMOKE_MAX_BODY_BYTES = 8 * 1024 * 1024;
const MCP_SESSION_HEADER = "mcp-session-id";
const MCP_GATEWAY_SHARD_PREFIX = "mcp-gateway-";
const DEFAULT_MCP_GATEWAY_SHARDS = 32;
const LANDING_HOST = "woah.generalbusiness.ai";
const WORLD_PUBLIC_HOST = "woah1.generalbusiness.ai";

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

    // Capture the request BEFORE sanitization for the one caller that must
    // read the inbound internal signature: the /net-smoke doorway (H1b).
    // sanitizePublicHeaders strips every x-woo-internal-* header, so the
    // signature cannot survive into handleNetSmoke otherwise. We must
    // CLONE, not alias: sanitizePublicHeaders builds `new Request(request,
    // …)`, which disturbs (locks) the original's body stream — a POST
    // doorway call would then fail its body read with "stream locked to a
    // reader" on real workerd (the fake lane never surfaced it). The clone
    // has an independent, unlocked body. Only pay the clone for the
    // /net-smoke path; every other request aliases as before.
    const isNetSmoke = url.pathname.startsWith("/net-smoke/");
    const isNetInstall = url.pathname.startsWith("/net-install/");
    const rawRequest = isNetSmoke || isNetInstall ? request.clone() : request;

    // Strip any x-woo-internal-* / x-woo-host-key the public client tried to
    // inject; those headers are reserved for trusted gateway → DO forwarding.
    request = sanitizePublicHeaders(request);

    if (url.hostname.toLowerCase() === LANDING_HOST) {
      const landingResponse = handleLandingHost(request, env, url);
      if (landingResponse) return landingResponse;
    }

    if (url.pathname.startsWith("/__internal/")) {
      return jsonResponse({ error: wooError("E_NOSESSION", "internal routes require a signed internal request") }, 401);
    }

    // Reviewer finding 4: the SPA's transport default is DEPLOYMENT
    // state, not client state — a first-time browser at bare `/` after
    // the route switch must boot the net client. Public, unauthenticated,
    // tiny; the SPA fetches it once per unsignaled boot (explicit ?net=1
    // / localStorage signals win without the fetch).
    if (request.method === "GET" && url.pathname === "/client-config") {
      // V3 finding 9: the transport default is AUTHORITATIVE deployment
      // state — no-store so a rollback (route back to the dual-stack
      // worker, which serves net:false or 404s) is never masked by a
      // cached net:true. The SPA lets this OVERRIDE a stored woo:net flag
      // (a rollback un-pins net clients); only an explicit ?net=1
      // (development) still wins client-side.
      return new Response(JSON.stringify({ net: Boolean(env.WOO_NET_DEFAULT) }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
      });
    }

    // Cutover item C: the §8 write-freeze, edge half (the DO enforces it
    // again — defense in depth). Freezes the V2 surfaces only: the NET
    // namespace (/net-api, /net-install) must stay fully usable during
    // the window — installing and proving the new world is WHY the old
    // one is frozen. GET reads continue; the WS upgrade and session mint
    // are refused even as GETs (each opens a mutation channel). /admin
    // stays up (operator surface, own auth).
    {
      const frozenSurface =
        isApiPath(url.pathname) || url.pathname === "/mcp" || url.pathname === "/connect" || url.pathname.startsWith("/v2/");
      const mutating = request.method !== "GET" || url.pathname === "/v2/turn-network/ws" || url.pathname === "/v2/session/mint";
      // V3 finding 1 (P0): satellite-host mutations arrive at their DOs
      // INTERNAL-SIGNED (edge-forwarded), so a DO-level persisted-fence
      // check never fires for them — the EDGE, which every public
      // request crosses regardless of host, is the distributed choke.
      // env flag = instant per deploy; the persisted generation reaches
      // here TTL-cached from the world authority. (WS FRAMES bypass the
      // edge after upgrade — the DO frame handler holds its own
      // distributed check.)
      if (frozenSurface && mutating && (env.WOO_WRITE_FREEZE || (await edgeFenceFrozen(env)))) {
        return jsonResponse(
          {
            error: {
              code: "E_MAINTENANCE",
              message: "write-frozen for the cutover maintenance window; reads continue, writes resume after the window",
              detail: { frozen: true }
            }
          },
          503
        );
      }
    }

    // Plan 002 Phase 3 lane surface (step 4b): the workerd smoke lane
    // (scripts/net-smoke-workerd.ts, `npm run smoke:net-dev`) drives the
    // net DOs over plain HTTP through this block. It exists ONLY for the
    // local proving lanes — the Phase-4 transports (session open, command
    // routing, fanout delivery) replace it, at which point this block is
    // deleted. Hard-refused in deployed environments: WOO_AE_DATASET is
    // set only by the deploy configs (the same runtime posture as
    // parseNetFaults), so on a deploy the surface 404s indistinguishably
    // from any other unknown route.
    //
    // H1b passes the RAW (pre-sanitize) request so the doorway can verify
    // the inbound internal signature — the sanitized copy has none. This
    // is safe: (1) the deploy-404 fires first, so a deployed environment
    // never reaches verification with the raw request; (2) verification
    // rejects anyone without WOO_INTERNAL_SECRET; (3) handleNetSmoke
    // rebuilds a FRESH forward request to the DO (it never propagates an
    // inbound header), so an injected x-woo-host-key etc. is dropped, not
    // trusted. The proving lanes hold the secret and sign every call.
    if (isNetSmoke) {
      return handleNetSmoke(rawRequest, env, url);
    }

    // Cutover item A: the PRODUCTION world-install conduit
    // (notes/2026-07-08-net-cutover-tooling-plan.md). Unlike /net-smoke
    // this is NOT dataset-gated — installing the world into the fresh net
    // namespace is a production operation (§8 Phase 5 step 2) — so the
    // internal SIGNATURE is the whole gate (the operator holds
    // WOO_INTERNAL_SECRET for the cutover op), and the surface is
    // allow-listed to exactly the install verbs: seed and head. Same H1b
    // raw-request discipline as /net-smoke.
    if (isNetInstall) {
      return handleNetInstall(rawRequest, env, url);
    }

    // Plan 002 Phase 4 item 2: the coherence layer's PRODUCTION client
    // surface. UNLIKE /net-smoke this is NOT gated on WOO_AE_DATASET —
    // it carries client credentials (apikey verified by the gateway DO
    // against the catalog identity cell), and no internal signature is
    // minted here, so the DO's /net-api handler trusts nothing about
    // this hop (sanitizePublicHeaders already stripped any injected
    // internal headers above).
    if (url.pathname.startsWith("/net-api/")) {
      return handleNetApi(request, env, url);
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
      // Route /api/objects/X/calls/Y to X's host when Directory knows
      // one; otherwise fall back to WORLD. Previously /calls/ was
      // forced to WORLD on the rationale that v2 REST calls run from
      // a gateway snapshot and commit through CommitScopeDO. Two
      // architectural shifts make satellite-side execution safe:
      //   - Live verbs (commit 6153d8a) bypass CommitScopeDO entirely
      //     and execute in-process against the receiving DO's world.
      //   - Durable verbs still go through CommitScopeDO regardless of
      //     which DO submits the envelope — CommitScopeDO is the
      //     authority for ordering; the submitting host's snapshot is
      //     just a planner input, validated by CommitScopeDO before
      //     accept. The originating host's writeThroughV2CommitToObjectHosts
      //     applies the transcript locally for the touched objects it
      //     owns, then fans apply-v2-commit to other touched hosts.
      // Block subjects (the_horoscope, the_weather, ...) anchored to
      // a self-hosted room now execute on that room's DO instead of
      // pinning WORLD's host queue.
      try {
        const host = await resolveHostForObjectRoute(env, request, objectRoute);
        const routed = await withDirectorySession(env, request);
        const response = await forwardToHost(env, host, routed);
        if (host !== WORLD_HOST && request.method === "POST" && objectRoute.rest[0] === "calls") {
          await broadcastRoutedCall(env, request, response.clone(), host);
        }
        return response;
      } catch (err) {
        // Routing-stage errors (e.g. E_RATE from the body peek in
        // resolveHostForObjectRoute) must surface as a normalized
        // JSON error response, not as a Worker exception. Once the
        // request reaches a DO, core/protocol.ts handles normalization
        // — but the routing peek runs before that boundary, so the
        // top-level fetch is the last chance to translate.
        return errorResponseFor(err);
      }
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

function handleLandingHost(request: Request, env: Env, url: URL): Response | Promise<Response> | null {
  if (isLandingPageRequest(request, url)) {
    if (!env.ASSETS) return missingAssetsResponse();
    const assetUrl = new URL(request.url);
    assetUrl.pathname = "/landing";
    assetUrl.search = "";
    return env.ASSETS.fetch(new Request(assetUrl, request));
  }

  if (isLandingAssetPath(url.pathname)) {
    if (!env.ASSETS) return missingAssetsResponse();
    return env.ASSETS.fetch(request);
  }

  // Protocol clients, especially WebSocket upgrades, cannot safely follow the
  // landing-host redirect. Let API and internal-control paths use normal Worker
  // routing on this same hostname.
  if (isLandingHostPassthroughPath(url.pathname)) return null;

  const target = new URL(request.url);
  target.hostname = WORLD_PUBLIC_HOST;
  return Response.redirect(target.toString(), 308);
}

function isLandingPageRequest(request: Request, url: URL): boolean {
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/landing" || url.pathname === "/landing.html")
  );
}

function isLandingAssetPath(pathname: string): boolean {
  return pathname === "/woah-og.png" || pathname === "/woah-og.svg" || pathname.startsWith("/icons/");
}

function isLandingHostPassthroughPath(pathname: string): boolean {
  return isApiPath(pathname) || pathname.startsWith("/__internal/");
}

function missingAssetsResponse(): Response {
  return new Response(
    JSON.stringify({ error: { code: "E_NO_ASSETS", message: "no SPA bundle deployed; run `npm run build` before `wrangler deploy`" } }),
    { status: 503, headers: { "content-type": "application/json; charset=utf-8" } }
  );
}

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

/** V3 finding 1: the edge's TTL-cached read of the world authority's
 * PERSISTED freeze generation (isolate-scoped module cache — every
 * public mutation crosses the edge, so this is where the persisted
 * fence becomes distributed). Unreachable authority retains the
 * last-known verdict and retries at quarter-TTL; a fresh isolate with
 * no verdict defaults open (the env flag is the instant global half,
 * and the runbook sets BOTH for the cutover window). */
let edgeFenceCache: { frozen: boolean; checkedAt: number } | null = null;
let edgeFenceInFlight: Promise<void> | null = null;
const EDGE_FENCE_TTL_MS = 15_000;

/** Test isolation: the fence cache is isolate-scoped and would leak a
 * TTL'd verdict across fake-DO harnesses in one vitest worker. */
export function __resetEdgeFenceForTests(): void {
  edgeFenceCache = null;
}

async function edgeFenceFrozen(env: Env): Promise<boolean> {
  const now = Date.now();
  if (!edgeFenceCache || now - edgeFenceCache.checkedAt > EDGE_FENCE_TTL_MS) {
    if (!edgeFenceInFlight) {
      edgeFenceInFlight = (async () => {
        try {
          const probe = new Request(`${INTERNAL_ORIGIN}/__internal/freeze-state`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}"
          });
          const response = await forwardToHost(env, WORLD_HOST, probe);
          if (response.ok) {
            const body = (await response.json()) as { frozen?: unknown };
            edgeFenceCache = { frozen: Boolean(body.frozen), checkedAt: Date.now() };
            return;
          }
        } catch {
          // retain last-known below
        }
        edgeFenceCache = {
          frozen: edgeFenceCache?.frozen ?? false,
          checkedAt: Date.now() - Math.floor((EDGE_FENCE_TTL_MS * 3) / 4)
        };
      })().finally(() => {
        edgeFenceInFlight = null;
      });
    }
    await edgeFenceInFlight;
  }
  return edgeFenceCache?.frozen ?? false;
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
  session: { session_id: string; actor: string; started?: number | null; display_name?: string | null; expires_at: number; token_class: string; active_scope?: string | null; apikey_id?: string | null; focus_list?: string[] }
): Request {
  const headers = cleanInternalHeaders(request.headers);
  headers.set("x-woo-internal-session", session.session_id);
  headers.set("x-woo-internal-actor", session.actor);
  if (Number.isFinite(session.started) && session.started && session.started > 0) headers.set("x-woo-internal-started", String(session.started));
  if (session.display_name) headers.set("x-woo-internal-display-name", session.display_name);
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
      started: Number.isFinite(Number(body.started)) && Number(body.started) > 0 ? Number(body.started) : null,
      display_name: typeof body.display_name === "string" && body.display_name.length > 0 ? body.display_name : null,
      expires_at: Number(body.expires_at ?? Date.now() + 5 * 60_000),
      token_class: body.token_class === "guest" || body.token_class === "apikey" ? body.token_class : "bearer",
      active_scope: sessionActiveScope(body),
      current_location: sessionActiveScope(body),
      apikey_id: typeof body.apikey_id === "string" && body.apikey_id.length > 0 ? body.apikey_id : null
    });
    // Auth-time actor route registration. Previously hard-coded
    // host=WORLD_HOST regardless of where the actor actually lives —
    // for apikey-bound block actors (the_horoscope, the_weather)
    // that overwrote the block's self-host route on every cold plug
    // auth. Skip the write if Directory already has a non-WORLD route
    // for this actor (its actual host has registered it on cold-load).
    // Default to WORLD only when no route exists yet (newly-minted
    // guest actors). See review finding "P1: Plug cold auth can
    // overwrite the new self-host route back to world."
    const existing = await resolveDirectoryObject(env, body.actor, WORLD_HOST);
    if (existing.host === WORLD_HOST) {
      await directoryPost(env, "/register-objects", {
        routes: [{ id: body.actor, host: WORLD_HOST, anchor: null }]
      });
    }
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
    started: session.started ?? null,
    display_name: session.display_name ?? null,
    expires_at: session.expires_at,
    token_class: session.token_class,
    active_scope: room,
    current_location: room,
    apikey_id: session.apikey_id ?? null,
    focus_list: session.focus_list ?? []
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

async function resolveRequestSession(env: Env, request: Request): Promise<{ session_id: string; actor: string; started?: number | null; display_name?: string | null; expires_at: number; token_class: string; active_scope?: string | null; current_location?: string | null; apikey_id?: string | null; focus_list?: string[] } | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Session\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  return resolveSessionId(env, match[1]);
}

async function resolveSessionId(env: Env, sessionId: string): Promise<{ session_id: string; actor: string; started?: number | null; display_name?: string | null; expires_at: number; token_class: string; active_scope?: string | null; current_location?: string | null; apikey_id?: string | null; focus_list?: string[] } | null> {
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
      started: Number.isFinite(Number(record.started)) && Number(record.started) > 0 ? Number(record.started) : null,
      display_name: typeof record.display_name === "string" && record.display_name.length > 0 ? record.display_name : null,
      expires_at: Number(record.expires_at ?? 0),
      token_class: typeof record.token_class === "string" ? record.token_class : "bearer",
      active_scope: activeScope,
      current_location: activeScope,
      apikey_id: typeof record.apikey_id === "string" && record.apikey_id.length > 0 ? record.apikey_id : null,
      focus_list: Array.isArray(record.focus_list)
        ? record.focus_list.filter((item): item is string => typeof item === "string" && item.length > 0)
        : []
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

export function cleanInternalHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  for (const name of Array.from(headers.keys())) {
    const lower = name.toLowerCase();
    if (lower.startsWith("x-woo-internal-") || lower === "x-woo-host-key" || lower === "x-woo-task-chain" || lower === "x-woo-impersonate-actor") {
      // x-woo-task-chain is behavior-bearing on the receiver (it can
      // bypass the host queue when matched against the running task's
      // chain id; see WooWorld.hostDispatch). The gateway mints fresh
      // chain ids in forwardInternalRaw — public clients have no
      // legitimate use for the header and it must not survive the
      // public→internal trust boundary.
      // x-woo-impersonate-actor is also behavior-bearing. The REST
      // protocol still enforces wizard authority if the header reaches a
      // DO through an internal path, but public gateway requests must use
      // the JSON `actor` field so a browser/client cannot smuggle authority
      // through an ambient header.
      headers.delete(name);
    }
  }
  return headers;
}

function sanitizePublicHeaders(request: Request): Request {
  const headers = cleanInternalHeaders(request.headers);
  return new Request(request, { headers });
}

/** The one GATEWAY_NET shard serving the whole /net-api client surface.
 *
 * Sharding decision (Phase 4 item 2, documented): ONE stable shard for
 * now. A session cell installs into the MINTING gateway's derived view,
 * and /net-api/turn validates the session from that same view — so mint
 * and turn must land on the same DO. Hash-sharding by session id (the v2
 * MCP idiom, forwardToMcpGateway above) needs a session→cluster
 * resolution story first (session ids carry no lineage, CO14), so a
 * non-minting shard could pull the cell on miss; that lands with the
 * Phase-4/5 scale work, not here. */
const NET_API_GATEWAY_SHARD = "net-api";

/**
 * Phase-4 client surface: forward /net-api/* to the stable GATEWAY_NET
 * shard. The gateway DO authenticates the client credential itself; this
 * hop only enforces the public JSON body cap (the same idiom as every
 * public route) and never signs the request.
 */
async function handleNetApi(request: Request, env: Env, url: URL): Promise<Response> {
  const netEnv = env as unknown as NetBindingsEnv;
  let stub;
  try {
    stub = resolveNetDestination(netEnv, `gateway:${NET_API_GATEWAY_SHARD}`);
  } catch (err) {
    return jsonResponse({ error: { code: "E_INTERNAL", message: errorMessage(err) } }, 500);
  }
  const target = new URL(`https://do${url.pathname}`);
  target.search = url.search;
  // An exception escaping the DO's fetch propagates as a THROW from
  // stub.fetch here (workerd semantics) — without this guard the client
  // sees an opaque runtime 500 with a non-JSON body. Normalize it.
  try {
    if (request.method === "GET") {
      // `new Request(target, request)` re-targets the URL while copying
      // method/headers from the inbound request — including the Upgrade
      // header, so GET /net-api/ws forwards as a real WebSocket upgrade
      // (the same posture as forwardToHost's v2 WS forwarding) and the
      // DO's 101 + webSocket response returns to the client unwrapped.
      return await stub.fetch(new Request(target, request));
    }
    const body = await readLimitedBody(request);
    return await stub.fetch(new Request(target, { method: request.method, headers: request.headers, body }));
  } catch (err) {
    return errorResponseFor(err);
  }
}

/**
 * Phase-3 lane surface (see the /net-smoke/ block in fetch above):
 *   {any method} /net-smoke/{scope|gateway}/<name>/<route...>
 *     → env.SCOPE_NET / env.GATEWAY_NET stub for <name>,
 *       signInternalRequest, forward as /net/<route...>, return the reply.
 * Query strings pass through (GET /net/cell?key=...). The internal-auth
 * signature is minted HERE — a caller cannot supply one — so the net DOs'
 * verifyInternalRequest posture is unchanged: this block is just a local
 * test doorway in front of the same signed surface the DOs already expose.
 */
async function handleNetSmoke(request: Request, env: Env, url: URL): Promise<Response> {
  if (env.WOO_AE_DATASET !== undefined) {
    // Deployed environment: refuse with a plain 404 (no hint the route exists).
    return jsonResponse({ error: { code: "E_OBJNF", message: `no such route: ${url.pathname}` } }, 404);
  }
  // H1(b): the doorway must NEVER be an unauthenticated seeding/admin
  // surface. The WOO_AE_DATASET 404 above hides it on the deploy
  // profile, but a reachable environment that merely lacked that var
  // would expose /net/seed and friends to anyone. Require the internal
  // signature on the INBOUND request too — the local proving lanes hold
  // WOO_INTERNAL_SECRET and sign (net-smoke-harness.ts); nobody else can.
  // Defense in depth: both the deploy-404 AND the signature gate. NOTE:
  // `request` here is the RAW pre-sanitize request (the fetch entry hands
  // it in specifically for this check); the sanitized copy has no
  // signature headers. Safe because the fresh forward below never
  // propagates an inbound header to the DO — see the fetch-entry comment.
  const netEnvForAuth = env as unknown as NetBindingsEnv;
  try {
    await verifyInternalRequest(netEnvForAuth, request);
  } catch (err) {
    return jsonResponse({ error: { code: "E_NOSESSION", message: `net-smoke requires a signed internal request: ${errorMessage(err)}` } }, 401);
  }
  const parts = url.pathname.split("/").filter(Boolean); // ["net-smoke", kind, name, ...route]
  const kind = parts[1];
  const name = parts[2];
  const route = parts.slice(3).map((part) => decodeURIComponent(part)).join("/");
  if ((kind !== "scope" && kind !== "gateway") || !name || !route) {
    return jsonResponse({ error: { code: "E_INVARG", message: "expected /net-smoke/{scope|gateway}/<name>/<route...>" } }, 404);
  }
  // SCOPE_NET/GATEWAY_NET are bound in every wrangler config but the v2 Env
  // type does not declare them (the v2 freeze); the structural
  // NetBindingsEnv slice is the honest view of what this block needs.
  const netEnv = env as unknown as NetBindingsEnv;
  let stub;
  try {
    stub = resolveNetDestination(netEnv, `${kind}:${name}`);
  } catch (err) {
    return jsonResponse({ error: { code: "E_INTERNAL", message: errorMessage(err) } }, 500);
  }
  const target = new URL(`https://do/net/${route}`);
  target.search = url.search;
  let forward: Request;
  if (request.method === "GET") {
    forward = new Request(target);
  } else {
    // Cap the body read (fix 8c): an unbounded arrayBuffer() on a
    // local-lane doorway is still an unbounded buffer. The bound is
    // larger than the public JSON cap because /net/seed legitimately
    // carries a full bootstrap-world cell closure (~1.1 MiB today) — a
    // state transfer, not a turn envelope. readLimitedBody throws
    // E_RATE past the cap (→ 429 via errorResponseFor).
    let body: ArrayBuffer;
    try {
      body = await readLimitedBody(request, NET_SMOKE_MAX_BODY_BYTES);
    } catch (err) {
      return errorResponseFor(err);
    }
    forward = new Request(target, {
      method: request.method,
      headers: { "content-type": "application/json" },
      body
    });
  }
  const signed = await signInternalRequest(netEnv, forward);
  return stub.fetch(signed);
}

/**
 * Cutover item A: the production install doorway —
 * `POST /net-install/scope/<name>/seed` and
 * `GET  /net-install/scope/<name>/head`.
 *
 * Trust model: the inbound internal SIGNATURE is the gate (verified on
 * the RAW pre-sanitize request — H1b; the operator running the cutover
 * holds WOO_INTERNAL_SECRET). The surface is deliberately narrower than
 * /net-smoke: scope DOs only, and ONLY the two install verbs — `seed`
 * (idempotent by the M9 epoch guard: same-epoch re-seed no-ops,
 * different-epoch refuses, so a crashed install re-runs safely) and
 * `head` (the verification probe). Everything else about a live world —
 * subscribe, pull, turns — happens through the normal production
 * surfaces, so nothing here can become a second admin path. The forward
 * is freshly built and freshly signed; no inbound header propagates.
 */
async function handleNetInstall(request: Request, env: Env, url: URL): Promise<Response> {
  const netEnv = env as unknown as NetBindingsEnv;
  try {
    await verifyInternalRequest(netEnv, request);
  } catch (err) {
    return jsonResponse(
      { error: { code: "E_NOSESSION", message: `net-install requires a signed internal request: ${errorMessage(err)}` } },
      401
    );
  }
  const parts = url.pathname.split("/").filter(Boolean); // ["net-install", "scope", name, verb]
  // Cutover item B: the identity-export fetch — the ONE read the §8
  // sequence takes from OLD prod. Forwarded freshly-signed to the world
  // host's internal export route (read-only; runs against the frozen
  // world — both freeze gates exempt signed internal traffic).
  // Finding 6: the acknowledged write fence — persist/clear the freeze
  // generation at the world authority (POST {generation: string|null}).
  if (parts.length === 2 && parts[1] === "freeze" && request.method === "POST") {
    let body: ArrayBuffer;
    try {
      body = await readLimitedBody(request, MAX_JSON_BODY_BYTES);
    } catch (err) {
      return errorResponseFor(err);
    }
    const forward = new Request(`${INTERNAL_ORIGIN}/__internal/freeze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body
    });
    const response = await forwardToHost(env, WORLD_HOST, forward);
    // The isolate that acknowledged the fence must see it immediately
    // (and tests must not leak a TTL'd verdict across harnesses).
    if (response.ok) edgeFenceCache = null;
    return response;
  }
  if (parts.length === 2 && parts[1] === "identity-export" && request.method === "GET") {
    // `?allow-unfrozen=1` is the REHEARSAL override for the export
    // route's freeze-first refusal (see the /__internal/identity-export
    // handler); a real cutover export never passes it.
    const allowUnfrozen = url.searchParams.get("allow-unfrozen") === "1";
    const forward = new Request(`${INTERNAL_ORIGIN}/__internal/identity-export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(allowUnfrozen ? { allow_unfrozen: true } : {})
    });
    return forwardToHost(env, WORLD_HOST, forward);
  }
  const kind = parts[1];
  const name = parts[2] === undefined ? "" : decodeURIComponent(parts[2]);
  const verb = parts[3];
  const allowed =
    (verb === "seed" && request.method === "POST") ||
    (verb === "head" && request.method === "GET") ||
    // The NC1 activation state machine (reviewer finding 1): activation
    // and deactivation are a dedicated signed op, never a seed — seeds
    // refuse once a scope has committed.
    (verb === "activate" && request.method === "POST");
  if (kind !== "scope" || !name || parts.length !== 4 || !allowed) {
    return jsonResponse(
      {
        error: {
          code: "E_INVARG",
          message:
            "expected POST /net-install/scope/<name>/seed, POST /net-install/scope/<name>/activate, GET /net-install/scope/<name>/head, or GET /net-install/identity-export"
        }
      },
      404
    );
  }
  let stub;
  try {
    stub = resolveNetDestination(netEnv, `scope:${name}`);
  } catch (err) {
    return jsonResponse({ error: { code: "E_INTERNAL", message: errorMessage(err) } }, 500);
  }
  const target = new URL(`https://do/net/${verb}`);
  let forward: Request;
  if (request.method === "GET") {
    forward = new Request(target);
  } else {
    // Same bounded-body discipline as the smoke doorway: a seed carries a
    // scope's full cell partition — a state transfer, not a turn envelope.
    let body: ArrayBuffer;
    try {
      body = await readLimitedBody(request, NET_SMOKE_MAX_BODY_BYTES);
    } catch (err) {
      return errorResponseFor(err);
    }
    forward = new Request(target, { method: "POST", headers: { "content-type": "application/json" }, body });
  }
  const signed = await signInternalRequest(netEnv, forward);
  return stub.fetch(signed);
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

async function readLimitedBody(request: Request, maxBytes = MAX_JSON_BODY_BYTES): Promise<ArrayBuffer> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw wooError("E_RATE", `request body exceeds ${maxBytes} bytes`);
  const body = await request.arrayBuffer();
  if (body.byteLength > maxBytes) throw wooError("E_RATE", `request body exceeds ${maxBytes} bytes`);
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

/** Map a thrown WooError (or other) into the public REST error envelope.
 * Used at the Worker entry's routing boundary; once a request reaches a
 * DO, core/protocol.ts normalizes errors there. Status map mirrors the
 * REST protocol: rate-limit/quota -> 429, internal -> 500, perms -> 403,
 * not-found -> 404, default -> 500. */
function errorResponseFor(err: unknown): Response {
  const error = err && typeof err === "object" && "code" in err
    ? err as { code: string; message?: string; value?: unknown }
    : { code: "E_INTERNAL", message: errorMessage(err) };
  const status = (() => {
    switch (error.code) {
      case "E_RATE": return 429;
      case "E_PERM": return 403;
      case "E_OBJNF":
      case "E_VERBNF":
      case "E_PROPNF": return 404;
      case "E_RETRY": return 503;
      case "E_INVARG": return 400;
      case "E_NOSESSION": return 401;
      default: return 500;
    }
  })();
  return jsonResponse({ error }, status);
}
