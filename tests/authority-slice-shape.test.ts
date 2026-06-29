// Authority-slice content contract:
//
// `WooWorld.exportAuthoritySlice` returns the executor's view of the world
// needed to validate and plan the next turn. The contract is "explicit roots
// plus their one-hop expansion plus their class chains" — NOT "every $-prefixed
// class object in the world".
//
// The catalog sweep version of this function (5b1f77c) tried to be safe by
// including every $-prefixed object on every refresh. In production that
// inflated the cross-host /__internal/authority-slice payload to ~3 MB / 1000
// page-refs and pushed cold-open round-trips past the 5s HOST_READ_RPC_TIMEOUT
// ceiling, hanging MCP turns. The fix trusts the reachability walk: parent
// classes, owners, contents, and property/argument value refs already cover
// the catalog dependencies that any legitimate turn needs. Catalog code that
// is NOT reachable from the explicit roots arrives via the first-open
// `serialized` seed (CommitScopeDO returns E_SNAPSHOT_REQUIRED and the gateway
// retries) — not via per-envelope authority refresh.

import { describe, expect, it } from "vitest";
import {
  authoritySliceObjectIds,
  buildSerializedAuthorityCellSlice,
  cellProvenanceFromAuthoritySlice,
  combineSerializedAuthoritySlices,
  isAuthorityCellSlice,
  filterSerializedAuthoritySlicePages,
  mergeSerializedAuthoritySlice,
  serializedWorldFromAuthoritySlice,
  withAuthorityPageProvenance
} from "../src/core/authority-slice";
import { createWorld } from "../src/core/bootstrap";
import { executorAuthorityPayload } from "../src/core/executor";
import type { SerializedAuthorityCellSlice, SerializedObject, SerializedSession } from "../src/core/repository";
import {
  shadowObjectLivePage,
  shadowStatePageHash,
  shadowStatePagesForObject,
  shadowStatePageRef,
  shadowVerbBytecodePages,
  stampAuthorityPageRef
} from "../src/core/shadow-state-pages";
import type { ShadowVerbBytecodePage } from "../src/core/shadow-state-pages";

