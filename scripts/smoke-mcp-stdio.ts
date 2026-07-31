import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
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
 * The collapsed profile (mcp.md §M9) over the same bridge and backend.
 *
 * A SECOND stdio child, because the profile is chosen by the environment the
 * client spawns the bridge with — running it in-process would prove the
 * gateway logic the fake-DO lane already covers, and skip the only part this
 * lane can add.
 *
 * Returns the contextual tool count so the caller can print both surfaces.
 */
async function runCollapsedSession(endpoint: string, token: string): Promise<number> {
  const client = new Client({ name: "woo-net-stdio-smoke-collapsed", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp/net-stdio.ts"],
    cwd: process.cwd(),
    env: { ...process.env, WOO_MCP_URL: endpoint, WOO_MCP_TOKEN: token, WOO_MCP_PROFILE: "collapsed" },
    stderr: "pipe"
  });
  const stderrChunks: Buffer[] = [];
  transport.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    if (listed.nextCursor) throw new Error("collapsed profile should fit one tools/list page");
    // The universal verb is one bare tool; the cockatoo's own `look` shadows
    // it and stays object-qualified; the mounts contribute nothing.
    for (const required of ["look", "say", "go", "woo_read"]) {
      if (!names.includes(required)) throw new Error(`collapsed profile omitted ${required}: ${JSON.stringify(names)}`);
    }
    if (!names.includes("the_cockatoo__look")) {
      throw new Error(`collapsed profile dropped a shadowing catalog verb: ${JSON.stringify(names)}`);
    }
    for (const folded of ["north", "southeast", "out"]) {
      if (names.includes(folded)) throw new Error(`collapsed profile advertised the folded ${folded}`);
    }
    if (names.some((name) => name.startsWith("the_outline__") || name.startsWith("the_dubspace__"))) {
      throw new Error(`collapsed profile projected a closed mount: ${JSON.stringify(names)}`);
    }

    // Resources: the listing is constant, and the exit record carries the
    // traversability category the classic surface never had.
    const resources = await client.listResources();
    const uris = resources.resources.map((entry) => entry.uri).sort();
    if (uris.join(",") !== "woo://here,woo://here/exits,woo://here/roster,woo://me,woo://me/inventory") {
      throw new Error(`unexpected resource listing: ${JSON.stringify(uris)}`);
    }
    const templates = await client.listResourceTemplates();
    if (!templates.resourceTemplates.some((entry) => entry.uriTemplate === "woo://object/{id}")) {
      throw new Error("resource templates omitted woo://object/{id}");
    }
    const exits = await client.readResource({ uri: "woo://here/exits" });
    const first = exits.contents[0] as { text?: string } | undefined;
    const payload = JSON.parse(first?.text ?? "{}") as { exits?: Array<{ id: string; traversable: boolean }> };
    const south = payload.exits?.find((exit) => exit.id === "exit_living_room_south");
    if (!south) throw new Error(`exit record missing the seeded pseudo-exit: ${first?.text}`);
    if (south.traversable !== false) throw new Error("the seeded pseudo-exit is reported traversable");

    // The universal tool dispatches, and reaches the receiver it is given.
    const looked = assertOk("collapsed look(the_mug)", await client.callTool({
      name: "look",
      arguments: { target: "the_mug" }
    }) as ToolResult);
    if (!JSON.stringify(looked).toLowerCase().includes("mug")) {
      throw new Error(`collapsed look did not reach its receiver: ${JSON.stringify(looked).slice(0, 400)}`);
    }
    return names.filter((name) => !name.startsWith("woo_")).length;
  } catch (error) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    if (stderr) console.error(stderr);
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
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
  let listChangedCount = 0;
  let wakeListChanged: (() => void) | null = null;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChangedCount += 1;
    wakeListChanged?.();
    wakeListChanged = null;
  });
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
      arguments: { scope: "active", limit: 200 }
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

    // The official SDK must receive the standard notification through the
    // stdio bridge's HTTP GET/SSE carrier, then observe a genuinely different
    // descriptor set after re-listing in the destination room.
    const beforeMoveNotifications = listChangedCount;
    const changed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for notifications/tools/list_changed")), 5_000);
      wakeListChanged = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    assertOk("woo_call southeast", await client.callTool({
      name: "woo_call",
      arguments: { object: "the_chatroom", verb: "southeast", args: [] }
    }) as ToolResult);
    await changed;
    if (listChangedCount !== beforeMoveNotifications + 1) {
      throw new Error(`Net MCP emitted ${listChangedCount - beforeMoveNotifications} list_changed notifications for one move`);
    }
    const movedTools = await client.listTools();
    const movedNames = movedTools.tools.map((tool) => tool.name);
    if (!movedNames.some((name) => name.startsWith("the_deck__")) || movedNames.includes("the_cockatoo__squawk")) {
      throw new Error(`Net MCP re-list did not reflect the destination context: ${JSON.stringify(movedNames)}`);
    }

    // ---- the collapsed profile, through the same bridge and backend -------
    // The fake-DO lane proves the projection's rules; this proves the OPT-IN
    // reaches them: a real MCP SDK client, a real stdio child process reading
    // WOO_MCP_PROFILE from its environment, and real workerd DOs behind it.
    const collapsedCount = await runCollapsedSession(endpoint, token);

    console.log(
      `Net MCP stdio smoke passed (${stable.length} stable + ${listedTools.length - stable.length} contextual tools; `
      + `collapsed profile: ${collapsedCount} contextual tools)`
    );
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
