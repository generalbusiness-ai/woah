import type { DirectLiveAudience } from "../core/types";

/**
 * Best-effort direct-observation delivery.
 *
 * Unlike FanoutBody, this carrier has no authority sequence and is never
 * persisted. The scope only uses its bounded subscriber-shard registry to
 * distribute a validated direct turn; each gateway filters the observations
 * against its local session slice.
 */
export type LiveAudience = DirectLiveAudience;

export type LiveFanoutBody = LiveAudience & {
  scope: string;
  observations: unknown[];
  /** Trusted internal key used only to suppress the submitting session. */
  submitter_turn_id?: string;
  /** One-way client-safe correlation token. */
  echo_id?: string;
};

/** One fresh-event carrier may combine several independent live messages for
 * the same gateway. The gateway still filters and emits each body separately;
 * batching reduces cross-DO calls without inventing ordering or durability. */
export type LiveFanoutBatchBody = {
  deliveries: LiveFanoutBody[];
};

export const LIVE_FANOUT_BATCH_CAP = 64;
