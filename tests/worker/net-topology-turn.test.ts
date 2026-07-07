// CO15 derived topology end-to-end over fake-DO (Plan 002 Phase 3.5
// item 2, chunk 2): a /net/turn request carrying NO topology overrides
// (no anchors/shared/scopes) against a gateway whose view was seeded
// from a partitionCells world — THREE scope DOs (room, cluster,
// catalog). Proves:
//   - the gateway derives its classifier from view lineage (topology.ts
//     anchor walk) and routes by the `scope:<scopeName>` destination
//     convention (the DO namespace key IS the scope name);
//   - foreign reads attest against their derived owners — the class
//     chain against the CATALOG scope DO, the actor's cells against its
//     CLUSTER scope DO (real /net/attest RPCs to both);
//   - a rider write to the actor commits at the room and is adopted at
//     the cluster (rider objects derived from the transcript, not from
//     a request anchor map);
//   - install-on-accept + adoption keep the second turn warm (attempt 1).
import { describe, expect, it } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { installVerb } from "../../src/core/authoring";
import { createWorld } from "../../src/core/bootstrap";
import { cellsFromSerialized, type ShadowTurnCall } from "../../src/net/bridge";
import { CATALOG_SCOPE, partitionCells } from "../../src/net/topology";
import type { AttemptTraceEntry } from "../../src/net/errors";
import type { CommitReply, ScopeHead } from "../../src/net/scope";

const SECRET = "net-topology-test-secret";
const EPOCH = "cat-net-topo-1";

/** Fake DO state + the alarm slice + a settle() that awaits deferred
 * outbox drains (the rider adoption rides host.defer → waitUntil). */
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

type TurnBody = {
  reply: CommitReply;
  selection: { scope: string; riders: string[] };
  attempt: number;
  trace: AttemptTraceEntry[];
  envelopeBytes: number;
  // Phase-4 item 1: the planned transcript's result/observations on an
  // accepted reply; `replayed` on a detected idempotent replay.
  result?: unknown;
  observations?: Array<Record<string, unknown>>;
  replayed?: boolean;
};

