/**
 * Customer attribution (spec/operations/audit.md AU3.1/AU3.3).
 *
 * "Who is the ultimate owner of this actor" is materialized ONCE, at
 * binding time, as a per-actor `customer_of` property cell — never
 * walked through the identity graph at runtime. The cell is an ordinary
 * `property_cell:<actor>:customer_of`, so the anchor walk partitions it
 * to the actor's own cluster scope (the same home as the actor's
 * session cells), where the gateway's existing cluster warm serves it.
 *
 * Writers (the identity pipeline only): the cutover identity import
 * (src/net/identity.ts), guest provisioning (src/net/guest.ts), and
 * audited ownership-transfer admin actions. Runtime code READS the cell
 * (normalizeCustomerAttribution) and never derives.
 *
 * Layering: pure derivation over a narrow world-view interface — no
 * WooWorld, Host, or platform imports.
 */
import { cellKey } from "./cells";

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
 * WooWorld by the identity import and over fixtures by tests. */
export type AttributionSource = {
  /** Live parent-chain reachability (isa), e.g. isa(actor, "$agent"). */
  isa(obj: string, ancestor: string): boolean;
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
 * ownership hop ($agent.owner is a single principal by AP4.2).
 */
export function deriveCustomerAttribution(
  source: AttributionSource,
  actor: string
): CustomerAttribution | null {
  // Rule 1: actor bound to an account ($human, multi-character players,
  // account-bound service actors).
  const account = accountOf(source, actor);
  if (account) return { customer: account, derived_via: "account" };

  // Rule 2: $agent — attribute through the owning principal.
  if (source.isa(actor, "$agent")) {
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

  // Rule 4: unbound guests.
  if (source.isa(actor, "$guest")) {
    return { customer: GUEST_CUSTOMER_ID, derived_via: "guest" };
  }

  return null;
}

/**
 * Scope-level attribution (AU3.3): the customer owning the scope's
 * anchor, stamped into scope meta at seed/install time — anchor lineage
 * carries an owner OBJREF, not an account, so this must be pre-stamped
 * by the install pipeline (which has the whole graph) and can never be
 * derived by the scope at runtime. Rewritten only by audited
 * ownership-transfer admin actions.
 */
export type ScopeAttribution = {
  customer: string;
  derived_via: "cluster_actor" | "anchor_owner" | "operator" | "transfer";
  stamped_at_epoch: string;
};

/** Read guard for scope meta's attribution value. */
export function normalizeScopeAttribution(raw: unknown): ScopeAttribution | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.customer !== "string" || v.customer.length === 0) return null;
  if (
    v.derived_via !== "cluster_actor" &&
    v.derived_via !== "anchor_owner" &&
    v.derived_via !== "operator" &&
    v.derived_via !== "transfer"
  ) {
    return null;
  }
  if (typeof v.stamped_at_epoch !== "string" || v.stamped_at_epoch.length === 0) return null;
  return { customer: v.customer, derived_via: v.derived_via, stamped_at_epoch: v.stamped_at_epoch };
}

/** Cell key for an actor's attribution: `property_cell:<actor>:customer_of`. */
export function customerOfCellKey(actor: string): string {
  return cellKey("property_cell", actor, PROP_CUSTOMER_OF);
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
