/**
 * Session-id shard hint (ready-to-scale Phase 6,
 * notes/2026-07-08-net-ready-to-scale-plan.md).
 *
 * A session id minted today must remain ROUTABLE after the /net-api
 * surface gains shards: session ids carry no lineage (CO14), so without
 * a mint-time hint there is no way to resolve which gateway shard holds
 * a live session's view — re-sharding would be a data migration instead
 * of a routing change. The hint therefore ships in the FIRST deploy,
 * even while one stable shard serves everything.
 *
 * Format: `s_<shard>_<random>` — exactly three `_`-separated tokens.
 *
 * Delimiter safety (the review's #4): cell keys are `:`-delimited and
 * `objectOfCellKey` assumes object ids never contain `:`; the id's own
 * parse splits on `_`. The shard token is therefore sanitized to
 * `[A-Za-z0-9-]` at mint — `:` can never enter a session id, and a `_`
 * in a shard name cannot break the three-token parse. Hint-less ids
 * (`s_<random>`, the pre-hint format) parse to null and route to the
 * default shard.
 */

/** Mint a session id carrying the shard hint. `random` is the caller's
 * entropy (the module stays randomness-free for workflow replay); a null
 * shard (an environment that cannot name itself) mints the hint-less
 * legacy form. */
export function sessionIdWithShardHint(shard: string | null, random: string): string {
  if (shard === null || shard.length === 0) return `s_${random}`;
  const hint = shard.replace(/[^A-Za-z0-9-]/g, "-");
  return `s_${hint}_${random}`;
}

/** The shard a session id was minted at, or null for the hint-less
 * legacy form (routes to the default shard). Strict three-token parse —
 * the sanitizer guarantees the hint itself never contains `_`. */
export function sessionShardHint(session: string): string | null {
  const parts = session.split("_");
  if (parts.length !== 3 || parts[0] !== "s" || parts[1].length === 0) return null;
  return parts[1];
}
