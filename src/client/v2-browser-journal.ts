import type { EffectTranscript, TranscriptCell } from "../core/effect-transcript";
import type { ShadowCommitAccepted, ShadowScopeHead } from "../core/shadow-commit-scope";
import type { ObjRef } from "../core/types";

export const V2_BROWSER_TENTATIVE_JOURNAL_LIMIT = 16;

export type V2ProposalDependency = {
  cell: TranscriptCell;
  version?: string;
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

export function v2TurnProposalAcceptedFrameMatch(
  record: V2BrowserTurnProposalRecord,
  frame: Pick<ShadowCommitAccepted, "id" | "transcript_hash">
): "hash" | "id" | null {
  if (record.transcript_hash === frame.transcript_hash) return "hash";
  if (frame.id && record.id === frame.id) return "id";
  return null;
}

export function v2TurnProposalNeedsReplanAfterTranscript(
  record: V2BrowserTurnProposalRecord,
  accepted: EffectTranscript
): boolean {
  if (record.status !== "pending" || record.scope !== accepted.scope) return false;
  const touched = new Set(acceptedTouchedCellKeys(accepted));
  if (touched.size === 0) return false;
  return record.depends_on.some((dependency) => touched.has(proposalCellKey(dependency.cell)));
}

export function v2TurnProposalNeedsReplanRecord(record: V2BrowserTurnProposalRecord): V2BrowserTurnProposalRecord {
  return {
    ...normalizeTurnProposalRecord(record),
    status: "needs_replan"
  };
}

export function v2ReconcileTurnProposalsWithAcceptedFrame(
  records: readonly V2BrowserTurnProposalRecord[],
  selector: V2BrowserProposalSelector,
  frame: Pick<ShadowCommitAccepted, "id" | "position" | "transcript_hash">,
  transcript?: EffectTranscript
): {
  matched: V2BrowserTurnProposalRecord[];
  promote: V2BrowserTurnProposalRecord[];
  replan: V2BrowserTurnProposalRecord[];
} {
  const scoped = records
    .map(normalizeTurnProposalRecord)
    .filter((record) =>
      record.scope === selector.scope &&
      record.actor === selector.actor &&
      record.session === selector.session
    );
  const matched = scoped.filter((record) => v2TurnProposalAcceptedFrameMatch(record, frame));
  const confirmedLocalTranscript = matched.some((record) => record.transcript_hash === frame.transcript_hash);
  const matchedIds = new Set(matched.map((record) => record.id));
  const replan = confirmedLocalTranscript || !transcript
    ? []
    : scoped.filter((record) =>
        !matchedIds.has(record.id) &&
        v2TurnProposalNeedsReplanAfterTranscript(record, transcript)
      );
  return {
    matched,
    promote: transcript ? [] : matched.filter((record) => record.transcript_hash === frame.transcript_hash),
    replan
  };
}

function proposalDependencies(transcript: EffectTranscript): V2ProposalDependency[] {
  const byCell = new Map<string, V2ProposalDependency>();
  for (const read of transcript.reads) {
    const dependency = {
      cell: structuredClone(read.cell) as TranscriptCell,
      ...(read.version !== undefined ? { version: read.version } : {})
    };
    byCell.set(proposalCellKey(dependency.cell), dependency);
  }
  for (const cell of transcript.stateProbes ?? []) {
    byCell.set(proposalCellKey(cell), { cell: structuredClone(cell) as TranscriptCell });
  }
  return Array.from(byCell.values()).sort(compareProposalCells);
}

function normalizeTurnProposalRecord(record: V2BrowserTurnProposalRecord): V2BrowserTurnProposalRecord {
  if (
    record.kind === "woo.turn_proposal.v1" &&
    Array.isArray(record.depends_on)
  ) {
    return record;
  }
  return {
    ...record,
    kind: "woo.turn_proposal.v1",
    depends_on: proposalDependencies(record.transcript),
    predicted_overlay: record.predicted_overlay ?? null,
    status: record.status ?? "pending"
  };
}

function compareProposalCells<T extends { cell: TranscriptCell }>(a: T, b: T): number {
  return proposalCellKey(a.cell).localeCompare(proposalCellKey(b.cell));
}

function compareTentativeTurns(a: V2BrowserTurnProposalRecord, b: V2BrowserTurnProposalRecord): number {
  return a.created_at - b.created_at || a.id.localeCompare(b.id);
}

function acceptedTouchedCellKeys(transcript: EffectTranscript): string[] {
  const keys = new Set<string>();
  for (const write of transcript.writes) keys.add(proposalCellKey(write.cell));
  for (const created of transcript.creates) keys.add(proposalCellKey({ kind: "lifecycle", object: created.object }));
  for (const move of transcript.moves) {
    keys.add(proposalCellKey({ kind: "location", object: move.object }));
    if (move.from) keys.add(proposalCellKey({ kind: "contents", object: move.from }));
    keys.add(proposalCellKey({ kind: "contents", object: move.to }));
  }
  return Array.from(keys);
}

function proposalCellKey(cell: TranscriptCell): string {
  switch (cell.kind) {
    case "prop":
      return `prop:${cell.object}:${cell.name}`;
    case "verb":
      return `verb:${cell.object}:${cell.name}`;
    case "location":
      return `location:${cell.object}`;
    case "contents":
      return `contents:${cell.object}`;
    case "lifecycle":
      return `lifecycle:${cell.object}`;
  }
}
