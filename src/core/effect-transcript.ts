import { createWorldFromSerialized } from "./bootstrap";
import type { SerializedWorld } from "./repository";
import { shadowOwnerCellVersion, shadowStructuralCellVersion, stableShadowJson } from "./shadow-cell-version";
import { hashSource } from "./source-hash";
import type { ErrorValue, ObjRef, Observation, WooValue } from "./types";
import type { RecordedCell, RecordedCellWriteOp, RecordedTurn, RecordedWriteAuthority, TurnStart } from "./turn-recorder";
import { nativePrimitiveContractValue, nativePrimitiveIsTranscriptTracked } from "./native-primitive-contract";

export type TranscriptCell = RecordedCell;

export type TranscriptRead = {
  cell: TranscriptCell;
  version?: string;
  value: WooValue;
};

export type TranscriptWrite = {
  cell: TranscriptCell;
  prior?: string;
  next?: string;
  value: WooValue;
  op: RecordedCellWriteOp;
  writer?: RecordedWriteAuthority;
};

export type TranscriptCreate = {
  object: ObjRef;
  name: string;
  parent: ObjRef | null;
  owner: ObjRef;
  anchor: ObjRef | null;
  location: ObjRef | null;
  flags: {
    wizard?: boolean;
    programmer?: boolean;
    fertile?: boolean;
  };
  writer?: RecordedWriteAuthority;
};

export type TranscriptMove = {
  object: ObjRef;
  from: ObjRef | null;
  to: ObjRef;
  writer?: RecordedWriteAuthority;
};

export type TranscriptUntrackedEffect = {
  name: string;
  detail: WooValue | null;
};

export type EffectTranscript = {
  kind: "woo.effect_transcript.shadow.v1";
  id?: string;
  route: TurnStart["route"];
  scope: ObjRef;
  seq: number;
  session?: string | null;
  call: Pick<TurnStart, "actor" | "target" | "verb" | "args" | "body">;
  reads: TranscriptRead[];
  writes: TranscriptWrite[];
  creates: TranscriptCreate[];
  moves: TranscriptMove[];
  observations: Observation[];
  logicalInputs: Array<{ name: string; value: WooValue }>;
  untrackedEffects: TranscriptUntrackedEffect[];
  result?: WooValue;
  error?: ErrorValue;
  complete: boolean;
  incompleteReasons: string[];
  hash: string;
};

export type TranscriptValidation = {
  ok: boolean;
  errors: string[];
};

export type TranscriptCellRead = { ok: true; version?: string; value: WooValue } | { ok: false; error: string };

export function effectTranscriptFromRecordedTurn(turn: RecordedTurn): EffectTranscript {
  const reads: TranscriptRead[] = [];
  const writes: TranscriptWrite[] = [];
  const creates: TranscriptCreate[] = [];
  const moves: TranscriptMove[] = [];
  const observations: Observation[] = [];
  const logicalInputs: Array<{ name: string; value: WooValue }> = [];
  const untrackedEffects: TranscriptUntrackedEffect[] = [];
  const incompleteReasons = new Set<string>();
  let result: WooValue | undefined;
  let error: ErrorValue | undefined;

  for (const event of turn.events) {
    switch (event.kind) {
      case "cell_read":
        reads.push({
          cell: event.cell,
          version: event.version,
          value: event.value
        });
        break;
      case "cell_write":
        writes.push({
          cell: event.cell,
          prior: event.prior,
          next: event.next,
          value: event.value,
          op: event.op,
          writer: event.writer
        });
        break;
      case "prop_read":
        reads.push({
          cell: { kind: "prop", object: event.object, name: event.name },
          version: versionString(event.version),
          value: event.value
        });
        break;
      case "prop_write":
        writes.push({
          cell: { kind: "prop", object: event.object, name: event.name },
          prior: versionString(event.beforeVersion),
          next: versionString(event.afterVersion),
          value: event.after,
          op: "set",
          writer: event.writer
        });
        break;
      case "object_create":
        creates.push({
          object: event.object,
          name: event.name,
          parent: event.parent,
          owner: event.owner,
          anchor: event.anchor,
          location: event.location,
          flags: event.flags,
          writer: event.writer
        });
        writes.push({
          cell: { kind: "lifecycle", object: event.object },
          value: "created",
          op: "create",
          writer: event.writer
        });
        break;
      case "object_move":
        moves.push({ object: event.object, from: event.from, to: event.to, writer: event.writer });
        writes.push({
          cell: { kind: "location", object: event.object },
          value: event.to,
          op: "move",
          writer: event.writer
        });
        break;
      case "observe":
        observations.push(event.observation);
        break;
      case "logical_input":
        logicalInputs.push({ name: event.name, value: event.value });
        break;
      case "dispatch":
        reads.push({
          cell: { kind: "verb", object: event.definer, name: event.verb },
          version: versionString(event.version),
          value: {
            implementation: event.implementation,
            owner: event.owner,
            source_hash: event.source_hash ?? null,
            direct_callable: event.direct_callable === true,
            native: event.native ?? null,
            native_contract: nativePrimitiveContractValue(event.native),
            version: event.version ?? null
          }
        });
        if (event.implementation === "native" && !nativePrimitiveIsTranscriptTracked(event.native)) {
          incompleteReasons.add(`native:${event.target}:${event.verb}`);
        }
        break;
      case "untracked_effect":
        untrackedEffects.push({
          name: event.name,
          detail: event.detail ? structuredClone(event.detail) as WooValue : null
        });
        incompleteReasons.add(event.name);
        break;
      case "turn_finish":
        if (event.ok) result = event.result;
        else error = event.error;
        break;
      case "turn_start":
        break;
    }
  }

  const withoutHash = {
    kind: "woo.effect_transcript.shadow.v1" as const,
    id: turn.start.id,
    route: turn.start.route,
    scope: turn.start.scope,
    seq: turn.start.seq,
    session: turn.start.session,
    call: {
      actor: turn.start.actor,
      target: turn.start.target,
      verb: turn.start.verb,
      args: turn.start.args,
      ...(turn.start.body !== undefined ? { body: turn.start.body } : {})
    },
    reads,
    writes,
    creates,
    moves,
    observations,
    logicalInputs,
    untrackedEffects,
    result,
    error,
    complete: incompleteReasons.size === 0,
    incompleteReasons: Array.from(incompleteReasons).sort()
  };

  return {
    ...withoutHash,
    hash: hashSource(stableJson(withoutHash as unknown as WooValue))
  };
}

