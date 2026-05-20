import type { SerializedObject, SerializedSession, SerializedWorld } from "./repository";
import {
  createShadowCommitScope,
  markShadowCommitScopeSerializedChanged,
  transcriptTouchedObjectIds,
  type ShadowCommitAccepted,
  type ShadowCommitConflict,
  type ShadowCommitScope
} from "./shadow-commit-scope";
import {
  buildShadowCellPageTransfer,
  createShadowExecutionNode,
  executeAuthoritativeShadowTurnCall,
  installShadowCachedObjectRecords,
  installShadowStateTransfer,
  shadowObjectRecordHash,
  type ShadowExecutionNode,
  type ShadowMissingAtom,
  type ShadowStateTransfer,
  type ShadowTurnExecRequest,
  type ShadowTurnExecReply,
  type ShadowTurnExecutionResult
} from "./shadow-turn-exec";
import { shadowStatePageHash, shadowStatePagesForObject, type ShadowStatePage } from "./shadow-state-pages";
import { runShadowTurnCall, runShadowTurnCallTranscript, type ShadowTurnCall } from "./shadow-turn-call";
import { buildShadowScopeTurnExecAd, buildShadowTurnExecAd, buildShadowTurnExecAdFromNode, executeShadowTurnCallAcrossInProcessNetwork, type ShadowInProcessNetworkResult } from "./shadow-turn-network";
import { shadowAtomHash, shadowTurnKeyFromTranscript, type ShadowTurnKey } from "./turn-key";
import type { EffectTranscript } from "./effect-transcript";
import type { ShadowCapabilityAd } from "./capability-ad";
import { stableShadowJson } from "./shadow-cell-version";
import { decodeEnvelope, type ShadowEnvelope, type ShadowEnvelopeAuth } from "./shadow-envelope";
import { constantTimeEqual, hashSource } from "./source-hash";
import type { MetricEvent, ObjRef, Observation, PropertyDef, WooValue } from "./types";
import { cloneValue, directedRecipients } from "./types";
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
export const MAX_SHADOW_OPEN_EXECUTABLE_SEED_CACHE = 128;
const MAX_SHADOW_LIVE_EVENTS = 500;
const MAX_SHADOW_BROWSER_TRANSFERS = 200;
const MAX_SHADOW_BROWSER_CACHE_TAIL = 1_000;
const MAX_SHADOW_BROWSER_CONFLICTS = 200;
// The envelope codec rejects frames at 1 MiB. Keep browser state-transfer
// bodies comfortably below that so the surrounding envelope metadata and
// session token cannot push a retained-tail catch-up over the wire limit.
const MAX_SHADOW_BROWSER_TRANSFER_BODY_BYTES = 900 * 1024;
const SHADOW_BROWSER_TRANSFER_ENCODER = new TextEncoder();
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
  projection?: ShadowScopeProjection;
  projection_patch?: ShadowScopeProjectionPatch;
  proof: ShadowBrowserStateProof;
};

export type ShadowProjectionListPatch = {
  order: ObjRef[];
  upsert: ScopedObjectSummary[];
  remove: ObjRef[];
};

export const SHADOW_SCOPE_PROJECTION_PATCH_FIELDS = [
  "title",
  "object_count",
  "contents",
  "seq",
  "cursor",
  "viewer",
  "self",
  "session",
  "subject"
] as const satisfies readonly (keyof ShadowScopeProjection)[];

type ShadowScopeProjectionPatchField = typeof SHADOW_SCOPE_PROJECTION_PATCH_FIELDS[number];

export type ShadowScopeProjectionPatch = {
  kind: "woo.scope_projection_patch.shadow.v1";
  scope: ObjRef;
  base: ShadowCommitAccepted["position"];
  to: ShadowCommitAccepted["position"];
  fields: Partial<Pick<ShadowScopeProjection, ShadowScopeProjectionPatchField>>;
  objects: ShadowProjectionListPatch;
  inventory?: ShadowProjectionListPatch;
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
    active_scope: ObjRef | null;
    current_location?: ObjRef | null;
    all_locations: ObjRef[];
  } | null;
  inventory?: ScopedObjectSummary[];
  subject: ScopedObjectSummary | null;
  objects: ScopedObjectSummary[];
};

type ShadowScopeProjectionNonPatchField = "kind" | "scope" | "objects" | "inventory";
type ShadowScopeProjectionUncoveredField = Exclude<keyof ShadowScopeProjection, ShadowScopeProjectionPatchField | ShadowScopeProjectionNonPatchField>;
const SHADOW_SCOPE_PROJECTION_PATCH_FIELD_COVERAGE: ShadowScopeProjectionUncoveredField extends never ? true : never = true;

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
  serialized_generation: number;
  open_executable_seed_cache: Map<string, { generation: number; digest: string }>;
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
  executable_transfer: ShadowStateTransfer;
  executable_transfer_cache: "hit" | "miss";
  executable_transfer_digest?: string;
  executable_transfer_bytes: number;
  executable_transfer_pages: number;
  executable_transfer_inline_pages: number;
  ads: ShadowCapabilityAd[];
  preseeded_objects: number;
  transfer_mode: "projection" | "delta";
};

export type ShadowBrowserOpenScopeOptions = {
  preseed_catalog_pages?: boolean;
  last_known_head?: ShadowCommitAccepted["position"];
  executable_seed_digest?: string;
  metric?: (event: MetricEvent) => void;
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
  body?: Record<string, WooValue>;
  persistence?: ShadowTurnExecRequest["persistence"];
};

export type ShadowTurnIntentRequest = {
  kind: "woo.turn.intent.request.shadow.v1";
  id?: string;
  route: ShadowTurnCall["route"];
  scope: ObjRef;
  target: ObjRef;
  verb: string;
  args?: WooValue[];
  body?: Record<string, WooValue>;
  persistence?: ShadowTurnExecRequest["persistence"];
  selected_ad?: string;
};

export type ShadowExecutableStateTransferRequest = {
  kind: "woo.state.transfer.request.shadow.v1";
  id?: string;
  scope: ObjRef;
  key: ShadowTurnKey;
  // Hashes are sufficient when the requested atoms appear in `key.preimages`
  // (the planned transcript saw them). When the request originates from an
  // `E_NEED_STATE` throw, the recorder bailed before recording the access, so
  // the planned key has no entry for those atoms; in that case the requester
  // MUST send `missing_atoms` with explicit preimages so the relay can build
  // the cell-page closure without inventing it from the partial key.
  atom_hashes?: string[];
  missing_atoms?: ShadowMissingAtom[];
  known_page_hashes?: string[];
  mode?: "cell_pages";
};

export function buildShadowTurnIntentEnvelope(input: {
  node: string;
  actor: ObjRef;
  session: string;
  token: string;
  id?: string;
  envelopeId?: string;
  route: ShadowTurnCall["route"];
  scope: ObjRef;
  target: ObjRef;
  verb: string;
  args: WooValue[];
  body?: Record<string, WooValue>;
  persistence?: ShadowTurnExecRequest["persistence"];
  selected_ad?: string;
}): ShadowEnvelope<ShadowTurnIntentRequest> {
  const body: ShadowTurnIntentRequest = {
    kind: "woo.turn.intent.request.shadow.v1",
    id: input.id,
    route: input.route,
    scope: input.scope,
    target: input.target,
    verb: input.verb,
    args: input.args,
    body: input.body,
    persistence: input.persistence,
    ...(input.selected_ad ? { selected_ad: input.selected_ad } : {})
  };
  return {
    v: 2,
    type: body.kind,
    id: input.envelopeId ?? input.id ?? `${input.node}:turn`,
    from: input.node,
    actor: input.actor,
    session: input.session,
    auth: { mode: "session", token: input.token },
    body
  };
}

export function buildShadowTurnExecEnvelope(input: {
  node: string;
  actor: ObjRef;
  session: string;
  token: string;
  id?: string;
  envelopeId?: string;
  body: ShadowTurnExecRequest;
}): ShadowEnvelope<ShadowTurnExecRequest> {
  return {
    v: 2,
    type: input.body.kind,
    id: input.envelopeId ?? input.id ?? `${input.node}:turn`,
    from: input.node,
    actor: input.actor,
    session: input.session,
    auth: { mode: "session", token: input.token },
    body: input.body
  };
}

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
    serialized_generation: 0,
    open_executable_seed_cache: new Map(),
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
    if (existing && existing.actor === session.actor && existing.activeScope !== undefined) {
      merged.activeScope = existing.activeScope;
    }
    mergedById.set(session.id, merged);
  }
  return Array.from(mergedById.values()).sort((a, b) => a.id.localeCompare(b.id));
}

export function mergeShadowBrowserAuthoritySessionState(current: readonly SerializedSession[], fresh: readonly SerializedSession[]): SerializedSession[] {
  const mergedById = new Map<string, SerializedSession>(
    current.map((session) => [session.id, structuredClone(session) as SerializedSession])
  );
  for (const session of fresh) {
    // Authority slices are produced by the session/object owner immediately
    // before an envelope is submitted. Unlike the legacy auth refresh above,
    // their activeScope is intentional input to planning and must replace any
    // stale per-scope value left by another CommitScopeDO.
    mergedById.set(session.id, structuredClone(session) as SerializedSession);
  }
  return Array.from(mergedById.values()).sort((a, b) => a.id.localeCompare(b.id));
}

export function markShadowBrowserRelaySerializedChanged(relay: ShadowBrowserRelayShim): void {
  markShadowCommitScopeSerializedChanged(relay.commit_scope);
  relay.serialized_generation++;
  relay.open_executable_seed_cache.clear();
  SHADOW_SERIALIZED_INDEX_CACHE.delete(relay.commit_scope.serialized);
}

