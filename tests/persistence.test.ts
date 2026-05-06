import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createWorld, createWorldFromSerialized, scopeSerializedWorldToHost } from "../src/core/bootstrap";
import type { SerializedWorld } from "../src/core/repository";
import type { AppliedFrame, DirectResultFrame, ErrorFrame, Message, TinyBytecode, VerbDef } from "../src/core/types";
import { dumpSerializedObjectsToJsonFolder, JsonFolderWorldRepository } from "../src/server/json-folder-repository";
import { LocalSQLiteRepository } from "../src/server/sqlite-repository";

function message(actor: string, target: string, verb: string, args: unknown[] = []): Message {
  return { actor, target, verb, args: args as any[] };
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
    const direct = await world.directCall(requestId, request.actor, request.target, request.verb, request.args);
    return direct;
  }

  return world.call(requestId, sessionId, "the_dubspace", request);
}

async function callInTaskspace(
  world: ReturnType<typeof createWorld>,
  sessionId: string,
  requestId: string,
  request: Message
): Promise<AppliedFrame | DirectResultFrame | ErrorFrame> {
  const sessionActor = world.sessions.get(sessionId)?.actor;
  if (sessionActor !== request.actor) {
    return world.call(requestId, sessionId, "the_taskspace", request);
  }
  if (!world.hasPresence(sessionActor, "the_taskspace")) {
    const entered = await world.directCall(`enter-${requestId}`, sessionActor, "the_taskspace", "enter", []);
    if (entered.op === "error") return entered;
  }

  let verb;
  try {
    ({ verb } = world.resolveVerb(request.target, request.verb));
  } catch {
    return world.call(requestId, sessionId, "the_taskspace", request);
  }
  if (verb.direct_callable === true && typeof verb.perms === "string" && verb.perms.includes("x")) {
    const direct = await world.directCall(requestId, request.actor, request.target, request.verb, request.args);
    return direct;
  }

  return world.call(requestId, sessionId, "the_taskspace", request);
}

function tempDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "woo-sqlite-"));
  return { dir, path: join(dir, "world.sqlite") };
}

function addBytecodeVerb(name: string, bytecode: TinyBytecode): VerbDef {
  return {
    kind: "bytecode",
    name,
    aliases: [],
    owner: "$wiz",
    perms: "rxd",
    arg_spec: {},
    source: `test ${name}`,
    source_hash: `test-${name}`,
    version: 1,
    line_map: {},
    bytecode
  };
}

class CountingLocalSQLiteRepository extends LocalSQLiteRepository {
  saves = 0;
  objectSaves: string[] = [];
  propertySaves: string[] = [];

  save(world: SerializedWorld): void {
    this.saves += 1;
    super.save(world);
  }

  saveObject(obj: Parameters<LocalSQLiteRepository["saveObject"]>[0]): void {
    this.objectSaves.push(obj.id);
    super.saveObject(obj);
  }

  saveProperty(id: Parameters<LocalSQLiteRepository["saveProperty"]>[0], prop: Parameters<LocalSQLiteRepository["saveProperty"]>[1]): void {
    this.propertySaves.push(`${id}.${prop.name}`);
    super.saveProperty(id, prop);
  }
}

function installForkFixture(world: ReturnType<typeof createWorld>): void {
  world.addVerb(
    "delay_1",
    addBytecodeVerb("mark_after_restart", {
      literals: ["after_restart", null],
      num_locals: 0,
      max_stack: 3,
      version: 1,
      ops: [["PUSH_THIS"], ["PUSH_LIT", 0], ["PUSH_ARG", 0], ["SET_PROP"], ["PUSH_LIT", 1], ["RETURN"]]
    })
  );
  world.addVerb(
    "delay_1",
    addBytecodeVerb("schedule_restart_mark", {
      literals: ["mark_after_restart"],
      num_locals: 0,
      max_stack: 5,
      version: 1,
      ops: [["PUSH_INT", 0], ["PUSH_THIS"], ["PUSH_LIT", 0], ["PUSH_ARG", 0], ["FORK", 1], ["RETURN"]]
    })
  );
}

