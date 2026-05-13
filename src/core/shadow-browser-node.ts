import type { SerializedObject, SerializedSession, SerializedWorld } from "./repository";
import { createShadowCommitScope, type ShadowCommitAccepted, type ShadowCommitConflict, type ShadowCommitScope } from "./shadow-commit-scope";
import {
  createShadowExecutionNode,
  installShadowCachedObjectRecords,
  shadowObjectRecordHash,
  type ShadowExecutionNode,
  type ShadowStateTransfer,
  type ShadowTurnExecRequest,
  type ShadowTurnExecutionResult
} from "./shadow-turn-exec";
import { runShadowTurnCall, type ShadowTurnCall } from "./shadow-turn-call";
import { buildShadowTurnExecAd, executeShadowTurnCallAcrossInProcessNetwork, type ShadowInProcessNetworkResult } from "./shadow-turn-network";
import { shadowTurnKeyFromTranscript, type ShadowTurnKey } from "./turn-key";
import type { EffectTranscript } from "./effect-transcript";
import { stableShadowJson } from "./shadow-cell-version";
import { decodeEnvelope, encodeEnvelope, type ShadowEnvelope, type ShadowEnvelopeAuth } from "./shadow-envelope";
import { constantTimeEqual, hashSource } from "./source-hash";
import type { ObjRef, Observation, WooValue } from "./types";

const DEFAULT_SHADOW_BROWSER_STATE_AUTHORITY = "shadow-relay";
const DEFAULT_SHADOW_BROWSER_STATE_KEY_ID = "shadow-browser-dev";
const DEFAULT_SHADOW_BROWSER_STATE_SECRET = "shadow-browser-dev-secret";
const DEFAULT_SHADOW_DEPLOYMENT = "shadow-local";
const MIN_SHADOW_IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1000;
const SHADOW_LIVE_DURABILITY_RESERVED_FIELDS = new Set([
  "writes",
  "creates",
  "moves",
  "transcript",
  "commit",
  "receipt",
  "state_transfer",
  "applied",
  "schedule",
  "cancellations"
]);

export type ShadowLiveAudience = {
  actors?: ObjRef[];
  sessions?: string[];
  scope?: ObjRef;
};

export type ShadowLiveEvent = {
  kind: "woo.live.event.shadow.v1";
  id: string;
  source: ObjRef;
  actor?: ObjRef;
  scope?: ObjRef;
  audience?: ShadowLiveAudience;
  observation: Observation;
  coalesce?: string;
};

export type ShadowProjectionTransfer = {
  kind: "woo.state.transfer.shadow.v1";
  mode: "projection";
  scope: ObjRef;
  to: ShadowCommitAccepted["position"];
  projection: WooValue;
  proof: ShadowBrowserStateProof;
};

export type ShadowDeltaTransfer = {
  kind: "woo.state.transfer.shadow.v1";
  mode: "delta";
  scope: ObjRef;
  to: ShadowCommitAccepted["position"];
  applied: ShadowCommitAccepted[];
  transcript_tail: EffectTranscript[];
  projection: WooValue;
  proof: ShadowBrowserStateProof;
};

export type ShadowBrowserStateTransfer = ShadowStateTransfer | ShadowProjectionTransfer | ShadowDeltaTransfer;

export type ShadowBrowserStateProof = {
  kind: "woo.state_proof.shadow.v1";
  scheme: "shadow.relay_mac.v1";
  authority: string;
  key_id: string;
  recipient: string;
  scope: ObjRef;
  mode: ShadowProjectionTransfer["mode"] | ShadowDeltaTransfer["mode"];
  root: string;
  head: ShadowCommitAccepted["position"];
  signature: string;
};

export type ShadowBrowserLiveInput = {
  id?: string;
  source: ObjRef;
  actor?: ObjRef;
  scope?: ObjRef;
  audience?: ShadowLiveAudience;
  observation: Observation;
  coalesce?: string;
  deliver_to_self?: boolean;
};

export type ShadowBrowserNodeCache = {
  kind: "woo.browser_cache.shadow.v1";
  object_pages: Map<string, SerializedObject>;
  object_page_refs: Map<ObjRef, string>;
  projections: Map<ObjRef, WooValue>;
  transcript_tail: EffectTranscript[];
  pending_turns: Map<string, ShadowBrowserPendingTurn>;
  applied_frames: ShadowCommitAccepted[];
  conflicts: ShadowCommitConflict[];
  transfers: ShadowBrowserStateTransfer[];
  live_events: ShadowLiveEvent[];
};