function noteShadowBrowserRelayCommitAccepted(relay: ShadowBrowserRelayShim): void {
  // Accepted commits replace commit_scope.serialized through the indexed commit
  // scope, so the state index is already current. The browser-facing generation
  // still must advance so open-time executable seed digests cannot validate
  // against pre-commit pages.
  relay.serialized_generation++;
  relay.open_executable_seed_cache.clear();
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
  // Reused relays can already hold the wire token after a previous open; keep
  // this operation idempotent so reconnects do not depend on a local bearer
  // entry being rebuilt first.
  if (!browser.session_token) throw new Error("shadow browser session auth token is required");
  if (browser.session_token === token) return;
  const claims = browser.relay.session_auth.get(browser.session_token) ?? browser.relay.session_auth.get(token);
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
  const totalStartedAt = metricNow();
  validateShadowBrowserNodeAuth(browser);
  const serialized = browser.relay.commit_scope.serialized;
  const openSeedCacheKey = shadowBrowserOpenExecutableSeedCacheKey(browser.scope, browser.actor);
  const cachedOpenSeed = browser.relay.open_executable_seed_cache.get(openSeedCacheKey);
  const cachedDigestMatches = Boolean(
    cachedOpenSeed &&
    cachedOpenSeed.generation === browser.relay.serialized_generation &&
    options.executable_seed_digest === cachedOpenSeed.digest
  );
  const preseedSelectStartedAt = metricNow();
  const preseed = options.preseed_catalog_pages === true && !cachedDigestMatches ? shadowBrowserCatalogObjects(serialized) : [];
  emitV2OpenStep(options, browser, "preseed_catalog_select", preseedSelectStartedAt, {
    count: preseed.length,
    executable_transfer_cache: cachedDigestMatches ? "hit" : "miss"
  });
  if (preseed.length > 0) {
    const preseedInstallStartedAt = metricNow();
    installShadowCachedObjectRecords(browser.execution_node, preseed);
    cacheObjectPages(browser.cache, preseed);
    emitV2OpenStep(options, browser, "preseed_catalog_install", preseedInstallStartedAt, { count: preseed.length });
  }
  const subscribeStartedAt = metricNow();
  subscribeShadowBrowserNode(browser, browser.scope);
  emitV2OpenStep(options, browser, "subscribe_scope", subscribeStartedAt, { count: 1 });
  // Scope open enters the state plane even for display-only projection data, so
  // every cache fill goes through the same recipient-bound verification path.
  const catchupBuildStartedAt = metricNow();
  const transfer = buildShadowBrowserCatchupTransferForBrowser(browser, browser.scope, options.last_known_head);
  emitV2OpenStep(options, browser, "catchup_transfer_build", catchupBuildStartedAt, {
    transfer_mode: transfer.mode,
    count: transfer.mode === "delta" ? transfer.applied.length : 1
  });
  const catchupApplyStartedAt = metricNow();
  applyShadowBrowserTransfer(browser, transfer);
  emitV2OpenStep(options, browser, "catchup_transfer_apply", catchupApplyStartedAt, { transfer_mode: transfer.mode });
  let executableTransfer: ShadowStateTransfer;
  let executableSeedDigest: string | null = cachedOpenSeed?.generation === browser.relay.serialized_generation ? cachedOpenSeed.digest : null;
  if (cachedDigestMatches) {
    const cacheHitStartedAt = metricNow();
    rememberShadowBrowserOpenExecutableSeedDigest(browser.relay, openSeedCacheKey, cachedOpenSeed!.digest);
    executableTransfer = buildShadowBrowserOpenExecutableSeedCacheHitTransfer(browser.relay, browser.scope, browser.node, browser.actor);
    emitV2OpenStep(options, browser, "open_seed_cache_hit_build", cacheHitStartedAt, { executable_transfer_cache: "hit" });
  } else {
    const seedBuildStartedAt = metricNow();
    const fullExecutableTransfer = buildShadowBrowserOpenExecutableSeedTransfer(browser.relay, browser.scope, browser.node, browser.actor);
    emitV2OpenStep(options, browser, "open_seed_full_build", seedBuildStartedAt, {
      executable_transfer_cache: "miss",
      count: fullExecutableTransfer.mode === "cell_pages" ? fullExecutableTransfer.page_refs.length : 1
    });
    const digestStartedAt = metricNow();
    executableSeedDigest = shadowStateTransferCacheDigest(fullExecutableTransfer);
    emitV2OpenStep(options, browser, "open_seed_digest", digestStartedAt, {
      executable_transfer_cache: "miss",
      count: executableSeedDigest ? 1 : 0
    });
    if (executableSeedDigest) {
      rememberShadowBrowserOpenExecutableSeedDigest(browser.relay, openSeedCacheKey, executableSeedDigest);
    }
    // The execution node and browser cache are separate stores: the former runs
    // local turns, while the latter persists transfer pages through IndexedDB.
    const installStartedAt = metricNow();
    installShadowStateTransfer(browser.execution_node, fullExecutableTransfer);
    cacheStatePages(browser.cache, fullExecutableTransfer.mode === "cell_pages" ? fullExecutableTransfer.inline_pages : []);
    emitV2OpenStep(options, browser, "open_seed_install", installStartedAt, {
      executable_transfer_cache: "miss",
      count: fullExecutableTransfer.mode === "cell_pages" ? fullExecutableTransfer.inline_pages.length : 1
    });
    executableTransfer = fullExecutableTransfer;
  }
  const executableApplyStartedAt = metricNow();
  applyShadowBrowserTransfer(browser, executableTransfer);
  emitV2OpenStep(options, browser, "open_seed_transfer_apply", executableApplyStartedAt, {
    executable_transfer_cache: cachedDigestMatches ? "hit" : "miss"
  });
  const bytesStartedAt = metricNow();
  const executableTransferBytes = shadowStateTransferJsonBytes(executableTransfer);
  emitV2OpenStep(options, browser, "open_seed_json_bytes", bytesStartedAt, {
    bytes: executableTransferBytes,
    executable_transfer_cache: cachedDigestMatches ? "hit" : "miss"
  });
  const adsStartedAt = metricNow();
  const ads = shadowBrowserScopeExecutionAds(browser.relay, browser.scope);
  emitV2OpenStep(options, browser, "scope_execution_ads", adsStartedAt, { count: ads.length });
  emitV2OpenStep(options, browser, "total", totalStartedAt, {
    transfer_mode: transfer.mode,
    executable_transfer_cache: cachedDigestMatches ? "hit" : "miss",
    bytes: executableTransferBytes,
    count: preseed.length
  });
  return {
    projection: browser.cache.projections.get(browser.scope) ?? (transfer.mode === "projection" ? transfer.projection : null),
    transfer,
    executable_transfer: executableTransfer,
    executable_transfer_cache: cachedDigestMatches ? "hit" : "miss",
    ...(executableSeedDigest ? { executable_transfer_digest: executableSeedDigest } : {}),
    executable_transfer_bytes: executableTransferBytes,
    executable_transfer_pages: executableTransfer.mode === "cell_pages" ? executableTransfer.page_refs.length : 0,
    executable_transfer_inline_pages: executableTransfer.mode === "cell_pages" ? executableTransfer.inline_pages.length : 0,
    ads,
    preseeded_objects: preseed.length,
    transfer_mode: transfer.mode
  };
}

function metricNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return perf?.now ? perf.now() : Date.now();
}

function emitV2OpenStep(
  options: ShadowBrowserOpenScopeOptions,
  browser: ShadowBrowserNode,
  phase: string,
  startedAt: number,
  fields: Partial<Extract<MetricEvent, { kind: "v2_open_step" }>> = {}
): void {
  options.metric?.({
    kind: "v2_open_step",
    phase,
    scope: browser.scope,
    node: browser.node,
    ...(browser.actor ? { actor: browser.actor } : {}),
    ms: Math.max(0, Math.round((metricNow() - startedAt) * 1000) / 1000),
    status: "ok",
    ...fields
  });
}

function shadowStateTransferJsonBytes(transfer: ShadowStateTransfer): number {
  return new TextEncoder().encode(JSON.stringify(transfer)).length;
}

function shadowBrowserOpenExecutableSeedCacheKey(scope: ObjRef, actor?: ObjRef): string {
  return `${scope}\u0000${actor ?? ""}`;
}

function rememberShadowBrowserOpenExecutableSeedDigest(relay: ShadowBrowserRelayShim, key: string, digest: string): void {
  // Map insertion order is the LRU list. The digest is only a cache validator,
  // so evicting an old actor entry changes performance but never correctness.
  relay.open_executable_seed_cache.delete(key);
  relay.open_executable_seed_cache.set(key, {
    generation: relay.serialized_generation,
    digest
  });
  while (relay.open_executable_seed_cache.size > MAX_SHADOW_OPEN_EXECUTABLE_SEED_CACHE) {
    const oldest = relay.open_executable_seed_cache.keys().next().value;
    if (typeof oldest !== "string") break;
    relay.open_executable_seed_cache.delete(oldest);
  }
}

