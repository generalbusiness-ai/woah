import { hashSource } from "./source-hash";
import type { ObjRef } from "./types";
import type { ShadowTurnKey } from "./turn-key";

export type ShadowBloomFilter = {
  m: number;
  k: number;
  bits_hex: string;
};

export type ShadowCapabilityAd = {
  kind: "woo.exec_capability_ad.shadow.v1";
  node: string;
  scope: ObjRef;
  epoch: string;
  // B8: the owner head hash this ad reflects. A consumer prefers an ad whose
  // head matches the scope it is routing for; a stale-head ad still routes (the
  // commit validates authority anyway) but ranks no better than a fresh one.
  head?: string;
  covers: ShadowBloomFilter;
  accepts: ShadowBloomFilter;
  effects: number;
  // B8 routing-cost components. `factor` is the node's own opaque self-cost
  // estimate (load/proximity); the others let a caller rank candidates by
  // expected total cost: latency to reach the node, the state-transfer cost to
  // warm a turn there (derived from B7's measurable cell_pages transfer — a
  // node already holding the closure advertises ~0), and a penalty accrued from
  // recent false-positive refusals so a lying Bloom is deprioritised. All
  // default to 0 so an ad that sets only `factor` ranks exactly as before.
  factor: number;
  latency_ms?: number;
  transfer_cost?: number;
  failure_penalty?: number;
  // B8 freshness. When both are set, a consumer passing `now` drops the ad once
  // `issued_at_ms + ttl_ms < now`. Absent → the ad never expires (the in-process
  // and test paths that do not stamp time).
  issued_at_ms?: number;
  ttl_ms?: number;
};

export function buildShadowCapabilityAd(input: {
  node: string;
  scope: ObjRef;
  epoch?: string;
  head?: string;
  atom_hashes: string[];
  accepts_atom_hashes?: string[];
  effects?: number;
  factor?: number;
  latency_ms?: number;
  transfer_cost?: number;
  failure_penalty?: number;
  issued_at_ms?: number;
  ttl_ms?: number;
  m?: number;
  k?: number;
}): ShadowCapabilityAd {
  const m = input.m ?? 512;
  const k = input.k ?? 4;
  const covers = buildBloom(input.atom_hashes, m, k);
  const accepts = buildBloom(input.accepts_atom_hashes ?? input.atom_hashes, m, k);
  return {
    kind: "woo.exec_capability_ad.shadow.v1",
    node: input.node,
    scope: input.scope,
    epoch: input.epoch ?? "shadow",
    ...(input.head !== undefined ? { head: input.head } : {}),
    covers,
    accepts,
    effects: input.effects ?? 0,
    factor: input.factor ?? 1,
    ...(input.latency_ms !== undefined ? { latency_ms: input.latency_ms } : {}),
    ...(input.transfer_cost !== undefined ? { transfer_cost: input.transfer_cost } : {}),
    ...(input.failure_penalty !== undefined ? { failure_penalty: input.failure_penalty } : {}),
    ...(input.issued_at_ms !== undefined ? { issued_at_ms: input.issued_at_ms } : {}),
    ...(input.ttl_ms !== undefined ? { ttl_ms: input.ttl_ms } : {})
  };
}

export function capabilityAdProbablyCoversTurn(ad: ShadowCapabilityAd, key: ShadowTurnKey): boolean {
  if (ad.scope !== key.scope) return false;
  return bloomContainsAll(ad.covers, key.atom_hashes) && bloomContainsAll(ad.accepts, key.accept_atom_hashes);
}

// B8 candidate ranking score: lower is better. The full formula the target
// names — latency + factor + transfer_cost + failure_penalty — collapses to
// `factor` alone when the cost components are unset, so existing factor-only
// ranking is unchanged. This is the single source of truth for "which covering
// node should run this turn"; ads route, the commit still proves authority.
export function capabilityAdRoutingScore(ad: ShadowCapabilityAd): number {
  return (ad.latency_ms ?? 0) + ad.factor + (ad.transfer_cost ?? 0) + (ad.failure_penalty ?? 0);
}

function capabilityAdExpired(ad: ShadowCapabilityAd, now?: number): boolean {
  if (now === undefined) return false;
  if (ad.issued_at_ms === undefined || ad.ttl_ms === undefined) return false;
  return ad.issued_at_ms + ad.ttl_ms < now;
}

export function rankCapabilityAdsForTurn(
  ads: ShadowCapabilityAd[],
  key: ShadowTurnKey,
  options?: { now?: number }
): ShadowCapabilityAd[] {
  return ads
    .filter((ad) => !capabilityAdExpired(ad, options?.now) && capabilityAdProbablyCoversTurn(ad, key))
    .sort((a, b) => capabilityAdRoutingScore(a) - capabilityAdRoutingScore(b) || a.node.localeCompare(b.node));
}

function buildBloom(atomHashes: string[], m: number, k: number): ShadowBloomFilter {
  const bytes = new Uint8Array(Math.ceil(m / 8));
  for (const atomHash of atomHashes) {
    for (const index of bloomIndexes(atomHash, m, k)) setBit(bytes, index);
  }
  return { m, k, bits_hex: bytesToHex(bytes) };
}

function bloomContainsAll(filter: ShadowBloomFilter, atomHashes: string[]): boolean {
  const bytes = hexToBytes(filter.bits_hex);
  return atomHashes.every((atomHash) =>
    bloomIndexes(atomHash, filter.m, filter.k).every((index) => getBit(bytes, index))
  );
}

function bloomIndexes(atomHash: string, m: number, k: number): number[] {
  const indexes: number[] = [];
  for (let i = 0; i < k; i++) {
    const digest = hashSource(`${i}:${atomHash}`);
    indexes.push(Number.parseInt(digest.slice(0, 12), 16) % m);
  }
  return indexes;
}

function setBit(bytes: Uint8Array, index: number): void {
  bytes[Math.floor(index / 8)] |= 1 << (index % 8);
}

function getBit(bytes: Uint8Array, index: number): boolean {
  return (bytes[Math.floor(index / 8)] & (1 << (index % 8))) !== 0;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(Math.ceil(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
