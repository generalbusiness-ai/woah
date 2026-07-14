// Outliner v1 -> v2 data migration (catalogs/outliner/migration-v1-to-v2.json).
//
// v1 stored tree shape in per-item `.parent` + dense `.position`; v2 makes the
// room-owned ordered-edge index (`__ordered_edge` = { parent, rank }) the sole
// structural authority. The migration derives each item's edge from its legacy
// (parent, position) — grouping siblings by (containing outliner, parent),
// ordering by (position, then item id) — assigns fractional ranks, and drops
// the legacy props. These tests exercise the REAL migration file against an
// aged v1 world (nested items, duplicate positions to force the id tie-break,
// two outliners to prove per-container grouping), on a local SQLite woo per the
// AGENTS.md migration discipline, and assert the four validations + idempotency.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import { installCatalogManifest, updateCatalogManifest, type CatalogManifest } from "../src/core/catalog-installer";
import { installLocalCatalogs } from "../src/core/local-catalogs";
import { LocalSQLiteRepository } from "../src/server/sqlite-repository";

const catalogsRoot = join(__dirname, "..", "catalogs");
function readMigration(): NonNullable<Parameters<typeof updateCatalogManifest>[2]>["migration"] {
  return JSON.parse(readFileSync(join(catalogsRoot, "outliner", "migration-v1-to-v2.json"), "utf8"));
}
function tempDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "woo-outliner-mig-"));
  return { dir, path: join(dir, "world.sqlite") };
}

// Minimal self-contained v1/v2 manifests with the REAL class names, so the
// bundled migration file (which references $outline_item) applies unchanged.
const V1: CatalogManifest = {
  name: "outliner", version: "1.0.1", spec_version: "v1", license: "MIT", depends: [],
  classes: [
    { local_name: "$outliner", parent: "$thing", properties: [] },
    {
      local_name: "$outline_item", parent: "$thing",
      properties: [
        { name: "parent", type: "obj|null", default: null, perms: "r" },
        { name: "position", type: "int", default: 0, perms: "r" }
      ]
    }
  ]
} as unknown as CatalogManifest;

const V2: CatalogManifest = {
  name: "outliner", version: "2.0.0", spec_version: "v1", license: "MIT", depends: [],
  classes: [
    { local_name: "$outliner", parent: "$thing", properties: [] },
    {
      local_name: "$outline_item", parent: "$thing",
      properties: [{ name: "__ordered_edge", type: "map|null", default: null, perms: "r" }]
    }
  ]
} as unknown as CatalogManifest;

type Item = { id: string; parent: string | null; position: number; container: string };

// The aged v1 fixture. Two outliners; `mo` has a duplicate top-level position
// (it_b, it_c both position 1) to force the id tie-break, and a nested pair
// under it_b (also duplicate position). Expected order (position, then id):
//   mo  roots: it_b(1), it_c(1), it_a(2)
//   mo  it_b children: it_x(1), it_y(1)
//   mo2 roots: it_m(1), it_n(2)
const AGED: Item[] = [
  { id: "it_a", parent: null, position: 2, container: "mo" },
  { id: "it_b", parent: null, position: 1, container: "mo" },
  { id: "it_c", parent: null, position: 1, container: "mo" },
  { id: "it_x", parent: "it_b", position: 1, container: "mo" },
  { id: "it_y", parent: "it_b", position: 1, container: "mo" },
  { id: "it_m", parent: null, position: 1, container: "mo2" },
  { id: "it_n", parent: null, position: 2, container: "mo2" }
];

// Adversarial v1 fixture (P1.3): a<->b cycle, c -> missing parent, d -> a
// cross-container parent (adv_x lives in amo2). A migration that copies parents
// blindly preserves all three invalid edges, and — since v2 renders only from
// null-parent roots — every one of a/b/c/d then VANISHES.
const ADVERSARIAL: Item[] = [
  { id: "adv_a", parent: "adv_b", position: 1, container: "amo" },
  { id: "adv_b", parent: "adv_a", position: 2, container: "amo" },
  { id: "adv_c", parent: "ghost_missing", position: 3, container: "amo" },
  { id: "adv_d", parent: "adv_x", position: 4, container: "amo" },
  { id: "adv_x", parent: null, position: 1, container: "amo2" }
];

