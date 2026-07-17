/**
 * Customer attribution derivation (spec/operations/audit.md AU3.1).
 *
 * Lives in core because the IDENTITY LIFECYCLE writes it: account
 * binding (signup/promotion), actor provisioning, guest minting, and
 * the identity import all derive an actor's ultimate owner AT BINDING
 * TIME and store it as the reserved `customer_of` property. Runtime
 * code (gateways, scopes) only READS the materialized value — never
 * walks the ownership graph. The net layer re-exports these and adds
 * the cell/principal machinery (src/net/attribution.ts).
 *
 * `customer_of` is a RESERVED property: ordinary authoring and verb
 * writes are refused below the permission system (world.ts
 * assertOrdinaryPropertyName); the only writers are the identity
 * pipeline's privileged setter (world.setCustomerOf) and the net guest
 * mint's transcript write, which the committing sequencer verifies
 * against the identity-writer allow-list.
 */

/** Distinguished customer id for operator-owned activity (AU3.1 rule 3,
 * AU5 operator partition). */
export const OPERATOR_CUSTOMER_ID = "operator";
/** Distinguished attribution for unbound guests (AU3.1 rule 4); routed
 * to the operator partition until the actor binds to an account. */
export const GUEST_CUSTOMER_ID = "guest";
/** The reserved per-actor property name. */
export const PROP_CUSTOMER_OF = "customer_of";

export type CustomerAttribution = {
  /** Account id, or a distinguished id (`operator` / `guest`). */
  customer: string;
  /** Owning team at binding time, if any (identity/teams.md). */
  team?: string;
  /** Which AU3.1 rule produced this value. */
  derived_via: "account" | "agent_owner" | "operator" | "guest" | "transfer";
  /** Producer clock at binding, ms — absent for import-derived cells
   * (the import pipeline has no authoritative clock). */
  bound_at?: number;
};

/** The narrow world view the derivation rules read. Implemented over
 * WooWorld by the identity pipeline and over fixtures by tests. */
export type AttributionSource = {
  /** Is the object an agent-classed actor (AP4.2)? Class-name knowledge
   * stays with the implementer (world.attributionSource / fixtures) so
   * this module holds no catalog or seed class names (layering guard). */
  isAgent(obj: string): boolean;
  /** Is the object an unbound guest-classed actor? */
  isGuest(obj: string): boolean;
  /** Property value or null (world.propOrNull). */
  prop(obj: string, name: string): unknown;
  /** The object's owner field (an objref), or null when unresolvable. */
  ownerOf(obj: string): string | null;
  /** flags.wizard === true. */
  isWizard(obj: string): boolean;
};

function accountOf(source: AttributionSource, obj: string): string | null {
  const account = source.prop(obj, "account");
  return typeof account === "string" && account.length > 0 ? account : null;
}

/**
 * The closed AU3.1 derivation rules, applied in order. Returns null for
 * an actor no rule covers — the caller's policy decides (the import
 * reports it; record minting later surfaces `unattributed` to the
 * operator partition). Never throws, never walks more than one
 * ownership hop (an agent's owner is a single principal by AP4.2).
 */
export function deriveCustomerAttribution(
  source: AttributionSource,
  actor: string
): CustomerAttribution | null {
  // Rule 1: actor bound to an account (humans, multi-character players,
  // account-bound service actors).
  const account = accountOf(source, actor);
  if (account) return { customer: account, derived_via: "account" };

  // Rule 2: agent-classed actors attribute through the owning principal.
  if (source.isAgent(actor)) {
    const owner = source.ownerOf(actor);
    if (owner !== null) {
      if (owner === "$wiz" || source.isWizard(owner)) {
        return { customer: OPERATOR_CUSTOMER_ID, derived_via: "operator" };
      }
      const ownerAccount = accountOf(source, owner);
      if (ownerAccount) return { customer: ownerAccount, derived_via: "agent_owner" };
    }
    // An agent with an unattributable owner falls through: rules 3/4
    // can still catch a wizard-flagged or guest-classed agent, and an
    // uncovered one is the named pipeline bug, not a silent guess.
  }

  // Rule 3: wizard/operator actors.
  if (actor === "$wiz" || source.isWizard(actor)) {
    return { customer: OPERATOR_CUSTOMER_ID, derived_via: "operator" };
  }

  // Rule 4: unbound guests. Ordered BEFORE the generic owner walk —
  // pool guests are $wiz-owned and must stay guest-attributed, not
  // operator-attributed.
  if (source.isGuest(actor)) {
    return { customer: GUEST_CUSTOMER_ID, derived_via: "guest" };
  }

  // Rule 5: any remaining actor attributes through its owner, one hop —
  // the same walk rule 2 applies to agents, generalized. The canonical
  // case is catalog-seeded ACTING APPLIANCES (weather panels, horoscope
  // machines): actor-classed world furniture that is neither agent nor
  // guest, and not itself wizard-flagged. Wizard-owned → operator;
  // an owner bound to an account → that account (a player's homebuilt
  // acting appliance is their business). Self-owned actors fall through
  // — there is nobody else to attribute to.
  const owner = source.ownerOf(actor);
  if (owner !== null && owner !== actor) {
    if (owner === "$wiz" || source.isWizard(owner)) {
      return { customer: OPERATOR_CUSTOMER_ID, derived_via: "operator" };
    }
    const ownerAccount = accountOf(source, owner);
    if (ownerAccount) return { customer: ownerAccount, derived_via: "agent_owner" };
  }

  return null;
}

/**
 * Read guard for the cell/prop value (the runtime never trusts shape).
 * Accepts the canonical property-cell payload (`{value: attribution}`)
 * or the bare attribution (the world-side prop value); returns null on
 * anything else.
 */
export function normalizeCustomerAttribution(raw: unknown): CustomerAttribution | null {
  let value = raw;
  if (value !== null && typeof value === "object" && !Array.isArray(value) && "value" in (value as object)) {
    value = (value as { value: unknown }).value;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.customer !== "string" || v.customer.length === 0) return null;
  if (
    v.derived_via !== "account" &&
    v.derived_via !== "agent_owner" &&
    v.derived_via !== "operator" &&
    v.derived_via !== "guest" &&
    v.derived_via !== "transfer"
  ) {
    return null;
  }
  const out: CustomerAttribution = { customer: v.customer, derived_via: v.derived_via };
  if (typeof v.team === "string" && v.team.length > 0) out.team = v.team;
  if (typeof v.bound_at === "number" && Number.isFinite(v.bound_at)) out.bound_at = v.bound_at;
  return out;
}
