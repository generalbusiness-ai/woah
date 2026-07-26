// Step 2c: a supported Net promote/demote path. A human, its account, and its
// owned agent co-locate in one authority cluster (2a); the provisioning audit
// is the commit record, not a catalog write (2b); the programmer flag commits
// through the object_lineage lineage seam; and promote/demote are tracked
// native primitives. Driven over the real /net-api/turn doorway. Fake-DO lane.
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

const SECRET = "net-promote-test-secret";
const EPOCH = "cat-net-promote-1";

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

async function clientFetch(
  gateway: NetGatewayDO,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {}
): Promise<{ status: number; body: Record<string, any> }> {
  const headers = new Headers();
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  const request = method === "GET"
    ? new Request(`https://do${path}`, { headers })
    : new Request(`https://do${path}`, { method, headers: (headers.set("content-type", "application/json"), headers), body: JSON.stringify(opts.body ?? {}) });
  const response = await gateway.fetch(request);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

describe("Net promote/demote over /net-api/turn (fake-DO lane)", () => {
  it("a human promotes then demotes its owned agent; the flag commits through the lineage seam and the surface follows", async () => {
    const old = createWorld();
    const start = await old.beginSignup("promote@woo.dev", "password123");
    const verify = old.verifySignup(start.verification_token);
    const human = verify.actor as string;
    const account = old.propOrNull(human, "account") as string;
    old.setProp(account, "programmer_grant_quota", 10);
    old.ensureApiKey("$wiz", human, "promo-human-key", "promo-human-secret", "human");
    const prov = (await old.directCall("prov", human, human, "create_agent", ["ProbBot", "", false])) as any;
    const agent = prov.result.actor_id as string;
    old.ensureApiKey("$wiz", agent, "promo-agent-key", "promo-agent-secret", "agent");
    expect(old.object(agent).flags.programmer ?? false).toBe(false);
    expect(old.object(agent).anchor).toBe(human);

    const cells = cellsFromSerialized(old.exportWorld());
    const partitions = partitionCells(cells);
    const relations = partitionInstallRelations(cells);
    partitions.set(CATALOG_SCOPE, [...(partitions.get(CATALOG_SCOPE) ?? []), netActivationCell(EPOCH)]);
    const clusterScope = `cluster:${human}`;
    expect([...partitions.keys()]).toEqual(expect.arrayContaining([clusterScope, CATALOG_SCOPE]));

    const states: Array<ReturnType<typeof netState>> = [];
    const scopeDOs = new Map<string, NetScopeDO>();
    let gateway: NetGatewayDO;
    let auditDO: NetAuditDO;
    const resolve = (destination: string) => {
      if (destination.startsWith("scope:")) {
        const i = scopeDOs.get(destination.slice("scope:".length));
        if (i) return i;
      }
      if (destination.startsWith("gateway:")) return gateway;
      if (destination === "audit:audit-0") return auditDO;
      throw new Error(`unresolvable ${destination}`);
    };
    const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve, NET_AUDIT_SHARDS: "1" };
    const auditState = netState("audit-0");
    auditDO = new NetAuditDO(auditState.state, { WOO_INTERNAL_SECRET: SECRET });
    states.push(auditState);
    for (const scope of [clusterScope, CATALOG_SCOPE]) {
      const st = netState(`scope-${scope}`);
      const instance = new NetScopeDO(st.state, scopeEnv);
      const req = new Request("https://do/net/seed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope, catalog_epoch: EPOCH, cells: partitions.get(scope) ?? [], relations: relations.get(scope) ?? [] }) });
      const seeded = await instance.fetch(await signInternalRequest(scopeEnv, req));
      expect(seeded.ok, `seed ${scope}`).toBe(true);
      states.push(st);
      scopeDOs.set(scope, instance);
    }
    const gwState = netState("gateway-net-api");
    states.push(gwState);
    gateway = new NetGatewayDO(gwState.state, { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve, NET_AUDIT_SHARDS: "1" } as NetGatewayEnv);
    const settleAll = async () => {
      for (const st of states) await st.settle();
      for (const s of scopeDOs.values()) await s.alarm();
      for (const st of states) await st.settle();
    };

    const humanToken = "apikey:promo-human-key:promo-human-secret";
    const minted = await clientFetch(gateway, "POST", "/net-api/session", { token: humanToken, body: { ttl_ms: 600_000 } });
    expect(minted.status, JSON.stringify(minted.body)).toBe(200);
    const sid = minted.body.session as string;

    const promoted = await clientFetch(gateway, "POST", "/net-api/turn", {
      token: humanToken,
      body: { target: human, verb: "promote_agent_to_programmer", args: [agent], session: sid }
    });
    expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
    expect(promoted.body?.reply?.status, JSON.stringify(promoted.body).slice(0, 600)).toBe("accepted");
    // A verb that THREW (e.g. E_QUOTA_EXCEEDED when the account quota is
    // unwarmed and reads back as the class default 0) still commits its
    // effect-less transcript and returns "accepted". Assert the verb SUCCEEDED
    // — no error field, truthy result — so a silent authority-warming
    // regression cannot pass this test on protocol acceptance alone.
    expect(promoted.body?.error, `promote errored: ${JSON.stringify(promoted.body?.error)}`).toBeUndefined();
    expect(promoted.body?.result).toBe(true);
    await settleAll();

    // The agent now resolves its programmer tools over the Net MCP resolver:
    // both the flag (lineage seam) and the surface (feature) committed durably.
    // A FRESH gateway reconstructs the agent's feature chain from the durable
    // scope (gate 5: cold gateway reconstruction) — the promoting gateway's own
    // view is not subscribed to the agent and would be stale.
    const agentTools = async () => {
      const r = async (body: unknown, headers: Record<string, string> = {}) => {
        const resp = await gateway.fetch(new Request("https://do/net-api/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
        const t = await resp.text();
        return { status: resp.status, headers: resp.headers, body: t ? JSON.parse(t) as Record<string, any> : null };
      };
      const init = await r({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { "mcp-token": "apikey:promo-agent-key:promo-agent-secret" });
      const s = init.headers.get("mcp-session-id") as string;
      await r({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": s });
      const listed = await r({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-session-id": s });
      return (listed.body?.result?.tools ?? []).map((t: any) => t.name);
    };
    const p = agent.replace(/^\$/, "").replace(/[^a-zA-Z0-9_]/g, "_");
    const afterPromote = await agentTools();
    expect(afterPromote, `${p}__install_verb missing from ${JSON.stringify(afterPromote.filter((n: string) => n.startsWith(p)))}`).toContain(`${p}__install_verb`);

    // Demote reverses it: the flag clears (lineage seam) and the surface is removed.
    const demoted = await clientFetch(gateway, "POST", "/net-api/turn", {
      token: humanToken,
      body: { target: human, verb: "demote_agent_from_programmer", args: [agent], session: sid }
    });
    expect(demoted.status, JSON.stringify(demoted.body)).toBe(200);
    expect(demoted.body?.reply?.status, JSON.stringify(demoted.body).slice(0, 600)).toBe("accepted");
    expect(demoted.body?.error, `demote errored: ${JSON.stringify(demoted.body?.error)}`).toBeUndefined();
    await settleAll();
    const afterDemote = await agentTools();
    expect(afterDemote).not.toContain(`${p}__install_verb`);

    for (const st of states) st.close();
  });
});
