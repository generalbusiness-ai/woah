// Client-shell phase i: the MCP adapter over /net-api (fake-DO lane).
// The walkthrough scenario's client contract — initialize with an
// mcp-token, notifications/initialized, woo_list_reachable_tools for
// actor resolution, woo_call for verbs, woo_wait for cross-actor
// observations — driven end-to-end against the INSTALLED world with two
// carried (apikey) actors born present in the chatroom.
import { describe, expect, it, vi } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { createWorld } from "../../src/core/bootstrap";
import { installVerb } from "../../src/core/authoring";
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
    let taskRef = "";
    const identity = exportIdentity(old.exportWorld());
    const plan = await planNetInstall({
      graft: async (fresh) => {
        importIdentity(fresh, identity);
        const commandOnly = {
          argSpec: { command: { dobj: "none", prep: "any", iobj: "any", args_from: [] } }
        };
        expect(installVerb(
          fresh,
          alice,
          "command_only_probe",
          "verb :command_only_probe() rxd { return true; }",
          null,
          commandOnly
        ).ok).toBe(true);
        expect(installVerb(
          fresh,
          "the_mug",
          "command_only_probe",
          "verb :command_only_probe() rxd { return true; }",
          null,
          commandOnly
        ).ok).toBe(true);
        const seededPolicy = await fresh.directCall(
          "mcp-seed-policy",
          "$wiz",
          "the_taskboard",
          "seed_minimal_policy",
          [alice],
          { forceDirect: true, forceReason: "test fixture" }
        );
        expect(seededPolicy.op).toBe("result");
        const createdTask = await fresh.directCall(
          "mcp-create-context-task",
          alice,
          "the_taskboard",
          "create_task",
          ["task", "Context navigation", "Exercise structural MCP context", [], null],
          { forceDirect: true, forceReason: "test fixture" }
        );
        expect(createdTask.op).toBe("result");
        taskRef = createdTask.op === "result" ? String(createdTask.result) : "";
      }
    });
    expect(taskRef).toBeTruthy();
    const commandOnlyPage = [...plan.partitions.values()].flat().find((cell) =>
      cell.kind === "verb_bytecode"
      && cell.object === "the_mug"
      && cell.name === "command_only_probe"
    );
    expect(commandOnlyPage?.value).toMatchObject({
      arg_spec: { command: { args_from: [] } },
      tool_exposed: undefined
    });
    const taskClaimTool = `${taskRef.replace(/^\$/, "").replace(/[^a-zA-Z0-9_]/g, "_")}__claim`;
    const taskPassTool = `${taskRef.replace(/^\$/, "").replace(/[^a-zA-Z0-9_]/g, "_")}__pass`;

    // Seed every partition; the gateway self-resolves for subscriptions.
    const states: Array<ReturnType<typeof netState>> = [];
    const scopeStates = new Map<string, ReturnType<typeof netState>>();
    const scopeDOs = new Map<string, NetScopeDO>();
    const resolvedDestinations: string[] = [];
    let gateway: NetGatewayDO;
    const resolve = (destination: string) => {
      resolvedDestinations.push(destination);
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

    // Protocol methods use protocol result shapes. In particular, the MCP
    // SDK validates tools/list as {result:{tools:[...]}}; the tools/call
    // content/structuredContent envelope is not valid here.
    const listed = await mcp(
      { jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} },
      { "mcp-session-id": aliceSession }
    );
    const initialToolNames = listed.body?.result?.tools?.map((tool: { name: string }) => tool.name) ?? [];
    expect(initialToolNames).toEqual(expect.arrayContaining([
      "woo_call",
      "woo_list_reachable_tools",
      "woo_wait",
      "the_chatroom__look",
      "the_chatroom__say",
      "the_cockatoo__squawk"
    ]));
    // A co-present person is social context, not an object administration
    // target. Room say/tell remains the interaction path.
    expect(initialToolNames.some((name: string) => name.startsWith(`${bob}__`))).toBe(false);
    expect(initialToolNames.some((name: string) => /^guest_[2-8]__/.test(name))).toBe(false);
    expect(initialToolNames).not.toContain(`${alice}__command_only_probe`);
    const waitDefinition = listed.body?.result?.tools?.find((tool: { name: string }) => tool.name === "woo_wait");
    expect(waitDefinition?.inputSchema?.properties).toMatchObject({
      timeout_ms: { type: "number" },
      limit: { type: "number" }
    });
    const sayDefinition = listed.body?.result?.tools?.find((tool: { name: string }) => tool.name === "the_chatroom__say");
    expect(sayDefinition?.inputSchema).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"]
    });

    const discoveredPage = await call(aliceSession, "woo_list_reachable_tools", {
      scope: "active",
      query: "squawk",
      limit: 1,
      include_schema: true
    });
    expect(discoveredPage.result?.structuredContent?.result).toMatchObject({
      scope: "active",
      query: "squawk",
      limit: 1,
      cursor: null,
      total: expect.any(Number),
      tools: [expect.objectContaining({
        name: "the_cockatoo__squawk",
        object: "the_cockatoo",
        verb: "squawk",
        input_schema: expect.objectContaining({ type: "object" })
      })]
    });
    const commandOnlyDiscovery = await call(aliceSession, "woo_list_reachable_tools", {
      scope: "active",
      query: "command_only_probe",
      limit: 10
    });
    const commandOnlyNames = (commandOnlyDiscovery.result?.structuredContent?.result?.tools ?? [])
      .map((tool: { name: string }) => tool.name);
    expect(commandOnlyNames).toContain("the_mug__command_only_probe");
    expect(commandOnlyNames).not.toContain(`${alice}__command_only_probe`);

    // A dangling contextual row gets one targeted probe and then enters the
    // bounded retry gate; repeated model listings do not create a read storm.
    gatewayState.state.storage.sql.exec(
      "INSERT INTO net_gateway_relation (key, relation, owner, member, body, owner_scope, member_scope) VALUES (?, 'contents', 'the_chatroom', 'dangling_context_fixture', NULL, 'room:the_chatroom', 'room:dangling_context_fixture')",
      "relation:contents:the_chatroom:dangling_context_fixture"
    );
    const missingScopeBefore = resolvedDestinations.filter((value) => value === "scope:room:dangling_context_fixture").length;
    await mcp(
      { jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} },
      { "mcp-session-id": aliceSession }
    );
    await mcp(
      { jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} },
      { "mcp-session-id": aliceSession }
    );
    const missingScopeAfter = resolvedDestinations.filter((value) => value === "scope:room:dangling_context_fixture").length;
    expect(missingScopeAfter - missingScopeBefore).toBe(1);
    gatewayState.state.storage.sql.exec(
      "DELETE FROM net_gateway_relation WHERE key = ?",
      "relation:contents:the_chatroom:dangling_context_fixture"
    );

    // Actor resolution remains explicit in initialize instructions and in the
    // contextual discovery descriptors; native actor controls are not
    // advertised as dynamic Net tools because they have no portable bytecode.
    const tools = await call(aliceSession, "woo_list_reachable_tools", { scope: "all", limit: 200 });
    const list = tools.result?.structuredContent?.result?.tools ?? [];
    const self = list.find((tool: any) => tool?.object === alice);
    expect(self?.object, JSON.stringify(list.slice(0, 12))).toBe(alice);

    // Dynamic-name invocation uses the same descriptor and authoritative turn
    // path as woo_call; no focus step is involved.
    const squawked = await call(aliceSession, "the_cockatoo__squawk", {});
    expect(squawked.result?.isError, JSON.stringify(squawked)).not.toBe(true);

    // The stable wait contract is bounded: a caller can consume part of a
    // burst without discarding the remainder from its session-local queue.
    (gateway as any).mcpEnqueue(bobSession, [{ marker: "first" }, { marker: "second" }]);
    const firstWait = await call(bobSession, "woo_wait", { timeout_ms: 0, limit: 1 });
    expect(firstWait.result?.structuredContent?.result?.observations).toEqual([{ marker: "first" }]);
    const secondWait = await call(bobSession, "woo_wait", { timeout_ms: 0, limit: 1 });
    expect(secondWait.result?.structuredContent?.result?.observations).toEqual([{ marker: "second" }]);

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

    // A globally known task is not callable until it is in this session's
    // structural context. woo_call is not an object-id escape hatch.
    const unreachableTask = await call(aliceSession, "woo_call", { object: taskRef, verb: "claim", args: [] });
    expect(unreachableTask.result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "E_PERM" } }
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

    // Structural navigation replaces focus choreography. Walk through the
    // garden to the task board; its contained task immediately contributes
    // dynamic lifecycle tools.
    const toGarden = await call(aliceSession, "woo_call", { object: "the_deck", verb: "south", args: [] });
    expect(toGarden.result?.isError, JSON.stringify(toGarden).slice(0, 400)).not.toBe(true);
    await settleAll();
    const toTasks = await call(aliceSession, "woo_call", { object: "the_garden", verb: "south", args: [] });
    expect(toTasks.result?.isError, JSON.stringify(toTasks).slice(0, 400)).not.toBe(true);
    await settleAll();
    const atTaskboard = await mcp(
      { jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} },
      { "mcp-session-id": aliceSession }
    );
    const taskboardNames = atTaskboard.body?.result?.tools?.map((tool: { name: string }) => tool.name) ?? [];
    expect(taskboardNames).toContain(taskClaimTool);
    expect(taskboardNames).not.toContain("the_cockatoo__squawk");
    expect(taskboardNames.some((name: string) => name === "woo_focus" || name.endsWith("__focus"))).toBe(false);

    const claimed = await call(aliceSession, taskClaimTool, {});
    expect(claimed.result?.isError, JSON.stringify(claimed).slice(0, 600)).not.toBe(true);
    await settleAll();
    const outToGarden = await call(aliceSession, "woo_call", { object: "the_taskboard", verb: "out", args: [] });
    expect(outToGarden.result?.isError, JSON.stringify(outToGarden).slice(0, 400)).not.toBe(true);
    await settleAll();
    const afterClaimMove = await mcp(
      { jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} },
      { "mcp-session-id": aliceSession }
    );
    const inventoryNames = afterClaimMove.body?.result?.tools?.map((tool: { name: string }) => tool.name) ?? [];
    expect(inventoryNames).toContain(taskPassTool);

    // Return to the living room for the existing take/drop scenario.
    const gardenNorth = await call(aliceSession, "woo_call", { object: "the_garden", verb: "north", args: [] });
    expect(gardenNorth.result?.isError, JSON.stringify(gardenNorth).slice(0, 400)).not.toBe(true);
    await settleAll();

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
    const listAfterClose = await mcp(
      { jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} },
      { "mcp-session-id": bobSession }
    );
    expect(listAfterClose.body).toMatchObject({ error: { message: expect.stringMatching(/session (expired|missing)/) } });

    states.forEach((st) => st.close());
  });
});
