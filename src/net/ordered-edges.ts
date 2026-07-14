/**
 * Ordered-edge index — a room-owned, authored authority cell per child
 * that records the child's parent and its fractional rank among its
 * siblings, plus the owner-side reduction that turns a scope's edge cells
 * into ONE bounded ordered-children value.
 *
 * This is the read-bounded replacement for reading every sibling's
 * `parent`/`position` property and renumbering them on every insert (the
 * O(N) closure that blows the 64 KiB warm envelope). It is the exact
 * structural analogue of the room roster (relations.ts `roomRosterRows` +
 * the `room_roster` projection), but for ORDERING rather than presence.
 *
 * ── Edge cell representation ─────────────────────────────────────────
 * An edge is a `property_cell` whose SUBJECT is the CHILD object, under the
 * reserved property name `ORDERED_EDGE_PROP`, holding `{ parent, rank }`:
 *
 *     property_cell:<child>:__ordered_edge  ->  { value: { parent, rank } }
 *
 * WHY this shape (deliverable 2):
 *
 *  (a) Room-scope-owned. A child item is anchored to its room's scope, so
 *      the child's cells — this edge included — are sequenced by that one
 *      room-scope authority. Ordering therefore has a single owner (no
 *      cross-scope dual write), exactly like presence rows living at the
 *      room's scope.
 *
 *  (b) Keyed by child. `object = child` makes the by-child lookup O(1):
 *      `cellKey("property_cell", child, ORDERED_EDGE_PROP)` yields the
 *      child's parent + rank directly. Attaching the edge to the child
 *      (rather than piling N edge cells onto the room object) keeps a
 *      room-target turn's seed slice from dragging every sibling's edge
 *      into its closure — only the child's own single edge rides along.
 *
 *  (c) A first-class AUTHORED authority cell, not a derived relation. It is
 *      written by a verb as an ordinary property set and is the SOLE
 *      structural source (the legacy `parent`/`position` item props are
 *      removed in the catalog rewrite). Relations (relations.ts) are
 *      derived projections rebuildable from authority cells; edges are the
 *      authority. Reusing the existing `property_cell` kind means the edge
 *      round-trips through every net mechanism (serialize, closure, seed,
 *      hydrate, content-address versioning) with zero new plumbing and no
 *      new `CellKind` — it is byte-small (`{parent, rank}`, two short
 *      fields) and version-stable like any other property.
 *
 * Reads NEVER pull the edge cells into a turn's attestable closure: the
 * ordered-children value is computed OWNER-SIDE by `orderedChildrenRows`
 * and installed only in the ephemeral planning world (see the
 * `ordered_children` builtin + `planningOrderedChildren`), precisely as the
 * roster is. The only edge cell a mutation touches is the ONE it writes.
 */
import {
  ORDERED_EDGE_PROP,
  orderedNeighborsFromRows,
  orderedNeighborsQueryKey,
  type OrderedChildRow,
  type OrderedEdgeValue,
  type OrderedNeighborsQuery,
  type OrderedNeighborsValue
} from "../core/ordered-edge";
import { cellKey, cellVersion, type Cell } from "./cells";

export {
  ORDERED_EDGE_PROP,
  orderedNeighborsFromRows,
  orderedNeighborsQueryKey,
  type OrderedChildRow,
  type OrderedEdgeValue,
  type OrderedNeighborsQuery,
  type OrderedNeighborsValue
};

/** The cell key of a child's edge (the O(1) by-child index). */
export function orderedEdgeCellKey(child: string): string {
  return cellKey("property_cell", child, ORDERED_EDGE_PROP);
}

/**
 * Extract the `{parent, rank}` edge record from a `property_cell` cell value,
 * or `null` if the value is not a well-formed edge. A `property_cell` payload
 * wraps the property value as `{ value, def? }` (see transcript.ts
 * `propertyCellPayload`), so the edge record is at `cell.value.value`.
 */
export function readOrderedEdge(cellValue: unknown): OrderedEdgeValue | null {
  if (!cellValue || typeof cellValue !== "object") return null;
  const inner = (cellValue as { value?: unknown }).value;
  if (!inner || typeof inner !== "object") return null;
  const parent = (inner as { parent?: unknown }).parent;
  const rank = (inner as { rank?: unknown }).rank;
  if (typeof rank !== "string" || rank.length === 0) return null;
  if (parent !== null && typeof parent !== "string") return null;
  return { parent: (parent as string | null) ?? null, rank };
}

/**
 * Reduce a scope's authority cells into the bounded ordered list of a
 * parent's direct children (the owner-computed projection — the ordering
 * analogue of `roomRosterRows`). Scans the store's `property_cell` edge
 * cells, keeps those whose `parent` matches, and sorts by fractional rank
 * (plain string compare — the whole point of the rank scheme), tie-breaking
 * by child id so the order is total and reproducible even if two edges ever
 * share a rank. O(edges in the scope); the RESULT is one small value.
 *
 * `parent` is the parent ref, or `null` to list the ordering roots.
 */
export function orderedChildrenRows(cells: Iterable<Cell>, parent: string | null): OrderedChildRow[] {
  const rows: OrderedChildRow[] = [];
  for (const cell of cells) {
    if (cell.kind !== "property_cell" || cell.name !== ORDERED_EDGE_PROP) continue;
    const edge = readOrderedEdge(cell.value);
    if (!edge) continue;
    if (edge.parent !== parent) continue;
    rows.push({ child: cell.object, rank: edge.rank });
  }
  rows.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.child < b.child ? -1 : a.child > b.child ? 1 : 0));
  return rows;
}

/**
 * A content version of a parent's ordered children — the content address of
 * the sorted rows (P1.1). A mutation attests the version it read; the owning
 * scope re-derives the version from its CURRENT edge cells at submit and
 * rejects a stale plan (read_version_mismatch). This is what makes concurrent
 * inserts into the SAME parent serialize: the ordering is a read the transcript
 * carries, so a same-parent insert that lands between plan and submit
 * invalidates the neighbour read that produced the rank. A change under a
 * DIFFERENT parent does not touch these rows, so it does not conflict.
 */
export function orderedChildrenVersion(rows: readonly OrderedChildRow[]): string {
  return cellVersion(rows as unknown[]);
}
