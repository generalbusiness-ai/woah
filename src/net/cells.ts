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
import { ORDERED_EDGE_PROP } from "../core/ordered-edge";
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
  /** object id → keys of every cell whose `object` is that id. Kept by
   * every mutation so `cellsForObject` is O(own cells), not O(store) —
   * the Phase-1 seed-slice builder calls it per seeded object on every
   * turn (ready-to-scale blocker #1: a per-turn store scan is O(view)). */
  private readonly keysByObject = new Map<string, Set<string>>();
  /** actor id → keys of the actor's session cells. The seed slice must
   * enumerate the calling actor's sessions (the move chain's primary-
   * session decision needs them all) without an O(store) key scan. */
  private readonly sessionKeysByActor = new Map<string, Set<string>>();
  /** location id → objects whose object_live cell places them there (the
   * ROSTER index, client-shell phase i): room-verb planning must seed the
   * room's members (name matching, contents projection) without an
   * O(store) scan per turn. */
  private readonly membersByLocation = new Map<string, Set<string>>();
  /** parent (or the "\0root" sentinel for null) → keys of the ordered-edge
   * cells whose edge names that parent (P2.4). Lets a mutation's neighbour read
   * and the ordering-version check touch O(children-of-parent), not O(whole
   * scope): the alternative — scanning every edge cell in the scope and sorting
   * all siblings — makes authority work unbounded as the outliner grows. */
  private readonly edgeChildrenByParent = new Map<string, Set<string>>();

  constructor(role: StoreRole) {
    this.role = role;
  }

  /** The parent an ordered-edge property_cell names, or `undefined` if the cell
   * is not a valid ordered edge. The payload is `{ value: { parent, rank } }`. */
  private static orderedEdgeParent(cell: Cell): string | null | undefined {
    if (cell.kind !== "property_cell" || cell.name !== ORDERED_EDGE_PROP) return undefined;
    const inner = (cell.value as { value?: unknown } | null)?.value;
    if (!inner || typeof inner !== "object") return undefined;
    const rank = (inner as { rank?: unknown }).rank;
    if (typeof rank !== "string" || rank.length === 0) return undefined; // cleared/unranked
    const parent = (inner as { parent?: unknown }).parent;
    if (parent !== null && typeof parent !== "string") return undefined;
    return (parent as string | null) ?? null;
  }

  private static edgeParentKey(parent: string | null): string {
    return parent === null ? "\0root" : parent;
  }

  /** Single internal write path: every insert/overwrite goes through here
   * so the object and session indexes can never drift from the map. An
   * overwrite un-indexes the prior cell first — a session row's `actor`
   * can change across writes, and the stale index entry must not linger. */
  private setCell(cell: Cell): void {
    const prior = this.cells.get(cell.key);
    if (prior) this.unindexCell(prior);
    this.cells.set(cell.key, cell);
    this.indexCell(cell);
  }

  /** Single internal delete path — see setCell. */
  private removeCell(key: string): void {
    const prior = this.cells.get(key);
    if (!prior) return;
    this.unindexCell(prior);
    this.cells.delete(key);
  }

  private indexCell(cell: Cell): void {
    let objectKeys = this.keysByObject.get(cell.object);
    if (!objectKeys) this.keysByObject.set(cell.object, (objectKeys = new Set()));
    objectKeys.add(cell.key);
    const actor = sessionActorOf(cell);
    if (actor !== null) {
      let sessionKeys = this.sessionKeysByActor.get(actor);
      if (!sessionKeys) this.sessionKeysByActor.set(actor, (sessionKeys = new Set()));
      sessionKeys.add(cell.key);
    }
    const location = liveLocationOf(cell);
    if (location !== null) {
      let members = this.membersByLocation.get(location);
      if (!members) this.membersByLocation.set(location, (members = new Set()));
      members.add(cell.object);
    }
    const edgeParent = CellStore.orderedEdgeParent(cell);
    if (edgeParent !== undefined) {
      const key = CellStore.edgeParentKey(edgeParent);
      let children = this.edgeChildrenByParent.get(key);
      if (!children) this.edgeChildrenByParent.set(key, (children = new Set()));
      children.add(cell.key);
    }
  }

  private unindexCell(cell: Cell): void {
    const objectKeys = this.keysByObject.get(cell.object);
    if (objectKeys) {
      objectKeys.delete(cell.key);
      if (objectKeys.size === 0) this.keysByObject.delete(cell.object);
    }
    const actor = sessionActorOf(cell);
    if (actor !== null) {
      const sessionKeys = this.sessionKeysByActor.get(actor);
      if (sessionKeys) {
        sessionKeys.delete(cell.key);
        if (sessionKeys.size === 0) this.sessionKeysByActor.delete(actor);
      }
    }
    const location = liveLocationOf(cell);
    if (location !== null) {
      const members = this.membersByLocation.get(location);
      if (members) {
        members.delete(cell.object);
        if (members.size === 0) this.membersByLocation.delete(location);
      }
    }
    const edgeParent = CellStore.orderedEdgeParent(cell);
    if (edgeParent !== undefined) {
      const key = CellStore.edgeParentKey(edgeParent);
      const children = this.edgeChildrenByParent.get(key);
      if (children) {
        children.delete(cell.key);
        if (children.size === 0) this.edgeChildrenByParent.delete(key);
      }
    }
  }

  /** The ordered children of `parent`, rank-sorted, via the per-parent edge
   * index — O(children-of-parent), NOT O(whole scope). The bounded read behind
   * the ordering projection, the ordering-version check, and neighbour lookup
   * (P2.4). Tie-break by child id keeps the order total. */
  orderedEdgeChildren(parent: string | null): Array<{ child: string; rank: string }> {
    const children = this.edgeChildrenByParent.get(CellStore.edgeParentKey(parent));
    if (!children) return [];
    const rows: Array<{ child: string; rank: string }> = [];
    for (const key of children) {
      const cell = this.cells.get(key);
      if (!cell) continue;
      const rank = ((cell.value as { value?: { rank?: unknown } } | null)?.value?.rank);
      if (typeof rank !== "string" || rank.length === 0) continue;
      rows.push({ child: cell.object, rank });
    }
    rows.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.child < b.child ? -1 : a.child > b.child ? 1 : 0));
    return rows;
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

  /** Every cell in the store (for owner-side projections that reduce the
   * whole scope, e.g. the ordered-children scan — O(store), on the authority
   * only, producing ONE bounded value). */
  allCells(): IterableIterator<Cell> {
    return this.cells.values();
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
    this.setCell(cell);
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
      this.setCell({ ...cell, provenance: "derived" });
      return;
    }
    this.setCell(cell);
  }

  delete(key: string): void {
    this.removeCell(key);
  }

  /** CO8: drop every cell whose stamp mismatches the expected epoch —
   * the named self-healing reseed path (E_STALE_EPOCH consumers call this
   * then refetch). Returns the number of cells dropped. */
  dropStaleEpoch(expected: Pick<EpochStamp, "catalog_epoch">): number {
    let dropped = 0;
    for (const [key, cell] of this.cells) {
      if (cell.stamp.catalog_epoch !== expected.catalog_epoch) {
        this.removeCell(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  /**
   * Planner-parity scratch ONLY (CO4 step 10, gateway side): an
   * authority-role copy of a derived view's cells — values and versions
   * preserved, provenance re-stamped `authoritative` — so the planner can
   * run the SAME `applyTranscript` the committing scope runs (it refuses
   * derived stores) and predict `post_state_version` from its view's
   * pre-state. The result is a post-state computation scratch and MUST be
   * discarded after the digest is read: holding it as state would mint a
   * second write path for the view's cells (CO2.1).
   */
  static scratchAuthorityFrom(view: CellStore): CellStore {
    const scratch = new CellStore("authority");
    for (const cell of view.cells.values()) scratch.setCell({ ...cell, provenance: "authoritative" });
    return scratch;
  }

  /** Snapshot for post-state re-derivation (CO4 step 10): apply recorded
   * writes to a clone, never to live state. */
  clone(): CellStore {
    const copy = new CellStore(this.role);
    for (const cell of this.cells.values()) copy.setCell({ ...cell });
    return copy;
  }

  /** Slice-clone: a copy holding only the given keys that this store has
   * (Phase 1 slice planning — the planner runs against the turn's seed
   * slice, cloned per attempt from the live view). Same role and same
   * detached-copy semantics as `clone`; absent keys are skipped. */
  cloneSlice(keys: Iterable<string>): CellStore {
    const copy = new CellStore(this.role);
    for (const key of keys) {
      const cell = this.cells.get(key);
      if (cell) copy.setCell({ ...cell });
    }
    return copy;
  }

  /** Every cell whose subject is `object` — O(the object's own cells) via
   * the object index (the seed-slice builder's per-object hot call). */
  cellsForObject(object: string): Cell[] {
    const keys = this.keysByObject.get(object);
    if (!keys) return [];
    const out: Cell[] = [];
    for (const key of keys) {
      const cell = this.cells.get(key);
      if (cell) out.push(cell);
    }
    return out;
  }

  /** Objects whose live cell places them at `location` — O(the roster)
   * via the location index (room-verb planning seeds the room's members
   * for name matching + the contents projection). */
  membersAt(location: string): string[] {
    const members = this.membersByLocation.get(location);
    return members ? [...members] : [];
  }

  /** The actor's session cells — O(the actor's own sessions) via the
   * session index (the seed-slice builder's per-turn session lookup,
   * replacing an O(store) key scan). */
  sessionCellsForActor(actor: string): Cell[] {
    const keys = this.sessionKeysByActor.get(actor);
    if (!keys) return [];
    const out: Cell[] = [];
    for (const key of keys) {
      const cell = this.cells.get(key);
      if (cell) out.push(cell);
    }
    return out;
  }
}

/** The location an object_live cell places its object at, or null (the
 * roster index's extraction rule). */
function liveLocationOf(cell: Cell): string | null {
  if (cell.kind !== "object_live") return null;
  const location = (cell.value as { location?: unknown } | null | undefined)?.location;
  return typeof location === "string" && location.length > 0 ? location : null;
}

/** The actor a session cell belongs to, or null for every other cell kind
 * (the session index's extraction rule — value shape per CO14 rows). */
function sessionActorOf(cell: Cell): string | null {
  if (cell.kind !== "session") return null;
  const actor = (cell.value as { actor?: unknown } | null | undefined)?.actor;
  return typeof actor === "string" && actor.length > 0 ? actor : null;
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

/** Lineage closure is an *object*-page property (CO7). Session and log
 * cells key on session ids / log streams — subjects with no lineage row —
 * so they ride in transfers (CO7 names session rows as envelope content)
 * without triggering the object closure walk. */
function cellRequiresLineageClosure(kind: CellKind): boolean {
  return kind !== "session" && kind !== "log";
}

export function serializeTransfer(cells: Cell[], receiverKnown: ReadonlySet<string> = new Set()): CellTransfer {
  const present = new Set(cells.map((c) => c.key));
  const lineageByObject = new Map<string, Cell>();
  for (const cell of cells) if (cell.kind === "object_lineage") lineageByObject.set(cell.object, cell);

  const objects = new Set(cells.filter((c) => cellRequiresLineageClosure(c.kind)).map((c) => c.object));
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
    if (!cellRequiresLineageClosure(cell.kind)) continue;
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
