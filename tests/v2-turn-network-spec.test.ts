import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const specPath = resolve("spec/protocol/v2-turn-network.md");

function readSpec(): string {
  return readFileSync(specPath, "utf8");
}

describe("v2 turn-network spec", () => {
  it("does not reintroduce the retired interim protocol vocabulary", () => {
    const spec = readSpec();
    const retiredTerm = "sha" + "dow";

    expect(spec.toLowerCase()).not.toContain(retiredTerm);
    expect(spec).not.toContain(`.${retiredTerm}.`);
  });

  it("keeps browser-edge execution completion requirements explicit", () => {
    const spec = readSpec();

    expect(spec).toContain("### VTN14.1 Browser cache ownership");
    expect(spec).toContain("### VTN14.3 Optimistic local turn flow");
    expect(spec).toContain("### VTN14.4 Missing-state repair");
    expect(spec).toContain("### VTN14.5 Optimistic UI and reconciliation");
    expect(spec).toContain("### VTN14.7 Completion test gates");
    expect(spec).toContain("## VTN16. Completion milestones");
  });
});
