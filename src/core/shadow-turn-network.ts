import { buildShadowCapabilityAd, rankCapabilityAdsForTurn, type ShadowCapabilityAd } from "./capability-ad";
import type { SerializedWorld } from "./repository";
import { createShadowCommitScope, serializedFor, type ShadowCommitScope } from "./shadow-commit-scope";
import {
  buildShadowCellPageTransfer,
  buildShadowClosureTransfer,
  buildShadowObjectRecordTransfer,
  executeShadowTurnCallOrNeedState,
  installShadowStateTransfer,
  type ShadowExecutionNode,
  type ShadowStateTransfer,
  type ShadowTurnExecRequest,
  type ShadowTurnExecutionResult
} from "./shadow-turn-exec";
import type { MetricEvent, ObjRef } from "./types";
import type { ShadowTurnKey } from "./turn-key";

export type ShadowInProcessNetworkResult = {
  selected_node: string;
  first: ShadowTurnExecutionResult;
  transfer?: ShadowStateTransfer;
  transfers: ShadowStateTransfer[];
  result: ShadowTurnExecutionResult;
};

export function buildShadowTurnExecAd(input: {
  node: string;
  scope: ObjRef;
  key: ShadowTurnKey;
  factor?: number;
}): ShadowCapabilityAd {
  return buildShadowCapabilityAd({
    node: input.node,
    scope: input.scope,
    atom_hashes: input.key.atom_hashes,
    accepts_atom_hashes: input.key.accept_atom_hashes,
    factor: input.factor
  });
}

export function buildShadowScopeTurnExecAd(input: {
  node: string;
  scope: ObjRef;
  epoch?: string;
  factor?: number;
}): ShadowCapabilityAd {
  return buildShadowCapabilityAd({
    node: input.node,
    scope: input.scope,
    epoch: input.epoch,
    atom_hashes: [],
    accepts_atom_hashes: [],
    factor: input.factor
  });
}

export function buildShadowTurnExecAdFromNode(input: {
  node: ShadowExecutionNode;
  accepts: ShadowTurnKey;
  factor?: number;
}): ShadowCapabilityAd {
  return buildShadowCapabilityAd({
    node: input.node.node,
    scope: input.node.scope,
    atom_hashes: Array.from(input.node.atom_hashes).sort(),
    accepts_atom_hashes: input.accepts.accept_atom_hashes,
    factor: input.factor
  });
}

