// Library-shape helpers for projecting a v2 effect transcript into the
// scopes and audiences that the host has to notify.
//
// These functions are pure data transformations: a transcript in, a list
// of scopes or a per-event audience predicate out. No DO state, no Workers
// globals, no WooWorld instance — they are usable from any host that has
// the substrate types.
//
// Branches that need world-coupled data (e.g. recomputing live audiences
// from an authoritative actor list) take the data as plain parameters here
// and recompute it in the consumer. See `withComputedLiveAudience` for the
// callback shape: the consumer feeds `actors`/`sessions` arrays and we
// only assemble the audience record.

import { shadowLiveEventsForTranscriptRelay } from "./shadow-browser-node";
import type { EffectTranscript } from "./effect-transcript";
import type { ShadowLiveAudience, ShadowLiveEvent } from "./shadow-browser-node";
import type { ObjRef } from "./types";

export type PresenceProjectionPredicate = (object: ObjRef, property: string) => boolean;

// A peer descriptor: enough state to decide whether a fan-out event should
// be delivered to a single client. WS attachments and REST relays both
// satisfy this shape today; the field set is deliberately small so future
// transports can match without growing the predicate.
export type ShadowLivePeerScope = {
  sessionId: string;
  actor: ObjRef;
  scope: ObjRef;
};

// Base helper: every scope that a transcript could plausibly affect through
// presence-bearing writes. The originating scope is always included; moves,
// creates with a location, and contents/subscriber writes contribute their
// own scopes so co-present sessions on other shards/hosts still see the
// fanout.
export function affectedTranscriptScopes(scope: ObjRef, transcript: EffectTranscript, isPresenceProjection?: PresenceProjectionPredicate): ObjRef[] {
  const scopes = new Set<ObjRef>([scope]);
  const add = (value: ObjRef | null | undefined): void => {
    if (value) scopes.add(value);
  };
  for (const move of transcript.moves) {
    add(move.from);
    add(move.to);
  }
  for (const create of transcript.creates) {
    add(create.location);
  }
  for (const write of transcript.writes) {
    const cell = write.cell;
    if (cell.kind === "contents") add(cell.object);
    if (cell.kind === "prop" && isPresenceProjection?.(cell.object, cell.name) === true) {
      add(cell.object);
    }
  }
  return Array.from(scopes).sort();
}

// MCP fan-out and browser fan-out are conceptually separate (different
// transports, different recipient discovery) but currently project from
// the transcript identically. Kept as named exports so call sites read
// intent-first and future divergence is a localized change.
export function affectedMcpFanoutScopes(scope: ObjRef, transcript: EffectTranscript, isPresenceProjection?: PresenceProjectionPredicate): ObjRef[] {
  return affectedTranscriptScopes(scope, transcript, isPresenceProjection);
}

export function affectedBrowserFanoutScopes(scope: ObjRef, transcript: EffectTranscript, isPresenceProjection?: PresenceProjectionPredicate): ObjRef[] {
  return affectedTranscriptScopes(scope, transcript, isPresenceProjection);
}

// Build a `ShadowLiveAudience` record from raw actor/session id lists.
// Returns `null` when neither list contains anything addressable, so the
// caller can drop the audience field entirely rather than emit an empty
// shape that downstream consumers would have to defend against.
export function computedShadowLiveAudience(actors: ObjRef[], sessions: string[]): ShadowLiveAudience | null {
  const uniqueActors = Array.from(new Set(actors.filter(Boolean)));
  const uniqueSessions = Array.from(new Set(sessions.filter(Boolean)));
  if (uniqueActors.length === 0 && uniqueSessions.length === 0) return null;
  return {
    ...(uniqueActors.length > 0 ? { actors: uniqueActors } : {}),
    ...(uniqueSessions.length > 0 ? { sessions: uniqueSessions } : {})
  };
}

// Attach a recomputed audience to a live event; returns null when the
// event has no addressable recipients (callers should drop it from
// fan-out rather than broadcast it).
export function withComputedLiveAudience(
  event: ShadowLiveEvent,
  actors: ObjRef[],
  sessions: string[]
): ShadowLiveEvent | null {
  const audience = computedShadowLiveAudience(actors, sessions);
  return audience ? { ...event, audience } : null;
}

