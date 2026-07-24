// Phase C of the programmer-environment remediation plan: prove the
// feature-composed programmer surface over the real Net MCP resolver
// (fake-DO lane). A provisioned $agent that carries $programmer as a feature
// must (1) keep its $agent kind, (2) have its authoring verbs advertised as
// dynamic Net tools, (3) create/install/invoke through the authoritative turn
// path, and (4) leave no authoring tools exposed on a non-programmer agent —
// the surface, not the flag, gates the tool set. The resolver walks the
// object's feature chain (gateway-do.ts mcpObjectToolDrafts), so this exercises
// the same reachability decision production uses.
import { describe, expect, it } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { createWorld } from "../../src/core/bootstrap";
import { exportIdentity, importIdentity } from "../../src/net/identity";
import { planNetInstall } from "../../src/net/install";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";

const SECRET = "net-mcp-programmer-secret";

function netState(name: string) {
  const fake = new FakeDurableObjectState(name);
  const deferred: Array<Promise<unknown>> = [];
  const state: NetScopeDurableState & NetGatewayDurableState = {
    id: fake.id,
    waitUntil: (promise: Promise<unknown>) => {
      deferred.push(promise);
    },
    storage: {
      sql: fake.storage.sql,
      transactionSync: fake.storage.transactionSync,
      setAlarm: () => {},
      deleteAlarm: () => {}
    }
  };
  return {
    state,
    settle: async () => {
      while (deferred.length > 0) await deferred.shift();
    },
    close: () => fake.close()
  };
}

type Rpc = { jsonrpc: "2.0"; id?: number; method: string; params?: unknown };

