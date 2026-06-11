// CommitScopeDO is the durable home for v2 commit-scope state.
//
// The gateway remains the WebSocket edge, but every authority-bearing v2 turn
// envelope is handled here so commit head, catch-up tail, and reply idempotency
// survive gateway isolate hibernation. The shadow relay still runs in-process
// inside this DO. Storage is row-shaped rather than one large snapshot blob so
// hot envelope retries rewrite only the state families that actually changed.

import type { EffectTranscript } from "../core/effect-transcript";
import type { ShadowCapabilityAd } from "../core/capability-ad";
import { cellProvenanceFromAuthoritySlice, pruneSerializedSessionsWithoutActorRows, serializedWorldFromAuthoritySlice } from "../core/authority-slice";
import { createWorldFromSerialized } from "../core/bootstrap";
import { localCatalogBundleFingerprint, localCatalogMigrationIndexFingerprint, parseAutoInstallCatalogs, runHostScopedLocalCatalogLifecycle } from "../core/local-catalogs";
import type { SerializedAuthoritySlice, SerializedObject, SerializedSession, SerializedWorld } from "../core/repository";
import {
  applyShadowBrowserTransfer,
  buildShadowBrowserCatchupTransferForBrowser,
  buildShadowBrowserSessionAuth,
  createShadowBrowserClient,
  createShadowBrowserRelayShim,
  handleShadowBrowserTurnExecEnvelope,
  handleShadowBrowserStateTransferEnvelope,
  MAX_SHADOW_ACCEPTED_TAIL,
  MAX_SHADOW_IDEMPOTENCY_ENTRIES,
  MAX_SHADOW_RECENT_REPLIES_ENTRIES,
  MAX_SHADOW_TRANSCRIPT_TAIL,
  mergeShadowBrowserSessionState,
  openShadowBrowserScope,
  receiveShadowBrowserEnvelopeReceipt,
  setShadowBrowserSessionToken,
  shadowLiveEventMatchesBrowser,
  shadowLiveEventsForTranscript,
  shadowBrowserTransportHello,
  subscribeShadowBrowserNode,
  type ShadowBrowserEnvelopeReceipt,
  type ShadowBrowserStateTransfer,
  type ShadowTransportHello
} from "../core/shadow-browser-node";
import {
  shadowCommitScopeObject,
  shadowCommitScopeSession,
  serializedFor,
  transcriptLogEntry,
  transcriptSessionActiveScope,
  transcriptTouchedObjectIds,
  type ShadowCommitAccepted,
  type ShadowScopeHead
} from "../core/shadow-commit-scope";
import {
  markShadowBrowserRelaySerializedChanged,
  mergeAuthorityIntoRelayCache,
  type ShadowRelayCache
} from "../core/shadow-relay-cache";
import { hydrateShadowRelayTail } from "../core/shadow-relay-tail";
import { encodeEnvelope, type ShadowEnvelope } from "../core/shadow-envelope";
import { stableShadowJson } from "../core/shadow-cell-version";
import { hashSource } from "../core/source-hash";
import type { ShadowTurnExecReply } from "../core/shadow-turn-exec";
import type { MetricEvent, ObjRef, WooValue } from "../core/types";
import { wooError } from "../core/types";
import { statusForError } from "../core/protocol";
import { normalizeError } from "../core/world";
import {
  browserProfileOpenTransferFromAuthority,
  browserProfileProjectionContext,
  browserProfileProjectionWriteFromAuthority,
  summarizeProjectionWrites,
  type AcceptedFrameTransfer,
  type BrowserProfile,
  type OpenContinuation,
  type OpenTransfer,
  type ProjectionDeltaSummary,
  type ProjectionPage,
  type ProjectionWrite,
  type ScopeCheckpoint
} from "../core/projection-delta";
import { V2_COMMIT_SCOPE_SNAPSHOT_REQUIRED, type ExecutionCapsule } from "../core/executor";
import {
  isShadowTurnExecReply,
  shadowReplyMetricKind,
  type ShadowEnvelopeReplyBody
} from "../core/v2-reply-predicates";
import { verifyInternalRequest, type InternalAuthEnv } from "./internal-auth";
import { metricErrorFields } from "./metric-errors";
import { writeMetricToAnalytics, writeConstructorMetricToAnalytics } from "./metrics-sink";
import { FaultInjector, KillAfterCommitError } from "./rpc-fault-inject";

const SHADOW_OPEN_EXECUTABLE_SEED_WARN_BYTES = 1_000_000;
// Per-table soft budget for the durable relay tail (accepted_frames and
// transcript_tail measured independently, so the combined ceiling is 2×).
//
// Retention policy (B-iv):
//   - The checkpoint floor is a HARD constraint: rows with seq > lastCheckpointSeq
//     are NEVER pruned, even when over budget. A rehydrating DO must be able to
//     replay all frames since the last durable checkpoint.
//   - Within the budget, the most-recent rows are kept; older rows (seq ≤
//     lastCheckpointSeq) are pruned when over budget or when too old.
//   - With WOO_V2_CHECKPOINT_BOUNDED at interval 32, the tail above the checkpoint
//     floor is bounded to at most 31 frames. Each frame is typically a few KB of
//     chat/action deltas; 31 × 50 KB ≈ 1.5 MB worst-case for covered frames.
//   - 4 MB per table (8 MB combined) keeps a generous buffer for bursty rooms
//     while ensuring covered frames are pruned quickly once a checkpoint fires.
//     Previously 16 MB; the deployed b7-tail run showed one active scope at
//     17.6 MB combined because covered frames were never pruned fast enough.
//
// Cursor-floor concern (D1 design brief):
//   v2_fanout_pending rows carry self-contained payloads (commit + transcript +
//   fanout list); the drain never reads from the CommitScopeDO relay tail. The
//   cursor-floor rule is therefore MOOT for this table — tail pruning cannot
//   outrun an in-flight D1 delivery. See notes/2026-06-10-b-iv-checkpoint-tail.md.
const SHADOW_TAIL_RETENTION_BYTES = 4 * 1024 * 1024;
// Age-based pruning: rows older than 1 hour can be pruned even if within the byte
// budget, provided they are below the checkpoint floor (covered by a checkpoint).
// 7 days was excessively generous; a DO typically rehydrates within seconds, and
// the checkpoint floor (not the age limit) provides the correctness guarantee.
const SHADOW_TAIL_RETENTION_MS = 60 * 60 * 1000;
const CHECKPOINT_TRANSFER_DEFAULT_BYTES = 512 * 1024;
const CHECKPOINT_TRANSFER_MAX_BYTES = 1024 * 1024;
const CHECKPOINT_PAGE_TARGET_BYTES = 512 * 1024;
const CHECKPOINT_CONTINUATION_TTL_MS = 5 * 60 * 1000;
const JSON_BYTES = new TextEncoder();
const COMMIT_SCOPE_SNAPSHOT_REPAIR_EPOCH = "commit-scope-catalog-repair-v1";

type CommitScopeEnv = InternalAuthEnv & {
  WOO_AUTO_INSTALL_CATALOGS?: string;
  // P1′ probe (2026-06-05): when set, on-commit checkpoint builds are gated by a
  // frame-count threshold instead of running on EVERY accepted commit. The
  // durable accepted-frame + transcript tail already covers cold catch-up; the
  // checkpoint is only a replay accelerator, so skipping it on most commits is
  // safe and lets us measure how much of the per-turn CommitScopeDO cpuTime the
  // full ~3MB checkpoint rebuild accounts for. Default (unset) preserves the
  // exact prior behavior (checkpoint every commit).
  WOO_V2_CHECKPOINT_BOUNDED?: string;
  // Frames between on-commit checkpoints when WOO_V2_CHECKPOINT_BOUNDED is on.
  // Set very high (e.g. 1000000) to measure the floor (effectively never
  // checkpoint on commit); set to a sane value (e.g. 32) as the actual fix.
  WOO_V2_CHECKPOINT_FRAME_INTERVAL?: string;
  // Authority-slimming probe (step 1): when on, emit a v2_envelope_bytes metric
  // breaking the request into authority / capsule-authority / sessions / envelope
  // bytes plus relay warmth. Off by default — it re-stringifies the large slice.
  WOO_V2_ENVELOPE_BYTE_BREAKDOWN?: string;
  // Fault injection configuration for RPC seam testing (worker/test layer only).
  // JSON array of FaultSpec objects; see src/worker/rpc-fault-inject.ts.
  // Never set in production. kill_after_commit fires here, post-durable-save,
  // before the /v2/envelope response is sent back to the gateway.
  WOO_FAULT_INJECT?: string;
};

type PersistedCheckpointPageRef = {
  kind: "woo.projection_page_ref.v1";
  page_index: number;
  table: ProjectionPage["table"];
  page: string;
  hash: string;
  bytes: number;
};

type PersistedCheckpointFrameRef = {
  seq: number;
  hash: string;
  bytes: number;
};

type PersistedScopeCheckpointManifest = {
  kind: "woo.scope_checkpoint_manifest.v1";
  scope: ObjRef;
  head: ShadowScopeHead;
  checkpoint_hash: string;
  pages: PersistedCheckpointPageRef[];
  frame_tail: PersistedCheckpointFrameRef[];
};

type LoadedScopeCheckpoint =
  | {
      storage: "manifest";
      scope: ObjRef;
      head: ShadowScopeHead;
      checkpoint_hash: string;
      page_refs: PersistedCheckpointPageRef[];
      frame_refs: PersistedCheckpointFrameRef[];
    }
  | {
      storage: "legacy";
      scope: ObjRef;
      head: ShadowScopeHead;
      checkpoint_hash: string;
      pages: ProjectionPage[];
      frame_tail: ShadowCommitAccepted[];
    };

export class CommitScopeDO {
  private relay: ShadowRelayCache | null = null;
  private snapshotLoaded = false;
  private needsFullSave = false;
  private relayInitPromise: Promise<ShadowRelayCache> | null = null;
  private fullSavePromise: Promise<void> | null = null;
  private checkpointBuildPromise: Promise<void> | null = null;
  // Authority-slimming probe (step 1): how the relay for the current request was
  // obtained — "snapshot" (rehydrated from this DO's own durable storage) or
  // "cold_seed" (built from the request's authority/serialized payload). Combined
  // with "relay already in memory" at the call site this classifies each envelope
  // as warm / snapshot-rehydrated / cold-seeded, the axis that decides whether the
  // ~3MB top-level authority in the request was actually needed.
  private lastRelayInitSource: "snapshot" | "cold_seed" | null = null;
  // Lazily-parsed fault injector for C1a kill_after_commit. Null until first
  // access; no-op when WOO_FAULT_INJECT is unset (production and default tests).
  private _faultInjector: FaultInjector | undefined = undefined;

