// Aged-world proof that a bundled catalog's §CT14 MAJOR edge can be applied
// COMPLETELY to a deployed Net world — definitions included.
//
// The gap this closes was a real question, not a hypothetical. A Net runtime
// never runs local catalog boot: installLocalCatalogs is called only inside
// planNetInstall (namespace genesis), so runLocalCatalogVersionMigrations —
// the thing that applies migration-v0-to-v1.json on a local world — has no
// deployed counterpart. Deploying the code that carries help v1.0.0 therefore
// leaves an active Net world running the v0 definitions forever.
//
// The sanctioned delivery is the signed `repair-definitions` operator
// operation (net-cutover.md §NC5, coherence.md CO15). It is usually described
// as the REPLACE path for bootstrap verb pages, but it carries the drop half
// too: its `remove` array deletes verb_bytecode and property_cell definition
// pages at catalog authority, and its CLI allow-list for drops is mined from
// exactly the bundled migrations' `drop_verb` / `drop_property` steps. So a
// catalog that ships a migration declaring its drops has, by that same act,
// authorized the Net operator op to perform them. This test proves that end to
// end rather than asserting it in prose.
//
// One op covers both halves of help v1.0.0:
//   npm run repair:net-definitions -- <worker> '$player:help' \
//     --drop '$generic_help_db:record_miss' 'prop:$generic_help_db:missed_topics'
import { describe, expect, it } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { createWorld } from "../../src/core/bootstrap";
import { compileVerb } from "../../src/core/authoring";
import { exportIdentity, importIdentity } from "../../src/net/identity";
import { planNetInstall } from "../../src/net/install";
import { CATALOG_SCOPE } from "../../src/net/topology";
import { definitionRepairInputs } from "../../scripts/net-repair-definitions";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";

const SECRET = "net-help-migration-aged-secret";

// The help miss path exactly as help v0.x shipped it: on a miss it dispatched
// record_miss, which wrote the bounded missed_topics list on the first help db.
// Reproduced verbatim (not paraphrased) so the aged world is the real one.
const V0_PLAYER_HELP_SOURCE = `verb :help(topic) rxd {
  let t = "index";
  if (topic != null && str_trim(to_string(topic)) != "") { t = str_lower(str_trim(to_string(topic))); }
  let dbs = [];
  let actor_chain = [this] + parents(this);
  for obj in actor_chain {
    try {
      let h = obj.help;
      if (typeof(h) == "list") { for db in h { if (db != null && !(db in dbs)) { dbs = dbs + [db]; } } }
      else if (h != null && !(h in dbs)) { dbs = dbs + [h]; }
    } except err { }
  }
  let here = location(this);
  if (here != null && valid(here)) {
    let here_chain = [here] + parents(here);
    for obj2 in here_chain {
      try {
        let hh = obj2.help;
        if (typeof(hh) == "list") { for db2 in hh { if (db2 != null && !(db2 in dbs)) { dbs = dbs + [db2]; } } }
        else if (hh != null && !(hh in dbs)) { dbs = dbs + [hh]; }
      } except err2 { }
    }
  }
  try {
    for db3 in "$system".help_dbs { if (db3 != null && !(db3 in dbs)) { dbs = dbs + [db3]; } }
  } except err3 { }
  let result = null;
  let found = false;
  let n = length(dbs);
  for i in [1..n] {
    let db4 = dbs[i];
    let remaining = [];
    if (i < n) { for j in [(i + 1)..n] { remaining = remaining + [dbs[j]]; } }
    try {
      result = dispatch(db4, "get_topic", [t, remaining]);
      found = true;
      break;
    } except err4 {
      if (err4["code"] != "E_HELPNF") { raise err4; }
    }
  }
  if (!found) {
    if (length(dbs) > 0) { try { dispatch(dbs[1], "record_miss", [t]); } except err5 { } }
    result = { ok: false, status: "not_found", topic: t, lines: ["No help available for " + str_char(34) + t + str_char(34) + "."] };
  }
  if (typeof(result) == "map" && has(result, "lines")) { this:tell_lines(result["lines"]); }
  else { this:tell(to_string(result)); }
  return result;
}`;

