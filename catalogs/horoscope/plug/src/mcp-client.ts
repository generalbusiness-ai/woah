// Minimal MCP client for plug Workers, talking to woo's streamable-HTTP MCP
// gateway (src/mcp/gateway.ts).
//
// **NOT CURRENTLY WIRED.** The production plug uses REST via woo-client.ts.
// This module is preserved for the future long-lived "event-driven" plug
// variant — when the catalog is ready and we want a persistent session that
// drains via `woo_wait` instead of cron polling, this is the transport.
//
// `woo_call` requires verbs to be `tool_exposed: true` and reachable
// (server.ts:129, host.ts:588). For dispenser-style plugs that's a deliberate
// catalog policy decision: hide :next_pending / :deliver from agent
// discovery (current default) → use REST; expose them as MCP tools →
// switch to this client.
//
// Transport: HTTP POST per JSON-RPC request. First POST carries
// `Authorization: Bearer <token>` and includes the `initialize` request;
// the gateway resolves the token to a woo session and returns
// `Mcp-Session-Id` as a response header. Subsequent POSTs include that
// header. DELETE with the same header closes the session.
//
// All verb invocations go through the `woo_call` tool — the gateway exposes
// it as a generic `(object, verb, args)` entrypoint. The tool result wraps
// the verb's return in `structuredContent.result`; errors in
// `structuredContent.error` with `isError: true`.

const PROTOCOL_VERSION = "2025-06-18";

export type WooMcpSession = {
  mcpSessionId: string;
  serverInfo?: { name?: string; version?: string };
};

export class WooMcpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly value?: unknown
  ) {
    super(message);
    this.name = "WooMcpError";
  }
}

export type WooMcpClientOptions = {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  clientName?: string;
  clientVersion?: string;
};

type RpcResponse = { result?: any; error?: { code: number; message: string; data?: any } };

export class WooMcpClient {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private session: WooMcpSession | null = null;
  private nextId = 1;

  constructor(opts: WooMcpClientOptions) {
    const base = opts.baseUrl.replace(/\/+$/, "");
    this.endpoint = `${base}/mcp`;
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.clientName = opts.clientName ?? "woo-plug";
    this.clientVersion = opts.clientVersion ?? "0.0.0";
  }

  get currentSession(): WooMcpSession | null {
    return this.session;
  }

  // First POST: include Authorization header and the JSON-RPC `initialize`
  // request. Server returns Mcp-Session-Id header; we capture it. Then send
  // the `notifications/initialized` notification per MCP protocol.
  async initialize(): Promise<WooMcpSession> {
    const id = this.nextId++;
    const body = {
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: this.clientName, version: this.clientVersion }
      }
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.token}`
    };

    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    const mcpSessionId = response.headers.get("mcp-session-id");
    const data = await this.readJsonRpc(response);
    this.unwrapResult(data, "initialize");

    if (!mcpSessionId) {
      throw new WooMcpError("E_NOSESSION", "MCP gateway did not return Mcp-Session-Id", response.status);
    }
    this.session = { mcpSessionId, serverInfo: data.result?.serverInfo };

    await this.notify("notifications/initialized");
    return this.session;
  }

  // Generic verb invocation via the `woo_call` tool.
  async wooCall(object: string, verb: string, args: unknown[] = []): Promise<unknown> {
    const tool = await this.callTool("woo_call", { object, verb, args });
    if (tool.isError) {
      const err = (tool.structuredContent?.error ?? {}) as { code?: string; message?: string; value?: unknown };
      throw new WooMcpError(
        err.code ?? "E_INTERNAL",
        err.message ?? `woo_call ${object}:${verb} failed`,
        500,
        err.value
      );
    }
    return tool.structuredContent?.result ?? null;
  }

  async close(): Promise<void> {
    if (!this.session) return;
    const headers: Record<string, string> = {
      "Mcp-Session-Id": this.session.mcpSessionId
    };
    try {
      await this.fetchImpl(this.endpoint, { method: "DELETE", headers });
    } catch {
      // Best-effort cleanup. The gateway times sessions out anyway.
    }
    this.session = null;
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ isError?: boolean; content?: any; structuredContent?: any }> {
    const data = await this.rpc("tools/call", { name, arguments: args });
    return this.unwrapResult(data, `tools/call ${name}`);
  }

  private async rpc(method: string, params: unknown): Promise<RpcResponse> {
    this.requireSession();
    const id = this.nextId++;
    const body = { jsonrpc: "2.0", id, method, params };
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": this.session!.mcpSessionId
    };
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    return this.readJsonRpc(response);
  }

  private async notify(method: string, params: unknown = {}): Promise<void> {
    this.requireSession();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": this.session!.mcpSessionId
    };
    // A JSON-RPC notification has no `id` and the server returns no body.
    const body = { jsonrpc: "2.0", method, params };
    await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
  }

  private requireSession(): void {
    if (!this.session) throw new WooMcpError("E_NOSESSION", "WooMcpClient.initialize() not yet called", 401);
  }

  private async readJsonRpc(response: Response): Promise<RpcResponse> {
    const text = await response.text();
    if (!response.ok) {
      let parsed: any = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          // fall through
        }
      }
      const err = parsed?.error;
      throw new WooMcpError(
        err?.data?.code ?? `E_HTTP_${response.status}`,
        err?.message ?? `MCP gateway HTTP ${response.status}`,
        response.status,
        err?.data
      );
    }
    if (text.length === 0) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new WooMcpError("E_INVARG", "MCP response was not JSON", response.status);
    }
  }

  private unwrapResult(data: RpcResponse, label: string): any {
    if (data.error) {
      const code = data.error.data?.code ?? `E_RPC_${data.error.code}`;
      throw new WooMcpError(code, `${label}: ${data.error.message}`, 500, data.error.data);
    }
    return data.result;
  }
}
