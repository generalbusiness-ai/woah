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
import { serializedFor, transcriptSessionActiveScope, transcriptTouchedObjectIds, type ShadowCommitAccepted } from "../core/shadow-commit-scope";
import { fanOutHostWrites } from "../core/object-host-write-through";
import {
  browserProfileProjectionContext,
  browserProfileProjectionWriteFromAuthority,
  summarizeProjectionWrites,
  type BrowserProfile,
  type ProjectionDeltaSummary,
  type ProjectionWrite
} from "../core/projection-delta";
import {
  buildV2FanoutLiveEvents,
  planV2BrowserFanout,
  type V2FanoutPeer
} from "../core/v2-fanout-projection";
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
  receiveShadowBrowserEnvelopeReceipt,
  shadowBrowserReplyEnvelopeForReceipt,
  shadowLiveEventsForTranscriptRelay,
  type ShadowBrowserEnvelopeReceipt,
  type ShadowBrowserNode,
  type ShadowLiveEvent
} from "../core/shadow-browser-node";
import type { PlanningAdmissibilityViolation } from "../core/planning-world";
import { restFrameFromTurnReply } from "../core/protocol";
import { wooError, type AppliedFrame, type DirectResultFrame, type MetricEvent, type ObjRef, type WooValue } from "../core/types";
import type { WooWorld } from "../core/world";

const DEV_WORLD_HOST = "world";

// Test/diagnostic hook: localdev shares the CF object-host write-through fan-out
// (src/core/object-host-write-through.ts) so it exercises the same local-apply +
// remote-forward + E_RETRY path. `onRemoteForward` is invoked before each remote
// host's in-process apply; throwing from it simulates an object-host RPC failure
// (timeout/rejection) so tests can drive the partial-fanout / E_RETRY contract
// without Cloudflare.
export type DevHostWriteThroughOptions = {
  // Invoked before each remote host's in-process apply; throwing simulates an
  // object-host RPC failure (timeout/rejection) so tests can drive the
  // partial-fanout / E_RETRY contract without Cloudflare.
  onRemoteForward?: (hostKey: string) => void | Promise<void>;
};

