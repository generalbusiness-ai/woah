import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { migrationShapeProblems } from "./lib/validate-migration-shape.mjs";

const root = process.cwd();
const catalogsDir = join(root, "catalogs");

if (!existsSync(catalogsDir) || !statSync(catalogsDir).isDirectory()) {
  process.exit(0);
}

const errors = [];

for (const entry of readdirSync(catalogsDir)) {
  if (entry.startsWith(".") || entry.startsWith("_")) continue;
  const catalogDir = join(catalogsDir, entry);
  if (!statSync(catalogDir).isDirectory()) continue;
  const manifestPath = join(catalogDir, "manifest.json");
  if (!existsSync(manifestPath)) continue;

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    errors.push(`${entry}/manifest.json: cannot parse JSON (${err.message})`);
    continue;
  }

  const version = manifest.version;
  if (typeof version !== "string") {
    errors.push(`${entry}/manifest.json: missing "version" string`);
    continue;
  }

  const match = /^(\d+)\./.exec(version);
  if (!match) {
    errors.push(`${entry}/manifest.json: version "${version}" is not in MAJOR.MINOR.PATCH form`);
    continue;
  }
  const major = Number.parseInt(match[1], 10);
  if (major === 0) continue;

  for (let k = 1; k <= major; k++) {
    const file = `migration-v${k - 1}-to-v${k}.json`;
    if (!existsSync(join(catalogDir, file))) {
      errors.push(`${entry}: manifest at version ${version} (major ${major}) requires ${file} (see spec/discovery/catalogs.md §CT14.1)`);
    }
  }

  // Shape gate: every migration file must carry the runtime's
  // {from_version, to_version, spec_version, steps} contract (shared rule in
  // scripts/lib/validate-migration-shape.mjs) and agree with the manifest's
  // spec_version — a mis-shaped file would otherwise only fail at boot,
  // inside the upgrade picker, on a deployed world.
  for (const file of readdirSync(catalogDir).filter((name) => /^migration-v\d+-to-v\d+\.json$/.test(name)).sort()) {
    let migration;
    try {
      migration = JSON.parse(readFileSync(join(catalogDir, file), "utf8"));
    } catch (err) {
      errors.push(`${entry}/${file}: cannot parse JSON (${err.message})`);
      continue;
    }
    for (const problem of migrationShapeProblems(`${entry}/${file}`, migration)) {
      errors.push(`${entry}/${file}: ${problem}`);
    }
    if (typeof migration?.spec_version === "string" && typeof manifest.spec_version === "string" && migration.spec_version !== manifest.spec_version) {
      errors.push(`${entry}/${file}: spec_version "${migration.spec_version}" does not match manifest spec_version "${manifest.spec_version}"`);
    }
  }
}

if (errors.length > 0) {
  console.error("Catalog migration guard failed:");
  for (const err of errors) console.error(`  ${err}`);
  process.exit(1);
}
