// CO13 relations over the DO shells (Plan 002 Phase 3.5 item 3):
// a cross-scope move commits at the actor's CLUSTER, the room — the
// foreign owner of the contents/presence rows — receives the deltas via
// a durable /net/relate outbox row ((from_scope, seq) idempotent, the
// /adopt idioms exactly), applies them owner-sequenced, and REFANS them
// to its subscriber gateway, whose GET /net/relation serves the roster.
// Local deltas ride the commit's own FanoutBody.relations. Fake-DO lane
// with real per-instance SQLite, mirroring net-scope-fanout.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import type { NetStub } from "../../src/worker/net/workerd-host";
import { applyTranscript } from "../../src/net/transcript";
import { ScopeSequencer, type CommitReply, type CommitSubmit, type ScopeHead } from "../../src/net/scope";
import type { RelationDelta } from "../../src/net/relations";
import { turnEchoId } from "../../src/net/turn-echo";
import { makeCell } from "../../src/net/cells";

const SECRET = "net-relations-test-secret";
const EPOCH = "cat-net-relations-1";
const ROOM_SCOPE = "room_w";
const CLUSTER_SCOPE = "cluster_c";

/** Fake DO state + waitUntil capture (net-scope-fanout idiom) so tests
 * can await drains started by an explicit durable alarm event. */
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
      setAlarm: () => {},
      deleteAlarm: () => {}
    }
  };
  return {
    state,
    sql: fake.storage.sql,
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

/** Wrap a stub, recording every request body. */
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

function roomCells() {
  return [{ kind: "object_lineage" as const, object: "#room", value: { parent: null, owner: "#actor", name: "room", anchor: null, flags: {} } }];
}

function clusterCells() {
  return [
    { kind: "object_lineage" as const, object: "#actor", value: { parent: null, owner: "#actor", name: "actor", anchor: null, flags: {} } },
    { kind: "object_live" as const, object: "#actor", value: { location: null } },
    { kind: "property_cell" as const, object: "#actor", name: "last_error", value: { value: null } },
    // CO14: the cluster is the session's authority — the sequenced move
    // below names s1, and authorize validates it from this owned cell.
    { kind: "session" as const, object: "s1", value: { id: "s1", actor: "#actor", started: 0 } }
  ];
}

/** Cross-scope move turn, committed at the actor's CLUSTER: the actor
 * moves into #room (a ROOM-anchored owner) and its session transitions
 * there too — both relation deltas are the room's rows, not the
 * cluster's. Reads are empty: the fixture exercises delivery. */
function crossScopeMoveSubmit(base: ScopeHead): CommitSubmit {
  const transcript = {
    kind: "woo.effect_transcript.shadow.v1",
    route: "sequenced",
    scope: CLUSTER_SCOPE,
    seq: 1,
    session: "s1",
    call: { actor: "#actor", target: "#actor", verb: "moveto", args: ["#room"], body: undefined },
    reads: [],
    writes: [],
    creates: [],
    moves: [{ object: "#actor", from: null, to: "#room" }],
    sessionScopeTransition: { session: "s1", actor: "#actor", from: null, to: "#room" },
    observations: [
      {
        type: "entered",
        source: "#room",
        actor: "#actor",
        text: "actor enters room"
      }
    ],
    logicalInputs: [],
    untrackedEffects: [],
    complete: true,
    incompleteReasons: [],
    hash: "net-relations-move-1"
  };
  const twin = new ScopeSequencer(CLUSTER_SCOPE, EPOCH);
  twin.seed(clusterCells());
  const derived = applyTranscript(twin.store, transcript as never, { scope_head: "x", catalog_epoch: EPOCH });
  return {
    kind: "woo.net.commit_submit.v1",
    scope: CLUSTER_SCOPE,
    base,
    idempotency_key: "relations-move-1",
    transcript: transcript as never,
    post_state_version: derived.postStateVersion,
    stamp: { scope_head: "x", catalog_epoch: EPOCH }
  };
}

/** A rolling/aged catalog shape: a sequenced call through #room writes only
 * the anchored actor's cluster state and emits a default-audience fact. With
 * no room-owned projection write and no relation delta, the observation-owner
 * direction is the only path from the accepted cluster commit to room peers. */
function offSpaceObservationSubmit(base: ScopeHead): CommitSubmit {
  const transcript = {
    kind: "woo.effect_transcript.shadow.v1",
    route: "sequenced",
    scope: CLUSTER_SCOPE,
    space: "#room",
    seq: 1,
    session: "s1",
    call: { actor: "#actor", target: "#actor", verb: "legacy_notice", args: ["scorpio"], body: undefined },
    reads: [],
    writes: [{
      cell: { kind: "prop", object: "#actor", name: "last_error" },
      value: "scorpio",
      op: "set",
      writer: {
        progr: "#actor",
        thisObj: "#actor",
        verb: "legacy_notice",
        definer: "#actor",
        caller: "#actor",
        callerPerms: "#actor"
      }
    }],
    creates: [],
    moves: [],
    observations: [{ type: "legacy_notice", source: "#actor", request: "scorpio" }],
    logicalInputs: [],
    untrackedEffects: [],
    complete: true,
    incompleteReasons: [],
    hash: "net-relations-observe-1"
  };
  const twin = new ScopeSequencer(CLUSTER_SCOPE, EPOCH);
  twin.seed(clusterCells());
  const derived = applyTranscript(twin.store, transcript as never, { scope_head: "x", catalog_epoch: EPOCH });
  return {
    kind: "woo.net.commit_submit.v1",
    scope: CLUSTER_SCOPE,
    base,
    idempotency_key: "relations-observe-1",
    transcript: transcript as never,
    post_state_version: derived.postStateVersion,
    stamp: { scope_head: "x", catalog_epoch: EPOCH }
  };
}

/** Room-local move turn: a room-anchored box enters the room, so the
 * contents delta is LOCAL and rides the commit's own fanout body. */
function localMoveSubmit(base: ScopeHead): CommitSubmit {
  const transcript = {
    kind: "woo.effect_transcript.shadow.v1",
    // Tooling submit without a session: direct route (CO14 — a sequenced
    // turn must name a session).
    route: "direct",
    scope: ROOM_SCOPE,
    seq: 1,
    call: { actor: "#actor", target: "#box", verb: "moveto", args: ["#room"], body: undefined },
    reads: [],
    writes: [],
    creates: [],
    moves: [{ object: "#box", from: null, to: "#room" }],
    observations: [],
    logicalInputs: [],
    untrackedEffects: [],
    complete: true,
    incompleteReasons: [],
    hash: "net-relations-local-1"
  };
  const twin = new ScopeSequencer(ROOM_SCOPE, EPOCH);
  twin.seed([
    ...roomCells(),
    { kind: "object_lineage" as const, object: "#box", value: { parent: null, owner: "#actor", name: "box", anchor: "#room", flags: {} } },
    { kind: "object_live" as const, object: "#box", value: { location: null } }
  ]);
  const derived = applyTranscript(twin.store, transcript as never, { scope_head: "x", catalog_epoch: EPOCH });
  return {
    kind: "woo.net.commit_submit.v1",
    scope: ROOM_SCOPE,
    base,
    idempotency_key: "relations-local-1",
    transcript: transcript as never,
    post_state_version: derived.postStateVersion,
    stamp: { scope_head: "x", catalog_epoch: EPOCH }
  };
}

function scopeRelationRows(state: NetScopeDurableState): Array<{ key: string }> {
  return (
    state.storage.sql.exec("SELECT key FROM net_scope_relation ORDER BY key") as { toArray(): Array<{ key: string }> }
  ).toArray();
}

type RelationRead = { relation: string; owner: string; members: Array<{ member: string; body?: unknown }> };

describe("lane-batched /net/fanout receive (2026-07-22 gateway occupancy)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies batch rows serially with the seq gate and stamps net_gateway_fanout_applied", async () => {
    const metricLines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      metricLines.push(args.map(String).join(" "));
    });
    const gatewayState = netState("gateway-batch-receive");
    const gatewayEnv: NetGatewayEnv = { WOO_INTERNAL_SECRET: SECRET };
    const gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);
    const row = (seq: number) => ({
      scope: ROOM_SCOPE,
      seq,
      delivery_seq: seq,
      cells: [],
      observations: []
    });
    // Batch of two: both advance the per-scope seq gate, in order.
    const first = await call<{ applied: boolean[] }>(gateway, gatewayEnv, "/fanout", {
      kind: "woo.net.fanout_batch.v1",
      rows: [row(1), row(2)]
    });
    expect(first.applied).toEqual([true, true]);
    // Redelivered batch: the seq gate no-ops every row (CO2.5) — the
    // retry-whole-prefix contract the sender relies on.
    const replay = await call<{ applied: boolean[] }>(gateway, gatewayEnv, "/fanout", {
      kind: "woo.net.fanout_batch.v1",
      rows: [row(1), row(2)]
    });
    expect(replay.applied).toEqual([false, false]);
    // A bare single body keeps the pre-batch wire shape and reply.
    const single = await call<{ applied: boolean }>(gateway, gatewayEnv, "/fanout", row(3));
    expect(single.applied).toBe(true);
    // Receive-side occupancy stamp: one event per request with the row
    // count on it (batch, replay, single).
    const stamps = metricLines
      .filter((line) => line.includes("net_gateway_fanout_applied"))
      .map((line) => JSON.parse(line.slice(line.indexOf("{"))) as { rows: number; applied: number; ms: number });
    expect(stamps.map((s) => ({ rows: s.rows, applied: s.applied }))).toEqual([
      { rows: 2, applied: 2 },
      { rows: 2, applied: 0 },
      { rows: 1, applied: 1 }
    ]);
    for (const s of stamps) expect(typeof s.ms).toBe("number");
    gatewayState.close();
  });

  it("a partially applied batch still stamps ONE receive event with status/error and the applied count", async () => {
    const metricLines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      metricLines.push(args.map(String).join(" "));
    });
    const gatewayState = netState("gateway-batch-partial");
    const gatewayEnv: NetGatewayEnv = { WOO_INTERNAL_SECRET: SECRET };
    const gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);
    const good = { scope: ROOM_SCOPE, seq: 1, delivery_seq: 1, cells: [], observations: [] };
    // Row 2's null cell throws inside receiveFanout AFTER row 1 durably
    // advanced — the survivorship-bias case the review reproduced.
    const poison = { scope: ROOM_SCOPE, seq: 2, delivery_seq: 2, cells: [null], observations: [] };
    await expect(
      call(gateway, gatewayEnv, "/fanout", { kind: "woo.net.fanout_batch.v1", rows: [good, poison] })
    ).rejects.toThrow();
    const stamps = metricLines
      .filter((line) => line.includes("net_gateway_fanout_applied"))
      .map((line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>);
    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toMatchObject({ rows: 2, applied: 1, status: "error" });
    expect(typeof stamps[0]!.ms).toBe("number");
    expect(String(stamps[0]!.error).length).toBeGreaterThan(0);
    gatewayState.close();
  });
});

