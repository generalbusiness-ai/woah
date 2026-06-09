#!/usr/bin/env node
// guard:smoke-wrangler — keep wrangler.smoke.toml's Durable Object surface in
// lockstep with production wrangler.toml.
//
// The smoke lane (scripts/smoke-cf-dev.ts) boots real workerd from a SEPARATE
// config (wrangler.smoke.toml) that deliberately strips routes/assets/AE and
// inlines local-only vars, but DUPLICATES the DO bindings + sqlite-class
// migrations. The migration sync/check tool only looks at wrangler.toml, so a
// future DO binding or migration change to production could silently leave the
// smoke config behind — and then the pre-deploy gate would boot a different DO
// class set than production. This guard fails when the two drift.
//
// It compares only the DO-relevant subset (bindings + migration sequence). The
// intentional differences (name, routes, assets, AE, vars, KV id) are ignored.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeDoMigrations, parseWranglerDoState } from "./sync-wrangler-do-migrations.mjs";

const PROD_CONFIG = "wrangler.toml";
const SMOKE_CONFIG = "wrangler.smoke.toml";

// Canonical, order-preserving signature of the DO bindings + migration history.
// Migrations are order-sensitive (they replay to compute the active class set),
// so the sequence — not just the set — must match.
function doSignature(text) {
  const { bindings, migrations } = parseWranglerDoState(text);
  return JSON.stringify({
    bindings: [...bindings]
      .map((b) => ({ name: b.name, class_name: b.class_name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    migrations: migrations.map((m) => ({
      tag: m.tag,
      new_classes: m.new_classes ?? [],
      new_sqlite_classes: m.new_sqlite_classes ?? [],
      deleted_classes: m.deleted_classes ?? [],
      renamed_classes: (m.renamed_classes ?? []).map((r) => ({ from: r.from, to: r.to }))
    }))
  }, null, 2);
}

function main() {
  const prodPath = resolve(process.cwd(), PROD_CONFIG);
  const smokePath = resolve(process.cwd(), SMOKE_CONFIG);
  const prodText = readFileSync(prodPath, "utf8");
  const smokeText = readFileSync(smokePath, "utf8");

  // The smoke config's own DO migration history must be internally valid
  // (every bound class created, no duplicate tags, no orphaned actives) — the
  // same invariant cf:migrations:check enforces for production.
  const smokeAnalysis = analyzeDoMigrations(smokeText);
  if (!smokeAnalysis.ok) {
    console.error(`guard:smoke-wrangler: ${SMOKE_CONFIG} DO migrations are inconsistent`);
    if (smokeAnalysis.duplicateTags.length) console.error(`  duplicate tags: ${smokeAnalysis.duplicateTags.join(", ")}`);
    if (smokeAnalysis.missingCreates.length) console.error(`  bound classes without a create migration: ${smokeAnalysis.missingCreates.join(", ")}`);
    if (smokeAnalysis.activeButUnbound.length) console.error(`  active classes with no binding: ${smokeAnalysis.activeButUnbound.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const prodSig = doSignature(prodText);
  const smokeSig = doSignature(smokeText);
  if (prodSig !== smokeSig) {
    console.error(
      `guard:smoke-wrangler: ${SMOKE_CONFIG} Durable Object bindings/migrations have drifted from ${PROD_CONFIG}.\n` +
      `Mirror the DO bindings + [[migrations]] blocks from ${PROD_CONFIG} into ${SMOKE_CONFIG} (routes/assets/AE/vars/KV id intentionally differ).\n` +
      `--- ${PROD_CONFIG} DO surface ---\n${prodSig}\n--- ${SMOKE_CONFIG} DO surface ---\n${smokeSig}`
    );
    process.exitCode = 1;
    return;
  }

  console.log(`guard:smoke-wrangler: ok — ${SMOKE_CONFIG} DO surface matches ${PROD_CONFIG} (${smokeAnalysis.boundClasses.length} classes, ${smokeAnalysis.migrations.length} migrations)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`guard:smoke-wrangler: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