function installSuspendFixture(world: ReturnType<typeof createWorld>): void {
  world.addVerb(
    "delay_1",
    addBytecodeVerb("suspend_after_restart", {
      literals: ["after_restart_suspend", null],
      num_locals: 0,
      max_stack: 4,
      version: 1,
      ops: [["PUSH_INT", 0], ["SUSPEND"], ["POP"], ["PUSH_THIS"], ["PUSH_LIT", 0], ["PUSH_ARG", 0], ["SET_PROP"], ["PUSH_LIT", 1], ["RETURN"]]
    })
  );
}

function installReadFixture(world: ReturnType<typeof createWorld>): void {
  world.addVerb(
    "delay_1",
    addBytecodeVerb("read_after_restart", {
      literals: ["after_restart_read", null],
      num_locals: 1,
      max_stack: 4,
      version: 1,
      ops: [["PUSH_ACTOR"], ["READ"], ["POP_LOCAL", 0], ["PUSH_THIS"], ["PUSH_LIT", 0], ["PUSH_LOCAL", 0], ["SET_PROP"], ["PUSH_LIT", 1], ["RETURN"]]
    })
  );
}

describe("sqlite persistence", () => {
  it("reloads host-scoped cluster state from per-object writes after initial seed save", async () => {
    const { dir, path } = tempDb();
    try {
      const gateway = createWorld();
      const session = gateway.auth("guest:cluster-restart");
      const gatewaySeed = gateway.exportWorld();

      const firstRepo = new CountingLocalSQLiteRepository(path);
      const firstSeed = scopeSerializedWorldToHost(firstRepo.load() ?? gatewaySeed, "the_taskspace");
      const firstCluster = createWorldFromSerialized(firstSeed, { repository: firstRepo });
      expect(firstRepo.saves).toBeGreaterThan(0);
      firstRepo.saves = 0;

      const firstSession = firstCluster.auth("guest:cluster-restart");
      const created = await callInTaskspace(
        firstCluster,
        firstSession.id,
        "cluster-create",
        message(firstSession.actor, "the_taskspace", "create_task", ["Cluster persisted", "written after host seed"])
      );
      expect(created.op).toBe("applied");
      expect(firstRepo.saves).toBe(0);
      if (created.op !== "applied") return;
      const task = String(created.observations.find((obs) => obs.type === "task_created")?.task ?? "");
      expect(task).toMatch(/^obj_the_taskspace_/);
      firstRepo.close();

      const secondRepo = new CountingLocalSQLiteRepository(path);
      const stored = secondRepo.load();
      expect(stored).not.toBeNull();
      const secondSeed = scopeSerializedWorldToHost(stored ?? gatewaySeed, "the_taskspace");
      const secondCluster = createWorldFromSerialized(secondSeed, { repository: secondRepo, persist: false });
      expect(secondRepo.saves).toBe(0);
      secondRepo.saves = 0;

      expect(secondCluster.object(task).parent).toBe("$task");
      expect(secondCluster.getProp(task, "title")).toBe("Cluster persisted");
      expect(secondCluster.getProp("the_taskspace", "root_tasks")).toContain(task);
      expect(secondCluster.replay("the_taskspace", 1, 10).map((entry) => entry.message.verb)).toEqual(["create_task"]);

      const secondSession = secondCluster.auth("guest:cluster-restart");
      const status = await callInTaskspace(
        secondCluster,
        secondSession.id,
        "cluster-status",
        message(secondSession.actor, task, "set_status", ["done"])
      );
      expect(status.op).toBe("applied");
      expect(secondCluster.getProp(task, "status")).toBe("done");
      expect(secondRepo.saves).toBe(0);
      secondRepo.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses object-repository writes after bootstrap instead of whole-world saves", async () => {
    const { dir, path } = tempDb();
    try {
      const firstRepo = new CountingLocalSQLiteRepository(path);
      const firstWorld = createWorld({ repository: firstRepo });
      expect(firstRepo.saves).toBeGreaterThan(0);
      firstRepo.saves = 0;

      const session = firstWorld.auth("guest:incremental");
      firstRepo.objectSaves = [];
      firstRepo.propertySaves = [];
      const applied = await callInDubspace(firstWorld, session.id, "incremental-1", message(session.actor, "the_dubspace", "set_control", ["delay_1", "wet", 0.73]));
      expect(applied.op).toBe("applied");
        expect(firstRepo.objectSaves).toEqual(expect.arrayContaining([session.actor, "$nowhere", "the_dubspace"]));
      expect(firstRepo.propertySaves).toEqual(expect.arrayContaining(["the_dubspace.next_seq", "delay_1.wet"]));
      firstWorld.saveSnapshot("the_dubspace");
      firstRepo.close();
      expect(firstRepo.saves).toBe(0);

      const secondRepo = new CountingLocalSQLiteRepository(path);
      const secondWorld = createWorld({ repository: secondRepo });
      expect(secondRepo.saves).toBe(0);
      expect(secondWorld.getProp("delay_1", "wet")).toBe(0.73);
      expect(secondWorld.replay("the_dubspace", 1, 10)).toHaveLength(1);
      expect(secondWorld.latestSnapshot("the_dubspace")?.seq).toBe(1);
      const resumed = secondWorld.auth(`session:${session.id}`);
      expect(resumed.actor).toBe(session.actor);
      secondRepo.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists bootstrap repairs for stale stored worlds", async () => {
    const { dir, path } = tempDb();
    try {
      const seedRepo = new CountingLocalSQLiteRepository(path);
      createWorld({ repository: seedRepo });
      const damaged = seedRepo.load();
      expect(damaged).not.toBeNull();
      const system = damaged!.objects.find((obj) => obj.id === "$system");
      expect(system).toBeTruthy();
      system!.properties = system!.properties.filter(([name]) => name !== "description");
      system!.propertyVersions = system!.propertyVersions.filter(([name]) => name !== "description");
      seedRepo.save(damaged!);
      seedRepo.close();

      const repairRepo = new CountingLocalSQLiteRepository(path);
      repairRepo.saves = 0;
      const repaired = createWorld({ repository: repairRepo });
      expect(repaired.getProp("$system", "description")).toContain("Bootstrap object");
      expect(repairRepo.saves).toBe(1);
      repairRepo.close();

      const restartRepo = new CountingLocalSQLiteRepository(path);
      const restarted = createWorld({ repository: restartRepo });
      expect(restarted.getProp("$system", "description")).toContain("Bootstrap object");
      expect(restartRepo.saves).toBe(0);
      restartRepo.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("coalesces deferred property writes to one dirty property save", () => {
    const { dir, path } = tempDb();
    try {
      const repo = new CountingLocalSQLiteRepository(path);
      const world = createWorld({ repository: repo });
      repo.objectSaves = [];
      repo.propertySaves = [];

      world.withPersistenceDeferred(() => {
        world.setProp("delay_1", "wet", 0.24);
        world.setProp("delay_1", "wet", 0.61);
      });

      expect(repo.objectSaves).toEqual([]);
      expect(repo.propertySaves).toEqual(["delay_1.wet"]);
      repo.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reloads object state, sessions, and space logs from SQLite", async () => {
    const { dir, path } = tempDb();
    try {
      const firstRepo = new LocalSQLiteRepository(path);
      const firstWorld = createWorld({ repository: firstRepo });
      const session = firstWorld.auth("guest:persist");
      const applied = await callInDubspace(firstWorld, session.id, "persist-1", message(session.actor, "the_dubspace", "set_control", ["delay_1", "wet", 0.91]));
      expect(applied.op).toBe("applied");
      expect(firstWorld.getProp("delay_1", "wet")).toBe(0.91);
      firstRepo.close();

      const secondRepo = new LocalSQLiteRepository(path);
      const secondWorld = createWorld({ repository: secondRepo });
      expect(secondWorld.getProp("delay_1", "wet")).toBe(0.91);
      expect(secondWorld.getProp("the_dubspace", "next_seq")).toBe(2);
      expect(secondWorld.replay("the_dubspace", 1, 10)).toHaveLength(1);
      const resumed = secondWorld.auth(`session:${session.id}`);
      expect(resumed.actor).toBe(session.actor);
      secondRepo.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not persist socket attachments across SQLite reload", async () => {
    const { dir, path } = tempDb();
    try {
      const firstRepo = new LocalSQLiteRepository(path);
      const firstWorld = createWorld({ repository: firstRepo });
      const session = firstWorld.auth("guest:socket-reload");
      firstWorld.attachSocket(session.id, "ws-old");
      expect(firstWorld.sessions.get(session.id)?.attachedSockets.size).toBe(1);
      firstRepo.close();

      const secondRepo = new LocalSQLiteRepository(path);
      const secondWorld = createWorld({ repository: secondRepo });
      const reloaded = secondWorld.sessions.get(session.id);
      expect(reloaded?.attachedSockets.size).toBe(0);
      expect(reloaded?.lastDetachAt).toEqual(expect.any(Number));
      const resumed = secondWorld.auth(`session:${session.id}`);
      expect(resumed.actor).toBe(session.actor);
      expect(secondWorld.sessions.get(session.id)?.lastDetachAt).toBe(reloaded?.lastDetachAt);
      secondRepo.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists space snapshots", async () => {
    const { dir, path } = tempDb();
    try {
      const firstRepo = new LocalSQLiteRepository(path);
      const firstWorld = createWorld({ repository: firstRepo });
      const session = firstWorld.auth("guest:snapshot");
      await callInDubspace(firstWorld, session.id, "snapshot-1", message(session.actor, "the_dubspace", "set_control", ["filter_1", "cutoff", 1800]));
      const snapshot = firstWorld.saveSnapshot("the_dubspace");
      expect(snapshot.seq).toBe(1);
      firstRepo.close();

      const secondRepo = new LocalSQLiteRepository(path);
      const secondWorld = createWorld({ repository: secondRepo });
      const loaded = secondWorld.latestSnapshot("the_dubspace");
      expect(loaded?.seq).toBe(1);
      expect(loaded?.hash).toBe(snapshot.hash);
      expect(secondWorld.getProp("the_dubspace", "last_snapshot_seq")).toBe(1);
      secondRepo.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists delayed fork tasks and runs them after restart", async () => {
    const { dir, path } = tempDb();
    try {
      const firstRepo = new LocalSQLiteRepository(path);
      const firstWorld = createWorld({ repository: firstRepo });
      installForkFixture(firstWorld);
      const session = firstWorld.auth("guest:fork-persist");
      const scheduled = await callInDubspace(firstWorld, session.id, "fork-persist", message(session.actor, "delay_1", "schedule_restart_mark", ["ok"]));
      expect(scheduled.op).toBe("applied");
      expect(firstWorld.parkedTasks.size).toBe(1);
      firstRepo.close();

      const secondRepo = new LocalSQLiteRepository(path);
      const secondWorld = createWorld({ repository: secondRepo });
      expect(secondWorld.parkedTasks.size).toBe(1);
      const ran = await secondWorld.runDueTasks(Date.now() + 1);
      expect(ran).toHaveLength(1);
      expect(ran[0].frame?.op).toBe("applied");
      if (ran[0].frame?.op === "applied") expect(ran[0].frame.seq).toBe(2);
      expect(secondWorld.replay("the_dubspace", 1, 10).map((entry) => entry.message.verb)).toEqual(["schedule_restart_mark", "mark_after_restart"]);
      expect(secondWorld.getProp("delay_1", "after_restart")).toBe("ok");
      expect(secondWorld.parkedTasks.size).toBe(0);
      secondRepo.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists suspended VM continuations and resumes them after restart", async () => {
    const { dir, path } = tempDb();
    try {
      const firstRepo = new LocalSQLiteRepository(path);
      const firstWorld = createWorld({ repository: firstRepo });
      installSuspendFixture(firstWorld);
      const session = firstWorld.auth("guest:suspend-persist");
      const suspended = await callInDubspace(firstWorld, session.id, "suspend-persist", message(session.actor, "delay_1", "suspend_after_restart", ["ok"]));
      expect(suspended.op).toBe("applied");
      expect(firstWorld.parkedTasks.size).toBe(1);
      firstRepo.close();

      const secondRepo = new LocalSQLiteRepository(path);
      const secondWorld = createWorld({ repository: secondRepo });
      expect(secondWorld.parkedTasks.size).toBe(1);
      const ran = await secondWorld.runDueTasks(Date.now() + 1);
      expect(ran).toHaveLength(1);
      expect(ran[0].frame?.op).toBe("applied");
      if (ran[0].frame?.op === "applied") expect(ran[0].frame.message.verb).toBe("$resume");
      expect(secondWorld.getProp("delay_1", "after_restart_suspend")).toBe("ok");
      expect(secondWorld.replay("the_dubspace", 1, 10).map((entry) => entry.message.verb)).toEqual(["suspend_after_restart", "$resume"]);
      secondRepo.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists READ continuations and resumes them from input after restart", async () => {
    const { dir, path } = tempDb();
    try {
      const firstRepo = new LocalSQLiteRepository(path);
      const firstWorld = createWorld({ repository: firstRepo });
      installReadFixture(firstWorld);
      const session = firstWorld.auth("guest:read-persist");
      const waiting = await callInDubspace(firstWorld, session.id, "read-persist", message(session.actor, "delay_1", "read_after_restart", []));
      expect(waiting.op).toBe("applied");
      expect(firstWorld.parkedTasks.size).toBe(1);
      firstRepo.close();

      const secondRepo = new LocalSQLiteRepository(path);
      const secondWorld = createWorld({ repository: secondRepo });
      expect(secondWorld.parkedTasks.size).toBe(1);
      const ran = await secondWorld.deliverInput(session.actor, "after reboot");
      expect(ran?.frame?.op).toBe("applied");
      if (ran?.frame?.op === "applied") {
        expect(ran.frame.message.verb).toBe("$resume");
        expect(ran.frame.message.body?.kind).toBe("vm_read");
      }
      expect(secondWorld.getProp("delay_1", "after_restart_read")).toBe("after reboot");
      expect(secondWorld.replay("the_dubspace", 1, 10).map((entry) => entry.message.verb)).toEqual(["read_after_restart", "$resume"]);
      secondRepo.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("json folder persistence", () => {
  it("round-trips a full world through a JSON folder repository", { timeout: 15000 }, async () => {
    const { dir, path } = tempDb();
    try {
      const firstRepo = new JsonFolderWorldRepository(path);
      const firstWorld = createWorld({ repository: firstRepo });
      const session = firstWorld.auth("guest:json");
      await callInDubspace(firstWorld, session.id, "json-1", message(session.actor, "the_dubspace", "set_control", ["delay_1", "send", 0.66]));
      firstWorld.saveSnapshot("the_dubspace");

      const secondRepo = new JsonFolderWorldRepository(path);
      const secondWorld = createWorld({ repository: secondRepo });
      expect(secondWorld.getProp("delay_1", "send")).toBe(0.66);
      expect(secondWorld.getProp("the_dubspace", "next_seq")).toBe(2);
      expect(secondWorld.replay("the_dubspace", 1, 10)).toHaveLength(1);
      expect(secondWorld.latestSnapshot("the_dubspace")?.seq).toBe(1);
      expect(existsSync(join(path, "objects", "delay_1.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dumps selected objects as a partial JSON folder", async () => {
    const { dir, path } = tempDb();
    try {
      const world = createWorld();
      world.setProp("delay_1", "wet", 0.82);
      const manifest = dumpSerializedObjectsToJsonFolder(world.exportWorld(), path, ["delay_1"]);
      expect(manifest.partial).toBe(true);
      expect(manifest.objects.map((obj) => obj.id)).toEqual(["delay_1"]);
      expect(manifest.logs).toEqual([]);
      expect(manifest.sessions_file).toBeNull();
      expect(manifest.tasks_file).toBeNull();
      const dumped = JSON.parse(readFileSync(join(path, "objects", "delay_1.json"), "utf8"));
      expect(dumped.properties.find(([name]: [string, unknown]) => name === "wet")?.[1]).toBe(0.82);
      expect(() => new JsonFolderWorldRepository(path).load()).toThrow(/partial/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