export function shadowStateTransferCacheDigest(transfer: ShadowStateTransfer): string | null {
  if (transfer.mode === "closure") {
    return hashSource(stableShadowJson({
      kind: "woo.state_transfer_cache_digest.shadow.v1",
      mode: transfer.mode,
      scope: transfer.scope,
      atom_hashes: transfer.atom_hashes,
      preimages: transfer.preimages ?? [],
      serialized_hash: hashSource(stableShadowJson(transfer.serialized as unknown as WooValue))
    } as unknown as WooValue));
  }
  if (transfer.mode === "object_records") {
    if (transfer.object_pages.length === 0) return null;
    return hashSource(stableShadowJson({
      kind: "woo.state_transfer_cache_digest.shadow.v1",
      mode: transfer.mode,
      scope: transfer.scope,
      atom_hashes: transfer.atom_hashes,
      preimages: transfer.preimages ?? [],
      object_pages: transfer.object_pages.map(({ id, hash, bytes }) => ({ id, hash, bytes })),
      sessions: transfer.sessions,
      logs: transfer.logs,
      snapshots: transfer.snapshots,
      parkedTasks: transfer.parkedTasks,
      tombstones: transfer.tombstones,
      counters: transfer.counters,
      source_object_count: transfer.source_object_count
    } as unknown as WooValue));
  }
  if (transfer.page_refs.length === 0) return null;
  return hashSource(stableShadowJson({
    kind: "woo.state_transfer_cache_digest.shadow.v1",
    mode: transfer.mode,
    purpose: transfer.purpose ?? null,
    scope: transfer.scope,
    atom_hashes: transfer.atom_hashes,
    preimages: transfer.preimages ?? [],
    page_refs: transfer.page_refs.map(({ object, page, name, hash, bytes }) => ({ object, page, ...(name ? { name } : {}), hash, bytes })),
    sessions: transfer.sessions,
    logs: transfer.logs,
    snapshots: transfer.snapshots,
    parkedTasks: transfer.parkedTasks,
    tombstones: transfer.tombstones,
    counters: transfer.counters,
    source_object_count: transfer.source_object_count,
    source_page_count: transfer.source_page_count
  } as unknown as WooValue));
}

export function buildShadowBrowserOpenExecutableSeedTransfer(
  relay: ShadowBrowserRelayShim,
  scope: ObjRef,
  recipient: string,
  actor?: ObjRef
): ShadowStateTransfer {
  // Scope open needs enough executable material for the browser to plan the
  // first durable turn locally. This seed grants only coarse structural atom
  // coverage for the scope/actor/content scaffold; after planning derives the
  // exact TurnKey, ordinary missing-state repair installs the specific verb and
  // property cells before the browser submits a TurnExecRequest.
  const preimages = shadowBrowserOpenExecutableSeedPreimages(relay.commit_scope.serialized, scope, actor);
  const key: ShadowTurnKey = {
    kind: "woo.turn_key.shadow.v1",
    scope,
    actor: actor ?? "",
    target: scope,
    verb: "__open_executable_seed__",
    preimages,
    atom_hashes: preimages.map(shadowAtomHash),
    read_preimages: preimages,
    read_atom_hashes: preimages.map(shadowAtomHash),
    write_preimages: [],
    write_atom_hashes: [],
    accept_preimages: preimages,
    accept_atom_hashes: preimages.map(shadowAtomHash)
  };
  return buildShadowCellPageTransfer({
    serialized: shadowBrowserOpenExecutableSeedSerialized(relay.commit_scope.serialized, scope, actor),
    key,
    purpose: "open_executable_seed",
    recipient
  });
}

function buildShadowBrowserOpenExecutableSeedCacheHitTransfer(
  relay: ShadowBrowserRelayShim,
  scope: ObjRef,
  recipient: string,
  actor?: ObjRef
): ShadowStateTransfer {
  const key: ShadowTurnKey = {
    kind: "woo.turn_key.shadow.v1",
    scope,
    actor: actor ?? "",
    target: scope,
    verb: "__open_executable_seed_cache_hit__",
    preimages: [],
    atom_hashes: [],
    read_preimages: [],
    read_atom_hashes: [],
    write_preimages: [],
    write_atom_hashes: [],
    accept_preimages: [],
    accept_atom_hashes: []
  };
  return buildShadowCellPageTransfer({
    serialized: relay.commit_scope.serialized,
    key,
    purpose: "open_executable_seed_cache_hit",
    recipient
  });
}

function shadowBrowserOpenExecutableSeedPreimages(serialized: SerializedWorld, scope: ObjRef, actor?: ObjRef): string[] {
  const byId = new Map(serialized.objects.map((obj) => [obj.id, obj] as const));
  const preimages = new Set<string>();
  const add = (preimage: string): void => {
    preimages.add(preimage);
  };
  add(`scope:${scope}`);
  add(`target:${scope}`);
  if (actor) add(`actor:${actor}`);
  for (const id of byId.get(scope)?.contents ?? []) add(`target:${id}`);

  const scopeObj = byId.get(scope);
  const actorObj = actor ? byId.get(actor) : undefined;
  const actorLocationObj = actorObj?.location ? byId.get(actorObj.location) : undefined;
  for (const id of openSeedLinkedObjectRefs(serialized, scope, actor)) add(`target:${id}`);
  if (scopeObj) addOpenSeedObjectCells(scopeObj, add, { writeProps: true, writeContents: true });
  if (actorObj) addOpenSeedObjectCells(actorObj, add, { writeLocation: true });
  if (actorLocationObj) {
    addOpenSeedObjectCells(actorLocationObj, add, { writeContents: true });
    // A first local `enter` moves the actor out of their current room before
    // entering the tool scope. The generic movement chain probes
    // oldLocation:exitfunc even when no concrete hook exists, so seed that
    // inherited verb lookup at open instead of forcing the first click through
    // a repair round.
    addOpenSeedVerbLookupCells(serialized, actorLocationObj.id, ["exitfunc"], add);
  }

  // Catalog lineage and property cells are executable metadata: they let a
  // partial browser shard interpret objects that arrive later from accepted
  // transcripts. Without these pages, `isa()` and inherited property walks can
  // degrade to false/not-found inside a syntactically valid local world. Verb
  // bytecode remains exact-repair driven because all bundled catalog bytecode is
  // too large for the open envelope.
  addOpenSeedCatalogExecutableCells(serialized, add);

  // The browser cannot derive a first-turn key without the selected verb's
  // bytecode. Scope-lineage verb pages cover normal tool controls while keeping
  // large content-object catalogs out of the open envelope; content-specific
  // verbs still arrive through exact missing-state repair after the key exists.
  let current: ObjRef | null | undefined = scope;
  while (current) {
    const obj = byId.get(current);
    if (!obj) break;
    for (const verb of obj.verbs) {
      add(`read:cell:verb:${obj.id}:${verb.name}`);
      add(`call:${scope}:${verb.name}`);
    }
    current = obj.parent;
  }
  return [
    ...preimages
  ].sort();
}

function addOpenSeedVerbLookupCells(
  serialized: SerializedWorld,
  receiver: ObjRef,
  names: readonly string[],
  add: (preimage: string) => void
): void {
  const byId = new Map(serialized.objects.map((obj) => [obj.id, obj] as const));
  const wanted = new Set(names);
  let current: ObjRef | null | undefined = receiver;
  const seen = new Set<ObjRef>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const obj = byId.get(current);
    if (!obj) return;
    for (const name of wanted) add(`read:cell:verb:${obj.id}:${name}`);
    current = obj.parent;
  }
  // Verb lookup can also pass through catalog feature/mixin classes that are
  // not on the single parent chain. The open seed already ships catalog
  // objects; for a tiny fixed hook set, include their lookup cells too so a
  // missing inherited no-op hook never stalls the first local movement turn.
  for (const obj of shadowBrowserCatalogObjects(serialized)) {
    for (const name of wanted) add(`read:cell:verb:${obj.id}:${name}`);
  }
}

function addOpenSeedCatalogExecutableCells(
  serialized: SerializedWorld,
  add: (preimage: string) => void
): void {
  for (const obj of shadowBrowserCatalogObjects(serialized)) {
    add(`read:cell:lifecycle:${obj.id}`);
    addOpenSeedObjectCells(obj, add);
  }
}

function addOpenSeedObjectCells(
  obj: SerializedObject,
  add: (preimage: string) => void,
  options: { writeProps?: boolean; writeLocation?: boolean; writeContents?: boolean } = {}
): void {
  for (const name of openSeedPropertyNames(obj)) {
    add(`read:cell:prop:${obj.id}.${name}`);
    if (options.writeProps === true) add(`write:cell:prop:${obj.id}.${name}`);
  }
  if (options.writeLocation === true) {
    add(`read:cell:location:${obj.id}`);
    add(`write:cell:location:${obj.id}`);
  }
  if (options.writeContents === true) {
    add(`read:cell:contents:${obj.id}`);
    add(`write:cell:contents:${obj.id}`);
  }
}

function openSeedPropertyNames(obj: SerializedObject): string[] {
  const names = new Set<string>([
    "name",
    "description",
    "aliases",
    "mount_room",
    "subscribers",
    "session_subscribers",
    "focus_by_actor",
    "last_undo"
  ]);
  for (const [name] of obj.properties) names.add(name);
  for (const def of obj.propertyDefs) names.add(def.name);
  return Array.from(names).sort();
}

