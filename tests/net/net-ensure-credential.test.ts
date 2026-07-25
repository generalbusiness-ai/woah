import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureNetCredential } from "../../scripts/net-ensure-credential";
import { verifyInternalRequest } from "../../src/worker/internal-auth";

const SECRET = "operator-cli-test-secret";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Net credential operator CLI", () => {
  it("persists one owner-only candidate before sending a verifier-only, replay-stable request", async () => {
    const home = mkdtempSync(join(tmpdir(), "woo-net-credential-"));
    temporaryDirectories.push(home);
    const credentialFile = join(home, ".config", "generalbusiness", "woo_net_credentials.env");
    const requests: Array<Record<string, unknown>> = [];
    const logs: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      await verifyInternalRequest({ WOO_INTERNAL_SECRET: SECRET }, request.clone());
      // The candidate must already be durable if the authority commits and
      // this reply is subsequently dropped.
      expect(statSync(credentialFile).mode & 0o777).toBe(0o600);
      const body = await request.json() as Record<string, unknown>;
      requests.push(body);
      return new Response(JSON.stringify({
        ok: true,
        status: requests.length === 1 ? "applied" : "empty",
        actor: body.actor,
        id: body.id
      }), {
        headers: { "content-type": "application/json" }
      });
    };
    const args = [
      "--actor", "the_weather",
      "--authority-root", "the_weather",
      "--name", "WEATHER_WOO_APIKEY",
      "--base-url", "https://woo.test",
      "--credential-file", credentialFile
    ];
    const deps = {
      env: { WOO_INTERNAL_SECRET: SECRET },
      homeDir: home,
      fetch: fetchImpl,
      log: (message: string) => logs.push(message)
    };

    await ensureNetCredential(args, deps);
    const firstFile = readFileSync(credentialFile, "utf8");
    await ensureNetCredential(args, deps);

    expect(readFileSync(credentialFile, "utf8")).toBe(firstFile);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0]).toMatchObject({
      authority_scope: "cluster:the_weather",
      actor: "the_weather",
      id: expect.stringMatching(/^n1_/),
      record: {
        actor: "the_weather",
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        salt: expect.stringMatching(/^[0-9a-f]{32}$/),
        label: "the_weather net credential",
        created_at: expect.any(Number)
      }
    });
    expect(JSON.stringify(requests[0])).not.toContain("apikey:");
    expect(Object.keys(requests[0].record as Record<string, unknown>).sort()).toEqual([
      "actor",
      "created_at",
      "hash",
      "label",
      "salt"
    ]);
    const token = /^WEATHER_WOO_APIKEY='([^']+)'$/m.exec(firstFile)?.[1];
    expect(token).toMatch(/^apikey:n1_/);
    expect(firstFile).not.toContain(SECRET);
    expect(logs.join("\n")).not.toContain(token);
  });
});
