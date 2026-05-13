import type {
  ParkedTaskRecord,
  SerializedObject,
  SerializedSession,
  SerializedWorld,
  SpaceSnapshotRecord
} from "./repository";
import type { AppliedFrame, DirectResultFrame, ErrorFrame, ObjRef, WooValue } from "./types";
import { effectTranscriptFromRecordedTurn, type EffectTranscript } from "./effect-transcript";
import { shadowCommitReceipt, type ShadowCommitReceipt } from "./turn-commit";
import { replayRecordedTurn } from "./turn-replay";
import type { RecordedTurn } from "./turn-recorder";
import { shadowTurnKeyFromTranscript, type ShadowTurnKey } from "./turn-key";
import { runShadowTurnCallOnWorld, type ShadowTurnCall } from "./shadow-turn-call";
import {
  submitShadowCommit,
  type ShadowCommitAccepted,
  type ShadowCommitAcceptedWire,
  type ShadowCommitConflict,
  type ShadowCommitScope,
  type ShadowScopeHead
} from "./shadow-commit-scope";
import { constantTimeEqual, hashSource } from "./source-hash";
import { stableShadowJson } from "./shadow-cell-version";
import { createWorldFromSerialized } from "./bootstrap";
import type { WooWorld } from "./world";

const DEFAULT_SHADOW_TRANSFER_AUTHORITY = "shadow-anchor";
const DEFAULT_SHADOW_TRANSFER_KEY_ID = "shadow-dev";
const DEFAULT_SHADOW_TRANSFER_SECRET = "shadow-dev-secret";

export type ShadowMissingAtom = {
  hash: string;
  preimage?: string;
};

export type ShadowClosureTransfer = {
  kind: "woo.state.transfer.shadow.v1";
  mode: "closure";
  scope: ObjRef;
  atom_hashes: string[];
  preimages?: string[];
  serialized: SerializedWorld;
  proof: ShadowStateProof;
};

export type ShadowObjectRecordTransfer = {
  kind: "woo.state.transfer.shadow.v1";
  mode: "object_records";
  scope: ObjRef;
  atom_hashes: string[];
  preimages?: string[];
  object_pages: ShadowObjectPageRef[];
  objects: SerializedObject[];
  sessions: SerializedSession[];
  logs: SerializedWorld["logs"];
  snapshots: SpaceSnapshotRecord[];
  parkedTasks: ParkedTaskRecord[];
  tombstones: ObjRef[];
  counters: Pick<SerializedWorld, "objectCounter" | "parkedTaskCounter" | "sessionCounter">;
  source_object_count: number;
  proof: ShadowStateProof;
};

export type ShadowObjectPageRef = {
  id: ObjRef;
  hash: string;
  bytes: number;
  inline: boolean;
};

export type ShadowStateProof = {
  kind: "woo.state_proof.shadow.v1";
  scheme: "shadow.anchor_mac.v1";
  authority: string;
  key_id: string;
  recipient: string;
  scope: ObjRef;
  mode: ShadowStateTransferMode;
  root: string;
  signature: string;
};

export type ShadowStateTransferMode = "closure" | "object_records";

export type ShadowTransferSigning = {
  authority?: string;
  key_id?: string;
  secret?: string;
  recipient?: string;
};

export type ShadowStateTransfer = ShadowClosureTransfer | ShadowObjectRecordTransfer;

export type ShadowExecutionNode = {
  kind: "woo.execution_node.shadow.v1";
  node: string;
  scope: ObjRef;
  atom_hashes: Set<string>;
  object_hashes: Set<string>;
  object_cache: Map<string, SerializedObject>;
  trusted_transfer_authorities: Map<string, string>;
  serialized?: SerializedWorld;
  world?: WooWorld;
};

