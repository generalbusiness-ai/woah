import { describe, expect, it, vi } from "vitest";
import { installVerb } from "../../src/core/authoring";
import { createWorld } from "../../src/core/bootstrap";
import { encodeEnvelope } from "../../src/core/shadow-envelope";
import {
  createShadowBrowserNode,
  createShadowBrowserRelayShim,
  openShadowBrowserScope,
  setShadowBrowserSessionToken,
  shadowBrowserEnvelope
} from "../../src/core/shadow-browser-node";
import { runShadowTurnCall, type ShadowTurnCall } from "../../src/core/shadow-turn-call";
import { shadowTurnKeyFromTranscript } from "../../src/core/turn-key";
import type { SerializedWorld } from "../../src/core/repository";
import type { WooWorld } from "../../src/core/world";
import { CommitScopeDO } from "../../src/worker/commit-scope-do";
import { DirectoryDO } from "../../src/worker/directory-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { PersistentObjectDO, type Env } from "../../src/worker/persistent-object-do";
import { FakeDurableObjectNamespace, FakeDurableObjectState } from "./fake-do";

vi.setConfig({ testTimeout: 120_000 });

class FakeWebSocket {
  readonly sent: string[] = [];

  constructor(private readonly attachment: Record<string, unknown>) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {}

  deserializeAttachment(): unknown {
    return this.attachment;
  }
}

type CostHarness = {
  world: WooWorld;
  internals: {
    webSocketV2TurnNetworkMessage: (world: WooWorld, ws: WebSocket, message: string | ArrayBuffer) => Promise<void>;
  };
  ws: FakeWebSocket;
  gatewayState: FakeDurableObjectState;
  scopeState: FakeDurableObjectState;
  commitScopeNamespace: FakeDurableObjectNamespace;
  openScope: () => Promise<void>;
  envelope: (index: number) => Promise<string>;
  sendTurn: (index: number) => Promise<void>;
  cleanup: () => void;
};

