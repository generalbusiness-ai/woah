import type {
  ParkedTaskRecord,
  SerializedObject,
  SerializedSession,
  SerializedWorld,
  SpaceSnapshotRecord
} from "./repository";
import type { AppliedFrame, DirectResultFrame, ErrorFrame, MetricEvent, ObjRef, WooValue } from "./types";
import { effectTranscriptFromRecordedTurn, type EffectTranscript } from "./effect-transcript";
import { shadowCommitReceipt, type ShadowCommitReceipt } from "./turn-commit";
import { replayRecordedTurn } from "./turn-replay";
import type { RecordedTurn } from "./turn-recorder";
import { shadowAtomHash, shadowTurnKeyFromTranscript, type ShadowTurnKey } from "./turn-key";
import {
  runShadowTurnCallOnWorld,
  runShadowTurnCallOnWorldTranscript,
  type ShadowTurnCall,
  type ShadowTurnCallRun,
  type ShadowTurnCallTranscriptRun
} from "./shadow-turn-call";
import type { ShadowCapabilityAd } from "./capability-ad";
import {
  serializedFor,
  shadowCommitScopeObject,
  shadowLocationCommitScopeForTranscript,
  submitShadowCommit,
  transcriptTouchedObjectIds,
  type ShadowCommitAccepted,
  type ShadowCommitAcceptedWire,
  type ShadowCommitConflict,
  type ShadowCommitScope,
  type ShadowScopeHead
} from "./shadow-commit-scope";
import { constantTimeEqual, hashSource, utf8ByteLength } from "./source-hash";
import { stableShadowJson } from "./shadow-cell-version";
import { createWorldFromSerialized } from "./bootstrap";
import type { WooWorld } from "./world";
import {
  cacheShadowStatePages,
  mergeShadowStatePagesIntoSerialized,
  shadowObjectLineagePage,
  shadowObjectLivePage,
  shadowPropertyCellPage,
  shadowStatePageHash,
  shadowStatePageRef,
  shadowStatePagesForObject,
  shadowVerbBytecodePages,
  type ShadowStatePage,
  type ShadowStatePageRef
} from "./shadow-state-pages";

const DEFAULT_SHADOW_TRANSFER_AUTHORITY = "shadow-anchor";
const DEFAULT_SHADOW_TRANSFER_KEY_ID = "shadow-dev";
const DEFAULT_SHADOW_TRANSFER_SECRET = "shadow-dev-secret";
const SHADOW_EXECUTION_CAPSULE_CLOCK_SKEW_MS = 5_000;

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

export type ShadowCellPageTransferPurpose =
  | "open_executable_seed"
  | "open_executable_seed_cache_hit"
  | "state_repair"
  | "accepted_write_cells";

export type ShadowCellPageTransfer = {
  kind: "woo.state.transfer.shadow.v1";
  mode: "cell_pages";
  purpose?: ShadowCellPageTransferPurpose;
  scope: ObjRef;
  atom_hashes: string[];
  preimages?: string[];
  page_refs: ShadowStatePageRef[];
  inline_pages: ShadowStatePage[];
  sessions: SerializedSession[];
  logs: SerializedWorld["logs"];
  snapshots: SpaceSnapshotRecord[];
  parkedTasks: ParkedTaskRecord[];
  tombstones: ObjRef[];
  counters: Pick<SerializedWorld, "objectCounter" | "parkedTaskCounter" | "sessionCounter">;
  source_object_count: number;
  source_page_count: number;
  capsule?: ShadowExecutionCapsuleMetadata;
  proof: ShadowStateProof;
};

export type ShadowExecutionCapsuleMetadata = {
  kind: "woo.execution_capsule_metadata.shadow.v1";
  scope: ObjRef;
  head: ShadowScopeHead;
  actor: ObjRef;
  session?: string | null;
  target: ObjRef;
  verb: string;
  turn_key_hash: string;
  recipient: string;
  expires_at_ms: number;
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

export type ShadowStateTransferMode = "closure" | "object_records" | "cell_pages";

export type ShadowTransferSigning = {
  authority?: string;
  key_id?: string;
  secret?: string;
  recipient?: string;
};

export type ShadowStateTransfer = ShadowClosureTransfer | ShadowObjectRecordTransfer | ShadowCellPageTransfer;

export type ShadowExecutionNode = {
  kind: "woo.execution_node.shadow.v1";
  node: string;
  scope: ObjRef;
  atom_hashes: Set<string>;
  object_hashes: Set<string>;
  object_cache: Map<string, SerializedObject>;
  page_hashes: Set<string>;
  page_cache: Map<string, ShadowStatePage>;
  trusted_transfer_authorities: Map<string, string>;
  serialized?: SerializedWorld;
  world?: WooWorld;
  committed_head_hash?: string;
  serialized_generation?: number;
  // When true, the executor owns the full authoritative scope state and the
  // atom-guard checks (pre-run `missingAtomsForShadowTurn`, in-run
  // `ShadowStateGuardTurnRecorder`, post-run `missingActualAtoms`) are skipped:
  // every cell already materializes from `serialized`, so a request that only
  // negotiated a subset of atoms must not be rejected with `missing_state`.
  // The atom-guard remains the authority for delegate executors that hold a
  // verified partial cache.
  authoritative_state?: boolean;
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

function requireSerializedAfter(run: ShadowTurnCallRun | ShadowTurnCallTranscriptRun): SerializedWorld {
  if ("serializedAfter" in run) return run.serializedAfter;
  throw new Error("shadow turn post-state snapshot unavailable on transcript-only execution path");
}

export type ShadowTurnExecRequest = {
  kind: "woo.turn.exec.request.shadow.v1";
  id?: string;
  call: ShadowTurnCall;
  key: ShadowTurnKey;
  // A server-side planner may already have executed the turn to discover the
  // commit authority. Alternate commit authorities validate and commit that
  // transcript; they must not re-run the VM just to sequence the write.
  planned_transcript?: EffectTranscript;
  planned_frame?: AppliedFrame | DirectResultFrame | ErrorFrame;
  expected?: ShadowScopeHead;
  auth?: {
    mode: "shadow_local";
    actor: ObjRef;
    session?: string | null;
  };
  selected_ad?: string;
  requested_transfer?: {
    mode: ShadowStateTransferMode;
    atom_hashes?: string[];
    max_bytes?: number;
  };
  // Server-assisted sparse turns use a static key and must discover the true
  // closure under the atom guard. The relay may hold a serialized slice, but it
  // must not mark that slice authoritative: absent referenced objects have to
  // surface as `missing_state`, not as catalog-level E_OBJNF observations.
  guarded_execution?: boolean;
  max_transfer_bytes?: number;
  persistence?: "durable" | "live";
};

export type ShadowTurnExecReply =
  | {
      kind: "woo.turn.exec.reply.shadow.v1";
      ok: true;
      id?: string;
      outcome: { result?: WooValue; error?: WooValue };
      transcript: EffectTranscript;
      commit?: ShadowCommitAccepted | ShadowCommitAcceptedWire;
      state_transfer?: ShadowStateTransfer;
      ads?: ShadowCapabilityAd[];
    }
  | {
      kind: "woo.turn.exec.reply.shadow.v1";
      ok: false;
      id?: string;
      reason: "missing_state" | "commit_rejected";
      missing_atoms?: ShadowMissingAtom[];
      transcript?: EffectTranscript;
      commit?: ShadowCommitConflict;
      state_transfer?: ShadowStateTransfer;
      ads?: ShadowCapabilityAd[];
    };

export type ShadowTurnExecutionOptions = {
  commitScope?: ShadowCommitScope;
  commitScopeForTranscript?: (transcript: EffectTranscript) => ShadowCommitScope | null | undefined;
  profile?: (event: MetricEvent & { kind: "shadow_apply_step" }) => void;
  metric?: (event: MetricEvent) => void;
};

export function createShadowExecutionNode(input: {
  node: string;
  scope: ObjRef;
  atom_hashes?: string[];
  object_hashes?: string[];
  page_hashes?: string[];
  cached_objects?: SerializedObject[];
  cached_pages?: ShadowStatePage[];
  trusted_transfer_authorities?: Record<string, string>;
  serialized?: SerializedWorld;
  authoritative_state?: boolean;
}): ShadowExecutionNode {
  const authoritativeSerialized = input.authoritative_state === true && input.serialized !== undefined;
  // Authoritative relay executors already share the commit-scope state. Cloning
  // and hashing every object at construction only duplicates the authority's
  // resident state and puts full-world work back on the first user turn.
  let serialized = input.serialized
    ? authoritativeSerialized
      ? input.serialized
      : structuredClone(input.serialized) as SerializedWorld
    : undefined;
  const objectCache = new Map<string, SerializedObject>();
  const pageCache = new Map<string, ShadowStatePage>();
  if (!authoritativeSerialized) {
    for (const obj of serialized?.objects ?? []) cacheShadowObjectRecord(objectCache, obj);
    for (const obj of serialized?.objects ?? []) cacheShadowStatePages(pageCache, shadowStatePagesForObject(obj));
  }
  const cachedObjects = input.cached_objects ?? [];
  for (const obj of cachedObjects) cacheShadowObjectRecord(objectCache, obj);
  for (const obj of cachedObjects) cacheShadowStatePages(pageCache, shadowStatePagesForObject(obj));
  cacheShadowStatePages(pageCache, input.cached_pages ?? []);
  if (cachedObjects.length > 0) serialized = mergeCachedObjectRecords(serialized, cachedObjects);
  return {
    kind: "woo.execution_node.shadow.v1",
    node: input.node,
    scope: input.scope,
    atom_hashes: new Set(input.atom_hashes ?? []),
    object_hashes: new Set(input.object_hashes ?? objectCache.keys()),
    page_hashes: new Set(input.page_hashes ?? pageCache.keys()),
    object_cache: objectCache,
    page_cache: pageCache,
    trusted_transfer_authorities: trustedTransferAuthorities(input.trusted_transfer_authorities),
    serialized,
    ...(input.authoritative_state === true ? { authoritative_state: true } : {})
  };
}

export function installShadowCachedObjectRecords(node: ShadowExecutionNode, objects: SerializedObject[]): void {
  for (const obj of objects) cacheShadowMaterializedObject(node, obj);
  if (objects.length > 0) node.serialized = mergeCachedObjectRecords(node.serialized, objects);
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
      bytes: utf8ByteLength(stableShadowJson(obj as unknown as WooValue)),
      inline: !knownObjectHashes.has(hash)
    };
  });
  const inlineObjects = requiredObjects
    .filter((_, index) => objectPages[index]?.inline === true)
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

