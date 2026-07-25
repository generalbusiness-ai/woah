import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.cwd();
const checkedRoots = ["src/core", "src/mcp", "src/net", "src/worker", "src/client"];
const skippedDirs = new Set(["node_modules", "dist", ".git", "src/generated"]);
const baselinePath = join(root, "scripts", "guard-layering-baseline.json");

// These names are substrate identities or compiler/runtime placeholders. They
// are architectural vocabulary rather than knowledge of an installed catalog.
const allowedRefs = new Set(["$wiz", "$system", "$nowhere", "$catalog_registry", "$catalog", "$error", "$me", "$verb"]);
const objectRefPattern = /\$[A-Za-z_][A-Za-z0-9_]*/g;
const observed = new Map();
const violations = [];

function normalize(path) {
  return relative(root, path).split(sep).join("/");
}

function walk(path) {
  const rel = normalize(path);
  if (skippedDirs.has(rel)) return;
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) walk(join(path, entry));
    return;
  }
  if (!/\.ts$/.test(path)) return;

  const source = readFileSync(path, "utf8");
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    objectRefPattern.lastIndex = 0;
    for (const match of line.matchAll(objectRefPattern)) {
      const ref = match[0];
      if (allowedRefs.has(ref)) continue;
      const key = `${rel}\0${ref}`;
      observed.set(key, {
        file: rel,
        ref,
        count: (observed.get(key)?.count ?? 0) + 1,
        firstLine: observed.get(key)?.firstLine ?? index + 1,
        snippet: observed.get(key)?.snippet ?? line.trim()
      });
    }
  }
}

for (const dir of checkedRoots) walk(join(root, dir));

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const expected = new Map();
for (const [file, refs] of Object.entries(baseline)) {
  for (const [ref, count] of Object.entries(refs)) {
    expected.set(`${file}\0${ref}`, { file, ref, count });
  }
}

// The baseline is an exact per-file/per-reference occurrence budget. It
// replaces whole-file exemptions: adding even one use of an already tolerated
// name fails, while removing debt requires deleting its stale budget now.
for (const [key, hit] of observed) {
  const budget = expected.get(key);
  if (!budget) {
    violations.push(`${hit.file}:${hit.firstLine}: new ${hit.ref}: ${hit.snippet}`);
  } else if (hit.count !== budget.count) {
    violations.push(`${hit.file}:${hit.firstLine}: ${hit.ref} occurs ${hit.count} times; baseline is ${budget.count}`);
  }
}
for (const [key, budget] of expected) {
  if (!observed.has(key)) violations.push(`${budget.file}: stale baseline for ${budget.ref}; remove the ${budget.count}-occurrence budget`);
}

if (violations.length > 0) {
  console.error("Catalog object literals leaked across the substrate/client layering boundary.");
  console.error("The exact legacy baseline may only shrink; move catalog behavior into its catalog module.");
  console.error("");
  for (const violation of violations) console.error(`  ${violation}`);
  console.error("");
  console.error(`Audited roots: ${checkedRoots.join(", ")}`);
  console.error(`Allowed substrate refs: ${Array.from(allowedRefs).sort().join(", ")}`);
  process.exit(1);
}

console.log(`layering: ok (${checkedRoots.length} roots, ${observed.size} exact legacy budgets)`);
