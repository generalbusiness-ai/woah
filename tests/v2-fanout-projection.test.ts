import { describe, expect, it } from "vitest";

import type { EffectTranscript } from "../src/core/effect-transcript";
import type { ShadowLiveEvent } from "../src/core/shadow-browser-node";
import {
  affectedBrowserFanoutScopes,
  affectedMcpFanoutScopes,
  affectedTranscriptScopes,
  computedShadowLiveAudience,
  shadowLiveEventMatchesPeerScope,
  withComputedLiveAudience
} from "../src/core/v2-fanout-projection";

function makeTranscript(partial: Partial<EffectTranscript> = {}): EffectTranscript {
  return {
    kind: "woo.effect_transcript.shadow.v1",
    route: "sequenced",
    scope: "origin_scope",
    seq: 1,
    call: { actor: "guest_1", target: "the_chatroom", verb: "say", args: ["hi"] },
    reads: [],
    writes: [],
    creates: [],
    moves: [],
    observations: [],
    logicalInputs: [],
    untrackedEffects: [],
    complete: true,
    incompleteReasons: [],
    hash: "",
    ...partial
  } as EffectTranscript;
}

describe("affectedTranscriptScopes", () => {
  it("always includes the originating scope and returns a sorted unique list", () => {
    expect(affectedTranscriptScopes("origin_scope", makeTranscript())).toEqual(["origin_scope"]);
  });

  it("adds move endpoints (from/to)", () => {
    const transcript = makeTranscript({
      moves: [
        { object: "guest_1", from: "the_chatroom", to: "the_deck" } as EffectTranscript["moves"][number]
      ]
    });
    expect(affectedTranscriptScopes("origin_scope", transcript)).toEqual(["origin_scope", "the_chatroom", "the_deck"]);
  });

  it("adds create.location", () => {
    const transcript = makeTranscript({
      creates: [
        { object: "pin_42", location: "the_pinboard" } as EffectTranscript["creates"][number]
      ]
    });
    expect(affectedTranscriptScopes("origin_scope", transcript)).toContain("the_pinboard");
  });

  it("adds contents-write objects and subscriber-prop objects, ignores unrelated prop writes", () => {
    const transcript = makeTranscript({
      writes: [
        { cell: { kind: "contents", object: "the_lobby" }, value: [] } as unknown as EffectTranscript["writes"][number],
        { cell: { kind: "prop", object: "the_chatroom", name: "session_subscribers" }, value: [] } as unknown as EffectTranscript["writes"][number],
        { cell: { kind: "prop", object: "the_deck", name: "subscribers" }, value: [] } as unknown as EffectTranscript["writes"][number],
        { cell: { kind: "prop", object: "guest_1", name: "name" }, value: "Alice" } as unknown as EffectTranscript["writes"][number]
      ]
    });
    const result = affectedTranscriptScopes("origin_scope", transcript);
    expect(result).toContain("the_lobby");
    expect(result).toContain("the_chatroom");
    expect(result).toContain("the_deck");
    expect(result).not.toContain("guest_1");
  });

  it("deduplicates scopes shared across moves/creates/writes", () => {
    const transcript = makeTranscript({
      moves: [{ object: "guest_1", from: "the_chatroom", to: "the_deck" } as EffectTranscript["moves"][number]],
      creates: [{ object: "pin_42", location: "the_chatroom" } as EffectTranscript["creates"][number]],
      writes: [{ cell: { kind: "contents", object: "the_deck" }, value: [] } as unknown as EffectTranscript["writes"][number]]
    });
    const result = affectedTranscriptScopes("origin_scope", transcript);
    expect(result).toEqual(["origin_scope", "the_chatroom", "the_deck"]);
  });
});

describe("affectedMcpFanoutScopes and affectedBrowserFanoutScopes", () => {
  it("are intent-named aliases of affectedTranscriptScopes", () => {
    const transcript = makeTranscript({
      moves: [{ object: "guest_1", from: "the_chatroom", to: "the_deck" } as EffectTranscript["moves"][number]]
    });
    const base = affectedTranscriptScopes("origin_scope", transcript);
    expect(affectedMcpFanoutScopes("origin_scope", transcript)).toEqual(base);
    expect(affectedBrowserFanoutScopes("origin_scope", transcript)).toEqual(base);
  });
});

describe("computedShadowLiveAudience", () => {
  it("returns null when both actor and session lists are empty", () => {
    expect(computedShadowLiveAudience([], [])).toBeNull();
    expect(computedShadowLiveAudience(["", ""], ["", ""])).toBeNull();
  });

  it("omits empty fields and dedupes", () => {
    expect(computedShadowLiveAudience(["guest_1", "guest_1"], [])).toEqual({ actors: ["guest_1"] });
    expect(computedShadowLiveAudience([], ["session_x", "session_x", "session_y"])).toEqual({
      sessions: ["session_x", "session_y"]
    });
    expect(computedShadowLiveAudience(["guest_1"], ["session_x"])).toEqual({
      actors: ["guest_1"],
      sessions: ["session_x"]
    });
  });
});

describe("withComputedLiveAudience", () => {
  const baseEvent = { kind: "woo.live_event.shadow.v1", type: "said", scope: "the_chatroom" } as unknown as ShadowLiveEvent;

  it("attaches a recomputed audience when there is one", () => {
    const result = withComputedLiveAudience(baseEvent, ["guest_1"], []);
    expect(result).toEqual({ ...baseEvent, audience: { actors: ["guest_1"] } });
  });

  it("returns null when the recomputed audience would be empty", () => {
    expect(withComputedLiveAudience(baseEvent, [], [])).toBeNull();
  });
});

describe("shadowLiveEventMatchesPeerScope", () => {
  const peer = { sessionId: "session_x", actor: "guest_1", scope: "the_chatroom" };

  it("matches when audience names the peer's session", () => {
    const event = { audience: { sessions: ["session_x"] } } as unknown as ShadowLiveEvent;
    expect(shadowLiveEventMatchesPeerScope(event, peer)).toBe(true);
  });

  it("matches when audience names the peer's actor", () => {
    const event = { audience: { actors: ["guest_1"] } } as unknown as ShadowLiveEvent;
    expect(shadowLiveEventMatchesPeerScope(event, peer)).toBe(true);
  });

  it("does not fall back to event.scope when audience targets a different actor", () => {
    // Privacy guarantee: an actor/session-only audience must not become a
    // room broadcast just because event.scope happens to match the peer.
    const event = { scope: "the_chatroom", audience: { actors: ["guest_other"] } } as unknown as ShadowLiveEvent;
    expect(shadowLiveEventMatchesPeerScope(event, peer)).toBe(false);
  });

  it("matches when audience.scope equals the peer's scope", () => {
    const event = { audience: { scope: "the_chatroom" } } as unknown as ShadowLiveEvent;
    expect(shadowLiveEventMatchesPeerScope(event, peer)).toBe(true);
    const wrongScope = { audience: { scope: "the_deck" } } as unknown as ShadowLiveEvent;
    expect(shadowLiveEventMatchesPeerScope(wrongScope, peer)).toBe(false);
  });

  it("falls back to event.scope when there is no audience", () => {
    const event = { scope: "the_chatroom" } as unknown as ShadowLiveEvent;
    expect(shadowLiveEventMatchesPeerScope(event, peer)).toBe(true);
    const otherScope = { scope: "the_deck" } as unknown as ShadowLiveEvent;
    expect(shadowLiveEventMatchesPeerScope(otherScope, peer)).toBe(false);
  });
});