export function validateTranscriptAgainstSerializedWorld(serializedBefore: SerializedWorld, transcript: EffectTranscript): TranscriptValidation {
  const world = createWorldFromSerialized(serializedBefore, { persist: false });
  const errors: string[] = [];

  for (const read of transcript.reads) {
    const sameTurn = sameTurnRead(transcript, read);
    if (sameTurn.ok) continue;
    const actual = actualReadCell(serializedBefore, world, read.cell);
    if (!actual.ok) {
      errors.push(actual.error);
      continue;
    }
    const readMatchesOwnWrite = sameTurn.reason === "own_write_mismatch" ? false : sameTurnReadMatchesOwnWrite(transcript, read);
    if (!readMatchesOwnWrite && read.version !== actual.version) {
      errors.push(`read version mismatch ${cellLabel(read.cell)}: transcript=${read.version ?? "none"} actual=${actual.version ?? "none"}`);
    }
    if (!readMatchesOwnWrite && stableJson(actual.value) !== stableJson(read.value)) {
      errors.push(`read value mismatch ${cellLabel(read.cell)}`);
    }
  }

  for (let i = 0; i < transcript.writes.length; i++) {
    const write = transcript.writes[i];
    if (write.prior === undefined) continue;
    if (transcript.writes.slice(0, i).some((prior) => sameCell(prior.cell, write.cell))) continue;
    if (transcript.creates.some((create) => create.object === write.cell.object)) continue;
    const actual = actualReadCell(serializedBefore, world, write.cell);
    if (!actual.ok) {
      if (write.cell.kind !== "lifecycle" || write.op !== "create") errors.push(actual.error);
      continue;
    }
    if (write.prior !== actual.version) {
      errors.push(`write prior mismatch ${cellLabel(write.cell)}: transcript=${write.prior ?? "none"} actual=${actual.version ?? "none"}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function sameTurnRead(transcript: EffectTranscript, read: TranscriptRead): { ok: true } | { ok: false; reason?: "own_write_mismatch" } {
  if (sameTurnReadMatchesOwnWrite(transcript, read)) return { ok: true };
  const create = transcript.creates.find((item) => item.object === read.cell.object);
  if (!create) return { ok: false };
  switch (read.cell.kind) {
    case "prop":
      if (read.cell.name === "owner" && read.value === create.owner) return { ok: true };
      return { ok: false, reason: "own_write_mismatch" };
    case "location": {
      const moved = lastMoveForObject(transcript, read.cell.object);
      if (stableJson(create.location) === stableJson(read.value)) return { ok: true };
      if (moved && stableJson(moved.to) === stableJson(read.value)) return { ok: true };
      return { ok: false, reason: "own_write_mismatch" };
    }
    case "lifecycle":
      return read.value === "created" || read.value === "present" ? { ok: true } : { ok: false, reason: "own_write_mismatch" };
    case "contents":
      return { ok: false, reason: "own_write_mismatch" };
    case "verb":
      return { ok: false };
  }
}

function sameTurnReadMatchesOwnWrite(transcript: EffectTranscript, read: TranscriptRead): boolean {
  return transcript.writes.some((write) =>
    sameCell(write.cell, read.cell) &&
    (write.next === undefined || write.next === read.version) &&
    stableJson(write.value) === stableJson(read.value)
  );
}

function lastMoveForObject(transcript: EffectTranscript, object: ObjRef): TranscriptMove | undefined {
  for (let i = transcript.moves.length - 1; i >= 0; i--) {
    const move = transcript.moves[i];
    if (move.object === object) return move;
  }
  return undefined;
}

export function transcriptTouchedStateHash(serialized: SerializedWorld, transcript: EffectTranscript): string {
  const world = createWorldFromSerialized(serialized, { persist: false });
  const cells = uniqueTranscriptCells(transcript);
  const snapshot = cells.map((cell) => {
    const actual = actualReadCell(serialized, world, cell);
    return actual.ok
      ? { cell, version: actual.version ?? null, value: actual.value }
      : { cell, absent: true, error: actual.error };
  });
  return hashSource(stableJson({
    kind: "woo.touched_state_hash.shadow.v1",
    cells: snapshot
  } as unknown as WooValue));
}

export function readTranscriptCellFromSerializedWorld(serialized: SerializedWorld, cell: TranscriptCell): TranscriptCellRead {
  return actualReadCell(serialized, createWorldFromSerialized(serialized, { persist: false }), cell);
}

function actualReadCell(serialized: SerializedWorld, world: ReturnType<typeof createWorldFromSerialized>, cell: TranscriptCell): TranscriptCellRead {
  try {
    switch (cell.kind) {
      case "prop":
        return {
          ok: true,
          version: versionString(propVersion(serialized, cell.object, cell.name)),
          value: world.getProp(cell.object, cell.name)
        };
      case "verb": {
        const verb = serializedVerb(serialized, cell.object, cell.name);
        if (!verb) return { ok: false, error: `read unavailable ${cellLabel(cell)}: verb not found` };
        return {
          ok: true,
          version: versionString(verb.version),
          value: {
            implementation: verb.kind,
            owner: verb.owner,
            source_hash: verb.source_hash,
            direct_callable: verb.direct_callable === true,
            native: verb.kind === "native" ? verb.native : null,
            native_contract: verb.kind === "native" ? nativePrimitiveContractValue(verb.native) : null,
            version: verb.version
          }
        };
      }
      case "location": {
        const obj = serializedObject(serialized, cell.object);
        if (!obj) return { ok: false, error: `read unavailable ${cellLabel(cell)}: object not found` };
        return { ok: true, version: shadowStructuralCellVersion("location", obj), value: obj.location };
      }
      case "contents": {
        const obj = serializedObject(serialized, cell.object);
        if (!obj) return { ok: false, error: `read unavailable ${cellLabel(cell)}: object not found` };
        return { ok: true, version: shadowStructuralCellVersion("contents", obj), value: obj.contents };
      }
      case "lifecycle": {
        const obj = serializedObject(serialized, cell.object);
        if (!obj) return { ok: false, error: `read unavailable ${cellLabel(cell)}: object not found` };
        return { ok: true, version: shadowStructuralCellVersion("lifecycle", obj), value: "present" };
      }
    }
  } catch (err) {
    return { ok: false, error: `read unavailable ${cellLabel(cell)}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function propVersion(serialized: SerializedWorld, object: ObjRef, name: string): number | string | undefined {
  const obj = serialized.objects.find((item) => item.id === object);
  if (!obj) return undefined;
  if (name === "owner") return shadowOwnerCellVersion(object, obj.owner);
  return obj.propertyVersions.find(([prop]) => prop === name)?.[1] ?? 0;
}

function serializedObject(serialized: SerializedWorld, object: ObjRef): SerializedWorld["objects"][number] | undefined {
  return serialized.objects.find((item) => item.id === object);
}

function serializedVerb(serialized: SerializedWorld, object: ObjRef, name: string): SerializedWorld["objects"][number]["verbs"][number] | undefined {
  const obj = serializedObject(serialized, object);
  return obj?.verbs.find((verb) => verb.name === name || verb.aliases.includes(name));
}

function uniqueTranscriptCells(transcript: EffectTranscript): TranscriptCell[] {
  const byKey = new Map<string, TranscriptCell>();
  for (const read of transcript.reads) byKey.set(cellKey(read.cell), read.cell);
  for (const write of transcript.writes) byKey.set(cellKey(write.cell), write.cell);
  return Array.from(byKey.values()).sort((a, b) => cellKey(a).localeCompare(cellKey(b)));
}

function sameCell(a: TranscriptCell, b: TranscriptCell): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "prop" && b.kind === "prop") return a.object === b.object && a.name === b.name;
  if (a.kind === "verb" && b.kind === "verb") return a.object === b.object && a.name === b.name;
  return a.object === b.object;
}

function versionString(version: number | string | undefined): string | undefined {
  return version === undefined ? undefined : String(version);
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
  return stableJson(cell as unknown as WooValue);
}

function stableJson(value: WooValue): string {
  return stableShadowJson(value);
}
