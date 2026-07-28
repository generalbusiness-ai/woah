// Idempotent operator repair for aged worlds whose verb pages share an ordinal.
//
// Until 2026-07-27 the Net authoring path could not see an object's other verb
// pages, so `install_verb` / `add_verb` / the verb editor wrote `slot: 1` for
// every verb they created, and `set_verb_info` / `set_verb_code` demoted the
// verb they touched to slot 1 as well (notes/2026-07-27-net-verb-slots.md).
// Slot order is the dispatcher's tie-breaker, so an object whose pages share a
// slot has no dispatch order of its own: the MCP resolver refuses the ambiguous
// calls (`verb_order_unavailable`), and `list_verb` reports an ordinal that
// addresses nothing. Authoring is fixed; committed cells are not rewritten by a
// runtime, so this signed op is how a deployed world is walked forward.
//
// THE TRUE INSERTION ORDER IS NOT RECOVERABLE and the repair does not pretend
// otherwise. Verb pages carry no timestamp, and `version` counts edits to one
// verb rather than global writes. What the repair does instead is make the
// order the system ALREADY resolves explicit: slot ascending, then name
// ascending — the tie-break `serializedFromCells`, `shadowVerbBytecodePages`
// and `world.orderVerbs` all apply today — written out as dense ordinals. It is
// behaviour-preserving by construction: no name resolves to a different verb
// after it runs. See src/net/verb-slots.ts.
//
// BOUNDED, NOT GLOBAL: the operator names the SCOPES (namespace-level
// knowledge), and each scope derives its own candidates from its OWN verb
// cells. Nothing in the request chooses a slot. Objects are capped per request
// and the reply reports `remaining`; re-run until it is zero. An already-healthy
// object — including one with legitimate GAPS from deleted verbs — is left
// alone, which is what makes replays no-ops.
import { pathToFileURL } from "node:url";
import { planNetInstall } from "../src/net/install";
import { signInternalRequest } from "../src/worker/internal-auth";

/** Cells the scope reported rewriting. */
export function repairedCellCount(body: string): number {
  const parsed = JSON.parse(body) as { changed?: unknown };
  return Array.isArray(parsed.changed) ? parsed.changed.filter((key) => typeof key === "string").length : 0;
}

/** Objects the scope could not fit into this request's cap. A non-zero total
 * across the run means the operator must run again. */
export function remainingObjectCount(body: string): number {
  const parsed = JSON.parse(body) as { remaining?: unknown };
  return typeof parsed.remaining === "number" && Number.isFinite(parsed.remaining) ? parsed.remaining : 0;
}

export type RepairVerbSlotArgs = {
  scopes: string[];
  objects: string[];
  dryRun: boolean;
  allSeeded: boolean;
};

/** One pass over the argument list. `--object <id>` consumes its value so an
 * object id can never be mistaken for a positional scope name. */
export function parseRepairVerbSlotArgs(argv: readonly string[]): RepairVerbSlotArgs {
  const scopes: string[] = [];
  const objects: string[] = [];
  let dryRun = false;
  let allSeeded = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") { dryRun = true; continue; }
    if (arg === "--all-seeded") { allSeeded = true; continue; }
    if (arg === "--object") {
      const id = argv[i + 1] ?? "";
      if (!id || id.startsWith("--")) throw new Error("--object expects an object id");
      objects.push(id);
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}`);
    scopes.push(arg);
  }
  return { scopes, objects, dryRun, allSeeded };
}

async function main(): Promise<void> {
  const { scopes: parsed, objects, dryRun, allSeeded } = parseRepairVerbSlotArgs(process.argv.slice(2));
  const baseUrl = (parsed[0] ?? "").replace(/\/$/, "");
  const positional = parsed.slice(1);

  if (!baseUrl || (positional.length === 0 && !allSeeded)) {
    throw new Error(
      "usage: npm run repair:net-verb-slots -- https://worker.example [scope ...] " +
      "[--all-seeded] [--dry-run] [--object <id>]"
    );
  }
  if (!process.env.WOO_INTERNAL_SECRET) throw new Error("WOO_INTERNAL_SECRET is required");

  // `--all-seeded` uses the bundle's partitions: the namespace's seeded scope
  // set. Scopes created after install (actor clusters, new rooms) must be
  // named explicitly — this driver never enumerates a world.
  let scopes = positional;
  if (allSeeded) {
    const plan = await planNetInstall({ activate: false });
    scopes = [...new Set([...positional, ...plan.partitions.keys()])].sort();
  }

  let repaired = 0;
  let remaining = 0;
  for (const scope of scopes) {
    const url = `${baseUrl}/net-install/scope/${encodeURIComponent(scope)}/repair-verb-slots`;
    const request = await signInternalRequest(
      { WOO_INTERNAL_SECRET: process.env.WOO_INTERNAL_SECRET },
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dry_run: dryRun, ...(objects.length > 0 ? { objects } : {}) })
      })
    );
    const response = await fetch(request);
    const body = await response.text();
    if (!response.ok) throw new Error(`repair-verb-slots ${scope} failed: ${response.status} ${body}`);
    repaired += repairedCellCount(body);
    remaining += remainingObjectCount(body);
    console.log(`${dryRun ? "would repair" : "repaired"} ${scope}: ${body}`);
  }

  console.log(
    `net verb-slot repair ${dryRun ? "(dry run) " : ""}ok: ${repaired} page(s) renumbered across ${scopes.length} scope(s)`
  );
  if (remaining > 0) {
    // Loud, not fatal: what landed is complete and safe; the cap simply means
    // more objects are waiting.
    console.error(`\n${remaining} object(s) exceeded the per-request cap. Run the same command again until remaining is 0.`);
    process.exitCode = 2;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error) => {
    console.error(String(error));
    process.exit(1);
  });
}
