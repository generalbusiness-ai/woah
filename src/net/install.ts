/**
 * Net world install (cutover plan item A —
 * notes/2026-07-08-net-cutover-tooling-plan.md; protocol source
 * notes/2026-07-04-simplest-system-plan.md "Phase 5").
 *
 * Installing a world into a fresh net namespace is: build the SAME world
 * any environment boots (bundled bootstrap + the local catalog set),
 * optionally graft the carried identity (item B) BEFORE export so it
 * partitions like any other world state, then split the exported cells by
 * CO15 topology — one `/net/seed` per scope. This module is the pure,
 * transport-free half: it plans the install; the ferry (the
 * `/net-install` doorway and scripts/net-install.ts) moves it.
 *
 * Idempotence (the migration rule): the install EPOCH is derived from the
 * catalog bundle fingerprint, so re-running the same bundle re-seeds at
 * the SAME epoch — the scope's M9 seed guard makes that a no-op-shaped
 * success — while a different bundle produces a different epoch and the
 * scopes refuse rather than silently mixing worlds. (Deliberate
 * limitation, documented: the bootstrap snapshot is not part of the
 * fingerprint — a substrate-only change with an identical catalog set
 * keeps the epoch. A reinstall over such a change is a fresh-namespace
 * decision, not a re-seed.)
 */
import { createWorld, GUEST_RESET_NATIVE } from "../core/bootstrap";
import {
  normalizeCustomerAttribution,
  OPERATOR_CUSTOMER_ID,
  PROP_CUSTOMER_OF,
  type ScopeAttribution
} from "./attribution";
import { DEFAULT_LOCAL_CATALOGS, installLocalCatalogs, localCatalogBundleFingerprint } from "../core/local-catalogs";
import type { WooWorld } from "../core/world";
import { cellsFromSerialized, type NetCellInput } from "./bridge";
import { materializeCustomerAttributions } from "./identity";
import { CATALOG_SCOPE, classifierFromLineage, partitionCells, type AnchorLineage } from "./topology";
import type { RelationRow } from "./relations";

/**
 * The activation barrier (cutover state machine — spec/operations/
 * net-cutover.md): a namespace is INSTALLING until the catalog authority
 * publishes the fully-verified install epoch in this cell, and the
 * gateway refuses ALL client traffic until then (E_NOT_INSTALLED,
 * reason `not_active`). E_NOT_INSTALLED alone only guards a fully-unseeded
 * namespace; this cell is what makes a PARTIALLY seeded or mixed-epoch
 * namespace equally unobservable. The production installer seeds it LAST,
 * after every scope head and the carried credential verify; test fixtures
 * seed it with the catalog partition (they install pre-verified worlds).
 */
export const NET_ACTIVE_EPOCH_PROP = "net_active_epoch";

/** The one-cell activation seed. `epoch === null` DEACTIVATES — the
 * installer's compensation when post-activation credential verification
 * fails (safe pre-traffic: activation always precedes the route switch). */
export function netActivationCell(epoch: string | null): NetCellInput {
  return { kind: "property_cell", object: "$system", name: NET_ACTIVE_EPOCH_PROP, value: { value: epoch } };
}

export type NetInstallPlan = {
  /** The install epoch every scope seeds at (`cat-<bundle fingerprint>`). */
  epoch: string;
  /** CO15 partition: scope name → the cells it anchors. */
  partitions: Map<string, NetCellInput[]>;
  /** Initial derived contents rows, partitioned by the LOCATION owner's
   * scope. These cannot be reconstructed one seed partition at a time:
   * self-hosted spaces such as the pinboard own their live cell while their
   * containing room owns the corresponding contents row. */
  relations: Map<string, RelationRow[]>;
  /** The built world — callers verify against it (e.g. that an imported
   * apikey authenticates) and mine it for reports. */
  world: WooWorld;
  /** AU3.3 per-scope owning customer, resolved from the anchor owner's
   * `customer_of` while the whole graph is in hand. Scopes with an
   * unattributable anchor owner are ABSENT (unstamped), never guessed. */
  attributions: Map<string, ScopeAttribution>;
  /** AU3.1 named gaps: live actors no derivation rule covers. Installers
   * surface these; they are never silently attributed. */
  unattributedActors: string[];
};

