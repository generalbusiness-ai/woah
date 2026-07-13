import { describe, expect, it } from "vitest";
import {
  CLIENT_SESSION_TTL_DEFAULT_MS,
  CLIENT_SESSION_TTL_MAX_MS,
  CLIENT_SESSION_TTL_MIN_MS,
  clampClientSessionTtl
} from "../../src/net/client-session-policy";

describe("client session lifetime policy", () => {
  it("shares one default and clamps explicit values at the public boundary", () => {
    expect(clampClientSessionTtl(undefined)).toBe(CLIENT_SESSION_TTL_DEFAULT_MS);
    expect(clampClientSessionTtl(Number.NaN)).toBe(CLIENT_SESSION_TTL_DEFAULT_MS);
    expect(clampClientSessionTtl(1)).toBe(CLIENT_SESSION_TTL_MIN_MS);
    expect(clampClientSessionTtl(Number.MAX_SAFE_INTEGER)).toBe(CLIENT_SESSION_TTL_MAX_MS);
  });
});
