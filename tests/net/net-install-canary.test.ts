import { describe, expect, it } from "vitest";

import { parseCanaryApiKey } from "../../scripts/net-install-canary";

describe("Net acceptance-canary installer", () => {
  it("accepts only complete API-key credentials from the environment", () => {
    expect(parseCanaryApiKey("KEY", "apikey:alice:secret-a")).toEqual({
      token: "apikey:alice:secret-a",
      id: "alice",
      secret: "secret-a"
    });
    expect(() => parseCanaryApiKey("KEY", undefined)).toThrow("KEY must use apikey:<id>:<secret>");
    expect(() => parseCanaryApiKey("KEY", "session:s1")).toThrow("KEY must use apikey:<id>:<secret>");
  });
});
