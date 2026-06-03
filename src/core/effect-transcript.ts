import type { SerializedWorld } from "./repository";
import { shadowOwnerCellVersion, shadowStructuralCellVersion, stableShadowJson } from "./shadow-cell-version";
import { hashSource } from "./source-hash";
import type { ErrorValue, ObjRef, Observation, PresenceProjectionDef, WooValue } from "./types";
import type { RecordedCell, RecordedCellWriteOp, RecordedProjectionWrite, RecordedTurn, RecordedWriteAuthority, TurnStart } from "./turn-recorder";
import { nativePrimitiveContractValue, nativePrimitiveIsTranscriptTracked } from "./native-primitive-contract";
import { readObjectPropertyValue, type PropertyReadableObject } from "./property-read";

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

// A first-class session active-scope transition (CA8). Distinct from a physical
// `TranscriptMove`: it is recorded whenever a session's active scope changes —
// including a no-op physical enter (actor already in the room) — and it is the
// authoritative input for live presence projections (session_subscribers /
// subscribers) and session-row materialization. Routing/presence state, not
// room-membership authority, so it does not count as a CA3 authoritative write.
export type TranscriptSessionScopeTransition = {
  session: string;
  actor: ObjRef;
  from: ObjRef | null;
  to: ObjRef | null;
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
  // State probes are materialization dependencies, not user-visible reads.
  // They capture negative lookup edges such as "the receiver has no `text`
  // verb, so dispatch fell through to its parent"; a partial executor must
  // have these cells before it can safely replay the turn locally.
  stateProbes?: TranscriptCell[];
  writes: TranscriptWrite[];
  creates: TranscriptCreate[];
  moves: TranscriptMove[];
  // Net session active-scope transition for this turn (coalesced first.from →
  // last.to). Drives presence projections + session-row materialization. CA8.
  sessionScopeTransition?: TranscriptSessionScopeTransition;
  projectionWrites?: RecordedProjectionWrite[];
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
  // Structured cell refs for the reads whose pre-state version/value did not
  // match the authoritative cell (the same mismatches the `read version
  // mismatch` / `read value mismatch` error STRINGS describe). The repair path
  // turns these into a targeted cell-page transfer so a stale planning view can
  // be refreshed with the commit-authority's current cells and converge on the
  // next attempt, instead of re-planning against the same stale rows and
  // grinding the whole retry budget. Empty when no read mismatched.
  mismatchedReadCells: TranscriptCell[];
};

export type TranscriptCellRead = { ok: true; version?: string; value: WooValue } | { ok: false; error: string };

export type TranscriptCellReader = {
  serialized: SerializedWorld;
  objectById: ReadonlyMap<ObjRef, SerializedWorld["objects"][number]>;
  propertiesByObject: Map<ObjRef, Map<string, WooValue>>;
  propertyDefsByObject: Map<ObjRef, Map<string, SerializedWorld["objects"][number]["propertyDefs"][number]>>;
  propertyVersionsByObject: Map<ObjRef, Map<string, number | string>>;
  verbsByObject: Map<ObjRef, SerializedWorld["objects"][number]["verbs"]>;
};

export function effectTranscriptFromRecordedTurn(turn: RecordedTurn): EffectTranscript {
  const reads: TranscriptRead[] = [];
  const writes: TranscriptWrite[] = [];
  const stateProbes: TranscriptCell[] = [];
  const creates: TranscriptCreate[] = [];
  const moves: TranscriptMove[] = [];
  let sessionScopeTransition: TranscriptSessionScopeTransition | undefined;
  const projectionWrites: RecordedProjectionWrite[] = [];
  const observations: Observation[] = [];
  const logicalInputs: Array<{ name: string; value: WooValue }> = [];
  const untrackedEffects: TranscriptUntrackedEffect[] = [];
  let turnFinishedOk = false;
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
      case "session_scope":
        // Coalesce multiple transitions within one turn to the net first.from →
        // last.to so the transcript carries a single authoritative placement.
        sessionScopeTransition = {
          session: event.session,
          actor: event.actor,
          from: sessionScopeTransition ? sessionScopeTransition.from : event.from,
          to: event.to
        };
        break;
      case "projection_write":
        projectionWrites.push(structuredClone(event.write) as RecordedProjectionWrite);
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
      case "state_probe":
        stateProbes.push(event.cell);
        break;
      case "untracked_effect":
        untrackedEffects.push({
          name: event.name,
          detail: event.detail ? structuredClone(event.detail) as WooValue : null
        });
        incompleteReasons.add(event.name);
        break;
      case "turn_finish":
        turnFinishedOk = event.ok;
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
    ...(stateProbes.length > 0 ? { stateProbes: uniqueCells(stateProbes) } : {}),
    writes,
    creates,
    moves,
    ...(sessionScopeTransition ? { sessionScopeTransition } : {}),
    ...(turnFinishedOk && projectionWrites.length > 0 ? { projectionWrites } : {}),
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
  return validateTranscriptWithCellReader(createTranscriptCellReader(serializedBefore), transcript);
}

