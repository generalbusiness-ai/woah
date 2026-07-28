// AP11.9 — the two deploy-only blockers, reproduced and closed.
//
// The deployed world was a fresh cutover, which means two things no fake-DO
// test had ever modelled:
//
//   1. it contains NO `$human` and no `$account` at all (verified against the
//      real install plan: zero instances of either in any partition), so AP11
//      had nothing to anchor to; and
//   2. it predates the AP11 primitive, and `repair-definitions` could only
//      REPLACE a verb page, never ADD one — so a genuinely new bootstrap verb
//      could not reach an aged world by any mechanism.
//
// This file builds exactly that world — catalog partition with the primitive's
// page removed, no human anywhere — and drives the whole operator runbook
// through the real signed routes.
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
import { verbCellSlot } from "../../src/net/verb-slots";
import { identityAnchorIds } from "../../src/net/identity-anchor";

const SECRET = "net-anchor-test-secret";
const EPOCH = "cat-anchor-1";
const AP11_VERB = "provision_wizard_agent";

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

/** A world shaped like the deployed one: no human, and (optionally) without the
 * AP11 verb page, so the primitive genuinely has to be installed. */
async function buildAgedWorld(options: { withPrimitive?: boolean } = {}) {
  const old = createWorld();
  const cells = cellsFromSerialized(old.exportWorld()).filter((cell) =>
    options.withPrimitive === true ||
    !(cell.kind === "verb_bytecode" && cell.object === "$human" && cell.name === AP11_VERB)
  );
  const partitions = partitionCells(cells);
  const relations = partitionInstallRelations(cells);
  partitions.set(CATALOG_SCOPE, [...(partitions.get(CATALOG_SCOPE) ?? []), netActivationCell(EPOCH)]);

  const states: Array<ReturnType<typeof netState>> = [];
  const scopeDOs = new Map<string, NetScopeDO>();
  let gateway!: NetGatewayDO;
  let auditDO!: NetAuditDO;
  const scopeEnv: NetScopeEnv = {
    WOO_INTERNAL_SECRET: SECRET,
    NET_RESOLVE: (destination: string) => resolve(destination),
    NET_AUDIT_SHARDS: "1"
  };
  // Scope DOs are created ON DEMAND: a genesis submit addresses a cluster that
  // does not exist yet, which is the whole point of the anchor op.
  const resolve = (destination: string) => {
    if (destination.startsWith("scope:")) {
      const scope = destination.slice("scope:".length);
      let instance = scopeDOs.get(scope);
      if (!instance) {
        const st = netState(`scope-${scope}`);
        instance = new NetScopeDO(st.state, scopeEnv);
        states.push(st);
        scopeDOs.set(scope, instance);
      }
      return instance;
    }
    if (destination.startsWith("gateway:")) return gateway;
    if (destination === "audit:audit-0") return auditDO;
    throw new Error(`unresolvable ${destination}`);
  };
  const auditState = netState("audit-0");
  auditDO = new NetAuditDO(auditState.state, { WOO_INTERNAL_SECRET: SECRET });
  states.push(auditState);
  for (const scope of partitions.keys()) {
    const instance = resolve(`scope:${scope}`) as NetScopeDO;
    const seeded = await instance.fetch(await signInternalRequest(scopeEnv, new Request("https://do/net/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, catalog_epoch: EPOCH, cells: partitions.get(scope) ?? [], relations: relations.get(scope) ?? [] })
    })));
    expect(seeded.ok, `seed ${scope}`).toBe(true);
  }
  const gwState = netState("gateway-net-api");
  states.push(gwState);
  gateway = new NetGatewayDO(gwState.state, { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve, NET_AUDIT_SHARDS: "1" } as NetGatewayEnv);

  return {
    old, gateway, scopeDOs, scopeEnv, states, cells,
    settleAll: async () => {
      for (const st of [...states]) await st.settle();
      for (const s of [...scopeDOs.values()]) await s.alarm();
      for (const st of [...states]) await st.settle();
    },
    close: () => { for (const st of states) st.close(); }
  };
}

