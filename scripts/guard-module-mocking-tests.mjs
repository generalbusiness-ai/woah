// Guard: every test file that rewrites the module registry must run isolated.
//
// The suite runs with `isolate: false` because sharing one module registry per
// worker is ~36% faster over the full sweep. The cost is that `vi.mock()`,
// `vi.doMock()`, and `vi.resetModules()` do not stay inside the file that calls
// them — they reach every other file that worker runs. Thread scheduling picks
// those neighbours, and it picks differently each run, so the damage is
// intermittent and surfaces in an innocent file rather than the one holding the
// mock. That is an expensive class of flake to diagnose; this guard stops a new
// one from being introduced silently.
//
// vite.config.ts lists the mocking files in MODULE_MOCKING_TESTS and runs
// exactly those in a project with `isolate: true`. This guard keeps that list
// in sync with reality, in both directions: an unlisted file that mocks fails,
// and a listed file that no longer mocks fails so the list cannot rot into a
// permanent slow lane nobody revisits.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.cwd();
const testsRoot = join(root, "tests");
const configPath = join(root, "vite.config.ts");

// `vi.mock(`, `vi.doMock(`, `vi.resetModules(`, and the unmock/doUnmock pair.
// Matching the call form rather than the bare identifier keeps a passing
// mention in a comment or string from tripping the guard.
const MOCKING_CALL = /\bvi\s*\.\s*(mock|doMock|unmock|doUnmock|resetModules)\s*\(/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (full.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function normalize(path) {
  return relative(root, path).split(sep).join("/");
}

// Read the declared list straight out of the config source. Importing the
// config would drag in the whole vite pipeline for one array.
const configSource = readFileSync(configPath, "utf8");
const declaredBlock = /const MODULE_MOCKING_TESTS = \[([^\]]*)\]/.exec(configSource);
if (!declaredBlock) {
  console.error("guard-module-mocking-tests: MODULE_MOCKING_TESTS not found in vite.config.ts.");
  console.error("If the isolation split was intentionally removed, delete this guard with it.");
  process.exit(1);
}
const declared = new Set(
  [...declaredBlock[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1])
);

const actual = new Set(
  walk(testsRoot)
    .filter((file) => MOCKING_CALL.test(readFileSync(file, "utf8")))
    .map(normalize)
);

const unlisted = [...actual].filter((file) => !declared.has(file)).sort();
const stale = [...declared].filter((file) => !actual.has(file)).sort();

if (unlisted.length > 0 || stale.length > 0) {
  console.error("Module-mocking test files are out of sync with vite.config.ts MODULE_MOCKING_TESTS.");
  console.error("");
  for (const file of unlisted) {
    console.error(`  ${file}: mocks modules but is not listed, so it runs in the shared-registry`);
    console.error("    pool and its mocks can corrupt unrelated test files. Add it to the list.");
  }
  for (const file of stale) {
    console.error(`  ${file}: listed but no longer mocks modules. Remove it so it rejoins the`);
    console.error("    faster shared pool.");
  }
  console.error("");
  process.exit(1);
}

console.log(`guard-module-mocking-tests: ${actual.size} isolated file(s) in sync.`);
