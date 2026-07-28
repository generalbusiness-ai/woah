// AP11 operator wizard provisioning — core semantics.
//
// tests/worker/net-provision-wizard.test.ts proves the deployed shape end to
// end; this file pins the parts that are cheaper and clearer to assert against
// a plain in-memory world: the fail-closed idempotency branches (a stale or
// mismatched ledger entry must never become a duplicate identity), quota
// accounting, authority gating, and the local-profile audit trail.
import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import { routedApiKeyId } from "../src/core/api-key-id";
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

  // The quota slot must be returned EXACTLY ONCE by permanent retirement, no
  // matter what tombstoned the actor first. `deactivated_at` cannot carry that
  // fact: it is a reversible AUTH tombstone that `$system:deactivate_actor`
  // sets without touching any counter. Reading it as an accounting fact fails
  // in both directions, so all four orderings are pinned.
  describe("quota-slot accounting across every retirement ordering", () => {
    const revoke = async (world: WooWorld, human: string, agent: string): Promise<unknown> => {
      const frame = await world.directCall(`rev-${Math.random()}`, human, human, "revoke_agent", [agent] as never);
      if (frame.op === "error") throw Object.assign(new Error(frame.error.message), { code: frame.error.code });
      return (frame as unknown as { result: unknown }).result;
    };
    const wizardCall = async (world: WooWorld, verb: string, args: unknown[]): Promise<void> => {
      const frame = await world.directCall(`sys-${Math.random()}`, "$wiz", "$system", verb, args as never);
      if (frame.op === "error") throw Object.assign(new Error(frame.error.message), { code: frame.error.code });
    };
    const audits = (world: WooWorld, action: string): Array<Record<string, unknown>> =>
      wizardActions(world).filter((entry) => entry.action === action);

    it("(1) revoke of a never-deactivated agent returns the slot once and audits", async () => {
      const world = createWorld();
      const { human, account } = await signup(world, "ap11-o1@woo.dev");
      const agent = (await provision(world, "$wiz", human, "ops-1")).actor_id;
      expect(world.propOrNull(account, "agent_count")).toBe(1);

      expect(await revoke(world, human, agent)).toBe(true);
      expect(world.propOrNull(account, "agent_count")).toBe(0);
      expect(world.propOrNull(account, "programmer_agent_count")).toBe(0);
      expect(world.propOrNull(agent, "retired_at")).toBeTruthy();
      expect(world.propOrNull(agent, "deactivated_at")).toBeTruthy();
      expect(audits(world, "agent_revoked")).toHaveLength(1);
    });

    it("(2) deactivate_actor then revoke STILL returns the slot, and audits", async () => {
      // The leak. deactivate_actor tombstones without decrementing, so a guard
      // that treats any tombstone as proof the slot came back strands it
      // forever — the reviewer's probe saw agent_count stay 1 -> 1 -> 1 with no
      // agent_revoked record at all.
      const world = createWorld();
      const { human, account } = await signup(world, "ap11-o2@woo.dev");
      const agent = (await provision(world, "$wiz", human, "ops-1")).actor_id;
      const survivor = (await provision(world, "$wiz", human, "ops-2")).actor_id;
      expect(world.propOrNull(account, "agent_count")).toBe(2);
      expect(world.propOrNull(account, "programmer_agent_count")).toBe(2);

      await wizardCall(world, "deactivate_actor", [agent, "suspected compromise"]);
      // Deactivation alone changes no accounting and does not retire.
      expect(world.propOrNull(account, "agent_count")).toBe(2);
      expect(world.propOrNull(agent, "deactivated_at")).toBeTruthy();
      expect(world.propOrNull(agent, "retired_at")).toBe(null);
      const deactivatedAt = world.propOrNull(agent, "deactivated_at");

      expect(await revoke(world, human, agent)).toBe(true);
      expect(world.propOrNull(account, "agent_count")).toBe(1);
      // The permanent-retirement work that deactivation skipped also happened.
      expect(world.propOrNull(account, "programmer_agent_count")).toBe(1);
      expect(world.object(agent).flags.programmer ?? false).toBe(false);
      expect(world.propOrNull(agent, "retired_at")).toBeTruthy();
      // The auth tombstone keeps its ORIGINAL time; retirement records its own.
      expect(world.propOrNull(agent, "deactivated_at")).toBe(deactivatedAt);
      expect(audits(world, "agent_revoked")).toHaveLength(1);
      // The sibling is untouched throughout.
      expect(world.propOrNull(survivor, "retired_at")).toBe(null);
      expect(world.object(survivor).flags.programmer).toBe(true);
    });

    it("reviewer probe shape: deactivate_actor -> revoke, one agent, 1 -> 1 -> 0", async () => {
      // The reported sequence verbatim: a single agent, where the leak showed
      // as agent_count staying 1 -> 1 -> 1 with no agent_revoked record.
      const world = createWorld();
      const { human, account } = await signup(world, "ap11-probe@woo.dev");
      const agent = (await provision(world, "$wiz", human, "ops-1")).actor_id;
      expect(world.propOrNull(account, "agent_count")).toBe(1);

      await wizardCall(world, "deactivate_actor", [agent, null]);
      expect(world.propOrNull(account, "agent_count")).toBe(1);

      expect(await revoke(world, human, agent)).toBe(true);
      expect(world.propOrNull(account, "agent_count")).toBe(0);
      expect(audits(world, "agent_revoked")).toHaveLength(1);
    });

    it("(3) revoke of an already-revoked agent changes no counter and adds no duplicate audit", async () => {
      const world = createWorld();
      const { human, account } = await signup(world, "ap11-o3@woo.dev");
      const agent = (await provision(world, "$wiz", human, "ops-1")).actor_id;
      const survivor = (await provision(world, "$wiz", human, "ops-2")).actor_id;

      await revoke(world, human, agent);
      const retiredAt = world.propOrNull(agent, "retired_at");
      expect(world.propOrNull(account, "agent_count")).toBe(1);
      expect(audits(world, "agent_revoked")).toHaveLength(1);

      await revoke(world, human, agent);
      await revoke(world, human, agent);
      expect(world.propOrNull(account, "agent_count")).toBe(1);
      expect(world.propOrNull(account, "programmer_agent_count")).toBe(1);
      expect(world.propOrNull(agent, "retired_at")).toBe(retiredAt);
      expect(audits(world, "agent_revoked")).toHaveLength(1);
      expect(world.object(survivor).flags.programmer).toBe(true);

      // The slot really is available exactly once.
      const replacement = await provision(world, "$wiz", human, "ops-3");
      expect(replacement.created).toBe(true);
      expect(world.propOrNull(account, "agent_count")).toBe(2);
    });

    it("a repeat revoke that actually repairs something is audited as a repair", async () => {
      // The spec promises no real retirement work is ever unaudited. A repeat
      // call normally does nothing and records nothing — but if a NEW key was
      // pointed at the retired agent, revoking it is real work and must show up
      // (marked repair, with no counter movement).
      const world = createWorld();
      const { human, account } = await signup(world, "ap11-repair@woo.dev");
      const agent = (await provision(world, "$wiz", human, "ops-1")).actor_id;
      await revoke(world, human, agent);
      expect(audits(world, "agent_revoked")).toHaveLength(1);
      expect(world.propOrNull(account, "agent_count")).toBe(0);

      const strayKey = world.createApiKey("$wiz", agent, "stray");
      world.setProp(agent, "api_key_id", strayKey.id);

      await revoke(world, human, agent);
      const records = audits(world, "agent_revoked");
      expect(records).toHaveLength(2);
      expect(records[1]?.repair).toBe(true);
      // Still no accounting movement.
      expect(world.propOrNull(account, "agent_count")).toBe(0);
      // ...and the stray key is dead.
      const keys = world.propOrNull(agent, "api_keys") as Record<string, Record<string, unknown>>;
      expect(keys[strayKey.id]?.revoked_at).toBeTruthy();

      // A third call now finds nothing left to repair and records nothing.
      await revoke(world, human, agent);
      expect(audits(world, "agent_revoked")).toHaveLength(2);
    });

    it("(4) deactivate then reactivate (no revoke) restores nothing, because nothing was returned", async () => {
      const world = createWorld();
      const { human, account } = await signup(world, "ap11-o4@woo.dev");
      const agent = (await provision(world, "$wiz", human, "ops-1")).actor_id;

      await wizardCall(world, "deactivate_actor", [agent, null]);
      expect(world.propOrNull(account, "agent_count")).toBe(1);
      await wizardCall(world, "reactivate_actor", [agent]);
      // Fully reversible: the slot was never returned, so there is nothing to
      // restore and the counter never moved.
      expect(world.propOrNull(account, "agent_count")).toBe(1);
      expect(world.propOrNull(agent, "deactivated_at")).toBe(null);
      expect(world.propOrNull(agent, "retired_at")).toBe(null);
      expect(audits(world, "agent_revoked")).toHaveLength(0);

      // ...and the agent is usable again, so a later revoke still returns the
      // slot exactly once.
      expect(await revoke(world, human, agent)).toBe(true);
      expect(world.propOrNull(account, "agent_count")).toBe(0);
    });

    it("reactivation of a RETIRED agent is refused (the inverse bypass)", async () => {
      // Symmetry check: without this, reactivating a retired actor produces a
      // live identity whose slot has already been returned — N live agents
      // against a count of N-1.
      const world = createWorld();
      const { human, account } = await signup(world, "ap11-o5@woo.dev");
      const agent = (await provision(world, "$wiz", human, "ops-1")).actor_id;
      await revoke(world, human, agent);
      expect(world.propOrNull(account, "agent_count")).toBe(0);

      await expect(wizardCall(world, "reactivate_actor", [agent])).rejects.toMatchObject({ code: "E_PERM" });
      expect(world.propOrNull(agent, "deactivated_at")).toBeTruthy();
      expect(world.propOrNull(account, "agent_count")).toBe(0);
    });

    it("pre-marker worlds are not double-returned (aged-data inference)", async () => {
      // A world revoked before `retired_at` existed carries the old shape: auth
      // tombstone set AND the agent's current key already revoked, with the
      // counter ALREADY decremented. deactivate_actor never produces that
      // conjunction, so inferring from it keeps the unsafe direction closed.
      const world = createWorld();
      const { human, account } = await signup(world, "ap11-o6@woo.dev");
      const agent = (await provision(world, "$wiz", human, "ops-1")).actor_id;
      const key = world.createApiKey("$wiz", agent, "aged");
      await provision(world, "$wiz", human, "ops-1", { api_key_id: key.id });

      // Reconstruct the pre-marker post-revoke state by hand.
      world.revokeApiKey("$wiz", key.id);
      world.setProp(agent, "deactivated_at", Date.now());
      world.setProp(account, "agent_count", 0);

      await revoke(world, human, agent);
      expect(world.propOrNull(account, "agent_count")).toBe(0);
      expect(audits(world, "agent_revoked")).toHaveLength(0);
      // The marker is backfilled, so the next call needs no inference.
      expect(world.propOrNull(agent, "retired_at")).toBeTruthy();
    });
  });

  it("demoting a non-programmer agent does not double-decrement the programmer count", async () => {
    const world = createWorld();
    const { human, account } = await signup(world, "ap11k@woo.dev");
    const a = await provision(world, "$wiz", human, "ops-a");
    const b = await provision(world, "$wiz", human, "ops-b");
    expect(world.propOrNull(account, "programmer_agent_count")).toBe(2);

    const demote = async (agent: string): Promise<void> => {
      const frame = await world.directCall(`dem-${Math.random()}`, human, human, "demote_agent_from_programmer", [agent] as never);
      if (frame.op === "error") throw Object.assign(new Error(frame.error.message), { code: frame.error.code });
    };

    // The shared transition moves the flag and the counter only on a real
    // transition, so repeats are no-ops rather than a slow drain to zero.
    await demote(a.actor_id);
    expect(world.propOrNull(account, "programmer_agent_count")).toBe(1);
    await demote(a.actor_id);
    await demote(a.actor_id);
    expect(world.propOrNull(account, "programmer_agent_count")).toBe(1);
    expect(world.object(b.actor_id).flags.programmer).toBe(true);
  });

  it("records the api_key_id pointer only after validating it fail-closed", async () => {
    const world = createWorld();
    const { human } = await signup(world, "ap11d@woo.dev");
    const other = await signup(world, "ap11d2@woo.dev");

    const first = await provision(world, "$wiz", human, "ops-1");
    // No key is minted by the primitive: the pointer is null and the agent's
    // own verifier map is untouched until the credential route runs.
    expect(world.propOrNull(first.actor_id, "api_key_id")).toBe(null);
    expect(world.propOrNull(first.actor_id, "api_keys") ?? {}).toEqual({});

    // The pointer is what retirement follows (revoke_agent revokes
    // agent.api_key_id and nothing else), so a pointer naming a key that is not
    // this agent's would leave the REAL credential alive through retirement.
    // Every mismatch axis is refused, and nothing is stored.
    const bogus: Array<[string, string]> = [
      ["not a routed id at all", "plain-key-id"],
      ["routed but bound to another actor", "n1_x_y_z"]
    ];
    for (const [why, id] of bogus) {
      await expect(provision(world, "$wiz", human, "ops-1", { api_key_id: id }), why)
        .rejects.toMatchObject({ code: "E_INVARG" });
      expect(world.propOrNull(first.actor_id, "api_key_id"), why).toBe(null);
    }

    // Correctly shaped for this agent, but with no verifier record installed:
    // still refused, because the runbook installs the credential BEFORE the
    // call that records the pointer.
    const unbacked = routedApiKeyId(human, first.actor_id, "a".repeat(32));
    await expect(provision(world, "$wiz", human, "ops-1", { api_key_id: unbacked }))
      .rejects.toMatchObject({ code: "E_INVARG" });
    expect(world.propOrNull(first.actor_id, "api_key_id")).toBe(null);

    // A real record, but minted for a DIFFERENT actor: the id parses, so only
    // the actor binding catches it.
    const otherAgent = await provision(world, "$wiz", other.human, "ops-other");
    const otherKey = world.createApiKey("$wiz", otherAgent.actor_id, "other");
    await expect(provision(world, "$wiz", human, "ops-1", { api_key_id: otherKey.id }))
      .rejects.toMatchObject({ code: "E_INVARG" });
    expect(world.propOrNull(first.actor_id, "api_key_id")).toBe(null);

    // The valid case: a routed id minted for THIS agent under this authority
    // root, with a live verifier record on the agent itself.
    const key = world.createApiKey("$wiz", first.actor_id, "ops wizard");
    const pointed = await provision(world, "$wiz", human, "ops-1", { api_key_id: key.id });
    expect(pointed.created).toBe(false);
    expect(world.propOrNull(first.actor_id, "api_key_id")).toBe(key.id);

    // A revoked credential is not a valid pointer either — following it at
    // retirement would be a no-op while a live key elsewhere kept working.
    const stale = world.createApiKey("$wiz", first.actor_id, "stale");
    world.revokeApiKey("$wiz", stale.id);
    await expect(provision(world, "$wiz", human, "ops-1", { api_key_id: stale.id }))
      .rejects.toMatchObject({ code: "E_INVARG" });
    expect(world.propOrNull(first.actor_id, "api_key_id")).toBe(key.id);
  });

  it("treats a provision_id that names an Object.prototype member as ordinary text", async () => {
    const world = createWorld();
    const { human, account } = await signup(world, "ap11h@woo.dev");

    // `constructor` passes the operator route's wire grammar; `__proto__` does
    // not, but the primitive is reachable by any wizard and must be correct for
    // both. With inherited-member access these resolve to `function Object()`
    // and to the prototype setter respectively.
    for (const provisionId of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const minted = await provision(world, "$wiz", human, provisionId);
      expect(minted.created, provisionId).toBe(true);
      expect(minted.actor_id, provisionId).toMatch(/^agent_/);
      expect(world.propOrNull(minted.actor_id, "provision_id"), provisionId).toBe(provisionId);

      // And the ledger round-trips: the re-run must find the SAME agent, which
      // it can only do through an own-key read of a stored own property.
      const again = await provision(world, "$wiz", human, provisionId);
      expect(again.actor_id, provisionId).toBe(minted.actor_id);
      expect(again.created, provisionId).toBe(false);
    }
    expect(world.propOrNull(account, "agent_count")).toBe(4);
    const ledger = world.propOrNull(account, "operator_provisioned_agents") as Record<string, string>;
    expect(Object.keys(ledger).sort()).toEqual(["__proto__", "constructor", "hasOwnProperty", "toString"]);
    // Nothing was written onto the prototype chain.
    expect(Object.getPrototypeOf(ledger)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).constructor).toBe(Object);
  });

  it("refuses a provision_id longer than the durable cell should carry", async () => {
    const world = createWorld();
    const { human } = await signup(world, "ap11i@woo.dev");
    await expect(provision(world, "$wiz", human, "x".repeat(129)))
      .rejects.toMatchObject({ code: "E_INVARG" });
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
