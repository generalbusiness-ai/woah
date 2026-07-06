/**
 * bridge.ts — engine-boundary views (coherence.md CO7; Phase-2 kickoff
 * step 8).
 *
 * THE second (and last) v2 engine-boundary file, amending the
 * single-bridge rule: bridges = `transcript.ts` (schema) + `bridge.ts`
 * (engine views). Everything `src/net/` needs from the engine — the
 * SerializedWorld shape, the PlanningWorld admission gate, the VM turn
 * runner — enters through here, so Phase-5 deletion has exactly two
 * places to cut and `plan.ts` stays engine-import-free.
 *
 * Both directions, with **net cell payload shapes** (no
 * shadow-state-pages dependency):
 *
 * | net cell                      | SerializedWorld                        |
 * |-------------------------------|----------------------------------------|
 * | object_lineage:<id>           | {parent, owner, name, anchor, flags,   |
 * |                               |  eventSchemas?} — identity only; never |
 * |                               |  created/modified timestamps           |
 * | object_live:<id>              | {location}                             |
 * | property_cell:<id>:<name>     | {value?, def?} (PropertyCellPayload)   |
 * | verb_bytecode:<id>:<name>     | the serialized verb minus line_map     |
 * |                               |  (CO7: debug info never ships)         |
 * | session:<sid>                 | the SerializedSession row              |
 * | log:*                         | — none: the sequenced-log tail is      |
 * |                               |   scope-local (CO5 copy #1), never a   |
 * |                               |   planning input                       |
 *
 * `contents` and `children` are NOT cells: they are projections of the
 * members' own live/lineage cells (CA4/CO9), recomputed at assembly.
 * `propertyVersions` are left at defaults — engine read-version counters
 * are meaningless to net; `plan.ts` rewrites every recorded read version
 * through the planning view's net cells (the step-8 version rule).
 */
import { authoritativePlanningWorld, type PlanningWorld } from "../core/planning-world";
import type { SerializedObject, SerializedSession, SerializedWorld } from "../core/repository";
import type { PropertyDef, VerbDef } from "../core/types";
import type { Cell, CellKind } from "./cells";
import { netError } from "./errors";
import { propertyCellPayload, type PropertyCellPayload } from "./transcript";

// The VM entry points plan.ts drives, re-exported so the engine boundary
// stays inside this file (grep gate: `from "../core/` in src/net appears in
// bridge.ts, transcript.ts, and cells.ts's hashSource only).
export { runShadowTurnCallTranscript } from "../core/shadow-turn-call";
export type { ShadowTurnCall, ShadowTurnCallTranscriptRun } from "../core/shadow-turn-call";
export { authoritativePlanningWorld, buildPlanningWorld } from "../core/planning-world";
export type { PlanningWorld } from "../core/planning-world";
export type { SerializedWorld } from "../core/repository";

/** The seedable slice of a Cell: what `ScopeSequencer.seed` and
 * `serializedFromCells` consume. Versions/provenance/stamps are minted by
 * whichever store the inputs land in. */
export type NetCellInput = {
  kind: CellKind;
  object: string;
  name?: string;
  value: unknown;
};

/** The `object_lineage` payload (identity; the closure walk reads
 * `parent`). `eventSchemas` is carried only when non-empty so a
 * bridge-seeded lineage cell content-addresses identically to one
 * materialized by an applyTranscript create (which never has schemas). */
type LineagePayload = {
  parent: string | null;
  owner: string;
  name: string;
  anchor: string | null;
  flags: SerializedObject["flags"];
  eventSchemas?: SerializedObject["eventSchemas"];
};

/**
 * SerializedWorld → net cell inputs, one authoritative fact per cell.
 * Values are taken by reference: callers treat cell payloads as immutable
 * (the same discipline every CellStore consumer already follows).
 */
