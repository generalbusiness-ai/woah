import { describe, expect, it } from "vitest";
import { v2ProjectionMessageFromRow, v2ProjectionSnapshotFromMessage } from "../src/client/v2-browser-messages";

describe("v2 browser worker messages", () => {
  it("builds projection messages only from well-shaped cached rows", () => {
    const row = {
      scope: "#room",
      head: {
        kind: "woo.scope_head.shadow.v1",
        scope: "#room",
        epoch: 1,
        seq: 3,
        hash: "head-3"
      },
      projection: {
        kind: "woo.scope_projection.shadow.v1",
        scope: "#room",
        contents: [],
        cursor: { spaces: { "#room": { next_seq: 4 } } },
        subject: { id: "#room", name: "Room" },
        objects: [{ id: "#room", name: "Room" }, { id: "#note", name: "Note" }, "bad"]
      }
    };

    expect(v2ProjectionMessageFromRow(row, { cached: true })).toEqual({
      kind: "projection",
      scope: "#room",
      head: row.head,
      projection: row.projection,
      cached: true
    });
    expect(v2ProjectionMessageFromRow({ ...row, head: { seq: "3" } })).toBeUndefined();
    expect(v2ProjectionMessageFromRow({ ...row, scope: 123 })).toBeUndefined();
  });

  it("extracts catalog-neutral objects from v2 projection messages", () => {
    const message = v2ProjectionMessageFromRow({
      scope: "#room",
      head: {
        kind: "woo.scope_head.shadow.v1",
        scope: "#room",
        epoch: 1,
        seq: 3,
        hash: "head-3"
      },
      projection: {
        kind: "woo.scope_projection.shadow.v1",
        scope: "#room",
        cursor: { spaces: { "#room": { next_seq: 4 } } },
        subject: { id: "#room", name: "Room" },
        objects: [{ id: "#room", name: "Room" }, { id: "#note", name: "Note" }, { name: "missing id" }]
      }
    });

    expect(message).toBeDefined();
    expect(message ? v2ProjectionSnapshotFromMessage(message) : undefined).toEqual({
      scope: "#room",
      cursor: { spaces: { "#room": { next_seq: 4 } } },
      subject: { id: "#room", name: "Room" },
      objects: [{ id: "#room", name: "Room" }, { id: "#note", name: "Note" }]
    });
  });
});