describe("NetGatewayDO derived topology (CO15) over three scope DOs", () => {
  it("routes a no-override turn end-to-end: room commit, catalog+cluster attestation, cluster rider adoption", async () => {
    // ---- Engine-real fixture: a room ($space-classed), a room-anchored
    // box with a verb that writes the box (room scope) AND the actor
    // (cluster rider) in one turn, and the actor placed in the room.
    const world = createWorld();
    const session = world.auth("guest:net-topology");
    const actor = session.actor;
    world.createObject({ id: "topo_room", name: "Topo Room", parent: "$space", owner: actor });
    world.createObject({ id: "topo_box", name: "Topo Box", parent: "$thing", owner: actor, anchor: "topo_room", location: "topo_room" });
    world.defineProperty("topo_box", { name: "counter", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
    // A catalog-anchored read source: anchorless, neither actor- nor
    // space-classed → the catalog scope (CO15 anchorless rule). The verb
    // reads its `bonus`, so the plan records a read whose derived owner
    // is the CATALOG scope — exercising catalog attestation for real
    // (class-DEFAULT reads are recorded at the instance, so a shared
    // config object is the honest way to touch catalog state in a turn).
    world.createObject({ id: "topo_config", name: "Topo Config", parent: "$thing", owner: actor });
    world.defineProperty("topo_config", { name: "bonus", defaultValue: 1, owner: actor, perms: "rw", typeHint: "int" });
    world.defineProperty("topo_box", { name: "bonus_source", defaultValue: "topo_config", owner: actor, perms: "rw", typeHint: "obj" });
    // Rider property def on the actor's CLASS (catalog scope) so the
    // actor's own cell is value-only — the same shape the differential
    // two-scope scenario uses (a def on the instance would need the CO7
    // write-preimage transfer at the committing scope).
    const actorClass = world.object(actor).parent as string;
    world.defineProperty(actorClass, { name: "greeted", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
    const installed = installVerb(
      world,
      "topo_box",
      "bump",
      `verb :bump() rxd {
        let src = this.bonus_source;
        this.counter = this.counter + src.bonus;
        actor.greeted = actor.greeted + 1;
        observe({ type: "bumped", counter: this.counter });
        return this.counter;
      }`,
      null
    );
    expect(installed.ok).toBe(true);
    // Genesis placement: the actor occupies the room (this also gives the
    // room partition its presence rows — genesis state, not under test).
    const placed = await world.directCall("topo-genesis-place", actor, actor, "moveto", ["topo_room"], { sessionId: session.id });
    expect(placed.op).toBe("result");

    // ---- Partition the world (CO15 install-pipeline shape) and seed one
    // scope DO per partition we drive. The DO namespace key IS the scope
    // name (`scope:<scopeName>`), so NET_RESOLVE keys on exactly that.
    const partitions = partitionCells(cellsFromSerialized(world.exportWorld()));
    const roomScope = "room:topo_room";
    const clusterScope = `cluster:${actor}`;
    expect([...partitions.keys()]).toEqual(expect.arrayContaining([roomScope, clusterScope, CATALOG_SCOPE]));

    const doStates = new Map<string, ReturnType<typeof netState>>();
    const scopeDOs = new Map<string, NetScopeDO>();
    // Scope DOs resolve their OWN rpc destinations too: the room's adopt
    // outbox delivers to `scope:cluster:<actor>` (the same convention the
    // gateway derives). The lookup is lazy, so registration order below
    // does not matter.
    const scopeEnv: NetScopeEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        const scope = destination.startsWith("scope:") ? destination.slice("scope:".length) : null;
        const instance = scope !== null ? scopeDOs.get(scope) : undefined;
        if (!instance) throw new Error(`unexpected scope-side destination ${destination}`);
        return instance;
      }
    };
    for (const scope of [roomScope, clusterScope, CATALOG_SCOPE]) {
      const st = netState(`scope-${scope}`);
      const instance = new NetScopeDO(st.state, scopeEnv);
      await call(instance, scopeEnv, "/seed", { scope, catalog_epoch: EPOCH, cells: partitions.get(scope) ?? [] });
      doStates.set(scope, st);
      scopeDOs.set(scope, instance);
    }

    // The RPC seams the turn must exercise, recorded per destination so
    // the test can assert WHERE attestations went.
    const rpcLog: string[] = [];
    const gatewayState = netState("gateway-topology");
    const gatewayEnv: NetGatewayEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        const scope = destination.startsWith("scope:") ? destination.slice("scope:".length) : null;
        const instance = scope !== null ? scopeDOs.get(scope) : undefined;
        if (!instance) throw new Error(`unexpected destination ${destination}`);
        return {
          fetch: (request: Request) => {
            rpcLog.push(`${destination}${new URL(request.url).pathname}`);
            return instance.fetch(request);
          }
        };
      }
    };
    const gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);
    for (const scope of [roomScope, clusterScope, CATALOG_SCOPE]) {
      await call(gateway, gatewayEnv, "/pull", { scope, destination: `scope:${scope}` });
    }

    // ---- The turn: NO topology on the request. Classifier and
    // destinations are derived (CO15); the lane override fields stay off.
    const bump = (id: string): ShadowTurnCall => ({
      kind: "woo.turn_call.shadow.v1",
      id,
      route: "direct",
      scope: roomScope,
      session: session.id,
      actor,
      target: "topo_box",
      verb: "bump",
      args: []
    });
    const turnRequest = (key: string) => ({
      call: bump(key),
      planningScope: roomScope,
      catalog_epoch: EPOCH,
      idempotency_key: key
    });

    rpcLog.length = 0;
    const turn1 = await call<TurnBody>(gateway, gatewayEnv, "/turn", turnRequest("topo-t1"));
    expect(turn1.reply.status, JSON.stringify(turn1.reply)).toBe("accepted");
    expect(turn1.attempt).toBe(1);
    expect(turn1.trace).toEqual([]);
    // route.ts on the DERIVED classifier: the box write is the room's,
    // the actor write rides along (CA3) — commit at the room, one rider.
    expect(turn1.selection).toEqual({ scope: roomScope, riders: [clusterScope] });
    // Phase-4 item 1: the accepted reply carries the planned transcript's
    // result (the verb's return value) and observations (the observe()
    // event), and is not marked as a replay.
    expect(turn1.result).toBe(1);
    expect(turn1.observations?.map((o) => o.type)).toContain("bumped");
    expect(turn1.replayed).toBeUndefined();
    // Foreign reads attested at their derived owners over real RPC: the
    // class chain at the catalog scope, the actor's cells at the cluster.
    expect(rpcLog).toContain(`scope:${CATALOG_SCOPE}/net/attest`);
    expect(rpcLog).toContain(`scope:${clusterScope}/net/attest`);
    // The submit went to the room by the `scope:<scopeName>` convention.
    expect(rpcLog).toContain(`scope:${roomScope}/net/submit`);

    // Rider adoption at the cluster (durable outbox off the room DO).
    await (doStates.get(roomScope) as ReturnType<typeof netState>).settle();
    const clusterDO = scopeDOs.get(clusterScope) as NetScopeDO;
    const adopted = await call<{ cells: Array<{ key: string; value: unknown; provenance: string }> }>(
      clusterDO,
      scopeEnv,
      "/closure",
      { keys: [`property_cell:${actor}:greeted`], known: [`object_lineage:${actor}`] }
    );
    expect(adopted.cells).toHaveLength(1);
    expect(adopted.cells[0].value).toMatchObject({ value: 1 });
    // The cluster's head advanced: adoption is an owner-sequenced commit.
    const clusterHead = await call<{ head: ScopeHead }>(clusterDO, scopeEnv, "/head");
    expect(clusterHead.head.seq).toBe(1);

    // ---- Second turn stays warm: install-on-accept refreshed the room
    // cells and the adopted rider version matches the view's copy, so the
    // fresh attestation agrees and no repair round fires.
    const turn2 = await call<TurnBody>(gateway, gatewayEnv, "/turn", turnRequest("topo-t2"));
    expect(turn2.reply.status, JSON.stringify(turn2.reply)).toBe("accepted");
    expect(turn2.attempt).toBe(1);
    expect(turn2.selection).toEqual({ scope: roomScope, riders: [clusterScope] });
    expect(turn2.result).toBe(2);

    // Phase-4 item 1, idempotent replay: resubmitting turn 1's key returns
    // the scope's RECORDED reply (CO2.5). The world moved on (counter is
    // now 2), so this round's re-plan predicts a different post-state than
    // the recorded accept — the gateway detects that digest mismatch,
    // marks the reply replayed, and omits result/observations rather than
    // presenting the re-planned execution as the committed one.
    const replay = await call<TurnBody>(gateway, gatewayEnv, "/turn", turnRequest("topo-t1"));
    expect(replay.reply.status).toBe("accepted");
    if (replay.reply.status === "accepted" && turn1.reply.status === "accepted") {
      expect(replay.reply.post_state_version).toBe(turn1.reply.post_state_version);
    }
    expect(replay.replayed).toBe(true);
    expect(replay.result).toBeUndefined();
    expect(replay.observations).toBeUndefined();

    // Authority landed where the topology says it lives: counter at the
    // room, greeted at the cluster (after the second adoption settles).
    await (doStates.get(roomScope) as ReturnType<typeof netState>).settle();
    const roomDO = scopeDOs.get(roomScope) as NetScopeDO;
    const counter = await call<{ cells: Array<{ value: unknown }> }>(roomDO, scopeEnv, "/closure", {
      keys: ["property_cell:topo_box:counter"],
      known: ["object_lineage:topo_box"]
    });
    expect(counter.cells[0]?.value).toMatchObject({ value: 2 });
    const greeted = await call<{ cells: Array<{ value: unknown }> }>(clusterDO, scopeEnv, "/closure", {
      keys: [`property_cell:${actor}:greeted`],
      known: [`object_lineage:${actor}`]
    });
    expect(greeted.cells[0]?.value).toMatchObject({ value: 2 });

    for (const st of doStates.values()) st.close();
    gatewayState.close();
  });
});
