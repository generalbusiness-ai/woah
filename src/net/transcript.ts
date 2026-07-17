/**
 * Transcript bridge + apply — coherence.md CO3/CO4 step 10.
 *
 * THE single v2 bridge file (Phase-2 kickoff rule): the coherence layer
 * consumes the *implemented* v2 transcript shape
 * (`woo.effect_transcript.shadow.v1`, src/core/effect-transcript.ts) via
 * type imports here and nowhere else, so the Phase-2 differential gate
 * compares like with like and Phase-5 deletion has one place to cut.
 * coherence.md CO3's `woo.effect_transcript.v1` is the target shape the
 * kind string graduates to when v2 is deleted.
 *
 * Apply is deterministic re-application of recorded writes to a CellStore
 * clone — never re-execution of verb bytecode (CO4). The recorded-cell →
 * net-cell translation:
 *
 * | RecordedCell            | net cell                       |
 * |-------------------------|--------------------------------|
 * | prop {object,name}      | property_cell:<object>:<name>  |
 * | verb {object,name}      | verb_bytecode:<object>:<name>  |
 * | location {object}       | object_live:<object>           |
 * | lifecycle {object}      | object_lineage:<object>        |
 * | contents {object}       | — none: contents is a derived   |
 * |                         |   projection (CA4/CO9), never an|
 * |                         |   authority cell; those writes  |
 * |                         |   route to the projection applier|
 * | session {object=sid}    | session:<sid> — net-only kind   |
 * |                         |   (CO14; see SessionTranscriptCell|
 * |                         |   below): the v2 recorder never |
 * |                         |   emits it                      |
 */
import type {
  EffectTranscript as EngineEffectTranscript,
  TranscriptCell as EngineTranscriptCell,
  TranscriptRead as EngineTranscriptRead,
  TranscriptWrite as EngineTranscriptWrite
} from "../core/effect-transcript";
import { finalWritesByCell } from "../core/shadow-commit-scope";
import type { Principal } from "./attribution";
import { CellStore, cellKey, cellVersion, type EpochStamp } from "./cells";
import type { TraceContext } from "./trace";
import { netError } from "./errors";

/**
 * CO14: the net layer's session-cell vocabulary, widened AT THE BRIDGE.
 *
 * The v2 recorder never emits a session-kind RecordedCell (v2 persists
 * session rows out-of-band via persistSession), so the engine's
 * `RecordedCell` union — and every exhaustive switch on it in the frozen
 * v2 layer — stays untouched. Session cells enter transcripts only
 * through the net layer's own producers: `mintSessionSubmit`
 * (sessions.ts) and the plan-time transition fold (plan.ts). Everything
 * downstream of the bridge (scope validation, apply, routing) consumes
 * the widened types re-exported here, so an engine transcript remains
 * directly assignable (the union only widens).
 */
