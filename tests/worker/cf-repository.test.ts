import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { installVerb } from "../../src/core/authoring";
import { createWorld } from "../../src/core/bootstrap";
import { encodeEnvelope } from "../../src/core/shadow-envelope";
import {
  createShadowBrowserNode,
  createShadowBrowserRelayShim,
  openShadowBrowserScope,
  setShadowBrowserSessionToken,
  shadowBrowserEnvelope,
  type ShadowBrowserNode
} from "../../src/core/shadow-browser-node";
import { runShadowTurnCall, type ShadowTurnCall } from "../../src/core/shadow-turn-call";
import { shadowTurnKeyFromTranscript } from "../../src/core/turn-key";
import type { Message, ObjRef, TinyBytecode, VerbDef, WooValue } from "../../src/core/types";
import type { CallContext, HostBridge, HostObjectSummary, MoveObjectResult, RoomSnapshot, ScopedObjectSummary, WooWorld } from "../../src/core/world";
import { CFObjectRepository } from "../../src/worker/cf-repository";
import { DirectoryDO } from "../../src/worker/directory-do";
import worker from "../../src/worker/index";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { PersistentObjectDO, type Env } from "../../src/worker/persistent-object-do";

// These are production-shape Worker integration tests; under full-suite CPU
// contention they legitimately exceed Vitest's default 30s per-test timeout.
vi.setConfig({ testTimeout: 120_000 });

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

  async commandVerbCandidates(target: ObjRef, verbName: string): Promise<Array<{ name: string; direct_callable: boolean; arg_spec?: Record<string, WooValue> }>> {
    return this.worldFor(target).commandVerbCandidateSummaries(target, verbName);
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
  it("reserves the v2 session mint endpoint with shadow-local claims", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-v2-mint-token",
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

    try {
      const response = await gateway.fetch(new Request("https://woo.test/v2/session/mint", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "wizard:cf-v2-mint-token" })
      }));

      expect(response.status).toBe(200);
      const body = await response.json() as { token: string; claims: Record<string, unknown> };
      expect(body.token).toMatch(/^shadow-session:/);
      expect(body.claims).toMatchObject({
        actor: "$wiz",
        deployment: "shadow-local",
        rev: 1
      });
    } finally {
      directoryState.close();
      gatewayState.close();
    }
  });

  it("rejects v2 WebSocket upgrades without the required subprotocol", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-v2-subprotocol-token",
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

    try {
      const response = await gateway.fetch(new Request("https://woo.test/v2/turn-network/ws?token=wizard:cf-v2-subprotocol-token", {
        headers: { upgrade: "websocket" }
      }));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "E_PROTOCOL" }
      });
    } finally {
      directoryState.close();
      gatewayState.close();
    }
  });

  it("handles v2 turn requests through the Worker WebSocket message path", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-v2-message-token",
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
    const internals = gateway as unknown as {
      v2BrowserBySocket: Map<string, ShadowBrowserNode>;
      webSocketV2TurnNetworkMessage: (world: WooWorld, ws: WebSocket, message: string | ArrayBuffer) => Promise<void>;
    };
    class FakeWebSocket {
      readonly sent: string[] = [];
      send(data: string): void { this.sent.push(data); }
      close(): void {}
      deserializeAttachment(): unknown {
        return {
          protocol: "v2-turn-network",
          sessionId: session.id,
          actor: session.actor,
          socketId: "v2-message-socket",
          node: "browser:worker-test",
          token: "guest:cf-v2-message"
        };
      }
    }
    let session: ReturnType<WooWorld["auth"]>;

    try {
      const world = createWorld();
      session = world.auth("guest:cf-v2-message");
      world.createObject({ id: "cf_v2_message_box", name: "Worker V2 Box", parent: "$thing", owner: session.actor });
      world.defineProperty("cf_v2_message_box", { name: "value", defaultValue: 0, owner: session.actor, perms: "rw", typeHint: "int" });
      expect(installVerb(world, "cf_v2_message_box", "set_value", `verb :set_value(value) rxd {
        this.value = value;
        return this.value;
      }`, null).ok).toBe(true);
      const relay = createShadowBrowserRelayShim({
        node: "node:worker-test:relay",
        scope: "#-1",
        serialized: world.exportWorld()
      });
      const browser = createShadowBrowserNode({
        node: "browser:worker-test",
        scope: "#-1",
        actor: session.actor,
        session: session.id,
        relay
      });
      setShadowBrowserSessionToken(browser, "guest:cf-v2-message");
      await openShadowBrowserScope(browser, { preseed_catalog_pages: true });
      internals.v2BrowserBySocket.set("v2-message-socket", browser);
      const call: ShadowTurnCall = {
        kind: "woo.turn_call.shadow.v1",
        id: "cf-v2-message-value",
        route: "direct",
        scope: "#-1",
        session: session.id,
        actor: session.actor,
        target: "cf_v2_message_box",
        verb: "set_value",
        args: [67]
      };
      const planned = await runShadowTurnCall(browser.relay.commit_scope.serialized, call);
      const request = {
        kind: "woo.turn.exec.request.shadow.v1" as const,
        id: call.id,
        call,
        key: shadowTurnKeyFromTranscript(planned.transcript),
        expected: browser.relay.commit_scope.head,
        commit_policy: "execute_and_commit" as const
      };
      const encoded = encodeEnvelope(shadowBrowserEnvelope(browser, request.kind, request, "cf-v2-message-env"));
      const ws = new FakeWebSocket();

      await internals.webSocketV2TurnNetworkMessage(world, ws as unknown as WebSocket, encoded);

      const replies = ws.sent.map((frame) => JSON.parse(frame) as Record<string, any>);
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({ type: "woo.turn.exec.reply.shadow.v1", reply_to: "cf-v2-message-env" });
      expect(replies[0].body).toMatchObject({ ok: true, id: "cf-v2-message-value" });
      expect(replies[0].body.commit.serialized_after).toBeUndefined();
    } finally {
      directoryState.close();
      gatewayState.close();
    }
  });

  it("signals reset when Worker hibernation drops v2 socket-local relay state", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-v2-reset-token",
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
    const internals = gateway as unknown as {
      getWorld: (host?: string) => Promise<WooWorld>;
      webSocketV2TurnNetworkMessage: (world: WooWorld, ws: WebSocket, message: string | ArrayBuffer) => Promise<void>;
    };
    class FakeWebSocket {
      readonly sent: string[] = [];
      send(data: string): void { this.sent.push(data); }
      close(): void {}
      deserializeAttachment(): unknown {
        return {
          protocol: "v2-turn-network",
          sessionId: session.id,
          actor: session.actor,
          socketId: "v2-reset-socket",
          node: "browser:reset-test",
          token: "guest:cf-v2-reset"
        };
      }
    }
    let session: ReturnType<WooWorld["auth"]>;

    try {
      const world = await internals.getWorld("world");
      session = world.auth("guest:cf-v2-reset");
      const ws = new FakeWebSocket();
      await internals.webSocketV2TurnNetworkMessage(world, ws as unknown as WebSocket, "{}");

      expect(ws.sent).toHaveLength(1);
      expect(JSON.parse(ws.sent[0])).toMatchObject({
        type: "woo.transport.error.v1",
        body: { code: "E_RESET" }
      });
    } finally {
      directoryState.close();
      gatewayState.close();
    }
  });

  it("emits startup storage metrics before world init completes", async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");

    try {
      const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
      const env = {
        WOO_INITIAL_WIZARD_TOKEN: "cf-startup-metrics-token",
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

      const response = await gateway.fetch(new Request("https://woo.test/healthz"));
      expect(response.ok).toBe(true);

      const metrics = logs
        .filter((line) => line.startsWith("woo.metric "))
        .map((line) => JSON.parse(line.slice("woo.metric ".length)) as Record<string, unknown>);
      expect(metrics).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "startup_storage", phase: "cf_repository_migrate", host_key: "world" }),
        expect.objectContaining({ kind: "startup_storage", phase: "cf_repository_load", host_key: "world", stored: false }),
        expect.objectContaining({ kind: "startup_storage", phase: "cf_repository_save", host_key: "world" }),
        expect.objectContaining({ kind: "startup_storage", phase: "directory_schema", host_key: "directory" }),
        expect.objectContaining({ kind: "startup_storage", phase: "directory_register_objects", host_key: "directory", writes: 20 })
      ]));

      logs.length = 0;
      const restartedGateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);
      const restarted = await restartedGateway.fetch(new Request("https://woo.test/healthz"));
      expect(restarted.ok).toBe(true);
      const restartMetrics = logs
        .filter((line) => line.startsWith("woo.metric "))
        .map((line) => JSON.parse(line.slice("woo.metric ".length)) as Record<string, unknown>);
      expect(restartMetrics).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "startup_storage", phase: "cf_repository_load", host_key: "world", stored: true })
      ]));
      expect(restartMetrics).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "startup_storage", phase: "cf_repository_save", host_key: "world" })
      ]));
      // Cold-restart fingerprint: the gateway hashed the world's route set
      // against the persisted publish digest, found a match, and skipped
      // the directory_register_objects RPC entirely. The skip metric is
      // the observable signal; the absence of a register_objects metric
      // is the actual win (no signed fetch, no Directory transaction).
      expect(restartMetrics).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "startup_storage", phase: "directory_register_objects_skip", host_key: "world", routes: 20 })
      ]));
      expect(restartMetrics).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "startup_storage", phase: "directory_register_objects" })
      ]));
    } finally {
      logSpy.mockRestore();
      directoryState.close();
      gatewayState.close();
    }
  });

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

      const remoteRoomLook = await home.planCommand("cf-plan-remote-room-look-widget", session.id, "cf_remote_room", "look widget");
      expect(remoteRoomLook.op).toBe("result");
      if (remoteRoomLook.op === "result") {
        expect(remoteRoomLook.result).toMatchObject({ ok: true, route: "direct", target: "cf_remote_room", verb: "look_at", args: ["cf_home_widget"] });
      }
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

  it("bounds read-only cross-host fan-out during routed command planning", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const wooStates = new Map<string, FakeDurableObjectState>();
    const wooObjects = new Map<string, PersistentObjectDO>();
    let env: Env;
    let stallHotTub = false;
    const stalledHost = {
      fetch: async () => await new Promise<Response>(() => undefined)
    };
    const wooNamespace = new FakeDurableObjectNamespace((name) => {
      if (name === "the_hot_tub" && stallHotTub) return stalledHost;
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
      WOO_INITIAL_WIZARD_TOKEN: "cf-command-timeout-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "chat,demoworld,pinboard",
      WOO_HOST_READ_TIMEOUT_MS: "5000",
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
      const auth = await post("/api/auth", { token: "guest:cf-command-timeout" });
      expect(auth.status).toBe(200);
      const session = String(auth.body.session);
      expect((await post("/api/objects/the_chatroom/calls/enter", { args: [] }, session)).status).toBe(200);
      const goDeck = await post("/api/objects/the_chatroom/calls/southeast", { args: [] }, session);
      expect(goDeck.status, JSON.stringify(goDeck.body)).toBe(200);
      stallHotTub = true;
      env.WOO_HOST_READ_TIMEOUT_MS = "25";

      const planned = await Promise.race([
        post("/api/objects/the_deck/calls/command_plan", { args: ["enter tub"] }, session),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1000))
      ]);
      if (planned === "timeout") throw new Error("command_plan timed out");
      expect(planned).toMatchObject({ status: 200 });
      expect(planned.body.result).toMatchObject({
        ok: false,
        route: "huh",
        target: expect.any(String),
        verb: "huh",
        text: "enter tub",
        error: "I don't understand that."
      });
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
      const weatherLookCommand = await post("/api/objects/the_chatroom/calls/command", { args: ["look weather"] }, session);
      expect(weatherLookCommand.status).toBe(200);
      expect(weatherLookCommand.body.result).toMatchObject({ id: "the_weather" });
      expect(weatherLookCommand.body.observations).toContainEqual(expect.objectContaining({
        type: "looked",
        room: "the_chatroom",
        target: "the_weather"
      }));

      const goDeck = await post("/api/objects/the_chatroom/calls/southeast", { args: [] }, session);
      expect(goDeck.status).toBe(200);
      expect(goDeck.body.result).toMatchObject({ room: "the_deck", from: "the_chatroom", look_deferred: true });
      expect(goDeck.body.observations).toContainEqual(expect.objectContaining({ type: "entered", room: "the_deck", origin: "the_chatroom" }));
      const deckLook = await post("/api/objects/the_deck/calls/look", { args: [] }, session);
      expect(deckLook.status).toBe(200);
      expect(deckLook.body.result).toMatchObject({
        contents: expect.arrayContaining([expect.objectContaining({ id: "the_horoscope" })])
      });

      const gateway = wooObjects.get("world") as any;
      expect(gateway).toBeTruthy();
      const gatewayWorld = await gateway.getWorld("world") as WooWorld;
      const horoscopeRoute = gatewayWorld.objectRoutes().find((route) => route.id === "the_horoscope");
      expect(horoscopeRoute).toMatchObject({ host: "the_deck" });
      gateway.routeCache.set("the_horoscope", "world");
      gateway.publishedRoutes.set("the_horoscope", "world");
      const repairedHost = await gateway.resolveObjectHost("the_horoscope" as ObjRef, "world");
      expect(repairedHost).toBe("the_deck");
      expect(gateway.routeCache.get("the_horoscope")).toBe("the_deck");
      expect(gateway.publishedRoutes.get("the_horoscope")).toBe("the_deck");
      gateway.routeCache.set("the_horoscope", "world");
      gateway.publishedRoutes.set("the_horoscope", "world");
      const bridgeHost = await (gatewayWorld as any).hostBridge.hostForObject("the_horoscope" as ObjRef);
      expect(bridgeHost).toBe("the_deck");
      expect(gateway.routeCache.get("the_horoscope")).toBe("the_deck");
      expect(gateway.publishedRoutes.get("the_horoscope")).toBe("the_deck");
      const originalRegisterRoutes = gateway.registerRoutes.bind(gateway);
      gateway.routeCache.delete("the_horoscope");
      gateway.publishedRoutes.delete("the_horoscope");
      gateway.registerRoutes = async () => false;
      try {
        const localHost = await gateway.resolveObjectHost("the_horoscope" as ObjRef, "world");
        expect(localHost).toBe("the_deck");
        expect(gateway.routeCache.get("the_horoscope")).toBe("the_deck");
        expect(gateway.publishedRoutes.has("the_horoscope")).toBe(false);
      } finally {
        gateway.registerRoutes = originalRegisterRoutes;
      }

      const order = await post("/api/objects/the_horoscope/calls/order", { args: ["gemini"] }, session);
      expect(order.status).toBe(200);
      const orderId = String((order.body.result as { order_id: string }).order_id);
      const wizardAuth = await post("/api/auth", { token: "wizard:cf-smoke-token" });
      expect(wizardAuth.status).toBe(200);
      const wizardSession = String(wizardAuth.body.session);
      const deliver = await post("/api/objects/the_horoscope/calls/deliver", { args: [orderId, "Horoscope: Gemini", "The stars prefer bounded route tables."] }, wizardSession);
      expect(deliver.status).toBe(200);
      const deliveredNote = String((deliver.body.result as { note: string }).note);
      const lookDeliveredNote = await post("/api/objects/the_deck/calls/look_at", {
        id: "cf-look-delivered-note",
        space: "the_deck",
        args: [deliveredNote]
      }, session);
      expect(lookDeliveredNote.status).toBe(200);
      expect(lookDeliveredNote.body.result).toMatchObject({ id: deliveredNote });

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
        args: ["CF smoke edited"]
      }, session);
      expect(editNote.status).toBe(200);
      expect(editNote.body.observations).toContainEqual(expect.objectContaining({ type: "note_edited", note: pin, text: "CF smoke edited" }));

      const listed = await post("/api/objects/the_pinboard/calls/list_notes", { args: [] }, session);
      expect(listed.status).toBe(200);
      expect(listed.body.result).toContainEqual(expect.objectContaining({ id: pin, text: "CF smoke edited", color: "blue", x: 80, y: 96 }));
    } finally {
      logSpy.mockRestore();
      directoryState.close();
      for (const state of wooStates.values()) state.close();
    }
  });

  it("refreshes live host-scoped support classes from the gateway seed", async () => {
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
      WOO_INITIAL_WIZARD_TOKEN: "cf-host-refresh-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "chat,demoworld,note,blocks-demo",
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
      const guestAuth = await post("/api/auth", { token: "guest:cf-host-refresh" });
      expect(guestAuth.status).toBe(200);
      const guestSession = String(guestAuth.body.session);
      const enterChat = await post("/api/objects/the_chatroom/calls/enter", { args: [] }, guestSession);
      expect(enterChat.status).toBe(200);
      const goDeck = await post("/api/objects/the_chatroom/calls/southeast", { args: [] }, guestSession);
      expect(goDeck.status).toBe(200);

      const gatewayWorld = await (wooObjects.get("world") as any).getWorld("world") as WooWorld;
      const deckWorld = await (wooObjects.get("the_deck") as any).getWorld("the_deck") as WooWorld;
      expect(deckWorld.objects.has("$note")).toBe(true);
      expect(installVerb(deckWorld, "$note", "title", `verb :title() rxd {
  return this.name;
}`, deckWorld.ownVerb("$note", "title")?.version ?? null).ok).toBe(true);
      deckWorld.createObject({ id: "cf_live_deck_note", name: "Deck note", parent: "$note", owner: "$wiz", location: "$wiz", anchor: "the_deck" });
      deckWorld.setProp("cf_live_deck_note", "name", "Deck note");
      gatewayWorld.createObject({ id: "cf_live_deck_note", name: "Deck note", parent: "$note", owner: "$wiz", location: "$wiz", anchor: "the_deck" });
      gatewayWorld.setProp("cf_live_deck_note", "name", "Deck note");
      const staleTitle = await deckWorld.directCall("cf-live-note-stale", "$wiz", "cf_live_deck_note", "title", []);
      expect(staleTitle).toMatchObject({ op: "result", result: "Deck note" });

      expect(installVerb(gatewayWorld, "$note", "title", `verb :title() rxd {
  return "LIVE " + this.name;
}`, gatewayWorld.ownVerb("$note", "title")?.version ?? null).ok).toBe(true);
      const gatewaySeed = gatewayWorld.exportHostScopedWorld("the_deck");
      expect(gatewaySeed.objects.map((obj) => obj.id)).toContain("$note");
      expect(gatewaySeed.objects.find((obj) => obj.id === "$note")?.verbs.find((verb) => verb.name === "title")?.source).toContain("LIVE");

      const wizardAuth = await post("/api/auth", { token: "wizard:cf-host-refresh-token" });
      expect(wizardAuth.status).toBe(200);
      const refreshed = await post("/api/admin/refresh-host-seeds", { hosts: ["the_deck"] }, String(wizardAuth.body.session));
      expect(refreshed.status).toBe(200);
      expect(refreshed.body).toMatchObject({
        ok: true,
        refreshed: [expect.objectContaining({ host: "the_deck", changed: true })]
      });
      expect(deckWorld.objects.has("cf_live_deck_note")).toBe(true);
      expect(deckWorld.ownVerb("$note", "title")?.source).toContain("LIVE");
      const repairedTitle = await deckWorld.directCall("cf-live-note-repaired", "$wiz", "cf_live_deck_note", "title", []);
      expect(repairedTitle).toMatchObject({ op: "result", result: "LIVE Deck note" });

      const deckState = wooStates.get("the_deck");
      expect(deckState).toBeDefined();
      const reloadedDeck = new PersistentObjectDO(deckState as unknown as DurableObjectState, env);
      wooObjects.set("the_deck", reloadedDeck);
      const reloadedDeckWorld = await (reloadedDeck as any).getWorld("the_deck") as WooWorld;
      const reloadedTitle = await reloadedDeckWorld.directCall("cf-live-note-reloaded", "$wiz", "cf_live_deck_note", "title", []);
      expect(reloadedTitle).toMatchObject({ op: "result", result: "LIVE Deck note" });

      const second = await post("/api/admin/refresh-host-seeds", { hosts: ["missing_host", "the_deck"] }, String(wizardAuth.body.session));
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({
        ok: true,
        refreshed: [expect.objectContaining({ host: "the_deck", changed: false })],
        skipped: [expect.objectContaining({ host: "missing_host", reason: "unmatched_host" })]
      });
    } finally {
      logSpy.mockRestore();
      directoryState.close();
      for (const state of wooStates.values()) state.close();
    }
  });

  it("persists cold-load host seed repairs before a later refresh can consume them", async () => {
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
      WOO_INITIAL_WIZARD_TOKEN: "cf-cold-host-refresh-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "chat,demoworld,note,blocks-demo",
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
      const guestAuth = await post("/api/auth", { token: "guest:cf-cold-host-refresh" });
      expect(guestAuth.status).toBe(200);
      const guestSession = String(guestAuth.body.session);
      expect((await post("/api/objects/the_chatroom/calls/enter", { args: [] }, guestSession)).status).toBe(200);
      expect((await post("/api/objects/the_chatroom/calls/southeast", { args: [] }, guestSession)).status).toBe(200);

      const gatewayWorld = await (wooObjects.get("world") as any).getWorld("world") as WooWorld;
      const deckWorld = await (wooObjects.get("the_deck") as any).getWorld("the_deck") as WooWorld;
      expect(installVerb(deckWorld, "$note", "title", `verb :title() rxd {
  return this.name;
}`, deckWorld.ownVerb("$note", "title")?.version ?? null).ok).toBe(true);
      deckWorld.createObject({ id: "cf_cold_deck_note", name: "Cold note", parent: "$note", owner: "$wiz", location: "$wiz", anchor: "the_deck" });
      deckWorld.setProp("cf_cold_deck_note", "name", "Cold note");
      gatewayWorld.createObject({ id: "cf_cold_deck_note", name: "Cold note", parent: "$note", owner: "$wiz", location: "$wiz", anchor: "the_deck" });
      gatewayWorld.setProp("cf_cold_deck_note", "name", "Cold note");
      expect(installVerb(gatewayWorld, "$note", "title", `verb :title() rxd {
  return "LIVE " + this.name;
}`, gatewayWorld.ownVerb("$note", "title")?.version ?? null).ok).toBe(true);

      const deckState = wooStates.get("the_deck");
      expect(deckState).toBeDefined();
      const coldDeck = new PersistentObjectDO(deckState as unknown as DurableObjectState, env);
      wooObjects.set("the_deck", coldDeck);
      const coldDeckWorld = await (coldDeck as any).getWorld("the_deck") as WooWorld;
      expect(coldDeckWorld.ownVerb("$note", "title")?.source).toContain("LIVE");
      const coldTitle = await coldDeckWorld.directCall("cf-cold-note-repaired", "$wiz", "cf_cold_deck_note", "title", []);
      expect(coldTitle).toMatchObject({ op: "result", result: "LIVE Cold note" });

      const reloadedDeck = new PersistentObjectDO(deckState as unknown as DurableObjectState, env);
      wooObjects.set("the_deck", reloadedDeck);
      const reloadedDeckWorld = await (reloadedDeck as any).getWorld("the_deck") as WooWorld;
      const reloadedTitle = await reloadedDeckWorld.directCall("cf-cold-note-reloaded", "$wiz", "cf_cold_deck_note", "title", []);
      expect(reloadedTitle).toMatchObject({ op: "result", result: "LIVE Cold note" });
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

  it("falls back to actor-keyed delivery when audience_sessions has only stale session ids", async () => {
    // Regression: production accumulated dozens of stale entries in
    // `<space>.session_subscribers` (old `session-N` ids from the counter
    // generator, kept alive by absent-logout client reuse). The audience
    // computation legitimately filled `audience_sessions` from the index, but
    // every id resolved to a missing socket on the live gateway, so room-wide
    // events (`said`, `entered`, `left`) reached zero clients even though
    // `audience_actors` had live participants reachable through
    // `socketsByActor`. broadcastLiveEvent must fall through to the actor map
    // when none of the session ids deliver, so a polluted index does not
    // black-hole the broadcast.
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    let gateway: PersistentObjectDO;
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-broadcast-fallback-token",
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
    try {
      // Force world boot so internals (socketsByActor / socketsBySession) are
      // initialized before we reach into them. /healthz is the cheapest path.
      await gateway.fetch(new Request("https://woo.test/healthz"));

      type SentFrame = string;
      class FakeWebSocket { readyState = 1; readonly sent: SentFrame[] = []; send(data: string): void { this.sent.push(data); } }

      const liveActorWs = new FakeWebSocket();
      const internals = gateway as unknown as {
        socketsByActor: Map<ObjRef, Set<unknown>>;
        socketsBySession: Map<string, Set<unknown>>;
        broadcastLiveEvent: (
          world: WooWorld,
          frame: { op: "event"; observation: Record<string, unknown> },
          audience: ObjRef,
          audienceActors?: ObjRef[],
          audienceSessions?: string[],
          originator?: unknown
        ) => number;
        getWorld: (host?: string) => Promise<WooWorld>;
      };
      // Live participant has a socket on this DO, mapped only by actor.
      // No entry in socketsBySession for any of the stale ids the room's
      // session_subscribers would yield, mirroring the production state.
      internals.socketsByActor.set("guest_live_actor" as ObjRef, new Set([liveActorWs]));
      const world = await internals.getWorld("world");

      const observation = { type: "said", actor: "guest_live_actor", text: "hello", source: "the_chatroom", ts: Date.now() };
      const delivered = internals.broadcastLiveEvent(
        world,
        { op: "event", observation },
        "the_chatroom" as ObjRef,
        ["guest_live_actor" as ObjRef],
        ["session-stale-1", "session-stale-2", "session-stale-3"]
      );

      expect(delivered).toBe(1);
      expect(liveActorWs.sent).toHaveLength(1);
      expect(JSON.parse(liveActorWs.sent[0])).toEqual({ op: "event", observation });

      // Sanity check the positive case still works: when the session map
      // already covers the live participant, fallback isn't needed and the
      // session lookup delivers on its own (no double-send).
      liveActorWs.sent.length = 0;
      internals.socketsBySession.set("session-live", new Set([liveActorWs]));
      const deliveredViaSession = internals.broadcastLiveEvent(
        world,
        { op: "event", observation },
        "the_chatroom" as ObjRef,
        ["guest_live_actor" as ObjRef],
        ["session-live", "session-stale-1"]
      );
      expect(deliveredViaSession).toBe(1);
      expect(liveActorWs.sent).toHaveLength(1);
    } finally {
      directoryState.close();
      gatewayState.close();
    }
  });

  it("emits storage_direct_write metrics for log, snapshot, truncate, and tombstone writes", async () => {
    const state = new FakeDurableObjectState();
    const events: Array<{ kind: string; what?: string; rows?: number }> = [];
    try {
      const repo = new CFObjectRepository(state as unknown as DurableObjectState, (event) => {
        events.push({ kind: event.kind, what: (event as { what?: string }).what, rows: (event as { rows?: number }).rows });
      });
      const world = createWorld({ repository: repo });
      const session = world.auth("guest:cf-write-metrics");
      const applied = await callInDubspace(world, session.id, "cf-write-metric-frame",
        message(session.actor, "the_dubspace", "set_control", ["delay_1", "wet", 0.42]));
      expect(applied.op).toBe("applied");
      world.saveSnapshot("the_dubspace");
      const truncated = repo.truncateLog("the_dubspace", 1);
      expect(truncated).toBeGreaterThan(0);
      repo.saveTombstone("ulid_doomed", Date.now(), "test");

      const writes = events.filter((event) => event.kind === "storage_direct_write");
      const findWith = (what: string): { rows?: number } | undefined => writes.find((event) => event.what === what);
      const logAppend = findWith("log_append");
      expect(logAppend).toBeTruthy();
      expect(logAppend?.rows).toBe(4);
      const logOutcome = findWith("log_outcome");
      expect(logOutcome).toBeTruthy();
      expect(logOutcome?.rows).toBe(1);
      const snapshot = findWith("snapshot");
      expect(snapshot).toBeTruthy();
      expect(snapshot?.rows).toBe(1);
      const truncateMetric = findWith("log_truncate");
      expect(truncateMetric).toBeTruthy();
      expect(truncateMetric?.rows).toBe(truncated);
      const tombstone = findWith("tombstone");
      expect(tombstone).toBeTruthy();
      expect(tombstone?.rows).toBe(1);
    } finally {
      state.close();
    }
  });

  it("emits storage_full_save with non-zero rows when persistFullSnapshot rewrites the world", () => {
    const state = new FakeDurableObjectState();
    try {
      const repo = new CFObjectRepository(state as unknown as DurableObjectState);
      const fullSaves: Array<{ trigger?: string; rows?: number; objects?: number }> = [];
      const world = createWorld({
        repository: repo,
        metricsHook: (event) => {
          if (event.kind === "storage_full_save") {
            fullSaves.push({ trigger: event.trigger, rows: event.rows, objects: event.objects });
          }
        }
      });
      // Bootstrap fires the first save; ignore it. Importing the same snapshot
      // twice exercises both the explicit trigger label and the row-count path.
      fullSaves.length = 0;
      const snapshot = world.exportWorld();
      world.importWorld(snapshot);
      world.persistFullSnapshot();
      world.importWorld(snapshot);
      world.persistFullSnapshot("host_seed_apply");

      expect(fullSaves).toHaveLength(2);
      expect(fullSaves[0].trigger).toBe("persist_full_snapshot");
      expect(fullSaves[1].trigger).toBe("host_seed_apply");
      for (const event of fullSaves) {
        expect(event.rows ?? 0).toBeGreaterThan(0);
        expect(event.objects ?? 0).toBe(snapshot.objects.length);
      }
    } finally {
      state.close();
    }
  });
});

