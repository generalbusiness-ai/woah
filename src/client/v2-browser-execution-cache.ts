import type { EffectTranscript } from "../core/effect-transcript";
import { applyShadowTranscriptToCommitScopeCache, createShadowCommitScope, serializedFor } from "../core/shadow-commit-scope";
import { createShadowExecutionNode, installShadowStateTransfer, type ShadowExecutionNode, type ShadowStateTransfer } from "../core/shadow-turn-exec";
import { stableShadowJson } from "../core/shadow-cell-version";
import type { SerializedObject, SerializedWorld } from "../core/repository";
import type { ShadowStatePage } from "../core/shadow-state-pages";
import { hashSource } from "../core/source-hash";
import { shadowAtomHash, shadowReadCellPreimage, shadowTurnKeyFromTranscript } from "../core/turn-key";
import type { ObjRef, WooValue } from "../core/types";

export type V2ExecutableTransferRecord = {
  id: string;
  scope: ObjRef;
  mode: ShadowStateTransfer["mode"];
  transfer: ShadowStateTransfer;
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

export function v2ExecutableTransferRecord(
  transfer: ShadowStateTransfer,
  receivedAt: number = Date.now()
): V2ExecutableTransferRecord {
  return {
    id: v2ExecutableTransferId(transfer),
    scope: transfer.scope,
    mode: transfer.mode,
    transfer: structuredClone(transfer) as ShadowStateTransfer,
    received_at: receivedAt
  };
}

export function v2ExecutableTransferId(transfer: ShadowStateTransfer): string {
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
