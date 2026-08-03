import type { ErrorValue, ObjRef, Observation, WooObject, WooValue } from "./types";
import type { ProjectionWrite } from "./projection-delta";
import { nativePrimitiveIsTranscriptTracked } from "./native-primitive-contract";

export type TurnRoute = "direct" | "sequenced";

export type RecordedCell =
  | { kind: "prop"; object: ObjRef; name: string }
  | { kind: "verb"; object: ObjRef; name: string }
  | { kind: "location"; object: ObjRef }
  | { kind: "contents"; object: ObjRef }
  | { kind: "lifecycle"; object: ObjRef };

export type RecordedCellWriteOp = "set" | "create" | "move" | "add" | "remove" | "replace" | "delete";
export type RecordedProjectionWrite = Extract<ProjectionWrite, { table: "snapshots" | "tombstones" | "counters" }>;
/** Producer provenance for the controlled generic surface primitives. This is
 * never a capability by itself; commit authority re-derives the surface from
 * the recorded frame and authoritative actor lineage/features. */
export type RecordedSurfaceAuthority = "builder_surface";

/**
 * A semantic dependency of a proof, distinct from the cell eventually placed
 * in the transcript. Inherited lookup proofs are stored at the receiver, but
 * their value/definer also depends on every lineage and definition namespace
 * consulted while resolving them.
 */
export type RecordedProofDependency =
  | { kind: "lineage"; object: ObjRef }
  | { kind: "property_resolution"; object: ObjRef; name: string }
  | { kind: "verb_resolution"; object: ObjRef };

// Authority is captured at the VM-frame boundary so commit validation can
// authorize each mutation against the exact `progr` that performed it.
export type RecordedWriteAuthority = {
  progr: ObjRef;
  thisObj: ObjRef;
  verb: string;
  definer: ObjRef;
  caller: ObjRef;
  callerPerms: ObjRef;
};

export type TurnStart = {
  id?: string;
  route: TurnRoute;
  scope: ObjRef;
  seq: number;
  session?: string | null;
  actor: ObjRef;
  target: ObjRef;
  verb: string;
  /** Exact command-planned page identity. Omitted for ordinary name lookup. */
  verb_definer?: ObjRef;
  args: WooValue[];
  body?: Record<string, WooValue>;
};

export type TurnRecorderEvent =
  | { kind: "turn_start"; turn: TurnStart }
  | { kind: "turn_finish"; ok: true; result?: WooValue }
  | { kind: "turn_finish"; ok: false; error: ErrorValue }
  | { kind: "cell_read"; cell: RecordedCell; value: WooValue; version?: string }
  | { kind: "cell_write"; cell: RecordedCell; value: WooValue; op: RecordedCellWriteOp; prior?: string; next?: string; authority?: RecordedSurfaceAuthority; writer?: RecordedWriteAuthority }
  | { kind: "prop_read"; object: ObjRef; name: string; value: WooValue; version?: number | string; dependencies?: RecordedProofDependency[] }
  | { kind: "prop_write"; object: ObjRef; name: string; hadValue: boolean; before?: WooValue; after: WooValue; changed: boolean; beforeVersion?: number | string; afterVersion?: number | string; writer?: RecordedWriteAuthority }
  | { kind: "object_create"; object: ObjRef; name: string; parent: ObjRef | null; owner: ObjRef; anchor: ObjRef | null; location: ObjRef | null; flags: WooObject["flags"]; authority?: RecordedSurfaceAuthority; writer?: RecordedWriteAuthority }
  | { kind: "object_move"; object: ObjRef; from: ObjRef | null; to: ObjRef; writer?: RecordedWriteAuthority }
  // A session's active scope changed (the actor entered/left a space). This is a
  // first-class routing/presence effect, distinct from the physical
  // `object_move`: it is recorded even when the actor's physical location does
  // not change (a no-op enter while already in the room), and it drives the live
  // presence projections + session-row materialization. See cell-authority CA8.
  | { kind: "session_scope"; session: string; actor: ObjRef; from: ObjRef | null; to: ObjRef | null; rosterVisible?: false }
  | { kind: "projection_write"; write: RecordedProjectionWrite }
  | { kind: "observe"; observation: Observation }
  | { kind: "dispatch"; target: ObjRef; verb: string; startAt?: ObjRef | null; definer: ObjRef; implementation: "bytecode" | "native"; owner: ObjRef; version?: number; source_hash?: string; direct_callable?: boolean; native?: string; dependencies?: RecordedProofDependency[] }
  | { kind: "state_probe"; cell: RecordedCell; dependencies?: RecordedProofDependency[] }
  | { kind: "logical_input"; name: string; value: WooValue }
  | { kind: "untracked_effect"; name: string; detail?: WooValue }
  // Proof-free evidence that an invalidated native dispatch was untracked.
  // Rollback may discard the transient verb-page proof, but completeness must
  // still fail closed rather than laundering the native through pruning.
  | { kind: "incomplete_evidence"; reason: string }
  // CO16.2: arming and cancelling a scheduled turn are authority-bearing
  // effects, not writes. They carry the same per-frame `writer` provenance a
  // write does, and for the same reason: the commit scope must be able to
  // prove which object's namespace the id belongs to (CO16.3) and whether the
  // arming frame held wizard authority for an `always` entry (CO16.6),
  // without taking the planner's word for either.
  | { kind: "schedule"; request: RecordedScheduleRequest; writer?: RecordedWriteAuthority }
  | { kind: "cancel_schedule"; id: string; writer?: RecordedWriteAuthority };

