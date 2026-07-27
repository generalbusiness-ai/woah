// AP11 operator wizard provisioning — core semantics.
//
// tests/worker/net-provision-wizard.test.ts proves the deployed shape end to
// end; this file pins the parts that are cheaper and clearer to assert against
// a plain in-memory world: the fail-closed idempotency branches (a stale or
// mismatched ledger entry must never become a duplicate identity), quota
// accounting, authority gating, and the local-profile audit trail.
import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import type { WooWorld } from "../src/core/world";

type Provisioned = {
  actor_id: string;
  account: string;
  created: boolean;
  promoted: boolean;
  flagged: boolean;
  agent_count: number;
  agent_quota: number;
  programmer_grant_quota: number;
  programmer_agent_count: number;
  quota_grants: Array<{ kind: string; old: number; new: number }>;
};

async function signup(world: WooWorld, email: string): Promise<{ human: string; account: string }> {
  const start = await world.beginSignup(email, "password123");
  const verify = world.verifySignup(start.verification_token);
  const human = verify.actor as string;
  return { human, account: world.propOrNull(human, "account") as string };
}

async function provision(
  world: WooWorld,
  actor: string,
  human: string,
  provisionId: string,
  options: Record<string, unknown> = {}
): Promise<Provisioned> {
  const frame = await world.directCall(
    `prov-${provisionId}-${Math.random()}`,
    actor,
    human,
    "provision_wizard_agent",
    [provisionId, { name: "OpsWizard", ...options }] as never
  );
  if (frame.op === "error") throw Object.assign(new Error(frame.error.message), { code: frame.error.code });
  return (frame as unknown as { result: Provisioned }).result;
}

function wizardActions(world: WooWorld): Array<Record<string, unknown>> {
  const raw = world.propOrNull("$system", "wizard_actions");
  return Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
}

