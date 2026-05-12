import type { SerializedWorld } from "./repository";
import type { ObjRef } from "./types";
import type { EffectTranscript } from "./effect-transcript";
import { transcriptTouchedStateHash, validateTranscriptAgainstSerializedWorld } from "./effect-transcript";

export type ShadowCommitReceipt = {
  kind: "woo.commit_receipt.shadow.v1";
  id?: string;
  route: EffectTranscript["route"];
  scope: ObjRef;
  seq: number;
  transcript_hash: string;
  pre_state_hash: string;
  post_state_hash: string;
  accepted: boolean;
  errors: string[];
};

export function shadowCommitReceipt(
  serializedBefore: SerializedWorld,
  serializedAfter: SerializedWorld,
  transcript: EffectTranscript,
  extraErrors: string[] = []
): ShadowCommitReceipt {
  const validation = validateTranscriptAgainstSerializedWorld(serializedBefore, transcript);
  const errors = [
    ...validation.errors,
    ...extraErrors,
    ...(transcript.complete ? [] : transcript.incompleteReasons.map((reason) => `incomplete:${reason}`))
  ];
  return {
    kind: "woo.commit_receipt.shadow.v1",
    id: transcript.id,
    route: transcript.route,
    scope: transcript.scope,
    seq: transcript.seq,
    transcript_hash: transcript.hash,
    pre_state_hash: transcriptTouchedStateHash(serializedBefore, transcript),
    post_state_hash: transcriptTouchedStateHash(serializedAfter, transcript),
    accepted: errors.length === 0,
    errors
  };
}
