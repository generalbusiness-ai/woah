// Shared build-time validator for bundled catalog migration files.
//
// The runtime contract (src/core/catalog-installer CatalogMigrationManifest)
// is `{from_version, to_version, spec_version, steps[]}` — NOT `{from, to,
// operations}` or any other spelling; a mis-shaped file used to surface only
// at boot as `undefined.split` inside the migration picker. Both the bundled
// index generator (scripts/generate-bundled-catalog-index.mjs) and the
// migrations guard (scripts/guard-catalog-migrations.mjs) call this so the
// same rule holds on `npm run catalog:index` and `npm test`; the runtime
// repeats it at module load (src/core/local-catalogs.ts) as defense in depth.
//
// Version rules: `from_version` may use `x` wildcards anywhere; `to_version`
// needs a concrete MAJOR (minor/patch may be `x`) so boot-upgrade composition
// (composeMigrationChain) can walk adjacent major edges. The filename encodes
// the edge (`migration-vA-to-vB.json`); the content must agree with it, or
// the every-major-edge chain the guard promises would silently not connect.

const VERSION_PATTERN = /^(\d+|x)\.(\d+|x)\.(\d+|x)$/;

/** Returns a list of problem strings (empty = valid). `file` is the
 * repo-relative path, used for the filename↔content edge check. */
export function migrationShapeProblems(file, migration) {
  const problems = [];
  if (!migration || typeof migration !== "object" || Array.isArray(migration)) {
    return ["not a JSON object"];
  }
  for (const key of ["from_version", "to_version", "spec_version"]) {
    if (typeof migration[key] !== "string") {
      problems.push(`missing string "${key}" (found keys: ${Object.keys(migration).join(", ")}) — the runtime shape is {from_version, to_version, spec_version, steps}`);
    }
  }
  if (typeof migration.from_version === "string" && !VERSION_PATTERN.test(migration.from_version)) {
    problems.push(`from_version "${migration.from_version}" is not MAJOR.MINOR.PATCH (x wildcards allowed)`);
  }
  if (typeof migration.to_version === "string" && (!VERSION_PATTERN.test(migration.to_version) || !/^\d+\./.test(migration.to_version))) {
    problems.push(`to_version "${migration.to_version}" must have a concrete MAJOR (minor/patch may be x)`);
  }
  if (!Array.isArray(migration.steps)) {
    problems.push(`"steps" must be an array (found ${typeof migration.steps})`);
  } else {
    for (const [i, step] of migration.steps.entries()) {
      if (!step || typeof step !== "object" || typeof step.kind !== "string") {
        problems.push(`steps[${i}] must be an object with a string "kind"`);
      }
    }
  }
  const edge = /migration-v(\d+)-to-v(\d+)\.json$/.exec(file);
  if (edge && typeof migration.from_version === "string" && typeof migration.to_version === "string") {
    const [, fromMajor, toMajor] = edge;
    if (Number(toMajor) !== Number(fromMajor) + 1) {
      problems.push(`filename edge v${fromMajor}→v${toMajor} is not adjacent — ship one file per major edge`);
    }
    const fromDeclared = migration.from_version.split(".")[0];
    if (fromDeclared !== "x" && fromDeclared !== fromMajor) {
      problems.push(`from_version "${migration.from_version}" disagrees with filename major v${fromMajor}`);
    }
    if (migration.to_version.split(".")[0] !== toMajor) {
      problems.push(`to_version "${migration.to_version}" disagrees with filename major v${toMajor}`);
    }
  }
  return problems;
}
