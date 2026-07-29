import { describe, expect, it } from "vitest";
import worker, { type NetOnlyEnv } from "../../src/worker/net-only-index";
import { NetScopeDO, type NetScopeDurableState } from "../../src/worker/net/scope-do";
import { signInternalRequest, verifyInternalRequest } from "../../src/worker/internal-auth";
import { routedApiKeyId } from "../../src/core/api-key-id";
import { closeQuiescent, quiescentNetState as netState } from "./quiescent-do";


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
  return { env, close: async () => closeQuiescent([scopeState]) };
}

describe("net-only Worker entry", () => {
  it("serves the marketing root on the landing host, preserves protocol routes, and redirects human paths", async () => {
    const { env, close } = harness();
    const assetPaths: string[] = [];
    env.ASSETS = {
      fetch: async (request: Request) => {
        assetPaths.push(new URL(request.url).pathname);
        return new Response(`asset:${new URL(request.url).pathname}`);
      }
    } as unknown as Fetcher;
    for (const path of ["/", "/index.html", "/landing", "/landing.html"]) {
      const response = await worker.fetch(new Request(`https://woah.generalbusiness.ai${path}`), env);
      expect(response.status, path).toBe(200);
      expect(await response.text()).toBe("asset:/landing");
    }
    expect(assetPaths).toEqual(["/landing", "/landing", "/landing", "/landing"]);

    const protocol = await worker.fetch(new Request("https://woah.generalbusiness.ai/healthz"), env);
    expect(protocol.status).toBe(503);
    expect(protocol.headers.get("location")).toBeNull();

    const redirected = await worker.fetch(new Request("https://woah.generalbusiness.ai/docs/getting-started?q=1"), env);
    expect(redirected.status).toBe(308);
    expect(redirected.headers.get("location")).toBe("https://woah1.generalbusiness.ai/docs/getting-started?q=1");
    await close();
  });

  it("keeps credential ensure internal-signed and routes only the verifier to its authority", async () => {
    const { env, close } = harness();
    const scope = env.NET_RESOLVE!("scope:catalog");
    const seed = new Request("https://do/net/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "catalog",
        catalog_epoch: "net-only-credential",
        cells: [{ kind: "object_lineage", object: "$wiz", value: { parent: "$player", anchor: null } }],
        relations: []
      })
    });
    expect((await scope.fetch(await signInternalRequest(env, seed))).status).toBe(200);

    const id = routedApiKeyId("$wiz", "$wiz", "33333333333333333333333333333333");
    const body = {
      authority_scope: "catalog",
      actor: "$wiz",
      id,
      record: {
        hash: "6".repeat(64),
        salt: "7".repeat(32),
        actor: "$wiz",
        label: "operator",
        created_at: 5
      }
    };
    const unsigned = await worker.fetch(new Request("https://woo.test/net-operator/credentials/ensure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }), env);
    expect(unsigned.status).toBe(401);

    const signed = await signInternalRequest(env, new Request("https://woo.test/net-operator/credentials/ensure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }));
    const ensured = await worker.fetch(signed, env);
    expect(ensured.status, await ensured.clone().text()).toBe(200);
    expect(await ensured.json()).toMatchObject({ ok: true, status: "applied", actor: "$wiz", id });

    // Exact semantic replay is success without another head advance. JSON
    // object insertion order is transport trivia, not a verifier collision.
    const reorderedBody = {
      authority_scope: body.authority_scope,
      actor: body.actor,
      id: body.id,
      record: {
        created_at: body.record.created_at,
        label: body.record.label,
        actor: body.record.actor,
        salt: body.record.salt,
        hash: body.record.hash
      }
    };
    const replayed = await worker.fetch(await signInternalRequest(env, new Request("https://woo.test/net-operator/credentials/ensure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reorderedBody)
    })), env);
    expect(await replayed.json()).toMatchObject({ ok: true, status: "empty", actor: "$wiz", id });
    await close();
  });

  it("keeps account repair internal-signed and forwards only addressing facts to the named authority", async () => {
    const forwarded: Array<{ url: string; body: unknown }> = [];
    const env: NetOnlyEnv = {
      WOO_INTERNAL_SECRET: "net-only-account-repair-secret",
      NET_RESOLVE: (destination: string) => {
        if (destination !== "scope:cluster:human_repair") {
          throw new Error(`unexpected destination ${destination}`);
        }
        return {
          fetch: async (request: Request) => {
            await verifyInternalRequest(env, request.clone());
            forwarded.push({ url: request.url, body: await request.clone().json() });
            return new Response(JSON.stringify({
              ok: true,
              kind: "woo.account_state_repair.v1",
              status: "would_apply",
              dry_run: true,
              changed: ["property_cell:account_repair:agent_count"],
              conflicts: []
            }), { headers: { "content-type": "application/json" } });
          }
        } as unknown as ReturnType<NonNullable<NetOnlyEnv["NET_RESOLVE"]>>;
      }
    };
    const body = {
      authority_scope: "cluster:human_repair",
      account: "account_repair",
      human: "human_repair",
      candidates: [],
      dry_run: true
    };
    const unsigned = await worker.fetch(new Request("https://woo.test/net-operator/account/repair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }), env);
    expect(unsigned.status).toBe(401);
    expect(forwarded).toEqual([]);

    const repaired = await worker.fetch(await signInternalRequest(env, new Request("https://woo.test/net-operator/account/repair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    })), env);
    expect(repaired.status, await repaired.clone().text()).toBe(200);
    expect(forwarded).toEqual([{
      url: "https://do/net/repair-account-state",
      body
    }]);
    const applyBody = {
      ...body,
      dry_run: false,
      review_token: `sha256:${"a".repeat(64)}`
    };
    const applied = await worker.fetch(await signInternalRequest(env, new Request("https://woo.test/net-operator/account/repair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(applyBody)
    })), env);
    expect(applied.status, await applied.clone().text()).toBe(200);
    expect(forwarded.at(-1)).toEqual({
      url: "https://do/net/repair-account-state",
      body: applyBody
    });

    // The edge never accepts a catalog/global target or a body without the
    // concrete account family; malformed addressing reaches no authority.
    const malformed = await worker.fetch(await signInternalRequest(env, new Request("https://woo.test/net-operator/account/repair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ authority_scope: "catalog", account: "account_repair" })
    })), env);
    expect(malformed.status).toBe(400);
    expect(forwarded).toHaveLength(2);
    for (const invalidBody of [null, 7, [], "account_repair"]) {
      const invalid = await worker.fetch(await signInternalRequest(env, new Request("https://woo.test/net-operator/account/repair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(invalidBody)
      })), env);
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({
        error: { code: "E_INVARG" }
      });
    }
    expect(forwarded).toHaveLength(2);

    // A missing/malformed dry_run must never be interpreted as apply, and
    // the value-free contract rejects fields that could look like operator
    // instructions to a future implementation.
    const implicitApply = await worker.fetch(await signInternalRequest(env, new Request("https://woo.test/net-operator/account/repair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authority_scope: "cluster:human_repair",
        account: "account_repair",
        human: "human_repair",
        candidates: []
      })
    })), env);
    expect(implicitApply.status).toBe(400);
    const inventedValue = await worker.fetch(await signInternalRequest(env, new Request("https://woo.test/net-operator/account/repair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, agent_count: 4 })
    })), env);
    expect(inventedValue.status).toBe(400);
    const malformedToken = await worker.fetch(await signInternalRequest(env, new Request("https://woo.test/net-operator/account/repair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, dry_run: false, review_token: 7 })
    })), env);
    expect(malformedToken.status).toBe(400);
    expect(forwarded).toHaveLength(2);
  });

  it("forwards the AP11 wizard provisioning op to a gateway shard, freshly signed", async () => {
    const scopeState = netState("scope-catalog-provision");
    const forwarded: Array<{ url: string; body: unknown; signedForGateway: boolean }> = [];
    let env: NetOnlyEnv;
    env = {
      WOO_INTERNAL_SECRET: "net-only-test-secret",
      NET_API_GATEWAY_SHARDS: "1",
      NET_RESOLVE: (destination: string) => {
        if (destination === "scope:catalog") return new NetScopeDO(scopeState.state, env);
        if (destination.startsWith("gateway:")) {
          return {
            fetch: async (request: Request) => {
              // The trusted hop must be signed by the EDGE, never by inheriting
              // an inbound header.
              await signInternalRequest(env, request.clone());
              forwarded.push({
                url: request.url,
                body: await request.clone().json(),
                signedForGateway: request.headers.has("x-woo-internal-signature")
                  || [...request.headers.keys()].some((name) => name.toLowerCase().startsWith("x-woo-internal-"))
              });
              return new Response(JSON.stringify({ ok: true, scope: "cluster:human_2", result: { actor_id: "agent_7" } }), {
                headers: { "content-type": "application/json" }
              });
            }
          } as unknown as ReturnType<NonNullable<NetOnlyEnv["NET_RESOLVE"]>>;
        }
        throw new Error(`unexpected destination ${destination}`);
      }
    };

    const body = { human: "human_2", provision_id: "ops-wizard-1", name: "OpsWizard" };
    const unsigned = await worker.fetch(new Request("https://woo.test/net-operator/wizard/provision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }), env);
    expect(unsigned.status).toBe(401);
    expect(forwarded).toHaveLength(0);

    const signed = await worker.fetch(await signInternalRequest(env, new Request("https://woo.test/net-operator/wizard/provision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    })), env);
    expect(signed.status, await signed.clone().text()).toBe(200);
    expect(await signed.json()).toMatchObject({ ok: true, result: { actor_id: "agent_7" } });
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.url).toBe("https://do/net/provision-wizard");
    expect(forwarded[0]!.body).toEqual(body);
    expect(forwarded[0]!.signedForGateway).toBe(true);

    // A body without a human never reaches a DO.
    const malformed = await worker.fetch(await signInternalRequest(env, new Request("https://woo.test/net-operator/wizard/provision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provision_id: "x" })
    })), env);
    expect(malformed.status).toBe(400);
    // The allow-list is exact: no sibling operator path exists.
    const unknown = await worker.fetch(await signInternalRequest(env, new Request("https://woo.test/net-operator/wizard/demote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    })), env);
    expect(unknown.status).toBe(404);
    expect(forwarded).toHaveLength(1);

    // AP11.9: the identity-anchor op is the sibling that DOES exist, and is
    // gated identically.
    const anchorBody = { anchor_id: "ops-anchor" };
    const anchorUnsigned = await worker.fetch(new Request("https://woo.test/net-operator/identity/anchor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(anchorBody)
    }), env);
    expect(anchorUnsigned.status).toBe(401);
    expect(forwarded).toHaveLength(1);

    const anchorSigned = await worker.fetch(await signInternalRequest(env, new Request("https://woo.test/net-operator/identity/anchor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(anchorBody)
    })), env);
    expect(anchorSigned.status, await anchorSigned.clone().text()).toBe(200);
    expect(forwarded).toHaveLength(2);
    expect(forwarded[1]!.url).toBe("https://do/net/provision-anchor");
    expect(forwarded[1]!.body).toEqual(anchorBody);
    expect(forwarded[1]!.signedForGateway).toBe(true);

    // A body without a token never reaches a DO.
    const anchorMalformed = await worker.fetch(await signInternalRequest(env, new Request("https://woo.test/net-operator/identity/anchor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    })), env);
    expect(anchorMalformed.status).toBe(400);
    expect(forwarded).toHaveLength(2);
    await closeQuiescent([scopeState]);
  });

  it("retains the signed, world-state-free install readiness probe", async () => {
    const { env, close } = harness();
    const request = await signInternalRequest(env, new Request("https://woo.test/net-install/probe"));
    const response = await worker.fetch(request, env);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "net-scope" });
    await close();
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
    await close();
  });

  it("retires legacy routes before the asset fallback", async () => {
    const { env, close } = harness();
    for (const path of ["/api/me", "/v2/turn-network/ws", "/connect"]) {
      const response = await worker.fetch(new Request(`https://woo.test${path}`), env);
      expect(response.status, path).toBe(410);
    }
    await close();
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
    await close();
  });
});
