// Ordered-edge index — the room-owned authored-cell ordering primitive and
// its owner-computed bounded projection. These tests pin the two properties
// the net path depends on:
//   1. the authority-side scan (orderedChildrenRows) reduces a scope's edge
//      cells into ONE rank-sorted list, filtered by parent; and
//   2. a verb reads that ordering as one installed projection value in
//      planning — never by pulling every sibling's edge cell into the turn's
//      attestable read closure (the O(N) closure that blows the warm
//      envelope). This mirrors the compact room-roster planning tests.
import { describe, expect, it } from "vitest";
import { installVerb } from "../../src/core/authoring";
import { createWorld } from "../../src/core/bootstrap";
import { installCatalogManifest } from "../../src/core/catalog-installer";
import { cellsFromSerialized, storeCells } from "../../src/net/bridge";
import { CellStore, makeCell, type EpochStamp } from "../../src/net/cells";
import {
  ORDERED_EDGE_PROP,
  orderedChildrenRows,
  orderedEdgeCellKey,
  orderedNeighborsFromRows,
  orderedNeighborsQueryKey,
  readOrderedEdge
} from "../../src/net/ordered-edges";
import { planTurn, WARM_ENVELOPE_BYTE_LIMIT } from "../../src/net/plan";
import type { ScopeClassifier } from "../../src/net/route";
import { ScopeSequencer } from "../../src/net/scope";
import { propertyCellPayload } from "../../src/net/transcript";

const SCOPE = "home";
const EPOCH = "cat1";
const STAMP: EpochStamp = { scope_head: "h0", catalog_epoch: EPOCH };

// Every object anchors to the one shared scope the sequencer owns.
const classifier: ScopeClassifier = {
  scopeOf: () => SCOPE,
  isShared: (scope) => scope === SCOPE
};

function derivedViewOf(authority: CellStore): CellStore {
  const view = new CellStore("derived");
  for (const cell of storeCells(authority)) view.install(cell);
  return view;
}

/** An authored edge cell: a property_cell on the CHILD under ORDERED_EDGE_PROP
 * holding `{ parent, rank }` (wrapped by the property-cell payload). */
function edgeCell(child: string, parent: string | null, rank: string) {
  return makeCell({
    kind: "property_cell",
    object: child,
    name: ORDERED_EDGE_PROP,
    value: propertyCellPayload({ hasValue: true, value: { parent, rank } }),
    provenance: "authoritative",
    stamp: STAMP
  });
}

describe("ordered-edge cell representation", () => {
  it("keys an edge by its child object (O(1) by-child lookup)", () => {
    expect(orderedEdgeCellKey("item_7")).toBe(`property_cell:item_7:${ORDERED_EDGE_PROP}`);
  });

  it("reads a well-formed edge and rejects malformed payloads", () => {
    expect(readOrderedEdge(propertyCellPayload({ hasValue: true, value: { parent: "p", rank: "V" } }))).toEqual({ parent: "p", rank: "V" });
    expect(readOrderedEdge(propertyCellPayload({ hasValue: true, value: { parent: null, rank: "V" } }))).toEqual({ parent: null, rank: "V" });
    // Missing/empty rank, wrong parent type, and non-object all reject.
    expect(readOrderedEdge(propertyCellPayload({ hasValue: true, value: { parent: "p" } }))).toBeNull();
    expect(readOrderedEdge(propertyCellPayload({ hasValue: true, value: { parent: 5, rank: "V" } }))).toBeNull();
    expect(readOrderedEdge(propertyCellPayload({ hasValue: false }))).toBeNull();
    expect(readOrderedEdge(null)).toBeNull();
  });
});

describe("owner-side ordered-children scan (orderedChildrenRows)", () => {
  it("filters by parent and sorts by fractional rank, tie-breaking by child id", () => {
    const store = new CellStore("authority");
    // Two parents; ranks intentionally out of insertion order.
    store.install(edgeCell("c_b", "root", "W"));
    store.install(edgeCell("c_a", "root", "V"));
    store.install(edgeCell("c_c", "root", "X"));
    store.install(edgeCell("other", "elsewhere", "V")); // different parent
    store.install(edgeCell("r_1", null, "M")); // an ordering root (parent null)
    // Non-edge cells must be ignored.
    store.install(makeCell({ kind: "object_live", object: "c_a", value: { location: "root" }, provenance: "authoritative", stamp: STAMP }));

    expect(orderedChildrenRows(store.allCells(), "root")).toEqual([
      { child: "c_a", rank: "V" },
      { child: "c_b", rank: "W" },
      { child: "c_c", rank: "X" }
    ]);
    expect(orderedChildrenRows(store.allCells(), "elsewhere")).toEqual([{ child: "other", rank: "V" }]);
    expect(orderedChildrenRows(store.allCells(), null)).toEqual([{ child: "r_1", rank: "M" }]);
    expect(orderedChildrenRows(store.allCells(), "no_such_parent")).toEqual([]);
  });

  it("breaks a rank tie deterministically by child id", () => {
    const store = new CellStore("authority");
    store.install(edgeCell("z", "root", "V"));
    store.install(edgeCell("a", "root", "V"));
    expect(orderedChildrenRows(store.allCells(), "root")).toEqual([
      { child: "a", rank: "V" },
      { child: "z", rank: "V" }
    ]);
  });
});

