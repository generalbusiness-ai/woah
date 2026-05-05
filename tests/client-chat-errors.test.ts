import { describe, expect, it } from "vitest";

import { appliedFrameErrorObservations, chatErrorText } from "../src/client/chat-errors";

describe("client chat error helpers", () => {
  it("extracts structured errors from applied-frame observations", () => {
    const errors = appliedFrameErrorObservations({
      observations: [
        { type: "said", text: "before" },
        { type: "$error", code: "E_INVARG", message: "You are not carrying towel." },
        { type: "left", actor: "guest_1" }
      ]
    });

    expect(errors).toEqual([{ type: "$error", code: "E_INVARG", message: "You are not carrying towel." }]);
  });

  it("renders a useful message for structured sequenced-call errors", () => {
    expect(chatErrorText({ type: "$error", code: "E_INVARG", message: "You are not carrying towel." })).toBe("You are not carrying towel.");
    expect(chatErrorText({ type: "$error", code: "E_PERM" })).toBe("E_PERM");
    expect(chatErrorText({ type: "$error" })).toBe("That didn't work.");
  });
});