describe("WooWorld.exportAuthoritySlice content contract", () => {
  it("includes the explicit root plus its parent class chain", () => {
    const world = createWorld();
    const slice = world.exportAuthoritySlice([], ["the_chatroom"]);
    const ids = new Set(authoritySliceObjectIds(slice));
    expect(ids.has("the_chatroom")).toBe(true);
    expect(ids.has("$room")).toBe(true);
  });

  it("does NOT include unreferenced catalog classes (no $-prefix sweep)", () => {
    // Regression bait. Before the fix, exportAuthoritySlice ran a loop over
    // every $-prefixed object in the world and pushed each one. That inflated
    // the per-envelope cross-host RPC body and tripped cold-open timeouts in
    // production. `$dubspace` is part of the bundled boot graph but is not on
    // the_chatroom's class chain and not in its contents, so it must not
    // appear in a slice rooted at the chatroom alone.
    const world = createWorld();
    const slice = world.exportAuthoritySlice([], ["the_chatroom"]);
    const ids = new Set(authoritySliceObjectIds(slice));
    // $pinboard and $task_registry are catalog classes that are NOT on the
    // chatroom's class chain and NOT in its immediate contents, so they must
    // not appear in a chat-rooted slice. (Note: $dubspace and $outliner WILL
    // appear because the_dubspace and the_outline are physically in the
    // chatroom — that's correct one-hop reachability, not the sweep.)
    expect(ids.has("$pinboard")).toBe(false);
    expect(ids.has("$task_registry")).toBe(false);
  });

  it("keeps the slice payload bounded for a narrow root set", () => {
    // A two-root query (room + actor) should not return >50 objects on a
    // fresh bundled world. The previous sweep returned ~95 (every $-prefixed
    // class plus the actor's local graph). The contract is: only what dispatch
    // needs for verbs reachable from those roots.
    const world = createWorld();
    const session = world.auth("guest:slice-narrow");
    const slice = world.exportAuthoritySlice([], ["the_chatroom", session.actor]);
    const ids = new Set(authoritySliceObjectIds(slice));
    expect(ids.size).toBeLessThanOrEqual(50);
  });

  it("expands explicit roots monotonically regardless of order", () => {
    // Regression: if `the_dubspace` was first reached as a content of
    // `the_chatroom` (transitive push, no value-trace), a later explicit-root
    // push could not "upgrade" it to traceValues:"full" because `seen` had
    // already gated the property walk. So
    //   exportAuthoritySlice([], ["the_dubspace", "the_chatroom"])
    // omitted $exit, both living-room exits, and the_deck — while the SAME
    // roots in the reverse order surfaced them. executor.ts orders the roots
    // as [commitScope, scope, target, actor, …], so a turn whose target is
    // nested inside its commit scope would routinely lose exit/destination
    // refs and dispatch would fail with E_OBJNF.
    const world = createWorld();
    const a = world.exportAuthoritySlice([], ["the_dubspace", "the_chatroom"]);
    const b = world.exportAuthoritySlice([], ["the_chatroom", "the_dubspace"]);
    const aIds = new Set(authoritySliceObjectIds(a));
    const bIds = new Set(authoritySliceObjectIds(b));
    expect(aIds).toEqual(bIds);
    // And both orderings must include the_chatroom's full one-hop expansion.
    expect(aIds.has("the_deck")).toBe(true);
    expect(aIds.has("$exit")).toBe(true);
  });

  it("surfaces objects named by inherited propertyDef defaults", () => {
    // Regression bait: `getPropertyValue` falls through to the class
    // propertyDef's `defaultValue` when an instance does not store its own
    // value (src/core/property-read.ts). A verb body that reads
    // `instance.pointer` then gets back the class default's ref. If the
    // slice does not surface that ref, dispatch fails with E_OBJNF.
    // Tracing live property-cell values alone misses this case — we must
    // also follow `propertyDefs[*].defaultValue` refs on every class we
    // pull in.
    const world = createWorld();
    type WorldAny = { createObject: (input: { id: string; parent: string | null }) => unknown; defineProperty: (id: string, def: { name: string; defaultValue: unknown; owner: string; perms: string }) => unknown };
    const w = world as unknown as WorldAny;
    w.createObject({ id: "ref_target_obj", parent: "$thing" });
    w.createObject({ id: "ref_class", parent: "$thing" });
    w.defineProperty("ref_class", { name: "pointer", defaultValue: "ref_target_obj", owner: "$wiz", perms: "rc" });
    w.createObject({ id: "ref_instance", parent: "ref_class" });
    const slice = world.exportAuthoritySlice([], ["ref_instance"]);
    const ids = new Set(authoritySliceObjectIds(slice));
    expect(ids.has("ref_instance")).toBe(true);
    expect(ids.has("ref_class")).toBe(true);
    expect(ids.has("ref_target_obj")).toBe(true);
  });

  it("includes a $-class when the caller threads it as an explicit root", () => {
    // Native helpers can resolve an object named only as an argument. The
    // executor pre-walks args/body to surface those refs (executor.ts
    // §executorAuthorityObjectIds), and the slice's reachability walk then
    // expands them. This case keeps the cross-actor contract alive without
    // re-introducing the $-sweep — the catalog object appears only because
    // the caller named it.
    const world = createWorld();
    const slice = world.exportAuthoritySlice([], ["the_chatroom", "$dubspace"]);
    const ids = new Set(authoritySliceObjectIds(slice));
    expect(ids.has("$dubspace")).toBe(true);
  });

  it("lets later cell-page slices override earlier legacy object slices", () => {
    // Mixed-format authority payloads happen when a sparse gateway contributes
    // a local legacy row and a remote owner contributes newer cell pages. The
    // combiner's precedence rule is slice order, not representation: the later
    // owner row must win or movement planning can run against stale room
    // contents while the commit authority validates against the fresh row.
    const staleDeck = objectRecord("the_deck", ["the_hot_tub"]);
    const freshDeck = objectRecord("the_deck", ["the_hot_tub", "the_towel", "the_pinboard", "the_horoscope"]);
    const combined = combineSerializedAuthoritySlices([], [
      { kind: "woo.authority_slice.shadow.v1", sessions: [], objects: [staleDeck] },
      buildSerializedAuthorityCellSlice({
        sessions: [],
        objects: [freshDeck],
        counters: { objectCounter: 1, parkedTaskCounter: 1, sessionCounter: 1 },
        pageProvenance: () => ({ source: "authoritative" as const })
      })
    ]);
    const serialized = serializedWorldFromAuthoritySlice(combined);
    // Room contents are a derived set projection; merge precedence is about
    // membership, not the array order chosen by the serialized view.
    expect([...(serialized.objects.find((obj) => obj.id === "the_deck")?.contents ?? [])].sort()).toEqual([...freshDeck.contents].sort());
  });

  it("stamps mandatory provenance on every page, including legacy-object conversions (A3)", () => {
    // A3: a SerializedAuthorityCellSlice cannot carry a page without a `source`.
    // The risky case is the representation bridge: a legacy object-row slice
    // reaching combine has no per-page provenance, yet combine emits cell pages.
    // Those converted pages must be stamped — and conservatively, since combine
    // cannot verify the legacy rows are an owner's authoritative state — so the
    // downstream gateway/VM read path never mistakes them for write-authority.
    const legacyRoom = objectRecord("legacy_room", ["legacy_item"]);
    const ownerItem = objectRecord("legacy_item", []);
    const combined = combineSerializedAuthoritySlices([], [
      { kind: "woo.authority_slice.shadow.v1", sessions: [], objects: [legacyRoom] },
      buildSerializedAuthorityCellSlice({
        sessions: [],
        objects: [ownerItem],
        counters: { objectCounter: 1, parkedTaskCounter: 1, sessionCounter: 1 },
        pageProvenance: () => ({ source: "authoritative" as const })
      })
    ]);
    expect(combined.kind).toBe("woo.authority_slice.cells.shadow.v1");
    if (combined.kind !== "woo.authority_slice.cells.shadow.v1") return;
    // Every page carries a source — no undefined slips through.
    expect(combined.page_refs.every((ref) => typeof ref.source === "string")).toBe(true);
    // The converted legacy-room pages are conservatively non-authoritative.
    const legacyRefs = combined.page_refs.filter((ref) => ref.object === "legacy_room");
    expect(legacyRefs.length).toBeGreaterThan(0);
    expect(legacyRefs.every((ref) => ref.source === "fallback")).toBe(true);
    // The owner cell slice keeps its declared authoritative provenance.
    expect(combined.page_refs.filter((ref) => ref.object === "legacy_item").every((ref) => ref.source === "authoritative")).toBe(true);
  });

  it("carries optional authority-page provenance without changing materialization", () => {
    const room = objectRecord("room_owner", ["item_a"]);
    const item = objectRecord("item_a", []);
    const slice = buildSerializedAuthorityCellSlice({
      sessions: [],
      objects: [room, item],
      counters: { objectCounter: 1, parkedTaskCounter: 1, sessionCounter: 1 },
      pageProvenance: (page) => ({
        source: page.object === "room_owner" ? "authoritative" : "cache",
        source_host: "room_owner"
      })
    });

    expect(slice.page_refs.every((ref) => ref.source_host === "room_owner")).toBe(true);
    expect(slice.page_refs.filter((ref) => ref.object === "room_owner").every((ref) => ref.source === "authoritative")).toBe(true);
    expect(slice.page_refs.filter((ref) => ref.object === "item_a").every((ref) => ref.source === "cache")).toBe(true);
    expect(new Set(serializedWorldFromAuthoritySlice(slice).objects.map((obj) => obj.id))).toEqual(new Set(["room_owner", "item_a"]));

    const fallback = withAuthorityPageProvenance(slice, () => ({ source: "fallback", source_host: "mcp-gateway-0" }));
    expect(fallback.kind).toBe("woo.authority_slice.cells.shadow.v1");
    if (fallback.kind === "woo.authority_slice.cells.shadow.v1") {
      expect(fallback.page_refs.every((ref) => ref.source === "fallback" && ref.source_host === "mcp-gateway-0")).toBe(true);
    }
  });

  it("filterSerializedAuthoritySlicePages keeps each referenced object's lineage page even when the predicate drops it", () => {
    // Repro for the cross-room-move "state page set missing lineage page" failure
    // (shadow-state-pages.ts:252). A page-granularity filter (the gateway's
    // owner-only / gap-fill filter, filterRemoteAuthoritySliceForGateway) can admit
    // a neighbor object's owner-sourced cell page while dropping its non-owner
    // object_lineage page. A receiver that lacks the object then cannot reconstruct
    // it. The lineage page MUST co-travel with any kept page of the same object.
    const room: SerializedObject = { ...objectRecord("the_deck", []), name: "The Deck", parent: "$room", owner: "the_deck" };
    const slice = buildSerializedAuthorityCellSlice({
      sessions: [],
      objects: [room],
      counters: { objectCounter: 1, parkedTaskCounter: 1, sessionCounter: 1 },
      pageProvenance: () => ({ source: "authoritative" as const, source_host: "the_deck" })
    });
    expect(slice.page_refs.some((ref) => ref.object === "the_deck" && ref.page === "object_lineage")).toBe(true);

    // A predicate that drops the lineage page (e.g. it was non-owner-sourced) but
    // keeps the object's other pages — exactly the gateway gap-fill shape.
    const filtered = filterSerializedAuthoritySlicePages(slice, (ref) => ref.page !== "object_lineage");
    if (filtered.kind === "woo.authority_slice.cells.shadow.v1") {
      // The filter must re-add the lineage page so the object remains reconstructable.
      expect(filtered.page_refs.some((ref) => ref.object === "the_deck" && ref.page === "object_lineage")).toBe(true);
      expect(filtered.page_refs.find((ref) => ref.object === "the_deck" && ref.page === "object_lineage")?.source_host).toBe("the_deck");
      expect(filtered.page_refs).toEqual([...filtered.page_refs].sort(compareAuthorityRefsForTest));
    }
    // Must not throw "state page set missing lineage page for the_deck".
    const serialized = serializedWorldFromAuthoritySlice(filtered);
    expect(serialized.objects.find((obj) => obj.id === "the_deck")?.name).toBe("The Deck");
  });

  it("mergeSerializedAuthoritySlice uses inline lineage as reconstruction support when a final ref set dropped it", () => {
    // Final authority slices are assembled from several filtered sources. A
    // malformed page-ref set can keep a new object's live/cell page while losing
    // the lineage ref, even though the inline lineage page is still present in
    // the bundle. The merge boundary must use that inline lineage as fill-only
    // scaffolding instead of throwing "state page set missing lineage page".
    const room: SerializedObject = { ...objectRecord("lineage_gap_room", ["lineage_gap_item"]), name: "Lineage Gap Room" };
    const full = buildSerializedAuthorityCellSlice({
      sessions: [],
      objects: [room],
      counters: { objectCounter: 1, parkedTaskCounter: 1, sessionCounter: 1 },
      pageProvenance: () => ({ source: "projection" as const, source_host: "mcp-gateway-2" })
    });
    const missingLineageRef = {
      ...full,
      page_refs: full.page_refs.filter((ref) => ref.object !== "lineage_gap_room" || ref.page !== "object_lineage")
    };
    const serialized = {
      version: 1 as const,
      objectCounter: 1,
      parkedTaskCounter: 1,
      sessionCounter: 1,
      objects: [] as SerializedObject[],
      sessions: [],
      logs: [],
      snapshots: [],
      parkedTasks: [],
      tombstones: []
    };
    const provenance = new Map();
    expect(() => mergeSerializedAuthoritySlice(serialized, missingLineageRef, { clone: true, cellProvenance: provenance })).not.toThrow();
    expect(serialized.objects.find((obj) => obj.id === "lineage_gap_room")).toMatchObject({
      id: "lineage_gap_room",
      name: "Lineage Gap Room",
      contents: ["lineage_gap_item"]
    });
    expect(provenance.get("lineage_gap_room:object_lineage:")).toEqual({ source: "fallback" });

    const materialized = serializedWorldFromAuthoritySlice(missingLineageRef);
    expect(materialized.objects.find((obj) => obj.id === "lineage_gap_room")).toMatchObject({
      id: "lineage_gap_room",
      name: "Lineage Gap Room",
      contents: ["lineage_gap_item"]
    });
  });

  it("combineSerializedAuthoritySlices drops projection cells whose object lineage is absent", () => {
    // Directory/session projection can know that an actor appears in a scope
    // before the shard has fetched that scope's owner lineage. A live-only scope
    // cell is useful as support material only when another slice also carries the
    // scope identity; it must not create an unmaterializable standalone seed.
    const deck = { ...objectRecord("the_deck", ["guest_1"]), name: "the_deck", parent: "$space", owner: "$wiz" };
    const livePage = shadowObjectLivePage(deck);
    const liveOnly: SerializedAuthorityCellSlice = {
      kind: "woo.authority_slice.cells.shadow.v1",
      sessions: [],
      page_refs: [stampAuthorityPageRef(livePage, true, { source: "projection", source_host: "mcp-gateway-1" })],
      inline_pages: [livePage],
      counters: { objectCounter: 1, parkedTaskCounter: 1, sessionCounter: 1 },
      tombstones: [],
      source_object_count: 1
    };
    const actor = buildSerializedAuthorityCellSlice({
      sessions: [],
      objects: [{ ...objectRecord("guest_1", []), name: "Guest 1", parent: "$player", owner: "guest_1" }],
      counters: { objectCounter: 1, parkedTaskCounter: 1, sessionCounter: 1 },
      pageProvenance: () => ({ source: "projection" as const, source_host: "mcp-gateway-1" })
    });

    const combined = combineSerializedAuthoritySlices([], [liveOnly, actor]);
    expect(isAuthorityCellSlice(combined)).toBe(true);
    if (isAuthorityCellSlice(combined)) {
      expect(combined.page_refs.some((ref) => ref.object === "the_deck")).toBe(false);
      expect(combined.inline_pages.some((page) => page.object === "the_deck")).toBe(false);
    }
    expect(() => serializedWorldFromAuthoritySlice(combined)).not.toThrow();
    expect(serializedWorldFromAuthoritySlice(combined).objects.map((obj) => obj.id)).toEqual(["guest_1"]);
  });

  it("refuses a non-authoritative projection stub from overwriting a named lineage (CA11 symmetric stub guard)", () => {
    // Reverse of stub-repair: when the planning world already holds the resolved
    // identity ("Guest 1", projection) and an equal-rank projection page arrives
    // carrying the id-as-name stub, the stub MUST NOT win. Only the owner's
    // authoritative page may set an identity to its id.
    const named: SerializedObject = { ...objectRecord("guest_1", []), name: "Guest 1", parent: "$player", owner: "guest_1" };
    const stub: SerializedObject = { ...objectRecord("guest_1", []), name: "guest_1", parent: "$player", owner: "guest_1" };
    const namedSlice = buildSerializedAuthorityCellSlice({
      sessions: [],
      objects: [named],
      counters: { objectCounter: 1, parkedTaskCounter: 1, sessionCounter: 1 },
      pageProvenance: () => ({ source: "projection" as const, source_host: "mcp-gateway-2" })
    });
    const serialized = serializedWorldFromAuthoritySlice(namedSlice);
    const cellProvenance = cellProvenanceFromAuthoritySlice(namedSlice);
    const stubSlice = buildSerializedAuthorityCellSlice({
      sessions: [],
      objects: [stub],
      counters: { objectCounter: 1, parkedTaskCounter: 1, sessionCounter: 1 },
      pageProvenance: () => ({ source: "projection" as const, source_host: "the_deck" })
    });
    mergeSerializedAuthoritySlice(serialized, stubSlice, { clone: true, cellProvenance });
    expect(serialized.objects.find((obj) => obj.id === "guest_1")?.name).toBe("Guest 1");
  });

  it("repairs a non-authoritative id-as-name stub with a named projection page (CA11 stub repair)", () => {
    // Forward direction: a seeded `cache` stub (name===id) is repaired by a fresh
    // named projection, even when the stub's provenance is unknown at the merge.
    const stub: SerializedObject = { ...objectRecord("guest_1", []), name: "guest_1", parent: "$player", owner: "guest_1" };
    const named: SerializedObject = { ...objectRecord("guest_1", []), name: "Guest 1", parent: "$player", owner: "guest_1" };
    const stubSlice = buildSerializedAuthorityCellSlice({
      sessions: [],
      objects: [stub],
      counters: { objectCounter: 1, parkedTaskCounter: 1, sessionCounter: 1 },
      pageProvenance: () => ({ source: "cache" as const, source_host: "the_deck" })
    });
    const serialized = serializedWorldFromAuthoritySlice(stubSlice);
    // Empty provenance map simulates a seed that bypassed the recording merge:
    // the stub's provenance is unknown, yet a named page must still repair it.
    const cellProvenance = cellProvenanceFromAuthoritySlice({ kind: "woo.authority_slice.cells.shadow.v1", sessions: [], page_refs: [], inline_pages: [], counters: { objectCounter: 1, parkedTaskCounter: 1, sessionCounter: 1 }, tombstones: [], source_object_count: 0 });
    const namedSlice = buildSerializedAuthorityCellSlice({
      sessions: [],
      objects: [named],
      counters: { objectCounter: 1, parkedTaskCounter: 1, sessionCounter: 1 },
      pageProvenance: () => ({ source: "projection" as const, source_host: "mcp-gateway-2" })
    });
    mergeSerializedAuthoritySlice(serialized, namedSlice, { clone: true, cellProvenance });
    expect(serialized.objects.find((obj) => obj.id === "guest_1")?.name).toBe("Guest 1");
  });

  it("does not report no-op cell-page order normalization as an authority change", () => {
    // The CommitScope executable-seed cache is invalidated from this merge
    // return value. A raw world export and a repaired sparse snapshot can name
    // the same contents set in different array order; that must not clear the
    // open-seed digest when the final repaired state is unchanged.
    const world = createWorld();
    const session = world.auth("guest:slice-order-noop");
    const authority = executorAuthorityPayload(world, ["the_dubspace", session.actor]).authority;
    const serialized = serializedWorldFromAuthoritySlice(authority);
    expect(mergeSerializedAuthoritySlice(serialized, authority, { clone: true })).toBe(false);
  });

  it("keeps active session expiry monotonic when merging stale authority rows", () => {
    const actor = objectRecord("guest_1", []);
    const currentSession: SerializedSession = {
      id: "session-active",
      actor: actor.id,
      started: 1_000,
      expiresAt: 60_000,
      lastDetachAt: null,
      tokenClass: "guest",
      activeScope: "the_chatroom"
    };
    const staleAuthoritySession: SerializedSession = {
      ...currentSession,
      expiresAt: 20_000,
      activeScope: "the_deck"
    };
    const serialized = {
      sessions: [currentSession],
      objects: [actor]
    };

    mergeSerializedAuthoritySlice(serialized, {
      kind: "woo.authority_slice.shadow.v1",
      sessions: [staleAuthoritySession],
      objects: [actor]
    }, { clone: true });

    expect(serialized.sessions).toEqual([{
      ...staleAuthoritySession,
      expiresAt: currentSession.expiresAt
    }]);
  });
});

