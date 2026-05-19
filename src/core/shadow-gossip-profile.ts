import type { SerializedWorld } from "./repository";
import { utf8ByteLength } from "./source-hash";
import { buildShadowCapabilityAd, rankCapabilityAdsForTurn } from "./capability-ad";
import { createShadowCommitScope } from "./shadow-commit-scope";
import {
  buildShadowCellPageTransfer,
  createShadowExecutionNode,
  executeShadowTurnCallOrNeedState,
  installShadowStateTransfer,
  type ShadowMissingAtom,
  type ShadowStateTransfer,
  type ShadowTurnExecRequest,
  type ShadowTurnExecutionResult
} from "./shadow-turn-exec";
import type { ShadowTurnCall } from "./shadow-turn-call";
import type { ShadowCommitReceipt } from "./turn-commit";
import type { ShadowTurnKey } from "./turn-key";

export type ShadowNetworkShape =
  | "warm_actor_local"
  | "cold_actor_anchor_transfer"
  | "near_executor_remote"
  | "stale_ad_anchor_fallback";

export type ShadowProfileOptions = {
  local_exec_ms?: number;
  remote_exec_ms?: number;
  actor_anchor_rtt_ms?: number;
  actor_executor_rtt_ms?: number;
  stale_executor_rtt_ms?: number;
  transfer_bandwidth_bytes_per_ms?: number;
};

export type ShadowProfileStep = {
  kind: string;
  node?: string;
  latency_ms: number;
  bytes?: number;
  missing_atoms?: number;
};

export type ShadowNetworkProfile = {
  shape: ShadowNetworkShape;
  accepted: boolean;
  total_latency_ms: number;
  transfer_bytes: number;
  attempts: number;
  transcript_hash?: string;
  receipt?: ShadowCommitReceipt;
  steps: ShadowProfileStep[];
};

const DEFAULT_OPTIONS: Required<ShadowProfileOptions> = {
  local_exec_ms: 2,
  remote_exec_ms: 3,
  actor_anchor_rtt_ms: 80,
  actor_executor_rtt_ms: 18,
  stale_executor_rtt_ms: 24,
  transfer_bandwidth_bytes_per_ms: 200_000
};

export async function profileShadowTurnAcrossNetworkShapes(input: {
  serializedBefore: SerializedWorld;
  call: ShadowTurnCall;
  key: ShadowTurnKey;
  shapes?: ShadowNetworkShape[];
  options?: ShadowProfileOptions;
}): Promise<ShadowNetworkProfile[]> {
  const options = { ...DEFAULT_OPTIONS, ...input.options };
  const shapes = input.shapes ?? [
    "warm_actor_local",
    "cold_actor_anchor_transfer",
    "near_executor_remote",
    "stale_ad_anchor_fallback"
  ];
  const profiles: ShadowNetworkProfile[] = [];
  const request: ShadowTurnExecRequest = {
    kind: "woo.turn.exec.request.shadow.v1",
    call: input.call,
    key: input.key
  };
  for (const shape of shapes) {
    profiles.push(await profileShape(shape, input.serializedBefore, request, options));
  }
  return profiles;
}

async function profileShape(
  shape: ShadowNetworkShape,
  serializedBefore: SerializedWorld,
  request: ShadowTurnExecRequest,
  options: Required<ShadowProfileOptions>
): Promise<ShadowNetworkProfile> {
  switch (shape) {
    case "warm_actor_local":
      return await profileWarmActor(serializedBefore, request, options);
    case "cold_actor_anchor_transfer":
      return await profileColdAnchorTransfer(serializedBefore, request, options);
    case "near_executor_remote":
      return await profileNearExecutor(serializedBefore, request, options);
    case "stale_ad_anchor_fallback":
      return await profileStaleAdFallback(serializedBefore, request, options);
  }
}

