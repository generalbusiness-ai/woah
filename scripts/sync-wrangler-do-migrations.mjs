#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CONFIG = "wrangler.toml";

export function parseWranglerDoState(text) {
  const lines = text.split(/\r?\n/);
  const bindings = [];
  const migrations = [];
  let block = null;
  let current = null;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = stripComment(raw).trim();
    if (!line) continue;

    if (line === "[[durable_objects.bindings]]") {
      block = "binding";
      current = {};
      bindings.push(current);
      continue;
    }
    if (line === "[[migrations]]") {
      block = "migration";
      current = { tag: "", new_classes: [], new_sqlite_classes: [], deleted_classes: [], renamed_classes: [] };
      migrations.push(current);
      continue;
    }
    if (line === "[[migrations.renamed_classes]]") {
      block = "renamed";
      const migration = migrations.at(-1);
      if (!migration) throw new Error(`renamed_classes block before migration at line ${i + 1}`);
      current = {};
      migration.renamed_classes.push(current);
      continue;
    }
    if (line.startsWith("[[")) {
      block = null;
      current = null;
      continue;
    }

    if (block === "binding" && current) {
      assignString(current, line, "name");
      assignString(current, line, "class_name");
      continue;
    }
    if (block === "migration" && current) {
      assignString(current, line, "tag");
      for (const key of ["new_classes", "new_sqlite_classes", "deleted_classes"]) {
        if (line.startsWith(`${key} =`)) current[key] = readStringArray(lines, i).values;
      }
      if (line.startsWith("renamed_classes =")) {
        const read = readInlineRenames(lines, i);
        current.renamed_classes.push(...read.values);
        i = read.end;
      }
      continue;
    }
    if (block === "renamed" && current) {
      assignString(current, line, "from");
      assignString(current, line, "to");
    }
  }

  return {
    bindings: bindings
      .filter((binding) => binding.name && binding.class_name)
      .map((binding) => ({ name: binding.name, class_name: binding.class_name })),
    migrations
  };
}

export function analyzeDoMigrations(text) {
  const parsed = parseWranglerDoState(text);
  const tags = new Set();
  const duplicateTags = [];
  for (const migration of parsed.migrations) {
    if (!migration.tag) continue;
    if (tags.has(migration.tag)) duplicateTags.push(migration.tag);
    tags.add(migration.tag);
  }

  const activeClasses = applyMigrations(parsed.migrations);
  const boundClasses = new Set(parsed.bindings.map((binding) => binding.class_name));
  const missingCreates = sorted([...boundClasses].filter((className) => !activeClasses.has(className)));
  const activeButUnbound = sorted([...activeClasses].filter((className) => !boundClasses.has(className)));

  return {
    ...parsed,
    activeClasses: sorted([...activeClasses]),
    boundClasses: sorted([...boundClasses]),
    duplicateTags,
    missingCreates,
    activeButUnbound,
    ok: duplicateTags.length === 0 && missingCreates.length === 0 && activeButUnbound.length === 0
  };
}

export function syncWranglerDoMigrations(text, options = {}) {
  const analysis = analyzeDoMigrations(text);
  const errors = [];
  if (analysis.duplicateTags.length > 0) errors.push(`duplicate migration tags: ${analysis.duplicateTags.join(", ")}`);
  if (analysis.activeButUnbound.length > 0 && options.allowDelete !== true) {
    errors.push(`unbound Durable Object classes would need a delete migration: ${analysis.activeButUnbound.join(", ")}`);
  }
  if (errors.length > 0) return { changed: false, text, analysis, errors };

  const steps = [];
  if (analysis.missingCreates.length > 0) steps.push({ new_sqlite_classes: analysis.missingCreates });
  if (analysis.activeButUnbound.length > 0) steps.push({ deleted_classes: analysis.activeButUnbound });
  if (steps.length === 0) return { changed: false, text, analysis, errors: [] };

  const usedTags = new Set(analysis.migrations.map((migration) => migration.tag).filter(Boolean));
  let nextIndex = analysis.migrations.length + 1;
  const blocks = steps.map((step) => {
    let tag;
    do {
      tag = `cf-do-${String(nextIndex).padStart(4, "0")}`;
      nextIndex += 1;
    } while (usedTags.has(tag));
    usedTags.add(tag);
    return formatMigration({ tag, ...step });
  });
  const nextText = `${text.trimEnd()}\n\n${blocks.join("\n\n")}\n`;
  return { changed: true, text: nextText, analysis: analyzeDoMigrations(nextText), errors: [] };
}

