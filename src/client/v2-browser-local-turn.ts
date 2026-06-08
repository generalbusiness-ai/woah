import { runShadowTurnCallTranscript } from "../core/shadow-turn-call";
import { buildPlanningWorld } from "../core/planning-world";
import type { EffectTranscript } from "../core/effect-transcript";
import type { ShadowScopeHead } from "../core/shadow-commit-scope";
import { executeShadowTurnCallOrNeedState, missingAtomsForShadowTurn, type ShadowMissingAtom, type ShadowTurnExecRequest } from "../core/shadow-turn-exec";
import { shadowAtomHash, shadowTurnKeyFromTranscript } from "../core/turn-key";
import type { ShadowTurnKey } from "../core/turn-key";
import type { SerializedObject } from "../core/repository";
import type { ShadowStatePage } from "../core/shadow-state-pages";
import type { AppliedFrame, DirectResultFrame, ErrorFrame, ObjRef, WooValue } from "../core/types";
import {
  createV2BrowserExecutionNodeFromTransfers,
  type V2BrowserExecutionComposeStats,
  type V2ExecutableTransferRecord
} from "./v2-browser-execution-cache";

export type V2BrowserLocalTurnInput = {
  node: string;
  actor: ObjRef;
  session?: string | null;
  head: ShadowScopeHead;
  id: string;
  route: "direct" | "sequenced";
  scope: ObjRef;
  target: ObjRef;
  verb: string;
  args: WooValue[];
  body?: Record<string, WooValue>;
  persistence: "durable" | "live";
  transfers: readonly V2ExecutableTransferRecord[];
  cached_objects?: readonly SerializedObject[];
  cached_pages?: readonly ShadowStatePage[];
  tentative_transcripts?: readonly EffectTranscript[];
  onCompose?: (stats: V2BrowserExecutionComposeStats) => void;
};

export type V2BrowserLocalTurnResult =
  | {
      ok: true;
      request: ShadowTurnExecRequest;
      optimistic_frame: DirectResultFrame | ErrorFrame;
      transcript: EffectTranscript;
      transcript_hash: string;
      observation_count: number;
      result_known: boolean;
    }
  | {
      ok: false;
      reason: "no_executable_state" | "missing_state" | "commit_rejected";
      missing_atoms?: ShadowMissingAtom[];
      key?: ShadowTurnKey;
      request?: ShadowTurnExecRequest;
    };

export async function planV2BrowserLocalTurn(input: V2BrowserLocalTurnInput): Promise<V2BrowserLocalTurnResult> {
  const executionNode = createV2BrowserExecutionNodeFromTransfers({
    node: input.node,
    scope: input.scope,
    records: input.transfers,
    cached_objects: input.cached_objects,
    cached_pages: input.cached_pages,
    tentative_transcripts: input.tentative_transcripts,
    onCompose: input.onCompose
  });
  if (!executionNode.serialized) return { ok: false, reason: "no_executable_state" };

  const call = {
    kind: "woo.turn_call.shadow.v1" as const,
    id: input.id,
    route: input.route,
    scope: input.scope,
    session: input.session ?? null,
    actor: input.actor,
    target: input.target,
    verb: input.verb,
    args: input.args,
    body: input.body
  };
  // A3.2 true VM boundary: the client execution node is a DERIVED holder view
  // composed from transfers, so it is admitted by PROOF, not by declaration — the
  // gate runs against the node's recorded per-cell provenance (installShadowStateTransfer
  // stamps it) and a presentation stub / untagged cell is refused (repairable).
  const planned = await runShadowTurnCallTranscript(
    buildPlanningWorld(executionNode.serialized, executionNode.cellProvenance ?? new Map(), { enforceMissingProvenance: true }),
    call);
  const key = shadowTurnKeyFromTranscript(planned.transcript);
  const request: ShadowTurnExecRequest = {
    kind: "woo.turn.exec.request.shadow.v1",
    id: input.id,
    call,
    key,
    expected: input.head,
    auth: {
      mode: "shadow_local",
      actor: input.actor,
      session: input.session ?? null
    },
    persistence: input.persistence
  };
  const missing = missingAtomsForShadowTurn(executionNode, key);
  if (missing.length > 0) return { ok: false, reason: "missing_state", missing_atoms: missing, key, request };
  const executed = await executeShadowTurnCallOrNeedState(executionNode, request);
  if (executed.ok === false) {
    if (executed.reason === "missing_state") return { ok: false, reason: "missing_state", missing_atoms: executed.missing_atoms, key, request };
    return { ok: false, reason: "commit_rejected" };
  }
  const materializationMiss = missingObjectAtomsFromErrorFrame(executed.frame);
  if (materializationMiss.length > 0) {
    return { ok: false, reason: "missing_state", missing_atoms: materializationMiss, key, request };
  }
  return {
    ok: true,
    request,
    optimistic_frame: optimisticTurnResultFrame(executed.frame, input.id),
    transcript: executed.transcript,
    transcript_hash: executed.transcript.hash,
    observation_count: executed.transcript.observations.length,
    result_known: executed.transcript.result !== undefined || executed.transcript.error !== undefined
  };
}

function missingObjectAtomsFromErrorFrame(frame: AppliedFrame | DirectResultFrame | ErrorFrame): ShadowMissingAtom[] {
  if (frame.op !== "error") return [];
  const value = frame.error.value;
  if (frame.error.code !== "E_OBJNF" || typeof value !== "string" || value.length === 0) return [];
  const preimage = `read:cell:lifecycle:${value}`;
  return [{ hash: shadowAtomHash(preimage), preimage }];
}

function optimisticTurnResultFrame(
  frame: AppliedFrame | DirectResultFrame | ErrorFrame,
  id: string
): DirectResultFrame | ErrorFrame {
  if (frame.op === "result" || frame.op === "error") return frame;
  return {
    op: "result",
    id: frame.id ?? id,
    command: frame.message,
    result: frame.result ?? null,
    observations: frame.observations,
    audience: frame.space,
    ...(frame.audienceSessions ? { audienceSessions: frame.audienceSessions } : {}),
    ...(frame.observationSessionAudiences ? { observationSessionAudiences: frame.observationSessionAudiences } : {})
  };
}
