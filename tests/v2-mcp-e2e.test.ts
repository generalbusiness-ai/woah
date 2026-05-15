import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import type { ObjRef } from "../src/core/types";
import { McpGateway, type McpV2EnvelopeBody, type McpV2OpenBody } from "../src/mcp/gateway";
import { CommitScopeDO } from "../src/worker/commit-scope-do";
import { signInternalRequest } from "../src/worker/internal-auth";
import { FakeDurableObjectState } from "./worker/fake-do";

describe("v2 MCP e2e", () => {
  it("routes MCP tool calls through CommitScopeDO and fans accepted observations to MCP waiters", async () => {
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

      const accepted = sqlRows<{ body: string }>(scopeState.storage.sql.exec("SELECT body FROM v2_commit_scope_accepted_frame"));
      expect(accepted).toHaveLength(1);
      expect(JSON.parse(accepted[0].body)).toMatchObject({
        kind: "woo.commit.accepted.shadow.v1",
        position: { scope: "the_chatroom", seq: 1 },
        observations: expect.arrayContaining([expect.objectContaining({ type: "said" })])
      });

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
      const beforeWait = sqlRows<{ n: number }>(scopeState.storage.sql.exec("SELECT COUNT(*) AS n FROM v2_commit_scope_accepted_frame"))[0]?.n;

      await mcp(gateway, alice, 3, "tools/call", {
        name: "woo_wait",
        arguments: { timeout_ms: 0, limit: 10 }
      });
      const afterWait = sqlRows<{ n: number }>(scopeState.storage.sql.exec("SELECT COUNT(*) AS n FROM v2_commit_scope_accepted_frame"))[0]?.n;
      expect(afterWait).toBe(beforeWait);
    } finally {
      scopeState.close();
    }
  });

  it("keeps MCP session auth usable after a cross-scope room move", async () => {
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
      const sessions = world.exportSessions();
      await postCommitScope(scopeFor("the_deck"), env, "the_deck", "/v2/open", {
        scope: "the_deck",
        node: `mcp:${alice}`,
        token: `mcp-v2:${alice}:${aliceActor}`,
        session: alice,
        actor: aliceActor,
        sessions,
        session_objects: world.exportObjects(sessions.map((session) => session.actor)),
        serialized: world.exportWorld()
      });
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
    } finally {
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
  expect(response.ok).toBe(true);
  return await response.json() as T;
}

function sqlRows<T>(cursor: unknown): T[] {
  if (cursor && typeof cursor === "object" && "toArray" in cursor && typeof cursor.toArray === "function") {
    return cursor.toArray() as T[];
  }
  return Array.from(cursor as Iterable<T>);
}
