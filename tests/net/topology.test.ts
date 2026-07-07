// CO15 anchor-derived topology (Plan 002 Phase 3.5 item 2): the anchor
// walk, class detection over lineage parent chains, and the world
// partition. The bootstrap-world cases run against REAL exported cells
// (bridge.ts cellsFromSerialized), so the rule is proven against what the
// engine actually emits, not a hand-modeled shape.
import { describe, expect, it } from "vitest";
import { createWorld } from "../../src/core/bootstrap";
import { cellsFromSerialized } from "../../src/net/bridge";
import {
  CATALOG_SCOPE,
  classifierFromCells,
  classifierFromLineage,
  partitionCells,
  scopeNameOf,
  type AnchorLineage
} from "../../src/net/topology";

/** Hand lineage map → lookup, for the walk-mechanics cases. */
function lookup(entries: Record<string, AnchorLineage>) {
  return (object: string): AnchorLineage | null => entries[object] ?? null;
}

// The minimal seed-graph slice the class walk depends on (verified
// against src/core/bootstrap.ts:992-1003: $actor under $root, $space
// under $sequenced_log under $root).
const SEED: Record<string, AnchorLineage> = {
  $system: { parent: null, anchor: null },
  $root: { parent: "$system", anchor: null },
  $actor: { parent: "$root", anchor: null },
  $player: { parent: "$actor", anchor: null },
  $guest: { parent: "$player", anchor: null },
  $sequenced_log: { parent: "$root", anchor: null },
  $space: { parent: "$sequenced_log", anchor: null },
  $thing: { parent: "$root", anchor: null }
};

describe("scopeNameOf (CO15 anchor walk)", () => {
  it("actor and its carried (actor-anchored) item both classify cluster:<actor>", () => {
    const lineage = lookup({
      ...SEED,
      guest_9: { parent: "$guest", anchor: null },
      satchel: { parent: "$thing", anchor: "guest_9" },
      // Transitive anchoring: an item anchored to the satchel still roots
      // at the actor (anchor co-residency, objects.md §4.1).
      coin: { parent: "$thing", anchor: "satchel" }
    });
    expect(scopeNameOf("guest_9", lineage)).toBe("cluster:guest_9");
    expect(scopeNameOf("satchel", lineage)).toBe("cluster:guest_9");
    expect(scopeNameOf("coin", lineage)).toBe("cluster:guest_9");
  });

  it("room and its room-anchored door both classify room:<room>", () => {
    const lineage = lookup({
      ...SEED,
      north_room: { parent: "$space", anchor: null },
      north_door: { parent: "$thing", anchor: "north_room" }
    });
    expect(scopeNameOf("north_room", lineage)).toBe("room:north_room");
    expect(scopeNameOf("north_door", lineage)).toBe("room:north_room");
  });

  it("catalog classes and $-prefixed seeds classify catalog — even actor/space-classed ones", () => {
    const lineage = lookup(SEED);
    for (const object of ["$root", "$thing", "$actor", "$space", "$guest"]) {
      expect(scopeNameOf(object, lineage), object).toBe(CATALOG_SCOPE);
    }
  });

  it("an anchorless non-actor non-space instance classifies catalog (CO15 anchorless rule)", () => {
    const lineage = lookup({ ...SEED, loose_lamp: { parent: "$thing", anchor: null } });
    expect(scopeNameOf("loose_lamp", lineage)).toBe(CATALOG_SCOPE);
  });

  it("throws E_LINEAGE on unknown objects, unclosed walks, and cycles (assert class)", () => {
    const lineage = lookup({
      ...SEED,
      dangling: { parent: "$thing", anchor: "nowhere_to_be_found" },
      chicken: { parent: "$thing", anchor: "egg" },
      egg: { parent: "$thing", anchor: "chicken" },
      orphan_class_child: { parent: "missing_class", anchor: null }
    });
    expect(() => scopeNameOf("never_seen", lineage)).toThrowError(/E_LINEAGE/);
    expect(() => scopeNameOf("dangling", lineage)).toThrowError(/E_LINEAGE/);
    expect(() => scopeNameOf("chicken", lineage)).toThrowError(/E_LINEAGE/);
    expect(() => scopeNameOf("orphan_class_child", lineage)).toThrowError(/E_LINEAGE/);
  });
});

