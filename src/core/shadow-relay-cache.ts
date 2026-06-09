// Holder-neutral relay/cache substrate.
//
// A `ShadowRelayCache` (historically `ShadowBrowserRelayShim`) is the per-commit-scope
// relay + read-through cache that EVERY holder runs: the MCP gateway, the REST
// PersistentObjectDO, the CommitScopeDO, the dev server, and the in-process browser
// node. It is not browser-specific — the browser is just one client that attaches to
// it. The cache MECHANICS therefore live here, at the level shared by all holders:
//   - the relay-cache shape and its serialized-world index cache,
//   - generation bump + index/seed-cache eviction on mutation,
//   - the one authority-merge-into-cache recipe,
//   - the one accepted-frame application helper (head-advancing vs derived).
//
// Browser-specific concerns (live events, projection transfers, the browser node and
// its publish/subscribe path, session-auth construction) stay in `shadow-browser-node`,
// which imports this module's values. To keep the relay shape's mutually-recursive
// reference to `ShadowBrowserNode` (the `browsers` map) working without a runtime
// import cycle, this module imports the browser-local field TYPES with `import type`
// only — those imports are erased at runtime, so the value dependency is strictly
// browser-node → relay-cache.
import type { SerializedAuthorityCellSlice, SerializedAuthoritySlice, SerializedObject, SerializedSession, SerializedWorld } from "./repository";
import { mergeSerializedAuthoritySlice } from "./authority-slice";
import { planningCellKey } from "./planning-world";
import type { ShadowCellPageTransfer } from "./shadow-turn-exec";
import type { AuthorityPageRef } from "./shadow-state-pages";
import {
  applyAcceptedProjectionToCommitScopeCache,
  applyAcceptedShadowFrame,
  applyShadowTranscriptToCommitScopeCache,
  isShadowCommitScopeSerializedDirty,
  markShadowCommitScopeSerializedChanged,
  recordAcceptedCommitScopeCellProvenance,
  serializedFor,
  shadowCommitScopeSerializedRef,
  type ShadowCommitAccepted,
  type ShadowCommitScope
} from "./shadow-commit-scope";
import type { ShadowExecutionNode } from "./shadow-turn-exec";
import type { EffectTranscript } from "./effect-transcript";
import type { ShadowEnvelope } from "./shadow-envelope";
import type { MetricEvent, ObjRef, PropertyDef, WooValue } from "./types";
// Browser-local field types — type-only import (no runtime dependency back on the
// browser module, so the value-import direction stays one-way: browser → relay-cache).
import type {
  ShadowBrowserNode,
  ShadowBrowserSessionClaims,
  ShadowBrowserStateSigning,
  ShadowLiveEvent
} from "./shadow-browser-node";

// THE relay/cache substrate. One per commit scope; many clients (gateway sockets, REST
// relays, browser nodes) attach to it. The neutral fields are the cache itself; the
// `browsers`/`subscriptions`/`live_*` fields are the browser attachment surface, owned
// by `shadow-browser-node` but carried here because the shape is shared.
export type ShadowRelayCache = {
  kind: "woo.browser_relay.shadow.v1";
  node: string;
  deployment: string;
  commit_scope: ShadowCommitScope;
  commit_scopes: Map<ObjRef, ShadowCommitScope>;
  executors: ShadowExecutionNode[];
  subscriptions: Map<ObjRef, Set<string>>;
  browsers: Map<string, ShadowBrowserNode>;
  session_auth: Map<string, ShadowBrowserSessionClaims>;
  session_revs: Map<string, number>;
  serialized_generation: number;
  open_executable_seed_cache: Map<string, { generation: number; digest: string }>;
  idempotency_window_ms: number;
  recently_seen: Map<string, number>;
  recent_replies: Map<string, ShadowEnvelope>;
  live_session_serialized: Map<string, SerializedWorld>;
  accepted_frames: ShadowCommitAccepted[];
  transcript_tail: EffectTranscript[];
  live_events: ShadowLiveEvent[];
  state_signing: ShadowBrowserStateSigning;
};

