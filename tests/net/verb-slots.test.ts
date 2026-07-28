// The aged-world verb-slot repair's assignment rule (src/net/verb-slots.ts).
//
// The claim that makes this repair safe to run on a live deployed world is that
// it is BEHAVIOUR-PRESERVING: it writes out the order every node already
// resolves in, so no verb name starts resolving to a different verb. These
// cases pin that claim, and the two ways the repair must decline to act.
import { describe, expect, it } from "vitest";
import { createWorld } from "../../src/core/bootstrap";
import { repairedVerbSlots } from "../../src/net/verb-slots";

describe("repairedVerbSlots", () => {
  it("renumbers duplicates into the order the system already resolves", () => {
    // The canonical aged shape: every page on slot 1, because the pre-fix Net
    // authoring path could not see the object's other verbs.
    const assignment = repairedVerbSlots([
      { name: "zulu", slot: 1 },
      { name: "alpha", slot: 1 },
      { name: "mike", slot: 1 }
    ]);
    expect(assignment && Object.fromEntries(assignment)).toEqual({ alpha: 1, mike: 2, zulu: 3 });
  });

  it("preserves the world dispatcher's answer for the object it repairs", () => {
    // The oracle, not an assertion about my reading of the rule: build the aged
    // object in a real world, ask the dispatcher which verb an overlapping
    // alias reaches, then check the repair puts that verb first.
    const world = createWorld({ catalogs: false });
    world.createObject({ id: "aged_probe", name: "aged", parent: "$root", owner: "$wiz" });
    for (const name of ["zulu", "alpha", "mike"]) {
      world.addVerbForActor("$wiz", "aged_probe", { name, owner: "$wiz", perms: "rxd", aliases: ["x*"] });
    }
    // Age it: collapse every page onto slot 1, the way the pre-fix path
    // committed them, and rehydrate so ordering is recomputed from the cells.
    const serialized = world.exportWorld();
    const probe = serialized.objects.find((obj) => obj.id === "aged_probe");
    for (const verb of probe!.verbs) verb.slot = 1;
    const aged = createWorld({ catalogs: false });
    aged.importWorld(serialized);

    const before = aged.resolveVerb("aged_probe", "x").verb.name;
    const assignment = repairedVerbSlots(probe!.verbs.map((verb) => ({ name: verb.name, slot: verb.slot ?? null })));
    expect(assignment).not.toBeNull();
    const first = [...assignment!.entries()].sort((a, b) => a[1] - b[1])[0][0];
    expect(first, "the repair would change which verb an alias reaches").toBe(before);
  });

  it("leaves a healthy object alone, GAPS included", () => {
    // Distinct ascending ordinals are correct even when they are not dense:
    // removeVerb leaves a gap and never reuses an ordinal, so renumbering here
    // would invalidate live slot descriptors for nothing. Returning null is
    // also what makes the operator op idempotent.
    expect(repairedVerbSlots([{ name: "one", slot: 1 }, { name: "three", slot: 3 }])).toBeNull();
    expect(repairedVerbSlots([{ name: "solo", slot: 9 }])).toBeNull();
    expect(repairedVerbSlots([])).toBeNull();
  });

  it("repairs a page that carries no slot at all", () => {
    // Older than the duplicates: a page persisted before slots were stored.
    // It sorts first (treated as 0) and gets a real ordinal.
    const assignment = repairedVerbSlots([{ name: "b", slot: 2 }, { name: "a", slot: null }]);
    expect(assignment && Object.fromEntries(assignment)).toEqual({ a: 1, b: 2 });
  });
});
