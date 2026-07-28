import type { ErrorValue, ObjRef, Observation, WooObject, WooValue } from "./types";
import type { ProjectionWrite } from "./projection-delta";

export type TurnRoute = "direct" | "sequenced";

export type RecordedCell =
  | { kind: "prop"; object: ObjRef; name: string }
  | { kind: "verb"; object: ObjRef; name: string }
  | { kind: "location"; object: ObjRef }
  | { kind: "contents"; object: ObjRef }
  | { kind: "lifecycle"; object: ObjRef };

export type RecordedCellWriteOp = "set" | "create" | "move" | "add" | "remove" | "replace" | "delete";
export type RecordedProjectionWrite = Extract<ProjectionWrite, { table: "snapshots" | "tombstones" | "counters" }>;

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
  args: WooValue[];
  body?: Record<string, WooValue>;
};

export type TurnRecorderEvent =
  | { kind: "turn_start"; turn: TurnStart }
  | { kind: "turn_finish"; ok: true; result?: WooValue }
  | { kind: "turn_finish"; ok: false; error: ErrorValue }
  | { kind: "cell_read"; cell: RecordedCell; value: WooValue; version?: string }
  | { kind: "cell_write"; cell: RecordedCell; value: WooValue; op: RecordedCellWriteOp; prior?: string; next?: string; writer?: RecordedWriteAuthority }
  | { kind: "prop_read"; object: ObjRef; name: string; value: WooValue; version?: number | string }
  | { kind: "prop_write"; object: ObjRef; name: string; hadValue: boolean; before?: WooValue; after: WooValue; changed: boolean; beforeVersion?: number | string; afterVersion?: number | string; writer?: RecordedWriteAuthority }
  | { kind: "object_create"; object: ObjRef; name: string; parent: ObjRef | null; owner: ObjRef; anchor: ObjRef | null; location: ObjRef | null; flags: WooObject["flags"]; writer?: RecordedWriteAuthority }
  | { kind: "object_move"; object: ObjRef; from: ObjRef | null; to: ObjRef; writer?: RecordedWriteAuthority }
  // A session's active scope changed (the actor entered/left a space). This is a
  // first-class routing/presence effect, distinct from the physical
  // `object_move`: it is recorded even when the actor's physical location does
  // not change (a no-op enter while already in the room), and it drives the live
  // presence projections + session-row materialization. See cell-authority CA8.
  | { kind: "session_scope"; session: string; actor: ObjRef; from: ObjRef | null; to: ObjRef | null; rosterVisible?: false }
  | { kind: "projection_write"; write: RecordedProjectionWrite }
  | { kind: "observe"; observation: Observation }
  | { kind: "dispatch"; target: ObjRef; verb: string; startAt?: ObjRef | null; definer: ObjRef; implementation: "bytecode" | "native"; owner: ObjRef; version?: number; source_hash?: string; direct_callable?: boolean; native?: string }
  | { kind: "state_probe"; cell: RecordedCell }
  | { kind: "logical_input"; name: string; value: WooValue }
  | { kind: "untracked_effect"; name: string; detail?: WooValue }
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
   * effects, but retains reads/proofs/logical inputs and untracked-effect
   * evidence needed for validation and deterministic replay.
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
        // Reads normally survive a failed behavior because they are the
        // optimistic proof for the canonical error outcome. A read whose
        // SUBJECT was created inside this same aborted scope is different:
        // rollback erased that subject, so no authority can attest it and it
        // cannot conflict with durable state. Drop those orphan proofs along
        // with the create. This is computed over the complete aborted scope,
        // including committed nested scopes, so an outer abort also cleans up
        // reads of objects created before a nested call.
        const rolledBackCreates = new Set(
          aborted
            .filter((event): event is Extract<TurnRecorderEvent, { kind: "object_create" }> => event.kind === "object_create")
            .map((event) => event.object)
        );
        destination().push(...aborted.filter((event) =>
          recorderEventSurvivesBehaviorAbort(event) &&
          !recorderEventReadsRolledBackObject(event, rolledBackCreates)
        ));
      },
      currentBehaviorEvents: () => behaviorScopes.at(-1) ?? [],
      discardTurn: () => {
        const index = this.turns.indexOf(recorded);
        if (index >= 0) this.turns.splice(index, 1);
      }
    };
  }
}

export function objectCreateEvent(object: WooObject): TurnRecorderEvent {
  return {
    kind: "object_create",
    object: object.id,
    name: object.name,
    parent: object.parent,
    owner: object.owner,
    anchor: object.anchor,
    location: object.location,
    flags: { ...object.flags }
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
    event.kind === "untracked_effect"
  );
}

function recorderEventReadsRolledBackObject(event: TurnRecorderEvent, rolledBackCreates: ReadonlySet<ObjRef>): boolean {
  if (rolledBackCreates.size === 0) return false;
  switch (event.kind) {
    case "cell_read":
    case "state_probe":
      return rolledBackCreates.has(event.cell.object);
    case "prop_read":
      return rolledBackCreates.has(event.object);
    case "dispatch":
      // The transcript turns a dispatch into a verb-page read on its definer.
      // An inherited dispatch on a transient target still proves a durable
      // class page, while a verb defined on the transient object has no
      // surviving authority row.
      return rolledBackCreates.has(event.definer);
    default:
      return false;
  }
}
