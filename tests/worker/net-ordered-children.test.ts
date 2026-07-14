// Ordered-children projection REPAIR over the net gateway (stage 2).
//
// The gateway seeds only the call target's ordering up front. A verb that
// reads a DIFFERENT parent's ordering (add_item into a nested parent, a
// reparent's old + new parent) must not hard-fail: the builtin raises a
// REPAIRABLE ordered-children miss naming the parent, and the gateway's turn
// loop fetches that parent's owner projection (POST /net/ordered-children),
// installs it, and re-plans — the ordering analogue of a targeted cell
// refresh. These tests drive the real turnAttempts loop against a real
// per-instance SQLite scope DO over the signed /net surface, and assert:
//   (a) a non-target parent converges (fetch + install + re-plan);
//   (b) reading TWO parents in one turn converges with both projections;
//   (c) it stays bounded (few rounds, envelope under the warm ceiling);
//   (d) an absent/childless parent converges to [] with no repair loop.
import { describe, expect, it } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { installVerb } from "../../src/core/authoring";
import { createWorld } from "../../src/core/bootstrap";
import { cellsFromSerialized, type ShadowTurnCall } from "../../src/net/bridge";
import type { WooValue } from "../../src/core/types";
import { WARM_ENVELOPE_BYTE_LIMIT } from "../../src/net/plan";
import type { AttemptTraceEntry } from "../../src/net/errors";
import type { CommitReply } from "../../src/net/scope";

const SECRET = "net-ordered-children-secret";
const EPOCH = "cat-net-ordered-1";
const SCOPE = "flat"; // one scope holds the whole flattened world

function netState(name: string): { state: NetScopeDurableState & NetGatewayDurableState; close: () => void } {
  const fake = new FakeDurableObjectState(name);
  const state = {
    id: fake.id,
    waitUntil: (_promise: Promise<unknown>) => {},
    storage: {
      sql: fake.storage.sql,
      transactionSync: fake.storage.transactionSync,
      setAlarm: (_at: number) => {},
      deleteAlarm: () => {}
    }
  };
  return { state, close: () => fake.close() };
}

type Fetchable = { fetch(request: Request): Promise<Response> | Response };

async function call<T>(target: Fetchable, env: { WOO_INTERNAL_SECRET?: string }, route: string, body?: unknown): Promise<T> {
  const url = `https://do/net${route}`;
  const request =
    body === undefined
      ? new Request(url)
      : new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const signed = await signInternalRequest(env, request);
  const response = await target.fetch(signed);
  const decoded = (await response.json()) as T;
  if (!response.ok) throw new Error(`call ${route} failed: ${JSON.stringify(decoded)}`);
  return decoded;
}

type TurnStructureReport = { attempt: number; envelope_bytes: number };
type TurnBody = {
  reply: CommitReply;
  attempt: number;
  trace: AttemptTraceEntry[];
  result?: unknown;
  structure?: TurnStructureReport;
};

/** A container plus a two-level ordered tree, seeded as authored edge cells.
 * Verbs read a parent passed as an ARGUMENT, so the parent is data-dependent
 * (not the call target) — exactly the case the repair path exists for. */
function buildFixture() {
  const world = createWorld();
  const session = world.auth("guest:ocp");
  const actor = session.actor;
  world.createObject({ id: "ocp_root", name: "Outline Root", parent: "$thing", owner: actor });
  // Two-level tree: p_a, p_b under the root; a1,a2 under p_a; b1 under p_b.
  for (const id of ["p_a", "p_b", "c_a1", "c_a2", "c_b1"]) {
    world.createObject({ id, name: id, parent: "$thing", owner: actor });
  }
  // Authored ordered-edge cells (property_cell:<child>:__ordered_edge).
  const edge = (child: string, parent: string | null, rank: string) => world.setProp(child, "__ordered_edge", { parent, rank });
  edge("p_a", "ocp_root", "V");
  edge("p_b", "ocp_root", "W");
  edge("c_a1", "p_a", "V");
  edge("c_a2", "p_a", "W");
  edge("c_b1", "p_b", "V");

  installVerb(world, "ocp_root", "children_of", `verb :children_of(who) rxd { return ordered_children(who); }`, null);
  installVerb(world, "ocp_root", "two_parents", `verb :two_parents(p1, p2) rxd { return [ordered_children(p1), ordered_children(p2)]; }`, null);

  return { world, session, actor };
}

/** A gateway wired to one real per-instance scope DO over the signed surface,
 * with a per-destination RPC log so repair round-trips can be counted. */
