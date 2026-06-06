import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileVerb, installVerb } from "../src/core/authoring";
import { createWorld } from "../src/core/bootstrap";
import { wooError } from "../src/core/types";
import type { AppliedFrame, DirectResultFrame, ErrorFrame, Message, ObjRef, TinyBytecode, VerbDef, WooValue } from "../src/core/types";
import type { CallContext, DeferredHostEffect, ExecutorContext, HostObjectSummary, MoveObjectResult, RoomSnapshot, ScopedObjectSummary, WooWorld } from "../src/core/world";
import { LocalSQLiteRepository } from "../src/server/sqlite-repository";

type Harness = {
  world: WooWorld;
  restart: () => WooWorld;
  cleanup: () => void;
};

// Tests that pass a repository skip the boot-snapshot cache, so each
// createWorld() pays the full bundled-catalog install cost (~4s, since
// chat/demoworld/dubspace/pinboard/tasks all compile their DSL verbs
// from manifest sources). Cross-host tests build three worlds, which adds
// up to ~12s of setup before the test body even runs. Tests that don't
// need the bundled catalogs (only $space / $thing / $actor in core) should
// pass `catalogs: false`; tests that need a subset should name it.
type MakeOptions = { catalogs?: readonly string[] | false };

type Backend = {
  name: string;
  make: (options?: MakeOptions) => Harness;
};

// SQLite is the only conformance backend. `restart()` needs to reopen the
// same store, so file-backed SQLite (not `:memory:`) is the right choice
// here even when individual tests don't restart.
const backends: Backend[] = [
  {
    name: "sqlite",
    make: (options) => {
      const catalogs = options?.catalogs;
      const dir = mkdtempSync(join(tmpdir(), "woo-conformance-"));
      const path = join(dir, "world.sqlite");
      let repo = new LocalSQLiteRepository(path);
      let world = createWorld({ repository: repo, catalogs });
      return {
        get world() {
          return world;
        },
        restart: () => {
          repo.close();
          repo = new LocalSQLiteRepository(path);
          world = createWorld({ repository: repo, catalogs });
          return world;
        },
        cleanup: () => {
          repo.close();
          rmSync(dir, { recursive: true, force: true });
        }
      };
    }
  }
];

function message(actor: string, target: string, verb: string, args: WooValue[] = []): Message {
  return { actor, target, verb, args };
}

async function callInDubspace(
  world: ReturnType<typeof createWorld>,
  sessionId: string,
  requestId: string,
  request: Message
): Promise<AppliedFrame | DirectResultFrame | ErrorFrame> {
  const sessionActor = world.sessions.get(sessionId)?.actor;
  if (sessionActor !== request.actor) {
    return world.call(requestId, sessionId, "the_dubspace", request);
  }
  if (!world.hasPresence(sessionActor, "the_dubspace")) {
    const entered = await world.directCall(`enter-${requestId}`, sessionActor, "the_dubspace", "enter", []);
    if (entered.op === "error") return entered;
  }

  let verb;
  try {
    ({ verb } = world.resolveVerb(request.target, request.verb));
  } catch {
    return world.call(requestId, sessionId, "the_dubspace", request);
  }
  if (request.target === "the_dubspace" && verb.direct_callable === true && typeof verb.perms === "string" && verb.perms.includes("x")) {
    return world.directCall(requestId, request.actor, request.target, request.verb, request.args);
  }
  return world.call(requestId, sessionId, "the_dubspace", request);
}


function bytecodeVerb(name: string, bytecode: TinyBytecode): VerbDef {
  return {
    kind: "bytecode",
    name,
    aliases: [],
    owner: "$wiz",
    perms: "rxd",
    arg_spec: {},
    source: `conformance ${name}`,
    source_hash: `conformance-${name}`,
    version: 1,
    line_map: {},
    bytecode
  };
}

class LocalExecutorContext implements ExecutorContext {
  readonly contentsCalls = new Map<ObjRef, number>();
  actorSessionLocationsCalls = 0;
  actorSessionLocationsBatchCalls: Array<ObjRef[]> = [];
  // Test knob: when set, actorSessionLocationsBatch throws a read-
  // availability error instead of answering. Lets a test simulate a cold
  // or unreachable home host.
  failBatchWith: { code: string; message: string } | null = null;

