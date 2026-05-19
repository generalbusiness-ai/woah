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

import type { EffectTranscript } from "./effect-transcript";
import type { ShadowLiveAudience, ShadowLiveEvent } from "./shadow-browser-node";
import type { ObjRef } from "./types";

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
export function affectedTranscriptScopes(scope: ObjRef, transcript: EffectTranscript): ObjRef[] {
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
    if (cell.kind === "prop" && (cell.name === "session_subscribers" || cell.name === "subscribers")) {
      add(cell.object);
    }
  }
  return Array.from(scopes).sort();
}

// MCP fan-out and browser fan-out are conceptually separate (different
// transports, different recipient discovery) but currently project from
// the transcript identically. Kept as named exports so call sites read
// intent-first and future divergence is a localized change.
export function affectedMcpFanoutScopes(scope: ObjRef, transcript: EffectTranscript): ObjRef[] {
  return affectedTranscriptScopes(scope, transcript);
}

export function affectedBrowserFanoutScopes(scope: ObjRef, transcript: EffectTranscript): ObjRef[] {
  return affectedTranscriptScopes(scope, transcript);
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
