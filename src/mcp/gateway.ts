// MCP gateway — per-process state manager for the streamable-HTTP transport.
// Owns ONE McpHost per WooWorld so the built-in MCP control handlers
// only register once. Each MCP session binds a queue inside that host and
// gets its own server + transport.
//
// First-request auth uses either the `Mcp-Token` header or, for MCP clients
// that only expose bearer-token configuration, `Authorization: Bearer <token>`.
// The token value is one of the woo token classes: guest:, bearer:, apikey:,
// wizard:. The server resolves it to a woo session, generates an
// Mcp-Session-Id, and binds a McpHost queue to it. Subsequent requests carry
// Mcp-Session-Id.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { EffectTranscript } from "../core/effect-transcript";
import { buildSerializedAuthorityCellSlice, cellProvenanceFromAuthoritySlice, combineSerializedAuthoritySlices, filterAuthorityToReadClosure, serializedWorldFromAuthoritySlice } from "../core/authority-slice";
import { wooError, type AppliedFrame, type AuthorityReconstructionTrigger, type DirectResultFrame, type ErrorFrame, type ErrorValue, type Message, type MetricEvent, type ObjRef, type Session, type WooValue } from "../core/types";
import { normalizeError, type WooWorld } from "../core/world";
import type { SerializedAuthoritySlice, SerializedObject, SerializedSession } from "../core/repository";
import { projectionDeltaMissingWrites, type ProjectionWrite } from "../core/projection-delta";
import { createMcpServer } from "./server";
import { McpHost, type McpAcceptedFrameAudience, type McpBroadcastHooks, type McpDispatchHooks, type McpDispatchOptions, type McpToolManifestHooks } from "./host";
import { createShadowBrowserRelayShim } from "../core/shadow-browser-node";
import {
  applyAcceptedFrameToDerivedRelayCache,
  applyAcceptedFrameToRelayCache,
  installShadowAcceptedWriteTransferIntoRelayCache,
  installShadowCellPageTransferAsAuthority,
  mergeAuthorityIntoRelayCache,
  type ShadowRelayCache
} from "../core/shadow-relay-cache";
import type { ShadowTurnCall } from "../core/shadow-turn-call";
import {
  serializedFor,
  shadowCommitScopeObject,
  type ShadowCommitAccepted,
  type ShadowScopeHead
} from "../core/shadow-commit-scope";
import { planningCellKey } from "../core/planning-world";
import { affectedTranscriptScopes } from "../core/v2-fanout-projection";
import type { ShadowTurnExecReply } from "../core/shadow-turn-exec";
import {
  V2_COMMIT_SCOPE_SNAPSHOT_REQUIRED,
  buildExecutionCapsule,
  executorEnvelopeId,
  submitTurnIntent,
  executorAuthorityPayload,
  type ExecutionCapsule,
  type ExecutorAuthorityPayload,
  type SubmitTurnPhaseTimer
} from "../core/executor";

const MCP_TOKEN_HEADER = "mcp-token";
const MCP_SESSION_HEADER = "mcp-session-id";
const AUTHORIZATION_HEADER = "authorization";
const REMOTE_ACCEPTED_LRU_LIMIT = 8192;
const REMOTE_PENDING_LIMIT = 1024;
const REMOTE_PENDING_MAX_AGE_MS = 60_000;

function isV2CommitScopeSnapshotRequiredError(err: unknown): boolean {
  if (!err || typeof err !== "object" || Array.isArray(err)) return false;
  const code = (err as { code?: unknown }).code;
  if (code === V2_COMMIT_SCOPE_SNAPSHOT_REQUIRED) return true;
  const value = (err as { value?: unknown }).value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const nested = (value as { error?: unknown }).error;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return false;
  return (nested as { code?: unknown }).code === V2_COMMIT_SCOPE_SNAPSHOT_REQUIRED;
}

function assertProjectionWritesComplete(
  delta: NonNullable<ShadowCommitAccepted["projection_delta"]>,
  writes: readonly NonNullable<ShadowCommitAccepted["projection_writes"]>[number][],
  scope: ObjRef,
  source: "fanout" | "mcp"
): void {
  const missing = projectionDeltaMissingWrites(delta, writes);
  if (missing.length === 0) return;
  throw wooError("E_PROJECTION_INCOMPLETE", "projection_delta upserts/deletes are missing row-body-complete projection_writes", {
    scope,
    source,
    missing
  });
}

type SessionEntry = {
  woo: Session;
  v2Token: string;
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
  dispose: () => void;
};

type V2ScopeEnsureOptions = {
  requireCommitScopeOpen?: boolean;
  forceLegacyOpen?: boolean;
  timing?: SubmitTurnPhaseTimer;
  timingLabelPrefix?: string;
  ownerAuthorityObjectIds?: ObjRef[];
};

export type McpV2ClientHooks = {
  open: (scope: ObjRef, body: McpV2OpenBody) => Promise<McpV2OpenResult>;
  envelope: (scope: ObjRef, body: McpV2EnvelopeBody, context?: { timing?: SubmitTurnPhaseTimer }) => Promise<McpV2EnvelopeResult>;
  authorityPayload?: (
    extraObjectIds: ObjRef[],
    options?: {
      useCommitScopeSnapshotForRemoteAuthority?: boolean;
      tolerateRemoteFailures?: boolean;
      directorySessionScopes?: ObjRef[];
      scopeContentExpansionRoots?: ObjRef[];
      reconstructionReason?: "warm_turn_refresh" | "cold_open" | "missing_state_repair";
      reconstructionTrigger?: AuthorityReconstructionTrigger;
      reconstructionScope?: ObjRef;
      forceOwnerObjectIds?: ObjRef[];
    }
  ) => Promise<ReturnType<typeof executorAuthorityPayload>>;
  executionCapsuleOpen?: boolean;
  // When set, ordinary same-scope envelopes are sent WITHOUT the ~3MB top-level
  // authority slice (and session_objects). The CommitScopeDO is the authority for
  // its own scope and rehydrates from its durable snapshot, so a warm/snapshotted
  // scope never needs the slice; a truly-cold scope replies E_SNAPSHOT_REQUIRED
  // and submitEnvelope retries with the full body (same path the capsule
  // cold-miss already uses). Cross-scope planned-transcript commits are the
  // exception: their selected commit scope validates a transcript planned
  // elsewhere, so the narrow transcript authority remains load-bearing.
  slimWarmEnvelope?: boolean;
  // Cloudflare sparse MCP shards enable this. Local/dev MCP gateways usually plan
  // from an authoritative in-process world whose cells do not carry owner
  // source_host stamps, so the resolution-owner guard stays off by default.
  enforceResolutionOwnerRepair?: boolean;
  // B-i: when set, planned-transcript (cross-scope) envelopes carry only the
  // turn's read closure (actor + session + transcript-touched cells + lineage)
  // instead of the full scope-wide authority slice. The validation contract and
  // E_SNAPSHOT_REQUIRED cold-scope escape are unchanged; only the unread bulk
  // of the slice is withheld. Flag: WOO_V2_READ_CLOSURE_ENVELOPE.
  readClosureEnvelope?: boolean;
};

// Strip the ~3MB authority slice (and legacy session_objects) from ordinary
// same-scope envelope bodies for the slim warm path. A planned-transcript
// commit deliberately executes against a different commit scope than the one
// that planned the turn; its top-level authority is the validation seed for
// actor/session/read cells missing from that scope's durable snapshot, so it is
// not safe to slim.
export function slimMcpEnvelopeBody(body: McpV2EnvelopeBody): McpV2EnvelopeBody {
  if (body.planned_transcript_commit === true) return body;
  const { authority, session_objects, ...rest } = body;
  void session_objects;
  // Authority-bearing bodies leave the top-level `sessions` empty because the
  // receiver reads `authority.sessions` (see executorEnvelopeBody). Slimming
  // removes the authority slice, so carry its session rows forward as the
  // top-level fallback the CommitScopeDO turn path reads once `authority` is
  // gone. Without this the slimmed body would arrive with neither copy.
  return { ...rest, sessions: authority?.sessions ?? rest.sessions ?? [], session_objects: [] };
}

// B-i: filter a planned-transcript envelope body's authority to the turn's
// read closure (VTN8.3). The closure = pages for (actor ∪ session ∪
// transcript-touched cells ∪ their write pre-images) ∪ lineage_closure of
// those objects. `closureObjectIds` is the set computed by the executor
// (executorAuthorityObjectIds + transcript ids + repairObjectIds); the session
// filter covers only the submitting session and session actors in the closure.
//
// The `planned_transcript_commit: true` flag is preserved so the CommitScopeDO
// still processes this as a planned-transcript commit. The E_SNAPSHOT_REQUIRED
// cold-scope escape in submitEnvelope retries with the FULL body and is
// unchanged (the `envelopeBody` variable retains the unfiltered authority for
// that path).
//
// Only applies to cell-slice authority (the deployed format). Legacy
// object-slice authority falls through unchanged so the function is safe to
// call unconditionally.
export function closureMcpEnvelopeBody(
  body: McpV2EnvelopeBody,
  closureObjectIds: ReadonlySet<ObjRef>,
  sessionIds: readonly string[]
): McpV2EnvelopeBody {
  if (!body.authority || body.planned_transcript_commit !== true) return body;
  const closureAuthority = filterAuthorityToReadClosure(body.authority, closureObjectIds, sessionIds);
  return {
    ...body,
    authority: closureAuthority,
    // session_objects is legacy-empty on authority-bearing bodies (see executorEnvelopeBody).
    session_objects: []
  };
}

export type McpV2OpenBody = {
  scope: ObjRef;
  node: string;
  token: string;
  session: string;
  actor: ObjRef;
  open_protocol?: "head_session.v1";
  known_head?: ShadowScopeHead | null;
  sessions: ReturnType<WooWorld["exportSessions"]>;
  session_objects: ReturnType<WooWorld["exportObjects"]>;
  authority?: SerializedAuthoritySlice;
  serialized?: ReturnType<WooWorld["exportWorld"]>;
};

export type McpV2OpenResult = {
  ok: true;
  relay: string;
  head?: ShadowScopeHead;
};

export type McpV2EnvelopeBody = {
  scope: ObjRef;
  node: string;
  token: string;
  session: string;
  actor: ObjRef;
  sessions: ReturnType<WooWorld["exportSessions"]>;
  session_objects: ReturnType<WooWorld["exportObjects"]>;
  authority?: SerializedAuthoritySlice;
  execution_capsule?: ExecutionCapsule;
  envelope: string;
  planned_transcript_commit?: boolean;
};

export type McpV2EnvelopeResult = {
  ok: true;
  reply: string | null;
  head?: ShadowScopeHead;
  local_host_materialized?: {
    hostKey: string;
    gatewayHost?: boolean;
  } | null;
  accepted_audience?: McpAcceptedFrameAudience;
};

type V2ScopeClient = {
  scope: ObjRef;
  relay: ShadowRelayCache;
  commitScopeOpenedSessions: Set<string>;
  openedSessions: Set<string>;
  openingSessions: Map<string, Promise<void>>;
  ownerPrefetchedIds: Set<ObjRef>;
};

type RemoteAcceptedCommit = {
  commit: ShadowCommitAccepted;
  transcript: EffectTranscript;
  originSessionId: string | null;
  audience?: McpAcceptedFrameAudience;
  receivedAt: number;
  routed?: boolean;
};

function serializedSessionForMcpEntry(entry: SessionEntry): SerializedSession {
  const session = entry.woo;
  return {
    id: session.id,
    actor: session.actor,
    started: session.started,
    expiresAt: session.expiresAt,
    lastDetachAt: session.lastDetachAt,
    tokenClass: session.tokenClass,
    activeScope: session.activeScope,
    ...(session.apikeyId !== undefined ? { apikeyId: session.apikeyId } : {})
  };
}

