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
  arg_spec?: unknown;
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
      const metadataDiagnostics = toolMetadataDiagnostics(verb.arg_spec);
      // Verbs with a native implementation block carry no DSL source.
      if (typeof verb.source !== "string") {
        if (metadataDiagnostics.length > 0) {
          failures.push({ catalog: catalogName, manifestPath, className, verbName, diagnostics: metadataDiagnostics });
        }
        continue;
      }
      verbCount += 1;

      const compiled = compileVerb(verb.source);
      const diags: CompileDiagnostic[] = [];
      diags.push(...metadataDiagnostics);

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

/** Catalog tool metadata is persisted as ordinary arg_spec data and can be
 * authored outside MCP. Validate bundled declarations here so malformed risk
 * hints never silently ship; the runtime still ignores malformed aged/user
 * metadata conservatively. */
function toolMetadataDiagnostics(rawArgSpec: unknown): CompileDiagnostic[] {
  if (typeof rawArgSpec !== "object" || rawArgSpec === null || Array.isArray(rawArgSpec)) return [];
  const argSpec = rawArgSpec as Record<string, unknown>;
  const diagnostics: CompileDiagnostic[] = [];
  const fail = (message: string) => diagnostics.push({ severity: "error", code: "E_TOOL_METADATA", message });
  if (argSpec.output_schema !== undefined
      && (typeof argSpec.output_schema !== "object" || argSpec.output_schema === null || Array.isArray(argSpec.output_schema))) {
    fail("arg_spec.output_schema must be a JSON Schema object");
  }
  if (argSpec.authority !== undefined) {
    if (typeof argSpec.authority !== "object" || argSpec.authority === null || Array.isArray(argSpec.authority)) {
      fail("arg_spec.authority must be an object");
    } else {
      const authority = argSpec.authority as Record<string, unknown>;
      if (authority.authoring_target !== undefined) {
        const target = authority.authoring_target;
        const arg = target && typeof target === "object" && !Array.isArray(target)
          ? (target as Record<string, unknown>).arg
          : undefined;
        if (typeof arg !== "number" || !Number.isInteger(arg) || arg < 0) {
          fail("arg_spec.authority.authoring_target must be {arg: <non-negative integer>}");
        }
        if (!Array.isArray(authority.prefetch)
            || !(authority.prefetch as unknown[]).some((entry) =>
              entry !== null
              && typeof entry === "object"
              && !Array.isArray(entry)
              && (entry as Record<string, unknown>).arg === arg)) {
          fail("arg_spec.authority.authoring_target must also appear in authority.prefetch");
        }
      }
    }
  }
  if (argSpec.tool === undefined) return diagnostics;
  if (typeof argSpec.tool !== "object" || argSpec.tool === null || Array.isArray(argSpec.tool)) {
    fail("arg_spec.tool must be an object");
    return diagnostics;
  }
  const tool = argSpec.tool as Record<string, unknown>;
  for (const field of ["title", "description", "authority"] as const) {
    if (tool[field] !== undefined && (typeof tool[field] !== "string" || tool[field].trim() === "")) {
      fail(`arg_spec.tool.${field} must be a non-empty string`);
    }
  }
  if (tool.availability !== undefined && tool.availability !== "implemented" && tool.availability !== "deferred") {
    fail('arg_spec.tool.availability must be "implemented" or "deferred"');
  }
  if (tool.effects !== undefined) {
    if (typeof tool.effects !== "object" || tool.effects === null || Array.isArray(tool.effects)) {
      fail("arg_spec.tool.effects must be an object");
    } else {
      const effects = tool.effects as Record<string, unknown>;
      for (const field of ["read_only", "destructive", "idempotent", "open_world"] as const) {
        if (effects[field] !== undefined && typeof effects[field] !== "boolean") {
          fail(`arg_spec.tool.effects.${field} must be boolean`);
        }
      }
    }
  }
  return diagnostics;
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
