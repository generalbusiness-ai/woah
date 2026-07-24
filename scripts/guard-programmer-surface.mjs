import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// §8.14 of the programmer-environment remediation plan: core runtime and the
// net MCP gateway must not name the prog catalog's surface classes. The surface
// object reaches native code only as data — $system.programmer_surface, a
// catalog-published property, or an explicit generic argument — so a
// feature-composed programmer resolves through generic mechanics, never a
// hardcoded class branch.
//
// Unlike scripts/guard-layering.mjs (which exempts the large legacy core files
// wholesale while their broader object-name debt is migrated out), this guard
// is narrow and has NO file exemptions. It flags the surface classes used as
// string-literal *values* — the shape of a real branch, e.g.
// isDescendantOf("$wiz", "$programmer"), new Set([..., "$builder"]),
// chparentAuthoredObject(..., "$programmer"). Prose that merely names a class
// to explain the design (comments, docstrings) is documentation, not a branch,
// and is allowed. Bootstrap may seed the surface graph, but it does so by
// installing the prog catalog, not by literal-branching on these classes.

const root = process.cwd();
const checkedRoots = ["src/core", "src/worker/net", "src/mcp"];
const skippedDirs = new Set(["node_modules", "dist", ".git", "src/generated"]);
const forbidden = /["'`]\$(?:builder|programmer|prog)["'`]/;
const hits = [];

function normalize(path) {
  return relative(root, path).split(sep).join("/");
}

function walk(path) {
  const rel = normalize(path);
  if (skippedDirs.has(rel)) return;
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return;
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) walk(join(path, entry));
    return;
  }
  if (!/\.ts$/.test(path)) return;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (forbidden.test(line)) hits.push(`${rel}:${index + 1}: ${line.trim()}`);
  }
}

for (const dir of checkedRoots) walk(join(root, dir));

if (hits.length > 0) {
  console.error(
    "Core/gateway code must not name the prog surface classes ($builder/$programmer/$prog).\n" +
      "Reach the surface as data (e.g. $system.programmer_surface) or a generic argument instead:"
  );
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}

console.log("guard-programmer-surface: no prog surface class names in core/gateway");
