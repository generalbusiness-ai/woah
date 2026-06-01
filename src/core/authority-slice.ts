import type {
  SerializedAuthorityCellSlice,
  SerializedAuthorityObjectSlice,
  SerializedAuthoritySlice,
  SerializedObject,
  SerializedSession,
  SerializedWorld
} from "./repository";
import { stableShadowJson } from "./shadow-cell-version";
import {
  mergeShadowStatePagesIntoSerialized,
  shadowStatePageHash,
  shadowStatePageRef,
  shadowStatePagesForObject,
  type ShadowStatePage,
  type ShadowStatePageRef
} from "./shadow-state-pages";
import type { ObjRef, WooValue } from "./types";

export type MergeSerializedAuthorityInput =
  | SerializedAuthoritySlice
  | Pick<SerializedAuthorityObjectSlice, "sessions" | "objects">;

export type MergeSerializedAuthorityOptions = {
  clone?: boolean;
};

export type AuthorityPageProvenance = Pick<ShadowStatePageRef, "source" | "source_host">;

// A3 (mobile-heap sequence): every authority cell page MUST declare a `source`.
// Provenance is no longer a decorative optional field — the gateway merge path
// REFUSES to trust a non-"authoritative" page as authority (see
// filterRemoteAuthoritySliceForGateway), so a page with no declared source would
// be silently un-trustable. `pageProvenance` is therefore required and MUST
// return a provenance whose `source` is set. This is the type-level half of
// VTN0's "a derived copy is never a write-authority source": a builder cannot
// produce an authority slice without saying, per page, whether it is the owner's
// authoritative row or a cache/projection/fallback derivation.
export function buildSerializedAuthorityCellSlice(input: {
  sessions: readonly SerializedSession[];
  objects: readonly SerializedObject[];
  counters: Pick<SerializedWorld, "objectCounter" | "parkedTaskCounter" | "sessionCounter">;
  tombstones?: readonly ObjRef[];
  pageProvenance: (page: ShadowStatePage) => AuthorityPageProvenance & { source: NonNullable<AuthorityPageProvenance["source"]> };
}): SerializedAuthorityCellSlice {
  const pages = input.objects.flatMap((obj) => shadowStatePagesForObject(obj));
  return {
    kind: "woo.authority_slice.cells.shadow.v1",
    sessions: structuredClone(input.sessions) as SerializedSession[],
    page_refs: pages.map((page) => authorityPageRefWithProvenance(shadowStatePageRef(page, true), input.pageProvenance(page))),
    inline_pages: pages.map((page) => structuredClone(page) as ShadowStatePage),
    counters: { ...input.counters },
    tombstones: [...(input.tombstones ?? [])].sort(),
    source_object_count: input.objects.length
  };
}

export function authorityPageRefWithProvenance(
  ref: ShadowStatePageRef,
  provenance: AuthorityPageProvenance | null | undefined
): ShadowStatePageRef {
  if (!provenance?.source) return ref;
  return {
    ...ref,
    source: provenance.source,
    ...(provenance.source_host ? { source_host: provenance.source_host } : {})
  };
}

export function withAuthorityPageProvenance(
  authority: SerializedAuthoritySlice,
  provenance: (ref: ShadowStatePageRef) => AuthorityPageProvenance | null | undefined
): SerializedAuthoritySlice {
  if (!isAuthorityCellSlice(authority)) {
    return {
      kind: "woo.authority_slice.shadow.v1",
      sessions: authority.sessions.map((session) => structuredClone(session) as SerializedSession),
      objects: authority.objects.map((obj) => structuredClone(obj) as SerializedObject)
    };
  }
  return {
    ...authority,
    sessions: authority.sessions.map((session) => structuredClone(session) as SerializedSession),
    page_refs: authority.page_refs.map((ref) => authorityPageRefWithProvenance(structuredClone(ref) as ShadowStatePageRef, provenance(ref))),
    inline_pages: authority.inline_pages.map((page) => structuredClone(page) as ShadowStatePage),
    counters: { ...authority.counters },
    tombstones: [...authority.tombstones]
  };
}

