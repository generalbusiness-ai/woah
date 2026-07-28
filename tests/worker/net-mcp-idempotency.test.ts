// MCP mutation retry safety (CO2.5 / mcp.md §M4.2), fake-DO lane.
//
// The defect this pins: the MCP tool-call path minted a fresh idempotency
// key per HTTP request, so a mutation whose response was lost executed AGAIN
// on the client's retry. Every assertion below is on WORLD STATE (a counter
// the verb increments), not on reply shape alone — a fix that deduplicates
// the reply while letting the effect happen twice must fail here.
import { describe, expect, it } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { createWorld } from "../../src/core/bootstrap";
import { installVerb } from "../../src/core/authoring";
import { exportIdentity, importIdentity } from "../../src/net/identity";
import { planNetInstall } from "../../src/net/install";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";

const SECRET = "net-mcp-idempotency-secret";

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

/**
 * A one-actor world whose `the_mug` carries a counter verb.
 *
 * `bump` is an ordinary bytecode verb with no command metadata, so it routes
 * `sequenced` (the fail-safe default) and its write set makes it MUTATING —
 * exactly the shape the operation id exists to protect. `hits` is the world
 * state every assertion reads back.
 */
async function fixture() {
  const old = createWorld();
  const alice = old.auth("guest:idem-alice").actor;
  const bob = old.auth("guest:idem-bob").actor;
  old.ensureApiKey("$wiz", alice, "idem-key-a", "idem-secret-a", "alice");
  old.ensureApiKey("$wiz", bob, "idem-key-b", "idem-secret-b", "bob");
  const identity = exportIdentity(old.exportWorld());
  const plan = await planNetInstall({
    graft: async (fresh) => {
      importIdentity(fresh, identity);
      fresh.setProp("the_mug", "hits", 0);
      expect(installVerb(
        fresh,
        "the_mug",
        "bump",
        "verb :bump() rxd { this.hits = this.hits + 1; return this.hits; }",
        null
      ).ok).toBe(true);
      expect(installVerb(
        fresh,
        "the_mug",
        "hits_now",
        "verb :hits_now() rxd { return this.hits; }",
        null
      ).ok).toBe(true);
    }
  });

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
  const gatewayEnv = {
    WOO_INTERNAL_SECRET: SECRET,
    NET_RESOLVE: resolve,
    NET_GATEWAY_SELF: "gateway:net-api"
  } as NetGatewayEnv;
  gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);

  const settleAll = async () => {
    for (const st of states) await st.settle();
    for (const scope of scopeDOs.values()) await scope.alarm();
    for (const st of states) await st.settle();
  };

  let nextId = 100;
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
    const session = init.headers.get("mcp-session-id") as string;
    expect(session).toBeTruthy();
    await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": session });
    return session;
  };
  /** One tools/call. `meta` rides `params._meta` (the protocol carrier). */
  const call = async (
    session: string,
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>
  ) => (await mcp(
    { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } },
    { "mcp-session-id": session }
  )).body as Record<string, any>;

  const aliceSession = await open("apikey:idem-key-a:idem-secret-a");
  const bobSession = await open("apikey:idem-key-b:idem-secret-b");
  await settleAll();

  /** The counter, read back through the real turn path. */
  const hits = async (session = aliceSession): Promise<number> => {
    const read = await call(session, "woo_call", { object: "the_mug", verb: "hits_now", args: [] });
    expect(read.result?.isError, JSON.stringify(read).slice(0, 400)).not.toBe(true);
    return read.result?.structuredContent?.result as number;
  };
  const bump = async (session: string, operationId?: string, viaMeta = false) =>
    viaMeta
      ? await call(session, "woo_call", { object: "the_mug", verb: "bump", args: [] }, { "woo.net/operation_id": operationId })
      : await call(session, "woo_call", {
          object: "the_mug",
          verb: "bump",
          args: [],
          ...(operationId ? { operation_id: operationId } : {})
        });

  return {
    alice, bob, aliceSession, bobSession, gateway: () => gateway, gatewayState, gatewayEnv,
    mcp, call, hits, bump, settleAll,
    close: () => { for (const st of states) st.close(); }
  };
}

