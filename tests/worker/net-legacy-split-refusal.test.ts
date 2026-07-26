// P1 support-boundary regression: a NEW agent minted under a LEGACY anchorless
// account is NOT a supported promote/demote family. create_agent anchors the new
// agent to the human (cluster:<human>), but the legacy account stays
// catalog-scoped — so the family is still split, and a promote over Net must
// refuse cleanly with NO partial mutation (the account counter is a catalog
// write ordinary turns cannot make). This proves "re-provisioning the agent
// alone cannot repair a legacy family". Fake-DO lane.
import { describe, expect, it } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetAuditDO } from "../../src/worker/net/audit-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { createWorld } from "../../src/core/bootstrap";
import { cellsFromSerialized } from "../../src/net/bridge";
import { netActivationCell, partitionInstallRelations } from "../../src/net/install";
import { CATALOG_SCOPE, partitionCells, scopeNameOf } from "../../src/net/topology";
import { signInternalRequest } from "../../src/worker/internal-auth";

const SECRET = "net-split-refusal-secret";
const EPOCH = "cat-net-split-1";

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

describe("Net legacy split family: promote refuses without partial mutation", () => {
  it("a new agent under a legacy anchorless account cannot promote (account stays catalog-scoped)", async () => {
    const old = createWorld();
    const start = await old.beginSignup("legacy@woo.dev", "password123");
    const human = start.verification_token ? (old.verifySignup(start.verification_token).actor as string) : "";
    const account = old.propOrNull(human, "account") as string;
    old.setProp(account, "programmer_grant_quota", 10);
    old.setProp(account, "programmer_agent_count", 0);
    old.ensureApiKey("$wiz", human, "human-key", "human-secret", "human");
    // Simulate a LEGACY family: the account predates authority-root anchoring, so
    // it is anchorless (catalog-scoped). Signup anchored it; strip that to model
    // an already-deployed pre-anchoring account.
    old.object(account).anchor = null;
    // Now mint a NEW agent under this legacy family — the "re-provision" remedy.
    const prov = (await old.directCall("prov", human, human, "create_agent", ["NewBot", "", false])) as unknown as { result: { actor_id: string } };
    const agent = prov.result.actor_id;
    // Ground truth: the new agent anchors to the human, but the account is split off.
    expect(old.object(agent).anchor).toBe(human);
    expect(old.object(account).anchor ?? null).toBeNull();

    const cells = cellsFromSerialized(old.exportWorld());
    const lineage = new Map<string, unknown>();
    for (const c of cells) if (c.kind === "object_lineage") lineage.set(c.object, c.value);
    const look = (id: string) => (lineage.get(id) ?? null) as never;
    expect(scopeNameOf(agent, look)).toBe(`cluster:${human}`);
    expect(scopeNameOf(account, look)).toBe(CATALOG_SCOPE); // split from the agent

    const partitions = partitionCells(cells);
    const relations = partitionInstallRelations(cells);
    partitions.set(CATALOG_SCOPE, [...(partitions.get(CATALOG_SCOPE) ?? []), netActivationCell(EPOCH)]);

    const states: Array<ReturnType<typeof netState>> = [];
    const scopeDOs = new Map<string, NetScopeDO>();
    let gateway: NetGatewayDO;
    let auditDO: NetAuditDO;
    const resolve = (destination: string) => {
      if (destination.startsWith("scope:")) { const i = scopeDOs.get(destination.slice("scope:".length)); if (i) return i; }
      if (destination.startsWith("gateway:")) return gateway;
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
    const gwState = netState("gateway-net-api");
    states.push(gwState);
    gateway = new NetGatewayDO(gwState.state, { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve, NET_AUDIT_SHARDS: "1" } as NetGatewayEnv);
    const settleAll = async () => {
      for (const st of states) await st.settle();
      for (const s of scopeDOs.values()) await s.alarm();
      for (const st of states) await st.settle();
    };

    const humanToken = "apikey:human-key:human-secret";
    const minted = await clientFetch(gateway, "/net-api/session", humanToken, { ttl_ms: 600_000 });
    expect(minted.status, JSON.stringify(minted.body)).toBe(200);
    const sid = minted.body.session as string;

    // Promote over the real turn doorway — it must NOT succeed: the account
    // counter write lands in the catalog scope, which an ordinary turn cannot
    // mutate. Either the turn errors, or it commits nothing (the flag stays off).
    const promoted = await clientFetch(gateway, "/net-api/turn", humanToken, {
      target: human, verb: "promote_agent_to_programmer", args: [agent], session: sid
    });
    await settleAll();
    // The refusal is a clean 400 E_CATALOG_MUTATION — the legacy account's
    // programmer_agent_count is a catalog-scoped cell an ordinary turn cannot
    // write — atomically rejected, so nothing about the transition commits.
    expect(promoted.status).toBe(400);
    expect(promoted.body?.error?.code).toBe("E_CATALOG_MUTATION");

    // The promote did NOT succeed for the split family (accepted-with-no-error
    // would mean the transition committed). A refusal is either a non-200/reject
    // status, a rejected reply, or an accepted-but-errored turn — but never a
    // clean success.
    const cleanSuccess =
      promoted.status === 200 &&
      promoted.body?.reply?.status === "accepted" &&
      promoted.body?.error == null &&
      promoted.body?.result === true;
    expect(cleanSuccess, `split-family promote unexpectedly succeeded: ${JSON.stringify(promoted.body).slice(0, 600)}`).toBe(false);

    // No partial mutation: nothing about the transition committed. Reconstruct
    // the agent's surface on a COLD gateway from the durable scope — it must show
    // NO programmer tools (the flag/features never landed).
    old.ensureApiKey("$wiz", agent, "agent-key", "agent-secret", "agent");
    // (agent key minted in the source image is not seeded here; instead assert
    // the durable account counter never advanced — a committed promote would
    // have incremented it. Read it back from the catalog scope closure.)
    const closure = await scopeDOs.get(CATALOG_SCOPE)!.fetch(
      await signInternalRequest(scopeEnv, new Request("https://do/net/closure", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ keys: [`property_cell:${account}:programmer_agent_count`], known: [] })
      }))
    );
    expect(closure.ok).toBe(true);
    const transfer = (await closure.json()) as { cells?: Array<{ key: string; value: unknown }> };
    const countCell = (transfer.cells ?? []).find((c) => c.key === `property_cell:${account}:programmer_agent_count`);
    const count = countCell ? ((countCell.value as { value?: number })?.value ?? 0) : 0;
    expect(count, "the account programmer_agent_count advanced — the split promote partially committed").toBe(0);

    for (const st of states) st.close();
  });
});
