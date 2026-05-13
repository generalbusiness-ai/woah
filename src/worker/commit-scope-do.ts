// CommitScopeDO is the durable home for v2 commit-scope state.
//
// The gateway remains the WebSocket edge, but every authority-bearing v2 turn
// envelope is handled here so commit head, catch-up tail, and reply idempotency
// survive gateway isolate hibernation. The shadow relay still runs in-process
// inside this DO. Storage is row-shaped rather than one large snapshot blob so
// hot envelope retries rewrite only the state families that actually changed.

import type { EffectTranscript } from "../core/effect-transcript";
import type { SerializedSession, SerializedWorld } from "../core/repository";
import {
  buildShadowBrowserSessionAuth,
  createShadowBrowserNode,
  createShadowBrowserRelayShim,
  handleShadowBrowserTurnExecEnvelope,
  openShadowBrowserScope,
  receiveShadowBrowserEnvelopeReceipt,
  setShadowBrowserSessionToken,
  shadowBrowserTransportHello,
  type ShadowBrowserRelayShim,
  type ShadowTransportHello
} from "../core/shadow-browser-node";
import type { ShadowCommitAccepted, ShadowScopeHead } from "../core/shadow-commit-scope";
import { encodeEnvelope, type ShadowEnvelope } from "../core/shadow-envelope";
import type { ObjRef, WooValue } from "../core/types";
import { wooError } from "../core/types";
import { verifyInternalRequest, type InternalAuthEnv } from "./internal-auth";

