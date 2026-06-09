// B7 gateway install (notes/2026-06-09-b7-gateway-install.md).
//
// First-attempt authority on a warm MCP turn comes from the already-warm
// commit-scope relay cache instead of a per-turn authority-slice
// reconstruction, with reconstruction only for the residue the caches lack:
//
//   1. a warm same-scope turn's commit authority is served from the relay
//      (`cachedWarmCommitAuthority`) — the gateway's authorityPayload hook
//      (the reconstruction/fan-in entry point, and hence the cross-host
//      authority-slice RPC proxy in this in-process harness) is not called;
//   2. the movement owner-prefetch satisfies ids already owner-authoritative
//      in the planning relay (`warm_local`) or held owner-authoritatively by
//      another warm scope client on the same gateway (`warm_donor`,
//      process-local page copy), reconstructing only the residue;
//   3. a repair attempt (attempt > 0) NEVER serves warm/cached authority —
//      it reconstructs fresh, so multi-actor staleness converges in ≤ 2
//      attempts instead of looping cache → mismatch → cache;
//   4. the cold path is unchanged: a fresh scope still pays its first-open
//      seed through the hook.
import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import { executorAuthorityPayload } from "../src/core/executor";
import { planningCellKey } from "../src/core/planning-world";
import { encodeEnvelope, type ShadowEnvelope } from "../src/core/shadow-envelope";
import type { ShadowTurnExecReply } from "../src/core/shadow-turn-exec";
import type { AuthorityPageProvenance } from "../src/core/shadow-state-pages";
import type { MetricEvent, ObjRef } from "../src/core/types";
import { McpGateway, type McpV2EnvelopeBody, type McpV2EnvelopeResult } from "../src/mcp/gateway";
import { CommitScopeDO } from "../src/worker/commit-scope-do";
import { signInternalRequest } from "../src/worker/internal-auth";
import { FakeDurableObjectState } from "./worker/fake-do";

type AuthorityCall = {
  ids: ObjRef[];
  trigger?: string;
  reason?: string;
};

// Shared CommitScopeDO fixture: one DO per commit scope, shared across
// gateways so two gateway shards contend on the same authoritative head.
function commitScopeFixture(env: { WOO_INTERNAL_SECRET: string }) {
  const scopeStates = new Map<ObjRef, FakeDurableObjectState>();
  const scopes = new Map<ObjRef, CommitScopeDO>();
  const scopeFor = (commitScope: ObjRef): CommitScopeDO => {
    let scope = scopes.get(commitScope);
    if (!scope) {
      const state = new FakeDurableObjectState(commitScope);
      scopeStates.set(commitScope, state);
      scope = new CommitScopeDO(state as unknown as ConstructorParameters<typeof CommitScopeDO>[0], env);
      scopes.set(commitScope, scope);
    }
    return scope;
  };
  const close = (): void => {
    for (const state of scopeStates.values()) state.close();
  };
  return { scopeFor, close };
}

function warmGateway(
  world: ReturnType<typeof createWorld>,
  env: { WOO_INTERNAL_SECRET: string },
  scopeFor: (scope: ObjRef) => CommitScopeDO,
  authorityCalls: AuthorityCall[]
): McpGateway {
  return new McpGateway(world, {
    v2: {
      slimWarmEnvelope: true,
      authorityPayload: async (extraObjectIds, options) => {
        authorityCalls.push({
          ids: [...extraObjectIds],
          trigger: options?.reconstructionTrigger,
          reason: options?.reconstructionReason
        });
        return executorAuthorityPayload(world, extraObjectIds);
      },
      open: async (commitScope, body) => await postCommitScope(scopeFor(commitScope), env, commitScope, "/v2/open", body),
      envelope: async (commitScope, body) => await postCommitScope(scopeFor(commitScope), env, commitScope, "/v2/envelope", body)
    }
  });
}

