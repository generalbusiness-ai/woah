// MCP host — singleton per WooWorld. Registers $actor:wait/focus/etc. native
// handlers ONCE at construction; per-MCP-session state (observation queue,
// pending waiters) lives in a Map keyed by Mcp-Session-Id.
//
// Implements spec/protocol/mcp.md §M3 (reachability), §M4 (wait queue),
// and §M2 (verb-to-tool mapping with route classification). Transport
// (stdio/HTTP) lives in src/mcp/server.ts; this module is transport-agnostic.

import type { WooWorld } from "../core/world";
import type { EffectTranscript } from "../core/effect-transcript";
import type { AppliedFrame, DirectResultFrame, ErrorFrame, Message, ObjRef, Observation, RemoteToolDescriptor, RemoteToolProjection, RemoteToolRequest, WooValue } from "../core/types";
import type { ShadowCommitAccepted } from "../core/shadow-commit-scope";
import type { ProjectionFreshness, SessionToolManifest } from "../core/projection-delta";
import { directedRecipients, wooError } from "../core/types";

// Broadcast hooks the runtime wires into the MCP host so that MCP-initiated
// direct and sequenced calls fan out to attached WebSocket / SSE clients the
// same way REST-initiated calls do. Without these, an MCP agent's chat would
// be invisible to humans on the gateway's WS.
export type McpBroadcastHooks = {
  broadcastApplied?: (frame: AppliedFrame, originSessionId?: string | null) => void | Promise<void>;
  broadcastLiveEvents?: (result: DirectResultFrame, originSessionId?: string | null) => void | Promise<void>;
};

export type McpAcceptedFrameAudience = {
  audienceActors?: ObjRef[];
  observationAudiences?: ObjRef[][];
  audienceSessions?: string[];
  observationSessionAudiences?: string[][];
};

const QUEUE_HARD_CAP = 4096;
const DEFAULT_LIMIT = 64;
const MAX_LIMIT = 256;
const DEFAULT_TOOL_PAGE_LIMIT = 40;
const MAX_TOOL_PAGE_LIMIT = 200;
const MAX_TIMEOUT_MS = 30_000;
const OBJECT_VERB_SEP = "\u0000";

type SessionQueue = {
  actor: ObjRef;
  observations: Observation[];
  lostSinceMark: number;
  firstLostTs: number | null;
  waiters: Set<{ resolve: () => void; timer: ReturnType<typeof setTimeout> | null }>;
};

export type McpReachable = {
  id: ObjRef;
  origin: "self" | "location" | "contents" | "inventory" | "presence" | "focus";
};

export type McpTool = {
  name: string;
  object: ObjRef;
  verb: string;
  aliases: string[];
  description: string;
  inputSchema: Record<string, unknown>;
  direct: boolean;
  persistence: "durable" | "live";
  readsRoomPresence?: boolean;
  enclosingSpace: ObjRef | null;
  descriptor?: RemoteToolDescriptor;
};

export type McpToolScope = "active" | "here" | "focus" | "object" | "space" | "all";

export type McpToolListOptions = {
  scope?: McpToolScope;
  object?: ObjRef;
  query?: string;
  limit?: number;
  cursor?: string;
  sessionId?: string;
};

export type McpToolListPage = {
  scope: McpToolScope;
  object?: ObjRef;
  query?: string;
  limit: number;
  cursor: string | null;
  nextCursor: string | null;
  total: number;
  tools: McpTool[];
};

export type McpInvocationResult = {
  result: WooValue;
  observations: Observation[];
  applied?: { space: ObjRef; seq: number; ts: number };
};

export type McpDispatchHooks = {
  direct?: (sessionId: string, actor: ObjRef, target: ObjRef, verb: string, args: WooValue[], scope?: ObjRef | null, persistence?: "durable" | "live", options?: { directorySessionScopes?: ObjRef[] }) => McpDirectDispatchFrame | ErrorFrame | Promise<McpDirectDispatchFrame | ErrorFrame>;
  call?: (sessionId: string, actor: ObjRef, space: ObjRef, message: Message) => McpAppliedDispatchFrame | ErrorFrame | Promise<McpAppliedDispatchFrame | ErrorFrame>;
};

export type McpToolManifestHooks = {
  staleFallback?: boolean;
  loadSessionManifest?: (sessionId: string) => Promise<SessionToolManifest | null> | SessionToolManifest | null;
  saveSessionManifest?: (manifest: SessionToolManifest) => Promise<void> | void;
};

type McpTranscriptBearing = { transcript?: EffectTranscript };
type McpDirectDispatchFrame = DirectResultFrame & McpTranscriptBearing;
type McpAppliedDispatchFrame = AppliedFrame & McpTranscriptBearing;
type McpToolRefreshDecision = { refresh: boolean; reason: string; transcript: boolean };
type McpToolRefreshBaseline = { digest: string; location: ObjRef | null; activeScopes: string };
type McpToolRefreshSource = "invoke" | "accepted_frame";
type McpVerbInfo = {
  name: string;
  aliases: string[];
  arg_spec: Record<string, WooValue>;
  direct_callable?: boolean;
  perms: string;
  tool_exposed?: boolean;
  reads_room_presence?: boolean;
  source?: string;
  owner?: ObjRef;
};

// One cached verb surface for a (projection, actor, surface-identity) key —
// shared across same-parent objects with no own verbs, but object-unique for an
// object that defines its own (see verbSurfaceClassKey). `obvious` holds the raw
// obviousCommandVerbs result; `tooled` holds the collected {verb, owner} pairs
// from computeTooledVerbs. Every field stored is stable for that key: the
// per-object `owner` default for the obvious projection is re-applied by
// obviousVerbsFor on each call, never baked into the cached array. Entry
// validity is governed by the cache-wide mutation-version epoch, not per entry.
type TooledVerbEntry = { verb: McpVerbInfo; owner: ObjRef };
type VerbSurfaceCacheEntry = { obvious?: McpVerbInfo[]; tooled?: TooledVerbEntry[] };

// `actor_wait` runs through the standard verb-dispatch path, which doesn't
// thread the MCP session id through CallContext. McpHost.invokeTool sets this
// before dispatching the wait verb so the native handler can find the right
// per-session queue. Single-threaded JS makes this safe.
let CURRENT_WAIT_SESSION_ID: string | null = null;

export class McpHost {
  private queues = new Map<string, SessionQueue>();
  private listChangedListeners = new Set<(actor: ObjRef) => void>();
  private toolListSnapshot = new Map<string, string>();
  private sessionToolManifests = new Map<string, SessionToolManifest>();

  // Tool-surface verb cache. Computing the obvious/tooled verb surface for an
  // object walks its full ancestry + feature chain and runs a permission check
  // per verb (obviousCommandVerbs / computeTooledVerbs). enumerateLocalToolDescriptors
  // does this for EVERY child of a $space under expandContents — e.g. every node
  // in an outline whose items live in the space's contents — which made
  // enumeration O(items x ancestry x verbs) and pushed large shared scopes
  // (the_outline) past the 5s host read-RPC budget, yielding zero tools and a
  // downstream E_VERBNF. The surface is fully determined by (projection, actor,
  // the object's class lineage + its own verbs/features), so same-parent items
  // with no own verbs share one key (the outline fan-out collapses); an object
  // that defines its own verbs keys uniquely (see verbSurfaceClassKey). The
  // whole cache is valid only for a single world mutation-version epoch (same
  // idiom as world.hostSeedCache): any mutation clears it, so a verb/perm/
  // feature/actor edit is always observed and entries never linger stale. Within
  // one synchronous enumerate the version is fixed, so same-class items collapse
  // to one walk; across calls the cache also holds until the next mutation. A
  // coarse cap guards a pathological epoch that touches a very large number of
  // distinct keys.
  private verbSurfaceCache = new Map<string, VerbSurfaceCacheEntry>();
  private verbSurfaceCacheVersion = -1;
  private static readonly VERB_SURFACE_CACHE_MAX = 16384;

  private broadcasts: McpBroadcastHooks = {};

  constructor(private world: WooWorld, private dispatchHooks: McpDispatchHooks = {}, private manifestHooks: McpToolManifestHooks = {}) {
    // The actor_focus/unfocus/focus_list/wait native handlers are registered
    // by WooWorld's constructor (see registerNativeHandlers in world.ts) so
    // they remain installed when the actor's home DO wakes from hibernation
    // via /__internal/remote-dispatch — that path resolves verbs without ever
    // constructing an McpHost.
    //
    // McpHost.invokeTool short-circuits the actor's *own* wait tool directly
    // to drainWait(sessionId). But cross-actor wait dispatch (one session's
    // invokeTool reaching another actor's wait verb) reaches this world via
    // world.directCall and needs queue-aware draining keyed by CURRENT_WAIT_
    // SESSION_ID. Override the world.ts no-op only when McpHost is present;
    // it's safe because invokeTool sets/restores CURRENT_WAIT_SESSION_ID
    // around every dispatch.
    this.world.registerNativeHandler("actor_wait", async (_ctx, args) => {
      const sessionId = CURRENT_WAIT_SESSION_ID;
      if (!sessionId) return emptyDrain();
      return await this.drainWait(sessionId, args);
    });
  }

