import type {
  ParkedTaskRecord,
  SerializedObject,
  SerializedSession,
  SpaceSnapshotRecord
} from "./repository";
import { wooError, type ErrorValue, type Message, type Observation, type PresenceProjectionDef, type PropertyDef, type SpaceLogEntry, type VerbDef, type WooValue } from "./types";

export type SqlRow = Record<string, unknown>;

export const SQL_DELETE_TABLES = [
  "world_meta",
  "tombstone",
  "task",
  "space_snapshot",
  "space_message",
  "session",
  "event_schema",
  "content",
  "child",
  "verb",
  "property_version",
  "property_value",
  "property_def",
  "object"
] as const;

export const SQL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS object (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent TEXT,
    owner TEXT NOT NULL,
    location TEXT,
    anchor TEXT,
    flags INTEGER NOT NULL,
    created INTEGER NOT NULL,
    modified INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS property_def (
    object_id TEXT NOT NULL,
    name TEXT NOT NULL,
    default_val TEXT NOT NULL,
    type_hint TEXT,
    owner TEXT NOT NULL,
    perms TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    metadata TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (object_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS property_value (
    object_id TEXT NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (object_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS property_version (
    object_id TEXT NOT NULL,
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    PRIMARY KEY (object_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS verb (
    object_id TEXT NOT NULL,
    slot INTEGER NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    aliases TEXT NOT NULL,
    owner TEXT NOT NULL,
    perms TEXT NOT NULL,
    arg_spec TEXT NOT NULL,
    source TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    line_map TEXT NOT NULL,
    native TEXT,
    bytecode TEXT,
    flags TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (object_id, slot)
  )`,
  "CREATE INDEX IF NOT EXISTS verb_object_name ON verb(object_id, name)",
  `CREATE TABLE IF NOT EXISTS child (
    object_id TEXT NOT NULL,
    child_ref TEXT NOT NULL,
    PRIMARY KEY (object_id, child_ref)
  )`,
  `CREATE TABLE IF NOT EXISTS content (
    object_id TEXT NOT NULL,
    content_ref TEXT NOT NULL,
    PRIMARY KEY (object_id, content_ref)
  )`,
  `CREATE TABLE IF NOT EXISTS event_schema (
    object_id TEXT NOT NULL,
    type TEXT NOT NULL,
    schema TEXT NOT NULL,
    PRIMARY KEY (object_id, type)
  )`,
  `CREATE TABLE IF NOT EXISTS space_message (
    space_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    actor TEXT NOT NULL,
    message TEXT NOT NULL,
    observations TEXT NOT NULL DEFAULT '[]',
    applied_ok INTEGER,
    error TEXT,
    PRIMARY KEY (space_id, seq)
  )`,
  "CREATE INDEX IF NOT EXISTS space_message_ts ON space_message(space_id, ts)",
  `CREATE TABLE IF NOT EXISTS space_snapshot (
    space_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    state TEXT NOT NULL,
    hash TEXT NOT NULL,
    PRIMARY KEY (space_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS task (
    id TEXT PRIMARY KEY,
    parked_on TEXT NOT NULL,
    state TEXT NOT NULL,
    resume_at INTEGER,
    awaiting_player TEXT,
    correlation_id TEXT,
    serialized TEXT NOT NULL,
    created INTEGER NOT NULL,
    origin TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS task_parked_on ON task(parked_on)",
  "CREATE INDEX IF NOT EXISTS task_resume_at ON task(resume_at) WHERE state = 'suspended'",
  `CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    started INTEGER NOT NULL,
    expires_at INTEGER,
    last_detach_at INTEGER,
    token_class TEXT NOT NULL DEFAULT 'guest',
    current_location TEXT,
    apikey_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS world_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  // Recycled ULIDs. Per-host (each anchor cluster owns its own table).
  // Survives backup/restore. Per spec/reference/persistence.md §14.2.1.
  // Rows are immutable once written; recycle inserts in the same SQLite
  // transaction as the storage-row deletes.
  `CREATE TABLE IF NOT EXISTS tombstone (
    id TEXT PRIMARY KEY,
    recycled_at INTEGER NOT NULL,
    reason TEXT
  )`
] as const;

export const SQL_SCHEMA_SCRIPT = `${SQL_SCHEMA_STATEMENTS.join(";\n")};`;

export function sqlGroupBy<T extends SqlRow>(rows: T[], key: string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const value = String(row[key]);
    groups.set(value, [...(groups.get(value) ?? []), row]);
  }
  return groups;
}

export function stringifySqlValue(value: WooValue): string {
  return JSON.stringify(value);
}

export function parseSqlValue(value: unknown): WooValue {
  try {
    return JSON.parse(String(value));
  } catch (err) {
    throw wooError("E_STORAGE", "invalid JSON value in SQL repository", err instanceof Error ? err.message : String(err));
  }
}

export function propertyDefFromSqlRow(row: SqlRow, name = String(row.name)): PropertyDef {
  const metadata = row.metadata == null ? {} : parseSqlValue(row.metadata);
  const presenceProjection = presenceProjectionFromMetadata(metadata);
  return {
    name,
    defaultValue: parseSqlValue(String(row.default_val)),
    typeHint: row.type_hint == null ? undefined : String(row.type_hint),
    owner: String(row.owner),
    perms: String(row.perms),
    version: Number(row.version),
    ...(presenceProjection ? { presenceProjection } : {})
  };
}

export function propertyDefMetadataJson(def: PropertyDef): string {
  const metadata: Record<string, WooValue> = {};
  if (def.presenceProjection) metadata.presenceProjection = def.presenceProjection as unknown as WooValue;
  return stringifySqlValue(metadata);
}

export function presenceProjectionFromMetadata(metadata: unknown): PresenceProjectionDef | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const raw = (metadata as Record<string, unknown>).presenceProjection;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.kind !== "presence") return undefined;
  if (record.key === "actor") return { kind: "presence", key: "actor" };
  if (
    record.key === "session" &&
    typeof record.sessionField === "string" &&
    record.sessionField.length > 0 &&
    typeof record.actorField === "string" &&
    record.actorField.length > 0
  ) {
    return {
      kind: "presence",
      key: "session",
      sessionField: record.sessionField,
      actorField: record.actorField
    };
  }
  return undefined;
}

export function flagsToSqlInt(flags: SerializedObject["flags"]): number {
  return (flags.wizard ? 1 : 0) | (flags.programmer ? 2 : 0) | (flags.fertile ? 4 : 0);
}

export function flagsFromSqlInt(flags: number): SerializedObject["flags"] {
  return {
    wizard: Boolean(flags & 1),
    programmer: Boolean(flags & 2),
    fertile: Boolean(flags & 4)
  };
}

export function verbFromSqlRow(row: SqlRow): VerbDef {
  const flags = row.flags ? (parseSqlValue(row.flags) as Record<string, unknown>) : {};
  const base = {
    slot: row.slot == null ? undefined : Number(row.slot),
    name: String(row.name),
    aliases: parseSqlValue(row.aliases) as string[],
    owner: String(row.owner),
    perms: String(row.perms),
    arg_spec: parseSqlValue(row.arg_spec) as Record<string, WooValue>,
    source: String(row.source),
    source_hash: String(row.source_hash),
    version: Number(row.version),
    line_map: parseSqlValue(row.line_map) as Record<string, WooValue>,
    direct_callable: flags.direct_callable === true ? true : undefined,
    skip_presence_check: flags.skip_presence_check === true ? true : undefined,
    tool_exposed: flags.tool_exposed === true ? true : undefined,
    reads_room_presence: flags.reads_room_presence === true ? true : undefined,
    reads_ordered_children: flags.reads_ordered_children === true ? true : undefined,
    pure: flags.pure === true ? true : undefined,
    pure_declared: flags.pure_declared === true ? true : undefined,
    calls: Array.isArray(flags.calls) ? flags.calls as VerbDef extends { calls?: infer C } ? C : never : undefined
  };
  if (row.kind === "native") return { ...base, kind: "native", native: String(row.native ?? "") };
  return { ...base, kind: "bytecode", bytecode: parseSqlValue(row.bytecode) as VerbDef extends { bytecode: infer B } ? B : never };
}

export function verbFlagsJson(verb: VerbDef): string {
  const flags: Record<string, unknown> = {};
  if (verb.direct_callable === true) flags.direct_callable = true;
  if (verb.skip_presence_check === true) flags.skip_presence_check = true;
  if (verb.tool_exposed === true) flags.tool_exposed = true;
  if (verb.reads_room_presence === true) flags.reads_room_presence = true;
  if (verb.reads_ordered_children === true) flags.reads_ordered_children = true;
  if (verb.pure === true) flags.pure = true;
  if (verb.pure_declared === true) flags.pure_declared = true;
  // Always persist the calls array when defined, even empty: an empty array
  // means "compiled with the extractor, no call sites" and is distinct from
  // a missing field (legacy world predating the extractor).
  if (Array.isArray(verb.calls)) flags.calls = verb.calls;
  return JSON.stringify(flags);
}

export function snapshotFromSqlRow(row: SqlRow): SpaceSnapshotRecord {
  return {
    space_id: String(row.space_id),
    seq: Number(row.seq),
    ts: Number(row.ts),
    state: parseSqlValue(row.state),
    hash: String(row.hash)
  };
}

export function taskFromSqlRow(row: SqlRow): ParkedTaskRecord {
  return {
    id: String(row.id),
    parked_on: String(row.parked_on),
    state: row.state as ParkedTaskRecord["state"],
    resume_at: row.resume_at === null || row.resume_at === undefined ? null : Number(row.resume_at),
    awaiting_player: row.awaiting_player === null || row.awaiting_player === undefined ? null : String(row.awaiting_player),
    correlation_id: row.correlation_id === null || row.correlation_id === undefined ? null : String(row.correlation_id),
    serialized: parseSqlValue(row.serialized),
    created: Number(row.created),
    origin: String(row.origin)
  };
}

export function sessionFromSqlRow(row: SqlRow): SerializedSession {
  return {
    id: String(row.id),
    actor: String(row.actor),
    started: Number(row.started),
    expiresAt: row.expires_at === null || row.expires_at === undefined ? undefined : Number(row.expires_at),
    lastDetachAt: row.last_detach_at === null || row.last_detach_at === undefined ? null : Number(row.last_detach_at),
    tokenClass: row.token_class as "guest" | "bearer" | "apikey" | undefined,
    activeScope: row.current_location === null || row.current_location === undefined ? null : String(row.current_location),
    ...(row.apikey_id === null || row.apikey_id === undefined ? {} : { apikeyId: String(row.apikey_id) })
  };
}

export function logEntryFromSqlRow(row: SqlRow): SpaceLogEntry {
  if (row.applied_ok === null || row.applied_ok === undefined) {
    throw wooError("E_STORAGE", `log entry has no committed outcome: ${row.space_id}:${row.seq}`);
  }
  return {
    space: String(row.space_id),
    seq: Number(row.seq),
    ts: Number(row.ts),
    actor: String(row.actor),
    message: parseSqlValue(row.message) as unknown as Message,
    observations: row.observations ? (parseSqlValue(row.observations) as unknown as Observation[]) : [],
    applied_ok: Boolean(row.applied_ok),
    error: row.error ? (parseSqlValue(row.error) as unknown as ErrorValue) : undefined
  };
}
