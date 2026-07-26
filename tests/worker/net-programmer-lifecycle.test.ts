// Blocker 4: the production-shaped programmer lifecycle, end to end over the real
// Net MCP + turn doorways (fake-DO lane). Unlike net-mcp-programmer.test.ts (which
// hand-builds unanchored $wiz agents and stops at source inspection), this uses a
// REAL create_agent-provisioned, human-owned, ANCHORED agent with a self-routing
// n1_ key that enters Net UNpromoted, and walks the whole lifecycle over the real
// doorways: PROMOTE over /net-api/turn (the live session gains the surface) →
// create (into the author's cluster) → define a property → structured inspection
// → install dry-run → install → invoke (via the eval surface) → stale
// expected_version conflict → cold-gateway reconstruction → DEMOTE over
// /net-api/turn (the live session loses the surface). The successful
// expected_version compare-and-swap is proven in-memory (programmer-surface); the
// live tools/list_changed SSE + stale-call refusal in net-demote-lifecycle.
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
  it("provision-unpromoted → promote → create → define property → inspect → install → invoke → conflict → cold reconstruction → demote", async () => {
    // --- (1) Provisioning: a REAL create_agent-provisioned anchored programmer. ---
    const old = createWorld();
    const start = await old.beginSignup("life@woo.dev", "password123");
    const human = start.verification_token ? (old.verifySignup(start.verification_token).actor as string) : "";
    const account = old.propOrNull(human, "account") as string;
    old.setProp(account, "programmer_grant_quota", 10);
    old.ensureApiKey("$wiz", human, "human-key", "human-secret", "human");
    // Provision NOT promoted: the agent enters Net as an ordinary $agent and is
    // promoted OVER Net below, so the whole promote→author→demote lifecycle runs
    // through the real turn doorway rather than a pre-promoted local image.
    const prov = (await old.directCall("prov", human, human, "create_agent", ["ProgBot", "", false])) as unknown as { result: { actor_id: string } };
    const agent = prov.result.actor_id;
    const agentKey = old.createApiKeyForOwner(human, agent, "bot");
    const agentToken = `apikey:${agentKey.id}:${agentKey.secret}`;
    const humanToken = "apikey:human-key:human-secret";
    expect(old.object(agent).flags.programmer ?? false, "agent should enter Net UNpromoted").toBe(false);
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
    // The human drives promote/demote over the real turn doorway.
    const humanTurn = async (gateway: NetGatewayDO, session: string, verb: string) => {
      const resp = await gateway.fetch(new Request("https://do/net-api/turn", {
        method: "POST", headers: { authorization: `Bearer ${humanToken}`, "content-type": "application/json" },
        body: JSON.stringify({ target: human, verb, args: [agent], session })
      }));
      return { status: resp.status, body: (await resp.json()) as Record<string, any> };
    };

    const p = agent.replace(/^\$/, "").replace(/[^a-zA-Z0-9_]/g, "_");

    // --- (2) The UNpromoted agent connects: no authoring surface yet. ---
    const warm = freshGateway();
    const mcp = await mcpSession(warm, agentToken);
    expect(mcp.sid, "agent MCP session did not open").toBeTruthy();
    expect(await mcp.list(), `${p}__install_verb present before promote`).not.toContain(`${p}__install_verb`);

    // --- (3) PROMOTE over /net-api/turn; the live agent session gains the surface. ---
    const hSession = (await (async () => {
      const r = await warm.fetch(new Request("https://do/net-api/session", { method: "POST", headers: { authorization: `Bearer ${humanToken}`, "content-type": "application/json" }, body: JSON.stringify({ ttl_ms: 600_000 }) }));
      return (await r.json()) as { session: string };
    })()).session;
    const promoted = await humanTurn(warm, hSession, "promote_agent_to_programmer");
    expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
    expect(promoted.body?.reply?.status, JSON.stringify(promoted.body).slice(0, 500)).toBe("accepted");
    expect(promoted.body?.error, `promote errored: ${JSON.stringify(promoted.body?.error)}`).toBeUndefined();
    await settleAll();
    const afterPromote = await mcp.list();
    expect(afterPromote, `${p}__install_verb missing after Net promote`).toContain(`${p}__install_verb`);
    expect(afterPromote, `${p}__create missing after Net promote`).toContain(`${p}__create`);

    // --- (4) create an object INTO the author's inventory (co-located). ---
    const created = await mcp.call(`${p}__create`, { parent: "$thing", opts: { name: "Widget", location: agent } });
    expect(errored(created), JSON.stringify(created).slice(0, 500)).toBe(false);
    const widget = result(created).id as string;
    expect(widget?.startsWith("obj_"), JSON.stringify(created).slice(0, 500)).toBe(true);
    await settleAll();

    // --- (5) property DEFINITION on the authored object (set_property_info,
    // programmer authority). ---
    const propDef = await mcp.call(`${p}__set_property_info`, { id: widget, name: "count", opts: { mode: "define" } });
    expect(errored(propDef), `set_property_info(define) failed: ${JSON.stringify(propDef).slice(0, 500)}`).toBe(false);
    expect(result(propDef).ok).toBe(true);
    expect(result(propDef).after?.defined_on).toBe(widget);
    await settleAll();

    // --- (6) structured inspection reflects the object and its newly defined
    // property (the define is durable and readable over Net). ---
    const inspected = await mcp.call(`${p}__inspect`, { id: widget });
    expect(errored(inspected), `inspect failed: ${JSON.stringify(inspected).slice(0, 500)}`).toBe(false);
    const insText = JSON.stringify(result(inspected));
    expect(insText, insText.slice(0, 400)).toContain("count");

    // --- (7) install: dry-run → v1. ---
    const dry = await mcp.call(`${p}__install_verb`, { id: widget, descriptor: "ping", source: "verb :ping() rxd { return 7; }", opts: { dry_run: true } });
    expect(result(dry).ok).toBe(true);
    expect(result(dry).dry_run).toBe(true);
    const v1 = await mcp.call(`${p}__install_verb`, { id: widget, descriptor: "ping", source: "verb :ping() rxd { return 7; }", opts: {} });
    expect(result(v1).ok, JSON.stringify(v1).slice(0, 500)).toBe(true);
    expect(result(v1).version).toBe(1);
    await settleAll();

    // --- (8) INVOKE the authored verb (via the eval surface; authored bytecode
    // verbs are intentionally not tool_exposed). Dispatch pulls the verb page on
    // miss, which also makes the just-committed v1 visible to the next read. ---
    const invokeSrc = "let o = contents(actor)[1]; return o:ping();";
    const invoked = await mcp.call(`${p}__eval`, { source: invokeSrc, opts: { mode: "stmts" } });
    expect(errored(invoked), `invoke failed: ${JSON.stringify(invoked).slice(0, 500)}`).toBe(false);
    expect(result(invoked).value).toBe(7);
    await settleAll();

    // --- (9) install version control: a STALE expected_version conflicts. The
    // SUCCESSFUL compare-and-swap (naming the current version to commit the next)
    // is proven in-memory in tests/programmer-surface.test.ts — over Net it is a
    // cross-turn read of the arg object's verb-metadata page, which install_verb's
    // verb_info does not pull-on-miss (only dispatch does), a general Net metadata-
    // freshness property beyond the programmer surface. ---
    const conflict = await mcp.call(`${p}__install_verb`, { id: widget, descriptor: "ping", source: "verb :ping() rxd { return 9; }", opts: { expected_version: 99 } });
    expect(errored(conflict) || (result(conflict)?.diagnostics?.length ?? 0) > 0, `version conflict not refused: ${JSON.stringify(conflict).slice(0, 400)}`).toBe(true);

    // --- (9) COLD gateway reconstruction: a fresh gateway invokes from durable state. ---
    const cold = freshGateway();
    const coldMcp = await mcpSession(cold, agentToken);
    expect(coldMcp.sid, "cold agent MCP session did not open").toBeTruthy();
    const coldInvoke = await coldMcp.call(`${p}__eval`, { source: invokeSrc, opts: { mode: "stmts" } });
    expect(result(coldInvoke).value, "authored verb did not reconstruct on a cold gateway").toBe(7);

    // --- (10) DEMOTE over /net-api/turn; the live agent session loses the surface. ---
    const demoted = await humanTurn(warm, hSession, "demote_agent_from_programmer");
    expect(demoted.status, JSON.stringify(demoted.body)).toBe(200);
    expect(demoted.body?.reply?.status, JSON.stringify(demoted.body).slice(0, 500)).toBe("accepted");
    expect(demoted.body?.error, `demote errored: ${JSON.stringify(demoted.body?.error)}`).toBeUndefined();
    await settleAll();
    expect(await mcp.list(), `${p}__install_verb survived demote`).not.toContain(`${p}__install_verb`);
    // (The live tools/list_changed SSE notification and stale-call refusal for the
    // demote transition are proven in tests/worker/net-demote-lifecycle.test.ts.)

    for (const st of states) st.close();
  });
});
