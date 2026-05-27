#!/usr/bin/env node
// guard-serialized-access — keep `serializedFor(scope)` the only door to a
// ShadowCommitScope's materialized SerializedWorld.
//
// Step 1 of notes/2026-05-25-distributed-vm-document-data-path.md made
// `ShadowCommitScope.serialized` a lazy, dirty-tracked cache. The cache is
// materialized exactly once, inside `serializedFor(scope, …)`, which records
// the `serialized_world_materialized` metric. Any code that reads or writes
// `scope.serialized` directly bypasses the dirty check and the metric, and can
// silently reintroduce the per-commit eager materialization the step removed.
//
// The `.serialized` field name is shared by other types (executor nodes carry
// `node.serialized`; functions take an `input.serialized` argument). Those are
// NOT the commit-scope cache and are deliberately left alone. This guard only
// bans `.serialized` access on identifiers that name a ShadowCommitScope —
// `scope`, `commitScope`, and `<x>.commit_scope` — outside the accessor's own
// module, where the constructor and the cache internals legitimately live.
//
// What this guard does NOT do:
//   - Type-check. It matches by the conventional commit-scope variable names,
//     not by resolved TypeScript type. A commit scope held under an unusual
//     name would slip through; rename it to `commitScope`/`commit_scope`.
//   - Replace review. It is a narrow tripwire against the specific regression.
//
// It reports file:line so the fix (call `serializedFor(scope, { reason })`) is
// obvious.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const srcDir = join(root, "src");

// The accessor, the constructor, and the cache internals all live here. This
// is the "accessor and constructor/legacy import boundary" the note exempts.
const allowedFile = join("src", "core", "shadow-commit-scope.ts");

// Direct access to a commit scope's lazy cache field. Each pattern is anchored
// so it matches the field access, not a longer identifier (`scopeData` etc.).
const bannedPatterns = [
  { re: /\bcommitScope\.serialized\b/, hint: "use serializedFor(commitScope, { reason })" },
  { re: /\bcommit_scope\.serialized\b/, hint: "use serializedFor(<…>.commit_scope, { reason })" },
  { re: /(^|[^.\w])scope\.serialized\b/, hint: "use serializedFor(scope, { reason })" }
];

function collectTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

// Strip comments so prose mentions of `scope.serialized` in a doc-comment do
// not trip the guard — only runtime references should.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const violations = [];
for (const file of collectTsFiles(srcDir)) {
  const rel = relative(root, file);
  if (rel === allowedFile) continue;
  const source = readFileSync(file, "utf8");
  const stripped = stripComments(source);
  const lines = stripped.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    for (const { re, hint } of bannedPatterns) {
      if (re.test(lines[i])) violations.push({ file: rel, line: i + 1, hint });
    }
  }
}

if (violations.length > 0) {
  console.error("Direct ShadowCommitScope.serialized access bypasses serializedFor():");
  console.error("(the lazy cache is materialized only inside serializedFor, which");
  console.error(" emits serialized_world_materialized — see Step 1 of");
  console.error(" notes/2026-05-25-distributed-vm-document-data-path.md)");
  console.error();
  for (const { file, line, hint } of violations) {
    console.error(`  ${file}:${line}: ${hint}`);
  }
  process.exit(1);
}

console.log("guard-serialized-access: ok");
