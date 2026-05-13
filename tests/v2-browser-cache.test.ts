import { describe, expect, it } from "vitest";
import { v2BrowserCacheMutationsForEnvelope } from "../src/client/v2-browser-cache";
import type { ShadowEnvelope } from "../src/core/shadow-envelope";

describe("v2 browser cache reducer", () => {
  it("persists projection transfers as projection head and clears catch-up-required", () => {
    const envelope = envelopeFor("woo.state.transfer.shadow.v1", {
      kind: "woo.state.transfer.shadow.v1",
      mode: "projection",
      scope: "the_dubspace",
      to: { kind: "woo.scope_head.shadow.v1", scope: "the_dubspace", epoch: 1, seq: 3, hash: "h3" },
      projection: { kind: "projection", seq: 3 },
      proof: { kind: "test" }
    });

    expect(v2BrowserCacheMutationsForEnvelope(envelope)).toEqual([
      { kind: "projection", scope: "the_dubspace", head: envelope.body.to, projection: envelope.body.projection },
      { kind: "meta", key: "head:the_dubspace", value: envelope.body.to },
      { kind: "meta", key: "catchup_required", value: false }
    ]);
  });

  it("persists delta transfers as projection, applied frames, and transcript tail", () => {
    const accepted = {
      kind: "woo.commit.accepted.shadow.v1",
      id: "turn-1",
      position: { kind: "woo.scope_head.shadow.v1", scope: "the_dubspace", epoch: 1, seq: 1, hash: "h1" },
      receipt: { kind: "woo.commit_receipt.shadow.v1", id: "turn-1", accepted: true },
      transcript_hash: "t1",
      pre_state_hash: "p0",
      post_state_hash: "p1",
      observations: []
    };
    const transcript = {
      kind: "woo.effect_transcript.shadow.v1",
      id: "turn-1",
      scope: "the_dubspace",
      seq: 1,
      hash: "t1",
      complete: true
    };
    const envelope = envelopeFor("woo.state.transfer.shadow.v1", {
      kind: "woo.state.transfer.shadow.v1",
      mode: "delta",
      scope: "the_dubspace",
      to: accepted.position,
      projection: { kind: "projection", seq: 1 },
      applied: [accepted],
      transcript_tail: [transcript],
      proof: { kind: "test" }
    });

    expect(v2BrowserCacheMutationsForEnvelope(envelope)).toEqual([
      { kind: "projection", scope: "the_dubspace", head: accepted.position, projection: envelope.body.projection },
      { kind: "meta", key: "head:the_dubspace", value: accepted.position },
      { kind: "meta", key: "catchup_required", value: false },
      { kind: "applied_frame", frame: accepted },
      { kind: "transcript", transcript }
    ]);
  });

  it("marks reset errors as requiring catch-up and clears pending replies on replies", () => {
    expect(v2BrowserCacheMutationsForEnvelope(envelopeFor("woo.transport.error.v1", {
      kind: "woo.transport.error.v1",
      code: "E_RESET",
      message: "reset"
    }))).toEqual([{ kind: "meta", key: "catchup_required", value: true }]);

    expect(v2BrowserCacheMutationsForEnvelope({
      ...envelopeFor("woo.turn.exec.reply.shadow.v1", { kind: "woo.turn.exec.reply.shadow.v1", ok: true }),
      reply_to: "pending-1"
    })).toEqual([{ kind: "pending_delete", id: "pending-1" }]);
  });
});

function envelopeFor<T>(type: string, body: T): ShadowEnvelope<T> {
  return {
    v: 2,
    type,
    id: `${type}:1`,
    from: "relay",
    to: "browser",
    auth: { mode: "session", token: "token" },
    body
  } as ShadowEnvelope<T>;
}
