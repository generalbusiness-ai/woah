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
    expect(spec).toContain("rank gossiped ExecCapabilityAds and delegate the whole turn");
    expect(spec).toContain("delegation moves the actor-local cache forward");
    expect(spec).toContain("Gossiped whole-turn delegation");
    expect(spec).toContain("preserves `selected_ad`");
    expect(spec).toContain("scope-matching");
    expect(spec).toContain("gossiped `ExecCapabilityAd`");
    expect(spec).toContain("scope open SHOULD emit at least one standalone `ExecCapabilityAd` envelope");
    expect(spec).toContain("MUST NOT submit an unselected durable intent");
    expect(spec).toContain("If repair succeeds, the worker retries local");
    expect(spec).toContain("MUST NOT release queued durable turns until the");
  });
});
