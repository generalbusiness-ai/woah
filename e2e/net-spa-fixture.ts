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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorld } from "../src/core/bootstrap";
import { exportIdentity } from "../src/net/identity";
import { runNetInstall } from "../scripts/net-install";

const SECRET = "local-smoke-internal-secret"; // wrangler.smoke.toml's lane secret

async function main(): Promise<void> {
  const baseUrl = process.argv[2];
  if (!baseUrl) throw new Error("usage: net-spa-fixture.ts <baseUrl>");
  const old = createWorld();
  const alice = old.auth("guest:spa-alice").actor;
  const bob = old.auth("guest:spa-bob").actor;
  old.ensureApiKey("$wiz", alice, "spa-key-a", "spa-secret-a", "spa alice");
  old.ensureApiKey("$wiz", bob, "spa-key-b", "spa-secret-b", "spa bob");
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