export function cellsFromSerialized(world: SerializedWorld): NetCellInput[] {
  const cells: NetCellInput[] = [];
  for (const obj of world.objects) {
    const lineage: LineagePayload = {
      parent: obj.parent,
      owner: obj.owner,
      name: obj.name,
      anchor: obj.anchor,
      flags: obj.flags ?? {},
      ...(obj.eventSchemas.length > 0 ? { eventSchemas: obj.eventSchemas } : {})
    };
    cells.push({ kind: "object_lineage", object: obj.id, value: lineage });
    cells.push({ kind: "object_live", object: obj.id, value: { location: obj.location } });

    // One property cell per locally *defined or valued* name; inherited
    // defaults live on the ancestor's cells (the parent walk resolves them).
    const defs = new Map(obj.propertyDefs.map((def) => [def.name, def] as const));
    const values = new Map(obj.properties);
    const names = [...new Set([...values.keys(), ...defs.keys()])].sort();
    for (const name of names) {
      cells.push({
        kind: "property_cell",
        object: obj.id,
        name,
        value: propertyCellPayload({ hasValue: values.has(name), value: values.get(name), def: defs.get(name) })
      });
    }

    for (const verb of obj.verbs) {
      // CO7: line_map/debug info never ships in an envelope or transfer.
      const { line_map: _lineMap, ...page } = verb;
      cells.push({ kind: "verb_bytecode", object: obj.id, name: verb.name, value: page });
    }
  }
  for (const session of world.sessions) {
    cells.push({ kind: "session", object: session.id, value: session });
  }
  return cells;
}

export type SerializedFromCellsOptions = {
  /** World counters are host state, not cells. Planning worlds that only
   * read/write existing objects run fine at the defaults; a turn that
   * CREATES needs the real objectCounter threaded from the owning host
   * (Phase-3 wiring) or fresh ids would collide with existing ones. */
  objectCounter?: number;
  sessionCounter?: number;
  parkedTaskCounter?: number;
};

/**
 * Net cells → a PlanningWorld-ready SerializedWorld (the inverse of
 * `cellsFromSerialized`). An object exists iff its `object_lineage` cell
 * is present — a live/property/verb cell without lineage is a closure
 * violation (E_LINEAGE, assert class: `serializeTransfer` makes this
 * unrepresentable on the wire, so reaching it here is a bug).
 *
 * The result must still pass the admission gate before touching the VM:
 * route it through `planningWorldFromCells` / `authoritativePlanningWorld`.
 */
