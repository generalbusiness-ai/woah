import { describe, expect, it } from "vitest";

import {
  advanceProjectionCursor,
  idsFromRefsOrSummaries,
  scopedHerePresentActors,
  scopedModelWithMoveResult,
  type ScopedProjectionStateModel
} from "../src/client/scoped-projection";

describe("scoped client projection helpers", () => {
  it("applies move-result here snapshots without mutating the original /api/me snapshot", () => {
    const me = {
      session: { id: "session_1", actor: "guest_1", current_location: "room_a", all_locations: ["room_a"] },
      here: { id: "room_a", name: "Room A", present_actors: [{ id: "guest_1", name: "Guest One" }] },
      cursor: { spaces: { room_a: { next_seq: 5 } }, live: { resumable: false } }
    };
    const model: ScopedProjectionStateModel = {
      me,
      cursor: me.cursor,
      session: me.session,
      here: me.here,
      inventory: [],
      overlays: {}
    };
    const nextHere = {
      id: "room_b",
      name: "Room B",
      props: { next_seq: 8 },
      present_actors: [{ id: "guest_1", name: "Guest One" }, { id: "guest_2", name: "Guest Two" }]
    };

    const next = scopedModelWithMoveResult(model, { room: "room_b", here: nextHere });

    expect(next).not.toBe(model);
    expect(next.me).not.toBe(me);
    expect(next.session).toMatchObject({ current_location: "room_b" });
    expect(next.me?.session).toMatchObject({ current_location: "room_b" });
    expect(next.here).toBe(nextHere);
    expect(next.cursor?.spaces?.room_a?.next_seq).toBe(5);
    expect(next.cursor?.spaces?.room_b?.next_seq).toBe(8);
    expect(me.session.current_location).toBe("room_a");
    expect(me.here.id).toBe("room_a");
    expect(scopedHerePresentActors(next.here)).toEqual(["guest_1", "guest_2"]);
  });

  it("advances replay cursors monotonically from sequenced frames", () => {
    const cursor = { spaces: { room_a: { next_seq: 5 } }, live: { resumable: false } };

    expect(advanceProjectionCursor(cursor, "room_a", 3)).toBe(cursor);
    expect(advanceProjectionCursor(cursor, "room_a", 6)?.spaces?.room_a?.next_seq).toBe(7);
    expect(advanceProjectionCursor(cursor, "room_b", 1)?.spaces?.room_b?.next_seq).toBe(2);
  });

  it("normalizes mixed ref and summary arrays", () => {
    expect(idsFromRefsOrSummaries(["guest_1", { id: "guest_2", name: "Guest Two" }, null])).toEqual(["guest_1", "guest_2"]);
  });
});
