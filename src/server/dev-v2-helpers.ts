// Dev-only WS/REST adapter helpers. The SPA's v2 browser worker keeps one
// WebSocket per page but the page can target multiple commit scopes (chat
// panel + nested tool component + cross-room audiences). The WS-bound
// browser is anchored to one relay at open time, so off-scope calls need
// to be rerouted to the relay whose commit_scope matches the planner's
// transcript scope — otherwise CommitScope rejects them as scope_mismatch.
//
// Three concerns live here:
//
//   - per-host transcript materialization for the in-process dev multi-host
//     world (Worker DOs handle this internally; dev does it at the
//     transport layer).
//   - envelope scope/target decoding so the dev WS frame handler can pick
//     the right per-scope relay without re-entering async dispatch.
//   - synthetic woo.turn.exec.reply construction for pre-recording
//     substrate throws (presence/permission gates fire before
//     withTurnRecording starts, so the corresponding throw escapes
//     runShadowTurnCallOnWorld without a transcript — the SPA still needs
//     a reply_to-bearing answer to drain its pending-turn set).
//
// All three predate the v2-turn-gateway consolidation but remain because
// the dev transport runs ingress in-process rather than through the
// CommitScopeDO surface.

import type { EffectTranscript } from "../core/effect-transcript";
import { transcriptSessionActiveScope, transcriptTouchedObjectIds } from "../core/shadow-commit-scope";
import { decodeEnvelope, type ShadowEnvelope, type ShadowEnvelopeAuth } from "../core/shadow-envelope";
import type { ShadowTurnExecReply } from "../core/shadow-turn-exec";
import type { ObjRef } from "../core/types";
import type { WooWorld } from "../core/world";

const DEV_WORLD_HOST = "world";

export function materializeDevV2CommitLocally(
  world: WooWorld,
  scope: ObjRef,
  transcript: EffectTranscript
): void {
  const routeHost = new Map(world.objectRoutes().map((route) => [route.id, route.host] as const));
  const createdIds = new Set(transcript.creates.map((create) => create.object));
  const hosts = new Set<string>();
  const addHostFor = (id: ObjRef | null | undefined): void => {
    if (!id) return;
    hosts.add(routeHost.get(id) ?? DEV_WORLD_HOST);
  };

  addHostFor(scope);
  for (const id of transcriptTouchedObjectIds(transcript)) {
    if (!createdIds.has(id)) addHostFor(id);
  }
  for (const create of transcript.creates) {
    const host =
      routeHost.get(create.object) ??
      (create.anchor ? routeHost.get(create.anchor) : undefined) ??
      (create.location ? routeHost.get(create.location) : undefined) ??
      DEV_WORLD_HOST;
    hosts.add(host);
  }
  if (transcriptSessionActiveScope(transcript)) hosts.add(DEV_WORLD_HOST);
  for (const host of Array.from(hosts).sort()) {
    world.applyCommittedShadowTranscriptToHost(host, transcript, { gatewayHost: host === DEV_WORLD_HOST });
  }
}

export function directAudienceForTarget(world: WooWorld, target: ObjRef): ObjRef | null {
  // Mirrors WooWorld.directAudience synchronously so the WS frame handler
  // can pick the right per-scope relay without re-entering async dispatch.
  if (!world.objects.has(target)) return null;
  if (world.isDescendantOf(target, "$space")) return target;
  const obj = world.object(target);
  if (obj.anchor && world.objects.has(obj.anchor) && world.isDescendantOf(obj.anchor, "$space")) return obj.anchor;
  if (obj.location && world.objects.has(obj.location) && world.isDescendantOf(obj.location, "$space")) return obj.location;
  return null;
}

export function resolveTurnEnvelopeScope(world: WooWorld, encoded: string): ObjRef | null {
  return resolveTurnEnvelopeRouting(world, encoded)?.scope ?? null;
}

export function resolveTurnEnvelopeRouting(world: WooWorld, encoded: string): { scope: ObjRef; target: ObjRef | null } | null {
  // Decode just enough of an inbound intent/exec envelope to find the
  // call target. The target determines the audience scope; the intent's
  // declared scope is only used as fallback when the target isn't
  // space-resolvable (e.g. a verb on a floating object outside any
  // $space). The dev WS handler needs both the resolved scope (to pick
  // the relay) AND the call target (to refresh that row in the
  // destination relay's serialized snapshot before planning — matching
  // the explicit-rows authority-slice contract the REST and MCP paths
  // use).
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
      if (audience) return { scope: audience, target: target as ObjRef };
    }
    if (intentScope) return { scope: intentScope as ObjRef, target: (target as ObjRef | null) ?? null };
    return null;
  } catch {
    return null;
  }
}

export type TurnIntentRecovery = {
  id: string;
  envelope_id: string;
  scope: ObjRef;
  route: "direct" | "sequenced";
};

export function decodeTurnIntentForRecovery(encoded: string): TurnIntentRecovery | null {
  // Used only on the WS-handler error path so the client can correlate a
  // pre-recording substrate throw (E_PERM, E_DIRECT_DENIED, etc.) with
  // its original intent envelope. Returns null when the envelope isn't a
  // turn intent we can answer for; the caller falls back to a generic
  // transport error in that case.
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
  error: { code: string; message?: string };
  relayNode: string;
  to: string;
  actor?: ObjRef;
  session?: string;
  auth: ShadowEnvelopeAuth;
}): ShadowEnvelope<ShadowTurnExecReply> {
  // Substrate gates (presence/permission) fire before withTurnRecording
  // starts, so the corresponding throw escapes runShadowTurnCallOnWorld
  // without producing a transcript. The WS handler still needs to answer
  // with a reply whose `reply_to === intent.envelope_id`, otherwise the
  // SPA's pendingNetworkTurns set and the worker's pending storage never
  // drain and the wait cursor spins forever. Shape the reply as a
  // commit_rejected/permission_denied conflict so the SPA's
  // E_V2_COMMIT_REJECTED error path fires with the substrate error.
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
