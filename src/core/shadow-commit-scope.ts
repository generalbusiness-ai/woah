import type { SerializedObject, SerializedWorld } from "./repository";
import {
  createTranscriptCellReader,
  createTranscriptCellReaderFromObjectMap,
  readTranscriptCell,
  transcriptTouchedStateHashWithReader,
  validateTranscriptAgainstSerializedWorld,
  validateTranscriptWithCellReader,
  type EffectTranscript,
  type TranscriptCell,
  type TranscriptCellReader,
  type TranscriptCreate,
  type TranscriptValidation,
  type TranscriptWrite
} from "./effect-transcript";
import { stableShadowJson } from "./shadow-cell-version";
import { hashSource } from "./source-hash";
import { shadowCommitReceipt, shadowCommitReceiptFromTouchedStateHashes, type ShadowCommitReceipt } from "./turn-commit";
import type { RecordedWriteAuthority } from "./turn-recorder";
import type { MetricEvent, ObjRef, WooValue } from "./types";

export type ShadowScopeHead = {
  kind: "woo.scope_head.shadow.v1";
  scope: ObjRef;
  epoch: number;
  seq: number;
  hash: string;
};

export type ShadowCommitSubmit = {
  kind: "woo.commit.submit.shadow.v1";
  id?: string;
  scope: ObjRef;
  expected: ShadowScopeHead;
  transcript: EffectTranscript;
  executor?: string;
  profile?: (event: MetricEvent & { kind: "shadow_apply_step" }) => void;
  metric?: (event: MetricEvent) => void;
};

export type ShadowCommitAccepted = {
  kind: "woo.commit.accepted.shadow.v1";
  id?: string;
  position: ShadowScopeHead;
  ts?: number;
  transcript_hash: string;
  post_state_hash: string;
  observations: EffectTranscript["observations"];
  receipt: ShadowCommitReceipt;
};

export type ShadowCommitAcceptedWire = ShadowCommitAccepted;

export type ShadowCommitConflict = {
  kind: "woo.commit.conflict.shadow.v1";
  id?: string;
  scope: ObjRef;
  current: ShadowScopeHead;
  reason:
    | "stale_head"
    | "read_version_mismatch"
    | "write_fence_missing"
    | "permission_denied"
    | "bytecode_mismatch"
    | "nondeterministic"
    | "incomplete_transcript"
    | "scope_mismatch"
    | "post_state_mismatch";
  errors: string[];
  receipt: ShadowCommitReceipt;
};

export type ShadowCommitResult = ShadowCommitAccepted | ShadowCommitConflict;

export type ShadowCommitScope = {
  kind: "woo.commit_scope.shadow.v1";
  node: string;
  scope: ObjRef;
  epoch: number;
  head: ShadowScopeHead;
  serialized: SerializedWorld;
  state: ShadowCommitScopeState;
  submissions: Map<string, ShadowCommitResult>;
};

export type ShadowCommitScopeState = {
  kind: "woo.commit_scope_state.shadow.v1";
  version: 1;
  objectCounter: number;
  parkedTaskCounter: number;
  sessionCounter: number;
  objectsById: Map<ObjRef, SerializedObject>;
  sessionsById: Map<string, SerializedWorld["sessions"][number]>;
  logsByScope: Map<ObjRef, SerializedWorld["logs"][number][1]>;
  snapshots: SerializedWorld["snapshots"];
  parkedTasks: SerializedWorld["parkedTasks"];
  tombstones?: ObjRef[];
  serializedRefs: ShadowCommitScopeSerializedRefs;
};

type ShadowCommitScopeSerializedRefs = {
  serialized: SerializedWorld;
  objects: SerializedWorld["objects"];
  sessions: SerializedWorld["sessions"];
  logs: SerializedWorld["logs"];
  snapshots: SerializedWorld["snapshots"];
  parkedTasks: SerializedWorld["parkedTasks"];
  tombstones?: ObjRef[];
};

export type ShadowTranscriptApplyOptions = {
  objectTimestamp?: number;
  profile?: (event: MetricEvent & { kind: "shadow_apply_step" }) => void;
  metric?: (event: MetricEvent) => void;
};

export function createShadowCommitScope(input: {
  node: string;
  scope: ObjRef;
  epoch?: number;
  serialized: SerializedWorld;
}): ShadowCommitScope {
  const epoch = input.epoch ?? 1;
  const serialized = structuredClone(input.serialized) as SerializedWorld;
  return {
    kind: "woo.commit_scope.shadow.v1",
    node: input.node,
    scope: input.scope,
    epoch,
    head: shadowScopeHeadForSerialized(input.scope, epoch, serialized),
    serialized,
    state: createShadowCommitScopeState(serialized),
    submissions: new Map()
  };
}

export function shadowScopeHeadForSerialized(scope: ObjRef, epoch: number, serialized: SerializedWorld, seqOverride?: number): ShadowScopeHead {
  const seq = seqOverride ?? serialized.logs
    .find(([space]) => space === scope)?.[1]
    .reduce((max, entry) => Math.max(max, entry.seq), 0) ?? 0;
  const material = {
    kind: "woo.scope_head_material.shadow.v1",
    scope,
    epoch,
    seq,
    state_hash: hashSource(stableShadowJson(serialized as unknown as WooValue))
  };
  return {
    kind: "woo.scope_head.shadow.v1",
    scope,
    epoch,
    seq,
    hash: hashSource(stableShadowJson(material as unknown as WooValue))
  };
}

