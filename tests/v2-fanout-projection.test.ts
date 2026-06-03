import { describe, expect, it } from "vitest";

import type { EffectTranscript } from "../src/core/effect-transcript";
import type { ShadowLiveEvent } from "../src/core/shadow-browser-node";
import {
  affectedBrowserFanoutScopes,
  affectedMcpFanoutScopes,
  affectedTranscriptScopes,
  buildV2FanoutLiveEvents,
  computedShadowLiveAudience,
  planV2BrowserFanout,
  shadowLiveEventMatchesPeerScope,
  withComputedLiveAudience,
  type V2FanoutPeer
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

  it("adds contents writes and metadata-declared presence projection props, ignores unrelated prop writes", () => {
    const transcript = makeTranscript({
      writes: [
        { cell: { kind: "contents", object: "the_lobby" }, value: [] } as unknown as EffectTranscript["writes"][number],
        { cell: { kind: "prop", object: "the_chatroom", name: "custom_session_roster" }, value: [] } as unknown as EffectTranscript["writes"][number],
        { cell: { kind: "prop", object: "the_deck", name: "custom_actor_roster" }, value: [] } as unknown as EffectTranscript["writes"][number],
        { cell: { kind: "prop", object: "legacy_room", name: "subscribers" }, value: [] } as unknown as EffectTranscript["writes"][number],
        { cell: { kind: "prop", object: "guest_1", name: "name" }, value: "Alice" } as unknown as EffectTranscript["writes"][number]
      ]
    });
    const result = affectedTranscriptScopes("origin_scope", transcript, (object, property) =>
      (object === "the_chatroom" && property === "custom_session_roster") ||
      (object === "the_deck" && property === "custom_actor_roster")
    );
    expect(result).toContain("the_lobby");
    expect(result).toContain("the_chatroom");
    expect(result).toContain("the_deck");
    expect(result).not.toContain("legacy_room");
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

describe("buildV2FanoutLiveEvents", () => {
  it("recomputes each observation's audience from the host's per-observation lists and drops unaddressable events", () => {
    const transcript = makeTranscript({
      scope: "the_chatroom",
      observations: [
        { type: "said", source: "the_chatroom", actor: "guest_1", text: "hi" },
        { type: "secret", source: "the_chatroom", actor: "guest_1", text: "psst" }
      ] as unknown as EffectTranscript["observations"]
    });
    // Observation 0 is heard by guest_2; observation 1 has no present recipient.
    const events = buildV2FanoutLiveEvents("relay:node", transcript, {
      observationAudiences: [["guest_2"], []],
      observationSessionAudiences: [["session_2"], []]
    });
    // The unaddressable second observation is dropped entirely.
    expect(events).toHaveLength(1);
    expect(events[0].observation).toMatchObject({ type: "said", text: "hi" });
    // The audience is the recomputed authoritative one, NOT the transcript's
    // default {scope: source}.
    expect(events[0].audience).toEqual({ actors: ["guest_2"], sessions: ["session_2"] });
  });

  it("returns no events when there are no observations", () => {
    expect(buildV2FanoutLiveEvents("relay:node", makeTranscript(), {})).toEqual([]);
  });
});

describe("planV2BrowserFanout", () => {
  const evChatroom = { id: "e1", scope: "the_chatroom", audience: { scope: "the_chatroom" } } as unknown as ShadowLiveEvent;
  const evEnteredDeck = { id: "e2", scope: "the_deck", audience: { scope: "the_deck" } } as unknown as ShadowLiveEvent;
  const evPrivate = { id: "e3", scope: "the_chatroom", audience: { actors: ["guest_named"] } } as unknown as ShadowLiveEvent;

  function peer(node: string, scope: string, actor = `${node}_actor`, sessionId = `${node}_session`): V2FanoutPeer {
    return { node, sessionId, actor, scope };
  }

  it("delivers a room event only to peers bound to that room, and flags commit-scope peers for state-transfer", () => {
    const plan = planV2BrowserFanout({
      events: [evChatroom],
      commitScope: "the_chatroom",
      peers: [peer("a", "the_chatroom"), peer("b", "the_deck")]
    });
    // Peer a (in the chatroom) receives the event; peer b (in the deck) does not.
    expect(plan.liveDeliveries).toEqual([{ node: "a", events: [evChatroom] }]);
    // Peer a is at the commit scope, so it also re-syncs its projection.
    expect(plan.stateTransferNodes).toEqual(["a"]);
  });

  it("routes a cross-room move's per-room events to the right rooms (the drift this fixes)", () => {
    // A relocation commits at the actor's scope but emits a `left` (source room)
    // and an `entered` (destination room) observation. A peer in the source
    // room gets the source event; a peer in the destination room gets the
    // destination event. The old subscription-of-commit-scope dev path would
    // deliver NEITHER (nobody subscribes to the actor commit scope).
    const evLeftChatroom = { id: "left", scope: "the_chatroom", audience: { scope: "the_chatroom" } } as unknown as ShadowLiveEvent;
    const plan = planV2BrowserFanout({
      events: [evLeftChatroom, evEnteredDeck],
      commitScope: "mover_actor", // relocation commit scope = the moved actor
      peers: [peer("src", "the_chatroom"), peer("dst", "the_deck"), peer("mover", "mover_actor", "mover_actor")],
      originNode: "mover"
    });
    expect(plan.liveDeliveries).toEqual([
      { node: "src", events: [evLeftChatroom] },
      { node: "dst", events: [evEnteredDeck] }
    ]);
    // The only commit-scope peer is the mover itself, which is the origin and
    // therefore excluded — so no state-transfer target.
    expect(plan.stateTransferNodes).toEqual([]);
  });

  it("keeps a private (actor-audience) event off room peers and delivers it only to the named actor", () => {
    const plan = planV2BrowserFanout({
      events: [evPrivate],
      commitScope: "the_chatroom",
      peers: [peer("named", "the_chatroom", "guest_named"), peer("other", "the_chatroom", "guest_other")]
    });
    expect(plan.liveDeliveries).toEqual([{ node: "named", events: [evPrivate] }]);
    // Both peers are at the commit scope, so both re-sync regardless of the
    // private live event.
    expect(plan.stateTransferNodes).toEqual(["named", "other"]);
  });

  it("excludes the origin node and already-delivered nodes from BOTH live delivery and state-transfer", () => {
    const plan = planV2BrowserFanout({
      events: [evChatroom],
      commitScope: "the_chatroom",
      peers: [peer("origin", "the_chatroom"), peer("dup", "the_chatroom"), peer("fresh", "the_chatroom")],
      originNode: "origin",
      alreadyDeliveredNodes: new Set(["dup"])
    });
    expect(plan.liveDeliveries).toEqual([{ node: "fresh", events: [evChatroom] }]);
    expect(plan.stateTransferNodes).toEqual(["fresh"]);
  });
});
