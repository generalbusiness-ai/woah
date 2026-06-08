import { describe, expect, it, vi } from "vitest";
import { installVerb, installVerbAs } from "../src/core/authoring";
import { createWorld } from "../src/core/bootstrap";
import { McpHost, type McpTool } from "../src/mcp/host";
import { McpGateway } from "../src/mcp/gateway";
import { buildServerInstructions, createMcpServer } from "../src/mcp/server";
import { LocalSQLiteRepository } from "../src/server/sqlite-repository";
import type { EffectTranscript } from "../src/core/effect-transcript";
import {
  createShadowBrowserNode,
  createShadowBrowserRelayShim,
  openShadowBrowserScope,
  shadowStateTransferCacheDigest
} from "../src/core/shadow-browser-node";
import { applyShadowTranscriptToCommitScopeCache, createShadowCommitScope, serializedFor, type ShadowCommitAccepted } from "../src/core/shadow-commit-scope";
import type { MetricEvent, Observation, ObjRef, RemoteToolDescriptor, RemoteToolRequest, VerbDef, WooValue } from "../src/core/types";
import type { CallContext, ExecutorContext, MoveObjectResult, RoomSnapshot, ScopedObjectSummary, WooWorld } from "../src/core/world";
import type { ProjectionWrite, SessionToolManifest } from "../src/core/projection-delta";

function bootstrapWorld() {
  return createWorld();
}

function mcpTestTranscript(overrides: Partial<EffectTranscript> & { call: EffectTranscript["call"] }): EffectTranscript {
  return {
    kind: "woo.effect_transcript.shadow.v1",
    id: "mcp-test-transcript",
    route: "direct",
    scope: "the_chatroom",
    seq: -1,
    session: null,
    reads: [],
    writes: [],
    creates: [],
    moves: [],
    observations: [],
    logicalInputs: [],
    untrackedEffects: [],
    result: true,
    complete: true,
    incompleteReasons: [],
    hash: "mcp-test-transcript",
    ...overrides
  };
}

