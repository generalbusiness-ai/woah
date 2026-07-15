// Idempotent operator migration for bootstrap verb pages already persisted in
// an active net world. The explicit `$object:verb` allow-list is resolved from
// a fresh install plan: operators cannot inject arbitrary bytecode, create a
// definition, or update an instance outside the bootstrap catalog surface.
import { planNetInstall } from "../src/net/install";
import { CATALOG_SCOPE } from "../src/net/topology";
import { signInternalRequest } from "../src/worker/internal-auth";

async function main(): Promise<void> {
  const baseUrl = process.argv[2]?.replace(/\/$/, "") ?? "";
  const requested = [...new Set(process.argv.slice(3).filter(Boolean))];
  if (!baseUrl || requested.length === 0) {
    throw new Error("usage: npm run repair:net-definitions -- https://worker.example '$object:verb' ['$object:verb' ...]");
  }
  if (!process.env.WOO_INTERNAL_SECRET) throw new Error("WOO_INTERNAL_SECRET is required");

  const plan = await planNetInstall({ activate: false });
  const catalog = plan.partitions.get(CATALOG_SCOPE) ?? [];
  const definitions = new Map(
    catalog
      .filter((cell) => cell.kind === "verb_bytecode" && cell.object.startsWith("$") && Boolean(cell.name))
      .map((cell) => [`${cell.object}:${cell.name}`, cell])
  );
  const missing = requested.filter((name) => !definitions.has(name));
  if (missing.length > 0) throw new Error(`refused: requested ids are not bundled bootstrap verb pages: ${missing.join(", ")}`);

  const cells = requested.map((name) => {
    const cell = definitions.get(name)!;
    return { kind: cell.kind, object: cell.object, name: cell.name, value: cell.value };
  });
  const url = `${baseUrl}/net-install/scope/${encodeURIComponent(CATALOG_SCOPE)}/repair-definitions`;
  const request = await signInternalRequest(
    { WOO_INTERNAL_SECRET: process.env.WOO_INTERNAL_SECRET },
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cells })
    })
  );
  const response = await fetch(request);
  const body = await response.text();
  if (!response.ok) throw new Error(`definition repair failed: ${response.status} ${body}`);
  console.log(`net definition repair ok: ${body}`);
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
