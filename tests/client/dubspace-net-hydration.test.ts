import { describe, expect, it } from "vitest";
import { isAgedDubspaceControlsError, readAgedDubspaceControlCells } from "../../src/client/dubspace-net-hydration";

const roles = {
  slots: ["slot_1", "slot_2", "slot_3", "slot_4"],
  channel: "channel_1",
  filter: "filter_1",
  delay: "delay_1",
  drum: "drum_1",
  scene: "default_scene"
};

describe("aged Dubspace net hydration", () => {
  it("recognizes only missing-view compatibility failures", () => {
    expect(isAgedDubspaceControlsError({ code: "E_VERBNF" })).toBe(true);
    expect(isAgedDubspaceControlsError({ detail: { code: "E_BUDGET" } })).toBe(true);
    expect(isAgedDubspaceControlsError({ code: "E_PERM" })).toBe(false);
  });

  it("reads the fixed 27-cell surface in parallel and preserves false and zero", async () => {
    const requested: string[] = [];
    let released = false;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const pending = readAgedDubspaceControlCells({
      space: "the_dubspace",
      roles,
      nameOf: (id) => `name:${id}`,
      readCell: async (key) => {
        requested.push(key);
        if (requested.length === 27) {
          released = true;
          release();
        }
        await barrier;
        const property = key.slice(key.lastIndexOf(":") + 1);
        return { value: { value: property === "playing" ? false : property === "started_at" ? 0 : property === "pattern" ? { kick: [true, false] } : 1 } };
      }
    });
    await barrier;
    expect(released).toBe(true);
    expect(requested).toHaveLength(27);
    expect(new Set(requested).size).toBe(27);
    const view = await pending;
    expect(view.space).toEqual({ id: "the_dubspace", name: "name:the_dubspace" });
    expect(view.controls).toHaveLength(8);
    expect(view.controls.find((control) => control.id === "slot_1")?.props.playing).toBe(false);
    expect(view.controls.find((control) => control.id === "drum_1")?.props.started_at).toBe(0);
    expect(view.controls.find((control) => control.id === "drum_1")?.props.pattern).toEqual({ kick: [true, false] });
  });

  it("leaves missing cells absent so the caller's completeness gate rejects the view", async () => {
    const view = await readAgedDubspaceControlCells({
      space: "the_dubspace",
      roles,
      readCell: async (key) => key === "property_cell:drum_1:pattern" ? null : { value: { value: false } }
    });
    expect(view.controls.find((control) => control.id === "drum_1")?.props).not.toHaveProperty("pattern");
  });
});
