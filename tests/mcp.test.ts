import { describe, expect, it } from "vitest";
import { installVerb, installVerbAs } from "../src/core/authoring";
import { createWorld } from "../src/core/bootstrap";
import { McpHost, type McpTool } from "../src/mcp/host";
import { McpGateway } from "../src/mcp/gateway";
import { buildServerInstructions, createMcpServer } from "../src/mcp/server";
import type { Observation, ObjRef, RemoteToolDescriptor, VerbDef, WooValue } from "../src/core/types";
import type { CallContext, HostBridge, MoveObjectResult, WooWorld } from "../src/core/world";

function bootstrapWorld() {
  return createWorld();
}

function nativeToolVerb(name: string, native: string): VerbDef {
  return {
    kind: "native",
    name,
    aliases: [],
    owner: "$wiz",
    perms: "rxd",
    arg_spec: { args: [] },
    source: `verb :${name}() rxd { return "${name}"; }`,
    source_hash: `mcp-test-${name}`,
    version: 1,
    line_map: {},
    native,
    direct_callable: true,
    tool_exposed: true
  };
}

class RemoteToolBridge implements HostBridge {
  constructor(
    readonly localHost: string,
    private readonly worlds: Map<string, WooWorld>,
    private readonly routes: Map<ObjRef, string>,
    private readonly hosts: Map<string, McpHost>
  ) {}

  hostForObject(id: ObjRef): string | null {
    return this.routes.get(id) ?? null;
  }

  async getPropChecked(progr: ObjRef, objRef: ObjRef, name: string): Promise<WooValue> {
    return await this.worldFor(objRef).getPropChecked(progr, objRef, name);
  }

  async location(objRef: ObjRef): Promise<ObjRef | null> {
    return this.worldFor(objRef).object(objRef).location;
  }

  async dispatch(ctx: CallContext, target: ObjRef, verbName: string, args: WooValue[], startAt?: ObjRef | null): Promise<WooValue> {
    const remote = this.worldFor(startAt ?? target);
    return await remote.hostDispatch({ ...ctx, world: remote }, target, verbName, args, startAt);
  }

  async moveObject(objRef: ObjRef, targetRef: ObjRef, options: { suppressMirrorHost?: string | null } = {}): Promise<MoveObjectResult> {
    return await this.worldFor(objRef).moveObjectChecked(objRef, targetRef, options);
  }

  async mirrorContents(containerRef: ObjRef, objRef: ObjRef, present: boolean): Promise<void> {
    this.worldFor(containerRef).mirrorContents(containerRef, objRef, present);
  }

  async setActorPresence(actor: ObjRef, space: ObjRef, present: boolean): Promise<void> {
    this.worldFor(actor).setActorPresence(actor, space, present);
  }

  async setSpaceSubscriber(space: ObjRef, actor: ObjRef, present: boolean): Promise<void> {
    this.worldFor(space).setSpaceSubscriber(space, actor, present);
  }

  async contents(objRef: ObjRef): Promise<ObjRef[]> {
    return this.worldFor(objRef).contentsOf(objRef);
  }

  async enumerateRemoteTools(actor: ObjRef, ids: ObjRef[]): Promise<RemoteToolDescriptor[]> {
    const out: RemoteToolDescriptor[] = [];
    for (const id of ids) {
      const host = this.routes.get(id);
      if (!host || host === this.localHost) continue;
      const mcpHost = this.hosts.get(host);
      if (!mcpHost) continue;
      out.push(...mcpHost.enumerateLocalToolDescriptors(actor, [id]));
    }
    return out;
  }

  private worldFor(id: ObjRef): WooWorld {
    const host = this.routes.get(id);
    if (!host) throw new Error(`no route for ${id}`);
    const world = this.worlds.get(host);
    if (!world) throw new Error(`no world for ${host}`);
    return world;
  }
}

