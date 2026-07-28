// Verb slots over Net, end to end (fake-DO lane).
//
// The defect this pins (notes/2026-07-27-net-verb-slots.md): every verb
// authored over Net landed on `slot: 1`, and any metadata edit DEMOTED a live
// verb to slot 1 as well. Slot order is the dispatcher's tie-breaker
// (spec/semantics/objects.md §9.1), so a colliding pair had no defined order
// at all, and `list_verb`/`verb_info` reported a slot that was not the one the
// authority held.
//
// Three independent causes, each covered below:
//
//  1. HYDRATION. `importWorld` stamped `slot = index + 1`, so a slice holding
//     one verb page hydrated it as slot 1 whatever its real ordinal was — and
//     every authoring write re-serializes the page it touched, so the lie was
//     committed back as authority.
//  2. ALLOCATION. `addVerb(append)` used `obj.verbs.length + 1` over that same
//     slice, which is 0 for an object reached as a call ARGUMENT (no cell's
//     absence means "this object has other verbs", so the sparse repair loop
//     could never grow them in).
//  3. AUTHORITY. Nothing checked the proposal, so a wrong slot committed
//     silently.
//
// (1) and (2) are proved here against a pre-installed world whose verbs carry
// real slots 1..3. (3) is proved at the sequencer in
// tests/net/verb-slot-allocation.test.ts, and its convergence — a planner that
// is genuinely blind, refused by the owner, repaired, and re-planned — is
// proved by the eval case at the end, which reaches the object by literal
// rather than by argument so the seed slice cannot help it.
import { describe, expect, it } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { createWorld } from "../../src/core/bootstrap";
import { netActivationCell, partitionInstallRelations } from "../../src/net/install";
import { cellsFromSerialized } from "../../src/net/bridge";
import { CATALOG_SCOPE, partitionCells } from "../../src/net/topology";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";

const SECRET = "net-verb-slots-secret";
const AGENT = "prog_agent";
const WIDGET = "slot_widget";

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
  return { state, settle: async () => { while (deferred.length > 0) await deferred.shift(); }, close: () => fake.close() };
}

type Rpc = { jsonrpc: "2.0"; id?: number; method: string; params?: unknown };

/** A net world seeded from a PRE-INSTALL image, so the probe object's verbs
 * carry real slots before any Net turn runs. The agent and the widget are
 * anchored to the agent's own cluster: catalog-scope objects are immutable to
 * ordinary turns, and this test authors. */
async function seededWorld(verbNames: string[]) {
  const old = createWorld();
  const room = old.propOrNull("$system", "guest_initial_room") as string;
  expect(room, "the catalogs no longer declare a start room").toBeTruthy();
  old.createObject({ id: AGENT, parent: "$agent", owner: "$wiz", name: "ProgBot" });
  old.ensureApiKey("$wiz", AGENT, "prog-key", "prog-secret", "prog");
  old.setObjectFlags("$wiz", AGENT, { programmer: true });
  old.moveObject(AGENT, room);
  old.createObject({ id: WIDGET, parent: "$thing", owner: AGENT, name: "SlotWidget", anchor: AGENT });
  old.moveObject(WIDGET, room);
  for (const name of verbNames) {
    old.addVerbForActor("$wiz", WIDGET, { name, owner: AGENT, perms: "rxd", aliases: ["x*"] });
    old.setVerbCodeForActor("$wiz", WIDGET, name, `verb :${name}() rxd { return "${name}"; }`);
  }
  // The oracle for everything below: what the authoritative world itself holds.
  const authoritative = verbNames.map((name) => old.ownVerbExact(WIDGET, name)?.slot);
  expect(authoritative, "pre-install seeding did not produce dense slots").toEqual(verbNames.map((_, i) => i + 1));

  const cells = cellsFromSerialized(old.exportWorld());
  const partitions = partitionCells(cells);
  const relations = partitionInstallRelations(cells);
  const epoch = "cat-net-verb-slots";
  partitions.set(CATALOG_SCOPE, [...(partitions.get(CATALOG_SCOPE) ?? []), netActivationCell(epoch)]);

  const states: Array<ReturnType<typeof netState>> = [];
  const scopeDOs = new Map<string, NetScopeDO>();
  let gateway: NetGatewayDO;
  const resolve = (destination: string) => {
    if (destination.startsWith("scope:")) {
      const instance = scopeDOs.get(destination.slice("scope:".length));
      if (instance) return instance;
    }
    if (destination.startsWith("gateway:")) return gateway;
    throw new Error(`unresolvable destination ${destination}`);
  };
  const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve };
  for (const [scope, scopeCells] of partitions) {
    const st = netState(`slots-scope-${scope}`);
    const instance = new NetScopeDO(st.state, scopeEnv);
    const seeded = await instance.fetch(await signInternalRequest(scopeEnv, new Request("https://do/net/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, catalog_epoch: epoch, cells: scopeCells, relations: relations.get(scope) ?? [] })
    })));
    expect(seeded.ok, `seed ${scope}`).toBe(true);
    states.push(st);
    scopeDOs.set(scope, instance);
  }
  const gatewayState = netState("slots-gateway");
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
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body)
    }));
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) as Record<string, any> : null, headers: response.headers };
  };
  const init = await mcp({ jsonrpc: "2.0", id: nextId++, method: "initialize", params: {} }, { "mcp-token": "apikey:prog-key:prog-secret" });
  expect(init.status, JSON.stringify(init.body)).toBe(200);
  const session = init.headers.get("mcp-session-id") as string;
  await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": session });
  await settleAll();

  /** One authoritative turn, settled; throws with the payload on refusal. */
  const call = async (object: string, verb: string, args: unknown[]) => {
    const reply = await mcp({
      jsonrpc: "2.0", id: nextId++, method: "tools/call",
      params: { name: "woo_call", arguments: { object, verb, args } }
    }, { "mcp-session-id": session });
    await settleAll();
    const result = (reply.body as any)?.result;
    if (result?.isError === true) throw new Error(`${object}:${verb} refused: ${JSON.stringify(reply.body).slice(0, 400)}`);
    return result?.structuredContent?.result ?? {};
  };

  /** The COMMITTED slot of each verb page, read from the gateway's mirror of
   * authority cells — not from any turn's answer. */
  const committedSlots = (): Record<string, number | undefined> => {
    const out: Record<string, number | undefined> = {};
    for (const cell of (gateway as any).ensureView().cellsForObject(WIDGET)) {
      if (cell.kind !== "verb_bytecode") continue;
      out[cell.name as string] = (cell.value as { slot?: number }).slot;
    }
    return out;
  };

  return { call, committedSlots, close: () => { for (const st of states) st.close(); } };
}

