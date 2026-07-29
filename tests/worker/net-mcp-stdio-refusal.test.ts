// The load-bearing test for the /net-api/mcp envelope (mcp.md §M1.2).
//
// It drives the REAL stack end to end: the official MCP SDK client, over the
// real stdio bridge process (`src/mcp/net-stdio.ts` under tsx), over HTTP, into
// the real NetGatewayDO. Nothing here is a stand-in for the thing it tests.
//
// That fidelity is the point. The defect was invisible at every smaller scale:
// the gateway "returned a 401 with the reason in the body" and a gateway-only
// unit test reading that body would have passed. What actually reached the
// agent was decided one layer up — the bridge validated the non-JSON-RPC body
// against the MCP message schema, the validation failed, and the catch replaced
// "apikey not found or revoked" with roughly 3 kB of Zod union report. So the
// assertion that matters is on what the CLIENT receives, and only a test that
// owns the whole chain can make it.
//
// The bad-token path is chosen deliberately: it is the first thing every local
// agent hits when its credential is wrong or has been rotated, which is exactly
// when a legible diagnosis is worth the most.
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { createWorld } from "../../src/core/bootstrap";
import { exportIdentity, importIdentity } from "../../src/net/identity";
import { planNetInstall } from "../../src/net/install";
import { NetGatewayDO, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { closeQuiescent, quiescentNetState as netState, settleAll as settleHosts, type QuiescentHost } from "./quiescent-do";

const SECRET = "net-mcp-stdio-refusal-secret";

/** Hop-by-hop and framing headers belong to the node server, not the request
 * the DO sees. Forwarding them builds a Request that disagrees with its body. */
const HOP_BY_HOP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "content-length", "upgrade"]);

/**
 * A real HTTP front door for the fake-DO gateway.
 *
 * The bridge speaks HTTP and nothing else, so the only way to drive the real
 * bridge against the real gateway is to give the gateway a socket. Streaming
 * the response body through matters: the notification carrier is SSE, and a
 * buffering adapter would silently change the transport's behaviour.
 */
async function serveGateway(gateway: () => NetGatewayDO): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (HOP_BY_HOP.has(name)) continue;
        if (typeof value === "string") headers.set(name, value);
        else if (Array.isArray(value)) for (const one of value) headers.append(name, one);
      }
      const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
      const response = await gateway().fetch(new Request(`https://do${req.url ?? "/"}`, {
        method: req.method,
        headers,
        ...(body && req.method !== "GET" && req.method !== "HEAD" ? { body } : {})
      }));
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      const reader = response.body?.getReader();
      if (reader) {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      }
      res.end();
    })().catch((error) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/net-api/mcp`,
    stop: async () => await new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

async function fixture() {
  const old = createWorld();
  const actor = old.auth("guest:stdio-refusal").actor;
  old.ensureApiKey("$wiz", actor, "stdio-key", "stdio-secret", "stdio");
  const identity = exportIdentity(old.exportWorld());
  const plan = await planNetInstall({ graft: async (fresh) => { importIdentity(fresh, identity); } });

  const states: QuiescentHost[] = [];
  const scopeDOs = new Map<string, NetScopeDO>();
  let gateway: NetGatewayDO;
  const resolve = (destination: string) => {
    if (destination === "gateway:net-api") return gateway;
    if (destination.startsWith("scope:")) {
      const instance = scopeDOs.get(destination.slice("scope:".length));
      if (instance) return instance;
    }
    throw new Error(`unresolvable destination ${destination}`);
  };
  const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve };
  for (const [scope, cells] of plan.partitions) {
    const st = netState(`scope-${scope}`);
    const instance = new NetScopeDO(st.state, scopeEnv);
    const seeded = await instance.fetch(await signInternalRequest(scopeEnv, new Request("https://do/net/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, catalog_epoch: plan.epoch, cells, relations: plan.relations.get(scope) ?? [] })
    })));
    expect(seeded.ok, `seed ${scope}`).toBe(true);
    states.push(st);
    scopeDOs.set(scope, instance);
  }
  const gatewayState = netState("gateway-net-api");
  states.push(gatewayState);
  gateway = new NetGatewayDO(gatewayState.state, {
    WOO_INTERNAL_SECRET: SECRET,
    NET_RESOLVE: resolve,
    NET_GATEWAY_SELF: "gateway:net-api"
  } as NetGatewayEnv);

  const served = await serveGateway(() => gateway);
  return {
    endpoint: served.url,
    close: async () => {
      await served.stop();
      await settleHosts(states);
      await closeQuiescent(states);
    }
  };
}

/** Connect a real bridge child process, capturing its stderr. */
async function connectBridge(endpoint: string, token: string): Promise<{
  connect: () => Promise<void>;
  stderr: () => string;
  close: () => Promise<void>;
}> {
  const client = new Client({ name: "woo-net-stdio-refusal", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp/net-stdio.ts"],
    cwd: process.cwd(),
    env: { ...process.env, WOO_MCP_URL: endpoint, WOO_MCP_TOKEN: token } as Record<string, string>,
    stderr: "pipe"
  });
  const chunks: Buffer[] = [];
  transport.stderr?.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  return {
    connect: async () => await client.connect(transport),
    stderr: () => Buffer.concat(chunks).toString("utf8"),
    close: async () => { await client.close().catch(() => undefined); }
  };
}

describe("Net MCP stdio bridge: a refused credential reaches the client intact", () => {
  it("surfaces the woo refusal, not a schema-validation dump", async () => {
    const f = await fixture();
    const bridge = await connectBridge(f.endpoint, "apikey:no-such-key:whatever");
    try {
      const failure = await bridge.connect().then(
        () => null,
        (error: unknown) => error as Error & { code?: number; data?: { code?: string; http_status?: number } }
      );
      expect(failure, "a bad apikey connected successfully").not.toBeNull();
      const error = failure as Error & { code?: number; data?: Record<string, unknown> };

      // THE assertion. Before the fix this read (verbatim from the deployed
      // worker): "Net MCP transport failed: [ { "code": "invalid_union", ...
      // }, ... ]" — about 3 kB of Zod, with the server's sentence nowhere in
      // it. The agent's whole diagnosis was the parser's opinion of the body.
      expect(error.message).toContain("apikey not found or revoked");
      expect(error.message).not.toMatch(/invalid_union|invalid_literal|zod|Expected .* received/i);
      // JSON-RPC asks the message to be one concise sentence, and a terminal
      // is where it lands.
      expect(error.message.length).toBeLessThan(200);

      // The woo vocabulary survives the trip in machine-readable form, so a
      // client can branch on the refusal rather than string-match it.
      expect(error.code).toBe(-32000);
      expect(error.data?.code).toBe("E_NOSESSION");
      expect(error.data?.http_status).toBe(401);
      expect((error.data?.detail as { reason?: string } | undefined)?.reason).toBe("unknown_or_revoked");

      // A refusal is not a bridge malfunction: nothing should have been
      // reported as a transport-level error on stderr.
      expect(bridge.stderr()).not.toMatch(/bridge error|invalid_union/);
    } finally {
      await bridge.close();
      await f.close();
    }
  }, 60_000);
});
