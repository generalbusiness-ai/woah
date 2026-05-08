import http from "node:http";
import { createHash } from "node:crypto";
import { parse } from "node:url";
import { createServer as createViteServer } from "vite";
import { WebSocket, WebSocketServer } from "ws";
import { compileVerb, definePropertyVersionedAs, installVerbAs, setPropertyValueVersionedAs } from "../core/authoring";
import { createWorld } from "../core/bootstrap";
import { parseAutoInstallCatalogs } from "../core/local-catalogs";
import { appliedFromLogEntry, handleRestProtocolRequest, handleWsProtocolFrame, isSpaceLike, parseWsProtocolFrame, type RestProtocolRequest } from "../core/protocol";
import { normalizeError, type ParkedTaskRun } from "../core/world";
import {
  directedRecipients,
  publicAppliedFrame,
  wooError,
  type AppliedFrame,
  type DirectResultFrame,
  type LiveEventFrame,
  type ObjRef,
  type Session,
  type WooValue
} from "../core/types";
import { installGitHubTap, updateGitHubTap } from "./github-taps";
import { LocalSQLiteRepository } from "./sqlite-repository";
import { McpGateway } from "../mcp/gateway";

// Local dev server only: HTTP authoring endpoints require a session and then
// defer to the world's object-authoring permission checks.
const repository = new LocalSQLiteRepository(process.env.WOO_DB ?? ".woo/dev.sqlite");
const world = createWorld({ repository, catalogs: parseAutoInstallCatalogs(process.env.WOO_AUTO_INSTALL_CATALOGS) });
if (process.env.WOO_METRICS !== "off") {
  world.setMetricsHook((event) => console.log("woo.metric", JSON.stringify({ ...event, ts: Date.now(), host_key: "dev" })));
}
const mcpGateway = new McpGateway(world, {
  serverName: "woo-dev",
  broadcasts: {
    broadcastApplied: (frame, originSessionId) => broadcastApplied(frame, undefined, originSessionId),
    broadcastLiveEvents: (result, originSessionId) => broadcastLiveEvents(result, originSessionId)
  }
});
type AttachedSocket = { sessionId: string; actor: string; socketId: string };
const sockets = new Map<WebSocket, AttachedSocket>();
type RestStream = { id: string; res: http.ServerResponse; actor: ObjRef; target: ObjRef; scope: "space" | "actor" };
const restStreams = new Set<RestStream>();
let socketCounter = 1;
let streamCounter = 1;
const port = Number(process.env.PORT ?? 5173);
const hmrPort = Number(process.env.VITE_HMR_PORT ?? port + 10_000);
const MAX_HTTP_BODY_BYTES = 1 * 1024 * 1024;
const MAX_WS_FRAME_BYTES = 256 * 1024;

const vite = await createViteServer({
  server: { middlewareMode: true, hmr: { port: hmrPort } },
  appType: "spa"
});

