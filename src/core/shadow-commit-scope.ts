import type { SerializedObject, SerializedWorld } from "./repository";
import {
  readTranscriptCellFromSerializedWorld,
  validateTranscriptAgainstSerializedWorld,
  type EffectTranscript,
  type TranscriptCell,
  type TranscriptWrite
} from "./effect-transcript";
import { stableShadowJson } from "./shadow-cell-version";
import { hashSource } from "./source-hash";
import { shadowCommitReceipt, type ShadowCommitReceipt } from "./turn-commit";
import type { ObjRef, WooValue } from "./types";

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
  serialized_after: SerializedWorld;
  executor?: string;
};

export type ShadowCommitAccepted = {
  kind: "woo.commit.accepted.shadow.v1";
  id?: string;
  position: ShadowScopeHead;
  transcript_hash: string;
  post_state_hash: string;
  observations: EffectTranscript["observations"];
  receipt: ShadowCommitReceipt;
  serialized_after: SerializedWorld;
};

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
  submissions: Map<string, ShadowCommitResult>;
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
    submissions: new Map()
  };
}

export function shadowScopeHeadForSerialized(scope: ObjRef, epoch: number, serialized: SerializedWorld): ShadowScopeHead {
  const seq = serialized.logs
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

export function submitShadowCommit(scope: ShadowCommitScope, submit: ShadowCommitSubmit): ShadowCommitResult {
  const submissionId = submit.id ?? submit.transcript.id;
  if (submissionId) {
    const existing = scope.submissions.get(submissionId);
    if (existing) return existing;
  }

  // Shadow commit receives executor post-state as a prototype shortcut. The
  // authoritative scope must merge touched records into its full state rather
  // than trust a partial executor shard as the whole world.
  const mergedAfter = mergeShadowCommittedState(scope.serialized, submit.serialized_after, submit.transcript);
  const extraErrors = shadowCommitEnvelopeErrors(scope, submit);
  extraErrors.push(...validateShadowPostState(mergedAfter, submit.transcript));
  extraErrors.push(...validateShadowWriteAuthority(scope.serialized, submit.transcript));

  const receipt = shadowCommitReceipt(scope.serialized, mergedAfter, submit.transcript, extraErrors);
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
    if (submissionId) scope.submissions.set(submissionId, conflict);
    return conflict;
  }

  scope.serialized = mergedAfter;
  scope.head = shadowScopeHeadForSerialized(scope.scope, scope.epoch, scope.serialized);
  const accepted: ShadowCommitAccepted = {
    kind: "woo.commit.accepted.shadow.v1",
    id: submissionId,
    position: scope.head,
    transcript_hash: submit.transcript.hash,
    post_state_hash: receipt.post_state_hash,
    observations: submit.transcript.observations,
    receipt,
    serialized_after: structuredClone(scope.serialized) as SerializedWorld
  };
  if (submissionId) scope.submissions.set(submissionId, accepted);
  return accepted;
}

function shadowCommitEnvelopeErrors(scope: ShadowCommitScope, submit: ShadowCommitSubmit): string[] {
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
  const validation = validateTranscriptAgainstSerializedWorld(scope.serialized, submit.transcript);
  for (const error of validation.errors) errors.push(error);
  return errors;
}

function validateShadowPostState(serializedAfter: SerializedWorld, transcript: EffectTranscript): string[] {
  const errors: string[] = [];
  for (const write of transcript.writes) {
    const actual = readTranscriptCellFromSerializedWorld(serializedAfter, write.cell);
    if (!actual.ok) {
      errors.push(`post_state_mismatch ${cellLabel(write.cell)}: ${actual.error}`);
      continue;
    }
    if (write.next !== undefined && actual.version !== write.next) {
      errors.push(`post_state_mismatch ${cellLabel(write.cell)} version: transcript=${write.next} actual=${actual.version ?? "none"}`);
    }
    if (!writeValueMatchesPostState(write, actual.value)) {
      errors.push(`post_state_mismatch ${cellLabel(write.cell)} value`);
    }
  }

  for (const create of transcript.creates) {
    const obj = serializedObject(serializedAfter, create.object);
    if (!obj) {
      errors.push(`post_state_mismatch create ${create.object}: object missing`);
      continue;
    }
    if (obj.parent !== create.parent) errors.push(`post_state_mismatch create ${create.object}: parent`);
    if (obj.owner !== create.owner) errors.push(`post_state_mismatch create ${create.object}: owner`);
    if (obj.anchor !== create.anchor) errors.push(`post_state_mismatch create ${create.object}: anchor`);
    if (obj.location !== create.location) errors.push(`post_state_mismatch create ${create.object}: location`);
  }

  for (const move of transcript.moves) {
    const obj = serializedObject(serializedAfter, move.object);
    if (!obj || obj.location !== move.to) {
      errors.push(`post_state_mismatch move ${move.object}: location`);
    }
  }
  return errors;
}