describe("owner-computed ordered-children projection in planning", () => {
  /** A container plus a verb that reads its children's order via the builtin. */
  function harness(tag: string) {
    const world = createWorld();
    const session = world.auth(`guest:oc-${tag}`);
    world.createObject({ id: "the_list", name: "The List", parent: "$thing", owner: session.actor });
    const installed = installVerb(
      world,
      "the_list",
      "list_children",
      `verb :list_children() rxd { return ordered_children(this); }`,
      null
    );
    expect(installed.ok).toBe(true);
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seq.seed(cellsFromSerialized(world.exportWorld()));
    return { world, session, seq };
  }

  it("renders 120 ordered children from one transient value, no per-child closure cells", async () => {
    const { session, seq } = harness("120");
    const rows = Array.from({ length: 120 }, (_, i) => ({
      child: `item_${String(i).padStart(3, "0")}`,
      rank: `V${String(i).padStart(3, "0")}`
    }));

    const plan = await planTurn({
      call: {
        kind: "woo.turn_call.shadow.v1",
        id: "oc-120",
        route: "direct",
        scope: SCOPE,
        session: session.id,
        actor: session.actor,
        target: "the_list",
        verb: "list_children",
        args: []
      },
      view: derivedViewOf(seq.store),
      planningScope: SCOPE,
      classifier,
      base: seq.head(),
      idempotencyKey: "oc-120",
      stamp: seq.stamp(),
      planningOrderedChildren: [{ parent: "the_list", rows, version: "v0" }]
    });

    // The verb returned the full ordered projection...
    expect(plan.transcript.result).toHaveLength(120);
    expect(plan.transcript.result).toEqual(rows);
    // ...as ONE bounded value: the warm envelope stays well under the ceiling
    // and no per-child edge cell was pulled into the attestable read closure.
    expect(plan.envelopeBytes).toBeLessThan(WARM_ENVELOPE_BYTE_LIMIT);
    const readsAnyEdgeCell = plan.transcript.reads.some(
      (read) => (read.cell as { name?: unknown }).name === ORDERED_EDGE_PROP
        || (typeof read.cell.object === "string" && read.cell.object.startsWith("item_"))
    );
    expect(readsAnyEdgeCell).toBe(false);
  });

  it("escapes as a REPAIRABLE ordered-children miss (not terminal) when the projection is absent", async () => {
    // planTurn is the gateway planner; a missing projection is a repairable
    // E_MISSING_STATE naming the parent (`missing_ordered_children`), so the
    // gateway repair loop can fetch it and re-plan — never a terminal error.
    const { session, seq } = harness("miss");
    const planOnce = planTurn({
      call: {
        kind: "woo.turn_call.shadow.v1",
        id: "oc-miss",
        route: "direct",
        scope: SCOPE,
        session: session.id,
        actor: session.actor,
        target: "the_list",
        verb: "list_children",
        args: []
      },
      view: derivedViewOf(seq.store),
      planningScope: SCOPE,
      classifier,
      base: seq.head(),
      idempotencyKey: "oc-miss",
      stamp: seq.stamp()
    });

    await expect(planOnce).rejects.toMatchObject({
      code: "E_MISSING_STATE",
      detail: { missing_ordered_children: ["the_list"] }
    });
  });

  // P1.2 (reviewer repro): the projection-miss control signal MUST escape an
  // ordinary woocode `except` — otherwise a verb like $outline_item:recycle
  // (`try { here:_detach_item(...) } except err {}`) or _restore_item
  // (`try { this:move_item(...) } except err {}`) SWALLOWS the miss, the
  // transcript "succeeds", the gateway never repairs, and children keep edges
  // to a recycled/moved node. The miss must be uncatchable like E_TICKS /
  // E_NEED_STATE so it always reaches the gateway's repair path.
  it("a projection miss is UNCATCHABLE by woocode except — it escapes to the gateway repair", async () => {
    const world = createWorld();
    const session = world.auth("guest:oc-swallow");
    world.createObject({ id: "the_list", name: "The List", parent: "$thing", owner: session.actor });
    // The verb wraps the ordering read in a try/except that would otherwise
    // swallow the miss and return a bogus success.
    const installed = installVerb(
      world,
      "the_list",
      "swallow_children",
      `verb :swallow_children() rxd { try { return ordered_children(this); } except err { return "swallowed"; } }`,
      null
    );
    expect(installed.ok).toBe(true);
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seq.seed(cellsFromSerialized(world.exportWorld()));

    const planOnce = planTurn({
      call: {
        kind: "woo.turn_call.shadow.v1",
        id: "oc-swallow",
        route: "direct",
        scope: SCOPE,
        session: session.id,
        actor: session.actor,
        target: "the_list",
        verb: "swallow_children",
        args: []
      },
      view: derivedViewOf(seq.store),
      planningScope: SCOPE,
      classifier,
      base: seq.head(),
      idempotencyKey: "oc-swallow",
      stamp: seq.stamp()
    });

    // The `except` must NOT swallow the miss: planTurn must still escape a
    // repairable E_MISSING_STATE naming the parent, never resolve with the
    // bogus "swallowed" result.
    await expect(planOnce).rejects.toMatchObject({
      code: "E_MISSING_STATE",
      detail: { missing_ordered_children: ["the_list"] }
    });
  });

  it("errors terminally (no repair) for a genuinely malformed parent argument", async () => {
    // A non-ref argument is a verb bug, caught by the builtin's assertObj —
    // a terminal type error, NOT a repairable projection miss (so the gateway
    // never enters an unbounded fetch loop for it).
    const world = createWorld();
    const session = world.auth("guest:oc-badarg");
    world.createObject({ id: "bad_list", name: "Bad List", parent: "$thing", owner: session.actor });
    const installed = installVerb(
      world,
      "bad_list",
      "bad_children",
      `verb :bad_children() rxd { return ordered_children(42); }`,
      null
    );
    expect(installed.ok).toBe(true);
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seq.seed(cellsFromSerialized(world.exportWorld()));

    const plan = await planTurn({
      call: {
        kind: "woo.turn_call.shadow.v1",
        id: "oc-badarg",
        route: "direct",
        scope: SCOPE,
        session: session.id,
        actor: session.actor,
        target: "bad_list",
        verb: "bad_children",
        args: []
      },
      view: derivedViewOf(seq.store),
      planningScope: SCOPE,
      classifier,
      base: seq.head(),
      idempotencyKey: "oc-badarg",
      stamp: seq.stamp()
    });
    // A terminal verb error is RECORDED (planTurn returns), not a repairable
    // escape: the transcript carries the type error and no projection miss.
    expect(plan.transcript.result).toBeUndefined();
    expect((plan.transcript.error as { code?: string }).code).not.toBe("E_NEED_ORDERED_CHILDREN");
    expect(["E_TYPE", "E_INVARG"]).toContain((plan.transcript.error as { code?: string }).code);
  });
});

