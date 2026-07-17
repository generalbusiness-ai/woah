import { describe, expect, it } from "vitest";
import { NetMcpStdioProxy } from "../../src/mcp/net-stdio-proxy";

describe("Net MCP stdio transport bridge", () => {
  it("forwards initialize with the API key, then binds later messages and close to the returned Net session", async () => {
    const calls: Array<{ method: string; headers: Headers; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method: init?.method ?? "GET", headers, body });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
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
    expect(calls[1]!.headers.get("mcp-session-id")).toBe("s_net-api-0_test");
    expect(calls[2]!.headers.get("mcp-session-id")).toBe("s_net-api-0_test");

    await proxy.close();
    expect(calls[3]).toMatchObject({ method: "DELETE" });
    expect(calls[3]!.headers.get("mcp-session-id")).toBe("s_net-api-0_test");
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
});
