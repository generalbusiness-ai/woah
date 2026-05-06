import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createWorld } from "../../src/core/bootstrap";
import type { Message, ObjRef, TinyBytecode, VerbDef, WooValue } from "../../src/core/types";
import type { CallContext, HostBridge, MoveObjectResult, RoomSnapshot, ScopedObjectSummary, WooWorld } from "../../src/core/world";
import { CFObjectRepository } from "../../src/worker/cf-repository";
import { DirectoryDO } from "../../src/worker/directory-do";
import worker from "../../src/worker/index";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { PersistentObjectDO, type Env } from "../../src/worker/persistent-object-do";

class FakeSqlCursor {
  constructor(private readonly rows: Record<string, unknown>[]) {}

  toArray(): Record<string, unknown>[] {
    return this.rows;
  }

  [Symbol.iterator](): Iterator<Record<string, unknown>> {
    return this.rows[Symbol.iterator]();
  }
}

class FakeSqlStorage {
  constructor(private readonly db: DatabaseSync) {}

  exec(query: string, ...params: unknown[]): FakeSqlCursor {
    const stmt = this.db.prepare(query);
    const head = query.trim().split(/\s+/, 1)[0]?.toUpperCase();
    if (head === "SELECT" || head === "PRAGMA") {
      return new FakeSqlCursor(stmt.all(...(params as any[])) as Record<string, unknown>[]);
    }
    stmt.run(...(params as any[]));
    return new FakeSqlCursor([]);
  }
}

class FakeDurableObjectState {
  readonly id: { name: string };
  private readonly db = new DatabaseSync(":memory:");
  private transactionDepth = 0;
  private savepointCounter = 0;

  constructor(name = "world") {
    this.id = { name };
  }

  readonly storage = {
    sql: new FakeSqlStorage(this.db),
    transactionSync: <T>(fn: () => T): T => this.transactionSync(fn)
  };

  async blockConcurrencyWhile<T>(fn: () => T | Promise<T>): Promise<T> {
    return await fn();
  }

  acceptWebSocket(_ws: WebSocket): void {
    // Not needed for repository / REST-path tests.
  }

  getWebSockets(): WebSocket[] {
    return [];
  }

  close(): void {
    this.db.close();
  }

  private transactionSync<T>(fn: () => T): T {
    if (this.transactionDepth > 0) {
      const name = `fake_cf_sp_${++this.savepointCounter}`;
      this.db.exec(`SAVEPOINT ${name}`);
      try {
        const result = fn();
        this.db.exec(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (err) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
        this.db.exec(`RELEASE SAVEPOINT ${name}`);
        throw err;
      }
    }

    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth = 1;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.transactionDepth = 0;
    }
  }
}

class FakeDurableObjectNamespace {
  constructor(private readonly factory: (name: string) => { fetch(request: Request): Promise<Response> | Response }) {}

  idFromName(name: string): { name: string } {
    return { name };
  }

  get(id: { name: string }): { fetch(request: Request): Promise<Response> | Response } {
    return this.factory(id.name);
  }
}

type Harness = {
  world: WooWorld;
  restart: () => WooWorld;
  cleanup: () => void;
};

function makeCfHarness(): Harness {
  const state = new FakeDurableObjectState();
  let repo = new CFObjectRepository(state as unknown as DurableObjectState);
  let world = createWorld({ repository: repo });
  return {
    get world() {
      return world;
    },
    restart: () => {
      repo = new CFObjectRepository(state as unknown as DurableObjectState);
      world = createWorld({ repository: repo });
      return world;
    },
    cleanup: () => state.close()
  };
}

function message(actor: string, target: string, verb: string, args: WooValue[] = []): Message {
  return { actor, target, verb, args };
}