function validateShadowWriteAuthority(serializedBefore: SerializedWorld, transcript: EffectTranscript): string[] {
  const errors: string[] = [];
  // The transcript does not yet attach each write to a VM frame/progr. Use the
  // call actor plus recorded dispatch owners as a conservative shadow stand-in
  // until frame-level authority is carried in the transcript.
  const candidates = shadowWriterCandidates(transcript);
  if (transcript.session) {
    const session = serializedBefore.sessions.find((item) => item.id === transcript.session);
    if (!session) errors.push(`permission_denied: session not found ${transcript.session}`);
    else if (session.actor !== transcript.call.actor) errors.push(`permission_denied: session actor mismatch ${transcript.session}`);
  }
  if (!serializedObject(serializedBefore, transcript.call.actor)) {
    errors.push(`permission_denied: actor not found ${transcript.call.actor}`);
  }

  for (const write of transcript.writes) {
    if (write.cell.kind === "prop" && !canAnyCandidateWriteProperty(serializedBefore, candidates, write.cell.object, write.cell.name)) {
      errors.push(`permission_denied: no recorded authority can write ${cellLabel(write.cell)}`);
    }
    if (write.cell.kind === "location" && !canAnyCandidateControlObject(serializedBefore, candidates, write.cell.object)) {
      errors.push(`permission_denied: no recorded authority can move ${write.cell.object}`);
    }
  }

  for (const create of transcript.creates) {
    if (!canAnyCandidateCreateObject(serializedBefore, candidates, create.parent, create.owner)) {
      errors.push(`permission_denied: no recorded authority can create ${create.object}`);
    }
  }
  return errors;
}

function mergeShadowCommittedState(current: SerializedWorld, executorAfter: SerializedWorld, transcript: EffectTranscript): SerializedWorld {
  const next = structuredClone(current) as SerializedWorld;
  const currentObjects = new Map<ObjRef, SerializedObject>(next.objects.map((obj) => [obj.id, obj]));
  const executorObjects = new Map<ObjRef, SerializedObject>(executorAfter.objects.map((obj) => [obj.id, obj]));
  // Object records are the current transfer granularity, so a touched object is
  // the smallest post-state unit the commit scope can safely merge today.
  for (const id of touchedObjectIds(transcript)) {
    const obj = executorObjects.get(id);
    if (obj) currentObjects.set(id, structuredClone(obj) as SerializedObject);
  }
  next.objects = Array.from(currentObjects.values()).sort((a, b) => a.id.localeCompare(b.id));

  const logs = new Map<ObjRef, SerializedWorld["logs"][number][1]>(next.logs.map(([space, entries]) => [space, entries]));
  for (const [space, entries] of executorAfter.logs) {
    if (space === transcript.scope) logs.set(space, structuredClone(entries) as SerializedWorld["logs"][number][1]);
  }
  next.logs = Array.from(logs.entries()).sort(([a], [b]) => a.localeCompare(b));

  const sessions = new Map(next.sessions.map((session) => [session.id, session]));
  for (const session of executorAfter.sessions) sessions.set(session.id, structuredClone(session) as typeof session);
  next.sessions = Array.from(sessions.values()).sort((a, b) => a.id.localeCompare(b.id));

  const snapshotKey = (snapshot: SerializedWorld["snapshots"][number]) => `${snapshot.space_id}:${snapshot.seq}:${snapshot.hash}`;
  const snapshots = new Map(next.snapshots.map((snapshot) => [snapshotKey(snapshot), snapshot]));
  for (const snapshot of executorAfter.snapshots) snapshots.set(snapshotKey(snapshot), structuredClone(snapshot) as typeof snapshot);
  next.snapshots = Array.from(snapshots.values()).sort((a, b) =>
    a.space_id.localeCompare(b.space_id) || a.seq - b.seq || a.hash.localeCompare(b.hash)
  );

  const parkedTasks = new Map(next.parkedTasks.map((task) => [task.id, task]));
  for (const task of executorAfter.parkedTasks) parkedTasks.set(task.id, structuredClone(task) as typeof task);
  next.parkedTasks = Array.from(parkedTasks.values()).sort((a, b) => a.id.localeCompare(b.id));
  next.tombstones = Array.from(new Set([...(next.tombstones ?? []), ...(executorAfter.tombstones ?? [])])).sort();
  next.objectCounter = Math.max(next.objectCounter, executorAfter.objectCounter);
  next.parkedTaskCounter = Math.max(next.parkedTaskCounter, executorAfter.parkedTaskCounter);
  next.sessionCounter = Math.max(next.sessionCounter, executorAfter.sessionCounter);
  return next;
}

