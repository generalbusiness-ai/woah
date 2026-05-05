import { describe, expect, it } from "vitest";
import { definePropertyVersionedAs, installVerbAs } from "../src/core/authoring";
import { createWorld } from "../src/core/bootstrap";

describe("moveto", () => {
  // Helper: programmer actor that owns itself, with a `do_move` driver verb
  // and an `acceptable_obj` carryable thing.
  async function setupMovetoWorld(label: string) {
    const world = createWorld();
    const auth = world.auth(`guest:${label}`);
    const aobj = world.object(auth.actor);
    aobj.owner = auth.actor;
    aobj.flags.programmer = true;
    installVerbAs(world, auth.actor, auth.actor, "do_move", `verb :do_move(obj, target) rxd {
  return moveto(obj, target);
}`, null);
    return { world, auth };
  }

  it("runs the full hook chain on a successful move", async () => {
    const { world, auth } = await setupMovetoWorld("moveto-chain");
    const container = world.createAuthoredObject(auth.actor, { parent: "$thing", name: "Tracker" });
    definePropertyVersionedAs(world, auth.actor, container, "events", [], "rw", null, "list");
    installVerbAs(world, auth.actor, container, "acceptable", `verb :acceptable(obj) rxd { this.events = this.events + ["acceptable"]; return true; }`, null);
    installVerbAs(world, auth.actor, container, "enterfunc", `verb :enterfunc(obj) rx { this.events = this.events + ["enterfunc"]; return true; }`, null);
    installVerbAs(world, auth.actor, container, "exitfunc", `verb :exitfunc(obj) rx { this.events = this.events + ["exitfunc"]; return true; }`, null);
    const item = world.createAuthoredObject(auth.actor, { parent: "$thing", name: "Pebble", location: container });
    // createAuthoredObject is the trusted-authoring path; it does not fire
    // enterfunc, so container.events is still []. The first observed hook
    // is exitfunc when the move begins below.
    const target = world.createAuthoredObject(auth.actor, { parent: "$thing", name: "Bowl" });
    definePropertyVersionedAs(world, auth.actor, target, "events", [], "rw", null, "list");
    installVerbAs(world, auth.actor, target, "acceptable", `verb :acceptable(obj) rxd { this.events = this.events + ["acceptable"]; return true; }`, null);
    installVerbAs(world, auth.actor, target, "enterfunc", `verb :enterfunc(obj) rx { this.events = this.events + ["enterfunc"]; return true; }`, null);

    const result = await world.directCall("moveto-chain", auth.actor, auth.actor, "do_move", [item, target]);
    expect(result.op).toBe("result");
    expect(world.object(item).location).toBe(target);
    expect(world.getProp(container, "events")).toEqual(["exitfunc"]);
    expect(world.getProp(target, "events")).toEqual(["acceptable", "enterfunc"]);
  });

  it("rejects with E_PERM when :acceptable returns falsy", async () => {
    const { world, auth } = await setupMovetoWorld("moveto-reject");
    const target = world.createAuthoredObject(auth.actor, { parent: "$thing", name: "PickyBox" });
    installVerbAs(world, auth.actor, target, "acceptable", `verb :acceptable(obj) rxd { return false; }`, null);
    const item = world.createAuthoredObject(auth.actor, { parent: "$thing", name: "Reject Me" });
    const before = world.object(item).location;

    const result = await world.directCall("moveto-reject", auth.actor, auth.actor, "do_move", [item, target]);
    expect(result.op).toBe("error");
    if (result.op === "error") expect(result.error.code).toBe("E_PERM");
    expect(world.object(item).location).toBe(before);
  });

  it("propagates errors thrown inside :acceptable", async () => {
    const { world, auth } = await setupMovetoWorld("moveto-acc-throw");
    const target = world.createAuthoredObject(auth.actor, { parent: "$thing", name: "ThrowingBox" });
    installVerbAs(world, auth.actor, target, "acceptable", `verb :acceptable(obj) rxd { raise { code: "E_INVARG", message: "policy" }; }`, null);
    const item = world.createAuthoredObject(auth.actor, { parent: "$thing", name: "Throw Me" });

    const result = await world.directCall("moveto-acc-throw", auth.actor, auth.actor, "do_move", [item, target]);
    expect(result.op).toBe("error");
    if (result.op === "error") expect(result.error.code).toBe("E_INVARG");
    expect(world.object(item).location).not.toBe(target);
  });

  it("does not roll back the move when enterfunc or exitfunc throws", async () => {
    const { world, auth } = await setupMovetoWorld("moveto-hook-throw");
    const oldContainer = world.createAuthoredObject(auth.actor, { parent: "$thing", name: "OldBox" });
    installVerbAs(world, auth.actor, oldContainer, "exitfunc", `verb :exitfunc(obj) rx { raise { code: "E_INVARG", message: "ouch" }; }`, null);
    const newContainer = world.createAuthoredObject(auth.actor, { parent: "$thing", name: "NewBox" });
    installVerbAs(world, auth.actor, newContainer, "enterfunc", `verb :enterfunc(obj) rx { raise { code: "E_INVARG", message: "ouch2" }; }`, null);
    const item = world.createAuthoredObject(auth.actor, { parent: "$thing", name: "Item", location: oldContainer });

    const result = await world.directCall("moveto-hook-throw", auth.actor, auth.actor, "do_move", [item, newContainer]);
    expect(result.op).toBe("result");
    expect(world.object(item).location).toBe(newContainer);
  });

  it("dispatches obj:moveto once and falls through on recursion", async () => {
    const { world, auth } = await setupMovetoWorld("moveto-recurse");
    const target = world.createAuthoredObject(auth.actor, { parent: "$thing", name: "Slot" });
    const item = world.createAuthoredObject(auth.actor, { parent: "$thing", name: "Custom" });
    definePropertyVersionedAs(world, auth.actor, item, "move_count", 0, "rw", null, "int");
    installVerbAs(world, auth.actor, item, "moveto", `verb :moveto(target) rxd { this.move_count = this.move_count + 1; return moveto(this, target); }`, null);

    const result = await world.directCall("moveto-recurse", auth.actor, auth.actor, "do_move", [item, target]);
    expect(result.op).toBe("result");
    expect(world.object(item).location).toBe(target);
    expect(world.getProp(item, "move_count")).toBe(1);
  });

  it("uses the default $thing:moveto wrapper for plain objects", async () => {
    const { world, auth } = await setupMovetoWorld("moveto-default");
    const target = world.createAuthoredObject(auth.actor, { parent: "$thing", name: "Plain" });
    const item = world.createAuthoredObject(auth.actor, { parent: "$thing", name: "Bare" });
    expect(world.resolveVerb(item, "moveto").definer).toBe("$thing");

    const result = await world.directCall("moveto-default", auth.actor, auth.actor, "do_move", [item, target]);
    expect(result.op).toBe("result");
    expect(world.object(item).location).toBe(target);
  });

  it("rejects callers that don't control the moving object with E_PERM", async () => {
    const world = createWorld();
    const owner = world.auth("guest:moveto-owner");
    const stranger = world.auth("guest:moveto-stranger");
    world.object(owner.actor).owner = owner.actor;
    world.object(owner.actor).flags.programmer = true;
    world.object(stranger.actor).owner = stranger.actor;
    world.object(stranger.actor).flags.programmer = true;
    installVerbAs(world, stranger.actor, stranger.actor, "do_move", `verb :do_move(obj, target) rxd { return moveto(obj, target); }`, null);
    const item = world.createAuthoredObject(owner.actor, { parent: "$thing", name: "Owned" });
    const target = world.createAuthoredObject(stranger.actor, { parent: "$thing", name: "Snatch" });

    const result = await world.directCall("moveto-not-owner", stranger.actor, stranger.actor, "do_move", [item, target]);
    expect(result.op).toBe("error");
    if (result.op === "error") expect(result.error.code).toBe("E_PERM");
    expect(world.object(item).location).not.toBe(target);
  });
});
