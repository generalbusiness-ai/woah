// net-mcp-walkthrough — the client-shell phase-i EXIT GATE
// (`npm run smoke:net-mcp`): the ONE shared cross-actor walkthrough
// scenario (scripts/smoke/scenario.ts — the same file the deployed and
// fake lanes run) driven over the NET path end-to-end on real workerd:
//
//   net-install (real bundled world + two carried apikey actors)
//   → SmokeSession over the /net-api/mcp adapter
//   → runSmokeWalkthrough, unchanged.
//
// Smoke discipline: never a per-lane scenario copy — this lane injects
// only a transport (POST ${base}/net-api/mcp) and apikey session tokens.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createWorld } from "../src/core/bootstrap";
import { exportIdentity } from "../src/net/identity";
import { withWorkerd } from "./net-smoke-harness";
import { runNetInstall } from "./net-install";
import { runSmokeWalkthrough, type StepRunner } from "./smoke/scenario";
import { SmokeSession, type McpTransport } from "./smoke/session";

const SECRET = "local-smoke-internal-secret"; // wrangler.smoke.toml's lane secret

let passed = 0;
let failed = 0;

async function main(): Promise<void> {
  const runId = randomUUID().slice(0, 8);

  // The carried identity: two actors, one apikey each (the §8 shape —
  // agents/plugs authenticate by apikey; the scenario's actors ride it).
  const old = createWorld();
  const aliceActor = old.auth("guest:net-mcp-alice").actor;
  const bobActor = old.auth("guest:net-mcp-bob").actor;
  old.ensureApiKey("$wiz", aliceActor, "walk-key-a", "walk-secret-a", "walkthrough alice");
  old.ensureApiKey("$wiz", bobActor, "walk-key-b", "walk-secret-b", "walkthrough bob");
  const identity = exportIdentity(old.exportWorld());
  const dir = mkdtempSync(join(tmpdir(), "woo-net-mcp-walk-"));
  const identityPath = join(dir, "identity-export.json");
  writeFileSync(identityPath, JSON.stringify(identity));

  try {
    await withWorkerd({}, async (base) => {
      await runNetInstall(
        { baseUrl: base, identity: identityPath, verifyApikey: "apikey:walk-key-a:walk-secret-a", dryRun: false },
        { WOO_INTERNAL_SECRET: SECRET }
      );

      const transport: McpTransport = (init) => fetch(`${base}/net-api/mcp`, init);
      const alice = await SmokeSession.open(transport, {
        token: "apikey:walk-key-a:walk-secret-a",
        label: "alice",
        clientName: `net-mcp-walk-${runId}-alice`
      });
      const bob = await SmokeSession.open(transport, {
        token: "apikey:walk-key-b:walk-secret-b",
        label: "bob",
        clientName: `net-mcp-walk-${runId}-bob`
      });
      console.log(`sessions: alice=${alice.actor} bob=${bob.actor}`);

      // Fail-fast step runner (the workerd-lane posture): the first
      // failing step aborts the run with its full error — root causes
      // over patching activity.
      const step: StepRunner = async (name, body) => {
        try {
          await body({});
          passed += 1;
          console.log(`  ok    ${name}`);
        } catch (err) {
          failed += 1;
          console.error(`  FAIL  ${name}: ${String(err).slice(0, 600)}`);
          throw err;
        }
      };

      await runSmokeWalkthrough({ alice, bob }, step, {
        runId,
        includeTakeDrop: true,
        log: (message) => console.log(`        ${message}`)
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    console.log(`\nsummary[net-mcp-walkthrough]: ${passed} passed, ${failed} failed`);
  }
}

main().catch((err) => {
  console.error(String(err).slice(0, 1200));
  process.exit(1);
});