export function buildShadowCellPageTransfer(input: {
  serialized: SerializedWorld;
  key: ShadowTurnKey;
  atom_hashes?: string[];
  missing_atoms?: ShadowMissingAtom[];
  known_page_hashes?: Iterable<string>;
  session?: string | null;
  purpose?: ShadowCellPageTransferPurpose;
  capsule?: {
    head: ShadowScopeHead;
    actor?: ObjRef;
    session?: string | null;
    target?: ObjRef;
    verb?: string;
    recipient?: string;
    now?: number;
    ttlMs?: number;
    keyMode?: "request" | "transfer_atoms";
  };
} & ShadowTransferSigning): ShadowCellPageTransfer {
  let selected = selectedTransferAtoms(input.key, input.atom_hashes, input.missing_atoms);
  // VTN10.1: ONLY a lifecycle atom that arrives via
  // `missing_atoms` represents a bare-object materialization miss. Lifecycle
  // atoms also appear in full executable seeds and other ordinary closures; those
  // must not expand into full read/write grants or they bloat every browser
  // envelope. Scoped this way, object-lookup repair converges without changing
  // normal transfer sizing.
  const lifecycleObjects = lifecycleClosureObjectsFromPreimages(
    (input.missing_atoms ?? []).flatMap((atom) => typeof atom.preimage === "string" ? [atom.preimage] : [])
  );
  const serializedObjectIds = new Set(input.serialized.objects.map((obj) => obj.id));
  selected = selected.filter((item) => {
    const lifecycle = lifecycleObjectFromTurnKeyPreimage(item.preimage);
    // A READ lifecycle miss for an object absent from the anchor is a real
    // materialization miss that this transfer cannot satisfy; do not mark it
    // covered without pages, or the retry can fall through to E_OBJNF. A WRITE
    // lifecycle atom is different: creates legitimately write an object that
    // was absent from the pre-turn anchor.
    return !lifecycle || !item.preimage.startsWith("read:") || serializedObjectIds.has(lifecycle);
  });
  const requiredPages = pageClosureForPreimages(input.serialized, selected.map((item) => item.preimage), {
    fullLifecycleObjects: lifecycleObjects
  });
  const closureAtomPreimages = fullObjectClosureAtomPreimages(input.serialized, lifecycleObjects);
  const lookupAtomPreimages = lookupClosureAtomPreimages(input.serialized, selected.map((item) => item.preimage));
  const granted = transferAtomsForPages(selected, requiredPages, [...closureAtomPreimages, ...lookupAtomPreimages]);
  const knownPageHashes = new Set(input.known_page_hashes ?? []);
  const pageRefs = requiredPages.map((page) => {
    const ref = shadowStatePageRef(page, true);
    return { ...ref, inline: !knownPageHashes.has(ref.hash) };
  });
  const inlinePages = requiredPages
    .filter((_, index) => pageRefs[index]?.inline === true)
    .map((page) => structuredClone(page) as ShadowStatePage);
  const transfer = {
    kind: "woo.state.transfer.shadow.v1",
    mode: "cell_pages",
    ...(input.purpose ? { purpose: input.purpose } : {}),
    scope: input.key.scope,
    atom_hashes: granted.map((item) => item.hash),
    preimages: granted.map((item) => item.preimage),
    page_refs: pageRefs,
    inline_pages: inlinePages,
    ...shadowTransferWorldTail(input.serialized, input.key, input.session),
    // Count the selected executable closure, not every possible source page in
    // the snapshot. This is diagnostic/proof material only; rebuilding pages for
    // untouched objects puts whole-snapshot work back on cold open.
    source_page_count: requiredPages.length,
    ...(input.capsule ? {
      capsule: shadowExecutionCapsuleMetadata({
        scope: input.key.scope,
        key: input.capsule.keyMode === "transfer_atoms"
          ? shadowTransferAtomTurnKey(input.key.scope, granted, {
              actor: input.capsule.actor ?? input.key.actor,
              target: input.capsule.target ?? input.key.target,
              verb: input.capsule.verb ?? input.key.verb
            })
          : input.key,
        head: input.capsule.head,
        actor: input.capsule.actor,
        session: input.capsule.session,
        target: input.capsule.target,
        verb: input.capsule.verb,
        recipient: input.capsule.recipient ?? input.recipient ?? "*",
        now: input.capsule.now,
        ttlMs: input.capsule.ttlMs
      })
    } : {})
  } satisfies Omit<ShadowCellPageTransfer, "proof">;
  return {
    ...transfer,
    proof: signShadowStateTransfer(transfer, input)
  };
}