export function serializedWorldFromAuthoritySlice(authority: MergeSerializedAuthorityInput): SerializedWorld {
  if (isAuthorityCellSlice(authority)) {
    const referenced = new Set(authority.page_refs.map((ref) => ref.hash));
    const pages = authority.inline_pages.filter((page) => referenced.has(shadowStatePageHash(page)));
    const serialized = mergeShadowStatePagesIntoSerialized(emptySerializedWorldFromAuthority(authority), pages, () => emptySerializedWorldFromAuthority(authority));
    repairDerivedContentsProjection(serialized);
    pruneSerializedSessionsWithoutActorRows(serialized);
    return serialized;
  }
  const serialized: SerializedWorld = {
    version: 1,
    objectCounter: inferObjectCounter(authority.objects),
    parkedTaskCounter: 1,
    sessionCounter: inferSessionCounter(authority.sessions),
    objects: authority.objects.map((obj) => structuredClone(obj) as SerializedObject).sort((a, b) => a.id.localeCompare(b.id)),
    sessions: authority.sessions.map((session) => structuredClone(session) as SerializedSession).sort((a, b) => a.id.localeCompare(b.id)),
    logs: [],
    snapshots: [],
    parkedTasks: [],
    tombstones: []
  };
  repairDerivedContentsProjection(serialized);
  pruneSerializedSessionsWithoutActorRows(serialized);
  return serialized;
}

export function mergeSerializedAuthoritySlice(
  serialized: { sessions: SerializedSession[]; objects: SerializedObject[] } & Partial<Pick<SerializedWorld, "objectCounter" | "parkedTaskCounter" | "sessionCounter" | "tombstones">>,
  authority: MergeSerializedAuthorityInput,
  options: MergeSerializedAuthorityOptions = {}
): boolean {
  // Cell-page authority can carry set-equivalent children/contents arrays in a
  // different order than this sparse snapshot. The merge may temporarily apply
  // those pages and then normalize them back to the same final state; callers
  // use this boolean for cache invalidation, so report only durable state
  // changes that remain after all repairs.
  const before = authorityMergeFingerprint(serialized);
  mergeAuthoritySessions(serialized, authority.sessions, options);
  if (isAuthorityCellSlice(authority)) {
    mergeAuthorityCellPages(serialized, authority, options);
    mergeAuthorityMetadata(serialized, authority);
  } else {
    mergeAuthorityObjectRows(serialized, authority.objects, options);
  }
  repairDerivedContentsProjection(serialized);
  pruneSerializedSessionsWithoutActorRows(serialized);
  return authorityMergeFingerprint(serialized) !== before;
}

export function combineSerializedAuthoritySlices(
  sessions: readonly SerializedSession[],
  slices: readonly MergeSerializedAuthorityInput[]
): SerializedAuthoritySlice {
  const emitCellSlice = slices.some(isAuthorityCellSlice);
  const lastPageByKey = new Map<string, ShadowStatePageRef>();
  const inlineByHash = new Map<string, ShadowStatePage>();
  const legacyObjects = new Map<ObjRef, SerializedObject>();
  let counters: Pick<SerializedWorld, "objectCounter" | "parkedTaskCounter" | "sessionCounter"> = {
    objectCounter: 1,
    parkedTaskCounter: 1,
    sessionCounter: inferSessionCounter(sessions)
  };
  const tombstones = new Set<ObjRef>();
  let sourceObjectCount = 0;

  for (const slice of slices) {
    if (isAuthorityCellSlice(slice)) {
      counters = {
        objectCounter: Math.max(counters.objectCounter, slice.counters.objectCounter),
        parkedTaskCounter: Math.max(counters.parkedTaskCounter, slice.counters.parkedTaskCounter),
        sessionCounter: Math.max(counters.sessionCounter, slice.counters.sessionCounter)
      };
      for (const id of slice.tombstones) tombstones.add(id);
      sourceObjectCount += slice.source_object_count;
      for (const page of slice.inline_pages) inlineByHash.set(shadowStatePageHash(page), structuredClone(page) as ShadowStatePage);
      for (const ref of slice.page_refs) lastPageByKey.set(authorityPageRefKey(ref), structuredClone(ref) as ShadowStatePageRef);
      continue;
    }
    if (emitCellSlice) {
      // Preserve slice precedence across both legacy object slices and cell-page
      // slices. Deferring legacy objects until after all cell slices makes stale
      // local rows override fresher remote rows solely because of representation.
      for (const obj of slice.objects) {
        const pages = shadowStatePagesForObject(obj);
        sourceObjectCount += 1;
        for (const page of pages) {
          const ref = shadowStatePageRef(page, true);
          inlineByHash.set(ref.hash, structuredClone(page) as ShadowStatePage);
          lastPageByKey.set(authorityPageRefKey(ref), ref);
        }
      }
      continue;
    }
    for (const obj of slice.objects) legacyObjects.set(obj.id, structuredClone(obj) as SerializedObject);
  }

  if (!emitCellSlice) {
    return {
      kind: "woo.authority_slice.shadow.v1",
      sessions: sessions.map((session) => structuredClone(session) as SerializedSession),
      objects: Array.from(legacyObjects.values()).sort((a, b) => a.id.localeCompare(b.id))
    };
  }

  return {
    kind: "woo.authority_slice.cells.shadow.v1",
    sessions: sessions.map((session) => structuredClone(session) as SerializedSession),
    page_refs: Array.from(lastPageByKey.values()).sort(compareAuthorityPageRefs),
    inline_pages: Array.from(inlineByHash.values()).sort(compareAuthorityPages),
    counters,
    tombstones: Array.from(tombstones).sort(),
    source_object_count: sourceObjectCount
  };
}

