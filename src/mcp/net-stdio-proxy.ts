/**
 * Stdio-to-Net MCP framing bridge.
 *
 * This module deliberately knows no WooWorld, verbs, tools, or projection
 * model. The authoritative MCP implementation is `/net-api/mcp`; stdio only
 * changes how JSON-RPC messages enter and leave that implementation. Keeping
 * the bridge this small prevents local agent tooling from becoming a second
 * execution stack with different session, reachability, or observation rules.
 */
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export type NetMcpStdioProxyOptions = {
  endpoint: string;
  token: string;
  fetchImpl?: typeof fetch;
};

export class NetMcpStdioProxy {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private sessionId: string | null = null;
  private closed = false;

  constructor(options: NetMcpStdioProxyOptions) {
    this.endpoint = options.endpoint;
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** True only after initialize has installed the Net HTTP session id. */
  get sessionReady(): boolean {
    return this.sessionId !== null;
  }

  /** Forward one already-validated stdio message. Notifications produce no
   * stdout message because the Net endpoint acknowledges them with 202. */
  async forward(message: JSONRPCMessage): Promise<JSONRPCMessage | null> {
    try {
      const headers = new Headers({
        accept: "application/json, text/event-stream",
        "content-type": "application/json"
      });
      if (isInitialize(message)) headers.set("mcp-token", this.token);
      else if (this.sessionId) headers.set("mcp-session-id", this.sessionId);

      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(message)
      });
      if (response.status === 202 || response.status === 204) return null;

      const text = await response.text();
      if (!text) throw new Error(`Net MCP returned ${response.status} with an empty body`);
      const decoded = JSONRPCMessageSchema.parse(parseMcpBody(text, response.headers.get("content-type")));
      // Streamable HTTP may attach a useful JSON-RPC error to a non-2xx
      // response. Preserve that protocol error; synthesize -32000 only when
      // the response cannot be decoded as an MCP message at all.
      if (response.ok && isInitialize(message)) {
        const session = response.headers.get("mcp-session-id");
        if (!session) throw new Error("Net MCP initialize response omitted mcp-session-id");
        this.sessionId = session;
      }
      return decoded;
    } catch (error) {
      if (!hasRequestId(message)) throw error;
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: `Net MCP transport failed: ${errorMessage(error)}` }
      };
    }
  }

  /** Close the underlying Net session exactly once. Stdio EOF is transport
   * shutdown, so it maps to Streamable HTTP DELETE rather than merely exiting
   * and waiting for the session TTL. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const session = this.sessionId;
    this.sessionId = null;
    if (!session) return;
    await this.fetchImpl(this.endpoint, {
      method: "DELETE",
      headers: { "mcp-session-id": session }
    }).then((response) => response.body?.cancel()).catch(() => undefined);
  }
}

function isInitialize(message: JSONRPCMessage): boolean {
  return "method" in message && message.method === "initialize";
}

function hasRequestId(message: JSONRPCMessage): message is JSONRPCMessage & { id: string | number } {
  return "id" in message && (typeof message.id === "string" || typeof message.id === "number");
}

function parseMcpBody(text: string, contentType: string | null): unknown {
  if (!contentType?.includes("text/event-stream")) return JSON.parse(text);
  const data = text.split(/\r?\n/).find((line) => line.startsWith("data:"));
  if (!data) throw new Error("Net MCP event stream contained no message");
  return JSON.parse(data.slice("data:".length).trim());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
