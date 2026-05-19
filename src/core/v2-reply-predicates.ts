// Library-shaped predicates and metric labels for v2 shadow turn replies.
//
// These functions classify a wire envelope's body without any host coupling:
// no Worker globals, no Durable Object state, no WooWorld instance. They
// exist so that CommitScopeDO, PersistentObjectDO, and any future Node or
// browser consumer of the v2 protocol agree on the same shape predicates.
//
// Add a new branch here when the v2 reply protocol grows a new kind — not in
// the DOs.

import type { ShadowEnvelope } from "./shadow-envelope";
import type { ShadowCommitAccepted } from "./shadow-commit-scope";
import type { ShadowStateTransfer, ShadowTurnExecReply } from "./shadow-turn-exec";

export type ShadowEnvelopeReplyBody = ShadowTurnExecReply | ShadowStateTransfer;

// Labels that AE/admin charts use for the `mcp_envelope` / `v2_envelope`
// metrics. Keep the union narrow: each value corresponds to a distinct
// branch in `shadowReplyMetricKind` and a column in the stats UI.
export type V2EnvelopeReplyMetric = "none" | "accepted" | "live" | "missing_state" | "commit_rejected";

export function isShadowTurnExecReply(value: unknown): value is ShadowTurnExecReply {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { kind?: unknown }).kind === "woo.turn.exec.reply.shadow.v1"
  );
}

export function isShadowCommitAccepted(value: unknown): value is ShadowCommitAccepted {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ShadowCommitAccepted>;
  return candidate.kind === "woo.commit.accepted.shadow.v1"
    && !!candidate.position
    && typeof candidate.position === "object"
    && typeof candidate.position.scope === "string"
    && typeof candidate.position.seq === "number"
    && Array.isArray(candidate.observations);
}

export function shadowReplyMetricKind(
  reply: ShadowEnvelope<ShadowEnvelopeReplyBody> | null
): V2EnvelopeReplyMetric {
  const body = reply?.body;
  if (!isShadowTurnExecReply(body)) return "none";
  if (body.ok === false) return body.reason;
  return body.commit ? "accepted" : "live";
}