export function filterSerializedAuthoritySliceObjects(
  authority: MergeSerializedAuthorityInput,
  include: (id: ObjRef) => boolean
): SerializedAuthoritySlice {
  if (!isAuthorityCellSlice(authority)) {
    return {
      kind: "woo.authority_slice.shadow.v1",
      sessions: authority.sessions.map((session) => structuredClone(session) as SerializedSession),
      objects: authority.objects
        .filter((obj) => include(obj.id))
        .map((obj) => structuredClone(obj) as SerializedObject)
    };
  }
  const pageRefs = authority.page_refs
    .filter((ref) => include(ref.object))
    .map((ref) => structuredClone(ref) as ShadowStatePageRef);
  const keptHashes = new Set(pageRefs.map((ref) => ref.hash));
  const keptObjects = new Set(pageRefs.map((ref) => ref.object));
  return {
    ...authority,
    sessions: authority.sessions.map((session) => structuredClone(session) as SerializedSession),
    page_refs: pageRefs,
    inline_pages: authority.inline_pages
      .filter((page) => keptHashes.has(shadowStatePageHash(page)))
      .map((page) => structuredClone(page) as ShadowStatePage),
    tombstones: [...authority.tombstones],
    counters: { ...authority.counters },
    source_object_count: keptObjects.size
  };
}

export function filterSerializedAuthoritySlicePages(
  authority: MergeSerializedAuthorityInput,
  include: (ref: SerializedAuthorityCellSlice["page_refs"][number]) => boolean
): SerializedAuthoritySlice {
  if (!isAuthorityCellSlice(authority)) {
    return {
      kind: "woo.authority_slice.shadow.v1",
      sessions: authority.sessions.map((session) => structuredClone(session) as SerializedSession),
      objects: authority.objects
        .filter((obj) => shadowStatePagesForObject(obj).some((page) => include(shadowStatePageRef(page, true))))
        .map((obj) => structuredClone(obj) as SerializedObject)
    };
  }
  const pageRefs = authority.page_refs
    .filter(include)
    .map((ref) => structuredClone(ref) as ShadowStatePageRef);
  const keptHashes = new Set(pageRefs.map((ref) => ref.hash));
  const keptObjects = new Set(pageRefs.map((ref) => ref.object));
  return {
    ...authority,
    sessions: authority.sessions.map((session) => structuredClone(session) as SerializedSession),
    page_refs: pageRefs,
    inline_pages: authority.inline_pages
      .filter((page) => keptHashes.has(shadowStatePageHash(page)))
      .map((page) => structuredClone(page) as ShadowStatePage),
    tombstones: [...authority.tombstones],
    counters: { ...authority.counters },
    source_object_count: keptObjects.size
  };
}

export function authoritySliceObjectIds(authority: MergeSerializedAuthorityInput): Set<ObjRef> {
  if (!isAuthorityCellSlice(authority)) return new Set(authority.objects.map((obj) => obj.id));
  return new Set(authority.page_refs.map((ref) => ref.object));
}

// Count the cell pages a slice carries, for instrumentation that sizes a
// reconstruction (step 2a). For the cell-slice representation (CA12) this is
// the number of page refs; for the legacy object-row representation there are
// no cell pages, so the page count is the object-row count (each object row is
// the indivisible unit transferred). This stays in core so the metric site
// never has to branch on the slice's representation kind.
export function authoritySlicePageCount(authority: MergeSerializedAuthorityInput): number {
  if (!isAuthorityCellSlice(authority)) return authority.objects.length;
  return authority.page_refs.length;
}

export function pruneSerializedSessionsWithoutActorRows(serialized: { sessions: SerializedSession[]; objects: SerializedObject[] }): boolean {
  const objectIds = new Set(serialized.objects.map((obj) => obj.id));
  const sessions = serialized.sessions.filter((session) => objectIds.has(session.actor));
  if (sessions.length === serialized.sessions.length) return false;
  serialized.sessions = sessions;
  return true;
}

