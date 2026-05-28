import type { EffectTranscript } from "../core/effect-transcript";
import { applyShadowTranscriptToCommitScopeCache, createShadowCommitScope, serializedFor, type ShadowScopeHead } from "../core/shadow-commit-scope";
import {
  buildShadowCellPageTransfer,
  createShadowExecutionNode,
  installShadowStateTransfer,
  type ShadowCellPageTransfer,
  type ShadowExecutionNode
} from "../core/shadow-turn-exec";
import { stableShadowJson } from "../core/shadow-cell-version";
import type { SerializedObject, SerializedWorld } from "../core/repository";
import type { ShadowStatePage, ShadowStatePageRef } from "../core/shadow-state-pages";
import { hashSource } from "../core/source-hash";
import { shadowAtomHash, shadowReadCellPreimage, shadowTurnKeyFromTranscript, type ShadowTurnKey } from "../core/turn-key";
import type { ObjRef, WooValue } from "../core/types";

export type V2ExecutableTransferRecord = {
  id: string;
  scope: ObjRef;
  mode: ShadowCellPageTransfer["mode"];
  transfer: ShadowCellPageTransfer;
  received_at: number;
};

export type V2BrowserExecutionCheckpoint = {
  scope: ObjRef;
  through_seq: number;
  transfer_high_watermark: number;
  serialized: SerializedWorld;
  atom_hashes: string[];
  updated_at: number;
};

export type V2BrowserExecutionComposeStats = {
  scope: ObjRef;
  ms: number;
  transfer_count: number;
  installed_transfer_count: number;
  committed_transcript_count: number;
  tentative_transcript_count: number;
  checkpoint_seq?: number;
  object_count: number;
};

export type V2PromotedAcceptedTranscriptTransfer = {
  record: V2ExecutableTransferRecord;
  pages: Array<{ hash: string; ref: string; page: ShadowStatePage }>;
};

export function v2ExecutableTransferRecord(
  transfer: ShadowCellPageTransfer,
  receivedAt: number = Date.now()
): V2ExecutableTransferRecord {
  return {
    id: v2ExecutableTransferId(transfer),
    scope: transfer.scope,
    mode: transfer.mode,
    transfer: structuredClone(transfer) as ShadowCellPageTransfer,
    received_at: receivedAt
  };
}

export function v2ExecutableTransferId(transfer: ShadowCellPageTransfer): string {
  const proofRoot = transfer.proof?.root;
  const contentHash = typeof proofRoot === "string" && proofRoot.length > 0
    ? proofRoot
    : hashSource(stableShadowJson(transfer as unknown as WooValue));
  return `${transfer.scope}:${transfer.mode}:${contentHash}`;
}

export function createV2BrowserExecutionNodeFromTransfers(input: {
  node: string;
  scope: ObjRef;
  records: readonly V2ExecutableTransferRecord[];
  cached_objects?: readonly SerializedObject[];
  cached_pages?: readonly ShadowStatePage[];
  checkpoint?: V2BrowserExecutionCheckpoint | null;
  committed_transcripts?: readonly EffectTranscript[];
  tentative_transcripts?: readonly EffectTranscript[];
  onCompose?: (stats: V2BrowserExecutionComposeStats) => void;
}): ShadowExecutionNode {
  const startedAt = Date.now();
  const executionNode = createShadowExecutionNode({
    node: input.node,
    scope: input.scope,
    atom_hashes: input.checkpoint?.atom_hashes,
    serialized: input.checkpoint?.serialized,
    cached_objects: [...(input.cached_objects ?? [])],
    cached_pages: [...(input.cached_pages ?? [])]
  });
  const records = input.records
    .filter((record) => record.scope === input.scope)
    .filter((record) => !input.checkpoint || record.received_at > input.checkpoint.transfer_high_watermark)
    .slice()
    .sort((a, b) => a.received_at - b.received_at || a.id.localeCompare(b.id));
  for (const record of records) installShadowStateTransfer(executionNode, record.transfer);
  const committed = input.committed_transcripts ?? [];
  const tentative = input.tentative_transcripts ?? [];
  const materialized = materializeTranscriptOverlays(executionNode, [
    ...committed,
    ...tentative
  ]);
  input.onCompose?.({
    scope: input.scope,
    ms: Date.now() - startedAt,
    transfer_count: input.records.filter((record) => record.scope === input.scope).length,
    installed_transfer_count: records.length,
    committed_transcript_count: committed.length,
    tentative_transcript_count: tentative.length,
    ...(input.checkpoint ? { checkpoint_seq: input.checkpoint.through_seq } : {}),
    object_count: materialized.serialized?.objects.length ?? 0
  });
  return materialized;
}

