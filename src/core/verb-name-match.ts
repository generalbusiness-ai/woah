/**
 * Verb-name matching: the ONE rule that decides whether a caller's word names
 * a verb.
 *
 * A verb's `aliases` are LambdaMOO-style patterns, not literals:
 *
 *   `l@ook`     — `@` marks the abbreviation point; `l`, `lo`, `loo`, `look`
 *                 all match, and so does the full literal `look`.
 *   `@exam*ine` — `*` behaves the same way when it is not final.
 *   `get*`      — a trailing `*` is a prefix wildcard: any name starting
 *                 with `get` matches.
 *   `a|b`       — `|` separates alternative patterns within one alias.
 *
 * This lived as two private functions inside world.ts, which meant every
 * transport that resolved a verb WITHOUT going through the dispatcher had to
 * either import nothing and re-implement, or exact-compare. The Net MCP
 * gateway exact-compared, so `woo_call(obj, "l")` answered E_VERBNF for a verb
 * the world dispatcher would have run. One vocabulary, one implementation:
 * anything that answers "is this the verb?" imports from here.
 *
 * Pure, dependency-free, and deliberately in `src/core` rather than a
 * transport: it is object-model semantics, not protocol.
 */

/** Does one alias PATTERN match a caller-supplied verb name? */
export function verbAliasMatches(pattern: string, name: string): boolean {
  for (const segment of pattern.split("|")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    if (trimmed === name) return true;
    const star = trimmed.indexOf("*");
    if (star === trimmed.length - 1) {
      const literal = trimmed.slice(0, -1);
      if (literal && name.startsWith(literal)) return true;
      continue;
    }
    const abbreviation = star >= 0 ? star : trimmed.indexOf("@");
    if (abbreviation >= 0) {
      const literal = trimmed.slice(0, abbreviation) + trimmed.slice(abbreviation + 1);
      if (literal && literal.startsWith(name) && name.length >= Math.max(1, abbreviation)) return true;
      continue;
    }
  }
  return false;
}

/**
 * Does a verb page answer to `name`? Its own name matches exactly; its
 * aliases match as patterns.
 *
 * Takes the two fields rather than a `VerbDef` so a sparse caller — the Net
 * gateway reads verb pages as plain cell records, never as VerbDefs — can use
 * the identical rule without materializing an object-model type.
 */
export function verbPageAnswersTo(verbName: string, aliases: readonly string[], name: string): boolean {
  return verbName === name || aliases.some((alias) => verbAliasMatches(alias, name));
}