export function shadowCellPageTransferAtomTurnKey(
  transfer: ShadowCellPageTransfer,
  input: { actor: ObjRef; target: ObjRef; verb: string }
): ShadowTurnKey {
  const preimages = transfer.preimages ?? [];
  const atoms = preimages.map((preimage, index) => ({
    preimage,
    hash: transfer.atom_hashes[index] ?? shadowAtomHash(preimage)
  }));
  return shadowTransferAtomTurnKey(transfer.scope, atoms, input);
}

function shadowTransferAtomTurnKey(
  scope: ObjRef,
  atoms: readonly { hash: string; preimage: string }[],
  input: { actor: ObjRef; target: ObjRef; verb: string }
): ShadowTurnKey {
  const sorted = atoms.slice().sort((a, b) => a.hash.localeCompare(b.hash));
  const preimages = sorted.map((item) => item.preimage);
  const atomHashes = sorted.map((item) => item.hash);
  return {
    kind: "woo.turn_key.shadow.v1",
    scope,
    actor: input.actor,
    target: input.target,
    verb: input.verb,
    preimages,
    atom_hashes: atomHashes,
    read_preimages: preimages,
    read_atom_hashes: atomHashes,
    write_preimages: [],
    write_atom_hashes: [],
    accept_preimages: preimages,
    accept_atom_hashes: atomHashes
  };
}

function shadowExecutionCapsuleMetadata(input: {
  scope: ObjRef;
  key: ShadowTurnKey;
  head: ShadowScopeHead;
  actor?: ObjRef;
  session?: string | null;
  target?: ObjRef;
  verb?: string;
  recipient: string;
  now?: number;
  ttlMs?: number;
}): ShadowExecutionCapsuleMetadata {
  return {
    kind: "woo.execution_capsule_metadata.shadow.v1",
    scope: input.scope,
    head: structuredClone(input.head) as ShadowScopeHead,
    actor: input.actor ?? input.key.actor,
    ...(input.session !== undefined ? { session: input.session } : {}),
    target: input.target ?? input.key.target,
    verb: input.verb ?? input.key.verb,
    turn_key_hash: shadowTurnKeyHash(input.key),
    recipient: input.recipient,
    expires_at_ms: (input.now ?? Date.now()) + Math.max(1, input.ttlMs ?? 30_000)
  };
}

// Validates the request/recipient/expiry binding carried inside a cell-page
// execution capsule. The transfer proof and signature are verified separately
// by installShadowStateTransfer when the pages are installed.
export function validateShadowExecutionCapsuleTransfer(input: {
  node: string;
  transfer: ShadowStateTransfer;
  scope: ObjRef;
  key: ShadowTurnKey;
  actor?: ObjRef;
  session?: string | null;
  target?: ObjRef;
  verb?: string;
  now?: number;
}): void {
  if (input.transfer.mode !== "cell_pages") {
    throw new Error(`execution capsule transfer must use cell_pages: ${input.transfer.mode}`);
  }
  const capsule = input.transfer.capsule;
  if (!capsule) throw new Error("execution capsule metadata is required");
  if (capsule.scope !== input.transfer.scope || capsule.scope !== input.scope) {
    throw new Error("execution capsule scope mismatch");
  }
  if (capsule.head.scope !== input.scope) throw new Error("execution capsule head scope mismatch");
  if (capsule.recipient !== "*" && capsule.recipient !== input.node) {
    throw new Error(`execution capsule recipient mismatch: capsule=${capsule.recipient} node=${input.node}`);
  }
  const actor = input.actor ?? input.key.actor;
  const target = input.target ?? input.key.target;
  const verb = input.verb ?? input.key.verb;
  if (capsule.actor !== actor) throw new Error("execution capsule actor mismatch");
  if ((capsule.session ?? null) !== (input.session ?? null)) throw new Error("execution capsule session mismatch");
  if (capsule.target !== target || capsule.verb !== verb) throw new Error("execution capsule call mismatch");
  if (!constantTimeEqual(capsule.turn_key_hash, shadowTurnKeyHash(input.key))) throw new Error("execution capsule turn key mismatch");
  if (capsule.expires_at_ms + SHADOW_EXECUTION_CAPSULE_CLOCK_SKEW_MS <= (input.now ?? Date.now())) {
    throw new Error("execution capsule expired");
  }
}

function shadowTurnKeyHash(key: ShadowTurnKey): string {
  return hashSource(stableShadowJson(key as unknown as WooValue));
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
    for (const obj of node.serialized.objects) cacheShadowMaterializedObject(node, obj);
    return;
  }
  if (transfer.mode === "cell_pages") {
    node.serialized = mergeCellPageTransfer(node.serialized, transfer, node.page_cache);
    // Cell pages replace individual serialized cells. Any already-unpacked
    // WooWorld was built from the old cell versions, so replay must rebuild
    // before recording the retry transcript.
    node.world = undefined;
    for (const ref of transfer.page_refs) node.page_hashes.add(ref.hash);
    return;
  }
  node.serialized = mergeObjectRecordTransfer(node.serialized, transfer, node.object_cache);
  node.world = undefined;
  for (const page of transfer.object_pages) node.object_hashes.add(page.hash);
  cacheShadowObjectsById(node, new Set(transfer.object_pages.map((page) => page.id)));
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

  node.serialized = replay.serializedAfter;
  for (const hash of key.atom_hashes) node.atom_hashes.add(hash);
  cacheShadowTranscriptObjects(node, transcript);
  return {
    ok: true,
    attempted: true,
    frame: replay.frame,
    transcript,
    receipt,
    serializedAfter: replay.serializedAfter
  };
}

