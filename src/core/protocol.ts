import {
  wooError,
  type AppliedFrame,
  type CommandFrame,
  type DirectResultFrame,
  type ErrorFrame,
  type ErrorValue,
  type Message,
  type ObjRef,
  type Session,
  type SpaceLogEntry,
  type Observation,
  type WooValue
} from "./types";
import { localCatalogStatuses, localCatalogUiIndex } from "./local-catalogs";
import { normalizeError, type DirectCallOptions, type ParkedTaskRun, type WooWorld } from "./world";

const MAX_WS_FRAME_BYTES = 256 * 1024;

export type RestProtocolRequest = {
  method: string;
  pathname: string;
  query(name: string): string | null;
  header(name: string): string | null;
  readJson(): Promise<Record<string, unknown>>;
};

export type RestProtocolResult =
  | { handled: false }
  | { handled: true; status: number; body: unknown; headers?: Record<string, string> }
  | { handled: true; raw: true };

export type RestProtocolHost = {
  world: WooWorld;
  requireSession(request: RestProtocolRequest): Session;
  authenticateToken(token: string): Session | Promise<Session>;
  verifyTurnstile?(token: string, request: RestProtocolRequest): boolean | Promise<boolean>;
  onAuthenticated?(session: Session): void | Promise<void>;
  onSessionEnded?(session: Session): void | Promise<void>;
  onSessionsEnded?(sessions: Session[]): void | Promise<void>;
  installTap?(actor: ObjRef, body: Record<string, unknown>): Promise<AppliedFrame>;
  updateTap?(actor: ObjRef, body: Record<string, unknown>): Promise<AppliedFrame>;
  openStream?(request: RestProtocolRequest, rawTarget: string, target: ObjRef, session: Session): RestProtocolResult | Promise<RestProtocolResult>;
  resolveObject?(id: string, session: Session, request: RestProtocolRequest): ObjRef;
  resolveActor?(request: RestProtocolRequest, actorValue: unknown, session: Session): ObjRef;
  directCall?(
    id: string | undefined,
    actor: ObjRef,
    target: ObjRef,
    verb: string,
    args: WooValue[],
    options: DirectCallOptions
  ): Promise<DirectResultFrame | ErrorFrame>;
  executeTurn?(
    input: {
      id?: string;
      session: Session;
      actor: ObjRef;
      scope: ObjRef;
      target: ObjRef;
      verb: string;
      args: WooValue[];
      route: "direct" | "sequenced";
      persistence: "durable" | "live";
    }
  ): Promise<AppliedFrame | DirectResultFrame | ErrorFrame>;
  broadcastApplied(frame: AppliedFrame): void | Promise<void>;
  broadcastLiveEvents(result: DirectResultFrame): void | Promise<void>;
};

