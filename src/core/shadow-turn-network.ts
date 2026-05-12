import { buildShadowCapabilityAd, rankCapabilityAdsForTurn, type ShadowCapabilityAd } from "./capability-ad";
import type { SerializedWorld } from "./repository";
import { createShadowCommitScope, type ShadowCommitScope } from "./shadow-commit-scope";
import {
  buildShadowClosureTransfer,
  buildShadowObjectRecordTransfer,
  executeShadowTurnCallOrNeedState,
  installShadowStateTransfer,
  type ShadowExecutionNode,
  type ShadowStateTransfer,
  type ShadowTurnExecRequest,
  type ShadowTurnExecutionResult
} from "./shadow-turn-exec";
import type { ObjRef } from "./types";
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
  transferMode?: "closure" | "object_records";
  maxTransfers?: number;
  commitScope?: ShadowCommitScope;
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

  const first = await executeShadowTurnCallOrNeedState(selected, input.request, { commitScope });
  let result = first;
  const transfers: ShadowStateTransfer[] = [];
  const maxTransfers = input.maxTransfers ?? 3;
  const transferMode = input.transferMode ?? "object_records";

  for (let i = 0; i < maxTransfers && !result.ok && result.reason === "missing_state"; i++) {
    const transfer = transferMode === "closure"
      ? buildShadowClosureTransfer({
          serialized: input.anchor.serialized,
          key: input.request.key,
          atom_hashes: result.missing_atoms.map((atom) => atom.hash),
          recipient: selected.node
        })
      : buildShadowObjectRecordTransfer({
          serialized: input.anchor.serialized,
          key: input.request.key,
          missing_atoms: result.missing_atoms,
          known_object_hashes: selected.object_hashes,
          session: input.request.call.session,
          recipient: selected.node
    });
    installShadowStateTransfer(selected, transfer);
    transfers.push(transfer);
    result = await executeShadowTurnCallOrNeedState(selected, input.request, { commitScope });
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
