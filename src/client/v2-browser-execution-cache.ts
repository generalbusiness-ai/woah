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
import type { SerializedObject } from "../core/repository";
import type { ShadowStatePage, ShadowStatePageRef } from "../core/shadow-state-pages";
import { hashSource } from "../core/source-hash";
import { shadowAtomHash, shadowReadCellPreimage, shadowTurnKeyFromTranscript, type ShadowTurnKey } from "../core/turn-key";
import type { ObjRef, WooValue } from "../core/types";

const ACCEPTED_WRITE_CELL_CAPSULE_NOW_MS = 0;
const ACCEPTED_WRITE_CELL_CAPSULE_TTL_MS = Number.MAX_SAFE_INTEGER - 5_000;

export type V2ExecutableTransferRecord = {
  id: string;
  scope: ObjRef;
  mode: ShadowCellPageTransfer["mode"];
  transfer: ShadowCellPageTransfer;
  received_at: number;
};

export type V2BrowserExecutionComposeStats = {
  scope: ObjRef;
  ms: number;
  transfer_count: number;
  installed_transfer_count: number;
  tentative_transcript_count: number;
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
  tentative_transcripts?: readonly EffectTranscript[];
  onCompose?: (stats: V2BrowserExecutionComposeStats) => void;
}): ShadowExecutionNode {
  // The browser execution-checkpoint store was retired in 0e3b1c5, so the node is
  // always composed from the full set of scoped transfers — there is no persisted
  // seed/high-watermark to start from or to skip already-installed transfers.
  const startedAt = Date.now();
  const executionNode = createShadowExecutionNode({
    node: input.node,
    scope: input.scope,
    cached_objects: [...(input.cached_objects ?? [])],
    cached_pages: [...(input.cached_pages ?? [])]
  });
  const records = input.records
    .filter((record) => record.scope === input.scope)
    .slice()
    .sort((a, b) => a.received_at - b.received_at || a.id.localeCompare(b.id));
  for (const record of records) installShadowStateTransfer(executionNode, record.transfer);
  const tentative = input.tentative_transcripts ?? [];
  const materialized = materializeTranscriptOverlays(executionNode, tentative);
  input.onCompose?.({
    scope: input.scope,
    ms: Date.now() - startedAt,
    transfer_count: input.records.filter((record) => record.scope === input.scope).length,
    installed_transfer_count: records.length,
    tentative_transcript_count: tentative.length,
    object_count: materialized.serialized?.objects.length ?? 0
  });
  return materialized;
}

export function createV2BrowserAcceptedWriteCellTransfer(input: {
  node: string;
  scope: ObjRef;
  records: readonly V2ExecutableTransferRecord[];
  cached_objects?: readonly SerializedObject[];
  cached_pages?: readonly ShadowStatePage[];
  transcripts: readonly EffectTranscript[];
  received_at?: number;
  accepted_head: ShadowScopeHead;
}): V2PromotedAcceptedTranscriptTransfer | null {
  const scoped = input.transcripts.filter((transcript) => transcript.scope === input.scope);
  const anchor = scoped[scoped.length - 1];
  if (!anchor) return null;
  const base = createV2BrowserExecutionNodeFromTransfers({
    node: input.node,
    scope: input.scope,
    records: input.records,
    cached_objects: input.cached_objects,
    cached_pages: input.cached_pages
  });
  const materialized = materializeTranscriptOverlays(base, scoped);
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
      recipient: input.node,
      // Accepted write cells are durable, already sequenced scope state. Use a
      // deterministic capsule timestamp so promoting the same accepted range
      // remains content-addressed even if the worker retries the promotion.
      now: ACCEPTED_WRITE_CELL_CAPSULE_NOW_MS,
      ttlMs: ACCEPTED_WRITE_CELL_CAPSULE_TTL_MS
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
