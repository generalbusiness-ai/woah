import { describe, expect, it } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { routedApiKeyId } from "../../src/core/api-key-id";

const SECRET = "net-account-state-repair-secret";
const HUMAN = "human_repair";
const ACCOUNT = "account_repair";
const AGENT = "agent_repair";
const CLUSTER = `cluster:${HUMAN}`;
const KEY = routedApiKeyId(HUMAN, AGENT, "44444444444444444444444444444444");

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

function prop(object: string, name: string, value: unknown) {
  return { kind: "property_cell" as const, object, name, value: { value } };
}

function propDef(object: string, name: string) {
  return {
    kind: "property_cell" as const,
    object,
    name,
    value: { value: null, def: { name } }
  };
}

function identityRoleCells() {
  return [
    {
      kind: "object_lineage" as const,
      object: "$account",
      value: { parent: null, owner: "$wiz", name: "Account class", anchor: null, flags: {} }
    },
    {
      kind: "object_lineage" as const,
      object: "$human",
      value: { parent: null, owner: "$wiz", name: "Human class", anchor: null, flags: {} }
    },
    {
      kind: "object_lineage" as const,
      object: "$agent",
      value: { parent: null, owner: "$wiz", name: "Agent class", anchor: null, flags: {} }
    },
    ...["actors", "primary_actor", "agent_count", "programmer_agent_count", "operator_provisioned_agents"]
      .map((name) => propDef("$account", name)),
    propDef("$human", "account"),
    ...["api_key_id", "created_via", "deactivated_at", "retired_at", "provision_id"]
      .map((name) => propDef("$agent", name))
  ];
}

function lookalikeIdentityRoleCells() {
  return [
    {
      kind: "object_lineage" as const,
      object: "$lookalike_account_class",
      value: { parent: null, owner: "$wiz", name: "Account-shaped class", anchor: null, flags: {} }
    },
    {
      kind: "object_lineage" as const,
      object: "$lookalike_human_class",
      value: { parent: null, owner: "$wiz", name: "Human-shaped class", anchor: null, flags: {} }
    },
    {
      kind: "object_lineage" as const,
      object: "$lookalike_agent_class",
      value: { parent: null, owner: "$wiz", name: "Agent-shaped class", anchor: null, flags: {} }
    },
    ...["actors", "primary_actor", "agent_count", "programmer_agent_count", "operator_provisioned_agents"]
      .map((name) => propDef("$lookalike_account_class", name)),
    propDef("$lookalike_human_class", "account"),
    ...["api_key_id", "created_via", "deactivated_at", "retired_at", "provision_id"]
      .map((name) => propDef("$lookalike_agent_class", name))
  ];
}

