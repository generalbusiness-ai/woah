// net-install — install the world into a net namespace (cutover item A;
// normative protocol: spec/operations/net-cutover.md; working notes:
// notes/2026-07-08-net-cutover-tooling-plan.md).
//
//   WOO_INTERNAL_SECRET=... npx tsx scripts/net-install.ts \
//     --base-url https://<worker-host> [--catalogs a,b,c] \
//     [--identity identity-export.json --verify-apikey apikey:<id>:<secret>] \
//     [--skip-identity-verify] [--dry-run]
//
// Builds the SAME world any environment boots (bootstrap + local
// catalogs), grafts the carried identity when given (item B — applied
// BEFORE export so it partitions like any other state), splits by CO15
// topology, and seeds each scope through the signed /net-install doorway.
// Idempotent by the M9 epoch guard: re-running the same catalog bundle
// re-seeds at the same epoch (no-op-shaped success); a different bundle
// refuses rather than mixing worlds.
//
// The cutover state machine (spec/operations/net-cutover.md): the
// namespace stays INSTALLING — the gateway refuses ALL client traffic
// with E_NOT_INSTALLED — until every verification passes and this
// script seeds the activation cell as its LAST act. Verification is
// fail-closed: every seeded scope must answer /head at the install
// epoch, and when an identity rode along, a carried apikey MUST mint a
// session through the real /net-api/session surface (skippable only by
// the conspicuous --skip-identity-verify override). A failed credential
// probe DEACTIVATES the namespace before aborting — safe because
// activation always precedes the route switch, so no traffic exists yet.
import { readFileSync } from "node:fs";
import { netActivationCell, planNetInstall } from "../src/net/install";
import { importIdentity, parseIdentityExport } from "../src/net/identity";
import { CATALOG_SCOPE } from "../src/net/topology";
import { signInternalRequest } from "../src/worker/internal-auth";

type Args = {
  baseUrl: string;
  catalogs?: string[];
  identity?: string;
  verifyApikey?: string;
  skipIdentityVerify?: boolean;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { baseUrl: "", dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-url") args.baseUrl = argv[++i] ?? "";
    else if (arg === "--catalogs") args.catalogs = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (arg === "--identity") args.identity = argv[++i];
    else if (arg === "--verify-apikey") args.verifyApikey = argv[++i];
    else if (arg === "--skip-identity-verify") args.skipIdentityVerify = true;
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
  // Fail-closed identity rule (spec/operations/net-cutover.md): an
  // install that carries identity but cannot PROVE a carried credential
  // authenticates must not activate — a world nobody can log into is not
  // installed, whatever the scope heads say. The override exists for
  // identity-less rehearsals of the carry machinery, and it is loud.
  if (args.identity && !args.verifyApikey && !args.skipIdentityVerify && !args.dryRun) {
    throw new Error(
      "--identity requires --verify-apikey apikey:<id>:<secret> (the carried-credential proof); " +
        "pass --skip-identity-verify ONLY for a rehearsal where no credential can be probed"
    );
  }
  const identity = args.identity ? parseIdentityExport(JSON.parse(readFileSync(args.identity, "utf8"))) : null;
  // activate:false — the namespace must stay INSTALLING (client traffic
  // refused) until every verification below passes; this script seeds
  // the activation cell as its last act.
  const plan = await planNetInstall({
    activate: false,
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

  const seedScope = async (scope: string, cells: unknown[]): Promise<string> => {
    const url = `${args.baseUrl}/net-install/scope/${encodeURIComponent(scope)}/seed`;
    const response = await signedFetch(env, new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, catalog_epoch: plan.epoch, cells })
    }));
    const body = await response.text();
    if (!response.ok) throw new Error(`seed ${scope} failed: ${response.status} ${body}`);
    return body;
  };

  // INSTALLING: seed every scope. Failures abort — a partial install is
  // safe to re-run (same epoch → no-op-shaped success on the
  // already-seeded scopes), and the missing activation cell keeps the
  // gateway refusing client traffic the whole time.
  for (const [scope, cells] of scopes) {
    console.log(`seeded ${scope}: ${await seedScope(scope, cells)}`);
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

  // ACTIVATE: publish the verified epoch at the catalog authority. From
  // this seed on, the gateway admits client traffic — which the final
  // credential probe below depends on (it uses the REAL client surface).
  await seedScope(CATALOG_SCOPE, [netActivationCell(plan.epoch)]);
  console.log(`activated: ${CATALOG_SCOPE} publishes epoch ${plan.epoch}`);

  // Verification 2 (identity rode along): a carried apikey must mint a
  // session through the REAL client surface — the end-to-end proof that
  // auth works against the installed world. `--verify-apikey` supplies
  // the PLAINTEXT credential (exports carry only salted hashes). Probed
  // AFTER activation because the client surface is barred before it; a
  // failure DEACTIVATES (activation cell → null) so the namespace never
  // stays active unproven. No traffic can race this window: the route
  // switch is a later, separate operator step.
  if (args.verifyApikey) {
    const response = await fetch(`${args.baseUrl}/net-api/session`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${args.verifyApikey}` },
      body: JSON.stringify({ ttl_ms: 60_000 })
    });
    const body = (await response.json().catch(() => ({}))) as { session?: string };
    if (!response.ok || typeof body.session !== "string") {
      await seedScope(CATALOG_SCOPE, [netActivationCell(null)]);
      throw new Error(
        `identity verification failed — namespace DEACTIVATED: /net-api/session ${response.status} ${JSON.stringify(body)}`
      );
    }
    console.log(`verified: carried apikey minted session ${body.session}`);
  } else if (args.skipIdentityVerify && identity) {
    console.log("WARNING: identity imported UNVERIFIED (--skip-identity-verify) — run the mint probe before the route switch");
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
