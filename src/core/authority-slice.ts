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
  applyAuthorityPageProvenance,
  mergeShadowStatePagesIntoSerialized,
  shadowStatePageHash,
  shadowStatePageRef,
  shadowStatePagesForObject,
  stampAuthorityPageRef,
  stripVerbBytecodePageLineMap,
  type AuthorityPageProvenance,
  type AuthorityPageRef,
  type AuthorityPageSource,
  type ShadowStatePage,
  type ShadowStatePageRef
} from "./shadow-state-pages";
import type { ObjRef, WooValue } from "./types";

export type MergeSerializedAuthorityInput =
  | SerializedAuthoritySlice
  | Pick<SerializedAuthorityObjectSlice, "sessions" | "objects">;

export type MergeSerializedAuthorityOptions = {
  clone?: boolean;
  // A3.2 provenance retrofit (mobile-heap sequence): when present, the merge
  // records and consults per-cell provenance for the tracked identity/live cells
  // (PROVENANCE_TRACKED_PAGES) so a fresher non-authoritative page may repair a
  // staler non-authoritative cell, while an authoritative cell is never
  // overwritten by a derived one. Callers that own a durable planning cache (the
  // gateway relay commit-scope) pass their cell-provenance side-table here; the
  // map is mutated in place. Callers that omit it keep the original CI-safe rule
  // (an existing cell is protected from any non-authoritative page), so no
  // behavior changes for legacy/one-shot merges.
  cellProvenance?: Map<string, AuthorityPageProvenance>;
  // B-iii incremental merge: when present, the merge populates these output sets
  // with the exact IDs that actually changed, so callers can update only the
  // changed rows in their indexed state instead of rebuilding the whole index.
  // An absent set means the caller does not need the incremental detail.
  changedObjectIds?: Set<ObjRef>;
  changedSessionIds?: Set<string>;
};

// Precedence among authority page sources. Higher wins. `authoritative` is the
// owner's truth and is never displaced by a derived copy. The remaining order
// reflects confidence: a Directory-published `projection` of a present session
// is fresher than a non-owner host's stored `cache` row, which beats a
// representation-bridge `fallback`, which beats opportunistic `gossip`.
export const AUTHORITY_SOURCE_RANK: Record<AuthorityPageSource, number> = {
  authoritative: 4,
  projection: 3,
  cache: 2,
  fallback: 1,
  gossip: 0
};

// The immediate slice of the provenance retrofit: identity (`object_lineage`,
// carrying `name`/parent/owner) and `object_live` (location/contents). These are
// the cells roster/`who`/name resolution read, and the ones a stale cross-host
// `cache` stub blocks repair on. Other page kinds keep the original rule.
const PROVENANCE_TRACKED_PAGES = new Set<ShadowStatePage["page"]>(["object_lineage", "object_live"]);

// Whether an incoming page is allowed to overwrite an existing tracked cell given
// that cell's currently-recorded provenance. An `authoritative` page always lands
// (owner truth). A non-authoritative page may land only over a strictly-or-equally
// weaker non-authoritative cell; an authoritative (or unknown, hence conservatively
// protected) current cell is never displaced by a derived page. This is the
// merge-primitive form of VTN0 "a derived copy is never a write-authority source"
// that still permits projection→cache repair.
function authorityPageMayReplaceCurrent(
  incoming: AuthorityPageSource,
  current: AuthorityPageProvenance | undefined
): boolean {
  if (incoming === "authoritative") return true;
  const currentSource = current?.source ?? "authoritative";
  if (currentSource === "authoritative") return false;
  return AUTHORITY_SOURCE_RANK[incoming] >= AUTHORITY_SOURCE_RANK[currentSource];
}

// Is this page_ref an `object_lineage` whose resolved name equals its object id —
// i.e. a presentation stub rather than a real identity? Resolved via the inline
// page (the ref itself carries no name for lineage cells). A page absent from the
// inline map (a remote ref) cannot be proven a stub, so it is treated as named.
function pageRefIsStubLineage(ref: AuthorityPageRef, inlineByHash: ReadonlyMap<string, ShadowStatePage>): boolean {
  if (ref.page !== "object_lineage") return false;
  const page = inlineByHash.get(ref.hash);
  return page?.page === "object_lineage" && page.name === ref.object;
}

