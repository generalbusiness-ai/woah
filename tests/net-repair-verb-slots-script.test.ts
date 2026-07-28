// The repair:net-verb-slots driver's pure helpers (no network).
import { describe, expect, it } from "vitest";
import { parseRepairVerbSlotArgs, remainingObjectCount, repairedCellCount } from "../scripts/net-repair-verb-slots";

describe("net-repair-verb-slots driver", () => {
  it("counts only server-confirmed rewrites, so a replay reports zero", () => {
    expect(repairedCellCount(JSON.stringify({ status: "applied", changed: ["verb_bytecode:a:x", "verb_bytecode:a:y"] }))).toBe(2);
    expect(repairedCellCount(JSON.stringify({ status: "empty", changed: [] }))).toBe(0);
    expect(repairedCellCount(JSON.stringify({ status: "empty" }))).toBe(0);
  });

  it("reads the per-request cap's leftover so the operator knows to run again", () => {
    expect(remainingObjectCount(JSON.stringify({ remaining: 7 }))).toBe(7);
    expect(remainingObjectCount(JSON.stringify({}))).toBe(0);
  });

  it("parses flags without swallowing scope names", () => {
    // `--object` consumes its value, so an object id can never be read as a
    // positional scope (the mistake that would send a repair to the wrong DO).
    expect(parseRepairVerbSlotArgs(["https://w", "room:a", "--object", "box_1", "cluster:b", "--dry-run"]))
      .toEqual({ scopes: ["https://w", "room:a", "cluster:b"], objects: ["box_1"], dryRun: true, allSeeded: false });
    expect(parseRepairVerbSlotArgs(["https://w", "--all-seeded"]))
      .toEqual({ scopes: ["https://w"], objects: [], dryRun: false, allSeeded: true });
    expect(() => parseRepairVerbSlotArgs(["--object", "--dry-run"])).toThrow(/--object expects/);
    expect(() => parseRepairVerbSlotArgs(["--nope"])).toThrow(/unknown flag/);
  });
});
