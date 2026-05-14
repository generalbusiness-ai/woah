import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import { authedWorld, callInTaskspace, message } from "./core-support";

describe("taskspace", () => {
  it("creates hierarchical tasks and emits soft definition-of-done observations", async () => {
    const { world, session, actor } = authedWorld();
    const create = await callInTaskspace(world, session.id, "create", message(actor, "the_taskspace", "create_task", ["Build core", "Make it real"]));
    expect(create.op).toBe("applied");
    const task = create.op === "applied" ? (create.observations[0].task as string) : "";
    await callInTaskspace(world, session.id, "sub", message(actor, task, "add_subtask", ["Write tests", ""]));
    await callInTaskspace(world, session.id, "claim", message(actor, task, "claim", []));
    await callInTaskspace(world, session.id, "req", message(actor, task, "add_requirement", ["passes tests"]));
    const done = await callInTaskspace(world, session.id, "done", message(actor, task, "set_status", ["done"]));
    expect(world.getProp(task, "status")).toBe("done");
    if (done.op === "applied") {
      expect(done.observations.map((obs) => obs.type)).toContain("done_premature");
    }
  });

  it("prevents conflicting claims", async () => {
    const world = createWorld();
    const session1 = world.auth("guest:1");
    const session2 = world.auth("guest:2");
    const create = await callInTaskspace(world, session1.id, "create", message(session1.actor, "the_taskspace", "create_task", ["Claimed", ""]));
    const task = create.op === "applied" ? (create.observations[0].task as string) : "";
    await callInTaskspace(world, session1.id, "claim-1", message(session1.actor, task, "claim", []));
    const conflict = await callInTaskspace(world, session2.id, "claim-2", message(session2.actor, task, "claim", []));
    expect(conflict.op).toBe("applied");
    if (conflict.op === "applied") {
      expect(conflict.observations[0].type).toBe("$error");
      expect(conflict.observations[0].code).toBe("E_CONFLICT");
    }
  });

  it("lets anyone close claimed tasks while keeping other claimed status updates gated", async () => {
    const world = createWorld();
    const assignee = world.auth("guest:assignee");
    const other = world.auth("guest:other");
    world.sessions.set("wiz-session", {
      id: "wiz-session",
      actor: "$wiz",
      started: Date.now(),
      expiresAt: Date.now() + 60_000,
      lastDetachAt: null,
      tokenClass: "bearer",
      attachedSockets: new Set(),
      lastInputAt: Date.now(),
      activeScope: "$nowhere"
    });
    const create = await callInTaskspace(world, assignee.id, "create", message(assignee.actor, "the_taskspace", "create_task", ["Wizard check", ""]));
    const task = create.op === "applied" ? (create.observations[0].task as string) : "";
    await callInTaskspace(world, assignee.id, "claim", message(assignee.actor, task, "claim", []));
    const rejected = await callInTaskspace(world, other.id, "other-status", message(other.actor, task, "set_status", ["blocked"]));
    expect(world.getProp(task, "status")).toBe("claimed");
    if (rejected.op === "applied") expect(rejected.observations[0].code).toBe("E_PERM");
    const closed = await callInTaskspace(world, other.id, "other-done", message(other.actor, task, "set_status", ["done"]));
    expect(world.getProp(task, "status")).toBe("done");
    if (closed.op === "applied") expect(closed.observations[0].type).toBe("status_changed");
    const wizard = await callInTaskspace(world, "wiz-session", "wiz-status", message("$wiz", task, "set_status", ["blocked"]));
    expect(world.getProp(task, "status")).toBe("blocked");
    if (wizard.op === "applied") expect(wizard.observations[0].type).toBe("status_changed");
  });
});
