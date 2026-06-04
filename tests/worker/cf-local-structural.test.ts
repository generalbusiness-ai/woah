import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import { CommitScopeDO } from "../../src/worker/commit-scope-do";
import { DirectoryDO } from "../../src/worker/directory-do";
import { PersistentObjectDO, type Env } from "../../src/worker/persistent-object-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { mergeShadowStatePagesIntoSerialized, shadowObjectLineagePage, shadowObjectLivePage } from "../../src/core/shadow-state-pages";
import type { SerializedObject, SerializedWorld } from "../../src/core/repository";
import type { ObjRef } from "../../src/core/types";
import { FakeDurableObjectNamespace, FakeDurableObjectState } from "./fake-do";

vi.setConfig({ testTimeout: 45_000 });

const PROD_CATALOGS = "chat,demoworld,dubspace,help,note,pinboard,prog,tasks,blocks-demo";
const PROD_SHARDS = 32;
const DIRECTORY_PRESENCE_WINDOW_MS = 5 * 60_000;

describe("CF-local prod-shape structural probes", () => {
  it("rejects partial state-page materialization before it becomes a deployed-only lineage failure", () => {
    const deck = serializedObject("the_deck", "The Deck", "$space");

    expect(() =>
      mergeShadowStatePagesIntoSerialized(
        undefined,
        [shadowObjectLivePage(deck)],
        emptySerializedWorld
      )
    ).toThrow(/state page set missing lineage page for the_deck/);

    const merged = mergeShadowStatePagesIntoSerialized(
      undefined,
      [shadowObjectLineagePage(deck), shadowObjectLivePage(deck)],
      emptySerializedWorld
    );
    expect(merged.objects.map((obj) => obj.id)).toEqual(["the_deck"]);
  });

  it("keeps a one-turn prod-shaped MCP enter within structural budgets", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const harness = createStructuralHarness();
    const runId = `cf-local-structural-${Date.now()}-${randomUUID().slice(0, 8)}`;
    let sessionId: string | null = null;
    try {
      const staleSessionIds = await seedDirectoryMcpAudience(harness, runId, {
        scope: "the_chatroom",
        sessions: 29,
        uniqueShards: 17
      });
      harness.setDirectoryLastSeenAt(staleSessionIds, Date.now() - DIRECTORY_PRESENCE_WINDOW_MS - 60_000);
      logSpy.mockClear();

      sessionId = await openMcpSession(harness, `guest:cf-local-structural-${runId}`, runId);
      await callTool(harness, sessionId, 3, "woo_call", { object: "the_chatroom", verb: "enter", args: [] });

      const metrics = metricsFromLogSpy(logSpy);
      const maxDirectorySessions = maxMetric(metrics, "directory_sessions_for_scopes", "sessions");
      const maxAudienceSessionShards = maxMetric(metrics, "mcp_fanout", "audience_session_shards");
      const maxFanoutShards = maxMetric(metrics, "mcp_fanout", "shards");
      const mcpGatewayConstructors = metrics
        .filter((m) => m.kind === "do_constructor" && m.class === "PersistentObjectDO")
        .filter((m) => String(m.host_key ?? "").startsWith("mcp-gateway-"))
        .length;
      const commitFanoutGatewayTargets = new Set(metrics
        .filter((m) => m.kind === "cross_host_rpc" && m.route === "/__internal/mcp-commit-fanout")
        .map((m) => String(m.host ?? "")))
        .size;
      const hostSeedDoFetches = metrics
        .filter((m) => m.kind === "startup_storage" && m.phase === "host_seed_fetch" && m.source === "do")
        .length;
      const authorityReconstructions = metrics
        .filter((m) => m.kind === "authority_slice_reconstructed")
        .length;
      const enterTurns = metrics
        .filter((m) => m.kind === "turn_phase_timing" && m.target === "the_chatroom" && m.verb === "enter");

      expect(enterTurns.length, "the structural probe must exercise the real MCP turn path").toBeGreaterThan(0);
      expect(
        enterTurns.map((m) => ({ attempts: Number(m.attempts), authority_calls: Number(m.authority_calls) })),
        "one-turn smoke should converge without repair-round multiplication"
      ).toEqual([{ attempts: 1, authority_calls: 1 }]);
      expect(maxDirectorySessions, "stale Directory rows must not enter the presence authority payload").toBeLessThanOrEqual(2);
      expect(maxAudienceSessionShards, "stale sessions must not choose one MCP gateway shard each").toBeLessThanOrEqual(2);
      expect(maxFanoutShards, "commit fanout must stay proportional to live audience shards").toBeLessThanOrEqual(2);
      expect(mcpGatewayConstructors, "one live actor plus stale rows must not cold-start prod-scale gateway shards").toBeLessThanOrEqual(3);
      expect(commitFanoutGatewayTargets, "one enter must not fan out to many stale MCP gateway shards").toBeLessThanOrEqual(2);
      expect(hostSeedDoFetches, "one enter should not scatter host-seed cold loads").toBeLessThanOrEqual(3);
      expect(authorityReconstructions, "B7 warm-fill regressions show up as authority reconstruction fan-in").toBeLessThanOrEqual(8);
    } finally {
      if (sessionId) await mcpFetch(harness, { method: "DELETE", headers: { "mcp-session-id": sessionId } }).catch(() => undefined);
      logSpy.mockRestore();
      harness.close();
    }
  });
});

