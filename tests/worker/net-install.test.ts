// End-to-end net install (cutover items A+B): plan → seed every scope DO
// → a carried apikey mints a session through the REAL /net-api surface.
// This is the §8 step-3 "prove the new namespace" shape, in-process.
import { describe, expect, it } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { createWorld } from "../../src/core/bootstrap";
import { exportIdentity, importIdentity } from "../../src/net/identity";
import { planNetInstall } from "../../src/net/install";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";

const SECRET = "net-install-test-secret";
const KEY_ID = "install-key";
const KEY_SECRET = "install-secret-1";

function netState(name: string) {
  const fake = new FakeDurableObjectState(name);
  const state: NetScopeDurableState & NetGatewayDurableState = {
    id: fake.id,
    waitUntil: () => {},
    storage: {
      sql: fake.storage.sql,
      transactionSync: fake.storage.transactionSync,
      setAlarm: () => {},
      deleteAlarm: () => {}
    }
  };
  return { state, close: () => fake.close() };
}

describe("net install end-to-end (fake-DO lane)", () => {
  it("seeds every partition, verifies heads at the install epoch, and a carried apikey mints through /net-api", async () => {
    // The OLD world: one actor with an apikey (the §8 carry).
    const old = createWorld();
    const carried = old.auth("guest:install-e2e").actor;
    old.ensureApiKey("$wiz", carried, KEY_ID, KEY_SECRET, "install e2e");
    const identity = exportIdentity(old.exportWorld());

    // The install plan for the fresh namespace.
    const plan = await planNetInstall({ graft: (fresh) => importIdentity(fresh, identity) });

    // Seed one scope DO per partition — what scripts/net-install.ts does
    // through the /net-install doorway, driven directly here.
    const states: Array<ReturnType<typeof netState>> = [];
    const scopeDOs = new Map<string, NetScopeDO>();
    const resolve = (destination: string) => {
      if (destination.startsWith("scope:")) {
        const instance = scopeDOs.get(destination.slice("scope:".length));
        if (instance) return instance;
      }
      throw new Error(`unresolvable destination ${destination}`);
    };
    const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve };
    const call = async (instance: NetScopeDO | NetGatewayDO, path: string, body?: unknown) => {
      const request =
        body === undefined
          ? new Request(`https://do${path}`)
          : new Request(`https://do${path}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body)
            });
      return instance.fetch(await signInternalRequest(scopeEnv, request));
    };
    for (const [scope, cells] of plan.partitions) {
      const st = netState(`scope-${scope}`);
      const instance = new NetScopeDO(st.state, scopeEnv);
      const seeded = await call(instance, "/net/seed", { scope, catalog_epoch: plan.epoch, cells });
      expect(seeded.ok, `seed ${scope}`).toBe(true);
      states.push(st);
      scopeDOs.set(scope, instance);
    }

    // Verification 1: every head answers at the install epoch, and a
    // SAME-EPOCH re-seed is a no-op-shaped success (idempotent re-run).
    for (const [scope, cells] of plan.partitions) {
      const head = (await (await call(scopeDOs.get(scope) as NetScopeDO, "/net/head")).json()) as { catalog_epoch: string };
      expect(head.catalog_epoch, scope).toBe(plan.epoch);
      const reseed = await call(scopeDOs.get(scope) as NetScopeDO, "/net/seed", { scope, catalog_epoch: plan.epoch, cells });
      expect(reseed.ok, `re-seed ${scope}`).toBe(true);
    }

    // Verification 2 (§8 step 3): the carried key authenticates through
    // the REAL client surface of a fresh gateway shard.
    const gatewayState = netState("gateway-net-api");
    const gateway = new NetGatewayDO(gatewayState.state, {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: resolve
    } as NetGatewayEnv);
    states.push(gatewayState);
    const minted = await gateway.fetch(
      new Request("https://do/net-api/session", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer apikey:${KEY_ID}:${KEY_SECRET}` },
        body: JSON.stringify({ ttl_ms: 60_000 })
      })
    );
    const body = (await minted.json()) as { session?: string; actor?: string };
    expect(minted.status, JSON.stringify(body)).toBe(200);
    expect(body.actor).toBe(carried);
    expect(body.session).toMatch(/^s_/);

    // The client-shell foundation (cutover scope, proven 2026-07-09):
    // the REAL v2 command parser — bare verbs, speech, object matching,
    // persistence routing — runs over the net planner via the chat
    // catalog's `command_plan` wrapper around the `plan_command` native.
    // A thin client is: command_plan(text) → execute the returned plan.
    // This pins that foundation against the installed world.
    const commandPlan = async (text: string): Promise<Record<string, unknown>> => {
      const turn = await gateway.fetch(
        new Request("https://do/net-api/turn", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer apikey:${KEY_ID}:${KEY_SECRET}` },
          body: JSON.stringify({
            target: "the_chatroom",
            verb: "command_plan",
            args: [text],
            session: body.session,
            idempotency_key: `cmd-${text.replace(/\W+/g, "-")}`
          })
        })
      );
      const reply = (await turn.json()) as { reply?: { status?: string }; result?: Record<string, unknown> };
      expect(turn.status, text).toBe(200);
      expect(reply.reply?.status, text).toBe("accepted");
      return reply.result ?? {};
    };
    expect(await commandPlan("look")).toMatchObject({ ok: true, target: "the_chatroom", verb: "look" });
    expect(await commandPlan("say hello there")).toMatchObject({ ok: true, verb: "say", args: ["hello there"] });
    // Object matching resolves against the room's contents in the slice.
    expect(await commandPlan("look lamp")).toMatchObject({ ok: true, verb: "look_at", args: ["the_lamp"] });
    expect(await commandPlan("take mug")).toMatchObject({ ok: true, verb: "take", persistence: "durable" });

    states.forEach((st) => st.close());
  });
});
