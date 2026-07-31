// The COLLAPSED MCP profile (mcp.md §M9), fake-DO lane against the installed
// demo world.
//
// Every assertion here is pinned to a measurement in
// notes/2026-07-29-mcp-world-navigation-usability.md, so a regression shows up
// as a number that stopped matching rather than as a vague "the surface feels
// large". The world is the seeded Living Room: the actor stands in
// `the_chatroom` alongside two mounted workspaces it is in neither of.
import { describe, expect, it } from "vitest";
import { createWorld } from "../../src/core/bootstrap";
import { exportIdentity, importIdentity } from "../../src/net/identity";
import { planNetInstall } from "../../src/net/install";
import { NetGatewayDO, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { quiescentNetState as netState, settleAll as settleHosts, type QuiescentHost } from "./quiescent-do";

const SECRET = "net-mcp-collapsed-secret";
const ACTOR = "collapse_agent";
const KEY = "apikey:collapse-key:collapse-secret";

type Rpc = { jsonrpc: "2.0"; id?: number; method: string; params?: unknown };
type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };

/** One installed world plus a gateway, with an MCP helper bound to it. */
async function bootWorld() {
  const old = createWorld();
  old.createObject({ id: ACTOR, name: "Collapse Agent", parent: "$player", owner: "$wiz", location: "$nowhere" });
  old.ensureApiKey("$wiz", ACTOR, "collapse-key", "collapse-secret", "ck");
  const identity = exportIdentity(old.exportWorld());
  const plan = await planNetInstall({ graft: async (fresh) => { importIdentity(fresh, identity); } });

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
  for (const [scope, cells] of plan.partitions) {
    const st = netState(`scope-${scope}`);
    const instance = new NetScopeDO(st.state, scopeEnv);
    const seeded = await instance.fetch(await signInternalRequest(scopeEnv, new Request("https://do/net/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, catalog_epoch: plan.epoch, cells, relations: plan.relations.get(scope) ?? [] })
    })));
    expect(seeded.ok, `seed ${scope}`).toBe(true);
    states.push(st);
    scopeDOs.set(scope, instance);
  }
  const gatewayState = netState("gateway-net-api");
  states.push(gatewayState);
  gateway = new NetGatewayDO(gatewayState.state, {
    WOO_INTERNAL_SECRET: SECRET,
    NET_RESOLVE: resolve,
    NET_GATEWAY_SELF: "gateway:net-api"
  } as NetGatewayEnv);

  const settle = async () => {
    await settleHosts(states);
    for (const scope of scopeDOs.values()) await scope.alarm();
    await settleHosts(states);
  };

  let nextId = 100;
  const mcp = async (body: Rpc, headers: Record<string, string> = {}) => {
    const response = await gateway.fetch(new Request("https://do/net-api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body)
    }));
    const text = await response.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: response.status, headers: response.headers, body: (text ? JSON.parse(text) : null) as any };
  };

  /** Open a session under one profile. `profile: null` is the classic default. */
  const open = async (profile: "collapsed" | null) => {
    const extra: Record<string, string> = profile ? { "woo-mcp-profile": profile } : {};
    const init = await mcp(
      { jsonrpc: "2.0", id: nextId++, method: "initialize", params: {} },
      { "mcp-token": KEY, ...extra }
    );
    expect(init.status, JSON.stringify(init.body)).toBe(200);
    const session = init.headers.get("mcp-session-id") as string;
    expect(session).toBeTruthy();
    await settle();
    const call = (body: Rpc) => mcp(body, { "mcp-session-id": session, ...extra });
    const tools = async (): Promise<Tool[]> => {
      const collected: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await call({ jsonrpc: "2.0", id: nextId++, method: "tools/list", params: cursor ? { cursor } : {} });
        expect(page.status, JSON.stringify(page.body)).toBe(200);
        collected.push(...(page.body?.result?.tools ?? []));
        cursor = page.body?.result?.nextCursor;
      } while (cursor);
      return collected;
    };
    const invoke = (name: string, args: Record<string, unknown> = {}) =>
      call({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } });
    const read = (uri: string) =>
      call({ jsonrpc: "2.0", id: nextId++, method: "resources/read", params: { uri } });
    return { session, init, call, tools, invoke, read };
  };

  return { mcp, open, settle, nextId: () => nextId++ };
}

