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
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { cellVersion } from "../../src/net/cells";
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

/** Fake DO state + alarm slice + waitUntil capture. Submit fanout starts
 * only when a test invokes DO.alarm(); nested drains then ride waitUntil.
 * Armings are recorded (null = deleteAlarm) for retry assertions. */
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
    route: "direct",
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
    expect(clusterRecorder.calls).toHaveLength(0);
    expect(gatewayRecorder.calls).toHaveLength(0);
    await roomDO.alarm();
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
    const fanBody = fanoutCalls[0].body as { scope: string; seq: number; delivery_seq: number; cells: Array<{ key: string }>; observations: unknown[] };
    expect(fanBody.scope).toBe(ROOM_SCOPE);
    expect(fanBody.seq).toBe(1);
    expect(fanBody.delivery_seq).toBe(1);
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
    expect(resubmit).toEqual({ ...reply, replayed: true });
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
    await faultedDO.alarm();
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

// ---- Outbox liveness (Phase-3 hardening fix 4) ----------------------------
describe("outbox liveness (fix 4)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a quiet scope retries a failed delivery via the alarm (fix 4a): no further requests needed", async () => {
    const gatewayState = netState("gateway-quiet-1");
    const gatewayEnv: NetGatewayEnv = { WOO_INTERNAL_SECRET: SECRET };
    const gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);
    const recorder = recordingStub(gateway);
    const resolve = (destination: string) => {
      if (destination === "gateway:g1") return recorder.stub;
      throw new Error(`unexpected destination ${destination}`);
    };

    // Faulted fanout lane: the delivery fails, the row stays pending.
    const room = netState(`scope-${ROOM_SCOPE}-quiet`);
    const faultedEnv: NetScopeEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      WOO_NET_FAULTS: JSON.stringify({ "/fanout": { error: "fanout lane down" } }),
      NET_RESOLVE: resolve
    };
    const faultedDO = new NetScopeDO(room.state, faultedEnv);
    await call(faultedDO, faultedEnv, "/seed", { scope: ROOM_SCOPE, catalog_epoch: EPOCH, cells: roomCells() });
    await call(faultedDO, faultedEnv, "/subscribe", { destination: "gateway:g1" });
    const head0 = (await call<{ head: ScopeHead }>(faultedDO, faultedEnv, "/head")).head;
    expect((await call<CommitReply>(faultedDO, faultedEnv, "/submit", rideAlongSubmit(head0))).status).toBe("accepted");
    await faultedDO.alarm();
    await room.settle();

    // The failed drain armed the DO alarm for the retry window — the
    // quiet-scope liveness guarantee (no request will ever re-kick it).
    expect(outboxRows(room.state)).toEqual([{ route: "/fanout", status: "pending", attempts: 1 }]);
    const armed = room.alarms.filter((at): at is number => at !== null);
    expect(armed.length).toBeGreaterThanOrEqual(1);
    expect(armed[armed.length - 1]).toBeGreaterThan(0);

    // "Eviction + alarm fire": a fresh DO over the same storage, fault
    // gone, and ONLY the alarm handler runs — no fetch traffic at all.
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 300));
    const healthyEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve };
    const healthyDO = new NetScopeDO(room.state, healthyEnv);
    await healthyDO.alarm();
    await room.settle();

    const delivered = recorder.calls.filter((c) => c.path === "/net/fanout");
    expect(delivered).toHaveLength(1);
    expect(outboxRows(room.state)).toEqual([]);

    room.close();
    gatewayState.close();
  });

  it("detects subscriber-lane loss without treating sparse authority heads as gaps", async () => {
    const metricLines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      metricLines.push(args.map(String).join(" "));
    });
    const gaps = () => metricLines.filter((line) => line.includes("net_fanout_gap"));

    const gatewayState = netState("gateway-gap-1");
    const gatewayEnv: NetGatewayEnv = { WOO_INTERNAL_SECRET: SECRET };
    const gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);

    const bodyAt = (seq: number, delivery_seq?: number) => ({
      scope: ROOM_SCOPE,
      seq,
      ...(delivery_seq === undefined ? {} : { delivery_seq }),
      cells: [],
      observations: []
    });
    // Authority heads can skip while subscriber deliveries remain
    // contiguous. This is not loss.
    expect((await call<{ applied: boolean }>(gateway, gatewayEnv, "/fanout", bodyAt(3, 1))).applied).toBe(true);
    expect(gaps()).toHaveLength(0);
    expect((await call<{ applied: boolean }>(gateway, gatewayEnv, "/fanout", bodyAt(7, 3))).applied).toBe(true);
    expect(gaps()).toHaveLength(1);
    expect(gaps()[0]).toContain('"expected":2');
    expect(gaps()[0]).toContain('"got":3');
    // A late lost row no-ops below both high-waters and adds no new gap.
    expect((await call<{ applied: boolean }>(gateway, gatewayEnv, "/fanout", bodyAt(6, 2))).applied).toBe(false);
    expect(gaps()).toHaveLength(1);

    // Both high-waters survive eviction. A fresh gateway continues at
    // delivery 4 instead of reporting a phantom gap after reconstruction.
    const reconstructed = new NetGatewayDO(gatewayState.state, gatewayEnv);
    expect((await call<{ applied: boolean }>(reconstructed, gatewayEnv, "/fanout", bodyAt(9, 4))).applied).toBe(true);
    expect(gaps()).toHaveLength(1);

    // Legacy pending rows carry no delivery position and remain accepted
    // during a rolling deploy without reviving authority-seq false alarms.
    expect((await call<{ applied: boolean }>(reconstructed, gatewayEnv, "/fanout", bodyAt(20))).applied).toBe(true);
    expect(gaps()).toHaveLength(1);

    gatewayState.close();
  });
});