describe("Net MCP programmer surface (fake-DO lane)", () => {
  it("exposes a feature-composed agent's authoring tools over Net MCP and authors through the turn path", async () => {
    // Two $wiz-owned $agents with apikeys, one with the programmer surface
    // composed on. Real $agent auth exercises the owner-chain eligibility check
    // (owner read from object_lineage). The create_agent provisioning path is
    // covered in tests/programmer-surface.test.ts. The identity export now
    // carries the `features` surface, so the agent arrives feature-composed.
    const progAgent = "prog_agent";
    const plainAgent = "plain_agent";
    const old = createWorld();
    old.createObject({ id: progAgent, parent: "$agent", owner: "$wiz", name: "ProgBot" });
    old.createObject({ id: plainAgent, parent: "$agent", owner: "$wiz", name: "PlainBot" });
    old.ensureApiKey("$wiz", progAgent, "prog-key", "prog-secret", "prog");
    old.ensureApiKey("$wiz", plainAgent, "plain-key", "plain-secret", "plain");
    old.setObjectFlags("$wiz", progAgent, { programmer: true }); // flag + surface

    // §8.1: kind stays $agent; the surface is composed as a feature, never by
    // reparenting.
    expect(old.isDescendantOf(progAgent, "$agent")).toBe(true);
    expect(old.isDescendantOf(progAgent, "$programmer")).toBe(false);
    expect(old.actorHasSurface(progAgent, "$programmer")).toBe(true);
    expect(old.actorHasSurface(plainAgent, "$programmer")).toBe(false);

    const identity = exportIdentity(old.exportWorld());
    const plan = await planNetInstall({ graft: async (fresh) => { importIdentity(fresh, identity); } });
    const progToken = "apikey:prog-key:prog-secret";
    const plainToken = "apikey:plain-key:plain-secret";

    // --- wire the Net DOs (fake-DO lane) ---
    const states: Array<ReturnType<typeof netState>> = [];
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
      const request = new Request("https://do/net/seed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, catalog_epoch: plan.epoch, cells, relations: plan.relations.get(scope) ?? [] })
      });
      const seeded = await instance.fetch(await signInternalRequest(scopeEnv, request));
      expect(seeded.ok, `seed ${scope}`).toBe(true);
      states.push(st);
      scopeDOs.set(scope, instance);
    }
    const gatewayState = netState("gateway-net-api");
    states.push(gatewayState);
    gateway = new NetGatewayDO(gatewayState.state, { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve, NET_GATEWAY_SELF: "gateway:net-api" } as NetGatewayEnv);

    const settleAll = async () => {
      for (const st of states) await st.settle();
      for (const scope of scopeDOs.values()) await scope.alarm();
      for (const st of states) await st.settle();
    };

    let nextId = 10;
    const mcp = async (body: Rpc, headers: Record<string, string> = {}) => {
      const response = await gateway.fetch(new Request("https://do/net-api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body)
      }));
      const text = await response.text();
      return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) as Record<string, any> : null };
    };
    const open = async (token: string): Promise<string> => {
      const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { "mcp-token": token });
      expect(init.status, JSON.stringify(init.body)).toBe(200);
      const session = init.headers.get("mcp-session-id");
      expect(session).toBeTruthy();
      await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": session as string });
      return session as string;
    };
    const call = async (session: string, name: string, args: Record<string, unknown>) =>
      (await mcp({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }, { "mcp-session-id": session })).body as Record<string, any>;
    const listNames = async (session: string): Promise<string[]> => {
      const listed = await mcp({ jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} }, { "mcp-session-id": session });
      return (listed.body?.result?.tools ?? []).map((t: any) => t.name);
    };

    const progSession = await open(progToken);
    const sanitize = (id: string) => id.replace(/^\$/, "").replace(/[^a-zA-Z0-9_]/g, "_");
    const p = sanitize(progAgent);

    // (3) The agent's authoring verbs are advertised as dynamic Net tools —
    // resolved through the feature chain, not ancestry.
    const progNames = await listNames(progSession);
    for (const verb of ["install_verb", "create", "inspect", "eval"]) {
      expect(progNames, `${verb} missing from ${JSON.stringify(progNames.filter((n) => n.startsWith(p)))}`).toContain(`${p}__${verb}`);
    }

    // The removed "all" scope is rejected by the MCP validator, not silently
    // degraded to the local closure (§7 / no global enumeration).
    const scopeAll = await call(progSession, "woo_list_reachable_tools", { scope: "all" });
    expect(scopeAll.result?.isError, JSON.stringify(scopeAll).slice(0, 300)).toBe(true);

    // (4) The non-programmer agent sees NO authoring tools — the surface gates
    // the tool set, not merely the flag.
    const plainSession = await open(plainToken);
    const plainNames = await listNames(plainSession);
    const pl = sanitize(plainAgent);
    for (const verb of ["install_verb", "create", "eval"]) {
      expect(plainNames).not.toContain(`${pl}__${verb}`);
    }

    // (5) Author through the authoritative turn path: the builder create verb,
    // reached via the feature chain, runs over Net and attributes the object to
    // the invoking actor (§8.7).
    const created = await call(progSession, "woo_call", { object: progAgent, verb: "create", args: ["$thing", { name: "NetWidget" }] });
    await settleAll();
    expect(created.result?.isError, JSON.stringify(created).slice(0, 500)).not.toBe(true);
    const createdResult = created.result?.structuredContent?.result ?? {};
    expect(createdResult.id, JSON.stringify(created).slice(0, 500)).toBeTruthy();
    expect(createdResult.owner).toBe(progAgent);

    // NOTE: installing a verb on that freshly created object over Net currently
    // refuses with E_CATALOG_MUTATION — the object lands in a catalog-adjacent
    // scope rather than the actor's durable authoring cluster. Placing
    // programmer objects in the actor's cluster so subsequent source installs
    // stay local is the authoring-workspace-boundary work (plan §7), which is
    // deferred. The full create → install → invoke loop is proven in-memory in
    // tests/programmer-surface.test.ts; here we prove the Net resolver exposes
    // and gates the feature-composed surface and runs its builder verbs.

    for (const st of states) st.close();
  });
});
