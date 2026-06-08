import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import { executeInProcessV2DurableTurn } from "../src/server/dev-v2-helpers";
import { createShadowBrowserRelayShim, shadowBrowserSessionBearer } from "../src/core/shadow-browser-node";
import type { ShadowRelayCache } from "../src/core/shadow-relay-cache";
import type { MetricEvent, ObjRef, WooValue } from "../src/core/types";

// Browser/localdev per-turn cost measurement. Grounds perf work in exact metrics:
// how many full-world serializations a turn forces (serialized_world_materialized,
// each one an O(world) sort + array rebuild), how much that costs, and how stable
// it is across turns (a steady-state turn should not re-serialize the whole world).

function makeDevResolvers(world: ReturnType<typeof createWorld>, tag: string) {
  const gateways = new Map<ObjRef, ShadowRelayCache>();
  const commits = new Map<ObjRef, ShadowRelayCache>();
  const sparseSeed = createWorld({ catalogs: false }).exportWorld();
  return {
    gatewayRelayForScope: (s: ObjRef) => {
      let relay = gateways.get(s);
      if (!relay) { relay = createShadowBrowserRelayShim({ node: `dev:gw-${tag}-${s}`, scope: s, serialized: sparseSeed, deployment: "local-dev" }); gateways.set(s, relay); }
      return relay;
    },
    commitRelayForScope: (s: ObjRef) => {
      let relay = commits.get(s);
      if (!relay) { relay = createShadowBrowserRelayShim({ node: `dev:commit-${tag}-${s}`, scope: s, serialized: world.exportWorld(), deployment: "local-dev" }); commits.set(s, relay); }
      return relay;
    }
  };
}

type TurnCost = { label: string; materializations: number; objectsReserialized: number; matMs: number; metricCount: number };

describe("browser-localdev per-turn cost", () => {
  it("measures full-world (re)serialization per localdev turn", async () => {
    const world = createWorld();
    const totalObjects = world.exportWorld().objects.length;
    const g = world.auth("guest:perf");
    const resolvers = makeDevResolvers(world, "perf");
    const token = shadowBrowserSessionBearer({ id: g.id, actor: g.actor });
    const perTurn: TurnCost[] = [];

    const run = async (scope: ObjRef, target: ObjRef, verb: string, args: WooValue[], label: string) => {
      const metrics: MetricEvent[] = [];
      const res = await executeInProcessV2DurableTurn({
        world, ...resolvers, node: "dev:perf",
        call: { id: label, route: "sequenced", scope, session: g.id, actor: g.actor, target, verb, args, persistence: "durable", token },
        onMetric: (e) => metrics.push(e)
      });
      const mats = metrics.filter((m): m is Extract<MetricEvent, { kind: "serialized_world_materialized" }> => m.kind === "serialized_world_materialized");
      perTurn.push({
        label,
        materializations: mats.length,
        objectsReserialized: mats.reduce((s, m) => s + (m.objects ?? 0), 0),
        matMs: mats.reduce((s, m) => s + (m.ms ?? 0), 0),
        metricCount: metrics.length
      });
      return res;
    };

    // Representative steady-state sequence (same room, then a carry/move).
    await run("the_chatroom", "the_chatroom", "enter", [], "enter");
    await run("the_chatroom", "the_chatroom", "say", ["hello"], "say-1");
    await run("the_chatroom", "the_chatroom", "say", ["again"], "say-2");
    await run("the_chatroom", "the_chatroom", "say", ["third"], "say-3");

    // eslint-disable-next-line no-console
    console.log(`\n[browser-localdev perf] world objects=${totalObjects}`);
    // eslint-disable-next-line no-console
    console.table(perTurn);
    const steady = perTurn.slice(1); // exclude the first (cold) turn
    const avgReserialized = steady.reduce((s, t) => s + t.objectsReserialized, 0) / steady.length;
    // eslint-disable-next-line no-console
    console.log(`[browser-localdev perf] steady-state avg objects re-serialized/turn = ${avgReserialized.toFixed(0)} (world=${totalObjects})`);

    expect(perTurn.length).toBe(4);
    // Real guard: the core localdev turn primitive must NOT re-serialize the whole
    // world on a steady-state turn. Each materialization is an O(world) sort + array
    // rebuild; a regression that makes serializedFor re-materialize per turn would
    // push these above zero. This is the "core is lean" backstop for the browser/
    // localdev perf work (notes/2026-06-08-browser-localdev-perf.md): the measured
    // browser-side costs are addressed in v2-browser-worker.ts, and this asserts the
    // substrate underneath them stays free of full-world serialization churn.
    for (const turn of steady) {
      expect(turn.materializations, `turn ${turn.label} forced ${turn.materializations} full-world (re)serialization(s)`).toBe(0);
      expect(turn.objectsReserialized, `turn ${turn.label} re-serialized ${turn.objectsReserialized} objects`).toBe(0);
    }
  });
});
