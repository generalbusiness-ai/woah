import { createWorldFromSerialized } from "./bootstrap";
import { effectTranscriptFromRecordedTurn, type EffectTranscript } from "./effect-transcript";
import type { SerializedWorld } from "./repository";
import type { AppliedFrame, DirectResultFrame, ErrorFrame, Message, MetricEvent, ObjRef, WooValue } from "./types";
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

export type ShadowTurnCallTranscriptRun = Omit<ShadowTurnCallRun, "serializedAfter">;

export type ShadowTurnCallOptions = {
  allowed_atom_hashes?: Iterable<string>;
  // Optional forwarder for engine metric events. The ephemeral executor
  // world has no metrics hook by default, so events like `direct_call`,
  // `applied`, and `dispatch_resolved` get dropped on the v2 hot path
  // unless the caller threads its host's metric sink in here. Without
  // this, footprint-by-verb on /admin/ is permanently empty for v2
  // traffic. See notes/2026-05-18-v2-verb-metrics.md.
  onMetric?: (event: MetricEvent) => void;
};

export async function runShadowTurnCall(
  serializedBefore: SerializedWorld,
  call: ShadowTurnCall,
  options: ShadowTurnCallOptions = {}
): Promise<ShadowTurnCallRun> {
  const world = createWorldFromSerialized(serializedBefore, { persist: false });
  world.setMetricsHook(options.onMetric ?? null);
  return await runShadowTurnCallOnWorld(world, call, options);
}

export async function runShadowTurnCallTranscript(
  serializedBefore: SerializedWorld,
  call: ShadowTurnCall,
  options: ShadowTurnCallOptions = {}
): Promise<ShadowTurnCallTranscriptRun> {
  // Durable commit scopes apply transcripts authoritatively, so planning and
  // commit-scope execution should not pay for a full executor post-state export
  // unless a caller explicitly needs that snapshot.
  const world = createWorldFromSerialized(serializedBefore, { persist: false });
  if (options.onMetric) world.setMetricsHook(options.onMetric);
  return await runShadowTurnCallOnWorldTranscript(world, call, options);
}

export async function runShadowTurnCallOnWorld(
  world: WooWorld,
  call: ShadowTurnCall,
  options: ShadowTurnCallOptions = {}
): Promise<ShadowTurnCallRun> {
  const run = await runShadowTurnCallOnWorldTranscript(world, call, options);
  return {
    ...run,
    serializedAfter: world.exportWorld()
  };
}

export async function runShadowTurnCallOnWorldTranscript(
  world: WooWorld,
  call: ShadowTurnCall,
  options: ShadowTurnCallOptions = {}
): Promise<ShadowTurnCallTranscriptRun> {
  if (options.onMetric) world.setMetricsHook(options.onMetric);
  const recorder = new InMemoryTurnRecorder();
  const guarded = options.allowed_atom_hashes != null;
  world.setTurnRecorder(guarded
    ? new ShadowStateGuardTurnRecorder(recorder, new Set(options.allowed_atom_hashes))
    : recorder);

  // VTN10.1: arm the object-lookup materialization probe ONLY in guarded
  // mode (allowed_atom_hashes present). In this mode an `object(id)` miss
  // emits a lifecycle probe that the guard recorder rejects with
  // E_NEED_STATE, turning a missing-slice dereference into a repairable
  // missing_state instead of a semantic E_OBJNF. Authoritative/diagnostic
  // runs (no allowed set) leave the guard off so a genuine miss still
  // surfaces as E_OBJNF. The flag is always cleared in the finally below,
  // even on throw, so it never leaks into a later run on the same world.
  // The throw of E_NEED_STATE must propagate out (it becomes the recorded
  // turn's turn_finish error -> transcript.error -> repair); the finally
  // only clears the flag, it never swallows.
  if (guarded) world.setShadowExecutionGuard(true);

  let frame: AppliedFrame | DirectResultFrame | ErrorFrame;
  try {
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
  } finally {
    if (guarded) world.setShadowExecutionGuard(false);
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
    transcript
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
    case "state_probe":
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