// help v0.x backed record_miss with the `help_db_record_miss` NATIVE. This
// release deletes that handler, so an aged native page dispatched under the
// new runtime fails as `incomplete_transcript` (`native:$help:record_miss`)
// rather than E_CATALOG_MUTATION. Both aged shapes are covered below, because
// both are real: a world still on the old runtime shows the reported
// E_CATALOG_MUTATION, and the same world one deploy later shows the missing
// native. Neither is recoverable without the repair, and the repair fixes both.
//
// The bytecode variant performs the identical durable act — an ordinary turn
// writing property_cell:$help:missed_topics — so it reproduces the reported
// payload byte-for-byte under the current runtime.
const AGED_RECORD_MISS_SOURCE =
  "verb :record_miss(topic) rxd { this.missed_topics = this.missed_topics + [{ topic: topic }]; return true; }";

type AgedVerbKind = "native" | "bytecode";

/** Rewind an install-plan world to the help v0.x definition surface. */
function ageHelpDefinitions(world: ReturnType<typeof createWorld>, recordMissKind: AgedVerbKind): void {
  const owner = world.object("$generic_help_db").owner;
  world.defineProperty("$generic_help_db", {
    name: "missed_topics",
    defaultValue: [],
    typeHint: "list<map>",
    owner,
    perms: "r"
  });
  if (recordMissKind === "native") {
    world.addVerb("$generic_help_db", {
      kind: "native",
      name: "record_miss",
      aliases: [],
      owner,
      perms: "rxd",
      arg_spec: { args: ["topic"] },
      source: "verb :record_miss(topic) rxd { return null; /* native: see help_db_record_miss */ }",
      source_hash: "aged-record-miss",
      version: 1,
      line_map: {},
      native: "help_db_record_miss",
      direct_callable: true
    });
  } else {
    const compiledMiss = compileVerb(AGED_RECORD_MISS_SOURCE);
    if (!compiledMiss.ok || !compiledMiss.bytecode) throw new Error("aged record_miss source failed to compile");
    world.addVerb("$generic_help_db", {
      kind: "bytecode",
      name: "record_miss",
      aliases: [],
      owner,
      perms: "rxd",
      arg_spec: { args: ["topic"] },
      source: AGED_RECORD_MISS_SOURCE,
      source_hash: compiledMiss.source_hash ?? "aged-record-miss",
      version: 1,
      bytecode: compiledMiss.bytecode,
      line_map: compiledMiss.line_map ?? {},
      direct_callable: true
    });
  }
  // Swap $player:help back to the v0 body, keeping every other field of the
  // live verb (aliases, arg_spec, flags) so only the source/bytecode is aged.
  const existing = world.ownVerbExact("$player", "help");
  if (!existing || existing.kind !== "bytecode") throw new Error("$player:help is not a bytecode verb");
  const compiled = compileVerb(V0_PLAYER_HELP_SOURCE);
  if (!compiled.ok || !compiled.bytecode) throw new Error("v0 help source failed to compile");
  world.addVerb("$player", {
    ...existing,
    source: V0_PLAYER_HELP_SOURCE,
    source_hash: compiled.source_hash ?? existing.source_hash,
    bytecode: { ...compiled.bytecode, version: existing.version + 1 },
    line_map: compiled.line_map ?? {},
    version: existing.version + 1
  });
}

function netState(name: string) {
  const fake = new FakeDurableObjectState(name);
  const deferred: Array<Promise<unknown>> = [];
  const state: NetScopeDurableState & NetGatewayDurableState = {
    id: fake.id,
    waitUntil: (promise: Promise<unknown>) => { deferred.push(promise); },
    storage: {
      sql: fake.storage.sql,
      transactionSync: fake.storage.transactionSync,
      setAlarm: () => {},
      deleteAlarm: () => {}
    }
  };
  return {
    state,
    settle: async () => { while (deferred.length > 0) await deferred.shift(); },
    close: () => fake.close()
  };
}

type Rpc = { jsonrpc: "2.0"; id?: number; method: string; params?: unknown };

