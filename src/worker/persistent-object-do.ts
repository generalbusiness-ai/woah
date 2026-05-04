// PersistentObjectDO — Cloudflare host for the world gateway or an anchor cluster.
//
// The "world" host remains the gateway for auth, WebSockets, global
// catalog/admin surfaces, and bundled state aggregation. Directory-routed
// anchor clusters use the same storage schema, but initialize from a
// host-scoped world slice exported by the gateway: hosted objects, their
// parent/feature/bytecode support objects, hosted logs, snapshots, and tasks.
// They do not auto-install the bundled catalogs or claim independent bootstrap
// authority, but they do apply host-scoped catalog migration plans and data
// migrations for the objects they actually own.
//
// What's wired through fetch() / the WS handlers:
// - REST routing ported from src/server/dev-server.ts: auth, describe (with
//   actor-permission filtering), property reads (filtered), sequenced and
//   direct verb calls (with broadcast to connected WS clients), log paging,
//   /api/state (authenticated demo aggregate).
// - WebSocket upgrade with the CF hibernation API: state.acceptWebSocket,
//   serializeAttachment for per-socket {sessionId, actor, socketId}, and
//   webSocketMessage/Close/Error handlers. After DO wake-from-hibernation
//   getWorld() rehydrates session.attachedSockets from state.getWebSockets()
//   so reap doesn't expire active clients.
//
// What's still deferred to later phases:
// - Alarms for parked tasks (Phase 4): state.storage.setAlarm + alarm()
//   handler. Needed for FORK/SUSPEND wakeups on CF.
// - SSE streams (/api/objects/{id}/stream) — return 501. Browser uses WS;
//   SSE matters for HTTP-only agent integrations.
// - Authoring REST endpoints (/api/compile, /api/install, /api/property,
//   /api/property/value, /api/authoring/objects/{create,move,chparent}) — the
//   IDE tab can read on CF but not author.
// - Private GitHub tap auth/cache policy — public GitHub taps are wired;
//   private repos and content-hash caching are deferred.

import { createWorld, createWorldFromSerialized, mergeHostScopedSeed, nonEmptyHostScopedWorld } from "../core/bootstrap";
import { parseAutoInstallCatalogs, runHostScopedLocalCatalogLifecycle } from "../core/local-catalogs";
import {
  handleRestProtocolRequest,
  handleWsProtocolFrame,
  parseWsProtocolFrame,
  statusForError,
  type RestProtocolRequest
} from "../core/protocol";
import type { MetricEvent, ObjRef, Observation, RemoteToolDescriptor, Session, WooValue } from "../core/types";
import { directedRecipients, wooError } from "../core/types";
import type { AppliedFrame, DirectResultFrame, ErrorFrame, LiveEventFrame, Message } from "../core/types";
import type { SerializedWorld } from "../core/repository";
import { createHostOperationMemo, normalizeError, type ParkedTaskRun } from "../core/world";
import { installGitHubTap, updateGitHubTap, type CatalogTapLogEvent } from "../core/catalog-taps";
import { CFObjectRepository } from "./cf-repository";
import { McpGateway } from "../mcp/gateway";
import { signInternalRequest, verifyInternalRequest } from "./internal-auth";

// Re-import WooWorld type. Note `import type` must reach the world module
// without dragging Node-only deps into the Worker bundle.
import type { CallContext, DeferredHostEffect, HostBridge, HostObjectSummary, HostOperationMemo, MoveObjectResult, WooWorld } from "../core/world";

export interface Env {
  WOO: DurableObjectNamespace;
  DIRECTORY: DurableObjectNamespace;
  ASSETS?: Fetcher;
  WOO_INITIAL_WIZARD_TOKEN?: string;
  WOO_INTERNAL_SECRET?: string;
  WOO_AUTO_INSTALL_CATALOGS?: string;
}

const WORLD_HOST = "world";
const DIRECTORY_HOST = "directory";
const INTERNAL_ORIGIN = "https://woo.internal";
const MAX_JSON_BODY_BYTES = 1 * 1024 * 1024;
const METRIC_SAMPLE_BUDGET = 10;
const METRIC_SAMPLE_WINDOW_MS = 1000;
const HOST_STATE_CACHE_LIMIT = 32;

