import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { parse } from "node:url";
import { createServer as createViteServer } from "vite";
import { WebSocket, WebSocketServer } from "ws";
import { compileVerb, definePropertyVersionedAs, installVerbAs, setPropertyValueVersionedAs } from "../core/authoring";
import { createWorld } from "../core/bootstrap";
import { parseAutoInstallCatalogs } from "../core/local-catalogs";
import { handleRestProtocolRequest, restFrameFromTurnReply, type RestProtocolHost, type RestProtocolRequest } from "../core/protocol";
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
import {
  buildShadowBrowserSessionAuth,
  buildShadowBrowserDeltaTransfer,
  createShadowBrowserClient,
  createShadowBrowserRelayShim,
  disposeShadowBrowserNode,
  handleShadowBrowserTurnExecEnvelope,
  markShadowBrowserRelaySerializedChanged,
  mergeShadowBrowserAuthoritySessionState,
  openShadowBrowserScope,
  receiveShadowBrowserEnvelopeReceipt,
  shadowBrowserSessionBearer,
  shadowBrowserSessionClaimsValue,
  shadowLiveEventMatchesBrowser,
  shadowLiveEventsForTranscript,
  shadowBrowserTransportHello,
  type ShadowBrowserRelayShim
} from "../core/shadow-browser-node";
import { buildTransportErrorEnvelope, encodeEnvelope, type ShadowEnvelope } from "../core/shadow-envelope";
import { buildVerbThrewReplyEnvelope, decodeTurnIntentForRecovery, resolveTurnEnvelopeRouting } from "./dev-v2-routing";
import { stableShadowJson } from "../core/shadow-cell-version";
import type { ShadowCommitAccepted } from "../core/shadow-commit-scope";
import { parseShadowScopeHeadJson } from "../core/shadow-scope-head";
import {
  encodeV2TurnGatewayIntentEnvelope,
  v2TurnGatewayAuthorityObjectIds,
  v2TurnGatewayAuthorityPayload
} from "../core/v2-turn-gateway";

// Local dev server only: HTTP authoring endpoints require a session and then
// defer to the world's object-authoring permission checks.
const repository = new LocalSQLiteRepository(process.env.WOO_DB ?? ".woo/dev.sqlite");
const world = createWorld({ repository, catalogs: parseAutoInstallCatalogs(process.env.WOO_AUTO_INSTALL_CATALOGS) });
ensureLocaldevWizardApiKey();
if (process.env.WOO_METRICS !== "off") {
  world.setMetricsHook((event) => console.log("woo.metric", JSON.stringify({ ...event, ts: Date.now(), host_key: "dev" })));
}
const v2RelaysByScope = new Map<ObjRef, ShadowBrowserRelayShim>();
const v2SocketsByNode = new Map<string, WebSocket>();
const mcpGateway = new McpGateway(world, {
  serverName: "woo-dev",
  broadcasts: {
    broadcastApplied: (frame, originSessionId) => broadcastApplied(frame, undefined, originSessionId),
    broadcastLiveEvents: (result, originSessionId) => broadcastLiveEvents(result, originSessionId)
  }
});
type AttachedSocket = { sessionId: string; actor: string; socketId: string };
const sockets = new Map<WebSocket, AttachedSocket>();
let socketCounter = 1;
const port = Number(process.env.PORT ?? 5173);
const hmrPort = Number(process.env.VITE_HMR_PORT ?? port + 10_000);
const MAX_HTTP_BODY_BYTES = 1 * 1024 * 1024;

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
    if (req.method === "POST" && url.pathname === "/v2/session/mint") {
      const body = await readJson(req);
      const token = String(body.token ?? "");
      const session = authenticateToken(token);
      return json(res, {
        token: shadowBrowserSessionBearer(session),
        claims: shadowBrowserSessionClaimsValue(session, "local-dev", [session.actor])
      });
    }
    const protocol = await handleRestProtocolRequest(nodeRestRequest(req, url.pathname ?? ""), {
      world,
      authenticateToken,
      requireSession: () => requireRestSession(req),
      executeTurn: (input) => devRestV2Turn(input),
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

const v2wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols) => protocols.has("woo-v2.turn-network.json") ? "woo-v2.turn-network.json" : false
});

