import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.cwd();
const checkedRoots = ["src/core", "src/mcp"];
const skippedDirs = new Set(["node_modules", "dist", ".git", "src/generated"]);

// These substrate identifiers are architectural roots or compiler/runtime
// placeholders, not catalog-level object names.
const allowedRefs = new Set(["$wiz", "$system", "$nowhere", "$catalog_registry", "$catalog", "$error", "$me", "$verb"]);

// Existing files still carry catalog-object knowledge that predates this guard.
// Keep the exemptions narrow so new v2 code cannot add fresh object-name
// dependencies while that legacy debt is migrated out of core/MCP code.
const legacyDebtFiles = new Set([
  "src/core/bootstrap.ts",
  "src/core/catalog-installer.ts",
  "src/core/catalog-taps.ts",
  "src/core/dsl-compiler.ts",
  "src/core/local-catalogs.ts",
  "src/core/protocol.ts",
  "src/core/repository.ts",
  "src/core/tiny-vm.ts",
  "src/core/types.ts",
  "src/core/world.ts",
  "src/mcp/host.ts"
]);

const objectRefPattern = /\$[A-Za-z_][A-Za-z0-9_]*/g;
const hits = [];

const forbiddenTransportCatalogCouplings = [
  { file: "src/mcp/gateway.ts", snippet: 'verb === "leave"', reason: "MCP transport must read deterministic movement rules from verb metadata, not command words" },
  { file: "src/mcp/gateway.ts", snippet: 'verb === "out"', reason: "MCP transport must read deterministic movement rules from verb metadata, not command words" },
  { file: "src/mcp/gateway.ts", snippet: '"mount_room"', reason: "MCP transport must not know mounted-tool catalog properties" },
  { file: "src/mcp/gateway.ts", snippet: '"exits"', reason: "MCP transport must not know room-topology catalog properties" },
  { file: "src/mcp/gateway.ts", snippet: '"dest"', reason: "MCP transport must not know room-topology catalog properties" }
];

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
  if (legacyDebtFiles.has(rel)) return;

  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    objectRefPattern.lastIndex = 0;
    for (const match of line.matchAll(objectRefPattern)) {
      const ref = match[0];
      if (!allowedRefs.has(ref)) hits.push(`${rel}:${index + 1}: ${ref}: ${line.trim()}`);
    }
  }
}

for (const dir of checkedRoots) walk(join(root, dir));

for (const { file, snippet, reason } of forbiddenTransportCatalogCouplings) {
  const text = readFileSync(join(root, file), "utf8");
  const index = text.indexOf(snippet);
  if (index === -1) continue;
  const line = text.slice(0, index).split(/\r?\n/).length;
  hits.push(`${file}:${line}: ${snippet}: ${reason}`);
}

if (hits.length > 0) {
  console.error("Catalog object literals and catalog-specific transport couplings must not leak into new core/MCP implementation files:");
  for (const hit of hits) console.error(`  ${hit}`);
  console.error("");
  console.error(`Allowed substrate refs: ${Array.from(allowedRefs).sort().join(", ")}`);
  console.error("Legacy debt exemptions are listed in scripts/guard-layering.mjs and should shrink over time.");
  process.exit(1);
}