const server = http.createServer(async (req, res) => {
  const url = parse(req.url ?? "", true);
  try {
    if (url.pathname === "/mcp" && (req.method === "POST" || req.method === "GET" || req.method === "DELETE")) {
      const webRequest = await nodeRequestToWeb(req);
      const webResponse = await mcpGateway.handle(webRequest);
      await writeWebResponseToNode(webResponse, res);
      return;
    }
    const protocol = await handleRestProtocolRequest(nodeRestRequest(req, url.pathname ?? ""), {
      world,
      authenticateToken,
      requireSession: () => requireRestSession(req),
      state: (actor) => world.state(actor),
      installTap: (actor, body) => installGitHubTap(world, actor, {
        tap: String(body.tap ?? ""),
        catalog: String(body.catalog ?? ""),
        ref: typeof body.ref === "string" ? body.ref : undefined,
        as: typeof body.as === "string" ? body.as : undefined
      }, { hashText: nodeHashText }),
      updateTap: (actor, body) => updateGitHubTap(world, actor, {
        tap: String(body.tap ?? ""),
        catalog: String(body.catalog ?? ""),
        ref: typeof body.ref === "string" ? body.ref : undefined,
        as: typeof body.as === "string" ? body.as : undefined,
        accept_major: body.accept_major === true
      }, { hashText: nodeHashText }),
      openStream: (_request, rawTarget, target, session) => openRestStream(req, res, rawTarget, target, session) ? { handled: true, raw: true } : { handled: false },
      broadcastApplied,
      broadcastLiveEvents
    });
    if (protocol.handled) {
      if ("raw" in protocol) return;
      return json(res, protocol.body, protocol.status, protocol.headers);
    }
    if (req.method === "POST" && url.pathname === "/api/compile") {
      if (!authoringEnabled()) return json(res, { error: wooError("E_PERM", "authoring endpoints are disabled") }, 403);
      requireRestSession(req);
      const body = await readJson(req);
      return json(res, compileVerb(String(body.source ?? ""), { format: body.format }));
    }
    if (req.method === "POST" && url.pathname === "/api/install") {
      if (!authoringEnabled()) return json(res, { error: wooError("E_PERM", "authoring endpoints are disabled") }, 403);
      const session = requireRestSession(req);
      const body = await readJson(req);
      const result = installVerbAs(
        world,
        session.actor,
        String(body.object),
        String(body.name),
        String(body.source ?? ""),
        body.expected_version ?? null,
        { format: body.format }
      );
      return json(res, result);
    }
    if (req.method === "POST" && url.pathname === "/api/property") {
      if (!authoringEnabled()) return json(res, { error: wooError("E_PERM", "authoring endpoints are disabled") }, 403);
      const session = requireRestSession(req);
      const body = await readJson(req);
      const result = definePropertyVersionedAs(
        world,
        session.actor,
        String(body.object),
        String(body.name),
        body.default ?? null,
        String(body.perms ?? "rw"),
        body.expected_version ?? null,
        body.type_hint
      );
      return json(res, result);
    }
    if (req.method === "POST" && url.pathname === "/api/property/value") {
      if (!authoringEnabled()) return json(res, { error: wooError("E_PERM", "authoring endpoints are disabled") }, 403);
      const session = requireRestSession(req);
      const body = await readJson(req);
      return json(res, setPropertyValueVersionedAs(world, session.actor, String(body.object), String(body.name), body.value as WooValue, body.expected_version ?? null));
    }
    if (req.method === "POST" && url.pathname === "/api/authoring/objects/create") {
      if (!authoringEnabled()) return json(res, { error: wooError("E_PERM", "authoring endpoints are disabled") }, 403);
      const session = requireRestSession(req);
      const body = await readJson(req);
      const id = world.createAuthoredObject(session.actor, {
        parent: String(body.parent ?? "$thing"),
        name: typeof body.name === "string" ? body.name : undefined,
        description: typeof body.description === "string" ? body.description : undefined,
        aliases: Array.isArray(body.aliases) ? body.aliases as WooValue[] : undefined,
        location: typeof body.location === "string" ? body.location : null
      });
      return json(res, { id, object: world.describeForActor(id, session.actor) });
    }
    if (req.method === "POST" && url.pathname === "/api/authoring/objects/move") {
      if (!authoringEnabled()) return json(res, { error: wooError("E_PERM", "authoring endpoints are disabled") }, 403);
      const session = requireRestSession(req);
      const body = await readJson(req);
      world.moveAuthoredObject(session.actor, String(body.object), String(body.location));
      return json(res, { ok: true, object: world.describeForActor(String(body.object), session.actor) });
    }
    if (req.method === "POST" && url.pathname === "/api/authoring/objects/chparent") {
      if (!authoringEnabled()) return json(res, { error: wooError("E_PERM", "authoring endpoints are disabled") }, 403);
      const session = requireRestSession(req);
      const body = await readJson(req);
      world.chparentAuthoredObject(session.actor, String(body.object), String(body.parent));
      return json(res, { ok: true, object: world.describeForActor(String(body.object), session.actor) });
    }
  } catch (err) {
    return json(res, { error: normalizeError(err) }, 400);
  }

  vite.middlewares(req, res);
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  const socketId = `ws-${socketCounter++}`;
  ws.on("message", (raw) => {
    if (rawDataSize(raw) > MAX_WS_FRAME_BYTES) {
      ws.close(1009, "frame too large");
      return;
    }
    const frame = parseWsProtocolFrame(String(raw));
    if (frame.op === "error") {
      ws.send(JSON.stringify(frame));
      return;
    }
    void handleWsProtocolFrame(ws, frame, {
      defaultAuthToken: "guest:dev",
      authenticate: (token) => authenticateToken(token),
      attach: (_connection, session) => {
        const previous = sockets.get(ws);
        if (previous) world.detachSocket(previous.sessionId, previous.socketId);
        world.attachSocket(session.id, socketId);
        sockets.set(ws, { sessionId: session.id, actor: session.actor, socketId });
      },
      session: () => attachedSession(ws),
      send: (_connection, frameValue) => ws.send(JSON.stringify(frameValue)),
      call: (frameId, session, space, message) => {
        world.touchSessionInput(session.sessionId);
        return world.call(frameId, session.sessionId, space, message);
      },
      command: (frameId, session, space, text) => {
        world.touchSessionInput(session.sessionId);
        return world.command(frameId, session.sessionId, space, text);
      },
      direct: (frameId, session, target, verb, args) => {
        world.touchSessionInput(session.sessionId);
        return world.directCall(frameId, session.actor, target, verb, args, { sessionId: session.sessionId });
      },
      replay: (frameId, session, space, fromValue, limitValue) => {
        // Replay is recovery, not user input — does NOT touch lastInputAt.
        if (!world.hasPresence(session.actor, space)) throw wooError("E_PERM", `${session.actor} is not present in ${space}`);
        const from = Math.max(1, Number(fromValue ?? 1));
        const limit = Math.min(Math.max(1, Number(limitValue ?? 100)), 500);
        return { op: "replay", id: frameId, space, from, entries: world.replay(space, from, limit) };
      },
      deliverInput: (session, input) => {
        world.touchSessionInput(session.sessionId);
        return world.deliverInput(session.actor, input);
      },
      broadcastApplied: (frameValue, originator) => broadcastApplied(frameValue, originator),
      broadcastTaskResult,
      broadcastLiveEvents: (result, originator) => broadcastLiveEvents(result, null, originator)
    });
  });
  ws.on("close", () => {
    const session = sockets.get(ws);
    if (session) world.detachSocket(session.sessionId, session.socketId);
    sockets.delete(ws);
  });
});