// A read-built index over a serialized world: id→record maps plus per-object property
// maps. Cached per `SerializedWorld` instance (WeakMap) so repeated projection/read
// passes over the same snapshot do not rebuild it. Mutating a snapshot in place (e.g.
// an authority merge) must evict the stale entry — see markRelayCacheSerializedChanged.
export type ShadowSerializedIndex = {
  objects: Map<ObjRef, SerializedObject>;
  sessions: Map<string, SerializedSession>;
  indexedObjects: Map<ObjRef, ShadowIndexedObject>;
  logSeqBySpace: Map<ObjRef, number>;
};

export type ShadowIndexedObject = {
  record: SerializedObject;
  properties: Map<string, WooValue>;
  propertyDefs: Map<string, PropertyDef>;
};

const SHADOW_SERIALIZED_INDEX_CACHE = new WeakMap<SerializedWorld, ShadowSerializedIndex>();

export function shadowSerializedIndex(serialized: SerializedWorld): ShadowSerializedIndex {
  const cached = SHADOW_SERIALIZED_INDEX_CACHE.get(serialized);
  if (cached) return cached;
  const indexedObjects = new Map<ObjRef, ShadowIndexedObject>();
  for (const obj of serialized.objects) {
    indexedObjects.set(obj.id, {
      record: obj,
      properties: new Map(obj.properties),
      propertyDefs: new Map(obj.propertyDefs.map((def) => [def.name, def] as const))
    });
  }
  const index = {
    objects: new Map(serialized.objects.map((obj) => [obj.id, obj])),
    sessions: new Map(serialized.sessions.map((session) => [session.id, session])),
    indexedObjects,
    logSeqBySpace: new Map(serialized.logs.map(([space, entries]) => [
      space,
      entries.reduce((max, entry) => Math.max(max, entry.seq), 0)
    ] as const))
  };
  SHADOW_SERIALIZED_INDEX_CACHE.set(serialized, index);
  return index;
}

// Relay-cache invalidation shared by both serialized-row mutation and indexed
// state apply paths. This only invalidates consumers of the serialized snapshot;
// callers that mutate `commit_scope.serialized` in place must use
// markShadowBrowserRelaySerializedChanged so the commit-scope index is rebuilt.
export function invalidateShadowBrowserRelaySerializedCaches(relay: ShadowRelayCache): void {
  relay.serialized_generation++;
  relay.open_executable_seed_cache.clear();
  SHADOW_SERIALIZED_INDEX_CACHE.delete(shadowCommitScopeSerializedRef(relay.commit_scope));
}

// Mutating the relay's serialized snapshot in place invalidates anything keyed
// off the pre-mutation state and also rebuilds the commit-scope indexed state.
// Accepted-frame apply paths already update the indexed state first and should
// call invalidateShadowBrowserRelaySerializedCaches instead to avoid an O(world)
// index rebuild on every accepted frame.
export function markShadowBrowserRelaySerializedChanged(relay: ShadowRelayCache): void {
  if (!isShadowCommitScopeSerializedDirty(relay.commit_scope)) {
    markShadowCommitScopeSerializedChanged(relay.commit_scope);
  }
  invalidateShadowBrowserRelaySerializedCaches(relay);
}

// THE accepted-frame-into-relay-cache helper across every transport. `advanceHead:true`
// for an OWNING-scope frame (the head-advancing commit), `advanceHead:false` for a
// DERIVED/cross-scope frame projected into a relay subscribed elsewhere. Either way it
// records the derived view's provenance (`cache`) and bumps the relay-cache generation.
export function applyAcceptedFrameToRelayCache(
  relay: ShadowRelayCache,
  accepted: ShadowCommitAccepted,
  transcript: EffectTranscript,
  options: { advanceHead: boolean }
): void {
  if (options.advanceHead) {
    // applyAcceptedShadowFrame materializes authority projection rows (or replays)
    // AND advances the head to the accepted position.
    applyAcceptedShadowFrame(relay.commit_scope, accepted, transcript);
  } else if (!applyAcceptedProjectionToCommitScopeCache(relay.commit_scope, accepted, transcript)) {
    applyShadowTranscriptToCommitScopeCache(relay.commit_scope, transcript);
  }
  recordAcceptedCommitScopeCellProvenance(relay.commit_scope, transcript, accepted, "cache");
  invalidateShadowBrowserRelaySerializedCaches(relay);
}

