// D2 / CO10 warm-turn structural budget gate (CO12.3 "budget gates").
//
// A genuinely WARM SAME-SCOPE turn: one scope holds the whole fixture and
// the turn carries a `shared:[scope]` classifier override, so every read
// and write classifies to that one scope — no foreign attestation, no
// rider, no cross-scope hop. CO10's warm-turn structure then bounds it:
//   1 attempt, ≤ 3 cross-host RPCs on the synchronous reply path
//   (/head + /submit + the post-accept installTouched /closure),
//   0 authority reconstructions.
//
// The gate reads TurnResult.structure (the counters the gateway now emits
// as the `net_turn_structure` metric) AND cross-checks the sync-RPC count
// against a per-destination RPC log, so a miscount in either the counter
// or the plumbing fails the test. This file is in the curated `npm test`
// list (a CO12 gate that only ran under test:full would not hold the line).
import { describe, expect, it } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { WorkerdHost } from "../../src/worker/net/workerd-host";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { installVerb } from "../../src/core/authoring";
import { createWorld } from "../../src/core/bootstrap";
import { cellsFromSerialized, type ShadowTurnCall } from "../../src/net/bridge";
import type { AttemptTraceEntry } from "../../src/net/errors";
import type { CommitReply } from "../../src/net/scope";

const SECRET = "net-turn-structure-secret";
const EPOCH = "cat-net-structure-1";
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

type TurnStructureReport = {
  scope: string;
  attempt: number;
  envelope_bytes: number;
  sync_rpc: number;
  rpc_ms: number;
  rpc_max_ms: number;
  rpc_depth: number;
  queue_ms: number;
  wall_ms: number;
  scope_row_writes: number;
  reconstructions: number;
};
type TurnBody = {
  reply: CommitReply;
  attempt: number;
  trace: AttemptTraceEntry[];
  structure?: TurnStructureReport;
};

