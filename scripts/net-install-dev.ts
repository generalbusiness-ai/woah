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
//   3. re-run the install: after the first install's credential-probe
//      COMMIT, the destructive-reseed guard must refuse namedly
//      (E_SEED_COMMITTED) — pre-commit crashes remain rerunnable;
//   4. the carried apikey mints a session and commits a REAL turn
//      through /net-api — §8 step 3's "prove the new namespace" shape.
//   5. claims past the installed guest pool and proves the elastic actor
//      can immediately commit through its session bearer.
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

      // Destructive-reseed guard (reviewer finding 1): the FIRST install
      // ended with the credential probe — a real commit at the carried
      // actor's cluster — so a re-run must now REFUSE with the named
      // verdict instead of silently resetting committed state under an
      // unchanged head. (Idempotent re-run remains the recovery story
      // only for crashes BEFORE any commit; after commits, the recovery
      // is a fresh namespace.)
      let rerunRefusal = "";
      try {
        await runNetInstall(args, env);
      } catch (err) {
        rerunRefusal = String(err);
      }
      if (!rerunRefusal.includes("E_SEED_COMMITTED")) {
        throw new Error(`re-run after commits must refuse E_SEED_COMMITTED; got: ${rerunRefusal || "success"}`);
      }
      ok("re-run after commits refuses namedly (E_SEED_COMMITTED — the destructive-reseed guard)");

      // Real namespace creation: keep every pool session live, then the
      // next claim must commit a fresh actor+session at a previously
      // unseen cluster DO. This is the behavior workerd's real
      // idFromName/storage boundary proves and the fake lane cannot.
      const guestSessions: string[] = [];
      let elastic: { session: string; actor: string } | null = null;
      for (let i = 0; i < 16 && elastic === null; i += 1) {
        const claim = await fetch(`${base}/net-api/guest`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ttl_ms: 60_000 })
        });
        const body = (await claim.json()) as { session?: string; actor?: string; elastic?: boolean; error?: unknown };
        if (!claim.ok || !body.session || !body.actor) {
          throw new Error(`guest claim ${i} failed: ${claim.status} ${JSON.stringify(body)}`);
        }
        guestSessions.push(body.session);
        if (body.elastic === true) elastic = { session: body.session, actor: body.actor };
      }
      if (elastic === null) throw new Error("guest overflow never reached elastic provisioning within 16 claims");
      const elasticTurn = await fetch(`${base}/net-api/turn`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer session:${elastic.session}` },
        body: JSON.stringify({
          target: "the_chatroom",
          verb: "say",
          args: ["hello from an elastic guest"],
          idempotency_key: "install-dev-elastic-guest"
        })
      });
      const elasticTurnBody = (await elasticTurn.json()) as { reply?: { status?: string } };
      if (!elasticTurn.ok || elasticTurnBody.reply?.status !== "accepted") {
        throw new Error(`elastic guest turn failed: ${elasticTurn.status} ${JSON.stringify(elasticTurnBody)}`);
      }
      for (const guestSession of guestSessions) {
        const closed = await fetch(`${base}/net-api/session`, {
          method: "DELETE",
          headers: { "content-type": "application/json", authorization: `Bearer session:${guestSession}` },
          body: "{}"
        });
        if (!closed.ok) throw new Error(`guest close failed: ${closed.status}`);
      }
      ok(`guest overflow provisioned ${elastic.actor} and committed a bearer turn (real workerd)`);

      // Real turns through the client surface: mint, then the two
      // commands a user actually types first — `look` and `say` on the
      // room — both dispatching through the installed class chain
      // (the_chatroom → $chatroom → $room → … where the pages live).
      // NOTE (investigated 2026-07-08): `look` targets the ROOM — no
      // world defines `look` on an actor (the earlier guest_1:look probe
      // failed identically on a full v2 world); native seed-graph verbs
      // ride as verb_bytecode cells with their handler refs and dispatch
      // over the net planner fine.
      const minted = await fetch(`${base}/net-api/session`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer apikey:${KEY_ID}:${KEY_SECRET}` },
        body: JSON.stringify({ ttl_ms: 60_000 })
      });
      const session = ((await minted.json()) as { session?: string }).session;
      if (!minted.ok || !session) throw new Error(`mint failed: ${minted.status}`);
      for (const [verb, args] of [["look", []], ["say", ["hello from the cutover lane"]]] as const) {
        const turn = await fetch(`${base}/net-api/turn`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer apikey:${KEY_ID}:${KEY_SECRET}` },
          body: JSON.stringify({ target: "the_chatroom", verb, args, session, idempotency_key: `install-dev-${verb}` })
        });
        const body = (await turn.json()) as { reply?: { status?: string } };
        if (!turn.ok || body.reply?.status !== "accepted") {
          throw new Error(`${verb} failed: ${turn.status} ${JSON.stringify(body)}`);
        }
        ok(`carried actor committed \`${verb}\` on the_chatroom through /net-api`);
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nsummary[net-install-dev]: ${passed}/6 steps passed`);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
