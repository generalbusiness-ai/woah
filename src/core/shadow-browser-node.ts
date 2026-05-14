import type { SerializedObject, SerializedSession, SerializedWorld } from "./repository";
import { createShadowCommitScope, type ShadowCommitAccepted, type ShadowCommitConflict, type ShadowCommitScope } from "./shadow-commit-scope";
import {
  createShadowExecutionNode,
  installShadowCachedObjectRecords,
  shadowObjectRecordHash,
  type ShadowExecutionNode,
  type ShadowStateTransfer,
  type ShadowTurnExecRequest,
  type ShadowTurnExecReply,
  type ShadowTurnExecutionResult
} from "./shadow-turn-exec";
import { shadowStatePageHash, shadowStatePagesForObject, type ShadowStatePage } from "./shadow-state-pages";
import { runShadowTurnCall, type ShadowTurnCall } from "./shadow-turn-call";
import { buildShadowTurnExecAd, executeShadowTurnCallAcrossInProcessNetwork, type ShadowInProcessNetworkResult } from "./shadow-turn-network";
import { shadowTurnKeyFromTranscript, type ShadowTurnKey } from "./turn-key";
import type { EffectTranscript } from "./effect-transcript";
import { stableShadowJson } from "./shadow-cell-version";
import { decodeEnvelope, type ShadowEnvelope, type ShadowEnvelopeAuth } from "./shadow-envelope";
import { constantTimeEqual, hashSource } from "./source-hash";
import type { ObjRef, Observation, WooValue } from "./types";
import { cloneValue } from "./types";
import type { ScopedObjectSummary } from "./world";

const DEFAULT_SHADOW_BROWSER_STATE_AUTHORITY = "shadow-relay";
const DEFAULT_SHADOW_BROWSER_STATE_KEY_ID = "shadow-browser-dev";
const DEFAULT_SHADOW_BROWSER_STATE_SECRET = "shadow-browser-dev-secret";
const DEFAULT_SHADOW_DEPLOYMENT = "shadow-local";
const MIN_SHADOW_IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1000;
// Shadow retention caps keep the prototype from growing per-scope/per-browser
// arrays without bound. Production can tune these once VTN17 compaction policy
// is formalized, but unbounded tails are never acceptable on the hot path.
export const MAX_SHADOW_IDEMPOTENCY_ENTRIES = 10_000;
export const MAX_SHADOW_RECENT_REPLIES_ENTRIES = 10_000;
export const MAX_SHADOW_ACCEPTED_TAIL = 1_000;
export const MAX_SHADOW_TRANSCRIPT_TAIL = 1_000;
const MAX_SHADOW_LIVE_EVENTS = 500;
const MAX_SHADOW_BROWSER_TRANSFERS = 200;
const MAX_SHADOW_BROWSER_CACHE_TAIL = 1_000;
const MAX_SHADOW_BROWSER_CONFLICTS = 200;
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
  projection: ShadowScopeProjection;
  proof: ShadowBrowserStateProof;
};

export type ShadowDeltaTransfer = {
  kind: "woo.state.transfer.shadow.v1";
  mode: "delta";
  scope: ObjRef;
  to: ShadowCommitAccepted["position"];
  applied: ShadowCommitAccepted[];
  transcript_tail: EffectTranscript[];
  projection: ShadowScopeProjection;
  proof: ShadowBrowserStateProof;
};