describe("rank_between builtin (fractional-rank access from the DSL)", () => {
  async function evalRank(expr: string): Promise<unknown> {
    const world = createWorld();
    const session = world.auth("guest:rankb");
    world.createObject({ id: "rb", name: "RB", parent: "$thing", owner: session.actor });
    const installed = installVerb(world, "rb", "rb", `verb :rb() rxd { return ${expr}; }`, null);
    expect(installed.ok, JSON.stringify(installed.diagnostics)).toBe(true);
    const r = await world.directCall("rb", session.actor, "rb", "rb", [], { sessionId: session.id });
    return (r as { op: string; result?: unknown; error?: unknown }).op === "result"
      ? (r as { result: unknown }).result
      : { error: (r as { error: unknown }).error };
  }

  it("returns a key strictly between two bounds and handles open ends", async () => {
    const first = await evalRank("rank_between(null, null)");
    expect(typeof first).toBe("string");
    const after = await evalRank(`rank_between(${JSON.stringify(first)}, null)`);
    const before = await evalRank(`rank_between(null, ${JSON.stringify(first)})`);
    expect(String(before) < String(first)).toBe(true);
    expect(String(first) < String(after)).toBe(true);
    const mid = await evalRank(`rank_between(${JSON.stringify(before)}, ${JSON.stringify(after)})`);
    expect(String(before) < String(mid)).toBe(true);
    expect(String(mid) < String(after)).toBe(true);
  });

  it("raises E_INVARG for an out-of-order or malformed bound", async () => {
    expect(await evalRank(`rank_between("W", "V")`)).toMatchObject({ error: { code: "E_INVARG" } });
    expect(await evalRank(`rank_between("V0", null)`)).toMatchObject({ error: { code: "E_INVARG" } });
  });
});

