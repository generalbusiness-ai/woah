import { describe, expect, it } from "vitest";
import { clearProvisionalChatLines, provisionalChatErrorLine, upsertProvisionalChatLine } from "../src/client/provisional-chat";
import type { ChatLine } from "../catalogs/chat/ui/chat-space";

describe("provisional chat lines", () => {
  it("builds a retractable provisional error line for a turn", () => {
    expect(provisionalChatErrorLine({
      turnId: "drop-1",
      source: "the_deck",
      error: { code: "E_OBJNF", message: "object not found: the_towel" },
      ts: 10
    })).toEqual({
      kind: "error",
      turnId: "drop-1",
      provisional: true,
      source: "the_deck",
      text: "object not found: the_towel",
      ts: 10
    });
  });

  it("replaces prior provisional output for the same turn", () => {
    const first = provisionalChatErrorLine({
      turnId: "drop-1",
      source: "the_deck",
      error: { message: "object not found: the_towel" },
      ts: 10
    });
    const second = provisionalChatErrorLine({
      turnId: "drop-1",
      source: "the_deck",
      error: { message: "temporary lookup miss" },
      ts: 11
    });

    expect(upsertProvisionalChatLine([first], second, 160)).toEqual([second]);
  });

  it("clears only superseded provisional output for the authoritative turn", () => {
    const feed: ChatLine[] = [
      { kind: "input", source: "the_deck", text: "drop towel", ts: 9 },
      provisionalChatErrorLine({
        turnId: "drop-1",
        source: "the_deck",
        error: { message: "object not found: the_towel" },
        ts: 10
      }),
      { kind: "error", source: "the_deck", turnId: "drop-1", text: "final error", ts: 12 },
      provisionalChatErrorLine({
        turnId: "look-1",
        source: "the_deck",
        error: { message: "object not found: the_lamp" },
        ts: 13
      })
    ];

    const cleared = clearProvisionalChatLines(feed, "drop-1");

    expect(cleared.removed).toBe(true);
    expect(cleared.feed.map((line) => line.text)).toEqual([
      "drop towel",
      "final error",
      "object not found: the_lamp"
    ]);
  });
});