export type SessionTranscriptCell = { kind: "session"; object: string };
export type TranscriptCell = EngineTranscriptCell | SessionTranscriptCell;
export type TranscriptRead = Omit<EngineTranscriptRead, "cell"> & { cell: TranscriptCell };
export type TranscriptWrite = Omit<EngineTranscriptWrite, "cell"> & { cell: TranscriptCell };
export type EffectTranscript = Omit<EngineEffectTranscript, "reads" | "writes" | "stateProbes"> & {
  reads: TranscriptRead[];
  writes: TranscriptWrite[];
  stateProbes?: TranscriptCell[];
  /** Identity-door guest claim (CO14 addendum): a session mint stamped
   * exclusive is refused (`actor_occupied`, terminal) when ANY other
   * live session already binds the same actor — validated at the actor's
   * cluster sequencer, so concurrent claims serialize and exactly one
   * wins. Present-only-when-true keeps prior transcript hashes unchanged. */
  exclusiveMint?: boolean;
  /** Logout/release write (CO14): authorization proves the current owned
   * session instead of requiring the replacement's short expiry to
   * remain live across the cross-DO submit latency. */
  sessionClose?: boolean;
  /** Ordering projections this plan read (full ordered-children lists and
   * bounded neighbour answers alike), each attested at the authority content
   * `version` at read time (P1.1), the explicit container identity, and the
   * OWNING scope the answer was fetched from (R3 — `parent: null` names the
   * roots of exactly that container, so root ownership is never ambiguous).
   * The committing scope re-derives the ordering version for entries it OWNS
   * from its current edge cells and rejects the plan (read_version_mismatch)
   * if any differ; FOREIGN entries validate against the owner's ordering
   * attestation carried in the submit (mirror of foreign cell reads) — so a
   * concurrent same-parent insert that lands between plan and submit
   * invalidates the read that produced the rank, in-scope or cross-scope.
   * Present-only-when-nonempty keeps prior transcript hashes unchanged. */
  orderingReads?: Array<{ container: string; parent: string | null; scope: string; version: string }>;
  /** Audit attribution (audit.md AU3.2): stamped by the gateway at the
   * trust boundary, never accepted from client input. Lives INSIDE the
   * transcript so it participates in the transcript hash and survives
   * into the durable record. Present-only-when-set keeps prior
   * transcript hashes unchanged. */
  principal?: Principal;
  /** W3C trace context (audit.md AU2): adopted from the caller or minted
   * at the gateway; joins this commit to the operational trace and to
   * the customer's own systems. Present-only-when-set. */
  trace?: TraceContext;
};

/**
 * The canonical `property_cell` payload: `{value?, def?}`.
 *
 * `def` is present when the object locally *defines* the property (the
 * PropertyDef row); `value` when the object locally *values* it. A
 * def-only payload (inherited default, never locally set) omits `value`;
 * a value-only payload (set on an object that inherits its def) omits
 * `def`. The bridge (bridge.ts) seeds this shape and applyTranscript
 * produces it, so an apply-produced cell is version-identical to a
 * bridge-seeded cell for the same logical state — without this,
 * post-state parity breaks on the first write to a seeded property
 * (kickoff design, step 8).
 */
export type PropertyCellPayload = { value?: unknown; def?: unknown };

/** Build a `{value?, def?}` payload, omitting absent slots entirely so the
 * canonical-JSON content address is stable across producers. `hasValue`
 * is explicit because `undefined` is not a representable Woo value but
 * "no local value" must be distinguishable from "locally null". */
export function propertyCellPayload(input: { hasValue: boolean; value?: unknown; def?: unknown }): PropertyCellPayload {
  return {
    ...(input.hasValue ? { value: input.value } : {}),
    ...(input.def !== undefined ? { def: input.def } : {})
  };
}

/** The `def` slot of a `{value?, def?}` payload; undefined when the payload
 * carries no local definition (or is not a property payload at all). */
export function propertyCellDef(payload: unknown): unknown {
  if (payload && typeof payload === "object" && !Array.isArray(payload) && "def" in payload) {
    return (payload as PropertyCellPayload).def;
  }
  return undefined;
}

/** Canonical string identity for a recorded cell (dedup/lookup key). */
export function transcriptCellId(cell: TranscriptCell): string {
  switch (cell.kind) {
    case "prop": return `prop:${cell.object}:${cell.name}`;
    case "verb": return `verb:${cell.object}:${cell.name}`;
    case "location": return `location:${cell.object}`;
    case "contents": return `contents:${cell.object}`;
    case "lifecycle": return `lifecycle:${cell.object}`;
    case "session": return `session:${cell.object}`;
  }
}

/** RecordedCell → net authority cell key; null for projection-only cells
 * (contents — CA4/CO9: excluded from commit validation and authority). */
