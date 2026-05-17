// Per-envelope relay routing helpers for the dev WebSocket path. The dev
// server gives each commit scope its own ShadowBrowserRelayShim, but the v2
// browser worker only maintains one WS at a time. When a single page issues
// turns to multiple scopes (chat panel + nested tool component + a command
// that audiences to another tool space), the WS-bound
// relay alone cannot route every envelope correctly — off-scope submits get
// rejected as `scope_mismatch`.
//
// These helpers mirror `WooWorld.directAudience` in a synchronous form the
// WS frame handler can use to pick the relay whose commit_scope matches the
// transcript scope that the planner will produce.

import { decodeEnvelope } from "../core/shadow-envelope";
import type { ObjRef } from "../core/types";
import type { WooWorld } from "../core/world";

export function directAudienceForTarget(world: WooWorld, target: ObjRef): ObjRef | null {
  // The substrate already routes a `directCall(target=<$space-typed>)` to a
  // scope equal to that space (or to the target's anchor/location if the
  // target itself is not a space but is anchored/located in one). Replicate
  // that decision here without re-entering async dispatch.
  if (!world.objects.has(target)) return null;
  if (world.isDescendantOf(target, "$space")) return target;
  const obj = world.object(target);
  if (obj.anchor && world.objects.has(obj.anchor) && world.isDescendantOf(obj.anchor, "$space")) return obj.anchor;
  if (obj.location && world.objects.has(obj.location) && world.isDescendantOf(obj.location, "$space")) return obj.location;
  return null;
}

export function resolveTurnEnvelopeScope(world: WooWorld, encoded: string): ObjRef | null {
  // Decode just enough of the envelope to find the call target. The target
  // determines the audience scope; the intent's declared scope is only used
  // as a fallback when the target isn't space-resolvable (e.g. a verb on a
  // floating object that lives outside any $space).
  try {
    const envelope = decodeEnvelope<{ scope?: unknown; target?: unknown; call?: { scope?: unknown; target?: unknown } }>(encoded);
    if (envelope.type !== "woo.turn.intent.request.shadow.v1" && envelope.type !== "woo.turn.exec.request.shadow.v1") return null;
    const body = envelope.body;
    const target = typeof body?.target === "string"
      ? body.target
      : typeof body?.call?.target === "string"
        ? body.call.target
        : null;
    const intentScope = typeof body?.scope === "string"
      ? body.scope
      : typeof body?.call?.scope === "string"
        ? body.call.scope
        : null;
    if (target) {
      const audience = directAudienceForTarget(world, target as ObjRef);
      if (audience) return audience;
    }
    return (intentScope as ObjRef | null) ?? null;
  } catch {
    return null;
  }
}
