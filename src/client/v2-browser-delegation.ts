import { rankCapabilityAdsForTurn, type ShadowCapabilityAd } from "../core/capability-ad";
import { hashSource } from "../core/source-hash";
import { stableShadowJson } from "../core/shadow-cell-version";
import type { ShadowTurnKey } from "../core/turn-key";
import type { WooValue } from "../core/types";

export type V2ExecutionAdRecord = {
  id: string;
  node: string;
  scope: string;
  ad: ShadowCapabilityAd;
  received_at: number;
};

export type V2DelegationSelection =
  | {
      ok: true;
      record: V2ExecutionAdRecord;
      ad: ShadowCapabilityAd;
    }
  | {
      ok: false;
      reason: "no_executor";
    };

export function v2ExecutionAdRecord(ad: ShadowCapabilityAd, receivedAt: number = Date.now()): V2ExecutionAdRecord {
  return {
    id: v2ExecutionAdId(ad),
    node: ad.node,
    scope: ad.scope,
    ad: structuredClone(ad) as ShadowCapabilityAd,
    received_at: receivedAt
  };
}

export function v2ExecutionAdId(ad: ShadowCapabilityAd): string {
  return `${ad.scope}:${ad.node}:${hashSource(stableShadowJson(ad as unknown as WooValue))}`;
}

// Gossiped ads are only probabilistic claims. Selection ranks candidates; the
// selected executor still proves exact state by either executing or returning
// missing_state on the authoritative turn request.
export function selectV2DelegatedExecutor(input: {
  records: readonly V2ExecutionAdRecord[];
  key: ShadowTurnKey;
}): V2DelegationSelection {
  const recordByAd = new Map<ShadowCapabilityAd, V2ExecutionAdRecord>();
  const ads = input.records.map((record) => {
    recordByAd.set(record.ad, record);
    return record.ad;
  });
  const selected = rankCapabilityAdsForTurn(ads, input.key)[0];
  if (!selected) return { ok: false, reason: "no_executor" };
  const record = recordByAd.get(selected);
  if (!record) return { ok: false, reason: "no_executor" };
  return { ok: true, record, ad: selected };
}

// A cold browser cannot derive exact atom coverage yet. Scope-level selection
// is intentionally weaker and must be followed by relay-side planning and the
// normal exact missing-state checks before any delegated execution is accepted.
export function selectV2DelegatedScopeExecutor(input: {
  records: readonly V2ExecutionAdRecord[];
  scope: string;
}): V2DelegationSelection {
  const selected = input.records
    .filter((record) => record.scope === input.scope)
    .map((record) => record.ad)
    .sort((a, b) => a.factor - b.factor || a.node.localeCompare(b.node))[0];
  if (!selected) return { ok: false, reason: "no_executor" };
  const record = input.records.find((item) => item.ad.node === selected.node && item.scope === selected.scope);
  if (!record) return { ok: false, reason: "no_executor" };
  return { ok: true, record, ad: selected };
}
