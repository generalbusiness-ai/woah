import type { EffectTranscript } from "./effect-transcript";
import type { ParkedTaskRecord, SerializedObject, SerializedSession, SerializedWorld, SpaceSnapshotRecord } from "./repository";
import { stableShadowJson } from "./shadow-cell-version";
import type { ShadowCommitAccepted, ShadowScopeHead } from "./shadow-commit-scope";
import { hashSource } from "./source-hash";
import { cloneValue, type ObjRef, type Observation, type PropertyDef, type RemoteToolDescriptor, type SpaceLogEntry, type WooValue } from "./types";

export type CounterKey = "objectCounter" | "sessionCounter" | "parkedTaskCounter";

export type RowOp<Key> = {
  key: Key;
  op: "upsert" | "delete";
  // Kept during the data-path measurement rollout. Receiver-specific transfer
  // byte totals live on profiled rows, while the summary remains key/op common.
  bytes: number;
};

export type ProjectionFreshness = {
  scope: ObjRef;
  last_apply_seq: number;
  last_apply_hash: string;
  updated_at_ms: number;
  stale: boolean;
  stale_reason?: "owner_timeout" | "retention_gap" | "cache_miss" | "disabled";
};

export type ToolSurfaceProjectionRow = {
  kind: "woo.tool_surface_projection.v1";
  scope: ObjRef;
  object: ObjRef;
  head: ShadowScopeHead;
  verbs: Array<{
    name: string;
    owner: ObjRef;
    perms: string;
    args?: WooValue[];
    help?: string;
    aliases?: string[];
    arg_spec?: Record<string, WooValue>;
    direct?: boolean;
    reads_room_presence?: boolean;
    reads_ordered_children?: boolean;
    source?: string;
    enclosingSpace?: ObjRef | null;
  }>;
  source_rows: Array<{ table: "objects"; authority_scope: ObjRef; key: ObjRef }>;
};

export type SessionToolManifest = {
  kind: "woo.session_tool_manifest.v1";
  session_id: string;
  actor: ObjRef;
  active_scope: ObjRef;
  tools: RemoteToolDescriptor[];
  source_surfaces: Array<{ scope: ObjRef; object: ObjRef; head: ShadowScopeHead }>;
  last_apply_seq: number;
  last_apply_hash: string;
  updated_at_ms: number;
  expires_at_ms: number;
  stale?: boolean;
  stale_reason?: ProjectionFreshness["stale_reason"];
};

export type ProjectionDeltaSummary = {
  objects?: RowOp<ObjRef>[];
  sessions?: RowOp<string>[];
  logs?: RowOp<{ space: ObjRef; seq: number }>[];
  counters?: RowOp<CounterKey>[];
  snapshots?: RowOp<{ space: ObjRef; seq: number }>[];
  parked_tasks?: RowOp<string>[];
  tombstones?: RowOp<ObjRef>[];
  tool_surfaces?: RowOp<{ scope: ObjRef; object: ObjRef }>[];
  tool_surface_sources?: RowOp<{ table: "objects"; authority_scope: ObjRef; key: ObjRef }>[];
  projection_bytes: number;
};

export type ProjectionProfile = {
  objects: unknown;
  sessions: unknown;
  logs: unknown;
  snapshots: unknown;
  parked_tasks: unknown;
  counters: unknown;
  tombstones: unknown;
  tool_surfaces: unknown;
};

export type AuthorityProfile = {
  objects: SerializedObject;
  sessions: SerializedSession;
  logs: SpaceLogEntry;
  snapshots: SpaceSnapshotRecord;
  parked_tasks: ParkedTaskRecord;
  counters: { value: number };
  tombstones: { id: ObjRef };
  tool_surfaces: ToolSurfaceProjectionRow;
};

export type BrowserObjectDisplay = {
  id: ObjRef;
  name: string;
  parent?: ObjRef | null;
  ancestors?: ObjRef[];
  owner?: ObjRef;
  location?: ObjRef | null;
  aliases?: string[];
  description?: WooValue | null;
  props?: Record<string, WooValue>;
};