type StructuralHarness = {
  env: Env;
  request(path: string, init: RequestInit): Promise<Response>;
  setDirectoryLastSeenAt(sessionIds: readonly string[], lastSeenAt: number): void;
  close(): void;
};

class FakeKVNamespace {
  readonly values = new Map<string, string>();

  async get(key: string, _type?: "text"): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

function createStructuralHarness(): StructuralHarness {
  const directoryState = new FakeDurableObjectState("directory");
  const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-local-structural-secret" });
  const wooStates = new Map<string, FakeDurableObjectState>();
  const wooObjects = new Map<string, PersistentObjectDO>();
  const commitStates = new Map<string, FakeDurableObjectState>();
  const commitObjects = new Map<string, CommitScopeDO>();
  let env: Env;

  const wooNamespace = new FakeDurableObjectNamespace((name) => {
    let object = wooObjects.get(name);
    if (!object) {
      const state = wooStates.get(name) ?? new FakeDurableObjectState(name);
      wooStates.set(name, state);
      object = new PersistentObjectDO(state as unknown as DurableObjectState, env);
      wooObjects.set(name, object);
    }
    return object;
  });

  const commitNamespace = new FakeDurableObjectNamespace((name) => {
    let object = commitObjects.get(name);
    if (!object) {
      const state = commitStates.get(name) ?? new FakeDurableObjectState(name);
      commitStates.set(name, state);
      object = new CommitScopeDO(state as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-local-structural-secret" });
      commitObjects.set(name, object);
    }
    return object;
  });

  env = {
    WOO_INITIAL_WIZARD_TOKEN: "cf-local-structural-token",
    WOO_INTERNAL_SECRET: "cf-local-structural-secret",
    WOO_AUTO_INSTALL_CATALOGS: PROD_CATALOGS,
    WOO_MCP_GATEWAY_SHARDS: String(PROD_SHARDS),
    DIRECTORY: new FakeDurableObjectNamespace((name) => {
      if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
      return directory;
    }),
    WOO: wooNamespace,
    COMMIT_SCOPE: commitNamespace,
    HOST_SEED_KV: new FakeKVNamespace() as unknown as KVNamespace
  } as unknown as Env;

  return {
    env,
    request: async (path, init) => await worker.fetch(new Request(`https://woo.test${path}`, init), env, {}),
    setDirectoryLastSeenAt: (sessionIds, lastSeenAt) => {
      for (const sessionId of sessionIds) {
        directoryState.storage.sql.exec("UPDATE session_route SET last_seen_at = ? WHERE session_id = ?", lastSeenAt, sessionId);
      }
    },
    close: () => {
      directoryState.close();
      for (const state of wooStates.values()) state.close();
      for (const state of commitStates.values()) state.close();
    }
  };
}

async function seedDirectoryMcpAudience(
  harness: StructuralHarness,
  runId: string,
  options: { scope: ObjRef; sessions: number; uniqueShards: number }
): Promise<string[]> {
  const shardCount = Math.min(options.uniqueShards, PROD_SHARDS);
  const safeRunId = runId.replace(/[^A-Za-z0-9_]/g, "_");
  const sessionIds: string[] = [];
  for (let i = 0; i < options.sessions; i += 1) {
    const shardIndex = i % shardCount;
    const sessionId = sessionIdForShard(`stale-prod-${runId}-${i}`, shardIndex, PROD_SHARDS);
    sessionIds.push(sessionId);
    await registerDirectorySession(harness, {
      session_id: sessionId,
      actor: `guest_stale_prod_${safeRunId}_${i}`,
      started: Date.now() - 60_000,
      display_name: `stale-prod-${i}`,
      expires_at: Date.now() + 60 * 60_000,
      token_class: "guest",
      active_scope: options.scope,
      current_location: options.scope,
      mcp_shard: mcpShardHost(sessionId),
      focus_list: [options.scope]
    });
  }
  return sessionIds;
}

async function registerDirectorySession(harness: StructuralHarness, payload: Record<string, unknown>): Promise<void> {
  const request = await signInternalRequest(harness.env, new Request("https://woo.internal/register-session", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload)
  }));
  const response = await harness.env.DIRECTORY.get(harness.env.DIRECTORY.idFromName("directory")).fetch(request);
  expect(response.ok, await response.clone().text()).toBe(true);
}

