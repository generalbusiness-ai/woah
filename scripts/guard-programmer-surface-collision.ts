import { createWorld } from "../src/core/bootstrap";

// §8.13 of the programmer-environment remediation plan. A programmer surface is
// composed onto an actor as a feature, and the dispatcher's FT2 rule resolves
// the actor's own parent chain BEFORE its features. So if any actor-kind
// ancestry class ($root/$actor/$player/$agent/$guest/$human/$wiz) defines a
// command/verb whose name collides with a surface verb ($builder/$programmer),
// that verb silently shadows the surface's for a feature-composed programmer,
// while a legacy $programmer *descendant* keeps it — two promotion paths that
// resolve different tool sets. The name sets are disjoint today; this guard
// fails the build the moment a future edit introduces an overlap, so the
// divergence can never ship silently.

const world = createWorld();

// The surface chain is discovered from catalog data, not hardcoded: start at
// the published surface and walk its parent chain until it reaches the actor
// kinds (it inherits $builder, then $player).
const kindClasses = ["$root", "$actor", "$player", "$agent", "$guest", "$human", "$wiz"];
const kindSet = new Set(kindClasses);

const surfaceRef = world.propOrNull("$system", "programmer_surface");
if (typeof surfaceRef !== "string" || !world.objects.has(surfaceRef)) {
  console.error("guard-programmer-surface-collision: no $system.programmer_surface published; is the prog catalog installed?");
  process.exit(1);
}

const surfaceClasses: string[] = [];
let cursor: string | null = surfaceRef;
while (cursor && !kindSet.has(cursor)) {
  surfaceClasses.push(cursor);
  cursor = world.object(cursor).parent;
}

function ownVerbNames(cls: string): Set<string> {
  const names = new Set<string>();
  if (!world.objects.has(cls)) return names;
  for (const verb of world.object(cls).verbs) names.add(verb.name);
  return names;
}

const surfaceNames = new Map<string, string>(); // verb name -> defining surface class
for (const cls of surfaceClasses) {
  for (const name of ownVerbNames(cls)) if (!surfaceNames.has(name)) surfaceNames.set(name, cls);
}

const collisions: string[] = [];
for (const cls of kindClasses) {
  for (const name of ownVerbNames(cls)) {
    if (surfaceNames.has(name)) {
      collisions.push(`  ${name}: defined on kind ${cls} AND surface ${surfaceNames.get(name)}`);
    }
  }
}

if (collisions.length > 0) {
  console.error(
    "Verb name collision between actor-kind ancestry and the programmer surface.\n" +
      "Parent-chain-wins means the kind verb shadows the surface verb for a feature-composed\n" +
      "programmer while a legacy descendant keeps it — the two promotion paths would diverge.\n" +
      "Rename one side so the surface and kind verb sets stay disjoint:"
  );
  for (const c of collisions) console.error(c);
  process.exit(1);
}

console.log(
  `guard-programmer-surface-collision: surface [${surfaceClasses.join(", ")}] and actor kinds share no verb names`
);
