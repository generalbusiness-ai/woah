import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { constantTimeEqual, hashSource, randomHex, utf8ByteLength } from "../src/core/source-hash";

// FIPS 180-4 SHA-256 conformance vectors. These are the canonical test
// vectors from the SHA-256 specification — every conforming implementation
// must reproduce them. If any of these fails the implementation is broken at
// the algorithm level, not at a wrapper.
const NIST_VECTORS: ReadonlyArray<{ name: string; input: string; expected: string }> = [
  {
    name: "empty string",
    input: "",
    expected: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  },
  {
    name: "FIPS 180-4 short message: 'abc'",
    input: "abc",
    expected: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  },
  {
    name: "FIPS 180-4 long message",
    input: "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    expected: "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
  },
  {
    name: "FIPS 180-4 multi-block: 1,000,000 'a' characters",
    input: "a".repeat(1_000_000),
    expected: "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
  }
];

describe("source-hash SHA-256 implementation", () => {
  describe("FIPS 180-4 conformance vectors", () => {
    for (const vector of NIST_VECTORS) {
      it(vector.name, () => {
        expect(hashSource(vector.input)).toBe(vector.expected);
      });
    }
  });

  describe("equivalence with node:crypto sha256", () => {
    // Cross-checks the pure-JS implementation against Node's native SHA-256
    // over UTF-8 input. If these drift, every signed proof and content-
    // addressed lookup that relies on `hashSource` is broken across runtimes.
    const corpus = [
      "",
      "abc",
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      "Hello, World!\n",
      "the quick brown fox jumps over the lazy dog",
      "{}",
      JSON.stringify({ scope: "the_chatroom", actor: "guest_alice", seq: 42 }),
      "é́", // 'e' + combining acute (NFD form), tests multi-byte handling
      "字符串", // Chinese, three 3-byte UTF-8 codepoints
      "🦊🌒", // supplementary-plane codepoints
      "\ud800", // lone high surrogate must hash like TextEncoder/Node: U+FFFD
      "\udc00", // lone low surrogate must hash like TextEncoder/Node: U+FFFD
      "a\ud800b",
      "a".repeat(63),
      "a".repeat(64),
      "a".repeat(65),
      "a".repeat(127),
      "a".repeat(128),
      "a".repeat(129),
      "x".repeat(1024)
    ];
    for (const input of corpus) {
      const label = input.length <= 24 ? JSON.stringify(input) : `${JSON.stringify(input.slice(0, 16))}... (len=${input.length})`;
      it(`matches node:crypto for ${label}`, () => {
        const expected = createHash("sha256").update(input, "utf8").digest("hex");
        expect(hashSource(input)).toBe(expected);
      });
    }

    it("matches node:crypto for 64 random inputs of varied length", () => {
      // Property-style sweep: random lengths around the padding boundary
      // (55-65 bytes) where SHA-256 splits between one and two blocks.
      for (let i = 0; i < 64; i += 1) {
        const length = (i * 7) % 130; // 0..129
        const seed = nodeRandomBytes(length).toString("hex"); // ASCII payload
        const expected = createHash("sha256").update(seed, "utf8").digest("hex");
        expect(hashSource(seed), `random input length=${length}`).toBe(expected);
      }
    });
  });

  describe("block-boundary regressions", () => {
    // The SHA-256 padding rule kicks in differently at lengths 55, 56,
    // 63, 64, 119, 120 (relative to the 512-bit block size). Explicit
    // coverage prevents an off-by-one in the padding step from passing
    // the random sweep.
    for (const length of [55, 56, 57, 63, 64, 65, 119, 120, 121]) {
      it(`length ${length} byte input`, () => {
        const input = "a".repeat(length);
        const expected = createHash("sha256").update(input, "utf8").digest("hex");
        expect(hashSource(input)).toBe(expected);
      });
    }
  });

  it("is deterministic across repeated calls", () => {
    const input = "deterministic-input";
    const first = hashSource(input);
    const second = hashSource(input);
    const third = hashSource(input);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it("returns a 64-character lowercase hex string", () => {
    const digest = hashSource("anything");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("randomHex", () => {
  it("returns a hex string of length 2 * byteLength", () => {
    for (const n of [0, 1, 8, 16, 32, 64]) {
      const hex = randomHex(n);
      expect(hex).toHaveLength(n * 2);
      expect(hex).toMatch(/^[0-9a-f]*$/);
    }
  });

  it("does not collide across consecutive calls for non-trivial lengths", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 32; i += 1) seen.add(randomHex(16));
    // 16 bytes = 128 bits of entropy; 32 samples should never collide.
    expect(seen.size).toBe(32);
  });

  it("rejects non-integer and negative byte lengths", () => {
    expect(() => randomHex(-1)).toThrow(RangeError);
    expect(() => randomHex(1.5)).toThrow(RangeError);
    expect(() => randomHex(Number.NaN)).toThrow(RangeError);
  });
});

describe("utf8ByteLength", () => {
  it("matches Node Buffer byte lengths for ASCII and multibyte input", () => {
    for (const input of ["", "abc", "é́", "字符串", "ok🦊", "\ud800", "a\ud800b"]) {
      expect(utf8ByteLength(input), JSON.stringify(input)).toBe(Buffer.byteLength(input, "utf8"));
    }
  });
});

describe("source-hash fallback UTF-8 encoder", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("matches node:crypto when TextEncoder is unavailable and input has lone surrogates", async () => {
    vi.stubGlobal("TextEncoder", undefined);
    const fallbackModulePath = `../src/core/source-hash.ts?fallback=${Date.now()}`;
    const { hashSource: fallbackHashSource } = await import(fallbackModulePath);
    const corpus = ["\ud800", "\udc00", "a\ud800b", "\ud800\udc00", "ok🦊"];

    for (const input of corpus) {
      const expected = createHash("sha256").update(input, "utf8").digest("hex");
      expect(fallbackHashSource(input), JSON.stringify(input)).toBe(expected);
    }
  });
});

describe("constantTimeEqual", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("a".repeat(64), "a".repeat(64))).toBe(true);
  });

  it("returns false for equal-length but different strings", () => {
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("a".repeat(64), "a".repeat(63) + "b")).toBe(false);
    // Difference in the first character — still must return false (does not
    // short-circuit but the boolean result is what's being checked here).
    expect(constantTimeEqual("zbc", "abc")).toBe(false);
  });

  it("returns false for different-length strings without reading past either end", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("abcd", "abc")).toBe(false);
    expect(constantTimeEqual("", "x")).toBe(false);
  });
});
