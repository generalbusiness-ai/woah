import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import {
  nativePrimitiveContract,
  nativePrimitiveContractDisciplineErrors
} from "../src/core/native-primitive-contract";
import type { MetricEvent } from "../src/core/types";
import type { WooWorld } from "../src/core/world";

type CallResult = { op: "result"; result: any } | { op: "error"; error: any };

async function provisionHuman(
  world: WooWorld,
  email: string
): Promise<{ human: string; account: string }> {
  const start = await world.beginSignup(email, "password123");
  const verify = world.verifySignup(start.verification_token);
  const human = verify.actor as string;
  const account = world.propOrNull(human, "account") as string;
  world.setProp(account, "programmer_grant_quota", 10);
  return { human, account };
}

async function createAgent(
  world: WooWorld,
  human: string,
  name: string,
  programmer: boolean
): Promise<string> {
  const frame = await world.directCall(
    `create-${name}`,
    human,
    human,
    "create_agent",
    [name, "", programmer]
  ) as CallResult;
  if (frame.op === "error") throw new Error(JSON.stringify(frame.error));
  return frame.result.actor_id as string;
}

async function humanAgentCall(
  world: WooWorld,
  human: string,
  verb: string,
  agent: string
): Promise<CallResult> {
  return await world.directCall(
    `${verb}-${agent}`,
    human,
    human,
    verb,
    [agent]
  ) as CallResult;
}

describe("native handler prepare/apply failure boundaries", () => {
  it("rejects malformed features before programmer promotion mutates lineage or quota", async () => {
    const world = createWorld();
    const { human, account } = await provisionHuman(world, "native-promote@woo.dev");
    const agent = await createAgent(world, human, "native-promote", false);
    world.setProp(agent, "features", "malformed" as never);
    const counterVersion = world.object(account).propertyVersions.get("programmer_agent_count");

    const frame = await humanAgentCall(world, human, "promote_agent_to_programmer", agent);

    expect(frame.op).toBe("error");
    expect((frame as any).error.code).toBe("E_TYPE");
    expect(world.object(agent).flags.programmer ?? false).toBe(false);
    expect(world.propOrNull(account, "programmer_agent_count")).toBe(0);
    expect(world.object(account).propertyVersions.get("programmer_agent_count")).toBe(counterVersion);
    expect(world.propOrNull(agent, "features")).toBe("malformed");
  });

  it("rejects malformed features before programmer demotion mutates lineage or quota", async () => {
    const world = createWorld();
    const { human, account } = await provisionHuman(world, "native-demote@woo.dev");
    const agent = await createAgent(world, human, "native-demote", true);
    world.setProp(agent, "features", "malformed" as never);
    const counterVersion = world.object(account).propertyVersions.get("programmer_agent_count");

    const frame = await humanAgentCall(world, human, "demote_agent_from_programmer", agent);

    expect(frame.op).toBe("error");
    expect((frame as any).error.code).toBe("E_TYPE");
    expect(world.object(agent).flags.programmer).toBe(true);
    expect(world.propOrNull(account, "programmer_agent_count")).toBe(1);
    expect(world.object(account).propertyVersions.get("programmer_agent_count")).toBe(counterVersion);
    expect(world.propOrNull(agent, "features")).toBe("malformed");
  });

  it("rejects malformed features before retirement changes any lifecycle fact", async () => {
    const world = createWorld();
    const { human, account } = await provisionHuman(world, "native-revoke@woo.dev");
    const agent = await createAgent(world, human, "native-revoke", true);
    const keyId = world.propOrNull(agent, "api_key_id") as string;
    world.setProp(agent, "features", "malformed" as never);
    const keyBefore = structuredClone(
      (world.propOrNull(agent, "api_keys") as Record<string, unknown>)[keyId]
    );

    const frame = await humanAgentCall(world, human, "revoke_agent", agent);

    expect(frame.op).toBe("error");
    expect((frame as any).error.code).toBe("E_TYPE");
    expect(world.object(agent).flags.programmer).toBe(true);
    expect(world.propOrNull(account, "programmer_agent_count")).toBe(1);
    expect(world.propOrNull(account, "agent_count")).toBe(1);
    expect(world.propOrNull(agent, "deactivated_at")).toBe(null);
    expect(world.propOrNull(agent, "retired_at")).toBe(null);
    expect((world.propOrNull(agent, "api_keys") as Record<string, unknown>)[keyId])
      .toEqual(keyBefore);
  });

  it("preflights set_actor_flag before its separate programmer counter write", async () => {
    const world = createWorld();
    const { human, account } = await provisionHuman(world, "native-flag@woo.dev");
    const agent = await createAgent(world, human, "native-flag", false);
    world.setProp(agent, "features", "malformed" as never);

    const frame = await world.directCall(
      "native-set-flag",
      "$wiz",
      "$system",
      "set_actor_flag",
      [agent, "programmer", true]
    ) as CallResult;

    expect(frame.op).toBe("error");
    expect((frame as any).error.code).toBe("E_TYPE");
    expect(world.object(agent).flags.programmer ?? false).toBe(false);
    expect(world.propOrNull(account, "programmer_agent_count")).toBe(0);
  });

  it("preflights the prospective $agent surface before consuming an object id", async () => {
    const world = createWorld();
    const baseline = createWorld();
    const current = await provisionHuman(world, "native-create-collision@woo.dev");
    const control = await provisionHuman(baseline, "native-create-control@woo.dev");
    const beforeIds = Object.keys(world.state().objects).sort();
    const beforeActors = world.propOrNull(current.account, "actors");
    const surfaceVerb = world.object("$programmer").verbs.find((verb) => verb.name === "eval");
    if (!surfaceVerb) throw new Error("$programmer:eval fixture missing");
    const injectedCollision = { ...surfaceVerb, owner: "$agent" };
    world.object("$agent").verbs.push(injectedCollision);

    const refused = await world.directCall(
      "native-create-collision",
      current.human,
      current.human,
      "create_agent",
      ["collision", "", true]
    ) as CallResult;

    expect(refused.op).toBe("error");
    expect((refused as any).error.code).toBe("E_INVARG");
    expect(Object.keys(world.state().objects).sort()).toEqual(beforeIds);
    expect(world.propOrNull(current.account, "actors")).toEqual(beforeActors);
    expect(world.propOrNull(current.account, "agent_count")).toBe(0);
    expect(world.propOrNull(current.account, "programmer_agent_count")).toBe(0);

    world.object("$agent").verbs = world.object("$agent").verbs.filter(
      (verb) => verb !== injectedCollision
    );
    const afterRefusal = await createAgent(world, current.human, "after-refusal", true);
    const withoutRefusal = await createAgent(baseline, control.human, "control", true);
    expect(afterRefusal).toBe(withoutRefusal);
  });

  it("preflights replacement-key routing before revoking the current key", async () => {
    const world = createWorld();
    const { human } = await provisionHuman(world, "native-rotate@woo.dev");
    const agent = await createAgent(world, human, "native-rotate", false);
    const keyId = world.propOrNull(agent, "api_key_id") as string;
    const keyBefore = structuredClone(
      (world.propOrNull(agent, "api_keys") as Record<string, unknown>)[keyId]
    );
    world.object(agent).anchor = "the_chatroom";

    const frame = await humanAgentCall(world, human, "rotate_agent_key", agent);

    expect(frame.op).toBe("error");
    expect((frame as any).error.code).toBe("E_LINEAGE");
    expect(world.propOrNull(agent, "api_key_id")).toBe(keyId);
    expect((world.propOrNull(agent, "api_keys") as Record<string, unknown>)[keyId])
      .toEqual(keyBefore);
  });
});