// ---- Rider-read integrity interim guard (Phase-3 hardening fix 1) --------
// notes/2026-07-06-rider-read-integrity.md: adoption CASes each cell
// against the prior version the committing turn observed; a mismatch is
// owner-wins + net_adopt_conflict (named divergence), never a silent
// lost update. The committing scope's residue copies re-stamp derived.
describe("rider adoption prior-version CAS (fix 1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Ride-along transcript builder: read greeted at `readVersion` (the
   * version the plan observed through the gateway view), write visits +
   * greeted. Planner-parity post-state from a twin seeded like the room.
   * The submit carries the CO2.3 owner attestation at the same version —
   * the gateway attests at plan time, so plan-observed and attested
   * versions agree unless the owner moved BETWEEN view install and
   * attest (the read_version_mismatch repair case, covered in
   * tests/net/scope.test.ts). */
  function rideAlongReading(base: ScopeHead, key: string, hash: string, readVersion: string, visits: number, greeted: number): CommitSubmit {
    const transcript = {
      kind: "woo.effect_transcript.shadow.v1",
      route: "direct",
      scope: ROOM_SCOPE,
      seq: base.seq + 1,
      call: { actor: "#actor", target: "#room", verb: "greet", args: [], body: undefined },
      reads: [{ cell: { kind: "prop", object: "#actor", name: "greeted" }, version: readVersion, value: greeted - 1 }],
      writes: [
        { cell: { kind: "prop", object: "#room", name: "visits" }, value: visits, op: "set", writer: WRITER },
        { cell: { kind: "prop", object: "#actor", name: "greeted" }, value: greeted, op: "set", writer: WRITER }
      ],
      creates: [],
      moves: [],
      observations: [],
      logicalInputs: [],
      untrackedEffects: [],
      complete: true,
      incompleteReasons: [],
      hash
    };
    const twin = new ScopeSequencer(ROOM_SCOPE, EPOCH);
    twin.seed(roomCells());
    const derived = applyTranscript(twin.store, transcript as never, { scope_head: "x", catalog_epoch: EPOCH });
    return {
      kind: "woo.net.commit_submit.v1",
      scope: ROOM_SCOPE,
      base,
      idempotency_key: key,
      transcript: transcript as never,
      post_state_version: derived.postStateVersion,
      stamp: { scope_head: "x", catalog_epoch: EPOCH },
      attestations: {
        [CLUSTER_SCOPE]: {
          // Fixture head: validation compares attested cell versions,
          // not the owner head (provenance/diagnostics only).
          owner_head: { seq: 0, hash: "fixture-owner-head" },
          cells: [{ key: "property_cell:#actor:greeted", version: readVersion }]
        }
      }
    };
  }

  /** Direct owner-ordered write at the cluster (the owner "advancing"
   * between the shared scope's plan and its adopt delivery). */
  function clusterAdvanceSubmit(base: ScopeHead, greeted: number): CommitSubmit {
    const transcript = {
      kind: "woo.effect_transcript.shadow.v1",
      route: "direct",
      scope: CLUSTER_SCOPE,
      seq: base.seq + 1,
      call: { actor: "#actor", target: "#actor", verb: "stamp", args: [], body: undefined },
      reads: [],
      writes: [{ cell: { kind: "prop", object: "#actor", name: "greeted" }, value: greeted, op: "set", writer: WRITER }],
      creates: [],
      moves: [],
      observations: [],
      logicalInputs: [],
      untrackedEffects: [],
      complete: true,
      incompleteReasons: [],
      hash: `cluster-advance-${greeted}`
    };
    const twin = new ScopeSequencer(CLUSTER_SCOPE, EPOCH);
    twin.seed(clusterCells());
    const derived = applyTranscript(twin.store, transcript as never, { scope_head: "x", catalog_epoch: EPOCH });
    return {
      kind: "woo.net.commit_submit.v1",
      scope: CLUSTER_SCOPE,
      base,
      idempotency_key: `cluster-advance-${greeted}`,
      transcript: transcript as never,
      post_state_version: derived.postStateVersion,
      stamp: { scope_head: "x", catalog_epoch: EPOCH }
    };
  }

  it("owner-unmoved adopts cleanly; an owner advance between plan and adopt survives with one net_adopt_conflict", async () => {
    const metricLines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      metricLines.push(args.map(String).join(" "));
    });
    const conflicts = () => metricLines.filter((line) => line.includes("net_adopt_conflict")).length;

    const scopeEnvBase = { WOO_INTERNAL_SECRET: SECRET };
    const cluster = netState(`scope-${CLUSTER_SCOPE}-cas`);
    const clusterDO = new NetScopeDO(cluster.state, scopeEnvBase);
    await call(clusterDO, scopeEnvBase, "/seed", { scope: CLUSTER_SCOPE, catalog_epoch: EPOCH, cells: clusterCells() });

    const room = netState(`scope-${ROOM_SCOPE}-cas`);
    const roomEnv: NetScopeEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        if (destination === `scope:${CLUSTER_SCOPE}`) return clusterDO;
        throw new Error(`unexpected destination ${destination}`);
      }
    };
    const roomDO = new NetScopeDO(room.state, roomEnv);
    await call(roomDO, roomEnv, "/seed", { scope: ROOM_SCOPE, catalog_epoch: EPOCH, cells: roomCells() });
    const riders = { [CLUSTER_SCOPE]: { destination: `scope:${CLUSTER_SCOPE}`, objects: ["#actor"] } };

    const greetedAt = async (): Promise<{ value: unknown; version: string }> => {
      const closure = await call<{ cells: Array<{ value: unknown; version: string }> }>(clusterDO, scopeEnvBase, "/closure", {
        keys: ["property_cell:#actor:greeted"],
        known: ["object_lineage:#actor"]
      });
      return closure.cells[0];
    };

    // ---- Happy path: the plan reads greeted at the owner's live version
    // (versions are value content addresses; the seeded value is {value:0}).
    const head0 = (await call<{ head: ScopeHead }>(roomDO, roomEnv, "/head")).head;
    const happy = rideAlongReading(head0, "cas-happy", "cas-t1", cellVersion({ value: 0 }), 1, 1);
    expect((await call<CommitReply>(roomDO, roomEnv, "/submit", { submit: happy, rider_destinations: riders })).status).toBe("accepted");
    await roomDO.alarm();
    await room.settle();
    expect((await greetedAt()).value).toEqual({ value: 1 }); // adopted cleanly
    expect(conflicts()).toBe(0);

    // ---- Negative path (the external reviewer's scenario): the plan reads
    // greeted at {value:1}; the OWNER then advances the cell directly
    // (owner-ordered write → {value:42}) before the shared scope's commit
    // is adopted. The owner's newer value must SURVIVE, with exactly one
    // named net_adopt_conflict — never a silent clobber.
    const stale = rideAlongReading(
      (await call<{ head: ScopeHead }>(roomDO, roomEnv, "/head")).head,
      "cas-stale",
      "cas-t2",
      cellVersion({ value: 1 }), // what the plan observed
      2,
      2
    );
    const clusterHead = (await call<{ head: ScopeHead }>(clusterDO, scopeEnvBase, "/head")).head;
    expect((await call<CommitReply>(clusterDO, scopeEnvBase, "/submit", clusterAdvanceSubmit(clusterHead, 42))).status).toBe("accepted");

    expect((await call<CommitReply>(roomDO, roomEnv, "/submit", { submit: stale, rider_destinations: riders })).status).toBe("accepted");
    await roomDO.alarm();
    await room.settle();

    const after = await greetedAt();
    expect(after.value).toEqual({ value: 42 }); // owner-wins: newer value survived
    expect(conflicts()).toBe(1); // exactly one named divergence

    // Redelivery of the processed adoption no-ops (high-water advanced
    // even though the cell conflicted) — the verdict cannot flap.
    const replay = await call<{ applied: boolean }>(clusterDO, scopeEnvBase, "/adopt", {
      from_scope: ROOM_SCOPE,
      seq: 2,
      cells: [],
      prior_versions: {}
    });
    expect(replay.applied).toBe(false);
    expect(conflicts()).toBe(1);

    room.close();
    cluster.close();
  });

  it("re-stamps the committing scope's rider residue derived in closures (no dual authority)", async () => {
    const scopeEnvBase = { WOO_INTERNAL_SECRET: SECRET };
    const cluster = netState(`scope-${CLUSTER_SCOPE}-residue`);
    const clusterDO = new NetScopeDO(cluster.state, scopeEnvBase);
    await call(clusterDO, scopeEnvBase, "/seed", { scope: CLUSTER_SCOPE, catalog_epoch: EPOCH, cells: clusterCells() });

    const room = netState(`scope-${ROOM_SCOPE}-residue`);
    const roomEnv: NetScopeEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: () => clusterDO
    };
    const roomDO = new NetScopeDO(room.state, roomEnv);
    await call(roomDO, roomEnv, "/seed", { scope: ROOM_SCOPE, catalog_epoch: EPOCH, cells: roomCells() });

    const head0 = (await call<{ head: ScopeHead }>(roomDO, roomEnv, "/head")).head;
    const submit = rideAlongReading(head0, "residue-1", "residue-t1", cellVersion({ value: 0 }), 1, 1);
    expect(
      (
        await call<CommitReply>(roomDO, roomEnv, "/submit", {
          submit,
          rider_destinations: { [CLUSTER_SCOPE]: { destination: `scope:${CLUSTER_SCOPE}`, objects: ["#actor"] } }
        })
      ).status
    ).toBe("accepted");
    await roomDO.alarm();
    await room.settle();

    // A full "*" closure from the committing scope must not crash on the
    // rider cell's missing lineage (declared receiver-known), and must
    // ship the rider residue DERIVED while the scope's own cells stay
    // authoritative — the owner is the only authoritative copy now.
    const full = await call<{ cells: Array<{ key: string; provenance: string }>; assumes_known: string[] }>(
      roomDO,
      roomEnv,
      "/closure",
      { keys: ["*"], known: [] }
    );
    const byKey = new Map(full.cells.map((cell) => [cell.key, cell.provenance]));
    expect(byKey.get("property_cell:#actor:greeted")).toBe("derived");
    expect(byKey.get("property_cell:#room:visits")).toBe("authoritative");
    expect(full.assumes_known).toContain("object_lineage:#actor");

    // The owner's own copy stays authoritative in ITS closures.
    const owned = await call<{ cells: Array<{ key: string; provenance: string }> }>(clusterDO, scopeEnvBase, "/closure", {
      keys: ["property_cell:#actor:greeted"],
      known: ["object_lineage:#actor"]
    });
    expect(owned.cells[0]?.provenance).toBe("authoritative");

    room.close();
    cluster.close();
  });
});
