import type { SerializedWorld } from "./repository";
import type { AppliedFrame, DirectResultFrame, ErrorFrame, ObjRef } from "./types";
import { effectTranscriptFromRecordedTurn, type EffectTranscript } from "./effect-transcript";
import { shadowCommitReceipt, type ShadowCommitReceipt } from "./turn-commit";
import { replayRecordedTurn } from "./turn-replay";
import type { RecordedTurn } from "./turn-recorder";
import type { ShadowTurnKey } from "./turn-key";

export type ShadowMissingAtom = {
  hash: string;
  preimage?: string;
};

export type ShadowStateTransfer = {
  kind: "woo.state.transfer.shadow.v1";
  mode: "closure";
  scope: ObjRef;
  atom_hashes: string[];
  preimages?: string[];
  serialized: SerializedWorld;
};

export type ShadowExecutionNode = {
  kind: "woo.execution_node.shadow.v1";
  node: string;
  scope: ObjRef;
  atom_hashes: Set<string>;
  serialized?: SerializedWorld;
};

export type ShadowTurnExecutionResult =
  | {
      ok: false;
      reason: "missing_state";
      attempted: false;
      missing_atoms: ShadowMissingAtom[];
    }
  | {
      ok: false;
      reason: "commit_rejected";
      attempted: true;
      transcript: EffectTranscript;
      receipt: ShadowCommitReceipt;
      frame: AppliedFrame | DirectResultFrame | ErrorFrame;
    }
  | {
      ok: true;
      attempted: true;
      transcript: EffectTranscript;
      receipt: ShadowCommitReceipt;
      frame: AppliedFrame | DirectResultFrame | ErrorFrame;
      serializedAfter: SerializedWorld;
    };

export function createShadowExecutionNode(input: {
  node: string;
  scope: ObjRef;
  atom_hashes?: string[];
  serialized?: SerializedWorld;
}): ShadowExecutionNode {
  return {
    kind: "woo.execution_node.shadow.v1",
    node: input.node,
    scope: input.scope,
    atom_hashes: new Set(input.atom_hashes ?? []),
    serialized: input.serialized ? structuredClone(input.serialized) as SerializedWorld : undefined
  };
}

export function missingAtomsForShadowTurn(node: ShadowExecutionNode, key: ShadowTurnKey): ShadowMissingAtom[] {
  if (node.scope !== key.scope) {
    return key.atom_hashes.map((hash, index) => ({ hash, preimage: key.preimages[index] }));
  }
  const missing: ShadowMissingAtom[] = [];
  for (let i = 0; i < key.atom_hashes.length; i++) {
    const hash = key.atom_hashes[i];
    if (!node.atom_hashes.has(hash)) missing.push({ hash, preimage: key.preimages[i] });
  }
  return missing;
}

export function buildShadowClosureTransfer(input: {
  serialized: SerializedWorld;
  key: ShadowTurnKey;
  atom_hashes?: string[];
}): ShadowStateTransfer {
  const requested = new Set(input.atom_hashes ?? input.key.atom_hashes);
  const preimages = input.key.preimages.filter((_, index) => requested.has(input.key.atom_hashes[index]));
  return {
    kind: "woo.state.transfer.shadow.v1",
    mode: "closure",
    scope: input.key.scope,
    atom_hashes: input.key.atom_hashes.filter((hash) => requested.has(hash)),
    preimages,
    // Shadow transfer intentionally moves a full serialized pre-turn world.
    // Later state-plane work can replace this with page-level closure export.
    serialized: structuredClone(input.serialized) as SerializedWorld
  };
}

export function installShadowStateTransfer(node: ShadowExecutionNode, transfer: ShadowStateTransfer): void {
  if (node.scope !== transfer.scope) throw new Error(`state transfer scope mismatch: node=${node.scope} transfer=${transfer.scope}`);
  for (const hash of transfer.atom_hashes) node.atom_hashes.add(hash);
  node.serialized = structuredClone(transfer.serialized) as SerializedWorld;
}

export async function executeShadowRecordedTurnOrNeedState(
  node: ShadowExecutionNode,
  turn: RecordedTurn,
  key: ShadowTurnKey
): Promise<ShadowTurnExecutionResult> {
  const missing = missingAtomsForShadowTurn(node, key);
  if (missing.length > 0 || !node.serialized) {
    return {
      ok: false,
      reason: "missing_state",
      attempted: false,
      missing_atoms: missing.length > 0 ? missing : key.atom_hashes.map((hash, index) => ({ hash, preimage: key.preimages[index] }))
    };
  }

  const serializedBefore = structuredClone(node.serialized) as SerializedWorld;
  const replay = await replayRecordedTurn(serializedBefore, turn);
  const transcript = effectTranscriptFromRecordedTurn(replay.recorded);
  const receipt = shadowCommitReceipt(serializedBefore, replay.serializedAfter, transcript);
  if (!receipt.accepted) {
    return {
      ok: false,
      reason: "commit_rejected",
      attempted: true,
      frame: replay.frame,
      transcript,
      receipt
    };
  }

  node.serialized = structuredClone(replay.serializedAfter) as SerializedWorld;
  for (const hash of key.atom_hashes) node.atom_hashes.add(hash);
  return {
    ok: true,
    attempted: true,
    frame: replay.frame,
    transcript,
    receipt,
    serializedAfter: replay.serializedAfter
  };
}