function shadowBrowserOpenExecutableSeedSerialized(
  serialized: SerializedWorld,
  scope: ObjRef,
  actor?: ObjRef
): SerializedWorld {
  const byId = new Map(serialized.objects.map((obj) => [obj.id, obj] as const));
  const keep = new Set<ObjRef>();
  const addWithLineage = (id: ObjRef | null | undefined): void => {
    let current = id;
    while (current) {
      if (keep.has(current)) return;
      const obj = byId.get(current);
      if (!obj) return;
      keep.add(current);
      for (const feature of serializedFeatureRefs(obj)) addWithLineage(feature);
      current = obj.parent;
    }
  };
  for (const obj of shadowBrowserCatalogObjects(serialized)) keep.add(obj.id);
  addWithLineage(scope);
  addWithLineage(actor);
  for (const content of byId.get(scope)?.contents ?? []) addWithLineage(content);
  for (const linked of openSeedLinkedObjectRefs(serialized, scope, actor)) addWithLineage(linked);
  return {
    version: serialized.version,
    objectCounter: serialized.objectCounter,
    parkedTaskCounter: serialized.parkedTaskCounter,
    sessionCounter: serialized.sessionCounter,
    // This is a read-only projection into the commit-scope snapshot. The cell
    // page transfer builder clones the page/tail payloads it returns, so cloning
    // every kept row here only duplicates work on the cold /v2/open path.
    objects: serialized.objects
      .filter((obj) => keep.has(obj.id))
      .sort((a, b) => a.id.localeCompare(b.id)),
    sessions: serialized.sessions
      .filter((session) => session.actor === actor)
      .sort((a, b) => a.id.localeCompare(b.id)),
    logs: serialized.logs
      .filter(([space]) => space === scope)
      .sort(([a], [b]) => a.localeCompare(b)),
    snapshots: serialized.snapshots
      .filter((snapshot) => snapshot.space_id === scope),
    parkedTasks: [],
    tombstones: [...(serialized.tombstones ?? [])].sort()
  };
}

function openSeedLinkedObjectRefs(serialized: SerializedWorld, scope: ObjRef, actor?: ObjRef): ObjRef[] {
  const byId = new Map(serialized.objects.map((obj) => [obj.id, obj] as const));
  const refs = new Set<ObjRef>();
  const add = (value: unknown): void => {
    if (typeof value === "string" && byId.has(value)) refs.add(value);
  };
  const addPropRefs = (obj: SerializedObject | undefined): void => {
    if (!obj) return;
    for (const name of ["mount_room", "home"] as const) {
      add(obj.properties.find(([prop]) => prop === name)?.[1]);
    }
  };
  const scopeObj = byId.get(scope);
  const actorObj = actor ? byId.get(actor) : undefined;
  add(actorObj?.location ?? null);
  addPropRefs(scopeObj);
  addPropRefs(actorObj);
  for (const session of serialized.sessions) {
    if (!actor || session.actor !== actor) continue;
    add(session.activeScope ?? null);
  }
  // These linked spaces are not direct transcript cells, but first-turn tool
  // verbs routinely route observations or moves through them. Seeding their
  // lineage keeps local optimistic execution from turning a missing lineage
  // page into a catalog-visible E_TYPE.
  for (const ref of Array.from(refs)) addPropRefs(byId.get(ref));
  return Array.from(refs).sort();
}

function serializedFeatureRefs(obj: SerializedObject): ObjRef[] {
  const value = obj.properties.find(([name]) => name === "features")?.[1];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ObjRef => typeof item === "string");
}

export function shadowBrowserScopeExecutionAds(relay: ShadowBrowserRelayShim, scope: ObjRef): ShadowCapabilityAd[] {
  // A scope ad is a cold-start routing hint only. Its empty Bloom filters are
  // intentionally unusable for exact-key local delegation; after relay-side
  // planning, the selected executor still has to execute or return missing_state.
  return [buildShadowScopeTurnExecAd({
    node: shadowRelayDefaultExecutorNode(relay),
    scope,
    epoch: relay.commit_scope.head.hash,
    factor: 1
  })];
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
  const registered = browser.relay.browsers.get(browser.node);
  // Browser node ids are durable across reloads. A stale transport can close
  // after a replacement node has subscribed with the same id; disposing the
  // stale object must not remove the replacement's subscription or wire token.
  if (registered && registered !== browser) return;
  unsubscribeShadowBrowserNode(browser, scope);
  if (registered === browser) browser.relay.browsers.delete(browser.node);
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
  return shadowLiveEventsForTranscriptRelay(browser.relay.node, transcript);
}

export function shadowLiveEventsForTranscriptRelay(relayNode: string, transcript: EffectTranscript): ShadowLiveEvent[] {
  return transcript.observations.map((observation, index) => {
    const actor = typeof observation?.actor === "string" ? observation.actor : transcript.call.actor;
    const scope = transcript.scope;
    const source = shadowLiveEventSource(observation, transcript);
    const coalesce = typeof observation?.coalesce_key === "string" ? observation.coalesce_key : undefined;
    const audience = shadowLiveAudienceForObservation(observation) ?? { scope: source };
    return {
      kind: "woo.live.event.shadow.v1",
      id: `${relayNode}:live:${transcript.hash}:${index}`,
      source,
      actor,
      scope,
      // A single movement transcript can emit observations for both the source
      // and destination rooms. Route live delivery by observation source while
      // keeping the original transcript scope for ordering/debug metadata. If
      // the observation carried an explicit private audience, preserve it here;
      // otherwise transcript-derived live events would fall back to room scope.
      audience,
      observation: publicLiveObservation(observation),
      ...(coalesce ? { coalesce } : {})
    };
  });
}

function shadowLiveAudienceForObservation(observation: Observation): ShadowLiveAudience | undefined {
  const override = (observation as Record<string, unknown>)._audience_override;
  if (Array.isArray(override)) {
    const actors = Array.from(new Set(override.filter((item): item is ObjRef => typeof item === "string")));
    return { actors };
  }
  if ((observation.type === "looked" || observation.type === "who") && typeof observation.to === "string") {
    return { actors: [observation.to] };
  }
  const directed = directedRecipients(observation);
  const actors = new Set<ObjRef>();
  if (directed.to) actors.add(directed.to);
  if (directed.from) actors.add(directed.from);
  return actors.size > 0 ? { actors: Array.from(actors) } : undefined;
}

function publicLiveObservation(observation: Observation): Observation {
  const clone = structuredClone(observation) as Observation;
  delete (clone as Record<string, unknown>)._audience_override;
  return clone;
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
  const cached = cloneImmutableShadowLiveEvent(event);
  relay.live_events.push(cached);
  trimArrayHead(relay.live_events, MAX_SHADOW_LIVE_EVENTS);
  for (const browser of relay.browsers.values()) {
    if (options.except && browser.node === options.except) continue;
    if (!shadowLiveEventMatchesBrowser(relay, browser, cached)) continue;
    receiveShadowBrowserLiveEvent(browser, cached);
  }
}

function receiveShadowBrowserLiveEvent(browser: ShadowBrowserNode, event: ShadowLiveEvent): void {
  if (event.coalesce) {
    const index = browser.cache.live_events.findIndex((item) => item.coalesce === event.coalesce);
    if (index >= 0) {
      browser.cache.live_events[index] = event;
      return;
    }
  }
  browser.cache.live_events.push(event);
  trimArrayHead(browser.cache.live_events, MAX_SHADOW_LIVE_EVENTS);
}

function cloneImmutableShadowLiveEvent(event: ShadowLiveEvent): ShadowLiveEvent {
  // Live fan-out writes the same event into relay history and every matching
  // browser cache. Clone once at the trust boundary, then freeze so accidental
  // cache readers cannot mutate shared event cells.
  return freezePlainShadowValue(structuredClone(event) as ShadowLiveEvent);
}

function freezePlainShadowValue<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    freezePlainShadowValue(entry);
  }
  return Object.freeze(value);
}

export function shadowLiveEventMatchesBrowser(
  relay: ShadowBrowserRelayShim,
  browser: ShadowBrowserNode,
  event: ShadowLiveEvent
): boolean {
  const audience = event.audience;
  if (audience) {
    if (audience.sessions?.includes(browser.session ?? "")) return true;
    if (audience.actors?.includes(browser.actor)) return true;
    if (!audience.scope) return false;
    return relay.subscriptions.get(audience.scope)?.has(browser.node) === true;
  }
  const scope = event.scope;
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
    args: input.args ?? [],
    body: input.body
  };
  const planned = await runShadowTurnCallTranscript(browser.relay.commit_scope.serialized, call);
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
    persistence: input.persistence ?? "durable"
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
    if (network.result.commit) {
      noteShadowBrowserRelayCommitAccepted(browser.relay);
      publishShadowBrowserAcceptedFrame(browser.relay, network.result.commit, network.result.transcript);
    }
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
  viewer?: ShadowProjectionViewer,
  baseProjection?: ShadowScopeProjection,
  baseHead?: ShadowCommitAccepted["position"]
): ShadowDeltaTransfer {
  return buildShadowBrowserDeltaTransferFromFrames(relay, [accepted], [transcript], recipient, viewer, baseProjection, baseHead);
}

export function buildShadowBrowserDeltaTransferForBrowser(
  relay: ShadowBrowserRelayShim,
  browser: ShadowBrowserNode,
  accepted: ShadowCommitAccepted,
  transcript: EffectTranscript
): ShadowDeltaTransfer {
  const baseProjection = browser.cache.projections.get(accepted.position.scope);
  return buildShadowBrowserDeltaTransfer(
    relay,
    accepted,
    transcript,
    browser.node,
    shadowProjectionViewer(browser),
    isShadowScopeProjection(baseProjection) ? baseProjection : undefined,
    shadowBrowserCachedProjectionHead(browser, accepted.position.scope) ??
      shadowBrowserProjectionHead(baseProjection, accepted.position.scope, accepted.position.epoch)
  );
}