export function netCellKeyFor(cell: TranscriptCell): string | null {
  switch (cell.kind) {
    case "prop": return cellKey("property_cell", cell.object, cell.name);
    case "verb": return cellKey("verb_bytecode", cell.object, cell.name);
    case "location": return cellKey("object_live", cell.object);
    case "lifecycle": return cellKey("object_lineage", cell.object);
    case "contents": return null;
    case "session": return cellKey("session", cell.object);
  }
}

export type ApplyResult = {
  /** The post-state store (the clone that was applied to). */
  post: CellStore;
  /** Authority cell keys touched, in deterministic (sorted) order. */
  touched: string[];
  /** Contents writes routed to the projection applier (CO9) — the single
   * write path for derived relations; never applied to authority cells. */
  projectionWrites: TranscriptWrite[];
  /** Deterministic digest of touched-cell versions: the CO4 step-10
   * post-state comparison value. */
  postStateVersion: string;
};

/**
 * Last-write-wins collapse over the widened write set. Engine-kind cells
 * collapse through the v2 `finalWritesByCell` UNCHANGED (byte-identical
 * across the two layers for the differential gate); session-kind cells —
 * which v2's cell-key switch has never seen — collapse by the same rule
 * locally. The two id spaces cannot collide (session ids vs object ids),
 * so splitting preserves the collapse exactly.
 */
function finalNetWritesByCell(transcript: EffectTranscript): TranscriptWrite[] {
  const engineWrites: EngineTranscriptWrite[] = [];
  const sessionWrites = new Map<string, TranscriptWrite>();
  for (const write of transcript.writes) {
    if (write.cell.kind === "session") sessionWrites.set(transcriptCellId(write.cell), write);
    else engineWrites.push(write as EngineTranscriptWrite);
  }
  const collapsedEngine =
    sessionWrites.size === 0
      ? finalWritesByCell(transcript as unknown as EngineEffectTranscript)
      : finalWritesByCell({ ...transcript, writes: engineWrites } as unknown as EngineEffectTranscript);
  return [...(collapsedEngine as TranscriptWrite[]), ...sessionWrites.values()];
}

/**
 * Apply a transcript's final writes to a clone of `pre` (CO4 step 10:
 * applying can only add a post-state mismatch; it never runs bytecode).
 * Engine-kind collapsing is delegated to v2's `finalWritesByCell` so
 * last-write-wins stays byte-identical across the two layers for the
 * differential gate (see finalNetWritesByCell).
 */
