// AP11 — signed-operator wizard provisioning (spec/identity/provisioning.md §AP11).
//
// The deployed lock this op exists to break: `$wiz` is a catalog seed, so a
// client turn planning at its anchor classifies as `catalog` and is refused
// (`unplannable_scope`); meanwhile programmer minting is quota-gated to zero and
// only a wizard can raise the quota. Nobody can act.
//
// These cases drive the REAL internal-signed gateway route against fake DOs:
// happy path (the provisioned agent mints its own session and commits a turn
// that exercises wizard-only authority), idempotent re-run, refusals, counter
// correctness, and the load-bearing property that the provisioned agent plans
// successfully while located nowhere.
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
import { routedApiKeyId, routedApiKeyScope } from "../../src/core/api-key-id";
import { hashSource } from "../../src/core/source-hash";

const SECRET = "net-provision-wizard-secret";
const EPOCH = "cat-provision-wizard-1";

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

type Harness = Awaited<ReturnType<typeof buildWorld>>;

/** A minimal but REAL net world: one signed-up human with an account, exported
 * through the ordinary install partitioning into a cluster scope plus catalog. */
async function buildWorld(options: { controlAgent?: boolean } = {}) {
  const old = createWorld();
  const start = await old.beginSignup("wizprov@woo.dev", "password123");
  const verify = old.verifySignup(start.verification_token);
  const human = verify.actor as string;
  const account = old.propOrNull(human, "account") as string;
  old.ensureApiKey("$wiz", human, "wizprov-human-key", "wizprov-human-secret", "human");

  // The CONTROL: an ordinary, human-provisioned, non-wizard agent in the same
  // cluster. Every "the provisioned agent has wizard authority" assertion is
  // paired with the same call from this actor, so the test proves authority
  // rather than merely that the call happens to succeed for anyone.
  let control: string | null = null;
  if (options.controlAgent) {
    const provisioned = (await old.directCall("control", human, human, "create_agent", ["PlainBot", "", false])) as unknown as {
      result: { actor_id: string };
    };
    control = provisioned.result.actor_id;
  }

  const cells = cellsFromSerialized(old.exportWorld());
  const partitions = partitionCells(cells);
  const relations = partitionInstallRelations(cells);
  partitions.set(CATALOG_SCOPE, [...(partitions.get(CATALOG_SCOPE) ?? []), netActivationCell(EPOCH)]);

  const states: Array<ReturnType<typeof netState>> = [];
  const scopeDOs = new Map<string, NetScopeDO>();
  let gateway!: NetGatewayDO;
  let auditDO!: NetAuditDO;
  const resolve = (destination: string) => {
    if (destination.startsWith("scope:")) {
      const instance = scopeDOs.get(destination.slice("scope:".length));
      if (instance) return instance;
    }
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
    const seeded = await instance.fetch(await signInternalRequest(scopeEnv, new Request("https://do/net/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, catalog_epoch: EPOCH, cells: partitions.get(scope) ?? [], relations: relations.get(scope) ?? [] })
    })));
    expect(seeded.ok, `seed ${scope}`).toBe(true);
    states.push(st);
    scopeDOs.set(scope, instance);
  }
  const gwState = netState("gateway-net-api");
  states.push(gwState);
  gateway = new NetGatewayDO(gwState.state, { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve, NET_AUDIT_SHARDS: "1" } as NetGatewayEnv);

  return {
    old, human, account, control, gateway, scopeDOs, scopeEnv, states,
    clusterScope: `cluster:${human}`,
    settleAll: async () => {
      for (const st of states) await st.settle();
      for (const s of scopeDOs.values()) await s.alarm();
      for (const st of states) await st.settle();
    },
    close: () => { for (const st of states) st.close(); }
  };
}

/** POST the signed operator op exactly as the edge forwards it. */
async function provision(h: Harness, body: unknown, secret = SECRET) {
  const request = new Request("https://do/net/provision-wizard", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const signed = secret === "" ? request : await signInternalRequest({ WOO_INTERNAL_SECRET: secret }, request);
  const response = await h.gateway.fetch(signed);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, any> : null };
}

