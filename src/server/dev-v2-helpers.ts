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
// All three predate the executor consolidation but remain because
// the dev transport runs ingress in-process rather than through the
// CommitScopeDO surface.

import type { EffectTranscript } from "../core/effect-transcript";
import { serializedFor, transcriptSessionActiveScope, transcriptTouchedObjectIds } from "../core/shadow-commit-scope";
import { decodeEnvelope, encodeEnvelope, type ShadowEnvelope, type ShadowEnvelopeAuth } from "../core/shadow-envelope";
import type { ShadowTurnExecReply } from "../core/shadow-turn-exec";
import {
  executorAuthorityPayload,
  submitTurnIntent,
  type ExecutorCallInput,
  type ExecutorEnvelopeResult,
  type SubmitTurnIntentResult
} from "../core/executor";
import {
  markShadowBrowserRelaySerializedChanged,
  mergeAuthorityIntoRelayCache,
  type ShadowRelayCache
} from "../core/shadow-relay-cache";
import {
  createShadowBrowserClient,
  handleShadowBrowserTurnExecEnvelope,
  receiveShadowBrowserEnvelopeReceipt
} from "../core/shadow-browser-node";
import type { PlanningAdmissibilityViolation } from "../core/planning-world";
import { restFrameFromTurnReply } from "../core/protocol";
import { wooError, type AppliedFrame, type DirectResultFrame, type MetricEvent, type ObjRef } from "../core/types";
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

export type DevV2GatewayClient = {
  node: string;
  relay: ShadowRelayCache;
  nextTurn: number;
};

// In-process equivalent of the Cloudflare durable-turn contract (the worker's
// restV2Turn → submitTurnIntent → CommitScopeDO chain), so localdev exercises the
// SAME sparse/repair/admission/cross-scope machinery as cloud instead of the
// full-world browser-relay shortcut. The chain:
//   - Plan on a SPARSE `gatewayRelay` through `submitTurnIntent`: the
//     PlanningWorld admission gate (enforceMissingProvenance) + the authority
//     repair loop fire because the gateway does not hold the full world.
//   - Commit through an in-process `submitEnvelope` that runs the CommitScopeDO
//     `/v2/envelope` sequence (receiveShadowBrowserEnvelopeReceipt +
//     handleShadowBrowserTurnExecEnvelope) on the AUTHORITATIVE `commitRelay`.
// Authority for the repair loop is sourced from `world` (the local durable
// authority), mirroring the worker's v2GatewayAuthorityPayload.
export async function executeInProcessV2DurableTurn(input: {
  world: WooWorld;
  gatewayRelay: ShadowRelayCache;
  commitRelay: ShadowRelayCache;
  call: ExecutorCallInput;
  node: string;
  maxAttempts?: number;
  onMetric?: (event: MetricEvent) => void;
  onAdmissionViolation?: (violations: PlanningAdmissibilityViolation[]) => void;
}): Promise<SubmitTurnIntentResult<DevV2GatewayClient, ExecutorEnvelopeResult>> {
  const client: DevV2GatewayClient = { node: input.node, relay: input.gatewayRelay, nextTurn: 0 };
  return submitTurnIntent<DevV2GatewayClient, ExecutorEnvelopeResult>({
    input: input.call,
    maxAttempts: input.maxAttempts ?? 8,
    // The dev gateway relay is truly sparse (like the MCP gateway, unlike a warm
    // CommitScopeDO-backed REST relay), so repair authority BEFORE planning and
    // extract missing-object ids from planning-phase admission errors.
    prePlanAuthority: true,
    ensureClient: async () => {
      // CF "open" head sync: plan against the commit scope's current head so the
      // expected-head check at commit matches the authority's head.
      client.relay.commit_scope.head = input.commitRelay.commit_scope.head;
      return client;
    },
    clientNode: (c) => c.node,
    clientHead: (c) => c.relay.commit_scope.head,
    clientSerialized: (c) => serializedFor(c.relay.commit_scope, {
      reason: "dev_turn_plan",
      ...(input.onMetric ? { metric: input.onMetric } : {})
    }),
    clientPlanningProvenance: (c) => c.relay.commit_scope.cellProvenance ?? new Map(),
    enforceMissingProvenance: true,
    ...(input.onAdmissionViolation ? { onAdmissionViolation: input.onAdmissionViolation } : {}),
    nextTurnId: (c) => `${c.node}:turn:${c.nextTurn++}`,
    authorityPayload: (_scope, extraObjectIds) => executorAuthorityPayload(input.world, extraObjectIds),
    applyAuthority: (c, authority) => {
      mergeAuthorityIntoRelayCache(c.relay, authority, { preserveSessionActorLive: true, clone: true, reason: "dev_gateway_authority" });
      markShadowBrowserRelaySerializedChanged(c.relay);
    },
    submitEnvelope: async (scope, body) => {
      // In-process CommitScopeDO: apply the submitted authority slice to the
      // authoritative commit relay, then run the turn through the same
      // browser-relay machinery the worker's /v2/envelope handler uses.
      mergeAuthorityIntoRelayCache(input.commitRelay, body.authority, { preserveSessionActorLive: true, clone: true, reason: "dev_commit_authority" });
      const commitBrowser = createShadowBrowserClient({
        node: input.node,
        scope,
        actor: input.call.actor,
        session: input.call.session,
        relay: input.commitRelay,
        token: input.call.token
      });
      const receipt = receiveShadowBrowserEnvelopeReceipt(commitBrowser, body.envelope);
      const reply = await handleShadowBrowserTurnExecEnvelope(commitBrowser, receipt, input.onMetric ? { onMetric: input.onMetric } : {});
      return { reply: reply ? encodeEnvelope(reply) : null, head: input.commitRelay.commit_scope.head };
    },
    ...(input.onMetric ? { onMetric: input.onMetric } : {})
  });
}

