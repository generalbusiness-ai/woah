import { describe, expect, it } from "vitest";

import { authoritativePlanningWorld } from "../src/core/planning-world";
import { createWorld, createWorldFromSerialized } from "../src/core/bootstrap";
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

// B7 (VTN0 claim 5 / VTN12): state transfer as first-class verifiable cache-fill.
// The two-node gate the B7 spec note requires: an actor executes a turn on a
// REMOTE authoritative owner, the reply carries a verifiable state transfer, the
// actor installs it, and the NEXT same-object turn is served LOCALLY with no
// second remote state fetch. The installed rows are source:"cache" and never act
// as a write-authority source — the warmed turn still commits at the owner.
describe("B7 state-transfer warm cache-fill", () => {
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

  it("warms the caller from the commit reply so the next same-object turn is local", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:b7-warm");
    const actor = session.actor;
    anchor.setProp("the_dubspace", "operators", [actor]);
    const serialized = anchor.exportWorld();

    // Owner B holds authoritative scope state and is the only node that can
    // commit. Turn 1 executes remotely on B.
    const ownerB = createShadowExecutionNode({
      node: "owner-B",
      scope: "the_dubspace",
      serialized,
      authoritative_state: true
    });
    const commitScope = createShadowCommitScope({ node: "owner-B", scope: "the_dubspace", serialized });

    const turn1 = await executeAuthoritativeShadowTurnCall(ownerB, {
      id: "b7-turn-1",
      call: setControlCall("b7-turn-1", 0.66, session.id, actor),
      commitScope
    });
    expect(turn1.ok).toBe(true);
    if (!turn1.ok) throw new Error(`turn 1 failed: ${turn1.reason}`);

    // The reply carries a verifiable cell_pages warm transfer of the committed
    // closure (VTN12), purpose accepted_write_cells.
    const warm = turn1.reply?.ok ? turn1.reply.state_transfer : undefined;
    expect(warm).toBeDefined();
    if (!warm) throw new Error("turn 1 reply did not carry a warm state transfer");
    expect(warm.mode).toBe("cell_pages");
    if (warm.mode !== "cell_pages") throw new Error("warm transfer is not cell_pages");
    expect(warm.purpose).toBe("accepted_write_cells");
    expect(warm.scope).toBe("the_dubspace");
    expect(warm.page_refs.length + warm.inline_pages.length).toBeGreaterThan(0);

    // Actor node A is a sparse caller: no authoritative state of its own. It
    // installs the warm transfer from the reply.
    const actorA = createShadowExecutionNode({ node: "actor-A", scope: "the_dubspace" });
    expect(actorA.authoritative_state).toBeFalsy();
    installShadowStateTransfer(actorA, warm);

    // A3 / coherence invariant: every cell the warm transfer delivered is tagged
    // source:"cache" — a derived read-through, never a write-authority source.
    expect(actorA.cellProvenance && actorA.cellProvenance.size).toBeGreaterThan(0);
    for (const provenance of (actorA.cellProvenance ?? new Map()).values()) {
      expect(provenance.source).toBe("cache");
    }

    // Turn 2: same object, executed against the warmed actor node A. Plan it
    // against the post-turn-1 authority to derive the turn key.
    const afterTurn1 = turn1.serializedAfter;
    const headSeqAfterTurn1 = commitScope.head.seq;
    const call2 = setControlCall("b7-turn-2", 0.5, session.id, actor);
    const planned2 = await runShadowTurnCall(authoritativePlanningWorld(afterTurn1), call2);
    const key2 = shadowTurnKeyFromTranscript(planned2.transcript);
    const request2 = { kind: "woo.turn.exec.request.shadow.v1" as const, call: call2, key: key2 };

    const warmRouted = await executeShadowTurnCallAcrossInProcessNetwork({
      request: request2,
      nodes: [actorA],
      ads: [buildShadowTurnExecAdFromNode({ node: actorA, accepts: key2, factor: 0.1 })],
      anchor: { node: "owner-B", serialized: afterTurn1 },
      commitScope
    });

    // Local: A was selected, and ZERO state transfers were needed — no second
    // remote fetch. The warm cache covered the turn.
    expect(warmRouted.selected_node).toBe("actor-A");
    expect(warmRouted.transfers).toHaveLength(0);
    expect(warmRouted.result.ok).toBe(true);
    if (!warmRouted.result.ok) throw new Error(`warm turn 2 failed: ${warmRouted.result.reason}`);
    // The commit still landed at the owner's commit scope (authority), not at the
    // actor's cache: the scope head advanced past turn 1's.
    expect(commitScope.head.seq).toBeGreaterThan(headSeqAfterTurn1);
    const afterTurn2 = createWorldFromSerialized(warmRouted.result.serializedAfter, { persist: false });
    expect(afterTurn2.getProp("delay_1", "wet")).toBe(0.5);
  });

  it("a COLD caller needs a remote fetch for the same turn (warm-fill is necessary)", async () => {
    // Negative control: identical turn 2, but the actor node was never warmed.
    // It must fetch state (>=1 transfer) — proving the warm transfer above is
    // what removed the remote round-trip.
    const anchor = createWorld();
    const session = anchor.auth("guest:b7-cold");
    const actor = session.actor;
    anchor.setProp("the_dubspace", "operators", [actor]);
    const serialized = anchor.exportWorld();
    const commitScope = createShadowCommitScope({ node: "owner-B", scope: "the_dubspace", serialized });

    const coldA = createShadowExecutionNode({ node: "cold-A", scope: "the_dubspace" });
    const call = setControlCall("b7-cold-turn", 0.5, session.id, actor);
    const planned = await runShadowTurnCall(authoritativePlanningWorld(serialized), call);
    const key = shadowTurnKeyFromTranscript(planned.transcript);

    const routed = await executeShadowTurnCallAcrossInProcessNetwork({
      request: { kind: "woo.turn.exec.request.shadow.v1" as const, call, key },
      nodes: [coldA],
      // A cold node optimistically advertises the turn key (it has no held atoms
      // to honestly cover with): it is selected, misses, and the network forward-
      // repairs it with a state transfer.
      ads: [buildShadowTurnExecAd({ node: "cold-A", scope: "the_dubspace", key, factor: 0.1 })],
      anchor: { node: "owner-B", serialized },
      commitScope
    });

    expect(routed.result.ok).toBe(true);
    // Cold path required at least one state transfer (the forward repair) — the
    // remote round-trip the warm-fill eliminates.
    expect(routed.transfers.length).toBeGreaterThanOrEqual(1);
  });
});
