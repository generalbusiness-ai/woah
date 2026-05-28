import type { ShadowCommitAccepted, ShadowScopeHead } from "../core/shadow-commit-scope";
import type {
  BrowserLogRow,
  BrowserObjectRow,
  BrowserProfile,
  BrowserSessionRow,
  BrowserToolRow,
  CheckpointTailOpenTransfer,
  ProjectionWrite
} from "../core/projection-delta";
import type { ObjRef } from "../core/types";

export type V2BrowserCheckpointTailOpenTransfer = CheckpointTailOpenTransfer<BrowserProfile>;

export type V2BrowserProjectionRowRecord =
  | { id: string; scope: string; table: "objects"; key: ObjRef; row: BrowserObjectRow }
  | { id: string; scope: string; table: "sessions"; key: string; row: BrowserSessionRow }
  | { id: string; scope: string; table: "logs"; key: string; space: ObjRef; row: BrowserLogRow }
  | { id: string; scope: string; table: "tombstones"; key: ObjRef; row: { id: ObjRef } }
  | { id: string; scope: string; table: "tool_surfaces"; key: string; row: BrowserToolRow };

export type V2BrowserProjectionRowRecordInput =
  | { scope: string; table: "objects"; key: ObjRef; row: BrowserObjectRow }
  | { scope: string; table: "sessions"; key: string; row: BrowserSessionRow }
  | { scope: string; table: "logs"; key: string; space: ObjRef; row: BrowserLogRow }
  | { scope: string; table: "tombstones"; key: ObjRef; row: { id: ObjRef } }
  | { scope: string; table: "tool_surfaces"; key: string; row: BrowserToolRow };

export type V2BrowserHolderInstallStore = {
  getMeta<T>(key: string): Promise<T | undefined>;
  putMeta(key: string, value: unknown): Promise<void>;
  projectionRowsForScope(scope: string): Promise<V2BrowserProjectionRowRecord[]>;
  getProjectionRow(scope: string, table: V2BrowserProjectionRowRecord["table"], key: string): Promise<V2BrowserProjectionRowRecord | undefined>;
  projectionRowCountForScopeTable(scope: string, table: V2BrowserProjectionRowRecord["table"]): Promise<number>;
  putProjectionRow(row: V2BrowserProjectionRowRecordInput): Promise<void>;
  deleteProjectionRow(scope: string, table: V2BrowserProjectionRowRecord["table"], key: string): Promise<void>;
  clearProjectionRows(scope: string): Promise<void>;
};

export type V2BrowserHolderProjectionInstall = {
  scope: string;
  head: ShadowScopeHead;
  projection: unknown;
};

type ProjectionViewer = CheckpointTailOpenTransfer["viewer"];

// This is the browser holder's phase-1 display install boundary. It installs
// row-body-complete projection writes and advances the scope head last, so a
// crash before head advance retries from the previous head while current-or-
// older accepted frames remain idempotent.
export async function installV2BrowserAcceptedFrameProjection(input: {
  store: V2BrowserHolderInstallStore;
  frame: ShadowCommitAccepted;
  writes: readonly ProjectionWrite<BrowserProfile>[];
  viewer: ProjectionViewer;
}): Promise<V2BrowserHolderProjectionInstall> {
  const current = await input.store.getMeta<ShadowScopeHead>(`head:${input.frame.position.scope}`);
  if (current && scopeHeadAtOrBeyond(current, input.frame.position)) {
    return {
      scope: input.frame.position.scope,
      head: current,
      projection: await projectionFromStoredRows(input.store, input.frame.position.scope, current, input.viewer)
    };
  }
  return await installProjectionWritesAtHead({
    store: input.store,
    scope: input.frame.position.scope,
    head: input.frame.position,
    writes: input.writes,
    viewer: input.viewer
  });
}