export type ShadowScopeProjection = {
  kind: "woo.scope_projection.shadow.v1";
  scope: ObjRef;
  title: string;
  object_count: number;
  contents: ObjRef[];
  seq: number;
  cursor: { spaces: Record<ObjRef, { next_seq: number }>; live: { resumable: false } };
  viewer?: { actor: ObjRef; session?: string | null };
  self?: ScopedObjectSummary | null;
  session?: {
    id: string;
    actor: ObjRef;
    current_location: ObjRef | null;
    all_locations: ObjRef[];
  } | null;
  inventory?: ScopedObjectSummary[];
  subject: ScopedObjectSummary | null;
  objects: ScopedObjectSummary[];
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
  state_pages: Map<string, ShadowStatePage>;
  state_page_refs: Map<string, string>;
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
  recently_seen: Map<string, number>;
  recent_replies: Map<string, ShadowEnvelope>;
  live_session_serialized: Map<string, SerializedWorld>;
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
  next_envelope: number;
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

export type ShadowBrowserSessionAuth = {
  session_auth: Map<string, ShadowBrowserSessionClaims>;
  session_revs: Map<string, number>;
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

export type ShadowBrowserEnvelopeReceipt<T = WooValue> = {
  envelope: ShadowEnvelope<T>;
  fresh: boolean;
  idempotency_key: string;
};

export type ShadowBrowserOpenScopeResult = {
  projection: WooValue;
  transfer: ShadowProjectionTransfer | ShadowDeltaTransfer;
  preseeded_objects: number;
  transfer_mode: "projection" | "delta";
};

export type ShadowBrowserOpenScopeOptions = {
  preseed_catalog_pages?: boolean;
  last_known_head?: ShadowCommitAccepted["position"];
};

type ShadowProjectionViewer = {
  actor: ObjRef;
  session?: string | null;
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

export type ShadowTurnIntentRequest = {
  kind: "woo.turn.intent.request.shadow.v1";
  id?: string;
  route: ShadowTurnCall["route"];
  scope: ObjRef;
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
  const deployment = input.deployment ?? DEFAULT_SHADOW_DEPLOYMENT;
  const auth = buildShadowBrowserSessionAuth({
    sessions: input.serialized.sessions,
    scope: input.scope,
    deployment,
    session_revs: input.session_revs
  });
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
    session_auth: auth.session_auth,
    session_revs: auth.session_revs,
    idempotency_window_ms: Math.max(input.idempotency_window_ms ?? MIN_SHADOW_IDEMPOTENCY_WINDOW_MS, MIN_SHADOW_IDEMPOTENCY_WINDOW_MS),
    recently_seen: new Map(),
    recent_replies: new Map(),
    live_session_serialized: new Map(),
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

export function buildShadowBrowserSessionAuth(input: {
  sessions: SerializedSession[];
  scope: ObjRef;
  deployment?: string;
  session_revs?: Record<string, number>;
}): ShadowBrowserSessionAuth {
  // Session auth is intentionally derivable from the gateway's narrow session
  // export. Commit-scope relays can refresh token authority without rebuilding
  // execution state or receiving the full world over the transport boundary.
  const deployment = input.deployment ?? DEFAULT_SHADOW_DEPLOYMENT;
  const sessionRevs = shadowBrowserSessionRevs(input.sessions, input.session_revs);
  return {
    session_auth: shadowBrowserSessionClaims(input.sessions, input.scope, deployment, sessionRevs),
    session_revs: sessionRevs
  };
}

export function mergeShadowBrowserSessionState(current: SerializedSession[], fresh: SerializedSession[]): SerializedSession[] {
  const mergedById = new Map<string, SerializedSession>(
    current.map((session) => [session.id, structuredClone(session) as SerializedSession])
  );
  for (const session of fresh) {
    const existing = mergedById.get(session.id);
    const merged = structuredClone(session) as SerializedSession;
    // The gateway owns session identity, expiry, and revocation. A commit scope
    // owns the v2-committed session location for turns in that scope; replacing
    // it from the stale gateway snapshot would make a freshly-entered browser
    // fail the next presence gate.
    if (existing && existing.actor === session.actor && existing.currentLocation !== undefined) {
      merged.currentLocation = existing.currentLocation;
    }
    mergedById.set(session.id, merged);
  }
  return Array.from(mergedById.values()).sort((a, b) => a.id.localeCompare(b.id));
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
  const sessionToken = input.session ? shadowBrowserSessionBearer({
    id: input.session,
    actor: input.actor
  }) : null;
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
    next_live: 1,
    next_envelope: 1
  };
}

export function createShadowBrowserClient(input: Parameters<typeof createShadowBrowserNode>[0] & { token: string }): ShadowBrowserNode {
  // Wire/dev clients all need the same pair of operations: create the browser
  // node against an existing relay, then replace the deterministic shadow-local
  // bearer with the token presented on the transport.
  const browser = createShadowBrowserNode(input);
  setShadowBrowserSessionToken(browser, input.token);
  return browser;
}

export function setShadowBrowserSessionToken(browser: ShadowBrowserNode, token: string): void {
  // Wire handshakes authenticate with the caller's bearer token, while the
  // shadow shim starts with a local dev token. Replace the registered bearer so
  // subsequent envelope auth has exactly one valid token for this session.
  if (!browser.session_token) throw new Error("shadow browser session auth token is required");
  if (browser.session_token === token) return;
  const claims = browser.relay.session_auth.get(browser.session_token);
  if (!claims) throw new Error(`shadow browser session auth token is unknown: ${browser.session_token} session=${browser.session ?? "none"}`);
  browser.relay.session_auth.delete(browser.session_token);
  browser.relay.session_auth.set(token, claims);
  browser.session_token = token;
}

export function createShadowBrowserNodeCache(): ShadowBrowserNodeCache {
  return {
    kind: "woo.browser_cache.shadow.v1",
    object_pages: new Map(),
    object_page_refs: new Map(),
    state_pages: new Map(),
    state_page_refs: new Map(),
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
  const transfer = buildShadowBrowserCatchupTransfer(browser.relay, browser.scope, browser.node, options.last_known_head, shadowProjectionViewer(browser));
  applyShadowBrowserTransfer(browser, transfer);
  return {
    projection: transfer.projection,
    transfer,
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

export function disposeShadowBrowserNode(browser: ShadowBrowserNode, scope: ObjRef = browser.scope): void {
  unsubscribeShadowBrowserNode(browser, scope);
  browser.relay.browsers.delete(browser.node);
  if (browser.session_token) browser.relay.session_auth.delete(browser.session_token);
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

export function shadowLiveEventsForTranscript(browser: ShadowBrowserNode, transcript: EffectTranscript): ShadowLiveEvent[] {
  return transcript.observations.map((observation, index) => {
    const actor = typeof observation?.actor === "string" ? observation.actor : transcript.call.actor;
    const scope = transcript.scope;
    const coalesce = typeof observation?.coalesce_key === "string" ? observation.coalesce_key : undefined;
    return {
      kind: "woo.live.event.shadow.v1",
      id: `${browser.relay.node}:live:${transcript.hash}:${index}`,
      source: shadowLiveEventSource(observation, transcript),
      actor,
      scope,
      audience: { scope },
      observation,
      ...(coalesce ? { coalesce } : {})
    };
  });
}

function shadowLiveEventSource(observation: Observation, transcript: EffectTranscript): ObjRef {
  for (const key of ["source", "target"] as const) {
    const value = observation?.[key];
    if (typeof value === "string") return value;
  }
  return transcript.call.target;
}

export function publishShadowBrowserLiveEvent(
  relay: ShadowBrowserRelayShim,
  event: ShadowLiveEvent,
  options: { except?: string | null } = {}
): void {
  relay.live_events.push(structuredClone(event) as ShadowLiveEvent);
  trimArrayHead(relay.live_events, MAX_SHADOW_LIVE_EVENTS);
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
  trimArrayHead(browser.cache.live_events, MAX_SHADOW_LIVE_EVENTS);
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
    kind: "woo.turn.exec.request.shadow.v1",
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
    else {
      browser.cache.transcript_tail.push(network.result.transcript);
      trimArrayHead(browser.cache.transcript_tail, MAX_SHADOW_BROWSER_CACHE_TAIL);
    }
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

export function buildShadowBrowserProjectionTransfer(
  relay: ShadowBrowserRelayShim,
  scope: ObjRef,
  recipient = "*",
  viewer?: ShadowProjectionViewer
): ShadowProjectionTransfer {
  // Projection transfer replaces direct cache mutation on scope-open so display
  // state obeys the same recipient-bound relay authority check as deltas.
  const transfer = {
    kind: "woo.state.transfer.shadow.v1",
    mode: "projection",
    scope,
    to: structuredClone(relay.commit_scope.head) as ShadowCommitAccepted["position"],
    projection: shadowScopeProjection(relay.commit_scope.serialized, scope, relay.commit_scope.head.seq, viewer)
  } satisfies Omit<ShadowProjectionTransfer, "proof">;
  return { ...transfer, proof: signShadowBrowserStateTransfer(transfer, relay.state_signing, recipient) };
}

export function buildShadowBrowserDeltaTransfer(
  relay: ShadowBrowserRelayShim,
  accepted: ShadowCommitAccepted,
  transcript: EffectTranscript,
  recipient = "*",
  viewer?: ShadowProjectionViewer
): ShadowDeltaTransfer {
  return buildShadowBrowserDeltaTransferFromFrames(relay, [accepted], [transcript], recipient, viewer);
}

export function buildShadowBrowserDeltaTransferFromFrames(
  relay: ShadowBrowserRelayShim,
  acceptedFrames: ShadowCommitAccepted[],
  transcripts: EffectTranscript[],
  recipient = "*",
  viewer?: ShadowProjectionViewer
): ShadowDeltaTransfer {
  if (acceptedFrames.length === 0) throw new Error("shadow browser delta requires at least one accepted frame");
  const scope = acceptedFrames[0].position.scope;
  for (const frame of acceptedFrames) {
    if (frame.position.scope !== scope) throw new Error("shadow browser delta frames must share a scope");
  }
  const ordered = [...acceptedFrames].sort((a, b) => a.position.seq - b.position.seq);
  const transcriptByHash = new Map(transcripts.map((transcript) => [transcript.hash, transcript]));
  const orderedTranscripts = ordered.map((frame) => {
    const transcript = transcriptByHash.get(frame.transcript_hash);
    if (!transcript) throw new Error(`shadow browser delta missing transcript: ${frame.id}`);
    return transcript;
  });
  // Delta transfer carries the committed frame plus transcript tail needed by
  // browser caches to catch up without receiving executable closure state.
  const transfer = {
    kind: "woo.state.transfer.shadow.v1",
    mode: "delta",
    scope,
    to: structuredClone(ordered[ordered.length - 1].position) as ShadowCommitAccepted["position"],
    applied: ordered.map((frame) => structuredClone(frame) as ShadowCommitAccepted),
    transcript_tail: orderedTranscripts.map((transcript) => structuredClone(transcript) as EffectTranscript),
    projection: shadowScopeProjection(relay.commit_scope.serialized, scope, ordered[ordered.length - 1].position.seq, viewer)
  } satisfies Omit<ShadowDeltaTransfer, "proof">;
  return { ...transfer, proof: signShadowBrowserStateTransfer(transfer, relay.state_signing, recipient) };
}

export function buildShadowBrowserCatchupTransfer(
  relay: ShadowBrowserRelayShim,
  scope: ObjRef,
  recipient: string,
  lastKnownHead?: ShadowCommitAccepted["position"],
  viewer?: ShadowProjectionViewer
): ShadowProjectionTransfer | ShadowDeltaTransfer {
  if (lastKnownHead && lastKnownHead.scope === scope && lastKnownHead.epoch === relay.commit_scope.head.epoch && lastKnownHead.seq < relay.commit_scope.head.seq) {
    const accepted = relay.accepted_frames
      .filter((frame) => frame.position.scope === scope && frame.position.seq > lastKnownHead.seq && frame.position.seq <= relay.commit_scope.head.seq)
      .sort((a, b) => a.position.seq - b.position.seq);
    const expectedSeqs = new Set(Array.from({ length: relay.commit_scope.head.seq - lastKnownHead.seq }, (_item, index) => lastKnownHead.seq + index + 1));
    const hasContiguousTail = accepted.length === expectedSeqs.size && accepted.every((frame) => expectedSeqs.has(frame.position.seq));
    const transcripts = accepted.map((frame) => relay.transcript_tail.find((item) => item.hash === frame.transcript_hash));
    if (hasContiguousTail && transcripts.every((item): item is EffectTranscript => Boolean(item))) {
      return buildShadowBrowserDeltaTransferFromFrames(relay, accepted, transcripts, recipient, viewer);
    }
  }
  return buildShadowBrowserProjectionTransfer(relay, scope, recipient, viewer);
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
    const transfer = buildShadowBrowserDeltaTransfer(relay, accepted, transcript, browser.node, shadowProjectionViewer(browser));
    applyShadowBrowserTransfer(browser, transfer);
  }
}

export function purgeShadowBrowserRelayHistory(relay: ShadowBrowserRelayShim, scope: ObjRef, throughSeq = Number.POSITIVE_INFINITY): void {
  // Test and reconnect harnesses use this to model a relay whose short catch-up
  // tail expired while the authoritative commit scope kept advancing.
  relay.accepted_frames = relay.accepted_frames.filter((frame) => frame.position.scope !== scope || frame.position.seq > throughSeq);
  relay.transcript_tail = relay.transcript_tail.filter((transcript) => transcript.scope !== scope || transcript.seq > throughSeq);
}

export function shadowBrowserEnvelope<T>(
  browser: ShadowBrowserNode,
  type: string,
  body: T,
  id = `${browser.node}:env:${browser.next_envelope++}`
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
  return receiveShadowBrowserEnvelopeReceipt(browser, encoded).envelope;
}

export function receiveShadowBrowserEnvelopeReceipt(browser: ShadowBrowserNode, encoded: string): ShadowBrowserEnvelopeReceipt {
  const envelope = decodeEnvelope(encoded);
  validateShadowBrowserEnvelopeAuth(browser.relay, browser, envelope);
  // The receipt exposes freshness to callers that perform side-effecting
  // request dispatch after decode; duplicate envelopes must authenticate and
  // decode successfully but must not execute a second turn.
  const { fresh, key } = markShadowBrowserEnvelopeSeen(browser.relay, envelope);
  if (!fresh) return { envelope, fresh, idempotency_key: key };
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
  // Types without a built-in dispatch arm are returned for caller-level
  // handling; the codec has already checked that they are known wire types.
  return { envelope, fresh, idempotency_key: key };
}

export async function handleShadowBrowserTurnExecEnvelope(
  browser: ShadowBrowserNode,
  receipt: ShadowBrowserEnvelopeReceipt
): Promise<ShadowEnvelope<ShadowTurnExecReply> | null> {
  // Keep wire turn-exec dispatch in the substrate so dev-server, Worker, and
  // future socket bindings share the same duplicate handling and reply shape.
  if (receipt.envelope.type !== "woo.turn.exec.request.shadow.v1" && receipt.envelope.type !== "woo.turn.intent.request.shadow.v1") return null;
  if (!receipt.fresh) {
    const cached = browser.relay.recent_replies.get(receipt.idempotency_key);
    return cached ? structuredClone(cached) as ShadowEnvelope<ShadowTurnExecReply> : null;
  }
  const intent = receipt.envelope.type === "woo.turn.intent.request.shadow.v1"
    ? receipt.envelope.body as ShadowTurnIntentRequest
    : null;
  const request = intent
    ? await shadowTurnExecRequestFromIntent(browser, intent)
    : receipt.envelope.body as ShadowTurnExecRequest;
  const reply = intent?.commit_policy === "execute_only"
    ? await executeShadowBrowserExecuteOnlyIntent(browser, request)
    : (await executeShadowBrowserTurnExecRequest(browser, request)).reply;
  if (!reply) return null;
  const response = shadowBrowserTurnExecReplyEnvelope(browser, receipt, request, reply);
  // Idempotency is reply-oriented: a client retrying because it missed the
  // first reply must receive the same answer without re-running the turn.
  browser.relay.recent_replies.set(receipt.idempotency_key, structuredClone(response));
  trimShadowBrowserIdempotency(browser.relay);
  return response;
}

function shadowBrowserTurnExecReplyEnvelope(
  browser: ShadowBrowserNode,
  receipt: ShadowBrowserEnvelopeReceipt,
  request: ShadowTurnExecRequest,
  reply: ShadowTurnExecReply
): ShadowEnvelope<ShadowTurnExecReply> {
  const body = shadowBrowserWireTurnExecReply(reply);
  const envelope: ShadowEnvelope<ShadowTurnExecReply> = {
    v: 2,
    type: body.kind,
    id: `${browser.relay.node}:reply:${request.id ?? request.call.id ?? receipt.envelope.id}`,
    from: browser.relay.node,
    to: browser.node,
    actor: browser.actor,
    ...(browser.session ? { session: browser.session } : {}),
    reply_to: receipt.envelope.id,
    auth: shadowBrowserAuth(browser),
    body
  };
  return envelope;
}

async function executeShadowBrowserExecuteOnlyIntent(browser: ShadowBrowserNode, request: ShadowTurnExecRequest): Promise<ShadowTurnExecReply> {
  validateShadowBrowserNodeAuth(browser);
  // Server-assisted browser intents already have a deterministic planned
  // transcript. Execute-only turns are live/direct surface updates, so keep a
  // per-session live snapshot separate from the committed scope. That lets
  // direct gestures chain (for example Dubspace enter -> local control command)
  // without making the next authority-bearing commit validate against live-only
  // state.
  const sessionKey = request.call.session ?? request.call.actor;
  const serializedBefore = browser.relay.live_session_serialized.get(sessionKey) ?? browser.relay.commit_scope.serialized;
  const run = await runShadowTurnCall(serializedBefore, request.call);
  browser.relay.live_session_serialized.set(sessionKey, run.serializedAfter);
  for (const event of shadowLiveEventsForTranscript(browser, run.transcript)) {
    publishShadowBrowserLiveEvent(browser.relay, event, { except: browser.node });
  }
  const outcome = run.transcript.error
    ? { error: run.transcript.error as unknown as WooValue }
    : { result: run.transcript.result };
  return {
    kind: "woo.turn.exec.reply.shadow.v1",
    ok: true,
    id: request.id ?? request.call.id,
    outcome,
    transcript: run.transcript
  };
}

async function shadowTurnExecRequestFromIntent(browser: ShadowBrowserNode, intent: ShadowTurnIntentRequest): Promise<ShadowTurnExecRequest> {
  // Browser-local planning is the end-state, but early browser parity needs a
  // safe outbound path before the worker can reconstruct executable closures.
  // Server-assisted planning still records a deterministic transcript and
  // turns it into the same ShadowTurnKey that a local browser planner will
  // submit later.
  const id = intent.id ?? `${browser.node}:intent:${browser.next_turn++}`;
  const call: ShadowTurnCall = {
    kind: "woo.turn_call.shadow.v1",
    id,
    route: intent.route,
    scope: intent.scope,
    session: browser.session,
    actor: browser.actor,
    target: intent.target,
    verb: intent.verb,
    args: intent.args ?? []
  };
  const serialized = intent.commit_policy === "execute_only"
    ? browser.relay.live_session_serialized.get(call.session ?? call.actor) ?? browser.relay.commit_scope.serialized
    : browser.relay.commit_scope.serialized;
  const planned = await runShadowTurnCall(serialized, call);
  return {
    kind: "woo.turn.exec.request.shadow.v1",
    id,
    call,
    key: shadowTurnKeyFromTranscript(planned.transcript),
    expected: browser.relay.commit_scope.head,
    commit_policy: intent.commit_policy ?? "execute_and_commit"
  };
}

async function executeShadowBrowserTurnExecRequest(
  browser: ShadowBrowserNode,
  request: ShadowTurnExecRequest
): Promise<ShadowTurnExecutionResult> {
  validateShadowBrowserNodeAuth(browser);
  const executor = shadowRelayExecutorForRequest(browser.relay, request);
  const network = await executeShadowTurnCallAcrossInProcessNetwork({
    request,
    nodes: browser.relay.executors,
    // Wire clients already submit the planned turn key. The relay executor is
    // scope-local and stateful, so server dispatch should execute that request
    // directly instead of rebuilding a browser-origin planning turn first.
    ads: [buildShadowTurnExecAd({ node: executor.node, scope: request.key.scope, key: request.key, factor: 0.1 })],
    anchor: {
      node: browser.relay.node,
      serialized: browser.relay.commit_scope.serialized
    },
    commitScope: browser.relay.commit_scope
  });

  for (const transfer of network.transfers) applyShadowBrowserTransfer(browser, transfer);
  if (network.result.ok) {
    if (network.result.commit) publishShadowBrowserAcceptedFrame(browser.relay, network.result.commit, network.result.transcript);
    else {
      browser.cache.transcript_tail.push(network.result.transcript);
      trimArrayHead(browser.cache.transcript_tail, MAX_SHADOW_BROWSER_CACHE_TAIL);
    }
  } else if (network.result.reason === "commit_rejected" && network.result.commit) {
    applyShadowBrowserConflict(browser, network.result.commit);
  }
  return network.result;
}

function shadowRelayExecutorForRequest(relay: ShadowBrowserRelayShim, request: ShadowTurnExecRequest): ShadowExecutionNode {
  const nodeId = `${relay.node}:executor`;
  let executor = relay.executors.find((node) => node.node === nodeId);
  if (!executor) {
    executor = createShadowExecutionNode({
      node: nodeId,
      scope: request.key.scope,
      serialized: relay.commit_scope.serialized,
      atom_hashes: request.key.atom_hashes
    });
    relay.executors.push(executor);
  } else {
    // The relay executor is reused across socket lifetimes, while the commit
    // scope's serialized session slice can refresh between turns. Rebuild the
    // executor world from the current committed snapshot before planning or an
    // old cached world can reject a freshly accepted session before recording.
    executor.serialized = structuredClone(relay.commit_scope.serialized);
    executor.world = undefined;
  }
  // The relay executor has the authoritative scope state locally. The atom set
  // still gates the actual execution against the client's planned key; missing
  // actual atoms trigger the normal state-plane retry path.
  for (const hash of request.key.atom_hashes) executor.atom_hashes.add(hash);
  return executor;
}

function shadowBrowserWireTurnExecReply(reply: ShadowTurnExecReply): ShadowTurnExecReply {
  return structuredClone(reply) as ShadowTurnExecReply;
}

export function applyShadowBrowserAcceptedFrame(browser: ShadowBrowserNode, accepted: ShadowCommitAccepted): void {
  if (browser.cache.applied_frames.some((frame) => frame.id === accepted.id && frame.position.hash === accepted.position.hash)) return;
  browser.cache.applied_frames.push(accepted);
  trimArrayHead(browser.cache.applied_frames, MAX_SHADOW_BROWSER_CACHE_TAIL);
  browser.cache.projections.set(browser.scope, shadowScopeProjection(browser.relay.commit_scope.serialized, browser.scope, accepted.position.seq, shadowProjectionViewer(browser)));
}

export function applyShadowBrowserConflict(browser: ShadowBrowserNode, conflict: ShadowCommitConflict): void {
  browser.cache.conflicts.push(conflict);
  trimArrayHead(browser.cache.conflicts, MAX_SHADOW_BROWSER_CONFLICTS);
}

export function applyShadowBrowserTransfer(browser: ShadowBrowserNode, transfer: ShadowBrowserStateTransfer): void {
  verifyShadowBrowserStateTransfer(browser, transfer);
  browser.cache.transfers.push(structuredClone(transfer) as ShadowBrowserStateTransfer);
  trimArrayHead(browser.cache.transfers, MAX_SHADOW_BROWSER_TRANSFERS);
  switch (transfer.mode) {
    case "projection":
      browser.cache.projections.set(transfer.scope, structuredClone(transfer.projection) as WooValue);
      reconcileProjectionFallbackCache(browser, transfer);
      return;
    case "delta":
      browser.cache.projections.set(transfer.scope, structuredClone(transfer.projection) as WooValue);
      for (const transcript of transfer.transcript_tail) {
        if (!browser.cache.transcript_tail.some((item) => item.hash === transcript.hash)) {
          browser.cache.transcript_tail.push(structuredClone(transcript) as EffectTranscript);
          trimArrayHead(browser.cache.transcript_tail, MAX_SHADOW_BROWSER_CACHE_TAIL);
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
    case "cell_pages":
      // Cell-page transfers carry content-addressed page records sized below
      // a full object_record; the cache stores them so later turns can install
      // by ref instead of re-shipping the full page payload.
      cacheStatePages(browser.cache, transfer.inline_pages);
      return;
  }
  assertNeverTransfer(transfer);
}

function cacheObjectPages(cache: ShadowBrowserNodeCache, objects: SerializedObject[]): void {
  for (const obj of objects) {
    const hash = shadowObjectRecordHash(obj);
    cache.object_pages.set(hash, structuredClone(obj) as SerializedObject);
    cache.object_page_refs.set(obj.id, hash);
    cacheStatePages(cache, shadowStatePagesForObject(obj));
  }
}

function cacheStatePages(cache: ShadowBrowserNodeCache, pages: ShadowStatePage[]): void {
  for (const page of pages) {
    const hash = shadowStatePageHash(page);
    cache.state_pages.set(hash, structuredClone(page) as ShadowStatePage);
    cache.state_page_refs.set(`${page.object}:${page.page}:${"name" in page ? page.name : ""}`, hash);
  }
}

function shadowProjectionViewer(browser: ShadowBrowserNode): ShadowProjectionViewer {
  return { actor: browser.actor, session: browser.session };
}

function shadowScopeProjection(
  serialized: SerializedWorld,
  scope: ObjRef,
  seqOverride?: number,
  viewer?: ShadowProjectionViewer
): ShadowScopeProjection {
  const index = shadowSerializedIndex(serialized);
  const scopeObj = index.objects.get(scope);
  const session = viewer?.session ? index.sessions.get(viewer.session) : undefined;
  const actorObj = viewer?.actor ? index.objects.get(viewer.actor) : undefined;
  const subject = scopeObj ? shadowSerializedObjectSummary(index, scopeObj, viewer?.actor) : null;
  const self = actorObj ? shadowSerializedObjectSummary(index, actorObj, viewer?.actor) : null;
  const inventory = (actorObj?.contents ?? [])
    .map((id) => {
      const obj = index.objects.get(id);
      return obj ? shadowSerializedObjectSummary(index, obj, viewer?.actor) : null;
    })
    .filter((item): item is ScopedObjectSummary => item !== null);
  const objects = shadowProjectionRefs(index, scope, viewer)
    .map((id) => {
      const obj = index.objects.get(id);
      return obj ? shadowSerializedObjectSummary(index, obj, viewer?.actor) : null;
    })
    .filter((item): item is ScopedObjectSummary => item !== null);
  const seq = seqOverride ?? serialized.logs.find(([space]) => space === scope)?.[1].reduce((max, entry) => Math.max(max, entry.seq), 0) ?? 0;
  return {
    kind: "woo.scope_projection.shadow.v1",
    scope,
    title: scopeObj?.name ?? scope,
    object_count: serialized.objects.length,
    contents: scopeObj?.contents ?? [],
    seq,
    cursor: { spaces: { [scope]: { next_seq: seq + 1 } }, live: { resumable: false } },
    ...(viewer ? { viewer } : {}),
    ...(viewer ? {
      self,
      session: viewer.session ? {
        id: viewer.session,
        actor: viewer.actor,
        current_location: session?.currentLocation ?? null,
        all_locations: session?.currentLocation ? [session.currentLocation] : []
      } : null,
      inventory
    } : {}),
    subject,
    objects
  };
}

type ShadowSerializedIndex = {
  objects: Map<ObjRef, SerializedObject>;
  sessions: Map<string, SerializedSession>;
};

function shadowSerializedIndex(serialized: SerializedWorld): ShadowSerializedIndex {
  return {
    objects: new Map(serialized.objects.map((obj) => [obj.id, obj])),
    sessions: new Map(serialized.sessions.map((session) => [session.id, session]))
  };
}

function shadowProjectionRefs(index: ShadowSerializedIndex, scope: ObjRef, viewer?: ShadowProjectionViewer): ObjRef[] {
  // The state-plane projection exports a generic neighborhood instead of
  // client/catalog-specific panels: visible subject, subject contents, viewer,
  // inventory, and current location. Catalog UI can derive its own state from
  // readable props on those summaries.
  const refs = new Set<ObjRef>();
  const pushObject = (id: ObjRef | null | undefined): void => {
    if (!id || !index.objects.has(id)) return;
    refs.add(id);
  };
  const pushContents = (id: ObjRef | null | undefined): void => {
    if (!id) return;
    for (const content of index.objects.get(id)?.contents ?? []) pushObject(content);
  };
  pushObject(scope);
  pushContents(scope);
  if (viewer) {
    pushObject(viewer.actor);
    pushContents(viewer.actor);
    const session = viewer.session ? index.sessions.get(viewer.session) : undefined;
    pushObject(session?.currentLocation ?? null);
    pushContents(session?.currentLocation ?? null);
  }
  return Array.from(refs);
}

function shadowSerializedObjectSummary(index: ShadowSerializedIndex, obj: SerializedObject, actor?: ObjRef): ScopedObjectSummary {
  const props = shadowReadableProps(index, obj, actor);
  const aliases = props.aliases;
  return {
    id: obj.id,
    name: obj.name,
    parent: obj.parent,
    ancestors: shadowAncestors(index, obj.id),
    owner: obj.owner,
    location: obj.location,
    ...(Array.isArray(aliases) && aliases.every((item) => typeof item === "string") ? { aliases } : {}),
    description: props.description ?? null,
    props
  };
}

function shadowAncestors(index: ShadowSerializedIndex, objRef: ObjRef): ObjRef[] {
  const ancestors: ObjRef[] = [];
  let current = index.objects.get(objRef)?.parent ?? null;
  const seen = new Set<ObjRef>();
  while (current && !seen.has(current)) {
    ancestors.push(current);
    seen.add(current);
    current = index.objects.get(current)?.parent ?? null;
  }
  return ancestors.reverse();
}

function shadowReadableProps(index: ShadowSerializedIndex, obj: SerializedObject, actor?: ObjRef): Record<string, WooValue> {
  const props: Record<string, WooValue> = {};
  for (const name of shadowPropertyNames(index, obj.id)) {
    const resolved = shadowPropertyValue(index, obj.id, name);
    if (!resolved || resolved.value === undefined) continue;
    if (!shadowCanReadProperty(index, actor, resolved.owner, resolved.perms)) continue;
    props[name] = cloneValue(resolved.value);
  }
  return props;
}

function shadowPropertyNames(index: ShadowSerializedIndex, objRef: ObjRef): string[] {
  const names = new Set<string>();
  let current = index.objects.get(objRef) ?? null;
  const seen = new Set<ObjRef>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    for (const def of current.propertyDefs) names.add(def.name);
    for (const [name] of current.properties) names.add(name);
    current = current.parent ? index.objects.get(current.parent) ?? null : null;
  }
  return Array.from(names).sort();
}

function shadowPropertyValue(
  index: ShadowSerializedIndex,
  objRef: ObjRef,
  name: string
): { value: WooValue | undefined; owner: ObjRef; perms: string } | null {
  let current = index.objects.get(objRef) ?? null;
  const seen = new Set<ObjRef>();
  let value: WooValue | undefined;
  let hasValue = false;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (!hasValue) {
      const own = current.properties.find(([prop]) => prop === name);
      if (own) {
        value = own[1];
        hasValue = true;
      }
    }
    const def = current.propertyDefs.find((item) => item.name === name);
    if (def) {
      return { value: hasValue ? value : def.defaultValue, owner: def.owner, perms: def.perms };
    }
    current = current.parent ? index.objects.get(current.parent) ?? null : null;
  }
  return null;
}

function shadowCanReadProperty(index: ShadowSerializedIndex, actor: ObjRef | undefined, owner: ObjRef, perms: string): boolean {
  return Boolean(actor && (index.objects.get(actor)?.flags?.wizard === true || owner === actor)) || String(perms).includes("r");
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
    const token = shadowBrowserSessionBearer(session);
    const rev = sessionRevs.get(session.id) ?? 1;
    claims.set(token, {
      ...shadowBrowserSessionClaimsValue(session, deployment, [scope]),
      rev
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

export function shadowBrowserSessionBearer(session: Pick<SerializedSession, "id" | "actor">): string {
  // Shadow-local bearer only: the relay maps this deterministic token to
  // server-held claims. A real M4 deployment mints a signed gateway token.
  return `shadow-session:${session.id}:${session.actor}`;
}

export function shadowBrowserSessionClaimsValue(
  session: Pick<SerializedSession, "id" | "actor" | "started" | "expiresAt">,
  deployment: string,
  scopes: ObjRef[],
  rev = 1
): ShadowBrowserSessionClaims {
  return {
    session: session.id,
    actor: session.actor,
    deployment,
    issued_at: session.started,
    expires_at: session.expiresAt ?? session.started + 15 * 60 * 1000,
    scopes,
    features: ["shadow-envelope", "shadow-catchup", "shadow-multiplex"],
    rev
  };
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
  // Transport authentication uses wall-clock expiry. It is not a VM logical
  // time input and must not be routed through logicalNow.
  if (claims.expires_at <= Date.now()) throw new Error("shadow browser auth token is expired");
  return claims;
}

function markShadowBrowserEnvelopeSeen(relay: ShadowBrowserRelayShim, envelope: ShadowEnvelope, now = Date.now()): { fresh: boolean; key: string } {
  const cutoff = now - relay.idempotency_window_ms;
  for (const [key, seenAt] of relay.recently_seen) {
    if (seenAt < cutoff) {
      relay.recently_seen.delete(key);
      relay.recent_replies.delete(key);
      continue;
    }
    break;
  }
  const key = shadowBrowserIdempotencyKey(envelope);
  if (relay.recently_seen.has(key)) return { fresh: false, key };
  relay.recently_seen.set(key, now);
  trimShadowBrowserIdempotency(relay);
  return { fresh: true, key };
}

function shadowBrowserIdempotencyKey(envelope: Pick<ShadowEnvelope, "from" | "id">): string {
  return `${envelope.from}\u0000${envelope.id}`;
}

function trimShadowBrowserIdempotency(relay: ShadowBrowserRelayShim): void {
  if (relay.recently_seen.size <= MAX_SHADOW_IDEMPOTENCY_ENTRIES) {
    trimShadowBrowserRecentReplies(relay);
    return;
  }
  // The idempotency window is time-based, but a hot relay also needs a hard
  // entry cap so replay keys and cached replies cannot grow without bound.
  const overflow = relay.recently_seen.size - MAX_SHADOW_IDEMPOTENCY_ENTRIES;
  const oldest = Array.from(relay.recently_seen.entries())
    .sort((a, b) => a[1] - b[1])
    .slice(0, overflow);
  for (const [key] of oldest) {
    relay.recently_seen.delete(key);
    relay.recent_replies.delete(key);
  }
  trimShadowBrowserRecentReplies(relay);
}

function trimShadowBrowserRecentReplies(relay: ShadowBrowserRelayShim): void {
  if (relay.recent_replies.size <= MAX_SHADOW_RECENT_REPLIES_ENTRIES) return;
  // Reply caching has its own cap because some envelope ids are remembered
  // without producing a reply. Keep the newest replies by their seen time so a
  // retry inside the advertised window is most likely to get the cached answer.
  const overflow = relay.recent_replies.size - MAX_SHADOW_RECENT_REPLIES_ENTRIES;
  const oldest = Array.from(relay.recent_replies.keys())
    .sort((a, b) => (relay.recently_seen.get(a) ?? 0) - (relay.recently_seen.get(b) ?? 0))
    .slice(0, overflow);
  for (const key of oldest) relay.recent_replies.delete(key);
}

function reconcileProjectionFallbackCache(browser: ShadowBrowserNode, transfer: ShadowProjectionTransfer): void {
  // A projection fallback means the relay could not provide a contiguous tail
  // from the browser's last head. Keep the display projection, but discard
  // scope-local replay material and optimistic turns that can no longer be
  // reconciled to a proven accepted-frame sequence.
  browser.cache.transcript_tail = browser.cache.transcript_tail.filter((transcript) => transcript.scope !== transfer.scope);
  browser.cache.applied_frames = browser.cache.applied_frames.filter((frame) => frame.position.scope !== transfer.scope);
  for (const [id, pending] of browser.cache.pending_turns) {
    if (pending.key.scope === transfer.scope) browser.cache.pending_turns.delete(id);
  }
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
    trimArrayHead(relay.accepted_frames, MAX_SHADOW_ACCEPTED_TAIL);
  }
  if (!relay.transcript_tail.some((item) => item.hash === transcript.hash)) {
    relay.transcript_tail.push(structuredClone(transcript) as EffectTranscript);
    relay.transcript_tail.sort((a, b) => a.seq - b.seq || a.hash.localeCompare(b.hash));
    trimArrayHead(relay.transcript_tail, MAX_SHADOW_TRANSCRIPT_TAIL);
  }
}

function trimArrayHead<T>(items: T[], max: number): void {
  if (items.length > max) items.splice(0, items.length - max);
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