function buildV1(world: ReturnType<typeof createWorld>, items: Item[]): void {
  installCatalogManifest(world, V1, { tap: "@local", alias: "outliner" });
  for (const container of new Set(items.map((i) => i.container))) {
    world.createObject({ id: container, name: container, parent: "$outliner", owner: "$wiz" });
  }
  for (const item of items) {
    world.createObject({ id: item.id, name: item.id, parent: "$outline_item", owner: "$wiz", location: item.container });
    world.setProp(item.id, "parent", item.parent);
    world.setProp(item.id, "position", item.position);
  }
}

function buildAgedV1(world: ReturnType<typeof createWorld>): void {
  buildV1(world, AGED);
}

/** Items reachable by walking edges DOWN from the null-parent roots (what v2's
 * `object_tree_rows` renders). Anything unreachable has vanished. */
function reachableFromRoots(world: ReturnType<typeof createWorld>, items: Item[]): Set<string> {
  const byParent = new Map<string | null, string[]>();
  for (const it of items) {
    const parent = edgeOf(world, it.id).parent;
    (byParent.get(parent) ?? byParent.set(parent, []).get(parent)!).push(it.id);
  }
  const seen = new Set<string>();
  const queue = [...(byParent.get(null) ?? [])];
  while (queue.length > 0) {
    const n = queue.shift()!;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const child of byParent.get(n) ?? []) queue.push(child);
  }
  return seen;
}

function migrate(world: ReturnType<typeof createWorld>): ReturnType<typeof updateCatalogManifest> {
  return updateCatalogManifest(world, V2, { tap: "@local", alias: "outliner", acceptMajor: true, migration: readMigration() });
}

function edgeOf(world: ReturnType<typeof createWorld>, id: string): { parent: string | null; rank: string } {
  const e = world.propOrNull(id, "__ordered_edge") as { parent?: unknown; rank?: unknown } | null;
  expect(e && typeof e === "object", `item ${id} has no edge`).toBe(true);
  return { parent: (typeof e!.parent === "string" ? e!.parent : null), rank: e!.rank as string };
}

/** Ids of `container`'s items whose edge parent === `parent`, in rank order. */
function ordered(world: ReturnType<typeof createWorld>, container: string, parent: string | null): string[] {
  return AGED.filter((i) => i.container === container)
    .map((i) => ({ id: i.id, ...edgeOf(world, i.id) }))
    .filter((e) => e.parent === parent)
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .map((e) => e.id);
}

/** The four required migration validations, asserted against a migrated world. */
function assertValidations(world: ReturnType<typeof createWorld>): void {
  const byContainer = new Map<string, Set<string>>();
  for (const i of AGED) (byContainer.get(i.container) ?? byContainer.set(i.container, new Set()).get(i.container)!).add(i.id);
  for (const item of AGED) {
    const edge = edgeOf(world, item.id);
    // (1) one edge per child: exactly one non-empty rank.
    expect(typeof edge.rank).toBe("string");
    expect(edge.rank.length).toBeGreaterThan(0);
    // (2) no dangling parent: null, or an item in the SAME outliner.
    if (edge.parent !== null) {
      expect(byContainer.get(item.container)!.has(edge.parent), `${item.id} parent ${edge.parent} not in ${item.container}`).toBe(true);
    }
    // (3) no cycles: child -> parent walk terminates.
    const seen = new Set<string>();
    let cur: string | null = item.id;
    while (cur !== null) {
      expect(seen.has(cur), `cycle at ${cur}`).toBe(false);
      seen.add(cur);
      cur = edgeOf(world, cur).parent;
    }
    // legacy props dropped (no second write path).
    expect(world.propOrNull(item.id, "position")).toBeNull();
    expect(world.propOrNull(item.id, "parent")).toBeNull();
  }
}