export async function installV2BrowserCheckpointTailProjection(input: {
  store: V2BrowserHolderInstallStore;
  transfer: V2BrowserCheckpointTailOpenTransfer;
}): Promise<V2BrowserHolderProjectionInstall | null> {
  const viewer = input.transfer.viewer;
  if (!viewer?.actor) throw new Error("checkpoint/tail transfer missing viewer");
  if (input.transfer.transfer.kind === "checkpoint") {
    return await installCheckpointProjection(input.store, input.transfer, viewer);
  }
  for (const frame of input.transfer.transfer.frames) {
    for (const write of frame.projection_writes) {
      await applyProjectionWriteToBrowserRows(input.store, input.transfer.scope, write);
    }
  }
  await input.store.putMeta(`head:${input.transfer.scope}`, input.transfer.transfer.to);
  await input.store.putMeta("catchup_required", false);
  return {
    scope: input.transfer.scope,
    head: input.transfer.transfer.to,
    projection: await projectionFromStoredRows(input.store, input.transfer.scope, input.transfer.transfer.to, viewer)
  };
}

export function v2BrowserProjectionRowId(
  scope: string,
  table: V2BrowserProjectionRowRecord["table"],
  key: string
): string {
  return `${scope}\u0000${table}\u0000${key}`;
}

async function installProjectionWritesAtHead(input: {
  store: V2BrowserHolderInstallStore;
  scope: string;
  head: ShadowScopeHead;
  writes: readonly ProjectionWrite<BrowserProfile>[];
  viewer: ProjectionViewer;
}): Promise<V2BrowserHolderProjectionInstall> {
  for (const write of input.writes) await applyProjectionWriteToBrowserRows(input.store, input.scope, write);
  await input.store.putMeta(`head:${input.scope}`, input.head);
  return {
    scope: input.scope,
    head: input.head,
    projection: await projectionFromStoredRows(input.store, input.scope, input.head, input.viewer)
  };
}

async function installCheckpointProjection(
  store: V2BrowserHolderInstallStore,
  transfer: V2BrowserCheckpointTailOpenTransfer,
  viewer: ProjectionViewer
): Promise<V2BrowserHolderProjectionInstall | null> {
  const openTransfer = transfer.transfer;
  if (openTransfer.kind !== "checkpoint") throw new Error("checkpoint install requires checkpoint transfer");
  const checkpoint = openTransfer.checkpoint;
  const exportKey = `checkpoint_export:${checkpoint.scope}`;
  const exportState = {
    checkpoint_hash: checkpoint.checkpoint_hash,
    head: checkpoint.head
  };
  const prior = await store.getMeta<typeof exportState>(exportKey);
  const beginsExport = checkpoint.pages.some((page) => page.page === "000001");
  if (beginsExport || !prior || prior.checkpoint_hash !== checkpoint.checkpoint_hash) {
    await store.clearProjectionRows(checkpoint.scope);
  }
  for (const page of checkpoint.pages) {
    switch (page.table) {
      case "objects":
        for (const row of page.rows as BrowserObjectRow[]) {
          assertBrowserObjectRow(row);
          await store.putProjectionRow({ scope: checkpoint.scope, table: "objects", key: objectProjectionRowKey(row), row });
        }
        break;
      case "sessions":
        for (const row of page.rows as BrowserSessionRow[]) {
          assertBrowserSessionRow(row);
          await store.putProjectionRow({ scope: checkpoint.scope, table: "sessions", key: sessionProjectionRowKey(row), row });
        }
        break;
      case "logs":
        for (const row of page.rows as BrowserLogRow[]) {
          assertBrowserLogRow(row);
          const log = logProjectionRow(row);
          await store.putProjectionRow({ scope: checkpoint.scope, table: "logs", key: `${log.space}:${log.seq}`, space: log.space, row: log.row });
        }
        break;
      case "tombstones":
        for (const row of page.rows as Array<{ id: ObjRef }>) {
          await store.putProjectionRow({ scope: checkpoint.scope, table: "tombstones", key: row.id, row });
        }
        break;
      case "tool_surfaces":
        for (const row of page.rows as BrowserToolRow[]) {
          assertBrowserToolRow(row);
          await store.putProjectionRow({ scope: checkpoint.scope, table: "tool_surfaces", key: `${row.scope}:${row.object}`, row });
        }
        break;
      default:
        throw new Error(`browser checkpoint/tail page table is not browser-profiled: ${String((page as { table?: unknown }).table)}`);
    }
  }
  // `checkpoint_export` is a tiny continuation validator, not a freshness
  // lease. The server pins continuation freshness by export id/head/hash and
  // rejects stale continuation tokens.
  await store.putMeta(exportKey, exportState);
  if (transfer.transfer.continuation) {
    await store.putMeta("catchup_required", true);
    return null;
  }
  await store.putMeta(`head:${checkpoint.scope}`, checkpoint.head);
  await store.putMeta("catchup_required", false);
  return {
    scope: checkpoint.scope,
    head: checkpoint.head,
    projection: await projectionFromStoredRows(store, checkpoint.scope, checkpoint.head, viewer)
  };
}

