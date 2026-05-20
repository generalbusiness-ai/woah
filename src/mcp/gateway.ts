// MCP gateway — per-process state manager for the streamable-HTTP transport.
// Owns ONE McpHost per WooWorld so the built-in MCP control handlers
// only register once. Each MCP session binds a queue inside that host and
// gets its own server + transport.
//
// First-request auth uses either the `Mcp-Token` header or, for MCP clients
// that only expose bearer-token configuration, `Authorization: Bearer <token>`.
// The token value is one of the woo token classes: guest:, bearer:, apikey:,
// wizard:. The server resolves it to a woo session, generates an
// Mcp-Session-Id, and binds a McpHost queue to it. Subsequent requests carry
// Mcp-Session-Id.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { EffectTranscript } from "../core/effect-transcript";
import type { AppliedFrame, DirectResultFrame, ErrorFrame, ErrorValue, Message, ObjRef, Session, WooValue } from "../core/types";
import type { WooWorld } from "../core/world";
import type { SerializedAuthoritySlice } from "../core/repository";
import { createMcpServer } from "./server";
import { McpHost, type McpBroadcastHooks, type McpDispatchHooks } from "./host";
import {
  createShadowBrowserRelayShim,
  markShadowBrowserRelaySerializedChanged,
  type ShadowBrowserRelayShim
} from "../core/shadow-browser-node";
import type { ShadowTurnCall } from "../core/shadow-turn-call";
import { applyAcceptedShadowFrame, applyShadowTranscriptToCommitScopeCache, type ShadowCommitAccepted, type ShadowScopeHead } from "../core/shadow-commit-scope";
import type { ShadowTurnExecReply } from "../core/shadow-turn-exec";
import {
  V2_COMMIT_SCOPE_SNAPSHOT_REQUIRED,
  mergeV2TurnGatewayAuthority,
  submitTurnIntent,
  v2TurnGatewayAuthorityPayload
} from "../core/v2-turn-gateway";

const MCP_TOKEN_HEADER = "mcp-token";
const MCP_SESSION_HEADER = "mcp-session-id";
const AUTHORIZATION_HEADER = "authorization";
const REMOTE_ACCEPTED_LRU_LIMIT = 8192;
const REMOTE_PENDING_LIMIT = 1024;
const REMOTE_PENDING_MAX_AGE_MS = 60_000;

function isV2CommitScopeSnapshotRequiredError(err: unknown): boolean {
  if (!err || typeof err !== "object" || Array.isArray(err)) return false;
  const code = (err as { code?: unknown }).code;
  if (code === V2_COMMIT_SCOPE_SNAPSHOT_REQUIRED) return true;
  const value = (err as { value?: unknown }).value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const nested = (value as { error?: unknown }).error;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return false;
  return (nested as { code?: unknown }).code === V2_COMMIT_SCOPE_SNAPSHOT_REQUIRED;
}

type SessionEntry = {
  woo: Session;
  v2Token: string;
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
  dispose: () => void;
};

export type McpV2ClientHooks = {
  open: (scope: ObjRef, body: McpV2OpenBody) => Promise<McpV2OpenResult>;
  envelope: (scope: ObjRef, body: McpV2EnvelopeBody) => Promise<McpV2EnvelopeResult>;
  authorityPayload?: (extraObjectIds: ObjRef[]) => Promise<ReturnType<typeof v2TurnGatewayAuthorityPayload>>;
};

export type McpV2OpenBody = {
  scope: ObjRef;
  node: string;
  token: string;
  session: string;
  actor: ObjRef;
  sessions: ReturnType<WooWorld["exportSessions"]>;
  session_objects: ReturnType<WooWorld["exportObjects"]>;
  authority?: SerializedAuthoritySlice;
  serialized?: ReturnType<WooWorld["exportWorld"]>;
};

export type McpV2OpenResult = {
  ok: true;
  relay: string;
  head?: ShadowScopeHead;
};

export type McpV2EnvelopeBody = {
  scope: ObjRef;
  node: string;
  token: string;
  session: string;
  actor: ObjRef;
  sessions: ReturnType<WooWorld["exportSessions"]>;
  session_objects: ReturnType<WooWorld["exportObjects"]>;
  authority?: SerializedAuthoritySlice;
  envelope: string;
};

export type McpV2EnvelopeResult = {
  ok: true;
  reply: string | null;
  head?: ShadowScopeHead;
  local_host_materialized?: {
    hostKey: string;
    gatewayHost?: boolean;
  } | null;
};