type Aged = Awaited<ReturnType<typeof buildAgedWorld>>;

async function signedPost(h: Aged, path: string, body: unknown) {
  const response = await h.gateway.fetch(await signInternalRequest(
    { WOO_INTERNAL_SECRET: SECRET },
    new Request(`https://do${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  ));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, any> : null };
}

/** Drive the catalog scope's repair-definitions route exactly as the CLI does. */
async function repairDefinitions(h: Aged, cells: unknown[]) {
  const scope = h.scopeDOs.get(CATALOG_SCOPE)!;
  const response = await scope.fetch(await signInternalRequest(h.scopeEnv, new Request("https://do/net/repair-definitions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cells, remove: [] })
  })));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, any> : null };
}

async function catalogCell(h: Aged, key: string): Promise<{ value?: unknown } | undefined> {
  const scope = h.scopeDOs.get(CATALOG_SCOPE)!;
  const response = await scope.fetch(await signInternalRequest(h.scopeEnv, new Request("https://do/net/closure", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keys: [key], known: [] })
  })));
  const closure = await response.json() as { cells?: Array<{ key: string; value?: unknown }> };
  return closure.cells?.find((cell) => cell.key === key) as { value?: unknown } | undefined;
}

/** The bundled page for one bootstrap verb, as the CLI's fresh-plan allow-list
 * would supply it. */
function bundledVerbPage(h: Aged, object: string, name: string): Record<string, unknown> {
  const fresh = cellsFromSerialized(createWorld().exportWorld());
  const cell = fresh.find((c) => c.kind === "verb_bytecode" && c.object === object && c.name === name);
  if (!cell) throw new Error(`no bundled page for ${object}:${name}`);
  return { kind: "verb_bytecode", object, name, value: cell.value };
}

describe("AP11.9 operator anchor + aged-world primitive install (fake-DO lane)", () => {
  it("BLOCKER A: repair-definitions ADDs a new bootstrap verb, allocating its slot above the object's existing pages", async () => {
    const h = await buildAgedWorld();
    try {
      const key = `verb_bytecode:$human:${AP11_VERB}`;
      // The deployed precondition: the page is genuinely absent.
      expect(await catalogCell(h, key)).toBeUndefined();

      // Every slot $human's other verb pages hold, so the allocation can be
      // checked rather than assumed.
      const heldSlots = h.cells
        .filter((c) => c.kind === "verb_bytecode" && c.object === "$human")
        .map((c) => verbCellSlot(c.value))
        .filter((slot): slot is number => slot !== null);
      expect(heldSlots.length).toBeGreaterThan(0);

      const added = await repairDefinitions(h, [bundledVerbPage(h, "$human", AP11_VERB)]);
      expect(added.status, JSON.stringify(added.body)).toBe(200);
      expect(added.body?.status).toBe("applied");
      expect(added.body?.changed).toContain(key);

      const stored = await catalogCell(h, key);
      expect(stored).toBeDefined();
      const slot = verbCellSlot(stored?.value);
      // Allocated ABOVE every ordinal the object already holds — the same floor
      // the ordinary commit path demands of a new page, so an added verb can
      // never collide with a live one.
      expect(slot).toBe(Math.max(...heldSlots) + 1);

      // Idempotent: a second identical run changes nothing.
      const again = await repairDefinitions(h, [bundledVerbPage(h, "$human", AP11_VERB)]);
      expect(again.status).toBe(200);
      expect(again.body?.status).toBe("empty");
      expect(verbCellSlot((await catalogCell(h, key))?.value)).toBe(slot);
    } finally {
      h.close();
    }
  });

  it("BLOCKER A: a REPLACE keeps the ordinal the aged world holds, never the bundle's", async () => {
    // A bundled page carries the slot a FRESH install would give it, which has
    // no reason to match an aged world's numbering. Writing it verbatim could
    // move a live verb onto a sibling's ordinal — exactly the duplicate-slot
    // corruption the verb-slot repair exists to undo.
    const h = await buildAgedWorld({ withPrimitive: true });
    try {
      const key = "verb_bytecode:$human:create_agent";
      const before = await catalogCell(h, key);
      const heldSlot = verbCellSlot(before?.value);
      expect(heldSlot).not.toBeNull();

      // Hand the route a page claiming a DIFFERENT ordinal.
      const page = bundledVerbPage(h, "$human", "create_agent");
      const moved = { ...page, value: { ...(page.value as Record<string, unknown>), slot: (heldSlot as number) + 40 } };
      const replaced = await repairDefinitions(h, [moved]);
      expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);

      // The stored ordinal is unchanged: the authority owns it.
      expect(verbCellSlot((await catalogCell(h, key))?.value)).toBe(heldSlot);
    } finally {
      h.close();
    }
  });

  it("BLOCKER A: the ADD is still confined to installed $-classes and well-formed pages", async () => {
    const h = await buildAgedWorld();
    try {
      // A class this world does not hold.
      expect((await repairDefinitions(h, [{
        kind: "verb_bytecode", object: "$not_installed", name: "x", value: { name: "x" }
      }])).status).toBe(400);
      // A non-`$` object (an instance, not a bootstrap class).
      expect((await repairDefinitions(h, [{
        kind: "verb_bytecode", object: "the_weather", name: "x", value: { name: "x" }
      }])).status).toBe(400);
      // A page whose name disagrees with its key.
      expect((await repairDefinitions(h, [{
        kind: "verb_bytecode", object: "$human", name: "x", value: { name: "y" }
      }])).status).toBe(400);
      expect(await catalogCell(h, "verb_bytecode:$human:x")).toBeUndefined();
    } finally {
      h.close();
    }
  });

  it("BLOCKER B: the probe distinguishes missing human from missing primitive, and never mutates", async () => {
    const h = await buildAgedWorld();
    try {
      const { human } = identityAnchorIds("deadbeefdeadbeefdeadbeefdeadbeef");
      // (i) No human at all. Before this, the refusal was E_VERBNF — sending an
      // operator hunting for a missing verb when the identity was the problem.
      const noHuman = await signedPost(h, "/net/provision-wizard", { human, provision_id: "ops-1", probe: true });
      expect(noHuman.status, JSON.stringify(noHuman.body)).toBe(200);
      expect(noHuman.body?.human_present).toBe(false);
      // Both facts in ONE probe: this world lacks the human AND the primitive,
      // so one call is a complete plan rather than a round trip per problem.
      expect(noHuman.body?.primitive_installed).toBe(false);
      expect(JSON.stringify(noHuman.body?.next)).toMatch(/anchor/);
      expect(JSON.stringify(noHuman.body?.next)).toMatch(/repair:net-definitions/);

      // The non-probe call names the identity, not the verb.
      const refused = await signedPost(h, "/net/provision-wizard", { human, provision_id: "ops-1" });
      expect(refused.status).toBe(409);
      expect(refused.body?.error?.code).toBe("E_OBJNF");
      expect(refused.body?.error?.detail?.remedy).toMatch(/identity\/anchor/);

      // (ii) Human present, primitive absent.
      const seeded = await signedPost(h, "/net/provision-anchor", { anchor_id: "ops-anchor" });
      expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
      const seededHuman = seeded.body?.human as string;
      await h.settleAll();

      const noVerb = await signedPost(h, "/net/provision-wizard", { human: seededHuman, provision_id: "ops-1", probe: true });
      expect(noVerb.body?.human_present).toBe(true);
      expect(noVerb.body?.human_class).toContain("$human");
      expect(noVerb.body?.primitive_installed).toBe(false);
      expect(JSON.stringify(noVerb.body?.next)).toMatch(/repair:net-definitions/);
      expect(JSON.stringify(noVerb.body?.next)).not.toMatch(/anchor/);

      const verbRefused = await signedPost(h, "/net/provision-wizard", { human: seededHuman, provision_id: "ops-1" });
      expect(verbRefused.status).toBe(409);
      expect(verbRefused.body?.error?.code).toBe("E_VERBNF");

      // (iii) Both present.
      await repairDefinitions(h, [bundledVerbPage(h, "$human", AP11_VERB)]);
      const ready = await signedPost(h, "/net/provision-wizard", { human: seededHuman, provision_id: "ops-1", probe: true });
      expect(ready.body?.primitive_installed).toBe(true);
      expect(JSON.stringify(ready.body?.next)).toMatch(/ready/);

      // No probe mutated anything: nothing was provisioned.
      expect(ready.body?.recorded_agent ?? null).toBe(null);
    } finally {
      h.close();
    }
  });

  it("BLOCKER B: the anchor is a credential-less identity, idempotent on its token", async () => {
    const h = await buildAgedWorld();
    try {
      const first = await signedPost(h, "/net/provision-anchor", { anchor_id: "ops-anchor" });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body?.created).toBe(true);
      const human = first.body?.human as string;
      const account = first.body?.account as string;
      expect(first.body?.scope).toBe(`cluster:${human}`);
      await h.settleAll();

      const scope = h.scopeDOs.get(`cluster:${human}`)!;
      const read = async (key: string): Promise<unknown> => {
        const response = await scope.fetch(await signInternalRequest(h.scopeEnv, new Request("https://do/net/closure", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ keys: [key], known: [] })
        })));
        const closure = await response.json() as { cells?: Array<{ key: string; value?: { value?: unknown } }> };
        return closure.cells?.find((c) => c.key === key)?.value?.value;
      };

      // Both objects landed in ONE cluster, which is what keeps a later
      // promote/revoke turn single-scope and atomic.
      const humanLineage = await (async () => {
        const response = await scope.fetch(await signInternalRequest(h.scopeEnv, new Request("https://do/net/closure", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ keys: [`object_lineage:${human}`, `object_lineage:${account}`], known: [] })
        })));
        const closure = await response.json() as { cells?: Array<{ key: string; value?: any }> };
        return {
          human: closure.cells?.find((c) => c.key === `object_lineage:${human}`)?.value,
          account: closure.cells?.find((c) => c.key === `object_lineage:${account}`)?.value
        };
      })();
      expect(humanLineage.human?.parent).toBe("$human");
      expect(humanLineage.human?.anchor ?? null).toBe(null);
      expect(humanLineage.account?.parent).toBe("$account");
      expect(humanLineage.account?.anchor).toBe(human);

      expect(await read(`property_cell:${human}:account`)).toBe(account);
      expect(await read(`property_cell:${account}:primary_actor`)).toBe(human);
      expect(await read(`property_cell:${account}:actors`)).toEqual([human]);
      expect(await read(`property_cell:${account}:agent_count`)).toBe(0);
      // NOT pre-granted: AP11 grants exactly the headroom it consumes.
      expect(await read(`property_cell:${account}:programmer_grant_quota`)).toBe(0);
      expect(await read(`property_cell:${account}:signup_method`)).toBe("operator_anchor");

      // THE IDENTITY POSTURE: no credential of any kind exists on this account,
      // so nothing can authenticate AS the anchor. It is only an anchor.
      for (const field of ["password_hash", "password_salt", "oauth_identities"]) {
        expect(await read(`property_cell:${account}:${field}`), field).toBeUndefined();
      }

      // Idempotent on the token: same ids, no second commit.
      const again = await signedPost(h, "/net/provision-anchor", { anchor_id: "ops-anchor" });
      expect(again.status).toBe(200);
      expect(again.body?.created).toBe(false);
      expect(again.body?.human).toBe(human);
      expect(again.body?.account).toBe(account);

      // A different token is a different identity.
      const other = await signedPost(h, "/net/provision-anchor", { anchor_id: "ops-anchor-2" });
      expect(other.body?.human).not.toBe(human);

      // A probe run resolves the token to its ids WITHOUT creating anything —
      // which is what lets the operator's read-only probe start from a token.
      const probeOther = await signedPost(h, "/net/provision-anchor", { anchor_id: "ops-anchor-3", probe: true });
      expect(probeOther.status).toBe(200);
      expect(probeOther.body?.probe).toBe(true);
      expect(probeOther.body?.exists).toBe(false);
      expect(probeOther.body?.created).toBe(false);
      const probedHuman = probeOther.body?.human as string;
      await h.settleAll();
      // Nothing was committed: a real run afterwards still reports created.
      const realised = await signedPost(h, "/net/provision-anchor", { anchor_id: "ops-anchor-3" });
      expect(realised.body?.created).toBe(true);
      expect(realised.body?.human).toBe(probedHuman);
      // ...and probing an EXISTING anchor reports it exists.
      const probeExisting = await signedPost(h, "/net/provision-anchor", { anchor_id: "ops-anchor-3", probe: true });
      expect(probeExisting.body?.exists).toBe(true);

      // Malformed tokens refuse.
      expect((await signedPost(h, "/net/provision-anchor", { anchor_id: "bad token" })).status).toBe(400);
      expect((await signedPost(h, "/net/provision-anchor", {})).status).toBe(400);
    } finally {
      h.close();
    }
  });

  it("THE RUNBOOK: anchor -> install primitive -> provision, on a world that had neither", async () => {
    const h = await buildAgedWorld();
    try {
      // 1. Seed the anchor.
      const anchor = await signedPost(h, "/net/provision-anchor", { anchor_id: "ops-anchor" });
      expect(anchor.status, JSON.stringify(anchor.body)).toBe(200);
      const human = anchor.body?.human as string;
      await h.settleAll();

      // 2. Install the primitive the aged world predates.
      const installed = await repairDefinitions(h, [bundledVerbPage(h, "$human", AP11_VERB)]);
      expect(installed.status, JSON.stringify(installed.body)).toBe(200);
      await h.settleAll();

      // 3. Provision — the step that returned E_VERBNF on the deployed world.
      const provisioned = await signedPost(h, "/net/provision-wizard", {
        human,
        provision_id: "ops-wizard-1",
        name: "OpsWizard",
        purpose: "operator break-glass"
      });
      expect(provisioned.status, JSON.stringify(provisioned.body).slice(0, 900)).toBe(200);
      const result = provisioned.body?.result as Record<string, any>;
      expect(result.created).toBe(true);
      expect(result.promoted).toBe(true);
      expect(result.flagged).toBe(true);
      expect(result.actor_id).toMatch(/^agent_/);
      await h.settleAll();

      // The agent really is a wizard with the authoring surface, in the
      // anchor's cluster.
      const scope = h.scopeDOs.get(`cluster:${human}`)!;
      const response = await scope.fetch(await signInternalRequest(h.scopeEnv, new Request("https://do/net/closure", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keys: [`object_lineage:${result.actor_id}`, `property_cell:${result.actor_id}:features`], known: [] })
      })));
      const closure = await response.json() as { cells?: Array<{ key: string; value?: any }> };
      const lineage = closure.cells?.find((c) => c.key === `object_lineage:${result.actor_id}`)?.value;
      expect(lineage?.flags?.wizard).toBe(true);
      expect(lineage?.flags?.programmer).toBe(true);
      expect(lineage?.owner).toBe(human);
      expect(closure.cells?.find((c) => c.key === `property_cell:${result.actor_id}:features`)?.value?.value)
        .toContain("$programmer");

      // Re-running the whole runbook converges.
      expect((await signedPost(h, "/net/provision-anchor", { anchor_id: "ops-anchor" })).body?.created).toBe(false);
      expect((await repairDefinitions(h, [bundledVerbPage(h, "$human", AP11_VERB)])).body?.status).toBe("empty");
      const rerun = await signedPost(h, "/net/provision-wizard", {
        human, provision_id: "ops-wizard-1", name: "OpsWizard", purpose: "operator break-glass"
      });
      expect(rerun.body?.result?.actor_id).toBe(result.actor_id);
      expect(rerun.body?.result?.created).toBe(false);
    } finally {
      h.close();
    }
  });
});
