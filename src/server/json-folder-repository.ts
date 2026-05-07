import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SerializedObject, SerializedWorld, SpaceSnapshotRecord, WorldRepository } from "../core/repository";
import { wooError, type ObjRef } from "../core/types";

type JsonFolderManifest = {
  format: "woo-json-folder";
  version: 1;
  partial: boolean;
  objectCounter: number;
  taskCounter?: number;
  parkedTaskCounter?: number;
  sessionCounter: number;
  objects: Array<{ id: ObjRef; file: string }>;
  logs: Array<{ space: ObjRef; file: string }>;
  snapshots: Array<{ space: ObjRef; file: string }>;
  sessions_file: string | null;
  tasks_file: string | null;
  tombstones?: ObjRef[];
};

export type JsonFolderDumpOptions = {
  objectIds?: ObjRef[];
  includeLogs?: boolean;
  includeSessions?: boolean;
  includeSnapshots?: boolean;
  includeTasks?: boolean;
};

export class JsonFolderWorldRepository implements WorldRepository {
  constructor(private folder: string) {}

  load(): SerializedWorld | null {
    const manifestPath = join(this.folder, "manifest.json");
    if (!existsSync(manifestPath)) return null;
    const manifest = readJson<JsonFolderManifest>(manifestPath);
    if (manifest.format !== "woo-json-folder" || manifest.version !== 1) {
      throw new Error("unsupported Woo JSON folder format");
    }
    if (manifest.partial) throw new Error("partial Woo JSON folders cannot be loaded as a world repository");

    return {
      version: 1,
      objectCounter: manifest.objectCounter ?? manifest.taskCounter ?? 1,
      parkedTaskCounter: manifest.parkedTaskCounter ?? 1,
      sessionCounter: manifest.sessionCounter,
      objects: manifest.objects.map((item) => readJson<SerializedObject>(join(this.folder, item.file))),
      sessions: manifest.sessions_file ? readJson(join(this.folder, manifest.sessions_file)) : [],
      logs: manifest.logs.map((item) => [item.space, readJson(join(this.folder, item.file))]),
      snapshots: manifest.snapshots.flatMap((item) => readJson<SpaceSnapshotRecord[]>(join(this.folder, item.file))),
      parkedTasks: manifest.tasks_file ? readJson(join(this.folder, manifest.tasks_file)) : [],
      tombstones: manifest.tombstones ?? []
    };
  }

  save(world: SerializedWorld): void {
    dumpSerializedWorldToJsonFolder(world, this.folder);
  }

  saveSpaceSnapshot(snapshot: SpaceSnapshotRecord): void {
    const world = this.load();
    if (!world) return;
    world.snapshots = world.snapshots.filter((item) => !(item.space_id === snapshot.space_id && item.seq === snapshot.seq));
    world.snapshots.push(snapshot);
    this.save(world);
  }

  latestSpaceSnapshot(space: ObjRef): SpaceSnapshotRecord | null {
    const world = this.load();
    const snapshots = world?.snapshots.filter((snapshot) => snapshot.space_id === space).sort((a, b) => b.seq - a.seq) ?? [];
    return snapshots[0] ? structuredClone(snapshots[0]) : null;
  }
}

export function dumpSerializedWorldToJsonFolder(world: SerializedWorld, folder: string, options: JsonFolderDumpOptions = {}): JsonFolderManifest {
  const objectIds = options.objectIds ? new Set(options.objectIds) : null;
  const includeLogs = options.includeLogs ?? !objectIds;
  const includeSessions = options.includeSessions ?? !objectIds;
  const includeSnapshots = options.includeSnapshots ?? !objectIds;
  const includeTasks = options.includeTasks ?? !objectIds;
  const objects = objectIds ? world.objects.filter((obj) => objectIds.has(obj.id)) : world.objects;
  const objectDir = join(folder, "objects");
  const logDir = join(folder, "logs");
  const snapshotDir = join(folder, "snapshots");

  resetDir(folder);
  mkdirSync(objectDir, { recursive: true });
  if (includeLogs) mkdirSync(logDir, { recursive: true });
  if (includeSnapshots) mkdirSync(snapshotDir, { recursive: true });

  const manifest: JsonFolderManifest = {
    format: "woo-json-folder",
    version: 1,
    partial: Boolean(objectIds),
    objectCounter: world.objectCounter,
    parkedTaskCounter: world.parkedTaskCounter,
    sessionCounter: world.sessionCounter,
    objects: [],
    logs: [],
    snapshots: [],
    sessions_file: includeSessions ? "sessions.json" : null,
    tasks_file: includeTasks ? "tasks.json" : null,
    tombstones: world.tombstones ?? []
  };

  for (const obj of objects.sort((a, b) => a.id.localeCompare(b.id))) {
    const file = `objects/${fileForId(obj.id)}.json`;
    writeJson(join(folder, file), obj);
    manifest.objects.push({ id: obj.id, file });
  }

  if (includeSessions) writeJson(join(folder, "sessions.json"), world.sessions);
  if (includeTasks) writeJson(join(folder, "tasks.json"), world.parkedTasks);

  if (includeLogs) {
    for (const [space, entries] of world.logs.sort(([left], [right]) => left.localeCompare(right))) {
      const file = `logs/${fileForId(space)}.json`;
      writeJson(join(folder, file), entries);
      manifest.logs.push({ space, file });
    }
  }

  if (includeSnapshots) {
    const bySpace = new Map<ObjRef, SpaceSnapshotRecord[]>();
    for (const snapshot of world.snapshots) bySpace.set(snapshot.space_id, [...(bySpace.get(snapshot.space_id) ?? []), snapshot]);
    for (const [space, snapshots] of Array.from(bySpace.entries()).sort(([left], [right]) => left.localeCompare(right))) {
      const file = `snapshots/${fileForId(space)}.json`;
      writeJson(join(folder, file), snapshots.sort((a, b) => a.seq - b.seq));
      manifest.snapshots.push({ space, file });
    }
  }

  writeJson(join(folder, "manifest.json"), manifest);
  return manifest;
}

export function dumpSerializedObjectsToJsonFolder(world: SerializedWorld, folder: string, objectIds: ObjRef[]): JsonFolderManifest {
  return dumpSerializedWorldToJsonFolder(world, folder, {
    objectIds,
    includeLogs: false,
    includeSessions: false,
    includeSnapshots: false,
    includeTasks: false
  });
}

function resetDir(folder: string): void {
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    throw wooError("E_STORAGE", `invalid JSON file: ${path}`, err instanceof Error ? err.message : String(err));
  }
}

function fileForId(id: ObjRef): string {
  return encodeURIComponent(id);
}
