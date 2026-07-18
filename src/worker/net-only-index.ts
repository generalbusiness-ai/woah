/**
 * Net-only Worker entry.
 *
 * This is the executable v2-removal gate: it serves the production net client,
 * public MCP alias, install doorway, health probe, and SPA without importing or
 * exporting PersistentObjectDO, DirectoryDO, CommitScopeDO, the v2 MCP gateway,
 * or the v2 browser transport. Keep this entry independently bundleable; the
 * dual-stack entry remains the rollback vehicle until cutover bake completes.
 */
import { wooError } from "../core/types";
import { cellKey, type CellTransfer } from "../net/cells";
import { handleAdmin, type AdminEnv } from "./admin";
import { signInternalRequest, verifyInternalRequest } from "./internal-auth";
import { parseNetGatewayShardCount, routeNetGateway } from "./net/gateway-routing";
import { resolveNetDestination, type NetBindingsEnv } from "./net/workerd-host";

export { NetGatewayDO } from "./net/gateway-do";
export { NetScopeDO } from "./net/scope-do";

// AdminEnv carries only operator secrets + Analytics Engine vars; the dashboard
// needs no WORLD binding (its live routes hit AE directly and the classic guest
// purge is Net-retired to 410). Including it keeps `/admin` operable on the
// Net-only entry without importing PersistentObjectDO.
export type NetOnlyEnv = NetBindingsEnv & AdminEnv & {
  ASSETS?: Fetcher;
  NET_API_GATEWAY_SHARDS?: string;
};

const MAX_JSON_BODY_BYTES = 1 * 1024 * 1024;
const MAX_INSTALL_BODY_BYTES = 8 * 1024 * 1024;
const CATALOG_SCOPE = "catalog";

export default {
  async fetch(request: Request, env: NetOnlyEnv): Promise<Response> {
    const url = new URL(request.url);
    const install = url.pathname.startsWith("/net-install/");
    const raw = install ? request.clone() : request;
    request = sanitizePublicHeaders(request);

    if (url.pathname.startsWith("/__internal/")) {
      return json({ error: wooError("E_NOSESSION", "internal routes require a signed internal request") }, 401);
    }
    if (request.method === "GET" && url.pathname === "/client-config") {
      return json({ net: true }, 200, { "cache-control": "no-store" });
    }
    if (request.method === "GET" && url.pathname === "/healthz") return netHealth(env);
    if (url.pathname.startsWith("/net-api/")) return handleNetApi(request, env, url);
    if (url.pathname === "/mcp") {
      const alias = new URL(url);
      alias.pathname = "/net-api/mcp";
      return handleNetApi(request, env, alias);
    }
    if (install) return handleNetInstall(raw, env, url);

    // Operator dashboard. Must be matched before the asset fallback or `/admin`
    // silently serves the SPA shell. Its live routes (series/footprint) read
    // Analytics Engine directly and the guest purge is Net-retired (410), so no
    // WORLD binding is required here.
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return handleAdmin(request, env, url);
    }

    // These paths cannot silently reappear through the asset fallback after
    // the legacy DO classes are removed.
    if (url.pathname === "/connect" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/v2/")) {
      return json({ error: { code: "E_OBJNF", message: "legacy surface retired" } }, 410);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return json({ error: { code: "E_OBJNF", message: `no such route: ${url.pathname}` } }, 404);
  }
};

async function netHealth(env: NetOnlyEnv): Promise<Response> {
  try {
    const stub = resolveNetDestination(env, `scope:${CATALOG_SCOPE}`);
    const probe = await signInternalRequest(env, new Request("https://do/net/head"));
    const response = await stub.fetch(probe);
    const catalog = (await response.json()) as { catalog_epoch?: unknown };
    if (!response.ok || typeof catalog.catalog_epoch !== "string") {
      return json({ ok: false, net: true, reason: "catalog_unavailable", catalog }, 503);
    }

    // A reachable seeded DO is still INSTALLING until the authority's
    // activation cell matches its catalog epoch. Health is used for route
    // admission, so it must enforce the same fail-closed state as gateways.
    const key = cellKey("property_cell", "$system", "net_active_epoch");
    const closureRequest = new Request("https://do/net/closure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: [key], known: [] })
    });
    const closureResponse = await stub.fetch(await signInternalRequest(env, closureRequest));
    const closure = (await closureResponse.json()) as CellTransfer;
    const activation = closure.cells?.find((cell) => cell.key === key)?.value as { value?: unknown } | undefined;
    if (!closureResponse.ok || activation?.value !== catalog.catalog_epoch) {
      return json({
        ok: false,
        net: true,
        reason: activation?.value == null ? "not_active" : "epoch_mismatch",
        catalog_epoch: catalog.catalog_epoch,
        active_epoch: activation?.value ?? null
      }, 503);
    }
    return json({ ok: true, net: true, catalog });
  } catch (error) {
    return json({ ok: false, net: true, error: errorMessage(error) }, 503);
  }
}