export type ShadowBrowserPendingTurn = {
  id: string;
  call: ShadowTurnCall;
  key: ShadowTurnKey;
  planned_transcript: EffectTranscript;
};

export type ShadowBrowserRelayShim = {
  kind: "woo.browser_relay.shadow.v1";
  node: string;
  deployment: string;
  commit_scope: ShadowCommitScope;
  executors: ShadowExecutionNode[];
  subscriptions: Map<ObjRef, Set<string>>;
  browsers: Map<string, ShadowBrowserNode>;
  session_auth: Map<string, ShadowBrowserSessionClaims>;
  session_revs: Map<string, number>;
  idempotency_window_ms: number;
  accepted_frames: ShadowCommitAccepted[];
  transcript_tail: EffectTranscript[];
  live_events: ShadowLiveEvent[];
  state_signing: ShadowBrowserStateSigning;
};

export type ShadowBrowserNode = {
  kind: "woo.browser_node.shadow.v1";
  node: string;
  scope: ObjRef;
  actor: ObjRef;
  session: string | null;
  execution_node: ShadowExecutionNode;
  relay: ShadowBrowserRelayShim;
  cache: ShadowBrowserNodeCache;
  trusted_state_authorities: Map<string, string>;
  session_token: string | null;
  next_turn: number;
  next_live: number;
};

export type ShadowBrowserStateSigning = {
  authority: string;
  key_id: string;
  secret: string;
};

export type ShadowBrowserSessionClaims = {
  session: string;
  actor: ObjRef;
  deployment: string;
  issued_at: number;
  expires_at: number;
  scopes: ObjRef[];
  features: string[];
  rev: number;
};

export type ShadowTransportHello = {
  kind: "woo.transport.hello.v1";
  relay: string;
  session: string;
  actor: ObjRef;
  server_time: number;
  max_message_bytes: number;
  idempotency_window_ms: number;
  planes: Array<"execution" | "commit" | "state" | "live">;
  features: string[];
};

export type ShadowTransportError = {
  kind: "woo.transport.error.v1";
  code: string;
  message: string;
  envelope_id?: string;
};

export type ShadowBrowserOpenScopeResult = {
  projection: WooValue;
  preseeded_objects: number;
  transfer_mode: "projection" | "delta";
};

export type ShadowBrowserOpenScopeOptions = {
  preseed_catalog_pages?: boolean;
  last_known_head?: ShadowCommitAccepted["position"];
};

export type ShadowBrowserTurnInput = {
  id?: string;
  route?: ShadowTurnCall["route"];
  scope?: ObjRef;
  target: ObjRef;
  verb: string;
  args?: WooValue[];
  commit_policy?: ShadowTurnExecRequest["commit_policy"];
};

export type ShadowBrowserTurnResult = {
  id: string;
  call: ShadowTurnCall;
  key: ShadowTurnKey;
  planned_transcript: EffectTranscript;
  network: ShadowInProcessNetworkResult;
  result: ShadowTurnExecutionResult;
};

export function createShadowBrowserRelayShim(input: {
  node: string;
  scope: ObjRef;
  serialized: SerializedWorld;
  executors?: ShadowExecutionNode[];
  state_signing?: Partial<ShadowBrowserStateSigning>;
  deployment?: string;
  session_revs?: Record<string, number>;
  idempotency_window_ms?: number;
}): ShadowBrowserRelayShim {
  const sessionRevs = shadowBrowserSessionRevs(input.serialized.sessions, input.session_revs);
  const deployment = input.deployment ?? DEFAULT_SHADOW_DEPLOYMENT;
  return {
    kind: "woo.browser_relay.shadow.v1",
    node: input.node,
    deployment,
    commit_scope: createShadowCommitScope({
      node: input.node,
      scope: input.scope,
      serialized: input.serialized
    }),
    executors: input.executors ?? [],
    subscriptions: new Map(),
    browsers: new Map(),
    session_auth: shadowBrowserSessionClaims(input.serialized.sessions, input.scope, deployment, sessionRevs),
    session_revs: sessionRevs,
    idempotency_window_ms: Math.max(input.idempotency_window_ms ?? MIN_SHADOW_IDEMPOTENCY_WINDOW_MS, MIN_SHADOW_IDEMPOTENCY_WINDOW_MS),
    accepted_frames: [],
    transcript_tail: [],
    live_events: [],
    state_signing: {
      authority: input.state_signing?.authority ?? DEFAULT_SHADOW_BROWSER_STATE_AUTHORITY,
      key_id: input.state_signing?.key_id ?? DEFAULT_SHADOW_BROWSER_STATE_KEY_ID,
      secret: input.state_signing?.secret ?? DEFAULT_SHADOW_BROWSER_STATE_SECRET
    }
  };
}