function attachTranscriptForTest<T extends object>(frame: T, transcript: EffectTranscript): T {
  Object.defineProperty(frame, "transcript", { value: transcript, enumerable: false });
  return frame;
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

class RemoteToolBridge implements ExecutorContext {
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

  async enumerateRemoteTools(actor: ObjRef, requests: RemoteToolRequest[]): Promise<RemoteToolDescriptor[]> {
    const out: RemoteToolDescriptor[] = [];
    for (const request of requests) {
      const id = request.id;
      const host = this.routes.get(id);
      if (!host || host === this.localHost) continue;
      const mcpHost = this.hosts.get(host);
      if (!mcpHost) continue;
      out.push(...mcpHost.enumerateLocalToolDescriptors(actor, [request]));
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

  it("exposes inherited default look on ordinary visible contents", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-default-look");
    const host = new McpHost(world);
    host.bindSession(session.id, session.actor);

    await world.directCall(undefined, session.actor, "the_chatroom", "enter", []);
    const tools = await host.enumerateTools(session.actor, { scope: "here" });
    const couchLook = tools.find((tool) => tool.object === "the_couch" && tool.verb === "look");
    expect(couchLook).toBeDefined();
    expect(couchLook?.direct).toBe(true);
    expect(couchLook?.inputSchema).toMatchObject({ properties: {} });
    expect((couchLook?.inputSchema as { required?: unknown[] }).required ?? []).toEqual([]);
    expect(tools.some((tool) => tool.object === "the_couch" && tool.verb === "moveto")).toBe(false);

    const resolved = await host.resolveReachableTool(session.actor, "the_couch", "look");
    expect(resolved).toBeDefined();
    const result = await host.invokeTool(session.actor, session.id, resolved!, []);
    expect(result.result).toMatchObject({ id: "the_couch", title: "Couch" });
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "looked", target: "the_couch", room: "the_chatroom" })
    ]));
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

    // Regression for notes/2026-05-16-online-walkthrough.md Bug 9.2:
    // the cockatoo's teach tool MUST expose its single argument under
    // the same name the verb body destructures (`phrase`), so MCP
    // clients can call {phrase: "..."} and not hit
    // `E_TYPE: teach requires a string phrase` from a missing key.
    const teachTool = byObjVerb.get("the_cockatoo:teach");
    expect(teachTool).toBeDefined();
    const teachProperties = teachTool!.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(teachProperties)).toEqual(["phrase"]);
  });

  it("threads inherited tool definers into dispatch options", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-definer-prefetch");
    let capturedOptions: { toolDefiner?: ObjRef; toolSupportObjectIds?: ObjRef[] } | undefined;
    const host = new McpHost(world, {
      direct: async (_sessionId, actor, target, verb, args, scope, _persistence, options) => {
        capturedOptions = options;
        return attachTranscriptForTest({
          op: "result",
          id: "mcp-definer-prefetch",
          result: true,
          observations: [],
          audience: null
        }, mcpTestTranscript({
          route: "direct",
          scope: scope ?? "#-1",
          call: { actor, target, verb, args }
        }));
      }
    });
    host.bindSession(session.id, session.actor);

    await world.directCall(undefined, session.actor, "the_chatroom", "enter", [], { sessionId: session.id });
    const tool = await host.resolveReachableTool(session.actor, "the_chatroom", "southeast", session.id);

    expect(tool?.descriptor).toMatchObject({ object: "the_chatroom", verb: "southeast", definer: "$room" });
    await host.invokeTool(session.actor, session.id, tool!, []);
    expect(capturedOptions?.toolDefiner).toBe("$room");
    expect(capturedOptions?.toolSupportObjectIds).toEqual(expect.arrayContaining(["the_chatroom", "$chatroom", "$room"]));
  });

  // Regression for the tool-surface verb cache (notes/2026-05-28-...): a $space
  // full of same-class items (an outline whose nodes live in its contents) must
  // not recompute the verb surface once per item. Before the cache,
  // enumerateLocalToolDescriptors over the_outline ran obviousCommandVerbs per
  // node, was O(items x ancestry x verbs), and blew the 5s host read budget —
  // the scope then contributed zero tools and `enter` resolved as E_VERBNF.
  it("collapses the obvious verb surface across same-class space contents and invalidates on edit", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:tool-surface-cache");
    const host = new McpHost(world);
    host.bindSession(session.id, session.actor);

    // A space whose children are all instances of one item class, mirroring an
    // outline whose nodes moveto into the outliner's contents.
    world.createObject({ id: "cache_space", name: "Cache Space", parent: "$space", owner: "$wiz" });
    world.createObject({ id: "cache_item", name: "Cache Item Class", parent: "$thing", owner: "$wiz" });
    expect(installVerb(world, "cache_item", "poke", `verb :poke() rxd {
  return "poked";
}`, null).ok).toBe(true);
    const pokeVerb = world.ownVerb("cache_item", "poke");
    expect(pokeVerb).toBeDefined();
    if (pokeVerb) pokeVerb.arg_spec = { ...pokeVerb.arg_spec, command: { dobj: "this", prep: "none", iobj: "none", args_from: [] } };

    const itemCount = 60;
    for (let i = 0; i < itemCount; i++) {
      world.createObject({ id: `cache_item_${i}`, name: `Item ${i}`, parent: "cache_item", owner: "$wiz", location: "cache_space" });
    }

    const request: RemoteToolRequest = { id: "cache_space", projection: "tools", expandContents: true, contentsProjection: "obvious" };
    const surfaceSpy = vi.spyOn(world, "obviousCommandVerbs");

    const first = host.enumerateLocalToolDescriptors(session.actor, [request]);

    // Correctness: every item advertises poke, and each descriptor carries its
    // OWN object id and source-row authority scope — not the first item's, which
    // would happen if the per-object owner default were baked into the cache.
    for (let i = 0; i < itemCount; i++) {
      const descriptor = first.find((d) => d.object === `cache_item_${i}` && d.verb === "poke");
      expect(descriptor).toBeDefined();
      expect(descriptor!.source_rows?.every((row) => row.authority_scope === `cache_item_${i}`)).toBe(true);
    }

    // Collapse: 60 same-class items share one obvious-verb walk. (The space id
    // itself uses the tools projection, which does not call obviousCommandVerbs.)
    expect(surfaceSpy.mock.calls.length).toBe(1);

    // Cross-call hold: a second identical enumeration with no intervening world
    // mutation reuses the cache and does not recompute.
    surfaceSpy.mockClear();
    const second = host.enumerateLocalToolDescriptors(session.actor, [request]);
    expect(second.filter((d) => d.verb === "poke").length).toBe(itemCount);
    expect(surfaceSpy.mock.calls.length).toBe(0);

    // Invalidation: editing a verb on the item class bumps the world mutation
    // version, which drops the cache, so the next enumeration both recomputes
    // and reflects the new verb on every item.
    surfaceSpy.mockClear();
    expect(installVerb(world, "cache_item", "prod", `verb :prod() rxd {
  return "prodded";
}`, null).ok).toBe(true);
    const prodVerb = world.ownVerb("cache_item", "prod");
    if (prodVerb) prodVerb.arg_spec = { ...prodVerb.arg_spec, command: { dobj: "this", prep: "none", iobj: "none", args_from: [] } };

    const third = host.enumerateLocalToolDescriptors(session.actor, [request]);
    expect(surfaceSpy.mock.calls.length).toBe(1);
    expect(third.filter((d) => d.verb === "prod").length).toBe(itemCount);
    expect(third.filter((d) => d.verb === "poke").length).toBe(itemCount);
    surfaceSpy.mockRestore();
  });

  // Regression: the verb-surface cache key must NOT collapse two objects that
  // share a parent but each define their OWN verb of the same name. Keying own
  // verbs by name alone aliased their distinct arg_spec/source/owner, so the
  // second object was emitted with the first's schema and source_rows.
  it("does not alias same-named instance-owned verbs across same-parent objects", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:tool-surface-own-verbs");
    const host = new McpHost(world);
    host.bindSession(session.id, session.actor);

    world.createObject({ id: "own_space", name: "Own Space", parent: "$space", owner: "$wiz" });
    world.createObject({ id: "tool_a", name: "Tool A", parent: "$thing", owner: "$wiz", location: "own_space" });
    world.createObject({ id: "tool_b", name: "Tool B", parent: "$thing", owner: "$wiz", location: "own_space" });

    // Same verb name, different parameters and bodies — defined directly on each
    // instance, so neither is inherited from the shared $thing parent.
    expect(installVerb(world, "tool_a", "zap", `verb :zap(alpha) rxd {
  return alpha;
}`, null).ok).toBe(true);
    expect(installVerb(world, "tool_b", "zap", `verb :zap(beta, gamma) rxd {
  return beta;
}`, null).ok).toBe(true);
    for (const id of ["tool_a", "tool_b"]) {
      const verb = world.ownVerb(id, "zap")!;
      verb.tool_exposed = true;
      verb.arg_spec = { ...verb.arg_spec, command: { dobj: "this", prep: "none", iobj: "none", args_from: [] } };
    }

    // tools projection (direct per-object requests). Under the aliasing bug,
    // tool_b's zap was emitted with tool_a's source, arg_spec, and source_rows.
    const tooled = host.enumerateLocalToolDescriptors(session.actor, [
      { id: "tool_a", projection: "tools" },
      { id: "tool_b", projection: "tools" }
    ]);
    const aTools = tooled.find((d) => d.object === "tool_a" && d.verb === "zap")!;
    const bTools = tooled.find((d) => d.object === "tool_b" && d.verb === "zap")!;
    expect(aTools).toBeDefined();
    expect(bTools).toBeDefined();
    expect(aTools.source).toContain("return alpha");
    expect(bTools.source).toContain("return beta");
    expect(aTools.arg_spec).not.toEqual(bTools.arg_spec);
    expect(aTools.source_rows?.every((row) => row.authority_scope === "tool_a")).toBe(true);
    expect(bTools.source_rows?.every((row) => row.authority_scope === "tool_b")).toBe(true);

    // obvious contents projection (the outline-shaped fan-out path).
    const obvious = host.enumerateLocalToolDescriptors(session.actor, [
      { id: "own_space", projection: "tools", expandContents: true, contentsProjection: "obvious" }
    ]);
    const aObv = obvious.find((d) => d.object === "tool_a" && d.verb === "zap")!;
    const bObv = obvious.find((d) => d.object === "tool_b" && d.verb === "zap")!;
    expect(aObv).toBeDefined();
    expect(bObv).toBeDefined();
    expect(aObv.source).toContain("return alpha");
    expect(bObv.source).toContain("return beta");
    expect(aObv.arg_spec).not.toEqual(bObv.arg_spec);
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
    // Regression for notes/2026-05-16-online-walkthrough.md Bug 5:
    // an actor inside `the_dubspace` (`$transparent`) sees ONE `said`
    // for one `say`. The engine still emits two raw observations (one
    // local, one forwarded upward to the chatroom for outside
    // listeners), but the MCP layer trims to the caller's session
    // audience so the dubspace tab matches the chatroom tab in
    // single-utterance count.
    await world.directCall(undefined, session.actor, "the_dubspace", "enter", [], { sessionId: session.id });
    const dubspaceSayTool = (await host.enumerateTools(session.actor)).find((t) => t.object === "the_dubspace" && t.verb === "say")!;
    expect(dubspaceSayTool).toBeDefined();
    const dubspaceSay = await host.invokeTool(session.actor, session.id, dubspaceSayTool, ["beat"]);
    const saidEvents = dubspaceSay.observations.filter((o) => o.type === "said");
    expect(saidEvents).toHaveLength(1);
    expect(saidEvents[0]).toMatchObject({ source: "the_dubspace", text: "beat" });

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
      persistence: "durable",
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
      persistence: "durable",
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
      direct: async (_sessionId, _actor, _target, verb, _args, scope) => {
        passedScopes.push({ verb, scope });
        return { op: "result", result: null, observations: [], audience: null };
      },
      call: async (_sessionId, _actor, space, message) => {
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
      persistence: "durable",
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

  it("marks tools/list snapshots as seen so the next move notifies", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-list-seen");
    const host = new McpHost(world);
    host.bindSession(session.id, session.actor);
    let notifications = 0;
    const unregister = host.onToolListChanged((actor) => {
      if (actor === session.actor) notifications += 1;
    });

    await host.markToolListSeen(session.id, session.actor);
    await world.directCall(undefined, session.actor, "the_chatroom", "southeast", [], { sessionId: session.id });
    await host.refreshToolList(session.id, session.actor);

    expect(notifications).toBe(1);
    unregister();
  });

  it("skips post-call tool-list refresh when the v2 transcript cannot affect reachability", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-skip-refresh-say");
    world.object(session.actor).location = "the_chatroom";
    const metrics: MetricEvent[] = [];
    world.setMetricsHook((event) => metrics.push(event));
    const transcript = mcpTestTranscript({
      id: "mcp-skip-refresh-say",
      session: session.id,
      call: { actor: session.actor, target: session.actor, verb: "say", args: ["hi"] },
      observations: [{ type: "said", actor: session.actor, source: "the_chatroom", text: "hi", ts: 1 }],
      hash: "mcp-skip-refresh-say"
    });
    const host = new McpHost(world, {
      direct: async () => {
        return attachTranscriptForTest(
          { op: "result" as const, result: true, observations: transcript.observations, audience: "the_chatroom" },
          transcript
        );
      }
    });
    host.bindSession(session.id, session.actor);
    const refreshSpy = vi.spyOn(host, "refreshToolList");
    const tool: McpTool = {
      name: `${session.actor}__say`,
      object: session.actor,
      verb: "say",
      aliases: [],
      description: "",
      inputSchema: {},
      direct: true,
      persistence: "live",
      enclosingSpace: "the_chatroom"
    };

    await host.invokeTool(session.actor, session.id, tool, ["hi"]);

    expect(refreshSpy).not.toHaveBeenCalled();
    expect(metrics).toContainEqual(expect.objectContaining({
      kind: "mcp_tool_refresh_skipped",
      source: "invoke",
      reason: "no_reachability_change",
      transcript: true
    }));
  });

  it("refreshes post-call tools when the v2 transcript changes actor focus or room contents", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-refresh-reachability");
    world.object(session.actor).location = "the_chatroom";
    const metrics: MetricEvent[] = [];
    world.setMetricsHook((event) => metrics.push(event));
    let transcript = mcpTestTranscript({
      id: "mcp-refresh-focus",
      session: session.id,
      call: { actor: session.actor, target: session.actor, verb: "focus", args: ["the_pinboard"] },
      writes: [{ cell: { kind: "prop", object: session.actor, name: "focus_list" }, value: ["the_pinboard"], op: "set" }],
      hash: "mcp-refresh-focus"
    });
    const host = new McpHost(world, {
      direct: async () => {
        if (transcript.id === "mcp-refresh-digest-fallback") {
          const before = world.object(session.actor).location;
          world.object(session.actor).location = before === "the_chatroom" ? "the_deck" : "the_chatroom";
        }
        return attachTranscriptForTest(
          { op: "result" as const, result: true, observations: [], audience: null },
          transcript
        );
      }
    });
    host.bindSession(session.id, session.actor);
    const refreshSpy = vi.spyOn(host, "refreshToolList").mockResolvedValue(true);
    const tool: McpTool = {
      name: `${session.actor}__probe`,
      object: session.actor,
      verb: "probe",
      aliases: [],
      description: "",
      inputSchema: {},
      direct: true,
      persistence: "durable",
      enclosingSpace: "the_chatroom"
    };

    await host.invokeTool(session.actor, session.id, tool, ["the_pinboard"]);
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    transcript = mcpTestTranscript({
      id: "mcp-refresh-room-contents",
      session: session.id,
      call: { actor: session.actor, target: "the_chatroom", verb: "drop", args: ["widget"] },
      moves: [{ object: "widget", from: session.actor, to: "the_chatroom" }],
      writes: [
        { cell: { kind: "location", object: "widget" }, value: "the_chatroom", op: "move" },
        { cell: { kind: "contents", object: "the_chatroom" }, value: ["widget"], op: "set" }
      ],
      hash: "mcp-refresh-room-contents"
    });
    await host.invokeTool(session.actor, session.id, tool, ["widget"]);
    expect(refreshSpy).toHaveBeenCalledTimes(2);

    transcript = mcpTestTranscript({
      id: "mcp-refresh-digest-fallback",
      session: session.id,
      call: { actor: session.actor, target: session.actor, verb: "probe", args: [] },
      hash: "mcp-refresh-digest-fallback"
    });
    await host.invokeTool(session.actor, session.id, tool, []);
    expect(refreshSpy).toHaveBeenCalledTimes(3);

    expect(metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "mcp_tool_refresh_taken", source: "invoke", reason: "focus_list", transcript: true }),
      expect.objectContaining({ kind: "mcp_tool_refresh_taken", source: "invoke", reason: "actor_contents", transcript: true }),
      expect.objectContaining({ kind: "mcp_tool_refresh_taken", source: "invoke", reason: "actor_location", transcript: true })
    ]));
  });

  it("saves an active remote manifest after a move when the gateway actor row is stale", async () => {
    const home = bootstrapWorld();
    const remote = bootstrapWorld();
    const remoteHost = new McpHost(remote);
    const worlds = new Map<string, WooWorld>([
      ["home", home],
      ["remote", remote]
    ]);
    const routes = new Map<ObjRef, string>([["remote_room", "remote"]]);
    const hosts = new Map<string, McpHost>([["remote", remoteHost]]);
    home.setExecutorContext(new RemoteToolBridge("home", worlds, routes, hosts));
    remote.setExecutorContext(new RemoteToolBridge("remote", worlds, routes, hosts));

    remote.createObject({ id: "remote_room", name: "Remote Room", parent: "$space", owner: "$wiz" });
    remote.addVerb("remote_room", nativeToolVerb("west", "remote_west"));
    remote.registerNativeHandler("remote_west", () => "west");

    const session = home.auth("guest:mcp-post-move-manifest");
    home.object(session.actor).location = "$nowhere";
    session.activeScope = "$nowhere";
    const transcript = mcpTestTranscript({
      id: "mcp-post-move-manifest",
      session: session.id,
      call: { actor: session.actor, target: session.actor, verb: "probe", args: [] },
      moves: [{ object: session.actor, from: "$nowhere", to: "remote_room" }],
      writes: [{ cell: { kind: "location", object: session.actor }, value: "remote_room", op: "move" }],
      hash: "mcp-post-move-manifest"
    });
    let saved: SessionToolManifest | null = null;
    const host = new McpHost(home, {
      direct: async () => {
        // Reproduce the production split-brain shape: session routing updates
        // from projection rows, but the gateway-local actor object still reads
        // as $nowhere until a later authority refresh.
        session.activeScope = "remote_room";
        home.object(session.actor).location = "$nowhere";
        return attachTranscriptForTest(
          { op: "result" as const, result: true, observations: [], audience: null },
          transcript
        );
      }
    }, {
      staleFallback: true,
      loadSessionManifest: () => saved,
      saveSessionManifest: (manifest) => { saved = manifest; }
    });
    host.bindSession(session.id, session.actor);
    const tool: McpTool = {
      name: `${session.actor}__probe`,
      object: session.actor,
      verb: "probe",
      aliases: [],
      description: "",
      inputSchema: {},
      direct: true,
      persistence: "durable",
      enclosingSpace: null
    };

    await host.invokeTool(session.actor, session.id, tool, []);

    const savedManifest = saved as SessionToolManifest | null;
    if (!savedManifest) throw new Error("expected a saved session manifest");
    expect(savedManifest.active_scope).toBe("remote_room");
    expect(savedManifest.tools.map((candidate) => `${candidate.object}:${candidate.verb}`)).toContain("remote_room:west");
    const here = await host.listTools(session.actor, { scope: "here", sessionId: session.id });
    expect(here.tools.map((candidate) => `${candidate.object}:${candidate.verb}`)).toContain("remote_room:west");
  });

  it("refreshes post-call tools when the v2 transcript writes verb shape", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-refresh-verb-shape");
    world.object(session.actor).location = "the_chatroom";
    const transcript = mcpTestTranscript({
      id: "mcp-refresh-verb-shape",
      session: session.id,
      call: { actor: session.actor, target: session.actor, verb: "program", args: [] },
      writes: [{ cell: { kind: "verb", object: "$thing", name: "new_tool" }, value: { tool_exposed: true }, op: "set" }],
      hash: "mcp-refresh-verb-shape"
    });
    const host = new McpHost(world, {
      direct: async () => attachTranscriptForTest(
        { op: "result" as const, result: true, observations: [], audience: null },
        transcript
      )
    });
    host.bindSession(session.id, session.actor);
    const refreshSpy = vi.spyOn(host, "refreshToolList").mockResolvedValue(true);
    const tool: McpTool = {
      name: `${session.actor}__program`,
      object: session.actor,
      verb: "program",
      aliases: [],
      description: "",
      inputSchema: {},
      direct: true,
      persistence: "durable",
      enclosingSpace: "the_chatroom"
    };

    await host.invokeTool(session.actor, session.id, tool, []);

    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it("skips accepted-frame observer refresh when the transcript only emits observations", async () => {
    const world = bootstrapWorld();
    world.setProp("$system", "guest_initial_room", null);
    const alice = world.auth("guest:mcp-observer-no-refresh-alice");
    const bob = world.auth("guest:mcp-observer-no-refresh-bob");
    world.object(alice.actor).location = "the_chatroom";
    world.object(bob.actor).location = "the_chatroom";
    world.object("the_chatroom").contents.add(alice.actor);
    world.object("the_chatroom").contents.add(bob.actor);
    world.setProp("the_chatroom", "subscribers", [alice.actor, bob.actor]);
    const metrics: MetricEvent[] = [];
    world.setMetricsHook((event) => metrics.push(event));
    const host = new McpHost(world);
    host.bindSession(alice.id, alice.actor);
    host.bindSession(bob.id, bob.actor);
    const refreshSpy = vi.spyOn(host, "refreshToolList").mockResolvedValue(false);
    const transcript = mcpTestTranscript({
      id: "mcp-observer-no-refresh",
      session: alice.id,
      call: { actor: alice.actor, target: alice.actor, verb: "say", args: ["hi"] },
      observations: [{ type: "said", actor: alice.actor, source: "the_chatroom", text: "hi", ts: 1 }],
      hash: "mcp-observer-no-refresh"
    });

    host.routeShadowAcceptedFrame({
      kind: "woo.commit.accepted.shadow.v1",
      id: "mcp-observer-no-refresh",
      position: { kind: "woo.scope_head.shadow.v1", scope: "the_chatroom", epoch: 1, seq: 1, hash: "head" },
      transcript_hash: "mcp-observer-no-refresh",
      post_state_hash: "post",
      observations: transcript.observations,
      receipt: {
        kind: "woo.commit_receipt.shadow.v1",
        id: "mcp-observer-no-refresh",
        route: "direct",
        scope: "the_chatroom",
        seq: -1,
        transcript_hash: "mcp-observer-no-refresh",
        pre_state_hash: "pre",
        post_state_hash: "post",
        accepted: true,
        errors: []
      }
    }, alice.id, transcript);

    const waitTool: McpTool = {
      name: `${bob.actor}__wait`,
      object: bob.actor,
      verb: "wait",
      aliases: [],
      description: "",
      inputSchema: {},
      direct: true,
      persistence: "durable",
      enclosingSpace: "the_chatroom"
    };
    const drained = await host.invokeTool(bob.actor, bob.id, waitTool, [0, 10]);

    expect(refreshSpy).not.toHaveBeenCalled();
    expect((drained.result as { observations?: Observation[] }).observations).toEqual(transcript.observations);
    expect(metrics).toContainEqual(expect.objectContaining({
      kind: "mcp_tool_refresh_skipped",
      source: "accepted_frame",
      actor: bob.actor,
      reason: "no_reachability_change",
      transcript: true
    }));
  });

  it("routes accepted-frame observations by session audience when local session scope is stale", async () => {
    const world = bootstrapWorld();
    world.setProp("$system", "guest_initial_room", null);
    const alice = world.auth("guest:mcp-v2-audience-origin");
    const bob = world.auth("guest:mcp-v2-audience-recipient");
    world.object(alice.actor).location = "the_chatroom";
    world.object(bob.actor).location = "the_chatroom";
    const bobSession = world.sessions.get(bob.id);
    expect(bobSession).toBeTruthy();
    bobSession!.activeScope = "$nowhere";
    const metrics: MetricEvent[] = [];
    world.setMetricsHook((event) => metrics.push(event));
    const host = new McpHost(world);
    host.bindSession(bob.id, bob.actor);
    const transcript = mcpTestTranscript({
      id: "mcp-v2-session-audience",
      session: alice.id,
      call: { actor: alice.actor, target: "the_chatroom", verb: "enter", args: [] },
      observations: [{ type: "entered", actor: alice.actor, room: "the_chatroom", source: "the_chatroom", text: "Alice entered.", ts: 1 }],
      hash: "mcp-v2-session-audience"
    });

    host.routeShadowAcceptedFrame({
      kind: "woo.commit.accepted.shadow.v1",
      id: "mcp-v2-session-audience",
      position: { kind: "woo.scope_head.shadow.v1", scope: "the_chatroom", epoch: 1, seq: 1, hash: "head" },
      transcript_hash: "mcp-v2-session-audience",
      post_state_hash: "post",
      observations: transcript.observations,
      receipt: {
        kind: "woo.commit_receipt.shadow.v1",
        id: "mcp-v2-session-audience",
        route: "direct",
        scope: "the_chatroom",
        seq: -1,
        transcript_hash: "mcp-v2-session-audience",
        pre_state_hash: "pre",
        post_state_hash: "post",
        accepted: true,
        errors: []
      }
    }, alice.id, transcript, {
      audienceSessions: [bob.id],
      observationSessionAudiences: [[bob.id]]
    });

    const waitTool: McpTool = {
      name: `${bob.actor}__wait`,
      object: bob.actor,
      verb: "wait",
      aliases: [],
      description: "",
      inputSchema: {},
      direct: true,
      persistence: "durable",
      enclosingSpace: "the_chatroom"
    };
    const drained = await host.invokeTool(bob.actor, bob.id, waitTool, [0, 10]);

    expect((drained.result as { observations?: Observation[] }).observations).toEqual(transcript.observations);
    expect(metrics).toContainEqual(expect.objectContaining({
      kind: "mcp_observation_routed",
      route: "accepted",
      queues_scanned: 1,
      deliveries: 1
    }));
  });

  it("routes actor focus-list reads through direct dispatch hooks", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-focus-list-dispatch");
    const metrics: MetricEvent[] = [];
    world.setMetricsHook((event) => metrics.push(event));
    const direct = vi.fn(async () => ({ op: "result" as const, result: [], observations: [], audience: null }));
    const host = new McpHost(world, {
      direct
    });
    host.bindSession(session.id, session.actor);
    const refreshSpy = vi.spyOn(host, "refreshToolList").mockResolvedValue(false);
    const tool: McpTool = {
      name: `${session.actor}__focus_list`,
      object: session.actor,
      verb: "focus_list",
      aliases: [],
      description: "",
      inputSchema: {},
      direct: true,
      persistence: "durable",
      enclosingSpace: "the_chatroom"
    };

    await host.invokeTool(session.actor, session.id, tool, []);

    expect(direct).toHaveBeenCalledWith(session.id, session.actor, session.actor, "focus_list", [], "the_chatroom", "durable", {
      directorySessionScopes: []
    });
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(metrics).toContainEqual(expect.objectContaining({
      kind: "mcp_tool_refresh_taken",
      source: "invoke",
      reason: "no_transcript",
      transcript: false
    }));
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
    const timestamp = Date.now() + 1_000;

    vi.useFakeTimers();
    try {
      vi.setSystemTime(timestamp);
      world.applyCommittedShadowTranscript(transcript);
      world.applyCommittedShadowTranscript(transcript);
    } finally {
      vi.useRealTimers();
    }

    const after = world.exportWorld();
    const chatLog = after.logs.find(([space]) => space === "the_chatroom")?.[1] ?? [];
    expect(chatLog.filter((entry) => entry.seq === 3)).toHaveLength(1);
    expect(after.objectCounter).toBeGreaterThanOrEqual(before + 11);
    expect(world.getProp(session.actor, "cache_probe")).toBe("updated");
    expect(world.object(created)).toMatchObject({
      id: created,
      name: "cache probe",
      parent: "$thing",
      owner: session.actor,
      location: "the_chatroom"
    });
    expect(world.object("$thing").children).toContain(created);
    expect(world.object("the_chatroom").contents).toContain(created);
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

  it("applies projection-cache fanout to the volatile gateway routing cache", () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-v2-external-projection-fanout");
    const metrics: MetricEvent[] = [];
    world.setMetricsHook((event) => metrics.push(event));
    const gateway = new McpGateway(world);
    const row = structuredClone(world.exportObjects([session.actor])[0]!);
    row.properties = [...row.properties, ["fanout_probe", "remote"]];
    const write: ProjectionWrite = {
      table: "objects",
      key: session.actor,
      op: "upsert",
      row,
      bytes: 100
    };
    const transcript = mcpTestTranscript({
      id: "mcp-v2-external-projection-fanout",
      route: "sequenced",
      scope: "the_chatroom",
      seq: 1,
      session: session.id,
      call: { actor: session.actor, target: "the_chatroom", verb: "fanout_probe", args: [] },
      writes: [{ cell: { kind: "prop", object: session.actor, name: "fanout_probe" }, value: "remote", op: "set" }],
      observations: [],
      hash: "mcp-v2-external-projection-fanout"
    });
    const commit: ShadowCommitAccepted = {
      kind: "woo.commit.accepted.shadow.v1",
      id: "mcp-v2-external-projection-fanout",
      position: {
        kind: "woo.scope_head.shadow.v1",
        scope: "the_chatroom",
        epoch: 1,
        seq: 1,
        hash: "h1"
      },
      transcript_hash: transcript.hash,
      post_state_hash: "post",
      observations: [],
      receipt: {
        kind: "woo.commit_receipt.shadow.v1",
        id: transcript.id,
        route: transcript.route,
        scope: transcript.scope,
        seq: transcript.seq,
        transcript_hash: transcript.hash,
        pre_state_hash: "pre",
        post_state_hash: "post",
        accepted: true,
        errors: []
      },
      projection_delta: {
        objects: [{ key: session.actor, op: "upsert", bytes: write.bytes }],
        projection_bytes: write.bytes
      },
      projection_writes: [write]
    };

    gateway.acceptRemoteV2Commit("the_chatroom", commit, transcript);

    expect(world.propOrNull(session.actor, "fanout_probe")).toBe("remote");
    expect(metrics).toContainEqual(expect.objectContaining({
      kind: "gateway_projection_apply",
      source: "fanout",
      rows: 1,
      projection_bytes: 100
    }));
    expect(metrics.some((event) => event.kind === "shadow_gateway_apply_step")).toBe(false);
  });

  it("routes projection-cache fanout after applying session active-scope rows", async () => {
    const world = bootstrapWorld();
    world.setProp("$system", "guest_initial_room", null);
    const alice = world.auth("guest:mcp-v2-fanout-routing-alice");
    const bob = world.auth("guest:mcp-v2-fanout-routing-bob");
    const metrics: MetricEvent[] = [];
    world.setMetricsHook((event) => metrics.push(event));
    const gateway = new McpGateway(world);
    gateway.bindActorSession(bob.id, bob.actor);
    expect(world.activeScopeForSession(bob.id)).toBe("$nowhere");

    const bobSessionRow = structuredClone(world.exportSessions().find((row) => row.id === bob.id)!);
    bobSessionRow.activeScope = "the_chatroom";
    const write: ProjectionWrite = {
      table: "sessions",
      key: bob.id,
      op: "upsert",
      row: bobSessionRow,
      bytes: 100
    };
    const observation: Observation = { type: "entered", source: "the_chatroom", actor: alice.actor, room: "the_chatroom", text: "Alice entered.", ts: 1 };
    const transcript = mcpTestTranscript({
      id: "mcp-v2-fanout-routing-cache",
      route: "sequenced",
      scope: "the_chatroom",
      seq: 2,
      session: alice.id,
      call: { actor: alice.actor, target: "the_chatroom", verb: "enter", args: [] },
      writes: [],
      observations: [observation],
      hash: "mcp-v2-fanout-routing-cache"
    });
    const commit: ShadowCommitAccepted = {
      kind: "woo.commit.accepted.shadow.v1",
      id: "mcp-v2-fanout-routing-cache",
      position: {
        kind: "woo.scope_head.shadow.v1",
        scope: "the_chatroom",
        epoch: 1,
        seq: 2,
        hash: "h2"
      },
      transcript_hash: transcript.hash,
      post_state_hash: "post",
      observations: [observation],
      receipt: {
        kind: "woo.commit_receipt.shadow.v1",
        id: transcript.id,
        route: transcript.route,
        scope: transcript.scope,
        seq: transcript.seq,
        transcript_hash: transcript.hash,
        pre_state_hash: "pre",
        post_state_hash: "post",
        accepted: true,
        errors: []
      },
      projection_delta: {
        sessions: [{ key: bob.id, op: "upsert", bytes: write.bytes }],
        projection_bytes: write.bytes
      },
      projection_writes: [write]
    };

    gateway.acceptRemoteV2Commit("the_chatroom", commit, transcript, alice.id);

    expect(world.activeScopeForSession(bob.id)).toBe("the_chatroom");
    const drain = await (gateway.host as unknown as { drainWait(sessionId: string, args: WooValue[]): Promise<{ observations: Observation[] }> }).drainWait(bob.id, [0, 10]);
    expect(drain.observations).toEqual([
      expect.objectContaining({ type: "entered", actor: alice.actor, room: "the_chatroom" })
    ]);
    expect(metrics).toContainEqual(expect.objectContaining({
      kind: "mcp_observation_routed",
      route: "accepted",
      observation_type: "entered",
      queues_scanned: 1,
      deliveries: 1
    }));
    expect(metrics.some((event) => event.kind === "shadow_gateway_apply_step")).toBe(false);
  });

  it("persists MCP session projection rows for gateway rehydrate routing", () => {
    const repo = new LocalSQLiteRepository(":memory:");
    try {
      let world = createWorld({ repository: repo });
      const session = world.auth("guest:mcp-v2-fanout-session-persist");
      const gateway = new McpGateway(world);
      const sessionRow = structuredClone(world.exportSessions().find((row) => row.id === session.id)!);
      sessionRow.activeScope = "the_deck";
      const write: ProjectionWrite = {
        table: "sessions",
        key: session.id,
        op: "upsert",
        row: sessionRow,
        bytes: 100
      };
      const transcript = mcpTestTranscript({
        id: "mcp-v2-fanout-session-persist",
        route: "sequenced",
        scope: "the_chatroom",
        seq: 3,
        session: session.id,
        call: { actor: session.actor, target: "the_chatroom", verb: "enter", args: [] },
        observations: [],
        hash: "mcp-v2-fanout-session-persist"
      });
      const commit: ShadowCommitAccepted = {
        kind: "woo.commit.accepted.shadow.v1",
        id: "mcp-v2-fanout-session-persist",
        position: {
          kind: "woo.scope_head.shadow.v1",
          scope: "the_chatroom",
          epoch: 1,
          seq: 3,
          hash: "h3"
        },
        transcript_hash: transcript.hash,
        post_state_hash: "post",
        observations: [],
        receipt: {
          kind: "woo.commit_receipt.shadow.v1",
          id: transcript.id,
          route: transcript.route,
          scope: transcript.scope,
          seq: transcript.seq,
          transcript_hash: transcript.hash,
          pre_state_hash: "pre",
          post_state_hash: "post",
          accepted: true,
          errors: []
        },
        projection_delta: {
          sessions: [{ key: session.id, op: "upsert", bytes: write.bytes }],
          projection_bytes: write.bytes
        },
        projection_writes: [write]
      };

      gateway.acceptRemoteV2Commit("the_chatroom", commit, transcript, null);
      expect(world.activeScopeForSession(session.id)).toBe("the_deck");

      world = createWorld({ repository: repo });
      expect(world.activeScopeForSession(session.id)).toBe("the_deck");
    } finally {
      repo.close();
    }
  });

  it("does not compatibility-apply marker-only projection deltas", () => {
    const world = bootstrapWorld();
    const metrics: MetricEvent[] = [];
    world.setMetricsHook((event) => metrics.push(event));
    const gateway = new McpGateway(world);
    const transcript = mcpTestTranscript({
      id: "mcp-v2-marker-only-projection",
      route: "sequenced",
      scope: "the_chatroom",
      seq: 2,
      session: null,
      call: { actor: "$wiz", target: "the_chatroom", verb: "marker_only", args: [] },
      observations: [],
      hash: "mcp-v2-marker-only-projection"
    });
    const commit: ShadowCommitAccepted = {
      kind: "woo.commit.accepted.shadow.v1",
      id: "mcp-v2-marker-only-projection",
      position: {
        kind: "woo.scope_head.shadow.v1",
        scope: "the_chatroom",
        epoch: 1,
        seq: 2,
        hash: "h2"
      },
      transcript_hash: transcript.hash,
      post_state_hash: "post",
      observations: [],
      receipt: {
        kind: "woo.commit_receipt.shadow.v1",
        id: transcript.id,
        route: transcript.route,
        scope: transcript.scope,
        seq: transcript.seq,
        transcript_hash: transcript.hash,
        pre_state_hash: "pre",
        post_state_hash: "post",
        accepted: true,
        errors: []
      },
      projection_delta: {
        projection_bytes: 0,
        tool_surface_sources: [{
          key: { table: "objects", authority_scope: "the_chatroom", key: "the_chatroom" },
          op: "upsert",
          bytes: 0
        }]
      },
      projection_writes: []
    };

    gateway.acceptRemoteV2Commit("the_chatroom", commit, transcript);

    expect(metrics).toContainEqual(expect.objectContaining({
      kind: "gateway_projection_apply",
      source: "fanout",
      rows: 0,
      projection_bytes: 0
    }));
    expect(metrics.some((event) => event.kind === "shadow_gateway_apply_step")).toBe(false);
  });

  it("rejects projection deltas that are missing required row bodies", () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-v2-incomplete-projection");
    const gateway = new McpGateway(world);
    const relay = createShadowBrowserRelayShim({
      node: "mcp-v2-incomplete-projection-relay",
      scope: "the_chatroom",
      serialized: world.exportWorld()
    });
    relay.commit_scope.head = { kind: "woo.scope_head.shadow.v1", scope: "the_chatroom", epoch: 1, seq: 2, hash: "h2" };
    (gateway as unknown as { v2Scopes: Map<string, unknown> }).v2Scopes.set("the_chatroom", {
      scope: "the_chatroom",
      relay,
      openedSessions: new Set()
    });
    const transcript = mcpTestTranscript({
      id: "mcp-v2-incomplete-projection",
      route: "sequenced",
      scope: "the_chatroom",
      seq: 3,
      session: session.id,
      call: { actor: session.actor, target: "the_chatroom", verb: "incomplete_projection", args: [] },
      writes: [{ cell: { kind: "prop", object: session.actor, name: "incomplete_probe" }, value: "should-not-apply", op: "set" }],
      observations: [],
      hash: "mcp-v2-incomplete-projection"
    });
    const commit: ShadowCommitAccepted = {
      kind: "woo.commit.accepted.shadow.v1",
      id: "mcp-v2-incomplete-projection",
      position: {
        kind: "woo.scope_head.shadow.v1",
        scope: "the_chatroom",
        epoch: 1,
        seq: 3,
        hash: "h3"
      },
      transcript_hash: transcript.hash,
      post_state_hash: "post",
      observations: [],
      receipt: {
        kind: "woo.commit_receipt.shadow.v1",
        id: transcript.id,
        route: transcript.route,
        scope: transcript.scope,
        seq: transcript.seq,
        transcript_hash: transcript.hash,
        pre_state_hash: "pre",
        post_state_hash: "post",
        accepted: true,
        errors: []
      },
      projection_delta: {
        objects: [{ key: session.actor, op: "upsert", bytes: 100 }],
        projection_bytes: 100
      },
      projection_writes: []
    };

    expect(() => gateway.acceptRemoteV2Commit("the_chatroom", commit, transcript)).toThrow(/projection_delta/);
    expect(relay.commit_scope.head.seq).toBe(2);
    expect(world.propOrNull(session.actor, "incomplete_probe")).toBeNull();
  });

  it("does not replay gateway-host writes after local v2 host write-through", () => {
    const world = bootstrapWorld();
    world.setProp("$system", "guest_initial_room", null);
    const session = world.auth("guest:mcp-v2-host-skip");
    const transcript: EffectTranscript = {
      kind: "woo.effect_transcript.shadow.v1",
      id: "mcp-v2-host-skip",
      route: "sequenced",
      scope: "the_chatroom",
      seq: 4,
      session: session.id,
      call: { actor: session.actor, target: session.actor, verb: "host_skip_probe", args: [] },
      reads: [],
      writes: [
        { cell: { kind: "prop", object: session.actor, name: "host_skip_probe" }, value: "updated", op: "set" }
      ],
      creates: [],
      moves: [],
      observations: [],
      logicalInputs: [],
      untrackedEffects: [],
      result: true,
      complete: true,
      incompleteReasons: [],
      hash: "mcp-v2-host-skip"
    };

    world.applyCommittedShadowTranscriptToHost("world", transcript, { gatewayHost: true });
    world.applyCommittedShadowTranscript(transcript, { skipObjectHost: { hostKey: "world", gatewayHost: true } });

    const actor = world.exportWorld().objects.find((obj) => obj.id === session.actor);
    expect(actor?.properties.find(([name]) => name === "host_skip_probe")?.[1]).toBe("updated");
    expect(actor?.propertyVersions.find(([name]) => name === "host_skip_probe")?.[1]).toBe(1);
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

  it("persists accepted fanout into the projection cache in sequence order, not arrival order", () => {
    // Regression: the worker gateway wrote its durable SQL projection cache
    // before McpGateway sequenced the frame. A seq-2-before-seq-1 arrival
    // advanced the cache head to 2, so the later seq 1 was dropped by the
    // cache's head-idempotency guard (position.seq <= head_seq) — losing seq 1's
    // projection rows/invalidations from the durable cache. The
    // persistAcceptedProjection hook must therefore fire only when the gateway
    // actually applies a frame, in contiguous scope-sequence order.
    const world = bootstrapWorld();
    world.setProp("the_chatroom", "next_seq", 5);
    const persisted: number[] = [];
    const gateway = new McpGateway(world, {
      persistAcceptedProjection: (commit) => persisted.push(commit.position.seq)
    });
    const relay = createShadowBrowserRelayShim({
      node: "mcp-order-persist",
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
      id: `persist-order-${seq}`,
      route: "sequenced",
      scope: "the_chatroom",
      seq,
      session: null,
      call: { actor: "$wiz", target: "the_chatroom", verb: "persist_order_probe", args: [value] },
      reads: [],
      writes: [{ cell: { kind: "prop", object: "the_chatroom", name: "next_seq" }, value: seq + 1, op: "set" }],
      creates: [],
      moves: [],
      observations: [],
      logicalInputs: [],
      untrackedEffects: [],
      result: true,
      complete: true,
      incompleteReasons: [],
      hash: `persist-order-${seq}`
    });
    const commit = (seq: number) => ({
      kind: "woo.commit.accepted.shadow.v1" as const,
      id: `persist-order-${seq}`,
      position: { kind: "woo.scope_head.shadow.v1" as const, scope: "the_chatroom", epoch: 1, seq, hash: `head-${seq}` },
      transcript_hash: `persist-order-${seq}`,
      post_state_hash: `post-${seq}`,
      observations: [],
      receipt: {
        kind: "woo.commit_receipt.shadow.v1" as const,
        id: `persist-order-${seq}`,
        route: "sequenced" as const,
        scope: "the_chatroom",
        seq,
        transcript_hash: `persist-order-${seq}`,
        pre_state_hash: `pre-${seq}`,
        post_state_hash: `post-${seq}`,
        accepted: true,
        errors: []
      }
    });

    // seq 6 arrives first: queued, not yet applied, so the cache is NOT touched.
    gateway.acceptRemoteV2Commit("the_chatroom", commit(6), transcript(6, "six"));
    expect(persisted).toEqual([]);
    // seq 5 fills the gap and drains seq 6: the cache is persisted 5 then 6.
    gateway.acceptRemoteV2Commit("the_chatroom", commit(5), transcript(5, "five"));
    expect(persisted).toEqual([5, 6]);
    // A duplicate seq 6 is deduped before application: no re-persist.
    gateway.acceptRemoteV2Commit("the_chatroom", commit(6), transcript(6, "six-duplicate"));
    expect(persisted).toEqual([5, 6]);
  });

  it("routes audience-addressed commit observations even when projection sequencing has a gap", async () => {
    // MCP observation delivery is audience-filtered: a shard can legitimately
    // receive durable seq N without seq N-1 because the missing commit had no
    // observations for local sessions. Queue delivery must not wait for the
    // projection-cache sequencer, but durable projection persistence still must.
    const world = bootstrapWorld();
    const alice = world.auth("guest:mcp-v2-audience-gap-alice");
    const fanoutScope = "#audience-gap";
    const durableHead = new Map<string, number>([[fanoutScope, 22]]);
    const persisted: number[] = [];
    const gateway = new McpGateway(world, {
      durableProjectionHeadSeq: (scope) => durableHead.get(scope) ?? null,
      persistAcceptedProjection: (commit) => {
        persisted.push(commit.position.seq);
        durableHead.set(commit.position.scope, commit.position.seq);
      }
    });
    gateway.bindActorSession(alice.id, alice.actor);
    const observation: Observation = {
      type: "entered",
      source: "the_taskboard",
      actor: "guest_gap_peer",
      room: "the_taskboard",
      text: "Guest Gap Peer arrives at the workshop.",
      ts: 24
    };
    const transcript = (seq: number, observations: Observation[] = []): EffectTranscript => mcpTestTranscript({
      id: `audience-gap-${seq}`,
      route: "sequenced",
      scope: "the_garden",
      seq,
      session: null,
      call: { actor: "guest_gap_peer", target: "the_garden", verb: "south", args: [] },
      observations,
      hash: `audience-gap-${seq}`
    });
    const commit = (seq: number, observations: Observation[] = []): ShadowCommitAccepted => ({
      kind: "woo.commit.accepted.shadow.v1",
      id: `audience-gap-${seq}`,
      position: { kind: "woo.scope_head.shadow.v1", scope: fanoutScope, epoch: 1, seq, hash: `head-${seq}` },
      transcript_hash: `audience-gap-${seq}`,
      post_state_hash: `post-${seq}`,
      observations,
      receipt: {
        kind: "woo.commit_receipt.shadow.v1",
        id: `audience-gap-${seq}`,
        route: "sequenced",
        scope: "the_garden",
        seq,
        transcript_hash: `audience-gap-${seq}`,
        pre_state_hash: `pre-${seq}`,
        post_state_hash: `post-${seq}`,
        accepted: true,
        errors: []
      }
    });

    gateway.acceptRemoteV2Commit(fanoutScope, commit(24, [observation]), transcript(24, [observation]), "origin-session", {
      audienceSessions: [alice.id],
      observationSessionAudiences: [[alice.id]]
    });
    const firstDrain = await (gateway.host as unknown as { drainWait(sessionId: string, args: WooValue[]): Promise<{ observations: Observation[] }> }).drainWait(alice.id, [0, 10]);
    expect(firstDrain.observations).toEqual([expect.objectContaining({ type: "entered", actor: "guest_gap_peer", source: "the_taskboard" })]);
    expect(persisted).toEqual([]);

    gateway.acceptRemoteV2Commit(fanoutScope, commit(23), transcript(23), "origin-session");
    expect(persisted).toEqual([23, 24]);
    const secondDrain = await (gateway.host as unknown as { drainWait(sessionId: string, args: WooValue[]): Promise<{ observations: Observation[] }> }).drainWait(alice.id, [0, 10]);
    expect(secondDrain.observations).toEqual([]);
  });

  it("sequences fanout against the durable head when a cold shard has no relay", () => {
    // Hibernation window: a peer shard with durable session presence can receive
    // fanout before its v2 relay re-opens, so v2Scopes has no entry and the
    // in-memory relay head is gone. Sequencing must then fall back to the
    // durable projection-cache head; otherwise expectedSeq is null, frames apply
    // in arrival order, and the persist hook writes seq 6 before seq 5 — which
    // the SQL head guard then drops.
    const world = bootstrapWorld();
    const durableHead = new Map<string, number>([["the_chatroom", 4]]);
    const persisted: number[] = [];
    const gateway = new McpGateway(world, {
      durableProjectionHeadSeq: (scope) => durableHead.get(scope) ?? null,
      // Mirror the worker: the persist hook advances the durable head, which the
      // drain loop re-reads to release the next contiguous frame.
      persistAcceptedProjection: (commit) => {
        persisted.push(commit.position.seq);
        durableHead.set(commit.position.scope, commit.position.seq);
      }
    });
    // Deliberately NO v2Scopes entry for the_chatroom — this is the cold shard.
    const transcript = (seq: number): EffectTranscript => ({
      kind: "woo.effect_transcript.shadow.v1",
      id: `cold-order-${seq}`,
      route: "sequenced",
      scope: "the_chatroom",
      seq,
      session: null,
      call: { actor: "$wiz", target: "the_chatroom", verb: "cold_order_probe", args: [] },
      reads: [],
      writes: [{ cell: { kind: "prop", object: "the_chatroom", name: "next_seq" }, value: seq + 1, op: "set" }],
      creates: [],
      moves: [],
      observations: [],
      logicalInputs: [],
      untrackedEffects: [],
      result: true,
      complete: true,
      incompleteReasons: [],
      hash: `cold-order-${seq}`
    });
    const commit = (seq: number) => ({
      kind: "woo.commit.accepted.shadow.v1" as const,
      id: `cold-order-${seq}`,
      position: { kind: "woo.scope_head.shadow.v1" as const, scope: "the_chatroom", epoch: 1, seq, hash: `head-${seq}` },
      transcript_hash: `cold-order-${seq}`,
      post_state_hash: `post-${seq}`,
      observations: [],
      receipt: {
        kind: "woo.commit_receipt.shadow.v1" as const,
        id: `cold-order-${seq}`,
        route: "sequenced" as const,
        scope: "the_chatroom",
        seq,
        transcript_hash: `cold-order-${seq}`,
        pre_state_hash: `pre-${seq}`,
        post_state_hash: `post-${seq}`,
        accepted: true,
        errors: []
      }
    });

    // seq 6 arrives first; expected (durable head 4 + 1) is 5, so 6 is queued.
    gateway.acceptRemoteV2Commit("the_chatroom", commit(6), transcript(6));
    expect(persisted).toEqual([]);
    // seq 5 fills the gap and drains seq 6: persisted in contiguous order.
    gateway.acceptRemoteV2Commit("the_chatroom", commit(5), transcript(5));
    expect(persisted).toEqual([5, 6]);
  });

  it("propagates accepted-frame writes to other cached scope snapshots", async () => {
    // Production bug: after `chatroom → southeast → deck`, then `deck → west →
    // chatroom`, the next actor verb routed to the chatroom scope reads stale
    // `actor.location=the_deck`. The gateway caches per-scope serialized
    // snapshots; the `deck:west` commit updates the deck client's snapshot
    // (head + transcript writes) and the gateway's main world, but the
    // chatroom client's snapshot was last touched by the `southeast` commit
    // and still has actor.location=the_deck. The next dispatch goes to
    // `chatroom`, reads from the chatroom client's stale snapshot, and the
    // actor verb returns the wrong room. Acceptance of a commit must mirror
    // the transcript's writes to every other cached scope so cross-scope
    // state changes (actor.location, room.contents) stay coherent.
    const world = bootstrapWorld();
    world.createObject({ id: "scope_room_a", name: "Room A", parent: "$room", owner: "$wiz" });
    world.createObject({ id: "scope_room_b", name: "Room B", parent: "$room", owner: "$wiz" });
    world.setProp("scope_room_a", "next_seq", 1);
    world.setProp("scope_room_b", "next_seq", 1);
    const session = world.auth("guest:mcp-cross-scope-propagation");
    world.object(session.actor).location = "scope_room_a";
    world.object("scope_room_a").contents.add(session.actor);
    const gateway = new McpGateway(world);
    const v2Scopes = (gateway as unknown as { v2Scopes: Map<string, { scope: ObjRef; relay: ReturnType<typeof createShadowBrowserRelayShim>; openedSessions: Set<string> }> }).v2Scopes;
    for (const scope of ["scope_room_a", "scope_room_b"] as const) {
      const relay = createShadowBrowserRelayShim({
        node: `mcp-cross-scope-${scope}`,
        scope,
        serialized: world.exportWorld()
      });
      relay.commit_scope.head = { kind: "woo.scope_head.shadow.v1", scope, epoch: 1, seq: 0, hash: `head-${scope}-0` };
      v2Scopes.set(scope, { scope, relay, openedSessions: new Set() });
    }

    // Sanity: both snapshots see the actor in room A.
    const findActor = (objects: ReturnType<WooWorld["exportWorld"]>["objects"], id: ObjRef) =>
      objects.find((object) => object.id === id);
    expect(findActor(serializedFor(v2Scopes.get("scope_room_a")!.relay.commit_scope).objects, session.actor)?.location).toBe("scope_room_a");
    expect(findActor(serializedFor(v2Scopes.get("scope_room_b")!.relay.commit_scope).objects, session.actor)?.location).toBe("scope_room_a");
    const roomARelay = v2Scopes.get("scope_room_a")!.relay;
    const roomBRelay = v2Scopes.get("scope_room_b")!.relay;
    const roomBBrowser = createShadowBrowserNode({
      node: "mcp-cross-scope-room-b-browser",
      scope: "scope_room_b",
      actor: session.actor,
      session: session.id,
      relay: roomBRelay
    });
    const roomBOpen = await openShadowBrowserScope(roomBBrowser);
    const staleRoomBDigest = shadowStateTransferCacheDigest(roomBOpen.executable_transfer);
    expect(staleRoomBDigest).toBeTruthy();
    expect(roomBRelay.open_executable_seed_cache.size).toBe(1);
    const roomAGenerationBefore = roomARelay.serialized_generation;
    const roomBGenerationBefore = roomBRelay.serialized_generation;

    // Simulate a commit in room A that moves the actor to room B. Production
    // would reach this through invokeV2 → CommitScopeDO → acceptV2Commit; the
    // remote-fan-in path uses the same acceptance plumbing so applyRemote-
    // Accepted is the cheaper entry point to exercise here.
    const transcript: EffectTranscript = {
      kind: "woo.effect_transcript.shadow.v1",
      id: "cross-scope-move",
      route: "sequenced",
      scope: "scope_room_a",
      seq: 1,
      session: session.id,
      call: { actor: session.actor, target: "scope_room_a", verb: "move_probe", args: [] },
      reads: [],
      writes: [
        { cell: { kind: "location", object: session.actor }, value: "scope_room_b", op: "move" },
        { cell: { kind: "contents", object: "scope_room_a" }, value: [], op: "remove" },
        { cell: { kind: "contents", object: "scope_room_b" }, value: [session.actor], op: "add" },
        { cell: { kind: "prop", object: "scope_room_a", name: "next_seq" }, value: 2, op: "set" }
      ],
      creates: [],
      moves: [{ object: session.actor, from: "scope_room_a", to: "scope_room_b" }],
      observations: [],
      logicalInputs: [],
      untrackedEffects: [],
      result: true,
      complete: true,
      incompleteReasons: [],
      hash: "cross-scope-move"
    };
    const commit = {
      kind: "woo.commit.accepted.shadow.v1" as const,
      id: "cross-scope-move",
      position: { kind: "woo.scope_head.shadow.v1" as const, scope: "scope_room_a", epoch: 1, seq: 1, hash: "head-scope_room_a-1" },
      transcript_hash: "cross-scope-move",
      post_state_hash: "post-cross-scope-move",
      observations: [],
      receipt: {
        kind: "woo.commit_receipt.shadow.v1" as const,
        id: "cross-scope-move",
        route: "sequenced" as const,
        scope: "scope_room_a",
        seq: 1,
        transcript_hash: "cross-scope-move",
        pre_state_hash: "pre-cross-scope-move",
        post_state_hash: "post-cross-scope-move",
        accepted: true,
        errors: []
      }
    };

    gateway.acceptRemoteV2Commit("scope_room_a", commit, transcript);

    // The originating scope (room A) advanced head + applied writes — actor is
    // gone from its snapshot's room A contents and now at room B.
    const roomASnapshot = serializedFor(roomARelay.commit_scope);
    expect(findActor(roomASnapshot.objects, session.actor)?.location).toBe("scope_room_b");
    expect(roomARelay.commit_scope.head.seq).toBe(1);
    expect(roomARelay.serialized_generation).toBe(roomAGenerationBefore + 1);

    // The OTHER cached scope (room B) also reflects the actor's new location
    // — without this propagation, the next call dispatched to scope B would
    // read actor.location=room A and reject the verb as "not present here".
    const roomBSnapshot = serializedFor(roomBRelay.commit_scope);
    expect(findActor(roomBSnapshot.objects, session.actor)?.location).toBe("scope_room_b");
    // Room B's head is NOT advanced by another scope's commit — only writes
    // mirror across.
    expect(roomBRelay.commit_scope.head.seq).toBe(0);
    expect(roomBRelay.serialized_generation).toBe(roomBGenerationBefore + 1);
    expect(roomBRelay.open_executable_seed_cache.size).toBe(0);
    const roomBReopen = await openShadowBrowserScope(roomBBrowser, {
      executable_seed_digest: staleRoomBDigest ?? undefined
    });
    expect(roomBReopen.executable_transfer_cache).toBe("miss");
    expect(roomBReopen.executable_transfer_inline_pages).toBeGreaterThan(0);
    expect(roomBReopen.executable_transfer_digest).not.toBe(staleRoomBDigest);

    // The gateway's main world also reflects the actor's new location.
    expect(world.object(session.actor).location).toBe("scope_room_b");
  });

  it("applies write-only v2 accepted transcript cells through the gateway cache", () => {
    const world = bootstrapWorld();
    world.setProp("$system", "guest_initial_room", null);
    const session = world.auth("guest:mcp-v2-cache-write-only");
    const objectCounterBefore = world.exportWorld().objectCounter;
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

    vi.useFakeTimers();
    try {
      vi.setSystemTime(timestamp);
      world.applyCommittedShadowTranscript(transcript);
    } finally {
      vi.useRealTimers();
    }

    const after = world.exportWorld();
    expect(world.getProp(session.actor, "cache_probe")).toBe("write-only");
    expect(world.object(session.actor).location).toBe("the_lobby");
    expect([...world.object("the_chatroom").contents].sort()).toEqual(["$wiz", session.actor].sort());
    expect(after.logs.find(([space]) => space === "the_chatroom")?.[1].filter((entry) => entry.seq === 4)).toHaveLength(1);
    expect(after.objectCounter).toBe(objectCounterBefore);
  });

  it("applies v2 accepted transcripts without mutating the input serialized snapshot", () => {
    const world = bootstrapWorld();
    world.setProp("$system", "guest_initial_room", null);
    const session = world.auth("guest:mcp-v2-copy-on-write");
    const beforeApply = world.exportWorld();
    const beforeSnapshot = structuredClone(beforeApply);
    const transcript: EffectTranscript = {
      kind: "woo.effect_transcript.shadow.v1",
      id: "mcp-v2-copy-on-write",
      route: "sequenced",
      scope: "the_chatroom",
      seq: 8,
      session: session.id,
      call: { actor: session.actor, target: "the_chatroom", verb: "copy_on_write_probe", args: [] },
      reads: [],
      writes: [
        { cell: { kind: "prop", object: session.actor, name: "copy_on_write_probe" }, value: "updated", op: "set" },
        { cell: { kind: "contents", object: "the_chatroom" }, value: ["$wiz", session.actor], op: "set" }
      ],
      creates: [
        { object: "mcp_copy_on_write_created", name: "copy-on-write probe", parent: "$thing", owner: session.actor, location: "the_chatroom", anchor: null, flags: {}, writer: { progr: "$wiz", definer: "$thing", verb: "copy_on_write_probe", thisObj: "the_chatroom", caller: session.actor, callerPerms: session.actor } }
      ],
      moves: [],
      observations: [{ type: "copy_on_write_probe", actor: session.actor, source: "the_chatroom", text: "updated", ts: 1 }],
      logicalInputs: [],
      untrackedEffects: [],
      result: true,
      complete: true,
      incompleteReasons: [],
      hash: "mcp-v2-copy-on-write"
    };

    const scope = createShadowCommitScope({ node: "scope:mcp-copy-on-write", scope: "the_chatroom", serialized: beforeApply });
    applyShadowTranscriptToCommitScopeCache(scope, transcript, { objectTimestamp: Date.now() + 1_000 });
    const afterApply = serializedFor(scope);

    expect(beforeApply).toEqual(beforeSnapshot);
    expect(afterApply).not.toEqual(beforeApply);
  });

  it("does not enumerate remote tools while sending post-call list_changed hints", async () => {
    const world = bootstrapWorld();
    // The bridge below declares the_chatroom remote; the lazy-refresh contract
    // tested here assumes the actor doesn't start out in a remote room.
    world.setProp("$system", "guest_initial_room", null);
    const session = world.auth("guest:mcp-lazy-refresh");
    let remoteEnumerations = 0;
    world.setExecutorContext({
      localHost: "home",
      hostForObject: (id: string) => id === "the_chatroom" ? "chat" : "home",
      enumerateRemoteTools: async () => {
        remoteEnumerations += 1;
        return [];
      }
    } as unknown as ExecutorContext);
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

  it("preserves a session-visible remote tool from the saved manifest when owner refresh fails", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-tool-manifest");
    world.createObject({ id: "remote_widget", name: "Remote Widget", parent: "$thing", owner: "$wiz" });
    world.setProp(session.actor, "focus_list", ["remote_widget"]);
    const descriptor: RemoteToolDescriptor = {
      object: "remote_widget",
      verb: "ping",
      aliases: [],
      arg_spec: { args: [] },
      direct: true,
      source: "/* remote ping */",
      enclosingSpace: "remote_widget"
    };
    const saved: SessionToolManifest[] = [];
    world.setExecutorContext({
      localHost: "home",
      hostForObject: (id: ObjRef) => id === "remote_widget" ? "remote" : "home",
      enumerateRemoteTools: async () => [descriptor]
    } as unknown as ExecutorContext);
    const host = new McpHost(world, {}, {
      staleFallback: true,
      saveSessionManifest: (manifest) => { saved[0] = manifest; },
      loadSessionManifest: () => saved[0] ?? null
    });
    host.bindSession(session.id, session.actor);

    const listed = await host.listTools(session.actor, { scope: "focus", sessionId: session.id });
    expect(listed.tools.some((tool) => tool.object === "remote_widget" && tool.verb === "ping")).toBe(true);
    await host.markToolListSeen(session.id, session.actor, listed.tools);
    expect(saved[0]?.tools.some((tool) => tool.object === "remote_widget" && tool.verb === "ping")).toBe(true);

    world.setExecutorContext({
      localHost: "home",
      hostForObject: (id: ObjRef) => id === "remote_widget" ? "remote" : "home",
      enumerateRemoteTools: async () => { throw new Error("owner timeout"); }
    } as unknown as ExecutorContext);
    const rehydrated = new McpHost(world, {}, {
      staleFallback: true,
      loadSessionManifest: () => saved[0] ?? null,
      saveSessionManifest: (manifest) => { saved[0] = manifest; }
    });
    rehydrated.bindSession(session.id, session.actor);

    const fallbackList = await rehydrated.listTools(session.actor, { scope: "focus", sessionId: session.id });
    expect(fallbackList.tools.some((tool) => tool.object === "remote_widget" && tool.verb === "ping")).toBe(true);
    expect(saved[0]).toMatchObject({ stale: true, stale_reason: "owner_timeout" });
    expect(saved[0].tools.find((tool) => tool.object === "remote_widget" && tool.verb === "ping")).toMatchObject({
      stale: true,
      stale_reason: "owner_timeout"
    });
    await expect(rehydrated.resolveReachableTool(session.actor, "remote_widget", "ping", session.id)).resolves.toMatchObject({
      object: "remote_widget",
      verb: "ping"
    });
  });

  it("preserves expanded remote-content tools from the saved manifest when owner refresh fails", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-tool-manifest-expanded");
    world.createObject({ id: "remote_room", name: "Remote Room", parent: "$space", owner: "$wiz" });
    world.setProp(session.actor, "focus_list", ["remote_room"]);
    const descriptor: RemoteToolDescriptor = {
      object: "remote_child",
      verb: "ping",
      aliases: [],
      arg_spec: { args: [] },
      direct: true,
      source: "/* remote child ping */",
      enclosingSpace: "remote_room"
    };
    let saved: SessionToolManifest | null = null;
    world.setExecutorContext({
      localHost: "home",
      hostForObject: (id: ObjRef) => id === "remote_room" || id === "remote_child" ? "remote" : "home",
      enumerateRemoteTools: async (_actor: ObjRef, requests: Array<{ id: ObjRef; expandContents?: boolean }>) => (
        requests.some((request) => request.id === "remote_room" && request.expandContents === true) ? [descriptor] : []
      )
    } as unknown as ExecutorContext);
    const host = new McpHost(world, {}, {
      staleFallback: true,
      saveSessionManifest: (manifest) => { saved = manifest; },
      loadSessionManifest: () => saved
    });
    host.bindSession(session.id, session.actor);

    const listed = await host.listTools(session.actor, { scope: "space", object: "remote_room", sessionId: session.id });
    expect(listed.tools.some((tool) => tool.object === "remote_child" && tool.verb === "ping")).toBe(true);
    await host.markToolListSeen(session.id, session.actor, listed.tools);

    world.setExecutorContext({
      localHost: "home",
      hostForObject: (id: ObjRef) => id === "remote_room" || id === "remote_child" ? "remote" : "home",
      enumerateRemoteTools: async () => { throw new Error("owner timeout"); }
    } as unknown as ExecutorContext);
    const rehydrated = new McpHost(world, {}, {
      staleFallback: true,
      loadSessionManifest: () => saved,
      saveSessionManifest: (manifest) => { saved = manifest; }
    });
    rehydrated.bindSession(session.id, session.actor);

    const fallbackList = await rehydrated.listTools(session.actor, { scope: "space", object: "remote_room", sessionId: session.id });
    expect(fallbackList.tools.some((tool) => tool.object === "remote_child" && tool.verb === "ping")).toBe(true);
    const staleManifest = saved as SessionToolManifest | null;
    expect(staleManifest).toMatchObject({ stale: true, stale_reason: "owner_timeout" });
    if (!staleManifest) throw new Error("expected stale manifest");
    expect(staleManifest.tools.find((tool) => tool.object === "remote_child" && tool.verb === "ping")).toMatchObject({
      stale: true,
      stale_reason: "owner_timeout"
    });
  });

  it("records method-resolution source rows for remote tool-surface invalidation", () => {
    const world = bootstrapWorld();
    world.createObject({ id: "source_parent", name: "Source Parent", parent: "$thing", owner: "$wiz" });
    world.createObject({ id: "source_mid", name: "Source Mid", parent: "source_parent", owner: "$wiz" });
    world.createObject({ id: "source_child", name: "Source Child", parent: "source_mid", owner: "$wiz" });
    expect(installVerb(world, "source_parent", "ping", `verb :ping() rxd { return "parent"; }`, null).ok).toBe(true);
    const parentPing = world.ownVerb("source_parent", "ping");
    if (!parentPing) throw new Error("expected parent ping");
    parentPing.tool_exposed = true;
    parentPing.direct_callable = true;
    const host = new McpHost(world);

    const inherited = host.enumerateLocalToolDescriptors("$wiz", [{ id: "source_child", projection: "tools" }])
      .find((descriptor) => descriptor.object === "source_child" && descriptor.verb === "ping");
    expect(inherited?.source_rows?.map((row) => row.key)).toEqual(["source_child", "source_mid", "source_parent"]);

    expect(installVerb(world, "source_child", "ping", `verb :ping() rxd { return "child"; }`, null).ok).toBe(true);
    const childPing = world.ownVerb("source_child", "ping");
    if (!childPing) throw new Error("expected child ping");
    childPing.tool_exposed = true;
    childPing.direct_callable = true;
    const overridden = host.enumerateLocalToolDescriptors("$wiz", [{ id: "source_child", projection: "tools" }])
      .find((descriptor) => descriptor.object === "source_child" && descriptor.verb === "ping");
    expect(overridden?.source_rows?.map((row) => row.key)).toEqual(["source_child"]);
  });

  it("records feature source rows for remote tool-surface invalidation", () => {
    const world = bootstrapWorld();
    world.createObject({ id: "source_feature", name: "Source Feature", parent: "$thing", owner: "$wiz" });
    world.createObject({ id: "source_feature_user", name: "Source Feature User", parent: "$thing", owner: "$wiz" });
    world.setProp("source_feature_user", "features", ["source_feature"]);
    expect(installVerb(world, "source_feature", "spark", `verb :spark() rxd { return "spark"; }`, null).ok).toBe(true);
    const featureSpark = world.ownVerb("source_feature", "spark");
    if (!featureSpark) throw new Error("expected feature spark");
    featureSpark.tool_exposed = true;
    featureSpark.direct_callable = true;
    const host = new McpHost(world);

    const descriptor = host.enumerateLocalToolDescriptors("$wiz", [{ id: "source_feature_user", projection: "tools" }])
      .find((candidate) => candidate.object === "source_feature_user" && candidate.verb === "spark");

    expect(descriptor?.source_rows?.map((row) => row.key)).toEqual(["source_feature_user", "$thing", "$root", "$system", "source_feature"]);
  });

  it("does not serve saved session manifests when stale fallback is disabled", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-tool-manifest-disabled");
    world.createObject({ id: "remote_widget_disabled", name: "Remote Widget Disabled", parent: "$thing", owner: "$wiz" });
    world.setProp(session.actor, "focus_list", ["remote_widget_disabled"]);
    const descriptor: RemoteToolDescriptor = {
      object: "remote_widget_disabled",
      verb: "ping",
      aliases: [],
      arg_spec: { args: [] },
      direct: true,
      source: "/* remote ping */",
      enclosingSpace: "remote_widget_disabled"
    };
    let saved: SessionToolManifest | null = null;
    world.setExecutorContext({
      localHost: "home",
      hostForObject: (id: ObjRef) => id === "remote_widget_disabled" ? "remote" : "home",
      enumerateRemoteTools: async () => [descriptor]
    } as unknown as ExecutorContext);
    const host = new McpHost(world, {}, {
      saveSessionManifest: (manifest) => { saved = manifest; },
      loadSessionManifest: () => saved
    });
    host.bindSession(session.id, session.actor);
    const listed = await host.listTools(session.actor, { scope: "focus", sessionId: session.id });
    await host.markToolListSeen(session.id, session.actor, listed.tools);

    world.setExecutorContext({
      localHost: "home",
      hostForObject: (id: ObjRef) => id === "remote_widget_disabled" ? "remote" : "home",
      enumerateRemoteTools: async () => { throw new Error("owner timeout"); }
    } as unknown as ExecutorContext);
    const rehydrated = new McpHost(world, {}, {
      loadSessionManifest: () => saved,
      saveSessionManifest: (manifest) => { saved = manifest; }
    });
    rehydrated.bindSession(session.id, session.actor);

    const fallbackList = await rehydrated.listTools(session.actor, { scope: "focus", sessionId: session.id });
    expect(fallbackList.tools.some((tool) => tool.object === "remote_widget_disabled" && tool.verb === "ping")).toBe(false);
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
    const closedSessions: string[] = [];
    const gateway = new McpGateway(world, { onSessionClosed: (sessionId) => { closedSessions.push(sessionId); } });
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
    expect(closedSessions).toEqual([sessionId]);
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
    class FlakyRemoteToolBridge extends RemoteToolBridge {
      failEnumerate = false;
      override async enumerateRemoteTools(actor: ObjRef, requests: RemoteToolRequest[]): Promise<RemoteToolDescriptor[]> {
        if (this.failEnumerate) throw new Error("owner timeout");
        return await super.enumerateRemoteTools(actor, requests);
      }
    }
    const homeBridge = new FlakyRemoteToolBridge("home", worlds, routes, hosts);
    home.setExecutorContext(homeBridge);
    remote.setExecutorContext(new RemoteToolBridge("remote", worlds, routes, hosts));

    home.createObject({ id: "remote_gallery", name: "Remote Gallery", parent: "$space", owner: "$wiz" });
    home.createObject({ id: "remote_widget", name: "Remote Widget", parent: "$thing", owner: "$wiz" });
    home.addVerb("remote_widget", nativeToolVerb("ping", "remote_ping"));
    const homePing = home.ownVerb("remote_widget", "ping");
    if (homePing) homePing.arg_spec = { ...homePing.arg_spec, command: { dobj: "this", prep: "none", iobj: "none", args_from: [] } };

    remote.createObject({ id: "remote_gallery", name: "Remote Gallery", parent: "$space", owner: "$wiz" });
    remote.createObject({ id: "remote_widget", name: "Remote Widget", parent: "$thing", owner: "$wiz", location: "remote_gallery" });
    remote.addVerb("remote_widget", nativeToolVerb("ping", "remote_ping"));
    const remotePing = remote.ownVerb("remote_widget", "ping");
    if (remotePing) {
      // Load-bearing: command-shaped but not tool_exposed reproduces weather's
      // open/ask verbs, which local obvious projection listed but remote
      // explicit-tool projection used to drop.
      remotePing.tool_exposed = false;
      remotePing.arg_spec = { ...remotePing.arg_spec, command: { dobj: "this", prep: "none", iobj: "none", args_from: [] } };
    }
    remote.registerNativeHandler("remote_ping", () => "pong");

    let savedManifest: SessionToolManifest | null = null;
    const gateway = new McpGateway(home, {
      toolManifests: {
        staleFallback: true,
        saveSessionManifest: (manifest) => { savedManifest = manifest; },
        loadSessionManifest: () => savedManifest
      }
    });
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
    home.object(actor!).location = "$nowhere";
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
    const manifestAfterHere = savedManifest as SessionToolManifest | null;
    expect(manifestAfterHere?.tools.some((tool) => tool.object === "remote_widget" && tool.verb === "ping")).toBe(true);

    homeBridge.failEnumerate = true;
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
    const staleManifest = savedManifest as SessionToolManifest | null;
    expect(staleManifest).toMatchObject({ stale: true, stale_reason: "owner_timeout" });

    const focused = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "woo_focus", arguments: { target: "remote_widget" } }
    }, { "mcp-session-id": sessionId! }));
    expect(focused.ok).toBe(true);
    const focusedBody = await focused.json() as { result: { isError?: boolean; structuredContent?: { result?: unknown } } };
    expect(focusedBody.result.isError).not.toBe(true);
    expect(focusedBody.result.structuredContent?.result).toContain("remote_widget");
  });

  it("forces an owner refresh when an exact remote woo_call misses a cached descriptor", async () => {
    const home = bootstrapWorld();
    const remote = bootstrapWorld();
    const routes = new Map<ObjRef, string>([["remote_room", "remote"]]);
    const requests: RemoteToolRequest[] = [];
    const staleDescriptor: RemoteToolDescriptor = {
      object: "remote_room",
      verb: "look",
      aliases: [],
      arg_spec: { args: [] },
      direct: true,
      source: "/* stale cache */",
      enclosingSpace: "remote_room"
    };
    const freshDescriptor: RemoteToolDescriptor = {
      object: "remote_room",
      verb: "southeast",
      aliases: [],
      arg_spec: { args: [] },
      direct: true,
      source: "/* owner */",
      enclosingSpace: "remote_room"
    };
    class ExactRefreshBridge extends RemoteToolBridge {
      override async enumerateRemoteTools(_actor: ObjRef, batch: RemoteToolRequest[]): Promise<RemoteToolDescriptor[]> {
        requests.push(...batch);
        return batch.some((request) => request.forceRefresh === true) ? [freshDescriptor] : [staleDescriptor];
      }
    }
    home.setExecutorContext(new ExactRefreshBridge("home", new Map([["home", home], ["remote", remote]]), routes, new Map()));

    home.createObject({ id: "remote_room", name: "Remote Room", parent: "$space", owner: "$wiz" });
    const session = home.auth("guest:mcp-exact-force-refresh");
    home.object(session.actor).location = "remote_room";
    home.object("remote_room").contents.add(session.actor);
    session.activeScope = "remote_room";

    const host = new McpHost(home);
    const resolved = await host.resolveReachableTool(session.actor, "remote_room", "southeast", session.id);

    expect(resolved).toMatchObject({ object: "remote_room", verb: "southeast" });
    expect(requests).toEqual([
      expect.objectContaining({ id: "remote_room", projection: "tools" }),
      expect.objectContaining({ id: "remote_room", projection: "tools", forceRefresh: true })
    ]);
  });

  it("forces an owner refresh when an active-scope local projection lacks the requested verb", async () => {
    const home = bootstrapWorld();
    const requests: RemoteToolRequest[] = [];
    const freshDescriptor: RemoteToolDescriptor = {
      object: "remote_room",
      verb: "southeast",
      aliases: [],
      arg_spec: { args: [] },
      direct: true,
      source: "/* owner */",
      enclosingSpace: "remote_room"
    };
    class ActiveScopeRefreshBridge extends RemoteToolBridge {
      override async enumerateRemoteTools(_actor: ObjRef, batch: RemoteToolRequest[]): Promise<RemoteToolDescriptor[]> {
        requests.push(...batch);
        return batch.some((request) => request.id === "remote_room" && request.forceRefresh === true)
          ? [freshDescriptor]
          : [];
      }
    }
    const routes = new Map<ObjRef, string>([["remote_room", "home"]]);
    home.setExecutorContext(new ActiveScopeRefreshBridge("home", new Map([["home", home]]), routes, new Map()));

    // This row is a sparse active-scope projection: it is reachable locally, but
    // it has no owner tool surface, so local verb lookup misses.
    home.createObject({ id: "remote_room", name: "Remote Room", parent: "$space", owner: "$wiz" });
    const session = home.auth("guest:mcp-active-scope-local-stub");
    home.object(session.actor).location = "remote_room";
    home.object("remote_room").contents.add(session.actor);
    session.activeScope = "remote_room";

    const host = new McpHost(home);
    const resolved = await host.resolveReachableTool(session.actor, "remote_room", "southeast", session.id);

    expect(resolved).toMatchObject({ object: "remote_room", verb: "southeast" });
    expect(requests).toEqual([
      expect.objectContaining({ id: "remote_room", projection: "tools", forceRefresh: true })
    ]);
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
    home.setExecutorContext(new RemoteToolBridge("home", worlds, routes, hosts));
    remote.setExecutorContext(new RemoteToolBridge("remote", worlds, routes, hosts));

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
    session.activeScope = "remote_room";

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

  it("does not broaden focused remote objects to obvious-only verbs", async () => {
    const home = bootstrapWorld();
    const remote = bootstrapWorld();
    const remoteHost = new McpHost(remote);
    const worlds = new Map<string, WooWorld>([
      ["home", home],
      ["remote", remote]
    ]);
    const routes = new Map<ObjRef, string>([["remote_widget", "remote"]]);
    const hosts = new Map<string, McpHost>([["remote", remoteHost]]);
    home.setExecutorContext(new RemoteToolBridge("home", worlds, routes, hosts));
    remote.setExecutorContext(new RemoteToolBridge("remote", worlds, routes, hosts));

    home.createObject({ id: "remote_widget", name: "Remote Widget", parent: "$thing", owner: "$wiz" });
    remote.createObject({ id: "remote_widget", name: "Remote Widget", parent: "$thing", owner: "$wiz" });
    remote.addVerb("remote_widget", nativeToolVerb("ping", "remote_ping"));
    const remotePing = remote.ownVerb("remote_widget", "ping");
    if (remotePing) {
      remotePing.tool_exposed = false;
      remotePing.arg_spec = { ...remotePing.arg_spec, command: { dobj: "this", prep: "none", iobj: "none", args_from: [] } };
    }
    remote.registerNativeHandler("remote_ping", () => "pong");

    const session = home.auth("guest:mcp-focused-remote-obvious");
    home.setProp(session.actor, "focus_list", ["remote_widget"]);
    const host = new McpHost(home);
    host.bindSession(session.id, session.actor);

    const focused = await host.listTools(session.actor, { scope: "focus" });
    expect(focused.tools.map((tool) => `${tool.object}:${tool.verb}`)).not.toContain("remote_widget:ping");
    await expect(host.resolveReachableTool(session.actor, "remote_widget", "ping")).resolves.toBeNull();
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
      params: { name: "woo_focus", arguments: { target: "the_chatroom" } }
    }, { "mcp-session-id": sessionId! }));
    const focusedBody = (await focused.json()) as { result: { isError?: boolean; structuredContent?: { result?: unknown } } };
    expect(focusedBody.result.isError).not.toBe(true);
    expect(focusedBody.result.structuredContent?.result).toContain("the_chatroom");
  });

  it("rejects woo_focus targets that are missing or not currently reachable", async () => {
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
    }, { "mcp-token": "guest:mcp-focus-reachable" }));
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    const actor = world.sessions.get(sessionId!)?.actor;
    expect(actor).toBeTruthy();

    await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      method: "notifications/initialized"
    }, { "mcp-session-id": sessionId! }));

    const callFocus = async (id: number, target: string) => {
      const response = await gateway.handle(jsonRpcRequest("http://t/mcp", {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "woo_focus", arguments: { target } }
      }, { "mcp-session-id": sessionId! }));
      expect(response.ok).toBe(true);
      return await response.json() as {
        result: {
          isError?: boolean;
          content?: Array<{ type: string; text?: string }>;
          structuredContent?: { error?: { code?: string }; result?: unknown };
        };
      };
    };

    const missingNative = await world.directCall(undefined, actor!, actor!, "focus", ["no_such_object"], { sessionId: sessionId! });
    expect(missingNative.op).toBe("error");
    if (missingNative.op === "error") expect(missingNative.error.code).toBe("E_OBJNF");

    const missing = await callFocus(2, "no_such_object");
    expect(missing.result.isError).toBe(true);
    expect(missing.result.structuredContent?.error?.code).toBe("E_OBJNF");
    // Regression for the tool-error doubled-prefix bug (notes/
    // 2026-05-16-online-walkthrough.md Bug 2). Before the
    // fromError change, MCP clients saw text like
    // "E_OBJNF: E_OBJNF: …". The code now appears exactly once.
    const errorText = missing.result.content?.[0]?.text ?? "";
    expect(errorText).toMatch(/^E_OBJNF: /);
    expect(errorText).not.toMatch(/^E_OBJNF: E_OBJNF/);

    const remoteRoomObject = await callFocus(3, "the_pinboard");
    expect(remoteRoomObject.result.isError).toBe(true);
    expect(remoteRoomObject.result.structuredContent?.error?.code).toBe("E_PERM");

    const substrateObject = await callFocus(4, "$system");
    expect(substrateObject.result.isError).toBe(true);
    expect(substrateObject.result.structuredContent?.error?.code).toBe("E_PERM");

    const moved = await world.directCall(undefined, actor!, "the_chatroom", "southeast", [], { sessionId: sessionId! });
    expect(moved.op).toBe("result");

    const reachable = await callFocus(5, "the_pinboard");
    expect(reachable.result.isError).not.toBe(true);
    expect(reachable.result.structuredContent?.result).toContain("the_pinboard");
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