describe("classifierFromLineage / classifierFromCells", () => {
  it("isShared: rooms are shared; clusters and the catalog scope are not", () => {
    const classifier = classifierFromLineage(lookup(SEED));
    expect(classifier.isShared("room:north_room")).toBe(true);
    expect(classifier.isShared("cluster:guest_9")).toBe(false);
    // The catalog scope is not a turn sequencer: writes belong to the
    // install pipeline alone (CO15) — never "shared" for route.ts.
    expect(classifier.isShared(CATALOG_SCOPE)).toBe(false);
  });

  it("fallback covers objects the lineage set does not know (same-turn creates); known objects stay strict", () => {
    const strict = classifierFromLineage(lookup(SEED));
    expect(() => strict.scopeOf("obj_home_41")).toThrowError(/E_LINEAGE/);
    const soft = classifierFromLineage(lookup(SEED), { fallback: "room:planning" });
    expect(soft.scopeOf("obj_home_41")).toBe("room:planning");
    expect(soft.scopeOf("$thing")).toBe(CATALOG_SCOPE);
  });

  it("classifies a real bootstrap world's cells", () => {
    const world = createWorld();
    const session = world.auth("guest:topology");
    const actor = session.actor;
    world.createObject({ id: "topo_room", name: "Topo Room", parent: "$space", owner: actor });
    world.createObject({ id: "topo_door", name: "Topo Door", parent: "$thing", owner: actor, anchor: "topo_room" });
    world.createObject({ id: "topo_bag", name: "Topo Bag", parent: "$thing", owner: actor, anchor: actor, location: actor });
    const cells = cellsFromSerialized(world.exportWorld());
    const classifier = classifierFromCells(cells as never);
    expect(classifier.scopeOf(actor)).toBe(`cluster:${actor}`);
    expect(classifier.scopeOf("topo_bag")).toBe(`cluster:${actor}`);
    expect(classifier.scopeOf("topo_room")).toBe("room:topo_room");
    expect(classifier.scopeOf("topo_door")).toBe("room:topo_room");
    // Bundled seed rooms/exits from the catalogs: real room scopes.
    expect(classifier.scopeOf("the_chatroom")).toBe("room:the_chatroom");
    expect(classifier.scopeOf("exit_deck_east")).toBe("room:the_deck");
    // Seed substrate: catalog, including actor/space-classed $-seeds.
    for (const object of ["$system", "$root", "$thing", "$actor", "$space", "$guest", "$chatroom"]) {
      expect(classifier.scopeOf(object), object).toBe(CATALOG_SCOPE);
    }
  });
});

describe("partitionCells (CO15 install-pipeline partition)", () => {
  it("partitions a bootstrap world with no cell unassigned; catalog classes all land in catalog", () => {
    const world = createWorld();
    const session = world.auth("guest:topology-partition");
    const actor = session.actor;
    world.createObject({ id: "topo_room", name: "Topo Room", parent: "$space", owner: actor });
    world.createObject({ id: "topo_door", name: "Topo Door", parent: "$thing", owner: actor, anchor: "topo_room" });
    const cells = cellsFromSerialized(world.exportWorld());

    const partitions = partitionCells(cells);

    // Conservation: every input cell lands in exactly one partition.
    const assigned = [...partitions.values()].reduce((n, bucket) => n + bucket.length, 0);
    expect(assigned).toBe(cells.length);

    // Every $-prefixed object's cells (class lineage, verb bytecode,
    // property defaults) are in the catalog partition and nowhere else.
    const catalog = partitions.get(CATALOG_SCOPE) ?? [];
    const catalogObjects = new Set(catalog.map((cell) => cell.object));
    for (const [scope, bucket] of partitions) {
      for (const cell of bucket) {
        if (cell.kind === "session") continue; // keyed by session id, partitioned by actor
        if (cell.object.startsWith("$")) {
          expect(scope, `${cell.kind}:${cell.object} must be catalog`).toBe(CATALOG_SCOPE);
        }
      }
    }
    expect(catalogObjects.has("$root")).toBe(true);
    expect(catalogObjects.has("$thing")).toBe(true);

    // Room partition: the room object plus its room-anchored door.
    const roomObjects = new Set((partitions.get("room:topo_room") ?? []).map((cell) => cell.object));
    expect(roomObjects).toEqual(new Set(["topo_room", "topo_door"]));

    // Cluster partition: the actor and its SESSION row (CO14: a session
    // is authoritative at the actor's cluster scope).
    const cluster = partitions.get(`cluster:${actor}`) ?? [];
    expect(cluster.some((cell) => cell.kind === "session")).toBe(true);
    expect(cluster.some((cell) => cell.kind === "object_lineage" && cell.object === actor)).toBe(true);

    // Per-object atomicity: all of one object's cells share one scope.
    const scopeByObject = new Map<string, string>();
    for (const [scope, bucket] of partitions) {
      for (const cell of bucket) {
        if (cell.kind === "session") continue;
        const prior = scopeByObject.get(cell.object);
        expect(prior ?? scope, `object ${cell.object} split across scopes`).toBe(scope);
        scopeByObject.set(cell.object, scope);
      }
    }
  });

  it("refuses log cells (scope-local, never partition input)", () => {
    expect(() =>
      partitionCells([{ kind: "log" as const, object: "tail", value: {} }])
    ).toThrowError(/never partition/);
  });

  it("refuses a session cell that names no actor", () => {
    expect(() =>
      partitionCells([{ kind: "session" as const, object: "session-x", value: {} }])
    ).toThrowError(/E_LINEAGE/);
  });
});
