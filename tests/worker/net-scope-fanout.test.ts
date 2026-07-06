// NetScopeDO fanout + rider adoption (Plan 002 Phase 3 step 3;
// coherence.md CO2.5/CO2.7, CA3). Fake-DO lane, two scope DOs with REAL
// per-instance SQLite plus a gateway DO subscriber.
//
// Covered: an accepted room-writing turn with an actor rider enqueues
// durable outbox rows in the same transaction as the commit; the drain
// delivers /net/adopt to the rider's owning scope (cells installed as
// authoritative, idempotent by (from_scope, seq)) and /net/fanout to the
// registered subscriber (observations included, receiver no-ops replays
// by seq); a /net/fanout delivery fault (WOO_NET_FAULTS) leaves a
// pending row that a later drain — kicked by the next request on a
// fresh DO over the same storage — delivers.
import { describe, expect, it } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import type { NetStub } from "../../src/worker/net/workerd-host";
import { applyTranscript } from "../../src/net/transcript";
import { ScopeSequencer, type CommitReply, type CommitSubmit, type ScopeHead } from "../../src/net/scope";

const SECRET = "net-fanout-test-secret";
const EPOCH = "cat-net-fanout-1";
const ROOM_SCOPE = "room_w";
const CLUSTER_SCOPE = "cluster_c";

/** Fake DO state + alarm slice + waitUntil capture, so tests can await
 * the deferred outbox drains WorkerdHost hands to waitUntil. */