export type BrowserObjectRow = {
  kind: "woo.browser_object_row.v1";
  id: ObjRef;
  scope: ObjRef;
  head: ShadowScopeHead;
  name?: string;
  display: BrowserObjectDisplay;
  location?: ObjRef | null;
  contents?: ObjRef[];
};

export type BrowserSessionRow = {
  kind: "woo.browser_session_row.v1";
  session_id: string;
  actor: ObjRef;
  active_scope: ObjRef | null;
  head: ShadowScopeHead;
};

export type BrowserLogRow = {
  kind: "woo.browser_log_row.v1";
  scope: ObjRef;
  seq: number;
  observations: Observation[];
  head: ShadowScopeHead;
};

export type BrowserToolRow = {
  kind: "woo.browser_tool_row.v1";
  scope: ObjRef;
  object: ObjRef;
  verbs: RemoteToolDescriptor[];
  head: ShadowScopeHead;
};

export type BrowserProfile = {
  objects: BrowserObjectRow;
  sessions: BrowserSessionRow;
  logs: BrowserLogRow;
  snapshots: never;
  parked_tasks: never;
  counters: never;
  tombstones: { id: ObjRef };
  tool_surfaces: BrowserToolRow;
};

export type ProjectionKey<T extends keyof ProjectionProfile> =
  T extends "objects" ? ObjRef :
  T extends "sessions" ? string :
  T extends "logs" ? { space: ObjRef; seq: number } :
  T extends "snapshots" ? { space: ObjRef; seq: number } :
  T extends "parked_tasks" ? string :
  T extends "counters" ? CounterKey :
  T extends "tombstones" ? ObjRef :
  T extends "tool_surfaces" ? { scope: ObjRef; object: ObjRef } :
  never;

type ProjectionWriteForTable<P extends ProjectionProfile, T extends keyof ProjectionProfile> =
  P[T] extends never ? never :
  T extends "counters"
    ? { table: T; key: ProjectionKey<T>; op: "upsert"; value: number; bytes: number }
    : | { table: T; key: ProjectionKey<T>; op: "upsert"; row: P[T]; bytes: number }
      | { table: T; key: ProjectionKey<T>; op: "delete"; bytes: 0 };

export type ProjectionWrite<P extends ProjectionProfile = AuthorityProfile> = {
  [T in keyof ProjectionProfile]: ProjectionWriteForTable<P, T>
}[keyof ProjectionProfile];

export type AcceptedFrameTransfer<P extends ProjectionProfile = AuthorityProfile> = {
  frame: ShadowCommitAccepted;
  projection_writes: ProjectionWrite<P>[];
};

export type OpenTransfer<P extends ProjectionProfile = AuthorityProfile> =
  | {
      kind: "frames";
      from: ShadowScopeHead;
      to: ShadowScopeHead;
      frames: AcceptedFrameTransfer<P>[];
      continuation?: OpenContinuation;
    }
  | {
      kind: "checkpoint";
      checkpoint: ScopeCheckpoint<P>;
      continuation?: OpenContinuation;
    };

export type OpenContinuation = {
  token: string;
  export_id: string;
  head: ShadowScopeHead;
  checkpoint_hash?: string;
  expires_at_ms: number;
};

export type CheckpointTailOpenTransfer<P extends ProjectionProfile = AuthorityProfile> = {
  kind: "woo.open.checkpoint_tail.v1";
  scope: ObjRef;
  head: ShadowScopeHead;
  transfer: OpenTransfer<P>;
  viewer: { actor: ObjRef; session?: string | null };
};

type ProjectionPageForTable<P extends ProjectionProfile, T extends keyof ProjectionProfile> =
  T extends "counters" ? never :
  P[T] extends never ? never : {
    kind: "woo.projection_page.v1";
    table: T;
    page: string;
    hash: string;
    rows: P[T][];
  };

export type ProjectionPage<P extends ProjectionProfile = AuthorityProfile> = {
  [T in keyof ProjectionProfile]: ProjectionPageForTable<P, T>
}[keyof ProjectionProfile];

export type ScopeCheckpoint<P extends ProjectionProfile = AuthorityProfile> = {
  kind: "woo.scope_checkpoint.v1";
  scope: ObjRef;
  head: ShadowScopeHead;
  checkpoint_hash: string;
  pages: ProjectionPage<P>[];
  frame_tail: ShadowCommitAccepted[];
};

