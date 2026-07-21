// Net MCP stdio entry point.
//
// Run `npm run dev` first, then configure an MCP client to spawn this command.
// The process is intentionally only a JSON-RPC transport bridge; all tool and
// turn behavior remains in the Net gateway's `/net-api/mcp` implementation.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { NetMcpStdioDispatcher } from "./net-stdio-dispatcher";
import { NetMcpStdioProxy } from "./net-stdio-proxy";

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
  const proxy = new NetMcpStdioProxy({
    endpoint,
    token,
    onNotification: (message) => transport.send(message),
    onError: reportError
  });
  const dispatcher = new NetMcpStdioDispatcher(
    proxy,
    (message) => transport.send(message),
    reportError
  );
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await dispatcher.idle();
    await proxy.close();
    await transport.close();
  };

  // The dispatcher serializes only the pre-session prefix. After initialize,
  // independent MCP requests run concurrently so woo_wait cannot block pings.
  transport.onmessage = (message) => {
    void dispatcher.dispatch(message);
  };
  transport.onerror = (error) => {
    process.stderr.write(`net MCP stdio transport error: ${errorMessage(error)}\n`);
  };
  process.stdin.once("end", () => void shutdown());
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(130)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(143)));
  await transport.start();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  process.stderr.write(`mcp stdio failed: ${errorMessage(error)}\n`);
  process.exit(1);
});
