import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createWorld, createWorldFromSerialized, scopeSerializedWorldToHost } from "../src/core/bootstrap";
import { installCatalogManifest, updateCatalogManifest, type CatalogManifest } from "../src/core/catalog-installer";
import type { ProjectionWrite } from "../src/core/projection-delta";
import type { SerializedWorld } from "../src/core/repository";
import type { AppliedFrame, DirectResultFrame, ErrorFrame, Message, TinyBytecode, VerbDef } from "../src/core/types";
import { dumpSerializedObjectsToJsonFolder, JsonFolderWorldRepository } from "../src/server/json-folder-repository";
import { LocalSQLiteRepository } from "../src/server/sqlite-repository";

const catalogsRoot = new URL("../catalogs", import.meta.url).pathname;
function readCatalogManifest(name: string, file = "manifest.json"): unknown {
  return JSON.parse(readFileSync(join(catalogsRoot, name, file), "utf8"));
}

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
    const entered = await world.directCall(`move-${requestId}`, sessionActor, sessionActor, "moveto", ["the_dubspace"], { sessionId });
    if (entered.op === "error") return entered;
  }

  let verb;
  try {
    ({ verb } = world.resolveVerb(request.target, request.verb));
  } catch {
    return world.call(requestId, sessionId, "the_dubspace", request);
  }
  if (request.target === "the_dubspace" && verb.direct_callable === true && typeof verb.perms === "string" && verb.perms.includes("x")) {
    const direct = await world.directCall(requestId, request.actor, request.target, request.verb, request.args, { sessionId });
    return direct;
  }

  return world.call(requestId, sessionId, "the_dubspace", request);
}

async function callInPinboard(
  world: ReturnType<typeof createWorld>,
  sessionId: string,
  requestId: string,
  request: Message
): Promise<AppliedFrame | DirectResultFrame | ErrorFrame> {
  const sessionActor = world.sessions.get(sessionId)?.actor;
  if (sessionActor !== request.actor) {
    return world.call(requestId, sessionId, "the_pinboard", request);
  }
  if (!world.hasPresence(sessionActor, "the_pinboard")) {
    const entered = await world.directCall(`move-${requestId}`, sessionActor, sessionActor, "moveto", ["the_pinboard"], { sessionId });
    if (entered.op === "error") return entered;
  }

  let verb;
  try {
    ({ verb } = world.resolveVerb(request.target, request.verb));
  } catch {
    return world.call(requestId, sessionId, "the_pinboard", request);
  }
  if (verb.direct_callable === true && typeof verb.perms === "string" && verb.perms.includes("x")) {
    const direct = await world.directCall(requestId, request.actor, request.target, request.verb, request.args, { sessionId });
    return direct;
  }

  return world.call(requestId, sessionId, "the_pinboard", request);
}

/** The registry record a catalog alias currently stores. */
function registryRecord(world: ReturnType<typeof createWorld>, alias: string): Record<string, unknown> | undefined {
  const records = world.getProp("$catalog_registry", "installed_catalogs") as Array<Record<string, unknown>>;
  return records.find((record) => record.alias === alias);
}

