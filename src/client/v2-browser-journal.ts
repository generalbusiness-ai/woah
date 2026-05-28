import type { EffectTranscript, TranscriptCell, TranscriptWrite } from "../core/effect-transcript";
import type { ShadowScopeHead } from "../core/shadow-commit-scope";
import type { ObjRef } from "../core/types";

export const V2_BROWSER_TENTATIVE_JOURNAL_LIMIT = 16;

export type V2ProposalDependency = {
  cell: TranscriptCell;
  version?: string;
};

export type V2ProposalWriteCell = {
  cell: TranscriptCell;
  prior?: string;
  next?: string;
  op: TranscriptWrite["op"];
};

export type V2ProposalProjectionOverlay = {
  kind: "woo.proposal_projection_overlay.v1";
  id: string;
  scope: ObjRef;
  result_known: boolean;
  authoritative_projection: false;
};

export type V2BrowserTurnProposalRecord = {
  kind: "woo.turn_proposal.v1";
  id: string;
  scope: ObjRef;
  actor: ObjRef;
  session: string | null;
  base_head: ShadowScopeHead;
  transcript_hash: string;
  transcript: EffectTranscript;
  depends_on: V2ProposalDependency[];
  write_cells: V2ProposalWriteCell[];
  state_probe_cells: TranscriptCell[];
  predicted_overlay: V2ProposalProjectionOverlay | null;
  status: "pending" | "needs_replan";
  created_at: number;
};

export type V2BrowserProposalSelector = {
  scope: ObjRef;
  actor: ObjRef;
  session: string | null;
};

export function v2BrowserTurnProposalRecord(input: {
  id: string;
  scope: ObjRef;
  actor: ObjRef;
  session: string | null;
  base_head: ShadowScopeHead;
  transcript: EffectTranscript;
  predicted_overlay?: V2ProposalProjectionOverlay | null;
  created_at?: number;
}): V2BrowserTurnProposalRecord {
  return {
    kind: "woo.turn_proposal.v1",
    id: input.id,
    scope: input.scope,
    actor: input.actor,
    session: input.session,
    base_head: structuredClone(input.base_head) as ShadowScopeHead,
    transcript_hash: input.transcript.hash,
    transcript: structuredClone(input.transcript) as EffectTranscript,
    depends_on: proposalDependencies(input.transcript),
    write_cells: proposalWriteCells(input.transcript),
    state_probe_cells: structuredClone(input.transcript.stateProbes ?? []) as TranscriptCell[],
    predicted_overlay: input.predicted_overlay
      ? structuredClone(input.predicted_overlay) as V2ProposalProjectionOverlay
      : null,
    status: "pending",
    created_at: input.created_at ?? Date.now()
  };
}

export function selectV2PendingTurnProposals(
  records: readonly V2BrowserTurnProposalRecord[],
  selector: V2BrowserProposalSelector
): V2BrowserTurnProposalRecord[] {
  return records
    .map(normalizeTurnProposalRecord)
    .filter((record) =>
      record.status === "pending" &&
      record.scope === selector.scope &&
      record.actor === selector.actor &&
      record.session === selector.session
    )
    .slice()
    .sort(compareTentativeTurns);
}

export function v2ProposalTranscriptChain(
  records: readonly V2BrowserTurnProposalRecord[],
  selector: V2BrowserProposalSelector
): EffectTranscript[] {
  return selectV2PendingTurnProposals(records, selector)
    .map((record) => structuredClone(record.transcript) as EffectTranscript);
}

export function v2ProposalBufferHasCapacity(
  records: readonly V2BrowserTurnProposalRecord[],
  selector: V2BrowserProposalSelector,
  limit = V2_BROWSER_TENTATIVE_JOURNAL_LIMIT
): boolean {
  return selectV2PendingTurnProposals(records, selector).length < limit;
}

export function v2TurnProposalMatches(
  record: V2BrowserTurnProposalRecord,
  ids: readonly string[],
  transcriptHash?: string
): boolean {
  return ids.includes(record.id) || (transcriptHash !== undefined && record.transcript_hash === transcriptHash);
}

export function v2TurnProposalForInvalidation(
  records: readonly V2BrowserTurnProposalRecord[],
  ids: readonly string[],
  transcriptHash?: string
): V2BrowserTurnProposalRecord | null {
  // Phase 1 has no wire-level depends_on field, so the relay treats later
  // locally planned turns as independent submissions. Only the directly
  // rejected tentative can be invalidated without inventing dependency
  // semantics the server does not yet enforce.
  return records.map(normalizeTurnProposalRecord).find((record) => v2TurnProposalMatches(record, ids, transcriptHash)) ?? null;
}

function proposalDependencies(transcript: EffectTranscript): V2ProposalDependency[] {
  const byCell = new Map<string, V2ProposalDependency>();
  for (const read of transcript.reads) {
    const dependency = {
      cell: structuredClone(read.cell) as TranscriptCell,
      ...(read.version !== undefined ? { version: read.version } : {})
    };
    byCell.set(JSON.stringify(dependency.cell), dependency);
  }
  for (const cell of transcript.stateProbes ?? []) {
    byCell.set(JSON.stringify(cell), { cell: structuredClone(cell) as TranscriptCell });
  }
  return Array.from(byCell.values()).sort(compareProposalCells);
}

function proposalWriteCells(transcript: EffectTranscript): V2ProposalWriteCell[] {
  return transcript.writes
    .map((write) => ({
      cell: structuredClone(write.cell) as TranscriptCell,
      ...(write.prior !== undefined ? { prior: write.prior } : {}),
      ...(write.next !== undefined ? { next: write.next } : {}),
      op: write.op
    }))
    .sort(compareProposalCells);
}

function normalizeTurnProposalRecord(record: V2BrowserTurnProposalRecord): V2BrowserTurnProposalRecord {
  if (
    record.kind === "woo.turn_proposal.v1" &&
    Array.isArray(record.depends_on) &&
    Array.isArray(record.write_cells) &&
    Array.isArray(record.state_probe_cells)
  ) {
    return record;
  }
  return {
    ...record,
    kind: "woo.turn_proposal.v1",
    depends_on: proposalDependencies(record.transcript),
    write_cells: proposalWriteCells(record.transcript),
    state_probe_cells: structuredClone(record.transcript.stateProbes ?? []) as TranscriptCell[],
    predicted_overlay: record.predicted_overlay ?? null,
    status: record.status ?? "pending"
  };
}

function compareProposalCells<T extends { cell: TranscriptCell }>(a: T, b: T): number {
  return JSON.stringify(a.cell).localeCompare(JSON.stringify(b.cell));
}

function compareTentativeTurns(a: V2BrowserTurnProposalRecord, b: V2BrowserTurnProposalRecord): number {
  return a.created_at - b.created_at || a.id.localeCompare(b.id);
}