export function buildShadowBrowserDeltaTransferFromFrames(
  relay: ShadowBrowserRelayShim,
  acceptedFrames: ShadowCommitAccepted[],
  transcripts: EffectTranscript[],
  recipient = "*",
  viewer?: ShadowProjectionViewer,
  baseProjection?: ShadowScopeProjection,
  baseHead?: ShadowCommitAccepted["position"]
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
  const to = structuredClone(ordered[ordered.length - 1].position) as ShadowCommitAccepted["position"];
  // Delta transfer carries the committed frame plus transcript tail needed by
  // browser caches to catch up without receiving executable closure state.
  const common = {
    kind: "woo.state.transfer.shadow.v1",
    mode: "delta",
    scope,
    to,
    applied: ordered.map((frame) => structuredClone(frame) as ShadowCommitAccepted),
    transcript_tail: orderedTranscripts.map((transcript) => structuredClone(transcript) as EffectTranscript)
  } satisfies Omit<ShadowDeltaTransfer, "proof" | "projection" | "projection_patch">;
  if (ordered.length === 1 && baseProjection && baseHead && baseProjection.scope === scope && baseHead.scope === scope) {
    const projectionPatch = shadowScopeProjectionPatchFromTranscript(
      relay.commit_scope.serialized,
      ordered[0],
      orderedTranscripts[0],
      baseProjection,
      baseHead,
      viewer
    );
    if (projectionPatch) {
      const patchTransfer = {
        ...common,
        projection_patch: projectionPatch
      } satisfies Omit<ShadowDeltaTransfer, "proof">;
      return { ...patchTransfer, proof: signShadowBrowserStateTransfer(patchTransfer, relay.state_signing, recipient) };
    }
  }
  const projection = shadowScopeProjection(relay.commit_scope.serialized, scope, to.seq, viewer);
  const fullTransfer = {
    ...common,
    projection
  } satisfies Omit<ShadowDeltaTransfer, "proof">;
  if (!baseProjection || !baseHead || baseProjection.scope !== scope || baseHead.scope !== scope) {
    return { ...fullTransfer, proof: signShadowBrowserStateTransfer(fullTransfer, relay.state_signing, recipient) };
  }
  const patchTransfer = {
    ...common,
    projection_patch: shadowScopeProjectionPatch(baseProjection, baseHead, projection, to)
  } satisfies Omit<ShadowDeltaTransfer, "proof">;
  const selectedTransfer = shadowBrowserTransferBodyByteLength(patchTransfer) < shadowBrowserTransferBodyByteLength(fullTransfer)
    ? patchTransfer
    : fullTransfer;
  return { ...selectedTransfer, proof: signShadowBrowserStateTransfer(selectedTransfer, relay.state_signing, recipient) };
}

export function buildShadowBrowserCurrentTransfer(
  relay: ShadowBrowserRelayShim,
  scope: ObjRef,
  recipient: string
): ShadowDeltaTransfer {
  // Equal-head reconnects already hold the display projection in IndexedDB. A
  // signed empty delta acknowledges freshness without rebuilding and resending
  // a full projection body through the server-side browser shim.
  const transfer = {
    kind: "woo.state.transfer.shadow.v1",
    mode: "delta",
    scope,
    to: structuredClone(relay.commit_scope.head) as ShadowCommitAccepted["position"],
    applied: [],
    transcript_tail: []
  } satisfies Omit<ShadowDeltaTransfer, "proof">;
  return { ...transfer, proof: signShadowBrowserStateTransfer(transfer, relay.state_signing, recipient) };
}

export function buildShadowBrowserCatchupTransfer(
  relay: ShadowBrowserRelayShim,
  scope: ObjRef,
  recipient: string,
  lastKnownHead?: ShadowCommitAccepted["position"],
  viewer?: ShadowProjectionViewer,
  baseProjection?: ShadowScopeProjection,
  baseHead?: ShadowCommitAccepted["position"]
): ShadowProjectionTransfer | ShadowDeltaTransfer {
  if (
    lastKnownHead &&
    lastKnownHead.scope === scope &&
    lastKnownHead.epoch === relay.commit_scope.head.epoch &&
    lastKnownHead.seq === relay.commit_scope.head.seq &&
    lastKnownHead.hash === relay.commit_scope.head.hash
  ) {
    return buildShadowBrowserCurrentTransfer(relay, scope, recipient);
  }
  if (lastKnownHead && lastKnownHead.scope === scope && lastKnownHead.epoch === relay.commit_scope.head.epoch && lastKnownHead.seq < relay.commit_scope.head.seq) {
    const accepted = relay.accepted_frames
      .filter((frame) => frame.position.scope === scope && frame.position.seq > lastKnownHead.seq && frame.position.seq <= relay.commit_scope.head.seq)
      .sort((a, b) => a.position.seq - b.position.seq);
    const expectedSeqs = new Set(Array.from({ length: relay.commit_scope.head.seq - lastKnownHead.seq }, (_item, index) => lastKnownHead.seq + index + 1));
    const hasContiguousTail = accepted.length === expectedSeqs.size && accepted.every((frame) => expectedSeqs.has(frame.position.seq));
    const transcriptByHash = new Map(relay.transcript_tail.map((item) => [item.hash, item] as const));
    const transcripts = accepted.map((frame) => transcriptByHash.get(frame.transcript_hash));
    if (hasContiguousTail && transcripts.every((item): item is EffectTranscript => Boolean(item))) {
      const delta = buildShadowBrowserDeltaTransferFromFrames(relay, accepted, transcripts, recipient, viewer, baseProjection, baseHead);
      // A retained tail can still be the wrong transfer choice when the browser
      // has been away for many chatty turns. Projection fallback is smaller for
      // display catch-up and preserves the one-frame WebSocket contract.
      if (shadowBrowserTransferBodyByteLength(delta) <= MAX_SHADOW_BROWSER_TRANSFER_BODY_BYTES) return delta;
    }
  }
  return buildShadowBrowserProjectionTransfer(relay, scope, recipient, viewer);
}

export function buildShadowBrowserCatchupTransferForBrowser(
  browser: ShadowBrowserNode,
  scope: ObjRef,
  lastKnownHead?: ShadowCommitAccepted["position"]
): ShadowProjectionTransfer | ShadowDeltaTransfer {
  const requestedHead = lastKnownHead;
  const cachedBase = requestedHead ? shadowBrowserCachedProjectionBase(browser, scope, requestedHead) : null;
  return buildShadowBrowserCatchupTransfer(
    browser.relay,
    scope,
    browser.node,
    requestedHead,
    shadowProjectionViewer(browser),
    cachedBase?.projection,
    cachedBase?.head
  );
}

function shadowBrowserTransferBodyByteLength(
  transfer: ShadowProjectionTransfer | ShadowDeltaTransfer | Omit<ShadowProjectionTransfer, "proof"> | Omit<ShadowDeltaTransfer, "proof">
): number {
  return SHADOW_BROWSER_TRANSFER_ENCODER.encode(JSON.stringify(transfer)).byteLength;
}

