// Aged-world proof for the editor's `{ref: ...}` authority prefetch.
//
// The gateway resolves `authority.prefetch` from the PERSISTED verb page
// (`verb_bytecode:$programmer:edit_verb` at the catalog scope), not from the
// bundled manifest — deployment alone never updates durable definitions
// (spec/operations/net-cutover.md, "Runtime deployment alone never implies
// this durable-world update"). A world installed before the prefetch
// declaration therefore keeps failing `edit_verb` under NEW code: the editor
// seed instance stays cold, `isa(editor, $space)` answers false (an absent
// object never raises), and the verb refuses E_TYPE with nothing for the
// repair loop to act on. The sibling test (net-verb-editor.test.ts) creates a
// FRESH install and cannot see this.
//
// This test ages the world by stripping the authority block from the seeded
// catalog page, proves entry fails exactly as deployed aged worlds do, then
// applies the signed operator definition repair (the same
// `scripts/net-repair-definitions.ts` inputs production uses) and proves
// entry works — and that the repair is idempotent.
import { describe, expect, it } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { createWorld } from "../../src/core/bootstrap";
import { exportIdentity, importIdentity } from "../../src/net/identity";
import { planNetInstall } from "../../src/net/install";
import { CATALOG_SCOPE } from "../../src/net/topology";
import { definitionRepairInputs } from "../../scripts/net-repair-definitions";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";

const SECRET = "net-verb-editor-aged-secret";
const EDITOR = "the_verb_editor";

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

describe("Verb editor aged-world repair (fake-DO lane)", () => {
  it("edit_verb fails on a pre-prefetch world and recovers via the signed definition repair", async () => {
    const agent = "prog_agent";
    const old = createWorld();
    old.createObject({ id: agent, parent: "$agent", owner: "$wiz", name: "ProgBot" });
    old.ensureApiKey("$wiz", agent, "prog-key", "prog-secret", "prog");
    old.setObjectFlags("$wiz", agent, { programmer: true });
    const identity = exportIdentity(old.exportWorld());
    const plan = await planNetInstall({ graft: async (fresh) => { importIdentity(fresh, identity); } });

    // AGE the world: the durable catalog page predates the `{ref: ...}`
    // authority declaration. Everything else — code, gateway, manifest — is
    // current, exactly the state a deploy leaves an existing world in.
    const catalogCells = plan.partitions.get(CATALOG_SCOPE) ?? [];
    const editPage = catalogCells.find(
      (cell) => cell.kind === "verb_bytecode" && cell.object === "$programmer" && cell.name === "edit_verb"
    );
    expect(editPage, "bundled edit_verb page missing from the install plan").toBeTruthy();
    const agedArgSpec = { ...(editPage!.value as { arg_spec?: Record<string, unknown> }).arg_spec };
    expect(agedArgSpec.authority, "bundled edit_verb no longer declares authority.prefetch — retire this test's aging step").toBeTruthy();
    delete agedArgSpec.authority;
    editPage!.value = { ...(editPage!.value as Record<string, unknown>), arg_spec: agedArgSpec };

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
    const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { "mcp-token": "apikey:prog-key:prog-secret" });
    expect(init.status, JSON.stringify(init.body)).toBe(200);
    const session = init.headers.get("mcp-session-id") as string;
    await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": session });
    await settleAll();

    const callVerb = async (object: string, verb: string, args: unknown[]) => {
      const r = await mcp({
        jsonrpc: "2.0", id: nextId++, method: "tools/call",
        params: { name: "woo_call", arguments: { object, verb, args } }
      }, { "mcp-session-id": session });
      await settleAll();
      return r.body as Record<string, any>;
    };
    const ok = (r: Record<string, any>, label: string) => {
      expect(r?.result?.isError, `${label}: ${JSON.stringify(r).slice(0, 500)}`).not.toBe(true);
      return r?.result?.structuredContent?.result ?? {};
    };
    const activeScope = async (): Promise<string | null> => {
      const r = await mcp({
        jsonrpc: "2.0", id: nextId++, method: "tools/call",
        params: { name: "woo_list_reachable_tools", arguments: { scope: "active" } }
      }, { "mcp-session-id": session });
      const payload = (r.body as any)?.result?.structuredContent?.result ?? {};
      return payload.activeScope ?? payload.active_scope ?? null;
    };

    const widget = ok(await callVerb(agent, "create", ["$thing", { name: "EditTarget", location: agent }]), "create").id as string;
    ok(await callVerb(agent, "install_verb", [widget, "hi", "verb :hi() rxd { return 42; }", {}]), "install_verb");

    // --- 1. deploy alone does NOT fix an aged world ------------------------
    const aged = await callVerb(agent, "edit_verb", [widget, "hi", {}]);
    const agedText = JSON.stringify(aged);
    expect(aged?.result?.isError, `aged edit_verb unexpectedly succeeded — the aging step no longer reproduces: ${agedText.slice(0, 300)}`).toBe(true);
    expect(agedText).toContain("E_TYPE");

    // --- 2. the signed operator definition repair carries the current page --
    // Inputs mined exactly the way `npm run repair:net-definitions --
    // <worker> '$programmer:edit_verb'` mines them: from a fresh install
    // plan, never from operator-supplied values.
    const changes = await definitionRepairInputs(["$programmer:edit_verb"], []);
    expect(changes.cells).toHaveLength(1);
    const catalogDO = scopeDOs.get(CATALOG_SCOPE)!;
    const repairBody = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(changes)
    };
    const repaired = await catalogDO.fetch(await signInternalRequest(scopeEnv, new Request("https://do/net/repair-definitions", repairBody)));
    expect(repaired.status, await repaired.clone().text()).toBe(200);
    expect(await repaired.json()).toMatchObject({
      ok: true,
      status: "applied",
      changed: ["verb_bytecode:$programmer:edit_verb"]
    });
    await settleAll();

    // Idempotent: replaying the same repair changes nothing (the migration
    // rule — reruns and partial-failure recovery must be safe).
    const replayed = await catalogDO.fetch(await signInternalRequest(scopeEnv, new Request("https://do/net/repair-definitions", repairBody)));
    expect(await replayed.json()).toMatchObject({ ok: true, status: "empty", changed: [] });
    await settleAll();

    // --- 3. the repaired world enters the editor ---------------------------
    const entered = ok(await callVerb(agent, "edit_verb", [widget, "hi", {}]), "edit_verb after repair");
    expect(entered.editor).toBe(EDITOR);
    expect(await activeScope(), "session scope did not enter the editor after repair").toBe(EDITOR);
    // And can leave again (the full-loop test owns the deep coverage; this
    // pins that the repaired page composes with the leave path end-to-end).
    const paused = ok(await callVerb(EDITOR, "pause", []), "pause after repair");
    expect(paused.paused).toBe(true);

    await settleAll();
    for (const st of states) st.close();
  });
});
