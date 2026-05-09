import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";

// Pins the LambdaCore-shaped `$command_utils` helpers ported in the `core`
// catalog. Verb messages match LambdaCore #219 wording so MOO veterans
// reading a port can confirm equivalence at a glance.

function findTextObservation(observations: any[], target: string): string | undefined {
  for (const obs of observations) {
    if (obs?.type !== "text") continue;
    if (obs?.target !== target) continue;
    if (typeof obs?.text === "string") return obs.text;
  }
  return undefined;
}

async function callObjectMatchFailed(world: ReturnType<typeof createWorld>, match: unknown, name: string) {
  return world.directCall(
    `omf-${name}-${typeof match === "string" ? match : "obj"}`,
    "$wiz",
    "$command_utils",
    "object_match_failed",
    [match as any, name]
  );
}

describe("$command_utils:object_match_failed (LambdaCore #219 port)", () => {
  it("seeds $command_utils as a $utils descendant", () => {
    const world = createWorld();
    expect(world.objects.has("$command_utils")).toBe(true);
    expect(world.objects.has("$utils")).toBe(true);
    expect(world.isDescendantOf("$command_utils", "$utils")).toBe(true);
  });

  it("returns false (and stays silent) for a real object match", async () => {
    const world = createWorld();
    world.createObject({ id: "obj_omf_real", name: "thing", parent: "$thing", owner: "$wiz", location: "$wiz" });
    const result = await callObjectMatchFailed(world, "obj_omf_real", "thing");
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toBe(false);
    expect(findTextObservation(result.observations, "$wiz")).toBeUndefined();
  });

  it("notifies on $nothing and returns true", async () => {
    const world = createWorld();
    const result = await callObjectMatchFailed(world, "$nothing", "");
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toBe(true);
    expect(findTextObservation(result.observations, "$wiz")).toMatch(
      /You must give the name of some object\./
    );
  });

  it("notifies on $failed_match with LambdaCore wording", async () => {
    const world = createWorld();
    const result = await callObjectMatchFailed(world, "$failed_match", "ghost");
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toBe(true);
    expect(findTextObservation(result.observations, "$wiz")).toMatch(/I see no 'ghost' here\./);
  });

  it("notifies on $ambiguous_match with LambdaCore wording", async () => {
    const world = createWorld();
    const result = await callObjectMatchFailed(world, "$ambiguous_match", "twin");
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toBe(true);
    expect(findTextObservation(result.observations, "$wiz")).toMatch(
      /I don't know which 'twin' you mean\./
    );
  });
});