export function publishShadowBrowserAcceptedFrame(
  relay: ShadowBrowserRelayShim,
  accepted: ShadowCommitAccepted,
  transcript: EffectTranscript
): void {
  rememberShadowBrowserAcceptedFrame(relay, accepted, transcript);
  // Drop per-session live snapshots so the next live/direct call rebases on
  // the freshly committed scope state instead of a stale pre-commit view.
  // Without this, after a sequenced commit on the same scope, a subsequent
  // direct read (e.g. `the_outline:list_items` immediately after `:add`)
  // runs against the cached `live_session_serialized` and returns the
  // pre-commit value — making the new row look like it was never written.
  // The live snapshot only matters for chained live-only gestures (e.g.
  // dubspace cue → local control); rebasing on commit is correct because
  // those gestures were never authoritative anyway.
  relay.live_session_serialized.clear();
  // Commit fan-out is subscription-gated; browsers outside the scope must ask
  // for later state transfer rather than receiving every accepted frame.
  for (const browser of relay.browsers.values()) {
    if (relay.subscriptions.get(accepted.position.scope)?.has(browser.node) !== true) continue;
    // The originator is often subscribed too; accepted-frame dedup below makes
    // that round trip harmless while preserving one relay fan-out path.
    const transfer = buildShadowBrowserDeltaTransferForBrowser(relay, browser, accepted, transcript);
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
    features: ["shadow-envelope", "shadow-catchup", "shadow-exec-ads", "shadow-multiplex"]
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

export type ShadowBrowserTurnExecEnvelopeOptions = {
  profile?: (event: MetricEvent & { kind: "shadow_apply_step" }) => void;
  // Forwarder for engine-level metric events recorded during the
  // planning-phase verb execution. Both the intent-envelope path and
  // the live-persistence path run the verb in an ephemeral world
  // (runShadowTurnCallTranscript / runShadowTurnCall in
  // shadow-turn-call.ts) which has no metrics hook by default — so
  // direct_call / applied / dispatch_resolved / broadcast events get
  // dropped on every MCP and WS turn unless the caller threads its
  // host's metric sink in here. Without this, /admin/
  // footprint-by-verb stays empty for the production hot path. The
  // CommitScopeDO caller passes `event => this.emitMetric(event)` so
  // AE sees each verb call.
  onMetric?: (event: MetricEvent) => void;
};

export async function handleShadowBrowserTurnExecEnvelope(
  browser: ShadowBrowserNode,
  receipt: ShadowBrowserEnvelopeReceipt,
  options: ShadowBrowserTurnExecEnvelopeOptions = {}
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
  let request: ShadowTurnExecRequest;
  let reply: ShadowTurnExecReply | undefined;
  if (intent) {
    const call = shadowTurnCallFromIntent(browser, intent);
    if (intent.persistence === "live") {
      reply = await executeShadowBrowserLivePersistenceCall(browser, call, options.onMetric);
      request = {
        kind: "woo.turn.exec.request.shadow.v1",
        id: call.id,
        call,
        key: shadowTurnKeyFromTranscript(reply.transcript),
        expected: browser.relay.commit_scope.head,
        persistence: "live"
      };
    } else if (!intent.selected_ad) {
      const result = await executeShadowBrowserAuthoritativeIntent(browser, call, options);
      if (!result.transcript) throw new Error("authoritative shadow intent completed without a transcript");
      reply = result.reply;
      request = {
        kind: "woo.turn.exec.request.shadow.v1",
        id: call.id,
        call,
        key: shadowTurnKeyFromTranscript(result.transcript),
        expected: browser.relay.commit_scope.head,
        persistence: "durable"
      };
    } else {
      request = await shadowTurnExecRequestFromIntent(browser, intent, options.onMetric, call);
      reply = (await executeShadowBrowserTurnExecRequest(browser, request, options)).reply;
    }
  } else {
    request = receipt.envelope.body as ShadowTurnExecRequest;
    reply = (await executeShadowBrowserTurnExecRequest(browser, request, options)).reply;
  }
  if (!reply) return null;
  const response = shadowBrowserTurnExecReplyEnvelope(browser, receipt, request, reply);
  // Idempotency is reply-oriented: a client retrying because it missed the
  // first reply must receive the same answer without re-running the turn.
  browser.relay.recent_replies.set(receipt.idempotency_key, structuredClone(response));
  trimShadowBrowserIdempotency(browser.relay);
  return response;
}

export function handleShadowBrowserStateTransferEnvelope(
  browser: ShadowBrowserNode,
  receipt: ShadowBrowserEnvelopeReceipt
): ShadowEnvelope<ShadowStateTransfer> | null {
  if (receipt.envelope.type !== "woo.state.transfer.request.shadow.v1") return null;
  if (!receipt.fresh) {
    const cached = browser.relay.recent_replies.get(receipt.idempotency_key);
    return cached ? structuredClone(cached) as ShadowEnvelope<ShadowStateTransfer> : null;
  }
  const request = receipt.envelope.body as ShadowExecutableStateTransferRequest;
  if (request.scope !== browser.relay.commit_scope.scope || request.key.scope !== request.scope) {
    throw new Error(`state transfer scope mismatch: request=${request.scope} key=${request.key.scope} relay=${browser.relay.commit_scope.scope}`);
  }
  if (request.mode && request.mode !== "cell_pages") throw new Error(`unsupported state transfer mode: ${request.mode}`);
  // `missing_atoms` carries preimages for `E_NEED_STATE` throws whose recorder
  // bailed before recording the access. `atom_hashes` still selects atoms from
  // the planned key; when both are present the transfer builder serves the
  // union.
  const transfer = buildShadowCellPageTransfer({
    serialized: browser.relay.commit_scope.serialized,
    key: request.key,
    atom_hashes: request.atom_hashes,
    missing_atoms: request.missing_atoms,
    // Only the requester can say which IndexedDB pages it already possesses.
    // The relay's in-process execution node may have the same pages from open
    // seeding, but treating that server-local cache as client possession makes
    // cold repair replies reference pages the browser never stored.
    known_page_hashes: request.known_page_hashes ?? [],
    session: browser.session,
    recipient: browser.node
  });
  const response: ShadowEnvelope<ShadowStateTransfer> = {
    v: 2,
    type: transfer.kind,
    id: `${browser.relay.node}:state:${request.id ?? receipt.envelope.id}`,
    from: browser.relay.node,
    to: browser.node,
    actor: browser.actor,
    ...(browser.session ? { session: browser.session } : {}),
    reply_to: receipt.envelope.id,
    auth: shadowBrowserAuth(browser),
    body: transfer
  };
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

async function executeShadowBrowserLivePersistenceCall(
  browser: ShadowBrowserNode,
  call: ShadowTurnCall,
  onMetric?: (event: MetricEvent) => void
): Promise<Extract<ShadowTurnExecReply, { ok: true }>> {
  validateShadowBrowserNodeAuth(browser);
  // Live-persistence turns are live/direct surface updates, so keep a per-session
  // live snapshot separate from the committed scope. That lets
  // direct gestures chain (for example Dubspace enter -> local control command)
  // without making the next authority-bearing commit validate against live-only
  // state.
  const sessionKey = call.session ?? call.actor;
  const serializedBefore = browser.relay.live_session_serialized.get(sessionKey) ?? browser.relay.commit_scope.serialized;
  const headHashBefore = browser.relay.commit_scope.head.hash;
  const run = await runShadowTurnCall(serializedBefore, call, { onMetric });
  // A live/direct read may be started by UI hydration immediately after a
  // fire-and-forget sequenced write. If that read finishes after the write
  // commits, caching its pre-commit post-state would resurrect a stale live
  // snapshot and make follow-up reads hide the accepted write.
  if (browser.relay.commit_scope.head.hash === headHashBefore) {
    browser.relay.live_session_serialized.set(sessionKey, run.serializedAfter);
  }
  for (const event of shadowLiveEventsForTranscript(browser, run.transcript)) {
    publishShadowBrowserLiveEvent(browser.relay, event, { except: browser.node });
  }
  const outcome = run.transcript.error
    ? { error: run.transcript.error as unknown as WooValue }
    : { result: run.transcript.result };
  return {
    kind: "woo.turn.exec.reply.shadow.v1",
    ok: true,
    id: call.id,
    outcome,
    transcript: run.transcript
  };
}

async function shadowTurnExecRequestFromIntent(
  browser: ShadowBrowserNode,
  intent: ShadowTurnIntentRequest,
  onMetric?: (event: MetricEvent) => void,
  call = shadowTurnCallFromIntent(browser, intent)
): Promise<ShadowTurnExecRequest> {
  // Browser-local planning is the end-state, but early browser parity needs a
  // safe outbound path before the worker can reconstruct executable closures.
  // Server-assisted planning still records a deterministic transcript and
  // turns it into the same ShadowTurnKey that a local browser planner will
  // submit later.
  const serialized = intent.persistence === "live"
    ? browser.relay.live_session_serialized.get(call.session ?? call.actor) ?? browser.relay.commit_scope.serialized
    : browser.relay.commit_scope.serialized;
  const planned = await runShadowTurnCallTranscript(serialized, call, { onMetric });
  return {
    kind: "woo.turn.exec.request.shadow.v1",
    id: call.id,
    call,
    key: shadowTurnKeyFromTranscript(planned.transcript),
    expected: browser.relay.commit_scope.head,
    persistence: intent.persistence ?? "durable",
    ...(intent.selected_ad ? { selected_ad: intent.selected_ad } : {})
  };
}

function shadowTurnCallFromIntent(browser: ShadowBrowserNode, intent: ShadowTurnIntentRequest): ShadowTurnCall {
  return {
    kind: "woo.turn_call.shadow.v1",
    id: intent.id ?? `${browser.node}:intent:${browser.next_turn++}`,
    route: intent.route,
    scope: intent.scope,
    session: browser.session,
    actor: browser.actor,
    target: intent.target,
    verb: intent.verb,
    args: intent.args ?? [],
    body: intent.body
  };
}

async function executeShadowBrowserTurnExecRequest(
  browser: ShadowBrowserNode,
  request: ShadowTurnExecRequest,
  options: Pick<ShadowBrowserTurnExecEnvelopeOptions, "profile" | "onMetric"> = {}
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
    commitScope: browser.relay.commit_scope,
    profile: options.profile,
    metric: options.onMetric
  });

  for (const transfer of network.transfers) applyShadowBrowserTransfer(browser, transfer);
  if (network.result.ok) {
    const selectedExecutor = browser.relay.executors.find((node) => node.node === network.selected_node);
    if (selectedExecutor) {
      // A delegated success must also warm the actor-side executable cache.
      // Projection deltas update display state, but only execution transfers
      // let the browser plan the next related turn locally.
      const stateTransfer = buildShadowCellPageTransfer({
        serialized: browser.relay.commit_scope.serialized,
        key: request.key,
        atom_hashes: request.key.atom_hashes,
        known_page_hashes: browser.execution_node.page_hashes,
        session: request.call.session,
        recipient: browser.node
      });
      if (network.result.reply) {
        network.result.reply.state_transfer = stateTransfer;
        network.result.reply.ads = [buildShadowTurnExecAdFromNode({ node: selectedExecutor, accepts: request.key, factor: 0.1 })];
      }
    }
    if (network.result.commit) noteShadowBrowserRelayCommitAccepted(browser.relay);
    executor.committed_head_hash = browser.relay.commit_scope.head.hash;
    executor.serialized_generation = browser.relay.serialized_generation;
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

async function executeShadowBrowserAuthoritativeIntent(
  browser: ShadowBrowserNode,
  call: ShadowTurnCall,
  options: Pick<ShadowBrowserTurnExecEnvelopeOptions, "profile" | "onMetric"> = {}
): Promise<ShadowTurnExecutionResult> {
  validateShadowBrowserNodeAuth(browser);
  const executor = shadowRelayAuthoritativeExecutorForScope(browser.relay, call.scope);
  const result = await executeAuthoritativeShadowTurnCall(executor, {
    id: call.id,
    call,
    expected: browser.relay.commit_scope.head,
    persistence: "durable",
    commitScope: browser.relay.commit_scope,
    profile: options.profile,
    metric: options.onMetric
  });
  if (result.ok) {
    const key = shadowTurnKeyFromTranscript(result.transcript);
    if (result.commit) noteShadowBrowserRelayCommitAccepted(browser.relay);
    executor.committed_head_hash = browser.relay.commit_scope.head.hash;
    executor.serialized_generation = browser.relay.serialized_generation;
    if (result.reply) {
      // The fast path intentionally does not build a state transfer on every
      // default relay turn; that transfer walks closure pages and is only needed
      // when warming a delegated/local executor cache. Display state still fans
      // out through the accepted-frame plane below.
      result.reply.ads = [buildShadowTurnExecAdFromNode({ node: executor, accepts: key, factor: 0.1 })];
    }
    if (result.commit) publishShadowBrowserAcceptedFrame(browser.relay, result.commit, result.transcript);
  }
  return result;
}

function shadowRelayExecutorForRequest(relay: ShadowBrowserRelayShim, request: ShadowTurnExecRequest): ShadowExecutionNode {
  const selected = request.selected_ad
    ? relay.executors.find((node) => node.node === request.selected_ad && node.scope === request.key.scope)
    : undefined;
  // Selected ads name an executor that owns its advertised cache. Unlike the
  // relay-local fallback below, the relay must not silently refresh or expand
  // that executor's atom set; exact coverage is proven by execution or
  // missing_state.
  if (selected) return selected;

  const executor = shadowRelayAuthoritativeExecutorForScope(relay, request.key.scope);
  // The relay executor has the authoritative scope state locally. The atom set
  // still feeds downstream executable-cache ads and state-transfer replies.
  for (const hash of request.key.atom_hashes) executor.atom_hashes.add(hash);
  return executor;
}

function shadowRelayAuthoritativeExecutorForScope(relay: ShadowBrowserRelayShim, scope: ObjRef): ShadowExecutionNode {
  const nodeId = shadowRelayDefaultExecutorNode(relay);
  let executor = relay.executors.find((node) => node.node === nodeId);
  const needsRefresh = !executor ||
    executor.scope !== scope ||
    executor.committed_head_hash !== relay.commit_scope.head.hash ||
    executor.serialized_generation !== relay.serialized_generation;
  if (needsRefresh) {
    const fresh = createShadowExecutionNode({
      node: nodeId,
      scope,
      serialized: relay.commit_scope.serialized,
      // The relay-default executor owns the full authoritative serialized
      // state for its commit scope. Marking it authoritative disables the
      // atom-guard that exists to detect partial-cache misses on delegate
      // executors — without this, a browser-built request whose planned key
      // omits cells the verb's actual run touches drives the network-side
      // repair loop to its bound and returns `missing_state` to the browser
      // even though the cells exist in serialized.
      authoritative_state: true
    });
    fresh.committed_head_hash = relay.commit_scope.head.hash;
    fresh.serialized_generation = relay.serialized_generation;
    const index = relay.executors.findIndex((node) => node.node === nodeId);
    if (index < 0) relay.executors.push(fresh);
    else relay.executors[index] = fresh;
    executor = fresh;
  }
  if (!executor) throw new Error(`shadow relay executor unavailable: ${nodeId}`);
  return executor;
}

function shadowRelayDefaultExecutorNode(relay: ShadowBrowserRelayShim): string {
  return `${relay.node}:executor`;
}

function shadowBrowserWireTurnExecReply(reply: ShadowTurnExecReply): ShadowTurnExecReply {
  return structuredClone(reply) as ShadowTurnExecReply;
}

export function applyShadowBrowserAcceptedFrame(browser: ShadowBrowserNode, accepted: ShadowCommitAccepted): void {
  if (browser.cache.applied_frames.some((frame) => frame.id === accepted.id && frame.position.hash === accepted.position.hash)) return;
  browser.cache.applied_frames.push(accepted);
  trimArrayHead(browser.cache.applied_frames, MAX_SHADOW_BROWSER_CACHE_TAIL);
  const existing = browser.cache.projections.get(browser.scope);
  if (isShadowScopeProjection(existing) && existing.seq >= accepted.position.seq) return;
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
      if (transfer.projection || transfer.projection_patch) {
        browser.cache.projections.set(transfer.scope, shadowProjectionForDeltaTransfer(browser.cache.projections.get(transfer.scope), transfer));
      }
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
  const seq = seqOverride ?? index.logSeqBySpace.get(scope) ?? 0;
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
        active_scope: session?.activeScope ?? null,
        current_location: session?.activeScope ?? null,
        all_locations: session?.activeScope ? [session.activeScope] : []
      } : null,
      inventory
    } : {}),
    subject,
    objects
  };
}