export type FanoutEnvelope = {
  frame: ShadowCommitAccepted;
  fanout_observations: EffectTranscript["observations"];
  projection_delta: ProjectionDeltaSummary;
  projection_writes: ProjectionWrite[];
};

export type ApplyResult = {
  accepted_frame: ShadowCommitAccepted;
  projection_delta: ProjectionDeltaSummary;
  projection_writes: ProjectionWrite[];
  fanout_observations: EffectTranscript["observations"];
  reply_rows: WooValue[];
  idempotency_rows: Array<{ idempotency_key: string; seen_at: number }>;
};

const ROW_BYTES_ENCODER = new TextEncoder();

export function projectionRowBytes(value: unknown): number {
  return ROW_BYTES_ENCODER.encode(JSON.stringify(value)).byteLength;
}

export function projectionWriteIdentity(write: ProjectionWrite<ProjectionProfile>): string {
  return `${write.table}:${JSON.stringify(write.key)}`;
}

export function coalesceProjectionWrites<P extends ProjectionProfile = AuthorityProfile>(writes: readonly ProjectionWrite<P>[]): ProjectionWrite<P>[] {
  const byKey = new Map<string, ProjectionWrite<P>>();
  for (const write of writes) byKey.set(projectionWriteIdentity(write), write);
  return Array.from(byKey.values()).sort(compareProjectionWrites);
}

export function projectionDeltaMissingWrites(delta: ProjectionDeltaSummary, writes: readonly ProjectionWrite[]): string[] {
  const byKey = new Map<string, ProjectionWrite>();
  for (const write of writes) byKey.set(projectionWriteIdentity(write), write);
  const missing: string[] = [];
  const requireRows = <Key>(table: ProjectionWrite["table"], ops: readonly RowOp<Key>[] | undefined): void => {
    for (const op of ops ?? []) {
      const identity = `${table}:${JSON.stringify(op.key)}`;
      const write = byKey.get(identity);
      if (!write) {
        missing.push(`${identity}:missing`);
        continue;
      }
      if (write.op !== op.op) {
        missing.push(`${identity}:op:${write.op}->${op.op}`);
        continue;
      }
      if (op.op === "upsert" && !projectionWriteHasBody(write)) {
        missing.push(`${identity}:body`);
      }
    }
  };

  requireRows("objects", delta.objects);
  requireRows("sessions", delta.sessions);
  requireRows("logs", delta.logs);
  requireRows("counters", delta.counters);
  requireRows("snapshots", delta.snapshots);
  requireRows("parked_tasks", delta.parked_tasks);
  requireRows("tombstones", delta.tombstones);
  requireRows("tool_surfaces", delta.tool_surfaces);
  // tool_surface_sources are cache-invalidation markers for rows that may have
  // contributed to cached descriptors. They are not materialized projection
  // rows, so there is no row body to require in projection_writes.
  return missing;
}

function projectionWriteHasBody(write: ProjectionWrite): boolean {
  if (write.op === "delete") return true;
  return "row" in write || "value" in write;
}

export function summarizeProjectionWrites(writes: readonly ProjectionWrite[]): ProjectionDeltaSummary {
  const delta: ProjectionDeltaSummary = { projection_bytes: 0 };
  const add = <Key>(field: keyof Omit<ProjectionDeltaSummary, "projection_bytes">, op: RowOp<Key>): void => {
    const current = (delta[field] ?? []) as RowOp<Key>[];
    current.push(op);
    (delta as Record<string, unknown>)[field] = current;
    delta.projection_bytes += op.bytes;
  };
  for (const write of writes) {
    switch (write.table) {
      case "objects":
        add("objects", { key: write.key, op: write.op, bytes: write.bytes });
        break;
      case "sessions":
        add("sessions", { key: write.key, op: write.op, bytes: write.bytes });
        break;
      case "logs":
        add("logs", { key: write.key, op: write.op, bytes: write.bytes });
        break;
      case "snapshots":
        add("snapshots", { key: write.key, op: write.op, bytes: write.bytes });
        break;
      case "parked_tasks":
        add("parked_tasks", { key: write.key, op: write.op, bytes: write.bytes });
        break;
      case "counters":
        add("counters", { key: write.key, op: write.op, bytes: write.bytes });
        break;
      case "tombstones":
        add("tombstones", { key: write.key, op: write.op, bytes: write.bytes });
        break;
      case "tool_surfaces":
        add("tool_surfaces", { key: write.key, op: write.op, bytes: write.bytes });
        break;
    }
  }
  return delta;
}

