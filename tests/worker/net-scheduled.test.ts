// CO16 scheduled-turn execution (Plan 002 Phase 3.5 item 5). Fake-DO
// lane over real per-instance SQLite.
//
// Chunk 1 (scope side): /net/subscribe roles (fanout | planner) with the
// legacy-table migration; alarm() moves each DUE scheduled turn
// ATOMICALLY from the scheduled row family to a durable /plan-scheduled
// outbox row addressed to ONE deterministic planner; no planner → the
// turn stays parked with the named metric; a delivery fault leaves a
// durable pending row that drain-on-reactivation delivers (at-least-once,
// never lost).
//
// Chunk 2 (planner side): NetGatewayDO POST /net/plan-scheduled runs the
// normal turn machinery under the stable `sched:<id>:<at_logical_time>`
// idempotency key — end-to-end effect lands in scope authority, a
// REDELIVERED dispatch cannot double-commit (the scope's reply cache),
// and a cold planner view converges via pull-on-miss.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { installVerb } from "../../src/core/authoring";
import { createWorld } from "../../src/core/bootstrap";
import { cellsFromSerialized } from "../../src/net/bridge";
import { CATALOG_SCOPE, partitionCells } from "../../src/net/topology";
import type { CommitReply, ScheduledTurn } from "../../src/net/scope";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import type { NetStub } from "../../src/worker/net/workerd-host";

const SECRET = "net-scheduled-test-secret";
const EPOCH = "cat-net-sched-1";
const SCOPE = "room-sched";

/** Fake DO state + alarm recording + waitUntil capture (the same shape
 * as net-do/net-scope-fanout tests). */
