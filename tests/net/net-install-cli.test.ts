import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, probeNetInstall } from "../../scripts/net-install";
import { verifyInternalRequest } from "../../src/worker/internal-auth";

afterEach(() => vi.unstubAllGlobals());

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

  it("supports a probe-only deployment gate", () => {
    expect(parseArgs(["--base-url", "https://woo.test", "--probe-only"])).toMatchObject({
      baseUrl: "https://woo.test",
      probeOnly: true,
      dryRun: false
    });
    expect(() => parseArgs(["--probe-only", "--dry-run"])).toThrow(/--base-url is required/);
  });

  it("signs the exact readiness route and requires the named scope response", async () => {
    const secret = "installer-probe-secret";
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const request = input instanceof Request ? input : new Request(input);
      await verifyInternalRequest({ WOO_INTERNAL_SECRET: secret }, request);
      expect(request.method).toBe("GET");
      expect(new URL(request.url).pathname).toBe("/net-install/probe");
      return new Response(JSON.stringify({ ok: true, service: "net-scope" }), {
        headers: { "content-type": "application/json" }
      });
    });
    await expect(probeNetInstall("https://woo.test", { WOO_INTERNAL_SECRET: secret })).resolves.toBeUndefined();

    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" }
    }));
    await expect(probeNetInstall("https://woo.test", { WOO_INTERNAL_SECRET: secret })).rejects.toThrow(
      /net-install probe failed/
    );
  });
});
