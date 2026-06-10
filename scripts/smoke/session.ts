// Shared MCP smoke session — ONE implementation of the two-actor MCP client
// used by every smoke lane. Previously this logic was copied between
// scripts/smoke-walkthrough.ts (deployed, real HTTP) and
// tests/worker/cf-local-walkthrough.test.ts (in-process fake DO), and the two
// copies drifted. The only real difference between the lanes is the
// *transport* — how a /mcp request reaches the worker — so this module takes
// that as an injected `McpTransport` and keeps the JSON-RPC handshake, actor
// resolution, room tracking, and per-RPC deadline identical everywhere.
//
// Lanes and their transports:
//   - deployed   (scripts/smoke-walkthrough.ts)  -> httpTransport(baseUrl) over global fetch
//   - workerd    (scripts/smoke-cf-dev.ts)       -> httpTransport(localUrl) over global fetch
//   - fake DO    (tests/worker/cf-local-*.test)  -> closure over harness.request("/mcp", ...)

// A transport carries one /mcp request to the worker and returns its Response.
// The path is always /mcp; the transport owns base URL / worker binding.
export type McpTransport = (init: {
  method: string;
  headers: Headers;
  body?: BodyInit;
  signal?: AbortSignal;
}) => Promise<Response>;

export type SmokeSessionOptions = {
  token: string;
  label: string;
  // `clientInfo.name` is logged server-side as `client_info.name` on every MCP
  // request, so encoding a run id here lets a `wrangler tail` filter narrow to
  // exactly one invocation: `--search <clientName>`.
  clientName: string;
  // Per-RPC deadline. The worker should answer in well under a second; the only
  // long call is the woo_wait long-poll (~1000ms). 20s leaves headroom for p99
  // fanout and guarantees a stuck connection cannot strand a step watchdog.
  rpcTimeoutMs?: number;
};

const DEFAULT_RPC_TIMEOUT_MS = 20_000;

export class SmokeSession {
  private nextId = 2;
  // Tracked from every move-style response that carries a `room` field in its
  // structuredContent.result. Guarded helpers (leaveIfIn, directional walks)
  // gate on this so a leave/direction verb is never issued from the wrong
  // assumed room — which would surface as a confusing E_VERBNF that masks the
  // real upstream failure.
  currentRoom: string | null = null;

  private constructor(
    private readonly transport: McpTransport,
    readonly sessionId: string,
    readonly actor: string,
    readonly label: string,
    private readonly rpcTimeoutMs: number
  ) {}

  static async open(transport: McpTransport, options: SmokeSessionOptions): Promise<SmokeSession> {
    const rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    const response = await fetchMcp(transport, rpcTimeoutMs, {
      method: "POST",
      headers: { "mcp-token": options.token },
      body: rpc(1, "initialize", initializeParams(options.clientName))
    });
    if (!response.ok) {
      throw new Error(`MCP initialize failed: ${response.status} ${await response.text().catch(() => "")}`);
    }
    const sessionId = response.headers.get("mcp-session-id");
    if (!sessionId) throw new Error("MCP initialize response missing mcp-session-id");
    // Drain (and confirm parse of) the initialize envelope before emitting
    // notifications/initialized, mirroring the SDK handshake order.
    await parseMcpResponse(response);

    // The actor id is not in the initialize response shape; resolve it from the
    // dynamic tool list, where every actor-control tool is prefixed `${id}:`.
    // The reachability gate guarantees `${actor}:focus_list` (and friends) are
    // always present, so this resolver is stable.
    const probing = new SmokeSession(transport, sessionId, "", options.label, rpcTimeoutMs);
    const notified = await fetchMcp(transport, rpcTimeoutMs, {
      method: "POST",
      headers: { "mcp-session-id": sessionId },
      body: notification("notifications/initialized")
    });
    if (notified.status !== 202) {
      throw new Error(`notifications/initialized expected 202, got ${notified.status}`);
    }
    const tools = await probing.callTool("woo_list_reachable_tools", { scope: "all", limit: 200 });
    const list = (tools as any)?.result?.structuredContent?.result?.tools ?? [];
    const selfTool = list.find((tool: any) =>
      typeof tool?.object === "string" &&
      /^guest_/.test(tool.object) &&
      (tool.verb === "focus_list" || tool.verb === "focus" || tool.verb === "wait")
    );
    if (!selfTool || typeof selfTool.object !== "string") {
      throw new Error(`could not resolve actor for ${options.label} from tool list (saw ${list.length} tools)`);
    }
    return new SmokeSession(transport, sessionId, selfTool.object, options.label, rpcTimeoutMs);
  }

  async call(object: string, verb: string, verbArgs: unknown[], signal?: AbortSignal): Promise<unknown> {
    const result = unwrap(await this.callRaw(object, verb, verbArgs, signal));
  // Move/enter/out responses carry `room` in structuredContent.result;
    // update tracked room from every successful call.
    if (isRecord(result) && typeof result.room === "string") this.currentRoom = result.room;
    return result;
  }