export type NetInstallOptions = {
  /** Catalog names to install (default: the full bundled set — the same
   * list the deployed v2 worker auto-installs). */
  catalogs?: readonly string[];
  /** Item-B hook: applied to the built world BEFORE export, so carried
   * identity partitions and seeds like any other world state — no second
   * seed pass, no ref rewriting. Must throw on any dangling ref (the
   * import verification rule). Async because rehoming an adopted stock
   * actor goes through the world's move chain. */
  graft?: (world: WooWorld) => unknown | Promise<unknown>;
  /** Whether the plan includes the activation cell in the catalog
   * partition (default true — fixtures and lanes install pre-verified
   * worlds and want an immediately usable namespace). The PRODUCTION
   * installer passes false and seeds `netActivationCell` as a separate
   * final step, after all verification passes. */
  activate?: boolean;
};

/** The deterministic install epoch for a catalog bundle. */
export function netInstallEpoch(catalogs: readonly string[] = DEFAULT_LOCAL_CATALOGS): string {
  return `cat-${localCatalogBundleFingerprint(catalogs).slice(0, 16)}`;
}

/**
 * Build the install plan: bootstrapped world + catalogs (+ grafted
 * identity), exported and partitioned. Pure and in-process — no network,
 * no environment reads; the same call serves the vitest proof, the dev
 * lane, and the production cutover run.
 */
export async function planNetInstall(options: NetInstallOptions = {}): Promise<NetInstallPlan> {
  const catalogs = options.catalogs ?? DEFAULT_LOCAL_CATALOGS;
  const world = createWorld();
  // Fail-closed catalog health: a fresh install that cannot bring every
  // catalog to a completed schema plan / version migration must ABORT
  // the plan — an inactive namespace is recoverable; a half-migrated
  // active one is not. (Deployed-world boot repair keeps warn-only —
  // a booting world must come up.)
  installLocalCatalogs(world, catalogs, { failClosed: true });
  if (options.graft) await options.graft(world);
  normalizeAnchors(world);
  seedGuestPool(world);
  // AU3.1 "every actor": the lifecycle writers (import, provisioning,
  // guest mint) cover actors THEY create; the preseeded pool and any
  // catalog-seeded actors are attributed here, before the world image
  // is partitioned — so no installed world ships an actor without its
  // customer_of cell unless no derivation rule covers it (reported).
  const unattributedActors = materializeCustomerAttributions(world);
  const epoch = netInstallEpoch(catalogs);
  const cells = cellsFromSerialized(world.exportWorld());
  const partitions = partitionCells(cells);
  const relations = partitionInstallRelations(cells);
  if (options.activate !== false) {
    // Pre-verified installs (fixtures, lanes): active from the first seed.
    const catalog = partitions.get(CATALOG_SCOPE) ?? [];
    catalog.push(netActivationCell(epoch));
    partitions.set(CATALOG_SCOPE, catalog);
  }
  const attributions = deriveScopeAttributions(world, [...partitions.keys()], epoch);
  return { epoch, partitions, relations, world, attributions, unattributedActors };
}

/**
 * AU3.3: compute each scope's owning customer while the whole graph is
 * in hand — anchor lineage only carries an owner OBJREF, so this is the
 * one place the objref → customer resolution may happen. Scopes whose
 * anchor owner has no `customer_of` stay UNSTAMPED (absent from the
 * map): record minting later attributes them to the operator and flags
 * them, per the spec — the installer never guesses.
 */
export function deriveScopeAttributions(
  world: WooWorld,
  scopes: readonly string[],
  epoch: string
): Map<string, ScopeAttribution> {
  const attributions = new Map<string, ScopeAttribution>();
  const customerOf = (obj: string): ReturnType<typeof normalizeCustomerAttribution> => {
    try {
      return normalizeCustomerAttribution(world.propOrNull(obj, PROP_CUSTOMER_OF));
    } catch {
      return null;
    }
  };
  const isWizard = (obj: string): boolean => {
    try {
      return obj === "$wiz" || world.object(obj).flags.wizard === true;
    } catch {
      return false;
    }
  };
  for (const scope of scopes) {
    if (scope === CATALOG_SCOPE) {
      // The shared substrate is the operator's by definition.
      attributions.set(scope, { customer: OPERATOR_CUSTOMER_ID, derived_via: "operator", stamped_at_epoch: epoch });
      continue;
    }
    if (scope.startsWith("cluster:")) {
      const actor = scope.slice("cluster:".length);
      const attr = customerOf(actor);
      if (attr) {
        attributions.set(scope, { customer: attr.customer, derived_via: "cluster_actor", stamped_at_epoch: epoch });
      } else if (isWizard(actor)) {
        attributions.set(scope, { customer: OPERATOR_CUSTOMER_ID, derived_via: "operator", stamped_at_epoch: epoch });
      }
      continue;
    }
    if (scope.startsWith("room:")) {
      const space = scope.slice("room:".length);
      let owner: string | null = null;
      try {
        owner = world.object(space).owner;
      } catch {
        owner = null;
      }
      if (owner === null) continue;
      if (isWizard(owner)) {
        attributions.set(scope, { customer: OPERATOR_CUSTOMER_ID, derived_via: "operator", stamped_at_epoch: epoch });
        continue;
      }
      const attr = customerOf(owner);
      if (attr) {
        attributions.set(scope, { customer: attr.customer, derived_via: "anchor_owner", stamped_at_epoch: epoch });
      }
      continue;
    }
  }
  return attributions;
}

