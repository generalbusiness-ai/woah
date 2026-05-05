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
  return idsFromRefsOrSummaries(Array.isArray(here?.present_actors) ? here.present_actors : []);
}

export function scopedModelWithHere(model: ScopedProjectionStateModel, here: any): ScopedProjectionStateModel {
  const cursor = cursorWithHereSnapshot(model.cursor, here);
  const me = model.me && typeof model.me === "object" && !Array.isArray(model.me)
    ? { ...model.me, here, cursor }
    : model.me;
  return { ...model, me, here, cursor };
}

export function scopedModelWithCurrentLocation(model: ScopedProjectionStateModel, room: string): ScopedProjectionStateModel {
  if (!model.session) return model;
  const session = { ...model.session, current_location: room };
  const me = model.me && typeof model.me === "object" && !Array.isArray(model.me)
    ? { ...model.me, session }
    : model.me;
  return { ...model, me, session };
}

export function scopedModelWithMoveResult(model: ScopedProjectionStateModel, result: any): ScopedProjectionStateModel {
  if (!result || typeof result !== "object" || Array.isArray(result)) return model;
  let next = model;
  if (result.here && typeof result.here === "object" && !Array.isArray(result.here)) next = scopedModelWithHere(next, result.here);
  if (typeof result.room === "string") next = scopedModelWithCurrentLocation(next, result.room);
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
