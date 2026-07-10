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

  it("activation barrier: client traffic refuses until the verified epoch is published, and on epoch mismatch", async () => {
    const old = createWorld();
    const carried = old.auth("guest:install-barrier").actor;
    old.ensureApiKey("$wiz", carried, KEY_ID, KEY_SECRET, "install barrier");
    const identity = exportIdentity(old.exportWorld());

    // activate:false — the production installer's posture: every scope
    // seeded (identity cells included) but no activation cell yet.
    const plan = await planNetInstall({ activate: false, graft: (fresh) => importIdentity(fresh, identity) });

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
    const seed = async (scope: string, cells: unknown[]) => {
      let instance = scopeDOs.get(scope);
      if (!instance) {
        const st = netState(`scope-${scope}`);
        states.push(st);
        instance = new NetScopeDO(st.state, scopeEnv);
        scopeDOs.set(scope, instance);
      }
      const request = new Request("https://do/net/seed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, catalog_epoch: plan.epoch, cells })
      });
      const seeded = await instance.fetch(await signInternalRequest(scopeEnv, request));
      expect(seeded.ok, `seed ${scope}`).toBe(true);
    };
    for (const [scope, cells] of plan.partitions) await seed(scope, cells);

    // A FRESH gateway per probe: activation state rides the gateway's
    // cached catalog view, and the barrier must hold for a shard that
    // has never seen the namespace before.
    const mint = async (label: string) => {
      const st = netState(`gateway-${label}`);
      states.push(st);
      const gateway = new NetGatewayDO(st.state, { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve } as NetGatewayEnv);
      return gateway.fetch(
        new Request("https://do/net-api/session", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer apikey:${KEY_ID}:${KEY_SECRET}` },
          body: JSON.stringify({ ttl_ms: 60_000 })
        })
      );
    };

    // INSTALLING: fully seeded, identity present — still refused with the
    // NAMED verdict (E_NOT_INSTALLED alone would only cover the unseeded
    // namespace; this is the partial/unverified case the barrier exists for).
    const barred = await mint("installing");
    expect(barred.status).toBe(503);
    const barredBody = (await barred.json()) as { error: { code: string; detail?: { reason?: string } } };
    expect(barredBody.error.code).toBe("E_NOT_INSTALLED");
    expect(barredBody.error.detail?.reason).toBe("not_active");

    // Activation state changes ride the DEDICATED operator op (reviewer
    // finding 1: /net/seed refuses once a scope commits, so activation
    // must never be a seed).
    const { CATALOG_SCOPE } = await import("../../src/net/topology");
    const activateRaw = async (activeEpoch: string | null, expected: string | null | undefined) => {
      const instance = scopeDOs.get(CATALOG_SCOPE) as NetScopeDO;
      const request = new Request("https://do/net/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: CATALOG_SCOPE,
          catalog_epoch: plan.epoch,
          active_epoch: activeEpoch,
          ...(expected !== undefined ? { expected_active_epoch: expected } : {})
        })
      });
      return instance.fetch(await signInternalRequest(scopeEnv, request));
    };
    const activate = async (activeEpoch: string | null) => {
      const response = await activateRaw(activeEpoch, undefined);
      expect(response.ok, `activate ${String(activeEpoch)}`).toBe(true);
    };

    // A MIXED-EPOCH activation (identity from this install, activation
    // from another) is an operator error to surface, never to serve through.
    await activate("cat-someother");
    const mixed = await mint("mixed");
    expect(mixed.status).toBe(503);
    expect(((await mixed.json()) as { error: { detail?: { reason?: string } } }).error.detail?.reason).toBe("epoch_mismatch");

    // ACTIVE: publishing the verified epoch admits traffic.
    await activate(plan.epoch);
    const active = await mint("active");
    expect(active.status, JSON.stringify(await active.clone().json())).toBe(200);

    // DEACTIVATED (the installer's failed-verification compensation):
    // a null activation refuses again on a fresh shard.
    await activate(null);
    const deactivated = await mint("deactivated");
    expect(deactivated.status).toBe(503);
    expect(((await deactivated.json()) as { error: { detail?: { reason?: string } } }).error.detail?.reason).toBe("not_active");

    // Reviewer finding 5 — the SAME gateway that served under activation
    // must observe a later deactivation (the fresh-gateway-per-probe
    // pattern above deliberately cannot catch this). TTL 0 forces
    // re-verification against the authority on every request.
    const sameState = netState("gateway-same");
    states.push(sameState);
    const sameGateway = new NetGatewayDO(sameState.state, {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: resolve,
      NET_ACTIVATION_TTL_MS: "0"
    } as NetGatewayEnv);
    const mintOn = (gateway: NetGatewayDO) =>
      gateway.fetch(
        new Request("https://do/net-api/session", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer apikey:${KEY_ID}:${KEY_SECRET}` },
          body: JSON.stringify({ ttl_ms: 60_000 })
        })
      );
    await activate(plan.epoch);
    const served = await mintOn(sameGateway);
    expect(served.status, JSON.stringify(await served.clone().json())).toBe(200);
    await activate(null);
    const revoked = await mintOn(sameGateway);
    expect(revoked.status).toBe(503);
    expect(((await revoked.json()) as { error: { detail?: { reason?: string } } }).error.detail?.reason).toBe("not_active");

    // V3 finding 5: activation CAS. Current active is null (just
    // deactivated). A stale replay that expects the OLD epoch is refused
    // (E_STALE_HEAD), so a captured activation cannot restore a revoked
    // grant; a same-value write is idempotent.
    const staleActivate = await activateRaw(plan.epoch, "cat-someother");
    expect(staleActivate.ok).toBe(false);
    expect(((await staleActivate.json()) as { error: { code: string } }).error.code).toBe("E_STALE_HEAD");
    const idempotent = await activateRaw(null, "expected-ignored-when-equal");
    expect(idempotent.ok).toBe(true);
    expect(((await idempotent.json()) as { idempotent?: boolean }).idempotent).toBe(true);

    // V3 finding 2 (P0): an activation grant FAILS CLOSED when the
    // authority cannot re-verify it past the grace window. TTL 0 makes
    // every request a re-verification; severing the catalog resolve
    // must flip the same gateway from serving to the named refusal —
    // never an indefinite stale grant.
    let severed = false;
    const flakyResolve = (destination: string) => {
      if (severed && destination === `scope:${CATALOG_SCOPE}`) throw new Error("catalog authority unreachable");
      return resolve(destination);
    };
    const graceState = netState("gateway-grace");
    const graceGateway = new NetGatewayDO(graceState.state, {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: flakyResolve,
      NET_ACTIVATION_TTL_MS: "0"
    } as NetGatewayEnv);
    await activate(plan.epoch);
    const graceMint = (key: string) =>
      graceGateway.fetch(
        new Request("https://do/net-api/session", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer apikey:${KEY_ID}:${KEY_SECRET}` },
          body: JSON.stringify({ ttl_ms: 60_000, idempotency_key: key })
        })
      );
    const graceServed = await graceMint("grace-1");
    expect(graceServed.status, JSON.stringify(await graceServed.clone().json())).toBe(200);
    severed = true;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 5)); // age past 3×TTL(0)
    const unverifiable = await graceMint("grace-2");
    expect(unverifiable.status).toBe(503);
    expect(((await unverifiable.json()) as { error: { detail?: { reason?: string } } }).error.detail?.reason).toBe(
      "activation_unverifiable"
    );
    graceState.close();
    states.forEach((st) => st.close());
  });
});
