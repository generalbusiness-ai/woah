// Transcript apply — deterministic post-state re-derivation on a CellStore
// clone (coherence.md CO3/CO4 step 10), consuming the implemented v2
// shadow.v1 transcript shape through the single bridge file.
import { describe, expect, it } from "vitest";
import { CellStore, cellKey, type EpochStamp } from "../../src/net/cells";
import { isNetError } from "../../src/net/errors";
import {
  applyTranscript,
  netCellKeyFor,
  postStateVersion,
  type EffectTranscript
} from "../../src/net/transcript";

const STAMP: EpochStamp = { scope_head: "h2", catalog_epoch: "cat1" };

function baseTranscript(partial: Partial<EffectTranscript>): EffectTranscript {
  return {
    kind: "woo.effect_transcript.shadow.v1",
    route: "direct",
    scope: "the_room",
    seq: 2,
    call: { actor: "#actor", target: "#thing", verb: "poke", args: [], body: undefined },
    reads: [],
    writes: [],
    creates: [],
    moves: [],
    observations: [],
    ...partial
  } as EffectTranscript;
}

describe("recorded-cell translation (CO3 table)", () => {
  it("maps authority cells and routes contents to projection", () => {
    expect(netCellKeyFor({ kind: "prop", object: "#1", name: "n" })).toBe("property_cell:#1:n");
    expect(netCellKeyFor({ kind: "verb", object: "#1", name: "v" })).toBe("verb_bytecode:#1:v");
    expect(netCellKeyFor({ kind: "location", object: "#1" })).toBe("object_live:#1");
    expect(netCellKeyFor({ kind: "lifecycle", object: "#1" })).toBe("object_lineage:#1");
    expect(netCellKeyFor({ kind: "contents", object: "#room" })).toBeNull();
  });
});

describe("applyTranscript (CO4 step 10)", () => {
  it("applies prop writes to a clone, never the live pre-state", () => {
    const pre = new CellStore("authority");
    pre.commit({ kind: "property_cell", object: "#1", name: "n", value: { value: "old" }, stamp: STAMP });
    const result = applyTranscript(pre, baseTranscript({
      writes: [{ cell: { kind: "prop", object: "#1", name: "n" }, value: "new", op: "set" }]
    }), STAMP);
    expect(pre.get("property_cell:#1:n")?.value).toEqual({ value: "old" });
    expect(result.post.get("property_cell:#1:n")?.value).toEqual({ value: "new" });
    expect(result.touched).toEqual(["property_cell:#1:n"]);
  });

  it("last write per cell wins (finalWritesByCell parity with v2)", () => {
    const pre = new CellStore("authority");
    const result = applyTranscript(pre, baseTranscript({
      writes: [
        { cell: { kind: "prop", object: "#1", name: "n" }, value: "first", op: "set" },
        { cell: { kind: "prop", object: "#1", name: "n" }, value: "second", op: "set" }
      ]
    }), STAMP);
    expect(result.post.get("property_cell:#1:n")?.value).toEqual({ value: "second" });
  });

  it("prop writes merge def from the prior cell ({value, def?} payload)", () => {
    // A seeded def-only cell (inherited default, never locally valued):
    // the first write must produce {value, def} — the same payload the
    // bridge would seed for that post-state — or the planner's predicted
    // post_state_version and the scope's derived one diverge on the very
    // first write to a seeded property (kickoff step-8 amendment).
    const def = { name: "n", defaultValue: 0, owner: "#actor", perms: "rw", version: 1 };
    const pre = new CellStore("authority");
    pre.commit({ kind: "property_cell", object: "#1", name: "n", value: { def }, stamp: STAMP });
    const result = applyTranscript(pre, baseTranscript({
      writes: [{ cell: { kind: "prop", object: "#1", name: "n" }, value: 7, op: "set" }]
    }), STAMP);
    expect(result.post.get("property_cell:#1:n")?.value).toEqual({ value: 7, def });
    // A def-less prior (or no prior at all) stays value-only.
    const bare = applyTranscript(new CellStore("authority"), baseTranscript({
      writes: [{ cell: { kind: "prop", object: "#1", name: "n" }, value: 7, op: "set" }]
    }), STAMP);
    expect(bare.post.get("property_cell:#1:n")?.value).toEqual({ value: 7 });
  });

  it("creates materialize lineage identity + live cells", () => {
    const result = applyTranscript(new CellStore("authority"), baseTranscript({
      creates: [{ object: "#new", name: "widget", parent: "$thing", owner: "#actor", anchor: null, location: "#room", flags: {} }]
    }), STAMP);
    const lineage = result.post.get(cellKey("object_lineage", "#new"))?.value as Record<string, unknown>;
    expect(lineage.parent).toBe("$thing");
    expect(lineage.name).toBe("widget");
    expect(result.touched).toContain("object_live:#new");
  });

  it("moves rewrite only the moved object's live cell (CA3: O(1) container move)", () => {
    const pre = new CellStore("authority");
    pre.commit({ kind: "object_live", object: "#bag", value: { location: "#room" }, stamp: STAMP });
    pre.commit({ kind: "object_live", object: "#coin", value: { location: "#bag" }, stamp: STAMP });
    const result = applyTranscript(pre, baseTranscript({
      moves: [{ object: "#bag", from: "#room", to: "#hall" }]
    }), STAMP);
    expect((result.post.get("object_live:#bag")?.value as { location: string }).location).toBe("#hall");
    // Contained object untouched — location is parent-relative.
    expect((result.post.get("object_live:#coin")?.value as { location: string }).location).toBe("#bag");
    expect(result.touched).toEqual(["object_live:#bag"]);
  });

  it("contents writes route to the projection applier, never authority (CA4/CO9)", () => {
    const result = applyTranscript(new CellStore("authority"), baseTranscript({
      writes: [{ cell: { kind: "contents", object: "#room" }, value: ["#actor"], op: "add" }]
    }), STAMP);
    expect(result.projectionWrites).toHaveLength(1);
    expect(result.touched).toEqual([]);
    expect(result.post.get("contents:#room" as string)).toBeUndefined();
  });

  it("post-state version is deterministic and value-sensitive", () => {
    const t = baseTranscript({ writes: [{ cell: { kind: "prop", object: "#1", name: "n" }, value: 1, op: "set" }] });
    const a = applyTranscript(new CellStore("authority"), t, STAMP);
    const b = applyTranscript(new CellStore("authority"), t, STAMP);
    expect(a.postStateVersion).toBe(b.postStateVersion);
    const c = applyTranscript(new CellStore("authority"), baseTranscript({
      writes: [{ cell: { kind: "prop", object: "#1", name: "n" }, value: 2, op: "set" }]
    }), STAMP);
    expect(c.postStateVersion).not.toBe(a.postStateVersion);
    // Absent vs present cells cannot collide.
    expect(postStateVersion(new CellStore("authority"), ["property_cell:#1:n"])).not.toBe(a.postStateVersion);
  });

  it("refuses to apply against a derived store", () => {
    try {
      applyTranscript(new CellStore("derived") as never, baseTranscript({}), STAMP);
      expect.unreachable("must throw");
    } catch (err) {
      expect(isNetError(err) && err.code === "E_LINEAGE").toBe(true);
    }
  });
});
