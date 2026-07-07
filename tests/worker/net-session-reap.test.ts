// H2b: the session reaper — expired session cells and their presence
// rows are cleaned up on the scope alarm as an owner-sequenced event
// (ScopeSequencer.reapExpiredSessions + the NetScopeDO delivery half).
//
// Fixture: a cluster scope owning three session cells —
//   s_far   expired, last present in a room anchored at ANOTHER scope
//           (its presence row lives at the room scope; the reaper sends
//           a /net/relate remove by the CO15 `room:<owner>` convention);
//   s_local expired, last present in a room anchored HERE (its presence
//           row is local; the reaper removes it in the batch and refans
//           the removal to fanout subscribers);
//   s_live  NOT expired — must survive, and its expiry re-arms the alarm.
import { describe, expect, it } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import type { FanoutBody } from "../../src/net/outbox";

const SECRET = "net-session-reap-secret";
const EPOCH = "cat-net-reap-1";
const CLUSTER = "cluster:reap_actor";
const FAR_ROOM_SCOPE = "room:far_room";

function netState(name: string): {
  state: NetScopeDurableState;
  alarms: number[];
  settle: () => Promise<void>;
  close: () => void;
} {
  const fake = new FakeDurableObjectState(name);
  const deferred: Array<Promise<unknown>> = [];
  const alarms: number[] = [];
  const state = {
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
      deleteAlarm: () => {}
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

function sessionSeed(id: string, actor: string, expiresAt: number, activeScope: string | null) {
  return {
    kind: "session" as const,
    object: id,
    value: { id, actor, started: expiresAt - 60_000, expiresAt, activeScope }
  };
}

describe("session reaper on the scope alarm (H2b)", () => {
  it("reaps expired session cells, removes local + foreign presence rows, re-arms for the next expiry", async () => {
    const now = Date.now();
    const liveExpiry = now + 3_600_000;

    // The gateway mirror stub: records every /net/fanout body it receives.
    const fanouts: FanoutBody[] = [];
    const mirror: Fetchable = {
      fetch: async (request: Request) => {
        const url = new URL(request.url);
        if (url.pathname === "/net/fanout") fanouts.push((await request.json()) as FanoutBody);
        return new Response(JSON.stringify({ applied: true }), { status: 200 });
      }
    };

    const farState = netState("scope-far-room");
    const clusterState = netState("scope-reap-cluster");
    let farDO: NetScopeDO;
    let clusterDO: NetScopeDO;
    const env: NetScopeEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        if (destination === `scope:${FAR_ROOM_SCOPE}`) return farDO;
        if (destination === `scope:${CLUSTER}`) return clusterDO;
        if (destination === "gateway:mirror") return mirror;
        throw new Error(`unexpected destination ${destination}`);
      }
    };
    farDO = new NetScopeDO(farState.state, env);
    clusterDO = new NetScopeDO(clusterState.state, env);

    // Seed the far room (owns far_room's lineage — the presence row's
    // home) and give it s_far's presence row via a setup /net/relate.
    await call(farDO, env, "/seed", {
      scope: FAR_ROOM_SCOPE,
      catalog_epoch: EPOCH,
      cells: [{ kind: "object_lineage", object: "far_room", value: { object: "far_room", parents: [] } }]
    });
    await call(farDO, env, "/relate", {
      from_scope: "setup-lane",
      seq: 1,
      deltas: [
        { op: "add", row: { relation: "session_presence", owner: "far_room", member: "s_far", body: { actor: "reap_actor" } } }
      ]
    });

    // Seed the cluster: two expired sessions, one live, and the LOCAL
    // room's lineage (so s_local's presence row anchors here).
    await call(clusterDO, env, "/seed", {
      scope: CLUSTER,
      catalog_epoch: EPOCH,
      cells: [
        { kind: "object_lineage", object: "local_room", value: { object: "local_room", parents: [] } },
        sessionSeed("s_far", "reap_actor", now - 10_000, "far_room"),
        sessionSeed("s_local", "reap_actor", now - 10_000, "local_room"),
        sessionSeed("s_live", "reap_actor", liveExpiry, null)
      ]
    });
    // The seed carried session cells: the reap alarm armed to the
    // EARLIEST relevant wake (the expired cells are already due; the
    // arm-only-"ok" rule means s_live's expiry is what registers).
    expect(clusterState.alarms.length).toBeGreaterThan(0);
    // s_local's presence row, delivered like any relate (setup lane).
    await call(clusterDO, env, "/relate", {
      from_scope: "setup-lane",
      seq: 1,
      deltas: [
        { op: "add", row: { relation: "session_presence", owner: "local_room", member: "s_local", body: { actor: "reap_actor" } } }
      ]
    });
    // A fanout subscriber (the gateway mirror) to receive the refan.
    await call(clusterDO, env, "/subscribe", { destination: "gateway:mirror" });

    // ---- The alarm fires: the reaper runs.
    await clusterDO.alarm();
    await clusterState.settle();
    await farState.settle();

    // Expired cells deleted; the live one survives.
    const closure = await call<{ cells: Array<{ key: string }>; head: { seq: number }; relations?: Array<{ owner: string; member: string }> }>(
      clusterDO,
      env,
      "/closure",
      { keys: ["*"], known: [] }
    );
    const keys = closure.cells.map((cell) => cell.key);
    expect(keys).not.toContain("session:s_far");
    expect(keys).not.toContain("session:s_local");
    expect(keys).toContain("session:s_live");
    // ONE owner-sequenced head advance for the whole batch (seed = 0,
    // the setup relate advanced to 1, the reap batch to 2 — exactly one).
    expect(closure.head.seq).toBe(2);
    // The LOCAL presence row is gone from the cluster's relation family.
    expect(closure.relations ?? []).not.toContainEqual(expect.objectContaining({ owner: "local_room", member: "s_local" }));

    // The local removal refanned to the subscriber at the advanced head.
    const refan = fanouts.find((body) => (body.relations ?? []).some((delta) => delta.op === "remove"));
    expect(refan, "no removal refan reached the mirror").toBeTruthy();
    expect(refan?.seq).toBe(2);
    expect(refan?.relations).toContainEqual(
      expect.objectContaining({ op: "remove", row: expect.objectContaining({ owner: "local_room", member: "s_local" }) })
    );

    // The FOREIGN presence row was removed at the far room via /net/relate
    // (addressed by the room:<owner> convention).
    const farClosure = await call<{ relations?: Array<{ owner: string; member: string }> }>(farDO, env, "/closure", {
      keys: ["*"],
      known: []
    });
    expect(farClosure.relations ?? []).not.toContainEqual(expect.objectContaining({ owner: "far_room", member: "s_far" }));

    // The alarm re-armed for the next FUTURE expiry (s_live).
    expect(clusterState.alarms).toContain(liveExpiry);

    // Idempotence: a second alarm pass finds nothing expired — the head
    // does not advance again.
    await clusterDO.alarm();
    await clusterState.settle();
    const after = await call<{ head: { seq: number } }>(clusterDO, env, "/closure", { keys: ["*"], known: [] });
    expect(after.head.seq).toBe(2);

    farState.close();
    clusterState.close();
  });
});