export function createV2BrowserExecutionCheckpoint(input: {
  node: string;
  scope: ObjRef;
  records: readonly V2ExecutableTransferRecord[];
  cached_objects?: readonly SerializedObject[];
  cached_pages?: readonly ShadowStatePage[];
  checkpoint?: V2BrowserExecutionCheckpoint | null;
  committed_transcripts: readonly EffectTranscript[];
  through_seq: number;
  updated_at?: number;
}): V2BrowserExecutionCheckpoint | null {
  const node = createV2BrowserExecutionNodeFromTransfers({
    node: input.node,
    scope: input.scope,
    records: input.records,
    cached_objects: input.cached_objects,
    cached_pages: input.cached_pages,
    checkpoint: input.checkpoint,
    committed_transcripts: input.committed_transcripts
  });
  if (!node.serialized) return null;
  const transferHighWatermark = input.records
    .filter((record) => record.scope === input.scope)
    .reduce((max, record) => Math.max(max, record.received_at), input.checkpoint?.transfer_high_watermark ?? 0);
  return {
    scope: input.scope,
    through_seq: input.through_seq,
    transfer_high_watermark: transferHighWatermark,
    serialized: structuredClone(node.serialized) as SerializedWorld,
    atom_hashes: Array.from(node.atom_hashes).sort(),
    updated_at: input.updated_at ?? Date.now()
  };
}

export function createV2BrowserAcceptedWriteCellTransfer(input: {
  node: string;
  scope: ObjRef;
  records: readonly V2ExecutableTransferRecord[];
  cached_objects?: readonly SerializedObject[];
  cached_pages?: readonly ShadowStatePage[];
  checkpoint?: V2BrowserExecutionCheckpoint | null;
  transcripts: readonly EffectTranscript[];
  received_at?: number;
  accepted_head: ShadowScopeHead;
}): V2PromotedAcceptedTranscriptTransfer | null {
  const scoped = input.transcripts.filter((transcript) => transcript.scope === input.scope);
  const anchor = scoped[scoped.length - 1];
  if (!anchor) return null;
  const materialized = createV2BrowserExecutionNodeFromTransfers({
    node: input.node,
    scope: input.scope,
    records: input.records,
    cached_objects: input.cached_objects,
    cached_pages: input.cached_pages,
    checkpoint: input.checkpoint,
    committed_transcripts: scoped
  });
  if (!materialized.serialized) return null;
  const key = acceptedWriteCellPromotionKey(anchor, scoped);
  const transfer = buildShadowCellPageTransfer({
    serialized: materialized.serialized,
    key,
    atom_hashes: key.atom_hashes,
    session: anchor.session ?? null,
    purpose: "accepted_write_cells",
    recipient: input.node,
    capsule: {
      head: input.accepted_head,
      actor: key.actor,
      session: anchor.session ?? null,
      target: key.target,
      verb: key.verb,
      recipient: input.node
    }
  });
  return {
    record: v2ExecutableTransferRecord(transfer, input.received_at ?? Date.now()),
    pages: executableStatePageRows(transfer)
  };
}

function acceptedWriteCellPromotionKey(anchor: EffectTranscript, transcripts: readonly EffectTranscript[]): ShadowTurnKey {
  const base = shadowTurnKeyFromTranscript(anchor);
  const preimages = new Set(base.preimages);
  const readPreimages = new Set(base.read_preimages);
  for (const transcript of transcripts) {
    for (const write of transcript.writes) {
      const preimage = shadowReadCellPreimage(write.cell);
      preimages.add(preimage);
      readPreimages.add(preimage);
    }
  }
  const sorted = Array.from(preimages).sort();
  const sortedReads = Array.from(readPreimages).sort();
  return {
    ...base,
    preimages: sorted,
    atom_hashes: sorted.map(shadowAtomHash),
    read_preimages: sortedReads,
    read_atom_hashes: sortedReads.map(shadowAtomHash)
  };
}

function executableStatePageRows(transfer: ShadowCellPageTransfer): Array<{ hash: string; ref: string; page: ShadowStatePage }> {
  const refs = new Map(transfer.page_refs.map((ref) => [statePageRefKey(ref), ref] as const));
  return transfer.inline_pages.flatMap((page) => {
    const ref = refs.get(statePageRefKey(page));
    if (!ref) return [];
    return [{ hash: ref.hash, ref: statePageRefKey(ref), page }];
  });
}

function statePageRefKey(page: Pick<ShadowStatePage | ShadowStatePageRef, "object" | "page"> & { name?: string }): string {
  return `${page.object}:${page.page}:${page.name ?? ""}`;
}

function materializeTranscriptOverlays(
  executionNode: ShadowExecutionNode,
  transcripts: readonly EffectTranscript[]
): ShadowExecutionNode {
  const scoped = transcripts.filter((transcript) => transcript.scope === executionNode.scope);
  if (scoped.length === 0 || !executionNode.serialized) return executionNode;
  const atomHashes = new Set(executionNode.atom_hashes);
  const commitScope = createShadowCommitScope({
    node: executionNode.node,
    scope: executionNode.scope,
    serialized: executionNode.serialized
  });
  for (const transcript of scoped) {
    applyShadowTranscriptToCommitScopeCache(commitScope, transcript);
    // A later local turn may read a cell written by an accepted transcript or
    // by a pending local predecessor. Treat the transcript's negotiated atoms
    // as materialized in the composed view so the partial-cache guard asks for
    // genuinely missing remote cells only.
    const key = shadowTurnKeyFromTranscript(transcript);
    for (const hash of key.atom_hashes) atomHashes.add(hash);
    for (const write of transcript.writes) atomHashes.add(shadowAtomHash(shadowReadCellPreimage(write.cell)));
  }
  return createShadowExecutionNode({
    node: executionNode.node,
    scope: executionNode.scope,
    serialized: serializedFor(commitScope, { reason: "browser_execution_overlay" }),
    atom_hashes: Array.from(atomHashes)
  });
}