server.listen(port, () => {
  console.log(`woo dev server http://localhost:${port}`);
});

setInterval(() => {
  void (async () => {
    for (const result of await world.runDueTasks()) broadcastTaskResult(result);
  })().catch((err: unknown) => {
    console.error("runDueTasks failed", err);
  });
  expireAttachedSessions(world.reapExpiredSessions());
}, 250).unref();

function attachedSession(ws: WebSocket): AttachedSocket | null {
  const session = sockets.get(ws);
  if (!session) return null;
  if (world.sessionAlive(session.sessionId)) return session;
  expireAttachedSessions([session.sessionId]);
  return null;
}

function expireAttachedSessions(sessionIds: string[]): void {
  if (sessionIds.length === 0) return;
  const expired = new Set(sessionIds);
  for (const [ws, session] of Array.from(sockets.entries())) {
    if (!expired.has(session.sessionId)) continue;
    sockets.delete(ws);
    sendNoSession(ws, undefined, "session token is expired or unknown");
  }
}

function nodeHashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sendNoSession(ws: WebSocket, id: string | undefined, message: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ op: "error", id, error: { code: "E_NOSESSION", message } }));
}

function authoringEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.WOO_DEV === "1";
}

function broadcastApplied(frame: AppliedFrame, originator?: WebSocket, originMcpSessionId?: string | null): void {
  const audienceSessions = frame.audienceSessions ? new Set(frame.audienceSessions) : null;
  const publicFrame = publicAppliedFrame(frame);
  if (originator && originator.readyState === WebSocket.OPEN) originator.send(JSON.stringify(frame));
  for (const [ws, session] of sockets) {
    if (ws === originator) continue;
    if (ws.readyState !== ws.OPEN) continue;
    if (audienceSessions ? !audienceSessions.has(session.sessionId) : !world.hasPresence(session.actor, frame.space)) continue;
    ws.send(JSON.stringify(publicFrame));
  }
  broadcastAppliedSse(publicFrame);
  mcpGateway.routeAppliedFrame(publicFrame, originMcpSessionId ?? null);
}