export function validateTranscriptWithCellReader(reader: TranscriptCellReader, transcript: EffectTranscript): TranscriptValidation {
  const errors: string[] = [];
  // Cells whose recorded read version/value disagreed with the authoritative
  // cell. Collected alongside the existing error STRINGS so the repair path can
  // build a targeted refresh transfer (see TranscriptValidation.mismatchedReadCells).
  const mismatchedReadCells: TranscriptCell[] = [];
  const recordMismatch = (cell: TranscriptCell): void => {
    if (mismatchedReadCells.some((existing) => sameCell(existing, cell))) return;
    mismatchedReadCells.push(cell);
  };

  for (const read of transcript.reads) {
    const sameTurn = sameTurnRead(transcript, read);
    if (sameTurn.ok) continue;
    const actual = readTranscriptCell(reader, read.cell);
    if (!actual.ok) {
      errors.push(actual.error);
      continue;
    }
    if (readMatchesSequencedAllocation(transcript, read, actual)) continue;
    // A4 (cell-authority CA2/CA4): contents and presence-projection cells are
    // PROJECTIONS, not authority. Their truth is each member's own
    // `live:location` authoritative cell, validated independently. A read of a
    // projection cell is therefore NOT a consistency dependency: a stale
    // cross-room view of a room's contents / presence roster must NOT reject the
    // commit (that was the masked CI debt the conformance gate allow-listed).
    // Movement still serializes at the moved object's location owner; this only
    // stops a derived read model from gating an unrelated turn.
    if (isProjectionReadCell(reader, read.cell)) continue;
    const readMatchesOwnWrite = sameTurn.reason === "own_write_mismatch" ? false : sameTurnReadMatchesOwnWrite(transcript, read);
    if (!readMatchesOwnWrite && read.version !== actual.version) {
      errors.push(`read version mismatch ${cellLabel(read.cell)}: transcript=${read.version ?? "none"} actual=${actual.version ?? "none"}`);
      recordMismatch(read.cell);
    }
    if (!readMatchesOwnWrite && !transcriptReadValuesMatch(read.cell, actual.value, read.value)) {
      errors.push(`read value mismatch ${cellLabel(read.cell)}`);
      recordMismatch(read.cell);
    }
  }

  for (let i = 0; i < transcript.writes.length; i++) {
    const write = transcript.writes[i];
    if (write.prior === undefined) continue;
    if (transcript.writes.slice(0, i).some((prior) => sameCell(prior.cell, write.cell))) continue;
    if (transcript.creates.some((create) => create.object === write.cell.object)) continue;
    const actual = readTranscriptCell(reader, write.cell);
    if (!actual.ok) {
      if (write.cell.kind !== "lifecycle" || write.op !== "create") errors.push(actual.error);
      continue;
    }
    if (write.prior !== actual.version) {
      errors.push(`write prior mismatch ${cellLabel(write.cell)}: transcript=${write.prior ?? "none"} actual=${actual.version ?? "none"}`);
    }
  }

  for (const write of transcript.projectionWrites ?? []) {
    const error = projectionWriteShapeError(write);
    if (error) errors.push(error);
  }

  // Session active-scope transition (CA8): validation-exempt from object-cell
  // write authority (it is routing/presence state, not a CA3 authoritative
  // write), but NOT trust-exempt — check it structurally. It must name this
  // turn's session and actor, and (when the session's pre-state is readable on
  // this host) its `from` must agree with the authoritative pre-state scope so a
  // stale transition cannot silently rewrite presence.
  const transition = transcript.sessionScopeTransition;
  if (transition) {
    if (!transcript.session) {
      errors.push("session scope transition present but transcript carries no session");
    } else if (transition.session !== transcript.session) {
      errors.push(`session scope transition session mismatch: transition=${transition.session} transcript=${transcript.session}`);
    }
    if (transition.actor !== transcript.call.actor) {
      errors.push(`session scope transition actor mismatch: transition=${transition.actor} call=${transcript.call.actor}`);
    }
    const priorScope = readerSessionActiveScope(reader, transition.session);
    if (priorScope !== undefined && (priorScope ?? null) !== (transition.from ?? null)) {
      errors.push(`session scope transition from mismatch: transition=${transition.from ?? "none"} actual=${priorScope ?? "none"}`);
    }
  }

  return { ok: errors.length === 0, errors, mismatchedReadCells };
}

