export type V2LocalTurnInvalidatedMessage = {
  kind: "local_turn_invalidated";
  id?: string;
  reason?: string;
  invalidated_ids?: unknown;
};

export type V2OptimisticLifecycleHooks = {
  failOptimisticCall(id: string): void;
  pendingDirect: Map<string, (result: unknown) => void>;
  pendingFrameErrors: Map<string, (error: unknown) => void>;
  pendingCommands?: Map<string, unknown>;
  completeNetworkWait?: (id: string) => void;
};

export type V2TentativeInvalidatedError = {
  code: "E_V2_TENTATIVE_INVALIDATED";
  message: string;
  reason: string;
  invalidated_ids: string[];
};

export function settleInvalidatedOptimisticTurns(
  message: V2LocalTurnInvalidatedMessage,
  hooks: V2OptimisticLifecycleHooks
): V2TentativeInvalidatedError | null {
  const invalidatedIds = localTurnInvalidatedIds(message);
  if (invalidatedIds.length === 0) return null;
  const reason = typeof message.reason === "string" && message.reason.length > 0 ? message.reason : "tentative_invalidated";
  const error: V2TentativeInvalidatedError = {
    code: "E_V2_TENTATIVE_INVALIDATED",
    message: `tentative v2 turn invalidated: ${reason}`,
    reason,
    invalidated_ids: invalidatedIds
  };
  for (const id of invalidatedIds) {
    hooks.completeNetworkWait?.(id);
    hooks.failOptimisticCall(id);
    hooks.pendingDirect.delete(id);
    hooks.pendingCommands?.delete(id);
    const errorHandler = hooks.pendingFrameErrors.get(id);
    hooks.pendingFrameErrors.delete(id);
    errorHandler?.(error);
  }
  return error;
}

export function shouldInvalidateTentativeTurnForCommitReason(reason: string | undefined): boolean {
  // Stale-head is a retry/convergence signal. Permanent conflicts invalidate
  // the local chain; stale-head must leave it pending for the accepted retry or
  // later replay path.
  return reason !== "stale_head";
}

function localTurnInvalidatedIds(message: V2LocalTurnInvalidatedMessage): string[] {
  const ids = new Set<string>();
  if (typeof message.id === "string" && message.id.length > 0) ids.add(message.id);
  if (Array.isArray(message.invalidated_ids)) {
    for (const id of message.invalidated_ids) {
      if (typeof id === "string" && id.length > 0) ids.add(id);
    }
  }
  return Array.from(ids);
}