// Derived/cross-scope convenience (advanceHead: false) — the common case for a relay
// projecting another scope's accepted commit.
export function applyAcceptedFrameToDerivedRelayCache(
  relay: ShadowRelayCache,
  accepted: ShadowCommitAccepted,
  transcript: EffectTranscript
): void {
  applyAcceptedFrameToRelayCache(relay, accepted, transcript, { advanceHead: false });
}

type PreservedRelayActorLiveCells = {
  location: SerializedObject["location"];
  children: SerializedObject["children"];
  contents: SerializedObject["contents"];
};

// Snapshot the live (location/children/contents) cells of the relay's session actors
// before an authority merge. Per-turn authority refreshes can source an actor row
// from a sparse owner snapshot; the relay's accepted derived live projection for its
// own session actors must survive the merge while lineage/property cells refresh.
function preserveRelayActorLiveCells(
  serialized: Pick<SerializedWorld, "objects">,
  sessions: readonly SerializedSession[]
): Map<ObjRef, PreservedRelayActorLiveCells> {
  const actors = new Set(sessions.map((session) => session.actor));
  const preserved = new Map<ObjRef, PreservedRelayActorLiveCells>();
  for (const obj of serialized.objects) {
    if (!actors.has(obj.id)) continue;
    preserved.set(obj.id, { location: obj.location, children: obj.children.slice(), contents: obj.contents.slice() });
  }
  return preserved;
}

function restoreRelayActorLiveCells(
  serialized: Pick<SerializedWorld, "objects">,
  preserved: ReadonlyMap<ObjRef, PreservedRelayActorLiveCells>
): void {
  if (preserved.size === 0) return;
  for (const obj of serialized.objects) {
    const live = preserved.get(obj.id);
    if (!live) continue;
    obj.location = live.location;
    obj.children = live.children.slice();
    obj.contents = live.contents.slice();
  }
}

// THE one authority-merge-into-relay-cache helper across MCP / REST / CommitScopeDO /
// dev. Materializes a fresh authority slice into the relay's planning snapshot with
// the relay's per-cell provenance (so the admission gate / merge precedence apply
// uniformly), optionally preserving the session actors' live cells across the merge,
// and bumps the relay-cache generation when the snapshot actually changed. Returns
// whether the merge changed durable state.
export function mergeAuthorityIntoRelayCache(
  relay: ShadowRelayCache,
  authority: SerializedAuthoritySlice,
  options: { preserveSessionActorLive?: boolean; clone?: boolean; reason?: string; metric?: (event: MetricEvent) => void } = {}
): boolean {
  const serialized = serializedFor(relay.commit_scope, {
    reason: options.reason ?? "authority_merge",
    ...(options.metric ? { metric: options.metric } : {})
  });
  const preserved = options.preserveSessionActorLive
    ? preserveRelayActorLiveCells(serialized, authority.sessions)
    : null;
  const cellProvenance = (relay.commit_scope.cellProvenance ??= new Map());
  let changed = mergeSerializedAuthoritySlice(serialized, authority, { clone: options.clone === true, cellProvenance });
  if (preserved) restoreRelayActorLiveCells(serialized, preserved);
  if (pruneRelayPresentationStubs(serialized, cellProvenance)) changed = true;
  if (changed) markShadowBrowserRelaySerializedChanged(relay);
  return changed;
}

