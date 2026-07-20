#!/usr/bin/env node
// guard-client-imports — fail fast on browser-incompatible imports in the
// client bundle's transitive closure.
//
// The browser bundle entry is src/client/main.ts. Anything reachable from it,
// directly or via imports, must work in a browser/Worker context. The bundler
// is the ultimate authority, but the bundler only runs during `npm run build`,
// which fails late in deploy. This guard walks the static import graph from
// the client entry and flags any Node builtin import it sees on the
// way. It catches the common failure of an existing module suddenly being
// pulled into the browser because a worker-side file started importing a
// runtime symbol from a Node-side module.
//
// What this guard does NOT do:
//   - Detect non-literal dynamic imports.
//   - Detect runtime feature checks (e.g. `if (process)`).
//   - Replace `npm run build`. Bundlers can fail for many other reasons.
//
// The guard is intentionally narrow. It reports file:line of the offending
// import so the fix path is obvious.

import { readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

const root = process.cwd();
const entries = [
  // Browser bundle: anything reachable from main.ts ends up in the SPA bundle.
  "src/client/main.ts"
];

const visited = new Set();
const violations = [];
const nodeBuiltinSpecifiers = new Set(
  builtinModules.flatMap((specifier) => specifier.startsWith("node:")
    ? [specifier, specifier.slice("node:".length)]
    : [specifier, `node:${specifier}`])
);

function isNodeBuiltinSpecifier(specifier) {
  return nodeBuiltinSpecifiers.has(specifier);
}

function tryResolveModule(specifier, fromFile) {
  // Relative or absolute path: resolve against the importing file's directory.
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const base = resolve(dirname(fromFile), specifier);
    for (const ext of ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.js"]) {
      const candidate = base + ext;
      try {
        const stat = statSync(candidate);
        if (stat.isFile()) return candidate;
      } catch {
        // try next
      }
    }
    return null;
  }
  // Node builtins, package imports: not a project-local source file, so the
  // guard either flags it (for Node builtins) or treats it as opaque (for npm packages —
  // those are vetted at install time and bundled separately).
  return null;
}

// Strip line/block comments before scanning. We want to ignore comment-only
// references like `// see node:crypto example`, not just runtime imports.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const importPattern = /(?:^|\s)(?:import|export)(?:\s+[^"']*?)?\s+from\s+["']([^"']+)["']/g;
const sideEffectImportPattern = /(?:^|\s)import\s+["']([^"']+)["']/g;
const dynamicImportPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function specifiersFromSource(source) {
  const stripped = stripComments(source);
  const out = [];
  for (const pattern of [importPattern, sideEffectImportPattern, dynamicImportPattern]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(stripped)) !== null) out.push(match[1]);
  }
  return out;
}

function lineOf(source, specifier) {
  const idx = source.indexOf(specifier);
  if (idx < 0) return 0;
  return source.slice(0, idx).split(/\r?\n/).length;
}

function walk(file) {
  if (visited.has(file)) return;
  visited.add(file);
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return;
  }
  const rel = relative(root, file);
  for (const specifier of specifiersFromSource(source)) {
    if (isNodeBuiltinSpecifier(specifier)) {
      violations.push({ file: rel, line: lineOf(source, specifier), specifier });
      continue;
    }
    const resolved = tryResolveModule(specifier, file);
    if (resolved) walk(resolved);
  }
}

for (const entry of entries) walk(join(root, entry));

if (violations.length > 0) {
  console.error("Client bundle pulls in Node-only modules:");
  console.error("(remove the import, or move the symbol behind a runtime");
  console.error(" branch that does not statically import Node builtin code)");
  console.error();
  for (const { file, line, specifier } of violations) {
    console.error(`  ${file}:${line}: import from "${specifier}"`);
  }
  console.error();
  console.error("Reachable client entries:");
  for (const entry of entries) console.error(`  - ${entry}`);
  process.exit(1);
}

console.log(`guard-client-imports: ok (scanned ${visited.size} files from ${entries.length} entries)`);