// Precedence for combining two page_refs for the same cell key. Higher provenance
// rank always wins (authoritative never displaced by a derived page). Among equal
// rank, a presentation stub never displaces a named lineage page; otherwise the
// later (candidate) slice wins, preserving slice order as the freshness signal.
function pageRefShouldReplace(
  existing: AuthorityPageRef,
  candidate: AuthorityPageRef,
  inlineByHash: ReadonlyMap<string, ShadowStatePage>
): boolean {
  const existingRank = AUTHORITY_SOURCE_RANK[existing.source];
  const candidateRank = AUTHORITY_SOURCE_RANK[candidate.source];
  if (candidateRank !== existingRank) return candidateRank > existingRank;
  const existingStub = pageRefIsStubLineage(existing, inlineByHash);
  const candidateStub = pageRefIsStubLineage(candidate, inlineByHash);
  if (existingStub !== candidateStub) return existingStub; // keep the named page; replace only if the existing one is the stub
  return true;
}

function recordCellProvenanceIfStronger(
  map: Map<string, AuthorityPageProvenance>,
  key: string,
  ref: AuthorityPageRef
): void {
  const existing = map.get(key);
  if (existing && AUTHORITY_SOURCE_RANK[ref.source] < AUTHORITY_SOURCE_RANK[existing.source]) return;
  map.set(key, ref.source_host !== undefined ? { source: ref.source, source_host: ref.source_host } : { source: ref.source });
}

// Build the initial cell-provenance side-table for a planning cache seeded from an
// authority slice. Only the tracked identity/live cells are captured; a legacy
// object slice (no per-page provenance) yields an empty map, so its cells stay
// conservatively protected.
export function cellProvenanceFromAuthoritySlice(authority: MergeSerializedAuthorityInput): Map<string, AuthorityPageProvenance> {
  const map = new Map<string, AuthorityPageProvenance>();
  if (!isAuthorityCellSlice(authority)) return map;
  for (const ref of authority.page_refs) {
    if (!PROVENANCE_TRACKED_PAGES.has(ref.page)) continue;
    recordCellProvenanceIfStronger(map, authorityPageRefKey(ref), ref);
  }
  return map;
}

// A3 (mobile-heap sequence): every authority cell page MUST declare a `source`.
// Provenance is no longer a decorative optional field — the gateway merge path
// REFUSES to trust a non-"authoritative" page as authority (see
// filterRemoteAuthoritySliceForGateway), so a page with no declared source would
// be silently un-trustable. `pageProvenance` is therefore required and MUST
// return a provenance whose `source` is set. This is the type-level half of
// VTN0's "a derived copy is never a write-authority source": a builder cannot
// produce an authority slice without saying, per page, whether it is the owner's
// authoritative row or a cache/projection/fallback derivation. `AuthorityPageRef`
// (the page_refs element type) makes that requirement load-bearing — the only
// way to mint one is through `stampAuthorityPageRef` / `applyAuthorityPageProvenance`.
export function buildSerializedAuthorityCellSlice(input: {
  sessions: readonly SerializedSession[];
  objects: readonly SerializedObject[];
  counters: Pick<SerializedWorld, "objectCounter" | "parkedTaskCounter" | "sessionCounter">;
  tombstones?: readonly ObjRef[];
  pageProvenance: (page: ShadowStatePage) => AuthorityPageProvenance;
}): SerializedAuthorityCellSlice {
  // CA12.2: strip verb `line_map` from delivered verb_bytecode pages. Page
  // identity is line_map-blind, so refs and inline pages still pair by hash; this
  // only removes the dominant byte contributor (~59% of slice bytes on the demo
  // world) from both the inline payload and the ref `bytes`. Done here (not at the
  // delivery edge) so refs and inline are built from the same stripped page and
  // their sizes agree.
  const pages = input.objects
    .flatMap((obj) => shadowStatePagesForObject(obj))
    .map(stripVerbBytecodePageLineMap);
  return {
    kind: "woo.authority_slice.cells.shadow.v1",
    sessions: structuredClone(input.sessions) as SerializedSession[],
    page_refs: pages.map((page) => stampAuthorityPageRef(page, true, input.pageProvenance(page))),
    inline_pages: pages.map((page) => structuredClone(page) as ShadowStatePage),
    counters: { ...input.counters },
    tombstones: [...(input.tombstones ?? [])].sort(),
    source_object_count: input.objects.length
  };
}

