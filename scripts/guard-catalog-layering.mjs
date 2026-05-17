// Catalog layering guard: enforce that no catalog depends on
// @local:demoworld. demoworld is the first-light demo bundle and a
// sink in the dependency graph — it consumes other catalogs to place
// their demo instances in its rooms, but nothing should consume it.
//
// If a catalog needs to ship a demo instance, the seed_hook belongs
// in demoworld's manifest. Demoworld then gains an @local:<catalog>
// entry in its depends so install order is correct. The reverse
// direction (catalog -> demoworld) creates a layering inversion: any
// world that installs the catalog drags in the bundled-demo geography,
// and the demo bundle can't be swapped out for a different one.
//
// Run via `npm run guard:catalog-layering` or as part of `npm test`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const catalogsRoot = join(root, "catalogs");
const offenders = [];

const dirs = readdirSync(catalogsRoot)
  .map((name) => join(catalogsRoot, name))
  .filter((path) => {
    try {
      return statSync(join(path, "manifest.json")).isFile();
    } catch {
      return false;
    }
  })
  .sort();

for (const dir of dirs) {
  const manifestPath = join(dir, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    console.error(`failed to parse ${manifestPath}: ${err.message}`);
    process.exit(1);
  }
  const name = manifest.name ?? dir;
  const depends = Array.isArray(manifest.depends) ? manifest.depends : [];
  for (const dep of depends) {
    if (dep === "@local:demoworld") {
      offenders.push({ catalog: name, manifest: manifestPath });
    }
  }
}

if (offenders.length > 0) {
  console.error("Layering violation: catalogs must not depend on @local:demoworld.");
  console.error("demoworld is the demo-instance sink; if you need to seed a");
  console.error("demo instance, add the seed_hook to catalogs/demoworld/manifest.json");
  console.error("and have demoworld depend on this catalog instead.");
  console.error("");
  for (const offender of offenders) {
    console.error(`  ${offender.catalog}  (${offender.manifest})`);
  }
  process.exit(1);
}

console.log(`catalog layering: ok (${dirs.length} catalogs audited)`);
