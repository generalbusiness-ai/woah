import { describe, expect, it } from "vitest";
import { changedRelationCount } from "../scripts/net-repair-relations";

describe("net relation repair operator reporting", () => {
  it("counts only server-confirmed changes, not requested replay rows", () => {
    expect(changedRelationCount(JSON.stringify({ ok: true, status: "empty", changed: [] }))).toBe(0);
    expect(changedRelationCount(JSON.stringify({
      ok: true,
      status: "applied",
      changed: ["relation:contents:the_deck:the_pinboard", "relation:contents:the_chatroom:the_dubspace"]
    }))).toBe(2);
  });
});
