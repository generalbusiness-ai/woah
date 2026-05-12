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
  covers: ShadowBloomFilter;
  effects: number;
  factor: number;
};

export function buildShadowCapabilityAd(input: {
  node: string;
  scope: ObjRef;
  epoch?: string;
  atom_hashes: string[];
  effects?: number;
  factor?: number;
  m?: number;
  k?: number;
}): ShadowCapabilityAd {
  const m = input.m ?? 512;
  const k = input.k ?? 4;
  const bytes = new Uint8Array(Math.ceil(m / 8));
  for (const atomHash of input.atom_hashes) {
    for (const index of bloomIndexes(atomHash, m, k)) setBit(bytes, index);
  }
  return {
    kind: "woo.exec_capability_ad.shadow.v1",
    node: input.node,
    scope: input.scope,
    epoch: input.epoch ?? "shadow",
    covers: { m, k, bits_hex: bytesToHex(bytes) },
    effects: input.effects ?? 0,
    factor: input.factor ?? 1
  };
}

export function capabilityAdProbablyCoversTurn(ad: ShadowCapabilityAd, key: ShadowTurnKey): boolean {
  if (ad.scope !== key.scope) return false;
  const bytes = hexToBytes(ad.covers.bits_hex);
  return key.atom_hashes.every((atomHash) =>
    bloomIndexes(atomHash, ad.covers.m, ad.covers.k).every((index) => getBit(bytes, index))
  );
}

export function rankCapabilityAdsForTurn(ads: ShadowCapabilityAd[], key: ShadowTurnKey): ShadowCapabilityAd[] {
  return ads
    .filter((ad) => capabilityAdProbablyCoversTurn(ad, key))
    .sort((a, b) => b.factor - a.factor || a.node.localeCompare(b.node));
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