function shadowScopeHeadForAcceptedCommit(
  scope: ObjRef,
  epoch: number,
  previous: ShadowScopeHead,
  transcriptHash: string,
  postStateHash: string
): ShadowScopeHead {
  const seq = previous.seq + 1;
  // The epoch root still hashes a full serialized state. Accepted heads only
  // need to name the ordered commit position, so chaining from the previous head
  // avoids re-hashing the whole world on every interaction.
  const material = {
    kind: "woo.scope_head_commit_material.shadow.v1",
    scope,
    epoch,
    seq,
    prev_hash: previous.hash,
    transcript_hash: transcriptHash,
    post_state_hash: postStateHash
  };
  return {
    kind: "woo.scope_head.shadow.v1",
    scope,
    epoch,
    seq,
    hash: hashSource(stableShadowJson(material as unknown as WooValue))
  };
}

export function submitShadowCommit(scope: ShadowCommitScope, submit: ShadowCommitSubmit): ShadowCommitResult {
  const submissionId = shadowSubmissionId(submit);
  const submissionCacheKey = shadowSubmissionCacheKey(submit);
  if (submissionCacheKey) {
    const existing = scope.submissions.get(submissionCacheKey);
    if (existing) return existing;
  }

  const stateBefore = ensureShadowCommitScopeState(scope);
  const beforeReader = createCommitScopeStateCellReader(stateBefore);
  const validation = validateTranscriptWithCellReader(beforeReader, submit.transcript);
  const mergedState = applyShadowTranscriptToIndexedState(stateBefore, submit.transcript, { profile: submit.profile, metric: submit.metric });
  const afterReader = createCommitScopeStateCellReader(mergedState);
  const extraErrors = shadowCommitEnvelopeErrors(scope, submit, validation);
  extraErrors.push(...validateShadowPostState(afterReader, submit.transcript));
  extraErrors.push(...validateShadowWriteAuthorityIndex(serializedAuthorityIndexFromState(stateBefore), submit.transcript));

  const receipt = shadowCommitReceiptFromTouchedStateHashes(
    submit.transcript,
    transcriptTouchedStateHashWithReader(beforeReader, submit.transcript),
    transcriptTouchedStateHashWithReader(afterReader, submit.transcript),
    extraErrors,
    validation
  );
  if (!receipt.accepted) {
    const conflict: ShadowCommitConflict = {
      kind: "woo.commit.conflict.shadow.v1",
      id: submissionId,
      scope: submit.scope,
      current: scope.head,
      reason: shadowConflictReason(receipt.errors),
      errors: receipt.errors,
      receipt
    };
    // `stale_head` is a transient conflict: the same submission id can succeed
    // on a later retry once the caller resubmits against the new head (or the
    // relay's `executeShadowTurnCallAcrossInProcessNetwork` re-runs the verb
    // and updates `expected` automatically). Caching the rejection by id would
    // serve the stale conflict to every retry, which makes the convergence
    // loop fail even though the underlying transcript would commit. Permanent
    // rejections (post-state mismatch, permission, invariant) stay cached so
    // re-submissions don't retry doomed work.
    if (submissionCacheKey && conflict.reason !== "stale_head") scope.submissions.set(submissionCacheKey, conflict);
    return conflict;
  }

  scope.serialized = commitShadowCommitScopeState(scope, mergedState);
  // Shadow commit scopes sequence accepted transcripts independently of the
  // legacy durable space log. The serialized state is still in the hash, but
  // browser catch-up needs every accepted v2 commit to advance the head.
  scope.head = shadowScopeHeadForAcceptedCommit(scope.scope, scope.epoch, scope.head, submit.transcript.hash, receipt.post_state_hash);
  const accepted: ShadowCommitAccepted = {
    kind: "woo.commit.accepted.shadow.v1",
    id: submissionId,
    position: scope.head,
    ts: Date.now(),
    transcript_hash: submit.transcript.hash,
    post_state_hash: receipt.post_state_hash,
    observations: submit.transcript.observations,
    receipt
  };
  if (submissionCacheKey) scope.submissions.set(submissionCacheKey, accepted);
  return accepted;
}

export function applyAcceptedShadowFrame(
  scope: ShadowCommitScope,
  accepted: ShadowCommitAccepted,
  transcript: EffectTranscript
): void {
  // Consumers that receive an accepted frame from the commit authority already
  // have the validation result. Update their local cache from the transcript
  // and authority head without running the expensive authority checks again.
  applyShadowTranscriptToCommitScopeCache(scope, transcript);
  scope.head = structuredClone(accepted.position) as ShadowScopeHead;
  if (accepted.id) scope.submissions.set(`${accepted.id}:${accepted.transcript_hash}`, structuredClone(accepted) as ShadowCommitAccepted);
}

function shadowSubmissionId(submit: ShadowCommitSubmit): string | undefined {
  return submit.id ?? submit.transcript.id;
}

function shadowSubmissionCacheKey(submit: ShadowCommitSubmit): string | undefined {
  const id = shadowSubmissionId(submit);
  return id ? `${id}:${submit.transcript.hash}` : undefined;
}

export function applyShadowTranscriptToCommitScopeCache(
  scope: ShadowCommitScope,
  transcript: EffectTranscript,
  options: ShadowTranscriptApplyOptions = {}
): void {
  const state = applyShadowTranscriptToIndexedState(ensureShadowCommitScopeState(scope), transcript, options);
  scope.serialized = commitShadowCommitScopeState(scope, state);
}

export function markShadowCommitScopeSerializedChanged(scope: ShadowCommitScope): void {
  scope.state = createShadowCommitScopeState(scope.serialized);
}

export function shadowCommitScopeObject(scope: ShadowCommitScope, id: ObjRef): SerializedObject | undefined {
  return ensureShadowCommitScopeState(scope).objectsById.get(id);
}