export class CommitScopeDO {
  private relay: ShadowBrowserRelayShim | null = null;
  private snapshotLoaded = false;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: InternalAuthEnv
  ) {
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS v2_commit_scope_snapshot (id TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at INTEGER NOT NULL)"
    );
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
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return jsonResponse({
        ok: true,
        kind: "woo.commit_scope_do.v1",
        id: String(this.state.id),
        ts: Date.now()
      });
    }
    if (request.method === "POST" && url.pathname === "/v2/open") {
      await verifyInternalRequest(this.env, request);
      const input = await readJson<CommitScopeOpenRequest>(request);
      const relay = await this.relayFor(input);
      const browser = this.browserFor(relay, input);
      await openShadowBrowserScope(browser, { preseed_catalog_pages: true });
      const hello = shadowBrowserTransportHello(browser);
      await this.save(relay);
      return jsonResponse({
        ok: true,
        relay: relay.node,
        hello
      } satisfies CommitScopeOpenResponse);
    }
    if (request.method === "POST" && url.pathname === "/v2/envelope") {
      await verifyInternalRequest(this.env, request);
      const input = await readJson<CommitScopeEnvelopeRequest>(request);
      const relay = await this.relayFor(input);
      const browser = this.browserFor(relay, input);
      const receipt = receiveShadowBrowserEnvelopeReceipt(browser, input.envelope);
      const reply = await handleShadowBrowserTurnExecEnvelope(browser, receipt);
      await this.save(relay);
      return jsonResponse({
        ok: true,
        reply: reply ? encodeEnvelope(reply) : null,
        head: relay.commit_scope.head
      } satisfies CommitScopeEnvelopeResponse);
    }
    return jsonResponse({
      error: {
        code: "E_NOT_IMPLEMENTED",
        message: "CommitScopeDO storage is reserved for the v2 turn-network commit scope"
      }
    }, 501);
  }

  private async relayFor(input: CommitScopeBaseRequest & { serialized?: SerializedWorld }): Promise<ShadowBrowserRelayShim> {
    if (!this.snapshotLoaded) {
      this.relay = this.loadSnapshot(input);
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
      await this.save(this.relay);
    }
    if (this.relay.commit_scope.scope !== input.scope) {
      throw wooError("E_PROTOCOL", `commit scope mismatch: have=${this.relay.commit_scope.scope} want=${input.scope}`);
    }
    this.refreshSessionAuth(this.relay, input);
    return this.relay;
  }

  private refreshSessionAuth(relay: ShadowBrowserRelayShim, input: CommitScopeBaseRequest): void {
    // Sessions can be refreshed by the gateway between messages. Refresh only
    // the auth maps from the narrow session export; the committed state and
    // projection snapshot remain owned by this scope DO.
    const auth = buildShadowBrowserSessionAuth({
      sessions: input.sessions,
      scope: input.scope,
      deployment: relay.deployment,
      session_revs: input.session_revs
    });
    relay.session_auth = auth.session_auth;
    relay.session_revs = auth.session_revs;
  }

  private browserFor(relay: ShadowBrowserRelayShim, input: CommitScopeBaseRequest) {
    const browser = createShadowBrowserNode({
      node: input.node,
      scope: input.scope,
      actor: input.actor,
      session: input.session,
      relay
    });
    setShadowBrowserSessionToken(browser, input.token);
    return browser;
  }

  private loadSnapshot(input: CommitScopeBaseRequest): ShadowBrowserRelayShim | null {
    const rowRelay = this.loadRowSnapshot(input);
    if (rowRelay) return rowRelay;
    const rows = sqlRows<{ body?: string }>(this.state.storage.sql.exec(
      "SELECT body FROM v2_commit_scope_snapshot WHERE id = 'current'"
    ));
    const row = rows[0] ?? null;
    if (!row?.body) return null;
    const snapshot = JSON.parse(row.body) as CommitScopeSnapshot;
    const relay = createShadowBrowserRelayShim({
      node: snapshot.relay_node,
      scope: snapshot.scope,
      serialized: snapshot.serialized,
      idempotency_window_ms: snapshot.idempotency_window_ms
    });
    relay.commit_scope.head = snapshot.head;
    relay.accepted_frames = snapshot.accepted_frames;
    relay.transcript_tail = snapshot.transcript_tail;
    relay.recently_seen = new Map(snapshot.recently_seen);
    relay.recent_replies = new Map(snapshot.recent_replies);
    this.refreshSessionAuth(relay, input);
    return relay;
  }

  private loadRowSnapshot(input: CommitScopeBaseRequest): ShadowBrowserRelayShim | null {
    const rows = sqlRows<CommitScopeMetaRow>(this.state.storage.sql.exec(
      "SELECT scope, relay_node, serialized, head, idempotency_window_ms FROM v2_commit_scope_meta WHERE id = 'current'"
    ));
    const meta = rows[0] ?? null;
    if (!meta) return null;
    const relay = createShadowBrowserRelayShim({
      node: meta.relay_node,
      scope: meta.scope as ObjRef,
      serialized: JSON.parse(meta.serialized) as SerializedWorld,
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
    relay.recent_replies = new Map(sqlRows<{ idempotency_key: string; body: string }>(this.state.storage.sql.exec(
      "SELECT idempotency_key, body FROM v2_commit_scope_reply ORDER BY updated_at"
    )).map((row) => [decodeStorageKey(row.idempotency_key), JSON.parse(row.body) as ShadowEnvelope<WooValue>]));
    this.refreshSessionAuth(relay, input);
    return relay;
  }

  private async save(relay: ShadowBrowserRelayShim): Promise<void> {
    const now = Date.now();
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        "INSERT OR REPLACE INTO v2_commit_scope_meta(id, scope, relay_node, serialized, head, idempotency_window_ms, updated_at) VALUES ('current', ?, ?, ?, ?, ?, ?)",
        relay.commit_scope.scope,
        relay.node,
        JSON.stringify(relay.commit_scope.serialized),
        JSON.stringify(relay.commit_scope.head),
        relay.idempotency_window_ms,
        now
      );
      this.saveAcceptedFrames(relay, now);
      this.saveTranscriptTail(relay, now);
      this.saveSeenKeys(relay);
      this.saveRecentReplies(relay, now);
    });
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
}

type CommitScopeBaseRequest = {
  scope: ObjRef;
  node: string;
  token: string;
  session: string;
  actor: ObjRef;
  sessions: SerializedSession[];
  session_revs?: Record<string, number>;
};

type CommitScopeOpenRequest = CommitScopeBaseRequest & {
  serialized: SerializedWorld;
};

type CommitScopeOpenResponse = {
  ok: true;
  relay: string;
  hello: ShadowTransportHello;
};

type CommitScopeEnvelopeRequest = CommitScopeBaseRequest & {
  envelope: string;
};

type CommitScopeEnvelopeResponse = {
  ok: true;
  reply: string | null;
  head: ShadowScopeHead;
};

type CommitScopeSnapshot = {
  kind: "woo.commit_scope_snapshot.shadow.v1";
  scope: ObjRef;
  relay_node: string;
  serialized: SerializedWorld;
  head: ShadowScopeHead;
  idempotency_window_ms: number;
  accepted_frames: ShadowCommitAccepted[];
  transcript_tail: EffectTranscript[];
  recently_seen: Array<[string, number]>;
  recent_replies: Array<[string, ShadowEnvelope<WooValue>]>;
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