function installedVersion(world: ReturnType<typeof createWorld>, alias: string): string | undefined {
  return registryRecord(world, alias)?.version as string | undefined;
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

describe("sqlite persistence", () => {
  it("reloads host-scoped cluster state from per-object writes after initial seed save", async () => {
    const { dir, path } = tempDb();
    try {
      const gateway = createWorld();
      gateway.auth("guest:cluster-restart");
      const gatewaySeed = gateway.exportWorld();

      const firstRepo = new CountingLocalSQLiteRepository(path);
      const firstSeed = scopeSerializedWorldToHost(firstRepo.load() ?? gatewaySeed, "the_pinboard");
      const firstCluster = createWorldFromSerialized(firstSeed, { repository: firstRepo });
      expect(firstRepo.saves).toBeGreaterThan(0);
      firstRepo.saves = 0;

      const firstSession = firstCluster.auth("guest:cluster-restart");
      const created = await callInPinboard(
        firstCluster,
        firstSession.id,
        "cluster-create",
        message(firstSession.actor, "the_pinboard", "add_note", ["Cluster persisted note"])
      );
      expect(created.op).toBe("applied");
      expect(firstRepo.saves).toBe(0);
      if (created.op !== "applied") return;
      const noteAdded = created.observations.find((obs) => obs.type === "note_added");
      const pin = String((noteAdded?.note as Record<string, unknown> | undefined)?.id ?? noteAdded?.pin ?? "");
      expect(pin).toMatch(/^obj_the_pinboard_/);
      firstRepo.close();

      const secondRepo = new CountingLocalSQLiteRepository(path);
      const stored = secondRepo.load();
      expect(stored).not.toBeNull();
      const secondSeed = scopeSerializedWorldToHost(stored ?? gatewaySeed, "the_pinboard");
      const secondCluster = createWorldFromSerialized(secondSeed, { repository: secondRepo, persist: false });
      expect(secondRepo.saves).toBe(0);
      secondRepo.saves = 0;

      expect(secondCluster.object(pin).parent).toBe("$pin");
      expect(secondCluster.getProp(pin, "text")).toBe("Cluster persisted note");
      expect(secondCluster.object(pin).location).toBe("the_pinboard");
      expect(secondCluster.replay("the_pinboard", 1, 10).map((entry) => entry.message.verb)).toEqual(["add_note"]);
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
      // The actor's previous location is whatever auth chose (currently
      // `the_chatroom` from demoworld's `$system.guest_initial_room`).
      const priorLocation = firstWorld.object(session.actor).location ?? "$nowhere";
      firstRepo.objectSaves = [];
      firstRepo.propertySaves = [];
      const applied = await callInDubspace(firstWorld, session.id, "incremental-1", message(session.actor, "the_dubspace", "set_control", ["delay_1", "wet", 0.73]));
      expect(applied.op).toBe("applied");
      expect(firstRepo.objectSaves).toEqual(expect.arrayContaining([session.actor, priorLocation, "the_dubspace"]));
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

  it("persists property presence-projection metadata across SQLite reload", () => {
    const { dir, path } = tempDb();
    try {
      const firstRepo = new LocalSQLiteRepository(path);
      const firstWorld = createWorld({ repository: firstRepo });
      firstWorld.createObject({ id: "presence_meta_room", name: "Presence Metadata Room", parent: "$space", owner: "$wiz" });
      firstWorld.defineProperty("presence_meta_room", {
        name: "occupant_rows",
        defaultValue: [],
        owner: "$wiz",
        perms: "r",
        typeHint: "list<map>",
        presenceProjection: { kind: "presence", key: "session", sessionField: "sid", actorField: "who" }
      });
      firstRepo.close();

      const secondRepo = new LocalSQLiteRepository(path);
      const secondWorld = createWorld({ repository: secondRepo });
      expect(secondWorld.object("presence_meta_room").propertyDefs.get("occupant_rows")?.presenceProjection).toEqual({
        kind: "presence",
        key: "session",
        sessionField: "sid",
        actorField: "who"
      });
      secondRepo.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds property_def metadata column to existing SQLite schemas", () => {
    const { dir, path } = tempDb();
    try {
      const db = new DatabaseSync(path);
      db.exec(`
        PRAGMA user_version = 1;
        CREATE TABLE property_def (
          object_id TEXT NOT NULL,
          name TEXT NOT NULL,
          default_val TEXT NOT NULL,
          type_hint TEXT,
          owner TEXT NOT NULL,
          perms TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (object_id, name)
        )
      `);
      db.close();

      const repo = new LocalSQLiteRepository(path);
      const check = new DatabaseSync(path);
      const columns = (check.prepare("PRAGMA table_info(property_def)").all() as Array<{ name: string }>).map((row) => row.name);
      const metadataColumn = check.prepare("SELECT dflt_value, \"notnull\" FROM pragma_table_info('property_def') WHERE name = 'metadata'").get() as { dflt_value: string; notnull: number } | undefined;
      check.close();

      expect(columns).toContain("metadata");
      expect(metadataColumn).toEqual({ dflt_value: "'{}'", notnull: 1 });
      repo.close();
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

  it("preserves live socket attachments across session projection upserts", () => {
    const world = createWorld();
    const session = world.auth("guest:projection-socket");
    world.attachSocket(session.id, "ws-live");
    const before = world.sessions.get(session.id);
    expect(before?.attachedSockets.has("ws-live")).toBe(true);
    expect(before?.lastDetachAt).toBeNull();

    const write: ProjectionWrite = {
      table: "sessions",
      key: session.id,
      op: "upsert",
      row: {
        id: session.id,
        actor: session.actor,
        started: session.started,
        expiresAt: session.expiresAt + 60_000,
        lastDetachAt: Date.now(),
        tokenClass: session.tokenClass,
        activeScope: "the_dubspace"
      },
      bytes: 1
    };
    world.applyProjectionWrites([write]);

    const after = world.sessions.get(session.id);
    expect(after?.attachedSockets.has("ws-live")).toBe(true);
    expect(after?.attachedSockets.size).toBe(1);
    expect(after?.lastDetachAt).toBeNull();
    expect(after?.activeScope).toBe("the_dubspace");
  });

  it("recreates unversioned legacy SQLite databases", () => {
    const { dir, path } = tempDb();
    try {
      const db = new DatabaseSync(path);
      db.exec(`
        CREATE TABLE legacy_only (
          id TEXT PRIMARY KEY
        );
        CREATE TABLE session (
          id TEXT PRIMARY KEY,
          actor TEXT NOT NULL,
          started INTEGER NOT NULL,
          expires_at INTEGER,
          last_detach_at INTEGER,
          token_class TEXT NOT NULL DEFAULT 'guest',
          attachment TEXT NOT NULL
        )
      `);
      db.close();

      const repo = new LocalSQLiteRepository(path);
      const world = createWorld({ repository: repo });
      world.auth("guest:legacy-attachment");
      const check = new DatabaseSync(path);
      const version = (check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      const legacyTable = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'legacy_only'").get();
      const sessionColumns = (check.prepare("PRAGMA table_info(session)").all() as Array<{ name: string }>).map((row) => row.name);
      check.close();

      expect(version).toBe(1);
      expect(legacyTable).toBeUndefined();
      expect(sessionColumns).not.toContain("attachment");
      repo.close();
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
});

describe("json folder persistence", () => {
  it("round-trips a full world through a JSON folder repository", { timeout: 30000 }, async () => {
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
      const manifest = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8")) as {
        objects: Array<{ id: string; file: string }>;
      };
      const delayFile = manifest.objects.find((item) => item.id === "delay_1")?.file;
      expect(delayFile).toMatch(/^generations\/gen-[^/]+\/objects\/delay_1\.json$/);
      expect(delayFile && existsSync(join(path, delayFile))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists a transform_property list-to-string migration across SQLite reload", () => {
    const { dir, path } = tempDb();
    try {
      const seedRepo = new LocalSQLiteRepository(path);
      const seedWorld = createWorld({ repository: seedRepo });
      const v0Sticky: CatalogManifest = {
        name: "sticky-test",
        version: "0.1.0",
        spec_version: "v1",
        license: "MIT",
        classes: [{
          local_name: "$sticky_test",
          parent: "$thing",
          properties: [{ name: "body", type: "list<str>", default: [], perms: "" }]
        }],
        seed_hooks: [
          { kind: "create_instance", class: "$sticky_test", as: "obj_test_sticky_persist_filled", properties: { body: ["one", "two"] } },
          { kind: "create_instance", class: "$sticky_test", as: "obj_test_sticky_persist_empty", properties: { body: [] } }
        ]
      } as unknown as CatalogManifest;
      seedRepo.transaction(() => installCatalogManifest(seedWorld, v0Sticky, { tap: "@local", alias: "sticky-test" }));
      expect(seedWorld.getProp("obj_test_sticky_persist_filled", "body")).toEqual(["one", "two"]);
      seedRepo.close();

      const upgradeRepo = new LocalSQLiteRepository(path);
      const upgradeWorld = createWorld({ repository: upgradeRepo });
      expect(upgradeWorld.getProp("obj_test_sticky_persist_filled", "body")).toEqual(["one", "two"]);
      const v1Sticky: CatalogManifest = {
        ...v0Sticky,
        version: "1.0.0",
        classes: [{
          local_name: "$sticky_test",
          parent: "$thing",
          properties: [{ name: "body", type: "str", default: "", perms: "" }]
        }],
        seed_hooks: v0Sticky.seed_hooks
      } as unknown as CatalogManifest;
      const record = upgradeRepo.transaction(() => updateCatalogManifest(upgradeWorld, v1Sticky, {
        tap: "@local",
        alias: "sticky-test",
        acceptMajor: true,
        migration: {
          from_version: "0.x.x",
          to_version: "1.0.0",
          spec_version: "v1",
          steps: [{ kind: "transform_property", class: "$sticky_test", name: "body", transform: { op: "join", separator: "\n" } }]
        }
      }));
      expect(record.migration_state).toMatchObject({ status: "completed", from_version: "0.1.0", to_version: "1.0.0" });
      expect(upgradeWorld.getProp("obj_test_sticky_persist_filled", "body")).toBe("one\ntwo");
      expect(upgradeWorld.getProp("obj_test_sticky_persist_empty", "body")).toBe("");
      upgradeRepo.close();

      const verifyRepo = new LocalSQLiteRepository(path);
      const verifyWorld = createWorld({ repository: verifyRepo });
      expect(verifyWorld.getProp("obj_test_sticky_persist_filled", "body")).toBe("one\ntwo");
      expect(verifyWorld.getProp("obj_test_sticky_persist_empty", "body")).toBe("");
      verifyRepo.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists a $note v1 → v2 drop_verb migration across SQLite reload", () => {
    const { dir, path } = tempDb();
    try {
      const seedRepo = new LocalSQLiteRepository(path);
      const seedWorld = createWorld({ repository: seedRepo, catalogs: false });
      const v1Note: CatalogManifest = {
        name: "note",
        version: "1.0.0",
        spec_version: "v1",
        license: "MIT",
        classes: [{
          local_name: "$note",
          parent: "$thing",
          properties: [{ name: "text", type: "str", default: "", perms: "" }],
          verbs: [
            {
              name: "title",
              perms: "rxd",
              direct_callable: true,
              skip_presence_check: true,
              arg_spec: { args: [] },
              source: "verb :title() rxd { return this.name; }"
            },
            {
              name: "delete",
              perms: "rx",
              arg_spec: { args: ["line"] },
              source: "verb :delete(line) rx { return true; }"
            }
          ]
        }]
      } as unknown as CatalogManifest;
      seedRepo.transaction(() => installCatalogManifest(seedWorld, v1Note, { tap: "@local", alias: "note" }));
      expect(seedWorld.ownVerbExact("$note", "title")).toBeTruthy();
      expect(seedWorld.ownVerbExact("$note", "delete")).toBeTruthy();
      seedRepo.close();

      const upgradeRepo = new LocalSQLiteRepository(path);
      const upgradeWorld = createWorld({ repository: upgradeRepo, catalogs: false });
      expect(upgradeWorld.ownVerbExact("$note", "title")).toBeTruthy();
      expect(upgradeWorld.ownVerbExact("$note", "delete")).toBeTruthy();
      const v2Note: CatalogManifest = {
        ...v1Note,
        version: "2.0.0",
        classes: [{
          local_name: "$note",
          parent: "$thing",
          properties: [{ name: "text", type: "str", default: "", perms: "" }]
        }]
      } as unknown as CatalogManifest;
      const migration = readCatalogManifest("note", "migration-v1-to-v2.json") as NonNullable<Parameters<typeof updateCatalogManifest>[2]>["migration"];
      const record = upgradeRepo.transaction(() => updateCatalogManifest(upgradeWorld, v2Note, {
        tap: "@local",
        alias: "note",
        acceptMajor: true,
        migration
      }));
      expect(record.migration_state).toMatchObject({ status: "completed", to_version: "2.0.0" });
      expect(upgradeWorld.ownVerbExact("$note", "title")).toBeNull();
      expect(upgradeWorld.ownVerbExact("$note", "delete")).toBeNull();
      upgradeRepo.close();

      const verifyRepo = new LocalSQLiteRepository(path);
      const verifyWorld = createWorld({ repository: verifyRepo, catalogs: false });
      expect(verifyWorld.ownVerbExact("$note", "title")).toBeNull();
      expect(verifyWorld.ownVerbExact("$note", "delete")).toBeNull();
      verifyRepo.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // §CT14 version honesty. A recorded version means "this edge fully applied".
  //
  // The savepoint fix removed one CAUSE of step failure; this is about how a
  // failure that still happens gets RECORDED. applyCatalogMigration returns
  // `status: "failed"` by design (§CT14.3 wants partial progress kept, not
  // rolled back), but the installer stored `version: manifest.version`
  // regardless. That combination is terminal, not merely untidy: the next
  // attempt validates the migration's from_version against the recorded
  // version, so a world that advanced to 2.0.0 on a failed edge answers its own
  // retry with "migration version range does not match 2.0.0 -> 2.0.0". It
  // claims 2.0.0, holds v1 data, and has no path forward — directly against the
  // rerun-recovery contract §CT14.4 rests on.
  //
  // On SQLite specifically, because that is where the real failure mode lived.
  it("holds the recorded version back when a migration step failed, and admits the rerun", () => {
    const { dir, path } = tempDb();
    try {
      const v1: CatalogManifest = {
        name: "probe",
        version: "1.0.0",
        spec_version: "v1",
        license: "MIT",
        classes: [{
          local_name: "$probe",
          parent: "$thing",
          properties: [{ name: "text", type: "str", default: "", perms: "" }],
          verbs: [{ name: "gone", perms: "rxd", arg_spec: { args: [] }, source: "verb :gone() rxd { return 1; }" }]
        }]
      } as unknown as CatalogManifest;
      const v2: CatalogManifest = {
        ...v1,
        version: "2.0.0",
        classes: [{ local_name: "$probe", parent: "$thing", properties: [{ name: "text", type: "str", default: "", perms: "" }] }]
      } as unknown as CatalogManifest;
      type Migration = NonNullable<Parameters<typeof updateCatalogManifest>[2]>["migration"];
      // The step cannot resolve its class — the shape of a migration that hits
      // a world in a state it did not expect.
      const broken = {
        from_version: "1.0.0",
        to_version: "2.0.0",
        spec_version: "v1",
        steps: [{ kind: "drop_verb", class: "$absent_class", verb: "gone" }]
      } as unknown as Migration;
      const fixed = {
        from_version: "1.0.0",
        to_version: "2.0.0",
        spec_version: "v1",
        steps: [{ kind: "drop_verb", class: "$probe", verb: "gone" }]
      } as unknown as Migration;

      const seedRepo = new LocalSQLiteRepository(path);
      const seedWorld = createWorld({ repository: seedRepo, catalogs: false });
      seedRepo.transaction(() => installCatalogManifest(seedWorld, v1, { tap: "@local", alias: "probe" }));
      seedRepo.close();

      const failRepo = new LocalSQLiteRepository(path);
      const failWorld = createWorld({ repository: failRepo, catalogs: false });
      const failed = updateCatalogManifest(failWorld, v2, {
        tap: "@local", alias: "probe", acceptMajor: true, migration: broken
      });
      // The failure is recorded VISIBLY...
      expect(failed.migration_state).toMatchObject({
        status: "failed",
        from_version: "1.0.0",
        to_version: "2.0.0",
        failed_step: "1:drop_verb:$absent_class:gone"
      });
      // ...and the version is NOT advanced, in the returned record and in the
      // world the registry actually stores.
      expect(failed.version).toBe("1.0.0");
      expect(installedVersion(failWorld, "probe")).toBe("1.0.0");
      // The step really did not apply, so holding the version is the honest record.
      expect(failWorld.ownVerbExact("$probe", "gone")).toBeTruthy();
      failRepo.close();

      // The held-back version survives the storage round trip — a reopened
      // world must not believe it is migrated either.
      const retryRepo = new LocalSQLiteRepository(path);
      const retryWorld = createWorld({ repository: retryRepo, catalogs: false });
      expect(installedVersion(retryWorld, "probe")).toBe("1.0.0");
      expect((registryRecord(retryWorld, "probe")?.migration_state as { status?: string } | undefined)?.status).toBe("failed");

      // ...and the rerun is ADMITTED rather than refused, once the cause is
      // gone. This is the assertion the whole invariant exists for.
      const repaired = updateCatalogManifest(retryWorld, v2, {
        tap: "@local", alias: "probe", acceptMajor: true, migration: fixed
      });
      expect(repaired.migration_state).toMatchObject({ status: "completed", to_version: "2.0.0" });
      expect(repaired.version).toBe("2.0.0");
      expect(retryWorld.ownVerbExact("$probe", "gone")).toBeNull();
      retryRepo.close();

      const verifyRepo = new LocalSQLiteRepository(path);
      const verifyWorld = createWorld({ repository: verifyRepo, catalogs: false });
      expect(installedVersion(verifyWorld, "probe")).toBe("2.0.0");
      expect(verifyWorld.ownVerbExact("$probe", "gone")).toBeNull();
      verifyRepo.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The partially-applied case, which is the one that has to CONVERGE rather
  // than double-apply. Step 1 succeeds, step 2 fails; the operator repairs the
  // cause and reruns the SAME edge. Step 1 must re-run harmlessly — which is
  // exactly what §CT14.4 requires publishers to guarantee, and what the two
  // drop steps give for free: removeVerb and deleteProp both return false and
  // no-op when the target is already absent.
  it("converges when a partially-applied migration is rerun", () => {
    const { dir, path } = tempDb();
    try {
      const v1: CatalogManifest = {
        name: "twostep",
        version: "1.0.0",
        spec_version: "v1",
        license: "MIT",
        classes: [{
          local_name: "$twostep",
          parent: "$thing",
          properties: [
            { name: "keep", type: "str", default: "", perms: "" },
            { name: "doomed", type: "str", default: "", perms: "" }
          ],
          verbs: [{ name: "first", perms: "rxd", arg_spec: { args: [] }, source: "verb :first() rxd { return 1; }" }]
        }]
      } as unknown as CatalogManifest;
      const v2: CatalogManifest = {
        ...v1,
        version: "2.0.0",
        classes: [{
          local_name: "$twostep",
          parent: "$thing",
          properties: [{ name: "keep", type: "str", default: "", perms: "" }]
        }]
      } as unknown as CatalogManifest;
      type Migration = NonNullable<Parameters<typeof updateCatalogManifest>[2]>["migration"];
      // Step 1 resolves and applies. Step 2 names a class this world is missing
      // — a real shape: an earlier incomplete install left the graph short.
      const migration = {
        from_version: "1.0.0",
        to_version: "2.0.0",
        spec_version: "v1",
        steps: [
          { kind: "drop_verb", class: "$twostep", verb: "first" },
          { kind: "drop_property", class: "$twostep_extra", name: "doomed" }
        ]
      } as unknown as Migration;

      const seedRepo = new LocalSQLiteRepository(path);
      const seedWorld = createWorld({ repository: seedRepo, catalogs: false });
      seedRepo.transaction(() => installCatalogManifest(seedWorld, v1, { tap: "@local", alias: "twostep" }));
      seedRepo.close();

      const partialRepo = new LocalSQLiteRepository(path);
      const partialWorld = createWorld({ repository: partialRepo, catalogs: false });
      const partial = updateCatalogManifest(partialWorld, v2, {
        tap: "@local", alias: "twostep", acceptMajor: true, migration
      });
      expect(partial.migration_state).toMatchObject({
        status: "failed",
        completed_steps: ["1:drop_verb:$twostep:first"],
        failed_step: "2:drop_property:$twostep_extra.doomed"
      });
      // Step 1's work is KEPT (that is the point of §CT14.3's partial-progress
      // semantics) while the version stays behind.
      expect(partialWorld.ownVerbExact("$twostep", "first")).toBeNull();
      expect(partial.version).toBe("1.0.0");
      partialRepo.close();

      // Operator repairs the cause: the missing class now exists, carrying the
      // property step 2 wants dropped.
      const rerunRepo = new LocalSQLiteRepository(path);
      const rerunWorld = createWorld({ repository: rerunRepo, catalogs: false });
      expect(installedVersion(rerunWorld, "twostep")).toBe("1.0.0");
      expect(rerunWorld.ownVerbExact("$twostep", "first")).toBeNull();
      rerunWorld.createObject({ id: "$twostep_extra", parent: "$thing", owner: "$wiz", name: "extra" });
      rerunWorld.defineProperty("$twostep_extra", {
        name: "doomed", defaultValue: "", owner: "$wiz", perms: "r"
      });
      expect(rerunWorld.object("$twostep_extra").propertyDefs.has("doomed")).toBe(true);

      // The SAME edge, rerun. Step 1 re-applies as a no-op; step 2 now lands.
      const converged = updateCatalogManifest(rerunWorld, v2, {
        tap: "@local", alias: "twostep", acceptMajor: true, migration
      });
      expect(converged.migration_state).toMatchObject({
        status: "completed",
        completed_steps: ["1:drop_verb:$twostep:first", "2:drop_property:$twostep_extra.doomed"]
      });
      expect(converged.version).toBe("2.0.0");
      // No double-apply damage: the re-run of step 1 left the class alone
      // apart from the verb it had already removed.
      expect(rerunWorld.ownVerbExact("$twostep", "first")).toBeNull();
      expect(rerunWorld.object("$twostep").propertyDefs.has("keep")).toBe(true);
      expect(rerunWorld.object("$twostep_extra").propertyDefs.has("doomed")).toBe(false);
      rerunRepo.close();

      const verifyRepo = new LocalSQLiteRepository(path);
      const verifyWorld = createWorld({ repository: verifyRepo, catalogs: false });
      expect(installedVersion(verifyWorld, "twostep")).toBe("2.0.0");
      expect(verifyWorld.ownVerbExact("$twostep", "first")).toBeNull();
      expect(verifyWorld.object("$twostep_extra").propertyDefs.has("doomed")).toBe(false);
      verifyRepo.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Regression for the seam the two migration fixtures above CANNOT see.
  // Both wrap their update in `repo.transaction(...)`, which leaves
  // transactionDepth at 1 so the persist flush flattens. The real boot path
  // (installLocalCatalogs -> runLocalCatalogVersionMigrations ->
  // updateCatalogManifest) has no such wrapper, so its per-step
  // world.withMutationSavepoint() IS the outermost scope — and a SAVEPOINT
  // opened outside an explicit BEGIN starts a transaction implicitly. The
  // inner BEGIN IMMEDIATE then failed with "cannot start a transaction within
  // a transaction", every migration step threw, and applyCatalogMigration
  // swallowed it into migration_state while the schema sync still advanced the
  // recorded catalog version. Worlds reported themselves migrated with none of
  // their drops applied. Note the shape below: NO enclosing transaction.
  it("persists a write made inside an OUTERMOST savepoint, with no enclosing transaction", () => {
    const { dir, path } = tempDb();
    try {
      const seedRepo = new LocalSQLiteRepository(path);
      const seedWorld = createWorld({ repository: seedRepo, catalogs: false });
      seedWorld.addVerb("$thing", {
        kind: "native",
        name: "doomed_verb",
        aliases: [],
        owner: seedWorld.object("$thing").owner,
        perms: "rxd",
        arg_spec: { args: [] },
        source: "verb :doomed_verb() rxd { return null; }",
        source_hash: "doomed",
        version: 1,
        line_map: {},
        native: "noop",
        direct_callable: true
      });
      expect(seedWorld.ownVerbExact("$thing", "doomed_verb")).toBeTruthy();
      seedRepo.close();

      const dropRepo = new LocalSQLiteRepository(path);
      const dropWorld = createWorld({ repository: dropRepo, catalogs: false });
      expect(dropWorld.ownVerbExact("$thing", "doomed_verb")).toBeTruthy();
      // removeVerb persists, exactly as the drop_verb migration step does.
      dropWorld.withMutationSavepoint(() => {
        dropWorld.removeVerb("$thing", "doomed_verb");
      });
      expect(dropWorld.ownVerbExact("$thing", "doomed_verb")).toBeNull();
      dropRepo.close();

      const verifyRepo = new LocalSQLiteRepository(path);
      const verifyWorld = createWorld({ repository: verifyRepo, catalogs: false });
      expect(verifyWorld.ownVerbExact("$thing", "doomed_verb")).toBeNull();
      verifyRepo.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The other half of the same seam: flattening the nested transaction must
  // not cost the savepoint its rollback isolation. A step that throws must
  // leave nothing behind, which is what makes a partially-failed migration
  // safe to re-run.
  it("rolls back a failed outermost savepoint, leaving the persisted world untouched", () => {
    const { dir, path } = tempDb();
    try {
      const seedRepo = new LocalSQLiteRepository(path);
      const seedWorld = createWorld({ repository: seedRepo, catalogs: false });
      seedWorld.addVerb("$thing", {
        kind: "native",
        name: "kept_verb",
        aliases: [],
        owner: seedWorld.object("$thing").owner,
        perms: "rxd",
        arg_spec: { args: [] },
        source: "verb :kept_verb() rxd { return null; }",
        source_hash: "kept",
        version: 1,
        line_map: {},
        native: "noop",
        direct_callable: true
      });
      seedRepo.close();

      const failRepo = new LocalSQLiteRepository(path);
      const failWorld = createWorld({ repository: failRepo, catalogs: false });
      expect(() => failWorld.withMutationSavepoint(() => {
        failWorld.removeVerb("$thing", "kept_verb");
        throw new Error("step failed after its write");
      })).toThrow("step failed after its write");
      failRepo.close();

      const verifyRepo = new LocalSQLiteRepository(path);
      const verifyWorld = createWorld({ repository: verifyRepo, catalogs: false });
      expect(verifyWorld.ownVerbExact("$thing", "kept_verb")).toBeTruthy();
      verifyRepo.close();
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
