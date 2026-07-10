// NC8 — the `load:net-skew` skewed-workload lane (spec/operations/
// net-cutover.md NC8). The asymptote lane (net-load-asymptote.test.ts)
// proves costs against EVENLY distributed state; production dies on the
// skew: one hot room, one huge audience, one high-degree owner, an alarm
// backlog under foreground writes, a slow or failing downstream
// authority. Each scenario here asserts a BOUND on the new NC8a counters
// (structure reports and woo.metric series), never a wall-clock number —
// in-process timing is not prod timing, but counts and refusal shapes
// are transport-independent.
//
// Fidelity note (the smoke-ladder rule): the fake-DO lane interleaves at
// await boundaries WITHOUT workerd's input gates, so contention here is
// at least as hot as production's per-DO serialization. What it cannot
// prove: real cross-colo tails and cold-start stalls — those remain the
// deployed canary's job (NC8).
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { NetGatewayDO, MAX_TURN_ATTEMPTS, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { installVerb } from "../../src/core/authoring";
import { createWorld } from "../../src/core/bootstrap";
import { cellsFromSerialized, type NetCellInput, type ShadowTurnCall } from "../../src/net/bridge";
import { netActivationCell } from "../../src/net/install";
import { CATALOG_SCOPE, partitionCells } from "../../src/net/topology";
import type { CommitReply, ScheduledTurn, ScopeHead } from "../../src/net/scope";

const SECRET = "net-load-skew-secret";
const EPOCH = "cat-net-skew-1";

function netState(name: string): {
  state: NetScopeDurableState & NetGatewayDurableState;
  settle: () => Promise<void>;
  close: () => void;
} {
  const fake = new FakeDurableObjectState(name);
  const deferred: Array<Promise<unknown>> = [];
  const state = {
    id: fake.id,
    waitUntil: (promise: Promise<unknown>) => {
      deferred.push(promise);
    },
    storage: {
      sql: fake.storage.sql,
      transactionSync: fake.storage.transactionSync,
      setAlarm: (_at: number) => {},
      deleteAlarm: () => {}
    }
  };
  return {
    state,
    settle: async () => {
      while (deferred.length > 0) await deferred.shift();
    },
    close: () => fake.close()
  };
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

type TurnStructureReport = {
  attempt: number;
  sync_rpc: number;
  reconstructions: number;
  plan_cells: number;
  snapshot_cells: number;
  rpc_ms: number;
  rpc_max_ms: number;
  rpc_depth: number;
  wall_ms: number;
};
type TurnBody = { reply: CommitReply; attempt: number; structure?: TurnStructureReport; error?: unknown };

/** Capture woo.metric emissions while keeping the log flowing. */
function captureMetrics(): { metrics: Array<Record<string, unknown>> } {
  const metrics: Array<Record<string, unknown>> = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    if (args[0] === "woo.metric" && typeof args[1] === "string") {
      try {
        metrics.push(JSON.parse(args[1]) as Record<string, unknown>);
      } catch {
        // non-JSON metric lines are not under test
      }
    }
  });
  return { metrics };
}

/**
 * One skew-world: a hot room (`skew_room`, own scope) holding a
 * contended counter box and `actors` guests, an away room
 * (`skew_annex`, own scope) optionally padded with `annexPad` objects,
 * every partition seeded to its own scope DO, one gateway shard over
 * them, warmed with a pull of the hot room.
 */