export function shadowCommitScopeSession(scope: ShadowCommitScope, id: string, actor?: ObjRef): SerializedWorld["sessions"][number] | undefined {
  const session = ensureShadowCommitScopeState(scope).sessionsById.get(id);
  if (!session || (actor !== undefined && session.actor !== actor)) return undefined;
  return session;
}

function shadowCommitEnvelopeErrors(scope: ShadowCommitScope, submit: ShadowCommitSubmit, validation?: TranscriptValidation): string[] {
  const errors: string[] = [];
  if (submit.scope !== scope.scope || submit.transcript.scope !== scope.scope) {
    errors.push(`scope_mismatch: submit=${submit.scope} transcript=${submit.transcript.scope} scope=${scope.scope}`);
  }
  if (!sameShadowHead(submit.expected, scope.head)) {
    errors.push(`stale_head: expected=${submit.expected.hash}@${submit.expected.seq} current=${scope.head.hash}@${scope.head.seq}`);
  }
  if (!submit.transcript.complete) {
    errors.push("incomplete_transcript");
  }
  const checked = validation ?? validateTranscriptAgainstSerializedWorld(scope.serialized, submit.transcript);
  for (const error of checked.errors) errors.push(error);
  return errors;
}

function validateShadowPostState(reader: TranscriptCellReader, transcript: EffectTranscript): string[] {
  const errors: string[] = [];
  const finalWrites = finalWritesByCell(transcript);
  for (const write of finalWrites) {
    const actual = readTranscriptCell(reader, write.cell);
    if (!actual.ok) {
      errors.push(`post_state_mismatch ${cellLabel(write.cell)}: ${actual.error}`);
      continue;
    }
    if (write.next !== undefined && actual.version !== write.next) {
      errors.push(`post_state_mismatch ${cellLabel(write.cell)} version: transcript=${write.next} actual=${actual.version ?? "none"}`);
    }
    if (!writeValueMatchesPostState(write, actual.value, transcript)) {
      errors.push(`post_state_mismatch ${cellLabel(write.cell)} value`);
    }
  }

  for (const create of transcript.creates) {
    const obj = reader.objectById.get(create.object);
    if (!obj) {
      errors.push(`post_state_mismatch create ${create.object}: object missing`);
      continue;
    }
    const expectedLocation = lastMoveForObject(transcript, create.object)?.to ?? create.location;
    if (obj.parent !== create.parent) errors.push(`post_state_mismatch create ${create.object}: parent`);
    if (obj.owner !== create.owner) errors.push(`post_state_mismatch create ${create.object}: owner`);
    if (obj.anchor !== create.anchor) errors.push(`post_state_mismatch create ${create.object}: anchor`);
    if (obj.location !== expectedLocation) errors.push(`post_state_mismatch create ${create.object}: location`);
  }

  for (const move of transcript.moves) {
    const obj = reader.objectById.get(move.object);
    if (!obj || obj.location !== move.to) {
      errors.push(`post_state_mismatch move ${move.object}: location`);
    }
  }
  return errors;
}

export function finalWritesByCell(transcript: EffectTranscript): TranscriptWrite[] {
  const byCell = new Map<string, TranscriptWrite>();
  for (const write of transcript.writes) byCell.set(cellKey(write.cell), write);
  return Array.from(byCell.values());
}

function validateShadowWriteAuthority(serializedBefore: SerializedWorld, transcript: EffectTranscript): string[] {
  return validateShadowWriteAuthorityIndex(serializedAuthorityIndex(serializedBefore), transcript);
}

function validateShadowWriteAuthorityIndex(index: SerializedAuthorityIndex, transcript: EffectTranscript): string[] {
  const errors: string[] = [];
  const validWriters = new Map<string, boolean>();
  const authorizedCreates = new Map<ObjRef, TranscriptCreate>();
  if (transcript.session) {
    const session = index.sessionById.get(transcript.session);
    if (!session) errors.push(`permission_denied: session not found ${transcript.session}`);
    else if (session.actor !== transcript.call.actor) errors.push(`permission_denied: session actor mismatch ${transcript.session}`);
  }
  if (!serializedObject(index, transcript.call.actor)) {
    errors.push(`permission_denied: actor not found ${transcript.call.actor}`);
  }

  for (const create of transcript.creates) {
    if (!create.writer) {
      errors.push(`permission_denied: missing writer for create ${create.object}`);
      continue;
    }
    if (!recordedWriterIsValid(index, transcript, create.writer, validWriters)) {
      errors.push(`permission_denied: writer frame not recorded ${writerFrameLabel(create.writer)} for create ${create.object}`);
      continue;
    }
    if (canWriterCreateObject(index, create.writer.progr, create.parent, create.owner)) {
      authorizedCreates.set(create.object, create);
    } else {
      errors.push(`permission_denied: no recorded authority can create ${create.object}`);
    }
  }

  for (const write of transcript.writes) {
    if (!write.writer) {
      errors.push(`permission_denied: missing writer for ${cellLabel(write.cell)}`);
      continue;
    }
    if (!recordedWriterIsValid(index, transcript, write.writer, validWriters)) {
      errors.push(`permission_denied: writer frame not recorded ${writerFrameLabel(write.writer)} for ${cellLabel(write.cell)}`);
      continue;
    }
    const createdObject = authorizedCreates.get(write.cell.object);
    if (write.cell.kind === "lifecycle") {
      if (!createdObject || !writerCanInitializeCreatedObject(index, write.writer.progr, createdObject)) {
        errors.push(`permission_denied: no recorded authority can create ${write.cell.object}`);
      }
      continue;
    }
    if (createdObject && writerCanInitializeCreatedObject(index, write.writer.progr, createdObject)) {
      continue;
    }
    if (write.cell.kind === "prop" && !canWriterWriteProperty(index, write.writer.progr, write.cell.object, write.cell.name)) {
      errors.push(`permission_denied: no recorded authority can write ${cellLabel(write.cell)}`);
    }
    if (write.cell.kind === "location" && !canWriterControlObject(index, write.writer.progr, write.cell.object)) {
      errors.push(`permission_denied: no recorded authority can move ${write.cell.object}`);
    }
  }
  return errors;
}