  // Follow the `out` exit only if our tracked location matches `space`. Tool
  // spaces model "way back" as a room exit, not as a public lifecycle verb.
  // Guarding the call keeps cleanup from masking the real upstream failure with a
  // wrong-room movement error. Returns true iff the exit actually fired.
  async leaveIfIn(space: string, signal?: AbortSignal): Promise<boolean> {
    if (this.currentRoom !== space) return false;
    await this.call(space, "go", ["out"], signal);
    return true;
  }

  async moveTo(space: string, signal?: AbortSignal): Promise<unknown> {
    const exit = TOOL_SPACE_EXIT_ALIASES[space];
    if (!exit) throw new Error(`no smoke movement route for ${space}`);
    if (!this.currentRoom) throw new Error(`cannot move to ${space}: current room is unknown`);
    return await this.call(this.currentRoom, "go", [exit], signal);
  }

  async callRaw(object: string, verb: string, verbArgs: unknown[], signal?: AbortSignal): Promise<any> {
    return await this.callTool("woo_call", { object, verb, args: verbArgs }, { signal });
  }

  async callTool(
    name: string,
    params: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<any> {
    const response = await fetchMcp(this.transport, options.timeoutMs ?? this.rpcTimeoutMs, {
      method: "POST",
      headers: { "mcp-session-id": this.sessionId },
      body: rpc(this.nextId++, "tools/call", { name, arguments: params }),
      signal: options.signal
    });
    if (!response.ok) {
      throw new Error(`tools/call ${name} ${response.status}: ${await response.text().catch(() => "")}`);
    }
    const body = await parseMcpResponse(response);
    // JSON-RPC envelope errors (transport/protocol level — unknown session,
    // malformed request) surface as `body.error` and would otherwise be
    // swallowed (callers reach into result.* and find undefined). Make it loud.
    if (body && typeof body === "object" && "error" in body && body.error) {
      throw new Error(`tools/call ${name} JSON-RPC error: ${JSON.stringify((body as any).error)}`);
    }
    return body;
  }

  async close(signal?: AbortSignal): Promise<void> {
    await fetchMcp(this.transport, 3000, {
      method: "DELETE",
      headers: { "mcp-session-id": this.sessionId },
      signal
    }).catch(() => undefined);
  }
}

const TOOL_SPACE_EXIT_ALIASES: Record<string, string> = {
  the_dubspace: "dubspace",
  the_outline: "outline",
  the_pinboard: "pinboard"
};

// HTTP transport for the deployed and local-workerd lanes: a raw fetch to
// <baseUrl>/mcp. The per-RPC deadline lives in the session (fetchMcp), so the
// transport stays a thin fetch wrapper shared by both HTTP lanes.
export function httpTransport(baseUrl: string): McpTransport {
  const base = baseUrl.replace(/\/+$/, "");
  return (init) => fetch(`${base}/mcp`, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal
  });
}

// Issue one MCP request through the transport with a hard per-RPC deadline.
// Composes the caller's optional signal with a timeout signal so either an
// explicit abort or the deadline tears the request down promptly, and reports a
// deadline overrun as a timeout-classified error (isTimeoutDetail matches it).
async function fetchMcp(
  transport: McpTransport,
  timeoutMs: number,
  input: { method: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal }
): Promise<Response> {
  const headers = new Headers({ accept: "application/json, text/event-stream", ...input.headers });
  let body: BodyInit | undefined;
  if (input.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(input.body);
  }
  const timeoutController = new AbortController();
  const timer = setTimeout(
    () => timeoutController.abort(new Error(`MCP request exceeded ${timeoutMs}ms deadline`)),
    timeoutMs
  );
  const signal = mergeSignals(input.signal, timeoutController.signal);
  try {
    return await transport({ method: input.method, headers, body, signal });
  } catch (err) {
    if (timeoutController.signal.aborted) {
      throw new Error(`MCP ${input.method} /mcp timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  const anyImpl = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyImpl === "function") return anyImpl([a, b]);
  // Manual relay fallback for older runtimes.
  const merged = new AbortController();
  const relay = () => merged.abort();
  if (a.aborted) merged.abort();
  else a.addEventListener("abort", relay, { once: true });
  if (b.aborted) merged.abort();
  else b.addEventListener("abort", relay, { once: true });
  return merged.signal;
}

export async function parseMcpResponse(response: Response): Promise<any> {
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

export function unwrap(body: any): unknown {
  if (body?.result?.isError) {
    const sc = body.result.structuredContent;
    throw new Error(`MCP tool error: ${JSON.stringify(sc ?? body.result, null, 2)}`);
  }
  return body?.result?.structuredContent?.result;
}

export function waitObservationsOf(body: any): unknown[] {
  return body?.result?.structuredContent?.result?.observations ?? [];
}

export function initializeParams(name: string): Record<string, unknown> {
  return {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name, version: "0.0.0" }
  };
}

export function rpc(id: number, method: string, params?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

export function notification(method: string, params?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
}

export function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