export function projectionDeltaWithToolSurfaceSourceMarkers(
  delta: ProjectionDeltaSummary,
  authorityScope: ObjRef
): ProjectionDeltaSummary {
  const objectOps = delta.objects ?? [];
  if (objectOps.length === 0) return delta;
  const byKey = new Map<string, RowOp<{ table: "objects"; authority_scope: ObjRef; key: ObjRef }>>();
  for (const marker of delta.tool_surface_sources ?? []) {
    byKey.set(toolSurfaceSourceMarkerIdentity(marker.key), marker);
  }
  for (const op of objectOps) {
    const key = { table: "objects" as const, authority_scope: authorityScope, key: op.key };
    // Source markers have no row body. They bound remote tool-surface
    // invalidation fanout without inflating projection byte accounting.
    byKey.set(toolSurfaceSourceMarkerIdentity(key), { key, op: op.op, bytes: 0 });
  }
  return {
    ...delta,
    tool_surface_sources: Array.from(byKey.values()).sort(compareToolSurfaceSourceMarkers)
  };
}

function toolSurfaceSourceMarkerIdentity(key: { table: "objects"; authority_scope: ObjRef; key: ObjRef }): string {
  return `${key.table}:${key.authority_scope}:${key.key}`;
}

function compareToolSurfaceSourceMarkers(
  a: RowOp<{ table: "objects"; authority_scope: ObjRef; key: ObjRef }>,
  b: RowOp<{ table: "objects"; authority_scope: ObjRef; key: ObjRef }>
): number {
  const table = a.key.table.localeCompare(b.key.table);
  if (table !== 0) return table;
  const scope = a.key.authority_scope.localeCompare(b.key.authority_scope);
  if (scope !== 0) return scope;
  return a.key.key.localeCompare(b.key.key);
}

function compareProjectionWrites(a: ProjectionWrite<ProjectionProfile>, b: ProjectionWrite<ProjectionProfile>): number {
  const table = a.table.localeCompare(b.table);
  if (table !== 0) return table;
  return JSON.stringify(a.key).localeCompare(JSON.stringify(b.key));
}

export type BrowserProjectionViewer = { actor: ObjRef; session?: string | null };

export type BrowserProfileProjectionContext = {
  serialized: SerializedWorld;
  index: ProjectionSerializedIndex;
};

export function browserProfileProjectionContext(serialized: SerializedWorld): BrowserProfileProjectionContext {
  // Browser-profile conversion may project many object rows from one committed
  // frame or checkpoint page. Build the inherited property index once, then
  // overlay each row being projected so per-row cost is proportional to lineage
  // depth instead of all objects in the scope.
  return {
    serialized,
    index: projectionSerializedIndex(serialized)
  };
}

export function browserProfileOpenTransferFromAuthority(input: {
  transfer: OpenTransfer;
  serialized: SerializedWorld;
  viewer: BrowserProjectionViewer;
}): OpenTransfer<BrowserProfile> {
  const context = browserProfileProjectionContext(input.serialized);
  if (input.transfer.kind === "frames") {
    return {
      ...input.transfer,
      frames: input.transfer.frames.map((frame) => ({
        frame: frame.frame,
        projection_writes: frame.projection_writes
          .map((write) => browserProfileProjectionWriteFromAuthority({
            write,
            context,
            scope: frame.frame.position.scope,
            head: frame.frame.position,
            viewer: input.viewer
          }))
          .filter((write): write is ProjectionWrite<BrowserProfile> => write !== null)
      }))
    };
  }
  return {
    ...input.transfer,
    checkpoint: browserProfileScopeCheckpointFromAuthority({
      checkpoint: input.transfer.checkpoint,
      context,
      viewer: input.viewer
    })
  };
}

