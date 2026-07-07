/**
 * Relations — derived rows with one write path (coherence.md CO13, CO9).
 *
 * A relation row materializes a fact that is DEFINED by authority cells
 * (contents by `live:location`, presence by session-scope transitions)
 * and is derived at exactly one place: the committing scope, from the
 * accepted transcript. Rows whose owner object is anchored elsewhere are
 * delivered to the owning scope (the shell's /net/relate, riding the
 * durable outbox); nothing ever writes a relation row from a second
 * source. Rows are rebuildable from authority cells (the bounded repair
 * path — CO13), which is what makes them projections rather than truth.
 */
import type { Cell } from "./cells";
import type { ApplyResult, EffectTranscript } from "./transcript";

export type RelationRow = {
  relation: string;
  owner: string;
  member: string;
  /** Small JSON payload (e.g. presence rows carry the actor). */
  body?: unknown;
};

export type RelationDelta = {
  op: "add" | "remove";
  row: RelationRow;
};

export function relationKey(relation: string, owner: string, member: string): string {
  return `relation:${relation}:${owner}:${member}`;
}

/** Foreign deltas grouped by the owning scope's name. */
export type DerivedRelationDeltas = {
  local: RelationDelta[];
  foreign: Map<string, RelationDelta[]>;
};

/**
 * Derive relation deltas from one accepted transcript.
 *
 * - `contents` (CA4): from the projection-routed contents writes AND from
 *   `moves` (remove at the source parent, add at the destination). The
 *   two sources can name the same membership change for one turn (the
 *   engine records both a contents cell write and a move for container
 *   moves); deltas dedupe by (op, owner, member) with set semantics.
 * - `session_presence` (CA8/CO14): from the transcript's session-scope
 *   transition — remove at `from`, add at `to`, body carries the actor.
 *
 * `homeScope` + `scopeOf` partition the deltas: a delta whose owner is
 * anchored to another scope is that scope's row (delivered via
 * /net/relate); with no `scopeOf` every delta is local (single-scope).
 */
export function deriveRelationDeltas(
  transcript: EffectTranscript,
  applied: Pick<ApplyResult, "projectionWrites">,
  homeScope: string,
  scopeOf?: (object: string) => string
): DerivedRelationDeltas {
  const deltas = new Map<string, RelationDelta>();
  const put = (op: "add" | "remove", relation: string, owner: string, member: string, body?: unknown) => {
    if (!owner || !member) return;
    // Set semantics: one final delta per (op, row); a later opposite op
    // for the same row replaces the earlier one (last write wins within
    // the turn, matching finalWritesByCell's collapsing discipline).
    deltas.delete(`${op === "add" ? "remove" : "add"}|${relationKey(relation, owner, member)}`);
    deltas.set(`${op}|${relationKey(relation, owner, member)}`, {
      op,
      row: { relation, owner, member, ...(body !== undefined ? { body } : {}) }
    });
  };

  for (const write of applied.projectionWrites) {
    if (write.cell.kind !== "contents") continue;
    const owner = write.cell.object;
    const op = write.op === "remove" ? "remove" : "add";
    const members = Array.isArray(write.value) ? write.value : [write.value];
    for (const member of members) {
      if (typeof member === "string") put(op, "contents", owner, member);
    }
  }
  for (const move of transcript.moves ?? []) {
    if (move.from) put("remove", "contents", move.from, move.object);
    put("add", "contents", move.to, move.object);
  }
  const transition = transcript.sessionScopeTransition;
  if (transition) {
    if (transition.from) put("remove", "session_presence", transition.from, transition.session, { actor: transition.actor });
    if (transition.to) put("add", "session_presence", transition.to, transition.session, { actor: transition.actor });
  }

  const local: RelationDelta[] = [];
  const foreign = new Map<string, RelationDelta[]>();
  for (const delta of deltas.values()) {
    const ownerScope = scopeOf ? scopeOf(delta.row.owner) : homeScope;
    if (ownerScope === homeScope) {
      local.push(delta);
    } else {
      const lane = foreign.get(ownerScope) ?? [];
      lane.push(delta);
      foreign.set(ownerScope, lane);
    }
  }
  return { local, foreign };
}

/** Apply deltas to a relation map (the in-memory row family). Returns
 * the keys that CHANGED, for durable write-through — an add of an
 * identical row and a remove of an absent row are both no-ops, so a
 * redelivered batch reports empty and the caller (the owner-sequenced
 * relate path) neither advances its head nor refans a no-op. */
export function applyRelationDeltas(rows: Map<string, RelationRow>, deltas: RelationDelta[]): string[] {
  const changed: string[] = [];
  for (const delta of deltas) {
    const key = relationKey(delta.row.relation, delta.row.owner, delta.row.member);
    if (delta.op === "add") {
      const existing = rows.get(key);
      // Same key ⇒ relation/owner/member already match; only the body can
      // differ. Bodies come from the single derivation path, so plain
      // JSON comparison is stable here.
      if (existing && JSON.stringify(existing.body) === JSON.stringify(delta.row.body)) continue;
      rows.set(key, delta.row);
    } else {
      if (!rows.delete(key)) continue; // removing an absent row changes nothing
    }
    changed.push(key);
  }
  return changed;
}

/**
 * Rebuild the `contents` relation from authority cells (CO13's bounded
 * repair: scan the scope's live cells — O(scope size), the same bound as
 * hydration). Presence rows rebuild from session cells once CO14 lands;
 * until then a rebuild preserves existing presence rows untouched.
 */
export function rebuildContentsRelation(cells: Iterable<Cell>): Map<string, RelationRow> {
  const rows = new Map<string, RelationRow>();
  for (const cell of cells) {
    if (cell.kind !== "object_live") continue;
    const location = (cell.value as { location?: unknown } | null)?.location;
    if (typeof location !== "string" || !location) continue;
    const row: RelationRow = { relation: "contents", owner: location, member: cell.object };
    rows.set(relationKey("contents", location, cell.object), row);
  }
  return rows;
}
