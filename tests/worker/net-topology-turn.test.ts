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
import { installVerb, installVerbAs } from "../../src/core/authoring";
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
    world.object(actor).flags.programmer = true;
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
    // Install on the class, not the instance: invoking this through topo_box
    // records genuine class-chain reads at the catalog owner. The cache may
    // amortize these cells; it must not amortize topo_config below merely
    // because that mutable compatibility object has the same owner.
    const helperInstalled = installVerb(
      world,
      "$thing",
      "catalog_peek_value",
      "verb :catalog_peek_value() rxd { return 1; }",
      null
    );
    expect(helperInstalled.ok).toBe(true);
    const peekInstalled = installVerb(
      world,
      "$thing",
      "catalog_peek",
      "verb :catalog_peek() rxd { return this:catalog_peek_value(); }",
      null
    );
    expect(peekInstalled.ok).toBe(true);
    const mutateClassInstalled = installVerbAs(
      world,
      "$wiz",
      "topo_box",
      "mutate_catalog_class",
      `verb :mutate_catalog_class() rxd {
        return set_verb_code($thing, "catalog_peek_value", "verb :catalog_peek_value() rxd { return 2; }");
      }`,
      null
    );
    expect(mutateClassInstalled.ok, JSON.stringify(mutateClassInstalled)).toBe(true);
    const mutateClassPropertyInstalled = installVerbAs(
      world,
      "$wiz",
      "topo_box",
      "mutate_catalog_class_property",
      `verb :mutate_catalog_class_property() rxd {
        add_property($thing, "runtime_catalog_property", 1, { perms: "rw", type_hint: "int" });
        return true;
      }`,
      null
    );
    expect(mutateClassPropertyInstalled.ok, JSON.stringify(mutateClassPropertyInstalled)).toBe(true);
    const runtimeInstall = installVerbAs(
      world,
      actor,
      "topo_box",
      "install_runtime_verb",
      `verb :install_runtime_verb() rxd {
        add_verb(this, { name: "runtime_value", perms: "rxd" });
        return set_verb_code(this, "runtime_value", "verb :runtime_value() rxd { return 2; }");
      }`,
      null
    );
    expect(runtimeInstall.ok, JSON.stringify(runtimeInstall)).toBe(true);
    const runtimeRename = installVerbAs(
      world,
      actor,
      "topo_box",
      "rename_runtime_verb",
      `verb :rename_runtime_verb() rxd {
        return set_verb_info(this, "runtime_value", { name: "runtime_renamed", perms: "rxd" });
      }`,
      null
    );
    expect(runtimeRename.ok, JSON.stringify(runtimeRename)).toBe(true);
    const runtimeDelete = installVerbAs(
      world,
      actor,
      "topo_box",
      "delete_runtime_verb",
      `verb :delete_runtime_verb() rxd {
        delete_verb(this, "runtime_renamed");
        return true;
      }`,
      null
    );
    expect(runtimeDelete.ok, JSON.stringify(runtimeDelete)).toBe(true);
    const propertyInstall = installVerbAs(
      world,
      actor,
      "topo_box",
      "install_runtime_property",
      `verb :install_runtime_property() rxd {
        add_property(this, "runtime_property", 7, { perms: "rw", type_hint: "int" });
        return this.runtime_property;
      }`,
      null
    );
    expect(propertyInstall.ok, JSON.stringify(propertyInstall)).toBe(true);
    const propertyInfoUpdate = installVerbAs(
      world,
      actor,
      "topo_box",
      "update_runtime_property_info",
      `verb :update_runtime_property_info() rxd {
        set_property_info(this, "runtime_property", { perms: "r", type_hint: "int" });
        return property_info(this, "runtime_property");
      }`,
      null
    );
    expect(propertyInfoUpdate.ok, JSON.stringify(propertyInfoUpdate)).toBe(true);
    const propertyDelete = installVerbAs(
      world,
      actor,
      "topo_box",
      "delete_runtime_property",
      `verb :delete_runtime_property() rxd {
        delete_property(this, "runtime_property");
        return true;
      }`,
      null
    );
    expect(propertyDelete.ok, JSON.stringify(propertyDelete)).toBe(true);
    // Genesis placement: the actor occupies the room (this also gives the
    // room partition its presence rows — genesis state, not under test).
    const placed = await world.directCall("topo-genesis-place", actor, actor, "moveto", ["topo_room"], { sessionId: session.id });
    expect(placed.op).toBe("result");
    const wizardSession = world.createSessionForActor("$wiz", "bearer");
    const wizardPlaced = await world.directCall(
      "topo-genesis-place-wizard",
      "$wiz",
      "$wiz",
      "moveto",
      ["topo_room"],
      { sessionId: wizardSession.id }
    );
    expect(wizardPlaced.op).toBe("result");

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
    const catalogAttestKeys: string[][] = [];
    const gatewayState = netState("gateway-topology");
    const gatewayEnv: NetGatewayEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        const scope = destination.startsWith("scope:") ? destination.slice("scope:".length) : null;
        const instance = scope !== null ? scopeDOs.get(scope) : undefined;
        if (!instance) throw new Error(`unexpected destination ${destination}`);
        return {
          fetch: async (request: Request) => {
            const path = new URL(request.url).pathname;
            rpcLog.push(`${destination}${path}`);
            // Force the first two read-only turns to overlap at the catalog
            // authority, proving the gateway coalesces an actual burst miss.
            if (destination === `scope:${CATALOG_SCOPE}` && path === "/net/attest") {
              const body = await request.clone().json() as { keys?: string[] };
              catalogAttestKeys.push([...(body.keys ?? [])]);
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return await instance.fetch(request);
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

    const peekRequest = (key: string) => ({
      call: { ...bump(key), verb: "catalog_peek" },
      planningScope: roomScope,
      catalog_epoch: EPOCH,
      idempotency_key: key
    });

    rpcLog.length = 0;
    const peeks = await Promise.all([
      call<TurnBody>(gateway, gatewayEnv, "/turn", peekRequest("topo-peek-1")),
      call<TurnBody>(gateway, gatewayEnv, "/turn", peekRequest("topo-peek-2"))
    ]);
    for (const peek of peeks) {
      expect(peek.reply.status, JSON.stringify(peek.reply)).toBe("accepted");
      expect(peek.result).toBe(1);
    }
    expect(
      rpcLog.filter((entry) => entry === `scope:${CATALOG_SCOPE}/net/attest`),
      JSON.stringify(catalogAttestKeys)
    ).toHaveLength(1);
    expect(rpcLog.filter((entry) => entry === `scope:${clusterScope}/net/attest`)).toHaveLength(2);

    // Runtime programmers may still edit user-owned noncatalog objects, but
    // installed catalog classes are epoch-immutable. Refuse before submit so
    // a mixed room/class write cannot mutate the class via rider adoption.
    rpcLog.length = 0;
    await expect(call<TurnBody>(gateway, gatewayEnv, "/turn", {
      call: {
        id: "topo-class-mutation",
        route: "direct",
        scope: roomScope,
        session: wizardSession.id,
        actor: "$wiz",
        target: "topo_box",
        verb: "mutate_catalog_class",
        args: []
      },
      planningScope: roomScope,
      catalog_epoch: EPOCH,
      idempotency_key: "topo-class-mutation"
    })).rejects.toThrow("E_CATALOG_MUTATION");
    expect(rpcLog).not.toContain(`scope:${roomScope}/net/submit`);
    await expect(call<TurnBody>(gateway, gatewayEnv, "/turn", {
      call: {
        id: "topo-class-property-mutation",
        route: "direct",
        scope: roomScope,
        session: wizardSession.id,
        actor: "$wiz",
        target: "topo_box",
        verb: "mutate_catalog_class_property",
        args: []
      },
      planningScope: roomScope,
      catalog_epoch: EPOCH,
      idempotency_key: "topo-class-property-mutation"
    })).rejects.toThrow("E_CATALOG_MUTATION");
    expect(rpcLog).not.toContain(`scope:${roomScope}/net/submit`);

    const runtimeRequest = (key: string, verb: string) => ({
      call: { ...bump(key), verb },
      planningScope: roomScope,
      catalog_epoch: EPOCH,
      idempotency_key: key
    });
    const runtimeCreated = await call<TurnBody>(
      gateway,
      gatewayEnv,
      "/turn",
      runtimeRequest("topo-runtime-create", "install_runtime_verb")
    );
    expect(runtimeCreated.reply.status).toBe("accepted");
    expect(runtimeCreated.reply.status === "accepted" && runtimeCreated.reply.touched)
      .toContain("verb_bytecode:topo_box:runtime_value");
    const runtimeValue = await call<TurnBody>(
      gateway,
      gatewayEnv,
      "/turn",
      runtimeRequest("topo-runtime-value", "runtime_value")
    );
    expect(runtimeValue.result).toBe(2);

    const runtimeRenamed = await call<TurnBody>(
      gateway,
      gatewayEnv,
      "/turn",
      runtimeRequest("topo-runtime-rename", "rename_runtime_verb")
    );
    expect(runtimeRenamed.reply.status).toBe("accepted");
    if (runtimeRenamed.reply.status === "accepted") {
      expect(runtimeRenamed.reply.touched).toEqual(expect.arrayContaining([
        "verb_bytecode:topo_box:runtime_value",
        "verb_bytecode:topo_box:runtime_renamed"
      ]));
    }
    const renamedValue = await call<TurnBody>(
      gateway,
      gatewayEnv,
      "/turn",
      runtimeRequest("topo-runtime-renamed-value", "runtime_renamed")
    );
    expect(renamedValue.result).toBe(2);

    const runtimeDeleted = await call<TurnBody>(
      gateway,
      gatewayEnv,
      "/turn",
      runtimeRequest("topo-runtime-delete", "delete_runtime_verb")
    );
    expect(runtimeDeleted.reply.status).toBe("accepted");
    expect(runtimeDeleted.reply.status === "accepted" && runtimeDeleted.reply.touched)
      .toContain("verb_bytecode:topo_box:runtime_renamed");

    const propertyCreated = await call<TurnBody>(
      gateway,
      gatewayEnv,
      "/turn",
      runtimeRequest("topo-property-create", "install_runtime_property")
    );
    expect(propertyCreated.result).toBe(7);
    expect(propertyCreated.reply.status === "accepted" && propertyCreated.reply.touched)
      .toContain("property_cell:topo_box:runtime_property");
    const propertyUpdated = await call<TurnBody>(
      gateway,
      gatewayEnv,
      "/turn",
      runtimeRequest("topo-property-info", "update_runtime_property_info")
    );
    expect(propertyUpdated.result).toMatchObject({ perms: "r", type_hint: "int" });
    expect(propertyUpdated.reply.status === "accepted" && propertyUpdated.reply.touched)
      .toContain("property_cell:topo_box:runtime_property");
    const propertyDeleted = await call<TurnBody>(
      gateway,
      gatewayEnv,
      "/turn",
      runtimeRequest("topo-property-delete", "delete_runtime_property")
    );
    expect(propertyDeleted.reply.status).toBe("accepted");
    expect(propertyDeleted.reply.status === "accepted" && propertyDeleted.reply.touched)
      .toContain("property_cell:topo_box:runtime_property");
    const propertyClosure = await call<{ cells: unknown[] }>(
      scopeDOs.get(roomScope) as NetScopeDO,
      scopeEnv,
      "/closure",
      { keys: ["property_cell:topo_box:runtime_property"], known: ["object_lineage:topo_box"] }
    );
    expect(propertyClosure.cells).toEqual([]);

    rpcLog.length = 0;
    catalogAttestKeys.length = 0;
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
    // The class-chain read is served by the exact-epoch cache populated by
    // the peeks, but topo_config is an arbitrary catalog-owned object and
    // therefore still attests live. Mutable actor cells do the same.
    expect(rpcLog.filter((entry) => entry === `scope:${CATALOG_SCOPE}/net/attest`)).toHaveLength(1);
    expect(catalogAttestKeys[0]).toContain("property_cell:topo_config:bonus");
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
    rpcLog.length = 0;
    catalogAttestKeys.length = 0;
    const turn2 = await call<TurnBody>(gateway, gatewayEnv, "/turn", turnRequest("topo-t2"));
    expect(turn2.reply.status, JSON.stringify(turn2.reply)).toBe("accepted");
    expect(turn2.attempt).toBe(1);
    expect(turn2.selection).toEqual({ scope: roomScope, riders: [clusterScope] });
    expect(turn2.result).toBe(2);
    expect(rpcLog.filter((entry) => entry === `scope:${CATALOG_SCOPE}/net/attest`)).toHaveLength(1);
    expect(catalogAttestKeys[0]).toContain("property_cell:topo_config:bonus");

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

    // A truncated multi-key authority response fails without publishing a
    // partial cache. The next attempt must request the complete same class
    // batch again, then succeeds from the unmodified authority response.
    const truncatedKeys: string[][] = [];
    const truncatedGatewayState = netState("gateway-topology-truncated-attest");
    const truncatedGatewayEnv: NetGatewayEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        const scope = destination.startsWith("scope:") ? destination.slice("scope:".length) : null;
        const instance = scope !== null ? scopeDOs.get(scope) : undefined;
        if (!instance) throw new Error(`unexpected truncated-gateway destination ${destination}`);
        return {
          fetch: async (request: Request) => {
            const path = new URL(request.url).pathname;
            if (destination !== `scope:${CATALOG_SCOPE}` || path !== "/net/attest") {
              return await instance.fetch(request);
            }
            const requestBody = await request.clone().json() as { keys?: string[] };
            truncatedKeys.push([...(requestBody.keys ?? [])]);
            const response = await instance.fetch(request);
            if (truncatedKeys.length !== 1) return response;
            const body = await response.json() as { cells?: unknown[] } & Record<string, unknown>;
            return new Response(JSON.stringify({ ...body, cells: (body.cells ?? []).slice(0, -1) }), {
              status: response.status,
              headers: { "content-type": "application/json" }
            });
          }
        };
      }
    };
    const truncatedGateway = new NetGatewayDO(truncatedGatewayState.state, truncatedGatewayEnv);
    for (const scope of [roomScope, clusterScope, CATALOG_SCOPE]) {
      await call(truncatedGateway, truncatedGatewayEnv, "/pull", { scope, destination: `scope:${scope}` });
    }
    await expect(call<TurnBody>(truncatedGateway, truncatedGatewayEnv, "/turn", peekRequest("topo-truncated-1")))
      .rejects.toThrow("catalog attestation omitted");
    const recovered = await call<TurnBody>(
      truncatedGateway,
      truncatedGatewayEnv,
      "/turn",
      peekRequest("topo-truncated-2")
    );
    expect(recovered.reply.status).toBe("accepted");
    expect(truncatedKeys).toHaveLength(2);
    expect(truncatedKeys[0]?.length).toBeGreaterThan(1);
    expect(truncatedKeys[1]).toEqual(truncatedKeys[0]);

    // A mismatched authority epoch fails closed and does not poison a fresh
    // gateway's cache: both attempts must reach the catalog owner and fail.
    const badRpcLog: string[] = [];
    const badGatewayState = netState("gateway-topology-wrong-epoch");
    const badGatewayEnv: NetGatewayEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        const scope = destination.startsWith("scope:") ? destination.slice("scope:".length) : null;
        const instance = scope !== null ? scopeDOs.get(scope) : undefined;
        if (!instance) throw new Error(`unexpected bad-gateway destination ${destination}`);
        return {
          fetch: async (request: Request) => {
            const path = new URL(request.url).pathname;
            badRpcLog.push(`${destination}${path}`);
            const response = await instance.fetch(request);
            if (destination !== `scope:${CATALOG_SCOPE}` || path !== "/net/attest") return response;
            const body = await response.json() as Record<string, unknown>;
            return new Response(JSON.stringify({ ...body, catalog_epoch: "wrong-epoch" }), {
              status: response.status,
              headers: { "content-type": "application/json" }
            });
          }
        };
      }
    };
    const badGateway = new NetGatewayDO(badGatewayState.state, badGatewayEnv);
    for (const scope of [roomScope, clusterScope, CATALOG_SCOPE]) {
      await call(badGateway, badGatewayEnv, "/pull", { scope, destination: `scope:${scope}` });
    }
    await expect(call<TurnBody>(badGateway, badGatewayEnv, "/turn", peekRequest("topo-bad-1")))
      .rejects.toThrow("E_EPOCH_MISMATCH");
    await expect(call<TurnBody>(badGateway, badGatewayEnv, "/turn", peekRequest("topo-bad-2")))
      .rejects.toThrow("E_EPOCH_MISMATCH");
    expect(badRpcLog.filter((entry) => entry === `scope:${CATALOG_SCOPE}/net/attest`)).toHaveLength(2);

    for (const st of doStates.values()) st.close();
    badGatewayState.close();
    truncatedGatewayState.close();
    gatewayState.close();
  });
});