async function buildSkewHarness(options: { actors: number; annexPad?: number; gatewayFaults?: Record<string, unknown> }) {
  const world = createWorld();
  const guests: string[] = [];
  const sessions: string[] = [];
  for (let i = 0; i < options.actors; i += 1) {
    const session = world.auth(`guest:skew-${i}`);
    guests.push(session.actor);
    sessions.push(session.id);
  }
  const owner = guests[0];
  world.createObject({ id: "skew_room", name: "Skew Room", parent: "$space", owner });
  world.createObject({ id: "skew_annex", name: "Skew Annex", parent: "$space", owner });
  world.createObject({ id: "skew_box", name: "Skew Box", parent: "$thing", owner, anchor: "skew_room", location: "skew_room" });
  world.defineProperty("skew_box", { name: "counter", defaultValue: 0, owner, perms: "rw", typeHint: "int" });
  const installed = installVerb(
    world,
    "skew_box",
    "bump",
    `verb :bump() rxd {
      this.counter = this.counter + 1;
      observe({ type: "bumped", counter: this.counter });
      return this.counter;
    }`,
    null
  );
  expect(installed.ok).toBe(true);
  for (let i = 0; i < options.actors; i += 1) {
    const placed = await world.directCall(`skew-place-${i}`, guests[i], guests[i], "moveto", ["skew_room"], {
      sessionId: sessions[i]
    });
    expect(placed.op, `place guest ${i}`).toBe("result");
  }
  // High-degree padding: objects anchored in the OTHER room — one owner
  // scope carrying hundreds of members the hot-room turn never reads.
  for (let i = 0; i < (options.annexPad ?? 0); i += 1) {
    world.createObject({
      id: `skew_pad_${i}`,
      name: `Pad ${i}`,
      parent: "$thing",
      owner,
      anchor: "skew_annex",
      location: "skew_annex"
    });
    world.defineProperty(`skew_pad_${i}`, { name: "n", defaultValue: i, owner, perms: "rw", typeHint: "int" });
  }

  const partitions = partitionCells(cellsFromSerialized(world.exportWorld()));
  partitions.set(CATALOG_SCOPE, [...(partitions.get(CATALOG_SCOPE) ?? []), netActivationCell(EPOCH)]);

  const states: Array<ReturnType<typeof netState>> = [];
  const scopeDOs = new Map<string, NetScopeDO>();
  const resolve = (destination: string) => {
    if (destination.startsWith("scope:")) {
      const instance = scopeDOs.get(destination.slice("scope:".length));
      if (instance) return instance;
    }
    if (destination.startsWith("gateway:")) return gateway;
    throw new Error(`unresolvable destination ${destination}`);
  };
  const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve };
  for (const [scope, cells] of partitions) {
    const st = netState(`skew-scope-${scope}`);
    states.push(st);
    const instance = new NetScopeDO(st.state, scopeEnv);
    const seeded = await call<{ ok: boolean }>(instance, scopeEnv, "/seed", { scope, catalog_epoch: EPOCH, cells });
    expect(seeded.ok, `seed ${scope}`).toBe(true);
    scopeDOs.set(scope, instance);
  }
  const roomScope = "room:skew_room";
  const gatewayState = netState("skew-gateway");
  states.push(gatewayState);
  const gatewayEnv: NetGatewayEnv = {
    WOO_INTERNAL_SECRET: SECRET,
    NET_RESOLVE: resolve,
    ...(options.gatewayFaults ? { WOO_NET_FAULTS: JSON.stringify(options.gatewayFaults) } : {})
  } as NetGatewayEnv;
  const gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);
  // Catalog first: the room transfer's class chains ($thing/$space) are
  // lineage-closed only once the shared substrate is in view.
  await call(gateway, gatewayEnv, "/pull", { scope: CATALOG_SCOPE, destination: `scope:${CATALOG_SCOPE}` });
  await call(gateway, gatewayEnv, "/pull", { scope: roomScope, destination: `scope:${roomScope}` });

  const bump = (key: string, actor: string): ShadowTurnCall => ({
    kind: "woo.turn_call.shadow.v1",
    id: key,
    route: "direct",
    scope: roomScope,
    actor,
    target: "skew_box",
    verb: "bump",
    args: []
  });
  const turnRequest = (key: string, actor: string) => ({
    call: bump(key, actor),
    planningScope: roomScope,
    catalog_epoch: EPOCH,
    idempotency_key: key
  });

  return {
    world,
    guests,
    roomScope,
    scopeDOs,
    gateway,
    gatewayEnv,
    scopeEnv,
    turnRequest,
    settle: async () => {
      for (const st of states) await st.settle();
    },
    close: () => states.forEach((st) => st.close())
  };
}

