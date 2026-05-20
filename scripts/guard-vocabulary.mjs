// Vocabulary guard — flags forbidden words from spec/semantics/distribution.md §DT5.
//
// The distribution model has three roles: Execute, Sequence, Hold. Several
// vocabulary patterns from earlier framings contradict that model:
//
//   - "primary host" / "backstop" suggest objects have a primary location
//     and a fallback authority. They do not: a scope's sequencer is the
//     only authority on order, and any node may execute or hold state.
//   - "instances_self_host" attaches host identity to a class. The class
//     property is being retired; placement is a cache hint, not an
//     authority claim. New code should not introduce more uses.
//
// Baseline: scripts/guard-vocabulary-baseline.json records per-file counts
// of currently-tolerated legacy occurrences. New occurrences beyond the
// baseline fail the guard. Baseline counts are a debt ledger expected to
// shrink as the legacy framing is migrated out; the script reports when a
// baseline entry has shrunk so it can be lowered.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.cwd();
// Limited to source code — spec/ legitimately describes properties as they
// exist today and the migration anti-patterns themselves.
const checkedRoots = ["src", "scripts"];
const skippedDirs = new Set(["node_modules", "dist", ".git", "src/generated"]);

// Each forbidden phrase is matched as a substring against source text.
// Keep the list narrow: only patterns the spec explicitly retires. Broader
// vocabulary creep can be added later as the migration progresses.
const forbidden = [
  { pattern: "primary_host" },
  { pattern: "primaryHost" },
  { pattern: "backstop" },
  { pattern: "instances_self_host" }
];

// Files that document or guard the vocabulary itself — they must mention
// the forbidden phrases without violating the rule.
const selfReferentialFiles = new Set([
  "scripts/guard-vocabulary.mjs",
  "scripts/guard-vocabulary-baseline.json",
  "spec/semantics/distribution.md"
]);

const baselinePath = "scripts/guard-vocabulary-baseline.json";
const baseline = existsSync(join(root, baselinePath))
  ? JSON.parse(readFileSync(join(root, baselinePath), "utf8"))
  : {};

const counts = {};

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
  if (!/\.(ts|mjs|js|tsx|jsx)$/.test(path)) return;
  if (selfReferentialFiles.has(rel)) return;

  const text = readFileSync(path, "utf8");
  for (const { pattern } of forbidden) {
    const re = new RegExp(escapeRegex(pattern), "g");
    const matches = text.match(re);
    if (matches && matches.length > 0) {
      counts[rel] ??= {};
      counts[rel][pattern] = matches.length;
    }
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

for (const dir of checkedRoots) {
  if (existsSync(join(root, dir))) walk(join(root, dir));
}

let exitCode = 0;
const newViolations = [];
const dwindling = [];

const allFiles = new Set([...Object.keys(counts), ...Object.keys(baseline)]);
for (const file of allFiles) {
  const seen = counts[file] ?? {};
  const allowed = baseline[file] ?? {};
  const allPatterns = new Set([...Object.keys(seen), ...Object.keys(allowed)]);
  for (const pattern of allPatterns) {
    const seenN = seen[pattern] ?? 0;
    const allowedN = allowed[pattern] ?? 0;
    if (seenN > allowedN) {
      newViolations.push(`${file}: '${pattern}' appears ${seenN}× (baseline ${allowedN})`);
      exitCode = 1;
    } else if (seenN < allowedN) {
      dwindling.push(`${file}: '${pattern}' down to ${seenN}× (baseline ${allowedN}) — please update baseline`);
    }
  }
}

if (newViolations.length) {
  console.error("Vocabulary guard — new occurrences not in baseline:");
  for (const v of newViolations) console.error(`  ${v}`);
  console.error("");
  console.error("See spec/semantics/distribution.md §DT5 for the model these");
  console.error("phrases contradict. If you need to keep the new occurrence,");
  console.error(`update ${baselinePath} — the baseline is a debt ledger and is`);
  console.error("expected to shrink, not grow.");
  process.exit(exitCode);
}

if (dwindling.length) {
  console.log("Vocabulary guard — baseline shrank, please lower the counts:");
  for (const d of dwindling) console.log(`  ${d}`);
  process.exit(1);
}
