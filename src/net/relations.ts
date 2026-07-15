/**
 * Relations — derived rows with one write path (coherence.md CO13, CO9).
 *
 * A relation row materializes a fact that is DEFINED by authority cells
 * (contents by `live:location`, presence by session-scope transitions,
 * ordered edges by the child's authored edge plus current container)
 * and is derived at exactly one place: the committing scope, from the
 * accepted transcript. Rows whose owner object is anchored elsewhere are
 * delivered to the owning scope (the shell's /net/relate, riding the
 * durable outbox); nothing ever writes a relation row from a second
 * source. Local contents rows rebuild from local authority cells; foreign
 * presence and ordered-edge rows re-derive at their defining immutable anchor
 * and return through this same delivery path. No relation row becomes truth or
 * acquires a second writer (CO13).
 */
import { cellKey, type Cell, type CellStore } from "./cells";
import { ORDERED_EDGE_PROP, ORDERED_EDGE_RELATION, readOrderedEdge } from "./ordered-edges";
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

/** Select observations addressed to relation owners changed by one foreign
 * delivery. The synchronous freshness fence and the durable outbox must send
 * identical `/relate` bodies: the receiver deduplicates by (from_scope, seq),
 * so whichever path arrives first is the only one that can refan these
 * observations. */
export function observationsForRelationOwners(
  observations: readonly unknown[],
  deltas: readonly RelationDelta[]
): unknown[] {
  const owners = new Set(deltas.map((delta) => delta.row.owner));
  return observations.filter((observation) => {
    const record = observation as { source?: unknown; room?: unknown } | null;
    return (
      (typeof record?.source === "string" && owners.has(record.source)) ||
      (typeof record?.room === "string" && owners.has(record.room))
    );
  });
}

/** Compact owner-anchored witness for one present session. It carries only the
 * fields required to build and expire a roster; actor lineage/live authority
 * remains at the actor's cluster and never fattens room state. */
