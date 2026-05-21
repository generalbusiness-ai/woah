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
import { directedRecipients, wooError } from "../core/types";

// Broadcast hooks the runtime wires into the MCP host so that MCP-initiated
// direct and sequenced calls fan out to attached WebSocket / SSE clients the
// same way REST-initiated calls do. Without these, an MCP agent's chat would
// be invisible to humans on the gateway's WS.
export type McpBroadcastHooks = {
  broadcastApplied?: (frame: AppliedFrame, originSessionId?: string | null) => void | Promise<void>;
  broadcastLiveEvents?: (result: DirectResultFrame, originSessionId?: string | null) => void | Promise<void>;
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
  enclosingSpace: ObjRef | null;
};

export type McpToolScope = "active" | "here" | "focus" | "object" | "space" | "all";

export type McpToolListOptions = {
  scope?: McpToolScope;
  object?: ObjRef;
  query?: string;
  limit?: number;
  cursor?: string;
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
  direct?: (sessionId: string, actor: ObjRef, target: ObjRef, verb: string, args: WooValue[], scope?: ObjRef | null, persistence?: "durable" | "live") => McpDirectDispatchFrame | ErrorFrame | Promise<McpDirectDispatchFrame | ErrorFrame>;
  call?: (sessionId: string, actor: ObjRef, space: ObjRef, message: Message) => McpAppliedDispatchFrame | ErrorFrame | Promise<McpAppliedDispatchFrame | ErrorFrame>;
};

type McpTranscriptBearing = { transcript?: EffectTranscript };
type McpDirectDispatchFrame = DirectResultFrame & McpTranscriptBearing;
type McpAppliedDispatchFrame = AppliedFrame & McpTranscriptBearing;
type McpToolRefreshDecision = { refresh: boolean; reason: string; transcript: boolean };
type McpToolRefreshBaseline = { digest: string; location: ObjRef | null; activeScopes: string };
type McpToolRefreshSource = "invoke" | "accepted_frame";

// `actor_wait` runs through the standard verb-dispatch path, which doesn't
// thread the MCP session id through CallContext. McpHost.invokeTool sets this
// before dispatching the wait verb so the native handler can find the right
// per-session queue. Single-threaded JS makes this safe.
let CURRENT_WAIT_SESSION_ID: string | null = null;

export class McpHost {
  private queues = new Map<string, SessionQueue>();
  private listChangedListeners = new Set<(actor: ObjRef) => void>();
  private toolListSnapshot = new Map<string, string>();

  private broadcasts: McpBroadcastHooks = {};

