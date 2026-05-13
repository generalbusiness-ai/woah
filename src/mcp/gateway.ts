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
import type { AppliedFrame, DirectResultFrame, ErrorFrame, Message, ObjRef, Session, WooValue } from "../core/types";
import type { WooWorld } from "../core/world";
import { createMcpServer } from "./server";
import { McpHost, type McpBroadcastHooks, type McpDispatchHooks } from "./host";
import { encodeEnvelope, decodeEnvelope, type ShadowEnvelope } from "../core/shadow-envelope";
import {
  createShadowBrowserRelayShim,
  type ShadowBrowserRelayShim
} from "../core/shadow-browser-node";
import { runShadowTurnCall, type ShadowTurnCall } from "../core/shadow-turn-call";
import { applyAcceptedShadowFrame, type ShadowScopeHead } from "../core/shadow-commit-scope";
import type { ShadowTurnExecReply, ShadowTurnExecRequest } from "../core/shadow-turn-exec";
import { shadowTurnKeyFromTranscript } from "../core/turn-key";

const MCP_TOKEN_HEADER = "mcp-token";
const MCP_SESSION_HEADER = "mcp-session-id";
const AUTHORIZATION_HEADER = "authorization";

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
};

export type McpV2OpenBody = {
  scope: ObjRef;
  node: string;
  token: string;
  session: string;
  actor: ObjRef;
  sessions: ReturnType<WooWorld["exportSessions"]>;
  serialized: ReturnType<WooWorld["exportWorld"]>;
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
  envelope: string;
};

export type McpV2EnvelopeResult = {
  ok: true;
  reply: string | null;
  head?: ShadowScopeHead;
};

type V2ScopeClient = {
  scope: ObjRef;
  relay: ShadowBrowserRelayShim;
  openedSessions: Set<string>;
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

  constructor(private world: WooWorld, private options: McpGatewayOptions = {}) {
    const dispatch = options.v2 ? {
      direct: async (sessionId: string, actor: ObjRef, target: ObjRef, verb: string, args: WooValue[], scope?: ObjRef | null) =>
        await this.invokeV2Direct(sessionId, actor, target, verb, args, scope),
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

  closeSession(id: string): void {
    const entry = this.sessions.get(id);
    if (entry) {
      entry.dispose();
      void entry.transport.close().catch(() => {});
      this.sessions.delete(id);
    }
    this.host.unbindSession(id);
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
      onsessionclosed: (id) => { this.closeSession(id); }
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
    scope?: ObjRef | null
  ): Promise<DirectResultFrame | ErrorFrame> {
    // Direct calls record under their live audience when there is one, and
    // under the shadow direct-call scope (`#-1`) otherwise. McpHost passes the
    // tool's enclosing scope so the CommitScopeDO route matches the transcript.
    const frame = await this.invokeV2(sessionId, actor, "direct", target, verb, args, scope ?? "#-1");
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
    explicitScope?: ObjRef | null
  ): Promise<AppliedFrame | DirectResultFrame | ErrorFrame> {
    const hooks = this.options.v2;
    if (!hooks) throw new Error("MCP v2 client hooks are not configured");
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`MCP session is not bound: ${sessionId}`);
    const scope = explicitScope ?? this.scopeForV2Call(actor, target);
    const client = await this.ensureV2ScopeClient(entry, scope);
    const id = `mcp-v2:${sessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id,
      route,
      scope,
      session: entry.woo.id,
      actor,
      target,
      verb,
      args
    };
    const planned = await runShadowTurnCall(client.relay.commit_scope.serialized, call);
    const request: ShadowTurnExecRequest = {
      kind: "woo.turn.exec.request.shadow.v1",
      id,
      call,
      key: shadowTurnKeyFromTranscript(planned.transcript),
      expected: client.relay.commit_scope.head,
      commit_policy: "execute_and_commit"
    };
    const envelope: ShadowEnvelope<ShadowTurnExecRequest> = {
      v: 2,
      type: request.kind,
      id,
      from: this.v2NodeFor(entry),
      actor,
      session: entry.woo.id,
      auth: { mode: "session", token: entry.v2Token },
      body: request
    };
    const result = await hooks.envelope(scope, {
      scope,
      node: this.v2NodeFor(entry),
      token: entry.v2Token,
      session: entry.woo.id,
      actor,
      sessions: this.world.exportSessions(),
      envelope: encodeEnvelope(envelope)
    });
    const replyEnvelope = result.reply ? decodeEnvelope<ShadowTurnExecReply>(result.reply) : null;
    const reply = replyEnvelope?.body;
    if (!reply) {
      if (result.head) client.relay.commit_scope.head = result.head;
      return planned.frame;
    }
    if (!reply.ok) {
      if (result.head) client.relay.commit_scope.head = result.head;
      return { op: "error", id, error: { code: reply.reason, message: reply.reason, value: reply as unknown as WooValue } };
    }
    if (reply.commit) {
      this.acceptV2Commit(client, reply, sessionId);
    }
    return planned.frame;
  }

  private async ensureV2ScopeClient(entry: SessionEntry, scope: ObjRef): Promise<V2ScopeClient> {
    const hooks = this.options.v2;
    if (!hooks) throw new Error("MCP v2 client hooks are not configured");
    let client = this.v2Scopes.get(scope);
    if (!client) {
      client = {
        scope,
        relay: createShadowBrowserRelayShim({
          node: `mcp-v2-relay:${scope}`,
          scope,
          serialized: this.world.exportWorld()
        }),
        openedSessions: new Set()
      };
      this.v2Scopes.set(scope, client);
    }
    if (!client.openedSessions.has(entry.woo.id)) {
      const opened = await hooks.open(scope, {
        scope,
        node: this.v2NodeFor(entry),
        token: entry.v2Token,
        session: entry.woo.id,
        actor: entry.woo.actor,
        sessions: this.world.exportSessions(),
        serialized: this.world.exportWorld()
      });
      if (opened.head) client.relay.commit_scope.head = opened.head;
      client.openedSessions.add(entry.woo.id);
    }
    return client;
  }

  private acceptV2Commit(client: V2ScopeClient, reply: Extract<ShadowTurnExecReply, { ok: true }>, originSessionId: string): void {
    if (!reply.commit || !reply.transcript) return;
    applyAcceptedShadowFrame(client.relay.commit_scope, reply.commit, reply.transcript);
    this.world.applyCommittedShadowTranscript(reply.transcript);
    this.host.routeShadowAcceptedFrame(reply.commit, originSessionId);
  }

  private scopeForV2Call(actor: ObjRef, target: ObjRef): ObjRef {
    const enclosing = this.host.enclosingSpaceFor(target);
    if (enclosing) return enclosing;
    const session = this.sessionsByActor(actor);
    return (session ? this.world.currentLocationForSession(session.woo.id) : null) ?? actor;
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

function authTokenFromHeaders(headers: Headers): string | null {
  const explicit = headers.get(MCP_TOKEN_HEADER)?.trim();
  if (explicit) return explicit;
  const authorization = headers.get(AUTHORIZATION_HEADER)?.trim();
  if (!authorization) return null;
  const match = /^bearer\s+(.+)$/i.exec(authorization);
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
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
