import type { EffectTranscript } from "../core/effect-transcript";
import type { ShadowScopeHead } from "../core/shadow-commit-scope";
import type { ObjRef } from "../core/types";

export const V2_BROWSER_TENTATIVE_JOURNAL_LIMIT = 16;

export type V2BrowserTentativeTurnRecord = {
  id: string;
  scope: ObjRef;
  actor: ObjRef;
  session: string | null;
  base_head: ShadowScopeHead;
  transcript_hash: string;
  transcript: EffectTranscript;
  status: "pending";
  created_at: number;
};

export type V2BrowserTentativeSelector = {
  scope: ObjRef;
  actor: ObjRef;
  session: string | null;
};

export function v2BrowserTentativeTurnRecord(input: {
  id: string;
  scope: ObjRef;
  actor: ObjRef;
  session: string | null;
  base_head: ShadowScopeHead;
  transcript: EffectTranscript;
  created_at?: number;
}): V2BrowserTentativeTurnRecord {
  return {
    id: input.id,
    scope: input.scope,
    actor: input.actor,
    session: input.session,
    base_head: structuredClone(input.base_head) as ShadowScopeHead,
    transcript_hash: input.transcript.hash,
    transcript: structuredClone(input.transcript) as EffectTranscript,
    status: "pending",
    created_at: input.created_at ?? Date.now()
  };
}

export function selectV2PendingTentativeTurns(
  records: readonly V2BrowserTentativeTurnRecord[],
  selector: V2BrowserTentativeSelector
): V2BrowserTentativeTurnRecord[] {
  return records
    .filter((record) =>
      record.status === "pending" &&
      record.scope === selector.scope &&
      record.actor === selector.actor &&
      record.session === selector.session
    )
    .slice()
    .sort(compareTentativeTurns);
}

export function v2TentativeTranscriptChain(
  records: readonly V2BrowserTentativeTurnRecord[],
  selector: V2BrowserTentativeSelector
): EffectTranscript[] {
  return selectV2PendingTentativeTurns(records, selector)
    .map((record) => structuredClone(record.transcript) as EffectTranscript);
}

export function v2TentativeJournalHasCapacity(
  records: readonly V2BrowserTentativeTurnRecord[],
  selector: V2BrowserTentativeSelector,
  limit = V2_BROWSER_TENTATIVE_JOURNAL_LIMIT
): boolean {
  return selectV2PendingTentativeTurns(records, selector).length < limit;
}

export function v2TentativeTurnMatches(
  record: V2BrowserTentativeTurnRecord,
  ids: readonly string[],
  transcriptHash?: string
): boolean {
  return ids.includes(record.id) || (transcriptHash !== undefined && record.transcript_hash === transcriptHash);
}

export function v2TentativeTurnForInvalidation(
  records: readonly V2BrowserTentativeTurnRecord[],
  ids: readonly string[],
  transcriptHash?: string
): V2BrowserTentativeTurnRecord | null {
  // Phase 1 has no wire-level depends_on field, so the relay treats later
  // locally planned turns as independent submissions. Only the directly
  // rejected tentative can be invalidated without inventing dependency
  // semantics the server does not yet enforce.
  return records.find((record) => v2TentativeTurnMatches(record, ids, transcriptHash)) ?? null;
}

export function v2TentativeTurnChainFrom(
  records: readonly V2BrowserTentativeTurnRecord[],
  anchor: V2BrowserTentativeTurnRecord
): V2BrowserTentativeTurnRecord[] {
  return records
    .filter((record) =>
      record.status === "pending" &&
      record.scope === anchor.scope &&
      record.actor === anchor.actor &&
      record.session === anchor.session &&
      record.created_at >= anchor.created_at
    )
    .slice()
    .sort(compareTentativeTurns);
}

function compareTentativeTurns(a: V2BrowserTentativeTurnRecord, b: V2BrowserTentativeTurnRecord): number {
  return a.created_at - b.created_at || a.id.localeCompare(b.id);
}