export async function materializeDevV2CommitLocally(
  world: WooWorld,
  scope: ObjRef,
  transcript: EffectTranscript,
  options: DevHostWriteThroughOptions = {}
): Promise<void> {
  const routeHost = new Map(world.objectRoutes().map((route) => [route.id, route.host] as const));
  const resolveHost = (id: ObjRef): string => routeHost.get(id) ?? DEV_WORLD_HOST;
  const localHostKey = resolveHost(scope);
  const forwardHook = async (host: string): Promise<void> => {
    if (options.onRemoteForward) await options.onRemoteForward(host);
  };

  // localdev materializes in transcript mode: apply the accepted transcript per
  // touched host through the shared fan-out (local apply + in-process forward +
  // E_RETRY). Projection-mode parity (branching on commit.projection_delta like
  // CF's writeThroughProjectionWritesToObjectHosts) is deferred — see
  // notes/2026-06-03-object-host-write-through-seam.md.
  const createdIds = new Set(transcript.creates.map((create) => create.object));
  const hosts = new Set<string>();
  const addHostFor = (id: ObjRef | null | undefined): void => {
    if (!id) return;
    hosts.add(resolveHost(id));
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

  // The scope's host plays the "local" DO; every other touched host is reached
  // through an in-process forward, mirroring CF's local-apply + RPC-fanout shape.
  const slicesByHost = new Map<string, EffectTranscript>();
  for (const host of Array.from(hosts).sort()) slicesByHost.set(host, transcript);
  const applyToHost = (host: string): void => {
    world.applyCommittedShadowTranscriptToHost(host, transcript, { gatewayHost: host === DEV_WORLD_HOST });
  };
  await fanOutHostWrites<EffectTranscript>({
    localHostKey,
    isGatewayHost: (host) => host === DEV_WORLD_HOST,
    slicesByHost,
    scope,
    touched: hosts.size,
    retryMessage: "v2 commit accepted but localdev object-host write-through failed",
    onMetric: (event) => world.recordMetric(event),
    applyLocal: () => applyToHost(localHostKey),
    forwardRemote: async (host) => {
      await forwardHook(host);
      applyToHost(host);
    }
  });
}

// Sentinel commit scope for the live (non-durable) fanout decision: no real
// peer scope can equal it, so `planV2BrowserFanout` marks no state-transfer
// targets while still routing the transcript-derived live events.
const DEV_LIVE_NO_COMMIT_SCOPE = "\0:dev-live-no-commit" as ObjRef;

export type DevV2FanoutPlan = {
  kind: "live" | "commit" | "none";
  // Per recipient peer node: the (non-empty) live events to send.
  liveDeliveries: Array<{ node: string; events: ShadowLiveEvent[] }>;
  // Commit turns only: peers bound to the commit scope that must re-sync their
  // projection via an in-process delta transfer.
  stateTransferNodes: string[];
  // Commit turns only: the accepted commit the delta transfer is built from.
  commit?: ShadowCommitAccepted;
};

// The dev transport's CF-shaped browser fanout decision, composed from the same
// shared primitives the worker's sendV2CommitTranscriptFanout uses
// (computeDirectLiveAudiences + buildV2FanoutLiveEvents + planV2BrowserFanout).
// Free of socket I/O so it is testable directly against a world + a synthetic
// peer set; the caller (dev-server) supplies the connected peers and performs
// the resulting sends and projection transfers.
//
//   - A LIVE (non-durable) reply fans transcript-derived events to peers by
//     (session, actor, scope); no projection transfer.
//   - A COMMITTED reply recomputes per-observation audiences authoritatively
//     (directed/private observations stay private; room observations reach
//     co-present peers across every affected scope), routes the resulting
//     events, and marks commit-scope peers for a projection catch-up. The old
//     dev path delivered only a delta to commit-scope subscribers and emitted
//     no live events for committed turns.
export async function planDevV2BrowserFanout(input: {
  world: WooWorld;
  reply: ShadowTurnExecReply;
  fromNode: string;
  peers: V2FanoutPeer[];
  originNode: string;
}): Promise<DevV2FanoutPlan> {
  const reply = input.reply;
  if (reply.ok !== true || !reply.transcript) {
    return { kind: "none", liveDeliveries: [], stateTransferNodes: [] };
  }
  if (!reply.commit) {
    const events = shadowLiveEventsForTranscriptRelay(input.fromNode, reply.transcript);
    const { liveDeliveries } = planV2BrowserFanout({
      events,
      commitScope: DEV_LIVE_NO_COMMIT_SCOPE,
      peers: input.peers,
      originNode: input.originNode
    });
    return { kind: "live", liveDeliveries, stateTransferNodes: [] };
  }
  const commit = reply.commit;
  const commitScope = commit.position.scope;
  // Clone observations: computeDirectLiveAudiences strips _audience_override in
  // place, and the committed transcript must not be mutated.
  const observations = structuredClone(reply.transcript.observations);
  const audiences = await input.world.computeDirectLiveAudiences(commitScope, observations);
  const eventTranscript = { ...reply.transcript, observations } as EffectTranscript;
  const events = buildV2FanoutLiveEvents(input.fromNode, eventTranscript, audiences);
  const plan = planV2BrowserFanout({ events, commitScope, peers: input.peers, originNode: input.originNode });
  return { kind: "commit", liveDeliveries: plan.liveDeliveries, stateTransferNodes: plan.stateTransferNodes, commit };
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
  // Scope-aware relay resolvers, mirroring CF's per-scope ensureRestV2Relay /
  // v2CommitScopePost. A turn can PLAN in one scope and COMMIT in another (B6
  // relocation moves the commit to the moved object's scope), so the primitive
  // must resolve the gateway/commit relay for whatever scope submitTurnIntent
  // asks for, not bind a single fixed pair. The resolvers are responsible for
  // warming the relay they return (sessions/authority), exactly as CF's
  // ensureRestV2Relay warms the DO it opens.
  gatewayRelayForScope: (scope: ObjRef) => ShadowRelayCache;
  commitRelayForScope: (scope: ObjRef) => ShadowRelayCache;
  call: ExecutorCallInput;
  node: string;
  maxAttempts?: number;
  onMetric?: (event: MetricEvent) => void;
  onAdmissionViolation?: (violations: PlanningAdmissibilityViolation[]) => void;
}): Promise<SubmitTurnIntentResult<DevV2GatewayClient, ExecutorEnvelopeResult>> {
  // One gateway client per scope. submitTurnIntent calls ensureClient for the
  // planning scope and again for the (possibly different) commit scope; each
  // needs its own sparse gateway relay + turn counter.
  const clients = new Map<ObjRef, DevV2GatewayClient>();
  return submitTurnIntent<DevV2GatewayClient, ExecutorEnvelopeResult>({
    input: input.call,
    maxAttempts: input.maxAttempts ?? 8,
    // The dev gateway relay is truly sparse (like the MCP gateway, unlike a warm
    // CommitScopeDO-backed REST relay), so repair authority BEFORE planning and
    // extract missing-object ids from planning-phase admission errors.
    prePlanAuthority: true,
    ensureClient: async (scope) => {
      const gatewayRelay = input.gatewayRelayForScope(scope);
      let client = clients.get(scope);
      if (!client) {
        client = { node: input.node, relay: gatewayRelay, nextTurn: 0 };
        clients.set(scope, client);
      } else {
        client.relay = gatewayRelay;
      }
      // CF "open" head sync: plan against the commit scope's current head so the
      // expected-head check at commit matches the authority's head.
      client.relay.commit_scope.head = input.commitRelayForScope(scope).commit_scope.head;
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
      // In-process CommitScopeDO: resolve the commit relay for the B6-selected
      // commit scope (which may differ from the planning scope), apply the
      // submitted authority slice, then run the turn through the same
      // browser-relay machinery the worker's /v2/envelope handler uses. The
      // scope assertion is the dev analog of v2CommitScopePost routing to the
      // CommitScopeDO whose id IS the scope: a mismatch means the resolver
      // returned the wrong DO and the commit would land on the wrong head.
      const commitRelay = input.commitRelayForScope(scope);
      if (commitRelay.commit_scope.scope !== scope) {
        throw wooError("E_INTERNAL", `dev commit relay scope mismatch: relay=${commitRelay.commit_scope.scope} envelope=${scope}`);
      }
      mergeAuthorityIntoRelayCache(commitRelay, body.authority, { preserveSessionActorLive: true, clone: true, reason: "dev_commit_authority" });
      const commitBrowser = createShadowBrowserClient({
        node: input.node,
        scope,
        actor: input.call.actor,
        session: input.call.session,
        relay: commitRelay,
        token: input.call.token
      });
      const receipt = receiveShadowBrowserEnvelopeReceipt(commitBrowser, body.envelope);
      const reply = await handleShadowBrowserTurnExecEnvelope(commitBrowser, receipt, input.onMetric ? { onMetric: input.onMetric } : {});
      return { reply: reply ? encodeEnvelope(reply) : null, head: commitRelay.commit_scope.head };
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
  gatewayRelayForScope: (scope: ObjRef) => ShadowRelayCache;
  commitRelayForScope: (scope: ObjRef) => ShadowRelayCache;
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
    await materializeDevV2CommitLocally(input.world, submitted.reply.commit.position.scope, submitted.reply.transcript);
  }
  // restFrameFromTurnReply throws turnReplyError on a rejected commit / !ok,
  // matching the legacy dev REST path.
  return { frame: restFrameFromTurnReply(input.call.scope, submitted.reply), submitted };
}

// A verb that raised (before/at recording) has no useful transcript; the SPA
// still needs a drainable reply. Shape it as a commit_rejected/permission_denied
// conflict so the SPA's E_V2_COMMIT_REJECTED path fires with the substrate error.
// Shared by the WS pre-recording-throw recovery and the durable-WS local-frame
// (verb-raised) path.
export function verbThrewReplyBody(input: {
  id: string;
  scope: ObjRef;
  route: "direct" | "sequenced";
  error: { code: string; message?: string };
}): ShadowTurnExecReply {
  const errors = [`${input.error.code}: ${input.error.message ?? ""}`];
  return {
    kind: "woo.turn.exec.reply.shadow.v1",
    ok: false,
    id: input.id,
    reason: "commit_rejected",
    commit: {
      kind: "woo.commit.conflict.shadow.v1",
      id: input.id,
      scope: input.scope,
      current: { kind: "woo.scope_head.shadow.v1", scope: input.scope, epoch: 1, seq: 0, hash: "" },
      reason: "permission_denied",
      errors,
      receipt: {
        kind: "woo.commit_receipt.shadow.v1",
        id: input.id,
        route: input.route,
        scope: input.scope,
        seq: 0,
        transcript_hash: "",
        pre_state_hash: "",
        post_state_hash: "",
        accepted: false,
        errors
      }
    }
  };
}

// Durable WS turn → a socket-addressed reply the SPA can drain. Runs the CF
// commit contract (executeInProcessV2DurableTurn) + write-through, then wraps the
// result into a reply addressed to `browser` with `reply_to = receipt.envelope.id`
// (the original WS intent id). Unlike the REST wrapper this NEVER throws — every
// outcome (accepted, commit-rejected, verb-raised) returns a reply envelope, so
// the SPA's pending-turn set always drains. This is the testable seam the WS
// handler delegates to.
// Decode an inbound WS turn-intent envelope into an ExecutorCallInput so the dev
// WS handler can route durable turns through the CF commit contract. Returns null
// when the envelope is not a decodable turn intent (the caller falls back to the
// legacy browser-relay path). persistence defaults to "durable" only when absent;
// an explicit "live" is preserved so the caller keeps live turns off the
// committing path.
export function decodeTurnIntentCall(encoded: string, sessionId: string, token: string): ExecutorCallInput | null {
  try {
    const env = decodeEnvelope<{
      id?: unknown; route?: unknown; scope?: unknown; target?: unknown;
      verb?: unknown; args?: unknown; body?: unknown; persistence?: unknown;
      selected_ad?: unknown;
    }>(encoded);
    if (env.type !== "woo.turn.intent.request.shadow.v1") return null;
    const b = env.body;
    // A selected-ad intent (B8 gossip delegation: the browser pre-selected an
    // executor ad on the wire body) must NOT be flattened into an
    // ExecutorCallInput — the sparse-gateway primitive plans the turn locally
    // and has no concept of a pre-selected executor, so the delegation would be
    // silently dropped. Returning null routes the caller to the legacy
    // handleShadowBrowserTurnExecEnvelope path, which honors selected_ad exactly
    // as CF forwards the original encoded envelope to the CommitScopeDO.
    if (typeof (b as { selected_ad?: unknown })?.selected_ad === "string") return null;
    // The call's actor is carried on the ENVELOPE (env.actor), not in the intent
    // body; scope/target/verb/args are in the body.
    const actor = typeof env.actor === "string" ? env.actor : null;
    if (!actor || typeof b?.verb !== "string" || typeof b?.target !== "string" || typeof b?.scope !== "string") return null;
    return {
      id: typeof b.id === "string" ? b.id : undefined,
      route: b.route === "direct" ? "direct" : "sequenced",
      scope: b.scope as ObjRef,
      session: sessionId,
      actor: actor as ObjRef,
      target: b.target as ObjRef,
      verb: b.verb,
      args: Array.isArray(b.args) ? b.args : [],
      ...(b.body && typeof b.body === "object" ? { body: b.body as Record<string, WooValue> } : {}),
      persistence: b.persistence === "live" ? "live" : "durable",
      token
    };
  } catch {
    return null;
  }
}

export type DevV2DurableWsReplyInput = {
  world: WooWorld;
  gatewayRelayForScope: (scope: ObjRef) => ShadowRelayCache;
  commitRelayForScope: (scope: ObjRef) => ShadowRelayCache;
  browser: ShadowBrowserNode;
  receipt: ShadowBrowserEnvelopeReceipt;
  call: ExecutorCallInput;
  node: string;
  onMetric?: (event: MetricEvent) => void;
  onAdmissionViolation?: (violations: PlanningAdmissibilityViolation[]) => void;
};

export type DevV2DurableWsReplyResult = {
  reply: ShadowEnvelope<ShadowTurnExecReply>;
  submitted?: SubmitTurnIntentResult<DevV2GatewayClient, ExecutorEnvelopeResult>;
};

export async function executeDevV2DurableTurnWsReply(input: DevV2DurableWsReplyInput): Promise<DevV2DurableWsReplyResult> {
  // Idempotency: a replayed intent (the relay already saw this idempotency key)
  // returns the cached WS reply WITHOUT re-executing — otherwise a retried
  // durable turn commits twice (a real regression for create verbs). Mirrors
  // handleShadowBrowserTurnExecEnvelope's recent_replies behavior, which the
  // legacy dev WS path relied on. The cache lives on the WS-bound relay
  // (browser.relay) — where the SPA's retries actually arrive and where the
  // receipt's idempotency_key was minted — NOT on a commit relay (which the
  // B6-selected commit scope may differ from for a relocation turn).
  if (!input.receipt.fresh) {
    const cached = input.browser.relay.recent_replies.get(input.receipt.idempotency_key);
    if (cached) return { reply: structuredClone(cached) as ShadowEnvelope<ShadowTurnExecReply> };
  }
  const computed = await computeDevV2DurableTurnWsReply(input);
  input.browser.relay.recent_replies.set(input.receipt.idempotency_key, structuredClone(computed.reply));
  return computed;
}

async function computeDevV2DurableTurnWsReply(input: DevV2DurableWsReplyInput): Promise<DevV2DurableWsReplyResult> {
  const turnId = input.call.id ?? input.receipt.envelope.id;
  let submitted: SubmitTurnIntentResult<DevV2GatewayClient, ExecutorEnvelopeResult>;
  try {
    submitted = await executeInProcessV2DurableTurn({
      world: input.world,
      gatewayRelayForScope: input.gatewayRelayForScope,
      commitRelayForScope: input.commitRelayForScope,
      call: input.call,
      node: input.node,
      ...(input.onMetric ? { onMetric: input.onMetric } : {}),
      ...(input.onAdmissionViolation ? { onAdmissionViolation: input.onAdmissionViolation } : {})
    });
  } catch (err) {
    // Pre-recording substrate throws (presence/permission gates, unknown verb)
    // escape submitTurnIntent without a local_frame. The WS path MUST still
    // answer with a drainable reply, or the SPA's pending-turn set spins forever.
    const e = err as { code?: unknown; message?: unknown };
    const error = typeof e?.code === "string"
      ? { code: e.code, message: typeof e.message === "string" ? e.message : undefined }
      : { code: "E_INTERNAL", message: err instanceof Error ? err.message : String(err) };
    const body = verbThrewReplyBody({ id: turnId, scope: input.call.scope, route: input.call.route, error });
    return { reply: shadowBrowserReplyEnvelopeForReceipt(input.browser, input.receipt, body) };
  }
  if (submitted.kind === "local_frame") {
    const error = submitted.frame.op === "error"
      ? submitted.frame.error
      : { code: "E_INTERNAL", message: "dev v2 durable turn produced an unexpected non-error local frame" };
    const body = verbThrewReplyBody({ id: turnId, scope: input.call.scope, route: input.call.route, error });
    return { reply: shadowBrowserReplyEnvelopeForReceipt(input.browser, input.receipt, body), submitted };
  }
  if (!submitted.reply) {
    const body = verbThrewReplyBody({ id: turnId, scope: input.call.scope, route: input.call.route, error: { code: "E_INTERNAL", message: "dev v2 durable turn produced no reply" } });
    return { reply: shadowBrowserReplyEnvelopeForReceipt(input.browser, input.receipt, body), submitted };
  }
  if (submitted.reply.ok && submitted.reply.commit && submitted.reply.transcript) {
    await materializeDevV2CommitLocally(input.world, submitted.reply.commit.position.scope, submitted.reply.transcript);
  }
  const receiverReply = devV2BrowserProfileTurnReply({
    reply: submitted.reply,
    browser: input.browser,
    commitRelayForScope: input.commitRelayForScope
  });
  // Accepted OR a !ok reply (commit_rejected / missing_state) — wrap it for the
  // WS client; the socket addressing + reply_to come from the original receipt,
  // not the primitive's internally-addressed reply.
  return { reply: shadowBrowserReplyEnvelopeForReceipt(input.browser, input.receipt, receiverReply), submitted };
}

export function devV2BrowserProfileTurnReply(input: {
  reply: ShadowTurnExecReply;
  browser: ShadowBrowserNode;
  commitRelayForScope: (scope: ObjRef) => ShadowRelayCache;
}): ShadowTurnExecReply {
  const reply = input.reply;
  if (reply.ok !== true || !reply.commit) return reply;
  const authorityWrites = reply.commit.projection_writes ?? [];
  if (authorityWrites.length === 0 && !reply.commit.projection_delta) return reply;
  const commitRelay = input.commitRelayForScope(reply.commit.position.scope);
  const context = browserProfileProjectionContext(serializedFor(commitRelay.commit_scope, { reason: "dev_ws_browser_profile_reply" }));
  const browserWrites = authorityWrites
    .map((write) => browserProfileProjectionWriteFromAuthority({
      write,
      context,
      scope: reply.commit!.position.scope,
      head: reply.commit!.position,
      viewer: { actor: input.browser.actor, session: input.browser.session }
    }))
    .filter((write): write is ProjectionWrite<BrowserProfile> => write !== null);
  const projectionDelta = devV2BrowserProjectionDeltaFromWrites(browserWrites, reply.commit.projection_delta);
  return {
    ...reply,
    commit: {
      ...reply.commit,
      projection_delta: projectionDelta,
      projection_writes: browserWrites
    }
  } as ShadowTurnExecReply;
}

function devV2BrowserProjectionDeltaFromWrites(
  writes: ProjectionWrite<BrowserProfile>[],
  authorityDelta: ProjectionDeltaSummary | undefined
): ProjectionDeltaSummary {
  const delta = summarizeProjectionWrites(writes as ProjectionWrite[]);
  if (authorityDelta?.tool_surface_sources?.length) {
    delta.tool_surface_sources = structuredClone(authorityDelta.tool_surface_sources);
  }
  return delta;
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
  const replyBody = verbThrewReplyBody({
    id: input.intent.id,
    scope: input.intent.scope,
    route: input.intent.route,
    error: input.error
  });
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
