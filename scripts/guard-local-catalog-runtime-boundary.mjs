#!/usr/bin/env node
// Bundled catalog helpers may run during bootstrap, operator/lifecycle repair,
// and catalog status reporting. They must not become a dependency of ordinary
// runtime semantics or generic command/verb execution.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.cwd();
const srcRoot = join(root, "src");
const skippedDirs = new Set(["node_modules", "dist", ".git", "src/generated"]);

const allowedImporters = new Map([
  ["src/core/bootstrap.ts", "empty-world bootstrap and explicit catalog install option"],
  ["src/core/protocol.ts", "catalog status/index protocol reporting"],
  ["src/net/install.ts", "net-namespace world install pipeline (cutover item A): a lifecycle surface, never turn runtime"],
  ["src/mcp/stdio.ts", "startup parsing of auto-install configuration"],
  ["src/server/dev-server.ts", "startup parsing of auto-install configuration"],
  ["src/server/net-dev.ts", "Net developer-composition startup and install selection"],
  ["src/worker/commit-scope-do.ts", "host-scoped catalog lifecycle repair on durable scope open"],
  ["src/worker/persistent-object-do.ts", "gateway/host lifecycle catalog install and repair"]
]);

const importPattern = /from\s+["']([^"']*local-catalogs)["']|import\(["']([^"']*local-catalogs)["']\)/g;
const violations = [];
const observed = new Set();

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

  const text = readFileSync(path, "utf8");
  importPattern.lastIndex = 0;
  for (const match of text.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2];
    if (!specifier) continue;
    observed.add(rel);
    if (!allowedImporters.has(rel)) {
      violations.push(`${rel}: imports ${specifier}`);
    }
  }
}

walk(srcRoot);

if (violations.length > 0) {
  console.error("Bundled catalog helpers must stay out of ordinary runtime semantics:");
  for (const violation of violations) console.error(`  ${violation}`);
  console.error("");
  console.error("Allowed importers are lifecycle/bootstrap/status surfaces:");
  for (const [file, reason] of allowedImporters) console.error(`  ${file}: ${reason}`);
  process.exit(1);
}

const missing = [...observed].filter((file) => !allowedImporters.has(file));
if (missing.length > 0) {
  console.error(`internal guard error: unclassified importers ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`local catalog runtime boundary: ok (${observed.size} importers audited)`);
