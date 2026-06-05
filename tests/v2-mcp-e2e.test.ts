import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import { executorAuthorityPayload } from "../src/core/executor";
import { authoritySliceObjectIds, filterSerializedAuthoritySliceObjects, serializedWorldFromAuthoritySlice } from "../src/core/authority-slice";
import { serializedFor } from "../src/core/shadow-commit-scope";
import { decodeEnvelope, encodeEnvelope, type ShadowEnvelope } from "../src/core/shadow-envelope";
import { createShadowBrowserRelayShim, markShadowBrowserRelaySerializedChanged } from "../src/core/shadow-browser-node";
import type { ShadowTurnExecReply } from "../src/core/shadow-turn-exec";
import type { MetricEvent, ObjRef } from "../src/core/types";
import { McpGateway, type McpV2EnvelopeBody, type McpV2EnvelopeResult, type McpV2OpenBody } from "../src/mcp/gateway";
import { CommitScopeDO } from "../src/worker/commit-scope-do";
import { signInternalRequest } from "../src/worker/internal-auth";
import { FakeDurableObjectState } from "./worker/fake-do";

describe("v2 MCP e2e", () => {
  it("routes MCP live tool calls through CommitScopeDO and fans observations to MCP waiters", async () => {
    const world = createWorld();
    const env = { WOO_INTERNAL_SECRET: "v2-mcp-secret" };
    const scopeStates = new Map<ObjRef, FakeDurableObjectState>();
    const scopes = new Map<ObjRef, CommitScopeDO>();
    const stateFor = (commitScope: ObjRef): FakeDurableObjectState => {
      let state = scopeStates.get(commitScope);
      if (!state) {
        state = new FakeDurableObjectState(commitScope);
        scopeStates.set(commitScope, state);
      }
      return state;
    };
    const scopeFor = (commitScope: ObjRef): CommitScopeDO => {
      let scope = scopes.get(commitScope);
      if (!scope) {
        scope = new CommitScopeDO(stateFor(commitScope) as unknown as ConstructorParameters<typeof CommitScopeDO>[0], env);
        scopes.set(commitScope, scope);
      }
      return scope;
    };
    const gateway = new McpGateway(world, {
      v2: {
        open: async (commitScope, body) => await postCommitScope(scopeFor(commitScope), env, commitScope, "/v2/open", body),
        envelope: async (commitScope, body) => await postCommitScope(scopeFor(commitScope), env, commitScope, "/v2/envelope", body)
      }
    });

    try {
      const alice = await initializeMcp(gateway, "guest:v2-mcp-alice", 1);
      const bob = await initializeMcp(gateway, "guest:v2-mcp-bob", 10);

      const list = await mcp(gateway, bob, 11, "tools/list");
      const tools = (list.result as { tools: Array<{ name: string }> }).tools;
      expect(tools.some((tool) => tool.name === "woo_wait")).toBe(true);

      const said = await mcp(gateway, alice, 2, "tools/call", {
        name: "woo_call",
        arguments: { object: "the_chatroom", verb: "say", args: ["hello from v2 MCP"] }
      });
      expect(said.result.isError).not.toBe(true);
      expect(said.result.structuredContent.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "said", text: expect.stringContaining("hello from v2 MCP") })
      ]));

      const waited = await mcp(gateway, bob, 12, "tools/call", {
        name: "woo_wait",
        arguments: { timeout_ms: 0, limit: 10 }
      });
      expect(waited.result.isError).not.toBe(true);
      expect(waited.result.structuredContent.result.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "said", text: expect.stringContaining("hello from v2 MCP") })
      ]));

      const accepted = sqlRows<{ body: string }>(stateFor("the_chatroom").storage.sql.exec("SELECT body FROM v2_commit_scope_accepted_frame"));
      expect(accepted).toHaveLength(0);

      const aliceActor = world.sessions.get(alice)?.actor;
      const bobActor = world.sessions.get(bob)?.actor;
      expect(aliceActor).toBeTruthy();
      expect(bobActor).toBeTruthy();
      const nativeCalls = [
        { object: "the_chatroom", verb: "look", args: [] },
        { object: aliceActor!, verb: "who_all", args: [] },
        { object: aliceActor!, verb: "help", args: ["look"] },
        { object: aliceActor!, verb: "examine_detailed", args: ["the_chatroom"] },
        { object: aliceActor!, verb: "join_player", args: [world.object(bobActor!).name] }
      ];
      for (let i = 0; i < nativeCalls.length; i += 1) {
        const call = nativeCalls[i];
        const result = await mcp(gateway, alice, 30 + i, "tools/call", {
          name: "woo_call",
          arguments: call
        });
        expect(result.result.isError, `${call.object}:${call.verb} failed: ${JSON.stringify(result.result.structuredContent)}`).not.toBe(true);
      }

      const charlie = await initializeMcp(gateway, "guest:v2-mcp-charlie", 20);
      const entered = await mcp(gateway, charlie, 21, "tools/call", {
        name: "woo_call",
        arguments: { object: "the_chatroom", verb: "enter", args: [] }
      });
      expect(entered.result.isError).not.toBe(true);
      const charlieActor = world.sessions.get(charlie)?.actor;
      expect(charlieActor).toBeTruthy();
      const beforeWait = acceptedFramesForState(stateFor(charlieActor!)).length;

      await mcp(gateway, alice, 3, "tools/call", {
        name: "woo_wait",
        arguments: { timeout_ms: 0, limit: 10 }
      });
      const afterWait = acceptedFramesForState(stateFor(charlieActor!)).length;
      expect(afterWait).toBe(beforeWait);
    } finally {
      for (const state of scopeStates.values()) state.close();
    }
  });

  it("slimWarmEnvelope: same-scope warm turns omit the ~3MB authority slice and still converge", async () => {
    const metrics: MetricEvent[] = [];
    const world = createWorld({ metricsHook: (event) => metrics.push(event) });
    const env = { WOO_INTERNAL_SECRET: "v2-mcp-secret" };
    const scopeStates = new Map<ObjRef, FakeDurableObjectState>();
    const scopes = new Map<ObjRef, CommitScopeDO>();
    const commitPosts: Array<{ scope: ObjRef; path: "/v2/open" | "/v2/envelope"; body: Record<string, unknown> }> = [];
    const stateFor = (commitScope: ObjRef): FakeDurableObjectState => {
      let state = scopeStates.get(commitScope);
      if (!state) {
        state = new FakeDurableObjectState(commitScope);
        scopeStates.set(commitScope, state);
      }
      return state;
    };
    const scopeFor = (commitScope: ObjRef): CommitScopeDO => {
      let scope = scopes.get(commitScope);
      if (!scope) {
        scope = new CommitScopeDO(stateFor(commitScope) as unknown as ConstructorParameters<typeof CommitScopeDO>[0], env);
        scopes.set(commitScope, scope);
      }
      return scope;
    };
    const gateway = new McpGateway(world, {
      v2: {
        slimWarmEnvelope: true,
        authorityPayload: async (extraObjectIds) => {
          const payload = executorAuthorityPayload(world, extraObjectIds);
          return { ...payload, sessions: [], authority: { ...payload.authority, sessions: [] } };
        },
        open: async (commitScope, body) => {
          commitPosts.push({ scope: commitScope, path: "/v2/open", body: body as unknown as Record<string, unknown> });
          return await postCommitScope(scopeFor(commitScope), env, commitScope, "/v2/open", body);
        },
        envelope: async (commitScope, body) => {
          commitPosts.push({ scope: commitScope, path: "/v2/envelope", body: body as unknown as Record<string, unknown> });
          return await postCommitScope<McpV2EnvelopeResult>(scopeFor(commitScope), env, commitScope, "/v2/envelope", body);
        }
      }
    });

    try {
      const alice = await initializeMcp(gateway, "guest:v2-mcp-slim-alice", 1);
      const bob = await initializeMcp(gateway, "guest:v2-mcp-slim-bob", 10);
      const aliceActor = world.sessions.get(alice)?.actor;
      expect(aliceActor).toBeTruthy();

      // Two same-scope turns. The first opens + seeds the durable snapshot; the
      // second is a warm turn whose envelope must carry NO authority slice yet
      // still commit (the CommitScopeDO is authoritative for its own scope and
      // validates against its durable snapshot).
      const first = await mcp(gateway, alice, 2, "tools/call", {
        name: "woo_call",
        arguments: { object: "the_chatroom", verb: "say", args: ["slim one"] }
      });
      expect(first.result.isError, JSON.stringify(first.result.structuredContent)).not.toBe(true);
      const second = await mcp(gateway, alice, 3, "tools/call", {
        name: "woo_call",
        arguments: { object: "the_chatroom", verb: "say", args: ["slim two"] }
      });
      expect(second.result.isError, JSON.stringify(second.result.structuredContent)).not.toBe(true);
      // Second turn's observation reflects the committed state — proves the DO
      // converged on the slim path without the gateway pushing authority.
      expect(second.result.structuredContent.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "said", text: expect.stringContaining("slim two") })
      ]));

      // Peer fanout still works on the slim path: bob sees alice's say.
      const waited = await mcp(gateway, bob, 11, "tools/call", { name: "woo_wait", arguments: { timeout_ms: 1000 } });
      expect(JSON.stringify(waited.result.structuredContent)).toContain("slim two");

      // A scope's FIRST commit (head.seq 0) keeps the full slice to seed in one
      // round trip; warm repeats (head.seq >= 1) are slimmed. So at least one
      // envelope to a repeat-committed scope must carry no authority slice and
      // empty session_objects (while retaining the tiny session rows).
      const envelopes = commitPosts.filter((post) => post.path === "/v2/envelope");
      expect(envelopes.length).toBeGreaterThanOrEqual(2);
      const slimmed = envelopes.filter((post) => !Object.prototype.hasOwnProperty.call(post.body, "authority"));
      expect(
        slimmed.length,
        JSON.stringify(envelopes.map((post) => ({ scope: post.scope, hasAuthority: Object.prototype.hasOwnProperty.call(post.body, "authority") })))
      ).toBeGreaterThanOrEqual(1);
      for (const post of slimmed) {
        expect(post.body.session_objects ?? []).toEqual([]);
        expect(post.body).toHaveProperty("sessions");
      }
      // Convergence on the slim path is proven above: the second turn's
      // observation reflects committed state and bob (a peer) received it via the
      // DO's fanout — all without the gateway pushing the authority slice. (`say`
      // is a live verb, so there is no durable accepted frame to count; the
      // companion cold-reseed test below exercises the durable commit retry.)
    } finally {
      for (const state of scopeStates.values()) state.close();
    }
  });

  it("opens cross-scope planned-transcript commit scopes before building the envelope when capsule open is enabled", async () => {
    const metrics: MetricEvent[] = [];
    const world = createWorld({ metricsHook: (event) => metrics.push(event) });
    const env = { WOO_INTERNAL_SECRET: "v2-mcp-secret" };
    const scopeStates = new Map<ObjRef, FakeDurableObjectState>();
    const scopes = new Map<ObjRef, CommitScopeDO>();
    const commitPosts: Array<{ scope: ObjRef; path: "/v2/open" | "/v2/envelope"; body: Record<string, unknown> }> = [];
    const commitReplies: ShadowTurnExecReply[] = [];
    const stateFor = (commitScope: ObjRef): FakeDurableObjectState => {
      let state = scopeStates.get(commitScope);
      if (!state) {
        state = new FakeDurableObjectState(commitScope);
        scopeStates.set(commitScope, state);
      }
      return state;
    };
    const scopeFor = (commitScope: ObjRef): CommitScopeDO => {
      let scope = scopes.get(commitScope);
      if (!scope) {
        scope = new CommitScopeDO(stateFor(commitScope) as unknown as ConstructorParameters<typeof CommitScopeDO>[0], env);
        scopes.set(commitScope, scope);
      }
      return scope;
    };
    const gateway = (): McpGateway => new McpGateway(world, {
      v2: {
        executionCapsuleOpen: true,
        authorityPayload: async (extraObjectIds) => {
          const payload = executorAuthorityPayload(world, extraObjectIds);
          // Sparse MCP gateway shards can reconstruct object authority without
          // carrying the just-bound session row. The gateway must splice its
          // authenticated MCP session back into the commit-scope open/envelope
          // payload so CommitScopeDO can derive browser-session claims.
          return {
            ...payload,
            sessions: [],
            authority: { ...payload.authority, sessions: [] }
          };
        },
        open: async (commitScope, body) => {
          commitPosts.push({ scope: commitScope, path: "/v2/open", body: body as unknown as Record<string, unknown> });
          return await postCommitScope(scopeFor(commitScope), env, commitScope, "/v2/open", body);
        },
        envelope: async (commitScope, body) => {
          commitPosts.push({ scope: commitScope, path: "/v2/envelope", body: body as unknown as Record<string, unknown> });
          const result = await postCommitScope<McpV2EnvelopeResult>(scopeFor(commitScope), env, commitScope, "/v2/envelope", body);
          if (result.reply) commitReplies.push(decodeEnvelope(result.reply).body as ShadowTurnExecReply);
          return result;
        }
      }
    });

    try {
      const firstGateway = gateway();
      const firstSession = await initializeMcp(firstGateway, "guest:v2-mcp-recycled-head-a", 1);
      const firstActor = world.sessions.get(firstSession)?.actor;
      expect(firstActor).toBeTruthy();
      const firstEnter = await mcp(firstGateway, firstSession, 2, "tools/call", {
        name: "woo_call",
        arguments: { object: "the_chatroom", verb: "enter", args: [] }
      });
      expect(firstEnter.result.isError, JSON.stringify(firstEnter.result.structuredContent)).not.toBe(true);
      expect(acceptedFramesForState(stateFor(firstActor!))).toHaveLength(1);

      world.endSession(firstSession);
      commitPosts.length = 0;

      const secondGateway = gateway();
      const secondSession = await initializeMcp(secondGateway, "guest:v2-mcp-recycled-head-b", 3);
      const secondActor = world.sessions.get(secondSession)?.actor;
      expect(secondActor).toBe(firstActor);
      const secondEnter = await mcp(secondGateway, secondSession, 4, "tools/call", {
        name: "woo_call",
        arguments: { object: "the_chatroom", verb: "enter", args: [] }
      });
      expect(secondEnter.result.isError, JSON.stringify(secondEnter.result.structuredContent)).not.toBe(true);
      const acceptedReply = commitReplies.find((reply) =>
        reply.ok === true &&
        reply.commit?.position.scope === secondActor &&
        reply.transcript.call.verb === "enter"
      );
      expect(acceptedReply?.state_transfer).toMatchObject({
        kind: "woo.state.transfer.shadow.v1",
        mode: "cell_pages",
        purpose: "accepted_write_cells"
      });

      const actorPosts = commitPosts.filter((post) => post.scope === secondActor);
      const actorOpenIndex = actorPosts.findIndex((post) => post.path === "/v2/open");
      const actorEnvelopeIndex = actorPosts.findIndex((post) => post.path === "/v2/envelope");
      expect(actorOpenIndex, JSON.stringify(actorPosts.map((post) => post.path))).toBeGreaterThanOrEqual(0);
      expect(actorEnvelopeIndex, JSON.stringify(actorPosts.map((post) => post.path))).toBeGreaterThan(actorOpenIndex);
      const openBody = actorPosts[actorOpenIndex].body;
      expect(openBody).toMatchObject({ open_protocol: "head_session.v1" });
      expect(openBody).not.toHaveProperty("authority");
      expect(openBody).not.toHaveProperty("serialized");
      expect(openBody.sessions).toEqual(expect.arrayContaining([expect.objectContaining({ id: secondSession, actor: secondActor })]));
      const envelopeBody = actorPosts[actorEnvelopeIndex].body;
      const envelopeSessions = envelopeBody.sessions as Array<{ id?: string; actor?: string }>;
      const authoritySessions = (envelopeBody.authority as { sessions?: Array<{ id?: string; actor?: string }> }).sessions ?? [];
      expect(envelopeSessions).toEqual(expect.arrayContaining([expect.objectContaining({ id: secondSession, actor: secondActor })]));
      expect(authoritySessions).toEqual(expect.arrayContaining([expect.objectContaining({ id: secondSession, actor: secondActor })]));
      const envelope = decodeEnvelope(String(actorPosts[actorEnvelopeIndex].body.envelope));
      const expected = (envelope.body as { expected?: { seq?: unknown } }).expected;
      expect(expected?.seq).toBe(1);
      expect(actorPosts[actorEnvelopeIndex].body).toHaveProperty("planned_transcript_commit", true);
      expect(actorPosts[actorEnvelopeIndex].body).not.toHaveProperty("execution_capsule");
      const enterTimings = metrics.filter((event): event is Extract<MetricEvent, { kind: "turn_phase_timing" }> =>
        event.kind === "turn_phase_timing" &&
        event.commit_scope === secondActor &&
        event.target === "the_chatroom" &&
        event.verb === "enter"
      );
      const secondEnterTiming = enterTimings[enterTimings.length - 1];
      expect(secondEnterTiming?.ensure_detail_ms).toMatchObject({ "commit.session_open_cached": 0 });
      expect(metrics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "mcp_relocation_prewarm",
          scope: "the_chatroom",
          commit_scope: secondActor,
          target: "the_chatroom",
          verb: "enter",
          status: "ok"
        })
      ]));
    } finally {
      for (const state of scopeStates.values()) state.close();
    }
  });

  it("repairs stale relay lineage before MCP local planning", async () => {
    const world = createWorld({ catalogs: ["chat", "demoworld", "tasks", "blocks-demo"] });
    const env = { WOO_INTERNAL_SECRET: "v2-mcp-secret" };
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
    const authorityCalls: Array<{ snapshot: boolean; tolerate: boolean }> = [];
    const gateway = new McpGateway(world, {
      v2: {
        open: async (commitScope, body) => await postCommitScope(scopeFor(commitScope), env, commitScope, "/v2/open", body),
        authorityPayload: async (extraObjectIds, options) => {
          authorityCalls.push({
            snapshot: options?.useCommitScopeSnapshotForRemoteAuthority === true,
            tolerate: options?.tolerateRemoteFailures === true
          });
          return executorAuthorityPayload(world, extraObjectIds);
        },
        envelope: async (commitScope, body) => await postCommitScope(scopeFor(commitScope), env, commitScope, "/v2/envelope", body)
      }
    });

    try {
      const session = await initializeMcp(gateway, "guest:v2-mcp-preplan-lineage", 1);
      const entered = await mcp(gateway, session, 2, "tools/call", {
        name: "woo_call",
        arguments: { object: "the_chatroom", verb: "enter", args: [] }
      });
      expect(entered.result.isError, JSON.stringify(entered.result.structuredContent)).not.toBe(true);

      removeObjectsFromMcpScope(gateway, "the_chatroom", ["$chatroom", "$space"]);
      authorityCalls.length = 0;

      const looked = await mcp(gateway, session, 3, "tools/call", {
        name: "woo_call",
        arguments: { object: "the_chatroom", verb: "look", args: [] }
      });

      expect(looked.result.isError, JSON.stringify(looked.result.structuredContent)).not.toBe(true);
      expect(authorityCalls[0]).toEqual({ snapshot: false, tolerate: true });
      expect(mcpScopeObjectIds(gateway, "the_chatroom")).toEqual(expect.arrayContaining(["$chatroom", "$space"]));
    } finally {
      for (const state of scopeStates.values()) state.close();
    }
  });

  it("repairs stale relay transitive refs before MCP movement planning", async () => {
    const world = createWorld({ catalogs: ["chat", "demoworld", "tasks", "blocks-demo"] });
    const env = { WOO_INTERNAL_SECRET: "v2-mcp-secret" };
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
    const authorityRequests: ObjRef[][] = [];
    const gardenClosure = new Set<ObjRef>(["the_garden", "exit_garden_north", "exit_garden_south"]);
    const gateway = new McpGateway(world, {
      v2: {
        open: async (commitScope, body) => await postCommitScope(scopeFor(commitScope), env, commitScope, "/v2/open", body),
        authorityPayload: async (extraObjectIds) => {
          authorityRequests.push([...extraObjectIds]);
          const payload = executorAuthorityPayload(world, extraObjectIds);
          // Prod owner slices are partitioned: asking for `the_deck` brings the
          // exit whose `dest` names `the_garden`, but not the destination room's
          // authority rows. The second attempt must request the missing room id
          // explicitly before the owner can return its closure.
          if (extraObjectIds.includes("the_garden")) return payload;
          return {
            ...payload,
            authority: filterSerializedAuthoritySliceObjects(payload.authority, (id) => !gardenClosure.has(id))
          };
        },
        envelope: async (commitScope, body) => await postCommitScope(scopeFor(commitScope), env, commitScope, "/v2/envelope", body)
      }
    });

    try {
      const session = await initializeMcp(gateway, "guest:v2-mcp-preplan-garden", 1);
      for (const [id, object, verb] of [
        [2, "the_chatroom", "enter"],
        [3, "the_chatroom", "southeast"]
      ] as const) {
        const result = await mcp(gateway, session, id, "tools/call", {
          name: "woo_call",
          arguments: { object, verb, args: [] }
        });
        expect(result.result.isError, `${object}:${verb} failed: ${JSON.stringify(result.result.structuredContent)}`).not.toBe(true);
      }
      const look = await mcp(gateway, session, 4, "tools/call", {
        name: "woo_call",
        arguments: { object: "the_deck", verb: "look", args: [] }
      });
      expect(look.result.isError, JSON.stringify(look.result.structuredContent)).not.toBe(true);

      removeObjectsFromMcpScope(gateway, "the_deck", ["the_garden"]);

      const south = await mcp(gateway, session, 5, "tools/call", {
        name: "woo_call",
        arguments: { object: "the_deck", verb: "south", args: [] }
      });

      expect(south.result.isError, JSON.stringify(south.result.structuredContent)).not.toBe(true);
      expect(authorityRequests.some((ids) => ids.includes("the_garden"))).toBe(true);
      expect(world.activeScopeForSession(session)).toBe("the_garden");
      expect(mcpScopeObjectIds(gateway, "the_deck")).toContain("the_garden");
    } finally {
      for (const state of scopeStates.values()) state.close();
    }
  });

  it("uses snapshot authority only for the first MCP envelope attempt", async () => {
    const world = createWorld();
    const env = { WOO_INTERNAL_SECRET: "v2-mcp-secret" };
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
    const authoritySnapshotFlags: boolean[] = [];
    let envelopeCalls = 0;
    const gateway = new McpGateway(world, {
      v2: {
        open: async (commitScope, body) => await postCommitScope(scopeFor(commitScope), env, commitScope, "/v2/open", body),
        authorityPayload: async (extraObjectIds, options) => {
          authoritySnapshotFlags.push(options?.useCommitScopeSnapshotForRemoteAuthority === true);
          return executorAuthorityPayload(world, extraObjectIds);
        },
        envelope: async (commitScope, body) => {
          envelopeCalls += 1;
          if (envelopeCalls === 1) {
            return { ok: true, reply: encodeEnvelope(replyEnvelope(missingStateReply("mcp-snapshot-retry"))) };
          }
          return await postCommitScope(scopeFor(commitScope), env, commitScope, "/v2/envelope", body);
        }
      }
    });

    try {
      const session = await initializeMcp(gateway, "guest:v2-mcp-authority-snapshot", 1);
      const result = await mcp(gateway, session, 4, "tools/call", {
        name: "woo_call",
        arguments: { object: "the_chatroom", verb: "enter", args: [] }
      });

      expect(result.result.isError, JSON.stringify(result.result.structuredContent)).not.toBe(true);
      expect(envelopeCalls).toBe(2);
      // B7 warm-cache-first MCP planning no longer pays the two unconditional
      // pre-plan authority refreshes. The first commit refresh may use the
      // CommitScopeDO snapshot fallback; the repair attempt must not reuse it.
      expect(authoritySnapshotFlags).toEqual([false, false, true, false]);
    } finally {
      for (const state of scopeStates.values()) state.close();
    }
  });

  it("carries relay snapshot rows when snapshot-fallback authority is sparse", async () => {
    const world = createWorld({ catalogs: ["chat", "demoworld", "tasks", "blocks-demo"] });
    const scopeStates = new Map<string, FakeDurableObjectState>();
    const env = { WOO_INTERNAL_SECRET: "v2-mcp-secret" };
    const scopes = new Map<string, CommitScopeDO>();
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
    const envelopeAuthorityIds: ObjRef[][] = [];
    const gateway = new McpGateway(world, {
      v2: {
        open: async (commitScope, body) => await postCommitScope(scopeFor(commitScope), env, commitScope, "/v2/open", body),
        authorityPayload: async (extraObjectIds, options) => {
          const payload = executorAuthorityPayload(world, extraObjectIds);
          if (options?.useCommitScopeSnapshotForRemoteAuthority !== true) return payload;
          return {
            ...payload,
            authority: filterSerializedAuthoritySliceObjects(payload.authority, (id) => id !== "the_garden"),
            staleFallbackCount: 1
          };
        },
        envelope: async (commitScope, body) => {
          if (commitScope === "the_deck") envelopeAuthorityIds.push(Array.from(authoritySliceObjectIds(body.authority!)));
          return await postCommitScope(scopeFor(commitScope), env, commitScope, "/v2/envelope", body);
        }
      }
    });

    try {
      const session = await initializeMcp(gateway, "guest:v2-mcp-relay-stale-fallback", 1);
      await mcp(gateway, session, 2, "tools/call", {
        name: "woo_call",
        arguments: { object: "the_chatroom", verb: "enter", args: [] }
      });
      await mcp(gateway, session, 3, "tools/call", {
        name: "woo_call",
        arguments: { object: "the_chatroom", verb: "southeast", args: [] }
      });
      const result = await mcp(gateway, session, 4, "tools/call", {
        name: "woo_call",
        arguments: { object: "the_deck", verb: "look", args: [] }
      });

      expect(result.result.isError, JSON.stringify(result.result.structuredContent)).not.toBe(true);
      expect(envelopeAuthorityIds[0]).toContain("the_garden");
    } finally {
      for (const state of scopeStates.values()) state.close();
    }
  });

  it("skips the relay snapshot merge when authority did not degrade", () => {
    const world = createWorld({ catalogs: ["chat", "demoworld", "tasks", "blocks-demo"] });
    const session = world.auth("guest:v2-mcp-no-stale-fallback");
    const relaySeed = executorAuthorityPayload(world, ["the_deck", session.actor]);
    const freshPayload = executorAuthorityPayload(world, ["the_chatroom", session.actor]);
    expect(authoritySliceObjectIds(relaySeed.authority).has("the_garden")).toBe(true);
    expect(authoritySliceObjectIds(freshPayload.authority).has("the_garden")).toBe(false);

    const gateway = new McpGateway(world);
    const client = {
      scope: "the_deck",
      relay: createShadowBrowserRelayShim({
        node: "mcp-v2-relay:test",
        scope: "the_deck",
        serialized: serializedWorldFromAuthoritySlice(relaySeed.authority)
      }),
      commitScopeOpenedSessions: new Set<string>(),
      openedSessions: new Set<string>(),
      openingSessions: new Map<string, Promise<void>>()
    };
    const helper = gateway as unknown as {
      withRelaySnapshotAuthorityFallback(
        client: unknown,
        payload: typeof freshPayload
      ): typeof freshPayload;
    };

    const warm = helper.withRelaySnapshotAuthorityFallback(client, freshPayload);
    expect(authoritySliceObjectIds(warm.authority).has("the_garden")).toBe(false);

    const degraded = helper.withRelaySnapshotAuthorityFallback(client, {
      ...freshPayload,
      staleFallbackCount: 1
    });
    expect(authoritySliceObjectIds(degraded.authority).has("the_garden")).toBe(true);
  });

  it("keeps MCP session authority coherent after cross-scope room moves", async () => {
    const world = createWorld();
    const scopeStates = new Map<string, FakeDurableObjectState>();
    const env = { WOO_INTERNAL_SECRET: "v2-mcp-secret" };
    const scopes = new Map<string, CommitScopeDO>();
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
    const gateway = new McpGateway(world, {
      v2: {
        open: async (commitScope, body) => await postCommitScope(scopeFor(commitScope), env, commitScope, "/v2/open", body),
        envelope: async (commitScope, body) => await postCommitScope(scopeFor(commitScope), env, commitScope, "/v2/envelope", body)
      }
    });

    try {
      const alice = await initializeMcp(gateway, "guest:v2-mcp-cross-scope", 1);
      const aliceActor = world.sessions.get(alice)!.actor;
      const move = await mcp(gateway, alice, 3, "tools/call", {
        name: "woo_call",
        arguments: { object: "the_chatroom", verb: "southeast", args: [] }
      });
      expect(move.result.isError).not.toBe(true);
      expect(world.activeScopeForSession(alice)).toBe("the_deck");

      const look = await mcp(gateway, alice, 4, "tools/call", {
        name: "woo_call",
        arguments: { object: "the_deck", verb: "look", args: [] }
      });
      expect(look.result.isError, JSON.stringify(look.result.structuredContent)).not.toBe(true);
      expect(world.object(world.sessions.get(alice)!.actor).location).toBe("the_deck");

      const back = await mcp(gateway, alice, 5, "tools/call", {
        name: "woo_call",
        arguments: { object: "the_deck", verb: "west", args: [] }
      });
      expect(back.result.isError, JSON.stringify(back.result.structuredContent)).not.toBe(true);
      expect(world.activeScopeForSession(alice)).toBe("the_chatroom");
      expect(world.object(world.sessions.get(alice)!.actor).location).toBe("the_chatroom");

      // Regression for production drift: the chatroom CommitScopeDO already
      // had a durable snapshot from the first move, where the actor had left.
      // The deck CommitScopeDO accepted the return move, so the next chatroom
      // call must refresh enough session/room authority to plan against the
      // actor's actual current room instead of the stale chatroom snapshot.
      const ways = await mcp(gateway, alice, 6, "tools/call", {
        name: "woo_call",
        arguments: { object: aliceActor, verb: "ways", args: [] }
      });
      expect(ways.result.isError, JSON.stringify(ways.result.structuredContent)).not.toBe(true);
    } finally {
      for (const state of scopeStates.values()) state.close();
    }
  });

  it("carries actor inventory across scopes so drop succeeds in the new room", async () => {
    // Production walkthrough surfaced this companion to the cross-scope move
    // bug: take an item in chatroom, southeast to deck, then drop. Inventory
    // verbs read `actor.contents` (which the slice already refreshes), but
    // drop calls `location(item) == actor` — the item's `location` field must
    // also be authoritative on the destination scope, or drop raises E_INVARG
    // even though the actor visibly carries the item. Authority slice must
    // include each item the actor holds.
    const world = createWorld();
    const scopeStates = new Map<string, FakeDurableObjectState>();
    const env = { WOO_INTERNAL_SECRET: "v2-mcp-secret" };
    const scopes = new Map<string, CommitScopeDO>();
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
    const gateway = new McpGateway(world, {
      v2: {
        open: async (commitScope, body) => await postCommitScope(scopeFor(commitScope), env, commitScope, "/v2/open", body),
        envelope: async (commitScope, body) => await postCommitScope(scopeFor(commitScope), env, commitScope, "/v2/envelope", body)
      }
    });

    try {
      const alice = await initializeMcp(gateway, "guest:v2-mcp-cross-scope-inventory", 1);
      const aliceActor = world.sessions.get(alice)!.actor;
      const take = await mcp(gateway, alice, 2, "tools/call", {
        name: "woo_call",
        arguments: { object: "the_chatroom", verb: "take", args: ["the_mug"] }
      });
      expect(take.result.isError, JSON.stringify(take.result.structuredContent)).not.toBe(true);
      expect(world.object("the_mug").location).toBe(aliceActor);

      const move = await mcp(gateway, alice, 3, "tools/call", {
        name: "woo_call",
        arguments: { object: "the_chatroom", verb: "southeast", args: [] }
      });
      expect(move.result.isError, JSON.stringify(move.result.structuredContent)).not.toBe(true);

      const drop = await mcp(gateway, alice, 4, "tools/call", {
        name: "woo_call",
        arguments: { object: "the_deck", verb: "drop", args: ["the_mug"] }
      });
      expect(drop.result.isError, JSON.stringify(drop.result.structuredContent)).not.toBe(true);
      expect(world.object("the_mug").location).toBe("the_deck");
    } finally {
      for (const state of scopeStates.values()) state.close();
    }
  });

  it("commits woo_focus through the v2 authority instead of mutating only the gateway", async () => {
    const world = createWorld();
    const scopeState = new FakeDurableObjectState("the_chatroom");
    const env = { WOO_INTERNAL_SECRET: "v2-mcp-secret" };
    const scope = new CommitScopeDO(scopeState as unknown as ConstructorParameters<typeof CommitScopeDO>[0], env);
    const gateway = new McpGateway(world, {
      v2: {
        open: async (commitScope, body) => await postCommitScope(scope, env, commitScope, "/v2/open", body),
        envelope: async (commitScope, body) => await postCommitScope(scope, env, commitScope, "/v2/envelope", body)
      }
    });

    try {
      const session = await initializeMcp(gateway, "guest:v2-mcp-focus-authority", 1);
      const actor = world.sessions.get(session)!.actor;
      const focused = await mcp(gateway, session, 2, "tools/call", {
        name: "woo_focus",
        arguments: { target: "the_chatroom" }
      });

      expect(focused.result.isError, JSON.stringify(focused.result.structuredContent)).not.toBe(true);
      expect(world.getProp(actor, "focus_list")).toEqual(["the_chatroom"]);
      const accepted = sqlRows<{ body: string }>(scopeState.storage.sql.exec("SELECT body FROM v2_commit_scope_accepted_frame ORDER BY seq"));
      expect(accepted).toHaveLength(1);
      expect(JSON.parse(accepted[0].body)).toMatchObject({
        kind: "woo.commit.accepted.shadow.v1",
        position: { scope: "the_chatroom", seq: 1 }
      });
      const transcriptRows = sqlRows<{ body: string }>(scopeState.storage.sql.exec("SELECT body FROM v2_commit_scope_transcript_tail ORDER BY seq"));
      expect(transcriptRows).toHaveLength(1);
      expect(JSON.parse(transcriptRows[0].body)).toMatchObject({
        call: { actor, target: actor, verb: "focus", args: ["the_chatroom"] },
        writes: [expect.objectContaining({ cell: { kind: "prop", object: actor, name: "focus_list" }, value: ["the_chatroom"] })]
      });
    } finally {
      scopeState.close();
    }
  });

  it("serializes concurrent MCP v2 intents without stale-head rejects", async () => {
    const world = createWorld();
    const env = { WOO_INTERNAL_SECRET: "v2-mcp-secret" };
    const scopeStates = new Map<ObjRef, FakeDurableObjectState>();
    const scopes = new Map<ObjRef, CommitScopeDO>();
    const stateFor = (commitScope: ObjRef): FakeDurableObjectState => {
      let state = scopeStates.get(commitScope);
      if (!state) {
        state = new FakeDurableObjectState(commitScope);
        scopeStates.set(commitScope, state);
      }
      return state;
    };
    const scopeFor = (commitScope: ObjRef): CommitScopeDO => {
      let scope = scopes.get(commitScope);
      if (!scope) {
        scope = new CommitScopeDO(stateFor(commitScope) as unknown as ConstructorParameters<typeof CommitScopeDO>[0], env);
        scopes.set(commitScope, scope);
      }
      return scope;
    };
    const concurrentCalls = 4;
    const openBodies: McpV2OpenBody[] = [];
    const pendingEnvelopes: Array<() => void> = [];
    const releaseEnvelopeBatch = (): void => {
      const releases = pendingEnvelopes.splice(0);
      for (const release of releases) release();
    };
    const gateway = new McpGateway(world, {
      v2: {
        open: async (commitScope, body) => {
          openBodies.push(body);
          return await postCommitScope(scopeFor(commitScope), env, commitScope, "/v2/open", body);
        },
        envelope: async (commitScope, body) => {
          // Hold the first batch until every caller has locally reached the
          // commit boundary. Exec envelopes planned at the gateway race here
          // and stale-head reject; intent envelopes let CommitScopeDO plan in
          // arrival order and accept each turn.
          if (pendingEnvelopes.length < concurrentCalls) {
            await new Promise<void>((resolve) => {
              pendingEnvelopes.push(resolve);
              if (pendingEnvelopes.length === concurrentCalls) releaseEnvelopeBatch();
            });
          }
          return await postCommitScope(scopeFor(commitScope), env, commitScope, "/v2/envelope", body);
        }
      }
    });

    try {
      const sessions = await Promise.all(Array.from({ length: concurrentCalls }, async (_, index) =>
        await initializeMcp(gateway, `guest:v2-mcp-concurrent-${index}`, 100 + index)
      ));
      const results = await Promise.all(sessions.map(async (session, index) =>
        await mcp(gateway, session, 200 + index, "tools/call", {
          name: "woo_call",
          arguments: { object: "the_chatroom", verb: "enter", args: [] }
        })
      ));

      for (const [index, result] of results.entries()) {
        expect(
          result.result.isError,
          `call ${index} failed: ${JSON.stringify(result.result.structuredContent)}`
        ).not.toBe(true);
      }
      const actorScopes = sessions
        .map((session) => world.sessions.get(session)?.actor)
        .filter((actor): actor is ObjRef => Boolean(actor));
      expect(actorScopes).toHaveLength(concurrentCalls);
      const accepted = actorScopes.flatMap((actor) => acceptedFramesForState(stateFor(actor)));
      expect(accepted).toHaveLength(concurrentCalls);
      expect(accepted.map((frame) => frame.position.scope).sort()).toEqual([...actorScopes].sort());
      expect(accepted.map((frame) => frame.position.seq)).toEqual([1, 1, 1, 1]);
      const actorOpenBodies = openBodies.filter((body) => actorScopes.includes(body.scope));
      expect(actorOpenBodies).toHaveLength(concurrentCalls * 2);
      const tinyOpens = actorOpenBodies.filter((body) => !Object.prototype.hasOwnProperty.call(body, "authority"));
      const seededOpens = actorOpenBodies.filter((body) => Object.prototype.hasOwnProperty.call(body, "authority"));
      expect(tinyOpens).toHaveLength(concurrentCalls);
      expect(seededOpens).toHaveLength(concurrentCalls);
      expect(tinyOpens.every((body) => body.open_protocol === "head_session.v1")).toBe(true);
      expect(tinyOpens.every((body) => !Object.prototype.hasOwnProperty.call(body, "serialized"))).toBe(true);
      expect(tinyOpens.every((body) => Array.isArray(body.session_objects) && body.session_objects.length === 0)).toBe(true);
      expect(seededOpens.every((body) => body.open_protocol === "head_session.v1")).toBe(true);
      expect(seededOpens.every((body) => Object.prototype.hasOwnProperty.call(body, "serialized"))).toBe(true);
      expect(seededOpens.every((body) => body.authority?.kind === "woo.authority_slice.cells.shadow.v1")).toBe(true);
    } finally {
      releaseEnvelopeBatch();
      for (const state of scopeStates.values()) state.close();
    }
  });
});