export function isAuthorityCellSlice(authority: MergeSerializedAuthorityInput): authority is SerializedAuthorityCellSlice {
  return (authority as { kind?: string }).kind === "woo.authority_slice.cells.shadow.v1";
}

function mergeAuthoritySessions(
  serialized: { sessions: SerializedSession[] },
  sessions: readonly SerializedSession[],
  options: MergeSerializedAuthorityOptions
): boolean {
  const next = options.clone
    ? structuredClone(sessions) as SerializedSession[]
    : sessions.map((session) => session as SerializedSession);
  if (stableShadowJson(next as unknown as WooValue) === stableShadowJson(serialized.sessions as unknown as WooValue)) return false;
  serialized.sessions = next;
  return true;
}

function authorityMergeFingerprint(
  serialized: { sessions: SerializedSession[]; objects: SerializedObject[] } & Partial<Pick<SerializedWorld, "objectCounter" | "parkedTaskCounter" | "sessionCounter" | "tombstones">>
): string {
  return stableShadowJson({
    sessions: serialized.sessions,
    objects: serialized.objects,
    objectCounter: serialized.objectCounter ?? null,
    parkedTaskCounter: serialized.parkedTaskCounter ?? null,
    sessionCounter: serialized.sessionCounter ?? null,
    tombstones: serialized.tombstones ?? null
  } as unknown as WooValue);
}

function mergeAuthorityObjectRows(
  serialized: { objects: SerializedObject[] },
  objects: readonly SerializedObject[],
  options: MergeSerializedAuthorityOptions
): boolean {
  if (objects.length === 0) return false;
  const byId = new Map(serialized.objects.map((obj, index) => [obj.id, index] as const));
  let changed = false;
  for (const obj of objects) {
    const next = options.clone ? structuredClone(obj) as SerializedObject : obj as SerializedObject;
    const index = byId.get(next.id);
    if (index === undefined) {
      byId.set(next.id, serialized.objects.length);
      serialized.objects.push(next);
      changed = true;
      continue;
    }
    if (stableShadowJson(serialized.objects[index] as unknown as WooValue) === stableShadowJson(next as unknown as WooValue)) continue;
    serialized.objects[index] = next;
    changed = true;
  }
  return changed;
}

function mergeAuthorityCellPages(
  serialized: { objects: SerializedObject[] },
  authority: SerializedAuthorityCellSlice,
  options: MergeSerializedAuthorityOptions
): boolean {
  if (authority.page_refs.length === 0) return false;
  const incomingByHash = new Map(authority.inline_pages.map((page) => [shadowStatePageHash(page), page] as const));
  const currentPages = new Map<string, { hash: string; page: ShadowStatePage }>();
  for (const obj of serialized.objects) {
    for (const page of shadowStatePagesForObject(obj)) currentPages.set(authorityPageKey(page), { hash: shadowStatePageHash(page), page });
  }

  const changedPages: ShadowStatePage[] = [];
  for (const ref of authority.page_refs) {
    const key = authorityPageRefKey(ref);
    const current = currentPages.get(key);
    if (current?.hash === ref.hash) continue;
    const incoming = incomingByHash.get(ref.hash);
    if (!incoming) {
      throw new Error(`authority cell page missing inline value: ${ref.object}:${ref.page}${ref.name ? `:${ref.name}` : ""}@${ref.hash}`);
    }
    const actual = shadowStatePageRef(incoming, true);
    if (actual.object !== ref.object || actual.page !== ref.page || actual.name !== ref.name || actual.hash !== ref.hash) {
      throw new Error(`authority cell page ref mismatch: ${ref.object}:${ref.page}${ref.name ? `:${ref.name}` : ""}`);
    }
    changedPages.push(options.clone ? structuredClone(incoming) as ShadowStatePage : incoming);
  }
  if (changedPages.length === 0) return false;

  const base: SerializedWorld = {
    version: 1,
    objectCounter: 1,
    parkedTaskCounter: 1,
    sessionCounter: 1,
    objects: serialized.objects,
    sessions: [],
    logs: [],
    snapshots: [],
    parkedTasks: [],
    tombstones: []
  };
  const merged = mergeShadowStatePagesIntoSerialized(base, changedPages, () => base);
  serialized.objects = merged.objects;
  return true;
}