export class PersistentObjectDO {
  private state: DurableObjectState;
  private env: Env;
  private repo: CFObjectRepository;
  private world: WooWorld | null = null;
  private routeCache = new Map<ObjRef, string>();
  private publishedRoutes = new Map<ObjRef, string>();
  private routesRegistered = false;
  private mcpGateway: McpGateway | null = null;
  // Per-actor cache of `world.state(actor)` keyed by world.mutationVersion().
  // Both /__internal/state and the local-host slice inside aggregateState
  // hit this; a cache hit returns instantly without re-walking the object
  // graph. Cleared implicitly on DO restart (cold init wipes the Map).
  private hostStateCache = new Map<ObjRef, { version: number; payload: Record<string, unknown> }>();
  // Cross-host property cache for stable, hot-path property reads
  // (actor.name in a verb that runs on a different host's DO is a common
  // case). Keyed by `${host}|${objRef}|${name}`. Only entries for
  // CROSS_HOST_STABLE_PROPS are populated; everything else still pays the
  // RPC. TTL-based with a hard cap to bound memory.
  private crossHostPropCache = new Map<string, { value: unknown; expiresAt: number }>();
  private static readonly CROSS_HOST_STABLE_PROPS = new Set(["name", "description", "aliases"]);
  private static readonly CROSS_HOST_PROP_TTL_MS = 30_000;
  private static readonly CROSS_HOST_PROP_CACHE_MAX = 1024;
  // Actor -> live WebSocket set on this DO. Avoids the per-broadcast
  // state.getWebSockets() scan: broadcast iterates the audience's actors
  // (from world.presenceActorsIn) and looks up sockets directly. Built
  // on rehydrate and maintained on attach/detach.
  private socketsByActor = new Map<ObjRef, Set<WebSocket>>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.repo = new CFObjectRepository(state);
  }

  async fetch(request: Request): Promise<Response> {
    // Operator-bootstrap precondition check (cloudflare.md §R14.7).
    if (!this.env.WOO_INITIAL_WIZARD_TOKEN) {
      return jsonResponse(
        { error: { code: "E_BOOTSTRAP_TOKEN_MISSING", message: "set WOO_INITIAL_WIZARD_TOKEN via wrangler secret put" } },
        503
      );
    }
    if (!this.env.WOO_INTERNAL_SECRET) {
      return jsonResponse(
        { error: { code: "E_BOOTSTRAP_TOKEN_MISSING", message: "set WOO_INTERNAL_SECRET via wrangler secret put" } },
        503
      );
    }

    const url = new URL(request.url);
    const pathname = url.pathname;
    const hostKey = request.headers.get("x-woo-host-key") || this.durableHostKey();
    const gatewayHost = hostKey === WORLD_HOST;
    const internalRequest = pathname.startsWith("/__internal/");

    if (internalRequest) await verifyInternalRequest(this.env, request);

    if (!gatewayHost && (pathname === "/api/auth" || pathname === "/ws")) {
      return jsonResponse({ error: { code: "E_NOTAPPLICABLE", message: `${pathname} is only available on the world gateway host` } }, 404);
    }

    try {
      const world = await this.getWorld(hostKey);

      if (internalRequest) {
        return await this.handleInternal(request, world, pathname);
      }

      // WebSocket upgrade — accept via hibernation API. The connection survives
      // DO hibernation; per-socket state is in serializeAttachment(). Per
      // cloudflare.md §R8.
      if (pathname === "/ws") {
        const upgrade = request.headers.get("upgrade");
        if (upgrade?.toLowerCase() !== "websocket") {
          return jsonResponse({ error: { code: "E_INVARG", message: "expected Upgrade: websocket" } }, 400);
        }
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        this.state.acceptWebSocket(server);
        return new Response(null, { status: 101, webSocket: client });
      }

      if (request.method === "GET" && pathname === "/healthz") {
        return jsonResponse({ ok: true, ts: Date.now(), objects: world.objects.size });
      }

      // MCP streamable-HTTP transport (spec/protocol/mcp.md). Only on the
      // gateway host: agent sessions live here alongside human WebSockets.
      if (gatewayHost && pathname === "/mcp") {
        const gateway = this.getMcpGateway(world);
        return await gateway.handle(request);
      }

      const protocol = await handleRestProtocolRequest(workerRestRequest(request, pathname), {
        world,
        authenticateToken: (token) => this.authenticateToken(world, token),
        requireSession: () => this.requireRestSession(world, request),
        state: (actor) => this.aggregateState(world, actor),
        installTap: async (actor, body) => {
          if (!gatewayHost) throw wooError("E_NOTAPPLICABLE", "GitHub tap install is only available on the world gateway host");
          return await installGitHubTap(world, actor, {
            tap: String(body.tap ?? ""),
            catalog: String(body.catalog ?? ""),
            ref: typeof body.ref === "string" ? body.ref : undefined,
            as: typeof body.as === "string" ? body.as : undefined
          }, {
            hashText: workerHashText,
            log: (event) => logCatalogTapEvent(event)
          });
        },
        updateTap: async (actor, body) => {
          if (!gatewayHost) throw wooError("E_NOTAPPLICABLE", "GitHub tap update is only available on the world gateway host");
          return await updateGitHubTap(world, actor, {
            tap: String(body.tap ?? ""),
            catalog: String(body.catalog ?? ""),
            ref: typeof body.ref === "string" ? body.ref : undefined,
            as: typeof body.as === "string" ? body.as : undefined,
            accept_major: body.accept_major === true
          }, {
            hashText: workerHashText,
            log: (event) => logCatalogTapEvent(event)
          });
        },
        resolveObject: (id, session) => this.resolveRestObject(world, id, session),
        resolveActor: (_protocolRequest, actorValue, session) => this.resolveRestActor(world, request, actorValue, session),
        directCall: async (id, actor, target, verb, args, options) => {
          const deferredHostEffects: DeferredHostEffect[] = [];
          const result = await world.directCall(id, actor, target, verb, args, {
            ...options,
            deferHostEffect: (effect) => deferredHostEffects.push(effect)
          });
          if (deferredHostEffects.length > 0) await world.applyDeferredHostEffects(deferredHostEffects);
          return result;
        },
        broadcastApplied: (frame) => this.handleAppliedFrame(world, frame),
        broadcastLiveEvents: (result) => this.broadcastLiveEvents(world, result)
      });
      if (protocol.handled) {
        if ("raw" in protocol) {
          return jsonResponse({ error: { code: "E_NOT_IMPLEMENTED", message: "raw REST response not supported on CF Worker" } }, 501);
        }
        return jsonResponse(protocol.body, protocol.status);
      }

      return jsonResponse({ error: { code: "E_OBJNF", message: `no route for ${request.method} ${pathname}` } }, 404);
    } catch (err) {
      const error = normalizeError(err);
      return jsonResponse({ error }, statusForError(error));
    }
  }

  // ---- world lifecycle ----

  /**
   * Lazy-init the in-memory WooWorld. The gateway host runs normal bootstrap
   * and catalog auto-install; cluster hosts load/prune a host-scoped serialized
   * world and write that slice through the same repository path.
   *
   * The init is wrapped in blockConcurrencyWhile to ensure no fetch handler
   * interleaves with the bootstrap; once init completes, the same `world`
   * instance handles all subsequent requests until DO hibernation.
   */
  private durableHostKey(): string {
    return this.state.id.name ?? WORLD_HOST;
  }

  private getMcpGateway(world: WooWorld): McpGateway {
    if (!this.mcpGateway) {
      const initStart = Date.now();
      this.mcpGateway = new McpGateway(world, {
        serverName: "woo",
        dispatch: {
          call: async (sessionId, actor, space, message) => {
            const session = { sessionId, actor };
            const host = await this.resolveObjectHost(space, WORLD_HOST);
            const result = host === WORLD_HOST
              ? await world.call(undefined, sessionId, space, message)
              : await this.forwardWsCall(world, host, undefined, session, space, message);
            if (result.op === "applied" && host !== WORLD_HOST) await this.registerRemoteObjectRoutes(host);
            return result;
          },
          direct: async (sessionId, actor, target, verb, args) => {
            const session = { sessionId, actor };
            const host = await this.resolveObjectHost(target, WORLD_HOST);
            return host === WORLD_HOST
              ? await world.directCall(undefined, actor, target, verb, args)
              : await this.forwardWsDirect(world, host, undefined, session, target, verb, args);
          }
        },
        broadcasts: {
          broadcastApplied: (frame, originSessionId) => this.handleAppliedFrame(world, frame, undefined, originSessionId),
          broadcastLiveEvents: (result, originSessionId) => this.broadcastLiveEvents(world, result, originSessionId)
        }
      });
      world.recordMetric({ kind: "init", phase: "mcp_gateway", ms: Date.now() - initStart });
    }
    return this.mcpGateway;
  }

  private async getWorld(hostKey = this.durableHostKey()): Promise<WooWorld> {
    if (this.world) {
      if (hostKey === WORLD_HOST) await this.registerObjectRoutes(this.world);
      return this.world;
    }
    let initialized: WooWorld | null = null;
    let coldInitStart: number | null = null;
    await this.state.blockConcurrencyWhile(async () => {
      if (this.world) {
        initialized = this.world;
        return;
      }
      coldInitStart = Date.now();
      const world = hostKey === WORLD_HOST
        ? createWorld({ repository: this.repo, catalogs: parseAutoInstallCatalogs(this.env.WOO_AUTO_INSTALL_CATALOGS) })
        : await this.createHostScopedWorld(hostKey as ObjRef);
      this.installHostBridge(world, hostKey);
      // Rehydrate live WebSocket attachments. After DO wake-from-hibernation,
      // state.getWebSockets() returns sockets whose serializeAttachment
      // payload survived hibernation; the in-memory world.sessions, however,
      // is freshly hydrated from storage with empty attachedSockets sets
      // (hydrateSession in world.ts:1256). Re-attach each surviving socket
      // so presence-filtered broadcasts reach those clients again and the
      // session reap path doesn't expire actively-connected sessions.
      this.socketsByActor.clear();
      for (const ws of this.state.getWebSockets()) {
        const att = this.attachment(ws);
        if (att && world.sessions?.has(att.sessionId)) {
          world.attachSocket(att.sessionId, att.socketId);
          this.indexAddSocket(att.actor, ws);
        }
      }
      this.world = world;
      initialized = world;
    });
    const world = initialized!;
    if (coldInitStart !== null) {
      world.recordMetric({ kind: "init", phase: "world", ms: Date.now() - coldInitStart });
    }
    if (hostKey === WORLD_HOST) await this.registerObjectRoutes(world);
    return world;
  }

  private async createHostScopedWorld(hostKey: ObjRef): Promise<WooWorld> {
    const stored = this.repo.load();
    let scoped = stored ? nonEmptyHostScopedWorld(stored, hostKey) : null;
    if (stored && !scoped) {
      console.warn("woo.cluster_seed_fallback", {
        host: hostKey,
        reason: "stored_world_missing_host_slice",
        stored_objects: stored.objects.length,
        stored_logs: stored.logs.length,
        stored_tasks: stored.parkedTasks.length
      });
    }
    let freshSeed: SerializedWorld | null = null;
    try {
      freshSeed = nonEmptyHostScopedWorld(await this.fetchHostSeed(hostKey), hostKey);
    } catch (err) {
      if (!scoped) throw err;
      console.warn("woo.cluster_seed_refresh_failed", { host: hostKey, error: normalizeError(err) });
    }
    if (scoped && freshSeed) scoped = mergeHostScopedSeed(scoped, freshSeed);
    if (!scoped) scoped = freshSeed;
    if (!scoped) throw wooError("E_OBJNF", `no host-scoped seed for ${hostKey}`, hostKey);
    const world = createWorldFromSerialized(scoped, { repository: this.repo });
    // Run local catalog schema/data migration plans on this host's actual
    // slice. The gateway cannot convert state it does not own.
    runHostScopedLocalCatalogLifecycle(world, hostKey, { freshSeed: stored === null });
    this.scrubStaleSubscribersOnce(world);
    return world;
  }

  // One-shot wipe of accumulated subscriber lists on cluster $space objects
  // that rely on explicit enter/leave (i.e. not auto_presence). Stale entries
  // built up before cross-host session-reap cleanup landed; live clients
  // re-enter on next focus. Gated per-space so it only runs once per object
  // across reboots.
  private scrubStaleSubscribersOnce(world: WooWorld): void {
    for (const id of Array.from(world.objects.keys())) {
      const nextSeq = world.propOrNull(id, "next_seq");
      if (typeof nextSeq !== "number") continue;
      if (world.propOrNull(id, "auto_presence") === true) continue;
      if (world.propOrNull(id, "_subscribers_scrubbed_v1") === true) continue;
      const subscribers = world.propOrNull(id, "subscribers");
      if (Array.isArray(subscribers) && subscribers.length > 0) {
        try { world.setProp(id, "subscribers", []); } catch { continue; }
      }
      try { world.setProp(id, "_subscribers_scrubbed_v1", true); } catch { /* read-only */ }
    }
  }

  private async fetchHostSeed(hostKey: ObjRef): Promise<SerializedWorld> {
    const id = this.env.WOO.idFromName(WORLD_HOST);
    const request = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}/__internal/host-seed`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-woo-host-key": WORLD_HOST
      },
      body: JSON.stringify({ host: hostKey })
    }));
    const response = await this.env.WOO.get(id).fetch(request);
    const body = await response.json();
    if (!response.ok) throw wooError("E_STORAGE", `failed to load host seed for ${hostKey}`, body as WooValue);
    return body as SerializedWorld;
  }

  private async registerObjectRoutes(world: WooWorld): Promise<void> {
    if (this.routesRegistered) return;
    const ok = await this.registerRoutes(world.objectRoutes());
    if (ok) this.routesRegistered = true;
  }

  private async registerIncrementalObjectRoutes(world: WooWorld): Promise<void> {
    const routes = world.objectRoutes().filter((route) => this.publishedRoutes.get(route.id) !== route.host);
    await this.registerRoutes(routes);
  }

  private async registerRoutes(routes: Array<{ id: ObjRef; host: string; anchor: ObjRef | null }>): Promise<boolean> {
    if (routes.length === 0) return true;
    try {
      const id = this.env.DIRECTORY.idFromName(DIRECTORY_HOST);
      const request = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}/register-objects`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ routes })
      }));
      const response = await this.env.DIRECTORY.get(id).fetch(request);
      if (!response.ok) throw new Error(`Directory register-objects failed: ${response.status}`);
      for (const route of routes) {
        this.routeCache.set(route.id, route.host);
        this.publishedRoutes.set(route.id, route.host);
      }
      return true;
    } catch {
      // Directory acceleration is best-effort. Fallback routing still sends
      // unknown objects to the world host or the caller-provided space host.
      return false;
    }
  }

  private installHostBridge(world: WooWorld, localHost: string): void {
    const hostForObjectUncached = async (id: ObjRef): Promise<string | null> => {
      const cached = this.routeCache.get(id);
      if (cached) return cached;
      const route = world.objectRoutes().find((item) => item.id === id);
      if (route) {
        this.routeCache.set(id, route.host);
        return route.host;
      }
      if (localHost === WORLD_HOST && world.objects.has(id)) return localHost;
      const resolved = await this.resolveObjectHost(id, "");
      return resolved || null;
    };
    const hostForObject = async (id: ObjRef, memo?: HostOperationMemo): Promise<string | null> => {
      if (!memo) return await hostForObjectUncached(id);
      return await memoizeHostOperation(memo.routes, id, () => hostForObjectUncached(id));
    };
    const bridge: HostBridge = {
      localHost,
      hostForObject,
      getPropChecked: async (progr, objRef, name, memo) => {
        const read = async (): Promise<WooValue> => {
          const host = await hostForObject(objRef, memo);
          if (!host || host === localHost) return await world.getPropChecked(progr, objRef, name, memo);
          const cacheable = PersistentObjectDO.CROSS_HOST_STABLE_PROPS.has(name);
          const cacheKey = cacheable ? `${host}|${objRef}|${name}` : null;
          if (cacheKey !== null) {
            const cached = this.crossHostPropCache.get(cacheKey);
            if (cached && cached.expiresAt > Date.now()) return cached.value as WooValue;
          }
          const response = await this.forwardInternalChecked<{ value: WooValue }>(host, "/__internal/remote-get-prop", { progr, obj: objRef, name });
          if (cacheKey !== null) {
            if (this.crossHostPropCache.size >= PersistentObjectDO.CROSS_HOST_PROP_CACHE_MAX) {
              const firstKey = this.crossHostPropCache.keys().next().value;
              if (firstKey !== undefined) this.crossHostPropCache.delete(firstKey);
            }
            this.crossHostPropCache.set(cacheKey, { value: response.value, expiresAt: Date.now() + PersistentObjectDO.CROSS_HOST_PROP_TTL_MS });
          }
          return response.value;
        };
        if (memo) return await memoizeHostOperation(memo.reads, `prop:${progr}:${objRef}:${name}`, read);
        return await read();
      },
      describeObject: async (nameActor, readActor, objRef, memo) => {
        const read = async () => {
          const host = await hostForObject(objRef, memo);
          if (!host || host === localHost) {
            return {
              name: world.object(objRef).name,
              description: world.propOrNullForActor(readActor, objRef, "description"),
              aliases: world.propOrNullForActor(readActor, objRef, "aliases")
            };
          }
          return await this.forwardInternalChecked<{ name: WooValue | null; description: WooValue | null; aliases: WooValue | null }>(
            host,
            "/__internal/remote-describe",
            { name_actor: nameActor, read_actor: readActor, obj: objRef }
          );
        };
        if (memo) return await memoizeHostOperation(memo.reads, `describe:${nameActor}:${readActor}:${objRef}`, read);
        return await read();
      },
      describeObjects: async (nameActor, readActor, objRefs, memo) => {
        const out: Record<ObjRef, HostObjectSummary> = {};
        const missingByHost = new Map<string, ObjRef[]>();
        for (const objRef of objRefs) {
          const key = `describe:${nameActor}:${readActor}:${objRef}`;
          const cached = memo?.reads.get(key) as Promise<HostObjectSummary> | undefined;
          if (cached) {
            out[objRef] = await cached;
            continue;
          }
          const host = await hostForObject(objRef, memo);
          if (!host || host === localHost) {
            const summary = {
              name: world.object(objRef).name,
              description: world.propOrNullForActor(readActor, objRef, "description"),
              aliases: world.propOrNullForActor(readActor, objRef, "aliases")
            };
            out[objRef] = summary;
            if (memo) memo.reads.set(key, Promise.resolve(summary));
            continue;
          }
          const list = missingByHost.get(host) ?? [];
          list.push(objRef);
          missingByHost.set(host, list);
        }
        await Promise.all(Array.from(missingByHost, async ([host, ids]) => {
          const response = await this.forwardInternalChecked<{ objects: Record<ObjRef, HostObjectSummary> }>(
            host,
            "/__internal/remote-describe-many",
            { name_actor: nameActor, read_actor: readActor, ids }
          );
          for (const id of ids) {
            const summary = response.objects?.[id];
            if (!summary) continue;
            out[id] = summary;
            if (memo) memo.reads.set(`describe:${nameActor}:${readActor}:${id}`, Promise.resolve(summary));
          }
        }));
        return out;
      },
      resolveVerb: async (target, verbName, memo) => {
        const read = async () => {
          const host = await hostForObject(target, memo);
          if (!host || host === localHost) {
            const { verb } = world.resolveVerb(target, verbName);
            return { name: verb.name, direct_callable: verb.direct_callable === true };
          }
          return await this.forwardInternalChecked<{ name: string; direct_callable: boolean }>(
            host,
            "/__internal/remote-resolve-verb",
            { target, verb: verbName }
          );
        };
        if (memo) return await memoizeHostOperation(memo.reads, `verb:${target}:${verbName}`, read);
        return await read();
      },
      location: async (objRef, memo) => {
        const read = async (): Promise<ObjRef | null> => {
          const host = await hostForObject(objRef, memo);
          if (!host || host === localHost) return world.object(objRef).location;
          const response = await this.forwardInternalChecked<{ location: ObjRef | null }>(host, "/__internal/remote-location", { obj: objRef });
          return response.location;
        };
        if (memo) return await memoizeHostOperation(memo.reads, `location:${objRef}`, read);
        return await read();
      },
      dispatch: async (ctx, target, verbName, args, startAt) => {
        const host = await hostForObject(startAt ?? target, ctx.hostMemo);
        if (!host || host === localHost) return await world.hostDispatch(ctx, target, verbName, args, startAt);
        const response = await this.forwardInternalChecked<{
          result: WooValue;
          observations?: Observation[];
          audience_actors?: ObjRef[];
          observation_audiences?: ObjRef[][];
          deferred_host_effects?: DeferredHostEffect[];
        }>(host, "/__internal/remote-dispatch", {
          ctx: this.serializedCallContext(ctx),
          target,
          verb: verbName,
          args,
          start_at: startAt ?? null
        });
        if (Array.isArray(response.observations)) {
          for (const observation of response.observations) ctx.observations.push(observation);
        }
        // Surface authoritative audience info from the source DO so the
        // gateway's directCallNow uses it instead of recomputing from stale
        // local state.
        if (response.audience_actors || response.observation_audiences) {
          (ctx as { crossHostAudience?: { audienceActors?: ObjRef[]; observationAudiences?: ObjRef[][] } }).crossHostAudience = {
            audienceActors: response.audience_actors,
            observationAudiences: response.observation_audiences
          };
        }
        if (Array.isArray(response.deferred_host_effects)) {
          if (ctx.deferHostEffect) {
            for (const effect of response.deferred_host_effects) ctx.deferHostEffect(effect);
          } else {
            await world.applyDeferredHostEffects(response.deferred_host_effects);
          }
        }
        return response.result;
      },
      moveObject: async (objRef, targetRef, options = {}) => {
        const host = await hostForObject(objRef);
        if (!host || host === localHost) {
          return await world.moveObjectChecked(objRef, targetRef, options);
        }
        const suppressMirrorHost = options.suppressMirrorHost ?? localHost;
        const response = await this.forwardInternalChecked<{ ok: true; old_location?: ObjRef | null; location?: ObjRef }>(host, "/__internal/remote-move-object", {
          obj: objRef,
          target: targetRef,
          suppress_mirror_host: suppressMirrorHost
        });
        const result: MoveObjectResult = {
          oldLocation: typeof response.old_location === "string" ? response.old_location : null,
          location: typeof response.location === "string" ? response.location : targetRef
        };
        // If this host owns either affected container, the object owner
        // suppresses mirror RPCs back here to avoid A→B→A subrequest
        // recursion. Update this host's contents caches after the
        // authoritative owner-location write succeeds.
        if (suppressMirrorHost === localHost) {
          if (result.oldLocation && await hostForObject(result.oldLocation) === localHost && world.objects.has(result.oldLocation)) {
            world.mirrorContents(result.oldLocation, objRef, false);
          }
          if (await hostForObject(result.location) === localHost && world.objects.has(result.location)) {
            world.mirrorContents(result.location, objRef, true);
          }
        }
        return result;
      },
      mirrorContents: async (containerRef, objRef, present) => {
        const host = await hostForObject(containerRef);
        if (!host || host === localHost) {
          world.mirrorContents(containerRef, objRef, present);
          return;
        }
        await this.forwardInternalChecked(host, "/__internal/mirror-contents", { container: containerRef, obj: objRef, present });
      },
      setActorPresence: async (actor, space, present) => {
        const host = await hostForObject(actor);
        if (!host || host === localHost) {
          world.setActorPresence(actor, space, present);
          return;
        }
        await this.forwardInternalChecked(host, "/__internal/actor-presence", { actor, space, present });
      },
      setSpaceSubscriber: async (space, actor, present) => {
        const host = await hostForObject(space);
        if (!host || host === localHost) {
          world.setSpaceSubscriber(space, actor, present);
          return;
        }
        await this.forwardInternalChecked(host, "/__internal/space-subscriber", { space, actor, present });
      },
      contents: async (objRef, memo) => {
        const read = async (): Promise<ObjRef[]> => {
          const host = await hostForObject(objRef, memo);
          if (!host || host === localHost) return world.contentsOf(objRef);
          const response = await this.forwardInternalChecked<{ contents: ObjRef[] }>(host, "/__internal/contents", { obj: objRef });
          return response.contents;
        };
        if (memo) return await memoizeHostOperation(memo.reads, `contents:${objRef}`, read);
        return await read();
      },
      enumerateRemoteTools: async (actor, ids) => {
        // Group ids by owning host, RPC each, merge.
        const byHost = new Map<string, ObjRef[]>();
        for (const id of ids) {
          const host = await hostForObject(id);
          if (!host || host === localHost) continue;
          const list = byHost.get(host) ?? [];
          list.push(id);
          byHost.set(host, list);
        }
        if (byHost.size === 0) return [];
        const responses = await Promise.all(
          Array.from(byHost, async ([host, hostIds]) => {
            try {
              const response = await this.forwardInternalChecked<{ tools: RemoteToolDescriptor[] }>(host, "/__internal/enumerate-tools", { actor, ids: hostIds });
              const tools = response.tools ?? [];
              // Returned descriptors include runtime-minted objects (tasks
              // created on the cluster) that the directory may not know about
              // yet. Record the responding host as their route so a follow-up
              // tool call dispatches without an extra lookup.
              for (const tool of tools) {
                if (!this.routeCache.has(tool.object)) this.routeCache.set(tool.object, host);
              }
              return tools;
            } catch {
              return [] as RemoteToolDescriptor[];
            }
          })
        );
        return responses.flat();
      }
    };
    world.setHostBridge(bridge);
    world.setMetricsHook((event) => this.emitMetric(event, localHost));
  }

  // Sample high-rate metric kinds so a noisy gateway doesn't blow up the log
  // pipeline. `applied`, `direct_call`, and `compose_look` already have
  // natural 1-per-call bounds; `broadcast` and `cross_host_rpc` can fire many
  // times per call so we cap each kind at SAMPLE_BUDGET per SAMPLE_WINDOW_MS
  // and emit a periodic dropped-count summary.
  private emitMetric(event: MetricEvent, hostKey: string): void {
    if (event.kind === "broadcast" || event.kind === "cross_host_rpc" || event.kind === "storage_direct_write") {
      const counter = this.metricSampleCounters[event.kind];
      const now = Date.now();
      if (now - counter.windowStart >= METRIC_SAMPLE_WINDOW_MS) {
        if (counter.dropped > 0) {
          console.log("woo.metric", JSON.stringify({ kind: `${event.kind}_dropped`, count: counter.dropped, ms_window: METRIC_SAMPLE_WINDOW_MS, ts: now, host_key: hostKey }));
        }
        counter.windowStart = now;
        counter.emitted = 0;
        counter.dropped = 0;
      }
      if (counter.emitted >= METRIC_SAMPLE_BUDGET) {
        counter.dropped += 1;
        return;
      }
      counter.emitted += 1;
    }
    console.log("woo.metric", JSON.stringify({ ...event, ts: Date.now(), host_key: hostKey }));
  }

  private metricSampleCounters: Record<"broadcast" | "cross_host_rpc" | "storage_direct_write", { windowStart: number; emitted: number; dropped: number }> = {
    broadcast: { windowStart: 0, emitted: 0, dropped: 0 },
    cross_host_rpc: { windowStart: 0, emitted: 0, dropped: 0 },
    storage_direct_write: { windowStart: 0, emitted: 0, dropped: 0 }
  };

  private serializedCallContext(ctx: CallContext): Record<string, unknown> {
    return {
      space: ctx.space,
      seq: ctx.seq,
      actor: ctx.actor,
      player: ctx.player,
      caller: ctx.caller,
      callerPerms: ctx.callerPerms,
      progr: ctx.progr,
      thisObj: ctx.thisObj,
      verbName: ctx.verbName,
      definer: ctx.definer,
      message: ctx.message,
      moveto_stack: ctx.movetoStack ? Array.from(ctx.movetoStack) : []
    };
  }

  private async registerRemoteObjectRoutes(host: string): Promise<void> {
    try {
      const routes = await this.forwardInternal<Array<{ id: ObjRef; host: string; anchor: ObjRef | null }>>(host, "/__internal/object-routes", {});
      await this.registerRoutes(routes.filter((route) => route.host === host));
    } catch {
      // The applied frame is already durable on the target host; route
      // registration can be retried by a later state read or call.
    }
  }

  private cachedHostState(world: WooWorld, actor: ObjRef): Record<string, unknown> {
    const version = world.mutationVersion();
    const hit = this.hostStateCache.get(actor);
    // Clone on read so callers (notably aggregateState, which reassigns
    // state.object_routes / state.spaces / state.objects) can't mutate the
    // cached copy. structuredClone on a ~127KB plain object is much cheaper
    // than rebuilding state via the full object-graph walk.
    if (hit && hit.version === version) {
      this.hostStateCache.delete(actor);
      this.hostStateCache.set(actor, hit);
      return this.withFreshStateClock(structuredClone(hit.payload));
    }
    const payload = world.state(actor) as unknown as Record<string, unknown>;
    this.hostStateCache.delete(actor);
    this.hostStateCache.set(actor, { version, payload: structuredClone(payload) });
    while (this.hostStateCache.size > HOST_STATE_CACHE_LIMIT) {
      const oldest = this.hostStateCache.keys().next().value as ObjRef | undefined;
      if (!oldest) break;
      this.hostStateCache.delete(oldest);
    }
    return this.withFreshStateClock(payload);
  }

  private withFreshStateClock(payload: Record<string, unknown>): Record<string, unknown> {
    // Mutates only the response object being returned. On cache hits that is a
    // clone of the cached payload; on misses the cache already stored its own
    // clone before this clock field is stamped.
    payload.server_time = Date.now();
    return payload;
  }

  private async aggregateState(world: WooWorld, actor: ObjRef): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const result = await this.aggregateStateInner(world, actor);
    world.recordMetric({
      kind: "state_projection",
      ms: Date.now() - startedAt,
      objects: Object.keys((result.objects ?? {}) as Record<string, unknown>).length,
      remote_hosts: Array.isArray(result.object_routes) ? new Set((result.object_routes as Array<{ host?: string }>).map((r) => r.host ?? "").filter(Boolean)).size : 0
    });
    return result;
  }

  private async aggregateStateInner(world: WooWorld, actor: ObjRef): Promise<Record<string, unknown>> {
    const state = this.cachedHostState(world, actor);
    const routes = Array.isArray(state.object_routes)
      ? state.object_routes.filter((route): route is { id: string; host: string; anchor: string | null } => (
          route !== null &&
          typeof route === "object" &&
          !Array.isArray(route) &&
          typeof (route as Record<string, unknown>).id === "string" &&
          typeof (route as Record<string, unknown>).host === "string"
        ))
      : [];
    const remoteHosts = Array.from(new Set(routes.map((route) => route.host).filter((host) => host && host !== WORLD_HOST)));
    // Fan out to every remote host in parallel; each /__internal/state takes
    // O(per-host-state-compose) so a serial loop turns into O(N × that). The
    // merge below is purely local object-reshape, so awaiting all fetches up
    // front collapses the wall time to roughly max-host-latency.
    const fetched = await Promise.all(
      remoteHosts.map((host) => this.fetchHostState(host, actor).then((remote) => ({ host, remote })))
    );
    for (const { host, remote } of fetched) {
      if (!remote) continue;
      const remoteRoutes = Array.isArray(remote.object_routes)
        ? remote.object_routes.filter((route): route is { id: string; host: string; anchor: string | null } => (
            route !== null &&
            typeof route === "object" &&
            !Array.isArray(route) &&
            typeof (route as Record<string, unknown>).id === "string" &&
            (route as Record<string, unknown>).host === host
          ))
        : [];
      const hostRoutes = [...routes.filter((route) => route.host === host), ...remoteRoutes];
      state.object_routes = uniqueRoutes([...(Array.isArray(state.object_routes) ? state.object_routes as Array<{ id: string; host: string; anchor: string | null }> : []), ...remoteRoutes]);
      const routeIds = new Set(hostRoutes.map((route) => route.id));
      const spaces = { ...readMap(state.spaces) };
      for (const id of routeIds) {
        const remoteSpace = readMap(remote.spaces)[id];
        if (remoteSpace) spaces[id] = remoteSpace;
      }
      state.spaces = spaces;
      const objects = { ...readMap(state.objects) };
      const remoteObjects = readMap(remote.objects);
      for (const id of routeIds) {
        if (remoteObjects[id]) objects[id] = remoteObjects[id];
      }
      state.objects = objects;
    }
    return state;
  }

  private async fetchHostState(host: string, actor: ObjRef): Promise<Record<string, unknown> | null> {
    try {
      const id = this.env.WOO.idFromName(host);
      const request = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}/__internal/state`, {
        headers: { "x-woo-host-key": host, "x-woo-internal-actor": actor }
      }));
      const response = await this.env.WOO.get(id).fetch(request);
      if (!response.ok) return null;
      const body = await response.json();
      return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  private async handleInternal(request: Request, world: WooWorld, pathname: string): Promise<Response> {
    try {
      if (request.method === "GET" && pathname === "/__internal/state") {
        const actor = request.headers.get("x-woo-internal-actor");
        return jsonResponse(actor ? this.cachedHostState(world, actor as ObjRef) : world.state());
      }

      const body = await readJsonBody(request);
      if (request.method === "POST" && pathname === "/__internal/object-routes") {
        return jsonResponse(world.objectRoutes());
      }

      if (request.method === "POST" && pathname === "/__internal/host-seed") {
        const host = String(body.host ?? "") as ObjRef;
        if (!host) throw wooError("E_INVARG", "host-seed requires host");
        return jsonResponse(world.exportHostScopedWorld(host));
      }

      if (request.method === "POST" && pathname === "/__internal/broadcast-applied") {
        const frame = body.frame && typeof body.frame === "object" && !Array.isArray(body.frame)
          ? body.frame as AppliedFrame
          : null;
        if (!frame || frame.op !== "applied") throw wooError("E_INVARG", "broadcast-applied requires an applied frame");
        this.broadcastApplied(world, frame);
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && pathname === "/__internal/broadcast-live-events") {
        const audience = String(body.audience ?? "") as ObjRef;
        const audienceActors = Array.isArray(body.audience_actors)
          ? body.audience_actors.filter((item): item is ObjRef => typeof item === "string")
          : undefined;
        const observationAudiences = Array.isArray(body.observation_audiences)
          ? body.observation_audiences.map((audience) => (
              Array.isArray(audience) ? audience.filter((item): item is ObjRef => typeof item === "string") : []
            ))
          : undefined;
        const observations = Array.isArray(body.observations)
          ? body.observations.filter((item): item is Record<string, WooValue> & { type: string } => (
              item !== null &&
              typeof item === "object" &&
              !Array.isArray(item) &&
              typeof (item as Record<string, unknown>).type === "string"
            ))
          : [];
        if (!audience) throw wooError("E_INVARG", "broadcast-live-events requires audience");
        this.broadcastLiveEvents(world, { op: "result", result: null, observations, audience, audienceActors, observationAudiences });
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && pathname === "/__internal/ws-call") {
        const session = this.ensureInternalSession(
          world,
          String(body.session_id ?? ""),
          String(body.actor ?? "") as ObjRef,
          Number(body.expires_at ?? 0),
          body.token_class
        );
        const raw = body.message && typeof body.message === "object" && !Array.isArray(body.message)
          ? body.message as Record<string, unknown>
          : {};
        const message: Message = {
          actor: session.actor,
          target: String(raw.target ?? "") as ObjRef,
          verb: String(raw.verb ?? ""),
          args: Array.isArray(raw.args) ? raw.args as WooValue[] : [],
          body: raw.body && typeof raw.body === "object" && !Array.isArray(raw.body)
            ? raw.body as Record<string, WooValue>
            : undefined
        };
        return jsonResponse(await world.call(typeof body.frame_id === "string" ? body.frame_id : undefined, session.id, String(body.space ?? "") as ObjRef, message));
      }

      if (request.method === "POST" && pathname === "/__internal/ws-direct") {
        const session = this.ensureInternalSession(
          world,
          String(body.session_id ?? ""),
          String(body.actor ?? "") as ObjRef,
          Number(body.expires_at ?? 0),
          body.token_class
        );
        const deferredHostEffects: DeferredHostEffect[] = [];
        const result = await world.directCall(
          typeof body.frame_id === "string" ? body.frame_id : undefined,
          session.actor,
          String(body.target ?? "") as ObjRef,
          String(body.verb ?? ""),
          Array.isArray(body.args) ? body.args as WooValue[] : [],
          { deferHostEffect: (effect) => deferredHostEffects.push(effect) }
        );
        return jsonResponse(result.op === "result" ? { ...result, deferred_host_effects: deferredHostEffects } : result);
      }

      if (request.method === "POST" && pathname === "/__internal/replay") {
        const session = this.ensureInternalSession(
          world,
          String(body.session_id ?? ""),
          String(body.actor ?? "") as ObjRef,
          Number(body.expires_at ?? 0),
          body.token_class
        );
        const space = String(body.space ?? "") as ObjRef;
        if (!world.hasPresence(session.actor, space)) throw wooError("E_PERM", `${session.actor} is not present in ${space}`);
        const from = Math.max(1, Number(body.from ?? 1));
        const limit = Math.min(Math.max(1, Number(body.limit ?? 100)), 500);
        return jsonResponse({ op: "replay", id: body.frame_id, space, from, entries: world.replay(space, from, limit) });
      }

      if (request.method === "POST" && pathname === "/__internal/remote-get-prop") {
        const progr = String(body.progr ?? "") as ObjRef;
        const obj = String(body.obj ?? "") as ObjRef;
        const name = String(body.name ?? "");
        return jsonResponse({ value: await world.getPropChecked(progr, obj, name) });
      }

      if (request.method === "POST" && pathname === "/__internal/remote-describe") {
        const readActor = String(body.read_actor ?? "") as ObjRef;
        const obj = String(body.obj ?? "") as ObjRef;
        return jsonResponse({
          name: world.object(obj).name,
          description: world.propOrNullForActor(readActor, obj, "description"),
          aliases: world.propOrNullForActor(readActor, obj, "aliases")
        });
      }

      if (request.method === "POST" && pathname === "/__internal/remote-describe-many") {
        const readActor = String(body.read_actor ?? "") as ObjRef;
        const ids = Array.isArray(body.ids) ? body.ids.filter((item): item is ObjRef => typeof item === "string") : [];
        const objects: Record<ObjRef, HostObjectSummary> = {};
        for (const obj of ids) {
          try {
            objects[obj] = {
              name: world.object(obj).name,
              description: world.propOrNullForActor(readActor, obj, "description"),
              aliases: world.propOrNullForActor(readActor, obj, "aliases")
            };
          } catch {
            // A stale route should not poison the whole batch; callers can
            // fall back to id-only matching/rendering for missing entries.
          }
        }
        return jsonResponse({ objects });
      }

      if (request.method === "POST" && pathname === "/__internal/remote-resolve-verb") {
        const target = String(body.target ?? "") as ObjRef;
        const verbName = String(body.verb ?? "");
        const { verb } = world.resolveVerb(target, verbName);
        return jsonResponse({ name: verb.name, direct_callable: verb.direct_callable === true });
      }

      if (request.method === "POST" && pathname === "/__internal/remote-location") {
        const obj = String(body.obj ?? "") as ObjRef;
        return jsonResponse({ location: world.object(obj).location });
      }

      if (request.method === "POST" && pathname === "/__internal/remote-dispatch") {
        const rawCtx = body.ctx && typeof body.ctx === "object" && !Array.isArray(body.ctx)
          ? body.ctx as Record<string, unknown>
          : {};
        const target = String(body.target ?? "") as ObjRef;
        const verb = String(body.verb ?? "");
        const args = Array.isArray(body.args) ? body.args as WooValue[] : [];
        const startAt = typeof body.start_at === "string" ? body.start_at as ObjRef : null;
        const observations: Observation[] = [];
        const actor = String(rawCtx.actor ?? "") as ObjRef;
        const player = String(rawCtx.player ?? actor) as ObjRef;
        if (actor) this.ensureInternalActor(world, actor);
        if (player) this.ensureInternalActor(world, player);
        const message = rawCtx.message && typeof rawCtx.message === "object" && !Array.isArray(rawCtx.message)
          ? rawCtx.message as Message
          : { actor, target, verb, args };
        const deferredHostEffects: DeferredHostEffect[] = [];
        const ctx: CallContext = {
          world,
          space: String(rawCtx.space ?? "#-1") as ObjRef,
          seq: Number(rawCtx.seq ?? -1),
          actor,
          player,
          caller: String(rawCtx.caller ?? "#-1") as ObjRef,
          callerPerms: String(rawCtx.callerPerms ?? rawCtx.progr ?? actor) as ObjRef,
          progr: String(rawCtx.progr ?? actor) as ObjRef,
          thisObj: String(rawCtx.thisObj ?? target) as ObjRef,
          verbName: String(rawCtx.verbName ?? verb),
          definer: String(rawCtx.definer ?? target) as ObjRef,
          message,
          observations,
          hostMemo: createHostOperationMemo(),
          movetoStack: Array.isArray(rawCtx.moveto_stack)
            ? new Set(rawCtx.moveto_stack.filter((item): item is string => typeof item === "string"))
            : undefined,
          observe: (event) => {
            observations.push({ ...event, source: event.source ?? String(rawCtx.space ?? "#-1") });
          },
          deferHostEffect: (effect) => deferredHostEffects.push(effect)
        };
        const result = await world.hostDispatch(ctx, target, verb, args, startAt);
        // Compute audience here using this DO's authoritative subscribers; the
        // gateway's local view of a self-hosted space is stale and would
        // mis-filter the WS/MCP fan-out. Returned to the caller so the
        // gateway's broadcastLiveEvents has accurate audience information.
        const audiences = world.computeDirectLiveAudiences(target, observations);
        return jsonResponse({
          result,
          observations,
          audience_actors: audiences.audienceActors,
          observation_audiences: audiences.observationAudiences,
          deferred_host_effects: deferredHostEffects
        });
      }

      if (request.method === "POST" && pathname === "/__internal/remote-move-object") {
        const suppressMirrorHost = typeof body.suppress_mirror_host === "string" ? body.suppress_mirror_host : null;
        const result = await world.moveObjectChecked(
          String(body.obj ?? "") as ObjRef,
          String(body.target ?? "") as ObjRef,
          { suppressMirrorHost }
        );
        return jsonResponse({ ok: true, old_location: result.oldLocation, location: result.location });
      }

      if (request.method === "POST" && pathname === "/__internal/mirror-contents") {
        world.mirrorContents(
          String(body.container ?? "") as ObjRef,
          String(body.obj ?? "") as ObjRef,
          body.present === true
        );
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && pathname === "/__internal/actor-presence") {
        world.setActorPresence(
          String(body.actor ?? "") as ObjRef,
          String(body.space ?? "") as ObjRef,
          body.present === true
        );
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && pathname === "/__internal/space-subscriber") {
        world.setSpaceSubscriber(
          String(body.space ?? "") as ObjRef,
          String(body.actor ?? "") as ObjRef,
          body.present === true
        );
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && pathname === "/__internal/contents") {
        return jsonResponse({ contents: world.contentsOf(String(body.obj ?? "") as ObjRef) });
      }

      if (request.method === "POST" && pathname === "/__internal/enumerate-tools") {
        const actor = String(body.actor ?? "") as ObjRef;
        const ids = Array.isArray(body.ids) ? (body.ids as string[]).filter((id) => typeof id === "string") as ObjRef[] : [];
        if (actor) this.ensureInternalActor(world, actor);
        const tools = this.getMcpGateway(world).host.enumerateLocalToolDescriptors(actor, ids);
        return jsonResponse({ tools });
      }

      return jsonResponse({ error: { code: "E_OBJNF", message: `no internal route for ${request.method} ${pathname}` } }, 404);
    } catch (err) {
      const error = normalizeError(err);
      return jsonResponse({ error }, statusForError(error));
    }
  }

  private ensureInternalSession(
    world: WooWorld,
    sessionId: string,
    actor: ObjRef,
    expiresAt: number,
    rawTokenClass: unknown
  ): Session {
    if (!sessionId || !actor) throw wooError("E_NOSESSION", "internal forwarded call requires session and actor");
    this.ensureInternalActor(world, actor);
    const tokenClass: Session["tokenClass"] = rawTokenClass === "guest" || rawTokenClass === "apikey" ? rawTokenClass : "bearer";
    return world.ensureSessionForActor(sessionId, actor, tokenClass, Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : undefined);
  }

  private ensureInternalActor(world: WooWorld, actor: ObjRef): void {
    if (world.objects.has(actor)) return;
    const parent = world.objects.has("$player") ? "$player" : world.objects.has("$actor") ? "$actor" : null;
    world.createObject({ id: actor, name: actor, parent, owner: actor });
    // No explicit property writes: `presence_in` already inherits the right
    // default (`[]`) from $actor, and writing it here just adds a redundant
    // per-actor row at every (actor × host) first-touch.
  }

  // ---- auth helpers (port from dev-server.ts) ----

  private authenticateToken(world: WooWorld, token: string): Session {
    if (token.startsWith("wizard:")) {
      return world.claimWizardBootstrapSession(token.slice("wizard:".length), this.env.WOO_INITIAL_WIZARD_TOKEN);
    }
    return world.auth(token);
  }

  private async registerSessionRoute(session: Session): Promise<void> {
    try {
      const id = this.env.DIRECTORY.idFromName(DIRECTORY_HOST);
      const request = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}/register-session`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          session_id: session.id,
          actor: session.actor,
          expires_at: session.expiresAt,
          token_class: session.tokenClass
        })
      }));
      await this.env.DIRECTORY.get(id).fetch(request);
      await this.registerRoutes([{ id: session.actor, host: WORLD_HOST, anchor: null }]);
    } catch {
      // Directory registration accelerates cross-DO routing. The local auth
      // result remains authoritative for this host; routed object calls fail
      // closed if the Directory cannot resolve the session.
    }
  }

  private requireRestSession(world: WooWorld, request: Request): Session {
    const internalSession = request.headers.get("x-woo-internal-session");
    const internalActor = request.headers.get("x-woo-internal-actor");
    if (internalSession && internalActor) {
      return this.ensureInternalSession(
        world,
        internalSession,
        internalActor as ObjRef,
        Number(request.headers.get("x-woo-internal-expires-at") ?? 0),
        request.headers.get("x-woo-internal-token-class")
      );
    }
    const header = request.headers.get("authorization") ?? "";
    const match = /^Session\s+(.+)$/i.exec(header.trim());
    if (!match) throw wooError("E_NOSESSION", "Authorization: Session <id> required");
    return world.auth(`session:${match[1]}`);
  }

  private resolveRestObject(world: WooWorld, id: string, session: Session): ObjRef {
    if (id === "$me") return session.actor;
    world.object(id);
    return id;
  }

  private resolveRestActor(world: WooWorld, request: Request, actorValue: unknown, session: Session): ObjRef {
    const impersonated = request.headers.get("x-woo-impersonate-actor");
    const requested = typeof impersonated === "string"
      ? impersonated
      : actorValue === undefined || actorValue === null || actorValue === "$me"
        ? session.actor
        : String(actorValue);
    if (requested === session.actor) return requested;
    if (world.object(session.actor).flags.wizard) {
      world.object(requested);
      world.recordWizardAction(session.actor, "impersonate", {
        actor: requested,
        via: typeof impersonated === "string" ? "REST X-Woo-Impersonate-Actor" : "REST actor field"
      });
      return requested;
    }
    throw wooError("E_PERM", "actor does not match session actor", { actor: requested, session_actor: session.actor });
  }

  // ---- WebSocket lifecycle (CF hibernation API) ----
  //
  // Each accepted ws carries a serialized attachment {sessionId, actor, socketId}
  // that survives DO hibernation. webSocketMessage() ports the WS frame
  // dispatch from src/server/dev-server.ts; broadcast helpers iterate
  // state.getWebSockets() for fan-out instead of an in-memory Map.

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const world = await this.getWorld();
    const frame = parseWsProtocolFrame(message);
    if (frame.op === "error") {
      ws.send(JSON.stringify(frame));
      return;
    }
    await handleWsProtocolFrame(ws, frame, {
      authenticate: async (token) => {
        const session = this.authenticateToken(world, token);
        await this.registerSessionRoute(session);
        return session;
      },
      attach: (_connection, session) => {
        const previous = this.attachment(ws);
        if (previous) {
          world.detachSocket(previous.sessionId, previous.socketId);
          this.indexRemoveSocket(previous.actor, ws);
        }
        const socketId = `ws-${session.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        world.attachSocket(session.id, socketId);
        ws.serializeAttachment({ sessionId: session.id, actor: session.actor, socketId });
        this.indexAddSocket(session.actor, ws);
      },
      session: () => this.liveAttachment(world, ws),
      send: (_connection, frameValue) => ws.send(JSON.stringify(frameValue)),
      call: async (frameId, session, space, messageValue) => {
        const host = await this.resolveObjectHost(space, WORLD_HOST);
        const result = host === WORLD_HOST
          ? await world.call(frameId, session.sessionId, space, messageValue)
          : await this.forwardWsCall(world, host, frameId, session, space, messageValue);
        if (result.op === "applied") {
          if (host !== WORLD_HOST) await this.registerRemoteObjectRoutes(host);
        }
        return result;
      },
      direct: async (frameId, session, target, verb, args) => {
        const host = await this.resolveObjectHost(target, WORLD_HOST);
        return host === WORLD_HOST
          ? await world.directCall(
              frameId,
              session.actor,
              target,
              verb,
              args
            )
          : await this.forwardWsDirect(world, host, frameId, session, target, verb, args);
      },
      replay: async (frameId, session, space, fromValue, limitValue) => {
        const host = await this.resolveObjectHost(space, WORLD_HOST);
        if (host !== WORLD_HOST) {
          return this.forwardWsReplay(world, host, frameId, session, space, fromValue, limitValue);
        }
        if (!world.hasPresence(session.actor, space)) throw wooError("E_PERM", `${session.actor} is not present in ${space}`);
        const from = Math.max(1, Number(fromValue ?? 1));
        const limit = Math.min(Math.max(1, Number(limitValue ?? 100)), 500);
        return { op: "replay", id: frameId, space, from, entries: world.replay(space, from, limit) };
      },
      deliverInput: (session, input) => world.deliverInput(session.actor, input),
      broadcastApplied: (frameValue, originator) => this.handleAppliedFrame(world, frameValue, originator),
      broadcastTaskResult: (result) => this.broadcastTaskResult(world, result),
      broadcastLiveEvents: (result) => this.broadcastLiveEvents(world, result)
    });
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const world = await this.getWorld();
    const att = this.attachment(ws);
    if (att) {
      world.detachSocket(att.sessionId, att.socketId);
      this.indexRemoveSocket(att.actor, ws);
    }
    try {
      ws.close();
    } catch {
      // ignore — already closed
    }
  }

  async webSocketError(ws: WebSocket, _err: unknown): Promise<void> {
    const world = await this.getWorld();
    const att = this.attachment(ws);
    if (att) {
      world.detachSocket(att.sessionId, att.socketId);
      this.indexRemoveSocket(att.actor, ws);
    }
  }

  private indexAddSocket(actor: ObjRef, ws: WebSocket): void {
    let set = this.socketsByActor.get(actor);
    if (!set) { set = new Set(); this.socketsByActor.set(actor, set); }
    set.add(ws);
  }

  private indexRemoveSocket(actor: ObjRef, ws: WebSocket): void {
    const set = this.socketsByActor.get(actor);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this.socketsByActor.delete(actor);
  }

  // ---- WS helpers ----

  private attachment(ws: WebSocket): { sessionId: string; actor: ObjRef; socketId: string } | null {
    const raw = ws.deserializeAttachment();
    if (!raw || typeof raw !== "object") return null;
    const a = raw as Record<string, unknown>;
    if (typeof a.sessionId !== "string" || typeof a.actor !== "string" || typeof a.socketId !== "string") return null;
    return { sessionId: a.sessionId, actor: a.actor as ObjRef, socketId: a.socketId };
  }

  private liveAttachment(world: WooWorld, ws: WebSocket): { sessionId: string; actor: ObjRef; socketId: string } | null {
    const att = this.attachment(ws);
    if (!att) return null;
    return world.sessionAlive(att.sessionId) ? att : null;
  }

  private async resolveObjectHost(id: ObjRef, fallbackHost: string): Promise<string> {
    const cached = this.routeCache.get(id);
    if (cached) return cached;
    try {
      const directoryId = this.env.DIRECTORY.idFromName(DIRECTORY_HOST);
      const request = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}/resolve-object`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ id, fallback_host: fallbackHost })
      }));
      const response = await this.env.DIRECTORY.get(directoryId).fetch(request);
      const body = await response.json() as Record<string, unknown>;
      const host = typeof body.host === "string" ? body.host : fallbackHost;
      this.routeCache.set(id, host);
      return host;
    } catch {
      return fallbackHost;
    }
  }

  private async forwardWsCall(
    world: WooWorld,
    host: string,
    frameId: string | undefined,
    session: { sessionId: string; actor: ObjRef },
    space: ObjRef,
    message: Message
  ): Promise<AppliedFrame | ErrorFrame> {
    const body = this.forwardBody(world, session, { frame_id: frameId, space, message });
    return this.forwardInternal<AppliedFrame | ErrorFrame>(host, "/__internal/ws-call", body);
  }

  private async forwardWsDirect(
    world: WooWorld,
    host: string,
    frameId: string | undefined,
    session: { sessionId: string; actor: ObjRef },
    target: ObjRef,
    verb: string,
    args: WooValue[]
  ): Promise<DirectResultFrame | ErrorFrame> {
    const body = this.forwardBody(world, session, { frame_id: frameId, target, verb, args });
    const result = await this.forwardInternal<((DirectResultFrame & { deferred_host_effects?: DeferredHostEffect[] }) | ErrorFrame)>(host, "/__internal/ws-direct", body);
    if (result.op === "result" && Array.isArray(result.deferred_host_effects)) {
      await world.applyDeferredHostEffects(result.deferred_host_effects);
      delete result.deferred_host_effects;
    }
    return result;
  }

  private async forwardWsReplay(
    world: WooWorld,
    host: string,
    frameId: string | undefined,
    session: { sessionId: string; actor: ObjRef },
    space: ObjRef,
    from: unknown,
    limit: unknown
  ): Promise<unknown> {
    const body = this.forwardBody(world, session, { frame_id: frameId, space, from, limit });
    return this.forwardInternal(host, "/__internal/replay", body);
  }

  private async forwardInternal<T>(host: string, path: string, body: Record<string, unknown>): Promise<T> {
    const id = this.env.WOO.idFromName(host);
    const request = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-woo-host-key": host
      },
      body: JSON.stringify(body)
    }));
    const startedAt = Date.now();
    const response = await this.env.WOO.get(id).fetch(request);
    const parsed = await response.json() as T;
    this.world?.recordMetric({ kind: "cross_host_rpc", route: path, host, ms: Date.now() - startedAt });
    return parsed;
  }

  private async forwardInternalChecked<T>(host: string, path: string, body: Record<string, unknown>): Promise<T> {
    const parsed = await this.forwardInternal<T | { error?: unknown }>(host, path, body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "error" in parsed && (parsed as { error?: unknown }).error) {
      throw normalizeError((parsed as { error: unknown }).error);
    }
    return parsed as T;
  }

  private forwardBody(
    world: WooWorld,
    session: { sessionId: string; actor: ObjRef },
    extra: Record<string, unknown>
  ): Record<string, unknown> {
    const local = world.sessions.get(session.sessionId);
    return {
      session_id: session.sessionId,
      actor: session.actor,
      expires_at: local?.expiresAt ?? Date.now() + 5 * 60_000,
      token_class: local?.tokenClass ?? "bearer",
      ...extra
    };
  }

  private broadcastApplied(world: WooWorld, frame: AppliedFrame, originator?: WebSocket, originMcpSessionId?: string | null): void {
    const startedAt = Date.now();
    const data = JSON.stringify(frame);
    const dataNoId = JSON.stringify({ ...frame, id: undefined });
    let audienceSize = 0;
    const audience = world.presenceActorsIn(frame.space);
    if (audience) {
      for (const actor of audience) {
        const sockets = this.socketsByActor.get(actor);
        if (!sockets) continue;
        for (const ws of sockets) {
          audienceSize += 1;
          try {
            ws.send(ws === originator ? data : dataNoId);
          } catch {
            // socket gone; webSocketClose will clean up
          }
        }
      }
    }
    this.mcpGateway?.routeAppliedFrame(frame, originMcpSessionId ?? null);
    world.recordMetric({ kind: "broadcast", audience_size: audienceSize, obs_count: frame.observations.length, ms: Date.now() - startedAt });
  }

  private async handleAppliedFrame(world: WooWorld, frame: AppliedFrame, originator?: WebSocket, originMcpSessionId?: string | null): Promise<void> {
    if (this.durableHostKey() === WORLD_HOST) await this.registerIncrementalObjectRoutes(world);
    this.broadcastApplied(world, frame, originator, originMcpSessionId);
  }

  private broadcastTaskResult(world: WooWorld, result: ParkedTaskRun): void {
    if (result.frame?.op === "applied") {
      this.broadcastApplied(world, result.frame);
      return;
    }
    const space = taskResultSpace(result);
    const data = JSON.stringify({ op: "task", task: result.task.id, space, observations: result.observations });
    const audience = world.presenceActorsIn(space);
    if (!audience) return;
    for (const actor of audience) {
      const sockets = this.socketsByActor.get(actor);
      if (!sockets) continue;
      for (const ws of sockets) {
        try { ws.send(data); } catch { /* gone */ }
      }
    }
  }

  private broadcastLiveEvents(world: WooWorld, result: DirectResultFrame, originMcpSessionId?: string | null): void {
    if (!result.audience) return;
    const startedAt = Date.now();
    let audienceSize = 0;
    result.observations.forEach((observation, index) => {
      const frame: LiveEventFrame = { op: "event", observation };
      audienceSize += this.broadcastLiveEvent(world, frame, result.audience!, result.observationAudiences?.[index] ?? result.audienceActors);
    });
    this.mcpGateway?.routeLiveEvents(result, originMcpSessionId ?? null);
    world.recordMetric({ kind: "broadcast", audience_size: audienceSize, obs_count: result.observations.length, ms: Date.now() - startedAt });
  }

  private broadcastLiveEvent(world: WooWorld, frame: LiveEventFrame, audience: ObjRef, audienceActors?: ObjRef[]): number {
    const data = JSON.stringify(frame);
    const { to: directedTo, from: directedFrom } = directedRecipients(frame.observation);
    let delivered = 0;
    const sendAll = (sockets: Set<WebSocket> | undefined): void => {
      if (!sockets) return;
      for (const ws of sockets) {
        delivered += 1;
        try { ws.send(data); } catch { /* gone */ }
      }
    };
    if (directedTo || directedFrom) {
      if (directedTo) sendAll(this.socketsByActor.get(directedTo));
      if (directedFrom && directedFrom !== directedTo) sendAll(this.socketsByActor.get(directedFrom));
      return delivered;
    }
    const actorsIter: Iterable<ObjRef> | null = audienceActors
      ? audienceActors
      : world.presenceActorsIn(audience);
    if (!actorsIter) return delivered;
    for (const actor of actorsIter) sendAll(this.socketsByActor.get(actor));
    return delivered;
  }

}

