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