describe("D2 / CO10 warm-turn structural budget", () => {
  it("a warm same-scope accepted turn stays within the CO10 structure (1 attempt, ≤3 sync RPC, 0 reconstructions)", async () => {
    const analytics: Array<{ indexes?: string[]; blobs?: string[]; doubles?: number[] }> = [];
    const metrics = { writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }) { analytics.push(point); } };
    // ---- Engine-real fixture: a room, a room-anchored box whose bump
    // verb writes ONLY the box (no actor rider → no cross-scope write),
    // and the actor placed in the room. The whole world is then flattened
    // into ONE scope, so the shared-override turn touches a single scope.
    const world = createWorld();
    const session = world.auth("guest:net-structure");
    const actor = session.actor;
    world.createObject({ id: "strn_room", name: "Structure Room", parent: "$space", owner: actor });
    world.createObject({ id: "strn_box", name: "Structure Box", parent: "$thing", owner: actor, anchor: "strn_room", location: "strn_room" });
    world.defineProperty("strn_box", { name: "counter", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
    const installed = installVerb(
      world,
      "strn_box",
      "bump",
      `verb :bump() rxd {
        this.counter = this.counter + 1;
        observe({ type: "bumped", counter: this.counter });
        return this.counter;
      }`,
      null
    );
    expect(installed.ok).toBe(true);
    const placed = await world.directCall("strn-genesis-place", actor, actor, "moveto", ["strn_room"], { sessionId: session.id });
    expect(placed.op).toBe("result");

    // ---- Flatten: seed EVERY cell into the single scope DO. The
    // `shared:[SCOPE]` override on the turn (below) classifies every
    // object to SCOPE regardless of its natural anchor, so there is no
    // foreign read to attest — exactly the warm same-scope case CO10
    // bounds. Real per-instance SQLite (fake-DO), signed /net surface.
    const cells = cellsFromSerialized(world.exportWorld());
    const scopeState = netState("scope-flat");
    const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, METRICS: metrics };
    const scopeDO = new NetScopeDO(scopeState.state, scopeEnv);
    await call(scopeDO, scopeEnv, "/seed", { scope: SCOPE, catalog_epoch: EPOCH, cells });

    // The gateway records every RPC pathname per destination, so the
    // sync-RPC counter can be cross-checked against the real plumbing.
    const rpcLog: string[] = [];
    const gatewayState = netState("gateway-structure");
    const gatewayEnv: NetGatewayEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      METRICS: metrics,
      NET_RESOLVE: (destination) => {
        if (destination !== `scope:${SCOPE}`) throw new Error(`unexpected destination ${destination}`);
        return {
          fetch: (request: Request) => {
            rpcLog.push(new URL(request.url).pathname);
            return scopeDO.fetch(request);
          }
        };
      }
    };
    const gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);
    await call(gateway, gatewayEnv, "/pull", { scope: SCOPE, destination: `scope:${SCOPE}` });

    const bump = (id: string): ShadowTurnCall => ({
      kind: "woo.turn_call.shadow.v1",
      id,
      route: "direct",
      scope: SCOPE,
      actor,
      target: "strn_box",
      verb: "bump",
      args: []
    });
    const turnRequest = (key: string) => ({
      call: bump(key),
      planningScope: SCOPE,
      catalog_epoch: EPOCH,
      idempotency_key: key,
      // Single-scope classifier override (lane form): every object → SCOPE.
      shared: [SCOPE],
      scopes: { [SCOPE]: `scope:${SCOPE}` }
    });

    // First turn warms install-on-accept; the second is the gate target.
    const turn1 = await call<TurnBody>(gateway, gatewayEnv, "/turn", turnRequest("strn-t1"));
    expect(turn1.reply.status, JSON.stringify(turn1.reply)).toBe("accepted");

    rpcLog.length = 0;
    const turn2 = await call<TurnBody>(gateway, gatewayEnv, "/turn", turnRequest("strn-t2"));
    expect(turn2.reply.status, JSON.stringify(turn2.reply)).toBe("accepted");

    // ---- The CO10 warm-turn structural gate.
    const structure = turn2.structure;
    expect(structure, "TurnResult must carry the D2 structure report").toBeTruthy();
    expect(structure?.attempt).toBe(1); // no repair round
    expect(structure?.reconstructions).toBe(0); // warm view: no refresh/reseed
    expect(structure?.sync_rpc).toBeLessThanOrEqual(3); // /head + /submit + installTouched
    expect(structure?.scope_row_writes).toBeGreaterThan(0); // the counter cell moved
    expect(structure?.scope).toBe(SCOPE);

    // Cross-check the counter against the real plumbing: the only RPCs on
    // the reply path are the head, the submit, and the warm cache-fill
    // closure — all to the single scope, none of them a foreign attest.
    expect(rpcLog).toEqual(["/net/head", "/net/submit", "/net/closure"]);
    expect(structure?.sync_rpc).toBe(rpcLog.length);

    // NC8a: the timing/depth series ride the same report. Every warm RPC
    // is a serial step, so depth == count here; wall covers the RPC time.
    expect(structure?.rpc_depth).toBe(structure?.sync_rpc);
    expect(structure?.rpc_ms).toBeGreaterThanOrEqual(0);
    expect(structure?.rpc_max_ms).toBeLessThanOrEqual(structure?.rpc_ms ?? 0);
    expect(structure?.wall_ms).toBeGreaterThanOrEqual(structure?.rpc_ms ?? 0);

    // The deployed canary reads AE, not sampled tail. Prove both DO shells
    // wrote their readiness events under stable per-instance indexes.
    const turnPoint = analytics.filter((point) => point.blobs?.[0] === "net_turn_structure").at(-1);
    const submitPoint = analytics.find((point) => point.blobs?.[0] === "net_scope_submit");
    expect(turnPoint?.indexes).toEqual(["net-gateway:gateway-structure"]);
    expect(turnPoint?.blobs?.[7]).toBe("accepted");
    expect(turnPoint?.doubles?.[4]).toBe(structure?.wall_ms);
    expect(submitPoint?.indexes).toEqual(["net-scope:scope-flat"]);

    scopeState.close();
    gatewayState.close();
  });
});

