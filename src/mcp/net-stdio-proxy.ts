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
  /** Server-initiated Streamable HTTP messages become ordinary stdio output.
   * The Net gateway currently emits list_changed notifications only, but the
   * transport deliberately preserves the full JSON-RPC message shape. */
  onNotification?: (message: JSONRPCMessage) => Promise<void> | void;
  onError?: (error: unknown) => void;
};

export class NetMcpStdioProxy {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onNotification: (message: JSONRPCMessage) => Promise<void> | void;
  private readonly onError: (error: unknown) => void;
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  private readonly notificationAbort = new AbortController();
  private notificationTask: Promise<void> | null = null;
  private closed = false;

  constructor(options: NetMcpStdioProxyOptions) {
    this.endpoint = options.endpoint;
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onNotification = options.onNotification ?? (() => {});
    this.onError = options.onError ?? (() => {});
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
      if (!isInitialize(message) && this.protocolVersion) {
        headers.set("mcp-protocol-version", this.protocolVersion);
      }

      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(message)
      });
      if (response.status === 202 || response.status === 204) {
        if (response.status === 202 && isInitialized(message)) this.startNotifications();
        return null;
      }

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
        const negotiated = "result" in decoded
          && decoded.result
          && typeof decoded.result === "object"
          && "protocolVersion" in decoded.result
          && typeof decoded.result.protocolVersion === "string"
          ? decoded.result.protocolVersion
          : null;
        this.protocolVersion = negotiated;
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
    this.notificationAbort.abort();
    await this.notificationTask?.catch(() => undefined);
    const session = this.sessionId;
    this.sessionId = null;
    if (!session) return;
    const headers = new Headers({ "mcp-session-id": session });
    if (this.protocolVersion) headers.set("mcp-protocol-version", this.protocolVersion);
    await this.fetchImpl(this.endpoint, {
      method: "DELETE",
      headers
    }).then((response) => response.body?.cancel()).catch(() => undefined);
  }

  private startNotifications(): void {
    const session = this.sessionId;
    if (!session || this.closed || this.notificationTask) return;
    this.notificationTask = this.listenForNotifications(session)
      .catch((error) => {
        if (!this.closed && !isAbortError(error)) this.onError(error);
      })
      .finally(() => { this.notificationTask = null; });
  }

  /** Maintain the optional standalone GET/SSE carrier. Woo's server closes
   * each idle listen within 25 seconds; reconnecting is normal, while a small
   * floor prevents a misbehaving endpoint that returns immediate empty 200s
   * from becoming a tight request loop. */
  private async listenForNotifications(session: string): Promise<void> {
    let retryMs = 250;
    while (!this.closed && this.sessionId === session) {
      try {
        const headers = new Headers({ accept: "text/event-stream", "mcp-session-id": session });
        if (this.protocolVersion) headers.set("mcp-protocol-version", this.protocolVersion);
        const response = await this.fetchImpl(this.endpoint, {
          method: "GET",
          headers,
          signal: this.notificationAbort.signal
        });
        if (response.status === 405) {
          await response.body?.cancel();
          return;
        }
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          const error = new Error(`Net MCP notification stream returned ${response.status}: ${detail}`);
          // A dead/rejected session cannot recover by reopening the same GET.
          // Surface it once; later ordinary MCP calls will carry the correlated
          // JSON-RPC error that tells the client to establish a new session.
          if (response.status === 401 || response.status === 404) {
            this.onError(error);
            return;
          }
          throw error;
        }
        if (!response.headers.get("content-type")?.includes("text/event-stream")) {
          await response.body?.cancel();
          throw new Error("Net MCP notification GET did not return text/event-stream");
        }
        await consumeMcpSse(response, async (message) => this.onNotification(message));
        retryMs = 250;
      } catch (error) {
        if (this.closed || isAbortError(error)) return;
        this.onError(error);
        retryMs = Math.min(retryMs * 2, 5_000);
      }
      if (!this.closed && this.sessionId === session) {
        await abortableDelay(retryMs, this.notificationAbort.signal);
      }
    }
  }
}

function isInitialize(message: JSONRPCMessage): boolean {
  return "method" in message && message.method === "initialize";
}

function isInitialized(message: JSONRPCMessage): boolean {
  return "method" in message && message.method === "notifications/initialized";
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

async function consumeMcpSse(
  response: Response,
  onMessage: (message: JSONRPCMessage) => Promise<void>
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Net MCP notification stream has no body");
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const events = buffered.split(/\r?\n\r?\n/);
      buffered = events.pop() ?? "";
      for (const event of events) {
        await consumeMcpSseEvent(event, onMessage);
      }
    }
    // A conforming SSE sender terminates events with a blank line. Still
    // accept a complete final data event when an intermediary closes exactly
    // at EOF; this is harmless for retry/comment-only priming fragments.
    buffered += decoder.decode();
    await consumeMcpSseEvent(buffered, onMessage);
  } finally {
    reader.releaseLock();
  }
}

async function consumeMcpSseEvent(
  event: string,
  onMessage: (message: JSONRPCMessage) => Promise<void>
): Promise<void> {
  const data = event.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (!data) return; // retry/keepalive/priming event
  await onMessage(JSONRPCMessageSchema.parse(JSON.parse(data)));
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  // Undici, Node, browsers, and workerd do not all share one DOMException
  // constructor identity. The standardized error name is the portable seam.
  return typeof error === "object" && error !== null
    && "name" in error && error.name === "AbortError";
}