export async function executeAuthoritativeShadowTurnCall(
  node: ShadowExecutionNode,
  input: {
    id?: string;
    call: ShadowTurnCall;
    expected?: ShadowScopeHead;
    persistence?: "durable" | "live";
    commitScope: ShadowCommitScope;
  } & ShadowTurnExecutionOptions
): Promise<ShadowTurnExecutionResult> {
  if (node.authoritative_state !== true || !node.serialized) {
    throw new Error(`authoritative shadow fast path requires full authoritative state: ${node.node}`);
  }
  if (node.scope !== input.call.scope) {
    throw new Error(`authoritative shadow fast path scope mismatch: node=${node.scope} call=${input.call.scope}`);
  }
  if (input.persistence === "live") {
    throw new Error("authoritative shadow fast path is durable-only; live intents use the live snapshot path");
  }

  const world = shadowExecutionWorld(node);
  let run: ShadowTurnCallTranscriptRun;
  try {
    // The authoritative relay owns all cells for the scope, so it can execute an
    // intent once and use the resulting transcript as the commit contract. This
    // removes the old plan-then-execute double VM run for server-assisted turns.
    run = await runShadowTurnCallOnWorldTranscript(world, input.call, { onMetric: input.metric });
  } catch (err) {
    node.world = undefined;
    throw err;
  }

  const key = shadowTurnKeyFromTranscript(run.transcript);
  const request: ShadowTurnExecRequest = {
    kind: "woo.turn.exec.request.shadow.v1",
    id: input.id ?? input.call.id,
    call: input.call,
    key,
    expected: input.expected ?? input.commitScope.head,
    persistence: "durable"
  };
  const locationCommitScope = shadowLocationCommitScopeForTranscript(run.transcript);
  const commit = submitShadowCommit(input.commitScope, {
    kind: "woo.commit.submit.shadow.v1",
    id: request.id ?? input.call.id,
    // CA3 location-as-truth: commit at the moved object's location authority
    // when it owns this commit scope; otherwise at the transcript's own scope.
    scope: locationCommitScope === input.commitScope.scope ? input.commitScope.scope : run.transcript.scope,
    expected: request.expected ?? input.commitScope.head,
    transcript: run.transcript,
    executor: node.node,
    profile: input.profile,
    metric: input.metric
  });
  const receipt = commit.receipt;
  if (!receipt.accepted) {
    node.world = undefined;
    const conflict = commit.kind === "woo.commit.conflict.shadow.v1" ? commit : undefined;
    if (typeof console !== "undefined") {
      console.log("woo.commit_rejected.errors", JSON.stringify({
        scope: run.transcript.scope,
        verb: run.transcript.call?.verb,
        target: run.transcript.call?.target,
        actor: run.transcript.call?.actor,
        errors: receipt.errors
      }));
    }
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
  if (commit.kind !== "woo.commit.accepted.shadow.v1") {
    throw new Error("accepted authoritative shadow commit returned a conflict result");
  }

  node.serialized = serializedFor(input.commitScope, { reason: "authoritative_turn_result" });
  for (const hash of key.atom_hashes) node.atom_hashes.add(hash);
  cacheShadowTranscriptObjects(node, run.transcript, input.commitScope);
  return {
    ok: true,
    attempted: true,
    frame: run.frame,
    transcript: run.transcript,
    receipt,
    commit,
    serializedAfter: node.serialized,
    reply: successReply(request, run.transcript, commit)
  };
}

export async function executeShadowTurnCallOrNeedState(
  node: ShadowExecutionNode,
  request: ShadowTurnExecRequest,
  options: ShadowTurnExecutionOptions = {}
): Promise<ShadowTurnExecutionResult> {
  // Authoritative executors own the full scope's serialized state, so every
  // cell the verb might touch already materializes. Skipping the atom-guard
  // pre-check, the in-run `ShadowStateGuardTurnRecorder`, and the post-run
  // `missingActualAtoms` check prevents the relay from rejecting a turn with
  // `missing_state` for cells it actually has — which would otherwise loop the
  // browser through doomed repair rounds for atoms the relay was never going
  // to declare missing. Commit-scope validation (`submitShadowCommit`) is
  // still the gate that decides whether the transcript is accepted.
  const skipAtomChecks = node.authoritative_state === true && node.serialized !== undefined;

  if (!skipAtomChecks) {
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
  } else if (!node.serialized) {
    // Defensive: an authoritative node without serialized state is malformed,
    // but report it as missing_state rather than letting `shadowExecutionWorld`
    // throw an opaque error.
    return {
      ok: false,
      reason: "missing_state",
      attempted: false,
      missing_atoms: request.key.atom_hashes.map((hash, index) => ({ hash, preimage: request.key.preimages[index] })),
      reply: missingStateReply(request, request.key.atom_hashes.map((hash, index) => ({ hash, preimage: request.key.preimages[index] })))
    };
  }

  const serializedBefore = node.serialized;
  const world = shadowExecutionWorld(node);
  const commitScopeExecution = !!options.commitScope && request.persistence !== "live";
  let run: ShadowTurnCallRun | ShadowTurnCallTranscriptRun;
  try {
    const runOptions = {
      ...(skipAtomChecks ? {} : { allowed_atom_hashes: node.atom_hashes }),
      ...(options.metric ? { onMetric: options.metric } : {})
    };
    // With a durable commit scope, the transcript is the contract and the
    // commit scope owns authoritative post-state construction.
    run = commitScopeExecution
      ? await runShadowTurnCallOnWorldTranscript(world, request.call, runOptions)
      : await runShadowTurnCallOnWorld(world, request.call, runOptions);
  } catch (err) {
    // A cached executor world is authoritative only after a successful turn.
    // If VM execution throws outside the normal ErrorFrame path, discard the
    // mutable cache and rebuild from node.serialized on the next attempt.
    node.world = undefined;
    // VTN10.1: a guarded sequenced-call PREAMBLE materialization
    // miss surfaces as a thrown E_NEED_STATE (no transcript was recorded — the
    // miss happened before the recorder opened). Convert it to the same clean
    // `missing_state` the in-run probe path produces, so the repair loop pages
    // the absent object in and retries instead of propagating an uncaught
    // throw. Any non-E_NEED_STATE throw is a real fault and re-propagates.
    const needState = missingAtomsFromThrownNeedState(err);
    if (needState) {
      return {
        ok: false,
        reason: "missing_state",
        attempted: false,
        missing_atoms: needState,
        reply: missingStateReply(request, needState)
      };
    }
    throw err;
  }
  if (!skipAtomChecks) {
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
    const unmaterialized = missingActualAtoms(actualKey, node.atom_hashes, run.transcript);
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
  }

  const livePersistence = request.persistence === "live";
  const selectedCommitScope = !livePersistence
    ? options.commitScopeForTranscript?.(run.transcript) ?? options.commitScope
    : options.commitScope;
  const locationCommitScope = selectedCommitScope
    ? shadowLocationCommitScopeForTranscript(run.transcript)
    : null;
  const expected = selectedCommitScope && request.expected?.scope === selectedCommitScope.scope
    ? request.expected
    : selectedCommitScope?.head;
  const commit = selectedCommitScope && !livePersistence
    ? submitShadowCommit(selectedCommitScope, {
        kind: "woo.commit.submit.shadow.v1",
        id: request.id ?? request.call.id,
        // CA3 location-as-truth: commit at the moved object's location authority
        // when it owns this commit scope; otherwise at the transcript's scope.
        scope: locationCommitScope === selectedCommitScope.scope ? selectedCommitScope.scope : run.transcript.scope,
        expected: expected ?? selectedCommitScope.head,
        transcript: run.transcript,
        executor: node.node,
        profile: options.profile,
        metric: options.metric
      })
    : null;
  const receipt = commit
    ? commit.receipt
    : livePersistence
      // Live persistence is not authority-bearing: it may run through the
      // sequenced route to reuse catalog behavior, but its writes are discarded
      // below. Validate transcript completeness, not durable read versions that
      // include ephemeral sequencer bookkeeping from this same live turn.
      ? shadowCommitReceipt(serializedBefore, requireSerializedAfter(run), run.transcript, [], { ok: true, errors: [] })
      : shadowCommitReceipt(serializedBefore, requireSerializedAfter(run), run.transcript);
  if (!receipt.accepted) {
    node.world = undefined;
    const conflict = commit?.kind === "woo.commit.conflict.shadow.v1" ? commit : undefined;
    // Surface the receipt errors so commit_rejected is debuggable end-to-end.
    // The worker already logs these (`woo.commit_rejected.errors`) but the dev
    // server path does not — without this, a rejection is opaque on the client.
    if (typeof console !== "undefined") {
      console.log("woo.commit_rejected.errors", JSON.stringify({
        scope: run.transcript.scope,
        verb: run.transcript.call?.verb,
        target: run.transcript.call?.target,
        actor: run.transcript.call?.actor,
        errors: receipt.errors
      }));
    }
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
    ? selectedCommitScope ? serializedFor(selectedCommitScope, { reason: "turn_exec_result" }) : requireSerializedAfter(run)
    : livePersistence
      ? serializedBefore
      : requireSerializedAfter(run);
  node.serialized = serializedAfter;
  // Live-persistence turns are live/direct observations, not authority-bearing
  // state transitions. Keep their reply transcript, but discard the executor's
  // speculative world so the next durable turn plans against the commit scope.
  if (livePersistence) node.world = undefined;
  // Even when the atom-guard was skipped (authoritative executor), recording
  // the actual touched atoms keeps `node.atom_hashes` aligned with what just
  // executed — useful for any non-authoritative downstream consumer that
  // inspects the node after the turn.
  const acceptedKey = shadowTurnKeyFromTranscript(run.transcript);
  for (const hash of acceptedKey.atom_hashes) node.atom_hashes.add(hash);
  if (!livePersistence) cacheShadowTranscriptObjects(node, run.transcript, selectedCommitScope);
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
  const selected = new Map<string, { hash: string; preimage: string }>();
  if (atomHashes !== undefined || !missingAtoms) {
    const requested = new Set(atomHashes ?? key.atom_hashes);
    for (let index = 0; index < key.preimages.length; index++) {
      const preimage = key.preimages[index];
      const hash = key.atom_hashes[index];
      if (requested.has(hash)) selected.set(preimage, { preimage, hash });
    }
  }
  for (const atom of missingAtoms ?? []) {
    if (typeof atom.preimage === "string") selected.set(atom.preimage, { hash: atom.hash, preimage: atom.preimage });
  }
  return Array.from(selected.values()).sort((a, b) => a.hash.localeCompare(b.hash));
}

function transferAtomsForPages(
  selected: Array<{ hash: string; preimage: string }>,
  pages: readonly ShadowStatePage[],
  // VTN10.1: extra read/write preimages granted for objects
  // materialized by a bare-object lifecycle miss (their full own-cell closure).
  // Empty for ordinary cell-page transfers, so their granted atom set is
  // unchanged.
  extraAtomPreimages: readonly string[] = []
): Array<{ hash: string; preimage: string }> {
  const byPreimage = new Map<string, { hash: string; preimage: string }>();
  for (const item of selected) byPreimage.set(item.preimage, item);
  for (const page of pages) {
    for (const preimage of readPreimagesForStatePage(page)) {
      byPreimage.set(preimage, { preimage, hash: shadowAtomHash(preimage) });
    }
  }
  for (const preimage of extraAtomPreimages) {
    byPreimage.set(preimage, { preimage, hash: shadowAtomHash(preimage) });
  }
  return Array.from(byPreimage.values()).sort((a, b) => a.hash.localeCompare(b.hash));
}

function readPreimagesForStatePage(page: ShadowStatePage): string[] {
  switch (page.page) {
    case "verb_bytecode":
      return [`read:cell:verb:${page.object}:${page.name}`];
    default:
      return [];
  }
}

// A guarded executor can miss a negative lookup cell while walking an
// inheritance chain. The transfer selected by the first miss already carries
// the authoritative lineage pages for that walk, so grant the specific read
// atoms for the rest of the lookup path too. Otherwise sparse execution stalls
// one repair round per ancestor before it can reach feature verbs or conclude
// the lookup is absent.
function lookupClosureAtomPreimages(serialized: SerializedWorld, preimages: readonly string[]): string[] {
  const byId = new Map(serialized.objects.map((obj) => [obj.id, obj] as const));
  const out = new Set<string>();
  const verbMatches = (obj: SerializedObject, name: string): boolean =>
    obj.verbs.some((verb) => verb.name === name || verb.aliases.includes(name));
  const addVerbChain = (start: ObjRef, name: string): boolean => {
    let current: ObjRef | null | undefined = start;
    while (current) {
      const obj = byId.get(current);
      if (!obj) return false;
      out.add(`read:cell:verb:${current}:${name}`);
      if (verbMatches(obj, name)) return true;
      current = obj.parent;
    }
    return false;
  };
  const addVerbLookup = (start: ObjRef, name: string): void => {
    if (addVerbChain(start, name)) return;
    const obj = byId.get(start);
    if (!obj) return;
    for (const feature of serializedFeatureRefs(obj)) {
      if (addVerbChain(feature, name)) return;
    }
  };
  const addPropLookup = (start: ObjRef, name: string): void => {
    let current: ObjRef | null | undefined = start;
    while (current) {
      const obj = byId.get(current);
      if (!obj) return;
      out.add(`read:cell:prop:${current}.${name}`);
      if (objectHasPropertyCell(obj, name)) return;
      current = obj.parent;
    }
  };
  for (const preimage of preimages) {
    if (!preimage.startsWith("read:")) continue;
    const verb = verbCellFromTurnKeyPreimage(preimage);
    if (verb) {
      addVerbLookup(verb.object, verb.name);
      continue;
    }
    const prop = propCellFromTurnKeyPreimage(preimage);
    if (prop) addPropLookup(prop.object, prop.name);
  }
  return Array.from(out).sort();
}

// VTN10.1: for objects pulled in by a bare-object materialization
// miss (a `lifecycle:<id>` probe), grant the FULL set of read/write atoms for
// that object's own materialized cells — lifecycle, every own property, every
// own verb, and the structural location/contents cells — so the next guarded
// re-run does not re-miss a cell whose page is now installed. This is coverage,
// not write authority; commit validation remains the authority gate. It is the
// difference between "one transitively-referenced object = one repair round"
// and a per-cell stall.
//
// Scoped ONLY to the lifecycle-closure objects (passed in `fullClosureObjects`),
// it does NOT broaden the read atoms granted for ordinary location/contents/
// property/verb cell-page transfers. Other transfer modes are unchanged: their
// granted atoms remain exactly the selected missing atoms plus verb-page reads,
// which keeps commit-time touched-cell validation intact.
function fullObjectClosureAtomPreimages(
  serialized: SerializedWorld,
  ids: Iterable<ObjRef>
): string[] {
  const byId = new Map(serialized.objects.map((obj) => [obj.id, obj] as const));
  const preimages: string[] = [];
  for (const id of ids) {
    const obj = byId.get(id);
    if (!obj) continue;
    preimages.push(`read:cell:lifecycle:${id}`);
    preimages.push(`read:cell:location:${id}`);
    preimages.push(`write:cell:location:${id}`);
    preimages.push(`read:cell:contents:${id}`);
    preimages.push(`write:cell:contents:${id}`);
    for (const name of materializedPropertyNamesForObject(byId, obj)) {
      preimages.push(`read:cell:prop:${id}.${name}`);
      if (name !== "owner") preimages.push(`write:cell:prop:${id}.${name}`);
    }
    for (const page of shadowStatePagesForObject(obj)) {
      if (page.page === "verb_bytecode") {
        preimages.push(`read:cell:verb:${id}:${page.name}`);
        preimages.push(`write:cell:verb:${id}:${page.name}`);
      }
    }
  }
  return preimages;
}

// VTN10.1: the set of objects a transfer materialized via a
// lifecycle (bare-object) miss. Used to grant those objects' full read-atom
// closure (see fullObjectClosureAtomPreimages) so a reduced-key repair
// converges in one round per transitive object instead of stalling per cell.
function lifecycleClosureObjectsFromPreimages(preimages: string[]): Set<ObjRef> {
  const ids = new Set<ObjRef>();
  for (const preimage of preimages) {
    const id = lifecycleObjectFromTurnKeyPreimage(preimage);
    if (id) ids.add(id);
  }
  return ids;
}

function materializedPropertyNamesForObject(
  byId: ReadonlyMap<ObjRef, SerializedObject>,
  obj: SerializedObject
): Set<string> {
  const names = new Set<string>(["name", "owner"]);
  for (const def of obj.propertyDefs) names.add(def.name);
  for (const [name] of obj.properties) names.add(name);
  for (const [name] of obj.propertyVersions) names.add(name);
  const seen = new Set<ObjRef>();
  let parent = obj.parent;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const ancestor = byId.get(parent);
    if (!ancestor) break;
    for (const def of ancestor.propertyDefs) names.add(def.name);
    parent = ancestor.parent;
  }
  return names;
}

function trustedTransferAuthorities(input: Record<string, string> | undefined): Map<string, string> {
  return new Map(Object.entries(input ?? { [DEFAULT_SHADOW_TRANSFER_AUTHORITY]: DEFAULT_SHADOW_TRANSFER_SECRET }));
}

type UnsignedShadowStateTransfer =
  | Omit<ShadowClosureTransfer, "proof">
  | Omit<ShadowObjectRecordTransfer, "proof">
  | Omit<ShadowCellPageTransfer, "proof">;

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
    : transfer.mode === "cell_pages"
      ? {
          ...base,
          ...(transfer.purpose ? { purpose: transfer.purpose } : {}),
          ...(transfer.capsule ? { capsule: transfer.capsule } : {}),
          page_refs: transfer.page_refs,
          inline_page_hashes: transfer.inline_pages.map(shadowStatePageHash),
          sessions: transfer.sessions,
          logs: transfer.logs,
          snapshots: transfer.snapshots,
          parkedTasks: transfer.parkedTasks,
          tombstones: transfer.tombstones,
          counters: transfer.counters,
          source_object_count: transfer.source_object_count,
          source_page_count: transfer.source_page_count
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

function cacheShadowTranscriptObjects(
  node: ShadowExecutionNode,
  transcript: EffectTranscript,
  commitScope?: ShadowCommitScope
): void {
  cacheShadowObjectsById(node, transcriptMaterializedObjectIds(transcript), commitScope);
}

function transcriptMaterializedObjectIds(transcript: EffectTranscript): Set<ObjRef> {
  const ids = transcriptTouchedObjectIds(transcript);
  for (const move of transcript.moves) {
    ids.add(move.object);
    if (move.from) ids.add(move.from);
    ids.add(move.to);
  }
  return ids;
}

function cacheShadowObjectsById(
  node: ShadowExecutionNode,
  ids: Iterable<ObjRef>,
  commitScope?: ShadowCommitScope
): void {
  const byId = commitScope
    ? undefined
    : node.serialized
      ? new Map(node.serialized.objects.map((obj) => [obj.id, obj] as const))
      : undefined;
  for (const id of ids) {
    const obj = commitScope ? shadowCommitScopeObject(commitScope, id) : byId?.get(id);
    if (obj) cacheShadowMaterializedObject(node, obj);
  }
}

function cacheShadowMaterializedObject(node: ShadowExecutionNode, obj: SerializedObject): void {
  const objectHash = shadowObjectRecordHash(obj);
  node.object_hashes.add(objectHash);
  node.object_cache.set(objectHash, structuredClone(obj) as SerializedObject);
  for (const page of shadowStatePagesForObject(obj)) {
    const pageHash = shadowStatePageHash(page);
    node.page_hashes.add(pageHash);
    node.page_cache.set(pageHash, structuredClone(page) as ShadowStatePage);
  }
}

function cacheShadowObjectRecord(cache: Map<string, SerializedObject>, obj: SerializedObject): void {
  cache.set(shadowObjectRecordHash(obj), structuredClone(obj) as SerializedObject);
}

function missingActualAtoms(actual: ShadowTurnKey, materialized: Set<string>, transcript?: EffectTranscript): ShadowMissingAtom[] {
  const createdObjects = new Set((transcript?.creates ?? []).map((create) => create.object));
  const missing: ShadowMissingAtom[] = [];
  for (let i = 0; i < actual.atom_hashes.length; i++) {
    const hash = actual.atom_hashes[i];
    const preimage = actual.preimages[i];
    if (createdObjects.size > 0 && createdObjectOwnsAtomPreimage(preimage, createdObjects)) continue;
    if (!materialized.has(hash)) missing.push({ hash, preimage: actual.preimages[i] });
  }
  return missing;
}

function createdObjectOwnsAtomPreimage(preimage: string | undefined, createdObjects: ReadonlySet<ObjRef>): boolean {
  if (!preimage) return false;
  const cell = preimage.replace(/^(?:read|write):/, "");
  for (const prefix of ["cell:location:", "cell:contents:", "cell:lifecycle:"]) {
    if (cell.startsWith(prefix)) return createdObjects.has(cell.slice(prefix.length) as ObjRef);
  }
  if (cell.startsWith("cell:prop:")) {
    const rest = cell.slice("cell:prop:".length);
    const split = rest.lastIndexOf(".");
    return split > 0 && createdObjects.has(rest.slice(0, split) as ObjRef);
  }
  if (cell.startsWith("cell:verb:")) {
    const rest = cell.slice("cell:verb:".length);
    const split = rest.lastIndexOf(":");
    return split > 0 && createdObjects.has(rest.slice(0, split) as ObjRef);
  }
  return false;
}

function missingAtomsFromNeedStateTranscript(transcript: EffectTranscript): ShadowMissingAtom[] {
  if (transcript.error?.code !== "E_NEED_STATE") return [];
  return missingAtomsFromNeedStateValue(transcript.error.value);
}

// VTN10.1: a guarded preamble materialization miss is thrown as a
// raw E_NEED_STATE wooError (no transcript, because the recorder had not opened
// yet). Extract its `missing_atoms` so the executor can return a clean
// `missing_state`. Returns null when `err` is not an E_NEED_STATE carrying
// usable missing atoms, so the caller re-propagates genuine faults.
function missingAtomsFromThrownNeedState(err: unknown): ShadowMissingAtom[] | null {
  const error = err as { code?: string; value?: WooValue } | null;
  if (!error || error.code !== "E_NEED_STATE") return null;
  const atoms = missingAtomsFromNeedStateValue(error.value);
  return atoms.length > 0 ? atoms : null;
}

function missingAtomsFromNeedStateValue(raw: WooValue | undefined): ShadowMissingAtom[] {
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

function pageClosureForPreimages(
  serialized: SerializedWorld,
  preimages: string[],
  options: { fullLifecycleObjects?: ReadonlySet<ObjRef> } = {}
): ShadowStatePage[] {
  if (preimages.length === 0) return [];
  const byId = new Map(serialized.objects.map((obj) => [obj.id, obj] as const));
  const catalogObjects = serialized.objects
    .filter((obj) => obj.id.startsWith("$"))
    .sort((a, b) => a.id.localeCompare(b.id));
  const selectedObjects = objectClosureForPreimages(serialized, preimages);
  const pages = new Map<string, ShadowStatePage>();
  const visitedLookups = new Set<string>();
  const expandedVerbPages = new Set<string>();

  const addPage = (page: ShadowStatePage): void => {
    pages.set(shadowStatePageHash(page), page);
  };
  const addObjectScaffold = (id: ObjRef | null | undefined, includeLive = true): void => {
    if (!id) return;
    const obj = byId.get(id);
    if (!obj) return;
    addPage(shadowObjectLineagePage(obj));
    if (includeLive) addPage(shadowObjectLivePage(obj));
  };
  const addLineage = (id: ObjRef | null | undefined): void => {
    let current = id;
    while (current) {
      const obj = byId.get(current);
      if (!obj) return;
      addObjectScaffold(current);
      current = obj.parent;
    }
  };
  const addPropertyLookupPages = (object: ObjRef, name: string): void => {
    const target = byId.get(object);
    if (!target) return;
    if (objectHasPropertyCell(target, name)) addPage(shadowPropertyCellPage(target, name));
    if (name === "features" && objectHasPropertyCell(target, "features")) {
      for (const feature of serializedFeatureRefs(target)) addLineage(feature);
    }
    if (name === "owner" || name === "name") return;
    let parent = target.parent;
    while (parent) {
      const ancestor = byId.get(parent);
      if (!ancestor) return;
      if (ancestor.propertyDefs.some((def) => def.name === name)) {
        addPage(shadowPropertyCellPage(ancestor, name));
        return;
      }
      parent = ancestor.parent;
    }
  };
  const addOwnPropertyPages = (object: ObjRef): void => {
    const obj = byId.get(object);
    if (!obj) return;
    for (const page of shadowStatePagesForObject(obj)) {
      if (page.page === "property_cell") addPage(page);
    }
  };
  // VTN10.1: a bare-object materialization miss (a `lifecycle:<id>` probe
  // emitted by `WooWorld.object()` for an id not in the executor slice)
  // must grant the FULL OBJECT CLOSURE for that id in one repair round:
  // lineage + live + every own property cell + the object's own verb
  // cells. Granting only the structural scaffold (lineage+live) would
  // stall the loop one cell per round — the next re-run would re-miss
  // `prop:<id>.<name>` or `verb:<id>:<name>`. With the full closure the
  // executor materializes a complete object, so "one transitively-
  // referenced object = one repair round". (Location/contents cell misses
  // keep granting only the structural scaffold; see the loop below.)
  const addFullObjectClosure = (id: ObjRef): void => {
    const obj = byId.get(id);
    if (!obj) return;
    for (const page of shadowStatePagesForObject(obj)) addPage(page);
    for (const name of materializedPropertyNamesForObject(byId, obj)) {
      addPropertyLookupPages(id, name);
    }
  };
  const addVerbLookupClosure = (object: ObjRef, name: string): void => {
    const lookupKey = `${object}:${name}`;
    if (visitedLookups.has(lookupKey)) return;
    visitedLookups.add(lookupKey);
    let current: ObjRef | null | undefined = object;
    while (current) {
      const obj = byId.get(current);
      if (!obj) return;
      addObjectScaffold(current);
      const page = shadowVerbBytecodePages(obj).find((item) => item.name === name);
      if (page) {
        addPage(page);
        addVerbCallClosure(page, object);
        return;
      }
      current = obj.parent;
    }
  };
  const addCatalogVerbLookups = (name: string): void => {
    for (const obj of catalogObjects) {
      if (obj.verbs.some((verb) => verb.name === name || verb.aliases.includes(name))) {
        addVerbLookupClosure(obj.id, name);
      }
    }
  };
  const addVerbCallClosure = (page: Extract<ShadowStatePage, { page: "verb_bytecode" }>, receiver: ObjRef): void => {
    const pageKey = `${page.object}:${page.name}`;
    if (expandedVerbPages.has(pageKey)) return;
    expandedVerbPages.add(pageKey);
    for (const call of page.verb.calls ?? []) {
      if (call.this_call) addVerbLookupClosure(receiver, call.name);
      else addCatalogVerbLookups(call.name);
    }
  };

  for (const id of selectedObjects) addLineage(id);
  for (const preimage of preimages) {
    // Sequenced-call preamble checks session/subscriber metadata before the
    // recorder opens, so cold executable closures need root object properties
    // in addition to the exact cells that appear in the eventual transcript.
    const preambleRoot = preambleRootObjectFromTurnKeyPreimage(preimage);
    if (preambleRoot) addOwnPropertyPages(preambleRoot);
    const prop = propCellFromTurnKeyPreimage(preimage);
    if (prop) addPropertyLookupPages(prop.object, prop.name);
    const verb = verbCellFromTurnKeyPreimage(preimage);
    if (verb) addVerbLookupClosure(verb.object, verb.name);
    // VTN10.1: a lifecycle miss is the materialization probe for a bare
    // object lookup ONLY when it came from `missing_atoms`; full executable
    // seeds also contain lifecycle preimages and must keep the old lightweight
    // scaffold behavior. location/contents misses remain scaffold-only.
    const lifecycle = lifecycleObjectFromTurnKeyPreimage(preimage);
    if (lifecycle) {
      if (options.fullLifecycleObjects?.has(lifecycle)) addFullObjectClosure(lifecycle);
      else addObjectScaffold(lifecycle);
    }
    const structural = structuralObjectFromTurnKeyPreimage(preimage);
    if (structural) addObjectScaffold(structural);
  }

  return Array.from(pages.values()).sort(compareStatePages);
}

function objectHasPropertyCell(obj: SerializedObject, name: string): boolean {
  return obj.propertyDefs.some((def) => def.name === name)
    || obj.properties.some(([prop]) => prop === name)
    || obj.propertyVersions.some(([prop]) => prop === name);
}

function compareStatePages(a: ShadowStatePage, b: ShadowStatePage): number {
  return a.object.localeCompare(b.object)
    || a.page.localeCompare(b.page)
    || (("name" in a ? a.name : "").localeCompare("name" in b ? b.name : ""));
}

function propCellFromTurnKeyPreimage(preimage: string): { object: ObjRef; name: string } | null {
  const cell = preimage.match(/^(?:read|write):cell:prop:([^.:]+)\.(.+)$/);
  return cell ? { object: cell[1] as ObjRef, name: cell[2] } : null;
}

function verbCellFromTurnKeyPreimage(preimage: string): { object: ObjRef; name: string } | null {
  const cell = preimage.match(/^(?:read|write):cell:verb:([^:]+):(.+)$/);
  return cell ? { object: cell[1] as ObjRef, name: cell[2] } : null;
}

function structuralObjectFromTurnKeyPreimage(preimage: string): ObjRef | null {
  // Only location/contents cell misses grant the structural scaffold
  // (lineage+live for the touched object). Lifecycle is handled separately
  // by `lifecycleObjectFromTurnKeyPreimage` so the materialization-probe
  // case can grant the FULL object closure (VTN10.1) without
  // double-counting it here.
  const structural = preimage.match(/^(?:read|write):cell:(?:location|contents):(.+)$/);
  return structural ? structural[1] as ObjRef : null;
}

// VTN10.1: a `lifecycle:<id>` preimage is the materialization probe that
// `WooWorld.object()` emits when an id is absent from a guarded executor's
// slice. Distinguished from location/contents so the page closure can grant
// the object's full closure in one repair round (see addFullObjectClosure).
function lifecycleObjectFromTurnKeyPreimage(preimage: string): ObjRef | null {
  const lifecycle = preimage.match(/^(?:read|write):cell:lifecycle:(.+)$/);
  return lifecycle ? lifecycle[1] as ObjRef : null;
}

function preambleRootObjectFromTurnKeyPreimage(preimage: string): ObjRef | null {
  for (const prefix of ["actor:", "target:", "scope:"]) {
    if (preimage.startsWith(prefix)) return preimage.slice(prefix.length);
  }
  return null;
}

function serializedFeatureRefs(obj: SerializedObject): ObjRef[] {
  const value = obj.properties.find(([name]) => name === "features")?.[1];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ObjRef => typeof item === "string");
}

function shadowTransferWorldTail(
  serialized: SerializedWorld,
  key: ShadowTurnKey,
  session: string | null | undefined
): Pick<ShadowObjectRecordTransfer, "sessions" | "logs" | "snapshots" | "parkedTasks" | "tombstones" | "counters" | "source_object_count"> {
  return {
    sessions: serialized.sessions
      .filter((item) => item.id === session || item.actor === key.actor)
      .map((item) => structuredClone(item) as SerializedSession)
      .sort((a, b) => a.id.localeCompare(b.id)),
    logs: serialized.logs
      .filter(([space]) => space === key.scope)
      .map(([space, entries]) => [space, structuredClone(entries) as SerializedWorld["logs"][number][1]] as SerializedWorld["logs"][number]),
    snapshots: serialized.snapshots
      .filter((snapshot) => snapshot.space_id === key.scope)
      .map((snapshot) => structuredClone(snapshot) as SpaceSnapshotRecord),
    parkedTasks: [],
    tombstones: [...(serialized.tombstones ?? [])].sort(),
    counters: {
      objectCounter: serialized.objectCounter,
      parkedTaskCounter: serialized.parkedTaskCounter,
      sessionCounter: serialized.sessionCounter
    },
    source_object_count: serialized.objects.length
  };
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

function mergeCellPageTransfer(
  current: SerializedWorld | undefined,
  transfer: ShadowCellPageTransfer,
  pageCache: Map<string, ShadowStatePage>
): SerializedWorld {
  const base = current ? structuredClone(current) as SerializedWorld : emptySerializedWorld(transfer);
  const incomingPages: ShadowStatePage[] = [];
  const inlineRefHashes = new Set(transfer.page_refs.filter((ref) => ref.inline === true).map((ref) => ref.hash));
  for (const page of transfer.inline_pages) {
    const hash = shadowStatePageHash(page);
    if (!inlineRefHashes.has(hash)) throw new Error(`inline shadow state page has no inline page ref: ${hash}`);
    pageCache.set(hash, structuredClone(page) as ShadowStatePage);
  }

  let currentPages: Map<string, ShadowStatePage> | null = null;
  const currentPage = (hash: string): ShadowStatePage | undefined => {
    if (!currentPages) {
      currentPages = new Map();
      for (const obj of base.objects) {
        for (const page of shadowStatePagesForObject(obj)) currentPages.set(shadowStatePageHash(page), page);
      }
    }
    return currentPages.get(hash);
  };

  for (const ref of transfer.page_refs) {
    const page = pageCache.get(ref.hash) ?? currentPage(ref.hash);
    if (!page) throw new Error(`missing cached shadow state page: ${ref.object}:${ref.page}@${ref.hash}`);
    const actualRef = shadowStatePageRef(page, ref.inline);
    if (actualRef.object !== ref.object || actualRef.page !== ref.page || actualRef.name !== ref.name) {
      throw new Error(`shadow state page ref mismatch: ${ref.object}:${ref.page}`);
    }
    incomingPages.push(structuredClone(page) as ShadowStatePage);
  }

  const withObjects = mergeShadowStatePagesIntoSerialized(base, incomingPages, () => emptySerializedWorld(transfer));
  return mergeTransferTail(withObjects, transfer);
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

function emptySerializedWorld(transfer: ShadowObjectRecordTransfer | ShadowCellPageTransfer): SerializedWorld {
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

function mergeTransferTail(
  base: SerializedWorld,
  transfer: ShadowObjectRecordTransfer | ShadowCellPageTransfer
): SerializedWorld {
  const sessions = new Map<string, SerializedSession>(base.sessions.map((session) => [session.id, session]));
  for (const session of transfer.sessions) sessions.set(session.id, structuredClone(session) as SerializedSession);

  const logs = new Map<ObjRef, SerializedWorld["logs"][number][1]>(base.logs.map(([space, entries]) => [space, entries]));
  for (const [space, entries] of transfer.logs) logs.set(space, structuredClone(entries) as SerializedWorld["logs"][number][1]);

  const parkedTasks = new Map<string, ParkedTaskRecord>(base.parkedTasks.map((task) => [task.id, task]));
  for (const task of transfer.parkedTasks) parkedTasks.set(task.id, structuredClone(task) as ParkedTaskRecord);

  const tombstones = new Set<ObjRef>([...(base.tombstones ?? []), ...transfer.tombstones]);

  return {
    ...base,
    objectCounter: Math.max(base.objectCounter ?? 1, transfer.counters.objectCounter ?? 1),
    parkedTaskCounter: Math.max(base.parkedTaskCounter ?? 1, transfer.counters.parkedTaskCounter ?? 1),
    sessionCounter: Math.max(base.sessionCounter ?? 1, transfer.counters.sessionCounter ?? 1),
    sessions: Array.from(sessions.values()).sort((a, b) => a.id.localeCompare(b.id)),
    logs: Array.from(logs.entries()).sort(([a], [b]) => a.localeCompare(b)),
    snapshots: mergeSnapshots(base.snapshots, transfer.snapshots),
    parkedTasks: Array.from(parkedTasks.values()).sort((a, b) => a.id.localeCompare(b.id)),
    tombstones: Array.from(tombstones).sort()
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
