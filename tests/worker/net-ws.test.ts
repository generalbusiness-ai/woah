// Phase-4 item 3: the /net-api/ws WebSocket transport + observation push
// over fake-DO (coherence.md CO14 client surface + CO13 presence
// audiences; kickoff "WS transport + observation push").
//
// Runtime shims (the established cf-repository.test.ts idiom): workerd's
// `WebSocketPair` global and its 101-tolerant Response are stubbed for
// the whole file — Node's undici Response refuses status 101, and the
// pair type only exists in workerd.
//
// Proves (chunk 1 — the socket surface):
//   - upgrade refusals are named: no Upgrade header (400), bad apikey
//     (401), missing/bogus/mismatched session (401 with the verdict);
//   - a valid upgrade accepts the server socket TAGGED with the session
//     id (the hibernation registry — no durable copy, CO5 stays five)
//     and attaches {session, actor};
//   - {type:"turn"} frames run the SAME clientTurn path (result +
//     observations on the turn_result frame; the socket's own session is
//     used regardless of what the frame claims); {type:"ping"} pongs;
//     unknown/malformed frames get named error frames, never a close.
//
// Proves (chunk 2 — observation push via session_presence):
//   - a turn's fanout pushes {type:"observations"} frames to sockets of
//     OTHER sessions present (CO13 mirror) in the fanout's scope;
//   - the SUBMITTING session's socket is skipped (it got the
//     observations on the turn reply — turn-id dedupe);
//   - sessions present elsewhere (or nowhere) receive nothing; a
//     present session with no socket is skipped silently.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeDurableObjectState, FakeWebSocket, FakeWebSocketPair } from "./fake-do";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { installVerb } from "../../src/core/authoring";
import { createWorld } from "../../src/core/bootstrap";
import { cellsFromSerialized } from "../../src/net/bridge";
import { netActivationCell } from "../../src/net/install";
import { CATALOG_SCOPE, partitionCells } from "../../src/net/topology";
import { signInternalRequest } from "../../src/worker/internal-auth";

const SECRET = "net-ws-test-secret";
const EPOCH = "cat-net-ws-1";
const KEY_ID = "ws-key";
const KEY_SECRET = "ws-secret";

/** 101-tolerant Response for the upgrade path (Node's undici Response
 * rejects informational statuses). Only what the DOs and assertions
 * need: status/ok/json/text/webSocket. */
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

/** One shared deferred queue for EVERY DO in the harness: cross-DO
 * deliveries chain (a scope drain enqueues a gateway fanout which may
 * enqueue nothing further), so settle() drains until quiescent. */
function netState(name: string, deferred: Array<Promise<unknown>>) {
  const fake = new FakeDurableObjectState(name);
  let alarmAt: number | null = null;
  const state = {
    id: fake.id,
    waitUntil: (promise: Promise<unknown>) => {
      deferred.push(promise);
    },
    acceptWebSocket: (ws: WebSocket, tags?: string[]) => fake.acceptWebSocket(ws, tags),
    getWebSockets: (tag?: string) => fake.getWebSockets(tag),
    storage: {
      sql: fake.storage.sql,
      transactionSync: fake.storage.transactionSync,
      setAlarm: (at: number) => { alarmAt = at; },
      deleteAlarm: () => { alarmAt = null; }
    }
  } satisfies NetScopeDurableState & NetGatewayDurableState & { acceptWebSocket: unknown; getWebSockets: unknown };
  return {
    state,
    fake,
    /** Claim one due durable alarm. Future session-reap alarms remain
     * parked; immediate outbox continuations fire through DO.alarm(). */
    takeDueAlarm: (now: number): boolean => {
      if (alarmAt === null || alarmAt > now) return false;
      alarmAt = null;
      return true;
    },
    close: () => fake.close()
  };
}

async function clientFetch(
  gateway: NetGatewayDO,
  method: string,
  path: string,
  opts: { token?: string; headers?: Record<string, string>; body?: unknown } = {}
): Promise<{ status: number; body: Record<string, unknown>; webSocket?: WebSocket }> {
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
  const body =
    response.status === 101 ? {} : ((await response.json()) as Record<string, unknown>);
  return { status: response.status, body, ...(response.webSocket ? { webSocket: response.webSocket } : {}) };
}

