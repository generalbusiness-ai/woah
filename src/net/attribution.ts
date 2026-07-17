/**
 * Customer attribution — net-layer surface (audit.md AU3).
 *
 * The derivation rules and the `CustomerAttribution` value live in
 * src/core/attribution.ts (the identity LIFECYCLE writes them, and core
 * cannot import src/net). This module re-exports them and adds the
 * net-only machinery: the attribution CELL addressing, the AU3.2
 * `Principal` envelope, and the AU3.3 `ScopeAttribution` stamp.
 *
 * The `customer_of` cell is an ordinary `property_cell` on the actor,
 * so the anchor walk partitions it to the actor's own cluster scope
 * (the same home as its session cells) and the gateway's existing
 * cluster warm serves it. Writes are identity-pipeline-only: the name
 * is RESERVED below ordinary authoring (world.ts), and the committing
 * sequencer refuses transcript writes to it from non-identity writers.
 */
import { cellKey } from "./cells";

export {
  deriveCustomerAttribution,
  normalizeCustomerAttribution,
  GUEST_CUSTOMER_ID,
  OPERATOR_CUSTOMER_ID,
  PROP_CUSTOMER_OF
} from "../core/attribution";
export type { AttributionSource, CustomerAttribution } from "../core/attribution";

/**
 * The principal envelope (AU3.2): who a turn runs as, stamped ONCE by
 * the gateway at the authentication boundary and never accepted from
 * client input. Discriminated — full attribution is unknowable before
 * successful authentication, and the shape does not pretend otherwise:
 * - `authenticated`: customer + actor are present (a committed turn
 *   only ever carries this form — the sequencer refuses the others);
 * - `credentialed`: the credential was recognized but rejected
 *   (expired/revoked/actor-mismatch) — credential REQUIRED, customer
 *   the customer-of-record for it when known, actor possibly absent;
 * - `anonymous`: unknown or malformed credential — customer and actor
 *   MUST be absent (gateway edge records only).
 */
export type Principal = {
  attribution: "authenticated" | "credentialed" | "anonymous";
  customer?: string;
  team?: string;
  actor?: string;
  session?: string;
  credential?: string;
  on_behalf_of?: string;
};

/** Read guard for carried principals (durable rows, transcripts). The
 * per-variant field rules are enforced here so a semantically malformed
 * principal can never round-trip through a durable carrier. */
export function normalizePrincipal(raw: unknown): Principal | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (v.attribution !== "authenticated" && v.attribution !== "credentialed" && v.attribution !== "anonymous") {
    return null;
  }
  const str = (x: unknown): string | undefined => (typeof x === "string" && x.length > 0 ? x : undefined);
  const out: Principal = { attribution: v.attribution };
  const customer = str(v.customer);
  const actor = str(v.actor);
  const credential = str(v.credential);
  if (customer !== undefined) out.customer = customer;
  if (actor !== undefined) out.actor = actor;
  if (credential !== undefined) out.credential = credential;
  // Variant rules (AU3.2):
  if (v.attribution === "authenticated" && (customer === undefined || actor === undefined)) {
    return null; // authenticated REQUIRES customer + actor
  }
  if (v.attribution === "credentialed" && credential === undefined) {
    return null; // credentialed REQUIRES the credential that was recognized
  }
  if (v.attribution === "anonymous" && (customer !== undefined || actor !== undefined)) {
    return null; // anonymous means exactly that — no attribution claims
  }
  const team = str(v.team);
  const session = str(v.session);
  const onBehalfOf = str(v.on_behalf_of);
  if (team !== undefined) out.team = team;
  if (session !== undefined) out.session = session;
  if (onBehalfOf !== undefined) out.on_behalf_of = onBehalfOf;
  return out;
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
  return cellKey("property_cell", actor, "customer_of");
}
