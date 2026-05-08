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

import { createWorld, createWorldFromSerialized, mergeHostScopedSeedWithStatus, nonEmptyHostScopedWorld } from "../core/bootstrap";
import { parseAutoInstallCatalogs, runHostScopedLocalCatalogLifecycle } from "../core/local-catalogs";
import {
  handleRestProtocolRequest,
  handleWsProtocolFrame,
  parseWsProtocolFrame,
  statusForError,
  type RestProtocolRequest
} from "../core/protocol";
import type { MetricEvent, ObjRef, Observation, RemoteToolDescriptor, Session, WooValue } from "../core/types";
import { directedRecipients, publicAppliedFrame, wooError } from "../core/types";
import type { AppliedFrame, CommandFrame, DirectResultFrame, ErrorFrame, LiveEventFrame, Message } from "../core/types";
import type { SerializedWorld, TombstoneRecord } from "../core/repository";
import { createHostOperationMemo, normalizeError, type ParkedTaskRun } from "../core/world";
import { installGitHubTap, updateGitHubTap, type CatalogTapLogEvent } from "../core/catalog-taps";
import { CFObjectRepository } from "./cf-repository";
import { McpGateway } from "../mcp/gateway";
import { signInternalRequest, verifyInternalRequest } from "./internal-auth";

// Re-import WooWorld type. Note `import type` must reach the world module
// without dragging Node-only deps into the Worker bundle.
import type { CallContext, DeferredHostEffect, HostBridge, HostObjectSummary, HostOperationMemo, MoveObjectResult, OverlaySnapshot, RoomSnapshot, ScopedObjectSummary, WooWorld } from "../core/world";

export interface Env {
  WOO: DurableObjectNamespace;
  DIRECTORY: DurableObjectNamespace;
  ASSETS?: Fetcher;
  WOO_INITIAL_WIZARD_TOKEN?: string;
  WOO_INTERNAL_SECRET?: string;
  WOO_AUTO_INSTALL_CATALOGS?: string;
  WOO_HOST_READ_TIMEOUT_MS?: string;
  WOO_HOST_WRITE_TIMEOUT_MS?: string;
  WOO_HOST_OUT_FETCH_CONCURRENCY?: string;
}

const WORLD_HOST = "world";
const DIRECTORY_HOST = "directory";
const INTERNAL_ORIGIN = "https://woo.internal";
const MAX_JSON_BODY_BYTES = 1 * 1024 * 1024;
const METRIC_SAMPLE_BUDGET = 10;
const METRIC_SAMPLE_WINDOW_MS = 1000;
const HOST_STATE_CACHE_LIMIT = 32;
const HOST_STATE_FETCH_TIMEOUT_MS = 2500;
// Read-only cross-host RPCs (room-snapshot, remote-get-prop, contents, etc.)
// are deadlined tightly so a wedge surfaces fast and the local task chain
// can fall back to a degraded reply. 5s is the working ceiling: a hot
// remote settles in ~50ms, but a cold-start DO has to load persistence,
// run bootstrap, and serve the snapshot, which can spike to 3-4s on first
// touch. Override per deployment via WOO_HOST_READ_TIMEOUT_MS.
const HOST_READ_RPC_TIMEOUT_MS = 5000;
// Mutating cross-host RPCs do not have an inherent deadline (a write that
// takes 30s may still be making progress), but a wedged DO can park a slot
// forever and the local task chain along with it. The watchdog is a
// generous safety net: if no response has come back by this point, the
// remote is assumed unreachable, the slot is released, and the caller sees
// E_TIMEOUT. Aborting mid-write may leave ambiguous remote state — but
// indefinite hang is already a worse failure mode (the whole DO becomes
// unresponsive). Most operations on this codebase are inherently
// idempotent (set_property, observe, mirror-contents).
const HOST_WRITE_RPC_TIMEOUT_MS = 30_000;
// Cap on concurrent DO->DO fetch() subrequests issued by this isolate. The
// Workers runtime enforces its own ~6-slot limit; we self-limit slightly under
// that and queue the overflow so cold-start fan-outs (compose_look hitting 4
// remote hosts × N concurrent looks) don't all pile against the runtime queue
// at once. Saturation is visible in the cross_host_rpc metric's queue_ms field.
const HOST_OUT_FETCH_CONCURRENCY = 5;
// Race a Promise against an AbortSignal. If the signal aborts first, reject
// with the signal's reason; the underlying Promise is orphaned (real fetch
// implementations cancel via the Request signal as well, so this is just a
// belt-and-suspenders early-out for environments — like test fakes — that
// don't honor the signal on the Request).
function raceAgainstAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? wooError("E_ABORTED", "aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? wooError("E_ABORTED", "aborted"));
    };
    signal.addEventListener("abort", onAbort);
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (err) => { signal.removeEventListener("abort", onAbort); reject(err); }
    );
  });
}