/** The box counter read straight from the authority (integrity oracle). */
async function boxCounter(h: Awaited<ReturnType<typeof buildSkewHarness>>): Promise<number> {
  const scopeDO = h.scopeDOs.get(h.roomScope) as NetScopeDO;
  const closure = await call<{ cells: Array<{ key: string; value: unknown }> }>(scopeDO, h.scopeEnv, "/closure", {
    keys: ["property_cell:skew_box:counter"],
    known: []
  });
  const cell = closure.cells.find((entry) => entry.key === "property_cell:skew_box:counter");
  const payload = cell?.value as { value?: number } | undefined;
  return payload?.value ?? 0;
}

describe("load:net-skew — skewed-workload bounds (NC8)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hot room: concurrent same-cell writers converge under client retry with named verdicts and exact serialization", async () => {
    const WRITERS = 10;
    const h = await buildSkewHarness({ actors: WRITERS });

    // Wave 1: all writers CONCURRENTLY, same cell. The fake lane
    // interleaves at await boundaries, so every loser races the winners'
    // commits — the thundering-herd shape.
    const first = await Promise.all(
      h.guests.map((actor, i) =>
        call<TurnBody>(h.gateway, h.gatewayEnv, "/turn", h.turnRequest(`skew-hot-${i}`, actor)).catch((err) => ({
          error: String(err)
        }) as unknown as TurnBody)
      )
    );
    // Every outcome is LEGIBLE: accepted, or the named convergence
    // budget — never a bare 500, never a wedged reply.
    const accepted1 = first.filter((turn) => turn.reply?.status === "accepted");
    const budgeted = first.filter((turn) => turn.error !== undefined);
    for (const failed of budgeted) {
      expect(String(failed.error)).toContain("E_BUDGET");
    }
    expect(accepted1.length + budgeted.length).toBe(WRITERS);
    // Progress guarantee: contention slows losers, it must not starve
    // the scope — at least half the herd lands in wave 1.
    expect(accepted1.length).toBeGreaterThanOrEqual(WRITERS / 2);

    // Client retry (same idempotency keys) converges the remainder.
    // Bounded: one extra wave suffices in-process; a regression that
    // livelocks the loop fails here.
    const retried = await Promise.all(
      first.map((turn, i) =>
        turn.reply?.status === "accepted"
          ? Promise.resolve(turn)
          : call<TurnBody>(h.gateway, h.gatewayEnv, "/turn", h.turnRequest(`skew-hot-${i}`, h.guests[i]))
      )
    );
    for (const [i, turn] of retried.entries()) {
      expect(turn.reply?.status, `writer ${i} after retry`).toBe("accepted");
      // NC8b: no turn, however contended, exceeds the attempt or RPC caps.
      expect(turn.attempt).toBeLessThanOrEqual(MAX_TURN_ATTEMPTS);
      expect(turn.structure?.sync_rpc ?? 0).toBeLessThanOrEqual(32);
    }

    // Serialization integrity: the authority's counter equals the number
    // of DISTINCT accepted turns — no lost update, no double-commit
    // (replayed retries must not re-apply).
    expect(await boxCounter(h)).toBe(WRITERS);
    h.close();
  });

  it("large audience: fanout scan and push track room occupancy, not total mirrored sessions", async () => {
    const OCCUPANTS = 24;
    const h = await buildSkewHarness({ actors: OCCUPANTS });
    // The gateway receives the room's fanout (the client shard's
    // sessionOpen does this via selfSubscribe; the lane wires it directly).
    await call(h.scopeDOs.get(h.roomScope) as NetScopeDO, h.scopeEnv, "/subscribe", { destination: "gateway:skew" });
    const capture = captureMetrics();

    // Seed the gateway's presence relation the CO13 way: relation-row
    // deltas riding a fanout apply at the subscriber. Simulate OCCUPANTS
    // present sessions in the hot room plus 3x as many sessions mirrored
    // for OTHER scopes — the scan must stay O(room occupants).
    const gw = h.gateway as unknown as {
      applyRelationDelta(delta: { op: "add"; row: { relation: string; owner: string; member: string; body?: unknown } }): void;
    };
    for (let i = 0; i < OCCUPANTS; i += 1) {
      gw.applyRelationDelta({
        op: "add",
        row: {
          relation: "session_presence",
          owner: "skew_room",
          member: `s_test_${i}`,
          body: { actor: h.guests[i % h.guests.length] }
        }
      });
    }
    for (let i = 0; i < OCCUPANTS * 3; i += 1) {
      gw.applyRelationDelta({
        op: "add",
        row: {
          relation: "session_presence",
          owner: "skew_annex",
          member: `s_away_${i}`,
          body: { actor: "nobody" }
        }
      });
    }

    // One turn in the hot room; its fanout returns to this gateway
    // (subscribed by the pull) and pushes to the room's audience.
    const turn = await call<TurnBody>(h.gateway, h.gatewayEnv, "/turn", h.turnRequest("skew-aud-1", h.guests[0]));
    expect(turn.reply.status).toBe("accepted");
    await h.settle();

    const scans = capture.metrics.filter((m) => m.kind === "net_presence_scan" && m.scope === h.roomScope);
    const pushes = capture.metrics.filter((m) => m.kind === "net_push" && m.scope === h.roomScope);
    expect(scans.length).toBeGreaterThanOrEqual(1);
    expect(pushes.length).toBeGreaterThanOrEqual(1);
    // THE INVARIANT: audience == room occupants; the 3x off-room sessions
    // never enter the scan (indexed owner_scope filter, N+1 fixed).
    for (const scan of scans) expect(scan.presence_scan_rows).toBe(OCCUPANTS);
    for (const push of pushes) {
      expect(push.audience).toBe(OCCUPANTS);
      expect(push.observations).toBeGreaterThanOrEqual(1);
    }
    h.close();
  });

  it("high-degree owner isolation: a 200-member annex adds nothing to the hot room's turn", async () => {
    const base = await buildSkewHarness({ actors: 2 });
    const padded = await buildSkewHarness({ actors: 2, annexPad: 200 });

    const measure = async (h: Awaited<ReturnType<typeof buildSkewHarness>>): Promise<TurnStructureReport> => {
      await call<TurnBody>(h.gateway, h.gatewayEnv, "/turn", h.turnRequest("skew-deg-warm", h.guests[0]));
      const turn = await call<TurnBody>(h.gateway, h.gatewayEnv, "/turn", h.turnRequest("skew-deg-measure", h.guests[1]));
      expect(turn.reply.status).toBe("accepted");
      return turn.structure as TurnStructureReport;
    };
    const small = await measure(base);
    const large = await measure(padded);

    // The padded world's HOT-ROOM turn: identical structure. The
    // high-degree owner is another scope; its degree must not leak into
    // this turn's plan, snapshot, or RPC chain.
    expect(large.plan_cells - small.plan_cells).toBeLessThanOrEqual(4);
    expect(large.snapshot_cells - small.snapshot_cells).toBeLessThanOrEqual(4);
    expect(large.sync_rpc).toBe(small.sync_rpc);
    expect(large.rpc_depth).toBe(small.rpc_depth);
    base.close();
    padded.close();
  });

  it("alarm backlog: 40 parked scheduled turns do not degrade foreground commits", async () => {
    const h = await buildSkewHarness({ actors: 2 });
    const scopeDO = h.scopeDOs.get(h.roomScope) as NetScopeDO;

    // Backlog: 40 near-due turns with NO planner-role subscriber — the
    // alarm parks them (rows retained). This is the pathological shape:
    // a scope whose scheduled family is saturated.
    const due = Date.now() + 20;
    for (let i = 0; i < 40; i += 1) {
      await call(scopeDO, h.scopeEnv, "/schedule", {
        scope: h.roomScope,
        catalog_epoch: EPOCH,
        turn: { id: `skew-sched-${i}`, at_logical_time: due, call: { actor: "#a", target: "#t", verb: "tick", args: [] } } satisfies ScheduledTurn
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    await scopeDO.alarm();
    await h.settle();

    // Foreground turns land first-attempt with the warm RPC budget —
    // the parked backlog adds zero rounds and zero RPC to the write path.
    await call<TurnBody>(h.gateway, h.gatewayEnv, "/turn", h.turnRequest("skew-fg-warm", h.guests[0]));
    const fg = await call<TurnBody>(h.gateway, h.gatewayEnv, "/turn", h.turnRequest("skew-fg-measure", h.guests[1]));
    expect(fg.reply.status).toBe("accepted");
    expect(fg.attempt).toBe(1);
    expect(fg.structure?.sync_rpc ?? 99).toBeLessThanOrEqual(3);
    h.close();
  });

  it("slow authority: injected submit latency lands in the turn's rpc_ms series", async () => {
    const h = await buildSkewHarness({ actors: 1, gatewayFaults: { "/submit": { latency_ms: 60 } } });
    const turn = await call<TurnBody>(h.gateway, h.gatewayEnv, "/turn", h.turnRequest("skew-slow-1", h.guests[0]));
    expect(turn.reply.status).toBe("accepted");
    // The evidence chain the canary dashboards read: a slow authority is
    // visible per-turn, attributed to its slowest step.
    expect(turn.structure?.rpc_ms ?? 0).toBeGreaterThanOrEqual(60);
    expect(turn.structure?.rpc_max_ms ?? 0).toBeGreaterThanOrEqual(60);
    expect(turn.structure?.wall_ms ?? 0).toBeGreaterThanOrEqual(turn.structure?.rpc_ms ?? 0);
    h.close();
  });

  it("failing authority: a cold gateway against a dead /closure exhausts to the named budget with bounded amplification", async () => {
    const capture = captureMetrics();
    const h = await buildSkewHarness({ actors: 2 });

    // The retrying-caller-vs-dead-owner shape: a COLD gateway (empty
    // view) whose every /closure — the only repair primitive — dies.
    // Its turn must exhaust to a NAMED verdict with bounded work: the
    // 12s repair amplifier class from the v2 postmortems, now capped by
    // MAX_TURN_ATTEMPTS and the NC8b per-turn RPC budget.
    const gw2State = netState("skew-gateway-cold");
    const deadEnv: NetGatewayEnv = {
      ...h.gatewayEnv,
      WOO_NET_FAULTS: JSON.stringify({ "/closure": { error: "injected-authority-down" } })
    } as NetGatewayEnv;
    const gw2 = new NetGatewayDO(gw2State.state, deadEnv);
    const dead = await call<TurnBody>(gw2, deadEnv, "/turn", h.turnRequest("skew-dead-1", h.guests[0])).catch(
      (err) => ({ error: String(err) }) as unknown as TurnBody
    );
    expect(dead.error, "the cold turn must fail, namedly").toBeDefined();
    expect(String(dead.error)).toMatch(/E_BUDGET|E_MISSING_STATE/);
    // Bounded amplification: the failed turn's structure metric stays
    // inside the NC8b caps — no unbounded retry storm.
    const errorStructures = capture.metrics.filter((m) => m.kind === "net_turn_structure");
    expect(errorStructures.length).toBeGreaterThanOrEqual(1);
    for (const metric of errorStructures) {
      expect(metric.sync_rpc as number).toBeLessThanOrEqual(32);
      expect(metric.attempt as number).toBeLessThanOrEqual(MAX_TURN_ATTEMPTS + 1);
    }
    gw2State.close();
    h.close();
  });
});