function createShadowCommitScopeState(serialized: SerializedWorld): ShadowCommitScopeState {
  return {
    kind: "woo.commit_scope_state.shadow.v1",
    version: serialized.version,
    objectCounter: serialized.objectCounter,
    parkedTaskCounter: serialized.parkedTaskCounter,
    sessionCounter: serialized.sessionCounter,
    objectsById: new Map(serialized.objects.map((obj) => [obj.id, obj])),
    sessionsById: new Map(serialized.sessions.map((session) => [session.id, session])),
    logsByScope: new Map(serialized.logs.map(([space, entries]) => [space, entries] as const)),
    snapshots: serialized.snapshots,
    parkedTasks: serialized.parkedTasks,
    tombstones: serialized.tombstones,
    serializedRefs: serializedRefs(serialized)
  };
}

function ensureShadowCommitScopeState(scope: ShadowCommitScope): ShadowCommitScopeState {
  // Older transport/cache boundaries still mutate `scope.serialized` directly.
  // Rebuild the indexed view whenever those callers replace a top-level row
  // array; in-place row edits must call markShadowCommitScopeSerializedChanged.
  if (!stateMatchesSerializedRefs(scope.state, scope.serialized)) {
    scope.state = createShadowCommitScopeState(scope.serialized);
  }
  return scope.state;
}

function stateMatchesSerializedRefs(state: ShadowCommitScopeState, serialized: SerializedWorld): boolean {
  return state.serializedRefs.serialized === serialized &&
    state.serializedRefs.objects === serialized.objects &&
    state.serializedRefs.sessions === serialized.sessions &&
    state.serializedRefs.logs === serialized.logs &&
    state.serializedRefs.snapshots === serialized.snapshots &&
    state.serializedRefs.parkedTasks === serialized.parkedTasks &&
    state.serializedRefs.tombstones === serialized.tombstones;
}

function serializedRefs(serialized: SerializedWorld): ShadowCommitScopeSerializedRefs {
  return {
    serialized,
    objects: serialized.objects,
    sessions: serialized.sessions,
    logs: serialized.logs,
    snapshots: serialized.snapshots,
    parkedTasks: serialized.parkedTasks,
    tombstones: serialized.tombstones
  };
}

function cloneShadowCommitScopeState(current: ShadowCommitScopeState): ShadowCommitScopeState {
  return {
    ...current,
    objectsById: new Map(current.objectsById),
    sessionsById: new Map(current.sessionsById),
    logsByScope: new Map(current.logsByScope),
    snapshots: current.snapshots.slice(),
    parkedTasks: current.parkedTasks.slice(),
    tombstones: current.tombstones?.slice()
  };
}

function createCommitScopeStateCellReader(state: ShadowCommitScopeState): TranscriptCellReader {
  return createTranscriptCellReaderFromObjectMap(serializedShellFromCommitScopeState(state), state.objectsById);
}

function applyShadowTranscriptToIndexedState(
  current: ShadowCommitScopeState,
  transcript: EffectTranscript,
  options: ShadowTranscriptApplyOptions = {}
): ShadowCommitScopeState {
  const totalStartedAt = Date.now();
  const profile = (phase: (MetricEvent & { kind: "shadow_apply_step" })["phase"], startedAt: number) => {
    options.profile?.({
      kind: "shadow_apply_step",
      phase,
      scope: transcript.scope,
      route: transcript.route,
      ms: Date.now() - startedAt,
      objects: current.objectsById.size,
      creates: transcript.creates.length,
      writes: transcript.writes.length
    });
  };
  const next = cloneShadowCommitScopeState(current);
  const mutableObjects = new Set<ObjRef>();
  const mutableObject = (id: ObjRef): SerializedObject | null => {
    const existing = next.objectsById.get(id);
    if (!existing) return null;
    if (mutableObjects.has(id)) return existing;
    const clone = structuredClone(existing) as SerializedObject;
    next.objectsById.set(id, clone);
    mutableObjects.add(id);
    return clone;
  };

  // The indexed path keeps commit-scope objects in a Map and clones only rows
  // touched by the accepted transcript. Serialized arrays are materialized
  // after validation for existing transport/cache boundaries.
  let stepStartedAt = Date.now();
  for (const create of transcript.creates) {
    if (next.objectsById.has(create.object)) continue;
    const created = serializedObjectFromCreate(create, options.objectTimestamp);
    next.objectsById.set(create.object, created);
    mutableObjects.add(create.object);
    if (created.parent) addUniqueObjectRef(mutableObject(created.parent)?.children, created.id);
    if (created.location) addUniqueObjectRef(mutableObject(created.location)?.contents, created.id);
  }
  profile("apply_creates", stepStartedAt);
  stepStartedAt = Date.now();
  const writes = finalWritesByCell(transcript);
  profile("collect_writes", stepStartedAt);
  stepStartedAt = Date.now();
  for (const write of writes) {
    const target = mutableObject(write.cell.object);
    if (target) applyTranscriptWriteToSerializedObject(target, write, transcript, options);
  }
  profile("apply_writes", stepStartedAt);
  stepStartedAt = Date.now();
  applyTranscriptSessionLocationToState(next, transcript);
  profile("apply_session", stepStartedAt);
  stepStartedAt = Date.now();
  applyTranscriptLogToState(next, transcript);
  profile("apply_log", stepStartedAt);
  stepStartedAt = Date.now();
  next.objectCounter = nextObjectCounterForCreates(next.objectCounter, transcript.creates);
  profile("counters", stepStartedAt);
  profile("total", totalStartedAt);
  return next;
}

