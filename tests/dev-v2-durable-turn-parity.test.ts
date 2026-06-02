import { describe, expect, it } from "vitest";

import { authoritativePlanningWorld } from "../src/core/planning-world";
import { createWorld, createWorldFromSerialized } from "../src/core/bootstrap";
import { createShadowBrowserRelayShim, shadowBrowserSessionBearer } from "../src/core/shadow-browser-node";
import { serializedFor } from "../src/core/shadow-commit-scope";
import { runShadowTurnCall, type ShadowTurnCall } from "../src/core/shadow-turn-call";
import { executeDevV2DurableTurnFrame, executeInProcessV2DurableTurn } from "../src/server/dev-v2-helpers";
import type { ExecutorCallInput } from "../src/core/executor";
import type { ObjRef } from "../src/core/types";

// #1 localdev↔CF drift: dev durable turns must use the SAME contract as CF —
// submitTurnIntent → sparse planning + admission gate + authority repair loop →
// commit-scope envelope → accepted commit. The previous dev path ran the
// browser-relay shortcut on a FULL-WORLD relay, so the sparse/repair machinery
// never fired. These cases pin the converged primitive: the repair loop fires on
// a sparse gateway, the result matches the direct authoritative path, and a
// genuinely cold gateway with no authority source cannot fabricate state.
describe("dev v2 durable turn — CF contract parity", () => {
  function setControl(scope: ObjRef, session: string, actor: ObjRef, wet: number, id: string): ExecutorCallInput {
    return {
      id,
      route: "sequenced",
      scope,
      session,
      actor,
      target: scope,
      verb: "set_control",
      args: ["delay_1", "wet", wet],
      persistence: "durable",
      token: shadowBrowserSessionBearer({ id: session, actor })
    };
  }

  it("plans on a sparse gateway (repair loop fires) and commits via the authoritative relay", async () => {
    const world = createWorld();
    const session = world.auth("guest:dev-parity");
    world.setProp("the_dubspace", "operators", [session.actor]);

    // Sparse gateway: bootstrap-only seed (NO the_dubspace / delay_1). The
    // authoritative commit relay holds the full world.
    const sparseSeed = createWorld({ catalogs: false }).exportWorld();
    const gatewayRelay = createShadowBrowserRelayShim({ node: "dev:gw", scope: "the_dubspace", serialized: sparseSeed, deployment: "local-dev" });
    const commitRelay = createShadowBrowserRelayShim({ node: "dev:commit", scope: "the_dubspace", serialized: world.exportWorld(), deployment: "local-dev" });

    // Sanity: the gateway is genuinely sparse — it does NOT hold delay_1.
    expect(serializedFor(gatewayRelay.commit_scope).objects.some((o) => o.id === "delay_1")).toBe(false);

    const submitted = await executeInProcessV2DurableTurn({
      world,
      gatewayRelay,
      commitRelay,
      node: "dev:gw",
      call: setControl("the_dubspace", session.id, session.actor, 0.42, "dev-parity-1")
    });

    expect(submitted.kind).toBe("submitted");
    if (submitted.kind !== "submitted") throw new Error(`expected submitted, got ${submitted.kind}`);
    expect(submitted.reply?.ok).toBe(true);
    if (!submitted.reply?.ok) throw new Error("expected accepted reply");
    expect(submitted.reply.commit?.position.scope).toBe("the_dubspace");

    // The repair loop FIRED: planning hit missing state for delay_1 on the sparse
    // gateway, submitTurnIntent repaired it from `world` authority, and the
    // gateway relay now holds delay_1.
    expect(serializedFor(gatewayRelay.commit_scope).objects.some((o) => o.id === "delay_1")).toBe(true);

    // Result parity with the direct authoritative path: same control_changed
    // observation and committed post-state value.
    const direct = await runShadowTurnCall(
      authoritativePlanningWorld(world.exportWorld()),
      setControlAsTurnCall("the_dubspace", session.id, session.actor, 0.42, "dev-parity-direct")
    );
    expect(submitted.reply.transcript?.observations).toContainEqual(
      expect.objectContaining({ type: "control_changed", target: "delay_1", name: "wet", value: 0.42 })
    );
    expect(direct.transcript.observations).toContainEqual(
      expect.objectContaining({ type: "control_changed", target: "delay_1", name: "wet", value: 0.42 })
    );
    const committed = createWorldFromSerialized(serializedFor(commitRelay.commit_scope), { persist: false });
    expect(committed.getProp("delay_1", "wet")).toBe(0.42);
  });

  it("executeDevV2DurableTurnFrame applies the commit to the dev world and returns an applied frame", async () => {
    const world = createWorld();
    const session = world.auth("guest:dev-frame");
    world.setProp("the_dubspace", "operators", [session.actor]);
    const sparseSeed = createWorld({ catalogs: false }).exportWorld();
    const gatewayRelay = createShadowBrowserRelayShim({ node: "dev:gw-frame", scope: "the_dubspace", serialized: sparseSeed, deployment: "local-dev" });
    const commitRelay = createShadowBrowserRelayShim({ node: "dev:commit-frame", scope: "the_dubspace", serialized: world.exportWorld(), deployment: "local-dev" });

    const { frame } = await executeDevV2DurableTurnFrame({
      world,
      gatewayRelay,
      commitRelay,
      node: "dev:gw-frame",
      call: setControl("the_dubspace", session.id, session.actor, 0.37, "dev-frame-1")
    });

    expect(frame.op).toBe("applied");
    if (frame.op !== "applied") throw new Error("expected applied frame");
    expect(frame.space).toBe("the_dubspace");
    // Write-through: the accepted transcript was materialized into the dev world.
    expect(world.getProp("delay_1", "wet")).toBe(0.37);
  });

  it("executeDevV2DurableTurnFrame throws a turn error when the verb raises (parity with the legacy REST contract)", async () => {
    const world = createWorld();
    const session = world.auth("guest:dev-frame-err");
    world.setProp("the_dubspace", "operators", [session.actor]);
    const sparseSeed = createWorld({ catalogs: false }).exportWorld();
    const gatewayRelay = createShadowBrowserRelayShim({ node: "dev:gw-err", scope: "the_dubspace", serialized: sparseSeed, deployment: "local-dev" });
    const commitRelay = createShadowBrowserRelayShim({ node: "dev:commit-err", scope: "the_dubspace", serialized: world.exportWorld(), deployment: "local-dev" });

    // A verb that does not exist on the target raises during planning → the
    // wrapper THROWS the turn error rather than returning an error frame
    // (matching restFrameFromTurnReply / the legacy dev REST path).
    const badCall = {
      id: "dev-frame-err-1",
      route: "sequenced" as const,
      scope: "the_dubspace" as ObjRef,
      session: session.id,
      actor: session.actor,
      target: "the_dubspace" as ObjRef,
      verb: "__parity_no_such_verb__",
      args: [],
      persistence: "durable" as const,
      token: shadowBrowserSessionBearer({ id: session.id, actor: session.actor })
    };
    await expect(executeDevV2DurableTurnFrame({
      world,
      gatewayRelay,
      commitRelay,
      node: "dev:gw-err",
      call: badCall
    })).rejects.toBeTruthy();
  });

  it("reuses warm gateway + commit relays across turns (live dev-server relay-reuse path)", async () => {
    // Mirrors the live dev server, which caches one gateway relay + one commit
    // relay per scope and runs many turns through them: turn 1 repairs the cold
    // gateway, turn 2 is warm (no new repair) and commits at the advanced head.
    const world = createWorld();
    const session = world.auth("guest:dev-warm");
    world.setProp("the_dubspace", "operators", [session.actor]);
    const gatewayRelay = createShadowBrowserRelayShim({ node: "dev:gw-warm", scope: "the_dubspace", serialized: createWorld({ catalogs: false }).exportWorld(), deployment: "local-dev" });
    const commitRelay = createShadowBrowserRelayShim({ node: "dev:commit-warm", scope: "the_dubspace", serialized: world.exportWorld(), deployment: "local-dev" });

    const first = await executeDevV2DurableTurnFrame({
      world, gatewayRelay, commitRelay, node: "dev:gw-warm",
      call: setControl("the_dubspace", session.id, session.actor, 0.11, "dev-warm-1")
    });
    expect(first.frame.op).toBe("applied");
    expect(world.getProp("delay_1", "wet")).toBe(0.11);
    const headAfterFirst = commitRelay.commit_scope.head.seq;

    const second = await executeDevV2DurableTurnFrame({
      world, gatewayRelay, commitRelay, node: "dev:gw-warm",
      call: setControl("the_dubspace", session.id, session.actor, 0.22, "dev-warm-2")
    });
    expect(second.frame.op).toBe("applied");
    expect(world.getProp("delay_1", "wet")).toBe(0.22);
    // The commit head advanced (the warm gateway committed at the new head, not a stale one).
    expect(commitRelay.commit_scope.head.seq).toBeGreaterThan(headAfterFirst);
  });

  it("a cold gateway whose authority source lacks the target cannot fabricate state (sparseness is real)", async () => {
    // The authority SOURCE is the sparse bootstrap world (no the_dubspace), so the
    // repair loop has nothing to fill the missing closure with — the turn must
    // fail rather than silently plan against a hidden full world.
    const sparseWorld = createWorld({ catalogs: false });
    const session = sparseWorld.auth("guest:dev-parity-cold");
    const sparseSeed = sparseWorld.exportWorld();
    const gatewayRelay = createShadowBrowserRelayShim({ node: "dev:gw-cold", scope: "the_dubspace", serialized: sparseSeed, deployment: "local-dev" });
    const commitRelay = createShadowBrowserRelayShim({ node: "dev:commit-cold", scope: "the_dubspace", serialized: sparseSeed, deployment: "local-dev" });

    await expect(executeInProcessV2DurableTurn({
      world: sparseWorld,
      gatewayRelay,
      commitRelay,
      node: "dev:gw-cold",
      maxAttempts: 3,
      call: setControl("the_dubspace", session.id, session.actor, 0.5, "dev-parity-cold-1")
    })).rejects.toThrow();
  });
});

function setControlAsTurnCall(scope: ObjRef, session: string, actor: ObjRef, wet: number, id: string): ShadowTurnCall {
  return {
    kind: "woo.turn_call.shadow.v1",
    id,
    route: "sequenced",
    scope,
    session,
    actor,
    target: scope,
    verb: "set_control",
    args: ["delay_1", "wet", wet]
  };
}