server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
  const target = pathname === "/v2/turn-network/ws" ? v2wss : null;
  if (!target) {
    socket.destroy();
    return;
  }
  target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
});

v2wss.on("connection", (ws, req) => {
  if (ws.protocol !== "woo-v2.turn-network.json") {
    ws.close(1002, "missing woo-v2.turn-network.json subprotocol");
    return;
  }
  const url = new URL(req.url ?? "/v2/turn-network/ws", `http://${req.headers.host ?? "localhost"}`);
  const token = url.searchParams.get("token") ?? "";
  const node = url.searchParams.get("node") || `browser:dev:${socketCounter++}`;
  const requestedScope = url.searchParams.get("scope") as ObjRef | null;
  const lastKnownHead = parseShadowScopeHeadJson(url.searchParams.get("last_known_head"));
  let session: Session;
  try {
    if (!token) throw wooError("E_NOSESSION", "token query parameter is required");
    session = authenticateToken(token);
  } catch (err) {
    ws.close(1008, normalizeError(err).message);
    return;
  }
  const scope = requestedScope || session.actor;

  const socketId = `v2-ws-${socketCounter++}`;
  world.attachSocket(session.id, socketId);
  sockets.set(ws, { sessionId: session.id, actor: session.actor, socketId });
  // The local WebSocket shim keeps one browser node for the connection, matching
  // the Worker path's socket-lifetime idempotency and cache behavior.
  const browser = v2ShadowBrowser(node, token, session, scope || session.actor);
  ensureDevV2SerializedSession(browser.relay, session);
  v2SocketsByNode.set(browser.node, ws);
  const hello = shadowBrowserTransportHello(browser);
  ws.send(encodeEnvelope({
    v: 2,
    type: hello.kind,
    id: `dev-relay:hello:${randomUUID()}`,
    from: browser.relay.node,
    to: browser.node,
    actor: session.actor,
    session: session.id,
    auth: { mode: "session", token },
    body: hello
  } satisfies ShadowEnvelope<typeof hello>));
  // Match the Worker binding: the first frame is TransportHello, followed by a
  // verified state-plane projection or catch-up delta for the requested scope.
  void openShadowBrowserScope(browser, {
    preseed_catalog_pages: true,
    ...(lastKnownHead ? { last_known_head: lastKnownHead } : {})
  }).then((opened) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(encodeEnvelope({
      v: 2,
      type: opened.transfer.kind,
      id: `dev-relay:state:${randomUUID()}`,
      from: browser.relay.node,
      to: browser.node,
      actor: session.actor,
      session: session.id,
      auth: { mode: "session", token },
      body: opened.transfer
    } satisfies ShadowEnvelope<typeof opened.transfer>));
    for (const ad of opened.ads) {
      ws.send(encodeEnvelope({
        v: 2,
        type: ad.kind,
        id: `dev-relay:exec-ad:${randomUUID()}`,
        from: browser.relay.node,
        to: browser.node,
        actor: session.actor,
        session: session.id,
        auth: { mode: "anonymous_advisory" },
        body: ad
      } satisfies ShadowEnvelope<typeof ad>));
    }
  }).catch((err) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(encodeEnvelope(buildTransportErrorEnvelope({
      id: `dev-relay:error:${randomUUID()}`,
      from: browser.relay.node,
      to: node,
      actor: session.actor,
      session: session.id,
      auth: { mode: "session", token },
      code: "E_PROTOCOL",
      message: normalizeError(err).message ?? "v2 open failed"
    })));
  });

  ws.on("message", (raw) => {
    if (rawDataSize(raw) > 1024 * 1024) {
      ws.close(1009, "frame too large");
      return;
    }
    void handleV2ShadowFrame(ws, node, token, session, browser, String(raw));
  });
  ws.on("close", () => {
    world.detachSocket(session.id, socketId);
    sockets.delete(ws);
    // The browser worker reuses its node id across scope changes. A previous
    // scope socket can close after the replacement socket has registered, so
    // only remove the node mapping if this close still owns it.
    if (v2SocketsByNode.get(browser.node) === ws) v2SocketsByNode.delete(browser.node);
    disposeShadowBrowserNode(browser);
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

function ensureLocaldevWizardApiKey(): void {
  const id = process.env.WOO_LOCALDEV_WIZ_API_ID;
  const secret = process.env.WOO_LOCALDEV_WIZ_API_KEY;
  if (!id && !secret) return;
  if (!id || !secret) {
    throw wooError("E_INVARG", "set both WOO_LOCALDEV_WIZ_API_ID and WOO_LOCALDEV_WIZ_API_KEY, or neither");
  }
  const ensured = world.ensureApiKey("$wiz", "$wiz", id, secret, "localdev-wiz");
  const action = ensured.created ? "created" : "found";
  console.log("");
  console.log(`Localdev wizard API key ${action} (unsafe local convenience):`);
  console.log(`  Username: ${id}`);
  console.log(`  Password: ${secret}`);
  console.log("  Actor: $wiz");
  console.log("");
}

function v2ShadowBrowser(node: string, token: string, session: Session, scope: ObjRef): ReturnType<typeof createShadowBrowserClient> {
  const relay = v2RelayForScope(scope);
  return createShadowBrowserClient({
    node,
    scope,
    actor: session.actor,
    session: session.id,
    relay,
    token
  });
}

function v2RelayForScope(scope: ObjRef): ShadowBrowserRelayShim {
  let relay = v2RelaysByScope.get(scope);
  if (!relay) {
    relay = createShadowBrowserRelayShim({
      node: "node:dev:relay",
      scope,
      serialized: world.exportWorld(),
      deployment: "local-dev"
    });
    v2RelaysByScope.set(scope, relay);
    return relay;
  }
  // Dev mirrors the Worker/CommitScopeDO lifetime: one relay per commit scope,
  // many browser sockets. Refresh the same authority slice the Worker sends
  // to CommitScopeDO so local testing catches cross-scope drift.
  refreshDevV2RelaySessions(relay);
  return relay;
}

function refreshDevV2RelaySessions(relay: ShadowBrowserRelayShim, extraObjectIds: Iterable<ObjRef> = []): void {
  const { authority } = v2TurnGatewayAuthorityPayload(world, extraObjectIds);
  const auth = buildShadowBrowserSessionAuth({
    sessions: authority.sessions,
    scope: relay.commit_scope.scope,
    deployment: relay.deployment
  });
  relay.session_auth = auth.session_auth;
  relay.session_revs = auth.session_revs;
  for (const browser of relay.browsers.values()) {
    if (!browser.session || !browser.session_token) continue;
    const claims = relay.session_auth.get(shadowBrowserSessionBearer({ id: browser.session, actor: browser.actor }));
    if (claims) relay.session_auth.set(browser.session_token, claims);
  }
  const mergedSessions = mergeShadowBrowserAuthoritySessionState(relay.commit_scope.serialized.sessions, authority.sessions);
  if (stableShadowJson(mergedSessions as unknown as WooValue) !== stableShadowJson(relay.commit_scope.serialized.sessions as unknown as WooValue)) {
    relay.commit_scope.serialized.sessions = mergedSessions;
    markShadowBrowserRelaySerializedChanged(relay);
  }
  refreshDevV2SerializedObjects(relay, authority.objects);
}

function ensureDevV2SerializedSession(relay: ShadowBrowserRelayShim, session: Session): void {
  // Existing dev relays can outlive the local world snapshot they were opened
  // with. The accepted socket session must be present in the scope snapshot
  // before planning, or the turn fails before the recorder can produce a
  // useful transcript.
  //
  // Do not merely check for presence: a reused commit-scope relay can already
  // have a row for this session with stale detach/expiry/location metadata.
  // Dev receives the live gateway session as authority before planning.
  const serialized = {
    id: session.id,
    actor: session.actor,
    started: session.started,
    expiresAt: session.expiresAt,
    lastDetachAt: session.lastDetachAt ?? null,
    tokenClass: session.tokenClass,
    activeScope: session.activeScope,
    apikeyId: session.apikeyId
  };
  const index = relay.commit_scope.serialized.sessions.findIndex((item) => item.id === session.id);
  if (index < 0) {
    relay.commit_scope.serialized.sessions.push(serialized);
    refreshDevV2SerializedSessionActor(relay, session.actor);
    markShadowBrowserRelaySerializedChanged(relay);
    return;
  }
  const existing = relay.commit_scope.serialized.sessions[index];
  const next = serialized;
  if (stableShadowJson(next as unknown as WooValue) !== stableShadowJson(existing as unknown as WooValue)) {
    relay.commit_scope.serialized.sessions[index] = next;
    markShadowBrowserRelaySerializedChanged(relay);
  }
  refreshDevV2SerializedSessionActor(relay, session.actor);
}

function refreshDevV2SerializedSessionActor(relay: ShadowBrowserRelayShim, actor: ObjRef): void {
  const [record] = world.exportObjects([actor]);
  if (!record) return;
  refreshDevV2SerializedObjects(relay, [record]);
}

function refreshDevV2SerializedObjects(relay: ShadowBrowserRelayShim, objects: ReturnType<typeof world.exportObjects>): void {
  if (objects.length === 0) return;
  const byId = new Map(relay.commit_scope.serialized.objects.map((obj, index) => [obj.id, index] as const));
  let changed = false;
  for (const record of objects) {
    const index = byId.get(record.id);
    if (index === undefined) {
      byId.set(record.id, relay.commit_scope.serialized.objects.length);
      relay.commit_scope.serialized.objects.push(record);
      changed = true;
      continue;
    }
    relay.commit_scope.serialized.objects[index] = record;
    changed = true;
  }
  if (changed) markShadowBrowserRelaySerializedChanged(relay);
}

async function devRestV2Turn(input: Parameters<NonNullable<RestProtocolHost["executeTurn"]>>[0]): Promise<AppliedFrame | DirectResultFrame> {
  const token = shadowBrowserSessionBearer(input.session);
  const browser = v2ShadowBrowser(`node:dev:rest:${input.id ?? randomUUID()}`, token, input.session, input.scope);
  refreshDevV2RelaySessions(browser.relay, [input.scope, input.target, input.actor]);
  ensureDevV2SerializedSession(browser.relay, input.session);
  const encoded = encodeV2TurnGatewayIntentEnvelope({
    node: browser.node,
    turn: {
      id: input.id,
      route: input.route,
      scope: input.scope,
      session: input.session.id,
      actor: input.actor,
      target: input.target,
      verb: input.verb,
      args: input.args,
      body: input.body,
      persistence: input.persistence,
      token
    },
    turnId: input.id
  });
  const receipt = receiveShadowBrowserEnvelopeReceipt(browser, encoded);
  const reply = await handleShadowBrowserTurnExecEnvelope(browser, receipt);
  if (!reply) throw wooError("E_INTERNAL", "v2 REST turn produced no reply");
  if (reply.body.commit && reply.body.transcript) {
    world.applyCommittedShadowTranscript(reply.body.transcript);
  }
  sendDevV2Fanout(browser, reply);
  return restFrameFromTurnReply(input.scope, reply.body);
}

async function handleV2ShadowFrame(
  ws: WebSocket,
  node: string,
  token: string,
  session: Session,
  browser: ReturnType<typeof createShadowBrowserClient>,
  encoded: string
): Promise<void> {
  try {
    // Per-envelope relay routing: a single WS may carry calls for any scope
    // (e.g. the chat panel and a nested tool component can target different
    // spaces). The WS-bound browser is bound to one
    // relay at open time; without rerouting here, off-scope calls would be
    // submitted to the wrong commit scope and rejected as scope_mismatch.
    // The production worker handles this internally via per-DO routing;
    // for dev we resolve the target relay from the envelope body and run
    // the turn through a transient browser anchored to that relay.
    // Match REST/MCP's authority-slice contract: refresh the destination
    // relay's session_auth AND the explicit scope/target/actor object rows
    // before planning. Cross-scope WS turns previously skipped the row
    // refresh and could plan against stale destination-relay state
    // (subscribers, contents, verb/property versions on `target`). The
    // wire-token wipe described below is avoided by ordering refresh
    // BEFORE `createShadowBrowserClient`, not by skipping refresh.
    const routing = resolveTurnEnvelopeRouting(world, encoded);
    const callScope = routing?.scope ?? null;
    const callTarget = routing?.target ?? null;
    const crossScope = !!callScope && callScope !== browser.relay.commit_scope.scope;
    // Verbs commonly iterate `contents(this)` and call isa/prop reads on each
    // member (e.g. $outliner:list_items, $room:look_self). The relay's
    // serialized snapshot must therefore include those contained objects, not
    // just the target itself — otherwise isa throws E_OBJNF on items created
    // by earlier commits in the same session. The REST path's per-request
    // relay reuses a fully-refreshed shim so it hits this naturally; the WS
    // path's persistent relay misses it unless we ask explicitly.
    const baseTarget = crossScope ? callScope! : browser.relay.commit_scope.scope;
    const containerForContents = callTarget ?? baseTarget;
    const containerContents = world.objects.has(containerForContents)
      ? Array.from(world.object(containerForContents).contents)
      : [];
    const explicitRows = v2TurnGatewayAuthorityObjectIds({
      scope: callScope ?? browser.relay.commit_scope.scope,
      target: callTarget ?? undefined,
      actor: session.actor
    });
    const seenExplicitRows = new Set(explicitRows);
    for (const id of containerContents) {
      if (seenExplicitRows.has(id)) continue;
      seenExplicitRows.add(id);
      explicitRows.push(id);
    }
    const targetRelay = crossScope ? v2RelayForScope(callScope!) : browser.relay;
    // Refresh wipes session_auth and then re-registers wire tokens only
    // for browsers tracked in `relay.browsers`. The WS-bound `browser` is
    // subscribed there at WS open, so its wire token survives the
    // refresh; the cross-scope transient browser is not subscribed, so
    // its wire token has to be installed AFTER this refresh via
    // `setShadowBrowserSessionToken` inside `createShadowBrowserClient`.
    refreshDevV2RelaySessions(targetRelay, explicitRows);
    ensureDevV2SerializedSession(targetRelay, session);
    const turnBrowser = crossScope
      ? v2ShadowBrowser(browser.node, token, session, callScope!)
      : browser;
    const receipt = receiveShadowBrowserEnvelopeReceipt(turnBrowser, encoded);
    const reply = await handleShadowBrowserTurnExecEnvelope(turnBrowser, receipt);
    if (reply?.body.ok === true && reply.body.commit && reply.body.transcript) {
      world.applyCommittedShadowTranscript(reply.body.transcript);
    }
    if (reply) {
      ws.send(encodeEnvelope(reply));
      sendDevV2Fanout(turnBrowser, reply);
    }
  } catch (err) {
    // Pre-recording throws (the substrate's presence/permission gates fire
    // before withTurnRecording starts, so the recorder has no turn) escape
    // out of runShadowTurnCallOnWorld and land here. Sending a bare
    // woo.transport.error.v1 has no reply_to back-reference, so the worker
    // never delete-pendings the original intent and the SPA's
    // pendingNetworkTurns set never drains — the wait cursor spins forever.
    // Send back a proper turn.exec.reply with ok:false and reply_to set so
    // v2BrowserCacheMutationsForEnvelope can correlate and clear the
    // optimistic call.
    const normalized = normalizeError(err);
    const intent = decodeTurnIntentForRecovery(encoded);
    if (intent) {
      ws.send(encodeEnvelope(buildVerbThrewReplyEnvelope({
        intent,
        error: { code: normalized.code, message: normalized.message },
        relayNode: "node:dev:relay",
        to: node,
        actor: session.actor,
        session: session.id,
        auth: { mode: "session", token }
      })));
      return;
    }
    ws.send(encodeEnvelope(buildTransportErrorEnvelope({
      id: `dev-relay:error:${Date.now()}`,
      from: "node:dev:relay",
      to: node,
      actor: session.actor,
      session: session.id,
      auth: { mode: "session", token },
      code: "E_PROTOCOL",
      message: normalized.message ?? "v2 transport error"
    })));
  }
}

function sendDevV2Fanout(
  origin: ReturnType<typeof createShadowBrowserClient>,
  reply: NonNullable<Awaited<ReturnType<typeof handleShadowBrowserTurnExecEnvelope>>>
): void {
  const body = reply.body;
  if (body.ok !== true || !body.transcript) return;
  if (!body.commit) {
    sendDevV2LiveFanout(origin, reply);
    return;
  }
  for (const browser of origin.relay.browsers.values()) {
    if (browser.node === origin.node) continue;
    if (origin.relay.subscriptions.get(body.commit.position.scope)?.has(browser.node) !== true) continue;
    const socket = v2SocketsByNode.get(browser.node);
    if (!socket || socket.readyState !== WebSocket.OPEN) continue;
    const transfer = buildShadowBrowserDeltaTransfer(origin.relay, body.commit as ShadowCommitAccepted, body.transcript, browser.node, {
      actor: browser.actor,
      session: browser.session
    });
    socket.send(encodeEnvelope({
      v: 2,
      type: transfer.kind,
      id: `${origin.relay.node}:state:${body.commit.position.seq}:${browser.node}`,
      from: origin.relay.node,
      to: browser.node,
      actor: browser.actor,
      ...(browser.session ? { session: browser.session } : {}),
      auth: { mode: "session", token: browser.session_token ?? "" },
      body: transfer
    } satisfies ShadowEnvelope<typeof transfer>));
  }
}

function sendDevV2LiveFanout(
  origin: ReturnType<typeof createShadowBrowserClient>,
  reply: NonNullable<Awaited<ReturnType<typeof handleShadowBrowserTurnExecEnvelope>>>
): void {
  const body = reply.body;
  if (body.ok !== true || !body.transcript) return;
  for (const event of shadowLiveEventsForTranscript(origin, body.transcript)) {
    for (const browser of origin.relay.browsers.values()) {
      if (browser.node === origin.node) continue;
      if (!shadowLiveEventMatchesBrowser(origin.relay, browser, event)) continue;
      const socket = v2SocketsByNode.get(browser.node);
      if (!socket || socket.readyState !== WebSocket.OPEN) continue;
      socket.send(encodeEnvelope({
        v: 2,
        type: event.kind,
        id: `${event.id}:${browser.node}`,
        from: origin.relay.node,
        to: browser.node,
        actor: browser.actor,
        ...(browser.session ? { session: browser.session } : {}),
        auth: { mode: "session", token: browser.session_token ?? "" },
        body: event
      } satisfies ShadowEnvelope<typeof event>));
    }
  }
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
