// Net MCP stdio entry point.
//
// Run `npm run dev` first, then configure an MCP client to spawn this command.
// The process is intentionally only a JSON-RPC transport bridge; all tool and
// turn behavior remains in the Net gateway's `/net-api/mcp` implementation.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { NetMcpStdioDispatcher } from "./net-stdio-dispatcher";
import { NetMcpStdioProxy } from "./net-stdio-proxy";
import { createNetMcpStdioShutdown, NET_MCP_STDIO_HARD_EXIT_MS } from "./net-stdio-shutdown";

async function main(): Promise<void> {
  const token = process.env.WOO_MCP_TOKEN;
  if (!token) {
    throw new Error("WOO_MCP_TOKEN is required (Net uses apikey:<id>:<secret>)");
  }
  if (!token.startsWith("apikey:")) {
    throw new Error("WOO_MCP_TOKEN must be a Net apikey:<id>:<secret> credential");
  }
  const endpoint = process.env.WOO_MCP_URL ?? "http://127.0.0.1:5173/net-api/mcp";
  const transport = new StdioServerTransport();
  const reportError = (error: unknown): void => {
    process.stderr.write(`net MCP stdio bridge error: ${errorMessage(error)}\n`);
  };
  // `WOO_MCP_PROFILE=collapsed` selects the collapsed tool/resource surface
  // (mcp.md §M9.1). Unset keeps the classic default, so an existing bridge
  // configuration behaves exactly as before.
  const profile = process.env.WOO_MCP_PROFILE;
  const proxy = new NetMcpStdioProxy({
    endpoint,
    token,
    ...(profile ? { profile } : {}),
    onNotification: (message) => transport.send(message),
    onError: reportError
  });
  const dispatcher = new NetMcpStdioDispatcher(
    proxy,
    (message) => transport.send(message),
    reportError
  );
  const shutdown = createNetMcpStdioShutdown({ dispatcher, proxy, transport, onError: reportError });

  /** Every exit route runs the same bounded shutdown, then leaves.
   *
   * The explicit exit matters: the bridge holds sockets (the notification
   * GET/SSE carrier, any aborted POST) whose teardown we cannot fully observe,
   * and "the event loop happened to drain" is not a promptness guarantee. The
   * watchdog covers the remaining case where shutdown itself wedges — a child
   * that ignores SIGTERM gets SIGKILLed, which loses the session DELETE too. */
  const exitAfterShutdown = (code: number): void => {
    const watchdog = setTimeout(() => {
      process.stderr.write("net MCP stdio bridge shutdown timed out; exiting\n");
      process.exit(code);
    }, NET_MCP_STDIO_HARD_EXIT_MS);
    watchdog.unref();
    void shutdown().finally(() => {
      clearTimeout(watchdog);
      process.exit(code);
    });
  };

  // The dispatcher serializes only the pre-session prefix. After initialize,
  // independent MCP requests run concurrently so woo_wait cannot block pings.
  transport.onmessage = (message) => {
    void dispatcher.dispatch(message);
  };
  transport.onerror = (error) => {
    process.stderr.write(`net MCP stdio transport error: ${errorMessage(error)}\n`);
  };
  // Stdin EOF means the client is gone: nothing further can be served, and
  // nothing is left to report to, so a clean exit is the correct response.
  process.stdin.once("end", () => exitAfterShutdown(0));
  process.once("SIGINT", () => exitAfterShutdown(130));
  process.once("SIGTERM", () => exitAfterShutdown(143));
  await transport.start();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  process.stderr.write(`mcp stdio failed: ${errorMessage(error)}\n`);
  process.exit(1);
});
