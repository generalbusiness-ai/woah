// Idempotent operator migration for seeded property VALUES already persisted
// in an active net world — the data twin of net-repair-definitions. A bundled
// catalog that corrects a seeded map database declares the correction as a
// `merge_map` set_property seed hook (spec/discovery/catalogs.md §CT5.4): the
// hook's `value` is the current shipped map and its `supersedes` block names,
// per key, the historical shipped values it may replace. This driver mines
// exactly those hooks from the bundled manifests — an operator cannot name an
// arbitrary object or property — and posts them to the owning scope, where
// the DO applies the same generic merge the local boot drift pass uses:
// missing keys are added, keys still holding a superseded default are
// replaced, and operator-edited keys survive untouched. Re-running is a no-op.
import { planNetInstall } from "../src/net/install";
import { BUNDLED_CATALOGS } from "../src/generated/bundled-catalogs";
import { signInternalRequest } from "../src/worker/internal-auth";

export type SeedPropertyRepairEntry = {
  object: string;
  property: string;
  value: Record<string, unknown>;
  supersedes?: Record<string, unknown[]>;
};

/**
 * Every bundled `merge_map` seed hook, grouped by the scope that owns the
 * target property cell in a fresh install plan. The deployed world was
 * partitioned by the same rules, so the fresh plan is the authority for
 * where each cell lives; a hook whose cell appears in no partition is
 * reported as an error rather than guessed at.
 */
export async function seedPropertyRepairInputs(): Promise<Map<string, SeedPropertyRepairEntry[]>> {
  const hooks: SeedPropertyRepairEntry[] = [];
  for (const entry of BUNDLED_CATALOGS) {
    for (const hook of entry.manifest.seed_hooks ?? []) {
      if (hook.kind !== "set_property" || hook.mode !== "merge_map") continue;
      if (!hook.value || typeof hook.value !== "object" || Array.isArray(hook.value)) {
        throw new Error(`refused: merge_map hook ${hook.object}.${hook.property} in ${entry.path} does not carry a map value`);
      }
      hooks.push({
        object: hook.object,
        property: hook.property,
        value: hook.value as Record<string, unknown>,
        ...(hook.supersedes ? { supersedes: hook.supersedes as Record<string, unknown[]> } : {})
      });
    }
  }
  const byScope = new Map<string, SeedPropertyRepairEntry[]>();
  if (hooks.length === 0) return byScope;

  const plan = await planNetInstall({ activate: false });
  for (const hook of hooks) {
    let owner: string | null = null;
    for (const [scope, cells] of plan.partitions) {
      if (cells.some((cell) => cell.kind === "property_cell" && cell.object === hook.object && cell.name === hook.property)) {
        owner = scope;
        break;
      }
    }
    if (!owner) {
      throw new Error(`refused: no fresh-install partition owns property_cell:${hook.object}:${hook.property}; cannot infer the repair scope`);
    }
    const list = byScope.get(owner) ?? [];
    list.push(hook);
    byScope.set(owner, list);
  }
  return byScope;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const baseUrl = args.filter((arg) => arg !== "--dry-run")[0]?.replace(/\/$/, "") ?? "";
  if (!baseUrl) {
    throw new Error("usage: npm run repair:net-seed-properties -- https://worker.example [--dry-run]");
  }
  if (!process.env.WOO_INTERNAL_SECRET) throw new Error("WOO_INTERNAL_SECRET is required");

  const byScope = await seedPropertyRepairInputs();
  if (byScope.size === 0) {
    console.log("no bundled merge_map seed hooks declared; nothing to repair");
    return;
  }
  for (const [scope, entries] of byScope) {
    const url = `${baseUrl}/net-install/scope/${encodeURIComponent(scope)}/repair-seed-properties`;
    const request = await signInternalRequest(
      { WOO_INTERNAL_SECRET: process.env.WOO_INTERNAL_SECRET },
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entries, dry_run: dryRun })
      })
    );
    const response = await fetch(request);
    const body = await response.text();
    if (!response.ok) throw new Error(`seed property repair failed for scope ${scope}: ${response.status} ${body}`);
    console.log(`net seed property repair ok (${scope}): ${body}`);
  }
}

const invokedDirectly = process.argv[1]?.endsWith("net-repair-seed-properties.ts") === true;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(String(error));
    process.exit(1);
  });
}