function applyTranscriptSessionLocationToState(state: ShadowCommitScopeState, transcript: EffectTranscript): void {
  const update = transcriptSessionActiveScope(transcript);
  if (!update) return;
  const session = state.sessionsById.get(update.session);
  if (!session || session.actor !== update.actor) return;
  state.sessionsById.set(update.session, { ...session, activeScope: update.activeScope });
}

function applyTranscriptLogToState(state: ShadowCommitScopeState, transcript: EffectTranscript): void {
  const entry = transcriptLogEntry(transcript);
  if (!entry) return;
  // The indexed state still materializes full log arrays for the scope-head
  // snapshot boundary, so this path remains O(N_log) for sequenced turns. Keep
  // the per-turn clone shallow here; eliminating the remaining copy belongs
  // with lazy full-snapshot/head hashing.
  const entries = (state.logsByScope.get(transcript.scope) ?? []).slice();
  mergeTranscriptLogEntry(entries, entry);
  state.logsByScope.set(transcript.scope, entries);
}

function commitShadowCommitScopeState(scope: ShadowCommitScope, state: ShadowCommitScopeState): SerializedWorld {
  const serialized = serializedWorldFromCommitScopeState(state);
  state.serializedRefs = serializedRefs(serialized);
  scope.state = state;
  return serialized;
}

function serializedWorldFromCommitScopeState(state: ShadowCommitScopeState): SerializedWorld {
  return {
    version: state.version,
    objectCounter: state.objectCounter,
    parkedTaskCounter: state.parkedTaskCounter,
    sessionCounter: state.sessionCounter,
    objects: Array.from(state.objectsById.values()).sort((a, b) => a.id.localeCompare(b.id)),
    sessions: Array.from(state.sessionsById.values()).sort((a, b) => a.id.localeCompare(b.id)),
    logs: Array.from(state.logsByScope.entries()).sort(([a], [b]) => a.localeCompare(b)),
    snapshots: state.snapshots,
    parkedTasks: state.parkedTasks,
    tombstones: state.tombstones
  };
}

function serializedShellFromCommitScopeState(state: ShadowCommitScopeState): SerializedWorld {
  return {
    version: state.version,
    objectCounter: state.objectCounter,
    parkedTaskCounter: state.parkedTaskCounter,
    sessionCounter: state.sessionCounter,
    objects: [],
    sessions: [],
    logs: [],
    snapshots: state.snapshots,
    parkedTasks: state.parkedTasks,
    tombstones: state.tombstones
  };
}

export function applyShadowTranscriptToCommittedState(
  current: SerializedWorld,
  transcript: EffectTranscript,
  options: ShadowTranscriptApplyOptions = {}
): SerializedWorld {
  const totalStartedAt = Date.now();
  const profile = (phase: (MetricEvent & { kind: "shadow_apply_step" })["phase"], startedAt: number) => {
    options.profile?.({
      kind: "shadow_apply_step",
      phase,
      scope: transcript.scope,
      route: transcript.route,
      ms: Date.now() - startedAt,
      objects: current.objects.length,
      creates: transcript.creates.length,
      writes: transcript.writes.length
    });
  };
  let stepStartedAt = Date.now();
  const next: SerializedWorld = {
    ...current,
    objects: current.objects.slice()
  };
  profile("clone_world", stepStartedAt);
  stepStartedAt = Date.now();
  const currentObjects = new Map<ObjRef, SerializedObject>(next.objects.map((obj) => [obj.id, obj]));
  const objectIndexes = new Map<ObjRef, number>(next.objects.map((obj, index) => [obj.id, index]));
  const mutableObjects = new Set<ObjRef>();
  let objectsNeedSort = false;
  const mutableObject = (id: ObjRef): SerializedObject | null => {
    const existing = currentObjects.get(id);
    if (!existing) return null;
    if (mutableObjects.has(id)) return existing;
    const clone = structuredClone(existing) as SerializedObject;
    currentObjects.set(id, clone);
    mutableObjects.add(id);
    const index = objectIndexes.get(id);
    if (index !== undefined) next.objects[index] = clone;
    return clone;
  };
  profile("index_objects", stepStartedAt);

  // The commit scope constructs authoritative post-state from the transcript.
  // Executor post-world snapshots are intentionally not trusted across this
  // boundary; they are diagnostics/cache-fill only.
  stepStartedAt = Date.now();
  for (const create of transcript.creates) {
    if (currentObjects.has(create.object)) continue;
    const created = serializedObjectFromCreate(create, options.objectTimestamp);
    currentObjects.set(create.object, created);
    objectIndexes.set(create.object, next.objects.length);
    mutableObjects.add(create.object);
    next.objects.push(created);
    objectsNeedSort = true;
    if (created.parent) addUniqueObjectRef(mutableObject(created.parent)?.children, created.id);
    if (created.location) addUniqueObjectRef(mutableObject(created.location)?.contents, created.id);
  }
  profile("apply_creates", stepStartedAt);
  stepStartedAt = Date.now();
  const writes = finalWritesByCell(transcript);
  profile("collect_writes", stepStartedAt);
  stepStartedAt = Date.now();
  for (const write of writes) {
    const target = mutableObject(write.cell.object);
    if (target) applyTranscriptWriteToSerializedObject(target, write, transcript, options);
  }
  profile("apply_writes", stepStartedAt);
  stepStartedAt = Date.now();
  next.sessions = applyTranscriptSessionLocation(current.sessions, transcript);
  profile("apply_session", stepStartedAt);
  stepStartedAt = Date.now();
  if (objectsNeedSort) next.objects.sort((a, b) => a.id.localeCompare(b.id));
  profile("sort_objects", stepStartedAt);
  stepStartedAt = Date.now();
  next.logs = applyTranscriptLog(current.logs, transcript);
  profile("apply_log", stepStartedAt);
  stepStartedAt = Date.now();
  next.objectCounter = nextObjectCounterForCreates(next.objectCounter, transcript.creates);
  profile("counters", stepStartedAt);
  profile("total", totalStartedAt);
  return next;
}

