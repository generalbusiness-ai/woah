import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createWorld } from "../src/core/bootstrap";
import { runShadowTurnCall } from "../src/core/shadow-turn-call";
import { materializeDevV2CommitLocally } from "../src/server/dev-v2-commit";
import { LocalSQLiteRepository } from "../src/server/sqlite-repository";

describe("dev v2 commit materialization", () => {
  it("persists accepted self-hosted outliner commits through SQLite restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "woo-dev-v2-commit-"));
    const path = join(dir, "dev.sqlite");
    let repo: LocalSQLiteRepository | null = new LocalSQLiteRepository(path);
    try {
      const world = createWorld({ repository: repo });
      const session = world.auth("guest:dev-v2-commit");
      const entered = await runShadowTurnCall(world.exportWorld(), {
        kind: "woo.turn_call.shadow.v1",
        id: "dev-v2-outline-enter",
        route: "sequenced",
        scope: "the_outline",
        session: session.id,
        actor: session.actor,
        target: "the_outline",
        verb: "enter",
        args: []
      });
      materializeDevV2CommitLocally(world, "the_outline", entered.transcript);

      const added = await runShadowTurnCall(world.exportWorld(), {
        kind: "woo.turn_call.shadow.v1",
        id: "dev-v2-outline-add",
        route: "sequenced",
        scope: "the_outline",
        session: session.id,
        actor: session.actor,
        target: "the_outline",
        verb: "add",
        args: ["durable dev outline"]
      });
      materializeDevV2CommitLocally(world, "the_outline", added.transcript);
      const item = added.transcript.creates[0]?.object;
      if (!item) throw new Error("expected add to create an outline item");

      repo.close();
      repo = new LocalSQLiteRepository(path);
      const reloaded = createWorld({ repository: repo });
      expect(Array.from(reloaded.object("the_outline").contents)).toContain(item);
      expect(reloaded.getProp(item, "text")).toBe("durable dev outline");
    } finally {
      repo?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists accepted self-hosted pinboard note text through SQLite restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "woo-dev-v2-pinboard-"));
    const path = join(dir, "dev.sqlite");
    let repo: LocalSQLiteRepository | null = new LocalSQLiteRepository(path);
    try {
      const world = createWorld({ repository: repo });
      const session = world.auth("guest:dev-v2-pinboard");
      const entered = await runShadowTurnCall(world.exportWorld(), {
        kind: "woo.turn_call.shadow.v1",
        id: "dev-v2-pinboard-enter",
        route: "sequenced",
        scope: "the_pinboard",
        session: session.id,
        actor: session.actor,
        target: "the_pinboard",
        verb: "enter",
        args: []
      });
      materializeDevV2CommitLocally(world, "the_pinboard", entered.transcript);

      const added = await runShadowTurnCall(world.exportWorld(), {
        kind: "woo.turn_call.shadow.v1",
        id: "dev-v2-pinboard-add",
        route: "sequenced",
        scope: "the_pinboard",
        session: session.id,
        actor: session.actor,
        target: "the_pinboard",
        verb: "add_note",
        args: ["durable dev pin", "yellow", 48, 48, 180, 110]
      });
      materializeDevV2CommitLocally(world, "the_pinboard", added.transcript);
      const pin = added.transcript.creates[0]?.object;
      if (!pin) throw new Error("expected add_note to create a pin");

      repo.close();
      repo = new LocalSQLiteRepository(path);
      const reloaded = createWorld({ repository: repo });
      expect(Array.from(reloaded.object("the_pinboard").contents)).toContain(pin);
      expect(reloaded.getProp(pin, "text")).toBe("durable dev pin");
    } finally {
      repo?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges host contents writes as deltas when materializing accepted commits", async () => {
    const world = createWorld();
    const first = world.auth("guest:dev-v2-contents-a");
    const second = world.auth("guest:dev-v2-contents-b");
    const initial = world.exportWorld();
    const firstEnter = await runShadowTurnCall(initial, {
      kind: "woo.turn_call.shadow.v1",
      id: "dev-v2-pinboard-enter-a",
      route: "sequenced",
      scope: "the_pinboard",
      session: first.id,
      actor: first.actor,
      target: "the_pinboard",
      verb: "enter",
      args: []
    });
    const secondEnter = await runShadowTurnCall(initial, {
      kind: "woo.turn_call.shadow.v1",
      id: "dev-v2-pinboard-enter-b",
      route: "sequenced",
      scope: "the_pinboard",
      session: second.id,
      actor: second.actor,
      target: "the_pinboard",
      verb: "enter",
      args: []
    });

    materializeDevV2CommitLocally(world, "the_pinboard", firstEnter.transcript);
    materializeDevV2CommitLocally(world, "the_pinboard", secondEnter.transcript);

    const contents = Array.from(world.object("the_pinboard").contents);
    expect(contents).toContain(first.actor);
    expect(contents).toContain(second.actor);
  });
});