describe("native post-accept host effects", () => {
  it("keeps API-key revocation accepted when session notification rejects", async () => {
    const metrics: MetricEvent[] = [];
    const world = createWorld({ metricsHook: (event) => metrics.push(event) });
    const { human } = await provisionHuman(world, "native-revoke-callback@woo.dev");
    const agent = await createAgent(world, human, "native-revoke-callback", false);
    const keyId = world.propOrNull(agent, "api_key_id") as string;
    const session = world.createSessionForActor(agent, "apikey", keyId);
    let callbackSawRevoked = false;

    const frame = await world.directCall(
      "native-revoke-callback",
      human,
      "$system",
      "revoke_api_key",
      [keyId],
      {
        onSessionsEnded: async () => {
          const record = (world.propOrNull(agent, "api_keys") as Record<string, any>)[keyId];
          callbackSawRevoked = record.revoked_at != null;
          throw new Error("notification unavailable");
        }
      }
    ) as CallResult;
    await Promise.resolve();

    expect(frame.op).toBe("result");
    expect((frame as any).result).toBe(true);
    expect(callbackSawRevoked).toBe(true);
    expect(world.sessionAlive(session.id)).toBe(false);
    expect((world.propOrNull(agent, "api_keys") as Record<string, any>)[keyId].revoked_at)
      .toBeTruthy();
    expect(metrics).toContainEqual(expect.objectContaining({
      kind: "post_accept_effect",
      effect: "sessions_ended:revoke_api_key",
      status: "error",
      error: "E_INTERNAL"
    }));
  });

  it("keeps actor deactivation accepted when session notification throws", async () => {
    const metrics: MetricEvent[] = [];
    const world = createWorld({ metricsHook: (event) => metrics.push(event) });
    const { human } = await provisionHuman(world, "native-deactivate-callback@woo.dev");
    const agent = await createAgent(world, human, "native-deactivate-callback", false);
    const session = world.createSessionForActor(agent, "bearer");

    const frame = await world.directCall(
      "native-deactivate-callback",
      "$wiz",
      "$system",
      "deactivate_actor",
      [agent, "test"],
      { onSessionsEnded: () => { throw new Error("notification unavailable"); } }
    ) as CallResult;

    expect(frame.op).toBe("result");
    expect((frame as any).result).toBe(true);
    expect(world.propOrNull(agent, "deactivated_at")).toBeTypeOf("number");
    expect(world.sessionAlive(session.id)).toBe(false);
    expect(metrics).toContainEqual(expect.objectContaining({
      kind: "post_accept_effect",
      effect: "sessions_ended:deactivate_actor",
      status: "error",
      error: "E_INTERNAL"
    }));
  });
});

describe("tracked native failure contracts", () => {
  it("requires a valid failure discipline for every mutating contract", () => {
    expect(nativePrimitiveContractDisciplineErrors()).toEqual([]);
    expect(nativePrimitiveContract("human_promote_agent_to_programmer")?.failure)
      .toEqual({ mutation_scope: "single_authority", on_error: "rollback" });
    expect(nativePrimitiveContract("revoke_api_key")?.failure?.post_commit)
      .toContain("session-ended transport notification");
  });
});