function broadcastTaskResult(result: ParkedTaskRun): void {
  if (result.frame?.op === "applied") {
    broadcastApplied(result.frame);
    return;
  }
  const space = taskResultSpace(result);
  const data = JSON.stringify({ op: "task", task: result.task.id, space, observations: result.observations });
  for (const [ws, session] of sockets) {
    if (ws.readyState !== ws.OPEN || !world.hasPresence(session.actor, space)) continue;
    ws.send(data);
  }
}

function broadcastLiveEvents(result: DirectResultFrame, originMcpSessionId?: string | null, originator?: WebSocket): void {
  result.observations.forEach((observation, index) => {
    broadcastLiveEvent(
      { op: "event", observation },
      result.audience,
      result.observationAudiences?.[index] ?? result.audienceActors,
      result.observationSessionAudiences?.[index] ?? result.audienceSessions,
      originator
    );
  });
  mcpGateway.routeLiveEvents(result, originMcpSessionId ?? null);
}

function broadcastLiveEvent(frame: LiveEventFrame, audience: ObjRef | null, audienceActors?: ObjRef[], audienceSessions?: string[], originator?: WebSocket): void {
  const data = JSON.stringify(frame);
  const { to: directedTo, from: directedFrom } = directedRecipients(frame.observation);
  const audienceSet = audienceActors ? new Set(audienceActors) : null;
  const sessionSet = audienceSessions ? new Set(audienceSessions) : null;
  for (const [ws, session] of sockets) {
    if (ws.readyState !== ws.OPEN) continue;
    if (ws === originator) continue;
    if (directedTo || directedFrom) {
      if (session.actor !== directedTo && session.actor !== directedFrom) continue;
    } else if (sessionSet) {
      if (!sessionSet.has(session.sessionId)) continue;
    } else if (audienceSet) {
      if (!audienceSet.has(session.actor)) continue;
    } else if (!audience || !world.hasPresence(session.actor, audience)) {
      continue;
    }
    ws.send(data);
  }
  broadcastLiveEventSse(frame, audience, audienceActors);
}

function broadcastAppliedSse(frame: AppliedFrame): void {
  for (const stream of Array.from(restStreams)) {
    if (stream.scope === "space") {
      if (stream.target !== frame.space || !world.hasPresence(stream.actor, frame.space)) continue;
    } else if (!world.hasPresence(stream.actor, frame.space)) {
      continue;
    }
    writeSse(stream, "applied", frame, `${frame.space}:${frame.seq}`);
  }
}

function broadcastLiveEventSse(frame: LiveEventFrame, audience: ObjRef | null, audienceActors?: ObjRef[]): void {
  const { to: directedTo, from: directedFrom } = directedRecipients(frame.observation);
  const audienceSet = audienceActors ? new Set(audienceActors) : null;
  for (const stream of Array.from(restStreams)) {
    if (directedTo || directedFrom) {
      if (stream.actor !== directedTo && stream.actor !== directedFrom) continue;
    } else if (stream.scope === "space") {
      if (!audience || stream.target !== audience) continue;
      if (audienceSet ? !audienceSet.has(stream.actor) : !world.hasPresence(stream.actor, audience)) continue;
    } else if (audienceSet) {
      if (!audienceSet.has(stream.actor)) continue;
    } else if (!audience || !world.hasPresence(stream.actor, audience)) {
      continue;
    }
    writeSse(stream, "event", frame);
  }
}

function taskResultSpace(result: ParkedTaskRun): ObjRef {
  const serialized = result.task.serialized;
  if (serialized && typeof serialized === "object" && !Array.isArray(serialized) && typeof serialized.space === "string") return serialized.space;
  return result.task.parked_on;
}

function authenticateToken(token: string): Session {
  if (token.startsWith("wizard:")) return claimWizardSession(token.slice("wizard:".length));
  return world.auth(token);
}

function claimWizardSession(token: string): Session {
  return world.claimWizardBootstrapSession(token, process.env.WOO_INITIAL_WIZARD_TOKEN);
}

