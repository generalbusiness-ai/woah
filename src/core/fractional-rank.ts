/**
 * Fractional rank keys — lexicographic order maintenance with bounded
 * mutation cost (substrate, catalog-agnostic).
 *
 * WHY. An ordered index (the outliner's ordered-edge index is the first
 * consumer, but nothing here knows that) must let a caller insert an item
 * between two neighbours, or at either end, writing ONE key — never
 * renumbering the whole list. Integer positions force an O(N) renumber on
 * every insert; fractional keys do not. Each key is a base-62 string; the
 * total order is plain string comparison, so a store can sort with a
 * `.localeCompare`/`<` and never decode the key.
 *
 * SCHEME. Keys are digit strings over a 62-symbol alphabet chosen so that
 * ASCII byte order == digit order: `0-9` (0x30–0x39) < `A-Z` (0x41–0x5A) <
 * `a-z` (0x61–0x7A). A key denotes the base-62 fraction `0.<digits>`; the
 * radix point is implicit and never stored. String comparison then matches
 * fraction comparison AS LONG AS no key ends in the zero digit `'0'`
 * (`"V"` and `"V0"` are the same fraction but different strings). The
 * midpoint algorithm below preserves the no-trailing-zero invariant, so
 * every key this module returns is safe to compare with `<`.
 *
 * BOUNDEDNESS. `rankBetween` returns a key strictly between its neighbours
 * and adds at most one digit per shrinking of the gap. Repeatedly inserting
 * into the same shrinking gap (the adversarial case) grows the key by ~1
 * digit per log2(62) ≈ 5.95 insertions, i.e. O(log_62 n) — never one digit
 * per insertion. Append/prepend stay single-digit until the alphabet is
 * exhausted at that position, then grow by one. See the exhaustive unit
 * tests in tests/fractional-rank.test.ts.
 *
 * The `midpoint` implementation follows the well-known fractional-indexing
 * algorithm (David Greenspan / Figma, "Implementing Fractional Indexing"),
 * specialised to a single alphabet and no integer part.
 */

/** 62 symbols in strict ASCII-ascending order: digit value == index. */
export const RANK_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = RANK_DIGITS.length; // 62
const ZERO = RANK_DIGITS[0]; // '0'

/** Digit value of a single character, or -1 if it is not a rank digit. */
function digitOf(ch: string): number {
  return RANK_DIGITS.indexOf(ch);
}

/** True iff `s` is a valid, comparison-safe rank key: non-empty, every
 * character is a rank digit, and it does not end in the zero digit. An
 * empty string is NOT a valid stored key — it is only accepted as a
 * neighbour sentinel meaning "unbounded below" inside `midpoint`. */
export function isValidRank(s: string): boolean {
  if (s.length === 0) return false;
  for (const ch of s) if (digitOf(ch) < 0) return false;
  return s[s.length - 1] !== ZERO;
}

/**
 * A key strictly between the base-62 fractions `0.a` and `0.b`, where
 * `a` is the lower bound (empty string == the fraction 0, i.e. unbounded
 * below) and `b` is the upper bound (`null` == unbounded above, the
 * fraction 1). Requires `a < b` and neither ending in the zero digit;
 * both are guaranteed by the public wrappers and by the recursion.
 */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) {
    throw new Error(`fractional-rank: midpoint lower bound ${JSON.stringify(a)} >= upper bound ${JSON.stringify(b)}`);
  }
  // ITERATIVE (P2.5): a recursive descent overflows the JS stack on a long
  // bound (one frame per digit — "Maximum call stack size exceeded" past
  // ~40000 chars). Walk index pointers over `a`/`b` instead, accumulating the
  // shared/kept prefix, so depth is O(1) regardless of key length. `ai`/`bi`
  // are cursors; a null `b` means the upper bound is the fraction 1. `a`'s
  // digits past its end read as the zero digit (the fraction 0.a…000).
  let prefix = "";
  let ai = 0;
  let bi = 0;
  for (;;) {
    // Copy the shared leading run (treating a missing digit of `a` as zero).
    // This keeps the produced key close to its neighbours rather than jumping
    // to the absolute middle of a narrow interval.
    if (b !== null) {
      while (bi < b.length && (a[ai] ?? ZERO) === b[bi]) {
        prefix += b[bi];
        ai += 1;
        bi += 1;
      }
    }
    const digitA = ai < a.length ? digitOf(a[ai]) : 0;
    const digitB = b !== null && bi < b.length ? digitOf(b[bi]) : BASE;
    if (digitB - digitA > 1) {
      // Room for a whole digit strictly between them: pick the middle one.
      return prefix + RANK_DIGITS[Math.round((digitA + digitB) / 2)];
    }
    // Leading digits are consecutive: no single digit fits between them.
    if (b !== null && bi + 1 < b.length) {
      // `b`'s first remaining digit alone is > `a`'s remaining prefix and < `b`
      // (it has a nonempty tail), and cannot end in zero here.
      return prefix + b[bi];
    }
    // `b` is unbounded (or a single digit adjacent to `a`'s digit): keep `a`'s
    // digit and descend into its tail against an unbounded upper bound
    // (e.g. midpoint("49","5") -> "4" + midpoint("9", null) -> "495").
    prefix += RANK_DIGITS[digitA];
    ai += 1;
    b = null;
    bi = 0;
  }
}