  setBroadcastHooks(hooks: McpBroadcastHooks): void {
    this.broadcasts = hooks;
  }

  // ----- session lifecycle -----

  bindSession(sessionId: string, actor: ObjRef): void {
    if (!this.queues.has(sessionId)) this.queues.set(sessionId, makeQueue(actor));
  }

  unbindSession(sessionId: string): void {
    const queue = this.queues.get(sessionId);
    if (!queue) return;
    for (const waiter of queue.waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve();
    }
    queue.waiters.clear();
    this.queues.delete(sessionId);
    this.toolListSnapshot.delete(sessionId);
  }

  onToolListChanged(listener: (actor: ObjRef) => void): () => void {
    this.listChangedListeners.add(listener);
    return () => { this.listChangedListeners.delete(listener); };
  }

  // ----- external observation routing (broadcast-side fan-out) -----

  // Called by the runtime's broadcastApplied path (dev-server / worker DO).
  // Prefer the frame's session audience; older frames fall back to actor
  // presence in the frame's space.
  routeAppliedFrame(frame: AppliedFrame, originSessionId?: string | null): void {
    if (!frame.observations.length) return;
    const sessionAudience = frame.audienceSessions ? new Set(frame.audienceSessions) : null;
    for (const [sessionId, queue] of this.queues) {
      if (originSessionId && sessionId === originSessionId) continue;
      if (sessionAudience ? !sessionAudience.has(sessionId) : !this.actorSubscribes(queue.actor, frame.space)) continue;
      for (const observation of frame.observations) this.enqueueFor(sessionId, observation);
    }
  }

  // Called by the runtime's broadcastLiveEvents path. For each observation,
  // enqueue to every session whose actor is in the audience (per-observation
  // audience hint, with a presence fallback). Skip the originating session;
  // its own observations travel back via the call result.
  routeLiveEvents(result: DirectResultFrame, originSessionId?: string | null): void {
    const observations = result.observations ?? [];
    for (let i = 0; i < observations.length; i++) {
      const observation = observations[i];
      const sessionAudience = result.observationSessionAudiences?.[i] ?? result.audienceSessions ?? null;
      let queuesScanned = 0;
      let deliveries = 0;
      if (sessionAudience) {
        const sessionSet = new Set(sessionAudience);
        for (const sessionId of sessionSet) {
          queuesScanned += 1;
          if (originSessionId && sessionId === originSessionId) continue;
          if (!this.queues.has(sessionId)) continue;
          this.enqueueFor(sessionId, observation);
          deliveries += 1;
        }
        this.world.recordMetric({
          kind: "mcp_observation_routed",
          scope: typeof result.audience === "string" ? (result.audience as ObjRef) : ("?" as ObjRef),
          observation_type: String(observation.type ?? ""),
          queues_scanned: queuesScanned,
          deliveries,
          route: "live"
        });
        continue;
      }
      const audience = result.observationAudiences?.[i] ?? result.audienceActors ?? null;
      const audienceSet = audience ? new Set(audience) : null;
      const directed = directedRecipients(observation);
      const directedActors = new Set<ObjRef>();
      if (directed.to) directedActors.add(directed.to);
      if (directed.from) directedActors.add(directed.from);
      const sourceScope = typeof observation.source === "string" ? observation.source : null;
      for (const [sessionId, queue] of this.queues) {
        queuesScanned += 1;
        if (originSessionId && sessionId === originSessionId) continue;
        const sessionLocation = this.world.activeScopeForSession(sessionId);
        const shouldDeliver = audienceSet
          ? audienceSet.has(queue.actor)
          : directedActors.size > 0
            ? directedActors.has(queue.actor)
            : !!result.audience && (
              this.actorSubscribes(queue.actor, result.audience) ||
              sessionLocation === result.audience ||
              (sourceScope !== null && (this.actorSubscribes(queue.actor, sourceScope) || sessionLocation === sourceScope))
            );
        if (shouldDeliver) {
          this.enqueueFor(sessionId, observation);
          deliveries += 1;
        }
      }
      this.world.recordMetric({
        kind: "mcp_observation_routed",
        scope: typeof result.audience === "string" ? (result.audience as ObjRef) : ("?" as ObjRef),
        observation_type: String(observation.type ?? ""),
        queues_scanned: queuesScanned,
        deliveries,
        route: "live"
      });
    }
  }

  // v2 commit-scope accepted frames are the pure-v2 observation source.
  // Prefer the commit gateway's session audience because receiving shards can
  // be behind on session.activeScope during the move that produced the frame.
  // Older frames fall back to actor/direct/scope routing.
  routeShadowAcceptedFrame(
    frame: ShadowCommitAccepted,
    originSessionId?: string | null,
    transcript?: EffectTranscript,
    audience?: McpAcceptedFrameAudience
  ): void {
    if (!frame.observations.length) return;
    const refreshSessions = new Set<string>();
    const refreshDecisionByActor = new Map<ObjRef, McpToolRefreshDecision>();
    const refreshDecisionForActor = (actor: ObjRef): McpToolRefreshDecision => {
      const cached = refreshDecisionByActor.get(actor);
      if (cached) return cached;
      const decision = this.toolRefreshDecisionAfterTranscript(actor, transcript);
      refreshDecisionByActor.set(actor, decision);
      this.recordToolRefreshDecision(actor, "accepted_frame", decision);
      return decision;
    };
    for (let index = 0; index < frame.observations.length; index += 1) {
      const observation = frame.observations[index];
      const sessionAudience = audience?.observationSessionAudiences?.[index] ?? audience?.audienceSessions ?? null;
      const actorAudience = audience?.observationAudiences?.[index] ?? audience?.audienceActors ?? null;
      const directed = directedRecipients(observation);
      const directedActors = new Set<ObjRef>();
      if (directed.to) directedActors.add(directed.to);
      if (directed.from) directedActors.add(directed.from);
      let queuesScanned = 0;
      let deliveries = 0;
      if (sessionAudience) {
        const sessionSet = new Set(sessionAudience);
        for (const sessionId of sessionSet) {
          queuesScanned += 1;
          if (originSessionId && sessionId === originSessionId) continue;
          const queue = this.queues.get(sessionId);
          if (!queue) continue;
          this.enqueueFor(sessionId, observation);
          deliveries += 1;
          if (refreshDecisionForActor(queue.actor).refresh) refreshSessions.add(sessionId);
        }
        this.world.recordMetric({
          kind: "mcp_observation_routed",
          scope: frame.position.scope,
          observation_type: String(observation.type ?? ""),
          queues_scanned: queuesScanned,
          deliveries,
          route: "accepted"
        });
        continue;
      }
      const actorAudienceSet = actorAudience ? new Set(actorAudience) : null;
      for (const [sessionId, queue] of this.queues) {
        queuesScanned += 1;
        if (originSessionId && sessionId === originSessionId) continue;
        const sessionLocation = this.world.activeScopeForSession(sessionId);
        const sourceScope = typeof observation.source === "string" ? observation.source : null;
        const shouldDeliver = actorAudienceSet
          ? actorAudienceSet.has(queue.actor)
          : directedActors.size > 0
            ? directedActors.has(queue.actor)
            : this.actorSubscribes(queue.actor, frame.position.scope) ||
              sessionLocation === frame.position.scope ||
              (sourceScope !== null && (this.actorSubscribes(queue.actor, sourceScope) || sessionLocation === sourceScope));
        if (shouldDeliver) {
          this.enqueueFor(sessionId, observation);
          deliveries += 1;
          if (refreshDecisionForActor(queue.actor).refresh) refreshSessions.add(sessionId);
        }
      }
      // Per-observation summary. Audience drops show as `queues_scanned > 0`
      // but `deliveries === 0`. "Shard has nobody to deliver to" shows as
      // `queues_scanned === 0`.
      this.world.recordMetric({
        kind: "mcp_observation_routed",
        scope: frame.position.scope,
        observation_type: String(observation.type ?? ""),
        queues_scanned: queuesScanned,
        deliveries,
        route: "accepted"
      });
    }
    for (const sessionId of refreshSessions) {
      const queue = this.queues.get(sessionId);
      if (queue) void this.refreshToolList(sessionId, queue.actor).catch(() => {});
    }
  }

  private actorSubscribes(actor: ObjRef, space: ObjRef): boolean {
    if (!this.world.objects.has(space)) return false;
    const subs = this.subscriberList(space);
    return subs.includes(actor);
  }

  private subscriberList(space: ObjRef): ObjRef[] {
    if (!this.world.objects.has(space)) return [];
    const raw = this.world.propOrNull(space, "subscribers");
    return Array.isArray(raw) ? raw.filter((item): item is ObjRef => typeof item === "string") : [];
  }

