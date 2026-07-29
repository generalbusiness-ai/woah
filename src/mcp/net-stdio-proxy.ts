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
import { withDeadline } from "./deadline";

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

/** Default wall-clock bound for each step of {@link NetMcpStdioProxy.close}. */
export const NET_MCP_STDIO_CLOSE_MS = 500;

export class NetMcpStdioProxy {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onNotification: (message: JSONRPCMessage) => Promise<void> | void;
  private readonly onError: (error: unknown) => void;
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  private readonly notificationAbort = new AbortController();
  /** Cancels forwarded request POSTs. Deliberately separate from
   * `notificationAbort`: shutdown must be able to cut a hung request without
   * that being confused with the notification carrier's normal retry cycle. */
  private readonly requestAbort = new AbortController();
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

      // No per-request deadline: `woo_wait` legitimately blocks for tens of
      // seconds, so a blanket transport timeout would break it. The bound that
      // matters is shutdown, and `requestAbort` supplies it — otherwise a hung
      // POST outlives stdin and the process ignores SIGTERM.
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: this.requestAbort.signal
      });
      if (response.status === 202 || response.status === 204) {
        if (isInitialized(message)) this.startNotifications();
        return null;
      }

      const text = await response.text();
      // Streamable HTTP may attach a useful JSON-RPC error to a non-2xx
      // response. `decodeNetMcpResponse` preserves whatever diagnosis the body
      // carries — a JSON-RPC message, an older gateway's bare woo refusal, or
      // failing both, a short summary — and never lets a schema-validation
      // dump take the place of the server's own message.
      const decoded = decodeNetMcpResponse(text, response);
      if (decoded.kind === "message") {
        // Only a message that actually carries a `result` establishes the
        // session. An initialize the gateway ANSWERED with a JSON-RPC error
        // reaches the error branch below, so the client is told why the key
        // was refused instead of "initialize response omitted mcp-session-id".
        if (response.ok && isInitialize(message)) {
          const session = response.headers.get("mcp-session-id");
          if (!session) throw new Error("Net MCP initialize response omitted mcp-session-id");
          this.sessionId = session;
          this.protocolVersion = protocolVersionOf(decoded.message);
        }
        return decoded.message;
      }
      // An error, from any of the three shapes. A request gets it correlated
      // to the id it sent — the gateway omits the id on a refusal raised
      // before it could parse the body, and only this side still knows it.
      if (hasRequestId(message)) return { jsonrpc: "2.0", id: message.id, error: decoded.error };
      // A notification has no reply slot, so the refusal cannot be a message.
      // It must still be legible: reporting it (stderr, via onError) is the
      // only place the diagnosis can go, and throwing here would replace it
      // with a bridge stack trace.
      this.onError(new Error(`Net MCP refused ${methodOf(message) ?? "a notification"}: ${decoded.error.message}`));
      return null;
    } catch (error) {
      const aborted = isAbortError(error) || this.requestAbort.signal.aborted;
      if (!hasRequestId(message)) {
        // A notification has no reply slot. Abort during shutdown is expected,
        // so it must not be reported as a bridge error on stderr.
        if (aborted) return null;
        throw error;
      }
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: aborted
            ? "Net MCP stdio bridge shut down before the request completed"
            : `Net MCP transport failed: ${errorMessage(error)}`
        }
      };
    }
  }

  /** Cancel every in-flight forwarded request.
   *
   * Shutdown calls this after its bounded drain: a request the Net endpoint
   * never answers must not be able to hold stdin EOF or SIGTERM hostage.
   * Each cancelled `forward` resolves with a correlated JSON-RPC error, so
   * the client sees a reply rather than a truncated stream. */
  abortRequests(): void {
    this.requestAbort.abort();
  }

  /** Close the underlying Net session exactly once. Stdio EOF is transport
   * shutdown, so it maps to Streamable HTTP DELETE rather than merely exiting
   * and waiting for the session TTL.
   *
   * The DELETE is a courtesy — the server expires the session on its own TTL —
   * so every step here is bounded by `timeoutMs`. A hung endpoint must not
   * turn session hygiene back into the hang this method exists to avoid. */
  async close(timeoutMs = NET_MCP_STDIO_CLOSE_MS): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.notificationAbort.abort();
    this.requestAbort.abort();
    await withDeadline(this.notificationTask?.catch(() => undefined), timeoutMs);
    const session = this.sessionId;
    this.sessionId = null;
    if (!session) return;
    const headers = new Headers({ "mcp-session-id": session });
    if (this.protocolVersion) headers.set("mcp-protocol-version", this.protocolVersion);
    // Both bounds are needed: the signal frees the socket, and the race frees
    // this method even from a `fetch` implementation that ignores the signal.
    const deleted = this.fetchImpl(this.endpoint, {
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    }).then((response) => response.body?.cancel()).catch(() => undefined);
    await withDeadline(deleted, timeoutMs);
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
          // Same decode ladder the request path uses, so a refused carrier
          // reports the gateway's own sentence rather than a raw body dump.
          const text = await response.text().catch(() => "");
          const decoded = decodeNetMcpResponse(text, response);
          const detail = decoded.kind === "error" ? decoded.error.message : text;
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

