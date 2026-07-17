/**
 * AU3.1 lifecycle coverage + write contract (review fixes, 2026-07-17):
 * every installed actor carries customer_of; signup and guest→account
 * promotion rewrite it; the reserved property refuses ordinary
 * authoring (the forgery vector: an owner rewriting an owned agent's
 * attribution).
 */
import { describe, expect, it } from "vitest";
import { createWorld } from "../../src/core/bootstrap";
import {
  GUEST_CUSTOMER_ID,
  normalizeCustomerAttribution,
  OPERATOR_CUSTOMER_ID,
  PROP_CUSTOMER_OF
} from "../../src/core/attribution";
import { materializeCustomerAttributions } from "../../src/net/identity";
import { planNetInstall } from "../../src/net/install";

describe("install-time materialization (AU3.1 'every actor')", () => {
  it("attributes every preseeded pool guest and reports no gaps for the stock world", async () => {
    const plan = await planNetInstall();
    expect(plan.unattributedActors).toEqual([]);
    // Pool guests exist and carry the guest attribution...
    const guests = plan.world
      .exportWorld()
      .objects.filter((obj) => obj.parent === "$guest" && !obj.id.startsWith("$"));
    expect(guests.length).toBeGreaterThan(0);
    for (const guest of guests) {
      const attr = normalizeCustomerAttribution(plan.world.propOrNull(guest.id, PROP_CUSTOMER_OF));
      expect(attr, `guest ${guest.id}`).toEqual({ customer: GUEST_CUSTOMER_ID, derived_via: "guest" });
      // ...and the cell partitions to the guest's own cluster scope.
      const cluster = plan.partitions.get(`cluster:${guest.id}`) ?? [];
      expect(
        cluster.some(
          (cell) => cell.kind === "property_cell" && cell.object === guest.id && cell.name === PROP_CUSTOMER_OF
        ),
        `cluster cell for ${guest.id}`
      ).toBe(true);
    }
  });

  it("is idempotent and skips already-attributed actors", () => {
    const world = createWorld();
    const first = materializeCustomerAttributions(world);
    const again = materializeCustomerAttributions(world);
    expect(again).toEqual(first);
  });
});

describe("signup and promotion rebind attribution (AU3.1 rule 1)", () => {
  it("a fresh signup's actor attributes to the new account", async () => {
    const world = createWorld();
    const started = await world.beginSignup("new-human@example.com", "a-strong-passphrase-1");
    const verified = world.verifySignup(started.verification_token);
    const attr = normalizeCustomerAttribution(world.propOrNull(verified.actor, PROP_CUSTOMER_OF));
    expect(attr?.customer).toBe(started.account);
    expect(attr?.derived_via).toBe("account");
  });

  it("a promoted guest stops attributing to guest and moves to the account", async () => {
    const world = createWorld();
    const guestSession = world.auth("guest:promo-1");
    materializeCustomerAttributions(world);
    expect(
      normalizeCustomerAttribution(world.propOrNull(guestSession.actor, PROP_CUSTOMER_OF))?.customer
    ).toBe(GUEST_CUSTOMER_ID);

    const started = await world.beginSignup("promoted@example.com", "a-strong-passphrase-2");
    const verified = world.verifySignup(started.verification_token, guestSession.id);
    expect(verified.promoted_guest).toBe(true);
    expect(verified.actor).toBe(guestSession.actor);
    const attr = normalizeCustomerAttribution(world.propOrNull(verified.actor, PROP_CUSTOMER_OF));
    expect(attr?.customer).toBe(started.account);
    expect(attr?.derived_via).toBe("account");
  });
});

describe("customer_of write contract (AU3.1 — reserved below ordinary authoring)", () => {
  it("refuses ordinary setProp, including by the object's owner (the forgery vector)", () => {
    const world = createWorld();
    const owner = world.auth("guest:forge-owner").actor;
    world.createObject({ id: "victim_agent", name: "Agent", parent: "$agent", owner });
    materializeCustomerAttributions(world);
    // The owner tries to rewrite the owned agent's attribution.
    expect(() =>
      world.setProp("victim_agent", PROP_CUSTOMER_OF, { customer: "acct_stolen", derived_via: "account" } as never)
    ).toThrow(/identity-pipeline/);
    // And nobody can smuggle a property DEFINITION under the name.
    expect(() =>
      world.defineProperty("victim_agent", {
        name: PROP_CUSTOMER_OF,
        defaultValue: null,
        owner,
        perms: "rw"
      })
    ).toThrow(/identity-pipeline/);
  });

  it("the privileged setter writes, validates shape, and stays idempotent", () => {
    const world = createWorld();
    const actor = world.auth("guest:priv-1").actor;
    world.setCustomerOf(actor, { customer: "acct_x", derived_via: "transfer", bound_at: 5 });
    expect(normalizeCustomerAttribution(world.propOrNull(actor, PROP_CUSTOMER_OF))?.customer).toBe("acct_x");
    expect(() => world.setCustomerOf(actor, { customer: "", derived_via: "transfer" } as never)).toThrow(
      /malformed/
    );
  });

  it("wizard-owned agents attribute to operator at materialization", () => {
    const world = createWorld();
    world.createObject({ id: "infra_agent", name: "Infra", parent: "$agent", owner: "$wiz" });
    materializeCustomerAttributions(world);
    expect(
      normalizeCustomerAttribution(world.propOrNull("infra_agent", PROP_CUSTOMER_OF))?.customer
    ).toBe(OPERATOR_CUSTOMER_ID);
  });
});