async function openMcpSession(harness: StructuralHarness, token: string, runId: string): Promise<string> {
  const response = await mcpFetch(harness, {
    method: "POST",
    headers: { "mcp-token": token },
    body: rpc(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: `cf-local-structural/${runId}`, version: "0.0.0" }
    })
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  const sessionId = response.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  await parseMcpResponse(response);
  const initialized = await mcpFetch(harness, {
    method: "POST",
    headers: { "mcp-session-id": sessionId! },
    body: notification("notifications/initialized")
  });
  expect(initialized.status).toBe(202);
  return sessionId!;
}

async function callTool(
  harness: StructuralHarness,
  sessionId: string,
  id: number,
  name: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const response = await mcpFetch(harness, {
    method: "POST",
    headers: { "mcp-session-id": sessionId },
    body: rpc(id, "tools/call", { name, arguments: params })
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  const body = await parseMcpResponse(response);
  if (body?.result?.isError) throw new Error(`MCP tool error: ${JSON.stringify(body.result.structuredContent ?? body.result)}`);
  return body?.result?.structuredContent?.result;
}

async function mcpFetch(
  harness: StructuralHarness,
  input: { method: string; headers?: Record<string, string>; body?: unknown }
): Promise<Response> {
  const headers = new Headers({ accept: "application/json, text/event-stream", ...input.headers });
  let body: BodyInit | undefined;
  if (input.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(input.body);
  }
  return await harness.request("/mcp", { method: input.method, headers, body });
}

async function parseMcpResponse(response: Response): Promise<any> {
  if (response.status === 202 || response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const data = text.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice("data:".length).trim();
    return data ? JSON.parse(data) : null;
  }
  return JSON.parse(text);
}

function metricsFromLogSpy(logSpy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return logSpy.mock.calls
    .filter((c) => c[0] === "woo.metric" && typeof c[1] === "string")
    .map((c) => { try { return JSON.parse(c[1] as string) as Record<string, unknown>; } catch { return null; } })
    .filter((m): m is Record<string, unknown> => m !== null);
}

function maxMetric(metrics: Record<string, unknown>[], kind: string, field: string): number {
  return Math.max(0, ...metrics.filter((m) => m.kind === kind).map((m) => Number(m[field]) || 0));
}

function rpc(id: number, method: string, params?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

function notification(method: string, params?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
}

function sessionIdForShard(prefix: string, shardIndex: number, shards: number): string {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const candidate = `${prefix}-${attempt}`;
    if (mcpShardHost(candidate, shards) === `mcp-gateway-${shardIndex}`) return candidate;
  }
  throw new Error(`could not construct session id for mcp-gateway-${shardIndex}`);
}

function mcpShardHost(sessionId: string, shards = PROD_SHARDS): string {
  return `mcp-gateway-${stableHash(sessionId) % shards}`;
}

function stableHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function serializedObject(id: ObjRef, name: string, parent: ObjRef | null): SerializedObject {
  return {
    id,
    name,
    parent,
    owner: "$wiz",
    location: null,
    anchor: id,
    flags: {},
    created: 1,
    modified: 1,
    propertyDefs: [],
    properties: [],
    propertyVersions: [],
    verbs: [],
    children: [],
    contents: [],
    eventSchemas: []
  };
}

function emptySerializedWorld(): SerializedWorld {
  return {
    version: 1,
    objectCounter: 1,
    parkedTaskCounter: 1,
    sessionCounter: 1,
    objects: [],
    sessions: [],
    logs: [],
    snapshots: [],
    parkedTasks: [],
    tombstones: []
  };
}