/**
 * A rank key that sorts strictly between `a` and `b` (both plain string
 * comparison). `a === null` means "before `b`" (prepend); `b === null`
 * means "after `a`" (append); both `null` yields the first key of an empty
 * order. Throws if `a >= b`.
 */
export function rankBetween(a: string | null, b: string | null): string {
  if (a !== null && !isValidRank(a)) throw new Error(`fractional-rank: invalid lower bound ${JSON.stringify(a)}`);
  if (b !== null && !isValidRank(b)) throw new Error(`fractional-rank: invalid upper bound ${JSON.stringify(b)}`);
  if (a !== null && b !== null && a >= b) {
    throw new Error(`fractional-rank: lower bound ${JSON.stringify(a)} >= upper bound ${JSON.stringify(b)}`);
  }
  // P2.5: the open-ended cases are the outliner's hot append/prepend path
  // (`rank_between(last, null)` / `rank_between(null, first)`). Route them
  // through the O(1)-length `rankAfter`/`rankBefore` INCREMENT primitives —
  // NOT the bisecting midpoint, which lengthens the key on every append and
  // eventually feeds an unbounded key back in. Only the genuinely two-sided
  // case needs the midpoint.
  if (b === null) return a === null ? midpoint("", null) : rankAfter(a);
  if (a === null) return rankBefore(b);
  // `midpoint` treats an empty lower bound as the fraction 0.
  return midpoint(a, b);
}

/** The first key for an empty order (room to insert on either side). */
export function firstRank(): string {
  return rankBetween(null, null);
}

/**
 * A key that sorts after `a` (append to the end of the order).
 *
 * Unlike `midpoint(a, null)`, which bisects toward the fraction 1 and so
 * lengthens the key on every append, this INCREMENTS the last digit when
 * there is headroom below the max digit — keeping repeated appends at the
 * same length until a whole digit position is exhausted, then growing by
 * one. Append is the outliner's hot path (items are usually added at the
 * end), so it must stay short.
 */
export function rankAfter(a: string): string {
  if (!isValidRank(a)) throw new Error(`fractional-rank: invalid key ${JSON.stringify(a)}`);
  const d = digitOf(a[a.length - 1]);
  // Bump the last digit: same length, strictly greater, never trailing
  // zero (the incremented digit is >= 1). Room to insert between `a` and
  // the result remains available via `rankBetween` (midpoint descends).
  if (d + 1 < BASE) return a.slice(0, -1) + RANK_DIGITS[d + 1];
  // Last digit is the max digit: append a fresh interior digit instead.
  return a + RANK_DIGITS[Math.floor(BASE / 2)];
}

/**
 * A key that sorts before `b` (prepend to the front of the order). The
 * mirror of `rankAfter`: decrement the last digit while it stays >= 1
 * (digit 0 would be an aliasing trailing zero), else drop to a `0`-prefixed
 * interior key that still sorts below `b`.
 */
export function rankBefore(b: string): string {
  if (!isValidRank(b)) throw new Error(`fractional-rank: invalid key ${JSON.stringify(b)}`);
  const d = digitOf(b[b.length - 1]);
  if (d - 1 >= 1) return b.slice(0, -1) + RANK_DIGITS[d - 1];
  // Last digit is '1': replace it with '0' + an interior digit. `0X` sorts
  // below anything ending in `1` at that position and never trails a zero.
  return b.slice(0, -1) + ZERO + RANK_DIGITS[Math.floor(BASE / 2)];
}