/** A scheduled turn as the arming turn recorded it. `id` is already
 * namespaced (`<object>:<key>`) by the engine — see CO16.3. */
export type RecordedScheduleRequest = {
  id: string;
  at: number;
  idlePolicy: "while_active" | "always";
  call: { actor: ObjRef; target: ObjRef; verb: string; args: WooValue[] };
};

export type RecordedTurn = {
  start: TurnStart;
  events: TurnRecorderEvent[];
};

export interface ActiveTurnRecorder {
  event(event: TurnRecorderEvent): void;
  /**
   * Open a nestable behavior transaction. Events remain private to the
   * innermost scope until it commits. Abort discards rolled-back domain
   * effects, but retains durable pre-mutation reads/proofs, logical inputs,
   * and untracked-effect evidence needed for validation and deterministic
   * replay. Proofs of state seen only after a rolled-back mutation are
   * discarded because no authority can validate that transient state.
   * Envelope events recorded outside a scope (sequence allocation and the
   * terminal outcome) therefore cannot be confused with behavior effects.
   */
  beginBehaviorScope(): void;
  commitBehaviorScope(): void;
  abortBehaviorScope(): void;
  /** Events staged in the innermost behavior scope, used to prove that a
   * terminal command wrapper has performed reads/dispatch only. */
  currentBehaviorEvents(): readonly TurnRecorderEvent[];
  /** Remove a provisional wrapper turn which has transferred ownership to
   * the target's one authoritative turn. */
  discardTurn(): void;
}

export interface TurnRecorder {
  startTurn(turn: TurnStart): ActiveTurnRecorder;
}

class NoopActiveTurnRecorder implements ActiveTurnRecorder {
  event(): void {
    // Intentionally empty.
  }

  beginBehaviorScope(): void {
    // Intentionally empty.
  }

  commitBehaviorScope(): void {
    // Intentionally empty.
  }

  abortBehaviorScope(): void {
    // Intentionally empty.
  }

  currentBehaviorEvents(): readonly TurnRecorderEvent[] {
    return [];
  }

  discardTurn(): void {
    // Intentionally empty.
  }
}

class NoopTurnRecorder implements TurnRecorder {
  private readonly active = new NoopActiveTurnRecorder();

  startTurn(): ActiveTurnRecorder {
    return this.active;
  }
}

export const noopTurnRecorder: TurnRecorder = new NoopTurnRecorder();

export class InMemoryTurnRecorder implements TurnRecorder {
  readonly turns: RecordedTurn[] = [];