function netState(name: string) {
  const fake = new FakeDurableObjectState(name);
  const deferred: Array<Promise<unknown>> = [];
  const alarms: Array<number | null> = [];
  const state: NetScopeDurableState & NetGatewayDurableState = {
    id: fake.id,
    waitUntil: (promise: Promise<unknown>) => {
      deferred.push(promise);
    },
    storage: {
      sql: fake.storage.sql,
      transactionSync: fake.storage.transactionSync,
      setAlarm: (at: number) => {
        alarms.push(at);
      },
      deleteAlarm: () => {
        alarms.push(null);
      }
    }
  };
  return {
    state,
    alarms,
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

/** A 200-replying planner stub that records every /net/plan-scheduled
 * body it receives (chunk-1 tests need only the delivery contract; the
 * real NetGatewayDO planner is chunk 2's end-to-end suite below). */
function plannerStub(): { stub: NetStub; received: Array<{ path: string; body: unknown }> } {
  const received: Array<{ path: string; body: unknown }> = [];
  return {
    received,
    stub: {
      fetch: async (request: Request) => {
        const url = new URL(request.url);
        received.push({ path: url.pathname, body: request.method === "POST" ? await request.json() : undefined });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
  };
}

function scheduledRows(state: NetScopeDurableState): Array<{ id: string }> {
  return (state.storage.sql.exec("SELECT id FROM net_scope_scheduled") as { toArray(): Array<{ id: string }> }).toArray();
}

function outboxRows(state: NetScopeDurableState): Array<{ route: string; destination: string; status: string; attempts: number }> {
  return (
    state.storage.sql.exec("SELECT route, destination, status, attempts FROM net_scope_outbox") as {
      toArray(): Array<{ route: string; destination: string; status: string; attempts: number }>;
    }
  ).toArray();
}

function subscriberRows(state: NetScopeDurableState): Array<{ destination: string; role: string }> {
  return (
    state.storage.sql.exec("SELECT destination, role FROM net_scope_subscribers ORDER BY destination, role") as {
      toArray(): Array<{ destination: string; role: string }>;
    }
  ).toArray();
}

function tick(id: string, atMs: number): ScheduledTurn {
  return { id, at_logical_time: atMs, call: { actor: "#actor", target: "#thing", verb: "tick", args: [] } };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("CO16 scheduled-turn dispatch at the scope (chunk 1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("alarm moves a due turn atomically to the outbox; the planner receives /net/plan-scheduled", async () => {
    const metricLines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      metricLines.push(args.map(String).join(" "));
    });
    const planner = plannerStub();
    const scope = netState(`scope-${SCOPE}-dispatch`);
    const env: NetScopeEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        if (destination === "gateway:planner-a") return planner.stub;
        throw new Error(`unexpected destination ${destination}`);
      }
    };
    const scopeDO = new NetScopeDO(scope.state, env);
    await call(scopeDO, env, "/subscribe", { destination: "gateway:planner-a", role: "planner" });
    await call(scopeDO, env, "/schedule", { scope: SCOPE, catalog_epoch: EPOCH, turn: tick("sched-1", Date.now() + 30) });
    expect(scheduledRows(scope.state).map((row) => row.id)).toEqual(["sched-1"]);

    await sleep(60);
    await scopeDO.alarm();
    await scope.settle();

    // The turn changed family (scheduled → outbox) and delivered: neither
    // family holds it now, and the planner got the full dispatch body.
    expect(scheduledRows(scope.state)).toEqual([]);
    expect(outboxRows(scope.state)).toEqual([]);
    expect(planner.received.filter((entry) => entry.path === "/net/plan-scheduled")).toHaveLength(1);
    const body = planner.received[0].body as { scheduled_turn: ScheduledTurn; scope: string; catalog_epoch: string };
    expect(body.scope).toBe(SCOPE);
    expect(body.catalog_epoch).toBe(EPOCH);
    expect(body.scheduled_turn.id).toBe("sched-1");
    expect(body.scheduled_turn.call.verb).toBe("tick");
    expect(metricLines.some((line) => line.includes("net_scope_scheduled_turn_dispatched"))).toBe(true);
  });

  it("no planner registered → the due turn stays parked with the named metric (fanout role does not qualify)", async () => {
    const metricLines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      metricLines.push(args.map(String).join(" "));
    });
    const fanout = plannerStub(); // records anything sent its way
    const scope = netState(`scope-${SCOPE}-parked`);
    const env: NetScopeEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: () => fanout.stub
    };
    const scopeDO = new NetScopeDO(scope.state, env);
    // A fanout-role subscriber exists; it must NOT be picked as planner.
    await call(scopeDO, env, "/subscribe", { destination: "gateway:sub-fanout" });
    await call(scopeDO, env, "/schedule", { scope: SCOPE, catalog_epoch: EPOCH, turn: tick("sched-parked", Date.now() + 30) });

    await sleep(60);
    await scopeDO.alarm();
    await scope.settle();

    // Parked: row retained, nothing enqueued, named metric emitted.
    expect(scheduledRows(scope.state).map((row) => row.id)).toEqual(["sched-parked"]);
    expect(outboxRows(scope.state)).toEqual([]);
    expect(fanout.received).toEqual([]);
    const fired = metricLines.filter((line) => line.includes("net_scope_scheduled_turn_fired"));
    expect(fired).toHaveLength(1);
    expect(fired[0]).toContain("no planner-role subscriber registered");
  });

  it("a later planner subscription arms an immediate wake for parked overdue turns", async () => {
    const planner = plannerStub();
    const scope = netState(`scope-${SCOPE}-late-planner`);
    const env: NetScopeEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        if (destination === "gateway:planner-late") return planner.stub;
        throw new Error(`unexpected destination ${destination}`);
      }
    };
    const scopeDO = new NetScopeDO(scope.state, env);
    await call(scopeDO, env, "/schedule", { scope: SCOPE, catalog_epoch: EPOCH, turn: tick("sched-late", Date.now() + 30) });
    await sleep(60);
    await scopeDO.alarm(); // fires with no planner: parked
    expect(scheduledRows(scope.state)).toHaveLength(1);
    const armedBefore = scope.alarms.length;

    await call(scopeDO, env, "/subscribe", { destination: "gateway:planner-late", role: "planner" });
    // The subscribe armed an immediate wake (rearmAlarm never arms for
    // overdue rows, so without this the parked turn would wait for an
    // unrelated alarm).
    const armedAfter = scope.alarms.slice(armedBefore).filter((at): at is number => at !== null);
    expect(armedAfter.length).toBeGreaterThanOrEqual(1);
    expect(armedAfter[armedAfter.length - 1]).toBeLessThanOrEqual(Date.now());

    // The wake (fired here directly — fake alarms never self-fire)
    // dispatches the parked turn.
    await scopeDO.alarm();
    await scope.settle();
    expect(scheduledRows(scope.state)).toEqual([]);
    expect(planner.received.filter((entry) => entry.path === "/net/plan-scheduled")).toHaveLength(1);
  });

  it("a faulted planner delivery leaves a durable pending row (crash window) that drain-on-reactivation delivers", async () => {
    const planner = plannerStub();
    const resolve = (destination: string) => {
      if (destination === "gateway:planner-a") return planner.stub;
      throw new Error(`unexpected destination ${destination}`);
    };
    const scope = netState(`scope-${SCOPE}-crash`);
    const faultedEnv: NetScopeEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      WOO_NET_FAULTS: JSON.stringify({ "/plan-scheduled": { error: "planner lane down" } }),
      NET_RESOLVE: resolve
    };
    const faultedDO = new NetScopeDO(scope.state, faultedEnv);
    await call(faultedDO, faultedEnv, "/subscribe", { destination: "gateway:planner-a", role: "planner" });
    await call(faultedDO, faultedEnv, "/schedule", { scope: SCOPE, catalog_epoch: EPOCH, turn: tick("sched-crash", Date.now() + 30) });

    await sleep(60);
    await faultedDO.alarm();
    await scope.settle();

    // The atomic family move happened (scheduled empty) and the delivery
    // failure left the durable row pending — the turn is in exactly one
    // family, never lost.
    expect(scheduledRows(scope.state)).toEqual([]);
    expect(outboxRows(scope.state)).toEqual([
      { route: "/plan-scheduled", destination: "gateway:planner-a", status: "pending", attempts: 1 }
    ]);
    expect(planner.received).toEqual([]);

    // "Reactivation": fresh DO over the SAME storage, fault gone; the
    // first request kicks drain-on-reactivation past the backoff window.
    await sleep(300);
    const healthyEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve };
    const healthyDO = new NetScopeDO(scope.state, healthyEnv);
    await call(healthyDO, healthyEnv, "/head");
    await scope.settle();
    expect(outboxRows(scope.state)).toEqual([]);
    expect(planner.received.filter((entry) => entry.path === "/net/plan-scheduled")).toHaveLength(1);
  });

  it("migrates a legacy destination-only subscribers table: existing rows keep working as fanout", async () => {
    const scope = netState(`scope-${SCOPE}-migrate`);
    // Pre-CO16 shape, written before the DO class ever runs.
    scope.state.storage.sql.exec("CREATE TABLE net_scope_subscribers (destination TEXT PRIMARY KEY)");
    scope.state.storage.sql.exec("INSERT INTO net_scope_subscribers (destination) VALUES (?)", "gateway:legacy-sub");

    const env: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET };
    const scopeDO = new NetScopeDO(scope.state, env);
    // The legacy row survived the recreate with role='fanout'.
    expect(subscriberRows(scope.state)).toEqual([{ destination: "gateway:legacy-sub", role: "fanout" }]);
    // Both roles coexist for one destination (PK is (destination, role)),
    // and construction is idempotent over the migrated table.
    await call(scopeDO, env, "/subscribe", { destination: "gateway:legacy-sub", role: "planner" });
    new NetScopeDO(scope.state, env);
    expect(subscriberRows(scope.state)).toEqual([
      { destination: "gateway:legacy-sub", role: "fanout" },
      { destination: "gateway:legacy-sub", role: "planner" }
    ]);
    // An unknown role refuses loudly.
    await expect(call(scopeDO, env, "/subscribe", { destination: "gateway:x", role: "observer" })).rejects.toThrow(/role/);
  });

  it("picks the lexicographically first planner deterministically", async () => {
    const plannerA = plannerStub();
    const plannerB = plannerStub();
    const scope = netState(`scope-${SCOPE}-pick`);
    const env: NetScopeEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        if (destination === "gateway:planner-a") return plannerA.stub;
        if (destination === "gateway:planner-b") return plannerB.stub;
        throw new Error(`unexpected destination ${destination}`);
      }
    };
    const scopeDO = new NetScopeDO(scope.state, env);
    // Registered out of order; "gateway:planner-a" sorts first.
    await call(scopeDO, env, "/subscribe", { destination: "gateway:planner-b", role: "planner" });
    await call(scopeDO, env, "/subscribe", { destination: "gateway:planner-a", role: "planner" });
    await call(scopeDO, env, "/schedule", { scope: SCOPE, catalog_epoch: EPOCH, turn: tick("sched-pick", Date.now() + 30) });
    await sleep(60);
    await scopeDO.alarm();
    await scope.settle();
    expect(plannerA.received.filter((entry) => entry.path === "/net/plan-scheduled")).toHaveLength(1);
    expect(plannerB.received).toEqual([]);
  });
});

