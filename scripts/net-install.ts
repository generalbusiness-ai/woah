// net-install — install the world into a net namespace (cutover item A;
// normative protocol: spec/operations/net-cutover.md; working notes:
// notes/2026-07-08-net-cutover-tooling-plan.md).
//
//   WOO_INTERNAL_SECRET=... npx tsx scripts/net-install.ts \
//     --base-url https://<worker-host> [--catalogs a,b,c] \
//     [--identity identity-export.json] \
//     [--skip-identity-verify] [--dry-run]
//   WOO_INTERNAL_SECRET=... npx tsx scripts/net-install.ts \
//     --base-url https://<worker-host> --probe-only
// Real credential probes should be supplied as WOO_VERIFY_APIKEY and
// WOO_VERIFY_PASSWORD so secrets do not appear in argv/process listings.
//
// Builds the SAME world any environment boots (bootstrap + local
// catalogs), grafts the carried identity when given (item B — applied
// BEFORE export so it partitions like any other state), splits by CO15
// topology, and seeds each scope through the signed /net-install doorway.
// Re-run posture (M9 + the destructive-reseed guard): a crashed install
// re-runs safely while no scope has COMMITTED turns (same-epoch re-seed
// of install cells over install cells); once any turn commits — e.g.
// the credential probe minted — a re-seed refuses E_SEED_COMMITTED and
// the recovery is a fresh namespace. A different catalog bundle refuses
// E_EPOCH_MISMATCH rather than mixing worlds.
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
import { planNetInstall, type NetInstallOptions } from "../src/net/install";
import { importIdentity, parseIdentityExport } from "../src/net/identity";
import { CATALOG_SCOPE } from "../src/net/topology";
import { signInternalRequest } from "../src/worker/internal-auth";

export type NetInstallArgs = {
  baseUrl: string;
  catalogs?: string[];
  identity?: string;
  verifyApikey?: string;
  /** §8 step-3 second half: `email:password` for a carried account — the
   * prove step must log in with a carried apikey AND a carried password. */
  verifyPassword?: string;
  skipIdentityVerify?: boolean;
  probeOnly?: boolean;
  dryRun: boolean;
  /** Composition-only extension used by local Net development to add its
   * deterministic dev credential. The production CLI has no flag for this:
   * carried live identity still enters only through the export file. */
  graft?: NetInstallOptions["graft"];
};

export function parseArgs(
  argv: string[],
  credentialEnv: { WOO_VERIFY_APIKEY?: string; WOO_VERIFY_PASSWORD?: string } = {}
): NetInstallArgs {
  // Real cutover secrets come from the environment so they need not appear
  // in argv/process listings. Explicit flags remain useful for synthetic lanes.
  const args: NetInstallArgs = {
    baseUrl: "",
    dryRun: false,
    verifyApikey: credentialEnv.WOO_VERIFY_APIKEY,
    verifyPassword: credentialEnv.WOO_VERIFY_PASSWORD
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-url") args.baseUrl = argv[++i] ?? "";
    else if (arg === "--catalogs") args.catalogs = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (arg === "--identity") args.identity = argv[++i];
    else if (arg === "--verify-apikey") args.verifyApikey = argv[++i];
    else if (arg === "--verify-password") args.verifyPassword = argv[++i];
    else if (arg === "--skip-identity-verify") args.skipIdentityVerify = true;
    else if (arg === "--probe-only") args.probeOnly = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.baseUrl && (!args.dryRun || args.probeOnly)) {
    throw new Error("--base-url is required (or use --dry-run without --probe-only)");
  }
  return args;
}

async function signedFetch(env: { WOO_INTERNAL_SECRET?: string }, request: Request): Promise<Response> {
  return fetch(await signInternalRequest(env, request));
}

/** Prove the install HMAC through the complete edge → catalog-DO path.
 * This must run before any seed because a first-time secret deployment can
 * briefly leave the live route and its target DO on different bindings. */
export async function probeNetInstall(baseUrl: string, env: { WOO_INTERNAL_SECRET?: string }): Promise<void> {
  if (!env.WOO_INTERNAL_SECRET) throw new Error("WOO_INTERNAL_SECRET is required to sign the install probe");
  const response = await signedFetch(env, new Request(`${baseUrl}/net-install/probe`));
  const body = (await response.json().catch(() => null)) as { ok?: unknown; service?: unknown } | null;
  if (!response.ok || body?.ok !== true || body.service !== "net-scope") {
    throw new Error(`net-install probe failed: ${response.status} ${JSON.stringify(body)}`);
  }
  console.log("verified: install secret reached edge and catalog scope");
}

