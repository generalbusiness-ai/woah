import { stableShadowJson } from "./shadow-cell-version";
import { hashSource } from "./source-hash";
import type { WooValue } from "./types";

export type ShadowKnownPageHashSetIdentity = {
  kind: "woo.known_page_hash_set.v1";
  token: string;
  digest: string;
  count: number;
};

export type ShadowKnownPageHashSet = {
  identity: ShadowKnownPageHashSetIdentity;
  hashes: string[];
};

export function shadowKnownPageHashSet(hashes: Iterable<string>): ShadowKnownPageHashSet {
  const unique = Array.from(new Set(Array.from(hashes).filter((hash) => typeof hash === "string" && hash.length > 0))).sort();
  const digest = hashSource(stableShadowJson({
    kind: "woo.known_page_hash_set_material.v1",
    hashes: unique
  } as unknown as WooValue));
  return {
    identity: {
      kind: "woo.known_page_hash_set.v1",
      token: digest,
      digest,
      count: unique.length
    },
    hashes: unique
  };
}

export function shadowKnownPageHashSetIdentity(hashes: Iterable<string>): ShadowKnownPageHashSetIdentity {
  return shadowKnownPageHashSet(hashes).identity;
}

export function shadowKnownPageHashSetIdentityMatches(
  identity: ShadowKnownPageHashSetIdentity | undefined,
  hashes: Iterable<string>
): boolean {
  if (!identity || identity.kind !== "woo.known_page_hash_set.v1") return false;
  const actual = shadowKnownPageHashSet(hashes).identity;
  return identity.token === actual.token &&
    identity.digest === actual.digest &&
    identity.count === actual.count;
}