function projectionWriteShapeError(write: RecordedProjectionWrite): string | null {
  switch (write.table) {
    case "snapshots":
      if (write.op === "delete") return write.bytes === 0 ? null : "projection_write snapshots delete must have zero bytes";
      return write.row.space_id === write.key.space && write.row.seq === write.key.seq
        ? null
        : `projection_write snapshots key mismatch ${write.key.space}@${write.key.seq}`;
    case "parked_tasks":
      if (write.op === "delete") return write.bytes === 0 ? null : "projection_write parked_tasks delete must have zero bytes";
      return write.row.id === write.key
        ? null
        : `projection_write parked_tasks key mismatch ${write.key}`;
    case "tombstones":
      if (write.op === "delete") return write.bytes === 0 ? null : "projection_write tombstones delete must have zero bytes";
      return write.row.id === write.key
        ? null
        : `projection_write tombstones key mismatch ${write.key}`;
    case "counters":
      return write.op === "upsert"
        ? null
        : `projection_write counters unsupported op ${(write as { op?: string }).op ?? "unknown"}`;
    default:
      return `projection_write unsupported table ${(write as { table?: string }).table ?? "unknown"}`;
  }
}

// A4: is this read cell a derived projection (never a consistency dependency)?
// A `contents` cell is the canonical container projection (CA4 — derived from
// members' `live:location`). A `prop` cell is a projection only when its
// property def declares a presence projection (CA4 PresenceProjectionDef) — an
// ordinary list-valued property with no declaration stays an order-sensitive
// authoritative cell and is still validated.
function isProjectionReadCell(reader: TranscriptCellReader, cell: TranscriptCell): boolean {
  if (cell.kind === "contents") return true;
  if (cell.kind === "prop") return presenceProjectionForCell(reader, cell.object, cell.name) !== null;
  return false;
}

function presenceProjectionForCell(
  reader: TranscriptCellReader,
  object: ObjRef,
  name: string
): PresenceProjectionDef | null {
  let current = serializedObject(reader, object);
  while (current) {
    const def = readerPropertyDefs(reader, current).get(name);
    if (def?.presenceProjection) return def.presenceProjection;
    current = current.parent ? serializedObject(reader, current.parent) : undefined;
  }
  return null;
}

// Every metadata-declared presence-projection property on `object`, resolved
// through a transcript cell reader's inheritance chain (presence cells such as
// the session/actor subscriber lists are declared on the space base class and
// inherited by each room). Property names closer to the object win, so a
// subclass override of a presence cell is honoured. Exported so the
// indexed-state materializer can build the resolver `sessionScopePresenceDeltas`
// needs; the in-memory world materializer supplies an equivalent resolver over
// its own object records.
export function presenceProjectionPropsFromReader(
  reader: TranscriptCellReader,
  object: ObjRef
): Array<{ name: string; def: PresenceProjectionDef }> {
  const out = new Map<string, PresenceProjectionDef>();
  let current = serializedObject(reader, object);
  while (current) {
    for (const [name, def] of readerPropertyDefs(reader, current)) {
      if (def.presenceProjection && !out.has(name)) out.set(name, def.presenceProjection);
    }
    current = current.parent ? serializedObject(reader, current.parent) : undefined;
  }
  return Array.from(out, ([name, def]) => ({ name, def }));
}

// A single add/remove against one room's presence-projection cell, emitted by
// `movementPresenceProjectionDeltas`.
export type PresenceProjectionRowDelta = {
  room: ObjRef;
  property: string;
  def: PresenceProjectionDef;
  op: "add" | "remove";
  actor: ObjRef;
  session: string;
};

// Resolver: the metadata-declared presence-projection properties of a room,
// supplied by the caller so the same reducer serves the serialized commit-scope
// state and the in-memory world (two different object representations, one
// inheritance walk each).
export type PresenceProjectionPropsResolver = (room: ObjRef) => Array<{ name: string; def: PresenceProjectionDef }>;

