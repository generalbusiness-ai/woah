import { describe, expect, it } from "vitest";
import {
  assertPlanningWorldAdmissible,
  authoritativePlanningWorld,
  buildPlanningWorld,
  collectPlanningWorldViolations,
  planningCellKey,
  type PlanningWorldProvenance
} from "../src/core/planning-world";
import type { AuthorityPageProvenance } from "../src/core/shadow-state-pages";
import type { SerializedObject, SerializedWorld } from "../src/core/repository";

// Minimal serialized object; only the cells the admission gate inspects matter.
function obj(id: string, name: string, extra: Partial<SerializedObject> = {}): SerializedObject {
  return {
    id,
    name,
    parent: "$player",
    owner: id,
    location: null,
    anchor: null,
    flags: {},
    created: 0,
    modified: 0,
    propertyDefs: [],
    properties: [],
    propertyVersions: [],
    verbs: [],
    children: [],
    contents: [],
    eventSchemas: [],
    ...extra
  };
}

function provenance(entries: Array<[string, AuthorityPageProvenance]>): PlanningWorldProvenance {
  return new Map(entries);
}

function lineageKey(id: string): string {
  return planningCellKey(id, "object_lineage");
}

describe("PlanningWorld admission gate", () => {
  // The originating bug: a name===id presentation stub admitted as planning
  // lineage. It must be rejected unless it is genuinely the owner's row.
  it("rejects a name===id stub lineage that is not authoritative", () => {
    const world = { objects: [obj("guest_1", "guest_1")] };
    const prov = provenance([[lineageKey("guest_1"), { source: "cache", source_host: "the_deck" }]]);
    const violations = collectPlanningWorldViolations(world, prov);
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("presentation_stub_lineage");
    expect(violations[0].object).toBe("guest_1");
  });

  // A named projection page (the correct "Guest 1") is admissible: identity is
  // resolved, so it is not a stub.
  it("admits a named projection lineage", () => {
    const world = { objects: [obj("guest_1", "Guest 1")] };
    const prov = provenance([[lineageKey("guest_1"), { source: "projection", source_host: "mcp-gateway-2" }]]);
    expect(collectPlanningWorldViolations(world, prov)).toHaveLength(0);
  });

  // Bootstrap/support objects legitimately have name===id (e.g. "$player"); the
  // gate must NOT flag them because their lineage is the owner's authoritative row.
  it("admits a name===id bootstrap object when its lineage is authoritative", () => {
    const world = { objects: [obj("$player", "$player", { parent: null })] };
    const prov = provenance([[lineageKey("$player"), { source: "authoritative", source_host: "WORLD" }]]);
    expect(collectPlanningWorldViolations(world, prov)).toHaveLength(0);
  });

  // Substrate refs (the `$`-prefixed namespace: system singletons, catalog classes)
  // are named by their ref by convention, so name===id is legitimate there even at
  // non-authoritative (e.g. cache, on a sparse shard) provenance — it is NOT a
  // presentation stub. Without this exclusion the gate floods with false positives
  // for $block/$chatroom/etc.
  it("does not flag a $-prefixed substrate ref whose name===id at cache provenance", () => {
    const world = { objects: [obj("$block", "$block", { parent: null, owner: "$wiz" })] };
    const prov = provenance([[lineageKey("$block"), { source: "cache", source_host: "world" }]]);
    expect(collectPlanningWorldViolations(world, prov)).toHaveLength(0);
  });

  // A NON-stub tracked cell with no provenance is missing_provenance (non-fatal).
  it("reports a non-stub tracked lineage cell with no provenance as missing_provenance", () => {
    const world = { objects: [obj("guest_1", "Guest 1")] };
    const violations = collectPlanningWorldViolations(world, provenance([]));
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("missing_provenance");
  });

  // P1 fix: stub-ness is independent of provenance. An unprovenanced name===id stub
  // must be presentation_stub_lineage (enters repair), NOT demoted to the non-fatal
  // missing_provenance bucket — otherwise the id-as-name leak slips through.
  it("classifies an unprovenanced name===id stub as presentation_stub_lineage", () => {
    const world = { objects: [obj("guest_1", "guest_1")] };
    const violations = collectPlanningWorldViolations(world, provenance([]));
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("presentation_stub_lineage");
  });

  // The ratchet: a known-debt cell key is allow-listed so the gate can run during
  // migration. The allow-list may only shrink.
  it("suppresses an allow-listed violation", () => {
    const world = { objects: [obj("guest_1", "guest_1")] };
    const prov = provenance([[lineageKey("guest_1"), { source: "cache" }]]);
    const allow = new Set([lineageKey("guest_1")]);
    expect(collectPlanningWorldViolations(world, prov, { allow })).toHaveLength(0);
  });

  it("throws from assertPlanningWorldAdmissible on a non-allow-listed violation", () => {
    const world = { objects: [obj("guest_1", "guest_1")] };
    const prov = provenance([[lineageKey("guest_1"), { source: "cache" }]]);
    expect(() => assertPlanningWorldAdmissible(world, prov, "unit-test")).toThrow(/inadmissible at unit-test/);
  });

  it("does not throw when every tracked cell is admissible", () => {
    const world = { objects: [obj("guest_1", "Guest 1"), obj("$player", "$player", { parent: null })] };
    const prov = provenance([
      [lineageKey("guest_1"), { source: "projection" }],
      [lineageKey("$player"), { source: "authoritative" }]
    ]);
    expect(() => assertPlanningWorldAdmissible(world, prov, "unit-test")).not.toThrow();
  });
});