export async function handleRestProtocolRequest(request: RestProtocolRequest, host: RestProtocolHost): Promise<RestProtocolResult> {
  const world = host.world;
  try {
    if (request.method === "POST" && request.pathname === "/api/auth") {
      const body = await request.readJson();
      const token = String(body.token ?? "");
      if (!token.startsWith("guest:") && !token.startsWith("session:") && !token.startsWith("wizard:") && !token.startsWith("apikey:") && !token.startsWith("bearer:")) {
        throw wooError("E_INVARG", "REST accepts guest:, session:, wizard:, bearer:, and apikey: tokens");
      }
      const session = await host.authenticateToken(token);
      await host.onAuthenticated?.(session);
      return jsonProtocol({
        actor: session.actor,
        session: session.id,
        active_scope: session.activeScope,
        current_location: session.activeScope,
        expires_at: session.expiresAt,
        token_class: session.tokenClass,
        ...(session.apikeyId !== undefined ? { apikey_id: session.apikeyId } : {})
      });
    }

    if (request.method === "POST" && request.pathname === "/api/signup") {
      const body = await request.readJson();
      const turnstileToken = String(body.turnstile_token ?? "");
      if (!turnstileToken) throw wooError("E_PERM", "turnstile token is required");
      if (host.verifyTurnstile && !await host.verifyTurnstile(turnstileToken, request)) throw wooError("E_PERM", "turnstile verification failed");
      const result = await world.beginSignup(String(body.email ?? ""), String(body.password ?? ""), {
        inviteCode: typeof body.invite_code === "string" ? body.invite_code : null
      });
      return jsonProtocol(result, 201);
    }

    if (request.method === "POST" && request.pathname === "/api/signup/verify") {
      const session = optionalSession(host, request);
      const body = await request.readJson();
      const result = world.verifySignup(String(body.token ?? ""), session?.id ?? null);
      await host.onAuthenticated?.(result.session);
      return jsonProtocol(authProjection(result));
    }

    if (request.method === "POST" && request.pathname === "/api/auth/password") {
      const body = await request.readJson();
      const result = await world.authenticatePassword(String(body.email ?? ""), String(body.password ?? ""));
      await host.onAuthenticated?.(result.session);
      return jsonProtocol(authProjection(result));
    }

    if (request.method === "POST" && request.pathname === "/api/connect") {
      const session = host.requireSession(request);
      const body = await request.readJson();
      const result = world.connectHermes(session.actor, String(body.return ?? ""), String(body.state ?? ""), String(body.profile_id ?? ""), {
        force: body.force === true
      });
      return jsonProtocol(result);
    }

    if (request.method === "GET" && request.pathname === "/connect") {
      const session = optionalSession(host, request);
      if (!session) return jsonProtocol({ ok: false, login_required: true }, 302, { Location: `/signup?return=${encodeURIComponent(connectReturnPath(request))}` });
      const result = world.connectHermes(session.actor, request.query("return") ?? "", request.query("state") ?? "", request.query("profile_id") ?? "");
      return jsonProtocol(result, 302, { Location: result.redirect_url });
    }

    if (request.method === "GET" && request.pathname === "/api/me") {
      const session = host.requireSession(request);
      return jsonProtocol(await world.meSnapshot(session));
    }

    if (request.method === "DELETE" && request.pathname === "/api/session") {
      const session = host.requireSession(request);
      world.endSession(session.id);
      await host.onSessionEnded?.(session);
      return jsonProtocol({ ok: true, session: session.id });
    }

    if (request.method === "POST" && request.pathname === "/api/tap/install") {
      const session = host.requireSession(request);
      requireWizard(world, session.actor);
      const body = await request.readJson();
      if (!host.installTap) {
        return jsonProtocol({ error: { code: "E_NOT_IMPLEMENTED", message: "GitHub tap install is not available on this host" } }, 501);
      }
      const frame = await host.installTap(session.actor, body);
      await host.broadcastApplied(frame);
      return jsonProtocol(frame);
    }

    if (request.method === "POST" && request.pathname === "/api/tap/update") {
      const session = host.requireSession(request);
      requireWizard(world, session.actor);
      const body = await request.readJson();
      if (!host.updateTap) {
        return jsonProtocol({ error: { code: "E_NOT_IMPLEMENTED", message: "GitHub tap update is not available on this host" } }, 501);
      }
      const frame = await host.updateTap(session.actor, body);
      await host.broadcastApplied(frame);
      return jsonProtocol(frame);
    }

    if (request.method === "GET" && request.pathname === "/api/taps") {
      const session = host.requireSession(request);
      requireWizard(world, session.actor);
      return jsonProtocol({ catalogs: world.state(session.actor).catalogs.installed });
    }

    if (request.method === "GET" && request.pathname === "/api/catalogs") {
      const session = host.requireSession(request);
      return jsonProtocol({ ...world.state(session.actor).catalogs, local: localCatalogStatuses(world) });
    }

    if (request.method === "GET" && request.pathname === "/api/catalogs/ui") {
      host.requireSession(request);
      return catalogUiProtocol(request, world);
    }

    if (request.method === "GET" && request.pathname === "/api/object") {
      const session = host.requireSession(request);
      const target = resolveRestObject(host, request.query("id") ?? "", session, request);
      return jsonProtocol({
        description: world.describeForActor(target, session.actor),
        verbs: world.verbs(target).map((name) => world.verbInfo(target, String(name))),
        properties: world.properties(target).map((name) => world.propertyInfo(target, String(name)))
      });
    }

    const route = objectRoute(request.pathname);
    if (!route) return { handled: false };

    const session = host.requireSession(request);
    const target = resolveRestObject(host, route.id, session, request);

    if (request.method === "GET" && route.rest.length === 1 && route.rest[0] === "summary") {
      return jsonProtocol(await world.scopedObjectSummary(session.actor, target));
    }

    if (request.method === "GET" && route.rest.length === 1 && route.rest[0] === "ui-snapshot") {
      const surface = request.query("surface") ?? "default";
      return jsonProtocol(await world.overlaySnapshotForActor(session.actor, target, surface, session.id));
    }

    if (request.method === "GET" && route.rest.length === 0) {
      return jsonProtocol(world.describeForActor(target, session.actor));
    }

    if (request.method === "GET" && route.rest.length === 2 && route.rest[0] === "properties") {
      const name = route.rest[1];
      const value = world.getPropForActor(session.actor, target, name);
      const info = restPropertyInfo(world, target, name);
      const ownVersion = world.object(target).propertyVersions.get(name);
      return jsonProtocol({ ...info, value, version: ownVersion ?? info.version });
    }

    if (request.method === "POST" && route.rest.length === 2 && route.rest[0] === "calls") {
      // Authenticated input from a real client — count it for idle tracking.
      // Replay/state/property reads above don't reach this branch.
      world.touchSessionInput(session.id);
      const body = await request.readJson();
      const verb = route.rest[1];
      const args = Array.isArray(body.args) ? body.args as WooValue[] : [];
      const actor = resolveRestActor(host, request, body.actor, session);
      const id = typeof body.id === "string" ? body.id : undefined;

      if (verb === "call" && !Object.prototype.hasOwnProperty.call(body, "space") && isSpaceLike(world, target)) {
        const inner = Array.isArray(body.args) ? body.args[0] : null;
        if (!inner || typeof inner !== "object" || Array.isArray(inner)) throw wooError("E_INVARG", "$space:call expects args[0] to be a message map");
        const message = messageFromRestMap(host, request, inner as Record<string, WooValue>, actor, session);
        const result = await executeRestTurn(host, {
          id,
          session,
          actor: message.actor,
          scope: target,
          target: message.target,
          verb: message.verb,
          args: message.args ?? [],
          route: "sequenced",
          persistence: "durable"
        });
        if (result.op === "error") return errorProtocol(result.error);
        if (result.op === "applied") await host.broadcastApplied(result);
        return jsonProtocol(result);
      }

      if (Object.prototype.hasOwnProperty.call(body, "space") && body.space !== null) {
        const space = resolveRestObject(host, String(body.space), session, request);
        if (body.body && typeof body.body === "object" && !Array.isArray(body.body) && Object.keys(body.body as Record<string, unknown>).length > 0) {
          throw wooError("E_NOT_IMPLEMENTED", "REST v2 calls do not support message body maps");
        }
        const message: Message = {
          actor,
          target,
          verb,
          args,
          body: body.body && typeof body.body === "object" && !Array.isArray(body.body) ? body.body as Record<string, WooValue> : undefined
        };
        const result = await executeRestTurn(host, {
          id,
          session,
          actor: message.actor,
          scope: space,
          target: message.target,
          verb: message.verb,
          args: message.args ?? [],
          route: "sequenced",
          persistence: "durable"
        });
        if (result.op === "error") return errorProtocol(result.error);
        if (result.op === "applied") await host.broadcastApplied(result);
        return jsonProtocol(result);
      }

      const persistence = restDirectPersistence(world, target, verb);
      const result = await executeRestTurn(host, {
        id,
        session,
        actor,
        scope: target,
        target,
        verb,
        args,
        route: "direct",
        persistence
      });
      if (result.op === "error") return errorProtocol(result.error);
      if (result.op === "applied") {
        await host.broadcastApplied(result);
        return jsonProtocol(result);
      }
      await host.broadcastLiveEvents(result);
      return jsonProtocol({
          result: result.result,
          observations: result.observations,
          audience_actors: result.audienceActors,
          observation_audiences: result.observationAudiences,
          audience_sessions: result.audienceSessions,
          observation_session_audiences: result.observationSessionAudiences
        });
    }

    if (request.method === "GET" && route.rest.length === 1 && route.rest[0] === "log") {
      if (!isSpaceLike(world, target)) throw wooError("E_NOTAPPLICABLE", `${target} does not have a sequenced log`, target);
      if (!world.hasPresence(session.actor, target)) throw wooError("E_PERM", `${session.actor} is not present in ${target}`);
      const from = Math.max(1, Number(request.query("from") ?? 1));
      const limit = Math.min(Math.max(1, Number(request.query("limit") ?? 100)), 1000);
      const entries = world.replay(target, from, limit + 1);
      const messages = entries.slice(0, limit);
      const lastSeq = messages.length > 0 ? messages[messages.length - 1].seq : from - 1;
      return jsonProtocol({ messages, next_seq: lastSeq + 1, has_more: entries.length > limit });
    }

    if (request.method === "GET" && route.rest.length === 1 && route.rest[0] === "stream") {
      if (host.openStream) return host.openStream(request, route.id, target, session);
      return jsonProtocol({ error: { code: "E_NOT_IMPLEMENTED", message: "SSE streams are not available on this host" } }, 501);
    }
  } catch (err) {
    return errorProtocol(normalizeError(err));
  }

  return { handled: false };
}

