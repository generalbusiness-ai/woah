import type { EffectTranscript } from "./effect-transcript";
import type { ParkedTaskRecord, SerializedObject, SerializedSession, SpaceSnapshotRecord } from "./repository";
import type { ShadowCommitAccepted, ShadowScopeHead } from "./shadow-commit-scope";
import type { ObjRef, RemoteToolDescriptor, SpaceLogEntry, WooValue } from "./types";

export type CounterKey = "objectCounter" | "sessionCounter" | "parkedTaskCounter";

export type RowOp<Key> = {
  key: Key;
  op: "upsert" | "delete";
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

export type ProjectionWrite =
  | { table: "objects"; key: ObjRef; op: "upsert"; row: SerializedObject; bytes: number }
  | { table: "objects"; key: ObjRef; op: "delete"; bytes: 0 }
  | { table: "sessions"; key: string; op: "upsert"; row: SerializedSession; bytes: number }
  | { table: "sessions"; key: string; op: "delete"; bytes: 0 }
  | { table: "logs"; key: { space: ObjRef; seq: number }; op: "upsert"; row: SpaceLogEntry; bytes: number }
  | { table: "logs"; key: { space: ObjRef; seq: number }; op: "delete"; bytes: 0 }
  | { table: "snapshots"; key: { space: ObjRef; seq: number }; op: "upsert"; row: SpaceSnapshotRecord; bytes: number }
  | { table: "snapshots"; key: { space: ObjRef; seq: number }; op: "delete"; bytes: 0 }
  | { table: "parked_tasks"; key: string; op: "upsert"; row: ParkedTaskRecord; bytes: number }
  | { table: "parked_tasks"; key: string; op: "delete"; bytes: 0 }
  | { table: "counters"; key: CounterKey; op: "upsert"; value: number; bytes: number }
  | { table: "tombstones"; key: ObjRef; op: "upsert"; row: { id: ObjRef }; bytes: number }
  | { table: "tombstones"; key: ObjRef; op: "delete"; bytes: 0 }
  | { table: "tool_surfaces"; key: { scope: ObjRef; object: ObjRef }; op: "upsert"; row: ToolSurfaceProjectionRow; bytes: number }
  | { table: "tool_surfaces"; key: { scope: ObjRef; object: ObjRef }; op: "delete"; bytes: 0 };

export type AcceptedFrameTransfer = {
  frame: ShadowCommitAccepted;
  projection_writes: ProjectionWrite[];
};

export type OpenTransfer =
  | {
      kind: "frames";
      from: ShadowScopeHead;
      to: ShadowScopeHead;
      frames: AcceptedFrameTransfer[];
      continuation?: OpenContinuation;
    }
  | {
      kind: "checkpoint";
      checkpoint: ScopeCheckpoint;
      continuation?: OpenContinuation;
    };

export type OpenContinuation = {
  token: string;
  export_id: string;
  head: ShadowScopeHead;
  checkpoint_hash?: string;
  expires_at_ms: number;
};

export type CheckpointTailOpenTransfer = {
  kind: "woo.open.checkpoint_tail.v1";
  scope: ObjRef;
  head: ShadowScopeHead;
  transfer: OpenTransfer;
  viewer?: { actor: ObjRef; session?: string | null };
};

export type ProjectionPage =
  | {
      kind: "woo.projection_page.v1";
      table: "objects";
      page: string;
      hash: string;
      rows: SerializedObject[];
    }
  | {
      kind: "woo.projection_page.v1";
      table: "sessions";
      page: string;
      hash: string;
      rows: SerializedSession[];
    }
  | {
      kind: "woo.projection_page.v1";
      table: "logs";
      page: string;
      hash: string;
      rows: Array<{ space: ObjRef; entry: SpaceLogEntry }>;
    }
  | {
      kind: "woo.projection_page.v1";
      table: "snapshots";
      page: string;
      hash: string;
      rows: SpaceSnapshotRecord[];
    }
  | {
      kind: "woo.projection_page.v1";
      table: "parked_tasks";
      page: string;
      hash: string;
      rows: ParkedTaskRecord[];
    }
  | {
      kind: "woo.projection_page.v1";
      table: "tombstones";
      page: string;
      hash: string;
      rows: Array<{ id: ObjRef }>;
    }
  | {
      kind: "woo.projection_page.v1";
      table: "tool_surfaces";
      page: string;
      hash: string;
      rows: ToolSurfaceProjectionRow[];
    };

export type ScopeCheckpoint = {
  kind: "woo.scope_checkpoint.v1";
  scope: ObjRef;
  head: ShadowScopeHead;
  checkpoint_hash: string;
  pages: ProjectionPage[];
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

export function projectionWriteIdentity(write: ProjectionWrite): string {
  return `${write.table}:${JSON.stringify(write.key)}`;
}

export function coalesceProjectionWrites(writes: ProjectionWrite[]): ProjectionWrite[] {
  const byKey = new Map<string, ProjectionWrite>();
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

export function summarizeProjectionWrites(writes: ProjectionWrite[]): ProjectionDeltaSummary {
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

function compareProjectionWrites(a: ProjectionWrite, b: ProjectionWrite): number {
  const table = a.table.localeCompare(b.table);
  if (table !== 0) return table;
  return JSON.stringify(a.key).localeCompare(JSON.stringify(b.key));
}
