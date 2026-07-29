import { describe, expect, it } from "vitest";
import { createWorld, createWorldFromSerialized } from "../src/core/bootstrap";
import {
  nativePrimitiveContract,
  nativePrimitiveContractDisciplineErrors,
  nativePrimitiveFailureContract,
  nativePrimitiveFailureContractHandlers
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
  agent: string,
  invocation = "first"
): Promise<CallResult> {
  return await world.directCall(
    `${verb}-${agent}-${invocation}`,
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
    const before = world.exportWorld();

    const frame = await humanAgentCall(world, human, "promote_agent_to_programmer", agent, "first");

    expect(frame.op).toBe("error");
    expect((frame as any).error.code).toBe("E_TYPE");
    expect(world.object(agent).flags.programmer ?? false).toBe(false);
    expect(world.propOrNull(account, "programmer_agent_count")).toBe(0);
    expect(world.object(account).propertyVersions.get("programmer_agent_count")).toBe(counterVersion);
    expect(world.propOrNull(agent, "features")).toBe("malformed");
    expect(world.exportWorld()).toEqual(before);

    const retry = await humanAgentCall(world, human, "promote_agent_to_programmer", agent, "second");
    expect(retry).toMatchObject({ op: "error", error: { code: "E_TYPE" } });
    expect(world.exportWorld()).toEqual(before);
  });

  it("rejects malformed features before programmer demotion mutates lineage or quota", async () => {
    const world = createWorld();
    const { human, account } = await provisionHuman(world, "native-demote@woo.dev");
    const agent = await createAgent(world, human, "native-demote", true);
    world.setProp(agent, "features", "malformed" as never);
    const counterVersion = world.object(account).propertyVersions.get("programmer_agent_count");
    const before = world.exportWorld();

    const frame = await humanAgentCall(world, human, "demote_agent_from_programmer", agent, "first");

    expect(frame.op).toBe("error");
    expect((frame as any).error.code).toBe("E_TYPE");
    expect(world.object(agent).flags.programmer).toBe(true);
    expect(world.propOrNull(account, "programmer_agent_count")).toBe(1);
    expect(world.object(account).propertyVersions.get("programmer_agent_count")).toBe(counterVersion);
    expect(world.propOrNull(agent, "features")).toBe("malformed");
    expect(world.exportWorld()).toEqual(before);

    const retry = await humanAgentCall(world, human, "demote_agent_from_programmer", agent, "second");
    expect(retry).toMatchObject({ op: "error", error: { code: "E_TYPE" } });
    expect(world.exportWorld()).toEqual(before);
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
    const before = world.exportWorld();

    const frame = await humanAgentCall(world, human, "revoke_agent", agent, "first");

    expect(frame.op).toBe("error");
    expect((frame as any).error.code).toBe("E_TYPE");
    expect(world.object(agent).flags.programmer).toBe(true);
    expect(world.propOrNull(account, "programmer_agent_count")).toBe(1);
    expect(world.propOrNull(account, "agent_count")).toBe(1);
    expect(world.propOrNull(agent, "deactivated_at")).toBe(null);
    expect(world.propOrNull(agent, "retired_at")).toBe(null);
    expect((world.propOrNull(agent, "api_keys") as Record<string, unknown>)[keyId])
      .toEqual(keyBefore);
    expect(world.exportWorld()).toEqual(before);

    const retry = await humanAgentCall(world, human, "revoke_agent", agent, "second");
    expect(retry).toMatchObject({ op: "error", error: { code: "E_TYPE" } });
    expect(world.exportWorld()).toEqual(before);
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

  it("routes set_actor_flag programmer accounting through the shared transition", async () => {
    const world = createWorld();
    const { human, account } = await provisionHuman(world, "native-flag-shared@woo.dev");
    const agent = await createAgent(world, human, "native-flag-shared", false);

    const promote = await world.directCall(
      "native-set-flag-shared-up",
      "$wiz",
      "$system",
      "set_actor_flag",
      [agent, "programmer", true]
    ) as CallResult;
    expect(promote.op).toBe("result");
    expect(world.object(agent).flags.programmer).toBe(true);
    expect(world.actorHasSurface(agent, "$programmer")).toBe(true);
    expect(world.propOrNull(account, "programmer_agent_count")).toBe(1);

    const demote = await world.directCall(
      "native-set-flag-shared-down",
      "$wiz",
      "$system",
      "set_actor_flag",
      [agent, "programmer", false]
    ) as CallResult;
    expect(demote.op).toBe("result");
    expect(world.object(agent).flags.programmer).toBe(false);
    expect(world.actorHasSurface(agent, "$programmer")).toBe(false);
    expect(world.propOrNull(account, "programmer_agent_count")).toBe(0);

    const audits = world.propOrNull("$system", "wizard_actions") as Array<Record<string, unknown>>;
    expect(audits.filter((entry) => entry.action === "actor_flag_changed")).toEqual([
      expect.objectContaining({ actor: "$wiz", target: agent, flag: "programmer", old: false, new: true }),
      expect.objectContaining({ actor: "$wiz", target: agent, flag: "programmer", old: true, new: false })
    ]);
  });

  it("audits only an actual programmer-surface membership repair", async () => {
    const world = createWorld();
    const { human, account } = await provisionHuman(world, "native-flag-no-surface@woo.dev");
    const agent = await createAgent(world, human, "native-flag-no-surface", false);
    const surface = world.propOrNull("$system", "programmer_surface");
    expect(surface).toBe("$programmer");
    if (typeof surface !== "string") throw new Error("programmer surface fixture missing");
    world.setProp("$system", "programmer_surface", null);

    const promote = await world.directCall(
      "native-set-flag-no-surface-up",
      "$wiz",
      "$system",
      "set_actor_flag",
      [agent, "programmer", true]
    ) as CallResult;
    const repeat = await world.directCall(
      "native-set-flag-no-surface-repeat",
      "$wiz",
      "$system",
      "set_actor_flag",
      [agent, "programmer", true]
    ) as CallResult;

    expect(promote.op).toBe("result");
    expect(repeat.op).toBe("result");
    expect(world.object(agent).flags.programmer).toBe(true);
    expect(world.actorHasSurface(agent, "$programmer")).toBe(false);
    expect(world.propOrNull(account, "programmer_agent_count")).toBe(1);
    let audits = world.propOrNull("$system", "wizard_actions") as Array<Record<string, unknown>>;
    expect(audits.filter((entry) => entry.action === "programmer_surface_repaired")).toEqual([]);

    // Once a surface is genuinely published, the next identical grant heals
    // the aged half-state and records exactly that observed membership change.
    world.setProp("$system", "programmer_surface", surface);
    const repair = await world.directCall(
      "native-set-flag-surface-repair",
      "$wiz",
      "$system",
      "set_actor_flag",
      [agent, "programmer", true]
    ) as CallResult;
    const repairedRepeat = await world.directCall(
      "native-set-flag-surface-repaired-repeat",
      "$wiz",
      "$system",
      "set_actor_flag",
      [agent, "programmer", true]
    ) as CallResult;
    expect(repair.op).toBe("result");
    expect(repairedRepeat.op).toBe("result");
    expect(world.actorHasSurface(agent, "$programmer")).toBe(true);
    expect(world.propOrNull(account, "programmer_agent_count")).toBe(1);
    audits = world.propOrNull("$system", "wizard_actions") as Array<Record<string, unknown>>;
    expect(audits.filter((entry) => entry.action === "programmer_surface_repaired")).toEqual([
      expect.objectContaining({
        actor: "$wiz",
        target: agent,
        surface: "$programmer",
        attached: true,
        transition: false
      })
    ]);
  });

  it("preflights the prospective $agent surface before consuming an object id", async () => {
    let world = createWorld();
    const baseline = createWorld();
    const current = await provisionHuman(world, "native-create-collision@woo.dev");
    const control = await provisionHuman(baseline, "native-create-control@woo.dev");
    const beforeIds = Object.keys(world.state().objects).sort();
    const beforeActors = world.propOrNull(current.account, "actors");
    // Corruption fixtures must enter through a serialized authority boundary:
    // public object views are deliberately detached and cannot poison the live
    // graph. Model the aged bad world, then cold-load it.
    const corrupted = world.exportWorld();
    const surfaceVerb = corrupted.objects
      .find((object) => object.id === "$programmer")
      ?.verbs.find((verb) => verb.name === "eval");
    if (!surfaceVerb) throw new Error("$programmer:eval fixture missing");
    const injectedCollision = { ...structuredClone(surfaceVerb), owner: "$agent" };
    const agentClass = corrupted.objects.find((object) => object.id === "$agent");
    if (!agentClass) throw new Error("$agent fixture missing");
    agentClass.verbs.push(injectedCollision);
    world = createWorldFromSerialized(corrupted);

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

    const healed = world.exportWorld();
    const healedAgentClass = healed.objects.find((object) => object.id === "$agent");
    if (!healedAgentClass) throw new Error("$agent fixture missing after refusal");
    healedAgentClass.verbs = healedAgentClass.verbs.filter(
      (verb) => !(verb.name === injectedCollision.name && verb.owner === "$agent")
    );
    world = createWorldFromSerialized(healed);
    const afterRefusal = await createAgent(world, current.human, "after-refusal", true);
    const withoutRefusal = await createAgent(baseline, control.human, "control", true);
    expect(afterRefusal).toBe(withoutRefusal);
  });

  it("preflights replacement-key routing before revoking the current key", async () => {
    let world = createWorld();
    const { human } = await provisionHuman(world, "native-rotate@woo.dev");
    const agent = await createAgent(world, human, "native-rotate", false);
    const keyId = world.propOrNull(agent, "api_key_id") as string;
    const keyBefore = structuredClone(
      (world.propOrNull(agent, "api_keys") as Record<string, unknown>)[keyId]
    );
    const corrupted = world.exportWorld();
    const agentRow = corrupted.objects.find((object) => object.id === agent);
    if (!agentRow) throw new Error("agent fixture missing");
    agentRow.anchor = "the_chatroom";
    world = createWorldFromSerialized(corrupted);

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
    expect(nativePrimitiveFailureContract("set_actor_flag"))
      .toEqual({ mutation_scope: "single_authority", on_error: "rollback" });
    expect(nativePrimitiveFailureContract("deactivate_actor")?.post_commit)
      .toContain("session-ended transport notification");
    expect(nativePrimitiveFailureContract("rotate_api_key"))
      .toEqual({ mutation_scope: "single_authority", on_error: "rollback" });
    expect(nativePrimitiveContract("catalog_registry_update")?.failure)
      .toEqual({ mutation_scope: "durable_progress", on_error: "idempotent_progress" });
  });

  it("fails closed when a mutating built-in is omitted from handler classification", () => {
    const handlers = new Map(
      nativePrimitiveFailureContractHandlers().map((name) => [
        name,
        name === "return_guest" ? "live_only" as const : "authoritative" as const
      ])
    );
    handlers.delete("set_actor_flag");

    expect(nativePrimitiveContractDisciplineErrors(handlers))
      .toContain("set_actor_flag: failure contract has no built-in handler classification");
  });
});