export type ShadowTurnExecutionResult =
  | {
      ok: false;
      reason: "missing_state";
      attempted: boolean;
      missing_atoms: ShadowMissingAtom[];
      transcript?: EffectTranscript;
      frame?: AppliedFrame | DirectResultFrame | ErrorFrame;
      reply?: ShadowTurnExecReply;
    }
  | {
      ok: false;
      reason: "commit_rejected";
      attempted: true;
      transcript: EffectTranscript;
      receipt: ShadowCommitReceipt;
      commit?: ShadowCommitConflict;
      frame: AppliedFrame | DirectResultFrame | ErrorFrame;
      reply?: ShadowTurnExecReply;
    }
  | {
      ok: true;
      attempted: true;
      transcript: EffectTranscript;
      receipt: ShadowCommitReceipt;
      commit?: ShadowCommitAccepted;
      frame: AppliedFrame | DirectResultFrame | ErrorFrame;
      serializedAfter: SerializedWorld;
      reply?: ShadowTurnExecReply;
    };

export type ShadowTurnExecRequest = {
  kind: "woo.turn.exec.request.shadow.v1";
  id?: string;
  call: ShadowTurnCall;
  key: ShadowTurnKey;
  expected?: ShadowScopeHead;
  auth?: {
    mode: "shadow_local";
    actor: ObjRef;
    session?: string | null;
  };
  selected_ad?: string;
  requested_transfer?: {
    mode: "closure" | "object_records";
    atom_hashes?: string[];
    max_bytes?: number;
  };
  max_transfer_bytes?: number;
  commit_policy?: "execute_and_commit" | "execute_only";
};

export type ShadowTurnExecReply =
  | {
      kind: "woo.turn.exec.reply.shadow.v1";
      ok: true;
      id?: string;
      outcome: { result?: WooValue; error?: WooValue };
      transcript: EffectTranscript;
      commit?: ShadowCommitAccepted | ShadowCommitAcceptedWire;
    }
  | {
      kind: "woo.turn.exec.reply.shadow.v1";
      ok: false;
      id?: string;
      reason: "missing_state" | "commit_rejected";
      missing_atoms?: ShadowMissingAtom[];
      transcript?: EffectTranscript;
      commit?: ShadowCommitConflict;
    };

export type ShadowTurnExecutionOptions = {
  commitScope?: ShadowCommitScope;
};

export function createShadowExecutionNode(input: {
  node: string;
  scope: ObjRef;
  atom_hashes?: string[];
  object_hashes?: string[];
  cached_objects?: SerializedObject[];
  trusted_transfer_authorities?: Record<string, string>;
  serialized?: SerializedWorld;
}): ShadowExecutionNode {
  let serialized = input.serialized ? structuredClone(input.serialized) as SerializedWorld : undefined;
  const objectCache = new Map<string, SerializedObject>();
  for (const obj of serialized?.objects ?? []) cacheShadowObjectRecord(objectCache, obj);
  const cachedObjects = input.cached_objects ?? [];
  for (const obj of cachedObjects) cacheShadowObjectRecord(objectCache, obj);
  if (cachedObjects.length > 0) serialized = mergeCachedObjectRecords(serialized, cachedObjects);
  return {
    kind: "woo.execution_node.shadow.v1",
    node: input.node,
    scope: input.scope,
    atom_hashes: new Set(input.atom_hashes ?? []),
    object_hashes: new Set(input.object_hashes ?? objectCache.keys()),
    object_cache: objectCache,
    trusted_transfer_authorities: trustedTransferAuthorities(input.trusted_transfer_authorities),
    serialized
  };
}

