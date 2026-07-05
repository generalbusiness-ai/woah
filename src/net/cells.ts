/**
 * CellStore — typed, provenance-carrying cell pages (coherence.md CO2.1,
 * CO5, CO7, CO8).
 *
 * The coherence invariant holds *by construction* here:
 * - every cell carries `provenance` at the type level — there is no
 *   un-provenanced state to refuse or repair later (contrast v2's CA11
 *   presentation-stub machinery);
 * - a store is either the authority for its cells or a derived copy, and
 *   only an authority store accepts authoritative mutations — a derived
 *   copy can never become a second write path (CO2.1);
 * - transfers are lineage-closed at the serialization boundary: a page
 *   set that dangles a parent reference does not serialize (CO7), so
 *   `dangling_parent_ref` is unrepresentable rather than gated to zero.
 *
 * The cell-kind vocabulary matches what the engine already records
 * through the Phase-1 TurnEffects seam (object_lineage / object_live /
 * property_cell / verb_bytecode, plus session and log rows), so read
 * closures translate 1:1 from recorded turns. Scope state is cells —
 * never a whole-world image (the CA12 lesson; see the Phase-2 kickoff
 * note).
 */
import { hashSource } from "../core/source-hash";
import { netError } from "./errors";

/** CO5 provenance, simplified from v2's five sources:
 * - `authoritative`: the committing scope's own cells (copy #1);
 * - `derived`: a pure read-through installed from authority or fanout
 *   (copies #2, #4, #5);
 * - `seed`: a cold-start KV checkpoint, may lag (copy #3);
 * - `echo`: the browser's optimistic overlay, replaced by derived truth
 *   on commit (CO1 client). */
export type Provenance = "authoritative" | "derived" | "seed" | "echo";

/** CO8: every durable artifact stamps the epoch of its inputs. */
export type EpochStamp = {
  /** The scope head this cell's value was produced at. */
  scope_head: string;
  /** The catalog epoch of the world that produced it. */
  catalog_epoch: string;
};

export type CellKind =
  | "object_lineage"  // parent/class-chain identity; payload names `parent`
  | "object_live"     // location + liveness cells
  | "property_cell"   // one named property value
  | "verb_bytecode"   // compiled verb page (never carries line_map — CO7)
  | "session"         // session row
  | "log";            // sequenced-log row

/** Canonical cell key. Matches the planning-cell shape the engine records:
 * `<kind>:<object>` or `<kind>:<object>:<name>` for named cells. */
export function cellKey(kind: CellKind, object: string, name?: string): string {
  return name === undefined ? `${kind}:${object}` : `${kind}:${object}:${name}`;
}

export type Cell = {
  key: string;
  kind: CellKind;
  object: string;
  name?: string;
  /** JSON-serializable payload. For `object_lineage` the payload MUST
   * carry `parent: string | null` — the closure walk depends on it. */
  value: unknown;
  /** Content address of `value` (canonical JSON hash). Read-version
   * validation (CO2.4) compares these. */
  version: string;
  provenance: Provenance;
  stamp: EpochStamp;
};

/** Content address for a cell value: canonical (sorted-key) JSON, hashed
 * with the repo's standard source hash so versions are comparable across
 * hosts and with recorded transcript read versions. */