function applyMigrations(migrations) {
  const active = new Set();
  for (const migration of migrations) {
    for (const className of migration.new_classes ?? []) active.add(className);
    for (const className of migration.new_sqlite_classes ?? []) active.add(className);
    for (const rename of migration.renamed_classes ?? []) {
      if (rename.from) active.delete(rename.from);
      if (rename.to) active.add(rename.to);
    }
    for (const className of migration.deleted_classes ?? []) active.delete(className);
  }
  return active;
}

function formatMigration(migration) {
  const lines = ["[[migrations]]", `tag = "${migration.tag}"`];
  if (migration.new_sqlite_classes?.length) lines.push(`new_sqlite_classes = ${formatArray(migration.new_sqlite_classes)}`);
  if (migration.new_classes?.length) lines.push(`new_classes = ${formatArray(migration.new_classes)}`);
  if (migration.deleted_classes?.length) lines.push(`deleted_classes = ${formatArray(migration.deleted_classes)}`);
  for (const rename of migration.renamed_classes ?? []) {
    lines.push("", "  [[migrations.renamed_classes]]", `  from = "${rename.from}"`, `  to = "${rename.to}"`);
  }
  return lines.join("\n");
}

function formatArray(values) {
  return `[${values.map((value) => ` "${value}"`).join(",")} ]`;
}

function assignString(target, line, key) {
  const match = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`).exec(line);
  if (match) target[key] = match[1];
}

function readStringArray(lines, start) {
  let body = "";
  let end = start;
  for (let i = start; i < lines.length; i += 1) {
    body += `\n${stripComment(lines[i])}`;
    end = i;
    if (stripComment(lines[i]).includes("]")) break;
  }
  return {
    values: Array.from(body.matchAll(/"([^"]+)"/g)).map((match) => match[1]),
    end
  };
}

function readInlineRenames(lines, start) {
  let body = "";
  let end = start;
  for (let i = start; i < lines.length; i += 1) {
    body += `\n${stripComment(lines[i])}`;
    end = i;
    if (stripComment(lines[i]).includes("]")) break;
  }
  const values = [];
  for (const match of body.matchAll(/\{\s*from\s*=\s*"([^"]+)"\s*,\s*to\s*=\s*"([^"]+)"\s*\}/g)) {
    values.push({ from: match[1], to: match[2] });
  }
  return { values, end };
}

function stripComment(line) {
  let inString = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "\"" && line[i - 1] !== "\\") inString = !inString;
    if (char === "#" && !inString) return line.slice(0, i);
  }
  return line;
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function parseArgs(argv) {
  const options = { check: false, write: false, allowDelete: false, config: DEFAULT_CONFIG };
  for (const arg of argv) {
    if (arg === "--check") options.check = true;
    else if (arg === "--write") options.write = true;
    else if (arg === "--allow-delete") options.allowDelete = true;
    else if (arg.startsWith("--config=")) options.config = arg.slice("--config=".length);
    else throw new Error(`unknown flag: ${arg}`);
  }
  if (!options.check && !options.write) options.check = true;
  if (options.check && options.write) throw new Error("use either --check or --write, not both");
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const configPath = resolve(process.cwd(), options.config);
  const current = readFileSync(configPath, "utf8");
  const result = syncWranglerDoMigrations(current, options);
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`cf-do-migrations: ${error}`);
    process.exitCode = 1;
    return;
  }
  if (options.write && result.changed) writeFileSync(configPath, result.text);
  if (options.check && result.changed) {
    const initial = analyzeDoMigrations(current);
    console.error("cf-do-migrations: wrangler.toml is missing Durable Object migration entries; run npm run cf:migrations");
    console.error(`missing create classes: ${initial.missingCreates.join(", ") || "(none)"}`);
    process.exitCode = 1;
    return;
  }
  const checked = options.write && result.changed ? result.analysis : analyzeDoMigrations(current);
  console.log(`cf-do-migrations: ok bindings=${checked.boundClasses.join(",") || "(none)"} tags=${checked.migrations.length}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`cf-do-migrations: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