function touchedObjectIds(transcript: EffectTranscript): Set<ObjRef> {
  const ids = new Set<ObjRef>();
  for (const write of transcript.writes) ids.add(write.cell.object);
  for (const create of transcript.creates) ids.add(create.object);
  for (const move of transcript.moves) {
    ids.add(move.object);
    if (move.from) ids.add(move.from);
    ids.add(move.to);
  }
  return ids;
}

function shadowWriterCandidates(transcript: EffectTranscript): Set<ObjRef> {
  const candidates = new Set<ObjRef>([transcript.call.actor]);
  for (const read of transcript.reads) {
    if (read.cell.kind !== "verb") continue;
    if (!read.value || typeof read.value !== "object" || Array.isArray(read.value)) continue;
    const owner = (read.value as Record<string, WooValue>).owner;
    if (typeof owner === "string") candidates.add(owner);
  }
  return candidates;
}

function canAnyCandidateWriteProperty(serialized: SerializedWorld, candidates: Set<ObjRef>, object: ObjRef, name: string): boolean {
  const target = serializedObject(serialized, object);
  if (!target) return false;
  const info = serializedPropertyInfo(serialized, object, name);
  for (const candidate of candidates) {
    if (isWizard(serialized, candidate)) return true;
    if (!info && target.owner === candidate) return true;
    if (info && (info.owner === candidate || String(info.perms).includes("w"))) return true;
  }
  return false;
}

function canAnyCandidateControlObject(serialized: SerializedWorld, candidates: Set<ObjRef>, object: ObjRef): boolean {
  const target = serializedObject(serialized, object);
  if (!target) return false;
  for (const candidate of candidates) {
    if (isWizard(serialized, candidate) || target.owner === candidate) return true;
  }
  return false;
}

function canAnyCandidateCreateObject(serialized: SerializedWorld, candidates: Set<ObjRef>, parent: ObjRef | null, owner: ObjRef): boolean {
  if (!parent) return false;
  const parentObj = serializedObject(serialized, parent);
  if (!parentObj) return false;
  for (const candidate of candidates) {
    if (isWizard(serialized, candidate)) return true;
    if (owner !== candidate) continue;
    if (parentObj.owner === candidate || parentObj.flags.fertile === true) return true;
  }
  return false;
}

function serializedPropertyInfo(serialized: SerializedWorld, object: ObjRef, name: string): { owner: ObjRef; perms: string } | null {
  let current = serializedObject(serialized, object);
  while (current) {
    const def = current.propertyDefs.find((item) => item.name === name);
    if (def) return { owner: def.owner, perms: def.perms };
    current = current.parent ? serializedObject(serialized, current.parent) : undefined;
  }
  return null;
}

function serializedObject(serialized: SerializedWorld, id: ObjRef): SerializedObject | undefined {
  return serialized.objects.find((obj) => obj.id === id);
}

function isWizard(serialized: SerializedWorld, id: ObjRef): boolean {
  return serializedObject(serialized, id)?.flags.wizard === true;
}

function writeValueMatchesPostState(write: TranscriptWrite, actual: WooValue): boolean {
  if (write.cell.kind === "lifecycle" && write.op === "create") return actual === "present";
  return stableShadowJson(write.value) === stableShadowJson(actual);
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
