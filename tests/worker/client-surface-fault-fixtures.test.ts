// A1 fault-fixture suite (spec/protocol/client-surface.md CS3.3) — the
// wire-compatibility baseline for the client-surface extraction.
//
// CS3.3 says the extraction of the three client dialects out of
// `src/worker/net/gateway-do.ts` into surface operations (CS2) plus pure
// renderers (CS3.2) must be WIRE-PRESERVING: for every fault reachable
// today, the rendered body under the new renderers is byte-identical to
// the current dialect behavior. This suite is the definition of
// "preserved": it drives representative faults through each dialect and
// pins the EXACT wire response — status code + full JSON body for REST,
// the full JSON-RPC envelope for MCP, and the frame payload for WS —
// as inline literals, asserted with toEqual/toBe. When phases A1–A3
// convert the catch-sites, these fixtures must keep passing unchanged.
//
// Deliberately NOT vitest snapshot files: the literals ARE the
// documentation of the wire contract, and they must survive refactors
// legibly in review diffs.
//
// Fixture inventory (dialect × condition × code):
//
// | # | Dialect | Condition                                        | Status | Code            |
// |---|---------|--------------------------------------------------|--------|-----------------|
// | 1 | REST    | missing credential                               | 401    | E_NOSESSION     |
// | 2 | REST    | unsupported bearer token class                   | 401    | E_NOSESSION     |
// | 3 | REST    | unknown apikey id                                | 401    | E_NOSESSION     |
// | 4 | REST    | apikey secret rejected                           | 401    | E_NOSESSION     |
// | 5 | REST    | unknown session bearer credential                | 401    | E_NOSESSION     |
// | 6 | REST    | session-less turn (CO14)                         | 401    | E_NOSESSION     |
// | 7 | REST    | unknown session named on turn                    | 401    | E_NOSESSION     |
// | 8 | REST    | expired session named on turn                    | 401    | E_NOSESSION     |
// | 9 | REST    | malformed turn body (missing verb)               | 400    | E_INVARG        |
// | 10| REST    | malformed turn body (invalid target id)          | 400    | E_INVARG        |
// | 11| REST    | refused turn (direct call not allowed)           | 403    | E_DIRECT_DENIED |
// | 12| REST    | cell read outside the caller's presence          | 403    | E_PERM          |
// | 13| REST    | relation read outside the caller's presence      | 403    | E_PERM          |
// | 14| REST    | unknown route                                    | 404    | E_OBJNF         |
// | 15| REST    | standard rate bucket exhausted                   | 429    | E_RATE          |
// | 16| REST    | amplifier (mint) rate bucket exhausted           | 429    | E_RATE          |
// | 17| MCP     | initialize with rejected apikey secret           | 401    | E_NOSESSION     |
// | 18| MCP     | initialize with unknown apikey id                | 401    | E_NOSESSION     |
// | 19| MCP     | tools/call with unknown session                  | 401    | E_NOSESSION     |
// | 20| MCP     | tools/call `arguments` not an object             | 200    | E_INVARG (tool) |
// | 21| MCP     | woo_call control-schema violation (args)         | 200    | E_INVARG (tool) |
// | 22| MCP     | refused call: unknown verb on a present object   | 200    | E_VERBNF (tool) |
// |22b| MCP     | executed turn failed (verb raised; trace + obs)  | 200    | E_INVARG (tool) |
// | 23| MCP     | rate refusal on the notification path (no id)    | 429    | E_RATE          |
// | 24| MCP     | rate refusal on tools/call (id kept)             | 429    | E_RATE          |
// | 25| MCP     | unparseable JSON-RPC body                        | 400    | -32700          |
// | 26| WS      | upgrade without a ticket                         | 401    | E_NOSESSION     |
// | 27| WS      | upgrade with an invalid/forged ticket            | 401    | E_NOSESSION     |
// | 28| WS      | non-JSON frame                                   | frame  | E_INVARG        |
// | 29| WS      | frame on a socket with no session attachment     | frame  | E_NOSESSION     |
// | 30| WS      | unknown frame type                               | frame  | E_INVARG        |
// | 31| WS      | rate refusal frame (DELIBERATELY divergent shape)| frame  | E_RATE          |
// | 32| WS      | turn frame after session expiry                  | frame  | E_NOSESSION     |
// | 33| WS      | turn_result error frame for a refused turn       | frame  | E_DIRECT_DENIED |
//
// Normalizations (each explained where applied):
//  - none of the pinned bodies carry timestamps or random ids; the only
//    interpolated value is the fixture's own actor id (deterministic per
//    world build, but derived by the world rather than written here).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeWebSocket, FakeWebSocketPair } from "./fake-do";
import { closeQuiescent, quiescentNetState as netState, type QuiescentHost } from "./quiescent-do";
import { NetGatewayDO, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { installVerb } from "../../src/core/authoring";
import { createWorld } from "../../src/core/bootstrap";
import { cellsFromSerialized } from "../../src/net/bridge";
import { netActivationCell, partitionInstallRelations } from "../../src/net/install";
import { CATALOG_SCOPE, partitionCells } from "../../src/net/topology";
import { signInternalRequest } from "../../src/worker/internal-auth";

const SECRET = "client-surface-fixture-secret";
const EPOCH = "cat-client-surface-1";
const KEY_ID = "surface-key";
const KEY_SECRET = "surface-secret";

/** 101-tolerant Response for the WS upgrade path (Node's undici Response
 * rejects informational statuses). Same shim as net-ws.test.ts. */
class UpgradeTolerantResponse {
  readonly bodyText: string | null;
  readonly status: number;
  readonly headers: Headers;
  readonly webSocket?: WebSocket;

  constructor(body: BodyInit | null = null, init: (ResponseInit & { webSocket?: WebSocket }) = {}) {
    this.bodyText = typeof body === "string" ? body : body == null ? null : String(body);
    this.status = init.status ?? 200;
    this.headers = new Headers(init.headers as HeadersInit | undefined);
    this.webSocket = init.webSocket;
  }

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  async text(): Promise<string> {
    return this.bodyText ?? "";
  }

  async json(): Promise<unknown> {
    return JSON.parse(this.bodyText ?? "null");
  }
}

beforeAll(() => {
  vi.stubGlobal("WebSocketPair", FakeWebSocketPair);
  vi.stubGlobal("Response", UpgradeTolerantResponse);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

/** Unsigned client request straight at the gateway DO — the /net-api
 * surface never requires internal signing. */
async function clientFetch(
  gateway: NetGatewayDO,
  method: string,
  path: string,
  opts: { token?: string; headers?: Record<string, string>; body?: unknown } = {}
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const headers = new Headers(opts.headers ?? {});
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  const request =
    method === "GET"
      ? new Request(`https://do${path}`, { headers })
      : new Request(`https://do${path}`, {
          method,
          headers: (headers.set("content-type", "application/json"), headers),
          body: JSON.stringify(opts.body ?? {})
        });
  const response = (await gateway.fetch(request)) as Response & { webSocket?: WebSocket };
  const body = response.status === 101 ? {} : ((await response.json()) as Record<string, unknown>);
  return { status: response.status, body, headers: response.headers };
}

/** Parse the frames a fake server socket sent. */
function frames(server: FakeWebSocket): Array<Record<string, unknown>> {
  return server.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

type Harness = Awaited<ReturnType<typeof buildHarness>>;

/**
 * Engine-real fixture (the net-client-api/net-ws idiom): one room with a
 * verb-bearing box, a second room whose box is OUTSIDE the caller's
 * presence (for the read-authorization refusals), the actor placed in
 * the first room, and apikeys carried in $system.api_keys. The gateway
 * shard starts with an empty view — every warm-up is pull-on-miss, the
 * same path production faults travel.
 */
async function buildHarness() {
  const world = createWorld();
  const session = world.auth("guest:client-surface");
  const actor = session.actor;
  world.createObject({ id: "fx_room", name: "Fixture Room", parent: "$space", owner: actor });
  world.createObject({ id: "fx_box", name: "Fixture Box", parent: "$thing", owner: actor, anchor: "fx_room", location: "fx_room" });
  world.defineProperty("fx_box", { name: "counter", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
  expect(installVerb(
    world,
    "fx_box",
    "bump",
    `verb :bump() rxd {
      this.counter = this.counter + 1;
      observe({ type: "bumped", counter: this.counter });
      return this.counter;
    }`,
    null
  ).ok).toBe(true);
  // Not direct_callable: an explicit route:"direct" request against it is
  // the deterministic "refused turn" driver (E_DIRECT_DENIED) that never
  // commits anything.
  expect(installVerb(
    world,
    "fx_box",
    "locked_probe",
    "verb :locked_probe() rx { return 1; }",
    null
  ).ok).toBe(true);
  // A verb that fails INSIDE the committed turn (an explicit raise), for
  // the failure-of-an-executed-turn rendering — the deepest fault path the
  // dialects share (plan→submit chain, then per-dialect rendering of the
  // recorded failure).
  expect(installVerb(
    world,
    "fx_box",
    "explode",
    'verb :explode() rxd { raise { code: "E_INVARG", message: "the box refuses" }; }',
    null
  ).ok).toBe(true);
  // A second room + box the caller is NOT co-present with, for the
  // presence-scoped read refusals.
  world.createObject({ id: "fx_annex", name: "Fixture Annex", parent: "$space", owner: actor });
  world.createObject({ id: "fx_annex_box", name: "Annex Box", parent: "$thing", owner: actor, anchor: "fx_annex", location: "fx_annex" });
  const placed = await world.directCall("fixture-genesis-place", actor, actor, "moveto", ["fx_room"], { sessionId: session.id });
  expect(placed.op).toBe("result");
  world.ensureApiKey("$wiz", actor, KEY_ID, KEY_SECRET, "client-surface-fixture");
  // A second authenticated identity, so cross-actor conditions stay available.
  const other = world.auth("guest:client-surface-2").actor;
  world.ensureApiKey("$wiz", other, "surface-key-2", "surface-secret-2", "client-surface-fixture-2");

  const installCells = cellsFromSerialized(world.exportWorld());
  const partitions = partitionCells(installCells);
  // Relations (contents rosters etc.) make fx_box structurally reachable
  // from the session — needed so the MCP refused-call fixture reaches verb
  // RESOLUTION rather than stopping at the reachability gate.
  const relations = partitionInstallRelations(installCells);
  // Activation barrier: the fixture installs a pre-verified world, so it
  // self-activates with the catalog partition.
  partitions.set(CATALOG_SCOPE, [...(partitions.get(CATALOG_SCOPE) ?? []), netActivationCell(EPOCH)]);

  const states: QuiescentHost[] = [];
  const scopeDOs = new Map<string, NetScopeDO>();
  let gateway: NetGatewayDO;
  const resolve = (destination: string) => {
    if (destination === "gateway:net-api") return gateway;
    if (destination.startsWith("scope:")) {
      const instance = scopeDOs.get(destination.slice("scope:".length));
      if (instance) return instance;
    }
    throw new Error(`unresolvable destination ${destination}`);
  };
  const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve };
  for (const scope of ["room:fx_room", "room:fx_annex", `cluster:${actor}`, `cluster:${other}`, CATALOG_SCOPE]) {
    const st = netState(`scope-${scope}`);
    const instance = new NetScopeDO(st.state, scopeEnv);
    const seeded = await instance.fetch(await signInternalRequest(scopeEnv, new Request("https://do/net/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, catalog_epoch: EPOCH, cells: partitions.get(scope) ?? [], relations: relations.get(scope) ?? [] })
    })));
    expect(seeded.ok, `seed ${scope}`).toBe(true);
    states.push(st);
    scopeDOs.set(scope, instance);
  }

  const gatewayState = netState("gateway-net-api");
  // Graft the hibernation WebSocket surface onto the shared quiescent
  // fixture (which deliberately does not model it) — the net-ws idiom.
  Object.assign(gatewayState.state, {
    acceptWebSocket: (ws: WebSocket, tags?: string[]) => gatewayState.fake.acceptWebSocket(ws, tags),
    getWebSockets: (tag?: string) => gatewayState.fake.getWebSockets(tag)
  });
  states.push(gatewayState);
  gateway = new NetGatewayDO(gatewayState.state, {
    WOO_INTERNAL_SECRET: SECRET,
    NET_RESOLVE: resolve,
    NET_GATEWAY_SELF: "gateway:net-api"
  } as NetGatewayEnv);

  const token = `apikey:${KEY_ID}:${KEY_SECRET}`;
  const mint = async (): Promise<string> => {
    const minted = await clientFetch(gateway, "POST", "/net-api/session", { token, body: { ttl_ms: 600_000 } });
    expect(minted.status, JSON.stringify(minted.body)).toBe(200);
    return minted.body.session as string;
  };
  const mcp = async (
    body: Record<string, unknown> | string,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; body: Record<string, unknown> | null; headers: Headers }> => {
    const response = await gateway.fetch(new Request("https://do/net-api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body)
    }));
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null, headers: response.headers };
  };
  const mcpOpen = async (): Promise<string> => {
    const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { "mcp-token": token });
    expect(init.status, JSON.stringify(init.body)).toBe(200);
    const session = init.headers.get("mcp-session-id") as string;
    expect(session).toBeTruthy();
    return session;
  };
  /** Mint a WS ticket and upgrade; returns the accepted server socket. */
  const wsOpen = async (session: string): Promise<FakeWebSocket> => {
    const minted = await clientFetch(gateway, "POST", "/net-api/ws-ticket", { token, body: { session } });
    expect(minted.status, JSON.stringify(minted.body)).toBe(200);
    const before = new Set(gatewayState.fake.getWebSockets());
    const upgraded = await clientFetch(gateway, "GET", `/net-api/ws?ticket=${minted.body.ticket as string}`, {
      headers: { upgrade: "websocket" }
    });
    expect(upgraded.status).toBe(101);
    const server = gatewayState.fake.getWebSockets().find((ws) => !before.has(ws));
    expect(server).toBeTruthy();
    return server as unknown as FakeWebSocket;
  };

  return {
    gateway,
    token,
    actor,
    other,
    mint,
    mcp,
    mcpOpen,
    wsOpen,
    close: async () => closeQuiescent(states)
  };
}

// ---------------------------------------------------------------------------
// REST — /net-api/*, rendered by clientApi's catch (gateway-do.ts ~3677)
// ---------------------------------------------------------------------------

describe("REST dialect fault rendering (CS3.3 baseline)", () => {
  it("pins the credential refusals (fixtures 1-5)", async () => {
    const h = await buildHarness();
    try {
      // 1: no credential at all.
      const missing = await clientFetch(h.gateway, "GET", "/net-api/cell?key=object_live:fx_box");
      expect(missing.status).toBe(401);
      expect(missing.body).toEqual({
        error: {
          code: "E_NOSESSION",
          message: "missing credential: send `authorization: Bearer apikey:<id>:<secret>` (or `Bearer session:<id>`, or `x-woo-api-key`)",
          detail: { reason: "missing_credential" }
        }
      });

      // 2: a bearer token of an unsupported class.
      const wrongClass = await clientFetch(h.gateway, "GET", "/net-api/cell?key=object_live:fx_box", {
        token: "some-opaque-token"
      });
      expect(wrongClass.status).toBe(401);
      expect(wrongClass.body).toEqual({
        error: {
          code: "E_NOSESSION",
          message: "bearer credential must be apikey:<id>:<secret> or session:<id>",
          detail: { reason: "unsupported_token_class" }
        }
      });

      // 3: an unknown apikey id (unknown and revoked share one message,
      // deliberately, as core auth does).
      const unknown = await clientFetch(h.gateway, "POST", "/net-api/session", {
        token: "apikey:no-such-key:whatever",
        body: {}
      });
      expect(unknown.status).toBe(401);
      expect(unknown.body).toEqual({
        error: {
          code: "E_NOSESSION",
          message: "apikey not found or revoked",
          detail: { reason: "unknown_or_revoked" }
        }
      });

      // 4: a known key presented with the wrong secret.
      const badSecret = await clientFetch(h.gateway, "POST", "/net-api/session", {
        token: `apikey:${KEY_ID}:wrong-secret`,
        body: {}
      });
      expect(badSecret.status).toBe(401);
      expect(badSecret.body).toEqual({
        error: {
          code: "E_NOSESSION",
          message: "apikey secret rejected",
          detail: { reason: "secret_rejected" }
        }
      });

      // 5: a session bearer naming a session this gateway has never minted.
      const forgedBearer = await clientFetch(h.gateway, "GET", "/net-api/cell?key=object_live:fx_box", {
        token: "session:s_forged"
      });
      expect(forgedBearer.status).toBe(401);
      expect(forgedBearer.body).toEqual({
        error: {
          code: "E_NOSESSION",
          message: "session missing",
          detail: { session_verdict: "missing", reason: "session_bearer_rejected" }
        }
      });
    } finally {
      await h.close();
    }
  });

  it("pins the session verdicts on the turn route (fixtures 6-8)", async () => {
    const h = await buildHarness();
    const clock = { t: Date.now() };
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock.t);
    try {
      // 6: CO14 — a turn without any session is refused up front, named.
      const sessionless = await clientFetch(h.gateway, "POST", "/net-api/turn", {
        token: h.token,
        body: { target: "fx_box", verb: "bump" }
      });
      expect(sessionless.status).toBe(401);
      expect(sessionless.body).toEqual({
        error: {
          code: "E_NOSESSION",
          message: "client-originated turns require a session (CO14): POST /net-api/session first",
          detail: { session_verdict: "session_required" }
        }
      });

      // 7: a session id the gateway does not know.
      const unknownSession = await clientFetch(h.gateway, "POST", "/net-api/turn", {
        token: h.token,
        body: { target: "fx_box", verb: "bump", session: "s_never_minted" }
      });
      expect(unknownSession.status).toBe(401);
      expect(unknownSession.body).toEqual({
        error: {
          code: "E_NOSESSION",
          message: "session missing",
          detail: { session_verdict: "missing" }
        }
      });

      // 8: a REAL minted session, aged past its ttl by advancing the pinned
      // clock (Date.now is the gateway host's clock). Normalization note:
      // pinning the clock is what makes the expiry deterministic; the body
      // itself carries no timestamp.
      const sid = await h.mint();
      clock.t += 700_000; // ttl was 600s
      const expired = await clientFetch(h.gateway, "POST", "/net-api/turn", {
        token: h.token,
        body: { target: "fx_box", verb: "bump", session: sid }
      });
      expect(expired.status).toBe(401);
      expect(expired.body).toEqual({
        error: {
          code: "E_NOSESSION",
          message: "session expired",
          detail: { session_verdict: "expired" }
        }
      });
    } finally {
      nowSpy.mockRestore();
      await h.close();
    }
  });

  it("pins malformed turn bodies and the refused direct turn (fixtures 9-11)", async () => {
    const h = await buildHarness();
    try {
      const sid = await h.mint();

      // 9: missing verb.
      const missingVerb = await clientFetch(h.gateway, "POST", "/net-api/turn", {
        token: h.token,
        body: { target: "fx_box", session: sid }
      });
      expect(missingVerb.status).toBe(400);
      expect(missingVerb.body).toEqual({
        error: { code: "E_INVARG", message: "turn body requires target and verb" }
      });

      // 10: a catalog-qualified (colon-bearing) target is installer syntax,
      // never a runtime object id.
      const badTarget = await clientFetch(h.gateway, "POST", "/net-api/turn", {
        token: h.token,
        body: { target: "tasks:the_taskboard", verb: "bump", session: sid }
      });
      expect(badTarget.status).toBe(400);
      expect(badTarget.body).toEqual({
        error: {
          code: "E_INVARG",
          message: "turn target is not a valid runtime object id",
          detail: { field: "target", reason: "invalid_object_id" }
        }
      });

      // 11: a refused turn — an explicit direct request against a verb that
      // is not direct_callable. Deterministic, and commits nothing.
      const denied = await clientFetch(h.gateway, "POST", "/net-api/turn", {
        token: h.token,
        body: { target: "fx_box", verb: "locked_probe", route: "direct", session: sid }
      });
      expect(denied.status).toBe(403);
      expect(denied.body).toEqual({
        error: {
          code: "E_DIRECT_DENIED",
          message: "verb locked_probe is not externally direct-callable",
          detail: { target: "fx_box", verb: "locked_probe" }
        }
      });
    } finally {
      await h.close();
    }
  });

  it("pins the presence-scoped read refusals and the unknown route (fixtures 12-14)", async () => {
    const h = await buildHarness();
    try {
      const sid = await h.mint();

      // 12: a cell belonging to an object in a room the caller is not in.
      const foreignCell = await clientFetch(
        h.gateway,
        "GET",
        `/net-api/cell?session=${encodeURIComponent(sid)}&key=property_cell:fx_annex_box:counter`,
        { token: h.token }
      );
      expect(foreignCell.status).toBe(403);
      expect(foreignCell.body).toEqual({
        error: {
          code: "E_PERM",
          message: "cell not readable in the caller's presence",
          detail: { key: "property_cell:fx_annex_box:counter" }
        }
      });

      // 13: a relation owned by a room the caller is not in.
      const foreignRelation = await clientFetch(
        h.gateway,
        "GET",
        `/net-api/relation?session=${encodeURIComponent(sid)}&relation=contents&owner=fx_annex`,
        { token: h.token }
      );
      expect(foreignRelation.status).toBe(403);
      expect(foreignRelation.body).toEqual({
        error: {
          code: "E_PERM",
          message: "relation not readable in the caller's presence",
          detail: { owner: "fx_annex" }
        }
      });

      // 14: the route fall-through.
      const noRoute = await clientFetch(h.gateway, "GET", "/net-api/nope", { token: h.token });
      expect(noRoute.status).toBe(404);
      expect(noRoute.body).toEqual({
        error: { code: "E_OBJNF", message: "no such route: GET /net-api/nope" }
      });
    } finally {
      await h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Rate refusals — one pinned-clock harness drives all three dialects off the
// SAME exhausted per-actor bucket, pinning each dialect's rendering of the
// SAME condition (fixtures 15-16, 23-24, 31).
// ---------------------------------------------------------------------------

describe("rate-refusal rendering across the three dialects (CS3.3 baseline)", () => {
  it("pins the standard-bucket 429 for REST, MCP (notification + tools/call) and the divergent WS frame", async () => {
    const h = await buildHarness();
    // Pin the clock the token buckets read (WorkerdHost.now = Date.now) so
    // exhaustion is exact — under CPU contention a sequential loop would
    // otherwise let the 50/s refill grant extra tokens. Normalization note:
    // the pinned clock is setup determinism; the pinned bodies carry no
    // clock-derived fields.
    const clock = { t: Date.now() };
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock.t);
    try {
      const sid = await h.mint();
      const mcpSession = await h.mcpOpen();
      const server = await h.wsOpen(sid);

      // Exhaust the actor's standard bucket with cheap reads (each consumes
      // exactly one post-auth token; their 401 session_required responses are
      // irrelevant to the budget).
      let throttled: { status: number; body: Record<string, unknown> } | null = null;
      for (let i = 0; i < 250 && throttled === null; i += 1) {
        const res = await clientFetch(h.gateway, "GET", "/net-api/cell?key=object_live:fx_box", { token: h.token });
        if (res.status === 429) throttled = res;
      }
      expect(throttled, "standard bucket never refused in 250 reads").not.toBeNull();

      // 15: the REST rendering.
      expect(throttled!.body).toEqual({
        error: {
          code: "E_RATE",
          message: "rate limit exceeded; retry after backoff",
          detail: {
            reason: "rate_limited",
            limit: { rate_per_sec: 50, burst: 100 }
          }
        }
      });

      // 31: the WS turn-frame rendering. DELIBERATELY divergent (documented
      // at gateway-do.ts webSocketMessage): a turn_result with status 429 and
      // NO detail object, so the client's in-flight turn settles by id
      // instead of being stranded by an uncorrelated error frame.
      await h.gateway.webSocketMessage(
        server as unknown as WebSocket,
        JSON.stringify({ type: "turn", id: "rate-1", target: "fx_box", verb: "bump" })
      );
      expect(frames(server).at(-1)).toEqual({
        type: "turn_result",
        id: "rate-1",
        status: 429,
        error: { code: "E_RATE", message: "rate limit exceeded; retry after backoff" }
      });

      // 23: the MCP notification path — refused with a 429 JSON-RPC error
      // carrying NO id (a notification has none by construction), never 202.
      const notification = await h.mcp(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { "mcp-session-id": mcpSession }
      );
      expect(notification.status).toBe(429);
      expect(notification.body).toEqual({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "rate limit exceeded; retry after backoff",
          data: {
            code: "E_RATE",
            detail: {
              reason: "rate_limited",
              limit: { rate_per_sec: 50, burst: 100 }
            },
            http_status: 429
          }
        }
      });

      // 24: the MCP request path keeps the id.
      const toolCall = await h.mcp(
        { jsonrpc: "2.0", id: 77, method: "tools/call", params: { name: "woo_wait", arguments: {} } },
        { "mcp-session-id": mcpSession }
      );
      expect(toolCall.status).toBe(429);
      expect(toolCall.body).toEqual({
        jsonrpc: "2.0",
        id: 77,
        error: {
          code: -32000,
          message: "rate limit exceeded; retry after backoff",
          data: {
            code: "E_RATE",
            detail: {
              reason: "rate_limited",
              limit: { rate_per_sec: 50, burst: 100 }
            },
            http_status: 429
          }
        }
      });
    } finally {
      nowSpy.mockRestore();
      await h.close();
    }
  });

  it("pins the amplifier-bucket 429 (session mint / ws-ticket share the tighter bucket)", async () => {
    const h = await buildHarness();
    const clock = { t: Date.now() };
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock.t);
    try {
      const sid = await h.mint();
      // 16: exhaust the mint bucket with rapid ticket mints (burst 20,
      // refill 5/s; the clock is pinned so no refill happens).
      let throttled: { status: number; body: Record<string, unknown> } | null = null;
      for (let i = 0; i < 40 && throttled === null; i += 1) {
        const res = await clientFetch(h.gateway, "POST", "/net-api/ws-ticket", { token: h.token, body: { session: sid } });
        if (res.status === 429) throttled = res;
      }
      expect(throttled, "amplifier bucket never refused in 40 mints").not.toBeNull();
      expect(throttled!.body).toEqual({
        error: {
          code: "E_RATE",
          message: "rate limit exceeded; retry after backoff",
          detail: {
            reason: "rate_limited",
            limit: { rate_per_sec: 5, burst: 20 }
          }
        }
      });
    } finally {
      nowSpy.mockRestore();
      await h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// MCP — /net-api/mcp, rendered by clientMcpRoute/mcpRefusal (JSON-RPC
// envelope, ~5404/5439) and mcpToolError (tool envelope, ~6287)
// ---------------------------------------------------------------------------

describe("MCP dialect fault rendering (CS3.3 baseline)", () => {
  it("pins the initialize credential refusals (fixtures 17-18)", async () => {
    const h = await buildHarness();
    try {
      // 17: known key, wrong secret; the id correlates because initialize is
      // a parsed request.
      const badSecret = await h.mcp(
        { jsonrpc: "2.0", id: 42, method: "initialize", params: {} },
        { "mcp-token": `apikey:${KEY_ID}:wrong-secret` }
      );
      expect(badSecret.status).toBe(401);
      expect(badSecret.body).toEqual({
        jsonrpc: "2.0",
        id: 42,
        error: {
          code: -32000,
          message: "apikey secret rejected",
          data: {
            code: "E_NOSESSION",
            detail: { reason: "secret_rejected" },
            http_status: 401
          }
        }
      });

      // 18: unknown key id.
      const unknown = await h.mcp(
        { jsonrpc: "2.0", id: "init-2", method: "initialize", params: {} },
        { "mcp-token": "apikey:no-such-key:whatever" }
      );
      expect(unknown.status).toBe(401);
      expect(unknown.body).toEqual({
        jsonrpc: "2.0",
        id: "init-2",
        error: {
          code: -32000,
          message: "apikey not found or revoked",
          data: {
            code: "E_NOSESSION",
            detail: { reason: "unknown_or_revoked" },
            http_status: 401
          }
        }
      });
    } finally {
      await h.close();
    }
  });

  it("pins the unknown-session refusal on tools/call (fixture 19)", async () => {
    const h = await buildHarness();
    try {
      const forged = await h.mcp(
        { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "woo_wait", arguments: {} } },
        { "mcp-session-id": "s_not-a-real-session" }
      );
      expect(forged.status).toBe(401);
      expect(forged.body).toEqual({
        jsonrpc: "2.0",
        id: 8,
        error: {
          code: -32000,
          message: "session missing",
          data: {
            code: "E_NOSESSION",
            detail: { session_verdict: "missing", reason: "session_bearer_rejected" },
            http_status: 401
          }
        }
      });
    } finally {
      await h.close();
    }
  });

  it("pins the tool-envelope validation and refused-call errors (fixtures 20-22b)", async () => {
    const h = await buildHarness();
    try {
      const session = await h.mcpOpen();

      // 20: `arguments` supplied but not an object — refused at the envelope,
      // rendered as a TOOL error (isError + structuredContent.error), HTTP 200.
      const badArguments = await h.mcp(
        { jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "woo_call", arguments: "nope" } },
        { "mcp-session-id": session }
      );
      expect(badArguments.status).toBe(200);
      const badArgumentsError = {
        code: "E_INVARG",
        message: 'woo_call: "arguments" must be a JSON object of named parameters, received string',
        detail: {
          reason: "invalid_arguments_object",
          tool: "woo_call",
          field: "arguments",
          expected: "object",
          received: "string",
          remediation: "pass arguments as a JSON object keyed by parameter name, or omit it entirely when the tool takes none"
        }
      };
      expect(badArguments.body).toEqual({
        jsonrpc: "2.0",
        id: 21,
        result: {
          content: [{ type: "text", text: JSON.stringify(badArgumentsError) }],
          structuredContent: { error: badArgumentsError },
          isError: true
        }
      });

      // 21: woo_call's own control schema — `args` must be an array.
      const badArgs = await h.mcp(
        { jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "woo_call", arguments: { object: "fx_box", verb: "bump", args: "nope" } } },
        { "mcp-session-id": session }
      );
      expect(badArgs.status).toBe(200);
      const badArgsError = {
        code: "E_INVARG",
        message: 'woo_call: argument "args" must be array or null, received string',
        detail: {
          reason: "argument_type_mismatch",
          tool: "woo_call",
          field: "args",
          expected: "array or null",
          received: "string",
          remediation: 'pass "args" as array or null'
        }
      };
      expect(badArgs.body).toEqual({
        jsonrpc: "2.0",
        id: 22,
        result: {
          content: [{ type: "text", text: JSON.stringify(badArgsError) }],
          structuredContent: { error: badArgsError },
          isError: true
        }
      });

      // 22: a refused call — an unknown verb on a co-present object,
      // rendered as the tool envelope.
      const unknownVerb = await h.mcp(
        { jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "woo_call", arguments: { object: "fx_box", verb: "no_such_verb", args: [] } } },
        { "mcp-session-id": session }
      );
      expect(unknownVerb.status).toBe(200);
      const unknownVerbError = {
        code: "E_VERBNF",
        message: "verb not found: fx_box:no_such_verb",
        detail: {
          obj: "fx_box",
          name: "no_such_verb",
          reason: "verb_not_defined",
          remediation: "fx_box is reachable but defines no no_such_verb on its class chain; list its verbs, or install one"
        }
      };
      expect(unknownVerb.body).toEqual({
        jsonrpc: "2.0",
        id: 23,
        result: {
          content: [{ type: "text", text: JSON.stringify(unknownVerbError) }],
          structuredContent: { error: unknownVerbError },
          isError: true
        }
      });

      // 22b: a turn that RAN and failed (the verb threw inside the committed
      // execution) — the mcpShapeTurnError path, still a tool envelope.
      const exploded = await h.mcp(
        { jsonrpc: "2.0", id: 24, method: "tools/call", params: { name: "woo_call", arguments: { object: "fx_box", verb: "explode", args: [] } } },
        { "mcp-session-id": session }
      );
      expect(exploded.status).toBe(200);
      // The verb RAN: the envelope carries the committed failure (with its
      // VM trace) AND the observations seat — the actor's only copy of what
      // its own failed action emitted (§M4.1). `progr` is the fixture
      // actor's id — deterministic, but derived by the world, so it is
      // interpolated rather than written literally.
      const explodedError = {
        code: "E_INVARG",
        message: "the box refuses",
        trace: [{ obj: "fx_box", verb: "explode", definer: "fx_box", progr: h.actor, pc: 5, version: 1 }]
      };
      const explodedObservation = {
        type: "$error",
        code: "E_INVARG",
        message: "the box refuses",
        value: null,
        trace: [{ obj: "fx_box", verb: "explode", definer: "fx_box", progr: h.actor, pc: 5, version: 1 }]
      };
      expect(exploded.body).toEqual({
        jsonrpc: "2.0",
        id: 24,
        result: {
          content: [
            { type: "text", text: JSON.stringify(explodedError) },
            { type: "text", text: JSON.stringify({ observations: [explodedObservation] }) }
          ],
          structuredContent: {
            error: explodedError,
            observations: [explodedObservation]
          },
          isError: true
        }
      });
    } finally {
      await h.close();
    }
  });

  it("pins the parse-error refusal (fixture 25)", async () => {
    const h = await buildHarness();
    try {
      const garbage = await h.mcp("this is not json");
      expect(garbage.status).toBe(400);
      expect(garbage.body).toEqual({
        jsonrpc: "2.0",
        error: {
          code: -32700,
          message: "parse error: expected a JSON-RPC 2.0 request"
        }
      });
    } finally {
      await h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// WebSocket — ticket mint (~7202), upgrade (~7233), webSocketMessage frames
// (~7310) and the turn error branch (~7371)
// ---------------------------------------------------------------------------

describe("WebSocket dialect fault rendering (CS3.3 baseline)", () => {
  it("pins the upgrade refusals (fixtures 26-27)", async () => {
    const h = await buildHarness();
    try {
      // 26: no ticket — the permanent credential never rides the URL.
      const noTicket = await clientFetch(h.gateway, "GET", "/net-api/ws", {
        headers: { upgrade: "websocket" }
      });
      expect(noTicket.status).toBe(401);
      expect(noTicket.body).toEqual({
        error: {
          code: "E_NOSESSION",
          message: "WS upgrade requires a ticket (POST /net-api/ws-ticket)",
          detail: { reason: "ticket_required" }
        }
      });

      // 27: a forged/unknown ticket.
      const badTicket = await clientFetch(h.gateway, "GET", "/net-api/ws?ticket=wst_forged", {
        headers: { upgrade: "websocket" }
      });
      expect(badTicket.status).toBe(401);
      expect(badTicket.body).toEqual({
        error: {
          code: "E_NOSESSION",
          message: "ticket invalid or expired",
          detail: { reason: "ticket_invalid" }
        }
      });
    } finally {
      await h.close();
    }
  });

  it("pins the frame-level faults (fixtures 28-30)", async () => {
    const h = await buildHarness();
    try {
      const sid = await h.mint();
      const server = await h.wsOpen(sid);

      // 28: a frame that is not JSON.
      await h.gateway.webSocketMessage(server as unknown as WebSocket, "not json {");
      expect(frames(server).at(-1)).toEqual({
        type: "error",
        error: { code: "E_INVARG", message: "frames must be JSON text" }
      });

      // 29: per-frame session validation — a socket this DO never attached
      // (no hibernation attachment) is refused namedly, id echoed.
      const orphan = new FakeWebSocket();
      await h.gateway.webSocketMessage(
        orphan as unknown as WebSocket,
        JSON.stringify({ type: "turn", id: "orphan-1", target: "fx_box", verb: "bump" })
      );
      expect(frames(orphan).at(-1)).toEqual({
        type: "error",
        id: "orphan-1",
        error: { code: "E_NOSESSION", message: "socket has no session attachment" }
      });

      // 30: an unknown frame type.
      await h.gateway.webSocketMessage(
        server as unknown as WebSocket,
        JSON.stringify({ type: "mystery", id: "m1" })
      );
      expect(frames(server).at(-1)).toEqual({
        type: "error",
        id: "m1",
        error: { code: "E_INVARG", message: 'unknown frame type "mystery"' }
      });
    } finally {
      await h.close();
    }
  });

  it("pins the expired-session turn frame and the refused-turn frame (fixtures 32-33)", async () => {
    const h = await buildHarness();
    const clock = { t: Date.now() };
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock.t);
    try {
      const sid = await h.mint();
      const server = await h.wsOpen(sid);

      // 33: a refused turn travels the SAME clientTurn path as REST and the
      // refusal body is spread into a turn_result frame with the status.
      await h.gateway.webSocketMessage(
        server as unknown as WebSocket,
        JSON.stringify({ type: "turn", id: "deny-1", target: "fx_box", verb: "locked_probe", route: "direct" })
      );
      expect(frames(server).at(-1)).toEqual({
        type: "turn_result",
        id: "deny-1",
        status: 403,
        error: {
          code: "E_DIRECT_DENIED",
          message: "verb locked_probe is not externally direct-callable",
          detail: { target: "fx_box", verb: "locked_probe" }
        }
      });

      // 32: age the session past its ttl on the pinned clock; the per-frame
      // bearer re-validation refuses with the verdict, as a turn_result so
      // the client's in-flight turn settles.
      clock.t += 700_000; // ttl was 600s
      await h.gateway.webSocketMessage(
        server as unknown as WebSocket,
        JSON.stringify({ type: "turn", id: "expired-1", target: "fx_box", verb: "bump" })
      );
      expect(frames(server).at(-1)).toEqual({
        type: "turn_result",
        id: "expired-1",
        status: 401,
        error: {
          code: "E_NOSESSION",
          message: "session expired",
          detail: { session_verdict: "expired", reason: "session_bearer_rejected" }
        }
      });
    } finally {
      nowSpy.mockRestore();
      await h.close();
    }
  });
});
