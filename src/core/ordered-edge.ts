/**
 * Ordered-edge vocabulary — the substrate-shared names and shapes for a
 * room-owned ordered index (a child's parent + fractional rank). Kept in
 * `core` (with no `net` dependency) so both the VM/world runtime and the
 * net cell layer can name the same reserved property without core importing
 * net. The net-cell reduction (scan a scope's edge cells → one bounded
 * ordered value) lives in `src/net/ordered-edges.ts`; the fractional rank
 * scheme lives in `src/core/fractional-rank.ts`.
 *
 * The name is deliberately generic — an ordered tree/graph edge — so the
 * substrate never encodes knowledge of the outliner (or any catalog).
 */

/** Reserved property name carrying a child's ordered-edge record
 * `{ parent, rank }`. A catalog stores exactly one such property per item. */
export const ORDERED_EDGE_PROP = "__ordered_edge";

/** The authored value of an edge: the child's parent (null = a root of the
 * ordering) and its fractional rank among that parent's children. */
export type OrderedEdgeValue = {
  parent: string | null;
  rank: string;
};

/** One row of the owner-computed ordered-children projection: a child and
 * its rank, in ascending rank order. The rank rides along so a mutation can
 * pick a fractional key between neighbours without a second owner query. */
export type OrderedChildRow = {
  child: string;
  rank: string;
};

/** Identity of one owner-computed ordering. `parent: null` is meaningful only
 * inside its container, so every transient projection/miss/cache key carries
 * both coordinates. Non-root parents retain the container too: keeping one shape
 * end-to-end prevents a root-only special case from being dropped by a wrapper. */
export type OrderedProjectionKey = {
  container: string;
  parent: string | null;
};

/** Parse a RAW `__ordered_edge` property value (as stored on an object, not
 * the net property-cell wrapper — see ordered-edges.ts `readOrderedEdge` for
 * that) into a well-formed edge, or null when the value is absent/cleared/
 * malformed (an empty rank is the "detached" convention). */
export function orderedEdgeFromPropertyValue(raw: unknown): OrderedEdgeValue | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const parent = (raw as { parent?: unknown }).parent;
  const rank = (raw as { rank?: unknown }).rank;
  if (typeof rank !== "string" || rank.length === 0) return null;
  if (parent !== null && typeof parent !== "string") return null;
  return { parent: (parent as string | null) ?? null, rank };
}

/** A bounded ordering query for ONE mutation slot (P2.4). All coordinates
 * are 0-based insertion slots (`index` ∈ [0, count]); `index: null` means
 * append. `exclude` drops one child from the neighbour computation (a
 * same-parent move must not neighbour against itself); `child` asks for
 * that child's current slot in the UNFILTERED ordering (the mutation's
 * old position, for undo records and no-op checks). */
export type OrderedNeighborsQuery = {
  parent: string | null;
  index: number | null;
  exclude: string | null;
  child: string | null;
};

/** One bounded neighbour request plus the identity of the ordering it reads. */
export type OrderedNeighborsRequest = {
  container: string;
  query: OrderedNeighborsQuery;
};

/** The O(1) answer to an `OrderedNeighborsQuery`: the sibling count (after
 * exclusion), the effective (clamped) insertion slot, the two ranks bounding
 * that slot, and the queried child's current slot (or null when absent).
 * Constant-size regardless of how wide the parent is — this is the whole
 * point: a mutation reads THIS instead of the full sibling list. */
export type OrderedNeighborsValue = {
  count: number;
  index: number;
  before: string | null;
  after: string | null;
  child_index: number | null;
};

/** Canonical identity of a neighbours query — the key the sparse planning
 * world and the gateway's per-turn projection cache agree on, so a repaired
 * query is found again by the re-planned read that missed it. */
export function orderedProjectionKey(container: string, parent: string | null): string {
  return `${container}\0${parent ?? "\0root"}`;
}

/** Canonical identity includes the ordering's container. Two root queries in one
 * turn may belong to different containers (for example a cross-outliner move)
 * and must never alias merely because both have `parent: null`. */
export function orderedNeighborsQueryKey(container: string, query: OrderedNeighborsQuery): string {
  return [
    container,
    query.parent ?? "\0root",
    query.index === null ? "append" : String(query.index),
    query.exclude ?? "",
    query.child ?? ""
  ].join("\0");
}

/** Answer a neighbours query from a parent's full ordered rows. Pure and
 * shared: the owning scope runs it against its authoritative edge index
 * (the /net/ordered-neighbors endpoint), and a complete local runtime runs
 * it against its own scan — both must clamp and exclude identically or a
 * repaired plan would disagree with the authority it attested. The slot is
 * clamped (never an error) so range POLICY stays in the calling verb, which
 * validates its raw index against `count` before using the ranks. */
export function orderedNeighborsFromRows(
  rows: readonly OrderedChildRow[],
  query: Pick<OrderedNeighborsQuery, "index" | "exclude" | "child">
): OrderedNeighborsValue {
  let child_index: number | null = null;
  if (query.child !== null) {
    const at = rows.findIndex((row) => row.child === query.child);
    child_index = at >= 0 ? at : null;
  }
  const filtered = query.exclude !== null ? rows.filter((row) => row.child !== query.exclude) : rows;
  const count = filtered.length;
  let index = query.index === null ? count : Math.floor(query.index);
  if (!Number.isFinite(index)) index = count;
  if (index < 0) index = 0;
  if (index > count) index = count;
  const before = index > 0 ? filtered[index - 1].rank : null;
  const after = index < count ? filtered[index].rank : null;
  return { count, index, before, after, child_index };
}
