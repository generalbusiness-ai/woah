#!/usr/bin/env node
// guard:smoke-wrangler — keep wrangler.smoke.toml and wrangler.cf-e2e.toml's
// Durable Object surface in lockstep with production wrangler.toml.
//
// Both the smoke lane (scripts/smoke-cf-dev.ts) and the CF e2e lane
// (scripts/e2e-cf-dev.ts) boot real workerd from a SEPARATE config that
// deliberately strips routes/AE and inlines local-only vars, but DUPLICATES the
// DO bindings + sqlite-class migrations. The migration sync/check tool only
// looks at wrangler.toml, so a future DO binding or migration change to
// production could silently leave a lane config behind — and then the pre-deploy
// gate would boot a different DO class set than production.
//
// It compares only the DO-relevant subset (bindings + migration sequence). The
// intentional differences (name, routes, assets, AE, vars, KV id) are ignored.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeDoMigrations, parseWranglerDoState } from "./sync-wrangler-do-migrations.mjs";

const PROD_CONFIG = "wrangler.toml";
// All local-dev wrangler configs that duplicate the DO surface must stay in sync.
const LOCAL_CONFIGS = ["wrangler.smoke.toml", "wrangler.cf-e2e.toml"];

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
  const prodText = readFileSync(prodPath, "utf8");
  const prodSig = doSignature(prodText);

  let anyFailed = false;

  for (const localConfig of LOCAL_CONFIGS) {
    const localPath = resolve(process.cwd(), localConfig);
    const localText = readFileSync(localPath, "utf8");

    // Each local config's own DO migration history must be internally valid
    // (every bound class created, no duplicate tags, no orphaned actives) — the
    // same invariant cf:migrations:check enforces for production.
    const localAnalysis = analyzeDoMigrations(localText);
    if (!localAnalysis.ok) {
      console.error(`guard:smoke-wrangler: ${localConfig} DO migrations are inconsistent`);
      if (localAnalysis.duplicateTags.length) console.error(`  duplicate tags: ${localAnalysis.duplicateTags.join(", ")}`);
      if (localAnalysis.missingCreates.length) console.error(`  bound classes without a create migration: ${localAnalysis.missingCreates.join(", ")}`);
      if (localAnalysis.activeButUnbound.length) console.error(`  active classes with no binding: ${localAnalysis.activeButUnbound.join(", ")}`);
      anyFailed = true;
      continue;
    }

    const localSig = doSignature(localText);
    if (prodSig !== localSig) {
      console.error(
        `guard:smoke-wrangler: ${localConfig} Durable Object bindings/migrations have drifted from ${PROD_CONFIG}.\n` +
        `Mirror the DO bindings + [[migrations]] blocks from ${PROD_CONFIG} into ${localConfig} (routes/assets/AE/vars/KV id intentionally differ).\n` +
        `--- ${PROD_CONFIG} DO surface ---\n${prodSig}\n--- ${localConfig} DO surface ---\n${localSig}`
      );
      anyFailed = true;
      continue;
    }

    console.log(`guard:smoke-wrangler: ok — ${localConfig} DO surface matches ${PROD_CONFIG} (${localAnalysis.boundClasses.length} classes, ${localAnalysis.migrations.length} migrations)`);
  }

  if (anyFailed) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`guard:smoke-wrangler: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