describe("MCP mutation retry safety (CO2.5 / M4.2)", () => {
  it("a retry under the same operation_id commits ONCE and learns the outcome", async () => {
    const f = await fixture();
    try {
      expect(await f.hits()).toBe(0);

      // The commit that succeeds.
      const first = await f.bump(f.aliceSession, "order-1");
      expect(first.result?.isError, JSON.stringify(first).slice(0, 400)).not.toBe(true);
      expect(first.result?.structuredContent?.result).toBe(1);
      expect(first.result?.structuredContent?.replayed).toBeUndefined();
      await f.settleAll();
      expect(await f.hits()).toBe(1);

      // FAULT INJECTION: the response above is now treated as lost — the
      // client never saw it and cannot know whether the mutation landed. Its
      // only safe move is to retry the identical call under the identical
      // operation id. (What this lane models is the client's view: commit
      // durable at the authority, outcome unknown to the caller. It does not
      // model a mid-flight DO eviction; the cold-gateway case is the next
      // test, which retries through a second gateway instance.)
      const retry = await f.bump(f.aliceSession, "order-1");
      await f.settleAll();

      // 1. The effect happened exactly once.
      expect(await f.hits()).toBe(1);
      // 2. The retry LEARNS the outcome — the recorded return value of the
      //    execution that committed, not a re-planned guess and not null.
      expect(retry.result?.isError, JSON.stringify(retry).slice(0, 400)).not.toBe(true);
      expect(retry.result?.structuredContent?.result).toBe(1);
      expect(retry.result?.structuredContent?.replayed).toBe(true);
      expect(retry.result?.structuredContent?.replay_outcome).toBe("full");
      // 3. And it is told, in prose an agent will read, not to retry again
      //    under a new id.
      const notice = (retry.result?.content ?? []).map((block: any) => block.text).join(" ");
      expect(notice).toContain("ran exactly once");
      expect(notice).toContain("Do not retry it under a new operation_id");
    } finally {
      f.close();
    }
  });

  it("replays through a COLD gateway instance: the guarantee is the authority's, not one shard's memory", async () => {
    const f = await fixture();
    try {
      expect((await f.bump(f.aliceSession, "cold-1")).result?.structuredContent?.result).toBe(1);
      await f.settleAll();
      expect(await f.hits()).toBe(1);

      // A gateway DO eviction is exactly the failure that loses a response.
      // A fresh instance over the SAME durable state must still replay,
      // because the recorded reply lives at the committing scope.
      const revived = new NetGatewayDO(f.gatewayState.state, f.gatewayEnv);
      const response = await revived.fetch(new Request("https://do/net-api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", "mcp-session-id": f.aliceSession },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 9001,
          method: "tools/call",
          params: {
            name: "woo_call",
            arguments: { object: "the_mug", verb: "bump", args: [], operation_id: "cold-1" }
          }
        })
      }));
      const body = await response.json() as Record<string, any>;
      await f.settleAll();
      expect(body.result?.isError, JSON.stringify(body).slice(0, 500)).not.toBe(true);
      expect(body.result?.structuredContent?.replayed).toBe(true);
      expect(body.result?.structuredContent?.result).toBe(1);
      expect(await f.hits()).toBe(1);
    } finally {
      f.close();
    }
  });

  it("the KEY is what dedupes: different operation ids execute twice", async () => {
    const f = await fixture();
    try {
      expect((await f.bump(f.aliceSession, "op-a")).result?.structuredContent?.result).toBe(1);
      await f.settleAll();
      const second = await f.bump(f.aliceSession, "op-b");
      await f.settleAll();
      expect(second.result?.structuredContent?.result).toBe(2);
      expect(second.result?.structuredContent?.replayed).toBeUndefined();
      expect(await f.hits()).toBe(2);
    } finally {
      f.close();
    }
  });

  it("no operation id: unchanged behaviour — every call is a new turn", async () => {
    const f = await fixture();
    try {
      expect((await f.bump(f.aliceSession)).result?.structuredContent?.result).toBe(1);
      await f.settleAll();
      expect((await f.bump(f.aliceSession)).result?.structuredContent?.result).toBe(2);
      await f.settleAll();
      expect(await f.hits()).toBe(2);
    } finally {
      f.close();
    }
  });

  it("the `_meta` carrier works, and outranks the argument form", async () => {
    const f = await fixture();
    try {
      expect((await f.bump(f.aliceSession, "meta-1", true)).result?.structuredContent?.result).toBe(1);
      await f.settleAll();
      const retry = await f.bump(f.aliceSession, "meta-1", true);
      await f.settleAll();
      expect(retry.result?.structuredContent?.replayed).toBe(true);
      expect(await f.hits()).toBe(1);

      // Precedence: `_meta` is the protocol-level carrier and wins, so this
      // call replays "meta-1" and the argument's "meta-other" is ignored.
      const mixed = await f.call(
        f.aliceSession,
        "woo_call",
        { object: "the_mug", verb: "bump", args: [], operation_id: "meta-other" },
        { "woo.net/operation_id": "meta-1" }
      );
      await f.settleAll();
      expect(mixed.result?.structuredContent?.replayed).toBe(true);
      expect(await f.hits()).toBe(1);
    } finally {
      f.close();
    }
  });

  it("operation ids are namespaced per actor: two agents choosing the same string do not collide", async () => {
    const f = await fixture();
    try {
      expect((await f.bump(f.aliceSession, "shared")).result?.structuredContent?.result).toBe(1);
      await f.settleAll();
      // Bob picks the same obvious string. His call is a DIFFERENT operation
      // and must run; he must also never receive Alice's recorded outcome.
      const bobs = await f.bump(f.bobSession, "shared");
      await f.settleAll();
      expect(bobs.result?.isError, JSON.stringify(bobs).slice(0, 400)).not.toBe(true);
      expect(bobs.result?.structuredContent?.replayed).toBeUndefined();
      expect(bobs.result?.structuredContent?.result).toBe(2);
      expect(await f.hits()).toBe(2);
    } finally {
      f.close();
    }
  });

  it("a malformed operation id is refused, never silently downgraded to a fresh key", async () => {
    const f = await fixture();
    try {
      const bad = await f.call(f.aliceSession, "woo_call", {
        object: "the_mug",
        verb: "bump",
        args: [],
        operation_id: "has spaces and 🙂"
      });
      expect(bad.result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "E_INVARG", detail: { reason: "invalid_operation_id" } } }
      });
      // Refused BEFORE the turn: nothing committed.
      await f.settleAll();
      expect(await f.hits()).toBe(0);
    } finally {
      f.close();
    }
  });

  it("advertises operation_id on woo_call and on dynamic tools", async () => {
    const f = await fixture();
    try {
      const listed = await f.mcp(
        { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} },
        { "mcp-session-id": f.aliceSession }
      );
      const tools = listed.body?.result?.tools ?? [];
      const wooCall = tools.find((tool: any) => tool.name === "woo_call");
      expect(wooCall?.inputSchema?.properties?.operation_id?.type).toBe("string");
      // Dynamic tools carry it too — an agent that only ever sees dynamic
      // names must still be able to retry safely.
      const dynamic = tools.find((tool: any) => tool.name?.includes("__") && tool.inputSchema?.properties);
      expect(dynamic?.inputSchema?.properties?.operation_id?.type).toBe("string");
      // It is never `required`: an existing client that has never heard of
      // it keeps working exactly as before.
      expect(wooCall?.inputSchema?.required ?? []).not.toContain("operation_id");

      // The discovery control advertises the SAME call surface — an agent
      // that finds tools this way must not be shown a schema that hides
      // retry safety.
      const page = await f.call(f.aliceSession, "woo_list_reachable_tools", { limit: 5, include_schema: true });
      const listed2 = page.result?.structuredContent?.result?.tools ?? [];
      expect(listed2.length).toBeGreaterThan(0);
      expect(listed2[0]?.input_schema?.properties?.operation_id?.type).toBe("string");
    } finally {
      f.close();
    }
  });
});
