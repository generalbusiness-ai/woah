import { describe, expect, it } from "vitest";
import { WooMcpClient, WooMcpError } from "../src/mcp-client";

type Recorded = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: any;
};

function makeFetch(responses: Array<{ status?: number; headers?: Record<string, string>; body?: any }>): {
  fetchImpl: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let i = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k] = h[k];
    }
    let body: any = undefined;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = String(init.body);
      }
    }
    calls.push({ url, method, headers, body });
    const next = responses[i++] ?? { status: 200, body: {} };
    const responseHeaders = new Headers(next.headers ?? {});
    responseHeaders.set("content-type", "application/json");
    const text = next.body === undefined ? "" : JSON.stringify(next.body);
    return new Response(text, {
      status: next.status ?? 200,
      headers: responseHeaders
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("WooMcpClient", () => {
  it("sends Authorization on initialize, captures Mcp-Session-Id, sends notifications/initialized", async () => {
    const { fetchImpl, calls } = makeFetch([
      // initialize response
      {
        status: 200,
        headers: { "mcp-session-id": "mcp-sess-1" },
        body: {
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            serverInfo: { name: "woo", version: "0.0.0" }
          }
        }
      },
      // notifications/initialized — no body needed
      { status: 202, body: {} }
    ]);

    const client = new WooMcpClient({
      baseUrl: "https://woo.example.com/",
      token: "apikey:abc:def",
      fetchImpl,
      clientName: "test-plug",
      clientVersion: "1.2.3"
    });
    const session = await client.initialize();

    expect(session.mcpSessionId).toBe("mcp-sess-1");
    expect(session.serverInfo).toEqual({ name: "woo", version: "0.0.0" });
    expect(client.currentSession?.mcpSessionId).toBe("mcp-sess-1");

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      url: "https://woo.example.com/mcp",
      method: "POST",
      headers: { Authorization: "Bearer apikey:abc:def" }
    });
    expect(calls[0].body).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "test-plug", version: "1.2.3" }
      }
    });
    expect(calls[1]).toMatchObject({
      url: "https://woo.example.com/mcp",
      method: "POST",
      headers: { "Mcp-Session-Id": "mcp-sess-1" }
    });
    expect(calls[1].body).toMatchObject({
      jsonrpc: "2.0",
      method: "notifications/initialized"
    });
    expect(calls[1].body).not.toHaveProperty("id");
  });

  it("wooCall posts tools/call with woo_call args and returns structuredContent.result", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        status: 200,
        headers: { "mcp-session-id": "s1" },
        body: { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {} } }
      },
      { status: 202, body: {} },
      {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id: 3,
          result: {
            content: [{ type: "text", text: "ok" }],
            structuredContent: {
              result: { ok: true, note: "note_42" },
              observations: []
            },
            isError: false
          }
        }
      }
    ]);

    const client = new WooMcpClient({ baseUrl: "https://w", token: "apikey:a:b", fetchImpl });
    await client.initialize();
    const result = await client.wooCall("the_horoscope_block", "deliver", ["ord_1", "destiny calls"]);

    expect(result).toEqual({ ok: true, note: "note_42" });
    const toolCall = calls[2];
    expect(toolCall.url).toBe("https://w/mcp");
    expect(toolCall.headers["Mcp-Session-Id"]).toBe("s1");
    expect(toolCall.body).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "woo_call",
        arguments: {
          object: "the_horoscope_block",
          verb: "deliver",
          args: ["ord_1", "destiny calls"]
        }
      }
    });
  });

  it("wooCall raises WooMcpError when isError + structuredContent.error are set", async () => {
    const { fetchImpl } = makeFetch([
      {
        status: 200,
        headers: { "mcp-session-id": "s" },
        body: { jsonrpc: "2.0", id: 1, result: {} }
      },
      { status: 202, body: {} },
      {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id: 3,
          result: {
            content: [{ type: "text", text: "E_RATE: too soon" }],
            structuredContent: {
              error: { code: "E_RATE", message: "too soon", value: { retry_after_ms: 30000 } }
            },
            isError: true
          }
        }
      }
    ]);

    const client = new WooMcpClient({ baseUrl: "https://w", token: "apikey:a:b", fetchImpl });
    await client.initialize();

    await expect(client.wooCall("the_horoscope_block", "order", ["scorpio"])).rejects.toMatchObject({
      name: "WooMcpError",
      code: "E_RATE",
      message: "too soon",
      value: { retry_after_ms: 30000 }
    });
  });

  it("close DELETEs with the session header", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        status: 200,
        headers: { "mcp-session-id": "s-close" },
        body: { jsonrpc: "2.0", id: 1, result: {} }
      },
      { status: 202, body: {} },
      { status: 204, body: {} }
    ]);

    const client = new WooMcpClient({ baseUrl: "https://w", token: "apikey:a:b", fetchImpl });
    await client.initialize();
    await client.close();
    expect(calls.at(-1)).toMatchObject({
      url: "https://w/mcp",
      method: "DELETE",
      headers: { "Mcp-Session-Id": "s-close" }
    });
    expect(client.currentSession).toBeNull();
  });

  it("refuses to call before initialize()", async () => {
    const { fetchImpl } = makeFetch([]);
    const client = new WooMcpClient({ baseUrl: "https://w", token: "apikey:a:b", fetchImpl });
    await expect(client.wooCall("foo", "bar")).rejects.toBeInstanceOf(WooMcpError);
  });

  it("raises WooMcpError when the gateway returns 4xx auth failure", async () => {
    const { fetchImpl } = makeFetch([
      {
        status: 401,
        body: {
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32001, message: "auth failed", data: { code: "E_NOSESSION" } }
        }
      }
    ]);
    const client = new WooMcpClient({ baseUrl: "https://w", token: "apikey:bad", fetchImpl });
    await expect(client.initialize()).rejects.toMatchObject({
      name: "WooMcpError",
      code: "E_NOSESSION",
      status: 401
    });
  });

  it("raises WooMcpError when initialize succeeds at HTTP but the gateway omits Mcp-Session-Id", async () => {
    const { fetchImpl } = makeFetch([
      {
        status: 200,
        // no mcp-session-id header
        body: { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {} } }
      }
    ]);
    const client = new WooMcpClient({ baseUrl: "https://w", token: "apikey:a:b", fetchImpl });
    await expect(client.initialize()).rejects.toMatchObject({ code: "E_NOSESSION" });
  });
});
