import { describe, expect, it } from "vitest";
import { installVerb } from "../src/core/authoring";
import { bootstrap, createWorld, createWorldFromSerialized, mergeHostScopedSeed, mergeHostScopedSeedWithStatus, nonEmptyHostScopedWorld, scopeSerializedWorldToHost } from "../src/core/bootstrap";
import { bundledCatalogAliases, installLocalCatalogs } from "../src/core/local-catalogs";
import type { ParkedTaskRecord, SerializedWorld } from "../src/core/repository";
import type { CallContext, WooWorld } from "../src/core/world";
import { freezeTinyBytecode, type MetricEvent, type ObjRef, type TinyBytecode, type WooValue } from "../src/core/types";
import {
  authedWorld,
  bytecodeVerb,
  callInDubspace,
  LocalExecutorContext,
  message,
  moveActorTo,
  nativeVerb
} from "./core-support";

describe("woo core", () => {
  it("bootstraps the seed graph and describes objects", async () => {
    const world = createWorld();
    expect(world.object("$root").id).toBe("$root");
    expect(world.object("the_dubspace").parent).toBe("$dubspace");
    expect(world.object("the_pinboard").parent).toBe("$pinboard");
    const description = world.describe("the_dubspace");
    expect(description.id).toBe("the_dubspace");
    expect(description.description).toContain("sound-space");
    expect(description.flags).toEqual({ wizard: false, programmer: false, fertile: false });
    expect(description.verbs).toContain("set_control");
    expect(description.schemas).toContain("control_changed");
  });

  it("enforces property read permissions for actor-facing introspection", async () => {
    const { world, session, actor } = authedWorld();
    const name = "private_rest_probe";
    world.defineProperty("the_dubspace", {
      name,
      defaultValue: "secret",
      owner: "$wiz",
      perms: "w",
      typeHint: "str"
    });

    expect(world.describeForActor("the_dubspace", actor).properties).toContain(name);
    expect(() => world.getPropForActor(actor, "the_dubspace", name)).toThrow(/cannot read/);
    expect(world.getPropForActor("$wiz", "the_dubspace", name)).toBe("secret");

    world.defineProperty("the_dubspace", {
      name: "description",
      defaultValue: "private dubspace",
      owner: "$wiz",
      perms: "w",
      typeHint: "str"
    });
    world.setProp("the_dubspace", "description", "private dubspace");
    expect((world.state(actor).objects.the_dubspace as Record<string, unknown>).description).toBeNull();
    expect((world.state("$wiz").objects.the_dubspace as Record<string, unknown>).description).toBe("private dubspace");

    await moveActorTo(world, actor, "the_dubspace", { requestId: "move-describe", sessionId: session.id });
    const described = await callInDubspace(world, session.id, "describe-private", message(actor, "the_dubspace", "describe", []));
    expect(described.op).toBe("result");
    if (described.op === "result") expect((described.result as Record<string, unknown>).description).toBeNull();
  });

  it("exposes catalog-generic presentation builtins with substrate-only facts", async () => {
    const { world, session, actor } = authedWorld();
    const other = world.auth("guest:builtin-other");
    const observer = world.auth("guest:builtin-observer");
    world.sessions.get(observer.id)!.activeScope = "the_deck";
    world.object(observer.actor).location = "the_deck";
    world.object("the_chatroom").contents.delete(observer.actor);
    world.object("the_deck").contents.add(observer.actor);
    await world.directCall("builtin-actor-enter", actor, "the_chatroom", "enter", [], { sessionId: session.id });
    await world.directCall("builtin-other-enter", other.actor, "the_chatroom", "enter", [], { sessionId: other.id });
    world.setProp("the_chatroom", "session_subscribers", [
      ...(world.getProp("the_chatroom", "session_subscribers") as WooValue[]),
      { session: observer.id, actor: observer.actor } as unknown as WooValue
    ]);
    world.setProp("the_chatroom", "subscribers", [
      ...(world.getProp("the_chatroom", "subscribers") as WooValue[]),
      observer.actor
    ]);

    world.createObject({ id: "builtin_visible_box", name: "Visible Box", parent: "$thing", owner: "$wiz", location: "the_chatroom" });
    world.setProp("builtin_visible_box", "description", "Visible to room look.");
    world.createObject({ id: "builtin_verb_box", name: "Verb Box", parent: "$thing", owner: "$wiz", location: "the_chatroom" });
    world.addVerb("builtin_verb_box", {
      ...nativeVerb("polish"),
      perms: "rxd",
      direct_callable: true,
      aliases: ["shine"],
      arg_spec: { command: { dobj: "this", prep: "none", iobj: "none", args_from: [] } }
    });
    expect(installVerb(world, actor, "builtin_probe", `verb :builtin_probe() rxd {
      return {
        present: present_actors("the_chatroom"),
        active: active_actors("the_chatroom"),
        meta: session_metadata(actor),
        visible: visible_contents("the_chatroom"),
        obvious: obvious_verbs("builtin_verb_box")
      };
    }`, null).ok).toBe(true);

    const probed = await world.directCall("builtin-probe", actor, actor, "builtin_probe", [], { sessionId: session.id });
    expect(probed.op).toBe("result");
    if (probed.op !== "result") return;
    const result = probed.result as Record<string, unknown>;
    expect(result.present).toEqual(expect.arrayContaining([actor, other.actor, observer.actor]));
    expect(result.active).toEqual(expect.arrayContaining([actor, other.actor]));
    expect(result.active).not.toContain(observer.actor);
    // connected_players() retired (global enumeration); active_actors(space)
    // above is the scoped presence primitive that replaces it.
    expect(result.visible).toEqual(expect.arrayContaining(["builtin_visible_box", "builtin_verb_box"]));
    expect(result.meta).toMatchObject({ connected: true });
    expect((result.meta as Record<string, unknown>).connected_at).toEqual(expect.any(Number));
    expect(result.obvious).toEqual(expect.arrayContaining([expect.objectContaining({
      definer: "builtin_verb_box",
      name: "polish",
      aliases: ["shine"],
      command: expect.objectContaining({ dobj: "this", prep: "none", iobj: "none" })
    })]));
  });

  it("remote_describe returns remote summaries singly and in batches without local property reads", async () => {
    const { world: home, actor } = authedWorld();
    const remote = createWorld({ catalogs: false });
    const worlds = new Map<string, WooWorld>([
      ["home", home],
      ["remote", remote]
    ]);
    const routes = new Map<ObjRef, string>([
      ["remote_builtin_lamp", "remote"],
      ["remote_builtin_mug", "remote"]
    ]);
    const bridge = new LocalExecutorContext("home", worlds, routes);
    home.setExecutorContext(bridge);
    remote.setExecutorContext(new LocalExecutorContext("remote", worlds, routes));
    remote.createObject({ id: "remote_builtin_lamp", name: "Remote Builtin Lamp", parent: "$thing", owner: "$wiz" });
    remote.setProp("remote_builtin_lamp", "description", "A remote lamp summary.");
    remote.createObject({ id: "remote_builtin_mug", name: "Remote Builtin Mug", parent: "$thing", owner: "$wiz" });
    remote.setProp("remote_builtin_mug", "description", "A remote mug summary.");

    expect(installVerb(home, actor, "remote_builtin_probe", `verb :remote_builtin_probe() rxd {
      return {
        one: remote_describe("remote_builtin_lamp"),
        many: remote_describe(["remote_builtin_lamp", "remote_builtin_mug", "the_chatroom"])
      };
    }`, null).ok).toBe(true);

    const probed = await home.directCall("remote-builtin-probe", actor, actor, "remote_builtin_probe", []);
    expect(probed.op).toBe("result");
    if (probed.op !== "result") return;
    const result = probed.result as Record<string, Record<string, Record<string, unknown>>>;
    expect(result.one).toMatchObject({ name: "Remote Builtin Lamp", description: "A remote lamp summary." });
    expect(result.many.remote_builtin_lamp).toMatchObject({ name: "Remote Builtin Lamp" });
    expect(result.many.remote_builtin_mug).toMatchObject({ name: "Remote Builtin Mug" });
    expect(result.many.the_chatroom).toBeUndefined();
    expect(bridge.describeManyCalls).toEqual([expect.arrayContaining(["remote_builtin_lamp", "remote_builtin_mug"])]);
    expect(Array.from(bridge.getPropCalls.keys()).some((key) => key.includes("remote_builtin_lamp"))).toBe(false);
  });

  it("rejects non-x verbs across direct, sequenced, CALL_VERB, and PASS dispatch", async () => {
    const { world, session, actor } = authedWorld();
    world.createObject({ id: "no_x_target", name: "No X Target", parent: "$thing", owner: "$wiz" });
    world.addVerb("no_x_target", {
      ...nativeVerb("sealed", "describe", "$wiz"),
      perms: "rd",
      direct_callable: true
    });

    const direct = await world.directCall("no-x-direct", actor, "no_x_target", "sealed", []);
    expect(direct.op).toBe("error");
    if (direct.op === "error") expect(direct.error.code).toBe("E_PERM");

    const sequenced = await callInDubspace(world, session.id, "no-x-sequenced", message(actor, "no_x_target", "sealed", []));
    expect(sequenced.op).toBe("applied");
    if (sequenced.op === "applied") expect(sequenced.observations[0]).toMatchObject({ type: "$error", code: "E_PERM" });

    world.addVerb(
      "delay_1",
      bytecodeVerb(
        "call_sealed",
        {
          literals: ["no_x_target", "sealed"],
          num_locals: 0,
          max_stack: 2,
          version: 1,
          ops: [["PUSH_LIT", 0], ["PUSH_LIT", 1], ["CALL_VERB", 0], ["RETURN"]]
        },
        actor
      )
    );
    let callErr: unknown;
    try {
      await world.dispatch(
        {
            world,
            space: "the_dubspace",
            seq: 1,
            session: null,
            actor,
          player: actor,
          caller: "#-1",
          callerPerms: actor,
          progr: actor,
          thisObj: "delay_1",
          verbName: "call_sealed",
          definer: "delay_1",
          message: message(actor, "delay_1", "call_sealed", []),
          observations: [],
          observe: () => {}
        },
        "delay_1",
        "call_sealed",
        []
      );
    } catch (err) {
      callErr = err;
    }
    expect(callErr).toMatchObject({ code: "E_PERM" });

    world.createObject({ id: "no_x_base", name: "No X Base", parent: "$thing", owner: "$wiz" });
    world.createObject({ id: "no_x_child", name: "No X Child", parent: "no_x_base", owner: actor });
    world.addVerb(
      "no_x_base",
      bytecodeVerb("value", { literals: [], num_locals: 0, max_stack: 1, version: 1, ops: [["PUSH_INT", 1], ["RETURN"]] }, "$wiz", "r")
    );
    world.addVerb(
      "no_x_child",
      bytecodeVerb("value", { literals: [], num_locals: 0, max_stack: 1, version: 1, ops: [["PASS", 0], ["RETURN"]] }, actor)
    );
    let passErr: unknown;
    try {
      await world.dispatch(
        {
            world,
            space: "the_dubspace",
            seq: 2,
            session: null,
            actor,
          player: actor,
          caller: "#-1",
          callerPerms: actor,
          progr: actor,
          thisObj: "no_x_child",
          verbName: "value",
          definer: "no_x_child",
          message: message(actor, "no_x_child", "value", []),
          observations: [],
          observe: () => {}
        },
        "no_x_child",
        "value",
        []
      );
    } catch (err) {
      passErr = err;
    }
    expect(passErr).toMatchObject({ code: "E_PERM" });
  });

  it("routes VM reads, writes, and CALL_VERB through a host bridge", async () => {
    const { world: home, session, actor } = authedWorld();
    const remote = createWorld({ catalogs: false });
    const worlds = new Map<string, WooWorld>([
      ["home", home],
      ["remote", remote]
    ]);
    const routes = new Map<ObjRef, string>([["remote_box", "remote"]]);
    home.setExecutorContext(new LocalExecutorContext("home", worlds, routes));
    remote.setExecutorContext(new LocalExecutorContext("remote", worlds, routes));

    remote.createObject({ id: "remote_box", name: "Remote Box", parent: "$thing", owner: "$wiz" });
    remote.defineProperty("remote_box", {
      name: "value",
      defaultValue: "remote",
      owner: "$wiz",
      perms: "rw",
      typeHint: "str"
    });
    remote.addVerb(
      "remote_box",
      bytecodeVerb("value", {
        literals: ["remote_box", "value"],
        num_locals: 0,
        max_stack: 2,
        version: 1,
        ops: [["PUSH_LIT", 0], ["PUSH_LIT", 1], ["GET_PROP"], ["RETURN"]]
      })
    );

    home.createObject({ id: "local_reader", name: "Local Reader", parent: "$thing", owner: actor });
    home.addVerb(
      "local_reader",
      bytecodeVerb(
        "read_remote",
        {
          literals: ["remote_box", "value"],
          num_locals: 0,
          max_stack: 2,
          version: 1,
          ops: [["PUSH_LIT", 0], ["PUSH_LIT", 1], ["CALL_VERB", 0], ["RETURN"]]
        },
        actor
      )
    );

    const ctx: CallContext = {
        world: home,
        space: "the_dubspace",
        seq: 1,
        session: null,
        actor,
      player: actor,
      caller: "#-1",
      callerPerms: actor,
      progr: actor,
      thisObj: "local_reader",
      verbName: "read_remote",
      definer: "local_reader",
      message: message(actor, "local_reader", "read_remote", []),
      observations: [],
      observe: () => {}
    };

    expect(await home.getPropChecked("$wiz", "remote_box", "value")).toBe("remote");
    expect(await home.dispatch(ctx, "local_reader", "read_remote", [])).toBe("remote");

    home.createObject({ id: "local_writer", name: "Local Writer", parent: "$thing", owner: actor });
    home.addVerb(
      "local_writer",
      bytecodeVerb(
        "write_remote",
        {
          literals: ["remote_box", "value", "changed", null],
          num_locals: 0,
          max_stack: 3,
          version: 1,
          ops: [["PUSH_LIT", 0], ["PUSH_LIT", 1], ["PUSH_LIT", 2], ["SET_PROP"], ["PUSH_LIT", 3], ["RETURN"]]
        },
        actor
      )
    );

    const written = await callInDubspace(home, session.id, "cross-host-write", message(actor, "local_writer", "write_remote", []));
    expect(written.op).toBe("applied");
    if (written.op === "applied") expect(written.observations).toHaveLength(0);
    expect(remote.getProp("remote_box", "value")).toBe("changed");
  });

  it("re-entrant cross-host dispatch (A→B→A) does not deadlock the host queue", async () => {
    // Production deadlock: the_deck:look_at($wiz) dispatches look_self
    // on $wiz (gateway-hosted). The gateway's $wiz:look_self walks
    // $wiz.contents and dispatches :title on each item. One item is
    // hosted on the_deck — so the gateway calls back to the_deck for
    // the title. The_deck's queue is busy with look_at; the title
    // dispatch queues behind it. Look_at can't progress (waiting on
    // gateway's response); gateway can't progress (waiting on
    // the_deck's title response). 30s E_TIMEOUT in prod tail.
    //
    // Fix: outbound RPC stamps the active task's chain id; the
    // receiver's hostDispatch runs the call inline (bypassing the
    // queue) when the inbound chain id matches its own currentTask.
    // The fail mode without the fix is a hang — vitest's timeout
    // turns that into a clear test failure.
    const { world: home, actor } = authedWorld();
    const remote = createWorld({ catalogs: false });
    const worlds = new Map<string, WooWorld>([["home", home], ["remote", remote]]);
    const routes = new Map<ObjRef, string>([
      ["remote_obj", "remote"],
      // home_obj must be routable from remote so the callback dispatch
      // resolves; without this entry remote.dispatch falls through to
      // its local table and trips E_OBJNF.
      ["home_obj", "home"]
    ]);
    home.setExecutorContext(new LocalExecutorContext("home", worlds, routes));
    remote.setExecutorContext(new LocalExecutorContext("remote", worlds, routes));
    home.setChainOriginPrefix("home");
    remote.setChainOriginPrefix("remote");

    home.createObject({ id: "home_obj", name: "Home", parent: "$thing", owner: actor });
    remote.createObject({ id: "remote_obj", name: "Remote", parent: "$thing", owner: "$wiz" });

    // home_obj:home_inner — the callback target. Returns a string.
    home.addVerb("home_obj", {
      ...bytecodeVerb(
        "home_inner",
        {
          literals: ["callback-ran"],
          num_locals: 0,
          max_stack: 1,
          version: 1,
          ops: [["PUSH_LIT", 0], ["RETURN"]]
        },
        actor
      ),
      direct_callable: true
    });

    // remote_obj:remote_inner — calls back to home_obj:home_inner
    // (this is the leg that would self-deadlock against the home queue).
    remote.addVerb("remote_obj", {
      ...bytecodeVerb(
        "remote_inner",
        {
          literals: ["home_obj", "home_inner"],
          num_locals: 0,
          max_stack: 2,
          version: 1,
          ops: [["PUSH_LIT", 0], ["PUSH_LIT", 1], ["CALL_VERB", 0], ["RETURN"]]
        },
        "$wiz"
      )
    });

    // home_obj:home_outer — the queued entry. Dispatches remote_inner.
    home.addVerb("home_obj", {
      ...bytecodeVerb(
        "home_outer",
        {
          literals: ["remote_obj", "remote_inner"],
          num_locals: 0,
          max_stack: 2,
          version: 1,
          ops: [["PUSH_LIT", 0], ["PUSH_LIT", 1], ["CALL_VERB", 0], ["RETURN"]]
        },
        actor
      ),
      direct_callable: true
    });

    // Tight timeout: a hang here means re-entrancy isn't taking
    // effect. With the fix, this completes in milliseconds.
    const result = await Promise.race<unknown>([
      home.directCall(undefined, actor, "home_obj", "home_outer", []),
      new Promise((_, reject) => setTimeout(() => reject(new Error("re-entrant deadlock")), 4000))
    ]) as Awaited<ReturnType<typeof home.directCall>>;
    if (result.op !== "result") {
      throw new Error(`expected result, got ${result.op}: ${JSON.stringify((result as { error?: unknown }).error)}`);
    }
    expect(result.result).toBe("callback-ran");
  });

  it("memoizes repeated remote reads within one host operation", async () => {
    const { world: home, actor } = authedWorld();
    const remote = createWorld({ catalogs: false });
    const worlds = new Map<string, WooWorld>([
      ["home", home],
      ["remote", remote]
    ]);
    const routes = new Map<ObjRef, string>([["remote_box", "remote"]]);
    const bridge = new LocalExecutorContext("home", worlds, routes);
    home.setExecutorContext(bridge);
    remote.setExecutorContext(new LocalExecutorContext("remote", worlds, routes));

    remote.createObject({ id: "remote_box", name: "Remote Box", parent: "$thing", owner: "$wiz" });
    remote.defineProperty("remote_box", {
      name: "value",
      defaultValue: "remote",
      owner: "$wiz",
      perms: "r",
      typeHint: "str"
    });
    home.createObject({ id: "memo_reader", name: "Memo Reader", parent: "$thing", owner: actor });
    home.addVerb("memo_reader", {
      ...bytecodeVerb(
        "read_twice",
        {
          literals: ["remote_box", "value"],
          num_locals: 0,
          max_stack: 4,
          version: 1,
          ops: [
            ["PUSH_LIT", 0],
            ["PUSH_LIT", 1],
            ["GET_PROP"],
            ["PUSH_LIT", 0],
            ["PUSH_LIT", 1],
            ["GET_PROP"],
            ["MAKE_LIST", 2],
            ["RETURN"]
          ]
        },
        actor
      ),
      direct_callable: true
    });

    const result = await home.directCall(undefined, actor, "memo_reader", "read_twice", []);
    expect(result.op).toBe("result");
    if (result.op === "result") expect(result.result).toEqual(["remote", "remote"]);
    expect(bridge.getPropCalls.get(`prop:${actor}:remote_box:value`)).toBe(1);
  });

  it("lets woocode collect readable properties across local and remote objects", async () => {
    const { world: home, actor } = authedWorld();
    const remote = createWorld({ catalogs: false });
    const worlds = new Map<string, WooWorld>([
      ["home", home],
      ["remote", remote]
    ]);
    const routes = new Map<ObjRef, string>([
      ["remote_guest", "remote"]
    ]);
    const bridge = new LocalExecutorContext("home", worlds, routes);
    home.setExecutorContext(bridge);
    remote.setExecutorContext(new LocalExecutorContext("remote", worlds, routes));

    remote.createObject({ id: "remote_guest", name: "Remote Guest", parent: "$player", owner: "$wiz" });
    remote.setProp("remote_guest", "name", "Remote Guest");
    home.createObject({ id: "collector", name: "Collector", parent: "$thing", owner: "$wiz" });
    installVerb(home, "collector", "names", "verb :names(actors) rxd {\n  return str_join(collect_prop(actors, \"name\"), \", \");\n}", null);

    const result = await home.directCall(undefined, actor, "collector", "names", [[actor, "remote_guest"]]);
    expect(result.op).toBe("result");
    if (result.op === "result") expect(result.result).toBe(`${home.getProp(actor, "name")}, Remote Guest`);
    expect(bridge.getPropCalls.get(`prop:$wiz:remote_guest:name`)).toBe(1);
  });

  it("charges collect_prop ticks per input object", async () => {
    const { world, actor } = authedWorld();
    for (const id of ["tick_actor_1", "tick_actor_2", "tick_actor_3"]) {
      world.createObject({ id, name: id, parent: "$player", owner: "$wiz" });
      world.setProp(id, "name", id);
    }
    world.createObject({ id: "tick_collector", name: "Tick Collector", parent: "$thing", owner: "$wiz" });
    expect(installVerb(world, "tick_collector", "names", "verb :names(actors) rxd {\n  return collect_prop(actors, \"name\");\n}", null).ok).toBe(true);
    const verb = world.ownVerbExact("tick_collector", "names");
    if (!verb || verb.kind !== "bytecode") throw new Error("expected bytecode verb");
    verb.bytecode.max_ticks = 8;

    const result = await world.directCall("collect-prop-ticks", actor, "tick_collector", "names", [["tick_actor_1", "tick_actor_2", "tick_actor_3"]]);
    expect(result.op).toBe("error");
    if (result.op === "error") expect(result.error.code).toBe("E_TICKS");
  });

  it("batches remote look descriptions into one host read per host", async () => {
    const { world: home, actor } = authedWorld();
    const remote = createWorld({ catalogs: false });
    const worlds = new Map<string, WooWorld>([
      ["home", home],
      ["remote", remote]
    ]);
    const routes = new Map<ObjRef, string>([
      ["remote_lamp", "remote"],
      ["remote_mug", "remote"]
    ]);
    const bridge = new LocalExecutorContext("home", worlds, routes);
    home.setExecutorContext(bridge);
    remote.setExecutorContext(new LocalExecutorContext("remote", worlds, routes));

    remote.createObject({ id: "remote_lamp", name: "Remote Lamp", parent: "$thing", owner: "$wiz" });
    remote.setProp("remote_lamp", "description", "A lamp hosted on a different object host.");
    remote.createObject({ id: "remote_mug", name: "Remote Mug", parent: "$thing", owner: "$wiz" });
    remote.setProp("remote_mug", "description", "A mug hosted beside the lamp.");
    home.object("the_chatroom").contents.add("remote_lamp");
    home.object("the_chatroom").contents.add("remote_mug");

    const entered = await home.directCall(undefined, actor, "the_chatroom", "enter", []);
    expect(entered.op).toBe("result");
    const result = await home.directCall(undefined, actor, "the_chatroom", "look", []);
    expect(result.op).toBe("result");
    if (result.op === "result") {
      const look = result.result as { contents: Array<{ id: string; title: string; description: string }> };
      expect(look.contents.find((item) => item.id === "remote_lamp")).toMatchObject({
        title: "Remote Lamp",
        description: "A lamp hosted on a different object host."
      });
      expect(look.contents.find((item) => item.id === "remote_mug")).toMatchObject({
        title: "Remote Mug",
        description: "A mug hosted beside the lamp."
      });
    }
    expect(bridge.describeManyCalls).toEqual([expect.arrayContaining(["remote_lamp", "remote_mug"])]);
    expect(bridge.describeCalls.size).toBe(0);
    expect(Array.from(bridge.getPropCalls.keys()).some((key) => key.endsWith(":remote_lamp:name"))).toBe(false);
    expect(Array.from(bridge.getPropCalls.keys()).some((key) => key.endsWith(":remote_lamp:description"))).toBe(false);
  });

  it("keeps room announcements tolerant of cross-host contents mirrors", async () => {
    const home = createWorld();
    const remote = createWorld({ catalogs: false });
    const speaker = home.auth("guest:remote-announcement-speaker");
    const witness = home.auth("guest:remote-announcement-witness");
    const worlds = new Map<string, WooWorld>([
      ["home", home],
      ["remote", remote]
    ]);
    const routes = new Map<ObjRef, string>([
      ["remote_welcome_pin", "remote"]
    ]);
    home.setExecutorContext(new LocalExecutorContext("home", worlds, routes));
    remote.setExecutorContext(new LocalExecutorContext("remote", worlds, routes));

    remote.createObject({ id: "remote_welcome_pin", name: "Remote Welcome Pin", parent: "$thing", owner: "$wiz", location: "the_chatroom" });
    home.mirrorContents("the_chatroom", "remote_welcome_pin", true);

    await home.directCall("remote-ann-speaker-enter", speaker.actor, "the_chatroom", "enter", [], { sessionId: speaker.id });
    await home.directCall("remote-ann-witness-enter", witness.actor, "the_chatroom", "enter", [], { sessionId: witness.id });

    const blockedSouth = await home.directCall("remote-ann-south-window", speaker.actor, "the_chatroom", "south", [], { sessionId: speaker.id });

    expect(blockedSouth.op).toBe("result");
    if (blockedSouth.op === "result") {
      expect(String(blockedSouth.result)).toMatch(/plate-glass/);
      expect(blockedSouth.observations).toContainEqual(expect.objectContaining({
        type: "text",
        source: "the_chatroom",
        target: witness.actor,
        text: `${home.object(speaker.actor).name} attempts to walk through the plate-glass windows. Fortunately, they're tougher than that.`
      }));
    }
  });

  it("examines visible remote objects through host summaries instead of local object lookup", async () => {
    const home = createWorld();
    const remote = createWorld({ catalogs: false });
    const session = home.auth("guest:remote-examine");
    const worlds = new Map<string, WooWorld>([
      ["home", home],
      ["remote", remote]
    ]);
    const routes = new Map<ObjRef, string>([
      ["remote_welcome_pin", "remote"]
    ]);
    home.setExecutorContext(new LocalExecutorContext("home", worlds, routes));
    remote.setExecutorContext(new LocalExecutorContext("remote", worlds, routes));

    remote.createObject({ id: "remote_welcome_pin", name: "Remote Welcome Pin", parent: "$thing", owner: "$wiz", location: "the_chatroom" });
    remote.setProp("remote_welcome_pin", "description", "A pin hosted somewhere else.");
    remote.setProp("remote_welcome_pin", "aliases", ["remote pin"]);
    remote.addVerb("remote_welcome_pin", {
      ...nativeVerb("polish"),
      perms: "rxd",
      direct_callable: true,
      arg_spec: { command: { dobj: "this", prep: "none", iobj: "none", args_from: [] } }
    });
    home.mirrorContents("the_chatroom", "remote_welcome_pin", true);
    await home.directCall("remote-examine-enter", session.actor, "the_chatroom", "enter", [], { sessionId: session.id });

    const examined = await home.directCall("remote-examine", session.actor, session.actor, "examine_detailed", ["remote pin"], { sessionId: session.id });

    expect(examined.op).toBe("result");
    if (examined.op === "result") {
      expect(examined.result).toMatchObject({
        target: "remote_welcome_pin",
        owner: "$wiz",
        remote: true,
        aliases: ["remote pin"],
        description: "A pin hosted somewhere else.",
        obvious_verbs: expect.arrayContaining([expect.stringContaining("polish remote pin")])
      });
      expect(examined.observations).toContainEqual(expect.objectContaining({
        type: "text",
        target: session.actor,
        text: expect.stringContaining("Obvious verbs:")
      }));
    }
  });

  it("routes mounted-space direct observations to a remote room audience", async () => {
    const chat = createWorld();
    const pinboard = createWorld();
    const actor = chat.auth("guest:mounted-space-actor");
    const watcher = chat.auth("guest:mounted-space-watcher");
    const worlds = new Map<string, WooWorld>([
      ["chat", chat],
      ["pinboard", pinboard]
    ]);
    const routes = new Map<ObjRef, string>([
      [actor.actor, "chat"],
      [watcher.actor, "chat"],
      ["the_deck", "chat"],
      ["the_pinboard", "pinboard"]
    ]);
    chat.setExecutorContext(new LocalExecutorContext("chat", worlds, routes));
    pinboard.setExecutorContext(new LocalExecutorContext("pinboard", worlds, routes));

    chat.setActorPresence(watcher.actor, "the_deck", true);
    chat.setSpaceSubscriber("the_deck", watcher.actor, true);

    const entered = await chat.directCall("remote-mounted-pinboard-enter", actor.actor, actor.actor, "moveto", ["the_pinboard"], { sessionId: actor.id });

    expect(entered.op).toBe("result");
    if (entered.op !== "result") return;
    expect(entered.observations.map((obs) => obs.type)).toEqual(["pinboard_entered", "pinboard_activity"]);
    expect(entered.observations[1]).toMatchObject({ source: "the_deck", board: "the_pinboard", actor: actor.actor });
    expect(entered.observationAudiences?.[0]).toEqual([actor.actor]);
    expect(entered.observationAudiences?.[1]).toEqual([watcher.actor]);
  });

  it("checks VM property mutations against the running progr", async () => {
    const { world, session, actor } = authedWorld();
    world.createObject({ id: "private_box", name: "Private Box", parent: "$thing", owner: "$wiz" });
    world.defineProperty("private_box", {
      name: "secret",
      defaultValue: "before",
      owner: "$wiz",
      perms: "r",
      typeHint: "str"
    });
    world.addVerb(
      "delay_1",
      bytecodeVerb(
        "write_private",
        {
          literals: ["private_box", "secret", "after", null],
          num_locals: 0,
          max_stack: 3,
          version: 1,
          ops: [["PUSH_LIT", 0], ["PUSH_LIT", 1], ["PUSH_LIT", 2], ["SET_PROP"], ["PUSH_LIT", 3], ["RETURN"]]
        },
        actor
      )
    );

    const failedWrite = await callInDubspace(world, session.id, "private-write", message(actor, "delay_1", "write_private", []));
    expect(failedWrite.op).toBe("applied");
    if (failedWrite.op === "applied") expect(failedWrite.observations[0]).toMatchObject({ type: "$error", code: "E_PERM" });
    expect(world.getProp("private_box", "secret")).toBe("before");

    world.addVerb(
      "delay_1",
      bytecodeVerb(
        "define_on_wiz",
        {
          literals: ["$wiz", "new_private_prop", "x", "rw", null],
          num_locals: 0,
          max_stack: 4,
          version: 1,
          ops: [["PUSH_LIT", 0], ["PUSH_LIT", 1], ["PUSH_LIT", 2], ["PUSH_LIT", 3], ["DEFINE_PROP"], ["PUSH_LIT", 4], ["RETURN"]]
        },
        actor
      )
    );
    const failedDefine = await callInDubspace(world, session.id, "private-define", message(actor, "delay_1", "define_on_wiz", []));
    expect(failedDefine.op).toBe("applied");
    if (failedDefine.op === "applied") expect(failedDefine.observations[0]).toMatchObject({ type: "$error", code: "E_PERM" });
    expect(() => world.propertyInfo("$wiz", "new_private_prop")).toThrow();

    world.addVerb(
      "delay_1",
      bytecodeVerb(
        "retag_private",
        {
          literals: ["private_box", "secret", { perms: "rw" }, null],
          num_locals: 0,
          max_stack: 3,
          version: 1,
          ops: [["PUSH_LIT", 0], ["PUSH_LIT", 1], ["PUSH_LIT", 2], ["SET_PROP_INFO"], ["PUSH_LIT", 3], ["RETURN"]]
        },
        actor
      )
    );
    const failedInfo = await callInDubspace(world, session.id, "private-info", message(actor, "delay_1", "retag_private", []));
    expect(failedInfo.op).toBe("applied");
    if (failedInfo.op === "applied") expect(failedInfo.observations[0]).toMatchObject({ type: "$error", code: "E_PERM" });
    expect(world.propertyInfo("private_box", "secret").perms).toBe("r");
  });

  it("routes VM property assignment to a remote object host", async () => {
    const home = createWorld();
    const remote = createWorld();
    const worlds = new Map<string, WooWorld>([
      ["home", home],
      ["remote", remote]
    ]);
    const routes = new Map<ObjRef, string>([
      ["delay_1", "home"],
      ["remote_box", "remote"]
    ]);
    home.setExecutorContext(new LocalExecutorContext("home", worlds, routes));
    remote.setExecutorContext(new LocalExecutorContext("remote", worlds, routes));
    remote.createObject({ id: "remote_box", name: "Remote Box", parent: "$thing", owner: "$wiz" });
    remote.defineProperty("remote_box", {
      name: "secret",
      defaultValue: "before",
      owner: "$wiz",
      perms: "r",
      typeHint: "str"
    });
    home.addVerb(
      "delay_1",
      bytecodeVerb("write_remote_box", {
        literals: ["remote_box", "secret", "after", true],
        num_locals: 0,
        max_stack: 3,
        version: 1,
        ops: [["PUSH_LIT", 0], ["PUSH_LIT", 1], ["PUSH_LIT", 2], ["SET_PROP"], ["PUSH_LIT", 3], ["RETURN"]]
      })
    );

    const result = await home.directCall("remote-prop-write", "$wiz", "delay_1", "write_remote_box", []);

    expect(result.op).toBe("result");
    expect(remote.getProp("remote_box", "secret")).toBe("after");
  });

  it("treats owner as a read-only core field projection", () => {
    const world = createWorld();
    const session = world.auth("guest:owner-field");
    world.createObject({ id: "owner_probe", parent: "$thing", owner: session.actor });

    expect(world.getProp("owner_probe", "owner")).toBe(session.actor);
    expect(world.propertyInfo("owner_probe", "owner")).toMatchObject({
      owner: session.actor,
      perms: "r",
      defined_on: "owner_probe",
      has_value: true
    });
    expect(() => world.setProp("owner_probe", "owner", "$wiz")).toThrow();
    expect(() => world.defineProperty("owner_probe", { name: "owner", defaultValue: "$wiz", owner: "$wiz", perms: "rw" })).toThrow();
  });

  it("separates alias-aware verb lookup from exact-slot replacement lookup", () => {
    const world = createWorld();
    world.createObject({ id: "alias_probe", parent: "$thing", owner: "$wiz" });
    world.addVerb("alias_probe", { ...nativeVerb("look"), aliases: ["ex*"] });

    expect(world.ownVerb("alias_probe", "examine")?.name).toBe("look");
    expect(world.ownVerbExact("alias_probe", "examine")).toBeNull();
    expect(world.ownVerbExact("alias_probe", "look")?.name).toBe("look");
  });

  it("does not expose inherited generic root setters as public capabilities", async () => {
    const { world, session, actor } = authedWorld();
    const before = world.getProp("$wiz", "description");
    const result = await callInDubspace(world, session.id, "root-setter", message(actor, "$wiz", "set_prop", ["description", "pwned"]));
    expect(result.op).toBe("applied");
    if (result.op === "applied") expect(result.observations[0]).toMatchObject({ type: "$error", code: "E_PERM" });
    expect(world.getProp("$wiz", "description")).toBe(before);
    expect(world.verbInfo("$root", "set_prop").perms).not.toContain("x");
  });

  it("does not expose maintenance verbs as public capabilities", async () => {
    const { world, session, actor } = authedWorld();
    const wizLocation = world.object("$wiz").location;
    const moved = await callInDubspace(world, session.id, "move-wiz", message(actor, "$wiz", "moveto", ["the_dubspace"]));
    expect(moved.op).toBe("applied");
    if (moved.op === "applied") expect(moved.observations[0]).toMatchObject({ type: "$error", code: "E_PERM" });
    expect(world.object("$wiz").location).toBe(wizLocation);

    const returned = await callInDubspace(world, session.id, "return-guest", message(actor, "$system", "return_guest", [actor]));
    expect(returned.op).toBe("applied");
    if (returned.op === "applied") expect(returned.observations[0]).toMatchObject({ type: "$error", code: "E_PERM" });

    const reset = await callInDubspace(world, session.id, "reset-guest", message(actor, actor, "on_disfunc", []));
    expect(reset.op).toBe("applied");
    if (reset.op === "applied") expect(reset.observations[0]).toMatchObject({ type: "$error", code: "E_PERM" });
  });

  it("scopes dubspace public mutators to controls in that dubspace", async () => {
    const { world, session, actor } = authedWorld();
    const before = world.getProp("$wiz", "description");
    const rejected = await callInDubspace(world, session.id, "dubspace-set-wiz", message(actor, "the_dubspace", "set_control", ["$wiz", "description", "pwned"]));
    expect(rejected.op).toBe("applied");
    if (rejected.op === "applied") expect(rejected.observations[0]).toMatchObject({ type: "$error", code: "E_PERM" });
    expect(world.getProp("$wiz", "description")).toBe(before);

    const valid = await callInDubspace(world, session.id, "dubspace-set-valid", message(actor, "the_dubspace", "set_control", ["delay_1", "wet", 0.63]));
    expect(valid.op).toBe("applied");
    if (valid.op === "applied") expect(valid.observations[0]).toMatchObject({ type: "control_changed", target: "delay_1", name: "wet" });
    expect(world.getProp("delay_1", "wet")).toBe(0.63);

    const badSlot = await callInDubspace(world, session.id, "dubspace-start-wiz", message(actor, "the_dubspace", "start_loop", ["$wiz"]));
    expect(badSlot.op).toBe("applied");
    if (badSlot.op === "applied") expect(badSlot.observations[0]).toMatchObject({ type: "$error", code: "E_PERM" });
    expect(world.propOrNull("$wiz", "playing")).toBeNull();
  });

  it("runs chat command dispatch under actor authority when entering the planned verb", async () => {
    // The actor in this assertion is not a presence-bearing room subscriber;
    // demoworld would otherwise auto-place fresh guests in Living Room and
    // shift this test off its intended path.
    const world = createWorld();
    world.setProp("$system", "guest_initial_room", null);
    const session = world.auth("guest:test");
    const actor = session.actor;
    world.createObject({ id: "sealed_sign", name: "Sealed Sign", parent: "$thing", owner: "$wiz", location: "the_chatroom" });
    world.addVerb("sealed_sign", {
      ...nativeVerb("poke", "describe", "$wiz"),
      perms: "r",
      direct_callable: true
    });

    const result = await world.directCall("sealed-command", actor, "the_chatroom", "command", ["poke Sealed Sign"]);
    expect(result.op).toBe("error");
    if (result.op === "error") expect(result.error.code).toBe("E_PERM");
  });

  it("seeds readable descriptions for every bootstrap object", async () => {
    const world = createWorld();
    for (const id of world.objects.keys()) {
      const description = world.getProp(id, "description");
      expect(typeof description, id).toBe("string");
      expect((description as string).length, id).toBeGreaterThan(40);
    }
  });

  it("installs first-light demos from local catalog manifests", async () => {
    const world = createWorld();
    const installed = world.getProp("$catalog_registry", "installed_catalogs") as Record<string, unknown>[];
    const aliases = bundledCatalogAliases();
    expect(installed.map((record) => record.alias)).toEqual(aliases);
    expect(world.replay("$catalog_registry", 1, 10).map((entry) => entry.message.verb)).toEqual([]);
    bootstrap(world);
    expect(world.replay("$catalog_registry", 1, 10).map((entry) => entry.message.verb)).toEqual([]);
    expect(world.object("catalog_dubspace").parent).toBe("$catalog");
    expect(world.object("$space").parent).toBe("$sequenced_log");
    expect(world.object("$dubspace").parent).toBe("$room");
    expect(world.object("$pinboard").parent).toBe("$room");
    expect(world.object("$conversational").parent).toBe("$thing");
    expect(world.object("$dubspace").eventSchemas.has("control_changed")).toBe(true);
    // Schema-ledger hygiene (net-cutover item 2): `text` (chat's tell() type)
    // is now declared where it was emitted-but-undeclared; the dead `help`
    // schema (help emits no observation — it ships help text as a directed
    // `text`) is removed.
    expect(world.object("$conversational").eventSchemas.has("text")).toBe(true);
    expect(world.object("$generic_help_db").eventSchemas.has("help")).toBe(false);
    expect(world.verbInfo("the_dubspace", "set_control").source).toContain("target.(name)");
    expect(world.verbInfo("the_dubspace", "start_loop").bytecode_version).toBeGreaterThan(0);
    expect(world.verbInfo("the_chatroom", "say").definer).toBe("$conversational");
    // catalog_registry:list is now a compiled sourceVerb (net-cutover item 3),
    // not a native — it must carry bytecode and return installed_catalogs.
    expect(world.verbInfo("$catalog_registry", "list").bytecode_version).toBeGreaterThan(0);
  });

  it("catalog_registry:list returns installed_catalogs via the ported sourceVerb", async () => {
    const world = createWorld();
    const listed = await world.directCall("registry-list", "$wiz", "$catalog_registry", "list", []);
    expect(listed.op).toBe("result");
    if (listed.op === "result") {
      expect(listed.result).toEqual(world.getProp("$catalog_registry", "installed_catalogs"));
    }
  });

  it("can boot without demo catalogs and install them later", async () => {
    const world = createWorld({ catalogs: false });
    expect(() => world.object("the_dubspace")).toThrow(/E_OBJNF|object not found/);
    expect(world.getProp("$catalog_registry", "installed_catalogs")).toEqual([]);
    const session = world.auth("guest:clean");
    expect(world.allLocationsForActor(session.actor)).toEqual(["$nowhere"]);

    installLocalCatalogs(world, ["chat", "demoworld", "pinboard", "dubspace"]);
    expect(world.object("the_chatroom").parent).toBe("$chatroom");
    expect(world.object("the_pinboard").parent).toBe("$pinboard");
    expect(world.object("the_dubspace").parent).toBe("$dubspace");
    expect(world.verbInfo("the_dubspace", "say").definer).toBe("$transparent");
  });

  it("exports host-scoped worlds for routed cluster hosts", async () => {
    const world = createWorld();
    world.auth("guest:host-scope");
    const parked: ParkedTaskRecord = {
      id: "ptask_12",
      parked_on: "the_pinboard",
      state: "suspended",
      resume_at: Date.now() + 1000,
      awaiting_player: null,
      correlation_id: null,
      serialized: { kind: "test", space: "the_pinboard", target: "the_pinboard" },
      created: Date.now(),
      origin: "the_pinboard"
    };
    world.parkedTasks.set(parked.id, parked);
    const scoped = world.exportHostScopedWorld("the_pinboard");
    const ids = scoped.objects.map((obj) => obj.id);

    expect(ids).toContain("the_pinboard");
    expect(ids).toContain("$pinboard");
    expect(ids).toContain("$pin");
    expect(ids).toContain("$conversational");
    expect(ids).toContain("the_dubspace");
    expect(scoped.sessions).toEqual([]);
    expect(scoped.logs.every(([space]) => space === "the_pinboard")).toBe(true);
    expect(scoped.parkedTaskCounter).toBe(13);

    const cluster = createWorldFromSerialized(scoped, { persist: false });
    const clusterSession = cluster.auth("guest:host-scope");
    const entered = await cluster.directCall("host-scope-moveto", clusterSession.actor, clusterSession.actor, "moveto", ["the_pinboard"], { sessionId: clusterSession.id });
    expect(entered.op).toBe("result");
    const created = await cluster.call("host-scope-create", clusterSession.id, "the_pinboard", message(clusterSession.actor, "the_pinboard", "add_note", ["Scoped"]));
    expect(created.op).toBe("applied");
    if (created.op !== "applied") return;
    const noteAdded = created.observations.find((obs) => obs.type === "note_added");
    const pin = String((noteAdded?.note as Record<string, unknown> | undefined)?.id ?? noteAdded?.pin ?? "");
    expect(pin).toMatch(/^obj_the_pinboard_/);
    expect(cluster.object(pin).parent).toBe("$pin");
    expect(cluster.objectRoutes()).toContainEqual({ id: pin, host: "the_pinboard", anchor: "the_pinboard" });
  });

  it("does not copy gateway-global counters into host-scoped seed exports", () => {
    const stored = createWorld();
    const fresh = createWorld();
    for (let i = 0; i < 5; i += 1) {
      fresh.createRuntimeObject("$thing", "$wiz", null, { name: `Gateway-only ${i}` });
    }

    const storedScoped = stored.exportHostScopedWorld("the_taskspace");
    const freshScoped = fresh.exportHostScopedWorld("the_taskspace");

    expect(fresh.exportWorld().objectCounter).toBeGreaterThan(stored.exportWorld().objectCounter);
    expect(freshScoped.objectCounter).toBe(storedScoped.objectCounter);
    expect(mergeHostScopedSeedWithStatus(storedScoped, freshScoped, "the_taskspace").changed).toBe(false);
  });

  it("treats stored worlds without a host slice as unusable for cluster boot", async () => {
    const full = createWorld().exportWorld();
    const stale = {
      ...full,
      objects: full.objects.map((obj) => obj.id === "the_dubspace"
        ? { ...obj, properties: obj.properties.filter(([name]) => name !== "host_placement") }
        : obj)
    };

    expect(nonEmptyHostScopedWorld(stale, "the_dubspace")).toBeNull();
    expect(nonEmptyHostScopedWorld(full, "the_dubspace")?.objects.map((obj) => obj.id)).toContain("the_dubspace");
  });

  it("can prune a full serialized world to one host slice", async () => {
    const full = createWorld().exportWorld();
    const scoped = scopeSerializedWorldToHost(full, "the_dubspace");
    const ids = scoped.objects.map((obj) => obj.id);

    expect(ids).toContain("the_dubspace");
    expect(ids).toContain("$dubspace");
    expect(ids).toContain("$loop_slot");
    expect(ids).toContain("slot_1");
    expect(ids).toContain("the_pinboard");
    expect(ids).toContain("the_chatroom");

    const chatScoped = scopeSerializedWorldToHost(full, "the_chatroom");
    const chatIds = chatScoped.objects.map((obj) => obj.id);
    const room = chatScoped.objects.find((obj) => obj.id === "the_chatroom");
    const mountedDubspace = chatScoped.objects.find((obj) => obj.id === "the_dubspace");
    expect(chatIds).toContain("the_dubspace");
    expect(mountedDubspace?.contents).toEqual([
      "slot_1",
      "slot_2",
      "slot_3",
      "slot_4",
      "channel_1",
      "filter_1",
      "delay_1",
      "drum_1",
      "default_scene"
    ]);
    expect(room?.contents).toContain("the_dubspace");
  });

  it("lets a host-scoped chat room enter even with mirror-only contents refs", async () => {
    const full = createWorld().exportWorld();
    const scoped = nonEmptyHostScopedWorld(full, "the_chatroom");
    expect(scoped).not.toBeNull();

    const cluster = createWorldFromSerialized(scoped!, { persist: false });
    const session = cluster.auth("guest:host-chat-enter");
    const entered = await cluster.directCall("host-chat-enter", session.actor, "the_chatroom", "enter", []);

    expect(entered.op).toBe("result");
    if (entered.op !== "result") return;
    expect(entered.result).toMatchObject({ room: "the_chatroom", look_deferred: true });
    const look = await cluster.directCall("host-chat-look", session.actor, "the_chatroom", "look", []);
    expect(look.op).toBe("result");
    if (look.op !== "result") return;
    const looked = look.observations.find((obs) => obs.type === "looked") as Record<string, any> | undefined;
    expect(looked?.text).toContain("Dubspace");
    expect(looked?.look?.contents?.map((item: Record<string, string>) => item.id)).toEqual(expect.arrayContaining(["the_lamp", "the_mug", "the_dubspace"]));
  });

  it("preserves receiver-hosted state through merge and additively restores missing receiver-hosted subjects (HS2.1)", async () => {
    const staleWorld = createWorld();
    const session = staleWorld.auth("guest:merge-host-seed");
    // Receiver-side mutations to the receiver-hosted room.
    staleWorld.object("the_chatroom").name = "Lobby";
    staleWorld.setProp("the_chatroom", "name", "Lobby");
    staleWorld.setProp("the_chatroom", "subscribers", [session.actor]);
    staleWorld.setProp("the_chatroom", "next_seq", 42);
    // Missing-from-stored case: receiver lost some hosted objects.
    staleWorld.objects.delete("the_lamp");
    staleWorld.objects.delete("the_mug");
    staleWorld.objects.delete("the_dubspace");
    staleWorld.object("the_chatroom").contents.delete("the_lamp");
    staleWorld.object("the_chatroom").contents.delete("the_dubspace");

    const fresh = createWorld().exportWorld();
    const staleScoped = nonEmptyHostScopedWorld(staleWorld.exportWorld(), "the_chatroom");
    const freshScoped = nonEmptyHostScopedWorld(fresh, "the_chatroom");
    expect(staleScoped).not.toBeNull();
    expect(freshScoped).not.toBeNull();

    const merged = mergeHostScopedSeed(staleScoped!, freshScoped!, "the_chatroom");
    const reloaded = createWorldFromSerialized(merged, { persist: false });

    // HS2.1 strict receiver-authority: stored fields are NOT overwritten.
    expect(reloaded.object("the_chatroom").name).toBe("Lobby");
    expect(reloaded.getProp("the_chatroom", "name")).toBe("Lobby");
    expect(reloaded.getProp("the_chatroom", "subscribers")).toEqual([session.actor]);
    expect(reloaded.getProp("the_chatroom", "next_seq")).toBe(42);

    // HS2.1 additive: receiver-hosted subjects missing from stored are
    // initialized from the seed.
    expect(reloaded.objects.has("the_lamp")).toBe(true);
    expect(reloaded.objects.has("the_mug")).toBe(true);
    expect(reloaded.objects.has("the_dubspace")).toBe(true);
    expect(reloaded.object("the_lamp").location).toBe("the_chatroom");
    expect(reloaded.object("the_dubspace").location).toBe("the_chatroom");
  });

  it("merges fresh host seed without overwriting authored host-state properties", () => {
    const storedWorld = createWorld();
    storedWorld.setProp("the_pinboard", "notes", [
      { id: "n1", text: "keep me", color: "yellow", x: 48, y: 48, w: 180, h: 110, z: 1 }
    ]);
    storedWorld.setProp("the_pinboard", "next_note_id", 2);
    storedWorld.setProp("the_pinboard", "next_z", 2);

    const freshWorld = createWorld();
    const storedScoped = nonEmptyHostScopedWorld(storedWorld.exportWorld(), "the_pinboard");
    const freshScoped = nonEmptyHostScopedWorld(freshWorld.exportWorld(), "the_pinboard");
    expect(storedScoped).not.toBeNull();
    expect(freshScoped).not.toBeNull();

    const merged = mergeHostScopedSeed(storedScoped!, freshScoped!, "the_pinboard");
    const reloaded = createWorldFromSerialized(merged, { persist: false });

    expect(reloaded.getProp("the_pinboard", "notes")).toEqual([
      { id: "n1", text: "keep me", color: "yellow", x: 48, y: 48, w: 180, h: 110, z: 1 }
    ]);
    expect(reloaded.getProp("the_pinboard", "next_note_id")).toBe(2);
    expect(reloaded.getProp("the_pinboard", "next_z")).toBe(2);
    expect(reloaded.ownVerb("$pinboard", "add_note")).toBeDefined();
  });

  // spec/protocol/host-seeds.md §HS5 idempotency: two consecutive
  // cold-loads of a quiescent cluster MUST produce zero satellite-side
  // writes after the first. The cold-load path computes that signal
  // through `mergeHostScopedSeedWithStatus(...).changed`; if it ever
  // flips back to true on a second pass, the implementation has lost
  // the spec's invariant.
  it("HS5: merge is idempotent — second pass over the same stored+seed reports changed=false", () => {
    const gateway = createWorld();
    const seed = gateway.buildHostSeedForDelivery("the_pinboard");
    const stored = nonEmptyHostScopedWorld(gateway.exportWorld(), "the_pinboard");
    expect(stored).not.toBeNull();

    const first = mergeHostScopedSeedWithStatus(stored!, seed, "the_pinboard");
    const second = mergeHostScopedSeedWithStatus(first.world, seed, "the_pinboard");
    expect(second.changed).toBe(false);
  });

  it("HS5: cold-load merge is idempotent across hosts (the_chatroom, the_dubspace, the_pinboard)", () => {
    const gateway = createWorld();
    for (const host of ["the_chatroom", "the_dubspace", "the_pinboard"] as const) {
      const seed = gateway.buildHostSeedForDelivery(host);
      const stored = nonEmptyHostScopedWorld(gateway.exportWorld(), host);
      expect(stored, `stored slice for ${host}`).not.toBeNull();
      const first = mergeHostScopedSeedWithStatus(stored!, seed, host);
      const second = mergeHostScopedSeedWithStatus(first.world, seed, host);
      expect(second.changed, `${host} second-pass changed`).toBe(false);
    }
  });

  it("HS2.1: receiver-hosted subjects with stored entries are skipped (gateway-side mutations do not stomp receiver state)", () => {
    const stored = createWorld();
    stored.object("the_chatroom").name = "Receiver Lobby";
    const storedSlice = nonEmptyHostScopedWorld(stored.exportWorld(), "the_chatroom");
    expect(storedSlice).not.toBeNull();

    // Build a divergent seed by mutating the gateway's view.
    const gateway = createWorld();
    gateway.object("the_chatroom").name = "Gateway Living Room";
    const seed = gateway.buildHostSeedForDelivery("the_chatroom");

    const merged = mergeHostScopedSeedWithStatus(storedSlice!, seed, "the_chatroom");
    const after = merged.world.objects.find((obj) => obj.id === "the_chatroom");
    expect(after?.name).toBe("Receiver Lobby");
  });

  it("HS2.2 verbs: an aliases-only catalog update propagates from gateway to satellite (source_hash short-circuit must compare aliases)", () => {
    const gateway = createWorld();
    const satellite = createWorld();
    const stored = nonEmptyHostScopedWorld(satellite.exportWorld(), "the_pinboard");
    expect(stored).not.toBeNull();

    // Pick a class verb both worlds share. Mutate aliases on gateway
    // only — leaving source unchanged so source_hash matches.
    const noteOnGateway = gateway.object("$note").verbs.find((v) => v.name === "read");
    expect(noteOnGateway).toBeDefined();
    if (!noteOnGateway) return;
    noteOnGateway.aliases = [...(noteOnGateway.aliases ?? []), "rd"];

    const seed = gateway.buildHostSeedForDelivery("the_pinboard");
    const merged = mergeHostScopedSeedWithStatus(stored!, seed, "the_pinboard");
    expect(merged.changed).toBe(true);
    const noteAfter = merged.world.objects.find((o) => o.id === "$note");
    const readAfter = noteAfter?.verbs.find((v) => v.name === "read");
    expect(readAfter?.aliases).toContain("rd");
  });

  it("HS2.2 verbs: an arg_spec-only catalog update propagates (source_hash short-circuit must compare arg_spec)", () => {
    const gateway = createWorld();
    const satellite = createWorld();
    const stored = nonEmptyHostScopedWorld(satellite.exportWorld(), "the_pinboard");
    expect(stored).not.toBeNull();

    const noteOnGateway = gateway.object("$note").verbs.find((v) => v.name === "read");
    expect(noteOnGateway).toBeDefined();
    if (!noteOnGateway) return;
    noteOnGateway.arg_spec = { ...noteOnGateway.arg_spec, command: { dobj: "this", prep: ["with"], iobj: "string" } };

    const seed = gateway.buildHostSeedForDelivery("the_pinboard");
    const merged = mergeHostScopedSeedWithStatus(stored!, seed, "the_pinboard");
    expect(merged.changed).toBe(true);
    const noteAfter = merged.world.objects.find((o) => o.id === "$note");
    const readAfter = noteAfter?.verbs.find((v) => v.name === "read");
    expect(readAfter?.arg_spec).toEqual(expect.objectContaining({ command: expect.objectContaining({ dobj: "this" }) }));
  });

  it("setProp is idempotent on equal values — no version bump, no persist", () => {
    // The host-seed merge depends on propertyVersions[name] tracking
    // *real* changes. Every gateway-side `setProp(equal_value)` would
    // otherwise propagate as a forced satellite snapshot every cold-load
    // (catalog repair, returnGuest cleanup that re-clears already-empty
    // fields, periodic reconciliation, etc.). Pin the new contract:
    // value-equal means no bump.
    const w = createWorld();
    w.setProp("$system", "extra_attr", { foo: 1, bar: [2, 3] });
    const v1 = w.object("$system").propertyVersions.get("extra_attr");
    expect(v1).toBeGreaterThanOrEqual(1);
    // Re-set the same value (deep-equal but a fresh object reference).
    w.setProp("$system", "extra_attr", { foo: 1, bar: [2, 3] });
    expect(w.object("$system").propertyVersions.get("extra_attr")).toBe(v1);
    // Real change does bump.
    w.setProp("$system", "extra_attr", { foo: 2, bar: [2, 3] });
    expect(w.object("$system").propertyVersions.get("extra_attr")).toBe((v1 ?? 0) + 1);
  });

  it("HS2.2: propertyVersion drift with equal value does NOT drive a merge change", () => {
    // setProp bumps propertyVersions[name] on every call. Older
    // gateway-side code (and stored worlds persisted before the
    // setProp idempotency fix) could rewrite the same value and
    // produce a seed with a higher version than stored even though
    // the actual value matched. The merge previously took the bumped
    // version, declared changed=true, and burned a satellite snapshot
    // every cold-load. Version must travel with value: only bump when
    // the value also changes.
    //
    // setProp is now idempotent on equal values, so the trap is
    // simulated by tampering with the seed's propertyVersions
    // directly — same data shape a pre-fix world would have produced.
    const gateway = createWorld();
    const satellite = createWorld();
    gateway.setProp("$system", "extra_attr", "shared_value");
    satellite.setProp("$system", "extra_attr", "shared_value");

    const storedSlice = nonEmptyHostScopedWorld(satellite.exportWorld(), "the_pinboard");
    expect(storedSlice).not.toBeNull();
    const seed = gateway.buildHostSeedForDelivery("the_pinboard");
    const sysSeedIdx = seed.objects.findIndex((o) => o.id === "$system");
    const sysSeed = { ...seed.objects[sysSeedIdx] };
    sysSeed.propertyVersions = sysSeed.propertyVersions.map(([n, v]) => n === "extra_attr" ? [n, v + 100] as [string, number] : [n, v]);
    seed.objects[sysSeedIdx] = sysSeed;

    const merged = mergeHostScopedSeedWithStatus(storedSlice!, seed, "the_pinboard");
    expect(merged.changed).toBe(false);
  });

  it("HS2.2: verb.version drift alone does NOT drive a merge change", () => {
    // Same shape as the propertyDef.version trap. addVerb / catalog repair
    // bump verb.version on every idempotent reinstall; production
    // satellites accumulate this counter past the gateway's authoritative
    // value and the merge previously replaced them every cold-load.
    const gateway = createWorld();
    const satellite = createWorld();
    const storedSlice = nonEmptyHostScopedWorld(satellite.exportWorld(), "the_pinboard");
    expect(storedSlice).not.toBeNull();

    const actorStored = storedSlice!.objects.find((o) => o.id === "$actor");
    expect(actorStored).toBeDefined();
    expect(actorStored!.verbs.length).toBeGreaterThan(0);
    actorStored!.verbs = actorStored!.verbs.map((v) => ({ ...v, version: 99 }));

    const seed = gateway.buildHostSeedForDelivery("the_pinboard");
    const merged = mergeHostScopedSeedWithStatus(storedSlice!, seed, "the_pinboard");
    expect(merged.changed).toBe(false);
  });

  it("HS2.2: propertyDef.version drift alone does NOT drive a merge change", () => {
    // Catalog repair / schema sync calls defineProperty(); each call bumps
    // PropertyDef.version even when the def is otherwise unchanged. On a
    // satellite running cold-load lifecycle, this counter accumulates
    // independently of the gateway's. Production satellites had stored
    // versions like $help.description=131 against gateway=30. Including
    // version in the merge's def comparison made the merge non-idempotent
    // (replace → next setProp bump → replace again on next cold-load) and
    // burned a full satellite snapshot every wake. The merge must compare
    // authoritative def fields only.
    const gateway = createWorld();
    const satellite = createWorld();
    const storedSlice = nonEmptyHostScopedWorld(satellite.exportWorld(), "the_pinboard");
    expect(storedSlice).not.toBeNull();

    // $root.description is a seeded propertyDef carried into every host
    // slice via lineage. Bump its version on stored to simulate accumulated
    // satellite-side drift; gateway's version stays at the seed default.
    const rootStored = storedSlice!.objects.find((o) => o.id === "$root");
    expect(rootStored).toBeDefined();
    const descIdx = rootStored!.propertyDefs.findIndex((d) => d.name === "description");
    expect(descIdx).toBeGreaterThanOrEqual(0);
    rootStored!.propertyDefs[descIdx] = { ...rootStored!.propertyDefs[descIdx], version: 131 };

    const seed = gateway.buildHostSeedForDelivery("the_pinboard");
    const merged = mergeHostScopedSeedWithStatus(storedSlice!, seed, "the_pinboard");
    expect(merged.changed).toBe(false);
  });

  it("HS1: buildHostSeedForDelivery strips verb.line_map (authoring metadata not needed on receiver)", () => {
    // line_map dominates seed payload size on classes with many compiled
    // verbs; delivery strips it to halve the per-host seed body. The
    // satellite recompiles line_map for bundled-catalog verbs through
    // runHostScopedLocalCatalogLifecycle's repair path, and verbs from
    // non-bundled sources accept the soft degradation (stack traces lose
    // line numbers on the satellite). Stored slices preserve any
    // populated line_map they already have — see the idempotency test
    // immediately below.
    const gateway = createWorld();
    const seed = gateway.buildHostSeedForDelivery("the_pinboard");
    expect(seed.objects.length).toBeGreaterThan(0);
    let countedVerbs = 0;
    for (const obj of seed.objects) {
      for (const verb of obj.verbs) {
        countedVerbs += 1;
        expect(verb.line_map, `${obj.id}:${verb.name} line_map`).toEqual({});
      }
    }
    expect(countedVerbs).toBeGreaterThan(0);

    // Source is preserved (editor/diagnostic flows on the satellite still
    // work); deferred to a follow-up that adds lazy-fetch infrastructure.
    const verbsWithSource = seed.objects.flatMap((obj) => obj.verbs).filter(
      (verb) => typeof verb.source === "string" && verb.source.length > 0
    );
    expect(verbsWithSource.length).toBeGreaterThan(0);
  });

  it("HS5: merge stays idempotent when stored has populated line_map and seed has empty line_map", () => {
    // The lean-seed-fat-storage contract: a satellite's first cold load
    // may store verbs with empty line_map; the host-scoped repair path
    // recompiles bundled-catalog verbs to populate it; the next cold
    // load receives an empty line_map from the gateway and must NOT
    // count this as a real change (otherwise every cold load thrashes
    // verb storage).
    const gateway = createWorld();
    const seed = gateway.buildHostSeedForDelivery("the_pinboard");
    const stored = nonEmptyHostScopedWorld(gateway.exportWorld(), "the_pinboard");
    expect(stored).not.toBeNull();

    // Sanity: stored has at least one populated line_map; seed has none.
    const storedHasLineMap = stored!.objects.some((obj) =>
      obj.verbs.some((v) => Object.keys(v.line_map ?? {}).length > 0)
    );
    expect(storedHasLineMap).toBe(true);

    const merged = mergeHostScopedSeedWithStatus(stored!, seed, "the_pinboard");
    expect(merged.changed).toBe(false);
  });

  it("HS1: buildHostSeedForDeliveryWithDigest returns a stable digest across cache hits", () => {
    const gateway = createWorld();
    const first = gateway.buildHostSeedForDeliveryWithDigest("the_pinboard");
    const second = gateway.buildHostSeedForDeliveryWithDigest("the_pinboard");
    expect(first.digest).toBe(second.digest);
    expect(first.seed).toBe(second.seed);
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
  });

  it("HS1: shared catalog support edits invalidate every cached host seed", () => {
    const gateway = createWorld();
    const before = gateway.buildHostSeedForDeliveryWithDigest("the_deck");
    const beforeRoster = before.seed.objects
      .find((obj) => obj.id === "$conversational")
      ?.verbs.find((verb) => verb.name === "room_roster");
    expect(beforeRoster?.source).toContain("active_actors(this)");

    const current = gateway.ownVerbExact("$conversational", "room_roster");
    expect(current).toBeTruthy();
    const installed = installVerb(
      gateway,
      "$conversational",
      "room_roster",
      "verb :room_roster() rxd { return [\"fresh-host-seed\"]; }",
      current!.version
    );
    expect(installed.ok).toBe(true);

    const after = gateway.buildHostSeedForDeliveryWithDigest("the_deck");
    const afterRoster = after.seed.objects
      .find((obj) => obj.id === "$conversational")
      ?.verbs.find((verb) => verb.name === "room_roster");
    expect(after.seed).not.toBe(before.seed);
    expect(after.digest).not.toBe(before.digest);
    expect(afterRoster?.source).toContain("fresh-host-seed");
  });

  it("HS1: seed digest changes when world content changes", () => {
    const gateway = createWorld();
    const before = gateway.buildHostSeedForDeliveryWithDigest("the_chatroom").digest;
    gateway.object("the_chatroom").name = "Renamed Chatroom";
    gateway.setProp("the_chatroom", "next_seq", (Number(gateway.getProp("the_chatroom", "next_seq") ?? 0)) + 1);
    const after = gateway.buildHostSeedForDeliveryWithDigest("the_chatroom").digest;
    expect(after).not.toBe(before);
  });

  it("HS1: seed digest survives a round-trip through exportWorld + createWorldFromSerialized (insertion-order vs SQL-hydration parity)", () => {
    // Mid-runtime serialization can produce non-canonical map iteration order
    // (insertion order). The same world after a cold-reload from a serialized
    // snapshot produces an alphabetical/hydration-order layout. The digest is
    // computed over a canonicalized seed body precisely so these two
    // serializations agree — otherwise every gateway eviction-reload would
    // force every satellite to re-fetch its host seed in full on the next
    // probe.
    const live = createWorld();
    // Force the live world out of canonical insertion order: add a property
    // whose name sorts BEFORE an existing property on the_pinboard's class.
    live.defineProperty("$pinboard", { name: "aaa_canonical_test", defaultValue: 1, owner: "$wiz", perms: "rcwx" });
    const liveDigest = live.buildHostSeedForDeliveryWithDigest("the_pinboard").digest;

    const reloaded = createWorldFromSerialized(live.exportWorld());
    const reloadedDigest = reloaded.buildHostSeedForDeliveryWithDigest("the_pinboard").digest;
    expect(reloadedDigest).toBe(liveDigest);
  });

  it("HS5: buildHostSeedForDelivery cache invalidates when the world is replaced via importWorld", () => {
    const gateway = createWorld();
    const before = gateway.buildHostSeedForDelivery("the_chatroom");
    const original = before.objects.find((o) => o.id === "the_chatroom")?.name;
    expect(typeof original).toBe("string");

    // Replace the whole world with a serialized snapshot whose
    // the_chatroom has a mutated name. Without importWorld bumping
    // the mutationCounter (and clearing the cache), the next
    // buildHostSeedForDelivery call would return the stale `before`.
    const swapped = createWorld().exportWorld();
    const chatroomIdx = swapped.objects.findIndex((o) => o.id === "the_chatroom");
    swapped.objects[chatroomIdx] = { ...swapped.objects[chatroomIdx], name: "Replaced Chatroom" };
    gateway.importWorld(swapped);

    const after = gateway.buildHostSeedForDelivery("the_chatroom");
    expect(after).not.toBe(before);
    expect(after.objects.find((o) => o.id === "the_chatroom")?.name).toBe("Replaced Chatroom");
  });

  it("HS2.2 deletions: gateway-removed properties on a foreign-hosted subject are removed from stored", () => {
    // $thing is gateway-hosted relative to the_pinboard receiver.
    const stored = createWorld();
    stored.setProp("$thing", "extra_attr", "from-stored-only");
    const storedSlice = nonEmptyHostScopedWorld(stored.exportWorld(), "the_pinboard");
    expect(storedSlice).not.toBeNull();

    const gateway = createWorld();
    // gateway has NO extra_attr
    const seed = gateway.buildHostSeedForDelivery("the_pinboard");

    const merged = mergeHostScopedSeedWithStatus(storedSlice!, seed, "the_pinboard");
    const thingAfter = merged.world.objects.find((obj) => obj.id === "$thing");
    const extraAfter = thingAfter?.properties.find(([name]) => name === "extra_attr");
    expect(extraAfter).toBeUndefined();
    expect(merged.changed).toBe(true);
  });

  it("HS2.2 dynamic carve-out: receiver-side ledger writes on $system survive merges (asymmetric)", () => {
    // $system is gateway-hosted; applied_migrations is a dynamic name.
    // Receiver writes its own ledger; gateway's seed view should not
    // overwrite once stored has its own entry.
    const stored = createWorld();
    stored.setProp("$system", "applied_migrations", { receiver_only: true });
    const storedSlice = nonEmptyHostScopedWorld(stored.exportWorld(), "the_pinboard");
    expect(storedSlice).not.toBeNull();

    const gateway = createWorld();
    const seed = gateway.buildHostSeedForDelivery("the_pinboard");

    const merged = mergeHostScopedSeedWithStatus(storedSlice!, seed, "the_pinboard");
    const sysAfter = merged.world.objects.find((obj) => obj.id === "$system");
    const ledgerAfter = sysAfter?.properties.find(([name]) => name === "applied_migrations");
    expect(ledgerAfter?.[1]).toEqual({ receiver_only: true });
  });

  it("HS4: gateway tombstone with no receiver stub is ignored (cost rule — receiver doesn't track gateway recycles it never knew about)", () => {
    const gateway = createWorld();
    const satellite = createWorld();
    const storedSlice = nonEmptyHostScopedWorld(satellite.exportWorld(), "the_pinboard");
    expect(storedSlice).not.toBeNull();

    // Gateway recycles an id the satellite never imported — its slice
    // has no stub for the_doomed_id. The merge must NOT propagate;
    // otherwise every satellite would store every gateway-side recycle.
    gateway.tombstones.add("obj_world_doomed_irrelevant_1");
    const seed = gateway.buildHostSeedForDelivery("the_pinboard");
    expect(seed.tombstones).toContain("obj_world_doomed_irrelevant_1");

    const merged = mergeHostScopedSeedWithStatus(storedSlice!, seed, "the_pinboard");
    expect(merged.changed).toBe(false);
    expect(merged.world.tombstones ?? []).not.toContain("obj_world_doomed_irrelevant_1");
  });

  it("HS4: gateway tombstone with a receiver stub IS propagated and the stub removed", () => {
    const gateway = createWorld();
    const satellite = createWorld();
    // Satellite happens to have a stub for $wiz (gateway-hosted).
    // Gateway recycles $wiz (in this test we just stuff its id into
    // tombstones to simulate the post-recycle state without removing
    // it from gateway's objects, which the test doesn't need).
    gateway.tombstones.add("$wiz");

    const storedSlice = nonEmptyHostScopedWorld(satellite.exportWorld(), "the_pinboard");
    expect(storedSlice).not.toBeNull();
    expect(storedSlice!.objects.some((o) => o.id === "$wiz")).toBe(true); // stub is present

    const seed = gateway.buildHostSeedForDelivery("the_pinboard");
    const merged = mergeHostScopedSeedWithStatus(storedSlice!, seed, "the_pinboard");
    expect(merged.changed).toBe(true);
    expect(merged.world.tombstones).toContain("$wiz");
    expect(merged.world.objects.some((o) => o.id === "$wiz")).toBe(false); // stub removed

    // Idempotent: second pass with same seed produces no change.
    const second = mergeHostScopedSeedWithStatus(merged.world, seed, "the_pinboard");
    expect(second.changed).toBe(false);
  });

  it("isolates serialized input while importing worlds", () => {
    const serialized = createWorld({ catalogs: false }).exportWorld();
    const root = serialized.objects.find((obj) => obj.id === "$root");
    expect(root).toBeTruthy();
    if (!root) return;

    const setNestedMarker = (value: WooValue, marker: string): void => {
      ((value as Record<string, WooValue>).nested as Record<string, WooValue>).marker = marker;
    };
    const nestedMarker = (value: WooValue): WooValue => {
      return ((value as Record<string, WooValue>).nested as Record<string, WooValue>).marker;
    };

    root.flags = { wizard: false, programmer: false, fertile: false };
    const defaultDef = {
      name: "isolation_default",
      defaultValue: { nested: { marker: "before" } },
      owner: "$wiz",
      perms: "r",
      version: 1
    };
    const propertyEntry: [string, WooValue] = ["isolation_value", { nested: { marker: "before" } }];
    const verb = {
      ...nativeVerb("isolate_import"),
      aliases: ["iso"],
      arg_spec: { command: { nested: { marker: "before" } } },
      line_map: { nested: { marker: "before" } },
      calls: [{ name: "look", this_call: true }]
    };
    const byteVerb = bytecodeVerb("isolate_bytecode", {
      ops: [["PUSH", { nested: { marker: "before" } }]],
      literals: [{ nested: { marker: "before" } }],
      num_locals: 0,
      max_stack: 1,
      version: 1
    });
    const eventSchema: Record<string, WooValue> = { nested: { marker: "before" } };
    const logEntry: SerializedWorld["logs"][number][1][number] = {
      space: "$nowhere",
      seq: 1,
      ts: 1,
      actor: "$wiz",
      message: message("$wiz", "$root", "look", [{ nested: { marker: "before" } }]),
      observations: [{ type: "isolation_event", source: "$root", payload: { nested: { marker: "before" } } }],
      applied_ok: false,
      error: { code: "E_TEST", message: "before", value: { nested: { marker: "before" } } }
    };
    const snapshot: SerializedWorld["snapshots"][number] = {
      space_id: "$nowhere",
      seq: 1,
      ts: 1,
      state: { nested: { marker: "before" } },
      hash: "isolation"
    };
    const task: ParkedTaskRecord = {
      id: "isolation_task",
      parked_on: "$nowhere",
      state: "suspended",
      resume_at: null,
      awaiting_player: null,
      correlation_id: null,
      serialized: { nested: { marker: "before" } },
      created: 1,
      origin: "$nowhere"
    };
    root.propertyDefs.push(defaultDef);
    root.properties.push(propertyEntry);
    root.propertyVersions.push(["isolation_value", 7]);
    root.verbs.push(verb);
    root.verbs.push(byteVerb);
    root.eventSchemas.push(["isolation_event", eventSchema]);
    serialized.logs.push(["$nowhere", [logEntry]]);
    serialized.snapshots.push(snapshot);
    serialized.parkedTasks.push(task);

    const reloaded = createWorldFromSerialized(serialized, { persist: false });

    root.flags.wizard = true;
    setNestedMarker(defaultDef.defaultValue, "after-input");
    setNestedMarker(propertyEntry[1], "after-input");
    verb.aliases[0] = "after-input";
    setNestedMarker(verb.arg_spec.command, "after-input");
    setNestedMarker(verb.line_map, "after-input");
    verb.calls[0].name = "after-input";
    setNestedMarker(byteVerb.bytecode.ops[0][1], "after-input");
    setNestedMarker(byteVerb.bytecode.literals[0], "after-input");
    setNestedMarker(eventSchema, "after-input");
    setNestedMarker(logEntry.message.args[0], "after-input");
    setNestedMarker(logEntry.observations[0].payload, "after-input");
    setNestedMarker(logEntry.error!.value!, "after-input");
    setNestedMarker(snapshot.state, "after-input");
    setNestedMarker(task.serialized, "after-input");

    const exported = reloaded.exportWorld();
    const importedRoot = exported.objects.find((obj) => obj.id === "$root");
    const importedVerb = importedRoot?.verbs.find((item) => item.name === "isolate_import");
    const importedByteVerb = importedRoot?.verbs.find((item) => item.name === "isolate_bytecode");
    expect(importedRoot?.flags.wizard).toBe(false);
    expect(nestedMarker(importedRoot!.propertyDefs.find((def) => def.name === "isolation_default")!.defaultValue)).toBe("before");
    expect(nestedMarker(importedRoot!.properties.find(([name]) => name === "isolation_value")![1])).toBe("before");
    expect(importedVerb?.aliases).toEqual(["iso"]);
    expect(nestedMarker(importedVerb!.arg_spec.command)).toBe("before");
    expect(nestedMarker(importedVerb!.line_map)).toBe("before");
    expect(importedVerb?.calls).toEqual([{ name: "look", this_call: true }]);
    expect(importedByteVerb?.kind).toBe("bytecode");
    if (importedByteVerb?.kind !== "bytecode") return;
    expect(nestedMarker(importedByteVerb.bytecode.ops[0][1])).toBe("before");
    expect(nestedMarker(importedByteVerb.bytecode.literals[0])).toBe("before");
    expect(nestedMarker(importedRoot!.eventSchemas.find(([name]) => name === "isolation_event")![1])).toBe("before");
    expect(nestedMarker(exported.logs.find(([space]) => space === "$nowhere")![1][0].message.args[0])).toBe("before");
    expect(nestedMarker(exported.logs.find(([space]) => space === "$nowhere")![1][0].observations[0].payload)).toBe("before");
    expect(nestedMarker(exported.logs.find(([space]) => space === "$nowhere")![1][0].error!.value!)).toBe("before");
    expect(nestedMarker(exported.snapshots.find((item) => item.hash === "isolation")!.state)).toBe("before");
    expect(nestedMarker(exported.parkedTasks.find((item) => item.id === "isolation_task")!.serialized)).toBe("before");

    const liveRoot = reloaded.object("$root");
    const liveVerb = liveRoot.verbs.find((item) => item.name === "isolate_import");
    const liveByteVerb = liveRoot.verbs.find((item) => item.name === "isolate_bytecode");
    expect(liveVerb).toBeTruthy();
    expect(liveByteVerb?.kind).toBe("bytecode");
    if (!liveVerb || liveByteVerb?.kind !== "bytecode") return;
    liveRoot.flags.programmer = true;
    setNestedMarker(liveRoot.propertyDefs.get("isolation_default")!.defaultValue, "after-world");
    setNestedMarker(liveRoot.properties.get("isolation_value")!, "after-world");
    liveVerb.aliases[0] = "after-world";
    setNestedMarker(liveVerb.arg_spec.command, "after-world");
    setNestedMarker(liveVerb.line_map, "after-world");
    liveVerb.calls![0].name = "after-world";
    // Bytecode is immutable and shared by reference across worlds, so the live
    // world holds a deeply-frozen object: an in-place mutation throws instead of
    // silently editing a peer world that shares the same source. (Mutable verb
    // wrapper fields above remain per-world isolated.)
    expect(Object.isFrozen(liveByteVerb.bytecode)).toBe(true);
    expect(() => setNestedMarker(liveByteVerb.bytecode.ops[0][1], "after-world")).toThrow();
    expect(() => setNestedMarker(liveByteVerb.bytecode.literals[0], "after-world")).toThrow();
    setNestedMarker(liveRoot.eventSchemas.get("isolation_event")!, "after-world");
    const liveLog = reloaded.logs.get("$nowhere")![0];
    setNestedMarker(liveLog.message.args[0], "after-world");
    setNestedMarker(liveLog.observations[0].payload, "after-world");
    setNestedMarker(liveLog.error!.value!, "after-world");
    setNestedMarker(reloaded.snapshots.find((item) => item.hash === "isolation")!.state, "after-world");
    setNestedMarker(reloaded.parkedTasks.get("isolation_task")!.serialized, "after-world");

    expect(root.flags.programmer).toBe(false);
    expect(nestedMarker(defaultDef.defaultValue)).toBe("after-input");
    expect(nestedMarker(propertyEntry[1])).toBe("after-input");
    expect(verb.aliases).toEqual(["after-input"]);
    expect(nestedMarker(verb.arg_spec.command)).toBe("after-input");
    expect(nestedMarker(verb.line_map)).toBe("after-input");
    expect(verb.calls).toEqual([{ name: "after-input", this_call: true }]);
    expect(nestedMarker(byteVerb.bytecode.ops[0][1])).toBe("after-input");
    expect(nestedMarker(byteVerb.bytecode.literals[0])).toBe("after-input");
    expect(nestedMarker(eventSchema)).toBe("after-input");
    expect(nestedMarker(logEntry.message.args[0])).toBe("after-input");
    expect(nestedMarker(logEntry.observations[0].payload)).toBe("after-input");
    expect(nestedMarker(logEntry.error!.value!)).toBe("after-input");
    expect(nestedMarker(snapshot.state)).toBe("after-input");
    expect(nestedMarker(task.serialized)).toBe("after-input");
  });

  it("deep-freezes bytecode so a shared copy cannot be mutated in place", () => {
    const bytecode = freezeTinyBytecode({
      ops: [["PUSH_LIT", 0]],
      literals: [{ nested: { marker: "x" } }],
      num_locals: 0,
      max_stack: 1,
      version: 1
    });
    expect(Object.isFrozen(bytecode)).toBe(true);
    expect(Object.isFrozen(bytecode.ops)).toBe(true);
    expect(Object.isFrozen(bytecode.ops[0])).toBe(true);
    expect(Object.isFrozen(bytecode.literals)).toBe(true);
    expect(Object.isFrozen(bytecode.literals[0])).toBe(true);
    expect(Object.isFrozen(((bytecode.literals[0] as Record<string, WooValue>).nested))).toBe(true);
    expect(() => { ((bytecode.literals[0] as Record<string, Record<string, string>>).nested).marker = "y"; }).toThrow();
  });

  it("shares frozen bytecode by reference across imported worlds without cloning or cross-world corruption", () => {
    // A bytecode verb whose body we can identify after export.
    const live = createWorld({ catalogs: false });
    live.createObject({ id: "freeze_probe", name: "Probe", parent: "$thing", owner: "$wiz" });
    expect(installVerb(live, "freeze_probe", "ping", `verb :ping() rxd {
  return "pong";
}`, null).ok).toBe(true);
    const serialized = live.exportWorld();

    // Freeze the verb's bytecode in the serialized source, mimicking the
    // module-global KV reservoir: bytecode is frozen once, then every world
    // restored in the isolate shares that one object by reference.
    const probe = serialized.objects.find((obj) => obj.id === "freeze_probe");
    const probeVerb = probe?.verbs.find((verb) => verb.name === "ping");
    expect(probeVerb?.kind).toBe("bytecode");
    if (probeVerb?.kind !== "bytecode") return;
    const frozenBytecode: TinyBytecode = freezeTinyBytecode(probeVerb.bytecode);

    const worldA = createWorldFromSerialized(serialized, { persist: false });
    const worldB = createWorldFromSerialized(serialized, { persist: false });
    const pingOf = (world: WooWorld) => {
      const verb = world.object("freeze_probe").verbs.find((candidate) => candidate.name === "ping");
      return verb?.kind === "bytecode" ? verb : null;
    };
    const a = pingOf(worldA);
    const b = pingOf(worldB);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    if (!a || !b) return;

    // Shared by reference — no per-import deep clone of ops/literals.
    expect(a.bytecode).toBe(frozenBytecode);
    expect(b.bytecode).toBe(frozenBytecode);
    expect(Object.isFrozen(a.bytecode)).toBe(true);

    // An attempted in-place mutation throws, so one world can never corrupt the
    // bytecode another world shares.
    const opCountBefore = b.bytecode.ops.length;
    expect(() => { (a.bytecode.ops as unknown[]).push(["NOOP"]); }).toThrow();
    expect(pingOf(worldB)!.bytecode.ops.length).toBe(opCountBefore);
  });

  it("does not share a merely shallow-frozen bytecode across imported worlds", () => {
    // A shallow Object.freeze leaves ops/literals mutable. Trusting bare
    // Object.isFrozen would share such an object by reference and let one world
    // corrupt another's ops; importBytecode must instead clone+deep-freeze it.
    const live = createWorld({ catalogs: false });
    live.createObject({ id: "shallow_probe", name: "Probe", parent: "$thing", owner: "$wiz" });
    expect(installVerb(live, "shallow_probe", "ping", `verb :ping() rxd {
  return "pong";
}`, null).ok).toBe(true);
    const serialized = live.exportWorld();
    const probeVerb = serialized.objects.find((obj) => obj.id === "shallow_probe")?.verbs.find((verb) => verb.name === "ping");
    expect(probeVerb?.kind).toBe("bytecode");
    if (probeVerb?.kind !== "bytecode") return;

    // exportWorld now returns deep-frozen (branded) bytecode, which is safe to
    // share. To exercise the "merely shallow-frozen, NOT branded" path, swap in a
    // fresh plain copy whose top object is Object.frozen but whose ops/literals
    // stay mutable — exactly the shape importBytecode must clone rather than share.
    const shallowFrozen = JSON.parse(JSON.stringify(probeVerb.bytecode));
    Object.freeze(shallowFrozen);
    (probeVerb as { bytecode: unknown }).bytecode = shallowFrozen;
    expect(Object.isFrozen(probeVerb.bytecode)).toBe(true);
    expect(Object.isFrozen((probeVerb.bytecode as { ops: unknown }).ops)).toBe(false);

    const worldA = createWorldFromSerialized(serialized, { persist: false });
    const worldB = createWorldFromSerialized(serialized, { persist: false });
    const pingOf = (world: WooWorld) => {
      const verb = world.object("shallow_probe").verbs.find((candidate) => candidate.name === "ping");
      return verb?.kind === "bytecode" ? verb : null;
    };
    const a = pingOf(worldA);
    const b = pingOf(worldB);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    if (!a || !b) return;

    // Each world got its own deep-frozen clone — the shallow-frozen source is
    // never shared, and the two worlds do not alias each other.
    expect(a.bytecode).not.toBe(probeVerb.bytecode);
    expect(a.bytecode).not.toBe(b.bytecode);
    expect(Object.isFrozen(a.bytecode.ops)).toBe(true);
    const opCountBefore = b.bytecode.ops.length;
    expect(() => { (a.bytecode.ops as unknown[]).push(["NOOP"]); }).toThrow();
    expect(pingOf(worldB)!.bytecode.ops.length).toBe(opCountBefore);
  });

  it("exportWorld shares immutable bytecode by reference but still clones mutable verb fields", () => {
    const world = createWorld({ catalogs: false });
    world.createObject({ id: "export_probe", name: "Probe", parent: "$thing", owner: "$wiz" });
    expect(installVerb(world, "export_probe", "ping", `verb :ping(arg) rxd {
  return arg;
}`, null).ok).toBe(true);
    const liveVerb = world.object("export_probe").verbs.find((verb) => verb.name === "ping");
    expect(liveVerb?.kind).toBe("bytecode");
    if (liveVerb?.kind !== "bytecode") return;

    const exported = world.exportWorld();
    const exportedVerb = exported.objects.find((obj) => obj.id === "export_probe")?.verbs.find((verb) => verb.name === "ping");
    expect(exportedVerb?.kind).toBe("bytecode");
    if (exportedVerb?.kind !== "bytecode") return;

    // Bytecode is immutable: shared by reference (no deep clone) and frozen.
    expect(exportedVerb.bytecode).toBe(liveVerb.bytecode);
    expect(Object.isFrozen(exportedVerb.bytecode)).toBe(true);
    // A second export reuses the same frozen object — no re-clone, no re-freeze churn.
    const exported2 = world.exportWorld();
    const exportedVerb2 = exported2.objects.find((obj) => obj.id === "export_probe")?.verbs.find((verb) => verb.name === "ping");
    expect(exportedVerb2?.kind === "bytecode" && exportedVerb2.bytecode).toBe(liveVerb.bytecode);

    // Mutable wrapper fields are still cloned (export must be safe to mutate).
    expect(exportedVerb.arg_spec).not.toBe(liveVerb.arg_spec);
    expect(exportedVerb.aliases).not.toBe(liveVerb.aliases);
    expect(exportedVerb).toEqual(expect.objectContaining({ name: "ping", source: liveVerb.source }));

    // The exported world still imports and executes correctly.
    const reloaded = createWorldFromSerialized(exported, { persist: false });
    const reVerb = reloaded.object("export_probe").verbs.find((verb) => verb.name === "ping");
    expect(reVerb?.kind).toBe("bytecode");
  });

  it("does not share cached boot snapshot cells across createWorld calls", () => {
    const first = createWorld({ catalogs: false });
    const firstRoot = first.object("$root");
    const firstDescribe = firstRoot.verbs.find((verb) => verb.name === "describe");
    expect(firstDescribe).toBeTruthy();
    if (!firstDescribe) return;

    firstRoot.flags.wizard = true;
    firstDescribe.aliases.push("cache_poison");

    const secondRoot = createWorld({ catalogs: false }).object("$root");
    const secondDescribe = secondRoot.verbs.find((verb) => verb.name === "describe");
    expect(secondRoot.flags.wizard).not.toBe(true);
    expect(secondDescribe?.aliases).not.toContain("cache_poison");
  });

  it("normalizes legacy d permission shorthand while importing worlds", async () => {
    const serialized = createWorld({ catalogs: false }).exportWorld();
    const root = serialized.objects.find((obj) => obj.id === "$root");
    const describe = root?.verbs.find((verb) => verb.name === "describe");
    expect(describe).toBeTruthy();
    if (!describe) return;
    describe.perms = "rxd";
    describe.direct_callable = false;

    const reloaded = createWorldFromSerialized(serialized, { persist: false });
    const info = reloaded.verbInfo("$root", "describe");
    expect(info.perms).toBe("rx");
    expect(info.direct_callable).toBe(true);
  });

  it("stores local verbs as ordered slots and resolves the first matching name", async () => {
    const world = createWorld({ catalogs: false });
    world.createObject({ id: "ordered_probe", name: "Ordered Probe", parent: "$root", owner: "$wiz" });
    world.addVerb("ordered_probe", nativeVerb("same"));
    world.addVerb(
      "ordered_probe",
      {
        ...nativeVerb("same"),
        aliases: ["tw*o"],
        source_hash: "test-same-second",
        version: 2
      },
      { append: true }
    );

    expect(world.object("ordered_probe").verbs.map((verb) => [verb.name, verb.slot, verb.source_hash])).toEqual([
      ["same", 1, "test-same"],
      ["same", 2, "test-same-second"]
    ]);
    expect(world.resolveVerb("ordered_probe", "same").verb.source_hash).toBe("test-same");
    expect(world.resolveVerb("ordered_probe", "two").verb.source_hash).toBe("test-same-second");
    expect(world.programmerResolveVerb("$wiz", "ordered_probe", 2, "$wiz")).toMatchObject({ slot: 2, source: "verb :same() rx { ... }" });

    const reloaded = createWorldFromSerialized(world.exportWorld(), { persist: false });
    expect(reloaded.object("ordered_probe").verbs.map((verb) => [verb.name, verb.slot, verb.source_hash])).toEqual([
      ["same", 1, "test-same"],
      ["same", 2, "test-same-second"]
    ]);
  });

  it("sequences calls and emits observations", async () => {
    const { world, session, actor } = authedWorld();
    const first = await callInDubspace(world, session.id, "1", message(actor, "the_dubspace", "set_control", ["delay_1", "feedback", 0.77]));
    const second = await callInDubspace(world, session.id, "2", message(actor, "the_dubspace", "set_control", ["filter_1", "cutoff", 1440]));
    expect(first.op).toBe("applied");
    expect(second.op).toBe("applied");
    if (first.op === "applied" && second.op === "applied") {
      expect(first.seq).toBe(1);
      expect(second.seq).toBe(2);
      expect(first.observations[0].type).toBe("control_changed");
    }
    expect(world.getProp("delay_1", "feedback")).toBe(0.77);
    expect(world.getProp("filter_1", "cutoff")).toBe(1440);
    expect(world.replay("the_dubspace", 2, 1).map((entry) => entry.seq)).toEqual([2]);
  });

  it("emits metrics for direct and sequenced call routes", async () => {
    const { world, session, actor } = authedWorld();
    const metrics: MetricEvent[] = [];
    world.setMetricsHook((event) => metrics.push(event));

    const direct = await world.directCall("direct-metric", actor, "the_chatroom", "enter", []);
    const sequenced = await callInDubspace(world, session.id, "sequenced-metric", message(actor, "the_dubspace", "set_control", ["delay_1", "feedback", 0.64]));

    expect(direct.op).toBe("result");
    expect(sequenced.op).toBe("applied");
    expect(metrics.find((event) => event.kind === "direct_call")).toMatchObject({
      kind: "direct_call",
      target: "the_chatroom",
      verb: "enter",
      audience: "the_chatroom",
      status: "ok"
    });
    expect(metrics.find((event) => event.kind === "applied")).toMatchObject({
      kind: "applied",
      space: "the_dubspace",
      verb: "set_control"
    });
  });

  it("runDueTasks short-circuits with no metrics when no task is due", async () => {
    const world = createWorld();
    const metrics: MetricEvent[] = [];
    world.setMetricsHook((event) => metrics.push(event));

    const ran = await world.runDueTasks();
    expect(ran).toEqual([]);
    const noise = metrics.filter((event) => event.kind.startsWith("host_task_") && (event as { label?: string }).label === "runDueTasks");
    expect(noise).toEqual([]);
  });

  it("resumes a live session token", async () => {
    const world = createWorld();
    const first = world.auth("guest:resume");
    const resumed = world.auth(`session:${first.id}`);
    expect(resumed.id).toBe(first.id);
    expect(resumed.actor).toBe(first.actor);
  });

  it("claims the wizard bootstrap token exactly once", async () => {
    const world = createWorld({ catalogs: false });
    const session = world.claimWizardBootstrapSession("secret", "secret");
    expect(session.actor).toBe("$wiz");
    expect(world.getProp("$system", "bootstrap_token_used")).toBe(true);
    expect(() => world.claimWizardBootstrapSession("secret", "secret")).toThrow(/E_TOKEN_CONSUMED|already been consumed/);
  });

  it("allocates guest instances, not the guest class", async () => {
    const world = createWorld();
    const session = world.auth("guest:instance");
    expect(session.actor).toMatch(/^guest_/);
    expect(session.actor).not.toBe("$guest");
    expect(world.object(session.actor).parent).toBe("$guest");
  });

  it("places fresh guests in the configured initial room without adding presence", async () => {
    const world = createWorld();
    const session = world.auth("guest:initial-room");
    expect(world.object(session.actor).location).toBe("the_chatroom");
    expect(session.activeScope).toBe("the_chatroom");
    expect(world.object("the_chatroom").contents.has(session.actor)).toBe(true);
    expect(world.hasPresence(session.actor, "the_chatroom")).toBe(false);
  });

  it("does not join the chatroom until explicit enter", async () => {
    const world = createWorld();
    const session = world.auth("guest:no-chat-autojoin");
    expect(world.hasPresence(session.actor, "the_dubspace")).toBe(false);
    expect(world.hasPresence(session.actor, "the_dubspace")).toBe(false);
    expect(world.hasPresence(session.actor, "the_chatroom")).toBe(false);

    const enter = await world.directCall("enter-chat", session.actor, "the_chatroom", "enter", []);
    expect(enter.op).toBe("result");
    expect(world.hasPresence(session.actor, "the_chatroom")).toBe(true);
  });

  it("tracks active scope per session for the same actor", async () => {
    const world = createWorld();
    const primary = world.auth("guest:multi-location");
    const actor = primary.actor;
    const secondary = world.ensureSessionForActor("zz-secondary-location-session", actor, "guest");

    expect((await world.directCall("primary-enter-chat", actor, "the_chatroom", "enter", [], { sessionId: primary.id })).op).toBe("result");
    expect((await moveActorTo(world, actor, "the_dubspace", { requestId: "secondary-move-dubspace", sessionId: secondary.id })).op).toBe("result");

    expect(world.activeScopeForSession(primary.id)).toBe("the_chatroom");
    expect(world.activeScopeForSession(secondary.id)).toBe("the_dubspace");
    expect(world.object(actor).location).toBe("the_chatroom");
    expect(world.hasSessionPresence(primary.id, "the_chatroom")).toBe(true);
    expect(world.hasSessionPresence(primary.id, "the_dubspace")).toBe(false);
    expect(world.hasSessionPresence(secondary.id, "the_chatroom")).toBe(false);
    expect(world.hasSessionPresence(secondary.id, "the_dubspace")).toBe(true);
    expect(new Set(world.allLocationsForActor(actor))).toEqual(new Set(["the_chatroom", "the_dubspace"]));
  });

  it("hydrates legacy currentLocation snapshots into activeScope", () => {
    const world = createWorld();
    const session = world.auth("guest:legacy-current-location");
    const serialized = world.exportWorld();
    const stored = serialized.sessions.find((item) => item.id === session.id);
    if (!stored) throw new Error("expected exported session");
    delete stored.activeScope;
    stored.currentLocation = "the_dubspace";

    const reloaded = createWorldFromSerialized(serialized, { persist: false });

    expect(reloaded.activeScopeForSession(session.id)).toBe("the_dubspace");
    expect(reloaded.currentLocationForSession(session.id)).toBe("the_dubspace");
  });

  it("routes live observations to sessions in the source space, not every actor session", async () => {
    const world = createWorld();
    const primary = world.auth("guest:session-audience");
    const actor = primary.actor;
    const secondary = world.ensureSessionForActor("secondary-audience-session", actor, "guest");

    await world.directCall("audience-primary-chat", actor, "the_chatroom", "enter", [], { sessionId: primary.id });
    await moveActorTo(world, actor, "the_dubspace", { requestId: "audience-secondary-dubspace", sessionId: secondary.id });
    const said = await world.directCall("audience-say", actor, "the_chatroom", "say", ["hello"], { sessionId: primary.id });

    expect(said.op).toBe("result");
    if (said.op === "result") {
      expect(said.audienceSessions).toEqual([primary.id]);
      expect(said.observationSessionAudiences).toEqual([[primary.id]]);
    }
  });

  it("forwards transparent embedded-space speech upward without sending local frames to unrelated sessions", async () => {
    const world = createWorld();
    const outside = world.auth("guest:transparent-outside");
    const inside = world.auth("guest:transparent-inside");

    await world.directCall("transparent-outside-enter", outside.actor, "the_chatroom", "enter", [], { sessionId: outside.id });
    await moveActorTo(world, inside.actor, "the_dubspace", { requestId: "transparent-inside-move", sessionId: inside.id });
    const said = await world.directCall("transparent-say", inside.actor, "the_dubspace", "say", ["beat"], { sessionId: inside.id });

    expect(said.op).toBe("result");
    if (said.op === "result") {
      expect(said.observations.map((observation) => observation.source)).toEqual(["the_dubspace", "the_chatroom"]);
      expect(said.observationSessionAudiences).toEqual([[inside.id], [outside.id]]);
    }
  });

  it("routes tool-room announcements once to actors in that room", async () => {
    const world = createWorld();
    const speaker = world.auth("guest:transparent-announcer");
    const inside = world.auth("guest:transparent-announcement-inside");
    const outside = world.auth("guest:transparent-announcement-outside");

    await world.directCall("transparent-ann-outside-enter", outside.actor, "the_chatroom", "enter", [], { sessionId: outside.id });
    await moveActorTo(world, speaker.actor, "the_dubspace", { requestId: "transparent-ann-speaker-move", sessionId: speaker.id });
    await moveActorTo(world, inside.actor, "the_dubspace", { requestId: "transparent-ann-inside-move", sessionId: inside.id });

    const announced = await world.directCall("transparent-announcement", speaker.actor, "the_dubspace", "announce_all", ["pulse"], { sessionId: speaker.id });

    expect(announced.op).toBe("result");
    if (announced.op === "result") {
      const textObservations = announced.observations.filter((observation) => observation.type === "text");
      expect(textObservations.map((observation) => observation.target).sort()).toEqual([speaker.actor, inside.actor].sort());
      expect(textObservations.filter((observation) => observation.target === speaker.actor)).toHaveLength(1);
      expect(textObservations.filter((observation) => observation.target === inside.actor)).toHaveLength(1);
      expect(textObservations.filter((observation) => observation.target === outside.actor)).toHaveLength(0);
      const sessionsByTarget = Object.fromEntries(textObservations.map((observation, index) => [
        String(observation.target),
        announced.observationSessionAudiences?.[index] ?? []
      ]));
      expect(sessionsByTarget[speaker.actor]).toEqual([speaker.id]);
      expect(sessionsByTarget[inside.actor]).toEqual([inside.id]);
      expect(sessionsByTarget[outside.actor]).toBeUndefined();
    }
  });

  it("lets semitransparent spaces hear parent announcements without forwarding local speech out", async () => {
    const world = createWorld();
    const outside = world.auth("guest:rain-outside");
    const inside = world.auth("guest:rain-inside");
    world.createObject({ id: "rain_curtain", name: "Rain Curtain", parent: "$space", owner: "$wiz", location: "the_chatroom" });
    world.setProp("rain_curtain", "features", ["$semitransparent"]);
    world.setProp("rain_curtain", "features_version", 1);

    await world.directCall("rain-outside-enter", outside.actor, "the_chatroom", "enter", [], { sessionId: outside.id });
    await world.directCall("rain-inside-enter", inside.actor, "rain_curtain", "enter", [], { sessionId: inside.id });
    const local = await world.directCall("rain-local-say", inside.actor, "rain_curtain", "say", ["hush"], { sessionId: inside.id });
    expect(local.op).toBe("result");
    if (local.op === "result") {
      expect(local.observations.map((observation) => observation.source)).toEqual(["rain_curtain"]);
      expect(local.observationSessionAudiences).toEqual([[inside.id]]);
    }

    const outsideAnnouncement = await world.directCall("rain-parent-announce", outside.actor, "the_chatroom", "announce_all", ["storm"], { sessionId: outside.id });
    expect(outsideAnnouncement.op).toBe("result");
    if (outsideAnnouncement.op === "result") {
      expect(outsideAnnouncement.observations.filter((observation) => observation.type === "text").map((observation) => observation.target).sort()).toEqual([inside.actor, outside.actor].sort());
    }
  });

  it("keeps same-actor co-occupant sessions subscribed when one leaves", async () => {
    const world = createWorld();
    const primary = world.auth("guest:co-occupant");
    const actor = primary.actor;
    const secondary = world.ensureSessionForActor("secondary-co-occupant-session", actor, "guest");

    await world.directCall("co-primary-enter", actor, "the_chatroom", "enter", [], { sessionId: primary.id });
    await world.directCall("co-secondary-enter", actor, "the_chatroom", "enter", [], { sessionId: secondary.id });
    expect(world.presenceSessionIdsIn("the_chatroom", [actor]).sort()).toEqual([primary.id, secondary.id].sort());
    expect(world.getProp("the_chatroom", "subscribers")).toEqual([actor]);

    await world.directCall("co-secondary-leave", actor, "the_chatroom", "leave", [], { sessionId: secondary.id });
    expect(world.hasSessionPresence(primary.id, "the_chatroom")).toBe(true);
    expect(world.hasSessionPresence(secondary.id, "the_chatroom")).toBe(false);
    expect(world.getProp("the_chatroom", "subscribers")).toEqual([actor]);
    expect(world.allLocationsForActor(actor)).toContain("the_chatroom");
  });

  it("breaks primary-session ties by session id", () => {
    const world = createWorld();
    const primary = world.auth("guest:primary-tie");
    const actor = primary.actor;
    const earlierId = world.ensureSessionForActor("session-0000-primary-tie", actor, "guest");
    primary.started = 1234;
    earlierId.started = 1234;

    expect(world.primarySessionForActor(actor)?.id).toBe("session-0000-primary-tie");
  });

  it("uses remote space session audience instead of every actor session", async () => {
    const home = createWorld();
    const remote = createWorld();
    const primary = home.auth("guest:remote-session-audience");
    const actor = primary.actor;
    const secondary = home.ensureSessionForActor("secondary-remote-session-audience", actor, "guest");
    const worlds = new Map<string, WooWorld>([
      ["home", home],
      ["remote", remote]
    ]);
    const routes = new Map<ObjRef, string>([
      [actor, "home"],
      ["remote_room", "remote"]
    ]);
    home.setExecutorContext(new LocalExecutorContext("home", worlds, routes));
    remote.setExecutorContext(new LocalExecutorContext("remote", worlds, routes));
    home.createObject({ id: "remote_room", name: "Remote Room", parent: "$space", owner: "$wiz" });
    remote.createObject({ id: "remote_room", name: "Remote Room", parent: "$space", owner: "$wiz" });
    home.createObject({ id: "emitter", name: "Emitter", parent: "$thing", owner: "$wiz", location: "remote_room" });
    home.registerNativeHandler("emit_remote_room", (ctx) => {
      ctx.observe({ type: "remote_ping", source: "remote_room", _audience_override: [actor] } as WooValue as Record<string, WooValue> & { type: string });
      return true;
    });
    home.addVerb("emitter", { ...nativeVerb("emit_remote", "emit_remote_room"), direct_callable: true, skip_presence_check: true });
    remote.setSpaceSubscriber("remote_room", actor, true, primary.id);
    home.sessions.get(primary.id)!.activeScope = "remote_room";
    home.sessions.get(secondary.id)!.activeScope = "the_chatroom";

    const result = await home.directCall("remote-session-audience", actor, "emitter", "emit_remote", [], { sessionId: secondary.id });

    expect(result.op).toBe("result");
    if (result.op === "result") {
      expect(result.audienceSessions).toEqual([primary.id]);
      expect(result.observationSessionAudiences).toEqual([[primary.id]]);
    }
  });

  it("keeps detached guest sessions resumable during grace", async () => {
    const world = createWorld();
    const session = world.auth("guest:grace");
    const entered = await world.directCall("grace-enter-chat", session.actor, "the_chatroom", "enter", [], { sessionId: session.id });
    expect(entered.op).toBe("result");
    world.attachSocket(session.id, "ws-1");
    world.detachSocket(session.id, "ws-1");
    expect(world.sessions.get(session.id)?.lastDetachAt).toEqual(expect.any(Number));

    const resumed = world.auth(`session:${session.id}`);
    world.attachSocket(resumed.id, "ws-2");
    expect(resumed.actor).toBe(session.actor);
    expect(resumed.activeScope).toBe("the_chatroom");
    expect(world.sessions.get(session.id)?.lastDetachAt).toBeNull();
  });

  it("promotes the next-oldest player session location when primary reaps", async () => {
    const world = createWorld();
    const actor = "player_primary_promotion";
    world.createObject({ id: actor, name: "Primary Promotion Player", parent: "$player", owner: actor, location: "$nowhere" });
    world.setProp(actor, "name", "Primary Promotion Player");
    world.setProp(actor, "home", "$nowhere");

    const oldest = world.createSessionForActor(actor, "bearer");
    const middle = world.ensureSessionForActor("session-primary-promotion-middle", actor, "bearer");
    const newest = world.ensureSessionForActor("session-primary-promotion-newest", actor, "bearer");
    oldest.started = 100;
    middle.started = 200;
    newest.started = 300;

    expect((await world.directCall("primary-promotion-oldest-enter", actor, "the_chatroom", "enter", [], { sessionId: oldest.id })).op).toBe("result");
    expect((await moveActorTo(world, actor, "the_dubspace", { requestId: "primary-promotion-middle-move", sessionId: middle.id })).op).toBe("result");
    expect((await moveActorTo(world, actor, "the_dubspace", { requestId: "primary-promotion-newest-move", sessionId: newest.id })).op).toBe("result");
    expect(world.primarySessionForActor(actor)?.id).toBe(oldest.id);
    expect(world.object(actor).location).toBe("the_chatroom");

    oldest.expiresAt = Date.now() - 1;
    expect(world.reapExpiredSessions()).toEqual([oldest.id]);
    expect(world.primarySessionForActor(actor)?.id).toBe(middle.id);
    expect(world.object(actor).location).toBe("the_dubspace");
    expect(world.activeScopeForSession(middle.id)).toBe("the_dubspace");
    expect(world.activeScopeForSession(newest.id)).toBe("the_dubspace");
  });

  it("does not expire a session while a socket is attached", async () => {
    const world = createWorld();
    const session = world.auth("guest:attached");
    world.attachSocket(session.id, "ws-1");
    session.expiresAt = Date.now() - 1;

    expect(world.sessionAlive(session.id)).toBe(true);
    expect(world.reapExpiredSessions()).toEqual([]);
    expect(world.sessions.has(session.id)).toBe(true);
  });

  it("emits one session_reap metric only for sweeps that reap sessions", () => {
    const metrics: MetricEvent[] = [];
    const world = createWorld({ metricsHook: (event) => metrics.push(event) });
    const first = world.auth("guest:reap-metric-a");
    const second = world.auth("guest:reap-metric-b");

    expect(world.reapExpiredSessions(Date.now())).toEqual([]);
    expect(metrics.filter((event) => event.kind === "session_reap")).toEqual([]);

    first.expiresAt = 1;
    second.expiresAt = 1;
    expect(world.reapExpiredSessions(2).sort()).toEqual([first.id, second.id].sort());
    const reaps = metrics.filter((event) => event.kind === "session_reap");
    expect(reaps).toHaveLength(1);
    expect(reaps[0]).toMatchObject({
      kind: "session_reap",
      inspected: 2,
      reaped: 2,
      guest_reaped: 2,
      credential_reaped: 0
    });
  });

  it("keeps a long-attached session resumable for the detach grace window", async () => {
    const world = createWorld();
    const session = world.auth("guest:long-attached");
    world.attachSocket(session.id, "ws-1");
    session.expiresAt = Date.now() - 1;

    world.detachSocket(session.id, "ws-1");

    const detached = world.sessions.get(session.id);
    expect(detached?.lastDetachAt).toEqual(expect.any(Number));
    expect(detached?.expiresAt).toBeGreaterThan(detached?.lastDetachAt ?? 0);
    expect(world.auth(`session:${session.id}`).actor).toBe(session.actor);
  });

  it("reaps detached guest sessions and returns guests to the pool", async () => {
    const world = createWorld();
    const session = world.auth("guest:reap");
    const actor = session.actor;
    await world.directCall("enter-chat-before-reap", actor, "the_chatroom", "enter", [], { sessionId: session.id });
    const enterDubspace = await moveActorTo(world, actor, "the_dubspace", { requestId: "move-dubspace-before-reap", sessionId: session.id });
    expect(enterDubspace.op).toBe("result");
    expect(world.propOrNull("the_dubspace", "operators")).toBeNull();
    await world.directCall("return-chat-before-reap", actor, "the_chatroom", "enter", [], { sessionId: session.id });
    const takeLamp = await world.directCall("take-lamp-before-reap", actor, "the_chatroom", "take", ["lamp"]);
    expect(takeLamp.op).toBe("result");
    expect(world.object("the_lamp").location).toBe(actor);
    world.object(actor).contents.add("missing_inventory_ref");
    world.setProp(actor, "description", "temporary guest description");
    world.setProp(actor, "aliases", ["temp"]);
    world.setProp(actor, "focus_list", ["the_dubspace"]);
    world.attachSocket(session.id, "ws-1");
    world.detachSocket(session.id, "ws-1");

    const detachedAt = world.sessions.get(session.id)?.lastDetachAt ?? Date.now();
    expect(world.reapExpiredSessions(detachedAt + 60_001)).toEqual([session.id]);
    expect(world.sessions.has(session.id)).toBe(false);
    expect(world.hasPresence(actor, "the_dubspace")).toBe(false);
    expect(world.hasPresence(actor, "the_dubspace")).toBe(false);
    expect(world.hasPresence(actor, "the_chatroom")).toBe(false);
    expect(world.propOrNull("the_dubspace", "operators")).toBeNull();
    expect(world.getProp(actor, "description")).toBe("");
    expect(world.getProp(actor, "aliases")).toEqual([]);
    expect(world.getProp(actor, "focus_list")).toEqual([]);
    expect(world.object(actor).location).toBe("$nowhere");
    expect(world.object(actor).contents.has("missing_inventory_ref")).toBe(false);
    expect(world.object("the_lamp").location).toBe("the_chatroom");
    expect(world.object("the_chatroom").contents.has("the_lamp")).toBe(true);

    const next = world.auth("guest:after-reap");
    expect(next.actor).toBe(actor);
    expect(world.propOrNull("the_dubspace", "operators")).toBeNull();
  });

  it("rejects calls from expired sessions", async () => {
    const world = createWorld();
    const session = world.auth("guest:expired-call");
    const actor = session.actor;
    world.attachSocket(session.id, "ws-1");
    world.detachSocket(session.id, "ws-1");
    const detachedAt = world.sessions.get(session.id)?.lastDetachAt ?? Date.now();
    world.reapExpiredSessions(detachedAt + 60_001);

    const result = await callInDubspace(world, session.id, "expired-call", message(actor, "the_dubspace", "set_control", ["delay_1", "wet", 0.5]));
    expect(result.op).toBe("error");
    if (result.op === "error") expect(result.error.code).toBe("E_NOSESSION");
  });

  it("rejects calls whose actor does not match the session", async () => {
    const world = createWorld();
    const first = world.auth("guest:actor-one");
    const second = world.auth("guest:actor-two");
    const result = await callInDubspace(world, first.id, "actor-mismatch", message(second.actor, "the_dubspace", "set_control", ["delay_1", "wet", 0.5]));
    expect(result.op).toBe("error");
    if (result.op === "error") expect(result.error.code).toBe("E_PERM");
  });

  it("returns the same applied frame for idempotent retry", async () => {
    const { world, session, actor } = authedWorld();
    const msg = message(actor, "the_dubspace", "set_control", ["delay_1", "wet", 0.91]);
    const first = await callInDubspace(world, session.id, "same-id", msg);
    const second = await callInDubspace(world, session.id, "same-id", msg);
    expect(first).toEqual(second);
    expect(world.replay("the_dubspace", 1, 10)).toHaveLength(1);
  });

  it("keeps failed behavior in sequence while rolling back mutation", async () => {
    const { world, session, actor } = authedWorld();
    const result = await callInDubspace(world, session.id, "bad", message(actor, "the_dubspace", "missing_verb", []));
    expect(result.op).toBe("applied");
    if (result.op === "applied") {
      expect(result.seq).toBe(1);
      expect(result.observations[0].type).toBe("$error");
      expect(result.observations[0].code).toBe("E_VERBNF");
    }
    expect(world.replay("the_dubspace", 1, 10)[0].applied_ok).toBe(false);
  });

  it("updates dubspace percussion pattern and transport through sequenced calls", async () => {
    const { world, session, actor } = authedWorld();
    const step = await callInDubspace(world, session.id, "drum-step", message(actor, "the_dubspace", "set_drum_step", ["tone", 3, true]));
    const tempo = await callInDubspace(world, session.id, "tempo", message(actor, "the_dubspace", "set_tempo", [132]));
    const start = await callInDubspace(world, session.id, "start", message(actor, "the_dubspace", "start_transport", []));
    const pattern = world.getProp("drum_1", "pattern") as Record<string, boolean[]>;
    expect(pattern.tone[3]).toBe(true);
    expect(world.getProp("drum_1", "bpm")).toBe(132);
    expect(world.getProp("drum_1", "playing")).toBe(true);
    expect(Number(world.getProp("drum_1", "started_at"))).toBeGreaterThan(0);
    if (step.op === "applied") expect(step.observations[0].type).toBe("drum_step_changed");
    if (tempo.op === "applied") expect(tempo.observations[0].type).toBe("tempo_changed");
    if (start.op === "applied") expect(start.observations[0].type).toBe("transport_started");
  });

  it("runs direct dubspace previews as live-only observations", async () => {
    const { world, actor } = authedWorld();
    const entered = await moveActorTo(world, actor, "the_dubspace", { requestId: "move-dubspace-preview" });
    expect(entered.op).toBe("result");
    const result = entered.op === "result"
      ? await world.directCall("preview-1", actor, "the_dubspace", "preview_control", ["delay_1", "feedback", 0.42])
      : entered;
    expect(result.op).toBe("result");
    if (result.op === "result") {
      expect(result.result).toBe(0.42);
      expect(result.audience).toBe("the_dubspace");
      expect(result.observations).toMatchObject([
        { type: "gesture_progress", source: "the_dubspace", actor, target: "delay_1", name: "feedback", value: 0.42 }
      ]);
    }
    expect(world.getProp("delay_1", "feedback")).toBe(0.35);
    expect(world.getProp("the_dubspace", "next_seq")).toBe(1);
    expect(world.replay("the_dubspace", 1, 10)).toEqual([]);
  });

  it("runs chatroom speech as direct live-only observations", async () => {
    const world = createWorld();
    const first = world.auth("guest:first");
    const second = world.auth("guest:second");
    expect(world.verbInfo("the_chatroom", "say").definer).toBe("$conversational");
    expect(world.verbInfo("the_dubspace", "say").definer).toBe("$transparent");

    const enterFirst = await world.directCall("enter-first", first.actor, "the_chatroom", "enter", []);
    const enterSecond = await world.directCall("enter-second", second.actor, "the_chatroom", "enter", []);
    expect(enterFirst.op).toBe("result");
    expect(enterSecond.op).toBe("result");

    const who = await world.directCall("who", first.actor, "the_chatroom", "who", []);
    expect(who.op).toBe("result");
    if (who.op === "result") {
      expect((who.result as Array<{ id: string }>).map((row) => row.id)).toEqual([first.actor, second.actor]);
    }

    const say = await world.directCall("say", first.actor, "the_chatroom", "say", ["hello room"]);
    expect(say.op).toBe("result");
    if (say.op === "result") {
      expect(say.audience).toBe("the_chatroom");
      expect(say.observations).toMatchObject([{ type: "said", source: "the_chatroom", actor: first.actor, text: "hello room" }]);
    }

    const tell = await world.directCall("tell", first.actor, "the_chatroom", "tell", [second.actor, "psst"]);
    expect(tell.op).toBe("result");
    if (tell.op === "result") {
      expect(tell.observations).toMatchObject([{ type: "told", source: "the_chatroom", from: first.actor, to: second.actor, text: "psst" }]);
    }

    await world.directCall("leave-second", second.actor, "the_chatroom", "leave", []);
    await world.directCall("enter-other", first.actor, "the_chatroom", "enter", [second.actor]);
    const afterEnter = await world.directCall("who-2", first.actor, "the_chatroom", "who", []);
    if (afterEnter.op === "result") {
      expect((afterEnter.result as Array<{ id: string }>).map((row) => row.id)).toEqual([first.actor]);
    }

    expect(world.getProp("the_chatroom", "next_seq")).toBe(1);
    expect(world.replay("the_chatroom", 1, 10)).toEqual([]);

    // the_dubspace mounts in the_chatroom with the chat:$transparent feature,
    // so a `say` here also propagates to the parent chatroom — say emits two
    // `said` observations, one per audience.
    const dubspaceEnter = await moveActorTo(world, first.actor, "the_dubspace", { requestId: "dubspace-move", sessionId: first.id });
    expect(dubspaceEnter.op).toBe("result");
    const dubspaceSay = dubspaceEnter.op === "result"
      ? await world.directCall("dubspace-say", first.actor, "the_dubspace", "say", ["same feature"])
      : dubspaceEnter;
    expect(dubspaceSay.op).toBe("result");
    if (dubspaceSay.op === "result") {
      expect(dubspaceSay.audience).toBe("the_dubspace");
      expect(dubspaceSay.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "said", source: "the_dubspace", actor: first.actor, text: "same feature" })
      ]));
    }
    expect(world.getProp("the_dubspace", "next_seq")).toBe(1);
    expect(world.replay("the_dubspace", 1, 10)).toEqual([]);
  });

  it("resolves feature verbs after the parent chain in feature-list order", async () => {
    const world = createWorld();
    world.createObject({ id: "feature_a", parent: "$thing", owner: "$wiz" });
    world.createObject({ id: "feature_b", parent: "$thing", owner: "$wiz" });
    world.createObject({ id: "feature_nested", parent: "$thing", owner: "$wiz" });
    world.addVerb("feature_a", nativeVerb("ping"));
    world.addVerb("feature_b", nativeVerb("ping"));
    world.addVerb("feature_nested", nativeVerb("nested_only"));
    world.setProp("the_dubspace", "features", ["feature_a", "feature_b"]);
    world.setProp("the_dubspace", "features_version", 99);
    world.setProp("feature_a", "features", ["feature_nested"]);

    expect(world.verbInfo("the_dubspace", "ping").definer).toBe("feature_a");
    world.setProp("the_dubspace", "features", ["feature_b", "feature_a"]);
    world.setProp("the_dubspace", "features_version", 100);
    expect(world.verbInfo("the_dubspace", "ping").definer).toBe("feature_b");
    expect(() => world.verbInfo("the_dubspace", "nested_only")).toThrow(/E_VERBNF|verb not found/);

    world.addVerb("$dubspace", nativeVerb("ping"));
    expect(world.verbInfo("the_dubspace", "ping").definer).toBe("$dubspace");
  });

  it("manages feature lists through space feature verbs", async () => {
    const world = createWorld();
    const session = world.auth("guest:feature-owner");
    world.createObject({ id: "owned_space", parent: "$space", owner: session.actor });
    world.createObject({ id: "owned_feature", parent: "$thing", owner: session.actor });
    world.setProp("owned_space", "next_seq", 1);
    world.setSpaceSubscriber("owned_space", session.actor, true, session.id);
    world.setProp("owned_space", "last_snapshot_seq", 0);
    world.sessions.get(session.id)!.activeScope = "owned_space";

    const add = await world.call("add-feature", session.id, "owned_space", message(session.actor, "owned_space", "add_feature", ["owned_feature"]));
    expect(add.op).toBe("applied");
    if (add.op === "applied") expect(add.observations[0]).toMatchObject({ type: "feature_added", source: "owned_space", feature: "owned_feature" });
    expect(world.getProp("owned_space", "features")).toEqual(["owned_feature"]);
    expect(world.getProp("owned_space", "features_version")).toBe(1);

    const has = await world.directCall("has-feature", session.actor, "owned_space", "has_feature", ["owned_feature"]);
    expect(has.op).toBe("result");
    if (has.op === "result") expect(has.result).toBe(true);

    const duplicate = await world.call("add-feature-again", session.id, "owned_space", message(session.actor, "owned_space", "add_feature", ["owned_feature"]));
    expect(world.getProp("owned_space", "features_version")).toBe(1);
    if (duplicate.op === "applied") expect(duplicate.observations[0].type).toBe("feature_already_added");

    const remove = await world.call("remove-feature", session.id, "owned_space", message(session.actor, "owned_space", "remove_feature", ["owned_feature"]));
    expect(remove.op).toBe("applied");
    expect(world.getProp("owned_space", "features")).toEqual([]);
    expect(world.getProp("owned_space", "features_version")).toBe(2);
  });

  it("allows conversational feature attachment by non-wizard space owners", async () => {
    const world = createWorld();
    const session = world.auth("guest:chat-feature-owner");
    world.createObject({ id: "owned_chat_space", parent: "$space", owner: session.actor });
    world.setProp("owned_chat_space", "next_seq", 1);
    world.setSpaceSubscriber("owned_chat_space", session.actor, true, session.id);
    world.setProp("owned_chat_space", "last_snapshot_seq", 0);
    world.sessions.get(session.id)!.activeScope = "owned_chat_space";

    const add = await world.call("add-conversational", session.id, "owned_chat_space", message(session.actor, "owned_chat_space", "add_feature", ["$conversational"]));
    expect(add.op).toBe("applied");
    expect(world.getProp("owned_chat_space", "features")).toEqual(["$conversational"]);
  });

  it("rejects non-direct-callable verbs over direct ingress", async () => {
    const { world, actor } = authedWorld();
    const result = await world.directCall("direct-denied", actor, "the_dubspace", "set_control", ["delay_1", "feedback", 0.44]);
    expect(result.op).toBe("error");
    if (result.op === "error") expect(result.error.code).toBe("E_DIRECT_DENIED");
    expect(world.getProp("delay_1", "feedback")).toBe(0.35);
    expect(world.replay("the_dubspace", 1, 10)).toEqual([]);
  });

  it("allows wizard force-direct repair and records the bypass", async () => {
    const { world, actor } = authedWorld();
    const nonWizard = await world.directCall("force-denied", actor, "the_dubspace", "set_control", ["delay_1", "feedback", 0.44], { forceDirect: true });
    expect(nonWizard.op).toBe("error");
    if (nonWizard.op === "error") expect(nonWizard.error.code).toBe("E_PERM");

    const wizard = await world.directCall("force-wizard", "$wiz", "the_dubspace", "set_control", ["delay_1", "feedback", 0.44], {
      forceDirect: true,
      forceReason: "test repair"
    });
    expect(wizard.op).toBe("result");
    if (wizard.op === "result") {
      expect(wizard.observations[0]).toMatchObject({ type: "wizard_action", action: "force_direct", actor: "$wiz", target: "the_dubspace", verb: "set_control" });
      expect(wizard.observations[1]).toMatchObject({ type: "control_changed", target: "delay_1", name: "feedback", value: 0.44 });
    }
    expect(world.getProp("delay_1", "feedback")).toBe(0.44);
    expect(world.replay("the_dubspace", 1, 10)).toEqual([]);
    const audit = world.getProp("$system", "wizard_actions");
    expect(audit).toEqual([
      expect.objectContaining({ actor: "$wiz", action: "force_direct", target: "the_dubspace", verb: "set_control", reason: "test repair" })
    ]);
  });
});
