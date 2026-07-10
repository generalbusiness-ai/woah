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
import { createWorld } from "../core/bootstrap";
import { DEFAULT_LOCAL_CATALOGS, installLocalCatalogs, localCatalogBundleFingerprint } from "../core/local-catalogs";
import type { WooWorld } from "../core/world";
import { cellsFromSerialized, type NetCellInput } from "./bridge";
import { CATALOG_SCOPE, partitionCells } from "./topology";

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
  /** The built world — callers verify against it (e.g. that an imported
   * apikey authenticates) and mine it for reports. */
  world: WooWorld;
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
  const epoch = netInstallEpoch(catalogs);
  const partitions = partitionCells(cellsFromSerialized(world.exportWorld()));
  if (options.activate !== false) {
    // Pre-verified installs (fixtures, lanes): active from the first seed.
    const catalog = partitions.get(CATALOG_SCOPE) ?? [];
    catalog.push(netActivationCell(epoch));
    partitions.set(CATALOG_SCOPE, catalog);
  }
  return { epoch, partitions, world };
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
