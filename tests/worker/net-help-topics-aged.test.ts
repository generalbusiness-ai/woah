// Aged-world proof for the help-topic seed repair over the Net stack.
//
// help v0.2.0 corrects three MCP-facing topics and adds the orientation
// topics, shipped as a `merge_map` set_property seed hook (spec §CT5.4). A
// fresh install gets the corrected values, and a LOCAL world heals on cold
// init through the boot drift pass — but a deployed Net world does neither: a
// Scope DO cold start rehydrates durable cells as-is, and deployment alone
// never rewrites them (spec/operations/net-cutover.md, "Runtime deployment
// alone never implies this durable-world update"). An active net world
// installed at help v0.1.1 therefore keeps serving woo_focus guidance forever
// under NEW code. The sibling test (net-mcp-agent-surface.test.ts) builds a
// FRESH install and cannot see this.
//
// This test ages the world by rewriting the seeded topics cell to its v0.1.1
// shape (plus one operator edit), proves the deployed surface serves the
// stale text, then applies the signed operator seed-property repair with the
// same inputs `npm run repair:net-seed-properties -- <worker>` mines from the
// bundled manifests — and proves the merge repairs the untouched keys, adds
// the missing ones, preserves the operator edit, and replays as a no-op.
import { describe, expect, it } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { createWorld } from "../../src/core/bootstrap";
import { exportIdentity, importIdentity } from "../../src/net/identity";
import { planNetInstall } from "../../src/net/install";
import { seedPropertyRepairInputs } from "../../scripts/net-repair-seed-properties";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";

const SECRET = "net-help-topics-aged-secret";

// The exact topic values help v0.1.1 shipped — the aged state being modelled.
// These must match the manifest's `supersedes` declarations, and the test
// asserts that they do, so fingerprint drift fails loudly here rather than
// silently stranding deployed worlds.
const V011_FOCUS = [
  "Use woo_focus(<object>) to add a reachable object to your working set. Its tool-exposed verbs become callable directly even after you move to another room.",
  "woo_unfocus(<object>) removes it. focus_list shows the current working set. Focused remote objects expose their admin (tool_exposed) verbs; the room listing exposes the obvious command-shape verbs."
];
const V011_WAIT = [
  "wait(<timeout_ms>, <limit>) drains queued external observations for this session. It returns immediately if events are queued, or holds until timeout_ms elapses or limit events arrive.",
  "wait is how an MCP agent listens for chat, taken/dropped, moves, and other events that other actors generate while you are not making a call."
];

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