describe("McpHost", () => {
  it("frames the initialize instructions with the session's actor id", () => {
    const text = buildServerInstructions("guest_42");
    expect(text).toContain("`guest_42`");
    expect(text).toContain("woo_call(object, verb, args)");
    expect(text).toContain("woo_list_reachable_tools");
    expect(text).toContain("woo_focus(target)");
    expect(text).toContain("`enter`");
    expect(text).toContain("`look`");
    expect(text).toContain("`help`");
  });

  it("does not expose other actors through contents, inventory, or focus", async () => {
    const world = bootstrapWorld();
    const alice = world.auth("guest:mcp-privacy-alice");
    const bob = world.auth("guest:mcp-privacy-bob");
    const host = new McpHost(world);
    host.bindSession(alice.id, alice.actor);

    // Fresh guests sit in $nowhere together. That containment must not make
    // Bob's inherited $actor maintenance verbs callable by Alice.
    let tools = await host.enumerateTools(alice.actor);
    expect(tools.some((t) => t.object === alice.actor && t.verb === "wait")).toBe(true);
    expect(tools.some((t) => t.object === bob.actor)).toBe(false);

    // Same invariant inside an ordinary room: other present actors may be
    // visible to :look, but their actor verbs are not part of Alice's tool set.
    await world.directCall(undefined, alice.actor, "the_chatroom", "enter", []);
    await world.directCall(undefined, bob.actor, "the_chatroom", "enter", []);
    tools = await host.enumerateTools(alice.actor);
    expect(tools.some((t) => t.object === alice.actor && t.verb === "wait")).toBe(true);
    expect(tools.some((t) => t.object === bob.actor)).toBe(false);

    const focus = tools.find((t) => t.object === alice.actor && t.verb === "focus")!;
    await expect(host.invokeTool(alice.actor, alice.id, focus, [bob.actor])).rejects.toMatchObject({ code: "E_PERM" });
    expect((await host.enumerateTools(alice.actor)).some((t) => t.object === bob.actor)).toBe(false);
  });

  it("enumerates tools reachable from the actor with route classification", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-list");
    const host = new McpHost(world);
    host.bindSession(session.id, session.actor);

    // Walk into the chatroom so its verbs and contents are in scope.
    const entered = await world.directCall(undefined, session.actor, "the_chatroom", "enter", []);
    expect(entered.op).toBe("result");

    const tools = await host.enumerateTools(session.actor);
    const byObjVerb = new Map(tools.map((t) => [`${t.object}:${t.verb}`, t]));

    // $actor host primitives are seeded as tool_exposed verbs and reachable via "self".
    expect(byObjVerb.has(`${session.actor}:wait`)).toBe(true);
    expect(byObjVerb.has(`${session.actor}:focus`)).toBe(true);
    expect(byObjVerb.has(`${session.actor}:focus_list`)).toBe(true);

    // After entering, $conversational verbs on the chatroom are direct-callable.
    const sayTool = byObjVerb.get("the_chatroom:say");
    expect(sayTool).toBeDefined();
    expect(sayTool?.direct).toBe(true);

    // Cockatoo lives in the room's contents so its tool-exposed verbs are in scope.
    expect(byObjVerb.has("the_cockatoo:squawk")).toBe(true);

    // Taskspace mutators are sequenced (tool_exposed, not direct_callable);
    // the actor has presence in the_taskspace via auto_presence on auth.
    const createTask = byObjVerb.get("the_taskspace:create_task");
    expect(createTask).toBeDefined();
    expect(createTask?.direct).toBe(false);
    expect(createTask?.enclosingSpace).toBe("the_taskspace");

    // Tool names are unique.
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  });

  it("exposes verb editor tools after the programmer enters the editor room", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-editor");
    const actorObj = world.object(session.actor);
    actorObj.owner = session.actor;
    actorObj.flags.programmer = true;
    world.chparentAuthoredObject("$wiz", session.actor, "$programmer");
    const target = world.createAuthoredObject(session.actor, { parent: "$thing", name: "MCP Edit Target" });
    expect(installVerbAs(world, session.actor, target, "title", `verb :title() rx {
  return "before";
}`, null).ok).toBe(true);

    const host = new McpHost(world);
    host.bindSession(session.id, session.actor);
    const before = await host.enumerateTools(session.actor);
    expect(before.some((tool) => tool.object === session.actor && tool.verb === "edit_verb")).toBe(true);
    expect(before.some((tool) => tool.object === "the_verb_editor" && tool.verb === "view")).toBe(false);

    const edit = before.find((tool) => tool.object === session.actor && tool.verb === "edit_verb")!;
    await host.invokeTool(session.actor, session.id, edit, [target, "title", {}]);
    expect(world.object(session.actor).location).toBe("the_verb_editor");

    const inEditor = await host.enumerateTools(session.actor);
    const replace = inEditor.find((tool) => tool.object === "the_verb_editor" && tool.verb === "replace")!;
    const save = inEditor.find((tool) => tool.object === "the_verb_editor" && tool.verb === "save")!;
    expect(inEditor.some((tool) => tool.object === "the_verb_editor" && tool.verb === "view")).toBe(true);
    await host.invokeTool(session.actor, session.id, replace, [`verb :title() rx {
  return "after";
}`]);
    await host.invokeTool(session.actor, session.id, save, []);

    expect(world.object(session.actor).location).toBe("$nowhere");
    expect(world.ownVerb(target, "title")?.source).toContain("after");
    const after = await host.enumerateTools(session.actor);
    expect(after.some((tool) => tool.object === "the_verb_editor" && tool.verb === "view")).toBe(false);
  });

  it("builds input schemas from source-compiled parameter specs", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-source-params");
    const host = new McpHost(world);
    host.bindSession(session.id, session.actor);
    await world.directCall(undefined, session.actor, "the_chatroom", "enter", []);

    world.createObject({ id: "schema_widget", name: "Schema Widget", parent: "$thing", owner: "$wiz", location: "the_chatroom" });
    const installed = installVerb(world, "schema_widget", "paint", `verb :paint(color, count) rxd {
  return color;
}`, null);
    expect(installed.ok).toBe(true);
    const verb = world.ownVerb("schema_widget", "paint");
    expect(verb).toBeDefined();
    if (verb) verb.tool_exposed = true;

    const tool = (await host.enumerateTools(session.actor)).find((candidate) => candidate.object === "schema_widget" && candidate.verb === "paint");
    expect(tool).toBeDefined();
    const schema = tool?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    expect(schema.properties).toHaveProperty("color");
    expect(schema.properties).toHaveProperty("count");
    expect(schema.required).toEqual(["color", "count"]);
  });

  it("lists reachable tools with bounded default scope and explicit expansion", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-list-scopes");
    const host = new McpHost(world);
    host.bindSession(session.id, session.actor);

    const entered = await world.directCall(undefined, session.actor, "the_chatroom", "enter", []);
    expect(entered.op).toBe("result");

    const active = await host.listTools(session.actor);
    expect(active.scope).toBe("active");
    expect(active.tools.some((t) => t.object === "the_chatroom" && t.verb === "say")).toBe(true);
    expect(active.tools.some((t) => t.object === "the_cockatoo" && t.verb === "squawk")).toBe(false);

    const here = await host.listTools(session.actor, { scope: "here", query: "squawk" });
    expect(here.tools.map((t) => `${t.object}:${t.verb}`)).toContain("the_cockatoo:squawk");

    const first = await host.listTools(session.actor, { scope: "all", limit: 1 });
    expect(first.tools.length).toBe(1);
    expect(first.nextCursor).toBe("1");
    const second = await host.listTools(session.actor, { scope: "all", limit: 1, cursor: first.nextCursor ?? undefined });
    expect(second.tools.length).toBe(1);
    expect(second.tools[0].name).not.toBe(first.tools[0].name);
  });

  it("returns own-call observations inline only — wait queue is for external events", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-self");
    const host = new McpHost(world);
    host.bindSession(session.id, session.actor);

    // Walk into the chatroom first so its verbs become reachable.
    const entered = await world.directCall(undefined, session.actor, "the_chatroom", "enter", []);
    expect(entered.op).toBe("result");

    const sayTool = (await host.enumerateTools(session.actor)).find((t) => t.object === "the_chatroom" && t.verb === "say")!;
    expect(sayTool).toBeDefined();
    const sayResult = await host.invokeTool(session.actor, session.id, sayTool, ["hello, world"]);
    expect(sayResult.observations.some((o) => o.type === "said")).toBe(true);

    // The own-call observations are NOT also enqueued — wait should drain empty.
    const waitTool = (await host.enumerateTools(session.actor)).find((t) => t.object === session.actor && t.verb === "wait")!;
    const waited = await host.invokeTool(session.actor, session.id, waitTool, [0, 64]);
    const drained = waited.result as { observations: Observation[]; more: boolean; queue_depth: number };
    expect(drained.observations.length).toBe(0);
    expect(drained.more).toBe(false);
  });

  it("routes external broadcast observations into other sessions' queues but not the originator's", async () => {
    const world = bootstrapWorld();
    const alice = world.auth("guest:mcp-alice");
    const bob = world.auth("guest:mcp-bob");
    const host = new McpHost(world);
    host.bindSession(alice.id, alice.actor);
    host.bindSession(bob.id, bob.actor);

    // Both walk into the chatroom so they share presence.
    await world.directCall(undefined, alice.actor, "the_chatroom", "enter", []);
    await world.directCall(undefined, bob.actor, "the_chatroom", "enter", []);

    // Alice says hello — direct result. Route as external from Alice's session.
    const said = await world.directCall(undefined, alice.actor, "the_chatroom", "say", ["hi everyone"]);
    expect(said.op).toBe("result");
    if (said.op !== "result") return;
    host.routeLiveEvents(said, alice.id);

    const waitTool = (await host.enumerateTools(bob.actor)).find((t) => t.object === bob.actor && t.verb === "wait")!;
    // Bob sees Alice's said observation in his queue.
    const bobDrain = (await host.invokeTool(bob.actor, bob.id, waitTool, [0, 64])).result as { observations: Observation[] };
    expect(bobDrain.observations.some((o) => o.type === "said" && o.actor === alice.actor)).toBe(true);

    // Alice does NOT see her own observation in her queue.
    const aliceWait = (await host.enumerateTools(alice.actor)).find((t) => t.object === alice.actor && t.verb === "wait")!;
    const aliceDrain = (await host.invokeTool(alice.actor, alice.id, aliceWait, [0, 64])).result as { observations: Observation[] };
    expect(aliceDrain.observations.some((o) => o.type === "said" && o.actor === alice.actor)).toBe(false);
  });

  it("isolates per-session queues when two sessions share one gateway/host", async () => {
    const world = bootstrapWorld();
    const gateway = new McpGateway(world);
    const host = gateway.host;
    const alice = world.auth("guest:mcp-iso-alice");
    const bob = world.auth("guest:mcp-iso-bob");
    gateway.bindActorSession(alice.id, alice.actor);
    gateway.bindActorSession(bob.id, bob.actor);

    // Enqueue a per-actor observation for Alice and a different one for Bob.
    const ping: Observation = { type: "ping", actor: alice.actor, source: alice.actor, ts: Date.now() } as Observation;
    const pong: Observation = { type: "pong", actor: bob.actor, source: bob.actor, ts: Date.now() } as Observation;
    host.routeLiveEvents({
      op: "result", result: null, observations: [ping, pong],
      audience: "the_chatroom",
      audienceActors: [alice.actor, bob.actor],
      observationAudiences: [[alice.actor], [bob.actor]]
    }, null);

    const waitForActor = (await host.enumerateTools(alice.actor)).find((t) => t.object === alice.actor && t.verb === "wait")!;
    const aliceDrain = (await host.invokeTool(alice.actor, alice.id, waitForActor, [0, 64])).result as { observations: Observation[] };
    const bobDrain = (await host.invokeTool(bob.actor, bob.id, waitForActor, [0, 64])).result as { observations: Observation[] };

    expect(aliceDrain.observations.map((o) => o.type)).toEqual(["ping"]);
    expect(bobDrain.observations.map((o) => o.type)).toEqual(["pong"]);
  });

  it("invokes a sequenced tool through the enclosing space and returns applied", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-seq");
    const host = new McpHost(world);
    host.bindSession(session.id, session.actor);

    const create = (await host.enumerateTools(session.actor)).find((t) => t.object === "the_taskspace" && t.verb === "create_task")!;
    expect(create).toBeDefined();
    expect(create.direct).toBe(false);
    const result = await host.invokeTool(session.actor, session.id, create, ["MCP task", "from the host"]);
    expect(result.applied).toBeDefined();
    expect(result.applied?.space).toBe("the_taskspace");
    expect(typeof result.applied?.seq).toBe("number");
    expect(result.observations.some((o) => o.type === "task_created")).toBe(true);
  });

  it("uses dispatch hooks for MCP direct and sequenced invocation routes", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-dispatch-hooks");
    const calls: string[] = [];
    const host = new McpHost(world, {
      direct: async (_sessionId, actor, target, verb, args) => {
        calls.push(`direct:${actor}:${target}:${verb}:${args.length}`);
        return { op: "result", result: "direct-ok", observations: [], audience: null };
      },
      call: async (_sessionId, actor, space, message) => {
        calls.push(`call:${actor}:${space}:${message.target}:${message.verb}:${message.args.length}`);
        return {
          op: "applied",
          space,
          seq: 9,
          ts: 123,
          message,
          observations: [{ type: "sequenced-ok", source: space }]
        };
      }
    });
    host.bindSession(session.id, session.actor);

    const directTool: McpTool = {
      name: "remote_widget__ping",
      object: "remote_widget",
      verb: "ping",
      aliases: [],
      description: "",
      inputSchema: {},
      direct: true,
      enclosingSpace: null
    };
    const direct = await host.invokeTool(session.actor, session.id, directTool, ["x"]);
    expect(direct.result).toBe("direct-ok");

    const sequencedTool: McpTool = {
      name: "remote_space__mutate",
      object: "remote_space",
      verb: "mutate",
      aliases: [],
      description: "",
      inputSchema: {},
      direct: false,
      enclosingSpace: "remote_space"
    };
    const sequenced = await host.invokeTool(session.actor, session.id, sequencedTool, [1, 2]);
    expect(sequenced.applied).toEqual({ space: "remote_space", seq: 9, ts: 123 });
    expect(calls).toEqual([
      `direct:${session.actor}:remote_widget:ping:1`,
      `call:${session.actor}:remote_space:remote_space:mutate:2`
    ]);
  });

  it("focus and unfocus extend reachability and toggle list_changed", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-focus");
    const host = new McpHost(world);
    host.bindSession(session.id, session.actor);
    await host.refreshToolList(session.id, session.actor); // seed snapshot

    const create = (await host.enumerateTools(session.actor)).find((t) => t.object === "the_taskspace" && t.verb === "create_task")!;
    const created = await host.invokeTool(session.actor, session.id, create, ["Focus me", "test"]);
    const taskRef = (created.observations.find((o) => o.type === "task_created")?.task as string | undefined) ?? "";
    expect(typeof taskRef).toBe("string");
    expect(taskRef.length).toBeGreaterThan(0);

    // Before focus, the task's per-instance verbs aren't reachable.
    expect((await host.enumerateTools(session.actor)).some((t) => t.object === taskRef)).toBe(false);

    let listChanged = 0;
    host.onToolListChanged(() => { listChanged += 1; });

    const focus = (await host.enumerateTools(session.actor)).find((t) => t.object === session.actor && t.verb === "focus")!;
    await host.invokeTool(session.actor, session.id, focus, [taskRef]);

    // After focus, task's verbs (claim, set_status, add_subtask) are reachable.
    const taskTools = (await host.enumerateTools(session.actor)).filter((t) => t.object === taskRef);
    expect(taskTools.length).toBeGreaterThan(0);
    expect(taskTools.some((t) => t.verb === "claim")).toBe(true);
    expect(listChanged).toBeGreaterThan(0);

    const unfocus = (await host.enumerateTools(session.actor)).find((t) => t.object === session.actor && t.verb === "unfocus")!;
    await host.invokeTool(session.actor, session.id, unfocus, [taskRef]);
    expect((await host.enumerateTools(session.actor)).some((t) => t.object === taskRef)).toBe(false);
  });

  it("sends list_changed only to sessions for the actor whose tool list changed", async () => {
    const world = bootstrapWorld();
    const alice = world.auth("guest:mcp-list-change-alice");
    const bob = world.auth("guest:mcp-list-change-bob");
    const host = new McpHost(world);
    const aliceInstance = createMcpServer({ world, host, actor: alice.actor, sessionId: alice.id });
    const aliceServer = aliceInstance.server;
    const bobInstance = createMcpServer({ world, host, actor: bob.actor, sessionId: bob.id });
    const bobServer = bobInstance.server;
    await new Promise((resolve) => setTimeout(resolve, 0));

    let aliceNotifications = 0;
    let bobNotifications = 0;
    (aliceServer as unknown as { notification: (notification: unknown) => Promise<void> }).notification = async () => { aliceNotifications += 1; };
    (bobServer as unknown as { notification: (notification: unknown) => Promise<void> }).notification = async () => { bobNotifications += 1; };

    await host.refreshToolList(alice.id, alice.actor);
    await host.refreshToolList(bob.id, bob.actor);

    world.setProp(alice.actor, "focus_list", ["the_pinboard"]);
    await host.refreshToolList(alice.id, alice.actor);

    expect(aliceNotifications).toBe(1);
    expect(bobNotifications).toBe(0);

    bobInstance.dispose();
    world.setProp(bob.actor, "focus_list", ["the_taskspace"]);
    await host.refreshToolList(bob.id, bob.actor);
    expect(bobNotifications).toBe(0);
    aliceInstance.dispose();
  });

  it("does not enumerate remote tools while sending post-call list_changed hints", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-lazy-refresh");
    let remoteEnumerations = 0;
    world.setHostBridge({
      localHost: "home",
      hostForObject: (id: string) => id === "the_chatroom" ? "chat" : "home",
      enumerateRemoteTools: async () => {
        remoteEnumerations += 1;
        return [];
      }
    } as unknown as HostBridge);
    const host = new McpHost(world);
    host.bindSession(session.id, session.actor);
    await host.refreshToolList(session.id, session.actor);

    let listChanged = 0;
    host.onToolListChanged((actor) => {
      if (actor === session.actor) listChanged += 1;
    });

    const focus = (await host.enumerateTools(session.actor)).find((t) => t.object === session.actor && t.verb === "focus")!;
    await host.invokeTool(session.actor, session.id, focus, ["the_chatroom"]);

    expect(listChanged).toBe(1);
    expect(remoteEnumerations).toBe(0);
  });

  it("waits with timeout and returns more=true when queue overflows the limit", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-batch");
    const host = new McpHost(world);
    host.bindSession(session.id, session.actor);

    // Synthesize observations destined for this actor by routing a fake direct
    // result whose audience targets only this actor (origin = null = broadcast).
    const synthetic = (n: number): Observation => ({ type: "ping", source: session.actor, n: n as unknown as WooValue, ts: Date.now() } as Observation);
    const observations = Array.from({ length: 80 }, (_, i) => synthetic(i));
    host.routeLiveEvents({
      op: "result",
      result: null,
      observations,
      audience: "the_chatroom",
      audienceActors: [session.actor],
      observationAudiences: observations.map(() => [session.actor])
    }, null);

    const waitTool = (await host.enumerateTools(session.actor)).find((t) => t.object === session.actor && t.verb === "wait")!;
    const first = await host.invokeTool(session.actor, session.id, waitTool, [0, 50]);
    const drainedFirst = first.result as { observations: Observation[]; more: boolean; queue_depth: number };
    expect(drainedFirst.observations.length).toBe(50);
    expect(drainedFirst.more).toBe(true);
    expect(drainedFirst.queue_depth).toBe(30);

    const second = await host.invokeTool(session.actor, session.id, waitTool, [0, 50]);
    const drainedSecond = second.result as { observations: Observation[]; more: boolean; queue_depth: number };
    expect(drainedSecond.observations.length).toBe(30);
    expect(drainedSecond.more).toBe(false);
  });
});