describe("outliner v1 -> v2 migration", () => {
  it("derives edges from (parent, position) on a local SQLite woo, tie-breaking duplicate positions by id", () => {
    const { dir, path } = tempDb();
    try {
      // ---- Seed an aged v1 world and persist it.
      const seedRepo = new LocalSQLiteRepository(path);
      const seedWorld = createWorld({ repository: seedRepo, catalogs: false });
      buildAgedV1(seedWorld);
      seedRepo.close();

      // ---- Reload from SQLite and apply the real v1 -> v2 migration.
      const upgradeRepo = new LocalSQLiteRepository(path);
      const upgradeWorld = createWorld({ repository: upgradeRepo, catalogs: false });
      const record = upgradeRepo.transaction(() => migrate(upgradeWorld));
      expect(record.migration_state).toMatchObject({ status: "completed", to_version: "2.0.0" });

      // Derived order matches (position, then id) per (outliner, parent).
      expect(ordered(upgradeWorld, "mo", null)).toEqual(["it_b", "it_c", "it_a"]);
      expect(ordered(upgradeWorld, "mo", "it_b")).toEqual(["it_x", "it_y"]);
      expect(ordered(upgradeWorld, "mo2", null)).toEqual(["it_m", "it_n"]);
      // Parents preserved on the edge.
      expect(edgeOf(upgradeWorld, "it_x").parent).toBe("it_b");
      expect(edgeOf(upgradeWorld, "it_a").parent).toBeNull();
      assertValidations(upgradeWorld);
      upgradeRepo.close();

      // ---- Reload once more: the migrated edges + dropped props persist.
      const verifyRepo = new LocalSQLiteRepository(path);
      const verifyWorld = createWorld({ repository: verifyRepo, catalogs: false });
      expect(ordered(verifyWorld, "mo", null)).toEqual(["it_b", "it_c", "it_a"]);
      assertValidations(verifyWorld);
      verifyRepo.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is deterministic: two identical aged worlds migrate to byte-identical ranks (stable ordering)", () => {
    const a = createWorld({ catalogs: false });
    const b = createWorld({ catalogs: false });
    buildAgedV1(a);
    buildAgedV1(b);
    migrate(a);
    migrate(b);
    assertValidations(a);
    assertValidations(b);
    for (const item of AGED) {
      const ea = edgeOf(a, item.id);
      const eb = edgeOf(b, item.id);
      expect(eb.rank, `rank drift for ${item.id}`).toBe(ea.rank);
      expect(eb.parent).toBe(ea.parent);
    }
    // Ranks are strictly increasing in sibling order (a real total order).
    const roots = ["it_b", "it_c", "it_a"].map((id) => edgeOf(a, id).rank);
    for (let i = 1; i < roots.length; i += 1) expect(roots[i - 1] < roots[i]).toBe(true);
  });

  // P1.3 (reviewer repro): the migration must ENFORCE the four validations on
  // real (possibly malformed) input, with deterministic repair, BEFORE it drops
  // the legacy source props — otherwise it copies invalid parents blindly, the
  // nodes vanish from list_items (which renders only null-parent roots), and the
  // v1 source is then destroyed under corruption.
  it("enforces the four validations on a malformed v1 tree with deterministic repair, on SQLite", () => {
    const { dir, path } = tempDb();
    try {
      const seedRepo = new LocalSQLiteRepository(path);
      const seedWorld = createWorld({ repository: seedRepo, catalogs: false });
      buildV1(seedWorld, ADVERSARIAL);
      seedRepo.close();

      const upgradeRepo = new LocalSQLiteRepository(path);
      const upgradeWorld = createWorld({ repository: upgradeRepo, catalogs: false });
      const record = upgradeRepo.transaction(() => migrate(upgradeWorld));
      expect(record.migration_state).toMatchObject({ status: "completed", to_version: "2.0.0" });

      const validItems: Record<string, string[]> = {
        amo: ["adv_a", "adv_b", "adv_c", "adv_d"],
        amo2: ["adv_x"]
      };
      for (const item of ADVERSARIAL) {
        const e = edgeOf(upgradeWorld, item.id);
        // (1) exactly one edge, non-empty rank.
        expect(typeof e.rank).toBe("string");
        expect(e.rank.length).toBeGreaterThan(0);
        // (2) no dangling / cross-container parent: null or a same-outliner item.
        if (e.parent !== null) {
          expect(validItems[item.container], `${item.id} parent ${e.parent} not in ${item.container}`).toContain(e.parent);
        }
        // (3) no cycles: child -> parent walk terminates.
        const seen = new Set<string>();
        let cur: string | null = item.id;
        while (cur !== null) {
          expect(seen.has(cur), `cycle at ${cur}`).toBe(false);
          seen.add(cur);
          cur = edgeOf(upgradeWorld, cur).parent;
        }
        // legacy source dropped only AFTER a valid edge exists.
        expect(upgradeWorld.propOrNull(item.id, "parent")).toBeNull();
        expect(upgradeWorld.propOrNull(item.id, "position")).toBeNull();
      }
      // No vanished nodes: every item is reachable from a root.
      const reachable = reachableFromRoots(upgradeWorld, ADVERSARIAL);
      for (const item of ADVERSARIAL) expect(reachable.has(item.id), `${item.id} vanished`).toBe(true);

      // Deterministic repair details:
      //  - cycle {adv_a, adv_b} broken at the lowest id (adv_a -> root, adv_b -> adv_a);
      //  - dangling adv_c -> root; cross-container adv_d -> root.
      expect(edgeOf(upgradeWorld, "adv_a").parent).toBeNull();
      expect(edgeOf(upgradeWorld, "adv_b").parent).toBe("adv_a");
      expect(edgeOf(upgradeWorld, "adv_c").parent).toBeNull();
      expect(edgeOf(upgradeWorld, "adv_d").parent).toBeNull();
      upgradeRepo.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repairs a malformed tree DETERMINISTICALLY (idempotent across identical inputs)", () => {
    const a = createWorld({ catalogs: false });
    const b = createWorld({ catalogs: false });
    buildV1(a, ADVERSARIAL);
    buildV1(b, ADVERSARIAL);
    migrate(a);
    migrate(b);
    for (const item of ADVERSARIAL) {
      expect(edgeOf(b, item.id).parent).toBe(edgeOf(a, item.id).parent);
      expect(edgeOf(b, item.id).rank, `rank drift for ${item.id}`).toBe(edgeOf(a, item.id).rank);
    }
  });

  it("is applied AUTOMATICALLY on boot: installLocalCatalogs upgrades an aged v1 outliner to v2 (the prod deploy path)", () => {
    // This is exactly how a deployed build reaches an already-installed world:
    // booting with the bundled (now v2) catalogs runs
    // `runLocalCatalogVersionMigrations`, which sees the installed outliner at
    // v1 < the bundled v2.0.0 and applies the bundled migration-v1-to-v2.json.
    const world = createWorld({ catalogs: false });
    installLocalCatalogs(world, ["chat", "note"]);
    // A synthetic v1 outliner (real class names/ancestors) with aged items.
    const v1Full: CatalogManifest = {
      name: "outliner", version: "1.0.1", spec_version: "v1", license: "MIT", depends: ["@local:chat", "@local:note"],
      classes: [
        { local_name: "$outliner", parent: "$room", properties: [] },
        {
          local_name: "$outline_item", parent: "$note",
          properties: [
            { name: "parent", type: "obj|null", default: null, perms: "r" },
            { name: "position", type: "int", default: 0, perms: "r" }
          ]
        }
      ]
    } as unknown as CatalogManifest;
    installCatalogManifest(world, v1Full, { tap: "@local", alias: "outliner" });
    world.createObject({ id: "boot_mo", name: "mo", parent: "$outliner", owner: "$wiz" });
    for (const [id, pos] of [["bi_a", 2], ["bi_b", 1]] as const) {
      world.createObject({ id, name: id, parent: "$outline_item", owner: "$wiz", location: "boot_mo" });
      world.setProp(id, "parent", null);
      world.setProp(id, "position", pos);
    }

    // Boot with the bundled catalogs — the auto-upgrade trigger.
    installLocalCatalogs(world, ["chat", "note", "outliner"]);

    // Edges derived by (position) order; legacy props dropped.
    const ea = world.propOrNull("bi_a", "__ordered_edge") as { parent: string | null; rank: string };
    const eb = world.propOrNull("bi_b", "__ordered_edge") as { parent: string | null; rank: string };
    expect(ea.parent).toBeNull();
    expect(eb.parent).toBeNull();
    // Deriving edges FROM the legacy position order (bi_b before bi_a) proves
    // the migration ran on aged v1 data — a fresh v2 install has no positions.
    expect(eb.rank < ea.rank).toBe(true); // bi_b (position 1) before bi_a (position 2)
    expect(world.propOrNull("bi_a", "position")).toBeNull();
    expect(world.propOrNull("bi_a", "parent")).toBeNull();
  });
});