// ---- module-scoped helpers ----

function memoizeHostOperation<T>(cache: Map<string, Promise<unknown>>, key: string, load: () => Promise<T>): Promise<T> {
  const existing = cache.get(key);
  if (existing) return existing as Promise<T>;
  const promise = load();
  cache.set(key, promise as Promise<unknown>);
  return promise;
}

function taskResultSpace(result: ParkedTaskRun): ObjRef {
  const serialized = result.task.serialized as unknown;
  if (serialized && typeof serialized === "object" && !Array.isArray(serialized)) {
    const space = (serialized as Record<string, unknown>).space;
    if (typeof space === "string") return space as ObjRef;
  }
  return result.task.parked_on;
}

function workerRestRequest(request: Request, pathname: string): RestProtocolRequest {
  const url = new URL(request.url);
  return {
    method: request.method,
    pathname,
    query: (name) => url.searchParams.get(name),
    header: (name) => request.headers.get(name),
    readJson: () => readJsonBody(request)
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-length") === "0") return {};
  try {
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) throw wooError("E_RATE", `request body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
    const raw = await request.arrayBuffer();
    if (raw.byteLength > MAX_JSON_BODY_BYTES) throw wooError("E_RATE", `request body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
    const parsed = raw.byteLength === 0 ? {} : JSON.parse(new TextDecoder().decode(raw));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return {};
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) throw err;
    return {};
  }
}

function readMap(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function uniqueRoutes(routes: Array<{ id: string; host: string; anchor: string | null }>): Array<{ id: string; host: string; anchor: string | null }> {
  const byId = new Map<string, { id: string; host: string; anchor: string | null }>();
  for (const route of routes) {
    if (!route?.id || !route.host) continue;
    byId.set(route.id, route);
  }
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

async function workerHashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function logCatalogTapEvent(event: CatalogTapLogEvent): void {
  console.log("woo.catalog", JSON.stringify({ ...event, ts: Date.now() }));
}