function pruneRelayPresentationStubs(
  serialized: SerializedWorld,
  cellProvenance: Map<string, { source: string }>
): boolean {
  const pruned = new Set<ObjRef>();
  for (const obj of serialized.objects) {
    if (obj.id.startsWith("$") || obj.name !== obj.id) continue;
    const lineageSource = cellProvenance.get(planningCellKey(obj.id, "object_lineage"))?.source;
    if (lineageSource === "authoritative") continue;
    pruned.add(obj.id);
  }
  if (pruned.size === 0) return false;

  for (const id of pruned) {
    cellProvenance.delete(planningCellKey(id, "object_lineage"));
    cellProvenance.delete(planningCellKey(id, "object_live"));
  }
  serialized.sessions = serialized.sessions.filter((session) => !pruned.has(session.actor));
  serialized.objects = serialized.objects
    .filter((obj) => !pruned.has(obj.id))
    .map((obj) => {
      const contents = obj.contents.filter((id) => !pruned.has(id));
      const children = obj.children.filter((id) => !pruned.has(id));
      const location = obj.location && pruned.has(obj.location) ? null : obj.location;
      if (contents.length === obj.contents.length && children.length === obj.children.length && location === obj.location) return obj;
      return { ...obj, contents, children, location };
    });
  return true;
}

// DESIGN A layer-2 install path. A `read_version_mismatch` rejection from the
// committing scope carries a `version_mismatch_repair_cells` cell-page transfer
// of the cells the caller planned against staler versions of. Install it into
// the relay's planning cache so the next repair attempt plans against the fresh
// committed cells and converges, instead of re-submitting the same stale rows.
//
// The transfer's page refs are stamped `authoritative` by the committing scope,
// so converting it to a cell-authority slice and going through the ONE
// authority-merge recipe means the standard precedence + version gate apply: an
// owner-authoritative cell overrides a self-certified shard stub, and the
// version gate refuses to install a row older than the cached one. We do NOT
// preserve session-actor live cells here: the whole point is to refresh the
// mismatched cells (commonly an actor identity/property), and location/contents
// projections still come from the authoritative live page in the transfer.
// Returns whether the merge changed durable cache state.
export function installShadowCellPageTransferAsAuthority(
  relay: ShadowRelayCache,
  transfer: ShadowCellPageTransfer,
  options: { reason?: string } = {}
): boolean {
  // The transfer is a content-addressed cell-page bundle whose shape is a
  // superset of a cell-authority slice. The repair builder already stamped each
  // page ref `source: "authoritative"` (a well-formed AuthorityPageRef), so this
  // is a structural reinterpretation, not a re-derivation.
  const slice: SerializedAuthorityCellSlice = {
    kind: "woo.authority_slice.cells.shadow.v1",
    sessions: transfer.sessions,
    page_refs: transfer.page_refs as AuthorityPageRef[],
    inline_pages: transfer.inline_pages,
    counters: transfer.counters,
    tombstones: transfer.tombstones,
    source_object_count: transfer.source_object_count
  };
  return mergeAuthorityIntoRelayCache(relay, slice, {
    reason: options.reason ?? "version_mismatch_repair",
    clone: true
  });
}

// B7 / VTN12.1 accepted-write cache fill. Unlike the read-mismatch repair path
// above, an accepted commit reply is a derived read-through for the caller. It
// warms the next planning turn, but it MUST NOT become write authority. Stamp
// every transferred page as `cache` and merge through the same provenance-aware
// boundary used by authority slices.
export function installShadowAcceptedWriteTransferIntoRelayCache(
  relay: ShadowRelayCache,
  transfer: ShadowCellPageTransfer,
  options: { reason?: string } = {}
): boolean {
  if (transfer.purpose !== "accepted_write_cells") return false;
  const slice: SerializedAuthorityCellSlice = {
    kind: "woo.authority_slice.cells.shadow.v1",
    sessions: transfer.sessions,
    page_refs: transfer.page_refs.map((ref) => ({
      ...structuredClone(ref),
      source: "cache" as const
    })),
    inline_pages: transfer.inline_pages,
    counters: transfer.counters,
    tombstones: transfer.tombstones,
    source_object_count: transfer.source_object_count
  };
  return mergeAuthorityIntoRelayCache(relay, slice, {
    reason: options.reason ?? "accepted_write_cells_cache",
    clone: true
  });
}
