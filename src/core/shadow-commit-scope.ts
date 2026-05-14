import type { SerializedObject, SerializedWorld } from "./repository";
import {
  readTranscriptCellFromSerializedWorld,
  validateTranscriptAgainstSerializedWorld,
  type EffectTranscript,
  type TranscriptCell,
  type TranscriptCreate,
  type TranscriptWrite
} from "./effect-transcript";
import { stableShadowJson } from "./shadow-cell-version";
import { hashSource } from "./source-hash";
import { shadowCommitReceipt, type ShadowCommitReceipt } from "./turn-commit";
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
};

export type ShadowCommitAccepted = {
  kind: "woo.commit.accepted.shadow.v1";
  id?: string;
  position: ShadowScopeHead;
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
  submissions: Map<string, ShadowCommitResult>;
};

export type ShadowTranscriptApplyOptions = {
  objectTimestamp?: number;
  profile?: (event: MetricEvent & { kind: "shadow_apply_step" }) => void;
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

export function submitShadowCommit(scope: ShadowCommitScope, submit: ShadowCommitSubmit): ShadowCommitResult {
  const submissionId = submit.id ?? submit.transcript.id;
  if (submissionId) {
    const existing = scope.submissions.get(submissionId);
    if (existing) return existing;
  }

  const mergedAfter = applyShadowTranscriptToCommittedState(scope.serialized, submit.transcript, { profile: submit.profile });
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
  // Shadow commit scopes sequence accepted transcripts independently of the
  // legacy durable space log. The serialized state is still in the hash, but
  // browser catch-up needs every accepted v2 commit to advance the head.
  scope.head = shadowScopeHeadForSerialized(scope.scope, scope.epoch, scope.serialized, scope.head.seq + 1);
  const accepted: ShadowCommitAccepted = {
    kind: "woo.commit.accepted.shadow.v1",
    id: submissionId,
    position: scope.head,
    transcript_hash: submit.transcript.hash,
    post_state_hash: receipt.post_state_hash,
    observations: submit.transcript.observations,
    receipt
  };
  if (submissionId) scope.submissions.set(submissionId, accepted);
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
  scope.serialized = applyShadowTranscriptToCommittedState(scope.serialized, transcript);
  scope.head = structuredClone(accepted.position) as ShadowScopeHead;
  if (accepted.id) scope.submissions.set(accepted.id, structuredClone(accepted) as ShadowCommitAccepted);
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
  const finalWrites = finalWritesByCell(transcript);
  for (const write of finalWrites) {
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
    const expectedLocation = lastMoveForObject(transcript, create.object)?.to ?? create.location;
    if (obj.parent !== create.parent) errors.push(`post_state_mismatch create ${create.object}: parent`);
    if (obj.owner !== create.owner) errors.push(`post_state_mismatch create ${create.object}: owner`);
    if (obj.anchor !== create.anchor) errors.push(`post_state_mismatch create ${create.object}: anchor`);
    if (obj.location !== expectedLocation) errors.push(`post_state_mismatch create ${create.object}: location`);
  }

  for (const move of transcript.moves) {
    const obj = serializedObject(serializedAfter, move.object);
    if (!obj || obj.location !== move.to) {
      errors.push(`post_state_mismatch move ${move.object}: location`);
    }
  }
  return errors;
}

function finalWritesByCell(transcript: EffectTranscript): TranscriptWrite[] {
  const byCell = new Map<string, TranscriptWrite>();
  for (const write of transcript.writes) byCell.set(cellKey(write.cell), write);
  return Array.from(byCell.values());
}

function validateShadowWriteAuthority(serializedBefore: SerializedWorld, transcript: EffectTranscript): string[] {
  const errors: string[] = [];
  const validWriters = new Map<string, boolean>();
  const authorizedCreates = new Map<ObjRef, TranscriptCreate>();
  if (transcript.session) {
    const session = serializedBefore.sessions.find((item) => item.id === transcript.session);
    if (!session) errors.push(`permission_denied: session not found ${transcript.session}`);
    else if (session.actor !== transcript.call.actor) errors.push(`permission_denied: session actor mismatch ${transcript.session}`);
  }
  if (!serializedObject(serializedBefore, transcript.call.actor)) {
    errors.push(`permission_denied: actor not found ${transcript.call.actor}`);
  }

  for (const create of transcript.creates) {
    if (!create.writer) {
      errors.push(`permission_denied: missing writer for create ${create.object}`);
      continue;
    }
    if (!recordedWriterIsValid(serializedBefore, transcript, create.writer, validWriters)) {
      errors.push(`permission_denied: writer frame not recorded ${writerFrameLabel(create.writer)} for create ${create.object}`);
      continue;
    }
    if (canWriterCreateObject(serializedBefore, create.writer.progr, create.parent, create.owner)) {
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
    if (!recordedWriterIsValid(serializedBefore, transcript, write.writer, validWriters)) {
      errors.push(`permission_denied: writer frame not recorded ${writerFrameLabel(write.writer)} for ${cellLabel(write.cell)}`);
      continue;
    }
    const createdObject = authorizedCreates.get(write.cell.object);
    if (write.cell.kind === "lifecycle") {
      if (!createdObject || !writerCanInitializeCreatedObject(serializedBefore, write.writer.progr, createdObject)) {
        errors.push(`permission_denied: no recorded authority can create ${write.cell.object}`);
      }
      continue;
    }
    if (createdObject && writerCanInitializeCreatedObject(serializedBefore, write.writer.progr, createdObject)) {
      continue;
    }
    if (write.cell.kind === "prop" && !canWriterWriteProperty(serializedBefore, write.writer.progr, write.cell.object, write.cell.name)) {
      errors.push(`permission_denied: no recorded authority can write ${cellLabel(write.cell)}`);
    }
    if (write.cell.kind === "location" && !canWriterControlObject(serializedBefore, write.writer.progr, write.cell.object)) {
      errors.push(`permission_denied: no recorded authority can move ${write.cell.object}`);
    }
  }
  return errors;
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
  const next = structuredClone(current) as SerializedWorld;
  profile("clone_world", stepStartedAt);
  stepStartedAt = Date.now();
  const currentObjects = new Map<ObjRef, SerializedObject>(next.objects.map((obj) => [obj.id, obj]));
  profile("index_objects", stepStartedAt);

  // The commit scope constructs authoritative post-state from the transcript.
  // Executor post-world snapshots are intentionally not trusted across this
  // boundary; they are diagnostics/cache-fill only.
  stepStartedAt = Date.now();
  for (const create of transcript.creates) {
    const created = serializedObjectFromCreate(create, options.objectTimestamp);
    currentObjects.set(create.object, created);
    if (created.parent) addUniqueObjectRef(currentObjects.get(created.parent)?.children, created.id);
    if (created.location) addUniqueObjectRef(currentObjects.get(created.location)?.contents, created.id);
  }
  profile("apply_creates", stepStartedAt);
  stepStartedAt = Date.now();
  const writes = finalWritesByCell(transcript);
  profile("collect_writes", stepStartedAt);
  stepStartedAt = Date.now();
  for (const write of writes) {
    applyTranscriptWrite(currentObjects, write, options.objectTimestamp);
  }
  profile("apply_writes", stepStartedAt);
  stepStartedAt = Date.now();
  applyTranscriptSessionLocation(next, transcript);
  profile("apply_session", stepStartedAt);
  stepStartedAt = Date.now();
  next.objects = Array.from(currentObjects.values()).sort((a, b) => a.id.localeCompare(b.id));
  profile("sort_objects", stepStartedAt);
  stepStartedAt = Date.now();
  next.logs = applyTranscriptLog(next.logs, transcript);
  profile("apply_log", stepStartedAt);
  stepStartedAt = Date.now();
  next.objectCounter = nextObjectCounterForCreates(next.objectCounter, transcript.creates);
  profile("counters", stepStartedAt);
  profile("total", totalStartedAt);
  return next;
}

function applyTranscriptSessionLocation(next: SerializedWorld, transcript: EffectTranscript): void {
  if (!transcript.session) return;
  const actorMove = lastMoveForObject(transcript, transcript.call.actor);
  if (!actorMove) return;
  // Session location is transport/session authority, not an object cell, so it
  // is not represented as a transcript write. Actor moveto calls still need the
  // committed session view to advance, otherwise the next presence scrub drops
  // freshly-committed subscriber rows as stale.
  for (const session of next.sessions) {
    if (session.id === transcript.session && session.actor === transcript.call.actor) {
      session.currentLocation = actorMove.to;
      return;
    }
  }
}

function serializedObjectFromCreate(create: TranscriptCreate, objectTimestamp: number | undefined): SerializedObject {
  const timestamp = objectTimestamp ?? 0;
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

function applyTranscriptLog(logEntries: SerializedWorld["logs"], transcript: EffectTranscript): SerializedWorld["logs"] {
  if (transcript.route !== "sequenced") return logEntries;
  const logs = new Map<ObjRef, SerializedWorld["logs"][number][1]>(
    logEntries.map(([space, entries]) => [space, structuredClone(entries) as SerializedWorld["logs"][number][1]])
  );
  const entries = logs.get(transcript.scope) ?? [];
  const message = {
    actor: transcript.call.actor,
    target: transcript.call.target,
    verb: transcript.call.verb,
    args: structuredClone(transcript.call.args) as WooValue[]
  };
  const existing = entries.findIndex((entry) => entry.seq === transcript.seq);
  const entry = {
    space: transcript.scope,
    seq: transcript.seq,
    ts: 0,
    actor: transcript.call.actor,
    message,
    observations: structuredClone(transcript.observations) as EffectTranscript["observations"],
    applied_ok: transcript.error === undefined,
    ...(transcript.error ? { error: structuredClone(transcript.error) } : {})
  };
  if (existing >= 0) entries[existing] = entry;
  else entries.push(entry);
  entries.sort((a, b) => a.seq - b.seq);
  logs.set(transcript.scope, entries);
  return Array.from(logs.entries()).sort(([a], [b]) => a.localeCompare(b));
}

function applyTranscriptWrite(
  currentObjects: Map<ObjRef, SerializedObject>,
  write: TranscriptWrite,
  objectTimestamp: number | undefined
): void {
  const target = currentObjects.get(write.cell.object);
  if (!target) return;
  switch (write.cell.kind) {
    case "prop":
      applyPropWrite(target, write);
      touchSerializedObject(target, objectTimestamp);
      return;
    case "location":
      if (typeof write.value === "string" || write.value === null) target.location = write.value;
      touchSerializedObject(target, objectTimestamp);
      return;
    case "contents":
      if (Array.isArray(write.value)) target.contents = write.value.filter((item): item is ObjRef => typeof item === "string");
      touchSerializedObject(target, objectTimestamp);
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

function touchSerializedObject(target: SerializedObject, objectTimestamp: number | undefined): void {
  if (objectTimestamp !== undefined) target.modified = objectTimestamp;
}

function applyPropWrite(target: SerializedObject, write: TranscriptWrite): void {
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

function nextObjectCounterForCreates(current: number, creates: TranscriptCreate[]): number {
  let next = current;
  for (const create of creates) {
    const match = create.object.match(/_(\d+)$/);
    if (!match) continue;
    next = Math.max(next, Number(match[1]) + 1);
  }
  return next;
}

function recordedWriterIsValid(
  serialized: SerializedWorld,
  transcript: EffectTranscript,
  writer: RecordedWriteAuthority,
  validWriters: Map<string, boolean>
): boolean {
  const key = stableShadowJson(writer as unknown as WooValue);
  const cached = validWriters.get(key);
  if (cached !== undefined) return cached;
  const valid =
    serializedObject(serialized, writer.progr) !== undefined &&
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

function canWriterWriteProperty(serialized: SerializedWorld, writer: ObjRef, object: ObjRef, name: string): boolean {
  const target = serializedObject(serialized, object);
  if (!target) return false;
  const info = serializedPropertyInfo(serialized, object, name);
  if (isWizard(serialized, writer)) return true;
  if (!info && target.owner === writer) return true;
  return info !== null && (info.owner === writer || String(info.perms).includes("w"));
}

function canWriterControlObject(serialized: SerializedWorld, writer: ObjRef, object: ObjRef): boolean {
  const target = serializedObject(serialized, object);
  if (!target) return false;
  return isWizard(serialized, writer) || target.owner === writer;
}

function canWriterCreateObject(serialized: SerializedWorld, writer: ObjRef, parent: ObjRef | null, owner: ObjRef): boolean {
  if (!parent) return false;
  const parentObj = serializedObject(serialized, parent);
  if (!parentObj) return false;
  if (isWizard(serialized, writer)) return true;
  return owner === writer && (parentObj.owner === writer || parentObj.flags.fertile === true);
}

function writerCanInitializeCreatedObject(serialized: SerializedWorld, writer: ObjRef, create: TranscriptCreate): boolean {
  return isWizard(serialized, writer) || create.owner === writer;
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