export function createShadowBrowserNode(input: {
  node: string;
  scope: ObjRef;
  actor: ObjRef;
  session?: string | null;
  relay: ShadowBrowserRelayShim;
  cached_objects?: SerializedObject[];
  trusted_state_authorities?: Record<string, string>;
}): ShadowBrowserNode {
  const executionNode = createShadowExecutionNode({
    node: input.node,
    scope: input.scope,
    cached_objects: input.cached_objects
  });
  const cache = createShadowBrowserNodeCache();
  cacheObjectPages(cache, input.cached_objects ?? []);
  const sessionToken = input.session ? shadowBrowserSessionToken(input.session, input.actor) : null;
  return {
    kind: "woo.browser_node.shadow.v1",
    node: input.node,
    scope: input.scope,
    actor: input.actor,
    session: input.session ?? null,
    execution_node: executionNode,
    relay: input.relay,
    cache,
    trusted_state_authorities: trustedBrowserStateAuthorities(input.trusted_state_authorities),
    session_token: sessionToken,
    next_turn: 1,
    next_live: 1
  };
}

export function createShadowBrowserNodeCache(): ShadowBrowserNodeCache {
  return {
    kind: "woo.browser_cache.shadow.v1",
    object_pages: new Map(),
    object_page_refs: new Map(),
    projections: new Map(),
    transcript_tail: [],
    pending_turns: new Map(),
    applied_frames: [],
    conflicts: [],
    transfers: [],
    live_events: []
  };
}

