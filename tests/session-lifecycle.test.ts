import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import { executeInProcessV2DurableTurn, materializeDevV2CommitLocally } from "../src/server/dev-v2-helpers";
import { createShadowBrowserRelayShim, shadowBrowserSessionBearer } from "../src/core/shadow-browser-node";
import type { ShadowRelayCache } from "../src/core/shadow-relay-cache";
import type { ObjRef, WooValue } from "../src/core/types";

// A1: Session lifecycle — regressions for the three defects described in the
// cross-scope architecture plan (2026-06-09):
//   1. Closed sessions must never win primarySessionForActor.
//   2. Move with stale closed prior session must execute the physical move.
//   3. Session count after open/close cycles must be bounded.

// Relay resolvers for in-process v2 durable turns (same pattern as session-scope-presence.test.ts).
function resolvers(world: ReturnType<typeof createWorld>, tag: string) {
  const gateways = new Map<ObjRef, ShadowRelayCache>();
  const commits = new Map<ObjRef, ShadowRelayCache>();
  const sparse = createWorld({ catalogs: false }).exportWorld();
  return {
    gatewayRelayForScope: (s: ObjRef) =>
      gateways.get(s) ??
      (gateways.set(s, createShadowBrowserRelayShim({ node: `gw-${tag}-${s}`, scope: s, serialized: sparse, deployment: "local-dev" })),
      gateways.get(s)!),
    commitRelayForScope: (s: ObjRef) =>
      commits.get(s) ??
      (commits.set(s, createShadowBrowserRelayShim({ node: `c-${tag}-${s}`, scope: s, serialized: world.exportWorld(), deployment: "local-dev" })),
      commits.get(s)!)
  };
}

async function durable(
  world: ReturnType<typeof createWorld>,
  r: ReturnType<typeof resolvers>,
  c: { id: string; scope: ObjRef; session: string; actor: ObjRef; target: ObjRef; verb: string; args: WooValue[] }
) {
  const s = await executeInProcessV2DurableTurn({
    world,
    gatewayRelayForScope: r.gatewayRelayForScope,
    commitRelayForScope: r.commitRelayForScope,
    node: `gw-${c.id}`,
    call: { ...c, route: "sequenced", persistence: "durable", token: shadowBrowserSessionBearer({ id: c.session, actor: c.actor }) }
  });
  if (s.kind !== "submitted" || !s.reply?.ok) {
    const err = s.kind === "submitted" ? s.reply : s;
    throw new Error(`turn ${c.id} failed: ${JSON.stringify(err)}`);
  }
  if (s.reply.commit && s.reply.transcript) {
    await materializeDevV2CommitLocally(world, s.reply.commit.position.scope, s.reply.transcript);
  }
  return s.reply;
}

