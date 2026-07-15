// Idempotent operator repair for namespaces installed before install-time
// contents relations were seeded. The required object allow-list prevents a
// fresh bootstrap image from resurrecting a bundled object that operators
// deliberately moved after installation. Live guest/human locations are never
// inferred from bootstrap state, even when explicitly named.
import { planNetInstall } from "../src/net/install";
import { signInternalRequest } from "../src/worker/internal-auth";

async function main(): Promise<void> {
  const baseUrl = process.argv[2]?.replace(/\/$/, "") ?? "";
  const requested = new Set(process.argv.slice(3).filter(Boolean));
  if (!baseUrl || requested.size === 0) {
    throw new Error("usage: npm run repair:net-relations -- https://worker.example object_id [object_id ...]");
  }
  if (!process.env.WOO_INTERNAL_SECRET) throw new Error("WOO_INTERNAL_SECRET is required");

  const plan = await planNetInstall({ activate: false });
  const serialized = plan.world.exportWorld();
  const objects = new Map(serialized.objects.map((object) => [object.id, object]));
  const isActor = (id: string): boolean => {
    let current: string | null | undefined = id;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      if (current === "$actor") return true;
      seen.add(current);
      current = objects.get(current)?.parent;
    }
    return false;
  };
  const eligible = new Set(
    [...plan.relations.values()].flat().filter((row) => !isActor(row.member)).map((row) => row.member)
  );
  const missing = [...requested].filter((id) => !eligible.has(id));
  if (missing.length > 0) {
    throw new Error(`refused: requested ids are not bundled non-actor static memberships: ${missing.join(", ")}`);
  }

  let added = 0;
  for (const [scope, rows] of [...plan.relations].sort(([a], [b]) => a.localeCompare(b))) {
    const relations = rows.filter((row) => requested.has(row.member) && !isActor(row.member));
    if (relations.length === 0) continue;
    const url = `${baseUrl}/net-install/scope/${encodeURIComponent(scope)}/repair-relations`;
    const request = await signInternalRequest(
      { WOO_INTERNAL_SECRET: process.env.WOO_INTERNAL_SECRET },
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ relations })
      })
    );
    const response = await fetch(request);
    const body = await response.text();
    if (!response.ok) throw new Error(`repair ${scope} failed: ${response.status} ${body}`);
    added += relations.length;
    console.log(`repaired ${scope}: ${body}`);
  }
  console.log(`net relation repair ok: replayed ${added} allow-listed static memberships`);
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
