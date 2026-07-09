// net-install — install the world into a net namespace (cutover item A;
// notes/2026-07-08-net-cutover-tooling-plan.md).
//
//   WOO_INTERNAL_SECRET=... npx tsx scripts/net-install.ts \
//     --base-url https://<worker-host> [--catalogs a,b,c] \
//     [--identity identity-export.json] [--dry-run]
//
// Builds the SAME world any environment boots (bootstrap + local
// catalogs), grafts the carried identity when given (item B — applied
// BEFORE export so it partitions like any other state), splits by CO15
// topology, and seeds each scope through the signed /net-install doorway.
// Idempotent by the M9 epoch guard: re-running the same catalog bundle
// re-seeds at the same epoch (no-op-shaped success); a different bundle
// refuses rather than mixing worlds.
//
// Verification (abort on failure, per the §8 import rule): every seeded
// scope must answer /head at the install epoch; when an identity rode
// along, a carried apikey must mint a session through the REAL
// /net-api/session client surface.
import { readFileSync } from "node:fs";
import { planNetInstall } from "../src/net/install";
import { importIdentity, parseIdentityExport } from "../src/net/identity";
import { signInternalRequest } from "../src/worker/internal-auth";

type Args = { baseUrl: string; catalogs?: string[]; identity?: string; verifyApikey?: string; dryRun: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { baseUrl: "", dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-url") args.baseUrl = argv[++i] ?? "";
    else if (arg === "--catalogs") args.catalogs = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (arg === "--identity") args.identity = argv[++i];
    else if (arg === "--verify-apikey") args.verifyApikey = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.baseUrl && !args.dryRun) throw new Error("--base-url is required (or use --dry-run)");
  return args;
}

async function signedFetch(env: { WOO_INTERNAL_SECRET?: string }, request: Request): Promise<Response> {
  return fetch(await signInternalRequest(env, request));
}

export async function runNetInstall(args: Args, env: { WOO_INTERNAL_SECRET?: string }): Promise<void> {
  const identity = args.identity ? parseIdentityExport(JSON.parse(readFileSync(args.identity, "utf8"))) : null;
  const plan = await planNetInstall({
    ...(args.catalogs ? { catalogs: args.catalogs } : {}),
    ...(identity ? { graft: (world) => importIdentity(world, identity) } : {})
  });
  const scopes = [...plan.partitions.entries()].sort(([a], [b]) => a.localeCompare(b));
  console.log(`net-install: epoch=${plan.epoch} scopes=${scopes.length} cells=${scopes.reduce((n, [, c]) => n + c.length, 0)}`);
  for (const [scope, cells] of scopes) console.log(`  ${scope}: ${cells.length} cells`);
  if (args.dryRun) {
    console.log("dry run: nothing seeded");
    return;
  }
  if (!env.WOO_INTERNAL_SECRET) throw new Error("WOO_INTERNAL_SECRET is required to sign the install");

  // Seed every scope. Failures abort — a partial install is safe to
  // re-run (same epoch → no-op-shaped success on the already-seeded
  // scopes), so abort-and-retry is the whole recovery story.
  for (const [scope, cells] of scopes) {
    const url = `${args.baseUrl}/net-install/scope/${encodeURIComponent(scope)}/seed`;
    const response = await signedFetch(env, new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, catalog_epoch: plan.epoch, cells })
    }));
    const body = await response.text();
    if (!response.ok) throw new Error(`seed ${scope} failed: ${response.status} ${body}`);
    console.log(`seeded ${scope}: ${body}`);
  }

  // Verification 1: every scope answers /head at the install epoch.
  for (const [scope] of scopes) {
    const url = `${args.baseUrl}/net-install/scope/${encodeURIComponent(scope)}/head`;
    const response = await signedFetch(env, new Request(url));
    const head = (await response.json()) as { catalog_epoch?: string };
    if (!response.ok || head.catalog_epoch !== plan.epoch) {
      throw new Error(`verify ${scope} failed: ${response.status} ${JSON.stringify(head)}`);
    }
  }
  console.log(`verified: ${scopes.length}/${scopes.length} scope heads at ${plan.epoch}`);

  // Verification 2 (identity rode along): a carried apikey must mint a
  // session through the REAL client surface — the end-to-end proof that
  // auth works against the installed world. `--verify-apikey` supplies
  // the PLAINTEXT credential (exports carry only salted hashes).
  if (args.verifyApikey) {
    const response = await fetch(`${args.baseUrl}/net-api/session`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${args.verifyApikey}` },
      body: JSON.stringify({ ttl_ms: 60_000 })
    });
    const body = (await response.json()) as { session?: string };
    if (!response.ok || typeof body.session !== "string") {
      throw new Error(`identity verification failed: /net-api/session ${response.status} ${JSON.stringify(body)}`);
    }
    console.log(`verified: carried apikey minted session ${body.session}`);
  } else if (identity) {
    console.log("note: identity imported but no --verify-apikey given — run the mint probe before cutover step 3");
  }
  console.log("net-install ok");
}

// CLI entry (tsx scripts/net-install.ts ...). Import-safe: the dev-lane
// proof imports runNetInstall directly.
const invokedDirectly = process.argv[1]?.endsWith("net-install.ts") === true;
if (invokedDirectly) {
  runNetInstall(parseArgs(process.argv.slice(2)), { WOO_INTERNAL_SECRET: process.env.WOO_INTERNAL_SECRET }).catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
}
