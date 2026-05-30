import { describe, expect, it } from "vitest";
import { installVerb } from "../src/core/authoring";
import { createWorld, createWorldFromSerialized } from "../src/core/bootstrap";
import {
  createShadowCommitScope,
  serializedFor,
  shadowPlacementTransactionForTranscript,
  submitShadowCommit
} from "../src/core/shadow-commit-scope";
import { runShadowTurnCallTranscript, type ShadowTurnCall } from "../src/core/shadow-turn-call";
import type { Session } from "../src/core/types";

function createMovementRoom(world: ReturnType<typeof createWorld>, id: string): void {
  world.createObject({ id, name: id, parent: "$space", owner: "$wiz" });
  const installed = installVerb(
    world,
    id,
    "go",
    `verb :go(dest) rxd {
      moveto(actor, dest);
    }`,
    null
  );
  expect(installed.ok).toBe(true);
}

function placeSessionActor(world: ReturnType<typeof createWorld>, session: Session, room: string): void {
  const actor = world.object(session.actor);
  if (actor.location) world.object(actor.location).contents.delete(session.actor);
  actor.location = room;
  world.object(room).contents.add(session.actor);
  const row = world.sessions.get(session.id);
  if (row) row.activeScope = room;
}

function movementCall(session: Session, scope: string, id: string): ShadowTurnCall {
  return {
    kind: "woo.turn_call.shadow.v1",
    id,
    route: "sequenced",
    scope,
    session: session.id,
    actor: session.actor,
    target: scope,
    verb: "go",
    args: ["mv_dest"]
  };
}

