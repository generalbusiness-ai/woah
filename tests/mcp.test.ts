import { describe, expect, it, vi } from "vitest";
import { installVerb, installVerbAs } from "../src/core/authoring";
import { createWorld } from "../src/core/bootstrap";
import { McpHost, type McpTool } from "../src/mcp/host";
import { McpGateway } from "../src/mcp/gateway";
import { buildServerInstructions, createMcpServer } from "../src/mcp/server";
import type { EffectTranscript } from "../src/core/effect-transcript";
import { createShadowBrowserRelayShim } from "../src/core/shadow-browser-node";
import { applyShadowTranscriptToCommittedState } from "../src/core/shadow-commit-scope";
import type { MetricEvent, Observation, ObjRef, RemoteToolDescriptor, VerbDef, WooValue } from "../src/core/types";
import type { CallContext, HostBridge, MoveObjectResult, RoomSnapshot, ScopedObjectSummary, WooWorld } from "../src/core/world";

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

  async setPropChecked(progr: ObjRef, objRef: ObjRef, name: string, value: WooValue): Promise<void> {
    await this.worldFor(objRef).setPropChecked(progr, objRef, name, value);
  }

  async location(objRef: ObjRef): Promise<ObjRef | null> {
    return this.worldFor(objRef).object(objRef).location;
  }

  async isDescendantOf(objRef: ObjRef, ancestorRef: ObjRef): Promise<boolean> {
    return await this.worldFor(objRef).isDescendantOfChecked(objRef, ancestorRef);
  }

  async objectSummary(readActor: ObjRef, objRef: ObjRef): Promise<ScopedObjectSummary> {
    return await this.worldFor(objRef).scopedObjectSummary(readActor, objRef);
  }

  async objectSummaries(readActor: ObjRef, objRefs: ObjRef[]): Promise<Record<ObjRef, ScopedObjectSummary>> {
    const out: Record<ObjRef, ScopedObjectSummary> = {};
    for (const objRef of objRefs) out[objRef] = await this.objectSummary(readActor, objRef);
    return out;
  }

  async roomSnapshot(readActor: ObjRef, room: ObjRef, sessionId?: string | null): Promise<RoomSnapshot> {
    return await this.worldFor(room).roomSnapshotForActor(readActor, room, sessionId ?? null);
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

  async setActorPresence(actor: ObjRef, space: ObjRef, present: boolean, sessionId?: string): Promise<void> {
    this.worldFor(actor).setActorPresence(actor, space, present, sessionId);
  }

  async setSpaceSubscriber(space: ObjRef, actor: ObjRef, present: boolean, sessionId?: string): Promise<void> {
    this.worldFor(space).setSpaceSubscriber(space, actor, present, sessionId);
  }

  async spaceAudienceSessions(space: ObjRef, actors?: ObjRef[]): Promise<string[]> {
    return this.worldFor(space).presenceSessionIdsIn(space, actors);
  }

  async actorSessionLocations(actor: ObjRef): Promise<ObjRef[]> {
    return this.worldFor(actor).allLocationsForActor(actor);
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

  it("exposes only obvious command verbs for other actors in room contents", async () => {
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
    // visible to :look and can advertise obvious commands, but their actor
    // maintenance verbs are not part of Alice's tool set.
    await world.directCall(undefined, alice.actor, "the_chatroom", "enter", []);
    await world.directCall(undefined, bob.actor, "the_chatroom", "enter", []);
    const installed = installVerb(world, bob.actor, "wave", `verb :wave() rxd {
  return "waved";
}`, null);
    expect(installed.ok).toBe(true);
    const wave = world.ownVerb(bob.actor, "wave");
    expect(wave).toBeDefined();
    if (wave) {
      wave.direct_callable = true;
      wave.arg_spec = { ...wave.arg_spec, command: { dobj: "this", prep: "none", iobj: "none", args_from: [] } };
    }
    tools = await host.enumerateTools(alice.actor);
    expect(tools.some((t) => t.object === alice.actor && t.verb === "wait")).toBe(true);
    expect(tools.some((t) => t.object === bob.actor && t.verb === "wave")).toBe(true);
    expect(tools.some((t) => t.object === bob.actor && ["wait", "focus", "unfocus", "focus_list"].includes(t.verb))).toBe(false);

    const focus = tools.find((t) => t.object === alice.actor && t.verb === "focus")!;
    await expect(host.invokeTool(alice.actor, alice.id, focus, [bob.actor])).rejects.toMatchObject({ code: "E_PERM" });
    expect((await host.enumerateTools(alice.actor)).some((t) => t.object === bob.actor && ["wait", "focus", "unfocus", "focus_list"].includes(t.verb))).toBe(false);
  });

  it("exposes block appliances even though they inherit from $actor", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-block-visible");
    const host = new McpHost(world);
    host.bindSession(session.id, session.actor);

    world.createObject({ id: "$block", name: "$block", parent: "$actor", owner: "$wiz" });
    world.createObject({ id: "mcp_weather", name: "Weather", parent: "$block", owner: "$wiz", location: "the_chatroom" });
    const installed = installVerb(world, "mcp_weather", "status", `verb :status() rxd {
  return "72F";
}`, null);
    expect(installed.ok).toBe(true);
    const verb = world.ownVerb("mcp_weather", "status");
    expect(verb).toBeDefined();
    if (verb) verb.arg_spec = { ...verb.arg_spec, command: { dobj: "this", prep: "none", iobj: "none", args_from: [] } };

    await world.directCall(undefined, session.actor, "the_chatroom", "enter", []);
    const reachable = host.reachable(session.actor);
    expect(reachable).toEqual(expect.arrayContaining([expect.objectContaining({ id: "mcp_weather", origin: "contents" })]));
    const tools = await host.enumerateTools(session.actor, { scope: "here" });
    expect(tools.some((tool) => tool.object === "mcp_weather" && tool.verb === "status")).toBe(true);
    expect(tools.some((tool) => tool.object === "mcp_weather" && ["wait", "focus", "unfocus", "focus_list"].includes(tool.verb))).toBe(false);
    await expect(host.resolveReachableTool(session.actor, "mcp_weather", "focus")).resolves.toBeNull();
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

    // Tool names are unique.
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  });

  it("exposes verb editor tools after the programmer enters the editor room", async () => {
    const world = bootstrapWorld();
    // The verb editor exit-to-$nowhere assertion below assumes the actor had
    // no prior location. Demoworld would otherwise auto-place fresh guests in
    // Living Room.
    world.setProp("$system", "guest_initial_room", null);
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
    if (verb) {
      verb.tool_exposed = true;
      verb.arg_spec = { ...verb.arg_spec, command: { dobj: "this", prep: "none", iobj: "none", args_from: [] } };
    }

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
    const enteredPinboard = await world.directCall(undefined, session.actor, "the_pinboard", "enter", []);
    expect(enteredPinboard.op).toBe("result");

    const addNote = (await host.enumerateTools(session.actor)).find((t) => t.object === "the_pinboard" && t.verb === "add_note")!;
    expect(addNote).toBeDefined();
    expect(addNote.direct).toBe(false);
    expect(addNote.enclosingSpace).toBe("the_pinboard");

    const result = await host.invokeTool(session.actor, session.id, addNote, ["MCP-routed note"]);
    expect(result.applied).toBeDefined();
    expect(result.applied?.space).toBe("the_pinboard");
    expect(typeof result.applied?.seq).toBe("number");
    expect(result.observations.some((o) => o.type === "note_added")).toBe(true);
  });

  it("focus extends reachability so a focused $task's lifecycle verbs join the tool list", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-focus-task");
    const host = new McpHost(world);
    host.bindSession(session.id, session.actor);

    const seeded = await world.directCall("seed-min", "$wiz", "the_taskboard", "seed_minimal_policy", [session.actor], { forceDirect: true, forceReason: "test" });
    expect(seeded.op).toBe("result");
    const created = await world.directCall("mcp-create-task", session.actor, "the_taskboard", "create_task", ["task", "Focus me", "test body", [], null], { forceDirect: true, forceReason: "test" });
    expect(created.op).toBe("result");
    const taskRef = (created.op === "result" ? created.result : null) as string | null;
    expect(typeof taskRef).toBe("string");
    if (typeof taskRef !== "string") return;

    expect((await host.enumerateTools(session.actor, { scope: "focus" })).some((t) => t.object === taskRef)).toBe(false);

    const focus = (await host.enumerateTools(session.actor)).find((t) => t.object === session.actor && t.verb === "focus")!;
    await host.invokeTool(session.actor, session.id, focus, [taskRef]);

    const taskTools = (await host.enumerateTools(session.actor, { scope: "focus" })).filter((t) => t.object === taskRef);
    expect(taskTools.length).toBeGreaterThan(0);
    for (const lifecycle of ["claim", "pass", "release", "handoff", "reject", "wait", "yield", "drop_terminal"]) {
      expect(taskTools.some((t) => t.verb === lifecycle)).toBe(true);
    }

    const unfocus = (await host.enumerateTools(session.actor)).find((t) => t.object === session.actor && t.verb === "unfocus")!;
    await host.invokeTool(session.actor, session.id, unfocus, [taskRef]);
    expect((await host.enumerateTools(session.actor, { scope: "focus" })).some((t) => t.object === taskRef)).toBe(false);
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

  it("re-resolves enclosing space at invocation time so cross-scope moves route correctly", async () => {
    // The MCP tool cache records `enclosingSpace` at tools/list time. When an
    // actor moves to another room before the next invocation, the cached hint
    // is stale and would otherwise route the call to the actor's old scope —
    // the bug behind `missing_state` on `${A}__ways` after `southeast` in the
    // production walkthrough. The host re-resolves the enclosing space from
    // the live object graph on every invocation so the call lands on the
    // current scope without the client having to refresh tools/list first.
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-enclosing-space-restore");
    const passedScopes: Array<{ verb: string; scope: ObjRef | null | undefined }> = [];
    const host = new McpHost(world, {
      direct: async (_sessionId, actor, target, verb, _args, scope) => {
        passedScopes.push({ verb, scope });
        return { op: "result", result: null, observations: [], audience: null };
      },
      call: async (_sessionId, actor, space, message) => {
        passedScopes.push({ verb: message.verb, scope: space });
        return { op: "applied", space, seq: 1, ts: 0, message, observations: [] };
      }
    });
    host.bindSession(session.id, session.actor);

    // Build two side-by-side $room objects and a cached tool whose stored
    // enclosingSpace points at the actor's starting room. Then physically
    // move the actor and reissue the call — the second dispatch should hit
    // the second room rather than the cached one.
    world.createObject({ id: "host_test_room_a", name: "Room A", parent: "$room", owner: "$wiz" });
    world.createObject({ id: "host_test_room_b", name: "Room B", parent: "$room", owner: "$wiz" });
    world.object(session.actor).location = "host_test_room_a";

    const directTool: McpTool = {
      name: `${session.actor}__ways`,
      object: session.actor,
      verb: "ways",
      aliases: [],
      description: "",
      inputSchema: {},
      direct: true,
      enclosingSpace: "host_test_room_a"
    };
    await host.invokeTool(session.actor, session.id, directTool, []);
    expect(passedScopes[passedScopes.length - 1].scope).toBe("host_test_room_a");

    world.object(session.actor).location = "host_test_room_b";
    await host.invokeTool(session.actor, session.id, directTool, []);
    expect(passedScopes[passedScopes.length - 1].scope).toBe("host_test_room_b");
  });

  it("focus upgrades visible room contents from obvious affordances to explicit tools", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-focused-room-content");
    const host = new McpHost(world);
    host.bindSession(session.id, session.actor);
    await world.directCall(undefined, session.actor, "the_chatroom", "enter", []);

    world.createObject({ id: "focus_widget", name: "Focus Widget", parent: "$thing", owner: "$wiz", location: "the_chatroom" });
    const installed = installVerb(world, "focus_widget", "private_ping", `verb :private_ping() rxd {
  return "pong";
}`, null);
    expect(installed.ok).toBe(true);
    const verb = world.ownVerb("focus_widget", "private_ping");
    expect(verb).toBeDefined();
    if (verb) verb.tool_exposed = true;

    expect((await host.enumerateTools(session.actor, { scope: "here" })).some((t) => t.object === "focus_widget" && t.verb === "private_ping")).toBe(false);

    const focus = (await host.enumerateTools(session.actor)).find((t) => t.object === session.actor && t.verb === "focus")!;
    await host.invokeTool(session.actor, session.id, focus, ["focus_widget"]);

    expect((await host.enumerateTools(session.actor, { scope: "focus" })).some((t) => t.object === "focus_widget" && t.verb === "private_ping")).toBe(true);
    expect((await host.enumerateTools(session.actor, { scope: "object", object: "focus_widget" })).some((t) => t.object === "focus_widget" && t.verb === "private_ping")).toBe(true);
    expect((await host.enumerateTools(session.actor, { scope: "all" })).some((t) => t.object === "focus_widget" && t.verb === "private_ping")).toBe(true);
    await expect(host.resolveReachableTool(session.actor, "focus_widget", "private_ping")).resolves.toMatchObject({ object: "focus_widget", verb: "private_ping" });
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
    world.setProp(bob.actor, "focus_list", ["the_dubspace"]);
    await host.refreshToolList(bob.id, bob.actor);
    expect(bobNotifications).toBe(0);
    aliceInstance.dispose();
  });

  it("refreshes tool lists for v2 accepted-frame observers", async () => {
    const world = bootstrapWorld();
    world.setProp("$system", "guest_initial_room", null);
    const alice = world.auth("guest:mcp-v2-refresh-alice");
    const bob = world.auth("guest:mcp-v2-refresh-bob");
    const host = new McpHost(world);
    const bobInstance = createMcpServer({ world, host, actor: bob.actor, sessionId: bob.id });
    let bobNotifications = 0;
    (bobInstance.server as unknown as { notification: (notification: unknown) => Promise<void> }).notification = async () => { bobNotifications += 1; };
    await host.refreshToolList(bob.id, bob.actor);

    world.applyCommittedShadowTranscript({
      kind: "woo.effect_transcript.shadow.v1",
      id: "mcp-v2-observer-refresh",
      route: "direct",
      scope: "the_chatroom",
      seq: -1,
      session: alice.id,
      call: { actor: alice.actor, target: "the_chatroom", verb: "enter", args: [] },
      reads: [],
      writes: [
        { cell: { kind: "prop", object: "the_chatroom", name: "subscribers" }, value: [bob.actor, alice.actor], op: "set" },
        { cell: { kind: "prop", object: "the_chatroom", name: "session_subscribers" }, value: [
          { session: bob.id, actor: bob.actor },
          { session: alice.id, actor: alice.actor }
        ], op: "set" },
        { cell: { kind: "location", object: bob.actor }, value: "the_chatroom", op: "move" },
        { cell: { kind: "location", object: alice.actor }, value: "the_chatroom", op: "move" }
      ],
      creates: [],
      moves: [
        { object: bob.actor, from: "$nowhere", to: "the_chatroom" },
        { object: alice.actor, from: "$nowhere", to: "the_chatroom" }
      ],
      observations: [{ type: "entered", actor: alice.actor, room: "the_chatroom", text: "Alice entered.", ts: 1 }],
      logicalInputs: [],
      untrackedEffects: [],
      result: true,
      complete: true,
      incompleteReasons: [],
      hash: "mcp-v2-observer-refresh"
    });
    expect(world.activeScopeForSession(alice.id)).toBe("the_chatroom");
    host.routeShadowAcceptedFrame({
      kind: "woo.commit.accepted.shadow.v1",
      id: "mcp-v2-observer-refresh",
      position: { kind: "woo.scope_head.shadow.v1", scope: "the_chatroom", epoch: 1, seq: 1, hash: "head" },
      transcript_hash: "mcp-v2-observer-refresh",
      post_state_hash: "post",
      observations: [{ type: "entered", actor: alice.actor, room: "the_chatroom", text: "Alice entered.", ts: 1 }],
      receipt: {
        kind: "woo.commit_receipt.shadow.v1",
        id: "mcp-v2-observer-refresh",
        route: "direct",
        scope: "the_chatroom",
        seq: -1,
        transcript_hash: "mcp-v2-observer-refresh",
        pre_state_hash: "pre",
        post_state_hash: "post",
        accepted: true,
        errors: []
      }
    }, alice.id);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(bobNotifications).toBe(1);
    bobInstance.dispose();
  });

  it("applies v2 accepted transcript logs, counters, and modified times through the gateway cache", () => {
    const world = bootstrapWorld();
    world.setProp("$system", "guest_initial_room", null);
    const session = world.auth("guest:mcp-v2-cache-apply");
    const otherSession = world.auth("guest:mcp-v2-cache-apply-other");
    const metrics: MetricEvent[] = [];
    world.setMetricsHook((event) => metrics.push(event));
    world.attachSocket(session.id, "socket:mcp-v2-cache-apply");
    world.attachSocket(otherSession.id, "socket:mcp-v2-cache-apply-other");
    world.touchSessionInput(otherSession.id, 123_456);
    const before = world.exportWorld().objectCounter;
    const created = `mcp_cache_obj_${before + 10}`;
    const modifiedBefore = world.object(session.actor).modified;
    const transcript: EffectTranscript = {
      kind: "woo.effect_transcript.shadow.v1",
      id: "mcp-v2-cache-apply",
      route: "sequenced",
      scope: "the_chatroom",
      seq: 3,
      session: session.id,
      call: { actor: session.actor, target: "the_chatroom", verb: "cache_apply_probe", args: [] },
      reads: [],
      writes: [
        { cell: { kind: "prop", object: session.actor, name: "cache_probe" }, value: "updated", op: "set" }
      ],
      creates: [
        { object: created, name: "cache probe", parent: "$thing", owner: session.actor, location: "the_chatroom", anchor: null, flags: {}, writer: { progr: "$wiz", definer: "$thing", verb: "cache_apply_probe", thisObj: "the_chatroom", caller: session.actor, callerPerms: session.actor } }
      ],
      moves: [],
      observations: [{ type: "cache_apply_probe", actor: session.actor, source: "the_chatroom", text: "probe", ts: 1 }],
      logicalInputs: [],
      untrackedEffects: [],
      result: true,
      complete: true,
      incompleteReasons: [],
      hash: "mcp-v2-cache-apply"
    };
    const beforeApply = world.exportWorld();
    const timestamp = Date.now() + 1_000;
    let expected = applyShadowTranscriptToCommittedState(beforeApply, transcript, { objectTimestamp: timestamp });
    expected = applyShadowTranscriptToCommittedState(expected, transcript, { objectTimestamp: timestamp });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(timestamp);
      world.applyCommittedShadowTranscript(transcript);
      world.applyCommittedShadowTranscript(transcript);
    } finally {
      vi.useRealTimers();
    }

    const after = world.exportWorld();
    expect(after.objects).toEqual(expected.objects);
    expect(after.sessions).toEqual(expected.sessions);
    expect(after.logs).toEqual(expected.logs);
    expect(after.objectCounter).toBe(expected.objectCounter);
    const chatLog = after.logs.find(([space]) => space === "the_chatroom")?.[1] ?? [];
    expect(chatLog.filter((entry) => entry.seq === 3)).toHaveLength(1);
    expect(after.objectCounter).toBeGreaterThanOrEqual(before + 11);
    expect(world.sessions.get(session.id)?.attachedSockets.has("socket:mcp-v2-cache-apply")).toBe(true);
    expect(world.sessions.get(session.id)?.attachedSockets.has("socket:mcp-v2-cache-apply-other")).toBe(false);
    expect(world.sessions.get(otherSession.id)?.attachedSockets.has("socket:mcp-v2-cache-apply-other")).toBe(true);
    expect(world.sessions.get(otherSession.id)?.attachedSockets.has("socket:mcp-v2-cache-apply")).toBe(false);
    expect(world.sessions.get(otherSession.id)?.lastInputAt).toBe(123_456);
    expect(world.object(created).created).toBeGreaterThan(0);
    expect(world.object(created).modified).toBeGreaterThan(0);
    expect(world.object(session.actor).modified).toBeGreaterThanOrEqual(modifiedBefore);
    const gatewayApplyMetrics = metrics.filter((event) => event.kind === "shadow_gateway_apply_step");
    expect(gatewayApplyMetrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "shadow_gateway_apply_step", phase: "apply_creates", scope: "the_chatroom", route: "sequenced" }),
      expect.objectContaining({ kind: "shadow_gateway_apply_step", phase: "collect_writes", scope: "the_chatroom", route: "sequenced" }),
      expect.objectContaining({ kind: "shadow_gateway_apply_step", phase: "apply_writes", scope: "the_chatroom", route: "sequenced" }),
      expect.objectContaining({ kind: "shadow_gateway_apply_step", phase: "sort_objects", scope: "the_chatroom", route: "sequenced" }),
      expect.objectContaining({ kind: "shadow_gateway_apply_step", phase: "apply_session", scope: "the_chatroom", route: "sequenced" }),
      expect.objectContaining({ kind: "shadow_gateway_apply_step", phase: "apply_log", scope: "the_chatroom", route: "sequenced" }),
      expect.objectContaining({ kind: "shadow_gateway_apply_step", phase: "counters", scope: "the_chatroom", route: "sequenced" }),
      expect.objectContaining({ kind: "shadow_gateway_apply_step", phase: "total", scope: "the_chatroom", route: "sequenced" })
    ]));
    expect(gatewayApplyMetrics.find((event) => event.phase === "total")).toMatchObject({
      objects: expect.any(Number),
      properties: expect.any(Number),
      sessions: expect.any(Number),
      logs: expect.any(Number),
      creates: 1,
      writes: 1
    });
  });

  it("applies remote MCP shard commits in scope sequence order and dedups repeats", () => {
    const world = bootstrapWorld();
    world.setProp("the_chatroom", "next_seq", 5);
    const gateway = new McpGateway(world);
    const relay = createShadowBrowserRelayShim({
      node: "mcp-order-test",
      scope: "the_chatroom",
      serialized: world.exportWorld()
    });
    relay.commit_scope.head = { kind: "woo.scope_head.shadow.v1", scope: "the_chatroom", epoch: 1, seq: 4, hash: "head-4" };
    (gateway as unknown as { v2Scopes: Map<string, unknown> }).v2Scopes.set("the_chatroom", {
      scope: "the_chatroom",
      relay,
      openedSessions: new Set()
    });
    const transcript = (seq: number, value: string): EffectTranscript => ({
      kind: "woo.effect_transcript.shadow.v1",
      id: `remote-order-${seq}`,
      route: "sequenced",
      scope: "the_chatroom",
      seq,
      session: null,
      call: { actor: "$wiz", target: "the_chatroom", verb: "remote_order_probe", args: [value] },
      reads: [],
      writes: [
        { cell: { kind: "prop", object: "$wiz", name: "remote_order_probe" }, value, op: "set" },
        { cell: { kind: "prop", object: "the_chatroom", name: "next_seq" }, value: seq + 1, op: "set" }
      ],
      creates: [],
      moves: [],
      observations: [{ type: "remote_order_probe", source: "the_chatroom", text: value, ts: seq }],
      logicalInputs: [],
      untrackedEffects: [],
      result: true,
      complete: true,
      incompleteReasons: [],
      hash: `remote-order-${seq}`
    });
    const commit = (seq: number) => ({
      kind: "woo.commit.accepted.shadow.v1" as const,
      id: `remote-order-${seq}`,
      position: { kind: "woo.scope_head.shadow.v1" as const, scope: "the_chatroom", epoch: 1, seq, hash: `head-${seq}` },
      transcript_hash: `remote-order-${seq}`,
      post_state_hash: `post-${seq}`,
      observations: [{ type: "remote_order_probe", source: "the_chatroom", text: String(seq), ts: seq }],
      receipt: {
        kind: "woo.commit_receipt.shadow.v1" as const,
        id: `remote-order-${seq}`,
        route: "sequenced" as const,
        scope: "the_chatroom",
        seq,
        transcript_hash: `remote-order-${seq}`,
        pre_state_hash: `pre-${seq}`,
        post_state_hash: `post-${seq}`,
        accepted: true,
        errors: []
      }
    });

    gateway.acceptRemoteV2Commit("the_chatroom", commit(6), transcript(6, "six"));
    expect(world.propOrNull("$wiz", "remote_order_probe")).toBe(null);
    expect(world.getProp("the_chatroom", "next_seq")).toBe(5);

    gateway.acceptRemoteV2Commit("the_chatroom", commit(5), transcript(5, "five"));
    expect(world.propOrNull("$wiz", "remote_order_probe")).toBe("six");
    expect(world.getProp("the_chatroom", "next_seq")).toBe(7);

    gateway.acceptRemoteV2Commit("the_chatroom", commit(6), transcript(6, "six-duplicate"));
    expect(world.propOrNull("$wiz", "remote_order_probe")).toBe("six");
    expect(world.getProp("the_chatroom", "next_seq")).toBe(7);
  });

  it("matches the serialized applier for write-only v2 accepted transcripts", () => {
    const world = bootstrapWorld();
    world.setProp("$system", "guest_initial_room", null);
    const session = world.auth("guest:mcp-v2-cache-write-only");
    const beforeApply = world.exportWorld();
    const transcript: EffectTranscript = {
      kind: "woo.effect_transcript.shadow.v1",
      id: "mcp-v2-cache-write-only",
      route: "sequenced",
      scope: "the_chatroom",
      seq: 4,
      session: session.id,
      call: { actor: session.actor, target: "the_chatroom", verb: "cache_write_only_probe", args: [] },
      reads: [],
      writes: [
        { cell: { kind: "prop", object: session.actor, name: "cache_probe" }, value: "write-only", op: "set" },
        { cell: { kind: "location", object: session.actor }, value: "the_lobby", op: "set" },
        { cell: { kind: "contents", object: "the_chatroom" }, value: ["$wiz", session.actor], op: "set" }
      ],
      creates: [],
      moves: [],
      observations: [{ type: "cache_write_only_probe", actor: session.actor, source: "the_chatroom", text: "write-only", ts: 1 }],
      logicalInputs: [],
      untrackedEffects: [],
      result: true,
      complete: true,
      incompleteReasons: [],
      hash: "mcp-v2-cache-write-only"
    };
    const timestamp = Date.now() + 1_000;
    const expected = applyShadowTranscriptToCommittedState(beforeApply, transcript, { objectTimestamp: timestamp });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(timestamp);
      world.applyCommittedShadowTranscript(transcript);
    } finally {
      vi.useRealTimers();
    }

    const after = world.exportWorld();
    expect(after.objects).toEqual(expected.objects);
    expect(after.sessions).toEqual(expected.sessions);
    expect(after.logs).toEqual(expected.logs);
    expect(after.objectCounter).toBe(expected.objectCounter);
  });

  it("does not enumerate remote tools while sending post-call list_changed hints", async () => {
    const world = bootstrapWorld();
    // The bridge below declares the_chatroom remote; the lazy-refresh contract
    // tested here assumes the actor doesn't start out in a remote room.
    world.setProp("$system", "guest_initial_room", null);
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
    const sessionsBeforeInit = new Set(world.sessions.keys());

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
    const gatewaySession = Array.from(world.sessions.values()).find((candidate) => !sessionsBeforeInit.has(candidate.id)) ?? Array.from(world.sessions.values()).at(0);
    expect(gatewaySession).toBeDefined();
    if (gatewaySession) {
      const enteredChat = await world.directCall("mcp-enter-chat", gatewaySession.actor, "the_chatroom", "enter", []);
      expect(enteredChat.op).toBe("result");
    }

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

    // 3) Stable control tool — invoke a reachable direct verb by canonical handle.
    const stableCall = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "woo_call", arguments: { object: "the_chatroom", verb: "look", args: [] } }
    }, { "mcp-session-id": sessionId! }));
    expect(stableCall.ok).toBe(true);
    const stableCallBody = (await stableCall.json()) as { result: { isError?: boolean; structuredContent?: { result?: unknown } } };
    expect(stableCallBody.result.isError).not.toBe(true);

    // 4) DELETE closes the session
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
    const homePing = home.ownVerb("remote_widget", "ping");
    if (homePing) homePing.arg_spec = { ...homePing.arg_spec, command: { dobj: "this", prep: "none", iobj: "none", args_from: [] } };

    remote.createObject({ id: "remote_gallery", name: "Remote Gallery", parent: "$space", owner: "$wiz" });
    remote.createObject({ id: "remote_widget", name: "Remote Widget", parent: "$thing", owner: "$wiz", location: "remote_gallery" });
    remote.addVerb("remote_widget", nativeToolVerb("ping", "remote_ping"));
    const remotePing = remote.ownVerb("remote_widget", "ping");
    if (remotePing) remotePing.arg_spec = { ...remotePing.arg_spec, command: { dobj: "this", prep: "none", iobj: "none", args_from: [] } };
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
    const wooSession = Array.from(home.sessions.values())[0];
    const actor = wooSession?.actor;
    expect(actor).toBeTruthy();
    home.object(actor!).location = "remote_gallery";
    wooSession!.activeScope = "remote_gallery";
    home.object("remote_gallery").contents.add(actor!);
    remote.setSpaceSubscriber("remote_gallery", actor!, true, wooSession!.id);

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
    const remotePing = remote.ownVerb("remote_widget", "ping");
    if (remotePing) remotePing.arg_spec = { ...remotePing.arg_spec, command: { dobj: "this", prep: "none", iobj: "none", args_from: [] } };
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
      params: { name: "woo_focus", arguments: { target: "the_dubspace" } }
    }, { "mcp-session-id": sessionId! }));
    const focusedBody = (await focused.json()) as { result: { isError?: boolean; structuredContent?: { result?: unknown } } };
    expect(focusedBody.result.isError).not.toBe(true);
    expect(focusedBody.result.structuredContent?.result).toContain("the_dubspace");
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

  it("rejects first-request MCP tokens outside the woo auth token vocabulary", async () => {
    const world = bootstrapWorld();
    const gateway = new McpGateway(world);
    const response = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 91,
      method: "initialize",
      params: {}
    }, { "mcp-token": "not-a-real-token" }));

    expect(response.status).toBe(401);
    const body = await response.json() as { jsonrpc: string; id: number; error: { code: number; data?: { code?: string } } };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(91);
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

  it("resumes a session on a fresh gateway when the world session still exists (DO hibernation recovery)", async () => {
    const world = bootstrapWorld();
    const gateway1 = new McpGateway(world);

    const init = await gateway1.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0.0.0" }
      }
    }, { "mcp-token": "guest:hibernation-resume" }));
    expect(init.ok).toBe(true);
    const sessionId = init.headers.get("mcp-session-id");
    expect(typeof sessionId).toBe("string");
    expect((sessionId ?? "").length).toBeGreaterThan(0);

    const originalActor = world.sessions.get(sessionId!)?.actor;
    expect(originalActor).toBeTruthy();

    // Simulate DO hibernation by dropping gateway1 (its in-memory `sessions`
    // map dies with it) and standing up a fresh gateway over the same world.
    // The persisted world.sessions table is what carries the actor binding
    // across the cycle.
    const gateway2 = new McpGateway(world);

    const list = await gateway2.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list"
    }, { "mcp-session-id": sessionId! }));
    expect(list.ok).toBe(true);
    const listBody = (await list.json()) as { result: { tools: Array<{ name: string }> } };
    expect(Array.isArray(listBody.result.tools)).toBe(true);
    expect(listBody.result.tools.some((t) => t.name === "woo_call")).toBe(true);

    // Resumed entry must be bound to the same actor; calling a stable tool
    // that returns actor-scoped data should succeed.
    const stableCall = await gateway2.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "woo_list_reachable_tools", arguments: { scope: "active", limit: 4 } }
    }, { "mcp-session-id": sessionId! }));
    expect(stableCall.ok).toBe(true);
    const stableBody = (await stableCall.json()) as { result: { isError?: boolean } };
    expect(stableBody.result.isError).not.toBe(true);

    expect(world.sessions.get(sessionId!)?.actor).toBe(originalActor);
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
