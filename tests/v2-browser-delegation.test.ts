import { authoritativePlanningWorld } from "../src/core/planning-world";
import { describe, expect, it } from "vitest";

import { selectV2DelegatedExecutor, selectV2DelegatedScopeExecutor, v2ExecutionAdRecord } from "../src/client/v2-browser-delegation";
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

  it("selects a scope-level executor before the browser can derive an exact turn key", async () => {
    const key = await plannedDubspaceKey();
    const selected = selectV2DelegatedScopeExecutor({
      scope: key.scope,
      records: [
        v2ExecutionAdRecord(buildShadowCapabilityAd({ node: "scope-slow", scope: key.scope, atom_hashes: [], factor: 4 }), 1),
        v2ExecutionAdRecord(buildShadowCapabilityAd({ node: "scope-near", scope: key.scope, atom_hashes: [], factor: 0.4 }), 2),
        v2ExecutionAdRecord(buildShadowCapabilityAd({ node: "other", scope: "the_pinboard", atom_hashes: [], factor: 0.1 }), 3)
      ]
    });

    expect(selected).toMatchObject({ ok: true, ad: { node: "scope-near" } });
  });

  it("drops an expired ad from exact-key selection (TTL is load-bearing in real routing)", async () => {
    const key = await plannedDubspaceKey();
    const selected = selectV2DelegatedExecutor({
      key,
      now: 1000,
      records: [
        // Best score but expired at now=1000 (issued 0 + ttl 100).
        v2ExecutionAdRecord(buildShadowCapabilityAd({ node: "expired-best", scope: key.scope, atom_hashes: key.atom_hashes, accepts_atom_hashes: key.accept_atom_hashes, factor: 0.1, issued_at_ms: 0, ttl_ms: 100 }), 1),
        // Fresh but worse factor.
        v2ExecutionAdRecord(buildShadowCapabilityAd({ node: "fresh", scope: key.scope, atom_hashes: key.atom_hashes, accepts_atom_hashes: key.accept_atom_hashes, factor: 5, issued_at_ms: 900, ttl_ms: 1000 }), 2)
      ]
    });
    expect(selected).toMatchObject({ ok: true, ad: { node: "fresh" } });
  });

  it("ranks exact-key selection by latency + factor + transfer_cost (not factor alone)", async () => {
    const key = await plannedDubspaceKey();
    const selected = selectV2DelegatedExecutor({
      key,
      now: 1,
      records: [
        // Lowest factor but remote: score 0.2 + 50 + 20 = 70.2.
        v2ExecutionAdRecord(buildShadowCapabilityAd({ node: "remote", scope: key.scope, atom_hashes: key.atom_hashes, accepts_atom_hashes: key.accept_atom_hashes, factor: 0.2, latency_ms: 50, transfer_cost: 20 }), 1),
        // Higher factor but local + warm: score 1.
        v2ExecutionAdRecord(buildShadowCapabilityAd({ node: "local-warm", scope: key.scope, atom_hashes: key.atom_hashes, accepts_atom_hashes: key.accept_atom_hashes, factor: 1, latency_ms: 0, transfer_cost: 0 }), 2)
      ]
    });
    expect(selected).toMatchObject({ ok: true, ad: { node: "local-warm" } });
  });

  it("scope-level selection drops expired ads and ranks by routing score (not factor alone)", () => {
    const scope = "the_dubspace";
    const selected = selectV2DelegatedScopeExecutor({
      scope,
      now: 1000,
      records: [
        // Best factor but expired → dropped.
        v2ExecutionAdRecord(buildShadowCapabilityAd({ node: "scope-expired-best", scope, atom_hashes: [], factor: 0.1, issued_at_ms: 0, ttl_ms: 100 }), 1),
        // Fresh but remote: score 0.2 + 50 = 50.2.
        v2ExecutionAdRecord(buildShadowCapabilityAd({ node: "scope-fresh-remote", scope, atom_hashes: [], factor: 0.2, latency_ms: 50, issued_at_ms: 900, ttl_ms: 1000 }), 2),
        // Fresh + local: score 1 → wins over the fresh-remote despite worse factor.
        v2ExecutionAdRecord(buildShadowCapabilityAd({ node: "scope-fresh-local", scope, atom_hashes: [], factor: 1, latency_ms: 0, issued_at_ms: 900, ttl_ms: 1000 }), 3)
      ]
    });
    expect(selected).toMatchObject({ ok: true, ad: { node: "scope-fresh-local" } });
  });
});

async function plannedDubspaceKey() {
  const world = createWorld();
  const session = world.auth("guest:v2-browser-delegation");
  const moved = await world.directCall("delegation-dubspace-moveto", session.actor, session.actor, "moveto", ["the_dubspace"], { sessionId: session.id });
  expect(moved.op).toBe("result");
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
  return shadowTurnKeyFromTranscript((await runShadowTurnCall(authoritativePlanningWorld(world.exportWorld()), call)).transcript);
}