/** JSON-RPC requests carry an id and therefore owe the client exactly one
 * reply; notifications do not. Shared with the dispatcher so both sides agree
 * on which messages must be answered when the bridge is tearing down. */
export function hasRequestId(message: JSONRPCMessage): message is JSONRPCMessage & { id: string | number } {
  return "id" in message && (typeof message.id === "string" || typeof message.id === "number");
}


function parseMcpBody(text: string, contentType: string | null): unknown {
  if (!contentType?.includes("text/event-stream")) return JSON.parse(text);
  const data = text.split(/\r?\n/).find((line) => line.startsWith("data:"));
  if (!data) throw new Error("Net MCP event stream contained no message");
  return JSON.parse(data.slice("data:".length).trim());
}

/** The JSON-RPC error object shape this bridge produces or forwards. */
type NetMcpErrorObject = { code: number; message: string; data?: unknown };

type NetMcpDecoded =
  | { kind: "message"; message: JSONRPCMessage }
  | { kind: "error"; error: NetMcpErrorObject };

/** JSON-RPC's implementation-defined server-error slot. The Net gateway uses
 * the same number, and the woo code always rides in `error.data.code`. */
const NET_MCP_SERVER_ERROR = -32000;

/** Enough of a strange body to diagnose it, bounded so a stray HTML error page
 * or a proxy dump cannot become a multi-kilobyte stdio message. */
const NET_MCP_BODY_EXCERPT = 400;

/**
 * Decode one Streamable HTTP response body.
 *
 * Three shapes are accepted, in descending order of fidelity:
 *
 * 1. **A JSON-RPC message.** Returned as-is when it carries a result, and
 *    unwrapped to its `error` when it is an error response — including the
 *    id-less form the gateway uses for a refusal raised before it could read
 *    the request (§M1.2), which only the caller can still correlate.
 * 2. **A bare woo refusal**, `{error:{code,message,detail}}`. This is what
 *    every gateway older than the §M1.2 envelope answers with on this route,
 *    and what the rest of the woo HTTP surface still answers with. The bridge
 *    and the worker version independently, so tolerating it is not legacy
 *    kindness — it is the only thing that keeps a current bridge usable
 *    against a deployed worker that has not been updated yet.
 * 3. **Anything else.** A SHORT summary, with the unparseable material kept in
 *    `data`. This is the case the previous implementation handled by letting a
 *    schema validator throw and pasting its ~3 kB union report into the
 *    user-facing `message`, which is how "apikey not found or revoked" reached
 *    an agent as a wall of Zod output.
 */
function decodeNetMcpResponse(text: string, response: Response): NetMcpDecoded {
  const status = response.status;
  if (!text) {
    return {
      kind: "error",
      error: {
        code: NET_MCP_SERVER_ERROR,
        message: `Net MCP returned ${status} with an empty body`,
        data: { http_status: status }
      }
    };
  }
  let body: unknown;
  try {
    body = parseMcpBody(text, response.headers.get("content-type"));
  } catch (error) {
    return { kind: "error", error: unintelligibleBody(text, status, errorMessage(error)) };
  }

  const parsed = JSONRPCMessageSchema.safeParse(body);
  if (parsed.success) {
    const message = parsed.data;
    if ("error" in message && message.error) return { kind: "error", error: message.error };
    return { kind: "message", message };
  }

  const woo = bareWooRefusal(body);
  if (woo) {
    return {
      kind: "error",
      error: {
        code: NET_MCP_SERVER_ERROR,
        message: woo.message,
        data: { code: woo.code, ...(woo.detail === undefined ? {} : { detail: woo.detail }), http_status: status }
      }
    };
  }
  // `parsed.error` is the schema report. It belongs in `data`, never in the
  // message a client shows a human.
  return { kind: "error", error: unintelligibleBody(text, status, parsed.error.message) };
}

/** The pre-envelope woo refusal body, or null when this is something else. */
function bareWooRefusal(body: unknown): { code: string; message: string; detail?: unknown } | null {
  if (typeof body !== "object" || body === null || !("error" in body)) return null;
  const error = (body as { error: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  if (typeof code !== "string" || typeof message !== "string") return null;
  return { code, message, detail: (error as { detail?: unknown }).detail };
}

function unintelligibleBody(text: string, status: number, reason: string): NetMcpErrorObject {
  return {
    code: NET_MCP_SERVER_ERROR,
    message: `Net MCP returned an unrecognized ${status} response`,
    data: {
      http_status: status,
      // Both are truncated: this string can end up on a terminal.
      body: text.slice(0, NET_MCP_BODY_EXCERPT),
      parse_error: reason.slice(0, NET_MCP_BODY_EXCERPT)
    }
  };
}

/** The negotiated protocol version from an initialize result, if it has one. */
function protocolVersionOf(message: JSONRPCMessage): string | null {
  if (!("result" in message) || !message.result || typeof message.result !== "object") return null;
  const version = (message.result as { protocolVersion?: unknown }).protocolVersion;
  return typeof version === "string" ? version : null;
}

function methodOf(message: JSONRPCMessage): string | null {
  return "method" in message && typeof message.method === "string" ? message.method : null;
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