type V2ScopeClient = {
  scope: ObjRef;
  relay: ShadowBrowserRelayShim;
  openedSessions: Set<string>;
  openingSessions: Map<string, Promise<void>>;
};

type RemoteAcceptedCommit = {
  commit: ShadowCommitAccepted;
  transcript: EffectTranscript;
  originSessionId: string | null;
  receivedAt: number;
};

export type McpGatewayOptions = {
  serverName?: string;
  serverVersion?: string;
  broadcasts?: McpBroadcastHooks;
  dispatch?: McpDispatchHooks;
  v2?: McpV2ClientHooks;
};

export class McpGateway {
  readonly host: McpHost;
  private sessions = new Map<string, SessionEntry>();
  private v2Scopes = new Map<ObjRef, V2ScopeClient>();
  private v2ScopeInitializers = new Map<ObjRef, Promise<V2ScopeClient>>();
  private remoteAccepted = new Set<string>();
  private remoteAcceptedOrder: string[] = [];
  private remotePending = new Map<ObjRef, Map<number, RemoteAcceptedCommit>>();
  private remotePendingCount = 0;

  constructor(private world: WooWorld, private options: McpGatewayOptions = {}) {
    const dispatch = options.v2 ? {
      direct: async (sessionId: string, actor: ObjRef, target: ObjRef, verb: string, args: WooValue[], scope?: ObjRef | null, persistence?: "durable" | "live") =>
        await this.invokeV2Direct(sessionId, actor, target, verb, args, scope, persistence),
      call: async (sessionId: string, actor: ObjRef, space: ObjRef, message: Message) =>
        await this.invokeV2Call(sessionId, actor, space, message)
    } satisfies McpDispatchHooks : options.dispatch;
    this.host = new McpHost(world, dispatch);
    if (options.broadcasts) this.host.setBroadcastHooks(options.broadcasts);
  }

  setBroadcastHooks(hooks: McpBroadcastHooks): void {
    this.host.setBroadcastHooks(hooks);
  }

  async handle(request: Request): Promise<Response> {
    const headers = request.headers;
    const startedAt = Date.now();
    const probe = await jsonRpcProbeFromRequest(request);

    if (request.method === "DELETE") {
      const id = headers.get(MCP_SESSION_HEADER);
      if (id) this.closeSession(id);
      this.world.recordMetric({ kind: "mcp_request", method: "session_delete", ms: Date.now() - startedAt, status: "ok" });
      return new Response(null, { status: 204 });
    }

    const sessionHeader = headers.get(MCP_SESSION_HEADER);
    let entry: SessionEntry | undefined = sessionHeader ? this.sessions.get(sessionHeader) : undefined;

    if (sessionHeader && !entry) {
      // The in-memory `sessions` map is per-DO-instance and lost across
      // hibernation. Because we minted the MCP session id from the woo
      // session id (see `bind` below), the persisted world.sessions table
      // still has the actor binding — resume by rebinding a fresh transport
      // around it, with a synthetic initialize so the SDK transport ends up
      // in the same `_initialized` state the original handshake left it in.
      const resumed = await this.tryResume(sessionHeader);
      if (!resumed) {
        this.world.recordMetric({ kind: "mcp_request", method: probe.method ?? "unknown", tool: probe.tool, ms: Date.now() - startedAt, status: "error" });
        return mcpError(request, 404, -32001, "E_NOSESSION", "MCP session not found; reinitialize");
      }
      entry = resumed;
    }

    if (!entry) {
      if (request.method !== "POST") {
        this.world.recordMetric({ kind: "mcp_request", method: probe.method ?? "unknown", tool: probe.tool, ms: Date.now() - startedAt, status: "error" });
        return mcpError(request, 401, -32001, "E_NOSESSION", "mcp gateway requires Mcp-Session-Id (or POST + auth token to initialize)");
      }
      const token = authTokenFromHeaders(headers);
      if (!token) {
        this.world.recordMetric({ kind: "mcp_request", method: probe.method ?? "unknown", tool: probe.tool, ms: Date.now() - startedAt, status: "error" });
        return mcpError(request, 401, -32001, "E_NOSESSION", "first MCP request must include Mcp-Token or Authorization: Bearer <token>");
      }
      if (!isAcceptedWooAuthToken(token)) {
        this.world.recordMetric({ kind: "mcp_request", method: probe.method ?? "unknown", tool: probe.tool, ms: Date.now() - startedAt, status: "error" });
        return mcpError(request, 401, -32001, "E_NOSESSION", "MCP auth token must be guest:, session:, wizard:, or apikey:");
      }
      try {
        const woo = this.world.auth(token);
        entry = this.bind(woo);
      } catch (err) {
        const error = err as { code?: string; message?: string };
        this.world.recordMetric({ kind: "mcp_request", method: probe.method ?? "unknown", tool: probe.tool, ms: Date.now() - startedAt, status: "error" });
        return mcpError(request, 401, -32001, error.code ?? "E_NOSESSION", error.message ?? "auth failed");
      }
    }

    try {
      const response = await entry.transport.handleRequest(withRequiredMcpAccept(request));
      const transportId = entry.transport.sessionId;
      if (transportId && !this.sessions.has(transportId)) {
        this.sessions.set(transportId, entry);
        this.host.bindSession(transportId, entry.woo.actor);
      }
      this.world.recordMetric({ kind: "mcp_request", method: probe.method ?? "unknown", tool: probe.tool, ms: Date.now() - startedAt, status: "ok" });
      return response;
    } catch (err) {
      const error = err as { code?: string; message?: string };
      this.world.recordMetric({ kind: "mcp_request", method: probe.method ?? "unknown", tool: probe.tool, ms: Date.now() - startedAt, status: "error" });
      return mcpError(request, 500, -32603, error.code ?? "E_INTERNAL", error.message ?? "internal MCP gateway error");
    }
  }