  startTurn(turn: TurnStart): ActiveTurnRecorder {
    const start = {
      ...turn,
      args: structuredClone(turn.args) as WooValue[],
      ...(turn.body !== undefined ? { body: structuredClone(turn.body) as Record<string, WooValue> } : {})
    };
    const recorded: RecordedTurn = {
      start,
      events: [{ kind: "turn_start", turn: start }]
    };
    this.turns.push(recorded);
    const behaviorScopes: TurnRecorderEvent[][] = [];
    const destination = (): TurnRecorderEvent[] => behaviorScopes.at(-1) ?? recorded.events;
    return {
      event: (event) => {
        destination().push(cloneRecorderEvent(event));
      },
      beginBehaviorScope: () => {
        behaviorScopes.push([]);
      },
      commitBehaviorScope: () => {
        const committed = behaviorScopes.pop();
        if (!committed) throw new Error("turn recorder behavior-scope commit without begin");
        destination().push(...committed);
      },
      abortBehaviorScope: () => {
        const aborted = behaviorScopes.pop();
        if (!aborted) throw new Error("turn recorder behavior-scope abort without begin");
        // A proof remains authority-valid only when it describes durable
        // pre-scope state. Walk in execution order: once a rolled-back
        // mutation touches a cell, later reads of that cell describe the
        // transient state which rollback just erased and must not escape into
        // the failed transcript. Earlier reads still prove the path into the
        // failure. Committed nested scopes have already merged here, so an
        // outer abort applies the same rule across the complete nested trace.
        destination().push(...recorderEventsSurvivingBehaviorAbort(aborted));
      },
      currentBehaviorEvents: () => behaviorScopes.at(-1) ?? [],
      discardTurn: () => {
        const index = this.turns.indexOf(recorded);
        if (index >= 0) this.turns.splice(index, 1);
      }
    };
  }
}

export function objectCreateEvent(object: WooObject, authority?: RecordedSurfaceAuthority): TurnRecorderEvent {
  return {
    kind: "object_create",
    object: object.id,
    name: object.name,
    parent: object.parent,
    owner: object.owner,
    anchor: object.anchor,
    location: object.location,
    flags: { ...object.flags },
    ...(authority ? { authority } : {})
  };
}

function cloneRecorderEvent(event: TurnRecorderEvent): TurnRecorderEvent {
  return structuredClone(event) as TurnRecorderEvent;
}

function recorderEventSurvivesBehaviorAbort(event: TurnRecorderEvent): boolean {
  return (
    event.kind === "cell_read" ||
    event.kind === "prop_read" ||
    event.kind === "dispatch" ||
    event.kind === "state_probe" ||
    event.kind === "logical_input" ||
    event.kind === "untracked_effect" ||
    event.kind === "incomplete_evidence"
  );
}

/**
 * Retain only proof material that an authority can validate against the
 * restored pre-scope state. This is deliberately a cell/dependency rule, not
 * an effect-kind allow-list for the transcript: logical inputs and untracked
 * effect evidence survive independently, while each proof is checked against
 * the precise rolled-back mutations that preceded it.
 */
function recorderEventsSurvivingBehaviorAbort(events: readonly TurnRecorderEvent[]): TurnRecorderEvent[] {
  const invalidatedCells = new Set<string>();
  const invalidatedObjects = new Set<ObjRef>();
  const invalidatedDispatchTargets = new Set<ObjRef>();
  const invalidatedDependencies = new Set<string>();
  const surviving: TurnRecorderEvent[] = [];

  for (const event of events) {
    if (recorderEventSurvivesBehaviorAbort(event)) {
      const invalidated = recorderProofWasInvalidated(
        event,
        invalidatedCells,
        invalidatedObjects,
        invalidatedDispatchTargets,
        invalidatedDependencies
      );
      if (!invalidated) {
        surviving.push(event);
      } else if (
        event.kind === "dispatch" &&
        event.implementation === "native" &&
        !nativePrimitiveIsTranscriptTracked(event.native)
      ) {
        // The dispatch proof describes transient resolution state and cannot
        // survive, but its negative completeness evidence is independent of
        // that proof and must remain terminal.
        surviving.push({
          kind: "incomplete_evidence",
          reason: `native:${event.target}:${event.verb}`
        });
      }
    }
    recordRolledBackProofInvalidations(
      event,
      invalidatedCells,
      invalidatedObjects,
      invalidatedDispatchTargets,
      invalidatedDependencies
    );
  }
  return surviving;
}

function recordedCellKey(cell: RecordedCell): string {
  switch (cell.kind) {
    case "prop":
    case "verb":
      return `${cell.kind}\u0000${cell.object}\u0000${cell.name}`;
    case "location":
    case "contents":
    case "lifecycle":
      return `${cell.kind}\u0000${cell.object}`;
  }
}