export async function executeShadowTurnCallAcrossInProcessNetwork(input: {
  request: ShadowTurnExecRequest;
  nodes: ShadowExecutionNode[];
  ads: ShadowCapabilityAd[];
  anchor: {
    node: string;
    serialized: SerializedWorld;
  };
  transferMode?: "closure" | "object_records" | "cell_pages";
  maxTransfers?: number;
  maxStaleHeadRetries?: number;
  commitScope?: ShadowCommitScope;
  profile?: (event: MetricEvent & { kind: "shadow_apply_step" }) => void;
  metric?: (event: MetricEvent) => void;
}): Promise<ShadowInProcessNetworkResult> {
  const ranked = rankCapabilityAdsForTurn(input.ads, input.request.key);
  const selectedAd = ranked[0];
  if (!selectedAd) throw new Error("no shadow executor ad covers requested turn");
  const selected = input.nodes.find((node) => node.node === selectedAd.node);
  if (!selected) throw new Error(`shadow executor not registered: ${selectedAd.node}`);
  const commitScope = input.commitScope ?? createShadowCommitScope({
    node: input.anchor.node,
    scope: input.request.key.scope,
    serialized: input.anchor.serialized
  });

  // `request.expected` is the browser's optimistic concurrency token. When two
  // browsers race a commit on the same scope, the loser sees stale_head; for an
  // authoritative executor that has the post-winning-commit state in serialized,
  // re-running the verb against the new head is the correct convergence — the
  // browser's `key` was a planning artifact and `request.id` keeps idempotency.
  // Cloning the request lets us bump `expected` per retry without mutating the
  // caller's input.
  let activeRequest: ShadowTurnExecRequest = input.request;
  const first = await executeShadowTurnCallOrNeedState(selected, activeRequest, { commitScope, profile: input.profile, metric: input.metric });
  let result = first;
  const transfers: ShadowStateTransfer[] = [];
  const maxTransfers = input.maxTransfers ?? 3;
  const maxStaleHeadRetries = input.maxStaleHeadRetries ?? 3;
  const transferMode = input.transferMode ?? "cell_pages";

  let missingStateRounds = 0;
  let staleHeadRounds = 0;
  while (!result.ok) {
    if (result.reason === "missing_state") {
      if (missingStateRounds >= maxTransfers) break;
      missingStateRounds += 1;
      const missingAtoms = result.missing_atoms;
      const transfer = transferMode === "closure"
        ? buildShadowClosureTransfer({
            serialized: input.anchor.serialized,
            key: activeRequest.key,
            atom_hashes: missingAtoms.map((atom) => atom.hash),
            recipient: selected.node
          })
        : transferMode === "object_records"
          ? buildShadowObjectRecordTransfer({
            serialized: input.anchor.serialized,
            key: activeRequest.key,
            missing_atoms: missingAtoms,
            known_object_hashes: selected.object_hashes,
            session: activeRequest.call.session,
            recipient: selected.node
          })
          : buildShadowCellPageTransfer({
            serialized: input.anchor.serialized,
            key: activeRequest.key,
            missing_atoms: missingAtoms,
            known_page_hashes: selected.page_hashes,
            session: activeRequest.call.session,
            recipient: selected.node
          });
      if (shadowTransferServesNoAtoms(transfer)) break;
      installShadowStateTransfer(selected, transfer);
      transfers.push(transfer);
    } else if (result.reason === "commit_rejected" && result.commit?.reason === "stale_head") {
      // Stale-head retry is only safe when the executor owns the full
      // authoritative scope state. For a selected/gossiped executor whose
      // serialized is a verified partial shard advertised by an `ExecCapabilityAd`,
      // mutating `selected.serialized` from the relay's commit-scope would
      // silently overwrite the executor's owned cache and violate the
      // selected-ad asymmetry — the executor is supposed to prove coverage by
      // executing or returning `missing_state`, not to inherit relay state.
      // Bail in that case and surface the stale-head conflict to the caller,
      // which can re-plan against a fresh head if it wants to retry.
      if (selected.authoritative_state !== true) break;
      if (staleHeadRounds >= maxStaleHeadRetries) break;
      staleHeadRounds += 1;
      // Update `expected` AND resync the executor's serialized snapshot to the
      // current commit-scope authority. Concurrent requests each snapshot the
      // pre-race state when their executor is created, so after the winner's
      // commit the loser's executor still carries pre-race cell versions — a
      // re-run on stale serialized would just produce another transcript with
      // the same (now-pre-state-mismatched) reads.
      selected.serialized = serializedFor(commitScope, { reason: "stale_head_retry" });
      selected.world = undefined;
      activeRequest = { ...activeRequest, expected: commitScope.head };
    } else {
      break;
    }
    result = await executeShadowTurnCallOrNeedState(selected, activeRequest, { commitScope, profile: input.profile, metric: input.metric });
  }

  if (transfers.length === 0) {
    return {
      selected_node: selected.node,
      first,
      transfers,
      result
    };
  }

  return {
    selected_node: selected.node,
    first,
    transfer: transfers[0],
    transfers,
    result
  };
}

function shadowTransferServesNoAtoms(transfer: ShadowStateTransfer): boolean {
  if (transfer.atom_hashes.length > 0) return false;
  if (transfer.mode === "cell_pages") return transfer.page_refs.length === 0 && transfer.inline_pages.length === 0;
  if (transfer.mode === "object_records") return transfer.object_pages.length === 0 && transfer.objects.length === 0;
  return false;
}
