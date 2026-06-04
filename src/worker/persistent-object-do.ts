// PersistentObjectDO — Cloudflare host for the world gateway or an anchor cluster.
//
// The "world" host remains the gateway for auth, WebSockets, global
// catalog/admin surfaces, and bundled state aggregation. Directory-routed
// anchor clusters use the same storage schema, but initialize from a
// host-scoped world slice exported by the gateway: hosted objects, their
// parent/feature/bytecode support objects, hosted logs, snapshots, and tasks.
// They do not auto-install the bundled catalogs or claim independent bootstrap
// authority, but they do apply host-scoped catalog migration plans and data
// migrations for the objects they actually own.
//
// What's wired through fetch() / the v2 WS handlers:
// - REST routing ported from src/server/dev-server.ts: auth, describe (with
//   actor-permission filtering), property reads (filtered), sequenced and
//   direct verb calls (with broadcast to connected WS clients), log paging.
// - v2 turn-network WebSocket upgrade with the CF hibernation API:
//   state.acceptWebSocket, serializeAttachment, and webSocketMessage/Close/Error
//   handlers. V2 sockets carry protocol-scoped attachments so
//   wake-from-hibernation can route frames back to CommitScopeDO.
//
// What's still deferred to later phases:
// - Alarms for parked tasks (Phase 4): state.storage.setAlarm + alarm()
//   handler. Needed for FORK/SUSPEND wakeups on CF.
// - Authoring REST endpoints (/api/compile, /api/install, /api/property,
//   /api/property/value, /api/authoring/objects/{create,move,chparent}) — the
//   IDE tab can read on CF but not author.
// - Private GitHub tap auth/cache policy — public GitHub taps are wired;
//   private repos and content-hash caching are deferred.

import { createWorld, createWorldFromSerialized, mergeHostScopedSeedWithStatus, nonEmptyHostScopedWorld } from "../core/bootstrap";
import {
  authoritySlicePageCount,
  authoritySliceObjectIds,
  buildSerializedAuthorityCellSlice,
  cellProvenanceFromAuthoritySlice,
  combineSerializedAuthoritySlices,
  filterSerializedAuthoritySlicePages,
  isAuthorityCellSlice,
  withAuthorityPageProvenance,
  serializedWorldFromAuthoritySlice
} from "../core/authority-slice";
import { shadowObjectLineagePage, shadowObjectLivePage, shadowPropertyCellPages, stampAuthorityPageRef, type AuthorityPageProvenance, type ShadowStatePage } from "../core/shadow-state-pages";
import type { EffectTranscript } from "../core/effect-transcript";
import { installLocalCatalogs, localCatalogBundleFingerprint, parseAutoInstallCatalogs, runHostScopedLocalCatalogLifecycle } from "../core/local-catalogs";
import {
  handleRestProtocolRequest,
  restFrameFromTurnReply,
  statusForError,
  type RestProtocolHost,
  type RestProtocolRequest
} from "../core/protocol";
import type { ErrorValue, MetricEvent, ObjRef, Observation, RemoteToolDescriptor, RemoteToolRequest, Session, TinyBytecode, VerbDef, WooValue } from "../core/types";
import { directedRecipients, freezeTinyBytecode, publicAppliedFrame, sessionActiveScopeFromRecord, wooError } from "../core/types";
import type { AppliedFrame, DirectResultFrame, ErrorFrame, LiveEventFrame, Message } from "../core/types";
import type { SeedWorld, SerializedAuthorityCellSlice, SerializedAuthoritySlice, SerializedObject, SerializedSession, SerializedWorld, TombstoneRecord } from "../core/repository";
import { createHostOperationMemo, normalizeError } from "../core/world";
import { installGitHubTap, updateGitHubTap, type CatalogTapLogEvent } from "../core/catalog-taps";
import type { ShadowCapabilityAd } from "../core/capability-ad";
import {
  createShadowBrowserRelayShim,
  publishShadowBrowserAcceptedFrame,
  shadowLiveEventsForTranscriptRelay,
  shadowBrowserSessionBearer,
  shadowBrowserSessionClaimsValue,
  type ShadowLiveEvent,
  type ShadowBrowserStateTransfer
} from "../core/shadow-browser-node";
import {
  applyAcceptedFrameToDerivedRelayCache,
  applyAcceptedFrameToRelayCache,
  installShadowCellPageTransferAsAuthority,
  markShadowBrowserRelaySerializedChanged,
  mergeAuthorityIntoRelayCache,
  type ShadowRelayCache
} from "../core/shadow-relay-cache";
import { parseShadowScopeHeadJson } from "../core/shadow-scope-head";
import { buildTransportErrorEnvelope, decodeEnvelope, encodeEnvelope, type ShadowEnvelope } from "../core/shadow-envelope";
import type { ShadowStateTransfer, ShadowTurnExecReply } from "../core/shadow-turn-exec";
import { runShadowTurnCall } from "../core/shadow-turn-call";
import { authoritativePlanningWorld } from "../core/planning-world";
import {
  serializedFor,
  shadowLocationCommitScopeForTranscript,
  transcriptTouchedObjectIds,
  type ShadowCommitAccepted,
  type ShadowScopeHead
} from "../core/shadow-commit-scope";
import { isShadowCommitAccepted, isShadowTurnExecReply } from "../core/v2-reply-predicates";
import {
  affectedBrowserFanoutScopes,
  affectedMcpFanoutScopes,
  affectedTranscriptScopes,
  buildV2FanoutLiveEvents,
  planV2BrowserFanout,
  shadowLiveEventMatchesPeerScope
} from "../core/v2-fanout-projection";
import { runShadowApply, type ShadowApplyTarget } from "../core/v2-shadow-apply";
import { fanOutHostWrites, partitionProjectionWritesByHost } from "../core/object-host-write-through";
import {
  V2_COMMIT_SCOPE_SNAPSHOT_REQUIRED,
  buildExecutionCapsule,
  submitTurnIntent,
  executorAuthorityObjectIds,
  executorAuthorityPayload,
  executorEnvelopeId,
  type ExecutorAuthorityPayload,
  type ExecutorEnvelopeBody
} from "../core/executor";
import { CFObjectRepository } from "./cf-repository";
import { McpGateway, type McpV2EnvelopeResult, type McpV2OpenResult } from "../mcp/gateway";
import { signInternalRequest, verifyInternalRequest } from "./internal-auth";
import { hashSource } from "../core/source-hash";
import { stableShadowJson } from "../core/shadow-cell-version";
import {
  projectionDeltaMissingWrites,
  summarizeProjectionWrites,
  type BrowserProfile,
  type CheckpointTailOpenTransfer,
  type OpenTransfer,
  type ProjectionDeltaSummary,
  type ProjectionWrite,
  type SessionToolManifest,
  type ToolSurfaceProjectionRow
} from "../core/projection-delta";
import { metricErrorFields } from "./metric-errors";
import { writeMetricToAnalytics, writeConstructorMetricToAnalytics } from "./metrics-sink";

// Re-import WooWorld type. Note `import type` must reach the world module
// without dragging Node-only deps into the Worker bundle.
import type { CallContext, DeferredHostEffect, ExecutorContext, HostObjectSummary, HostOperationMemo, MoveObjectResult, OverlaySnapshot, RoomSnapshot, ScopedObjectSummary, WooWorld } from "../core/world";

export interface Env {
  WOO: DurableObjectNamespace;
  DIRECTORY: DurableObjectNamespace;
  COMMIT_SCOPE?: DurableObjectNamespace;
  ASSETS?: Fetcher;
  WOO_INITIAL_WIZARD_TOKEN?: string;
  WOO_INTERNAL_SECRET?: string;
  TURNSTILE_SECRET_KEY?: string;
  WOO_AUTO_INSTALL_CATALOGS?: string;
  WOO_HOST_READ_TIMEOUT_MS?: string;
  WOO_HOST_WRITE_TIMEOUT_MS?: string;
  WOO_HOST_OUT_FETCH_CONCURRENCY?: string;
  WOO_MCP_GATEWAY_SHARDS?: string;
  WOO_TOOL_SURFACE_SOURCE_INDEX_MAX_ROWS?: string;
  WOO_TOOL_SURFACE_SOURCE_INDEX_MAX_SHARD_ROWS?: string;
  WOO_V2_CHECKPOINT_TAIL_OPEN?: string;
  WOO_V2_BROWSER_CHECKPOINT_TAIL_OPEN?: string;
  WOO_BROWSER_PROJECTION_HOLDER?: string;
  WOO_V2_EXECUTION_CAPSULE?: string;
  // Workers Analytics Engine binding. The metrics-sink module writes every
  // `MetricEvent` here (modulo sampling) so /admin/stats can query historical
  // counts and latencies without depending on tail-time consumption.
  METRICS?: import("./metrics-sink").MetricsAnalyticsBinding;
  // /admin/ HTTP Basic auth password. Set via
  //   wrangler secret put ADMIN_PASSWORD
  // When unset, /admin/* always returns 503 — the admin panel fails closed.
  ADMIN_PASSWORD?: string;
  // Cloudflare account-scoped API token with Account Analytics: Read.
  // /admin/series proxies AE SQL through this. Set via
  //   wrangler secret put CF_ANALYTICS_TOKEN
  // and put the account id in CF_ACCOUNT_ID (a [vars] entry, not a secret).
  CF_ANALYTICS_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  // AE dataset that /admin/series queries. Set via [vars] (per env) so
  // staging hits `woo_v1_staging` and prod hits `woo_v1_prod`; defaults
  // to `woo_v1_prod` for unset envs to fail safely toward production.
  WOO_AE_DATASET?: string;
  // KV-fronted host-seed cache. Populated by WORLD on every host-seed
  // build (via waitUntil so the build itself isn't blocked) and read by
  // satellite cold-loads before they fall back to WORLD's DO. See
  // wrangler.toml [[kv_namespaces]] binding HOST_SEED_KV.
  HOST_SEED_KV?: KVNamespace;
}

type CommitScopeLegacyOpenResponse = {
  ok: true;
  relay: string;
  head?: ShadowScopeHead;
  hello: {
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
  transfer: ShadowBrowserStateTransfer;
  executable_transfer?: ShadowBrowserStateTransfer;
  ads?: ShadowCapabilityAd[];
};

type CommitScopeCheckpointTailOpenResponse = {
  ok: true;
  open_protocol: "checkpoint_tail.v1";
  relay: string;
  head: ShadowScopeHead;
  hello: CommitScopeLegacyOpenResponse["hello"];
  transfer: OpenTransfer | OpenTransfer<BrowserProfile>;
};

type CommitScopeOpenResponse = CommitScopeLegacyOpenResponse | CommitScopeCheckpointTailOpenResponse;

type CommitScopeEnvelopeResponse = {
  ok: true;
  reply: string | null;
  receiver_reply?: string | null;
  fanout?: Array<{ node: string; envelope: string }>;
  head?: ShadowScopeHead;
};

type CommitScopeStateTransferResponse = {
  ok: true;
  relay: string;
  transfer: ShadowBrowserStateTransfer;
};

type RestV2RelayClient = {
  scope: ObjRef;
  node: string;
  relay: ShadowRelayCache;
  openedAt: number;
  nextTurn: number;
};

type AuthorityReconstructionReason = "warm_turn_refresh" | "cold_open" | "missing_state_repair";

type V2LocalHostMaterialization = {
  hostKey: string;
  gatewayHost: boolean;
} | null;

type V2FanoutDelivery = {
  localHostMaterialized: V2LocalHostMaterialization;
  mcpAudience?: McpFanoutAudience;
};

type BrowserMetricSessionCounter = {
  windowStart: number;
  seen: number;
  lastSeen: number;
};

type DirectorySerializedSession = SerializedSession & {
  displayName?: string | null;
  focusList?: ObjRef[];
  actorProps?: DirectorySessionActorProp[];
};

type DirectorySessionActorProp = {
  name: string;
  value: WooValue;
  version: number;
};

type McpFanoutAudience = {
  audienceActors?: ObjRef[];
  observationAudiences?: ObjRef[][];
  audienceSessions?: string[];
  observationSessionAudiences?: string[][];
};

type DirectoryScopeSessionsCacheEntry = {
  expiresAt: number;
  value?: DirectorySerializedSession[];
  promise?: Promise<DirectorySerializedSession[]>;
};

type V2SocketAttachment = {
  sessionId: string;
  actor: ObjRef;
  socketId: string;
  protocol?: "v2-turn-network";
  node?: string;
  scope: ObjRef;
  token?: string;
  openedAt?: number;
  stateHead?: ShadowScopeHead;
};
type ActiveV2SocketAttachment = V2SocketAttachment & { protocol: "v2-turn-network"; node: string };

const WORLD_HOST = "world";
const MCP_GATEWAY_SHARD_PREFIX = "mcp-gateway-";
const DEFAULT_MCP_GATEWAY_SHARDS = 32;
const MCP_GATEWAY_SCOPE_CONTENT_AUTHORITY_LIMIT = 128;
// Roots of the universal actor/thing lineage carried into every MCP gateway-shard
// world so verb / property resolution can walk the ancestor chain locally. The
// carried set is the COMPLETE closure of these roots (their full class subtree
// plus every ancestor up to `$system`, the lineage top with parent:null) —
// computed from the seed in mcpGatewayActorSupportObjects(), not hand-listed.
//
// A hand-maintained id list was wrong twice: it omitted `$system` (so every
// `$root -> $system` walk dangled) and `$guest`/`$human`/`$agent` (so every
// guest/human/agent actor's `<actor> -> $<class>` walk dangled) — a
// `dangling_parent_ref` storm (~one per resolution per turn) that silently
// degraded resolution and forced per-turn authority-slice fan-in. Closing over
// the roots makes the set self-maintaining as the seed lineage evolves.
//
// Scope lineage (`$space`) is intentionally NOT a root here — it stays owner
// authority and arrives via the room's authority slice (see
// mcpGatewayDirectorySessionCellSlice), so a sparse `$space` stub never
// overwrites a real `$chatroom`.
// Exported for the cf-local regression guard, which asserts (a) the seed-derived
// closure of these roots is carried with zero dangling ancestors, and (b) these
// roots contain NO scope/catalog class (e.g. $space, $chatroom) — so the
// remaining scope-lineage dangle can never be "fixed" by broadening the
// universal support set instead of by the authority slice (perf-plan step 2).
export const MCP_GATEWAY_ACTOR_SUPPORT_ROOTS: readonly ObjRef[] = ["$actor", "$thing"];
const DEFAULT_TOOL_SURFACE_SOURCE_INDEX_MAX_SCOPE_ROWS = 10_000;
const DEFAULT_TOOL_SURFACE_SOURCE_INDEX_MAX_SHARD_ROWS = 40_000;
const MAX_REST_V2_RELAY_CLIENTS = 64;
const DIRECTORY_HOST = "directory";
const INTERNAL_ORIGIN = "https://woo.internal";
const MAX_JSON_BODY_BYTES = 1 * 1024 * 1024;
const HOST_SEED_KV_KIND = "woo.host_seed.kv.bytecode_free.v1";
const MAX_BROWSER_METRICS_BATCH = 200;
const MAX_BROWSER_METRIC_STRING = 160;
const BROWSER_METRICS_SESSION_BUDGET = 60;
const BROWSER_METRICS_OVER_BUDGET_SAMPLE_RATE = 10;
const BROWSER_METRICS_COUNTER_TTL_MS = 5 * 60_000;
const METRIC_SAMPLE_BUDGET = 10;
const METRIC_SAMPLE_WINDOW_MS = 1000;
// Read-only cross-host RPCs (room-snapshot, remote-get-prop, contents, etc.)
// are deadlined tightly so a wedge surfaces fast and the local task chain
// can fall back to a degraded reply. 5s is the working ceiling: a hot
// remote settles in ~50ms, but a cold-start DO has to load persistence,
// run bootstrap, and serve the snapshot, which can spike to 3-4s on first
// touch. Override per deployment via WOO_HOST_READ_TIMEOUT_MS.
const HOST_READ_RPC_TIMEOUT_MS = 5000;
// Mutating cross-host RPCs do not have an inherent deadline (a write that
// takes 30s may still be making progress), but a wedged DO can park a slot
// forever and the local task chain along with it. The watchdog is a
// generous safety net: if no response has come back by this point, the
// remote is assumed unreachable, the slot is released, and the caller sees
// E_TIMEOUT. Aborting mid-write may leave ambiguous remote state — but
// indefinite hang is already a worse failure mode (the whole DO becomes
// unresponsive). Most operations on this codebase are inherently
// idempotent (set_property, observe, mirror-contents).
const HOST_WRITE_RPC_TIMEOUT_MS = 30_000;
// Directory-backed room presence is a live hint used to make sparse MCP
// shards render roster reads. Keep the cache deliberately short: enough to
// collapse duplicate who/look planning reads in one burst without making
// a moved/disconnected actor linger in user-visible room text.
const DIRECTORY_SCOPE_SESSIONS_TTL_MS = 1_000;
const DIRECTORY_SCOPE_SESSIONS_CACHE_MAX = 128;
// Cap on concurrent DO->DO fetch() subrequests issued by this isolate. The
// Workers runtime enforces its own ~6-slot limit; we self-limit slightly under
// that and queue the overflow so cold-start fan-outs (compose_look hitting 4
// remote hosts × N concurrent looks) don't all pile against the runtime queue
// at once. Saturation is visible in the cross_host_rpc metric's queue_ms field.
const HOST_OUT_FETCH_CONCURRENCY = 5;
// Race a Promise against an AbortSignal. If the signal aborts first, reject
// with the signal's reason; the underlying Promise is orphaned (real fetch
// implementations cancel via the Request signal as well, so this is just a
// belt-and-suspenders early-out for environments — like test fakes — that
// don't honor the signal on the Request).
function raceAgainstAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? wooError("E_ABORTED", "aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? wooError("E_ABORTED", "aborted"));
    };
    signal.addEventListener("abort", onAbort);
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (err) => { signal.removeEventListener("abort", onAbort); reject(err); }
    );
  });
}

function webSocketProtocols(request: Request): string[] {
  return (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function commitScopeErrorFromPayload(payload: unknown): ErrorValue | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string" || !code) return null;
  const message = (error as { message?: unknown }).message;
  const value = (error as { value?: unknown }).value;
  return {
    code,
    ...(typeof message === "string" ? { message } : {}),
    ...(value === undefined ? {} : { value: value as WooValue })
  };
}

function isCommitScopeSnapshotRequiredError(err: unknown): boolean {
  const error = normalizeError(err);
  if (error.code === V2_COMMIT_SCOPE_SNAPSHOT_REQUIRED) return true;
  return commitScopeErrorFromPayload(error.value)?.code === V2_COMMIT_SCOPE_SNAPSHOT_REQUIRED;
}

function isCommitScopeCheckpointPendingError(err: unknown): boolean {
  const error = normalizeError(err);
  if (error.code === "E_CHECKPOINT_PENDING") return true;
  return commitScopeErrorFromPayload(error.value)?.code === "E_CHECKPOINT_PENDING";
}

function isCheckpointTailOpenResponse(response: CommitScopeOpenResponse): response is CommitScopeCheckpointTailOpenResponse {
  return (response as { open_protocol?: unknown }).open_protocol === "checkpoint_tail.v1";
}

// Internal RPC routes that are pure reads of world state and therefore safe
// to coalesce: while one fetch is in flight, identical concurrent requests
// (same host + path + body) attach to the same Promise rather than each
// firing a fresh subrequest. Single-flight only — once the Promise settles,
// the next call computes anew, so freshness is automatic without a TTL.
// Mutating routes (remote-dispatch, ws-call, ws-direct, mirror-contents,
// space-subscriber, register-objects, register-session, host-seed, etc.)
// MUST NOT be added: coalescing them would deduplicate intentional repeated
// writes.
const COALESCEABLE_INTERNAL_PATHS: ReadonlySet<string> = new Set([
  "/__internal/object-summaries",
  "/__internal/object-summary",
  "/__internal/authority-slice",
  "/__internal/remote-describe-many",
  "/__internal/remote-get-prop",
  "/__internal/replay",
  "/__internal/actor-session-locations-batch",
  "/__internal/space-audience-sessions",
  "/__internal/room-snapshot",
]);
// Per spec/semantics/recycle.md §RC11.3 step 2: tombstone roster handed to
// Directory in batches sized to stay well under the 512 KiB Directory cap.
// 1000 records × ~80 bytes per JSON entry ≈ 80 KiB, leaving ample headroom
// for header overhead.
const INHERIT_TOMBSTONES_BATCH_SIZE = 1000;
// Meta key under which the §RC11.2 host-teardown state is persisted.
const HOST_STATE_META_KEY = "host_state";
const HOST_STATE_TEARING_DOWN = "tearing_down";
// Last gateway-supplied host-seed digest the satellite successfully merged.
// On a subsequent cold-load, the satellite probes the gateway for the
// current digest and skips the full seed transfer when it matches — see
// createHostScopedWorld below.
const HOST_SEED_DIGEST_META_KEY = "host_seed_digest";
const LOCAL_CATALOG_BUNDLE_FINGERPRINT_META_KEY = "local_catalog_bundle_fingerprint";
export const LOCAL_CATALOG_BUNDLE_REPAIR_EPOCH = "resident-catalog-repair-v3";
// SHA-256 of the (id|host|anchor) triples this DO last successfully
// published to the Directory, sorted by id. On gateway cold-restart we
// recompute the digest from the current route set and skip the
// register-objects RPC entirely when it matches — see
// registerObjectRoutes. Assumes Directory state persists; an
// independently-wiped Directory recovers on the next route mutation,
// which bumps the digest and triggers a fresh publish.
const PUBLISHED_ROUTES_DIGEST_META_KEY = "published_routes_digest";

export class PersistentObjectDO {
  private state: DurableObjectState;
  private env: Env;
  private repo: CFObjectRepository;
  private world: WooWorld | null = null;
  private routeCache = new Map<ObjRef, string>();
  private localRouteSnapshot: {
    hostKey: string;
    version: number;
    routes: Map<ObjRef, { id: ObjRef; host: string; anchor: ObjRef | null }>;
  } | null = null;
  private publishedRoutes = new Map<ObjRef, string>();
  private routesRegistered = false;
  private mcpGateway: McpGateway | null = null;
  // Gateway-owned REST relays mirror the browser/MCP open-once shape. Keep a
  // bounded per-DO LRU so agents that touch many scopes do not retain full
  // serialized snapshots for the lifetime of a hot Durable Object instance.
  private restV2Relays = new Map<ObjRef, RestV2RelayClient>();
  // Cross-host property cache for stable, hot-path property reads
  // (actor.name in a verb that runs on a different host's DO is a common
  // case). Keyed by `${host}|${objRef}|${name}`. Only entries for
  // CROSS_HOST_STABLE_PROPS are populated; everything else still pays the
  // RPC. TTL-based with a hard cap to bound memory.
  private crossHostPropCache = new Map<string, { value: unknown; expiresAt: number }>();
  private static readonly CROSS_HOST_STABLE_PROPS = new Set(["name", "description", "aliases"]);
  private static readonly CROSS_HOST_PROP_TTL_MS = 30_000;
  private static readonly CROSS_HOST_PROP_CACHE_MAX = 1024;
  // Actor -> live WebSocket set on this DO. Avoids the per-broadcast
  // state.getWebSockets() scan: broadcast iterates the audience's actors
  // (from world.presenceActorsIn) and looks up sockets directly. Built
  // on rehydrate and maintained on attach/detach.
  private socketsByActor = new Map<ObjRef, Set<WebSocket>>();
  private socketsBySession = new Map<string, Set<WebSocket>>();
  // FIFO semaphore for outbound DO->DO fetch() concurrency. See
  // HOST_OUT_FETCH_CONCURRENCY. The releaser hands the slot directly to the
  // next waiter (no decrement-then-increment) to avoid an over-cap race when a
  // releaser and a fresh acquire run concurrently.
  private outFetchInFlight = 0;
  private outFetchQueue: Array<() => void> = [];
  // Single-flight coalesce table for COALESCEABLE_INTERNAL_PATHS. Key is
  // `${host}\n${path}\n${bodyStr}`; value is the in-flight Promise. Cleared on
  // settle (resolve or reject) so the next call recomputes against fresh state.
  private outFetchInflight = new Map<string, Promise<unknown>>();
  // Short-lived single-flight cache for Directory session lookups used by
  // sparse MCP shard presence reads. Directory is a singleton; without this,
  // back-to-back roster verbs can add synchronous singleton pressure during
  // the post-deploy cold-load window.
  private directoryScopeSessionsCache = new Map<string, DirectoryScopeSessionsCacheEntry>();
  // Per spec/semantics/recycle.md §RC11. Cached host_state — null means
  // "not yet read this lifetime"; afterwards the cached string is "live"
  // or "tearing_down". Resets on DO eviction.
  private cachedTeardownState: string | null = null;
  // Set true once a teardown sequence has been scheduled in this DO
  // lifetime so we don't double-fire it from concurrent fetch handlers.
  private teardownScheduled = false;

  constructor(state: DurableObjectState, env: Env) {
    const constructorStartedAt = Date.now();
    this.state = state;
    this.env = env;
    this.repo = new CFObjectRepository(state, (event) => this.emitMetric(event, this.durableHostKey()));
    this.migrateGatewayProjectionCache();
    const constructorMs = Date.now() - constructorStartedAt;
    console.log("woo.metric", JSON.stringify({ kind: "do_constructor", class: "PersistentObjectDO", ms: constructorMs, ts: Date.now(), host_key: this.durableHostKey() }));
    writeConstructorMetricToAnalytics("PersistentObjectDO", constructorMs, this.durableHostKey(), this.env.METRICS);
  }

  private migrateGatewayProjectionCache(): void {
    // Projection-cache tables are idempotent existing-DO SQL migrations. They
    // are created on every host because PersistentObjectDO uses one class for
    // world, gateway shards, and object hosts; only gateway shards write them
    // (a world/object host never routes accepted fanout through the cache).
    const sql = this.state.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS gateway_projection_scope (
      scope TEXT PRIMARY KEY,
      head_seq INTEGER NOT NULL,
      head_hash TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      stale INTEGER NOT NULL DEFAULT 0,
      stale_reason TEXT
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS gateway_projection_object (
      id TEXT NOT NULL,
      authority_scope TEXT NOT NULL,
      body TEXT NOT NULL,
      last_apply_seq INTEGER NOT NULL,
      last_apply_hash TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      stale INTEGER NOT NULL DEFAULT 0,
      stale_reason TEXT,
      PRIMARY KEY(authority_scope, id)
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS gateway_scope_member (
      scope TEXT NOT NULL,
      id TEXT NOT NULL,
      authority_scope TEXT NOT NULL,
      role TEXT NOT NULL,
      last_apply_seq INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY(scope, id, role)
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS gateway_projection_session (
      session_id TEXT PRIMARY KEY,
      scope TEXT,
      actor TEXT NOT NULL,
      body TEXT NOT NULL,
      last_apply_seq INTEGER NOT NULL,
      last_apply_hash TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      stale INTEGER NOT NULL DEFAULT 0,
      stale_reason TEXT
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS gateway_tool_surface (
      scope TEXT NOT NULL,
      object TEXT NOT NULL,
      object_authority_scope TEXT NOT NULL,
      body TEXT NOT NULL,
      last_apply_seq INTEGER NOT NULL,
      last_apply_hash TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      stale INTEGER NOT NULL DEFAULT 0,
      stale_reason TEXT,
      PRIMARY KEY(scope, object)
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS gateway_session_tool_manifest (
      session_id TEXT PRIMARY KEY,
      actor TEXT NOT NULL,
      active_scope TEXT NOT NULL,
      body TEXT NOT NULL,
      last_apply_seq INTEGER NOT NULL,
      last_apply_hash TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      stale INTEGER NOT NULL DEFAULT 0,
      stale_reason TEXT
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS gateway_tool_surface_source (
      scope TEXT NOT NULL,
      source_table TEXT NOT NULL,
      source_authority_scope TEXT NOT NULL,
      source_key TEXT NOT NULL,
      object TEXT NOT NULL,
      PRIMARY KEY(scope, source_table, source_authority_scope, source_key, object)
    )`);
    // Invalidation looks up every cached tool surface that depended on a changed
    // authority row. The primary key is scope-first for descriptor reads; this
    // reverse index keeps fanout apply from scanning all source rows on each
    // object write.
    sql.exec(`CREATE INDEX IF NOT EXISTS gateway_tool_surface_source_lookup
      ON gateway_tool_surface_source(source_table, source_authority_scope, source_key)`);
    // A saturated scope is read as a cache miss so MCP can fall back to the
    // session manifest or owner refresh instead of serving a partial tool list.
    sql.exec(`CREATE TABLE IF NOT EXISTS gateway_tool_surface_scope (
      scope TEXT PRIMARY KEY,
      saturated INTEGER NOT NULL DEFAULT 0,
      saturated_reason TEXT,
      updated_at_ms INTEGER NOT NULL
    )`);
  }

  private toolSurfaceSourceIndexMaxScopeRows(): number {
    return nonNegativeIntegerEnv(
      this.env.WOO_TOOL_SURFACE_SOURCE_INDEX_MAX_ROWS,
      DEFAULT_TOOL_SURFACE_SOURCE_INDEX_MAX_SCOPE_ROWS
    );
  }

  private toolSurfaceSourceIndexMaxShardRows(): number {
    return nonNegativeIntegerEnv(
      this.env.WOO_TOOL_SURFACE_SOURCE_INDEX_MAX_SHARD_ROWS,
      DEFAULT_TOOL_SURFACE_SOURCE_INDEX_MAX_SHARD_ROWS
    );
  }

  private checkpointTailOpenEnabled(): boolean {
    return envFlag(this.env.WOO_V2_CHECKPOINT_TAIL_OPEN);
  }

  private browserProjectionHolderEnabled(): boolean {
    return envFlag(this.env.WOO_BROWSER_PROJECTION_HOLDER);
  }

  private browserCheckpointTailOpenEnabled(): boolean {
    return this.browserProjectionHolderEnabled() && this.checkpointTailOpenEnabled() && envFlag(this.env.WOO_V2_BROWSER_CHECKPOINT_TAIL_OPEN);
  }

  private withCheckpointTailOpen(body: Record<string, unknown>): Record<string, unknown> {
    return {
      ...body,
      open_protocol: "checkpoint_tail.v1",
      known_head: body.known_head ?? body.last_known_head ?? null
    };
  }

  private withoutCheckpointTailOpen(body: Record<string, unknown>): Record<string, unknown> {
    const { open_protocol, known_head, transfer_budget_bytes, max_tail_frames, continuation, ...legacy } = body;
    void open_protocol;
    void known_head;
    void transfer_budget_bytes;
    void max_tail_frames;
    void continuation;
    return legacy;
  }

  private loadGatewaySessionToolManifest(sessionId: string): SessionToolManifest | null {
    const row = firstSqlRow<{ body: string }>(this.state.storage.sql.exec(
      "SELECT body FROM gateway_session_tool_manifest WHERE session_id = ? AND expires_at_ms > ?",
      sessionId,
      Date.now()
    ));
    if (!row) return null;
    const parsed = JSON.parse(row.body) as unknown;
    return isSessionToolManifest(parsed) ? parsed : null;
  }

  private saveGatewaySessionToolManifest(manifest: SessionToolManifest): void {
    const body = stableShadowJson(manifest as unknown as WooValue);
    this.state.storage.sql.exec(
      `INSERT OR REPLACE INTO gateway_session_tool_manifest(
        session_id, actor, active_scope, body, last_apply_seq, last_apply_hash, updated_at_ms, expires_at_ms, stale, stale_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      manifest.session_id,
      manifest.actor,
      manifest.active_scope,
      body,
      manifest.last_apply_seq,
      manifest.last_apply_hash,
      manifest.updated_at_ms,
      manifest.expires_at_ms,
      manifest.stale ? 1 : 0,
      manifest.stale_reason ?? null
    );
  }

  private applyGatewayProjectionWrites(
    position: ShadowScopeHead,
    writes: readonly ProjectionWrite[],
    source: "rest" | "mcp" | "fanout",
    delta?: ProjectionDeltaSummary
  ): { rows: number; bytes: number } {
    this.requireProjectionWritesComplete(position.scope, delta, writes, `gateway_projection:${source}`);
    // The gateway cache stores accepted projection rows durably so a hibernated
    // MCP shard can answer descriptor reads without reconstructing an
    // executable WooWorld mirror first. Auth and execution still use the
    // authoritative paths, not these stale-tolerant rows.
    const sql = this.state.storage.sql;
    const now = Date.now();
    let rows = 0;
    let bytes = 0;
    const authorityScope = position.scope;
    // Accepted-fanout application is idempotent by scope head. A duplicate
    // envelope replay or a redelivered fanout frame carries a position already
    // reflected in the cache; re-applying it would burn durable writes for no
    // state change (and could regress a newer head that arrived first). A cold
    // shard that has never seen this scope has no head row and falls through.
    // Out-of-order fanout is prevented upstream by sequencing against this same
    // head (see durableProjectionHeadSeq); this guard is the final protection.
    const existingHead = this.gatewayProjectionHeadSeq(authorityScope);
    if (existingHead != null && position.seq <= existingHead) return { rows: 0, bytes: 0 };
    this.state.storage.transactionSync(() => {
      sql.exec(
        "INSERT OR REPLACE INTO gateway_projection_scope(scope, head_seq, head_hash, updated_at_ms, stale, stale_reason) VALUES (?, ?, ?, ?, 0, NULL)",
        authorityScope,
        position.seq,
        position.hash,
        now
      );
      rows += 1;
      for (const marker of delta?.tool_surface_sources ?? []) {
        if (marker.key.table === "objects") {
          this.invalidateGatewayToolSurfacesForObject(marker.key.authority_scope, marker.key.key);
        }
      }
      for (const write of writes) {
        bytes += write.bytes;
        switch (write.table) {
          case "objects":
            this.invalidateGatewayToolSurfacesForObject(authorityScope, write.key);
            if (write.op === "delete") {
              sql.exec("DELETE FROM gateway_projection_object WHERE authority_scope = ? AND id = ?", authorityScope, write.key);
              sql.exec("DELETE FROM gateway_scope_member WHERE authority_scope = ? AND id = ?", authorityScope, write.key);
            } else {
              sql.exec(
                `INSERT OR REPLACE INTO gateway_projection_object(
                  id, authority_scope, body, last_apply_seq, last_apply_hash, updated_at_ms, stale, stale_reason
                ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL)`,
                write.key,
                authorityScope,
                stableShadowJson(write.row as unknown as WooValue),
                position.seq,
                position.hash,
                now
              );
              sql.exec(
                "INSERT OR REPLACE INTO gateway_scope_member(scope, id, authority_scope, role, last_apply_seq, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
                authorityScope,
                write.key,
                authorityScope,
                "projection",
                position.seq,
                now
              );
            }
            rows += 1;
            break;
          case "sessions":
            if (write.op === "delete") {
              sql.exec("DELETE FROM gateway_projection_session WHERE session_id = ?", write.key);
            } else {
              sql.exec(
                `INSERT OR REPLACE INTO gateway_projection_session(
                  session_id, scope, actor, body, last_apply_seq, last_apply_hash, updated_at_ms, stale, stale_reason
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
                write.key,
                write.row.activeScope ?? write.row.currentLocation ?? null,
                write.row.actor,
                stableShadowJson(write.row as unknown as WooValue),
                position.seq,
                position.hash,
                now
              );
            }
            rows += 1;
            break;
          case "tool_surfaces":
            if (write.op === "delete") {
              this.deleteGatewayToolSurface(write.key.scope, write.key.object);
            } else {
              this.upsertGatewayToolSurface(write.row, authorityScope, position, now);
            }
            rows += 1;
            break;
          default:
            break;
        }
      }
    });
    this.emitMetric({
      kind: "gateway_projection_cache_write",
      scope: authorityScope,
      rows,
      bytes,
      projection_bytes: bytes,
      gateway_projection_rows_written: rows,
      gateway_projection_bytes: bytes,
      source
    }, this.durableHostKey());
    return { rows, bytes };
  }

  private requireProjectionWritesComplete(
    scope: ObjRef,
    delta: ProjectionDeltaSummary | undefined,
    writes: readonly ProjectionWrite[],
    source: string
  ): void {
    if (!delta) return;
    const missing = projectionDeltaMissingWrites(delta, writes);
    if (missing.length === 0) return;
    throw wooError("E_PROJECTION_INCOMPLETE", "projection_delta upserts/deletes are missing row-body-complete projection_writes", {
      scope,
      source,
      missing
    });
  }

  private invalidateGatewayToolSurfacesForObject(authorityScope: ObjRef, object: ObjRef): void {
    const rows = sqlRows<{ scope: string; object: string }>(this.state.storage.sql.exec(
      `SELECT scope, object FROM gateway_tool_surface_source
       WHERE source_table = 'objects' AND source_authority_scope = ? AND source_key = ?`,
      authorityScope,
      object
    ));
    for (const row of rows) this.deleteGatewayToolSurface(row.scope as ObjRef, row.object as ObjRef);
  }

  private deleteGatewayToolSurface(scope: ObjRef, object: ObjRef): void {
    this.state.storage.sql.exec("DELETE FROM gateway_tool_surface WHERE scope = ? AND object = ?", scope, object);
    this.state.storage.sql.exec("DELETE FROM gateway_tool_surface_source WHERE scope = ? AND object = ?", scope, object);
    this.refreshGatewayToolSurfaceScopeSaturation(scope, Date.now());
  }

  private upsertGatewayToolSurface(row: ToolSurfaceProjectionRow, objectAuthorityScope: ObjRef, head: ShadowScopeHead, now = Date.now()): void {
    const sourceRows = coalesceToolSurfaceSourceRows(row.source_rows);
    const maxScopeRows = this.toolSurfaceSourceIndexMaxScopeRows();
    const maxShardRows = this.toolSurfaceSourceIndexMaxShardRows();
    const retainedScopeRows = firstSqlRow<{ n: number }>(this.state.storage.sql.exec(
      "SELECT COUNT(*) AS n FROM gateway_tool_surface_source WHERE scope = ? AND object <> ?",
      row.scope,
      row.object
    ))?.n ?? 0;
    const retainedShardRows = firstSqlRow<{ n: number }>(this.state.storage.sql.exec(
      "SELECT COUNT(*) AS n FROM gateway_tool_surface_source WHERE scope <> ? OR object <> ?",
      row.scope,
      row.object
    ))?.n ?? 0;
    const disabledCurrentObject = firstSqlRow<{ n: number }>(this.state.storage.sql.exec(
      "SELECT COUNT(*) AS n FROM gateway_tool_surface WHERE scope = ? AND object = ? AND stale = 1 AND stale_reason = 'disabled'",
      row.scope,
      row.object
    ))?.n ?? 0;
    const scopeCapHit = retainedScopeRows + sourceRows.length > maxScopeRows;
    const shardCapHit = retainedShardRows + sourceRows.length > maxShardRows;
    const scopeBlocked = this.gatewayToolSurfaceScopeSaturated(row.scope) && disabledCurrentObject === 0;
    const saturated = scopeBlocked || scopeCapHit || shardCapHit;
    const saturationReason = scopeBlocked || (scopeCapHit && !shardCapHit) ? "scope" : scopeCapHit && shardCapHit ? "scope_and_shard" : "shard";
    this.state.storage.sql.exec(
      `INSERT OR REPLACE INTO gateway_tool_surface(
        scope, object, object_authority_scope, body, last_apply_seq, last_apply_hash, updated_at_ms, stale, stale_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.scope,
      row.object,
      objectAuthorityScope,
      stableShadowJson({ ...row, source_rows: sourceRows } as unknown as WooValue),
      head.seq,
      head.hash,
      now,
      saturated ? 1 : 0,
      saturated ? "disabled" : null
    );
    this.state.storage.sql.exec("DELETE FROM gateway_tool_surface_source WHERE scope = ? AND object = ?", row.scope, row.object);
    if (saturated) {
      this.markGatewayToolSurfaceScopeSaturated(row.scope, saturationReason, now);
      this.emitMetric({
        kind: "gateway_tool_surface_source_rows",
        scope: row.scope,
        object: row.object,
        rows: sourceRows.length,
        scope_rows: retainedScopeRows,
        shard_rows: retainedShardRows,
        cap: maxScopeRows,
        shard_cap: maxShardRows,
        saturated: true,
        saturation_reason: saturationReason
      }, this.durableHostKey());
      return;
    }
    for (const sourceRow of sourceRows) {
      this.state.storage.sql.exec(
        `INSERT OR REPLACE INTO gateway_tool_surface_source(
          scope, source_table, source_authority_scope, source_key, object
        ) VALUES (?, ?, ?, ?, ?)`,
        row.scope,
        sourceRow.table,
        sourceRow.authority_scope,
        sourceRow.key,
        row.object
      );
    }
    this.emitMetric({
      kind: "gateway_tool_surface_source_rows",
      scope: row.scope,
      object: row.object,
      rows: sourceRows.length,
      scope_rows: retainedScopeRows + sourceRows.length,
      shard_rows: retainedShardRows + sourceRows.length,
      cap: maxScopeRows,
      shard_cap: maxShardRows,
      saturated: false
    }, this.durableHostKey());
    this.refreshGatewayToolSurfaceScopeSaturation(row.scope, now);
  }

  // Durable head_seq of the projection cache for a scope, or null if never seen.
  // Drives both the head-idempotency guard and (via the gateway's
  // durableProjectionHeadSeq hook) fanout sequencing on a relay-less cold shard.
  private gatewayProjectionHeadSeq(scope: ObjRef): number | null {
    const row = firstSqlRow<{ head_seq: number }>(this.state.storage.sql.exec(
      "SELECT head_seq FROM gateway_projection_scope WHERE scope = ?",
      scope
    ));
    return row ? row.head_seq : null;
  }

  // True only when the gateway already holds a non-stale tool-surface row for
  // this request. Used to decide whether a cache read is a COMPLETE answer for
  // a request before short-circuiting the owner refresh. A saturated scope
  // (reverse-index cap hit) is uncovered so reads refresh from the owner; an
  // empty-but-cached scope also reads as uncovered (it leaves no row) and so
  // re-verifies with the owner rather than being mistaken for "fully cached".
  private gatewayToolSurfaceRequestCovered(request: RemoteToolRequest): boolean {
    if (this.gatewayToolSurfaceScopeSaturated(request.id)) return false;
    const row = request.expandContents
      ? firstSqlRow<{ present: number }>(this.state.storage.sql.exec(
          "SELECT 1 AS present FROM gateway_tool_surface WHERE scope = ? AND stale = 0 LIMIT 1",
          request.id
        ))
      : firstSqlRow<{ present: number }>(this.state.storage.sql.exec(
          "SELECT 1 AS present FROM gateway_tool_surface WHERE scope = ? AND object = ? AND stale = 0 LIMIT 1",
          request.id,
          request.id
        ));
    return row != null;
  }

  private readGatewayToolSurfaceDescriptors(requests: readonly RemoteToolRequest[]): RemoteToolDescriptor[] {
    const out: RemoteToolDescriptor[] = [];
    const seen = new Set<string>();
    const append = (row: ToolSurfaceProjectionRow): void => {
      for (const verb of row.verbs) {
        const key = `${row.object}\u0000${verb.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          object: row.object,
          verb: verb.name,
          aliases: verb.aliases ?? [],
          arg_spec: verb.arg_spec ?? {},
          direct: verb.direct === true,
          ...(verb.reads_room_presence === true ? { reads_room_presence: true } : {}),
          source: verb.source ?? "",
          enclosingSpace: verb.enclosingSpace ?? row.scope,
          source_rows: row.source_rows
        });
      }
    };
    for (const request of requests) {
      if (this.gatewayToolSurfaceScopeSaturated(request.id)) continue;
      const rows = request.expandContents
        ? sqlRows<{ body: string }>(this.state.storage.sql.exec(
            "SELECT body FROM gateway_tool_surface WHERE scope = ? AND stale = 0 ORDER BY object",
            request.id
          ))
        : sqlRows<{ body: string }>(this.state.storage.sql.exec(
            "SELECT body FROM gateway_tool_surface WHERE scope = ? AND object = ? AND stale = 0",
            request.id,
            request.id
          ));
      for (const raw of rows) {
        const parsed = JSON.parse(raw.body) as unknown;
        if (isToolSurfaceProjectionRow(parsed)) append(parsed);
      }
    }
    return out;
  }

  private gatewayToolSurfaceScopeSaturated(scope: ObjRef): boolean {
    const row = firstSqlRow<{ saturated: number }>(this.state.storage.sql.exec(
      "SELECT saturated FROM gateway_tool_surface_scope WHERE scope = ?",
      scope
    ));
    return row?.saturated === 1;
  }

  private markGatewayToolSurfaceScopeSaturated(scope: ObjRef, reason: "scope" | "shard" | "scope_and_shard", now: number): void {
    this.state.storage.sql.exec(
      "INSERT OR IGNORE INTO gateway_tool_surface_scope(scope, saturated, saturated_reason, updated_at_ms) VALUES (?, 1, ?, ?)",
      scope,
      reason,
      now
    );
    this.state.storage.sql.exec(
      "UPDATE gateway_tool_surface_scope SET saturated = 1, saturated_reason = ?, updated_at_ms = ? WHERE scope = ?",
      reason,
      now,
      scope
    );
  }

  private refreshGatewayToolSurfaceScopeSaturation(scope: ObjRef, now: number): void {
    if (!this.gatewayToolSurfaceScopeSaturated(scope)) return;
    // Recovery requires all disabled descriptor rows to be replaced or deleted;
    // otherwise descriptor reads would see only a prefix of the active scope.
    const disabledRows = firstSqlRow<{ n: number }>(this.state.storage.sql.exec(
      "SELECT COUNT(*) AS n FROM gateway_tool_surface WHERE scope = ? AND stale = 1 AND stale_reason = 'disabled'",
      scope
    ))?.n ?? 0;
    const scopeRows = firstSqlRow<{ n: number }>(this.state.storage.sql.exec(
      "SELECT COUNT(*) AS n FROM gateway_tool_surface_source WHERE scope = ?",
      scope
    ))?.n ?? 0;
    const shardRows = firstSqlRow<{ n: number }>(this.state.storage.sql.exec(
      "SELECT COUNT(*) AS n FROM gateway_tool_surface_source"
    ))?.n ?? 0;
    if (disabledRows > 0 || scopeRows > this.toolSurfaceSourceIndexMaxScopeRows() || shardRows > this.toolSurfaceSourceIndexMaxShardRows()) return;
    this.state.storage.sql.exec(
      "UPDATE gateway_tool_surface_scope SET saturated = 0, saturated_reason = NULL, updated_at_ms = ? WHERE scope = ?",
      now,
      scope
    );
  }

  private storeGatewayToolSurfacesFromDescriptors(scope: ObjRef, authorityScope: ObjRef, descriptors: readonly RemoteToolDescriptor[]): void {
    if (descriptors.length === 0) return;
    const byObject = new Map<ObjRef, RemoteToolDescriptor[]>();
    for (const descriptor of descriptors) {
      const list = byObject.get(descriptor.object) ?? [];
      list.push(descriptor);
      byObject.set(descriptor.object, list);
    }
    const now = Date.now();
    const head: ShadowScopeHead = {
      kind: "woo.scope_head.shadow.v1",
      scope,
      epoch: 1,
      seq: 0,
      hash: ""
    };
    this.state.storage.transactionSync(() => {
      for (const [object, objectDescriptors] of byObject) {
        const sourceRows = coalesceToolSurfaceSourceRows(
          objectDescriptors.flatMap((descriptor) => descriptor.source_rows && descriptor.source_rows.length > 0
            ? descriptor.source_rows.map((row) => ({ ...row, authority_scope: authorityScope }))
            : [{ table: "objects" as const, authority_scope: authorityScope, key: object }])
        );
        this.upsertGatewayToolSurface({
          kind: "woo.tool_surface_projection.v1",
          scope,
          object,
          head,
          verbs: objectDescriptors.map((descriptor) => ({
            name: descriptor.verb,
            owner: object,
            perms: "x",
            aliases: descriptor.aliases,
            arg_spec: descriptor.arg_spec,
            direct: descriptor.direct,
            ...(descriptor.reads_room_presence === true ? { reads_room_presence: true } : {}),
            source: descriptor.source,
            enclosingSpace: descriptor.enclosingSpace
          })),
          source_rows: sourceRows
        }, authorityScope, head, now);
      }
    });
  }

  private storeGatewayToolSurfacesForRequests(requests: readonly RemoteToolRequest[], descriptors: readonly RemoteToolDescriptor[]): void {
    for (const request of requests) {
      this.storeGatewayToolSurfacesFromDescriptors(
        request.id,
        request.id,
        descriptors.filter((descriptor) => this.remoteToolDescriptorMatchesRequest(descriptor, request))
      );
    }
  }

  private remoteToolDescriptorMatchesRequest(descriptor: RemoteToolDescriptor, request: RemoteToolRequest): boolean {
    if (descriptor.object === request.id) return true;
    return request.expandContents === true && descriptor.enclosingSpace === request.id;
  }

  async fetch(request: Request): Promise<Response> {
    const handlerStartedAt = Date.now();
    let pathname = "";
    let hostKey = this.durableHostKey();
    let handlerStatus: "ok" | "error" = "ok";
    let handlerError: string | undefined;
    let handlerErrorDetail: string | undefined;
    // Per-call correlation id stamped by the sender (forwardInternalRaw).
    // We echo it in `do_handler` so a sender-side timeout can be matched to
    // the receiver's actual handler runtime without keeping the fetch alive.
    const rpcId = request.headers.get("x-woo-rpc-id") || undefined;
    // Operator-bootstrap precondition check (cloudflare.md §R14.7).
    try {
      if (!this.env.WOO_INITIAL_WIZARD_TOKEN) {
        return jsonResponse(
          { error: { code: "E_BOOTSTRAP_TOKEN_MISSING", message: "set WOO_INITIAL_WIZARD_TOKEN via wrangler secret put" } },
          503
        );
      }
      if (!this.env.WOO_INTERNAL_SECRET) {
        return jsonResponse(
          { error: { code: "E_BOOTSTRAP_TOKEN_MISSING", message: "set WOO_INTERNAL_SECRET via wrangler secret put" } },
          503
        );
      }

      const url = new URL(request.url);
      pathname = url.pathname;
      hostKey = request.headers.get("x-woo-host-key") || this.durableHostKey();
      const worldGatewayHost = hostKey === WORLD_HOST;
      const mcpGatewayShard = isMcpGatewayShardHost(hostKey);
      const gatewayHost = worldGatewayHost || mcpGatewayShard;
      const internalRequest = pathname.startsWith("/__internal/");

      if (internalRequest) await verifyInternalRequest(this.env, request);

      // §RC11.5 teardown gate. Once host_state is "tearing_down", this DO
      // refuses all inbound work with E_HOST_RECYCLED until deleteAll has
      // run. If teardown is in progress but no waitUntil is currently
      // running it (e.g. a wake from hibernation between batches), schedule
      // a resume so the sequence completes idempotently.
      if (!gatewayHost && this.getHostState() === HOST_STATE_TEARING_DOWN) {
        this.ensureTeardownScheduled(this.durableHostKey());
        return jsonResponse(
          { error: { code: "E_HOST_RECYCLED", message: "host is tearing down" } },
          410
        );
      }

      if (!worldGatewayHost && (pathname === "/api/auth" || pathname === "/v2/turn-network/ws")) {
        return jsonResponse({ error: { code: "E_NOTAPPLICABLE", message: `${pathname} is only available on the world gateway host` } }, 404);
      }

      let postHandlerWorld: WooWorld | null = null;
      try {
      // Slice 1: time getWorld (cold-init included) for the /mcp dispatch so the
      // dispatch-timing metric can separate cold-load from the dispatch steps.
      const mcpDispatchTimed = gatewayHost && pathname === "/mcp";
      const mcpWorldWasCold = mcpDispatchTimed && !this.world;
      const getWorldStartedAt = mcpDispatchTimed ? Date.now() : 0;
      const world = await this.getWorld(hostKey);
      const mcpGetWorldMs = mcpDispatchTimed ? Date.now() - getWorldStartedAt : 0;
      postHandlerWorld = world;

      if (internalRequest) {
        return await this.handleInternal(request, world, pathname, hostKey);
      }

      if (worldGatewayHost && pathname === "/v2/turn-network/ws") {
        return await this.acceptV2TurnNetworkWebSocket(request, world);
      }

      if (request.method === "GET" && pathname === "/healthz") {
        return jsonResponse({ ok: true, ts: Date.now(), objects: world.objects.size });
      }

      // MCP streamable-HTTP transport (spec/protocol/mcp.md). Only on the
      // gateway host or a gateway shard. Shards receive Directory session
      // headers from the Worker so they can resume SDK transport state without
      // becoming the canonical session store.
      if (gatewayHost && pathname === "/mcp") {
        // Slice 1 dispatch attribution: split the wrapper steps so a slow
        // DELETE teardown (or POST wrapper overhead outside submitTurnIntent)
        // is charged to forward/handle/register rather than guessed. Emitted
        // finally-style with partial timings + status so an ERROR path (the very
        // case worth diagnosing) still gets attribution instead of falling back
        // to coarse do_handler. handle/register record elapsed even on throw.
        const dispatchStartedAt = Date.now();
        let forwardMs = 0;
        let handleMs = 0;
        let registerMs = 0;
        let dispatchStatus: "ok" | "error" = "ok";
        try {
          const forwardStartedAt = Date.now();
          this.ensureForwardedMcpSession(world, request);
          forwardMs = Date.now() - forwardStartedAt;
          const gateway = this.getMcpGateway(world);
          const handleStartedAt = Date.now();
          let response: Response;
          try {
            response = await gateway.handle(request);
          } finally {
            handleMs = Date.now() - handleStartedAt;
          }
          const registerStartedAt = Date.now();
          try {
            if (request.method === "DELETE") {
              // DELETE /mcp is a session lifecycle boundary, not another
              // activity heartbeat. Registering its 204 response would
              // resurrect the Directory route we just closed and leave the
              // guest actor in room contents until TTL/reap. The gateway hook
              // below performs the durable cleanup.
            } else {
              await this.registerMcpSessionRoute(world, request, response.clone(), mcpGatewayShard ? hostKey : null);
            }
          } finally {
            registerMs = Date.now() - registerStartedAt;
          }
          return response;
        } catch (err) {
          dispatchStatus = "error";
          throw err;
        } finally {
          world.recordMetric({
            kind: "mcp_dispatch_timing",
            method: request.method,
            host: hostKey,
            cold_world: mcpWorldWasCold,
            status: dispatchStatus,
            total_ms: mcpGetWorldMs + (Date.now() - dispatchStartedAt),
            get_world_ms: mcpGetWorldMs,
            forward_ms: forwardMs,
            handle_ms: handleMs,
            register_ms: registerMs
          });
        }
      }

      if (worldGatewayHost && request.method === "POST" && pathname === "/v2/session/mint") {
        const body = await readJsonBody(request);
        const session = this.authenticateToken(world, String(body.token ?? ""));
        await this.registerSessionRoute(session, {}, world);
        return jsonResponse({
          token: shadowBrowserSessionBearer(session),
          claims: shadowBrowserSessionClaimsValue(session, "shadow-local", [session.actor])
        });
      }

      if (worldGatewayHost && request.method === "POST" && pathname === "/api/browser-metrics") {
        return await this.handleBrowserMetrics(world, request);
      }

      if (worldGatewayHost && request.method === "POST" && pathname === "/api/admin/refresh-host-seeds") {
        const session = this.requireRestSession(world, request);
        if (!world.object(session.actor).flags.wizard) throw wooError("E_PERM", "wizard authority required");
        const body = await readJsonBody(request);
        const hosts = Array.isArray(body.hosts) ? body.hosts.filter((item): item is string => typeof item === "string") : undefined;
        return jsonResponse(await this.refreshRemoteHostSeeds(world, { hosts }));
      }

      if (worldGatewayHost && request.method === "POST" && pathname === "/api/admin/force-rebuild-host") {
        // Wizard-authorized force-rebuild of a target satellite. Wipes
        // the target DO's local SQL via /__internal/force-rebuild, so
        // its next request triggers a clean cold-load from WORLD. Used
        // to recover from a stale-seed-poisoning incident where
        // refresh-host-seeds can't push the fix because the satellite's
        // seed exceeds the 1MB request body limit.
        const session = this.requireRestSession(world, request);
        if (!world.object(session.actor).flags.wizard) throw wooError("E_PERM", "wizard authority required");
        const body = await readJsonBody(request);
        const targets = Array.isArray(body.hosts) ? body.hosts.filter((item): item is string => typeof item === "string") : [];
        if (targets.length === 0) throw wooError("E_INVARG", "force-rebuild-host requires hosts: string[]");
        const results: Array<Record<string, unknown>> = [];
        for (const target of targets) {
          if (target === WORLD_HOST) {
            results.push({ host: target, ok: false, error: "cannot force-rebuild WORLD" });
            continue;
          }
          try {
            const result = await this.forwardInternalChecked<{ ok: true; host: string; ms: number }>(
              target,
              "/__internal/force-rebuild",
              {},
              { timeoutMs: 30_000 }
            );
            results.push(result);
          } catch (err) {
            results.push({ host: target, ok: false, error: normalizeError(err) });
          }
        }
        return jsonResponse({ ok: results.every((r) => r.ok !== false), results });
      }

      if (worldGatewayHost && request.method === "POST" && pathname === "/api/admin/purge-inactive-guests") {
        const session = this.requireRestSession(world, request);
        if (!world.object(session.actor).flags.wizard) throw wooError("E_PERM", "wizard authority required");
        const result = world.purgeInactiveGuests();
        for (const sessionId of result.reaped_sessions) {
          await this.unregisterSessionRoute(sessionId);
        }
        const directory_expired_sessions_removed = await this.purgeExpiredDirectorySessions();
        return jsonResponse({ ok: true, ...result, directory_expired_sessions_removed });
      }

      const protocol = await handleRestProtocolRequest(workerRestRequest(request, pathname), {
        world,
        authenticateToken: (token) => this.authenticateToken(world, token),
        requireSession: () => this.requireRestSession(world, request),
        verifyTurnstile: (token, protocolRequest) => this.verifyTurnstile(token, protocolRequest),
        onAuthenticated: (session) => this.registerSessionRoute(session, {}, world),
        onSessionEnded: (session) => {
          this.browserMetricSessionCounters.delete(session.id);
          return this.unregisterSessionRoute(session.id);
        },
        onSessionsEnded: async (sessions) => {
          for (const session of sessions) {
            this.browserMetricSessionCounters.delete(session.id);
            await this.unregisterSessionRoute(session.id);
          }
        },
        executeTurn: (input) => this.restV2Turn(world, input),
        installTap: async (actor, body) => {
          if (!worldGatewayHost) throw wooError("E_NOTAPPLICABLE", "GitHub tap install is only available on the world gateway host");
          return await installGitHubTap(world, actor, {
            tap: String(body.tap ?? ""),
            catalog: String(body.catalog ?? ""),
            ref: typeof body.ref === "string" ? body.ref : undefined,
            as: typeof body.as === "string" ? body.as : undefined
          }, {
            hashText: workerHashText,
            log: (event) => logCatalogTapEvent(event)
          });
        },
        updateTap: async (actor, body) => {
          if (!worldGatewayHost) throw wooError("E_NOTAPPLICABLE", "GitHub tap update is only available on the world gateway host");
          return await updateGitHubTap(world, actor, {
            tap: String(body.tap ?? ""),
            catalog: String(body.catalog ?? ""),
            ref: typeof body.ref === "string" ? body.ref : undefined,
            as: typeof body.as === "string" ? body.as : undefined,
            accept_major: body.accept_major === true
          }, {
            hashText: workerHashText,
            log: (event) => logCatalogTapEvent(event)
          });
        },
        resolveObject: (id, session) => this.resolveRestObject(world, id, session),
        resolveActor: (_protocolRequest, actorValue, session) => this.resolveRestActor(world, request, actorValue, session),
        broadcastApplied: (frame) => this.handleAppliedFrame(world, frame),
        broadcastLiveEvents: (result) => this.broadcastLiveEvents(world, result)
      });
      if (protocol.handled) {
        if ("raw" in protocol) {
          return jsonResponse({ error: { code: "E_NOT_IMPLEMENTED", message: "raw REST response not supported on CF Worker" } }, 501);
        }
        return jsonResponse(protocol.body, protocol.status, protocol.headers);
      }

      return jsonResponse({ error: { code: "E_OBJNF", message: `no route for ${request.method} ${pathname}` } }, 404);
    } catch (err) {
      const error = normalizeError(err);
      const fields = metricErrorFields(err);
      handlerStatus = "error";
      handlerError = fields.error;
      handlerErrorDetail = fields.error_detail;
      return jsonResponse({ error }, statusForError(error));
    } finally {
      if (!gatewayHost && postHandlerWorld) {
        this.maybeStartTeardown(postHandlerWorld, this.durableHostKey());
      }
    }
    } catch (err) {
      handlerStatus = "error";
      const fields = metricErrorFields(err);
      handlerError = fields.error;
      handlerErrorDetail = fields.error_detail;
      throw err;
    } finally {
      this.emitMetric({
        kind: "do_handler",
        class: "PersistentObjectDO",
        method: request.method,
        route: pathname || "_pre_route",
        ms: Date.now() - handlerStartedAt,
        status: handlerStatus,
        ...(rpcId ? { rpc_id: rpcId } : {}),
        ...(handlerError ? { error: handlerError } : {}),
        ...(handlerErrorDetail ? { error_detail: handlerErrorDetail } : {})
      }, hostKey);
    }
  }

  // ---- world lifecycle ----

  /**
   * Lazy-init the in-memory WooWorld. The gateway host runs normal bootstrap
   * and catalog auto-install; cluster hosts load/prune a host-scoped serialized
   * world and write that slice through the same repository path.
   *
   * The init is wrapped in blockConcurrencyWhile to ensure no fetch handler
   * interleaves with the bootstrap; once init completes, the same `world`
   * instance handles all subsequent requests until DO hibernation.
   */
  private durableHostKey(): string {
    return this.state.id.name ?? WORLD_HOST;
  }

  // ---- §RC11 host teardown ----

  /** Read the persisted host_state, cached for the DO lifetime (resets on
   * eviction). Returns "live" by default; "tearing_down" once §RC11 has
   * begun. The first call reads from the repo; subsequent calls return
   * the cached value until setHostStateTearingDown overwrites it. */
  private getHostState(): string {
    if (this.cachedTeardownState !== null) return this.cachedTeardownState;
    let value: string | null = null;
    try {
      value = this.repo.loadMeta(HOST_STATE_META_KEY);
    } catch {
      value = null;
    }
    this.cachedTeardownState = value === HOST_STATE_TEARING_DOWN ? HOST_STATE_TEARING_DOWN : "live";
    return this.cachedTeardownState;
  }

  private setHostStateTearingDown(): void {
    this.repo.saveMeta(HOST_STATE_META_KEY, HOST_STATE_TEARING_DOWN);
    this.cachedTeardownState = HOST_STATE_TEARING_DOWN;
  }

  /** Post-handler trigger evaluation per spec/semantics/recycle.md §RC11.1.
   *
   * v1 detection: if this DO's self-hosted root is gone (recycled), the host
   * is empty of payload — pre-flight A3 forces co-resident objects to recycle
   * first. The trigger evaluates `world.tombstones.has(rootId) &&
   * !world.objects.has(rootId)`. Future revisions may need a deeper
   * livePayloadCount that excludes host-scoped support copies row-by-row;
   * that's not required while the trigger fires only on root recycle. */
  private maybeStartTeardown(world: WooWorld, hostKey: string): void {
    if (hostKey === WORLD_HOST) return;
    if (this.cachedTeardownState === HOST_STATE_TEARING_DOWN) return;
    if (!world.tombstones.has(hostKey as ObjRef)) return;
    if (world.objects.has(hostKey as ObjRef)) return;

    try {
      this.setHostStateTearingDown();
    } catch (err) {
      console.warn("woo.host_teardown.mark_failed", { host: hostKey, error: normalizeError(err) });
      return;
    }
    this.ensureTeardownScheduled(hostKey);
  }

  /** Idempotently schedule the teardown sequence. Multiple fetches that
   * observe `tearing_down` only ever start one waitUntil promise. */
  private ensureTeardownScheduled(hostKey: string): void {
    if (this.teardownScheduled) return;
    this.teardownScheduled = true;
    const promise = this.runTeardownSequence(hostKey).catch((err) => {
      console.warn("woo.host_teardown.failed", { host: hostKey, error: normalizeError(err) });
      // Leave teardownScheduled=true so we don't loop on a permanently
      // failing batch; the next DO wake re-evaluates and can retry.
    });
    if (typeof this.state.waitUntil === "function") {
      this.state.waitUntil(promise);
    }
  }

  /** Per spec/semantics/recycle.md §RC11.3 steps 2–4. */
  private async runTeardownSequence(hostKey: string): Promise<void> {
    const startedAt = Date.now();
    let tombstones: TombstoneRecord[] = [];
    try {
      tombstones = this.repo.loadTombstoneRecords();
    } catch {
      tombstones = [];
    }

    // Step 2: hand the roster to Directory in batches.
    const batches = chunkTombstones(tombstones, INHERIT_TOMBSTONES_BATCH_SIZE);
    for (let i = 0; i < batches.length; i++) {
      const final = i === batches.length - 1;
      await this.postInheritTombstones(hostKey, i, final, batches[i]);
    }

    // Step 3: cancel alarms (best-effort; deleteAll also clears them at
    // the current compatibility date — see spec/semantics/recycle.md
    // §RC11.3 step 3).
    try {
      await this.state.storage.deleteAlarm?.();
    } catch {
      // best-effort
    }

    // Step 4: wipe storage.
    try {
      await this.state.storage.deleteAll();
    } catch (err) {
      console.warn("woo.host_teardown.deleteAll_failed", { host: hostKey, error: normalizeError(err) });
      throw err;
    }

    this.emitMetric({
      kind: "startup_storage", phase: "directory_inherit_tombstones",
      ms: Date.now() - startedAt, status: "ok",
      count: tombstones.length, batch_seq: batches.length - 1, final: true
    }, hostKey);
  }

  /** Cold-load guard per spec/semantics/recycle.md §RC11.6. Called on a DO
   * with empty storage before any cold-load seed runs. RPCs Directory's
   * `lookup-inherited-tombstone` for our own id; if hit, throws
   * E_HOST_RECYCLED and the caller refuses to bootstrap. The Directory
   * RPC is the same one used to answer `is_recycled()` queries, so this
   * adds at most one Directory round-trip to a cold start that already
   * RPCs the gateway for a host seed. */
  private async guardColdLoadAgainstInheritedTombstone(hostKey: string): Promise<void> {
    if (hostKey === WORLD_HOST) return;
    let body: Record<string, unknown> | null = null;
    try {
      const directoryId = this.env.DIRECTORY.idFromName(DIRECTORY_HOST);
      const request = await signInternalRequest(this.env, new Request(
        `${INTERNAL_ORIGIN}/__internal/lookup-inherited-tombstone`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-woo-host-key": hostKey
          },
          body: JSON.stringify({ id: hostKey })
        }
      ));
      const response = await this.env.DIRECTORY.get(directoryId).fetch(request);
      if (!response.ok) return; // lenient: Directory unreachable → proceed
      body = await response.json() as Record<string, unknown>;
    } catch (err) {
      // Lenient on transport failure; logged for observability. The cost
      // of a false-negative cold-load (re-creating a DO under a torn-down
      // id) is bounded — the next request that reaches Directory will
      // trip the gate, the DO writes host_state=tearing_down, and reruns
      // §RC11.3 (idempotent on the empty roster).
      console.warn("woo.host_teardown.cold_load_guard_failed", { host: hostKey, error: normalizeError(err) });
      return;
    }
    if (body && body.tombstoned === true) {
      throw wooError(
        "E_HOST_RECYCLED",
        `host ${hostKey} was recycled; refusing cold-load`,
        hostKey
      );
    }
  }

  private async postInheritTombstones(
    hostKey: string,
    batchSeq: number,
    final: boolean,
    tombstones: TombstoneRecord[]
  ): Promise<void> {
    const directoryId = this.env.DIRECTORY.idFromName(DIRECTORY_HOST);
    const request = await signInternalRequest(this.env, new Request(
      `${INTERNAL_ORIGIN}/__internal/inherit-tombstones`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-woo-host-key": hostKey
        },
        body: JSON.stringify({
          host: hostKey,
          batch_seq: batchSeq,
          final,
          tombstones
        })
      }
    ));
    const response = await this.env.DIRECTORY.get(directoryId).fetch(request);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`directory inherit-tombstones batch ${batchSeq} failed (${response.status}): ${text}`);
    }
  }

  private getMcpGateway(world: WooWorld): McpGateway {
    if (!this.mcpGateway) {
      const initStart = Date.now();
      this.mcpGateway = new McpGateway(world, {
        serverName: "woo",
        v2: {
          open: async (scope, body): Promise<McpV2OpenResult> => {
            world.touchSessionInput(body.session);
            return await this.v2CommitScopePost<CommitScopeOpenResponse>(scope, "/v2/open", body as unknown as Record<string, unknown>);
          },
          envelope: async (scope, body): Promise<McpV2EnvelopeResult> => {
            world.touchSessionInput(body.session);
            const result = await this.v2CommitScopePost<CommitScopeEnvelopeResponse>(scope, "/v2/envelope", body as unknown as Record<string, unknown>);
            const delivery = await this.deliverV2Fanout(world, scope, result, body.session, body.node, { localMcpLiveHandled: true });
            this.applyGatewayProjectionCacheFromReply(result.reply, "mcp");
            return {
              ...result,
              local_host_materialized: delivery.localHostMaterialized,
              ...(delivery.mcpAudience ? { accepted_audience: delivery.mcpAudience } : {})
            };
          },
          // tolerateRemoteFailures: this is the per-envelope refresh callback
          // for an already-opened MCP session; the CommitScopeDO has a durable
          // snapshot, so omitting a cold satellite's slice falls through to
          // existing cells. The first-open seeding path does NOT pass this
          // flag — see comment on v2GatewayAuthorityPayload.
          authorityPayload: async (extraObjectIds, authorityOptions) =>
            await this.v2GatewayAuthorityPayload(world, extraObjectIds, {
              tolerateRemoteFailures: true,
              useCommitScopeSnapshotForRemoteAuthority:
                authorityOptions?.useCommitScopeSnapshotForRemoteAuthority === true &&
                !isMcpGatewayShardHost(this.durableHostKey()),
              directorySessionScopes: authorityOptions?.directorySessionScopes,
              scopeContentExpansionRoots: authorityOptions?.scopeContentExpansionRoots,
              reconstructionReason: authorityOptions?.reconstructionReason,
              reconstructionScope: authorityOptions?.reconstructionScope
            }),
          executionCapsuleOpen: envFlag(this.env.WOO_V2_EXECUTION_CAPSULE)
        },
        toolManifests: {
          staleFallback: true,
          loadSessionManifest: (sessionId) => this.loadGatewaySessionToolManifest(sessionId),
          saveSessionManifest: (manifest) => this.saveGatewaySessionToolManifest(manifest)
        },
        // Persist accepted fanout into the durable SQL projection cache in
        // contiguous sequence order, as the gateway accepts/drains each frame.
        persistAcceptedProjection: (commit) =>
          this.applyGatewayProjectionWrites(commit.position, commit.projection_writes ?? [], "fanout", commit.projection_delta),
        // Fanout-sequencing fallback for a cold shard with no in-memory relay:
        // sequence against the durable projection-cache head so frames drain in
        // order instead of applying (and persisting) in arrival order.
        durableProjectionHeadSeq: (scope) => this.gatewayProjectionHeadSeq(scope),
        onSessionClosed: (sessionId) => this.closeMcpWooSession(world, sessionId, this.durableHostKey()),
        broadcasts: {}
      });
      // On cold-load (DO rehydrate after hibernation), McpHost.queues is empty.
      // The runtime relies on bindSession to populate it, which only happens
      // when a client sends a fresh /mcp request that goes through gateway
      // session resume. Until that happens, peer-shard fanout to this shard
      // for the actor's session is dropped (queues_scanned=0 in the
      // mcp_observation_routed metric — see commit 9316122). Rebind every
      // persisted session in world.sessions. Sparse shard worlds are already
      // filtered by Directory's mcp_shard row, so re-hashing here would make a
      // shard-count change or stale row silently drop queues after cold-load.
      // The queue starts empty; observations land in it immediately; the next
      // woo_wait drain returns them.
      const localShard = this.durableHostKey();
      let rebound = 0;
      const reboundStart = Date.now();
      for (const session of world.sessions.values()) {
        if (isMcpGatewayShardHost(localShard) || mcpGatewayShardHost(this.env, session.id) === localShard) {
          this.mcpGateway.host.bindSession(session.id, session.actor);
          rebound += 1;
        }
      }
      world.recordMetric({ kind: "mcp_gateway_rebind", host_key: localShard, sessions_rebound: rebound, ms: Date.now() - reboundStart });
      world.recordMetric({ kind: "init", phase: "mcp_gateway", ms: Date.now() - initStart });
    }
    return this.mcpGateway;
  }

  private async handleBrowserMetrics(world: WooWorld, request: Request): Promise<Response> {
    const session = this.requireRestSession(world, request);
    const body = await readJsonBody(request);
    const rawMetrics = Array.isArray(body.metrics) ? body.metrics : [];
    let accepted = 0;
    let sampled = Math.max(0, rawMetrics.length - MAX_BROWSER_METRICS_BATCH);
    for (const raw of rawMetrics.slice(0, MAX_BROWSER_METRICS_BATCH)) {
      const event = browserActivityMetricFromPayload(raw, session);
      if (!event) continue;
      if (!this.acceptBrowserMetricForSession(session.id)) {
        sampled += 1;
        continue;
      }
      this.emitMetric(event, "browser");
      accepted += 1;
    }
    return jsonResponse({ ok: true, accepted, sampled });
  }

  private async verifyTurnstile(token: string, request: RestProtocolRequest): Promise<boolean> {
    const secret = this.env.TURNSTILE_SECRET_KEY;
    if (!secret) throw wooError("E_PERM", "TURNSTILE_SECRET_KEY is required for signup");
    const body = new FormData();
    body.set("secret", secret);
    body.set("response", token);
    const remoteIp = request.header("cf-connecting-ip") ?? request.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (remoteIp) body.set("remoteip", remoteIp);
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body
    });
    if (!response.ok) return false;
    const parsed = await response.json().catch(() => null);
    return !!(parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as { success?: unknown }).success === true);
  }

  private currentLocalCatalogBundleFingerprint(): string {
    return `${localCatalogBundleFingerprint(parseAutoInstallCatalogs(this.env.WOO_AUTO_INSTALL_CATALOGS))}:${LOCAL_CATALOG_BUNDLE_REPAIR_EPOCH}`;
  }

  private async ensureLoadedWorldCatalogBundle(world: WooWorld, hostKey: string): Promise<void> {
    const fingerprint = this.currentLocalCatalogBundleFingerprint();
    if (this.repo.loadMeta(LOCAL_CATALOG_BUNDLE_FINGERPRINT_META_KEY) === fingerprint) return;
    if (hostKey === WORLD_HOST) {
      installLocalCatalogs(world, parseAutoInstallCatalogs(this.env.WOO_AUTO_INSTALL_CATALOGS));
    } else if (!isMcpGatewayShardHost(hostKey)) {
      // Hot DO instances can retain an already-loaded host slice across a
      // Worker deploy. Pull the gateway seed once per catalog bundle so
      // foreign-hosted support rows keep gateway-authoritative repairs while
      // bundled verb-source changes reach resident worlds before stale
      // bytecode handles the next request. This intentionally bypasses KV:
      // a stale resident gateway could have written a bytecode-free seed under
      // the same catalog fingerprint before this repair code was deployed.
      const current = world.exportWorld();
      try {
        const fetched = await this.fetchHostSeed(hostKey as ObjRef, current, { preferKv: false });
        if (fetched.seed.objects.length > 0) {
          let changed = false;
          const merged = mergeHostScopedSeedWithStatus(current, fetched.seed, hostKey as ObjRef);
          if (merged.changed) {
            this.logHostSeedMergeDiff(hostKey as ObjRef, "catalog_bundle_repair", current, fetched.seed, merged.reasons);
            world.importWorld(merged.world);
            this.crossHostPropCache.clear();
            changed = true;
          }
          // Fresh seeds are already gateway-authoritative for foreign support
          // rows, and the host lifecycle runs in covered mode below. Re-merging
          // the same seed after lifecycle would export and scan the whole slice
          // again on every hot deploy repair without adding authority.
          runHostScopedLocalCatalogLifecycle(world, hostKey, { freshSeed: true });
          if (changed) world.persistFullSnapshot();
          if (fetched.digest) this.repo.saveMeta(HOST_SEED_DIGEST_META_KEY, fetched.digest);
        } else {
          runHostScopedLocalCatalogLifecycle(world, hostKey);
        }
      } catch (err) {
        console.warn("woo.local_catalog_bundle_repair_failed", { host: hostKey, error: normalizeError(err) });
        runHostScopedLocalCatalogLifecycle(world, hostKey);
      }
    }
    this.repo.saveMeta(LOCAL_CATALOG_BUNDLE_FINGERPRINT_META_KEY, fingerprint);
  }

  private async getWorld(hostKey = this.durableHostKey()): Promise<WooWorld> {
    if (this.world) {
      await this.ensureLoadedWorldCatalogBundle(this.world, hostKey);
      if (hostKey === WORLD_HOST) await this.registerObjectRoutes(this.world);
      return this.world;
    }
    let initialized: WooWorld | null = null;
    let coldInitStart: number | null = null;
    await this.state.blockConcurrencyWhile(async () => {
      if (this.world) {
        initialized = this.world;
        return;
      }
      coldInitStart = Date.now();
      const metricsHook = (event: MetricEvent) => this.emitMetric(event, hostKey);
      const world = hostKey === WORLD_HOST
        ? createWorld({ repository: this.repo, catalogs: parseAutoInstallCatalogs(this.env.WOO_AUTO_INSTALL_CATALOGS), metricsHook })
        : isMcpGatewayShardHost(hostKey)
          ? await this.createMcpGatewayShardWorld(hostKey, metricsHook)
        : await this.createHostScopedWorld(hostKey as ObjRef, metricsHook);
      this.installExecutorContext(world, hostKey);
      // Rehydrate live WebSocket attachments. After DO wake-from-hibernation,
      // state.getWebSockets() returns sockets whose serializeAttachment
      // payload survived hibernation; the in-memory world.sessions, however,
      // is freshly hydrated from storage with empty attachedSockets sets
      // (hydrateSession in world.ts:1256). Re-attach each surviving socket
      // so presence-filtered broadcasts reach those clients again and the
      // session reap path doesn't expire actively-connected sessions.
        this.socketsByActor.clear();
        this.socketsBySession.clear();
      for (const ws of this.state.getWebSockets()) {
        const att = this.attachment(ws);
        if (att && world.sessions?.has(att.sessionId)) {
          world.attachSocket(att.sessionId, att.socketId);
            this.indexAddSocket(att.sessionId, att.actor, ws);
        }
      }
      this.world = world;
      initialized = world;
    });
    const world = initialized!;
    if (coldInitStart !== null) {
      world.recordMetric({ kind: "init", phase: "world", ms: Date.now() - coldInitStart });
    }
    if (hostKey === WORLD_HOST) {
      await this.registerObjectRoutes(world);
    } else if (isMcpGatewayShardHost(hostKey)) {
      // MCP shard worlds are deliberately stubbed from Directory session rows.
      // Do not publish or cache routes from those stubs; object ownership is
      // resolved lazily through Directory/owner hosts when tools or turns need
      // real authority.
    } else {
      // Satellite cold-load: prime `routeCache` from the local slice so
      // `resolveObjectHostForWorld` can answer locally without firing a
      // resolve-object RPC. Do NOT touch `publishedRoutes` — that map
      // means "this DO has successfully published this route to the
      // Directory." Marking entries published-without-publishing means
      // any later call that goes through registerRoutes() (which skips
      // anything in publishedRoutes per the dedup filter) cannot repair
      // a missing or stale Directory entry. We rely on the gateway
      // having registered satellite routes during its own cold-load and
      // catalog install, but if that contract ever drifts, the
      // satellite still has a path to repair via adoptLocalObjectRoute.
      for (const route of world.objectRoutes()) {
        this.routeCache.set(route.id, route.host);
      }
    }
    return world;
  }

  private async createMcpGatewayShardWorld(hostKey: string, metricsHook: (event: MetricEvent) => void): Promise<WooWorld> {
    // MCP shards are transport/session routers, not world owners. Their cold
    // state is the Directory's live session rows for this shard; object
    // authority is fetched lazily through v2GatewayAuthorityPayload when a turn
    // actually needs it. Loading a full gateway SerializedWorld here was the
    // A3 cold-start cliff: every established MCP request imported all objects
    // just to rebind queues.
    const startedAt = Date.now();
    const sessions = await this.loadMcpGatewayShardSessions(hostKey);
    const snapshot = mcpGatewayShardSerializedWorld(sessions);
    this.emitMetric({
      kind: "startup_storage",
      phase: "mcp_gateway_snapshot_fetch",
      ms: Date.now() - startedAt,
      status: "ok",
      objects: snapshot.objects.length,
      sessions: snapshot.sessions.length,
      source: "directory"
    }, hostKey);
    return createWorldFromSerialized(snapshot, { repository: this.repo, metricsHook, persist: false });
  }

  private async loadMcpGatewayShardSessions(hostKey: string): Promise<DirectorySerializedSession[]> {
    if (!isMcpGatewayShardHost(hostKey)) return [];
    const id = this.env.DIRECTORY.idFromName(DIRECTORY_HOST);
    const sessions: DirectorySerializedSession[] = [];
    let afterSessionId = "";
    for (let page = 0; page < 256; page += 1) {
      const directoryRequest = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}/mcp-sessions-for-shard`, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({ shard: hostKey, after_session_id: afterSessionId })
      }));
      const response = await this.env.DIRECTORY.get(id).fetch(directoryRequest);
      const body = await response.json().catch(() => null) as { sessions?: unknown; next_after_session_id?: unknown } | null;
      if (!response.ok || !body || !Array.isArray(body.sessions)) {
        throw wooError("E_STORAGE", `failed to load MCP gateway shard sessions for ${hostKey}`, body as WooValue);
      }
      sessions.push(...body.sessions.map(serializedSessionFromDirectoryRoute).filter((session): session is DirectorySerializedSession => session !== null));
      const next = typeof body.next_after_session_id === "string" ? body.next_after_session_id : "";
      if (!next) return sessions;
      afterSessionId = next;
    }
    throw wooError("E_STORAGE", `too many MCP gateway shard session pages for ${hostKey}`, hostKey);
  }

  private async loadDirectorySessionsForScopes(scopes: readonly ObjRef[]): Promise<DirectorySerializedSession[]> {
    const requested = Array.from(new Set(scopes.filter((scope) => typeof scope === "string" && scope.length > 0))).sort();
    if (requested.length === 0) return [];
    const cacheKey = requested.join("\n");
    const now = Date.now();
    const cached = this.directoryScopeSessionsCache.get(cacheKey);
    if (cached?.promise) return cloneDirectorySerializedSessions(await cached.promise);
    if (cached?.value && cached.expiresAt > now) return cloneDirectorySerializedSessions(cached.value);

    const startedAt = Date.now();
    let failed = false;
    const promise = this.fetchDirectorySessionsForScopes(requested).catch((err) => {
      failed = true;
      const error = normalizeError(err);
      this.world?.recordMetric({
        kind: "directory_sessions_for_scopes",
        scopes: requested.length,
        sessions: 0,
        ms: Date.now() - startedAt,
        status: error.code === "E_TIMEOUT" ? "timeout" : "error",
        error: error.code
      });
      return [];
    });
    this.directoryScopeSessionsCache.set(cacheKey, { expiresAt: now + DIRECTORY_SCOPE_SESSIONS_TTL_MS, promise });
    this.trimDirectoryScopeSessionsCache();
    const sessions = await promise;
    this.directoryScopeSessionsCache.set(cacheKey, {
      expiresAt: Date.now() + DIRECTORY_SCOPE_SESSIONS_TTL_MS,
      value: cloneDirectorySerializedSessions(sessions)
    });
    this.trimDirectoryScopeSessionsCache();
    if (!failed) {
      this.world?.recordMetric({
        kind: "directory_sessions_for_scopes",
        scopes: requested.length,
        sessions: sessions.length,
        ms: Date.now() - startedAt,
        status: "ok"
      });
    }
    return cloneDirectorySerializedSessions(sessions);
  }

  private async fetchDirectorySessionsForScopes(requested: readonly ObjRef[]): Promise<DirectorySerializedSession[]> {
    const id = this.env.DIRECTORY.idFromName(DIRECTORY_HOST);
    const sessions: DirectorySerializedSession[] = [];
    let afterSessionId = "";
    for (let page = 0; page < 256; page += 1) {
      const controller = new AbortController();
      const timeoutMs = this.hostReadRpcTimeoutMs();
      const timeout = setTimeout(() => {
        controller.abort(wooError("E_TIMEOUT", "Directory sessions-for-scopes timed out", { timeout_ms: timeoutMs, scopes: requested.length }));
      }, timeoutMs);
      try {
        const signedRequest = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}/sessions-for-scopes`, {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({ scopes: requested, after_session_id: afterSessionId })
        }));
        const directoryRequest = new Request(signedRequest, { signal: controller.signal });
        const response = await raceAgainstAbort(this.env.DIRECTORY.get(id).fetch(directoryRequest), controller.signal);
        const body = await response.json().catch(() => null) as { sessions?: unknown; next_after_session_id?: unknown } | null;
        if (!response.ok || !body || !Array.isArray(body.sessions)) {
          throw wooError("E_STORAGE", "Directory sessions-for-scopes failed", { status: response.status });
        }
        sessions.push(...body.sessions.map(serializedSessionFromDirectoryRoute).filter((session): session is DirectorySerializedSession => session !== null));
        const next = typeof body.next_after_session_id === "string" ? body.next_after_session_id : "";
        if (!next) return sessions;
        afterSessionId = next;
      } finally {
        clearTimeout(timeout);
      }
    }
    return sessions;
  }

  private trimDirectoryScopeSessionsCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.directoryScopeSessionsCache) {
      if (entry.expiresAt <= now) this.directoryScopeSessionsCache.delete(key);
    }
    while (this.directoryScopeSessionsCache.size > DIRECTORY_SCOPE_SESSIONS_CACHE_MAX) {
      const oldest = this.directoryScopeSessionsCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.directoryScopeSessionsCache.delete(oldest);
    }
  }

  private async createHostScopedWorld(hostKey: ObjRef, metricsHook: (event: MetricEvent) => void): Promise<WooWorld> {
    const stored = this.repo.load();
    // §RC11.6 cold-load guard. If storage is empty (a fresh DO or a stale
    // stub reactivating an empty post-deleteAll instance), check Directory
    // before running any cold-load seed: if our id is recorded as a
    // former_host in inherited_tombstone, refuse and write nothing.
    if (!stored) {
      await this.guardColdLoadAgainstInheritedTombstone(hostKey);
    }
    // Trust the on-disk slice when it carries the post-migration host
    // marker (the host's own object has host_placement="self"). Re-scoping
    // via nonEmptyHostScopedWorld imports-then-re-exports through the
    // satellite's local hostScope(), which reaches catalog-supplied class
    // objects via addCatalogSupportFor — and that helper depends on
    // installed_catalogs, a per-host dynamic property the gateway never
    // propagates. Result: the gateway's seed contains class objects (e.g.
    // $cockatoo, $horoscope_note) that the satellite can't reach in its
    // own scope walk, so every cold-load merge re-added them and the next
    // load dropped them again. We only re-scope when stored predates the
    // 2026-04-30 catalog-placement migration (no host_placement marker on
    // any object in the slice) — that's the original recovery path.
    let scoped: SerializedWorld | null;
    let trustedStoredHostScoped = false;
    if (stored && storedSliceIsHostScoped(stored, hostKey)) {
      scoped = stored;
      trustedStoredHostScoped = true;
    } else {
      scoped = stored ? nonEmptyHostScopedWorld(stored, hostKey) : null;
      if (stored && !scoped) {
        console.warn("woo.cluster_seed_fallback", {
          host: hostKey,
          reason: "stored_world_missing_host_slice",
          stored_objects: stored.objects.length,
          stored_logs: stored.logs.length,
          stored_tasks: stored.parkedTasks.length
        });
      }
    }
    // The content-addressed KV pointer doubles as a cheap freshness probe. If
    // this DO already persisted a host-scoped slice merged from that exact seed
    // digest, the next cold-load can skip the seed body restore and both seed
    // merges. We still run host-owned data migrations below, but mark the seed
    // as covering foreign support rows so schema repair does not rewrite rows
    // the gateway seed already owns.
    let freshSeed: SeedWorld | null = null;
    let freshSeedDigest: string | null = null;
    let seedDigestHit = false;
    try {
      const storedSeedDigest = this.repo.loadMeta(HOST_SEED_DIGEST_META_KEY);
      if (this.env.HOST_SEED_KV && trustedStoredHostScoped && scoped && storedSeedDigest) {
        const probeStartedAt = Date.now();
        try {
          const pointer = await this.env.HOST_SEED_KV.get(hostSeedPointerKey(this.env, hostKey), "text");
          if (pointer && pointer === storedSeedDigest) {
            freshSeedDigest = pointer;
            seedDigestHit = true;
            this.emitMetric({
              kind: "startup_storage",
              phase: "host_seed_fetch",
              ms: Date.now() - probeStartedAt,
              status: "ok",
              objects: scoped.objects.length,
              source: "digest_hit"
            }, hostKey);
          }
        } catch {
          // A probe failure must not strand a satellite on its local slice; the
          // normal fetch path below has the full KV-miss/DO-fallback behavior.
        }
      }
      if (!seedDigestHit) {
        // Use the gateway's seed verbatim — re-scoping via
        // nonEmptyHostScopedWorld would import-then-re-export, which
        // recomputes objectHosts from the fresh world's anchor chain
        // and discards any gateway-supplied routing metadata (per
        // spec/protocol/host-seeds.md §HS1, objectHosts is the only
        // routing input the merge needs and must come from the
        // gateway's batched directory view).
        const fetched = await this.fetchHostSeed(hostKey, scoped);
        freshSeed = fetched.seed.objects.length > 0 ? fetched.seed : null;
        freshSeedDigest = fetched.digest;
      }
    } catch (err) {
      if (!scoped) throw err;
      console.warn("woo.cluster_seed_refresh_failed", { host: hostKey, error: normalizeError(err) });
    }
    let seedMergeChanged = false;
    if (scoped && freshSeed) {
      const merged = mergeHostScopedSeedWithStatus(scoped, freshSeed, hostKey);
      if (merged.changed) {
        this.logHostSeedMergeDiff(hostKey, "load", scoped, freshSeed, merged.reasons);
      }
      scoped = merged.world;
      seedMergeChanged = merged.changed;
    }
    if (!scoped) scoped = freshSeed;
    if (!scoped) throw wooError("E_OBJNF", `no host-scoped seed for ${hostKey}`, hostKey);
    const world = createWorldFromSerialized(scoped, { repository: this.repo, metricsHook, persist: stored === null });
    // A successful seed fetch is the gateway-authoritative schema repair for
    // foreign-hosted catalog support rows. Running host schema repair on those
    // rows after the merge would re-add local-only catalog fields. The
    // fresh-seed lifecycle mode records the gateway-covered plan instead, so a
    // second post-lifecycle export/merge/import is duplicate full-slice work.
    // Host-owned data migrations still run below and persist incrementally.
    runHostScopedLocalCatalogLifecycle(world, hostKey, { freshSeed: freshSeed !== null || seedDigestHit });
    // With content-addressed KV keys (Lever B), a successful KV read
    // returns bytes whose digest matches the requested pointer — the
    // bytes are self-consistent and either current or a frozen past
    // version. Persisting them to local SQL is safe: stale-but-
    // consistent state is exactly what the next apply-v2-commit
    // fanout corrects, and the cold-load no longer pays the merge
    // cost on every wake. The v1 KV poisoning required a non-
    // content-addressed key (deploy N+1 read deploy N's bytes under
    // the same key); Lever B's bytes:${host}:${digest} key shape
    // means a deploy that changes verb shape produces a new digest
    // and a new key, so old bytes are unreachable through the
    // pointer.
    if (seedMergeChanged) world.persistFullSnapshot();
    if (freshSeedDigest && freshSeed) {
      this.repo.saveMeta(HOST_SEED_DIGEST_META_KEY, freshSeedDigest);
    }
    this.scrubStaleSubscribersOnce(world);
    return world;
  }

  // One-shot wipe of accumulated subscriber lists on cluster $space objects
  // that rely on explicit enter/leave (i.e. not auto_presence). Stale entries
  // built up before cross-host session-reap cleanup landed; live clients
  // re-enter on next focus. Gated per-space so it only runs once per object
  // across reboots.
  private scrubStaleSubscribersOnce(world: WooWorld): void {
    for (const id of Array.from(world.objects.keys())) {
      const nextSeq = world.propOrNull(id, "next_seq");
      if (typeof nextSeq !== "number") continue;
      if (world.propOrNull(id, "auto_presence") === true) continue;
      if (world.propOrNull(id, "_subscribers_scrubbed_v1") === true) continue;
      const subscribers = world.propOrNull(id, "subscribers");
      if (Array.isArray(subscribers) && subscribers.length > 0) {
        try { world.setProp(id, "subscribers", []); } catch { continue; }
      }
      try { world.setProp(id, "_subscribers_scrubbed_v1", true); } catch { /* read-only */ }
    }
  }

  // Diagnostic for host seed write-treadmills: when a seed merge declares
  // `changed: true` we re-do a manual diff and log the first few (object,
  // field) pairs so we can identify which class/instance is drifting between
  // gateway state and the satellite's slice.
  private logHostSeedMergeDiff(
    hostKey: ObjRef,
    phase: "load" | "post_lifecycle" | "catalog_bundle_repair" | "catalog_bundle_repair_post_lifecycle",
    storedWorld: SerializedWorld,
    seedWorld: SerializedWorld,
    reasons: Array<{ id: ObjRef; reasons: string[] }> | undefined
  ): void {
    // Mirror the merge's DYNAMIC_HOST_SEED_PROPERTIES so the diagnostic
    // reports the same set of property names the merge ignores. Any name
    // here is receiver-authoritative on a satellite's local copy of a
    // foreign-hosted object — drift on these is by design.
    const DYNAMIC = new Set([
      "next_seq", "subscribers", "operators", "last_snapshot_seq", "focus_list",
      "bootstrap_token_used", "wizard_actions", "applied_migrations",
      "catalog_migration_records", "installed_catalogs",
      "_subscribers_scrubbed_v1"
    ]);
    const stored = new Map(storedWorld.objects.map((o) => [o.id, o]));
    // Only fields the merge actually compares (HS2.2). children/contents
    // are derived from parent/location pointers; modified is a local clock;
    // they don't drive changed=true and were creating diagnostic noise that
    // pushed real drivers past the MAX cap.
    const fields = ["verbs", "propertyDefs", "propertyVersions", "properties", "flags", "eventSchemas", "name", "parent", "owner", "anchor"] as const;
    const diffs: Array<{ id: string; field: string; detail?: string }> = [];
    const MAX = 12;
    for (const seedObj of seedWorld.objects) {
      const cur = stored.get(seedObj.id);
      if (!cur) {
        if (diffs.length < MAX) diffs.push({ id: seedObj.id, field: "<missing-in-stored>" });
        continue;
      }
      for (const f of fields) {
        if (diffs.length >= MAX) break;
        const a = (cur as unknown as Record<string, unknown>)[f];
        const b = (seedObj as unknown as Record<string, unknown>)[f];
        if (JSON.stringify(a) === JSON.stringify(b)) continue;
        if (f === "properties" || f === "propertyVersions") {
          const aMap = new Map((a as Array<[string, unknown]>) ?? []);
          const bMap = new Map((b as Array<[string, unknown]>) ?? []);
          const names = new Set<string>([...aMap.keys(), ...bMap.keys()]);
          let recorded = false;
          for (const n of names) {
            if (DYNAMIC.has(n)) continue;
            if (JSON.stringify(aMap.get(n)) === JSON.stringify(bMap.get(n))) continue;
            // HS2.2 version gate: skip propertyVersions where stored ≥ seed,
            // and skip the matching `properties` entry too (the merge
            // wouldn't take seed's value either). These are local drift the
            // merge is content to leave alone — logging them just buried
            // the real driver.
            if (f === "propertyVersions") {
              const sv = Number(aMap.get(n) ?? 0);
              const dv = Number(bMap.get(n) ?? 0);
              if (sv >= dv && aMap.has(n)) continue;
            }
            if (f === "properties") {
              const sv = Number((cur as unknown as { propertyVersions: Array<[string, number]> }).propertyVersions
                .find(([k]) => k === n)?.[1] ?? 0);
              const dv = Number((seedObj as unknown as { propertyVersions: Array<[string, number]> }).propertyVersions
                .find(([k]) => k === n)?.[1] ?? 0);
              if (sv >= dv && aMap.has(n)) continue;
            }
            diffs.push({
              id: seedObj.id,
              field: `${f}.${n}`,
              detail: f === "propertyVersions"
                ? `stored=${aMap.get(n) ?? "∅"} seed=${bMap.get(n) ?? "∅"}`
                : `stored_has=${aMap.has(n)} seed_has=${bMap.has(n)}`
            });
            recorded = true;
            if (diffs.length >= MAX) break;
          }
          if (!recorded && JSON.stringify(a) !== JSON.stringify(b) && diffs.length < MAX) {
            diffs.push({ id: seedObj.id, field: `${f} (only DYNAMIC props differ)` });
          }
        } else if (f === "verbs") {
          // Per-verb diff so the driver isn't hidden behind a generic
          // "verbs" pointer. Reports the first concrete divergence per
          // mismatched verb: source_hash mismatch (real source drift),
          // missing on one side, or a specific metadata field
          // (aliases / arg_spec / perms / owner / kind / calls / flags).
          // Drops `version`, `slot`, `bytecode`, and `line_map`
          // (matching normalizeVerbForCompare).
          const skip = new Set(["version", "slot", "bytecode", "line_map"]);
          const flagFields = new Set(["direct_callable", "skip_presence_check", "tool_exposed", "pure", "pure_declared"]);
          const aVerbs = new Map(((a as Array<Record<string, unknown>>) ?? []).map((v) => [String(v.name), v]));
          const bVerbs = new Map(((b as Array<Record<string, unknown>>) ?? []).map((v) => [String(v.name), v]));
          const verbNames = new Set<string>([...aVerbs.keys(), ...bVerbs.keys()]);
          let recorded = false;
          for (const vn of verbNames) {
            if (diffs.length >= MAX) break;
            const av = aVerbs.get(vn);
            const bv = bVerbs.get(vn);
            if (!av || !bv) {
              diffs.push({ id: seedObj.id, field: `verbs.${vn}`, detail: !av ? "stored only" : "seed only" });
              recorded = true;
              continue;
            }
            // source_hash matches → only inspect non-derived metadata.
            const hashesMatch = av.source_hash && bv.source_hash && av.source_hash === bv.source_hash;
            const keys = new Set<string>([...Object.keys(av), ...Object.keys(bv)]);
            for (const k of keys) {
              if (skip.has(k)) continue;
              if (hashesMatch && (k === "source" || k === "source_hash")) continue;
              if (flagFields.has(k)) {
                if ((av[k] === true) === (bv[k] === true)) continue;
              } else {
                if (JSON.stringify(av[k]) === JSON.stringify(bv[k])) continue;
              }
              diffs.push({ id: seedObj.id, field: `verbs.${vn}.${k}` });
              recorded = true;
              break;
            }
            if (diffs.length >= MAX) break;
          }
          if (!recorded && diffs.length < MAX) {
            diffs.push({ id: seedObj.id, field: `verbs (only ignored fields differ)` });
          }
        } else if (f === "propertyDefs") {
          // Authoritative def fields only — match the merge's
          // propertyDefEqualIgnoringVersion semantics so cosmetic version
          // drift doesn't appear as a diff.
          const aDefs = new Map(((a as Array<{ name: string; owner: string; perms: string; typeHint?: string; defaultValue: unknown; presenceProjection?: unknown }>) ?? []).map((d) => [d.name, d]));
          const bDefs = new Map(((b as Array<{ name: string; owner: string; perms: string; typeHint?: string; defaultValue: unknown; presenceProjection?: unknown }>) ?? []).map((d) => [d.name, d]));
          const names = new Set<string>([...aDefs.keys(), ...bDefs.keys()]);
          let recorded = false;
          for (const n of names) {
            const ad = aDefs.get(n);
            const bd = bDefs.get(n);
            if (
              ad && bd &&
              ad.owner === bd.owner &&
              ad.perms === bd.perms &&
              (ad.typeHint ?? null) === (bd.typeHint ?? null) &&
              JSON.stringify(ad.defaultValue) === JSON.stringify(bd.defaultValue) &&
              JSON.stringify(ad.presenceProjection ?? null) === JSON.stringify(bd.presenceProjection ?? null)
            ) continue;
            if (!ad && !bd) continue;
            diffs.push({ id: seedObj.id, field: `propertyDefs.${n}`, detail: ad && bd ? "shape changed" : ad ? "stored only" : "seed only" });
            recorded = true;
            if (diffs.length >= MAX) break;
          }
          if (!recorded && diffs.length < MAX) {
            diffs.push({ id: seedObj.id, field: `propertyDefs (only version differs — ignored by merge)` });
          }
        } else {
          diffs.push({ id: seedObj.id, field: f });
        }
      }
    }
    // The merge itself records WHICH field on which object drove the
    // change (mergeSeedObject's reasons sink). Surface those alongside
    // the older field-shape diff: the reasons are authoritative ("this
    // is exactly what triggered changed=true"), the diff is exploratory
    // ("here's the broader shape of the disagreement"). When the two
    // disagree the reasons are right.
    const reasonsTrimmed = (reasons ?? []).slice(0, 12).map((r) => ({ id: r.id, reasons: r.reasons.slice(0, 4) }));
    console.log("woo.host_seed_merge_diff", JSON.stringify({
      host: hostKey,
      phase,
      stored_objects: storedWorld.objects.length,
      seed_objects: seedWorld.objects.length,
      reasons: reasonsTrimmed,
      reason_count: (reasons ?? []).length,
      diffs: diffs.slice(0, MAX),
      truncated: diffs.length > MAX,
      ts: Date.now()
    }));
  }

  private async fetchHostSeed(hostKey: ObjRef, localSeedSource: SerializedWorld | null, options: { preferKv?: boolean } = {}): Promise<{ seed: SeedWorld; digest: string | null; source: "kv" | "do" }> {
    // KV READ PATH (Lever B, content-addressed).
    // Sequence:
    //   1. Read seed-current:${catalogs}:${host} → digest (cheap, ~10ms)
    //   2. Read seed:${catalogs}:${host}:${digest} → bytes (cheap, ~10-50ms)
    //   3. Return seed + digest; caller's merge logic handles staleness
    // On any miss/error, fall through to the DO RPC path below. The
    // content-addressed key prevents the v1 stale-data poisoning: a
    // satellite that reads an older pointer gets older bytes, but the
    // bytes are self-consistent (digest matches), and the receiver's
    // mergeHostScopedSeedWithStatus is robust to slight version skew.
    if (this.env.HOST_SEED_KV && options.preferKv !== false) {
      const kvStartedAt = Date.now();
      try {
        let missReason: HostSeedKvRestoreMissReason | null = null;
        const pointer = await this.env.HOST_SEED_KV.get(hostSeedPointerKey(this.env, hostKey), "text");
        if (pointer && pointer.length > 0) {
          const raw = await this.env.HOST_SEED_KV.get(hostSeedBytesKey(this.env, hostKey, pointer), "text");
          if (raw) {
            try {
              const parsed = JSON.parse(raw) as unknown;
              const seed = restoreHostSeedKvPayload(parsed, pointer, localSeedSource, this.env, (event) => this.emitMetric(event, hostKey));
              if (seed.ok) {
                this.emitMetric({ kind: "startup_storage", phase: "host_seed_fetch", ms: Date.now() - kvStartedAt, status: "ok", objects: seed.value.objects.length, source: "kv" }, hostKey);
                return { seed: seed.value, digest: pointer, source: "kv" };
              }
              missReason = seed.reason;
            } catch (err) {
              if (err instanceof SyntaxError) {
                missReason = "invalid_payload";
              } else {
                throw err;
              }
            }
          } else {
            missReason = "no_entry";
          }
        } else {
          missReason = "no_pointer";
        }
        this.emitMetric({ kind: "host_seed_kv_restore_miss", cache: "host_seed", host: hostKey, reason: missReason ?? "invalid_payload", ms: Date.now() - kvStartedAt }, hostKey);
        this.emitMetric({ kind: "startup_storage", phase: "host_seed_fetch_kv_miss", ms: Date.now() - kvStartedAt, status: "ok" }, hostKey);
      } catch (err) {
        this.emitMetric({ kind: "startup_storage", phase: "host_seed_fetch_kv_miss", ms: Date.now() - kvStartedAt, status: "error", ...metricErrorFields(err) }, hostKey);
        // Fall through to DO RPC.
      }
    }
    const startedAt = Date.now();
    const id = this.env.WOO.idFromName(WORLD_HOST);
    try {
      const request = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}/__internal/host-seed`, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-woo-host-key": WORLD_HOST
        },
        body: JSON.stringify({ host: hostKey })
      }));
      const { response } = await this.outboundFetch(id, request);
      const body = await response.json();
      if (!response.ok) {
        throw wooError("E_STORAGE", `failed to load host seed for ${hostKey}`, body as WooValue);
      }
      this.emitMetric({ kind: "startup_storage", phase: "host_seed_fetch", ms: Date.now() - startedAt, status: "ok", objects: Array.isArray((body as { objects?: unknown }).objects) ? ((body as { objects: unknown[] }).objects.length) : undefined, source: "do" }, hostKey);
      if (!isSeedWorld(body)) throw wooError("E_STORAGE", `host-seed response missing SeedWorld.objectHosts (spec §HS1)`, hostKey);
      // The digest header lets the receiver persist the gateway's
      // content fingerprint so its next cold-load can short-circuit
      // the seed transfer when nothing has changed. Older gateways
      // (rolling deploys) omit the header — treat that as "no digest
      // known," which falls back to the full fetch every time.
      const digest = response.headers.get("x-woo-seed-digest");
      return { seed: body, digest: digest && digest.length > 0 ? digest : null, source: "do" };
    } catch (err) {
      this.emitMetric({ kind: "startup_storage", phase: "host_seed_fetch", ms: Date.now() - startedAt, status: "error", ...metricErrorFields(err) }, hostKey);
      throw err;
    }
  }

  private async refreshRemoteHostSeeds(world: WooWorld, options: { hosts?: string[] } = {}): Promise<Record<string, unknown>> {
    await this.registerObjectRoutes(world);
    const requested = options.hosts && options.hosts.length > 0 ? new Set(options.hosts) : null;
    const routeHosts = new Set(world.objectRoutes().map((route) => route.host).filter((host) => host && host !== WORLD_HOST));
    const hosts = Array.from(new Set(
      Array.from(routeHosts).filter((host) => !requested || requested.has(host))
    )).sort();
    const refreshed: Array<Record<string, unknown>> = [];
    const skipped: Array<Record<string, unknown>> = [];
    const errors: Array<Record<string, unknown>> = [];
    if (requested) {
      for (const host of Array.from(requested).sort()) {
        if (host !== WORLD_HOST && !routeHosts.has(host)) skipped.push({ host, reason: "unmatched_host" });
      }
    }
    for (const host of hosts) {
      const built = world.buildHostSeedForDeliveryWithDigest(host as ObjRef);
      const seed = built.seed;
      if (seed.objects.length === 0) {
        skipped.push({ host, reason: "empty_seed" });
        continue;
      }
      try {
        const result = await this.forwardInternalChecked<Record<string, unknown>>(
          host,
          "/__internal/apply-host-seed",
          { host, seed, digest: built.digest },
          { timeoutMs: 15_000 }
        );
        refreshed.push(result);
      } catch (err) {
        errors.push({ host, error: normalizeError(err) });
      }
    }
    return { ok: errors.length === 0, hosts: hosts.length, refreshed, skipped, errors };
  }

  private applyHostSeed(world: WooWorld, hostKey: ObjRef, seed: SeedWorld, digest: string | null): Record<string, unknown> {
    // Use the gateway's seed verbatim — re-scoping would discard the
    // gateway-supplied objectHosts metadata (see spec §HS1).
    if (seed.objects.length === 0) throw wooError("E_OBJNF", `host seed does not contain ${hostKey}`, hostKey);
    const current = world.exportWorld();
    const merged = mergeHostScopedSeedWithStatus(current, seed, hostKey);
    if (merged.changed) {
      world.importWorld(merged.world);
      world.persistFullSnapshot("host_seed_apply");
      this.crossHostPropCache.clear();
    }
    // Mirror the cold-load path: any successful merge of a freshly
    // built seed leaves the satellite's stored slice consistent with
    // that digest, so the next cold-load probe can short-circuit.
    if (digest) this.repo.saveMeta(HOST_SEED_DIGEST_META_KEY, digest);
    return { ok: true, host: hostKey, changed: merged.changed, objects: world.objects.size };
  }

  private async registerObjectRoutes(world: WooWorld): Promise<void> {
    if (this.routesRegistered) {
      await this.registerIncrementalObjectRoutes(world);
      return;
    }
    const routes = world.objectRoutes();
    // Cold-restart skip: if the current route set hashes to the same
    // value the DO published last time it was awake, the Directory's
    // SQLite tables already hold an identical row set and the RPC
    // would write zero rows. Skipping the round-trip is worth ~one
    // signed fetch + Directory transaction per cold gateway boot.
    // Still populate the in-memory dedup map so subsequent incremental
    // calls in this session don't republish the same triples.
    const currentDigest = hashRouteSet(routes);
    const storedDigest = this.repo.loadMeta(PUBLISHED_ROUTES_DIGEST_META_KEY);
    if (storedDigest && storedDigest === currentDigest) {
      for (const route of routes) {
        this.publishedRoutes.set(route.id, route.host);
        this.routeCache.set(route.id, route.host);
      }
      this.routesRegistered = true;
      this.emitMetric({ kind: "startup_storage", phase: "directory_register_objects_skip", ms: 0, status: "ok", routes: routes.length }, this.durableHostKey());
      return;
    }
    const ok = await this.registerRoutes(routes);
    if (ok) {
      this.routesRegistered = true;
      this.repo.saveMeta(PUBLISHED_ROUTES_DIGEST_META_KEY, currentDigest);
    }
  }

  private async registerIncrementalObjectRoutes(world: WooWorld): Promise<void> {
    const all = world.objectRoutes();
    const fresh = all.filter((route) => this.publishedRoutes.get(route.id) !== route.host);
    if (fresh.length === 0) return;
    const ok = await this.registerRoutes(fresh);
    // Keep the persisted digest in sync with what's actually published
    // so the cold-restart skip in registerObjectRoutes stays valid
    // after route mutations during the session. Single-route writes via
    // adoptLocalObjectRoute deliberately don't update the digest — they
    // bypass `world`, so we instead let the next full registerObjectRoutes
    // call (any request after cold-restart) recompute and refresh.
    if (ok) this.repo.saveMeta(PUBLISHED_ROUTES_DIGEST_META_KEY, hashRouteSet(all));
  }

  private localObjectRoute(world: WooWorld | null | undefined, id: ObjRef): { id: ObjRef; host: string; anchor: ObjRef | null } | null {
    if (isMcpGatewayShardHost(this.durableHostKey())) return null;
    if (!world) return null;
    const hostKey = this.durableHostKey();
    const version = world.mutationVersion();
    if (!this.localRouteSnapshot || this.localRouteSnapshot.hostKey !== hostKey || this.localRouteSnapshot.version !== version) {
      // objectRoutes() walks every object and anchor chain. Host routing reads
      // call this path for many VM property/object operations, so cache the
      // route map for the current world mutation epoch instead of rebuilding it
      // per cell. Route-affecting writes bump mutationVersion.
      this.localRouteSnapshot = {
        hostKey,
        version,
        routes: new Map(world.objectRoutes().map((route) => [route.id, route] as const))
      };
    }
    return this.localRouteSnapshot.routes.get(id) ?? null;
  }

  private async adoptLocalObjectRoute(route: { id: ObjRef; host: string; anchor: ObjRef | null }): Promise<string> {
    if (this.publishedRoutes.get(route.id) !== route.host) {
      const ok = await this.registerRoutes([route]);
      if (!ok) this.routeCache.set(route.id, route.host);
    } else {
      this.routeCache.set(route.id, route.host);
    }
    return route.host;
  }

  private async resolveObjectHostForWorld(world: WooWorld | null | undefined, id: ObjRef, fallbackHost: string): Promise<string> {
    const localRoute = this.localObjectRoute(world, id);
    const cached = this.routeCache.get(id);
    if (cached) {
      if (localRoute && localRoute.host !== cached) return await this.adoptLocalObjectRoute(localRoute);
      return cached;
    }
    if (localRoute) return await this.adoptLocalObjectRoute(localRoute);
    const host = await this.fetchDirectoryObjectHost(id, fallbackHost);
    if (host) this.routeCache.set(id, host);
    return host;
  }

  private async fetchDirectoryObjectHost(id: ObjRef, fallbackHost: string): Promise<string> {
    try {
      const directoryId = this.env.DIRECTORY.idFromName(DIRECTORY_HOST);
      const request = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}/resolve-object`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ id, fallback_host: fallbackHost })
      }));
      const response = await this.env.DIRECTORY.get(directoryId).fetch(request);
      const body = await response.json() as Record<string, unknown>;
      const host = typeof body.host === "string" ? body.host : fallbackHost;
      return host;
    } catch {
      return fallbackHost;
    }
  }

  private async registerRoutes(routes: Array<{ id: ObjRef; host: string; anchor: ObjRef | null }>): Promise<boolean> {
    // Per-frame dedup: skip routes whose (id → host) mapping is already
    // published by this DO. Without this filter, repeated session registration
    // and single-route adoption fired signed RPCs even when the directory would
    // have written zero rows. The directory's `register-objects` metric showed
    // `routes:1 writes:0` on basically every call — the round-trip itself was
    // the cost. We still emit when any route is new or has changed host (e.g.
    // host-placement migration moves an object), so directory acceleration
    // stays current.
    const fresh = routes.filter((route) => this.publishedRoutes.get(route.id) !== route.host);
    if (fresh.length === 0) return true;
    try {
      const id = this.env.DIRECTORY.idFromName(DIRECTORY_HOST);
      const request = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}/register-objects`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ routes: fresh })
      }));
      const response = await this.env.DIRECTORY.get(id).fetch(request);
      if (!response.ok) throw new Error(`Directory register-objects failed: ${response.status}`);
      for (const route of fresh) {
        this.routeCache.set(route.id, route.host);
        this.publishedRoutes.set(route.id, route.host);
      }
      return true;
    } catch {
      // Directory acceleration is best-effort. Fallback routing still sends
      // unknown objects to the world host or the caller-provided space host.
      return false;
    }
  }

  private installExecutorContext(world: WooWorld, localHost: string): void {
    const hostForObjectUncached = async (id: ObjRef): Promise<string | null> => {
      const fallbackHost = isMcpGatewayShardHost(localHost) ? WORLD_HOST : "";
      const resolved = await this.resolveObjectHostForWorld(world, id, fallbackHost);
      return resolved || null;
    };
    const hostForObject = async (id: ObjRef, memo?: HostOperationMemo): Promise<string | null> => {
      if (!memo) return await hostForObjectUncached(id);
      return await memoizeHostOperation(memo.routes, id, () => hostForObjectUncached(id));
    };
    const bridge: ExecutorContext = {
      localHost,
      hostForObject,
      getPropChecked: async (progr, objRef, name, memo) => {
        const read = async (): Promise<WooValue> => {
          const host = await hostForObject(objRef, memo);
          if (!host || host === localHost) return await world.getPropChecked(progr, objRef, name, memo);
          const cacheable = PersistentObjectDO.CROSS_HOST_STABLE_PROPS.has(name);
          const cacheKey = cacheable ? `${host}|${objRef}|${name}` : null;
          if (cacheKey !== null) {
            const cached = this.crossHostPropCache.get(cacheKey);
            if (cached && cached.expiresAt > Date.now()) return cached.value as WooValue;
          }
          const response = await this.forwardInternalReadChecked<{ value: WooValue }>(host, "/__internal/remote-get-prop", { progr, obj: objRef, name });
          if (cacheKey !== null) {
            if (this.crossHostPropCache.size >= PersistentObjectDO.CROSS_HOST_PROP_CACHE_MAX) {
              const firstKey = this.crossHostPropCache.keys().next().value;
              if (firstKey !== undefined) this.crossHostPropCache.delete(firstKey);
            }
            this.crossHostPropCache.set(cacheKey, { value: response.value, expiresAt: Date.now() + PersistentObjectDO.CROSS_HOST_PROP_TTL_MS });
          }
          return response.value;
        };
        if (memo) return await memoizeHostOperation(memo.reads, `prop:${progr}:${objRef}:${name}`, read);
        return await read();
      },
      setPropChecked: async (progr, objRef, name, value, memo) => {
        const host = await hostForObject(objRef, memo);
        if (!host || host === localHost) {
          await world.setPropChecked(progr, objRef, name, value, memo);
          return;
        }
        memo?.reads.delete(`prop:${progr}:${objRef}:${name}`);
        this.crossHostPropCache.delete(`${host}|${objRef}|${name}`);
        await this.forwardInternalChecked<{ ok: true }>(host, "/__internal/remote-set-prop", { progr, obj: objRef, name, value });
      },
      objectSummary: async (readActor, objRef, memo) => {
        const read = async (): Promise<ScopedObjectSummary> => {
          const host = await hostForObject(objRef, memo);
          if (!host || host === localHost) return await world.scopedObjectSummary(readActor, objRef, memo);
          return await this.forwardInternalReadChecked<ScopedObjectSummary>(
            host,
            "/__internal/object-summary",
            { read_actor: readActor, obj: objRef }
          );
        };
        if (memo) return await memoizeHostOperation(memo.reads, `summary:${readActor}:${objRef}`, read);
        return await read();
      },
      objectSummaries: async (readActor, objRefs, memo) => {
        const out: Record<ObjRef, ScopedObjectSummary> = {};
        const missingByHost = new Map<string, ObjRef[]>();
        for (const objRef of objRefs) {
          const key = `summary:${readActor}:${objRef}`;
          const cached = memo?.reads.get(key) as Promise<ScopedObjectSummary> | undefined;
          if (cached) {
            out[objRef] = await cached;
            continue;
          }
          const host = await hostForObject(objRef, memo);
          if (!host || host === localHost) {
            const summary = await world.scopedObjectSummary(readActor, objRef, memo);
            out[objRef] = summary;
            if (memo) memo.reads.set(key, Promise.resolve(summary));
            continue;
          }
          const list = missingByHost.get(host) ?? [];
          list.push(objRef);
          missingByHost.set(host, list);
        }
        await Promise.all(Array.from(missingByHost, async ([host, ids]) => {
          try {
            const response = await this.forwardInternalReadChecked<{ objects: Record<ObjRef, ScopedObjectSummary> }>(
              host,
              "/__internal/object-summaries",
              { read_actor: readActor, ids }
            );
            if (!response.objects || typeof response.objects !== "object" || Array.isArray(response.objects)) {
              throw wooError("E_INTERNAL", "remote object-summaries response missing objects", { host });
            }
            for (const id of ids) {
              const summary = response.objects?.[id];
              if (!summary) continue;
              out[id] = summary;
              if (memo) memo.reads.set(`summary:${readActor}:${id}`, Promise.resolve(summary));
            }
          } catch (err) {
            if (!isReadAvailabilityError(err)) throw err;
            // Scoped summaries are projection hints. A cold or slow remote host
            // must not hold this host's single-threaded queue.
          }
        }));
        return out;
      },
      roomSnapshot: async (readActor, room, sessionId, memo) => {
        const read = async (): Promise<RoomSnapshot> => {
          const host = await hostForObject(room, memo);
          if (!host || host === localHost) return await world.roomSnapshotForActor(readActor, room, sessionId ?? null, memo);
          return await this.forwardInternalReadChecked<RoomSnapshot>(
            host,
            "/__internal/room-snapshot",
            { read_actor: readActor, room, session_id: sessionId ?? null }
          );
        };
        if (memo) return await memoizeHostOperation(memo.reads, `room-snapshot:${readActor}:${room}:${sessionId ?? ""}`, read);
        return await read();
      },
      overlaySnapshot: async (readActor, subject, surface, sessionId, memo) => {
        const read = async (): Promise<OverlaySnapshot> => {
          const host = await hostForObject(subject, memo);
          if (!host || host === localHost) return await world.overlaySnapshotForActor(readActor, subject, surface, sessionId ?? null, memo);
          return await this.forwardInternalReadChecked<OverlaySnapshot>(
            host,
            "/__internal/overlay-snapshot",
            { read_actor: readActor, subject, surface, session_id: sessionId ?? null }
          );
        };
        if (memo) return await memoizeHostOperation(memo.reads, `overlay-snapshot:${readActor}:${subject}:${surface}:${sessionId ?? ""}`, read);
        return await read();
      },
      describeObject: async (nameActor, readActor, objRef, memo) => {
        const read = async () => {
          const host = await hostForObject(objRef, memo);
          if (!host || host === localHost) {
            return {
              name: world.object(objRef).name,
              description: world.propOrNullForActor(readActor, objRef, "description"),
              aliases: world.propOrNullForActor(readActor, objRef, "aliases"),
              owner: world.object(objRef).owner,
              obvious_verbs: world.obviousCommandSyntaxes(objRef, world.object(objRef).name || objRef)
            };
          }
          return await this.forwardInternalReadChecked<HostObjectSummary>(
            host,
            "/__internal/remote-describe",
            { name_actor: nameActor, read_actor: readActor, obj: objRef }
          );
        };
        if (memo) return await memoizeHostOperation(memo.reads, `describe:${nameActor}:${readActor}:${objRef}`, read);
        return await read();
      },
      describeObjects: async (nameActor, readActor, objRefs, memo) => {
        const out: Record<ObjRef, HostObjectSummary> = {};
        const missingByHost = new Map<string, ObjRef[]>();
        for (const objRef of objRefs) {
          const key = `describe:${nameActor}:${readActor}:${objRef}`;
          const cached = memo?.reads.get(key) as Promise<HostObjectSummary> | undefined;
          if (cached) {
            out[objRef] = await cached;
            continue;
          }
          const host = await hostForObject(objRef, memo);
          if (!host || host === localHost) {
            const summary = {
              name: world.object(objRef).name,
              description: world.propOrNullForActor(readActor, objRef, "description"),
              aliases: world.propOrNullForActor(readActor, objRef, "aliases"),
              owner: world.object(objRef).owner,
              obvious_verbs: world.obviousCommandSyntaxes(objRef, world.object(objRef).name || objRef)
            };
            out[objRef] = summary;
            if (memo) memo.reads.set(key, Promise.resolve(summary));
            continue;
          }
          const list = missingByHost.get(host) ?? [];
          list.push(objRef);
          missingByHost.set(host, list);
        }
        await Promise.all(Array.from(missingByHost, async ([host, ids]) => {
          try {
            const response = await this.forwardInternalReadChecked<{ objects: Record<ObjRef, HostObjectSummary> }>(
              host,
              "/__internal/remote-describe-many",
              { name_actor: nameActor, read_actor: readActor, ids }
            );
            if (!response.objects || typeof response.objects !== "object" || Array.isArray(response.objects)) {
              throw wooError("E_INTERNAL", "remote describe-many response missing objects", { host });
            }
            for (const id of ids) {
              const summary = response.objects?.[id];
              if (!summary) continue;
              out[id] = summary;
              if (memo) memo.reads.set(`describe:${nameActor}:${readActor}:${id}`, Promise.resolve(summary));
            }
          } catch (err) {
            if (!isReadAvailabilityError(err)) throw err;
            // Object matching/rendering can fall back to ids for a slow host.
          }
        }));
        return out;
      },
      resolveVerb: async (target, verbName, memo) => {
        const read = async () => {
          const host = await hostForObject(target, memo);
          if (!host || host === localHost) {
            const { verb } = world.resolveVerb(target, verbName);
            return { name: verb.name, direct_callable: verb.direct_callable === true, arg_spec: verb.arg_spec ?? {} };
          }
          return await this.forwardInternalReadChecked<{ name: string; direct_callable: boolean; arg_spec?: Record<string, WooValue> }>(
            host,
            "/__internal/remote-resolve-verb",
            { target, verb: verbName }
          );
        };
        if (memo) return await memoizeHostOperation(memo.reads, `verb:${target}:${verbName}`, read);
        return await read();
      },
      commandVerbCandidates: async (target, verbName, memo) => {
        const read = async () => {
          const host = await hostForObject(target, memo);
          if (!host || host === localHost) return world.commandVerbCandidateSummaries(target, verbName);
          const response = await this.forwardInternalReadChecked<{ candidates?: Array<{ name: string; direct_callable: boolean; arg_spec?: Record<string, WooValue> }> }>(
            host,
            "/__internal/remote-command-verb-candidates",
            { target, verb: verbName }
          );
          return Array.isArray(response.candidates) ? response.candidates : [];
        };
        if (memo) return await memoizeHostOperation(memo.reads, `command-verbs:${target}:${verbName}`, read);
        return await read();
      },
      isDescendantOf: async (objRef, ancestorRef, memo) => {
        const read = async (): Promise<boolean> => {
          const host = await hostForObject(objRef, memo);
          if (!host || host === localHost) return world.isDescendantOf(objRef, ancestorRef);
          const response = await this.forwardInternalReadChecked<{ result: boolean }>(
            host,
            "/__internal/remote-is-descendant",
            { obj: objRef, ancestor: ancestorRef }
          );
          return response.result === true;
        };
        if (memo) return await memoizeHostOperation(memo.reads, `isa:${objRef}:${ancestorRef}`, read);
        return await read();
      },
      isRecycled: async (objRef, memo) => {
        // Per spec/semantics/recycle.md §RC5 and
        // spec/reference/persistence.md §14.2.1, tombstones live on the
        // owning host. When `objRef` lives elsewhere, ask that host's
        // local tombstone table; otherwise consult the local set.
        const read = async (): Promise<boolean> => {
          const host = await hostForObject(objRef, memo);
          if (!host || host === localHost) return world.isRecycled(objRef);
          try {
            const response = await this.forwardInternalReadChecked<{ result: boolean }>(
              host,
              "/__internal/remote-is-recycled",
              { obj: objRef }
            );
            return response.result === true;
          } catch {
            return false;
          }
        };
        if (memo) return await memoizeHostOperation(memo.reads, `is-recycled:${objRef}`, read);
        return await read();
      },
      location: async (objRef, memo) => {
        const read = async (): Promise<ObjRef | null> => {
          const host = await hostForObject(objRef, memo);
          if (!host || host === localHost) return world.object(objRef).location;
          const response = await this.forwardInternalReadChecked<{ location: ObjRef | null }>(host, "/__internal/remote-location", { obj: objRef });
          return response.location;
        };
        if (memo) return await memoizeHostOperation(memo.reads, `location:${objRef}`, read);
        return await read();
      },
      dispatch: async (ctx, target, verbName, args, startAt) => {
        const host = await hostForObject(startAt ?? target, ctx.hostMemo);
        const resolvedHost = host ?? localHost;
        const { pure, path } = this.resolveDispatchPath(world, target, verbName, resolvedHost, localHost);
        if (path === "local") return await world.hostDispatch(ctx, target, verbName, args, startAt);
        // Pure verbs route through forwardInternalReadChecked for its 2.5s
        // read deadline. A timed-out look_self surfaces as E_TIMEOUT to the
        // caller and frees the host queue rather than wedging it.
        const forward = pure
          ? this.forwardInternalReadChecked.bind(this)
          : this.forwardInternalChecked.bind(this);
        const response = await forward<{
          result: WooValue;
            observations?: Observation[];
            audience_actors?: ObjRef[];
            observation_audiences?: ObjRef[][];
            audience_sessions?: string[];
            observation_session_audiences?: string[][];
            deferred_host_effects?: DeferredHostEffect[];
        }>(resolvedHost, "/__internal/remote-dispatch", {
          ctx: this.serializedCallContext(ctx),
          target,
          verb: verbName,
          args,
          start_at: startAt ?? null
        });
        if (Array.isArray(response.observations)) {
          for (const observation of response.observations) ctx.observations.push(observation);
        }
        // Surface authoritative audience info from the source DO so the
        // gateway's directCallNow uses it instead of recomputing from stale
        // local state.
          if (response.audience_actors || response.observation_audiences || response.audience_sessions || response.observation_session_audiences) {
            (ctx as { crossHostAudience?: { audienceActors?: ObjRef[]; observationAudiences?: ObjRef[][]; audienceSessions?: string[]; observationSessionAudiences?: string[][] } }).crossHostAudience = {
              audienceActors: response.audience_actors,
              observationAudiences: response.observation_audiences,
              audienceSessions: response.audience_sessions,
              observationSessionAudiences: response.observation_session_audiences
            };
          }
        if (Array.isArray(response.deferred_host_effects)) {
          if (ctx.deferHostEffect) {
            for (const effect of response.deferred_host_effects) ctx.deferHostEffect(effect);
          } else {
            await world.applyDeferredHostEffects(response.deferred_host_effects);
          }
        }
        return response.result;
      },
      moveObject: async (objRef, targetRef, options = {}) => {
        const host = await hostForObject(objRef);
        if (!host || host === localHost) {
          return await world.moveObjectChecked(objRef, targetRef, options);
        }
        const suppressMirrorHost = options.suppressMirrorHost ?? localHost;
        const response = await this.forwardInternalChecked<{ ok: true; old_location?: ObjRef | null; location?: ObjRef }>(host, "/__internal/remote-move-object", {
          obj: objRef,
          target: targetRef,
          suppress_mirror_host: suppressMirrorHost
        });
        const result: MoveObjectResult = {
          oldLocation: typeof response.old_location === "string" ? response.old_location : null,
          location: typeof response.location === "string" ? response.location : targetRef
        };
        // If this host owns either affected container, the object owner
        // suppresses mirror RPCs back here to avoid A→B→A subrequest
        // recursion. Update this host's contents caches after the
        // authoritative owner-location write succeeds.
        if (suppressMirrorHost === localHost) {
          if (result.oldLocation && await hostForObject(result.oldLocation) === localHost && world.objects.has(result.oldLocation)) {
            world.mirrorContents(result.oldLocation, objRef, false);
          }
          if (await hostForObject(result.location) === localHost && world.objects.has(result.location)) {
            world.mirrorContents(result.location, objRef, true);
          }
        }
        return result;
      },
      mirrorContents: async (containerRef, objRef, present) => {
        const host = await hostForObject(containerRef);
        if (!host || host === localHost) {
          world.mirrorContents(containerRef, objRef, present);
          return;
        }
        await this.forwardInternalChecked(host, "/__internal/mirror-contents", { container: containerRef, obj: objRef, present });
      },
      setActorPresence: async (actor, space, present, sessionId) => {
        const host = await hostForObject(actor);
        if (!host || host === localHost) {
          world.setActorPresence(actor, space, present, sessionId);
          return;
        }
        await this.forwardInternalChecked(host, "/__internal/actor-presence", { actor, space, present, session: sessionId ?? null });
      },
      setSpaceSubscriber: async (space, actor, present, sessionId) => {
        const host = await hostForObject(space);
        if (!host || host === localHost) {
          world.setSpaceSubscriber(space, actor, present, sessionId);
          return;
        }
        await this.forwardInternalChecked(host, "/__internal/space-subscriber", { space, actor, present, session: sessionId ?? null });
      },
      spaceAudienceSessions: async (space, actors, memo) => {
        const read = async (): Promise<string[]> => {
          const host = await hostForObject(space, memo);
          if (!host || host === localHost) return world.presenceSessionIdsIn(space, actors);
          const response = await this.forwardInternalReadChecked<{ sessions: string[] }>(
            host,
            "/__internal/space-audience-sessions",
            { space, actors: actors ?? null }
          );
          return Array.isArray(response.sessions) ? response.sessions.filter((item): item is string => typeof item === "string") : [];
        };
        if (memo) return await memoizeHostOperation(memo.reads, `space-audience:${space}:${(actors ?? []).join(",")}`, read);
        return await read();
      },
      actorSessionLocations: async (actor, memo) => {
        const read = async (): Promise<ObjRef[]> => {
          const host = await hostForObject(actor, memo);
          if (!host || host === localHost) return world.allLocationsForActor(actor);
          const response = await this.forwardInternalReadChecked<{ locations: ObjRef[] }>(
            host,
            "/__internal/actor-session-locations",
            { actor }
          );
          return Array.isArray(response.locations) ? response.locations.filter((item): item is ObjRef => typeof item === "string") : [];
        };
        if (memo) return await memoizeHostOperation(memo.reads, `actor-locations:${actor}`, read);
        return await read();
      },
      actorSessionLocationsBatch: async (actors, memo) => {
        const out = new Map<ObjRef, ObjRef[]>();
        const missingByHost = new Map<string, ObjRef[]>();
        for (const actor of actors) {
          const key = `actor-locations:${actor}`;
          const cached = memo?.reads.get(key) as Promise<ObjRef[]> | undefined;
          if (cached) {
            out.set(actor, await cached);
            continue;
          }
          const host = await hostForObject(actor, memo);
          if (!host || host === localHost) {
            const locations = world.allLocationsForActor(actor);
            out.set(actor, locations);
            if (memo) memo.reads.set(key, Promise.resolve(locations));
            continue;
          }
          const list = missingByHost.get(host) ?? [];
          list.push(actor);
          missingByHost.set(host, list);
        }
        await Promise.all(Array.from(missingByHost, async ([host, ids]) => {
          try {
            const response = await this.forwardInternalReadChecked<{ locations: Record<ObjRef, ObjRef[]> }>(
              host,
              "/__internal/actor-session-locations-batch",
              { actors: ids }
            );
            const map = response.locations && typeof response.locations === "object" && !Array.isArray(response.locations)
              ? response.locations
              : {};
            for (const actor of ids) {
              const raw = map[actor];
              const locations = Array.isArray(raw)
                ? raw.filter((item): item is ObjRef => typeof item === "string")
                : [];
              out.set(actor, locations);
              if (memo) memo.reads.set(`actor-locations:${actor}`, Promise.resolve(locations));
            }
          } catch (err) {
            if (!isReadAvailabilityError(err)) throw err;
            // Leave these actors absent from `out`; the caller treats unknown
            // remote-location data as "skip scrub for this actor this window".
          }
        }));
        return out;
      },
      contents: async (objRef, memo) => {
        const read = async (): Promise<ObjRef[]> => {
          const host = await hostForObject(objRef, memo);
          if (!host || host === localHost) return world.contentsOf(objRef);
          const response = await this.forwardInternalReadChecked<{ contents: ObjRef[] }>(host, "/__internal/contents", { obj: objRef });
          return response.contents;
        };
        if (memo) return await memoizeHostOperation(memo.reads, `contents:${objRef}`, read);
        return await read();
      },
      enumerateRemoteTools: async (actor, requests) => {
        // Group ids by owning host, RPC each, merge.
        const byHost = new Map<string, RemoteToolRequest[]>();
        for (const request of requests) {
          const id = request.id;
          const host = await hostForObject(id);
          if (!host || host === localHost) continue;
          const list = byHost.get(host) ?? [];
          list.push(request);
          byHost.set(host, list);
        }
        if (byHost.size === 0) return [];
        const responses = await Promise.all(
          Array.from(byHost, async ([host, hostRequests]) => {
            const cached = this.readGatewayToolSurfaceDescriptors(hostRequests);
            // Only serve from cache without an owner refresh when EVERY request
            // in this host batch is covered. A partial hit (one cached scope,
            // another uncached) must still refresh, otherwise the uncached
            // scopes' tools silently vanish from a mixed/expanded listing.
            const fullyCovered = hostRequests.every((request) => this.gatewayToolSurfaceRequestCovered(request));
            if (fullyCovered) {
              this.emitMetric({
                kind: "same_host_fallback",
                route: "/__internal/enumerate-tools",
                host,
                rows: cached.length,
                reason: "cache_hit"
              }, localHost);
              return cached;
            }
            try {
              const response = await this.forwardInternalReadChecked<{ tools: RemoteToolDescriptor[] }>(host, "/__internal/enumerate-tools", { actor, requests: hostRequests });
              const tools = response.tools ?? [];
              this.storeGatewayToolSurfacesForRequests(hostRequests, tools);
              const exactRequestIds = new Set(hostRequests.map((request) => request.id));
              // Cache only the exact ids whose owner we just resolved. Expanded
              // content descriptors can include mounted/self-hosted objects
              // represented as stubs in the responding host's slice; caching
              // those to the scope host poisons later authority fetches.
              for (const tool of tools) {
                if (exactRequestIds.has(tool.object) && !this.routeCache.has(tool.object)) this.routeCache.set(tool.object, host);
              }
              return tools;
            } catch {
              if (cached.length > 0) {
                this.emitMetric({
                  kind: "same_host_fallback",
                  route: "/__internal/enumerate-tools",
                  host,
                  rows: cached.length,
                  reason: "owner_timeout"
                }, localHost);
                return cached;
              }
              // Same-host stale fallback is unconditional: a previously listed
              // descriptor must not silently vanish on owner timeout. With no
              // cached row to serve, surface the refresh failure to the caller.
              throw new Error(`remote tool descriptor refresh failed: ${host}`);
            }
          })
        );
        return responses.flat();
      }
    };
    world.setExecutorContext(bridge);
    world.setMetricsHook((event) => this.emitMetric(event, localHost));
    world.setChainOriginPrefix(localHost);
  }

  private acceptBrowserMetricForSession(sessionId: string): boolean {
    const now = Date.now();
    this.pruneBrowserMetricSessionCounters(now);
    let counter = this.browserMetricSessionCounters.get(sessionId);
    if (!counter || now - counter.windowStart >= METRIC_SAMPLE_WINDOW_MS) {
      counter = { windowStart: now, seen: 0, lastSeen: now };
      this.browserMetricSessionCounters.set(sessionId, counter);
    }
    counter.lastSeen = now;
    counter.seen += 1;
    if (counter.seen <= BROWSER_METRICS_SESSION_BUDGET) return true;
    if ((counter.seen - BROWSER_METRICS_SESSION_BUDGET) % BROWSER_METRICS_OVER_BUDGET_SAMPLE_RATE === 0) return true;
    return false;
  }

  private pruneBrowserMetricSessionCounters(now: number): void {
    if (now - this.lastBrowserMetricCounterPrune < METRIC_SAMPLE_WINDOW_MS) return;
    this.lastBrowserMetricCounterPrune = now;
    for (const [sessionId, counter] of this.browserMetricSessionCounters) {
      if (now - counter.lastSeen > BROWSER_METRICS_COUNTER_TTL_MS) {
        this.browserMetricSessionCounters.delete(sessionId);
      }
    }
  }

  // Throttle log emission for high-rate metric kinds so a noisy gateway
  // doesn't blow up the log pipeline. `applied`, `direct_call`, and
  // `compose_look` already have natural 1-per-call bounds; `broadcast` and
  // `cross_host_rpc` can fire many times per call so we cap each kind's log
  // emission at SAMPLE_BUDGET per SAMPLE_WINDOW_MS and emit a periodic
  // summary of how many *log lines* were skipped. The underlying operations
  // still ran — only the per-event log line was suppressed.
  private emitMetric(event: MetricEvent, hostKey: string): void {
    // AE writes happen before the console-tail throttle: the throttle is only
    // there to keep tail logs human-readable; AE has its own sampling rules
    // (see metrics-sink.ts) and we want a noisy `broadcast` burst to still
    // produce accurate counts in the dashboard.
    writeMetricToAnalytics(event, hostKey, this.env.METRICS);
    const sampleKind = event.kind === "browser_activity" ? "browser_metrics" : event.kind;
    if (sampleKind === "broadcast" || sampleKind === "cross_host_rpc" || sampleKind === "storage_direct_write" || sampleKind === "browser_metrics") {
      const counter = this.metricSampleCounters[sampleKind];
      const now = Date.now();
      if (now - counter.windowStart >= METRIC_SAMPLE_WINDOW_MS) {
        if (counter.suppressed > 0) {
          console.log("woo.metric", JSON.stringify({ kind: `${sampleKind}_log_sampled`, suppressed: counter.suppressed, ms_window: METRIC_SAMPLE_WINDOW_MS, ts: now, host_key: hostKey }));
        }
        counter.windowStart = now;
        counter.emitted = 0;
        counter.suppressed = 0;
      }
      if (counter.emitted >= METRIC_SAMPLE_BUDGET) {
        counter.suppressed += 1;
        return;
      }
      counter.emitted += 1;
    }
    console.log("woo.metric", JSON.stringify({ ...event, ts: Date.now(), host_key: hostKey }));
  }

  private emitV2OpenStep(
    phase: string,
    startedAt: number,
    fields: Partial<Extract<MetricEvent, { kind: "v2_open_step" }>>
  ): void {
    this.emitMetric({
      kind: "v2_open_step",
      phase,
      ms: metricElapsed(startedAt),
      status: "ok",
      ...fields
    }, this.durableHostKey());
  }

  private metricSampleCounters: Record<"broadcast" | "cross_host_rpc" | "storage_direct_write" | "browser_metrics", { windowStart: number; emitted: number; suppressed: number }> = {
    broadcast: { windowStart: 0, emitted: 0, suppressed: 0 },
    cross_host_rpc: { windowStart: 0, emitted: 0, suppressed: 0 },
    storage_direct_write: { windowStart: 0, emitted: 0, suppressed: 0 },
    browser_metrics: { windowStart: 0, emitted: 0, suppressed: 0 }
  };
  private browserMetricSessionCounters = new Map<string, BrowserMetricSessionCounter>();
  private lastBrowserMetricCounterPrune = 0;

  private serializedCallContext(ctx: CallContext): Record<string, unknown> {
    const session = ctx.session ? ctx.world.sessions.get(ctx.session) : undefined;
    return {
      space: ctx.space,
      seq: ctx.seq,
      session: ctx.session,
      session_started: session?.started ?? null,
      session_active_scope: session?.activeScope ?? null,
      session_current_location: session?.activeScope ?? null,
      session_expires_at: session?.expiresAt ?? null,
      session_token_class: session?.tokenClass ?? null,
      session_apikey_id: session?.apikeyId ?? null,
      actor: ctx.actor,
      player: ctx.player,
      caller: ctx.caller,
      callerPerms: ctx.callerPerms,
      progr: ctx.progr,
      thisObj: ctx.thisObj,
      verbName: ctx.verbName,
      definer: ctx.definer,
      message: ctx.message,
      moveto_stack: ctx.movetoStack ? Array.from(ctx.movetoStack) : []
    };
  }

  private async handleInternal(request: Request, world: WooWorld, pathname: string, hostKey: string): Promise<Response> {
    try {
      const body = await readJsonBody(request);
      if (request.method === "POST" && pathname === "/__internal/object-routes") {
        return jsonResponse(world.objectRoutes());
      }

      if (request.method === "POST" && pathname === "/__internal/mcp-gateway-world") {
        if (hostKey !== WORLD_HOST) throw wooError("E_NOTAPPLICABLE", "MCP gateway snapshots are served only by the world host");
        const shard = typeof body.shard === "string" ? body.shard : "";
        if (!isMcpGatewayShardHost(shard)) throw wooError("E_INVARG", "mcp-gateway-world requires a shard host");
        // Compatibility/diagnostic route only. Shards no longer call WORLD to
        // cold-load; they read Directory session rows directly. Keep this
        // endpoint bounded so old probes cannot accidentally request a full
        // world materialization from the gateway.
        const exported = mcpGatewayShardSerializedWorld(await this.loadMcpGatewayShardSessions(shard));
        return jsonResponse(exported);
      }

      if (request.method === "POST" && pathname === "/__internal/mcp-commit-fanout") {
        const scope = String(body.scope ?? "") as ObjRef;
        if (!scope) throw wooError("E_INVARG", "mcp-commit-fanout requires scope");
        if (!isShadowCommitAccepted(body.commit)) throw wooError("E_INVARG", "mcp-commit-fanout requires accepted commit");
        if (!body.transcript || typeof body.transcript !== "object" || Array.isArray(body.transcript)) {
          throw wooError("E_INVARG", "mcp-commit-fanout requires transcript");
        }
        const originSession = typeof body.origin_session === "string" ? body.origin_session : null;
        const audience = mcpFanoutAudienceFromBody(body);
        // The durable projection-cache write is NOT done here: a fanout frame
        // may arrive out of scope-sequence order, and writing it before
        // sequencing would advance the cache head past a not-yet-seen earlier
        // frame, dropping that frame at the head-idempotency guard. The gateway
        // applies the SQL write via the persistAcceptedProjection hook, in
        // contiguous order, as it accepts/drains each frame.
        this.getMcpGateway(world).acceptRemoteV2Commit(scope, body.commit, body.transcript as EffectTranscript, originSession, audience);
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && pathname === "/__internal/mcp-live-fanout") {
        const scope = String(body.scope ?? "") as ObjRef;
        if (!scope) throw wooError("E_INVARG", "mcp-live-fanout requires scope");
        if (!body.transcript || typeof body.transcript !== "object" || Array.isArray(body.transcript)) {
          throw wooError("E_INVARG", "mcp-live-fanout requires transcript");
        }
        const originSession = typeof body.origin_session === "string" ? body.origin_session : null;
        this.getMcpGateway(world).acceptRemoteV2Live(scope, body.transcript as EffectTranscript, originSession);
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && pathname === "/__internal/apply-v2-commit") {
        const scope = String(body.scope ?? "") as ObjRef;
        if (!scope) throw wooError("E_INVARG", "apply-v2-commit requires scope");
        if (!isShadowCommitAccepted(body.commit)) throw wooError("E_INVARG", "apply-v2-commit requires accepted commit");
        if (!body.transcript || typeof body.transcript !== "object" || Array.isArray(body.transcript)) {
          throw wooError("E_INVARG", "apply-v2-commit requires transcript");
        }
        const commit = body.commit as ShadowCommitAccepted;
        const transcript = body.transcript as EffectTranscript;
        if (commit.position.scope !== scope || !v2ApplyCommitTranscriptScopeMatches(scope, commit, transcript)) {
          throw wooError("E_INVARG", "apply-v2-commit scope mismatch");
        }
        const projectionWrites = Array.isArray(body.projection_writes)
          ? body.projection_writes as ProjectionWrite[]
          : commit.projection_writes ?? [];
        if (projectionWrites.length > 0 || commit.projection_delta) {
          this.requireProjectionWritesComplete(scope, commit.projection_delta, projectionWrites, "host_apply");
          const applied = world.applyProjectionWrites(projectionWrites, { transcript });
          if (applied.creates > 0) await this.registerIncrementalObjectRoutes(world);
          return jsonResponse(applied);
        }
        // Satellite write-through: apply to the local host slice. The
        // ShadowApplyTarget abstraction supplies only `applyTranscript`
        // here — the originating gateway already did session/api-key
        // housekeeping before fanning out, so there's nothing to mirror.
        let applyResult: ReturnType<WooWorld["applyCommittedShadowTranscriptToHost"]> | null = null;
        await runShadowApply(transcript, {
          applyTranscript: (t) => {
            applyResult = world.applyCommittedShadowTranscriptToHost(hostKey, t, { gatewayHost: hostKey === WORLD_HOST });
          }
        });
        return jsonResponse(applyResult);
      }

      if (request.method === "POST" && pathname === "/__internal/host-seed") {
        const host = String(body.host ?? "") as ObjRef;
        if (!host) throw wooError("E_INVARG", "host-seed requires host");
        const built = world.buildHostSeedForDeliveryWithDigest(host);
        // KV publish (Lever B): content-addressed bytecode-free write.
        //   seed:${catalogs}:${host}:${digest} -> { digest, seed, bytecode_hashes }
        //   seed-current:${catalogs}:${host}   -> digest             (the pointer)
        // The bytes key is immutable per content and bundled-catalog
        // fingerprint; new content or new catalog source = new key.
        // The seed omits verb.bytecode (the dominant KV storage cost);
        // satellites restore exact bytecode by hash from local SQL or
        // bundled catalogs. If a verb is new, edited, or compiled by a
        // different runtime and no matching local bytecode exists, the
        // cache is treated as a miss and the satellite falls through to
        // DO RPC. The pointer moves atomically (last write wins). Stale
        // bytes stay in KV until TTL but are unreferenced.
        //
        // The catalog-fingerprint namespace is deliberately narrower than a
        // deploy-version key: ordinary code-only deploys keep cache locality,
        // but bundled catalog source changes cannot restore old bytecode from
        // the receiver's local SQL.
        if (this.env.HOST_SEED_KV && typeof this.state.waitUntil === "function" && built.digest) {
          const bytesKey = hostSeedBytesKey(this.env, host, built.digest);
          const pointerKey = hostSeedPointerKey(this.env, host);
          const payload = JSON.stringify(bytecodeFreeHostSeedKvPayload(built.seed, built.digest));
          this.state.waitUntil((async () => {
            try {
              // Write bytes first; then move the pointer. This order
              // means a satellite that reads `seed-current` after the
              // write finds bytes available. If we wrote the pointer
              // first and crashed, a satellite would read the pointer
              // and miss the bytes — falls through to DO RPC, no
              // correctness loss but a missed cache hit.
              await this.env.HOST_SEED_KV!.put(bytesKey, payload, {
                // TTL keeps stale-content keys from growing unboundedly.
                // The bytes are immutable so a long TTL is safe;
                // anything still pointed at by current must be fresh
                // enough to be valid.
                expirationTtl: 7 * 24 * 3600
              });
              await this.env.HOST_SEED_KV!.put(pointerKey, built.digest);
            } catch (err) {
              console.warn("woo.host_seed_kv_put.failed", { host, digest: built.digest, error: normalizeError(err) });
            }
          })());
        }
        return jsonResponse(built.seed, 200, { "x-woo-seed-digest": built.digest });
      }

      if (request.method === "POST" && pathname === "/__internal/authority-slice") {
        const objects = Array.isArray(body.objects)
          ? body.objects.filter((item): item is ObjRef => typeof item === "string" && item.length > 0)
          : [];
        const authority = withAuthorityPageProvenance(
          world.exportAuthoritySlice([], objects),
          (ref) => ({
            source: world.objectHostKey(ref.object) === hostKey ? "authoritative" : "cache",
            source_host: hostKey
          })
        );
        this.emitMetric({
          kind: "authority_slice_reconstructed",
          reason: "slice_served",
          scope: "$nowhere",
          object_count: authoritySliceObjectIds(authority).size,
          page_count: authoritySlicePageCount(authority),
          source_host: hostKey
        }, hostKey);
        return jsonResponse({ authority });
      }

      if (request.method === "POST" && pathname === "/__internal/apply-host-seed") {
        if (hostKey === WORLD_HOST) throw wooError("E_NOTAPPLICABLE", "host seed apply is only available on object hosts");
        const host = String(body.host ?? "") as ObjRef;
        if (!host) throw wooError("E_INVARG", "apply-host-seed requires host");
        if (host !== hostKey) throw wooError("E_INVARG", `host mismatch: ${host} != ${hostKey}`);
        if (!isSeedWorld(body.seed)) throw wooError("E_INVARG", "apply-host-seed requires a SeedWorld with objectHosts (spec §HS1)");
        const digest = typeof body.digest === "string" && body.digest.length > 0 ? body.digest : null;
        return jsonResponse(this.applyHostSeed(world, host, body.seed, digest));
      }

      if (request.method === "POST" && pathname === "/__internal/force-rebuild") {
        // Recovery path for a satellite whose local SQL got poisoned (e.g.,
        // by a bad host-seed merge from a stale KV value). Wipes the DO's
        // entire SQL storage and drops the in-memory world; the next /mcp
        // or other handler request triggers a normal cold-load that pulls
        // a fresh seed from WORLD via /__internal/host-seed (response body,
        // no 1MB limit) and writes it through to clean SQL. WORLD itself
        // can't be wiped this way; refuse there.
        if (hostKey === WORLD_HOST) throw wooError("E_NOTAPPLICABLE", "force-rebuild is for object hosts and gateway shards, not WORLD");
        const wipeStart = Date.now();
        try {
          await this.state.storage.deleteAll();
        } catch (err) {
          console.warn("woo.force_rebuild.deleteAll_failed", { host: hostKey, error: normalizeError(err) });
          throw err;
        }
        this.world = null;
        this.routesRegistered = false;
        this.publishedRoutes.clear();
        this.routeCache.clear();
        this.localRouteSnapshot = null;
        this.crossHostPropCache.clear();
        this.mcpGateway = null;
        return jsonResponse({ ok: true, host: hostKey, ms: Date.now() - wipeStart });
      }

      if (request.method === "POST" && pathname === "/__internal/end-session") {
        const sessionId = String(body.session_id ?? "");
        if (!sessionId) throw wooError("E_INVARG", "end-session requires session_id");
        const ended = world.endSession(sessionId);
        return jsonResponse({ ok: true, ended });
      }

      if (request.method === "POST" && pathname === "/__internal/broadcast-applied") {
        const frame = body.frame && typeof body.frame === "object" && !Array.isArray(body.frame)
          ? body.frame as AppliedFrame
          : null;
        if (!frame || frame.op !== "applied") throw wooError("E_INVARG", "broadcast-applied requires an applied frame");
        this.broadcastApplied(world, frame);
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && pathname === "/__internal/broadcast-live-events") {
        const audience = String(body.audience ?? "") as ObjRef;
        const audienceActors = Array.isArray(body.audience_actors)
          ? body.audience_actors.filter((item): item is ObjRef => typeof item === "string")
          : undefined;
          const observationAudiences = Array.isArray(body.observation_audiences)
            ? body.observation_audiences.map((audience) => (
                Array.isArray(audience) ? audience.filter((item): item is ObjRef => typeof item === "string") : []
              ))
            : undefined;
          const audienceSessions = Array.isArray(body.audience_sessions)
            ? body.audience_sessions.filter((item): item is string => typeof item === "string")
            : undefined;
          const observationSessionAudiences = Array.isArray(body.observation_session_audiences)
            ? body.observation_session_audiences.map((audience) => (
                Array.isArray(audience) ? audience.filter((item): item is string => typeof item === "string") : []
              ))
            : undefined;
        const observations = Array.isArray(body.observations)
          ? body.observations.filter((item): item is Record<string, WooValue> & { type: string } => (
              item !== null &&
              typeof item === "object" &&
              !Array.isArray(item) &&
              typeof (item as Record<string, unknown>).type === "string"
            ))
          : [];
        if (!audience) throw wooError("E_INVARG", "broadcast-live-events requires audience");
          this.broadcastLiveEvents(world, { op: "result", result: null, observations, audience, audienceActors, observationAudiences, audienceSessions, observationSessionAudiences });
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && pathname === "/__internal/replay") {
        const session = this.ensureInternalSession(
          world,
          String(body.session_id ?? ""),
          String(body.actor ?? "") as ObjRef,
          Number(body.expires_at ?? 0),
          body.token_class,
          sessionActiveScope(body),
          typeof body.apikey_id === "string" ? body.apikey_id : null,
          Number(body.started ?? 0)
        );
        const space = String(body.space ?? "") as ObjRef;
        if (!world.hasPresence(session.actor, space)) throw wooError("E_PERM", `${session.actor} is not present in ${space}`);
        const from = Math.max(1, Number(body.from ?? 1));
        const limit = Math.min(Math.max(1, Number(body.limit ?? 100)), 500);
        return jsonResponse({ op: "replay", id: body.frame_id, space, from, entries: world.replay(space, from, limit) });
      }

      if (request.method === "POST" && pathname === "/__internal/remote-get-prop") {
        const progr = String(body.progr ?? "") as ObjRef;
        const obj = String(body.obj ?? "") as ObjRef;
        const name = String(body.name ?? "");
        return jsonResponse({ value: await world.getPropChecked(progr, obj, name) });
      }

      if (request.method === "POST" && pathname === "/__internal/remote-set-prop") {
        const progr = String(body.progr ?? "") as ObjRef;
        const obj = String(body.obj ?? "") as ObjRef;
        const name = String(body.name ?? "");
        await world.setPropChecked(progr, obj, name, body.value as WooValue);
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && pathname === "/__internal/debug/session") {
        // Probe: dump the gateway shard's in-memory view of one session and
        // its actor. Used to diagnose the actor_loc=$nowhere active_scope=null
        // divergent state (see memory/divergent_session_state_race.md):
        // calling this immediately after a failed E_VERBNF surfaces whether
        // the cached actor row or the session row is the one out of sync.
        const sessionId = String(body.session_id ?? "");
        const actor = String(body.actor ?? "") as ObjRef;
        const session = sessionId ? (world as unknown as { sessions: Map<string, { actor: ObjRef; activeScope: ObjRef | null; expiresAt: number; lastDetachAt: number | null; tokenClass?: string; attachedSockets: Set<string> }> }).sessions.get(sessionId) ?? null : null;
        const actorObj = actor && world.objects.has(actor) ? world.object(actor) : null;
        const sessionAlive = sessionId ? world.sessionAlive(sessionId) : null;
        return jsonResponse({
          host_key: hostKey,
          session_id_known: !!session,
          session: session ? {
            actor: session.actor,
            activeScope: session.activeScope,
            expiresAt: session.expiresAt,
            lastDetachAt: session.lastDetachAt,
            tokenClass: session.tokenClass,
            attachedSocketCount: session.attachedSockets.size
          } : null,
          session_alive: sessionAlive,
          active_scope_for_session: world.activeScopeForSession(sessionId || null),
          actor_known: !!actorObj,
          actor: actorObj ? {
            id: actor,
            name: actorObj.name,
            parent: actorObj.parent,
            location: actorObj.location,
            modified: actorObj.modified
          } : null,
          all_sessions_for_actor: actor ? world.allLocationsForActor(actor) : null,
          now: Date.now()
        });
      }

      if (request.method === "POST" && pathname === "/__internal/object-summary") {
        const readActor = String(body.read_actor ?? "") as ObjRef;
        const obj = String(body.obj ?? "") as ObjRef;
        return jsonResponse(await world.scopedObjectSummary(readActor, obj));
      }

      if (request.method === "POST" && pathname === "/__internal/object-summaries") {
        const readActor = String(body.read_actor ?? "") as ObjRef;
        const ids = Array.isArray(body.ids) ? body.ids.filter((item): item is ObjRef => typeof item === "string") : [];
        return jsonResponse({ objects: await world.scopedObjectSummaries(readActor, ids) });
      }

      if (request.method === "POST" && pathname === "/__internal/room-snapshot") {
        const readActor = String(body.read_actor ?? "") as ObjRef;
        const room = String(body.room ?? "") as ObjRef;
        const sessionId = typeof body.session_id === "string" ? body.session_id : null;
        return jsonResponse(await world.roomSnapshotForActor(readActor, room, sessionId));
      }

      if (request.method === "POST" && pathname === "/__internal/overlay-snapshot") {
        const readActor = String(body.read_actor ?? "") as ObjRef;
        const subject = String(body.subject ?? "") as ObjRef;
        const surface = String(body.surface ?? "default");
        const sessionId = typeof body.session_id === "string" ? body.session_id : null;
        return jsonResponse(await world.overlaySnapshotForActor(readActor, subject, surface, sessionId));
      }

      if (request.method === "POST" && pathname === "/__internal/remote-describe") {
        const readActor = String(body.read_actor ?? "") as ObjRef;
        const obj = String(body.obj ?? "") as ObjRef;
        return jsonResponse({
          name: world.object(obj).name,
          description: world.propOrNullForActor(readActor, obj, "description"),
          aliases: world.propOrNullForActor(readActor, obj, "aliases"),
          owner: world.object(obj).owner,
          obvious_verbs: world.obviousCommandSyntaxes(obj, world.object(obj).name || obj)
        });
      }

      if (request.method === "POST" && pathname === "/__internal/remote-describe-many") {
        const readActor = String(body.read_actor ?? "") as ObjRef;
        const ids = Array.isArray(body.ids) ? body.ids.filter((item): item is ObjRef => typeof item === "string") : [];
        const objects: Record<ObjRef, HostObjectSummary> = {};
        for (const obj of ids) {
          try {
            objects[obj] = {
              name: world.object(obj).name,
              description: world.propOrNullForActor(readActor, obj, "description"),
              aliases: world.propOrNullForActor(readActor, obj, "aliases"),
              owner: world.object(obj).owner,
              obvious_verbs: world.obviousCommandSyntaxes(obj, world.object(obj).name || obj)
            };
          } catch {
            // A stale route should not poison the whole batch; callers can
            // fall back to id-only matching/rendering for missing entries.
          }
        }
        return jsonResponse({ objects });
      }

      if (request.method === "POST" && pathname === "/__internal/remote-resolve-verb") {
        const target = String(body.target ?? "") as ObjRef;
        const verbName = String(body.verb ?? "");
        const { verb } = world.resolveVerb(target, verbName);
        return jsonResponse({ name: verb.name, direct_callable: verb.direct_callable === true, arg_spec: verb.arg_spec ?? {} });
      }

      if (request.method === "POST" && pathname === "/__internal/remote-command-verb-candidates") {
        const target = String(body.target ?? "") as ObjRef;
        const verbName = String(body.verb ?? "");
        return jsonResponse({ candidates: world.commandVerbCandidateSummaries(target, verbName) });
      }

      if (request.method === "POST" && pathname === "/__internal/remote-is-descendant") {
        const obj = String(body.obj ?? "") as ObjRef;
        const ancestor = String(body.ancestor ?? "") as ObjRef;
        return jsonResponse({ result: world.isDescendantOf(obj, ancestor) });
      }

      if (request.method === "POST" && pathname === "/__internal/remote-is-recycled") {
        const obj = String(body.obj ?? "") as ObjRef;
        return jsonResponse({ result: world.isRecycled(obj) });
      }

      if (request.method === "POST" && pathname === "/__internal/remote-location") {
        const obj = String(body.obj ?? "") as ObjRef;
        return jsonResponse({ location: world.object(obj).location });
      }

      if (request.method === "POST" && pathname === "/__internal/remote-dispatch") {
        // Re-entrancy: if this inbound call is part of the chain we are
        // currently awaiting on the queue (typical for A→B→A dispatch
        // shapes), forward the chain id to hostDispatch. It runs inline
        // when the id matches currentTaskChainId, bypassing the
        // serial host queue. Without this the inbound queues behind
        // the A task that is still awaiting B's response → 30s
        // E_TIMEOUT, plus everything else queued behind A blocks too
        // (observed in prod tail as host_task_blocked storms during a
        // single look_at).
        const inboundChainId = request.headers.get("x-woo-task-chain") ?? undefined;
        const rawCtx = body.ctx && typeof body.ctx === "object" && !Array.isArray(body.ctx)
          ? body.ctx as Record<string, unknown>
          : {};
        const target = String(body.target ?? "") as ObjRef;
        const verb = String(body.verb ?? "");
        const args = Array.isArray(body.args) ? body.args as WooValue[] : [];
        const startAt = typeof body.start_at === "string" ? body.start_at as ObjRef : null;
        const observations: Observation[] = [];
        const actor = String(rawCtx.actor ?? "") as ObjRef;
        const player = String(rawCtx.player ?? actor) as ObjRef;
        if (actor) this.ensureInternalActor(world, actor);
        if (player) this.ensureInternalActor(world, player);
        const sessionId = typeof rawCtx.session === "string" ? rawCtx.session : null;
        if (sessionId && actor) {
          this.ensureInternalSession(
            world,
            sessionId,
            actor,
            Number(rawCtx.session_expires_at ?? 0),
            rawCtx.session_token_class,
            sessionActiveScope({
              active_scope: rawCtx.session_active_scope,
              current_location: rawCtx.session_current_location
            }),
            typeof rawCtx.session_apikey_id === "string" ? rawCtx.session_apikey_id : null,
            Number(rawCtx.session_started ?? 0)
          );
        }
        const message = rawCtx.message && typeof rawCtx.message === "object" && !Array.isArray(rawCtx.message)
          ? rawCtx.message as Message
          : { actor, target, verb, args };
        const deferredHostEffects: DeferredHostEffect[] = [];
        const ctx: CallContext = {
          world,
          space: String(rawCtx.space ?? "#-1") as ObjRef,
          seq: Number(rawCtx.seq ?? -1),
          session: sessionId,
          actor,
          player,
          caller: String(rawCtx.caller ?? "#-1") as ObjRef,
          callerPerms: String(rawCtx.callerPerms ?? rawCtx.progr ?? actor) as ObjRef,
          progr: String(rawCtx.progr ?? actor) as ObjRef,
          thisObj: String(rawCtx.thisObj ?? target) as ObjRef,
          verbName: String(rawCtx.verbName ?? verb),
          definer: String(rawCtx.definer ?? target) as ObjRef,
          message,
          observations,
          hostMemo: createHostOperationMemo(),
          movetoStack: Array.isArray(rawCtx.moveto_stack)
            ? new Set(rawCtx.moveto_stack.filter((item): item is string => typeof item === "string"))
            : undefined,
          observe: (event) => {
            observations.push({ ...event, source: event.source ?? String(rawCtx.space ?? "#-1") });
          },
          deferHostEffect: (effect) => deferredHostEffects.push(effect)
        };
        const result = await world.hostDispatch(ctx, target, verb, args, startAt, inboundChainId);
        // Compute audience here using this DO's authoritative subscribers; the
        // gateway's local view of a self-hosted space is stale and would
        // mis-filter the WS/MCP fan-out. Returned to the caller so the
        // gateway's broadcastLiveEvents has accurate audience information.
        const audiences = await world.computeDirectLiveAudiences(target, observations);
        return jsonResponse({
          result,
            observations,
            audience_actors: audiences.audienceActors,
            observation_audiences: audiences.observationAudiences,
            audience_sessions: audiences.audienceSessions,
            observation_session_audiences: audiences.observationSessionAudiences,
            deferred_host_effects: deferredHostEffects
        });
      }

      if (request.method === "POST" && pathname === "/__internal/remote-move-object") {
        const suppressMirrorHost = typeof body.suppress_mirror_host === "string" ? body.suppress_mirror_host : null;
        const result = await world.moveObjectChecked(
          String(body.obj ?? "") as ObjRef,
          String(body.target ?? "") as ObjRef,
          { suppressMirrorHost }
        );
        return jsonResponse({ ok: true, old_location: result.oldLocation, location: result.location });
      }

      if (request.method === "POST" && pathname === "/__internal/mirror-contents") {
        world.mirrorContents(
          String(body.container ?? "") as ObjRef,
          String(body.obj ?? "") as ObjRef,
          body.present === true
        );
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && pathname === "/__internal/actor-presence") {
        world.setActorPresence(
          String(body.actor ?? "") as ObjRef,
          String(body.space ?? "") as ObjRef,
          body.present === true,
          typeof body.session === "string" ? body.session : undefined
        );
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && pathname === "/__internal/space-subscriber") {
        world.setSpaceSubscriber(
          String(body.space ?? "") as ObjRef,
          String(body.actor ?? "") as ObjRef,
          body.present === true,
          typeof body.session === "string" ? body.session : undefined
        );
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && pathname === "/__internal/space-audience-sessions") {
        const actors = Array.isArray(body.actors)
          ? body.actors.filter((item): item is ObjRef => typeof item === "string")
          : undefined;
        return jsonResponse({ sessions: world.presenceSessionIdsIn(String(body.space ?? "") as ObjRef, actors) });
      }

      if (request.method === "POST" && pathname === "/__internal/actor-session-locations") {
        return jsonResponse({ locations: world.allLocationsForActor(String(body.actor ?? "") as ObjRef) });
      }

      if (request.method === "POST" && pathname === "/__internal/actor-session-locations-batch") {
        const actors = Array.isArray(body.actors)
          ? (body.actors as unknown[]).filter((item): item is ObjRef => typeof item === "string")
          : [];
        const out: Record<ObjRef, ObjRef[]> = {};
        for (const actor of actors) out[actor] = world.allLocationsForActor(actor);
        return jsonResponse({ locations: out });
      }

      if (request.method === "POST" && pathname === "/__internal/contents") {
        return jsonResponse({ contents: world.contentsOf(String(body.obj ?? "") as ObjRef) });
      }

      if (request.method === "POST" && pathname === "/__internal/enumerate-tools") {
        const actor = String(body.actor ?? "") as ObjRef;
        const requests = Array.isArray(body.requests)
          ? body.requests
            .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && typeof item.id === "string")
            .map((item) => ({
              id: item.id as ObjRef,
              projection: item.projection === "obvious" ? "obvious" as const : "tools" as const,
              expandContents: item.expandContents === true,
              contentsProjection: item.contentsProjection === "tools" ? "tools" as const : "obvious" as const
            }))
          : Array.isArray(body.ids)
          ? (body.ids as unknown[])
            .filter((id): id is string => typeof id === "string")
            .map((id) => ({ id: id as ObjRef, projection: "tools" as const, expandContents: true, contentsProjection: "obvious" as const }))
          : [];
        if (actor) this.ensureInternalActor(world, actor);
        const tools = this.getMcpGateway(world).host.enumerateLocalToolDescriptors(actor, requests);
        return jsonResponse({ tools });
      }

      return jsonResponse({ error: { code: "E_OBJNF", message: `no internal route for ${request.method} ${pathname}` } }, 404);
    } catch (err) {
      const error = normalizeError(err);
      return jsonResponse({ error }, statusForError(error));
    }
  }

  private ensureInternalSession(
    world: WooWorld,
    sessionId: string,
    actor: ObjRef,
    expiresAt: number,
    rawTokenClass: unknown,
    activeScope?: ObjRef | null,
    apikeyId?: string | null,
    started?: number
  ): Session {
    if (!sessionId || !actor) throw wooError("E_NOSESSION", "internal forwarded call requires session and actor");
    this.ensureInternalActor(world, actor);
    const tokenClass: Session["tokenClass"] = rawTokenClass === "guest" || rawTokenClass === "apikey" ? rawTokenClass : "bearer";
    const apikeyIdValue = typeof apikeyId === "string" && apikeyId.length > 0 ? apikeyId : undefined;
    return world.ensureSessionForActor(
      sessionId,
      actor,
      tokenClass,
      Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : undefined,
      activeScope,
      apikeyIdValue,
      Number.isFinite(started ?? 0) && (started ?? 0) > 0 ? started : undefined
    );
  }

  private ensureForwardedMcpSession(world: WooWorld, request: Request): void {
    const sessionId = request.headers.get("x-woo-internal-session");
    const actor = request.headers.get("x-woo-internal-actor");
    if (!sessionId || !actor) return;
    this.ensureInternalSession(
      world,
      sessionId,
      actor as ObjRef,
      Number(request.headers.get("x-woo-internal-expires-at") ?? 0),
      request.headers.get("x-woo-internal-token-class"),
      sessionActiveScope({
        active_scope: request.headers.get("x-woo-internal-active-scope"),
        current_location: request.headers.get("x-woo-internal-current-location")
      }),
      request.headers.get("x-woo-internal-apikey-id"),
      Number(request.headers.get("x-woo-internal-started") ?? 0)
    );
    const displayName = request.headers.get("x-woo-internal-display-name");
    if (displayName && world.objects.has(actor as ObjRef) && world.object(actor as ObjRef).name === actor) {
      world.object(actor as ObjRef).name = displayName;
      world.markObjectChanged(actor as ObjRef);
    }
  }

  private ensureInternalActor(world: WooWorld, actor: ObjRef): void {
    if (world.objects.has(actor)) return;
    const parent = world.objects.has("$player") ? "$player" : world.objects.has("$actor") ? "$actor" : null;
    world.createObject({ id: actor, name: actor, parent, owner: actor });
    // No explicit property writes: first-touch actor stubs only need identity
    // and ancestry for permission checks.
  }

  // ---- auth helpers (port from dev-server.ts) ----

  private authenticateToken(world: WooWorld, token: string): Session {
    if (token.startsWith("wizard:")) {
      return world.claimWizardBootstrapSession(token.slice("wizard:".length), this.env.WOO_INITIAL_WIZARD_TOKEN);
    }
    return world.auth(token);
  }

  private async registerSessionRoute(session: Session, options: { mcpShard?: string | null } = {}, world: WooWorld | null = this.world): Promise<void> {
    try {
      const id = this.env.DIRECTORY.idFromName(DIRECTORY_HOST);
      const request = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}/register-session`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          session_id: session.id,
          actor: session.actor,
          started: session.started,
          expires_at: session.expiresAt,
          token_class: session.tokenClass,
          active_scope: session.activeScope,
          current_location: session.activeScope,
          apikey_id: session.apikeyId ?? null,
          mcp_shard: options.mcpShard ?? null,
          display_name: displayNameForDirectorySession(world, session.actor),
          focus_list: focusListForDirectorySession(world, session.actor),
          actor_props: actorPropsForDirectorySession(world, session.actor)
        })
      }));
      await this.env.DIRECTORY.get(id).fetch(request);
      // Register the actor's object route at the actor's actual host,
      // not blindly at WORLD. For newly-minted guests on WORLD this
      // resolves to WORLD (unchanged), but for apikey-bound actors
      // that ARE objects with their own host (e.g. self-hosted blocks
      // like the_horoscope), the previous hard-coded WORLD_HOST
      // overwrote the correct self-host route on every plug auth —
      // see review finding "P1: Plug cold auth can overwrite the new
      // self-host route back to world."
      const actorRoute = this.world?.objectRoutes().find((route) => route.id === session.actor);
      const hostKey = this.durableHostKey();
      // Session routes are live presence and can be registered by any gateway
      // that handles the session. Object routes are authority ownership: a
      // satellite may hold only a projected actor row, so it must not republish
      // that actor as locally owned. WORLD may publish default/self-hosted actor
      // routes from its authoritative route table; a self-hosted actor may also
      // publish itself.
      if (hostKey === WORLD_HOST || actorRoute?.host === session.actor) {
        await this.registerRoutes([{ id: session.actor, host: actorRoute?.host ?? WORLD_HOST, anchor: actorRoute?.anchor ?? null }]);
      }
    } catch {
      // Directory registration accelerates cross-DO routing. The local auth
      // result remains authoritative for this host; routed object calls fail
      // closed if the Directory cannot resolve the session.
    }
  }

  private async registerMcpSessionRoute(world: WooWorld, request: Request, response: Response, mcpShard: string | null): Promise<void> {
    if (!response.ok) return;
    const sessionId = response.headers.get("mcp-session-id") ?? request.headers.get("mcp-session-id");
    if (!sessionId) return;
    const session = world.sessions.get(sessionId);
    if (session) await this.registerSessionRoute(session, { mcpShard }, world);
  }

  private async closeMcpWooSession(world: WooWorld, sessionId: string, hostKey: string): Promise<void> {
    if (!sessionId) return;
    this.deleteLocalGatewaySessionCache(sessionId);
    if (hostKey === WORLD_HOST) {
      world.endSession(sessionId);
    } else {
      // MCP shard worlds are sparse transport projections. They can drop the
      // local session row, but WORLD owns the guest object and must run the
      // authoritative guest reset that moves the actor back to $nowhere.
      world.sessions.delete(sessionId);
      await this.forwardInternalChecked<{ ok: true; ended: boolean }>(
        WORLD_HOST,
        "/__internal/end-session",
        { session_id: sessionId },
        { timeoutMs: this.hostReadRpcTimeoutMs() }
      );
    }
    await this.unregisterSessionRoute(sessionId);
  }

  private deleteLocalGatewaySessionCache(sessionId: string): void {
    try {
      const sql = this.state.storage.sql;
      sql.exec("DELETE FROM gateway_projection_session WHERE session_id = ?", sessionId);
      sql.exec("DELETE FROM gateway_session_tool_manifest WHERE session_id = ?", sessionId);
    } catch {
      // These tables exist on current deployments but are cache-only. Session
      // lifecycle cleanup must not fail because an old shard has not migrated a
      // cache table yet.
    }
  }

  private async unregisterSessionRoute(sessionId: string): Promise<void> {
    try {
      const id = this.env.DIRECTORY.idFromName(DIRECTORY_HOST);
      const request = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}/unregister-session`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ session_id: sessionId })
      }));
      await this.env.DIRECTORY.get(id).fetch(request);
    } catch {
      // Local session deletion is authoritative; stale Directory routes expire
      // closed on their normal TTL if best-effort cleanup misses.
    }
  }

  private async unregisterApiKeySessionRoutes(apikeyId: string): Promise<void> {
    if (!apikeyId) return;
    try {
      const id = this.env.DIRECTORY.idFromName(DIRECTORY_HOST);
      const request = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}/unregister-apikey-sessions`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ apikey_id: apikeyId })
      }));
      await this.env.DIRECTORY.get(id).fetch(request);
    } catch {
      // Revocation is authoritative in the gateway world. Directory cleanup
      // prevents stale routed REST sessions from being resurrected through
      // x-woo-internal-session before the normal expiry window.
    }
  }

  private async purgeExpiredDirectorySessions(): Promise<number> {
    try {
      const id = this.env.DIRECTORY.idFromName(DIRECTORY_HOST);
      const request = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}/purge-expired-sessions`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: "{}"
      }));
      const response = await this.env.DIRECTORY.get(id).fetch(request);
      if (!response.ok) return 0;
      const body = await response.json().catch(() => null) as { removed?: unknown } | null;
      return Number(body?.removed ?? 0);
    } catch {
      return 0;
    }
  }

  private closeLocalApiKeySessions(world: WooWorld, apikeyId: string): void {
    for (const session of [...world.sessions.values()]) {
      if (session.apikeyId === apikeyId) world.endSession(session.id);
    }
  }

  private revokedApiKeyIds(world: WooWorld): Set<string> {
    const raw = world.propOrNull("$system", "api_keys");
    const out = new Set<string>();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    for (const [id, record] of Object.entries(raw as Record<string, WooValue>)) {
      if (record && typeof record === "object" && !Array.isArray(record) && (record as Record<string, WooValue>).revoked_at != null) {
        out.add(id);
      }
    }
    return out;
  }

  private async cleanupNewlyRevokedApiKeys(world: WooWorld, revokedBefore: Set<string>): Promise<void> {
    for (const id of this.revokedApiKeyIds(world)) {
      if (revokedBefore.has(id)) continue;
      this.closeLocalApiKeySessions(world, id);
      await this.unregisterApiKeySessionRoutes(id);
    }
  }

  // Adapter for gateway-side apply (full housekeeping: api-key revocation
  // diff + per-session route mirroring). Used only by the in-process REST turn
  // fallback (`restV2TurnInProcess`, when there is no CommitScopeDO binding);
  // the normal REST/MCP/WS reply paths maintain the gateway projection cache
  // from the accepted commit's projection delta instead of a mirror WooWorld.
  private buildGatewayApplyTarget(world: WooWorld): ShadowApplyTarget {
    return {
      applyTranscript: (transcript) => {
        world.applyCommittedShadowTranscript(transcript, {});
      },
      revokedApiKeyIdsBefore: () => this.revokedApiKeyIds(world),
      cleanupRevokedApiKeys: (revokedBefore) => this.cleanupNewlyRevokedApiKeys(world, revokedBefore),
      sessionHousekeeping: async (sessionId, result) => {
        const session = world.sessions.get(sessionId);
        if (!session) return;
        this.mirrorResultRoomToSession(world, session, result);
        await this.registerSessionRoute(session, {}, world);
      }
    };
  }

  // Adapter for host-side apply (write-through to a specific host slice or
  // satellite fanout target). No session housekeeping — the originating
  // gateway already did that for the session before fanning out.
  private buildHostApplyTarget(world: WooWorld, hostKey: string): ShadowApplyTarget {
    return {
      applyTranscript: (transcript) => {
        world.applyCommittedShadowTranscriptToHost(hostKey, transcript, { gatewayHost: hostKey === WORLD_HOST });
      }
    };
  }

  private requireRestSession(world: WooWorld, request: Request): Session {
    const internalSession = request.headers.get("x-woo-internal-session");
    const internalActor = request.headers.get("x-woo-internal-actor");
    if (internalSession && internalActor) {
      return this.ensureInternalSession(
        world,
        internalSession,
        internalActor as ObjRef,
        Number(request.headers.get("x-woo-internal-expires-at") ?? 0),
        request.headers.get("x-woo-internal-token-class"),
        sessionActiveScopeFromRecord({
          active_scope: request.headers.get("x-woo-internal-active-scope"),
          current_location: request.headers.get("x-woo-internal-current-location")
        }) as ObjRef | null,
        request.headers.get("x-woo-internal-apikey-id"),
        Number(request.headers.get("x-woo-internal-started") ?? 0)
      );
    }
    const header = request.headers.get("authorization") ?? "";
    const match = /^Session\s+(.+)$/i.exec(header.trim());
    if (!match) throw wooError("E_NOSESSION", "Authorization: Session <id> required");
    return world.auth(`session:${match[1]}`);
  }

  private resolveRestObject(world: WooWorld, id: string, session: Session): ObjRef {
    if (id === "$me") return session.actor;
    world.object(id);
    return id;
  }

  private resolveRestActor(world: WooWorld, request: Request, actorValue: unknown, session: Session): ObjRef {
    const impersonated = request.headers.get("x-woo-impersonate-actor");
    const requested = typeof impersonated === "string"
      ? impersonated
      : actorValue === undefined || actorValue === null || actorValue === "$me"
        ? session.actor
        : String(actorValue);
    if (requested === session.actor) return requested;
    if (world.object(session.actor).flags.wizard) {
      world.object(requested);
      world.recordWizardAction(session.actor, "impersonate", {
        actor: requested,
        via: typeof impersonated === "string" ? "REST X-Woo-Impersonate-Actor" : "REST actor field"
      });
      return requested;
    }
    throw wooError("E_PERM", "actor does not match session actor", { actor: requested, session_actor: session.actor });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const world = await this.getWorld();
    const existing = this.attachment(ws);
    if (existing?.protocol === "v2-turn-network") {
      await this.webSocketV2TurnNetworkMessage(world, ws, message);
      return;
    }
    ws.close(1002, "unsupported WebSocket protocol");
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, wasClean: boolean): Promise<void> {
    const startedAt = Date.now();
    const world = await this.getWorld();
    const att = this.attachment(ws);
    if (att) {
      world.detachSocket(att.sessionId, att.socketId);
      this.indexRemoveSocket(att.sessionId, att.actor, ws);
    }
    try {
      ws.close();
    } catch {
      // ignore — already closed
    }
    if (att?.protocol === "v2-turn-network") {
      this.emitMetric({
        kind: "v2_ws_close",
        scope: att.scope,
        node: att.node,
        actor: att.actor,
        code,
        clean: wasClean,
        reason: `close:${code}`,
        ms: Date.now() - (att.openedAt ?? startedAt),
        status: "ok"
      }, this.durableHostKey());
    }
  }

  async webSocketError(ws: WebSocket, err: unknown): Promise<void> {
    const startedAt = Date.now();
    const world = await this.getWorld();
    const att = this.attachment(ws);
    if (att) {
      world.detachSocket(att.sessionId, att.socketId);
      this.indexRemoveSocket(att.sessionId, att.actor, ws);
    }
    if (att?.protocol === "v2-turn-network") {
      this.emitMetric({
        kind: "v2_ws_error",
        scope: att.scope,
        node: att.node,
        actor: att.actor,
        ms: Date.now() - startedAt,
        status: "error",
        ...metricErrorFields(err)
      }, this.durableHostKey());
    }
  }

  private async acceptV2TurnNetworkWebSocket(request: Request, world: WooWorld): Promise<Response> {
    const startedAt = Date.now();
    const metricStartedAt = metricNow();
    // Public deployments rely on Cloudflare's TLS termination and route this as
    // wss://; plaintext ws:// is only acceptable for localhost development per
    // VTN19.
    const upgrade = request.headers.get("upgrade");
    if (upgrade?.toLowerCase() !== "websocket") {
      return this.rejectV2TurnNetworkWebSocket({ code: "E_INVARG", message: "expected Upgrade: websocket" }, 400, startedAt);
    }
    if (!webSocketProtocols(request).includes("woo-v2.turn-network.json")) {
      return this.rejectV2TurnNetworkWebSocket({ code: "E_PROTOCOL", message: "missing Sec-WebSocket-Protocol: woo-v2.turn-network.json" }, 400, startedAt);
    }
    const url = new URL(request.url);
    const token = url.searchParams.get("token") ?? "";
    const node = url.searchParams.get("node") || `browser:${crypto.randomUUID()}`;
    const scope = (url.searchParams.get("scope") || "") as ObjRef;
    const lastKnownHead = parseShadowScopeHeadJson(url.searchParams.get("last_known_head"));
    const executableSeedDigest = url.searchParams.get("executable_seed_digest") || undefined;
    if (!token) {
      return this.rejectV2TurnNetworkWebSocket({ code: "E_NOSESSION", message: "token query parameter is required" }, 401, startedAt, scope, node);
    }
    let session: Session;
    try {
      session = this.authenticateToken(world, token);
    } catch (err) {
      this.emitMetric({
        kind: "v2_ws_reject",
        scope: scope || undefined,
        node,
        ms: Date.now() - startedAt,
        status: "error",
        ...metricErrorFields(err)
      }, this.durableHostKey());
      throw err;
    }
    const commitScope = scope || session.actor;
    const socketId = `v2-${session.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    world.attachSocket(session.id, socketId);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({
      protocol: "v2-turn-network",
      sessionId: session.id,
      actor: session.actor,
      socketId,
      node,
      scope: commitScope,
      token,
      openedAt: startedAt
    });
    this.state.acceptWebSocket(server);
    this.indexAddSocket(session.id, session.actor, server);
    try {
      const seedObjectIds = [commitScope, session.actor];
      let phaseStartedAt = metricNow();
      const authority = await this.v2GatewayAuthorityPayload(world, seedObjectIds, { reconstructionReason: "cold_open", reconstructionScope: commitScope });
      this.emitV2OpenStep("gateway_authority", phaseStartedAt, { scope: commitScope, node, actor: session.actor, count: seedObjectIds.length });
      phaseStartedAt = metricNow();
      const openBody = {
        scope: commitScope,
        node,
        token,
        session: session.id,
        actor: session.actor,
        ...(this.browserProjectionHolderEnabled() ? { receiver_profile: "browser" as const } : {}),
        ...authority,
        ...(lastKnownHead ? { last_known_head: lastKnownHead } : {}),
        ...(executableSeedDigest ? { executable_seed_digest: executableSeedDigest } : {})
      };
      const opened = await this.v2CommitScopeOpen(
        world,
        commitScope,
        this.browserCheckpointTailOpenEnabled() ? this.withCheckpointTailOpen(openBody) : openBody,
        seedObjectIds
      );
      this.emitV2OpenStep("gateway_commit_scope_open", phaseStartedAt, { scope: commitScope, node, actor: session.actor });
      const hello = opened.hello;
      phaseStartedAt = metricNow();
      const helloEnvelope = encodeEnvelope({
        v: 2,
        type: hello.kind,
        id: `${this.durableHostKey()}:hello:${Date.now()}`,
        from: opened.relay,
        to: node,
        actor: session.actor,
        session: session.id,
        auth: { mode: "session", token },
        body: hello
      } satisfies ShadowEnvelope<typeof hello>);
      server.send(helloEnvelope);
      this.emitV2OpenStep("gateway_send_hello", phaseStartedAt, { scope: commitScope, node, actor: session.actor, bytes: helloEnvelope.length });
      if (isCheckpointTailOpenResponse(opened)) {
        await this.sendCheckpointTailOpenTransfer(server, opened, {
          token,
          node,
          actor: session.actor,
          sessionId: session.id,
          scope: commitScope,
          openBody: this.withCheckpointTailOpen(openBody)
        });
        this.updateV2SocketStateHead(server, opened.head);
        this.emitV2OpenStep("gateway_send_ads", metricNow(), { scope: commitScope, node, actor: session.actor, bytes: 0, count: 0 });
      } else {
      const transfer = opened.transfer;
      phaseStartedAt = metricNow();
      const transferEnvelope = encodeEnvelope({
        v: 2,
        type: transfer.kind,
        id: `${this.durableHostKey()}:state:${crypto.randomUUID()}`,
        from: opened.relay,
        to: node,
        actor: session.actor,
        session: session.id,
        auth: { mode: "session", token },
        body: transfer
      } satisfies ShadowEnvelope<typeof transfer>);
      server.send(transferEnvelope);
      this.emitV2OpenStep("gateway_send_display_transfer", phaseStartedAt, { scope: commitScope, node, actor: session.actor, bytes: transferEnvelope.length });
      if ("to" in transfer) this.updateV2SocketStateHead(server, transfer.to);
      const executableTransfer = opened.executable_transfer;
      if (executableTransfer) {
        phaseStartedAt = metricNow();
        const executableEnvelope = encodeEnvelope({
          v: 2,
          type: executableTransfer.kind,
          id: `${this.durableHostKey()}:exec-state:${crypto.randomUUID()}`,
          from: opened.relay,
          to: node,
          actor: session.actor,
          session: session.id,
          auth: { mode: "session", token },
          body: executableTransfer
        } satisfies ShadowEnvelope<typeof executableTransfer>);
        server.send(executableEnvelope);
        this.emitV2OpenStep("gateway_send_executable_transfer", phaseStartedAt, { scope: commitScope, node, actor: session.actor, bytes: executableEnvelope.length });
      }
      phaseStartedAt = metricNow();
      let adBytes = 0;
      for (const ad of opened.ads ?? []) {
        const adEnvelope = encodeEnvelope({
          v: 2,
          type: ad.kind,
          id: `${this.durableHostKey()}:exec-ad:${crypto.randomUUID()}`,
          from: opened.relay,
          to: node,
          actor: session.actor,
          session: session.id,
          auth: { mode: "anonymous_advisory" },
          body: ad
        } satisfies ShadowEnvelope<typeof ad>);
        adBytes += adEnvelope.length;
        server.send(adEnvelope);
      }
      this.emitV2OpenStep("gateway_send_ads", phaseStartedAt, { scope: commitScope, node, actor: session.actor, bytes: adBytes, count: opened.ads?.length ?? 0 });
      }
    } catch (err) {
      world.detachSocket(session.id, socketId);
      this.indexRemoveSocket(session.id, session.actor, server);
      try {
        server.close(1011, "v2 open failed");
      } catch {
        // ignore cleanup failure; the fetch error remains the signal
      }
      this.emitMetric({
        kind: "v2_ws_reject",
        scope: commitScope,
        node,
        ms: Date.now() - startedAt,
        status: "error",
        ...metricErrorFields(err)
      }, this.durableHostKey());
      throw err;
    }

    this.emitMetric({
      kind: "v2_ws_open",
      scope: commitScope,
      node,
      actor: session.actor,
      ms: metricElapsed(metricStartedAt),
      status: "ok"
    }, this.durableHostKey());

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": "woo-v2.turn-network.json" }
    });
  }

  private rejectV2TurnNetworkWebSocket(error: { code: string; message: string }, status: number, startedAt: number, scope?: ObjRef, node?: string): Response {
    this.emitMetric({
      kind: "v2_ws_reject",
      ...(scope ? { scope } : {}),
      ...(node ? { node } : {}),
      ms: Date.now() - startedAt,
      status: "error",
      error: error.code
    }, this.durableHostKey());
    return jsonResponse({ error }, status);
  }

  private async webSocketV2TurnNetworkMessage(world: WooWorld, ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = this.attachment(ws);
    if (!att?.node || !att.token) {
      ws.close(1008, "missing v2 attachment");
      return;
    }
    const encoded = typeof message === "string" ? message : new TextDecoder().decode(message);
    try {
      const authorityIds = v2SocketEnvelopeAuthorityObjectIds(encoded, att.scope, att.actor);
      const result = await this.v2CommitScopePost<CommitScopeEnvelopeResponse>(att.scope, "/v2/envelope", {
        ...executorAuthorityPayload(world, authorityIds),
        scope: att.scope,
        node: att.node,
        token: att.token,
        session: att.sessionId,
        actor: att.actor,
        ...(this.browserProjectionHolderEnabled() ? { receiver_profile: "browser" as const } : {}),
        envelope: encoded
      });
      await this.deliverV2Fanout(world, att.scope, result, att.sessionId, att.node);
      await this.applyV2CommittedTranscript(world, result.reply, att.sessionId);
      const receiverReply = result.receiver_reply ?? result.reply;
      if (receiverReply) ws.send(receiverReply);
    } catch (err) {
      ws.send(encodeEnvelope(buildTransportErrorEnvelope({
        id: `${this.durableHostKey()}:error:${Date.now()}`,
        from: this.durableHostKey(),
        to: att.node,
        actor: att.actor,
        session: att.sessionId,
        auth: { mode: "session", token: att.token },
        code: "E_PROTOCOL",
        message: errorMessage(err)
      })));
    }
  }

  private async v2CommitScopePost<T>(scope: ObjRef, path: "/v2/open" | "/v2/envelope" | "/v2/state-transfer", body: Record<string, unknown>): Promise<T> {
    if (!this.env.COMMIT_SCOPE) throw wooError("E_NOT_IMPLEMENTED", "COMMIT_SCOPE binding is required for v2 turn network");
    const id = this.env.COMMIT_SCOPE.idFromName(String(scope));
    const request = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-woo-host-key": `commit-scope:${scope}`
      },
      body: JSON.stringify(body)
    }));
    const response = await this.env.COMMIT_SCOPE.get(id).fetch(request);
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      throw commitScopeErrorFromPayload(payload) ?? wooError("E_INTERNAL", `CommitScopeDO ${path} failed`, payload as WooValue);
    }
    return payload as T;
  }

  private async sendCheckpointTailOpenTransfer(
    server: WebSocket,
    opened: CommitScopeCheckpointTailOpenResponse,
    input: { token: string; node: string; actor: ObjRef; sessionId: string; scope: ObjRef; openBody: Record<string, unknown> }
  ): Promise<void> {
    let current = opened;
    for (let chunk = 0; chunk < 256; chunk += 1) {
      const phaseStartedAt = metricNow();
      const body: CheckpointTailOpenTransfer = {
        kind: "woo.open.checkpoint_tail.v1",
        scope: input.scope,
        head: current.head,
        transfer: current.transfer as CheckpointTailOpenTransfer["transfer"],
        viewer: { actor: input.actor, session: input.sessionId }
      };
      const envelope = encodeEnvelope({
        v: 2,
        type: body.kind,
        id: `${this.durableHostKey()}:checkpoint-tail:${crypto.randomUUID()}`,
        from: current.relay,
        to: input.node,
        actor: input.actor,
        session: input.sessionId,
        auth: { mode: "session", token: input.token },
        body
      } satisfies ShadowEnvelope<CheckpointTailOpenTransfer>);
      server.send(envelope);
      this.emitV2OpenStep("gateway_send_checkpoint_tail_transfer", phaseStartedAt, {
        scope: input.scope,
        node: input.node,
        actor: input.actor,
        bytes: envelope.length,
        transfer_mode: current.transfer.kind,
        count: current.transfer.kind === "frames" ? current.transfer.frames.length : current.transfer.checkpoint.pages.length,
        ...(current.transfer.continuation ? { continuation: true } : {})
      });
      const continuation = current.transfer.continuation;
      if (!continuation) return;
      current = await this.v2CommitScopePost<CommitScopeCheckpointTailOpenResponse>(input.scope, "/v2/open", {
        ...input.openBody,
        open_protocol: "checkpoint_tail.v1",
        continuation
      });
    }
    throw wooError("E_CHECKPOINT_CONTINUATION_LOOP", "checkpoint/tail continuation did not terminate within the gateway safety cap");
  }

  private async v2CommitScopeOpen(
    world: WooWorld,
    scope: ObjRef,
    body: Record<string, unknown>,
    seedObjectIds: Iterable<ObjRef>,
    seed?: { serialized: SerializedWorld; authority: ReturnType<typeof executorAuthorityPayload> }
  ): Promise<CommitScopeOpenResponse> {
    try {
      return await this.v2CommitScopePost<CommitScopeOpenResponse>(scope, "/v2/open", body);
    } catch (err) {
      if (Object.prototype.hasOwnProperty.call(body, "open_protocol") && isCommitScopeCheckpointPendingError(err)) {
        return await this.v2CommitScopePost<CommitScopeOpenResponse>(scope, "/v2/open", this.withoutCheckpointTailOpen(body));
      }
      if (!isCommitScopeSnapshotRequiredError(err) || Object.prototype.hasOwnProperty.call(body, "serialized")) throw err;
      const seeded = seed ?? await this.v2GatewayState(world, seedObjectIds);
      return await this.v2CommitScopePost<CommitScopeOpenResponse>(scope, "/v2/open", {
        ...body,
        ...seeded.authority,
        serialized: seeded.serialized
      });
    }
  }

  private async ensureRestV2Relay(
    world: WooWorld,
    input: Parameters<NonNullable<RestProtocolHost["executeTurn"]>>[0],
    scope: ObjRef,
    token: string,
    forceReopen = false
  ): Promise<RestV2RelayClient> {
    if (forceReopen) this.restV2Relays.delete(scope);
    let client = this.restV2Relays.get(scope);
    const seedObjectIds = executorAuthorityObjectIds({
      scope: input.scope,
      target: input.target,
      actor: input.actor,
      args: input.args,
      body: input.body
    }, scope);
    const seeded = await this.v2GatewayState(world, seedObjectIds);
    if (!client) {
      client = {
        scope,
        node: `${this.durableHostKey()}:rest:${scope}`,
        relay: createShadowBrowserRelayShim({
          node: `${this.durableHostKey()}:rest-relay:${scope}`,
          scope,
          serialized: seeded.serialized,
          // Authority-derived seed: carry the slice's real per-cell provenance so a
          // first-open turn that plans before mergeRestPlanningAuthority still sees
          // tagged cells (not flattened to cache).
          seedCellProvenance: cellProvenanceFromAuthoritySlice(seeded.authority.authority)
        }),
        openedAt: Date.now(),
        nextTurn: 0
      };
      if (this.restExecutionCapsuleEnabled() && !forceReopen) {
        this.rememberRestV2Relay(scope, client);
        return client;
      }
      const opened = await this.v2CommitScopeOpen(world, scope, {
        ...seeded.authority,
        scope,
        node: client.node,
        token,
        session: input.session.id,
        actor: input.actor
      }, seedObjectIds, seeded);
      if (opened.head) client.relay.commit_scope.head = opened.head;
      this.rememberRestV2Relay(scope, client);
      return client;
    }
    this.rememberRestV2Relay(scope, client);
    this.mergeRestPlanningAuthority(world, client, seeded.authority.authority);
    return client;
  }

  private restExecutionCapsuleEnabled(): boolean {
    return envFlag(this.env.WOO_V2_EXECUTION_CAPSULE);
  }

  private withRestExecutionCapsule(
    client: RestV2RelayClient | undefined,
    body: ExecutorEnvelopeBody,
    target: ObjRef,
    verb: string
  ): ExecutorEnvelopeBody {
    if (body.planned_transcript_commit === true) return body;
    if (!this.restExecutionCapsuleEnabled() || !client) return body;
    return {
      ...body,
      execution_capsule: buildExecutionCapsule({
        scope: body.scope,
        head: client.relay.commit_scope.head,
        actor: body.actor,
        session: body.session,
        target,
        verb,
        authority: body.authority
      })
    };
  }

  private mergeRestPlanningAuthority(
    world: WooWorld,
    client: RestV2RelayClient,
    authority: SerializedAuthoritySlice
  ): void {
    // Shared holder-neutral merge, mirroring the MCP gateway's
    // mergeV2AuthorityIntoScopeClient exactly: provenance-aware precedence +
    // stub-repair apply (so the admission gate can enforce on this sparse path),
    // session-actor live-cell preservation, and the generation bump that
    // invalidates stale seed caches.
    mergeAuthorityIntoRelayCache(client.relay, authority, {
      preserveSessionActorLive: true,
      clone: true,
      reason: "rest_planning_authority_merge",
      metric: (event) => world.recordMetric(event)
    });
  }

  private async v2GatewayState(world: WooWorld, extraObjectIds: Iterable<ObjRef>): Promise<{ serialized: SerializedWorld; authority: ReturnType<typeof executorAuthorityPayload> }> {
    const ids = Array.from(extraObjectIds);
    const authority = await this.v2GatewayAuthorityPayload(world, ids, { reconstructionReason: "cold_open", reconstructionScope: ids[0] ?? "$nowhere" });
    const serialized = serializedWorldFromAuthoritySlice(authority.authority);
    return { serialized, authority };
  }

  private authorityPayloadFromCachedAuthority(
    world: WooWorld,
    reconstructionScope: ObjRef,
    authority: SerializedAuthoritySlice,
    directoryScopeSessions: readonly DirectorySerializedSession[],
    reason: AuthorityReconstructionReason
  ): ExecutorAuthorityPayload {
    const sessionActors = new Set<ObjRef>(
      authority.sessions
        .map((session) => session.actor)
        .filter((actor) => world.objects.has(actor))
    );
    const slices: SerializedAuthoritySlice[] = [authority];
    if (sessionActors.size > 0) {
      const localActorLive = mcpGatewayLocalActorLiveCellSlice(world, sessionActors, this.durableHostKey());
      if (authoritySlicePageCount(localActorLive) > 0) slices.push(localActorLive);
    }
    if (directoryScopeSessions.length > 0) slices.push(mcpGatewayDirectorySessionCellSlice(directoryScopeSessions, this.durableHostKey()));
    let mergedAuthority: SerializedAuthoritySlice;
    if (slices.length > 1) {
      mergedAuthority = combineSerializedAuthoritySlices(mergeSerializedSessions(authority.sessions, directoryScopeSessions), slices);
    } else if (directoryScopeSessions.length > 0) {
      mergedAuthority = { ...authority, sessions: mergeSerializedSessions(authority.sessions, directoryScopeSessions) };
    } else {
      mergedAuthority = authority;
    }
    const authorityObjectIds = authoritySliceObjectIds(mergedAuthority);
    const authoritySessions = mergedAuthority.sessions.filter((session) => authorityObjectIds.has(session.actor));
    const filteredAuthority: SerializedAuthoritySlice = mergedAuthority.sessions.length === authoritySessions.length
      ? mergedAuthority
      : { ...mergedAuthority, sessions: authoritySessions };
    world.recordMetric({
      kind: "authority_slice_reconstructed",
      reason,
      scope: reconstructionScope,
      object_count: authoritySliceObjectIds(filteredAuthority).size,
      page_count: authoritySlicePageCount(filteredAuthority),
      source_host: this.durableHostKey()
    });
    return {
      sessions: filteredAuthority.sessions,
      session_objects: [],
      authority: filteredAuthority
    };
  }

  private async filterRemoteAuthoritySliceForGateway(
    authority: SerializedAuthoritySlice,
    host: string,
    localObjectIds: ReadonlySet<ObjRef>,
    localActorAuthorityRoots: ReadonlySet<ObjRef>,
    resolveHost: (id: ObjRef, fallbackHost: string) => Promise<string>
  ): Promise<SerializedAuthoritySlice> {
    const rejectLocalActorLive = (ref: { object: ObjRef; page: string }): boolean =>
      localActorAuthorityRoots.has(ref.object) && ref.page === "object_live";
    // A3: provenance is now load-bearing. Every authority cell slice page carries
    // a `source` (the builder requires it). The gateway TRUSTS a page as authority
    // only when it is the owner's authoritative row from the responding host;
    // every other source (cache/projection/fallback/gossip) is support material
    // that may fill a gap but MUST NOT override a locally-preserved row. This is
    // the typed refusal that replaces the old "if any ref happens to carry
    // provenance" optimization: a non-authoritative page can never masquerade as
    // authority for an id the gateway already holds.
    if (isAuthorityCellSlice(authority)) {
      return filterSerializedAuthoritySlicePages(authority, (ref) => {
        if (rejectLocalActorLive(ref)) return false;
        const ownerSourced = ref.source === "authoritative" && ref.source_host === host;
        if (ownerSourced) return true;
        // Not owner-authoritative: admit only to fill a gap the gateway lacks
        // locally; never to overwrite a local/owner row.
        return !localObjectIds.has(ref.object);
      });
    }
    const accepted = new Set<ObjRef>();
    const responseObjectIds = Array.from(authoritySliceObjectIds(authority));
    const objectHosts = await Promise.all(responseObjectIds.map(
      async (id) => [id, await resolveHost(id, WORLD_HOST)] as const
    ));
    for (const [id, objectHost] of objectHosts) {
      if (objectHost === host || !localObjectIds.has(id)) accepted.add(id);
    }
    return filterSerializedAuthoritySlicePages(authority, (ref) =>
      accepted.has(ref.object) && !rejectLocalActorLive(ref)
    );
  }

  private async v2GatewayAuthorityPayload(
    world: WooWorld,
    extraObjectIds: Iterable<ObjRef>,
    options: {
      tolerateRemoteFailures?: boolean;
      useCommitScopeSnapshotForRemoteAuthority?: boolean;
      directorySessionScopes?: readonly ObjRef[];
      scopeContentExpansionRoots?: readonly ObjRef[];
      reconstructionReason?: AuthorityReconstructionReason;
      reconstructionScope?: ObjRef;
    } = {}
  ): Promise<ReturnType<typeof executorAuthorityPayload>> {
    // `tolerateRemoteFailures: true` allows the per-envelope refresh path to
    // omit slices for cold/unreachable remote hosts and rely on the
    // CommitScopeDO's existing durable snapshot. It must NOT be set on the
    // first-open seeding path: a missing remote slice would let the
    // satellite persist an incomplete seed (no recovery on subsequent
    // warm opens). Open paths instead let the timeout propagate so the
    // caller fails loudly and the client retries against a warm satellite.
    const ids = Array.from(new Set(Array.from(extraObjectIds).filter((id): id is ObjRef => typeof id === "string" && id.length > 0)));
    const directorySessionScopes = options.directorySessionScopes ?? [];
    const reconstructionReason = options.reconstructionReason ?? (options.tolerateRemoteFailures || options.useCommitScopeSnapshotForRemoteAuthority ? "warm_turn_refresh" : "cold_open");
    const reconstructionScope = options.reconstructionScope ?? ids[0] ?? "$nowhere";
    const localHost = this.durableHostKey();
    const mcpGatewayShard = isMcpGatewayShardHost(localHost);
    const directoryScopeSessions = mcpGatewayShard && directorySessionScopes.length > 0
      ? await this.loadDirectorySessionsForScopes(directorySessionScopes)
      : [];
    // A5: the in-memory per-scope authority checkpoint is removed. A warm turn
    // reconstructs from local rows + owner slices (the authoritative path); the
    // durable gateway projection cache remains the cross-turn read model. The
    // checkpoint was a second, divergent materialization of the projection cache
    // (its own apply path was the CI hazard removed in applyGatewayProjectionWrites)
    // and prod measurement showed it was not delivering warm hits. A read-through
    // over the projection cache to restore warm-hit latency is a separate,
    // deploy-measured step; correctness here rests on full reconstruction.
    const requestedIds = ids;
    const localActorAuthorityRoots = localActorAuthorityRootIds(world, requestedIds, { sessionActorsOnly: mcpGatewayShard });
    const local = mcpGatewayShard
      ? mcpGatewayLocalAuthorityPayload(world, requestedIds, localActorAuthorityRoots)
      : executorAuthorityPayload(world, requestedIds);
    const localObjectIds = authoritySliceObjectIds(local.authority);
    const preservedObjectIds = new Set<ObjRef>(localObjectIds);
    const routesById = isMcpGatewayShardHost(localHost)
      ? new Map<ObjRef, { id: ObjRef; host: string; anchor: ObjRef | null }>()
      : new Map(world.objectRoutes().map((route) => [route.id, route] as const));
    const resolveHost = async (id: ObjRef, fallbackHost: string): Promise<string> => {
      const localRoute = routesById.get(id) ?? null;
      if (localRoute) {
        // This is classification for an authority payload, not route
        // publication. A satellite can hold projected rows for foreign objects;
        // those rows participate in objectRoutes(), but they are not proof that
        // the satellite owns the object's authority. Directory is the route
        // authority here; the local route is only a fallback if Directory is not
        // reachable.
        const directoryHost = await this.fetchDirectoryObjectHost(id, localRoute.host || WORLD_HOST);
        const host = directoryHost || localRoute.host;
        if (host) this.routeCache.set(id, host);
        return host;
      }
      const cached = this.routeCache.get(id);
      if (cached && (!mcpGatewayShard || cached !== WORLD_HOST)) return cached;
      if (mcpGatewayShard) {
        if (id.startsWith("$")) {
          // Sparse MCP shards do not publish every bootstrap/catalog support
          // object they may inherit from during guarded repair. These `$`
          // rows are the small universal support graph, so falling back to the
          // world host is the right repair path; the non-$ branch below keeps
          // arbitrary instance misses from waking the singleton speculatively.
          const directoryHost = await this.fetchDirectoryObjectHost(id, WORLD_HOST);
          const host = directoryHost || WORLD_HOST;
          this.routeCache.set(id, host);
          return host;
        }
        // Sparse MCP shards can carry a stale `id -> world` cache entry from an
        // earlier fallback route. For authority refresh, Directory is the
        // routing authority: an unresolved non-$ id should use the local
        // last-known row, not wake the world singleton as a guessed owner.
        const directoryHost = await this.fetchDirectoryObjectHost(id, "");
        if (directoryHost) {
          this.routeCache.set(id, directoryHost);
          return directoryHost;
        }
        return "";
      }
      return await this.resolveObjectHostForWorld(null, id, fallbackHost);
    };

    const resolvedIds = await Promise.all(requestedIds.map(async (id) => [id, await resolveHost(id, WORLD_HOST)] as const));
    const byHost = new Map<string, Set<ObjRef>>();
    for (const [id, host] of resolvedIds) {
      if (!host || host === localHost) continue;
      const list = byHost.get(host) ?? new Set<ObjRef>();
      list.add(id);
      byHost.set(host, list);
    }
    // Remote authority-slice fetches can time out on cold satellites. Per-turn
    // refreshes already have a CommitScopeDO snapshot behind them, but relying
    // only on that snapshot turns cold-owner misses into hard E_OBJNF when the
    // snapshot lacks a transitive row (for example an exit destination reached
    // from a room's `exits` map). Keep the gateway's last-known local rows as a
    // stale fallback; if they are out of date, the transcript's cell-version
    // validation rejects the write with a normal retryable mismatch.
    const remoteSlices: Array<{ host: string; response: { authority: SerializedAuthoritySlice } | null; error: { code: string } | null }> = [];
    let staleFallbackCount = 0;
    if (options.useCommitScopeSnapshotForRemoteAuthority) {
      // MCP per-envelope refresh happens only after ensureV2ScopeSessionOpen has
      // established the CommitScopeDO's durable planning snapshot. Re-waking
      // every remote owner here reintroduces the cold-open fanout that the
      // snapshot is meant to avoid; send the local stale rows instead and let
      // commit validation arbitrate freshness.
      for (const [host, objects] of byHost) {
        world.recordMetric({
          kind: "authority_slice_stale_fallback",
          host,
          object_count: objects.size,
          reason: "snapshot_fallback"
        });
        staleFallbackCount += 1;
        remoteSlices.push({ host, response: null, error: null });
      }
    } else {
      remoteSlices.push(...await Promise.all(Array.from(byHost, async ([host, objects]) => {
        try {
          const response = await this.forwardInternalReadChecked<{ authority: SerializedAuthoritySlice }>(
            host,
            "/__internal/authority-slice",
            { objects: Array.from(objects) }
          );
          return { host, response, error: null as { code: string } | null };
        } catch (err) {
          const error = normalizeError(err);
          // Only swallow read-deadline timeouts (E_TIMEOUT) and only when the
          // caller declared this is a refresh path (durable snapshot exists).
          // Other errors (auth, signature, unreachable) always propagate;
          // first-open seeding paths likewise propagate so cold-cold misses
          // fail loudly instead of persisting a partial seed.
          if (error.code === "E_TIMEOUT" && options.tolerateRemoteFailures) {
            world.recordMetric({
              kind: "authority_slice_stale_fallback",
              host,
              object_count: objects.size,
              reason: "timeout"
            });
            staleFallbackCount += 1;
            return { host, response: null, error };
          }
          throw err;
        }
      })));
    }
    const slices: SerializedAuthoritySlice[] = [local.authority];
    if (mcpGatewayShard && localActorAuthorityRoots.size > 0) {
      const actorLive = mcpGatewayLocalActorLiveCellSlice(world, localActorAuthorityRoots, this.durableHostKey());
      if (actorLive.page_refs.length > 0) slices.push(actorLive);
      const actorCells = mcpGatewayLocalActorPropertyCellSlice(world, localActorAuthorityRoots, this.durableHostKey());
      if (actorCells.page_refs.length > 0) slices.push(actorCells);
    }
    for (const { host, response } of remoteSlices) {
      if (!response) continue;
      slices.push(await this.filterRemoteAuthoritySliceForGateway(
        response.authority,
        host,
        preservedObjectIds,
        localActorAuthorityRoots,
        resolveHost
      ));
    }
    if (mcpGatewayShard && options.scopeContentExpansionRoots && options.scopeContentExpansionRoots.length > 0) {
      const firstPassAuthority = combineSerializedAuthoritySlices(local.authority.sessions, slices);
      const contentIds = directContentIdsFromAuthoritySlice(
        firstPassAuthority,
        options.scopeContentExpansionRoots,
        MCP_GATEWAY_SCOPE_CONTENT_AUTHORITY_LIMIT
      );
      const expansionIds = contentIds.filter((id) => !requestedIds.includes(id));
      if (expansionIds.length > 0) {
        const expansionResolved = await Promise.all(expansionIds.map(async (id) => [id, await resolveHost(id, "")] as const));
        const expansionByHost = new Map<string, Set<ObjRef>>();
        for (const [id, host] of expansionResolved) {
          if (!host || host === localHost) continue;
          const list = expansionByHost.get(host) ?? new Set<ObjRef>();
          list.add(id);
          expansionByHost.set(host, list);
        }
        const expansionSlices = await Promise.all(Array.from(expansionByHost, async ([host, objects]) => {
          try {
            const response = await this.forwardInternalReadChecked<{ authority: SerializedAuthoritySlice }>(
              host,
              "/__internal/authority-slice",
              { objects: Array.from(objects) }
            );
            return { host, response };
          } catch (err) {
            const error = normalizeError(err);
            if (error.code === "E_TIMEOUT" && options.tolerateRemoteFailures) {
              world.recordMetric({
                kind: "authority_slice_stale_fallback",
                host,
                object_count: objects.size,
                reason: "content_expansion_timeout"
              });
              staleFallbackCount += 1;
              return null;
            }
            throw err;
          }
        }));
        for (const item of expansionSlices) {
          if (!item) continue;
          slices.push(await this.filterRemoteAuthoritySliceForGateway(
            item.response.authority,
            item.host,
            preservedObjectIds,
            localActorAuthorityRoots,
            resolveHost
          ));
        }
        world.recordMetric({
          kind: "authority_slice_content_expansion",
          roots: options.scopeContentExpansionRoots.length,
          objects: expansionIds.length,
          hosts: expansionByHost.size,
          cap: MCP_GATEWAY_SCOPE_CONTENT_AUTHORITY_LIMIT
        });
      }
    }
    const authority = combineSerializedAuthoritySlices(
      local.authority.sessions,
      slices
    );
    // Session rows are live authority too: if we ship a session whose actor row
    // is absent from the same merged slice, CommitScopeDO replaces its session
    // set with a presence entry that catalog roster verbs cannot dereference.
    // That turns stale projected presence into E_OBJNF during room_roster().
    const authorityObjectIds = authoritySliceObjectIds(authority);
    const authoritySessions = authority.sessions.filter((session) => authorityObjectIds.has(session.actor));
    const filteredAuthority: SerializedAuthoritySlice = authority.sessions.length === authoritySessions.length
      ? authority
      : { ...authority, sessions: authoritySessions };
    return {
      ...this.authorityPayloadFromCachedAuthority(world, reconstructionScope, filteredAuthority, directoryScopeSessions, reconstructionReason),
      staleFallbackCount
    };
  }

  private rememberRestV2Relay(scope: ObjRef, client: RestV2RelayClient): void {
    this.restV2Relays.delete(scope);
    this.restV2Relays.set(scope, client);
    while (this.restV2Relays.size > MAX_REST_V2_RELAY_CLIENTS) {
      const oldest = this.restV2Relays.keys().next().value;
      if (oldest === undefined) break;
      this.restV2Relays.delete(oldest);
    }
  }

  private async restV2Turn(world: WooWorld, input: Parameters<NonNullable<RestProtocolHost["executeTurn"]>>[0]): Promise<AppliedFrame | DirectResultFrame | ErrorFrame> {
    if (!this.env.COMMIT_SCOPE) {
      this.emitRestV2InProcessFallback(input, "no_commit_scope");
      return await this.restV2TurnInProcess(world, input);
    }
    // Live verbs (persistence: "live") declare themselves read-only: they
    // produce a result and observations but no durable commit. Running
    // them through submitTurnIntent → CommitScopeDO costs a cross-DO
    // round-trip + relay-open for no consistency benefit; the gateway's
    // local world snapshot already has the verb's read surface. Skip
    // the round-trip and execute in-process. Bypasses the bottleneck
    // documented in notes/2026-05-22-horoscope-blocking-world.md where
    // the_horoscope's next_pending polling repeatedly opened a v2 relay
    // against an idle CommitScopeDO, blocking WORLD for 9-26s per call.
    if (input.persistence === "live") {
      return await this.restV2TurnInProcess(world, input);
    }
    const token = shadowBrowserSessionBearer(input.session);
    const submitted = await submitTurnIntent<RestV2RelayClient, CommitScopeEnvelopeResponse>({
      input: {
        id: input.id,
        route: input.route,
        scope: input.scope,
        session: input.session.id,
        actor: input.actor,
        target: input.target,
        verb: input.verb,
        args: input.args,
        body: input.body,
        persistence: input.persistence,
        token
      },
      // Durable REST turns plan locally on the relay and submit a planned
      // exec request. Movement commits at the moved object's location
      // authority (CA3), not through the withdrawn #placement authority.
      maxAttempts: 8,
      ensureClient: async (scope, attempt) => await this.ensureRestV2Relay(world, input, scope, token, attempt > 0),
      clientNode: (client) => client.node,
      clientHead: (client) => client.relay.commit_scope.head,
      clientSerialized: (client) => serializedFor(client.relay.commit_scope, { reason: "rest_turn_plan", metric: (event) => world.recordMetric(event) }),
      // A3.2 admission gate (mirrors the MCP gateway): the REST durable planning path
      // is sparse cloud planning too. Thread the relay's per-cell provenance and opt
      // IN to fatal missing_provenance enforcement; a presentation stub / untagged
      // cell raises a repairable E_NEED_STATE that this submitTurnIntent repair loop
      // resolves. onAdmissionViolation observes.
      clientPlanningProvenance: (client) => client.relay.commit_scope.cellProvenance ?? new Map(),
      enforceMissingProvenance: true,
      onAdmissionViolation: (violations) => {
        for (const v of violations) {
          console.warn("woo.planning_world_inadmissible", { where: "rest_turn_plan", scope: input.scope, kind: v.kind, object: v.object, page: v.page, detail: v.detail });
        }
      },
      nextTurnId: (client) => `${client.node}:turn:${client.nextTurn++}:${crypto.randomUUID()}`,
      envelopeId: (id, attempt) => executorEnvelopeId(id, attempt, () => crypto.randomUUID()),
      // Per-turn authority refresh against an already-opened relay; the
      // CommitScopeDO has a durable snapshot so a cold satellite's slice
      // can be safely omitted. See comment on v2GatewayAuthorityPayload.
      authorityPayload: async (_scope, extraObjectIds) =>
        await this.v2GatewayAuthorityPayload(world, extraObjectIds, {
          tolerateRemoteFailures: true,
          directorySessionScopes: extraObjectIds,
          reconstructionReason: "warm_turn_refresh",
          reconstructionScope: _scope
        }),
      applyAuthority: (client, authority) => {
        this.mergeRestPlanningAuthority(world, client, authority);
        markShadowBrowserRelaySerializedChanged(client.relay);
      },
      // Adopt the authority's current head on a stale-head/version conflict so the
      // next attempt does not re-submit a stale `expected` (authority merge
      // updates cell versions but never advances the head). See gateway.ts.
      applyHead: (client, head) => {
        client.relay.commit_scope.head = structuredClone(head);
      },
      // DESIGN A layer-2 (mirrors gateway.ts): install the committing scope's
      // fresh mismatched cells, carried on a read-version-mismatch conflict, so
      // the next repair attempt plans against current versions and converges
      // instead of re-submitting the same stale rows.
      applyStateTransfer: (client, transfer) => {
        if (transfer.mode !== "cell_pages") return;
        installShadowCellPageTransferAsAuthority(client.relay, transfer, { reason: "rest_version_mismatch_repair" });
      },
      submitEnvelope: async (scope, body) => {
        const client = this.restV2Relays.get(scope);
        const capsuleBody = this.withRestExecutionCapsule(client, body, input.target, input.verb);
        try {
          return await this.v2CommitScopePost<CommitScopeEnvelopeResponse>(scope, "/v2/envelope", capsuleBody);
        } catch (err) {
          if (!this.restExecutionCapsuleEnabled() || !isCommitScopeSnapshotRequiredError(err)) throw err;
          if (!client) throw err;
          const seedObjectIds = executorAuthorityObjectIds({
            scope: input.scope,
            target: input.target,
            actor: input.actor,
            args: input.args,
            body: input.body
          }, scope);
          const seeded = await this.v2GatewayState(world, seedObjectIds);
          const opened = await this.v2CommitScopePost<CommitScopeOpenResponse>(scope, "/v2/open", {
            ...seeded.authority,
            scope,
            node: client.node,
            token,
            session: input.session.id,
            actor: input.actor,
            serialized: seeded.serialized
          });
          if (opened.head) client.relay.commit_scope.head = opened.head;
          mergeAuthorityIntoRelayCache(client.relay, seeded.authority.authority, {
            preserveSessionActorLive: true,
            clone: true,
            reason: "rest_capsule_open_seed",
            metric: (event) => world.recordMetric(event)
          });
          const { execution_capsule, ...legacyBody } = capsuleBody;
          void execution_capsule;
          return await this.v2CommitScopePost<CommitScopeEnvelopeResponse>(scope, "/v2/envelope", legacyBody);
        }
      },
      // Forward planning-phase verb metrics to the host world's metrics
      // hook so /admin/ footprint-by-verb sees v2 traffic.
      onMetric: (event) => world.recordMetric(event)
    });
    if (submitted.kind === "local_frame") return submitted.frame;
    await this.deliverV2Fanout(world, submitted.commitScope, submitted.result, input.session.id, submitted.client.node);
    if (!submitted.result.reply || !submitted.reply) throw wooError("E_INTERNAL", "v2 REST turn produced no reply");
    await this.applyV2CommittedTranscript(world, submitted.result.reply, input.session.id);
    return restFrameFromTurnReply(input.scope, submitted.reply);
  }

  private emitRestV2InProcessFallback(
    input: Parameters<NonNullable<RestProtocolHost["executeTurn"]>>[0],
    reason: "no_commit_scope"
  ): void {
    const event = {
      kind: "rest_v2_in_process_fallback" as const,
      reason,
      scope: input.scope,
      target: input.target,
      verb: input.verb,
      route: input.route,
      persistence: input.persistence
    };
    this.emitMetric(event, this.durableHostKey());
    console.warn("woo.rest.v2_in_process_fallback", event);
  }

  private async restV2TurnInProcess(world: WooWorld, input: Parameters<NonNullable<RestProtocolHost["executeTurn"]>>[0]): Promise<AppliedFrame | DirectResultFrame | ErrorFrame> {
    // The in-process REST fallback plans against this host's OWN full world
    // export — authoritative by construction, not a sparse cross-host projection.
    const snapshot = authoritativePlanningWorld(world.exportWorld());
    const run = await runShadowTurnCall(snapshot, {
      kind: "woo.turn_call.shadow.v1",
      id: input.id,
      route: input.route,
      scope: input.scope,
      session: input.session.id,
      actor: input.actor,
      target: input.target,
      verb: input.verb,
      args: input.args,
      body: input.body
    }, {
      // The ephemeral world has no metrics hook by default; forward to
      // the host world's hook so verb-level events from in-process REST
      // fallbacks land in AE alongside the v2 turn-network path.
      onMetric: (event) => world.recordMetric(event)
    });
    if (run.frame.op === "error") return run.frame;
    if (input.persistence === "durable") {
      await runShadowApply(run.transcript, this.buildGatewayApplyTarget(world), {
        sessionId: input.session.id,
        result: run.frame.result
      });
      const seq = this.committedScopeSeq(world, input.scope);
      if (seq === null) return run.frame;
      return {
        op: "applied",
        id: input.id,
        space: input.scope,
        seq,
        ts: Date.now(),
        message: {
          actor: input.actor,
          target: input.target,
          verb: input.verb,
          args: input.args
        },
        observations: run.transcript.observations,
        ...(run.transcript.result !== undefined ? { result: run.transcript.result } : {})
      };
    }
    return run.frame;
  }

  private async applyV2CommittedTranscript(
    world: WooWorld,
    replyText: string | null,
    sessionId: string
  ): Promise<void> {
    if (!replyText) return;
    const reply = decodeEnvelope<ShadowTurnExecReply | ShadowStateTransfer>(replyText);
    if (!isShadowTurnExecReply(reply.body)) return;
    if (reply.body.ok !== true || !reply.body.commit || !reply.body.transcript) return;
    const restRelay = this.restV2Relays.get(reply.body.commit.position.scope);
    if (restRelay) {
      // Owning-scope frame: advance the head and apply via the shared helper, then
      // publish (provenance re-tag is idempotent; publish also fans out + rebases live).
      applyAcceptedFrameToRelayCache(restRelay.relay, reply.body.commit, reply.body.transcript, { advanceHead: true });
      publishShadowBrowserAcceptedFrame(restRelay.relay, reply.body.commit, reply.body.transcript);
    }
    this.propagateRestTranscriptToOtherRelays(reply.body.commit.position.scope, reply.body.commit, reply.body.transcript, world);
    const projectionWrites = reply.body.commit.projection_writes ?? [];
    const projectionDelta = reply.body.commit.projection_delta;
    // The gateway maintains its projection-row cache from the accepted commit's
    // projection delta; it does not keep a mirror WooWorld via runShadowApply.
    // The core applier emits projection_delta for every accepted commit
    // (shadow-commit-scope.ts), so a delta-less accepted reply is a contract
    // violation, not a cue to fall back to the retired mirror-apply path.
    if (!projectionDelta) {
      throw wooError("E_INTERNAL", `accepted commit for ${reply.body.commit.position.scope} carried no projection_delta`);
    }
    const revokedBefore = projectionWrites.length ? this.revokedApiKeyIds(world) : null;
    this.applyGatewayProjectionWrites(reply.body.commit.position, projectionWrites, "rest", projectionDelta);
    if (projectionWrites.length) {
      const applied = world.applyProjectionWrites(projectionWrites, { persist: false, persistCreated: true, transcript: reply.body.transcript });
      if (applied.creates > 0) await this.registerIncrementalObjectRoutes(world);
    }
    if (revokedBefore) await this.cleanupNewlyRevokedApiKeys(world, revokedBefore);
    const session = world.sessions.get(sessionId);
    if (session) {
      this.mirrorResultRoomToSession(world, session, reply.body.outcome.result ?? reply.body.transcript.result);
      await this.registerSessionRoute(session, {}, world);
    }
    world.recordMetric({
      kind: "gateway_projection_apply",
      scope: reply.body.commit.position.scope,
      rows: projectionWrites.length,
      projection_bytes: projectionDelta.projection_bytes,
      source: "rest"
    });
  }

  private propagateRestTranscriptToOtherRelays(originScope: ObjRef, accepted: ShadowCommitAccepted, transcript: EffectTranscript, world: WooWorld): void {
    // REST relays are cached per planning scope. A movement turn may plan under a
    // room scope and commit under the moved object's location authority, so every
    // cached planning relay in an AFFECTED scope must see the accepted writes even
    // though only the authority relay advances its head. Mirrors the MCP gateway
    // exactly: bound to the transcript's affected scopes, and route every affected
    // relay through the one shared derived-cache applier (authority projection_writes
    // rows + movement projection + provenance + dirty-mark, no head advance).
    const affected = new Set(affectedTranscriptScopes(
      originScope,
      transcript,
      (object, property) => world.isPresenceProjectionProperty(object, property)
    ));
    for (const [scope, client] of this.restV2Relays) {
      if (scope === originScope) continue;
      if (!affected.has(scope)) continue;
      applyAcceptedFrameToDerivedRelayCache(client.relay, accepted, transcript);
    }
  }

  private applyGatewayProjectionCacheFromReply(replyText: string | null, source: "rest" | "mcp" | "fanout"): void {
    if (!replyText) return;
    const reply = decodeEnvelope<ShadowTurnExecReply | ShadowStateTransfer>(replyText);
    if (!isShadowTurnExecReply(reply.body)) return;
    if (reply.body.ok !== true || !reply.body.commit) return;
    const projectionWrites = reply.body.commit.projection_writes ?? [];
    const projectionDelta = reply.body.commit.projection_delta;
    if (!projectionWrites.length && !projectionDelta) return;
    this.applyGatewayProjectionWrites(reply.body.commit.position, projectionWrites, source, projectionDelta);
  }

  private mirrorResultRoomToSession(world: WooWorld, session: Session, result: unknown): void {
    if (!result || typeof result !== "object" || Array.isArray(result)) return;
    const room = (result as Record<string, unknown>).room;
    if (typeof room !== "string" || !room) return;
    const activeScope = room as ObjRef;
    session.activeScope = activeScope;
    world.ensureSessionForActor(session.id, session.actor, session.tokenClass, session.expiresAt, activeScope, session.apikeyId);
  }

  private committedScopeSeq(world: WooWorld, scope: ObjRef): number | null {
    try {
      return Number(world.getProp(scope, "next_seq")) - 1;
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "";
      if (code === "E_PROPNF") return null;
      throw err;
    }
  }

  private sendV2Fanout(fanout: Array<{ node: string; envelope: string }>): Set<string> {
    const deliveredNodes = new Set<string>();
    if (fanout.length === 0) return deliveredNodes;
    const byNode = v2FanoutEnvelopesByNode(fanout);
    for (const ws of this.state.getWebSockets()) {
      const att = this.attachment(ws);
      const envelopes = att?.node ? byNode.get(att.node) : undefined;
      if (!envelopes) continue;
      let delivered = false;
      for (const envelope of envelopes) {
        try {
          ws.send(envelope);
          delivered = true;
        } catch {
          // Socket cleanup is driven by webSocketClose/webSocketError; fan-out
          // should not fail the originator's already-accepted commit.
        }
      }
      if (delivered && att?.node) deliveredNodes.add(att.node);
    }
    return deliveredNodes;
  }

  private async deliverV2Fanout(
    world: WooWorld,
    scope: ObjRef,
    result: CommitScopeEnvelopeResponse,
    originSessionId?: string | null,
    originNode?: string | null,
    options: { localMcpLiveHandled?: boolean } = {}
  ): Promise<V2FanoutDelivery> {
    const fanout = result.fanout ?? [];
    if (!result.reply) {
      this.sendV2Fanout(fanout);
      return { localHostMaterialized: null };
    }
    const replyEnvelope = decodeEnvelope<ShadowTurnExecReply | ShadowStateTransfer>(result.reply);
    if (!isShadowTurnExecReply(replyEnvelope.body)) {
      this.sendV2Fanout(fanout);
      return { localHostMaterialized: null };
    }
    const turnReplyEnvelope = replyEnvelope as ShadowEnvelope<ShadowTurnExecReply>;
    const reply = turnReplyEnvelope.body;
    if (reply.ok !== true || !reply.commit || !reply.transcript) {
      const deliveredNodes = this.sendV2Fanout(fanout);
      if (reply.ok === true && reply.transcript && !reply.commit) {
        this.sendV2LiveTranscriptFanout(turnReplyEnvelope, deliveredNodes, originNode ?? null);
        await this.deliverMcpLiveFanout(world, scope, reply.transcript, originSessionId ?? null, options.localMcpLiveHandled === true);
      }
      return { localHostMaterialized: null };
    }
    const revokedBefore = this.revokedApiKeyIds(world);
    const localHostMaterialized = await this.writeThroughV2CommitToObjectHosts(world, reply.commit.position.scope, reply.commit, reply.transcript);
    await this.cleanupNewlyRevokedApiKeys(world, revokedBefore);
    const deliveredNodes = this.sendV2Fanout(fanout);
    const frame = restFrameFromTurnReply(scope, reply);
    const observations = "observations" in frame && frame.observations.length > 0
      ? frame.observations
      : reply.commit.observations;
    const mcpAudience = await this.mcpFanoutAudience(world, reply.commit.position.scope, reply.transcript, observations);
    await this.sendV2CommitTranscriptFanout(world, turnReplyEnvelope, deliveredNodes, originNode ?? null);
    await this.deliverMcpCommitFanout(world, scope, fanout, { ...reply.commit, observations }, reply.transcript, originSessionId ?? null, mcpAudience);
    return { localHostMaterialized, mcpAudience };
  }

  private async sendV2CommitTranscriptFanout(
    world: WooWorld,
    replyEnvelope: ShadowEnvelope<ShadowTurnExecReply>,
    alreadyDeliveredNodes: ReadonlySet<string>,
    originNode: string | null
  ): Promise<void> {
    const reply = replyEnvelope.body;
    if (reply.ok !== true || !reply.commit || !reply.transcript) return;
    const commitScope = reply.commit.position.scope;
    const from = replyEnvelope.from || this.durableHostKey();
    const observations = structuredClone(reply.transcript.observations) as Observation[];
    const sockets = this.state.getWebSockets()
      .map((ws) => ({ ws, att: this.attachment(ws) }))
      .filter((entry): entry is { ws: WebSocket; att: ActiveV2SocketAttachment } =>
        !!entry.att?.node && entry.att.protocol === "v2-turn-network"
      );
    if (sockets.length === 0) return;
    const audiences = await world.computeDirectLiveAudiences(commitScope, observations);
    const eventTranscript = { ...reply.transcript, observations } as EffectTranscript;
    // Recipient routing is the shared `planV2BrowserFanout` decision (also used
    // by localdev) so the two paths cannot drift: a peer receives events its
    // (session, actor, scope) matches, and a commit-scope peer also re-syncs its
    // projection. Projection transfers are scoped to the relay head that signs
    // them; peer scopes receive live events only until their own scope DO can
    // build a self-consistent catch-up transfer.
    const events = buildV2FanoutLiveEvents(from, eventTranscript, audiences);
    const affectedScopes = new Set(affectedBrowserFanoutScopes(commitScope, reply.transcript, (object, property) => world.isPresenceProjectionProperty(object, property)));
    if (events.length === 0 && affectedScopes.size === 0) return;
    const socketByNode = new Map(sockets.map(({ ws, att }) => [att.node, { ws, att }] as const));
    const plan = planV2BrowserFanout({
      events,
      commitScope,
      peers: sockets.map(({ att }) => ({ node: att.node, sessionId: att.sessionId, actor: att.actor, scope: att.scope })),
      originNode,
      alreadyDeliveredNodes
    });
    for (const { node, events: peerEvents } of plan.liveDeliveries) {
      const entry = socketByNode.get(node);
      if (!entry) continue;
      for (const event of peerEvents) this.sendV2LiveEvent(entry.ws, entry.att, from, event);
    }
    await Promise.all(plan.stateTransferNodes.map((node) => {
      const entry = socketByNode.get(node);
      return entry ? this.sendV2ProjectionStateTransfer(world, entry.ws, entry.att, commitScope, from) : Promise.resolve();
    }));
  }

  private sendV2LiveEvent(ws: WebSocket, att: V2SocketAttachment, from: string, event: ShadowLiveEvent): void {
    try {
      ws.send(encodeEnvelope({
        v: 2,
        type: event.kind,
        id: `${event.id}:${att.node}`,
        from,
        to: att.node,
        actor: att.actor,
        session: att.sessionId,
        auth: { mode: "session", token: att.token ?? "" },
        body: event
      } satisfies ShadowEnvelope<typeof event>));
    } catch {
      // Socket cleanup is driven by webSocketClose/webSocketError.
    }
  }

  private async sendV2ProjectionStateTransfer(
    world: WooWorld,
    ws: WebSocket,
    att: V2SocketAttachment,
    commitScope: ObjRef,
    from: string
  ): Promise<void> {
    if (!att.node || !att.token) return;
    try {
      const transfer = await this.v2CommitScopePost<CommitScopeStateTransferResponse>(commitScope, "/v2/state-transfer", {
        ...executorAuthorityPayload(world, [commitScope, att.scope, att.actor]),
        scope: commitScope,
        node: att.node,
        token: att.token,
        session: att.sessionId,
        actor: att.actor,
        transfer_scope: att.scope,
        ...(att.stateHead ? { last_known_head: att.stateHead } : {})
      });
      ws.send(encodeEnvelope({
        v: 2,
        type: transfer.transfer.kind,
        id: `${from}:state:${Date.now()}:${att.node}`,
        from: transfer.relay || from,
        to: att.node,
        actor: att.actor,
        session: att.sessionId,
        auth: { mode: "session", token: att.token },
        body: transfer.transfer
      } satisfies ShadowEnvelope<typeof transfer.transfer>));
      if ("to" in transfer.transfer) this.updateV2SocketStateHead(ws, transfer.transfer.to);
    } catch (err) {
      console.warn("woo.v2_browser_commit_fanout.state_transfer_failed", {
        node: att.node,
        scope: att.scope,
        commit_scope: commitScope,
        error: normalizeError(err)
      });
    }
  }

  private sendV2LiveTranscriptFanout(
    replyEnvelope: ShadowEnvelope<ShadowTurnExecReply>,
    alreadyDeliveredNodes: ReadonlySet<string>,
    originNode: string | null
  ): void {
    const reply = replyEnvelope.body;
    if (reply.ok !== true || !reply.transcript || reply.commit) return;
    const from = replyEnvelope.from || this.durableHostKey();
    const events = shadowLiveEventsForTranscriptRelay(from, reply.transcript);
    if (events.length === 0) return;
    for (const ws of this.state.getWebSockets()) {
      const att = this.attachment(ws);
      if (!att?.node || att.protocol !== "v2-turn-network") continue;
      if (att.node === originNode || alreadyDeliveredNodes.has(att.node)) continue;
      const matching = events.filter((event) => shadowLiveEventMatchesPeerScope(event, att));
      for (const event of matching) {
        this.sendV2LiveEvent(ws, att, from, event);
      }
    }
  }

  private async mcpFanoutAudience(
    world: WooWorld,
    scope: ObjRef,
    transcript: EffectTranscript,
    observations: readonly Observation[]
  ): Promise<McpFanoutAudience> {
    const directorySessions = await this.loadDirectorySessionsForScopes(affectedMcpFanoutScopes(scope, transcript, (object, property) => world.isPresenceProjectionProperty(object, property)));
    // MCP gateway shards are intentionally sparse. Directory is the live
    // session table for MCP fanout, so recomputing audiences from local room
    // lineage on those shards both duplicates the route source of truth and
    // walks stale scope stubs before owner authority is present.
    const fallback = isMcpGatewayShardHost(this.durableHostKey())
      ? {}
      : await world.computeDirectLiveAudiences(scope, structuredClone(observations) as Observation[]);
    const directoryAudience = mcpFanoutAudienceFromDirectorySessions(scope, observations, directorySessions);
    return mergeMcpFanoutAudience(fallback, directoryAudience);
  }

  private async deliverMcpLiveFanout(
    world: WooWorld,
    scope: ObjRef,
    transcript: EffectTranscript,
    originSessionId: string | null,
    localAlreadyHandled: boolean
  ): Promise<void> {
    // Live transcripts have no accepted commit to replay later. Route their
    // observations to MCP wait queues at the gateway layer, using the same
    // Directory shard discovery as durable commit fanout.
    if (!localAlreadyHandled) this.mcpGateway?.acceptRemoteV2Live(scope, transcript, originSessionId);
    const affectedScopes = affectedMcpFanoutScopes(scope, transcript, (object, property) => world.isPresenceProjectionProperty(object, property));
    const scopedHosts = await this.mcpShardHostsForScopes(affectedScopes);
    const hosts = new Set(scopedHosts);
    const localHost = this.durableHostKey();
    const localSuppressed = hosts.delete(localHost);
    // Live fanout has no durable subscribers list (no commit, no fanout
    // recipients) — peers receive the transcript only if Directory's
    // scoped-presence lookup names their shard. We record the metric even
    // when hosts.size === 0 so chat:say-style peer-not-seeing-observation
    // cases ("the selector ran with zero remote shards") show up in logs
    // the same way the durable commit path does.
    const body = {
      scope,
      origin_session: originSessionId,
      transcript: transcript as unknown as WooValue
    };
    if (hosts.size > 0) {
      await Promise.all(Array.from(hosts, async (host) => {
        try {
          await this.forwardInternalChecked<{ ok: true }>(host, "/__internal/mcp-live-fanout", body, { timeoutMs: this.hostReadRpcTimeoutMs() });
        } catch (err) {
          console.warn("woo.mcp_live_fanout.failed", { host, scope, error: normalizeError(err) });
        }
      }));
    }
    world.recordMetric({
      kind: "mcp_fanout",
      scope,
      shards: hosts.size,
      observations: transcript.observations.length,
      affected_scopes: affectedScopes.length,
      scoped_shards: scopedHosts.length,
      // Live fanout has no durable subscriber list — explicit subscriber
      // shards are always zero. Keep the field set (0) for symmetry with
      // the commit path so triage queries don't need to special-case live.
      subscriber_shards: 0,
      local_suppressed: localSuppressed,
      origin_session: originSessionId
    });
  }

  private async writeThroughV2CommitToObjectHosts(
    world: WooWorld,
    scope: ObjRef,
    commit: ShadowCommitAccepted,
    transcript: EffectTranscript
  ): Promise<V2LocalHostMaterialization> {
    if (commit.projection_delta) {
      return await this.writeThroughProjectionWritesToObjectHosts(world, scope, commit, transcript);
    }
    const touched = transcriptTouchedObjectIds(transcript);
    touched.add(scope);
    const localHost = this.durableHostKey();
    // Partition: every touched host receives the same transcript slice. The
    // shared fan-out applies the local slice and forwards the rest as RPCs.
    const slicesByHost = new Map<string, EffectTranscript>();
    for (const id of touched) {
      const host = await this.resolveObjectHostForWorld(world, id, localHost);
      if (host) slicesByHost.set(host, transcript);
    }
    return await fanOutHostWrites<EffectTranscript>({
      localHostKey: localHost,
      isGatewayHost: (host) => host === WORLD_HOST,
      slicesByHost,
      scope,
      touched: touched.size,
      retryMessage: "v2 commit accepted but object-host write-through failed",
      onMetric: (event) => world.recordMetric(event),
      applyLocal: (slice) => runShadowApply(slice, this.buildHostApplyTarget(world, localHost)),
      forwardRemote: (host, slice) => this.forwardInternalChecked<{ ok: true }>(host, "/__internal/apply-v2-commit", {
        scope,
        commit: commit as unknown as WooValue,
        transcript: slice as unknown as WooValue
      }, { timeoutMs: this.hostWriteRpcTimeoutMs() }).then(() => undefined)
    });
  }

  private async writeThroughProjectionWritesToObjectHosts(
    world: WooWorld,
    scope: ObjRef,
    commit: ShadowCommitAccepted,
    transcript: EffectTranscript
  ): Promise<V2LocalHostMaterialization> {
    const localHost = this.durableHostKey();
    const projectionWrites = commit.projection_writes ?? [];
    this.requireProjectionWritesComplete(scope, commit.projection_delta, projectionWrites, "host_write_through");
    // Partition: each host gets only the projection rows it owns. The shared
    // fan-out applies the local host's rows and forwards the rest as RPCs.
    const slicesByHost = await this.projectionWritesByHost(world, scope, projectionWrites, localHost);
    return await fanOutHostWrites<ProjectionWrite[]>({
      localHostKey: localHost,
      isGatewayHost: (host) => host === WORLD_HOST,
      slicesByHost,
      scope,
      touched: projectionWrites.length,
      retryMessage: "v2 commit accepted but object-host projection write-through failed",
      onMetric: (event) => world.recordMetric(event),
      applyLocal: async (writes) => {
        const applied = world.applyProjectionWrites(writes, { transcript });
        if (applied.creates > 0) await this.registerIncrementalObjectRoutes(world);
      },
      forwardRemote: (host, writes) => this.forwardInternalChecked<{ ok: true }>(host, "/__internal/apply-v2-commit", {
        scope,
        commit: {
          ...commit,
          projection_delta: summarizeProjectionWrites(writes),
          projection_writes: writes
        } as unknown as WooValue,
        transcript: transcript as unknown as WooValue,
        projection_writes: writes as unknown as WooValue
      }, { timeoutMs: this.hostWriteRpcTimeoutMs() }).then(() => undefined)
    });
  }

  private projectionWritesByHost(
    world: WooWorld,
    scope: ObjRef,
    writes: readonly ProjectionWrite[],
    fallbackHost: string
  ): Promise<Map<string, ProjectionWrite[]>> {
    return partitionProjectionWritesByHost(writes, scope, fallbackHost, (id) => this.resolveObjectHostForWorld(world, id, fallbackHost));
  }

  private async deliverMcpCommitFanout(
    world: WooWorld,
    scope: ObjRef,
    fanout: Array<{ node: string; envelope: string }>,
    commit: ShadowCommitAccepted,
    transcript: EffectTranscript,
    originSessionId: string | null,
    audience: McpFanoutAudience
  ): Promise<void> {
    // Query Directory freshly for scopes whose presence/contents changed so
    // co-present MCP sessions receive the accepted transcript before they plan
    // their next local read. Do not fan out to every active MCP shard here:
    // a cold unrelated shard has to hydrate a gateway snapshot before it can
    // discard the replay, and that turns one room commit into deployment-wide
    // cold-start work.
    const affectedScopes = affectedMcpFanoutScopes(scope, transcript, (object, property) => world.isPresenceProjectionProperty(object, property));
    const audienceSessions = mcpFanoutAudienceSessionIds(audience);
    const audienceShardSet = new Set<string>();
    for (const sessionId of audienceSessions) {
      if (originSessionId && sessionId === originSessionId) continue;
      audienceShardSet.add(mcpGatewayShardHost(this.env, sessionId));
    }
    const scopedHosts = audienceShardSet.size > 0 ? [] : await this.mcpShardHostsForScopes(affectedScopes);
    const hosts = new Set(scopedHosts);
    for (const host of audienceShardSet) hosts.add(host);
    const localHost = this.durableHostKey();
    // The commit scope's durable fanout list names sessions that subscribed to
    // this scope explicitly (e.g. through a v2 open). Those recipients may not
    // appear in Directory's scoped query — a session can subscribe to a scope
    // without being located there — so we add their gateway shards here in
    // addition to the scoped-presence shards above.
    const subscriberShardSet = new Set<string>();
    for (const item of fanout) {
      const sessionId = mcpSessionIdFromNode(item.node);
      if (!sessionId) continue;
      const shard = mcpGatewayShardHost(this.env, sessionId);
      hosts.add(shard);
      subscriberShardSet.add(shard);
    }
    const localSuppressed = hosts.delete(localHost);
    // Metric fires regardless of hosts.size so triage can see that the
    // selector ran with `shards: 0` (peer-not-seeing-observation cases often
    // hinge on this — no remote shards selected and local delivery
    // suppressed = no fanout at all).
    const body = {
      scope,
      origin_session: originSessionId,
      commit: commit as unknown as WooValue,
      transcript: transcript as unknown as WooValue,
      ...mcpFanoutAudienceBody(audience)
    };
    world.recordMetric({
      kind: "mcp_fanout",
      scope,
      shards: hosts.size,
      observations: commit.observations.length,
      affected_scopes: affectedScopes.length,
      scoped_shards: scopedHosts.length,
      audience_session_shards: audienceShardSet.size,
      subscriber_shards: subscriberShardSet.size,
      local_suppressed: localSuppressed,
      origin_session: originSessionId
    });
    if (hosts.size > 0) {
      const task = Promise.all(Array.from(hosts, async (host) => {
        try {
          await this.forwardInternalChecked<{ ok: true }>(host, "/__internal/mcp-commit-fanout", body, { timeoutMs: this.hostReadRpcTimeoutMs() });
        } catch (err) {
          console.warn("woo.mcp_fanout.failed", { host, scope, error: normalizeError(err) });
        }
      })).then(() => undefined);
      // Durable commit fanout is necessary for remote MCP queues, but the
      // originator's accepted commit is already durable at this point. Run the
      // cross-shard replay after the response so slow/cold subscriber shards do
      // not sit on the submit critical path.
      const waitUntil = (this.state as { waitUntil?: (promise: Promise<unknown>) => void }).waitUntil;
      if (typeof waitUntil === "function") {
        waitUntil.call(this.state, task);
      } else {
        await task;
      }
    }
  }

  private async mcpShardHostsForScopes(scopes: ObjRef[]): Promise<string[]> {
    if (scopes.length === 0) return [];
    const id = this.env.DIRECTORY.idFromName(DIRECTORY_HOST);
    const request = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}/mcp-shards-for-scopes`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ scopes })
    }));
    const response = await this.env.DIRECTORY.get(id).fetch(request);
    const body = await response.json().catch(() => null) as { shards?: unknown } | null;
    if (!response.ok || !body || !Array.isArray(body.shards)) return [];
    return body.shards.filter((item): item is string => typeof item === "string" && item.startsWith(MCP_GATEWAY_SHARD_PREFIX));
  }

    private indexAddSocket(sessionId: string, actor: ObjRef, ws: WebSocket): void {
      let set = this.socketsByActor.get(actor);
      if (!set) { set = new Set(); this.socketsByActor.set(actor, set); }
      set.add(ws);
      let sessionSet = this.socketsBySession.get(sessionId);
      if (!sessionSet) { sessionSet = new Set(); this.socketsBySession.set(sessionId, sessionSet); }
      sessionSet.add(ws);
    }

    private indexRemoveSocket(sessionId: string, actor: ObjRef, ws: WebSocket): void {
      const set = this.socketsByActor.get(actor);
      if (set) {
        set.delete(ws);
        if (set.size === 0) this.socketsByActor.delete(actor);
      }
      const sessionSet = this.socketsBySession.get(sessionId);
      if (sessionSet) {
        sessionSet.delete(ws);
        if (sessionSet.size === 0) this.socketsBySession.delete(sessionId);
      }
    }

  // ---- WS helpers ----

  private attachment(ws: WebSocket): V2SocketAttachment | null {
    if (typeof ws.deserializeAttachment !== "function") return null;
    const raw = ws.deserializeAttachment();
    if (!raw || typeof raw !== "object") return null;
    const a = raw as Record<string, unknown>;
    if (typeof a.sessionId !== "string" || typeof a.actor !== "string" || typeof a.socketId !== "string") return null;
    return {
      sessionId: a.sessionId,
      actor: a.actor as ObjRef,
      socketId: a.socketId,
      ...(a.protocol === "v2-turn-network" ? { protocol: "v2-turn-network" as const } : {}),
      ...(typeof a.node === "string" ? { node: a.node } : {}),
      scope: (typeof a.scope === "string" ? a.scope : a.actor) as ObjRef,
      ...(typeof a.token === "string" ? { token: a.token } : {}),
      ...(typeof a.openedAt === "number" ? { openedAt: a.openedAt } : {}),
      ...(this.isShadowScopeHeadRecord(a.stateHead) ? { stateHead: a.stateHead } : {})
    };
  }

  private isShadowScopeHeadRecord(value: unknown): value is ShadowScopeHead {
    return Boolean(
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as { kind?: unknown }).kind === "woo.scope_head.shadow.v1" &&
      typeof (value as { scope?: unknown }).scope === "string" &&
      typeof (value as { epoch?: unknown }).epoch === "number" &&
      typeof (value as { seq?: unknown }).seq === "number" &&
      typeof (value as { hash?: unknown }).hash === "string"
    );
  }

  private updateV2SocketStateHead(ws: WebSocket, stateHead: ShadowScopeHead): void {
    const att = this.attachment(ws);
    if (!att) return;
    if (typeof ws.serializeAttachment !== "function") return;
    ws.serializeAttachment({ ...att, stateHead });
  }

  // Helper used at every cross-host verb-dispatch site to (a) probe verb
  // purity from the local class registry and (b) emit a `dispatch_resolved`
  // event so we always have a tail trace of the verb routed to which host
  // along which path. Uses the full resolveVerb walk (parent chain + feature
  // chain), matching the way the dispatcher itself resolves at run time —
  // otherwise feature-contributed pure verbs would silently take the
  // mutating path. Best-effort: when the verb can't be resolved locally
  // (instance-only verb on a host we don't seed), defaults to `pure=false`
  // (mutating path), matching pre-flag conservative behavior.
  private resolveDispatchPath(world: WooWorld | null | undefined, target: ObjRef, verb: string, resolvedHost: string, localHost: string): { pure: boolean; path: "local" | "read" | "mutating" } {
    const local = resolvedHost === localHost;
    let pure = false;
    if (world) {
      try {
        const resolved = world.resolveVerb(target, verb);
        if (resolved.verb.pure === true) pure = true;
      } catch { /* not resolvable locally; mutating fallback */ }
    }
    const path: "local" | "read" | "mutating" = local ? "local" : (pure ? "read" : "mutating");
    world?.recordMetric({ kind: "dispatch_resolved", target, verb, host: resolvedHost, path, pure });
    return { pure, path };
  }

  private hostReadRpcTimeoutMs(): number {
    const configured = Number(this.env.WOO_HOST_READ_TIMEOUT_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : HOST_READ_RPC_TIMEOUT_MS;
  }

  private hostWriteRpcTimeoutMs(): number {
    const configured = Number(this.env.WOO_HOST_WRITE_TIMEOUT_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : HOST_WRITE_RPC_TIMEOUT_MS;
  }

  private hostOutFetchConcurrency(): number {
    const configured = Number(this.env.WOO_HOST_OUT_FETCH_CONCURRENCY);
    if (!Number.isFinite(configured) || configured <= 0) return HOST_OUT_FETCH_CONCURRENCY;
    return Math.max(1, Math.floor(configured));
  }

  // Acquire one outbound subrequest slot. If the cap is reached, the caller is
  // queued FIFO and the slot is handed off directly by releaseOutFetchSlot
  // (no decrement-then-increment, so concurrent acquire+release can't go
  // over cap). If `signal` aborts before the slot is granted, the waiter is
  // spliced from the queue and the acquire rejects — no fetch is performed,
  // no slot is consumed.
  private async acquireOutFetchSlot(signal?: AbortSignal): Promise<void> {
    if (this.outFetchInFlight < this.hostOutFetchConcurrency()) {
      this.outFetchInFlight += 1;
      return;
    }
    if (signal?.aborted) throw signal.reason ?? wooError("E_ABORTED", "outbound fetch aborted before queue");
    await new Promise<void>((resolve, reject) => {
      let aborted = false;
      // A handoff after we've already aborted: take the slot and immediately
      // release it so the next non-aborted waiter (or a fresh acquire) can use
      // it. Without this, releaseOutFetchSlot would have leaked a slot.
      const waiter: () => void = () => {
        if (signal) signal.removeEventListener("abort", onAbort);
        if (aborted) { this.releaseOutFetchSlot(); return; }
        resolve();
      };
      const onAbort = () => {
        aborted = true;
        const idx = this.outFetchQueue.indexOf(waiter);
        if (idx >= 0) this.outFetchQueue.splice(idx, 1);
        if (signal) signal.removeEventListener("abort", onAbort);
        reject(signal!.reason ?? wooError("E_ABORTED", "outbound fetch aborted while queued"));
      };
      this.outFetchQueue.push(waiter);
      signal?.addEventListener("abort", onAbort);
    });
  }

  private releaseOutFetchSlot(): void {
    const next = this.outFetchQueue.shift();
    if (next) { next(); return; }
    this.outFetchInFlight -= 1;
  }

  // Wraps the actual DO->DO fetch with the queue. `signal` is honored for
  // (a) the queue wait — aborting before a slot is granted splices the waiter
  // out of the queue without performing the fetch — and (b) the fetch itself,
  // both via the Request's signal (so the production runtime cancels the
  // subrequest) and via a manual race (so even if the underlying fetch ignores
  // the signal — e.g. in tests — the caller's await still rejects promptly
  // and our slot is released).
  private async outboundFetch(id: DurableObjectId, request: Request, signal?: AbortSignal): Promise<{ response: Response; queueMs: number }> {
    const queueStart = Date.now();
    await this.acquireOutFetchSlot(signal);
    const queueMs = Date.now() - queueStart;
    try {
      const signedRequest = signal ? new Request(request, { signal }) : request;
      const fetchPromise = this.env.WOO.get(id).fetch(signedRequest);
      if (!signal) {
        const response = await fetchPromise;
        return { response, queueMs };
      }
      const response = await raceAgainstAbort(fetchPromise, signal);
      return { response, queueMs };
    } finally {
      this.releaseOutFetchSlot();
    }
  }

  private async forwardInternal<T>(host: string, path: string, body: Record<string, unknown>, options: { timeoutMs?: number } = {}): Promise<T> {
    const bodyStr = JSON.stringify(body);
    // Single-flight: only enabled for explicitly read-only paths. Joiners get
    // the same Promise as the in-flight leader; they don't pay queue, fetch,
    // or parse cost, and they share the leader's success/error outcome.
    const coalesceKey = COALESCEABLE_INTERNAL_PATHS.has(path) ? `${host}\n${path}\n${bodyStr}` : null;
    if (coalesceKey) {
      const existing = this.outFetchInflight.get(coalesceKey) as Promise<T> | undefined;
      if (existing) return existing;
    }
    const promise = this.forwardInternalRaw<T>(host, path, bodyStr, options);
    if (coalesceKey) {
      this.outFetchInflight.set(coalesceKey, promise as Promise<unknown>);
      // Clear on settle (resolve or reject) so the next call recomputes.
      promise.then(
        () => { if (this.outFetchInflight.get(coalesceKey) === promise) this.outFetchInflight.delete(coalesceKey); },
        () => { if (this.outFetchInflight.get(coalesceKey) === promise) this.outFetchInflight.delete(coalesceKey); }
      );
    }
    return promise;
  }

  private async forwardInternalRaw<T>(host: string, path: string, bodyStr: string, options: { timeoutMs?: number }): Promise<T> {
    const id = this.env.WOO.idFromName(host);
    // Stamp the active task chain id on every outbound RPC. The receiver
    // uses it to detect re-entrancy: if a callback arrives while the
    // caller is still awaiting (typical for A→B→A dispatch chains),
    // matching ids let the callback run inline instead of queueing
    // behind the caller's stuck task. Reads from the world's
    // currentHostTask, set by enqueueHostTask. Null when no task is
    // active (cold-load directory chatter, postflight probes, etc.) —
    // treated as a fresh chain at the receiver.
    const chainId = this.world?.currentTaskChainId() ?? null;
    // Per-call correlation id, propagated to the receiver via header and
    // back into both sides' metrics. The sender's `cross_host_rpc_start`,
    // the receiver's `do_handler`, and the sender's `cross_host_rpc`
    // (ok|timeout|error) all share the same `rpc_id`, so a timeout on the
    // sender can be matched against the receiver's actual handler runtime —
    // distinguishing transit latency from satellite execution time without
    // keeping orphaned fetches alive past timeout.
    const rpcId = crypto.randomUUID();
    const baseHeaders: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
      "x-woo-host-key": host,
      "x-woo-rpc-id": rpcId
    };
    if (chainId !== null) baseHeaders["x-woo-task-chain"] = chainId;
    const request = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}${path}`, {
      method: "POST",
      headers: baseHeaders,
      body: bodyStr
    }));
    const startedAt = Date.now();
    // Logged here so a wedged fetch leaves a trace; the existing
    // `cross_host_rpc` end event only fires on settle.
    this.world?.recordMetric({ kind: "cross_host_rpc_start", route: path, host, rpc_id: rpcId });
    // Every cross-host RPC gets a deadline. Read-only callers pick a tight
    // one (HOST_READ_RPC_TIMEOUT_MS via forwardInternalReadChecked); mutating
    // callers fall back to the much more generous HOST_WRITE_RPC_TIMEOUT_MS
    // watchdog so a wedged downstream can't park the slot — and the entire
    // local task chain — indefinitely. The AbortController cancels both the
    // queue wait and the underlying fetch on timeout; aborting mid-write
    // can leave ambiguous remote state, but indefinite hang is the worse
    // failure mode (the whole DO becomes unresponsive).
    const timeoutMs = options.timeoutMs ?? this.hostWriteRpcTimeoutMs();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(wooError("E_TIMEOUT", `cross-host RPC timed out: ${host}${path}`, { host, path, timeout_ms: timeoutMs })), timeoutMs);
    let observedQueueMs = 0;
    try {
      const { response, queueMs } = await this.outboundFetch(id, request, controller.signal);
      observedQueueMs = queueMs;
      const parsed = await response.json() as T;
      const queueField = observedQueueMs > 0 ? { queue_ms: observedQueueMs } : {};
      this.world?.recordMetric({ kind: "cross_host_rpc", route: path, host, ms: Date.now() - startedAt, status: "ok", rpc_id: rpcId, ...queueField });
      return parsed;
    } catch (err) {
      const queueField = observedQueueMs > 0 ? { queue_ms: observedQueueMs } : {};
      // E_TIMEOUT lifted out of the abort reason so callers see the same shape
      // as before this refactor.
      const isAbortTimeout = controller.signal.aborted && (controller.signal.reason as { code?: string } | undefined)?.code === "E_TIMEOUT";
      if (isAbortTimeout) {
        this.world?.recordMetric({ kind: "cross_host_rpc", route: path, host, ms: Date.now() - startedAt, status: "timeout", rpc_id: rpcId, ...queueField });
        throw controller.signal.reason;
      }
      const error = normalizeError(err);
      this.world?.recordMetric({ kind: "cross_host_rpc", route: path, host, ms: Date.now() - startedAt, status: "error", error: error.code, rpc_id: rpcId, ...queueField });
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async forwardInternalChecked<T>(host: string, path: string, body: Record<string, unknown>, options: { timeoutMs?: number } = {}): Promise<T> {
    const parsed = await this.forwardInternal<T | { error?: unknown }>(host, path, body, options);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "error" in parsed && (parsed as { error?: unknown }).error) {
      throw normalizeError((parsed as { error: unknown }).error);
    }
    return parsed as T;
  }

  private async forwardInternalReadChecked<T>(host: string, path: string, body: Record<string, unknown>): Promise<T> {
    return await this.forwardInternalChecked<T>(host, path, body, { timeoutMs: this.hostReadRpcTimeoutMs() });
  }

  private broadcastApplied(world: WooWorld, frame: AppliedFrame, originator?: WebSocket, originMcpSessionId?: string | null): void {
    const startedAt = Date.now();
    const data = JSON.stringify(frame);
    const publicFrame = publicAppliedFrame(frame);
    const dataNoId = JSON.stringify(publicFrame);
    let audienceSize = 0;
    if (originator?.readyState === WebSocket.OPEN) {
      try {
        originator.send(data);
        audienceSize += 1;
      } catch {
        // socket gone; webSocketClose will clean up
      }
    }
    const sendSockets = (sockets: Set<WebSocket> | undefined): void => {
      if (!sockets) return;
      for (const ws of sockets) {
        if (ws === originator) continue;
        audienceSize += 1;
        try {
          ws.send(dataNoId);
        } catch {
          // socket gone; webSocketClose will clean up
        }
      }
    };
    if (frame.audienceSessions) {
      for (const sessionId of frame.audienceSessions) sendSockets(this.socketsBySession.get(sessionId));
    } else {
      const audience = world.presenceActorsIn(frame.space);
      if (audience) {
        for (const actor of audience) sendSockets(this.socketsByActor.get(actor));
      }
    }
    this.mcpGateway?.routeAppliedFrame(publicFrame, originMcpSessionId ?? null);
    world.recordMetric({ kind: "broadcast", audience_size: audienceSize, obs_count: frame.observations.length, ms: Date.now() - startedAt });
  }

  private async handleAppliedFrame(world: WooWorld, frame: AppliedFrame, originator?: WebSocket, originMcpSessionId?: string | null): Promise<void> {
    if (this.durableHostKey() === WORLD_HOST) await this.registerIncrementalObjectRoutes(world);
    this.broadcastApplied(world, frame, originator, originMcpSessionId);
  }

  private broadcastLiveEvents(world: WooWorld, result: DirectResultFrame, originMcpSessionId?: string | null, originator?: WebSocket): void {
    const startedAt = Date.now();
    let audienceSize = 0;
    result.observations.forEach((observation, index) => {
      const frame: LiveEventFrame = { op: "event", observation };
      audienceSize += this.broadcastLiveEvent(
        world,
        frame,
        result.audience,
        result.observationAudiences?.[index] ?? result.audienceActors,
        result.observationSessionAudiences?.[index] ?? result.audienceSessions,
        originator
      );
    });
    this.mcpGateway?.routeLiveEvents(result, originMcpSessionId ?? null);
    world.recordMetric({ kind: "broadcast", audience_size: audienceSize, obs_count: result.observations.length, ms: Date.now() - startedAt });
  }

  private broadcastLiveEvent(world: WooWorld, frame: LiveEventFrame, audience: ObjRef | null, audienceActors?: ObjRef[], audienceSessions?: string[], originator?: WebSocket): number {
    const data = JSON.stringify(frame);
    const { to: directedTo, from: directedFrom } = directedRecipients(frame.observation);
    let delivered = 0;
    const sendAll = (sockets: Set<WebSocket> | undefined): void => {
      if (!sockets) return;
      for (const ws of sockets) {
        if (ws === originator) continue;
        delivered += 1;
        try { ws.send(data); } catch { /* gone */ }
      }
    };
    if (directedTo || directedFrom) {
      if (directedTo) sendAll(this.socketsByActor.get(directedTo));
      if (directedFrom && directedFrom !== directedTo) sendAll(this.socketsByActor.get(directedFrom));
      return delivered;
    }
    if (audienceSessions) {
      for (const sessionId of audienceSessions) sendAll(this.socketsBySession.get(sessionId));
      // If every session lookup missed (typical when the space's
      // session_subscribers row contains stale/expired session IDs that no
      // longer have a live WebSocket on this DO), fall through to actor-keyed
      // delivery so live participants still receive room-wide events.
      if (delivered > 0) return delivered;
    }
    const actorsIter: Iterable<ObjRef> | null = audienceActors
      ? audienceActors
      : audience
        ? world.presenceActorsIn(audience)
        : null;
    if (!actorsIter) return delivered;
    for (const actor of actorsIter) sendAll(this.socketsByActor.get(actor));
    return delivered;
  }

}

// ---- module-scoped helpers ----

function browserActivityMetricFromPayload(raw: unknown, session: Session): MetricEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (input.kind !== "browser_activity") return null;
  const phase = boundedString(input.phase);
  if (!phase) return null;
  const source = input.source === "main" ? "main" : "v2_browser_worker";
  const status = input.status === "error" ? "error" : "ok";
  const ms = nonNegativeNumber(input.ms) ?? 0;
  return {
    kind: "browser_activity",
    source,
    phase,
    actor: session.actor,
    ms,
    status,
    ...(boundedString(input.scope) ? { scope: boundedString(input.scope)! as ObjRef } : {}),
    ...(boundedString(input.node) ? { node: boundedString(input.node)! } : {}),
    ...(boundedString(input.route) ? { route: boundedString(input.route)! } : {}),
    ...(boundedString(input.method) ? { method: boundedString(input.method)! } : {}),
    ...(boundedString(input.path) ? { path: boundedString(input.path)! } : {}),
    ...(boundedString(input.what) ? { what: boundedString(input.what)! } : {}),
    ...(boundedString(input.reason) ? { reason: boundedString(input.reason)! } : {}),
    ...(nonNegativeNumber(input.count) !== undefined ? { count: nonNegativeNumber(input.count)! } : {}),
    ...(nonNegativeNumber(input.bytes) !== undefined ? { bytes: nonNegativeNumber(input.bytes)! } : {}),
    ...(nonNegativeNumber(input.records) !== undefined ? { records: nonNegativeNumber(input.records)! } : {}),
    ...(boundedString(input.transfer_mode) ? { transfer_mode: boundedString(input.transfer_mode)! } : {}),
    ...(input.executable_transfer_cache === "hit" || input.executable_transfer_cache === "miss" ? { executable_transfer_cache: input.executable_transfer_cache } : {}),
    ...(boundedString(input.error) ? { error: boundedString(input.error)! } : {}),
    ...(boundedString(input.error_detail) ? { error_detail: boundedString(input.error_detail)! } : {})
  };
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_BROWSER_METRIC_STRING ? trimmed.slice(0, MAX_BROWSER_METRIC_STRING) : trimmed;
}

function nonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, value);
}

function metricNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return perf?.now ? perf.now() : Date.now();
}

function metricElapsed(startedAt: number): number {
  return Math.max(0, Math.round((metricNow() - startedAt) * 1000) / 1000);
}

function chunkTombstones(records: TombstoneRecord[], chunkSize: number): TombstoneRecord[][] {
  if (records.length === 0) return [[]]; // always send at least one batch with final=true
  const out: TombstoneRecord[][] = [];
  for (let i = 0; i < records.length; i += chunkSize) {
    out.push(records.slice(i, i + chunkSize));
  }
  return out;
}

function memoizeHostOperation<T>(cache: Map<string, Promise<unknown>>, key: string, load: () => Promise<T>): Promise<T> {
  const existing = cache.get(key);
  if (existing) return existing as Promise<T>;
  const promise = load();
  cache.set(key, promise as Promise<unknown>);
  return promise;
}

function workerRestRequest(request: Request, pathname: string): RestProtocolRequest {
  const url = new URL(request.url);
  return {
    method: request.method,
    pathname,
    query: (name) => url.searchParams.get(name),
    header: (name) => request.headers.get(name),
    readJson: () => readJsonBody(request)
  };
}

function sqlRows<T>(cursor: unknown): T[] {
  if (cursor && typeof cursor === "object" && "toArray" in cursor && typeof cursor.toArray === "function") {
    return cursor.toArray() as T[];
  }
  return Array.from(cursor as Iterable<T>);
}

function firstSqlRow<T>(cursor: unknown): T | null {
  return sqlRows<T>(cursor)[0] ?? null;
}

function envFlag(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}

function nonNegativeIntegerEnv(value: string | undefined, fallback: number): number {
  const raw = Number(value ?? fallback);
  return Number.isInteger(raw) && raw >= 0 ? raw : fallback;
}

function isSessionToolManifest(value: unknown): value is SessionToolManifest {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === "woo.session_tool_manifest.v1" &&
    typeof (value as { session_id?: unknown }).session_id === "string" &&
    typeof (value as { actor?: unknown }).actor === "string" &&
    typeof (value as { active_scope?: unknown }).active_scope === "string" &&
    Array.isArray((value as { tools?: unknown }).tools)
  );
}

function isToolSurfaceProjectionRow(value: unknown): value is ToolSurfaceProjectionRow {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === "woo.tool_surface_projection.v1" &&
    typeof (value as { scope?: unknown }).scope === "string" &&
    typeof (value as { object?: unknown }).object === "string" &&
    Array.isArray((value as { verbs?: unknown }).verbs)
  );
}

function coalesceToolSurfaceSourceRows(rows: ToolSurfaceProjectionRow["source_rows"]): ToolSurfaceProjectionRow["source_rows"] {
  const byKey = new Map<string, ToolSurfaceProjectionRow["source_rows"][number]>();
  for (const row of rows) {
    byKey.set(`${row.table}\u0000${row.authority_scope}\u0000${row.key}`, row);
  }
  return Array.from(byKey.values()).sort((left, right) =>
    `${left.table}\u0000${left.authority_scope}\u0000${left.key}`.localeCompare(`${right.table}\u0000${right.authority_scope}\u0000${right.key}`)
  );
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  if (status === 304) return new Response(null, { status, headers });
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}

type BytecodeHashEntry = { object: ObjRef; verb: string; hash: string };
type BytecodeReservoirEntry = { hash: string; bytecode: TinyBytecode };
type BytecodeReservoir = Map<ObjRef, Map<string, BytecodeReservoirEntry>>;
type HostSeedKvRestoreMissReason = Extract<MetricEvent, { kind: "host_seed_kv_restore_miss" }>["reason"];
type KvRestoreResult<T> = { ok: true; value: T } | { ok: false; reason: HostSeedKvRestoreMissReason };
type ReservoirLookupResult = { ok: true; bytecode: TinyBytecode } | { ok: false; reason: "hash_mismatch" | "reservoir_miss" };

// Module scope here is per Worker isolate, not global across Cloudflare.
// Each isolate rebuilds this reservoir at most once per auto-install catalog
// config, which keeps repeated bytecode-free KV restores from reinstalling
// bundled catalogs while making the one-time build cost observable.
const localCatalogReservoirs = new Map<string, BytecodeReservoir>();
const hostSeedKvNamespaces = new Map<string, string>();

function hostSeedKvNamespace(env: Env): string {
  const key = `${env.WOO_AUTO_INSTALL_CATALOGS ?? "<default>"}:${LOCAL_CATALOG_BUNDLE_REPAIR_EPOCH}`;
  const cached = hostSeedKvNamespaces.get(key);
  if (cached) return cached;
  const namespace = `${localCatalogBundleFingerprint(parseAutoInstallCatalogs(env.WOO_AUTO_INSTALL_CATALOGS))}:${LOCAL_CATALOG_BUNDLE_REPAIR_EPOCH}`;
  hostSeedKvNamespaces.set(key, namespace);
  return namespace;
}

function hostSeedPointerKey(env: Env, host: ObjRef): string {
  return `seed-current:${hostSeedKvNamespace(env)}:${host}`;
}

function hostSeedBytesKey(env: Env, host: ObjRef, digest: string): string {
  return `seed:${hostSeedKvNamespace(env)}:${host}:${digest}`;
}

function bytecodeFreeHostSeedKvPayload(seed: SeedWorld, digest: string): Record<string, unknown> {
  const stripped = stripBytecodeForKv(seed);
  return {
    kind: HOST_SEED_KV_KIND,
    digest,
    seed: stripped.world,
    bytecode_hashes: stripped.bytecodeHashes
  };
}

function restoreHostSeedKvPayload(
  value: unknown,
  expectedDigest: string,
  localSeedSource: SerializedWorld | null,
  env: Env,
  emitMetric?: (event: MetricEvent) => void
): KvRestoreResult<SeedWorld> {
  if (!isPlainRecord(value)) return { ok: false, reason: "invalid_payload" };
  if (value.kind === HOST_SEED_KV_KIND) {
    if (value.digest !== expectedDigest) return { ok: false, reason: "digest_mismatch" };
    if (!isSeedWorld(value.seed)) return { ok: false, reason: "invalid_payload" };
    if (!isBytecodeHashEntries(value.bytecode_hashes)) return { ok: false, reason: "invalid_bytecode_hashes" };
    const restored = restoreBytecodeFreeWorld(value.seed, value.bytecode_hashes, localSeedSource, env, emitMetric);
    return restored.ok && !isSeedWorld(restored.value) ? { ok: false, reason: "invalid_payload" } : restored;
  }
  if (value.digest !== expectedDigest) return { ok: false, reason: "digest_mismatch" };
  if (isSeedWorld(value.seed)) {
    return serializedWorldHasCompleteBytecode(value.seed)
      ? { ok: true, value: value.seed }
      : { ok: false, reason: "incomplete_legacy_bytecode" };
  }
  return { ok: false, reason: "invalid_payload" };
}

function stripBytecodeForKv<T extends SerializedWorld>(world: T): { world: T; bytecodeHashes: BytecodeHashEntry[] } {
  const bytecodeHashes: BytecodeHashEntry[] = [];
  const objects = world.objects.map((obj) => {
    const verbs = obj.verbs.map((verb) => {
      if (verb.kind !== "bytecode") return { ...verb, line_map: {} };
      bytecodeHashes.push({ object: obj.id, verb: verb.name, hash: hashTinyBytecode(verb.bytecode) });
      const { bytecode: _bytecode, ...withoutBytecode } = verb;
      return { ...withoutBytecode, line_map: {} } as unknown as VerbDef;
    });
    return { ...obj, verbs };
  });
  return { world: { ...world, objects } as T, bytecodeHashes };
}

function restoreBytecodeFreeWorld<T extends SerializedWorld>(
  world: T,
  bytecodeHashes: BytecodeHashEntry[],
  localSeedSource: SerializedWorld | null,
  env: Env,
  emitMetric?: (event: MetricEvent) => void
): KvRestoreResult<T> {
  const localReservoir = bytecodeReservoirFromSerializedWorld(localSeedSource);
  const localOnly = restoreBytecodeFreeWorldFromReservoirs(world, bytecodeHashes, [localReservoir]);
  if (localOnly.ok) return localOnly;
  if (localOnly.reason !== "reservoir_miss" && localOnly.reason !== "hash_mismatch") return localOnly;
  const withCatalog = restoreBytecodeFreeWorldFromReservoirs(world, bytecodeHashes, [localReservoir, localCatalogBytecodeReservoir(env, emitMetric)]);
  if (withCatalog.ok) return withCatalog;
  return localOnly.reason === "hash_mismatch" && withCatalog.reason === "reservoir_miss" ? localOnly : withCatalog;
}

function restoreBytecodeFreeWorldFromReservoirs<T extends SerializedWorld>(
  world: T,
  bytecodeHashes: BytecodeHashEntry[],
  reservoirs: readonly BytecodeReservoir[]
): KvRestoreResult<T> {
  const expectedHashes = new Map(bytecodeHashes.map((entry) => [bytecodeHashKey(entry.object, entry.verb), entry.hash]));
  if (expectedHashes.size !== bytecodeHashes.length) return { ok: false, reason: "duplicate_bytecode_hash" };
  const objects: SerializedObject[] = [];
  for (const obj of world.objects) {
    const verbs: VerbDef[] = [];
    for (const verb of obj.verbs) {
      const raw = verb as unknown as Record<string, unknown>;
      const line_map = isPlainRecord(raw.line_map) ? structuredClone(raw.line_map) as Record<string, WooValue> : {};
      if (raw.kind !== "bytecode") {
        verbs.push({ ...verb, line_map } as VerbDef);
        continue;
      }
      const name = typeof raw.name === "string" ? raw.name : "";
      const expected = expectedHashes.get(bytecodeHashKey(obj.id, name));
      if (!expected) return { ok: false, reason: "missing_bytecode_hash" };
      if (isTinyBytecode(raw.bytecode)) {
        if (hashTinyBytecode(raw.bytecode) !== expected) return { ok: false, reason: "inline_hash_mismatch" };
        // Inline bytecode is owned by this freshly-parsed payload; freeze it in
        // place and share rather than clone (bytecode is immutable; importWorld
        // shares frozen bytecode by reference instead of deep-copying it).
        verbs.push({ ...verb, line_map, bytecode: freezeTinyBytecode(raw.bytecode) } as VerbDef);
        continue;
      }
      const lookup = findReservoirBytecode(reservoirs, obj.id, name, expected);
      if (!lookup.ok) return { ok: false, reason: lookup.reason };
      // Reservoir bytecode is already frozen at reservoir-build time and shared
      // across every world restored in this isolate — hand back the reference.
      verbs.push({ ...verb, line_map, bytecode: lookup.bytecode } as VerbDef);
    }
    objects.push({ ...obj, verbs });
  }
  return { ok: true, value: { ...world, objects } as T };
}

function bytecodeReservoirFromSerializedWorld(world: SerializedWorld | null): BytecodeReservoir {
  const reservoir: BytecodeReservoir = new Map();
  if (!world) return reservoir;
  for (const obj of world.objects) {
    for (const verb of obj.verbs) {
      if (verb.kind !== "bytecode" || !isTinyBytecode((verb as unknown as Record<string, unknown>).bytecode)) continue;
      let objectVerbs = reservoir.get(obj.id);
      if (!objectVerbs) {
        objectVerbs = new Map();
        reservoir.set(obj.id, objectVerbs);
      }
      // Freeze once at reservoir-build time so every world that restores from
      // this module-global reservoir can share the bytecode object by reference
      // without a defensive clone, and so accidental mutation throws.
      objectVerbs.set(verb.name, { hash: hashTinyBytecode(verb.bytecode), bytecode: freezeTinyBytecode(verb.bytecode) });
    }
  }
  return reservoir;
}

function localCatalogBytecodeReservoir(env: Env, emitMetric?: (event: MetricEvent) => void): BytecodeReservoir {
  const key = env.WOO_AUTO_INSTALL_CATALOGS ?? "<default>";
  const cached = localCatalogReservoirs.get(key);
  if (cached) return cached;
  const startedAt = Date.now();
  try {
    const world = createWorld({ catalogs: parseAutoInstallCatalogs(env.WOO_AUTO_INSTALL_CATALOGS) });
    const reservoir = bytecodeReservoirFromSerializedWorld(world.exportWorld());
    localCatalogReservoirs.set(key, reservoir);
    emitMetric?.({
      kind: "kv_catalog_reservoir_build",
      catalog_key: key,
      ms: Date.now() - startedAt,
      status: "ok",
      objects: world.objects.size,
      verbs: bytecodeReservoirVerbCount(reservoir)
    });
    return reservoir;
  } catch (err) {
    emitMetric?.({ kind: "kv_catalog_reservoir_build", catalog_key: key, ms: Date.now() - startedAt, status: "error", ...metricErrorFields(err) });
    throw err;
  }
}

function findReservoirBytecode(
  reservoirs: readonly BytecodeReservoir[],
  object: ObjRef,
  verb: string,
  expectedHash: string
): ReservoirLookupResult {
  let foundDifferentHash = false;
  for (const reservoir of reservoirs) {
    const entry = reservoir.get(object)?.get(verb);
    if (!entry) continue;
    if (entry.hash === expectedHash) return { ok: true, bytecode: entry.bytecode };
    foundDifferentHash = true;
  }
  return { ok: false, reason: foundDifferentHash ? "hash_mismatch" : "reservoir_miss" };
}

function bytecodeReservoirVerbCount(reservoir: BytecodeReservoir): number {
  let count = 0;
  for (const verbs of reservoir.values()) count += verbs.size;
  return count;
}

function serializedWorldHasCompleteBytecode(world: SerializedWorld): boolean {
  for (const obj of world.objects) {
    for (const verb of obj.verbs) {
      const raw = verb as unknown as Record<string, unknown>;
      if (raw.kind === "bytecode" && !isTinyBytecode(raw.bytecode)) return false;
    }
  }
  return true;
}

function isBytecodeHashEntries(value: unknown): value is BytecodeHashEntry[] {
  return Array.isArray(value) && value.every((entry) =>
    isPlainRecord(entry) &&
    typeof entry.object === "string" &&
    typeof entry.verb === "string" &&
    typeof entry.hash === "string" &&
    entry.hash.length > 0
  );
}

function isTinyBytecode(value: unknown): value is TinyBytecode {
  if (!isPlainRecord(value)) return false;
  return Array.isArray(value.ops) &&
    Array.isArray(value.literals) &&
    Number.isInteger(value.num_locals) &&
    Number.isInteger(value.max_stack) &&
    Number.isInteger(value.version);
}

function hashTinyBytecode(bytecode: TinyBytecode): string {
  return hashSource(canonicalKvJsonStringify(bytecode));
}

function bytecodeHashKey(object: ObjRef, verb: string): string {
  return `${object}\u0000${verb}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function canonicalKvJsonStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalKvJsonStringify).join(",") + "]";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + canonicalKvJsonStringify(record[key])).join(",") + "}";
  }
  return "null";
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-length") === "0") return {};
  try {
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) throw wooError("E_RATE", `request body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
    const raw = await request.arrayBuffer();
    if (raw.byteLength > MAX_JSON_BODY_BYTES) throw wooError("E_RATE", `request body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
    const parsed = raw.byteLength === 0 ? {} : JSON.parse(new TextDecoder().decode(raw));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return {};
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) throw err;
    return {};
  }
}

function isSerializedWorld(value: unknown): value is SerializedWorld {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<Record<keyof SerializedWorld, unknown>>;
  return Array.isArray(candidate.objects) &&
    Array.isArray(candidate.sessions) &&
    Array.isArray(candidate.logs) &&
    Array.isArray(candidate.snapshots) &&
    Array.isArray(candidate.parkedTasks);
}

/** A SeedWorld must validate as a SerializedWorld AND carry an
 * `objectHosts` map with an entry for every `objects[i].id`, per
 * spec/protocol/host-seeds.md §HS1. Missing entries would be treated
 * as foreign-hosted by the merge and could overwrite receiver-
 * authoritative state, so coverage is enforced at the boundary. */
/** A satellite's on-disk slice is "host-scoped" once it carries the
 * 2026-04-30 catalog-placement marker — i.e. the host's own object has a
 * host_placement="self" property recorded. Pre-migration stored worlds
 * lack it; those need the recovery re-scope path. The gateway slice
 * (hostKey === WORLD_HOST) is always treated as host-scoped: its
 * authoritative full universe is the source of every host's seed and
 * never needs trimming. */
function storedSliceIsHostScoped(stored: SerializedWorld, hostKey: ObjRef): boolean {
  if (hostKey === WORLD_HOST) return true;
  const hostObj = stored.objects.find((obj) => obj.id === hostKey);
  if (!hostObj) return false;
  for (const [name, value] of hostObj.properties) {
    if (name === "host_placement" && value === "self") return true;
  }
  return false;
}

function isSeedWorld(value: unknown): value is SeedWorld {
  if (!isSerializedWorld(value)) return false;
  const candidate = value as Partial<Record<"objectHosts", unknown>>;
  if (candidate.objectHosts === null || typeof candidate.objectHosts !== "object" || Array.isArray(candidate.objectHosts)) return false;
  const objectHosts = candidate.objectHosts as Record<string, unknown>;
  for (const obj of (value as SerializedWorld).objects) {
    if (typeof objectHosts[obj.id] !== "string" || (objectHosts[obj.id] as string).length === 0) return false;
  }
  return true;
}

function isReadAvailabilityError(err: unknown): boolean {
  const error = normalizeError(err);
  return error.code === "E_TIMEOUT" || error.code === "E_OBJNF";
}

function sessionActiveScope(record: Record<string, unknown>): ObjRef | undefined {
  return (sessionActiveScopeFromRecord(record) as ObjRef | null) ?? undefined;
}

function v2SocketEnvelopeAuthorityObjectIds(encoded: string, fallbackScope: ObjRef, fallbackActor: ObjRef): ObjRef[] {
  try {
    const envelope = decodeEnvelope(encoded);
    const body = envelope.body;
    if (!isRecord(body)) return executorAuthorityObjectIds({ scope: fallbackScope, actor: fallbackActor }, fallbackScope);
    const call = isRecord(body.call) ? body.call : null;
    const scope = objRefFromUnknown(call?.scope) ?? objRefFromUnknown(body.scope) ?? fallbackScope;
    const target = objRefFromUnknown(call?.target) ?? objRefFromUnknown(body.target);
    const actor = objRefFromUnknown(call?.actor) ?? objRefFromUnknown(envelope.actor) ?? fallbackActor;
    const args = Array.isArray(call?.args)
      ? call.args as WooValue[]
      : Array.isArray(body.args)
      ? body.args as WooValue[]
      : undefined;
    const requestBody = isRecord(call?.body)
      ? call.body as Record<string, WooValue>
      : isRecord(body.body)
      ? body.body as Record<string, WooValue>
      : undefined;
    return executorAuthorityObjectIds({ scope, target, actor, args, body: requestBody }, fallbackScope);
  } catch {
    return executorAuthorityObjectIds({ scope: fallbackScope, actor: fallbackActor }, fallbackScope);
  }
}

function localActorAuthorityRootIds(world: WooWorld, explicitIds: readonly ObjRef[], options: { sessionActorsOnly?: boolean } = {}): Set<ObjRef> {
  const roots = new Set<ObjRef>();
  const sessionActors = new Set(Array.from(world.sessions.values(), (session) => session.actor));
  for (const id of explicitIds) {
    if (!world.objects.has(id)) continue;
    if (sessionActors.has(id)) {
      roots.add(id);
      continue;
    }
    // Sparse MCP gateway shards carry room/scope stubs before owner authority
    // arrives. Walking their catalog lineage just to ask "is this an actor?"
    // records noisy dangling_parent_ref metrics and can misclassify stale rows.
    // Session actors are the only live cells the shard owns; non-session actor
    // discovery remains available to full hosts where the lineage is complete.
    if (!options.sessionActorsOnly && world.isDescendantOf(id, "$actor")) roots.add(id);
  }
  return roots;
}

function mcpGatewayLocalAuthorityPayload(
  world: WooWorld,
  explicitIds: readonly ObjRef[],
  actorRoots: ReadonlySet<ObjRef>
): ExecutorAuthorityPayload {
  const localIds = new Set<ObjRef>();
  for (const id of explicitIds) {
    // Session actor stubs on sparse MCP shards are not owner authority for
    // identity/name/property cells. They are patched below as live/projection
    // support; the explicit actor root must still resolve through Directory.
    if (actorRoots.has(id)) continue;
    // Bootstrap actor/thing support rows are deliberately resident on every
    // MCP shard. Scope/room rows are not: their catalog lineage belongs to the
    // owner slice, and exporting a stale local stub before owner repair is the
    // dangling_parent_ref storm this path is designed to avoid.
    if (id.startsWith("$") && world.objects.has(id)) localIds.add(id);
    else if (localObjectLineageIsComplete(world, id)) localIds.add(id);
  }
  const sessions = world.exportSessions();
  const authority = world.exportAuthoritySlice([], localIds);
  return {
    sessions,
    session_objects: [],
    authority: { ...authority, sessions }
  };
}

function localObjectLineageIsComplete(world: WooWorld, id: ObjRef): boolean {
  let current: ObjRef | null = id;
  const seen = new Set<ObjRef>();
  while (current) {
    if (seen.has(current)) return false;
    seen.add(current);
    const obj = world.objects.get(current);
    if (!obj) return false;
    current = obj.parent;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objRefFromUnknown(value: unknown): ObjRef | undefined {
  return typeof value === "string" && value.length > 0 ? value as ObjRef : undefined;
}

function isMcpGatewayShardHost(hostKey: string): boolean {
  return hostKey.startsWith(MCP_GATEWAY_SHARD_PREFIX);
}

function mcpSessionIdFromNode(node: string): string | null {
  return node.startsWith("mcp:") ? node.slice("mcp:".length) || null : null;
}

function mcpGatewayShardHost(env: Env, sessionId: string): string {
  const shards = mcpGatewayShardCount(env);
  return `${MCP_GATEWAY_SHARD_PREFIX}${stableHash(sessionId) % shards}`;
}

function mcpGatewayShardCount(env: Env): number {
  const raw = Number(env.WOO_MCP_GATEWAY_SHARDS ?? DEFAULT_MCP_GATEWAY_SHARDS);
  return Number.isInteger(raw) && raw > 0 && raw <= 256 ? raw : DEFAULT_MCP_GATEWAY_SHARDS;
}

let mcpGatewayActorSupportObjectsCache: SerializedObject[] | null = null;

function mcpGatewayActorSupportObjects(): SerializedObject[] {
  if (!mcpGatewayActorSupportObjectsCache) {
    const snapshot = createWorld({ catalogs: false }).exportWorld();
    const byId = new Map(snapshot.objects.map((obj) => [obj.id, obj] as const));
    // Closure of MCP_GATEWAY_ACTOR_SUPPORT_ROOTS: each root's full class subtree
    // (so any actor subclass an actor instance is parented at resolves) plus the
    // ancestor chain to the lineage top (so the chain never dangles partway).
    const ids = new Set<ObjRef>();
    const subtree = [...MCP_GATEWAY_ACTOR_SUPPORT_ROOTS];
    while (subtree.length > 0) {
      const id = subtree.pop()!;
      if (ids.has(id)) continue;
      ids.add(id);
      for (const child of byId.get(id)?.children ?? []) subtree.push(child);
    }
    for (const root of MCP_GATEWAY_ACTOR_SUPPORT_ROOTS) {
      let current: ObjRef | null = byId.get(root)?.parent ?? null;
      while (current && !ids.has(current)) {
        ids.add(current);
        current = byId.get(current)?.parent ?? null;
      }
    }
    mcpGatewayActorSupportObjectsCache = snapshot.objects
      .filter((obj) => ids.has(obj.id))
      .map((obj) => {
        const clone = structuredClone(obj) as SerializedObject;
        clone.children = clone.children.filter((id) => ids.has(id));
        clone.contents = [];
        return clone;
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  return mcpGatewayActorSupportObjectsCache.map((obj) => structuredClone(obj) as SerializedObject);
}

function mcpGatewayShardSerializedWorld(sessions: readonly DirectorySerializedSession[]): SerializedWorld {
  const now = Date.now();
  const objects = new Map<ObjRef, SerializedObject>();
  // Shards must expose the actor's own MCP control tools (wait/focus/list)
  // immediately after cold-load. Carry only the universal actor lineage that
  // defines those verbs, not the full gateway world.
  for (const obj of mcpGatewayActorSupportObjects()) objects.set(obj.id, obj);
  const scopeContents = new Map<ObjRef, Set<ObjRef>>();
  const actors = new Map<ObjRef, {
    activeScope: ObjRef | null;
    actorProps: DirectorySessionActorProp[];
    displayName: string | null;
    focusList: ObjRef[];
    primaryStarted: number;
    primarySession: string;
  }>();
  for (const session of sessions) {
    const activeScope = session.activeScope ?? session.currentLocation ?? null;
    const actor = actors.get(session.actor) ?? {
      activeScope,
      actorProps: [],
      displayName: session.displayName ?? null,
      focusList: [],
      primaryStarted: session.started,
      primarySession: session.id
    };
    actor.actorProps = mergeDirectoryActorProps(actor.actorProps, session.actorProps ?? []);
    if (!actor.displayName && session.displayName) actor.displayName = session.displayName;
    for (const id of session.focusList ?? []) {
      if (!actor.focusList.includes(id) && actor.focusList.length < 32) actor.focusList.push(id);
    }
    if (session.started < actor.primaryStarted || (session.started === actor.primaryStarted && session.id < actor.primarySession)) {
      actor.activeScope = activeScope;
      actor.primaryStarted = session.started;
      actor.primarySession = session.id;
    }
    actors.set(session.actor, actor);
    if (activeScope) {
      const contents = scopeContents.get(activeScope) ?? new Set<ObjRef>();
      contents.add(session.actor);
      scopeContents.set(activeScope, contents);
    }
  }
  for (const [actor, stub] of actors) {
    objects.set(actor, mcpGatewayStubObject({
      id: actor,
      name: stub.displayName ?? actor,
      parent: "$player",
      owner: actor,
      location: stub.activeScope,
      properties: mcpGatewayActorStubProperties(actor, stub),
      now
    }));
  }
  for (const [scope, contents] of scopeContents) {
    if (objects.has(scope)) continue;
    objects.set(scope, mcpGatewayStubObject({
      id: scope,
      name: scope,
      parent: "$space",
      owner: "$wiz",
      location: null,
      contents: Array.from(contents).sort(),
      now
    }));
  }
  return {
    version: 1,
    objectCounter: 1,
    parkedTaskCounter: 1,
    sessionCounter: 1,
    objects: Array.from(objects.values()).sort((a, b) => a.id.localeCompare(b.id)),
    sessions: sessions.map((session) => structuredClone(session) as SerializedSession),
    logs: [],
    snapshots: [],
    parkedTasks: [],
    tombstones: []
  };
}

function mcpGatewayDirectorySessionCellSlice(sessions: readonly DirectorySerializedSession[], hostKey: string): SerializedAuthorityCellSlice {
  const snapshot = mcpGatewayShardSerializedWorld(sessions);
  const sessionActors = new Set<ObjRef>(sessions.map((session) => session.actor));
  const actorObjects = snapshot.objects.filter((obj) => sessionActors.has(obj.id));
  const actorLineagePages: ShadowStatePage[] = actorObjects.flatMap((obj) => [
    shadowObjectLineagePage(obj),
    ...shadowPropertyCellPages(obj)
  ]);
  const actorLivePlaceholders: ShadowStatePage[] = actorObjects.map((obj) => shadowObjectLivePage({
    ...obj,
    location: null,
    children: [],
    contents: []
  }));
  const scopeLivePages: ShadowStatePage[] = snapshot.objects
    .filter((obj) => !sessionActors.has(obj.id) && obj.contents.length > 0)
    .map((obj) => shadowObjectLivePage(obj));
  const inlinePages = [...actorLineagePages, ...actorLivePlaceholders, ...scopeLivePages];
  // A3: these pages are synthesized from Directory route records, not from the
  // object owner's live state — Directory publishes session/presence/projection
  // rows (CA12.1). Actor lineage/properties and scope contents are projection
  // provenance. Actor live pages are only empty fallback placeholders: they let
  // sparse planning admit a peer actor's identity without treating Directory's
  // possibly-stale current-location hint as movement truth. Accepted-frame/cache
  // rows and owner rows outrank them.
  const provenance: AuthorityPageProvenance = { source: "projection", source_host: hostKey };
  const actorLivePlaceholderProvenance: AuthorityPageProvenance = { source: "fallback", source_host: hostKey };
  return {
    kind: "woo.authority_slice.cells.shadow.v1",
    sessions: [],
    page_refs: inlinePages.map((page) => stampAuthorityPageRef(
      page,
      true,
      page.page === "object_live" && sessionActors.has(page.object) ? actorLivePlaceholderProvenance : provenance
    )),
    inline_pages: inlinePages,
    counters: {
      objectCounter: 1,
      parkedTaskCounter: 1,
      sessionCounter: 1
    },
    tombstones: [],
    source_object_count: actorObjects.length + scopeLivePages.length
  };
}

function directContentIdsFromAuthoritySlice(
  authority: SerializedAuthoritySlice,
  roots: readonly ObjRef[],
  limit: number
): ObjRef[] {
  const rootSet = new Set<ObjRef>(roots.filter((id): id is ObjRef => typeof id === "string" && id.length > 0));
  if (rootSet.size === 0 || limit <= 0) return [];
  const seen = new Set<ObjRef>(rootSet);
  const ids: ObjRef[] = [];
  const visitContents = (contents: readonly ObjRef[]): boolean => {
    for (const id of contents) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= limit) return false;
    }
    return true;
  };
  if (isAuthorityCellSlice(authority)) {
    for (const page of authority.inline_pages) {
      if (page.page !== "object_live" || !rootSet.has(page.object)) continue;
      if (!visitContents(page.contents)) return ids;
    }
    return ids;
  }
  for (const obj of authority.objects) {
    if (!rootSet.has(obj.id)) continue;
    if (!visitContents(obj.contents)) return ids;
  }
  return ids;
}

function mcpGatewayStubObject(input: {
  id: ObjRef;
  name: string;
  parent: ObjRef | null;
  owner: ObjRef;
  location: ObjRef | null;
  contents?: ObjRef[];
  properties?: DirectorySessionActorProp[];
  now: number;
}): SerializedObject {
  return {
    id: input.id,
    name: input.name,
    parent: input.parent,
    owner: input.owner,
    location: input.location,
    anchor: null,
    flags: {},
    created: input.now,
    modified: input.now,
    propertyDefs: [],
    properties: input.properties?.map((prop) => [prop.name, structuredClone(prop.value) as WooValue] as [string, WooValue]) ?? [],
    propertyVersions: input.properties?.map((prop) => [prop.name, prop.version] as [string, number]) ?? [],
    verbs: [],
    children: [],
    contents: input.contents ?? [],
    eventSchemas: []
  };
}

function mergeSerializedSessions(
  base: readonly SerializedSession[],
  overlay: readonly SerializedSession[]
): SerializedSession[] {
  const byId = new Map<string, SerializedSession>();
  for (const session of base) byId.set(session.id, structuredClone(session) as SerializedSession);
  for (const session of overlay) byId.set(session.id, structuredClone(session) as SerializedSession);
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function cloneDirectorySerializedSessions(sessions: readonly DirectorySerializedSession[]): DirectorySerializedSession[] {
  return sessions.map((session) => ({
    ...session,
    ...(session.displayName !== undefined ? { displayName: session.displayName } : {}),
    ...(session.focusList ? { focusList: [...session.focusList] } : {}),
    ...(session.actorProps ? { actorProps: cloneDirectoryActorProps(session.actorProps) } : {})
  }));
}

function serializedSessionFromDirectoryRoute(value: unknown): DirectorySerializedSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.session_id === "string"
    ? record.session_id
    : typeof record.id === "string"
      ? record.id
      : "";
  const actor = typeof record.actor === "string" ? record.actor as ObjRef : null;
  const expiresAt = Number(record.expires_at ?? record.expiresAt ?? 0);
  if (!id || !actor || !Number.isFinite(expiresAt) || expiresAt <= 0) return null;
  const activeScope = sessionActiveScopeFromRecord({
    active_scope: record.active_scope,
    current_location: record.current_location,
    activeScope: record.activeScope,
    currentLocation: record.currentLocation
  });
  return {
    id,
    actor,
    started: finitePositiveNumber(record.started) ?? finitePositiveNumber(record.updated_at) ?? Date.now(),
    expiresAt,
    lastDetachAt: null,
    tokenClass: record.token_class === "guest" || record.token_class === "apikey" ? record.token_class : "bearer",
    activeScope,
    currentLocation: activeScope,
    ...(typeof record.apikey_id === "string" && record.apikey_id.length > 0 ? { apikeyId: record.apikey_id } : {}),
    displayName: typeof record.display_name === "string" && record.display_name.length > 0 ? record.display_name : null,
    focusList: focusListFromUnknown(record.focus_list),
    actorProps: actorPropsFromUnknown(record.actor_props)
  };
}

function displayNameForDirectorySession(world: WooWorld | null, actor: ObjRef): string | null {
  if (!world?.objects.has(actor)) return null;
  const propName = world.propOrNull(actor, "name");
  if (typeof propName === "string" && propName.length > 0) return propName;
  const objectName = world.object(actor).name;
  return objectName && objectName !== actor ? objectName : null;
}

function focusListForDirectorySession(world: WooWorld | null, actor: ObjRef): ObjRef[] {
  if (!world?.objects.has(actor)) return [];
  const raw = world.propOrNull(actor, "focus_list");
  return focusListFromUnknown(raw);
}

function actorPropsForDirectorySession(world: WooWorld | null, actor: ObjRef): DirectorySessionActorProp[] {
  if (!world?.objects.has(actor)) return [];
  const obj = world.object(actor);
  const out: DirectorySessionActorProp[] = [];
  // Sparse MCP shards are restored from Directory without waking the actor's
  // owner. Carry the small actor-local property cells that catalog leave/focus
  // verbs read, including their versions, so placement commits validate against
  // the same actor authority the planner saw.
  for (const name of ["home", "focus_list"] as const) {
    if (!obj.properties.has(name)) continue;
    out.push({
      name,
      value: structuredClone(obj.properties.get(name)!) as WooValue,
      version: obj.propertyVersions.get(name) ?? 0
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function focusListFromUnknown(value: unknown): ObjRef[] {
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const out: ObjRef[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item.length === 0 || out.includes(item as ObjRef)) continue;
    out.push(item as ObjRef);
    if (out.length >= 32) break;
  }
  return out;
}

function actorPropsFromUnknown(value: unknown): DirectorySessionActorProp[] {
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return cloneDirectoryActorProps(raw.filter(isDirectoryActorProp));
}

function isDirectoryActorProp(value: unknown): value is DirectorySessionActorProp {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const version = Number(record.version);
  return typeof record.name === "string" &&
    record.name.length > 0 &&
    Number.isInteger(version) &&
    version >= 0;
}

function cloneDirectoryActorProps(props: readonly DirectorySessionActorProp[]): DirectorySessionActorProp[] {
  const byName = new Map<string, DirectorySessionActorProp>();
  for (const prop of props) {
    if (!prop.name || !Number.isInteger(prop.version) || prop.version < 0) continue;
    byName.set(prop.name, {
      name: prop.name,
      value: structuredClone(prop.value) as WooValue,
      version: prop.version
    });
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function mergeDirectoryActorProps(
  existing: readonly DirectorySessionActorProp[],
  incoming: readonly DirectorySessionActorProp[]
): DirectorySessionActorProp[] {
  const byName = new Map<string, DirectorySessionActorProp>();
  for (const prop of cloneDirectoryActorProps(existing)) byName.set(prop.name, prop);
  for (const prop of cloneDirectoryActorProps(incoming)) {
    const current = byName.get(prop.name);
    if (!current || prop.version >= current.version) byName.set(prop.name, prop);
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function mcpGatewayActorStubProperties(
  actor: ObjRef,
  stub: { actorProps: readonly DirectorySessionActorProp[]; focusList: readonly ObjRef[] }
): DirectorySessionActorProp[] {
  const props = mergeDirectoryActorProps([], stub.actorProps);
  const names = new Set(props.map((prop) => prop.name));
  if (!names.has("focus_list") && stub.focusList.length > 0) {
    props.push({ name: "focus_list", value: [...stub.focusList] as WooValue, version: 1 });
  }
  // Legacy Directory rows predate actor_props. Seeded guest actors have an own
  // home property at version 1; preserving that default avoids a sparse shard
  // planning against inherited version 0 while another relay still has the
  // versioned actor row.
  if (!names.has("home") && /^guest_\d+$/.test(actor)) {
    props.push({ name: "home", value: "$nowhere", version: 1 });
  }
  return props.sort((a, b) => a.name.localeCompare(b.name));
}

function mcpGatewayLocalActorPropertyCellSlice(
  world: WooWorld,
  actors: ReadonlySet<ObjRef>,
  hostKey: string
): SerializedAuthorityCellSlice {
  const inlinePages: ShadowStatePage[] = [];
  for (const obj of world.exportObjects(actors)) {
    inlinePages.push(...shadowPropertyCellPages(withMcpGatewayActorLocalProperties(obj)));
  }
  // Sparse MCP shards carry a small Directory-derived actor stub so leave/focus
  // verbs can plan before the owner slice arrives. These cells are support
  // material, not owner truth: actor identity/name and ordinary properties must
  // come from the actor's Directory-resolved owner when available.
  const provenance: AuthorityPageProvenance = { source: "projection", source_host: hostKey };
  return {
    kind: "woo.authority_slice.cells.shadow.v1",
    sessions: [],
    page_refs: inlinePages.map((page) => stampAuthorityPageRef(page, true, provenance)),
    inline_pages: inlinePages,
    counters: {
      objectCounter: 1,
      parkedTaskCounter: 1,
      sessionCounter: 1
    },
    tombstones: [],
    source_object_count: new Set(inlinePages.map((page) => page.object)).size
  };
}

function mcpGatewayLocalActorLiveCellSlice(
  world: WooWorld,
  actors: ReadonlySet<ObjRef>,
  hostKey: string
): SerializedAuthorityCellSlice {
  const inlinePages: ShadowStatePage[] = world.exportObjects(actors).map((obj) => shadowObjectLivePage(obj));
  // A3: the live (location) cell of a local session actor is exactly the cell
  // the gateway shard owns under actor-anchored movement (CA3). It is the
  // owner's authoritative row, stamped from this host.
  const provenance: AuthorityPageProvenance = { source: "authoritative", source_host: hostKey };
  return {
    kind: "woo.authority_slice.cells.shadow.v1",
    sessions: [],
    page_refs: inlinePages.map((page) => stampAuthorityPageRef(page, true, provenance)),
    inline_pages: inlinePages,
    counters: {
      objectCounter: 1,
      parkedTaskCounter: 1,
      sessionCounter: 1
    },
    tombstones: [],
    source_object_count: inlinePages.length
  };
}

function withMcpGatewayActorLocalProperties(obj: SerializedObject): SerializedObject {
  const clone = structuredClone(obj) as SerializedObject;
  const localNames = new Set(["home", "focus_list"]);
  clone.propertyDefs = clone.propertyDefs.filter((def) => localNames.has(def.name));
  clone.properties = clone.properties.filter(([name]) => localNames.has(name));
  clone.propertyVersions = clone.propertyVersions.filter(([name]) => localNames.has(name));
  if (/^guest_\d+$/.test(clone.id) && !clone.properties.some(([name]) => name === "home")) {
    clone.properties.push(["home", "$nowhere"]);
    clone.propertyVersions.push(["home", 1]);
  }
  return clone;
}

function v2ApplyCommitTranscriptScopeMatches(scope: ObjRef, commit: ShadowCommitAccepted, transcript: EffectTranscript): boolean {
  if (transcript.scope === scope) return true;
  // Actor-anchored movement commits at the moved object's location authority,
  // while the transcript keeps the user-visible VM scope that selected the
  // closure. Cross-scope apply is allowed only for that single-location CA3
  // commit owner; ordinary movement no longer uses a placement fence.
  return scope === commit.position.scope && shadowLocationCommitScopeForTranscript(transcript) === scope;
}

function mcpFanoutAudienceFromDirectorySessions(
  fallbackScope: ObjRef,
  observations: readonly Observation[],
  sessions: readonly DirectorySerializedSession[]
): McpFanoutAudience {
  const now = Date.now();
  const liveSessions = sessions.filter((session) => typeof session.expiresAt !== "number" || session.expiresAt > now);
  const allActors = new Set<ObjRef>();
  const allSessions = new Set<string>();
  const observationAudiences: ObjRef[][] = [];
  const observationSessionAudiences: string[][] = [];
  for (const observation of observations) {
    const actorTargets = mcpObservationActorTargets(observation);
    const sourceScope = typeof observation.source === "string" ? observation.source as ObjRef : fallbackScope;
    const scopeAudience = actorTargets.size === 0 ? sourceScope : null;
    const actors = new Set<ObjRef>();
    const sessionIds: string[] = [];
    for (const session of liveSessions) {
      const actorMatches = actorTargets.size > 0 && actorTargets.has(session.actor);
      const scopeMatches = scopeAudience !== null && (session.activeScope ?? session.currentLocation ?? null) === scopeAudience;
      if (!actorMatches && !scopeMatches) continue;
      if (mcpObservationExcludesActor(observation, session.actor)) continue;
      actors.add(session.actor);
      sessionIds.push(session.id);
      allActors.add(session.actor);
      allSessions.add(session.id);
    }
    observationAudiences.push(Array.from(actors).sort());
    observationSessionAudiences.push(Array.from(new Set(sessionIds)).sort());
  }
  return {
    audienceActors: allActors.size > 0 ? Array.from(allActors).sort() : undefined,
    observationAudiences: observations.length > 0 ? observationAudiences : undefined,
    audienceSessions: allSessions.size > 0 ? Array.from(allSessions).sort() : undefined,
    observationSessionAudiences: observations.length > 0 ? observationSessionAudiences : undefined
  };
}

function mcpObservationActorTargets(observation: Observation): Set<ObjRef> {
  const actors = new Set<ObjRef>();
  if ((observation.type === "looked" || observation.type === "who") && typeof observation.to === "string") {
    actors.add(observation.to as ObjRef);
  }
  if (typeof observation.target === "string") actors.add(observation.target as ObjRef);
  const directed = directedRecipients(observation);
  if (directed.to) actors.add(directed.to);
  if (directed.from) actors.add(directed.from);
  return actors;
}

function mcpObservationExcludesActor(observation: Observation, actor: ObjRef): boolean {
  return (observation.type === "entered" || observation.type === "left" || observation.type === "taken" || observation.type === "dropped") &&
    typeof observation.actor === "string" &&
    observation.actor === actor;
}

function mergeMcpFanoutAudience(primary: McpFanoutAudience, secondary: McpFanoutAudience): McpFanoutAudience {
  return {
    audienceActors: mergeStringList(primary.audienceActors, secondary.audienceActors) as ObjRef[] | undefined,
    audienceSessions: mergeStringList(primary.audienceSessions, secondary.audienceSessions),
    observationAudiences: mergeNestedStringLists(primary.observationAudiences, secondary.observationAudiences) as ObjRef[][] | undefined,
    observationSessionAudiences: mergeNestedStringLists(primary.observationSessionAudiences, secondary.observationSessionAudiences)
  };
}

function mergeStringList(a: readonly string[] | undefined, b: readonly string[] | undefined): string[] | undefined {
  const merged = Array.from(new Set([...(a ?? []), ...(b ?? [])].filter((item) => item.length > 0))).sort();
  return merged.length > 0 ? merged : undefined;
}

function mergeNestedStringLists(a: readonly (readonly string[])[] | undefined, b: readonly (readonly string[])[] | undefined): string[][] | undefined {
  const length = Math.max(a?.length ?? 0, b?.length ?? 0);
  if (length === 0) return undefined;
  const out: string[][] = [];
  for (let i = 0; i < length; i += 1) {
    out.push(mergeStringList(a?.[i], b?.[i]) ?? []);
  }
  return out;
}

function mcpFanoutAudienceSessionIds(audience: McpFanoutAudience): string[] {
  const ids = new Set<string>();
  for (const session of audience.audienceSessions ?? []) ids.add(session);
  for (const list of audience.observationSessionAudiences ?? []) {
    for (const session of list) ids.add(session);
  }
  return Array.from(ids).sort();
}

function mcpFanoutAudienceBody(audience: McpFanoutAudience): Record<string, WooValue> {
  return {
    ...(audience.audienceActors?.length ? { audience_actors: audience.audienceActors as unknown as WooValue } : {}),
    ...(audience.observationAudiences?.length ? { observation_audiences: audience.observationAudiences as unknown as WooValue } : {}),
    ...(audience.audienceSessions?.length ? { audience_sessions: audience.audienceSessions as unknown as WooValue } : {}),
    ...(audience.observationSessionAudiences?.length ? { observation_session_audiences: audience.observationSessionAudiences as unknown as WooValue } : {})
  };
}

function mcpFanoutAudienceFromBody(body: Record<string, unknown>): McpFanoutAudience | undefined {
  const audience: McpFanoutAudience = {
    audienceActors: stringListFromUnknown(body.audience_actors) as ObjRef[] | undefined,
    observationAudiences: nestedStringListFromUnknown(body.observation_audiences) as ObjRef[][] | undefined,
    audienceSessions: stringListFromUnknown(body.audience_sessions),
    observationSessionAudiences: nestedStringListFromUnknown(body.observation_session_audiences)
  };
  return audience.audienceActors || audience.observationAudiences || audience.audienceSessions || audience.observationSessionAudiences
    ? audience
    : undefined;
}

function stringListFromUnknown(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = Array.from(new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))).sort();
  return out.length > 0 ? out : undefined;
}

function nestedStringListFromUnknown(value: unknown): string[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => stringListFromUnknown(item) ?? []);
}

function finitePositiveNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function stableHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

async function workerHashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function logCatalogTapEvent(event: CatalogTapLogEvent): void {
  console.log("woo.catalog", JSON.stringify({ ...event, ts: Date.now() }));
}

export function v2FanoutEnvelopesByNode(fanout: Array<{ node: string; envelope: string }>): Map<string, string[]> {
  const byNode = new Map<string, string[]>();
  for (const item of fanout) {
    const envelopes = byNode.get(item.node);
    if (envelopes) envelopes.push(item.envelope);
    else byNode.set(item.node, [item.envelope]);
  }
  return byNode;
}

// Stable digest over a set of object routes. Used by registerObjectRoutes
// to compare the current published-route set against what was last
// persisted, so a cold-restart with an unchanged world skips the
// Directory register-objects RPC entirely. Triples are sorted by id and
// joined with delimiters that cannot appear in ObjRefs.
function hashRouteSet(routes: ReadonlyArray<{ id: ObjRef; host: string; anchor: ObjRef | null }>): string {
  const sorted = [...routes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const lines = sorted.map((route) => `${route.id}\t${route.host}\t${route.anchor ?? ""}`);
  return hashSource(lines.join("\n"));
}