export function applyShadowScopeProjectionPatch(
  baseProjection: unknown,
  patch: ShadowScopeProjectionPatch,
  baseHead?: ShadowCommitAccepted["position"]
): ShadowScopeProjection {
  if (!isShadowScopeProjection(baseProjection)) throw new Error("shadow projection patch requires cached base projection");
  if (baseProjection.scope !== patch.scope || baseProjection.seq !== patch.base.seq) throw new Error("shadow projection patch base mismatch");
  if (baseHead && !shadowScopeHeadsCompatible(baseHead, patch.base)) throw new Error("shadow projection patch head mismatch");
  const projection = {
    ...baseProjection,
    ...(structuredClone(patch.fields) as typeof patch.fields),
    kind: "woo.scope_projection.shadow.v1",
    scope: patch.scope,
    seq: patch.to.seq,
    objects: applyShadowProjectionListPatch(baseProjection.objects, patch.objects)
  } satisfies ShadowScopeProjection;
  if (patch.inventory) {
    projection.inventory = applyShadowProjectionListPatch(baseProjection.inventory ?? [], patch.inventory);
  }
  return projection;
}

function shadowScopeProjectionPatchFromTranscript(
  serialized: SerializedWorld,
  accepted: ShadowCommitAccepted,
  transcript: EffectTranscript,
  baseProjection: ShadowScopeProjection,
  baseHead: ShadowCommitAccepted["position"],
  viewer?: ShadowProjectionViewer
): ShadowScopeProjectionPatch | null {
  const scope = accepted.position.scope;
  if (
    baseHead.scope !== scope ||
    baseHead.epoch !== accepted.position.epoch ||
    baseHead.seq !== accepted.position.seq - 1 ||
    baseProjection.seq !== baseHead.seq
  ) {
    return null;
  }
  const index = shadowSerializedIndex(serialized);
  const scopeObj = index.objects.get(scope);
  const actorObj = viewer?.actor ? index.objects.get(viewer.actor) : undefined;
  const session = viewer?.session ? index.sessions.get(viewer.session) : undefined;
  const changedObjects = transcriptTouchedObjectIds(transcript);
  const fields: ShadowScopeProjectionPatch["fields"] = {};
  setShadowProjectionPatchField(fields, baseProjection, "title", scopeObj?.name ?? scope);
  setShadowProjectionPatchField(fields, baseProjection, "object_count", serialized.objects.length);
  setShadowProjectionPatchField(fields, baseProjection, "contents", scopeObj?.contents ?? []);
  setShadowProjectionPatchField(fields, baseProjection, "seq", accepted.position.seq);
  setShadowProjectionPatchField(fields, baseProjection, "cursor", { spaces: { [scope]: { next_seq: accepted.position.seq + 1 } }, live: { resumable: false } });
  if (viewer) {
    setShadowProjectionPatchField(fields, baseProjection, "viewer", viewer);
    setShadowProjectionPatchField(fields, baseProjection, "self", actorObj ? shadowSerializedObjectSummary(index, actorObj, viewer.actor) : null);
    setShadowProjectionPatchField(fields, baseProjection, "session", viewer.session ? {
      id: viewer.session,
      actor: viewer.actor,
      active_scope: session?.activeScope ?? null,
      current_location: session?.activeScope ?? null,
      all_locations: session?.activeScope ? [session.activeScope] : []
    } : null);
  }
  setShadowProjectionPatchField(fields, baseProjection, "subject", scopeObj ? shadowSerializedObjectSummary(index, scopeObj, viewer?.actor) : null);
  const objects = shadowProjectionListPatchFromRefs(index, baseProjection.objects, shadowProjectionRefs(index, scope, viewer), changedObjects, viewer?.actor);
  const inventory = viewer
    ? shadowProjectionListPatchFromRefs(index, baseProjection.inventory ?? [], actorObj?.contents ?? [], changedObjects, viewer.actor)
    : null;
  return {
    kind: "woo.scope_projection_patch.shadow.v1",
    scope,
    base: structuredClone(baseHead) as ShadowCommitAccepted["position"],
    to: structuredClone(accepted.position) as ShadowCommitAccepted["position"],
    fields,
    objects,
    ...(inventory && shadowProjectionListPatchHasChanges(baseProjection.inventory ?? [], inventory) ? { inventory } : {})
  };
}

function setShadowProjectionPatchField<K extends ShadowScopeProjectionPatchField>(
  fields: ShadowScopeProjectionPatch["fields"],
  baseProjection: ShadowScopeProjection,
  field: K,
  value: ShadowScopeProjection[K]
): void {
  if (!shadowValuesEqual(baseProjection[field], value)) fields[field] = structuredClone(value) as never;
}

function shadowScopeProjectionPatch(
  baseProjection: ShadowScopeProjection,
  baseHead: ShadowCommitAccepted["position"],
  projection: ShadowScopeProjection,
  to: ShadowCommitAccepted["position"]
): ShadowScopeProjectionPatch {
  const fields: ShadowScopeProjectionPatch["fields"] = {};
  for (const field of SHADOW_SCOPE_PROJECTION_PATCH_FIELDS) {
    if (!shadowValuesEqual(baseProjection[field], projection[field])) {
      fields[field] = structuredClone(projection[field]) as never;
    }
  }
  const inventoryChanged = !shadowValuesEqual(baseProjection.inventory ?? [], projection.inventory ?? []);
  return {
    kind: "woo.scope_projection_patch.shadow.v1",
    scope: projection.scope,
    base: structuredClone(baseHead) as ShadowCommitAccepted["position"],
    to: structuredClone(to) as ShadowCommitAccepted["position"],
    fields,
    objects: shadowProjectionListPatch(baseProjection.objects, projection.objects),
    ...(inventoryChanged ? { inventory: shadowProjectionListPatch(baseProjection.inventory ?? [], projection.inventory ?? []) } : {})
  };
}

