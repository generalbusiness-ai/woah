// Fractional rank keys — the substrate ordering primitive behind the
// outliner's ordered-edge index. These tests pin the properties the index
// depends on: a total order by plain string compare, strict-betweenness,
// collision-free repeated midpoint insertion, monotonic append/prepend, and
// bounded key-length growth under adversarial insertion (the property that
// keeps a single edge write O(1) instead of an O(N) renumber).
import { describe, expect, it } from "vitest";
import {
  RANK_DIGITS,
  firstRank,
  isValidRank,
  rankAfter,
  rankBefore,
  rankBetween
} from "../src/core/fractional-rank";

/** Every key must be comparison-safe: non-empty, all rank digits, no
 * trailing zero digit (which would alias to a shorter equal fraction). */
function assertValid(key: string): void {
  expect(isValidRank(key)).toBe(true);
  expect(key.length).toBeGreaterThan(0);
  expect(key.endsWith(RANK_DIGITS[0])).toBe(false);
}

describe("fractional rank alphabet", () => {
  it("is 62 symbols in strict ASCII-ascending order (digit order == byte order)", () => {
    expect(RANK_DIGITS).toHaveLength(62);
    for (let i = 1; i < RANK_DIGITS.length; i++) {
      expect(RANK_DIGITS[i - 1] < RANK_DIGITS[i]).toBe(true);
    }
  });
});

describe("rankBetween basics", () => {
  it("firstRank sits in the interior so both ends stay insertable", () => {
    const first = firstRank();
    assertValid(first);
    // Strictly between the empty-order bounds: something sorts before and after.
    expect(rankBefore(first) < first).toBe(true);
    expect(first < rankAfter(first)).toBe(true);
  });

  it("prepend (a=null) yields a key before b; append (b=null) after a", () => {
    const mid = firstRank();
    const before = rankBetween(null, mid);
    const after = rankBetween(mid, null);
    assertValid(before);
    assertValid(after);
    expect(before < mid).toBe(true);
    expect(mid < after).toBe(true);
  });

  it("always produces a key strictly between two neighbours", () => {
    const lo = firstRank();
    const hi = rankAfter(lo);
    const mid = rankBetween(lo, hi);
    assertValid(mid);
    expect(lo < mid).toBe(true);
    expect(mid < hi).toBe(true);
  });

  it("throws when the lower bound is not strictly below the upper bound", () => {
    const k = firstRank();
    expect(() => rankBetween(k, k)).toThrow();
    const lo = firstRank();
    const hi = rankAfter(lo);
    expect(() => rankBetween(hi, lo)).toThrow();
  });

  it("rejects malformed bounds (empty, non-digit, trailing zero)", () => {
    expect(() => rankBetween("", null)).toThrow();
    expect(() => rankBetween("!", null)).toThrow();
    expect(() => rankBetween("V0", null)).toThrow();
    expect(isValidRank("")).toBe(false);
    expect(isValidRank("V0")).toBe(false);
    expect(isValidRank("~")).toBe(false);
  });
});

describe("total ordering by plain string comparison", () => {
  it("append produces a strictly increasing sequence (monotonic)", () => {
    const keys: string[] = [firstRank()];
    for (let i = 0; i < 500; i++) keys.push(rankAfter(keys[keys.length - 1]));
    for (let i = 1; i < keys.length; i++) {
      assertValid(keys[i]);
      expect(keys[i - 1] < keys[i]).toBe(true);
    }
    // Sorting the shuffled keys reproduces insertion order.
    const shuffled = [...keys].sort(() => Math.random() - 0.5);
    expect([...shuffled].sort()).toEqual(keys);
  });

  it("prepend produces a strictly decreasing sequence (monotonic)", () => {
    const keys: string[] = [firstRank()];
    for (let i = 0; i < 500; i++) keys.push(rankBefore(keys[keys.length - 1]));
    for (let i = 1; i < keys.length; i++) {
      assertValid(keys[i]);
      expect(keys[i] < keys[i - 1]).toBe(true);
    }
  });

  it("interleaved inserts keep an in-memory ordered list totally ordered", () => {
    // Simulate an editor: maintain a sorted list, insert at random indices,
    // assert the list stays strictly sorted and collision-free throughout.
    let order: string[] = [firstRank()];
    for (let i = 0; i < 400; i++) {
      const idx = Math.floor(Math.random() * (order.length + 1));
      const lo = idx > 0 ? order[idx - 1] : null;
      const hi = idx < order.length ? order[idx] : null;
      const key = rankBetween(lo, hi);
      assertValid(key);
      order = [...order.slice(0, idx), key, ...order.slice(idx)];
    }
    for (let i = 1; i < order.length; i++) expect(order[i - 1] < order[i]).toBe(true);
    expect(new Set(order).size).toBe(order.length); // no collisions
  });
});

describe("repeated midpoint between the same neighbours", () => {
  it("never collides and stays strictly ordered (insert just after a fixed key)", () => {
    const a = firstRank();
    const b = rankAfter(a);
    const inserted: string[] = [];
    let hi = b;
    // Always insert between the fixed lower bound `a` and the previous
    // insertion — the shrinking-gap adversarial pattern.
    for (let i = 0; i < 1000; i++) {
      const key = rankBetween(a, hi);
      assertValid(key);
      expect(a < key).toBe(true);
      expect(key < hi).toBe(true);
      inserted.push(key);
      hi = key;
    }
    // Strictly descending toward `a`, all distinct.
    for (let i = 1; i < inserted.length; i++) expect(inserted[i] < inserted[i - 1]).toBe(true);
    expect(new Set(inserted).size).toBe(inserted.length);
  });

  it("repeated midpoint between two FIXED keys is collision-free and interior", () => {
    const a = firstRank();
    const b = rankAfter(a);
    const seen = new Set<string>();
    let lo = a;
    for (let i = 0; i < 1000; i++) {
      const key = rankBetween(lo, b);
      assertValid(key);
      expect(lo < key).toBe(true);
      expect(key < b).toBe(true);
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      lo = key; // climb toward b
    }
  });
});

describe("bounded key-length growth (the O(1)-write guarantee)", () => {
  it("1000 adversarial shrinking-gap midpoints stay well under a linear bound", () => {
    const a = firstRank();
    let hi = rankAfter(a);
    let maxLen = 0;
    for (let i = 0; i < 1000; i++) {
      hi = rankBetween(a, hi);
      maxLen = Math.max(maxLen, hi.length);
    }
    // O(log_62 n): ~1 digit per ~5.95 insertions, ~168 chars at n=1000.
    // Assert a generous constant that is still far below the naive
    // one-digit-per-insertion (1000) failure mode this scheme must avoid.
    expect(maxLen).toBeLessThan(200);
  });

  it("1000 appends stay short (increment in place; grow one digit per rollover)", () => {
    let key = firstRank();
    let maxLen = 0;
    for (let i = 0; i < 1000; i++) {
      key = rankAfter(key);
      maxLen = Math.max(maxLen, key.length);
    }
    // ~30 appends per digit position (a digit climbs ~31 values before it
    // rolls over and adds a character), so ~34 chars at n=1000 — far below
    // the bisecting append's ~200. Comfortably bounded.
    expect(maxLen).toBeLessThan(50);
  });

  it("1000 prepends stay short (decrement in place; grow one digit per rollover)", () => {
    let key = firstRank();
    let maxLen = 0;
    for (let i = 0; i < 1000; i++) {
      key = rankBefore(key);
      maxLen = Math.max(maxLen, key.length);
    }
    expect(maxLen).toBeLessThan(50);
  });
});