export function shadowBrowserCatalogObjects(serialized: SerializedWorld): SerializedObject[] {
  return serialized.objects
    .filter((obj) => obj.id.startsWith("$"))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function openShadowBrowserScope(
  browser: ShadowBrowserNode,
  options: ShadowBrowserOpenScopeOptions = {}
): Promise<ShadowBrowserOpenScopeResult> {
  validateShadowBrowserNodeAuth(browser);
  const serialized = browser.relay.commit_scope.serialized;
  const preseed = options.preseed_catalog_pages === true ? shadowBrowserCatalogObjects(serialized) : [];
  if (preseed.length > 0) {
    installShadowCachedObjectRecords(browser.execution_node, preseed);
    cacheObjectPages(browser.cache, preseed);
  }
  subscribeShadowBrowserNode(browser, browser.scope);
  // Scope open enters the state plane even for display-only projection data, so
  // every cache fill goes through the same recipient-bound verification path.
  const transfer = buildShadowBrowserCatchupTransfer(browser.relay, browser.scope, browser.node, options.last_known_head);
  applyShadowBrowserTransfer(browser, transfer);
  return {
    projection: transfer.projection,
    preseeded_objects: preseed.length,
    transfer_mode: transfer.mode
  };
}

export function subscribeShadowBrowserNode(browser: ShadowBrowserNode, scope: ObjRef = browser.scope): void {
  browser.relay.browsers.set(browser.node, browser);
  let subscribers = browser.relay.subscriptions.get(scope);
  if (!subscribers) {
    subscribers = new Set();
    browser.relay.subscriptions.set(scope, subscribers);
  }
  subscribers.add(browser.node);
}

export function unsubscribeShadowBrowserNode(browser: ShadowBrowserNode, scope: ObjRef = browser.scope): void {
  browser.relay.subscriptions.get(scope)?.delete(browser.node);
}

export function emitShadowBrowserLiveEvent(browser: ShadowBrowserNode, input: ShadowBrowserLiveInput): ShadowLiveEvent {
  validateShadowBrowserNodeAuth(browser);
  const event: ShadowLiveEvent = {
    kind: "woo.live.event.shadow.v1",
    id: input.id ?? `${browser.node}:live:${browser.next_live++}`,
    source: input.source,
    actor: input.actor ?? browser.actor,
    scope: input.scope ?? browser.scope,
    audience: input.audience,
    observation: input.observation,
    coalesce: input.coalesce
  };
  publishShadowBrowserLiveEvent(browser.relay, event, {
    except: input.deliver_to_self === true ? null : browser.node
  });
  return event;
}

export function publishShadowBrowserLiveEvent(
  relay: ShadowBrowserRelayShim,
  event: ShadowLiveEvent,
  options: { except?: string | null } = {}
): void {
  relay.live_events.push(structuredClone(event) as ShadowLiveEvent);
  for (const browser of relay.browsers.values()) {
    if (options.except && browser.node === options.except) continue;
    if (!shadowLiveEventMatchesBrowser(relay, browser, event)) continue;
    receiveShadowBrowserLiveEvent(browser, event);
  }
}

function receiveShadowBrowserLiveEvent(browser: ShadowBrowserNode, event: ShadowLiveEvent): void {
  const cloned = structuredClone(event) as ShadowLiveEvent;
  if (event.coalesce) {
    const index = browser.cache.live_events.findIndex((item) => item.coalesce === event.coalesce);
    if (index >= 0) {
      browser.cache.live_events[index] = cloned;
      return;
    }
  }
  browser.cache.live_events.push(cloned);
}

function shadowLiveEventMatchesBrowser(
  relay: ShadowBrowserRelayShim,
  browser: ShadowBrowserNode,
  event: ShadowLiveEvent
): boolean {
  const audience = event.audience;
  if (audience?.sessions?.includes(browser.session ?? "")) return true;
  if (audience?.actors?.includes(browser.actor)) return true;
  const scope = audience?.scope ?? event.scope;
  return typeof scope === "string" && relay.subscriptions.get(scope)?.has(browser.node) === true;
}

export async function executeShadowBrowserTurn(
  browser: ShadowBrowserNode,
  input: ShadowBrowserTurnInput
): Promise<ShadowBrowserTurnResult> {
  validateShadowBrowserNodeAuth(browser);
  const id = input.id ?? `${browser.node}:turn:${browser.next_turn++}`;
  const call: ShadowTurnCall = {
    kind: "woo.turn_call.shadow.v1",
    id,
    route: input.route ?? "sequenced",
    scope: input.scope ?? browser.scope,
    session: browser.session,
    actor: browser.actor,
    target: input.target,
    verb: input.verb,
    args: input.args ?? []
  };
  const planned = await runShadowTurnCall(browser.relay.commit_scope.serialized, call);
  const key = shadowTurnKeyFromTranscript(planned.transcript);
  const pending: ShadowBrowserPendingTurn = {
    id,
    call,
    key,
    planned_transcript: planned.transcript
  };
  browser.cache.pending_turns.set(id, pending);

  const request: ShadowTurnExecRequest = {
    kind: "woo.turn_exec_request.shadow.v1",
    id,
    call,
    key,
    expected: browser.relay.commit_scope.head,
    auth: {
      mode: "shadow_local",
      actor: browser.actor,
      session: browser.session
    },
    commit_policy: input.commit_policy ?? "execute_and_commit"
  };

  const network = await executeShadowTurnCallAcrossInProcessNetwork({
    request,
    nodes: [browser.execution_node, ...browser.relay.executors],
    // Browser nodes do not broadcast broad capability in production. This ad is
    // the relay's local optimistic route back to the actor node; exact inventory
    // is still checked before VM execution.
    ads: [buildShadowTurnExecAd({ node: browser.execution_node.node, scope: key.scope, key, factor: 0.1 })],
    anchor: {
      node: browser.relay.node,
      serialized: browser.relay.commit_scope.serialized
    },
    commitScope: browser.relay.commit_scope
  });

  for (const transfer of network.transfers) applyShadowBrowserTransfer(browser, transfer);
  if (network.result.ok) {
    browser.cache.pending_turns.delete(id);
    if (network.result.commit) publishShadowBrowserAcceptedFrame(browser.relay, network.result.commit, network.result.transcript);
    else browser.cache.transcript_tail.push(network.result.transcript);
  } else if (network.result.reason === "commit_rejected") {
    browser.cache.pending_turns.delete(id);
    if (network.result.commit) applyShadowBrowserConflict(browser, network.result.commit);
  }

  return {
    id,
    call,
    key,
    planned_transcript: planned.transcript,
    network,
    result: network.result
  };
}

export function buildShadowBrowserProjectionTransfer(relay: ShadowBrowserRelayShim, scope: ObjRef, recipient = "*"): ShadowProjectionTransfer {
  // Projection transfer replaces direct cache mutation on scope-open so display
  // state obeys the same recipient-bound relay authority check as deltas.
  const transfer = {
    kind: "woo.state.transfer.shadow.v1",
    mode: "projection",
    scope,
    to: structuredClone(relay.commit_scope.head) as ShadowCommitAccepted["position"],
    projection: shadowScopeProjection(relay.commit_scope.serialized, scope)
  } satisfies Omit<ShadowProjectionTransfer, "proof">;
  return { ...transfer, proof: signShadowBrowserStateTransfer(transfer, relay.state_signing, recipient) };
}

export function buildShadowBrowserDeltaTransfer(
  relay: ShadowBrowserRelayShim,
  accepted: ShadowCommitAccepted,
  transcript: EffectTranscript,
  recipient = "*"
): ShadowDeltaTransfer {
  // Delta transfer carries the committed frame plus transcript tail needed by
  // browser caches to catch up without receiving executable closure state.
  const transfer = {
    kind: "woo.state.transfer.shadow.v1",
    mode: "delta",
    scope: accepted.position.scope,
    to: structuredClone(accepted.position) as ShadowCommitAccepted["position"],
    applied: [structuredClone(accepted) as ShadowCommitAccepted],
    transcript_tail: [structuredClone(transcript) as EffectTranscript],
    projection: shadowScopeProjection(relay.commit_scope.serialized, accepted.position.scope)
  } satisfies Omit<ShadowDeltaTransfer, "proof">;
  return { ...transfer, proof: signShadowBrowserStateTransfer(transfer, relay.state_signing, recipient) };
}

export function buildShadowBrowserCatchupTransfer(
  relay: ShadowBrowserRelayShim,
  scope: ObjRef,
  recipient: string,
  lastKnownHead?: ShadowCommitAccepted["position"]
): ShadowProjectionTransfer | ShadowDeltaTransfer {
  if (lastKnownHead && lastKnownHead.scope === scope && lastKnownHead.epoch === relay.commit_scope.head.epoch && lastKnownHead.seq < relay.commit_scope.head.seq) {
    const accepted = relay.accepted_frames.find((frame) => frame.position.scope === scope && frame.position.seq === lastKnownHead.seq + 1);
    const transcript = accepted ? relay.transcript_tail.find((item) => item.hash === accepted.transcript_hash) : undefined;
    if (accepted && transcript) return buildShadowBrowserDeltaTransfer(relay, accepted, transcript, recipient);
  }
  return buildShadowBrowserProjectionTransfer(relay, scope, recipient);
}

export function publishShadowBrowserAcceptedFrame(
  relay: ShadowBrowserRelayShim,
  accepted: ShadowCommitAccepted,
  transcript: EffectTranscript
): void {
  rememberShadowBrowserAcceptedFrame(relay, accepted, transcript);
  // Commit fan-out is subscription-gated; browsers outside the scope must ask
  // for later state transfer rather than receiving every accepted frame.
  for (const browser of relay.browsers.values()) {
    if (relay.subscriptions.get(accepted.position.scope)?.has(browser.node) !== true) continue;
    // The originator is often subscribed too; accepted-frame dedup below makes
    // that round trip harmless while preserving one relay fan-out path.
    const transfer = buildShadowBrowserDeltaTransfer(relay, accepted, transcript, browser.node);
    applyShadowBrowserTransfer(browser, transfer);
  }
}

export function shadowBrowserEnvelope<T>(
  browser: ShadowBrowserNode,
  type: string,
  body: T,
  id = `${browser.node}:env:${browser.next_live++}`
): ShadowEnvelope<T> {
  return {
    v: 2,
    type,
    id,
    from: browser.node,
    to: browser.relay.node,
    actor: browser.actor,
    ...(browser.session ? { session: browser.session } : {}),
    auth: shadowBrowserAuth(browser),
    body
  };
}

export function shadowBrowserTransportHello(browser: ShadowBrowserNode, now = Date.now()): ShadowTransportHello {
  const claims = validateShadowBrowserAuth(browser.relay, {
    mode: "session",
    token: browser.session_token ?? undefined
  }, browser.actor, browser.session);
  // The hello mirrors the future WebSocket handshake so in-process tests catch
  // drift in session authority and replay-window metadata before M4 networking.
  return {
    kind: "woo.transport.hello.v1",
    relay: browser.relay.node,
    session: claims.session,
    actor: claims.actor,
    server_time: now,
    max_message_bytes: 1024 * 1024,
    idempotency_window_ms: browser.relay.idempotency_window_ms,
    planes: ["execution", "commit", "state", "live"],
    features: ["shadow-envelope", "shadow-catchup", "shadow-multiplex"]
  };
}

export function receiveShadowBrowserEnvelope(browser: ShadowBrowserNode, encoded: string): ShadowEnvelope {
  const envelope = decodeEnvelope(encoded);
  validateShadowBrowserEnvelopeAuth(browser.relay, browser, envelope);
  switch (envelope.type) {
    case "woo.live.event.shadow.v1":
      assertShadowLiveEventIsEphemeral(envelope.body);
      publishShadowBrowserLiveEvent(browser.relay, envelope.body as ShadowLiveEvent);
      break;
    case "woo.state.transfer.shadow.v1":
      applyShadowBrowserTransfer(browser, envelope.body as ShadowBrowserStateTransfer);
      break;
    case "woo.commit.accepted.shadow.v1":
      applyShadowBrowserAcceptedFrame(browser, envelope.body as ShadowCommitAccepted);
      break;
    case "woo.commit.conflict.shadow.v1":
      applyShadowBrowserConflict(browser, envelope.body as ShadowCommitConflict);
      break;
  }
  return envelope;
}

export function roundTripShadowBrowserEnvelope<T>(browser: ShadowBrowserNode, type: string, body: T): ShadowEnvelope<T> {
  return decodeEnvelope<T>(encodeEnvelope(shadowBrowserEnvelope(browser, type, body)));
}

export function applyShadowBrowserAcceptedFrame(browser: ShadowBrowserNode, accepted: ShadowCommitAccepted): void {
  if (browser.cache.applied_frames.some((frame) => frame.id === accepted.id && frame.position.hash === accepted.position.hash)) return;
  browser.cache.applied_frames.push(accepted);
  browser.cache.projections.set(browser.scope, shadowScopeProjection(accepted.serialized_after, browser.scope));
}

export function applyShadowBrowserConflict(browser: ShadowBrowserNode, conflict: ShadowCommitConflict): void {
  browser.cache.conflicts.push(conflict);
}

export function applyShadowBrowserTransfer(browser: ShadowBrowserNode, transfer: ShadowBrowserStateTransfer): void {
  verifyShadowBrowserStateTransfer(browser, transfer);
  browser.cache.transfers.push(structuredClone(transfer) as ShadowBrowserStateTransfer);
  switch (transfer.mode) {
    case "projection":
      browser.cache.projections.set(transfer.scope, structuredClone(transfer.projection) as WooValue);
      return;
    case "delta":
      browser.cache.projections.set(transfer.scope, structuredClone(transfer.projection) as WooValue);
      for (const transcript of transfer.transcript_tail) {
        if (!browser.cache.transcript_tail.some((item) => item.hash === transcript.hash)) {
          browser.cache.transcript_tail.push(structuredClone(transcript) as EffectTranscript);
        }
      }
      for (const accepted of transfer.applied) applyShadowBrowserAcceptedFrame(browser, accepted);
      return;
    case "closure":
      // Closure and object-record transfers keep the execution-plane
      // shadow.anchor_mac.v1 proof; this browser cache path only stores pages.
      cacheObjectPages(browser.cache, transfer.serialized.objects);
      return;
    case "object_records":
      cacheObjectPages(browser.cache, transfer.objects);
      return;
  }
  assertNeverTransfer(transfer);
}

function cacheObjectPages(cache: ShadowBrowserNodeCache, objects: SerializedObject[]): void {
  for (const obj of objects) {
    const hash = shadowObjectRecordHash(obj);
    cache.object_pages.set(hash, structuredClone(obj) as SerializedObject);
    cache.object_page_refs.set(obj.id, hash);
  }
}

function shadowScopeProjection(serialized: SerializedWorld, scope: ObjRef): WooValue {
  const scopeObj = serialized.objects.find((obj) => obj.id === scope);
  return {
    kind: "woo.scope_projection.shadow.v1",
    scope,
    title: scopeObj?.name ?? scope,
    object_count: serialized.objects.length,
    contents: scopeObj?.contents ?? [],
    seq: serialized.logs.find(([space]) => space === scope)?.[1].reduce((max, entry) => Math.max(max, entry.seq), 0) ?? 0
  };
}

function trustedBrowserStateAuthorities(input: Record<string, string> | undefined): Map<string, string> {
  return new Map(Object.entries(input ?? { [DEFAULT_SHADOW_BROWSER_STATE_AUTHORITY]: DEFAULT_SHADOW_BROWSER_STATE_SECRET }));
}

function shadowBrowserSessionClaims(
  sessions: SerializedSession[],
  scope: ObjRef,
  deployment: string,
  sessionRevs: Map<string, number>
): Map<string, ShadowBrowserSessionClaims> {
  const claims = new Map<string, ShadowBrowserSessionClaims>();
  for (const session of sessions) {
    const token = shadowBrowserSessionToken(session.id, session.actor);
    claims.set(token, {
      session: session.id,
      actor: session.actor,
      deployment,
      issued_at: session.started,
      expires_at: session.expiresAt ?? session.started + 15 * 60 * 1000,
      scopes: [scope],
      features: ["shadow-envelope", "shadow-catchup", "shadow-multiplex"],
      rev: sessionRevs.get(session.id) ?? 1
    });
  }
  return claims;
}

function shadowBrowserSessionRevs(
  sessions: SerializedSession[],
  overrides: Record<string, number> | undefined
): Map<string, number> {
  const revs = new Map<string, number>();
  for (const session of sessions) revs.set(session.id, overrides?.[session.id] ?? 1);
  return revs;
}

function shadowBrowserSessionToken(session: string, actor: ObjRef): string {
  return `shadow-session:${session}:${actor}`;
}

function shadowBrowserAuth(browser: ShadowBrowserNode): ShadowEnvelopeAuth {
  if (!browser.session_token) throw new Error("shadow browser session auth token is required");
  const claims = browser.relay.session_auth.get(browser.session_token);
  if (!claims) throw new Error("shadow browser session auth token is unknown");
  return {
    mode: "session",
    token: browser.session_token,
    claims: claims as unknown as Record<string, WooValue>
  };
}

function validateShadowBrowserNodeAuth(browser: ShadowBrowserNode): void {
  validateShadowBrowserAuth(browser.relay, {
    mode: "session",
    token: browser.session_token ?? undefined
  }, browser.actor, browser.session);
}

function validateShadowBrowserEnvelopeAuth(relay: ShadowBrowserRelayShim, browser: ShadowBrowserNode, envelope: ShadowEnvelope): void {
  if (envelope.from !== browser.node) throw new Error(`shadow envelope sender mismatch: ${envelope.from}`);
  validateShadowBrowserAuth(relay, envelope.auth, envelope.actor, envelope.session);
}

function validateShadowBrowserAuth(
  relay: ShadowBrowserRelayShim,
  auth: ShadowEnvelopeAuth,
  actor?: ObjRef,
  session?: string | null
): ShadowBrowserSessionClaims {
  if (auth.mode !== "session") throw new Error(`unsupported shadow browser auth mode: ${auth.mode}`);
  if (!auth.token) throw new Error("shadow browser auth token is required");
  const claims = relay.session_auth.get(auth.token);
  if (!claims) throw new Error("shadow browser auth token is unknown");
  if (actor && claims.actor !== actor) throw new Error("shadow browser auth actor mismatch");
  if (session && claims.session !== session) throw new Error("shadow browser auth session mismatch");
  if (claims.deployment !== relay.deployment) throw new Error("shadow browser auth deployment mismatch");
  if (claims.rev !== relay.session_revs.get(claims.session)) throw new Error("shadow browser auth rev mismatch");
  if (claims.expires_at <= Date.now()) throw new Error("shadow browser auth token is expired");
  return claims;
}

function assertShadowLiveEventIsEphemeral(value: unknown): asserts value is ShadowLiveEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shadow live event must be an object");
  // Live-plane frames are display hints only. Rejecting the named durability
  // fields at decode keeps callers from smuggling committed-write shapes through
  // the same single-socket channel.
  for (const field of SHADOW_LIVE_DURABILITY_RESERVED_FIELDS) {
    if (field in value) throw new Error(`shadow live event carries durability-reserved field: ${field}`);
  }
}

