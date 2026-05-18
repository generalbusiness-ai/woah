// Isomorphic content hashing and random utilities. Both the substrate (which
// runs in Node, Cloudflare Workers, and browser-side worker contexts) and the
// browser bundle reach this module. Anything imported here must therefore be
// available everywhere — no `node:*` imports.
//
// FIPS 180-4 SHA-256 implemented directly in TypeScript so callers can hash
// synchronously. Web Crypto's `crypto.subtle.digest` is async and not usable
// from the many sync proof/transcript/idempotency-key call sites. The
// implementation is byte-exact equivalent to `node:crypto`'s `sha256` digest
// over the UTF-8 encoding of the input; equivalence is enforced by
// tests/source-hash.test.ts against both NIST/FIPS vectors and Node's own
// digest output.

// Round constants — first 32 bits of the fractional parts of the cube roots of
// the first 64 primes (FIPS 180-4 §4.2.2). Frozen so the array contents cannot
// be mutated by accident through the shared module instance.
const K = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

// Initial hash values — first 32 bits of the fractional parts of the square
// roots of the first 8 primes (FIPS 180-4 §5.3.3).
const H0 = Object.freeze([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
]);

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

function sha256Bytes(bytes: Uint8Array): Uint8Array {
  // Padding: append a single 1 bit, then zeros until length ≡ 56 (mod 64),
  // then the 64-bit big-endian message length in bits. With JS-safe integer
  // ranges (< 2**53) the high 32 bits of bitLength only matter for inputs
  // ≥ 512 MiB; we still emit both halves to stay strictly FIPS 180-4 compliant.
  const bitLength = bytes.byteLength * 8;
  const padLength = bytes.byteLength % 64 < 56 ? 56 - (bytes.byteLength % 64) : 120 - (bytes.byteLength % 64);
  const buffer = new Uint8Array(bytes.byteLength + padLength + 8);
  buffer.set(bytes, 0);
  buffer[bytes.byteLength] = 0x80;
  // Length in bits, big-endian, 64-bit. JS numbers are safe up to 2^53.
  const lengthOffset = buffer.byteLength - 8;
  const highBits = Math.floor(bitLength / 0x100000000) >>> 0;
  const lowBits = (bitLength >>> 0);
  buffer[lengthOffset] = (highBits >>> 24) & 0xff;
  buffer[lengthOffset + 1] = (highBits >>> 16) & 0xff;
  buffer[lengthOffset + 2] = (highBits >>> 8) & 0xff;
  buffer[lengthOffset + 3] = highBits & 0xff;
  buffer[lengthOffset + 4] = (lowBits >>> 24) & 0xff;
  buffer[lengthOffset + 5] = (lowBits >>> 16) & 0xff;
  buffer[lengthOffset + 6] = (lowBits >>> 8) & 0xff;
  buffer[lengthOffset + 7] = lowBits & 0xff;

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const state = new Uint32Array(H0);
  const w = new Uint32Array(64);

  for (let chunkOffset = 0; chunkOffset < buffer.byteLength; chunkOffset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(chunkOffset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = state[0], b = state[1], c = state[2], d = state[3];
    let e = state[4], f = state[5], g = state[6], h = state[7];

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, state[i], false);
  return out;
}

const HEX = "0123456789abcdef";
function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    const byte = bytes[i];
    out += HEX[byte >>> 4] + HEX[byte & 0x0f];
  }
  return out;
}

const TEXT_ENCODER = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
function utf8Encode(source: string): Uint8Array {
  // Node and modern browsers both expose TextEncoder; the explicit fallback
  // exists for the rare environment that lacks it (e.g. older test shims).
  if (TEXT_ENCODER) return TEXT_ENCODER.encode(source);
  const bytes: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    let code = source.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < source.length) {
      const low = source.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + (((code - 0xd800) << 10) | (low - 0xdc00));
        i += 1;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xd800 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >>> 6));
      bytes.push(0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >>> 12));
      bytes.push(0x80 | ((code >>> 6) & 0x3f));
      bytes.push(0x80 | (code & 0x3f));
    } else {
      bytes.push(0xf0 | (code >>> 18));
      bytes.push(0x80 | ((code >>> 12) & 0x3f));
      bytes.push(0x80 | ((code >>> 6) & 0x3f));
      bytes.push(0x80 | (code & 0x3f));
    }
  }
  return Uint8Array.from(bytes);
}

export function hashSource(source: string): string {
  return bytesToHex(sha256Bytes(utf8Encode(source)));
}

// Minimal type for the Web Crypto bit we actually need. The worker tsconfig
// excludes the DOM lib; this avoids pulling in the whole DOM typing surface
// just to type-check `crypto.getRandomValues`.
type WebCrypto = { getRandomValues<T extends ArrayBufferView>(array: T): T };
const webCrypto: WebCrypto | undefined =
  (globalThis as unknown as { crypto?: WebCrypto }).crypto;

export function randomHex(byteLength: number): string {
  if (!Number.isInteger(byteLength) || byteLength < 0) {
    throw new RangeError(`randomHex requires a non-negative integer byte length, got ${byteLength}`);
  }
  const bytes = new Uint8Array(byteLength);
  if (byteLength > 0) {
    if (!webCrypto) throw new Error("randomHex requires a global crypto.getRandomValues implementation");
    webCrypto.getRandomValues(bytes);
  }
  return bytesToHex(bytes);
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