function mergeAuthorityMetadata(
  serialized: Partial<Pick<SerializedWorld, "objectCounter" | "parkedTaskCounter" | "sessionCounter" | "tombstones">>,
  authority: SerializedAuthorityCellSlice
): boolean {
  let changed = false;
  const objectCounter = Math.max(serialized.objectCounter ?? 1, authority.counters.objectCounter);
  const parkedTaskCounter = Math.max(serialized.parkedTaskCounter ?? 1, authority.counters.parkedTaskCounter);
  const sessionCounter = Math.max(serialized.sessionCounter ?? 1, authority.counters.sessionCounter);
  if (serialized.objectCounter !== undefined && serialized.objectCounter !== objectCounter) {
    serialized.objectCounter = objectCounter;
    changed = true;
  }
  if (serialized.parkedTaskCounter !== undefined && serialized.parkedTaskCounter !== parkedTaskCounter) {
    serialized.parkedTaskCounter = parkedTaskCounter;
    changed = true;
  }
  if (serialized.sessionCounter !== undefined && serialized.sessionCounter !== sessionCounter) {
    serialized.sessionCounter = sessionCounter;
    changed = true;
  }
  if (serialized.tombstones !== undefined) {
    const next = Array.from(new Set([...serialized.tombstones, ...authority.tombstones])).sort();
    if (stableShadowJson(next as unknown as WooValue) !== stableShadowJson(serialized.tombstones as unknown as WooValue)) {
      serialized.tombstones = next;
      changed = true;
    }
  }
  return changed;
}

function repairDerivedContentsProjection(serialized: { objects: SerializedObject[] }): boolean {
  // CA3/CA4: `location` is the authoritative movement cell; `contents` is a
  // derived compatibility projection. Sparse authority merges often carry both
  // a moved object and its current container, so repair that per-member index
  // locally without requiring a second authoritative room write.
  const byId = new Map(serialized.objects.map((obj) => [obj.id, obj] as const));
  const desiredByContainer = new Map<ObjRef, Set<ObjRef>>();
  for (const obj of serialized.objects) {
    if (!obj.location || !byId.has(obj.location)) continue;
    let members = desiredByContainer.get(obj.location);
    if (!members) {
      members = new Set();
      desiredByContainer.set(obj.location, members);
    }
    members.add(obj.id);
  }

  let changed = false;
  for (const container of serialized.objects) {
    const next = new Set<ObjRef>();
    for (const member of container.contents) {
      const memberRow = byId.get(member);
      if (memberRow && memberRow.location !== container.id) {
        changed = true;
        continue;
      }
      next.add(member);
    }
    for (const member of desiredByContainer.get(container.id) ?? []) next.add(member);
    const contents = Array.from(next).sort();
    if (stableShadowJson(contents as unknown as WooValue) === stableShadowJson(container.contents as unknown as WooValue)) continue;
    container.contents = contents;
    changed = true;
  }
  return changed;
}

function emptySerializedWorldFromAuthority(authority: SerializedAuthorityCellSlice): SerializedWorld {
  return {
    version: 1,
    objectCounter: authority.counters.objectCounter,
    parkedTaskCounter: authority.counters.parkedTaskCounter,
    sessionCounter: authority.counters.sessionCounter,
    objects: [],
    sessions: authority.sessions.map((session) => structuredClone(session) as SerializedSession).sort((a, b) => a.id.localeCompare(b.id)),
    logs: [],
    snapshots: [],
    parkedTasks: [],
    tombstones: [...authority.tombstones].sort()
  };
}

function authorityPageKey(page: ShadowStatePage): string {
  return `${page.object}:${page.page}:${authorityPageIdentityName(page)}`;
}

function authorityPageRefKey(ref: Pick<ShadowStatePageRef, "object" | "page" | "name">): string {
  return `${ref.object}:${ref.page}:${ref.name ?? ""}`;
}

function authorityPageIdentityName(page: ShadowStatePage): string {
  return page.page === "property_cell" || page.page === "verb_bytecode" ? page.name : "";
}

function compareAuthorityPageRefs(a: ShadowStatePageRef, b: ShadowStatePageRef): number {
  return a.object.localeCompare(b.object) || a.page.localeCompare(b.page) || (a.name ?? "").localeCompare(b.name ?? "");
}

function compareAuthorityPages(a: ShadowStatePage, b: ShadowStatePage): number {
  return authorityPageKey(a).localeCompare(authorityPageKey(b));
}

function inferSessionCounter(sessions: readonly SerializedSession[]): number {
  let max = 1;
  for (const session of sessions) {
    const match = session.id.match(/:(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]) + 1);
  }
  return max;
}

function inferObjectCounter(objects: readonly SerializedObject[]): number {
  let max = 1;
  for (const obj of objects) {
    const match = obj.id.match(/^#-(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]) + 1);
  }
  return max;
}
