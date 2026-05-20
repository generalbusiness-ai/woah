// CommitScopeDO is the durable home for v2 commit-scope state.
//
// The gateway remains the WebSocket edge, but every authority-bearing v2 turn
// envelope is handled here so commit head, catch-up tail, and reply idempotency
// survive gateway isolate hibernation. The shadow relay still runs in-process
// inside this DO. Storage is row-shaped rather than one large snapshot blob so
// hot envelope retries rewrite only the state families that actually changed.

import type { EffectTranscript } from "../core/effect-transcript";
import type { ShadowCapabilityAd } from "../core/capability-ad";
import { mergeSerializedAuthoritySlice, serializedWorldFromAuthoritySlice } from "../core/authority-slice";
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
  markShadowBrowserRelaySerializedChanged,
  mergeShadowBrowserSessionState,
  openShadowBrowserScope,
  receiveShadowBrowserEnvelopeReceipt,
  setShadowBrowserSessionToken,
  shadowLiveEventMatchesBrowser,
  shadowLiveEventsForTranscript,
  shadowBrowserTransportHello,
  subscribeShadowBrowserNode,
  type ShadowBrowserEnvelopeReceipt,
  type ShadowBrowserRelayShim,
  type ShadowBrowserStateTransfer,
  type ShadowTransportHello
} from "../core/shadow-browser-node";
import {
  shadowCommitScopeObject,
  shadowCommitScopeSession,
  transcriptLogEntry,
  transcriptSessionActiveScope,
  transcriptTouchedObjectIds,
  type ShadowCommitAccepted,
  type ShadowScopeHead
} from "../core/shadow-commit-scope";
import { encodeEnvelope, type ShadowEnvelope } from "../core/shadow-envelope";
import { stableShadowJson } from "../core/shadow-cell-version";
import type { ShadowTurnExecReply } from "../core/shadow-turn-exec";
import type { MetricEvent, ObjRef, WooValue } from "../core/types";
import { wooError } from "../core/types";
import { V2_COMMIT_SCOPE_SNAPSHOT_REQUIRED } from "../core/executor";
import {
  isShadowTurnExecReply,
  shadowReplyMetricKind,
  type ShadowEnvelopeReplyBody
} from "../core/v2-reply-predicates";
import { verifyInternalRequest, type InternalAuthEnv } from "./internal-auth";
import { metricErrorFields } from "./metric-errors";
import { writeMetricToAnalytics, writeConstructorMetricToAnalytics } from "./metrics-sink";

const SHADOW_OPEN_EXECUTABLE_SEED_WARN_BYTES = 1_000_000;

export class CommitScopeDO {
  private relay: ShadowBrowserRelayShim | null = null;
  private snapshotLoaded = false;
  private needsFullSave = false;
  private relayInitPromise: Promise<ShadowBrowserRelayShim> | null = null;
  private fullSavePromise: Promise<void> | null = null;

  constructor(
    private readonly state: CommitScopeDurableState,
    private readonly env: InternalAuthEnv
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
    const constructorMs = Date.now() - constructorStartedAt;
    console.log("woo.metric", JSON.stringify({ kind: "do_constructor", class: "CommitScopeDO", ms: constructorMs, ts: Date.now(), host_key: this.durableScopeKey() }));
    writeConstructorMetricToAnalytics("CommitScopeDO", constructorMs, this.durableScopeKey(), this.env.METRICS);
  }