export function withAuthorityPageProvenance(
  authority: SerializedAuthoritySlice,
  provenance: (ref: AuthorityPageRef) => AuthorityPageProvenance | null | undefined
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
    // A null/undefined override keeps the page's existing (already mandatory)
    // provenance; a non-null override re-stamps it. Either way the result is a
    // well-formed AuthorityPageRef.
    page_refs: authority.page_refs.map((ref) => {
      const cloned = structuredClone(ref) as AuthorityPageRef;
      const override = provenance(ref);
      return override?.source ? applyAuthorityPageProvenance(cloned, override) : cloned;
    }),
    inline_pages: authority.inline_pages.map((page) => structuredClone(page) as ShadowStatePage),
    counters: { ...authority.counters },
    tombstones: [...authority.tombstones]
  };
}

export function serializedWorldFromAuthoritySlice(authority: MergeSerializedAuthorityInput): SerializedWorld {
  if (isAuthorityCellSlice(authority)) {
    const referenced = new Set(authority.page_refs.map((ref) => ref.hash));
    const pages = referencedInlinePagesWithLineage(authority, referenced);
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

function referencedInlinePagesWithLineage(
  authority: SerializedAuthorityCellSlice,
  referenced: ReadonlySet<string>
): ShadowStatePage[] {
  const pages = authority.inline_pages.filter((page) => referenced.has(shadowStatePageHash(page)));
  const objectsWithPages = new Set(pages.map((page) => page.object));
  const objectsWithLineage = new Set(pages
    .filter((page) => page.page === "object_lineage")
    .map((page) => page.object));
  if (objectsWithPages.size === objectsWithLineage.size) return pages;

  // Final page refs may drop fill-only lineage scaffolding while still carrying
  // changed non-lineage pages inline; merging those pages requires lineage too.
  const inlineLineageByObject = new Map<ObjRef, ShadowStatePage>();
  for (const page of authority.inline_pages) {
    if (page.page === "object_lineage") inlineLineageByObject.set(page.object, page);
  }
  for (const object of objectsWithPages) {
    if (objectsWithLineage.has(object)) continue;
    const lineage = inlineLineageByObject.get(object);
    if (!lineage) continue;
    pages.push(structuredClone(lineage) as ShadowStatePage);
    objectsWithLineage.add(object);
  }
  return pages;
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

// Provenance stamped onto pages synthesized from a legacy (object-row) slice
// during representation bridging. See the rationale at the conversion site in
// combineSerializedAuthoritySlices.
const LEGACY_OBJECT_SLICE_PROVENANCE: AuthorityPageProvenance = { source: "fallback" };

export function combineSerializedAuthoritySlices(
  sessions: readonly SerializedSession[],
  slices: readonly MergeSerializedAuthorityInput[]
): SerializedAuthoritySlice {
  const emitCellSlice = slices.some(isAuthorityCellSlice);
  const lastPageByKey = new Map<string, AuthorityPageRef>();
  const inlineByHash = new Map<string, ShadowStatePage>();
  const legacyObjects = new Map<ObjRef, SerializedObject>();
  let counters: Pick<SerializedWorld, "objectCounter" | "parkedTaskCounter" | "sessionCounter"> = {
    objectCounter: 1,
    parkedTaskCounter: 1,
    sessionCounter: inferSessionCounter(sessions)
  };
  const tombstones = new Set<ObjRef>();

  // Choose the winning page_ref per cell key by provenance, not raw slice order.
  // An authoritative page is never displaced by a derived one; among equal-rank
  // derived pages a later slice wins (slice order still encodes freshness), EXCEPT
  // that a presentation stub (`object_lineage` whose name === object id) never
  // displaces a named page of the same rank. This makes the combine consistent
  // with the merge-primitive precedence (mergeAuthorityCellPages) and the
  // PlanningWorld admission rules: a stale `name=id` lineage page can no longer
  // win admission over the fresh named/authoritative row purely because it was
  // ordered last (the cross-scope `who` "layer 3" defect — see
  // notes/2026-06-01-planning-world-admission.md).
  const considerPageRef = (ref: AuthorityPageRef): void => {
    const key = authorityPageRefKey(ref);
    const existing = lastPageByKey.get(key);
    if (existing && !pageRefShouldReplace(existing, ref, inlineByHash)) return;
    lastPageByKey.set(key, ref);
  };

  for (const slice of slices) {
    if (isAuthorityCellSlice(slice)) {
      counters = {
        objectCounter: Math.max(counters.objectCounter, slice.counters.objectCounter),
        parkedTaskCounter: Math.max(counters.parkedTaskCounter, slice.counters.parkedTaskCounter),
        sessionCounter: Math.max(counters.sessionCounter, slice.counters.sessionCounter)
      };
      for (const id of slice.tombstones) tombstones.add(id);
      // Inline pages must be present before ref precedence runs: the stub tiebreak
      // resolves a ref to its inline page by hash to read the lineage name.
      for (const page of slice.inline_pages) inlineByHash.set(shadowStatePageHash(page), structuredClone(page) as ShadowStatePage);
      for (const ref of slice.page_refs) considerPageRef(structuredClone(ref) as AuthorityPageRef);
      continue;
    }
    if (emitCellSlice) {
      // A3: a legacy object slice carries no per-page provenance, and this
      // representation bridge cannot verify the rows are an owner's current
      // authoritative state — it has no owning host in hand. We therefore stamp
      // the converted pages "fallback": they MAY fill a planning gap, but the
      // gateway/VM read path MUST NOT treat them as a write-authority source.
      // Under provenance-ranked precedence a fresher authoritative/projection page
      // for the same key wins regardless of slice order.
      for (const obj of slice.objects) {
        const pages = shadowStatePagesForObject(obj);
        for (const page of pages) {
          const ref = stampAuthorityPageRef(page, true, LEGACY_OBJECT_SLICE_PROVENANCE);
          inlineByHash.set(ref.hash, structuredClone(page) as ShadowStatePage);
          considerPageRef(ref);
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

  const pageRefs = Array.from(lastPageByKey.values()).sort(compareAuthorityPageRefs);
  const lineageObjects = new Set(pageRefs
    .filter((ref) => ref.page === "object_lineage")
    .map((ref) => ref.object));
  // A combined authority slice is commonly used as a standalone seed. Projection
  // helpers can contribute support cells such as object_live without identity;
  // keep those cells only when some slice also supplied lineage for the object.
  const lineageClosedPageRefs = pageRefs.filter((ref) => ref.page === "object_lineage" || lineageObjects.has(ref.object));
  const keptHashes = new Set(lineageClosedPageRefs.map((ref) => ref.hash));

  return {
    kind: "woo.authority_slice.cells.shadow.v1",
    sessions: sessions.map((session) => structuredClone(session) as SerializedSession),
    page_refs: lineageClosedPageRefs,
    inline_pages: Array.from(inlineByHash.values())
      .filter((page) => keptHashes.has(shadowStatePageHash(page)))
      .sort(compareAuthorityPages),
    counters,
    tombstones: Array.from(tombstones).sort(),
    source_object_count: new Set(lineageClosedPageRefs.map((ref) => ref.object)).size
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
    .map((ref) => structuredClone(ref) as AuthorityPageRef);
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
        .filter((obj) => shadowStatePagesForObject(obj).some((page) => include(stampAuthorityPageRef(page, true, LEGACY_OBJECT_SLICE_PROVENANCE))))
        .map((obj) => structuredClone(obj) as SerializedObject)
    };
  }
  const pageRefs = authority.page_refs
    .filter(include)
    .map((ref) => structuredClone(ref) as AuthorityPageRef);
  const keptObjects = new Set(pageRefs.map((ref) => ref.object));
  // Lineage-completeness invariant: mergeShadowStatePagesIntoSerialized
  // (shadow-state-pages.ts) requires that any object referenced by a kept page
  // also carries its object_lineage page, so a receiver that lacks the object can
  // reconstruct it. A page-granularity `include` predicate (e.g. the gateway's
  // owner-only / gap-fill filter) can admit an object's cell page while dropping
  // its non-owner lineage page — producing a slice that throws "state page set
  // missing lineage page" downstream (the cross-room-move failure). Re-add each
  // kept object's lineage page from the original slice when the filter dropped it.
  // The page keeps its original provenance, so the merge still refuses to treat a
  // non-authoritative lineage as write-authority; it only fills the reconstruction
  // gap. (The legacy-object branch above keeps whole objects, so it is already
  // lineage-complete.)
  const objectsWithLineage = new Set(
    pageRefs.filter((ref) => ref.page === "object_lineage").map((ref) => ref.object)
  );
  for (const ref of authority.page_refs) {
    if (ref.page !== "object_lineage" || objectsWithLineage.has(ref.object) || !keptObjects.has(ref.object)) continue;
    pageRefs.push(structuredClone(ref) as AuthorityPageRef);
    objectsWithLineage.add(ref.object);
  }
  pageRefs.sort(compareAuthorityPageRefs);
  const keptHashes = new Set(pageRefs.map((ref) => ref.hash));
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

// B-i read-closure envelopes (VTN8.3). Filter a cell-slice authority to only
// carry pages for the turn's read closure:
//
//   read_closure(turn) =
//       pages( actor row
//            ∪ submitting-session rows
//            ∪ read_set(transcript)   // incl. permission/policy reads
//            ∪ write_preimages(transcript) )
//     ∪ lineage_closure(objects of those pages)
//
// The lineage closure is expanded by walking each closure object's parent
// chain using the lineage pages already present in the full authority slice.
// The `filterSerializedAuthoritySliceObjects` helper filters page_refs and
// inline_pages to the expanded set; it also preserves the lineage-page
// invariant (every kept object has its lineage page).
//
// Sessions are filtered to only the submitting session (by id) and any session
// whose actor is in the closure.  The counters and tombstones are retained
// unchanged — the CommitScopeDO's version gate compares only per-cell
// versions, not the counter watermarks, and tombstones are cheap.
export function filterAuthorityToReadClosure(
  authority: SerializedAuthoritySlice,
  closureObjectIds: ReadonlySet<ObjRef>,
  sessionIds: readonly string[]
): SerializedAuthoritySlice {
  if (!isAuthorityCellSlice(authority)) {
    // Legacy object-slice: filter to closure objects and session actors.
    const sessionSet = new Set(sessionIds);
    return {
      kind: "woo.authority_slice.shadow.v1",
      sessions: authority.sessions.filter(
        (s) => sessionSet.has(s.id) || closureObjectIds.has(s.actor)
      ).map((s) => structuredClone(s) as SerializedSession),
      objects: authority.objects.filter((o) => closureObjectIds.has(o.id)).map((o) => structuredClone(o) as SerializedObject)
    };
  }
  // Build a parent-lookup map from the lineage pages already in the slice.
  // We use inline_pages (which always carry lineage pages) rather than
  // page_refs alone, so the walk is complete even for objects whose owner is
  // a remote shard we seeded as "fallback" lineage.
  const parentOf = new Map<ObjRef, ObjRef>();
  for (const page of authority.inline_pages) {
    if (page.page === "object_lineage" && page.parent !== null && page.parent !== undefined) {
      parentOf.set(page.object, page.parent as ObjRef);
    }
  }
  // Expand the closure IDs to include their full lineage (parent chains) so
  // every object referenced by a kept page also has its lineage present.
  // Without this expansion a CommitScopeDO merge would fail the
  // "state page set missing lineage page for X" invariant when a parent object
  // first arrives via child pages only.
  // Track which IDs are "lineage-only ancestors" (not directly in the closure)
  // so we can strip their verb_bytecode pages — the validator only needs those
  // for objects that appear as verb-read targets in the transcript.
  const lineageOnlyIds = new Set<ObjRef>();
  const expandedIds = new Set<ObjRef>(closureObjectIds);
  for (const id of Array.from(closureObjectIds)) {
    let current: ObjRef = id;
    for (let depth = 0; depth < 32; depth++) {
      const parent = parentOf.get(current);
      if (!parent) break;
      if (!expandedIds.has(parent)) {
        expandedIds.add(parent);
        lineageOnlyIds.add(parent);
      }
      current = parent;
    }
  }
  const sessionSet = new Set(sessionIds);
  const filteredSessions = authority.sessions.filter(
    (s) => sessionSet.has(s.id) || expandedIds.has(s.actor)
  ).map((s) => structuredClone(s) as SerializedSession);
  // For lineage-only ancestors, strip verb_bytecode pages. The commit validator
  // only walks lineage for property-def resolution (propertyDefs chain walk) and
  // permission checks — it does NOT execute verbs on ancestors. Keeping only
  // object_live, object_lineage, and property_cell pages for these objects is
  // sufficient for validation and substantially reduces bytes.
  const filtered = filterSerializedAuthoritySlicePages(
    { ...authority, sessions: filteredSessions },
    (ref) => {
      if (!expandedIds.has(ref.object)) return false;
      // For lineage-only ancestors, exclude verb_bytecode pages.
      if (lineageOnlyIds.has(ref.object) && ref.page === "verb_bytecode") return false;
      return true;
    }
  );
  // Restore sessions (filterSerializedAuthoritySlicePages may not filter them
  // the same way — replace with our session-filtered list).
  if (isAuthorityCellSlice(filtered)) {
    return { ...filtered, sessions: filteredSessions };
  }
  return filtered;
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
  // B-iii: record which session rows actually changed so callers can update
  // only those entries in their indexed state.
  if (options.changedSessionIds) {
    const before = new Map(serialized.sessions.map((s) => [s.id, stableShadowJson(s as unknown as WooValue)]));
    for (const session of next) {
      const prev = before.get(session.id);
      if (prev === undefined || prev !== stableShadowJson(session as unknown as WooValue)) {
        options.changedSessionIds.add(session.id);
      }
    }
    // Also record sessions removed from `next` (deleted sessions).
    const nextIds = new Set(next.map((s) => s.id));
    for (const prev of serialized.sessions) {
      if (!nextIds.has(prev.id)) options.changedSessionIds.add(prev.id);
    }
  }
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
      // B-iii: record the new object as changed.
      options.changedObjectIds?.add(next.id);
      changed = true;
      continue;
    }
    if (stableShadowJson(serialized.objects[index] as unknown as WooValue) === stableShadowJson(next as unknown as WooValue)) continue;
    serialized.objects[index] = next;
    // B-iii: record the updated object as changed.
    options.changedObjectIds?.add(next.id);
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
  const objectsById = new Map<ObjRef, SerializedObject>();
  for (const obj of serialized.objects) {
    objectsById.set(obj.id, obj);
    for (const page of shadowStatePagesForObject(obj)) currentPages.set(authorityPageKey(page), { hash: shadowStatePageHash(page), page });
  }

  const cellProvenance = options.cellProvenance;
  const changedPages: ShadowStatePage[] = [];
  const inlineLineageByObject = new Map<ObjRef, ShadowStatePage>();
  for (const page of authority.inline_pages) {
    if (page.page === "object_lineage") inlineLineageByObject.set(page.object, page);
  }
  for (const ref of authority.page_refs) {
    const key = authorityPageRefKey(ref);
    const current = currentPages.get(key);
    const tracked = cellProvenance !== undefined && PROVENANCE_TRACKED_PAGES.has(ref.page);
    if (current?.hash === ref.hash) {
      // Value already matches; still let the recorded provenance strengthen
      // (e.g. an owner-authoritative confirmation of a value first seen as a
      // `cache` stub), so a later stale page cannot displace a now-confirmed cell.
      if (tracked) recordCellProvenanceIfStronger(cellProvenance!, key, ref);
      continue;
    }
    // A3.2: provenance is enforced at the boundary where a transferred cell page
    // becomes a row in the materialized planning world the VM reads from. For the
    // tracked identity/live cells (when the caller supplies a provenance table),
    // the decision uses the cell's RECORDED provenance: an authoritative cell is
    // never displaced by a derived page, but a fresher derived page MAY repair a
    // staler derived cell (projection→cache). Otherwise we fall back to the
    // original CI-safe rule — a non-authoritative page may only FILL a cell the
    // planning world lacks, never overwrite an existing one. Either way "a derived
    // copy is never a write-authority source" (VTN0) stays a property of the merge
    // primitive, inherited by every caller (gateway, REST, browser, checkpoint).
    if (current) {
      let mayReplace = tracked
        ? authorityPageMayReplaceCurrent(ref.source, cellProvenance!.get(key))
        : ref.source === "authoritative";
      // Stub repair: a `name===id` presentation stub whose recorded provenance is
      // not authoritative is never legitimate identity for a real object; a NAMED
      // lineage page (any source) repairs it. This closes the case where a stub
      // entered the planning world via a non-provenance-recording seed (so its
      // provenance is unknown and would otherwise default to authoritative-protected)
      // — the same admission rule the PlanningWorld gate enforces, applied in the
      // merge so the VM never plans against the id-as-name stub.
      if (!mayReplace && tracked && ref.page === "object_lineage") {
        const curObj = objectsById.get(ref.object);
        const incomingPage = incomingByHash.get(ref.hash);
        const incomingNamed = incomingPage?.page === "object_lineage" && incomingPage.name !== ref.object;
        const currentAuthoritative = cellProvenance!.get(key)?.source === "authoritative";
        if (curObj && curObj.name === ref.object && incomingNamed && !currentAuthoritative) {
          mayReplace = true;
        }
      }
      // Inverse stub guard (symmetric with the combine tiebreak): a
      // non-authoritative incoming presentation stub (`name===id`) must NEVER
      // displace a NAMED current lineage, even at equal-or-higher derived rank.
      // Only the owner's authoritative page may set an identity to its id. Without
      // this, an equal-rank projection stub could overwrite the resolved name (the
      // reverse of the repair direction above) — see cell-authority CA11.
      if (mayReplace && ref.source !== "authoritative" && ref.page === "object_lineage") {
        const curObj = objectsById.get(ref.object);
        const incomingPage = incomingByHash.get(ref.hash);
        const incomingStub = incomingPage?.page === "object_lineage" && incomingPage.name === ref.object;
        if (incomingStub && curObj && curObj.name !== ref.object) {
          mayReplace = false;
        }
      }
      if (!mayReplace) continue;
    }
    const incoming = incomingByHash.get(ref.hash);
    if (!incoming) {
      throw new Error(`authority cell page missing inline value: ${ref.object}:${ref.page}${ref.name ? `:${ref.name}` : ""}@${ref.hash}`);
    }
    const actual = shadowStatePageRef(incoming, true);
    if (actual.object !== ref.object || actual.page !== ref.page || actual.name !== ref.name || actual.hash !== ref.hash) {
      throw new Error(`authority cell page ref mismatch: ${ref.object}:${ref.page}${ref.name ? `:${ref.name}` : ""}`);
    }
    changedPages.push(options.clone ? structuredClone(incoming) as ShadowStatePage : incoming);
    // The cell now holds the incoming value, so its provenance is the incoming
    // page's. The replace guard already required incoming rank >= current rank,
    // so this never downgrades a tracked cell below what protected it.
    if (tracked) cellProvenance!.set(key, ref.source_host !== undefined ? { source: ref.source, source_host: ref.source_host } : { source: ref.source });
  }
  if (changedPages.length === 0) return false;
  // Reconstruction support invariant: a page-filtered slice can be semantically
  // valid for authority while still being incomplete as a materialization unit.
  // If another incoming page creates a new object and the slice still carries
  // that object's inline lineage page, add it as fill-only scaffolding so
  // mergeShadowStatePagesIntoSerialized can build the row. This does not create
  // authority for the lineage cell; missing official provenance remains fallback
  // and later owner-authoritative pages can still displace it.
  const changedObjectsWithLineage = new Set(changedPages
    .filter((page) => page.page === "object_lineage")
    .map((page) => page.object));
  for (const page of [...changedPages]) {
    if (objectsById.has(page.object) || changedObjectsWithLineage.has(page.object)) continue;
    const lineage = inlineLineageByObject.get(page.object);
    if (!lineage) continue;
    changedPages.push(options.clone ? structuredClone(lineage) as ShadowStatePage : lineage);
    changedObjectsWithLineage.add(page.object);
    if (cellProvenance) {
      const key = authorityPageKey(lineage);
      if (!cellProvenance.has(key)) cellProvenance.set(key, { source: "fallback" });
    }
  }

  // B-iii: the changed object IDs are exactly the set of objects in changedPages
  // (including scaffolding lineage objects added above). Record them before the
  // merge so the caller can do an incremental state update instead of a full O(n)
  // rebuild. The set may include NEW objects (not yet in objectsById) that the
  // merge introduces — those also need to be added to the indexed state.
  if (options.changedObjectIds) {
    for (const page of changedPages) options.changedObjectIds.add(page.object);
  }

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