export function browserProfileScopeCheckpointFromAuthority(input: {
  checkpoint: ScopeCheckpoint;
  serialized?: SerializedWorld;
  context?: BrowserProfileProjectionContext;
  viewer: BrowserProjectionViewer;
}): ScopeCheckpoint<BrowserProfile> {
  const context = input.context ?? browserProfileProjectionContext(requiredSerialized(input.serialized));
  const pages = input.checkpoint.pages
    .map((page) => browserProfileProjectionPageFromAuthority({
      page,
      scope: input.checkpoint.scope,
      head: input.checkpoint.head,
      context,
      viewer: input.viewer
    }))
    .filter((page): page is ProjectionPage<BrowserProfile> => page !== null);
  // Continuation chunks carry different page subsets, so the browser-facing
  // checkpoint hash must key the whole transformed export, not the current
  // chunk's rows.
  const checkpointHashMaterial = {
    kind: "woo.scope_checkpoint_browser_hash.v1",
    scope: input.checkpoint.scope,
    head: input.checkpoint.head,
    authority_checkpoint_hash: input.checkpoint.checkpoint_hash,
    viewer: { actor: input.viewer.actor, session: input.viewer.session ?? null }
  };
  return {
    kind: "woo.scope_checkpoint.v1",
    scope: input.checkpoint.scope,
    head: input.checkpoint.head,
    checkpoint_hash: hashSource(stableShadowJson(checkpointHashMaterial as unknown as WooValue)),
    pages,
    frame_tail: input.checkpoint.frame_tail
  };
}

export function browserProfileProjectionWriteFromAuthority(input: {
  write: ProjectionWrite;
  serialized?: SerializedWorld;
  context?: BrowserProfileProjectionContext;
  scope: ObjRef;
  head: ShadowScopeHead;
  viewer: BrowserProjectionViewer;
}): ProjectionWrite<BrowserProfile> | null {
  const { write, scope, head, viewer } = input;
  const context = input.context ?? browserProfileProjectionContext(requiredSerialized(input.serialized));
  switch (write.table) {
    case "objects":
      return write.op === "delete"
        ? { table: "objects", key: write.key, op: "delete", bytes: 0 }
        : browserProjectionWrite("objects", write.key, browserObjectRow(context.index, scope, head, write.row, viewer));
    case "sessions":
      return write.op === "delete"
        ? { table: "sessions", key: write.key, op: "delete", bytes: 0 }
        : browserProjectionWrite("sessions", write.key, browserSessionRow(write.row, head));
    case "logs":
      return write.op === "delete"
        ? { table: "logs", key: write.key, op: "delete", bytes: 0 }
        : browserProjectionWrite("logs", write.key, browserLogRow(write.row, head));
    case "tombstones":
      return write.op === "delete"
        ? { table: "tombstones", key: write.key, op: "delete", bytes: 0 }
        : browserProjectionWrite("tombstones", write.key, { id: write.row.id });
    case "tool_surfaces":
      return write.op === "delete"
        ? { table: "tool_surfaces", key: write.key, op: "delete", bytes: 0 }
        : browserProjectionWrite("tool_surfaces", write.key, browserToolRow(write.row, head));
    case "snapshots":
    case "parked_tasks":
    case "counters":
      return null;
  }
}

function browserProfileProjectionPageFromAuthority(input: {
  page: ProjectionPage;
  scope: ObjRef;
  head: ShadowScopeHead;
  context: BrowserProfileProjectionContext;
  viewer: BrowserProjectionViewer;
}): ProjectionPage<BrowserProfile> | null {
  const { page, scope, head, context, viewer } = input;
  switch (page.table) {
    case "objects":
      return browserProjectionPage("objects", page.page, page.rows.map((row) => browserObjectRow(context.index, scope, head, row, viewer)));
    case "sessions":
      return browserProjectionPage("sessions", page.page, page.rows.map((row) => browserSessionRow(row, head)));
    case "logs":
      return browserProjectionPage("logs", page.page, page.rows.map((row) => browserLogRow(authorityLogEntryFromPageRow(row), head)));
    case "tombstones":
      return browserProjectionPage("tombstones", page.page, page.rows.map((row) => ({ id: row.id })));
    case "tool_surfaces":
      return browserProjectionPage("tool_surfaces", page.page, page.rows.map((row) => browserToolRow(row, head)));
    case "snapshots":
    case "parked_tasks":
      return null;
  }
}

