// SECURITY (P0): session bearer-token enumeration over the net client
// surface. A net session id IS the bearer credential (`Authorization:
// Bearer session:<id>`), so any surface that hands a co-present session's
// id (or its session cell value) to another actor is an account-takeover
// vector.
//
// This file is REPRODUCE-FIRST: the `EXPLOIT` cases assert the theft
// succeeds against the surface, and the `CLOSURE` cases assert the fix
// removes every session id/value from what a co-present peer receives
// while keeping the legitimate actor-level roster intact.
//
// Surfaces under test:
// - GET /net-api/relation?relation=session_presence
// - GET /net-api/cell?key=property_cell:<room>:<presence property>
// Both projections contain raw session ids; every client-facing path must
// refuse or redact them before a co-present peer can observe the payload.
import { describe, expect, it } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { installVerb } from "../../src/core/authoring";
import { createWorld } from "../../src/core/bootstrap";
import { cellsFromSerialized } from "../../src/net/bridge";
import { netActivationCell } from "../../src/net/install";
import { CATALOG_SCOPE, partitionCells } from "../../src/net/topology";

const SECRET = "net-session-leak-test-secret";
const EPOCH = "cat-net-leak-1";
const KEY_A = { id: "leak-key-a", secret: "leak-secret-a" };
const KEY_B = { id: "leak-key-b", secret: "leak-secret-b" };

function netState(name: string): {
  state: NetScopeDurableState & NetGatewayDurableState;
  settle: () => Promise<void>;
  close: () => void;
} {
  const fake = new FakeDurableObjectState(name);
  const deferred: Array<Promise<unknown>> = [];
  const state = {
    id: fake.id,
    waitUntil: (promise: Promise<unknown>) => {
      deferred.push(promise);
    },
    storage: {
      sql: fake.storage.sql,
      transactionSync: fake.storage.transactionSync,
      setAlarm: (_at: number) => {},
      deleteAlarm: () => {}
    }
  };
  return {
    state,
    settle: async () => {
      while (deferred.length > 0) await deferred.shift();
    },
    close: () => fake.close()
  };
}

