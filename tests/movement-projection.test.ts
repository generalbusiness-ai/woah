import { describe, expect, it } from "vitest";
import { installVerb } from "../src/core/authoring";
import { createWorld, createWorldFromSerialized } from "../src/core/bootstrap";
import {
  applyAcceptedShadowFrame,
  createShadowCommitScope,
  serializedFor,
  shadowLocationCommitScopeForTranscript,
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

describe("actor-anchored movement projection", () => {
  it("plans movement as one authoritative location write without a placement transaction", async () => {
    const world = createWorld();
    createMovementRoom(world, "mv_src_a");
    createMovementRoom(world, "mv_dest");
    const alice = world.auth("guest:movement-a");
    placeSessionActor(world, alice, "mv_src_a");

    const planned = await runShadowTurnCallTranscript(world.exportWorld(), movementCall(alice, "mv_src_a", "move-a"));
    expect(planned.frame).toMatchObject({ op: "applied" });
    expect(shadowLocationCommitScopeForTranscript(planned.transcript)).toBe(alice.actor);
    expect(planned.transcript.writes.filter((write) => write.cell.kind === "contents")).toEqual([]);
    expect(planned.transcript.writes).toContainEqual(expect.objectContaining({
      cell: { kind: "location", object: alice.actor },
      value: "mv_dest",
      op: "move"
    }));
  });

  it("accepts cross-scope movement at the moved object's location authority and updates contents as projection", async () => {
    const world = createWorld();
    createMovementRoom(world, "mv_src_a");
    createMovementRoom(world, "mv_dest");
    const alice = world.auth("guest:movement-authority");
    placeSessionActor(world, alice, "mv_src_a");
    const before = world.exportWorld();
    const planned = await runShadowTurnCallTranscript(before, movementCall(alice, "mv_src_a", "move-a"));

    const actorScope = createShadowCommitScope({
      node: "actor-location-authority",
      scope: alice.actor,
      serialized: before
    });
    const accepted = submitShadowCommit(actorScope, {
      kind: "woo.commit.submit.shadow.v1",
      id: "move-a",
      scope: actorScope.scope,
      expected: structuredClone(actorScope.head),
      transcript: planned.transcript
    });

    expect(accepted).toMatchObject({ kind: "woo.commit.accepted.shadow.v1" });
    const after = createWorldFromSerialized(serializedFor(actorScope), { persist: false });
    expect(after.allLocationsForActor(alice.actor)).toEqual(["mv_dest"]);
    expect(after.contentsOf("mv_src_a")).not.toContain(alice.actor);
    expect(after.contentsOf("mv_dest")).toContain(alice.actor);
  });

  it("merges concurrent moves into the same destination as disjoint projection updates", async () => {
    const world = createWorld();
    createMovementRoom(world, "mv_src_a");
    createMovementRoom(world, "mv_src_b");
    createMovementRoom(world, "mv_dest");
    const alice = world.auth("guest:movement-a");
    const bob = world.auth("guest:movement-b");
    placeSessionActor(world, alice, "mv_src_a");
    placeSessionActor(world, bob, "mv_src_b");
    const before = world.exportWorld();
    const plannedA = await runShadowTurnCallTranscript(before, movementCall(alice, "mv_src_a", "move-a"));
    const plannedB = await runShadowTurnCallTranscript(before, movementCall(bob, "mv_src_b", "move-b"));

    const aliceScope = createShadowCommitScope({ node: "alice-authority", scope: alice.actor, serialized: before });
    const bobScope = createShadowCommitScope({ node: "bob-authority", scope: bob.actor, serialized: before });
    const acceptedA = submitShadowCommit(aliceScope, {
      kind: "woo.commit.submit.shadow.v1",
      id: "move-a",
      scope: alice.actor,
      expected: structuredClone(aliceScope.head),
      transcript: plannedA.transcript
    });
    const acceptedB = submitShadowCommit(bobScope, {
      kind: "woo.commit.submit.shadow.v1",
      id: "move-b",
      scope: bob.actor,
      expected: structuredClone(bobScope.head),
      transcript: plannedB.transcript
    });
    expect(acceptedA).toMatchObject({ kind: "woo.commit.accepted.shadow.v1" });
    expect(acceptedB).toMatchObject({ kind: "woo.commit.accepted.shadow.v1" });
    if (acceptedA.kind !== "woo.commit.accepted.shadow.v1" || acceptedB.kind !== "woo.commit.accepted.shadow.v1") {
      throw new Error("expected both actor-location commits to accept");
    }

    const roomProjection = createShadowCommitScope({ node: "room-projection", scope: "mv_dest", serialized: before });
    applyAcceptedShadowFrame(roomProjection, acceptedA, plannedA.transcript);
    applyAcceptedShadowFrame(roomProjection, acceptedB, plannedB.transcript);
    const after = createWorldFromSerialized(serializedFor(roomProjection), { persist: false });
    expect(after.contentsOf("mv_dest").sort()).toEqual(expect.arrayContaining([alice.actor, bob.actor]));
    expect(after.contentsOf("mv_src_a")).not.toContain(alice.actor);
    expect(after.contentsOf("mv_src_b")).not.toContain(bob.actor);
  });
});
