// Per-catalog DSL compile check.
//
// Walks every `catalogs/*/manifest.json`, runs each verb's `source`
// string through the DSL compiler, and verifies the `verb :name(...)`
// header matches the manifest's `name` field. Reports compile
// diagnostics with file/class/verb context and exits non-zero if any
// verb fails — same exit-code contract as the other guard scripts.
//
// This is intentionally the smallest useful first cut: it catches
// every typo and bad opcode the moment a manifest is saved, without
// needing a cross-catalog symbol table. Whole-bundle cross-reference
// (e.g. "$cls:verb does not exist") is a follow-up.
//
// Wired into the test guard script so `npm test` blocks on a clean compile.
// Run standalone via `npm run catalog:check`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { compileVerb } from "../src/core/authoring";
import type { CompileDiagnostic } from "../src/core/types";

type VerbEntry = {
  name?: unknown;
  source?: unknown;
  implementation?: unknown;
};

type ClassEntry = {
  name?: unknown;
  local_name?: unknown;
  verbs?: unknown;
};

type Manifest = {
  name?: unknown;
  classes?: unknown;
};

type Failure = {
  catalog: string;
  manifestPath: string;
  className: string;
  verbName: string;
  diagnostics: CompileDiagnostic[];
};

const root = process.cwd();
const catalogsRoot = join(root, "catalogs");
const failures: Failure[] = [];

let catalogCount = 0;
let verbCount = 0;
const t0 = Date.now();

const catalogDirs = readdirSync(catalogsRoot)
  .map((name) => join(catalogsRoot, name))
  .filter((path) => {
    try {
      return statSync(join(path, "manifest.json")).isFile();
    } catch {
      return false;
    }
  })
  .sort();

for (const dir of catalogDirs) {
  const manifestPath = join(dir, "manifest.json");
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    console.error(`catalog-check: failed to parse ${manifestPath}: ${(err as Error).message}`);
    process.exit(1);
  }

  const catalogName = typeof manifest.name === "string" ? manifest.name : relative(root, dir);
  catalogCount += 1;

  const classes = Array.isArray(manifest.classes) ? (manifest.classes as ClassEntry[]) : [];
  for (const cls of classes) {
    const className =
      (typeof cls.local_name === "string" && cls.local_name) ||
      (typeof cls.name === "string" && cls.name) ||
      "<anonymous-class>";
    const verbs = Array.isArray(cls.verbs) ? (cls.verbs as VerbEntry[]) : [];
    for (const verb of verbs) {
      const verbName = typeof verb.name === "string" ? verb.name : "<unnamed>";
      // Verbs with a native implementation block carry no DSL source.
      if (typeof verb.source !== "string") continue;
      verbCount += 1;

      const compiled = compileVerb(verb.source);
      const diags: CompileDiagnostic[] = [];

      if (!compiled.ok || !compiled.bytecode) {
        diags.push(...compiled.diagnostics);
      } else {
        // Header-name guard: matches the check that
        // `installVerbWithOwner` enforces at runtime, lifted here so a
        // mismatch fails the build instead of one specific install.
        const headerName = compiled.metadata?.name;
        if (typeof headerName === "string" && headerName !== verbName) {
          diags.push({
            severity: "error",
            code: "E_HEADER_NAME",
            message: `verb header names :${headerName}, but manifest entry is "${verbName}"`,
          });
        }
      }

      if (diags.length > 0) {
        failures.push({ catalog: catalogName, manifestPath, className, verbName, diagnostics: diags });
      }
    }
  }
}

const elapsedMs = Date.now() - t0;

if (failures.length === 0) {
  console.log(`catalog-check: ${catalogCount} catalogs, ${verbCount} verbs, ${elapsedMs}ms`);
  process.exit(0);
}

console.error(`catalog-check: ${failures.length} verb(s) failed across ${catalogCount} catalogs (${verbCount} compiled, ${elapsedMs}ms)`);
console.error("");
for (const f of failures) {
  const rel = relative(root, f.manifestPath);
  console.error(`  ${f.catalog}/${f.className}:${f.verbName}  (${rel})`);
  for (const d of f.diagnostics) {
    const span = d.span ? ` at line ${d.span.line}:${d.span.column}` : "";
    console.error(`      ${d.severity} ${d.code}: ${d.message}${span}`);
  }
}
process.exit(1);
