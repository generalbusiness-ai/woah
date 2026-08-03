/** Bootstrap definition pages this bundle has retired.
 *
 * Seeding is declarative — `createWorld()` writes the pages the current bundle
 * declares — so a page that simply stops being seeded still exists on every
 * world an older bundle created. Re-seeding cannot delete it, and while it
 * survives it *shadows* its replacement for its own subtree: a page on a
 * nearer ancestor always wins, so an aged world would keep two definers of the
 * same verb and the surface fragmentation the replacement removes.
 *
 * Two consumers walk aged worlds forward from this one list, so the local and
 * deployed paths cannot drift apart:
 *   - local / SQLite: the cold-init boot migration in `local-catalogs.ts`.
 *   - Net: the `--drop` allow-list in `scripts/net-repair-definitions.ts`.
 *     That script exists to repair *bootstrap* pages, yet its drop side could
 *     previously only name pages retired by a bundled **catalog** migration —
 *     an asymmetry that left bootstrap retirements with no deployed path.
 *
 * This lives in its own leaf module because `bootstrap.ts` imports
 * `local-catalogs.ts`; declaring it in either would make the other's import
 * cyclic.
 */
export type RetiredDefinition = { kind: "verb"; object: string; name: string };

export const RETIRED_BOOTSTRAP_DEFINITIONS: readonly RetiredDefinition[] = [
  // Superseded by the graph-root `look` — a single dispatcher seated where
  // every branch inherits it. Objects customize `look_self`; nothing
  // overrides `look`. See ROOT_LOOK_SOURCE in bootstrap.ts.
  { kind: "verb", object: "$thing", name: "look" }
];

/** `<kind>:<object>:<name>` spelling, matching how `repair:net-definitions`
 * names pages on the command line. */
export function retiredDefinitionId(entry: RetiredDefinition): string {
  return `${entry.kind}:${entry.object}:${entry.name}`;
}
