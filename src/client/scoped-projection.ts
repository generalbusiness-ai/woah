export type ProjectionCursor = {
  spaces?: Record<string, { next_seq?: number }>;
  live?: { resumable?: boolean };
};

export type ScopedProjectionStateModel = {
  me?: any;
  catalogs?: any;
  cursor?: ProjectionCursor;
  self?: any;
  session?: any;
  here?: any;
  inventory: any[];
  overlays: Record<string, any>;
  overlaySnapshots?: Record<string, any>;
  error?: string;
};

export function idsFromRefsOrSummaries(value: any[]): string[] {
  return (Array.isArray(value) ? value : []).map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object" && !Array.isArray(item) && typeof item.id === "string") return item.id;
    return String(item ?? "");
  }).filter(Boolean);
}

export function scopedHerePresentActors(here: any): string[] {
  return idsFromRefsOrSummaries(Array.isArray(here?.roster) ? here.roster : Array.isArray(here?.present_actors) ? here.present_actors : []);
}

/** Resolve the optional object rows surrounding a room without coupling the
 * room's identity to a moment-in-time contents relation. Presence actors belong
 * to the roster, and any other member may move before its authorized read
 * completes; either case must not make the room projection disappear. */
export async function resolveOptionalRoomContents<T>(
  contentRows: readonly { member?: unknown }[],
  roster: readonly unknown[],
  read: (id: string) => Promise<T | undefined>
): Promise<Awaited<T>[]> {
  const rosterIds = new Set(idsFromRefsOrSummaries([...roster]));
  const contentIds = Array.from(new Set(contentRows
    .map((row) => row.member)
    .filter((id): id is string => typeof id === "string" && id.length > 0 && !rosterIds.has(id))));
  const summaries = await Promise.allSettled(contentIds.map((id) => read(id)));
  const resolved: Awaited<T>[] = [];
  for (const item of summaries) {
    if (item.status === "fulfilled" && item.value !== undefined) resolved.push(item.value as Awaited<T>);
  }
  return resolved;
}

// `who` puts roster at the top level of the observation; `looked` (built by
// chat's `:look_at`) nests the room view — including its roster — under
// `look`. The look-derived list is only meaningful
// when the looker was looking at the room itself; `look at <object>`
// dispatches to the target's own `look_self`, whose roster (if any) belongs
// to that target, not the looker's room. present_actors is accepted only as
// an input compatibility fallback while old catalog snapshots drain.
export function presentActorsFromObservation(observation: any): string[] {
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) return [];
  if (Array.isArray(observation.roster)) return idsFromRefsOrSummaries(observation.roster);
  if (Array.isArray(observation.present_actors)) return idsFromRefsOrSummaries(observation.present_actors);
  if (String(observation.type ?? "") !== "looked") return [];
  const room = typeof observation.room === "string" ? observation.room : "";
  const target = typeof observation.target === "string" ? observation.target : "";
  if (target && target !== room) return [];
  const view = observation.look;
  if (!view || typeof view !== "object" || Array.isArray(view)) return [];
  const roster = Array.isArray(view.roster) ? view.roster : Array.isArray(view.present_actors) ? view.present_actors : [];
  return idsFromRefsOrSummaries(roster);
}

export function scopedModelWithHere(model: ScopedProjectionStateModel, here: any): ScopedProjectionStateModel {
  const cursor = cursorWithHereSnapshot(model.cursor, here);
  const me = model.me && typeof model.me === "object" && !Array.isArray(model.me)
    ? { ...model.me, here, cursor }
    : model.me;
  return { ...model, me, here, cursor };
}

export function scopedModelWithActiveScope(model: ScopedProjectionStateModel, room: string): ScopedProjectionStateModel {
  if (!model.session) return model;
  const session = { ...model.session, active_scope: room, current_location: room };
  const me = model.me && typeof model.me === "object" && !Array.isArray(model.me)
    ? { ...model.me, session }
    : model.me;
  return { ...model, me, session };
}

/** @deprecated Use scopedModelWithActiveScope. */
export const scopedModelWithCurrentLocation = scopedModelWithActiveScope;

export function scopedModelWithMoveResult(model: ScopedProjectionStateModel, result: any): ScopedProjectionStateModel {
  if (!result || typeof result !== "object" || Array.isArray(result)) return model;
  let next = model;
  const hasHereSnapshot = result.here && typeof result.here === "object" && !Array.isArray(result.here);
  if (hasHereSnapshot) next = scopedModelWithHere(next, result.here);
  if (typeof result.room === "string") {
    next = scopedModelWithActiveScope(next, result.room);
    const hereId = typeof next.here?.id === "string" ? next.here.id : "";
    if (!hasHereSnapshot && hereId && hereId !== result.room) {
      next = scopedModelWithHere(next, null);
    }
  }
  return next;
}

export function advanceProjectionCursor(cursor: ProjectionCursor | undefined, space: string, seq: number): ProjectionCursor | undefined {
  if (!space || !Number.isFinite(seq)) return cursor;
  const nextSeq = Math.floor(seq) + 1;
  const current = cursor?.spaces?.[space]?.next_seq;
  if (typeof current === "number" && current >= nextSeq) return cursor;
  return {
    ...(cursor ?? {}),
    spaces: {
      ...(cursor?.spaces ?? {}),
      [space]: { next_seq: nextSeq }
    },
    live: cursor?.live ?? { resumable: false }
  };
}

function cursorWithHereSnapshot(cursor: ProjectionCursor | undefined, here: any): ProjectionCursor | undefined {
  const space = typeof here?.id === "string" ? here.id : "";
  const nextSeq = Number(here?.props?.next_seq);
  if (!space || !Number.isFinite(nextSeq)) return cursor;
  const current = cursor?.spaces?.[space]?.next_seq;
  if (typeof current === "number" && current >= nextSeq) return cursor;
  return {
    ...(cursor ?? {}),
    spaces: {
      ...(cursor?.spaces ?? {}),
      [space]: { next_seq: nextSeq }
    },
    live: cursor?.live ?? { resumable: false }
  };
}
