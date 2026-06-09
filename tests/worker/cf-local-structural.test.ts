import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
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
const WARM_TURN_FORBIDDEN_AUTHORITY_RECONSTRUCTION_REASONS = new Set(["warm_turn_refresh", "missing_state_repair"]);
const WARM_TURN_MAX_COMMIT_SCOPE_ENVELOPE_RPC_MS = 300;
const WARM_TURN_MAX_MCP_FANOUT_SHARDS = 1;
const WARM_TURN_MAX_MCP_SCOPED_SHARDS = 1;
const WARM_TURN_MAX_MCP_AFFECTED_SCOPES = 3;

type WarmTurnExpectation = {
  target: string;
  verb: string;
  expectedCount?: number;
  maxAuthorityCalls?: number;
  maxCommitScopeEnvelopeRpcMs?: number;
};

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
      writeLabeledMetricsIfRequested(runId, {
        one_turn_enter: metrics
      });

      expect(enterTurns.length, "the structural probe must exercise the real MCP turn path").toBeGreaterThan(0);
      expect(
        enterTurns.map((m) => ({ attempts: Number(m.attempts), authority_calls: Number(m.authority_calls) })),
        "one-turn smoke should converge without repair-round multiplication"
      ).toEqual([{ attempts: 1, authority_calls: 1 }]);
      expect(
        enterTurns.some((m) => m.ensure_detail_ms && typeof m.ensure_detail_ms === "object"),
        "enter turn should expose ensure subphase detail for prod smoke triage"
      ).toBe(true);
      expect(
        enterTurns.some((m) => m.submit_detail_ms && typeof m.submit_detail_ms === "object" && "worker.commit_scope_envelope_rpc" in m.submit_detail_ms),
        "enter turn should split submit into commit-scope RPC and post-accept delivery"
      ).toBe(true);
      expect(maxDirectorySessions, "stale Directory rows must not enter the presence authority payload").toBeLessThanOrEqual(2);
      expect(maxAudienceSessionShards, "stale sessions must not choose one MCP gateway shard each").toBeLessThanOrEqual(2);
      expect(maxFanoutShards, "commit fanout must stay proportional to live audience shards").toBeLessThanOrEqual(2);
      expect(mcpGatewayConstructors, "one live actor plus stale rows must not cold-start prod-scale gateway shards").toBeLessThanOrEqual(3);
      expect(commitFanoutGatewayTargets, "one enter must not fan out to many stale MCP gateway shards").toBeLessThanOrEqual(2);
      expect(hostSeedDoFetches, "one enter should not scatter host-seed cold loads").toBeLessThanOrEqual(3);
      expect(authorityReconstructions, "B7 warm-fill regressions show up as authority reconstruction fan-in").toBeLessThanOrEqual(5);
    } finally {
      if (sessionId) await mcpFetch(harness, { method: "DELETE", headers: { "mcp-session-id": sessionId } }).catch(() => undefined);
      logSpy.mockRestore();
      harness.close();
    }
  });

  it("gates measured warm deterministic movement and mounted-tool turns", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const harness = createStructuralHarness();
    const runId = `cf-local-warm-turn-${Date.now()}-${randomUUID().slice(0, 8)}`;
    let sessionId: string | null = null;
    try {
      sessionId = await openMcpSession(harness, `guest:cf-local-warm-turn-${runId}`, runId);

      await callTool(harness, sessionId, 3, "woo_call", { object: "the_chatroom", verb: "enter", args: [] });
      const setupMetrics = metricsFromLogSpy(logSpy);
      logSpy.mockClear();

      // Deliberate warm-up: exercise the same deterministic routes once before
      // measuring so cold opens, catalog install, and first seed fills remain
      // outside the zero-repair warm-turn gate.
      await callTool(harness, sessionId, 4, "woo_call", { object: "the_chatroom", verb: "southeast", args: [] });
      await callTool(harness, sessionId, 5, "woo_call", { object: "the_pinboard", verb: "enter", args: [] });
      await callTool(harness, sessionId, 6, "woo_call", { object: "the_pinboard", verb: "leave", args: [] });
      await callTool(harness, sessionId, 7, "woo_call", { object: "the_deck", verb: "west", args: [] });
      const warmupMetrics = metricsFromLogSpy(logSpy);
      logSpy.mockClear();

      await callTool(harness, sessionId, 8, "woo_call", { object: "the_chatroom", verb: "southeast", args: [] });
      await callTool(harness, sessionId, 9, "woo_call", { object: "the_pinboard", verb: "enter", args: [] });
      await callTool(harness, sessionId, 10, "woo_call", { object: "the_pinboard", verb: "leave", args: [] });
      await callTool(harness, sessionId, 11, "woo_call", { object: "the_deck", verb: "west", args: [] });
      const measuredMetrics = metricsFromLogSpy(logSpy);

      writeLabeledMetricsIfRequested(runId, {
        setup: setupMetrics,
        warmup: warmupMetrics,
        measured_warm: measuredMetrics
      });
      assertWarmTurnStructuralGate(measuredMetrics, [
        { target: "the_chatroom", verb: "southeast" },
        { target: "the_pinboard", verb: "enter" },
        { target: "the_pinboard", verb: "leave" },
        { target: "the_deck", verb: "west" }
      ]);
    } finally {
      if (sessionId) await mcpFetch(harness, { method: "DELETE", headers: { "mcp-session-id": sessionId } }).catch(() => undefined);
      logSpy.mockRestore();
      harness.close();
    }
  });

  it("reports warm-turn structural gate violations with actionable metric context", () => {
    const violations = warmTurnStructuralViolations([
      {
        kind: "turn_phase_timing",
        target: "the_chatroom",
        verb: "southeast",
        route: "direct",
        attempts: 2,
        authority_calls: 2,
        outcome: "submitted",
        submit_detail_ms: {
          "worker.commit_scope_envelope_rpc": 999
        }
      },
      {
        kind: "serialized_world_materialized",
        scope: "the_chatroom",
        seq: 3,
        reason: "mcp_turn_plan",
        ms: 1,
        objects: 99,
        sessions: 1,
        logs: 0
      },
      {
        kind: "turn_repair_attempt",
        target: "the_chatroom",
        verb: "southeast",
        source: "planning_throw",
        reason: "missing_state",
        attempt: 1,
        objects: ["the_deck"],
        atoms: ["read:cell:contents:the_deck"]
      },
      {
        kind: "authority_slice_reconstructed",
        reason: "warm_turn_refresh",
        scope: "the_chatroom",
        object_count: 12,
        page_count: 34,
        source_host: "the_deck"
      },
      {
        kind: "shadow_commit_rejected",
        scope: "the_chatroom",
        reason: "read_version_mismatch"
      },
      {
        kind: "mcp_fanout",
        scope: "the_chatroom",
        shards: 4,
        observations: 1,
        affected_scopes: 8,
        scoped_shards: 5,
        audience_session_shards: 4
      },
      {
        kind: "shadow_gateway_apply_step",
        scope: "the_chatroom",
        phase: "total",
        route: "fanout",
        ms: 2,
        objects: 80,
        creates: 0,
        writes: 2
      },
      {
        kind: "v2_envelope",
        status: "ok",
        scope: "the_chatroom"
      },
      {
        kind: "v2_envelope",
        status: "ok",
        scope: "the_chatroom"
      }
    ], [{ target: "the_chatroom", verb: "southeast" }]);

    expect(violations).toEqual(expect.arrayContaining([
      expect.stringContaining("turn_phase_timing the_chatroom:southeast attempts=2 authority_calls=2"),
      expect.stringContaining("commit_scope_envelope_rpc the_chatroom:southeast ms=999 max=300"),
      expect.stringContaining("serialized_world_materialized scope=the_chatroom reason=mcp_turn_plan"),
      expect.stringContaining("turn_repair_attempt the_chatroom:southeast source=planning_throw reason=missing_state attempt=1"),
      expect.stringContaining("authority_slice_reconstructed scope=the_chatroom reason=warm_turn_refresh"),
      expect.stringContaining("shadow_commit_rejected scope=the_chatroom reason=read_version_mismatch"),
      expect.stringContaining("mcp_fanout scope=the_chatroom shards=4 max_shards=1"),
      expect.stringContaining("shadow_gateway_apply_step scope=the_chatroom phase=total"),
      expect.stringContaining("v2_envelope accepted_count=2 expected_turns=1")
    ]));
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
    WOO_V2_SLIM_WARM_ENVELOPE: "1",
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

function assertWarmTurnStructuralGate(metrics: Record<string, unknown>[], expectedTurns: WarmTurnExpectation[]): void {
  const violations = warmTurnStructuralViolations(metrics, expectedTurns);
  expect(
    violations,
    `measured warm deterministic turns violated structural invariants:\n${violations.join("\n")}`
  ).toEqual([]);
}

function warmTurnStructuralViolations(metrics: Record<string, unknown>[], expectedTurns: WarmTurnExpectation[]): string[] {
  const violations: string[] = [];
  const expected = new Map(expectedTurns.map((turn) => [turnKey(turn), turn]));
  const phaseTimings = metrics.filter((m) => m.kind === "turn_phase_timing" && expected.has(metricTurnKey(m)));
  const phaseTimingsByTurn = groupByTurn(phaseTimings);
  for (const turn of expectedTurns) {
    const key = turnKey(turn);
    const timings = phaseTimingsByTurn.get(key) ?? [];
    const expectedCount = turn.expectedCount ?? 1;
    if (timings.length !== expectedCount) {
      violations.push(`turn_phase_timing ${key} count=${timings.length} expected=${expectedCount}`);
      continue;
    }
    for (const timing of timings) {
      const attempts = Number(timing.attempts);
      const authorityCalls = Number(timing.authority_calls);
      const maxAuthorityCalls = turn.maxAuthorityCalls ?? 1;
      if (attempts !== 1 || authorityCalls > maxAuthorityCalls) {
        violations.push(`turn_phase_timing ${key} attempts=${String(timing.attempts)} authority_calls=${String(timing.authority_calls)} max_authority_calls=${maxAuthorityCalls}`);
      }
      if (timing.outcome !== "submitted") {
        violations.push(`turn_phase_timing ${key} outcome=${String(timing.outcome)}`);
      }
      if (!hasSubmitDetail(timing, "worker.commit_scope_envelope_rpc")) {
        violations.push(`turn_phase_timing ${key} missing_submit_detail=worker.commit_scope_envelope_rpc`);
      } else {
        const commitScopeEnvelopeRpcMs = submitDetailNumber(timing, "worker.commit_scope_envelope_rpc");
        const maxCommitScopeEnvelopeRpcMs = turn.maxCommitScopeEnvelopeRpcMs ?? WARM_TURN_MAX_COMMIT_SCOPE_ENVELOPE_RPC_MS;
        if (commitScopeEnvelopeRpcMs > maxCommitScopeEnvelopeRpcMs) {
          violations.push(`commit_scope_envelope_rpc ${key} ms=${commitScopeEnvelopeRpcMs} max=${maxCommitScopeEnvelopeRpcMs}`);
        }
      }
    }
  }

  for (const metric of metrics) {
    const key = metricTurnKey(metric);
    if (metric.kind === "turn_repair_attempt" && expected.has(key)) {
      violations.push(
        `turn_repair_attempt ${key} source=${String(metric.source)} reason=${String(metric.reason)} attempt=${String(metric.attempt)} objects=${JSON.stringify(metric.objects ?? [])} atoms=${JSON.stringify(metric.atoms ?? [])}`
      );
    }
    if (metric.kind === "direct_call" && expected.has(key) && metric.status === "error") {
      violations.push(`direct_call ${key} status=error error=${String(metric.error ?? "")}`);
    }
  }

  for (const metric of metrics) {
    if (
      metric.kind === "authority_slice_reconstructed" &&
      WARM_TURN_FORBIDDEN_AUTHORITY_RECONSTRUCTION_REASONS.has(String(metric.reason))
    ) {
      violations.push(`authority_slice_reconstructed scope=${String(metric.scope)} reason=${String(metric.reason)} objects=${String(metric.object_count)} pages=${String(metric.page_count)} source_host=${String(metric.source_host ?? "")}`);
    }
    if (metric.kind === "shadow_commit_rejected") {
      violations.push(`shadow_commit_rejected scope=${String(metric.scope)} reason=${String(metric.reason)}`);
    }
    if (metric.kind === "serialized_world_materialized") {
      violations.push(`serialized_world_materialized scope=${String(metric.scope)} reason=${String(metric.reason)} objects=${String(metric.objects)} sessions=${String(metric.sessions)}`);
    }
    if (metric.kind === "shadow_gateway_apply_step") {
      violations.push(`shadow_gateway_apply_step scope=${String(metric.scope)} phase=${String(metric.phase)} objects=${String(metric.objects)} writes=${String(metric.writes)}`);
    }
    if (metric.kind === "mcp_fanout") {
      const shards = Number(metric.shards) || 0;
      const scopedShards = Number(metric.scoped_shards) || 0;
      const affectedScopes = Number(metric.affected_scopes) || 0;
      const audienceSessionShards = Number(metric.audience_session_shards) || 0;
      if (
        shards > WARM_TURN_MAX_MCP_FANOUT_SHARDS ||
        scopedShards > WARM_TURN_MAX_MCP_SCOPED_SHARDS ||
        affectedScopes > WARM_TURN_MAX_MCP_AFFECTED_SCOPES ||
        audienceSessionShards > WARM_TURN_MAX_MCP_FANOUT_SHARDS
      ) {
        violations.push(`mcp_fanout scope=${String(metric.scope)} shards=${shards} max_shards=${WARM_TURN_MAX_MCP_FANOUT_SHARDS} scoped_shards=${scopedShards} max_scoped_shards=${WARM_TURN_MAX_MCP_SCOPED_SHARDS} affected_scopes=${affectedScopes} max_affected_scopes=${WARM_TURN_MAX_MCP_AFFECTED_SCOPES} audience_session_shards=${audienceSessionShards}`);
      }
    }
  }

  const acceptedEnvelopes = metrics.filter((m) => m.kind === "v2_envelope" && m.status === "ok");
  if (acceptedEnvelopes.length !== phaseTimings.length) {
    violations.push(`v2_envelope accepted_count=${acceptedEnvelopes.length} expected_turns=${phaseTimings.length}`);
  }
  const mcpFanouts = metrics.filter((m) => m.kind === "mcp_fanout");
  if (mcpFanouts.length !== phaseTimings.length) {
    violations.push(`mcp_fanout count=${mcpFanouts.length} expected_turns=${phaseTimings.length}`);
  }
  return violations;
}

function groupByTurn(metrics: Record<string, unknown>[]): Map<string, Record<string, unknown>[]> {
  const out = new Map<string, Record<string, unknown>[]>();
  for (const metric of metrics) {
    const key = metricTurnKey(metric);
    const bucket = out.get(key) ?? [];
    bucket.push(metric);
    out.set(key, bucket);
  }
  return out;
}

function turnKey(turn: Pick<WarmTurnExpectation, "target" | "verb">): string {
  return `${turn.target}:${turn.verb}`;
}

function metricTurnKey(metric: Record<string, unknown>): string {
  return `${String(metric.target ?? "")}:${String(metric.verb ?? "")}`;
}

function hasSubmitDetail(metric: Record<string, unknown>, label: string): boolean {
  const detail = metric.submit_detail_ms;
  return typeof detail === "object" && detail !== null && label in detail;
}

function submitDetailNumber(metric: Record<string, unknown>, label: string): number {
  const detail = metric.submit_detail_ms;
  if (typeof detail !== "object" || detail === null) return 0;
  return Number((detail as Record<string, unknown>)[label]) || 0;
}

function writeLabeledMetricsIfRequested(
  runId: string,
  phases: Record<string, Record<string, unknown>[]>
): void {
  if (!process.env.WOO_CF_LOCAL_METRICS_OUT) return;
  const labeled = Object.entries(phases).flatMap(([phase, metrics]) =>
    metrics.map((metric) => ({ ...metric, cf_local_run: runId, cf_local_phase: phase }))
  );
  writeFileSync(process.env.WOO_CF_LOCAL_METRICS_OUT, `${JSON.stringify(labeled, null, 2)}\n`);
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