function recorderProofCell(event: TurnRecorderEvent): RecordedCell | null {
  switch (event.kind) {
    case "cell_read":
    case "state_probe":
      return event.cell;
    case "prop_read":
      return { kind: "prop", object: event.object, name: event.name };
    case "dispatch":
      // The transcript turns a dispatch into a verb-page read on its definer.
      // An inherited dispatch on a transient target still proves a durable
      // class page, while a verb defined on the transient object has no
      // surviving authority row.
      return { kind: "verb", object: event.definer, name: event.verb };
    default:
      return null;
  }
}

function recorderProofWasInvalidated(
  event: TurnRecorderEvent,
  invalidatedCells: ReadonlySet<string>,
  invalidatedObjects: ReadonlySet<ObjRef>,
  invalidatedDispatchTargets: ReadonlySet<ObjRef>,
  invalidatedDependencies: ReadonlySet<string>
): boolean {
  // Object existence is an implicit prerequisite of every dispatch even
  // though the transcript read is stored at the resolved definer's verb cell.
  if (event.kind === "dispatch" && invalidatedDispatchTargets.has(event.target)) return true;
  if (
    (event.kind === "prop_read" || event.kind === "dispatch" || event.kind === "state_probe") &&
    event.dependencies?.some((dependency) =>
      invalidatedDependencies.has(recordedProofDependencyKey(dependency))
    )
  ) {
    return true;
  }
  const cell = recorderProofCell(event);
  return cell !== null && (
    invalidatedObjects.has(cell.object) ||
    invalidatedCells.has(recordedCellKey(cell))
  );
}

function recordRolledBackProofInvalidations(
  event: TurnRecorderEvent,
  invalidatedCells: Set<string>,
  invalidatedObjects: Set<ObjRef>,
  invalidatedDispatchTargets: Set<ObjRef>,
  invalidatedDependencies: Set<string>
): void {
  const invalidate = (cell: RecordedCell): void => {
    invalidatedCells.add(recordedCellKey(cell));
  };
  const invalidateDependency = (dependency: RecordedProofDependency): void => {
    invalidatedDependencies.add(recordedProofDependencyKey(dependency));
  };
  const invalidateContents = (object: ObjRef | null): void => {
    if (object !== null) invalidate({ kind: "contents", object });
  };

  switch (event.kind) {
    case "prop_write":
      invalidate({ kind: "prop", object: event.object, name: event.name });
      return;
    case "cell_write":
      invalidate(event.cell);
      if (event.cell.kind === "lifecycle") {
        // A lineage edge participates in every inherited property/verb lookup
        // whose recorded dependency closure visited this object.
        invalidateDependency({ kind: "lineage", object: event.cell.object });
        if (event.op === "create" || event.op === "delete") invalidatedObjects.add(event.cell.object);
        if (event.op === "delete") invalidatedDispatchTargets.add(event.cell.object);
      } else if (event.cell.kind === "verb") {
        // Canonical names, aliases, and slot precedence share one vocabulary
        // namespace. Replacing any page can change a later dispatch whose
        // invocation name differs from the page's canonical name.
        invalidateDependency({ kind: "verb_resolution", object: event.cell.object });
      } else if (
        event.cell.kind === "prop" &&
        (event.op === "replace" || event.op === "delete")
      ) {
        // Authored definition/default changes affect descendant inherited
        // reads. Ordinary instance value writes remain exact-cell effects.
        invalidateDependency({
          kind: "property_resolution",
          object: event.cell.object,
          name: event.cell.name
        });
      }
      return;
    case "object_create":
      invalidatedObjects.add(event.object);
      invalidateDependency({ kind: "lineage", object: event.object });
      invalidateContents(event.location);
      return;
    case "object_move":
      invalidate({ kind: "location", object: event.object });
      invalidateContents(event.from);
      invalidateContents(event.to);
      return;
    case "projection_write":
      if (event.write.table === "tombstones") {
        // Tombstone changes are the durable lifecycle effect of recycle (and
        // repair-time resurrection). Either direction changes whether every
        // cell and dispatch edge for the object can be attested.
        invalidatedObjects.add(event.write.key);
        invalidatedDispatchTargets.add(event.write.key);
        invalidateDependency({ kind: "lineage", object: event.write.key });
      }
      return;
    default:
      return;
  }
}

function recordedProofDependencyKey(dependency: RecordedProofDependency): string {
  switch (dependency.kind) {
    case "lineage":
    case "verb_resolution":
      return `${dependency.kind}\u0000${dependency.object}`;
    case "property_resolution":
      return `${dependency.kind}\u0000${dependency.object}\u0000${dependency.name}`;
  }
}
