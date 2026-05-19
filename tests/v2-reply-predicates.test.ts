import { describe, expect, it } from "vitest";

import type { ShadowEnvelope } from "../src/core/shadow-envelope";
import type { ShadowCommitAccepted } from "../src/core/shadow-commit-scope";
import type { ShadowStateTransfer, ShadowTurnExecReply } from "../src/core/shadow-turn-exec";
import {
  isShadowCommitAccepted,
  isShadowTurnExecReply,
  shadowReplyMetricKind,
  type ShadowEnvelopeReplyBody
} from "../src/core/v2-reply-predicates";

const baseAccepted = {
  kind: "woo.commit.accepted.shadow.v1",
  position: { scope: "the_chatroom", seq: 7 },
  observations: [],
  ts: 0
} as unknown as ShadowCommitAccepted;

function envelope(body: ShadowEnvelopeReplyBody): ShadowEnvelope<ShadowEnvelopeReplyBody> {
  return {
    type: body.kind,
    body,
    auth: {} as ShadowEnvelope["auth"],
    id: "test"
  } as ShadowEnvelope<ShadowEnvelopeReplyBody>;
}

describe("v2-reply-predicates", () => {
  describe("isShadowTurnExecReply", () => {
    it("accepts a turn-exec reply body", () => {
      const reply = { kind: "woo.turn.exec.reply.shadow.v1", ok: true, id: "x" } as unknown as ShadowTurnExecReply;
      expect(isShadowTurnExecReply(reply)).toBe(true);
    });

    it("rejects state-transfer bodies, primitives, arrays, and null", () => {
      const transfer = { kind: "woo.state.transfer.shadow.closure.v1" } as unknown as ShadowStateTransfer;
      expect(isShadowTurnExecReply(transfer)).toBe(false);
      expect(isShadowTurnExecReply(null)).toBe(false);
      expect(isShadowTurnExecReply(undefined)).toBe(false);
      expect(isShadowTurnExecReply([])).toBe(false);
      expect(isShadowTurnExecReply("woo.turn.exec.reply.shadow.v1")).toBe(false);
      expect(isShadowTurnExecReply({ kind: "something.else.v1" })).toBe(false);
    });
  });

  describe("isShadowCommitAccepted", () => {
    it("accepts a well-formed accepted commit", () => {
      expect(isShadowCommitAccepted(baseAccepted)).toBe(true);
    });

    it("requires position.scope, position.seq, and observations[]", () => {
      expect(isShadowCommitAccepted({ ...baseAccepted, position: undefined })).toBe(false);
      expect(isShadowCommitAccepted({ ...baseAccepted, position: { scope: "x" } })).toBe(false);
      expect(isShadowCommitAccepted({ ...baseAccepted, position: { scope: "x", seq: "1" } })).toBe(false);
      expect(isShadowCommitAccepted({ ...baseAccepted, observations: "nope" })).toBe(false);
    });

    it("rejects wrong-kind values and non-objects", () => {
      expect(isShadowCommitAccepted({ ...baseAccepted, kind: "woo.commit.rejected.shadow.v1" })).toBe(false);
      expect(isShadowCommitAccepted(null)).toBe(false);
      expect(isShadowCommitAccepted([baseAccepted])).toBe(false);
    });
  });

  describe("shadowReplyMetricKind", () => {
    it("returns 'none' for a null reply or a state-transfer body", () => {
      expect(shadowReplyMetricKind(null)).toBe("none");
      const transfer = { kind: "woo.state.transfer.shadow.closure.v1" } as unknown as ShadowStateTransfer;
      expect(shadowReplyMetricKind(envelope(transfer))).toBe("none");
    });

    it("returns 'accepted' when the reply carries a commit", () => {
      const reply = {
        kind: "woo.turn.exec.reply.shadow.v1",
        ok: true,
        id: "x",
        commit: baseAccepted
      } as unknown as ShadowTurnExecReply;
      expect(shadowReplyMetricKind(envelope(reply))).toBe("accepted");
    });

    it("returns 'live' when the reply is ok with no commit", () => {
      const reply = { kind: "woo.turn.exec.reply.shadow.v1", ok: true, id: "x" } as unknown as ShadowTurnExecReply;
      expect(shadowReplyMetricKind(envelope(reply))).toBe("live");
    });

    it("returns the reason string when the reply is not ok", () => {
      const missing = { kind: "woo.turn.exec.reply.shadow.v1", ok: false, id: "x", reason: "missing_state" } as unknown as ShadowTurnExecReply;
      expect(shadowReplyMetricKind(envelope(missing))).toBe("missing_state");
      const rejected = { kind: "woo.turn.exec.reply.shadow.v1", ok: false, id: "x", reason: "commit_rejected" } as unknown as ShadowTurnExecReply;
      expect(shadowReplyMetricKind(envelope(rejected))).toBe("commit_rejected");
    });
  });
});
