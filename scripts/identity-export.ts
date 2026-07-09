// identity-export — pull the §8 identity carry-over from a live v2
// worker (cutover item B; notes/2026-07-08-net-cutover-tooling-plan.md).
//
//   WOO_INTERNAL_SECRET=... npx tsx scripts/identity-export.ts \
//     --base-url https://<worker-host> [--out identity-export.json]
//
// Read-only and idempotent (re-running re-reads). Runs against a FROZEN
// world — the freeze exempts signed internal traffic, which is the §8
// "final identity-export from frozen old prod" step. The output feeds
// scripts/net-install.ts --identity.
import { writeFileSync } from "node:fs";
import { parseIdentityExport } from "../src/net/identity";
import { signInternalRequest } from "../src/worker/internal-auth";

function parseArgs(argv: string[]): { baseUrl: string; out: string } {
  const args = { baseUrl: "", out: "identity-export.json" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-url") args.baseUrl = argv[++i] ?? "";
    else if (arg === "--out") args.out = argv[++i] ?? args.out;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.baseUrl) throw new Error("--base-url is required");
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = { WOO_INTERNAL_SECRET: process.env.WOO_INTERNAL_SECRET };
  if (!env.WOO_INTERNAL_SECRET) throw new Error("WOO_INTERNAL_SECRET is required to sign the export request");
  const request = new Request(`${args.baseUrl}/net-install/identity-export`);
  const response = await fetch(await signInternalRequest(env, request));
  const raw = await response.json();
  if (!response.ok) throw new Error(`identity export failed: ${response.status} ${JSON.stringify(raw)}`);
  // Shape-check BEFORE writing: a malformed export must never become the
  // cutover's input file.
  const identity = parseIdentityExport(raw);
  writeFileSync(args.out, JSON.stringify(identity, null, 2));
  console.log(
    `identity-export ok: ${Object.keys(identity.api_keys).length} api keys, ${identity.actors.length} actors → ${args.out}`
  );
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
