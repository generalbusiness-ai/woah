import { describe, expect, it } from "vitest";
import { buildLaneFixture } from "../scripts/net-smoke-fixture";

describe("shared Net smoke fixture", () => {
  it("serializes the annex entry verb with its presence-gate exemption", async () => {
    const fixture = await buildLaneFixture();
    // Assert the partition payload consumed by workerd: public world views are
    // detached, so checking or mutating an in-memory view can hide a seed defect.
    const cells = fixture.partitions.flatMap(([, partitionCells]) => partitionCells);
    const welcome = cells.find((cell) =>
      cell.kind === "verb_bytecode"
      && cell.object === "net_lane_annex"
      && cell.name === "welcome"
    );

    expect(welcome).toBeDefined();
    expect(welcome?.value).toMatchObject({ skip_presence_check: true });
  });
});