describe("PlanningWorld admission gate — buildPlanningWorld enforcement", () => {
  function world(objects: SerializedObject[]): SerializedWorld {
    return { version: 1, objectCounter: 1, parkedTaskCounter: 1, sessionCounter: 1, objects, sessions: [], logs: [], snapshots: [], parkedTasks: [], tombstones: [] };
  }

  // The single admission point raises a REPAIRABLE missing-state (E_NEED_STATE)
  // naming the stubbed object, so the submitTurnIntent repair loop refreshes its
  // authority and re-plans against the named identity. The brand makes the VM
  // boundary unreachable except through this constructor.
  it("raises a repairable E_NEED_STATE for a stub with non-authoritative provenance", () => {
    const serialized = world([obj("guest_1", "guest_1", { owner: "guest_1" })]);
    const prov = provenance([[lineageKey("guest_1"), { source: "cache", source_host: "the_deck" }]]);
    let thrown: unknown;
    try { buildPlanningWorld(serialized, prov); } catch (err) { thrown = err; }
    expect(thrown).toMatchObject({ code: "E_NEED_STATE" });
    const atoms = (thrown as { value?: { missing_atoms?: Array<{ preimage?: string }> } }).value?.missing_atoms ?? [];
    expect(atoms.some((a) => a.preimage?.includes("guest_1"))).toBe(true);
  });

  // P1: an unprovenanced stub must STILL raise (it must not be demoted to the
  // non-fatal missing_provenance bucket).
  it("raises E_NEED_STATE for an unprovenanced stub", () => {
    const serialized = world([obj("guest_1", "guest_1", { owner: "guest_1" })]);
    expect(() => buildPlanningWorld(serialized, new Map())).toThrow(/repair identity/);
  });

  // authoritativePlanningWorld trusts untagged cells: a legitimate name===id under
  // authoritative construction is not a stub and is admitted.
  it("admits a stub-shaped object under authoritative construction", () => {
    const serialized = world([obj("guest_1", "guest_1", { owner: "guest_1" })]);
    expect(() => authoritativePlanningWorld(serialized)).not.toThrow();
  });

  // A named cell passes the gate and returns a branded PlanningWorld.
  it("admits a named lineage and returns a branded world", () => {
    const serialized = world([obj("guest_1", "Guest 1", { owner: "guest_1" })]);
    const prov = provenance([[lineageKey("guest_1"), { source: "projection" }]]);
    const built = buildPlanningWorld(serialized, prov);
    expect(built.objects.find((o) => o.id === "guest_1")?.name).toBe("Guest 1");
  });

  // missing_provenance on a non-stub cell is observe-only by default (coverage is
  // not yet universal); a path with proven coverage opts IN with
  // enforceMissingProvenance:true to make it fatal-by-repair (the #11 flip).
  it("enforces missing_provenance only when the caller opts in", () => {
    const serialized = world([obj("guest_1", "Guest 1", { owner: "guest_1" })]);
    expect(() => buildPlanningWorld(serialized, new Map())).not.toThrow();
    expect(() => buildPlanningWorld(serialized, new Map(), { enforceMissingProvenance: true })).toThrow(/repair identity/);
  });
});
