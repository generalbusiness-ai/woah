import { createWorldFromSerialized } from "./bootstrap";
import type { SerializedWorld } from "./repository";
import type { AppliedFrame, DirectResultFrame, ErrorFrame, Message } from "./types";
import { InMemoryTurnRecorder, type RecordedTurn, type TurnRecorderEvent } from "./turn-recorder";

export type TurnReplayResult = {
  frame: AppliedFrame | DirectResultFrame | ErrorFrame;
  recorded: RecordedTurn;
  serializedAfter: SerializedWorld;
};

export async function replayRecordedTurn(serializedBefore: SerializedWorld, turn: RecordedTurn): Promise<TurnReplayResult> {
  const world = createWorldFromSerialized(serializedBefore, { persist: false });
  const recorder = new InMemoryTurnRecorder();
  world.setTurnRecorder(recorder);
  world.setLogicalInputsForReplay(turn.events
    .filter((event): event is Extract<TurnRecorderEvent, { kind: "logical_input" }> => event.kind === "logical_input")
    .map((event) => ({ name: event.name, value: event.value })));

  let frame: AppliedFrame | DirectResultFrame | ErrorFrame;
  const message: Message = {
    actor: turn.start.actor,
    target: turn.start.target,
    verb: turn.start.verb,
    args: turn.start.args
  };
  if (turn.start.route === "direct") {
    frame = await world.directCall(turn.start.id, turn.start.actor, turn.start.target, turn.start.verb, turn.start.args, { sessionId: turn.start.session ?? null });
  } else if (turn.start.session) {
    frame = await world.call(turn.start.id, turn.start.session, turn.start.scope, message);
  } else {
    frame = await world.applyCall(turn.start.id, turn.start.scope, message, null);
  }

  const recorded = recorder.turns[0];
  if (!recorded) throw new Error("replay produced no recorded turn");
  return { frame, recorded, serializedAfter: world.exportWorld() };
}

export function comparableTurnEvents(events: TurnRecorderEvent[]): TurnRecorderEvent[] {
  return events;
}
