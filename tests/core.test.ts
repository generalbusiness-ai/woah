import { describe, expect, it } from "vitest";
import { installVerb } from "../src/core/authoring";
import { bootstrap, createWorld, createWorldFromSerialized, mergeHostScopedSeed, nonEmptyHostScopedWorld, scopeSerializedWorldToHost } from "../src/core/bootstrap";
import { bundledCatalogAliases, installLocalCatalogs } from "../src/core/local-catalogs";
import type { CallContext, WooWorld } from "../src/core/world";
import type { MetricEvent, ObjRef, WooValue } from "../src/core/types";
import {
  authedWorld,
  bytecodeVerb,
  callInDubspace,
  callInTaskspace,
  LocalHostBridge,
  message,
  nativeVerb
} from "./core-support";

describe("woo core", () => {
  it("bootstraps the seed graph and describes objects", async () => {
    const world = createWorld();
    expect(world.object("$root").id).toBe("$root");
    expect(world.object("the_dubspace").parent).toBe("$dubspace");
    expect(world.object("the_taskspace").parent).toBe("$taskspace");
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
    world.defineProperty("the_taskspace", {
      name,
      defaultValue: "secret",
      owner: "$wiz",
      perms: "w",
      typeHint: "str"
    });

    expect(world.describeForActor("the_taskspace", actor).properties).toContain(name);
    expect(() => world.getPropForActor(actor, "the_taskspace", name)).toThrow(/cannot read/);
    expect(world.getPropForActor("$wiz", "the_taskspace", name)).toBe("secret");

    world.defineProperty("the_taskspace", {
      name: "description",
      defaultValue: "private taskspace",
      owner: "$wiz",
      perms: "w",
      typeHint: "str"
    });
    world.setProp("the_taskspace", "description", "private taskspace");
    expect((world.state(actor).objects.the_taskspace as Record<string, unknown>).description).toBeNull();
    expect((world.state("$wiz").objects.the_taskspace as Record<string, unknown>).description).toBe("private taskspace");

    await callInTaskspace(world, session.id, "enter-describe", message(actor, "the_taskspace", "enter", []));
    const described = await callInTaskspace(world, session.id, "describe-private", message(actor, "the_taskspace", "describe", []));
    expect(described.op).toBe("result");
    if (described.op === "result") expect((described.result as Record<string, unknown>).description).toBeNull();
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

  it("routes VM reads and CALL_VERB through a host bridge but rejects cross-host writes", async () => {
    const { world: home, session, actor } = authedWorld();
    const remote = createWorld({ catalogs: false });
    const worlds = new Map<string, WooWorld>([
      ["home", home],
      ["remote", remote]
    ]);
    const routes = new Map<ObjRef, string>([["remote_box", "remote"]]);
    home.setHostBridge(new LocalHostBridge("home", worlds, routes));
    remote.setHostBridge(new LocalHostBridge("remote", worlds, routes));

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

    const failedWrite = await callInDubspace(home, session.id, "cross-host-write", message(actor, "local_writer", "write_remote", []));
    expect(failedWrite.op).toBe("applied");
    if (failedWrite.op === "applied") expect(failedWrite.observations[0]).toMatchObject({ type: "$error", code: "E_CROSS_HOST_WRITE" });
    expect(remote.getProp("remote_box", "value")).toBe("remote");
  });

  it("memoizes repeated remote reads within one host operation", async () => {
    const { world: home, actor } = authedWorld();
    const remote = createWorld({ catalogs: false });
    const worlds = new Map<string, WooWorld>([
      ["home", home],
      ["remote", remote]
    ]);
    const routes = new Map<ObjRef, string>([["remote_box", "remote"]]);
    const bridge = new LocalHostBridge("home", worlds, routes);
    home.setHostBridge(bridge);
    remote.setHostBridge(new LocalHostBridge("remote", worlds, routes));

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
    const bridge = new LocalHostBridge("home", worlds, routes);
    home.setHostBridge(bridge);
    remote.setHostBridge(new LocalHostBridge("remote", worlds, routes));

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
    const bridge = new LocalHostBridge("home", worlds, routes);
    home.setHostBridge(bridge);
    remote.setHostBridge(new LocalHostBridge("remote", worlds, routes));

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
    home.setHostBridge(new LocalHostBridge("home", worlds, routes));
    remote.setHostBridge(new LocalHostBridge("remote", worlds, routes));

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
    home.setHostBridge(new LocalHostBridge("home", worlds, routes));
    remote.setHostBridge(new LocalHostBridge("remote", worlds, routes));

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
    chat.setHostBridge(new LocalHostBridge("chat", worlds, routes));
    pinboard.setHostBridge(new LocalHostBridge("pinboard", worlds, routes));

    chat.setActorPresence(watcher.actor, "the_deck", true);
    chat.setSpaceSubscriber("the_deck", watcher.actor, true);

    const entered = await pinboard.directCall("remote-mounted-pinboard-enter", actor.actor, "the_pinboard", "enter", []);

    expect(entered.op).toBe("result");
    if (entered.op !== "result") return;
    expect(entered.observations.map((obs) => obs.type)).toEqual(["pinboard_entered", "pinboard_activity"]);
    expect(entered.observations[1]).toMatchObject({ source: "the_deck", board: "the_pinboard", actor: actor.actor });
    expect(entered.observationAudiences?.[0]).toEqual([]);
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
      ...nativeVerb("poke", "default_title", "$wiz"),
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
    expect(world.object("$dubspace").parent).toBe("$space");
    expect(world.object("$taskspace").parent).toBe("$space");
    expect(world.object("$conversational").parent).toBe("$thing");
    expect(world.object("$dubspace").eventSchemas.has("control_changed")).toBe(true);
    expect(world.verbInfo("the_dubspace", "set_control").source).toContain("target.(name)");
    expect(world.verbInfo("the_dubspace", "start_loop").bytecode_version).toBeGreaterThan(0);
    expect(world.verbInfo("the_chatroom", "say").definer).toBe("$conversational");
  });

  it("can boot without demo catalogs and install them later", async () => {
    const world = createWorld({ catalogs: false });
    expect(() => world.object("the_dubspace")).toThrow(/E_OBJNF|object not found/);
    expect(world.getProp("$catalog_registry", "installed_catalogs")).toEqual([]);
    const session = world.auth("guest:clean");
    expect(world.allLocationsForActor(session.actor)).toEqual(["$nowhere"]);

    installLocalCatalogs(world, ["chat", "demoworld", "taskspace", "dubspace"]);
    expect(world.object("the_chatroom").parent).toBe("$chatroom");
    expect(world.object("the_taskspace").parent).toBe("$taskspace");
    expect(world.object("the_dubspace").parent).toBe("$dubspace");
    expect(world.verbInfo("the_taskspace", "say").definer).toBe("$transparent");
  });

  it("exports host-scoped worlds for routed cluster hosts", async () => {
    const world = createWorld();
    const session = world.auth("guest:host-scope");
    const scoped = world.exportHostScopedWorld("the_taskspace");
    const ids = scoped.objects.map((obj) => obj.id);

    expect(ids).toContain("the_taskspace");
    expect(ids).toContain("$taskspace");
    expect(ids).toContain("$task");
    expect(ids).toContain("$conversational");
    expect(ids).not.toContain("the_dubspace");
    expect(ids).not.toContain("the_chatroom");
    expect(scoped.sessions).toEqual([]);
    expect(scoped.logs.every(([space]) => space === "the_taskspace")).toBe(true);

    const cluster = createWorldFromSerialized(scoped, { persist: false });
    const clusterSession = cluster.auth("guest:host-scope");
    const entered = await cluster.directCall("host-scope-enter", clusterSession.actor, "the_taskspace", "enter", []);
    expect(entered.op).toBe("result");
    const created = await cluster.call("host-scope-create", clusterSession.id, "the_taskspace", message(clusterSession.actor, "the_taskspace", "create_task", ["Scoped", ""]));
    expect(created.op).toBe("applied");
    if (created.op !== "applied") return;
    const task = String(created.observations.find((obs) => obs.type === "task_created")?.task ?? "");
    expect(task).toMatch(/^obj_the_taskspace_/);
    expect(cluster.object(task).parent).toBe("$task");
    expect(cluster.objectRoutes()).toContainEqual({ id: task, host: "the_taskspace", anchor: "the_taskspace" });
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
    expect(ids).not.toContain("the_taskspace");
    expect(ids).toContain("the_chatroom");

    const chatScoped = scopeSerializedWorldToHost(full, "the_chatroom");
    const chatIds = chatScoped.objects.map((obj) => obj.id);
    const room = chatScoped.objects.find((obj) => obj.id === "the_chatroom");
    const mountedDubspace = chatScoped.objects.find((obj) => obj.id === "the_dubspace");
    expect(chatIds).toContain("the_dubspace");
    expect(mountedDubspace?.contents).toEqual([]);
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

  it("merges fresh host seed into a stale host slice without wiping dynamic room state", async () => {
    const staleWorld = createWorld();
    const session = staleWorld.auth("guest:merge-host-seed");
    staleWorld.object("the_chatroom").name = "Lobby";
    staleWorld.setProp("the_chatroom", "name", "Lobby");
    staleWorld.setProp("the_chatroom", "subscribers", [session.actor]);
    staleWorld.setProp("the_chatroom", "next_seq", 42);
    staleWorld.object("the_chatroom").contents.delete("the_lamp");
    staleWorld.object("the_chatroom").contents.delete("the_dubspace");
    staleWorld.objects.delete("the_lamp");
    staleWorld.objects.delete("the_towel");
    staleWorld.objects.delete("the_mug");
    staleWorld.objects.delete("the_dubspace");
    staleWorld.object("the_deck").contents.delete("the_towel");

    const fresh = createWorld().exportWorld();
    const staleScoped = nonEmptyHostScopedWorld(staleWorld.exportWorld(), "the_chatroom");
    const freshScoped = nonEmptyHostScopedWorld(fresh, "the_chatroom");
    expect(staleScoped).not.toBeNull();
    expect(freshScoped).not.toBeNull();

    const merged = mergeHostScopedSeed(staleScoped!, freshScoped!);
    const reloaded = createWorldFromSerialized(merged, { persist: false });

    expect(reloaded.object("the_chatroom").name).toBe("Living Room");
    expect(reloaded.getProp("the_chatroom", "name")).toBe("Lobby");
    expect(reloaded.getProp("the_chatroom", "subscribers")).toEqual([session.actor]);
    expect(reloaded.getProp("the_chatroom", "next_seq")).toBe(42);
    expect(reloaded.objects.has("the_lamp")).toBe(true);
    expect(reloaded.object("the_chatroom").contents.has("the_lamp")).toBe(true);
    expect(reloaded.objects.has("the_mug")).toBe(true);
    expect(reloaded.object("the_chatroom").contents.has("the_mug")).toBe(true);
    expect(reloaded.object("the_dubspace").location).toBe("the_chatroom");
    expect(reloaded.object("the_chatroom").contents.has("the_dubspace")).toBe(true);
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

    const merged = mergeHostScopedSeed(storedScoped!, freshScoped!);
    const reloaded = createWorldFromSerialized(merged, { persist: false });

    expect(reloaded.getProp("the_pinboard", "notes")).toEqual([
      { id: "n1", text: "keep me", color: "yellow", x: 48, y: 48, w: 180, h: 110, z: 1 }
    ]);
    expect(reloaded.getProp("the_pinboard", "next_note_id")).toBe(2);
    expect(reloaded.getProp("the_pinboard", "next_z")).toBe(2);
    expect(reloaded.ownVerb("$pinboard", "add_note")).toBeDefined();
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
    expect(session.currentLocation).toBe("the_chatroom");
    expect(world.object("the_chatroom").contents.has(session.actor)).toBe(true);
    expect(world.hasPresence(session.actor, "the_chatroom")).toBe(false);
  });

  it("does not join the chatroom until explicit enter", async () => {
    const world = createWorld();
    const session = world.auth("guest:no-chat-autojoin");
    expect(world.hasPresence(session.actor, "the_dubspace")).toBe(false);
    expect(world.hasPresence(session.actor, "the_taskspace")).toBe(false);
    expect(world.hasPresence(session.actor, "the_chatroom")).toBe(false);

    const enter = await world.directCall("enter-chat", session.actor, "the_chatroom", "enter", []);
    expect(enter.op).toBe("result");
    expect(world.hasPresence(session.actor, "the_chatroom")).toBe(true);
  });

  it("tracks current location per session for the same actor", async () => {
    const world = createWorld();
    const primary = world.auth("guest:multi-location");
    const actor = primary.actor;
    const secondary = world.ensureSessionForActor("zz-secondary-location-session", actor, "guest");

    expect((await world.directCall("primary-enter-chat", actor, "the_chatroom", "enter", [], { sessionId: primary.id })).op).toBe("result");
    expect((await world.directCall("secondary-enter-dubspace", actor, "the_dubspace", "enter", [], { sessionId: secondary.id })).op).toBe("result");

    expect(world.currentLocationForSession(primary.id)).toBe("the_chatroom");
    expect(world.currentLocationForSession(secondary.id)).toBe("the_dubspace");
    expect(world.object(actor).location).toBe("the_chatroom");
    expect(world.hasSessionPresence(primary.id, "the_chatroom")).toBe(true);
    expect(world.hasSessionPresence(primary.id, "the_dubspace")).toBe(false);
    expect(world.hasSessionPresence(secondary.id, "the_chatroom")).toBe(false);
    expect(world.hasSessionPresence(secondary.id, "the_dubspace")).toBe(true);
    expect(new Set(world.allLocationsForActor(actor))).toEqual(new Set(["the_chatroom", "the_dubspace"]));
  });

  it("routes live observations to sessions in the source space, not every actor session", async () => {
    const world = createWorld();
    const primary = world.auth("guest:session-audience");
    const actor = primary.actor;
    const secondary = world.ensureSessionForActor("secondary-audience-session", actor, "guest");

    await world.directCall("audience-primary-chat", actor, "the_chatroom", "enter", [], { sessionId: primary.id });
    await world.directCall("audience-secondary-dubspace", actor, "the_dubspace", "enter", [], { sessionId: secondary.id });
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
    await world.directCall("transparent-inside-enter", inside.actor, "the_dubspace", "enter", [], { sessionId: inside.id });
    const said = await world.directCall("transparent-say", inside.actor, "the_dubspace", "say", ["beat"], { sessionId: inside.id });

    expect(said.op).toBe("result");
    if (said.op === "result") {
      expect(said.observations.map((observation) => observation.source)).toEqual(["the_dubspace", "the_chatroom"]);
      expect(said.observationSessionAudiences).toEqual([[inside.id], [outside.id]]);
    }
  });

  it("routes transparent announcements once to child and parent room sessions", async () => {
    const world = createWorld();
    const speaker = world.auth("guest:transparent-announcer");
    const inside = world.auth("guest:transparent-announcement-inside");
    const outside = world.auth("guest:transparent-announcement-outside");

    await world.directCall("transparent-ann-outside-enter", outside.actor, "the_chatroom", "enter", [], { sessionId: outside.id });
    await world.directCall("transparent-ann-speaker-enter", speaker.actor, "the_dubspace", "enter", [], { sessionId: speaker.id });
    await world.directCall("transparent-ann-inside-enter", inside.actor, "the_dubspace", "enter", [], { sessionId: inside.id });

    const announced = await world.directCall("transparent-announcement", speaker.actor, "the_dubspace", "announce_all", ["pulse"], { sessionId: speaker.id });

    expect(announced.op).toBe("result");
    if (announced.op === "result") {
      const textObservations = announced.observations.filter((observation) => observation.type === "text");
      expect(textObservations.map((observation) => observation.target).sort()).toEqual([speaker.actor, inside.actor, outside.actor].sort());
      expect(textObservations.filter((observation) => observation.target === speaker.actor)).toHaveLength(1);
      expect(textObservations.filter((observation) => observation.target === inside.actor)).toHaveLength(1);
      expect(textObservations.filter((observation) => observation.target === outside.actor)).toHaveLength(1);
      const sessionsByTarget = Object.fromEntries(textObservations.map((observation, index) => [
        String(observation.target),
        announced.observationSessionAudiences?.[index] ?? []
      ]));
      expect(sessionsByTarget[speaker.actor]).toEqual([speaker.id]);
      expect(sessionsByTarget[inside.actor]).toEqual([inside.id]);
      expect(sessionsByTarget[outside.actor]).toEqual([outside.id]);
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
    home.setHostBridge(new LocalHostBridge("home", worlds, routes));
    remote.setHostBridge(new LocalHostBridge("remote", worlds, routes));
    home.createObject({ id: "remote_room", name: "Remote Room", parent: "$space", owner: "$wiz" });
    remote.createObject({ id: "remote_room", name: "Remote Room", parent: "$space", owner: "$wiz" });
    home.createObject({ id: "emitter", name: "Emitter", parent: "$thing", owner: "$wiz", location: "remote_room" });
    home.registerNativeHandler("emit_remote_room", (ctx) => {
      ctx.observe({ type: "remote_ping", source: "remote_room", _audience_override: [actor] } as WooValue as Record<string, WooValue> & { type: string });
      return true;
    });
    home.addVerb("emitter", { ...nativeVerb("emit_remote", "emit_remote_room"), direct_callable: true, skip_presence_check: true });
    remote.setSpaceSubscriber("remote_room", actor, true, primary.id);
    home.sessions.get(primary.id)!.currentLocation = "remote_room";
    home.sessions.get(secondary.id)!.currentLocation = "the_chatroom";

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
    expect(resumed.currentLocation).toBe("the_chatroom");
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
    expect((await world.directCall("primary-promotion-middle-enter", actor, "the_dubspace", "enter", [], { sessionId: middle.id })).op).toBe("result");
    expect((await world.directCall("primary-promotion-newest-enter", actor, "the_taskspace", "enter", [], { sessionId: newest.id })).op).toBe("result");
    expect(world.primarySessionForActor(actor)?.id).toBe(oldest.id);
    expect(world.object(actor).location).toBe("the_chatroom");

    oldest.expiresAt = Date.now() - 1;
    expect(world.reapExpiredSessions()).toEqual([oldest.id]);
    expect(world.primarySessionForActor(actor)?.id).toBe(middle.id);
    expect(world.object(actor).location).toBe("the_dubspace");
    expect(world.currentLocationForSession(middle.id)).toBe("the_dubspace");
    expect(world.currentLocationForSession(newest.id)).toBe("the_taskspace");
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
    await world.directCall("enter-chat-before-reap", actor, "the_chatroom", "enter", []);
    const enterDubspace = await world.directCall("enter-dubspace-before-reap", actor, "the_dubspace", "enter", []);
    expect(enterDubspace.op).toBe("result");
    expect(world.getProp("the_dubspace", "operators")).toEqual([actor]);
    await world.directCall("return-chat-before-reap", actor, "the_chatroom", "enter", []);
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
    expect(world.hasPresence(actor, "the_taskspace")).toBe(false);
    expect(world.hasPresence(actor, "the_chatroom")).toBe(false);
    expect(world.getProp("the_dubspace", "operators")).toEqual([]);
    expect(world.getProp(actor, "description")).toBe("");
    expect(world.getProp(actor, "aliases")).toEqual([]);
    expect(world.getProp(actor, "focus_list")).toEqual([]);
    expect(world.object(actor).location).toBe("$nowhere");
    expect(world.object(actor).contents.has("missing_inventory_ref")).toBe(false);
    expect(world.object("the_lamp").location).toBe("the_chatroom");
    expect(world.object("the_chatroom").contents.has("the_lamp")).toBe(true);

    const next = world.auth("guest:after-reap");
    expect(next.actor).toBe(actor);
    expect(world.getProp("the_dubspace", "operators")).toEqual([]);
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
    const entered = await world.directCall("enter-dubspace-preview", actor, "the_dubspace", "enter", []);
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
    expect(world.verbInfo("the_taskspace", "say").definer).toBe("$transparent");

    const enterFirst = await world.directCall("enter-first", first.actor, "the_chatroom", "enter", []);
    const enterSecond = await world.directCall("enter-second", second.actor, "the_chatroom", "enter", []);
    expect(enterFirst.op).toBe("result");
    expect(enterSecond.op).toBe("result");

    const who = await world.directCall("who", first.actor, "the_chatroom", "who", []);
    expect(who.op).toBe("result");
    if (who.op === "result") expect(who.result).toEqual([first.actor, second.actor]);

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
    if (afterEnter.op === "result") expect(afterEnter.result).toEqual([first.actor]);

    expect(world.getProp("the_chatroom", "next_seq")).toBe(1);
    expect(world.replay("the_chatroom", 1, 10)).toEqual([]);

    const taskspaceEnter = await world.directCall("taskspace-enter", first.actor, "the_taskspace", "enter", []);
    expect(taskspaceEnter.op).toBe("result");
    const taskspaceSay = taskspaceEnter.op === "result"
      ? await world.directCall("taskspace-say", first.actor, "the_taskspace", "say", ["same feature"])
      : taskspaceEnter;
    expect(taskspaceSay.op).toBe("result");
    if (taskspaceSay.op === "result") {
      expect(taskspaceSay.audience).toBe("the_taskspace");
      expect(taskspaceSay.observations).toMatchObject([{ type: "said", source: "the_taskspace", actor: first.actor, text: "same feature" }]);
    }
    expect(world.getProp("the_taskspace", "next_seq")).toBe(1);
    expect(world.replay("the_taskspace", 1, 10)).toEqual([]);
  });

  it("resolves feature verbs after the parent chain in feature-list order", async () => {
    const world = createWorld();
    world.createObject({ id: "feature_a", parent: "$thing", owner: "$wiz" });
    world.createObject({ id: "feature_b", parent: "$thing", owner: "$wiz" });
    world.createObject({ id: "feature_nested", parent: "$thing", owner: "$wiz" });
    world.addVerb("feature_a", nativeVerb("ping"));
    world.addVerb("feature_b", nativeVerb("ping"));
    world.addVerb("feature_nested", nativeVerb("nested_only"));
    world.setProp("the_taskspace", "features", ["feature_a", "feature_b"]);
    world.setProp("the_taskspace", "features_version", 99);
    world.setProp("feature_a", "features", ["feature_nested"]);

    expect(world.verbInfo("the_taskspace", "ping").definer).toBe("feature_a");
    world.setProp("the_taskspace", "features", ["feature_b", "feature_a"]);
    world.setProp("the_taskspace", "features_version", 100);
    expect(world.verbInfo("the_taskspace", "ping").definer).toBe("feature_b");
    expect(() => world.verbInfo("the_taskspace", "nested_only")).toThrow(/E_VERBNF|verb not found/);

    world.addVerb("$taskspace", nativeVerb("ping"));
    expect(world.verbInfo("the_taskspace", "ping").definer).toBe("$taskspace");
  });

  it("manages feature lists through space feature verbs", async () => {
    const world = createWorld();
    const session = world.auth("guest:feature-owner");
    world.createObject({ id: "owned_space", parent: "$space", owner: session.actor });
    world.createObject({ id: "owned_feature", parent: "$thing", owner: session.actor });
    world.setProp("owned_space", "next_seq", 1);
    world.setSpaceSubscriber("owned_space", session.actor, true, session.id);
    world.setProp("owned_space", "last_snapshot_seq", 0);
    world.sessions.get(session.id)!.currentLocation = "owned_space";

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
    world.sessions.get(session.id)!.currentLocation = "owned_chat_space";

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