async function executeRestTurn(
  host: RestProtocolHost,
  input: Parameters<NonNullable<RestProtocolHost["executeTurn"]>>[0]
): Promise<AppliedFrame | DirectResultFrame | ErrorFrame> {
  if (!host.executeTurn) throw wooError("E_NOT_IMPLEMENTED", "REST verb calls require a v2 turn executor");
  return await host.executeTurn(input);
}

function restDirectPersistence(world: WooWorld, target: ObjRef, verb: string): "durable" | "live" {
  if (["command_plan", "look", "examine", "read", "who", "say", "tell", "emote", "pose"].includes(verb)) return "live";
  try {
    const info = world.verbInfo(target, verb);
    const command = info.arg_spec && typeof info.arg_spec === "object" && !Array.isArray(info.arg_spec)
      ? (info.arg_spec as Record<string, WooValue>).command
      : undefined;
    if (command && typeof command === "object" && !Array.isArray(command)) {
      const persistence = (command as Record<string, WooValue>).persistence;
      if (persistence === "live" || persistence === "durable") return persistence;
    }
  } catch {
    // Permission and missing-verb errors are raised by the v2 executor below.
  }
  return "durable";
}

export function objectRoute(pathname: string): { id: string; rest: string[] } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "objects" || !parts[2]) return null;
  return {
    id: decodeURIComponent(parts[2]),
    rest: parts.slice(3).map((part) => decodeURIComponent(part))
  };
}

