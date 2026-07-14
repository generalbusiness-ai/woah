// Reproduction: outliner `add` over the net path must CONVERGE (commit
// within the attempt budget). Against deployed prod it deterministically
// fails with E_BUDGET after a read_version_mismatch repair loop
// (max_attempts:6). This drives the same turn through the in-process
// fake-DO net harness to prove whether the non-convergence reproduces
// locally and to pin the non-stabilizing read.
import { describe, expect, it } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { planNetInstall } from "../../src/net/install";
import { cellsFromSerialized } from "../../src/net/bridge";
import { partitionCells } from "../../src/net/topology";
import type { AttemptTraceEntry } from "../../src/net/errors";
import type { CommitReply } from "../../src/net/scope";

const SECRET = "net-outliner-converge-secret";

function netState(name: string): {
  state: NetScopeDurableState & NetGatewayDurableState;
  settle: () => Promise<void>;
  close: () => void;
} {
  const fake = new FakeDurableObjectState(name);
  const deferred: Array<Promise<unknown>> = [];
  const state = {
    id: fake.id,
    waitUntil: (promise: Promise<unknown>) => { deferred.push(promise); },
    storage: {
      sql: fake.storage.sql,
      transactionSync: fake.storage.transactionSync,
      setAlarm: (_at: number) => {},
      deleteAlarm: () => {}
    }
  };
  return {
    state,
    settle: async () => { while (deferred.length > 0) await deferred.shift(); },
    close: () => fake.close()
  };
}

type Fetchable = { fetch(request: Request): Promise<Response> | Response };

async function call<T>(target: Fetchable, env: { WOO_INTERNAL_SECRET?: string }, route: string, body?: unknown): Promise<T> {
  const url = `https://do/net${route}`;
  const request = body === undefined
    ? new Request(url)
    : new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const signed = await signInternalRequest(env, request);
  const response = await target.fetch(signed);
  const decoded = (await response.json()) as T;
  if (!response.ok) throw new Error(`call ${route} failed: ${JSON.stringify(decoded)}`);
  return decoded;
}

type TurnBody = {
  reply: CommitReply;
  attempt: number;
  trace: AttemptTraceEntry[];
  result?: unknown;
};

describe("outliner add over the net path converges", () => {
  it("commits an add turn to the_outline without a read_version_mismatch repair loop", async () => {
    // Full bundled install — the same world the cutover seeded (epoch
    // cat-1926a87fb31f4ea4). the_outline exists with 0 items.
    const plan = await planNetInstall();
    const world = plan.world;
    const serialized = world.exportWorld();
    const outline = serialized.objects.find((o) => o.parent === "$outliner");
    if (!outline) throw new Error("no $outliner instance seeded");
    const theOutline = outline.id;

    // Place an actor in the outliner so `add` runs with the actor present.
    const session = world.auth("guest:outliner-repro");
    const actor = session.actor;
    const placed = await world.directCall("place", actor, actor, "moveto", [theOutline], { sessionId: session.id });
    expect(placed.op).toBe("result");

    // Re-partition the mutated world and seed every scope DO.
    const partitions = partitionCells(cellsFromSerialized(world.exportWorld()));
    const epoch = plan.epoch;
    const roomScope = `room:${theOutline}`;
    expect([...partitions.keys()]).toContain(roomScope);

    const scopeDOs = new Map<string, NetScopeDO>();
    const scopeEnv: NetScopeEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        const scope = destination.startsWith("scope:") ? destination.slice("scope:".length) : null;
        const instance = scope !== null ? scopeDOs.get(scope) : undefined;
        if (!instance) throw new Error(`unexpected scope-side destination ${destination}`);
        return instance;
      }
    };
    for (const [scope, cells] of partitions) {
      const st = netState(`scope-${scope}`);
      const instance = new NetScopeDO(st.state, scopeEnv);
      await call(instance, scopeEnv, "/seed", { scope, catalog_epoch: epoch, cells });
      scopeDOs.set(scope, instance);
    }

    const rpcLog: string[] = [];
    const gatewayState = netState("gateway-outliner");
    const gatewayEnv: NetGatewayEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        const scope = destination.startsWith("scope:") ? destination.slice("scope:".length) : null;
        const instance = scope !== null ? scopeDOs.get(scope) : undefined;
        if (!instance) throw new Error(`unexpected destination ${destination}`);
        return {
          fetch: async (request: Request) => {
            rpcLog.push(`${destination}${new URL(request.url).pathname}`);
            return await instance.fetch(request);
          }
        };
      }
    };
    const gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);
    for (const scope of partitions.keys()) {
      await call(gateway, gatewayEnv, "/pull", { scope, destination: `scope:${scope}` });
    }

    // Drive SEQUENTIAL adds in one session. Each add rewrites the
    // per-actor last_undo/focus_by_actor maps; if a later add loops to
    // E_BUDGET the non-empty obj-ref map round-trip is the trigger (the
    // "third item fails" report).
    for (let i = 1; i <= 4; i += 1) {
      const turn = await call<TurnBody>(gateway, gatewayEnv, "/turn", {
        call: {
          kind: "woo.turn_call.shadow.v1",
          id: `outliner-add-${i}`,
          route: "direct",
          scope: roomScope,
          session: session.id,
          actor,
          target: theOutline,
          verb: "add",
          args: [`item ${i}`]
        },
        planningScope: roomScope,
        catalog_epoch: epoch,
        idempotency_key: `outliner-add-${i}`
      });
      // Surface the attempt trace on failure so the reject reason is visible.
      expect(turn.reply.status, `add #${i}: attempts=${turn.attempt} trace=${JSON.stringify(turn.trace)}`).toBe("accepted");
      // Converge CLEANLY, not merely under the 6-attempt budget: one
      // sibling-property repair round is expected once siblings exist, so
      // bound attempts well below MAX_TURN_ATTEMPTS to catch a regression
      // that trades E_BUDGET for a near-budget grind.
      expect(turn.attempt, `add #${i} took ${turn.attempt} attempts`).toBeLessThanOrEqual(3);
    }
  });
});
