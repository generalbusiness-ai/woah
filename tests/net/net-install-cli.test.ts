import { describe, expect, it } from "vitest";
import { parseArgs } from "../../scripts/net-install";

describe("net install credential inputs", () => {
  it("reads verification secrets from the environment without placing them in argv", () => {
    expect(parseArgs(
      ["--base-url", "https://woo.test", "--identity", "identity-export.json"],
      { WOO_VERIFY_APIKEY: "apikey:id:secret", WOO_VERIFY_PASSWORD: "alice@example.com:password" }
    )).toMatchObject({ verifyApikey: "apikey:id:secret", verifyPassword: "alice@example.com:password" });
  });

  it("keeps explicit synthetic-lane flags as overrides", () => {
    expect(parseArgs(
      ["--dry-run", "--verify-apikey", "apikey:cli:value", "--verify-password", "cli@example.com:value"],
      { WOO_VERIFY_APIKEY: "apikey:env:value", WOO_VERIFY_PASSWORD: "env@example.com:value" }
    )).toMatchObject({ verifyApikey: "apikey:cli:value", verifyPassword: "cli@example.com:value" });
  });
});