  constructor(
    private readonly state: CommitScopeDurableState,
    private readonly env: CommitScopeEnv
  ) {
    const constructorStartedAt = Date.now();
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS v2_commit_scope_meta (id TEXT PRIMARY KEY, scope TEXT NOT NULL, relay_node TEXT NOT NULL, head TEXT NOT NULL, idempotency_window_ms INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1, object_counter INTEGER NOT NULL DEFAULT 1, parked_task_counter INTEGER NOT NULL DEFAULT 1, session_counter INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL)"
    );
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS v2_commit_scope_object (id TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at INTEGER NOT NULL)"
    );
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS v2_commit_scope_session (id TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at INTEGER NOT NULL)"
    );
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS v2_commit_scope_log (space TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(space, seq))"
    );
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS v2_commit_scope_snapshot (space TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(space, seq))"
    );
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS v2_commit_scope_task (id TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at INTEGER NOT NULL)"
    );
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS v2_commit_scope_tombstone (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL)"
    );
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS v2_commit_scope_accepted_frame (scope TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, position_hash TEXT NOT NULL, body TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(scope, seq))"
    );
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS v2_commit_scope_transcript_tail (scope TEXT NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL PRIMARY KEY, body TEXT NOT NULL, updated_at INTEGER NOT NULL)"
    );
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS v2_commit_scope_seen (idempotency_key TEXT PRIMARY KEY, seen_at INTEGER NOT NULL)"
    );
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS v2_commit_scope_reply (idempotency_key TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at INTEGER NOT NULL)"
    );
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS v2_commit_scope_checkpoint (scope TEXT PRIMARY KEY, head_seq INTEGER NOT NULL, head_hash TEXT NOT NULL, head TEXT NOT NULL, checkpoint_hash TEXT NOT NULL, body TEXT NOT NULL, updated_at INTEGER NOT NULL)"
    );
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS v2_commit_scope_checkpoint_page (scope TEXT NOT NULL, checkpoint_hash TEXT NOT NULL, page_index INTEGER NOT NULL, table_name TEXT NOT NULL, page TEXT NOT NULL, page_hash TEXT NOT NULL, body TEXT NOT NULL, bytes INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(scope, checkpoint_hash, page_index))"
    );
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS v2_commit_scope_checkpoint_frame (scope TEXT NOT NULL, checkpoint_hash TEXT NOT NULL, seq INTEGER NOT NULL, position_hash TEXT NOT NULL, body TEXT NOT NULL, bytes INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(scope, checkpoint_hash, seq))"
    );
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS v2_commit_scope_snapshot_repair (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, updated_at INTEGER NOT NULL)"
    );
    const constructorMs = Date.now() - constructorStartedAt;
    console.log("woo.metric", JSON.stringify({ kind: "do_constructor", class: "CommitScopeDO", ms: constructorMs, ts: Date.now(), host_key: this.durableScopeKey() }));
    writeConstructorMetricToAnalytics("CommitScopeDO", constructorMs, this.durableScopeKey(), this.env.METRICS);
  }

  // Lazily-initialised fault injector. Fast-path: returns no-op immediately when
  // WOO_FAULT_INJECT is unset. Parsed once per DO lifetime, not per request.
  private faultInjector(): FaultInjector {
    if (this._faultInjector !== undefined) return this._faultInjector;
    this._faultInjector = FaultInjector.fromEnv(this.env.WOO_FAULT_INJECT);
    return this._faultInjector;
  }

  async fetch(request: Request): Promise<Response> {
    const handlerStartedAt = Date.now();
    const url = new URL(request.url);
    let handlerStatus: "ok" | "error" = "ok";
    let handlerError: string | undefined;
    let handlerErrorDetail: string | undefined;
    // Per-call correlation id stamped by the sender (see
    // persistent-object-do.ts §forwardInternalRaw). Echoed on do_handler so
    // a sender timeout can be matched against the receiver's actual handler
    // runtime — distinguishing transit delay from satellite execution.
    const rpcId = request.headers.get("x-woo-rpc-id") || undefined;
    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        return jsonResponse({
          ok: true,
          kind: "woo.commit_scope_do.v1",
          id: String(this.state.id),
          ts: Date.now()
        });
      }
      if (request.method === "POST" && url.pathname === "/v2/open") {
        const startedAt = metricNow();
        let scope: ObjRef | undefined;
        let node: string | undefined;
        let fullSave = false;
        try {
          let phaseStartedAt = metricNow();
          await verifyInternalRequest(this.env, request);
          this.emitV2OpenStep("verify_internal", phaseStartedAt, { scope, node });
          phaseStartedAt = metricNow();
          const input = await readJson<CommitScopeOpenRequest>(request);
          this.emitV2OpenStep("read_json", phaseStartedAt, { scope: input.scope, node: input.node, bytes: requestContentLength(request) });
          scope = input.scope;
          node = input.node;
          phaseStartedAt = metricNow();
          const relay = await this.relayFor(input, { mergeSerializedAuth: input.open_protocol !== "checkpoint_tail.v1" });
          this.emitV2OpenStep("relay_for", phaseStartedAt, { scope, node });
          if (input.open_protocol === "head_session.v1") {
            // MCP planned-transcript commits execute from the transcript, not a
            // browser-local VM. They must observe the current head and bind the
            // session, but they must not build an executable open seed.
            phaseStartedAt = metricNow();
            this.ensureSerializedSession(relay, input);
            this.emitV2OpenStep("ensure_session", phaseStartedAt, { scope, node, count: input.sessions.length });
            phaseStartedAt = metricNow();
            fullSave = await this.saveFullIfNeeded(relay);
            let sessionSaved = false;
            if (!fullSave) sessionSaved = this.saveHeadSessionOpenBoundary(relay, input);
            this.emitV2OpenStep("head_session_persist", phaseStartedAt, {
              scope,
              node,
              full_save: fullSave,
              count: fullSave || sessionSaved ? 1 : 0
            });
            this.emitMetric({
              kind: "v2_open",
              scope,
              node,
              ms: metricElapsed(startedAt),
              status: "ok",
              transfer_mode: "head_session",
              executable_transfer_cache: "hit",
              executable_transfer_bytes: 0,
              executable_transfer_pages: 0,
              executable_transfer_inline_pages: 0,
              preseeded_objects: 0,
              full_save: fullSave
            });
            return jsonResponse({
              ok: true,
              open_protocol: "head_session.v1",
              relay: relay.node,
              head: relay.commit_scope.head
            });
          }
          if (input.open_protocol === "checkpoint_tail.v1") {
            phaseStartedAt = metricNow();
            fullSave = await this.saveFullIfNeeded(relay);
            this.emitV2OpenStep("full_save", phaseStartedAt, { scope, node, full_save: fullSave, count: fullSave ? 1 : 0 });
            if (fullSave) this.scheduleCheckpointBuild(relay, "checkpoint_tail_full_save");
            phaseStartedAt = metricNow();
            const responseBody = this.checkpointTailOpenResponse(relay, input);
            if (!responseBody) {
              const continuationRequested = input.continuation !== undefined;
              const errorCode = continuationRequested ? "E_CHECKPOINT_CONTINUATION_STALE" : "E_CHECKPOINT_PENDING";
              this.emitV2OpenStep(continuationRequested ? "checkpoint_tail_continuation_stale" : "checkpoint_tail_pending", phaseStartedAt, {
                scope,
                node,
                transfer_mode: continuationRequested ? "checkpoint_tail:continuation_stale" : "checkpoint_tail:pending",
                bytes: 0
              });
              this.emitMetric({
                kind: "v2_open",
                scope,
                node,
                ms: metricElapsed(startedAt),
                status: "error",
                transfer_mode: continuationRequested ? "checkpoint_tail:continuation_stale" : "checkpoint_tail:pending",
                full_save: false,
                error: errorCode
              });
              return jsonResponse({
                error: continuationRequested
                  ? wooError("E_CHECKPOINT_CONTINUATION_STALE", "checkpoint/tail continuation is expired or no longer matches the retained export")
                  : wooError("E_CHECKPOINT_PENDING", "checkpoint/tail open has no complete checkpoint yet; retry or use legacy open during rollout")
              }, continuationRequested ? 409 : 425);
            }
            this.emitV2OpenStep("checkpoint_tail_packaging", phaseStartedAt, {
              scope,
              node,
              transfer_mode: responseBody.transfer.kind,
              bytes: jsonByteLength(responseBody.transfer)
            });
            this.emitMetric({
              kind: "v2_open",
              scope,
              node,
              ms: metricElapsed(startedAt),
              status: "ok",
              transfer_mode: `checkpoint_tail:${responseBody.transfer.kind}`,
              executable_transfer_cache: "hit",
              executable_transfer_bytes: 0,
              executable_transfer_pages: 0,
              executable_transfer_inline_pages: 0,
              preseeded_objects: 0,
              full_save: false
            });
            return jsonResponse(responseBody);
          }
          phaseStartedAt = metricNow();
          this.ensureSerializedSession(relay, input);
          this.emitV2OpenStep("ensure_session", phaseStartedAt, { scope, node, count: input.sessions.length });
          phaseStartedAt = metricNow();
          const browser = this.browserFor(relay, input);
          this.emitV2OpenStep("browser_for", phaseStartedAt, { scope, node });
          phaseStartedAt = metricNow();
          const opened = await openShadowBrowserScope(browser, {
            last_known_head: input.last_known_head,
            executable_seed_digest: input.executable_seed_digest,
            metric: (event) => this.emitMetric(event)
          });
          this.emitV2OpenStep("open_shadow_scope", phaseStartedAt, {
            scope,
            node,
            transfer_mode: opened.transfer.mode,
            executable_transfer_cache: opened.executable_transfer_cache,
            bytes: opened.executable_transfer_bytes,
            count: opened.preseeded_objects
          });
          phaseStartedAt = metricNow();
          const hello = shadowBrowserTransportHello(browser);
          this.emitV2OpenStep("transport_hello", phaseStartedAt, { scope, node });
          // A cold relay seed must be durable before the open is reported.
          phaseStartedAt = metricNow();
          fullSave = await this.saveFullIfNeeded(relay);
          this.emitV2OpenStep("full_save", phaseStartedAt, { scope, node, full_save: fullSave, count: fullSave ? 1 : 0 });
          if (fullSave) this.scheduleCheckpointBuild(relay, "legacy_open_full_save");
          const seedStatus = opened.executable_transfer_bytes > SHADOW_OPEN_EXECUTABLE_SEED_WARN_BYTES ? "warn" : "ok";
          this.emitMetric({
            kind: "shadow_open_executable_seed_bytes",
            scope,
            node,
            bytes: opened.executable_transfer_bytes,
            pages: opened.executable_transfer_pages,
            inline_pages: opened.executable_transfer_inline_pages,
            status: seedStatus
          });
          if (seedStatus === "warn") {
            console.warn("woo.shadow_open_executable_seed_bytes.warn", {
              scope,
              node,
              bytes: opened.executable_transfer_bytes,
              pages: opened.executable_transfer_pages,
              inline_pages: opened.executable_transfer_inline_pages
            });
          }
          this.emitMetric({
            kind: "v2_open",
            scope,
            node,
            ms: metricElapsed(startedAt),
            status: "ok",
            transfer_mode: opened.transfer.mode,
            executable_transfer_cache: opened.executable_transfer_cache,
            executable_transfer_bytes: opened.executable_transfer_bytes,
            executable_transfer_pages: opened.executable_transfer_pages,
            executable_transfer_inline_pages: opened.executable_transfer_inline_pages,
            preseeded_objects: opened.preseeded_objects,
            full_save: fullSave
          });
          const responseBody = {
            ok: true,
            relay: relay.node,
            hello,
            head: relay.commit_scope.head,
            transfer: opened.transfer,
            executable_transfer: opened.executable_transfer,
            ads: opened.ads
          } satisfies CommitScopeOpenResponse;
          phaseStartedAt = metricNow();
          const encodedResponse = JSON.stringify(responseBody);
          const response = new Response(encodedResponse, {
            headers: { "content-type": "application/json; charset=utf-8" }
          });
          this.emitV2OpenStep("response_encode", phaseStartedAt, { scope, node, bytes: encodedResponse.length });
          return response;
        } catch (err) {
          this.emitMetric({ kind: "v2_open", scope, node, ms: metricElapsed(startedAt), status: "error", full_save: fullSave, ...metricErrorFields(err) });
          throw err;
        }
      }
      if (request.method === "POST" && url.pathname === "/v2/envelope") {
        const startedAt = Date.now();
        let scope: ObjRef | undefined;
        let node: string | undefined;
        let fullSave = false;
        let tailStats: CommitScopeTailStats | null = null;
        // P1′ size proxy: request body bytes from the header (clock-free; the
        // in-DO performance.now() cannot see synchronous parse/serialize CPU).
        const requestBytes = Number(request.headers.get("content-length") ?? 0) || 0;
        try {
          await verifyInternalRequest(this.env, request);
          const input = await readJson<CommitScopeEnvelopeRequest>(request);
          scope = input.scope;
          node = input.node;
          // Authority-slimming probe (step 1): classify how the relay is obtained.
          // "warm" = already in memory; otherwise relayFor sets lastRelayInitSource
          // to "snapshot" (our own durable storage) or "cold_seed" (request payload).
          const relayWasWarm = this.relay !== null;
          this.lastRelayInitSource = null;
          const relay = await this.relayFor(input);
          const relayWarmth = relayWasWarm ? "warm" : (this.lastRelayInitSource ?? "unknown");
          this.emitEnvelopeByteBreakdown(input, requestBytes, relayWarmth);
          this.ensureSerializedSession(relay, input);
          const browser = this.browserFor(relay, input);
          const replayStartedAt = metricNow();
          const receipt = receiveShadowBrowserEnvelopeReceipt(browser, input.envelope);
          const turnReply = await handleShadowBrowserTurnExecEnvelope(browser, receipt, {
            profile: (event) => this.emitMetric(event),
            // Forward verb-execution metrics from the ephemeral
            // planning world so direct_call / applied /
            // dispatch_resolved / broadcast events land in AE for
            // every MCP and WS turn — CommitScopeDO sees every v2
            // envelope regardless of strategy or transport.
            onMetric: (event) => this.emitMetric(event)
          });
          const reply = turnReply ?? handleShadowBrowserStateTransferEnvelope(browser, receipt);
          // When this envelope initialized a cold relay, the full save already
          // includes the accepted turn state; otherwise persist only the delta.
          fullSave = await this.saveFullIfNeeded(relay);
          if (!fullSave) {
            tailStats = await this.saveEnvelopeDelta(relay, receipt, reply);
          }
          // C1a kill_after_commit: simulate a DO crash AFTER the commit is
          // durably persisted but BEFORE fanout/reply delivery. The commit
          // state is on-disk; only the response delivery path is suppressed.
          // This is the hook point for plan item D1 (tail-driven peer delivery):
          // a rehydrating DO must be able to detect and re-deliver from the relay
          // tail without the gateway ever having seen the reply.
          // The fault fires ONLY for accepted (fresh) commits — a replayed
          // idempotency response is already-delivered, not a new commit.
          if (receipt.fresh) this.faultInjector().applyKillAfterCommit();
          this.emitCommitReplyReplayMetric({
            scope,
            node,
            receipt,
            reply,
            startedAt: replayStartedAt
          });
          const fanout = reply ? this.fanoutEnvelopes(relay, input.node, reply) : [];
          const responseReply = reply ? this.replyForReceiverProfile(reply, input) : null;
          // P1′ size proxies: hoist the response encodes so we can measure their
          // size without a second serialization. Lengths are char-count
          // approximations of byte size — accurate enough to correlate with the
          // synchronous encode CPU the clock can't see.
          const encodedReply = reply ? encodeEnvelope<ShadowEnvelopeReplyBody>(reply as ShadowEnvelope<ShadowEnvelopeReplyBody>) : null;
          const encodedReceiverReply = (responseReply && responseReply !== reply)
            ? encodeEnvelope<ShadowEnvelopeReplyBody>(responseReply as ShadowEnvelope<ShadowEnvelopeReplyBody>)
            : null;
          const fanoutBytes = fanout.reduce((total, item) => total + item.node.length + item.envelope.length, 0);
          this.emitMetric({
            kind: "v2_envelope",
            scope,
            node,
            ms: Date.now() - startedAt,
            status: "ok",
            fresh: receipt.fresh,
            reply: shadowReplyMetricKind(reply),
            fanout: fanout.length,
            full_save: fullSave,
            request_bytes: requestBytes,
            reply_bytes: encodedReply?.length ?? 0,
            receiver_reply_bytes: encodedReceiverReply?.length ?? 0,
            fanout_bytes: fanoutBytes,
            ...(tailStats ? {
              tail_rows_written: tailStats.rowsWritten,
              tail_bytes_retained: tailStats.bytesRetained,
              projection_bytes: tailStats.projectionBytes
            } : {})
          });
          this.emitShadowCommitMetric(reply, node, fanout.length);
          return jsonResponse({
            ok: true,
            reply: encodedReply,
            ...(encodedReceiverReply ? {
              receiver_reply: encodedReceiverReply
            } : {}),
            head: relay.commit_scope.head,
            fanout
          } satisfies CommitScopeEnvelopeResponse);
        } catch (err) {
          // kill_after_commit: commit IS durable; surface a distinct error code
          // so the gateway can record the crash-window event and the test can
          // assert that the commit applied while delivery was suppressed.
          if (err instanceof KillAfterCommitError) {
            this.emitMetric({ kind: "v2_envelope", scope, node, ms: Date.now() - startedAt, status: "error", full_save: fullSave, error: "E_KILL_AFTER_COMMIT" });
            return jsonResponse({ error: { code: "E_KILL_AFTER_COMMIT", message: err.message } }, 500);
          }
          this.emitMetric({ kind: "v2_envelope", scope, node, ms: Date.now() - startedAt, status: "error", full_save: fullSave, ...metricErrorFields(err) });
          throw err;
        }
      }
      if (request.method === "POST" && url.pathname === "/v2/state-transfer") {
        const startedAt = Date.now();
        let scope: ObjRef | undefined;
        let node: string | undefined;
        try {
          await verifyInternalRequest(this.env, request);
          const input = await readJson<CommitScopeStateTransferRequest>(request);
          scope = input.scope;
          node = input.node;
          if (input.transfer_scope !== input.scope) {
            throw wooError("E_PROTOCOL", `state transfer scope mismatch: authority=${input.scope} transfer=${input.transfer_scope}`);
          }
          const relay = await this.relayFor(input);
          this.ensureSerializedSession(relay, input);
          const browser = this.stateTransferBrowserFor(relay, input);
          const transfer = buildShadowBrowserCatchupTransferForBrowser(browser, input.transfer_scope, input.last_known_head);
          this.applyStateTransferToBrowserCache(browser, transfer);
          this.emitMetric({
            kind: "v2_state_transfer",
            scope: input.transfer_scope,
            node,
            ms: Date.now() - startedAt,
            status: "ok",
            transfer_mode: transfer.mode,
            full_save: false
          });
          return jsonResponse({
            ok: true,
            relay: relay.node,
            transfer
          } satisfies CommitScopeStateTransferResponse);
        } catch (err) {
          this.emitMetric({ kind: "v2_state_transfer", scope, node, ms: Date.now() - startedAt, status: "error", full_save: false, ...metricErrorFields(err) });
          throw err;
        }
      }
      return jsonResponse({
        error: {
          code: "E_NOT_IMPLEMENTED",
          message: "CommitScopeDO storage is reserved for the v2 turn-network commit scope"
        }
      }, 501);
    } catch (err) {
      handlerStatus = "error";
      const fields = metricErrorFields(err);
      handlerError = fields.error;
      handlerErrorDetail = fields.error_detail;
      const error = normalizeError(err);
      return jsonResponse({ error }, statusForError(error));
    } finally {
      this.emitMetric({
        kind: "do_handler",
        class: "CommitScopeDO",
        method: request.method,
        route: url.pathname,
        ms: Date.now() - handlerStartedAt,
        status: handlerStatus,
        ...(rpcId ? { rpc_id: rpcId } : {}),
        ...(handlerError ? { error: handlerError } : {}),
        ...(handlerErrorDetail ? { error_detail: handlerErrorDetail } : {})
      });
    }
  }

  private async relayFor(
    input: CommitScopeBaseRequest & { serialized?: SerializedWorld },
    options: { mergeSerializedAuth?: boolean } = {}
  ): Promise<ShadowRelayCache> {
    if (!this.relay) {
      if (!this.relayInitPromise) {
        const pending = this.initializeRelay(input);
        this.relayInitPromise = pending;
        try {
          await pending;
        } finally {
          if (this.relayInitPromise === pending) this.relayInitPromise = null;
        }
      } else {
        await this.relayInitPromise;
      }
    }
    if (!this.relay) throw wooError("E_INTERNAL", `commit scope ${input.scope} failed to initialize relay`);
    if (this.relay.commit_scope.scope !== input.scope) {
      throw wooError("E_PROTOCOL", `commit scope mismatch: have=${this.relay.commit_scope.scope} want=${input.scope}`);
    }
    this.validateExecutionCapsule(input, this.relay.commit_scope.head);
    this.refreshSessionAuth(this.relay, input, { mergeSerialized: options.mergeSerializedAuth !== false });
    return this.relay;
  }

  private async initializeRelay(input: CommitScopeBaseRequest & { serialized?: SerializedWorld }): Promise<ShadowRelayCache> {
    if (this.relay) return this.relay;
    if (!this.snapshotLoaded) {
      const loaded = await this.loadSnapshot();
      this.snapshotLoaded = true;
      if (loaded) {
        this.relay = loaded;
        this.lastRelayInitSource = "snapshot";
        return loaded;
      }
    }
    if (input.execution_capsule) {
      throw wooError(V2_COMMIT_SCOPE_SNAPSHOT_REQUIRED, `commit scope ${input.scope} has no durable snapshot for execution capsule; retry with legacy open bootstrap`);
    }
    const serialized = input.serialized ?? (input.authority ? serializedWorldFromAuthoritySlice(input.authority) : null);
    if (!serialized) {
      throw wooError(V2_COMMIT_SCOPE_SNAPSHOT_REQUIRED, `commit scope ${input.scope} has no durable snapshot; retry /v2/open with serialized seed state`);
    }
    const relay = createShadowBrowserRelayShim({
      node: `node:commit-scope:${input.scope}`,
      scope: input.scope,
      serialized
    });
    // A3.2 provenance retrofit: the relay is seeded directly from the serialized
    // world (bypassing the provenance-recording merge), so capture per-cell
    // provenance from the seed authority slice. Without this, a seeded identity
    // stub (e.g. a cross-host `cache` `name=id` row) has unknown provenance,
    // defaults to authoritative-protected, and refuses a later fresh `projection`
    // repair — the cross-scope `who` defect. A direct `serialized` seed (no
    // authority slice) yields an empty map; those cells stay conservatively
    // protected, matching prior behavior.
    if (input.authority) {
      relay.commit_scope.cellProvenance = cellProvenanceFromAuthoritySlice(input.authority);
    }
    this.relay = relay;
    this.lastRelayInitSource = "cold_seed";
    this.needsFullSave = true;
    return relay;
  }

  private validateExecutionCapsule(input: CommitScopeBaseRequest, currentHead: ShadowScopeHead): void {
    const capsule = input.execution_capsule;
    if (!capsule) return;
    if (capsule.kind !== "woo.execution_capsule.v1") throw wooError("E_PROTOCOL", "invalid execution capsule kind");
    if (capsule.scope !== input.scope) throw wooError("E_PROTOCOL", "execution capsule scope mismatch");
    if (capsule.actor !== input.actor || capsule.session !== input.session) throw wooError("E_PROTOCOL", "execution capsule session mismatch");
    if (capsule.head.scope !== input.scope) throw wooError("E_PROTOCOL", "execution capsule head scope mismatch");
    if (capsule.head.epoch !== currentHead.epoch) throw wooError("E_PROTOCOL", "execution capsule epoch mismatch");
    if (capsule.expires_at_ms <= Date.now()) throw wooError("E_STALE", "execution capsule expired");
  }

  private refreshSessionAuth(
    relay: ShadowRelayCache,
    input: CommitScopeBaseRequest,
    options: { mergeSerialized?: boolean } = {}
  ): void {
    // Sessions can be refreshed by the gateway between messages. Auth maps are
    // always rebuilt from the live session export; when the request carries an
    // authority slice, its session/object rows also refresh the planning
    // working set before the envelope is decoded.
    const authority = input.authority;
    const sessionRows = authority?.sessions ?? input.sessions;
    const auth = buildShadowBrowserSessionAuth({
      sessions: sessionRows,
      scope: input.scope,
      deployment: relay.deployment,
      session_revs: input.session_revs
    });
    relay.session_auth = auth.session_auth;
    relay.session_revs = auth.session_revs;
    if (options.mergeSerialized === false) return;
    if (authority) {
      // The commit scope's relay is the world the VM plans/executes against, so it
      // carries the same per-cell provenance as every other holder. Shared merge:
      // provenance-aware, preserves the session actors' live cells, bumps generation.
      mergeAuthorityIntoRelayCache(relay, authority, {
        preserveSessionActorLive: true,
        clone: true,
        reason: "commit_scope_authority_merge",
        metric: (event) => this.emitMetric(event)
      });
      return;
    }
    const serialized = serializedFor(relay.commit_scope, { reason: "commit_scope_session_merge", metric: (event) => this.emitMetric(event) });
    const mergedSessions = mergeShadowBrowserSessionState(serialized.sessions, sessionRows);
    if (stableShadowJson(mergedSessions as unknown as WooValue) !== stableShadowJson(serialized.sessions as unknown as WooValue)) {
      serialized.sessions = mergedSessions;
      markShadowBrowserRelaySerializedChanged(relay);
    }
    this.refreshSerializedObjects(relay, input.session_objects ?? []);
  }

  private ensureSerializedSession(relay: ShadowRelayCache, input: CommitScopeBaseRequest): void {
    // Commit validation and server-assisted planning read from the scope's
    // serialized world, not only from the transport auth maps. Keep the socket's
    // accepted session row present even when the gateway's narrow session export
    // and this long-lived scope snapshot briefly diverge.
    const current = (input.authority?.sessions ?? input.sessions).find((session) => session.id === input.session && session.actor === input.actor);
    if (!current) return;
    const serialized = structuredClone(current) as SerializedSession;
    const world = serializedFor(relay.commit_scope, { reason: "commit_scope_ensure_session", metric: (event) => this.emitMetric(event) });
    const index = world.sessions.findIndex((session) => session.id === serialized.id);
    if (index < 0) {
      world.sessions.push(serialized);
      world.sessions.sort((a, b) => a.id.localeCompare(b.id));
      markShadowBrowserRelaySerializedChanged(relay);
      return;
    }
    const existing = world.sessions[index];
    const next = input.authority
      ? serialized
      : {
        ...serialized,
        activeScope: existing.actor === serialized.actor && existing.activeScope !== undefined
          ? existing.activeScope
          : serialized.activeScope
    };
    if (stableShadowJson(next as unknown as WooValue) !== stableShadowJson(existing as unknown as WooValue)) {
      world.sessions[index] = next;
      markShadowBrowserRelaySerializedChanged(relay);
    }
  }

  private refreshSerializedObjects(relay: ShadowRelayCache, objects: SerializedObject[]): void {
    if (objects.length === 0) return;
    const serialized = serializedFor(relay.commit_scope, { reason: "commit_scope_object_refresh", metric: (event) => this.emitMetric(event) });
    const byId = new Map(serialized.objects.map((obj, index) => [obj.id, index] as const));
    for (const obj of objects) {
      const clone = structuredClone(obj) as SerializedObject;
      const index = byId.get(clone.id);
      if (index === undefined) {
        byId.set(clone.id, serialized.objects.length);
        serialized.objects.push(clone);
      } else {
        serialized.objects[index] = clone;
      }
    }
    markShadowBrowserRelaySerializedChanged(relay);
  }

  private browserFor(relay: ShadowRelayCache, input: CommitScopeBaseRequest) {
    return createShadowBrowserClient({
      node: input.node,
      scope: input.scope,
      actor: input.actor,
      session: input.session,
      relay,
      token: input.token
    });
  }

  private stateTransferBrowserFor(relay: ShadowRelayCache, input: CommitScopeStateTransferRequest) {
    const existing = relay.browsers.get(input.node);
    if (existing && existing.actor === input.actor && existing.session === input.session) {
      setShadowBrowserSessionToken(existing, input.token);
      return existing;
    }
    const browser = this.browserFor(relay, input);
    subscribeShadowBrowserNode(browser, input.transfer_scope);
    return browser;
  }

  private applyStateTransferToBrowserCache(browser: ReturnType<CommitScopeDO["browserFor"]>, transfer: ShadowBrowserStateTransfer): void {
    if (transfer.mode !== "delta" || !transfer.projection_patch) {
      applyShadowBrowserTransfer(browser, transfer);
      return;
    }
    const currentSeq = shadowProjectionSeq(browser.cache.projections.get(transfer.scope));
    if (currentSeq === transfer.projection_patch.base.seq || currentSeq !== transfer.to.seq) {
      applyShadowBrowserTransfer(browser, transfer);
    }
  }

  private checkpointTailOpenResponse(
    relay: ShadowRelayCache,
    input: CommitScopeOpenRequest
  ): CommitScopeOpenCheckpointTailResponse | null {
    const budget = boundedPositiveInteger(input.transfer_budget_bytes, CHECKPOINT_TRANSFER_DEFAULT_BYTES, CHECKPOINT_TRANSFER_MAX_BYTES);
    const maxTailFrames = boundedPositiveInteger(input.max_tail_frames, 200, 200);
    const authorityTransfer = input.continuation !== undefined
      ? this.openContinuationTransfer(relay.commit_scope.scope, input.continuation, budget)
      : this.openInitialCheckpointTailTransfer(relay, input, maxTailFrames, budget);
    if (!authorityTransfer) {
      if (input.continuation !== undefined) return null;
      this.scheduleCheckpointBuild(relay, "checkpoint_tail_pending");
      return null;
    }
    const browser = this.browserFor(relay, input);
    subscribeShadowBrowserNode(browser, input.scope);
    const transfer = input.receiver_profile === "browser"
      ? browserProfileOpenTransferFromAuthority({
        transfer: authorityTransfer,
        serialized: this.serializedProjectionWorld(),
        viewer: { actor: input.actor, session: input.session }
      })
      : authorityTransfer;
    return {
      ok: true,
      open_protocol: "checkpoint_tail.v1",
      relay: relay.node,
      hello: shadowBrowserTransportHello(browser),
      head: relay.commit_scope.head,
      transfer
    };
  }

  private openInitialCheckpointTailTransfer(
    relay: ShadowRelayCache,
    input: CommitScopeOpenRequest,
    maxTailFrames: number,
    budget: number
  ): OpenTransfer | null {
    const knownHead = input.known_head ?? input.last_known_head ?? null;
    const frameTransfer = knownHead
      ? this.openFrameTransfer(relay.commit_scope.scope, knownHead, relay.commit_scope.head, maxTailFrames, budget)
      : null;
    if (frameTransfer) return frameTransfer;
    return this.loadScopeCheckpointTransfer(relay.commit_scope.scope, relay.commit_scope.head, budget);
  }

  private loadCompleteScopeCheckpoint(scope: ObjRef, head: ShadowScopeHead): LoadedScopeCheckpoint | null {
    const row = sqlRows<{ body: string; head_hash: string; head_seq: number }>(this.state.storage.sql.exec(
      "SELECT body, head_hash, head_seq FROM v2_commit_scope_checkpoint WHERE scope = ? LIMIT 1",
      scope
    ))[0] ?? null;
    if (!row) return null;
    if (Number(row.head_seq) !== head.seq || row.head_hash !== head.hash) return null;
    const parsed = JSON.parse(row.body) as unknown;
    const manifest = persistedScopeCheckpointManifestFromUnknown(parsed);
    if (manifest) {
      if (manifest.scope !== scope || !shadowScopeHeadsEqual(manifest.head, head)) return null;
      return {
        storage: "manifest",
        scope: manifest.scope,
        head: manifest.head,
        checkpoint_hash: manifest.checkpoint_hash,
        page_refs: manifest.pages,
        frame_refs: manifest.frame_tail
      };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const legacyRecord = parsed as Record<string, unknown>;
    const legacyHead = shadowScopeHeadFromUnknown(legacyRecord.head);
    if (legacyRecord.kind !== "woo.scope_checkpoint.v1" || legacyRecord.scope !== scope || !legacyHead || !shadowScopeHeadsEqual(legacyHead, head) || !Array.isArray(legacyRecord.pages) || !Array.isArray(legacyRecord.frame_tail)) return null;
    const legacy = legacyRecord as unknown as ScopeCheckpoint;
    return {
      storage: "legacy",
      scope: legacy.scope,
      head: legacy.head,
      checkpoint_hash: legacy.checkpoint_hash,
      pages: legacy.pages,
      frame_tail: legacy.frame_tail
    };
  }

  private loadScopeCheckpointTransfer(scope: ObjRef, head: ShadowScopeHead, budget: number): OpenTransfer | null {
    const checkpoint = this.loadCompleteScopeCheckpoint(scope, head);
    return checkpoint ? this.packageCheckpointTransfer(checkpoint, 0, budget) : null;
  }

  private openFrameTransfer(
    scope: ObjRef,
    knownHead: ShadowScopeHead,
    currentHead: ShadowScopeHead,
    maxTailFrames: number,
    budget: number
  ): OpenTransfer | null {
    if (knownHead.scope !== scope || knownHead.epoch !== currentHead.epoch) return null;
    if (knownHead.seq === currentHead.seq && knownHead.hash === currentHead.hash) {
      return { kind: "frames", from: knownHead, to: currentHead, frames: [] };
    }
    if (knownHead.seq >= currentHead.seq || currentHead.seq - knownHead.seq > maxTailFrames) return null;
    const rows = sqlRows<{ body: string }>(this.state.storage.sql.exec(
      "SELECT body FROM v2_commit_scope_accepted_frame WHERE scope = ? AND seq > ? AND seq <= ? ORDER BY seq",
      scope,
      knownHead.seq,
      currentHead.seq
    ));
    if (rows.length !== currentHead.seq - knownHead.seq) return null;
    const frames = rows.map((row) => JSON.parse(row.body) as ShadowCommitAccepted);
    for (const frame of frames) {
      if (!frame.projection_writes || frame.projection_writes.some((write) => write.op === "upsert" && !("row" in write) && !("value" in write))) {
        return null;
      }
    }
    const transfers = frames.map((frame) => ({
      frame: acceptedFrameForTransfer(frame),
      projection_writes: structuredClone(frame.projection_writes ?? []) as ProjectionWrite[]
    } satisfies AcceptedFrameTransfer));
    return this.packageFrameTransfer(scope, knownHead, currentHead, transfers, 0, budget);
  }

  private openContinuationTransfer(scope: ObjRef, continuation: unknown, budget: number): OpenTransfer | null {
    const decoded = decodeOpenContinuation(continuation);
    if (!decoded || decoded.scope !== scope || decoded.expires_at_ms <= Date.now()) return null;
    if (decoded.mode === "checkpoint") {
      const checkpoint = this.loadCompleteScopeCheckpoint(scope, decoded.head);
      if (!checkpoint) return null;
      if (checkpoint.checkpoint_hash !== decoded.checkpoint_hash) return null;
      return this.packageCheckpointTransfer(checkpoint, decoded.next_page, budget);
    }
    const rows = sqlRows<{ body: string }>(this.state.storage.sql.exec(
      "SELECT body FROM v2_commit_scope_accepted_frame WHERE scope = ? AND seq >= ? AND seq <= ? ORDER BY seq",
      scope,
      decoded.next_seq,
      decoded.head.seq
    ));
    const frames = rows.map((row) => JSON.parse(row.body) as ShadowCommitAccepted);
    if (frames.length !== decoded.head.seq - decoded.next_seq + 1) return null;
    if (frames.length === 0) return { kind: "frames", from: decoded.after_head, to: decoded.after_head, frames: [] };
    if (frames[frames.length - 1]?.position.hash !== decoded.head.hash) return null;
    const transfers = frames.map((frame) => ({
      frame: acceptedFrameForTransfer(frame),
      projection_writes: structuredClone(frame.projection_writes ?? []) as ProjectionWrite[]
    } satisfies AcceptedFrameTransfer));
    return this.packageFrameTransfer(scope, decoded.after_head, decoded.head, transfers, 0, budget);
  }

  private packageFrameTransfer(
    scope: ObjRef,
    from: ShadowScopeHead,
    finalHead: ShadowScopeHead,
    frames: AcceptedFrameTransfer[],
    startIndex: number,
    budget: number
  ): OpenTransfer | null {
    const selected: AcceptedFrameTransfer[] = [];
    for (let index = startIndex; index < frames.length; index += 1) {
      const candidate = [...selected, frames[index]!];
      const candidateTo = candidate[candidate.length - 1]!.frame.position;
      const transfer = {
        kind: "frames",
        from,
        to: candidateTo,
        frames: candidate,
        ...(index + 1 < frames.length ? {
          continuation: frameContinuation(scope, candidateTo, finalHead, frames[index + 1]!.frame.position.seq)
        } : {})
      } satisfies OpenTransfer;
      if (selected.length > 0 && jsonByteLength(transfer) > budget) break;
      selected.push(frames[index]!);
      if (jsonByteLength(transfer) > budget) break;
    }
    if (selected.length === 0) return { kind: "frames", from, to: from, frames: [] };
    const nextIndex = startIndex + selected.length;
    const to = selected[selected.length - 1]!.frame.position;
    return {
      kind: "frames",
      from,
      to,
      frames: selected,
      ...(nextIndex < frames.length ? {
        continuation: frameContinuation(scope, to, finalHead, frames[nextIndex]!.frame.position.seq)
      } : {})
    };
  }

  private packageCheckpointTransfer(checkpoint: LoadedScopeCheckpoint, startPage: number, budget: number): OpenTransfer | null {
    const pageCount = this.checkpointPageCount(checkpoint);
    if (startPage < 0 || startPage > pageCount) return null;
    const selected: ProjectionPage[] = [];
    for (let index = startPage; index < pageCount; index += 1) {
      const page = this.checkpointPageAt(checkpoint, index);
      if (!page) return null;
      const candidate = [...selected, page];
      const partial = this.partialCheckpoint(checkpoint, candidate, index + 1 < pageCount);
      if (!partial) return null;
      const transfer = {
        kind: "checkpoint",
        checkpoint: partial,
        ...(index + 1 < pageCount ? {
          continuation: checkpointContinuation(checkpoint, index + 1)
        } : {})
      } satisfies OpenTransfer;
      if (selected.length > 0 && jsonByteLength(transfer) > budget) break;
      selected.push(page);
      if (jsonByteLength(transfer) > budget) break;
    }
    const nextPage = startPage + selected.length;
    const partial = this.partialCheckpoint(checkpoint, selected, nextPage < pageCount);
    if (!partial) return null;
    return {
      kind: "checkpoint",
      checkpoint: partial,
      ...(nextPage < pageCount ? {
        continuation: checkpointContinuation(checkpoint, nextPage)
      } : {})
    };
  }

  private checkpointPageCount(checkpoint: LoadedScopeCheckpoint): number {
    return checkpoint.storage === "legacy" ? checkpoint.pages.length : checkpoint.page_refs.length;
  }

  private checkpointPageAt(checkpoint: LoadedScopeCheckpoint, index: number): ProjectionPage | null {
    if (checkpoint.storage === "legacy") return checkpoint.pages[index] ?? null;
    const expected = checkpoint.page_refs[index];
    if (!expected) return null;
    const row = sqlRows<{ table_name: string; page: string; page_hash: string; body: string }>(this.state.storage.sql.exec(
      "SELECT table_name, page, page_hash, body FROM v2_commit_scope_checkpoint_page WHERE scope = ? AND checkpoint_hash = ? AND page_index = ? LIMIT 1",
      checkpoint.scope,
      checkpoint.checkpoint_hash,
      index
    ))[0] ?? null;
    if (!row) return null;
    if (row.table_name !== expected.table || row.page !== expected.page || row.page_hash !== expected.hash) return null;
    const page = JSON.parse(row.body) as ProjectionPage;
    if (page.kind !== "woo.projection_page.v1" || page.table !== expected.table || page.page !== expected.page || page.hash !== expected.hash) return null;
    return page;
  }

  private checkpointFrameTail(checkpoint: LoadedScopeCheckpoint): ShadowCommitAccepted[] | null {
    if (checkpoint.storage === "legacy") return checkpoint.frame_tail;
    const rows = sqlRows<{ seq: number; position_hash: string; body: string }>(this.state.storage.sql.exec(
      "SELECT seq, position_hash, body FROM v2_commit_scope_checkpoint_frame WHERE scope = ? AND checkpoint_hash = ? ORDER BY seq",
      checkpoint.scope,
      checkpoint.checkpoint_hash
    ));
    if (rows.length !== checkpoint.frame_refs.length) return null;
    const frames: ShadowCommitAccepted[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const expected = checkpoint.frame_refs[index]!;
      if (Number(row.seq) !== expected.seq || row.position_hash !== expected.hash) return null;
      const frame = JSON.parse(row.body) as ShadowCommitAccepted;
      if (frame.position.seq !== expected.seq || frame.position.hash !== expected.hash) return null;
      frames.push(frame);
    }
    return frames;
  }

  private partialCheckpoint(checkpoint: LoadedScopeCheckpoint, pages: ProjectionPage[], hasMorePages: boolean): ScopeCheckpoint | null {
    const frameTail = hasMorePages ? [] : this.checkpointFrameTail(checkpoint);
    if (!frameTail) return null;
    return {
      kind: "woo.scope_checkpoint.v1",
      scope: checkpoint.scope,
      head: checkpoint.head,
      checkpoint_hash: checkpoint.checkpoint_hash,
      pages,
      // The retained frame tail seeds future catch-up after the checkpoint is
      // fully installed. Sending it only with the final page batch keeps
      // continuation chunks bounded and prevents receivers from replaying
      // historical observations while projection pages are incomplete.
      frame_tail: frameTail
    };
  }

  private buildScopeCheckpoint(scope: ObjRef, head: ShadowScopeHead): ScopeCheckpoint {
    const pages: ProjectionPage[] = [
      ...this.objectProjectionPages(),
      ...this.sessionProjectionPages(),
      ...this.logProjectionPages(),
      ...this.snapshotProjectionPages(),
      ...this.parkedTaskProjectionPages(),
      ...this.tombstoneProjectionPages()
    ];
    const frameTail = sqlRows<{ body: string }>(this.state.storage.sql.exec(
      "SELECT body FROM v2_commit_scope_accepted_frame WHERE scope = ? ORDER BY seq",
      scope
    )).map((row) => acceptedFrameForTransfer(JSON.parse(row.body) as ShadowCommitAccepted));
    const checkpointMaterial = {
      kind: "woo.scope_checkpoint_material.v1",
      scope,
      head,
      pages: pages.map((page, index) => checkpointPageRef(page, index)),
      frame_tail: frameTail.map((frame) => frame.position)
    };
    return {
      kind: "woo.scope_checkpoint.v1",
      scope,
      head,
      checkpoint_hash: hashSource(stableShadowJson(checkpointMaterial as unknown as WooValue)),
      pages,
      frame_tail: frameTail
    };
  }

  private scheduleCheckpointBuild(relay: ShadowRelayCache, reason: string): boolean {
    const waitUntil = (this.state as { waitUntil?: (promise: Promise<unknown>) => void }).waitUntil;
    if (typeof waitUntil !== "function") return false;
    if (!this.checkpointBuildPromise) {
      const scope = relay.commit_scope.scope;
      const startedAt = metricNow();
      const task = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(async () => {
        if (this.needsFullSave) await this.saveFullIfNeeded(relay);
        this.persistScopeCheckpoint(scope, reason);
      });
      this.checkpointBuildPromise = task
        .catch((err) => {
          this.emitMetric({
            kind: "v2_open_step",
            phase: "checkpoint_build",
            scope,
            reason,
            ms: metricElapsed(startedAt),
            status: "error",
            ...metricErrorFields(err)
          });
        })
        .finally(() => {
          this.checkpointBuildPromise = null;
        });
    }
    waitUntil.call(this.state, this.checkpointBuildPromise);
    return true;
  }

  private persistScopeCheckpoint(scope: ObjRef, reason: string): void {
    const startedAt = metricNow();
    const head = this.loadPersistedHead(scope);
    if (!head) return;
    const checkpoint = this.buildScopeCheckpoint(scope, head);
    const pageRows = checkpoint.pages.map((page, index) => {
      const body = JSON.stringify(page);
      return { page, ref: checkpointPageRef(page, index, body), body };
    });
    const frameRows = checkpoint.frame_tail.map((frame) => {
      const body = JSON.stringify(frame);
      return { frame, ref: checkpointFrameRef(frame, body), body };
    });
    const manifest: PersistedScopeCheckpointManifest = {
      kind: "woo.scope_checkpoint_manifest.v1",
      scope,
      head,
      checkpoint_hash: checkpoint.checkpoint_hash,
      pages: pageRows.map((row) => row.ref),
      frame_tail: frameRows.map((row) => row.ref)
    };
    const body = JSON.stringify(manifest);
    const now = Date.now();
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        "DELETE FROM v2_commit_scope_checkpoint_page WHERE scope = ? AND checkpoint_hash <> ?",
        scope,
        checkpoint.checkpoint_hash
      );
      this.state.storage.sql.exec(
        "DELETE FROM v2_commit_scope_checkpoint_frame WHERE scope = ? AND checkpoint_hash <> ?",
        scope,
        checkpoint.checkpoint_hash
      );
      for (const { page, ref, body: pageBody } of pageRows) {
        this.state.storage.sql.exec(
          "INSERT OR REPLACE INTO v2_commit_scope_checkpoint_page(scope, checkpoint_hash, page_index, table_name, page, page_hash, body, bytes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          scope,
          checkpoint.checkpoint_hash,
          ref.page_index,
          page.table,
          page.page,
          page.hash,
          pageBody,
          ref.bytes,
          now
        );
      }
      for (const { frame, ref, body: frameBody } of frameRows) {
        this.state.storage.sql.exec(
          "INSERT OR REPLACE INTO v2_commit_scope_checkpoint_frame(scope, checkpoint_hash, seq, position_hash, body, bytes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          scope,
          checkpoint.checkpoint_hash,
          frame.position.seq,
          frame.position.hash,
          frameBody,
          ref.bytes,
          now
        );
      }
      this.state.storage.sql.exec(
        "INSERT OR REPLACE INTO v2_commit_scope_checkpoint(scope, head_seq, head_hash, head, checkpoint_hash, body, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        scope,
        head.seq,
        head.hash,
        JSON.stringify(head),
        checkpoint.checkpoint_hash,
        body,
        now
      );
    });
    const bytes = JSON_BYTES.encode(body).byteLength
      + pageRows.reduce((sum, row) => sum + row.ref.bytes, 0)
      + frameRows.reduce((sum, row) => sum + row.ref.bytes, 0);
    this.emitMetric({
      kind: "v2_open_step",
      phase: "checkpoint_build",
      scope,
      reason,
      ms: metricElapsed(startedAt),
      status: "ok",
      count: checkpoint.pages.length,
      bytes
    });
  }

  private loadPersistedHead(scope: ObjRef): ShadowScopeHead | null {
    const row = sqlRows<{ head: string }>(this.state.storage.sql.exec(
      "SELECT head FROM v2_commit_scope_meta WHERE id = 'current' AND scope = ? LIMIT 1",
      scope
    ))[0] ?? null;
    return row ? JSON.parse(row.head) as ShadowScopeHead : null;
  }

  private objectProjectionPages(): ProjectionPage[] {
    return projectionPages("objects", this.loadObjectRows());
  }

  private sessionProjectionPages(): ProjectionPage[] {
    const objects = this.loadObjectRows();
    return projectionPages("sessions", this.loadActorBackedSessionRows(objects));
  }

  private logProjectionPages(): ProjectionPage[] {
    return projectionPages("logs", this.loadLogRows().flatMap(([, entries]) => entries));
  }

  private snapshotProjectionPages(): ProjectionPage[] {
    return projectionPages("snapshots", this.loadSnapshotRows());
  }

  private parkedTaskProjectionPages(): ProjectionPage[] {
    return projectionPages("parked_tasks", this.loadParkedTaskRows());
  }

  private tombstoneProjectionPages(): ProjectionPage[] {
    return projectionPages("tombstones", this.loadTombstoneRows());
  }

  private serializedProjectionWorld(): SerializedWorld {
    const counters = this.loadPersistedCounters();
    const objects = this.loadObjectRows();
    return {
      version: 1,
      objectCounter: counters.objectCounter,
      parkedTaskCounter: counters.parkedTaskCounter,
      sessionCounter: counters.sessionCounter,
      objects,
      sessions: this.loadActorBackedSessionRows(objects),
      logs: this.loadLogRows(),
      snapshots: this.loadSnapshotRows(),
      parkedTasks: this.loadParkedTaskRows(),
      tombstones: this.loadTombstoneRows().map((row) => row.id)
    };
  }

  private loadPersistedCounters(): Pick<SerializedWorld, "objectCounter" | "parkedTaskCounter" | "sessionCounter"> {
    const row = sqlRows<{ object_counter: number; parked_task_counter: number; session_counter: number }>(this.state.storage.sql.exec(
      "SELECT object_counter, parked_task_counter, session_counter FROM v2_commit_scope_meta WHERE id = 'current' LIMIT 1"
    ))[0] ?? null;
    return {
      objectCounter: Number(row?.object_counter ?? 1),
      parkedTaskCounter: Number(row?.parked_task_counter ?? 1),
      sessionCounter: Number(row?.session_counter ?? 1)
    };
  }

  private loadObjectRows(): SerializedObject[] {
    return sqlRows<{ body: string }>(this.state.storage.sql.exec(
      "SELECT body FROM v2_commit_scope_object ORDER BY id"
    )).map((row) => JSON.parse(row.body) as SerializedObject);
  }

  private loadSessionRows(): SerializedSession[] {
    return sqlRows<{ body: string }>(this.state.storage.sql.exec(
      "SELECT body FROM v2_commit_scope_session ORDER BY id"
    )).map((row) => JSON.parse(row.body) as SerializedSession);
  }

  private loadActorBackedSessionRows(objects: readonly SerializedObject[]): SerializedSession[] {
    const serialized = { objects: objects.map((obj) => obj), sessions: this.loadSessionRows() };
    pruneSerializedSessionsWithoutActorRows(serialized);
    return serialized.sessions;
  }

  private loadLogRows(): SerializedWorld["logs"] {
    const rows = sqlRows<{ space: string; body: string }>(this.state.storage.sql.exec(
      "SELECT space, body FROM v2_commit_scope_log ORDER BY space, seq"
    ));
    const bySpace = new Map<ObjRef, SerializedWorld["logs"][number][1]>();
    for (const row of rows) {
      const space = row.space as ObjRef;
      const entries = bySpace.get(space) ?? [];
      entries.push(JSON.parse(row.body) as SerializedWorld["logs"][number][1][number]);
      bySpace.set(space, entries);
    }
    return Array.from(bySpace, ([space, entries]) => [space, entries] as [ObjRef, SerializedWorld["logs"][number][1]]);
  }

  private loadSnapshotRows(): SerializedWorld["snapshots"] {
    return sqlRows<{ body: string }>(this.state.storage.sql.exec(
      "SELECT body FROM v2_commit_scope_snapshot ORDER BY space, seq"
    )).map((row) => JSON.parse(row.body) as SerializedWorld["snapshots"][number]);
  }

  private loadParkedTaskRows(): SerializedWorld["parkedTasks"] {
    return sqlRows<{ body: string }>(this.state.storage.sql.exec(
      "SELECT body FROM v2_commit_scope_task ORDER BY id"
    )).map((row) => JSON.parse(row.body) as SerializedWorld["parkedTasks"][number]);
  }

  private loadTombstoneRows(): Array<{ id: ObjRef }> {
    return sqlRows<{ id: string }>(this.state.storage.sql.exec(
      "SELECT id FROM v2_commit_scope_tombstone ORDER BY id"
    )).map((row) => ({ id: row.id as ObjRef }));
  }

  private replyForReceiverProfile(
    reply: ShadowEnvelope<ShadowEnvelopeReplyBody>,
    input: CommitScopeEnvelopeRequest
  ): ShadowEnvelope<ShadowEnvelopeReplyBody> {
    if (input.receiver_profile !== "browser") return reply;
    const body = reply.body;
    if (!isShadowTurnExecReply(body) || body.ok !== true || !body.commit) return reply;
    const authorityWrites = body.commit.projection_writes ?? [];
    if (authorityWrites.length === 0 && !body.commit.projection_delta) return reply;
    const serialized = this.serializedProjectionWorld();
    const context = browserProfileProjectionContext(serialized);
    const browserWrites = authorityWrites
      .map((write) => browserProfileProjectionWriteFromAuthority({
        write,
        context,
        scope: body.commit!.position.scope,
        head: body.commit!.position,
        viewer: { actor: input.actor, session: input.session }
      }))
      .filter((write): write is ProjectionWrite<BrowserProfile> => write !== null);
    const projectionDelta = browserProjectionDeltaFromWrites(browserWrites, body.commit.projection_delta);
    return {
      ...reply,
      body: {
        ...body,
        commit: {
          ...body.commit,
          projection_delta: projectionDelta,
          projection_writes: browserWrites
        }
      }
    } as ShadowEnvelope<ShadowEnvelopeReplyBody>;
  }

  private fanoutEnvelopes(
    relay: ShadowRelayCache,
    originNode: string,
    reply: ShadowEnvelope<ShadowEnvelopeReplyBody>
  ): Array<{ node: string; envelope: string }> {
    const body = reply.body;
    if (!isShadowTurnExecReply(body)) return [];
    if (body.ok !== true || !body.transcript) return [];
    if (!body.commit) return this.liveFanoutEnvelopes(relay, originNode, reply);
    // Durable browser fan-out is owned by the gateway, which has the live
    // WebSocket/session set after hibernation and can route by per-observation
    // audiences across every affected scope. CommitScopeDO remains the state
    // authority and serves recipient-bound projection transfers on demand.
    return [];
  }

  private liveFanoutEnvelopes(
    relay: ShadowRelayCache,
    originNode: string,
    reply: ShadowEnvelope<ShadowEnvelopeReplyBody>
  ): Array<{ node: string; envelope: string }> {
    const origin = relay.browsers.get(originNode);
    const body = reply.body;
    if (!isShadowTurnExecReply(body)) return [];
    if (!origin || body.ok !== true || !body.transcript) return [];
    const out: Array<{ node: string; envelope: string }> = [];
    for (const event of shadowLiveEventsForTranscript(origin, body.transcript)) {
      for (const browser of relay.browsers.values()) {
        if (browser.node === originNode) continue;
        if (!shadowLiveEventMatchesBrowser(relay, browser, event)) continue;
        out.push({
          node: browser.node,
          envelope: encodeEnvelope({
            v: 2,
            type: event.kind,
            id: `${event.id}:${browser.node}`,
            from: relay.node,
            to: browser.node,
            actor: browser.actor,
            ...(browser.session ? { session: browser.session } : {}),
            auth: { mode: "session", token: browser.session_token ?? "" },
            body: event
          } satisfies ShadowEnvelope<typeof event>)
        });
      }
    }
    return out;
  }

  private emitShadowCommitMetric(reply: ShadowEnvelope<ShadowEnvelopeReplyBody> | null, node: string | undefined, fanout: number): void {
    const body = reply?.body;
    if (!isShadowTurnExecReply(body)) return;
    // Commit outcomes are split out from the endpoint metric so production
    // tails can alert on accept/reject rates without decoding reply envelopes.
    if (body.ok === true && body.commit) {
      this.emitMetric({
        kind: "shadow_commit_accepted",
        scope: body.commit.position.scope,
        seq: body.commit.position.seq,
        node,
        id: body.id,
        fanout
      });
      return;
    }
    if (body.ok === false && body.reason === "commit_rejected") {
      this.emitMetric({
        kind: "shadow_commit_rejected",
        scope: body.commit?.scope,
        node,
        id: body.id,
        reason: body.commit?.reason ?? body.reason
      });
      // Surface the underlying receipt.errors so the actual validation gate
      // that rejected the commit is greppable from a worker tail. The
      // structured metric above only carries the bucketed reason
      // ("nondeterministic" when no specific prefix matched), which hides
      // the per-cell "write prior mismatch" / "post_state_mismatch" /
      // "read unavailable" detail that an operator needs to triage.
      try {
        const errors = (body.commit as { errors?: unknown } | undefined)?.errors;
        if (Array.isArray(errors) && errors.length > 0) {
          console.log("woo.commit_rejected.errors", JSON.stringify({
            scope: body.commit?.scope,
            id: body.id,
            reason: body.commit?.reason ?? body.reason,
            errors: errors.slice(0, 12)
          }));
        }
      } catch {
        // Logging is best-effort; never block the metric flow on a stray
        // shape mismatch.
      }
    }
  }

  private emitCommitReplyReplayMetric(input: {
    scope?: ObjRef;
    node?: string;
    receipt: ShadowBrowserEnvelopeReceipt;
    reply: ShadowEnvelope<ShadowEnvelopeReplyBody> | null;
    startedAt: number;
  }): void {
    // This metric is intentionally separate from v2_envelope: the design
    // decision about durable reply rows needs a replay hit/miss numerator that
    // does not require decoding turn outcomes from the general request stream.
    const rowBacked = !input.receipt.fresh && this.replyRowExists(input.receipt.idempotency_key);
    const mode: Extract<MetricEvent, { kind: "commit_reply_replay" }>["mode"] = input.receipt.fresh
      ? "fresh"
      : input.reply || rowBacked
        ? "cached_sql"
        : "miss_after_hibernate";
    this.emitMetric({
      kind: "commit_reply_replay",
      scope: input.scope,
      node: input.node,
      route: "/v2/envelope",
      mode,
      status: mode === "miss_after_hibernate" ? "miss" : "ok",
      reply: shadowReplyMetricKind(input.reply),
      bytes: input.reply ? jsonByteLength(input.reply) : 0,
      ms: metricElapsed(input.startedAt)
    });
  }

  private emitMetric(event: MetricEvent): void {
    const hostKey = this.durableScopeKey("scope" in event ? event.scope : undefined);
    writeMetricToAnalytics(event, hostKey, this.env.METRICS);
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
    });
  }

  private durableScopeKey(scope?: ObjRef): string {
    return String(scope ?? (this.state.id as { name?: string }).name ?? "commit_scope");
  }

  private async loadSnapshot(): Promise<ShadowRelayCache | null> {
    return await this.loadRowSnapshot();
  }

  private async loadRowSnapshot(): Promise<ShadowRelayCache | null> {
    const rows = sqlRows<CommitScopeMetaRow>(this.state.storage.sql.exec(
      "SELECT scope, relay_node, head, idempotency_window_ms, version, object_counter, parked_task_counter, session_counter FROM v2_commit_scope_meta WHERE id = 'current'"
    ));
    const meta = rows[0] ?? null;
    if (!meta) return null;
    const serialized = this.loadSerializedWorld(meta);
    const relay = createShadowBrowserRelayShim({
      node: meta.relay_node,
      scope: meta.scope as ObjRef,
      serialized,
      idempotency_window_ms: Number(meta.idempotency_window_ms)
    });
    relay.commit_scope.head = JSON.parse(meta.head) as ShadowScopeHead;
    // Reconstruct the relay's durable tail through the holder-neutral seam, the
    // same definition localdev rehydrates from. Each field is read from its own
    // SQL table (the CommitScopeDO transport); the assignment back onto the relay
    // is shared. Reply envelopes are capped separately from seen keys; persisting
    // them costs one hot-path row but preserves reply-idempotency when a client
    // retries after the CommitScopeDO hibernates and rehydrates.
    hydrateShadowRelayTail(relay, {
      accepted_frames: sqlRows<{ body: string }>(this.state.storage.sql.exec(
        "SELECT body FROM v2_commit_scope_accepted_frame ORDER BY scope, seq"
      )).map((row) => JSON.parse(row.body) as ShadowCommitAccepted),
      transcript_tail: sqlRows<{ body: string }>(this.state.storage.sql.exec(
        "SELECT body FROM v2_commit_scope_transcript_tail ORDER BY scope, seq, hash"
      )).map((row) => JSON.parse(row.body) as EffectTranscript),
      recently_seen: sqlRows<{ idempotency_key: string; seen_at: number }>(this.state.storage.sql.exec(
        "SELECT idempotency_key, seen_at FROM v2_commit_scope_seen ORDER BY seen_at"
      )).map((row) => [decodeStorageKey(row.idempotency_key), Number(row.seen_at)]),
      recent_replies: sqlRows<{ idempotency_key: string; body: string }>(this.state.storage.sql.exec(
        "SELECT idempotency_key, body FROM v2_commit_scope_reply ORDER BY updated_at"
      )).map((row) => [decodeStorageKey(row.idempotency_key), JSON.parse(row.body) as ShadowEnvelope<WooValue>])
    });
    return relay;
  }

  private async saveFullIfNeeded(relay: ShadowRelayCache): Promise<boolean> {
    if (this.fullSavePromise) {
      await this.fullSavePromise;
      return false;
    }
    if (!this.needsFullSave) return false;
    this.needsFullSave = false;
    // Cold /v2/open calls for the same scope can overlap before the first
    // request finishes materializing rows. Only the first should pay the full
    // O(scope snapshot) write; the rest wait for that durable boundary.
    const pending = (async () => {
      try {
        await this.saveFull(relay);
      } catch (err) {
        this.needsFullSave = true;
        throw err;
      }
    })();
    // Publish the promise before awaiting it. That is the single-flight
    // invariant: every overlapping caller must observe and join this exact save.
    this.fullSavePromise = pending;
    try {
      await pending;
      return true;
    } finally {
      if (this.fullSavePromise === pending) this.fullSavePromise = null;
    }
  }

  private saveHeadSessionOpenBoundary(relay: ShadowRelayCache, input: CommitScopeBaseRequest): boolean {
    // A warm head/session open should persist at most the caller's session row.
    // Cold relays are handled by saveFullIfNeeded above.
    const session = shadowCommitScopeSession(relay.commit_scope, input.session, input.actor);
    const actor = shadowCommitScopeObject(relay.commit_scope, input.actor);
    if (!session || !actor) return false;
    const body = JSON.stringify(session);
    const existing = sqlRows<{ body: string }>(this.state.storage.sql.exec(
      "SELECT body FROM v2_commit_scope_session WHERE id = ? LIMIT 1",
      session.id
    ))[0] ?? null;
    if (existing?.body === body) return false;
    const now = Date.now();
    this.state.storage.transactionSync(() => {
      this.saveMeta(relay, now);
      this.state.storage.sql.exec(
        "INSERT OR REPLACE INTO v2_commit_scope_session(id, body, updated_at) VALUES (?, ?, ?)",
        session.id,
        body,
        now
      );
    });
    return true;
  }

  private loadSerializedWorld(meta: CommitScopeMetaRow): SerializedWorld {
    const objectRows = sqlRows<{ body: string }>(this.state.storage.sql.exec(
      "SELECT body FROM v2_commit_scope_object ORDER BY id"
    ));
    const objects = objectRows.map((row) => JSON.parse(row.body) as SerializedObject);
    const serialized: SerializedWorld = {
      version: Number(meta.version ?? 1) as 1,
      objectCounter: Number(meta.object_counter ?? 1),
      parkedTaskCounter: Number(meta.parked_task_counter ?? 1),
      sessionCounter: Number(meta.session_counter ?? 1),
      objects,
      sessions: this.loadSessionRows(),
      logs: logsFromRows(sqlRows<{ space: string; body: string }>(this.state.storage.sql.exec(
        "SELECT space, body FROM v2_commit_scope_log ORDER BY space, seq"
      ))),
      snapshots: sqlRows<{ body: string }>(this.state.storage.sql.exec(
        "SELECT body FROM v2_commit_scope_snapshot ORDER BY space, seq"
      )).map((row) => JSON.parse(row.body) as SerializedWorld["snapshots"][number]),
      parkedTasks: sqlRows<{ body: string }>(this.state.storage.sql.exec(
        "SELECT body FROM v2_commit_scope_task ORDER BY id"
      )).map((row) => JSON.parse(row.body) as SerializedWorld["parkedTasks"][number]),
      tombstones: sqlRows<{ id: string }>(this.state.storage.sql.exec(
        "SELECT id FROM v2_commit_scope_tombstone ORDER BY id"
      )).map((row) => row.id)
    };
    if (pruneSerializedSessionsWithoutActorRows(serialized)) this.needsFullSave = true;
    return this.repairLoadedSerializedWorld(serialized, meta.scope as ObjRef);
  }

  private async saveFull(relay: ShadowRelayCache): Promise<void> {
    // Full saves run only on cold initialization, when the gateway delivered
    // the seed snapshot via /v2/open. Hot envelopes use saveEnvelopeDelta to
    // rewrite only the rows the accepted transcript actually touched.
    const now = Date.now();
    this.state.storage.transactionSync(() => {
      this.saveMeta(relay, now);
      this.clearScopeCheckpoints(relay.commit_scope.scope);
      this.saveWorldRows(serializedFor(relay.commit_scope, { reason: "save_full", metric: (event) => this.emitMetric(event) }), now);
      this.appendAcceptedFrames(relay, now);
      this.appendTranscriptTail(relay, now);
      this.pruneAcceptedFramesByHorizon(relay, now);
      this.pruneTranscriptTailByHorizon(relay, now);
      this.saveSeenKeys(relay);
      this.saveRecentReplies(relay, now);
      this.saveSnapshotRepairFingerprint(now);
    });
  }

  private repairLoadedSerializedWorld(serialized: SerializedWorld, scope: ObjRef): SerializedWorld {
    // Synthetic/minimal snapshots used by checkpoint tests and capsule probes
    // may contain only the scope object. Without $system there is no bundled
    // catalog ledger/support graph to reconcile, so keep the historical row
    // shape untouched.
    if (!serialized.objects.some((object) => object.id === "$system")) return serialized;
    const fingerprint = this.currentSnapshotRepairFingerprint();
    if (this.loadSnapshotRepairFingerprint() === fingerprint) return serialized;
    const startedAt = metricNow();
    const world = createWorldFromSerialized(serialized, {
      persist: false,
      metricsHook: (event) => this.emitMetric(event)
    });
    // CommitScopeDO snapshots are long-lived row materializations. They do not
    // re-fetch gateway host seeds on deploy, so bundled catalog support rows
    // must receive the same idempotent host-scoped schema/data repair that
    // resident PersistentObjectDO hosts run on cold load.
    runHostScopedLocalCatalogLifecycle(world, scope);
    this.needsFullSave = true;
    console.log("woo.commit_scope_snapshot_repair", JSON.stringify({
      scope,
      fingerprint,
      ms: metricElapsed(startedAt)
    }));
    return world.exportWorld();
  }

  private currentSnapshotRepairFingerprint(): string {
    // The repair epoch is DERIVED from every input that can require a repair:
    // manifest content (bundle fingerprint) AND the local-boot migration index.
    // A migration added without any manifest change previously left this
    // fingerprint unchanged, so fingerprint-gated scope snapshots skipped the
    // new migration forever while ledger-gated hosts (world) ran it — the
    // 2026-06-11 deployed E_REPAIR_BUDGET loops (scope lacked
    // exit_living_room_outline that the world had). The manual epoch const
    // remains as a last-resort override only.
    return `${localCatalogBundleFingerprint(parseAutoInstallCatalogs(this.env.WOO_AUTO_INSTALL_CATALOGS))}:${localCatalogMigrationIndexFingerprint()}:${COMMIT_SCOPE_SNAPSHOT_REPAIR_EPOCH}`;
  }

  private loadSnapshotRepairFingerprint(): string | null {
    const rows = sqlRows<{ fingerprint: string }>(this.state.storage.sql.exec(
      "SELECT fingerprint FROM v2_commit_scope_snapshot_repair WHERE id = 'current' LIMIT 1"
    ));
    return rows[0]?.fingerprint ?? null;
  }

  private saveSnapshotRepairFingerprint(now: number): void {
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO v2_commit_scope_snapshot_repair(id, fingerprint, updated_at) VALUES ('current', ?, ?)",
      this.currentSnapshotRepairFingerprint(),
      now
    );
  }

  private clearScopeCheckpoints(scope: ObjRef): void {
    this.state.storage.sql.exec("DELETE FROM v2_commit_scope_checkpoint WHERE scope = ?", scope);
    this.state.storage.sql.exec("DELETE FROM v2_commit_scope_checkpoint_page WHERE scope = ?", scope);
    this.state.storage.sql.exec("DELETE FROM v2_commit_scope_checkpoint_frame WHERE scope = ?", scope);
  }

  private async saveEnvelopeDelta(
    relay: ShadowRelayCache,
    receipt: ShadowBrowserEnvelopeReceipt,
    reply: ShadowEnvelope<ShadowEnvelopeReplyBody> | null
  ): Promise<CommitScopeTailStats | null> {
    // Replayed envelopes authenticate and return the cached reply, but they do
    // not mutate relay state. Skipping storage here makes retry idempotency
    // side-effect-free as well as turn-execution-free.
    if (!receipt.fresh) return null;
    const seenAt = relay.recently_seen.get(receipt.idempotency_key);
    if (seenAt === undefined) return null;
    const now = Date.now();
    const body = reply?.body;
    const willSaveMeta = isShadowTurnExecReply(body) && body.ok === true && Boolean(body.commit) && Boolean(body.transcript);
    const tailStats: { value: CommitScopeTailStats | null } = { value: null };
    this.state.storage.transactionSync(() => {
      this.saveSeenKey(receipt.idempotency_key, seenAt);
      this.pruneSeenAndReplies(relay, now);
      if (reply) {
        this.saveRecentReply(receipt.idempotency_key, reply, now);
        this.pruneRecentReplies();
      }
      if (willSaveMeta && body && isShadowTurnExecReply(body) && body.ok === true && body.commit && body.transcript) {
        const tailStartedAt = Date.now();
        this.saveMeta(relay, now);
        this.saveTranscriptDelta(relay, body.transcript, now, body.commit.projection_writes ?? []);
        const frameWritten = this.saveAcceptedFrame(body.commit, now);
        const transcriptWritten = this.saveTranscript(body.transcript, now);
        const framePruned = this.pruneAcceptedFramesByHorizon(relay, now);
        const transcriptPruned = this.pruneTranscriptTailByHorizon(relay, now);
        const retained = this.tailRetentionStats(relay.commit_scope.scope);
        tailStats.value = {
          rowsWritten: frameWritten + transcriptWritten,
          rowsPruned: framePruned + transcriptPruned,
          bytesRetained: retained.bytes,
          acceptedFramesRetained: retained.acceptedFrames,
          transcriptTailRetained: retained.transcripts,
          projectionBytes: body.commit.projection_delta?.projection_bytes ?? 0,
          ms: Date.now() - tailStartedAt
        };
      }
    });
    if (tailStats.value) {
      this.emitMetric({
        kind: "authority_tail",
        scope: relay.commit_scope.scope,
        ms: tailStats.value.ms,
        tail_rows_written: tailStats.value.rowsWritten,
        tail_rows_pruned: tailStats.value.rowsPruned,
        tail_bytes_retained: tailStats.value.bytesRetained,
        accepted_frames_retained: tailStats.value.acceptedFramesRetained,
        transcript_tail_retained: tailStats.value.transcriptTailRetained
      });
      this.maybeCheckpointOnCommit(relay);
    }
    return tailStats.value;
  }

  // Authority-slimming probe (step 1): break the ~3MB envelope request into its
  // components so we know WHAT to slim. Gated behind WOO_V2_ENVELOPE_BYTE_BREAKDOWN
  // because measuring sizes re-stringifies the (large) authority slice, which adds
  // synchronous CPU — we only want that during a composition run, not permanently.
  // The clean floor cpuTime comes from the non-breakdown deploy; this run answers
  // "is it top-level authority, double-carried capsule authority, or sessions, and
  // is the slice even needed (relay warm/snapshot vs cold_seed)".
  private emitEnvelopeByteBreakdown(
    input: CommitScopeEnvelopeRequest,
    requestBytes: number,
    relayWarmth: string
  ): void {
    if (!envFlag(this.env.WOO_V2_ENVELOPE_BYTE_BREAKDOWN)) return;
    this.emitMetric({
      kind: "v2_envelope_bytes",
      scope: input.scope,
      node: input.node,
      relay_warmth: relayWarmth,
      request_bytes: requestBytes,
      authority_bytes: input.authority ? jsonByteLength(input.authority) : 0,
      // The execution capsule no longer carries an authority slice (removed as
      // dead weight); kept at 0 so the metric shape is stable for the follow-up
      // thin-warm-envelope verification.
      capsule_authority_bytes: 0,
      capsule_present: Boolean(input.execution_capsule),
      // Authority-bearing envelopes carry the session rows once inside the
      // authority slice (counted in authority_bytes) and leave this top-level
      // field empty, so this reads ~0 on full-authority turns by design. It is
      // only non-zero on the warm slim path, where the slice is stripped and the
      // rows are carried here instead (see slimMcpEnvelopeBody).
      sessions_bytes: input.sessions ? jsonByteLength(input.sessions) : 0,
      session_objects_bytes: input.session_objects ? jsonByteLength(input.session_objects) : 0,
      envelope_bytes: input.envelope ? input.envelope.length : 0
    });
  }

  // Decide whether this accepted commit should trigger a checkpoint rebuild.
  // Default (WOO_V2_CHECKPOINT_BOUNDED unset) = checkpoint every commit, exactly
  // as before. When bounded mode is on, only checkpoint once the head has advanced
  // WOO_V2_CHECKPOINT_FRAME_INTERVAL frames past the LAST PERSISTED checkpoint;
  // intervening commits rely on the durable accepted-frame tail for cold catch-up
  // (the tail self-protects — frames are not pruned until a complete checkpoint
  // covers them, see pruneTailTableByHorizon).
  //
  // The gate reads the persisted checkpoint head (completeCheckpointHeadSeq), NOT
  // an in-memory counter: this DO reconstructs on essentially every turn in
  // production, so an in-memory "last checkpoint seq" resets constantly and the
  // gate would never skip. The persisted seq survives reconstruction, so the
  // interval is honoured across cold activations.
  private maybeCheckpointOnCommit(relay: ShadowRelayCache): void {
    if (!envFlag(this.env.WOO_V2_CHECKPOINT_BOUNDED)) {
      this.scheduleCheckpointBuild(relay, "accepted_commit");
      return;
    }
    const scope = relay.commit_scope.scope;
    const headSeq = relay.commit_scope.head.seq;
    const interval = checkpointFrameInterval(this.env.WOO_V2_CHECKPOINT_FRAME_INTERVAL);
    const checkpointedSeq = this.completeCheckpointHeadSeq(scope);
    const due = checkpointedSeq === null || headSeq - checkpointedSeq >= interval;
    if (!due) {
      this.emitMetric({
        kind: "v2_open_step",
        phase: "checkpoint_build",
        scope,
        reason: "accepted_commit_bounded_skip",
        ms: 0,
        status: "ok",
        count: 0,
        bytes: 0
      });
      return;
    }
    this.scheduleCheckpointBuild(relay, "accepted_commit_bounded");
  }

  private saveMeta(relay: ShadowRelayCache, now: number): void {
    const scopeState = relay.commit_scope.state;
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO v2_commit_scope_meta(id, scope, relay_node, head, idempotency_window_ms, version, object_counter, parked_task_counter, session_counter, updated_at) VALUES ('current', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      relay.commit_scope.scope,
      relay.node,
      JSON.stringify(relay.commit_scope.head),
      relay.idempotency_window_ms,
      scopeState.version,
      scopeState.objectCounter,
      scopeState.parkedTaskCounter,
      scopeState.sessionCounter,
      now
    );
  }

  private saveWorldRows(serialized: SerializedWorld, now: number): void {
    // Session rows are presence authority. Persist only rows whose actor row is
    // in the same scope snapshot so catalog roster verbs never receive a
    // present actor they cannot dereference.
    pruneSerializedSessionsWithoutActorRows(serialized);
    for (const table of [
      "v2_commit_scope_tombstone",
      "v2_commit_scope_task",
      "v2_commit_scope_snapshot",
      "v2_commit_scope_log",
      "v2_commit_scope_session",
      "v2_commit_scope_object"
    ]) {
      this.state.storage.sql.exec(`DELETE FROM ${table}`);
    }
    for (const obj of serialized.objects) this.saveObjectRow(obj, now);
    for (const session of serialized.sessions) this.saveSessionRow(session, now);
    for (const [space, entries] of serialized.logs) {
      for (const entry of entries) this.saveLogRow(space, entry, now);
    }
    for (const snapshot of serialized.snapshots) {
      this.state.storage.sql.exec(
        "INSERT OR REPLACE INTO v2_commit_scope_snapshot(space, seq, body, updated_at) VALUES (?, ?, ?, ?)",
        snapshot.space_id,
        snapshot.seq,
        JSON.stringify(snapshot),
        now
      );
    }
    for (const task of serialized.parkedTasks) {
      this.state.storage.sql.exec(
        "INSERT OR REPLACE INTO v2_commit_scope_task(id, body, updated_at) VALUES (?, ?, ?)",
        task.id,
        JSON.stringify(task),
        now
      );
    }
    for (const id of serialized.tombstones ?? []) {
      this.state.storage.sql.exec("INSERT OR REPLACE INTO v2_commit_scope_tombstone(id, updated_at) VALUES (?, ?)", id, now);
    }
  }

  private saveTranscriptDelta(relay: ShadowRelayCache, transcript: EffectTranscript, now: number, projectionWrites: readonly ProjectionWrite[] = []): void {
    if (projectionWrites.length > 0) {
      this.saveProjectionWrites(projectionWrites, now);
      return;
    }
    for (const id of transcriptTouchedObjectIds(transcript)) {
      const obj = shadowCommitScopeObject(relay.commit_scope, id);
      if (obj) this.saveObjectRow(obj, now);
    }
    const sessionUpdate = transcriptSessionActiveScope(transcript);
    if (sessionUpdate) {
      const session = shadowCommitScopeSession(relay.commit_scope, sessionUpdate.session, sessionUpdate.actor);
      if (session) this.saveSessionRow(session, now);
    }
    const log = transcriptLogEntry(transcript);
    if (log) this.saveLogRow(log.space, log, now);
  }

  private saveProjectionWrites(writes: readonly ProjectionWrite[], now: number): void {
    for (const write of writes) {
      switch (write.table) {
        case "objects":
          if (write.op === "delete") {
            this.state.storage.sql.exec("DELETE FROM v2_commit_scope_object WHERE id = ?", write.key);
          } else {
            this.saveObjectRow(write.row, now);
          }
          break;
        case "sessions":
          if (write.op === "delete") {
            this.state.storage.sql.exec("DELETE FROM v2_commit_scope_session WHERE id = ?", write.key);
          } else {
            this.saveSessionRow(write.row, now);
          }
          break;
        case "logs":
          if (write.op === "delete") {
            this.state.storage.sql.exec("DELETE FROM v2_commit_scope_log WHERE space = ? AND seq = ?", write.key.space, write.key.seq);
          } else {
            this.saveLogRow(write.key.space, write.row, now);
          }
          break;
        case "snapshots":
          if (write.op === "delete") {
            this.state.storage.sql.exec("DELETE FROM v2_commit_scope_snapshot WHERE space = ? AND seq = ?", write.key.space, write.key.seq);
          } else {
            this.state.storage.sql.exec(
              "INSERT OR REPLACE INTO v2_commit_scope_snapshot(space, seq, body, updated_at) VALUES (?, ?, ?, ?)",
              write.key.space,
              write.key.seq,
              JSON.stringify(write.row),
              now
            );
          }
          break;
        case "parked_tasks":
          if (write.op === "delete") {
            this.state.storage.sql.exec("DELETE FROM v2_commit_scope_task WHERE id = ?", write.key);
          } else {
            this.state.storage.sql.exec(
              "INSERT OR REPLACE INTO v2_commit_scope_task(id, body, updated_at) VALUES (?, ?, ?)",
              write.key,
              JSON.stringify(write.row),
              now
            );
          }
          break;
        case "tombstones":
          if (write.op === "delete") {
            this.state.storage.sql.exec("DELETE FROM v2_commit_scope_tombstone WHERE id = ?", write.key);
          } else {
            this.state.storage.sql.exec("INSERT OR REPLACE INTO v2_commit_scope_tombstone(id, updated_at) VALUES (?, ?)", write.key, now);
          }
          break;
        case "counters":
          // saveMeta writes counters from the already-applied commit-scope
          // state at the start of this transaction.
          break;
        case "tool_surfaces":
          // Tool-surface rows live in the gateway projection cache, not in
          // CommitScopeDO's authority row store.
          break;
      }
    }
  }

  private saveObjectRow(obj: SerializedObject, now: number): void {
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO v2_commit_scope_object(id, body, updated_at) VALUES (?, ?, ?)",
      obj.id,
      JSON.stringify(obj),
      now
    );
  }

  private saveSessionRow(session: SerializedSession, now: number): void {
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO v2_commit_scope_session(id, body, updated_at) VALUES (?, ?, ?)",
      session.id,
      JSON.stringify(session),
      now
    );
  }

  private saveLogRow(space: ObjRef, entry: SerializedWorld["logs"][number][1][number], now: number): void {
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO v2_commit_scope_log(space, seq, body, updated_at) VALUES (?, ?, ?, ?)",
      space,
      entry.seq,
      JSON.stringify(entry),
      now
    );
  }

  private appendAcceptedFrames(relay: ShadowRelayCache, now: number): number {
    let written = 0;
    for (const frame of relay.accepted_frames) {
      written += this.saveAcceptedFrame(frame, now);
    }
    return written;
  }

  private saveAcceptedFrame(frame: ShadowCommitAccepted, now: number): number {
    if (this.acceptedFrameExists(frame.position.scope, frame.position.seq)) return 0;
    this.state.storage.sql.exec(
      "INSERT INTO v2_commit_scope_accepted_frame(scope, seq, id, position_hash, body, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      frame.position.scope,
      frame.position.seq,
      frame.id ?? "",
      frame.position.hash,
      JSON.stringify(frame),
      now
    );
    return 1;
  }

  private pruneAcceptedFramesByHorizon(relay: ShadowRelayCache, now: number): number {
    return this.pruneTailTableByHorizon({
      table: "v2_commit_scope_accepted_frame",
      scope: relay.commit_scope.scope,
      maxRows: MAX_SHADOW_ACCEPTED_TAIL,
      maxBytes: SHADOW_TAIL_RETENTION_BYTES,
      minUpdatedAt: now - SHADOW_TAIL_RETENTION_MS
    });
  }

  private appendTranscriptTail(relay: ShadowRelayCache, now: number): number {
    let written = 0;
    for (const transcript of relay.transcript_tail) {
      written += this.saveTranscript(transcript, now);
    }
    return written;
  }

  private saveTranscript(transcript: EffectTranscript, now: number): number {
    if (this.transcriptExists(transcript.hash)) return 0;
    this.state.storage.sql.exec(
      "INSERT INTO v2_commit_scope_transcript_tail(scope, seq, hash, body, updated_at) VALUES (?, ?, ?, ?, ?)",
      transcript.scope,
      transcript.seq,
      transcript.hash,
      JSON.stringify(transcript),
      now
    );
    return 1;
  }

  private pruneTranscriptTailByHorizon(relay: ShadowRelayCache, now: number): number {
    return this.pruneTailTableByHorizon({
      table: "v2_commit_scope_transcript_tail",
      scope: relay.commit_scope.scope,
      maxRows: MAX_SHADOW_TRANSCRIPT_TAIL,
      maxBytes: SHADOW_TAIL_RETENTION_BYTES,
      minUpdatedAt: now - SHADOW_TAIL_RETENTION_MS
    });
  }

  private acceptedFrameExists(scope: ObjRef, seq: number): boolean {
    return sqlRows<{ n: number }>(this.state.storage.sql.exec(
      "SELECT 1 AS n FROM v2_commit_scope_accepted_frame WHERE scope = ? AND seq = ? LIMIT 1",
      scope,
      seq
    )).length > 0;
  }

  private transcriptExists(hash: string): boolean {
    return sqlRows<{ n: number }>(this.state.storage.sql.exec(
      "SELECT 1 AS n FROM v2_commit_scope_transcript_tail WHERE hash = ? LIMIT 1",
      hash
    )).length > 0;
  }

  private replyRowExists(idempotencyKey: string): boolean {
    return sqlRows<{ n: number }>(this.state.storage.sql.exec(
      "SELECT 1 AS n FROM v2_commit_scope_reply WHERE idempotency_key = ? LIMIT 1",
      storageKey(idempotencyKey)
    )).length > 0;
  }

  private pruneTailTableByHorizon(input: {
    table: "v2_commit_scope_accepted_frame" | "v2_commit_scope_transcript_tail";
    scope: ObjRef;
    maxRows: number;
    maxBytes: number;
    minUpdatedAt: number;
  }): number {
    const checkpointHeadSeq = this.completeCheckpointHeadSeq(input.scope);
    if (checkpointHeadSeq === null) return 0;
    const rows = sqlRows<{ seq: number; hash?: string; body: string; updated_at: number }>(this.state.storage.sql.exec(
      `SELECT seq, ${input.table === "v2_commit_scope_transcript_tail" ? "hash" : "'' AS hash"}, body, updated_at FROM ${input.table} WHERE scope = ? ORDER BY seq DESC`,
      input.scope
    ));
    let kept = 0;
    let keptBytes = 0;
    const deleteRows: Array<{ seq: number; hash?: string }> = [];
    for (const row of rows) {
      const rowBytes = JSON_BYTES.encode(row.body).byteLength;
      const withinCount = kept < input.maxRows;
      const withinBytes = keptBytes + rowBytes <= input.maxBytes;
      const withinAge = Number(row.updated_at) >= input.minUpdatedAt;
      if (withinCount && withinBytes && withinAge) {
        kept += 1;
        keptBytes += rowBytes;
      } else if (row.seq <= checkpointHeadSeq) {
        deleteRows.push(row);
      } else {
        // Retention budgets are soft until a complete checkpoint covers the
        // row. A lagging holder must always be able to recover from either a
        // retained tail frame or a checkpoint that covers the pruned prefix.
        kept += 1;
        keptBytes += rowBytes;
      }
    }
    for (const row of deleteRows) {
      if (input.table === "v2_commit_scope_transcript_tail") {
        this.state.storage.sql.exec("DELETE FROM v2_commit_scope_transcript_tail WHERE hash = ?", row.hash ?? "");
      } else {
        this.state.storage.sql.exec("DELETE FROM v2_commit_scope_accepted_frame WHERE scope = ? AND seq = ?", input.scope, row.seq);
      }
    }
    return deleteRows.length;
  }

  private completeCheckpointHeadSeq(scope: ObjRef): number | null {
    const rows = sqlRows<{ head_seq: number }>(this.state.storage.sql.exec(
      "SELECT head_seq FROM v2_commit_scope_checkpoint WHERE scope = ? LIMIT 1",
      scope
    ));
    if (rows.length === 0) return null;
    const seq = Number(rows[0]!.head_seq);
    return Number.isFinite(seq) ? seq : null;
  }

  private tailRetentionStats(scope: ObjRef): { bytes: number; acceptedFrames: number; transcripts: number } {
    const frameRows = sqlRows<{ body: string }>(this.state.storage.sql.exec(
      "SELECT body FROM v2_commit_scope_accepted_frame WHERE scope = ?",
      scope
    ));
    const transcriptRows = sqlRows<{ body: string }>(this.state.storage.sql.exec(
      "SELECT body FROM v2_commit_scope_transcript_tail WHERE scope = ?",
      scope
    ));
    let bytes = 0;
    for (const row of frameRows) bytes += JSON_BYTES.encode(row.body).byteLength;
    for (const row of transcriptRows) bytes += JSON_BYTES.encode(row.body).byteLength;
    return { bytes, acceptedFrames: frameRows.length, transcripts: transcriptRows.length };
  }

  private saveSeenKeys(relay: ShadowRelayCache): void {
    const live = new Set(relay.recently_seen.keys());
    for (const [key, seenAt] of relay.recently_seen) {
      this.state.storage.sql.exec(
        "INSERT OR REPLACE INTO v2_commit_scope_seen(idempotency_key, seen_at) VALUES (?, ?)",
        storageKey(key),
        seenAt
      );
    }
    for (const row of sqlRows<{ idempotency_key: string }>(this.state.storage.sql.exec("SELECT idempotency_key FROM v2_commit_scope_seen"))) {
      if (!live.has(decodeStorageKey(row.idempotency_key))) this.state.storage.sql.exec("DELETE FROM v2_commit_scope_seen WHERE idempotency_key = ?", row.idempotency_key);
    }
  }

  private saveSeenKey(key: string, seenAt: number): void {
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO v2_commit_scope_seen(idempotency_key, seen_at) VALUES (?, ?)",
      storageKey(key),
      seenAt
    );
  }

  private pruneSeenAndReplies(relay: ShadowRelayCache, now: number): void {
    const cutoff = now - relay.idempotency_window_ms;
    this.state.storage.sql.exec("DELETE FROM v2_commit_scope_seen WHERE seen_at < ?", cutoff);
    this.state.storage.sql.exec("DELETE FROM v2_commit_scope_reply WHERE idempotency_key NOT IN (SELECT idempotency_key FROM v2_commit_scope_seen)");
    this.pruneTableByCount("v2_commit_scope_seen", "seen_at", MAX_SHADOW_IDEMPOTENCY_ENTRIES);
    this.state.storage.sql.exec("DELETE FROM v2_commit_scope_reply WHERE idempotency_key NOT IN (SELECT idempotency_key FROM v2_commit_scope_seen)");
  }

  private saveRecentReplies(relay: ShadowRelayCache, now: number): void {
    const live = new Set(relay.recent_replies.keys());
    for (const [key, reply] of relay.recent_replies) {
      this.state.storage.sql.exec(
        "INSERT OR REPLACE INTO v2_commit_scope_reply(idempotency_key, body, updated_at) VALUES (?, ?, ?)",
        storageKey(key),
        JSON.stringify(reply),
        now
      );
    }
    for (const row of sqlRows<{ idempotency_key: string }>(this.state.storage.sql.exec("SELECT idempotency_key FROM v2_commit_scope_reply"))) {
      if (!live.has(decodeStorageKey(row.idempotency_key))) this.state.storage.sql.exec("DELETE FROM v2_commit_scope_reply WHERE idempotency_key = ?", row.idempotency_key);
    }
  }

  private saveRecentReply(key: string, reply: ShadowEnvelope<ShadowEnvelopeReplyBody>, now: number): void {
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO v2_commit_scope_reply(idempotency_key, body, updated_at) VALUES (?, ?, ?)",
      storageKey(key),
      JSON.stringify(reply),
      now
    );
  }

  private pruneRecentReplies(): void {
    this.pruneTableByCount("v2_commit_scope_reply", "updated_at", MAX_SHADOW_RECENT_REPLIES_ENTRIES);
  }

  private pruneTableByCount(table: string, orderColumn: string, maxRows: number): void {
    const count = Number(sqlRows<{ n: number }>(this.state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`))[0]?.n ?? 0);
    const overflow = count - maxRows;
    if (overflow <= 0) return;
    this.state.storage.sql.exec(
      `DELETE FROM ${table} WHERE idempotency_key IN (SELECT idempotency_key FROM ${table} ORDER BY ${orderColumn} ASC LIMIT ?)`,
      overflow
    );
  }

}

type CommitScopeDurableState = {
  id: unknown;
  waitUntil?: (promise: Promise<unknown>) => void;
  storage: {
    sql: {
      exec(query: string, ...params: unknown[]): unknown;
    };
    transactionSync<T>(callback: () => T): T;
  };
};

type CommitScopeBaseRequest = {
  scope: ObjRef;
  node: string;
  token: string;
  session: string;
  actor: ObjRef;
  receiver_profile?: "authority" | "browser";
  sessions: SerializedSession[];
  session_objects?: SerializedObject[];
  authority?: SerializedAuthoritySlice;
  execution_capsule?: ExecutionCapsule;
  session_revs?: Record<string, number>;
};

type CommitScopeOpenRequest = CommitScopeBaseRequest & {
  serialized?: SerializedWorld;
  last_known_head?: ShadowScopeHead;
  open_protocol?: "checkpoint_tail.v1" | "head_session.v1";
  known_head?: ShadowScopeHead | null;
  transfer_budget_bytes?: number;
  max_tail_frames?: number;
  continuation?: OpenContinuation | { token: string } | string;
  executable_seed_digest?: string;
};

type CommitScopeOpenResponse = {
  ok: true;
  relay: string;
  hello: ShadowTransportHello;
  head: ShadowScopeHead;
  transfer: ShadowBrowserStateTransfer;
  executable_transfer: ShadowBrowserStateTransfer;
  ads: ShadowCapabilityAd[];
};

type CommitScopeOpenCheckpointTailResponse = {
  ok: true;
  open_protocol: "checkpoint_tail.v1";
  relay: string;
  hello: ShadowTransportHello;
  head: ShadowScopeHead;
  transfer: OpenTransfer | OpenTransfer<BrowserProfile>;
};

type CommitScopeEnvelopeRequest = CommitScopeBaseRequest & {
  envelope: string;
};

type CommitScopeStateTransferRequest = CommitScopeBaseRequest & {
  transfer_scope: ObjRef;
  last_known_head?: ShadowScopeHead;
};

type CommitScopeEnvelopeResponse = {
  ok: true;
  reply: string | null;
  receiver_reply?: string | null;
  head: ShadowScopeHead;
  fanout: Array<{ node: string; envelope: string }>;
};

type CommitScopeStateTransferResponse = {
  ok: true;
  relay: string;
  transfer: ShadowBrowserStateTransfer;
};

type CommitScopeTailStats = {
  rowsWritten: number;
  rowsPruned: number;
  bytesRetained: number;
  acceptedFramesRetained: number;
  transcriptTailRetained: number;
  projectionBytes: number;
  ms: number;
};

type CommitScopeMetaRow = {
  scope: string;
  relay_node: string;
  head: string;
  idempotency_window_ms: number;
  version?: number;
  object_counter?: number;
  parked_task_counter?: number;
  session_counter?: number;
};

function shadowProjectionSeq(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const seq = (value as { seq?: unknown }).seq;
  return typeof seq === "number" ? seq : null;
}

async function readJson<T>(request: Request): Promise<T> {
  return await request.json() as T;
}

function sqlRows<T>(cursor: unknown): T[] {
  if (cursor && typeof cursor === "object" && "toArray" in cursor && typeof cursor.toArray === "function") {
    return cursor.toArray() as T[];
  }
  return Array.from(cursor as Iterable<T>);
}

function storageKey(key: string): string {
  // In-memory idempotency keys use a NUL separator between (from, id). Encode
  // before using them as SQLite text primary keys so durable replay lookup
  // round-trips exactly across DO rehydration.
  return Array.from(new TextEncoder().encode(key), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeStorageKey(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

function logsFromRows(rows: Array<{ space: string; body: string }>): SerializedWorld["logs"] {
  const bySpace = new Map<ObjRef, SerializedWorld["logs"][number][1]>();
  for (const row of rows) {
    const entries = bySpace.get(row.space) ?? [];
    entries.push(JSON.parse(row.body) as SerializedWorld["logs"][number][1][number]);
    bySpace.set(row.space, entries);
  }
  return Array.from(bySpace.entries()).map(([space, entries]) => [
    space,
    entries.sort((a, b) => a.seq - b.seq)
  ]);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function metricNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return perf?.now ? perf.now() : Date.now();
}

function metricElapsed(startedAt: number): number {
  return Math.max(0, Math.round((metricNow() - startedAt) * 1000) / 1000);
}

function boundedPositiveInteger(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, max)
    : fallback;
}

function envFlag(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}

// P1′ probe: frames between on-commit checkpoints under WOO_V2_CHECKPOINT_BOUNDED.
const CHECKPOINT_FRAME_INTERVAL_DEFAULT = 32;
function checkpointFrameInterval(value: string | undefined): number {
  const raw = Number((value ?? "").trim());
  return Number.isInteger(raw) && raw > 0 ? raw : CHECKPOINT_FRAME_INTERVAL_DEFAULT;
}

function jsonByteLength(value: unknown): number {
  return JSON_BYTES.encode(JSON.stringify(value)).byteLength;
}

type DecodedOpenContinuation =
  | {
      mode: "checkpoint";
      scope: ObjRef;
      export_id: string;
      head: ShadowScopeHead;
      checkpoint_hash: string;
      next_page: number;
      expires_at_ms: number;
    }
  | {
      mode: "frames";
      scope: ObjRef;
      export_id: string;
      after_head: ShadowScopeHead;
      head: ShadowScopeHead;
      next_seq: number;
      expires_at_ms: number;
    };

function checkpointContinuation(checkpoint: LoadedScopeCheckpoint, nextPage: number): OpenContinuation {
  const expiresAt = Date.now() + CHECKPOINT_CONTINUATION_TTL_MS;
  const exportId = `checkpoint:${checkpoint.scope}:${checkpoint.head.epoch}:${checkpoint.head.seq}:${checkpoint.checkpoint_hash}`;
  const material: DecodedOpenContinuation = {
    mode: "checkpoint",
    scope: checkpoint.scope,
    export_id: exportId,
    head: checkpoint.head,
    checkpoint_hash: checkpoint.checkpoint_hash,
    next_page: nextPage,
    expires_at_ms: expiresAt
  };
  return {
    token: encodeContinuationMaterial(material),
    export_id: exportId,
    head: checkpoint.head,
    checkpoint_hash: checkpoint.checkpoint_hash,
    expires_at_ms: expiresAt
  };
}

function persistedScopeCheckpointManifestFromUnknown(value: unknown): PersistedScopeCheckpointManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== "woo.scope_checkpoint_manifest.v1") return null;
  if (typeof record.scope !== "string" || typeof record.checkpoint_hash !== "string") return null;
  const head = shadowScopeHeadFromUnknown(record.head);
  if (!head) return null;
  if (!Array.isArray(record.pages) || !Array.isArray(record.frame_tail)) return null;
  const pages: PersistedCheckpointPageRef[] = [];
  for (const item of record.pages) {
    const page = checkpointPageRefFromUnknown(item);
    if (!page) return null;
    pages.push(page);
  }
  const frameTail: PersistedCheckpointFrameRef[] = [];
  for (const item of record.frame_tail) {
    const frame = checkpointFrameRefFromUnknown(item);
    if (!frame) return null;
    frameTail.push(frame);
  }
  return {
    kind: "woo.scope_checkpoint_manifest.v1",
    scope: record.scope as ObjRef,
    head,
    checkpoint_hash: record.checkpoint_hash,
    pages,
    frame_tail: frameTail
  };
}

function checkpointPageRefFromUnknown(value: unknown): PersistedCheckpointPageRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== "woo.projection_page_ref.v1") return null;
  if (typeof record.page_index !== "number" || !Number.isInteger(record.page_index) || record.page_index < 0) return null;
  if (record.table !== "objects" && record.table !== "sessions" && record.table !== "logs" && record.table !== "snapshots" && record.table !== "parked_tasks" && record.table !== "tombstones" && record.table !== "tool_surfaces") return null;
  if (typeof record.page !== "string" || typeof record.hash !== "string") return null;
  if (typeof record.bytes !== "number" || !Number.isFinite(record.bytes) || record.bytes < 0) return null;
  return {
    kind: "woo.projection_page_ref.v1",
    page_index: record.page_index,
    table: record.table,
    page: record.page,
    hash: record.hash,
    bytes: record.bytes
  };
}

function checkpointFrameRefFromUnknown(value: unknown): PersistedCheckpointFrameRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.seq !== "number" || !Number.isInteger(record.seq) || record.seq < 0) return null;
  if (typeof record.hash !== "string") return null;
  if (typeof record.bytes !== "number" || !Number.isFinite(record.bytes) || record.bytes < 0) return null;
  return {
    seq: record.seq,
    hash: record.hash,
    bytes: record.bytes
  };
}

function checkpointPageRef(page: ProjectionPage, pageIndex: number, body = JSON.stringify(page)): PersistedCheckpointPageRef {
  return {
    kind: "woo.projection_page_ref.v1",
    page_index: pageIndex,
    table: page.table,
    page: page.page,
    hash: page.hash,
    bytes: JSON_BYTES.encode(body).byteLength
  };
}

function checkpointFrameRef(frame: ShadowCommitAccepted, body = JSON.stringify(frame)): PersistedCheckpointFrameRef {
  return {
    seq: frame.position.seq,
    hash: frame.position.hash,
    bytes: JSON_BYTES.encode(body).byteLength
  };
}

function frameContinuation(scope: ObjRef, afterHead: ShadowScopeHead, finalHead: ShadowScopeHead, nextSeq: number): OpenContinuation {
  const expiresAt = Date.now() + CHECKPOINT_CONTINUATION_TTL_MS;
  const exportId = `frames:${scope}:${finalHead.epoch}:${finalHead.seq}:${finalHead.hash}`;
  const material: DecodedOpenContinuation = {
    mode: "frames",
    scope,
    export_id: exportId,
    after_head: afterHead,
    head: finalHead,
    next_seq: nextSeq,
    expires_at_ms: expiresAt
  };
  return {
    token: encodeContinuationMaterial(material),
    export_id: exportId,
    head: finalHead,
    expires_at_ms: expiresAt
  };
}

function encodeContinuationMaterial(material: DecodedOpenContinuation): string {
  return storageKey(stableShadowJson({
    kind: "woo.open_checkpoint_tail.continuation.v1",
    ...material
  } as unknown as WooValue));
}

function decodeOpenContinuation(value: unknown): DecodedOpenContinuation | null {
  const token = continuationToken(value);
  if (!token) return null;
  try {
    const parsed = JSON.parse(decodeStorageKey(token)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.kind !== "woo.open_checkpoint_tail.continuation.v1") return null;
    const mode = record.mode;
    const scope = typeof record.scope === "string" ? record.scope as ObjRef : null;
    const exportId = typeof record.export_id === "string" ? record.export_id : null;
    const head = shadowScopeHeadFromUnknown(record.head);
    const expiresAt = typeof record.expires_at_ms === "number" ? record.expires_at_ms : null;
    if (!scope || !exportId || !head || expiresAt === null) return null;
    if (!continuationPublicFieldsMatch(value, exportId, head, expiresAt, typeof record.checkpoint_hash === "string" ? record.checkpoint_hash : undefined)) return null;
    if (mode === "checkpoint") {
      const checkpointHash = typeof record.checkpoint_hash === "string" ? record.checkpoint_hash : null;
      const nextPage = typeof record.next_page === "number" && Number.isInteger(record.next_page) ? record.next_page : null;
      if (!checkpointHash || nextPage === null) return null;
      return {
        mode,
        scope,
        export_id: exportId,
        head,
        checkpoint_hash: checkpointHash,
        next_page: nextPage,
        expires_at_ms: expiresAt
      };
    }
    if (mode === "frames") {
      const afterHead = shadowScopeHeadFromUnknown(record.after_head);
      const nextSeq = typeof record.next_seq === "number" && Number.isInteger(record.next_seq) ? record.next_seq : null;
      if (!afterHead || nextSeq === null) return null;
      return {
        mode,
        scope,
        export_id: exportId,
        after_head: afterHead,
        head,
        next_seq: nextSeq,
        expires_at_ms: expiresAt
      };
    }
    return null;
  } catch {
    return null;
  }
}

function continuationToken(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const token = (value as { token?: unknown }).token;
  return typeof token === "string" && token.trim() ? token : null;
}

function continuationPublicFieldsMatch(
  value: unknown,
  exportId: string,
  head: ShadowScopeHead,
  expiresAt: number,
  checkpointHash?: string
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  const record = value as Record<string, unknown>;
  if (typeof record.export_id === "string" && record.export_id !== exportId) return false;
  if (typeof record.expires_at_ms === "number" && record.expires_at_ms !== expiresAt) return false;
  if (typeof record.checkpoint_hash === "string" && record.checkpoint_hash !== checkpointHash) return false;
  const publicHead = shadowScopeHeadFromUnknown(record.head);
  if (publicHead && !shadowScopeHeadsEqual(publicHead, head)) return false;
  return true;
}

function shadowScopeHeadFromUnknown(value: unknown): ShadowScopeHead | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== "woo.scope_head.shadow.v1") return null;
  if (typeof record.scope !== "string") return null;
  if (typeof record.epoch !== "number" || !Number.isInteger(record.epoch)) return null;
  if (typeof record.seq !== "number" || !Number.isInteger(record.seq)) return null;
  if (typeof record.hash !== "string") return null;
  return {
    kind: "woo.scope_head.shadow.v1",
    scope: record.scope as ObjRef,
    epoch: record.epoch,
    seq: record.seq,
    hash: record.hash
  };
}

function shadowScopeHeadsEqual(left: ShadowScopeHead, right: ShadowScopeHead): boolean {
  return left.scope === right.scope && left.epoch === right.epoch && left.seq === right.seq && left.hash === right.hash;
}

function acceptedFrameForTransfer(frame: ShadowCommitAccepted): ShadowCommitAccepted {
  const copy = structuredClone(frame) as ShadowCommitAccepted;
  delete copy.projection_writes;
  return copy;
}

function projectionPages(table: "objects", rows: SerializedObject[]): Extract<ProjectionPage, { table: "objects" }>[];
function projectionPages(table: "sessions", rows: SerializedSession[]): Extract<ProjectionPage, { table: "sessions" }>[];
function projectionPages(table: "logs", rows: SerializedWorld["logs"][number][1]): Extract<ProjectionPage, { table: "logs" }>[];
function projectionPages(table: "snapshots", rows: SerializedWorld["snapshots"]): Extract<ProjectionPage, { table: "snapshots" }>[];
function projectionPages(table: "parked_tasks", rows: SerializedWorld["parkedTasks"]): Extract<ProjectionPage, { table: "parked_tasks" }>[];
function projectionPages(table: "tombstones", rows: Array<{ id: ObjRef }>): Extract<ProjectionPage, { table: "tombstones" }>[];
function projectionPages(table: ProjectionPage["table"], rows: unknown[]): ProjectionPage[] {
  const pages: ProjectionPage[] = [];
  let current: unknown[] = [];
  let currentBytes = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    const page = String(pages.length + 1).padStart(6, "0");
    const material = { kind: "woo.projection_page_material.v1", table, page, rows: current };
    pages.push({
      kind: "woo.projection_page.v1",
      table,
      page,
      hash: hashSource(stableShadowJson(material as unknown as WooValue)),
      rows: current
    } as ProjectionPage);
    current = [];
    currentBytes = 0;
  };
  for (const row of rows) {
    const rowBytes = jsonByteLength(row);
    if (current.length > 0 && currentBytes + rowBytes > CHECKPOINT_PAGE_TARGET_BYTES) flush();
    current.push(row);
    currentBytes += rowBytes;
    if (rowBytes > CHECKPOINT_PAGE_TARGET_BYTES) flush();
  }
  flush();
  return pages;
}

function browserProjectionDeltaFromWrites(
  writes: ProjectionWrite<BrowserProfile>[],
  authorityDelta: ProjectionDeltaSummary | undefined
): ProjectionDeltaSummary {
  const delta = summarizeProjectionWrites(writes as ProjectionWrite[]);
  if (authorityDelta?.tool_surface_sources?.length) {
    delta.tool_surface_sources = structuredClone(authorityDelta.tool_surface_sources);
  }
  return delta;
}

function requestContentLength(request: Request): number | undefined {
  const raw = request.headers.get("content-length");
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