function netState(name: string) {
  const fake = new FakeDurableObjectState(name);
  const deferred: Array<Promise<unknown>> = [];
  const state: NetScopeDurableState & NetGatewayDurableState = {
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
    /** Await every captured deferred task (including ones queued while
     * settling — a drain may be re-kicked). */
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
  const decoded = (await response.json()) as T & { error?: unknown };
  if (!response.ok) throw new Error(`call ${route} failed: ${JSON.stringify(decoded)}`);
  return decoded;
}

/** Wrap a stub, recording every request body — the test's view of what
 * a destination actually received. */
function recordingStub(target: Fetchable): { stub: NetStub; calls: Array<{ path: string; body: unknown }> } {
  const calls: Array<{ path: string; body: unknown }> = [];
  return {
    calls,
    stub: {
      fetch: async (request: Request) => {
        const url = new URL(request.url);
        const body = request.method === "POST" ? await request.clone().json() : undefined;
        calls.push({ path: url.pathname, body });
        return target.fetch(request);
      }
    }
  };
}

const WRITER = { progr: "#actor", thisObj: "#room", verb: "greet", definer: "$thing", caller: "#actor", callerPerms: "#actor" };

/** The room scope's own cells: the room object and its counter. The
 * actor deliberately anchors elsewhere (cluster_c). */
function roomCells() {
  return [
    { kind: "object_lineage" as const, object: "#room", value: { parent: null, owner: "#actor", name: "room", anchor: null, flags: {} } },
    { kind: "property_cell" as const, object: "#room", name: "visits", value: { value: 0 } }
  ];
}

/** The cluster scope's cells: the actor and its rider property. */
function clusterCells() {
  return [
    { kind: "object_lineage" as const, object: "#actor", value: { parent: null, owner: "#actor", name: "actor", anchor: null, flags: {} } },
    { kind: "property_cell" as const, object: "#actor", name: "greeted", value: { value: 0 } }
  ];
}

/** Hand-built CA3 ride-along turn (the differential's scenario shape):
 * one room write + one actor-cell rider write + an observation. Reads
 * are empty so the fixture exercises delivery, not validation. */
function rideAlongSubmit(base: ScopeHead): CommitSubmit {
  const transcript = {
    kind: "woo.effect_transcript.shadow.v1",
    route: "sequenced",
    scope: ROOM_SCOPE,
    seq: 1,
    call: { actor: "#actor", target: "#room", verb: "greet", args: [], body: undefined },
    reads: [],
    writes: [
      { cell: { kind: "prop", object: "#room", name: "visits" }, value: 1, op: "set", writer: WRITER },
      { cell: { kind: "prop", object: "#actor", name: "greeted" }, value: 1, op: "set", writer: WRITER }
    ],
    creates: [],
    moves: [],
    observations: [{ type: "greeted", room: "#room", who: "#actor" }],
    logicalInputs: [],
    untrackedEffects: [],
    complete: true,
    incompleteReasons: [],
    hash: "net-fanout-t1"
  };
  // Planner-parity post-state via the same apply the scope runs.
  const twin = new ScopeSequencer(ROOM_SCOPE, EPOCH);
  twin.seed(roomCells());
  const derived = applyTranscript(twin.store, transcript as never, { scope_head: "x", catalog_epoch: EPOCH });
  return {
    kind: "woo.net.commit_submit.v1",
    scope: ROOM_SCOPE,
    base,
    idempotency_key: "fanout-turn-1",
    transcript: transcript as never,
    post_state_version: derived.postStateVersion,
    stamp: { scope_head: "x", catalog_epoch: EPOCH }
  };
}

function outboxRows(state: NetScopeDurableState): Array<{ route: string; status: string; attempts: number }> {
  return (
    state.storage.sql.exec("SELECT route, status, attempts FROM net_scope_outbox") as { toArray(): Array<{ route: string; status: string; attempts: number }> }
  ).toArray();
}

describe("NetScopeDO fanout + rider adoption over fake-DO", () => {
  it("delivers rider cells via /net/adopt and observations via /net/fanout; replays no-op", async () => {
    const scopeEnvBase = { WOO_INTERNAL_SECRET: SECRET };

    // Rider owner: the cluster scope holding the actor's cells.
    const cluster = netState(`scope-${CLUSTER_SCOPE}`);
    const clusterDO = new NetScopeDO(cluster.state, scopeEnvBase);
    await call(clusterDO, scopeEnvBase, "/seed", { scope: CLUSTER_SCOPE, catalog_epoch: EPOCH, cells: clusterCells() });

    // Subscriber: a gateway shard registered on the room scope.
    const gatewayState = netState("gateway-fanout-1");
    const gatewayEnv: NetGatewayEnv = { WOO_INTERNAL_SECRET: SECRET };
    const gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);
    const gatewayRecorder = recordingStub(gateway);
    const clusterRecorder = recordingStub(clusterDO);

    // The committing room scope, wired to reach both destinations.
    const room = netState(`scope-${ROOM_SCOPE}`);
    const roomEnv: NetScopeEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        if (destination === `scope:${CLUSTER_SCOPE}`) return clusterRecorder.stub;
        if (destination === "gateway:g1") return gatewayRecorder.stub;
        throw new Error(`unexpected destination ${destination}`);
      }
    };
    const roomDO = new NetScopeDO(room.state, roomEnv);
    await call(roomDO, roomEnv, "/seed", { scope: ROOM_SCOPE, catalog_epoch: EPOCH, cells: roomCells() });
    await call(roomDO, roomEnv, "/subscribe", { destination: "gateway:g1" });

    const head0 = (await call<{ head: ScopeHead }>(roomDO, roomEnv, "/head")).head;
    const submit = rideAlongSubmit(head0);
    const reply = await call<CommitReply>(roomDO, roomEnv, "/submit", {
      submit,
      rider_destinations: { [CLUSTER_SCOPE]: { destination: `scope:${CLUSTER_SCOPE}`, objects: ["#actor"] } }
    });
    expect(reply.status).toBe("accepted");
    await room.settle();

    // Rider adoption: the cluster authority now holds the ride-along
    // write, adopted from the room's commit (CA3).
    const adopted = await call<{ cells: Array<{ key: string; value: unknown; provenance: string }> }>(
      clusterDO,
      scopeEnvBase,
      "/closure",
      { keys: ["property_cell:#actor:greeted"], known: ["object_lineage:#actor"] }
    );
    expect(adopted.cells[0]?.value).toEqual({ value: 1 });
    expect(adopted.cells[0]?.provenance).toBe("authoritative");
    const adoptCalls = clusterRecorder.calls.filter((c) => c.path === "/net/adopt");
    expect(adoptCalls).toHaveLength(1);
    const adoptBody = adoptCalls[0].body as { from_scope: string; seq: number; cells: Array<{ key: string }> };
    expect(adoptBody.from_scope).toBe(ROOM_SCOPE);
    expect(adoptBody.seq).toBe(1);
    // Only the rider's cells ride — the room's own write stays home.
    expect(adoptBody.cells.map((c) => c.key)).toEqual(["property_cell:#actor:greeted"]);

    // Subscriber fanout carried the observations and the room's cells.
    const fanoutCalls = gatewayRecorder.calls.filter((c) => c.path === "/net/fanout");
    expect(fanoutCalls).toHaveLength(1);
    const fanBody = fanoutCalls[0].body as { scope: string; seq: number; cells: Array<{ key: string }>; observations: unknown[] };
    expect(fanBody.scope).toBe(ROOM_SCOPE);
    expect(fanBody.seq).toBe(1);
    expect(fanBody.observations).toEqual([{ type: "greeted", room: "#room", who: "#actor" }]);
    expect(fanBody.cells.map((c) => c.key)).toContain("property_cell:#room:visits");

    // Delivered rows are gone; nothing is pending.
    expect(outboxRows(room.state)).toEqual([]);

    // Redelivery no-ops: the adopt high-water and the fanout seq gate
    // both refuse the replayed body (CO2.5 at the receiver).
    const replayAdopt = await call<{ applied: boolean }>(clusterDO, scopeEnvBase, "/adopt", adoptBody);
    expect(replayAdopt.applied).toBe(false);
    const replayFan = await call<{ applied: boolean }>(gateway, gatewayEnv, "/fanout", fanBody);
    expect(replayFan.applied).toBe(false);

    // An idempotent resubmit returns the recorded reply and enqueues
    // nothing new (the head did not advance).
    const resubmit = await call<CommitReply>(roomDO, roomEnv, "/submit", {
      submit,
      rider_destinations: { [CLUSTER_SCOPE]: { destination: `scope:${CLUSTER_SCOPE}`, objects: ["#actor"] } }
    });
    expect(resubmit).toEqual(reply);
    await room.settle();
    expect(outboxRows(room.state)).toEqual([]);
    expect(clusterRecorder.calls.filter((c) => c.path === "/net/adopt")).toHaveLength(1);
    expect(gatewayRecorder.calls.filter((c) => c.path === "/net/fanout")).toHaveLength(1);

    room.close();
    cluster.close();
    gatewayState.close();
  });

  it("a faulted /net/fanout leaves a pending row that the next drain delivers (drain-on-reactivation)", async () => {
    const gatewayState = netState("gateway-fanout-2");
    const gatewayEnv: NetGatewayEnv = { WOO_INTERNAL_SECRET: SECRET };
    const gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);
    const recorder = recordingStub(gateway);
    const resolve = (destination: string) => {
      if (destination === "gateway:g1") return recorder.stub;
      throw new Error(`unexpected destination ${destination}`);
    };

    // The room's fanout lane is down: delivery fails, the row stays.
    const room = netState(`scope-${ROOM_SCOPE}-faulted`);
    const faultedEnv: NetScopeEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      WOO_NET_FAULTS: JSON.stringify({ "/fanout": { error: "fanout lane down" } }),
      NET_RESOLVE: resolve
    };
    const faultedDO = new NetScopeDO(room.state, faultedEnv);
    await call(faultedDO, faultedEnv, "/seed", { scope: ROOM_SCOPE, catalog_epoch: EPOCH, cells: roomCells() });
    await call(faultedDO, faultedEnv, "/subscribe", { destination: "gateway:g1" });
    const head0 = (await call<{ head: ScopeHead }>(faultedDO, faultedEnv, "/head")).head;

    const reply = await call<CommitReply>(faultedDO, faultedEnv, "/submit", rideAlongSubmit(head0));
    expect(reply.status).toBe("accepted");
    await room.settle();

    // The commit stands; the delivery is pending with one failed attempt
    // (at-least-once: the row survives, nothing was lost or abandoned).
    expect(recorder.calls.filter((c) => c.path === "/net/fanout")).toHaveLength(0);
    expect(outboxRows(room.state)).toEqual([{ route: "/fanout", status: "pending", attempts: 1 }]);

    // "Reactivation": a fresh DO over the SAME storage, fault gone. The
    // first request kicks the deferred drain; the row is past its
    // backoff window (attempt 1 → 250 ms) and delivers.
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 300));
    const healthyEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve };
    const healthyDO = new NetScopeDO(room.state, healthyEnv);
    await call(healthyDO, healthyEnv, "/head");
    await room.settle();

    const delivered = recorder.calls.filter((c) => c.path === "/net/fanout");
    expect(delivered).toHaveLength(1);
    expect((delivered[0].body as { seq: number }).seq).toBe(1);
    expect(outboxRows(room.state)).toEqual([]);

    room.close();
    gatewayState.close();
  });
});
