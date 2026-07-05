// CellStore — CI by construction, epoch reseed, lineage-closed transfers
// (spec/protocol/coherence.md CO2.1, CO5, CO7, CO8).
import { describe, expect, it } from "vitest";
import {
  CellStore,
  cellKey,
  cellVersion,
  lineageClosureKeys,
  makeCell,
  serializeTransfer,
  type EpochStamp
} from "../../src/net/cells";
import { isNetError } from "../../src/net/errors";

const STAMP: EpochStamp = { scope_head: "h1", catalog_epoch: "cat1" };

function lineage(object: string, parent: string | null) {
  return makeCell({ kind: "object_lineage", object, value: { parent }, provenance: "authoritative", stamp: STAMP });
}

describe("cell identity and versions", () => {
  it("content-addresses values canonically (key order does not matter)", () => {
    expect(cellVersion({ a: 1, b: [2, { c: 3 }] })).toBe(cellVersion({ b: [2, { c: 3 }], a: 1 }));
    expect(cellVersion({ a: 1 })).not.toBe(cellVersion({ a: 2 }));
  });

  it("builds canonical keys", () => {
    expect(cellKey("object_live", "#12")).toBe("object_live:#12");
    expect(cellKey("property_cell", "#12", "name")).toBe("property_cell:#12:name");
  });
});

describe("store roles enforce the coherence invariant (CO2.1)", () => {
  it("authority commits stamp authoritative provenance", () => {
    const store = new CellStore("authority");
    const cell = store.commit({ kind: "object_live", object: "#1", value: { location: "#room" }, stamp: STAMP });
    expect(cell.provenance).toBe("authoritative");
    expect(store.get(cell.key)?.version).toBe(cellVersion({ location: "#room" }));
  });

  it("a derived store cannot originate truth", () => {
    const store = new CellStore("derived");
    try {
      store.commit({ kind: "object_live", object: "#1", value: {}, stamp: STAMP });
      expect.unreachable("commit on derived store must throw");
    } catch (err) {
      expect(isNetError(err) && err.code === "E_LINEAGE").toBe(true);
    }
  });

  it("derived installs re-stamp authoritative cells as derived copies", () => {
    const authority = new CellStore("authority");
    const cell = authority.commit({ kind: "object_live", object: "#1", value: { location: "#room" }, stamp: STAMP });
    const cache = new CellStore("derived");
    cache.install(cell);
    expect(cache.get(cell.key)?.provenance).toBe("derived");
    // The value/version are the authority's — a pure read-through.
    expect(cache.get(cell.key)?.version).toBe(cell.version);
  });

  it("clone gives an independent snapshot for post-state re-derivation (CO4.10)", () => {
    const store = new CellStore("authority");
    store.commit({ kind: "property_cell", object: "#1", name: "n", value: 1, stamp: STAMP });
    const snap = store.clone();
    snap.commit({ kind: "property_cell", object: "#1", name: "n", value: 2, stamp: STAMP });
    expect(store.get("property_cell:#1:n")?.value).toBe(1);
    expect(snap.get("property_cell:#1:n")?.value).toBe(2);
  });
});

describe("epoch discipline (CO8)", () => {
  it("dropStaleEpoch removes mismatched cells and reports the count", () => {
    const cache = new CellStore("derived");
    cache.install(makeCell({ kind: "object_live", object: "#1", value: {}, provenance: "derived", stamp: { scope_head: "h1", catalog_epoch: "old" } }));
    cache.install(makeCell({ kind: "object_live", object: "#2", value: {}, provenance: "derived", stamp: STAMP }));
    expect(cache.dropStaleEpoch({ catalog_epoch: "cat1" })).toBe(1);
    expect(cache.has("object_live:#1")).toBe(false);
    expect(cache.has("object_live:#2")).toBe(true);
  });
});

describe("lineage-closed transfers (CO7): dangling refs are unrepresentable", () => {
  it("serializes when every object closes over its lineage", () => {
    const cells = [
      lineage("#root", null),
      lineage("#thing", "#root"),
      makeCell({ kind: "object_live", object: "#thing", value: { location: "#room" }, provenance: "authoritative", stamp: STAMP }),
      lineage("#room", "#root")
    ];
    const transfer = serializeTransfer(cells);
    expect(transfer.kind).toBe("woo.net.cell_transfer.v1");
    expect(transfer.cells).toHaveLength(4);
  });

  it("refuses an object cell without its lineage page", () => {
    const cells = [makeCell({ kind: "object_live", object: "#thing", value: {}, provenance: "authoritative", stamp: STAMP })];
    try {
      serializeTransfer(cells);
      expect.unreachable("must throw E_LINEAGE");
    } catch (err) {
      expect(isNetError(err) && err.code === "E_LINEAGE").toBe(true);
    }
  });

  it("refuses a lineage page whose parent is not closed over", () => {
    try {
      serializeTransfer([lineage("#thing", "#missing-parent")]);
      expect.unreachable("must throw E_LINEAGE");
    } catch (err) {
      expect(isNetError(err) && err.code === "E_LINEAGE").toBe(true);
    }
  });

  it("receiver-known lineage keeps closures under the byte ceiling without reshipping", () => {
    const known = new Set([cellKey("object_lineage", "#root"), cellKey("object_lineage", "#thing")]);
    const cells = [makeCell({ kind: "object_live", object: "#thing", value: {}, provenance: "authoritative", stamp: STAMP })];
    const transfer = serializeTransfer(cells, known);
    expect(transfer.assumes_known).toContain("object_lineage:#thing");
  });

  it("lineageClosureKeys names the full closure a sender must satisfy", () => {
    const keys = lineageClosureKeys([lineage("#thing", "#root")]);
    expect(keys).toContain("object_lineage:#thing");
    expect(keys).toContain("object_lineage:#root");
  });
});