// Reducer #1 of the projection pipeline (CA4/CA8): an accepted session
// active-scope transition derives presence-projection row add/removes for the
// source and destination rooms' metadata-declared presence cells. The input is
// `transcript.sessionScopeTransition` (NOT `transcript.moves`) — presence is
// keyed by session placement, not physical containment, so this fires for a
// no-op physical enter and uses the reliable session from/to rather than a
// possibly-sparse move's from. Location remains the sole authoritative write
// (CA3); these rows are local projections every materializer recomputes from the
// accepted transcript. Live delivery still filters these durable rows through
// live session state at fanout (CA8), so a stale row is never a live recipient
// on its own.
export function sessionScopePresenceDeltas(
  presenceProjsForRoom: PresenceProjectionPropsResolver,
  transcript: EffectTranscript
): PresenceProjectionRowDelta[] {
  const transition = transcript.sessionScopeTransition;
  if (!transition || !transition.session || !transition.actor) return [];
  const { session, actor, from, to } = transition;
  if (from === to) return [];
  const deltas: PresenceProjectionRowDelta[] = [];
  if (from) {
    for (const { name, def } of presenceProjsForRoom(from)) {
      deltas.push({ room: from, property: name, def, op: "remove", actor, session });
    }
  }
  if (to) {
    for (const { name, def } of presenceProjsForRoom(to)) {
      deltas.push({ room: to, property: name, def, op: "add", actor, session });
    }
  }
  return deltas;
}

// Apply one presence-projection delta to a cell's current list value, returning
// the next value. Idempotent and keyed by member (CA4): a session-keyed cell
// drops any existing row for that session before re-adding, an actor-keyed cell
// dedupes the actor. The result is sorted for actor-keyed cells so cold reload
// and warm catch-up agree on row order.
export function applyPresenceProjectionRowDelta(
  current: WooValue | null | undefined,
  delta: PresenceProjectionRowDelta
): WooValue {
  const list = Array.isArray(current) ? current : [];
  if (delta.def.key === "session") {
    const sessionField = delta.def.sessionField;
    const actorField = delta.def.actorField;
    const without = list.filter((row) =>
      !(row && typeof row === "object" && !Array.isArray(row) && (row as Record<string, WooValue>)[sessionField] === delta.session)
    );
    if (delta.op === "remove") return without as WooValue;
    return [...without, { [sessionField]: delta.session, [actorField]: delta.actor }] as WooValue;
  }
  const without = list.filter((row) => row !== delta.actor);
  if (delta.op === "remove") return without as WooValue;
  return Array.from(new Set([...without, delta.actor] as ObjRef[])).sort() as unknown as WooValue;
}

function readMatchesSequencedAllocation(transcript: EffectTranscript, read: TranscriptRead, actual: TranscriptCellRead): boolean {
  if (!actual.ok) return false;
  if (transcript.route !== "sequenced") return false;
  if (read.cell.kind !== "prop" || read.cell.object !== transcript.scope || read.cell.name !== "next_seq") return false;
  if (typeof actual.value !== "number" || typeof read.value !== "number") return false;
  if (actual.value !== transcript.seq || read.value !== transcript.seq + 1) return false;
  const actualVersion = numericVersion(actual.version);
  const readVersion = numericVersion(read.version);
  return actualVersion === null || readVersion === null || readVersion === actualVersion + 1;
}

function sameTurnRead(transcript: EffectTranscript, read: TranscriptRead): { ok: true } | { ok: false; reason?: "own_write_mismatch" } {
  if (sameTurnReadMatchesOwnWrite(transcript, read)) return { ok: true };
  const create = transcript.creates.find((item) => item.object === read.cell.object);
  if (!create) return { ok: false };
  switch (read.cell.kind) {
    case "prop":
      // Same-turn create + same-turn prop read: pre-state cannot satisfy the
      // read because the object did not exist yet. Any in-turn write to the
      // same cell is already accepted by sameTurnReadMatchesOwnWrite above.
      // For reads with no in-turn write to that cell (typical for inherited
      // defaults like description/aliases on a freshly-created instance),
      // the recorded value is whatever propOrNull returned from the parent
      // chain or null — deterministic on replay. Accept unconditionally; a
      // value mismatch would surface later as post_state_mismatch when the
      // write side of the same cell is validated against the merged
      // post-state, not as a stale-pre-state read failure.
      return { ok: true };
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
    // Use the same set-aware comparison as cross-turn reads so a contents read
    // that echoes a same-turn contents write is not rejected on ordering alone.
    transcriptReadValuesMatch(read.cell, write.value, read.value)
  );
}