async function applyProjectionWriteToBrowserRows(
  store: V2BrowserHolderInstallStore,
  scope: string,
  write: ProjectionWrite<BrowserProfile>
): Promise<void> {
  switch (write.table) {
    case "objects":
      if (write.op === "delete") await store.deleteProjectionRow(scope, "objects", write.key);
      else {
        assertBrowserObjectRow(write.row);
        await store.putProjectionRow({ scope, table: "objects", key: write.key, row: write.row });
      }
      return;
    case "sessions":
      if (write.op === "delete") await store.deleteProjectionRow(scope, "sessions", write.key);
      else {
        assertBrowserSessionRow(write.row);
        await store.putProjectionRow({ scope, table: "sessions", key: write.key, row: write.row });
      }
      return;
    case "logs": {
      const key = `${write.key.space}:${write.key.seq}`;
      if (write.op === "delete") await store.deleteProjectionRow(scope, "logs", key);
      else {
        assertBrowserLogRow(write.row);
        await store.putProjectionRow({ scope, table: "logs", key, space: write.key.space, row: write.row });
      }
      return;
    }
    case "tombstones":
      if (write.op === "delete") await store.deleteProjectionRow(scope, "tombstones", write.key);
      else await store.putProjectionRow({ scope, table: "tombstones", key: write.key, row: write.row });
      return;
    case "tool_surfaces": {
      const key = `${write.key.scope}:${write.key.object}`;
      if (write.op === "delete") await store.deleteProjectionRow(scope, "tool_surfaces", key);
      else {
        assertBrowserToolRow(write.row);
        await store.putProjectionRow({ scope, table: "tool_surfaces", key, row: write.row });
      }
      return;
    }
    default:
      return;
  }
}

async function projectionFromStoredRows(
  store: V2BrowserHolderInstallStore,
  scope: string,
  head: ShadowScopeHead,
  viewer: ProjectionViewer
): Promise<unknown> {
  const subject = await storedBrowserObjectSummary(store, scope, scope);
  if (!subject) return projectionFromAllStoredRows(store, scope, head, viewer);
  const actor = viewer?.actor ? await storedBrowserObjectSummary(store, scope, viewer.actor) : null;
  const sessionRow = viewer?.session ? await storedBrowserSessionRow(store, scope, viewer.session) : undefined;
  const activeScope = sessionRow?.active_scope ?? null;
  const subjectContents = objectRefsFromContents(subject) ?? [];
  const inventoryRefs = objectRefsFromContents(actor) ?? [];
  const projectionRefs = new Set<string>([scope, ...subjectContents]);
  if (viewer?.actor) {
    projectionRefs.add(viewer.actor);
    for (const ref of inventoryRefs) projectionRefs.add(ref);
  }
  if (activeScope) projectionRefs.add(activeScope);

  const byId = new Map<string, Record<string, unknown>>();
  byId.set(scope, subject);
  if (actor) byId.set(viewer!.actor, actor);
  for (const id of projectionRefs) {
    if (byId.has(id)) continue;
    const summary = await storedBrowserObjectSummary(store, scope, id);
    if (summary) byId.set(id, summary);
  }
  return browserProjectionFromObjectSummaries(scope, head, {
    object_count: await store.projectionRowCountForScopeTable(scope, "objects"),
    byId,
    viewer,
    sessionRow,
    subjectContents,
    inventoryRefs
  });
}