describe("verb slots over Net (fake-DO lane)", () => {
  it("allocates above the object's real verbs and never moves an existing one", async () => {
    const world = await seededWorld(["alpha", "bravo", "charlie"]);
    try {
      // (The gateway view is empty until a turn warms the object, so the
      // pre-state oracle is the authoritative one asserted in seededWorld.)
      // Cause 1: a metadata edit on the LAST verb. The turn's slice holds only
      // charlie's page, which used to hydrate as slot 1 and commit back as
      // slot 1 — colliding with alpha and inverting their alias order.
      const edited = await world.call(AGENT, "set_verb_info", [WIDGET, "charlie", { aliases: ["ch*"] }]);
      expect(edited.slot, "a metadata edit moved the verb").toBe(3);
      expect(world.committedSlots()).toEqual({ alpha: 1, bravo: 2, charlie: 3 });

      // Cause 2: a fresh install. `id` is a call ARGUMENT, so the seed slice
      // now carries the object's own cells and the append sees the real set.
      const installed = await world.call(AGENT, "install_verb", [WIDGET, "delta", "verb :delta() rxd { return \"delta\"; }", {}]);
      expect(installed.ok, JSON.stringify(installed).slice(0, 300)).toBe(true);
      expect(installed.slot, "an appended verb did not allocate above the existing ones").toBe(4);
      expect(world.committedSlots()).toEqual({ alpha: 1, bravo: 2, charlie: 3, delta: 4 });

      // And the reported slot is the one the authority holds, so a slot
      // descriptor an agent reads back actually addresses that verb.
      expect((await world.call(AGENT, "list_verb", [WIDGET, "charlie", {}])).slot).toBe(3);
      expect((await world.call(AGENT, "list_verb", [WIDGET, 4, {}])).name).toBe("delta");

      // A PURE READ has no write for the owner to refuse, so this is the claim
      // that the seed slice itself carries the argument object's verb pages:
      // $programmer:install_verb projects a dry-run slot from `verbs(id)`,
      // which answered `[]` — an empty list, indistinguishable from a
      // verb-less object — for every object reached as an argument.
      const projected = await world.call(AGENT, "install_verb", [WIDGET, "epsilon", "verb :epsilon() rxd { return 5; }", { dry_run: true }]);
      expect(projected.ok, JSON.stringify(projected).slice(0, 300)).toBe(true);
      expect(projected.slot, "the dry-run projection cannot see the object's verbs").toBe(5);
    } finally {
      world.close();
    }
  });

  it("converges when the planner is blind: the owner refuses the guess and the replan is correct", async () => {
    const world = await seededWorld(["alpha", "bravo", "charlie"]);
    try {
      // Reached by LITERAL inside eval, not as an argument, so no seeding
      // heuristic can put the object's verb pages in the first slice. The
      // planner honestly proposes slot 1; the owning scope refuses it
      // (verb_slot_stale), the gateway repairs the named pages, and the
      // re-plan allocates 4. Convergence is the claim — a wrong slot must
      // never be able to commit, whatever the planner could see.
      const evaluated = await world.call(AGENT, "eval", [
        `add_verb(#${WIDGET}, { name: "echo", perms: "rxd" }); return verb_info(#${WIDGET}, "echo")["slot"];`,
        { mode: "stmts" }
      ]);
      expect(evaluated.ok, JSON.stringify(evaluated).slice(0, 400)).toBe(true);
      expect(evaluated.value, "a blind append committed a colliding slot").toBe(4);
      expect(world.committedSlots()).toEqual({ alpha: 1, bravo: 2, charlie: 3, echo: 4 });

      // The hydration claim, on the one read no repair can mask: a literal
      // inside eval grows exactly ONE verb page into the slice (the E_VERBNF
      // miss names it), and nothing else. Stamping `slot = index + 1` while
      // hydrating that one-page array reported the object's third verb as its
      // first — the read half of the same defect.
      const single = await world.call(AGENT, "eval", [`return verb_info(#${WIDGET}, "charlie")["slot"];`, { mode: "stmts" }]);
      expect(single.ok, JSON.stringify(single).slice(0, 300)).toBe(true);
      expect(single.value, "a one-page slice renumbered the verb it holds").toBe(3);
    } finally {
      world.close();
    }
  });
});
