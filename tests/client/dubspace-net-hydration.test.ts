import { describe, expect, it } from "vitest";
import { installedDubspaceSupportsControlsView, isAgedDubspaceControlsError, readAgedDubspaceControlCells } from "../../src/client/dubspace-net-hydration";

const roles = {
  slots: ["slot_1", "slot_2", "slot_3", "slot_4"],
  channel: "channel_1",
  filter: "filter_1",
  delay: "delay_1",
  drum: "drum_1",
  scene: "default_scene"
};

describe("aged Dubspace net hydration", () => {
  it("requires authoritative installed-version evidence before calling controls_view", () => {
    expect(installedDubspaceSupportsControlsView(undefined)).toBe(false);
    expect(installedDubspaceSupportsControlsView([{ alias: "dubspace", version: "1.0.1" }])).toBe(false);
    expect(installedDubspaceSupportsControlsView([{ catalog: "dubspace", version: "1.0.2" }])).toBe(true);
    expect(installedDubspaceSupportsControlsView([{ alias: "dubspace", version: "2.0.0" }])).toBe(true);
    expect(installedDubspaceSupportsControlsView([{ alias: "dubspace", version: "new" }])).toBe(false);
  });

  it("recognizes only missing-view compatibility failures", () => {
    expect(isAgedDubspaceControlsError({ code: "E_VERBNF" })).toBe(true);
    expect(isAgedDubspaceControlsError({ detail: { code: "E_BUDGET" } })).toBe(true);
    expect(isAgedDubspaceControlsError({ code: "E_PERM" })).toBe(false);
  });

  it("reads the fixed 27-cell surface with bounded pacing and preserves false and zero", async () => {
    const requested: string[] = [];
    const waits: number[] = [];
    const view = await readAgedDubspaceControlCells({
      space: "the_dubspace",
      roles,
      nameOf: (id) => `name:${id}`,
      wait: async (ms) => { waits.push(ms); },
      readCell: async (key) => {
        requested.push(key);
        const property = key.slice(key.lastIndexOf(":") + 1);
        return { value: { value: property === "playing" ? false : property === "started_at" ? 0 : property === "pattern" ? { kick: [true, false] } : 1 } };
      }
    });
    expect(requested).toHaveLength(27);
    expect(new Set(requested).size).toBe(27);
    expect(waits).toEqual(Array(26).fill(25));
    expect(view.space).toEqual({ id: "the_dubspace", name: "name:the_dubspace" });
    expect(view.controls).toHaveLength(8);
    expect(view.controls.find((control) => control.id === "slot_1")?.props.playing).toBe(false);
    expect(view.controls.find((control) => control.id === "drum_1")?.props.started_at).toBe(0);
    expect(view.controls.find((control) => control.id === "drum_1")?.props.pattern).toEqual({ kick: [true, false] });
  });

  it("uses declared defaults for sparse cells and lets materialized cells override them", async () => {
    const view = await readAgedDubspaceControlCells({
      space: "the_dubspace",
      roles,
      defaults: {
        drum_1: { bpm: 118, playing: false, started_at: 0, step_count: 8, pattern: { kick: [true, false] } }
      },
      wait: async () => {},
      readCell: async (key) => key === "property_cell:drum_1:bpm" ? { value: { value: 132 } } : null
    });
    const drum = view.controls.find((control) => control.id === "drum_1")?.props;
    expect(drum).toMatchObject({ bpm: 132, playing: false, started_at: 0, step_count: 8, pattern: { kick: [true, false] } });
  });

  it("leaves missing cells absent so the caller's completeness gate rejects the view", async () => {
    const view = await readAgedDubspaceControlCells({
      space: "the_dubspace",
      roles,
      wait: async () => {},
      readCell: async (key) => key === "property_cell:drum_1:pattern" ? null : { value: { value: false } }
    });
    expect(view.controls.find((control) => control.id === "drum_1")?.props).not.toHaveProperty("pattern");
  });

  it("backs off boundedly for E_RATE without hiding other read failures", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const view = await readAgedDubspaceControlCells({
      space: "the_dubspace",
      roles: { drum: "drum_1" },
      defaults: { drum_1: { pattern: { kick: [true] } } },
      wait: async (ms) => { waits.push(ms); },
      readCell: async () => {
        attempts += 1;
        if (attempts === 1) throw { code: "E_RATE" };
        return null;
      }
    });
    expect(attempts).toBe(6);
    expect(waits).toEqual([250, 25, 25, 25, 25]);
    expect(view.controls[0]?.props.pattern).toEqual({ kick: [true] });

    await expect(readAgedDubspaceControlCells({
      space: "the_dubspace",
      roles: { drum: "drum_1" },
      wait: async () => {},
      readCell: async () => { throw { code: "E_PERM" }; }
    })).rejects.toMatchObject({ code: "E_PERM" });
  });
});
