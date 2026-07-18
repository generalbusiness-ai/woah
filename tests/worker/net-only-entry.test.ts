import { describe, expect, it } from "vitest";
import worker, { type NetOnlyEnv } from "../../src/worker/net-only-index";
import { FakeDurableObjectState } from "./fake-do";
import { NetScopeDO, type NetScopeDurableState } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";

function netState(name: string): { state: NetScopeDurableState; close: () => void } {
  const fake = new FakeDurableObjectState(name);
  return {
    state: {
      id: fake.id,
      storage: {
        sql: fake.storage.sql,
        transactionSync: fake.storage.transactionSync,
        setAlarm: () => {},
        deleteAlarm: () => {}
      }
    },
    close: () => fake.close()
  };
}

function harness() {
  const scopeState = netState("scope-catalog");
  let env: NetOnlyEnv;
  env = {
    WOO_INTERNAL_SECRET: "net-only-test-secret",
    NET_API_GATEWAY_SHARDS: "1",
    NET_RESOLVE: (destination: string) => {
      if (destination === "scope:catalog") return new NetScopeDO(scopeState.state, env);
      throw new Error(`unexpected destination ${destination}`);
    }
  };
  return { env, close: scopeState.close };
}

describe("net-only Worker entry", () => {
  it("retains the signed, world-state-free install readiness probe", async () => {
    const { env, close } = harness();
    const request = await signInternalRequest(env, new Request("https://woo.test/net-install/probe"));
    const response = await worker.fetch(request, env);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "net-scope" });
    close();
  });

  it("serves an authoritative net default and probes the catalog scope", async () => {
    const { env, close } = harness();
    const config = await worker.fetch(new Request("https://woo.test/client-config"), env);
    expect(await config.json()).toEqual({ net: true });
    expect(config.headers.get("cache-control")).toBe("no-store");

    const catalog = env.NET_RESOLVE!("scope:catalog");
    const seed = new Request("https://do/net/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "catalog", catalog_epoch: "net-only-test", cells: [] })
    });
    expect((await catalog.fetch(await signInternalRequest(env, seed))).status).toBe(200);

    const inactive = await worker.fetch(new Request("https://woo.test/healthz"), env);
    expect(inactive.status).toBe(503);
    expect(await inactive.json()).toMatchObject({ ok: false, net: true, reason: "not_active" });

    const activate = new Request("https://do/net/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "catalog",
        catalog_epoch: "net-only-test",
        active_epoch: "net-only-test",
        expected_active_epoch: null
      })
    });
    expect((await catalog.fetch(await signInternalRequest(env, activate))).status).toBe(200);

    const health = await worker.fetch(new Request("https://woo.test/healthz"), env);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, net: true });
    close();
  });

  it("retires legacy routes before the asset fallback", async () => {
    const { env, close } = harness();
    for (const path of ["/api/me", "/v2/turn-network/ws", "/connect"]) {
      const response = await worker.fetch(new Request(`https://woo.test${path}`), env);
      expect(response.status, path).toBe(410);
    }
    close();
  });

  it("mounts the operator admin dashboard without a WORLD binding", async () => {
    const { env, close } = harness();
    // Wired to handleAdmin, not the SPA fallback: with no ADMIN_PASSWORD it must
    // fail closed (503), never serve the asset shell.
    const disabled = await worker.fetch(new Request("https://woo.test/admin/"), env);
    expect(disabled.status).toBe(503);
    expect(await disabled.json()).toMatchObject({ error: { code: "E_ADMIN_DISABLED" } });

    // With the secret set: unauthenticated → 401 (auth precedes everything).
    env.ADMIN_PASSWORD = "hunter2";
    env.WOO_NET_DEFAULT = "on";
    const unauthorized = await worker.fetch(new Request("https://woo.test/admin/"), env);
    expect(unauthorized.status).toBe(401);

    // Authenticated guest purge returns the Net retirement 410 — and crucially
    // does not throw despite the Net-only env having no WOO namespace.
    const authorization = `Basic ${Buffer.from("admin:hunter2").toString("base64")}`;
    const purge = await worker.fetch(
      new Request("https://woo.test/admin/purge-inactive-guests", { method: "POST", headers: { authorization } }),
      env
    );
    expect(purge.status).toBe(410);
    expect(await purge.json()).toMatchObject({ error: { code: "E_GONE", detail: { net: true } } });
    close();
  });
});
