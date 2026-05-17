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

import { decodeEnvelope, type ShadowEnvelope, type ShadowEnvelopeAuth } from "../core/shadow-envelope";
import type { ShadowTurnExecReply } from "../core/shadow-turn-exec";
import type { ObjRef } from "../core/types";
import type { WooWorld } from "../core/world";

type NormalizedErrorLike = { code: string; message?: string };

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

export type TurnIntentRecovery = {
  id: string;
  envelope_id: string;
  scope: ObjRef;
  route: "direct" | "sequenced";
};

export function decodeTurnIntentForRecovery(encoded: string): TurnIntentRecovery | null {
  // Used only on the WS-handler error path so the client can correlate a
  // pre-recording substrate throw (E_PERM, E_DIRECT_DENIED, etc.) with its
  // original intent envelope. Returns null when the envelope isn't a turn
  // intent we can answer for; the caller falls back to a generic transport
  // error in that case.
  try {
    const envelope = decodeEnvelope<{
      id?: unknown;
      scope?: unknown;
      route?: unknown;
      call?: { id?: unknown; scope?: unknown; route?: unknown };
    }>(encoded);
    if (envelope.type !== "woo.turn.intent.request.shadow.v1" && envelope.type !== "woo.turn.exec.request.shadow.v1") return null;
    const body = envelope.body;
    const id = typeof body?.id === "string"
      ? body.id
      : typeof body?.call?.id === "string"
        ? body.call.id
        : envelope.id;
    const scope = typeof body?.scope === "string"
      ? body.scope
      : typeof body?.call?.scope === "string"
        ? body.call.scope
        : null;
    const route = body?.route === "sequenced" || body?.call?.route === "sequenced" ? "sequenced" : "direct";
    if (!id || !scope) return null;
    return { id, envelope_id: envelope.id, scope: scope as ObjRef, route };
  } catch {
    return null;
  }
}

export function buildVerbThrewReplyEnvelope(input: {
  intent: TurnIntentRecovery;
  error: NormalizedErrorLike;
  relayNode: string;
  to: string;
  actor?: ObjRef;
  session?: string;
  auth: ShadowEnvelopeAuth;
}): ShadowEnvelope<ShadowTurnExecReply> {
  // Pre-recording substrate throws (presence/permission gates fire before
  // withTurnRecording starts) leave the recorder empty so
  // runShadowTurnCallOnWorld throws instead of returning a transcript. The
  // WS handler needs to answer the client with something whose
  // `envelope.reply_to === intent.envelope_id`, otherwise the SPA's
  // pending-network-turn set and the worker's pending storage never drain
  // and the wait cursor spins forever. Shape the reply as a
  // commit_rejected with a conflict whose errors include the substrate
  // code+message so the SPA's `E_V2_COMMIT_REJECTED` error path fires.
  const errors = [`${input.error.code}: ${input.error.message ?? ""}`];
  const replyBody: ShadowTurnExecReply = {
    kind: "woo.turn.exec.reply.shadow.v1",
    ok: false,
    id: input.intent.id,
    reason: "commit_rejected",
    commit: {
      kind: "woo.commit.conflict.shadow.v1",
      id: input.intent.id,
      scope: input.intent.scope,
      current: { kind: "woo.scope_head.shadow.v1", scope: input.intent.scope, epoch: 1, seq: 0, hash: "" },
      reason: "permission_denied",
      errors,
      receipt: {
        kind: "woo.commit_receipt.shadow.v1",
        id: input.intent.id,
        route: input.intent.route,
        scope: input.intent.scope,
        seq: 0,
        transcript_hash: "",
        pre_state_hash: "",
        post_state_hash: "",
        accepted: false,
        errors
      }
    }
  };
  const envelope: ShadowEnvelope<ShadowTurnExecReply> = {
    v: 2,
    type: replyBody.kind,
    id: `${input.relayNode}:reply:${input.intent.id}`,
    from: input.relayNode,
    to: input.to,
    reply_to: input.intent.envelope_id,
    auth: input.auth,
    body: replyBody
  };
  if (input.actor) envelope.actor = input.actor;
  if (input.session) envelope.session = input.session;
  return envelope;
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
