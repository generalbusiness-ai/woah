import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLocalMcpSmokeServer, type LocalMcpSmokeServer } from "./local-mcp-harness";

// With WOO_MCP_SMOKE_BASE_URL set this smoke runs against a deployed worker.
// Without it, it boots a local in-process MCP server (see local-mcp-harness.ts)
// so the streamable-HTTP MCP surface always has a local gate instead of
// silently skipping the whole suite.
const remoteBaseUrl = process.env.WOO_MCP_SMOKE_BASE_URL?.replace(/\/+$/, "");
let baseUrl = remoteBaseUrl;
let localServer: LocalMcpSmokeServer | undefined;
const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

beforeAll(async () => {
  if (!baseUrl) {
    localServer = await startLocalMcpSmokeServer();
    baseUrl = localServer.baseUrl;
  }
});

afterAll(async () => {
  await localServer?.close();
});

describe("v2 MCP smoke (deployed worker or local in-process server)", () => {
  it("initializes, lists tools, commits a catalog call, and delivers the observation to another session", async () => {
    const alice = await RemoteMcpSession.open(`guest:mcp-smoke-alice-${runId}`);
    const bob = await RemoteMcpSession.open(`guest:mcp-smoke-bob-${runId}`);
    try {
      const list = await bob.call("tools/list");
      const tools = toolsFromList(list);
      expect(tools).toContain("woo_call");
      expect(tools).toContain("woo_wait");
      await alice.enterChatroom();
      await bob.enterChatroom();

      const text = `v2 MCP smoke ${runId}`;
      const said = await alice.call("tools/call", {
        name: "woo_call",
        arguments: { object: "the_chatroom", verb: "say", args: [text] }
      });
      expect(said.result?.isError).not.toBe(true);
      expect(observationsOf(said)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "said", text: expect.stringContaining(text) })
      ]));

      const waited = await bob.call("tools/call", {
        name: "woo_wait",
        arguments: { timeout_ms: 1000, limit: 20 }
      });
      expect(waited.result?.isError).not.toBe(true);
      expect(waitObservationsOf(waited)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "said", text: expect.stringContaining(text) })
      ]));
    } finally {
      await Promise.allSettled([alice.close(), bob.close()]);
    }
  });

  it("rejects bad MCP credentials cleanly", async () => {
    const response = await mcpFetch({
      method: "POST",
      headers: { "mcp-token": `not-a-real-token-${runId}` },
      body: rpc(1, "initialize", initializeParams("bad-token-smoke"))
    });
    expect(response.status).toBe(401);
    const body = await parseMcpResponse(response);
    expect(body?.error?.data?.code).toBe("E_NOSESSION");
  });

  it("emits MCP list_changed notifications over the streamable HTTP event stream", async () => {
    const session = await RemoteMcpSession.open(`guest:mcp-smoke-sse-${runId}`);
    const events = session.openEvents();
    try {
      await session.enterChatroom();
      await session.call("tools/list");
      // list_changed fires only on a real reachability-digest change. Focusing
      // the active room can NEVER fire it: `McpHost.reachable()` dedups by
      // object id and the room is already present with origin "location", so
      // the digest is identical before and after (this is why the previous
      // `woo_focus the_chatroom` trigger silently produced no notification).
      // A cross-room move is the canonical tool-surface change: the actor's
      // location — and the new room's verb set — replace the old one. The
      // chatroom's `southeast` exit (living room → deck) ships in the bundled
      // demoworld catalog on every lane this smoke runs against.
      const moved = await session.call("tools/call", {
        name: "woo_call",
        arguments: { object: "the_chatroom", verb: "southeast", args: [] }
      });
      expect(moved.result?.isError).not.toBe(true);

      const notification = await events.nextJson((value) => value?.method === "notifications/tools/list_changed", 5000);
      expect(notification).toMatchObject({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    } finally {
      events.abort();
      await session.close();
    }
  });

  it("preserves session state across multiple Streamable-HTTP exchanges", async () => {
    const session = await RemoteMcpSession.open(`guest:mcp-smoke-reconnect-${runId}`);
    try {
      await session.enterChatroom();
      const text = `v2 MCP reconnect ${runId}`;
      await session.call("tools/call", {
        name: "woo_call",
        arguments: { object: "the_chatroom", verb: "say", args: [text] }
      });

      // A later request with only Mcp-Session-Id exercises the ordinary
      // Streamable-HTTP continuity path after the initial handshake.
      const list = await session.call("tools/list");
      expect(toolsFromList(list)).toContain("woo_call");

      const result = await session.call("tools/call", {
        name: "woo_call",
        arguments: { object: "the_chatroom", verb: "say", args: [`${text} again`] }
      });
      expect(result.result?.isError).not.toBe(true);
    } finally {
      await session.close();
    }
  });

  it("optionally verifies accepted-frame evidence through an operator-provided debug endpoint", async () => {
    const evidenceUrl = process.env.WOO_MCP_SMOKE_ACCEPTED_FRAMES_URL;
    if (!evidenceUrl) return;

    const session = await RemoteMcpSession.open(`guest:mcp-smoke-evidence-${runId}`);
    try {
      const text = `v2 MCP evidence ${runId}`;
      await session.call("tools/call", {
        name: "woo_call",
        arguments: { object: "the_chatroom", verb: "say", args: [text] }
      });

      // Expected response: JSON array of recent CommitScopeDO accepted-frame
      // rows, usually the most recent ~50. The shape is operator-defined; this
      // smoke only requires the run-specific text to appear somewhere in the
      // payload. Auth: WOO_MCP_SMOKE_ADMIN_TOKEN is sent as Bearer when set.
      // This endpoint is intentionally not part of the public product API. It
      // lets staging expose a narrow operator-only view of CommitScopeDO rows
      // without forcing normal smoke runs to depend on storage introspection.
      const response = await fetch(evidenceUrl, {
        headers: operatorHeaders()
      });
      expect(response.ok).toBe(true);
      const rows = await response.json() as unknown[];
      expect(JSON.stringify(rows)).toContain(text);
    } finally {
      await session.close();
    }
  });
});