describe("gateway fanout write amplification", () => {
  it("does not rewrite byte-identical cells or relation rows at a newer sequence", async () => {
    const state = netState("gateway-noop-write-suppression");
    const gatewayEnv: NetGatewayEnv = { WOO_INTERNAL_SECRET: SECRET };
    const gateway = new NetGatewayDO(state.state, gatewayEnv);
    const cell = makeCell({
      kind: "property_cell",
      object: "guest_1",
      name: "name",
      value: { value: "unchanged" },
      provenance: "authoritative",
      stamp: { scope_head: "gateway-noop", catalog_epoch: EPOCH }
    });
    const relation = { op: "add" as const, row: { relation: "contents", owner: "the_chatroom", member: "guest_1" } };
    const body = (seq: number) => ({
      scope: ROOM_SCOPE,
      seq,
      delivery_seq: seq,
      cells: [cell],
      relations: [relation],
      observations: []
    });

    await call(gateway, gatewayEnv, "/fanout", body(1));
    const before = state.sql.execLog.length;
    await call(gateway, gatewayEnv, "/fanout", body(2));
    const repeated = state.sql.execLog.slice(before);

    const cellWrites = repeated.filter((entry) => entry.query.startsWith("INSERT INTO net_gateway_cell"));
    const relationWrites = repeated.filter((entry) => entry.query.startsWith("INSERT INTO net_gateway_relation"));
    expect(cellWrites).toHaveLength(1);
    expect(relationWrites).toHaveLength(1);
    expect(cellWrites[0]!.changes).toBe(0);
    expect(relationWrites[0]!.changes).toBe(0);
    // The delivery high-water still advances: suppression affects derived
    // payload duplicates, never ordering or continuity authority.
    expect(repeated.find((entry) => entry.query.startsWith("INSERT INTO net_gateway_scope"))?.changes).toBe(1);
    state.close();
  });
});

