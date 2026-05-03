import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

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
}

if (errors.length > 0) {
  console.error("Catalog migration guard failed:");
  for (const err of errors) console.error(`  ${err}`);
  process.exit(1);
}
