import { describe, expect, it } from "vitest";
import {
  parseRoutedApiKeyId,
  routedApiKeyId,
  routedApiKeyScope
} from "../../src/core/api-key-id";

describe("self-routing API-key ids", () => {
  it("round-trips arbitrary UTF-8 object refs without making the id a secret", () => {
    const id = routedApiKeyId("human.root/α", "agent.with spaces", "0123456789abcdef0123456789abcdef");
    expect(parseRoutedApiKeyId(id)).toEqual({
      authorityRoot: "human.root/α",
      actor: "agent.with spaces",
      entropy: "0123456789abcdef0123456789abcdef"
    });
    expect(routedApiKeyScope(id)).toBe("cluster:human.root/α");
  });

  it("routes seed principals to catalog and fails closed on malformed hints", () => {
    const id = routedApiKeyId("$wiz", "$wiz", "abcdefabcdefabcdefabcdefabcdefab");
    expect(routedApiKeyScope(id)).toBe("catalog");
    for (const malformed of [
      "legacy-id",
      "n1__00_abcdefabcdefabcdefabcdefabcdefab",
      "n1_ff_ff_short",
      `n1_${Buffer.from("cluster:escape").toString("hex")}_24_abcdefabcdefabcdefabcdefabcdefab`,
      `n1_${"61".repeat(257)}_24_abcdefabcdefabcdefabcdefabcdefab`,
      `${id}00`
    ]) {
      expect(parseRoutedApiKeyId(malformed), malformed).toBeNull();
      expect(routedApiKeyScope(malformed), malformed).toBeNull();
    }
    expect(() => routedApiKeyId("cluster:escape", "$wiz", "abcdefabcdefabcdefabcdefabcdefab"))
      .toThrow(/bounded concrete/);
  });
});
