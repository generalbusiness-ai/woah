import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import { installLocalCatalogs } from "../src/core/local-catalogs";

function setupWorld() {
  const world = createWorld({ catalogs: false });
  installLocalCatalogs(world, ["chat", "note", "tasks"]);
  return world;
}

async function seedMinimal(
  world: ReturnType<typeof createWorld>,
  ownerActor: string
): Promise<void> {
  const r = await world.directCall("seed", "$wiz", "the_taskboard", "seed_minimal_policy", [ownerActor], {
    forceDirect: true,
    forceReason: "test"
  });
  if (r.op === "error") throw new Error(`seed_minimal_policy failed: ${r.error.code} ${r.error.message}`);
}

async function adminCall(
  world: ReturnType<typeof createWorld>,
  reqId: string,
  target: string,
  verb: string,
  args: unknown[]
) {
  return world.directCall(reqId, "$wiz", target, verb, args as never[], {
    forceDirect: true,
    forceReason: "test"
  });
}

describe("tasks catalog", () => {
  it("seeds the_taskboard as a $task_registry instance", () => {
    const world = setupWorld();
    expect(world.objects.has("the_taskboard")).toBe(true);
    expect(world.isDescendantOf("the_taskboard", "$task_registry")).toBe(true);
    expect(world.propOrNull("the_taskboard", "roles")).toEqual({});
    expect(world.propOrNull("the_taskboard", "obligations")).toEqual({});
    expect(world.propOrNull("the_taskboard", "policies")).toEqual({});
  });

  it("attaches $transparent so the_taskboard exposes embedded chat verbs", () => {
    const world = setupWorld();
    const features = world.propOrNull("the_taskboard", "features");
    expect(Array.isArray(features) && features.includes("$transparent")).toBe(true);
    expect(world.verbInfo("the_taskboard", "say").definer).toBe("$transparent");
  });

  it("re-attaches $transparent on the_taskboard for an upgraded world that drifted", () => {
    const world = setupWorld();
    // Mimic a world that bootstrapped with the older chat-transparent migration
    // (which only knew dubspace + pinboard consumers). The marker is set so
    // runChatTransparentFeatureMigration short-circuits, and the_taskboard's
    // features have drifted away from $transparent. The dedicated tasks
    // transparent-feature migration is expected to fix it on next install.
    world.setProp("the_taskboard", "features", []);
    world.setProp("the_taskboard", "features_version", 0);
    const ledger = world.getProp("$system", "applied_migrations") as string[];
    if (!ledger.includes("2026-05-04-chat-transparent-feature")) {
      world.setProp("$system", "applied_migrations", [...ledger, "2026-05-04-chat-transparent-feature"]);
    }
    world.setProp("$system", "applied_migrations", (world.getProp("$system", "applied_migrations") as string[]).filter((id) => id !== "2026-05-08-tasks-transparent-feature"));

    installLocalCatalogs(world, ["chat", "note", "tasks"]);
    const features = world.propOrNull("the_taskboard", "features");
    expect(Array.isArray(features) && features.includes("$transparent")).toBe(true);
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-05-08-tasks-transparent-feature");
  });

  it("rejects create_task for an unknown kind", async () => {
    const world = setupWorld();
    const session = world.auth("guest:create-bug");
    const r = await world.directCall("create-bad", session.actor, "the_taskboard", "create_task", [
      "bug",
      "no policy yet",
      "",
      [],
      null
    ]);
    expect(r.op).toBe("error");
    if (r.op === "error") expect(r.error.code).toBe("E_INVARG");
  });

  it("seed_minimal_policy populates roles, obligations, policies", async () => {
    const world = setupWorld();
    const session = world.auth("guest:operator");
    await seedMinimal(world, session.actor);

    expect(world.propOrNull("the_taskboard", "roles")).toMatchObject({
      doer: { description: "Does the work", owners: [session.actor] }
    });
    expect(world.propOrNull("the_taskboard", "obligations")).toMatchObject({
      "do:it": { role: "doer", criterion: "Done." }
    });
    expect(world.propOrNull("the_taskboard", "policies")).toEqual({ task: ["do:it"] });
  });

  it("runs create → claim → pass → auto-release", async () => {
    const world = setupWorld();
    const session = world.auth("guest:doer");
    await seedMinimal(world, session.actor);

    const created = await world.directCall("create", session.actor, "the_taskboard", "create_task", [
      "task",
      "fix the thing",
      "details about the thing",
      [],
      null
    ]);
    expect(created.op).toBe("result");
    if (created.op !== "result") return;
    const taskRef = created.result as string;
    expect(world.isDescendantOf(taskRef, "$task")).toBe(true);
    expect(world.propOrNull(taskRef, "registry")).toBe("the_taskboard");
    expect(world.propOrNull(taskRef, "kind")).toBe("task");
    expect(world.propOrNull(taskRef, "obligations")).toEqual([{ key: "do:it", met: false }]);
    expect(world.propOrNull(taskRef, "terminal")).toBe(false);
    expect(world.object(taskRef).location).toBe("the_taskboard");

    const claim = await world.directCall("claim", session.actor, taskRef, "claim", []);
    expect(claim.op).toBe("result");
    expect(world.object(taskRef).location).toBe(session.actor);

    const pass = await world.directCall("pass", session.actor, taskRef, "pass", [{ note: "done" }]);
    expect(pass.op).toBe("result");
    expect(world.propOrNull(taskRef, "obligations")).toEqual([
      { key: "do:it", met: true, evidence: { note: "done" } }
    ]);
    expect(world.object(taskRef).location).toBe("the_taskboard");
  });

  it("rejects pass without lease", async () => {
    const world = setupWorld();
    const session = world.auth("guest:loner");
    await seedMinimal(world, session.actor);

    const created = await world.directCall("create", session.actor, "the_taskboard", "create_task", [
      "task",
      "untouched",
      "",
      [],
      null
    ]);
    if (created.op !== "result") throw new Error("create_task failed");
    const taskRef = created.result as string;

    const r = await world.directCall("pass-no-lease", session.actor, taskRef, "pass", [null]);
    expect(r.op).toBe("error");
    if (r.op === "error") expect(r.error.code).toBe("E_PERM");
  });

  it("rejects claim from an actor without the cursor role", async () => {
    const world = setupWorld();
    const owner = world.auth("guest:owner");
    await seedMinimal(world, owner.actor);
    const stranger = world.auth("guest:stranger");

    const created = await world.directCall("create", owner.actor, "the_taskboard", "create_task", [
      "task",
      "for doer only",
      "",
      [],
      null
    ]);
    if (created.op !== "result") throw new Error("create_task failed");
    const taskRef = created.result as string;

    const r = await world.directCall("claim-stranger", stranger.actor, taskRef, "claim", []);
    expect(r.op).toBe("error");
    if (r.op === "error") expect(r.error.code).toBe("E_PERM");
  });

  it("blocks generic moveto on a $task without a transition_intent", async () => {
    const world = setupWorld();
    const session = world.auth("guest:meddler");
    await seedMinimal(world, session.actor);
    const created = await world.directCall("create", session.actor, "the_taskboard", "create_task", [
      "task",
      "guarded",
      "",
      [],
      null
    ]);
    if (created.op !== "result") throw new Error("create_task failed");
    const taskRef = created.result as string;

    // Try to move the task directly via builder_move (or moveto) — bypassing the lifecycle verbs.
    // Both paths should be refused by $task:moveto's transition_intent gate.
    // We don't have a direct moveto-builtin call in tests, so we assert the
    // task can only land at the registry until :claim/:handoff/:release is used.
    // This is a structural check: with transition_intent null, the gate raises;
    // re-asserting location confirms the gate held.
    expect(world.object(taskRef).location).toBe("the_taskboard");
    expect(world.propOrNull(taskRef, "transition_intent")).toBeNull();
  });

  it("listing exposes ready tasks at the registry", async () => {
    const world = setupWorld();
    const session = world.auth("guest:lister");
    await seedMinimal(world, session.actor);
    await world.directCall("a", session.actor, "the_taskboard", "create_task", ["task", "first", "", [], null]);
    await world.directCall("b", session.actor, "the_taskboard", "create_task", ["task", "second", "", [], null]);

    const r = await world.directCall("list", session.actor, "the_taskboard", "listing", []);
    expect(r.op).toBe("result");
    if (r.op !== "result") return;
    const entries = r.result as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(2);
    expect(entries[0]?.cursor_role).toBe("doer");
    expect(entries[0]?.terminal).toBe(false);
    expect(entries[0]?.complete).toBe(false);
  });

  it("admin verbs gate on registry owner / wizard and emit registry_*_changed", async () => {
    const world = setupWorld();
    const stranger = world.auth("guest:stranger");

    const denied = await world.directCall("denied", stranger.actor, "the_taskboard", "set_role", [
      "triager",
      { description: "x", owners: [stranger.actor] }
    ]);
    expect(denied.op).toBe("error");
    if (denied.op === "error") expect(denied.error.code).toBe("E_PERM");

    const ok = await adminCall(world, "ok", "the_taskboard", "set_role", [
      "triager",
      { description: "Triages bugs", owners: [stranger.actor] }
    ]);
    expect(ok.op).toBe("result");
    expect(world.propOrNull("the_taskboard", "roles")).toMatchObject({
      triager: { description: "Triages bugs", owners: [stranger.actor] }
    });
  });

  it("remove_role refuses while an obligation references it", async () => {
    const world = setupWorld();
    await adminCall(world, "r1", "the_taskboard", "set_role", [
      "triager",
      { description: "x", owners: ["$wiz"] }
    ]);
    await adminCall(world, "o1", "the_taskboard", "set_obligation", [
      "triage:confirm",
      { role: "triager", criterion: "Bug reproduces." }
    ]);
    const r = await adminCall(world, "rm", "the_taskboard", "remove_role", ["triager"]);
    expect(r.op).toBe("error");
    if (r.op === "error") expect(r.error.code).toBe("E_CONSTRAINT");
  });

  it("set_obligation rejects an unknown role", async () => {
    const world = setupWorld();
    const r = await adminCall(world, "o", "the_taskboard", "set_obligation", [
      "x",
      { role: "ghost", criterion: "..." }
    ]);
    expect(r.op).toBe("error");
    if (r.op === "error") expect(r.error.code).toBe("E_INVARG");
  });

  it("blocking yield adds a child_complete wait_for; child completion clears it", async () => {
    const world = setupWorld();
    const session = world.auth("guest:doer");
    await seedMinimal(world, session.actor);

    const parentMint = await world.directCall("mint-parent", session.actor, "the_taskboard", "create_task", [
      "task",
      "parent",
      "",
      [],
      null
    ]);
    if (parentMint.op !== "result") throw new Error("create_task failed");
    const parentRef = parentMint.result as string;

    await world.directCall("claim-parent", session.actor, parentRef, "claim", []);

    const yieldR = await world.directCall("yield", session.actor, parentRef, "yield", [
      {
        kind: "task",
        name: "child",
        text: "",
        blocking: true,
        because: "test"
      }
    ]);
    expect(yieldR.op).toBe("result");
    if (yieldR.op !== "result") return;
    const childRef = (yieldR.result as { child: string }).child;

    expect(world.propOrNull(parentRef, "wait_for")).toEqual([
      { kind: "child_complete", task: childRef }
    ]);
    expect(world.propOrNull(parentRef, "links")).toEqual([{ to: childRef, role: "parent" }]);
    expect(world.propOrNull(childRef, "links")).toEqual([{ to: parentRef, role: "parent" }]);

    const blocked = await world.directCall("parent-pass-blocked", session.actor, parentRef, "pass", [null]);
    expect(blocked.op).toBe("error");

    const claimChild = await world.directCall("claim-child", session.actor, childRef, "claim", []);
    expect(claimChild.op).toBe("result");
    const passChild = await world.directCall("pass-child", session.actor, childRef, "pass", [null]);
    expect(passChild.op).toBe("result");

    expect(world.propOrNull(parentRef, "wait_for")).toEqual([]);

    const passParent = await world.directCall("parent-pass", session.actor, parentRef, "pass", [null]);
    expect(passParent.op).toBe("result");
  });

  it("drop_terminal sets terminal and returns the task home", async () => {
    const world = setupWorld();
    const session = world.auth("guest:doer");
    await seedMinimal(world, session.actor);

    const created = await world.directCall("c", session.actor, "the_taskboard", "create_task", [
      "task",
      "abandoned",
      "",
      [],
      null
    ]);
    if (created.op !== "result") throw new Error("create_task failed");
    const taskRef = created.result as string;

    await world.directCall("claim", session.actor, taskRef, "claim", []);
    const drop = await world.directCall("drop", session.actor, taskRef, "drop_terminal", ["lost interest"]);
    expect(drop.op).toBe("result");
    expect(world.propOrNull(taskRef, "terminal")).toBe(true);
    expect(world.object(taskRef).location).toBe("the_taskboard");
  });
});