async function callInDubspace(
  world: ReturnType<typeof createWorld>,
  sessionId: string,
  requestId: string,
  request: Message
): Promise<ReturnType<typeof world.call>> {
  const sessionActor = world.sessions.get(sessionId)?.actor;
  if (sessionActor === request.actor && !world.hasPresence(sessionActor, "the_dubspace")) {
    const entered = await world.directCall(`enter-${requestId}`, sessionActor, "the_dubspace", "enter", []);
    if (entered.op === "error") return entered;
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
    source: `cf conformance ${name}`,
    source_hash: `cf-conformance-${name}`,
    version: 1,
    line_map: {},
    bytecode
  };
}

function installFailureFixture(world: WooWorld): void {
  world.addVerb(
    "delay_1",
    bytecodeVerb("cf_mutate_then_fail", {
      literals: ["cf_failed_value", "E_CF_FAIL"],
      num_locals: 0,
      max_stack: 3,
      version: 1,
      ops: [["PUSH_THIS"], ["PUSH_LIT", 0], ["PUSH_ARG", 0], ["SET_PROP"], ["PUSH_LIT", 1], ["RAISE"], ["PUSH_INT", 0], ["RETURN"]]
    })
  );
}

class FakeHostBridge implements HostBridge {
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

  async describeObject(_nameActor: ObjRef, readActor: ObjRef, objRef: ObjRef): Promise<{ name: WooValue | null; description: WooValue | null; aliases: WooValue | null }> {
    const world = this.worldFor(objRef);
    return {
      name: world.object(objRef).name,
      description: world.propOrNullForActor(readActor, objRef, "description"),
      aliases: world.propOrNullForActor(readActor, objRef, "aliases")
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

  async moveObject(objRef: ObjRef, targetRef: ObjRef): Promise<MoveObjectResult> {
    return await this.worldFor(objRef).moveObjectChecked(objRef, targetRef, { suppressMirrorHost: this.localHost });
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

  private worldFor(id: ObjRef): WooWorld {
    const host = this.routes.get(id);
    if (!host) throw new Error(`no route for ${id}`);
    const world = this.worlds.get(host);
    if (!world) throw new Error(`no world for ${host}`);
    return world;
  }
}

describe("CFObjectRepository production-shape coverage", () => {
  it("boots, persists, and reloads through the CF storage API shape", async () => {
    const harness = makeCfHarness();
    try {
      let world = harness.world;
      const session = world.auth("guest:cf-repo-reload");
      const applied = await callInDubspace(world, session.id, "cf-set-control", message(session.actor, "the_dubspace", "set_control", ["delay_1", "wet", 0.58]));
      expect(applied.op).toBe("applied");
      const snapshot = world.saveSnapshot("the_dubspace");

      world = harness.restart();
      expect(world.getProp("delay_1", "wet")).toBe(0.58);
      expect(world.getProp("the_dubspace", "next_seq")).toBe(2);
      expect(world.replay("the_dubspace", 1, 10).map((entry) => entry.message.verb)).toEqual(["set_control"]);
      expect(world.latestSnapshot("the_dubspace")?.hash).toBe(snapshot.hash);
      expect(world.verbInfo("the_chatroom", "enter").direct_callable).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it("uses CF nested transaction savepoints for behavior rollback", async () => {
    const harness = makeCfHarness();
    try {
      const world = harness.world;
      installFailureFixture(world);
      const session = world.auth("guest:cf-savepoint");
      const applied = await callInDubspace(world, session.id, "cf-fail", message(session.actor, "delay_1", "cf_mutate_then_fail", ["discarded"]));

      expect(applied.op).toBe("applied");
      if (applied.op === "applied") {
        expect(applied.seq).toBe(1);
        expect(applied.observations[0]).toMatchObject({ type: "$error", code: "E_CF_FAIL" });
      }
      expect(world.propOrNull("delay_1", "cf_failed_value")).toBeNull();
      expect(world.replay("the_dubspace", 1, 10)).toMatchObject([{ seq: 1, applied_ok: false, error: { code: "E_CF_FAIL" } }]);
    } finally {
      harness.cleanup();
    }
  });

  it("resolves commands against a remote current room with CF-backed hosts", async () => {
    const homeHarness = makeCfHarness();
    const roomHarness = makeCfHarness();
    try {
      const home = homeHarness.world;
      const roomHost = roomHarness.world;
      const session = home.auth("guest:cf-remote-command-match");
      const actor = session.actor;
      const worlds = new Map<string, WooWorld>([
        ["home", home],
        ["room", roomHost]
      ]);
      const routes = new Map<ObjRef, string>([
        [actor, "home"],
        ["cf_remote_room", "room"],
        ["cf_home_widget", "home"]
      ]);
      home.setHostBridge(new FakeHostBridge("home", worlds, routes));
      roomHost.setHostBridge(new FakeHostBridge("room", worlds, routes));

      roomHost.createObject({ id: "cf_remote_room", name: "Remote Room", parent: "$chatroom", owner: "$wiz" });
      roomHost.setProp("cf_remote_room", "subscribers", [actor]);
      roomHost.setProp("cf_remote_room", "features", ["$conversational"]);
      roomHost.setProp("cf_remote_room", "aliases", ["remote room"]);
      if (!roomHost.objects.has(actor)) roomHost.createObject({ id: actor, name: actor, parent: "$guest", owner: "$wiz" });
        roomHost.setActorPresence(actor, "cf_remote_room", true);

        home.object(actor).location = "cf_remote_room";
        home.sessions.get(session.id)!.currentLocation = "cf_remote_room";
        home.setActorPresence(actor, "cf_remote_room", true);
        home.createObject({ id: "cf_home_widget", name: "Home Widget", parent: "$thing", owner: "$wiz" });
        home.object("cf_home_widget").location = "cf_remote_room";
      home.setProp("cf_home_widget", "aliases", ["widget"]);
      home.addVerb("cf_home_widget", {
        kind: "native",
        name: "ping",
        aliases: ["p*ing"],
        owner: "$wiz",
        perms: "rxd",
        arg_spec: {
          command: { dobj: "this", prep: "any", iobj: "any", args_from: [] }
        },
        source: "verb :ping() rxd { return \"pong\"; }",
        source_hash: "cf-remote-command-ping",
        version: 1,
        line_map: {},
        native: "describe",
        direct_callable: true
      });
      roomHost.mirrorContents("cf_remote_room", actor, true);
      roomHost.mirrorContents("cf_remote_room", "cf_home_widget", true);

      const parsedHere = await home.directCall("cf-parse-remote-here", actor, "$match", "parse_command", ["look here", actor]);
      expect(parsedHere.op).toBe("result");
      if (parsedHere.op === "result") expect(parsedHere.result).toMatchObject({ dobj: "cf_remote_room", dobjstr: "here" });

      const parsedWidget = await home.directCall("cf-parse-remote-widget", actor, "$match", "parse_command", ["look widget", actor]);
      expect(parsedWidget.op).toBe("result");
      if (parsedWidget.op === "result") expect(parsedWidget.result).toMatchObject({ dobj: "cf_home_widget", dobjstr: "widget" });

      const plan = await roomHost.directCall("cf-plan-cross-host-widget", actor, "cf_remote_room", "command_plan", ["ping widget"]);
      expect(plan.op).toBe("result");
      if (plan.op === "result") expect(plan.result).toMatchObject({ ok: true, route: "direct", target: "cf_home_widget", verb: "ping", args: [] });
    } finally {
      roomHarness.cleanup();
      homeHarness.cleanup();
    }
  });

  it("supports no-fallback object resolution for internal host lookups", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const env = { WOO_INTERNAL_SECRET: "cf-test-secret" };

    async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
      const request = await signInternalRequest(env, new Request(`https://woo.internal${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      }));
      const response = await directory.fetch(request);
      expect(response.ok).toBe(true);
      return await response.json() as Record<string, unknown>;
    }

    try {
      await post("/register-objects", { routes: [{ id: "the_hot_tub", host: "the_hot_tub", anchor: null }] });
      await expect(post("/resolve-object", { id: "the_hot_tub", fallback_host: "" }))
        .resolves.toMatchObject({ id: "the_hot_tub", host: "the_hot_tub" });
      await expect(post("/resolve-object", { id: "tub", fallback_host: "" }))
        .resolves.toMatchObject({ id: "tub", host: "" });
      await expect(post("/resolve-object", { id: "$space", fallback_host: "" }))
        .resolves.toMatchObject({ id: "$space", host: "world" });
    } finally {
      directoryState.close();
    }
  });

  it("plans enter commands on a routed room without treating aliases as object routes", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const wooStates = new Map<string, FakeDurableObjectState>();
    const wooObjects = new Map<string, PersistentObjectDO>();
    let env: Env;
    const wooNamespace = new FakeDurableObjectNamespace((name) => {
      let object = wooObjects.get(name);
      if (!object) {
        const state = new FakeDurableObjectState(name);
        wooStates.set(name, state);
        object = new PersistentObjectDO(state as unknown as DurableObjectState, env);
        wooObjects.set(name, object);
      }
      return object;
    });
    env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-command-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "chat,demoworld,pinboard",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: wooNamespace
    } as unknown as Env;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    async function post(path: string, body: Record<string, unknown>, session?: string): Promise<{ status: number; body: Record<string, unknown> }> {
      const response = await worker.fetch(new Request(`https://woo.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(session ? { authorization: `Session ${session}` } : {})
        },
        body: JSON.stringify(body)
      }), env, {});
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    }

    try {
      const auth = await post("/api/auth", { token: "guest:cf-command-alias" });
      expect(auth.status).toBe(200);
      const session = String(auth.body.session);

      expect((await post("/api/objects/the_chatroom/calls/enter", { args: [] }, session)).status).toBe(200);
      expect((await post("/api/objects/the_chatroom/calls/enter", { args: [] }, session)).status).toBe(200);
      expect((await post("/api/objects/the_chatroom/calls/southeast", { args: [] }, session)).status).toBe(200);

      const tubPlan = await post("/api/objects/the_deck/calls/command_plan", { args: ["enter tub"] }, session);
      expect(tubPlan.status).toBe(200);
      expect(tubPlan.body.result).toMatchObject({ ok: true, route: "direct", target: "the_hot_tub", verb: "enter", args: [] });

      const pinboardPlan = await post("/api/objects/the_deck/calls/command_plan", { args: ["enter pinboard"] }, session);
      expect(pinboardPlan.status).toBe(200);
      expect(pinboardPlan.body.result).toMatchObject({ ok: true, route: "direct", target: "the_pinboard", verb: "enter", args: [] });
    } finally {
      logSpy.mockRestore();
      directoryState.close();
      for (const state of wooStates.values()) state.close();
    }
  });

  it("smokes Worker-routed cross-host room, inventory, and pinboard calls", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const wooStates = new Map<string, FakeDurableObjectState>();
    const wooObjects = new Map<string, PersistentObjectDO>();
    let env: Env;
    const wooNamespace = new FakeDurableObjectNamespace((name) => {
      let object = wooObjects.get(name);
      if (!object) {
        const state = new FakeDurableObjectState(name);
        wooStates.set(name, state);
        object = new PersistentObjectDO(state as unknown as DurableObjectState, env);
        wooObjects.set(name, object);
      }
      return object;
    });
    env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-smoke-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "chat,demoworld,dubspace,help,note,pinboard,prog,taskspace,blocks-demo",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: wooNamespace
    } as unknown as Env;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    async function post(path: string, body: Record<string, unknown>, session?: string): Promise<{ status: number; body: Record<string, unknown> }> {
      const response = await worker.fetch(new Request(`https://woo.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(session ? { authorization: `Session ${session}` } : {})
        },
        body: JSON.stringify(body)
      }), env, {});
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    }

    try {
      const auth = await post("/api/auth", { token: "guest:cf-cross-host-smoke" });
      expect(auth.status).toBe(200);
      const session = String(auth.body.session);

      const enterChat = await post("/api/objects/the_chatroom/calls/enter", { args: [] }, session);
      expect(enterChat.status).toBe(200);
      expect(enterChat.body.observations).toContainEqual(expect.objectContaining({ type: "entered", room: "the_chatroom" }));
      const chatLook = await post("/api/objects/the_chatroom/calls/look", { args: [] }, session);
      expect(chatLook.status).toBe(200);
      expect(chatLook.body.result).toMatchObject({
        contents: expect.arrayContaining([expect.objectContaining({ id: "the_weather" })])
      });

      const goDeck = await post("/api/objects/the_chatroom/calls/southeast", { args: [] }, session);
      expect(goDeck.status).toBe(200);
      expect(goDeck.body.result).toMatchObject({ room: "the_deck", from: "the_chatroom", look_deferred: true });
      expect(goDeck.body.observations).toContainEqual(expect.objectContaining({ type: "entered", room: "the_deck", origin: "the_chatroom" }));
      const deckLook = await post("/api/objects/the_deck/calls/look", { args: [] }, session);
      expect(deckLook.status).toBe(200);
      expect(deckLook.body.result).toMatchObject({
        contents: expect.arrayContaining([expect.objectContaining({ id: "the_horoscope" })])
      });
      const deckState = await worker.fetch(new Request("https://woo.test/api/me", {
        headers: { authorization: `Session ${session}` }
      }), env, {});
      expect(deckState.ok).toBe(true);
      expect((await deckState.json() as Record<string, any>).session?.current_location).toBe("the_deck");

      const takeTowel = await post("/api/objects/the_deck/calls/take", { args: ["towel"] }, session);
      expect(takeTowel.status).toBe(200);
      expect(takeTowel.body.result).toMatchObject({ item: "the_towel" });
      expect(takeTowel.body.observations).toContainEqual(expect.objectContaining({ type: "taken", item: "the_towel" }));

      const enterTub = await post("/api/objects/the_hot_tub/calls/enter", { args: [] }, session);
      expect(enterTub.status).toBe(200);
      expect(enterTub.body.result).toMatchObject({ room: "the_hot_tub", look_deferred: true });
      expect(enterTub.body.observations).toContainEqual(expect.objectContaining({ type: "entered", room: "the_hot_tub", origin: "the_deck" }));
      const tubState = await worker.fetch(new Request("https://woo.test/api/me", {
        headers: { authorization: `Session ${session}` }
      }), env, {});
      expect(tubState.ok).toBe(true);
      expect((await tubState.json() as Record<string, any>).session?.current_location).toBe("the_hot_tub");

      const dropTowel = await post("/api/objects/the_hot_tub/calls/drop", { args: ["towel"] }, session);
      expect(dropTowel.status).toBe(200);
      expect(dropTowel.body.result).toMatchObject({ item: "the_towel", room: "the_hot_tub" });
      expect(dropTowel.body.observations).toContainEqual(expect.objectContaining({ type: "dropped", item: "the_towel", room: "the_hot_tub" }));

      const enterPinboard = await post("/api/objects/the_pinboard/calls/enter", { args: [] }, session);
      expect(enterPinboard.status).toBe(200);
      expect(enterPinboard.body.observations).toContainEqual(expect.objectContaining({ type: "pinboard_entered", board: "the_pinboard" }));

      const addNote = await post("/api/objects/the_pinboard/calls/add_note", {
        id: "cf-pinboard-add-smoke",
        space: "the_pinboard",
        args: ["CF smoke note", "blue", 12, 24, 160, 90]
      }, session);
      expect(addNote.status).toBe(200);
      expect(addNote.body).toMatchObject({ op: "applied", space: "the_pinboard" });
      const added = (addNote.body.observations as any[]).find((obs) => obs?.type === "note_added");
      expect(added).toMatchObject({ type: "note_added", board: "the_pinboard" });
      const pin = String(added.note.id);
      expect(added.note).toMatchObject({ id: pin, text: "CF smoke note", color: "blue", x: 12, y: 24, w: 160, h: 90 });

      const moveNote = await post("/api/objects/the_pinboard/calls/move_pin", {
        id: "cf-pinboard-move-smoke",
        space: "the_pinboard",
        args: [pin, 80, 96]
      }, session);
      expect(moveNote.status).toBe(200);
      expect(moveNote.body.observations).toContainEqual(expect.objectContaining({ type: "pin_moved", pin, x: 80, y: 96 }));

      const editNote = await post(`/api/objects/${encodeURIComponent(pin)}/calls/set_text`, {
        id: "cf-pinboard-edit-smoke",
        space: "the_pinboard",
        args: [["CF smoke edited"]]
      }, session);
      expect(editNote.status).toBe(200);
      expect(editNote.body.observations).toContainEqual(expect.objectContaining({ type: "note_edited", note: pin, text: ["CF smoke edited"] }));

      const listed = await post("/api/objects/the_pinboard/calls/list_notes", { args: [] }, session);
      expect(listed.status).toBe(200);
      expect(listed.body.result).toContainEqual(expect.objectContaining({ id: pin, text: ["CF smoke edited"], color: "blue", x: 80, y: 96 }));
    } finally {
      logSpy.mockRestore();
      directoryState.close();
      for (const state of wooStates.values()) state.close();
    }
  });

  it("serves gateway state when a cold remote host state request stalls", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    let gateway: PersistentObjectDO;
    const stalledHost = {
      fetch: async () => await new Promise<Response>(() => {})
    };
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-cold-state-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "chat,demoworld,pinboard",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: new FakeDurableObjectNamespace((name) => {
        if (name === "world") return gateway;
        return stalledHost;
      })
    } as unknown as Env;
    gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });

    try {
      const auth = await gateway.fetch(new Request("https://woo.test/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "wizard:cf-cold-state-token" })
      }));
      expect(auth.ok).toBe(true);
      const { session } = await auth.json() as { session: string };

      const state = await Promise.race([
        gateway.fetch(new Request("https://woo.test/api/state", {
          headers: { authorization: `Session ${session}` }
        })),
        new Promise<Response>((_, reject) => setTimeout(() => reject(new Error("gateway /api/state did not return")), 4_000))
      ]);
      expect(state.ok).toBe(true);
      const body = await state.json() as Record<string, unknown>;
      expect(body.objects).toBeTruthy();
      expect(body.object_routes).toEqual(expect.arrayContaining([expect.objectContaining({ host: "the_chatroom" })]));
      expect(logs.some((line) => line.includes("woo.metric") && line.includes("\"kind\":\"cross_host_rpc\"") && line.includes("\"route\":\"/__internal/state\"") && line.includes("\"status\":\"timeout\""))).toBe(true);
    } finally {
      logSpy.mockRestore();
      directoryState.close();
      gatewayState.close();
    }
  });

  it("keeps cached api state clock fresh", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-state-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: new FakeDurableObjectNamespace((name) => {
        throw new Error(`unexpected Woo DO ${name}`);
      })
    } as unknown as Env;
    const gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const auth = await gateway.fetch(new Request("https://woo.test/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "wizard:cf-state-token" })
      }));
      expect(auth.ok).toBe(true);
      const { session } = await auth.json() as { session: string };

      const first = await gateway.fetch(new Request("https://woo.test/api/state", {
        headers: { authorization: `Session ${session}` }
      }));
      expect(first.ok).toBe(true);
      expect((await first.json() as Record<string, unknown>).server_time).toBe(1_000_000);

      vi.setSystemTime(1_005_000);
      const second = await gateway.fetch(new Request("https://woo.test/api/state", {
        headers: { authorization: `Session ${session}` }
      }));
      expect(second.ok).toBe(true);
      expect((await second.json() as Record<string, unknown>).server_time).toBe(1_005_000);
    } finally {
      vi.useRealTimers();
      directoryState.close();
      gatewayState.close();
    }
  });

  it("ends REST sessions and removes Directory session routes", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-session-end-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      DIRECTORY: undefined,
      WOO: new FakeDurableObjectNamespace((name) => {
        throw new Error(`unexpected Woo DO ${name}`);
      })
    } as unknown as Env;
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, env);
    (env as any).DIRECTORY = new FakeDurableObjectNamespace((name) => {
      if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
      return directory;
    });
    const gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);
    const directoryHealth = async (): Promise<Record<string, unknown>> => {
      const request = await signInternalRequest(env, new Request("https://woo.internal/healthz"));
      const response = await directory.fetch(request);
      return await response.json() as Record<string, unknown>;
    };

    try {
      const auth = await gateway.fetch(new Request("https://woo.test/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "guest:cf-session-end" })
      }));
      expect(auth.ok).toBe(true);
      const { session } = await auth.json() as { session: string };
      expect(await directoryHealth()).toMatchObject({ sessions: 1 });

      const ended = await gateway.fetch(new Request("https://woo.test/api/session", {
        method: "DELETE",
        headers: { authorization: `Session ${session}` }
      }));
      expect(ended.ok).toBe(true);
      expect(await ended.json()).toMatchObject({ ok: true, session });
      expect(await directoryHealth()).toMatchObject({ sessions: 0 });

      const staleState = await gateway.fetch(new Request("https://woo.test/api/state", {
        headers: { authorization: `Session ${session}` }
      }));
      expect(staleState.status).toBe(401);
    } finally {
      directoryState.close();
      gatewayState.close();
    }
  });

  it("revoke_api_key removes Directory routes for sessions minted from that key", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-apikey-revoke-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      DIRECTORY: undefined,
      WOO: undefined
    } as unknown as Env;
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, env);
    (env as any).DIRECTORY = new FakeDurableObjectNamespace((name) => {
      if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
      return directory;
    });
    const gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);
    (env as any).WOO = new FakeDurableObjectNamespace((name) => {
      if (name !== "world") throw new Error(`unexpected Woo DO ${name}`);
      return gateway;
    });

    async function post(path: string, body: Record<string, unknown>, session?: string): Promise<{ status: number; body: Record<string, any> }> {
      const response = await worker.fetch(new Request(`https://woo.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(session ? { authorization: `Session ${session}` } : {})
        },
        body: JSON.stringify(body)
      }), env, {});
      return { status: response.status, body: await response.json() as Record<string, any> };
    }

    try {
      const auth = await post("/api/auth", { token: "wizard:cf-apikey-revoke-token" });
      expect(auth.status).toBe(200);
      const wizardSession = String(auth.body.session);

      const created = await post("/api/objects/%24system/calls/create_api_key", { args: ["$wiz", "revoke-route"] }, wizardSession);
      expect(created.status).toBe(200);
      const key = created.body.result as { id: string; secret: string };

      const apiAuth = await post("/api/auth", { token: `apikey:${key.id}:${key.secret}` });
      expect(apiAuth.status).toBe(200);
      const apiSession = String(apiAuth.body.session);

      const before = await post("/api/objects/%24system/calls/list_api_keys", { args: [] }, apiSession);
      expect(before.status).toBe(200);

      const revoked = await post("/api/objects/%24system/calls/revoke_api_key", { args: [key.id] }, wizardSession);
      expect(revoked.status).toBe(200);
      expect(revoked.body.result).toBe(true);

      const stale = await post("/api/objects/%24system/calls/list_api_keys", { args: [] }, apiSession);
      expect(stale.status).toBe(401);
      expect(stale.body.error).toMatchObject({ code: "E_NOSESSION" });
    } finally {
      directoryState.close();
      gatewayState.close();
    }
  });

  it("publishes Worker-installed self-hosted tap objects before serving host seeds", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    let gateway: PersistentObjectDO;
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-tap-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: new FakeDurableObjectNamespace((name) => {
        if (name !== "world") throw new Error(`unexpected Woo DO ${name}`);
        return gateway;
      })
    } as unknown as Env;
    gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const sha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const manifest = {
        name: "cf-route-demo",
        version: "1.0.0",
        spec_version: "v1",
        license: "MIT",
        classes: [
          {
            local_name: "$cf_route_room",
            parent: "$space",
            description: "Self-hosted space class installed through the Worker tap path.",
            properties: []
          }
        ],
        seed_hooks: [
          {
            kind: "create_instance",
            class: "$cf_route_room",
            as: "cf_route_room_1",
            name: "CF Route Room",
            description: "A self-hosted room installed from a mocked GitHub tap.",
            properties: {
              next_seq: 1,
              subscribers: [],
              last_snapshot_seq: 0,
              host_placement: "self"
            }
          }
        ]
      };
      const readme = `---\nname: cf-route-demo\nversion: 1.0.0\nspec_version: v1\nlicense: MIT\n---\n\n# CF Route Demo\n`;
      if (url === "https://api.github.com/repos/hughpyle/woo-libs/commits/cf-route-demo-v1.0.0") {
        return new Response(JSON.stringify({ sha }), { headers: { "content-type": "application/json" } });
      }
      if (url === `https://raw.githubusercontent.com/hughpyle/woo-libs/${sha}/catalogs/cf-route-demo/manifest.json`) {
        return new Response(JSON.stringify(manifest), { headers: { "content-type": "application/json" } });
      }
      if (url === `https://raw.githubusercontent.com/hughpyle/woo-libs/${sha}/catalogs/cf-route-demo/README.md`) {
        return new Response(readme, { headers: { "content-type": "text/markdown" } });
      }
      return new Response("", { status: 404, statusText: "Not Found" });
    });

    try {
      const auth = await gateway.fetch(new Request("https://woo.test/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "wizard:cf-tap-token" })
      }));
      expect(auth.ok).toBe(true);
      const authBody = await auth.json() as { session: string };

      const install = await gateway.fetch(new Request("https://woo.test/api/tap/install", {
        method: "POST",
        headers: {
          "authorization": `Session ${authBody.session}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          tap: "hughpyle/woo-libs",
          catalog: "cf-route-demo",
          ref: "cf-route-demo-v1.0.0"
        })
      }));
      expect(install.ok).toBe(true);
      const installBody = await install.json() as { op?: string; seq?: number };
      expect(installBody).toMatchObject({ op: "applied", seq: 1 });
      expect(logs.some((line) => line.includes("woo.catalog") && line.includes("\"kind\":\"tap_install\""))).toBe(true);

      const routeRequest = await signInternalRequest(env, new Request("https://woo.internal/resolve-object", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "cf_route_room_1", fallback_host: "world" })
      }));
      const routeResponse = await directory.fetch(routeRequest);
      expect(routeResponse.ok).toBe(true);
      await expect(routeResponse.json()).resolves.toMatchObject({ id: "cf_route_room_1", host: "cf_route_room_1" });

      const seedRequest = await signInternalRequest(env, new Request("https://woo.internal/__internal/host-seed", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-woo-host-key": "world"
        },
        body: JSON.stringify({ host: "cf_route_room_1" })
      }));
      const seedResponse = await gateway.fetch(seedRequest);
      expect(seedResponse.ok).toBe(true);
      const seed = await seedResponse.json() as { objects?: Array<{ id: string }> };
      expect(seed.objects?.map((obj) => obj.id)).toContain("cf_route_room_1");
    } finally {
      logSpy.mockRestore();
      vi.unstubAllGlobals();
      directoryState.close();
      gatewayState.close();
    }
  });
});