function mcpDirectorySessionScopesForAuthority(entry: SessionEntry, ...scopes: Array<ObjRef | null | undefined>): ObjRef[] {
  const out = new Set<ObjRef>();
  const add = (scope: ObjRef | null | undefined): void => {
    if (!scope || scope === "#-1") return;
    out.add(scope);
  };
  add(entry.woo.activeScope ?? null);
  for (const scope of scopes) add(scope);
  return Array.from(out).sort();
}

function mergeObjRefs(...lists: readonly ObjRef[][]): ObjRef[] {
  const ids = new Set<ObjRef>();
  for (const list of lists) for (const id of list) ids.add(id);
  return Array.from(ids).sort();
}

function ensureSerializedSession(sessions: readonly SerializedSession[], session: SerializedSession): SerializedSession[] {
  const out = sessions.map((item) => structuredClone(item) as SerializedSession);
  const existing = out.find((item) => item.id === session.id);
  if (!existing) {
    out.push(structuredClone(session) as SerializedSession);
  } else if (existing.actor !== session.actor) {
    const index = out.indexOf(existing);
    out[index] = structuredClone(session) as SerializedSession;
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function cachedAuthorityPageKey(page: { object: ObjRef; page: string; name?: string }): string {
  const name = page.page === "property_cell" || page.page === "verb_bytecode" ? page.name ?? "" : "";
  return `${page.object}:${page.page}:${name}`;
}

// B7: does this relay's planning cache hold the OWNER's authoritative row for
// `id`? True only when the object row is resident AND both tracked cells
// (object_lineage + object_live — exactly the cells the CA11.2 movement-
// destination guard checks) carry recorded `authoritative` provenance. A
// topology pre-seed (projection) or accepted-write warm fill (cache) does NOT
// qualify — the owner-prefetch exists to upgrade those, so they stay residue.
function relayHoldsOwnerAuthority(relay: ShadowRelayCache, id: ObjRef): boolean {
  const provenance = relay.commit_scope.cellProvenance;
  if (!provenance) return false;
  if (!shadowCommitScopeObject(relay.commit_scope, id)) return false;
  return provenance.get(planningCellKey(id, "object_lineage"))?.source === "authoritative" &&
    provenance.get(planningCellKey(id, "object_live"))?.source === "authoritative";
}

// B7: lift one object's cell pages out of a donor scope client's relay into an
// authority slice the requesting client can merge. The donor holds the owner's
// rows for `id` (relayHoldsOwnerAuthority gates the call), so each page is
// re-served with the donor's RECORDED provenance — the tracked identity/live
// cells keep their original `authoritative` stamp (with the original owner
// `source_host`): this is a faithful process-local copy of pages the owner
// served, content-addressed and re-hashed by the same line_map-blind preimage
// owners use (CA12.2), not fabricated authority for derived data. Its staleness
// window is the same one the donor relay itself accepts (CA6), and commit-time
// cell-version validation remains the arbiter. Untracked pages (props/verbs)
// have no recorded provenance and default to `cache`. The slice carries the
// REQUESTING relay's sessions/counters/tombstones unchanged because the
// authority merge REPLACES the session list — the donor must not contribute
// its own session view.
function warmRelayAuthoritySliceForObject(
  requester: ShadowRelayCache,
  donor: ShadowRelayCache,
  id: ObjRef,
  metric: (event: MetricEvent) => void
): SerializedAuthoritySlice {
  const row = shadowCommitScopeObject(donor.commit_scope, id);
  if (!row) throw new Error(`warm owner-prefetch donor has no row for ${id}`);
  const requesterSerialized = serializedFor(requester.commit_scope, { reason: "mcp_owner_prefetch_warm", metric });
  const provenance = donor.commit_scope.cellProvenance;
  return buildSerializedAuthorityCellSlice({
    sessions: requesterSerialized.sessions,
    objects: [row],
    counters: {
      objectCounter: requesterSerialized.objectCounter,
      parkedTaskCounter: requesterSerialized.parkedTaskCounter,
      sessionCounter: requesterSerialized.sessionCounter
    },
    tombstones: requesterSerialized.tombstones,
    pageProvenance: (page) => provenance?.get(cachedAuthorityPageKey(page)) ?? { source: "cache" }
  });
}

// A2 / CA4 durable owner delivery: collect the ObjRef ids of objects that the
// transcript MOVES INTO `destScope` or CREATES IN `destScope`, PLUS the
// transitive contents of any actor moving into the scope (their carried inventory).
//
// The inventory case is the key one: when an actor carries an object from room A
// to room B, the transcript records actor:location A→B but the carried item was
// already moved to the actor in a prior turn. The current transcript does NOT
// contain a move for the item (its location is the actor, not room B). But room
// B's relay still needs the item's class lineage to dispatch verbs on it once it
// arrives. We collect it from the origin relay's actor.contents list.
//
// `originLookup` supplies the origin relay's object row by id (needed for the
// contents walk). Absent if the origin relay is not available.
function incomingObjectIds(
  destScope: ObjRef,
  transcript: EffectTranscript,
  originLookup?: (id: ObjRef) => { contents: ObjRef[] } | undefined
): Set<ObjRef> {
  const ids = new Set<ObjRef>();
  for (const move of transcript.moves) {
    if (move.to === destScope) {
      ids.add(move.object);
      // If an actor is moving into this scope, also include their carried contents
      // (inventory). The contents list from the origin relay reflects the state
      // at move time — anything already in the actor's inventory. One level deep
      // is sufficient: the carried item's own contents are part of its authority,
      // not cross-scope to this relay; and carried sub-containers are rare.
      if (originLookup) {
        const carried = originLookup(move.object)?.contents ?? [];
        for (const item of carried) ids.add(item);
      }
    }
  }
  for (const create of transcript.creates) {
    if (create.location === destScope) ids.add(create.object);
  }
  return ids;
}

// A2 / CA4: collect the transitive parent chain (lineage closure) of `startId`
// from `objectsById`. Returns all ancestor ids (not including `startId` itself,
// which the transcript delta already carries). Stops when a parent is absent —
// the destination relay will call the fallback repair path for truly missing
// objects. Bounded by the class chain depth (a few dozen levels at most);
// cycles are prevented by the `visited` guard.
function transitiveParentIds(startId: ObjRef, objectsById: (id: ObjRef) => { parent: ObjRef | null } | undefined): ObjRef[] {
  const parents: ObjRef[] = [];
  const visited = new Set<ObjRef>();
  visited.add(startId);
  let current = objectsById(startId)?.parent ?? null;
  while (current !== null) {
    if (visited.has(current)) break; // cycle guard
    visited.add(current);
    parents.push(current);
    current = objectsById(current)?.parent ?? null;
  }
  return parents;
}

// A2 / CA4: merge the lineage closure of objects incoming to `destScope` from
// the origin relay into the destination relay, using `cache` provenance.
//
// Why `cache` provenance: we are copying pages from the origin relay's planning
// snapshot, which itself holds them as `cache` (warm fill from the accepted
// write transfer, B7). This is NOT the owner's authoritative row. CA11 precedence
// ensures a later owner-authoritative page still displaces this fill, so the merge
// is strictly additive and safe. A relay that already holds the page at equal or
// higher rank keeps its current value (the already-current hash guard in
// mergeSerializedAuthoritySlice is a no-op for matching hashes).
//
// What we send: the ANCESTOR class-definition rows of each incoming object —
// the object itself is NOT included (the delta frame handles its live state).
// Specifically, the transitive parent chain (grandparent, great-grandparent, …)
// up to the root class is merged. That is sufficient for parentWalkLookup to
// resolve the full chain and eliminate dangling_parent_ref.
//
// Idempotent: merging the same pages twice is a no-op (same hash → skip).
function mergeIncomingObjectLineageClosure(
  destScope: ObjRef,
  transcript: EffectTranscript,
  originRelay: ShadowRelayCache,
  destRelay: ShadowRelayCache,
  metric: (event: MetricEvent) => void
): void {
  const lookup = (id: ObjRef) => shadowCommitScopeObject(originRelay.commit_scope, id);
  const incoming = incomingObjectIds(destScope, transcript, lookup);
  if (incoming.size === 0) return;

  // Collect only the ANCESTORS (parent chain) of each incoming object — do NOT
  // include the incoming objects themselves. The delta frame
  // (applyAcceptedFrameToDerivedRelayCache) already applies the incoming objects'
  // live state (location/contents/properties). Including them here would merge a
  // stale `object_live` page from the origin relay into the dest relay, clobbering
  // the delta frame's correct value (or triggering a spurious serialized_generation
  // increment when the hashes differ). Only the ancestor class-definition rows are
  // needed to allow parentWalkLookup to resolve the verb chain.
  //
  // Exception: an object CREATED in the dest scope (transcript.creates) was not
  // in the dest relay at all; it still needs its own lineage page so the relay
  // can materialize the new row. Those are included via the creates path in
  // incomingObjectIds, but their parent chain is all we need here — the create
  // write itself is applied by the delta frame.
  const lineageIds = new Set<ObjRef>();
  for (const id of incoming) {
    for (const parentId of transitiveParentIds(id, lookup)) {
      lineageIds.add(parentId);
    }
  }
  if (lineageIds.size === 0) return;

  // Build a lineage-only slice for ancestors that are MISSING from the dest relay.
  // Only merge what is actually absent — if all ancestors are already present
  // (common in full-world seeds), skip the merge entirely. This prevents a
  // spurious serialized_generation increment on the dest relay (mergeAuthorityInto-
  // RelayCache always increments generation when it detects any change, and would
  // also trigger pruneRelayPresentationStubs on a freshly-seeded relay that has
  // not yet had its cellProvenance populated). Provenance is `cache` — a derived
  // copy from the origin relay, not the owner's authoritative row. CA11 precedence
  // means a later owner-authoritative page still displaces this fill.
  const objects: SerializedObject[] = [];
  for (const id of lineageIds) {
    if (shadowCommitScopeObject(destRelay.commit_scope, id)) continue; // already present
    const row = shadowCommitScopeObject(originRelay.commit_scope, id);
    if (row) objects.push(row);
  }
  if (objects.length === 0) return;

  const destSerialized = serializedFor(destRelay.commit_scope, {
    reason: "a2_lineage_closure",
    metric
  });
  const lineageSlice = buildSerializedAuthorityCellSlice({
    sessions: destSerialized.sessions,
    objects,
    counters: {
      objectCounter: destSerialized.objectCounter,
      parkedTaskCounter: destSerialized.parkedTaskCounter,
      sessionCounter: destSerialized.sessionCounter
    },
    tombstones: destSerialized.tombstones,
    // A2: all pages are `cache` — we are copying from the origin relay's view,
    // not from the object's authoritative owner. CA11 precedence means a later
    // owner-authoritative row still displaces these fill pages; meanwhile they
    // ensure parentWalkLookup can resolve the chain and emit zero dangling_parent_ref.
    pageProvenance: () => ({ source: "cache" })
  });
  mergeAuthorityIntoRelayCache(destRelay, lineageSlice, {
    reason: "a2_lineage_closure",
    metric
  });
}

export type McpGatewayOptions = {
  serverName?: string;
  serverVersion?: string;
  broadcasts?: McpBroadcastHooks;
  dispatch?: McpDispatchHooks;
  toolManifests?: McpToolManifestHooks;
  // Persist an accepted fanout commit into a durable projection cache (the
  // worker gateway's SQL rows). Invoked from applyRemoteAccepted, i.e. in
  // contiguous scope-sequence order including drained out-of-order frames, so
  // the durable cache advances in the same order as in-memory routing. It must
  // NOT be called before sequencing: a seq-2-before-seq-1 arrival would
  // otherwise advance the cache head to 2 and let the later seq 1 be dropped by
  // the cache's head-idempotency guard.
  persistAcceptedProjection?: (commit: ShadowCommitAccepted, transcript: EffectTranscript) => void;
  // Durable head_seq of the projection cache for a scope, or null if the cache
  // has never seen it. Used as the fanout-sequencing fallback when no in-memory
  // relay exists (a hibernated/cold peer shard that received fanout before its
  // v2 relay re-opened): without it, remoteExpectedSeq is null and frames apply
  // in arrival order, letting persistAcceptedProjection write seq N+1 before
  // seq N and drop seq N at the cache's head-idempotency guard.
  durableProjectionHeadSeq?: (scope: ObjRef) => number | null;
  onSessionClosed?: (sessionId: string) => void | Promise<void>;
  v2?: McpV2ClientHooks;
};

export class McpGateway {
  readonly host: McpHost;
  private sessions = new Map<string, SessionEntry>();
  private v2Scopes = new Map<ObjRef, V2ScopeClient>();
  private v2ScopeInitializers = new Map<ObjRef, Promise<V2ScopeClient>>();
  private remoteAccepted = new Set<string>();
  private remoteAcceptedOrder: string[] = [];
  private remotePending = new Map<ObjRef, Map<number, RemoteAcceptedCommit>>();
  private remotePendingCount = 0;

  constructor(private world: WooWorld, private options: McpGatewayOptions = {}) {
    const dispatch = options.v2 ? {
      direct: async (sessionId: string, actor: ObjRef, target: ObjRef, verb: string, args: WooValue[], scope?: ObjRef | null, persistence?: "durable" | "live", options?: McpDispatchOptions) =>
        await this.invokeV2Direct(sessionId, actor, target, verb, args, scope, persistence, options),
      call: async (sessionId: string, actor: ObjRef, space: ObjRef, message: Message, options?: McpDispatchOptions) =>
        await this.invokeV2Call(sessionId, actor, space, message, options)
    } satisfies McpDispatchHooks : options.dispatch;
    this.host = new McpHost(world, dispatch, options.toolManifests);
    if (options.broadcasts) this.host.setBroadcastHooks(options.broadcasts);
  }

  setBroadcastHooks(hooks: McpBroadcastHooks): void {
    this.host.setBroadcastHooks(hooks);
  }

  async handle(request: Request): Promise<Response> {
    const headers = request.headers;
    const startedAt = Date.now();
    const probe = await jsonRpcProbeFromRequest(request);

    if (request.method === "DELETE") {
      const id = headers.get(MCP_SESSION_HEADER);
      if (id) {
        this.closeSession(id);
        await this.options.onSessionClosed?.(id);
      }
      this.world.recordMetric({ kind: "mcp_request", method: "session_delete", ms: Date.now() - startedAt, status: "ok" });
      return new Response(null, { status: 204 });
    }

    const sessionHeader = headers.get(MCP_SESSION_HEADER);
    let entry: SessionEntry | undefined = sessionHeader ? this.sessions.get(sessionHeader) : undefined;

    if (sessionHeader && !entry) {
      // The in-memory `sessions` map is per-DO-instance and lost across
      // hibernation. Because we minted the MCP session id from the woo
      // session id (see `bind` below), the persisted world.sessions table
      // still has the actor binding — resume by rebinding a fresh transport
      // around it, with a synthetic initialize so the SDK transport ends up
      // in the same `_initialized` state the original handshake left it in.
      const resumed = await this.tryResume(sessionHeader);
      if (!resumed) {
        this.world.recordMetric({ kind: "mcp_request", method: probe.method ?? "unknown", tool: probe.tool, ms: Date.now() - startedAt, status: "error" });
        return mcpError(request, 404, -32001, "E_NOSESSION", "MCP session not found; reinitialize");
      }
      entry = resumed;
    }

    if (!entry) {
      if (request.method !== "POST") {
        this.world.recordMetric({ kind: "mcp_request", method: probe.method ?? "unknown", tool: probe.tool, ms: Date.now() - startedAt, status: "error" });
        return mcpError(request, 401, -32001, "E_NOSESSION", "mcp gateway requires Mcp-Session-Id (or POST + auth token to initialize)");
      }
      const token = authTokenFromHeaders(headers);
      if (!token) {
        this.world.recordMetric({ kind: "mcp_request", method: probe.method ?? "unknown", tool: probe.tool, ms: Date.now() - startedAt, status: "error" });
        return mcpError(request, 401, -32001, "E_NOSESSION", "first MCP request must include Mcp-Token or Authorization: Bearer <token>");
      }
      if (!isAcceptedWooAuthToken(token)) {
        this.world.recordMetric({ kind: "mcp_request", method: probe.method ?? "unknown", tool: probe.tool, ms: Date.now() - startedAt, status: "error" });
        return mcpError(request, 401, -32001, "E_NOSESSION", "MCP auth token must be guest:, session:, wizard:, or apikey:");
      }
      try {
        const woo = this.world.auth(token);
        entry = this.bind(woo);
      } catch (err) {
        const error = err as { code?: string; message?: string };
        this.world.recordMetric({ kind: "mcp_request", method: probe.method ?? "unknown", tool: probe.tool, ms: Date.now() - startedAt, status: "error" });
        return mcpError(request, 401, -32001, error.code ?? "E_NOSESSION", error.message ?? "auth failed");
      }
    }

    try {
      // MCP sessions are long-lived HTTP sessions, not WebSockets. Keep the
      // in-memory activity clock fresh on every protocol request so a warm
      // gateway instance does not reap an active queue between durable turns.
      this.world.touchSessionInput(entry.woo.id);
      const response = await entry.transport.handleRequest(withRequiredMcpAccept(request));
      const transportId = entry.transport.sessionId;
      if (transportId && !this.sessions.has(transportId)) {
        this.sessions.set(transportId, entry);
        this.host.bindSession(transportId, entry.woo.actor);
      }
      this.world.recordMetric({ kind: "mcp_request", method: probe.method ?? "unknown", tool: probe.tool, ms: Date.now() - startedAt, status: "ok" });
      return response;
    } catch (err) {
      const error = err as { code?: string; message?: string };
      this.world.recordMetric({ kind: "mcp_request", method: probe.method ?? "unknown", tool: probe.tool, ms: Date.now() - startedAt, status: "error" });
      return mcpError(request, 500, -32603, error.code ?? "E_INTERNAL", error.message ?? "internal MCP gateway error");
    }
  }

  // ----- broadcast routing — called by the host runtime so external
  // observations reach MCP-attached agents the same way they reach WS clients.

  routeAppliedFrame(frame: AppliedFrame, originSessionId?: string | null): void {
    this.host.routeAppliedFrame(frame, originSessionId ?? null);
  }

  routeLiveEvents(result: DirectResultFrame, originSessionId?: string | null): void {
    this.host.routeLiveEvents(result, originSessionId ?? null);
  }

  closeSession(id: string, options: { unbind?: boolean } = {}): void {
    const entry = this.sessions.get(id);
    if (entry) {
      entry.dispose();
      void entry.transport.close().catch(() => {});
      this.sessions.delete(id);
    }
    if (options.unbind !== false) this.host.unbindSession(id);
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  // Visible for tests / dev introspection: bind a session id directly without
  // going through the HTTP transport. Used by tests that drive the host API
  // without an MCP client.
  bindActorSession(sessionId: string, actor: ObjRef): void {
    this.host.bindSession(sessionId, actor);
  }

  acceptRemoteV2Commit(
    scope: ObjRef,
    commit: ShadowCommitAccepted,
    transcript: EffectTranscript,
    originSessionId?: string | null,
    audience?: McpAcceptedFrameAudience
  ): void {
    const commitScope = commit.position.scope;
    const key = remoteAcceptedKey(commit);
    // Diagnostic: log every entry to acceptRemoteV2Commit so we can see whether
    // a peer shard is even reaching this code path for the cross-actor smoke
    // (Bug A — peer-not-seeing-observation). The previous metrics confirmed
    // the sender's selector chose remote shards; this confirms the receiver.
    const dedupedAlready = this.remoteAccepted.has(key);
    this.world.recordMetric({
      kind: "mcp_remote_commit_received",
      scope,
      commit_scope: commitScope,
      seq: commit.position.seq,
      origin_session: originSessionId ?? null,
      observations: commit.observations.length,
      queue_count: this.host.queueCount(),
      dedup_skipped: dedupedAlready
    });
    if (dedupedAlready) return;
    const pending = this.remotePending.get(commitScope);
    if (pending?.has(commit.position.seq)) return;

    this.pruneRemotePending();
    const entry: RemoteAcceptedCommit = { commit, transcript, originSessionId: originSessionId ?? null, audience, receivedAt: Date.now() };
    const expectedSeq = this.remoteExpectedSeq(commitScope);
    if (expectedSeq === null) {
      this.applyRemoteAccepted(scope, entry);
      return;
    }
    if (commit.position.seq < expectedSeq) {
      this.rememberRemoteAccepted(key);
      return;
    }
    if (commit.position.seq > expectedSeq) {
      if (entry.audience) {
        this.routeRemoteAcceptedFrame(entry);
        entry.routed = true;
      }
      this.queueRemoteAccepted(commitScope, entry);
      return;
    }
    this.applyRemoteAccepted(scope, entry);
    this.drainRemoteAccepted(scope, commitScope);
  }

  acceptRemoteV2Live(scope: ObjRef, transcript: EffectTranscript, originSessionId?: string | null): void {
    const key = remoteLiveAcceptedKey(scope, transcript);
    const dedupedAlready = this.remoteAccepted.has(key);
    // Same shape as the commit-path metric above: log every live-event receipt
    // on a peer shard so we can see whether the live-fanout path is reaching
    // the receiver before the audience filter rejects.
    this.world.recordMetric({
      kind: "mcp_remote_live_received",
      scope,
      origin_session: originSessionId ?? null,
      observations: transcript.observations.length,
      queue_count: this.host.queueCount(),
      dedup_skipped: dedupedAlready
    });
    if (dedupedAlready) return;
    this.rememberRemoteAccepted(key);
    this.host.routeLiveEvents(liveFrameFromTranscript(scope, transcript), originSessionId ?? null);
  }

  private applyRemoteAccepted(scope: ObjRef, entry: RemoteAcceptedCommit): void {
    const projectionWrites = entry.commit.projection_writes ?? [];
    if (entry.commit.projection_delta) {
      assertProjectionWritesComplete(entry.commit.projection_delta, projectionWrites, entry.commit.position.scope, "fanout");
    }
    // Persist into the durable projection cache before in-memory routing, and
    // only here — this runs in contiguous sequence order (including drained
    // out-of-order frames), so the cache head advances seq by seq and no frame
    // is dropped by the cache's head-idempotency guard.
    this.options.persistAcceptedProjection?.(entry.commit, entry.transcript);
    this.rememberRemoteAccepted(remoteAcceptedKey(entry.commit));
    const client = this.v2Scopes.get(scope);
    if (client) {
      // This relay OWNS the frame's scope (fanout for its own commit) — advance head.
      applyAcceptedFrameToRelayCache(client.relay, entry.commit, entry.transcript, { advanceHead: true });
    }
    if (entry.commit.projection_delta) {
      // Worker gateways persist accepted fanout into SQL before calling this
      // method, but MCP delivery still uses the in-memory WooWorld as its
      // routing cache (session.activeScope, subscribers, reachable objects).
      // Apply the row-body-complete projection writes without persistence so
      // routing sees the accepted state while durable projection ownership
      // stays in the SQL cache and no transcript replay is reintroduced.
      this.applyGatewayProjectionWrites(projectionWrites, entry.transcript);
      this.world.recordMetric({
        kind: "gateway_projection_apply",
        scope: entry.commit.position.scope,
        rows: projectionWrites.length,
        projection_bytes: entry.commit.projection_delta?.projection_bytes ?? 0,
        source: "fanout"
      });
    } else {
      this.world.applyCommittedShadowTranscript(entry.transcript);
    }
    this.propagateTranscriptToOtherScopes(entry.commit.position.scope, entry.commit, entry.transcript);
    if (!entry.routed) this.routeRemoteAcceptedFrame(entry);
  }

  private routeRemoteAcceptedFrame(entry: RemoteAcceptedCommit): void {
    this.host.routeShadowAcceptedFrame(entry.commit, entry.originSessionId, entry.transcript, entry.audience);
  }

  private drainRemoteAccepted(scope: ObjRef, commitScope: ObjRef): void {
    const pending = this.remotePending.get(commitScope);
    if (!pending) return;
    while (true) {
      const expectedSeq = this.remoteExpectedSeq(commitScope);
      if (expectedSeq === null) break;
      const entry = pending.get(expectedSeq);
      if (!entry) break;
      pending.delete(expectedSeq);
      this.remotePendingCount -= 1;
      this.applyRemoteAccepted(scope, entry);
    }
    if (pending.size === 0) this.remotePending.delete(commitScope);
  }

  private remoteExpectedSeq(scope: ObjRef): number | null {
    // The in-memory relay head is authoritative when a relay is open. With no
    // relay (cold/hibernated shard), fall back to the durable projection-cache
    // head so fanout still sequences and drains in order rather than applying
    // in arrival order. Only when neither exists (a scope never seen by this
    // shard) is there no expected seq; a single mid-stream delta cannot build a
    // complete projection anyway, and the descriptor read path refreshes it.
    const relayHead = this.v2Scopes.get(scope)?.relay.commit_scope.head;
    if (relayHead) return relayHead.seq + 1;
    const durableHead = this.options.durableProjectionHeadSeq?.(scope);
    return durableHead != null ? durableHead + 1 : null;
  }

  private queueRemoteAccepted(scope: ObjRef, entry: RemoteAcceptedCommit): void {
    let pending = this.remotePending.get(scope);
    if (!pending) {
      pending = new Map();
      this.remotePending.set(scope, pending);
    }
    pending.set(entry.commit.position.seq, entry);
    this.remotePendingCount += 1;
    this.trimRemotePending();
  }

  private rememberRemoteAccepted(key: string): void {
    if (this.remoteAccepted.has(key)) return;
    this.remoteAccepted.add(key);
    this.remoteAcceptedOrder.push(key);
    while (this.remoteAcceptedOrder.length > REMOTE_ACCEPTED_LRU_LIMIT) {
      const oldest = this.remoteAcceptedOrder.shift();
      if (oldest) this.remoteAccepted.delete(oldest);
    }
  }

  private pruneRemotePending(): void {
    const cutoff = Date.now() - REMOTE_PENDING_MAX_AGE_MS;
    for (const [scope, pending] of this.remotePending) {
      for (const [seq, entry] of pending) {
        if (entry.receivedAt >= cutoff) continue;
        pending.delete(seq);
        this.remotePendingCount -= 1;
      }
      if (pending.size === 0) this.remotePending.delete(scope);
    }
  }

  private trimRemotePending(): void {
    while (this.remotePendingCount > REMOTE_PENDING_LIMIT) {
      let oldestScope: ObjRef | null = null;
      let oldestSeq: number | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [scope, pending] of this.remotePending) {
        for (const [seq, entry] of pending) {
          if (entry.receivedAt >= oldestAt) continue;
          oldestAt = entry.receivedAt;
          oldestScope = scope;
          oldestSeq = seq;
        }
      }
      if (oldestScope === null || oldestSeq === null) break;
      const pending = this.remotePending.get(oldestScope);
      if (!pending?.delete(oldestSeq)) break;
      this.remotePendingCount -= 1;
      if (pending.size === 0) this.remotePending.delete(oldestScope);
    }
  }

  private bind(woo: Session): SessionEntry {
    const v2Token = mcpV2Token(woo);
    const { server, dispose } = createMcpServer({
      world: this.world,
      host: this.host,
      actor: woo.actor,
      sessionId: woo.id,
      serverName: this.options.serverName ?? "woo",
      serverVersion: this.options.serverVersion ?? "0.0.0"
    });

    // Mint the MCP transport session id from the woo session id so the
    // resume path on a hibernated DO can recover state from the (already
    // persisted) world.sessions table without any extra writes.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => woo.id,
      enableJsonResponse: true,
      onsessionclosed: (id) => { this.closeSession(id, { unbind: false }); }
    });

    void server.connect(transport).catch(() => {});

    return { woo, v2Token, server, transport, dispose };
  }

  private async tryResume(sessionId: string): Promise<SessionEntry | null> {
    let woo: Session;
    try {
      woo = this.world.auth(`session:${sessionId}`);
    } catch {
      return null;
    }
    const entry = this.bind(woo);
    try {
      const initResponse = await entry.transport.handleRequest(synthesizeInitializeRequest());
      // Drain any body to release the underlying stream.
      await initResponse.body?.cancel().catch(() => {});
    } catch {
      entry.dispose();
      void entry.transport.close().catch(() => {});
      return null;
    }
    if (entry.transport.sessionId !== woo.id) {
      // SDK refused the synthetic initialize for some reason; bail rather than
      // leak a half-bound entry.
      entry.dispose();
      void entry.transport.close().catch(() => {});
      return null;
    }
    this.sessions.set(woo.id, entry);
    this.host.bindSession(woo.id, woo.actor);
    return entry;
  }

  private async invokeV2Direct(
    sessionId: string,
    actor: ObjRef,
    target: ObjRef,
    verb: string,
    args: WooValue[],
    scope?: ObjRef | null,
    persistence: "durable" | "live" = "durable",
    options: McpDispatchOptions = {}
  ): Promise<DirectResultFrame | ErrorFrame> {
    // Direct calls record under their live audience when there is one, and
    // under the shadow direct-call scope (`#-1`) otherwise. McpHost passes the
    // tool's enclosing scope so the CommitScopeDO route matches the transcript.
    const frame = await this.invokeV2(sessionId, actor, "direct", target, verb, args, scope ?? "#-1", persistence, options);
    if (frame.op === "applied") throw new Error(`v2 direct call returned applied frame: ${target}:${verb}`);
    return frame;
  }

  private async invokeV2Call(
    sessionId: string,
    actor: ObjRef,
    space: ObjRef,
    message: Message,
    options: McpDispatchOptions = {}
  ): Promise<AppliedFrame | ErrorFrame> {
    const frame = await this.invokeV2(sessionId, actor, "sequenced", message.target, message.verb, message.args, space, "durable", options);
    if (frame.op === "result") throw new Error(`v2 sequenced call returned direct result: ${message.target}:${message.verb}`);
    return frame;
  }

  private async invokeV2(
    sessionId: string,
    actor: ObjRef,
    route: ShadowTurnCall["route"],
    target: ObjRef,
    verb: string,
    args: WooValue[],
    explicitScope?: ObjRef | null,
    persistence: "durable" | "live" = "durable",
    options: McpDispatchOptions = {}
  ): Promise<AppliedFrame | DirectResultFrame | ErrorFrame> {
    const hooks = this.options.v2;
    if (!hooks) throw new Error("MCP v2 client hooks are not configured");
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`MCP session is not bound: ${sessionId}`);
    const scope = explicitScope ?? this.scopeForV2Call(actor, target);
    const id = `mcp-v2:${sessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    this.prewarmLikelyRelocationCommitScope(entry, actor, scope, target, verb, route, persistence);
    const ownerAuthorityObjectIds = mergeObjRefs(
      this.likelyMovementOwnerAuthorityObjectIds(entry, scope, target, verb, options.toolArgSpec),
      options.toolDefiner ? [options.toolDefiner] : [],
      options.toolSupportObjectIds ?? []
    );
    let authorityRefreshAttempts = 0;
    const submitted = await submitTurnIntent<V2ScopeClient, McpV2EnvelopeResult>({
      input: {
        id,
        route,
        scope,
        session: entry.woo.id,
        actor,
        target,
        verb,
        args,
        persistence,
        token: entry.v2Token
      },
      prePlanAuthority: false,
      repairPlanningAuthority: true,
      maxAttempts: 8,
      ensureClient: async (submitScope, _attempt, context) => await this.ensureV2ScopeClient(entry, submitScope, {
        requireCommitScopeOpen: context.phase === "commit" && context.plannedTranscriptCommit,
        timing: context.timing,
        timingLabelPrefix: context.phase,
        ownerAuthorityObjectIds: context.phase === "planning" ? ownerAuthorityObjectIds : []
      }),
      clientNode: () => this.v2NodeFor(entry),
      clientHead: (client) => client.relay.commit_scope.head,
      clientSerialized: (client) => serializedFor(client.relay.commit_scope, { reason: "mcp_turn_plan", metric: (event) => this.world.recordMetric(event) }),
      // A3.2 admission gate (ENFORCED at the VM boundary via buildPlanningWorld):
      // thread the relay's per-cell provenance. A presentation stub raises a
      // repairable E_NEED_STATE (the repair loop refreshes the named object and
      // re-plans). The gateway relay records provenance on every authority merge
      // AND on accepted-frame application (recordAcceptedCommitScopeCellProvenance), so
      // it opts IN to fatal missing_provenance enforcement (#11): an untagged tracked
      // cell raises a repairable E_NEED_STATE that the repair loop resolves (and the
      // refreshed authority records its provenance, so it converges). Any residual
      // under-tagged cell self-heals on first touch rather than serving silently.
      clientPlanningProvenance: (client) => client.relay.commit_scope.cellProvenance ?? new Map(),
      enforceMissingProvenance: true,
      // CA11.2: the gateway is the path WITH a force-owner repair (the
      // `missing_state_repair` authority refresh), so it opts in to the
      // movement-destination owner-repair check: a move INTO a scope served only
      // as a non-authoritative topology pre-seed repairs to owner before commit.
      enforceMovementOwnerRepair: true,
      ...(hooks.enforceResolutionOwnerRepair === true ? {
        // The same repair mechanism protects room visibility/command resolution:
        // command matching, `visible_contents`, and `contents()` must not make
        // final decisions from a gateway projection cache row whose
        // `object_live.contents` did not come from the room owner.
        enforceResolutionOwnerRepair: true
      } : {}),
      onAdmissionViolation: (violations) => {
        for (const v of violations) {
          console.warn("woo.planning_world_inadmissible", { where: "mcp_turn_plan", scope, kind: v.kind, object: v.object, page: v.page, detail: v.detail });
        }
      },
      nextTurnId: () => id,
      envelopeId: (turnId, attempt) => executorEnvelopeId(turnId, attempt, () => Math.random().toString(36).slice(2, 10)),
      authorityPayload: async (submitScope, extraObjectIds, context) => {
        // Pre-plan authority repairs the local relay view before VM planning.
        // It must not consume the first envelope snapshot fallback slot: that
        // fallback is for commit submission after a durable snapshot exists.
        const isPrePlan = context?.phase === "pre_plan";
        // CA11.2 occupancy transition: a repair-driven pre-plan refresh (the VM /
        // admission gate proved a missing/unauthoritative cell, e.g. a move INTO a
        // scope served only as a topology pre-seed) must force owner authority for
        // the named ids. Tagging it `missing_state_repair` makes
        // v2GatewayAuthorityPayload disable topology refresh-suppression and the
        // seeded-id local-export exclusion for those ids, so the owner's
        // exits-bearing row is fetched and displaces the seed by CA11 precedence.
        const isRepair = isPrePlan && context?.repair === true;
        // B7: never serve warm/cached authority on a repair-loop retry. A
        // conflict (stale_head / read_version_mismatch / missing_state) on
        // attempt N means the state the cache served just failed validation;
        // attempt N+1 must reconstruct fresh owner state or a stale cell can
        // loop cache → mismatch → cache until the retry budget is exhausted.
        // (The conflict reply's applyHead/applyStateTransfer installs already
        // refresh the relay, but only for the cells the reply happened to name.)
        const isRepairAttempt = (context?.attempt ?? 0) > 0;
        if (
          !isPrePlan &&
          !isRepairAttempt &&
          hooks.slimWarmEnvelope === true
        ) {
          const submitClient = this.v2Scopes.get(submitScope);
          const authorityClient = context?.plannedTranscriptCommit === true
            ? this.v2Scopes.get(scope) ?? submitClient
            : submitClient;
          const sessionOpen = context?.plannedTranscriptCommit === true
            ? submitClient?.commitScopeOpenedSessions.has(entry.woo.id) === true
            : submitClient?.openedSessions.has(entry.woo.id) === true || submitClient?.commitScopeOpenedSessions.has(entry.woo.id) === true;
          // B7 widening: a relay whose commit-scope head has advanced past @0 is
          // tracking the CommitScopeDO's accepted sequence (the open adopted the
          // durable head and accepted frames advance it), so its admitted rows
          // ARE the head state the envelope will validate against — serve them
          // even when this particular session's open marker is not yet recorded
          // (e.g. another session on this shard opened the scope client).
          const headKnown = (authorityClient?.relay.commit_scope.head.seq ?? 0) > 0;
          if (authorityClient && (sessionOpen || headKnown)) return this.cachedWarmCommitAuthority(entry, authorityClient, extraObjectIds);
        }
        // The CommitScopeDO snapshot fallback (no remote fetch; rely on the
        // scope's durable snapshot + commit validation) applies to the FIRST
        // fallthrough commit refresh — including the one a repair attempt pays
        // after the cached path above refused it. Forcing real remote owner
        // fetches on repair attempts here was tried and REGRESSED the
        // production-shape movement path: the refetched slices, merged back
        // into the relay, displaced fresher repair-installed rows. Repair
        // freshness comes from the pre-plan missing_state_repair force-owner
        // refresh and the conflict reply's applyHead/applyStateTransfer
        // installs, not from this payload.
        const useCommitScopeSnapshotForRemoteAuthority = !isPrePlan && authorityRefreshAttempts === 0;
        if (!isPrePlan) authorityRefreshAttempts += 1;
        // Directory/session scopes still include submit+target so routes and
        // sessions resolve for the destination. But a repair-driven pre-plan
        // (movement-destination occupancy repair) MUST NOT request scope CONTENTS
        // expansion: contents arrive through the Directory/session projection, and
        // a repair pre-plan that expands the destination's (possibly stale) guest
        // contents re-introduces the pre-plan contents expansion the cf-local gate
        // forbids. So keep the directory-session scopes but drop the
        // scopeContentExpansionRoots on the repair pass.
        const directorySessionScopeRoots = isPrePlan ? [submitScope, target] : [];
        const contentExpansionRoots = isPrePlan && !isRepair ? [submitScope, target] : [];
        const payload = await this.v2AuthorityPayload(extraObjectIds, {
          useCommitScopeSnapshotForRemoteAuthority,
          tolerateRemoteFailures: isPrePlan,
          directorySessionScopes: mcpDirectorySessionScopesForAuthority(
            entry,
            submitScope,
            ...directorySessionScopeRoots,
            ...(options.directorySessionScopes ?? [])
          ),
          ...(contentExpansionRoots.length > 0 ? { scopeContentExpansionRoots: contentExpansionRoots } : {}),
          reconstructionReason: isRepair ? "missing_state_repair" : "warm_turn_refresh",
          reconstructionTrigger: isPrePlan ? "pre_plan_repair" : "turn_commit",
          reconstructionScope: submitScope,
          forceOwnerObjectIds: isRepair ? extraObjectIds : []
        });
        const fallbackClient = this.v2Scopes.get(scope) ?? this.v2Scopes.get(submitScope);
        const authorityPayload = fallbackClient && (payload.staleFallbackCount ?? 0) > 0
          ? this.withRelaySnapshotAuthorityFallback(fallbackClient, payload)
          : payload;
        return this.withMcpSessionAuthority(entry, authorityPayload);
      },
      applyAuthority: (client, authority) => {
        this.mergeV2AuthorityIntoScopeClient(client, authority);
      },
      // Adopt the authority's current head reported in a stale-head/version
      // conflict so the next attempt plans + commits against it. The relay's
      // authority merge updates cell versions but never advances the head, so
      // without this a fresh commit-scope relay (head @0) stale-rejects every
      // attempt. structuredClone keeps the reply's head object out of our cache.
      applyHead: (client, head) => {
        client.relay.commit_scope.head = structuredClone(head);
      },
      // DESIGN A layer-2: install the committing scope's fresh mismatched cells
      // (carried on a read-version-mismatch conflict) into this relay's planning
      // cache. The shard self-certifies its session-actor stub as authoritative
      // (so a remote owner refetch is skipped), which means without this the
      // next attempt re-plans against the SAME stale stub and the commit
      // re-rejects until the retry budget is exhausted. The transfer's pages are
      // stamped authoritative by the owner, so the standard authority-merge
      // precedence + version gate let them override the stub.
      applyStateTransfer: (client, transfer) => {
        if (transfer.mode !== "cell_pages") return;
        installShadowCellPageTransferAsAuthority(client.relay, transfer, { reason: "mcp_version_mismatch_repair" });
      },
      submitEnvelope: async (submitScope, body, context) => {
        const envelopeBody = await context.timing.time("submit", "mcp.execution_capsule", () => this.withExecutionCapsule(
          hooks,
          this.v2Scopes.get(submitScope)?.relay.commit_scope.head ?? null,
          body as McpV2EnvelopeBody,
          target,
          verb
        ));
        // Slim ordinary warm envelopes: the gateway opens (and the open seeds a
        // durable snapshot on) a scope before enveloping it, so a same-scope
        // CommitScopeDO rehydrates from its own snapshot and never needs the
        // ~3MB slice. Planned-transcript commits are excluded by
        // slimMcpEnvelopeBody because their commit scope validates a transcript
        // planned elsewhere. The rare genuine miss (no in-memory relay AND no
        // durable snapshot, e.g. a DO that lost storage) replies
        // E_SNAPSHOT_REQUIRED and is resolved by the reseed + full-body retry
        // below. The full body (envelopeBody) is retained for that retry.
        const slim = hooks.slimWarmEnvelope === true;
        // B-i: when readClosureEnvelope is on, filter a planned-transcript
        // commit's authority to the turn's read closure (VTN8.3). This replaces
        // the full scope-wide slice (~1.7 MB) with only the cells the validator
        // actually reads (actor, session, transcript-touched + lineage). The
        // full body (envelopeBody) is retained for the E_SNAPSHOT_REQUIRED
        // cold-scope retry — see the catch block below.
        const closureEnabled = hooks.readClosureEnvelope === true;
        let firstBody: McpV2EnvelopeBody;
        if (slim) {
          firstBody = slimMcpEnvelopeBody(envelopeBody);
          // slimMcpEnvelopeBody returns the planned-transcript body unchanged;
          // if closure is also enabled, apply the closure filter on top.
          if (closureEnabled && firstBody.planned_transcript_commit === true && context.closureObjectIds) {
            firstBody = closureMcpEnvelopeBody(
              firstBody,
              new Set(context.closureObjectIds),
              context.closureSessionIds ?? []
            );
          }
        } else if (closureEnabled && envelopeBody.planned_transcript_commit === true && context.closureObjectIds) {
          // slim is off but closure is on: filter the planned-transcript body.
          firstBody = closureMcpEnvelopeBody(
            envelopeBody,
            new Set(context.closureObjectIds),
            context.closureSessionIds ?? []
          );
        } else {
          firstBody = envelopeBody;
        }
        // A cold scope cannot seed from a slimmed body (no authority) nor from a
        // capsule body (capsule carries no slice), so both modes must be able to
        // re-seed and retry with the full body on E_SNAPSHOT_REQUIRED.
        const reseedEligible = slim || closureEnabled || hooks.executionCapsuleOpen === true;
        try {
          return await hooks.envelope(submitScope, firstBody, { timing: context.timing });
        } catch (err) {
          if (!reseedEligible || !isV2CommitScopeSnapshotRequiredError(err)) throw err;
          const client = this.v2Scopes.get(submitScope);
          if (!client) throw err;
          client.openedSessions.delete(entry.woo.id);
          client.commitScopeOpenedSessions.delete(entry.woo.id);
          const seeded = await context.timing.time("submit", "mcp.snapshot_retry_seed", () => this.v2SerializedWorld([submitScope, entry.woo.actor], { reconstructionReason: "cold_open", reconstructionTrigger: "snapshot_retry" }));
          await this.ensureV2ScopeSessionOpen(entry, client, hooks, seeded, {
            forceLegacyOpen: true,
            timing: context.timing,
            timingLabelPrefix: "submit.snapshot_retry"
          });
          // Retry with the FULL body (authority retained), capsule stripped — the
          // re-seed established the durable snapshot, so the cold-miss is resolved.
          const { execution_capsule, ...legacyBody } = envelopeBody;
          void execution_capsule;
          this.world.recordMetric({
            kind: "mcp_envelope_slim_reseed",
            scope: submitScope,
            mode: slim ? "slim" : (closureEnabled ? "closure" : "capsule")
          });
          return await context.timing.time("submit", "mcp.snapshot_retry_envelope_rpc", () => hooks.envelope(submitScope, legacyBody, { timing: context.timing }));
        }
      },
      // Forward planning-phase verb metrics to the gateway world's metrics
      // hook so direct_call/applied/dispatch_resolved/broadcast events land
      // in AE and drive the /admin/ footprint-by-verb view.
      onMetric: (event) => this.world.recordMetric(event)
    });
    if (submitted.kind === "local_frame") return submitted.frame;
    const result = submitted.result;
    const reply = submitted.reply;
    const client = submitted.client;
    if (!reply) {
      if (result.head) client.relay.commit_scope.head = result.head;
      return { op: "error", id, error: { code: "E_INTERNAL", message: "v2 MCP turn produced no reply" } };
    }
    if (!reply.ok) {
      if (result.head) client.relay.commit_scope.head = result.head;
      return { op: "error", id, error: { code: reply.reason, message: reply.reason, value: reply as unknown as WooValue } };
    }
    if (reply.commit) {
      this.acceptV2Commit(client, reply, sessionId, result.local_host_materialized ?? null, result.accepted_audience);
    }
    if (reply.state_transfer?.mode === "cell_pages") {
      installShadowAcceptedWriteTransferIntoRelayCache(client.relay, reply.state_transfer, { reason: "mcp_accepted_write_cache" });
    }
    const frame = mcpFrameFromTurnReply(scope, reply);
    if (!reply.commit && frame.op === "result") this.host.routeLiveEvents(frame, sessionId);
    return frame;
  }

  private prewarmLikelyRelocationCommitScope(
    entry: SessionEntry,
    actor: ObjRef,
    scope: ObjRef,
    target: ObjRef,
    verb: string,
    route: ShadowTurnCall["route"],
    persistence: "durable" | "live"
  ): void {
    // B6 relocation selection happens only after local planning sees the
    // transcript, but room-targeted durable MCP calls (`woo_call room:enter` is
    // the prod smoke case, and it arrives as a direct call) commonly commit at
    // the actor scope. Open that head/session boundary in parallel with room
    // planning; the normal commit ensure path still validates and retries if
    // this speculative open fails.
    if (persistence !== "durable" || (route !== "direct" && route !== "sequenced") || scope === actor || target !== scope) return;
    const startedAt = Date.now();
    void this.ensureV2ScopeClient(entry, actor, {
      requireCommitScopeOpen: true,
      timingLabelPrefix: "prewarm.relocation"
    }).then(() => {
      this.world.recordMetric({
        kind: "mcp_relocation_prewarm",
        scope,
        commit_scope: actor,
        target,
        verb,
        ms: Date.now() - startedAt,
        status: "ok"
      });
    }).catch((err) => {
      const error = normalizeError(err);
      this.world.recordMetric({
        kind: "mcp_relocation_prewarm",
        scope,
        commit_scope: actor,
        target,
        verb,
        ms: Date.now() - startedAt,
        status: "error",
        error: error.code,
        error_detail: error.message
      });
    });
  }

  private async ensureV2ScopeClient(
    entry: SessionEntry,
    scope: ObjRef,
    options: V2ScopeEnsureOptions = {}
  ): Promise<V2ScopeClient> {
    const hooks = this.options.v2;
    if (!hooks) throw new Error("MCP v2 client hooks are not configured");
    let client = this.v2Scopes.get(scope);
    if (!client) {
      client = await this.initializeV2ScopeClient(entry, scope, hooks, options);
    }
    await this.ensureV2ScopeSessionOpen(entry, client, hooks, undefined, options);
    await this.ensureV2OwnerAuthorityPrefetch(entry, client, options);
    return client;
  }

  private async initializeV2ScopeClient(
    entry: SessionEntry,
    scope: ObjRef,
    hooks: McpV2ClientHooks,
    options: V2ScopeEnsureOptions = {}
  ): Promise<V2ScopeClient> {
    const existing = this.v2Scopes.get(scope);
    if (existing) return existing;
    const pending = this.v2ScopeInitializers.get(scope);
    const timingPrefix = options.timingLabelPrefix ?? "ensure";
    if (pending) return await (options.timing
      ? options.timing.time("ensure_client", `${timingPrefix}.initializer_wait`, () => pending)
      : pending);
    // First-open seeding builds a narrow versioned authority seed for the
    // local relay and, only if CommitScopeDO lacks a durable row snapshot, a
    // materialized /v2/open retry. Coalesce it per scope so parallel sessions
    // do not each build and post the same seed.
    const initializer = (async () => {
      const ownerAuthorityObjectIds = options.ownerAuthorityObjectIds ?? [];
      const seedObjectIds = mergeObjRefs([scope, entry.woo.actor], ownerAuthorityObjectIds);
      // First-open seeding is a cold-open cost by the metric taxonomy (the
      // reason previously defaulted to warm_turn_refresh because the worker
      // hook always tolerates remote failures; B7 attribution showed these
      // seeds were the bulk of the mislabeled "warm" reconstructions).
      const seeded = await (options.timing
        ? options.timing.time("ensure_client", `${timingPrefix}.seed_authority`, () => this.v2SerializedWorld(seedObjectIds, {
          directorySessionScopes: mcpDirectorySessionScopesForAuthority(entry, scope),
          forceOwnerObjectIds: ownerAuthorityObjectIds,
          reconstructionScope: scope,
          reconstructionReason: "cold_open",
          reconstructionTrigger: "scope_seed"
        }))
        : this.v2SerializedWorld(seedObjectIds, {
          directorySessionScopes: mcpDirectorySessionScopesForAuthority(entry, scope),
          forceOwnerObjectIds: ownerAuthorityObjectIds,
          reconstructionScope: scope,
          reconstructionReason: "cold_open",
          reconstructionTrigger: "scope_seed"
        }));
      const client: V2ScopeClient = {
        scope,
        relay: createShadowBrowserRelayShim({
          node: `mcp-v2-relay:${scope}`,
          scope,
          serialized: seeded.serialized,
          // Authority-derived seed: carry the slice's real per-cell provenance
          // (authoritative/projection/cache per page), not a flat `cache`.
          seedCellProvenance: cellProvenanceFromAuthoritySlice(seeded.authority.authority)
        }),
        commitScopeOpenedSessions: new Set(),
        openedSessions: new Set(),
        openingSessions: new Map(),
        ownerPrefetchedIds: new Set()
      };
      for (const id of ownerAuthorityObjectIds) client.ownerPrefetchedIds.add(id);
      await this.ensureV2ScopeSessionOpen(entry, client, hooks, seeded, {
        ...options,
        timingLabelPrefix: `${timingPrefix}.initial`
      });
      this.v2Scopes.set(scope, client);
      return client;
    })();
    this.v2ScopeInitializers.set(scope, initializer);
    try {
      return await initializer;
    } finally {
      if (this.v2ScopeInitializers.get(scope) === initializer) this.v2ScopeInitializers.delete(scope);
    }
  }

  private async ensureV2OwnerAuthorityPrefetch(
    entry: SessionEntry,
    client: V2ScopeClient,
    options: V2ScopeEnsureOptions = {}
  ): Promise<void> {
    const ids = Array.from(new Set((options.ownerAuthorityObjectIds ?? [])
      .filter((id): id is ObjRef => typeof id === "string" && id.length > 0 && !client.ownerPrefetchedIds.has(id))));
    if (ids.length === 0) return;
    // B7 gateway install. The prefetch exists to give local planning OWNER-
    // authoritative identity/live rows for the ids a movement-class verb will
    // touch (the CA11.2 movement-destination guard rejects a non-authoritative
    // destination row). It used to reconstruct a full owner fan-in slice on
    // every first sighting of an id per scope client — the per-movement
    // `owner_prefetch` reconstructions the baseline measured. CA11.1's residue
    // rule applies instead:
    //   1. an id whose tracked cells are already owner-authoritative in THIS
    //      client's relay needs nothing;
    //   2. an id that ANOTHER warm scope client on this gateway holds
    //      owner-authoritatively (the gateway already paid that owner fetch
    //      when it seeded/refreshed that scope) is served by copying that
    //      relay's cell pages — process-local, no reconstruction, no RPC;
    //   3. only the residue pays a (residue-only, first-fetch) reconstruction.
    // A warm-served row may lag the owner; commit-time cell-version validation
    // arbitrates, and the repair attempt always reconstructs fresh (the
    // executor refuses warm authority when attempt > 0) — the same safety
    // property every B7 cache read relies on.
    const metric = (event: MetricEvent): void => this.world.recordMetric(event);
    let warmLocal = 0;
    let warmDonor = 0;
    const residue: ObjRef[] = [];
    for (const id of ids) {
      if (relayHoldsOwnerAuthority(client.relay, id)) {
        client.ownerPrefetchedIds.add(id);
        warmLocal += 1;
        continue;
      }
      const donor = id === client.scope ? undefined : this.v2Scopes.get(id);
      if (donor && donor !== client && relayHoldsOwnerAuthority(donor.relay, id)) {
        this.mergeV2AuthorityIntoScopeClient(client, warmRelayAuthoritySliceForObject(client.relay, donor.relay, id, metric));
        client.ownerPrefetchedIds.add(id);
        warmDonor += 1;
        continue;
      }
      residue.push(id);
    }
    this.world.recordMetric({
      kind: "mcp_owner_prefetch",
      scope: client.scope,
      requested: ids.length,
      warm_local: warmLocal,
      warm_donor: warmDonor,
      residue: residue.length
    });
    if (residue.length === 0) return;
    const timingPrefix = options.timingLabelPrefix ?? "ensure";
    // The residue is a first fetch of ids this shard has never held with owner
    // authority — a bounded cold cost by the metric taxonomy, not a per-turn
    // refresh of already-open state (which the warm paths above now absorb).
    const authority = this.withMcpSessionAuthority(
      entry,
      await (options.timing
        ? options.timing.time("ensure_client", `${timingPrefix}.owner_prefetch_authority`, () => this.v2AuthorityPayload(residue, {
          directorySessionScopes: mcpDirectorySessionScopesForAuthority(entry, client.scope),
          reconstructionReason: "cold_open",
          reconstructionTrigger: "owner_prefetch",
          reconstructionScope: client.scope,
          forceOwnerObjectIds: residue
        }))
        : this.v2AuthorityPayload(residue, {
          directorySessionScopes: mcpDirectorySessionScopesForAuthority(entry, client.scope),
          reconstructionReason: "cold_open",
          reconstructionTrigger: "owner_prefetch",
          reconstructionScope: client.scope,
          forceOwnerObjectIds: residue
        }))
    );
    this.mergeV2AuthorityIntoScopeClient(client, authority.authority);
    for (const id of residue) client.ownerPrefetchedIds.add(id);
  }

  private async ensureV2ScopeSessionOpen(
    entry: SessionEntry,
    client: V2ScopeClient,
    hooks: McpV2ClientHooks,
    seeded?: { serialized: ReturnType<WooWorld["exportWorld"]>; authority: ReturnType<typeof executorAuthorityPayload> },
    options: V2ScopeEnsureOptions = {}
  ): Promise<void> {
    const requireCommitScopeOpen = options.forceLegacyOpen === true || options.requireCommitScopeOpen === true;
    const timingPrefix = options.timingLabelPrefix ?? "ensure";
    if (requireCommitScopeOpen && client.commitScopeOpenedSessions.has(entry.woo.id)) {
      options.timing?.add("ensure_client", `${timingPrefix}.session_open_cached`, 0);
      return;
    }
    if (!requireCommitScopeOpen && client.openedSessions.has(entry.woo.id)) {
      options.timing?.add("ensure_client", `${timingPrefix}.session_open_cached`, 0);
      return;
    }
    const openingKey = requireCommitScopeOpen ? `${entry.woo.id}:commit-scope-open` : `${entry.woo.id}:session-open`;
    const existing = client.openingSessions.get(openingKey);
    if (existing) {
      await (options.timing
        ? options.timing.time("ensure_client", `${timingPrefix}.session_open_wait`, () => existing)
        : existing);
      return;
    }
    const pending = (async () => {
      const authority = this.withMcpSessionAuthority(
        entry,
        seeded?.authority ?? await (options.timing
          ? options.timing.time("ensure_client", `${timingPrefix}.session_authority_payload`, () => this.v2AuthorityPayload([client.scope, entry.woo.actor], {
            directorySessionScopes: mcpDirectorySessionScopesForAuthority(entry, client.scope),
            reconstructionTrigger: "session_open"
          }))
          : this.v2AuthorityPayload([client.scope, entry.woo.actor], {
            directorySessionScopes: mcpDirectorySessionScopesForAuthority(entry, client.scope),
            reconstructionTrigger: "session_open"
          }))
      );
      this.mergeV2AuthorityIntoScopeClient(client, authority.authority);
      if (hooks.executionCapsuleOpen && !requireCommitScopeOpen) {
        options.timing?.add("ensure_client", `${timingPrefix}.capsule_open_cached`, 0);
        client.openedSessions.add(entry.woo.id);
        return;
      }
      // Planned-transcript commits only need the selected commit scope's head
      // and authenticated session row; shipping executable pages here puts
      // every cross-scope MCP turn back on the legacy open hot path.
      const headSessionOpen = options.forceLegacyOpen !== true && options.requireCommitScopeOpen === true;
      const openBody: McpV2OpenBody = {
        scope: client.scope,
        node: this.v2NodeFor(entry),
        token: entry.v2Token,
        session: entry.woo.id,
        actor: entry.woo.actor,
        known_head: client.relay.commit_scope.head,
        ...(headSessionOpen ? {
          open_protocol: "head_session.v1" as const,
          sessions: authority.sessions,
          session_objects: authority.session_objects
        } : authority)
      };
      let opened: McpV2OpenResult;
      try {
        opened = await (options.timing
          ? options.timing.time("ensure_client", `${timingPrefix}.open_rpc`, () => hooks.open(client.scope, openBody))
          : hooks.open(client.scope, openBody));
      } catch (err) {
        if (!isV2CommitScopeSnapshotRequiredError(err)) throw err;
        const retrySeed = seeded ?? await (options.timing
          ? options.timing.time("ensure_client", `${timingPrefix}.snapshot_retry_seed`, () => this.v2SerializedWorld([client.scope, entry.woo.actor], {
            directorySessionScopes: mcpDirectorySessionScopesForAuthority(entry, client.scope),
            reconstructionReason: "cold_open",
            reconstructionTrigger: "snapshot_retry"
          }))
          : this.v2SerializedWorld([client.scope, entry.woo.actor], {
            directorySessionScopes: mcpDirectorySessionScopesForAuthority(entry, client.scope),
            reconstructionReason: "cold_open",
            reconstructionTrigger: "snapshot_retry"
          }));
        opened = await (options.timing
          ? options.timing.time("ensure_client", `${timingPrefix}.snapshot_retry_open_rpc`, () => hooks.open(client.scope, {
            ...openBody,
            ...authority,
            ...(headSessionOpen ? { open_protocol: "head_session.v1" as const } : {}),
            serialized: retrySeed.serialized
          }))
          : hooks.open(client.scope, {
          ...openBody,
          ...authority,
          ...(headSessionOpen ? { open_protocol: "head_session.v1" as const } : {}),
          serialized: retrySeed.serialized
        }));
      }
      if (opened.head) client.relay.commit_scope.head = opened.head;
      client.openedSessions.add(entry.woo.id);
      client.commitScopeOpenedSessions.add(entry.woo.id);
    })();
    client.openingSessions.set(openingKey, pending);
    try {
      await pending;
    } finally {
      if (client.openingSessions.get(openingKey) === pending) client.openingSessions.delete(openingKey);
    }
  }

  private withExecutionCapsule(
    hooks: McpV2ClientHooks,
    head: ShadowScopeHead | null,
    body: McpV2EnvelopeBody,
    target: ObjRef,
    verb: string
  ): McpV2EnvelopeBody {
    if ((body as { planned_transcript_commit?: unknown }).planned_transcript_commit === true) return body;
    if (!hooks.executionCapsuleOpen || !body.authority || !head) return body;
    return {
      ...body,
      execution_capsule: buildExecutionCapsule({
        scope: body.scope,
        head,
        actor: body.actor,
        session: body.session,
        target,
        verb
      })
    };
  }

  private async v2AuthorityPayload(
    extraObjectIds: ObjRef[],
    options: {
      useCommitScopeSnapshotForRemoteAuthority?: boolean;
      tolerateRemoteFailures?: boolean;
      directorySessionScopes?: ObjRef[];
      scopeContentExpansionRoots?: ObjRef[];
      reconstructionReason?: "warm_turn_refresh" | "cold_open" | "missing_state_repair";
      reconstructionTrigger?: AuthorityReconstructionTrigger;
      reconstructionScope?: ObjRef;
      forceOwnerObjectIds?: ObjRef[];
    } = {}
  ): Promise<ReturnType<typeof executorAuthorityPayload>> {
    return await (
      this.options.v2?.authorityPayload?.(extraObjectIds, options)
      ?? Promise.resolve(executorAuthorityPayload(this.world, extraObjectIds))
    );
  }

  private async v2SerializedWorld(
    extraObjectIds: ObjRef[],
    options: { directorySessionScopes?: ObjRef[]; forceOwnerObjectIds?: ObjRef[]; reconstructionScope?: ObjRef; reconstructionReason?: "warm_turn_refresh" | "cold_open" | "missing_state_repair"; reconstructionTrigger?: AuthorityReconstructionTrigger } = {}
  ): Promise<{ serialized: ReturnType<WooWorld["exportWorld"]>; authority: ReturnType<typeof executorAuthorityPayload> }> {
    const authority = await this.v2AuthorityPayload(extraObjectIds, options);
    const serialized = serializedWorldFromAuthoritySlice(authority.authority);
    return { serialized, authority };
  }

  private withMcpSessionAuthority(entry: SessionEntry, payload: ExecutorAuthorityPayload): ExecutorAuthorityPayload {
    const session = serializedSessionForMcpEntry(entry);
    const sessions = ensureSerializedSession(payload.sessions, session);
    const authoritySessions = ensureSerializedSession(payload.authority.sessions, session);
    return {
      ...payload,
      sessions,
      authority: {
        ...payload.authority,
        sessions: authoritySessions
      }
    };
  }

  private cachedWarmCommitAuthority(
    entry: SessionEntry,
    client: V2ScopeClient,
    objectIds: readonly ObjRef[]
  ): ExecutorAuthorityPayload {
    // Slim warm envelope commits do not send authority to CommitScopeDO; the
    // selected scope rehydrates from its durable snapshot. The executor still
    // asks for a commit authority payload so it can merge rows locally. Use the
    // already-admitted relay rows, from either the submit scope or the planning
    // scope for planned-transcript commits, instead of reconstructing an owner
    // fan-in slice. Pages keep recorded provenance when present and otherwise
    // fall back to cache, so this payload can fill local gaps without claiming
    // owner authority.
    const serialized = serializedFor(client.relay.commit_scope, {
      reason: "mcp_cached_warm_authority",
      metric: (event) => this.world.recordMetric(event)
    });
    const ids = new Set<ObjRef>(objectIds);
    ids.add(entry.woo.actor);
    const authority = buildSerializedAuthorityCellSlice({
      sessions: serialized.sessions.filter((session) => session.id === entry.woo.id || ids.has(session.actor)),
      objects: serialized.objects,
      counters: {
        objectCounter: serialized.objectCounter,
        parkedTaskCounter: serialized.parkedTaskCounter,
        sessionCounter: serialized.sessionCounter
      },
      tombstones: serialized.tombstones,
      pageProvenance: (page) =>
        client.relay.commit_scope.cellProvenance?.get(cachedAuthorityPageKey(page)) ?? { source: "cache" }
    });
    return this.withMcpSessionAuthority(entry, {
      sessions: authority.sessions,
      session_objects: [],
      authority
    });
  }

  private mergeV2AuthorityIntoScopeClient(client: V2ScopeClient, authority: SerializedAuthoritySlice): void {
    // The gateway keeps one relay per scope and mutates its serialized snapshot with
    // fresh session/actor authority. The shared relay-cache merge carries the relay's
    // per-cell provenance (so the admission gate / merge precedence apply uniformly),
    // preserves the session actors' live cells across the refresh, and bumps the
    // relay-cache generation when the snapshot changed.
    mergeAuthorityIntoRelayCache(client.relay, authority, {
      preserveSessionActorLive: true,
      reason: "mcp_authority_merge",
      metric: (event) => this.world.recordMetric(event)
    });
  }

  private withRelaySnapshotAuthorityFallback(
    client: V2ScopeClient,
    payload: ReturnType<typeof executorAuthorityPayload>
  ): ReturnType<typeof executorAuthorityPayload> {
    if ((payload.staleFallbackCount ?? 0) <= 0) return payload;
    // The PersistentObjectDO authority hook marks actual cold-owner degrade
    // paths with staleFallbackCount. Only then do we pay to include this MCP
    // shard's last successfully seeded view for the scope; fresh owner rows
    // still override stale values because the payload is combined last.
    const serialized = serializedFor(client.relay.commit_scope, {
      reason: "mcp_authority_stale_fallback",
      metric: (event) => this.world.recordMetric(event)
    });
    if (serialized.objects.length === 0) return payload;
    const relayAuthority = buildSerializedAuthorityCellSlice({
      sessions: [],
      objects: serialized.objects,
      counters: {
        objectCounter: serialized.objectCounter,
        parkedTaskCounter: serialized.parkedTaskCounter,
        sessionCounter: serialized.sessionCounter
      },
      tombstones: serialized.tombstones,
      // A3: this is the MCP shard's last-known relay view, included only on a
      // cold-owner degrade (staleFallbackCount > 0). It is a fallback derivation,
      // never the owner's authoritative row — fresh owner rows override it
      // because the payload is combined last.
      pageProvenance: () => ({ source: "fallback" })
    });
    return {
      ...payload,
      authority: combineSerializedAuthoritySlices(payload.sessions, [relayAuthority, payload.authority])
    };
  }

  private acceptV2Commit(
    client: V2ScopeClient,
    reply: Extract<ShadowTurnExecReply, { ok: true }>,
    originSessionId: string,
    localHostMaterialized: McpV2EnvelopeResult["local_host_materialized"] = null,
    audience?: McpAcceptedFrameAudience
  ): void {
    if (!reply.commit || !reply.transcript) return;
    // This relay OWNS the committed scope — advance head via the shared applier.
    applyAcceptedFrameToRelayCache(client.relay, reply.commit, reply.transcript, { advanceHead: true });
    const projectionWrites = reply.commit.projection_writes ?? [];
    if (reply.commit.projection_delta) {
      assertProjectionWritesComplete(reply.commit.projection_delta, projectionWrites, reply.commit.position.scope, "mcp");
      this.applyGatewayProjectionWrites(projectionWrites, reply.transcript);
      this.world.recordMetric({
        kind: "gateway_projection_apply",
        scope: reply.commit.position.scope,
        rows: projectionWrites.length,
        projection_bytes: reply.commit.projection_delta?.projection_bytes ?? 0,
        source: "mcp"
      });
    } else {
      this.world.applyCommittedShadowTranscript(reply.transcript, localHostMaterialized
        ? { skipObjectHost: { hostKey: localHostMaterialized.hostKey, gatewayHost: localHostMaterialized.gatewayHost === true } }
        : {});
    }
    this.propagateTranscriptToOtherScopes(reply.commit.position.scope, reply.commit, reply.transcript);
    this.host.routeShadowAcceptedFrame(reply.commit, originSessionId, reply.transcript, audience);
  }

  // The commit happened in `originScope`; that scope's V2 client has had the
  // accepted frame applied (head advanced, serialized state updated). Other
  // cached scope clients also need the transcript's *writes* (without head
  // advancement) so that cross-scope state changes — most importantly an
  // actor's `location` after a room-to-room move — show up in whatever scope
  // the next call dispatches to. Without this, a move accepted by one scope can
  // leave another open scope's snapshot with the actor in the old room, and the
  // very next actor verb routed there reads the stale location.
  // An accepted commit under `originScope` can affect objects/actors that a
  // DIFFERENT open relay plans against — most importantly a cross-scope MOVE,
  // which commits under the moved object's own scope but changes the source and
  // destination rooms' membership and the moved actor's row. Those other relays
  // must learn the authoritative rows from the accepted transcript stream, or a
  // live read (e.g. `who`) planning against a stale relay snapshot renders the
  // moved actor with no materialized name/lineage. This is derived materialization
  // from the accepted stream (VTN0) — NOT a head advance and NOT a second
  // authority: the target relay's head belongs to its own commit sequence, so we
  // apply projection rows + movement projection WITHOUT touching head.
  //
  // A2 (CA4 durable owner delivery): the transcript delta alone is not enough for
  // an object that arrives in a scope for the first time. The receiving relay has
  // the move effect (location change) but none of the arriving object's class
  // lineage pages (the moved object's class chain back to the root). Without them,
  // verb resolution walks parentWalkLookup, hits a null, records dangling_parent_ref,
  // and throws E_VERBNF/E_OBJNF. Before applying the delta we therefore merge the
  // LINEAGE CLOSURE of all objects incoming to each affected scope — every
  // transitive parent in the chain — from the origin relay's planning snapshot.
  // Provenance is `cache` (a derived copy from the origin relay, not owner
  // authority), so the merge respects CA11 precedence: a later owner-authoritative
  // row still displaces it. Idempotent: merging a lineage page that is already
  // present is a no-op (same hash → already-current guard in mergeSerializedAuthoritySlice).
  //
  // Bounded to the transcript's affected scopes (move from/to, creates with a
  // location, contents/presence writes); we do not touch every open relay.
  private propagateTranscriptToOtherScopes(
    originScope: ObjRef,
    accepted: ShadowCommitAccepted,
    transcript: EffectTranscript
  ): void {
    const affected = new Set(affectedTranscriptScopes(
      originScope,
      transcript,
      (object, property) => this.world.isPresenceProjectionProperty(object, property)
    ));
    // A2: pre-build the lineage closure slice from the origin relay so we can
    // inject it into every affected destination relay before the delta frame.
    // We only need to compute this if there are moves/creates that cross scope
    // boundaries (objects arriving at a different scope than originScope).
    const originClient = this.v2Scopes.get(originScope);
    for (const [scope, client] of this.v2Scopes) {
      if (scope === originScope) continue;
      if (!affected.has(scope)) continue;
      // A2: before applying the derived delta, inject the lineage closure of
      // objects arriving in this scope so the relay can resolve their verb chains.
      if (originClient) {
        mergeIncomingObjectLineageClosure(scope, transcript, originClient.relay, client.relay,
          (event) => this.world.recordMetric(event));
      }
      // The one shared derived-cache application (authority rows + movement
      // projection + provenance + dirty-mark, no head advance).
      applyAcceptedFrameToDerivedRelayCache(client.relay, accepted, transcript);
    }
  }

  private scopeForV2Call(actor: ObjRef, target: ObjRef): ObjRef {
    const enclosing = this.host.enclosingSpaceFor(target);
    if (enclosing) return enclosing;
    const session = this.sessionsByActor(actor);
    return (session ? this.world.activeScopeForSession(session.woo.id) : null) ?? actor;
  }

  // Catalogs may declare deterministic owner-prefetch paths in verb metadata.
  // The gateway interprets only generic roots/path/fallback forms; command words
  // and catalog property names must stay in the manifest declarations.
  private likelyMovementOwnerAuthorityObjectIds(entry: SessionEntry, scope: ObjRef, target: ObjRef, verbName: string, argSpec?: Record<string, WooValue>): ObjRef[] {
    const prefetch = this.authorityPrefetchEntries(argSpec);
    if (prefetch.length === 0) return [];
    const ids = new Set<ObjRef>();
    const add = (id: ObjRef | null | undefined): void => {
      if (!id || id === "$nowhere") return;
      ids.add(id);
    };
    for (const item of prefetch) {
      for (const id of this.resolveAuthorityPrefetchValue(item, { entry, scope, target, verb: verbName })) add(id);
    }
    return Array.from(ids).sort();
  }

  private authorityPrefetchEntries(argSpec?: Record<string, WooValue>): WooValue[] {
    if (!argSpec) return [];
    const authority = argSpec.authority;
    if (!authority || typeof authority !== "object" || Array.isArray(authority)) return [];
    const prefetch = (authority as Record<string, WooValue>).prefetch;
    return Array.isArray(prefetch) ? prefetch : [];
  }

  private resolveAuthorityPrefetchValue(
    value: WooValue,
    context: { entry: SessionEntry; scope: ObjRef; target: ObjRef; verb: string }
  ): ObjRef[] {
    if (typeof value === "string") {
      const id = this.authorityPrefetchRoot(value, context);
      return id ? [id] : [];
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const map = value as Record<string, WooValue>;
    if (Array.isArray(map.first)) {
      for (const item of map.first) {
        const ids = this.resolveAuthorityPrefetchValue(item, context);
        if (ids.length > 0) return ids;
      }
      return [];
    }
    if (Array.isArray(map.path)) {
      const id = this.resolveAuthorityPrefetchPath(map.path, context);
      return id ? [id] : [];
    }
    return [];
  }

  private resolveAuthorityPrefetchPath(
    path: WooValue[],
    context: { entry: SessionEntry; scope: ObjRef; target: ObjRef; verb: string }
  ): ObjRef | null {
    if (path.length === 0 || typeof path[0] !== "string") return null;
    let cursor: WooValue | undefined = this.authorityPrefetchRoot(path[0], context) ?? undefined;
    for (const rawPart of path.slice(1)) {
      if (typeof rawPart !== "string") return null;
      const part = rawPart === "$verb" ? context.verb : rawPart;
      if (typeof cursor === "string") cursor = this.localObjectProp(cursor as ObjRef, part);
      else if (cursor && typeof cursor === "object" && !Array.isArray(cursor)) cursor = (cursor as Record<string, WooValue>)[part];
      else return null;
    }
    return typeof cursor === "string" ? cursor as ObjRef : null;
  }

  private authorityPrefetchRoot(
    root: string,
    context: { entry: SessionEntry; scope: ObjRef; target: ObjRef }
  ): ObjRef | null {
    if (root === "scope") return context.scope;
    if (root === "target") return context.target;
    if (root === "actor") return context.entry.woo.actor;
    return null;
  }

  private localObjectProp(id: ObjRef, name: string): WooValue | undefined {
    const row = this.world.exportObjects([id])[0];
    if (!row) return undefined;
    return row.properties.find(([prop]) => prop === name)?.[1];
  }

  private sessionsByActor(actor: ObjRef): SessionEntry | null {
    for (const entry of this.sessions.values()) {
      if (entry.woo.actor === actor) return entry;
    }
    return null;
  }

  private v2NodeFor(entry: SessionEntry): string {
    return `mcp:${entry.woo.id}`;
  }

  private applyGatewayProjectionWrites(projectionWrites: readonly ProjectionWrite[], transcript: EffectTranscript): void {
    const sessionWrites = projectionWrites.filter((write) => write.table === "sessions");
    const volatileWrites = projectionWrites.filter((write) => write.table !== "sessions");
    if (volatileWrites.length > 0) {
      this.world.applyProjectionWrites(volatileWrites, { persist: false, transcript });
    }
    if (sessionWrites.length > 0) {
      // Session activeScope is the durable routing hint for MCP queues after
      // gateway hibernation. Persist only session rows; object/log projection
      // rows remain SQL-cache-owned and volatile in WooWorld.
      this.world.applyProjectionWrites(sessionWrites, { transcript });
    }
  }

}

function mcpV2Token(woo: Session): string {
  return `mcp-v2:${woo.id}:${woo.actor}`;
}

function remoteAcceptedKey(commit: ShadowCommitAccepted): string {
  return `commit:${commit.position.scope}:${commit.position.seq}`;
}

function remoteLiveAcceptedKey(scope: ObjRef, transcript: EffectTranscript): string {
  return `live:${scope}:${transcript.hash}`;
}

function mcpFrameFromTurnReply(scope: ObjRef, reply: Extract<ShadowTurnExecReply, { ok: true }>): AppliedFrame | DirectResultFrame | ErrorFrame {
  if (reply.outcome.error) {
    return attachTranscript({
      op: "error",
      id: reply.id,
      error: reply.transcript.error ?? wooValueAsError(reply.outcome.error, "v2 MCP turn failed")
    }, reply.transcript);
  }
  if (reply.transcript.route === "direct") {
    return attachTranscript({
      op: "result",
      id: reply.id,
      command: reply.transcript.call,
      // DirectResultFrame requires a result value; direct calls that return
      // nothing have historically surfaced null rather than omitting it.
      result: reply.outcome.result ?? null,
      observations: reply.transcript.observations,
      audience: scope
    }, reply.transcript);
  }
  // ShadowCommitAccepted.position is the authority head, not log metadata; it
  // currently carries no accepted-at timestamp. Keep the old planned-frame
  // wall clock until commit replies grow an explicit authoritative timestamp.
  return attachTranscript({
    op: "applied",
    id: reply.id,
    space: reply.commit?.position.scope ?? reply.transcript.scope,
    seq: reply.commit ? Number(reply.commit.position.seq) : reply.transcript.seq,
    ts: Date.now(),
    message: {
      actor: reply.transcript.call.actor,
      target: reply.transcript.call.target,
      verb: reply.transcript.call.verb,
      args: reply.transcript.call.args
    },
    observations: reply.transcript.observations,
    // AppliedFrame.result is optional. Preserve null when the verb returned
    // null, and omit undefined so JSON output matches normal applied frames.
    ...(reply.transcript.result !== undefined ? { result: reply.transcript.result } : {})
  }, reply.transcript);
}

function liveFrameFromTranscript(scope: ObjRef, transcript: EffectTranscript): DirectResultFrame {
  return attachTranscript({
    op: "result",
    id: transcript.id,
    command: transcript.call,
    result: transcript.result ?? null,
    observations: transcript.observations,
    audience: scope
  }, transcript);
}

function attachTranscript<T extends AppliedFrame | DirectResultFrame | ErrorFrame>(frame: T, transcript: EffectTranscript): T {
  // MCP host uses this internal hint to decide whether a post-call tool-list
  // refresh is necessary. Keep it non-enumerable so public frame JSON and
  // broadcast payloads remain unchanged.
  Object.defineProperty(frame, "transcript", { value: transcript, enumerable: false });
  return frame;
}

function wooValueAsError(value: WooValue, fallbackMessage: string): ErrorValue {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const code = typeof value.code === "string" ? value.code : "E_INTERNAL";
    const message = typeof value.message === "string" ? value.message : fallbackMessage;
    return { code, message, value };
  }
  return { code: "E_INTERNAL", message: fallbackMessage, value };
}

function authTokenFromHeaders(headers: Headers): string | null {
  const explicit = headers.get(MCP_TOKEN_HEADER)?.trim();
  if (explicit) return explicit;
  const authorization = headers.get(AUTHORIZATION_HEADER)?.trim();
  if (!authorization) return null;
  const match = /^bearer\s+(.+)$/i.exec(authorization);
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

function isAcceptedWooAuthToken(token: string): boolean {
  // Keep MCP's first-request auth vocabulary aligned with REST auth. Without
  // this gate, `world.auth` treats arbitrary strings as bearer-style guest
  // bootstrap tokens, which is convenient locally but too permissive on MCP.
  return token.startsWith("guest:")
    || token.startsWith("session:")
    || token.startsWith("wizard:")
    || token.startsWith("apikey:");
}

function withRequiredMcpAccept(request: Request): Request {
  const headers = new Headers(request.headers);
  const accept = headers.get("accept") ?? "";
  const needed = ["application/json", "text/event-stream"].filter((type) => !accept.toLowerCase().includes(type));
  if (needed.length === 0) return request;
  headers.set("accept", [accept.trim(), ...needed].filter(Boolean).join(", "));
  return new Request(request, { headers });
}

async function mcpError(request: Request, status: number, rpcCode: number, code: string, message: string): Promise<Response> {
  const id = await jsonRpcIdFromRequest(request);
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code: rpcCode,
      message,
      data: { code }
    }
  }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function jsonRpcProbeFromRequest(request: Request): Promise<{ method: string | null; tool?: string }> {
  if (request.method !== "POST") return { method: null };
  try {
    const parsed = await request.clone().json() as unknown;
    const single = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!single || typeof single !== "object") return { method: null };
    const m = (single as { method?: unknown }).method;
    const method = typeof m === "string" ? m : null;
    if (method === "tools/call") {
      const params = (single as { params?: { name?: unknown } }).params;
      const name = params && typeof params.name === "string" ? params.name : undefined;
      return { method, tool: name };
    }
    return { method };
  } catch {
    return { method: null };
  }
}

async function jsonRpcIdFromRequest(request: Request): Promise<string | number | null> {
  if (request.method !== "POST") return null;
  try {
    const parsed = await request.clone().json() as unknown;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const id = jsonRpcIdFromValue(item);
        if (id !== null) return id;
      }
      return null;
    }
    return jsonRpcIdFromValue(parsed);
  } catch {
    return null;
  }
}

function jsonRpcIdFromValue(value: unknown): string | number | null {
  if (!value || typeof value !== "object") return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" || id === null ? id : null;
}

function synthesizeInitializeRequest(): Request {
  return new Request("http://gateway.internal/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "resume",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "woo-resume", version: "0.0.0" }
      }
    })
  });
}

export type { ObjRef };