async function profileWarmActor(
  serializedBefore: SerializedWorld,
  request: ShadowTurnExecRequest,
  options: Required<ShadowProfileOptions>
): Promise<ShadowNetworkProfile> {
  const key = request.key;
  const actorNode = createShadowExecutionNode({ node: "actor", scope: key.scope, atom_hashes: key.atom_hashes, serialized: serializedBefore });
  const commitScope = createShadowCommitScope({ node: "anchor", scope: key.scope, serialized: serializedBefore });
  const executed = await executeShadowTurnCallOrNeedState(actorNode, request, { commitScope });
  if (!executed.ok) return rejectedProfile("warm_actor_local", options.local_exec_ms, [{ kind: executed.reason, node: "actor", latency_ms: options.local_exec_ms }]);
  return {
    shape: "warm_actor_local",
    accepted: executed.receipt.accepted,
    total_latency_ms: options.local_exec_ms,
    transfer_bytes: 0,
    attempts: 1,
    transcript_hash: executed.transcript.hash,
    receipt: executed.receipt,
    steps: [{ kind: "local_execute", node: "actor", latency_ms: options.local_exec_ms }]
  };
}

async function profileColdAnchorTransfer(
  serializedBefore: SerializedWorld,
  request: ShadowTurnExecRequest,
  options: Required<ShadowProfileOptions>
): Promise<ShadowNetworkProfile> {
  const key = request.key;
  const actorNode = createShadowExecutionNode({ node: "actor", scope: key.scope });
  const commitScope = createShadowCommitScope({ node: "anchor", scope: key.scope, serialized: serializedBefore });
  const first = await executeShadowTurnCallOrNeedState(actorNode, request, { commitScope });
  const missing = missingAtomsFromExecutionResult(first);
  const transfer = buildShadowCellPageTransfer({
    serialized: serializedBefore,
    key,
    missing_atoms: missing,
    known_page_hashes: actorNode.page_hashes,
    session: request.call.session,
    recipient: actorNode.node
  });
  const transferBytes = estimateShadowStateTransferBytes(transfer);
  installShadowStateTransfer(actorNode, transfer);
  const retry = await executeShadowTurnCallOrNeedState(actorNode, request, { commitScope });
  const transferLatency = transferLatencyMs(options.actor_anchor_rtt_ms, transferBytes, options);
  const steps: ShadowProfileStep[] = [
    { kind: "local_missing_state", node: "actor", latency_ms: 0, missing_atoms: missing.length },
    { kind: "anchor_cell_page_transfer", node: "anchor", latency_ms: transferLatency, bytes: transferBytes },
    { kind: "local_retry_execute", node: "actor", latency_ms: options.local_exec_ms }
  ];
  if (!retry.ok) return rejectedProfile("cold_actor_anchor_transfer", sumLatency(steps), steps);
  return acceptedProfile("cold_actor_anchor_transfer", retry.receipt, retry.transcript.hash, transferBytes, 1, steps);
}

async function profileNearExecutor(
  serializedBefore: SerializedWorld,
  request: ShadowTurnExecRequest,
  options: Required<ShadowProfileOptions>
): Promise<ShadowNetworkProfile> {
  const key = request.key;
  const ad = buildShadowCapabilityAd({ node: "near-executor", scope: key.scope, atom_hashes: key.atom_hashes, factor: 0.9 });
  const selected = rankCapabilityAdsForTurn([ad], key)[0];
  const executor = createShadowExecutionNode({ node: selected.node, scope: key.scope, atom_hashes: key.atom_hashes, serialized: serializedBefore });
  const commitScope = createShadowCommitScope({ node: "anchor", scope: key.scope, serialized: serializedBefore });
  const executed = await executeShadowTurnCallOrNeedState(executor, request, { commitScope });
  const transfer = executed.ok
    ? buildShadowCellPageTransfer({ serialized: executed.serializedAfter, key, atom_hashes: key.atom_hashes, session: request.call.session })
    : null;
  const transferBytes = transfer ? estimateShadowStateTransferBytes(transfer) : 0;
  const remoteLatency = options.actor_executor_rtt_ms + options.remote_exec_ms + transferBytes / options.transfer_bandwidth_bytes_per_ms;
  const steps: ShadowProfileStep[] = [
    { kind: "ad_rank_selected", node: selected.node, latency_ms: 0 },
    { kind: "remote_execute_and_cell_page_transfer", node: selected.node, latency_ms: remoteLatency, bytes: transferBytes }
  ];
  if (!executed.ok) return rejectedProfile("near_executor_remote", sumLatency(steps), steps);
  return acceptedProfile("near_executor_remote", executed.receipt, executed.transcript.hash, transferBytes, 1, steps);
}