function objectRecord(id: string, contents: string[]): SerializedObject {
  return {
    id,
    name: id,
    parent: null,
    anchor: null,
    owner: "$wiz",
    location: null,
    flags: {},
    created: 0,
    modified: 0,
    propertyDefs: [],
    properties: [],
    propertyVersions: [],
    verbs: [],
    children: [],
    contents,
    eventSchemas: []
  };
}

function compareAuthorityRefsForTest(
  a: { object: string; page: string; name?: string },
  b: { object: string; page: string; name?: string }
): number {
  return a.object.localeCompare(b.object) || a.page.localeCompare(b.page) || (a.name ?? "").localeCompare(b.name ?? "");
}

// CA12.2: a verb_bytecode page's identity hash is line_map-blind. line_map is
// authoring/diagnostic metadata (pc -> source position), so the same verb with
// or without it MUST hash identically — that is what makes it safe to omit
// line_map from a delivered authority page (the dominant slice-byte contributor)
// without desynchronising page-ref/verification. These tests fail before the
// canonical-preimage change and pass after it.
describe("CA12.2 verb_bytecode page-hash is line_map-blind", () => {
  // A serialized verb_bytecode page that actually carries a populated line_map.
  function verbPageWithLineMap(): { world: ReturnType<typeof createWorld>; page: ShadowVerbBytecodePage } {
    const world = createWorld({ catalogs: ["chat", "demoworld", "note", "pinboard", "tasks"] });
    for (const id of ["$pinboard", "$task_registry", "$note", "$exit", "$room"]) {
      const objs = world.exportObjects([id]);
      if (objs.length === 0) continue;
      const page = shadowVerbBytecodePages(objs[0]).find(
        (p) => Object.keys((p.verb as { line_map?: Record<string, unknown> }).line_map ?? {}).length > 0
      );
      if (page) return { world, page };
    }
    throw new Error("no verb_bytecode page with a populated line_map found in the demo world");
  }

  function strip(page: ShadowVerbBytecodePage): ShadowVerbBytecodePage {
    return { ...page, verb: { ...page.verb, line_map: {} } };
  }

  it("hashes identical verb pages the same whether or not line_map is present", () => {
    const { page } = verbPageWithLineMap();
    expect(Object.keys((page.verb as { line_map: Record<string, unknown> }).line_map).length).toBeGreaterThan(0);
    expect(shadowStatePageHash(strip(page))).toBe(shadowStatePageHash(page));
    expect(shadowStatePageRef(strip(page), true).hash).toBe(shadowStatePageRef(page, true).hash);
  });

  it("lets a ref minted from the full page identify a line_map-stripped inline page", () => {
    const { page } = verbPageWithLineMap();
    // The ref a sender mints from the full page must still identify the page
    // after delivery strips line_map — otherwise verification cannot pair them.
    expect(shadowStatePageHash(strip(page))).toBe(shadowStatePageRef(page, true).hash);
  });

  it("hashes populated, empty, and absent line_map identically", () => {
    // The canonical preimage MUST collapse all three wire shapes (CA12.2). The
    // "absent" case matters: a delivered page that omitted the property entirely
    // must not hash differently from `line_map: {}`, or a mixed-version fleet
    // (old full-line_map refs vs new stripped/omitted inline pages) fails to
    // pair during the rollout reseed convergence.
    const { page } = verbPageWithLineMap();
    const populated = page;
    const empty: ShadowVerbBytecodePage = { ...page, verb: { ...page.verb, line_map: {} } };
    // Reproduce a wire page whose verb has NO line_map property at all.
    const absentVerb = { ...page.verb } as Record<string, unknown>;
    delete absentVerb.line_map;
    const absent = { ...page, verb: absentVerb } as unknown as ShadowVerbBytecodePage;
    expect(Object.prototype.hasOwnProperty.call(absent.verb, "line_map")).toBe(false);

    const h = shadowStatePageHash(populated);
    expect(shadowStatePageHash(empty)).toBe(h);
    expect(shadowStatePageHash(absent)).toBe(h);
    expect(shadowStatePageRef(empty, true).hash).toBe(shadowStatePageRef(populated, true).hash);
    expect(shadowStatePageRef(absent, true).hash).toBe(shadowStatePageRef(populated, true).hash);
  });

  it("keeps line_map out of identity but reflects actual size in ref.bytes", () => {
    const { page } = verbPageWithLineMap();
    // Identity is line_map-blind; `bytes` is a size hint, not identity, so a
    // stripped page is smaller. This guards against re-folding line_map back
    // into the page hash (which would reintroduce the delivery-edge desync bug).
    expect(shadowStatePageHash(strip(page))).toBe(shadowStatePageHash(page));
    expect(shadowStatePageRef(strip(page), true).bytes).toBeLessThan(shadowStatePageRef(page, true).bytes);
  });

  it("delivers stripped inline verb pages that still materialize with bytecode (end state)", () => {
    // End-state guard after Commit B: exportAuthoritySlice ALREADY strips line_map
    // from delivered verb pages (buildSerializedAuthorityCellSlice). Assert the
    // delivered inline pages are stripped, and that they still materialize with
    // execution-essential bytecode intact and an empty line_map.
    const world = createWorld({ catalogs: ["chat", "demoworld", "note", "pinboard", "tasks"] });
    const slice = world.exportAuthoritySlice([], ["$pinboard"]);
    expect(isAuthorityCellSlice(slice)).toBe(true);
    if (!isAuthorityCellSlice(slice)) throw new Error("expected a cell slice");
    const deliveredVerbPages = slice.inline_pages.filter((p) => p.page === "verb_bytecode");
    expect(deliveredVerbPages.length).toBeGreaterThan(0);
    for (const p of deliveredVerbPages) {
      expect(
        Object.keys((p as ShadowVerbBytecodePage).verb.line_map ?? {}).length,
        `delivered ${p.page} ${(p as ShadowVerbBytecodePage).name} must ship without line_map`
      ).toBe(0);
    }
    const materialized = serializedWorldFromAuthoritySlice(slice);
    const pinboard = materialized.objects.find((o) => o.id === "$pinboard");
    const bytecodeVerb = pinboard?.verbs.find((v) => v.kind === "bytecode");
    expect(bytecodeVerb, "$pinboard bytecode verb must survive materialization").toBeTruthy();
    expect((bytecodeVerb as { bytecode?: unknown }).bytecode, "execution-essential bytecode preserved").toBeTruthy();
    expect(Object.keys((bytecodeVerb as { line_map: Record<string, unknown> }).line_map).length).toBe(0);
  });

  it("materializes a MIXED-version slice: full-line_map refs paired with stripped inline pages", () => {
    // Rollout convergence: an old node mints refs from full (line_map-bearing)
    // pages while a new node delivers the same pages line_map-stripped inline.
    // serializedWorldFromAuthoritySlice pairs refs to inline by shadowStatePageHash,
    // so this materializes ONLY because the hash is line_map-blind. Build the
    // fixture by hand (buildSerializedAuthorityCellSlice now strips on its own).
    const { world, page } = verbPageWithLineMap();
    const obj = page.object;
    const fullPages = shadowStatePagesForObject(world.exportObjects([obj])[0]);
    expect(fullPages.some((p) => p.page === "verb_bytecode"
      && Object.keys((p as ShadowVerbBytecodePage).verb.line_map ?? {}).length > 0)).toBe(true);
    const slice: SerializedAuthorityCellSlice = {
      kind: "woo.authority_slice.cells.shadow.v1",
      sessions: [],
      // refs minted from FULL pages (old node)
      page_refs: fullPages.map((p) => stampAuthorityPageRef(p, true, { source: "authoritative" })),
      // inline pages with verb line_map STRIPPED (new node)
      inline_pages: fullPages.map((p) =>
        p.page === "verb_bytecode" ? { ...p, verb: { ...p.verb, line_map: {} } } : p
      ),
      counters: { objectCounter: 0, parkedTaskCounter: 0, sessionCounter: 0 },
      tombstones: [],
      source_object_count: 1
    };
    const materialized = serializedWorldFromAuthoritySlice(slice);
    const o = materialized.objects.find((x) => x.id === obj);
    const bytecodeVerb = o?.verbs.find((v) => v.kind === "bytecode");
    expect(bytecodeVerb, `${obj} bytecode verb must survive mixed-version materialization`).toBeTruthy();
    expect((bytecodeVerb as { bytecode?: unknown }).bytecode).toBeTruthy();
  });
});