describe("AP11 operator wizard provisioning (core)", () => {
  it("grants exactly the headroom it consumes and records the local audit trail", async () => {
    const world = createWorld();
    const { human, account } = await signup(world, "ap11a@woo.dev");
    expect(world.propOrNull(account, "programmer_grant_quota")).toBe(0);
    const before = wizardActions(world).length;

    const result = await provision(world, "$wiz", human, "ops-1");

    expect(result.created).toBe(true);
    expect(result.promoted).toBe(true);
    expect(result.flagged).toBe(true);
    expect(world.object(result.actor_id).flags.wizard).toBe(true);
    expect(world.object(result.actor_id).flags.programmer).toBe(true);
    expect(world.object(result.actor_id).owner).toBe(human);
    expect(world.object(result.actor_id).anchor).toBe(human);
    // Located nowhere: the property that lets it plan at its own authority
    // cluster without any placement step.
    expect(world.object(result.actor_id).location).toBe("$nowhere");
    expect(world.propOrNull(result.actor_id, "created_via")).toBe("operator_wizard_provision");
    expect(world.propOrNull(result.actor_id, "provision_id")).toBe("ops-1");
    expect(world.propOrNull(account, "operator_provisioned_agents")).toEqual({ "ops-1": result.actor_id });

    // Only the grant quota needed headroom; agent_quota (default 5) did not.
    expect(result.quota_grants).toEqual([{ kind: "programmer_grant_quota", old: 0, new: 1 }]);
    expect(world.propOrNull(account, "agent_quota")).toBe(5);
    expect(world.propOrNull(account, "programmer_grant_quota")).toBe(1);
    expect(world.propOrNull(account, "agent_count")).toBe(1);
    expect(world.propOrNull(account, "programmer_agent_count")).toBe(1);

    // Local profile materializes the ledger-honest audit sequence. Each quota
    // grant sits immediately before the step that consumes it, so with
    // agent_quota already sufficient the only grant lands just before promote.
    const actions = wizardActions(world).slice(before).map((entry) => entry.action);
    expect(actions).toEqual([
      "actor_provisioned",
      "account_quota_changed",
      "agent_promoted_to_programmer",
      "actor_wizard_flag_set",
      "operator_wizard_agent_provisioned"
    ]);
  });

  it("raises agent_quota only when a mint would exceed it", async () => {
    const world = createWorld();
    const { human, account } = await signup(world, "ap11b@woo.dev");
    world.setProp(account, "agent_quota", 0);

    const result = await provision(world, "$wiz", human, "ops-1");

    expect(result.quota_grants).toEqual([
      { kind: "agent_quota", old: 0, new: 1 },
      { kind: "programmer_grant_quota", old: 0, new: 1 }
    ]);
    expect(world.propOrNull(account, "agent_quota")).toBe(1);
    expect(world.propOrNull(account, "agent_count")).toBe(1);
  });

  it("converges on a re-run and mints a distinct agent per provision_id", async () => {
    const world = createWorld();
    const { human, account } = await signup(world, "ap11c@woo.dev");

    const first = await provision(world, "$wiz", human, "ops-1");
    const before = wizardActions(world).length;
    const again = await provision(world, "$wiz", human, "ops-1");

    expect(again.actor_id).toBe(first.actor_id);
    expect(again.created).toBe(false);
    expect(again.promoted).toBe(false);
    expect(again.flagged).toBe(false);
    expect(again.quota_grants).toEqual([]);
    expect(world.propOrNull(account, "agent_count")).toBe(1);
    expect(world.propOrNull(account, "programmer_agent_count")).toBe(1);
    expect(world.propOrNull(account, "programmer_grant_quota")).toBe(1);
    // A converged re-run records only its own summary — no phantom transition.
    expect(wizardActions(world).slice(before).map((entry) => entry.action))
      .toEqual(["operator_wizard_agent_provisioned"]);

    const second = await provision(world, "$wiz", human, "ops-2");
    expect(second.actor_id).not.toBe(first.actor_id);
    expect(world.propOrNull(account, "agent_count")).toBe(2);
    expect(world.propOrNull(account, "programmer_agent_count")).toBe(2);
    expect(world.propOrNull(account, "programmer_grant_quota")).toBe(2);
    expect(world.propOrNull(account, "operator_provisioned_agents"))
      .toEqual({ "ops-1": first.actor_id, "ops-2": second.actor_id });
  });

  it("records the api_key_id pointer without minting any credential", async () => {
    const world = createWorld();
    const { human } = await signup(world, "ap11d@woo.dev");

    const first = await provision(world, "$wiz", human, "ops-1");
    // No key is minted by the primitive: the pointer is null and the agent's
    // own verifier map is untouched until the credential route runs.
    expect(world.propOrNull(first.actor_id, "api_key_id")).toBe(null);
    expect(world.propOrNull(first.actor_id, "api_keys") ?? {}).toEqual({});

    const pointed = await provision(world, "$wiz", human, "ops-1", { api_key_id: "n1_x_y_z" });
    expect(pointed.created).toBe(false);
    expect(world.propOrNull(first.actor_id, "api_key_id")).toBe("n1_x_y_z");
    expect(world.propOrNull(first.actor_id, "api_keys") ?? {}).toEqual({});
  });

  it("refuses fail-closed rather than minting a duplicate when the ledger disagrees", async () => {
    const world = createWorld();
    const { human, account } = await signup(world, "ap11e@woo.dev");
    const first = await provision(world, "$wiz", human, "ops-1");
    const countsBefore = {
      agents: world.propOrNull(account, "agent_count"),
      programmers: world.propOrNull(account, "programmer_agent_count")
    };

    // (a) The ledger names something that is not an agent at all.
    world.setProp(account, "operator_provisioned_agents", { "ops-1": human });
    await expect(provision(world, "$wiz", human, "ops-1")).rejects.toMatchObject({ code: "E_TYPE" });

    // (b) The ledger names an object that no longer exists.
    world.setProp(account, "operator_provisioned_agents", { "ops-1": "agent_does_not_exist" });
    await expect(provision(world, "$wiz", human, "ops-1")).rejects.toMatchObject({ code: "E_OBJNF" });

    // (c) The named agent exists and is owned, but carries a different token —
    // the reverse pointer is what makes the match unambiguous, and a stale or
    // unwarmed read of it must refuse instead of minting a second identity.
    world.setProp(account, "operator_provisioned_agents", { "ops-1": first.actor_id });
    world.setProp(first.actor_id, "provision_id", "something-else");
    await expect(provision(world, "$wiz", human, "ops-1")).rejects.toMatchObject({ code: "E_INVARG" });

    // (d) A deactivated agent is not reusable; AP11.7 says take a new token.
    world.setProp(first.actor_id, "provision_id", "ops-1");
    world.setProp(first.actor_id, "deactivated_at", Date.now());
    await expect(provision(world, "$wiz", human, "ops-1")).rejects.toMatchObject({ code: "E_PERM" });

    // Nothing was minted by any refusal.
    expect(world.propOrNull(account, "agent_count")).toBe(countsBefore.agents);
    expect(world.propOrNull(account, "programmer_agent_count")).toBe(countsBefore.programmers);
  });

  it("requires wizard authority and a live human account", async () => {
    const world = createWorld();
    const { human, account } = await signup(world, "ap11f@woo.dev");
    const { human: other } = await signup(world, "ap11g@woo.dev");

    // The account owner is not a wizard: self-service cannot escalate itself.
    await expect(provision(world, human, human, "ops-1")).rejects.toMatchObject({ code: "E_PERM" });
    // Nor can another human.
    await expect(provision(world, other, human, "ops-1")).rejects.toMatchObject({ code: "E_PERM" });
    // A non-human target cannot even resolve the verb: it is defined on the
    // human kind, so `$wiz` — the identity this whole op exists to replace —
    // is refused by verb lookup before any authority check.
    await expect(provision(world, "$wiz", "$wiz", "ops-1")).rejects.toMatchObject({ code: "E_VERBNF" });
    // A deactivated account refuses.
    world.setProp(account, "deactivated_at", Date.now());
    await expect(provision(world, "$wiz", human, "ops-1")).rejects.toMatchObject({ code: "E_PERM" });
    expect(world.propOrNull(account, "agent_count")).toBe(0);
  });
});
