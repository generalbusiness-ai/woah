// Finding #4: prove Net demotion is genuinely reconstructible, not just observed
// on the warm gateway that committed it. A human promotes then demotes its owned,
// anchored agent over /net-api/turn; we verify the agent's programmer tools appear
// after promote, then after demote: (a) a re-list on the SAME session drops them,
// (b) a stale call to a removed tool refuses, and (c) a COLD gateway reconstructed
// from the same durable scope also shows no programmer tools — resolved via the
// agent's self-routing n1_ key (its cells live in the human's cluster). Fake-DO lane.
import { describe, expect, it } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetAuditDO } from "../../src/worker/net/audit-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { createWorld } from "../../src/core/bootstrap";
import { cellsFromSerialized } from "../../src/net/bridge";
import { netActivationCell, partitionInstallRelations } from "../../src/net/install";
import { CATALOG_SCOPE, partitionCells } from "../../src/net/topology";
import { signInternalRequest } from "../../src/worker/internal-auth";

const SECRET = "net-demote-test-secret";
const EPOCH = "cat-net-demote-1";

function netState(name: string) {
  const fake = new FakeDurableObjectState(name);
  const deferred: Array<Promise<unknown>> = [];
  const state: NetScopeDurableState & NetGatewayDurableState = {
    id: fake.id,
    waitUntil: (p: Promise<unknown>) => { deferred.push(p); },
    storage: { sql: fake.storage.sql, transactionSync: fake.storage.transactionSync, setAlarm: () => {}, deleteAlarm: () => {} }
  };
  return { state, settle: async () => { while (deferred.length > 0) await deferred.shift(); }, close: () => fake.close() };
}