// ---- Chunk 2: the planner gateway executes exactly once --------------------
describe("CO16 planner gateway execution (chunk 2, end-to-end over fake-DO)", () => {
  it("alarm → planner plans+submits the scheduled verb turn; redelivery cannot double-commit; a cold planner converges via pull-on-miss", async () => {
    // ---- Engine-real fixture: a room, a room-anchored box with a
    // counter-only bump verb, and the real actor placed in the room —
    // partitioned into room/cluster/catalog scope DOs (CO15, the default
    // proving fixture).
    const world = createWorld();
    const session = world.auth("guest:net-sched");
    const actor = session.actor;
    world.createObject({ id: "sched_room", name: "Sched Room", parent: "$space", owner: actor });
    world.createObject({ id: "sched_box", name: "Sched Box", parent: "$thing", owner: actor, anchor: "sched_room", location: "sched_room" });
    world.defineProperty("sched_box", { name: "counter", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
    const installed = installVerb(
      world,
      "sched_box",
      "bump",
      `verb :bump() rxd {
        this.counter = this.counter + 1;
        return this.counter;
      }`,
      null
    );
    expect(installed.ok).toBe(true);
    const placed = await world.directCall("sched-genesis-place", actor, actor, "moveto", ["sched_room"], { sessionId: session.id });
    expect(placed.op).toBe("result");

    const partitions = partitionCells(cellsFromSerialized(world.exportWorld()));
    const roomScope = "room:sched_room";
    const clusterScope = `cluster:${actor}`;
    expect([...partitions.keys()]).toEqual(expect.arrayContaining([roomScope, clusterScope, CATALOG_SCOPE]));

    // ---- Scope DOs + the planner gateway, wired by the CO15
    // `scope:<scopeName>` convention. The room reaches the planner as
    // `gateway:sched-gw`; RPCs are logged per destination+path so the
    // test can assert WHERE dispatches and pull-on-miss went.
    const rpcLog: string[] = [];
    const scopeDOs = new Map<string, NetScopeDO>();
    const gateways = new Map<string, NetGatewayDO>();
    const resolve = (destination: string): NetStub => {
      const target = destination.startsWith("scope:")
        ? scopeDOs.get(destination.slice("scope:".length))
        : destination.startsWith("gateway:")
          ? gateways.get(destination.slice("gateway:".length))
          : undefined;
      if (!target) throw new Error(`unexpected destination ${destination}`);
      return {
        fetch: (request: Request) => {
          rpcLog.push(`${destination}${new URL(request.url).pathname}`);
          return target.fetch(request);
        }
      };
    };
    const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve };
    const gatewayEnv: NetGatewayEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve };
    const doStates = new Map<string, ReturnType<typeof netState>>();
    for (const scope of [roomScope, clusterScope, CATALOG_SCOPE]) {
      const st = netState(`scope-${scope}`);
      const instance = new NetScopeDO(st.state, scopeEnv);
      await call(instance, scopeEnv, "/seed", { scope, catalog_epoch: EPOCH, cells: partitions.get(scope) ?? [] });
      doStates.set(scope, st);
      scopeDOs.set(scope, instance);
    }
    const gatewayState = netState("gateway-sched");
    const gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);
    gateways.set("sched-gw", gateway);
    for (const scope of [roomScope, clusterScope, CATALOG_SCOPE]) {
      await call(gateway, gatewayEnv, "/pull", { scope, destination: `scope:${scope}` });
    }
    const roomDO = scopeDOs.get(roomScope) as NetScopeDO;
    const roomState = doStates.get(roomScope) as ReturnType<typeof netState>;
    await call(roomDO, scopeEnv, "/subscribe", { destination: "gateway:sched-gw", role: "planner" });

    const counterAt = async (): Promise<unknown> => {
      const closure = await call<{ cells: Array<{ value: unknown }> }>(roomDO, scopeEnv, "/closure", {
        keys: ["property_cell:sched_box:counter"],
        known: ["object_lineage:sched_box"]
      });
      return closure.cells[0]?.value;
    };

    // ---- The full CO16 path: schedule → alarm → outbox → planner runs
    // the normal turn machinery → the effect lands in scope authority.
    const dueAt = Date.now() + 30;
    const bumpTurn: ScheduledTurn = { id: "sched-e2e", at_logical_time: dueAt, call: { actor, target: "sched_box", verb: "bump", args: [] } };
    await call(roomDO, scopeEnv, "/schedule", { scope: roomScope, catalog_epoch: EPOCH, turn: bumpTurn });
    await sleep(60);
    rpcLog.length = 0;
    await roomDO.alarm();
    await roomState.settle();
    await gatewayState.settle();

    expect(rpcLog).toContain("gateway:sched-gw/net/plan-scheduled");
    expect(rpcLog).toContain(`scope:${roomScope}/net/submit`);
    expect(await counterAt()).toMatchObject({ value: 1 });
    expect(scheduledRows(roomState.state)).toEqual([]);
    expect(outboxRows(roomState.state)).toEqual([]);
    const headAfterFirst = (await call<{ head: { seq: number } }>(roomDO, scopeEnv, "/head")).head;

    // ---- Redelivery cannot double-commit: the same dispatch body (the
    // outbox redelivers it verbatim, so id AND at_logical_time — the
    // idempotency-key inputs — are identical) replans under the SAME
    // `sched:<id>:<at>` key, and the committing scope's reply cache
    // returns the recorded reply. The head does not advance and the
    // counter does not move.
    const redelivered = await call<{ reply: CommitReply }>(gateway, gatewayEnv, "/plan-scheduled", {
      scheduled_turn: bumpTurn,
      scope: roomScope,
      catalog_epoch: EPOCH
    });
    expect(redelivered.reply.status).toBe("accepted");
    expect(redelivered.reply.status === "accepted" && redelivered.reply.head.seq).toBe(headAfterFirst.seq);
    expect(await counterAt()).toMatchObject({ value: 1 });

    // ---- A COLD planner converges via pull-on-miss: a fresh gateway
    // (nothing pulled, no fanout history) receives a dispatch directly
    // and must pull the sending scope, the catalog closure, and the call
    // actor's cluster before planning — then commit normally.
    const coldState = netState("gateway-sched-cold");
    const coldGateway = new NetGatewayDO(coldState.state, gatewayEnv);
    gateways.set("cold-gw", coldGateway);
    rpcLog.length = 0;
    const coldTurn: ScheduledTurn = { id: "sched-cold", at_logical_time: dueAt + 1, call: { actor, target: "sched_box", verb: "bump", args: [] } };
    const cold = await call<{ reply: CommitReply; attempt: number }>(coldGateway, gatewayEnv, "/plan-scheduled", {
      scheduled_turn: coldTurn,
      scope: roomScope,
      catalog_epoch: EPOCH
    });
    expect(cold.reply.status, JSON.stringify(cold.reply)).toBe("accepted");
    expect(await counterAt()).toMatchObject({ value: 2 });
    // Pull-on-miss went to all three unseen scopes (live closure pulls).
    for (const scope of [roomScope, CATALOG_SCOPE, clusterScope]) {
      expect(rpcLog).toContain(`scope:${scope}/net/closure`);
    }

    for (const st of doStates.values()) st.close();
    gatewayState.close();
    coldState.close();
  });
});
