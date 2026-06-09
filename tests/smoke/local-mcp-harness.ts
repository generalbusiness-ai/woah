// Local in-process MCP smoke harness.
//
// The v2 MCP smoke (`tests/smoke/v2-mcp-smoke.test.ts`) was written against a
// deployed worker URL and silently skipped whenever WOO_MCP_SMOKE_BASE_URL was
// unset — which meant the streamable-HTTP MCP surface had no local gate at
// all. This harness gives the same test file a local lane: a real node HTTP
// server in front of `McpGateway.handle`, with the gateway's v2 dispatch wired
// to `CommitScopeDO` over `FakeDurableObjectState` (the same fake-DO wiring as
// `tests/v2-mcp-e2e.test.ts`). The smoke's fetch-based client code runs
// unchanged against either the deployed worker or this server.
//
// Fidelity note: like every fake-DO lane this collapses all Durable Objects
// into one process with synchronous RPC — it validates protocol shape, session
// continuity, SSE notifications, and cross-session observation delivery, not
// cross-colo latency or cold-owner timeouts (see AGENTS.md smoke ladder).
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createWorld } from "../../src/core/bootstrap";
import type { ObjRef } from "../../src/core/types";
import { McpGateway, type McpV2EnvelopeBody, type McpV2OpenBody } from "../../src/mcp/gateway";
import { CommitScopeDO } from "../../src/worker/commit-scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { FakeDurableObjectState } from "../worker/fake-do";

export interface LocalMcpSmokeServer {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startLocalMcpSmokeServer(): Promise<LocalMcpSmokeServer> {
  const world = createWorld();
  const env = { WOO_INTERNAL_SECRET: "v2-mcp-smoke-secret" };
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
    serverName: "woo-mcp-smoke-local",
    v2: {
      open: async (commitScope, body) => await postCommitScope(scopeFor(commitScope), env, commitScope, "/v2/open", body),
      envelope: async (commitScope, body) => await postCommitScope(scopeFor(commitScope), env, commitScope, "/v2/envelope", body)
    }
  });

  const server = http.createServer(async (req, res) => {
    try {
      const response = await gateway.handle(await nodeRequestToWeb(req));
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      // Node buffers headers until the first body write; an SSE stream with no
      // initial event would leave the client's fetch() unresolved forever.
      res.flushHeaders();
      if (!response.body) {
        res.end();
        return;
      }
      // Stream the body chunk-by-chunk: the GET event stream stays open until
      // the client aborts, so buffering the whole body would hang the SSE test.
      const reader = response.body.getReader();
      req.on("close", () => void reader.cancel().catch(() => {}));
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(err));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      // Open SSE connections would otherwise keep `server.close` waiting forever.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      for (const state of scopeStates.values()) state.close();
    }
  };
}

// Same internal-auth POST shape the worker uses for gateway → CommitScopeDO
// calls (mirrors the wiring in tests/v2-mcp-e2e.test.ts).
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

async function nodeRequestToWeb(req: http.IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
  }
  return new Request(`http://127.0.0.1${req.url ?? "/"}`, {
    method: req.method,
    headers,
    // GET/DELETE requests must not carry a body (the Request constructor throws).
    body: body.length > 0 ? body : undefined
  });
}