export function installShadowCachedObjectRecords(node: ShadowExecutionNode, objects: SerializedObject[]): void {
  for (const obj of objects) cacheShadowObjectRecord(node.object_cache, obj);
  if (objects.length > 0) node.serialized = mergeCachedObjectRecords(node.serialized, objects);
  refreshNodeObjectHashes(node);
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
} & ShadowTransferSigning): ShadowClosureTransfer {
  const requested = new Set(input.atom_hashes ?? input.key.atom_hashes);
  const preimages = input.key.preimages.filter((_, index) => requested.has(input.key.atom_hashes[index]));
  const transfer = {
    kind: "woo.state.transfer.shadow.v1",
    mode: "closure",
    scope: input.key.scope,
    atom_hashes: input.key.atom_hashes.filter((hash) => requested.has(hash)),
    preimages,
    // Shadow transfer intentionally moves a full serialized pre-turn world.
    // Later state-plane work can replace this with page-level closure export.
    serialized: structuredClone(input.serialized) as SerializedWorld
  } satisfies Omit<ShadowClosureTransfer, "proof">;
  return {
    ...transfer,
    proof: signShadowStateTransfer(transfer, input)
  };
}

export function buildShadowObjectRecordTransfer(input: {
  serialized: SerializedWorld;
  key: ShadowTurnKey;
  atom_hashes?: string[];
  missing_atoms?: ShadowMissingAtom[];
  known_object_hashes?: Iterable<string>;
  session?: string | null;
} & ShadowTransferSigning): ShadowObjectRecordTransfer {
  const selected = selectedTransferAtoms(input.key, input.atom_hashes, input.missing_atoms);
  const objectIds = objectClosureForPreimages(input.serialized, selected.map((item) => item.preimage));
  const requiredObjects = input.serialized.objects
    .filter((obj) => objectIds.has(obj.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const knownObjectHashes = new Set(input.known_object_hashes ?? []);
  const objectPages = requiredObjects.map((obj) => {
    const hash = shadowObjectRecordHash(obj);
    return {
      id: obj.id,
      hash,
      bytes: Buffer.byteLength(stableShadowJson(obj as unknown as WooValue), "utf8"),
      inline: !knownObjectHashes.has(hash)
    };
  });
  const inlineObjects = requiredObjects
    .filter((obj, index) => objectPages[index]?.inline === true)
    .map((obj) => structuredClone(obj) as SerializedObject);
  const sessions = input.serialized.sessions
    .filter((session) => session.id === input.session || session.actor === input.key.actor)
    .map((session) => structuredClone(session) as SerializedSession)
    .sort((a, b) => a.id.localeCompare(b.id));
  const logs = input.serialized.logs
    .filter(([space]) => space === input.key.scope)
    .map(([space, entries]) => [space, structuredClone(entries) as SerializedWorld["logs"][number][1]] as SerializedWorld["logs"][number]);
  const snapshots = input.serialized.snapshots
    .filter((snapshot) => snapshot.space_id === input.key.scope)
    .map((snapshot) => structuredClone(snapshot) as SpaceSnapshotRecord);
  const transfer = {
    kind: "woo.state.transfer.shadow.v1",
    mode: "object_records",
    scope: input.key.scope,
    atom_hashes: selected.map((item) => item.hash),
    preimages: selected.map((item) => item.preimage),
    object_pages: objectPages,
    objects: inlineObjects,
    sessions,
    logs,
    snapshots,
    parkedTasks: [],
    tombstones: [...(input.serialized.tombstones ?? [])].sort(),
    counters: {
      objectCounter: input.serialized.objectCounter,
      parkedTaskCounter: input.serialized.parkedTaskCounter,
      sessionCounter: input.serialized.sessionCounter
    },
    source_object_count: input.serialized.objects.length
  } satisfies Omit<ShadowObjectRecordTransfer, "proof">;
  return {
    ...transfer,
    proof: signShadowStateTransfer(transfer, input)
  };
}

export function installShadowStateTransfer(node: ShadowExecutionNode, transfer: ShadowStateTransfer): void {
  if (transfer.mode === "closure" && node.scope !== transfer.scope) {
    throw new Error(`state transfer scope mismatch: node=${node.scope} transfer=${transfer.scope}`);
  }
  // Object-record transfers are content-addressed pages for whatever atom was
  // missing during retry. Their proof still binds transfer.scope, but the
  // receiving execution node may be installing dependency pages such as catalog
  // or base-object records whose atom scope differs from the node's commit
  // scope.
  verifyShadowStateTransferProof(node, transfer);
  for (const hash of transfer.atom_hashes) node.atom_hashes.add(hash);
  if (transfer.mode === "closure") {
    node.serialized = structuredClone(transfer.serialized) as SerializedWorld;
    node.world = undefined;
    for (const obj of node.serialized.objects) cacheShadowObjectRecord(node.object_cache, obj);
    refreshNodeObjectHashes(node);
    return;
  }
  node.serialized = mergeObjectRecordTransfer(node.serialized, transfer, node.object_cache);
  node.world = undefined;
  for (const obj of node.serialized.objects) cacheShadowObjectRecord(node.object_cache, obj);
  refreshNodeObjectHashes(node);
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
  for (const obj of node.serialized.objects) cacheShadowObjectRecord(node.object_cache, obj);
  refreshNodeObjectHashes(node);
  return {
    ok: true,
    attempted: true,
    frame: replay.frame,
    transcript,
    receipt,
    serializedAfter: replay.serializedAfter
  };
}

export async function executeShadowTurnCallOrNeedState(
  node: ShadowExecutionNode,
  request: ShadowTurnExecRequest,
  options: ShadowTurnExecutionOptions = {}
): Promise<ShadowTurnExecutionResult> {
  const missing = missingAtomsForShadowTurn(node, request.key);
  if (missing.length > 0 || !node.serialized) {
    const missingAtoms = missing.length > 0
      ? missing
      : request.key.atom_hashes.map((hash, index) => ({ hash, preimage: request.key.preimages[index] }));
    return {
      ok: false,
      reason: "missing_state",
      attempted: false,
      missing_atoms: missingAtoms,
      reply: missingStateReply(request, missingAtoms)
    };
  }

  const serializedBefore = node.serialized;
  const world = shadowExecutionWorld(node);
  let run: Awaited<ReturnType<typeof runShadowTurnCallOnWorld>>;
  try {
    run = await runShadowTurnCallOnWorld(world, request.call, {
      allowed_atom_hashes: node.atom_hashes
    });
  } catch (err) {
    // A cached executor world is authoritative only after a successful turn.
    // If VM execution throws outside the normal ErrorFrame path, discard the
    // mutable cache and rebuild from node.serialized on the next attempt.
    node.world = undefined;
    throw err;
  }
  const needState = missingAtomsFromNeedStateTranscript(run.transcript);
  if (needState.length > 0) {
    node.world = undefined;
    return {
      ok: false,
      reason: "missing_state",
      attempted: true,
      missing_atoms: needState,
      frame: run.frame,
      transcript: run.transcript,
      reply: missingStateReply(request, needState, run.transcript)
    };
  }
  const actualKey = shadowTurnKeyFromTranscript(run.transcript);
  const unmaterialized = missingActualAtoms(actualKey, node.atom_hashes);
  if (unmaterialized.length > 0) {
    node.world = undefined;
    return {
      ok: false,
      reason: "missing_state",
      attempted: true,
      missing_atoms: unmaterialized,
      frame: run.frame,
      transcript: run.transcript,
      reply: missingStateReply(request, unmaterialized, run.transcript)
    };
  }

  const commit = options.commitScope && request.commit_policy !== "execute_only"
    ? submitShadowCommit(options.commitScope, {
        kind: "woo.commit.submit.shadow.v1",
        id: request.id ?? request.call.id,
        scope: request.key.scope,
        expected: request.expected ?? options.commitScope.head,
        transcript: run.transcript,
        executor: node.node
      })
    : null;
  const receipt = commit
    ? commit.receipt
    : shadowCommitReceipt(serializedBefore, run.serializedAfter, run.transcript);
  if (!receipt.accepted) {
    node.world = undefined;
    const conflict = commit?.kind === "woo.commit.conflict.shadow.v1" ? commit : undefined;
    return {
      ok: false,
      reason: "commit_rejected",
      attempted: true,
      frame: run.frame,
      transcript: run.transcript,
      receipt,
      commit: conflict,
      reply: commitRejectedReply(request, run.transcript, conflict)
    };
  }

  const serializedAfter = commit?.kind === "woo.commit.accepted.shadow.v1"
    ? options.commitScope?.serialized ?? run.serializedAfter
    : run.serializedAfter;
  node.serialized = structuredClone(serializedAfter) as SerializedWorld;
  for (const hash of actualKey.atom_hashes) node.atom_hashes.add(hash);
  for (const obj of node.serialized.objects) cacheShadowObjectRecord(node.object_cache, obj);
  refreshNodeObjectHashes(node);
  return {
    ok: true,
    attempted: true,
    frame: run.frame,
    transcript: run.transcript,
    receipt,
    commit: commit?.kind === "woo.commit.accepted.shadow.v1" ? commit : undefined,
    serializedAfter,
    reply: successReply(request, run.transcript, commit?.kind === "woo.commit.accepted.shadow.v1" ? commit : undefined)
  };
}

function shadowExecutionWorld(node: ShadowExecutionNode): WooWorld {
  if (!node.serialized) throw new Error(`shadow executor has no serialized state: ${node.node}`);
  if (!node.world) node.world = createWorldFromSerialized(node.serialized, { persist: false });
  return node.world;
}

export function shadowObjectRecordHash(obj: SerializedObject): string {
  return hashSource(stableShadowJson(obj as unknown as WooValue));
}

function selectedTransferAtoms(
  key: ShadowTurnKey,
  atomHashes: string[] | undefined,
  missingAtoms: ShadowMissingAtom[] | undefined
): Array<{ hash: string; preimage: string }> {
  if (missingAtoms) {
    return missingAtoms
      .filter((atom): atom is { hash: string; preimage: string } => typeof atom.preimage === "string")
      .sort((a, b) => a.hash.localeCompare(b.hash));
  }
  const requested = new Set(atomHashes ?? key.atom_hashes);
  return key.preimages
    .map((preimage, index) => ({ preimage, hash: key.atom_hashes[index] }))
    .filter((item) => requested.has(item.hash));
}

function trustedTransferAuthorities(input: Record<string, string> | undefined): Map<string, string> {
  return new Map(Object.entries(input ?? { [DEFAULT_SHADOW_TRANSFER_AUTHORITY]: DEFAULT_SHADOW_TRANSFER_SECRET }));
}

type UnsignedShadowStateTransfer =
  | Omit<ShadowClosureTransfer, "proof">
  | Omit<ShadowObjectRecordTransfer, "proof">;

function signShadowStateTransfer(
  transfer: UnsignedShadowStateTransfer,
  signing: ShadowTransferSigning
): ShadowStateProof {
  const authority = signing.authority ?? DEFAULT_SHADOW_TRANSFER_AUTHORITY;
  const keyId = signing.key_id ?? DEFAULT_SHADOW_TRANSFER_KEY_ID;
  const recipient = signing.recipient ?? "*";
  const root = shadowStateTransferRoot(transfer, { authority, key_id: keyId, recipient });
  return {
    kind: "woo.state_proof.shadow.v1",
    scheme: "shadow.anchor_mac.v1",
    authority,
    key_id: keyId,
    recipient,
    scope: transfer.scope,
    mode: transfer.mode,
    root,
    signature: shadowTransferSignature(root, signing.secret ?? DEFAULT_SHADOW_TRANSFER_SECRET)
  };
}

function verifyShadowStateTransferProof(node: ShadowExecutionNode, transfer: ShadowStateTransfer): void {
  const proof = transfer.proof;
  if (proof.scope !== transfer.scope || proof.mode !== transfer.mode) {
    throw new Error("shadow state proof scope/mode mismatch");
  }
  if (proof.recipient !== "*" && proof.recipient !== node.node) {
    throw new Error(`shadow state proof recipient mismatch: proof=${proof.recipient} node=${node.node}`);
  }
  const secret = node.trusted_transfer_authorities.get(proof.authority);
  if (!secret) throw new Error(`untrusted shadow state authority: ${proof.authority}`);
  const root = shadowStateTransferRoot(transfer, proof);
  if (!constantTimeEqual(root, proof.root)) throw new Error("shadow state proof root mismatch");
  const signature = shadowTransferSignature(root, secret);
  if (!constantTimeEqual(signature, proof.signature)) throw new Error("shadow state proof signature mismatch");
}

function shadowStateTransferRoot(
  transfer: UnsignedShadowStateTransfer | ShadowStateTransfer,
  proof: Pick<ShadowStateProof, "authority" | "key_id" | "recipient">
): string {
  const base = {
    kind: "woo.state_proof_material.shadow.v1",
    authority: proof.authority,
    key_id: proof.key_id,
    recipient: proof.recipient,
    scope: transfer.scope,
    mode: transfer.mode,
    atom_hashes: transfer.atom_hashes,
    preimages: transfer.preimages ?? []
  };
  const material = transfer.mode === "closure"
    ? {
        ...base,
        serialized_hash: hashSource(stableShadowJson(transfer.serialized as unknown as WooValue))
      }
    : {
        ...base,
        object_pages: transfer.object_pages,
        sessions: transfer.sessions,
        logs: transfer.logs,
        snapshots: transfer.snapshots,
        parkedTasks: transfer.parkedTasks,
        tombstones: transfer.tombstones,
        counters: transfer.counters,
        source_object_count: transfer.source_object_count
      };
  return hashSource(stableShadowJson(material as unknown as WooValue));
}

function shadowTransferSignature(root: string, secret: string): string {
  return hashSource(`shadow.anchor_mac.v1:${secret}:${root}`);
}

function serializedObjectHashes(serialized: SerializedWorld | undefined): string[] {
  return serialized?.objects.map((obj) => shadowObjectRecordHash(obj)) ?? [];
}

function refreshNodeObjectHashes(node: ShadowExecutionNode): void {
  node.object_hashes = new Set([
    ...serializedObjectHashes(node.serialized),
    ...node.object_cache.keys()
  ]);
}

function cacheShadowObjectRecord(cache: Map<string, SerializedObject>, obj: SerializedObject): void {
  cache.set(shadowObjectRecordHash(obj), structuredClone(obj) as SerializedObject);
}

function missingActualAtoms(actual: ShadowTurnKey, materialized: Set<string>): ShadowMissingAtom[] {
  const missing: ShadowMissingAtom[] = [];
  for (let i = 0; i < actual.atom_hashes.length; i++) {
    const hash = actual.atom_hashes[i];
    if (!materialized.has(hash)) missing.push({ hash, preimage: actual.preimages[i] });
  }
  return missing;
}

function missingAtomsFromNeedStateTranscript(transcript: EffectTranscript): ShadowMissingAtom[] {
  if (transcript.error?.code !== "E_NEED_STATE") return [];
  const raw = transcript.error.value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const missing = (raw as Record<string, WooValue>).missing_atoms;
  if (!Array.isArray(missing)) return [];
  return missing.flatMap((item): ShadowMissingAtom[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const map = item as Record<string, WooValue>;
    return typeof map.hash === "string"
      ? [{ hash: map.hash, ...(typeof map.preimage === "string" ? { preimage: map.preimage } : {}) }]
      : [];
  });
}

function missingStateReply(
  request: ShadowTurnExecRequest,
  missingAtoms: ShadowMissingAtom[],
  transcript?: EffectTranscript
): ShadowTurnExecReply {
  return {
    kind: "woo.turn.exec.reply.shadow.v1",
    ok: false,
    id: request.id ?? request.call.id,
    reason: "missing_state",
    missing_atoms: missingAtoms,
    transcript
  };
}

function commitRejectedReply(
  request: ShadowTurnExecRequest,
  transcript: EffectTranscript,
  commit?: ShadowCommitConflict
): ShadowTurnExecReply {
  return {
    kind: "woo.turn.exec.reply.shadow.v1",
    ok: false,
    id: request.id ?? request.call.id,
    reason: "commit_rejected",
    transcript,
    commit
  };
}

function successReply(
  request: ShadowTurnExecRequest,
  transcript: EffectTranscript,
  commit?: ShadowCommitAccepted
): ShadowTurnExecReply {
  const outcome = transcript.error
    ? { error: transcript.error as unknown as WooValue }
    : { result: transcript.result };
  return {
    kind: "woo.turn.exec.reply.shadow.v1",
    ok: true,
    id: request.id ?? request.call.id,
    outcome,
    transcript,
    commit
  };
}

function objectClosureForPreimages(serialized: SerializedWorld, preimages: string[]): Set<ObjRef> {
  const byId = new Map(serialized.objects.map((obj) => [obj.id, obj] as const));
  const objectIds = new Set<ObjRef>();

  const addWithLineage = (id: ObjRef | null | undefined): void => {
    let current = id;
    while (current) {
      if (objectIds.has(current)) return;
      const obj = byId.get(current);
      if (!obj) return;
      objectIds.add(current);
      // Object-record closure includes parent and feature lineage so verb and
      // property walks can execute against the partial shard. Owner refs remain
      // metadata unless the turn explicitly touches the owner object or owner
      // cell.
      for (const feature of serializedFeatureRefs(obj)) addWithLineage(feature);
      current = obj.parent;
    }
  };

  for (const preimage of preimages) {
    const object = objectRefFromTurnKeyPreimage(preimage);
    if (object) addWithLineage(object);
  }
  return objectIds;
}

function serializedFeatureRefs(obj: SerializedObject): ObjRef[] {
  const value = obj.properties.find(([name]) => name === "features")?.[1];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ObjRef => typeof item === "string");
}

function objectRefFromTurnKeyPreimage(preimage: string): ObjRef | null {
  for (const prefix of ["actor:", "target:", "scope:"]) {
    if (preimage.startsWith(prefix)) return preimage.slice(prefix.length);
  }
  if (preimage.startsWith("call:")) return preimage.slice("call:".length).split(":")[0] ?? null;
  const cell = preimage.match(/^(?:read|write):cell:(?:prop|verb):([^.:]+)[.:]/);
  if (cell) return cell[1] as ObjRef;
  const structural = preimage.match(/^(?:read|write):cell:(?:location|contents|lifecycle):(.+)$/);
  if (structural) return structural[1] as ObjRef;
  return null;
}

function mergeObjectRecordTransfer(
  current: SerializedWorld | undefined,
  transfer: ShadowObjectRecordTransfer,
  objectCache: Map<string, SerializedObject>
): SerializedWorld {
  const base = current ? structuredClone(current) as SerializedWorld : emptySerializedWorld(transfer);
  const objects = new Map<ObjRef, SerializedObject>(base.objects.map((obj) => [obj.id, obj]));
  const pagesById = new Map<ObjRef, ShadowObjectPageRef>(transfer.object_pages.map((page) => [page.id, page]));
  for (const obj of transfer.objects) {
    const page = pagesById.get(obj.id);
    if (!page || page.inline !== true) throw new Error(`inline shadow object has no inline page ref: ${obj.id}`);
    const actual = shadowObjectRecordHash(obj);
    if (actual !== page.hash) throw new Error(`inline shadow object page hash mismatch: ${obj.id}`);
    objects.set(obj.id, structuredClone(obj) as SerializedObject);
  }
  for (const page of transfer.object_pages) {
    const currentObj = objects.get(page.id);
    if (currentObj) {
      const currentHash = shadowObjectRecordHash(currentObj);
      if (currentHash === page.hash) continue;
      if (page.inline) throw new Error(`inline shadow object page hash mismatch: ${page.id}`);
    }
    const cachedObj = objectCache.get(page.hash);
    if (cachedObj && cachedObj.id === page.id) {
      objects.set(page.id, structuredClone(cachedObj) as SerializedObject);
      continue;
    }
    if (!page.inline) throw new Error(`missing cached shadow object page: ${page.id}@${page.hash}`);
  }

  const sessions = new Map<string, SerializedSession>(base.sessions.map((session) => [session.id, session]));
  for (const session of transfer.sessions) sessions.set(session.id, structuredClone(session) as SerializedSession);

  const logs = new Map<ObjRef, SerializedWorld["logs"][number][1]>(base.logs.map(([space, entries]) => [space, entries]));
  for (const [space, entries] of transfer.logs) logs.set(space, structuredClone(entries) as SerializedWorld["logs"][number][1]);

  const parkedTasks = new Map<string, ParkedTaskRecord>(base.parkedTasks.map((task) => [task.id, task]));
  for (const task of transfer.parkedTasks) parkedTasks.set(task.id, structuredClone(task) as ParkedTaskRecord);

  const tombstones = new Set<ObjRef>([...(base.tombstones ?? []), ...transfer.tombstones]);

  return {
    version: 1,
    objectCounter: Math.max(base.objectCounter ?? 1, transfer.counters.objectCounter ?? 1),
    parkedTaskCounter: Math.max(base.parkedTaskCounter ?? 1, transfer.counters.parkedTaskCounter ?? 1),
    sessionCounter: Math.max(base.sessionCounter ?? 1, transfer.counters.sessionCounter ?? 1),
    objects: Array.from(objects.values()).sort((a, b) => a.id.localeCompare(b.id)),
    sessions: Array.from(sessions.values()).sort((a, b) => a.id.localeCompare(b.id)),
    logs: Array.from(logs.entries()).sort(([a], [b]) => a.localeCompare(b)),
    snapshots: mergeSnapshots(base.snapshots, transfer.snapshots),
    parkedTasks: Array.from(parkedTasks.values()).sort((a, b) => a.id.localeCompare(b.id)),
    tombstones: Array.from(tombstones).sort()
  };
}

function mergeCachedObjectRecords(current: SerializedWorld | undefined, objects: SerializedObject[]): SerializedWorld {
  const base = current ? structuredClone(current) as SerializedWorld : emptySerializedWorldForCache();
  const byId = new Map<ObjRef, SerializedObject>(base.objects.map((obj) => [obj.id, obj]));
  for (const obj of objects) byId.set(obj.id, structuredClone(obj) as SerializedObject);
  return {
    ...base,
    objects: Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id))
  };
}