async function handleNetApi(request: Request, env: NetOnlyEnv, url: URL): Promise<Response> {
  const target = new URL(`https://do${url.pathname}`);
  target.search = url.search;
  try {
    const body = request.method === "GET" ? undefined : await readLimitedBody(request, MAX_JSON_BODY_BYTES);
    const bodyText = body === undefined ? undefined : new TextDecoder().decode(body);
    const shard = routeNetGateway({
      pathname: url.pathname,
      searchParams: url.searchParams,
      headers: request.headers,
      ...(bodyText !== undefined ? { bodyText } : {}),
      shardCount: parseNetGatewayShardCount(env.NET_API_GATEWAY_SHARDS),
      anonymousKey: crypto.randomUUID()
    });
    const stub = resolveNetDestination(env, `gateway:${shard}`);
    if (request.method === "GET") return await stub.fetch(new Request(target, request));
    return await stub.fetch(new Request(target, { method: request.method, headers: request.headers, body }));
  } catch (error) {
    return publicError(error);
  }
}

async function handleNetInstall(request: Request, env: NetOnlyEnv, url: URL): Promise<Response> {
  try {
    await verifyInternalRequest(env, request);
  } catch (error) {
    return json({ error: { code: "E_NOSESSION", message: `net-install requires a signed internal request: ${errorMessage(error)}` } }, 401);
  }
  const parts = url.pathname.split("/").filter(Boolean);
  // Match the dual-stack doorway: prove the secret through a freshly signed
  // catalog-DO hop before an operator is allowed to mutate install state.
  if (parts.length === 2 && parts[1] === "probe" && request.method === "GET") {
    try {
      const stub = resolveNetDestination(env, `scope:${CATALOG_SCOPE}`);
      return await stub.fetch(await signInternalRequest(env, new Request("https://do/net/probe")));
    } catch (error) {
      return publicError(error);
    }
  }
  if (parts.length === 2 && (parts[1] === "identity-export" || parts[1] === "freeze")) {
    return json({ error: { code: "E_OBJNF", message: "v2 migration doorway retired after cutover" } }, 410);
  }
  const name = parts[2] === undefined ? "" : decodeURIComponent(parts[2]);
  const verb = parts[3];
  const allowed =
    parts[1] === "scope" && parts.length === 4 && Boolean(name) &&
    ((request.method === "POST" && (verb === "seed" || verb === "activate" || verb === "repair-relations" || verb === "repair-definitions")) || (request.method === "GET" && verb === "head"));
  if (!allowed) {
    return json({ error: { code: "E_INVARG", message: "expected a signed net install probe, scope seed, activate, repair-relations, repair-definitions, or head operation" } }, 404);
  }
  try {
    const stub = resolveNetDestination(env, `scope:${name}`);
    const target = new URL(`https://do/net/${verb}`);
    const forward = request.method === "GET"
      ? new Request(target)
      : new Request(target, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: await readLimitedBody(request, MAX_INSTALL_BODY_BYTES)
        });
    return await stub.fetch(await signInternalRequest(env, forward));
  } catch (error) {
    return publicError(error);
  }
}

function sanitizePublicHeaders(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    const lower = name.toLowerCase();
    if (lower.startsWith("x-woo-internal-") || lower === "x-woo-host-key" || lower === "x-woo-task-chain" || lower === "x-woo-impersonate-actor") {
      headers.delete(name);
    }
  }
  return new Request(request, { headers });
}

async function readLimitedBody(request: Request, maxBytes: number): Promise<ArrayBuffer> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw wooError("E_RATE", `request body exceeds ${maxBytes} bytes`);
  const body = await request.arrayBuffer();
  if (body.byteLength > maxBytes) throw wooError("E_RATE", `request body exceeds ${maxBytes} bytes`);
  return body;
}

function publicError(error: unknown): Response {
  const value = error && typeof error === "object" && "code" in error
    ? error as { code: string; message?: string }
    : { code: "E_INTERNAL", message: errorMessage(error) };
  const status = value.code === "E_RATE" ? 429 : value.code === "E_INVARG" ? 400 : 500;
  return json({ error: value }, status);
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
}
