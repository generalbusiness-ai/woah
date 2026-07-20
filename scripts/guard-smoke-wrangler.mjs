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
// It compares two subsets:
//   1. the DO surface (bindings + migration sequence), and
//   2. the WOO_* behavior-flag vars — because the smoke lane is the
//      pre-deploy gate (scripts/deploy.sh), a behavior flag enabled in the
//      lane but not in production means the gate validates code paths the
//      deployed worker will not run (review finding, 2026-06-10). Per-lane
//      vars that are NOT behavior flags are allowlisted explicitly below.
// Other intentional differences (name, routes, assets, AE binding, KV id)
// are ignored.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeDoMigrations, parseWranglerDoState } from "./sync-wrangler-do-migrations.mjs";

const PROD_CONFIG = "wrangler.toml";
// All local-dev wrangler configs that duplicate the DO surface must stay in sync.
const LOCAL_CONFIGS = ["wrangler.smoke.toml"];

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

    const flagDrift = compareWooFlags(prodText, localText);
    if (flagDrift.length > 0) {
      console.error(
        `guard:smoke-wrangler: ${localConfig} WOO_* behavior flags have drifted from ${PROD_CONFIG}:\n` +
        flagDrift.map((d) => `  ${d}`).join("\n") +
        `\nEither enable the flag in ${PROD_CONFIG} (a validated feature being shipped) or remove it from the lane config; per-lane vars belong in LANE_ONLY_VARS / PROD_ONLY_VARS with a comment.`
      );
      anyFailed = true;
    } else {
      console.log(`guard:smoke-wrangler: ok — ${localConfig} WOO_* flags match ${PROD_CONFIG}`);
    }
  }

  if (anyFailed) process.exitCode = 1;
}

// WOO_* vars that may legitimately differ between production and the local
// workerd lanes. Everything else must match exactly: the smoke lane is the
// pre-deploy gate, so a behavior flag set only in the lane validates code
// paths production will not run, and a flag set only in production deploys
// paths the gate never exercised.
const LANE_ONLY_VARS = new Set([
  // Local stand-ins for values provisioned as deploy-time secrets in prod.
  "WOO_INITIAL_WIZARD_TOKEN",
  "WOO_INTERNAL_SECRET",
  // Test-only fault injection. parse also asserts it is NEVER set in prod.
  "WOO_FAULT_INJECT"
]);
const PROD_ONLY_VARS = new Set([
  // Analytics Engine dataset name; the lanes strip the AE binding entirely.
  "WOO_AE_DATASET",
  // NC6 public-selection flag: prod serves the net stack. The smoke and
  // cf-e2e lanes deliberately exercise the v2 cross-actor walkthrough, so
  // they must NOT default to net — enabling it in a lane would route that
  // walkthrough to /net-api and break it. Prod-only by design.
  "WOO_NET_DEFAULT"
]);

function wooVars(text) {
  const vars = new Map();
  for (const line of text.split("\n")) {
    const m = /^(WOO_[A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (m) vars.set(m[1], m[2]);
  }
  return vars;
}

function compareWooFlags(prodText, localText) {
  const prod = wooVars(prodText);
  const local = wooVars(localText);
  const drift = [];
  if (prod.has("WOO_FAULT_INJECT")) {
    drift.push(`WOO_FAULT_INJECT must NEVER be set in ${PROD_CONFIG} (test-only fault injection)`);
  }
  for (const [name, value] of prod) {
    if (PROD_ONLY_VARS.has(name)) continue;
    if (!local.has(name)) drift.push(`${name} set in prod but missing from the lane (gate would not exercise it)`);
    else if (local.get(name) !== value) drift.push(`${name} differs: prod=${value} lane=${local.get(name)}`);
  }
  for (const [name] of local) {
    if (LANE_ONLY_VARS.has(name)) continue;
    if (!prod.has(name)) drift.push(`${name} set in the lane but not in prod (gate validates a path prod will not run)`);
  }
  return drift;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`guard:smoke-wrangler: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
