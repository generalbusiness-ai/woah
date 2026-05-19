import { describe, expect, it, vi } from "vitest";

import {
  settleInvalidatedOptimisticTurns,
  shouldInvalidateTentativeTurnForCommitReason
} from "../src/client/v2-browser-optimistic-lifecycle";

describe("v2 browser optimistic lifecycle", () => {
  it("fails invalidated tentative calls and settles pending handlers", () => {
    const failOptimisticCall = vi.fn();
    const completeNetworkWait = vi.fn();
    const resultHandler = vi.fn();
    const errorHandler = vi.fn();
    const pendingDirect = new Map<string, (result: unknown) => void>([
      ["turn-a", resultHandler],
      ["turn-b", resultHandler]
    ]);
    const pendingFrameErrors = new Map<string, (error: any) => void>([
      ["turn-a", errorHandler],
      ["turn-b", errorHandler]
    ]);
    const pendingCommands = new Map<string, unknown>([
      ["turn-a", { text: "add note" }],
      ["turn-b", { text: "move note" }]
    ]);

    const error = settleInvalidatedOptimisticTurns({
      kind: "local_turn_invalidated",
      id: "turn-a",
      reason: "read_version_mismatch",
      invalidated_ids: ["turn-a", "turn-b"]
    }, {
      failOptimisticCall,
      pendingDirect,
      pendingFrameErrors,
      pendingCommands,
      completeNetworkWait
    });

    expect(error).toEqual({
      code: "E_V2_TENTATIVE_INVALIDATED",
      message: "tentative v2 turn invalidated: read_version_mismatch",
      reason: "read_version_mismatch",
      invalidated_ids: ["turn-a", "turn-b"]
    });
    expect(failOptimisticCall).toHaveBeenCalledWith("turn-a");
    expect(failOptimisticCall).toHaveBeenCalledWith("turn-b");
    expect(completeNetworkWait).toHaveBeenCalledWith("turn-a");
    expect(completeNetworkWait).toHaveBeenCalledWith("turn-b");
    expect(errorHandler).toHaveBeenCalledTimes(2);
    expect(errorHandler).toHaveBeenCalledWith(error);
    expect(pendingDirect.size).toBe(0);
    expect(pendingFrameErrors.size).toBe(0);
    expect(pendingCommands.size).toBe(0);
  });

  it("keeps stale-head conflicts pending for retry convergence", () => {
    expect(shouldInvalidateTentativeTurnForCommitReason("stale_head")).toBe(false);
    expect(shouldInvalidateTentativeTurnForCommitReason("read_version_mismatch")).toBe(true);
    expect(shouldInvalidateTentativeTurnForCommitReason(undefined)).toBe(true);
  });
});