function requireRestSession(req: http.IncomingMessage): Session {
  const header = req.headers.authorization ?? "";
  const match = Array.isArray(header) ? null : /^Session\s+(.+)$/i.exec(header.trim());
  if (!match) throw wooError("E_NOSESSION", "Authorization: Session <id> required");
  return world.auth(`session:${match[1]}`);
}

function openRestStream(req: http.IncomingMessage, res: http.ServerResponse, rawTarget: string, target: ObjRef, session: Session): boolean {
  const scope: RestStream["scope"] = rawTarget === "$me" || !isSpaceLike(world, target) ? "actor" : "space";
  if (scope === "space" && !world.hasPresence(session.actor, target)) throw wooError("E_PERM", `${session.actor} is not present in ${target}`);

  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();

  const stream: RestStream = { id: `sse-${streamCounter++}`, res, actor: session.actor, target, scope };
  restStreams.add(stream);
  res.write("retry: 1000\n\n");

  const lastEventId = req.headers["last-event-id"];
  if (scope === "space" && typeof lastEventId === "string") {
    const lastSeq = parseLastEventSeq(lastEventId, target);
    if (lastSeq !== null) {
      for (const entry of world.replay(target, lastSeq + 1, 1000)) {
        writeSse(stream, "applied", appliedFromLogEntry(entry), `${entry.space}:${entry.seq}`);
      }
    }
  }

  req.on("close", () => {
    restStreams.delete(stream);
  });
  return true;
}

function parseLastEventSeq(value: string, space: ObjRef): number | null {
  const prefix = `${space}:`;
  if (!value.startsWith(prefix)) return null;
  const seq = Number(value.slice(prefix.length));
  return Number.isFinite(seq) && seq >= 0 ? seq : null;
}

function writeSse(stream: RestStream, event: "applied" | "event", data: unknown, id?: string): void {
  if (stream.res.writableEnded) {
    restStreams.delete(stream);
    return;
  }
  if (id) stream.res.write(`id: ${id}\n`);
  stream.res.write(`event: ${event}\n`);
  stream.res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, any>> {
  const body = await readLimitedBody(req, MAX_HTTP_BODY_BYTES);
  if (!body.length) return {};
  return JSON.parse(body.toString("utf8"));
}

function nodeRestRequest(req: http.IncomingMessage, pathname: string): RestProtocolRequest {
  const parsed = parse(req.url ?? "", true);
  return {
    method: req.method ?? "GET",
    pathname,
    query: (name) => {
      const value = parsed.query[name];
      if (Array.isArray(value)) return value[0] ?? null;
      return value ?? null;
    },
    header: (name) => {
      const value = req.headers[name.toLowerCase()];
      if (Array.isArray(value)) return value[0] ?? null;
      return value ?? null;
    },
    readJson: () => readJson(req)
  };
}

function json(res: http.ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  if (status === 304) {
    res.end();
    return;
  }
  res.end(JSON.stringify(body, null, 2));
}

async function nodeRequestToWeb(req: http.IncomingMessage): Promise<Request> {
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) headers.set(name, value.join(", "));
    else if (typeof value === "string") headers.set(name, value);
  }
  let body: BodyInit | null = null;
  if (req.method && req.method !== "GET" && req.method !== "HEAD") {
    const buffer = await readLimitedBody(req, MAX_HTTP_BODY_BYTES);
    if (buffer.length > 0) body = arrayBufferFromBuffer(buffer);
  }
  return new Request(url.toString(), { method: req.method, headers, body, duplex: "half" } as RequestInit);
}

async function readLimitedBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw wooError("E_RATE", `request body exceeds ${maxBytes} bytes`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) throw wooError("E_RATE", `request body exceeds ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  return chunks.length > 0 ? Buffer.concat(chunks, total) : Buffer.alloc(0);
}

function rawDataSize(raw: import("ws").RawData): number {
  if (typeof raw === "string") return Buffer.byteLength(raw, "utf8");
  if (Buffer.isBuffer(raw)) return raw.byteLength;
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  return raw.reduce((sum, item) => sum + item.byteLength, 0);
}

function arrayBufferFromBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return copy.buffer;
}

async function writeWebResponseToNode(response: Response, res: http.ServerResponse): Promise<void> {
  res.statusCode = response.status;
  for (const [name, value] of response.headers.entries()) res.setHeader(name, value);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}