describe("Help topic aged-world repair (fake-DO lane)", () => {
  it("an aged net world serves v0.1.1 topics until the signed seed-property repair merges the corrections", async () => {
    const agent = "help_agent";
    const old = createWorld();
    old.createObject({ id: agent, parent: "$agent", owner: "$wiz", name: "HelpBot" });
    old.ensureApiKey("$wiz", agent, "help-key", "help-secret", "help");
    const identity = exportIdentity(old.exportWorld());
    const plan = await planNetInstall({ graft: async (fresh) => { importIdentity(fresh, identity); } });

    // The repair inputs are mined from the bundled manifests, exactly as the
    // production CLI mines them. This also tells us which scope owns the
    // topics cell — the test must not hardcode the partitioning rule.
    const repairsByScope = await seedPropertyRepairInputs();
    const ownerScope = [...repairsByScope.keys()].find((scope) =>
      repairsByScope.get(scope)!.some((entry) => entry.object === "$help" && entry.property === "topics")
    );
    expect(ownerScope, "no bundled merge_map hook targets $help.topics — retire or retarget this test").toBeTruthy();
    const helpEntry = repairsByScope.get(ownerScope!)!.find((entry) => entry.object === "$help")!;
    // Fingerprint integrity: the manifest's supersedes block still declares
    // the v0.1.1 values this test ages the world back to.
    // `supersedes` is keyed for merge_map hooks (a flat list is the scalar
    // `set` form, which this entry is not).
    const helpSupersedes = helpEntry.supersedes as Record<string, unknown[]> | undefined;
    expect(helpSupersedes?.focus).toContainEqual(V011_FOCUS);
    expect(helpSupersedes?.wait).toContainEqual(V011_WAIT);

    // AGE the world: the durable topics cell predates help v0.2.0. Everything
    // else — code, gateway, manifest — is current, exactly the state a deploy
    // leaves an existing world in. One key ("building") carries an operator
    // edit, which the repair must preserve.
    const ownerCells = plan.partitions.get(ownerScope!) ?? [];
    const topicsCell = ownerCells.find(
      (cell) => cell.kind === "property_cell" && cell.object === "$help" && cell.name === "topics"
    );
    expect(topicsCell, "seeded $help.topics cell missing from the install plan").toBeTruthy();
    const payload = topicsCell!.value as { value?: Record<string, unknown> };
    const agedTopics: Record<string, unknown> = { ...(payload.value ?? {}) };
    agedTopics.focus = [...V011_FOCUS];
    agedTopics.wait = [...V011_WAIT];
    agedTopics.building = ["Our house authoring rules.", "Ask the operator."];
    for (const added of ["self", "suit", "me", "tools"]) delete agedTopics[added];
    topicsCell!.value = { ...payload, value: agedTopics };

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
    const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { "mcp-token": "apikey:help-key:help-secret" });
    expect(init.status, JSON.stringify(init.body)).toBe(200);
    const session = init.headers.get("mcp-session-id") as string;
    await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": session });
    await settleAll();

    const helpTopic = async (topic: string): Promise<string> => {
      const result = await mcp({
        jsonrpc: "2.0", id: nextId++, method: "tools/call",
        params: { name: "woo_call", arguments: { object: agent, verb: "help", args: [topic] } }
      }, { "mcp-session-id": session });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      await settleAll();
      return JSON.stringify(result.body);
    };

    // --- 1. deploy alone does NOT fix an aged world ------------------------
    expect(await helpTopic("focus")).toContain("Use woo_focus(");
    expect(await helpTopic("wait")).toContain("wait(<timeout_ms>, <limit>)");
    const missingSelf = await helpTopic("self");
    expect(missingSelf).not.toContain("<object>__<verb>");

    // --- 2. the signed operator seed-property repair merges the fix --------
    const ownerDO = scopeDOs.get(ownerScope!)!;
    const repairBody = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries: repairsByScope.get(ownerScope!) })
    };
    const repaired = await ownerDO.fetch(await signInternalRequest(scopeEnv, new Request("https://do/net/repair-seed-properties", repairBody)));
    expect(repaired.status, await repaired.clone().text()).toBe(200);
    expect(await repaired.json()).toMatchObject({
      ok: true,
      status: "applied",
      changed: ["property_cell:$help:topics"]
    });
    await settleAll();

    // Idempotent: replaying the same repair changes nothing (the migration
    // rule — reruns and partial-failure recovery must be safe).
    const replayed = await ownerDO.fetch(await signInternalRequest(scopeEnv, new Request("https://do/net/repair-seed-properties", repairBody)));
    expect(await replayed.json()).toMatchObject({ ok: true, status: "empty", changed: [] });
    await settleAll();

    // --- 3. the repaired world serves the corrected topics -----------------
    const focus = await helpTopic("focus");
    expect(focus).toContain("no woo_focus");
    expect(focus).not.toContain("Use woo_focus(");
    expect(await helpTopic("wait")).toContain("woo_wait(timeout_ms, limit)");
    // The orientation topics landed, aliases included.
    for (const topic of ["self", "suit", "me", "tools"]) {
      expect(await helpTopic(topic), `topic "${topic}" missing after repair`).toContain("<object>__<verb>");
    }
    // The operator's edited key survived the merge untouched.
    expect(await helpTopic("building")).toContain("Our house authoring rules.");

    // Drain deferred work before closing the fake storage (see the surface
    // test for why: queued fanout resuming against closed DBs leaks errors
    // into the next test in this worker).
    await settleAll();
    for (const st of states) st.close();
  });
});
