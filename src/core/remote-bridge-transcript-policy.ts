import type { WooValue } from "./types";

// Shadow v2 records remote bridge boundaries as intentional incompleteness.
// Mergeable callee sub-transcripts need the later execution-plane envelope.
export type RemoteBridgeOperation =
  | "dispatch"
  | "get_prop"
  | "set_prop"
  | "move"
  | "location"
  | "mirror_contents"
  | "contents";

export type RemoteBridgeTranscriptPolicy = {
  kind: "woo.remote_bridge_transcript_policy.shadow.v1";
  version: 1;
  boundary: "cross_host_bridge";
  operation: RemoteBridgeOperation;
  policy: "incomplete_transcript";
  subtranscripts: "deferred";
  commit_result: "reject";
  note: string;
};

const REMOTE_BRIDGE_EFFECT_NAMES: Record<RemoteBridgeOperation, string> = {
  dispatch: "remote_dispatch",
  get_prop: "remote_get_prop",
  set_prop: "remote_set_prop",
  move: "remote_move",
  location: "remote_location",
  mirror_contents: "remote_mirror_contents",
  contents: "remote_contents"
};

export function remoteBridgeEffectName(operation: RemoteBridgeOperation): string {
  return REMOTE_BRIDGE_EFFECT_NAMES[operation];
}

export function remoteBridgeTranscriptPolicyValue(operation: RemoteBridgeOperation): WooValue {
  return {
    kind: "woo.remote_bridge_transcript_policy.shadow.v1",
    version: 1,
    boundary: "cross_host_bridge",
    operation,
    policy: "incomplete_transcript",
    subtranscripts: "deferred",
    commit_result: "reject",
    note: "Shadow v2 records that a cross-host bridge boundary occurred, but it does not merge a callee transcript yet."
  } satisfies RemoteBridgeTranscriptPolicy;
}

export function remoteBridgeUntrackedEffect(
  operation: RemoteBridgeOperation,
  detail: Record<string, WooValue>
): { name: string; detail: Record<string, WooValue> } {
  return {
    name: remoteBridgeEffectName(operation),
    detail: {
      ...detail,
      transcript_policy: remoteBridgeTranscriptPolicyValue(operation)
    }
  };
}
