// CFObjectRepository — Cloudflare Durable Object backend for ObjectRepository.
//
// Mirrors src/server/sqlite-repository.ts (LocalSQLiteRepository). The schema
// and SQL strings are identical (both target SQLite); only the storage wrapping
// differs: CF's state.storage.sql cursor API + state.storage.transactionSync
// instead of better-sqlite3's prepared-statement / db.exec API.
//
// Per spec/reference/cloudflare.md §R3 and §R3.1–§R3.4:
// - transaction() uses state.storage.transactionSync (CF's atomicity primitive).
// - savepoint() also uses state.storage.transactionSync — when called inside
//   an outer transaction, CF nests it as an implicit savepoint. Raw SQL
//   SAVEPOINT/ROLLBACK TO/RELEASE statements are NOT supported through
//   sql.exec on CF DOs (transaction-related statements must go through
//   transactionSync), so we don't issue them.
// - appendLog inserts a pending row (applied_ok = NULL); recordLogOutcome
//   updates the same row inside the outer transaction.
// - The transaction's commit fails if any pending log outcome remains.

// Types from @cloudflare/workers-types are scoped via tsconfig.worker.json,
// which sets `types: ["@cloudflare/workers-types"]`. The main tsconfig excludes
// src/worker/ to keep these globals out of client/server typechecking.

import type {
  LogReadResult,
  ObjectRepository,
  ParkedTaskRecord,
  SerializedObject,
  SerializedProperty,
  SerializedSession,
  SerializedVerb,
  SerializedWorld,
  SpaceSnapshotRecord,
  WorldRepository
} from "../core/repository";
import {
  flagsFromSqlInt as flagsFromInt,
  flagsToSqlInt as flagsToInt,
  logEntryFromSqlRow as logEntryFromRow,
  parseSqlValue as parseValue,
  sessionFromSqlRow as sessionFromRow,
  snapshotFromSqlRow as snapshotFromRow,
  SQL_DELETE_TABLES,
  SQL_LEGACY_RESET_TABLES,
  SQL_SCHEMA_STATEMENTS,
  SQL_SPACE_MESSAGE_OUTCOME_REBUILD_STATEMENTS,
  SQL_VERB_ORDER_REBUILD_STATEMENTS,
  sqlGroupBy as groupBy,
  stringifySqlValue as stringifyValue,
  taskFromSqlRow as taskFromRow,
  verbFlagsJson,
  verbFromSqlRow as verbFromRow
} from "../core/sql-shape";
import { wooError, type ErrorValue, type Message, type ObjRef, type Observation, type SpaceLogEntry, type WooValue } from "../core/types";

type Row = Record<string, unknown>;

export class CFObjectRepository implements ObjectRepository, WorldRepository {
  private sql: SqlStorage;
  private transactionDepth = 0;

  constructor(private state: DurableObjectState) {
    this.sql = state.storage.sql;
    this.migrate();
  }

  // ---- WorldRepository compatibility (so WooWorld's constructor can accept us) ----
  //
  // load() walks per-object tables and reconstructs a SerializedWorld so
  // createWorld() can hydrate after DO hibernation/restart. Same shape as
  // LocalSQLiteRepository.load() — schema is identical SQLite, only the
  // cursor wrapping differs. Returns null on a fresh DO (no `object` rows yet)
  // so createWorld() runs bootstrap + auto-install for first-light boot.
  //
  // save() is implemented via the per-object methods inside one transaction.
  // createWorld() calls world.persist() once after bootstrap, BEFORE
  // enableIncrementalPersistence() flips the runtime to per-object writes —
  // at that moment the runtime takes the WorldRepository.save() path, so the
  // CF backend has to flush the bootstrap state through this method.