function emptySerializedWorldForCache(): SerializedWorld {
  return {
    version: 1,
    objectCounter: 1,
    parkedTaskCounter: 1,
    sessionCounter: 1,
    objects: [],
    sessions: [],
    logs: [],
    snapshots: [],
    parkedTasks: [],
    tombstones: []
  };
}

function emptySerializedWorld(transfer: ShadowObjectRecordTransfer): SerializedWorld {
  return {
    version: 1,
    objectCounter: transfer.counters.objectCounter,
    parkedTaskCounter: transfer.counters.parkedTaskCounter,
    sessionCounter: transfer.counters.sessionCounter,
    objects: [],
    sessions: [],
    logs: [],
    snapshots: [],
    parkedTasks: [],
    tombstones: []
  };
}

function mergeSnapshots(current: SpaceSnapshotRecord[], incoming: SpaceSnapshotRecord[]): SpaceSnapshotRecord[] {
  const byKey = new Map<string, SpaceSnapshotRecord>();
  for (const snapshot of current) byKey.set(`${snapshot.space_id}:${snapshot.seq}:${snapshot.hash}`, snapshot);
  for (const snapshot of incoming) byKey.set(`${snapshot.space_id}:${snapshot.seq}:${snapshot.hash}`, structuredClone(snapshot) as SpaceSnapshotRecord);
  return Array.from(byKey.values()).sort((a, b) =>
    a.space_id.localeCompare(b.space_id) || a.seq - b.seq || a.hash.localeCompare(b.hash)
  );
}