async function clientFetch(h: Harness, method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const headers = new Headers();
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  const request = method === "GET"
    ? new Request(`https://do${path}`, { headers })
    : new Request(`https://do${path}`, {
        method,
        headers: (headers.set("content-type", "application/json"), headers),
        body: JSON.stringify(opts.body ?? {})
      });
  const response = await h.gateway.fetch(request);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

/** Install one operator-generated verifier through the EXISTING signed
 * credential-ensure route and return the presentable token. This is the second
 * half of the deploy-day runbook: the secret is generated here (i.e. on the
 * operator machine) and only its salted hash crosses the wire. A routed id is
 * also what lets a cold gateway find an anchored actor's authority cluster. */
async function ensureRoutedCredential(h: Harness, actor: string, nonce: string): Promise<string> {
  const id = routedApiKeyId(h.human, actor, nonce.repeat(32).slice(0, 32));
  expect(routedApiKeyScope(id)).toBe(h.clusterScope);
  const secret = nonce.repeat(64).slice(0, 64);
  const salt = nonce.repeat(32).slice(0, 32);
  const response = await h.scopeDOs.get(h.clusterScope)!.fetch(await signInternalRequest(h.scopeEnv, new Request("https://do/net/ensure-credential", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actor,
      id,
      record: { hash: hashSource(`${salt}:${secret}`), salt, actor, label: `${actor} operator credential`, created_at: 1 }
    })
  })));
  expect(response.ok, await response.clone().text()).toBe(true);
  await h.settleAll();
  return `apikey:${id}:${secret}`;
}

/** Read an authoritative property straight from the owning scope DO, so the
 * assertions never depend on the gateway's derived view. */
async function scopeProp(h: Harness, scope: string, object: string, name: string): Promise<unknown> {
  const instance = h.scopeDOs.get(scope);
  if (!instance) throw new Error(`no scope DO for ${scope}`);
  const response = await instance.fetch(await signInternalRequest(h.scopeEnv, new Request("https://do/net/closure", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keys: [`property_cell:${object}:${name}`], known: [] })
  })));
  const closure = await response.json() as { cells?: Array<{ key: string; value?: { value?: unknown } }> };
  return closure.cells?.find((cell) => cell.key === `property_cell:${object}:${name}`)?.value?.value;
}

async function scopeLineage(h: Harness, scope: string, object: string): Promise<Record<string, any> | undefined> {
  const instance = h.scopeDOs.get(scope);
  if (!instance) throw new Error(`no scope DO for ${scope}`);
  const response = await instance.fetch(await signInternalRequest(h.scopeEnv, new Request("https://do/net/closure", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keys: [`object_lineage:${object}`], known: [] })
  })));
  const closure = await response.json() as { cells?: Array<{ key: string; value?: unknown }> };
  return closure.cells?.find((cell) => cell.key === `object_lineage:${object}`)?.value as Record<string, any> | undefined;
}