// Durable-turn → REST frame, with the local dev write-through. Wraps
// `executeInProcessV2DurableTurn` (the CF commit contract) and applies the
// accepted transcript to the dev `world` (per-host materialization), returning
// the same AppliedFrame/DirectResultFrame shape the legacy dev REST path
// produced. Error contract matches the legacy path: a planning error or a
// rejected commit THROWS (the REST handler maps the throw to an error
// response), rather than returning an error frame. This is the testable seam
// `devRestV2Turn` delegates to.
export async function executeDevV2DurableTurnFrame(input: {
  world: WooWorld;
  gatewayRelay: ShadowRelayCache;
  commitRelay: ShadowRelayCache;
  call: ExecutorCallInput;
  node: string;
  onMetric?: (event: MetricEvent) => void;
  onAdmissionViolation?: (violations: PlanningAdmissibilityViolation[]) => void;
}): Promise<{
  frame: AppliedFrame | DirectResultFrame;
  submitted: SubmitTurnIntentResult<DevV2GatewayClient, ExecutorEnvelopeResult>;
}> {
  const submitted = await executeInProcessV2DurableTurn(input);
  if (submitted.kind === "local_frame") {
    // Planning produced an error frame (the verb raised before commit). The
    // legacy path surfaced this as a thrown turn error; preserve the contract.
    if (submitted.frame.op === "error") throw submitted.frame.error;
    throw wooError("E_INTERNAL", "dev v2 durable turn produced an unexpected non-error local frame");
  }
  if (!submitted.reply) throw wooError("E_INTERNAL", "dev v2 durable turn produced no reply");
  if (submitted.reply.ok && submitted.reply.commit && submitted.reply.transcript) {
    materializeDevV2CommitLocally(input.world, submitted.reply.commit.position.scope, submitted.reply.transcript);
  }
  // restFrameFromTurnReply throws turnReplyError on a rejected commit / !ok,
  // matching the legacy dev REST path.
  return { frame: restFrameFromTurnReply(input.call.scope, submitted.reply), submitted };
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