// Focused regressions for the outbound-fetch limiter introduced to mitigate
// the Workers ~6-slot subrequest cap. These bypass routed worker.fetch() and
// poke the DO's private helpers directly via casts, so the invariants
// (cap, queue-abort, single-flight) are exercised in isolation rather than
// inferred from end-to-end behavior.
describe("PersistentObjectDO outbound-fetch limiter", () => {
  type Helper = {
    outFetchInFlight: number;
    outFetchQueue: Array<() => void>;
    outFetchInflight: Map<string, Promise<unknown>>;
    acquireOutFetchSlot(signal?: AbortSignal): Promise<void>;
    releaseOutFetchSlot(): void;
    outboundFetch(id: { name: string }, request: Request, signal?: AbortSignal): Promise<{ response: Response; queueMs: number }>;
    forwardInternal<T>(host: string, path: string, body: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<T>;
  };

  function defer<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
    let resolve!: (value: T) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  function buildDO(opts: {
    fetchHandler: (request: Request) => Promise<Response> | Response;
    concurrency?: string;
  }): { po: PersistentObjectDO; helper: Helper; cleanup: () => void } {
    const state = new FakeDurableObjectState("limiter-test");
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "limiter-test-token",
      WOO_INTERNAL_SECRET: "limiter-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      ...(opts.concurrency !== undefined ? { WOO_HOST_OUT_FETCH_CONCURRENCY: opts.concurrency } : {}),
      DIRECTORY: new FakeDurableObjectNamespace(() => ({ fetch: opts.fetchHandler })),
      WOO: new FakeDurableObjectNamespace(() => ({ fetch: opts.fetchHandler }))
    } as unknown as Env;
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env);
    return { po, helper: po as unknown as Helper, cleanup: () => state.close() };
  }

  function makeRequest(reqId?: number): Request {
    return new Request("https://woo.internal/__internal/probe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-woo-host-key": "probe",
        ...(reqId !== undefined ? { "x-test-req-id": String(reqId) } : {})
      },
      body: "{}"
    });
  }

  it("never exceeds the configured concurrency cap and processes the queue FIFO", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: number[] = [];
    const { helper, cleanup } = buildDO({
      concurrency: "2",
      fetchHandler: async (request) => {
        // Stamp the call-site's id (from the request header) into `order` at
        // dispatch time. If the queue were LIFO, the queued ids 2..5 would
        // arrive in reverse, even though the handler-assigned counter would
        // still appear monotonic — only call-site identity catches that.
        const reqId = Number(request.headers.get("x-test-req-id"));
        order.push(reqId);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return new Response(JSON.stringify({ ok: true, id: reqId }), { status: 200 });
      }
    });
    try {
      // Fire 6 concurrent fetches; cap=2 means at any moment ≤ 2 are in flight,
      // and the other 4 wait in the FIFO queue. Each call carries its own id
      // in the request header so we can verify the handler observed them in
      // call-site order.
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => helper.outboundFetch({ name: "h" }, makeRequest(i)))
      );
      expect(results).toHaveLength(6);
      expect(maxInFlight).toBe(2);
      // FIFO: handler observed the ids in registration order (0..5). LIFO
      // would have produced [0, 1, 5, 4, 3, 2].
      expect(order).toEqual([0, 1, 2, 3, 4, 5]);
      // Slot accounting back at zero, queue empty.
      expect(helper.outFetchInFlight).toBe(0);
      expect(helper.outFetchQueue).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("removes aborted queued waiters without firing their fetch and without leaking slots", async () => {
    let fetchCount = 0;
    const release = defer<void>();
    const { helper, cleanup } = buildDO({
      concurrency: "1",
      fetchHandler: async () => {
        fetchCount++;
        await release.promise;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    });
    try {
      // Saturate the slot: this fetch will block until release.
      const heldCall = helper.outboundFetch({ name: "h" }, makeRequest());

      // Two queued waiters with their own controllers; we'll abort both.
      const abortA = new AbortController();
      const abortB = new AbortController();
      const callA = helper.outboundFetch({ name: "h" }, makeRequest(), abortA.signal);
      const callB = helper.outboundFetch({ name: "h" }, makeRequest(), abortB.signal);
      // Eagerly attach a no-op catch so the rejection between abort() and the
      // explicit await isn't seen as an unhandled rejection by the runner.
      callA.catch(() => {});
      callB.catch(() => {});

      // One queued waiter that we DO let through.
      const callC = helper.outboundFetch({ name: "h" }, makeRequest());

      // Give acquire() time to enqueue all three.
      await new Promise((r) => setTimeout(r, 5));
      expect(helper.outFetchQueue).toHaveLength(3);
      expect(fetchCount).toBe(1); // only the held call has fetched

      // abort() with no reason sets signal.reason to a DOMException("AbortError"),
      // which is what callers naturally pass through when they cancel their own
      // request. Match on `name` rather than `code` (DOMException's code is a
      // number, not the string we use for wooError).
      abortA.abort();
      abortB.abort();
      await expect(callA).rejects.toMatchObject({ name: "AbortError" });
      await expect(callB).rejects.toMatchObject({ name: "AbortError" });
      // Aborted waiters are gone from the queue; only callC remains.
      expect(helper.outFetchQueue).toHaveLength(1);

      // Let the held fetch finish so callC can proceed.
      release.resolve();
      await heldCall;
      await callC;

      // Total fetches: held + callC = 2. Aborted A/B never fired.
      expect(fetchCount).toBe(2);
      // Slot accounting clean.
      expect(helper.outFetchInFlight).toBe(0);
      expect(helper.outFetchQueue).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("coalesces concurrent identical reads on a coalesceable path and clears the entry on settle", async () => {
    let fetchCount = 0;
    let nextSeq = 0;
    const { helper, cleanup } = buildDO({
      concurrency: "10", // generous; we want to prove coalesce, not the queue
      fetchHandler: async () => {
        fetchCount++;
        const seq = ++nextSeq;
        await new Promise((r) => setTimeout(r, 5));
        return new Response(JSON.stringify({ seq }), { status: 200 });
      }
    });
    try {
      // 5 concurrent identical reads to a coalesceable path → 1 underlying fetch,
      // all 5 callers see the same seq value.
      const reads = await Promise.all(
        Array.from({ length: 5 }, () => helper.forwardInternal<{ seq: number }>("hostA", "/__internal/object-summaries", { ids: ["x", "y"] }))
      );
      expect(fetchCount).toBe(1);
      expect(new Set(reads.map((r) => r.seq))).toEqual(new Set([1]));

      // After the in-flight Promise settled, the table should be cleared so a
      // subsequent identical call recomputes against fresh world state.
      expect(helper.outFetchInflight.size).toBe(0);
      const second = await helper.forwardInternal<{ seq: number }>("hostA", "/__internal/object-summaries", { ids: ["x", "y"] });
      expect(fetchCount).toBe(2);
      expect(second.seq).toBe(2);

      // Different host or different body should not coalesce with the previous key.
      const [a, b] = await Promise.all([
        helper.forwardInternal<{ seq: number }>("hostB", "/__internal/object-summaries", { ids: ["x", "y"] }),
        helper.forwardInternal<{ seq: number }>("hostA", "/__internal/object-summaries", { ids: ["different"] })
      ]);
      expect(fetchCount).toBe(4);
      expect(a.seq).not.toBe(b.seq);
    } finally {
      cleanup();
    }
  });

  it("times out a wedged mutating cross-host RPC under the write watchdog", async () => {
    // Mutating-route forever-hang protection: the comment-and-old-code path
    // had no deadline at all, so a wedged downstream parked the local slot
    // and the entire task chain forever. The write watchdog fires at
    // WOO_HOST_WRITE_TIMEOUT_MS and surfaces an E_TIMEOUT to the caller —
    // ambiguous remote state is preferable to indefinite hang.
    let aborted = false;
    let fetchSettled = false;
    const release = defer<void>();
    const state = new FakeDurableObjectState("write-watchdog-test");
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "limiter-test-token",
      WOO_INTERNAL_SECRET: "limiter-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      WOO_HOST_WRITE_TIMEOUT_MS: "60",
      DIRECTORY: new FakeDurableObjectNamespace(() => ({ fetch: handler })),
      WOO: new FakeDurableObjectNamespace(() => ({ fetch: handler }))
    } as unknown as Env;
    async function handler(request: Request): Promise<Response> {
      request.signal.addEventListener("abort", () => { aborted = true; });
      try {
        await release.promise;
      } finally {
        fetchSettled = true;
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env);
    const helper = po as unknown as Helper;
    try {
      await expect(
        helper.forwardInternal("hostA", "/__internal/remote-dispatch", { actor: "$wiz", verb: "say", args: ["hi"] })
      ).rejects.toMatchObject({ code: "E_TIMEOUT" });
      // The downstream fetch is aborted as part of the timeout, and the slot
      // is released so the next mutating call isn't blocked behind the wedge.
      expect(aborted).toBe(true);
      expect(helper.outFetchInFlight).toBe(0);
      expect(helper.outFetchQueue).toHaveLength(0);
    } finally {
      release.resolve();
      // Wait one microtask so the handler can settle without leaking warnings.
      await Promise.resolve();
      expect(fetchSettled).toBe(true);
      state.close();
    }
  });

  it("does not coalesce mutating routes even with byte-identical bodies", async () => {
    let fetchCount = 0;
    const { helper, cleanup } = buildDO({
      concurrency: "10",
      fetchHandler: async () => {
        fetchCount++;
        await new Promise((r) => setTimeout(r, 5));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    });
    try {
      // /__internal/remote-dispatch is a mutating route; coalescing would
      // silently drop intentional repeated writes.
      await Promise.all(
        Array.from({ length: 5 }, () => helper.forwardInternal("hostA", "/__internal/remote-dispatch", { actor: "$wiz", verb: "say", args: ["hi"] }))
      );
      expect(fetchCount).toBe(5);
      expect(helper.outFetchInflight.size).toBe(0);
    } finally {
      cleanup();
    }
  });
});
