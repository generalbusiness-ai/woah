import { describe, expect, it, vi } from "vitest";

import type { EffectTranscript } from "../src/core/effect-transcript";
import { runShadowApply, type ShadowApplyTarget } from "../src/core/v2-shadow-apply";

function makeTranscript(): EffectTranscript {
  return {
    kind: "woo.effect_transcript.shadow.v1",
    route: "sequenced",
    scope: "the_chatroom",
    seq: 1,
    call: { actor: "guest_1", target: "the_chatroom", verb: "say", args: ["hi"] },
    reads: [],
    writes: [],
    creates: [],
    moves: [],
    observations: [],
    logicalInputs: [],
    untrackedEffects: [],
    complete: true,
    incompleteReasons: [],
    hash: ""
  } as EffectTranscript;
}

describe("runShadowApply", () => {
  it("invokes applyTranscript exactly once with the given transcript", async () => {
    const transcript = makeTranscript();
    const apply = vi.fn();
    await runShadowApply(transcript, { applyTranscript: apply });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(transcript);
  });

  it("calls cleanupRevokedApiKeys with the snapshot taken before applyTranscript", async () => {
    const order: string[] = [];
    const before = new Set<string>(["apikey_a"]);
    const target: ShadowApplyTarget = {
      revokedApiKeyIdsBefore: () => {
        order.push("before");
        return before;
      },
      applyTranscript: () => order.push("apply"),
      cleanupRevokedApiKeys: (received) => {
        order.push("cleanup");
        expect(received).toBe(before);
      }
    };
    await runShadowApply(makeTranscript(), target);
    expect(order).toEqual(["before", "apply", "cleanup"]);
  });

  it("skips cleanupRevokedApiKeys when revokedApiKeyIdsBefore is absent", async () => {
    const cleanup = vi.fn();
    await runShadowApply(makeTranscript(), {
      applyTranscript: () => {},
      cleanupRevokedApiKeys: cleanup
    });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("skips cleanupRevokedApiKeys when only the before-snapshot is provided", async () => {
    // No cleanup hook means the consumer doesn't want the diff applied.
    // The library shouldn't keep the snapshot for itself.
    const before = vi.fn(() => new Set<string>());
    await runShadowApply(makeTranscript(), {
      applyTranscript: () => {},
      revokedApiKeyIdsBefore: before
    });
    expect(before).toHaveBeenCalledTimes(1);
  });

  it("calls sessionHousekeeping with sessionId and result when sessionId is set", async () => {
    const session = vi.fn();
    await runShadowApply(
      makeTranscript(),
      { applyTranscript: () => {}, sessionHousekeeping: session },
      { sessionId: "session_x", result: { ok: true } }
    );
    expect(session).toHaveBeenCalledWith("session_x", { ok: true });
  });

  it("does not call sessionHousekeeping when sessionId is null/absent", async () => {
    const session = vi.fn();
    const target: ShadowApplyTarget = { applyTranscript: () => {}, sessionHousekeeping: session };
    await runShadowApply(makeTranscript(), target);
    await runShadowApply(makeTranscript(), target, { sessionId: null });
    expect(session).not.toHaveBeenCalled();
  });

  it("awaits async cleanup and housekeeping in order", async () => {
    const order: string[] = [];
    const target: ShadowApplyTarget = {
      revokedApiKeyIdsBefore: () => new Set(),
      applyTranscript: () => order.push("apply"),
      cleanupRevokedApiKeys: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        order.push("cleanup");
      },
      sessionHousekeeping: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        order.push("session");
      }
    };
    await runShadowApply(makeTranscript(), target, { sessionId: "session_x" });
    expect(order).toEqual(["apply", "cleanup", "session"]);
  });

  it("works as a satellite (only applyTranscript) without throwing", async () => {
    const apply = vi.fn();
    await runShadowApply(
      makeTranscript(),
      { applyTranscript: apply },
      { sessionId: "session_x", result: { ok: true } }
    );
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
