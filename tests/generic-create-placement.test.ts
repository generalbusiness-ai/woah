// Blocker 1: generic create() must follow the executing-host contract
// (objects.md §4.1) — a null-anchor creation stays anchorless and parent-scoped.
// The author-authority-root co-location is the BUILDER surface's authoring-
// workspace behavior alone (createBuilderObject), never generic creation, so an
// ordinary or wizard-owned helper create is not misrouted into the author's
// cluster.
import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";

describe("generic create() placement (executing-host contract)", () => {
  it("a null-anchor generic create stays anchorless; only the builder surface co-locates", async () => {
    const world = createWorld();
    const start = await world.beginSignup("gen@woo.dev", "password123");
    const human = world.verifySignup(start.verification_token).actor as string;
    const account = world.propOrNull(human, "account") as string;
    world.setProp(account, "programmer_grant_quota", 10);
    const prov = (await world.directCall("prov", human, human, "create_agent", ["Bot", "", true])) as unknown as {
      result: { actor_id: string };
    };
    const agent = prov.result.actor_id;

    // Generic runtime creation (createRuntimeObject, behind the `create` builtin)
    // with no explicit anchor keeps anchor=null — it is NOT co-located to the
    // author's authority cluster. The id is parent-scoped, not obj_<author>_.
    const generic = world.createRuntimeObject("$thing", agent, null, { progr: agent, name: "Widget" });
    expect(world.object(generic).anchor, "generic create must not anchor to the author").toBeNull();
    expect(generic.startsWith("obj_thing_"), `generic id was misrouted: ${generic}`).toBe(true);

    // A wizard-owned helper create must likewise stay anchorless (the misroute
    // the fallback would have caused).
    const wizHelper = world.createRuntimeObject("$thing", "$wiz", null, { progr: "$wiz", name: "Helper" });
    expect(world.object(wizHelper).anchor).toBeNull();

    // The BUILDER surface path DOES co-locate to the author's authority root
    // (the human for an anchored agent) — the authoring-workspace behavior.
    const built = (await world.builderCreateObject(agent, "$thing", { name: "BuiltWidget" }, "$builder")) as {
      id: string;
    };
    expect(world.object(built.id).anchor, "builder create must co-locate to the author root").toBe(human);
  });
});