  // ----- broadcast routing — called by the host runtime so external
  // observations reach MCP-attached agents the same way they reach WS clients.

  routeAppliedFrame(frame: AppliedFrame, originSessionId?: string | null): void {
    this.host.routeAppliedFrame(frame, originSessionId ?? null);
  }

  routeLiveEvents(result: DirectResultFrame, originSessionId?: string | null): void {
    this.host.routeLiveEvents(result, originSessionId ?? null);
  }

  closeSession(id: string, options: { unbind?: boolean } = {}): void {
    const entry = this.sessions.get(id);
    if (entry) {
      entry.dispose();
      void entry.transport.close().catch(() => {});
      this.sessions.delete(id);
    }
    if (options.unbind !== false) this.host.unbindSession(id);
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  // Visible for tests / dev introspection: bind a session id directly without
  // going through the HTTP transport. Used by tests that drive the host API
  // without an MCP client.
  bindActorSession(sessionId: string, actor: ObjRef): void {
    this.host.bindSession(sessionId, actor);
  }

  acceptRemoteV2Commit(scope: ObjRef, commit: ShadowCommitAccepted, transcript: EffectTranscript, originSessionId?: string | null): void {
    const commitScope = commit.position.scope;
    const key = remoteAcceptedKey(commit);
    if (this.remoteAccepted.has(key)) return;
    const pending = this.remotePending.get(commitScope);
    if (pending?.has(commit.position.seq)) return;

    this.pruneRemotePending();
    const entry = { commit, transcript, originSessionId: originSessionId ?? null, receivedAt: Date.now() };
    const expectedSeq = this.remoteExpectedSeq(commitScope);
    if (expectedSeq === null) {
      this.applyRemoteAccepted(scope, entry);
      return;
    }
    if (commit.position.seq < expectedSeq) {
      this.rememberRemoteAccepted(key);
      return;
    }
    if (commit.position.seq > expectedSeq) {
      this.queueRemoteAccepted(commitScope, entry);
      return;
    }
    this.applyRemoteAccepted(scope, entry);
    this.drainRemoteAccepted(scope, commitScope);
  }

  acceptRemoteV2Live(scope: ObjRef, transcript: EffectTranscript, originSessionId?: string | null): void {
    const key = remoteLiveAcceptedKey(scope, transcript);
    if (this.remoteAccepted.has(key)) return;
    this.rememberRemoteAccepted(key);
    this.host.routeLiveEvents(liveFrameFromTranscript(scope, transcript), originSessionId ?? null);
  }

  private applyRemoteAccepted(scope: ObjRef, entry: RemoteAcceptedCommit): void {
    this.rememberRemoteAccepted(remoteAcceptedKey(entry.commit));
    const client = this.v2Scopes.get(scope);
    if (client) {
      applyAcceptedShadowFrame(client.relay.commit_scope, entry.commit, entry.transcript);
      markShadowBrowserRelaySerializedChanged(client.relay);
    }
    this.world.applyCommittedShadowTranscript(entry.transcript);
    this.propagateTranscriptToOtherScopes(entry.commit.position.scope, entry.transcript);
    this.host.routeShadowAcceptedFrame(entry.commit, entry.originSessionId, entry.transcript);
  }

  private drainRemoteAccepted(scope: ObjRef, commitScope: ObjRef): void {
    const pending = this.remotePending.get(commitScope);
    if (!pending) return;
    while (true) {
      const expectedSeq = this.remoteExpectedSeq(commitScope);
      if (expectedSeq === null) break;
      const entry = pending.get(expectedSeq);
      if (!entry) break;
      pending.delete(expectedSeq);
      this.remotePendingCount -= 1;
      this.applyRemoteAccepted(scope, entry);
    }
    if (pending.size === 0) this.remotePending.delete(commitScope);
  }

  private remoteExpectedSeq(scope: ObjRef): number | null {
    const head = this.v2Scopes.get(scope)?.relay.commit_scope.head;
    return head ? head.seq + 1 : null;
  }

  private queueRemoteAccepted(scope: ObjRef, entry: RemoteAcceptedCommit): void {
    let pending = this.remotePending.get(scope);
    if (!pending) {
      pending = new Map();
      this.remotePending.set(scope, pending);
    }
    pending.set(entry.commit.position.seq, entry);
    this.remotePendingCount += 1;
    this.trimRemotePending();
  }

  private rememberRemoteAccepted(key: string): void {
    if (this.remoteAccepted.has(key)) return;
    this.remoteAccepted.add(key);
    this.remoteAcceptedOrder.push(key);
    while (this.remoteAcceptedOrder.length > REMOTE_ACCEPTED_LRU_LIMIT) {
      const oldest = this.remoteAcceptedOrder.shift();
      if (oldest) this.remoteAccepted.delete(oldest);
    }
  }

  private pruneRemotePending(): void {
    const cutoff = Date.now() - REMOTE_PENDING_MAX_AGE_MS;
    for (const [scope, pending] of this.remotePending) {
      for (const [seq, entry] of pending) {
        if (entry.receivedAt >= cutoff) continue;
        pending.delete(seq);
        this.remotePendingCount -= 1;
      }
      if (pending.size === 0) this.remotePending.delete(scope);
    }
  }

  private trimRemotePending(): void {
    while (this.remotePendingCount > REMOTE_PENDING_LIMIT) {
      let oldestScope: ObjRef | null = null;
      let oldestSeq: number | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [scope, pending] of this.remotePending) {
        for (const [seq, entry] of pending) {
          if (entry.receivedAt >= oldestAt) continue;
          oldestAt = entry.receivedAt;
          oldestScope = scope;
          oldestSeq = seq;
        }
      }
      if (oldestScope === null || oldestSeq === null) break;
      const pending = this.remotePending.get(oldestScope);
      if (!pending?.delete(oldestSeq)) break;
      this.remotePendingCount -= 1;
      if (pending.size === 0) this.remotePending.delete(oldestScope);
    }
  }