describe("B7 MCP warm authority", () => {
  it("serves warm same-scope commit authority from the relay cache with no reconstruction; cold path still seeds", async () => {
    const world = createWorld();
    const env = { WOO_INTERNAL_SECRET: "v2-warm-secret" };
    const fixture = commitScopeFixture(env);
    const authorityCalls: AuthorityCall[] = [];
    const gateway = warmGateway(world, env, fixture.scopeFor, authorityCalls);
    try {
      const session = await initializeMcp(gateway, "guest:b7-warm-turn", 1);
      const actor = world.sessions.get(session)!.actor;

      // Cold first durable turn: the scope client must seed through the hook
      // (cold path unchanged — the relay cannot serve what it never fetched).
      const first = await mcp(gateway, session, 2, "tools/call", {
        name: "woo_focus",
        arguments: { target: "the_chatroom" }
      });
      expect(first.result.isError, JSON.stringify(first.result.structuredContent)).not.toBe(true);
      expect(authorityCalls.length).toBeGreaterThan(0);
      expect(authorityCalls.some((call) => call.trigger === "scope_seed" && call.reason === "cold_open")).toBe(true);

      // Warm second durable turn on the same scope: first-attempt authority is
      // the relay cache. Zero hook calls means zero reconstructions and zero
      // cross-host authority-slice round trips for the whole turn.
      authorityCalls.length = 0;
      const second = await mcp(gateway, session, 3, "tools/call", {
        name: "woo_focus",
        arguments: { target: "the_mug" }
      });
      expect(second.result.isError, JSON.stringify(second.result.structuredContent)).not.toBe(true);
      expect(world.getProp(actor, "focus_list")).toEqual(["the_chatroom", "the_mug"]);
      expect(authorityCalls, JSON.stringify(authorityCalls)).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it("owner-prefetch reconstructs only the residue and serves revisited rooms from warm relays", async () => {
    const world = createWorld({ catalogs: ["chat", "demoworld", "tasks", "blocks-demo"] });
    const metrics: MetricEvent[] = [];
    world.setMetricsHook((event) => metrics.push(event));
    const env = { WOO_INTERNAL_SECRET: "v2-warm-secret" };
    const fixture = commitScopeFixture(env);
    const authorityCalls: AuthorityCall[] = [];
    const gateway = warmGateway(world, env, fixture.scopeFor, authorityCalls);
    try {
      const session = await initializeMcp(gateway, "guest:b7-warm-prefetch", 1);
      await mcpOk(gateway, session, 2, "the_chatroom", "enter");

      // In this in-process harness the hook exports the whole world as
      // `authoritative`, so the chatroom seed already covers the one-hop
      // neighbor the_deck. Downgrade its tracked cells to `projection` — the
      // stamp a real sparse shard's topology pre-seed carries — so the
      // movement prefetch sees a non-authoritative destination.
      downgradeRelayProvenance(gateway, "the_chatroom", "the_deck", { source: "projection" });

      // First sighting of the_deck on the chatroom client with no warm owner
      // source anywhere on this gateway: the prefetch pays a residue
      // reconstruction for exactly [the_deck] — not the full prefetch set.
      authorityCalls.length = 0;
      await mcpOk(gateway, session, 3, "the_chatroom", "southeast");
      const residueFetch = authorityCalls.filter((call) => call.trigger === "owner_prefetch");
      expect(residueFetch, JSON.stringify(authorityCalls)).toHaveLength(1);
      expect(residueFetch[0].ids).toEqual(["the_deck"]);
      expect(residueFetch[0].reason).toBe("cold_open");
      const coldPrefetch = lastOwnerPrefetch(metrics);
      expect(coldPrefetch).toMatchObject({ scope: "the_chatroom", residue: 1 });

      // Touch the deck scope so its client exists WITHOUT marking the
      // movement prefetch ids (look declares no authority.prefetch).
      await mcpOk(gateway, session, 4, "the_deck", "look");

      // Moving back: the deck client's new prefetch id is [the_chatroom]
      // (the_deck itself was already marked at the deck client's init).
      // Downgrade the chatroom row in the DECK relay (again: the projection
      // stamp a sparse shard would hold) — the warm chatroom CLIENT then
      // donates its owner-authoritative pages for the_chatroom (warm_donor).
      // No reconstruction, no hook call.
      downgradeRelayProvenance(gateway, "the_deck", "the_chatroom", { source: "projection" });
      metrics.length = 0;
      authorityCalls.length = 0;
      await mcpOk(gateway, session, 5, "the_deck", "west");
      expect(world.activeScopeForSession(session)).toBe("the_chatroom");
      expect(authorityCalls.filter((call) => call.trigger === "owner_prefetch"), JSON.stringify(authorityCalls)).toEqual([]);
      const warmPrefetch = lastOwnerPrefetch(metrics);
      expect(warmPrefetch).toMatchObject({
        scope: "the_deck",
        warm_donor: 1,
        residue: 0
      });
    } finally {
      fixture.close();
    }
  });

  it("converges multi-actor same-scope contention in ≤2 attempts with correct final state", async () => {
    const metrics: MetricEvent[] = [];
    const world = createWorld({ metricsHook: (event) => metrics.push(event) });
    const env = { WOO_INTERNAL_SECRET: "v2-warm-secret" };
    const fixture = commitScopeFixture(env);
    const callsA: AuthorityCall[] = [];
    const callsB: AuthorityCall[] = [];
    // Two gateway shards over the SAME CommitScopeDOs: B's commit advances the
    // shared chatroom head without A's relay seeing the accepted frame, so A's
    // next turn submits a stale expected head. The authoritative CommitScopeDO
    // (or, when it must reject, the repair loop) is the backstop; the turn must
    // converge within two attempts and the committed state must be correct.
    const gatewayA = warmGateway(world, env, fixture.scopeFor, callsA);
    const gatewayB = warmGateway(world, env, fixture.scopeFor, callsB);
    try {
      const alice = await initializeMcp(gatewayA, "guest:b7-stale-alice", 1);
      const bob = await initializeMcp(gatewayB, "guest:b7-stale-bob", 10);
      const aliceActor = world.sessions.get(alice)!.actor;
      const bobActor = world.sessions.get(bob)!.actor;

      // A commits at the chatroom scope (seq 1) — A's relay tracks head 1.
      const a1 = await mcp(gatewayA, alice, 2, "tools/call", {
        name: "woo_focus",
        arguments: { target: "the_chatroom" }
      });
      expect(a1.result.isError, JSON.stringify(a1.result.structuredContent)).not.toBe(true);

      // B commits to the SAME scope through the other gateway (seq 2). A's
      // relay still believes head 1.
      const b1 = await mcp(gatewayB, bob, 11, "tools/call", {
        name: "woo_focus",
        arguments: { target: "the_chatroom" }
      });
      expect(b1.result.isError, JSON.stringify(b1.result.structuredContent)).not.toBe(true);

      // A's next warm turn submits expected@1 against actual head 2 and must
      // still converge in ≤ 2 attempts with both actors' writes intact.
      metrics.length = 0;
      const a2 = await mcp(gatewayA, alice, 3, "tools/call", {
        name: "woo_focus",
        arguments: { target: "the_mug" }
      });
      expect(a2.result.isError, JSON.stringify(a2.result.structuredContent)).not.toBe(true);
      expect(world.getProp(aliceActor, "focus_list")).toEqual(["the_chatroom", "the_mug"]);
      expect(world.getProp(bobActor, "focus_list")).toEqual(["the_chatroom"]);
      const timing = metrics.find((event): event is Extract<MetricEvent, { kind: "turn_phase_timing" }> =>
        event.kind === "turn_phase_timing" && event.verb === "focus" && event.outcome === "submitted");
      expect(timing, JSON.stringify(metrics.filter((m) => m.kind === "turn_phase_timing"))).toBeTruthy();
      expect(timing!.attempts).toBeLessThanOrEqual(2);
    } finally {
      fixture.close();
    }
  });

  it("never serves cached authority on a repair attempt — the retry reconstructs through the hook", async () => {
    const metrics: MetricEvent[] = [];
    const world = createWorld({ metricsHook: (event) => metrics.push(event) });
    const env = { WOO_INTERNAL_SECRET: "v2-warm-secret" };
    const fixture = commitScopeFixture(env);
    const authorityCalls: AuthorityCall[] = [];
    let envelopeCalls = 0;
    let failNextEnvelope = false;
    const gateway = new McpGateway(world, {
      v2: {
        slimWarmEnvelope: true,
        authorityPayload: async (extraObjectIds, options) => {
          authorityCalls.push({
            ids: [...extraObjectIds],
            trigger: options?.reconstructionTrigger,
            reason: options?.reconstructionReason
          });
          return executorAuthorityPayload(world, extraObjectIds);
        },
        open: async (commitScope, body) => await postCommitScope(fixture.scopeFor(commitScope), env, commitScope, "/v2/open", body),
        envelope: async (commitScope, body) => {
          envelopeCalls += 1;
          // Force one missing_state conflict on the marked turn's first
          // attempt — the deterministic stand-in for a commit-scope reject
          // that the warm cache cannot satisfy (the in-process CommitScopeDO
          // converges stale heads itself, so a real conflict never reaches
          // the gateway in this harness).
          if (failNextEnvelope) {
            failNextEnvelope = false;
            return { ok: true, reply: encodeEnvelope(replyEnvelope(missingStateReply("b7-forced-miss"))) };
          }
          return await postCommitScope<McpV2EnvelopeResult>(fixture.scopeFor(commitScope), env, commitScope, "/v2/envelope", body as McpV2EnvelopeBody);
        }
      }
    });
    try {
      const session = await initializeMcp(gateway, "guest:b7-repair-no-cache", 1);
      const actor = world.sessions.get(session)!.actor;

      // Warm the scope with a committed turn first.
      const first = await mcp(gateway, session, 2, "tools/call", {
        name: "woo_focus",
        arguments: { target: "the_chatroom" }
      });
      expect(first.result.isError, JSON.stringify(first.result.structuredContent)).not.toBe(true);

      // Warm turn whose first attempt is rejected: attempt 1 serves the warm
      // cache (zero hook calls); the repair attempt MUST reconstruct through
      // the hook (trigger turn_commit) instead of re-serving the cache that
      // just failed, and the turn converges on attempt 2.
      authorityCalls.length = 0;
      metrics.length = 0;
      failNextEnvelope = true;
      const second = await mcp(gateway, session, 3, "tools/call", {
        name: "woo_focus",
        arguments: { target: "the_mug" }
      });
      expect(second.result.isError, JSON.stringify(second.result.structuredContent)).not.toBe(true);
      expect(world.getProp(actor, "focus_list")).toEqual(["the_chatroom", "the_mug"]);
      const timing = metrics.find((event): event is Extract<MetricEvent, { kind: "turn_phase_timing" }> =>
        event.kind === "turn_phase_timing" && event.verb === "focus" && event.outcome === "submitted");
      expect(timing?.attempts).toBe(2);
      const commitFetches = authorityCalls.filter((call) => call.trigger === "turn_commit");
      expect(commitFetches, JSON.stringify(authorityCalls)).toHaveLength(1);
      expect(commitFetches[0].reason).toBe("warm_turn_refresh");
    } finally {
      fixture.close();
    }
  });
});

function missingStateReply(id: string): ShadowTurnExecReply {
  return {
    kind: "woo.turn.exec.reply.shadow.v1",
    ok: false,
    id,
    reason: "missing_state"
  };
}

function replyEnvelope(body: ShadowTurnExecReply): ShadowEnvelope<ShadowTurnExecReply> {
  return {
    v: 2,
    type: body.kind,
    id: `reply:${body.id ?? "unknown"}`,
    from: "commit-scope",
    to: "mcp-gateway",
    actor: "$actor",
    session: "session",
    auth: { mode: "session", token: "token" },
    body
  };
}

// Overwrite the recorded provenance of an object's tracked identity/live cells
// in one scope client's relay — the test stand-in for a sparse shard whose row
// came from a projection-stamped topology pre-seed rather than the owner.
function downgradeRelayProvenance(
  gateway: McpGateway,
  scope: ObjRef,
  object: ObjRef,
  provenance: AuthorityPageProvenance
): void {
  const scopes = (gateway as unknown as {
    v2Scopes: Map<ObjRef, { relay: { commit_scope: { cellProvenance?: Map<string, AuthorityPageProvenance> } } }>;
  }).v2Scopes;
  const client = scopes.get(scope);
  expect(client, `expected MCP v2 scope client for ${scope}`).toBeDefined();
  const cells = client!.relay.commit_scope.cellProvenance;
  expect(cells, `expected relay cell provenance for ${scope}`).toBeDefined();
  cells!.set(planningCellKey(object, "object_lineage"), { ...provenance });
  cells!.set(planningCellKey(object, "object_live"), { ...provenance });
}

function lastOwnerPrefetch(metrics: MetricEvent[]): Extract<MetricEvent, { kind: "mcp_owner_prefetch" }> | undefined {
  const all = metrics.filter((event): event is Extract<MetricEvent, { kind: "mcp_owner_prefetch" }> => event.kind === "mcp_owner_prefetch");
  return all[all.length - 1];
}

async function mcpOk(gateway: McpGateway, sessionId: string, id: number, object: ObjRef, verb: string): Promise<void> {
  const result = await mcp(gateway, sessionId, id, "tools/call", {
    name: "woo_call",
    arguments: { object, verb, args: [] }
  });
  expect(result.result.isError, `${object}:${verb} failed: ${JSON.stringify(result.result.structuredContent)}`).not.toBe(true);
}

async function initializeMcp(gateway: McpGateway, token: string, id: number): Promise<string> {
  const init = await gateway.handle(jsonRpcRequest({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "b7-warm-authority-test", version: "0.0.0" }
    }
  }, { "mcp-token": token }));
  expect(init.ok).toBe(true);
  const sessionId = init.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  const notified = await gateway.handle(jsonRpcRequest({
    jsonrpc: "2.0",
    method: "notifications/initialized"
  }, { "mcp-session-id": sessionId! }));
  expect(notified.status).toBe(202);
  return sessionId!;
}

async function mcp(gateway: McpGateway, sessionId: string, id: number, method: string, params?: unknown): Promise<any> {
  const response = await gateway.handle(jsonRpcRequest({
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params })
  }, { "mcp-session-id": sessionId }));
  expect(response.ok).toBe(true);
  return await response.json();
}

function jsonRpcRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://test.local/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });
}

async function postCommitScope<T>(
  scope: CommitScopeDO,
  env: { WOO_INTERNAL_SECRET: string },
  commitScope: ObjRef,
  path: "/v2/open" | "/v2/envelope",
  body: unknown
): Promise<T> {
  const request = await signInternalRequest(env, new Request(`https://woo.internal${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-woo-host-key": `commit-scope:${commitScope}`
    },
    body: JSON.stringify(body)
  }));
  const response = await scope.fetch(request);
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    const error = new Error(payload?.error?.message ?? `CommitScopeDO ${path} failed: ${response.status}`) as Error & { code?: string; value?: unknown };
    error.code = payload?.error?.code;
    error.value = payload;
    throw error;
  }
  return await response.json() as T;
}
