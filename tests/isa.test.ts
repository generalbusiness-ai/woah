import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import { installVerbAs } from "../src/core/authoring";

describe("isa", () => {
  it("walks the parent chain and returns boolean", async () => {
    const world = createWorld();
    const auth = world.auth("guest:isa-check");
    world.object(auth.actor).owner = auth.actor;
    world.object(auth.actor).flags.programmer = true;
    const sub = world.createAuthoredObject(auth.actor, { parent: "$thing", name: "Sub" });
    const grand = world.createAuthoredObject(auth.actor, { parent: sub, name: "Grand" });
    installVerbAs(world, auth.actor, auth.actor, "check", `verb :check(obj, ancestor) rxd {
  return isa(obj, ancestor);
}`, null);

    const yes = await world.directCall("isa-yes", auth.actor, auth.actor, "check", [grand, "$thing"]);
    expect(yes.op).toBe("result");
    if (yes.op === "result") expect(yes.result).toBe(true);

    const yesSub = await world.directCall("isa-yes-sub", auth.actor, auth.actor, "check", [grand, sub]);
    expect(yesSub.op).toBe("result");
    if (yesSub.op === "result") expect(yesSub.result).toBe(true);

    const no = await world.directCall("isa-no", auth.actor, auth.actor, "check", [grand, "$space"]);
    expect(no.op).toBe("result");
    if (no.op === "result") expect(no.result).toBe(false);

    const self = await world.directCall("isa-self", auth.actor, auth.actor, "check", [sub, sub]);
    expect(self.op).toBe("result");
    if (self.op === "result") expect(self.result).toBe(true);
  });
});