  constructor(
    readonly localHost: string,
    private readonly worlds: Map<string, WooWorld>,
    private readonly routes: Map<ObjRef, string>
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

  async describeObject(_nameActor: ObjRef, readActor: ObjRef, objRef: ObjRef): Promise<HostObjectSummary> {
    const world = this.worldFor(objRef);
    return {
      name: world.object(objRef).name,
      description: world.propOrNullForActor(readActor, objRef, "description"),
      aliases: world.propOrNullForActor(readActor, objRef, "aliases"),
      owner: world.object(objRef).owner,
      obvious_verbs: world.obviousCommandSyntaxes(objRef, world.object(objRef).name || objRef)
    };
  }

  async resolveVerb(target: ObjRef, verbName: string): Promise<{ name: string; direct_callable: boolean; arg_spec: Record<string, WooValue> } | null> {
    const world = this.worldFor(target);
    try {
      const { verb } = world.resolveVerb(target, verbName);
      return { name: verb.name, direct_callable: verb.direct_callable === true, arg_spec: verb.arg_spec ?? {} };
    } catch {
      return null;
    }
  }

  async location(objRef: ObjRef): Promise<ObjRef | null> {
    return this.worldFor(objRef).object(objRef).location;
  }

  async isDescendantOf(objRef: ObjRef, ancestorRef: ObjRef): Promise<boolean> {
    return await this.worldFor(objRef).isDescendantOfChecked(objRef, ancestorRef);
  }

  async dispatch(ctx: CallContext, target: ObjRef, verbName: string, args: WooValue[], startAt?: ObjRef | null): Promise<WooValue> {
    const remote = this.worldFor(startAt ?? target);
    return await remote.hostDispatch({ ...ctx, world: remote }, target, verbName, args, startAt);
  }

  async moveObject(objRef: ObjRef, targetRef: ObjRef, options: { suppressMirrorHost?: string | null } = {}): Promise<MoveObjectResult> {
    const suppressMirrorHost = options.suppressMirrorHost ?? this.localHost;
    const result = await this.worldFor(objRef).moveObjectChecked(objRef, targetRef, { suppressMirrorHost });
    const localWorld = this.worlds.get(this.localHost);
    if (suppressMirrorHost === this.localHost && localWorld) {
      if (result.oldLocation && this.hostForObject(result.oldLocation) === this.localHost && localWorld.objects.has(result.oldLocation)) {
        localWorld.mirrorContents(result.oldLocation, objRef, false);
      }
      if (this.hostForObject(result.location) === this.localHost && localWorld.objects.has(result.location)) {
        localWorld.mirrorContents(result.location, objRef, true);
      }
    }
    return result;
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
    this.actorSessionLocationsCalls += 1;
    return this.worldFor(actor).allLocationsForActor(actor);
  }

  async actorSessionLocationsBatch(actors: ObjRef[]): Promise<Map<ObjRef, ObjRef[]>> {
    this.actorSessionLocationsBatchCalls.push([...actors]);
    if (this.failBatchWith) throw wooError(this.failBatchWith.code, this.failBatchWith.message);
    const out = new Map<ObjRef, ObjRef[]>();
    for (const actor of actors) out.set(actor, this.worldFor(actor).allLocationsForActor(actor));
    return out;
  }

  async contents(objRef: ObjRef): Promise<ObjRef[]> {
    this.contentsCalls.set(objRef, (this.contentsCalls.get(objRef) ?? 0) + 1);
    return this.worldFor(objRef).contentsOf(objRef);
  }

  private worldFor(id: ObjRef): WooWorld {
    const host = this.routes.get(id);
    if (!host) throw new Error(`no route for ${id}`);
    const world = this.worlds.get(host);
    if (!world) throw new Error(`no world for ${host}`);
    return world;
  }
}

function installForkFixture(world: WooWorld): void {
  world.addVerb(
    "delay_1",
    bytecodeVerb("conf_mark", {
      literals: ["conf_forked", "type", "conf_fork_ran", "value", null],
      num_locals: 0,
      max_stack: 6,
      version: 1,
      ops: [
        ["PUSH_THIS"],
        ["PUSH_LIT", 0],
        ["PUSH_ARG", 0],
        ["SET_PROP"],
        ["PUSH_LIT", 1],
        ["PUSH_LIT", 2],
        ["PUSH_LIT", 3],
        ["PUSH_ARG", 0],
        ["MAKE_MAP", 2],
        ["OBSERVE"],
        ["PUSH_LIT", 4],
        ["RETURN"]
      ]
    })
  );
  world.addVerb(
    "delay_1",
    bytecodeVerb("conf_schedule_mark", {
      literals: ["conf_mark"],
      num_locals: 0,
      max_stack: 5,
      version: 1,
      ops: [["PUSH_INT", 0], ["PUSH_THIS"], ["PUSH_LIT", 0], ["PUSH_ARG", 0], ["FORK", 1], ["RETURN"]]
    })
  );
}

function installReadFixture(world: WooWorld): void {
  world.addVerb(
    "delay_1",
    bytecodeVerb("conf_read_then_mark", {
      literals: ["conf_read_value", "type", "conf_read_resumed", "value", null],
      num_locals: 1,
      max_stack: 6,
      version: 1,
      ops: [
        ["PUSH_ACTOR"],
        ["READ"],
        ["POP_LOCAL", 0],
        ["PUSH_THIS"],
        ["PUSH_LIT", 0],
        ["PUSH_LOCAL", 0],
        ["SET_PROP"],
        ["PUSH_LIT", 1],
        ["PUSH_LIT", 2],
        ["PUSH_LIT", 3],
        ["PUSH_LOCAL", 0],
        ["MAKE_MAP", 2],
        ["OBSERVE"],
        ["PUSH_LIT", 4],
        ["RETURN"]
      ]
    })
  );
}

function installFailureFixture(world: WooWorld): void {
  world.addVerb(
    "delay_1",
    bytecodeVerb("conf_mutate_then_fail", {
      literals: ["conf_failed_value", "E_CONF_FAIL"],
      num_locals: 0,
      max_stack: 3,
      version: 1,
      ops: [["PUSH_THIS"], ["PUSH_LIT", 0], ["PUSH_ARG", 0], ["SET_PROP"], ["PUSH_LIT", 1], ["RAISE"], ["PUSH_INT", 0], ["RETURN"]]
    })
  );
}

describe.each(backends)("world conformance: $name", ({ make }) => {
  it("sequences calls, supports idempotent retry, replay paging, and behavior rollback", async () => {
    const harness = make();
    try {
      const world = harness.world;
      const session = world.auth("guest:conf-sequence");
      const firstMessage = message(session.actor, "the_dubspace", "set_control", ["delay_1", "feedback", 0.71]);
      const first = await callInDubspace(world, session.id, "same-frame", firstMessage);
      const retry = await callInDubspace(world, session.id, "same-frame", firstMessage);
      expect(retry).toEqual(first);
      expect(world.replay("the_dubspace", 1, 10)).toHaveLength(1);

      const beforeFailedVersion = world.mutationVersion();
      const failed = await callInDubspace(world, session.id, "missing", message(session.actor, "delay_1", "missing_verb", []));
      expect(failed.op).toBe("applied");
      if (failed.op === "applied") {
        expect(failed.seq).toBe(2);
        expect(failed.observations[0]).toMatchObject({ type: "$error", code: "E_VERBNF" });
      }
      expect(world.mutationVersion()).toBeGreaterThan(beforeFailedVersion);
      expect(world.getProp("delay_1", "feedback")).toBe(0.71);
      expect(world.getProp("the_dubspace", "next_seq")).toBe(3);
      expect(world.replay("the_dubspace", 1, 1).map((entry) => entry.seq)).toEqual([1]);
      expect(world.replay("the_dubspace", 2, 10).map((entry) => [entry.seq, entry.applied_ok])).toEqual([
        [2, false]
      ]);
    } finally {
      harness.cleanup();
    }
  });

  it("records behavior failures while rolling back behavior mutations", async () => {
    const harness = make();
    try {
      const world = harness.world;
      installFailureFixture(world);
      const session = world.auth("guest:conf-fail");
      const applied = await callInDubspace(world, session.id, "mutate-fail", message(session.actor, "delay_1", "conf_mutate_then_fail", ["discarded"]));

      expect(applied.op).toBe("applied");
      if (applied.op === "applied") {
        expect(applied.seq).toBe(1);
        expect(applied.observations).toHaveLength(1);
        expect(applied.observations[0]).toMatchObject({ type: "$error", code: "E_CONF_FAIL" });
      }
      expect(world.propOrNull("delay_1", "conf_failed_value")).toBeNull();
      expect(world.getProp("the_dubspace", "next_seq")).toBe(2);
      expect(world.replay("the_dubspace", 1, 10)).toMatchObject([{ seq: 1, applied_ok: false, error: { code: "E_CONF_FAIL" } }]);
    } finally {
      harness.cleanup();
    }
  });

  it("keeps direct observations live-only while sequenced observations are replayable", async () => {
    const harness = make();
    try {
      const world = harness.world;
      const session = world.auth("guest:conf-direct");
      const preview = await callInDubspace(world, session.id, "preview", message(session.actor, "the_dubspace", "preview_control", ["delay_1", "feedback", 0.42]));
      expect(preview.op).toBe("result");
      if (preview.op === "result") expect(preview.observations[0].type).toBe("gesture_progress");
      expect(world.getProp("delay_1", "feedback")).toBe(0.35);
      expect(world.replay("the_dubspace", 1, 10)).toEqual([]);

      const sequenced = await callInDubspace(world, session.id, "apply", message(session.actor, "the_dubspace", "set_control", ["delay_1", "feedback", 0.42]));
      expect(sequenced.op).toBe("applied");
      expect(world.getProp("delay_1", "feedback")).toBe(0.42);
      expect(world.replay("the_dubspace", 1, 10).map((entry) => entry.message.verb)).toEqual(["set_control"]);
    } finally {
      harness.cleanup();
    }
  });

  it("bridges remote property reads, writes, and CALL_VERB", async () => {
    const homeHarness = make();
    const remoteHarness = make();
    try {
      const home = homeHarness.world;
      const remote = remoteHarness.world;
      const session = home.auth("guest:conf-cross-host");
      const worlds = new Map<string, WooWorld>([
        ["home", home],
        ["remote", remote]
      ]);
      const routes = new Map<ObjRef, string>([["conf_remote_box", "remote"]]);
      home.setExecutorContext(new LocalExecutorContext("home", worlds, routes));
      remote.setExecutorContext(new LocalExecutorContext("remote", worlds, routes));

      remote.createObject({ id: "conf_remote_box", name: "Remote Box", parent: "$thing", owner: "$wiz" });
      remote.defineProperty("conf_remote_box", {
        name: "value",
        defaultValue: "from remote",
        owner: "$wiz",
        perms: "rw",
        typeHint: "str"
      });
      remote.addVerb(
        "conf_remote_box",
        bytecodeVerb("value", {
          literals: ["conf_remote_box", "value"],
          num_locals: 0,
          max_stack: 2,
          version: 1,
          ops: [["PUSH_LIT", 0], ["PUSH_LIT", 1], ["GET_PROP"], ["RETURN"]]
        })
      );

      home.createObject({ id: "conf_local_reader", name: "Local Reader", parent: "$thing", owner: "$wiz" });
      home.addVerb(
        "conf_local_reader",
        bytecodeVerb("read_remote", {
          literals: ["conf_remote_box", "value"],
          num_locals: 0,
          max_stack: 2,
          version: 1,
          ops: [["PUSH_LIT", 0], ["PUSH_LIT", 1], ["CALL_VERB", 0], ["RETURN"]]
        })
      );
      const ctx: CallContext = {
          world: home,
          space: "the_dubspace",
          seq: 1,
          session: null,
          actor: session.actor,
        player: session.actor,
        caller: "#-1",
        callerPerms: session.actor,
        progr: session.actor,
        thisObj: "conf_local_reader",
        verbName: "read_remote",
        definer: "conf_local_reader",
        message: message(session.actor, "conf_local_reader", "read_remote", []),
        observations: [],
        observe: () => {}
      };
      expect(await home.getPropChecked("$wiz", "conf_remote_box", "value")).toBe("from remote");
      expect(await home.dispatch(ctx, "conf_local_reader", "read_remote", [])).toBe("from remote");

      home.createObject({ id: "conf_local_writer", name: "Local Writer", parent: "$thing", owner: "$wiz" });
      home.addVerb(
        "conf_local_writer",
        bytecodeVerb("write_remote", {
          literals: ["conf_remote_box", "value", "changed", null],
          num_locals: 0,
          max_stack: 3,
          version: 1,
          ops: [["PUSH_LIT", 0], ["PUSH_LIT", 1], ["PUSH_LIT", 2], ["SET_PROP"], ["PUSH_LIT", 3], ["RETURN"]]
        })
      );
      const written = await home.directCall("conf-cross-host-write", session.actor, "conf_local_writer", "write_remote", []);
      expect(written.op).toBe("result");
      expect(remote.getProp("conf_remote_box", "value")).toBe("changed");
    } finally {
      remoteHarness.cleanup();
      homeHarness.cleanup();
    }
  });

  it("moves objects across hosts by updating owner location and container mirrors", async () => {
    // Pure substrate test: only $space / $thing / $actor (all in core). Skip
    // bundled catalogs so the three-world harness setup doesn't dominate the
    // 30s budget — without this it spends ~12s in createWorld() before the
    // test body starts.
    const homeHarness = make({ catalogs: false });
    const roomAHarness = make({ catalogs: false });
    const roomBHarness = make({ catalogs: false });
    try {
      const home = homeHarness.world;
      const roomA = roomAHarness.world;
      const roomB = roomBHarness.world;
      const session = home.auth("guest:conf-cross-host-move");
      const actor = session.actor;
      const worlds = new Map<string, WooWorld>([
        ["home", home],
        ["room-a", roomA],
        ["room-b", roomB]
      ]);
      const routes = new Map<ObjRef, string>([
        [actor, "home"],
        ["conf_satchel", "home"],
        ["conf_room_a", "room-a"],
        ["conf_room_b", "room-b"]
      ]);
      home.setExecutorContext(new LocalExecutorContext("home", worlds, routes));
      roomA.setExecutorContext(new LocalExecutorContext("room-a", worlds, routes));
      roomB.setExecutorContext(new LocalExecutorContext("room-b", worlds, routes));

      roomA.createObject({ id: "conf_room_a", name: "Room A", parent: "$space", owner: "$wiz" });
      roomB.createObject({ id: "conf_room_b", name: "Room B", parent: "$space", owner: "$wiz" });
      home.createObject({ id: "conf_satchel", name: "Satchel", parent: "$thing", owner: "$wiz", location: "conf_room_a" });
      roomA.mirrorContents("conf_room_a", "conf_satchel", true);

      await roomA.moveObjectChecked("conf_satchel", actor);
      expect(home.object("conf_satchel").location).toBe(actor);
      expect(roomA.object("conf_room_a").contents.has("conf_satchel")).toBe(false);
      expect(home.object(actor).contents.has("conf_satchel")).toBe(true);

      await roomB.moveObjectChecked("conf_satchel", "conf_room_b");
      expect(home.object("conf_satchel").location).toBe("conf_room_b");
      expect(home.object(actor).contents.has("conf_satchel")).toBe(false);
      expect(roomB.object("conf_room_b").contents.has("conf_satchel")).toBe(true);
    } finally {
      roomBHarness.cleanup();
      roomAHarness.cleanup();
      homeHarness.cleanup();
    }
  });

  it("moves chat actors across room hosts with presence and contents mirrors", async () => {
    // Needs $guest (chat) + the_chatroom / the_deck / the_hot_tub (demoworld).
    // Trim everything else so the three-world harness fits comfortably under
    // the 30s budget on a busy `npm test` run.
    const harnessOpts = { catalogs: ["chat", "demoworld"] as const };
    const homeHarness = make(harnessOpts);
    const roomAHarness = make(harnessOpts);
    const roomBHarness = make(harnessOpts);
    try {
      const home = homeHarness.world;
      const roomA = roomAHarness.world;
      const roomB = roomBHarness.world;
      const session = home.auth("guest:conf-cross-host-room-exit");
      const actor = session.actor;
      const worlds = new Map<string, WooWorld>([
        ["home", home],
        ["room-a", roomA],
        ["room-b", roomB]
      ]);
      const routes = new Map<ObjRef, string>([
        [actor, "home"],
        ["the_chatroom", "room-a"],
        ["the_deck", "room-b"],
        ["the_hot_tub", "room-b"]
      ]);
      home.setExecutorContext(new LocalExecutorContext("home", worlds, routes));
      const roomABridge = new LocalExecutorContext("room-a", worlds, routes);
      const roomBBridge = new LocalExecutorContext("room-b", worlds, routes);
      roomA.setExecutorContext(roomABridge);
        roomB.setExecutorContext(roomBBridge);

        roomA.createObject({ id: actor, name: actor, parent: "$guest", owner: "$wiz" });
        home.sessions.get(session.id)!.activeScope = "the_chatroom";
        roomA.ensureSessionForActor(session.id, actor, "guest").activeScope = "the_chatroom";
        home.setActorPresence(actor, "the_chatroom", true);
      roomA.setActorPresence(actor, "the_chatroom", true);
      roomA.setSpaceSubscriber("the_chatroom", actor, true);

      // Witness in the source room; should see Alice's "left" but never the
      // destination-room "entered" event when she walks out.
      const witnessSession = home.auth("guest:conf-cross-host-witness");
      const witness = witnessSession.actor;
      routes.set(witness, "home");
      roomA.createObject({ id: witness, name: witness, parent: "$guest", owner: "$wiz" });
      home.sessions.get(witnessSession.id)!.activeScope = "the_chatroom";
      roomA.ensureSessionForActor(witnessSession.id, witness, "guest").activeScope = "the_chatroom";
      roomA.setSpaceSubscriber("the_chatroom", witness, true, witnessSession.id);

      const moveEffects: DeferredHostEffect[] = [];
        const moved = await roomA.directCall("walk-se", actor, "the_chatroom", "southeast", [], {
          sessionId: session.id,
          deferHostEffect: (effect) => moveEffects.push(effect)
        });
      expect(moved.op).toBe("result");
      if (moved.op === "result") {
        expect(moved.result).toMatchObject({ room: "the_deck", look_deferred: true });
      }
        expect(moveEffects.map((effect) => effect.kind)).toEqual(["actor_presence", "move_object", "actor_presence", "space_subscriber"]);
      await home.applyDeferredHostEffects(moveEffects);
      expect(roomABridge.contentsCalls.get("the_deck") ?? 0).toBe(0);
      expect(home.object(actor).location).toBe("the_deck");
      expect(home.allLocationsForActor(actor)).toEqual(["the_deck"]);
      expect(roomA.getProp("the_chatroom", "subscribers")).not.toContain(actor);
      expect(roomB.getProp("the_deck", "subscribers")).toContain(actor);
      expect(roomB.object("the_deck").contents.has(actor)).toBe(true);

      // Audience filtering: witness in source room must see "left" but not
      // "entered" (destination-room observation must not bleed back).
      if (moved.op === "result") {
        const observations = moved.observations ?? [];
        const audiences = moved.observationAudiences ?? [];
        const leftIdx = observations.findIndex((o) => o.type === "left");
        const enteredIdx = observations.findIndex((o) => o.type === "entered");
        expect(leftIdx).toBeGreaterThanOrEqual(0);
        expect(enteredIdx).toBeGreaterThanOrEqual(0);
        expect(audiences[leftIdx]).toContain(witness);
        expect(audiences[enteredIdx] ?? []).not.toContain(witness);
        }

        const tubEffects: DeferredHostEffect[] = [];
        roomB.ensureSessionForActor(session.id, actor, "guest").activeScope = "the_deck";
        const enterTub = await roomB.directCall("enter-tub", actor, "the_hot_tub", "enter", [], {
          sessionId: session.id,
          deferHostEffect: (effect) => tubEffects.push(effect)
        });
      expect(enterTub.op).toBe("result");
      if (enterTub.op === "result") expect(enterTub.result).toMatchObject({ room: "the_hot_tub", look_deferred: true });
      expect(tubEffects.map((effect) => effect.kind)).toEqual(["actor_presence", "move_object", "actor_presence"]);
      await home.applyDeferredHostEffects(tubEffects);
      expect(home.allLocationsForActor(actor)).toEqual(["the_hot_tub"]);
      expect(roomB.getProp("the_deck", "subscribers")).not.toContain(actor);
      expect(roomB.getProp("the_hot_tub", "subscribers")).toContain(actor);
      expect(roomB.object("the_deck").contents.has(actor)).toBe(false);
      expect(roomB.object("the_hot_tub").contents.has(actor)).toBe(true);

      const tubOutEffects: DeferredHostEffect[] = [];
      const tubOut = await roomB.directCall("tub-out", actor, "the_hot_tub", "out", [], {
        sessionId: session.id,
        deferHostEffect: (effect) => tubOutEffects.push(effect)
      });
      expect(tubOut.op).toBe("result");
      await home.applyDeferredHostEffects(tubOutEffects);
      expect(home.allLocationsForActor(actor)).toEqual(["the_deck"]);
      expect(roomB.getProp("the_deck", "subscribers")).toContain(actor);
      expect(roomB.getProp("the_hot_tub", "subscribers")).not.toContain(actor);

      const westEffects: DeferredHostEffect[] = [];
      const west = await roomB.directCall("walk-west", actor, "the_deck", "west", [], {
        sessionId: session.id,
        deferHostEffect: (effect) => westEffects.push(effect)
      });
      expect(west.op).toBe("result");
      if (west.op === "result") {
        expect(west.result).toMatchObject({ room: "the_chatroom", look_deferred: true });
      }
        expect(westEffects.map((effect) => effect.kind)).toEqual(["actor_presence", "move_object", "actor_presence", "space_subscriber"]);
      await home.applyDeferredHostEffects(westEffects);
      expect(roomBBridge.contentsCalls.get("the_chatroom") ?? 0).toBe(0);
      expect(home.object(actor).location).toBe("the_chatroom");
      expect(home.allLocationsForActor(actor)).toEqual(["the_chatroom"]);
      expect(roomA.getProp("the_chatroom", "subscribers")).toContain(actor);
      expect(roomB.getProp("the_deck", "subscribers")).not.toContain(actor);
      if (west.op === "result") {
        const observations = west.observations ?? [];
        const audiences = west.observationAudiences ?? [];
        const enteredIdx = observations.findIndex((o) => o.type === "entered");
        expect(enteredIdx).toBeGreaterThanOrEqual(0);
        expect(audiences[enteredIdx]).toContain(witness);
        expect(observations.find((o) => o.type === "looked" && o.room === "the_chatroom")).toBeUndefined();
      }

      const look = await roomA.directCall("look-after-west", actor, "the_chatroom", "look", [], { sessionId: session.id });
      expect(look.op).toBe("result");
      if (look.op === "result") {
        const looked = look.observations.find((o) => o.type === "looked" && o.room === "the_chatroom");
        expect(looked).toMatchObject({
          look: {
            roster: expect.arrayContaining([expect.objectContaining({ id: actor })])
          }
        });
      }
    } finally {
      roomBHarness.cleanup();
      roomAHarness.cleanup();
      homeHarness.cleanup();
    }
  });

  it("ignores legacy subscribers when building an embodied room roster", async () => {
    const homeHarness = make();
    const roomHarness = make();
    try {
      const home = homeHarness.world;
      const roomHost = roomHarness.world;
      // These rows model an old subscriber mirror with no body placement.
      // In the v2 presence model they are live-audience hints at most; they
      // must not make actors appear in an embodied room roster.
      const live1 = home.auth("guest:conf-batch-1").actor;
      const live2 = home.auth("guest:conf-batch-2").actor;
      const live3 = home.auth("guest:conf-batch-3").actor;
      const worlds = new Map<string, WooWorld>([
        ["home", home],
        ["room", roomHost]
      ]);
      const routes = new Map<ObjRef, string>([
        [live1, "home"],
        [live2, "home"],
        [live3, "home"],
        ["conf_batch_room", "room"]
      ]);
      const homeBridge = new LocalExecutorContext("home", worlds, routes);
      const roomBridge = new LocalExecutorContext("room", worlds, routes);
      home.setExecutorContext(homeBridge);
      roomHost.setExecutorContext(roomBridge);

      roomHost.createObject({ id: "conf_batch_room", name: "Batch Room", parent: "$chatroom", owner: "$wiz" });
      roomHost.setProp("conf_batch_room", "subscribers", [live1, live2, live3]);
      roomHost.setProp("conf_batch_room", "features", ["$conversational"]);
      for (const actor of [live1, live2, live3]) {
        home.setActorPresence(actor, "conf_batch_room", true);
        home.object(actor).location = "conf_batch_room";
      }

      const who = await roomHost.directCall("batch-who", live1, "conf_batch_room", "who", []);
      expect(who.op).toBe("result");
      if (who.op === "result") {
        expect(who.result).toEqual([]);
      }
      expect(roomBridge.actorSessionLocationsBatchCalls.length).toBe(0);
      expect(roomBridge.actorSessionLocationsCalls).toBe(0);
    } finally {
      roomHarness.cleanup();
      homeHarness.cleanup();
    }
  });

  it("does not consult remote subscriber mirrors for embodied room roster fallback", async () => {
    const homeHarness = make();
    const roomHarness = make();
    try {
      const home = homeHarness.world;
      const roomHost = roomHarness.world;
      const live = home.auth("guest:conf-batch-fail-live").actor;
      const worlds = new Map<string, WooWorld>([
        ["home", home],
        ["room", roomHost]
      ]);
      const routes = new Map<ObjRef, string>([
        [live, "home"],
        ["conf_batch_fail_room", "room"]
      ]);
      const homeBridge = new LocalExecutorContext("home", worlds, routes);
      const roomBridge = new LocalExecutorContext("room", worlds, routes);
      home.setExecutorContext(homeBridge);
      roomHost.setExecutorContext(roomBridge);

      roomHost.createObject({ id: "conf_batch_fail_room", name: "Batch-Fail Room", parent: "$chatroom", owner: "$wiz" });
      roomHost.setProp("conf_batch_fail_room", "subscribers", [live]);
      roomHost.setProp("conf_batch_fail_room", "features", ["$conversational"]);
      home.setActorPresence(live, "conf_batch_fail_room", true);
      home.object(live).location = "conf_batch_fail_room";

      // Simulate the home host being unreachable. Roster construction should
      // not consult the legacy subscriber mirror at all, so no remote lookup
      // is attempted and the actor is not rendered as present.
      roomBridge.failBatchWith = { code: "E_TIMEOUT", message: "remote home unreachable" };

      const who = await roomHost.directCall("batch-fail-who", live, "conf_batch_fail_room", "who", []);
      expect(who.op).toBe("result");
      expect(roomHost.getProp("conf_batch_fail_room", "subscribers")).toEqual([live]);
      if (who.op === "result") expect(who.result).toEqual([]);
      expect(roomBridge.actorSessionLocationsBatchCalls.length).toBe(0);
      expect(roomBridge.actorSessionLocationsCalls).toBe(0);
    } finally {
      roomHarness.cleanup();
      homeHarness.cleanup();
    }
  });

  it("keeps legacy subscribers out of room roster and direct audiences", async () => {
    const homeHarness = make();
    const roomHarness = make();
    try {
      const home = homeHarness.world;
      const roomHost = roomHarness.world;
        const stale = home.auth("guest:conf-stale-subscriber").actor;
        const watcherSession = home.auth("guest:conf-live-subscriber");
        const watcher = watcherSession.actor;
      const worlds = new Map<string, WooWorld>([
        ["home", home],
        ["room", roomHost]
      ]);
      const routes = new Map<ObjRef, string>([
        [stale, "home"],
        [watcher, "home"],
        ["conf_scrub_room", "room"]
      ]);
      home.setExecutorContext(new LocalExecutorContext("home", worlds, routes));
      roomHost.setExecutorContext(new LocalExecutorContext("room", worlds, routes));

      roomHost.createObject({ id: "conf_scrub_room", name: "Scrub Room", parent: "$chatroom", owner: "$wiz" });
      roomHost.setProp("conf_scrub_room", "subscribers", [stale, watcher]);
      roomHost.setProp("conf_scrub_room", "features", ["$conversational"]);
      home.setActorPresence(watcher, "conf_scrub_room", true);
        // Isolation setup: this test is only about presence/subscriber mirror
        // repair, so location is direct-mutated instead of going through :enter.
        home.object(watcher).location = "conf_scrub_room";
        home.sessions.get(watcherSession.id)!.activeScope = "conf_scrub_room";

      const staleWho = await roomHost.directCall("stale-who", stale, "conf_scrub_room", "who", []);
      expect(staleWho.op).toBe("result");
      expect(roomHost.getProp("conf_scrub_room", "subscribers")).toEqual([stale, watcher]);

      const who = await roomHost.directCall("live-who", watcher, "conf_scrub_room", "who", []);
      expect(who.op).toBe("result");
      if (who.op === "result") {
        expect(who.result).toEqual([]);
        const observed = who.observations.find((obs) => obs.type === "who");
        expect(observed).toMatchObject({ roster: [] });
      }
    } finally {
      roomHarness.cleanup();
      homeHarness.cleanup();
    }
  });

  it("live_audience ignores expired and malformed session_subscribers rows", async () => {
    // Room presentation no longer repairs or reads the legacy subscribers
    // mirror. The live-audience primitive is the contract that matters for
    // delivery: only live session rows should be returned.
    const harness = make();
    try {
      const world = harness.world;
      const live = world.auth("guest:conf-session-scrub-live");
      world.createObject({ id: "conf_session_scrub_room", name: "Session Scrub Room", parent: "$chatroom", owner: "$wiz" });
      world.setProp("conf_session_scrub_room", "features", ["$conversational"]);
      const expiredAuth = world.auth("guest:conf-session-scrub-expired");
      const expired = world.sessions.get(expiredAuth.id);
      if (!expired) throw new Error("expected expired session in table");
      expired.expiresAt = Date.now() - 60_000;
      expired.lastDetachAt = Date.now() - 60_000;
      // Pre-populate: live row, expired-in-table row, malformed row, and
      // `legacy:` placeholder.
      world.setProp("conf_session_scrub_room", "session_subscribers", [
        { session: live.id, actor: live.actor },
        { session: expired.id, actor: expiredAuth.actor },
        { session: "", actor: "guest_blank" },
        { session: `legacy:${live.actor}`, actor: live.actor }
      ]);
      world.setProp("conf_session_scrub_room", "subscribers", [
        live.actor,
        expiredAuth.actor,
        "guest_blank"
      ]);
      world.setActorPresence(live.actor, "conf_session_scrub_room", true);
      world.object(live.actor).location = "conf_session_scrub_room";
      world.sessions.get(live.id)!.activeScope = "conf_session_scrub_room";

      const audience = await world.directCall("conf-session-audience", live.actor, "conf_session_scrub_room", "live_audience", []);
      expect(audience.op).toBe("result");
      if (audience.op === "result") expect(audience.result).toEqual([live.id]);

      // Sanity: when reapSession runs through removeSessionPresence first,
      // the session and its row both go away through the existing path.
      const reapedActor = "guest_reaped" as ObjRef;
      const reapedSession = "session-conf-reaped";
      world.createObject({ id: reapedActor, name: reapedActor, parent: "$guest", owner: "$wiz" });
      world.ensureSessionForActor(reapedSession, reapedActor, "guest", Date.now() + 60_000);
      world.setSpaceSubscriber("conf_session_scrub_room", reapedActor, true, reapedSession);
      const beforeReap = world.getProp("conf_session_scrub_room", "session_subscribers") as Array<{ session: string }>;
      expect(beforeReap.map((row) => row.session)).toContain(reapedSession);
      const reapedRecord = world.sessions.get(reapedSession);
      if (reapedRecord) {
        reapedRecord.expiresAt = Date.now() - 60_000;
        reapedRecord.lastDetachAt = Date.now() - 60_000;
      }
      world.reapExpiredSessions();
      const afterReap = world.getProp("conf_session_scrub_room", "session_subscribers") as Array<{ session: string }>;
      expect(afterReap.map((row) => row.session)).not.toContain(reapedSession);
    } finally {
      harness.cleanup();
    }
  });

  it("excludes vanished sessions from live_audience without relying on subscribers repair", async () => {
    // Production failure class: an MCP gateway session can vanish from the
    // in-memory map without a clean reap. Delivery must ignore that orphan
    // session row even if legacy subscribers and actor.location still mention
    // the actor.
    const harness = make();
    try {
      const world = harness.world;
      const watcher = world.auth("guest:conf-vanished-watcher");
      const stale = world.auth("guest:conf-vanished-stale");
      world.createObject({ id: "conf_vanished_room", name: "Vanished Room", parent: "$chatroom", owner: "$wiz" });
      world.setProp("conf_vanished_room", "features", ["$conversational"]);

      world.setSpaceSubscriber("conf_vanished_room", watcher.actor, true, watcher.id);
      world.setSpaceSubscriber("conf_vanished_room", stale.actor, true, stale.id);
      world.setActorPresence(watcher.actor, "conf_vanished_room", true);
      world.object(watcher.actor).location = "conf_vanished_room";
      world.sessions.get(watcher.id)!.activeScope = "conf_vanished_room";
      world.object(stale.actor).location = "conf_vanished_room";
      world.sessions.get(stale.id)!.activeScope = "conf_vanished_room";

      // Both subscribers in place, then the stale actor's session vanishes
      // out from under the world without a clean reap. `.location` stays.
      world.sessions.delete(stale.id);
      expect(world.object(stale.actor).location).toBe("conf_vanished_room");
      expect((world.getProp("conf_vanished_room", "subscribers") as ObjRef[]).sort()).toEqual([watcher.actor, stale.actor].sort());

      const audience = await world.directCall("conf-vanished-audience", watcher.actor, "conf_vanished_room", "live_audience", [], { sessionId: watcher.id });
      expect(audience.op, audience.op === "error" ? JSON.stringify(audience.error) : "").toBe("result");
      if (audience.op === "result") expect(audience.result).toEqual([watcher.id]);

      expect((world.getProp("conf_vanished_room", "subscribers") as ObjRef[]).sort()).toEqual([watcher.actor, stale.actor].sort());
      const remainingRows = world.getProp("conf_vanished_room", "session_subscribers") as Array<{ session: string; actor: string }>;
      expect(remainingRows.map((row) => row.actor).sort()).toEqual([watcher.actor, stale.actor].sort());
      expect(remainingRows.map((row) => row.session)).toContain(stale.id);
    } finally {
      harness.cleanup();
    }
  });

  it("resolves commands against a remote current room and cross-host room contents", async () => {
    const homeHarness = make();
    const roomHarness = make();
    try {
      const home = homeHarness.world;
      const roomHost = roomHarness.world;
      const session = home.auth("guest:conf-remote-command-match");
      const actor = session.actor;
      const worlds = new Map<string, WooWorld>([
        ["home", home],
        ["room", roomHost]
      ]);
      const routes = new Map<ObjRef, string>([
        [actor, "home"],
        ["conf_remote_room", "room"],
        ["conf_home_widget", "home"]
      ]);
      home.setExecutorContext(new LocalExecutorContext("home", worlds, routes));
      roomHost.setExecutorContext(new LocalExecutorContext("room", worlds, routes));

      roomHost.createObject({ id: "conf_remote_room", name: "Remote Room", parent: "$chatroom", owner: "$wiz" });
      roomHost.setProp("conf_remote_room", "subscribers", [actor]);
      roomHost.setProp("conf_remote_room", "features", ["$conversational"]);
      roomHost.setProp("conf_remote_room", "aliases", ["remote room"]);
      if (!roomHost.objects.has(actor)) roomHost.createObject({ id: actor, name: actor, parent: "$guest", owner: "$wiz" });
      roomHost.setActorPresence(actor, "conf_remote_room", true);

      home.object(actor).location = "conf_remote_room";
      home.sessions.get(session.id)!.activeScope = "conf_remote_room";
      home.setActorPresence(actor, "conf_remote_room", true);
      home.createObject({ id: "conf_home_widget", name: "Home Widget", parent: "$thing", owner: "$wiz" });
      home.object("conf_home_widget").location = "conf_remote_room";
      home.setProp("conf_home_widget", "aliases", ["widget"]);
      home.addVerb("conf_home_widget", {
        kind: "native",
        name: "ping",
        aliases: ["p*ing"],
        owner: "$wiz",
        perms: "rxd",
        arg_spec: {
          command: { dobj: "this", prep: "any", iobj: "any", args_from: [] }
        },
        source: "verb :ping() rxd { return \"pong\"; }",
        source_hash: "conf-remote-command-ping-seed",
        version: 1,
        line_map: {},
        native: "player_on_disfunc",
        direct_callable: true
      });
      expect(installVerb(home, "conf_home_widget", "ping", `verb :ping() rxd {
  return "pong";
}`, 1, { argSpec: { command: { dobj: "this", prep: "any", iobj: "any", args_from: [] } } }).ok).toBe(true);
      roomHost.mirrorContents("conf_remote_room", actor, true);
      roomHost.mirrorContents("conf_remote_room", "conf_home_widget", true);

      const parsedHere = await home.directCall("parse-remote-here", actor, "$match", "parse_command", ["look here", actor]);
      expect(parsedHere.op, parsedHere.op === "error" ? JSON.stringify(parsedHere.error) : "").toBe("result");
      if (parsedHere.op === "result") {
        expect(parsedHere.result).toMatchObject({ dobj: "conf_remote_room", dobjstr: "here" });
      }

      const parsedWidget = await home.directCall("parse-remote-widget", actor, "$match", "parse_command", ["look widget", actor]);
      expect(parsedWidget.op, parsedWidget.op === "error" ? JSON.stringify(parsedWidget.error) : "").toBe("result");
      if (parsedWidget.op === "result") {
        expect(parsedWidget.result).toMatchObject({ dobj: "conf_home_widget", dobjstr: "widget" });
      }

      const remoteVerb = await roomHost.directCall("match-remote-verb", actor, "$match", "match_verb", ["p", "conf_home_widget"]);
      expect(remoteVerb.op, remoteVerb.op === "error" ? JSON.stringify(remoteVerb.error) : "").toBe("result");
      if (remoteVerb.op === "result") {
        expect(remoteVerb.result).toMatchObject({ name: "ping", direct_callable: true });
      }

      const plan = await roomHost.directCall("plan-cross-host-widget", actor, "conf_remote_room", "command_plan", ["ping widget"]);
      expect(plan.op, plan.op === "error" ? JSON.stringify(plan.error) : "").toBe("result");
      if (plan.op === "result") {
        expect(plan.result).toMatchObject({ ok: true, route: "direct", target: "conf_home_widget", verb: "ping", args: [] });
      }

      const command = await home.command("command-cross-host-widget", session.id, "conf_remote_room", "ping widget");
      expect(command.op, command.op === "error" ? JSON.stringify(command.error) : "").toBe("result");
      if (command.op === "result") {
        expect(command.result).toBe("pong");
        expect((command as any).command).toMatchObject({ route: "direct", target: "conf_home_widget", verb: "ping", args: [] });
      }
    } finally {
      roomHarness.cleanup();
      homeHarness.cleanup();
    }
  });

  it("persists world state, sessions, logs, snapshots, and counters across restart", async () => {
    const harness = make();
    try {
      let world = harness.world;
      const session = world.auth("guest:conf-restart");
      await callInDubspace(world, session.id, "persisted-call", message(session.actor, "the_dubspace", "set_control", ["delay_1", "wet", 0.64]));
      const snapshot = world.saveSnapshot("the_dubspace");

      world = harness.restart();
      expect(world.getProp("delay_1", "wet")).toBe(0.64);
      expect(world.getProp("the_dubspace", "next_seq")).toBe(2);
      expect(world.replay("the_dubspace", 1, 10).map((entry) => entry.message.verb)).toEqual(["set_control"]);
      expect(world.latestSnapshot("the_dubspace")?.hash).toBe(snapshot.hash);
      expect(world.auth(`session:${session.id}`).actor).toBe(session.actor);

      const nextSession = world.auth("guest:conf-restart-next");
      expect(nextSession.id).not.toBe(session.id);
    } finally {
      harness.cleanup();
    }
  });

  it("reaps detached guest sessions and returns guest actors to the pool", async () => {
    const harness = make();
    try {
      const world = harness.world;
      const session = world.auth("guest:conf-reap");
      const actor = session.actor;
      await world.directCall("enter-chat", actor, "the_chatroom", "enter", []);
      world.setProp(actor, "description", "temporary");
      world.setProp(actor, "aliases", ["temp"]);
      world.attachSocket(session.id, "ws-1");
      world.detachSocket(session.id, "ws-1");
      const detachedAt = world.sessions.get(session.id)?.lastDetachAt ?? Date.now();

      expect(world.reapExpiredSessions(detachedAt + 60_001)).toEqual([session.id]);
      expect(world.sessions.has(session.id)).toBe(false);
      expect(world.hasPresence(actor, "the_dubspace")).toBe(false);
      expect(world.hasPresence(actor, "the_chatroom")).toBe(false);
      expect(world.getProp(actor, "description")).toBe("");
      expect(world.getProp(actor, "aliases")).toEqual([]);
      expect(world.object(actor).location).toBe("$nowhere");
      expect(world.auth("guest:conf-reuse").actor).toBe(actor);
    } finally {
      harness.cleanup();
    }
  });

  it("purges inactive guest actors without moving live guests", async () => {
    const harness = make();
    try {
      const world = harness.world;
      const stale = world.auth("guest:conf-purge-stale");
      const live = world.auth("guest:conf-purge-live");
      await world.directCall("enter-stale-chat", stale.actor, "the_chatroom", "enter", []);
      await world.directCall("enter-live-chat", live.actor, "the_chatroom", "enter", []);
      // Simulate a missed transport lifecycle close: the session row vanished,
      // but guest location and room presence rows were left durable.
      world.sessions.delete(stale.id);
      expect((world.getProp("the_chatroom", "subscribers") as ObjRef[]).sort()).toEqual([live.actor, stale.actor].sort());

      const result = world.purgeInactiveGuests();
      expect(result.reset_actors).not.toContain(live.actor);
      expect(world.object(stale.actor).location).toBe("$nowhere");
      expect(world.object(live.actor).location).toBe("the_chatroom");
      expect(world.contentsOf("the_chatroom")).toContain(live.actor);
      expect(world.contentsOf("the_chatroom")).not.toContain(stale.actor);
      expect(world.getProp("the_chatroom", "subscribers")).toEqual([live.actor]);
      const rows = world.getProp("the_chatroom", "session_subscribers") as Array<{ actor: string }>;
      expect(rows.map((row) => row.actor)).toEqual([live.actor]);
    } finally {
      harness.cleanup();
    }
  });

  it("repairs full host-local derived contents from object locations and persists the repair", () => {
    const harness = make({ catalogs: false });
    try {
      const world = harness.world;
      world.createObject({ id: "conf_repair_room", name: "Repair Room", parent: "$space", owner: "$wiz" });
      world.createObject({ id: "conf_repair_mug", name: "Repair Mug", parent: "$thing", owner: "$wiz", location: "conf_repair_room" });
      world.createObject({ id: "conf_repair_departed", name: "Departed Guest", parent: "$guest", owner: "$wiz", location: "$nowhere" });

      // Reproduce the prod failure shape: the member's authoritative location
      // points at the room, but the room's derived contents row is missing it
      // and still names objects that are absent or no longer in the room.
      const room = world.object("conf_repair_room");
      room.contents.clear();
      room.contents.add("conf_repair_missing_guest");
      room.contents.add("conf_repair_departed");
      world.object("$nowhere").contents.add("conf_repair_departed");
      world.markObjectChanged("conf_repair_room");
      world.markObjectChanged("$nowhere");

      const repaired = world.repairDerivedContentsIndex();
      expect(repaired).toMatchObject({
        repaired_containers: ["$nowhere", "conf_repair_room"],
        members_added: 1,
        missing_members_removed: 1
      });
      expect(repaired.members_removed).toBeGreaterThanOrEqual(3);
      expect(world.contentsOf("conf_repair_room")).toEqual(["conf_repair_mug"]);
      expect(world.contentsOf("$nowhere")).toEqual([]);

      const restarted = harness.restart();
      expect(restarted.contentsOf("conf_repair_room")).toEqual(["conf_repair_mug"]);
      expect(restarted.contentsOf("$nowhere")).toEqual([]);
    } finally {
      harness.cleanup();
    }
  });

  it("operator purge can reap stale guest sessions before guest TTL", async () => {
    const harness = make();
    try {
      const world = harness.world;
      const stale = world.auth("guest:conf-purge-stale-session");
      const live = world.auth("guest:conf-purge-live-session");
      await world.directCall("enter-stale-session-chat", stale.actor, "the_chatroom", "enter", [], { sessionId: stale.id });
      await world.directCall("enter-live-session-chat", live.actor, "the_chatroom", "enter", [], { sessionId: live.id });
      const now = Date.now();
      const staleSession = world.sessions.get(stale.id);
      expect(staleSession).toBeDefined();
      staleSession!.started = now - 120_000;
      staleSession!.expiresAt = now + 180_000;

      const result = world.purgeInactiveGuests(now, { staleGuestSessionMs: 60_000 });
      expect(result.stale_guest_sessions).toEqual([stale.id]);
      expect(result.reaped_sessions).toContain(stale.id);
      expect(result.reset_actors).toContain(stale.actor);
      expect(world.sessions.has(stale.id)).toBe(false);
      expect(world.object(stale.actor).location).toBe("$nowhere");
      expect(world.sessions.has(live.id)).toBe(true);
      expect(world.object(live.actor).location).toBe("the_chatroom");
      expect(world.contentsOf("the_chatroom")).toContain(live.actor);
      expect(world.contentsOf("the_chatroom")).not.toContain(stale.actor);
    } finally {
      harness.cleanup();
    }
  });

  it("omits disconnected guests from chat room roster even if contents are stale", async () => {
    const harness = make();
    try {
      const world = harness.world;
      const stale = world.auth("guest:conf-roster-stale");
      const live = world.auth("guest:conf-roster-live");
      await world.directCall("enter-stale-roster", stale.actor, "the_chatroom", "enter", [], { sessionId: stale.id });
      await world.directCall("enter-live-roster", live.actor, "the_chatroom", "enter", [], { sessionId: live.id });

      // Simulate the production failure mode: the physical room contents mirror
      // still names an old guest, but its session row has gone away.
      world.sessions.delete(stale.id);
      expect(world.contentsOf("the_chatroom")).toContain(stale.actor);

      const roster = await world.directCall("roster-stale-contents", live.actor, "the_chatroom", "room_roster", [], { sessionId: live.id });
      expect(roster.op).toBe("result");
      if (roster.op !== "result") return;
      const ids = (roster.result as Array<{ id: string }>).map((row) => row.id);
      expect(ids).toContain(live.actor);
      expect(ids).not.toContain(stale.actor);
    } finally {
      harness.cleanup();
    }
  });

  it("resumes delayed FORK work through a new sequenced frame", async () => {
    const harness = make();
    try {
      const world = harness.world;
      installForkFixture(world);
      const session = world.auth("guest:conf-fork");
      const scheduled = await callInDubspace(world, session.id, "fork", message(session.actor, "delay_1", "conf_schedule_mark", ["later"]));
      expect(scheduled.op).toBe("applied");
      expect(world.parkedTasks.size).toBe(1);
      expect(world.propOrNull("delay_1", "conf_forked")).toBeNull();

      const ran = await world.runDueTasks(Date.now() + 1);
      expect(ran).toHaveLength(1);
      expect(ran[0].frame?.op).toBe("applied");
      if (ran[0].frame?.op === "applied") {
        expect(ran[0].frame.seq).toBe(2);
        expect(ran[0].frame.message.verb).toBe("conf_mark");
        expect(ran[0].frame.observations[0].type).toBe("conf_fork_ran");
      }
      expect(world.getProp("delay_1", "conf_forked")).toBe("later");
      expect(world.replay("the_dubspace", 1, 10).map((entry) => entry.message.verb)).toEqual(["conf_schedule_mark", "conf_mark"]);
    } finally {
      harness.cleanup();
    }
  });

  it("persists READ parking across restart and resumes through a sequenced input frame", async () => {
    const harness = make();
    try {
      let world = harness.world;
      installReadFixture(world);
      const session = world.auth("guest:conf-read");
      const waiting = await callInDubspace(world, session.id, "read", message(session.actor, "delay_1", "conf_read_then_mark", []));
      expect(waiting.op).toBe("applied");
      expect(world.parkedTasks.size).toBe(1);

      world = harness.restart();
      expect(world.parkedTasks.size).toBe(1);
      const ran = await world.deliverInput(session.actor, "typed text");
      expect(ran?.frame?.op).toBe("applied");
      if (ran?.frame?.op === "applied") {
        expect(ran.frame.seq).toBe(2);
        expect(ran.frame.message.verb).toBe("$resume");
        expect(ran.frame.message.body?.kind).toBe("vm_read");
        expect(ran.frame.message.body?.input).toBe("typed text");
        expect(ran.frame.observations.map((obs) => obs.type)).toContain("conf_read_resumed");
      }
      expect(world.getProp("delay_1", "conf_read_value")).toBe("typed text");
      expect(world.replay("the_dubspace", 1, 10).map((entry) => entry.message.verb)).toEqual(["conf_read_then_mark", "$resume"]);
      expect(world.parkedTasks.size).toBe(0);
    } finally {
      harness.cleanup();
    }
  });

  it("compiles and installs source with optimistic version checks", async () => {
    const harness = make();
    try {
      const world = harness.world;
      const session = world.auth("guest:conf-authoring");
      const source = `verb :conf_set_feedback(value) rx {
  this.feedback = value;
  observe({ type: "conf_feedback", value: value, actor: actor });
  return value;
}`;
      const compiled = compileVerb(source);
      expect(compiled.ok).toBe(true);
      expect(installVerb(world, "delay_1", "conf_set_feedback", source, null).ok).toBe(true);
      const applied = await callInDubspace(world, session.id, "authored", message(session.actor, "delay_1", "conf_set_feedback", [0.83]));
      expect(applied.op).toBe("applied");
      if (applied.op === "applied") expect(applied.observations[0]).toMatchObject({ type: "conf_feedback", value: 0.83, actor: session.actor });
      expect(world.getProp("delay_1", "feedback")).toBe(0.83);
      expect(() => installVerb(world, "delay_1", "conf_set_feedback", source, null)).toThrow();
      expect(installVerb(world, "delay_1", "conf_set_feedback", source, 1).version).toBe(2);
    } finally {
      harness.cleanup();
    }
  });
});
