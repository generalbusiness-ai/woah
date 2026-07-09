// net-install-dev — the REAL-workerd proof of the install pipeline
// (cutover item A; `npm run install:net-dev`).
//
// Boots `wrangler dev` (wrangler.smoke.toml — the same lane as
// smoke:net-dev), then runs the PRODUCTION install path end-to-end:
//
//   1. exportIdentity from a prod-like old world (a carried apikey);
//   2. runNetInstall against the live worker — the plan's partitions
//      travel through the signed /net-install doorway, exactly the
//      cutover's transport (NOT the /net-smoke lane surface);
//   3. re-run the install (idempotence: same epoch → no-op-shaped
//      success on every scope);
//   4. the carried apikey mints a session and commits a REAL turn
//      through /net-api — §8 step 3's "prove the new namespace" shape.
//
// Exits non-zero on any failure; prints ok-lines in the smoke idiom.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorld } from "../src/core/bootstrap";
import { exportIdentity } from "../src/net/identity";
import { withWorkerd } from "./net-smoke-harness";
import { runNetInstall } from "./net-install";

const SECRET = "local-smoke-internal-secret"; // wrangler.smoke.toml's lane secret
const KEY_ID = "install-dev-key";
const KEY_SECRET = "install-dev-secret-1";

let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.log(`  ok    ${label}`);
}

async function main(): Promise<void> {
  // The OLD world: one actor holding the carried apikey.
  const old = createWorld();
  const carried = old.auth("guest:install-dev").actor;
  old.ensureApiKey("$wiz", carried, KEY_ID, KEY_SECRET, "install dev lane");
  const identity = exportIdentity(old.exportWorld());
  const dir = mkdtempSync(join(tmpdir(), "woo-net-install-"));
  const identityPath = join(dir, "identity-export.json");
  writeFileSync(identityPath, JSON.stringify(identity));
  ok(`identity exported: ${identity.actors.length} actors, ${Object.keys(identity.api_keys).length} keys`);

  try {
    await withWorkerd({}, async (base) => {
      const env = { WOO_INTERNAL_SECRET: SECRET };
      const args = {
        baseUrl: base,
        identity: identityPath,
        verifyApikey: `apikey:${KEY_ID}:${KEY_SECRET}`,
        dryRun: false
      };
      await runNetInstall(args, env);
      ok("install + head verification + carried-key mint (real workerd)");

      // Idempotent re-run: the same bundle re-seeds at the same epoch.
      await runNetInstall(args, env);
      ok("re-run is a no-op-shaped success (same epoch)");

      // A real turn through the client surface: mint, then call a
      // CATALOGED verb on an installed world object — `title` on the
      // chatroom dispatches through the installed class chain
      // (the_chatroom → $chatroom → $room → … → $root, where the page
      // lives). Deliberately NOT a native seed-graph verb (`look` etc.):
      // native verbs have no bytecode pages and do not dispatch over the
      // net planner yet — a tracked pre-cutover gap, not an install
      // deficiency (see the cutover tooling plan note).
      const minted = await fetch(`${base}/net-api/session`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer apikey:${KEY_ID}:${KEY_SECRET}` },
        body: JSON.stringify({ ttl_ms: 60_000 })
      });
      const session = ((await minted.json()) as { session?: string }).session;
      if (!minted.ok || !session) throw new Error(`mint failed: ${minted.status}`);
      const turn = await fetch(`${base}/net-api/turn`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer apikey:${KEY_ID}:${KEY_SECRET}` },
        body: JSON.stringify({ target: "the_chatroom", verb: "title", session, idempotency_key: "install-dev-t1" })
      });
      const body = (await turn.json()) as { reply?: { status?: string }; result?: unknown };
      if (!turn.ok || body.reply?.status !== "accepted") {
        throw new Error(`turn failed: ${turn.status} ${JSON.stringify(body)}`);
      }
      ok(`carried actor committed a real turn through /net-api (inherited catalog dispatch; title=${JSON.stringify(body.result)})`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nsummary[net-install-dev]: ${passed}/4 steps passed`);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