async function projectionFromAllStoredRows(
  store: V2BrowserHolderInstallStore,
  scope: string,
  head: ShadowScopeHead,
  viewer: ProjectionViewer
): Promise<unknown> {
  const rows = await store.projectionRowsForScope(scope);
  return browserProjectionFromStoredRows(scope, head, rows, viewer);
}

async function storedBrowserObjectSummary(
  store: V2BrowserHolderInstallStore,
  scope: string,
  id: string
): Promise<Record<string, unknown> | null> {
  const row = await store.getProjectionRow(scope, "objects", id);
  return row?.table === "objects" ? browserSummaryFromObjectRow(row.row) : null;
}

async function storedBrowserSessionRow(
  store: V2BrowserHolderInstallStore,
  scope: string,
  id: string
): Promise<BrowserSessionRow | undefined> {
  const row = await store.getProjectionRow(scope, "sessions", id);
  return row?.table === "sessions" ? row.row : undefined;
}

function objectProjectionRowKey(row: BrowserObjectRow): ObjRef {
  return row.id;
}

function scopeHeadAtOrBeyond(current: ShadowScopeHead, incoming: ShadowScopeHead): boolean {
  if (current.scope !== incoming.scope) return false;
  return current.epoch > incoming.epoch || (current.epoch === incoming.epoch && current.seq >= incoming.seq);
}

function sessionProjectionRowKey(row: BrowserSessionRow): string {
  return row.session_id;
}

function logProjectionRow(value: BrowserLogRow): {
  space: ObjRef;
  seq: number;
  row: BrowserLogRow;
} {
  return { space: value.scope, seq: value.seq, row: value };
}

function assertBrowserObjectRow(value: unknown): asserts value is BrowserObjectRow {
  if (!isBrowserObjectRow(value)) throw new Error("browser projection object row must be BrowserObjectRow");
}

function assertBrowserSessionRow(value: unknown): asserts value is BrowserSessionRow {
  if (!isBrowserSessionRow(value)) throw new Error("browser projection session row must be BrowserSessionRow");
}

function assertBrowserLogRow(value: unknown): asserts value is BrowserLogRow {
  if (!isBrowserLogRow(value)) throw new Error("browser projection log row must be BrowserLogRow");
}

function assertBrowserToolRow(value: unknown): asserts value is BrowserToolRow {
  if (!isBrowserToolRow(value)) throw new Error("browser projection tool-surface row must be BrowserToolRow");
}

function isBrowserObjectRow(value: unknown): value is BrowserObjectRow {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as { kind?: unknown }).kind === "woo.browser_object_row.v1");
}

function isBrowserSessionRow(value: unknown): value is BrowserSessionRow {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as { kind?: unknown }).kind === "woo.browser_session_row.v1");
}

function isBrowserLogRow(value: unknown): value is BrowserLogRow {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as { kind?: unknown }).kind === "woo.browser_log_row.v1");
}

function isBrowserToolRow(value: unknown): value is BrowserToolRow {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as { kind?: unknown }).kind === "woo.browser_tool_row.v1");
}