export async function runNetInstall(args: NetInstallArgs, env: { WOO_INTERNAL_SECRET?: string }): Promise<void> {
  if (args.probeOnly) {
    await probeNetInstall(args.baseUrl, env);
    console.log("net-install probe ok");
    return;
  }
  // Fail-closed identity rule (spec/operations/net-cutover.md): an
  // install that carries identity but cannot PROVE a carried credential
  // authenticates must not activate — a world nobody can log into is not
  // installed, whatever the scope heads say. The override exists for
  // identity-less rehearsals of the carry machinery, and it is loud.
  if (args.identity && !args.verifyApikey && !args.skipIdentityVerify && !args.dryRun) {
    throw new Error(
      "--identity requires WOO_VERIFY_APIKEY=apikey:<id>:<secret> or --verify-apikey (the carried-credential proof); " +
        "pass --skip-identity-verify ONLY for a rehearsal where no credential can be probed"
    );
  }
  const identity = args.identity ? parseIdentityExport(JSON.parse(readFileSync(args.identity, "utf8"))) : null;
  // activate:false — the namespace must stay INSTALLING (client traffic
  // refused) until every verification below passes; this script seeds
  // the activation cell as its last act.
  const graft: NetInstallOptions["graft"] | undefined = identity || args.graft
    ? async (world) => {
        if (identity) importIdentity(world, identity);
        await args.graft?.(world);
      }
    : undefined;
  const plan = await planNetInstall({
    activate: false,
    ...(args.catalogs ? { catalogs: args.catalogs } : {}),
    ...(graft ? { graft } : {})
  });
  const scopes = [...plan.partitions.entries()].sort(([a], [b]) => a.localeCompare(b));
  console.log(`net-install: epoch=${plan.epoch} scopes=${scopes.length} cells=${scopes.reduce((n, [, c]) => n + c.length, 0)}`);
  for (const [scope, cells] of scopes) console.log(`  ${scope}: ${cells.length} cells`);
  if (args.dryRun) {
    console.log("dry run: nothing seeded");
    return;
  }
  if (!env.WOO_INTERNAL_SECRET) throw new Error("WOO_INTERNAL_SECRET is required to sign the install");
  // No install mutation occurs until the complete signing path has answered.
  // This turns secret propagation from an operator assumption into a gate.
  await probeNetInstall(args.baseUrl, env);

  const seedScope = async (scope: string, cells: unknown[]): Promise<string> => {
    const url = `${args.baseUrl}/net-install/scope/${encodeURIComponent(scope)}/seed`;
    const response = await signedFetch(env, new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope,
        catalog_epoch: plan.epoch,
        cells,
        relations: plan.relations.get(scope) ?? [],
        // AU3.3: stamp the scope's owning customer at seed; absent for
        // scopes the plan could not attribute (never guessed here).
        ...(plan.attributions.has(scope) ? { attribution: plan.attributions.get(scope) } : {})
      })
    }));
    const body = await response.text();
    if (!response.ok) throw new Error(`seed ${scope} failed: ${response.status} ${body}`);
    return body;
  };

  // The NC1 activation state machine, as its own signed op: /net/seed
  // refuses once a scope has committed turns (the destructive-reseed
  // guard), so activation/deactivation never ride a seed.
  // V3 finding 5: activation is CAS'd — declare the value being
  // overwritten. Activation follows install (expected null → the epoch);
  // deactivation-on-verification-failure expects that just-set epoch.
  const setActivation = async (activeEpoch: string | null, expected: string | null): Promise<void> => {
    const url = `${args.baseUrl}/net-install/scope/${encodeURIComponent(CATALOG_SCOPE)}/activate`;
    const response = await signedFetch(env, new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: CATALOG_SCOPE, catalog_epoch: plan.epoch, active_epoch: activeEpoch, expected_active_epoch: expected })
    }));
    if (!response.ok) throw new Error(`activation write failed: ${response.status} ${await response.text()}`);
  };

  // INSTALLING: seed every scope. Failures abort — a PRE-COMMIT partial
  // install is safe to re-run (same epoch, heads still 0), and the
  // missing activation cell keeps the gateway refusing client traffic
  // the whole time. A scope with committed turns refuses re-seeding
  // (E_SEED_COMMITTED) by design.
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
  await setActivation(plan.epoch, null);
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
      await setActivation(null, plan.epoch);
      throw new Error(
        `identity verification failed — namespace DEACTIVATED: /net-api/session ${response.status} ${JSON.stringify(body)}`
      );
    }
    console.log(`verified: carried apikey minted session ${body.session}`);
  } else if (args.skipIdentityVerify && identity) {
    console.log("WARNING: identity imported UNVERIFIED (--skip-identity-verify) — run the mint probe before the route switch");
  }

  // Verification 3 (§8 step 3, second half): a carried account PASSWORD
  // must authenticate through the identity door — the human
  // re-authentication path the cutover promises. Same deactivate-on-
  // failure rule as the apikey probe.
  if (args.verifyPassword) {
    const colon = args.verifyPassword.indexOf(":");
    const email = colon >= 0 ? args.verifyPassword.slice(0, colon) : "";
    const password = colon >= 0 ? args.verifyPassword.slice(colon + 1) : "";
    if (!email || !password) throw new Error("WOO_VERIFY_PASSWORD/--verify-password must be email:password");
    const response = await fetch(`${args.baseUrl}/net-api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, ttl_ms: 60_000 })
    });
    const body = (await response.json().catch(() => ({}))) as { session?: string };
    if (!response.ok || typeof body.session !== "string") {
      await setActivation(null, plan.epoch);
      throw new Error(
        `password verification failed — namespace DEACTIVATED: /net-api/login ${response.status} ${JSON.stringify(body)}`
      );
    }
    console.log(`verified: carried account password minted session ${body.session}`);
  }
  console.log("net-install ok");
}

// CLI entry (tsx scripts/net-install.ts ...). Import-safe: the dev-lane
// proof imports runNetInstall directly.
const invokedDirectly = process.argv[1]?.endsWith("net-install.ts") === true;
if (invokedDirectly) {
  runNetInstall(parseArgs(process.argv.slice(2), process.env), { WOO_INTERNAL_SECRET: process.env.WOO_INTERNAL_SECRET }).catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
}