export function transcriptSessionActiveScope(transcript: EffectTranscript): { session: string; actor: ObjRef; activeScope: ObjRef } | null {
  if (!transcript.session) return null;
  const actorMove = lastMoveForObject(transcript, transcript.call.actor);
  if (!actorMove) return null;
  return { session: transcript.session, actor: transcript.call.actor, activeScope: actorMove.to };
}

export function transcriptTouchedObjectIds(transcript: EffectTranscript): Set<ObjRef> {
  const ids = new Set<ObjRef>();
  for (const create of transcript.creates) {
    ids.add(create.object);
    if (create.anchor) ids.add(create.anchor);
    if (create.parent) ids.add(create.parent);
    if (create.location) ids.add(create.location);
  }
  for (const write of transcript.writes) {
    if (write.cell.kind === "prop" || write.cell.kind === "location" || write.cell.kind === "contents" || write.cell.kind === "lifecycle") {
      ids.add(write.cell.object);
    }
  }
  return ids;
}

function applyTranscriptSessionLocation(sessions: SerializedWorld["sessions"], transcript: EffectTranscript): SerializedWorld["sessions"] {
  const update = transcriptSessionActiveScope(transcript);
  if (!update) return sessions;
  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index];
    if (session.id === update.session && session.actor === update.actor) {
      const next = sessions.slice();
      next[index] = { ...session, activeScope: update.activeScope };
      return next;
    }
  }
  return sessions;
}

function serializedObjectFromCreate(create: TranscriptCreate, objectTimestamp: number | undefined): SerializedObject {
  const timestamp = objectTimestamp ?? 0;
  return serializedObjectForTranscriptCreate(create, timestamp);
}

export function serializedObjectForTranscriptCreate(create: TranscriptCreate, timestamp: number): SerializedObject {
  return {
    id: create.object,
    name: create.name,
    parent: create.parent,
    owner: create.owner,
    location: create.location,
    anchor: create.anchor,
    flags: structuredClone(create.flags) as SerializedObject["flags"],
    created: timestamp,
    modified: timestamp,
    propertyDefs: [],
    properties: [],
    propertyVersions: [],
    verbs: [],
    children: [],
    contents: [],
    eventSchemas: []
  };
}

export function transcriptLogEntry(transcript: EffectTranscript): SerializedWorld["logs"][number][1][number] | null {
  if (transcript.route !== "sequenced") return null;
  const message = {
    actor: transcript.call.actor,
    target: transcript.call.target,
    verb: transcript.call.verb,
    args: structuredClone(transcript.call.args) as WooValue[]
  };
  return {
    space: transcript.scope,
    seq: transcript.seq,
    ts: 0,
    actor: transcript.call.actor,
    message,
    observations: structuredClone(transcript.observations) as EffectTranscript["observations"],
    applied_ok: transcript.error === undefined,
    ...(transcript.error ? { error: structuredClone(transcript.error) } : {})
  };
}

function applyTranscriptLog(logEntries: SerializedWorld["logs"], transcript: EffectTranscript): SerializedWorld["logs"] {
  const entry = transcriptLogEntry(transcript);
  if (!entry) return logEntries;
  const next = logEntries.slice();
  const index = next.findIndex(([space]) => space === transcript.scope);
  const entries = index >= 0
    ? structuredClone(next[index][1]) as SerializedWorld["logs"][number][1]
    : [];
  mergeTranscriptLogEntry(entries, entry);
  if (index >= 0) {
    next[index] = [transcript.scope, entries];
    return next;
  }
  next.push([transcript.scope, entries]);
  return next.sort(([a], [b]) => a.localeCompare(b));
}

export function mergeTranscriptLogEntry(entries: SpaceLogEntryLike[], entry: SpaceLogEntryLike): void {
  const existing = entries.findIndex((item) => item.seq === entry.seq);
  if (existing >= 0) entries[existing] = entry;
  else entries.push(entry);
  entries.sort((a, b) => a.seq - b.seq);
}

type SpaceLogEntryLike = SerializedWorld["logs"][number][1][number];

export function applyTranscriptWriteToSerializedObject(
  target: SerializedObject,
  write: TranscriptWrite,
  transcript: EffectTranscript,
  options: ShadowTranscriptApplyOptions = {}
): void {
  // Keep this serialized-object materializer parallel with
  // WooWorld.applyTranscriptWriteInPlace. The storage shapes differ, but the
  // accepted transcript semantics must stay identical.
  switch (write.cell.kind) {
    case "prop":
      applyPropWrite(target, write);
      touchSerializedObject(target, options.objectTimestamp);
      return;
    case "location":
      if (typeof write.value === "string" || write.value === null) target.location = write.value;
      touchSerializedObject(target, options.objectTimestamp);
      return;
    case "contents":
      applyTranscriptContentsWrite(target, write, transcript, options.metric);
      touchSerializedObject(target, options.objectTimestamp);
      return;
    case "lifecycle": {
      // Recycle/delete materialization is still outside the shadow applier.
      // The transcript records the cell for validation, but the commit scope's
      // full serialized state remains the authority for that effect.
      return;
    }
    case "verb":
      // The shadow recorder currently observes verb reads, not verb writes, so
      // accepted verb-edit materialization is intentionally not implemented.
      return;
  }
}

