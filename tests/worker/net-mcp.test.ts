// Client-shell phase i: the MCP adapter over /net-api (fake-DO lane).
// The walkthrough scenario's client contract — initialize with an
// mcp-token, notifications/initialized, woo_list_reachable_tools for
// actor resolution, woo_call for verbs, woo_wait for cross-actor
// observations — driven end-to-end against the INSTALLED world with two
// carried (apikey) actors born present in the chatroom.
import { describe, expect, it, vi } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { createWorld } from "../../src/core/bootstrap";
import { exportIdentity, importIdentity } from "../../src/net/identity";
import { planNetInstall } from "../../src/net/install";
import { cellVersion } from "../../src/net/cells";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { turnEchoId } from "../../src/net/turn-echo";

const SECRET = "net-mcp-test-secret";

function netState(name: string) {
  const fake = new FakeDurableObjectState(name);
  const deferred: Array<Promise<unknown>> = [];
  const state: NetScopeDurableState & NetGatewayDurableState = {
    id: fake.id,
    waitUntil: (promise: Promise<unknown>) => {
      deferred.push(promise);
    },
    storage: {
      sql: fake.storage.sql,
      transactionSync: fake.storage.transactionSync,
      setAlarm: () => {},
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

type Rpc = { jsonrpc: "2.0"; id?: number; method: string; params?: unknown };

describe("MCP adapter over /net-api (client-shell phase i)", () => {
  it("two carried actors: initialize, resolve self, say → peer woo_wait, command_plan round trip, error envelope", async () => {
    // OLD world: two guests, one apikey each.
    const old = createWorld();
    const alice = old.auth("guest:mcp-alice").actor;
    const bob = old.auth("guest:mcp-bob").actor;
    old.ensureApiKey("$wiz", alice, "mcp-key-a", "mcp-secret-a", "alice");
    old.ensureApiKey("$wiz", bob, "mcp-key-b", "mcp-secret-b", "bob");
    const identity = exportIdentity(old.exportWorld());
    const plan = await planNetInstall({ graft: (fresh) => importIdentity(fresh, identity) });

    // Seed every partition; the gateway self-resolves for subscriptions.
    const states: Array<ReturnType<typeof netState>> = [];
    const scopeStates = new Map<string, ReturnType<typeof netState>>();
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
    for (const [scope, cells] of plan.partitions) {
      const st = netState(`scope-${scope}`);
      const instance = new NetScopeDO(st.state, scopeEnv);
      const request = new Request("https://do/net/seed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, catalog_epoch: plan.epoch, cells, relations: plan.relations.get(scope) ?? [] })
      });
      const seeded = await instance.fetch(await signInternalRequest(scopeEnv, request));
      expect(seeded.ok, `seed ${scope}`).toBe(true);
      states.push(st);
      scopeStates.set(scope, st);
      scopeDOs.set(scope, instance);
    }
    const gatewayState = netState("gateway-net-api");
    states.push(gatewayState);
    const gatewayEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: resolve,
      NET_GATEWAY_SELF: "gateway:net-api"
    } as NetGatewayEnv;
    gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);

    const settleAll = async () => {
      for (const st of states) await st.settle();
      // Incoming adopt/relate deliveries continue from a fresh alarm
      // event, matching production's CF subrequest-depth boundary.
      for (const scope of scopeDOs.values()) await scope.alarm();
      for (const st of states) await st.settle();
    };

    let nextId = 10;
    const mcp = async (body: Rpc, headers: Record<string, string> = {}): Promise<{ status: number; headers: Headers; body: Record<string, any> | null }> => {
      const response = await gateway.fetch(
        new Request("https://do/net-api/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body)
        })
      );
      const text = await response.text();
      return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
    };
    const open = async (token: string): Promise<string> => {
      const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { "mcp-token": token });
      expect(init.status, JSON.stringify(init.body)).toBe(200);
      const session = init.headers.get("mcp-session-id");
      expect(session).toBeTruthy();
      const notified = await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": session as string });
      expect(notified.status).toBe(202);
      return session as string;
    };
    const call = async (session: string, name: string, args: Record<string, unknown>) =>
      (await mcp(
        { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } },
        { "mcp-session-id": session }
      )).body as Record<string, any>;
    const close = async (session: string) => await gateway.fetch(
      new Request("https://do/net-api/mcp", { method: "DELETE", headers: { "mcp-session-id": session } })
    );

    const aliceSession = await open("apikey:mcp-key-a:mcp-secret-a");
    const bobSession = await open("apikey:mcp-key-b:mcp-secret-b");
    await settleAll(); // mint fanout + presence relate settle

    // Actor resolution — the smoke SmokeSession.open contract: a guest_*
    // object carrying an actor-control verb (wait) in the tool list.
    const tools = await call(aliceSession, "woo_list_reachable_tools", { scope: "all", limit: 200 });
    const list = tools.result?.structuredContent?.result?.tools ?? [];
    const self = list.find((tool: any) => typeof tool?.object === "string" && /^guest_/.test(tool.object) && tool.verb === "wait");
    expect(self?.object, JSON.stringify(list.slice(0, 12))).toBe(alice);

    // Cross-actor: alice says; bob's woo_wait sees it (presence-routed
    // fanout → the MCP queue; both sessions born present in the room).
    const said = await call(aliceSession, "woo_call", { object: "the_chatroom", verb: "say", args: ["hello bob mcp-run"] });
    expect(said.result?.isError, JSON.stringify(said)).not.toBe(true);
    const ownTurnId = [...((gateway as any).recentClientTurns as Map<string, string>).keys()].at(-1);
    expect(ownTurnId).toMatch(/^mcp:/);
    await settleAll();
    const waited = await call(bobSession, "woo_wait", { timeout_ms: 0 });
    const observations = waited.result?.structuredContent?.result?.observations ?? [];
    const match = observations.find(
      (obs: any) => obs?.type === "said" && typeof obs.text === "string" && obs.text.includes("hello bob mcp-run")
    );
    expect(match, JSON.stringify(observations).slice(0, 400)).toBeTruthy();

    // The session-local echo guard remains after the shared recent-turn LRU
    // is lost (cap/eviction). A delayed self fanout must not leak into wait.
    ((gateway as any).recentClientTurns as Map<string, string>).clear();
    (gateway as any).pushObservations({
      scope: "room:the_chatroom",
      seq: 999,
      echo_id: turnEchoId(String(ownTurnId)),
      observations: [{ type: "looked", to: alice, text: "delayed self echo" }]
    });
    const ownWait = await call(aliceSession, "woo_wait", { timeout_ms: 0 });
    expect(ownWait.result?.structuredContent?.result?.observations ?? []).toEqual([]);

    // The thin-shell command round trip: plan then execute.
    const planned = await call(aliceSession, "woo_call", { object: "the_chatroom", verb: "command_plan", args: ["look"] });
    const cmd = planned.result?.structuredContent?.result as { ok?: boolean; target?: string; verb?: string; args?: unknown[] };
    expect(cmd?.ok).toBe(true);
    const executed = await call(aliceSession, "woo_call", { object: cmd.target as string, verb: cmd.verb as string, args: cmd.args ?? [] });
    expect(executed.result?.isError, JSON.stringify(executed).slice(0, 300)).not.toBe(true);

    // Error envelope: an unknown verb surfaces isError (unwrap() throws).
    const missing = await call(aliceSession, "woo_call", { object: "the_chatroom", verb: "no_such_verb_xyz", args: [] });
    expect(missing.result?.isError).toBe(true);

    // Catalog-qualified references are installer syntax, not runtime object
    // ids. Pin the MCP adapter's error envelope as well as the shared REST
    // refusal so this transport cannot regress back to E_BUDGET repair.
    const invalidTarget = await call(aliceSession, "woo_call", {
      object: "tasks:the_taskboard",
      verb: "listing",
      args: []
    });
    expect(invalidTarget.result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "E_INVARG",
          detail: { field: "target", reason: "invalid_object_id" }
        }
      }
    });

    // Cross-room move: the walkthrough's acid test (left/entered fanout).
    const entered = await call(aliceSession, "woo_call", { object: "the_chatroom", verb: "enter", args: [] });
    expect(entered.result?.isError, JSON.stringify(entered).slice(0, 400)).not.toBe(true);
    await settleAll();
    const moved = await call(aliceSession, "woo_call", { object: "the_chatroom", verb: "southeast", args: [] });
    expect(moved.result?.isError, JSON.stringify(moved).slice(0, 600)).not.toBe(true);
    await settleAll();
    const waitedMove = await call(bobSession, "woo_wait", { timeout_ms: 0 });
    const moveObs = waitedMove.result?.structuredContent?.result?.observations ?? [];
    const left = moveObs.find((obs: any) => obs?.type === "left" && obs.actor === alice);
    expect(left, JSON.stringify(moveObs).slice(0, 400)).toBeTruthy();

    // take/drop: room-committed contents change with cross-actor fanout.
    const back = await call(aliceSession, "woo_call", { object: "the_deck", verb: "west", args: [] });
    expect(back.result?.isError, JSON.stringify(back).slice(0, 300)).not.toBe(true);
    await settleAll();
    await call(bobSession, "woo_wait", { timeout_ms: 0 }); // drain the entered
    const took = await call(aliceSession, "woo_call", { object: "the_chatroom", verb: "take", args: ["mug"] });
    expect(took.result?.isError, JSON.stringify(took).slice(0, 400)).not.toBe(true);
    await settleAll();
    const waitedTake = await call(bobSession, "woo_wait", { timeout_ms: 0 });
    const takeObs = waitedTake.result?.structuredContent?.result?.observations ?? [];
    const taken = takeObs.find((obs: any) => obs?.type === "taken" && obs.actor === alice);
    expect(taken, JSON.stringify(takeObs).slice(0, 400)).toBeTruthy();

    // Aged gateway regression: lineage and the inherited `$room.exits = {}`
    // default are warm, the room's explicit exits page is absent, AND the
    // cached `$player:ways` page predates its authority-prefetch metadata.
    // The catalog pull must subscribe this gateway and replace that stale
    // page before the call; otherwise an already-committed definition repair
    // is invisible and this falsely reports "No obvious exits" until an
    // unrelated movement happens to warm one edge.
    gatewayState.state.storage.sql.exec(
      "DELETE FROM net_gateway_cell WHERE key = 'property_cell:the_chatroom:exits'"
    );
    const waysRows = Array.from(
      gatewayState.state.storage.sql.exec(
        "SELECT body FROM net_gateway_cell WHERE key = 'verb_bytecode:$player:ways'"
      ) as Iterable<{ body: string }>
    );
    expect(waysRows).toHaveLength(1);
    const staleWays = JSON.parse(waysRows[0].body);
    delete staleWays.value.arg_spec.authority;
    staleWays.version = cellVersion(staleWays.value);
    gatewayState.state.storage.sql.exec(
      "UPDATE net_gateway_cell SET body = ? WHERE key = 'verb_bytecode:$player:ways'",
      JSON.stringify(staleWays)
    );
    gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);
    const agedWays = await call(aliceSession, "woo_call", { object: alice, verb: "ways", args: [""] });
    expect(agedWays.result?.isError, JSON.stringify(agedWays).slice(0, 800)).not.toBe(true);
    const waysResult = agedWays.result?.structuredContent?.result as { exits?: string[]; text?: string };
    expect(waysResult.exits).toEqual(expect.arrayContaining([
      "exit_living_room_southeast",
      "exit_living_room_south",
      "exit_living_room_outline",
      "exit_living_room_dubspace"
    ]));
    expect(waysResult.exits).toHaveLength(4);
    expect(waysResult.text).toContain("Obvious exits:");

    // Once the exact room.exits page is warm, repeated read-only commands must
    // use the fanout-coherent gateway copy instead of paying another blocking
    // owner /closure RPC for every declared path cursor.
    const fetchSpies = [...scopeDOs.values()].map((scope) => vi.spyOn(scope, "fetch"));
    const warmWays = await call(aliceSession, "woo_call", { object: alice, verb: "ways", args: [""] });
    expect(warmWays.result?.isError, JSON.stringify(warmWays).slice(0, 800)).not.toBe(true);
    const closureReads = fetchSpies.flatMap((spy) => spy.mock.calls)
      .filter(([request]) => new URL((request as Request).url).pathname === "/closure");
    for (const spy of fetchSpies) spy.mockRestore();
    expect(closureReads, "a warm ways call should not synchronously refresh explicit path cells").toEqual([]);
    const catalogState = scopeStates.get("catalog");
    expect(catalogState).toBeTruthy();
    const catalogSubscribers = Array.from(
      catalogState!.state.storage.sql.exec(
        "SELECT destination FROM net_scope_subscribers WHERE role = 'fanout' AND destination = 'gateway:net-api'"
      ) as Iterable<{ destination: string }>
    );
    expect(catalogSubscribers).toEqual([{ destination: "gateway:net-api" }]);

    // Streamable HTTP DELETE releases the underlying net session. The
    // session id is the bearer, so it refuses after the close protocol's
    // 250ms in-flight grace (the same contract as browser logout).
    expect((await close(bobSession)).status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterClose = await call(bobSession, "woo_wait", { timeout_ms: 0 });
    expect(afterClose).toMatchObject({ error: { message: expect.stringMatching(/session (expired|missing)/) } });

    states.forEach((st) => st.close());
  });
});