/** Derive the install-time `contents` family from the complete world image and
 * route each row by its OWNER's CO15 scope. This is intentionally a whole-
 * install operation: doing it inside individual scope seeds loses cross-scope
 * facts such as `the_pinboard` living on `the_deck`. */
export function partitionInstallRelations(cells: readonly NetCellInput[]): Map<string, RelationRow[]> {
  const lineage = new Map<string, AnchorLineage>();
  for (const cell of cells) {
    if (cell.kind === "object_lineage") lineage.set(cell.object, cell.value as AnchorLineage);
  }
  const classifier = classifierFromLineage((object) => lineage.get(object) ?? null);
  const out = new Map<string, RelationRow[]>();
  for (const cell of cells) {
    if (cell.kind !== "object_live") continue;
    const location = (cell.value as { location?: unknown } | null)?.location;
    if (typeof location !== "string" || !location || location === "$nowhere") continue;
    const scope = classifier.scopeOf(location);
    const rows = out.get(scope) ?? [];
    rows.push({
      relation: "contents",
      owner: location,
      member: cell.object,
      member_scope: classifier.scopeOf(cell.object)
    });
    out.set(scope, rows);
  }
  for (const rows of out.values()) rows.sort((a, b) => `${a.owner}\0${a.member}`.localeCompare(`${b.owner}\0${b.member}`));
  return out;
}

/**
 * Identity-door guest pool: `$system.guest_pool` lists the claimable
 * anonymous actors — every live `$guest`-descended instance NOT bound to
 * an account (an adopted carried identity is somebody's, never a pool
 * seat). The gateway's `/net-api/guest` reads this CELL (catalog data
 * driving behavior — the layering rule: the gateway never hardcodes
 * world names) and claims a seat with an exclusive mint. Seeded at
 * install because the pool is a property of the installed WORLD;
 * deterministic (sorted) and idempotent. The pool is the reuse-first
 * tier; `$system.guest_template` lets the net door provision a fresh
 * owner-sequenced actor when every installed seat is occupied.
 */
