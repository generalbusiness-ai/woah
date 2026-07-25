// Blocker 4: the production-shaped programmer lifecycle, end to end over the real
// Net MCP + turn doorways (fake-DO lane). Unlike net-mcp-programmer.test.ts (which
// hand-builds unanchored $wiz agents and stops at source inspection), this uses a
// REAL create_agent-provisioned, human-owned, ANCHORED programmer agent with a
// self-routing n1_ key, and walks: provision → create (into the author's cluster)
// → install dry-run → install → version conflict → INVOKE (via the eval surface)
// → cold-gateway reconstruction (invoke from the durable scope). The real
// tools/list_changed notification is proven separately in net-demote-lifecycle.
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

const SECRET = "net-prog-lifecycle-secret";
const EPOCH = "cat-net-prog-lifecycle-1";

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

describe("Net programmer lifecycle (production-shaped, fake-DO lane)", () => {
  it("provision → create → dry-run → install → version conflict → invoke → cold reconstruction", async () => {
    // --- (1) Provisioning: a REAL create_agent-provisioned anchored programmer. ---
    const old = createWorld();
    const start = await old.beginSignup("life@woo.dev", "password123");
    const human = start.verification_token ? (old.verifySignup(start.verification_token).actor as string) : "";
    const account = old.propOrNull(human, "account") as string;
    old.setProp(account, "programmer_grant_quota", 10);
    old.ensureApiKey("$wiz", human, "human-key", "human-secret", "human");
    const prov = (await old.directCall("prov", human, human, "create_agent", ["ProgBot", "", true])) as unknown as { result: { actor_id: string } };
    const agent = prov.result.actor_id;
    const agentKey = old.createApiKeyForOwner(human, agent, "bot");
    const agentToken = `apikey:${agentKey.id}:${agentKey.secret}`;
    expect(old.object(agent).flags.programmer, "provisioned agent is not a programmer").toBe(true);
    expect(old.object(agent).anchor, "provisioned agent is not anchored to the human").toBe(human);

    // --- wire the Net DOs ---
    const cells = cellsFromSerialized(old.exportWorld());
    const partitions = partitionCells(cells);
    const relations = partitionInstallRelations(cells);
    partitions.set(CATALOG_SCOPE, [...(partitions.get(CATALOG_SCOPE) ?? []), netActivationCell(EPOCH)]);

    const states: Array<ReturnType<typeof netState>> = [];
    const scopeDOs = new Map<string, NetScopeDO>();
    const gateways: NetGatewayDO[] = [];
    let auditDO: NetAuditDO;
    const resolve = (destination: string) => {
      if (destination.startsWith("scope:")) { const i = scopeDOs.get(destination.slice("scope:".length)); if (i) return i; }
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

    const mcpSession = async (gateway: NetGatewayDO, token: string) => {
      const rpc = async (b: unknown, h: Record<string, string> = {}) => {
        const r = await gateway.fetch(new Request("https://do/net-api/mcp", { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(b) }));
        const t = await r.text();
        return { status: r.status, headers: r.headers, body: t ? JSON.parse(t) as Record<string, any> : null };
      };
      const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { "mcp-token": token });
      const sid = init.headers.get("mcp-session-id") as string;
      if (sid) await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": sid });
      let nextId = 2;
      const list = async () => {
        const r = await rpc({ jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} }, { "mcp-session-id": sid });
        return (r.body?.result?.tools ?? []).map((t: any) => t.name) as string[];
      };
      const call = async (name: string, args: unknown) =>
        (await rpc({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }, { "mcp-session-id": sid })).body;
      return { sid, list, call };
    };
    const result = (r: any) => r?.result?.structuredContent?.result ?? {};
    const errored = (r: any) => r?.result?.isError === true || r?.error != null;

    const p = agent.replace(/^\$/, "").replace(/[^a-zA-Z0-9_]/g, "_");

    // --- (2) The provisioned agent's surface is live over Net MCP. ---
    const warm = freshGateway();
    const mcp = await mcpSession(warm, agentToken);
    expect(mcp.sid, "provisioned agent MCP session did not open").toBeTruthy();
    const baseline = await mcp.list();
    expect(baseline, `${p}__install_verb missing`).toContain(`${p}__install_verb`);
    expect(baseline, `${p}__create missing`).toContain(`${p}__create`);

    // --- (3) create an object INTO the author's inventory (in context, and
    // co-located in the author's cluster so install stays a local write). ---
    const created = await mcp.call(`${p}__create`, { parent: "$thing", opts: { name: "Widget", location: agent } });
    expect(errored(created), JSON.stringify(created).slice(0, 500)).toBe(false);
    const widget = result(created).id as string;
    expect(widget, JSON.stringify(created).slice(0, 500)).toBeTruthy();
    expect(widget.startsWith("obj_"), widget).toBe(true);
    await settleAll();

    // --- (4) install dry-run: predicts slot/version, mutates nothing. ---
    const dry = await mcp.call(`${p}__install_verb`, { id: widget, descriptor: "ping", source: "verb :ping() rxd { return 7; }", opts: { dry_run: true } });
    expect(errored(dry), JSON.stringify(dry).slice(0, 500)).toBe(false);
    expect(result(dry).ok).toBe(true);
    expect(result(dry).dry_run).toBe(true);

    // --- (5) real install: version 1. ---
    const installed = await mcp.call(`${p}__install_verb`, { id: widget, descriptor: "ping", source: "verb :ping() rxd { return 7; }", opts: {} });
    expect(errored(installed), JSON.stringify(installed).slice(0, 500)).toBe(false);
    expect(result(installed).ok).toBe(true);
    expect(result(installed).version).toBe(1);
    await settleAll();

    // (An installed bytecode verb is invocable via woo_call but is not itself a
    // `tool_exposed` MCP tool, so it does not perturb the agent's tool digest;
    // the real tools/list_changed notification is proven for a surface change in
    // tests/worker/net-demote-lifecycle.test.ts.)

    // --- (6) version-conflict guard: expected_version mismatch refuses. ---
    const conflict = await mcp.call(`${p}__install_verb`, { id: widget, descriptor: "ping", source: "verb :ping() rxd { return 9; }", opts: { expected_version: 99 } });
    const conflictErr = errored(conflict) || (result(conflict)?.diagnostics?.length ?? 0) > 0;
    expect(conflictErr, `version conflict not refused: ${JSON.stringify(conflict).slice(0, 400)}`).toBe(true);

    // --- (7) INVOKE the installed verb. An authored bytecode verb is not itself
    // a `tool_exposed` MCP tool, so it is driven through the programmer `eval`
    // surface (a superset of woo_call) under the agent's own authority — the
    // production shape for scripting authored code over Net MCP. `contents(actor)`
    // resolves the widget in the agent's inventory. ---
    const invokeSrc = "let o = contents(actor)[1]; return o:ping();";
    const invoked = await mcp.call(`${p}__eval`, { source: invokeSrc, opts: { mode: "stmts" } });
    expect(errored(invoked), `invoke failed: ${JSON.stringify(invoked).slice(0, 500)}`).toBe(false);
    expect(result(invoked).ok, JSON.stringify(invoked).slice(0, 500)).toBe(true);
    expect(result(invoked).value).toBe(7);

    // --- (8) COLD gateway reconstruction: a fresh gateway invokes the authored
    // verb from the durable scope, proving the authored state is durable. ---
    const cold = freshGateway();
    const coldMcp = await mcpSession(cold, agentToken);
    expect(coldMcp.sid, "cold agent MCP session did not open").toBeTruthy();
    const coldInvoke = await coldMcp.call(`${p}__eval`, { source: invokeSrc, opts: { mode: "stmts" } });
    expect(errored(coldInvoke), `cold invoke failed: ${JSON.stringify(coldInvoke).slice(0, 500)}`).toBe(false);
    expect(result(coldInvoke).value, "authored verb did not reconstruct on a cold gateway").toBe(7);

    for (const st of states) st.close();
  });
});