describe("reads_ordered_children verb flag round-trip", () => {
  it("survives catalog install into the verb_bytecode cell (the gateway's flag source)", () => {
    const world = createWorld();
    const manifest = {
      name: "ordered-flag-test",
      version: "0.0.1",
      spec_version: "v1",
      description: "Flag round-trip coverage for the ordered-children projection gate.",
      license: "MIT",
      depends: [],
      seed_hooks: [],
      classes: [
        {
          local_name: "$oc_holder",
          parent: "$thing",
          verbs: [
            {
              name: "children",
              perms: "rxd",
              direct_callable: true,
              reads_ordered_children: true,
              arg_spec: { args: [] },
              source: `verb :children() rxd { return ordered_children(this); }`
            }
          ]
        }
      ]
    };
    installCatalogManifest(world, manifest, { tap: "@local", alias: manifest.name, actor: "$wiz" });

    const cells = cellsFromSerialized(world.exportWorld());
    const verbCell = cells.find(
      (cell) => cell.kind === "verb_bytecode" && cell.object === "$oc_holder" && cell.name === "children"
    );
    expect(verbCell).toBeDefined();
    expect((verbCell!.value as { reads_ordered_children?: unknown }).reads_ordered_children).toBe(true);
  });
});

describe("bounded neighbour answers (orderedNeighborsFromRows, P2.4)", () => {
  // The one shared reduction both the authority endpoint and the local
  // runtime run — they must clamp, exclude, and index identically or a
  // repaired plan would disagree with the ordering version it attested.
  const rows = [
    { child: "a", rank: "V" },
    { child: "b", rank: "hV" },
    { child: "c", rank: "n" },
    { child: "d", rank: "s" }
  ];

  it("answers an interior slot with the two bounding ranks + count", () => {
    const q = orderedNeighborsFromRows(rows, { index: 2, exclude: null, child: null });
    expect(q).toEqual({ count: 4, index: 2, before: "hV", after: "n", child_index: null });
  });

  it("treats index null as append (slot = count, after = null)", () => {
    const q = orderedNeighborsFromRows(rows, { index: null, exclude: null, child: null });
    expect(q).toEqual({ count: 4, index: 4, before: "s", after: null, child_index: null });
  });

  it("CLAMPS an out-of-range slot instead of erroring (range policy stays in the verb)", () => {
    expect(orderedNeighborsFromRows(rows, { index: -3, exclude: null, child: null }).index).toBe(0);
    expect(orderedNeighborsFromRows(rows, { index: 99, exclude: null, child: null })).toEqual(
      { count: 4, index: 4, before: "s", after: null, child_index: null }
    );
    // Fractional indexes floor, matching the verbs' floor(idx).
    expect(orderedNeighborsFromRows(rows, { index: 2.9, exclude: null, child: null }).index).toBe(2);
  });

  it("excludes one child from the neighbour computation (same-parent move)", () => {
    // Excluding "b": filtered = [a, c, d]; slot 1 sits between a and c.
    const q = orderedNeighborsFromRows(rows, { index: 1, exclude: "b", child: null });
    expect(q).toEqual({ count: 3, index: 1, before: "V", after: "n", child_index: null });
  });

  it("reports the queried child's slot in the UNFILTERED ordering (the mutation's old index)", () => {
    // exclude === child (the moving item): child_index still measures the
    // pre-move ordering, so a verb's no-op check (idx == old_idx) works in
    // the same coordinates the original full-list scan used.
    const q = orderedNeighborsFromRows(rows, { index: 2, exclude: "c", child: "c" });
    expect(q.child_index).toBe(2);
    expect(q.count).toBe(3);
    // Inserting c back at slot 2 of [a, b, d] = between b and d.
    expect(q.before).toBe("hV");
    expect(q.after).toBe("s");
  });

  it("answers an absent child with child_index null and an empty parent with nulls", () => {
    expect(orderedNeighborsFromRows(rows, { index: 0, exclude: null, child: "zz" }).child_index).toBeNull();
    expect(orderedNeighborsFromRows([], { index: null, exclude: null, child: null })).toEqual(
      { count: 0, index: 0, before: null, after: null, child_index: null }
    );
  });

  it("keys a query canonically (repair install and re-planned read agree)", () => {
    const q = { parent: "p1", index: 3, exclude: "x", child: "x" };
    expect(orderedNeighborsQueryKey(q)).toBe(orderedNeighborsQueryKey({ ...q }));
    expect(orderedNeighborsQueryKey(q)).not.toBe(orderedNeighborsQueryKey({ ...q, index: null }));
    expect(orderedNeighborsQueryKey({ parent: null, index: null, exclude: null, child: null }))
      .not.toBe(orderedNeighborsQueryKey({ parent: "null", index: null, exclude: null, child: null }));
  });
});