/** The whole scenario, run once per aged `record_miss` implementation kind.
 * `assertAgedFailure` pins the shape that kind produces under the CURRENT
 * runtime; everything after it is identical, because the repair and the
 * repaired behavior do not depend on how the retired verb was implemented. */
async function runAgedMigrationScenario(
  recordMissKind: AgedVerbKind,
  assertAgedFailure: (body: string) => void
): Promise<void> {
    const agent = "help_migration_agent";
    const old = createWorld();
    old.createObject({ id: agent, parent: "$agent", owner: "$wiz", name: "HelpBot" });
    old.ensureApiKey("$wiz", agent, "help-mig-key", "help-mig-secret", "help");
    const identity = exportIdentity(old.exportWorld());
    const plan = await planNetInstall({
      graft: async (fresh) => {
        importIdentity(fresh, identity);
        ageHelpDefinitions(fresh, recordMissKind);
      }
    });

    // The aged surface really is in the install image, and at catalog
    // authority — otherwise the repair below has nothing to prove.
    const catalogCells = plan.partitions.get(CATALOG_SCOPE) ?? [];
    const agedKeys = catalogCells
      .filter((cell) => cell.object === "$generic_help_db" && (cell.name === "record_miss" || cell.name === "missed_topics"))
      .map((cell) => `${cell.kind}:${cell.object}:${cell.name}`)
      .sort();
    expect(agedKeys).toEqual([
      "property_cell:$generic_help_db:missed_topics",
      "verb_bytecode:$generic_help_db:record_miss"
    ]);
    // No OTHER cell anywhere carries the retired surface. This is what makes a
    // class-scoped drop complete: the $help instance never materialized an own
    // missed_topics cell (it inherited the class default), so there is no
    // instance-level residue the class-scoped allow-list would miss.
    for (const [, cells] of plan.partitions) {
      for (const cell of cells) {
        if (cell.object === "$generic_help_db") continue;
        expect(`${cell.object}.${cell.name ?? ""}`).not.toContain("missed_topics");
      }
    }

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
    gateway = new NetGatewayDO(gatewayState.state, {
      WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve, NET_GATEWAY_SELF: "gateway:net-api"
    } as NetGatewayEnv);

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
    const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { "mcp-token": "apikey:help-mig-key:help-mig-secret" });
    expect(init.status, JSON.stringify(init.body)).toBe(200);
    const session = init.headers.get("mcp-session-id") as string;
    await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": session });
    await settleAll();

    const helpFor = async (topic: string): Promise<string> => {
      const result = await mcp({
        jsonrpc: "2.0", id: nextId++, method: "tools/call",
        params: { name: "woo_call", arguments: { object: agent, verb: "help", args: [topic] } }
      }, { "mcp-session-id": session });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      await settleAll();
      return JSON.stringify(result.body);
    };

    // --- 1. the aged world is broken -------------------------------------
    const broken = await helpFor("programmer");
    assertAgedFailure(broken);
    // A known topic still works: only the miss path is broken, which is why
    // this shipped unnoticed.
    expect(await helpFor("commands")).toContain("Common commands");

    // --- 2. the signed operator repair carries the whole edge --------------
    // Inputs come from the production CLI helper, so the test cannot name a
    // definition the operator could not. The drops are authorized ONLY because
    // catalogs/help/migration-v0-to-v1.json declares them and the current
    // bundle no longer defines those pages.
    const changes = await definitionRepairInputs(
      ["$player:help"],
      ["$generic_help_db:record_miss", "prop:$generic_help_db:missed_topics"]
    );
    expect(changes.remove).toEqual([
      { kind: "verb_bytecode", object: "$generic_help_db", name: "record_miss" },
      { kind: "property_cell", object: "$generic_help_db", name: "missed_topics" }
    ]);

    const catalogDO = scopeDOs.get(CATALOG_SCOPE)!;
    const repairRequest = () => new Request("https://do/net/repair-definitions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(changes)
    });
    const repaired = await catalogDO.fetch(await signInternalRequest(scopeEnv, repairRequest()));
    expect(repaired.status, await repaired.clone().text()).toBe(200);
    expect(await repaired.json()).toMatchObject({
      ok: true,
      status: "applied",
      removed: expect.arrayContaining([
        "property_cell:$generic_help_db:missed_topics",
        "verb_bytecode:$generic_help_db:record_miss"
      ])
    });
    await settleAll();

    // --- 3. the repaired world answers instead of failing ------------------
    const fixed = await helpFor("programmer");
    expect(fixed, "the aged world still fails after the repair").not.toContain("E_CATALOG_MUTATION");
    expect(fixed).toContain("not_found");
    expect(fixed).toContain('No help available for \\"programmer\\".');
    expect(fixed).toContain("Topics: ");
    for (const topic of ["commands", "movement", "tools"]) {
      expect(fixed, `repaired not_found reply omits topic "${topic}"`).toContain(topic);
    }
    // ...and the topics that already worked still do.
    expect(await helpFor("commands")).toContain("Common commands");

    // --- 4. the retired definitions are actually GONE from the authority ---
    const closure = await catalogDO.fetch(await signInternalRequest(scopeEnv, new Request("https://do/net/closure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        keys: [
          "verb_bytecode:$generic_help_db:record_miss",
          "property_cell:$generic_help_db:missed_topics",
          "verb_bytecode:$generic_help_db:get_topic"
        ]
      })
    })));
    const served = (await closure.json()) as { cells?: Array<{ key: string }> };
    const servedKeys = (served.cells ?? []).map((cell) => cell.key);
    expect(servedKeys).not.toContain("verb_bytecode:$generic_help_db:record_miss");
    expect(servedKeys).not.toContain("property_cell:$generic_help_db:missed_topics");
    // The control: a definition the migration did NOT drop is still served, so
    // the two absences above are removals rather than an empty closure.
    expect(servedKeys).toContain("verb_bytecode:$generic_help_db:get_topic");

    // --- 5. re-running the repair is a no-op -------------------------------
    // Migration rule: reruns and partial-failure recovery must be safe. The
    // replacement is byte-identical and both removals are already absent, so
    // the op applies nothing and advances no head.
    const headBefore = await catalogDO.fetch(await signInternalRequest(scopeEnv, new Request("https://do/net/head")));
    const seqBefore = ((await headBefore.json()) as { head: { seq: number } }).head.seq;
    const replayed = await catalogDO.fetch(await signInternalRequest(scopeEnv, repairRequest()));
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toMatchObject({ ok: true, removed: [] });
    await settleAll();
    const headAfter = await catalogDO.fetch(await signInternalRequest(scopeEnv, new Request("https://do/net/head")));
    expect(((await headAfter.json()) as { head: { seq: number } }).head.seq).toBe(seqBefore);
    // ...and the world still behaves.
    expect(await helpFor("programmer")).toContain("not_found");

    await settleAll();
    for (const st of states) st.close();
}

describe("Help v0 -> v1 catalog migration over Net (fake-DO lane)", () => {
  // The world as it stands RIGHT NOW on the deployed worker: old runtime, so
  // the retired verb still resolves and its property write is what fails. This
  // is the reported defect, reproduced over the Net stack byte-for-byte.
  it("repairs an aged world whose retired verb still writes the catalog property", async () => {
    await runAgedMigrationScenario("bytecode", (body) => {
      expect(body).toContain("E_CATALOG_MUTATION");
      expect(body).toContain("property_cell:$help:missed_topics");
    });
  });

  // The same world one deploy later: this release deletes the
  // `help_db_record_miss` native, so the aged page now dispatches to a handler
  // the runtime no longer has. Deploying does not fix an aged world and does
  // not make it unrecoverable either — it only changes which way the miss path
  // fails. The identical repair resolves both, which is what makes the deploy
  // step safe to run in either order.
  it("repairs an aged world whose retired verb points at a native this release deleted", async () => {
    await runAgedMigrationScenario("native", (body) => {
      expect(body).toContain("incomplete_transcript");
      expect(body).toContain("native:$help:record_miss");
    });
  });
});