describe("Net account-state historical repair", () => {
  it("dry-runs, commits atomically on the owning scope, and replays as empty", async () => {
    const catalogState = netState("account-repair-catalog");
    const clusterState = netState("account-repair-cluster");
    let catalog: NetScopeDO;
    let cluster: NetScopeDO;
    let catalogPause: Promise<void> | null = null;
    let catalogPauseEntered: (() => void) | null = null;
    const env: NetScopeEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        if (destination === "scope:catalog") {
          return {
            fetch: async (request: Request) => {
              if (catalogPause) {
                catalogPauseEntered?.();
                await catalogPause;
              }
              return catalog.fetch(request);
            }
          } as unknown as NetScopeDO;
        }
        if (destination === `scope:${CLUSTER}`) return cluster;
        throw new Error(`unexpected destination ${destination}`);
      }
    };
    catalog = new NetScopeDO(catalogState.state, env);
    cluster = new NetScopeDO(clusterState.state, env);

    const seed = async (scope: NetScopeDO, name: string, cells: unknown[]) => {
      const response = await scope.fetch(await signInternalRequest(env, new Request("https://do/net/seed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: name,
          catalog_epoch: "account-repair-epoch",
          cells,
          relations: []
        })
      })));
      expect(response.status, await response.clone().text()).toBe(200);
    };
    await seed(catalog, "catalog", [
      {
        kind: "object_lineage",
        object: "$system",
        value: { parent: "$root", owner: "$wiz", name: "System", anchor: null, flags: {} }
      },
      prop("$system", "programmer_surface", "$programmer"),
      ...identityRoleCells()
    ]);
    await seed(cluster, CLUSTER, [
      {
        kind: "object_lineage",
        object: HUMAN,
        value: { parent: "$human", owner: "$wiz", name: "Human", anchor: null, flags: {} }
      },
      {
        kind: "object_lineage",
        object: ACCOUNT,
        value: { parent: "$account", owner: "$wiz", name: "Account", anchor: HUMAN, flags: {} }
      },
      {
        kind: "object_lineage",
        object: AGENT,
        value: { parent: "$agent", owner: HUMAN, name: "Agent", anchor: HUMAN, flags: { programmer: true } }
      },
      prop(HUMAN, "account", ACCOUNT),
      prop(ACCOUNT, "primary_actor", HUMAN),
      prop(ACCOUNT, "actors", [HUMAN, AGENT, AGENT]),
      prop(ACCOUNT, "operator_provisioned_agents", {}),
      prop(ACCOUNT, "agent_count", 9),
      prop(ACCOUNT, "programmer_agent_count", 8),
      prop(AGENT, "created_via", "wizard"),
      prop(AGENT, "purpose", ""),
      prop(AGENT, "scope", "write"),
      prop(AGENT, "features", ["$programmer"]),
      prop(AGENT, "api_key_id", KEY),
      prop(AGENT, "api_keys", {
        [KEY]: {
          actor: AGENT,
          hash: "a".repeat(64),
          salt: "b".repeat(32),
          created_at: 1,
          revoked_at: null
        }
      }),
      prop(AGENT, "retired_at", 1234),
      prop(AGENT, "deactivated_at", null)
    ]);

    const call = async (dryRun: boolean) => {
      return cluster.fetch(await signInternalRequest(env, new Request("https://do/net/repair-account-state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: ACCOUNT, human: HUMAN, candidates: [], dry_run: dryRun })
      })));
    };
    const credentialRecord = async () => {
      const response = await cluster.fetch(await signInternalRequest(env, new Request("https://do/net/credential-record", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: AGENT, id: KEY })
      })));
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json() as { record: Record<string, unknown> | null }).record;
    };
    const authorityHead = async () => {
      const response = await cluster.fetch(await signInternalRequest(env, new Request("https://do/net/head")));
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json() as { head: { seq: number; hash: string; generation: number } }).head;
    };
    const apiKeysValue = async () => {
      const response = await cluster.fetch(await signInternalRequest(env, new Request("https://do/net/closure", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keys: [`property_cell:${AGENT}:api_keys`], known: [] })
      })));
      expect(response.status, await response.clone().text()).toBe(200);
      const cells = (await response.json() as {
        cells: Array<{ key: string; value: { value: Record<string, { revoked_at: number | null }> } }>;
      }).cells;
      const cell = cells.find((entry) => entry.key === `property_cell:${AGENT}:api_keys`);
      expect(cell).toBeTruthy();
      if (!cell) throw new Error("missing api_keys cell");
      return cell.value.value;
    };
    const unsigned = await cluster.fetch(new Request("https://do/net/repair-account-state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: ACCOUNT, human: HUMAN, candidates: [], dry_run: true })
    }));
    expect(unsigned.status).toBe(401);
    const nullBody = await cluster.fetch(await signInternalRequest(env, new Request("https://do/net/repair-account-state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null"
    })));
    expect(nullBody.status).toBe(400);
    expect(await nullBody.text()).toContain("E_INVARG");
    const implicitApply = await cluster.fetch(await signInternalRequest(env, new Request("https://do/net/repair-account-state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: ACCOUNT, human: HUMAN, candidates: [] })
    })));
    expect(implicitApply.status).toBe(400);
    expect(await credentialRecord()).toMatchObject({ actor: AGENT, revoked_at: null });

    const dry = await call(true);
    expect(dry.status, await dry.clone().text()).toBe(200);
    expect(await dry.json()).toMatchObject({
      ok: true,
      status: "would_apply",
      dry_run: true,
      conflicts: []
    });
    const dryReceipt = await (await call(true)).json() as Record<string, any>;
    expect(JSON.stringify(dryReceipt)).not.toContain("a".repeat(64));
    expect(JSON.stringify(dryReceipt)).not.toContain("b".repeat(32));
    expect(dryReceipt.patches).toEqual(expect.arrayContaining([{
      kind: "property",
      object: AGENT,
      name: "api_keys",
      reason: expect.any(String)
    }]));
    expect(dryReceipt.patches.some((patch: Record<string, unknown>) =>
      "before" in patch || "after" in patch
    )).toBe(false);

    // Fault the last leg of the owner transaction after the public api_keys
    // cell and its authority-private verifier row have both been mutated.
    // The SQL abort plus discardSeqOnThrow must roll back all representations,
    // the head, and the outbox — both immediately and after cold rehydrate.
    clusterState.state.storage.sql.exec(
      "INSERT INTO net_scope_subscribers (destination, role, delivery_seq) VALUES ('gateway:repair-rollback', 'fanout', 0)"
    );
    clusterState.state.storage.sql.exec(
      "CREATE TRIGGER fail_account_repair_outbox BEFORE INSERT ON net_scope_outbox BEGIN SELECT RAISE(ABORT, 'injected account repair outbox failure'); END"
    );
    const beforeFaultHead = await authorityHead();
    const beforeFaultTail = (
      clusterState.state.storage.sql.exec("SELECT seq, body FROM net_scope_tail ORDER BY seq") as {
        toArray(): Array<{ seq: number; body: string }>;
      }
    ).toArray();
    const faulted = await call(false);
    expect(faulted.status).toBe(500);
    expect(await faulted.text()).toContain("injected account repair outbox failure");
    expect(await authorityHead()).toEqual(beforeFaultHead);
    expect(await credentialRecord()).toMatchObject({ actor: AGENT, revoked_at: null });
    expect((await apiKeysValue())[KEY].revoked_at).toBeNull();
    expect((
      clusterState.state.storage.sql.exec("SELECT COUNT(*) AS n FROM net_scope_outbox") as {
        toArray(): Array<{ n: number }>;
      }
    ).toArray()[0].n).toBe(0);
    expect((
      clusterState.state.storage.sql.exec("SELECT seq, body FROM net_scope_tail ORDER BY seq") as {
        toArray(): Array<{ seq: number; body: string }>;
      }
    ).toArray()).toEqual(beforeFaultTail);

    cluster = new NetScopeDO(clusterState.state, env);
    expect(await authorityHead()).toEqual(beforeFaultHead);
    expect(await credentialRecord()).toMatchObject({ actor: AGENT, revoked_at: null });
    expect((await apiKeysValue())[KEY].revoked_at).toBeNull();
    expect((
      clusterState.state.storage.sql.exec("SELECT COUNT(*) AS n FROM net_scope_outbox") as {
        toArray(): Array<{ n: number }>;
      }
    ).toArray()[0].n).toBe(0);
    expect((
      clusterState.state.storage.sql.exec("SELECT seq, body FROM net_scope_tail ORDER BY seq") as {
        toArray(): Array<{ seq: number; body: string }>;
      }
    ).toArray()).toEqual(beforeFaultTail);
    clusterState.state.storage.sql.exec("DROP TRIGGER fail_account_repair_outbox");

    const applied = await call(false);
    expect(applied.status, await applied.clone().text()).toBe(200);
    const receipt = await applied.json() as Record<string, any>;
    expect(receipt).toMatchObject({ ok: true, status: "applied", dry_run: false });
    expect(receipt.head.seq).toBe(beforeFaultHead.seq + 1);
    expect(receipt.changed).toEqual(expect.arrayContaining([
      `object_lineage:${AGENT}`,
      `property_cell:${AGENT}:deactivated_at`,
      `property_cell:${AGENT}:api_keys`,
      `property_cell:${ACCOUNT}:actors`,
      `property_cell:${ACCOUNT}:agent_count`,
      `property_cell:${ACCOUNT}:programmer_agent_count`
    ]));
    // The authority-private verifier index is part of the same owner
    // transaction as actor.api_keys. Authentication must see the revocation
    // immediately, not only after the DO later rebuilds its index.
    expect(await credentialRecord()).toMatchObject({ actor: AGENT, revoked_at: 1234 });
    const outbox = (
      clusterState.state.storage.sql.exec(
        "SELECT body FROM net_scope_outbox WHERE route = '/fanout' AND destination = 'gateway:repair-rollback'"
      ) as { toArray(): Array<{ body: string }> }
    ).toArray();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].body).toContain(`property_cell:${AGENT}:api_keys`);

    const closure = await cluster.fetch(await signInternalRequest(env, new Request("https://do/net/closure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        keys: [
          `object_lineage:${AGENT}`,
          `property_cell:${AGENT}:features`,
          `property_cell:${AGENT}:api_keys`,
          `property_cell:${AGENT}:deactivated_at`,
          `property_cell:${ACCOUNT}:actors`,
          `property_cell:${ACCOUNT}:agent_count`,
          `property_cell:${ACCOUNT}:programmer_agent_count`
        ],
        known: []
      })
    })));
    const cells = (await closure.json() as { cells: Array<{ key: string; value: any }> }).cells;
    const value = (key: string) => cells.find((cell) => cell.key === key)?.value;
    expect(value(`object_lineage:${AGENT}`).flags.programmer).toBe(false);
    expect(value(`property_cell:${AGENT}:features`).value).toEqual([]);
    expect(value(`property_cell:${AGENT}:deactivated_at`).value).toBe(1234);
    expect(value(`property_cell:${AGENT}:api_keys`).value[KEY].revoked_at).toBe(1234);
    expect(value(`property_cell:${ACCOUNT}:actors`).value).toEqual([HUMAN, AGENT]);
    expect(value(`property_cell:${ACCOUNT}:agent_count`).value).toBe(0);
    expect(value(`property_cell:${ACCOUNT}:programmer_agent_count`).value).toBe(0);

    // Cold reconstruction reads the independently persisted private row and
    // must agree with the repaired authority cell.
    cluster = new NetScopeDO(clusterState.state, env);
    expect(await credentialRecord()).toMatchObject({ actor: AGENT, revoked_at: 1234 });

    const replay = await call(false);
    expect(await replay.json()).toMatchObject({
      ok: true,
      status: "empty",
      changed: [],
      conflicts: []
    });

    // Force a second owner event while repair is awaiting catalog facts. The
    // captured owner head is a CAS for the whole snapshot: the stale repair
    // retries instead of overlaying its old values over the new credential.
    let releaseCatalog!: () => void;
    catalogPause = new Promise<void>((resolve) => { releaseCatalog = resolve; });
    const enteredCatalog = new Promise<void>((resolve) => { catalogPauseEntered = resolve; });
    const staleRepair = call(true);
    await enteredCatalog;
    const concurrentKey = routedApiKeyId(HUMAN, AGENT, "55555555555555555555555555555555");
    const concurrent = await cluster.fetch(await signInternalRequest(env, new Request("https://do/net/ensure-credential", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: AGENT,
        id: concurrentKey,
        record: {
          actor: AGENT,
          hash: "c".repeat(64),
          salt: "d".repeat(32),
          created_at: 2,
          label: null
        }
      })
    })));
    expect(concurrent.status, await concurrent.clone().text()).toBe(200);
    releaseCatalog();
    catalogPause = null;
    const stale = await staleRepair;
    expect(stale.status).toBe(400);
    expect(await stale.text()).toContain("E_STALE_HEAD");
    const concurrentRecord = await cluster.fetch(await signInternalRequest(env, new Request("https://do/net/credential-record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: AGENT, id: concurrentKey })
    })));
    expect(await concurrentRecord.json()).toMatchObject({
      record: { actor: AGENT, created_at: 2 }
    });

    // An interleaved aborted mutation discards the in-memory sequencer without
    // advancing the durable head. Instance identity is therefore part of the
    // snapshot CAS; equal head values must not let the detached sequencer
    // commit after a fresh one has rehydrated.
    let releaseCatalogAfterAbort!: () => void;
    catalogPause = new Promise<void>((resolve) => { releaseCatalogAfterAbort = resolve; });
    const enteredCatalogAfterAbort = new Promise<void>((resolve) => { catalogPauseEntered = resolve; });
    const detachedRepair = call(true);
    await enteredCatalogAfterAbort;
    const rejectedMutation = await cluster.fetch(await signInternalRequest(env, new Request("https://do/net/ensure-credential", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: AGENT,
        id: "not-a-routed-key",
        record: {
          actor: AGENT,
          hash: "e".repeat(64),
          salt: "f".repeat(32),
          created_at: 3,
          label: null
        }
      })
    })));
    expect(rejectedMutation.status).toBe(400);
    releaseCatalogAfterAbort();
    catalogPause = null;
    const detached = await detachedRepair;
    expect(detached.status).toBe(400);
    expect(await detached.text()).toContain("E_STALE_HEAD");

    catalogState.close();
    clusterState.close();
  });

  it("reports an evidence-free failed-create orphan without advancing the owner head", async () => {
    const catalogState = netState("account-repair-conflict-catalog");
    const clusterState = netState("account-repair-conflict-cluster");
    let catalog: NetScopeDO;
    let cluster: NetScopeDO;
    const env: NetScopeEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        if (destination === "scope:catalog") return catalog;
        if (destination === `scope:${CLUSTER}`) return cluster;
        throw new Error(`unexpected destination ${destination}`);
      }
    };
    catalog = new NetScopeDO(catalogState.state, env);
    cluster = new NetScopeDO(clusterState.state, env);
    const seed = async (scope: NetScopeDO, name: string, cells: unknown[]) => {
      const response = await scope.fetch(await signInternalRequest(env, new Request("https://do/net/seed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: name, catalog_epoch: "account-repair-conflict", cells, relations: [] })
      })));
      expect(response.status, await response.clone().text()).toBe(200);
    };
    await seed(catalog, "catalog", [
      {
        kind: "object_lineage",
        object: "$system",
        value: { parent: "$root", owner: "$wiz", name: "System", anchor: null, flags: {} }
      },
      prop("$system", "programmer_surface", "$programmer"),
      ...identityRoleCells(),
      ...lookalikeIdentityRoleCells()
    ]);
    await seed(cluster, CLUSTER, [
      {
        kind: "object_lineage",
        object: HUMAN,
        value: { parent: "$human", owner: "$wiz", name: "Human", anchor: null, flags: {} }
      },
      {
        kind: "object_lineage",
        object: ACCOUNT,
        value: { parent: "$account", owner: "$wiz", name: "Account", anchor: HUMAN, flags: {} }
      },
      {
        kind: "object_lineage",
        object: "failed_create_orphan",
        value: { parent: "$agent", owner: HUMAN, name: "Orphan", anchor: HUMAN, flags: { programmer: true } }
      },
      {
        kind: "object_lineage",
        object: "lookalike_human",
        value: { parent: "$lookalike_human_class", owner: "$wiz", name: "Lookalike human", anchor: HUMAN, flags: {} }
      },
      {
        kind: "object_lineage",
        object: "lookalike_account",
        value: { parent: "$lookalike_account_class", owner: "$wiz", name: "Lookalike account", anchor: HUMAN, flags: {} }
      },
      {
        kind: "object_lineage",
        object: "secondary_human",
        value: { parent: "$human", owner: "$wiz", name: "Secondary", anchor: HUMAN, flags: {} }
      },
      prop(HUMAN, "account", ACCOUNT),
      prop(ACCOUNT, "primary_actor", HUMAN),
      prop(ACCOUNT, "actors", [HUMAN]),
      prop(ACCOUNT, "operator_provisioned_agents", {}),
      prop(ACCOUNT, "agent_count", 0),
      prop(ACCOUNT, "programmer_agent_count", 0),
      prop("failed_create_orphan", "created_via", "wizard"),
      prop("failed_create_orphan", "purpose", ""),
      prop("failed_create_orphan", "scope", "write"),
      prop("failed_create_orphan", "features", []),
      prop("lookalike_human", "account", "lookalike_account"),
      prop("secondary_human", "account", ACCOUNT),
      prop("lookalike_account", "primary_actor", "lookalike_human"),
      prop("lookalike_account", "actors", ["lookalike_human"]),
      prop("lookalike_account", "operator_provisioned_agents", {}),
      prop("lookalike_account", "agent_count", 0),
      prop("lookalike_account", "programmer_agent_count", 0)
    ]);
    const signed = (path: string, init?: RequestInit) =>
      signInternalRequest(env, new Request(`https://do${path}`, init));
    const before = await (await cluster.fetch(await signed("/net/head"))).json() as { head: unknown };
    const lookalike = await cluster.fetch(await signed("/net/repair-account-state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account: "lookalike_account",
        human: "lookalike_human",
        candidates: [],
        dry_run: false
      })
    }));
    expect(lookalike.status).toBe(400);
    expect(await lookalike.text()).toContain("lacks catalog-attested account/human lineage roles");

    // The human is an addressing witness, not advisory metadata. Even an
    // owned human with the right reverse pointer cannot stand in for the
    // account's primary actor.
    const secondary = await cluster.fetch(await signed("/net/repair-account-state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account: ACCOUNT,
        human: "secondary_human",
        candidates: [],
        dry_run: true
      })
    }));
    expect(secondary.status).toBe(400);
    expect(await secondary.text()).toContain("owned primary account family");

    const response = await cluster.fetch(await signed("/net/repair-account-state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account: ACCOUNT,
        human: HUMAN,
        candidates: ["failed_create_orphan"],
        dry_run: false
      })
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      status: "conflict",
      changed: [],
      patches: [],
      conflicts: [{
        code: "unregistered_agent_without_operation_evidence",
        object: "failed_create_orphan",
        field: "actors"
      }]
    });
    const after = await (await cluster.fetch(await signed("/net/head"))).json() as { head: unknown };
    expect(after.head).toEqual(before.head);

    const closure = await cluster.fetch(await signed("/net/closure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        keys: [
          `object_lineage:failed_create_orphan`,
          `property_cell:${ACCOUNT}:actors`,
          `property_cell:${ACCOUNT}:agent_count`
        ],
        known: []
      })
    }));
    const cells = (await closure.json() as { cells: Array<{ key: string; value: any }> }).cells;
    expect(cells.find((cell) => cell.key === `object_lineage:failed_create_orphan`)).toBeTruthy();
    expect(cells.find((cell) => cell.key === `property_cell:${ACCOUNT}:actors`)?.value.value).toEqual([HUMAN]);
    expect(cells.find((cell) => cell.key === `property_cell:${ACCOUNT}:agent_count`)?.value.value).toBe(0);

    catalogState.close();
    clusterState.close();
  });

  it("refuses to re-promote an explicitly demoted AP11 ledger agent", async () => {
    const catalogState = netState("account-repair-demoted-catalog");
    const clusterState = netState("account-repair-demoted-cluster");
    let catalog: NetScopeDO;
    let cluster: NetScopeDO;
    const env: NetScopeEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        if (destination === "scope:catalog") return catalog;
        if (destination === `scope:${CLUSTER}`) return cluster;
        throw new Error(`unexpected destination ${destination}`);
      }
    };
    catalog = new NetScopeDO(catalogState.state, env);
    cluster = new NetScopeDO(clusterState.state, env);
    const seed = async (scope: NetScopeDO, name: string, cells: unknown[]) => {
      const response = await scope.fetch(await signInternalRequest(env, new Request("https://do/net/seed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: name, catalog_epoch: "account-repair-demoted", cells, relations: [] })
      })));
      expect(response.status, await response.clone().text()).toBe(200);
    };
    await seed(catalog, "catalog", [
      {
        kind: "object_lineage",
        object: "$system",
        value: { parent: "$root", owner: "$wiz", name: "System", anchor: null, flags: {} }
      },
      prop("$system", "programmer_surface", "$programmer"),
      ...identityRoleCells()
    ]);
    await seed(cluster, CLUSTER, [
      {
        kind: "object_lineage",
        object: HUMAN,
        value: { parent: "$human", owner: "$wiz", name: "Human", anchor: null, flags: {} }
      },
      {
        kind: "object_lineage",
        object: ACCOUNT,
        value: { parent: "$account", owner: "$wiz", name: "Account", anchor: HUMAN, flags: {} }
      },
      {
        kind: "object_lineage",
        object: AGENT,
        value: {
          parent: "$agent",
          owner: HUMAN,
          name: "Demoted operator",
          anchor: HUMAN,
          // The preserved wizard bit proves AP11 completed before the later
          // programmer demotion. The historical ledger cannot override it.
          flags: { wizard: true, programmer: false }
        }
      },
      prop(HUMAN, "account", ACCOUNT),
      prop(ACCOUNT, "primary_actor", HUMAN),
      prop(ACCOUNT, "actors", [HUMAN, AGENT]),
      prop(ACCOUNT, "operator_provisioned_agents", { "demoted-ledger-1": AGENT }),
      prop(ACCOUNT, "agent_count", 1),
      prop(ACCOUNT, "programmer_agent_count", 0),
      prop(AGENT, "provision_id", "demoted-ledger-1"),
      prop(AGENT, "features", []),
      prop(AGENT, "api_key_id", null),
      prop(AGENT, "api_keys", {}),
      prop(AGENT, "retired_at", null),
      prop(AGENT, "deactivated_at", null)
    ]);

    const signed = (path: string, init?: RequestInit) =>
      signInternalRequest(env, new Request(`https://do${path}`, init));
    const before = await (await cluster.fetch(await signed("/net/head"))).json() as { head: unknown };
    const response = await cluster.fetch(await signed("/net/repair-account-state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account: ACCOUNT,
        human: HUMAN,
        candidates: [],
        dry_run: false
      })
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      status: "conflict",
      changed: [],
      patches: [],
      conflicts: [{
        code: "operator_agent_explicitly_demoted",
        object: AGENT,
        field: "object_lineage"
      }]
    });
    const after = await (await cluster.fetch(await signed("/net/head"))).json() as { head: unknown };
    expect(after.head).toEqual(before.head);

    const closure = await cluster.fetch(await signed("/net/closure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        keys: [
          `object_lineage:${AGENT}`,
          `property_cell:${AGENT}:features`,
          `property_cell:${ACCOUNT}:programmer_agent_count`
        ],
        known: []
      })
    }));
    const cells = (await closure.json() as { cells: Array<{ key: string; value: any }> }).cells;
    expect(cells.find((cell) => cell.key === `object_lineage:${AGENT}`)?.value.flags)
      .toMatchObject({ wizard: true, programmer: false });
    expect(cells.find((cell) => cell.key === `property_cell:${AGENT}:features`)?.value.value).toEqual([]);
    expect(cells.find((cell) => cell.key === `property_cell:${ACCOUNT}:programmer_agent_count`)?.value.value).toBe(0);

    catalogState.close();
    clusterState.close();
  });
});