describe("A1 session lifecycle", () => {
  // --- Test 1: primarySessionForActor skips closed sessions ---------------------
  it("primarySessionForActor skips sessions marked closedAt", () => {
    const world = createWorld();
    const actor = world.auth("guest:sl-primary-skip");
    // Simulate a second, newer session for the same actor.
    const newer = world.createSessionForActor(actor.actor, "guest");
    // Mark the newer session closed.
    world.markSessionClosed(newer.id);
    // Only the original session should be primary.
    const primary = world.primarySessionForActor(actor.actor);
    expect(primary?.id).toBe(actor.id);
  });

  // --- Test 2: primarySessionForActor returns null when all sessions are closed --
  it("primarySessionForActor returns null when all sessions are closed", () => {
    const world = createWorld();
    const sess = world.auth("guest:sl-all-closed");
    world.markSessionClosed(sess.id);
    expect(world.primarySessionForActor(sess.actor)).toBeNull();
  });

  // --- Test 3: hasLiveSessions returns false after markSessionClosed ------------
  it("hasLiveSessions returns false after markSessionClosed", () => {
    const world = createWorld();
    const sess = world.auth("guest:sl-live-closed");
    expect(world.hasLiveSessions(sess.actor)).toBe(true);
    world.markSessionClosed(sess.id);
    expect(world.hasLiveSessions(sess.actor)).toBe(false);
  });

  // --- Test 4: endSession clears the session and marks it closed ----------------
  it("endSession removes the session and closedAt is set on the session object", () => {
    const world = createWorld();
    const sess = world.auth("guest:sl-end-session");
    const sessionRef = world.sessions.get(sess.id)!;
    expect(sessionRef).toBeDefined();
    world.endSession(sess.id);
    // After endSession the session must be gone from world.sessions.
    expect(world.sessions.has(sess.id)).toBe(false);
    // The in-memory object should have closedAt set (reapSession stamps it before delete).
    expect(sessionRef.closedAt).toBeTypeOf("number");
  });

  // --- Test 5: stale closed session does not block physical move ----------------
  // Regression for the moveto_actor is_primary flake (5/11 warm smoke passes).
  // An actor with a stale/older session that has been closed must still execute
  // the physical move via the current live session.
  it("actor with a stale closed prior session still executes physical move", async () => {
    const world = createWorld();
    // First session — created first (older `started` timestamp).
    const staleSession = world.auth("guest:sl-stale-first");
    const actor = staleSession.actor;

    // Second session — newer (higher `started`, but world.auth creates one at a time).
    // Give them distinct started times so the ordering is deterministic.
    const freshSession = world.createSessionForActor(actor, "guest");
    // Ensure the stale session sorts older: make its started a tick earlier.
    const staleRow = world.sessions.get(staleSession.id)!;
    const freshRow = world.sessions.get(freshSession.id)!;
    staleRow.started = freshRow.started - 1000;

    // Mark the stale session closed — simulating what happens when the
    // Directory delivers an older session row to a shard that already has
    // the newer session, and the older one gets closed.
    world.markSessionClosed(staleSession.id);

    // Now the fresh session is the only live session and must be primary.
    expect(world.primarySessionForActor(actor)?.id).toBe(freshSession.id);

    // Enter the chatroom using the fresh session.
    const r = resolvers(world, "stale-move");
    await durable(world, r, {
      id: "stale-enter",
      scope: "the_chatroom",
      session: freshSession.id,
      actor,
      target: "the_chatroom",
      verb: "enter",
      args: []
    });
    // After entering, actor.location should be the_chatroom, not $nowhere.
    const afterEnter = world.object(actor).location;
    expect(afterEnter).toBe("the_chatroom");
    // session.activeScope should also be the_chatroom.
    expect(world.sessions.get(freshSession.id)?.activeScope).toBe("the_chatroom");

    // Now move southeast (chatroom → deck).
    await durable(world, r, {
      id: "stale-move-se",
      scope: "the_chatroom",
      session: freshSession.id,
      actor,
      target: "the_chatroom",
      verb: "southeast",
      args: []
    });

    // Physical location must have advanced — not stuck at the_chatroom.
    const afterMove = world.object(actor).location;
    expect(afterMove).toBe("the_deck");
    // Session activeScope must match physical location (no divergence).
    expect(world.sessions.get(freshSession.id)?.activeScope).toBe(afterMove);
  });

  // --- Test 6: liveSessionsForActor excludes closed sessions --------------------
  it("liveSessionsForActor excludes sessions with closedAt", () => {
    const world = createWorld();
    const actor = world.auth("guest:sl-live-list");
    const second = world.createSessionForActor(actor.actor, "guest");
    // Both live before close.
    expect(world.liveSessionsForActor(actor.actor).map((s) => s.id).sort())
      .toEqual([actor.id, second.id].sort());
    // Close second.
    world.markSessionClosed(second.id);
    const live = world.liveSessionsForActor(actor.actor);
    expect(live.map((s) => s.id)).toEqual([actor.id]);
  });

  // --- Test 7: session count bound — open+close cycles keep count at ≤ live actors + 1 --
  // Regression for the 26-sessions-for-2-actors scenario that inflated fanout.
  // In the in-memory world there is no Directory, so we measure world.sessions
  // directly: after closing sessions, world.sessions must only contain the live ones.
  it("session count is bounded after open/close cycles", () => {
    const world = createWorld();
    // Two actors; each opens and closes several sessions.
    const actorA = world.auth("guest:sl-bound-a");
    const actorB = world.auth("guest:sl-bound-b");
    // Open and immediately close extra sessions for actorA.
    for (let i = 0; i < 5; i++) {
      const s = world.createSessionForActor(actorA.actor, "guest");
      world.endSession(s.id);
    }
    // Open and immediately close extra sessions for actorB.
    for (let i = 0; i < 5; i++) {
      const s = world.createSessionForActor(actorB.actor, "guest");
      world.endSession(s.id);
    }

    // Count live sessions per scope (the_chatroom, since no one has entered;
    // use allLocationsForActor proxy: sessions should still exist only for the
    // two live sessions). The key invariant: world.sessions holds only live rows.
    const liveSessions = Array.from(world.sessions.values()).filter((s) => s.closedAt === undefined);
    // After all the opens+closes, only the two original sessions remain.
    // (endSession reaped the extras; guests are recycled back, not lingering)
    const liveActors = new Set(liveSessions.map((s) => s.actor));
    // Each actor should have at most 1 live session.
    for (const actor of liveActors) {
      const count = liveSessions.filter((s) => s.actor === actor).length;
      expect(count).toBeLessThanOrEqual(1);
    }
    // Total live sessions ≤ number of distinct live actors + 1.
    expect(liveSessions.length).toBeLessThanOrEqual(liveActors.size + 1);
  });

  // --- Test 8: allLocationsForActor skips closed sessions -----------------------
  // An actor with two sessions in different rooms: after the second session is
  // closed, only the first room should appear in allLocationsForActor.
  it("allLocationsForActor skips sessions marked closedAt", () => {
    const world = createWorld();
    const sess = world.auth("guest:sl-all-locations");
    // Second session for the same actor, placed in a different scope.
    const second = world.createSessionForActor(sess.actor, "guest");
    const secondRow = world.sessions.get(second.id)!;
    // Place first session in the_chatroom, second in the_deck.
    world.sessions.get(sess.id)!.activeScope = "the_chatroom" as ObjRef;
    secondRow.activeScope = "the_deck" as ObjRef;
    // Both appear before any close.
    const before = world.allLocationsForActor(sess.actor);
    expect(before).toContain("the_chatroom");
    expect(before).toContain("the_deck");
    // Close the second session (the_deck one).
    world.markSessionClosed(second.id);
    // After close, the_deck should not appear; the_chatroom still should.
    const after = world.allLocationsForActor(sess.actor);
    expect(after).toContain("the_chatroom");
    expect(after).not.toContain("the_deck");
  });
});