function shadowProjectionListPatch(base: ScopedObjectSummary[], next: ScopedObjectSummary[]): ShadowProjectionListPatch {
  const baseById = new Map(base.map((item) => [item.id, item] as const));
  const nextById = new Map(next.map((item) => [item.id, item] as const));
  return {
    order: next.map((item) => item.id),
    upsert: next.filter((item) => !shadowValuesEqual(baseById.get(item.id), item)).map((item) => structuredClone(item) as ScopedObjectSummary),
    remove: base.filter((item) => !nextById.has(item.id)).map((item) => item.id)
  };
}

function shadowProjectionListPatchFromRefs(
  index: ShadowSerializedIndex,
  base: ScopedObjectSummary[],
  nextRefs: ObjRef[],
  changedObjects: ReadonlySet<ObjRef>,
  actor?: ObjRef
): ShadowProjectionListPatch {
  const baseById = new Map(base.map((item) => [item.id, item] as const));
  const nextIds = nextRefs.filter((id) => index.objects.has(id));
  const nextById = new Set(nextIds);
  const upsert: ScopedObjectSummary[] = [];
  for (const id of nextIds) {
    if (!baseById.has(id) || shadowProjectionSummaryMayHaveChanged(index, id, changedObjects)) {
      const obj = index.objects.get(id);
      if (obj) upsert.push(shadowSerializedObjectSummary(index, obj, actor));
    }
  }
  return {
    order: nextIds,
    upsert,
    remove: base.filter((item) => !nextById.has(item.id)).map((item) => item.id)
  };
}

function shadowProjectionSummaryMayHaveChanged(
  index: ShadowSerializedIndex,
  objRef: ObjRef,
  changedObjects: ReadonlySet<ObjRef>
): boolean {
  if (changedObjects.size === 0) return false;
  let current = index.objects.get(objRef) ?? null;
  const seen = new Set<ObjRef>();
  while (current && !seen.has(current.id)) {
    if (changedObjects.has(current.id)) return true;
    seen.add(current.id);
    current = current.parent ? index.objects.get(current.parent) ?? null : null;
  }
  return false;
}

function shadowProjectionListPatchHasChanges(base: ScopedObjectSummary[], patch: ShadowProjectionListPatch): boolean {
  if (patch.upsert.length > 0 || patch.remove.length > 0) return true;
  if (base.length !== patch.order.length) return true;
  return base.some((item, index) => item.id !== patch.order[index]);
}

function applyShadowProjectionListPatch(base: ScopedObjectSummary[], patch: ShadowProjectionListPatch): ScopedObjectSummary[] {
  // Base summaries are shared by reference for unchanged rows; projection cache
  // callers must treat summary entries as immutable.
  const byId = new Map(base.map((item) => [item.id, item] as const));
  for (const id of patch.remove) byId.delete(id);
  for (const item of patch.upsert) byId.set(item.id, structuredClone(item) as ScopedObjectSummary);
  return patch.order
    .map((id) => byId.get(id) ?? null)
    .filter((item): item is ScopedObjectSummary => item !== null);
}

function shadowProjectionForDeltaTransfer(baseProjection: WooValue | undefined, transfer: ShadowDeltaTransfer): ShadowScopeProjection {
  if (transfer.projection) return structuredClone(transfer.projection) as ShadowScopeProjection;
  if (transfer.projection_patch) return applyShadowScopeProjectionPatch(baseProjection, transfer.projection_patch);
  if (transfer.applied.length === 0 && transfer.transcript_tail.length === 0 && isShadowScopeProjection(baseProjection)) {
    return structuredClone(baseProjection) as ShadowScopeProjection;
  }
  throw new Error("shadow browser delta missing projection material");
}

function shadowBrowserCachedProjectionHead(browser: ShadowBrowserNode, scope: ObjRef): ShadowCommitAccepted["position"] | undefined {
  for (let index = browser.cache.transfers.length - 1; index >= 0; index -= 1) {
    const transfer = browser.cache.transfers[index];
    if ((transfer.mode === "projection" || transfer.mode === "delta") && transfer.scope === scope) {
      return structuredClone(transfer.to) as ShadowCommitAccepted["position"];
    }
  }
  return undefined;
}

function shadowBrowserCachedProjectionBase(
  browser: ShadowBrowserNode,
  scope: ObjRef,
  head: ShadowCommitAccepted["position"]
): { projection: ShadowScopeProjection; head: ShadowCommitAccepted["position"] } | null {
  const current = browser.cache.projections.get(scope);
  const currentHead = shadowBrowserCachedProjectionHead(browser, scope) ??
    shadowBrowserProjectionHead(current, scope, browser.relay.commit_scope.head.epoch);
  if (currentHead && shadowScopeHeadsCompatible(currentHead, head) && isShadowScopeProjection(current)) {
    return { projection: current, head: currentHead };
  }
  for (let index = browser.cache.transfers.length - 1; index >= 0; index -= 1) {
    const transfer = browser.cache.transfers[index];
    if ((transfer.mode !== "projection" && transfer.mode !== "delta") || transfer.scope !== scope) continue;
    if (!shadowScopeHeadsCompatible(transfer.to, head)) continue;
    if (transfer.mode === "projection") return { projection: transfer.projection, head: transfer.to };
    if (transfer.projection) return { projection: transfer.projection, head: transfer.to };
  }
  return null;
}

function shadowBrowserProjectionHead(value: WooValue | undefined, scope: ObjRef, epoch: number): ShadowCommitAccepted["position"] | undefined {
  if (!isShadowScopeProjection(value) || value.scope !== scope) return undefined;
  // The in-memory shim historically stored projection rows without their head.
  // Keep a seq-only fallback so hot fan-out can still patch older test caches.
  return {
    kind: "woo.scope_head.shadow.v1",
    scope,
    epoch,
    seq: value.seq,
    hash: ""
  };
}

function isShadowScopeProjection(value: unknown): value is ShadowScopeProjection {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === "woo.scope_projection.shadow.v1" &&
    typeof (value as { scope?: unknown }).scope === "string" &&
    typeof (value as { seq?: unknown }).seq === "number" &&
    Array.isArray((value as { objects?: unknown }).objects)
  );
}

function shadowScopeHeadsCompatible(left: ShadowCommitAccepted["position"], right: ShadowCommitAccepted["position"]): boolean {
  return left.scope === right.scope && left.epoch === right.epoch && left.seq === right.seq && (!left.hash || !right.hash || left.hash === right.hash);
}

function shadowValuesEqual(left: unknown, right: unknown): boolean {
  return stableShadowJson(left as WooValue) === stableShadowJson(right as WooValue);
}

type ShadowSerializedIndex = {
  objects: Map<ObjRef, SerializedObject>;
  sessions: Map<string, SerializedSession>;
  indexedObjects: Map<ObjRef, ShadowIndexedObject>;
  logSeqBySpace: Map<ObjRef, number>;
};

type ShadowIndexedObject = {
  record: SerializedObject;
  properties: Map<string, WooValue>;
  propertyDefs: Map<string, PropertyDef>;
};

const SHADOW_SERIALIZED_INDEX_CACHE = new WeakMap<SerializedWorld, ShadowSerializedIndex>();

function shadowSerializedIndex(serialized: SerializedWorld): ShadowSerializedIndex {
  const cached = SHADOW_SERIALIZED_INDEX_CACHE.get(serialized);
  if (cached) return cached;
  const indexedObjects = new Map<ObjRef, ShadowIndexedObject>();
  for (const obj of serialized.objects) {
    indexedObjects.set(obj.id, {
      record: obj,
      properties: new Map(obj.properties),
      propertyDefs: new Map(obj.propertyDefs.map((def) => [def.name, def] as const))
    });
  }
  const index = {
    objects: new Map(serialized.objects.map((obj) => [obj.id, obj])),
    sessions: new Map(serialized.sessions.map((session) => [session.id, session])),
    indexedObjects,
    logSeqBySpace: new Map(serialized.logs.map(([space, entries]) => [
      space,
      entries.reduce((max, entry) => Math.max(max, entry.seq), 0)
    ] as const))
  };
  SHADOW_SERIALIZED_INDEX_CACHE.set(serialized, index);
  return index;
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
    pushObject(session?.activeScope ?? null);
    pushContents(session?.activeScope ?? null);
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
    const indexed = index.indexedObjects.get(current.id);
    for (const name of indexed?.propertyDefs.keys() ?? []) names.add(name);
    for (const name of indexed?.properties.keys() ?? []) names.add(name);
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
    const indexed = index.indexedObjects.get(current.id);
    if (!hasValue) {
      if (indexed?.properties.has(name)) {
        value = indexed.properties.get(name);
        hasValue = true;
      }
    }
    const def = indexed?.propertyDefs.get(name);
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
    features: ["shadow-envelope", "shadow-catchup", "shadow-exec-ads", "shadow-multiplex"],
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
    projection: "projection" in transfer ? transfer.projection ?? null : null,
    projection_patch: transfer.mode === "delta" ? transfer.projection_patch ?? null : null,
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
  const noOpDelta = transfer.mode === "delta" &&
    !transfer.projection &&
    !transfer.projection_patch &&
    transfer.applied.length === 0 &&
    transfer.transcript_tail.length === 0;
  if (transfer.mode === "delta" && !noOpDelta && Boolean(transfer.projection) === Boolean(transfer.projection_patch)) {
    throw new Error("shadow browser delta must carry exactly one projection material");
  }
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