describe("AP11 operator wizard provisioning (fake-DO lane)", () => {
  it("provisions a usable wizard agent, is idempotent, and keeps every counter honest", async () => {
    const h = await buildWorld({ controlAgent: true });
    try {
      // --- Baseline: the control agent exists, no programmer grant, no
      // operator-provisioned agent. ---
      expect(await scopeProp(h, h.clusterScope, h.account, "programmer_grant_quota")).toBe(0);
      expect(await scopeProp(h, h.clusterScope, h.account, "agent_count")).toBe(1);
      expect(await scopeProp(h, h.clusterScope, h.account, "programmer_agent_count")).toBe(0);

      const first = await provision(h, {
        human: h.human,
        provision_id: "ops-wizard-1",
        name: "OpsWizard",
        purpose: "operator break-glass"
      });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body?.ok).toBe(true);
      expect(first.body?.scope).toBe(h.clusterScope);
      const result = first.body?.result as Record<string, any>;
      const agent = result.actor_id as string;
      expect(agent, JSON.stringify(result)).toMatch(/^agent_/);
      expect(result.created).toBe(true);
      expect(result.promoted).toBe(true);
      expect(result.flagged).toBe(true);
      await h.settleAll();

      // --- Counters: one more agent, exactly one programmer, quota granted to
      // exactly the headroom consumed (never a blanket grant). ---
      expect(await scopeProp(h, h.clusterScope, h.account, "agent_count")).toBe(2);
      expect(await scopeProp(h, h.clusterScope, h.account, "programmer_agent_count")).toBe(1);
      expect(await scopeProp(h, h.clusterScope, h.account, "programmer_grant_quota")).toBe(1);
      // The default agent_quota is 5 and only 2 are used, so no headroom was
      // needed and `agent_quota` must be untouched.
      expect(await scopeProp(h, h.clusterScope, h.account, "agent_quota")).toBe(5);
      // `actors` already carries the primary human and the control agent.
      expect(await scopeProp(h, h.clusterScope, h.account, "actors")).toEqual([h.human, h.control, agent]);
      expect(await scopeProp(h, h.clusterScope, h.account, "operator_provisioned_agents"))
        .toEqual({ "ops-wizard-1": agent });

      // --- Authority AND surface: the two-gate model. A wizard-flagged agent
      // without the programmer surface would have authority but no tools. ---
      const lineage = await scopeLineage(h, h.clusterScope, agent);
      expect(lineage?.parent).toBe("$agent");
      expect(lineage?.owner).toBe(h.human);
      expect(lineage?.anchor).toBe(h.human);
      expect(lineage?.flags?.wizard).toBe(true);
      expect(lineage?.flags?.programmer).toBe(true);
      expect(await scopeProp(h, h.clusterScope, agent, "features")).toContain("$programmer");
      expect(await scopeProp(h, h.clusterScope, agent, "provision_id")).toBe("ops-wizard-1");

      // --- The agent is located NOWHERE. That is the whole point: a non-`$`
      // actor still plans at its own authority cluster, which `$wiz` cannot. ---
      const liveResponse = await h.scopeDOs.get(h.clusterScope)!.fetch(await signInternalRequest(h.scopeEnv, new Request("https://do/net/closure", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keys: [`object_live:${agent}`], known: [] })
      })));
      const live = await liveResponse.json() as { cells?: Array<{ key: string; value?: { location?: unknown } }> };
      expect(live.cells?.find((cell) => cell.key === `object_live:${agent}`)?.value?.location).toBe("$nowhere");

      // --- Idempotent re-run: same provision_id, nothing moves. ---
      const second = await provision(h, {
        human: h.human,
        provision_id: "ops-wizard-1",
        name: "OpsWizard",
        purpose: "operator break-glass"
      });
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      expect(second.body?.result?.actor_id).toBe(agent);
      expect(second.body?.result?.created).toBe(false);
      expect(second.body?.result?.promoted).toBe(false);
      expect(second.body?.result?.flagged).toBe(false);
      await h.settleAll();
      expect(await scopeProp(h, h.clusterScope, h.account, "agent_count")).toBe(2);
      expect(await scopeProp(h, h.clusterScope, h.account, "programmer_agent_count")).toBe(1);
      expect(await scopeProp(h, h.clusterScope, h.account, "programmer_grant_quota")).toBe(1);
      expect(await scopeProp(h, h.clusterScope, h.account, "actors")).toEqual([h.human, h.control, agent]);

      // --- Credential: the operator's locally generated verifier is installed
      // through the EXISTING signed credential route, bound to the agent the
      // provisioning op returned. The secret never transited either call. ---
      const token = await ensureRoutedCredential(h, agent, "1");

      // --- End to end: the provisioned agent mints its own session — while
      // located NOWHERE, which is what `$wiz` cannot do — and commits a turn
      // that requires WIZARD authority. `set_quota` is the exact primitive the
      // deployed world was deadlocked on: wizard-only, and the lever that lets
      // an account owner mint programmers for themselves afterwards. ---
      const minted = await clientFetch(h, "POST", "/net-api/session", { token, body: { ttl_ms: 600_000 } });
      expect(minted.status, JSON.stringify(minted.body)).toBe(200);
      const session = minted.body.session as string;
      // The session's planning anchor is the agent's own authority cluster, not
      // `catalog`: the refusal that bricks `$wiz` (`unplannable_scope`).
      expect(minted.body.active_scope ?? null).not.toBe(CATALOG_SCOPE);

      const quota = await clientFetch(h, "POST", "/net-api/turn", {
        token,
        body: { target: "$system", verb: "set_quota", args: [h.account, "agent_quota", 9], session, route: "direct" }
      });
      expect(quota.status, JSON.stringify(quota.body)).toBe(200);
      expect(quota.body?.reply?.status, JSON.stringify(quota.body).slice(0, 800)).toBe("accepted");
      expect(quota.body?.error, JSON.stringify(quota.body?.error)).toBeUndefined();
      await h.settleAll();
      expect(await scopeProp(h, h.clusterScope, h.account, "agent_quota")).toBe(9);

      // CONTROL: the same call from an ordinary agent in the same cluster is
      // E_PERM. Without this the assertion above would only prove that the call
      // works, not that the provisioned agent's wizard flag is what makes it.
      const controlToken = await ensureRoutedCredential(h, h.control as string, "4");
      const controlSession = await clientFetch(h, "POST", "/net-api/session", { token: controlToken, body: { ttl_ms: 600_000 } });
      expect(controlSession.status, JSON.stringify(controlSession.body)).toBe(200);
      const controlQuota = await clientFetch(h, "POST", "/net-api/turn", {
        token: controlToken,
        body: {
          target: "$system",
          verb: "set_quota",
          args: [h.account, "agent_quota", 42],
          session: controlSession.body.session as string,
          route: "direct"
        }
      });
      expect(controlQuota.body?.error?.code, JSON.stringify(controlQuota.body).slice(0, 800)).toBe("E_PERM");
      await h.settleAll();
      expect(await scopeProp(h, h.clusterScope, h.account, "agent_quota")).toBe(9);

      // --- A SECOND provision_id under the same account mints a second agent
      // and grants exactly one more unit of each quota. ---
      const third = await provision(h, { human: h.human, provision_id: "ops-wizard-2", name: "OpsWizard2" });
      expect(third.status, JSON.stringify(third.body)).toBe(200);
      const agent2 = third.body?.result?.actor_id as string;
      expect(agent2).not.toBe(agent);
      await h.settleAll();
      expect(await scopeProp(h, h.clusterScope, h.account, "agent_count")).toBe(3);
      expect(await scopeProp(h, h.clusterScope, h.account, "programmer_agent_count")).toBe(2);
      expect(await scopeProp(h, h.clusterScope, h.account, "programmer_grant_quota")).toBe(2);
      // The wizard's own set_quota above raised agent_quota to 9, so no further
      // headroom was needed here either.
      expect(await scopeProp(h, h.clusterScope, h.account, "agent_quota")).toBe(9);

      // --- The api_key_id pointer. A ROUTED id embeds the actor, so the
      // operator cannot generate it until provisioning has returned the agent —
      // the runbook therefore provisions, ensures the credential, then re-runs
      // provisioning with the id. That third call must record the pointer
      // WITHOUT minting anything, which is exactly the idempotent path. ---
      const pointerId = token.split(":")[1] as string;
      const pointer = await provision(h, { human: h.human, provision_id: "ops-wizard-1", api_key_id: pointerId });
      expect(pointer.status, JSON.stringify(pointer.body)).toBe(200);
      expect(pointer.body?.result?.actor_id).toBe(agent);
      expect(pointer.body?.result?.created).toBe(false);
      await h.settleAll();
      expect(await scopeProp(h, h.clusterScope, agent, "api_key_id")).toBe(pointerId);
      expect(await scopeProp(h, h.clusterScope, h.account, "agent_count")).toBe(3);

      // --- Retirement (AP11.7). `revoke_agent` is the lever, driven by the
      // OWNING HUMAN over the same client doorway: it strips programmer state,
      // revokes the key, deactivates the actor, and returns both counters. The
      // wizard flag is deliberately left set — a deactivated actor cannot
      // authenticate, so it grants nothing. ---
      const humanToken = await ensureRoutedCredential(h, h.human, "9");
      const humanSession = await clientFetch(h, "POST", "/net-api/session", { token: humanToken, body: { ttl_ms: 600_000 } });
      expect(humanSession.status, JSON.stringify(humanSession.body)).toBe(200);
      const revoked = await clientFetch(h, "POST", "/net-api/turn", {
        token: humanToken,
        body: { target: h.human, verb: "revoke_agent", args: [agent], session: humanSession.body.session, route: "direct" }
      });
      expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
      expect(revoked.body?.reply?.status, JSON.stringify(revoked.body).slice(0, 800)).toBe("accepted");
      expect(revoked.body?.error, JSON.stringify(revoked.body?.error)).toBeUndefined();
      await h.settleAll();
      expect(await scopeProp(h, h.clusterScope, agent, "deactivated_at")).toBeTruthy();
      expect(await scopeProp(h, h.clusterScope, h.account, "agent_count")).toBe(2);
      expect(await scopeProp(h, h.clusterScope, h.account, "programmer_agent_count")).toBe(1);
      expect((await scopeLineage(h, h.clusterScope, agent))?.flags?.programmer ?? false).toBe(false);

      // The retired wizard can no longer authenticate at all.
      const deadSession = await clientFetch(h, "POST", "/net-api/session", { token, body: { ttl_ms: 600_000 } });
      expect(deadSession.status, JSON.stringify(deadSession.body)).toBe(403);
      expect(deadSession.body?.error?.detail?.reason).toBe("identity_deactivated");

      // And its provision_id is not reusable: AP11.7 says take a new one.
      const reuse = await provision(h, { human: h.human, provision_id: "ops-wizard-1" });
      expect(reuse.status, JSON.stringify(reuse.body)).not.toBe(200);
      await h.settleAll();
      expect(await scopeProp(h, h.clusterScope, h.account, "agent_count")).toBe(2);
    } finally {
      h.close();
    }
  });

  it("refuses unsigned, wrong-secret, malformed, and unknown-human requests", async () => {
    const h = await buildWorld();
    try {
      const unsigned = await h.gateway.fetch(new Request("https://do/net/provision-wizard", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ human: h.human, provision_id: "nope" })
      }));
      expect(unsigned.status).toBe(401);

      const wrongSecret = await provision(h, { human: h.human, provision_id: "nope" }, "not-the-secret");
      expect(wrongSecret.status).toBe(401);

      expect((await provision(h, { provision_id: "x" })).status).toBe(400);
      expect((await provision(h, { human: h.human })).status).toBe(400);
      // A `$`-prefixed human is catalog substrate — the exact shape that cannot
      // host an account cluster, and the reason `$wiz` is unusable.
      expect((await provision(h, { human: "$wiz", provision_id: "x" })).status).toBe(400);
      expect((await provision(h, { human: h.human, provision_id: "bad id!" })).status).toBe(400);

      // A nonexistent human classifies to no authority cluster, or reaches the
      // primitive and refuses there. Either way it must not succeed.
      const missing = await provision(h, { human: "human_99", provision_id: "x" });
      expect(missing.status, JSON.stringify(missing.body)).not.toBe(200);

      // Nothing was provisioned by any refusal.
      expect(await scopeProp(h, h.clusterScope, h.account, "agent_count")).toBe(0);
      expect(await scopeProp(h, h.clusterScope, h.account, "programmer_grant_quota")).toBe(0);
      expect(await scopeProp(h, h.clusterScope, h.account, "operator_provisioned_agents")).toBeUndefined();
    } finally {
      h.close();
    }
  });
});