function optionalSession(host: RestProtocolHost, request: RestProtocolRequest): Session | null {
  try {
    return host.requireSession(request);
  } catch {
    return null;
  }
}

function connectReturnPath(request: RestProtocolRequest): string {
  const params = new URLSearchParams();
  for (const name of ["return", "state", "profile_id"]) {
    const value = request.query(name);
    if (value !== null) params.set(name, value);
  }
  const query = params.toString();
  return query ? `/connect?${query}` : "/connect";
}

function authProjection(result: { account: ObjRef; actor: ObjRef; bearer: string; session: Session; promoted_guest?: boolean }): Record<string, WooValue> {
  return {
    account: result.account,
    actor: result.actor,
    bearer: result.bearer,
    session: result.session.id,
    expires_at: result.session.expiresAt,
    token_class: result.session.tokenClass,
    ...(result.promoted_guest !== undefined ? { promoted_guest: result.promoted_guest } : {})
  };
}

export function isSpaceLike(world: WooWorld, obj: ObjRef): boolean {
  try {
    world.getProp(obj, "next_seq");
    return true;
  } catch {
    return false;
  }
}

export function restPropertyInfo(world: WooWorld, obj: ObjRef, name: string): Record<string, WooValue> {
  try {
    return world.propertyInfo(obj, name);
  } catch (err) {
    const error = normalizeError(err);
    const target = world.object(obj);
    if (error.code !== "E_PROPNF" || !target.properties.has(name)) throw err;
    return {
      name,
      owner: target.owner,
      perms: "r",
      defined_on: obj,
      type_hint: null,
      version: target.propertyVersions.get(name) ?? 1,
      has_value: true
    };
  }
}