export function serializedFromCells(
  cells: Iterable<NetCellInput>,
  opts: SerializedFromCellsOptions = {}
): SerializedWorld {
  const lineageByObject = new Map<string, LineagePayload>();
  const liveByObject = new Map<string, { location: string | null }>();
  const propsByObject = new Map<string, Map<string, PropertyCellPayload>>();
  const verbsByObject = new Map<string, VerbDef[]>();
  const sessions: SerializedSession[] = [];

  for (const cell of cells) {
    switch (cell.kind) {
      case "object_lineage":
        lineageByObject.set(cell.object, cell.value as LineagePayload);
        break;
      case "object_live":
        liveByObject.set(cell.object, cell.value as { location: string | null });
        break;
      case "property_cell": {
        if (cell.name === undefined) throw new Error(`property cell without a name: ${cell.object}`);
        let props = propsByObject.get(cell.object);
        if (!props) propsByObject.set(cell.object, (props = new Map()));
        props.set(cell.name, cell.value as PropertyCellPayload);
        break;
      }
      case "verb_bytecode": {
        let verbs = verbsByObject.get(cell.object);
        if (!verbs) verbsByObject.set(cell.object, (verbs = []));
        // Restore the shape VerbDef requires; the empty line_map is the
        // documented CO7 posture (debug info is fetched on demand).
        verbs.push({ ...(cell.value as Omit<VerbDef, "line_map">), line_map: {} } as VerbDef);
        break;
      }
      case "session":
        sessions.push(cell.value as SerializedSession);
        break;
      case "log":
        // The sequenced-log tail is scope-local recovery state (CO5 copy
        // #1) — it never assembles into a planning world.
        throw new Error(`log cells do not bridge to a planning world: ${cell.object}`);
    }
  }

  // CA4 projections, recomputed from the authoritative cells at assembly:
  // contents from members' live locations, children from lineage parents.
  // Sorted for a deterministic image (the engine's insertion order is a
  // host artifact, not state).
  const contentsByLocation = new Map<string, string[]>();
  for (const [object, live] of liveByObject) {
    if (!live.location) continue;
    let members = contentsByLocation.get(live.location);
    if (!members) contentsByLocation.set(live.location, (members = []));
    members.push(object);
  }
  const childrenByParent = new Map<string, string[]>();
  for (const [object, lineage] of lineageByObject) {
    if (lineage.parent === null) continue;
    let children = childrenByParent.get(lineage.parent);
    if (!children) childrenByParent.set(lineage.parent, (children = []));
    children.push(object);
  }

  const orphaned = [...liveByObject.keys(), ...propsByObject.keys(), ...verbsByObject.keys()]
    .filter((object) => !lineageByObject.has(object));
  if (orphaned.length > 0) {
    throw netError("E_LINEAGE", "cells reference objects without lineage closure", { objects: [...new Set(orphaned)].sort() });
  }

  const objects: SerializedObject[] = [...lineageByObject.keys()].sort().map((id) => {
    const lineage = lineageByObject.get(id) as LineagePayload;
    if (typeof lineage.owner !== "string" || typeof lineage.name !== "string") {
      throw netError("E_LINEAGE", "lineage payload missing identity fields", { object: id });
    }
    const props = propsByObject.get(id) ?? new Map<string, PropertyCellPayload>();
    const propertyDefs: PropertyDef[] = [];
    const properties: [string, unknown][] = [];
    for (const [name, payload] of [...props.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (payload.def !== undefined) propertyDefs.push(payload.def as PropertyDef);
      if ("value" in payload) properties.push([name, payload.value]);
    }
    // Verb order: reconstruct the object's ordered verb list from the
    // stored slot (importWorld reassigns slots from array order, so the
    // array must be in original slot order); name breaks ties for
    // slot-less legacy pages.
    const verbs = (verbsByObject.get(id) ?? []).sort((a, b) =>
      (a.slot ?? Number.MAX_SAFE_INTEGER) - (b.slot ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name));
    return {
      id,
      name: lineage.name,
      parent: lineage.parent ?? null,
      owner: lineage.owner,
      location: liveByObject.get(id)?.location ?? null,
      anchor: lineage.anchor ?? null,
      flags: { ...(lineage.flags ?? {}) },
      // Timestamps are host bookkeeping, not identity — lineage cells never
      // carry them (they would churn content addresses on every touch).
      created: 0,
      modified: 0,
      propertyDefs,
      properties: properties as SerializedObject["properties"],
      // Version rule (kickoff step 8): engine counters start at defaults;
      // plan.ts rewrites recorded read versions through net cell versions.
      propertyVersions: [],
      verbs,
      children: (childrenByParent.get(id) ?? []).sort(),
      contents: (contentsByLocation.get(id) ?? []).sort(),
      eventSchemas: lineage.eventSchemas ?? []
    };
  });

  return {
    version: 1,
    objectCounter: opts.objectCounter ?? 0,
    parkedTaskCounter: opts.parkedTaskCounter ?? 0,
    sessionCounter: opts.sessionCounter ?? 0,
    objects,
    sessions: sessions.sort((a, b) => a.id.localeCompare(b.id)),
    logs: [],
    snapshots: [],
    parkedTasks: [],
    tombstones: []
  };
}

/** The routed form: assemble and admit in one step. Net cells are
 * authoritative-or-derived copies of authoritative truth (a CellStore view
 * refuses anything else by construction), so the authoritative admission
 * gate is the correct one — every untagged cell is trusted. */
export function planningWorldFromCells(
  cells: Iterable<NetCellInput>,
  opts: SerializedFromCellsOptions = {}
): PlanningWorld {
  return authoritativePlanningWorld(serializedFromCells(cells, opts));
}

/** Iterate a store's cells (bridge-side helper so callers do not reach
 * into CellStore internals to feed `serializedFromCells`). */
export function storeCells(store: { keys(): IterableIterator<string>; get(key: string): Cell | undefined }): Cell[] {
  return [...store.keys()].map((key) => store.get(key) as Cell);
}
