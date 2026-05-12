import type { ErrorValue, ObjRef, Observation, WooObject, WooValue } from "./types";

export type TurnRoute = "direct" | "sequenced";

export type RecordedCell =
  | { kind: "prop"; object: ObjRef; name: string }
  | { kind: "verb"; object: ObjRef; name: string }
  | { kind: "location"; object: ObjRef }
  | { kind: "contents"; object: ObjRef }
  | { kind: "lifecycle"; object: ObjRef };

export type RecordedCellWriteOp = "set" | "create" | "move" | "add" | "remove" | "replace";

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
};

export type TurnRecorderEvent =
  | { kind: "turn_start"; turn: TurnStart }
  | { kind: "turn_finish"; ok: true; result?: WooValue }
  | { kind: "turn_finish"; ok: false; error: ErrorValue }
  | { kind: "cell_read"; cell: RecordedCell; value: WooValue; version?: string }
  | { kind: "cell_write"; cell: RecordedCell; value: WooValue; op: RecordedCellWriteOp; prior?: string; next?: string }
  | { kind: "prop_read"; object: ObjRef; name: string; value: WooValue; version?: number | string }
  | { kind: "prop_write"; object: ObjRef; name: string; hadValue: boolean; before?: WooValue; after: WooValue; changed: boolean; beforeVersion?: number | string; afterVersion?: number | string }
  | { kind: "object_create"; object: ObjRef; name: string; parent: ObjRef | null; owner: ObjRef; anchor: ObjRef | null; location: ObjRef | null; flags: WooObject["flags"] }
  | { kind: "object_move"; object: ObjRef; from: ObjRef | null; to: ObjRef }
  | { kind: "observe"; observation: Observation }
  | { kind: "dispatch"; target: ObjRef; verb: string; startAt?: ObjRef | null; definer: ObjRef; implementation: "bytecode" | "native"; owner: ObjRef; version?: number; source_hash?: string; direct_callable?: boolean; native?: string }
  | { kind: "logical_input"; name: string; value: WooValue }
  | { kind: "untracked_effect"; name: string; detail?: WooValue };

export type RecordedTurn = {
  start: TurnStart;
  events: TurnRecorderEvent[];
};

export interface ActiveTurnRecorder {
  event(event: TurnRecorderEvent): void;
}

export interface TurnRecorder {
  startTurn(turn: TurnStart): ActiveTurnRecorder;
}

class NoopActiveTurnRecorder implements ActiveTurnRecorder {
  event(): void {
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
    const recorded: RecordedTurn = {
      start: { ...turn, args: structuredClone(turn.args) as WooValue[] },
      events: [{ kind: "turn_start", turn: { ...turn, args: structuredClone(turn.args) as WooValue[] } }]
    };
    this.turns.push(recorded);
    return {
      event: (event) => {
        recorded.events.push(cloneRecorderEvent(event));
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
    flags: object.flags
  };
}

function cloneRecorderEvent(event: TurnRecorderEvent): TurnRecorderEvent {
  return structuredClone(event) as TurnRecorderEvent;
}