// True iff `peer` should receive `event` on the gateway side, where the
// peer is identified by (session, actor, scope) rather than a subscription
// map. An explicit actor/session audience is private unless it also names
// a scope — otherwise a direct reply would fan out to every room subscriber.
export function shadowLiveEventMatchesPeerScope(event: ShadowLiveEvent, peer: ShadowLivePeerScope): boolean {
  const audience = event.audience;
  if (audience) {
    if (audience.sessions?.includes(peer.sessionId)) return true;
    if (audience.actors?.includes(peer.actor)) return true;
    return typeof audience.scope === "string" && audience.scope === peer.scope;
  }
  return typeof event.scope === "string" && event.scope === peer.scope;
}

// Per-observation audiences recomputed authoritatively by the host (the
// `world.computeDirectLiveAudiences` result), index-aligned with
// `transcript.observations`. The async world walk stays host-side; this module
// only consumes the resulting arrays.
export type V2FanoutAudiences = {
  observationAudiences?: ObjRef[][];
  observationSessionAudiences?: string[][];
};

// Build the live events a COMMITTED transcript fans out, with each event's
// audience recomputed from the host's authoritative per-observation audience
// lists (replacing the transcript-embedded audience). Events with no
// addressable recipient are dropped. Shared by the worker and localdev so both
// decide committed-turn live recipients identically. `from` is the relay/host
// node stamped as the event origin.
export function buildV2FanoutLiveEvents(
  from: string,
  transcript: EffectTranscript,
  audiences: V2FanoutAudiences
): ShadowLiveEvent[] {
  return shadowLiveEventsForTranscriptRelay(from, transcript)
    .map((event, index) => withComputedLiveAudience(
      event,
      audiences.observationAudiences?.[index] ?? [],
      audiences.observationSessionAudiences?.[index] ?? []
    ))
    .filter((event): event is ShadowLiveEvent => event !== null);
}

// A peer the fanout may deliver to, identified by its bound scope (its
// "shard"): the WS attachment scope (worker) or the connected browser's scope
// (localdev). Same shape as `ShadowLivePeerScope` plus the addressable `node`.
export type V2FanoutPeer = ShadowLivePeerScope & { node: string };

export type V2BrowserFanoutPlan = {
  // Per recipient peer: the node and the (non-empty) events it should receive.
  liveDeliveries: Array<{ node: string; events: ShadowLiveEvent[] }>;
  // Peers whose bound scope IS the commit scope and therefore need a projection
  // state-transfer (catch-up) at the new head, in addition to any live events.
  stateTransferNodes: string[];
};

// The pure recipient-routing decision for a committed turn's browser fanout,
// shared by the worker (`sendV2CommitTranscriptFanout`) and localdev
// (`sendDevV2Fanout`). Given the audience-computed live events and the connected
// peers, decide who receives which events and who needs a projection catch-up.
//
// Origin and already-delivered nodes are excluded. A peer receives every event
// matching `shadowLiveEventMatchesPeerScope` (by peer.scope, actor, or session).
// A peer bound to `commitScope` is additionally a state-transfer target — it
// re-syncs its authoritative projection at the new head even when no live event
// matched (the commit advanced the head it projects from). This is exactly the
// worker's per-socket decision; localdev, being one process with one global
// socket set, runs it over EVERY connected peer so the union of the worker's
// per-DO + cross-shard delivery is reproduced locally.
export function planV2BrowserFanout(input: {
  events: ShadowLiveEvent[];
  commitScope: ObjRef;
  peers: Iterable<V2FanoutPeer>;
  originNode?: string | null;
  alreadyDeliveredNodes?: ReadonlySet<string>;
}): V2BrowserFanoutPlan {
  const liveDeliveries: Array<{ node: string; events: ShadowLiveEvent[] }> = [];
  const stateTransferNodes: string[] = [];
  for (const peer of input.peers) {
    if (input.originNode && peer.node === input.originNode) continue;
    if (input.alreadyDeliveredNodes?.has(peer.node)) continue;
    if (peer.scope === input.commitScope) stateTransferNodes.push(peer.node);
    const matching = input.events.filter((event) => shadowLiveEventMatchesPeerScope(event, peer));
    if (matching.length > 0) liveDeliveries.push({ node: peer.node, events: matching });
  }
  return { liveDeliveries, stateTransferNodes };
}
