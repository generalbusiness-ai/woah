// Idempotent operator migration for bootstrap definition pages already
// persisted in an active net world. Verb ids retain the convenient
// `$object:verb` spelling; `prop:$object:name` selects a property definition.
// The allow-list is resolved from a fresh install plan, so operators cannot
// inject arbitrary definitions or update instances outside the bootstrap
// catalog surface. A current property definition may be installed when an
// aged world predates it; removals must be named by bundled migrations.
import { planNetInstall } from "../src/net/install";
import { CATALOG_SCOPE } from "../src/net/topology";
import { BUNDLED_CATALOGS } from "../src/generated/bundled-catalogs";
import { signInternalRequest } from "../src/worker/internal-auth";

type DefinitionIdentity = { kind: "verb_bytecode" | "property_cell"; object: string; name: string };

function isPropertyDefinition(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const def = (value as { def?: unknown }).def;
  return Boolean(def && typeof def === "object" && !Array.isArray(def));
}

function requestKey(id: string): string {
  if (id.startsWith("verb:") || id.startsWith("prop:")) return id;
  return `verb:${id}`;
}

function identityFromRequest(id: string): DefinitionIdentity {
  const normalized = requestKey(id);
  const prefix = normalized.startsWith("prop:") ? "prop:" : "verb:";
  const kind = prefix === "prop:" ? "property_cell" : "verb_bytecode";
  const identity = normalized.slice(prefix.length);
  const split = identity.lastIndexOf(":");
  return { kind, object: identity.slice(0, split), name: identity.slice(split + 1) };
}

export async function definitionRepairInputs(replace: readonly string[], drop: readonly string[]): Promise<{
  cells: Array<DefinitionIdentity & { value: unknown }>;
  remove: DefinitionIdentity[];
}> {
  const plan = await planNetInstall({ activate: false });
  const catalog = plan.partitions.get(CATALOG_SCOPE) ?? [];
  const definitions = new Map(
    catalog
      .filter((cell) =>
        cell.object.startsWith("$") && Boolean(cell.name) &&
        (cell.kind === "verb_bytecode" || (cell.kind === "property_cell" && isPropertyDefinition(cell.value)))
      )
      .map((cell) => [
        `${cell.kind === "property_cell" ? "prop" : "verb"}:${cell.object}:${cell.name}`,
        cell
      ])
  );
  const missing = replace.filter((name) => !definitions.has(requestKey(name)));
  if (missing.length > 0) throw new Error(`refused: requested ids are not bundled bootstrap definition pages: ${missing.join(", ")}`);

  // Definition removals are sourced from the same bundled migration set as
  // local catalog upgrades. This is the delete-side equivalent of mining
  // replacement definitions from a fresh plan: the CLI cannot name an
  // arbitrary live definition, and a page still present in the current bundle
  // cannot be removed even if an old migration happened to mention its name.
  const allowedDrops = new Set<string>();
  for (const entry of BUNDLED_CATALOGS) {
    for (const migration of entry.migrations ?? []) {
      for (const step of migration.steps ?? []) {
        if (step.kind === "drop_verb") allowedDrops.add(`verb:${step.class}:${step.verb}`);
        if (step.kind === "drop_property") allowedDrops.add(`prop:${step.class}:${step.name}`);
      }
    }
  }
  const refusedDrops = drop.filter((name) => !allowedDrops.has(requestKey(name)) || definitions.has(requestKey(name)));
  if (refusedDrops.length > 0) {
    throw new Error(`refused: requested drops are not retired bundled bootstrap definition pages: ${refusedDrops.join(", ")}`);
  }

  const cells = replace.map((name) => {
    const cell = definitions.get(requestKey(name))!;
    return { kind: cell.kind as DefinitionIdentity["kind"], object: cell.object, name: cell.name!, value: cell.value };
  });
  const remove = drop.map(identityFromRequest);
  return { cells, remove };
}

function parseRequested(args: readonly string[]): { replace: string[]; drop: string[] } {
  const marker = args.indexOf("--drop");
  const replace = [...new Set((marker < 0 ? args : args.slice(0, marker)).filter(Boolean))];
  const drop = [...new Set((marker < 0 ? [] : args.slice(marker + 1)).filter(Boolean))];
  return { replace, drop };
}

async function main(): Promise<void> {
  const baseUrl = process.argv[2]?.replace(/\/$/, "") ?? "";
  const requested = parseRequested(process.argv.slice(3));
  if (!baseUrl || requested.replace.length + requested.drop.length === 0) {
    throw new Error("usage: npm run repair:net-definitions -- https://worker.example '$object:verb' ['prop:$object:name' ...] [--drop '$retired_object:verb' 'prop:$object:name' ...]");
  }
  if (!process.env.WOO_INTERNAL_SECRET) throw new Error("WOO_INTERNAL_SECRET is required");

  const changes = await definitionRepairInputs(requested.replace, requested.drop);
  const url = `${baseUrl}/net-install/scope/${encodeURIComponent(CATALOG_SCOPE)}/repair-definitions`;
  const request = await signInternalRequest(
    { WOO_INTERNAL_SECRET: process.env.WOO_INTERNAL_SECRET },
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(changes)
    })
  );
  const response = await fetch(request);
  const body = await response.text();
  if (!response.ok) throw new Error(`definition repair failed: ${response.status} ${body}`);
  console.log(`net definition repair ok: ${body}`);
}

const invokedDirectly = process.argv[1]?.endsWith("net-repair-definitions.ts") === true;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(String(error));
    process.exit(1);
  });
}
