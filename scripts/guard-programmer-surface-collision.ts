import { createWorld } from "../src/core/bootstrap";

// §8.13 of the programmer-environment remediation plan. A programmer surface is
// composed onto an actor as a feature, and the dispatcher's FT2 rule resolves
// the actor's own parent chain BEFORE its features. So if an actor's kind
// ancestry defines a verb whose name collides with a surface verb, that verb
// silently shadows the surface's for a feature-composed programmer while a
// legacy $programmer descendant keeps it — two promotion paths resolving
// different tool sets.
//
// This scans EVERY bundled $actor descendant, not a hardcoded kind list. It
// hard-fails on the provisioning kinds actors are actually minted as (which
// must carry the surface cleanly), and reports collisions on other actor
// classes (e.g. $block) as informational: those cannot be provisioned as
// programmers, and world.assertSurfaceComposable refuses attaching the surface
// to them at runtime — the bounded per-actor analogue of this guard that also
// covers custom/live classes the bundle never sees.

const world = createWorld();

const surfaceRef = world.propOrNull("$system", "programmer_surface");
if (typeof surfaceRef !== "string" || !world.objects.has(surfaceRef)) {
  console.error("guard-programmer-surface-collision: no $system.programmer_surface published; is the prog catalog installed?");
  process.exit(1);
}

// Actor kinds the provisioning surface actually mints or promotes. A collision
// on any of these (or a descendant of one) means broken provisioned programmers
// and is a hard failure.
const PROVISIONING_KINDS = new Set(["$agent", "$human", "$guest", "$wiz"]);

function ancestry(ref: string): string[] {
  const chain: string[] = [];
  let cursor: string | null = ref;
  while (cursor && world.objects.has(cursor)) {
    chain.push(cursor);
    cursor = world.object(cursor).parent;
  }
  return chain;
}

const surfaceChain = ancestry(surfaceRef);
const surfaceChainSet = new Set(surfaceChain);

// Collisions between a candidate actor class and the surface, restricted to the
// classes each chain owns above their nearest common ancestor (shared ancestors
// are inherited identically by both and never diverge). Mirrors
// world.assertSurfaceComposable.
function collisionsFor(candidate: string): string[] {
  const candChain = ancestry(candidate);
  const candSet = new Set(candChain);
  const ncaIndex = surfaceChain.findIndex((c) => candSet.has(c));
  const nca = ncaIndex >= 0 ? surfaceChain[ncaIndex] : null;
  const surfaceSpecific = ncaIndex >= 0 ? surfaceChain.slice(0, ncaIndex) : surfaceChain;
  const candSpecific = nca ? candChain.slice(0, candChain.indexOf(nca)) : candChain;
  const surfaceNames = new Set<string>();
  for (const cls of surfaceSpecific) for (const v of world.object(cls).verbs) surfaceNames.add(v.name);
  const hits = new Set<string>();
  for (const cls of candSpecific) for (const v of world.object(cls).verbs) if (surfaceNames.has(v.name)) hits.add(v.name);
  return [...hits].sort();
}

const candidates = [...world.objects.keys()].filter(
  (id) => world.isDescendantOf(id, "$actor") && !surfaceChainSet.has(id) && world.object(id).verbs.length > 0
);

const hardFailures: string[] = [];
const runtimeGuarded: string[] = [];
for (const cand of candidates) {
  const cols = collisionsFor(cand);
  if (cols.length === 0) continue;
  const isProvisioning = ancestry(cand).some((a) => PROVISIONING_KINDS.has(a));
  const line = `  ${cand}: shadows surface verb(s) ${cols.join(", ")}`;
  if (isProvisioning) hardFailures.push(line);
  else runtimeGuarded.push(line);
}

if (runtimeGuarded.length > 0) {
  console.log(
    `guard-programmer-surface-collision: ${runtimeGuarded.length} non-provisioning actor class(es) collide and cannot carry the surface (runtime attach refuses):`
  );
  for (const l of runtimeGuarded) console.log(l);
}

if (hardFailures.length > 0) {
  console.error(
    "Provisioning-kind verb name collision with the programmer surface.\n" +
      "Parent-chain-wins would shadow the surface verb for a feature-composed programmer\n" +
      "while a legacy descendant keeps it — provisioned programmers would break.\n" +
      "Rename one side so the surface and these kinds stay disjoint:"
  );
  for (const l of hardFailures) console.error(l);
  process.exit(1);
}

// The surface-specific classes are those above $player (the base every
// provisioning kind shares); shown for context only.
const playerIndex = surfaceChain.indexOf("$player");
const surfaceSpecific = playerIndex >= 0 ? surfaceChain.slice(0, playerIndex) : surfaceChain;
console.log(
  `guard-programmer-surface-collision: surface [${surfaceSpecific.join(", ")}] clean against all provisioning kinds`
);