  private bind(woo: Session): SessionEntry {
    const v2Token = mcpV2Token(woo);
    const { server, dispose } = createMcpServer({
      world: this.world,
      host: this.host,
      actor: woo.actor,
      sessionId: woo.id,
      serverName: this.options.serverName ?? "woo",
      serverVersion: this.options.serverVersion ?? "0.0.0"
    });

    // Mint the MCP transport session id from the woo session id so the
    // resume path on a hibernated DO can recover state from the (already
    // persisted) world.sessions table without any extra writes.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => woo.id,
      enableJsonResponse: true,
      onsessionclosed: (id) => { this.closeSession(id, { unbind: false }); }
    });

    void server.connect(transport).catch(() => {});

    return { woo, v2Token, server, transport, dispose };
  }

  private async tryResume(sessionId: string): Promise<SessionEntry | null> {
    let woo: Session;
    try {
      woo = this.world.auth(`session:${sessionId}`);
    } catch {
      return null;
    }
    const entry = this.bind(woo);
    try {
      const initResponse = await entry.transport.handleRequest(synthesizeInitializeRequest());
      // Drain any body to release the underlying stream.
      await initResponse.body?.cancel().catch(() => {});
    } catch {
      entry.dispose();
      void entry.transport.close().catch(() => {});
      return null;
    }
    if (entry.transport.sessionId !== woo.id) {
      // SDK refused the synthetic initialize for some reason; bail rather than
      // leak a half-bound entry.
      entry.dispose();
      void entry.transport.close().catch(() => {});
      return null;
    }
    this.sessions.set(woo.id, entry);
    this.host.bindSession(woo.id, woo.actor);
    return entry;
  }

  private async invokeV2Direct(
    sessionId: string,
    actor: ObjRef,
    target: ObjRef,
    verb: string,
    args: WooValue[],
    scope?: ObjRef | null,
    persistence: "durable" | "live" = "durable"
  ): Promise<DirectResultFrame | ErrorFrame> {
    // Direct calls record under their live audience when there is one, and
    // under the shadow direct-call scope (`#-1`) otherwise. McpHost passes the
    // tool's enclosing scope so the CommitScopeDO route matches the transcript.
    const frame = await this.invokeV2(sessionId, actor, "direct", target, verb, args, scope ?? "#-1", persistence);
    if (frame.op === "applied") throw new Error(`v2 direct call returned applied frame: ${target}:${verb}`);
    return frame;
  }

  private async invokeV2Call(
    sessionId: string,
    actor: ObjRef,
    space: ObjRef,
    message: Message
  ): Promise<AppliedFrame | ErrorFrame> {
    const frame = await this.invokeV2(sessionId, actor, "sequenced", message.target, message.verb, message.args, space);
    if (frame.op === "result") throw new Error(`v2 sequenced call returned direct result: ${message.target}:${message.verb}`);
    return frame;
  }

  private async invokeV2(
    sessionId: string,
    actor: ObjRef,
    route: ShadowTurnCall["route"],
    target: ObjRef,
    verb: string,
    args: WooValue[],
    explicitScope?: ObjRef | null,
    persistence: "durable" | "live" = "durable"
  ): Promise<AppliedFrame | DirectResultFrame | ErrorFrame> {
    const hooks = this.options.v2;
    if (!hooks) throw new Error("MCP v2 client hooks are not configured");
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`MCP session is not bound: ${sessionId}`);
    const scope = explicitScope ?? this.scopeForV2Call(actor, target);
    const id = `mcp-v2:${sessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const submitted = await submitTurnIntent<V2ScopeClient, McpV2EnvelopeResult>({
      input: {
        id,
        route,
        scope,
        session: entry.woo.id,
        actor,
        target,
        verb,
        args,
        persistence,
        token: entry.v2Token
      },
      strategy: "intent",
      ensureClient: async (submitScope) => await this.ensureV2ScopeClient(entry, submitScope),
      clientNode: () => this.v2NodeFor(entry),
      nextTurnId: () => id,
      authorityPayload: async (_submitScope, extraObjectIds) => {
        const payload = await this.v2AuthorityPayload(extraObjectIds);
        const client = this.v2Scopes.get(scope);
        if (client) this.mergeV2AuthorityIntoScopeClient(client, payload.authority);
        return payload;
      },
      submitEnvelope: async (submitScope, body) => await hooks.envelope(submitScope, body),
      // Forward planning-phase verb metrics to the gateway world's metrics
      // hook so direct_call/applied/dispatch_resolved/broadcast events land
      // in AE and drive the /admin/ footprint-by-verb view.
      onMetric: (event) => this.world.recordMetric(event)
    });
    if (submitted.kind === "local_frame") return submitted.frame;
    const result = submitted.result;
    const reply = submitted.reply;
    const client = submitted.client;
    if (!reply) {
      if (result.head) client.relay.commit_scope.head = result.head;
      return { op: "error", id, error: { code: "E_INTERNAL", message: "v2 MCP turn produced no reply" } };
    }
    if (!reply.ok) {
      if (result.head) client.relay.commit_scope.head = result.head;
      return { op: "error", id, error: { code: reply.reason, message: reply.reason, value: reply as unknown as WooValue } };
    }
    if (reply.commit) {
      this.acceptV2Commit(client, reply, sessionId, result.local_host_materialized ?? null);
    }
    const frame = mcpFrameFromTurnReply(scope, reply);
    if (!reply.commit && frame.op === "result") this.host.routeLiveEvents(frame, sessionId);
    return frame;
  }

  private async ensureV2ScopeClient(entry: SessionEntry, scope: ObjRef): Promise<V2ScopeClient> {
    const hooks = this.options.v2;
    if (!hooks) throw new Error("MCP v2 client hooks are not configured");
    let client = this.v2Scopes.get(scope);
    if (!client) {
      client = await this.initializeV2ScopeClient(entry, scope, hooks);
    }
    await this.ensureV2ScopeSessionOpen(entry, client, hooks);
    return client;
  }

  private async initializeV2ScopeClient(entry: SessionEntry, scope: ObjRef, hooks: McpV2ClientHooks): Promise<V2ScopeClient> {
    const existing = this.v2Scopes.get(scope);
    if (existing) return existing;
    const pending = this.v2ScopeInitializers.get(scope);
    if (pending) return await pending;
    // First-open seeding is the expensive path: authority slice plus full
    // exportWorld for the local relay and, only if CommitScopeDO lacks a
    // durable row snapshot, a serialized /v2/open retry. Coalesce it per scope
    // so parallel sessions do not each build and post the same snapshot.
    const initializer = (async () => {
      const seeded = await this.v2SerializedWorld([scope, entry.woo.actor]);
      const client: V2ScopeClient = {
        scope,
        relay: createShadowBrowserRelayShim({
          node: `mcp-v2-relay:${scope}`,
          scope,
          serialized: seeded.serialized
        }),
        openedSessions: new Set(),
        openingSessions: new Map()
      };
      await this.ensureV2ScopeSessionOpen(entry, client, hooks, seeded);
      this.v2Scopes.set(scope, client);
      return client;
    })();
    this.v2ScopeInitializers.set(scope, initializer);
    try {
      return await initializer;
    } finally {
      if (this.v2ScopeInitializers.get(scope) === initializer) this.v2ScopeInitializers.delete(scope);
    }
  }

  private async ensureV2ScopeSessionOpen(
    entry: SessionEntry,
    client: V2ScopeClient,
    hooks: McpV2ClientHooks,
    seeded?: { serialized: ReturnType<WooWorld["exportWorld"]>; authority: ReturnType<typeof v2TurnGatewayAuthorityPayload> }
  ): Promise<void> {
    if (client.openedSessions.has(entry.woo.id)) return;
    const existing = client.openingSessions.get(entry.woo.id);
    if (existing) {
      await existing;
      return;
    }
    const pending = (async () => {
      const authority = seeded?.authority ?? await this.v2AuthorityPayload([client.scope, entry.woo.actor]);
      this.mergeV2AuthorityIntoScopeClient(client, authority.authority);
      const openBody: McpV2OpenBody = {
        scope: client.scope,
        node: this.v2NodeFor(entry),
        token: entry.v2Token,
        session: entry.woo.id,
        actor: entry.woo.actor,
        ...authority
      };
      let opened: McpV2OpenResult;
      try {
        opened = await hooks.open(client.scope, openBody);
      } catch (err) {
        if (!seeded || !isV2CommitScopeSnapshotRequiredError(err)) throw err;
        opened = await hooks.open(client.scope, { ...openBody, serialized: seeded.serialized });
      }
      if (opened.head) client.relay.commit_scope.head = opened.head;
      client.openedSessions.add(entry.woo.id);
    })();
    client.openingSessions.set(entry.woo.id, pending);
    try {
      await pending;
    } finally {
      if (client.openingSessions.get(entry.woo.id) === pending) client.openingSessions.delete(entry.woo.id);
    }
  }

  private async v2AuthorityPayload(extraObjectIds: ObjRef[]): Promise<ReturnType<typeof v2TurnGatewayAuthorityPayload>> {
    return await (this.options.v2?.authorityPayload?.(extraObjectIds) ?? Promise.resolve(v2TurnGatewayAuthorityPayload(this.world, extraObjectIds)));
  }

  private async v2SerializedWorld(extraObjectIds: ObjRef[]): Promise<{ serialized: ReturnType<WooWorld["exportWorld"]>; authority: ReturnType<typeof v2TurnGatewayAuthorityPayload> }> {
    const authority = await this.v2AuthorityPayload(extraObjectIds);
    const serialized = this.world.exportWorld();
    mergeV2TurnGatewayAuthority(serialized, authority.authority, { clone: true });
    return { serialized, authority };
  }

  private mergeV2AuthorityIntoScopeClient(client: V2ScopeClient, authority: SerializedAuthoritySlice): void {
    // The gateway keeps one relay per scope and mutates its serialized snapshot
    // with fresh session/actor authority. Relay-level cache generation must
    // move with that snapshot or open executable seed digests can validate
    // against pre-refresh pages.
    mergeV2TurnGatewayAuthority(client.relay.commit_scope.serialized, authority);
    markShadowBrowserRelaySerializedChanged(client.relay);
  }

  private acceptV2Commit(
    client: V2ScopeClient,
    reply: Extract<ShadowTurnExecReply, { ok: true }>,
    originSessionId: string,
    localHostMaterialized: McpV2EnvelopeResult["local_host_materialized"] = null
  ): void {
    if (!reply.commit || !reply.transcript) return;
    applyAcceptedShadowFrame(client.relay.commit_scope, reply.commit, reply.transcript);
    markShadowBrowserRelaySerializedChanged(client.relay);
    this.world.applyCommittedShadowTranscript(reply.transcript, localHostMaterialized
      ? { skipObjectHost: { hostKey: localHostMaterialized.hostKey, gatewayHost: localHostMaterialized.gatewayHost === true } }
      : {});
    this.propagateTranscriptToOtherScopes(reply.commit.position.scope, reply.transcript);
    this.host.routeShadowAcceptedFrame(reply.commit, originSessionId, reply.transcript);
  }

  // The commit happened in `originScope`; that scope's V2 client has had the
  // accepted frame applied (head advanced, serialized state updated). Other
  // cached scope clients also need the transcript's *writes* (without head
  // advancement) so that cross-scope state changes — most importantly an
  // actor's `location` after a room-to-room move — show up in whatever scope
  // the next call dispatches to. Without this, a `deck:west` commit updates
  // the deck client's snapshot but the chatroom client's snapshot still has
  // actor.location=the_deck, and the very next actor verb routed to the
  // chatroom scope reads the stale location.
  private propagateTranscriptToOtherScopes(originScope: ObjRef, transcript: EffectTranscript): void {
    for (const [scope, client] of this.v2Scopes) {
      if (scope === originScope) continue;
      applyShadowTranscriptToCommitScopeCache(client.relay.commit_scope, transcript);
      markShadowBrowserRelaySerializedChanged(client.relay);
    }
  }

  private scopeForV2Call(actor: ObjRef, target: ObjRef): ObjRef {
    const enclosing = this.host.enclosingSpaceFor(target);
    if (enclosing) return enclosing;
    const session = this.sessionsByActor(actor);
    return (session ? this.world.activeScopeForSession(session.woo.id) : null) ?? actor;
  }

  private sessionsByActor(actor: ObjRef): SessionEntry | null {
    for (const entry of this.sessions.values()) {
      if (entry.woo.actor === actor) return entry;
    }
    return null;
  }

  private v2NodeFor(entry: SessionEntry): string {
    return `mcp:${entry.woo.id}`;
  }

}

function mcpV2Token(woo: Session): string {
  return `mcp-v2:${woo.id}:${woo.actor}`;
}

function remoteAcceptedKey(commit: ShadowCommitAccepted): string {
  return `commit:${commit.position.scope}:${commit.position.seq}`;
}

function remoteLiveAcceptedKey(scope: ObjRef, transcript: EffectTranscript): string {
  return `live:${scope}:${transcript.hash}`;
}

function mcpFrameFromTurnReply(scope: ObjRef, reply: Extract<ShadowTurnExecReply, { ok: true }>): AppliedFrame | DirectResultFrame | ErrorFrame {
  if (reply.outcome.error) {
    return attachTranscript({
      op: "error",
      id: reply.id,
      error: reply.transcript.error ?? wooValueAsError(reply.outcome.error, "v2 MCP turn failed")
    }, reply.transcript);
  }
  if (reply.transcript.route === "direct") {
    return attachTranscript({
      op: "result",
      id: reply.id,
      command: reply.transcript.call,
      // DirectResultFrame requires a result value; direct calls that return
      // nothing have historically surfaced null rather than omitting it.
      result: reply.outcome.result ?? null,
      observations: reply.transcript.observations,
      audience: scope
    }, reply.transcript);
  }
  // ShadowCommitAccepted.position is the authority head, not log metadata; it
  // currently carries no accepted-at timestamp. Keep the old planned-frame
  // wall clock until commit replies grow an explicit authoritative timestamp.
  return attachTranscript({
    op: "applied",
    id: reply.id,
    space: reply.commit?.position.scope ?? reply.transcript.scope,
    seq: reply.commit ? Number(reply.commit.position.seq) : reply.transcript.seq,
    ts: Date.now(),
    message: {
      actor: reply.transcript.call.actor,
      target: reply.transcript.call.target,
      verb: reply.transcript.call.verb,
      args: reply.transcript.call.args
    },
    observations: reply.transcript.observations,
    // AppliedFrame.result is optional. Preserve null when the verb returned
    // null, and omit undefined so JSON output matches normal applied frames.
    ...(reply.transcript.result !== undefined ? { result: reply.transcript.result } : {})
  }, reply.transcript);
}

function liveFrameFromTranscript(scope: ObjRef, transcript: EffectTranscript): DirectResultFrame {
  return attachTranscript({
    op: "result",
    id: transcript.id,
    command: transcript.call,
    result: transcript.result ?? null,
    observations: transcript.observations,
    audience: scope
  }, transcript);
}

function attachTranscript<T extends AppliedFrame | DirectResultFrame | ErrorFrame>(frame: T, transcript: EffectTranscript): T {
  // MCP host uses this internal hint to decide whether a post-call tool-list
  // refresh is necessary. Keep it non-enumerable so public frame JSON and
  // broadcast payloads remain unchanged.
  Object.defineProperty(frame, "transcript", { value: transcript, enumerable: false });
  return frame;
}

function wooValueAsError(value: WooValue, fallbackMessage: string): ErrorValue {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const code = typeof value.code === "string" ? value.code : "E_INTERNAL";
    const message = typeof value.message === "string" ? value.message : fallbackMessage;
    return { code, message, value };
  }
  return { code: "E_INTERNAL", message: fallbackMessage, value };
}

function authTokenFromHeaders(headers: Headers): string | null {
  const explicit = headers.get(MCP_TOKEN_HEADER)?.trim();
  if (explicit) return explicit;
  const authorization = headers.get(AUTHORIZATION_HEADER)?.trim();
  if (!authorization) return null;
  const match = /^bearer\s+(.+)$/i.exec(authorization);
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

function isAcceptedWooAuthToken(token: string): boolean {
  // Keep MCP's first-request auth vocabulary aligned with REST auth. Without
  // this gate, `world.auth` treats arbitrary strings as bearer-style guest
  // bootstrap tokens, which is convenient locally but too permissive on MCP.
  return token.startsWith("guest:")
    || token.startsWith("session:")
    || token.startsWith("wizard:")
    || token.startsWith("apikey:");
}

function withRequiredMcpAccept(request: Request): Request {
  const headers = new Headers(request.headers);
  const accept = headers.get("accept") ?? "";
  const needed = ["application/json", "text/event-stream"].filter((type) => !accept.toLowerCase().includes(type));
  if (needed.length === 0) return request;
  headers.set("accept", [accept.trim(), ...needed].filter(Boolean).join(", "));
  return new Request(request, { headers });
}

async function mcpError(request: Request, status: number, rpcCode: number, code: string, message: string): Promise<Response> {
  const id = await jsonRpcIdFromRequest(request);
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code: rpcCode,
      message,
      data: { code }
    }
  }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function jsonRpcProbeFromRequest(request: Request): Promise<{ method: string | null; tool?: string }> {
  if (request.method !== "POST") return { method: null };
  try {
    const parsed = await request.clone().json() as unknown;
    const single = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!single || typeof single !== "object") return { method: null };
    const m = (single as { method?: unknown }).method;
    const method = typeof m === "string" ? m : null;
    if (method === "tools/call") {
      const params = (single as { params?: { name?: unknown } }).params;
      const name = params && typeof params.name === "string" ? params.name : undefined;
      return { method, tool: name };
    }
    return { method };
  } catch {
    return { method: null };
  }
}

async function jsonRpcIdFromRequest(request: Request): Promise<string | number | null> {
  if (request.method !== "POST") return null;
  try {
    const parsed = await request.clone().json() as unknown;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const id = jsonRpcIdFromValue(item);
        if (id !== null) return id;
      }
      return null;
    }
    return jsonRpcIdFromValue(parsed);
  } catch {
    return null;
  }
}

function jsonRpcIdFromValue(value: unknown): string | number | null {
  if (!value || typeof value !== "object") return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" || id === null ? id : null;
}

function synthesizeInitializeRequest(): Request {
  return new Request("http://gateway.internal/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "resume",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "woo-resume", version: "0.0.0" }
      }
    })
  });
}

export type { ObjRef };
