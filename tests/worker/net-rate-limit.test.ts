// H4: the token-bucket limiter backing the /net-api rate limits
// (wire.md 50 ops/s sustained, burst 100). Pure unit lane with an
// injected clock — the gateway-level 429 surfaces are proven in
// tests/worker/net-client-api.test.ts and net-ws.test.ts.
import { describe, expect, it } from "vitest";
import { TokenBucketLimiter } from "../../src/worker/net/rate-limit";

describe("TokenBucketLimiter (H4)", () => {
  it("allows the burst, refuses past it, and refills at the sustained rate", () => {
    const limiter = new TokenBucketLimiter({ ratePerSec: 50, burst: 100 });
    let now = 1_000_000;
    for (let i = 0; i < 100; i += 1) {
      expect(limiter.take("a", now), `burst op ${i}`).toBe(true);
    }
    // Bucket empty at the same instant: refused, and the refusal does not
    // dig the bucket deeper (429-then-recover).
    expect(limiter.take("a", now)).toBe(false);
    expect(limiter.take("a", now)).toBe(false);
    // 100ms at 50/s refills 5 tokens.
    now += 100;
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.take("a", now), `refilled op ${i}`).toBe(true);
    }
    expect(limiter.take("a", now)).toBe(false);
    // Sustained pacing at exactly the rate keeps flowing.
    for (let i = 0; i < 20; i += 1) {
      now += 20; // 20ms * 50/s = 1 token
      expect(limiter.take("a", now), `paced op ${i}`).toBe(true);
    }
  });

  it("keeps per-key budgets independent and caps refill at the burst", () => {
    const limiter = new TokenBucketLimiter({ ratePerSec: 5, burst: 2 });
    const now = 5_000;
    expect(limiter.take("a", now)).toBe(true);
    expect(limiter.take("a", now)).toBe(true);
    expect(limiter.take("a", now)).toBe(false);
    // Key b is untouched by a's exhaustion.
    expect(limiter.take("b", now)).toBe(true);
    // A long idle period refills to the burst cap, never beyond.
    expect(limiter.take("a", now + 60_000)).toBe(true);
    expect(limiter.take("a", now + 60_000)).toBe(true);
    expect(limiter.take("a", now + 60_000)).toBe(false);
  });

  it("bounds the tracked-key map: idle eviction and the hard cap", () => {
    const limiter = new TokenBucketLimiter({ ratePerSec: 1, burst: 1, idleMs: 1_000, maxKeys: 4 });
    let now = 0;
    for (let i = 0; i < 4; i += 1) limiter.take(`k${i}`, now);
    expect(limiter.size()).toBe(4);
    // The hard cap evicts the least-recently-touched key.
    limiter.take("k4", now);
    expect(limiter.size()).toBeLessThanOrEqual(4);
    // Idle entries evict lazily on the next take.
    now += 5_000;
    limiter.take("fresh", now);
    expect(limiter.size()).toBe(1);
  });
});