// Internal RPC routes that are pure reads of world state and therefore safe
// to coalesce: while one fetch is in flight, identical concurrent requests
// (same host + path + body) attach to the same Promise rather than each
// firing a fresh subrequest. Single-flight only — once the Promise settles,
// the next call computes anew, so freshness is automatic without a TTL.
// Mutating routes (remote-dispatch, ws-call, ws-direct, mirror-contents,
// space-subscriber, register-objects, register-session, host-seed, etc.)
// MUST NOT be added: coalescing them would deduplicate intentional repeated
// writes.
const COALESCEABLE_INTERNAL_PATHS: ReadonlySet<string> = new Set([
  "/__internal/object-summaries",
  "/__internal/object-summary",
  "/__internal/remote-describe-many",
  "/__internal/remote-get-prop",
  "/__internal/replay",
  "/__internal/state",
  "/__internal/actor-session-locations-batch",
  "/__internal/space-audience-sessions",
  "/__internal/room-snapshot",
]);
// Per spec/semantics/recycle.md §RC11.3 step 2: tombstone roster handed to
// Directory in batches sized to stay well under the 512 KiB Directory cap.
// 1000 records × ~80 bytes per JSON entry ≈ 80 KiB, leaving ample headroom
// for header overhead.
const INHERIT_TOMBSTONES_BATCH_SIZE = 1000;
// Meta key under which the §RC11.2 host-teardown state is persisted.
const HOST_STATE_META_KEY = "host_state";
const HOST_STATE_TEARING_DOWN = "tearing_down";

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
  private socketsBySession = new Map<string, Set<WebSocket>>();
  // FIFO semaphore for outbound DO->DO fetch() concurrency. See
  // HOST_OUT_FETCH_CONCURRENCY. The releaser hands the slot directly to the
  // next waiter (no decrement-then-increment) to avoid an over-cap race when a
  // releaser and a fresh acquire run concurrently.
  private outFetchInFlight = 0;
  private outFetchQueue: Array<() => void> = [];
  // Single-flight coalesce table for COALESCEABLE_INTERNAL_PATHS. Key is
  // `${host}\n${path}\n${bodyStr}`; value is the in-flight Promise. Cleared on
  // settle (resolve or reject) so the next call recomputes against fresh state.
  private outFetchInflight = new Map<string, Promise<unknown>>();
  // Per spec/semantics/recycle.md §RC11. Cached host_state — null means
  // "not yet read this lifetime"; afterwards the cached string is "live"
  // or "tearing_down". Resets on DO eviction.
  private cachedTeardownState: string | null = null;
  // Set true once a teardown sequence has been scheduled in this DO
  // lifetime so we don't double-fire it from concurrent fetch handlers.
  private teardownScheduled = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.repo = new CFObjectRepository(state, (event) => this.emitMetric(event, this.durableHostKey()));
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

    // §RC11.5 teardown gate. Once host_state is "tearing_down", this DO
    // refuses all inbound work with E_HOST_RECYCLED until deleteAll has
    // run. If teardown is in progress but no waitUntil is currently
    // running it (e.g. a wake from hibernation between batches), schedule
    // a resume so the sequence completes idempotently.
    if (!gatewayHost && this.getHostState() === HOST_STATE_TEARING_DOWN) {
      this.ensureTeardownScheduled(this.durableHostKey());
      return jsonResponse(
        { error: { code: "E_HOST_RECYCLED", message: "host is tearing down" } },
        410
      );
    }

    if (!gatewayHost && (pathname === "/api/auth" || pathname === "/ws")) {
      return jsonResponse({ error: { code: "E_NOTAPPLICABLE", message: `${pathname} is only available on the world gateway host` } }, 404);
    }

    let postHandlerWorld: WooWorld | null = null;
    try {
      const world = await this.getWorld(hostKey);
      postHandlerWorld = world;

      if (internalRequest) {
        return await this.handleInternal(request, world, pathname, hostKey);
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

      if (gatewayHost && request.method === "POST" && pathname === "/api/admin/refresh-host-seeds") {
        const session = this.requireRestSession(world, request);
        if (!world.object(session.actor).flags.wizard) throw wooError("E_PERM", "wizard authority required");
        const body = await readJsonBody(request);
        const hosts = Array.isArray(body.hosts) ? body.hosts.filter((item): item is string => typeof item === "string") : undefined;
        return jsonResponse(await this.refreshRemoteHostSeeds(world, { hosts }));
      }

      const protocol = await handleRestProtocolRequest(workerRestRequest(request, pathname), {
        world,
        authenticateToken: (token) => this.authenticateToken(world, token),
        requireSession: () => this.requireRestSession(world, request),
        onAuthenticated: (session) => this.registerSessionRoute(session),
        onSessionEnded: (session) => this.unregisterSessionRoute(session.id),
        onSessionsEnded: async (sessions) => {
          for (const session of sessions) await this.unregisterSessionRoute(session.id);
        },
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
        return jsonResponse(protocol.body, protocol.status, protocol.headers);
      }

      return jsonResponse({ error: { code: "E_OBJNF", message: `no route for ${request.method} ${pathname}` } }, 404);
    } catch (err) {
      const error = normalizeError(err);
      return jsonResponse({ error }, statusForError(error));
    } finally {
      if (!gatewayHost && postHandlerWorld) {
        this.maybeStartTeardown(postHandlerWorld, this.durableHostKey());
      }
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

  // ---- §RC11 host teardown ----

  /** Read the persisted host_state, cached for the DO lifetime (resets on
   * eviction). Returns "live" by default; "tearing_down" once §RC11 has
   * begun. The first call reads from the repo; subsequent calls return
   * the cached value until setHostStateTearingDown overwrites it. */
  private getHostState(): string {
    if (this.cachedTeardownState !== null) return this.cachedTeardownState;
    let value: string | null = null;
    try {
      value = this.repo.loadMeta(HOST_STATE_META_KEY);
    } catch {
      value = null;
    }
    this.cachedTeardownState = value === HOST_STATE_TEARING_DOWN ? HOST_STATE_TEARING_DOWN : "live";
    return this.cachedTeardownState;
  }

  private setHostStateTearingDown(): void {
    this.repo.saveMeta(HOST_STATE_META_KEY, HOST_STATE_TEARING_DOWN);
    this.cachedTeardownState = HOST_STATE_TEARING_DOWN;
  }

  /** Post-handler trigger evaluation per spec/semantics/recycle.md §RC11.1.
   *
   * v1 detection: if this DO's self-hosted root is gone (recycled), the host
   * is empty of payload — pre-flight A3 forces co-resident objects to recycle
   * first. The trigger evaluates `world.tombstones.has(rootId) &&
   * !world.objects.has(rootId)`. Future revisions may need a deeper
   * livePayloadCount that excludes host-scoped support copies row-by-row;
   * that's not required while the trigger fires only on root recycle. */
  private maybeStartTeardown(world: WooWorld, hostKey: string): void {
    if (hostKey === WORLD_HOST) return;
    if (this.cachedTeardownState === HOST_STATE_TEARING_DOWN) return;
    if (!world.tombstones.has(hostKey as ObjRef)) return;
    if (world.objects.has(hostKey as ObjRef)) return;

    try {
      this.setHostStateTearingDown();
    } catch (err) {
      console.warn("woo.host_teardown.mark_failed", { host: hostKey, error: normalizeError(err) });
      return;
    }
    this.ensureTeardownScheduled(hostKey);
  }

  /** Idempotently schedule the teardown sequence. Multiple fetches that
   * observe `tearing_down` only ever start one waitUntil promise. */
  private ensureTeardownScheduled(hostKey: string): void {
    if (this.teardownScheduled) return;
    this.teardownScheduled = true;
    const promise = this.runTeardownSequence(hostKey).catch((err) => {
      console.warn("woo.host_teardown.failed", { host: hostKey, error: normalizeError(err) });
      // Leave teardownScheduled=true so we don't loop on a permanently
      // failing batch; the next DO wake re-evaluates and can retry.
    });
    if (typeof this.state.waitUntil === "function") {
      this.state.waitUntil(promise);
    }
  }

  /** Per spec/semantics/recycle.md §RC11.3 steps 2–4. */
  private async runTeardownSequence(hostKey: string): Promise<void> {
    const startedAt = Date.now();
    let tombstones: TombstoneRecord[] = [];
    try {
      tombstones = this.repo.loadTombstoneRecords();
    } catch {
      tombstones = [];
    }

    // Step 2: hand the roster to Directory in batches.
    const batches = chunkTombstones(tombstones, INHERIT_TOMBSTONES_BATCH_SIZE);
    for (let i = 0; i < batches.length; i++) {
      const final = i === batches.length - 1;
      await this.postInheritTombstones(hostKey, i, final, batches[i]);
    }

    // Step 3: cancel alarms (best-effort; deleteAll also clears them at
    // the current compatibility date — see spec/semantics/recycle.md
    // §RC11.3 step 3).
    try {
      await this.state.storage.deleteAlarm?.();
    } catch {
      // best-effort
    }

    // Step 4: wipe storage.
    try {
      await this.state.storage.deleteAll();
    } catch (err) {
      console.warn("woo.host_teardown.deleteAll_failed", { host: hostKey, error: normalizeError(err) });
      throw err;
    }

    this.emitMetric({
      kind: "startup_storage", phase: "directory_inherit_tombstones",
      ms: Date.now() - startedAt, status: "ok",
      count: tombstones.length, batch_seq: batches.length - 1, final: true
    }, hostKey);
  }

  /** Cold-load guard per spec/semantics/recycle.md §RC11.6. Called on a DO
   * with empty storage before any cold-load seed runs. RPCs Directory's
   * `lookup-inherited-tombstone` for our own id; if hit, throws
   * E_HOST_RECYCLED and the caller refuses to bootstrap. The Directory
   * RPC is the same one used to answer `is_recycled()` queries, so this
   * adds at most one Directory round-trip to a cold start that already
   * RPCs the gateway for a host seed. */
  private async guardColdLoadAgainstInheritedTombstone(hostKey: string): Promise<void> {
    if (hostKey === WORLD_HOST) return;
    let body: Record<string, unknown> | null = null;
    try {
      const directoryId = this.env.DIRECTORY.idFromName(DIRECTORY_HOST);
      const request = await signInternalRequest(this.env, new Request(
        `${INTERNAL_ORIGIN}/__internal/lookup-inherited-tombstone`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-woo-host-key": hostKey
          },
          body: JSON.stringify({ id: hostKey })
        }
      ));
      const response = await this.env.DIRECTORY.get(directoryId).fetch(request);
      if (!response.ok) return; // lenient: Directory unreachable → proceed
      body = await response.json() as Record<string, unknown>;
    } catch (err) {
      // Lenient on transport failure; logged for observability. The cost
      // of a false-negative cold-load (re-creating a DO under a torn-down
      // id) is bounded — the next request that reaches Directory will
      // trip the gate, the DO writes host_state=tearing_down, and reruns
      // §RC11.3 (idempotent on the empty roster).
      console.warn("woo.host_teardown.cold_load_guard_failed", { host: hostKey, error: normalizeError(err) });
      return;
    }
    if (body && body.tombstoned === true) {
      throw wooError(
        "E_HOST_RECYCLED",
        `host ${hostKey} was recycled; refusing cold-load`,
        hostKey
      );
    }
  }

  private async postInheritTombstones(
    hostKey: string,
    batchSeq: number,
    final: boolean,
    tombstones: TombstoneRecord[]
  ): Promise<void> {
    const directoryId = this.env.DIRECTORY.idFromName(DIRECTORY_HOST);
    const request = await signInternalRequest(this.env, new Request(
      `${INTERNAL_ORIGIN}/__internal/inherit-tombstones`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-woo-host-key": hostKey
        },
        body: JSON.stringify({
          host: hostKey,
          batch_seq: batchSeq,
          final,
          tombstones
        })
      }
    ));
    const response = await this.env.DIRECTORY.get(directoryId).fetch(request);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`directory inherit-tombstones batch ${batchSeq} failed (${response.status}): ${text}`);
    }
  }

  private getMcpGateway(world: WooWorld): McpGateway {
    if (!this.mcpGateway) {
      const initStart = Date.now();
      this.mcpGateway = new McpGateway(world, {
        serverName: "woo",
        dispatch: {
          call: async (sessionId, actor, space, message) => {
            world.touchSessionInput(sessionId);
            const session = { sessionId, actor };
            const host = await this.resolveObjectHost(space, WORLD_HOST);
            const result = host === WORLD_HOST
              ? await world.call(undefined, sessionId, space, message)
              : await this.forwardWsCall(world, host, undefined, session, space, message);
            if (result.op === "applied" && host !== WORLD_HOST) await this.registerRemoteObjectRoutes(host);
            return result;
          },
          direct: async (sessionId, actor, target, verb, args) => {
            world.touchSessionInput(sessionId);
            const session = { sessionId, actor };
            const host = await this.resolveObjectHost(target, WORLD_HOST);
            const { pure } = this.resolveDispatchPath(world, target, verb, host, WORLD_HOST);
            return host === WORLD_HOST
              ? await world.directCall(undefined, actor, target, verb, args)
              : await this.forwardWsDirect(world, host, undefined, session, target, verb, args, { pure });
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
      const metricsHook = (event: MetricEvent) => this.emitMetric(event, hostKey);
      const world = hostKey === WORLD_HOST
        ? createWorld({ repository: this.repo, catalogs: parseAutoInstallCatalogs(this.env.WOO_AUTO_INSTALL_CATALOGS), metricsHook })
        : await this.createHostScopedWorld(hostKey as ObjRef, metricsHook);
      this.installHostBridge(world, hostKey);
      // Rehydrate live WebSocket attachments. After DO wake-from-hibernation,
      // state.getWebSockets() returns sockets whose serializeAttachment
      // payload survived hibernation; the in-memory world.sessions, however,
      // is freshly hydrated from storage with empty attachedSockets sets
      // (hydrateSession in world.ts:1256). Re-attach each surviving socket
      // so presence-filtered broadcasts reach those clients again and the
      // session reap path doesn't expire actively-connected sessions.
        this.socketsByActor.clear();
        this.socketsBySession.clear();
      for (const ws of this.state.getWebSockets()) {
        const att = this.attachment(ws);
        if (att && world.sessions?.has(att.sessionId)) {
          world.attachSocket(att.sessionId, att.socketId);
            this.indexAddSocket(att.sessionId, att.actor, ws);
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

  private async createHostScopedWorld(hostKey: ObjRef, metricsHook: (event: MetricEvent) => void): Promise<WooWorld> {
    const stored = this.repo.load();
    // §RC11.6 cold-load guard. If storage is empty (a fresh DO or a stale
    // stub reactivating an empty post-deleteAll instance), check Directory
    // before running any cold-load seed: if our id is recorded as a
    // former_host in inherited_tombstone, refuse and write nothing.
    if (!stored) {
      await this.guardColdLoadAgainstInheritedTombstone(hostKey);
    }
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
    let seedMergeChanged = false;
    if (scoped && freshSeed) {
      const merged = mergeHostScopedSeedWithStatus(scoped, freshSeed);
      scoped = merged.world;
      seedMergeChanged = merged.changed;
    }
    if (!scoped) scoped = freshSeed;
    if (!scoped) throw wooError("E_OBJNF", `no host-scoped seed for ${hostKey}`, hostKey);
    const world = createWorldFromSerialized(scoped, { repository: this.repo, metricsHook, persist: stored === null });
    // Run local catalog schema/data migration plans on this host's actual
    // slice. The gateway cannot convert state it does not own.
    runHostScopedLocalCatalogLifecycle(world, hostKey, { freshSeed: stored === null });
    if (freshSeed) {
      const seeded = mergeHostScopedSeedWithStatus(world.exportWorld(), freshSeed);
      if (seeded.changed) {
        world.importWorld(seeded.world);
        seedMergeChanged = true;
      }
    }
    if (seedMergeChanged) world.persistFullSnapshot();
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
    const startedAt = Date.now();
    const id = this.env.WOO.idFromName(WORLD_HOST);
    try {
      const request = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}/__internal/host-seed`, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-woo-host-key": WORLD_HOST
        },
        body: JSON.stringify({ host: hostKey })
      }));
      const { response } = await this.outboundFetch(id, request);
      const body = await response.json();
      if (!response.ok) {
        throw wooError("E_STORAGE", `failed to load host seed for ${hostKey}`, body as WooValue);
      }
      this.emitMetric({ kind: "startup_storage", phase: "host_seed_fetch", ms: Date.now() - startedAt, status: "ok", objects: Array.isArray((body as { objects?: unknown }).objects) ? ((body as { objects: unknown[] }).objects.length) : undefined }, hostKey);
      return body as SerializedWorld;
    } catch (err) {
      this.emitMetric({ kind: "startup_storage", phase: "host_seed_fetch", ms: Date.now() - startedAt, status: "error", error: metricErrorCode(err) }, hostKey);
      throw err;
    }
  }

  private async refreshRemoteHostSeeds(world: WooWorld, options: { hosts?: string[] } = {}): Promise<Record<string, unknown>> {
    await this.registerObjectRoutes(world);
    const requested = options.hosts && options.hosts.length > 0 ? new Set(options.hosts) : null;
    const routeHosts = new Set(world.objectRoutes().map((route) => route.host).filter((host) => host && host !== WORLD_HOST));
    const hosts = Array.from(new Set(
      Array.from(routeHosts).filter((host) => !requested || requested.has(host))
    )).sort();
    const refreshed: Array<Record<string, unknown>> = [];
    const skipped: Array<Record<string, unknown>> = [];
    const errors: Array<Record<string, unknown>> = [];
    if (requested) {
      for (const host of Array.from(requested).sort()) {
        if (host !== WORLD_HOST && !routeHosts.has(host)) skipped.push({ host, reason: "unmatched_host" });
      }
    }
    for (const host of hosts) {
      const seed = world.exportHostScopedWorld(host as ObjRef);
      if (seed.objects.length === 0) {
        skipped.push({ host, reason: "empty_seed" });
        continue;
      }
      try {
        const result = await this.forwardInternalChecked<Record<string, unknown>>(
          host,
          "/__internal/apply-host-seed",
          { host, seed },
          { timeoutMs: 15_000 }
        );
        refreshed.push(result);
      } catch (err) {
        errors.push({ host, error: normalizeError(err) });
      }
    }
    return { ok: errors.length === 0, hosts: hosts.length, refreshed, skipped, errors };
  }

  private applyHostSeed(world: WooWorld, hostKey: ObjRef, seed: SerializedWorld): Record<string, unknown> {
    const scopedSeed = nonEmptyHostScopedWorld(seed, hostKey);
    if (!scopedSeed) throw wooError("E_OBJNF", `host seed does not contain ${hostKey}`, hostKey);
    const current = world.exportWorld();
    const merged = mergeHostScopedSeedWithStatus(current, scopedSeed);
    if (merged.changed) {
      world.importWorld(merged.world);
      world.persistFullSnapshot();
      this.hostStateCache.clear();
      this.crossHostPropCache.clear();
    }
    return { ok: true, host: hostKey, changed: merged.changed, objects: world.objects.size };
  }

  private async registerObjectRoutes(world: WooWorld): Promise<void> {
    if (this.routesRegistered) {
      await this.registerIncrementalObjectRoutes(world);
      return;
    }
    const ok = await this.registerRoutes(world.objectRoutes());
    if (ok) this.routesRegistered = true;
  }

  private async registerIncrementalObjectRoutes(world: WooWorld): Promise<void> {
    const routes = world.objectRoutes().filter((route) => this.publishedRoutes.get(route.id) !== route.host);
    await this.registerRoutes(routes);
  }

  private localObjectRoute(world: WooWorld | null | undefined, id: ObjRef): { id: ObjRef; host: string; anchor: ObjRef | null } | null {
    return world?.objectRoutes().find((route) => route.id === id) ?? null;
  }

  private async adoptLocalObjectRoute(route: { id: ObjRef; host: string; anchor: ObjRef | null }): Promise<string> {
    if (this.publishedRoutes.get(route.id) !== route.host) {
      const ok = await this.registerRoutes([route]);
      if (!ok) this.routeCache.set(route.id, route.host);
    } else {
      this.routeCache.set(route.id, route.host);
    }
    return route.host;
  }

  private async resolveObjectHostForWorld(world: WooWorld | null | undefined, id: ObjRef, fallbackHost: string): Promise<string> {
    const localRoute = this.localObjectRoute(world, id);
    const cached = this.routeCache.get(id);
    if (cached) {
      if (localRoute && localRoute.host !== cached) return await this.adoptLocalObjectRoute(localRoute);
      return cached;
    }
    if (localRoute) return await this.adoptLocalObjectRoute(localRoute);
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
      const resolved = await this.resolveObjectHostForWorld(world, id, "");
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
          const response = await this.forwardInternalReadChecked<{ value: WooValue }>(host, "/__internal/remote-get-prop", { progr, obj: objRef, name });
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
      setPropChecked: async (progr, objRef, name, value, memo) => {
        const host = await hostForObject(objRef, memo);
        if (!host || host === localHost) {
          await world.setPropChecked(progr, objRef, name, value, memo);
          return;
        }
        memo?.reads.delete(`prop:${progr}:${objRef}:${name}`);
        this.crossHostPropCache.delete(`${host}|${objRef}|${name}`);
        await this.forwardInternalChecked<{ ok: true }>(host, "/__internal/remote-set-prop", { progr, obj: objRef, name, value });
      },
      objectSummary: async (readActor, objRef, memo) => {
        const read = async (): Promise<ScopedObjectSummary> => {
          const host = await hostForObject(objRef, memo);
          if (!host || host === localHost) return await world.scopedObjectSummary(readActor, objRef, memo);
          return await this.forwardInternalReadChecked<ScopedObjectSummary>(
            host,
            "/__internal/object-summary",
            { read_actor: readActor, obj: objRef }
          );
        };
        if (memo) return await memoizeHostOperation(memo.reads, `summary:${readActor}:${objRef}`, read);
        return await read();
      },
      objectSummaries: async (readActor, objRefs, memo) => {
        const out: Record<ObjRef, ScopedObjectSummary> = {};
        const missingByHost = new Map<string, ObjRef[]>();
        for (const objRef of objRefs) {
          const key = `summary:${readActor}:${objRef}`;
          const cached = memo?.reads.get(key) as Promise<ScopedObjectSummary> | undefined;
          if (cached) {
            out[objRef] = await cached;
            continue;
          }
          const host = await hostForObject(objRef, memo);
          if (!host || host === localHost) {
            const summary = await world.scopedObjectSummary(readActor, objRef, memo);
            out[objRef] = summary;
            if (memo) memo.reads.set(key, Promise.resolve(summary));
            continue;
          }
          const list = missingByHost.get(host) ?? [];
          list.push(objRef);
          missingByHost.set(host, list);
        }
        await Promise.all(Array.from(missingByHost, async ([host, ids]) => {
          try {
            const response = await this.forwardInternalReadChecked<{ objects: Record<ObjRef, ScopedObjectSummary> }>(
              host,
              "/__internal/object-summaries",
              { read_actor: readActor, ids }
            );
            if (!response.objects || typeof response.objects !== "object" || Array.isArray(response.objects)) {
              throw wooError("E_INTERNAL", "remote object-summaries response missing objects", { host });
            }
            for (const id of ids) {
              const summary = response.objects?.[id];
              if (!summary) continue;
              out[id] = summary;
              if (memo) memo.reads.set(`summary:${readActor}:${id}`, Promise.resolve(summary));
            }
          } catch (err) {
            if (!isReadAvailabilityError(err)) throw err;
            // Scoped summaries are projection hints. A cold or slow remote host
            // must not hold this host's single-threaded queue.
          }
        }));
        return out;
      },
      roomSnapshot: async (readActor, room, sessionId, memo) => {
        const read = async (): Promise<RoomSnapshot> => {
          const host = await hostForObject(room, memo);
          if (!host || host === localHost) return await world.roomSnapshotForActor(readActor, room, sessionId ?? null, memo);
          return await this.forwardInternalReadChecked<RoomSnapshot>(
            host,
            "/__internal/room-snapshot",
            { read_actor: readActor, room, session_id: sessionId ?? null }
          );
        };
        if (memo) return await memoizeHostOperation(memo.reads, `room-snapshot:${readActor}:${room}:${sessionId ?? ""}`, read);
        return await read();
      },
      overlaySnapshot: async (readActor, subject, surface, sessionId, memo) => {
        const read = async (): Promise<OverlaySnapshot> => {
          const host = await hostForObject(subject, memo);
          if (!host || host === localHost) return await world.overlaySnapshotForActor(readActor, subject, surface, sessionId ?? null, memo);
          return await this.forwardInternalReadChecked<OverlaySnapshot>(
            host,
            "/__internal/overlay-snapshot",
            { read_actor: readActor, subject, surface, session_id: sessionId ?? null }
          );
        };
        if (memo) return await memoizeHostOperation(memo.reads, `overlay-snapshot:${readActor}:${subject}:${surface}:${sessionId ?? ""}`, read);
        return await read();
      },
      describeObject: async (nameActor, readActor, objRef, memo) => {
        const read = async () => {
          const host = await hostForObject(objRef, memo);
          if (!host || host === localHost) {
            return {
              name: world.object(objRef).name,
              description: world.propOrNullForActor(readActor, objRef, "description"),
              aliases: world.propOrNullForActor(readActor, objRef, "aliases"),
              owner: world.object(objRef).owner,
              obvious_verbs: world.obviousCommandSyntaxes(objRef, world.object(objRef).name || objRef)
            };
          }
          return await this.forwardInternalReadChecked<HostObjectSummary>(
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
              aliases: world.propOrNullForActor(readActor, objRef, "aliases"),
              owner: world.object(objRef).owner,
              obvious_verbs: world.obviousCommandSyntaxes(objRef, world.object(objRef).name || objRef)
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
          try {
            const response = await this.forwardInternalReadChecked<{ objects: Record<ObjRef, HostObjectSummary> }>(
              host,
              "/__internal/remote-describe-many",
              { name_actor: nameActor, read_actor: readActor, ids }
            );
            if (!response.objects || typeof response.objects !== "object" || Array.isArray(response.objects)) {
              throw wooError("E_INTERNAL", "remote describe-many response missing objects", { host });
            }
            for (const id of ids) {
              const summary = response.objects?.[id];
              if (!summary) continue;
              out[id] = summary;
              if (memo) memo.reads.set(`describe:${nameActor}:${readActor}:${id}`, Promise.resolve(summary));
            }
          } catch (err) {
            if (!isReadAvailabilityError(err)) throw err;
            // Object matching/rendering can fall back to ids for a slow host.
          }
        }));
        return out;
      },
      resolveVerb: async (target, verbName, memo) => {
        const read = async () => {
          const host = await hostForObject(target, memo);
          if (!host || host === localHost) {
            const { verb } = world.resolveVerb(target, verbName);
            return { name: verb.name, direct_callable: verb.direct_callable === true, arg_spec: verb.arg_spec ?? {} };
          }
          return await this.forwardInternalReadChecked<{ name: string; direct_callable: boolean; arg_spec?: Record<string, WooValue> }>(
            host,
            "/__internal/remote-resolve-verb",
            { target, verb: verbName }
          );
        };
        if (memo) return await memoizeHostOperation(memo.reads, `verb:${target}:${verbName}`, read);
        return await read();
      },
      commandVerbCandidates: async (target, verbName, memo) => {
        const read = async () => {
          const host = await hostForObject(target, memo);
          if (!host || host === localHost) return world.commandVerbCandidateSummaries(target, verbName);
          const response = await this.forwardInternalReadChecked<{ candidates?: Array<{ name: string; direct_callable: boolean; arg_spec?: Record<string, WooValue> }> }>(
            host,
            "/__internal/remote-command-verb-candidates",
            { target, verb: verbName }
          );
          return Array.isArray(response.candidates) ? response.candidates : [];
        };
        if (memo) return await memoizeHostOperation(memo.reads, `command-verbs:${target}:${verbName}`, read);
        return await read();
      },
      isDescendantOf: async (objRef, ancestorRef, memo) => {
        const read = async (): Promise<boolean> => {
          const host = await hostForObject(objRef, memo);
          if (!host || host === localHost) return world.isDescendantOf(objRef, ancestorRef);
          const response = await this.forwardInternalReadChecked<{ result: boolean }>(
            host,
            "/__internal/remote-is-descendant",
            { obj: objRef, ancestor: ancestorRef }
          );
          return response.result === true;
        };
        if (memo) return await memoizeHostOperation(memo.reads, `isa:${objRef}:${ancestorRef}`, read);
        return await read();
      },
      isRecycled: async (objRef, memo) => {
        // Per spec/semantics/recycle.md §RC5 and
        // spec/reference/persistence.md §14.2.1, tombstones live on the
        // owning host. When `objRef` lives elsewhere, ask that host's
        // local tombstone table; otherwise consult the local set.
        const read = async (): Promise<boolean> => {
          const host = await hostForObject(objRef, memo);
          if (!host || host === localHost) return world.isRecycled(objRef);
          try {
            const response = await this.forwardInternalReadChecked<{ result: boolean }>(
              host,
              "/__internal/remote-is-recycled",
              { obj: objRef }
            );
            return response.result === true;
          } catch {
            return false;
          }
        };
        if (memo) return await memoizeHostOperation(memo.reads, `is-recycled:${objRef}`, read);
        return await read();
      },
      location: async (objRef, memo) => {
        const read = async (): Promise<ObjRef | null> => {
          const host = await hostForObject(objRef, memo);
          if (!host || host === localHost) return world.object(objRef).location;
          const response = await this.forwardInternalReadChecked<{ location: ObjRef | null }>(host, "/__internal/remote-location", { obj: objRef });
          return response.location;
        };
        if (memo) return await memoizeHostOperation(memo.reads, `location:${objRef}`, read);
        return await read();
      },
      dispatch: async (ctx, target, verbName, args, startAt) => {
        const host = await hostForObject(startAt ?? target, ctx.hostMemo);
        const resolvedHost = host ?? localHost;
        const { pure, path } = this.resolveDispatchPath(world, target, verbName, resolvedHost, localHost);
        if (path === "local") return await world.hostDispatch(ctx, target, verbName, args, startAt);
        // Pure verbs route through forwardInternalReadChecked for its 2.5s
        // read deadline. A timed-out look_self surfaces as E_TIMEOUT to the
        // caller and frees the host queue rather than wedging it.
        const forward = pure
          ? this.forwardInternalReadChecked.bind(this)
          : this.forwardInternalChecked.bind(this);
        const response = await forward<{
          result: WooValue;
            observations?: Observation[];
            audience_actors?: ObjRef[];
            observation_audiences?: ObjRef[][];
            audience_sessions?: string[];
            observation_session_audiences?: string[][];
            deferred_host_effects?: DeferredHostEffect[];
        }>(resolvedHost, "/__internal/remote-dispatch", {
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
          if (response.audience_actors || response.observation_audiences || response.audience_sessions || response.observation_session_audiences) {
            (ctx as { crossHostAudience?: { audienceActors?: ObjRef[]; observationAudiences?: ObjRef[][]; audienceSessions?: string[]; observationSessionAudiences?: string[][] } }).crossHostAudience = {
              audienceActors: response.audience_actors,
              observationAudiences: response.observation_audiences,
              audienceSessions: response.audience_sessions,
              observationSessionAudiences: response.observation_session_audiences
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
      setActorPresence: async (actor, space, present, sessionId) => {
        const host = await hostForObject(actor);
        if (!host || host === localHost) {
          world.setActorPresence(actor, space, present, sessionId);
          return;
        }
        await this.forwardInternalChecked(host, "/__internal/actor-presence", { actor, space, present, session: sessionId ?? null });
      },
      setSpaceSubscriber: async (space, actor, present, sessionId) => {
        const host = await hostForObject(space);
        if (!host || host === localHost) {
          world.setSpaceSubscriber(space, actor, present, sessionId);
          return;
        }
        await this.forwardInternalChecked(host, "/__internal/space-subscriber", { space, actor, present, session: sessionId ?? null });
      },
      spaceAudienceSessions: async (space, actors, memo) => {
        const read = async (): Promise<string[]> => {
          const host = await hostForObject(space, memo);
          if (!host || host === localHost) return world.presenceSessionIdsIn(space, actors);
          const response = await this.forwardInternalReadChecked<{ sessions: string[] }>(
            host,
            "/__internal/space-audience-sessions",
            { space, actors: actors ?? null }
          );
          return Array.isArray(response.sessions) ? response.sessions.filter((item): item is string => typeof item === "string") : [];
        };
        if (memo) return await memoizeHostOperation(memo.reads, `space-audience:${space}:${(actors ?? []).join(",")}`, read);
        return await read();
      },
      actorSessionLocations: async (actor, memo) => {
        const read = async (): Promise<ObjRef[]> => {
          const host = await hostForObject(actor, memo);
          if (!host || host === localHost) return world.allLocationsForActor(actor);
          const response = await this.forwardInternalReadChecked<{ locations: ObjRef[] }>(
            host,
            "/__internal/actor-session-locations",
            { actor }
          );
          return Array.isArray(response.locations) ? response.locations.filter((item): item is ObjRef => typeof item === "string") : [];
        };
        if (memo) return await memoizeHostOperation(memo.reads, `actor-locations:${actor}`, read);
        return await read();
      },
      actorSessionLocationsBatch: async (actors, memo) => {
        const out = new Map<ObjRef, ObjRef[]>();
        const missingByHost = new Map<string, ObjRef[]>();
        for (const actor of actors) {
          const key = `actor-locations:${actor}`;
          const cached = memo?.reads.get(key) as Promise<ObjRef[]> | undefined;
          if (cached) {
            out.set(actor, await cached);
            continue;
          }
          const host = await hostForObject(actor, memo);
          if (!host || host === localHost) {
            const locations = world.allLocationsForActor(actor);
            out.set(actor, locations);
            if (memo) memo.reads.set(key, Promise.resolve(locations));
            continue;
          }
          const list = missingByHost.get(host) ?? [];
          list.push(actor);
          missingByHost.set(host, list);
        }
        await Promise.all(Array.from(missingByHost, async ([host, ids]) => {
          try {
            const response = await this.forwardInternalReadChecked<{ locations: Record<ObjRef, ObjRef[]> }>(
              host,
              "/__internal/actor-session-locations-batch",
              { actors: ids }
            );
            const map = response.locations && typeof response.locations === "object" && !Array.isArray(response.locations)
              ? response.locations
              : {};
            for (const actor of ids) {
              const raw = map[actor];
              const locations = Array.isArray(raw)
                ? raw.filter((item): item is ObjRef => typeof item === "string")
                : [];
              out.set(actor, locations);
              if (memo) memo.reads.set(`actor-locations:${actor}`, Promise.resolve(locations));
            }
          } catch (err) {
            if (!isReadAvailabilityError(err)) throw err;
            // Leave these actors absent from `out`; the caller treats unknown
            // remote-location data as "skip scrub for this actor this window".
          }
        }));
        return out;
      },
      contents: async (objRef, memo) => {
        const read = async (): Promise<ObjRef[]> => {
          const host = await hostForObject(objRef, memo);
          if (!host || host === localHost) return world.contentsOf(objRef);
          const response = await this.forwardInternalReadChecked<{ contents: ObjRef[] }>(host, "/__internal/contents", { obj: objRef });
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
              const response = await this.forwardInternalReadChecked<{ tools: RemoteToolDescriptor[] }>(host, "/__internal/enumerate-tools", { actor, ids: hostIds });
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
    const session = ctx.session ? ctx.world.sessions.get(ctx.session) : undefined;
    return {
      space: ctx.space,
      seq: ctx.seq,
      session: ctx.session,
      session_current_location: session?.currentLocation ?? null,
      session_expires_at: session?.expiresAt ?? null,
      session_token_class: session?.tokenClass ?? null,
      session_apikey_id: session?.apikeyId ?? null,
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
    // per-host timeout keeps a cold or wedged remote host from blocking the
    // gateway's first state projection indefinitely.
    const fetched = await Promise.all(
      remoteHosts.map((host) => this.fetchHostState(world, host, actor).then((remote) => ({ host, remote })))
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

  private async fetchHostState(world: WooWorld, host: string, actor: ObjRef): Promise<Record<string, unknown> | null> {
    let settled = false;
    const startedAt = Date.now();
    // The deadline now drives an AbortController, so on timeout the inner
    // fetch — and the queue waiter behind it — both wind down rather than
    // running on in the background after the outer race rejects.
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        world.recordMetric({ kind: "cross_host_rpc", route: "/__internal/state", host, ms: Date.now() - startedAt, status: "timeout" });
      }
      controller.abort(wooError("E_TIMEOUT", `host state fetch timed out: ${host}`, { host, timeout_ms: HOST_STATE_FETCH_TIMEOUT_MS }));
    }, HOST_STATE_FETCH_TIMEOUT_MS);
    try {
      const remote = await this.fetchHostStateInner(host, actor, controller.signal);
      if (!settled) {
        settled = true;
        world.recordMetric({
          kind: "cross_host_rpc",
          route: "/__internal/state",
          host,
          ms: Date.now() - startedAt,
          status: remote ? "ok" : "error",
          ...(remote ? {} : { error: "E_BAD_RESPONSE" })
        });
      }
      return remote;
    } catch (err) {
      if (!settled) {
        settled = true;
        const error = normalizeError(err);
        world.recordMetric({ kind: "cross_host_rpc", route: "/__internal/state", host, ms: Date.now() - startedAt, status: "error", error: error.code });
      }
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchHostStateInner(host: string, actor: ObjRef, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    const id = this.env.WOO.idFromName(host);
    const request = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}/__internal/state`, {
      headers: { "x-woo-host-key": host, "x-woo-internal-actor": actor }
    }));
    const { response } = await this.outboundFetch(id, request, signal);
    if (!response.ok) return null;
    const body = await response.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  }

  private async handleInternal(request: Request, world: WooWorld, pathname: string, hostKey: string): Promise<Response> {
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

      if (request.method === "POST" && pathname === "/__internal/apply-host-seed") {
        if (hostKey === WORLD_HOST) throw wooError("E_NOTAPPLICABLE", "host seed apply is only available on object hosts");
        const host = String(body.host ?? "") as ObjRef;
        if (!host) throw wooError("E_INVARG", "apply-host-seed requires host");
        if (host !== hostKey) throw wooError("E_INVARG", `host mismatch: ${host} != ${hostKey}`);
        if (!isSerializedWorld(body.seed)) throw wooError("E_INVARG", "apply-host-seed requires serialized seed");
        return jsonResponse(this.applyHostSeed(world, host, body.seed));
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
          const audienceSessions = Array.isArray(body.audience_sessions)
            ? body.audience_sessions.filter((item): item is string => typeof item === "string")
            : undefined;
          const observationSessionAudiences = Array.isArray(body.observation_session_audiences)
            ? body.observation_session_audiences.map((audience) => (
                Array.isArray(audience) ? audience.filter((item): item is string => typeof item === "string") : []
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
          this.broadcastLiveEvents(world, { op: "result", result: null, observations, audience, audienceActors, observationAudiences, audienceSessions, observationSessionAudiences });
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && pathname === "/__internal/ws-call") {
        const session = this.ensureInternalSession(
          world,
          String(body.session_id ?? ""),
          String(body.actor ?? "") as ObjRef,
          Number(body.expires_at ?? 0),
          body.token_class,
          typeof body.current_location === "string" ? body.current_location as ObjRef : undefined,
          typeof body.apikey_id === "string" ? body.apikey_id : null
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
          body.token_class,
          typeof body.current_location === "string" ? body.current_location as ObjRef : undefined,
          typeof body.apikey_id === "string" ? body.apikey_id : null
        );
        const deferredHostEffects: DeferredHostEffect[] = [];
        const result = await world.directCall(
          typeof body.frame_id === "string" ? body.frame_id : undefined,
          session.actor,
          String(body.target ?? "") as ObjRef,
          String(body.verb ?? ""),
          Array.isArray(body.args) ? body.args as WooValue[] : [],
            { sessionId: session.id, deferHostEffect: (effect) => deferredHostEffects.push(effect) }
        );
        return jsonResponse(result.op === "result" ? { ...result, deferred_host_effects: deferredHostEffects } : result);
      }

      if (request.method === "POST" && pathname === "/__internal/replay") {
        const session = this.ensureInternalSession(
          world,
          String(body.session_id ?? ""),
          String(body.actor ?? "") as ObjRef,
          Number(body.expires_at ?? 0),
          body.token_class,
          typeof body.current_location === "string" ? body.current_location as ObjRef : undefined,
          typeof body.apikey_id === "string" ? body.apikey_id : null
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

      if (request.method === "POST" && pathname === "/__internal/remote-set-prop") {
        const progr = String(body.progr ?? "") as ObjRef;
        const obj = String(body.obj ?? "") as ObjRef;
        const name = String(body.name ?? "");
        await world.setPropChecked(progr, obj, name, body.value as WooValue);
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && pathname === "/__internal/object-summary") {
        const readActor = String(body.read_actor ?? "") as ObjRef;
        const obj = String(body.obj ?? "") as ObjRef;
        return jsonResponse(await world.scopedObjectSummary(readActor, obj));
      }

      if (request.method === "POST" && pathname === "/__internal/object-summaries") {
        const readActor = String(body.read_actor ?? "") as ObjRef;
        const ids = Array.isArray(body.ids) ? body.ids.filter((item): item is ObjRef => typeof item === "string") : [];
        return jsonResponse({ objects: await world.scopedObjectSummaries(readActor, ids) });
      }

      if (request.method === "POST" && pathname === "/__internal/room-snapshot") {
        const readActor = String(body.read_actor ?? "") as ObjRef;
        const room = String(body.room ?? "") as ObjRef;
        const sessionId = typeof body.session_id === "string" ? body.session_id : null;
        return jsonResponse(await world.roomSnapshotForActor(readActor, room, sessionId));
      }

      if (request.method === "POST" && pathname === "/__internal/overlay-snapshot") {
        const readActor = String(body.read_actor ?? "") as ObjRef;
        const subject = String(body.subject ?? "") as ObjRef;
        const surface = String(body.surface ?? "default");
        const sessionId = typeof body.session_id === "string" ? body.session_id : null;
        return jsonResponse(await world.overlaySnapshotForActor(readActor, subject, surface, sessionId));
      }

      if (request.method === "POST" && pathname === "/__internal/remote-describe") {
        const readActor = String(body.read_actor ?? "") as ObjRef;
        const obj = String(body.obj ?? "") as ObjRef;
        return jsonResponse({
          name: world.object(obj).name,
          description: world.propOrNullForActor(readActor, obj, "description"),
          aliases: world.propOrNullForActor(readActor, obj, "aliases"),
          owner: world.object(obj).owner,
          obvious_verbs: world.obviousCommandSyntaxes(obj, world.object(obj).name || obj)
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
              aliases: world.propOrNullForActor(readActor, obj, "aliases"),
              owner: world.object(obj).owner,
              obvious_verbs: world.obviousCommandSyntaxes(obj, world.object(obj).name || obj)
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
        return jsonResponse({ name: verb.name, direct_callable: verb.direct_callable === true, arg_spec: verb.arg_spec ?? {} });
      }

      if (request.method === "POST" && pathname === "/__internal/remote-command-verb-candidates") {
        const target = String(body.target ?? "") as ObjRef;
        const verbName = String(body.verb ?? "");
        return jsonResponse({ candidates: world.commandVerbCandidateSummaries(target, verbName) });
      }

      if (request.method === "POST" && pathname === "/__internal/remote-is-descendant") {
        const obj = String(body.obj ?? "") as ObjRef;
        const ancestor = String(body.ancestor ?? "") as ObjRef;
        return jsonResponse({ result: world.isDescendantOf(obj, ancestor) });
      }

      if (request.method === "POST" && pathname === "/__internal/remote-is-recycled") {
        const obj = String(body.obj ?? "") as ObjRef;
        return jsonResponse({ result: world.isRecycled(obj) });
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
        const sessionId = typeof rawCtx.session === "string" ? rawCtx.session : null;
        if (sessionId && actor) {
          this.ensureInternalSession(
            world,
            sessionId,
            actor,
            Number(rawCtx.session_expires_at ?? 0),
            rawCtx.session_token_class,
            typeof rawCtx.session_current_location === "string" ? rawCtx.session_current_location as ObjRef : undefined,
            typeof rawCtx.session_apikey_id === "string" ? rawCtx.session_apikey_id : null
          );
        }
        const message = rawCtx.message && typeof rawCtx.message === "object" && !Array.isArray(rawCtx.message)
          ? rawCtx.message as Message
          : { actor, target, verb, args };
        const deferredHostEffects: DeferredHostEffect[] = [];
        const ctx: CallContext = {
          world,
          space: String(rawCtx.space ?? "#-1") as ObjRef,
          seq: Number(rawCtx.seq ?? -1),
          session: sessionId,
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
        const audiences = await world.computeDirectLiveAudiences(target, observations);
        return jsonResponse({
          result,
            observations,
            audience_actors: audiences.audienceActors,
            observation_audiences: audiences.observationAudiences,
            audience_sessions: audiences.audienceSessions,
            observation_session_audiences: audiences.observationSessionAudiences,
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
          body.present === true,
          typeof body.session === "string" ? body.session : undefined
        );
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && pathname === "/__internal/space-subscriber") {
        world.setSpaceSubscriber(
          String(body.space ?? "") as ObjRef,
          String(body.actor ?? "") as ObjRef,
          body.present === true,
          typeof body.session === "string" ? body.session : undefined
        );
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && pathname === "/__internal/space-audience-sessions") {
        const actors = Array.isArray(body.actors)
          ? body.actors.filter((item): item is ObjRef => typeof item === "string")
          : undefined;
        return jsonResponse({ sessions: world.presenceSessionIdsIn(String(body.space ?? "") as ObjRef, actors) });
      }

      if (request.method === "POST" && pathname === "/__internal/actor-session-locations") {
        return jsonResponse({ locations: world.allLocationsForActor(String(body.actor ?? "") as ObjRef) });
      }

      if (request.method === "POST" && pathname === "/__internal/actor-session-locations-batch") {
        const actors = Array.isArray(body.actors)
          ? (body.actors as unknown[]).filter((item): item is ObjRef => typeof item === "string")
          : [];
        const out: Record<ObjRef, ObjRef[]> = {};
        for (const actor of actors) out[actor] = world.allLocationsForActor(actor);
        return jsonResponse({ locations: out });
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
    rawTokenClass: unknown,
    currentLocation?: ObjRef | null,
    apikeyId?: string | null
  ): Session {
    if (!sessionId || !actor) throw wooError("E_NOSESSION", "internal forwarded call requires session and actor");
    this.ensureInternalActor(world, actor);
    const tokenClass: Session["tokenClass"] = rawTokenClass === "guest" || rawTokenClass === "apikey" ? rawTokenClass : "bearer";
    const apikeyIdValue = typeof apikeyId === "string" && apikeyId.length > 0 ? apikeyId : undefined;
    return world.ensureSessionForActor(sessionId, actor, tokenClass, Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : undefined, currentLocation, apikeyIdValue);
  }

  private ensureInternalActor(world: WooWorld, actor: ObjRef): void {
    if (world.objects.has(actor)) return;
    const parent = world.objects.has("$player") ? "$player" : world.objects.has("$actor") ? "$actor" : null;
    world.createObject({ id: actor, name: actor, parent, owner: actor });
    // No explicit property writes: first-touch actor stubs only need identity
    // and ancestry for permission checks.
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
          token_class: session.tokenClass,
          current_location: session.currentLocation,
          apikey_id: session.apikeyId ?? null
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

  private async unregisterSessionRoute(sessionId: string): Promise<void> {
    try {
      const id = this.env.DIRECTORY.idFromName(DIRECTORY_HOST);
      const request = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}/unregister-session`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ session_id: sessionId })
      }));
      await this.env.DIRECTORY.get(id).fetch(request);
    } catch {
      // Local session deletion is authoritative; stale Directory routes expire
      // closed on their normal TTL if best-effort cleanup misses.
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
        request.headers.get("x-woo-internal-token-class"),
        request.headers.get("x-woo-internal-current-location") as ObjRef | null,
        request.headers.get("x-woo-internal-apikey-id")
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
            this.indexRemoveSocket(previous.sessionId, previous.actor, ws);
        }
        const socketId = `ws-${session.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        world.attachSocket(session.id, socketId);
        ws.serializeAttachment({ sessionId: session.id, actor: session.actor, socketId });
          this.indexAddSocket(session.id, session.actor, ws);
      },
      session: () => this.liveAttachment(world, ws),
      send: (_connection, frameValue) => ws.send(JSON.stringify(frameValue)),
      call: async (frameId, session, space, messageValue) => {
        world.touchSessionInput(session.sessionId);
        const host = await this.resolveObjectHost(space, WORLD_HOST);
        const result = host === WORLD_HOST
          ? await world.call(frameId, session.sessionId, space, messageValue)
          : await this.forwardWsCall(world, host, frameId, session, space, messageValue);
        if (result.op === "applied") {
          if (host !== WORLD_HOST) await this.registerRemoteObjectRoutes(host);
        }
        return result;
      },
      command: async (frameId, session, space, text) => {
        world.touchSessionInput(session.sessionId);
        return await this.executeWsCommand(world, frameId, session, space, text);
      },
      direct: async (frameId, session, target, verb, args) => {
        world.touchSessionInput(session.sessionId);
        const host = await this.resolveObjectHost(target, WORLD_HOST);
        const { pure } = this.resolveDispatchPath(world, target, verb, host, WORLD_HOST);
        return host === WORLD_HOST
            ? await world.directCall(
                frameId,
                session.actor,
                target,
                verb,
                args,
                { sessionId: session.sessionId }
              )
          : await this.forwardWsDirect(world, host, frameId, session, target, verb, args, { pure });
      },
      replay: async (frameId, session, space, fromValue, limitValue) => {
        // Replay is recovery, not user input — does NOT touch lastInputAt.
        const host = await this.resolveObjectHost(space, WORLD_HOST);
        if (host !== WORLD_HOST) {
          return this.forwardWsReplay(world, host, frameId, session, space, fromValue, limitValue);
        }
        if (!world.hasPresence(session.actor, space)) throw wooError("E_PERM", `${session.actor} is not present in ${space}`);
        const from = Math.max(1, Number(fromValue ?? 1));
        const limit = Math.min(Math.max(1, Number(limitValue ?? 100)), 500);
        return { op: "replay", id: frameId, space, from, entries: world.replay(space, from, limit) };
      },
      deliverInput: (session, input) => {
        world.touchSessionInput(session.sessionId);
        return world.deliverInput(session.actor, input);
      },
      broadcastApplied: (frameValue, originator) => this.handleAppliedFrame(world, frameValue, originator),
      broadcastTaskResult: (result) => this.broadcastTaskResult(world, result),
      broadcastLiveEvents: (result, originator) => this.broadcastLiveEvents(world, result, null, originator)
    });
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const world = await this.getWorld();
    const att = this.attachment(ws);
    if (att) {
      world.detachSocket(att.sessionId, att.socketId);
        this.indexRemoveSocket(att.sessionId, att.actor, ws);
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
        this.indexRemoveSocket(att.sessionId, att.actor, ws);
    }
  }

    private indexAddSocket(sessionId: string, actor: ObjRef, ws: WebSocket): void {
      let set = this.socketsByActor.get(actor);
      if (!set) { set = new Set(); this.socketsByActor.set(actor, set); }
      set.add(ws);
      let sessionSet = this.socketsBySession.get(sessionId);
      if (!sessionSet) { sessionSet = new Set(); this.socketsBySession.set(sessionId, sessionSet); }
      sessionSet.add(ws);
    }

    private indexRemoveSocket(sessionId: string, actor: ObjRef, ws: WebSocket): void {
      const set = this.socketsByActor.get(actor);
      if (set) {
        set.delete(ws);
        if (set.size === 0) this.socketsByActor.delete(actor);
      }
      const sessionSet = this.socketsBySession.get(sessionId);
      if (sessionSet) {
        sessionSet.delete(ws);
        if (sessionSet.size === 0) this.socketsBySession.delete(sessionId);
      }
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
    return await this.resolveObjectHostForWorld(this.world, id, fallbackHost);
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
    args: WooValue[],
    options: { pure?: boolean } = {}
  ): Promise<DirectResultFrame | ErrorFrame> {
    const body = this.forwardBody(world, session, { frame_id: frameId, target, verb, args });
    // Pure verbs get the read deadline; mutating verbs pass through the
    // default write watchdog in forwardInternalRaw.
    const timeoutMs = options.pure === true ? this.hostReadRpcTimeoutMs() : undefined;
    const result = await this.forwardInternal<((DirectResultFrame & { deferred_host_effects?: DeferredHostEffect[] }) | ErrorFrame)>(host, "/__internal/ws-direct", body, { timeoutMs });
    if (result.op === "result" && Array.isArray(result.deferred_host_effects)) {
      await world.applyDeferredHostEffects(result.deferred_host_effects);
      delete result.deferred_host_effects;
    }
    return result;
  }

  // Helper used at every cross-host verb-dispatch site to (a) probe verb
  // purity from the local class registry and (b) emit a `dispatch_resolved`
  // event so we always have a tail trace of the verb routed to which host
  // along which path. Uses the full resolveVerb walk (parent chain + feature
  // chain), matching the way the dispatcher itself resolves at run time —
  // otherwise feature-contributed pure verbs would silently take the
  // mutating path. Best-effort: when the verb can't be resolved locally
  // (instance-only verb on a host we don't seed), defaults to `pure=false`
  // (mutating path), matching pre-flag conservative behavior.
  private resolveDispatchPath(world: WooWorld | null | undefined, target: ObjRef, verb: string, resolvedHost: string, localHost: string): { pure: boolean; path: "local" | "read" | "mutating" } {
    const local = resolvedHost === localHost;
    let pure = false;
    if (world) {
      try {
        const resolved = world.resolveVerb(target, verb);
        if (resolved.verb.pure === true) pure = true;
      } catch { /* not resolvable locally; mutating fallback */ }
    }
    const path: "local" | "read" | "mutating" = local ? "local" : (pure ? "read" : "mutating");
    world?.recordMetric({ kind: "dispatch_resolved", target, verb, host: resolvedHost, path, pure });
    return { pure, path };
  }

  private async executeWsCommand(
    world: WooWorld,
    frameId: string | undefined,
    session: { sessionId: string; actor: ObjRef },
    space: ObjRef,
    text: string
  ): Promise<CommandFrame> {
    const planned = await world.planCommand(frameId, session.sessionId, space, text);
    if (planned.op === "error") return planned;
    const plan = commandPlanFromProtocolValue(planned.result);
    if (!plan) return planned;

    if (plan.route === "direct") {
      const host = await this.resolveObjectHost(plan.target, WORLD_HOST);
      const { pure } = this.resolveDispatchPath(world, plan.target, plan.verb, host, WORLD_HOST);
      const result = host === WORLD_HOST
        ? await world.directCall(frameId, session.actor, plan.target, plan.verb, plan.args, { sessionId: session.sessionId })
        : await this.forwardWsDirect(world, host, frameId, session, plan.target, plan.verb, plan.args, { pure });
      return result.op === "result" ? { ...result, command: plan } as DirectResultFrame : result;
    }

    // If the resolved command target is itself a $space, the planner chooses
    // that space; object commands sequence through the originating surface.
    const commandSpace = plan.space ?? space;
    const message: Message = { actor: session.actor, target: plan.target, verb: plan.verb, args: plan.args };
    const host = await this.resolveObjectHost(commandSpace, WORLD_HOST);
    const result = host === WORLD_HOST
      ? await world.call(frameId, session.sessionId, commandSpace, message)
      : await this.forwardWsCall(world, host, frameId, session, commandSpace, message);
    if (result.op === "applied" && host !== WORLD_HOST) await this.registerRemoteObjectRoutes(host);
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

  private hostReadRpcTimeoutMs(): number {
    const configured = Number(this.env.WOO_HOST_READ_TIMEOUT_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : HOST_READ_RPC_TIMEOUT_MS;
  }

  private hostWriteRpcTimeoutMs(): number {
    const configured = Number(this.env.WOO_HOST_WRITE_TIMEOUT_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : HOST_WRITE_RPC_TIMEOUT_MS;
  }

  private hostOutFetchConcurrency(): number {
    const configured = Number(this.env.WOO_HOST_OUT_FETCH_CONCURRENCY);
    if (!Number.isFinite(configured) || configured <= 0) return HOST_OUT_FETCH_CONCURRENCY;
    return Math.max(1, Math.floor(configured));
  }

  // Acquire one outbound subrequest slot. If the cap is reached, the caller is
  // queued FIFO and the slot is handed off directly by releaseOutFetchSlot
  // (no decrement-then-increment, so concurrent acquire+release can't go
  // over cap). If `signal` aborts before the slot is granted, the waiter is
  // spliced from the queue and the acquire rejects — no fetch is performed,
  // no slot is consumed.
  private async acquireOutFetchSlot(signal?: AbortSignal): Promise<void> {
    if (this.outFetchInFlight < this.hostOutFetchConcurrency()) {
      this.outFetchInFlight += 1;
      return;
    }
    if (signal?.aborted) throw signal.reason ?? wooError("E_ABORTED", "outbound fetch aborted before queue");
    await new Promise<void>((resolve, reject) => {
      let aborted = false;
      // A handoff after we've already aborted: take the slot and immediately
      // release it so the next non-aborted waiter (or a fresh acquire) can use
      // it. Without this, releaseOutFetchSlot would have leaked a slot.
      const waiter: () => void = () => {
        if (signal) signal.removeEventListener("abort", onAbort);
        if (aborted) { this.releaseOutFetchSlot(); return; }
        resolve();
      };
      const onAbort = () => {
        aborted = true;
        const idx = this.outFetchQueue.indexOf(waiter);
        if (idx >= 0) this.outFetchQueue.splice(idx, 1);
        if (signal) signal.removeEventListener("abort", onAbort);
        reject(signal!.reason ?? wooError("E_ABORTED", "outbound fetch aborted while queued"));
      };
      this.outFetchQueue.push(waiter);
      signal?.addEventListener("abort", onAbort);
    });
  }

  private releaseOutFetchSlot(): void {
    const next = this.outFetchQueue.shift();
    if (next) { next(); return; }
    this.outFetchInFlight -= 1;
  }

  // Wraps the actual DO->DO fetch with the queue. `signal` is honored for
  // (a) the queue wait — aborting before a slot is granted splices the waiter
  // out of the queue without performing the fetch — and (b) the fetch itself,
  // both via the Request's signal (so the production runtime cancels the
  // subrequest) and via a manual race (so even if the underlying fetch ignores
  // the signal — e.g. in tests — the caller's await still rejects promptly
  // and our slot is released).
  private async outboundFetch(id: DurableObjectId, request: Request, signal?: AbortSignal): Promise<{ response: Response; queueMs: number }> {
    const queueStart = Date.now();
    await this.acquireOutFetchSlot(signal);
    const queueMs = Date.now() - queueStart;
    try {
      const signedRequest = signal ? new Request(request, { signal }) : request;
      const fetchPromise = this.env.WOO.get(id).fetch(signedRequest);
      if (!signal) {
        const response = await fetchPromise;
        return { response, queueMs };
      }
      const response = await raceAgainstAbort(fetchPromise, signal);
      return { response, queueMs };
    } finally {
      this.releaseOutFetchSlot();
    }
  }

  private async forwardInternal<T>(host: string, path: string, body: Record<string, unknown>, options: { timeoutMs?: number } = {}): Promise<T> {
    const bodyStr = JSON.stringify(body);
    // Single-flight: only enabled for explicitly read-only paths. Joiners get
    // the same Promise as the in-flight leader; they don't pay queue, fetch,
    // or parse cost, and they share the leader's success/error outcome.
    const coalesceKey = COALESCEABLE_INTERNAL_PATHS.has(path) ? `${host}\n${path}\n${bodyStr}` : null;
    if (coalesceKey) {
      const existing = this.outFetchInflight.get(coalesceKey) as Promise<T> | undefined;
      if (existing) return existing;
    }
    const promise = this.forwardInternalRaw<T>(host, path, bodyStr, options);
    if (coalesceKey) {
      this.outFetchInflight.set(coalesceKey, promise as Promise<unknown>);
      // Clear on settle (resolve or reject) so the next call recomputes.
      promise.then(
        () => { if (this.outFetchInflight.get(coalesceKey) === promise) this.outFetchInflight.delete(coalesceKey); },
        () => { if (this.outFetchInflight.get(coalesceKey) === promise) this.outFetchInflight.delete(coalesceKey); }
      );
    }
    return promise;
  }

  private async forwardInternalRaw<T>(host: string, path: string, bodyStr: string, options: { timeoutMs?: number }): Promise<T> {
    const id = this.env.WOO.idFromName(host);
    const request = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-woo-host-key": host
      },
      body: bodyStr
    }));
    const startedAt = Date.now();
    // Logged here so a wedged fetch leaves a trace; the existing
    // `cross_host_rpc` end event only fires on settle.
    this.world?.recordMetric({ kind: "cross_host_rpc_start", route: path, host });
    // Every cross-host RPC gets a deadline. Read-only callers pick a tight
    // one (HOST_READ_RPC_TIMEOUT_MS via forwardInternalReadChecked); mutating
    // callers fall back to the much more generous HOST_WRITE_RPC_TIMEOUT_MS
    // watchdog so a wedged downstream can't park the slot — and the entire
    // local task chain — indefinitely. The AbortController cancels both the
    // queue wait and the underlying fetch on timeout; aborting mid-write
    // can leave ambiguous remote state, but indefinite hang is the worse
    // failure mode (the whole DO becomes unresponsive).
    const timeoutMs = options.timeoutMs ?? this.hostWriteRpcTimeoutMs();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(wooError("E_TIMEOUT", `cross-host RPC timed out: ${host}${path}`, { host, path, timeout_ms: timeoutMs })), timeoutMs);
    let observedQueueMs = 0;
    try {
      const { response, queueMs } = await this.outboundFetch(id, request, controller.signal);
      observedQueueMs = queueMs;
      const parsed = await response.json() as T;
      const queueField = observedQueueMs > 0 ? { queue_ms: observedQueueMs } : {};
      this.world?.recordMetric({ kind: "cross_host_rpc", route: path, host, ms: Date.now() - startedAt, status: "ok", ...queueField });
      return parsed;
    } catch (err) {
      const queueField = observedQueueMs > 0 ? { queue_ms: observedQueueMs } : {};
      // E_TIMEOUT lifted out of the abort reason so callers see the same shape
      // as before this refactor.
      const isAbortTimeout = controller.signal.aborted && (controller.signal.reason as { code?: string } | undefined)?.code === "E_TIMEOUT";
      if (isAbortTimeout) {
        this.world?.recordMetric({ kind: "cross_host_rpc", route: path, host, ms: Date.now() - startedAt, status: "timeout", ...queueField });
        throw controller.signal.reason;
      }
      const error = normalizeError(err);
      this.world?.recordMetric({ kind: "cross_host_rpc", route: path, host, ms: Date.now() - startedAt, status: "error", error: error.code, ...queueField });
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async forwardInternalChecked<T>(host: string, path: string, body: Record<string, unknown>, options: { timeoutMs?: number } = {}): Promise<T> {
    const parsed = await this.forwardInternal<T | { error?: unknown }>(host, path, body, options);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "error" in parsed && (parsed as { error?: unknown }).error) {
      throw normalizeError((parsed as { error: unknown }).error);
    }
    return parsed as T;
  }

  private async forwardInternalReadChecked<T>(host: string, path: string, body: Record<string, unknown>): Promise<T> {
    return await this.forwardInternalChecked<T>(host, path, body, { timeoutMs: this.hostReadRpcTimeoutMs() });
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
      current_location: local?.currentLocation ?? null,
      ...(local?.apikeyId !== undefined ? { apikey_id: local.apikeyId } : {}),
      ...extra
    };
  }

    private broadcastApplied(world: WooWorld, frame: AppliedFrame, originator?: WebSocket, originMcpSessionId?: string | null): void {
      const startedAt = Date.now();
      const data = JSON.stringify(frame);
      const publicFrame = publicAppliedFrame(frame);
      const dataNoId = JSON.stringify(publicFrame);
      let audienceSize = 0;
      if (originator?.readyState === WebSocket.OPEN) {
        try {
          originator.send(data);
          audienceSize += 1;
        } catch {
          // socket gone; webSocketClose will clean up
        }
      }
      const sendSockets = (sockets: Set<WebSocket> | undefined): void => {
        if (!sockets) return;
        for (const ws of sockets) {
          if (ws === originator) continue;
          audienceSize += 1;
          try {
            ws.send(dataNoId);
          } catch {
            // socket gone; webSocketClose will clean up
          }
        }
      };
      if (frame.audienceSessions) {
        for (const sessionId of frame.audienceSessions) sendSockets(this.socketsBySession.get(sessionId));
      } else {
        const audience = world.presenceActorsIn(frame.space);
        if (audience) {
          for (const actor of audience) sendSockets(this.socketsByActor.get(actor));
        }
      }
    this.mcpGateway?.routeAppliedFrame(publicFrame, originMcpSessionId ?? null);
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

  private broadcastLiveEvents(world: WooWorld, result: DirectResultFrame, originMcpSessionId?: string | null, originator?: WebSocket): void {
    if (!result.audience) return;
    const startedAt = Date.now();
    let audienceSize = 0;
    result.observations.forEach((observation, index) => {
      const frame: LiveEventFrame = { op: "event", observation };
      audienceSize += this.broadcastLiveEvent(
        world,
        frame,
        result.audience!,
        result.observationAudiences?.[index] ?? result.audienceActors,
        result.observationSessionAudiences?.[index] ?? result.audienceSessions,
        originator
      );
    });
    this.mcpGateway?.routeLiveEvents(result, originMcpSessionId ?? null);
    world.recordMetric({ kind: "broadcast", audience_size: audienceSize, obs_count: result.observations.length, ms: Date.now() - startedAt });
  }

  private broadcastLiveEvent(world: WooWorld, frame: LiveEventFrame, audience: ObjRef, audienceActors?: ObjRef[], audienceSessions?: string[], originator?: WebSocket): number {
    const data = JSON.stringify(frame);
    const { to: directedTo, from: directedFrom } = directedRecipients(frame.observation);
    let delivered = 0;
    const sendAll = (sockets: Set<WebSocket> | undefined): void => {
      if (!sockets) return;
      for (const ws of sockets) {
        if (ws === originator) continue;
        delivered += 1;
        try { ws.send(data); } catch { /* gone */ }
      }
    };
    if (directedTo || directedFrom) {
      if (directedTo) sendAll(this.socketsByActor.get(directedTo));
      if (directedFrom && directedFrom !== directedTo) sendAll(this.socketsByActor.get(directedFrom));
      return delivered;
    }
    if (audienceSessions) {
      for (const sessionId of audienceSessions) sendAll(this.socketsBySession.get(sessionId));
      // If every session lookup missed (typical when the space's
      // session_subscribers row contains stale/expired session IDs that no
      // longer have a live WebSocket on this DO), fall through to actor-keyed
      // delivery so live participants still receive room-wide events.
      if (delivered > 0) return delivered;
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

function chunkTombstones(records: TombstoneRecord[], chunkSize: number): TombstoneRecord[][] {
  if (records.length === 0) return [[]]; // always send at least one batch with final=true
  const out: TombstoneRecord[][] = [];
  for (let i = 0; i < records.length; i += chunkSize) {
    out.push(records.slice(i, i + chunkSize));
  }
  return out;
}

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

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  if (status === 304) return new Response(null, { status, headers });
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
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

function isSerializedWorld(value: unknown): value is SerializedWorld {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<Record<keyof SerializedWorld, unknown>>;
  return Array.isArray(candidate.objects) &&
    Array.isArray(candidate.sessions) &&
    Array.isArray(candidate.logs) &&
    Array.isArray(candidate.snapshots) &&
    Array.isArray(candidate.parkedTasks);
}

function uniqueRoutes(routes: Array<{ id: string; host: string; anchor: string | null }>): Array<{ id: string; host: string; anchor: string | null }> {
  const byId = new Map<string, { id: string; host: string; anchor: string | null }>();
  for (const route of routes) {
    if (!route?.id || !route.host) continue;
    byId.set(route.id, route);
  }
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function commandPlanFromProtocolValue(value: WooValue): { route: "direct" | "sequenced"; space: ObjRef | null; target: ObjRef; verb: string; args: WooValue[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const map = value as Record<string, WooValue>;
  if (map.ok !== true) return null;
  if (map.route !== "direct" && map.route !== "sequenced") return null;
  if (typeof map.target !== "string" || typeof map.verb !== "string") return null;
  return {
    route: map.route,
    space: typeof map.space === "string" ? map.space : null,
    target: map.target,
    verb: map.verb,
    args: Array.isArray(map.args) ? map.args : []
  };
}

function isReadAvailabilityError(err: unknown): boolean {
  const error = normalizeError(err);
  return error.code === "E_TIMEOUT" || error.code === "E_OBJNF";
}

async function workerHashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function logCatalogTapEvent(event: CatalogTapLogEvent): void {
  console.log("woo.catalog", JSON.stringify({ ...event, ts: Date.now() }));
}

function metricErrorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : "E_INTERNAL";
}