export function appliedFromLogEntry(entry: SpaceLogEntry): AppliedFrame & { ts: number } {
  const observations: Observation[] = entry.observations?.length
    ? entry.observations
    : entry.applied_ok
      ? []
      : [{ type: "$error", code: entry.error?.code ?? "E_INTERNAL", message: entry.error?.message ?? entry.error?.code ?? "error", value: entry.error?.value ?? null }];
  return { op: "applied", space: entry.space, seq: entry.seq, message: entry.message, observations, ts: entry.ts };
}

export function statusForError(error: ErrorValue): number {
  switch (error.code) {
    case "E_INVARG":
      return 400;
    case "E_NOSESSION":
    case "E_TOKEN_CONSUMED":
      return 401;
    case "E_BOOTSTRAP_TOKEN_MISSING":
      return 503;
    case "E_PERM":
    case "E_DIRECT_DENIED":
      return 403;
    case "E_OBJNF":
    case "E_VERBNF":
    case "E_PROPNF":
    case "E_NOTAPPLICABLE":
    case "E_NOTFOUND":
      return 404;
    case "E_HOST_RECYCLED":
      return 410;
    case "E_CONFLICT":
      return 409;
    case "E_TRANSITION":
    case "E_TRANSITION_ROLE_UNSET":
    case "E_TRANSITION_REQUIRES":
      return 422;
    case "E_RATE":
      return 429;
    case "E_TIMEOUT":
      return 504;
    case "E_NOT_IMPLEMENTED":
    case "E_NOT_SUPPORTED":
      return 501;
    default:
      return 500;
  }
}

function jsonProtocol(body: unknown, status = 200, headers?: Record<string, string>): RestProtocolResult {
  return { handled: true, status, body, headers };
}

