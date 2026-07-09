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
import { partitionCells } from "./topology";

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
  installLocalCatalogs(world, catalogs);
  if (options.graft) await options.graft(world);
  normalizeAnchors(world);
  const partitions = partitionCells(cellsFromSerialized(world.exportWorld()));
  return { epoch: netInstallEpoch(catalogs), partitions, world };
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
  const reachesActor = (id: string): boolean => {
    let current: string | null | undefined = id;
    const guard = new Set<string>();
    while (current && !guard.has(current)) {
      if (current === "$actor") return true;
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
    if (reachesActor(obj.id)) continue;
    world.object(obj.id).anchor = obj.location;
  }
}
