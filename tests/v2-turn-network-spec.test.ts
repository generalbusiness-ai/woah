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
    expect(spec).toContain("#### VTN14.5.1 Phase 1 tentative journal");
    expect(spec).toContain("### VTN14.7 Completion test gates");
    expect(spec).toContain("## VTN16. Completion milestones");
    expect(spec).toContain("rank gossiped ExecCapabilityAds and delegate the whole turn");
    expect(spec).toContain("delegation moves the actor-local cache forward");
    expect(spec).toContain("Gossiped whole-turn delegation");
    expect(spec).toContain("preserves `selected_ad`");
    expect(spec).toContain("Normal durable browser surfaces MUST NOT use selected-ad intents");
    expect(spec).toContain("installs the open executable seed, plans locally");
    expect(spec).toContain("The browser can use it only after it has derived an exact `TurnKey`");
    expect(spec).toContain("scope open SHOULD emit at least one standalone `ExecCapabilityAd` envelope");
    expect(spec).toContain("MUST NOT submit an unselected durable intent");
    expect(spec).toContain("submit browser-built");
    expect(spec).toContain(`StateTransferRequest(mode:"cell_pages", atoms:[...], base:head)`);
    expect(spec).toContain(`StateTransfer(mode:"cell_pages", pages, inline_pages, proof, capsule)`);
    expect(spec).toContain("Browser local execution requests `cell_pages`");
    expect(spec).toContain("If repair succeeds, the worker retries local");
    expect(spec).toContain("MUST NOT release queued durable turns until the");
    expect(spec).toContain("can execute locally against the tentative post-state");
    expect(spec).toContain("invalidates only the directly rejected tentative turn");
    expect(spec).toContain("### Outliner");
    expect(spec).toContain("row selection, collapse state, and create-in-place editor state are");
  });
});
