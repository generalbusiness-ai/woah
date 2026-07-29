import { describe, expect, it, vi } from "vitest";
import { NetMcpStdioDispatcher } from "../../src/mcp/net-stdio-dispatcher";
import { NetMcpStdioProxy } from "../../src/mcp/net-stdio-proxy";

describe("Net MCP stdio transport bridge", () => {
  it("forwards initialize with the API key, then binds later messages and close to the returned Net session", async () => {
    const calls: Array<{ method: string; headers: Headers; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method: init?.method ?? "GET", headers, body });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (init?.method === "GET") return new Response(null, { status: 405 });
      if ((body as { method?: string } | null)?.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if ((body as { method?: string } | null)?.method === "initialize") {
        return Response.json(
          { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "woo-net", version: "1" } } },
          { headers: { "mcp-session-id": "s_net-api-0_test" } }
        );
      }
      return Response.json({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
    };
    const proxy = new NetMcpStdioProxy({
      endpoint: "http://127.0.0.1:5173/net-api/mcp",
      token: "apikey:local-dev:secret",
      fetchImpl
    });

    const initialized = await proxy.forward({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(initialized).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18" } });
    expect(calls[0]!.headers.get("mcp-token")).toBe("apikey:local-dev:secret");
    expect(calls[0]!.headers.get("mcp-session-id")).toBeNull();

    expect(await proxy.forward({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const listed = await proxy.forward({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(listed).toMatchObject({ id: 2, result: { tools: [] } });
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts[1]!.headers.get("mcp-session-id")).toBe("s_net-api-0_test");
    expect(posts[2]!.headers.get("mcp-session-id")).toBe("s_net-api-0_test");

    await proxy.close();
    const deleted = calls.find((call) => call.method === "DELETE");
    expect(deleted).toMatchObject({ method: "DELETE" });
    expect(deleted!.headers.get("mcp-session-id")).toBe("s_net-api-0_test");
  });

  it("returns a correlated JSON-RPC error when the HTTP transport is unavailable", async () => {
    const proxy = new NetMcpStdioProxy({
      endpoint: "http://127.0.0.1:1/net-api/mcp",
      token: "apikey:local-dev:secret",
      fetchImpl: async () => {
        throw new Error("connection refused");
      }
    });

    await expect(proxy.forward({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} })).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32000, message: expect.stringContaining("connection refused") }
    });
  });

  it("opens GET/SSE after initialized and forwards list_changed to stdio", async () => {
    const calls: Array<{ method: string; headers: Headers }> = [];
    const notifications: unknown[] = [];
    let getCount = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      calls.push({ method, headers });
      if (method === "DELETE") return new Response(null, { status: 204 });
      if (method === "GET") {
        getCount += 1;
        if (getCount > 1) return new Response(null, { status: 405 });
        return new Response(
          // Exercise an intermediary closing immediately after a complete
          // data line, without the conventional final blank event separator.
          'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n',
          { headers: { "content-type": "text/event-stream" } }
        );
      }
      const body = JSON.parse(String(init?.body)) as { id?: number; method?: string };
      if (body.method === "initialize") {
        return Response.json(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: { listChanged: true } },
              serverInfo: { name: "woo-net", version: "1" }
            }
          },
          { headers: { "mcp-session-id": "s_net-api-0_events" } }
        );
      }
      return new Response(null, { status: 202 });
    };
    const proxy = new NetMcpStdioProxy({
      endpoint: "http://127.0.0.1:5173/net-api/mcp",
      token: "apikey:local-dev:secret",
      fetchImpl,
      onNotification: async (message) => { notifications.push(message); }
    });

    await proxy.forward({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await proxy.forward({ jsonrpc: "2.0", method: "notifications/initialized" });
    await vi.waitFor(() => expect(notifications).toEqual([{
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed"
    }]));

    const get = calls.find((call) => call.method === "GET");
    expect(get?.headers.get("accept")).toBe("text/event-stream");
    expect(get?.headers.get("mcp-session-id")).toBe("s_net-api-0_events");
    expect(get?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
    await proxy.close();
  });

  it.each([401, 404])("opens after a 204 initialized ack and reports terminal GET %s exactly once", async (status) => {
    vi.useFakeTimers();
    try {
      let getCount = 0;
      const errors: unknown[] = [];
      const fetchImpl: typeof fetch = async (_input, init) => {
        const method = init?.method ?? "GET";
        if (method === "DELETE") return new Response(null, { status: 204 });
        if (method === "GET") {
          getCount += 1;
          return Response.json({ error: { code: "E_NOSESSION", message: "session expired" } }, { status });
        }
        const body = JSON.parse(String(init?.body)) as { id?: number; method?: string };
        if (body.method === "initialize") {
          return Response.json(
            {
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: { listChanged: true } },
                serverInfo: { name: "woo-net", version: "1" }
              }
            },
            { headers: { "mcp-session-id": `s_terminal_${status}` } }
          );
        }
        return new Response(null, { status: 204 });
      };
      const proxy = new NetMcpStdioProxy({
        endpoint: "http://127.0.0.1:5173/net-api/mcp",
        token: "apikey:local-dev:secret",
        fetchImpl,
        onError: (error) => { errors.push(error); }
      });

      await proxy.forward({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      await proxy.forward({ jsonrpc: "2.0", method: "notifications/initialized" });
      await vi.waitFor(() => {
        expect(getCount).toBe(1);
        expect(errors).toHaveLength(1);
      });
      expect(String(errors[0])).toContain(String(status));

      await vi.advanceTimersByTimeAsync(30_000);
      expect(getCount).toBe(1);
      expect(errors).toHaveLength(1);
      await proxy.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes the pre-session prefix but does not let woo_wait block later messages", async () => {
    let releaseInitialize!: () => void;
    let releaseWait!: () => void;
    const initializeGate = new Promise<void>((resolve) => { releaseInitialize = resolve; });
    const waitGate = new Promise<void>((resolve) => { releaseWait = resolve; });
    const calls: string[] = [];
    const replies: Array<string | number> = [];
    const proxy = new NetMcpStdioProxy({
      endpoint: "http://127.0.0.1:5173/net-api/mcp",
      token: "apikey:local-dev:secret",
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { id: string | number; method: string };
        calls.push(body.method);
        if (body.method === "initialize") {
          await initializeGate;
          return Response.json(
            { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "woo-net", version: "1" } } },
            { headers: { "mcp-session-id": "s_net-api-0_test" } }
          );
        }
        if (body.method === "tools/call") {
          await waitGate;
          return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [] } });
        }
        return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
      }
    });
    const dispatcher = new NetMcpStdioDispatcher(
      proxy,
      async (message) => {
        if ("id" in message && (typeof message.id === "string" || typeof message.id === "number")) {
          replies.push(message.id);
        }
      },
      (error) => { throw error; }
    );

    const initializing = dispatcher.dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const pipelined = dispatcher.dispatch({ jsonrpc: "2.0", id: 2, method: "ping", params: {} });
    await Promise.resolve();
    expect(calls).toEqual(["initialize"]);

    releaseInitialize();
    await initializing;
    await pipelined;
    expect(calls).toEqual(["initialize", "ping"]);

    const waiting = dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "woo_wait", arguments: { timeout_ms: 25_000 } }
    });
    await Promise.resolve();
    const pinging = dispatcher.dispatch({ jsonrpc: "2.0", id: 4, method: "ping", params: {} });
    await pinging;
    expect(calls).toEqual(["initialize", "ping", "tools/call", "ping"]);
    expect(replies).toEqual([1, 2, 4]);

    releaseWait();
    await waiting;
    await dispatcher.idle();
    expect(replies).toEqual([1, 2, 4, 3]);
  });

  it("preserves a server JSON-RPC error carried by a non-2xx response", async () => {
    const proxy = new NetMcpStdioProxy({
      endpoint: "http://127.0.0.1:5173/net-api/mcp",
      token: "apikey:local-dev:secret",
      fetchImpl: async () => Response.json(
        { jsonrpc: "2.0", id: 9, error: { code: -32001, message: "session expired" } },
        { status: 401 }
      )
    });

    await expect(proxy.forward({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} })).resolves.toEqual({
      jsonrpc: "2.0",
      id: 9,
      error: { code: -32001, message: "session expired" }
    });
  });

  // ---- defence in depth: bodies the bridge cannot parse as JSON-RPC --------
  //
  // The gateway now answers every /net-api/mcp request with a JSON-RPC message
  // (mcp.md §M1.2), but the bridge and the worker version INDEPENDENTLY: a
  // current bridge routinely talks to a worker that has not been redeployed.
  // Whatever the body turns out to be, the server's own diagnosis must reach
  // the client — the failure this replaced pasted a ~3.9 kB Zod union report
  // into the user-facing message and dropped "apikey not found or revoked"
  // entirely.

  it("wraps an older gateway's bare woo refusal, preserving its code and message", async () => {
    const proxy = new NetMcpStdioProxy({
      endpoint: "http://127.0.0.1:5173/net-api/mcp",
      token: "apikey:local-dev:secret",
      // Exactly what every pre-§M1.2 gateway answers with on this route.
      fetchImpl: async () => Response.json(
        {
          error: {
            code: "E_NOSESSION",
            message: "apikey not found or revoked",
            detail: { reason: "unknown_or_revoked" }
          }
        },
        { status: 401 }
      )
    });

    const reply = await proxy.forward({ jsonrpc: "2.0", id: 4, method: "initialize", params: {} });
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: 4,
      error: {
        code: -32000,
        message: "apikey not found or revoked",
        data: { code: "E_NOSESSION", detail: { reason: "unknown_or_revoked" }, http_status: 401 }
      }
    });
  });

  it("re-correlates an id-less JSON-RPC error to the request that provoked it", async () => {
    // A pre-parse refusal (foreign Origin, unparseable body) cannot know the
    // id, so the gateway omits it. Only this side still knows which request it
    // answered, and a reply the client cannot correlate is a hang.
    const proxy = new NetMcpStdioProxy({
      endpoint: "http://127.0.0.1:5173/net-api/mcp",
      token: "apikey:local-dev:secret",
      fetchImpl: async () => Response.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "foreign MCP Origin is not allowed", data: { code: "E_PERM" } } },
        { status: 403 }
      )
    });

    await expect(proxy.forward({ jsonrpc: "2.0", id: 12, method: "tools/list", params: {} })).resolves.toEqual({
      jsonrpc: "2.0",
      id: 12,
      error: { code: -32000, message: "foreign MCP Origin is not allowed", data: { code: "E_PERM" } }
    });
  });

  it("summarizes an unintelligible body instead of pasting the parser's report into the message", async () => {
    const proxy = new NetMcpStdioProxy({
      endpoint: "http://127.0.0.1:5173/net-api/mcp",
      token: "apikey:local-dev:secret",
      // An intermediary's HTML error page: neither JSON-RPC nor a woo refusal.
      fetchImpl: async () => new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" }
      })
    });

    const reply = await proxy.forward({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} }) as {
      id: number;
      error: { code: number; message: string; data: Record<string, unknown> };
    };
    expect(reply.id).toBe(5);
    expect(reply.error.code).toBe(-32000);
    expect(reply.error.message).toBe("Net MCP returned an unrecognized 502 response");
    expect(reply.error.message.length).toBeLessThan(120);
    // The unparseable material is kept — just not where a human reads it.
    expect(reply.error.data.http_status).toBe(502);
    expect(String(reply.error.data.body)).toContain("502 Bad Gateway");
    expect(String(reply.error.data.parse_error).length).toBeGreaterThan(0);
  });

  it("reports an empty refusal body as a correlated error rather than a thrown transport failure", async () => {
    const proxy = new NetMcpStdioProxy({
      endpoint: "http://127.0.0.1:5173/net-api/mcp",
      token: "apikey:local-dev:secret",
      fetchImpl: async () => new Response(null, { status: 401 })
    });

    await expect(proxy.forward({ jsonrpc: "2.0", id: 6, method: "tools/list", params: {} })).resolves.toEqual({
      jsonrpc: "2.0",
      id: 6,
      error: {
        code: -32000,
        message: "Net MCP returned 401 with an empty body",
        data: { http_status: 401 }
      }
    });
  });

  it("reports a refused notification on stderr and does not throw", async () => {
    // A notification has no reply slot, so the refusal cannot become a stdio
    // message — but it must not become a bridge stack trace either. Both the
    // current id-less JSON-RPC shape and an older gateway's bare body have to
    // land as one legible line.
    for (const body of [
      { jsonrpc: "2.0", error: { code: -32000, message: "session expired", data: { code: "E_NOSESSION" } } },
      { error: { code: "E_NOSESSION", message: "session expired" } }
    ]) {
      const errors: unknown[] = [];
      const proxy = new NetMcpStdioProxy({
        endpoint: "http://127.0.0.1:5173/net-api/mcp",
        token: "apikey:local-dev:secret",
        fetchImpl: async () => Response.json(body, { status: 401 }),
        onError: (error) => { errors.push(error); }
      });

      await expect(proxy.forward({ jsonrpc: "2.0", method: "notifications/initialized" })).resolves.toBeNull();
      expect(errors).toHaveLength(1);
      expect(String(errors[0])).toContain("notifications/initialized");
      expect(String(errors[0])).toContain("session expired");
    }
  });

  it("surfaces an initialize the gateway refused instead of complaining about a missing session header", async () => {
    // A 200 initialize carrying a JSON-RPC error has no mcp-session-id, and the
    // bridge used to throw on that absence — replacing the gateway's actual
    // reason with "initialize response omitted mcp-session-id".
    const proxy = new NetMcpStdioProxy({
      endpoint: "http://127.0.0.1:5173/net-api/mcp",
      token: "apikey:local-dev:secret",
      fetchImpl: async () => Response.json(
        { jsonrpc: "2.0", id: 3, error: { code: -32000, message: "session mint failed: E_RETRY", data: { code: "E_RETRY" } } },
        { status: 200 }
      )
    });

    await expect(proxy.forward({ jsonrpc: "2.0", id: 3, method: "initialize", params: {} })).resolves.toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32000, message: "session mint failed: E_RETRY", data: { code: "E_RETRY" } }
    });
    expect(proxy.sessionReady).toBe(false);
  });
});