export type SessionPresenceBody = {
  actor: string;
  name?: string;
  session?: Cell["value"];
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
  scopeOf?: (object: string) => string,
  post?: Pick<CellStore, "get">
): DerivedRelationDeltas {
  const deltas = new Map<string, RelationDelta>();
  const orderedEdgeWriters = new Set(
    transcript.writes
      .filter((write) => write.cell.kind === "prop" && write.cell.name === ORDERED_EDGE_PROP)
      .map((write) => write.cell.object)
  );
  const movedObjects = new Set((transcript.moves ?? []).map((move) => move.object));
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

    // Ordered edges remain authored cells at the child's immutable anchor.
    // When the child crosses containers, project its final edge into the
    // destination owner's index and retract the source row. This keeps
    // ordered_children(container roots) complete without re-anchoring or a
    // forbidden global scan.
    const edgeCell = post?.get(cellKey("property_cell", move.object, ORDERED_EDGE_PROP));
    const edge = edgeCell ? readOrderedEdge(edgeCell.value) : null;
    // Ordinary moved objects have no ordered-edge row to retract. Gate this
    // relation family on either a surviving edge or an edge write (the latter
    // covers a hook that cleared the edge while leaving no post cell).
    if (edge || orderedEdgeWriters.has(move.object)) {
      if (move.from) put("remove", ORDERED_EDGE_RELATION, move.from, move.object);
      if (edge) put("add", ORDERED_EDGE_RELATION, move.to, move.object, edge);
    }
  }
  // An in-place reparent/reorder updates the same owner row. Local children
  // are also readable directly from cells; storing the relation uniformly
  // makes a later cross-container move a simple remove/add transition.
  for (const write of transcript.writes) {
    if (write.cell.kind !== "prop" || write.cell.name !== ORDERED_EDGE_PROP || !post) continue;
    const live = post.get(cellKey("object_live", write.cell.object))?.value as { location?: unknown } | undefined;
    if (typeof live?.location !== "string" || !live.location) continue;
    const edgeCell = post.get(cellKey("property_cell", write.cell.object, ORDERED_EDGE_PROP));
    const edge = edgeCell ? readOrderedEdge(edgeCell.value) : null;
    if (edge) put("add", ORDERED_EDGE_RELATION, live.location, write.cell.object, edge);
    // A moved-and-cleared edge was retracted from its SOURCE above. Do not mint
    // a redundant removal at the destination/$nowhere merely because its live
    // cell already reflects the move.
    else if (!movedObjects.has(write.cell.object)) put("remove", ORDERED_EDGE_RELATION, live.location, write.cell.object);
  }
  const presenceBody = (actor: string, session: string, fallbackName?: string): SessionPresenceBody => {
    const nameCell = post?.get(cellKey("property_cell", actor, "name"))?.value as { value?: unknown } | undefined;
    const lineage = post?.get(cellKey("object_lineage", actor))?.value as { name?: unknown } | undefined;
    const name = typeof nameCell?.value === "string" && nameCell.value
      ? nameCell.value
      : typeof fallbackName === "string" && fallbackName
        ? fallbackName
        : typeof lineage?.name === "string" && lineage.name
          ? lineage.name
          : undefined;
    return {
      actor,
      ...(name ? { name } : {}),
      ...(post?.get(cellKey("session", session)) ? { session: post.get(cellKey("session", session))?.value } : {})
    };
  };
  const transition = transcript.sessionScopeTransition;
  if (transition) {
    const body = presenceBody(transition.actor, transition.session, transition.actorName);
    if (transition.from) put("remove", "session_presence", transition.from, transition.session, body);
    if (transition.to) put("add", "session_presence", transition.to, transition.session, body);
  }

  // Display names are mutable while a session remains present. Refresh the
  // same owner row through this derivation path when an actor renames itself;
  // otherwise a compact roster would retain its transition-time label until
  // the next move. The session cell identifies the one room owner to update.
  const renamedActor = transcript.writes.some(
    (write) => write.cell.kind === "prop" && write.cell.object === transcript.call.actor && write.cell.name === "name"
  );
  if (renamedActor && transcript.session && post) {
    const session = post.get(cellKey("session", transcript.session))?.value as { actor?: unknown; activeScope?: unknown } | undefined;
    if (session?.actor === transcript.call.actor && typeof session.activeScope === "string" && session.activeScope) {
      put(
        "add",
        "session_presence",
        session.activeScope,
        transcript.session,
        presenceBody(transcript.call.actor, transcript.session)
      );
    }
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

/** One compact, owner-produced roster row. The shape matches the catalog's
 * historical who result so woocode can render it without dereferencing each
 * actor across scopes. */
export type RoomRosterRow = {
  player: string;
  name: string;
  connected: boolean;
  connected_at: number | null;
  connected_seconds: number | null;
  idle_seconds: number | null;
  last_login_at: number | null;
  location: string;
  location_name: string;
  presence: "awake" | "idle" | "sleeping";
};

/** Reduce the room owner's complete presence relation into one bounded value.
 * Expired rows are excluded even before the asynchronous reaper retracts them.
 * Multiple live sessions for one actor collapse to one row. */
export function roomRosterRows(
  relations: Iterable<RelationRow>,
  room: string,
  roomName: string,
  now: number
): RoomRosterRow[] {
  const byActor = new Map<string, { name: string; started: number }>();
  for (const row of relations) {
    if (row.relation !== "session_presence" || row.owner !== room) continue;
    const body = row.body as SessionPresenceBody | undefined;
    if (!body || typeof body.actor !== "string") continue;
    const session = body.session as { actor?: unknown; started?: unknown; expiresAt?: unknown; activeScope?: unknown } | undefined;
    if (!session || session.actor !== body.actor || session.activeScope !== room) continue;
    if (typeof session.expiresAt === "number" && session.expiresAt <= now) continue;
    const started = typeof session.started === "number" ? session.started : now;
    const prior = byActor.get(body.actor);
    byActor.set(body.actor, {
      name: typeof body.name === "string" && body.name ? body.name : prior?.name ?? body.actor,
      started: prior ? Math.min(prior.started, started) : started
    });
  }
  return [...byActor.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([actor, entry]) => ({
    player: actor,
    name: entry.name,
    connected: true,
    connected_at: entry.started,
    connected_seconds: Math.max(0, Math.floor((now - entry.started) / 1000)),
    idle_seconds: 0,
    last_login_at: entry.started,
    location: room,
    location_name: roomName,
    presence: "awake"
  }));
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
 * hydration). Presence rows are preserved untouched, deliberately: a
 * presence row lives at the ROOM's scope while its defining session cell
 * lives at the actor's CLUSTER (CO14), so a local scan cannot see the
 * defining fact — a cross-scope presence rebuild would be the CO9 dual
 * write. Presence re-derives through its one write path (transition
 * commits + /net/relate delivery); single-scope worlds rebuild both from
 * the same store because everything anchors together there.
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