function applyTranscriptContentsWrite(
  target: SerializedObject,
  write: TranscriptWrite,
  transcript: EffectTranscript,
  metric?: (event: MetricEvent) => void
): void {
  target.contents = applyTranscriptContentsWriteRefs(target.contents, write, transcript, metric);
}

export function applyTranscriptContentsWriteRefs(
  current: readonly ObjRef[],
  write: TranscriptWrite,
  transcript: EffectTranscript,
  metric?: (event: MetricEvent) => void
): ObjRef[] {
  // Move/create transcripts record whole post-write contents arrays for
  // validation, but committed replay must merge the operation intent. Replacing
  // the array here would drop concurrent adds already accepted into the base.
  const refs = transcriptContentsWriteRefs(write);
  if (write.op === "add") {
    const next = current.slice();
    const added = transcriptContentAddsForContainer(transcript, write.cell.object);
    for (const ref of (added.length > 0 ? added : refs)) addUniqueObjectRef(next, ref);
    return next;
  }
  if (write.op === "remove") {
    const removed = transcriptContentRemovesForContainer(transcript, write.cell.object);
    if (removed.length > 0) {
      const remove = new Set(removed);
      return current.filter((ref) => !remove.has(ref));
    }
    metric?.({
      kind: "shadow_transcript_anomaly",
      scope: transcript.scope,
      route: transcript.route,
      reason: "contents_remove_without_move",
      object: write.cell.object,
      ...(transcript.id ? { id: transcript.id } : {})
    });
    return current.slice();
  }
  return refs;
}

function transcriptContentsWriteRefs(write: TranscriptWrite): ObjRef[] {
  return Array.isArray(write.value)
    ? write.value.filter((item): item is ObjRef => typeof item === "string")
    : [];
}

function transcriptContentAddsForContainer(transcript: EffectTranscript, container: ObjRef): ObjRef[] {
  const refs = new Set<ObjRef>();
  for (const move of transcript.moves) {
    if (move.to === container) refs.add(move.object);
  }
  for (const create of transcript.creates) {
    if (create.location === container) refs.add(create.object);
  }
  return Array.from(refs).sort();
}

function transcriptContentRemovesForContainer(transcript: EffectTranscript, container: ObjRef): ObjRef[] {
  const refs = new Set<ObjRef>();
  for (const move of transcript.moves) {
    if (move.from === container) refs.add(move.object);
  }
  return Array.from(refs).sort();
}

function touchSerializedObject(target: SerializedObject, objectTimestamp: number | undefined): void {
  if (objectTimestamp !== undefined) target.modified = objectTimestamp;
}

function applyPropWrite(target: SerializedObject, write: TranscriptWrite): void {
  // Keep this parallel with WooWorld.applyTranscriptPropWriteInPlace.
  if (write.cell.kind !== "prop") return;
  const propName = write.cell.name;
  if (write.op === "remove") {
    target.properties = target.properties.filter(([name]) => name !== propName);
    target.propertyVersions = target.propertyVersions.filter(([name]) => name !== propName);
    return;
  }
  const value = structuredClone(write.value) as WooValue;
  setSerializedProperty(target, propName, value);
  if (propName === "name" && typeof value === "string") target.name = value;
  setSerializedPropertyVersion(target, propName, write.next);
}

function setSerializedProperty(target: SerializedObject, name: string, value: WooValue): void {
  const index = target.properties.findIndex(([prop]) => prop === name);
  if (index >= 0) target.properties[index] = [name, value];
  else target.properties.push([name, value]);
  target.properties.sort(([a], [b]) => a.localeCompare(b));
}

function setSerializedPropertyVersion(target: SerializedObject, name: string, version: string | undefined): void {
  const parsed = version === undefined ? null : Number(version);
  const nextVersion: number = parsed !== null && Number.isInteger(parsed) && parsed >= 0
    ? parsed
    : (target.propertyVersions.find(([prop]) => prop === name)?.[1] ?? 0) + 1;
  const index = target.propertyVersions.findIndex(([prop]) => prop === name);
  if (index >= 0) target.propertyVersions[index] = [name, nextVersion];
  else target.propertyVersions.push([name, nextVersion]);
  target.propertyVersions.sort(([a], [b]) => a.localeCompare(b));
}

function addUniqueObjectRef(list: ObjRef[] | undefined, id: ObjRef): void {
  if (!list || list.includes(id)) return;
  list.push(id);
  list.sort();
}

export function nextObjectCounterForCreates(current: number, creates: TranscriptCreate[]): number {
  let next = current;
  for (const create of creates) {
    const match = create.object.match(/_(\d+)$/);
    if (!match) continue;
    next = Math.max(next, Number(match[1]) + 1);
  }
  return next;
}

function recordedWriterIsValid(
  index: SerializedAuthorityIndex,
  transcript: EffectTranscript,
  writer: RecordedWriteAuthority,
  validWriters: Map<string, boolean>
): boolean {
  const key = stableShadowJson(writer as unknown as WooValue);
  const cached = validWriters.get(key);
  if (cached !== undefined) return cached;
  const valid =
    serializedObject(index, writer.progr) !== undefined &&
    transcript.reads.some((read) => {
      if (read.cell.kind !== "verb" || read.cell.object !== writer.definer || read.cell.name !== writer.verb) return false;
      if (!read.value || typeof read.value !== "object" || Array.isArray(read.value)) return false;
      return (read.value as Record<string, WooValue>).owner === writer.progr;
    });
  validWriters.set(key, valid);
  return valid;
}