async function harness() {
  const { world, session, actor } = buildFixture();
  const cells = cellsFromSerialized(world.exportWorld());
  const scopeState = netState("ocp-scope");
  const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET };
  const scopeDO = new NetScopeDO(scopeState.state, scopeEnv);
  await call(scopeDO, scopeEnv, "/seed", { scope: SCOPE, catalog_epoch: EPOCH, cells });

  const rpcLog: string[] = [];
  const gatewayState = netState("ocp-gateway");
  const gatewayEnv: NetGatewayEnv = {
    WOO_INTERNAL_SECRET: SECRET,
    NET_RESOLVE: (destination) => {
      if (destination !== `scope:${SCOPE}`) throw new Error(`unexpected destination ${destination}`);
      return { fetch: (request: Request) => { rpcLog.push(new URL(request.url).pathname); return scopeDO.fetch(request); } };
    }
  };
  const gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);
  await call(gateway, gatewayEnv, "/pull", { scope: SCOPE, destination: `scope:${SCOPE}` });

  const turn = (id: string, verb: string, args: WooValue[]): Promise<TurnBody> => {
    const shadowCall: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1", id, route: "direct", scope: SCOPE,
      session: session.id, actor, target: "ocp_root", verb, args
    };
    return call<TurnBody>(gateway, gatewayEnv, "/turn", {
      call: shadowCall, planningScope: SCOPE, catalog_epoch: EPOCH, idempotency_key: id,
      shared: [SCOPE], scopes: { [SCOPE]: `scope:${SCOPE}` }
    });
  };

  return { turn, rpcLog, close: () => { scopeState.close(); gatewayState.close(); } };
}

describe("ordered-children projection repair over the gateway", () => {
  it("(a) a NON-target parent converges via fetch + install + re-plan (not E_INTERNAL)", async () => {
    const { turn, rpcLog, close } = await harness();
    try {
      const result = await turn("ocp-a", "children_of", ["p_a"]);
      expect(result.reply.status, JSON.stringify(result)).toBe("accepted");
      // The verb returned p_a's ordered children — proof the fetched
      // projection reached the planning world.
      expect(result.result).toEqual([
        { child: "c_a1", rank: "V" },
        { child: "c_a2", rank: "W" }
      ]);
      // Exactly one repair round: attempt 1 misses p_a, attempt 2 succeeds.
      expect(result.attempt).toBe(2);
      // The repair issued the parent-scoped ordered-children fetch.
      expect(rpcLog.filter((p) => p === "/net/ordered-children").length).toBe(1);
    } finally {
      close();
    }
  });

  it("(b) reading TWO parents in one turn converges with BOTH projections", async () => {
    const { turn, rpcLog, close } = await harness();
    try {
      const result = await turn("ocp-b", "two_parents", ["p_a", "p_b"]);
      expect(result.reply.status, JSON.stringify(result)).toBe("accepted");
      expect(result.result).toEqual([
        [{ child: "c_a1", rank: "V" }, { child: "c_a2", rank: "W" }],
        [{ child: "c_b1", rank: "V" }]
      ]);
      // One repair round per new parent (miss p_a → miss p_b → succeed) = 3
      // attempts; both parents fetched exactly once (sticky across re-plans).
      expect(result.attempt).toBe(3);
      expect(rpcLog.filter((p) => p === "/net/ordered-children").length).toBe(2);
    } finally {
      close();
    }
  });

  it("(c) repair stays bounded: few rounds, envelope under the warm ceiling", async () => {
    const { turn, close } = await harness();
    try {
      const result = await turn("ocp-c", "two_parents", ["p_a", "p_b"]);
      expect(result.reply.status).toBe("accepted");
      expect(result.attempt).toBeLessThanOrEqual(4); // O(parents read), not O(siblings)
      expect(result.structure?.envelope_bytes).toBeLessThan(WARM_ENVELOPE_BYTE_LIMIT);
    } finally {
      close();
    }
  });

  it("(d) an absent/childless parent converges to [] with NO repair loop", async () => {
    const { turn, rpcLog, close } = await harness();
    try {
      // A ref with no edges: the authority returns an empty ordering, which
      // installs once and terminates the repair — never an unbounded loop.
      const result = await turn("ocp-d", "children_of", ["c_b1"]); // a leaf: no children
      expect(result.reply.status, JSON.stringify(result)).toBe("accepted");
      expect(result.result).toEqual([]);
      expect(result.attempt).toBe(2); // one fetch (empty), then success
      expect(rpcLog.filter((p) => p === "/net/ordered-children").length).toBe(1);
    } finally {
      close();
    }
  });
});