/** Mint a B3 WS ticket for a session over authenticated HTTP. */
async function mintTicket(h: Harness, session: string, token = `apikey:${KEY_ID}:${KEY_SECRET}`): Promise<string> {
  const res = await clientFetch(h.gateway, "POST", "/net-api/ws-ticket", { token, body: { session } });
  if (res.status !== 200) throw new Error(`ws-ticket mint failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.ticket as string;
}

/** WS upgrade against the gateway DO (B3: authenticated by a ticket, not
 * the apikey). Returns the 101 (or refusal) plus the fake SERVER socket
 * the DO accepted. `ticket` overrides the minted one (for invalid-ticket
 * cases); pass null session to skip minting entirely. */
async function upgrade(
  h: Harness,
  session: string | null,
  opts: { ticket?: string; noUpgradeHeader?: boolean } = {}
): Promise<{ status: number; body: Record<string, unknown>; server: FakeWebSocket | null }> {
  const before = new Set(h.gatewayFake.getWebSockets());
  const ticket = opts.ticket ?? (session !== null ? await mintTicket(h, session) : null);
  const result = await clientFetch(h.gateway, "GET", `/net-api/ws${ticket !== null ? `?ticket=${ticket}` : ""}`, {
    headers: opts.noUpgradeHeader ? {} : { upgrade: "websocket" }
  });
  const server = h.gatewayFake.getWebSockets().find((ws) => !before.has(ws)) ?? null;
  return { status: result.status, body: result.body, server: server as unknown as FakeWebSocket | null };
}

function frames(server: FakeWebSocket): Array<Record<string, unknown>> {
  return server.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

type Harness = Awaited<ReturnType<typeof buildHarness>>;

async function buildHarness(gatewayEnvExtra: Partial<NetGatewayEnv> = {}) {
  // Engine-real fixture, mirroring net-client-api.test.ts plus the
  // presence pieces: a home room with an observing box, a second room
  // (the "annex") reachable by a presence-gate-skipping :welcome (the
  // lane idiom — entering IS the transition that mints the CO13
  // presence row), and a wave box in the annex whose verb observes.
  const world = createWorld();
  const session = world.auth("guest:net-ws");
  const actor = session.actor;
  world.createObject({ id: "ws_room", name: "WS Room", parent: "$space", owner: actor });
  world.createObject({ id: "ws_box", name: "WS Box", parent: "$thing", owner: actor, anchor: "ws_room", location: "ws_room" });
  world.defineProperty("ws_box", { name: "counter", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
  const bump = installVerb(
    world,
    "ws_box",
    "bump",
    `verb :bump() rxd {
      this.counter = this.counter + 1;
      observe({ type: "bumped", counter: this.counter });
      return this.counter;
    }`,
    null
  );
  expect(bump.ok).toBe(true);
  world.createObject({ id: "ws_annex", name: "WS Annex", parent: "$space", owner: actor });
  const welcome = installVerb(
    world,
    "ws_annex",
    "welcome",
    `verb :welcome() rxd {
      moveto(actor, this);
      return 1;
    }`,
    null
  );
  expect(welcome.ok).toBe(true);
  const welcomeVerb = world.object("ws_annex").verbs.find((verb) => verb.name === "welcome");
  if (!welcomeVerb) throw new Error("welcome verb missing after install");
  welcomeVerb.skip_presence_check = true;
  world.createObject({ id: "ws_wave_box", name: "Wave Box", parent: "$thing", owner: actor, anchor: "ws_annex", location: "ws_annex" });
  world.defineProperty("ws_wave_box", { name: "waves", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
  const wave = installVerb(
    world,
    "ws_wave_box",
    "wave",
    `verb :wave() rxd {
      this.waves = this.waves + 1;
      observe({ type: "waved", waves: this.waves });
      return this.waves;
    }`,
    null
  );
  expect(wave.ok).toBe(true);
  // A third room for the "present elsewhere" push case: a session that
  // transitioned HERE must receive nothing from an annex-scope fanout.
  world.createObject({ id: "ws_side", name: "WS Side Room", parent: "$space", owner: actor });
  const sideWelcome = installVerb(
    world,
    "ws_side",
    "welcome",
    `verb :welcome() rxd {
      moveto(actor, this);
      return 1;
    }`,
    null
  );
  expect(sideWelcome.ok).toBe(true);
  const sideWelcomeVerb = world.object("ws_side").verbs.find((verb) => verb.name === "welcome");
  if (!sideWelcomeVerb) throw new Error("side welcome verb missing after install");
  sideWelcomeVerb.skip_presence_check = true;
  const placed = await world.directCall("ws-genesis-place", actor, actor, "moveto", ["ws_room"], { sessionId: session.id });
  expect(placed.op).toBe("result");
  world.ensureApiKey("$wiz", actor, KEY_ID, KEY_SECRET, "net-ws-test");
  const otherSession = world.auth("guest:net-ws-2");
  const other = otherSession.actor;
  const otherPlaced = await world.directCall("ws-genesis-place-other", other, other, "moveto", ["ws_room"], { sessionId: otherSession.id });
  expect(otherPlaced.op).toBe("result");
  world.ensureApiKey("$wiz", other, "ws-key-2", "ws-secret-2", "net-ws-test-2");

  const partitions = partitionCells(cellsFromSerialized(world.exportWorld()));
  // Activation barrier: the fixture installs a pre-verified world, so it
  // self-activates with the catalog partition.
  partitions.set(CATALOG_SCOPE, [...(partitions.get(CATALOG_SCOPE) ?? []), netActivationCell(EPOCH)]);
  const roomScope = "room:ws_room";
  const annexScope = "room:ws_annex";
  const sideScope = "room:ws_side";
  const clusterScope = `cluster:${actor}`;

  const deferred: Array<Promise<unknown>> = [];
  const states: Array<ReturnType<typeof netState>> = [];
  const scopeDOs = new Map<string, NetScopeDO>();
  const scopeStates = new Map<string, ReturnType<typeof netState>>();
  let gateway: NetGatewayDO;
  const resolve = (destination: string) => {
    if (destination === "gateway:net-api") return gateway;
    const scope = destination.startsWith("scope:") ? destination.slice("scope:".length) : null;
    const instance = scope !== null ? scopeDOs.get(scope) : undefined;
    if (!instance) throw new Error(`unresolvable destination ${destination}`);
    return instance;
  };
  const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve };
  for (const scope of [roomScope, annexScope, sideScope, clusterScope, CATALOG_SCOPE, `cluster:${other}`]) {
    const st = netState(`scope-${scope}`, deferred);
    const instance = new NetScopeDO(st.state, scopeEnv);
    const seedRequest = new Request("https://do/net/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, catalog_epoch: EPOCH, cells: partitions.get(scope) ?? [] })
    });
    const seeded = await instance.fetch(await signInternalRequest(scopeEnv, seedRequest));
    expect(seeded.ok).toBe(true);
    states.push(st);
    scopeStates.set(scope, st);
    scopeDOs.set(scope, instance);
  }

  const gatewayState = netState("gateway-net-api", deferred);
  // The fake state's id is `gateway-net-api`, but the harness resolver
  // deliberately registers the production-shaped logical destination
  // `gateway:net-api`. Pin self-subscription to that same name so the
  // fixture cannot manufacture an unresolvable duplicate subscriber.
  const gatewayEnv: NetGatewayEnv = {
    WOO_INTERNAL_SECRET: SECRET,
    NET_RESOLVE: resolve,
    NET_GATEWAY_SELF: "gateway:net-api",
    ...gatewayEnvExtra
  };
  gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);
  states.push(gatewayState);

  /** Subscribe the client gateway shard to a scope's fanout (the same
   * registration the workerd lane performs). */
  const subscribe = async (scope: string): Promise<void> => {
    const request = new Request("https://do/net/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ destination: "gateway:net-api" })
    });
    const response = await (scopeDOs.get(scope) as NetScopeDO).fetch(await signInternalRequest(scopeEnv, request));
    expect(response.ok).toBe(true);
  };

  /** Drain every deferred delivery and due durable alarm to quiescence.
   * Incoming /relate deliberately crosses an alarm event before refan
   * (CO2.7), so a no-op alarm fake would strand the final presence row
   * until an unrelated request happened to reactivate that scope. */
  const settle = async (): Promise<void> => {
    for (;;) {
      while (deferred.length > 0) {
        await deferred.shift()?.catch(() => {});
      }
      let fired = false;
      const now = Date.now();
      for (const [scope, instance] of scopeDOs) {
        const scopeState = scopeStates.get(scope);
        if (!scopeState?.takeDueAlarm(now)) continue;
        fired = true;
        await instance.alarm();
      }
      if (!fired && deferred.length === 0) return;
    }
  };

  const mint = async (): Promise<string> => {
    const minted = await clientFetch(gateway, "POST", "/net-api/session", {
      token: `apikey:${KEY_ID}:${KEY_SECRET}`,
      body: { ttl_ms: 600_000 }
    });
    expect(minted.status, JSON.stringify(minted.body)).toBe(200);
    return minted.body.session as string;
  };
  const mintOther = async (): Promise<string> => {
    const minted = await clientFetch(gateway, "POST", "/net-api/session", {
      token: "apikey:ws-key-2:ws-secret-2",
      body: { ttl_ms: 600_000 }
    });
    expect(minted.status, JSON.stringify(minted.body)).toBe(200);
    return minted.body.session as string;
  };

  /** Simulate another gateway shard: keep the caller and relation mirror but
   * remove one peer's cluster cells before rehydrating the gateway object. */
  const rehydrateWithoutPeerCells = (peerSession: string): NetGatewayDO => {
    gatewayState.state.storage.sql.exec("DELETE FROM net_gateway_cell WHERE key = ?", `session:${peerSession}`);
    gatewayState.state.storage.sql.exec("DELETE FROM net_gateway_cell WHERE key IN (?, ?)", `object_lineage:${other}`, `object_live:${other}`);
    gatewayState.state.storage.sql.exec("DELETE FROM net_gateway_cell WHERE key LIKE ?", `property_cell:${other}:%`);
    gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);
    return gateway;
  };

  return {
    gateway,
    gatewayFake: gatewayState.fake,
    actor,
    other,
    roomScope,
    annexScope,
    sideScope,
    subscribe,
    settle,
    mint,
    mintOther,
    rehydrateWithoutPeerCells,
    close: () => states.forEach((st) => st.close())
  };
}

describe("/net-api/ws socket surface (Phase 4 item 3 chunk 1)", () => {
  it("refuses upgrades namedly: header, ticket, and refuses ticket mint for bad key/foreign session (B3)", async () => {
    const h = await buildHarness();
    const sid = await h.mint();

    // No Upgrade header: a plain GET is not a WebSocket.
    const plain = await upgrade(h, sid, { noUpgradeHeader: true });
    expect(plain.status).toBe(400);
    expect(plain.body.error).toMatchObject({ code: "E_INVARG" });
    expect(plain.server).toBeNull();

    // No ticket: the upgrade carries no apikey (B3), so a ticket is
    // REQUIRED — the permanent credential never rides the URL.
    const noTicket = await upgrade(h, null);
    expect(noTicket.status).toBe(401);
    expect(noTicket.body.error).toMatchObject({ code: "E_NOSESSION", detail: { reason: "ticket_required" } });
    expect(noTicket.server).toBeNull();

    // An unknown/forged ticket.
    const badTicket = await upgrade(h, null, { ticket: "wst_forged" });
    expect(badTicket.status).toBe(401);
    expect(badTicket.body.error).toMatchObject({ code: "E_NOSESSION", detail: { reason: "ticket_invalid" } });

    // A ticket is single-use: reusing one refuses the second upgrade.
    const ticket = await mintTicket(h, sid);
    const first = await upgrade(h, null, { ticket });
    expect(first.status).toBe(101);
    const reuse = await upgrade(h, null, { ticket });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error).toMatchObject({ code: "E_NOSESSION", detail: { reason: "ticket_invalid" } });

    // The ticket MINT is where apikey auth lives: a bad secret is refused.
    const badMint = await clientFetch(h.gateway, "POST", "/net-api/ws-ticket", {
      token: `apikey:${KEY_ID}:wrong`,
      body: { session: sid }
    });
    expect(badMint.status).toBe(401);
    expect(badMint.body.error).toMatchObject({ code: "E_NOSESSION", detail: { reason: "secret_rejected" } });

    // Another authenticated identity cannot mint a ticket for THIS actor's
    // session (the session's actor binding refuses it).
    const stolenMint = await clientFetch(h.gateway, "POST", "/net-api/ws-ticket", {
      token: "apikey:ws-key-2:ws-secret-2",
      body: { session: sid }
    });
    expect(stolenMint.status).toBe(401);
    expect(stolenMint.body.error).toMatchObject({ code: "E_NOSESSION", detail: { session_verdict: "actor_mismatch" } });

    h.close();
  });

  it("accepts a ticket upgrade tagged by session and serves turn/ping frames", async () => {
    const h = await buildHarness();
    const sid = await h.mint();

    const opened = await upgrade(h, sid);
    expect(opened.status).toBe(101);
    expect(opened.server).not.toBeNull();
    const server = opened.server as FakeWebSocket;
    // The registry IS the tag index: the session tag finds the socket.
    expect(h.gatewayFake.getWebSockets(sid)).toHaveLength(1);
    expect(h.gatewayFake.getWebSockets("s_someone_else")).toHaveLength(0);
    // The attachment carries the validated identity across hibernation.
    expect(server.deserializeAttachment()).toMatchObject({ session: sid, actor: h.actor });

    // B3: the apikey never rides the URL — the query token path is gone;
    // every route authenticates by header (or, for the upgrade, ticket).
    const ignoredQuery = await clientFetch(h.gateway, "GET", `/net-api/cell?key=x&token=apikey:${KEY_ID}:${KEY_SECRET}`);
    expect(ignoredQuery.status).toBe(401);
    expect(ignoredQuery.body.error).toMatchObject({ code: "E_NOSESSION", detail: { reason: "missing_credential" } });

    // Ping → pong with the id echoed.
    await h.gateway.webSocketMessage(server as unknown as WebSocket, JSON.stringify({ type: "ping", id: "p1" }));
    expect(frames(server).at(-1)).toEqual({ type: "pong", id: "p1" });

    // A turn frame runs the same clientTurn path: committed, with the
    // item-1 result/observations on the turn_result frame.
    await h.gateway.webSocketMessage(
      server as unknown as WebSocket,
      JSON.stringify({ type: "turn", id: "t1", target: "ws_box", verb: "bump", idempotency_key: "ws-t1" })
    );
    const turnFrame = frames(server).at(-1) as {
      type: string;
      id: string;
      status: number;
      reply?: { status?: string };
      result?: unknown;
      observations?: Array<{ type?: string }>;
    };
    expect(turnFrame.type).toBe("turn_result");
    expect(turnFrame.id).toBe("t1");
    expect(turnFrame.status, JSON.stringify(turnFrame)).toBe(200);
    expect(turnFrame.reply?.status).toBe("accepted");
    expect(turnFrame.result).toBe(1);
    expect(turnFrame.observations?.map((o) => o.type)).toContain("bumped");
    // Phase 5 v1 contract freeze: the turn_result frame's field names are
    // pinned (add-only, never rename — a renamed field breaks deployed
    // clients silently; the .v1 tags are decorative and no receiver
    // checks them).
    for (const key of ["type", "id", "status", "reply", "result", "observations"]) {
      expect(Object.keys(turnFrame as Record<string, unknown>), `turn_result.${key}`).toContain(key);
    }

    // A frame claiming ANOTHER session still runs on the socket's own:
    // the reply is a normal accepted turn, not an actor_mismatch — the
    // frame's session field is ignored by design.
    await h.gateway.webSocketMessage(
      server as unknown as WebSocket,
      JSON.stringify({ type: "turn", id: "t2", session: "s_forged", target: "ws_box", verb: "bump", idempotency_key: "ws-t2" })
    );
    const second = frames(server).at(-1) as { type: string; status: number; reply?: { status?: string } };
    expect(second.status).toBe(200);
    expect(second.reply?.status).toBe("accepted");

    // Unknown frame types and non-JSON get named error frames — the
    // socket stays open (readyState untouched).
    await h.gateway.webSocketMessage(server as unknown as WebSocket, JSON.stringify({ type: "mystery", id: "m1" }));
    expect(frames(server).at(-1)).toMatchObject({ type: "error", id: "m1", error: { code: "E_INVARG" } });
    await h.gateway.webSocketMessage(server as unknown as WebSocket, "not json");
    expect(frames(server).at(-1)).toMatchObject({ type: "error", error: { code: "E_INVARG" } });
    expect(server.readyState).toBe(1);

    h.close();
  });

  it("rate-limits inbound turn frames on the socket's actor bucket (H4)", async () => {
    const h = await buildHarness();
    const token = `apikey:${KEY_ID}:${KEY_SECRET}`;
    const sid = await h.mint();
    const opened = await upgrade(h, sid);
    expect(opened.status).toBe(101);
    const server = opened.server as FakeWebSocket;

    // REST and WS frames share ONE per-actor bucket: exhaust it with
    // cheap REST reads (each consumes a token after auth) so the frame
    // path's refusal is provable without 100 full commits.
    for (let i = 0; i < 100; i += 1) {
      await clientFetch(h.gateway, "GET", "/net-api/cell?key=object_live:ws_box", { token });
    }
    await h.gateway.webSocketMessage(
      server as unknown as WebSocket,
      JSON.stringify({ type: "turn", id: "rate1", target: "ws_box", verb: "bump", idempotency_key: "ws-rate-1" })
    );
    const refused = frames(server).at(-1);
    expect(refused).toMatchObject({ type: "turn_result", id: "rate1", status: 429, error: { code: "E_RATE" } });
    // The socket survives the refusal (a throttle is not a protocol error).
    expect(server.readyState).toBe(1);

    h.close();
  });
});

describe("gateway self-subscribe (H1)", () => {
  it("plans who_all from owner-anchored presence when the shard lacks a peer's cluster cells", async () => {
    const h = await buildHarness({ NET_GATEWAY_SELF: "gateway:net-api" });
    const token = `apikey:${KEY_ID}:${KEY_SECRET}`;
    const s1 = await h.mint();
    const s2 = await h.mintOther();
    const enter = async (gateway: NetGatewayDO, tokenValue: string, sid: string, key: string): Promise<void> => {
      const entered = await clientFetch(gateway, "POST", "/net-api/turn", {
        token: tokenValue,
        body: { target: "ws_annex", verb: "welcome", session: sid, idempotency_key: key }
      });
      expect(entered.status, JSON.stringify(entered.body)).toBe(200);
    };
    await enter(h.gateway, token, s1, "who-presence-enter-1");
    await enter(h.gateway, "apikey:ws-key-2:ws-secret-2", s2, "who-presence-enter-2");
    // Do not drain deferred outboxes. Accepted enter must synchronously make
    // the owner roster readable; otherwise this reproduces the deployed
    // partial-roster race across shards.

    const fresh = h.rehydrateWithoutPeerCells(s2);
    const who = await clientFetch(fresh, "POST", "/net-api/turn", {
      token,
      body: { target: h.actor, verb: "who_all", args: [], session: s1, idempotency_key: "who-owner-projection" }
    });
    expect(who.status, JSON.stringify(who.body)).toBe(200);
    expect((who.body.reply as { status?: string })?.status, JSON.stringify(who.body)).toBe("accepted");
    expect(who.body.result).toEqual(expect.arrayContaining([
      expect.objectContaining({ player: h.actor }),
      expect.objectContaining({ player: h.other })
    ]));
    h.close();
  });

  it("auto-subscribes the gateway to the scopes a session touches, so peer push works with NO manual subscribe", async () => {
    // NET_GATEWAY_SELF set, and — crucially — NO h.subscribe() call
    // anywhere: the gateway must register itself to the annex on its own
    // (session-open → cluster; each turn's anchor → the active scope),
    // which is exactly what H1 replaces the lane's manual subscribe with.
    const h = await buildHarness({ NET_GATEWAY_SELF: "gateway:net-api" });
    const token = `apikey:${KEY_ID}:${KEY_SECRET}`;

    const s1 = await h.mint(); // submitter
    const s2 = await h.mint(); // peer present in the annex → MUST receive
    const enter = async (sid: string, key: string): Promise<void> => {
      const entered = await clientFetch(h.gateway, "POST", "/net-api/turn", {
        token,
        body: { target: "ws_annex", verb: "welcome", session: sid, idempotency_key: key }
      });
      expect(entered.status, JSON.stringify(entered.body)).toBe(200);
      expect((entered.body.reply as { status?: string })?.status).toBe("accepted");
    };
    await enter(s1, "h1-enter-1");
    await enter(s2, "h1-enter-2");
    await h.settle();

    // The mirror learned the annex audience purely via self-subscribe +
    // the pull-after-subscribe / live refans (no doorway subscribe).
    const roster = await clientFetch(h.gateway, "GET", `/net-api/relation?session=${s1}&relation=session_presence&owner=ws_annex`, {
      token
    });
    const members = (roster.body.members as Array<{ member: string }>).map((row) => row.member);
    expect(members).toEqual(expect.arrayContaining([s1, s2]));

    const a = await upgrade(h, s1);
    const b = await upgrade(h, s2);
    expect(a.status).toBe(101);
    expect(b.status).toBe(101);
    const socketA = a.server as FakeWebSocket;
    const socketB = b.server as FakeWebSocket;

    await h.gateway.webSocketMessage(
      socketA as unknown as WebSocket,
      JSON.stringify({ type: "turn", id: "h1w1", target: "ws_wave_box", verb: "wave", idempotency_key: "h1-wave-1" })
    );
    await h.settle();

    // The peer received the push — proving the self-subscription carried
    // the annex fanout to this shard.
    const peerObservations = frames(socketB).filter((frame) => frame.type === "observations");
    expect(peerObservations).toHaveLength(1);
    expect((peerObservations[0].observations as Array<{ type?: string }>).map((o) => o.type)).toContain("waved");
    // Phase 5 v1 contract freeze: the push frame's field names are pinned
    // (add-only, never rename).
    for (const key of ["type", "scope", "seq", "observations"]) {
      expect(Object.keys(peerObservations[0] as Record<string, unknown>), `observations.${key}`).toContain(key);
    }

    h.close();
  });
});

describe("observation push via session_presence (Phase 4 item 3 chunk 2)", () => {
  it("pushes a turn's observations to present peers, skipping the submitter and absent sessions", async () => {
    const h = await buildHarness();
    const token = `apikey:${KEY_ID}:${KEY_SECRET}`;
    // The gateway shard subscribes to the rooms whose fanout it should
    // mirror (the lane registration): the annex carries the presence
    // refans AND the wave commit; the side room carries s3's presence.
    await h.subscribe(h.annexScope);
    await h.subscribe(h.sideScope);

    // Four sessions of the authenticated actor, entering rooms through
    // the engine-real transition path (:welcome folds the session-cell
    // write; the presence deltas reach the room scope via /net/relate
    // and refan to the subscribed mirror — the CO13 single write path).
    const s1 = await h.mint(); // submitter: annex + socket
    const s2 = await h.mint(); // peer: annex + socket → MUST receive
    const s3 = await h.mint(); // elsewhere: side room + socket → nothing
    const s4 = await h.mint(); // annex, NO socket → skipped silently
    const enter = async (sid: string, room: string, key: string): Promise<void> => {
      const entered = await clientFetch(h.gateway, "POST", "/net-api/turn", {
        token,
        body: { target: room, verb: "welcome", session: sid, idempotency_key: key }
      });
      expect(entered.status, JSON.stringify(entered.body)).toBe(200);
      expect((entered.body.reply as { status?: string })?.status).toBe("accepted");
    };
    await enter(s1, "ws_annex", "ws-enter-1");
    await enter(s2, "ws_annex", "ws-enter-2");
    await enter(s3, "ws_side", "ws-enter-3");
    await enter(s4, "ws_annex", "ws-enter-4");
    await h.settle();

    // The mirror now names the annex audience (sanity for the fixture:
    // without these rows the push assertions below would be vacuous).
    // B1: the roster read carries the caller's session; s1 is present in
    // ws_annex (entered above), so it may read the annex's presence.
    const roster = await clientFetch(h.gateway, "GET", `/net-api/relation?session=${s1}&relation=session_presence&owner=ws_annex`, {
      token
    });
    const members = (roster.body.members as Array<{ member: string }>).map((row) => row.member);
    expect(members).toEqual(expect.arrayContaining([s1, s2, s4]));
    expect(members).not.toContain(s3);

    const a = await upgrade(h, s1);
    const b = await upgrade(h, s2);
    const c = await upgrade(h, s3);
    expect(a.status).toBe(101);
    expect(b.status).toBe(101);
    expect(c.status).toBe(101);
    const socketA = a.server as FakeWebSocket;
    const socketB = b.server as FakeWebSocket;
    const socketC = c.server as FakeWebSocket;

    // Phase 2 invariant: capture the net_presence_scan metric to prove the
    // presence fanout scanned only the TARGET scope's occupants (O(occupants)),
    // never the off-scope s3 or a whole-table sweep.
    const scanRows: number[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      if (args[0] === "woo.metric" && typeof args[1] === "string" && args[1].includes("net_presence_scan")) {
        try {
          scanRows.push((JSON.parse(args[1] as string) as { presence_scan_rows: number }).presence_scan_rows);
        } catch {
          /* not the metric we want */
        }
      }
    });

    // s1 waves over ITS socket; the commit's fanout (annex scope, with
    // the turn id riding — src/net/outbox.ts FanoutBody.turn_id) then
    // fans to the subscribed mirror.
    await h.gateway.webSocketMessage(
      socketA as unknown as WebSocket,
      JSON.stringify({ type: "turn", id: "w1", target: "ws_wave_box", verb: "wave", idempotency_key: "ws-wave-1" })
    );
    const waveResult = frames(socketA).at(-1) as {
      type: string;
      status: number;
      reply?: { status?: string };
      observations?: Array<{ type?: string }>;
    };
    expect(waveResult.type).toBe("turn_result");
    expect(waveResult.status, JSON.stringify(waveResult)).toBe(200);
    expect(waveResult.reply?.status).toBe("accepted");
    // Item-1 contract: the submitter's observations arrive ON THE REPLY.
    expect(waveResult.observations?.map((o) => o.type)).toContain("waved");
    await h.settle();

    // The present PEER receives the observations frame from the fanout.
    const peerObservations = frames(socketB).filter((frame) => frame.type === "observations");
    expect(peerObservations).toHaveLength(1);
    expect(peerObservations[0]).toMatchObject({ scope: h.annexScope });
    expect((peerObservations[0].observations as Array<{ type?: string }>).map((o) => o.type)).toContain("waved");

    // The SUBMITTER's socket gets nothing via fanout (turn-id dedupe:
    // the reply above already carried the observations — pushing again
    // would duplicate them).
    expect(frames(socketA).filter((frame) => frame.type === "observations")).toHaveLength(0);

    // A session present in ANOTHER room receives nothing; the socket-less
    // annex session (s4) was skipped silently — the push neither threw
    // nor blocked the peer delivery, which the s2 assertion above proves.
    expect(frames(socketC).filter((frame) => frame.type === "observations")).toHaveLength(0);

    // Phase 2 invariant: the fanout scan touched exactly the ANNEX
    // occupants (s1, s2, s4 — three rows), NOT the off-scope s3, and never
    // the whole session_presence table. This is the O(occupants) property
    // the owner_scope index gives: adding sessions in OTHER scopes cannot
    // grow this count.
    logSpy.mockRestore();
    expect(scanRows).toEqual([3]);

    h.close();
  });
});
