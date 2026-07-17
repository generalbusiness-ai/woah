import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startNetDevBackend, type NetDevBackend } from "../src/server/net-dev";

type ToolResult = {
  isError?: boolean;
  structuredContent?: {
    result?: unknown;
    error?: unknown;
  };
};

function assertOk(name: string, result: ToolResult): ToolResult {
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.structuredContent ?? result)}`);
  return result;
}

/**
 * Exercise the default stdio command through a real workerd Net backend.
 * Supplying WOO_MCP_URL and WOO_MCP_TOKEN reuses an already-running `npm run
 * dev`; otherwise the smoke owns an isolated temporary backend. Either way,
 * no in-process WooWorld or classic MCP gateway participates.
 */
async function main(): Promise<void> {
  let backend: NetDevBackend | null = null;
  let persistDir: string | null = null;
  let endpoint = process.env.WOO_MCP_URL;
  let token = process.env.WOO_MCP_TOKEN;
  if (!endpoint || !token) {
    persistDir = mkdtempSync(join(tmpdir(), "woo-net-stdio-"));
    backend = await startNetDevBackend({ persistDir, quiet: true });
    endpoint = `${backend.baseUrl}/net-api/mcp`;
    token = backend.apiKey;
  }

  const client = new Client({ name: "woo-net-stdio-smoke", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp/net-stdio.ts"],
    cwd: process.cwd(),
    env: { ...process.env, WOO_MCP_URL: endpoint, WOO_MCP_TOKEN: token },
    stderr: "pipe"
  });
  const stderrChunks: Buffer[] = [];
  transport.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const listedTools = [...listed.tools];
    let nextCursor = listed.nextCursor;
    for (let page = 1; nextCursor && page < 16; page += 1) {
      const next = await client.listTools({ cursor: nextCursor });
      listedTools.push(...next.tools);
      nextCursor = next.nextCursor;
    }
    if (nextCursor) throw new Error("Net MCP tools/list exceeded the bounded 16-page smoke limit");
    const names = listedTools.map((tool) => tool.name).sort();
    if (new Set(names).size !== names.length) throw new Error("Net MCP tools/list returned duplicate names across pages");
    const stable = ["woo_call", "woo_list_reachable_tools", "woo_wait"];
    if (!stable.every((name) => names.includes(name)) || !names.includes("the_chatroom__look")) {
      throw new Error(`Net MCP omitted stable or contextual tools: ${JSON.stringify(names)}`);
    }

    const reachable = assertOk("woo_list_reachable_tools", await client.callTool({
      name: "woo_list_reachable_tools",
      arguments: { scope: "all", limit: 200 }
    }) as ToolResult);
    const tools = (reachable.structuredContent?.result as { tools?: Array<{ object?: string; verb?: string }> } | undefined)?.tools ?? [];
    if (!tools.some((tool) => /^guest_/.test(tool.object ?? ""))) {
      throw new Error(`Net MCP did not resolve its carried actor: ${JSON.stringify(tools.slice(0, 12))}`);
    }

    const planned = assertOk("woo_call command_plan", await client.callTool({
      name: "woo_call",
      arguments: { object: "the_chatroom", verb: "command_plan", args: ["look"] }
    }) as ToolResult);
    const command = planned.structuredContent?.result as { ok?: boolean; target?: string; verb?: string; args?: unknown[] } | undefined;
    if (!command?.ok || !command.target || !command.verb) {
      throw new Error(`command_plan did not return an executable command: ${JSON.stringify(command)}`);
    }
    assertOk("woo_call planned look", await client.callTool({
      name: "woo_call",
      arguments: { object: command.target, verb: command.verb, args: command.args ?? [] }
    }) as ToolResult);
    assertOk("woo_wait", await client.callTool({
      name: "woo_wait",
      arguments: { timeout_ms: 0, limit: 10 }
    }) as ToolResult);

    console.log(`Net MCP stdio smoke passed (${stable.length} stable + ${listedTools.length - stable.length} contextual tools)`);
  } catch (error) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    if (stderr) console.error(stderr);
    throw error;
  } finally {
    await client.close().catch(() => undefined);
    await backend?.stop().catch(() => undefined);
    if (persistDir) rmSync(persistDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