export function cellVersion(value: unknown): string {
  return hashSource(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export function makeCell(input: {
  kind: CellKind;
  object: string;
  name?: string;
  value: unknown;
  provenance: Provenance;
  stamp: EpochStamp;
}): Cell {
  return {
    key: cellKey(input.kind, input.object, input.name),
    kind: input.kind,
    object: input.object,
    ...(input.name !== undefined ? { name: input.name } : {}),
    value: input.value,
    version: cellVersion(input.value),
    provenance: input.provenance,
    stamp: input.stamp
  };
}

/**
 * A store is the authority for its cells or a derived copy — fixed at
 * construction, so the CI's "no second write path" is a type-level and
 * runtime property, not a convention.
 */
export type StoreRole = "authority" | "derived";

export class CellStore {
  readonly role: StoreRole;
  private readonly cells = new Map<string, Cell>();

  constructor(role: StoreRole) {
    this.role = role;
  }

  get(key: string): Cell | undefined {
    return this.cells.get(key);
  }

  has(key: string): boolean {
    return this.cells.has(key);
  }

  keys(): IterableIterator<string> {
    return this.cells.keys();
  }

  get size(): number {
    return this.cells.size;
  }

  /**
   * Authoritative mutation: only the authority store accepts it, and it
   * stamps the cell `authoritative` at the given head. This is the single
   * write path for a fact (CO9); everything else installs derived copies.
   */
  commit(input: { kind: CellKind; object: string; name?: string; value: unknown; stamp: EpochStamp }): Cell {
    if (this.role !== "authority") {
      // A derived copy asked to originate truth — the exact CI violation
      // class every recurring v2 defect reduced to. Programming error.
      throw netError("E_LINEAGE", "derived store cannot accept authoritative writes", {
        key: cellKey(input.kind, input.object, input.name)
      });
    }
    const cell = makeCell({ ...input, provenance: "authoritative" });
    this.cells.set(cell.key, cell);
    return cell;
  }

  /**
   * Install a derived/seed/echo copy (read-through at a known head —
   * CO2.1). The authority store never installs non-authoritative cells;
   * a derived store never installs authoritative ones.
   */
  install(cell: Cell): void {
    if (this.role === "authority" && cell.provenance !== "authoritative") {
      throw netError("E_LINEAGE", "authority store only holds authoritative cells", { key: cell.key, provenance: cell.provenance });
    }
    if (this.role === "derived" && cell.provenance === "authoritative") {
      // Derived copies re-stamp what they receive: the value is the
      // authority's, the copy is not.
      this.cells.set(cell.key, { ...cell, provenance: "derived" });
      return;
    }
    this.cells.set(cell.key, cell);
  }

  delete(key: string): void {
    this.cells.delete(key);
  }

  /** CO8: drop every cell whose stamp mismatches the expected epoch —
   * the named self-healing reseed path (E_STALE_EPOCH consumers call this
   * then refetch). Returns the number of cells dropped. */
  dropStaleEpoch(expected: Pick<EpochStamp, "catalog_epoch">): number {
    let dropped = 0;
    for (const [key, cell] of this.cells) {
      if (cell.stamp.catalog_epoch !== expected.catalog_epoch) {
        this.cells.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** Snapshot for post-state re-derivation (CO4 step 10): apply recorded
   * writes to a clone, never to live state. */
  clone(): CellStore {
    const copy = new CellStore(this.role);
    for (const [key, cell] of this.cells) copy["cells"].set(key, { ...cell });
    return copy;
  }

  cellsForObject(object: string): Cell[] {
    const out: Cell[] = [];
    for (const cell of this.cells.values()) if (cell.object === object) out.push(cell);
    return out;
  }
}

/**
 * A lineage-closed page transfer (CO7). `serializeTransfer` is the ONLY
 * way cells leave a store for the wire, and it throws E_LINEAGE (assert
 * class — this is a bug, not an operational error) if the page set
 * dangles: every object with any cell present must carry its
 * `object_lineage` cell, and every parent named by a lineage payload must
 * itself be lineage-present or listed in `receiverKnown` (how read
 * closures stay under the byte ceilings without reshipping the world's
 * class chain every turn).
 */
export type CellTransfer = {
  kind: "woo.net.cell_transfer.v1";
  cells: Cell[];
  /** Lineage keys the sender asserts the receiver already holds. */
  assumes_known: string[];
};

export function serializeTransfer(cells: Cell[], receiverKnown: ReadonlySet<string> = new Set()): CellTransfer {
  const present = new Set(cells.map((c) => c.key));
  const lineageByObject = new Map<string, Cell>();
  for (const cell of cells) if (cell.kind === "object_lineage") lineageByObject.set(cell.object, cell);

  const objects = new Set(cells.map((c) => c.object));
  for (const object of objects) {
    const key = cellKey("object_lineage", object);
    if (!present.has(key) && !receiverKnown.has(key)) {
      throw netError("E_LINEAGE", "transfer dangles: object without lineage closure", { object, missing: key });
    }
  }
  for (const lineage of lineageByObject.values()) {
    const parent = parentOfLineage(lineage);
    if (parent === null) continue;
    const parentKey = cellKey("object_lineage", parent);
    if (!present.has(parentKey) && !receiverKnown.has(parentKey)) {
      throw netError("E_LINEAGE", "transfer dangles: lineage parent not closed over", { object: lineage.object, parent, missing: parentKey });
    }
  }
  return { kind: "woo.net.cell_transfer.v1", cells, assumes_known: [...receiverKnown].sort() };
}

/** Walk every parent named by lineage payloads in `cells`, returning the
 * full closure key set a sender must satisfy (present or receiver-known). */
export function lineageClosureKeys(cells: Cell[]): Set<string> {
  const keys = new Set<string>();
  for (const cell of cells) {
    keys.add(cellKey("object_lineage", cell.object));
    if (cell.kind === "object_lineage") {
      const parent = parentOfLineage(cell);
      if (parent !== null) keys.add(cellKey("object_lineage", parent));
    }
  }
  return keys;
}

function parentOfLineage(cell: Cell): string | null {
  const value = cell.value as { parent?: unknown } | null | undefined;
  const parent = value && typeof value === "object" ? value.parent : undefined;
  if (parent === null || parent === undefined) return null;
  if (typeof parent !== "string") {
    throw netError("E_LINEAGE", "lineage payload has non-string parent", { key: cell.key });
  }
  return parent;
}