  async fetch(request: Request): Promise<Response> {
    const handlerStartedAt = Date.now();
    const url = new URL(request.url);
    let handlerStatus: "ok" | "error" = "ok";
    let handlerError: string | undefined;
    let handlerErrorDetail: string | undefined;
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
          const relay = await this.relayFor(input);
          this.emitV2OpenStep("relay_for", phaseStartedAt, { scope, node });
          phaseStartedAt = metricNow();
          this.ensureSerializedSession(relay, input);
          this.emitV2OpenStep("ensure_session", phaseStartedAt, { scope, node, count: input.sessions.length });
          phaseStartedAt = metricNow();
          const browser = this.browserFor(relay, input);
          this.emitV2OpenStep("browser_for", phaseStartedAt, { scope, node });
          phaseStartedAt = metricNow();
          const opened = await openShadowBrowserScope(browser, {
            preseed_catalog_pages: true,
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
        try {
          await verifyInternalRequest(this.env, request);
          const input = await readJson<CommitScopeEnvelopeRequest>(request);
          scope = input.scope;
          node = input.node;
          const relay = await this.relayFor(input);
          this.ensureSerializedSession(relay, input);
          const browser = this.browserFor(relay, input);
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
            await this.saveEnvelopeDelta(relay, receipt, reply);
          }
          const fanout = reply ? this.fanoutEnvelopes(relay, input.node, reply) : [];
          this.emitMetric({
            kind: "v2_envelope",
            scope,
            node,
            ms: Date.now() - startedAt,
            status: "ok",
            fresh: receipt.fresh,
            reply: shadowReplyMetricKind(reply),
            fanout: fanout.length,
            full_save: fullSave
          });
          this.emitShadowCommitMetric(reply, node, fanout.length);
          return jsonResponse({
            ok: true,
            reply: reply ? encodeEnvelope<ShadowEnvelopeReplyBody>(reply as ShadowEnvelope<ShadowEnvelopeReplyBody>) : null,
            head: relay.commit_scope.head,
            fanout
          } satisfies CommitScopeEnvelopeResponse);
        } catch (err) {
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
      throw err;
    } finally {
      this.emitMetric({
        kind: "do_handler",
        class: "CommitScopeDO",
        method: request.method,
        route: url.pathname,
        ms: Date.now() - handlerStartedAt,
        status: handlerStatus,
        ...(handlerError ? { error: handlerError } : {}),
        ...(handlerErrorDetail ? { error_detail: handlerErrorDetail } : {})
      });
    }
  }

  private async relayFor(input: CommitScopeBaseRequest & { serialized?: SerializedWorld }): Promise<ShadowBrowserRelayShim> {
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
    this.refreshSessionAuth(this.relay, input);
    return this.relay;
  }

  private async initializeRelay(input: CommitScopeBaseRequest & { serialized?: SerializedWorld }): Promise<ShadowBrowserRelayShim> {
    if (this.relay) return this.relay;
    if (!this.snapshotLoaded) {
      const loaded = await this.loadSnapshot();
      this.snapshotLoaded = true;
      if (loaded) {
        this.relay = loaded;
        return loaded;
      }
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
    this.relay = relay;
    this.needsFullSave = true;
    return relay;
  }

  private refreshSessionAuth(relay: ShadowBrowserRelayShim, input: CommitScopeBaseRequest): void {
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
    if (authority) {
      if (mergeSerializedAuthoritySlice(relay.commit_scope.serialized, authority, { clone: true })) {
        markShadowBrowserRelaySerializedChanged(relay);
      }
      return;
    }
    const mergedSessions = mergeShadowBrowserSessionState(relay.commit_scope.serialized.sessions, sessionRows);
    if (stableShadowJson(mergedSessions as unknown as WooValue) !== stableShadowJson(relay.commit_scope.serialized.sessions as unknown as WooValue)) {
      relay.commit_scope.serialized.sessions = mergedSessions;
      markShadowBrowserRelaySerializedChanged(relay);
    }
    this.refreshSerializedObjects(relay, input.session_objects ?? []);
  }

  private ensureSerializedSession(relay: ShadowBrowserRelayShim, input: CommitScopeBaseRequest): void {
    // Commit validation and server-assisted planning read from the scope's
    // serialized world, not only from the transport auth maps. Keep the socket's
    // accepted session row present even when the gateway's narrow session export
    // and this long-lived scope snapshot briefly diverge.
    const current = (input.authority?.sessions ?? input.sessions).find((session) => session.id === input.session && session.actor === input.actor);
    if (!current) return;
    const serialized = structuredClone(current) as SerializedSession;
    const index = relay.commit_scope.serialized.sessions.findIndex((session) => session.id === serialized.id);
    if (index < 0) {
      relay.commit_scope.serialized.sessions.push(serialized);
      relay.commit_scope.serialized.sessions.sort((a, b) => a.id.localeCompare(b.id));
      markShadowBrowserRelaySerializedChanged(relay);
      return;
    }
    const existing = relay.commit_scope.serialized.sessions[index];
    const next = input.authority
      ? serialized
      : {
        ...serialized,
        activeScope: existing.actor === serialized.actor && existing.activeScope !== undefined
          ? existing.activeScope
          : serialized.activeScope
      };
    if (stableShadowJson(next as unknown as WooValue) !== stableShadowJson(existing as unknown as WooValue)) {
      relay.commit_scope.serialized.sessions[index] = next;
      markShadowBrowserRelaySerializedChanged(relay);
    }
  }

  private refreshSerializedObjects(relay: ShadowBrowserRelayShim, objects: SerializedObject[]): void {
    if (objects.length === 0) return;
    const byId = new Map(relay.commit_scope.serialized.objects.map((obj, index) => [obj.id, index] as const));
    for (const obj of objects) {
      const clone = structuredClone(obj) as SerializedObject;
      const index = byId.get(clone.id);
      if (index === undefined) {
        byId.set(clone.id, relay.commit_scope.serialized.objects.length);
        relay.commit_scope.serialized.objects.push(clone);
      } else {
        relay.commit_scope.serialized.objects[index] = clone;
      }
    }
    markShadowBrowserRelaySerializedChanged(relay);
  }

  private browserFor(relay: ShadowBrowserRelayShim, input: CommitScopeBaseRequest) {
    return createShadowBrowserClient({
      node: input.node,
      scope: input.scope,
      actor: input.actor,
      session: input.session,
      relay,
      token: input.token
    });
  }

  private stateTransferBrowserFor(relay: ShadowBrowserRelayShim, input: CommitScopeStateTransferRequest) {
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

  private fanoutEnvelopes(
    relay: ShadowBrowserRelayShim,
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
    relay: ShadowBrowserRelayShim,
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

  private async loadSnapshot(): Promise<ShadowBrowserRelayShim | null> {
    return await this.loadRowSnapshot();
  }

  private async loadRowSnapshot(): Promise<ShadowBrowserRelayShim | null> {
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
    relay.accepted_frames = sqlRows<{ body: string }>(this.state.storage.sql.exec(
      "SELECT body FROM v2_commit_scope_accepted_frame ORDER BY scope, seq"
    )).map((row) => JSON.parse(row.body) as ShadowCommitAccepted);
    relay.transcript_tail = sqlRows<{ body: string }>(this.state.storage.sql.exec(
      "SELECT body FROM v2_commit_scope_transcript_tail ORDER BY scope, seq, hash"
    )).map((row) => JSON.parse(row.body) as EffectTranscript);
    relay.recently_seen = new Map(sqlRows<{ idempotency_key: string; seen_at: number }>(this.state.storage.sql.exec(
      "SELECT idempotency_key, seen_at FROM v2_commit_scope_seen ORDER BY seen_at"
    )).map((row) => [decodeStorageKey(row.idempotency_key), Number(row.seen_at)]));
    // Reply envelopes are capped separately from seen keys. Persisting them
    // costs one hot-path row, but preserves reply-idempotency when a client
    // retries after the CommitScopeDO hibernates and rehydrates.
    relay.recent_replies = new Map(sqlRows<{ idempotency_key: string; body: string }>(this.state.storage.sql.exec(
      "SELECT idempotency_key, body FROM v2_commit_scope_reply ORDER BY updated_at"
    )).map((row) => [decodeStorageKey(row.idempotency_key), JSON.parse(row.body) as ShadowEnvelope<WooValue>]));
    return relay;
  }

  private async saveFullIfNeeded(relay: ShadowBrowserRelayShim): Promise<boolean> {
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

  private loadSerializedWorld(meta: CommitScopeMetaRow): SerializedWorld {
    const objectRows = sqlRows<{ body: string }>(this.state.storage.sql.exec(
      "SELECT body FROM v2_commit_scope_object ORDER BY id"
    ));
    return {
      version: Number(meta.version ?? 1) as 1,
      objectCounter: Number(meta.object_counter ?? 1),
      parkedTaskCounter: Number(meta.parked_task_counter ?? 1),
      sessionCounter: Number(meta.session_counter ?? 1),
      objects: objectRows.map((row) => JSON.parse(row.body) as SerializedObject),
      sessions: sqlRows<{ body: string }>(this.state.storage.sql.exec(
        "SELECT body FROM v2_commit_scope_session ORDER BY id"
      )).map((row) => JSON.parse(row.body) as SerializedSession),
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
  }

  private async saveFull(relay: ShadowBrowserRelayShim): Promise<void> {
    // Full saves run only on cold initialization, when the gateway delivered
    // the seed snapshot via /v2/open. Hot envelopes use saveEnvelopeDelta to
    // rewrite only the rows the accepted transcript actually touched.
    const now = Date.now();
    this.state.storage.transactionSync(() => {
      this.saveMeta(relay, now);
      this.saveWorldRows(relay.commit_scope.serialized, now);
      this.saveAcceptedFrames(relay, now);
      this.saveTranscriptTail(relay, now);
      this.saveSeenKeys(relay);
      this.saveRecentReplies(relay, now);
    });
  }

  private async saveEnvelopeDelta(
    relay: ShadowBrowserRelayShim,
    receipt: ShadowBrowserEnvelopeReceipt,
    reply: ShadowEnvelope<ShadowEnvelopeReplyBody> | null
  ): Promise<void> {
    // Replayed envelopes authenticate and return the cached reply, but they do
    // not mutate relay state. Skipping storage here makes retry idempotency
    // side-effect-free as well as turn-execution-free.
    if (!receipt.fresh) return;
    const seenAt = relay.recently_seen.get(receipt.idempotency_key);
    if (seenAt === undefined) return;
    const now = Date.now();
    const body = reply?.body;
    const willSaveMeta = isShadowTurnExecReply(body) && body.ok === true && Boolean(body.commit) && Boolean(body.transcript);
    this.state.storage.transactionSync(() => {
      this.saveSeenKey(receipt.idempotency_key, seenAt);
      this.pruneSeenAndReplies(relay, now);
      if (reply) {
        this.saveRecentReply(receipt.idempotency_key, reply, now);
        this.pruneRecentReplies();
      }
      if (willSaveMeta && body && isShadowTurnExecReply(body) && body.ok === true && body.commit && body.transcript) {
        this.saveMeta(relay, now);
        this.saveTranscriptDelta(relay, body.transcript, now);
        this.saveAcceptedFrame(body.commit, now);
        this.saveTranscript(body.transcript, now);
        this.pruneAcceptedFrames(relay);
        this.pruneTranscriptTail(relay);
      }
    });
  }

  private saveMeta(relay: ShadowBrowserRelayShim, now: number): void {
    const serialized = relay.commit_scope.serialized;
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO v2_commit_scope_meta(id, scope, relay_node, head, idempotency_window_ms, version, object_counter, parked_task_counter, session_counter, updated_at) VALUES ('current', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      relay.commit_scope.scope,
      relay.node,
      JSON.stringify(relay.commit_scope.head),
      relay.idempotency_window_ms,
      serialized.version,
      serialized.objectCounter,
      serialized.parkedTaskCounter,
      serialized.sessionCounter,
      now
    );
  }

  private saveWorldRows(serialized: SerializedWorld, now: number): void {
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

  private saveTranscriptDelta(relay: ShadowBrowserRelayShim, transcript: EffectTranscript, now: number): void {
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

  private saveAcceptedFrames(relay: ShadowBrowserRelayShim, now: number): void {
    const live = new Set<string>();
    for (const frame of relay.accepted_frames) {
      live.add(`${frame.position.scope}\u0000${frame.position.seq}`);
      this.state.storage.sql.exec(
        "INSERT OR REPLACE INTO v2_commit_scope_accepted_frame(scope, seq, id, position_hash, body, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        frame.position.scope,
        frame.position.seq,
        frame.id ?? "",
        frame.position.hash,
        JSON.stringify(frame),
        now
      );
    }
    for (const row of sqlRows<{ scope: string; seq: number }>(this.state.storage.sql.exec("SELECT scope, seq FROM v2_commit_scope_accepted_frame"))) {
      if (!live.has(`${row.scope}\u0000${row.seq}`)) {
        this.state.storage.sql.exec("DELETE FROM v2_commit_scope_accepted_frame WHERE scope = ? AND seq = ?", row.scope, row.seq);
      }
    }
  }

  private saveAcceptedFrame(frame: ShadowCommitAccepted, now: number): void {
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO v2_commit_scope_accepted_frame(scope, seq, id, position_hash, body, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      frame.position.scope,
      frame.position.seq,
      frame.id ?? "",
      frame.position.hash,
      JSON.stringify(frame),
      now
    );
  }

  private pruneAcceptedFrames(relay: ShadowBrowserRelayShim): void {
    const oldestKeptSeq = relay.commit_scope.head.seq - MAX_SHADOW_ACCEPTED_TAIL + 1;
    if (oldestKeptSeq <= 1) return;
    this.state.storage.sql.exec(
      "DELETE FROM v2_commit_scope_accepted_frame WHERE scope = ? AND seq < ?",
      relay.commit_scope.scope,
      oldestKeptSeq
    );
  }

  private saveTranscriptTail(relay: ShadowBrowserRelayShim, now: number): void {
    const live = new Set<string>();
    for (const transcript of relay.transcript_tail) {
      live.add(transcript.hash);
      this.state.storage.sql.exec(
        "INSERT OR REPLACE INTO v2_commit_scope_transcript_tail(scope, seq, hash, body, updated_at) VALUES (?, ?, ?, ?, ?)",
        transcript.scope,
        transcript.seq,
        transcript.hash,
        JSON.stringify(transcript),
        now
      );
    }
    for (const row of sqlRows<{ hash: string }>(this.state.storage.sql.exec("SELECT hash FROM v2_commit_scope_transcript_tail"))) {
      if (!live.has(row.hash)) this.state.storage.sql.exec("DELETE FROM v2_commit_scope_transcript_tail WHERE hash = ?", row.hash);
    }
  }

  private saveTranscript(transcript: EffectTranscript, now: number): void {
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO v2_commit_scope_transcript_tail(scope, seq, hash, body, updated_at) VALUES (?, ?, ?, ?, ?)",
      transcript.scope,
      transcript.seq,
      transcript.hash,
      JSON.stringify(transcript),
      now
    );
  }

  private pruneTranscriptTail(relay: ShadowBrowserRelayShim): void {
    const oldestKeptSeq = relay.commit_scope.head.seq - MAX_SHADOW_TRANSCRIPT_TAIL + 1;
    if (oldestKeptSeq <= 1) return;
    this.state.storage.sql.exec(
      "DELETE FROM v2_commit_scope_transcript_tail WHERE scope = ? AND seq < ?",
      relay.commit_scope.scope,
      oldestKeptSeq
    );
  }

  private saveSeenKeys(relay: ShadowBrowserRelayShim): void {
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

  private pruneSeenAndReplies(relay: ShadowBrowserRelayShim, now: number): void {
    const cutoff = now - relay.idempotency_window_ms;
    this.state.storage.sql.exec("DELETE FROM v2_commit_scope_seen WHERE seen_at < ?", cutoff);
    this.state.storage.sql.exec("DELETE FROM v2_commit_scope_reply WHERE idempotency_key NOT IN (SELECT idempotency_key FROM v2_commit_scope_seen)");
    this.pruneTableByCount("v2_commit_scope_seen", "seen_at", MAX_SHADOW_IDEMPOTENCY_ENTRIES);
    this.state.storage.sql.exec("DELETE FROM v2_commit_scope_reply WHERE idempotency_key NOT IN (SELECT idempotency_key FROM v2_commit_scope_seen)");
  }

  private saveRecentReplies(relay: ShadowBrowserRelayShim, now: number): void {
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
  sessions: SerializedSession[];
  session_objects?: SerializedObject[];
  authority?: SerializedAuthoritySlice;
  session_revs?: Record<string, number>;
};

type CommitScopeOpenRequest = CommitScopeBaseRequest & {
  serialized?: SerializedWorld;
  last_known_head?: ShadowScopeHead;
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
  head: ShadowScopeHead;
  fanout: Array<{ node: string; envelope: string }>;
};

type CommitScopeStateTransferResponse = {
  ok: true;
  relay: string;
  transfer: ShadowBrowserStateTransfer;
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

function requestContentLength(request: Request): number | undefined {
  const raw = request.headers.get("content-length");
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