function catalogUiProtocol(request: RestProtocolRequest, world: WooWorld): RestProtocolResult {
  const body = localCatalogUiIndex(world);
  const payload = JSON.stringify(body);
  const etag = `"catalog-ui-${stableHash(payload)}"`;
  const headers = {
    "etag": etag,
    "cache-control": "max-age=60, must-revalidate"
  };
  if (request.header("if-none-match") === etag) return jsonProtocol(null, 304, headers);
  return jsonProtocol(body, 200, headers);
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function errorProtocol(error: ErrorValue): RestProtocolResult {
  return jsonProtocol({ error }, statusForError(error));
}

function requireWizard(world: WooWorld, actor: ObjRef): void {
  if (!world.object(actor).flags.wizard) throw wooError("E_PERM", "wizard authority required", actor);
}

function resolveRestObject(host: RestProtocolHost, id: string, session: Session, request: RestProtocolRequest): ObjRef {
  if (host.resolveObject) return host.resolveObject(id, session, request);
  if (id === "$me") return session.actor;
  host.world.object(id);
  return id;
}

function resolveRestActor(host: RestProtocolHost, request: RestProtocolRequest, actorValue: unknown, session: Session): ObjRef {
  if (host.resolveActor) return host.resolveActor(request, actorValue, session);
  const impersonated = request.header("x-woo-impersonate-actor");
  const requested = typeof impersonated === "string"
    ? impersonated
    : actorValue === undefined || actorValue === null || actorValue === "$me"
      ? session.actor
      : String(actorValue);
  if (requested === session.actor) return requested;
  if (host.world.object(session.actor).flags.wizard) {
    host.world.object(requested);
    host.world.recordWizardAction(session.actor, "impersonate", {
      actor: requested,
      via: typeof impersonated === "string" ? "REST X-Woo-Impersonate-Actor" : "REST actor field"
    });
    return requested;
  }
  throw wooError("E_PERM", "actor does not match session actor", { actor: requested, session_actor: session.actor });
}

function messageFromRestMap(host: RestProtocolHost, request: RestProtocolRequest, value: Record<string, WooValue>, actor: ObjRef, session: Session): Message {
  if (typeof value.target !== "string" || typeof value.verb !== "string") {
    throw wooError("E_INVARG", "message map requires string target and verb");
  }
  return {
    actor,
    target: resolveRestObject(host, value.target, session, request),
    verb: value.verb,
    args: Array.isArray(value.args) ? value.args : [],
    body: value.body && typeof value.body === "object" && !Array.isArray(value.body) ? value.body as Record<string, WooValue> : undefined
  };
}

export type WsProtocolSession = {
  sessionId: string;
  actor: ObjRef;
};

export type WsProtocolHost<Connection> = {
  defaultAuthToken?: string;
  authenticate(token: string, connection: Connection): Session | Promise<Session>;
  attach(connection: Connection, session: Session): void | Promise<void>;
  session(connection: Connection): WsProtocolSession | null;
  send(connection: Connection, frame: unknown): void;
  call(frameId: string | undefined, session: WsProtocolSession, space: ObjRef, message: Message): AppliedFrame | ErrorFrame | Promise<AppliedFrame | ErrorFrame>;
  command?(
    frameId: string | undefined,
    session: WsProtocolSession,
    space: ObjRef,
    text: string
  ): CommandFrame | Promise<CommandFrame>;
  direct(
    frameId: string | undefined,
    session: WsProtocolSession,
    target: ObjRef,
    verb: string,
    args: WooValue[]
  ): DirectResultFrame | ErrorFrame | Promise<DirectResultFrame | ErrorFrame>;
  replay(frameId: string | undefined, session: WsProtocolSession, space: ObjRef, from: unknown, limit: unknown): unknown | Promise<unknown>;
  deliverInput(session: WsProtocolSession, input: WooValue): ParkedTaskRun | null | Promise<ParkedTaskRun | null>;
  broadcastApplied(frame: AppliedFrame, originator?: Connection): void | Promise<void>;
  broadcastTaskResult(result: ParkedTaskRun): void | Promise<void>;
  broadcastLiveEvents(result: DirectResultFrame, originator?: Connection): void | Promise<void>;
};

export async function handleWsProtocolFrame<Connection>(
  connection: Connection,
  frame: Record<string, unknown>,
  host: WsProtocolHost<Connection>
): Promise<void> {
  try {
    const op = String(frame.op ?? "");

    if (op === "auth") {
      const session = await host.authenticate(String(frame.token ?? host.defaultAuthToken ?? ""), connection);
      await host.attach(connection, session);
      host.send(connection, { op: "session", actor: session.actor, session: session.id, resumed: false });
      return;
    }

    if (op === "ping") {
      host.send(connection, { op: "pong", server_time: Date.now() });
      return;
    }

    const session = host.session(connection);
    if (!session) {
      host.send(connection, { op: "error", id: frame.id, error: wooError("E_NOSESSION", "auth required before this op") });
      return;
    }

    if (op === "call") {
      const m = frame.message && typeof frame.message === "object" && !Array.isArray(frame.message)
        ? frame.message as Record<string, unknown>
        : {};
      const message: Message = {
        actor: session.actor,
        target: String(m.target ?? "") as ObjRef,
        verb: String(m.verb ?? ""),
        args: Array.isArray(m.args) ? m.args as WooValue[] : [],
        body: m.body && typeof m.body === "object" && !Array.isArray(m.body)
          ? m.body as Record<string, WooValue>
          : undefined
      };
      const result = await host.call(frameId(frame.id), session, String(frame.space ?? "") as ObjRef, message);
      if (result.op === "applied") await host.broadcastApplied(result, connection);
      else host.send(connection, result);
      return;
    }

    if (op === "command") {
      if (!host.command) {
        host.send(connection, { op: "error", id: frame.id, error: wooError("E_NOTSUPPORTED", "command op is not supported by this host") });
        return;
      }
      const result = await host.command(frameId(frame.id), session, String(frame.space ?? "") as ObjRef, String(frame.text ?? ""));
      if (result.op === "applied") await host.broadcastApplied(result, connection);
      else if (result.op === "result") {
        const command = (result as DirectResultFrame & { command?: WooValue }).command;
        host.send(connection, command === undefined
          ? { op: "result", id: result.id, result: result.result, observations: result.observations }
          : { op: "result", id: result.id, result: result.result, command, observations: result.observations });
        await host.broadcastLiveEvents(result, connection);
      } else {
        host.send(connection, result);
      }
      return;
    }

    if (op === "direct") {
      const result = await host.direct(
        frameId(frame.id),
        session,
        String(frame.target ?? "") as ObjRef,
        String(frame.verb ?? ""),
        Array.isArray(frame.args) ? frame.args as WooValue[] : []
      );
      if (result.op === "result") {
        host.send(connection, { op: "result", id: result.id, result: result.result, observations: result.observations });
        await host.broadcastLiveEvents(result, connection);
      } else {
        host.send(connection, result);
      }
      return;
    }

    if (op === "input") {
      const input = Object.prototype.hasOwnProperty.call(frame, "value") ? frame.value : frame.text ?? "";
      const result = await host.deliverInput(session, input as WooValue);
      if (!result) {
        host.send(connection, { op: "input", id: frame.id, accepted: false });
        return;
      }
      if (result.frame?.op === "applied") await host.broadcastApplied(result.frame, connection);
      else {
        host.send(connection, { op: "input", id: frame.id, accepted: true, task: result.task.id, observations: result.observations });
        await host.broadcastTaskResult(result);
      }
      return;
    }

    if (op === "replay") {
      host.send(connection, await host.replay(frameId(frame.id), session, String(frame.space ?? "") as ObjRef, frame.from, frame.limit));
      return;
    }

    host.send(connection, { op: "error", error: { code: "E_INVARG", message: `unknown op ${op}` } });
  } catch (err) {
    host.send(connection, { op: "error", error: normalizeError(err) });
  }
}

export function parseWsProtocolFrame(raw: string | ArrayBuffer | ArrayBufferView): Record<string, unknown> | ErrorFrame {
  try {
    if (rawFrameBytes(raw) > MAX_WS_FRAME_BYTES) {
      return { op: "error", error: wooError("E_RATE", `websocket frame exceeds ${MAX_WS_FRAME_BYTES} bytes`) };
    }
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return { op: "error", error: wooError("E_INVARG", "invalid JSON frame") };
  } catch {
    return { op: "error", error: wooError("E_INVARG", "invalid JSON frame") };
  }
}

function rawFrameBytes(raw: string | ArrayBuffer | ArrayBufferView): number {
  if (typeof raw === "string") return new TextEncoder().encode(raw).byteLength;
  return raw.byteLength;
}

function frameId(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
