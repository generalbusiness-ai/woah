import { describe, expect, it } from "vitest";

import { selectV2DelegatedExecutor, v2ExecutionAdRecord } from "../src/client/v2-browser-delegation";
import { buildShadowCapabilityAd } from "../src/core/capability-ad";
import { createWorld } from "../src/core/bootstrap";
import { runShadowTurnCall, type ShadowTurnCall } from "../src/core/shadow-turn-call";
import { shadowTurnKeyFromTranscript } from "../src/core/turn-key";

describe("v2 browser delegation", () => {
  it("selects the lowest-factor gossiped executor that covers the planned turn", async () => {
    const key = await plannedDubspaceKey();
    const selected = selectV2DelegatedExecutor({
      key,
      records: [
        v2ExecutionAdRecord(buildShadowCapabilityAd({ node: "slow", scope: key.scope, atom_hashes: key.atom_hashes, accepts_atom_hashes: key.accept_atom_hashes, factor: 5 }), 1),
        v2ExecutionAdRecord(buildShadowCapabilityAd({ node: "near", scope: key.scope, atom_hashes: key.atom_hashes, accepts_atom_hashes: key.accept_atom_hashes, factor: 0.2 }), 2),
        v2ExecutionAdRecord(buildShadowCapabilityAd({ node: "wrong-scope", scope: "the_pinboard", atom_hashes: key.atom_hashes, accepts_atom_hashes: key.accept_atom_hashes, factor: 0.1 }), 3)
      ]
    });

    expect(selected).toMatchObject({ ok: true, ad: { node: "near" } });
  });

  it("reports no executor when gossip does not cover the planned turn", async () => {
    const key = await plannedDubspaceKey();
    const selected = selectV2DelegatedExecutor({
      key,
      records: [
        v2ExecutionAdRecord(buildShadowCapabilityAd({ node: "empty", scope: key.scope, atom_hashes: [], factor: 0.1 }), 1)
      ]
    });

    expect(selected).toEqual({ ok: false, reason: "no_executor" });
  });
});

async function plannedDubspaceKey() {
  const world = createWorld();
  const session = world.auth("guest:v2-browser-delegation");
  world.setProp("the_dubspace", "operators", [session.actor]);
  const call: ShadowTurnCall = {
    kind: "woo.turn_call.shadow.v1",
    id: "delegated-dubspace-turn",
    route: "sequenced",
    scope: "the_dubspace",
    session: session.id,
    actor: session.actor,
    target: "the_dubspace",
    verb: "set_control",
    args: ["delay_1", "wet", 0.31]
  };
  return shadowTurnKeyFromTranscript((await runShadowTurnCall(world.exportWorld(), call)).transcript);
}
