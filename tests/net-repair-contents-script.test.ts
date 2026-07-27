import { describe, expect, it } from "vitest";
import { addedRowCount, parseRepairArgs, unplacedOwners } from "../scripts/net-repair-contents";

describe("net contents repair operator driver", () => {
  it("counts only server-confirmed additions", () => {
    expect(addedRowCount(JSON.stringify({ ok: true, status: "empty", changed: [] }))).toBe(0);
    expect(addedRowCount(JSON.stringify({
      ok: true,
      status: "applied",
      changed: ["relation:contents:the_hall:task_1", "relation:contents:the_hall:task_2"]
    }))).toBe(2);
  });

  it("surfaces owners the scope could not place so the operator can re-run with a mapping", () => {
    expect(unplacedOwners(JSON.stringify({ ok: true, unplaced: [] }))).toEqual([]);
    expect(unplacedOwners(JSON.stringify({ ok: true, unplaced: ["the_hall", "the_deck"] })))
      .toEqual(["the_hall", "the_deck"]);
    // A reply from an older worker that reports nothing must read as "none",
    // never as a crash on the operator's side.
    expect(unplacedOwners(JSON.stringify({ ok: true }))).toEqual([]);
  });

  it("consumes --owner-scope's value so a mapping is never read as a scope name", () => {
    const parsed = parseRepairArgs([
      "https://worker.example",
      "room:the_hall",
      "--owner-scope", "the_deck=room:the_deck",
      "cluster:alice",
      "--dry-run"
    ]);
    expect(parsed.scopes).toEqual(["https://worker.example", "room:the_hall", "cluster:alice"]);
    expect(parsed.ownerScopes).toEqual({ the_deck: "room:the_deck" });
    expect(parsed.dryRun).toBe(true);
    expect(parsed.allSeeded).toBe(false);
  });

  it("refuses a malformed mapping and an unknown flag rather than guessing", () => {
    expect(() => parseRepairArgs(["u", "--owner-scope", "the_deck"])).toThrow(/<object>=<scope>/);
    expect(() => parseRepairArgs(["u", "--owner-scope", "=room:x"])).toThrow(/<object>=<scope>/);
    expect(() => parseRepairArgs(["u", "--owner-scope", "the_deck="])).toThrow(/<object>=<scope>/);
    expect(() => parseRepairArgs(["u", "--all"])).toThrow(/unknown flag/);
  });
});