function writerFrameLabel(writer: RecordedWriteAuthority): string {
  return `${writer.progr} ${writer.definer}:${writer.verb} this=${writer.thisObj}`;
}

function canWriterWriteProperty(index: SerializedAuthorityIndex, writer: ObjRef, object: ObjRef, name: string): boolean {
  const target = serializedObject(index, object);
  if (!target) return false;
  const info = serializedPropertyInfo(index, object, name);
  if (isWizard(index, writer)) return true;
  if (!info && target.owner === writer) return true;
  return info !== null && (info.owner === writer || String(info.perms).includes("w"));
}

function canWriterControlObject(index: SerializedAuthorityIndex, writer: ObjRef, object: ObjRef): boolean {
  const target = serializedObject(index, object);
  if (!target) return false;
  return isWizard(index, writer) || target.owner === writer;
}

function canWriterCreateObject(index: SerializedAuthorityIndex, writer: ObjRef, parent: ObjRef | null, owner: ObjRef): boolean {
  if (!parent) return false;
  const parentObj = serializedObject(index, parent);
  if (!parentObj) return false;
  if (isWizard(index, writer)) return true;
  return owner === writer && (parentObj.owner === writer || parentObj.flags.fertile === true);
}

function writerCanInitializeCreatedObject(index: SerializedAuthorityIndex, writer: ObjRef, create: TranscriptCreate): boolean {
  return isWizard(index, writer) || create.owner === writer;
}

function serializedPropertyInfo(index: SerializedAuthorityIndex, object: ObjRef, name: string): { owner: ObjRef; perms: string } | null {
  let current = serializedObject(index, object);
  while (current) {
    const def = current.propertyDefs.find((item) => item.name === name);
    if (def) return { owner: def.owner, perms: def.perms };
    current = current.parent ? serializedObject(index, current.parent) : undefined;
  }
  return null;
}

type SerializedAuthorityIndex = {
  objectById: Map<ObjRef, SerializedObject>;
  sessionById: Map<string, SerializedWorld["sessions"][number]>;
};

function serializedAuthorityIndex(serialized: SerializedWorld): SerializedAuthorityIndex {
  return {
    objectById: new Map(serialized.objects.map((obj) => [obj.id, obj])),
    sessionById: new Map(serialized.sessions.map((session) => [session.id, session]))
  };
}

function serializedAuthorityIndexFromState(state: ShadowCommitScopeState): SerializedAuthorityIndex {
  return {
    objectById: state.objectsById,
    sessionById: state.sessionsById
  };
}

function serializedObject(index: SerializedAuthorityIndex, id: ObjRef): SerializedObject | undefined {
  return index.objectById.get(id);
}

function isWizard(index: SerializedAuthorityIndex, id: ObjRef): boolean {
  return serializedObject(index, id)?.flags.wizard === true;
}

function writeValueMatchesPostState(write: TranscriptWrite, actual: WooValue, transcript: EffectTranscript): boolean {
  if (write.cell.kind === "lifecycle" && write.op === "create") return actual === "present";
  if (write.cell.kind === "contents") return contentsWriteMatchesPostState(write, actual, transcript);
  return stableShadowJson(write.value) === stableShadowJson(actual);
}

function contentsWriteMatchesPostState(write: TranscriptWrite, actual: WooValue, transcript: EffectTranscript): boolean {
  if (!Array.isArray(actual)) return false;
  const actualRefs = new Set(actual.filter((item): item is ObjRef => typeof item === "string"));
  if (write.op === "add") {
    const added = transcriptContentAddsForContainer(transcript, write.cell.object);
    const required = added.length > 0 ? added : transcriptContentsWriteRefs(write);
    return required.every((ref) => actualRefs.has(ref));
  }
  if (write.op === "remove") {
    const removed = transcriptContentRemovesForContainer(transcript, write.cell.object);
    if (removed.length > 0) return removed.every((ref) => !actualRefs.has(ref));
  }
  return stableShadowJson(write.value) === stableShadowJson(actual);
}

function lastMoveForObject(transcript: EffectTranscript, object: ObjRef): { object: ObjRef; from: ObjRef | null; to: ObjRef } | undefined {
  for (let i = transcript.moves.length - 1; i >= 0; i--) {
    const move = transcript.moves[i];
    if (move.object === object) return move;
  }
  return undefined;
}

function shadowConflictReason(errors: string[]): ShadowCommitConflict["reason"] {
  if (errors.some((error) => error.startsWith("stale_head"))) return "stale_head";
  if (errors.some((error) => error.startsWith("scope_mismatch"))) return "scope_mismatch";
  if (errors.some((error) => error.startsWith("permission_denied"))) return "permission_denied";
  if (errors.some((error) => error.startsWith("post_state_mismatch"))) return "post_state_mismatch";
  if (errors.some((error) => error.startsWith("incomplete"))) return "incomplete_transcript";
  if (errors.some((error) => error.includes("version mismatch") || error.includes("value mismatch"))) return "read_version_mismatch";
  return "nondeterministic";
}

function sameShadowHead(a: ShadowScopeHead, b: ShadowScopeHead): boolean {
  return a.scope === b.scope && a.epoch === b.epoch && a.seq === b.seq && a.hash === b.hash;
}

function cellLabel(cell: TranscriptCell): string {
  switch (cell.kind) {
    case "prop":
      return `${cell.object}.${cell.name}`;
    case "verb":
      return `${cell.object}:${cell.name}`;
    case "location":
      return `${cell.object}.location`;
    case "contents":
      return `${cell.object}.contents`;
    case "lifecycle":
      return `${cell.object}.lifecycle`;
  }
}

function cellKey(cell: TranscriptCell): string {
  return stableShadowJson(cell as unknown as WooValue);
}
