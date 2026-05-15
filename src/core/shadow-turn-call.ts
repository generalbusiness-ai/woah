import { createWorldFromSerialized } from "./bootstrap";
import { effectTranscriptFromRecordedTurn, type EffectTranscript } from "./effect-transcript";
import type { SerializedWorld } from "./repository";
import type { AppliedFrame, DirectResultFrame, ErrorFrame, Message, ObjRef, WooValue } from "./types";
import { wooError } from "./types";
import {
  InMemoryTurnRecorder,
  type ActiveTurnRecorder,
  type RecordedTurn,
  type TurnRecorder,
  type TurnRecorderEvent,
  type TurnRoute,
  type TurnStart
} from "./turn-recorder";
import { shadowAtomHash, shadowReadCellPreimage, shadowWriteCellPreimage } from "./turn-key";
import type { WooWorld } from "./world";

export type ShadowTurnCall = {
  kind: "woo.turn_call.shadow.v1";
  id?: string;
  route: TurnRoute;
  scope: ObjRef;
  session?: string | null;
  actor: ObjRef;
  target: ObjRef;
  verb: string;
  args: WooValue[];
  body?: Record<string, WooValue>;
};

export type ShadowTurnCallRun = {
  frame: AppliedFrame | DirectResultFrame | ErrorFrame;
  recorded: RecordedTurn;
  transcript: EffectTranscript;
  serializedAfter: SerializedWorld;
};

export type ShadowTurnCallOptions = {
  allowed_atom_hashes?: Iterable<string>;
};

export async function runShadowTurnCall(
  serializedBefore: SerializedWorld,
  call: ShadowTurnCall,
  options: ShadowTurnCallOptions = {}
): Promise<ShadowTurnCallRun> {
  const world = createWorldFromSerialized(serializedBefore, { persist: false });
  return await runShadowTurnCallOnWorld(world, call, options);
}

export async function runShadowTurnCallOnWorld(
  world: WooWorld,
  call: ShadowTurnCall,
  options: ShadowTurnCallOptions = {}
): Promise<ShadowTurnCallRun> {
  const recorder = new InMemoryTurnRecorder();
  world.setTurnRecorder(options.allowed_atom_hashes
    ? new ShadowStateGuardTurnRecorder(recorder, new Set(options.allowed_atom_hashes))
    : recorder);

  let frame: AppliedFrame | DirectResultFrame | ErrorFrame;
  if (call.route === "direct") {
    frame = await world.directCall(call.id, call.actor, call.target, call.verb, call.args, { sessionId: call.session ?? null });
  } else {
    const message: Message = {
      actor: call.actor,
      target: call.target,
      verb: call.verb,
      args: call.args,
      body: call.body
    };
    frame = call.session
      ? await world.call(call.id, call.session, call.scope, message)
      : await world.applyCall(call.id, call.scope, message, null);
  }

  const recorded = recorder.turns[0];
  if (!recorded) {
    const suffix = frame.op === "error" ? `: ${frame.error.code} ${frame.error.message}` : "";
    throw new Error(`fresh turn produced no recording: ${call.target}:${call.verb}${suffix}`);
  }
  const transcript = effectTranscriptFromRecordedTurn(recorded);
  return {
    frame,
    recorded,
    transcript,
    serializedAfter: world.exportWorld()
  };
}

class ShadowStateGuardTurnRecorder implements TurnRecorder {
  constructor(
    private readonly inner: TurnRecorder,
    private readonly allowedAtomHashes: Set<string>
  ) {}

  startTurn(turn: TurnStart): ActiveTurnRecorder {
    const active = this.inner.startTurn(turn);
    return {
      event: (event) => {
        const missing = missingAtomsForRecorderEvent(event, this.allowedAtomHashes);
        if (missing.length > 0) {
          throw wooError("E_NEED_STATE", "shadow turn touched state outside the materialized atom set", {
            missing_atoms: missing
          });
        }
        active.event(event);
      }
    };
  }
}

function missingAtomsForRecorderEvent(
  event: TurnRecorderEvent,
  allowedAtomHashes: Set<string>
): Array<{ hash: string; preimage: string }> {
  const preimages = shadowAtomPreimagesForRecorderEvent(event);
  const missing: Array<{ hash: string; preimage: string }> = [];
  for (const preimage of preimages) {
    const hash = shadowAtomHash(preimage);
    if (!allowedAtomHashes.has(hash)) missing.push({ hash, preimage });
  }
  return missing;
}

function shadowAtomPreimagesForRecorderEvent(event: TurnRecorderEvent): string[] {
  switch (event.kind) {
    case "cell_read":
      return [shadowReadCellPreimage(event.cell)];
    case "cell_write":
      return [shadowWriteCellPreimage(event.cell)];
    case "prop_read":
      return [shadowReadCellPreimage({ kind: "prop", object: event.object, name: event.name })];
    case "prop_write":
      return [shadowWriteCellPreimage({ kind: "prop", object: event.object, name: event.name })];
    case "dispatch":
      return [shadowReadCellPreimage({ kind: "verb", object: event.definer, name: event.verb })];
    case "object_create":
      return [shadowWriteCellPreimage({ kind: "lifecycle", object: event.object })];
    case "object_move":
      return [shadowWriteCellPreimage({ kind: "location", object: event.object })];
    default:
      return [];
  }
}