function authorityLogEntryFromPageRow(row: unknown): SpaceLogEntry {
  if (row && typeof row === "object" && !Array.isArray(row) && "entry" in row) {
    return (row as { entry: SpaceLogEntry }).entry;
  }
  return row as SpaceLogEntry;
}

function browserProjectionWrite<T extends keyof BrowserProfile>(
  table: T,
  key: ProjectionKey<T>,
  row: BrowserProfile[T]
): ProjectionWrite<BrowserProfile> {
  return { table, key, op: "upsert", row, bytes: projectionRowBytes(row) } as ProjectionWrite<BrowserProfile>;
}

function browserProjectionPage<T extends keyof BrowserProfile>(
  table: T,
  page: string,
  rows: BrowserProfile[T][]
): ProjectionPage<BrowserProfile> {
  const material = { kind: "woo.projection_page_material.v1", table, page, rows };
  return {
    kind: "woo.projection_page.v1",
    table,
    page,
    hash: hashSource(stableShadowJson(material as unknown as WooValue)),
    rows
  } as ProjectionPage<BrowserProfile>;
}

function browserSessionRow(session: SerializedSession, head: ShadowScopeHead): BrowserSessionRow {
  return {
    kind: "woo.browser_session_row.v1",
    session_id: session.id,
    actor: session.actor,
    active_scope: session.activeScope ?? session.currentLocation ?? null,
    head
  };
}

function browserLogRow(entry: SpaceLogEntry, head: ShadowScopeHead): BrowserLogRow {
  return {
    kind: "woo.browser_log_row.v1",
    scope: entry.space,
    seq: entry.seq,
    observations: structuredClone(entry.observations) as Observation[],
    head
  };
}

function browserToolRow(row: ToolSurfaceProjectionRow, head: ShadowScopeHead): BrowserToolRow {
  return {
    kind: "woo.browser_tool_row.v1",
    scope: row.scope,
    object: row.object,
    verbs: row.verbs.map((verb) => ({
      object: row.object,
      verb: verb.name,
      aliases: verb.aliases ?? [],
      arg_spec: verb.arg_spec ?? {},
      direct: verb.direct === true,
      ...(verb.reads_room_presence === true ? { reads_room_presence: true } : {}),
      ...(verb.reads_ordered_children === true ? { reads_ordered_children: true } : {}),
      source: verb.source ?? "projection",
      enclosingSpace: verb.enclosingSpace ?? null,
      source_rows: row.source_rows
    })),
    head
  };
}

function browserObjectRow(
  baseIndex: ProjectionSerializedIndex,
  scope: ObjRef,
  head: ShadowScopeHead,
  obj: SerializedObject,
  viewer: BrowserProjectionViewer
): BrowserObjectRow {
  const index = projectionSerializedIndexWithObject(baseIndex, obj);
  const props = readableProps(index, obj, viewer.actor);
  const aliases = props.aliases;
  const display: BrowserObjectDisplay = {
    id: obj.id,
    name: obj.name,
    parent: obj.parent,
    ancestors: ancestors(index, obj.id),
    owner: obj.owner,
    location: obj.location,
    ...(Array.isArray(aliases) && aliases.every((item) => typeof item === "string") ? { aliases } : {}),
    description: props.description ?? null,
    props
  };
  return {
    kind: "woo.browser_object_row.v1",
    id: obj.id,
    scope,
    head,
    name: obj.name,
    display,
    location: obj.location,
    contents: [...obj.contents]
  };
}

function requiredSerialized(serialized: SerializedWorld | undefined): SerializedWorld {
  if (!serialized) throw new Error("browser-profile projection conversion requires serialized state or a projection context");
  return serialized;
}