async function profileStaleAdFallback(
  serializedBefore: SerializedWorld,
  request: ShadowTurnExecRequest,
  options: Required<ShadowProfileOptions>
): Promise<ShadowNetworkProfile> {
  const key = request.key;
  // The ad claims coverage, but the node's atom cache is empty. This models a
  // stale ad or Bloom false positive; correctness comes from retry, not gossip.
  const staleAd = buildShadowCapabilityAd({ node: "stale-executor", scope: key.scope, atom_hashes: key.atom_hashes, factor: 0.95 });
  const selected = rankCapabilityAdsForTurn([staleAd], key)[0];
  const staleNode = createShadowExecutionNode({ node: selected.node, scope: key.scope });
  const commitScope = createShadowCommitScope({ node: "anchor", scope: key.scope, serialized: serializedBefore });
  const staleAttempt = await executeShadowTurnCallOrNeedState(staleNode, request, { commitScope });
  const actorNode = createShadowExecutionNode({ node: "actor", scope: key.scope });
  const missing = missingAtomsFromExecutionResult(staleAttempt);
  const transfer = buildShadowCellPageTransfer({
    serialized: serializedBefore,
    key,
    missing_atoms: missing,
    known_page_hashes: actorNode.page_hashes,
    session: request.call.session,
    recipient: actorNode.node
  });
  const transferBytes = estimateShadowStateTransferBytes(transfer);
  installShadowStateTransfer(actorNode, transfer);
  const retry = await executeShadowTurnCallOrNeedState(actorNode, request, { commitScope });
  const transferLatency = transferLatencyMs(options.actor_anchor_rtt_ms, transferBytes, options);
  const steps: ShadowProfileStep[] = [
    { kind: "ad_rank_selected", node: selected.node, latency_ms: 0 },
    { kind: "remote_missing_state", node: selected.node, latency_ms: options.stale_executor_rtt_ms, missing_atoms: missing.length },
    { kind: "anchor_cell_page_transfer", node: "anchor", latency_ms: transferLatency, bytes: transferBytes },
    { kind: "local_retry_execute", node: "actor", latency_ms: options.local_exec_ms }
  ];
  if (!retry.ok) return rejectedProfile("stale_ad_anchor_fallback", sumLatency(steps), steps);
  return acceptedProfile("stale_ad_anchor_fallback", retry.receipt, retry.transcript.hash, transferBytes, 2, steps);
}

function acceptedProfile(
  shape: ShadowNetworkShape,
  receipt: ShadowCommitReceipt,
  transcriptHash: string,
  transferBytes: number,
  attempts: number,
  steps: ShadowProfileStep[]
): ShadowNetworkProfile {
  return {
    shape,
    accepted: receipt.accepted,
    total_latency_ms: roundLatency(sumLatency(steps)),
    transfer_bytes: transferBytes,
    attempts,
    transcript_hash: transcriptHash,
    receipt,
    steps
  };
}

function rejectedProfile(shape: ShadowNetworkShape, totalLatencyMs: number, steps: ShadowProfileStep[]): ShadowNetworkProfile {
  return {
    shape,
    accepted: false,
    total_latency_ms: roundLatency(totalLatencyMs),
    transfer_bytes: steps.reduce((sum, step) => sum + (step.bytes ?? 0), 0),
    attempts: steps.filter((step) => step.kind.includes("execute") || step.kind.includes("missing_state")).length,
    steps
  };
}

export function estimateShadowTransferBytes(serialized: SerializedWorld): number {
  return utf8ByteLength(JSON.stringify(serialized));
}

export function estimateShadowStateTransferBytes(transfer: ShadowStateTransfer): number {
  return utf8ByteLength(JSON.stringify(transfer));
}

function missingAtomsFromExecutionResult(result: ShadowTurnExecutionResult): ShadowMissingAtom[] {
  return !result.ok && result.reason === "missing_state" ? result.missing_atoms : [];
}

function transferLatencyMs(rttMs: number, bytes: number, options: Required<ShadowProfileOptions>): number {
  return rttMs + bytes / options.transfer_bandwidth_bytes_per_ms;
}

function sumLatency(steps: ShadowProfileStep[]): number {
  return steps.reduce((sum, step) => sum + step.latency_ms, 0);
}

function roundLatency(value: number): number {
  return Math.round(value * 1000) / 1000;
}
