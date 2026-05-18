import { describe, expect, it } from "vitest";

import { chatObservationSpace, updateEnteredLeftChatPresence } from "../src/client/chat-state";

describe("client chat presence state", () => {
  it("normalizes room-like observation fields before comparing chat space", () => {
    expect(chatObservationSpace({ type: "pinboard_entered", board: "the_pinboard", source: "the_chatroom" })).toBe("the_pinboard");
    expect(chatObservationSpace({ type: "dubspace_entered", space: "the_dubspace", source: "the_chatroom" })).toBe("the_dubspace");
    expect(chatObservationSpace({ type: "entered", source: "the_deck" })).toBe("the_deck");
  });

  it("does not re-add a departed actor from an entered event in another space", () => {
    const left = updateEnteredLeftChatPresence(
      ["guest_alice", "guest_bob"],
      { type: "left", room: "the_chatroom", source: "the_chatroom", actor: "guest_alice" },
      "the_chatroom"
    );
    expect(left.present).toEqual(["guest_bob"]);
    expect(left.shouldPushChatLine).toBe(true);

    const remoteEntered = updateEnteredLeftChatPresence(
      left.present,
      { type: "entered", room: "the_deck", source: "the_deck", actor: "guest_alice" },
      "the_chatroom"
    );
    expect(remoteEntered.present).toEqual(["guest_bob"]);
    expect(remoteEntered.shouldPushChatLine).toBe(false);
  });
});
