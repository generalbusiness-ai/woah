// net-spa-fixture — the tsx-subprocess half of the SPA-over-net e2e
// (e2e/net-spa.spec.ts). Engine imports cannot load under Playwright's
// Node loader (the attribute-less JSON manifest imports — the same
// MECHANISM note as scripts/net-smoke-harness.ts), so the spec execs
// this under tsx AFTER workerd is up:
//
//   npx tsx e2e/net-spa-fixture.ts <baseUrl>
//
// Builds an old world with two carried apikey actors, exports identity,
// runs the REAL install pipeline against the live worker (the signed
// /net-install doorway), and prints {alice, bob} credentials as JSON on
// stdout (the ONLY stdout line — the spec parses it).
import { webcrypto } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorld } from "../src/core/bootstrap";
import { exportIdentity } from "../src/net/identity";
import { runNetInstall } from "../scripts/net-install";

const SECRET = "local-smoke-internal-secret"; // wrangler.smoke.toml's lane secret
export const DOOR_EMAIL = "carol@example.com";
export const DOOR_PASSWORD = "carols-real-password";

/** The exact core password encoding (world.ts hashPassword) — the door
 * e2e signs in with a REAL carried credential. */
async function encodePassword(password: string): Promise<string> {
  const iterations = 600_000;
  const salt = "aabbccdd00112233aabbccdd00112233";
  const saltBytes = new Uint8Array(salt.length / 2);
  for (let i = 0; i < saltBytes.length; i += 1) saltBytes[i] = Number.parseInt(salt.slice(i * 2, i * 2 + 2), 16);
  const keyMaterial = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits"
  ]);
  const bits = await webcrypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations },
    keyMaterial,
    256
  );
  const digest = [...new Uint8Array(bits)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `pbkdf2-sha256:${iterations}:${salt}:${digest}`;
}

async function main(): Promise<void> {
  const baseUrl = process.argv[2];
  if (!baseUrl) throw new Error("usage: net-spa-fixture.ts <baseUrl>");
  const old = createWorld();
  const alice = old.auth("guest:spa-alice").actor;
  const bob = old.auth("guest:spa-bob").actor;
  old.ensureApiKey("$wiz", alice, "spa-key-a", "spa-secret-a", "spa alice");
  old.ensureApiKey("$wiz", bob, "spa-key-b", "spa-secret-b", "spa bob");
  // The identity-door e2e's human: an account with a real password hash
  // bound (actor-side only — the §8 import rebuilds primary_actor).
  const carol = old.auth("guest:spa-carol").actor;
  old.createObject({ id: "acct_spa_carol", parent: "$account", owner: "$wiz", name: "carol" });
  old.setProp("acct_spa_carol", "email", DOOR_EMAIL as never);
  old.setProp("acct_spa_carol", "password_hash", (await encodePassword(DOOR_PASSWORD)) as never);
  old.setProp(carol, "account", "acct_spa_carol" as never);
  const identity = exportIdentity(old.exportWorld());
  const dir = mkdtempSync(join(tmpdir(), "woo-net-spa-fixture-"));
  const identityPath = join(dir, "identity-export.json");
  writeFileSync(identityPath, JSON.stringify(identity));
  // Silence the installer's progress (stdout is the JSON contract).
  const log = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  try {
    await runNetInstall(
      { baseUrl, identity: identityPath, verifyApikey: "apikey:spa-key-a:spa-secret-a", dryRun: false },
      { WOO_INTERNAL_SECRET: SECRET }
    );
  } finally {
    console.log = log;
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ alice: "apikey:spa-key-a:spa-secret-a", bob: "apikey:spa-key-b:spa-secret-b" }));
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