/** The JSON payload of a `resources/read` reply. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resourceJson(body: any): any {
  return JSON.parse(body.result.contents[0].text);
}

/** The structured payload of a tool reply. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolJson(body: any): any {
  return body?.result?.structuredContent?.result ?? null;
}

describe("MCP collapsed profile: tool projection", () => {
  it("collapses the seeded Living Room to one tool per concept and leaves the classic surface alone", async () => {
    const world = await bootWorld();
    const classic = await world.open(null);
    const collapsed = await world.open("collapsed");

    const classicNames = (await classic.tools()).map((tool) => tool.name);
    const collapsedTools = await collapsed.tools();
    const collapsedNames = collapsedTools.map((tool) => tool.name);
    const dynamic = collapsedNames.filter((name) => !name.startsWith("woo_"));

    // --- the premise: the classic surface really is what the note measured --
    // If the demo world changes shape this is the assertion that should be
    // re-measured first; every ratio below is relative to it.
    expect(classicNames.filter((name) => !name.startsWith("woo_")).length).toBe(146);

    // --- the collapse -----------------------------------------------------
    // 146 -> 47. The remaining gap to the note's illustrative ~29 is the
    // speech merge (`say`/`emote`/`quote`… into one `say(text, mode)`) and the
    // `look`/`look_at`/`examine_detailed` merge, both of which would require
    // core to know what those verb NAMES mean. Ancestry cannot derive them and
    // this projection deliberately does not fake it.
    expect(dynamic.length).toBe(47);

    // --- shape: one tool per concept --------------------------------------
    expect(dynamic.filter((name) => name === "say")).toEqual(["say"]);
    expect(dynamic.filter((name) => name === "look")).toEqual(["look"]);
    expect(dynamic.filter((name) => name === "set_description")).toEqual(["set_description"]);
    // `set_description` was the worst case in the note: nine instances, one
    // per object in context. It is now one tool that reaches all of them.
    const describe = collapsedTools.find((tool) => tool.name === "set_description");
    const describeTargets = (describe?.inputSchema as { properties?: Record<string, { enum?: string[] }> })
      ?.properties?.target?.enum ?? [];
    expect(describeTargets.length).toBeGreaterThanOrEqual(8);
    expect(describeTargets).toContain("the_chatroom");
    expect(describeTargets).toContain(ACTOR);

    // --- mounts contribute a handle, not a room ---------------------------
    // The dominant measured lever: `the_outline` and `the_dubspace` supplied 80
    // of the classic 146 while the actor stands in neither.
    expect(classicNames.filter((name) => name.startsWith("the_outline__") || name.startsWith("the_dubspace__")).length)
      .toBe(80);
    expect(dynamic.filter((name) => name.startsWith("the_outline__") || name.startsWith("the_dubspace__")))
      .toEqual([]);
    // The handle each mount keeps is its place in the universal `enter`.
    const enter = collapsedTools.find((tool) => tool.name === "enter");
    const enterTargets = (enter?.inputSchema as { properties?: Record<string, { enum?: string[] }> })
      ?.properties?.target?.enum ?? [];
    expect(enterTargets).toContain("the_outline");
    expect(enterTargets).toContain("the_dubspace");
    // ...and it is findable by name, because the discovery control searches
    // descriptions and a deferring host has nothing else to search.
    expect(enter?.description).toContain("the_outline");

    // --- the name-keyed fold ----------------------------------------------
    // Eight compass verbs plus `out` read `target.exits[$verb].dest`; `go`
    // reads the same path from its argument, so the family folds into `go`.
    for (const compass of ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest", "out"]) {
      expect(dynamic, `${compass} should have folded into go`).not.toContain(compass);
      expect(classicNames).toContain(`the_chatroom__${compass}`);
    }
    expect(dynamic).toContain("go");
    const go = collapsedTools.find((tool) => tool.name === "go");
    const exitParameter = (go?.inputSchema as { properties?: Record<string, { description?: string }> })
      ?.properties?.exit;
    expect(exitParameter?.description ?? "").toContain("north");

    // --- classic is untouched ---------------------------------------------
    // Not merely "still works": the same session ids, the same names, and the
    // three stable controls with no `woo_read` among them.
    expect(classicNames.filter((name) => name.startsWith("woo_")))
      .toEqual(["woo_call", "woo_wait", "woo_list_reachable_tools"]);
    expect(collapsedNames.filter((name) => name.startsWith("woo_")))
      .toEqual(["woo_call", "woo_wait", "woo_list_reachable_tools", "woo_read"]);
    expect(classic.init.body.result.capabilities).toEqual({ tools: { listChanged: true } });
    expect(collapsed.init.body.result.capabilities)
      .toEqual({ tools: { listChanged: true }, resources: { listChanged: true } });
  }, 200_000);

  it("dispatches every universal tool to the receiver it was given", async () => {
    const world = await bootWorld();
    const collapsed = await world.open("collapsed");

    // Default receiver: the active space. `look` with no target looks at the
    // room, which is what the classic `the_chatroom__look` did.
    const here = await collapsed.invoke("look", {});
    expect(here.status, JSON.stringify(here.body)).toBe(200);
    expect(JSON.stringify(here.body)).toContain("the_chatroom");

    // An explicit receiver retargets the SAME tool, per call. This is the
    // property that makes a remembered collapsed name safe.
    const mug = await collapsed.invoke("look", { target: "the_mug" });
    expect(mug.status, JSON.stringify(mug.body)).toBe(200);
    expect(JSON.stringify(mug.body).toLowerCase()).toContain("mug");

    // `set_description` requires its receiver — there is no sensible default
    // for a verb every object answers — and the world's own authority still
    // adjudicates the call. Listing is never an authority grant: the tool
    // reaches nine objects and the actor may describe only what it owns.
    const refused = await collapsed.invoke("set_description", {
      target: "the_mug",
      desc: "A heavy ceramic mug, freshly described by a collapsed tool."
    });
    expect(refused.body?.result?.isError).toBe(true);
    // The refusal names the RECEIVER the argument chose, which is the proof
    // that the collapsed tool dispatched where it was told rather than to its
    // default.
    expect(JSON.stringify(refused.body)).toContain("\"obj\":\"the_mug\"");

    const described = await collapsed.invoke("set_description", {
      target: ACTOR,
      desc: "An agent, freshly described by a collapsed tool."
    });
    expect(described.status, JSON.stringify(described.body)).toBe(200);
    expect(described.body?.result?.isError ?? false, JSON.stringify(described.body)).toBe(false);
    await world.settle();
    expect(resourceJson((await collapsed.read("woo://me")).body).description).toContain("freshly described");

    // A receiver the tool does not reach is refused with the legal set — never
    // dispatched to the default and silently wrong. The published `enum` is
    // what refuses it, so the advertised set and the accepted set are one
    // thing rather than two checks that could drift.
    const wrong = await collapsed.invoke("look", { target: "the_deck" });
    expect(wrong.body?.result?.isError).toBe(true);
    const refusal = wrong.body?.result?.structuredContent?.error;
    expect(refusal?.code).toBe("E_INVARG");
    expect(refusal?.detail?.field).toBe("target");
    expect(String(refusal?.detail?.expected)).toContain("\"the_chatroom\"");

    // `$here` and `$me` resolve as they do for woo_call.
    const viaAlias = await collapsed.invoke("look", { target: "$here" });
    expect(viaAlias.status).toBe(200);
    expect(JSON.stringify(viaAlias.body)).toContain("the_chatroom");

    // The folded family's general form still moves the actor, using a folded
    // member's own name as the argument value.
    const moved = await collapsed.invoke("go", { exit: "southeast" });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body?.result?.isError ?? false).toBe(false);
    await world.settle();
    const afterMove = await collapsed.read("woo://here");
    expect(resourceJson(afterMove.body).id).toBe("the_deck");
  }, 200_000);

  it("keeps a catalog verb that shadows a universal name object-qualified and callable", async () => {
    const world = await bootWorld();
    const collapsed = await world.open("collapsed");
    const tools = await collapsed.tools();
    const names = tools.map((tool) => tool.name);

    // `look` is universal because `$conversational`/`$thing` — bases shared
    // across context — declare it. `$cockatoo` declares its OWN `look`, so the
    // cockatoo's is distinctive and keeps its object-qualified name. Shadowing
    // is allowed and diagnostic (§M9.3): both names are advertised.
    expect(names).toContain("look");
    expect(names).toContain("the_cockatoo__look");
    // ...and the shadowing object is NOT a receiver of the universal tool,
    // because its own declaration is what the world would dispatch.
    const look = tools.find((tool) => tool.name === "look");
    const lookTargets = (look?.inputSchema as { properties?: Record<string, { enum?: string[] }> })
      ?.properties?.target?.enum ?? [];
    expect(lookTargets).not.toContain("the_cockatoo");

    // The distinctive one is callable and reaches the cockatoo's own verb.
    const squawk = await collapsed.invoke("the_cockatoo__look", {});
    expect(squawk.status, JSON.stringify(squawk.body)).toBe(200);
    expect(squawk.body?.result?.isError ?? false).toBe(false);

    // The weather block's `open` is likewise its catalog's, not a convention:
    // it stays `the_weather__open` and does not collapse into anything.
    expect(names).toContain("the_weather__open");
    expect(names).not.toContain("open");
  }, 200_000);
});

describe("MCP collapsed profile: resources", () => {
  it("lists a constant resource set that movement cannot change", async () => {
    const world = await bootWorld();
    const collapsed = await world.open("collapsed");

    const listBefore = await collapsed.call({ jsonrpc: "2.0", id: world.nextId(), method: "resources/list", params: {} });
    expect(listBefore.status, JSON.stringify(listBefore.body)).toBe(200);
    const before = listBefore.body.result.resources.map((entry: { uri: string }) => entry.uri);
    expect(before).toEqual([
      "woo://here",
      "woo://here/exits",
      "woo://here/roster",
      "woo://me",
      "woo://me/inventory"
    ]);

    // The listing is the thing SEP-2567 forbids varying by prior call or
    // connection state. Walking the actor into a different space — which
    // changes the tool list dramatically — must leave it identical.
    const moved = await collapsed.invoke("go", { exit: "southeast" });
    expect(moved.body?.result?.isError ?? false).toBe(false);
    await world.settle();
    expect(resourceJson((await collapsed.read("woo://here")).body).id).toBe("the_deck");

    const listAfter = await collapsed.call({ jsonrpc: "2.0", id: world.nextId(), method: "resources/list", params: {} });
    expect(listAfter.body.result.resources.map((entry: { uri: string }) => entry.uri)).toEqual(before);
    expect(listAfter.body.result).toEqual(listBefore.body.result);

    // Templates are stable URI SHAPES and likewise do not vary.
    const templates = await collapsed.call({ jsonrpc: "2.0", id: world.nextId(), method: "resources/templates/list", params: {} });
    expect(templates.body.result.resourceTemplates.map((entry: { uriTemplate: string }) => entry.uriTemplate))
      .toEqual(["woo://object/{id}"]);
  }, 200_000);

  it("reports traversability on exit records, including the Living Room's plate-glass south", async () => {
    const world = await bootWorld();
    const collapsed = await world.open("collapsed");
    const exits = resourceJson((await collapsed.read("woo://here/exits")).body).exits as Array<Record<string, unknown>>;

    const south = exits.find((exit) => exit.id === "exit_living_room_south");
    expect(south, "the seeded pseudo-exit is gone; re-measure this case").toBeDefined();
    // The finding the walkthrough's second pass added: `ways()` reports this
    // as a real exit with a stable id, and it is not one. The category is
    // public; the joke is still only discovered by walking into it.
    expect(south?.traversable).toBe(false);
    expect(south?.destination).toBe("the_deck");
    expect(south?.aliases).toEqual(["s", "south"]);
    expect(JSON.stringify(south)).not.toContain("plate-glass windows, especially");

    const real = exits.find((exit) => exit.id === "exit_living_room_southeast");
    expect(real?.traversable).toBe(true);
    expect(real?.destination).toBe("the_deck");
    expect(real?.label).toBe("southeast");

    // Cacheability hints, per the revision: a room's exits are the same bytes
    // for everyone standing in it.
    const raw = (await collapsed.read("woo://here/exits")).body.result;
    expect(raw.cacheScope).toBe("public");
    expect(raw.ttlMs).toBeGreaterThan(0);
    const inventory = (await collapsed.read("woo://me/inventory")).body.result;
    expect(inventory.cacheScope).toBe("private");
    expect(inventory.ttlMs).toBeLessThan(raw.ttlMs);
  }, 200_000);

  it("refuses a read of an object outside structural context, and serves woo_read identically", async () => {
    const world = await bootWorld();
    const collapsed = await world.open("collapsed");

    // Reachable: the room's own contents.
    const mug = await collapsed.read("woo://object/the_mug");
    expect(mug.status, JSON.stringify(mug.body)).toBe(200);
    expect(resourceJson(mug.body).id).toBe("the_mug");

    // Not reachable: a space the actor is not in. A resource read must not be
    // a side channel around the reachability rule tools enforce.
    const elsewhere = await collapsed.read("woo://object/the_deck");
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.body?.error?.data?.code).toBe("E_PERM");
    expect(JSON.stringify(elsewhere.body)).toContain("not reachable");

    // The tool fallback answers the same bytes, so a host that ignores
    // resources sees the same world.
    const viaTool = await collapsed.invoke("woo_read", { uri: "woo://object/the_mug" });
    expect(viaTool.status).toBe(200);
    expect(toolJson(viaTool.body).data.id).toBe("the_mug");
    const refusedTool = await collapsed.invoke("woo_read", { uri: "woo://object/the_deck" });
    expect(refusedTool.body?.result?.isError).toBe(true);

    // `woo://here` names mounts separately from furniture, because the
    // projection treats them differently.
    const here = resourceJson((await collapsed.read("woo://here")).body);
    expect((here.mounts as Array<{ id: string }>).map((mount) => mount.id).sort())
      .toEqual(["the_dubspace", "the_outline"]);
    expect((here.contents as Array<{ id: string }>).map((entry) => entry.id))
      .not.toContain("the_outline");
  }, 200_000);

  it("does not expose resources to a classic session", async () => {
    const world = await bootWorld();
    const classic = await world.open(null);
    const listed = await classic.call({ jsonrpc: "2.0", id: world.nextId(), method: "resources/list", params: {} });
    // A method the server never advertised must say so, rather than quietly
    // working: capability discovery by probing would otherwise see two
    // different servers on one endpoint.
    expect(listed.body?.error?.code).toBe(-32601);
    const read = await classic.call({ jsonrpc: "2.0", id: world.nextId(), method: "resources/read", params: { uri: "woo://here" } });
    expect(read.body?.error?.code).toBe(-32601);
    // ...and `woo_read` is not callable there either.
    const tool = await classic.invoke("woo_read", { uri: "woo://here" });
    expect(JSON.stringify(tool.body)).toContain("unknown tool");
  }, 200_000);
});
