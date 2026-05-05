import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import { installVerbAs } from "../src/core/authoring";
import { LocalHostBridge } from "./core-support";
import type { ObjRef } from "../src/core/types";
import type { WooWorld } from "../src/core/world";

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

  it("checks remote ancestry through the host bridge and memoizes within a call", async () => {
    const home = createWorld();
    const remote = createWorld();
    const worlds = new Map<string, WooWorld>([
      ["home", home],
      ["remote", remote]
    ]);
    const routes = new Map<ObjRef, string>([
      ["remote_sub", "remote"],
      ["remote_grand", "remote"]
    ]);
    const bridge = new LocalHostBridge("home", worlds, routes);
    home.setHostBridge(bridge);
    remote.setHostBridge(new LocalHostBridge("remote", worlds, routes));
    const auth = home.auth("guest:remote-isa-check");
    home.object(auth.actor).owner = auth.actor;
    home.object(auth.actor).flags.programmer = true;
    remote.createObject({ id: "remote_sub", parent: "$thing", owner: "$wiz" });
    remote.createObject({ id: "remote_grand", parent: "remote_sub", owner: "$wiz" });
    installVerbAs(home, auth.actor, auth.actor, "remote_check", `verb :remote_check(obj, ancestor) rxd {
  return [isa(obj, ancestor), isa(obj, ancestor), isa(obj, $space), isa(obj, obj)];
}`, null);

    const checked = await home.directCall("remote-isa", auth.actor, auth.actor, "remote_check", ["remote_grand", "$thing"]);
    expect(checked.op).toBe("result");
    if (checked.op === "result") expect(checked.result).toEqual([true, true, false, true]);
    expect(bridge.isaCalls.get("isa:remote_grand:$thing")).toBe(1);
    expect(bridge.isaCalls.get("isa:remote_grand:$space")).toBe(1);
    expect(bridge.isaCalls.has("isa:remote_grand:remote_grand")).toBe(false);
  });
});