describe("CO13 relations over the DO shells", () => {
  it("an empty full closure removes stale presence before suppressing its delayed removal", async () => {
    const scope = "room:exact_room";
    const gatewayState = netState("gateway-relations-full-replacement");
    const closureStub: NetStub = {
      fetch: async (request) => {
        expect(new URL(request.url).pathname).toBe("/net/closure");
        return new Response(JSON.stringify({
          kind: "woo.net.cell_transfer.v1",
          cells: [],
          assumes_known: [],
          scope,
          head: { seq: 2, hash: "exact-head-2", generation: 2 },
          catalog_epoch: EPOCH,
          relations: []
        }), { headers: { "content-type": "application/json" } });
      }
    };
    const gatewayEnv: NetGatewayEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        if (destination === `scope:${scope}`) return closureStub;
        throw new Error(`unexpected destination ${destination}`);
      }
    };
    const gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);
    const row = {
      relation: "session_presence",
      owner: "exact_room",
      member: "departed-session",
      body: { actor: "departed-actor" }
    };

    // The shard saw the add but missed the authority's seq-2 removal.
    expect((await call<{ applied: boolean }>(gateway, gatewayEnv, "/fanout", {
      scope,
      seq: 1,
      cells: [],
      relations: [{ op: "add", row }],
      observations: []
    })).applied).toBe(true);
    expect((await call<RelationRead>(
      gateway,
      gatewayEnv,
      "/relation?relation=session_presence&owner=exact_room"
    )).members).toEqual([{ member: "departed-session", body: { actor: "departed-actor" } }]);

    // The exact head-2 closure has an explicitly empty relation family.
    // Replacement must delete the phantom before seen advances to 2.
    await call(gateway, gatewayEnv, "/pull", { scope, destination: `scope:${scope}` });
    expect((await call<RelationRead>(
      gateway,
      gatewayEnv,
      "/relation?relation=session_presence&owner=exact_room"
    )).members).toEqual([]);

    // Delivery of the matching removal is now intentionally suppressed by
    // the high-water. It is harmless because replacement already removed it.
    expect((await call<{ applied: boolean }>(gateway, gatewayEnv, "/fanout", {
      scope,
      seq: 2,
      cells: [],
      relations: [{ op: "remove", row }],
      observations: []
    })).applied).toBe(false);
    expect((await call<RelationRead>(
      gateway,
      gatewayEnv,
      "/relation?relation=session_presence&owner=exact_room"
    )).members).toEqual([]);

    gatewayState.close();
  });

  it("an observations-only affected-scope delivery advances the semantic owner and refans to its subscribers", async () => {
    const gatewayState = netState("gateway-observation-owner");
    const gatewayEnv: NetGatewayEnv = { WOO_INTERNAL_SECRET: SECRET };
    const gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);
    const gatewayRecorder = recordingStub(gateway);

    const room = netState(`scope-${ROOM_SCOPE}-observation-owner`);
    const roomEnv: NetScopeEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        if (destination === "gateway:g1") return gatewayRecorder.stub;
        throw new Error(`unexpected destination ${destination}`);
      }
    };
    const roomDO = new NetScopeDO(room.state, roomEnv);
    const roomRecorder = recordingStub(roomDO);
    await call(roomDO, roomEnv, "/seed", { scope: ROOM_SCOPE, catalog_epoch: EPOCH, cells: roomCells() });
    await call(roomDO, roomEnv, "/subscribe", { destination: "gateway:g1" });

    const cluster = netState(`scope-${CLUSTER_SCOPE}-observation-owner`);
    const clusterEnv: NetScopeEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        if (destination === `scope:${ROOM_SCOPE}`) return roomRecorder.stub;
        throw new Error(`unexpected destination ${destination}`);
      }
    };
    const clusterDO = new NetScopeDO(cluster.state, clusterEnv);
    await call(clusterDO, clusterEnv, "/seed", { scope: CLUSTER_SCOPE, catalog_epoch: EPOCH, cells: clusterCells() });

    const head0 = (await call<{ head: ScopeHead }>(clusterDO, clusterEnv, "/head")).head;
    const submit = offSpaceObservationSubmit(head0);
    await expect(call(clusterDO, clusterEnv, "/submit", {
      submit,
      relate_destinations: {
        [ROOM_SCOPE]: {
          destination: `scope:${ROOM_SCOPE}`,
          objects: [],
          observation_indexes: [1]
        }
      }
    })).rejects.toThrow(/E_INVARG.*observation index/);
    // Invalid internal routing metadata must roll back both authority and
    // outbox state; accepting the same turn below proves no phantom cached
    // reply survived discardSeqOnThrow.
    expect((await call<{ head: ScopeHead }>(clusterDO, clusterEnv, "/head")).head.seq).toBe(0);

    const relate = {
      [ROOM_SCOPE]: {
        destination: `scope:${ROOM_SCOPE}`,
        objects: [],
        observation_indexes: [0]
      }
    };
    const reply = await call<CommitReply>(clusterDO, clusterEnv, "/submit", {
      submit,
      relate_destinations: relate
    });
    expect(reply.status).toBe("accepted");
    if (reply.status !== "accepted") return;
    expect(reply.relations_foreign).toBeUndefined();
    expect(roomRecorder.calls.filter((call) => call.path === "/net/relate")).toHaveLength(0);

    await clusterDO.alarm();
    await cluster.settle();
    await room.settle();

    const relateCalls = roomRecorder.calls.filter((call) => call.path === "/net/relate");
    expect(relateCalls).toHaveLength(1);
    const relateBody = relateCalls[0].body as {
      from_scope: string;
      seq: number;
      deltas: RelationDelta[];
      observations: unknown[];
      submitter_turn_id: string;
      echo_id: string;
    };
    expect(relateBody).toMatchObject({
      from_scope: CLUSTER_SCOPE,
      seq: 1,
      deltas: [],
      observations: [{ type: "legacy_notice", source: "#actor", request: "scorpio" }],
      submitter_turn_id: "relations-observe-1",
      echo_id: turnEchoId("relations-observe-1")
    });
    expect((await call<{ head: ScopeHead }>(roomDO, roomEnv, "/head")).head.seq).toBe(1);

    // The incoming owner delivery enqueued refan but did not recurse through
    // room → gateway in the same request lineage.
    expect(gatewayRecorder.calls.filter((call) => call.path === "/net/fanout")).toHaveLength(0);
    await roomDO.alarm();
    await room.settle();
    const fanoutCalls = gatewayRecorder.calls.filter((call) => call.path === "/net/fanout");
    expect(fanoutCalls).toHaveLength(1);
    expect(fanoutCalls[0].body).toMatchObject({
      scope: ROOM_SCOPE,
      seq: 1,
      cells: [],
      observations: [{ type: "legacy_notice", source: "#actor", request: "scorpio" }],
      relations: [],
      submitter_turn_id: "relations-observe-1",
      echo_id: turnEchoId("relations-observe-1")
    });

    // Source redelivery is idempotent at the semantic owner: no second head
    // advance and no second refan.
    expect((await call<{ applied: boolean }>(roomDO, roomEnv, "/relate", relateBody)).applied).toBe(false);
    await room.settle();
    expect((await call<{ head: ScopeHead }>(roomDO, roomEnv, "/head")).head.seq).toBe(1);
    expect(gatewayRecorder.calls.filter((call) => call.path === "/net/fanout")).toHaveLength(1);

    room.close();
    cluster.close();
    gatewayState.close();
  });

  it("a cross-scope move delivers /net/relate to the owner, which applies and refans to its subscriber gateway; redelivery no-ops", async () => {
    const scopeEnvBase = { WOO_INTERNAL_SECRET: SECRET };

    // Subscriber: a gateway shard registered on the ROOM scope.
    const gatewayState = netState("gateway-relations-1");
    const gatewayEnv: NetGatewayEnv = { WOO_INTERNAL_SECRET: SECRET };
    const gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);
    const gatewayRecorder = recordingStub(gateway);

    // The owner: the room scope, wired to reach its subscriber.
    const room = netState(`scope-${ROOM_SCOPE}-relations`);
    const roomEnv: NetScopeEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        if (destination === "gateway:g1") return gatewayRecorder.stub;
        throw new Error(`unexpected destination ${destination}`);
      }
    };
    const roomDO = new NetScopeDO(room.state, roomEnv);
    const roomRecorder = recordingStub(roomDO);
    await call(roomDO, roomEnv, "/seed", { scope: ROOM_SCOPE, catalog_epoch: EPOCH, cells: roomCells() });
    await call(roomDO, roomEnv, "/subscribe", { destination: "gateway:g1" });

    // The committing scope: the actor's cluster, wired to reach the room.
    const cluster = netState(`scope-${CLUSTER_SCOPE}-relations`);
    const clusterEnv: NetScopeEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        if (destination === `scope:${ROOM_SCOPE}`) return roomRecorder.stub;
        throw new Error(`unexpected destination ${destination}`);
      }
    };
    const clusterDO = new NetScopeDO(cluster.state, clusterEnv);
    await call(clusterDO, clusterEnv, "/seed", { scope: CLUSTER_SCOPE, catalog_epoch: EPOCH, cells: clusterCells() });

    const head0 = (await call<{ head: ScopeHead }>(clusterDO, clusterEnv, "/head")).head;
    const submit = crossScopeMoveSubmit(head0);
    // The gateway's relate_destinations sibling names the room as the
    // foreign owner of #room's relation rows (the scopeOf hints).
    const relate = { [ROOM_SCOPE]: { destination: `scope:${ROOM_SCOPE}`, objects: ["#room"] } };
    const reply = await call<CommitReply>(clusterDO, clusterEnv, "/submit", { submit, relate_destinations: relate });
    expect(reply.status).toBe("accepted");
    if (reply.status !== "accepted") return;
    // Both deltas (contents membership + session presence) are the
    // room's rows: nothing applies locally at the cluster.
    expect(reply.relations).toBeUndefined();
    expect(reply.relations_foreign?.[0]?.scope).toBe(ROOM_SCOPE);
    expect(reply.relations_foreign?.[0]?.deltas).toHaveLength(2);
    // Submit returns before any gateway/scope callback begins. The fresh
    // alarm event drains /relate without a gateway -> scope -> gateway
    // request cycle.
    expect(roomRecorder.calls.filter((c) => c.path === "/net/relate")).toHaveLength(0);
    await clusterDO.alarm();
    await cluster.settle();
    // The incoming /relate MUST NOT recursively drain its refan in the
    // same CF request lineage. It arms a fresh alarm event instead.
    await room.settle();
    expect(gatewayRecorder.calls.filter((c) => c.path === "/net/fanout")).toHaveLength(0);
    await roomDO.alarm();
    await room.settle(); // fresh alarm event drains the refan

    // The room received exactly one /net/relate with the commit's
    // (from_scope, seq) identity and applied it owner-sequenced.
    const relateCalls = roomRecorder.calls.filter((c) => c.path === "/net/relate");
    expect(relateCalls).toHaveLength(1);
    const relateBody = relateCalls[0].body as {
      from_scope: string;
      seq: number;
      deltas: RelationDelta[];
      observations?: unknown[];
      submitter_turn_id?: string;
      echo_id?: string;
    };
    expect(relateBody.from_scope).toBe(CLUSTER_SCOPE);
    expect(relateBody.seq).toBe(1);
    expect(relateBody.submitter_turn_id).toBe("relations-move-1");
    expect(relateBody.echo_id).toBe(turnEchoId("relations-move-1"));
    expect(relateBody.observations).toEqual([
      expect.objectContaining({ type: "entered", source: "#room", actor: "#actor" })
    ]);
    expect(scopeRelationRows(room.state).map((r) => r.key)).toEqual([
      "relation:contents:#room:#actor",
      "relation:session_presence:#room:s1"
    ]);
    // Owner-sequenced: the room's head advanced once for the batch.
    expect((await call<{ head: ScopeHead }>(roomDO, roomEnv, "/head")).head.seq).toBe(1);

    // The refan reached the subscriber with the applied deltas riding
    // FanoutBody.relations at the room's advanced seq…
    const fanoutCalls = gatewayRecorder.calls.filter((c) => c.path === "/net/fanout");
    expect(fanoutCalls).toHaveLength(1);
    const fanBody = fanoutCalls[0].body as {
      scope: string;
      seq: number;
      cells: unknown[];
      observations?: unknown[];
      relations?: RelationDelta[];
      submitter_turn_id?: string;
      echo_id?: string;
    };
    expect(fanBody.scope).toBe(ROOM_SCOPE);
    expect(fanBody.seq).toBe(1);
    expect(fanBody.cells).toEqual([]);
    expect(fanBody.submitter_turn_id).toBe("relations-move-1");
    expect(fanBody.echo_id).toBe(turnEchoId("relations-move-1"));
    expect(fanBody.observations).toEqual([
      expect.objectContaining({ type: "entered", source: "#room", actor: "#actor" })
    ]);
    expect(fanBody.relations).toHaveLength(2);
    // …and the gateway's client-read primitive serves the roster.
    const contents = await call<RelationRead>(gateway, gatewayEnv, `/relation?relation=contents&owner=${encodeURIComponent("#room")}`);
    expect(contents.members).toEqual([{ member: "#actor" }]);
    const presence = await call<RelationRead>(
      gateway,
      gatewayEnv,
      `/relation?relation=session_presence&owner=${encodeURIComponent("#room")}`
    );
    expect(presence.members).toEqual([
      {
        member: "s1",
        body: expect.objectContaining({
          actor: "#actor",
          name: "actor",
          session: expect.objectContaining({ id: "s1", actor: "#actor" })
        })
      }
    ]);

    // Redelivery of the processed relate no-ops below the high-water:
    // no row churn, no head movement, no second refan (CO2.5).
    const replay = await call<{ applied: boolean }>(roomDO, roomEnv, "/relate", relateBody);
    expect(replay.applied).toBe(false);
    await room.settle();
    expect((await call<{ head: ScopeHead }>(roomDO, roomEnv, "/head")).head.seq).toBe(1);
    expect(gatewayRecorder.calls.filter((c) => c.path === "/net/fanout")).toHaveLength(1);

    // A replayed fanout body no-ops at the gateway too (same seq gate as
    // cells), leaving the mirror unchanged.
    const replayFan = await call<{ applied: boolean }>(gateway, gatewayEnv, "/fanout", fanBody);
    expect(replayFan.applied).toBe(false);
    const contentsAfter = await call<RelationRead>(gateway, gatewayEnv, `/relation?relation=contents&owner=${encodeURIComponent("#room")}`);
    expect(contentsAfter.members).toEqual([{ member: "#actor" }]);

    room.close();
    cluster.close();
    gatewayState.close();
  });

  it("local relation deltas ride the commit's own FanoutBody.relations to the subscriber gateway", async () => {
    const gatewayState = netState("gateway-relations-2");
    const gatewayEnv: NetGatewayEnv = { WOO_INTERNAL_SECRET: SECRET };
    const gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);
    const gatewayRecorder = recordingStub(gateway);

    const room = netState(`scope-${ROOM_SCOPE}-relations-local`);
    const roomEnv: NetScopeEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        if (destination === "gateway:g1") return gatewayRecorder.stub;
        throw new Error(`unexpected destination ${destination}`);
      }
    };
    const roomDO = new NetScopeDO(room.state, roomEnv);
    await call(roomDO, roomEnv, "/seed", {
      scope: ROOM_SCOPE,
      catalog_epoch: EPOCH,
      cells: [
        ...roomCells(),
        { kind: "object_lineage", object: "#box", value: { parent: null, owner: "#actor", name: "box", anchor: "#room", flags: {} } },
        { kind: "object_live", object: "#box", value: { location: null } }
      ]
    });
    await call(roomDO, roomEnv, "/subscribe", { destination: "gateway:g1" });

    const head0 = (await call<{ head: ScopeHead }>(roomDO, roomEnv, "/head")).head;
    // No relate_destinations sibling: every delta classifies local.
    const reply = await call<CommitReply>(roomDO, roomEnv, "/submit", localMoveSubmit(head0));
    expect(reply.status).toBe("accepted");
    if (reply.status !== "accepted") return;
    expect(reply.relations).toEqual([{
      op: "add",
      row: { relation: "contents", owner: "#room", member: "#box", member_scope: ROOM_SCOPE }
    }]);
    expect(reply.relations_foreign).toBeUndefined();
    expect(gatewayRecorder.calls.filter((c) => c.path === "/net/fanout")).toHaveLength(0);
    await roomDO.alarm();
    await room.settle();

    // The local delta was applied at the room durably AND rode the
    // commit's fanout body — the gateway mirror agrees with the owner.
    expect(scopeRelationRows(room.state).map((r) => r.key)).toEqual(["relation:contents:#room:#box"]);
    const fanoutCalls = gatewayRecorder.calls.filter((c) => c.path === "/net/fanout");
    expect(fanoutCalls).toHaveLength(1);
    expect((fanoutCalls[0].body as { relations?: RelationDelta[] }).relations).toHaveLength(1);
    const contents = await call<RelationRead>(gateway, gatewayEnv, `/relation?relation=contents&owner=${encodeURIComponent("#room")}`);
    expect(contents.members).toEqual([{ member: "#box" }]);

    room.close();
    gatewayState.close();
  });
});
