#!/usr/bin/env tsx
/**
 * Install a disposable Net acceptance canary with two canary-only MCP actors.
 *
 * Net MCP accepts API keys only, so the deployed cross-actor walkthrough needs
 * identity before activation. This wrapper builds that synthetic identity in
 * memory and composes the production installer; it never adds a canary door to
 * the runtime or carries production identity into the rehearsal.
 */
import { createWorld } from "../src/core/bootstrap";
import { exportIdentity } from "../src/net/identity";
import { runNetInstall } from "./net-install";

type CanaryKey = { token: string; id: string; secret: string };

export function parseCanaryApiKey(name: string, value: string | undefined): CanaryKey {
  const token = value?.trim() ?? "";
  const match = /^apikey:([^:]+):(.+)$/.exec(token);
  if (!match) throw new Error(`${name} must use apikey:<id>:<secret>`);
  return { token, id: match[1]!, secret: match[2]! };
}

function baseUrl(argv: string[]): string {
  const index = argv.indexOf("--base-url");
  const value = index >= 0 ? argv[index + 1] ?? "" : "";
  if (!/^https:\/\//.test(value)) throw new Error("--base-url https://... is required");
  return value.replace(/\/+$/, "");
}

async function verifyApiKey(base: string, key: CanaryKey): Promise<void> {
  const response = await fetch(`${base}/net-api/session`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key.token}` },
    body: JSON.stringify({ ttl_ms: 60_000 })
  });
  const body = (await response.json().catch(() => null)) as { session?: unknown } | null;
  if (!response.ok || typeof body?.session !== "string") {
    throw new Error(`canary API-key verification failed: ${response.status} ${JSON.stringify(body)}`);
  }
  const closed = await fetch(`${base}/net-api/session`, {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: `Bearer session:${body.session}` },
    body: "{}"
  });
  if (!closed.ok) throw new Error(`canary verification session close failed: ${closed.status}`);
}

async function main(): Promise<void> {
  const base = baseUrl(process.argv.slice(2));
  const alice = parseCanaryApiKey("WOO_CANARY_ALICE_APIKEY", process.env.WOO_CANARY_ALICE_APIKEY);
  const bob = parseCanaryApiKey("WOO_CANARY_BOB_APIKEY", process.env.WOO_CANARY_BOB_APIKEY);
  if (alice.id === bob.id) throw new Error("canary Alice and Bob API keys must have distinct ids");
  if (!process.env.WOO_INTERNAL_SECRET) throw new Error("WOO_INTERNAL_SECRET is required");

  const identityWorld = createWorld();
  const aliceActor = identityWorld.auth("guest:acts-canary-alice").actor;
  const bobActor = identityWorld.auth("guest:acts-canary-bob").actor;
  identityWorld.ensureApiKey("$wiz", aliceActor, alice.id, alice.secret, "Acts canary Alice");
  identityWorld.ensureApiKey("$wiz", bobActor, bob.id, bob.secret, "Acts canary Bob");
  const identity = exportIdentity(identityWorld.exportWorld());

  await runNetInstall({
    baseUrl: base,
    identityData: identity,
    verifyApikey: alice.token,
    dryRun: false
  }, { WOO_INTERNAL_SECRET: process.env.WOO_INTERNAL_SECRET });
  await verifyApiKey(base, bob);
  console.log(`net-install-canary ok: ${aliceActor}, ${bobActor}`);
}

const invokedDirectly = process.argv[1]?.endsWith("net-install-canary.ts") === true;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(String(error));
    process.exit(1);
  });
}
