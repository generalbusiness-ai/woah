import { describe, expect, it } from "vitest";
import { pinboardObservationsNeedNotesRefresh } from "../src/client/pinboard-refresh";

describe("pinboard refresh decisions", () => {
  it("refreshes when pin_added lacks same-frame note hydration", () => {
    expect(pinboardObservationsNeedNotesRefresh([{ type: "pin_added", pin: "pin_a" }])).toBe(true);
  });

  it("skips refresh when pin_added and note_added hydrate the same pin", () => {
    expect(pinboardObservationsNeedNotesRefresh([
      { type: "pin_added", pin: "pin_a" },
      { type: "note_added", note: { id: "pin_a", text: "ready" } }
    ])).toBe(false);
  });

  it("refreshes when pin_added and note_added refer to different pins", () => {
    expect(pinboardObservationsNeedNotesRefresh([
      { type: "pin_added", pin: "pin_a" },
      { type: "note_added", note: { id: "pin_b", text: "ready" } }
    ])).toBe(true);
  });

  it("does not refresh for hydrated note edits", () => {
    expect(pinboardObservationsNeedNotesRefresh([{ type: "note_edited", pin: "pin_a", text: "done" }])).toBe(false);
  });
});