type ProjectionSerializedIndex = {
  objects: Map<ObjRef, SerializedObject>;
  indexedObjects: Map<ObjRef, { properties: Map<string, WooValue>; propertyDefs: Map<string, PropertyDef> }>;
  objectOverrides?: Map<ObjRef, SerializedObject>;
  indexedObjectOverrides?: Map<ObjRef, { properties: Map<string, WooValue>; propertyDefs: Map<string, PropertyDef> }>;
};

function projectionSerializedIndex(serialized: SerializedWorld): ProjectionSerializedIndex {
  return {
    objects: new Map(serialized.objects.map((obj) => [obj.id, obj])),
    indexedObjects: new Map(serialized.objects.map((obj) => [obj.id, indexedSerializedObject(obj)] as const))
  };
}

function projectionSerializedIndexWithObject(index: ProjectionSerializedIndex, obj: SerializedObject): ProjectionSerializedIndex {
  return {
    ...index,
    objectOverrides: new Map([[obj.id, obj]]),
    indexedObjectOverrides: new Map([[obj.id, indexedSerializedObject(obj)]])
  };
}

function indexedSerializedObject(obj: SerializedObject): { properties: Map<string, WooValue>; propertyDefs: Map<string, PropertyDef> } {
  return {
    properties: new Map(obj.properties),
    propertyDefs: new Map(obj.propertyDefs.map((def) => [def.name, def] as const))
  };
}

function indexedObject(index: ProjectionSerializedIndex, id: ObjRef): { properties: Map<string, WooValue>; propertyDefs: Map<string, PropertyDef> } | undefined {
  return index.indexedObjectOverrides?.get(id) ?? index.indexedObjects.get(id);
}

function serializedObject(index: ProjectionSerializedIndex, id: ObjRef): SerializedObject | undefined {
  return index.objectOverrides?.get(id) ?? index.objects.get(id);
}

function readableProps(index: ProjectionSerializedIndex, obj: SerializedObject, actor?: ObjRef): Record<string, WooValue> {
  const props: Record<string, WooValue> = {};
  for (const name of propertyNames(index, obj.id)) {
    const resolved = propertyValue(index, obj.id, name);
    if (!resolved || resolved.value === undefined) continue;
    if (!canReadProperty(index, actor, resolved.owner, resolved.perms)) continue;
    props[name] = cloneValue(resolved.value);
  }
  return props;
}

function propertyNames(index: ProjectionSerializedIndex, objRef: ObjRef): string[] {
  const names = new Set<string>();
  let current = serializedObject(index, objRef) ?? null;
  const seen = new Set<ObjRef>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const indexed = indexedObject(index, current.id);
    for (const name of indexed?.propertyDefs.keys() ?? []) names.add(name);
    for (const name of indexed?.properties.keys() ?? []) names.add(name);
    current = current.parent ? serializedObject(index, current.parent) ?? null : null;
  }
  return Array.from(names).sort();
}

function propertyValue(
  index: ProjectionSerializedIndex,
  objRef: ObjRef,
  name: string
): { value: WooValue | undefined; owner: ObjRef; perms: string } | null {
  let current = serializedObject(index, objRef) ?? null;
  const seen = new Set<ObjRef>();
  let value: WooValue | undefined;
  let hasValue = false;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const indexed = indexedObject(index, current.id);
    if (!hasValue && indexed?.properties.has(name)) {
      value = indexed.properties.get(name);
      hasValue = true;
    }
    const def = indexed?.propertyDefs.get(name);
    if (def) return { value: hasValue ? value : def.defaultValue, owner: def.owner, perms: def.perms };
    current = current.parent ? serializedObject(index, current.parent) ?? null : null;
  }
  return null;
}

function ancestors(index: ProjectionSerializedIndex, objRef: ObjRef): ObjRef[] {
  const out: ObjRef[] = [];
  let current = serializedObject(index, objRef)?.parent ?? null;
  const seen = new Set<ObjRef>();
  while (current && !seen.has(current)) {
    out.push(current);
    seen.add(current);
    current = serializedObject(index, current)?.parent ?? null;
  }
  return out.reverse();
}

function canReadProperty(index: ProjectionSerializedIndex, actor: ObjRef | undefined, owner: ObjRef, perms: string): boolean {
  return Boolean(actor && (serializedObject(index, actor)?.flags?.wizard === true || owner === actor)) || String(perms).includes("r");
}