function browserProjectionFromStoredRows(
  scope: string,
  head: ShadowScopeHead,
  rows: V2BrowserProjectionRowRecord[],
  viewer?: ProjectionViewer
): unknown {
  const objectRows = rows
    .filter((row): row is Extract<V2BrowserProjectionRowRecord, { table: "objects" }> => row.table === "objects")
    .map((row) => browserSummaryFromObjectRow(row.row));
  const byId = new Map(objectRows.map((row) => [String(row.id), row] as const));
  const subject = byId.get(scope) ?? null;
  const actor = viewer?.actor ? byId.get(viewer.actor) ?? null : null;
  const sessionRow = viewer?.session
    ? rows
      .filter((row): row is Extract<V2BrowserProjectionRowRecord, { table: "sessions" }> => row.table === "sessions")
      .map((row) => row.row)
      .find((row) => row.session_id === viewer.session)
    : undefined;
  const activeScope = sessionRow?.active_scope ?? null;
  const subjectContents = objectRefsFromContents(subject) ?? objectRows
    .filter((row) => row.location === scope)
    .map((row) => String(row.id));
  const inventoryRefs = objectRefsFromContents(actor) ?? (viewer?.actor
    ? objectRows.filter((row) => row.location === viewer.actor).map((row) => String(row.id))
    : []);
  const projectionRefs = new Set<string>([scope, ...subjectContents]);
  if (viewer?.actor) {
    projectionRefs.add(viewer.actor);
    for (const ref of inventoryRefs) projectionRefs.add(ref);
  }
  if (activeScope) projectionRefs.add(activeScope);
  const objects = Array.from(projectionRefs)
    .map((id) => byId.get(id) ?? null)
    .filter((item): item is Record<string, unknown> => item !== null);
  const inventory = inventoryRefs
    .map((id) => byId.get(id) ?? null)
    .filter((item): item is Record<string, unknown> => item !== null);
  return {
    kind: "woo.scope_projection.shadow.v1",
    scope,
    title: typeof subject?.name === "string" ? subject.name : scope,
    object_count: objectRows.length,
    contents: subjectContents,
    seq: head.seq,
    cursor: { spaces: { [scope]: { next_seq: head.seq + 1 } }, live: { resumable: false } },
    ...(viewer ? { viewer } : {}),
    ...(viewer ? {
      self: actor,
      session: viewer.session ? {
        id: viewer.session,
        actor: viewer.actor,
        active_scope: activeScope,
        current_location: activeScope,
        all_locations: activeScope ? [activeScope] : []
      } : null,
      inventory
    } : {}),
    subject,
    objects
  };
}

function browserProjectionFromObjectSummaries(
  scope: string,
  head: ShadowScopeHead,
  input: {
    object_count: number;
    byId: Map<string, Record<string, unknown>>;
    viewer?: ProjectionViewer;
    sessionRow?: BrowserSessionRow;
    subjectContents: string[];
    inventoryRefs: string[];
  }
): unknown {
  const subject = input.byId.get(scope) ?? null;
  const actor = input.viewer?.actor ? input.byId.get(input.viewer.actor) ?? null : null;
  const activeScope = input.sessionRow?.active_scope ?? null;
  const projectionRefs = new Set<string>([scope, ...input.subjectContents]);
  if (input.viewer?.actor) {
    projectionRefs.add(input.viewer.actor);
    for (const ref of input.inventoryRefs) projectionRefs.add(ref);
  }
  if (activeScope) projectionRefs.add(activeScope);
  const objects = Array.from(projectionRefs)
    .map((id) => input.byId.get(id) ?? null)
    .filter((item): item is Record<string, unknown> => item !== null);
  const inventory = input.inventoryRefs
    .map((id) => input.byId.get(id) ?? null)
    .filter((item): item is Record<string, unknown> => item !== null);
  return {
    kind: "woo.scope_projection.shadow.v1",
    scope,
    title: typeof subject?.name === "string" ? subject.name : scope,
    object_count: input.object_count,
    contents: input.subjectContents,
    seq: head.seq,
    cursor: { spaces: { [scope]: { next_seq: head.seq + 1 } }, live: { resumable: false } },
    ...(input.viewer ? { viewer: input.viewer } : {}),
    ...(input.viewer ? {
      self: actor,
      session: input.viewer.session ? {
        id: input.viewer.session,
        actor: input.viewer.actor,
        active_scope: activeScope,
        current_location: activeScope,
        all_locations: activeScope ? [activeScope] : []
      } : null,
      inventory
    } : {}),
    subject,
    objects
  };
}

function browserSummaryFromObjectRow(row: BrowserObjectRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.display.name ?? row.name ?? row.id,
    parent: row.display.parent,
    ancestors: row.display.ancestors ?? [],
    owner: row.display.owner,
    location: row.location ?? row.display.location ?? null,
    aliases: row.display.aliases,
    description: row.display.description ?? null,
    props: row.display.props ?? {},
    contents: row.contents ?? []
  };
}

function objectRefsFromContents(summary: Record<string, unknown> | null): string[] | null {
  if (!summary) return null;
  const contents = summary.contents;
  return Array.isArray(contents) ? contents.filter((item): item is string => typeof item === "string") : null;
}
