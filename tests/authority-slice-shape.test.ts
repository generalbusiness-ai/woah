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
  filterSerializedAuthoritySlicePages,
  mergeSerializedAuthoritySlice,
  serializedWorldFromAuthoritySlice,
  withAuthorityPageProvenance
} from "../src/core/authority-slice";
import { createWorld } from "../src/core/bootstrap";
import { executorAuthorityPayload } from "../src/core/executor";
import type { SerializedObject } from "../src/core/repository";

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
