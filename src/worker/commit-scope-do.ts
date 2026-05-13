// CommitScopeDO is the durable home for v2 commit-scope state.
//
// The gateway remains the WebSocket edge, but every authority-bearing v2 turn
// envelope is handled here so commit head, catch-up tail, and reply idempotency
// survive gateway isolate hibernation. The shadow relay still runs in-process
// inside this DO; later work can replace the JSON snapshot with narrower SQL
// tables without changing the browser/relay boundary.

import type { EffectTranscript } from "../core/effect-transcript";
import type { SerializedWorld } from "../core/repository";
import {
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

  private async relayFor(input: CommitScopeBaseRequest): Promise<ShadowBrowserRelayShim> {
    if (!this.snapshotLoaded) {
      this.relay = this.loadSnapshot(input);
      this.snapshotLoaded = true;
    }
    if (!this.relay) {
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
    // Sessions can be refreshed by the gateway between messages. Rebuilding the
    // auth maps from the latest seed keeps token revocation and actor/session
    // checks current without overwriting the authoritative committed state.
    const fresh = createShadowBrowserRelayShim({
      node: this.relay.node,
      scope: input.scope,
      serialized: input.serialized,
      idempotency_window_ms: this.relay.idempotency_window_ms
    });
    this.relay.session_auth = fresh.session_auth;
    this.relay.session_revs = fresh.session_revs;
    return this.relay;
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
    // See relayFor(): session auth is always derived from the gateway's latest
    // serialized world, not from the possibly older committed-state snapshot.
    const fresh = createShadowBrowserRelayShim({
      node: relay.node,
      scope: input.scope,
      serialized: input.serialized,
      idempotency_window_ms: relay.idempotency_window_ms
    });
    relay.session_auth = fresh.session_auth;
    relay.session_revs = fresh.session_revs;
    return relay;
  }

  private async save(relay: ShadowBrowserRelayShim): Promise<void> {
    const snapshot: CommitScopeSnapshot = {
      kind: "woo.commit_scope_snapshot.shadow.v1",
      scope: relay.commit_scope.scope,
      relay_node: relay.node,
      serialized: relay.commit_scope.serialized,
      head: relay.commit_scope.head,
      idempotency_window_ms: relay.idempotency_window_ms,
      accepted_frames: relay.accepted_frames,
      transcript_tail: relay.transcript_tail,
      recently_seen: Array.from(relay.recently_seen.entries()),
      recent_replies: Array.from(relay.recent_replies.entries())
    };
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO v2_commit_scope_snapshot(id, body, updated_at) VALUES ('current', ?, ?)",
      JSON.stringify(snapshot),
      Date.now()
    );
  }
}

type CommitScopeBaseRequest = {
  scope: ObjRef;
  node: string;
  token: string;
  session: string;
  actor: ObjRef;
  serialized: SerializedWorld;
};

type CommitScopeOpenRequest = CommitScopeBaseRequest;

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

async function readJson<T>(request: Request): Promise<T> {
  return await request.json() as T;
}

function sqlRows<T>(cursor: unknown): T[] {
  if (cursor && typeof cursor === "object" && "toArray" in cursor && typeof cursor.toArray === "function") {
    return cursor.toArray() as T[];
  }
  return Array.from(cursor as Iterable<T>);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
