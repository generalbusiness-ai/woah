import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorld } from "../src/core/bootstrap";
import type { SerializedObject, SerializedProperty, SerializedSession, SerializedWorld } from "../src/core/repository";
import type { Message, MetricEvent, ObjRef } from "../src/core/types";
import { LocalSQLiteRepository } from "../src/server/sqlite-repository";

type PropertyWrite = { id: ObjRef; name: string; rows: number };
type ObjectWrite = { id: ObjRef; rows: number };

class ProfilingSQLiteRepository extends LocalSQLiteRepository {
  saves = 0;
  objectWrites: ObjectWrite[] = [];
  propertyWrites: PropertyWrite[] = [];
  sessionWrites = 0;
  sessionDeletes = 0;
  metaWrites = 0;
  appendLogs = 0;
  recordLogOutcomes = 0;

  reset(): void {
    this.saves = 0;
    this.objectWrites = [];
    this.propertyWrites = [];
    this.sessionWrites = 0;
    this.sessionDeletes = 0;
    this.metaWrites = 0;
    this.appendLogs = 0;
    this.recordLogOutcomes = 0;
  }

  save(world: SerializedWorld): void {
    this.saves += 1;
    super.save(world);
  }

  saveObject(obj: SerializedObject): void {
    this.objectWrites.push({ id: obj.id, rows: objectRows(obj) });
    super.saveObject(obj);
  }

  saveProperty(id: ObjRef, prop: SerializedProperty): void {
    this.propertyWrites.push({ id, name: prop.name, rows: propertyRows(prop) });
    super.saveProperty(id, prop);
  }

  saveSession(session: SerializedSession): void {
    this.sessionWrites += 1;
    super.saveSession(session);
  }

  deleteSession(sessionId: string): void {
    this.sessionDeletes += 1;
    super.deleteSession(sessionId);
  }

  saveMeta(key: string, value: string): void {
    this.metaWrites += 1;
    super.saveMeta(key, value);
  }

  appendLog(space: ObjRef, actor: ObjRef, message: Message): { seq: number; ts: number } {
    this.appendLogs += 1;
    return super.appendLog(space, actor, message);
  }

  recordLogOutcome(...args: Parameters<LocalSQLiteRepository["recordLogOutcome"]>): void {
    this.recordLogOutcomes += 1;
    super.recordLogOutcome(...args);
  }
}

function objectRows(obj: SerializedObject): number {
  return (
    1 +
    obj.propertyDefs.length +
    obj.properties.length +
    obj.propertyVersions.length +
    obj.verbs.length +
    obj.children.length +
    obj.contents.length +
    obj.eventSchemas.length
  );
}

function propertyRows(prop: SerializedProperty): number {
  return (prop.def ? 1 : 0) + (prop.value !== undefined ? 1 : 0) + 1;
}

function total<T>(items: T[], fn: (item: T) => number): number {
  return items.reduce((sum, item) => sum + fn(item), 0);
}

function summarizeMetrics(metrics: MetricEvent[]): MetricEvent[] {
  return metrics.filter((event) => event.kind === "storage_flush" || event.kind === "applied");
}

function message(actor: ObjRef, target: ObjRef, verb: string, args: unknown[]): Message {
  return { actor, target, verb, args: args as never[] };
}

const dir = mkdtempSync(join(tmpdir(), "woo-storage-profile-"));
try {
  const repo = new ProfilingSQLiteRepository(join(dir, "world.sqlite"));
  const world = createWorld({ repository: repo });
  const session = world.auth("guest:storage-profile");
  const metrics: MetricEvent[] = [];
  world.setMetricsHook((event) => metrics.push(event));

  repo.reset();
  void await world.call(
    "profile-set-control",
    session.id,
    "the_dubspace",
    message(session.actor as ObjRef, "the_dubspace", "set_control", ["delay_1", "wet", 0.37])
  );

  const exported = world.exportWorld();
  const oldWholeHostObjectRows = total(exported.objects, objectRows);
  const currentPropertyRows = total(repo.propertyWrites, (item) => item.rows);
  const currentObjectRows = total(repo.objectWrites, (item) => item.rows);
  const currentLogicalRows =
    currentPropertyRows +
    currentObjectRows +
    repo.sessionWrites +
    repo.sessionDeletes +
    repo.metaWrites +
    repo.appendLogs +
    repo.recordLogOutcomes;

  console.log(JSON.stringify({
    scenario: "one sequenced dubspace set_control(delay_1.wet)",
    current: {
      repository_ops: {
        save_world: repo.saves,
        save_object: repo.objectWrites.map((item) => item.id),
        save_property: repo.propertyWrites.map((item) => `${item.id}.${item.name}`),
        save_session: repo.sessionWrites,
        delete_session: repo.sessionDeletes,
        save_meta: repo.metaWrites,
        append_log: repo.appendLogs,
        record_log_outcome: repo.recordLogOutcomes
      },
      logical_row_estimate: currentLogicalRows,
      metrics: summarizeMetrics(metrics)
    },
    old_whole_host_flush_estimate: {
      hosted_objects: exported.objects.length,
      object_rows_rewritten_once: oldWholeHostObjectRows,
      object_rows_deleted_and_reinserted: oldWholeHostObjectRows * 2,
      note: "Old path also wrote the same appendLog/recordLogOutcome rows; this estimate isolates the removed whole-host object rewrite."
    }
  }, null, 2));

  repo.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
