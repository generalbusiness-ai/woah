// CO13 relations over the DO shells (Plan 002 Phase 3.5 item 3):
// a cross-scope move commits at the actor's CLUSTER, the room — the
// foreign owner of the contents/presence rows — receives the deltas via
// a durable /net/relate outbox row ((from_scope, seq) idempotent, the
// /adopt idioms exactly), applies them owner-sequenced, and REFANS them
// to its subscriber gateway, whose GET /net/relation serves the roster.
// Local deltas ride the commit's own FanoutBody.relations. Fake-DO lane
// with real per-instance SQLite, mirroring net-scope-fanout.test.ts.
import { describe, expect, it } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import type { NetStub } from "../../src/worker/net/workerd-host";
import { applyTranscript } from "../../src/net/transcript";
import { ScopeSequencer, type CommitReply, type CommitSubmit, type ScopeHead } from "../../src/net/scope";
import type { RelationDelta } from "../../src/net/relations";

const SECRET = "net-relations-test-secret";
const EPOCH = "cat-net-relations-1";
const ROOM_SCOPE = "room_w";
const CLUSTER_SCOPE = "cluster_c";

/** Fake DO state + waitUntil capture (net-scope-fanout idiom) so tests
 * can await the deferred outbox drains. */
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
    observations: [],
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

describe("CO13 relations over the DO shells", () => {
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
    await cluster.settle(); // cluster drains /relate to the room
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
    const relateBody = relateCalls[0].body as { from_scope: string; seq: number; deltas: RelationDelta[] };
    expect(relateBody.from_scope).toBe(CLUSTER_SCOPE);
    expect(relateBody.seq).toBe(1);
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
    const fanBody = fanoutCalls[0].body as { scope: string; seq: number; cells: unknown[]; relations?: RelationDelta[] };
    expect(fanBody.scope).toBe(ROOM_SCOPE);
    expect(fanBody.seq).toBe(1);
    expect(fanBody.cells).toEqual([]);
    expect(fanBody.relations).toHaveLength(2);
    // …and the gateway's client-read primitive serves the roster.
    const contents = await call<RelationRead>(gateway, gatewayEnv, `/relation?relation=contents&owner=${encodeURIComponent("#room")}`);
    expect(contents.members).toEqual([{ member: "#actor" }]);
    const presence = await call<RelationRead>(
      gateway,
      gatewayEnv,
      `/relation?relation=session_presence&owner=${encodeURIComponent("#room")}`
    );
    expect(presence.members).toEqual([{ member: "s1", body: { actor: "#actor" } }]);

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
    expect(reply.relations).toEqual([{ op: "add", row: { relation: "contents", owner: "#room", member: "#box" } }]);
    expect(reply.relations_foreign).toBeUndefined();
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
