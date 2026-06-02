import { describe, expect, it } from "vitest";

import { createWorld } from "../src/core/bootstrap";
import { planDevV2BrowserFanout } from "../src/server/dev-v2-helpers";
import type { EffectTranscript } from "../src/core/effect-transcript";
import type { ShadowTurnExecReply } from "../src/core/shadow-turn-exec";
import type { V2FanoutPeer } from "../src/core/v2-fanout-projection";
import type { ObjRef } from "../src/core/types";

// #2 localdev↔CF fanout drift: dev browser fanout must make recipient-routing
// decisions through the SAME affected-scope / per-peer-scope model the worker
// uses (the shared planDevV2BrowserFanout, composed from
// computeDirectLiveAudiences + buildV2FanoutLiveEvents + planV2BrowserFanout).
// The previous dev path delivered ONLY a projection delta to commit-scope
// subscribers and emitted no live events for committed turns, so a co-present
// peer in another affected room saw nothing. These cases pin the converged
// decision against a REAL world's authoritative presence/audience computation.
describe("dev v2 browser fanout — CF-shaped recipient routing", () => {
  function peer(node: string, actor: ObjRef, session: string, scope: ObjRef): V2FanoutPeer {
    return { node, sessionId: session, actor, scope };
  }

  it("routes a committed cross-room move's per-room observations to the right rooms (the drift this fixes)", async () => {
    const world = createWorld();
    const alice = world.auth("guest:fanout-alice");
    const bob = world.auth("guest:fanout-bob");
    const charlie = world.auth("guest:fanout-charlie");
    // Establish REAL presence: charlie stays in the_chatroom; bob is in the_deck;
    // alice moves chatroom -> deck (so the_chatroom={charlie}, the_deck={bob,alice}).
    await world.directCall("setup-charlie", charlie.actor, "the_chatroom", "enter", [], { sessionId: charlie.id });
    await world.directCall("setup-bob", bob.actor, "the_deck", "enter", [], { sessionId: bob.id });
    await world.directCall("setup-alice-1", alice.actor, "the_chatroom", "enter", [], { sessionId: alice.id });
    await world.directCall("setup-alice-2", alice.actor, "the_deck", "enter", [], { sessionId: alice.id });

    // A faithful committed relocation reply: a `left` observation sourced at the
    // old room and an `entered` at the new room, commit at the moved actor's
    // scope (B6 relocation). Audiences are NOT pre-stamped — the fanout
    // recomputes them authoritatively from the world's presence.
    const transcript = {
      kind: "woo.effect_transcript.shadow.v1",
      route: "sequenced",
      scope: "the_chatroom",
      seq: 1,
      call: { actor: alice.actor, target: "the_deck", verb: "enter", args: [] },
      reads: [], writes: [], creates: [],
      moves: [{ object: alice.actor, from: "the_chatroom", to: "the_deck" }],
      observations: [
        { type: "left", source: "the_chatroom", actor: alice.actor, text: "Alice leaves." },
        { type: "entered", source: "the_deck", actor: alice.actor, text: "Alice arrives." }
      ],
      logicalInputs: [], untrackedEffects: [], complete: true, incompleteReasons: [], hash: "move-hash"
    } as unknown as EffectTranscript;
    const reply = {
      kind: "woo.turn.exec.reply.shadow.v1",
      ok: true,
      id: "move-1",
      commit: {
        kind: "woo.commit.accepted.shadow.v1",
        id: "move-1",
        position: { kind: "woo.scope_head.shadow.v1", scope: alice.actor, epoch: 1, seq: 1, hash: "move-hash" }
      },
      transcript
    } as unknown as ShadowTurnExecReply;

    const plan = await planDevV2BrowserFanout({
      world,
      reply,
      fromNode: "node:dev:relay",
      peers: [
        peer("p_charlie", charlie.actor, charlie.id, "the_chatroom"),
        peer("p_bob", bob.actor, bob.id, "the_deck"),
        peer("p_alice", alice.actor, alice.id, "the_deck") // the mover, also the origin
      ],
      originNode: "p_alice"
    });

    expect(plan.kind).toBe("commit");
    // charlie (in the_chatroom) hears the `left`; bob (in the_deck) hears the
    // `entered`; the mover is the origin and is excluded entirely. The OLD dev
    // path delivered NEITHER (nobody subscribes to the actor commit scope).
    const byNode = new Map(plan.liveDeliveries.map((d) => [d.node, d.events.map((e) => e.observation.type)] as const));
    expect(byNode.get("p_charlie")).toEqual(["left"]);
    expect(byNode.get("p_bob")).toEqual(["entered"]);
    expect(byNode.has("p_alice")).toBe(false);
    // The mover is the only peer at the actor commit scope but is the origin, so
    // there is no projection state-transfer target.
    expect(plan.stateTransferNodes).toEqual([]);
  });

  it("keeps a private (directed) committed observation off room peers and delivers it only to the named actor", async () => {
    const world = createWorld();
    const alice = world.auth("guest:fanout-priv-alice");
    const bob = world.auth("guest:fanout-priv-bob");
    await world.directCall("priv-alice", alice.actor, "the_chatroom", "enter", [], { sessionId: alice.id });
    await world.directCall("priv-bob", bob.actor, "the_chatroom", "enter", [], { sessionId: bob.id });

    // A whisper-style directed observation (to: alice) committed in the_chatroom.
    const transcript = {
      kind: "woo.effect_transcript.shadow.v1",
      route: "sequenced", scope: "the_chatroom", seq: 1,
      call: { actor: bob.actor, target: alice.actor, verb: "whisper", args: ["secret"] },
      reads: [], writes: [], creates: [], moves: [],
      observations: [{ type: "told", source: "the_chatroom", to: alice.actor, from: bob.actor, text: "secret" }],
      logicalInputs: [], untrackedEffects: [], complete: true, incompleteReasons: [], hash: "whisper-hash"
    } as unknown as EffectTranscript;
    const reply = {
      kind: "woo.turn.exec.reply.shadow.v1", ok: true, id: "whisper-1",
      commit: { kind: "woo.commit.accepted.shadow.v1", id: "whisper-1", position: { kind: "woo.scope_head.shadow.v1", scope: "the_chatroom", epoch: 1, seq: 1, hash: "whisper-hash" } },
      transcript
    } as unknown as ShadowTurnExecReply;

    const plan = await planDevV2BrowserFanout({
      world, reply, fromNode: "node:dev:relay",
      peers: [
        peer("p_alice", alice.actor, alice.id, "the_chatroom"),
        peer("p_bob", bob.actor, bob.id, "the_chatroom")
      ],
      originNode: "p_bob"
    });

    // Only the named recipient (alice) gets the directed observation; the other
    // room peer (bob, also origin) does not see another actor's private line.
    expect(plan.liveDeliveries.map((d) => d.node)).toEqual(["p_alice"]);
    // Both room peers are at the commit scope (the_chatroom), so both would be
    // state-transfer targets — but bob is the origin and is excluded.
    expect(plan.stateTransferNodes).toEqual(["p_alice"]);
  });

  it("a live (non-durable) reply fans transcript events by peer scope with no state-transfer", async () => {
    const world = createWorld();
    const alice = world.auth("guest:fanout-live-alice");
    const bob = world.auth("guest:fanout-live-bob");
    const transcript = {
      kind: "woo.effect_transcript.shadow.v1",
      route: "direct", scope: "the_chatroom", seq: 1,
      call: { actor: alice.actor, target: "the_chatroom", verb: "say", args: ["hi"] },
      reads: [], writes: [], creates: [], moves: [],
      observations: [{ type: "said", source: "the_chatroom", actor: alice.actor, text: "hi" }],
      logicalInputs: [], untrackedEffects: [], complete: true, incompleteReasons: [], hash: "say-hash"
    } as unknown as EffectTranscript;
    // Live reply: ok + transcript, NO commit.
    const reply = { kind: "woo.turn.exec.reply.shadow.v1", ok: true, id: "say-1", transcript } as unknown as ShadowTurnExecReply;

    const plan = await planDevV2BrowserFanout({
      world, reply, fromNode: "node:dev:relay",
      peers: [
        peer("p_alice", alice.actor, alice.id, "the_chatroom"),
        peer("p_bob", bob.actor, bob.id, "the_deck") // different room: should NOT match
      ],
      originNode: "p_alice"
    });

    expect(plan.kind).toBe("live");
    // The `said` event (scope the_chatroom) reaches the chatroom peer only; the
    // deck peer's scope does not match. No commit ⇒ no state-transfer.
    expect(plan.liveDeliveries.map((d) => d.node)).toEqual([]);
    expect(plan.stateTransferNodes).toEqual([]);
    // Sanity: a chatroom-bound peer other than the origin WOULD match.
    const withChatroomPeer = await planDevV2BrowserFanout({
      world, reply, fromNode: "node:dev:relay",
      peers: [peer("p_charlie", "guest_charlie" as ObjRef, "s_charlie", "the_chatroom")],
      originNode: "p_alice"
    });
    expect(withChatroomPeer.liveDeliveries.map((d) => d.node)).toEqual(["p_charlie"]);
  });

  it("returns kind 'none' for a non-ok or transcript-less reply", async () => {
    const world = createWorld();
    const rejected = { kind: "woo.turn.exec.reply.shadow.v1", ok: false, id: "x", reason: "commit_rejected" } as unknown as ShadowTurnExecReply;
    const plan = await planDevV2BrowserFanout({ world, reply: rejected, fromNode: "n", peers: [], originNode: "o" });
    expect(plan).toEqual({ kind: "none", liveDeliveries: [], stateTransferNodes: [] });
  });
});