  private enqueueFor(sessionId: string, observation: Observation): void {
    const queue = this.queues.get(sessionId);
    if (!queue) return;
    if (queue.observations.length >= QUEUE_HARD_CAP) {
      queue.lostSinceMark += 1;
      if (queue.firstLostTs === null) queue.firstLostTs = Date.now();
      return;
    }
    queue.observations.push(observation);
    if (queue.waiters.size > 0) {
      for (const waiter of Array.from(queue.waiters)) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve();
        queue.waiters.delete(waiter);
      }
    }
  }

  // ----- reachability / tool list -----

  reachable(actor: ObjRef): McpReachable[] {
    const seen = new Map<ObjRef, McpReachable["origin"]>();
    const add = (id: ObjRef, origin: McpReachable["origin"], requireLocal = true): void => {
      if (requireLocal && !this.world.objects.has(id)) return;
      if (!seen.has(id)) seen.set(id, origin);
    };
    add(actor, "self");
    const actorObj = this.world.objects.has(actor) ? this.world.object(actor) : null;
    const activeLocations = this.world.allLocationsForActor(actor);
    // Session-driven activeScope wins over actorObj.location. The gateway
    // shard's actor row is a cross-host cache that can fall through to
    // $player.home's class default ("$nowhere") when the durable copy of
    // the actor row hasn't been refreshed since the last move — the
    // gateway is the session's host, not the actor's host, so its cached
    // actor.location can lag without surfacing as null/undefined. Reading
    // session.activeScope first makes the reachability check independent
    // of that cache, fixing the actor_loc=$nowhere divergent state hit by
    // the cross-actor smoke (memory/divergent_session_state_race.md).
    // We still fall back to actorObj.location for code paths with no
    // session (admin probes, postflight checks) and for actors whose
    // session has detached.
    const activeScope = activeLocations[0] ?? actorObj?.location ?? null;
    if (activeScope) add(activeScope, "location", false);
    if (activeScope && this.world.objects.has(activeScope) && this.descendsFrom(activeScope, "$space")) {
      for (const id of this.world.object(activeScope).contents) {
        if (this.actorCanSee(actor, id)) add(id, "contents");
      }
    }
    if (actorObj) for (const id of actorObj.contents) {
      if (this.isOtherActor(actor, id)) continue;
      if (this.actorCanSee(actor, id)) add(id, "inventory");
    }
    for (const id of activeLocations) if (id !== activeScope) add(id, "presence", false);
    const focusList = this.focusListOf(actor);
    for (const id of focusList) {
      if (this.world.objects.has(id)) {
        if (this.isOtherActor(actor, id)) continue;
        if (this.actorCanSee(actor, id)) add(id, "focus");
      } else {
        add(id, "focus", false);
      }
    }
    return Array.from(seen, ([id, origin]) => ({ id, origin }));
  }

  // Visibility check used by reachability and focus. The actor must be able to
  // see the object at all — minimum bar is being able to read its name (the
  // standard `:describe` surface does this). canReadProperty already short-
  // circuits for wizards via its internal canBypassPerms call.
  private actorCanSee(actor: ObjRef, target: ObjRef): boolean {
    if (!this.world.objects.has(target)) return false;
    return this.world.canReadProperty(actor, target, "name");
  }

  private isOtherActor(actor: ObjRef, target: ObjRef): boolean {
    return target !== actor && this.isActorObject(target) && !this.isBlockObject(target);
  }

  private isActorObject(target: ObjRef): boolean {
    if (!this.world.objects.has(target)) return false;
    let cursor: ObjRef | null = target;
    while (cursor && this.world.objects.has(cursor)) {
      if (cursor === "$actor") return true;
      cursor = this.world.object(cursor).parent;
    }
    return false;
  }

  private isBlockObject(target: ObjRef): boolean {
    return this.world.objects.has("$block") && this.descendsFrom(target, "$block");
  }

  async listTools(actor: ObjRef, options: McpToolListOptions = {}): Promise<McpToolListPage> {
    const scope = options.scope ?? "active";
    const limit = clampInt(options.limit, 1, MAX_TOOL_PAGE_LIMIT, DEFAULT_TOOL_PAGE_LIMIT);
    const offset = parseCursor(options.cursor);
    const filtered = await this.enumerateToolsForScope(actor, scope, options.object, options.query, options.sessionId);
    const tools = filtered.slice(offset, offset + limit);
    const nextOffset = offset + tools.length;
    return {
      scope,
      object: options.object,
      query: options.query,
      limit,
      cursor: options.cursor ?? null,
      nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
      total: filtered.length,
      tools
    };
  }

  async enumerateTools(actor: ObjRef, options: McpToolListOptions = {}): Promise<McpTool[]> {
    const scope = options.scope ?? "all";
    const filtered = await this.enumerateToolsForScope(actor, scope, options.object, options.query, options.sessionId);
    if (options.limit === undefined && options.cursor === undefined) return filtered;
    const limit = clampInt(options.limit, 1, MAX_TOOL_PAGE_LIMIT, filtered.length || DEFAULT_TOOL_PAGE_LIMIT);
    const offset = parseCursor(options.cursor);
    return filtered.slice(offset, offset + limit);
  }

  private async enumerateToolsForScope(actor: ObjRef, scope: McpToolScope, object: ObjRef | undefined, query: string | undefined, sessionId?: string): Promise<McpTool[]> {
    const plan = await this.toolScopePlan(actor, scope, object, sessionId);
    const tools: McpTool[] = [];
    const usedNames = new Set<string>();
    const seenObjectVerb = new Set<string>();

    for (const id of plan.selectedIds) {
      if (!this.world.objects.has(id)) continue;
      const verbs = plan.obviousOnlyIds.has(id) ? this.obviousVerbsFor(actor, id) : this.tooledVerbsFor(actor, id);
      for (const verb of verbs) {
        const tool = this.assembleTool(id, {
          verb: verb.name,
          aliases: verb.aliases,
          arg_spec: verb.arg_spec,
          direct: verb.direct_callable === true,
          ...(verb.reads_room_presence === true ? { reads_room_presence: true } : {}),
          source: verb.source ?? "",
          enclosingSpace: this.enclosingSpaceFor(id)
        }, usedNames);
        tools.push(tool);
        seenObjectVerb.add(`${id}${OBJECT_VERB_SEP}${verb.name}`);
      }
    }

    const bridge = this.world.getExecutorContext();
    const addRemoteDescriptors = (descriptors: RemoteToolDescriptor[], filterToSelected: boolean): void => {
      for (const d of descriptors) {
        if (filterToSelected && !plan.selectedIds.has(d.object)) continue;
        const key = `${d.object}${OBJECT_VERB_SEP}${d.verb}`;
        if (seenObjectVerb.has(key)) continue;
        seenObjectVerb.add(key);
        tools.push(this.assembleTool(d.object, d, usedNames));
      }
    };
    if (bridge?.enumerateRemoteTools) {
      let selectedDescriptors: RemoteToolDescriptor[] = [];
      let remoteFailed = false;
      try {
        if (plan.remoteRequests.length > 0) selectedDescriptors = await bridge.enumerateRemoteTools(actor, plan.remoteRequests);
      } catch {
        remoteFailed = true;
      }
      if ((remoteFailed || selectedDescriptors.length === 0) && sessionId && plan.remoteRequests.length > 0) {
        selectedDescriptors = this.filterManifestDescriptors(
          await this.sessionManifestDescriptors(sessionId, remoteFailed ? "owner_timeout" : "cache_miss"),
          plan
        );
      }
      addRemoteDescriptors(selectedDescriptors, false);
    }

    return filterTools(tools, query);
  }

  private async toolScopePlan(
    actor: ObjRef,
    scope: McpToolScope,
    object: ObjRef | undefined,
    sessionId?: string
  ): Promise<{ selectedIds: Set<ObjRef>; obviousOnlyIds: Set<ObjRef>; remoteRequests: RemoteToolRequest[] }> {
    const selectedIds = new Set<ObjRef>();
    const obviousOnlyIds = new Set<ObjRef>();
    const remoteCandidates = new Map<ObjRef, RemoteToolProjection>();
    const remoteExpandCandidates = new Map<ObjRef, RemoteToolProjection>();
    const actorObj = this.world.objects.has(actor) ? this.world.object(actor) : null;
    const activeLocations = this.world.allLocationsForActor(actor);
    const sessionScope = sessionId ? this.world.activeScopeForSession(sessionId) : null;
    const activeScope = sessionScope ?? activeLocations[0] ?? actorObj?.location ?? null;
    const focus = this.focusListOf(actor);
    const reachable = this.reachable(actor);
    const reachableOrigins = new Map(reachable.map((entry) => [entry.id, entry.origin]));
    const reachableIds = new Set(reachableOrigins.keys());

    const add = (id: ObjRef | null | undefined, remoteCandidate = true, projection: "tools" | "obvious" = "tools"): void => {
      if (!id) return;
      selectedIds.add(id);
      if (projection === "obvious") obviousOnlyIds.add(id);
      else obviousOnlyIds.delete(id);
      if (remoteCandidate) remoteCandidates.set(id, projection);
    };
    const addIfReachable = (id: ObjRef | null | undefined): void => {
      if (!id) return;
      if (id === actor || id === activeScope || reachableIds.has(id) || activeLocations.includes(id) || focus.includes(id)) {
        add(id, true, reachableOrigins.get(id) === "contents" && !focus.includes(id) ? "obvious" : "tools");
      }
    };
    const addContents = (space: ObjRef | null | undefined): void => {
      if (!space || !this.world.objects.has(space) || !this.descendsFrom(space, "$space")) return;
      for (const child of this.world.object(space).contents) {
        if (this.actorCanSee(actor, child)) add(child, false, "obvious");
      }
    };
    const expandRemoteContents = (space: ObjRef | null | undefined, contentsProjection: RemoteToolProjection = "obvious"): void => {
      if (space) remoteExpandCandidates.set(space, contentsProjection);
    };

    switch (scope) {
      case "active":
        add(actor, false);
        add(activeScope);
        if (actorObj) for (const id of actorObj.contents) addIfReachable(id);
        for (const id of activeLocations) add(id);
        for (const id of focus) add(id);
        break;
      case "here":
        add(activeScope);
        addContents(activeScope);
        expandRemoteContents(activeScope);
        break;
      case "focus":
        for (const id of focus) add(id);
        break;
      case "object":
        if (object) addIfReachable(object);
        break;
      case "space": {
        const target = object ?? activeScope;
        addIfReachable(target);
        addContents(target);
        expandRemoteContents(target);
        break;
      }
      case "all":
        for (const { id, origin } of reachable) add(id, true, origin === "contents" ? "obvious" : "tools");
        for (const id of activeLocations) {
          add(id);
        }
        for (const id of focus) {
          add(id);
        }
        expandRemoteContents(activeScope);
        break;
    }

    const requestById = new Map<ObjRef, RemoteToolRequest>();
    for (const [id, projection] of remoteCandidates) {
      if (id === actor) continue;
      if (!await this.world.isRemoteObject(id)) continue;
      requestById.set(id, { id, projection });
    }
    for (const [id, contentsProjection] of remoteExpandCandidates) {
      if (id === actor) continue;
      if (!await this.world.isRemoteObject(id)) continue;
      const request = requestById.get(id) ?? { id, projection: "tools" as const };
      request.expandContents = true;
      request.contentsProjection = contentsProjection;
      requestById.set(id, request);
    }
    return { selectedIds, obviousOnlyIds, remoteRequests: Array.from(requestById.values()) };
  }

  // Computes tool descriptors for the given requests — the remote-side
  // counterpart of cross-host enumeration. The caller owns the reachability
  // projection choice; the remote host only applies it under local permissions.
  enumerateLocalToolDescriptors(actor: ObjRef, requests: RemoteToolRequest[]): RemoteToolDescriptor[] {
    const out: RemoteToolDescriptor[] = [];
    const seen = new Set<string>();
    const emit = (id: ObjRef, projection: "tools" | "obvious" = "tools"): void => {
      if (!this.world.objects.has(id)) return;
      if (!this.actorCanSee(actor, id)) return;
      const verbs = projection === "obvious" ? this.obviousVerbsFor(actor, id) : this.tooledVerbsFor(actor, id);
      for (const verb of verbs) {
        const key = `${id}${OBJECT_VERB_SEP}${verb.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          object: id,
          verb: verb.name,
          aliases: verb.aliases,
          arg_spec: verb.arg_spec,
          direct: verb.direct_callable === true,
          ...(verb.reads_room_presence === true ? { reads_room_presence: true } : {}),
          source: verb.source ?? "",
          enclosingSpace: this.enclosingSpaceFor(id),
          source_rows: this.toolSurfaceSourceRows(id, verb.owner)
        });
      }
    };
    for (const request of requests) {
      const id = request.id;
      if (!this.world.objects.has(id)) continue;
      emit(id, request.projection ?? "tools");
      if (request.expandContents && this.descendsFrom(id, "$space")) {
        for (const child of this.world.object(id).contents) emit(child, request.contentsProjection ?? "obvious");
      }
    }
    return out;
  }

  private assembleTool(
    object: ObjRef,
    spec: {
      verb: string;
      aliases: string[];
      arg_spec: Record<string, WooValue>;
      direct: boolean;
      reads_room_presence?: boolean;
      source: string;
      enclosingSpace: ObjRef | null;
      source_rows?: RemoteToolDescriptor["source_rows"];
      stale?: RemoteToolDescriptor["stale"];
      stale_reason?: RemoteToolDescriptor["stale_reason"];
    },
    usedNames: Set<string>
  ): McpTool {
    const baseName = sanitizeId(object) + "__" + spec.verb;
    let name = baseName;
    let suffix = 2;
    while (usedNames.has(name)) {
      name = baseName + "_" + suffix++;
    }
    usedNames.add(name);
    return {
      name,
      object,
      verb: spec.verb,
      aliases: spec.aliases,
      description: this.toolDescription(object, { name: spec.verb, aliases: spec.aliases, source: spec.source }),
      inputSchema: argSpecToJsonSchema(spec.arg_spec),
      direct: spec.direct,
      persistence: mcpToolPersistence(spec.arg_spec),
      ...(spec.reads_room_presence === true ? { readsRoomPresence: true } : {}),
      enclosingSpace: spec.enclosingSpace,
      descriptor: {
        object,
        verb: spec.verb,
        aliases: spec.aliases,
        arg_spec: spec.arg_spec,
        direct: spec.direct,
        ...(spec.reads_room_presence === true ? { reads_room_presence: true } : {}),
        source: spec.source,
        enclosingSpace: spec.enclosingSpace,
        ...(spec.source_rows ? { source_rows: spec.source_rows } : {}),
        ...(spec.stale ? { stale: true, stale_reason: spec.stale_reason } : {})
      }
    };
  }

  private async collectRemoteScopeIds(actor: ObjRef, sessionId?: string): Promise<ObjRef[]> {
    const candidates = new Set<ObjRef>();
    const actorObj = this.world.objects.has(actor) ? this.world.object(actor) : null;
    const sessionScope = sessionId ? this.world.activeScopeForSession(sessionId) : null;
    if (sessionScope) candidates.add(sessionScope);
    if (actorObj?.location) candidates.add(actorObj.location);
    for (const id of this.world.allLocationsForActor(actor)) candidates.add(id);
    for (const id of this.focusListOf(actor)) candidates.add(id);
    candidates.delete(actor);
    const remote: ObjRef[] = [];
    for (const id of candidates) {
      if (await this.world.isRemoteObject(id)) remote.push(id);
    }
    return remote;
  }

  private async toolListDigest(actor: ObjRef): Promise<string> {
    // This digest intentionally avoids enumerateTools(). Full enumeration can
    // cross host boundaries for every focused/present space, so doing it after
    // every dispatch creates a subrequest storm on CF. The signal only tracks
    // cheap local scope changes; clients that need exact tools call tools/list.
    const actorObj = this.world.objects.has(actor) ? this.world.object(actor) : null;
    const parts = this.reachable(actor)
      .map(({ id, origin }) => {
        const obj = this.world.objects.get(id);
        const featuresVersion = obj ? this.world.propOrNull(id, "features_version") ?? 0 : 0;
        return `${origin}:${id}:${obj?.location ?? ""}:${obj?.modified ?? "remote"}:${featuresVersion}`;
      });
    if (actorObj?.location && !parts.some((part) => part.startsWith(`location:${actorObj.location}:`))) {
      parts.push(`location:${actorObj.location}:remote`);
    }
    return parts.sort().join("|");
  }

  async refreshToolList(sessionId: string, actor: ObjRef): Promise<boolean> {
    const digest = await this.toolListDigest(actor);
    const previous = this.toolListSnapshot.get(sessionId);
    if (digest === previous) return false;
    this.toolListSnapshot.set(sessionId, digest);
    if (previous !== undefined) {
      for (const listener of this.listChangedListeners) listener(actor);
    }
    return true;
  }

  async refreshSessionToolManifest(sessionId: string, actor: ObjRef): Promise<boolean> {
    const changed = await this.refreshToolList(sessionId, actor);
    if (this.manifestHooks.staleFallback !== true && !this.manifestHooks.saveSessionManifest) return changed;
    try {
      const page = await this.listTools(actor, { scope: "active", limit: 64, sessionId });
      await this.markToolListSeen(sessionId, actor, page.tools);
    } catch {
      // A post-call descriptor refresh is an availability cache update, not
      // part of the committed action. Keep the action successful even if a
      // descriptor owner or manifest write is temporarily unavailable.
    }
    return changed;
  }

  /** Number of sessions currently bound to this MCP host (have an entry in
   * `this.queues`). Used by acceptRemote* diagnostic metrics to distinguish
   * "fanout reached a shard that hosts no MCP sessions" from "fanout reached
   * the right shard but the audience filter rejected." */
  queueCount(): number { return this.queues.size; }

  async markToolListSeen(sessionId: string, actor: ObjRef, tools: McpTool[] = []): Promise<void> {
    // The transport just handed this actor a concrete tools/list result.
    // Record that digest as the notification baseline so the next real
    // reachability change emits list_changed even if the fire-and-forget
    // initial seed from createMcpServer is still racing.
    this.toolListSnapshot.set(sessionId, await this.toolListDigest(actor));
    if (tools.length > 0) {
      const now = Date.now();
      const nextTools = tools.map((tool) => tool.descriptor ?? descriptorFromTool(tool));
      const cached = this.sessionToolManifests.get(sessionId);
      const activeScope = this.world.activeScopeForSession(sessionId) ?? actor;
      const loaded = cached ?? await this.manifestHooks.loadSessionManifest?.(sessionId) ?? null;
      const merged = new Map<string, RemoteToolDescriptor>();
      if (loaded && loaded.expires_at_ms > now && loaded.active_scope === activeScope) {
        for (const descriptor of loaded.tools) merged.set(remoteToolDescriptorKey(descriptor), descriptor);
      }
      for (const descriptor of nextTools) merged.set(remoteToolDescriptorKey(descriptor), descriptor);
      const mergedTools = Array.from(merged.values());
      const staleReason = mergedTools.find((descriptor) => descriptor.stale)?.stale_reason;
      const manifest: SessionToolManifest = {
        kind: "woo.session_tool_manifest.v1",
        session_id: sessionId,
        actor,
        active_scope: activeScope,
        tools: mergedTools,
        source_surfaces: [],
        last_apply_seq: 0,
        last_apply_hash: "",
        updated_at_ms: now,
        expires_at_ms: now + 5 * 60_000,
        ...(staleReason ? { stale: true, stale_reason: staleReason } : {})
      };
      this.sessionToolManifests.set(sessionId, manifest);
      await this.manifestHooks.saveSessionManifest?.(manifest);
    }
  }

  async resolveReachableTool(actor: ObjRef, object: ObjRef, verbName: string, sessionId?: string): Promise<McpTool | null> {
    const locallyReachable = this.reachable(actor).some((entry) => entry.id === object);
    const bridge = this.world.getExecutorContext();
    if (locallyReachable && await this.world.isRemoteObject(object)) {
      if (!bridge?.enumerateRemoteTools) return null;
      const projection = this.usesObviousProjection(actor, object) ? "obvious" : "tools";
      let descriptors: RemoteToolDescriptor[] = [];
      let remoteFailed = false;
      try {
        descriptors = await bridge.enumerateRemoteTools(actor, [{ id: object, projection }]);
      } catch {
        remoteFailed = true;
        descriptors = [];
      }
      if (descriptors.length === 0 && sessionId) {
        descriptors = await this.sessionManifestDescriptors(sessionId, remoteFailed ? "owner_timeout" : "cache_miss");
      }
      let descriptor = descriptors.find((candidate) => candidate.object === object && candidate.verb === verbName);
      if (!descriptor && projection === "tools" && object === this.world.activeScopeForSession(sessionId)) {
        try {
          const obvious = await bridge.enumerateRemoteTools(actor, [{ id: object, projection: "obvious" }]);
          descriptor = obvious.find((candidate) => candidate.object === object && candidate.verb === verbName);
        } catch {
          // The tools projection already failed to resolve this verb. Preserve
          // the normal miss path if the narrower obvious-command fallback is
          // unavailable too.
        }
      }
      return descriptor ? this.assembleTool(descriptor.object, descriptor, new Set()) : null;
    }
    if (locallyReachable) {
      const verb = (this.usesObviousProjection(actor, object) ? this.obviousVerbsFor(actor, object) : this.tooledVerbsFor(actor, object)).find((candidate) => candidate.name === verbName);
      if (!verb) return null;
      return this.assembleTool(object, {
        verb: verb.name,
        aliases: verb.aliases,
        arg_spec: verb.arg_spec,
        direct: verb.direct_callable === true,
        ...(verb.reads_room_presence === true ? { reads_room_presence: true } : {}),
        source: verb.source ?? "",
        enclosingSpace: this.enclosingSpaceFor(object)
      }, new Set());
    }
    if (!bridge?.enumerateRemoteTools) return null;
    const remoteScopeIds = await this.collectRemoteScopeIds(actor, sessionId);
    if (remoteScopeIds.length === 0) return null;
    let descriptors: RemoteToolDescriptor[] = [];
    let remoteFailed = false;
    try {
      descriptors = await bridge.enumerateRemoteTools(actor, remoteScopeIds.map((id) => ({
        id,
        projection: "tools" as const,
        expandContents: true,
        contentsProjection: "obvious" as const
      })));
    } catch {
      remoteFailed = true;
      descriptors = [];
    }
    let descriptor = descriptors.find((candidate) => candidate.object === object && candidate.verb === verbName);
    if (!descriptor) {
      try {
        // Sparse gateway shards may not locally know that the requested object
        // is a content of the active remote scope. Keep the retry bounded to
        // the same reachable remote scopes, but ask owners for the fuller
        // content tool surface when the obvious projection missed the exact
        // woo_call target.
        const expanded = await bridge.enumerateRemoteTools(actor, remoteScopeIds.map((id) => ({
          id,
          projection: "tools" as const,
          expandContents: true,
          contentsProjection: "tools" as const
        })));
        descriptor = expanded.find((candidate) => candidate.object === object && candidate.verb === verbName);
      } catch {
        // Fall through to the session manifest fallback below.
      }
      try {
        // Some mounted tools are visible by id but are not physically present
        // in the active room's contents set. After the scope-bounded expansion
        // misses, ask the owner for the exact requested object and still let
        // remote actorCanSee/verb permission checks decide whether it is
        // callable.
        const exact = await bridge.enumerateRemoteTools(actor, [{ id: object, projection: "tools" as const }]);
        descriptor = exact.find((candidate) => candidate.object === object && candidate.verb === verbName);
      } catch {
        // Fall through to the session manifest fallback below.
      }
    }
    if (!descriptor && sessionId) {
      descriptor = (await this.sessionManifestDescriptors(sessionId, remoteFailed ? "owner_timeout" : "cache_miss"))
        .find((candidate) => candidate.object === object && candidate.verb === verbName);
    }
    return descriptor ? this.assembleTool(descriptor.object, descriptor, new Set()) : null;
  }

  private async sessionManifestDescriptors(sessionId: string, staleReason?: ProjectionFreshness["stale_reason"]): Promise<RemoteToolDescriptor[]> {
    if (this.manifestHooks.staleFallback !== true) return [];
    const now = Date.now();
    const activeScope = this.world.activeScopeForSession(sessionId) ?? null;
    const manifestIsCurrent = (manifest: SessionToolManifest): boolean =>
      activeScope !== null && manifest.active_scope === activeScope;
    const cached = this.sessionToolManifests.get(sessionId);
    if (cached && cached.expires_at_ms > now && manifestIsCurrent(cached)) return (await this.markSessionManifestStale(cached, staleReason)).tools;
    const loaded = await this.manifestHooks.loadSessionManifest?.(sessionId) ?? null;
    if (!loaded || loaded.expires_at_ms <= now || !manifestIsCurrent(loaded)) return [];
    const manifest = await this.markSessionManifestStale(loaded, staleReason);
    this.sessionToolManifests.set(sessionId, manifest);
    return manifest.tools;
  }

  private async markSessionManifestStale(
    manifest: SessionToolManifest,
    staleReason?: ProjectionFreshness["stale_reason"]
  ): Promise<SessionToolManifest> {
    if (!staleReason) return manifest;
    const stale: SessionToolManifest = {
      ...manifest,
      tools: manifest.tools.map((tool) => ({ ...tool, stale: true, stale_reason: staleReason })),
      stale: true,
      stale_reason: staleReason,
      updated_at_ms: Date.now()
    };
    this.sessionToolManifests.set(manifest.session_id, stale);
    await this.manifestHooks.saveSessionManifest?.(stale);
    return stale;
  }

  private filterManifestDescriptors(
    descriptors: RemoteToolDescriptor[],
    plan: { selectedIds: Set<ObjRef>; obviousOnlyIds: Set<ObjRef>; remoteRequests: RemoteToolRequest[] }
  ): RemoteToolDescriptor[] {
    if (descriptors.length === 0) return descriptors;
    const selected = new Set(plan.selectedIds);
    for (const request of plan.remoteRequests) selected.add(request.id);
    return descriptors.filter((descriptor) =>
      selected.has(descriptor.object) ||
      plan.remoteRequests.some((request) => manifestDescriptorMatchesRequest(descriptor, request))
    );
  }

  private tooledVerbsFor(actor: ObjRef, id: ObjRef): McpVerbInfo[] {
    const cached = this.cachedVerbSurface(actor, id, "tools");
    if (!cached.tooled) cached.tooled = this.computeTooledVerbs(actor, id);
    // owner is the defining object (an ancestor, or `id` itself for an own
    // verb). It is stable for the cache key — own-verb objects key uniquely on
    // their id — so the cached entries are reused verbatim; the spread produces
    // a fresh object per call.
    return cached.tooled.map((entry) => ({ ...entry.verb, owner: entry.owner }));
  }

  // The uncached ancestry + feature walk behind tooledVerbsFor. Returns
  // {verb, owner} pairs where owner is the defining object — an ancestor, or
  // `id` itself for a verb defined directly on this object. Safe to cache under
  // the surface key: own-verb-free objects share on the parent, and any object
  // that contributes its own verbs (owner === id) keys uniquely on its id.
  private computeTooledVerbs(actor: ObjRef, id: ObjRef): TooledVerbEntry[] {
    const seen = new Set<string>();
    const out: TooledVerbEntry[] = [];
    const collect = (start: ObjRef): void => {
      let cursor: ObjRef | null = start;
      while (cursor && this.world.objects.has(cursor)) {
        const obj = this.world.object(cursor);
        for (const verb of obj.verbs) {
          if (seen.has(verb.name)) continue;
          seen.add(verb.name);
          if (this.isSuppressedInheritedActorTool(actor, id, cursor)) continue;
          if (verb.tool_exposed !== true) continue;
          if (!this.world.canExecuteVerb(actor, verb)) continue;
          out.push({ verb: verb as unknown as McpVerbInfo, owner: cursor });
        }
        cursor = obj.parent;
      }
    };
    collect(id);
    const features = this.featureListOf(id);
    for (const feature of features) collect(feature);
    return out;
  }

  private obviousVerbsFor(actor: ObjRef, id: ObjRef): McpVerbInfo[] {
    const cached = this.cachedVerbSurface(actor, id, "obvious");
    if (!cached.obvious) cached.obvious = this.world.obviousCommandVerbs(id, { actor, executableOnly: true }) as unknown as McpVerbInfo[];
    // The obvious projection leaves `owner` unset on class verbs; default it to
    // the object itself per call (drives toolSurfaceSourceRows). This default is
    // per-object, so it is applied here and never written into the cached array.
    return cached.obvious.map((verb) => ({ ...verb, owner: verb.owner ?? id }));
  }

  // Returns the cache entry for this (actor, object, projection) verb surface,
  // creating an empty one (filled lazily by the caller) on a miss. The whole
  // cache is dropped when the world's mutation version has advanced since it was
  // last populated, so an entry is only ever read within the epoch that produced
  // it — no per-entry staleness is possible.
  private cachedVerbSurface(actor: ObjRef, id: ObjRef, projection: "tools" | "obvious"): VerbSurfaceCacheEntry {
    const version = this.world.mutationVersion();
    if (version !== this.verbSurfaceCacheVersion) {
      this.verbSurfaceCache.clear();
      this.verbSurfaceCacheVersion = version;
    } else if (this.verbSurfaceCache.size >= McpHost.VERB_SURFACE_CACHE_MAX) {
      // A single epoch touching this many distinct (actor, class) pairs is
      // pathological; drop the cache rather than grow without bound.
      this.verbSurfaceCache.clear();
    }
    const key = this.verbSurfaceClassKey(actor, id, projection);
    let entry = this.verbSurfaceCache.get(key);
    if (!entry) {
      entry = {};
      this.verbSurfaceCache.set(key, entry);
    }
    return entry;
  }

  // Identity that two objects must share to have the same verb surface. Under
  // single inheritance the immediate parent fully determines the inherited
  // ancestry and inherited feature list, so same-parent siblings with no own
  // definitions collapse to one key — the hot outline case. An object that
  // defines its OWN verbs cannot share: those verbs contribute per-object
  // content (arg_spec, source, perms, owner, exposure flags), not just names, so
  // we make the key object-unique whenever own verbs exist rather than try to
  // fingerprint every field. The own `features` value also varies the surface
  // and is keyed by value; the tools projection additionally depends on whether
  // the object is a block or is the actor itself (inherited $actor-tool
  // suppression).
  private verbSurfaceClassKey(actor: ObjRef, id: ObjRef, projection: "tools" | "obvious"): string {
    const obj = this.world.object(id);
    // `self:<id>` makes objects with their own verbs unique; `shared` lets
    // own-verb-free siblings reuse one entry keyed on the parent.
    const ownIdentity = obj.verbs.length > 0 ? `self:${id}` : "shared";
    const ownFeatures = JSON.stringify(this.world.propOrNull(id, "features") ?? null);
    const tooledDiscriminator = projection === "tools" ? `${id === actor}:${this.isBlockObject(id)}` : "";
    return `${projection}|${actor}|p:${obj.parent ?? ""}|own:${ownIdentity}|f:${ownFeatures}|t:${tooledDiscriminator}`;
  }

  private toolSurfaceSourceRows(object: ObjRef, owner: ObjRef | undefined): RemoteToolDescriptor["source_rows"] {
    const keys = new Set<ObjRef>();
    const objectLineage = this.objectLineage(object);
    const ownerInObjectLineage = owner ? objectLineage.indexOf(owner) : -1;
    if (ownerInObjectLineage >= 0) {
      for (const key of objectLineage.slice(0, ownerInObjectLineage + 1)) keys.add(key);
    } else {
      // Feature-provided verbs depend on the object/class rows that declare the
      // feature list, plus the feature object's own resolution path.
      for (const key of objectLineage) keys.add(key);
      let foundFeatureOwner = false;
      if (owner) {
        for (const feature of this.featureListOf(object)) {
          const featureLineage = this.objectLineage(feature);
          const ownerIndex = featureLineage.indexOf(owner);
          if (ownerIndex < 0) continue;
          foundFeatureOwner = true;
          for (const key of featureLineage.slice(0, ownerIndex + 1)) keys.add(key);
        }
      }
      if (owner && !foundFeatureOwner) keys.add(owner);
    }
    return Array.from(keys).map((key) => ({ table: "objects" as const, authority_scope: object, key }));
  }

  private objectLineage(start: ObjRef): ObjRef[] {
    const out: ObjRef[] = [];
    const seen = new Set<ObjRef>();
    let cursor: ObjRef | null = start;
    while (cursor && this.world.objects.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      out.push(cursor);
      cursor = this.world.object(cursor).parent;
    }
    return out;
  }

  private usesObviousProjection(actor: ObjRef, target: ObjRef): boolean {
    const focus = this.focusListOf(actor);
    if (focus.includes(target)) return false;
    return this.reachable(actor).some((entry) => entry.id === target && entry.origin === "contents");
  }

  private isSuppressedInheritedActorTool(actor: ObjRef, target: ObjRef, definingObject: ObjRef): boolean {
    return target !== actor && this.isBlockObject(target) && definingObject === "$actor";
  }

  private featureListOf(id: ObjRef): ObjRef[] {
    if (!this.world.objects.has(id)) return [];
    const seen = new Set<ObjRef>();
    let cursor: ObjRef | null = id;
    while (cursor && this.world.objects.has(cursor)) {
      const raw = this.world.propOrNull(cursor, "features");
      if (Array.isArray(raw)) {
        for (const f of raw) if (typeof f === "string") seen.add(f);
      }
      cursor = this.world.object(cursor).parent;
    }
    return Array.from(seen);
  }

  private toolDescription(id: ObjRef, verb: { name: string; aliases: string[]; source?: string }): string {
    const lines: string[] = [];
    const doc = extractFirstParagraph(verb.source ?? "");
    if (doc) lines.push(doc);
    lines.push(`call: ${id}:${verb.name}(...)`);
    if (verb.aliases.length > 0) lines.push(`aliases: ${verb.aliases.join(", ")}`);
    return lines.join("\n");
  }

  enclosingSpaceFor(target: ObjRef): ObjRef | null {
    let cursor: ObjRef | null = target;
    while (cursor && this.world.objects.has(cursor)) {
      const membership = this.spaceMembership(cursor);
      if (membership === "yes") return cursor;
      // CA11.2: do NOT walk past a node whose own $space membership is
      // INDETERMINATE because its class lineage is incomplete on this sparse
      // gateway shard (a missing ancestor before `parent:null`). Returning null
      // here defers to the caller's registration-time `enclosingSpace` hint
      // (computed against a complete world at listTools time), which is the
      // correct scope. Walking to this node's `location` would mis-resolve a
      // tool-space (e.g. `the_pinboard`, anchored in a now-resident `the_deck`
      // seeded by the topology pre-seed) to its containing room, breaking the
      // presence check for an actor who occupies the tool-space itself. Only a
      // node CONCLUSIVELY not a space ("no", complete lineage with no match) may
      // be walked through to its anchor/location.
      if (membership === "unknown") return null;
      const obj = this.world.object(cursor);
      cursor = obj.anchor ?? obj.location ?? null;
    }
    return null;
  }

  // Is `objRef` a descendant of `$space`? Tri-state because a sparse MCP gateway
  // shard may hold an object whose class lineage is not fully resident: walking
  // `parent` can hit a MISSING ancestor before reaching either `$space` or
  // `parent:null`. "yes"/"no" are conclusive; "unknown" means the lineage broke
  // at an absent ancestor and membership cannot be decided locally.
  private spaceMembership(objRef: ObjRef): "yes" | "no" | "unknown" {
    let cursor: ObjRef | null = objRef;
    const seen = new Set<ObjRef>();
    while (cursor) {
      if (cursor === "$space") return "yes";
      if (seen.has(cursor)) return "no"; // cycle — treat as conclusively non-space
      seen.add(cursor);
      const obj = this.world.objects.get(cursor);
      if (!obj) return "unknown"; // lineage broke at a missing ancestor
      cursor = obj.parent;
    }
    return "no"; // reached parent:null without matching $space
  }

  private descendsFrom(objRef: ObjRef, ancestorRef: ObjRef): boolean {
    let cursor: ObjRef | null = objRef;
    while (cursor && this.world.objects.has(cursor)) {
      if (cursor === ancestorRef) return true;
      cursor = this.world.object(cursor).parent;
    }
    return false;
  }

  // ----- tool invocation -----

  async invokeTool(actor: ObjRef, sessionId: string, tool: McpTool, args: WooValue[]): Promise<McpInvocationResult> {
    const refreshBaseline = await this.toolRefreshBaseline(actor);
    if (tool.direct) {
      // For wait we need session-scoped queue access. Thread the sessionId
      // through a module-scoped slot; the registered native handler reads it.
      const previous = CURRENT_WAIT_SESSION_ID;
      CURRENT_WAIT_SESSION_ID = sessionId;
      // tool.enclosingSpace was resolved at listTools time and is only a hint;
      // it becomes stale when the actor (or the tool's host object) moves
      // between rooms. Re-resolve from the live object graph so each invocation
      // routes to the actor's current scope — otherwise an actor verb dispatched
      // after a cross-scope move (e.g. `ways` after `southeast`) hits the old
      // scope's stale serialized world and returns missing_state.
      const liveEnclosing = this.enclosingSpaceFor(tool.object) ?? tool.enclosingSpace;
      try {
        if (this.isMcpWaitTool(actor, tool)) {
          return { result: await this.drainWait(sessionId, args), observations: [] };
        }
        const result = this.dispatchHooks.direct
          ? await this.dispatchHooks.direct(sessionId, actor, tool.object, tool.verb, args, liveEnclosing, tool.persistence, {
              directorySessionScopes: tool.readsRoomPresence === true
                ? roomPresenceCandidateScopes(tool.object, args, liveEnclosing)
                : []
            })
          : await this.world.directCall(undefined, actor, tool.object, tool.verb, args, { sessionId });
        if (result.op === "error") throw fromError(result.error);
        // Self observations are returned in the call result; do NOT route them
        // back into this session's queue — that would deliver them twice.
        // Other sessions' queues do see them via the normal broadcast path
        // (dev-server / DO call McpHost.routeLiveEvents with originSessionId).
        if (this.broadcasts.broadcastLiveEvents && result.audience) {
          await this.broadcasts.broadcastLiveEvents(result, sessionId);
        }
        const decision = await this.toolRefreshDecisionAfterInvoke(actor, tool, (result as McpTranscriptBearing).transcript, refreshBaseline);
        this.recordToolRefreshDecision(actor, "invoke", decision, sessionId);
        if (decision.refresh) {
          await this.refreshSessionToolManifest(sessionId, actor);
        }
        return { result: result.result, observations: this.filterCallerObservations(sessionId, result.observations, result.observationSessionAudiences) };
      } finally {
        CURRENT_WAIT_SESSION_ID = previous;
      }
    }
    // Same staleness reasoning as the direct-call path above: re-resolve the
    // enclosing space from the live graph at invocation time so a sequenced
    // call after a cross-scope move (e.g. `take` from a new room) routes to
    // the actor's current scope rather than the registration-time hint.
    const space = this.enclosingSpaceFor(tool.object) ?? tool.enclosingSpace;
    if (!space) throw wooError("E_INVARG", `verb ${tool.object}:${tool.verb} has no enclosing space for sequenced dispatch`);
    const message = { actor, target: tool.object, verb: tool.verb, args };
    const frame = this.dispatchHooks.call
      ? await this.dispatchHooks.call(sessionId, actor, space, message)
      : await this.world.call(undefined, sessionId, space, message);
    if (frame.op === "error") throw fromError(frame.error);
    if (this.broadcasts.broadcastApplied) {
      await this.broadcasts.broadcastApplied(frame, sessionId);
    }
    const decision = await this.toolRefreshDecisionAfterInvoke(actor, tool, (frame as McpTranscriptBearing).transcript, refreshBaseline);
    this.recordToolRefreshDecision(actor, "invoke", decision, sessionId);
    if (decision.refresh) {
      await this.refreshSessionToolManifest(sessionId, actor);
    }
    const errObs = frame.observations.find((o) => o.type === "$error");
    return {
      result: errObs ? null : true,
      observations: this.filterCallerObservations(sessionId, frame.observations, frame.observationSessionAudiences),
      applied: { space: frame.space, seq: frame.seq, ts: frame.ts }
    };
  }

  // Trim the verb's emitted observations to those whose per-observation
  // session audience includes the calling MCP session. The engine's
  // `result.observations` is the raw transcript and contains every
  // observation any verb produced during the call — including forwards
  // to other spaces (e.g. `$transparent:say` re-emits to `location(this)`
  // for actors in the parent room). Without this filter, an MCP client
  // sees two `said` events for a single proxied space `say` even though
  // its own audience only contains one. See notes/2026-05-16-online-
  // walkthrough.md Bug 5.
  //
  // If observationSessionAudiences is absent or shorter than observations
  // (older callers / cross-host bridges that don't populate it), pass the
  // observation through — better to over-report than to drop legitimate
  // events.
  private filterCallerObservations(sessionId: string, observations: Observation[], observationSessionAudiences?: string[][]): Observation[] {
    if (!observationSessionAudiences) return observations;
    return observations.filter((_, index) => {
      const audience = observationSessionAudiences[index];
      if (!audience) return true;
      return audience.includes(sessionId);
    });
  }

  private isMcpWaitTool(actor: ObjRef, tool: McpTool): boolean {
    return tool.object === actor && tool.verb === "wait";
  }

  private async toolRefreshDecisionAfterInvoke(
    actor: ObjRef,
    _tool: McpTool,
    transcript: EffectTranscript | undefined,
    baseline: McpToolRefreshBaseline
  ): Promise<McpToolRefreshDecision> {
    return await this.refineToolRefreshDecision(actor, this.toolRefreshDecisionAfterTranscript(actor, transcript), baseline);
  }

  private toolRefreshDecisionAfterTranscript(actor: ObjRef, transcript: EffectTranscript | undefined): McpToolRefreshDecision {
    // Older non-v2 dispatch paths do not expose an effect transcript. Preserve
    // the historical conservative refresh there; the optimization only applies
    // when shadow execution tells us exactly which reachability cells changed.
    if (!transcript) return { refresh: true, reason: "no_transcript", transcript: false };
    if (transcript.writes.some((write) => write.cell.kind === "verb")) {
      return { refresh: true, reason: "verb_shape", transcript: true };
    }
    if (transcript.moves.some((move) => move.object === actor)) return { refresh: true, reason: "actor_location", transcript: true };
    if (transcript.moves.some((move) => move.from === actor || move.to === actor)) return { refresh: true, reason: "actor_contents", transcript: true };
    if (transcript.creates.some((create) => create.location === actor)) return { refresh: true, reason: "actor_contents", transcript: true };
    for (const write of transcript.writes) {
      const cell = write.cell;
      if (cell.kind === "prop" && cell.object === actor && cell.name === "focus_list") return { refresh: true, reason: "focus_list", transcript: true };
      if (cell.kind === "location" && cell.object === actor) return { refresh: true, reason: "actor_location", transcript: true };
      if (cell.kind === "contents" && cell.object === actor) return { refresh: true, reason: "actor_contents", transcript: true };
    }
    const enclosing = this.enclosingSpaceFor(actor);
    if (!enclosing) return { refresh: false, reason: "no_reachability_change", transcript: true };
    if (transcript.moves.some((move) => move.from === enclosing || move.to === enclosing)) return { refresh: true, reason: "room_contents", transcript: true };
    if (transcript.creates.some((create) => create.location === enclosing)) return { refresh: true, reason: "room_contents", transcript: true };
    if (transcript.writes.some((write) => write.cell.kind === "contents" && write.cell.object === enclosing)) {
      return { refresh: true, reason: "room_contents", transcript: true };
    }
    return { refresh: false, reason: "no_reachability_change", transcript: true };
  }

  private async toolRefreshBaseline(actor: ObjRef): Promise<McpToolRefreshBaseline> {
    return {
      digest: await this.toolListDigest(actor),
      location: this.world.objects.get(actor)?.location ?? null,
      activeScopes: this.world.allLocationsForActor(actor).sort().join("|")
    };
  }

  private async refineToolRefreshDecision(
    actor: ObjRef,
    decision: McpToolRefreshDecision,
    baseline: McpToolRefreshBaseline
  ): Promise<McpToolRefreshDecision> {
    if (decision.refresh) return decision;
    // Transcripts are the fast path, but reachability is cheap to digest
    // locally. If a native/remote path under-reports an actor move, this
    // catches the changed tool surface before we suppress list_changed.
    const digest = await this.toolListDigest(actor);
    if (digest === baseline.digest) return decision;
    const location = this.world.objects.get(actor)?.location ?? null;
    const activeScopes = this.world.allLocationsForActor(actor).sort().join("|");
    if (location !== baseline.location || activeScopes !== baseline.activeScopes) {
      return { refresh: true, reason: "actor_location", transcript: decision.transcript };
    }
    return { refresh: true, reason: "reachability_digest", transcript: decision.transcript };
  }

  private recordToolRefreshDecision(actor: ObjRef, source: McpToolRefreshSource, decision: McpToolRefreshDecision, sessionId?: string): void {
    // session_id + active_scope let us tell which gateway shard made the
    // decision and what it thought the actor's working scope was — the two
    // pieces of context missing when a refresh metric lands without an
    // obvious matching tools/call. active_scope is read from the session's
    // recorded activeScope, with a fallback to the actor's location.
    const activeScope = (sessionId ? this.world.activeScopeForSession(sessionId) : null) ?? this.world.objects.get(actor)?.location ?? null;
    this.world.recordMetric({
      kind: decision.refresh ? "mcp_tool_refresh_taken" : "mcp_tool_refresh_skipped",
      actor,
      source,
      reason: decision.reason,
      transcript: decision.transcript,
      ...(sessionId ? { session_id: sessionId } : {}),
      active_scope: activeScope
    });
  }

  // ----- $actor:wait drain (focus/unfocus/focus_list natives live in world.ts) -----

  private async drainWait(sessionId: string, args: WooValue[]): Promise<WooValue> {
    const timeoutMs = Math.max(0, Math.min(MAX_TIMEOUT_MS, toInt(args[0], 0)));
    const limit = Math.max(1, Math.min(MAX_LIMIT, toInt(args[1], DEFAULT_LIMIT)));
    const queue = this.queues.get(sessionId);
    if (!queue) return emptyDrain();
    if (queue.observations.length === 0 && timeoutMs > 0) {
      await new Promise<void>((resolve) => {
        const waiter: SessionQueue["waiters"] extends Set<infer T> ? T : never = {
          resolve,
          timer: setTimeout(() => {
            queue.waiters.delete(waiter);
            resolve();
          }, timeoutMs)
        };
        queue.waiters.add(waiter);
      });
    }
    const drained = queue.observations.splice(0, limit);
    if (queue.lostSinceMark > 0 && drained.length === 0) {
      drained.unshift({
        type: "observation_overflow",
        lost: queue.lostSinceMark,
        since: queue.firstLostTs ?? Date.now()
      } as Observation);
      queue.lostSinceMark = 0;
      queue.firstLostTs = null;
    }
    return {
      observations: drained as unknown as WooValue,
      more: queue.observations.length > 0,
      queue_depth: queue.observations.length
    } as unknown as WooValue;
  }

  private focusListOf(actor: ObjRef): ObjRef[] {
    return this.stringListProp(actor, "focus_list");
  }

  private stringListProp(obj: ObjRef, name: string): ObjRef[] {
    if (!this.world.objects.has(obj)) return [];
    const raw = this.world.propOrNull(obj, name);
    return Array.isArray(raw) ? raw.filter((item): item is ObjRef => typeof item === "string") : [];
  }
}

function filterTools(tools: McpTool[], query: string | undefined): McpTool[] {
  const normalized = (query ?? "").trim().toLowerCase();
  if (!normalized) return tools;
  return tools.filter((tool) => {
    if (tool.name.toLowerCase().includes(normalized)) return true;
    if (tool.object.toLowerCase().includes(normalized)) return true;
    if (tool.verb.toLowerCase().includes(normalized)) return true;
    if (tool.description.toLowerCase().includes(normalized)) return true;
    return tool.aliases.some((alias) => alias.toLowerCase().includes(normalized));
  });
}

function roomPresenceCandidateScopes(object: ObjRef, args: readonly WooValue[], enclosingSpace: ObjRef | null): ObjRef[] {
  const out = new Set<ObjRef>();
  out.add(object);
  if (enclosingSpace) out.add(enclosingSpace);
  for (const arg of args) {
    if (typeof arg === "string" && arg.length > 0) out.add(arg as ObjRef);
  }
  return Array.from(out).sort();
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function makeQueue(actor: ObjRef): SessionQueue {
  return { actor, observations: [], lostSinceMark: 0, firstLostTs: null, waiters: new Set() };
}

function emptyDrain(): WooValue {
  return { observations: [] as unknown as WooValue, more: false, queue_depth: 0 } as unknown as WooValue;
}

function toInt(value: WooValue | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  return fallback;
}

function sanitizeId(id: ObjRef): string {
  return id.replace(/^\$/, "").replace(/[^a-zA-Z0-9_]/g, "_");
}

function extractFirstParagraph(source: string): string {
  if (!source) return "";
  const blockMatch = /\/\*([\s\S]*?)\*\//.exec(source);
  if (blockMatch) {
    const text = blockMatch[1].split(/\n\s*\n/)[0].replace(/^\s*\*?\s?/gm, "").trim();
    if (text) return text;
  }
  const lineMatch = /^\s*\/\/\s?(.*)$/m.exec(source);
  if (lineMatch) return lineMatch[1].trim();
  return "";
}

function argSpecToJsonSchema(spec: Record<string, WooValue>): Record<string, unknown> {
  const rawArgs = Array.isArray(spec.args) ? spec.args : Array.isArray(spec.params) ? spec.params : [];
  const args = rawArgs.filter((item): item is string => typeof item === "string");
  const types = (spec.types && typeof spec.types === "object" && !Array.isArray(spec.types)) ? spec.types as Record<string, WooValue> : {};
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const arg of args) {
    const optional = arg.endsWith("?");
    const name = optional ? arg.slice(0, -1) : arg;
    const hint = typeof types[name] === "string" ? String(types[name]) : "";
    properties[name] = jsonSchemaForHint(hint);
    if (!optional) required.push(name);
  }
  const schema: Record<string, unknown> = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

function mcpToolPersistence(spec: Record<string, WooValue>): "durable" | "live" {
  // The catalog command contract is transport-neutral. MCP exposes the same
  // verbs as REST and the browser, so command persistence must follow
  // arg_spec.command.persistence instead of being chosen by the MCP adapter.
  const command = spec.command;
  if (command && typeof command === "object" && !Array.isArray(command)) {
    const persistence = (command as Record<string, WooValue>).persistence;
    if (persistence === "live" || persistence === "durable") return persistence;
  }
  return "durable";
}

function manifestDescriptorMatchesRequest(descriptor: RemoteToolDescriptor, request: RemoteToolRequest): boolean {
  if (descriptor.object === request.id) return true;
  // expandContents asks the remote owner for child-object tools under the
  // requested space; stale manifest fallback must use the same match shape.
  return request.expandContents === true && descriptor.enclosingSpace === request.id;
}

function descriptorFromTool(tool: McpTool): RemoteToolDescriptor {
  return {
    object: tool.object,
    verb: tool.verb,
    aliases: tool.aliases,
    arg_spec: {},
    direct: tool.direct,
    ...(tool.readsRoomPresence === true ? { reads_room_presence: true } : {}),
    source: "",
    enclosingSpace: tool.enclosingSpace
  };
}

function remoteToolDescriptorKey(descriptor: RemoteToolDescriptor): string {
  return `${descriptor.object}${OBJECT_VERB_SEP}${descriptor.verb}`;
}

function jsonSchemaForHint(hint: string): Record<string, unknown> {
  if (!hint) return {};
  const trimmed = hint.trim();
  if (trimmed === "str") return { type: "string" };
  if (trimmed === "int") return { type: "integer" };
  if (trimmed === "float" || trimmed === "num") return { type: "number" };
  if (trimmed === "bool") return { type: "boolean" };
  if (trimmed === "obj") return { type: "string", description: "object reference (woo objref)" };
  if (trimmed.startsWith("list<")) return { type: "array" };
  if (trimmed.startsWith("map")) return { type: "object" };
  return {};
}

function fromError(error: { code: string; message?: string; value?: unknown; trace?: unknown }): Error {
  // Keep the bare engine message on `.message` and the code on `.code`.
  // The MCP server formats tool-error text as `${code}: ${message}` at
  // its own catch site (src/mcp/server.ts:invokeForMcp), so prefixing
  // the code into `.message` here produced "E_INVARG: E_INVARG: ..."
  // duplication visible to MCP clients (see
  // notes/2026-05-16-online-walkthrough.md Bug 2).
  const err = new Error(error.message ?? error.code);
  const enriched = err as Error & { code?: string; value?: unknown; trace?: unknown };
  enriched.code = error.code;
  if (error.value !== undefined) enriched.value = error.value;
  if (error.trace !== undefined) enriched.trace = error.trace;
  return err;
}