describe("v2 CommitScopeDO cost budget", () => {
  it("keeps an MCP v2 tool call off the gateway durable-write path", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");
    const commitStates = new Map<string, FakeDurableObjectState>();
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const commitScopeNamespace = new FakeDurableObjectNamespace((name) => {
      let state = commitStates.get(name);
      if (!state) {
        state = new FakeDurableObjectState(name);
        commitStates.set(name, state);
      }
      return new CommitScopeDO(state as unknown as ConstructorParameters<typeof CommitScopeDO>[0], { WOO_INTERNAL_SECRET: "cf-test-secret" });
    });
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-v2-mcp-cost-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected DirectoryDO ${name}`);
        return directory;
      }),
      WOO: new FakeDurableObjectNamespace((name) => {
        throw new Error(`unexpected Woo DO ${name}`);
      }),
      COMMIT_SCOPE: commitScopeNamespace
    } as unknown as Env;
    const gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);

    try {
      const sessionId = await initializeMcp(gateway, "guest:cf-v2-mcp-cost", 1);
      await mcp(gateway, sessionId, 2, "tools/call", {
        name: "woo_call",
        arguments: { object: "guest_1", verb: "set_description", args: ["warm mcp v2 scope"] }
      });
      const directScopeState = commitStates.get("#-1");
      expect(directScopeState).toBeTruthy();

      resetStateCostLog(gatewayState);
      resetStateCostLog(directScopeState!);
      commitScopeNamespace.fetchCallCount = 0;

      const said = await mcp(gateway, sessionId, 3, "tools/call", {
        name: "woo_call",
        arguments: { object: "guest_1", verb: "set_description", args: ["cost guard over mcp v2"] }
      });
      expect(said.result).toMatchObject({ isError: false });
      // The MCP gateway applies the accepted v2 transcript as an in-memory
      // routing/tool-list cache update. It must not persist the gateway world
      // on the v2 hot path; CommitScopeDO is the durable authority.
      expect(rowWrites(gatewayState)).toBe(0);
      expect(commitScopeNamespace.fetchCallCount).toBe(1);
      expect(writeRowsByTable(directScopeState!)).toMatchObject({
        v2_commit_scope_meta: 1,
        v2_commit_scope_accepted_frame: 1,
        v2_commit_scope_transcript_tail: 1,
        v2_commit_scope_seen: 1,
        v2_commit_scope_reply: 1
      });
    } finally {
      directoryState.close();
      gatewayState.close();
      for (const state of commitStates.values()) state.close();
    }
  });

  it("keeps one authority-bearing envelope inside the per-turn write and invocation budget", async () => {
    const harness = await makeCostHarness();
    try {
      await harness.openScope();
      resetCostLog(harness);

      await harness.sendTurn(1);

      const writes = rowWrites(harness.scopeState);
      // Expected row writes for one committed turn:
      // meta + touched object + accepted_frame + transcript_tail + seen +
      // reply = 6. The object row is the committed state delta; it replaces
      // the old full-world blob rewrite in v2_commit_scope_meta.serialized.
      // Reply envelopes stay durable so retries remain reply-idempotent across
      // CommitScopeDO hibernation; the separate reply cap prevents unbounded
      // growth inside the idempotency window.
      // Budget allows two small retention/accounting additions, but rejects the
      // old retained-tail rewrite pattern that produced thousands of writes.
      expect(writes).toBeLessThanOrEqual(8);
      expect(writeRowsByTable(harness.scopeState)).toEqual({
        v2_commit_scope_meta: 1,
        v2_commit_scope_object: 1,
        v2_commit_scope_accepted_frame: 1,
        v2_commit_scope_transcript_tail: 1,
        v2_commit_scope_seen: 1,
        v2_commit_scope_reply: 1
      });
      // v2 envelope handling may read gateway sessions for auth projection,
      // but it must not persist session activity, metrics, or cache state on
      // the gateway hot path.
      expect(rowWrites(harness.gatewayState)).toBe(0);
      // One browser envelope should cross exactly one extra Durable Object
      // boundary: gateway -> CommitScopeDO. Extra hops are billing-visible.
      expect(harness.commitScopeNamespace.fetchCallCount).toBe(1);
    } finally {
      harness.cleanup();
    }
  });

  it("stores cold-start state as object rows, then keeps the first envelope delta-sized", async () => {
    const harness = await makeCostHarness();
    try {
      await harness.openScope();
      const openWrites = writeRowsByTable(harness.scopeState);
      expect(openWrites).toMatchObject({
        v2_commit_scope_meta: 1,
        v2_commit_scope_object: harness.world.exportWorld().objects.length,
        v2_commit_scope_session: harness.world.exportWorld().sessions.length
      });
      expect(sqlRows(harness.scopeState.storage.sql.exec(
        "SELECT serialized IS NULL AS cleared FROM v2_commit_scope_meta WHERE id = 'current'"
      ))[0]).toMatchObject({ cleared: 1 });
      resetCostLog(harness);

      await harness.sendTurn(1);

      // After open, the first committed envelope should write only the changed
      // object plus small authority/idempotency rows. A return to full-state
      // rewrites would show up as one object write per object here.
      expect(rowWrites(harness.scopeState)).toBeLessThanOrEqual(8);
      expect(writeRowsByTable(harness.scopeState)).toMatchObject({
        v2_commit_scope_object: 1
      });
    } finally {
      harness.cleanup();
    }
  });

  it.each([
    ["raw JSON", async (serialized: SerializedWorld) => JSON.stringify(serialized)],
    ["GZB1 gzip", encodeLegacyGzipSerializedWorld]
  ])("migrates a legacy %s single-blob scope into row-shaped storage on open", async (_name, encodeLegacy) => {
    const state = new FakeDurableObjectState("#-1");
    const world = createWorld();
    const session = world.auth("guest:legacy-commit-scope");
    const serialized = world.exportWorld();
    const legacyBlob = await encodeLegacy(serialized);
    const legacyRelay = createShadowBrowserRelayShim({
      node: "node:commit-scope:#-1",
      scope: "#-1",
      serialized
    });
    state.storage.sql.exec(
      "CREATE TABLE v2_commit_scope_meta (id TEXT PRIMARY KEY, scope TEXT NOT NULL, relay_node TEXT NOT NULL, serialized TEXT NOT NULL, head TEXT NOT NULL, idempotency_window_ms INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
    );
    state.storage.sql.exec(
      "INSERT INTO v2_commit_scope_meta(id, scope, relay_node, serialized, head, idempotency_window_ms, updated_at) VALUES ('current', ?, ?, ?, ?, ?, ?)",
      "#-1",
      legacyRelay.node,
      legacyBlob,
      JSON.stringify(legacyRelay.commit_scope.head),
      legacyRelay.idempotency_window_ms,
      Date.now()
    );

    const scope = new CommitScopeDO(state as unknown as ConstructorParameters<typeof CommitScopeDO>[0], { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const request = await signInternalRequest({ WOO_INTERNAL_SECRET: "cf-test-secret" }, new Request("https://woo.internal/v2/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "#-1",
        node: "browser:legacy-migration",
        token: "guest:legacy-commit-scope",
        session: session.id,
        actor: session.actor,
        sessions: world.exportSessions(),
        serialized
      })
    }));

    const response = await scope.fetch(request);
    expect(response.ok).toBe(true);
    expect(sqlRows<{ n: number }>(state.storage.sql.exec("SELECT COUNT(*) AS n FROM v2_commit_scope_object"))[0]?.n).toBe(serialized.objects.length);
    expect(sqlRows<{ n: number }>(state.storage.sql.exec("SELECT COUNT(*) AS n FROM v2_commit_scope_session"))[0]?.n).toBe(serialized.sessions.length);
    expect(sqlRows<{ cleared: number }>(state.storage.sql.exec(
      "SELECT serialized IS NULL AS cleared FROM v2_commit_scope_meta WHERE id = 'current'"
    ))[0]).toMatchObject({ cleared: 1 });
  });

  it("performs exactly zero durable writes on duplicate envelope replay", async () => {
    const harness = await makeCostHarness();
    try {
      await harness.openScope();
      const envelope = await harness.envelope(1);
      await harness.internals.webSocketV2TurnNetworkMessage(harness.world, harness.ws as unknown as WebSocket, envelope);
      const writesBeforeReplay = rowWrites(harness.scopeState);
      const gatewayWritesBeforeReplay = rowWrites(harness.gatewayState);

      await harness.internals.webSocketV2TurnNetworkMessage(harness.world, harness.ws as unknown as WebSocket, envelope);

      // Duplicate replay must be reply-idempotent and storage-idempotent. If
      // this changes, retries can revive the same cost cliff as executing a
      // fresh turn, even though the side effect is correctly deduped.
      expect(rowWrites(harness.scopeState)).toBe(writesBeforeReplay);
      expect(rowWrites(harness.gatewayState)).toBe(gatewayWritesBeforeReplay);
    } finally {
      harness.cleanup();
    }
  });

  it("scales write cost linearly across many turns", async () => {
    const harness = await makeCostHarness();
    try {
      await harness.openScope();
      resetCostLog(harness);

      for (let index = 1; index <= 20; index += 1) await harness.sendTurn(index);
      const writesAfterFirstBatch = rowWrites(harness.scopeState);
      for (let index = 21; index <= 40; index += 1) await harness.sendTurn(index);
      const writesAfterSecondBatch = rowWrites(harness.scopeState);
      const secondBatchPerTurn = (writesAfterSecondBatch - writesAfterFirstBatch) / 20;

      // Expected remains about 6 writes/turn regardless of retained tail size.
      // O(retained) rewrites grow this number as history accumulates.
      expect(secondBatchPerTurn).toBeLessThanOrEqual(8);
    } finally {
      harness.cleanup();
    }
  });
});

async function makeCostHarness(): Promise<CostHarness> {
  const directoryState = new FakeDurableObjectState("directory");
  const gatewayState = new FakeDurableObjectState("world");
  const scopeState = new FakeDurableObjectState("#-1");
  const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
  const commitScope = new CommitScopeDO(scopeState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
  const commitScopeNamespace = new FakeDurableObjectNamespace((name) => {
    if (name !== "#-1") throw new Error(`unexpected CommitScopeDO ${name}`);
    return commitScope;
  });
  const env = {
    WOO_INITIAL_WIZARD_TOKEN: "cf-v2-cost-token",
    WOO_INTERNAL_SECRET: "cf-test-secret",
    WOO_AUTO_INSTALL_CATALOGS: "",
    DIRECTORY: new FakeDurableObjectNamespace((name) => {
      if (name !== "directory") throw new Error(`unexpected DirectoryDO ${name}`);
      return directory;
    }),
    WOO: new FakeDurableObjectNamespace((name) => {
      throw new Error(`unexpected Woo DO ${name}`);
    }),
    COMMIT_SCOPE: commitScopeNamespace
  } as unknown as Env;
  const gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);
  const internals = gateway as unknown as CostHarness["internals"];
  const world = createWorld();
  const session = world.auth("guest:cf-v2-cost");
  world.createObject({ id: "cf_v2_cost_box", name: "V2 Cost Box", parent: "$thing", owner: session.actor });
  world.defineProperty("cf_v2_cost_box", { name: "value", defaultValue: 0, owner: session.actor, perms: "rw", typeHint: "int" });
  expect(installVerb(world, "cf_v2_cost_box", "set_value", `verb :set_value(value) rxd {
    this.value = value;
    return this.value;
  }`, null).ok).toBe(true);

  const relay = createShadowBrowserRelayShim({
    node: "node:commit-scope:#-1",
    scope: "#-1",
    serialized: world.exportWorld()
  });
  const browser = createShadowBrowserNode({
    node: "browser:v2-cost",
    scope: "#-1",
    actor: session.actor,
    session: session.id,
    relay
  });
  setShadowBrowserSessionToken(browser, "guest:cf-v2-cost");
  await openShadowBrowserScope(browser, { preseed_catalog_pages: true });
  const ws = new FakeWebSocket({
    protocol: "v2-turn-network",
    sessionId: session.id,
    actor: session.actor,
    socketId: "v2-cost-socket",
    node: "browser:v2-cost",
    scope: "#-1",
    token: "guest:cf-v2-cost"
  });

  return {
    world,
    internals,
    ws,
    gatewayState,
    scopeState,
    commitScopeNamespace,
    openScope: async () => {
      const request = await signInternalRequest(env, new Request("https://woo.internal/v2/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "#-1",
          node: "browser:v2-cost",
          token: "guest:cf-v2-cost",
          session: session.id,
          actor: session.actor,
          sessions: world.exportSessions(),
          serialized: world.exportWorld()
        })
      }));
      const response = await commitScopeNamespace.get(commitScopeNamespace.idFromName("#-1")).fetch(request);
      expect(response.ok).toBe(true);
    },
    envelope: thisEnvelope,
    sendTurn: async (index: number) => {
      await internals.webSocketV2TurnNetworkMessage(world, ws as unknown as WebSocket, await thisEnvelope(index));
    },
    cleanup: () => {
      directoryState.close();
      gatewayState.close();
      scopeState.close();
    }
  };

  async function thisEnvelope(index: number): Promise<string> {
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: `cf-v2-cost-value-${index}`,
      route: "direct",
      scope: "#-1",
      session: session.id,
      actor: session.actor,
      target: "cf_v2_cost_box",
      verb: "set_value",
      args: [67]
    };
    const planned = await runShadowTurnCall(browser.relay.commit_scope.serialized, call);
    const request = {
      kind: "woo.turn.exec.request.shadow.v1" as const,
      id: call.id,
      call,
      key: shadowTurnKeyFromTranscript(planned.transcript),
      expected: browser.relay.commit_scope.head,
      persistence: "durable" as const
    };
    return encodeEnvelope(shadowBrowserEnvelope(browser, request.kind, request, `cf-v2-cost-env-${index}`));
  }
}

function resetCostLog(harness: CostHarness): void {
  harness.scopeState.storage.sql.execLog.length = 0;
  harness.gatewayState.storage.sql.execLog.length = 0;
  harness.commitScopeNamespace.fetchCallCount = 0;
}

function resetStateCostLog(state: FakeDurableObjectState): void {
  state.storage.sql.execLog.length = 0;
}

async function encodeLegacyGzipSerializedWorld(serialized: SerializedWorld): Promise<string> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  const writeDone = writer.write(new TextEncoder().encode(JSON.stringify(serialized))).then(() => writer.close());
  const chunks = await readAllChunks(cs.readable);
  await writeDone;
  return `GZB1:${base64FromBytes(concatBytes(chunks))}`;
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
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function initializeMcp(gateway: PersistentObjectDO, token: string, id: number): Promise<string> {
  const init = await gateway.fetch(jsonRpcRequest({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "v2-cost-budget", version: "0.0.0" }
    }
  }, { "mcp-token": token }));
  expect(init.ok).toBe(true);
  const sessionId = init.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  const notified = await gateway.fetch(jsonRpcRequest({
    jsonrpc: "2.0",
    method: "notifications/initialized"
  }, { "mcp-session-id": sessionId! }));
  expect(notified.status).toBe(202);
  return sessionId!;
}

async function mcp(gateway: PersistentObjectDO, sessionId: string, id: number, method: string, params?: unknown): Promise<any> {
  const response = await gateway.fetch(jsonRpcRequest({
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params })
  }, { "mcp-session-id": sessionId }));
  expect(response.ok).toBe(true);
  return await response.json();
}

function jsonRpcRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://woo.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });
}

function rowWrites(state: FakeDurableObjectState): number {
  return state.storage.sql.execLog
    .filter((entry) => /^(INSERT|UPDATE|DELETE)\b/i.test(entry.query.trim()))
    .reduce((total, entry) => total + entry.changes, 0);
}

function writeRowsByTable(state: FakeDurableObjectState): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of state.storage.sql.execLog) {
    if (!/^(INSERT|UPDATE|DELETE)\b/i.test(entry.query.trim())) continue;
    if (entry.changes === 0) continue;
    const table = writeTable(entry.query);
    if (!table) continue;
    counts[table] = (counts[table] ?? 0) + entry.changes;
  }
  return counts;
}

function sqlRows<T>(cursor: { toArray(): Record<string, unknown>[] }): T[] {
  return cursor.toArray() as T[];
}

function writeTable(query: string): string | null {
  const normalized = query.trim();
  return normalized.match(/^INSERT(?:\s+OR\s+REPLACE)?\s+INTO\s+([a-zA-Z0-9_]+)/i)?.[1]
    ?? normalized.match(/^UPDATE\s+([a-zA-Z0-9_]+)/i)?.[1]
    ?? normalized.match(/^DELETE\s+FROM\s+([a-zA-Z0-9_]+)/i)?.[1]
    ?? null;
}