function uniqueCells(cells: TranscriptCell[]): TranscriptCell[] {
  const seen = new Set<string>();
  const out: TranscriptCell[] = [];
  for (const cell of cells) {
    const key = stableJson(cell as unknown as WooValue);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cell);
  }
  return out.sort((a, b) => stableJson(a as unknown as WooValue).localeCompare(stableJson(b as unknown as WooValue)));
}

function lastMoveForObject(transcript: EffectTranscript, object: ObjRef): TranscriptMove | undefined {
  for (let i = transcript.moves.length - 1; i >= 0; i--) {
    const move = transcript.moves[i];
    if (move.object === object) return move;
  }
  return undefined;
}

export function transcriptTouchedStateHash(serialized: SerializedWorld, transcript: EffectTranscript): string {
  return transcriptTouchedStateHashWithReader(createTranscriptCellReader(serialized), transcript);
}

export function transcriptTouchedStateHashWithReader(reader: TranscriptCellReader, transcript: EffectTranscript): string {
  const cells = uniqueTranscriptCells(transcript);
  const snapshot = cells.map((cell) => {
    const actual = readTranscriptCell(reader, cell);
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
  return readTranscriptCell(createTranscriptCellReader(serialized), cell);
}

export function createTranscriptCellReader(serialized: SerializedWorld): TranscriptCellReader {
  return createTranscriptCellReaderFromObjects(serialized, serialized.objects);
}

export function createTranscriptCellReaderFromObjects(
  serialized: SerializedWorld,
  objects: Iterable<SerializedWorld["objects"][number]>
): TranscriptCellReader {
  return createTranscriptCellReaderFromObjectMap(
    serialized,
    new Map(Array.from(objects, (obj) => [obj.id, obj] as const))
  );
}

export function createTranscriptCellReaderFromObjectMap(
  serialized: SerializedWorld,
  objectById: ReadonlyMap<ObjRef, SerializedWorld["objects"][number]>
): TranscriptCellReader {
  return {
    serialized,
    objectById,
    propertiesByObject: new Map(),
    propertyDefsByObject: new Map(),
    propertyVersionsByObject: new Map(),
    verbsByObject: new Map()
  };
}

export function readTranscriptCell(reader: TranscriptCellReader, cell: TranscriptCell): TranscriptCellRead {
  try {
    switch (cell.kind) {
      case "prop":
        return {
          ok: true,
          version: versionString(propVersion(reader, cell.object, cell.name)),
          value: readSerializedProp(reader, cell.object, cell.name)
        };
      case "verb": {
        const verb = serializedVerb(reader, cell.object, cell.name);
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
        const obj = serializedObject(reader, cell.object);
        if (!obj) return { ok: false, error: `read unavailable ${cellLabel(cell)}: object not found` };
        return { ok: true, version: shadowStructuralCellVersion("location", obj), value: obj.location };
      }
      case "contents": {
        const obj = serializedObject(reader, cell.object);
        if (!obj) return { ok: false, error: `read unavailable ${cellLabel(cell)}: object not found` };
        return { ok: true, version: shadowStructuralCellVersion("contents", obj), value: obj.contents };
      }
      case "lifecycle": {
        const obj = serializedObject(reader, cell.object);
        if (!obj) return { ok: false, error: `read unavailable ${cellLabel(cell)}: object not found` };
        return { ok: true, version: shadowStructuralCellVersion("lifecycle", obj), value: "present" };
      }
    }
  } catch (err) {
    return { ok: false, error: `read unavailable ${cellLabel(cell)}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function propVersion(reader: TranscriptCellReader, object: ObjRef, name: string): number | string | undefined {
  const obj = serializedObject(reader, object);
  if (!obj) return undefined;
  if (name === "owner") return shadowOwnerCellVersion(object, obj.owner);
  return readerPropertyVersions(reader, obj).get(name) ?? 0;
}

function serializedObject(reader: TranscriptCellReader, object: ObjRef): SerializedWorld["objects"][number] | undefined {
  return reader.objectById.get(object);
}

// The session's active scope in the reader's pre-state, or undefined when the
// session row is not present on this host (so the caller skips the check rather
// than treating "absent" as null). Used to validate a session-scope transition's
// `from` against authoritative pre-state where it is locally knowable.
function readerSessionActiveScope(reader: TranscriptCellReader, sessionId: string): ObjRef | null | undefined {
  const session = reader.serialized.sessions.find((row) => row.id === sessionId);
  if (!session) return undefined;
  return session.activeScope ?? session.currentLocation ?? null;
}

function serializedVerb(reader: TranscriptCellReader, object: ObjRef, name: string): SerializedWorld["objects"][number]["verbs"][number] | undefined {
  const obj = serializedObject(reader, object);
  return obj ? readerVerbs(reader, obj).find((verb) => verb.name === name || verb.aliases.includes(name)) : undefined;
}

function readSerializedProp(reader: TranscriptCellReader, object: ObjRef, name: string): WooValue {
  const obj = serializedObject(reader, object);
  if (!obj) throw new Error(`object not found: ${object}`);
  return readObjectPropertyValue({
    object: readableSerializedObject(reader, obj),
    name,
    lookupParent: (parent) => {
      const ancestor = serializedObject(reader, parent);
      return ancestor ? readableSerializedObject(reader, ancestor) : null;
    },
    propertyNotFound: (missing) => new Error(`property not found: ${missing}`)
  });
}

function readableSerializedObject(
  reader: TranscriptCellReader,
  obj: SerializedWorld["objects"][number]
): PropertyReadableObject {
  return {
    id: obj.id,
    name: obj.name,
    parent: obj.parent,
    owner: obj.owner,
    properties: readerProperties(reader, obj),
    propertyDefs: readerPropertyDefs(reader, obj)
  };
}

function readerProperties(reader: TranscriptCellReader, obj: SerializedWorld["objects"][number]): Map<string, WooValue> {
  let properties = reader.propertiesByObject.get(obj.id);
  if (!properties) {
    properties = new Map(obj.properties);
    reader.propertiesByObject.set(obj.id, properties);
  }
  return properties;
}

function readerPropertyDefs(
  reader: TranscriptCellReader,
  obj: SerializedWorld["objects"][number]
): Map<string, SerializedWorld["objects"][number]["propertyDefs"][number]> {
  let defs = reader.propertyDefsByObject.get(obj.id);
  if (!defs) {
    defs = new Map(obj.propertyDefs.map((def) => [def.name, def] as const));
    reader.propertyDefsByObject.set(obj.id, defs);
  }
  return defs;
}

function readerPropertyVersions(reader: TranscriptCellReader, obj: SerializedWorld["objects"][number]): Map<string, number | string> {
  let versions = reader.propertyVersionsByObject.get(obj.id);
  if (!versions) {
    versions = new Map(obj.propertyVersions);
    reader.propertyVersionsByObject.set(obj.id, versions);
  }
  return versions;
}

function readerVerbs(
  reader: TranscriptCellReader,
  obj: SerializedWorld["objects"][number]
): SerializedWorld["objects"][number]["verbs"] {
  let verbs = reader.verbsByObject.get(obj.id);
  if (!verbs) {
    verbs = obj.verbs;
    reader.verbsByObject.set(obj.id, verbs);
  }
  return verbs;
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

function numericVersion(version: string | undefined): number | null {
  if (version === undefined) return null;
  const parsed = Number(version);
  return Number.isInteger(parsed) ? parsed : null;
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

// Compare a recorded read value against the authoritative cell value. The
// `contents` cell is canonically an unordered set: shadowStructuralCellVersion
// ("contents") hashes `Array.from(contents).sort()`, so two contents arrays with
// the same members are the SAME version. The runtime, however, captures contents
// reads in live insertion order (`Array.from(obj.contents)`), while the serialized
// authority stores them sorted — so right after a contents mutation (e.g. `enter`
// appends the actor to a room's contents) a locally-planned follow-up read records
// `[...,actor]` while the committed authority holds the sorted array. Comparing
// those order-sensitively spuriously rejects the turn as a value mismatch even
// though the membership (and version) are identical. Compare contents as a set so
// the value check stays consistent with the version hash; genuine membership
// changes still differ once sorted, and the version check already guards them.
function transcriptReadValuesMatch(cell: TranscriptCell, actual: WooValue, recorded: WooValue): boolean {
  if (cell.kind === "contents") {
    return stableJson(canonicalContentsValue(actual)) === stableJson(canonicalContentsValue(recorded));
  }
  return stableJson(actual) === stableJson(recorded);
}

function canonicalContentsValue(value: WooValue): WooValue {
  return Array.isArray(value) ? [...value].sort() : value;
}