export function applyTranscript(pre: CellStore, transcript: EffectTranscript, stamp: EpochStamp): ApplyResult {
  if (pre.role !== "authority") {
    throw netError("E_LINEAGE", "transcripts apply to authority state only", { role: pre.role });
  }
  const post = pre.clone();
  const touched = new Set<string>();
  const projectionWrites: TranscriptWrite[] = [];

  // Creates first: they materialize lineage + live cells the writes may
  // then touch (v2 constructs post-state the same way: creates, writes,
  // moves — VTN8/CO4).
  for (const create of transcript.creates ?? []) {
    const lineageKey = cellKey("object_lineage", create.object);
    post.commit({
      kind: "object_lineage",
      object: create.object,
      value: {
        parent: create.parent ?? null,
        owner: create.owner ?? null,
        name: create.name,
        anchor: create.anchor ?? null,
        flags: create.flags ?? {}
      },
      stamp
    });
    touched.add(lineageKey);
    const liveKey = cellKey("object_live", create.object);
    post.commit({ kind: "object_live", object: create.object, value: { location: create.location ?? null }, stamp });
    touched.add(liveKey);
  }

  for (const write of finalNetWritesByCell(transcript)) {
    const key = netCellKeyFor(write.cell);
    if (key === null) {
      projectionWrites.push(write);
      continue;
    }
    switch (write.cell.kind) {
      case "session": {
        // CO14: a session is a cell. `set` writes commit the full row
        // (mint/refresh/transition-fold — the value is the whole
        // SerializedSession-shaped payload, so post-state parity holds
        // from the write value alone, without prior-state merging);
        // `remove` is expiry/logout.
        if (write.op === "remove") post.delete(key);
        else post.commit({ kind: "session", object: write.cell.object, value: write.value, stamp });
        break;
      }
      case "location": {
        post.commit({ kind: "object_live", object: write.cell.object, value: { location: write.value ?? null }, stamp });
        break;
      }
      case "lifecycle": {
        // A create's lifecycle write is the ECHO of the create record the
        // loop above already applied (the recorder emits both for one
        // object_create). Re-merging it would graft a `lifecycle` key onto
        // the lineage payload and fork its content address from the
        // bridge-seeded shape — the step-9 differential gate catches this
        // as a lineage version divergence on every created object.
        if (write.op === "create" && (transcript.creates ?? []).some((create) => create.object === write.cell.object)) {
          break;
        }
        const existing = post.get(key);
        const prior = (existing?.value ?? {}) as Record<string, unknown>;
        post.commit({ kind: "object_lineage", object: write.cell.object, value: { ...prior, lifecycle: write.op }, stamp });
        break;
      }
      case "prop": {
        if (write.op === "delete") {
          post.delete(key);
          break;
        }
        if (write.op === "replace") {
          post.commit({
            kind: "property_cell",
            object: write.cell.object,
            name: write.cell.name,
            value: write.value,
            stamp
          });
          break;
        }
        const def = propertyCellDef(post.get(key)?.value);
        // op "remove" is LambdaMOO clear_property: drop the LOCAL value so
        // the property reverts to the inherited default (v2 parity:
        // applyTranscriptPropWrite → removeProperty). With a local def the
        // cell becomes def-only `{def}` (the bridge reconstructs
        // no-local-value from the missing `value` slot); with no def the
        // cell disappears — post.delete on the clone, hashed "absent" by
        // postStateVersion, adopted as a delete by scope.submit's
        // absent-from-post handling.
        if (write.op === "remove") {
          if (def !== undefined) {
            post.commit({
              kind: "property_cell",
              object: write.cell.object,
              name: write.cell.name,
              value: propertyCellPayload({ hasValue: false, def }),
              stamp
            });
          } else {
            post.delete(key);
          }
          break;
        }
        // `{value, def?}` payload, merging `def` from the prior cell: the
        // write updates the value slot only; a local definition survives so
        // the applied cell stays version-identical to what the bridge would
        // seed for the same post-state (see PropertyCellPayload).
        post.commit({
          kind: "property_cell",
          object: write.cell.object,
          name: write.cell.name,
          value: propertyCellPayload({ hasValue: true, value: write.value, def }),
          stamp
        });
        break;
      }
      case "verb": {
        if (write.op === "remove") {
          post.delete(key);
        } else {
          post.commit({ kind: "verb_bytecode", object: write.cell.object, name: write.cell.name, value: write.value, stamp });
        }
        break;
      }
      case "contents":
        // unreachable: netCellKeyFor returned null above
        break;
    }
    touched.add(key);
  }

  for (const move of transcript.moves ?? []) {
    const key = cellKey("object_live", move.object);
    const existing = post.get(key);
    const prior = (existing?.value ?? {}) as Record<string, unknown>;
    post.commit({ kind: "object_live", object: move.object, value: { ...prior, location: move.to }, stamp });
    touched.add(key);
  }

  const touchedSorted = [...touched].sort();
  return {
    post,
    touched: touchedSorted,
    projectionWrites,
    postStateVersion: postStateVersion(post, touchedSorted)
  };
}

/** Deterministic digest over the touched cells' content versions: the
 * comparison value for CO4 step 10. Missing cells hash as "absent" so a
 * delete/create asymmetry cannot collide with a value change. */
export function postStateVersion(store: CellStore, touched: readonly string[]): string {
  const pairs = touched.map((key) => [key, store.get(key)?.version ?? "absent"] as const);
  return cellVersion(pairs);
}
