import { describe, expect, it, vi } from "vitest";
import { installVerb } from "../../src/core/authoring";
import { serializedWorldFromAuthoritySlice } from "../../src/core/authority-slice";
import { applyAcceptedShadowFrame } from "../../src/core/shadow-commit-scope";
import { createWorld } from "../../src/core/bootstrap";
import { decodeEnvelope, encodeEnvelope } from "../../src/core/shadow-envelope";
import {
  createShadowBrowserNode,
  createShadowBrowserRelayShim,
  openShadowBrowserScope,
  setShadowBrowserSessionToken,
  shadowBrowserEnvelope,
  shadowStateTransferCacheDigest
} from "../../src/core/shadow-browser-node";
import type { ShadowTurnExecReply } from "../../src/core/shadow-turn-exec";
import { runShadowTurnCall, type ShadowTurnCall } from "../../src/core/shadow-turn-call";
import { shadowTurnKeyFromTranscript } from "../../src/core/turn-key";
import { v2TurnGatewayAuthorityPayload } from "../../src/core/v2-turn-gateway";
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
  openScope: () => Promise<{ objects: number; sessions: number }>;
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
      // CommitScopeDO remains the scope-head authority, but accepted v2
      // commits now write through to the routed object host before reporting
      // success. A gateway-hosted object therefore gets only its touched
      // property rows persisted here, not a full gateway-world rewrite.
      expect(writeRowsByTable(gatewayState)).toMatchObject({
        property_value: 1,
        property_version: 1
      });
      expect(rowWrites(gatewayState)).toBe(2);
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
      const seed = await harness.openScope();
      const openWrites = writeRowsByTable(harness.scopeState);
      expect(openWrites).toMatchObject({
        v2_commit_scope_meta: 1,
        v2_commit_scope_object: seed.objects,
        v2_commit_scope_session: seed.sessions
      });
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

  it("coalesces concurrent cold opens into one full row materialization", async () => {
    const world = createWorld({ catalogs: false });
    const session = world.auth("guest:cf-v2-concurrent-open");
    const scopeState = new FakeDurableObjectState("#-1");
    const commitScope = new CommitScopeDO(scopeState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const env = { WOO_INTERNAL_SECRET: "cf-test-secret" };
    const authority = v2TurnGatewayAuthorityPayload(world, ["#-1", session.actor]);
    const expectedObjects = serializedWorldFromAuthoritySlice(authority.authority).objects.length;
    const expectedSessions = authority.sessions.length;
    resetStateCostLog(scopeState);

    try {
      await Promise.all(Array.from({ length: 4 }, async (_, index) => {
        const request = await signInternalRequest(env, new Request("https://woo.internal/v2/open", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            scope: "#-1",
            node: `browser:v2-concurrent-open-${index}`,
            token: "guest:cf-v2-concurrent-open",
            session: session.id,
            actor: session.actor,
            ...authority
          })
        }));
        const response = await commitScope.fetch(request);
        expect(response.ok).toBe(true);
      }));

      expect(writeRowsByTable(scopeState)).toMatchObject({
        v2_commit_scope_object: expectedObjects,
        v2_commit_scope_session: expectedSessions
      });
    } finally {
      scopeState.close();
    }
  });

  it("returns a compact executable seed marker when the open digest matches", async () => {
    const world = createWorld();
    const session = world.auth("guest:cf-v2-open-seed-cache");
    const scopeState = new FakeDurableObjectState("the_dubspace");
    const commitScope = new CommitScopeDO(scopeState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const env = { WOO_INTERNAL_SECRET: "cf-test-secret" };
    const metrics: Record<string, unknown>[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((label: unknown, payload: unknown) => {
      if (label === "woo.metric" && typeof payload === "string") {
        metrics.push(JSON.parse(payload) as Record<string, unknown>);
      }
    });

    const open = async (node: string, executableSeedDigest?: string, lastKnownHead?: Record<string, any>): Promise<Record<string, any>> => {
      const authority = v2TurnGatewayAuthorityPayload(world, ["the_dubspace", session.actor]);
      const request = await signInternalRequest(env, new Request("https://woo.internal/v2/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "the_dubspace",
          node,
          token: "guest:cf-v2-open-seed-cache",
          session: session.id,
          actor: session.actor,
          ...authority,
          ...(lastKnownHead ? { last_known_head: lastKnownHead } : {}),
          ...(executableSeedDigest ? { executable_seed_digest: executableSeedDigest } : {})
        })
      }));
      const response = await commitScope.fetch(request);
      expect(response.ok).toBe(true);
      return await response.json() as Record<string, any>;
    };

    try {
      const first = await open("browser:v2-open-seed-cache-a");
      const digest = shadowStateTransferCacheDigest(first.executable_transfer);
      const firstOpenMetric = lastMetric(metrics, "v2_open");
      expect(digest).toBeTruthy();
      expect(first.executable_transfer).toMatchObject({ mode: "cell_pages", purpose: "open_executable_seed" });
      expect(first.executable_transfer.inline_pages.length).toBeGreaterThan(0);

      const metricStart = metrics.length;
      resetStateCostLog(scopeState);
      const second = await open("browser:v2-open-seed-cache-b", digest ?? undefined, first.head);
      const secondMetrics = metrics.slice(metricStart);
      const secondOpenMetric = lastMetric(secondMetrics, "v2_open");
      const secondSeedMetric = lastMetric(secondMetrics, "shadow_open_executable_seed_bytes");
      const secondOpenStepPhases = Array.from(new Set(secondMetrics
        .filter((metric) => metric.kind === "v2_open_step")
        .map((metric) => String(metric.phase ?? ""))));
      expect(second.transfer).toMatchObject({
        mode: "delta",
        to: first.head,
        applied: [],
        transcript_tail: []
      });
      expect(second.executable_transfer).toMatchObject({
        mode: "cell_pages",
        purpose: "open_executable_seed_cache_hit",
        page_refs: [],
        inline_pages: []
      });
      expect(JSON.stringify(second.executable_transfer).length).toBeLessThan(
        JSON.stringify(first.executable_transfer).length / 10
      );
      expect(JSON.stringify(second).length).toBeLessThan(JSON.stringify(first).length / 10);
      // This is a regression guard for the work behind the compact response:
      // cache-hit opens must not durable-write, catalog-preseed, or rebuild and
      // resend the executable page closure. Raw wall-clock assertions are too
      // noisy for CI, but these counters pin the expensive operations.
      expect(rowWrites(scopeState)).toBe(0);
      expect(secondSeedMetric).toMatchObject({
        kind: "shadow_open_executable_seed_bytes",
        bytes: metricNumber(secondOpenMetric, "executable_transfer_bytes"),
        pages: 0,
        inline_pages: 0,
        status: "ok"
      });
      expect(secondOpenMetric).toMatchObject({
        kind: "v2_open",
        status: "ok",
        transfer_mode: "delta",
        executable_transfer_cache: "hit",
        executable_transfer_pages: 0,
        executable_transfer_inline_pages: 0,
        preseeded_objects: 0,
        full_save: false
      });
      expect(secondOpenStepPhases).toEqual(expect.arrayContaining([
        "read_json",
        "relay_for",
        "open_shadow_scope",
        "open_seed_cache_hit_build",
        "full_save",
        "response_encode"
      ]));
      expect(metricNumber(secondOpenMetric, "executable_transfer_bytes")).toBeLessThan(
        metricNumber(firstOpenMetric, "executable_transfer_bytes") / 10
      );
    } finally {
      logSpy.mockRestore();
      scopeState.close();
    }
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

  it("recovers from stale head without unbounded writes", async () => {
    const harness = await makeCostHarness();
    try {
      await harness.openScope();
      const firstEnvelope = await harness.envelope(1);
      await harness.internals.webSocketV2TurnNetworkMessage(harness.world, harness.ws as unknown as WebSocket, firstEnvelope);
      expect(latestTurnReply(harness.ws)).toMatchObject({ ok: true, commit: { position: { seq: 1 } } });
      resetCostLog(harness);

      const staleEnvelope = await harness.envelope(2);
      await harness.internals.webSocketV2TurnNetworkMessage(harness.world, harness.ws as unknown as WebSocket, staleEnvelope);

      expect(latestTurnReply(harness.ws)).toMatchObject({ ok: true, commit: { position: { seq: 2 } } });
      expect(rowWrites(harness.scopeState)).toBeLessThanOrEqual(8);
      expect(writeRowsByTable(harness.scopeState)).toMatchObject({
        v2_commit_scope_meta: 1,
        v2_commit_scope_object: 1,
        v2_commit_scope_accepted_frame: 1,
        v2_commit_scope_transcript_tail: 1,
        v2_commit_scope_seen: 1,
        v2_commit_scope_reply: 1
      });
    } finally {
      harness.cleanup();
    }
  });

  it("scales write cost linearly across many turns", async () => {
    const harness = await makeCostHarness();
    try {
      await harness.openScope();
      resetCostLog(harness);

      const batchSize = 12;
      for (let index = 1; index <= batchSize; index += 1) await harness.sendTurn(index);
      const writesAfterFirstBatch = rowWrites(harness.scopeState);
      for (let index = batchSize + 1; index <= batchSize * 2; index += 1) await harness.sendTurn(index);
      const writesAfterSecondBatch = rowWrites(harness.scopeState);
      const secondBatchPerTurn = (writesAfterSecondBatch - writesAfterFirstBatch) / batchSize;

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
  const initialAuthority = v2TurnGatewayAuthorityPayload(world, ["#-1", "cf_v2_cost_box", session.actor]);

  const relay = createShadowBrowserRelayShim({
    node: "node:commit-scope:#-1",
    scope: "#-1",
    serialized: serializedWorldFromAuthoritySlice(initialAuthority.authority)
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
      const authority = v2TurnGatewayAuthorityPayload(world, ["#-1", "cf_v2_cost_box", session.actor]);
      const request = await signInternalRequest(env, new Request("https://woo.internal/v2/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "#-1",
          node: "browser:v2-cost",
          token: "guest:cf-v2-cost",
          session: session.id,
          actor: session.actor,
          ...authority
        })
      }));
      const response = await commitScopeNamespace.get(commitScopeNamespace.idFromName("#-1")).fetch(request);
      expect(response.ok).toBe(true);
      return {
        objects: serializedWorldFromAuthoritySlice(authority.authority).objects.length,
        sessions: authority.sessions.length
      };
    },
    envelope: thisEnvelope,
    sendTurn: async (index: number) => {
      await internals.webSocketV2TurnNetworkMessage(world, ws as unknown as WebSocket, await thisEnvelope(index));
      applyLatestReplyToBrowser();
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

  function applyLatestReplyToBrowser(): void {
    const body = latestTurnReply(ws);
    if (body.ok === true && body.commit) {
      // Keep the simulated browser's planning head aligned with the committed
      // authority. Otherwise each measured turn first exercises the stale-head
      // recovery path, which is useful elsewhere but not in this write-cost guard.
      applyAcceptedShadowFrame(browser.relay.commit_scope, body.commit, body.transcript);
    }
  }
}

function latestTurnReply(ws: FakeWebSocket): ShadowTurnExecReply {
  const latest = ws.sent.at(-1);
  expect(latest).toBeTruthy();
  const reply = decodeEnvelope(latest!);
  expect(reply.type).toBe("woo.turn.exec.reply.shadow.v1");
  return reply.body as ShadowTurnExecReply;
}

function resetCostLog(harness: CostHarness): void {
  harness.scopeState.storage.sql.execLog.length = 0;
  harness.gatewayState.storage.sql.execLog.length = 0;
  harness.commitScopeNamespace.fetchCallCount = 0;
}

function resetStateCostLog(state: FakeDurableObjectState): void {
  state.storage.sql.execLog.length = 0;
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

function lastMetric(metrics: Record<string, unknown>[], kind: string): Record<string, unknown> {
  const metric = [...metrics].reverse().find((entry) => entry.kind === kind);
  expect(metric).toBeTruthy();
  return metric!;
}

function metricNumber(metric: Record<string, unknown>, field: string): number {
  const value = metric[field];
  expect(typeof value).toBe("number");
  return value as number;
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

function writeTable(query: string): string | null {
  const normalized = query.trim();
  return normalized.match(/^INSERT(?:\s+OR\s+REPLACE)?\s+INTO\s+([a-zA-Z0-9_]+)/i)?.[1]
    ?? normalized.match(/^UPDATE\s+([a-zA-Z0-9_]+)/i)?.[1]
    ?? normalized.match(/^DELETE\s+FROM\s+([a-zA-Z0-9_]+)/i)?.[1]
    ?? null;
}