describe("NC8b: the per-turn RPC budget and parallel-group mechanics (TurnStructure)", () => {
  it("refuses past the RPC cap with a named E_BUDGET; mandatory steps bypass", async () => {
    const { TurnStructure } = await import("../../src/worker/net/gateway-do");
    const structure = new TurnStructure();
    for (let i = 0; i < 32; i += 1) {
      await structure.rpc(async () => i);
    }
    expect(structure.sync_rpc).toBe(32);
    // The 33rd is refused BEFORE issuing (the action must not run)...
    let ran = false;
    await expect(
      structure.rpc(async () => {
        ran = true;
      })
    ).rejects.toMatchObject({ code: "E_BUDGET" });
    expect(ran).toBe(false);
    // ...but a MANDATORY step (the CO2.5 disambiguation resubmit, the
    // post-accept warm fill) still runs at the budget's edge.
    await structure.rpc(async () => {
      ran = true;
    }, { mandatory: true });
    expect(ran).toBe(true);
  });

  it("a parallel group is one depth step, K RPCs, and rejects only after all settle", async () => {
    const { TurnStructure } = await import("../../src/worker/net/gateway-do");
    const structure = new TurnStructure();
    const settled: string[] = [];
    const results = await structure.rpcGroup([
      async () => {
        settled.push("a");
        return "a";
      },
      async () => {
        settled.push("b");
        return "b";
      },
      async () => {
        settled.push("c");
        return "c";
      }
    ]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(structure.sync_rpc).toBe(3); // all K counted
    expect(structure.rpc_depth).toBe(1); // ONE critical-path step

    // A failing member surfaces, but only after the others finished —
    // no orphaned in-flight write behind a thrown group.
    await expect(
      structure.rpcGroup([
        async () => {
          settled.push("late");
          return "late";
        },
        async () => {
          throw new Error("boom");
        }
      ])
    ).rejects.toThrow("boom");
    expect(settled).toContain("late");
    expect(structure.rpc_depth).toBe(2);
    expect(structure.sync_rpc).toBe(5);
  });

  it("a group that would cross the cap refuses whole (no partial fan-out)", async () => {
    const { TurnStructure } = await import("../../src/worker/net/gateway-do");
    const structure = new TurnStructure();
    for (let i = 0; i < 30; i += 1) await structure.rpc(async () => i);
    let issued = 0;
    await expect(
      structure.rpcGroup([async () => (issued += 1), async () => (issued += 1), async () => (issued += 1)])
    ).rejects.toMatchObject({ code: "E_BUDGET" });
    expect(issued).toBe(0);
    expect(structure.sync_rpc).toBe(30);
  });
});

describe("NC8 queue wait deadline", () => {
  it("runs twelve independent lanes per scope by default and queues the thirteenth", async () => {
    const gatewayState = netState("gateway-queue-lanes");
    const gateway = new NetGatewayDO(gatewayState.state, { WOO_INTERNAL_SECRET: SECRET });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let executions = 0;
    const internals = gateway as unknown as {
      turn(request: { planningScope: string }): Promise<unknown>;
      turnUnqueued(request: { planningScope: string }, queueMs: number): Promise<unknown>;
    };
    internals.turnUnqueued = async () => {
      executions += 1;
      if (executions <= 12) await gate;
      return { ok: true };
    };

    const request = { planningScope: "room:hot" };
    const turns = Array.from({ length: 13 }, () => internals.turn(request));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(executions).toBe(12);
    release();
    await Promise.all(turns);
    expect(executions).toBe(13);
    gatewayState.close();
  });

  it("refuses a queued turn on time and skips it when the predecessor releases", async () => {
    const gatewayState = netState("gateway-queue-deadline");
    const gateway = new NetGatewayDO(gatewayState.state, {
      WOO_INTERNAL_SECRET: SECRET,
      NET_TURN_QUEUE_WAIT_MS: "20",
      NET_TURN_SCOPE_CONCURRENCY: "1"
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let executions = 0;
    const internals = gateway as unknown as {
      turn(request: { planningScope: string }): Promise<unknown>;
      turnUnqueued(request: { planningScope: string }, queueMs: number): Promise<unknown>;
    };
    // Isolate the serializer from planning: the first execution parks;
    // the second must time out in the queue and never call turnUnqueued.
    internals.turnUnqueued = async () => {
      executions += 1;
      if (executions === 1) await firstGate;
      return { ok: true };
    };

    const request = { planningScope: "room:hot" };
    const first = internals.turn(request);
    await Promise.resolve();
    const started = Date.now();
    await expect(internals.turn(request)).rejects.toMatchObject({
      code: "E_BUDGET",
      detail: { reason: "queue_wait", limit_ms: 20 }
    });
    expect(Date.now() - started).toBeLessThan(500);
    releaseFirst();
    await first;
    await Promise.resolve();
    expect(executions).toBe(1);
    gatewayState.close();
  });
});

describe("net RPC deadline", () => {
  it("aborts a hanging cross-DO fetch and surfaces E_RPC_TIMEOUT", async () => {
    let signal: AbortSignal | undefined;
    const host = new WorkerdHost({
      env: { WOO_INTERNAL_SECRET: SECRET, NET_RPC_TIMEOUT_MS: "20" },
      resolve: () => ({
        fetch: (request) => {
          signal = request.signal;
          return new Promise<Response>(() => {});
        }
      })
    });

    const started = Date.now();
    await expect(host.rpc("scope:wedged", "/head")).rejects.toMatchObject({
      code: "E_RPC_TIMEOUT",
      detail: { destination: "scope:wedged", route: "/head", timeout_ms: 20 }
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(signal?.aborted).toBe(true);
  });

  it("uses the same deadline for a deterministic pre-call timeout fault", async () => {
    let called = false;
    const host = new WorkerdHost({
      env: {
        WOO_INTERNAL_SECRET: SECRET,
        NET_RPC_TIMEOUT_MS: "20",
        WOO_NET_FAULTS: JSON.stringify({ "/submit": { timeout: true } })
      },
      resolve: () => ({
        fetch: () => {
          called = true;
          return new Response("{}");
        }
      })
    });

    await expect(host.rpc("scope:wedged", "/submit", {})).rejects.toMatchObject({ code: "E_RPC_TIMEOUT" });
    expect(called).toBe(false);
  });
});