describe("shadow placement transactions", () => {
  it("serializes stale movement plans under one fenced placement transaction", async () => {
    const world = createWorld();
    createMovementRoom(world, "mv_src_a");
    createMovementRoom(world, "mv_src_b");
    createMovementRoom(world, "mv_dest");
    const alice = world.auth("guest:placement-a");
    const bob = world.auth("guest:placement-b");
    placeSessionActor(world, alice, "mv_src_a");
    placeSessionActor(world, bob, "mv_src_b");

    const before = world.exportWorld();
    const callA = movementCall(alice, "mv_src_a", "move-a");
    const callB = movementCall(bob, "mv_src_b", "move-b");
    const plannedA = await runShadowTurnCallTranscript(before, callA);
    const plannedB = await runShadowTurnCallTranscript(before, callB);
    expect(plannedA.frame).toMatchObject({ op: "applied" });
    expect(plannedB.frame).toMatchObject({ op: "applied" });

    const placementScope = createShadowCommitScope({
      node: "placement-authority",
      scope: "#placement",
      serialized: before
    });
    const initialHead = structuredClone(placementScope.head);
    const transactionA = shadowPlacementTransactionForTranscript(plannedA.transcript);
    const transactionB = shadowPlacementTransactionForTranscript(plannedB.transcript);
    expect(transactionA?.cells).toEqual(expect.arrayContaining([
      { kind: "contents", object: "mv_src_a" },
      { kind: "contents", object: "mv_dest" },
      { kind: "location", object: alice.actor }
    ]));
    expect(transactionB?.cells).toEqual(expect.arrayContaining([
      { kind: "contents", object: "mv_src_b" },
      { kind: "contents", object: "mv_dest" },
      { kind: "location", object: bob.actor }
    ]));

    const acceptedA = submitShadowCommit(placementScope, {
      kind: "woo.commit.submit.shadow.v1",
      id: "move-a",
      scope: placementScope.scope,
      expected: initialHead,
      transcript: plannedA.transcript,
      transaction: transactionA ?? undefined
    });
    expect(acceptedA).toMatchObject({ kind: "woo.commit.accepted.shadow.v1" });
    if (acceptedA.kind !== "woo.commit.accepted.shadow.v1") throw new Error("expected accepted move-a");
    expect(acceptedA.transaction).toEqual(transactionA);

    const staleB = submitShadowCommit(placementScope, {
      kind: "woo.commit.submit.shadow.v1",
      id: "move-b-stale",
      scope: placementScope.scope,
      expected: initialHead,
      transcript: plannedB.transcript,
      transaction: transactionB ?? undefined
    });
    expect(staleB).toMatchObject({
      kind: "woo.commit.conflict.shadow.v1",
      reason: "stale_head"
    });

    const replannedB = await runShadowTurnCallTranscript(serializedFor(placementScope), callB);
    const acceptedB = submitShadowCommit(placementScope, {
      kind: "woo.commit.submit.shadow.v1",
      id: "move-b",
      scope: placementScope.scope,
      expected: structuredClone(placementScope.head),
      transcript: replannedB.transcript,
      transaction: shadowPlacementTransactionForTranscript(replannedB.transcript) ?? undefined
    });
    expect(acceptedB).toMatchObject({ kind: "woo.commit.accepted.shadow.v1" });

    const after = createWorldFromSerialized(serializedFor(placementScope), { persist: false });
    expect(after.allLocationsForActor(alice.actor)).toEqual(["mv_dest"]);
    expect(after.allLocationsForActor(bob.actor)).toEqual(["mv_dest"]);
    expect(after.contentsOf("mv_dest").sort()).toEqual(expect.arrayContaining([alice.actor, bob.actor]));
    expect(after.contentsOf("mv_src_a")).not.toContain(alice.actor);
    expect(after.contentsOf("mv_src_b")).not.toContain(bob.actor);
  });

  it("rejects cross-scope movement commits without an explicit placement fence", async () => {
    const world = createWorld();
    createMovementRoom(world, "mv_src_a");
    createMovementRoom(world, "mv_dest");
    const alice = world.auth("guest:placement-required");
    placeSessionActor(world, alice, "mv_src_a");
    const before = world.exportWorld();
    const planned = await runShadowTurnCallTranscript(before, movementCall(alice, "mv_src_a", "move-a"));
    const placementScope = createShadowCommitScope({
      node: "placement-authority",
      scope: "#placement",
      serialized: before
    });

    const rejected = submitShadowCommit(placementScope, {
      kind: "woo.commit.submit.shadow.v1",
      id: "move-a-no-fence",
      scope: placementScope.scope,
      expected: structuredClone(placementScope.head),
      transcript: planned.transcript
    });

    expect(rejected).toMatchObject({
      kind: "woo.commit.conflict.shadow.v1",
      reason: "scope_mismatch"
    });
  });

  it("rejects incomplete placement fences before accepting movement writes", async () => {
    const world = createWorld();
    createMovementRoom(world, "mv_src_a");
    createMovementRoom(world, "mv_dest");
    const alice = world.auth("guest:placement-incomplete");
    placeSessionActor(world, alice, "mv_src_a");
    const before = world.exportWorld();
    const planned = await runShadowTurnCallTranscript(before, movementCall(alice, "mv_src_a", "move-a"));
    const placementScope = createShadowCommitScope({
      node: "placement-authority",
      scope: "#placement",
      serialized: before
    });

    const rejected = submitShadowCommit(placementScope, {
      kind: "woo.commit.submit.shadow.v1",
      id: "move-a-partial-fence",
      scope: placementScope.scope,
      expected: structuredClone(placementScope.head),
      transcript: planned.transcript,
      transaction: {
        kind: "placement",
        cells: [{ kind: "location", object: alice.actor }]
      }
    });

    expect(rejected).toMatchObject({
      kind: "woo.commit.conflict.shadow.v1",
      reason: "write_fence_missing"
    });
    expect(rejected.kind === "woo.commit.conflict.shadow.v1" ? rejected.errors : []).toEqual(
      expect.arrayContaining([
        "write_fence_missing: mv_src_a.contents",
        "write_fence_missing: mv_dest.contents"
      ])
    );
  });
});