  load(): SerializedWorld | null {
    const objectRows = this.all("SELECT * FROM object ORDER BY id");
    if (objectRows.length === 0) return null;

    const propertyDefs = groupBy(this.all("SELECT * FROM property_def ORDER BY object_id, name"), "object_id");
    const propertyValues = groupBy(this.all("SELECT * FROM property_value ORDER BY object_id, name"), "object_id");
    const propertyVersions = groupBy(this.all("SELECT * FROM property_version ORDER BY object_id, name"), "object_id");
    const verbs = groupBy(this.all("SELECT * FROM verb ORDER BY object_id, slot"), "object_id");
    const children = groupBy(this.all("SELECT * FROM child ORDER BY object_id, child_ref"), "object_id");
    const contents = groupBy(this.all("SELECT * FROM content ORDER BY object_id, content_ref"), "object_id");
    const eventSchemas = groupBy(this.all("SELECT * FROM event_schema ORDER BY object_id, type"), "object_id");

    const objects: SerializedObject[] = objectRows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      parent: row.parent === null ? null : String(row.parent),
      owner: String(row.owner),
      location: row.location === null ? null : String(row.location),
      anchor: row.anchor === null ? null : String(row.anchor),
      flags: flagsFromInt(Number(row.flags)),
      created: Number(row.created),
      modified: Number(row.modified),
      propertyDefs: (propertyDefs.get(String(row.id)) ?? []).map((def) => ({
        name: String(def.name),
        defaultValue: parseValue(String(def.default_val)),
        typeHint: def.type_hint == null ? undefined : String(def.type_hint),
        owner: String(def.owner),
        perms: String(def.perms),
        version: Number(def.version)
      })),
      properties: (propertyValues.get(String(row.id)) ?? []).map(
        (value) => [String(value.name), parseValue(String(value.value))] as [string, WooValue]
      ),
      propertyVersions: (propertyVersions.get(String(row.id)) ?? []).map(
        (version) => [String(version.name), Number(version.version)] as [string, number]
      ),
      verbs: (verbs.get(String(row.id)) ?? []).map(verbFromRow),
      children: (children.get(String(row.id)) ?? []).map((child) => String(child.child_ref)),
      contents: (contents.get(String(row.id)) ?? []).map((content) => String(content.content_ref)),
      eventSchemas: (eventSchemas.get(String(row.id)) ?? []).map(
        (schema) => [String(schema.type), parseValue(String(schema.schema)) as Record<string, WooValue>] as [string, Record<string, WooValue>]
      )
    }));

    const sessions = this.all("SELECT * FROM session ORDER BY id").map(sessionFromRow);

    const logRows = this.all("SELECT * FROM space_message ORDER BY space_id, seq");
    const logs = Array.from(groupBy(logRows, "space_id").entries()).map(([space, entries]) => [
      space,
      entries.map(logEntryFromRow) as SpaceLogEntry[]
    ]) as [ObjRef, SpaceLogEntry[]][];

    const snapshots = this.all("SELECT * FROM space_snapshot ORDER BY space_id, seq").map(snapshotFromRow);
    const parkedTasks = this.all("SELECT * FROM task ORDER BY id").map(taskFromRow);
    const meta = Object.fromEntries(this.all("SELECT key, value FROM world_meta").map((row) => [String(row.key), String(row.value ?? "")]));

    return {
      version: 1,
      objectCounter: Number(meta.objectCounter ?? meta.taskCounter ?? 1),
      parkedTaskCounter: Number(meta.parkedTaskCounter ?? 1),
      sessionCounter: Number(meta.sessionCounter ?? 1),
      objects,
      sessions,
      logs,
      snapshots,
      parkedTasks
    };
  }

  save(world: SerializedWorld): void {
    // createWorld() calls world.persist() once after bootstrap, BEFORE it
    // calls enableIncrementalPersistence(). At that moment the runtime takes
    // the WorldRepository.save() path, not the per-object path — so CF must
    // actually persist the bootstrap state here. We do it by clearing the
    // tables and re-inserting via the per-object methods, all in one
    // transaction. After this, enableIncrementalPersistence() takes over and
    // subsequent writes go through per-object methods directly.
    this.transaction(() => {
      // Drop everything; we're about to replace it.
      for (const table of SQL_DELETE_TABLES) {
        this.sql.exec(`DELETE FROM ${table}`);
      }

      this.saveMeta("version", String(world.version));
      this.saveMeta("objectCounter", String(world.objectCounter));
      this.saveMeta("parkedTaskCounter", String(world.parkedTaskCounter));
      this.saveMeta("sessionCounter", String(world.sessionCounter));

      for (const obj of world.objects) this.saveObject(obj);
      for (const session of world.sessions) this.saveSession(session);

      for (const [, entries] of world.logs) {
        for (const entry of entries) {
          this.sql.exec(
            "INSERT INTO space_message(space_id, seq, ts, actor, message, observations, applied_ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            entry.space, entry.seq, entry.ts, entry.actor,
            stringifyValue(entry.message as unknown as WooValue),
            stringifyValue((entry.observations ?? []) as unknown as WooValue),
            entry.applied_ok ? 1 : 0,
            entry.error ? stringifyValue(entry.error as unknown as WooValue) : null
          );
        }
      }

      for (const snapshot of world.snapshots) this.saveSpaceSnapshot(snapshot);
      for (const task of world.parkedTasks) this.saveTask(task);
    });
  }

  latestSpaceSnapshot(space: ObjRef): SpaceSnapshotRecord | null {
    // WorldRepository's optional method; same data as ObjectRepository.loadLatestSnapshot.
    return this.loadLatestSnapshot(space);
  }

  // ---- transactions ----

  transaction<T>(fn: () => T): T {
    // Nested transaction() calls flatten — only the outermost call wraps
    // state.storage.transactionSync and runs the pending-outcome assertion.
    // (Nested transactionSync would itself be a savepoint, but we want the
    // commit-time check at the outer-only boundary.)
    if (this.transactionDepth > 0) return fn();
    this.transactionDepth = 1;
    try {
      let result!: T;
      this.state.storage.transactionSync(() => {
        result = fn();
        this.assertNoPendingLogOutcomes();
      });
      return result;
    } finally {
      this.transactionDepth = 0;
    }
  }

  savepoint<T>(fn: () => T): T {
    // Inside an outer transactionSync, a nested transactionSync creates a
    // savepoint: throws roll back the inner scope; success commits to the
    // outer scope. This is CF's documented nested-transaction behavior, and
    // it's how the local SQLite backend's SAVEPOINT/ROLLBACK TO/RELEASE
    // statements get expressed on a runtime where raw transaction-control
    // SQL is forbidden through sql.exec.
    return this.state.storage.transactionSync(fn);
  }

  // ---- objects ----

  loadObject(id: ObjRef): SerializedObject | null {
    const row = this.one("SELECT * FROM object WHERE id = ?", id);
    if (!row) return null;
    return {
      id: String(row.id),
      name: String(row.name),
      parent: row.parent === null ? null : String(row.parent),
      owner: String(row.owner),
      location: row.location === null ? null : String(row.location),
      anchor: row.anchor === null ? null : String(row.anchor),
      flags: flagsFromInt(Number(row.flags)),
      created: Number(row.created),
      modified: Number(row.modified),
      propertyDefs: this.all("SELECT * FROM property_def WHERE object_id = ? ORDER BY name", id).map((def) => ({
        name: String(def.name),
        defaultValue: parseValue(String(def.default_val)),
        typeHint: def.type_hint == null ? undefined : String(def.type_hint),
        owner: String(def.owner),
        perms: String(def.perms),
        version: Number(def.version)
      })),
      properties: this.all("SELECT * FROM property_value WHERE object_id = ? ORDER BY name", id).map(
        (value) => [String(value.name), parseValue(String(value.value))] as [string, WooValue]
      ),
      propertyVersions: this.all("SELECT * FROM property_version WHERE object_id = ? ORDER BY name", id).map(
        (version) => [String(version.name), Number(version.version)] as [string, number]
      ),
      verbs: this.all("SELECT * FROM verb WHERE object_id = ? ORDER BY slot", id).map(verbFromRow),
      children: this.all("SELECT child_ref FROM child WHERE object_id = ? ORDER BY child_ref", id).map((row) => String(row.child_ref)),
      contents: this.all("SELECT content_ref FROM content WHERE object_id = ? ORDER BY content_ref", id).map((row) => String(row.content_ref)),
      eventSchemas: this.all("SELECT * FROM event_schema WHERE object_id = ? ORDER BY type", id).map(
        (schema) => [String(schema.type), parseValue(String(schema.schema)) as Record<string, WooValue>] as [string, Record<string, WooValue>]
      )
    };
  }

  saveObject(obj: SerializedObject): void {
    this.transaction(() => {
      this.deleteObjectRows(obj.id);
      this.sql.exec(
        "INSERT INTO object(id, name, parent, owner, location, anchor, flags, created, modified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        obj.id, obj.name, obj.parent, obj.owner, obj.location, obj.anchor, flagsToInt(obj.flags), obj.created, obj.modified
      );
      for (const def of obj.propertyDefs) {
        this.sql.exec(
          "INSERT INTO property_def(object_id, name, default_val, type_hint, owner, perms, version) VALUES (?, ?, ?, ?, ?, ?, ?)",
          obj.id, def.name, stringifyValue(def.defaultValue), def.typeHint ?? null, def.owner, def.perms, def.version
        );
      }
      for (const [name, value] of obj.properties) {
        this.sql.exec("INSERT INTO property_value(object_id, name, value) VALUES (?, ?, ?)", obj.id, name, stringifyValue(value));
      }
      for (const [name, version] of obj.propertyVersions) {
        this.sql.exec("INSERT INTO property_version(object_id, name, version) VALUES (?, ?, ?)", obj.id, name, version);
      }
      for (const verb of obj.verbs) this.saveVerb(obj.id, verb);
      for (const child of obj.children) this.addChild(obj.id, child);
      for (const content of obj.contents) this.addContent(obj.id, content);
      for (const [type, schema] of obj.eventSchemas) this.saveEventSchema(obj.id, type, schema);
    });
  }

  deleteObject(id: ObjRef): void {
    this.transaction(() => this.deleteObjectRows(id));
  }

  listHostedObjects(): ObjRef[] {
    return this.all("SELECT id FROM object ORDER BY id").map((row) => String(row.id));
  }

  // ---- properties ----

  loadProperty(id: ObjRef, name: string): SerializedProperty | null {
    const def = this.one("SELECT * FROM property_def WHERE object_id = ? AND name = ?", id, name);
    const value = this.one("SELECT value FROM property_value WHERE object_id = ? AND name = ?", id, name);
    const version = this.one("SELECT version FROM property_version WHERE object_id = ? AND name = ?", id, name);
    if (!def && !value && !version) return null;
    return {
      name,
      def: def
        ? {
            name,
            defaultValue: parseValue(String(def.default_val)),
            typeHint: def.type_hint == null ? undefined : String(def.type_hint),
            owner: String(def.owner),
            perms: String(def.perms),
            version: Number(def.version)
          }
        : null,
      value: value ? parseValue(String(value.value)) : undefined,
      version: version ? Number(version.version) : def ? Number(def.version) : 0
    };
  }

  saveProperty(id: ObjRef, prop: SerializedProperty): void {
    this.ensureHostedObject(id);
    if (prop.def) {
      this.sql.exec(
        "INSERT OR REPLACE INTO property_def(object_id, name, default_val, type_hint, owner, perms, version) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id, prop.name, stringifyValue(prop.def.defaultValue), prop.def.typeHint ?? null, prop.def.owner, prop.def.perms, prop.def.version
      );
    } else {
      this.sql.exec("DELETE FROM property_def WHERE object_id = ? AND name = ?", id, prop.name);
    }
    if (prop.value !== undefined) {
      this.sql.exec("INSERT OR REPLACE INTO property_value(object_id, name, value) VALUES (?, ?, ?)", id, prop.name, stringifyValue(prop.value));
    } else {
      this.sql.exec("DELETE FROM property_value WHERE object_id = ? AND name = ?", id, prop.name);
    }
    this.sql.exec("INSERT OR REPLACE INTO property_version(object_id, name, version) VALUES (?, ?, ?)", id, prop.name, prop.version);
  }

  deleteProperty(id: ObjRef, name: string): void {
    this.sql.exec("DELETE FROM property_def WHERE object_id = ? AND name = ?", id, name);
    this.sql.exec("DELETE FROM property_value WHERE object_id = ? AND name = ?", id, name);
    this.sql.exec("DELETE FROM property_version WHERE object_id = ? AND name = ?", id, name);
  }

  listPropertyNames(id: ObjRef): string[] {
    return this.all(
      "SELECT name FROM property_def WHERE object_id = ? UNION SELECT name FROM property_value WHERE object_id = ? ORDER BY name",
      id, id
    ).map((row) => String(row.name));
  }

  // ---- verbs ----

  loadVerb(id: ObjRef, name: string): SerializedVerb | null {
    const row = this.one("SELECT * FROM verb WHERE object_id = ? AND name = ? ORDER BY slot LIMIT 1", id, name);
    return row ? verbFromRow(row) : null;
  }

  saveVerb(id: ObjRef, verb: SerializedVerb): void {
    this.ensureHostedObject(id);
    const slot =
      typeof verb.slot === "number"
        ? verb.slot
        : Number(this.one("SELECT COALESCE(MAX(slot), 0) + 1 AS slot FROM verb WHERE object_id = ?", id)?.slot ?? 1);
    this.sql.exec(
      "INSERT OR REPLACE INTO verb(object_id, slot, name, kind, aliases, owner, perms, arg_spec, source, source_hash, version, line_map, native, bytecode, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, slot, verb.name, verb.kind, stringifyValue(verb.aliases), verb.owner, verb.perms,
      stringifyValue(verb.arg_spec), verb.source, verb.source_hash, verb.version, stringifyValue(verb.line_map),
      verb.kind === "native" ? verb.native : null,
      verb.kind === "bytecode" ? stringifyValue(verb.bytecode as unknown as WooValue) : null,
      verbFlagsJson(verb)
    );
  }

  deleteVerb(id: ObjRef, name: string): void {
    this.sql.exec("DELETE FROM verb WHERE object_id = ? AND name = ?", id, name);
  }

  listVerbNames(id: ObjRef): string[] {
    return this.all("SELECT name FROM verb WHERE object_id = ? ORDER BY slot", id).map((row) => String(row.name));
  }

  // ---- inheritance / containment ----

  loadChildren(id: ObjRef): ObjRef[] {
    return this.all("SELECT child_ref FROM child WHERE object_id = ? ORDER BY child_ref", id).map((row) => String(row.child_ref));
  }

  addChild(id: ObjRef, child: ObjRef): void {
    this.ensureHostedObject(id);
    this.sql.exec("INSERT OR IGNORE INTO child(object_id, child_ref) VALUES (?, ?)", id, child);
  }

  removeChild(id: ObjRef, child: ObjRef): void {
    this.sql.exec("DELETE FROM child WHERE object_id = ? AND child_ref = ?", id, child);
  }

  loadContents(id: ObjRef): ObjRef[] {
    return this.all("SELECT content_ref FROM content WHERE object_id = ? ORDER BY content_ref", id).map((row) => String(row.content_ref));
  }

  addContent(id: ObjRef, child: ObjRef): void {
    this.ensureHostedObject(id);
    this.sql.exec("INSERT OR IGNORE INTO content(object_id, content_ref) VALUES (?, ?)", id, child);
  }

  removeContent(id: ObjRef, child: ObjRef): void {
    this.sql.exec("DELETE FROM content WHERE object_id = ? AND content_ref = ?", id, child);
  }

  // ---- event schemas ----

  loadEventSchemas(id: ObjRef): [string, Record<string, WooValue>][] {
    return this.all("SELECT type, schema FROM event_schema WHERE object_id = ? ORDER BY type", id).map(
      (row) => [String(row.type), parseValue(String(row.schema)) as Record<string, WooValue>] as [string, Record<string, WooValue>]
    );
  }

  saveEventSchema(id: ObjRef, type: string, schema: Record<string, WooValue>): void {
    this.ensureHostedObject(id);
    this.sql.exec("INSERT OR REPLACE INTO event_schema(object_id, type, schema) VALUES (?, ?, ?)", id, type, stringifyValue(schema as WooValue));
  }

  deleteEventSchema(id: ObjRef, type: string): void {
    this.sql.exec("DELETE FROM event_schema WHERE object_id = ? AND type = ?", id, type);
  }

  // ---- log (two-phase) ----

  appendLog(space: ObjRef, actor: ObjRef, message: Message): { seq: number; ts: number } {
    this.ensureHostedObject(space);
    const seq = this.currentSeq(space);
    const nextSeq = this.loadProperty(space, "next_seq");
    this.saveProperty(space, {
      name: "next_seq",
      def: nextSeq?.def ?? null,
      value: seq + 1,
      version: (nextSeq?.version ?? 0) + 1
    });
    const ts = Date.now();
    this.sql.exec(
      "INSERT INTO space_message(space_id, seq, ts, actor, message, observations, applied_ok, error) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)",
      space, seq, ts, actor, stringifyValue(message as unknown as WooValue), stringifyValue([])
    );
    return { seq, ts };
  }

  recordLogOutcome(space: ObjRef, seq: number, applied_ok: boolean, observations: Observation[] = [], error?: ErrorValue): void {
    const row = this.one("SELECT applied_ok, observations, error FROM space_message WHERE space_id = ? AND seq = ?", space, seq);
    if (!row) throw wooError("E_STORAGE", `log entry not found: ${space}:${seq}`);
    if (row.applied_ok !== null && row.applied_ok !== undefined) {
      const existing = Boolean(row.applied_ok);
      const existingError = row.error ? parseValue(String(row.error)) : undefined;
      const existingObservations = row.observations ? parseValue(String(row.observations)) : [];
      if (existing === applied_ok && JSON.stringify(existingError ?? null) === JSON.stringify(error ?? null) && JSON.stringify(existingObservations) === JSON.stringify(observations)) return;
      throw wooError("E_STORAGE", `log outcome already recorded: ${space}:${seq}`);
    }
    this.sql.exec(
      "UPDATE space_message SET observations = ?, applied_ok = ?, error = ? WHERE space_id = ? AND seq = ?",
      stringifyValue(observations as unknown as WooValue),
      applied_ok ? 1 : 0,
      error ? stringifyValue(error as unknown as WooValue) : null,
      space, seq
    );
  }

  readLog(space: ObjRef, from: number, limit: number): LogReadResult {
    const rows = this.all("SELECT * FROM space_message WHERE space_id = ? AND seq >= ? ORDER BY seq LIMIT ?", space, from, limit + 1);
    const page = rows.slice(0, limit);
    return {
      messages: page.map(logEntryFromRow),
      next_seq: this.currentSeq(space),
      has_more: rows.length > limit
    };
  }

  currentSeq(space: ObjRef): number {
    const prop = this.loadProperty(space, "next_seq");
    if (typeof prop?.value === "number") return prop.value;
    const row = this.one("SELECT MAX(seq) AS max_seq FROM space_message WHERE space_id = ?", space);
    return Number(row?.max_seq ?? 0) + 1;
  }

  saveSpaceSnapshot(snapshot: SpaceSnapshotRecord): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO space_snapshot(space_id, seq, ts, state, hash) VALUES (?, ?, ?, ?, ?)",
      snapshot.space_id, snapshot.seq, snapshot.ts, stringifyValue(snapshot.state), snapshot.hash
    );
  }

  loadLatestSnapshot(space: ObjRef): SpaceSnapshotRecord | null {
    const row = this.one("SELECT * FROM space_snapshot WHERE space_id = ? ORDER BY seq DESC LIMIT 1", space);
    return row ? snapshotFromRow(row) : null;
  }

  truncateLog(space: ObjRef, covered_seq: number): number {
    const before = this.one("SELECT COUNT(*) AS n FROM space_message WHERE space_id = ? AND seq <= ?", space, covered_seq);
    this.sql.exec("DELETE FROM space_message WHERE space_id = ? AND seq <= ?", space, covered_seq);
    return Number(before?.n ?? 0);
  }

  // ---- sessions ----

  loadSession(session_id: string): SerializedSession | null {
    const row = this.one("SELECT * FROM session WHERE id = ?", session_id);
    return row ? sessionFromRow(row) : null;
  }

  saveSession(record: SerializedSession): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO session(id, actor, started, expires_at, last_detach_at, token_class, current_location, apikey_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      record.id, record.actor, record.started,
      record.expiresAt ?? null, record.lastDetachAt ?? null, record.tokenClass ?? "guest", record.currentLocation ?? null,
      record.apikeyId ?? null
    );
  }

  deleteSession(session_id: string): void {
    this.sql.exec("DELETE FROM session WHERE id = ?", session_id);
  }

  loadExpiredSessions(now: number): SerializedSession[] {
    return this.all("SELECT * FROM session ORDER BY id")
      .map(sessionFromRow)
      .filter((session) =>
        (session.expiresAt !== undefined && session.expiresAt <= now) ||
        (session.lastDetachAt !== undefined && session.lastDetachAt !== null && session.lastDetachAt <= now)
      );
  }

  // ---- parked tasks ----

  saveTask(task: ParkedTaskRecord): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO task(id, parked_on, state, resume_at, awaiting_player, correlation_id, serialized, created, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      task.id, task.parked_on, task.state, task.resume_at, task.awaiting_player,
      task.correlation_id, stringifyValue(task.serialized), task.created, task.origin
    );
  }

  deleteTask(id: string): void {
    this.sql.exec("DELETE FROM task WHERE id = ?", id);
  }

  loadTask(id: string): ParkedTaskRecord | null {
    const row = this.one("SELECT * FROM task WHERE id = ?", id);
    return row ? taskFromRow(row) : null;
  }

  loadDueTasks(now: number): ParkedTaskRecord[] {
    return this.all(
      "SELECT * FROM task WHERE state = 'suspended' AND resume_at <= ? ORDER BY resume_at, created, id",
      now
    ).map(taskFromRow);
  }

  loadAwaitingReadTasks(player: ObjRef): ParkedTaskRecord[] {
    return this.all(
      "SELECT * FROM task WHERE state = 'awaiting_read' AND awaiting_player = ? ORDER BY created, id",
      player
    ).map(taskFromRow);
  }

  earliestResumeAt(): number | null {
    const row = this.one("SELECT MIN(resume_at) AS resume_at FROM task WHERE state = 'suspended' AND resume_at IS NOT NULL");
    return row?.resume_at == null ? null : Number(row.resume_at);
  }

  // ---- counters & meta ----

  nextCounter(name: string): number {
    let next = 1;
    this.transaction(() => {
      const key = `counter:${name}`;
      next = Number(this.loadMeta(key) ?? 1);
      this.saveMeta(key, String(next + 1));
    });
    return next;
  }

  loadMeta(key: string): string | null {
    const row = this.one("SELECT value FROM world_meta WHERE key = ?", key);
    return row?.value == null ? null : String(row.value);
  }

  saveMeta(key: string, value: string): void {
    this.sql.exec("INSERT OR REPLACE INTO world_meta(key, value) VALUES (?, ?)", key, value);
  }

  // ---- internals ----

  /** Execute a query and return rows as plain object records. */
  private all(query: string, ...params: SqlStorageValue[]): Row[] {
    return this.sql.exec(query, ...params).toArray() as Row[];
  }

  /** Execute a query expected to return at most one row. */
  private one(query: string, ...params: SqlStorageValue[]): Row | null {
    const rows = this.sql.exec(query, ...params).toArray() as Row[];
    return rows[0] ?? null;
  }

  private ensureHostedObject(id: ObjRef): void {
    if (!this.one("SELECT 1 FROM object WHERE id = ?", id)) {
      throw wooError("E_OBJNF", `object not hosted here: ${id}`, id);
    }
  }

  private deleteObjectRows(id: ObjRef): void {
    for (const table of ["event_schema", "content", "child", "verb", "property_version", "property_value", "property_def"]) {
      this.sql.exec(`DELETE FROM ${table} WHERE object_id = ?`, id);
    }
    this.sql.exec("DELETE FROM object WHERE id = ?", id);
  }

  private assertNoPendingLogOutcomes(): void {
    const row = this.one("SELECT space_id, seq FROM space_message WHERE applied_ok IS NULL LIMIT 1");
    if (row) {
      throw wooError("E_STORAGE", `pending log outcome at transaction commit: ${row.space_id}:${row.seq}`);
    }
  }

  private migrate(): void {
    // v0.5 schema upgrade: the verb table gained a `flags` column to persist
    // direct_callable / skip_presence_check. If we find an old verb table
    // without that column, drop everything and rebuild — the runtime cannot
    // fix flag-less verb rows without re-running catalog install. The next
    // request runs createWorld() against empty storage → fresh bootstrap.
    // Operator re-claims the wizard token after this one-time reset.
    const verbCols = this.tableColumns("verb");
    if (verbCols.size > 0 && !verbCols.has("flags")) {
      for (const table of SQL_LEGACY_RESET_TABLES) {
        this.sql.exec(`DROP TABLE IF EXISTS ${table}`);
      }
    }

    // Schema mirrors src/server/sqlite-repository.ts via sql-shape.ts.
    // CF Workers SQL doesn't support multi-statement exec in one call, so each
    // CREATE TABLE / CREATE INDEX runs separately.
    for (const stmt of SQL_SCHEMA_STATEMENTS) this.sql.exec(stmt);
    this.ensureColumn("session", "current_location", "TEXT");
    this.ensureColumn("session", "apikey_id", "TEXT");
    this.ensureColumn("space_message", "observations", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureNullableSpaceMessageOutcome();
    this.ensureColumn("verb", "flags", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureOrderedVerbTable();
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    if (this.tableColumns(table).has(column)) return;
    this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private tableColumns(table: string): Set<string> {
    return new Set(this.all(`PRAGMA table_info(${table})`).map((row) => String(row.name)));
  }

  private ensureNullableSpaceMessageOutcome(): void {
    const rows = this.all("PRAGMA table_info(space_message)");
    const appliedOk = rows.find((row) => String(row.name) === "applied_ok");
    if (!appliedOk || Number(appliedOk.notnull ?? 0) === 0) return;
    // Current sequenced-call storage inserts a pending log row before behavior
    // outcome is known, then records applied_ok in the same outer transaction.
    // Older demo DBs used NOT NULL here, which rejects that pending state.
    for (const stmt of SQL_SPACE_MESSAGE_OUTCOME_REBUILD_STATEMENTS) this.sql.exec(stmt);
  }

  private ensureOrderedVerbTable(): void {
    if (this.tableColumns("verb").has("slot")) return;
    for (const stmt of SQL_VERB_ORDER_REBUILD_STATEMENTS) this.sql.exec(stmt);
  }
}
