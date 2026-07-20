import { describe, expect, it } from "vitest";
import { sanitizePublicHeaders } from "../../src/worker/net-only-index";

describe("worker gateway internal headers", () => {
  it("strips behavior-bearing public headers at the gateway boundary", () => {
    const cleaned = sanitizePublicHeaders(new Request("https://woo.test/net-api/turn", {
      headers: {
        authorization: "Session session-123",
        "x-woo-host-key": "world",
        "x-woo-internal-session": "session-forged",
        "x-woo-task-chain": "task-chain-forged",
        "x-woo-impersonate-actor": "$wiz"
      }
    })).headers;

    expect(cleaned.get("authorization")).toBe("Session session-123");
    expect(cleaned.has("x-woo-host-key")).toBe(false);
    expect(cleaned.has("x-woo-internal-session")).toBe(false);
    expect(cleaned.has("x-woo-task-chain")).toBe(false);
    expect(cleaned.has("x-woo-impersonate-actor")).toBe(false);
  });
});
