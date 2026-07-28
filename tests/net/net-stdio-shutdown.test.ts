import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { NetMcpStdioDispatcher } from "../../src/mcp/net-stdio-dispatcher";
import { NetMcpStdioProxy } from "../../src/mcp/net-stdio-proxy";
import { createNetMcpStdioShutdown, NET_MCP_STDIO_HARD_EXIT_MS } from "../../src/mcp/net-stdio-shutdown";

/**
 * Shutdown promptness for the stdio bridge.
 *
 * These assertions are on *elapsed time*, not on final state. A bridge that
 * hangs forever and a bridge that shuts down correctly reach the same final
 * state once the hang is externally released, so a shape-only assertion here
 * passes against the very defect the tests exist to catch.
 */

/** A fetch that never answers, mimicking a Net endpoint that has gone away
 * without resetting the connection. It honours abort, as real fetch does. */
function hang(signal: AbortSignal | null | undefined, onAbort?: () => void): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    if (!signal) return; // never settles at all — the "ignores abort" case
    const fail = (): void => {
      onAbort?.();
      reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    };
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

function initializeResponse(id: unknown, session: string): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "woo-net", version: "1" } }
    },
    { headers: { "mcp-session-id": session } }
  );
}

/** Build a bridge whose POSTs are answered by `respond`, already carrying a
 * live Net session so shutdown has a DELETE to perform. */
async function bridgeWithSession(options: {
  respond: (body: { id?: unknown; method: string }, init: RequestInit) => Promise<Response>;
  onDelete?: (init: RequestInit) => Promise<Response>;
  drainMs: number;
  teardownMs: number;
}): Promise<{
  dispatch: (message: JSONRPCMessage) => Promise<void>;
  shutdown: () => Promise<void>;
  sent: JSONRPCMessage[];
  methods: string[];
  transportClosed: () => boolean;
}> {
  const sent: JSONRPCMessage[] = [];
  const methods: string[] = [];
  let closed = false;
  const fetchImpl: typeof fetch = async (_input, init) => {
    const method = init?.method ?? "GET";
    if (method === "DELETE") {
      methods.push("DELETE");
      return options.onDelete ? options.onDelete(init!) : new Response(null, { status: 204 });
    }
    if (method === "GET") {
      methods.push("GET");
      return new Response(null, { status: 405 }); // no standalone SSE carrier
    }
    const body = JSON.parse(String(init?.body)) as { id?: unknown; method: string };
    methods.push(`POST ${body.method}`);
    if (body.method === "initialize") return initializeResponse(body.id, "s_shutdown");
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return options.respond(body, init!);
  };

  const proxy = new NetMcpStdioProxy({ endpoint: "http://127.0.0.1:5173/net-api/mcp", token: "apikey:t:s", fetchImpl });
  const dispatcher = new NetMcpStdioDispatcher(proxy, async (message) => { sent.push(message); }, () => {});
  const transport = { close: async (): Promise<void> => { closed = true; } };
  const shutdown = createNetMcpStdioShutdown({
    dispatcher,
    proxy,
    transport,
    drainMs: options.drainMs,
    teardownMs: options.teardownMs
  });

  await dispatcher.dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await dispatcher.dispatch({ jsonrpc: "2.0", method: "notifications/initialized" });
  return {
    dispatch: (message) => dispatcher.dispatch(message),
    shutdown,
    sent,
    methods,
    transportClosed: () => closed
  };
}

describe("Net MCP stdio bridge shutdown", () => {
  it("bounds the drain, aborts the hung request, answers it, and still deletes the session", async () => {
    let aborts = 0;
    const bridge = await bridgeWithSession({
      respond: async (_body, init) => hang(init.signal, () => { aborts += 1; }),
      drainMs: 150,
      teardownMs: 50
    });

    const hung = bridge.dispatch({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "woo_wait" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bridge.methods).toContain("POST tools/call");

    const started = Date.now();
    await bridge.shutdown();
    const elapsed = Date.now() - started;

    // Lower bound: the drain really happened rather than being skipped.
    // Upper bound: worst case is drainMs + 3 x teardownMs = 300ms.
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(1_000);

    await hung;
    expect(aborts).toBe(1);
    expect(bridge.sent).toContainEqual({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32000, message: "Net MCP stdio bridge shut down before the request completed" }
    });
    expect(bridge.methods).toContain("DELETE");
    expect(bridge.transportClosed()).toBe(true);
  });

  it("lets a healthy in-flight request finish untouched", async () => {
    let abortedAtCompletion: boolean | null = null;
    const bridge = await bridgeWithSession({
      respond: async (body, init) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        abortedAtCompletion = init.signal?.aborted ?? false;
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [] } });
      },
      drainMs: 2_000,
      teardownMs: 500
    });

    const inFlight = bridge.dispatch({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "woo_call" } });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const started = Date.now();
    await bridge.shutdown();
    const elapsed = Date.now() - started;

    await inFlight;
    // Nothing was stuck, so shutdown must not spend any of its 2s drain budget.
    expect(elapsed).toBeLessThan(500);
    expect(abortedAtCompletion).toBe(false);
    expect(bridge.sent).toContainEqual({ jsonrpc: "2.0", id: 2, result: { content: [] } });
    expect(bridge.methods).toContain("DELETE");
  });

  it("does not let a hung session DELETE resurrect the hang", async () => {
    const bridge = await bridgeWithSession({
      respond: async (body) => Response.json({ jsonrpc: "2.0", id: body.id, result: {} }),
      // Worst possible courtesy DELETE: never settles and ignores the signal.
      onDelete: async () => hang(null),
      drainMs: 100,
      teardownMs: 50
    });

    const started = Date.now();
    await bridge.shutdown();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1_000);
    expect(bridge.transportClosed()).toBe(true);
  });

  it("refuses messages that arrive after shutdown started instead of dropping them", async () => {
    const bridge = await bridgeWithSession({
      respond: async (body) => Response.json({ jsonrpc: "2.0", id: body.id, result: {} }),
      drainMs: 100,
      teardownMs: 50
    });
    await bridge.shutdown();
    const before = bridge.methods.length;

    await bridge.dispatch({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} });
    await bridge.dispatch({ jsonrpc: "2.0", method: "notifications/cancelled" });

    expect(bridge.methods).toHaveLength(before); // nothing forwarded
    expect(bridge.sent).toContainEqual({
      jsonrpc: "2.0",
      id: 9,
      error: { code: -32000, message: "Net MCP stdio bridge is shutting down" }
    });
    expect(bridge.sent.filter((message) => "error" in message)).toHaveLength(1); // notification got no reply
  });

  it("runs the teardown once when EOF and a signal both arrive", async () => {
    const bridge = await bridgeWithSession({
      respond: async (body) => Response.json({ jsonrpc: "2.0", id: body.id, result: {} }),
      drainMs: 100,
      teardownMs: 50
    });

    await Promise.all([bridge.shutdown(), bridge.shutdown(), bridge.shutdown()]);
    expect(bridge.methods.filter((method) => method === "DELETE")).toHaveLength(1);
  });
});