async function clientFetch(gateway: NetGatewayDO, path: string, token: string, body: unknown) {
  const resp = await gateway.fetch(new Request(`https://do${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  }));
  return { status: resp.status, body: (await resp.json()) as Record<string, any> };
}

describe("Net demotion lifecycle + cold reconstruction (fake-DO lane)", () => {
  it("promote then demote: same-session re-list drops the tools, stale call refuses, cold gateway shows none", async () => {
    const old = createWorld();
    const start = await old.beginSignup("demote@woo.dev", "password123");
    const human = start.verification_token ? (old.verifySignup(start.verification_token).actor as string) : "";
    const account = old.propOrNull(human, "account") as string;
    old.setProp(account, "programmer_grant_quota", 10);
    old.ensureApiKey("$wiz", human, "human-key", "human-secret", "human");
    // An anchored programmer agent (create_agent programmer:true) with a
    // self-routing n1_ key so a cold gateway resolves its home cluster.
    const prov = (await old.directCall("prov", human, human, "create_agent", ["ProgBot", "", true])) as unknown as { result: { actor_id: string } };
    const agent = prov.result.actor_id;
    const agentKey = old.createApiKeyForOwner(human, agent, "bot");
    const agentToken = `apikey:${agentKey.id}:${agentKey.secret}`;
    expect(old.object(agent).flags.programmer).toBe(true);

    const cells = cellsFromSerialized(old.exportWorld());
    const partitions = partitionCells(cells);
    const relations = partitionInstallRelations(cells);
    partitions.set(CATALOG_SCOPE, [...(partitions.get(CATALOG_SCOPE) ?? []), netActivationCell(EPOCH)]);

    const states: Array<ReturnType<typeof netState>> = [];
    const scopeDOs = new Map<string, NetScopeDO>();
    const gateways: NetGatewayDO[] = [];
    let auditDO: NetAuditDO;
    const resolve = (destination: string) => {
      if (destination.startsWith("scope:")) {
        const i = scopeDOs.get(destination.slice("scope:".length));
        if (i) return i;
      }
      if (destination.startsWith("gateway:")) return gateways[gateways.length - 1];
      if (destination === "audit:audit-0") return auditDO;
      throw new Error(`unresolvable ${destination}`);
    };
    const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve, NET_AUDIT_SHARDS: "1" };
    const auditState = netState("audit-0");
    auditDO = new NetAuditDO(auditState.state, { WOO_INTERNAL_SECRET: SECRET });
    states.push(auditState);
    for (const scope of partitions.keys()) {
      const st = netState(`scope-${scope}`);
      const instance = new NetScopeDO(st.state, scopeEnv);
      const req = new Request("https://do/net/seed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope, catalog_epoch: EPOCH, cells: partitions.get(scope) ?? [], relations: relations.get(scope) ?? [] }) });
      const seeded = await instance.fetch(await signInternalRequest(scopeEnv, req));
      expect(seeded.ok, `seed ${scope}`).toBe(true);
      states.push(st);
      scopeDOs.set(scope, instance);
    }
    const freshGateway = () => {
      const st = netState(`gateway-${gateways.length}`);
      states.push(st);
      const gw = new NetGatewayDO(st.state, { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve, NET_AUDIT_SHARDS: "1" } as NetGatewayEnv);
      gateways.push(gw);
      return gw;
    };
    const settleAll = async () => {
      for (const st of states) await st.settle();
      for (const s of scopeDOs.values()) await s.alarm();
      for (const st of states) await st.settle();
    };

    // An MCP session helper bound to one gateway.
    const mcpSession = async (gateway: NetGatewayDO, token: string) => {
      const rpc = async (b: unknown, h: Record<string, string> = {}) => {
        const r = await gateway.fetch(new Request("https://do/net-api/mcp", { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(b) }));
        const t = await r.text();
        return { status: r.status, headers: r.headers, body: t ? JSON.parse(t) as Record<string, any> : null };
      };
      const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { "mcp-token": token });
      const sid = init.headers.get("mcp-session-id") as string;
      if (sid) await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": sid });
      const list = async () => {
        const r = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-session-id": sid });
        return (r.body?.result?.tools ?? []).map((t: any) => t.name) as string[];
      };
      const call = async (name: string, args: unknown) =>
        rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } }, { "mcp-session-id": sid });
      return { sid, list, call };
    };

    const p = agent.replace(/^\$/, "").replace(/[^a-zA-Z0-9_]/g, "_");
    const installTool = `${p}__install_verb`;

    // --- Promote first (so demotion has something to remove) ---
    const warm = freshGateway();
    const humanToken = "apikey:human-key:human-secret";
    const minted = await clientFetch(warm, "/net-api/session", humanToken, { ttl_ms: 600_000 });
    expect(minted.status, JSON.stringify(minted.body)).toBe(200);
    const sid = minted.body.session as string;

    // The agent opens its MCP session BEFORE demotion (its surface is live).
    const agentMcp = await mcpSession(warm, agentToken);
    expect(agentMcp.sid, "agent MCP session did not open").toBeTruthy();
    const beforeDemote = await agentMcp.list();
    expect(beforeDemote, `${installTool} missing pre-demote`).toContain(installTool);

    // --- Demote over /net-api/turn ---
    const demoted = await clientFetch(warm, "/net-api/turn", humanToken, { target: human, verb: "demote_agent_from_programmer", args: [agent], session: sid });
    expect(demoted.status, JSON.stringify(demoted.body)).toBe(200);
    expect(demoted.body?.reply?.status, JSON.stringify(demoted.body).slice(0, 600)).toBe("accepted");
    expect(demoted.body?.error, `demote errored: ${JSON.stringify(demoted.body?.error)}`).toBeUndefined();
    await settleAll();

    // (a) Same-session re-list drops the programmer tools.
    const afterDemote = await agentMcp.list();
    expect(afterDemote, `${installTool} survived demotion in re-list`).not.toContain(installTool);

    // (b) A stale call to the removed tool refuses (not silently accepted).
    const stale = await agentMcp.call(installTool, { id: agent, descriptor: "x", source: "verb :x() rxd { return 1; }", opts: {} });
    const staleErr = stale.body?.result?.isError === true || stale.body?.error != null;
    expect(staleErr, `stale call to ${installTool} was not refused: ${JSON.stringify(stale.body).slice(0, 400)}`).toBe(true);

    // (c) A COLD gateway reconstructed from the same durable scope shows no
    // programmer tools — proving the removal is durable, not warm-view-only.
    const cold = freshGateway();
    const coldMcp = await mcpSession(cold, agentToken);
    expect(coldMcp.sid, "cold agent MCP session did not open (routed-key home resolution)").toBeTruthy();
    const coldTools = await coldMcp.list();
    expect(coldTools, `${installTool} resurrected on a cold gateway`).not.toContain(installTool);

    for (const st of states) st.close();
  });
});
