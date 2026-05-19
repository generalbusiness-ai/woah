import { isShadowScopeHead, type ShadowScopeHead } from "../core/shadow-scope-head";
import type { ShadowCommitAccepted } from "../core/shadow-commit-scope";
import type { EffectTranscript } from "../core/effect-transcript";
import type { AppliedFrame, WooValue } from "../core/types";
import type { DirectResultFrame, ErrorFrame } from "../core/types";
import type { ShadowTurnExecReply } from "../core/shadow-turn-exec";

export type V2ProjectionRow = {
  scope: string;
  head: unknown;
  projection: unknown;
  updated_at?: number;
};

export type V2ProjectionMessage = {
  kind: "projection";
  scope: string;
  head: ShadowScopeHead;
  projection: WooValue;
  cached?: boolean;
};

export type V2AppliedFrameMessage = {
  kind: "applied_frame";
  scope: string;
  seq: number;
  frame: ShadowCommitAccepted;
  transcript?: EffectTranscript;
  applied?: AppliedFrame;
};

export type V2TurnResultMessage = {
  kind: "turn_result";
  frame: DirectResultFrame | ErrorFrame;
  optimistic?: boolean;
};

export type V2TurnResultRoute = "final_result" | "final_error" | "optimistic_result" | "optimistic_error";

export type V2ProjectionSnapshot = {
  scope: string;
  objects: Record<string, unknown>[];
  cursor?: { spaces?: Record<string, { next_seq?: number }> };
  subject?: Record<string, unknown> | null;
};

export function v2TurnResultRoute(message: V2TurnResultMessage): V2TurnResultRoute {
  if (message.frame.op === "result") return message.optimistic === true ? "optimistic_result" : "final_result";
  return message.optimistic === true ? "optimistic_error" : "final_error";
}

export function v2ProjectionMessageFromRow(row: unknown, options: { cached?: boolean } = {}): V2ProjectionMessage | undefined {
  if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
  const record = row as Partial<V2ProjectionRow>;
  if (typeof record.scope !== "string" || !isShadowScopeHead(record.head)) return undefined;
  return {
    kind: "projection",
    scope: record.scope,
    head: record.head,
    projection: record.projection as WooValue,
    ...(options.cached ? { cached: true } : {})
  };
}

export function v2ProjectionSnapshotFromMessage(message: V2ProjectionMessage): V2ProjectionSnapshot | undefined {
  const projection = message.projection;
  if (!projection || typeof projection !== "object" || Array.isArray(projection)) return undefined;
  const record = projection as Record<string, unknown>;
  if (record.kind !== "woo.scope_projection.shadow.v1" || record.scope !== message.scope) return undefined;
  const objects = Array.isArray(record.objects)
    ? record.objects.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item) && typeof item.id === "string")
    : [];
  const cursor = record.cursor && typeof record.cursor === "object" && !Array.isArray(record.cursor)
    ? record.cursor as V2ProjectionSnapshot["cursor"]
    : undefined;
  const subject = record.subject && typeof record.subject === "object" && !Array.isArray(record.subject)
    ? record.subject as Record<string, unknown>
    : record.subject === null ? null : undefined;
  return {
    scope: message.scope,
    objects,
    ...(cursor ? { cursor } : {}),
    ...(subject !== undefined ? { subject } : {})
  };
}

export function v2AppliedFrameMessageFromFrame(frame: ShadowCommitAccepted, transcript?: EffectTranscript): V2AppliedFrameMessage | undefined {
  if (!frame || frame.kind !== "woo.commit.accepted.shadow.v1") return undefined;
  const scope = frame.position?.scope;
  const seq = frame.position?.seq;
  if (typeof scope !== "string" || !Number.isFinite(seq)) return undefined;
  return {
    kind: "applied_frame",
    scope,
    seq,
    frame,
    ...(transcript ? { transcript, applied: v2AppliedFrameFromTranscript(frame, transcript) } : {})
  };
}

export function v2TurnResultMessageFromReply(reply: ShadowTurnExecReply, replyTo?: string): V2TurnResultMessage | undefined {
  // Committed replies become applied-frame messages. Non-committing direct
  // replies need a v1-shaped result/error frame so existing catalog UI handlers
  // can consume them while the transport moves to v2.
  const id = reply.id ?? replyTo;
  if (reply.ok === true) {
    if (reply.commit) return undefined;
    if (reply.outcome.error !== undefined) {
      return {
        kind: "turn_result",
        frame: {
          op: "error",
          ...(id ? { id } : {}),
          error: coerceErrorValue(reply.outcome.error)
        }
      };
    }
    return {
      kind: "turn_result",
      frame: {
        op: "result",
        ...(id ? { id } : {}),
        command: reply.transcript.call,
        result: reply.outcome.result ?? null,
        observations: reply.transcript.observations,
        audience: null
      }
    };
  }
  if (reply.reason === "missing_state") return undefined;
  return {
    kind: "turn_result",
    frame: {
      op: "error",
      ...(id ? { id } : {}),
      error: {
        code: `E_V2_${reply.reason.toUpperCase()}`,
        message: reply.reason
      }
    }
  };
}

function v2AppliedFrameFromTranscript(frame: ShadowCommitAccepted, transcript: EffectTranscript): AppliedFrame {
  return {
    op: "applied",
    id: frame.id ?? transcript.id,
    space: frame.position.scope,
    seq: frame.position.seq,
    ts: 0,
    message: {
      actor: transcript.call.actor,
      target: transcript.call.target,
      verb: transcript.call.verb,
      args: transcript.call.args
    },
    observations: transcript.observations,
    ...(transcript.result !== undefined ? { result: transcript.result } : {})
  };
}

function coerceErrorValue(value: WooValue) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as ErrorFrame["error"];
  return {
    code: "E_V2_TURN",
    message: String(value)
  };
}
