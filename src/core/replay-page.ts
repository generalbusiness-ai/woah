/**
 * Replay pages — the shared vocabulary for the owner-attested sequenced-log
 * read input (spec/semantics/sequenced-log.md §SL2/§SL4;
 * spec/protocol/coherence.md CO2.3 "replay-page reads").
 *
 * A replay page is ONE bounded window of a space's committed log:
 * `{space, from, limit}` → the committed entries with `seq >= from`, at
 * most `limit` of them, exactly as the native `replay(from, limit)`
 * wrapper returns them. On a complete local runtime the world answers from
 * its own log; on the sparse net planning path the page is fetched from the
 * log's OWNING authority, installed transiently in the ephemeral planning
 * world, and attested at its content version — the read analogue of the
 * ordered-children projection (src/core/ordered-edge.ts).
 *
 * Identity rule (the semantic/authority split): `space` is ALWAYS the
 * SEMANTIC space id (`the_room`), never the Net commit-scope address
 * (`room:the_room`). Pages are FETCHED from the authority address (the
 * gateway routes `scopeOf(space)`), but every entry keeps its semantic
 * identity so `space == this` guards, journal output, and
 * `rebuild_from(room, ...)` read the same ids on every lane.
 *
 * The query key is exact — `(space, from, limit)` — because the page's
 * content version covers exactly that window: a differently-bounded read
 * is a different attested fact.
 */

/** SL2's read-paging bounds: `from < 1` or `limit > 1000` is E_RANGE.
 * This is also the net page ceiling — the ordered-relation inputs carry
 * no numeric cap (they are room-width-bounded), so replay's own 1000 is
 * the tighter convention and the one the authority endpoint enforces. */
export const REPLAY_PAGE_MAX_LIMIT = 1000;
/** SL2: `limit` defaults to 100 when omitted. */
export const REPLAY_PAGE_DEFAULT_LIMIT = 100;

export type ReplayPageQuery = {
  /** SEMANTIC space id (never the Net scope address). */
  space: string;
  /** First seq the page covers (>= 1). */
  from: number;
  /** Maximum entries in the page (1..REPLAY_PAGE_MAX_LIMIT). */
  limit: number;
};

/** True iff the bounds are the SL2-legal integer window. */
export function validReplayPageBounds(from: number, limit: number): boolean {
  return (
    Number.isInteger(from) && from >= 1 &&
    Number.isInteger(limit) && limit >= 1 && limit <= REPLAY_PAGE_MAX_LIMIT
  );
}

/** Canonical map key for one exact replay-page query. */
export function replayPageQueryKey(query: ReplayPageQuery): string {
  return `${query.space}\0${query.from}\0${query.limit}`;
}
