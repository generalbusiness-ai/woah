/**
 * Token-bucket rate limiting for the /net-api client surface (pre-deploy
 * fix H4; spec/protocol/wire.md's inbound rule: 50 ops/s sustained,
 * burst 100, excess refused with the named `E_RATE`).
 *
 * SCOPE, stated honestly: buckets live in PER-ISOLATE MEMORY on the
 * gateway DO — one map per DO lifetime, keyed by the AUTHENTICATED actor
 * (the apikey's bound identity, so rotating key ids cannot mint fresh
 * budget). Hibernation or eviction resets every bucket, which degrades to
 * permitting one fresh burst — never to blocking a legitimate client —
 * and matches the layer's no-new-durable-copies posture (CO5 stays at
 * five). Since `/net-api` is sharded, this is a per-shard safety valve,
 * not a global quota; durable provisioning limits belong at the owning
 * authority when tenant policy lands.
 *
 * The map is bounded: entries idle past `idleMs` are evicted lazily on
 * take(), and a hard `maxKeys` cap evicts oldest-touched entries beyond
 * it — a credential-guessing flood cannot grow the map without bound
 * (and rate limiting runs AFTER authentication, so unauthenticated junk
 * never reaches the map at all).
 */

export type TokenBucketOptions = {
  /** Sustained refill rate, tokens per second. */
  ratePerSec: number;
  /** Bucket capacity — the burst allowance. */
  burst: number;
  /** Evict entries untouched for this long (default 60 s). */
  idleMs?: number;
  /** Hard cap on tracked keys (default 4096). */
  maxKeys?: number;
};

type Bucket = { tokens: number; touchedAt: number };

export class TokenBucketLimiter {
  private readonly ratePerSec: number;
  private readonly burst: number;
  private readonly idleMs: number;
  private readonly maxKeys: number;
  /** Insertion-ordered by last touch: take() re-inserts, so the map's
   * first entry is always the least-recently-used one. */
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: TokenBucketOptions) {
    this.ratePerSec = options.ratePerSec;
    this.burst = options.burst;
    this.idleMs = options.idleMs ?? 60_000;
    this.maxKeys = options.maxKeys ?? 4096;
  }

  /** Take one token for `key` at time `now` (ms). Returns true when the
   * operation is within budget; false means refuse with E_RATE. A refused
   * take does NOT consume a token (the bucket stays at its floor and
   * refills on the clock, so the limit is 429-then-recover, never a
   * deepening hole). */
  take(key: string, now: number): boolean {
    this.evict(now);
    const existing = this.buckets.get(key);
    let tokens: number;
    if (existing) {
      const elapsed = Math.max(0, now - existing.touchedAt);
      tokens = Math.min(this.burst, existing.tokens + (elapsed / 1000) * this.ratePerSec);
      this.buckets.delete(key); // re-insert to refresh LRU order
    } else {
      tokens = this.burst;
    }
    const allowed = tokens >= 1;
    this.buckets.set(key, { tokens: allowed ? tokens - 1 : tokens, touchedAt: now });
    return allowed;
  }

  /** Lazy boundedness: drop idle entries from the LRU front, then hard-cap.
   * An evicted entry re-enters full (a fresh burst) — the documented
   * per-isolate degradation, applied consistently. */
  private evict(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.touchedAt < this.idleMs) break; // LRU order: the rest are fresher
      this.buckets.delete(key);
    }
    while (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }

  /** Tracked-key count (test/introspection surface). */
  size(): number {
    return this.buckets.size;
  }
}