  constructor(private world: WooWorld, private dispatchHooks: McpDispatchHooks = {}) {
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
      if (sessionAudience) {
        const sessionSet = new Set(sessionAudience);
        for (const sessionId of sessionSet) {
          if (originSessionId && sessionId === originSessionId) continue;
          if (!this.queues.has(sessionId)) continue;
          this.enqueueFor(sessionId, observation);
        }
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
        if (shouldDeliver) this.enqueueFor(sessionId, observation);
      }
    }
  }

  // v2 commit-scope accepted frames are the pure-v2 observation source. They
  // do not carry legacy AppliedFrame audience metadata, so route by directed
  // observation recipients first and then by scope subscription/presence.
  routeShadowAcceptedFrame(frame: ShadowCommitAccepted, originSessionId?: string | null, transcript?: EffectTranscript): void {
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
    for (const observation of frame.observations) {
      const directed = directedRecipients(observation);
      const directedActors = new Set<ObjRef>();
      if (directed.to) directedActors.add(directed.to);
      if (directed.from) directedActors.add(directed.from);
      for (const [sessionId, queue] of this.queues) {
        if (originSessionId && sessionId === originSessionId) continue;
        const sessionLocation = this.world.activeScopeForSession(sessionId);
        const sourceScope = typeof observation.source === "string" ? observation.source : null;
        const shouldDeliver = directedActors.size > 0
          ? directedActors.has(queue.actor)
          : this.actorSubscribes(queue.actor, frame.position.scope) ||
            sessionLocation === frame.position.scope ||
            (sourceScope !== null && (this.actorSubscribes(queue.actor, sourceScope) || sessionLocation === sourceScope));
        if (shouldDeliver) {
          this.enqueueFor(sessionId, observation);
          if (refreshDecisionForActor(queue.actor).refresh) refreshSessions.add(sessionId);
        }
      }
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
    const filtered = await this.enumerateToolsForScope(actor, scope, options.object, options.query);
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
    const filtered = await this.enumerateToolsForScope(actor, scope, options.object, options.query);
    if (options.limit === undefined && options.cursor === undefined) return filtered;
    const limit = clampInt(options.limit, 1, MAX_TOOL_PAGE_LIMIT, filtered.length || DEFAULT_TOOL_PAGE_LIMIT);
    const offset = parseCursor(options.cursor);
    return filtered.slice(offset, offset + limit);
  }

  private async enumerateToolsForScope(actor: ObjRef, scope: McpToolScope, object: ObjRef | undefined, query: string | undefined): Promise<McpTool[]> {
    const plan = await this.toolScopePlan(actor, scope, object);
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
      try {
        if (plan.remoteRequests.length > 0) selectedDescriptors = await bridge.enumerateRemoteTools(actor, plan.remoteRequests);
      } catch {
        // Best-effort; if a host is unreachable its tools just don't appear.
      }
      addRemoteDescriptors(selectedDescriptors, false);
    }

    return filterTools(tools, query);
  }

  private async toolScopePlan(
    actor: ObjRef,
    scope: McpToolScope,
    object: ObjRef | undefined
  ): Promise<{ selectedIds: Set<ObjRef>; obviousOnlyIds: Set<ObjRef>; remoteRequests: RemoteToolRequest[] }> {
    const selectedIds = new Set<ObjRef>();
    const obviousOnlyIds = new Set<ObjRef>();
    const remoteCandidates = new Map<ObjRef, RemoteToolProjection>();
    const remoteExpandCandidates = new Map<ObjRef, RemoteToolProjection>();
    const actorObj = this.world.objects.has(actor) ? this.world.object(actor) : null;
    const activeLocations = this.world.allLocationsForActor(actor);
    const activeScope = actorObj?.location ?? activeLocations[0] ?? null;
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
          source: verb.source ?? "",
          enclosingSpace: this.enclosingSpaceFor(id)
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
    spec: { verb: string; aliases: string[]; arg_spec: Record<string, WooValue>; direct: boolean; source: string; enclosingSpace: ObjRef | null },
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
      enclosingSpace: spec.enclosingSpace
    };
  }

  private async collectRemoteScopeIds(actor: ObjRef): Promise<ObjRef[]> {
    const candidates = new Set<ObjRef>();
    const actorObj = this.world.objects.has(actor) ? this.world.object(actor) : null;
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

  async markToolListSeen(sessionId: string, actor: ObjRef): Promise<void> {
    // The transport just handed this actor a concrete tools/list result.
    // Record that digest as the notification baseline so the next real
    // reachability change emits list_changed even if the fire-and-forget
    // initial seed from createMcpServer is still racing.
    this.toolListSnapshot.set(sessionId, await this.toolListDigest(actor));
  }

  async resolveReachableTool(actor: ObjRef, object: ObjRef, verbName: string): Promise<McpTool | null> {
    const locallyReachable = this.reachable(actor).some((entry) => entry.id === object);
    const bridge = this.world.getExecutorContext();
    if (locallyReachable && await this.world.isRemoteObject(object)) {
      if (!bridge?.enumerateRemoteTools) return null;
      const projection = this.usesObviousProjection(actor, object) ? "obvious" : "tools";
      const descriptors = await bridge.enumerateRemoteTools(actor, [{ id: object, projection }]);
      const descriptor = descriptors.find((candidate) => candidate.object === object && candidate.verb === verbName);
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
        source: verb.source ?? "",
        enclosingSpace: this.enclosingSpaceFor(object)
      }, new Set());
    }
    if (!bridge?.enumerateRemoteTools) return null;
    const remoteScopeIds = await this.collectRemoteScopeIds(actor);
    if (remoteScopeIds.length === 0) return null;
    const descriptors = await bridge.enumerateRemoteTools(actor, remoteScopeIds.map((id) => ({
      id,
      projection: "tools" as const,
      expandContents: true,
      contentsProjection: "obvious" as const
    })));
    const descriptor = descriptors.find((candidate) => candidate.object === object && candidate.verb === verbName);
    return descriptor ? this.assembleTool(descriptor.object, descriptor, new Set()) : null;
  }

  private tooledVerbsFor(actor: ObjRef, id: ObjRef): Array<{ name: string; aliases: string[]; arg_spec: Record<string, WooValue>; direct_callable?: boolean; perms: string; tool_exposed?: boolean; source?: string }> {
    const seen = new Set<string>();
    const out: Array<{ name: string; aliases: string[]; arg_spec: Record<string, WooValue>; direct_callable?: boolean; perms: string; tool_exposed?: boolean; source?: string }> = [];
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
          out.push(verb as unknown as typeof out[number]);
        }
        cursor = obj.parent;
      }
    };
    collect(id);
    const features = this.featureListOf(id);
    for (const feature of features) collect(feature);
    return out;
  }

  private obviousVerbsFor(actor: ObjRef, id: ObjRef): Array<{ name: string; aliases: string[]; arg_spec: Record<string, WooValue>; direct_callable?: boolean; perms: string; tool_exposed?: boolean; source?: string }> {
    return this.world.obviousCommandVerbs(id, { actor, executableOnly: true }) as unknown as Array<{ name: string; aliases: string[]; arg_spec: Record<string, WooValue>; direct_callable?: boolean; perms: string; tool_exposed?: boolean; source?: string }>;
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
      if (this.descendsFrom(cursor, "$space")) return cursor;
      const obj = this.world.object(cursor);
      cursor = obj.anchor ?? obj.location ?? null;
    }
    return null;
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
          ? await this.dispatchHooks.direct(sessionId, actor, tool.object, tool.verb, args, liveEnclosing, tool.persistence)
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
          await this.refreshToolList(sessionId, actor);
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
      await this.refreshToolList(sessionId, actor);
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
