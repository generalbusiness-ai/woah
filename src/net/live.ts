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

/**
 * Reduce an executor's exact local audience to the routing proof Net needs.
 *
 * Session ids are bearer credentials and can accumulate in a derived planner
 * view until their owner deletion reaches that shard. They must not ride the
 * scope submit or be repeated once per observation. Presence-mode delivery is
 * deliberately re-resolved from each destination gateway's local indexed
 * relation slice; explicit delivery needs only the non-secret actor refs.
 *
 * The no-mode branch is rolling compatibility for an older executor frame. A
 * current frame always carries the parallel mode vector.
 */
export function compactNetLiveAudience(audience: DirectLiveAudience): LiveAudience {
  const modes = audience.observationAudienceModes;
  if (modes === undefined) {
    return {
      ...(audience.audienceActors !== undefined ? { audienceActors: audience.audienceActors } : {}),
      ...(audience.observationAudiences !== undefined ? { observationAudiences: audience.observationAudiences } : {})
    };
  }
  const perObservation = audience.observationAudiences ?? [];
  const perObservationExclusions = audience.observationAudienceExclusions ?? [];
  return {
    observationAudienceModes: modes,
    observationAudiences: modes.map((mode, index) =>
      mode === "explicit" ? (perObservation[index] ?? []) : []
    ),
    observationAudienceExclusions: modes.map((mode, index) =>
      mode === "presence" ? (perObservationExclusions[index] ?? []) : []
    )
  };
}

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
