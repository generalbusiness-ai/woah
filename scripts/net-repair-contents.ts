// Idempotent operator repair for aged namespaces whose runtime-created objects
// never got a `contents` relation row.
//
// Before the create-time derivation landed, `object_create` recorded placement
// inline — no move, no contents projection write — so an object minted directly
// INTO a container produced no relation delta at all. Its `object_live.location`
// is correct; the membership row simply does not exist. Bundled catalogs create
// this way routinely ($task, $outline_item, $dispensed_note, $note), so any
// namespace that ran before the fix carries the gap.
//
// Unlike net-repair-relations.ts, this needs no object allow-list, because it
// infers nothing from a bootstrap image: each scope derives its own candidates
// from its OWN object_live cells (O(scope size) — the bound CO13 already
// sanctions for rebuildContentsRelation and hydration). No scope enumerates
// another, and this driver never enumerates objects. The operator names the
// SCOPES, which is namespace-level knowledge, not world-level.
//
// The scope applies add-only, so a second run advances no head and refans
// nothing. Cross-scope membership (a container this scope does not sequence)
// rides the ordinary /net/relate lane; anchor topology stays caller knowledge,
// so unresolvable owners are REPORTED rather than guessed — pass them with
// --owner-scope <object>=<scope> and re-run.
import { pathToFileURL } from "node:url";
import { planNetInstall } from "../src/net/install";
import { signInternalRequest } from "../src/worker/internal-auth";

export type RepairContentsReply = {
  scope: string;
  status?: string;
  changed?: unknown;
  candidates?: number;
  local?: number;
  foreign?: number;
  unplaced?: unknown;
};

export function addedRowCount(body: string): number {
  const parsed = JSON.parse(body) as { changed?: unknown };
  return Array.isArray(parsed.changed) ? parsed.changed.filter((key) => typeof key === "string").length : 0;
}

export function unplacedOwners(body: string): string[] {
  const parsed = JSON.parse(body) as { unplaced?: unknown };
  return Array.isArray(parsed.unplaced) ? parsed.unplaced.filter((id): id is string => typeof id === "string") : [];
}

export type RepairContentsArgs = {
  scopes: string[];
  ownerScopes: Record<string, string>;
  dryRun: boolean;
  allSeeded: boolean;
};

/** One pass over the argument list. `--owner-scope <object>=<scope>` consumes
 * its value, so a mapping can never be mistaken for a positional scope name. */
export function parseRepairArgs(argv: readonly string[]): RepairContentsArgs {
  const scopes: string[] = [];
  const ownerScopes: Record<string, string> = {};
  let dryRun = false;
  let allSeeded = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") { dryRun = true; continue; }
    if (arg === "--all-seeded") { allSeeded = true; continue; }
    if (arg === "--owner-scope") {
      const pair = argv[i + 1] ?? "";
      const at = pair.indexOf("=");
      if (at <= 0 || at === pair.length - 1) {
        throw new Error(`--owner-scope expects <object>=<scope>, got ${JSON.stringify(pair)}`);
      }
      ownerScopes[pair.slice(0, at)] = pair.slice(at + 1);
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}`);
    scopes.push(arg);
  }
  return { scopes, ownerScopes, dryRun, allSeeded };
}

async function main(): Promise<void> {
  // The first positional is the worker URL; everything after it is a scope.
  const { scopes: parsed, ownerScopes, dryRun, allSeeded } = parseRepairArgs(process.argv.slice(2));
  const baseUrl = (parsed[0] ?? "").replace(/\/$/, "");
  const positional = parsed.slice(1);

  if (!baseUrl || (positional.length === 0 && !allSeeded)) {
    throw new Error(
      "usage: npm run repair:net-contents -- https://worker.example [scope ...] " +
      "[--all-seeded] [--dry-run] [--owner-scope <object>=<scope>]"
    );
  }
  if (!process.env.WOO_INTERNAL_SECRET) throw new Error("WOO_INTERNAL_SECRET is required");

  // `--all-seeded` uses the bundle's partitions: the namespace's seeded scope
  // set. That is namespace-level knowledge, not a world scan — scopes created
  // after install must be named explicitly.
  let scopes = positional;
  if (allSeeded) {
    const plan = await planNetInstall({ activate: false });
    scopes = [...new Set([...positional, ...plan.partitions.keys()])].sort();
  }

  let added = 0;
  const stillUnplaced = new Map<string, string[]>();
  for (const scope of scopes) {
    const url = `${baseUrl}/net-install/scope/${encodeURIComponent(scope)}/repair-contents`;
    const request = await signInternalRequest(
      { WOO_INTERNAL_SECRET: process.env.WOO_INTERNAL_SECRET },
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dry_run: dryRun, owner_scopes: ownerScopes })
      })
    );
    const response = await fetch(request);
    const body = await response.text();
    if (!response.ok) throw new Error(`repair-contents ${scope} failed: ${response.status} ${body}`);
    added += addedRowCount(body);
    const unplaced = unplacedOwners(body);
    if (unplaced.length > 0) stillUnplaced.set(scope, unplaced);
    console.log(`${dryRun ? "would repair" : "repaired"} ${scope}: ${body}`);
  }

  if (stillUnplaced.size > 0) {
    // Loud, not fatal: the local half is already applied and safe to re-run.
    console.error(
      `\n${stillUnplaced.size} scope(s) hold memberships whose container they do not sequence. ` +
      "Anchor topology is not scope knowledge, so these were not guessed. Re-run with the " +
      "owning scope for each:\n" +
      [...stillUnplaced].map(([scope, owners]) =>
        `  ${scope}: ${owners.map((o) => `--owner-scope ${o}=<scope>`).join(" ")}`
      ).join("\n")
    );
    process.exitCode = 2;
  }
  console.log(
    `net contents repair ${dryRun ? "(dry run) " : ""}ok: ${added} row(s) added across ${scopes.length} scope(s)`
  );
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error) => {
    console.error(String(error));
    process.exit(1);
  });
}