async function clientFetch(
  gateway: NetGatewayDO,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = new Headers();
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  const request =
    method === "GET"
      ? new Request(`https://do${path}`, { headers })
      : new Request(`https://do${path}`, {
          method,
          headers: (headers.set("content-type", "application/json"), headers),
          body: JSON.stringify(opts.body ?? {})
        });
  const response = await gateway.fetch(request);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Two guest actors A and B, both placed in one room, each holding an
 * apikey. Mirrors net-client-api's fixture but seeds a co-presence
 * scenario. */
async function buildHarness() {
  const world = createWorld();
  const a = world.auth("guest:net-leak-a").actor;
  const b = world.auth("guest:net-leak-b").actor;
  world.createObject({ id: "leak_room", name: "Leak Room", parent: "$space", owner: a });
  world.createObject({ id: "leak_box", name: "Leak Box", parent: "$thing", owner: a, anchor: "leak_room", location: "leak_room" });
  world.defineProperty("leak_box", { name: "counter", defaultValue: 0, owner: a, perms: "rw", typeHint: "int" });
  const installed = installVerb(
    world,
    "leak_box",
    "bump",
    `verb :bump() rxd {
      this.counter = this.counter + 1;
      observe({ type: "bumped", counter: this.counter });
      return this.counter;
    }`,
    null
  );
  expect(installed.ok).toBe(true);
  // Both actors stand in the room (genesis placement).
  for (const [id, actor] of [["leak-place-a", a], ["leak-place-b", b]] as const) {
    const sess = world.primarySessionForActor(actor)?.id;
    const placed = await world.directCall(id, actor, actor, "moveto", ["leak_room"], { sessionId: sess });
    expect(placed.op).toBe("result");
  }
  // Vector 2 (live_audience): install AFTER placement (so it can't perturb
  // the genesis moveto's observation routing) a native verb bound to
  // space_live_audience, which returns liveSessionIdsIn(space) — raw bearer
  // session ids. Bundled catalogs bind this handler and it is
  // direct_callable, so a co-present guest can invoke
  // `leak_room:live_audience()` over /net-api/turn. This reproduces whether
  // the NET planning slice actually exposes peer sessions to the caller.
  world.addVerb("leak_room", {
    kind: "native",
    name: "live_audience",
    aliases: [],
    owner: "$wiz",
    perms: "rxd",
    arg_spec: { command: { dobj: "this", prep: "any", iobj: "any", args_from: [] }, args: ["observation?"] },
    source: "verb :live_audience(observation) rxd { return []; }",
    source_hash: "leak-live-audience",
    version: 1,
    line_map: {},
    native: "space_live_audience",
    direct_callable: true
  } as never);
  world.ensureApiKey("$wiz", a, KEY_A.id, KEY_A.secret, "net-leak-a");
  world.ensureApiKey("$wiz", b, KEY_B.id, KEY_B.secret, "net-leak-b");

  const partitions = partitionCells(cellsFromSerialized(world.exportWorld()));
  partitions.set(CATALOG_SCOPE, [...(partitions.get(CATALOG_SCOPE) ?? []), netActivationCell(EPOCH)]);

  const scopeDOs = new Map<string, NetScopeDO>();
  const gateways = new Map<string, NetGatewayDO>();
  const resolve = (destination: string) => {
    if (destination.startsWith("scope:")) {
      const instance = scopeDOs.get(destination.slice("scope:".length));
      if (!instance) throw new Error(`unresolvable destination ${destination}`);
      return instance;
    }
    if (destination.startsWith("gateway:")) {
      const instance = gateways.get(destination.slice("gateway:".length));
      if (!instance) throw new Error(`unresolvable destination ${destination}`);
      return instance;
    }
    throw new Error(`unresolvable destination ${destination}`);
  };
  const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve };
  const states: Array<ReturnType<typeof netState>> = [];
  const signedTo = async (instance: NetScopeDO, path: string, body: unknown) => {
    const req = new Request(`https://do${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return instance.fetch(await signInternalRequest(scopeEnv, req));
  };
  for (const scope of [...partitions.keys()]) {
    const st = netState(`scope-${scope}`);
    const instance = new NetScopeDO(st.state, scopeEnv);
    const seeded = await signedTo(instance, "/net/seed", { scope, catalog_epoch: EPOCH, cells: partitions.get(scope) ?? [] });
    expect(seeded.ok, `seed ${scope}`).toBe(true);
    states.push(st);
    scopeDOs.set(scope, instance);
  }
  // The gateway is registered both under the test's route label and under
  // its own shard name (`shardName()` derives from the DO id), so the room
  // scope's presence fanout (addressed `gateway:<shard>` by selfSubscribe)
  // resolves back to it — the production co-presence delivery path.
  const gatewayState = netState("gateway-leak");
  const gatewayEnv: NetGatewayEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve, NET_GATEWAY_SELF: "gateway:net-api" };
  const gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);
  gateways.set("net-api", gateway);
  states.push(gatewayState);

  const settleAll = async () => {
    for (const st of states) await st.settle();
  };

  return {
    gateway,
    a,
    b,
    tokenA: `apikey:${KEY_A.id}:${KEY_A.secret}`,
    tokenB: `apikey:${KEY_B.id}:${KEY_B.secret}`,
    settleAll,
    close: () => states.forEach((st) => st.close())
  };
}

/** Mint a session and take a turn: warms the room into the shared gateway
 * view and lands the actor's CO13 session_presence row in the mirror. */
async function joinAndAct(
  h: Awaited<ReturnType<typeof buildHarness>>,
  token: string
): Promise<string> {
  const mint = await clientFetch(h.gateway, "POST", "/net-api/session", { token, body: { ttl_ms: 600_000 } });
  expect(mint.status, JSON.stringify(mint.body)).toBe(200);
  const sid = mint.body.session as string;
  const bump = await clientFetch(h.gateway, "POST", "/net-api/turn", { token, body: { target: "leak_box", verb: "bump", session: sid } });
  expect(bump.status, JSON.stringify(bump.body)).toBe(200);
  await h.settleAll();
  return sid;
}

/** Deep scan for any string that looks like the victim's session id, or a
 * session-cell shape, anywhere in an arbitrary JSON value. */
function containsSessionId(value: unknown, sessionId: string): boolean {
  if (typeof value === "string") return value === sessionId;
  if (Array.isArray(value)) return value.some((v) => containsSessionId(v, sessionId));
  if (value && typeof value === "object") return Object.values(value).some((v) => containsSessionId(v, sessionId));
  return false;
}

function containsSessionCell(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSessionCell);
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    // A session cell value carries {id, actor, started/expiresAt/...}.
    if (typeof rec.id === "string" && typeof rec.actor === "string" && ("started" in rec || "expiresAt" in rec || "activeScope" in rec)) {
      return true;
    }
    if ("session" in rec && rec.session && typeof rec.session === "object") return true;
    return Object.values(rec).some(containsSessionCell);
  }
  return false;
}

describe("net session bearer-token leak (P0)", () => {
  it("REGRESSION: a co-present guest cannot read a session-keyed presence property cell", async () => {
    const h = await buildHarness();
    const sidA = await joinAndAct(h, h.tokenA);
    const sidB = await joinAndAct(h, h.tokenB);

    const key = "property_cell:leak_room:session_subscribers";
    const read = await clientFetch(
      h.gateway,
      "GET",
      `/net-api/cell?session=${encodeURIComponent(sidA)}&key=${encodeURIComponent(key)}`,
      { token: h.tokenA }
    );

    // On vulnerable code this is 200 and the cell value contains both
    // {session:sidA, actor:A} and {session:sidB, actor:B}. The generic
    // definition-driven guard now refuses every presence/key=session
    // property regardless of its catalog-defined name.
    expect(read.status, JSON.stringify(read.body)).toBe(403);
    expect(containsSessionId(read.body, sidA), JSON.stringify(read.body)).toBe(false);
    expect(containsSessionId(read.body, sidB), JSON.stringify(read.body)).toBe(false);

    h.close();
  });

  it("REGRESSION (was EXPLOIT): a co-present guest CANNOT enumerate a peer's bearer token via /net-api/relation", async () => {
    // The reproduced attack, now permanently guarded. On the VULNERABLE
    // code this exact read returned `members[].member === sidB` (the
    // bearer id) plus `body.session` (the session cell), and
    // `Bearer session:<sidB>` then authenticated as B — account takeover.
    // Post-fix the surface exposes only actor-level roster data, so the
    // theft below fails at the enumeration step.
    const h = await buildHarness();

    // Two guests join the same room via the real client path — each turn
    // lands its CO13 session_presence row in the shared gateway mirror.
    const sidA = await joinAndAct(h, h.tokenA);
    const sidB = await joinAndAct(h, h.tokenB);
    expect(sidA).not.toBe(sidB);

    // THE THEFT ATTEMPT: guest A, standing in the room, reads the presence
    // relation, trying to harvest B's bearer session id.
    const read = await clientFetch(
      h.gateway,
      "GET",
      `/net-api/relation?session=${sidA}&relation=session_presence&owner=leak_room`,
      { token: h.tokenA }
    );
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const members = read.body.members as Array<{ member: string; body?: unknown }>;

    // CLOSURE: B's bearer id is NOT enumerable — not as a `member`, not
    // anywhere in the payload — and no session cell leaks either.
    expect(members.map((m) => m.member), JSON.stringify(members)).not.toContain(sidB);
    expect(containsSessionId(read.body, sidB), JSON.stringify(read.body)).toBe(false);
    expect(containsSessionId(read.body, sidA), JSON.stringify(read.body)).toBe(false);
    expect(containsSessionCell(read.body.members), JSON.stringify(read.body)).toBe(false);

    // And the identifiers A CAN now see (actor ids) do not authenticate as
    // bearer sessions: presenting `Bearer session:<peer actor>` is refused.
    const takeover = await clientFetch(h.gateway, "POST", "/net-api/turn", {
      token: `session:${h.b}`,
      body: { target: "leak_box", verb: "bump" }
    });
    expect(takeover.status, JSON.stringify(takeover.body)).toBe(401);

    h.close();
  });

  it("CLOSURE: A's presence read carries only actor-level data — no session id or cell anywhere; the peer's token cannot be stolen", async () => {
    const h = await buildHarness();

    const sidA = await joinAndAct(h, h.tokenA);
    const sidB = await joinAndAct(h, h.tokenB);

    const presence = await clientFetch(
      h.gateway,
      "GET",
      `/net-api/relation?session=${sidA}&relation=session_presence&owner=leak_room`,
      { token: h.tokenA }
    );
    expect(presence.status, JSON.stringify(presence.body)).toBe(200);

    // CLOSURE: neither peer's session id may appear anywhere in what A
    // receives, and no session-cell-shaped object may leak either.
    expect(containsSessionId(presence.body, sidB), JSON.stringify(presence.body)).toBe(false);
    expect(containsSessionId(presence.body, sidA), JSON.stringify(presence.body)).toBe(false);
    expect(containsSessionCell(presence.body.members), JSON.stringify(presence.body)).toBe(false);

    // A forged session bearer built from the peer's ACTOR id (the only
    // identifier A can now see) is refused — the actor is not a session.
    const forged = await clientFetch(h.gateway, "POST", "/net-api/turn", {
      token: `session:${h.b}`,
      body: { target: "leak_box", verb: "bump" }
    });
    expect(forged.status).toBe(401);

    // Legit presence still works: A sees B as an actor with a display name.
    const members = presence.body.members as Array<{ member: string; body?: Record<string, unknown> }>;
    const forB = members.find((m) => m.member === h.b || (m.body && m.body.actor === h.b));
    expect(forB, JSON.stringify(members)).toBeTruthy();
    const name = forB?.body?.name as string | undefined;
    expect(typeof name === "string" && name.length > 0, JSON.stringify(forB)).toBe(true);
    expect(name).not.toBe(sidB);

    h.close();
  });

  it("VECTOR 2 (live_audience): a net turn does NOT disclose a co-present peer's bearer", async () => {
    // spaceLiveAudience returns liveSessionIdsIn(space) = raw bearer session
    // ids. The question this reproduces: over the NET path, does guest A's
    // planning slice hold peer B's session (owned by cluster:B) such that
    // the native handler enumerates B's bearer? If yes, live_audience() is a
    // second account-takeover vector; if no (peer sessions never enter A's
    // slice), the surface is safe and this is the permanent guard.
    const h = await buildHarness();
    const sidA = await joinAndAct(h, h.tokenA);
    const sidB = await joinAndAct(h, h.tokenB);
    expect(sidA).not.toBe(sidB);

    const res = await clientFetch(h.gateway, "POST", "/net-api/turn", {
      token: h.tokenA,
      body: { target: "leak_room", verb: "live_audience", args: [], session: sidA }
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // FINDING: safe over net for TWO independent reasons.
    // (1) space_live_audience is NOT transcript-tracked
    //     (native-primitive-contract), so a client turn invoking it commits
    //     as `rejected: incomplete_transcript` — it returns NO result, so it
    //     cannot hand back session ids. We assert that rejection to lock the
    //     property: if someone ever makes it tracked+committing, this fails
    //     loudly and the containsSessionId guard below becomes load-bearing.
    // (2) Even if it ran, peer B's session cell is owned by cluster:B and is
    //     never pulled into A's turn planning slice, so liveSessionIdsIn
    //     would see only A's own session.
    const reply = res.body.reply as { status?: string; reason?: string } | undefined;
    expect(reply?.status, JSON.stringify(res.body)).toBe("rejected");
    expect(reply?.reason, JSON.stringify(res.body)).toBe("incomplete_transcript");
    // The security invariant regardless of mechanism: B's bearer never
    // appears anywhere in what A receives.
    expect(containsSessionId(res.body, sidB), JSON.stringify(res.body)).toBe(false);

    h.close();
  });
});