function rememberShadowBrowserAcceptedFrame(
  relay: ShadowBrowserRelayShim,
  accepted: ShadowCommitAccepted,
  transcript: EffectTranscript
): void {
  if (!relay.accepted_frames.some((frame) => frame.id === accepted.id && frame.position.hash === accepted.position.hash)) {
    relay.accepted_frames.push(structuredClone(accepted) as ShadowCommitAccepted);
    relay.accepted_frames.sort((a, b) => a.position.seq - b.position.seq || String(a.id ?? "").localeCompare(String(b.id ?? "")));
  }
  if (!relay.transcript_tail.some((item) => item.hash === transcript.hash)) {
    relay.transcript_tail.push(structuredClone(transcript) as EffectTranscript);
  }
}

function signShadowBrowserStateTransfer(
  transfer: Omit<ShadowProjectionTransfer, "proof"> | Omit<ShadowDeltaTransfer, "proof">,
  signing: ShadowBrowserStateSigning,
  recipient: string
): ShadowBrowserStateProof {
  // Browser projection/delta state is signed by the relay shim rather than by
  // the execution anchor. This is still shadow-local authority, but unlike a
  // checksum it binds the payload to a trusted relay key and recipient node.
  const root = shadowBrowserStateTransferRoot(transfer, { recipient });
  return {
    kind: "woo.state_proof.shadow.v1",
    scheme: "shadow.relay_mac.v1",
    authority: signing.authority,
    key_id: signing.key_id,
    recipient,
    mode: transfer.mode,
    scope: transfer.scope,
    head: structuredClone(transfer.to) as ShadowCommitAccepted["position"],
    root,
    signature: shadowBrowserStateSignature(root, signing.secret)
  };
}

