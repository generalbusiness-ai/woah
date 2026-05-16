import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type ToolResult = {
  isError?: boolean;
  structuredContent?: {
    result?: unknown;
    observations?: Array<Record<string, unknown>>;
    error?: unknown;
  };
};

const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function assertOk(name: string, result: ToolResult): ToolResult {
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.structuredContent ?? result)}`);
  return result;
}

function observations(result: ToolResult): Array<Record<string, unknown>> {
  const value = result.structuredContent?.observations;
  return Array.isArray(value) ? value : [];
}

function hasObservation(result: ToolResult, type: string): boolean {
  return observations(result).some((observation) => observation.type === type);
}

async function main(): Promise<void> {
  const client = new Client({ name: "woo-local-mcp-smoke", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp/stdio.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      WOO_MCP_TOKEN: `guest:stdio-smoke-${runId}`
    },
    stderr: "pipe"
  });
  const stderrChunks: Buffer[] = [];
  transport.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    for (const required of ["woo_list_reachable_tools", "woo_call", "woo_focus", "woo_unfocus", "woo_wait"]) {
      if (!names.includes(required)) throw new Error(`missing MCP tool: ${required}`);
    }

    assertOk("woo_list_reachable_tools", await client.callTool({
      name: "woo_list_reachable_tools",
      arguments: { scope: "active", include_schema: true, limit: 20 }
    }) as ToolResult);

    const looked = assertOk("woo_call look", await client.callTool({
      name: "woo_call",
      arguments: { object: "the_chatroom", verb: "look", args: [] }
    }) as ToolResult);
    if (!hasObservation(looked, "looked")) throw new Error("woo_call look returned no looked observation");

    const said = assertOk("woo_call say", await client.callTool({
      name: "woo_call",
      arguments: { object: "the_chatroom", verb: "say", args: [`stdio MCP smoke ${runId}`] }
    }) as ToolResult);
    if (!hasObservation(said, "said")) throw new Error("woo_call say returned no said observation");

    assertOk("woo_focus", await client.callTool({
      name: "woo_focus",
      arguments: { target: "the_pinboard" }
    }) as ToolResult);

    assertOk("woo_list_reachable_tools focused", await client.callTool({
      name: "woo_list_reachable_tools",
      arguments: { scope: "focus", query: "pinboard", limit: 20 }
    }) as ToolResult);

    const refreshed = await client.listTools();
    const dynamicLook = refreshed.tools.find((tool) => tool.name.endsWith("__look"));
    if (!dynamicLook) throw new Error("no dynamic look tool available after focus");
    assertOk(`dynamic ${dynamicLook.name}`, await client.callTool({
      name: dynamicLook.name,
      arguments: {}
    }) as ToolResult);

    assertOk("woo_unfocus", await client.callTool({
      name: "woo_unfocus",
      arguments: { target: "the_pinboard" }
    }) as ToolResult);

    assertOk("woo_wait", await client.callTool({
      name: "woo_wait",
      arguments: { timeout_ms: 0, limit: 10 }
    }) as ToolResult);

    console.log(`MCP stdio smoke passed (${listed.tools.length} initial tools, ${refreshed.tools.length} focused tools)`);
  } catch (err) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    if (stderr) console.error(stderr);
    throw err;
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error((err as Error).stack ?? String(err));
  process.exit(1);
});