describe("McpGateway", () => {
  it("initializes a session via Mcp-Token, lists tools, and calls a verb", async () => {
    const world = bootstrapWorld();
    const gateway = new McpGateway(world);

    // 1) initialize
    const init = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0.0.0" }
      }
    }, { "mcp-token": "guest:mcp-gateway" }));
    expect(init.ok).toBe(true);
    const sessionId = init.headers.get("mcp-session-id");
    expect(typeof sessionId).toBe("string");
    expect((sessionId ?? "").length).toBeGreaterThan(0);

    // initialized notification (required by MCP handshake)
    const notified = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      method: "notifications/initialized"
    }, { "mcp-session-id": sessionId! }));
    expect(notified.status).toBe(202);

    // 2) tools/list
    const list = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list"
    }, { "mcp-session-id": sessionId! }));
    expect(list.ok).toBe(true);
    const listBody = (await list.json()) as { result: { tools: Array<{ name: string }> } };
    expect(Array.isArray(listBody.result.tools)).toBe(true);
    expect(listBody.result.tools.some((t) => t.name === "woo_list_reachable_tools")).toBe(true);
    expect(listBody.result.tools.some((t) => t.name === "woo_call")).toBe(true);
    expect(listBody.result.tools.some((t) => t.name === "woo_focus")).toBe(true);
    expect(listBody.result.tools.some((t) => t.name === "woo_wait")).toBe(true);
    expect(listBody.result.tools.some((t) => t.name.includes("wait"))).toBe(true);
    expect(listBody.result.tools.some((t) => t.name.includes("create_task"))).toBe(true);

    // 3) Stable control tool — invoke a reachable direct verb by canonical handle.
    const stableCall = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "woo_call", arguments: { object: "the_taskspace", verb: "list_tasks", args: [] } }
    }, { "mcp-session-id": sessionId! }));
    expect(stableCall.ok).toBe(true);
    const stableCallBody = (await stableCall.json()) as { result: { isError?: boolean; structuredContent?: { result?: unknown } } };
    expect(stableCallBody.result.isError).not.toBe(true);
    expect(Array.isArray(stableCallBody.result.structuredContent?.result)).toBe(true);

    // 4) tools/call — invoke create_task as a sequenced dynamic tool
    const createName = listBody.result.tools.find((t) => t.name.endsWith("__create_task"))!.name;
    const call = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: createName, arguments: { title: "via gateway", description: "from MCP" } }
    }, { "mcp-session-id": sessionId! }));
    expect(call.ok).toBe(true);
    const callBody = (await call.json()) as { result: { isError?: boolean; structuredContent?: { applied?: { space: string; seq: number } } } };
    expect(callBody.result.isError).not.toBe(true);
    expect(callBody.result.structuredContent?.applied?.space).toBe("the_taskspace");

    // 5) DELETE closes the session
    const closed = await gateway.handle(new Request("http://t/mcp", {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId! }
    }));
    expect(closed.status).toBe(204);
  });

  it("advertises woo_call positional args as arbitrary JSON values", async () => {
    const world = bootstrapWorld();
    const gateway = new McpGateway(world);

    const init = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0.0.0" }
      }
    }, { "mcp-token": "guest:mcp-woo-call-schema" }));
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const list = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list"
    }, { "mcp-session-id": sessionId! }));
    const body = await list.json() as { result: { tools: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }> } };
    const wooCall = body.result.tools.find((tool) => tool.name === "woo_call");
    const args = wooCall?.inputSchema?.properties?.args as { items?: { anyOf?: unknown[] } } | undefined;
    expect(args?.items?.anyOf?.some((schema) => (schema as { type?: string }).type === "number")).toBe(true);
    expect(args?.items?.anyOf?.some((schema) => (schema as { type?: string }).type === "object")).toBe(true);
  });

  it("resolves woo_call through remote space contents, not just local reachable ids", async () => {
    const home = bootstrapWorld();
    const remote = bootstrapWorld();
    const remoteHost = new McpHost(remote);
    const worlds = new Map<string, WooWorld>([
      ["home", home],
      ["remote", remote]
    ]);
    const routes = new Map<ObjRef, string>([
      ["remote_gallery", "remote"],
      ["remote_widget", "remote"]
    ]);
    const hosts = new Map<string, McpHost>([["remote", remoteHost]]);
    home.setHostBridge(new RemoteToolBridge("home", worlds, routes, hosts));
    remote.setHostBridge(new RemoteToolBridge("remote", worlds, routes, hosts));

    home.createObject({ id: "remote_gallery", name: "Remote Gallery", parent: "$space", owner: "$wiz" });
    home.createObject({ id: "remote_widget", name: "Remote Widget", parent: "$thing", owner: "$wiz" });
    home.addVerb("remote_widget", nativeToolVerb("ping", "remote_ping"));

    remote.createObject({ id: "remote_gallery", name: "Remote Gallery", parent: "$space", owner: "$wiz" });
    remote.createObject({ id: "remote_widget", name: "Remote Widget", parent: "$thing", owner: "$wiz", location: "remote_gallery" });
    remote.addVerb("remote_widget", nativeToolVerb("ping", "remote_ping"));
    remote.registerNativeHandler("remote_ping", () => "pong");

    const gateway = new McpGateway(home);
    const init = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0.0.0" }
      }
    }, { "mcp-token": "guest:mcp-remote-contents" }));
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    const actor = Array.from(home.sessions.values())[0]?.actor;
    expect(actor).toBeTruthy();
    home.object(actor!).location = "remote_gallery";
    home.object("remote_gallery").contents.add(actor!);
    home.setProp(actor!, "presence_in", ["remote_gallery"]);
    remote.setProp("remote_gallery", "subscribers", [actor!]);

    const list = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list"
    }, { "mcp-session-id": sessionId! }));
    const listBody = await list.json() as { result: { tools: Array<{ name: string }> } };
    expect(listBody.result.tools.some((tool) => tool.name === "remote_widget__ping")).toBe(false);

    const hereList = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: { name: "woo_list_reachable_tools", arguments: { scope: "here" } }
    }, { "mcp-session-id": sessionId! }));
    const hereBody = await hereList.json() as { result: { isError?: boolean; structuredContent?: { result?: { tools?: Array<{ name: string }> } } } };
    expect(hereBody.result.isError).not.toBe(true);
    expect(hereBody.result.structuredContent?.result?.tools?.some((tool) => tool.name === "remote_widget__ping")).toBe(true);

    const call = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "woo_call", arguments: { object: "remote_widget", verb: "ping", args: [] } }
    }, { "mcp-session-id": sessionId! }));
    expect(call.ok).toBe(true);
    const callBody = await call.json() as { result: { isError?: boolean; structuredContent?: { result?: unknown } } };
    expect(callBody.result.isError).not.toBe(true);
    expect(callBody.result.structuredContent?.result).toBe("pong");
  });

  it("treats a remote current location as reachable even without a local stub", async () => {
    const home = bootstrapWorld();
    const remote = bootstrapWorld();
    const remoteHost = new McpHost(remote);
    const worlds = new Map<string, WooWorld>([
      ["home", home],
      ["remote", remote]
    ]);
    const routes = new Map<ObjRef, string>([
      ["remote_room", "remote"],
      ["remote_widget", "remote"]
    ]);
    const hosts = new Map<string, McpHost>([["remote", remoteHost]]);
    home.setHostBridge(new RemoteToolBridge("home", worlds, routes, hosts));
    remote.setHostBridge(new RemoteToolBridge("remote", worlds, routes, hosts));

    remote.createObject({ id: "remote_room", name: "Remote Room", parent: "$space", owner: "$wiz" });
    remote.setProp("remote_room", "name", "Remote Room");
    remote.addVerb("remote_room", nativeToolVerb("leave", "remote_leave"));
    remote.registerNativeHandler("remote_leave", () => "left");
    remote.createObject({ id: "remote_widget", name: "Remote Widget", parent: "$thing", owner: "$wiz", location: "remote_room" });
    remote.setProp("remote_widget", "name", "Remote Widget");
    remote.addVerb("remote_widget", nativeToolVerb("ping", "remote_ping"));
    remote.registerNativeHandler("remote_ping", () => "pong");

    const session = home.auth("guest:mcp-remote-location");
    home.object(session.actor).location = "remote_room";

    const host = new McpHost(home);
    host.bindSession(session.id, session.actor);

    const active = await host.listTools(session.actor);
    expect(active.tools.map((tool) => `${tool.object}:${tool.verb}`)).toContain("remote_room:leave");
    expect(active.tools.some((tool) => tool.object === "remote_widget")).toBe(false);

    const here = await host.listTools(session.actor, { scope: "here" });
    expect(here.tools.map((tool) => `${tool.object}:${tool.verb}`)).toContain("remote_room:leave");
    expect(here.tools.map((tool) => `${tool.object}:${tool.verb}`)).toContain("remote_widget:ping");

    const objectScoped = await host.listTools(session.actor, { scope: "object", object: "remote_room" });
    expect(objectScoped.tools.map((tool) => `${tool.object}:${tool.verb}`)).toContain("remote_room:leave");

    const tool = await host.resolveReachableTool(session.actor, "remote_room", "leave");
    expect(tool).toBeDefined();
  });

  it("initializes a session via Authorization bearer for Codex-style MCP clients", async () => {
    const world = bootstrapWorld();
    const gateway = new McpGateway(world);

    const init = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "codex", version: "0.0.0" }
      }
    }, { authorization: "Bearer guest:mcp-codex" }));

    expect(init.ok).toBe(true);
    expect((init.headers.get("mcp-session-id") ?? "").length).toBeGreaterThan(0);
  });

  it("refreshes dynamic tool cache once when a stale client calls a newly reachable tool", async () => {
    const world = bootstrapWorld();
    const gateway = new McpGateway(world);

    const init = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0.0.0" }
      }
    }, { "mcp-token": "guest:mcp-refresh" }));
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      method: "notifications/initialized"
    }, { "mcp-session-id": sessionId! }));

    const initial = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list"
    }, { "mcp-session-id": sessionId! }));
    const initialBody = (await initial.json()) as { result: { tools: Array<{ name: string }> } };
    expect(initialBody.result.tools.some((t) => t.name === "the_pinboard__enter")).toBe(false);

    const actor = Array.from(world.sessions.values())[0]?.actor;
    expect(actor).toBeTruthy();
    world.setProp(actor!, "focus_list", ["the_pinboard"]);

    const staleCall = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "the_pinboard__enter", arguments: {} }
    }, { "mcp-session-id": sessionId! }));
    expect(staleCall.ok).toBe(true);
    const staleCallBody = (await staleCall.json()) as { result: { isError?: boolean; structuredContent?: { observations?: Array<{ type?: string }> } } };
    expect(staleCallBody.result.isError).not.toBe(true);
    expect(staleCallBody.result.structuredContent?.observations?.some((o) => o.type === "pinboard_entered")).toBe(true);
  });

  it("keeps stable actor-control tools available when dynamic actor tools are hidden", async () => {
    const world = bootstrapWorld();
    for (const name of ["wait", "focus"]) {
      const verb = world.ownVerb("$actor", name);
      expect(verb).toBeDefined();
      if (verb) verb.tool_exposed = false;
    }
    const gateway = new McpGateway(world);

    const init = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0.0.0" }
      }
    }, { "mcp-token": "guest:mcp-stable-control" }));
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    const actor = Array.from(world.sessions.values())[0]?.actor;
    expect(actor).toBeTruthy();

    await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      method: "notifications/initialized"
    }, { "mcp-session-id": sessionId! }));

    const list = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list"
    }, { "mcp-session-id": sessionId! }));
    const body = (await list.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.some((t) => t.name === "woo_wait")).toBe(true);
    expect(body.result.tools.some((t) => t.name === "woo_focus")).toBe(true);
    expect(body.result.tools.some((t) => t.name === `${actor}__wait`)).toBe(false);
    expect(body.result.tools.some((t) => t.name === `${actor}__focus`)).toBe(false);

    const waited = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "woo_wait", arguments: { timeout_ms: 0, limit: 1 } }
    }, { "mcp-session-id": sessionId! }));
    const waitedBody = (await waited.json()) as { result: { isError?: boolean } };
    expect(waitedBody.result.isError).not.toBe(true);

    const focused = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "woo_focus", arguments: { target: "the_taskspace" } }
    }, { "mcp-session-id": sessionId! }));
    const focusedBody = (await focused.json()) as { result: { isError?: boolean; structuredContent?: { result?: unknown } } };
    expect(focusedBody.result.isError).not.toBe(true);
    expect(focusedBody.result.structuredContent?.result).toContain("the_taskspace");
  });

  it("normalizes missing Accept headers for Codex-style initialize requests", async () => {
    const world = bootstrapWorld();
    const gateway = new McpGateway(world);

    const init = await gateway.handle(new Request("http://t/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer guest:mcp-codex-accept"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "codex", version: "0.0.0" }
        }
      })
    }));

    expect(init.ok).toBe(true);
    const body = await init.json() as { jsonrpc?: string; result?: { serverInfo?: { name?: string } } };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.result?.serverInfo?.name).toBe("woo");
  });

  it("rejects requests without a session and without an auth token", async () => {
    const world = bootstrapWorld();
    const gateway = new McpGateway(world);
    const response = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 9,
      method: "initialize",
      params: {}
    }, {}));
    expect(response.status).toBe(401);
    const body = await response.json() as { jsonrpc: string; id: number; error: { code: number; data?: { code?: string } } };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(9);
    expect(body.error.code).toBe(-32001);
    expect(body.error.data?.code).toBe("E_NOSESSION");
  });

  it("returns a JSON-RPC session-not-found error for stale session ids", async () => {
    const world = bootstrapWorld();
    const gateway = new McpGateway(world);
    const response = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/list"
    }, { "mcp-session-id": "stale-session" }));
    expect(response.status).toBe(404);
    const body = await response.json() as { jsonrpc: string; id: number; error: { code: number; message: string; data?: { code?: string } } };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(10);
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toContain("session not found");
    expect(body.error.data?.code).toBe("E_NOSESSION");
  });
});

function jsonRpcRequest(url: string, body: unknown, headers: Record<string, string>): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
      ...headers
    },
    body: JSON.stringify(body)
  });
}
