import { createShadowExecutionNode, installShadowStateTransfer, type ShadowExecutionNode, type ShadowStateTransfer } from "../core/shadow-turn-exec";
import { stableShadowJson } from "../core/shadow-cell-version";
import type { SerializedObject } from "../core/repository";
import type { ShadowStatePage } from "../core/shadow-state-pages";
import { hashSource } from "../core/source-hash";
import type { ObjRef, WooValue } from "../core/types";

export type V2ExecutableTransferRecord = {
  id: string;
  scope: ObjRef;
  mode: ShadowStateTransfer["mode"];
  transfer: ShadowStateTransfer;
  received_at: number;
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
}): ShadowExecutionNode {
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
  return executionNode;
}
