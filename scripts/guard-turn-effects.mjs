#!/usr/bin/env node
// Guard: the world engine stays behind the TurnEffects seam.
//
// Plan 002 Phase 1 (spec/protocol/coherence.md) re-routed every
// distribution-layer operation in src/core/world.ts through the injected
// TurnEffects interface (src/core/turn-effects.ts). This guard keeps it
// that way: world.ts must not import the distribution modules directly —
// neither values nor types — so an alternative distribution layer
// (src/net/) can be injected without engine changes.
//
// If you need a new distribution operation from world.ts, add it to the
// TurnEffects interface and the v2 implementation in turn-effects.ts.
import { readFileSync } from "node:fs";

const WORLD = "src/core/world.ts";
const FORBIDDEN = [
  "./authority-slice",
  "./shadow-cell-version",
  "./turn-key",
  "./planning-world",
  "./turn-recorder",
  "./remote-bridge-transcript-policy",
  "./effect-transcript",
  "./shadow-commit-scope",
  "./projection-delta",
  // Catch any future shadow-* module by prefix as well.
  "./shadow-"
];

const src = readFileSync(WORLD, "utf8");
const violations = [];
const importRe = /^import[^;]*?from\s+"([^"]+)";?\s*$/gms;
for (const match of src.matchAll(importRe)) {
  const specifier = match[1];
  if (FORBIDDEN.some((f) => specifier === f || (f.endsWith("-") && specifier.startsWith(f)))) {
    violations.push(specifier);
  }
}

if (violations.length > 0) {
  console.error(`guard:turn-effects: ${WORLD} imports distribution modules directly:`);
  for (const v of violations) console.error(`  - ${v}`);
  console.error("Route the operation through src/core/turn-effects.ts (TurnEffects) instead.");
  process.exit(1);
}
console.log("guard:turn-effects: ok — world.ts stays behind the TurnEffects seam");