function shadowBrowserStateTransferRoot(
  transfer: Omit<ShadowProjectionTransfer, "proof"> | Omit<ShadowDeltaTransfer, "proof"> | ShadowProjectionTransfer | ShadowDeltaTransfer,
  proof: Pick<ShadowBrowserStateProof, "recipient">
): string {
  // The proof root names only projection/delta cache material. Transcript body
  // hashes are recomputed during verification before this root is trusted.
  const material = {
    kind: "woo.browser_state_proof_material.shadow.v1",
    mode: transfer.mode,
    scope: transfer.scope,
    recipient: proof.recipient,
    head: transfer.to,
    projection: transfer.projection,
    applied: transfer.mode === "delta" ? transfer.applied.map((frame) => ({
      id: frame.id,
      position: frame.position,
      transcript_hash: frame.transcript_hash,
      post_state_hash: frame.post_state_hash
    })) : [],
    transcript_hashes: transfer.mode === "delta" ? transfer.transcript_tail.map((transcript) => transcript.hash) : []
  };
  return hashSource(stableShadowJson(material as unknown as WooValue));
}

function verifyShadowBrowserStateTransfer(browser: ShadowBrowserNode, transfer: ShadowBrowserStateTransfer): void {
  if (transfer.mode !== "projection" && transfer.mode !== "delta") return;
  // Verification is intentionally before cache install: transcript bodies must
  // match their hashes, then the relay MAC must match a trusted authority.
  verifyShadowBrowserTranscriptHashes(transfer);
  const expectedRoot = shadowBrowserStateTransferRoot(transfer, transfer.proof);
  if (transfer.proof.scope !== transfer.scope || transfer.proof.mode !== transfer.mode) {
    throw new Error("shadow browser state proof scope/mode mismatch");
  }
  if (transfer.proof.recipient !== "*" && transfer.proof.recipient !== browser.node) {
    throw new Error(`shadow browser state proof recipient mismatch: proof=${transfer.proof.recipient} node=${browser.node}`);
  }
  const secret = browser.trusted_state_authorities.get(transfer.proof.authority);
  if (!secret) throw new Error(`untrusted shadow browser state authority: ${transfer.proof.authority}`);
  if (!constantTimeEqual(expectedRoot, transfer.proof.root)) throw new Error("shadow browser state proof root mismatch");
  const signature = shadowBrowserStateSignature(expectedRoot, secret);
  if (!constantTimeEqual(signature, transfer.proof.signature)) throw new Error("shadow browser state proof signature mismatch");
}

function verifyShadowBrowserTranscriptHashes(transfer: ShadowProjectionTransfer | ShadowDeltaTransfer): void {
  if (transfer.mode !== "delta") return;
  const transcriptHashes = new Set<string>();
  for (const transcript of transfer.transcript_tail) {
    const actual = effectTranscriptHash(transcript);
    if (actual !== transcript.hash) throw new Error(`shadow browser transcript hash mismatch: ${transcript.id}`);
    transcriptHashes.add(transcript.hash);
  }
  for (const applied of transfer.applied) {
    if (!transcriptHashes.has(applied.transcript_hash)) {
      throw new Error(`shadow browser applied transcript missing: ${applied.id}`);
    }
  }
}

function effectTranscriptHash(transcript: EffectTranscript): string {
  const { hash: _hash, ...withoutHash } = transcript;
  return hashSource(stableShadowJson(withoutHash as unknown as WooValue));
}

function shadowBrowserStateSignature(root: string, secret: string): string {
  return hashSource(`shadow.relay_mac.v1:${secret}:${root}`);
}

function assertNeverTransfer(transfer: never): never {
  throw new Error(`unsupported shadow browser state transfer mode: ${(transfer as { mode?: string }).mode}`);
}
