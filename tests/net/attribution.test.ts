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
  normalizePrincipal,
  normalizeScopeAttribution,
  OPERATOR_CUSTOMER_ID,
  type AttributionSource
} from "../../src/net/attribution";
import { ScopeSequencer } from "../../src/net/scope";
import { InMemoryScopeStore } from "../../src/net/scope-store";

/** Fixture world: a flat description of actors for the derivation rules. */
function source(fixture: {
  agents?: string[];
  guests?: string[];
  wizards?: string[];
  accounts?: Record<string, string>; // obj -> account id
  owners?: Record<string, string>; // obj -> owner objref
}): AttributionSource {
  return {
    isAgent: (obj) => (fixture.agents ?? []).includes(obj),
    isGuest: (obj) => (fixture.guests ?? []).includes(obj),
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

describe("scope attribution stamping (AU3.3)", () => {
  it("seed stamps meta; later meta rewrites and rehydration preserve it; omitted re-seed keeps the prior stamp", () => {
    const store = new InMemoryScopeStore();
    const stamp = {
      customer: "#acct1",
      derived_via: "anchor_owner",
      stamped_at_epoch: "cat-attr-1"
    } as const;
    const seq = new ScopeSequencer("room:the_room", "cat-attr-1", { durable: store });
    seq.seed([], undefined, stamp);
    expect(seq.scopeAttribution()).toEqual(stamp);
    expect(store.readMeta()?.attribution).toEqual(stamp);

    // A re-seed that omits the field preserves the stamp (legacy-caller
    // posture), and a rehydrated sequencer still carries it.
    seq.seed([]);
    expect(store.readMeta()?.attribution).toEqual(stamp);
    const rehydrated = new ScopeSequencer("room:the_room", "cat-attr-1", { durable: store });
    expect(rehydrated.scopeAttribution()).toEqual(stamp);
  });

  it("normalizeScopeAttribution rejects malformed stamps", () => {
    expect(normalizeScopeAttribution({ customer: "#a", derived_via: "anchor_owner", stamped_at_epoch: "e" }))
      .not.toBeNull();
    expect(normalizeScopeAttribution({ customer: "#a", derived_via: "vibes", stamped_at_epoch: "e" })).toBeNull();
    expect(normalizeScopeAttribution({ customer: "", derived_via: "operator", stamped_at_epoch: "e" })).toBeNull();
    expect(normalizeScopeAttribution({ customer: "#a", derived_via: "operator" })).toBeNull();
  });
});

describe("normalizePrincipal variant rules (AU3.2)", () => {
  const cases: Array<[string, unknown, boolean]> = [
    ["authenticated full", { attribution: "authenticated", customer: "#a", actor: "#h" }, true],
    ["authenticated without customer", { attribution: "authenticated", actor: "#h" }, false],
    ["authenticated without actor", { attribution: "authenticated", customer: "#a" }, false],
    ["credentialed with credential", { attribution: "credentialed", credential: "key1", customer: "#a" }, true],
    ["credentialed WITHOUT credential", { attribution: "credentialed", customer: "#a" }, false],
    ["anonymous bare", { attribution: "anonymous" }, true],
    ["anonymous claiming a customer", { attribution: "anonymous", customer: "#a" }, false],
    ["anonymous claiming an actor", { attribution: "anonymous", actor: "#h" }, false],
    ["unknown attribution", { attribution: "vibes" }, false]
  ];
  for (const [label, value, ok] of cases) {
    it(`${ok ? "accepts" : "rejects"} ${label}`, () => {
      expect(normalizePrincipal(value) !== null).toBe(ok);
    });
  }
});