/**
 * A Net endpoint that completes initialize and then never answers anything
 * else — the exact condition under which the bridge used to become unkillable.
 */
async function startHangingNetEndpoint(): Promise<{ url: string; deletes: () => number; posts: () => string[]; stop: () => Promise<void> }> {
  const posts: string[] = [];
  let deletes = 0;
  const held: ServerResponse[] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method === "DELETE") {
      deletes += 1;
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET") {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: unknown; method: string };
      posts.push(body.method);
      if (body.method === "initialize") {
        response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s_child" }).end(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "woo-net", version: "1" } }
        }));
        return;
      }
      if (body.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      held.push(response); // deliberately never answered
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/net-api/mcp`,
    deletes: () => deletes,
    posts: () => [...posts],
    stop: async () => {
      for (const response of held) response.destroy();
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  };
}

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The installed `tsx` CLI, resolved rather than assumed to sit under this
 * file's own tree. Under a git worktree `node_modules` lives at the primary
 * checkout, so a path built relative to this file resolves to something that
 * does not exist and the child dies with ENOENT before it can be driven —
 * reported as "child never reached tools/call", which reads like a bridge
 * defect rather than a missing binary. Node's own resolution is what knows how
 * to walk up to the real install. */
const TSX_CLI = join(dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist", "cli.mjs");

describe("net MCP stdio bridge process", () => {
  /** Drive a real child bridge into a request the endpoint never answers, then
   * end it the way `stop` says and report how long the child took to leave. */
  async function hungChildThen(
    stop: (child: ReturnType<typeof spawn>) => void
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null; elapsedMs: number; deletes: number; stderr: string }> {
    const endpoint = await startHangingNetEndpoint();
    const child = spawn(process.execPath, [TSX_CLI, "src/mcp/net-stdio.ts"], {
      cwd: REPO_ROOT,
      env: { ...process.env, WOO_MCP_URL: endpoint.url, WOO_MCP_TOKEN: "apikey:local-dev:secret" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stderrChunks: Buffer[] = [];
    child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    try {
      const write = (message: unknown): void => { child.stdin?.write(`${JSON.stringify(message)}\n`); };
      write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
      write({ jsonrpc: "2.0", method: "notifications/initialized" });
      write({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "woo_wait", arguments: {} } });
      // Sync point: the child is now blocked on a POST that will never answer.
      const deadline = Date.now() + 20_000;
      while (!endpoint.posts().includes("tools/call")) {
        if (Date.now() > deadline) throw new Error(`child never reached tools/call: ${Buffer.concat(stderrChunks).toString("utf8")}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const started = Date.now();
      stop(child);
      const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
      return {
        code,
        signal,
        elapsedMs: Date.now() - started,
        deletes: endpoint.deletes(),
        stderr: Buffer.concat(stderrChunks).toString("utf8")
      };
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await endpoint.stop();
    }
  }

  it("exits promptly on SIGTERM while a request is hung", async () => {
    const result = await hungChildThen((child) => child.kill("SIGTERM"));
    // Graceful: the code is our own exit status, not death by signal.
    expect(result.signal).toBeNull();
    expect(result.code).toBe(143);
    expect(result.elapsedMs).toBeLessThan(NET_MCP_STDIO_HARD_EXIT_MS);
    // Promptness is the point; state alone would look identical after a hang.
    expect(result.elapsedMs).toBeLessThan(4_000);
    // The courtesy DELETE still happened despite the hung request.
    expect(result.deletes).toBe(1);
  }, 40_000);

  it("exits promptly on stdin EOF while a request is hung", async () => {
    const result = await hungChildThen((child) => child.stdin?.end());
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.elapsedMs).toBeLessThan(4_000);
    expect(result.deletes).toBe(1);
  }, 40_000);
});