class RemoteMcpSession {
  private nextId = 2;

  private constructor(readonly sessionId: string) {}

  static async open(token: string): Promise<RemoteMcpSession> {
    const response = await mcpFetch({
      method: "POST",
      headers: { "mcp-token": token },
      body: rpc(1, "initialize", initializeParams("woo-v2-mcp-smoke"))
    });
    expect(response.ok).toBe(true);
    const sessionId = response.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    await parseMcpResponse(response);

    const session = new RemoteMcpSession(sessionId!);
    const initialized = await session.notify("notifications/initialized");
    expect(initialized.status).toBe(202);
    return session;
  }

  async call(method: string, params?: unknown): Promise<any> {
    const response = await mcpFetch({
      method: "POST",
      headers: { "mcp-session-id": this.sessionId },
      body: rpc(this.nextId++, method, params)
    });
    expect(response.ok).toBe(true);
    const body = await parseMcpResponse(response);
    expect(body?.error).toBeUndefined();
    return body;
  }

  async notify(method: string, params?: unknown): Promise<Response> {
    return await mcpFetch({
      method: "POST",
      headers: { "mcp-session-id": this.sessionId },
      body: notification(method, params)
    });
  }

  async enterChatroom(): Promise<void> {
    // Best-effort positioning: the deployed demo world may already place new
    // guests in the chatroom, and the assertions that follow (`say` plus
    // cross-session observation delivery) are the authority-bearing smoke.
    await this.call("tools/call", {
      name: "woo_call",
      arguments: { object: "the_chatroom", verb: "enter", args: [] }
    });
  }

  openEvents(): EventStreamReader {
    const controller = new AbortController();
    const response = mcpFetch({
      method: "GET",
      headers: { "mcp-session-id": this.sessionId, accept: "text/event-stream" },
      signal: controller.signal
    });
    return new EventStreamReader(response, controller);
  }

  async close(): Promise<void> {
    await mcpFetch({
      method: "DELETE",
      headers: { "mcp-session-id": this.sessionId }
    }).catch(() => undefined);
  }
}

class EventStreamReader {
  constructor(private responsePromise: Promise<Response>, private controller: AbortController) {}

  async nextJson(predicate: (value: any) => boolean, timeoutMs: number): Promise<any> {
    const response = await this.responsePromise;
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type") ?? "").toContain("text/event-stream");
    if (!response.body) throw new Error("MCP event stream has no body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const timeout = setTimeout(() => this.controller.abort(), timeoutMs);
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (this.controller.signal.aborted) {
            throw new Error(`timed out waiting for matching MCP event after ${timeoutMs}ms`, { cause: err });
          }
          throw err;
        }
        const { value, done } = chunk;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";
        for (const event of events) {
          const data = event.split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice("data:".length).trim())
            .join("\n");
          if (!data) continue;
          const parsed = JSON.parse(data);
          if (predicate(parsed)) return parsed;
        }
      }
    } finally {
      clearTimeout(timeout);
      reader.releaseLock();
    }
    throw new Error(`timed out waiting for matching MCP event after ${timeoutMs}ms`);
  }

  abort(): void {
    this.controller.abort();
  }
}

async function mcpFetch(input: {
  method: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}): Promise<Response> {
  if (!baseUrl) throw new Error("MCP smoke base URL not resolved (beforeAll did not run?)");
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    ...input.headers
  });
  let body: BodyInit | undefined;
  if (input.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(input.body);
  }
  return await fetch(`${baseUrl}/mcp`, {
    method: input.method,
    headers,
    body,
    signal: input.signal
  });
}

async function parseMcpResponse(response: Response): Promise<any> {
  if (response.status === 202 || response.status === 204) return null;
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (!text) return null;
  if (contentType.includes("text/event-stream")) {
    const data = text.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice("data:".length).trim();
    return data ? JSON.parse(data) : null;
  }
  return JSON.parse(text);
}

function initializeParams(name: string): Record<string, unknown> {
  return {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name, version: "0.0.0" }
  };
}

function rpc(id: number, method: string, params?: unknown): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params })
  };
}

function notification(method: string, params?: unknown): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method,
    ...(params === undefined ? {} : { params })
  };
}

function toolsFromList(body: any): string[] {
  return (body?.result?.tools ?? []).map((tool: { name?: unknown }) => tool.name).filter((name: unknown): name is string => typeof name === "string");
}

function observationsOf(body: any): unknown[] {
  return body?.result?.structuredContent?.observations ?? [];
}

function waitObservationsOf(body: any): unknown[] {
  return body?.result?.structuredContent?.result?.observations ?? [];
}

function operatorHeaders(): HeadersInit {
  const token = process.env.WOO_MCP_SMOKE_ADMIN_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
}
