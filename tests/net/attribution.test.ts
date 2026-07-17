/**
 * AU3.1 customer attribution: the closed derivation rule table, the
 * read guard, and the cell-key/partition contract (an attribution cell
 * must land in the actor's own cluster scope).
 */
import { describe, expect, it } from "vitest";
import {
  deriveCustomerAttribution,
  customerOfCellKey,
  GUEST_CUSTOMER_ID,
  normalizeCustomerAttribution,
  OPERATOR_CUSTOMER_ID,
  type AttributionSource
} from "../../src/net/attribution";

/** Fixture world: a flat description of actors for the derivation rules. */
function source(fixture: {
  agents?: string[];
  guests?: string[];
  wizards?: string[];
  accounts?: Record<string, string>; // obj -> account id
  owners?: Record<string, string>; // obj -> owner objref
}): AttributionSource {
  return {
    isa: (obj, ancestor) =>
      (ancestor === "$agent" && (fixture.agents ?? []).includes(obj)) ||
      (ancestor === "$guest" && (fixture.guests ?? []).includes(obj)),
    prop: (obj, name) => (name === "account" ? (fixture.accounts ?? {})[obj] ?? null : null),
    ownerOf: (obj) => (fixture.owners ?? {})[obj] ?? null,
    isWizard: (obj) => (fixture.wizards ?? []).includes(obj)
  };
}

describe("deriveCustomerAttribution (AU3.1 closed rules, in order)", () => {
  it("rule 1: account-bound actor attributes to its account", () => {
    const s = source({ accounts: { "#h1": "#acct1" } });
    expect(deriveCustomerAttribution(s, "#h1")).toEqual({ customer: "#acct1", derived_via: "account" });
  });

  it("rule 1 beats wizardliness: a wizard human with an account is that account's", () => {
    const s = source({ accounts: { "#h1": "#acct1" }, wizards: ["#h1"] });
    expect(deriveCustomerAttribution(s, "#h1")?.customer).toBe("#acct1");
  });

  it("rule 2: human-owned agent attributes through its owner's account", () => {
    const s = source({ agents: ["#a1"], owners: { "#a1": "#h1" }, accounts: { "#h1": "#acct1" } });
    expect(deriveCustomerAttribution(s, "#a1")).toEqual({ customer: "#acct1", derived_via: "agent_owner" });
  });

  it("rule 2: $wiz-owned agent attributes to operator", () => {
    const s = source({ agents: ["#a1"], owners: { "#a1": "$wiz" } });
    expect(deriveCustomerAttribution(s, "#a1")).toEqual({
      customer: OPERATOR_CUSTOMER_ID,
      derived_via: "operator"
    });
  });

  it("rule 2: wizard-flagged-owner agent attributes to operator", () => {
    const s = source({ agents: ["#a1"], owners: { "#a1": "#ops" }, wizards: ["#ops"] });
    expect(deriveCustomerAttribution(s, "#a1")?.customer).toBe(OPERATOR_CUSTOMER_ID);
  });

  it("rule 3: $wiz itself and wizard-flagged actors attribute to operator", () => {
    expect(deriveCustomerAttribution(source({}), "$wiz")?.customer).toBe(OPERATOR_CUSTOMER_ID);
    const s = source({ wizards: ["#w1"] });
    expect(deriveCustomerAttribution(s, "#w1")).toEqual({
      customer: OPERATOR_CUSTOMER_ID,
      derived_via: "operator"
    });
  });

  it("rule 4: unbound guest attributes to the guest customer", () => {
    const s = source({ guests: ["#g1"] });
    expect(deriveCustomerAttribution(s, "#g1")).toEqual({
      customer: GUEST_CUSTOMER_ID,
      derived_via: "guest"
    });
  });

  it("agent with an account-less non-wizard owner falls through to null (named gap)", () => {
    const s = source({ agents: ["#a1"], owners: { "#a1": "#h1" } });
    expect(deriveCustomerAttribution(s, "#a1")).toBeNull();
  });

  it("an uncovered ordinary actor derives null, never a guess", () => {
    expect(deriveCustomerAttribution(source({}), "#stranger")).toBeNull();
  });
});

describe("customerOfCellKey", () => {
  it("is the actor's own property cell (partitions to cluster:<actor>)", () => {
    expect(customerOfCellKey("#a1")).toBe("property_cell:#a1:customer_of");
  });
});

describe("normalizeCustomerAttribution", () => {
  const good = { customer: "#acct1", derived_via: "account" };

  it("accepts a bare attribution and round-trips fields", () => {
    expect(
      normalizeCustomerAttribution({ ...good, team: "#team1", bound_at: 123 })
    ).toEqual({ customer: "#acct1", derived_via: "account", team: "#team1", bound_at: 123 });
  });

  it("unwraps the property-cell payload shape ({value})", () => {
    expect(normalizeCustomerAttribution({ value: good })).toEqual(good);
  });

  const bad: Array<[string, unknown]> = [
    ["null", null],
    ["array", [good]],
    ["empty customer", { customer: "", derived_via: "account" }],
    ["unknown derived_via", { customer: "#a", derived_via: "vibes" }],
    ["missing derived_via", { customer: "#a" }]
  ];
  for (const [label, value] of bad) {
    it(`rejects ${label}`, () => {
      expect(normalizeCustomerAttribution(value)).toBeNull();
    });
  }
});
