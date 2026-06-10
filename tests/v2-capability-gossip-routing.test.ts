import { describe, expect, it } from "vitest";

import { authoritativePlanningWorld } from "../src/core/planning-world";
import { createWorld } from "../src/core/bootstrap";
import {
  buildShadowCapabilityAd,
  capabilityAdProbablyCoversTurn,
  capabilityAdRoutingScore,
  rankCapabilityAdsForTurn
} from "../src/core/capability-ad";
import { SHADOW_EFFECT_MOVE, SHADOW_EFFECT_READ, type ShadowTurnKey } from "../src/core/turn-key";
import { createShadowCommitScope } from "../src/core/shadow-commit-scope";
import {
  createShadowExecutionNode,
  executeAuthoritativeShadowTurnCall,
  installShadowStateTransfer
} from "../src/core/shadow-turn-exec";
import { runShadowTurnCall, type ShadowTurnCall } from "../src/core/shadow-turn-call";
import {
  buildShadowTurnExecAd,
  buildShadowTurnExecAdFromNode,
  executeShadowTurnCallAcrossInProcessNetwork
} from "../src/core/shadow-turn-network";
import { shadowTurnKeyFromTranscript } from "../src/core/turn-key";

// B8 (VTN0 claim 4 / VTN11): routing is capability gossip, not a location
// oracle. Nodes advertise an ExecCapabilityAd (covers/accepts Bloom + opaque
// factor + cost components + scope/epoch/head + TTL); the caller ranks covering
// candidates by `latency + factor + transfer_cost + failure_penalty` and routes
// there. Ads route; the commit still proves authority. These cases pin the
// ranking formula, TTL expiry, false-positive deprioritisation, and — riding on
// B7 warm cache-fill — execution MIGRATION: a cold miss runs remote, warms the
// actor node, and the next same-object turn routes local with no remote fetch.
describe("B8 capability gossip routing", () => {
  function setControlCall(id: string, wet: number, session: string, actor: string): ShadowTurnCall {
    return {
      kind: "woo.turn_call.shadow.v1",
      id,
      route: "sequenced",
      scope: "the_dubspace",
      session,
      actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", wet]
    };
  }

  it("ranks covering candidates by latency + factor + transfer_cost + failure_penalty", () => {
    const key = { scope: "s", atom_hashes: ["a"], accept_atom_hashes: ["x"] } as ReturnType<typeof shadowTurnKeyFromTranscript>;
    const local = buildShadowCapabilityAd({ node: "local", scope: "s", atom_hashes: ["a"], accepts_atom_hashes: ["x"], factor: 1, latency_ms: 0, transfer_cost: 0 });
    const remote = buildShadowCapabilityAd({ node: "remote", scope: "s", atom_hashes: ["a"], accepts_atom_hashes: ["x"], factor: 1, latency_ms: 50 });
    const lying = buildShadowCapabilityAd({ node: "lying", scope: "s", atom_hashes: ["a"], accepts_atom_hashes: ["x"], factor: 1, failure_penalty: 100 });

    expect(capabilityAdRoutingScore(local)).toBe(1);
    expect(capabilityAdRoutingScore(remote)).toBe(51);
    expect(capabilityAdRoutingScore(lying)).toBe(101);

    const ranked = rankCapabilityAdsForTurn([remote, lying, local], key);
    expect(ranked.map((ad) => ad.node)).toEqual(["local", "remote", "lying"]);
  });

  it("drops a covering ad once its TTL has expired (only when a clock is supplied)", () => {
    const key = { scope: "s", atom_hashes: ["a"], accept_atom_hashes: ["x"] } as ReturnType<typeof shadowTurnKeyFromTranscript>;
    const ad = buildShadowCapabilityAd({ node: "n", scope: "s", atom_hashes: ["a"], accepts_atom_hashes: ["x"], factor: 1, issued_at_ms: 0, ttl_ms: 100 });
    expect(rankCapabilityAdsForTurn([ad], key).map((a) => a.node)).toEqual(["n"]); // no clock → never expires
    expect(rankCapabilityAdsForTurn([ad], key, { now: 50 }).map((a) => a.node)).toEqual(["n"]);
    expect(rankCapabilityAdsForTurn([ad], key, { now: 200 }).map((a) => a.node)).toEqual([]);
  });

  it("routes a contended turn to the only executor whose ad covers it (no location oracle)", () => {
    // Ranking inspects ONLY ads + key — never the world — so a turn routes to a
    // covering executor without any global enumeration (big-world discipline).
    const keyY = { scope: "s", atom_hashes: ["y"], accept_atom_hashes: ["y"] } as ReturnType<typeof shadowTurnKeyFromTranscript>;
    const adA = buildShadowCapabilityAd({ node: "A", scope: "s", atom_hashes: ["x"], accepts_atom_hashes: ["x"], factor: 0.1 });
    const adC = buildShadowCapabilityAd({ node: "busy-room-C", scope: "s", atom_hashes: ["y"], accepts_atom_hashes: ["y"], factor: 9 });
    const ranked = rankCapabilityAdsForTurn([adA, adC], keyY);
    expect(ranked.map((ad) => ad.node)).toEqual(["busy-room-C"]); // A does not cover; C wins despite worse factor
  });

  function keyWith(parts: { epoch: string; effects: number; atoms: string[]; accepts: string[] }): ShadowTurnKey {
    return {
      kind: "woo.turn_key.shadow.v1",
      scope: "s",
      epoch: parts.epoch,
      actor: "a",
      target: "s",
      verb: "v",
      effects: parts.effects,
      preimages: [],
      atom_hashes: parts.atoms,
      read_preimages: [],
      read_atom_hashes: [],
      write_preimages: [],
      write_atom_hashes: [],
      accept_preimages: [],
      accept_atom_hashes: parts.accepts
    };
  }

  it("VTN11 effect mask: a move turn does not route to a read-only executor", () => {
    const key = keyWith({ epoch: "shadow", effects: SHADOW_EFFECT_MOVE, atoms: ["m"], accepts: ["x"] });
    const full = buildShadowCapabilityAd({ node: "full", scope: "s", atom_hashes: ["m"], accepts_atom_hashes: ["x"] }); // default ALL effects
    const readOnly = buildShadowCapabilityAd({ node: "read-only", scope: "s", atom_hashes: ["m"], accepts_atom_hashes: ["x"], effects: SHADOW_EFFECT_READ });

    expect(capabilityAdProbablyCoversTurn(full, key)).toBe(true);
    expect(capabilityAdProbablyCoversTurn(readOnly, key)).toBe(false); // MOVE not in the ad's accepted effects
    expect(rankCapabilityAdsForTurn([readOnly, full], key).map((ad) => ad.node)).toEqual(["full"]);
  });

  it("VTN11 epoch: a stale-generation ad does not route; same-generation and wildcard do", () => {
    const key = keyWith({ epoch: "7", effects: 0, atoms: ["m"], accepts: ["x"] });
    const same = buildShadowCapabilityAd({ node: "same", scope: "s", epoch: "7", atom_hashes: ["m"], accepts_atom_hashes: ["x"] });
    const stale = buildShadowCapabilityAd({ node: "stale", scope: "s", epoch: "6", atom_hashes: ["m"], accepts_atom_hashes: ["x"] });
    const wild = buildShadowCapabilityAd({ node: "wild", scope: "s", epoch: "shadow", atom_hashes: ["m"], accepts_atom_hashes: ["x"] });

    expect(capabilityAdProbablyCoversTurn(same, key)).toBe(true);
    expect(capabilityAdProbablyCoversTurn(stale, key)).toBe(false); // different scope generation
    expect(capabilityAdProbablyCoversTurn(wild, key)).toBe(true);   // wildcard matches any generation
  });

  it("execution migrates: cold turn runs remote+warms the actor, next turn routes local with no fetch", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:b8-migrate");
    const actor = session.actor;
    const moved = await anchor.directCall("b8-migrate-dubspace-moveto", actor, actor, "moveto", ["the_dubspace"], { sessionId: session.id });
    expect(moved.op).toBe("result");
    const serialized = anchor.exportWorld();

    const ownerB = createShadowExecutionNode({ node: "owner-B", scope: "the_dubspace", serialized, authoritative_state: true });
    const commitScope = createShadowCommitScope({ node: "owner-B", scope: "the_dubspace", serialized });

    // Turn 1 (cold): the actor node holds nothing, so only the remote owner
    // covers. It runs remotely and the reply warms the actor (B7).
    const turn1 = await executeAuthoritativeShadowTurnCall(ownerB, {
      id: "b8-turn-1",
      call: setControlCall("b8-turn-1", 0.66, session.id, actor),
      commitScope
    });
    expect(turn1.ok).toBe(true);
    if (!turn1.ok) throw new Error(`turn1 failed: ${turn1.reason}`);
    const warm = turn1.reply?.ok ? turn1.reply.state_transfer : undefined;
    expect(warm).toBeDefined();

    const actorA = createShadowExecutionNode({ node: "actor-A", scope: "the_dubspace" });
    installShadowStateTransfer(actorA, warm!);

    // Turn 2: the actor node now covers (warm). Its ad is local (latency 0,
    // transfer_cost 0); the remote owner advertises with real latency. Gossip
    // ranking routes the turn to the actor node — execution migrated.
    const afterTurn1 = turn1.serializedAfter;
    const call2 = setControlCall("b8-turn-2", 0.5, session.id, actor);
    const planned2 = await runShadowTurnCall(authoritativePlanningWorld(afterTurn1), call2);
    const key2 = shadowTurnKeyFromTranscript(planned2.transcript);

    const routed = await executeShadowTurnCallAcrossInProcessNetwork({
      request: { kind: "woo.turn.exec.request.shadow.v1" as const, call: call2, key: key2 },
      nodes: [actorA, ownerB],
      ads: [
        buildShadowTurnExecAdFromNode({ node: actorA, accepts: key2, factor: 1, latency_ms: 0, transfer_cost: 0 }),
        buildShadowTurnExecAd({ node: "owner-B", scope: "the_dubspace", key: key2, factor: 1, latency_ms: 50, transfer_cost: 20 })
      ],
      anchor: { node: "owner-B", serialized: afterTurn1 },
      commitScope
    });

    expect(routed.selected_node).toBe("actor-A");   // migrated B -> A
    expect(routed.transfers).toHaveLength(0);         // warm: no remote fetch
    expect(routed.result.ok).toBe(true);
    if (!routed.result.ok) throw new Error(`turn2 failed: ${routed.result.reason}`);
    // Authority unchanged: the commit still landed at the owner's scope.
    expect(routed.result.commit?.position.scope).toBe("the_dubspace");
  });
});