function seedGuestPool(world: WooWorld): void {
  const serialized = world.exportWorld();
  const objects = new Map(serialized.objects.map((obj) => [obj.id, obj]));
  const reachesGuestClass = (id: string): boolean => {
    let current: string | null | undefined = objects.get(id)?.parent;
    const guard = new Set<string>([id]);
    while (current && !guard.has(current)) {
      if (current === "$guest") return true;
      guard.add(current);
      current = objects.get(current)?.parent;
    }
    return false;
  };
  // A pool seat must be genuinely ANONYMOUS: an account-bound guest is a
  // human's carried identity, and an apikey-bound one is an agent's —
  // neither may be handed out at the door.
  const apiKeysRaw = world.propOrNull("$system", "api_keys");
  const apiKeyActors = new Set<string>();
  if (apiKeysRaw && typeof apiKeysRaw === "object" && !Array.isArray(apiKeysRaw)) {
    for (const record of Object.values(apiKeysRaw as Record<string, unknown>)) {
      const actor = (record as { actor?: unknown } | null)?.actor;
      if (typeof actor === "string") apiKeyActors.add(actor);
    }
  }
  const pool = serialized.objects
    .filter((obj) => !obj.id.startsWith("$") && reachesGuestClass(obj.id))
    .filter((obj) => {
      if (apiKeyActors.has(obj.id)) return false;
      const account = obj.properties?.find(([name]) => name === "account")?.[1];
      return typeof account !== "string" || account.length === 0;
    })
    .map((obj) => obj.id)
    .sort();
  world.setProp("$system", "guest_pool", pool as never);
  // v2 parity: placeAllocatedGuest moves a fresh guest into
  // `$system.guest_initial_room` at auth time. The net door mints the
  // session at the actor's LIVE location, so pool seats are placed once
  // at install instead — a claimed guest's session is then born present
  // in the start room (placeless sessions miss every observation until
  // their first move). Idempotent: only $nowhere seats move.
  const startRaw = world.propOrNull("$system", "guest_initial_room");
  const start = typeof startRaw === "string" && startRaw.length > 0 && objects.has(startRaw) ? startRaw : null;
  if (start !== null) {
    for (const id of pool) {
      const location = objects.get(id)?.location ?? null;
      if (location === null || location === "$nowhere") world.moveObject(id, start);
    }
  }
  // Elastic guest creation remains catalog-data-driven: the gateway
  // consumes this template and never embeds $guest/$wiz/start-room
  // identities. The created actor and its session still commit at the
  // actor's fresh cluster sequencer (see guest.ts).
  const exemplar = pool.length > 0 ? objects.get(pool[0]) : undefined;
  if (exemplar && typeof exemplar.parent === "string" && start !== null) {
    const home = exemplar.properties?.find(([name]) => name === "home")?.[1];
    // Discover the reset page by its intrinsic native primitive. The template
    // records the world identities and verb word consumed by the Net door, so
    // admission remains data-driven if a deployment uses another guest class,
    // maintenance principal, or reset verb name.
    const reset = world.object(exemplar.parent).verbs.find((verb) => verb.kind === "native" && verb.native === GUEST_RESET_NATIVE);
    if (!reset) throw new Error(`guest template exemplar ${exemplar.id} has no ${GUEST_RESET_NATIVE} reset contract`);
    world.setProp("$system", "guest_template", {
      version: 2,
      parent: exemplar.parent,
      owner: exemplar.owner,
      description: "Temporary guest identity.",
      home: typeof home === "string" ? home : "$nowhere",
      initial_room: start,
      reset_definer: exemplar.parent,
      reset_verb: reset.name,
      maintenance_principal: reset.owner
    } as never);
  }
}

/**
 * CO15 anchor normalization — healing the named seed-data debt at the
 * ONE boundary where a world enters net topology. topology.ts documents
 * that anchorless instances classify to the CATALOG scope and calls the
 * bundled catalogs' missing anchors "seed-data debt, not a topology
 * gap": an un-anchored mug would make `take` COMMIT AT THE CATALOG
 * SCOPE — user state in the shared substrate, fanned to an audience
 * where nobody is present. The heal: every non-class instance that
 * carries a location but no anchor is anchored WHERE IT SITS (a room
 * member to its room, a carried item to its carrier — anchor chains
 * root through either). Deterministic and idempotent; classes and
 * genuinely place-less objects are untouched.
 */
function normalizeAnchors(world: WooWorld): void {
  const serialized = world.exportWorld();
  const objects = new Map(serialized.objects.map((obj) => [obj.id, obj]));
  const reachesClass = (id: string, marker: string): boolean => {
    let current: string | null | undefined = id;
    const guard = new Set<string>();
    while (current && !guard.has(current)) {
      if (current === marker) return true;
      guard.add(current);
      current = objects.get(current)?.parent;
    }
    return false;
  };
  for (const obj of serialized.objects) {
    if (obj.id.startsWith("$")) continue; // classes/substrate: catalog by design
    if (obj.anchor !== null || obj.location === null || obj.location === "$nowhere") continue;
    // Actors stay anchorless BY DESIGN: an anchorless actor classifies to
    // its own private cluster (CO14 — the session authority), which is
    // the model, not the debt.
    if (reachesClass(obj.id, "$actor")) continue;
    // Spaces stay anchorless BY DESIGN too: an anchorless space-classed
    // root classifies to its OWN `room:<id>` sequencer (the CO15 class
    // walk) — which is also what makes it DISCOVERABLE: the gateway's
    // missing-object repair probes the `room:<object>` naming convention.
    // Anchoring a nested space (the pinboard sits IN the deck) would
    // demote a sequencer root into a rider of its container, and a turn
    // addressed to it from anywhere but that container loops
    // E_MISSING_STATE → E_BUDGET (phase iii found exactly this: the SPA's
    // tab teleport into the pinboard from the chatroom).
    if (reachesClass(obj.id, "$space")) continue;
    world.object(obj.id).anchor = obj.location;
  }
}
