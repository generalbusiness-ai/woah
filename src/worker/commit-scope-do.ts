// CommitScopeDO is the durable home for v2 commit-scope state.
//
// The gateway remains the WebSocket edge, but every authority-bearing v2 turn
// envelope is handled here so commit head, catch-up tail, and reply idempotency
// survive gateway isolate hibernation. The shadow relay still runs in-process
// inside this DO. Storage is row-shaped rather than one large snapshot blob so
// hot envelope retries rewrite only the state families that actually changed.

import type { EffectTranscript } from "../core/effect-transcript";
import type { SerializedObject, SerializedSession, SerializedWorld } from "../core/repository";
import {
  buildShadowBrowserSessionAuth,
  buildShadowBrowserDeltaTransfer,
  createShadowBrowserClient,
  createShadowBrowserRelayShim,
  handleShadowBrowserTurnExecEnvelope,
  MAX_SHADOW_ACCEPTED_TAIL,
  MAX_SHADOW_IDEMPOTENCY_ENTRIES,
  MAX_SHADOW_RECENT_REPLIES_ENTRIES,
  MAX_SHADOW_TRANSCRIPT_TAIL,
  mergeShadowBrowserSessionState,
  openShadowBrowserScope,
  receiveShadowBrowserEnvelopeReceipt,
  shadowLiveEventsForTranscript,
  shadowBrowserTransportHello,
  type ShadowBrowserEnvelopeReceipt,
  type ShadowBrowserRelayShim,
  type ShadowBrowserStateTransfer,
  type ShadowTransportHello
} from "../core/shadow-browser-node";
import type { ShadowCommitAccepted, ShadowScopeHead } from "../core/shadow-commit-scope";
import { encodeEnvelope, type ShadowEnvelope } from "../core/shadow-envelope";
import type { ShadowTurnExecReply } from "../core/shadow-turn-exec";
import type { MetricEvent, ObjRef, WooValue } from "../core/types";
import { wooError } from "../core/types";
import { verifyInternalRequest, type InternalAuthEnv } from "./internal-auth";

// CommitScopeDO persists the full SerializedWorld snapshot in a single
// `v2_commit_scope_meta.serialized` column. Cloudflare Durable Object SQL
// rejects individual values larger than ~2 MiB with SQLITE_TOOBIG, and a
// world with the bundled catalogs installed crosses that boundary. Storage
// is gzipped + base64-encoded so it stays comfortably under the limit; the
// `GZB1:` prefix is the format marker and load detects legacy uncompressed
// JSON rows (which start with `{`) so existing scopes upgrade without a
// migration step.
const COMPRESSED_BLOB_PREFIX = "GZB1:";

async function encodeSerializedWorld(serialized: SerializedWorld): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(serialized));
  // Drive CompressionStream directly through its writable/readable interface;
  // wrapping in `new Response(...)` is convenient but fails in tests that stub
  // the global Response constructor (e.g. cf-repository's WebSocket upgrade
  // test), and we never need a Response object here.
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  const writeDone = writer.write(bytes).then(() => writer.close());
  const chunks = await readAllChunks(cs.readable);
  await writeDone;
  return COMPRESSED_BLOB_PREFIX + base64FromBytes(concatBytes(chunks));
}

async function decodeSerializedWorld(blob: string): Promise<SerializedWorld> {
  if (!blob.startsWith(COMPRESSED_BLOB_PREFIX)) {
    // Legacy uncompressed JSON row from before the gzip change. Parse as-is
    // so existing CommitScopeDOs (e.g. the_chatroom in production) keep
    // loading until their next write rewrites the row in compressed form.
    return JSON.parse(blob) as SerializedWorld;
  }
  const compressed = bytesFromBase64(blob.slice(COMPRESSED_BLOB_PREFIX.length));
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  // Cast to BufferSource: lib.dom TS types narrow Uint8Array's backing buffer
  // to `ArrayBuffer` and Node's TextEncoder returns the wider `ArrayBufferLike`.
  const writeDone = writer.write(compressed as unknown as BufferSource).then(() => writer.close());
  const chunks = await readAllChunks(ds.readable);
  await writeDone;
  return JSON.parse(new TextDecoder().decode(concatBytes(chunks))) as SerializedWorld;
}