async function initializeMcp(gateway: McpGateway, token: string, id: number): Promise<string> {
  const init = await gateway.handle(jsonRpcRequest({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "v2-mcp-test", version: "0.0.0" }
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
  body: McpV2OpenBody | McpV2EnvelopeBody
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

function sqlRows<T>(cursor: unknown): T[] {
  if (cursor && typeof cursor === "object" && "toArray" in cursor && typeof cursor.toArray === "function") {
    return cursor.toArray() as T[];
  }
  return Array.from(cursor as Iterable<T>);
}

function acceptedFramesForState(state: FakeDurableObjectState): Array<{ position: { scope: ObjRef; seq: number } }> {
  try {
    return sqlRows<{ body: string }>(state.storage.sql.exec("SELECT body FROM v2_commit_scope_accepted_frame ORDER BY seq"))
      .map((row) => JSON.parse(row.body) as { position: { scope: ObjRef; seq: number } });
  } catch (err) {
    if (err instanceof Error && /no such table/.test(err.message)) return [];
    throw err;
  }
}

function mcpScopeObjectIds(gateway: McpGateway, scope: ObjRef): ObjRef[] {
  const client = mcpScopeClient(gateway, scope);
  return serializedFor(client.relay.commit_scope, { reason: "test_inspect_mcp_scope" })
    .objects
    .map((obj) => obj.id);
}

function removeObjectsFromMcpScope(gateway: McpGateway, scope: ObjRef, ids: ObjRef[]): void {
  const client = mcpScopeClient(gateway, scope);
  const remove = new Set(ids);
  const serialized = serializedFor(client.relay.commit_scope, { reason: "test_corrupt_mcp_scope" });
  serialized.objects = serialized.objects.filter((obj) => !remove.has(obj.id));
  markShadowBrowserRelaySerializedChanged(client.relay);
}

function mcpScopeClient(gateway: McpGateway, scope: ObjRef): {
  relay: Parameters<typeof markShadowBrowserRelaySerializedChanged>[0];
} {
  const scopes = (gateway as unknown as { v2Scopes: Map<ObjRef, { relay: Parameters<typeof markShadowBrowserRelaySerializedChanged>[0] }> }).v2Scopes;
  const client = scopes.get(scope);
  expect(client, `expected MCP v2 scope client for ${scope}`).toBeDefined();
  return client!;
}

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
