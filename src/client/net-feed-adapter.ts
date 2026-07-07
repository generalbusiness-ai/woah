/**
 * NetFeed → framework adapter (Plan 002 Phase 4 item 4 chunk 2).
 *
 * Translates NetFeed observation events into EXACTLY the reducer input
 * framework.ts's ObservationRegistry consumes — the same
 * (observation, DeliveredObservation) pair the v2 path builds in
 * WooClientFramework.ingestAppliedFrame for committed frames:
 * route:"sequenced" with the committed seq and the emitting space. The
 * reducers registered by registerCoreObservationHandlers (and by catalog
 * UI modules) therefore cannot tell a feed-delivered observation from a
 * v2-delivered one; the cutover swaps the SOURCE, never the reducers.
 *
 * Route decision, documented: every NetFeed event is route:"sequenced".
 * Both feed channels — the turn reply (source:"self") and the fanout
 * {type:"observations"} frame (source:"peer") — carry observations of
 * COMMITTED transcripts, which is precisely what v2's applied-frame path
 * delivered as "sequenced". The net layer has no unsequenced live
 * channel in Phase 4, so handlers registered route:"live"-only (e.g.
 * gesture_progress) correctly never fire from the feed.
 *
 * `space` mirrors v2's `frame.space` — the SEQUENCING space's object
 * ref. The net event carries the committing scope instead (a net-layer
 * address, not an object ref), but the CO15 naming convention makes the
 * translation exact: a room scope is `room:<space>`, so stripping the
 * prefix recovers the ref (reducers compare `space` against object refs
 * — see taken/dropped's `obs.room ?? obs.source ?? delivered.space`
 * chain). Cluster-committed turns have no sequencing space; `space` is
 * honestly omitted, exactly like a v2 direct-route frame.
 *
 * Nothing in production imports this yet: wireNetFeed is the entry the
 * Phase-5 cutover calls (kickoff item 4; v2 stays untouched until then).
 */
import type { DeliveredObservation } from "./framework";
import type { NetFeedObservationEvent } from "./net-feed";

/** The feed surface the adapter needs (structural: NetFeed satisfies it,
 * and tests can drive a bare emitter). */
export type NetFeedSource = {
  onObservation(fn: (event: NetFeedObservationEvent) => void): () => void;
};

/** The framework surface the adapter targets (structural:
 * WooClientFramework satisfies it — `framework.observations` is the
 * ObservationRegistry — and reducer tests can pass a registry-holding
 * literal). */
export type NetFeedReducerTarget = {
  observations: {
    deliver(observation: Record<string, unknown>, delivered: DeliveredObservation): void;
  };
};

/**
 * Subscribe `feed` and deliver every observation event into `target`'s
 * reducers. Returns the unsubscribe function.
 */
export function wireNetFeed(target: NetFeedReducerTarget, feed: NetFeedSource): () => void {
  return feed.onObservation((event) => {
    const space = event.scope.startsWith("room:") ? event.scope.slice("room:".length) : undefined;
    const delivered: DeliveredObservation = {
      route: "sequenced",
      ...(event.seq !== null ? { seq: event.seq } : {}),
      ...(space !== undefined && space !== "" ? { space } : {}),
      ...(event.turn_id !== undefined ? { frameId: event.turn_id } : {}),
      receivedAt: Date.now()
    };
    target.observations.deliver(event.observation, delivered);
  });
}