async function readAllChunks(readable: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return chunks;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function base64FromBytes(bytes: Uint8Array): string {
  // btoa needs a binary string; String.fromCharCode(...arr) stack-overflows on
  // payloads larger than ~100 KB, so chunk the conversion.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function bytesFromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class CommitScopeDO {
  private relay: ShadowBrowserRelayShim | null = null;
  private snapshotLoaded = false;
  private needsFullSave = false;

  constructor(
    private readonly state: CommitScopeDurableState,
    private readonly env: InternalAuthEnv
  ) {
    const constructorStartedAt = Date.now();
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS v2_commit_scope_meta (id TEXT PRIMARY KEY, scope TEXT NOT NULL, relay_node TEXT NOT NULL, serialized TEXT NOT NULL, head TEXT NOT NULL, idempotency_window_ms INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
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
    console.log("woo.metric", JSON.stringify({ kind: "do_constructor", class: "CommitScopeDO", ms: Date.now() - constructorStartedAt, ts: Date.now(), host_key: this.durableScopeKey() }));
  }

  async fetch(request: Request): Promise<Response> {
    const handlerStartedAt = Date.now();
    const url = new URL(request.url);
    let handlerStatus: "ok" | "error" = "ok";
    let handlerError: string | undefined;
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
        const startedAt = Date.now();
        let scope: ObjRef | undefined;
        let node: string | undefined;
        let fullSave = false;
        try {
          await verifyInternalRequest(this.env, request);
          const input = await readJson<CommitScopeOpenRequest>(request);
          scope = input.scope;
          node = input.node;
          const relay = await this.relayFor(input);
          this.ensureSerializedSession(relay, input);
          const browser = this.browserFor(relay, input);
          const opened = await openShadowBrowserScope(browser, {
            preseed_catalog_pages: true,
            last_known_head: input.last_known_head
          });
          const hello = shadowBrowserTransportHello(browser);
          if (this.needsFullSave) {
            await this.saveFull(relay);
            this.needsFullSave = false;
            fullSave = true;
          }
          this.emitMetric({
            kind: "v2_open",
            scope,
            node,
            ms: Date.now() - startedAt,
            status: "ok",
            transfer_mode: opened.transfer.mode,
            full_save: fullSave
          });
          return jsonResponse({
            ok: true,
            relay: relay.node,
            hello,
            head: relay.commit_scope.head,
            transfer: opened.transfer
          } satisfies CommitScopeOpenResponse);
        } catch (err) {
          this.emitMetric({ kind: "v2_open", scope, node, ms: Date.now() - startedAt, status: "error", full_save: fullSave, error: metricErrorCode(err) });
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
          const reply = await handleShadowBrowserTurnExecEnvelope(browser, receipt, { profile: (event) => this.emitMetric(event) });
          if (this.needsFullSave) {
            await this.saveFull(relay);
            this.needsFullSave = false;
            fullSave = true;
          } else {
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
            reply: reply ? encodeEnvelope(reply) : null,
            head: relay.commit_scope.head,
            fanout
          } satisfies CommitScopeEnvelopeResponse);
        } catch (err) {
          this.emitMetric({ kind: "v2_envelope", scope, node, ms: Date.now() - startedAt, status: "error", full_save: fullSave, error: metricErrorCode(err) });
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
      handlerError = metricErrorCode(err);
      throw err;
    } finally {
      this.emitMetric({
        kind: "do_handler",
        class: "CommitScopeDO",
        method: request.method,
        route: url.pathname,
        ms: Date.now() - handlerStartedAt,
        status: handlerStatus,
        ...(handlerError ? { error: handlerError } : {})
      });
    }
  }

  private async relayFor(input: CommitScopeBaseRequest & { serialized?: SerializedWorld }): Promise<ShadowBrowserRelayShim> {
    if (!this.snapshotLoaded) {
      this.relay = await this.loadSnapshot(input);
      this.snapshotLoaded = true;
    }
    if (!this.relay) {
      if (!input.serialized) {
        throw wooError("E_PROTOCOL", `commit scope ${input.scope} has no durable snapshot; open the scope before sending envelopes`);
      }
      this.relay = createShadowBrowserRelayShim({
        node: `node:commit-scope:${input.scope}`,
        scope: input.scope,
        serialized: input.serialized
      });
      this.needsFullSave = true;
    }
    if (this.relay.commit_scope.scope !== input.scope) {
      throw wooError("E_PROTOCOL", `commit scope mismatch: have=${this.relay.commit_scope.scope} want=${input.scope}`);
    }
    this.refreshSessionAuth(this.relay, input);
    return this.relay;
  }

  private refreshSessionAuth(relay: ShadowBrowserRelayShim, input: CommitScopeBaseRequest): void {
    // Sessions can be refreshed by the gateway between messages. Refresh only
    // the auth maps and session actor records from the narrow session export;
    // the committed state and projection snapshot remain owned by this scope DO.
    const auth = buildShadowBrowserSessionAuth({
      sessions: input.sessions,
      scope: input.scope,
      deployment: relay.deployment,
      session_revs: input.session_revs
    });
    relay.session_auth = auth.session_auth;
    relay.session_revs = auth.session_revs;
    // Commit validation reads session authority from the committed serialized
    // state, not only from the transport auth map. Keep that narrow session
    // slice fresh so a new MCP/browser session can commit into a scope whose
    // durable snapshot was opened by an earlier session.
    relay.commit_scope.serialized.sessions = mergeShadowBrowserSessionState(relay.commit_scope.serialized.sessions, input.sessions);
    this.refreshSerializedObjects(relay, input.session_objects ?? []);
  }

  private ensureSerializedSession(relay: ShadowBrowserRelayShim, input: CommitScopeBaseRequest): void {
    // Commit validation and server-assisted planning read from the scope's
    // serialized world, not only from the transport auth maps. Keep the socket's
    // accepted session row present even when the gateway's narrow session export
    // and this long-lived scope snapshot briefly diverge.
    const current = input.sessions.find((session) => session.id === input.session && session.actor === input.actor);
    if (!current) return;
    const serialized = structuredClone(current) as SerializedSession;
    const index = relay.commit_scope.serialized.sessions.findIndex((session) => session.id === serialized.id);
    if (index < 0) {
      relay.commit_scope.serialized.sessions.push(serialized);
      relay.commit_scope.serialized.sessions.sort((a, b) => a.id.localeCompare(b.id));
      return;
    }
    const existing = relay.commit_scope.serialized.sessions[index];
    relay.commit_scope.serialized.sessions[index] = {
      ...serialized,
      activeScope: existing.actor === serialized.actor && existing.activeScope !== undefined
        ? existing.activeScope
        : serialized.activeScope
    };
  }

  private refreshSerializedObjects(relay: ShadowBrowserRelayShim, objects: SerializedObject[]): void {
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

  private fanoutEnvelopes(
    relay: ShadowBrowserRelayShim,
    originNode: string,
    reply: ShadowEnvelope<ShadowTurnExecReply>
  ): Array<{ node: string; envelope: string }> {
    const body = reply.body;
    if (body.ok !== true || !body.transcript) return [];
    if (!body.commit) return this.liveFanoutEnvelopes(relay, originNode, reply);
    const out: Array<{ node: string; envelope: string }> = [];
    for (const browser of relay.browsers.values()) {
      if (browser.node === originNode) continue;
      if (relay.subscriptions.get(body.commit.position.scope)?.has(browser.node) !== true) continue;
      const transfer = buildShadowBrowserDeltaTransfer(relay, body.commit as ShadowCommitAccepted, body.transcript, browser.node, {
        actor: browser.actor,
        session: browser.session
      });
      out.push({
        node: browser.node,
        envelope: encodeEnvelope({
          v: 2,
          type: transfer.kind,
          id: `${relay.node}:state:${body.commit.position.seq}:${browser.node}`,
          from: relay.node,
          to: browser.node,
          actor: browser.actor,
          ...(browser.session ? { session: browser.session } : {}),
          auth: { mode: "session", token: browser.session_token ?? "" },
          body: transfer
        } satisfies ShadowEnvelope<typeof transfer>)
      });
    }
    return out;
  }

  private liveFanoutEnvelopes(
    relay: ShadowBrowserRelayShim,
    originNode: string,
    reply: ShadowEnvelope<ShadowTurnExecReply>
  ): Array<{ node: string; envelope: string }> {
    const origin = relay.browsers.get(originNode);
    const body = reply.body;
    if (!origin || body.ok !== true || !body.transcript) return [];
    const out: Array<{ node: string; envelope: string }> = [];
    for (const event of shadowLiveEventsForTranscript(origin, body.transcript)) {
      const scope = event.audience?.scope ?? event.scope;
      for (const browser of relay.browsers.values()) {
        if (browser.node === originNode) continue;
        if (typeof scope === "string" && relay.subscriptions.get(scope)?.has(browser.node) !== true) continue;
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

  private emitShadowCommitMetric(reply: ShadowEnvelope<ShadowTurnExecReply> | null, node: string | undefined, fanout: number): void {
    const body = reply?.body;
    if (!body) return;
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
    }
  }

  private emitMetric(event: MetricEvent): void {
    console.log("woo.metric", JSON.stringify({ ...event, ts: Date.now(), host_key: this.durableScopeKey("scope" in event ? event.scope : undefined) }));
  }

  private durableScopeKey(scope?: ObjRef): string {
    return String(scope ?? (this.state.id as { name?: string }).name ?? "commit_scope");
  }

  private async loadSnapshot(input: CommitScopeBaseRequest): Promise<ShadowBrowserRelayShim | null> {
    return await this.loadRowSnapshot(input);
  }

  private async loadRowSnapshot(input: CommitScopeBaseRequest): Promise<ShadowBrowserRelayShim | null> {
    const rows = sqlRows<CommitScopeMetaRow>(this.state.storage.sql.exec(
      "SELECT scope, relay_node, serialized, head, idempotency_window_ms FROM v2_commit_scope_meta WHERE id = 'current'"
    ));
    const meta = rows[0] ?? null;
    if (!meta) return null;
    const relay = createShadowBrowserRelayShim({
      node: meta.relay_node,
      scope: meta.scope as ObjRef,
      serialized: await decodeSerializedWorld(meta.serialized),
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
    this.refreshSessionAuth(relay, input);
    return relay;
  }

  private async saveFull(relay: ShadowBrowserRelayShim): Promise<void> {
    // Full saves are reserved for cold initialization and one-time migration
    // from the legacy blob table. Hot envelopes use saveEnvelopeDelta instead.
    const now = Date.now();
    // Gzip-encode the serialized world before opening the storage transaction,
    // since CompressionStream is async and transactionSync requires sync work.
    const serializedBlob = await encodeSerializedWorld(relay.commit_scope.serialized);
    this.state.storage.transactionSync(() => {
      this.saveMeta(relay, now, serializedBlob);
      this.saveAcceptedFrames(relay, now);
      this.saveTranscriptTail(relay, now);
      this.saveSeenKeys(relay);
      this.saveRecentReplies(relay, now);
    });
  }

  private async saveEnvelopeDelta(
    relay: ShadowBrowserRelayShim,
    receipt: ShadowBrowserEnvelopeReceipt,
    reply: ShadowEnvelope<ShadowTurnExecReply> | null
  ): Promise<void> {
    // Replayed envelopes authenticate and return the cached reply, but they do
    // not mutate relay state. Skipping storage here makes retry idempotency
    // side-effect-free as well as turn-execution-free.
    if (!receipt.fresh) return;
    const seenAt = relay.recently_seen.get(receipt.idempotency_key);
    if (seenAt === undefined) return;
    const now = Date.now();
    // The delta path only rewrites the meta row when a turn actually committed.
    // Skip the (async, ~100 ms on 2 MiB) gzip pass when the reply was rejected
    // or carries no commit, so write-amplification stays proportional to real
    // commits rather than every envelope retry.
    const body = reply?.body;
    const willSaveMeta = body?.ok === true && Boolean(body.commit) && Boolean(body.transcript);
    const serializedBlob = willSaveMeta
      ? await encodeSerializedWorld(relay.commit_scope.serialized)
      : null;
    this.state.storage.transactionSync(() => {
      this.saveSeenKey(receipt.idempotency_key, seenAt);
      this.pruneSeenAndReplies(relay, now);
      if (reply) {
        this.saveRecentReply(receipt.idempotency_key, reply, now);
        this.pruneRecentReplies();
      }
      if (willSaveMeta && serializedBlob !== null && body && body.ok === true && body.commit && body.transcript) {
        this.saveMeta(relay, now, serializedBlob);
        this.saveAcceptedFrame(body.commit, now);
        this.saveTranscript(body.transcript, now);
        this.pruneAcceptedFrames(relay);
        this.pruneTranscriptTail(relay);
      }
    });
  }

  private saveMeta(relay: ShadowBrowserRelayShim, now: number, serializedBlob: string): void {
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO v2_commit_scope_meta(id, scope, relay_node, serialized, head, idempotency_window_ms, updated_at) VALUES ('current', ?, ?, ?, ?, ?, ?)",
      relay.commit_scope.scope,
      relay.node,
      serializedBlob,
      JSON.stringify(relay.commit_scope.head),
      relay.idempotency_window_ms,
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

  private saveRecentReply(key: string, reply: ShadowEnvelope<ShadowTurnExecReply>, now: number): void {
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
  session_revs?: Record<string, number>;
};

type CommitScopeOpenRequest = CommitScopeBaseRequest & {
  serialized: SerializedWorld;
  last_known_head?: ShadowScopeHead;
};

type CommitScopeOpenResponse = {
  ok: true;
  relay: string;
  hello: ShadowTransportHello;
  head: ShadowScopeHead;
  transfer: ShadowBrowserStateTransfer;
};

type CommitScopeEnvelopeRequest = CommitScopeBaseRequest & {
  envelope: string;
};

type CommitScopeEnvelopeResponse = {
  ok: true;
  reply: string | null;
  head: ShadowScopeHead;
  fanout: Array<{ node: string; envelope: string }>;
};

type CommitScopeMetaRow = {
  scope: string;
  relay_node: string;
  serialized: string;
  head: string;
  idempotency_window_ms: number;
};

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

type V2EnvelopeReplyMetric = "none" | "accepted" | "live" | "missing_state" | "commit_rejected";

function shadowReplyMetricKind(reply: ShadowEnvelope<ShadowTurnExecReply> | null): V2EnvelopeReplyMetric {
  const body = reply?.body;
  if (!body) return "none";
  if (body.ok === false) return body.reason;
  return body.commit ? "accepted" : "live";
}

function metricErrorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code?: unknown }).code === "string") return (err as { code: string }).code;
  if (err instanceof Error && err.name) return err.name;
  return "E_UNKNOWN";
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
