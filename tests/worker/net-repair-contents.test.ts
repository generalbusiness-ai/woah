// Aged-world repair for contents rows that were never derived
// (spec/protocol/coherence.md CO13).
//
// Before the create-time derivation landed, `object_create` recorded placement
// inline — no move, no contents projection write — so an object minted directly
// INTO a container produced no relation delta at all. Its `object_live.location`
// is correct and its membership row simply does not exist. Bundled catalogs
// create that way routinely, so namespaces that ran before the fix carry the
// gap and cannot heal by replaying the fix.
//
// The aged state is modelled exactly: seed a scope's CELLS with an explicitly
// empty relation family, which is what such a world looks like on disk.
//
// Asserted here: bounded local reconstruction (each scope reads only its OWN
// cells), head advance + refan of newly added rows, cross-scope membership over
// the ordinary /net/relate lane, add-only (a row whose member lives elsewhere
// survives), second-run no-op, and a COLD gateway seeing the repaired
// membership through its own pull.
import { describe, expect, it } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import type { ScopeHead } from "../../src/net/scope";

const SECRET = "net-repair-contents-secret";
const EPOCH = "cat-repair-contents-1";

const ROOM = "room:the_hall";
const CLUSTER = "cluster:alice";

function netState(name: string) {
  const fake = new FakeDurableObjectState(name);
  const deferred: Array<Promise<unknown>> = [];
  const state: NetScopeDurableState & NetGatewayDurableState = {
    id: fake.id,
    waitUntil: (promise: Promise<unknown>) => { deferred.push(promise); },
    storage: {
      sql: fake.storage.sql,
      transactionSync: fake.storage.transactionSync,
      setAlarm: () => {},
      deleteAlarm: () => {}
    }
  };
  return {
    state,
    settle: async () => { while (deferred.length > 0) await deferred.shift(); },
    close: () => fake.close()
  };
}

type Fetchable = { fetch(request: Request): Promise<Response> | Response };

async function call<T>(target: Fetchable, route: string, body?: unknown): Promise<T> {
  const url = `https://do/net${route}`;
  const request = body === undefined
    ? new Request(url)
    : new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const signed = await signInternalRequest({ WOO_INTERNAL_SECRET: SECRET }, request);
  const response = await target.fetch(signed);
  const decoded = (await response.json()) as T & { error?: unknown };
  if (!response.ok) throw new Error(`call ${route} failed: ${JSON.stringify(decoded)}`);
  return decoded;
}

const lineage = (object: string, parent: string | null, anchor: string | null = null) => ({
  kind: "object_lineage" as const,
  object,
  value: { parent, owner: "$wiz", name: object, anchor, flags: {} }
});
const live = (object: string, location: string | null) => ({
  kind: "object_live" as const,
  object,
  value: { location }
});

type RepairReply = {
  status: string;
  head: ScopeHead;
  changed: string[];
  candidates: number;
  local: number;
  foreign: number;
  unplaced: string[];
};
type RelationRead = { members: Array<{ member: string; body?: unknown }> };
type ClosureReply = { relations?: Array<{ relation: string; owner: string; member: string }> };

/** A scope's own relation family. `/net/relation` is a GATEWAY read; an
 * authority reports its rows on a full closure. */
async function contentsAt(target: Fetchable, owner: string): Promise<string[]> {
  const closure = await call<ClosureReply>(target, "/closure", { keys: [], relations: true });
  return (closure.relations ?? [])
    .filter((row) => row.relation === "contents" && row.owner === owner)
    .map((row) => row.member)
    .sort();
}

describe("aged-world contents repair (CO13)", () => {
  it("reconstructs local rows from the scope's own cells, advances the head, and no-ops on a second run", async () => {
    const room = netState(`scope-${ROOM}`);
    const scope = new NetScopeDO(room.state, { WOO_INTERNAL_SECRET: SECRET } as NetScopeEnv);

    // The aged world: cells are correct, the relation family is empty.
    await call(scope, "/seed", {
      scope: ROOM,
      catalog_epoch: EPOCH,
      cells: [
        lineage("the_hall", "$space"),
        lineage("task_1", "$task", "the_hall"),
        live("task_1", "the_hall"),
        lineage("task_2", "$task", "the_hall"),
        live("task_2", "the_hall")
      ],
      relations: []
    });
    const before = (await call<{ head: ScopeHead }>(scope, "/head")).head;
    expect(await contentsAt(scope, "the_hall")).toEqual([]);

    // A dry run reports without mutating — an operator can size the repair first.
    const planned = await call<RepairReply>(scope, "/repair-contents", { dry_run: true });
    expect(planned.local).toBe(2);
    expect(planned.changed).toEqual([]);
    expect((await call<{ head: ScopeHead }>(scope, "/head")).head).toEqual(before);

    const repaired = await call<RepairReply>(scope, "/repair-contents", {});
    expect(repaired.status).toBe("applied");
    expect(repaired.changed.sort()).toEqual([
      "relation:contents:the_hall:task_1",
      "relation:contents:the_hall:task_2"
    ]);
    expect(repaired.unplaced).toEqual([]);
    expect(repaired.head.seq).toBe(before.seq + 1);
    expect(await contentsAt(scope, "the_hall")).toEqual(["task_1", "task_2"]);

    // Idempotent: add-only means the second run finds nothing to change, so it
    // advances no head and refans nothing.
    const again = await call<RepairReply>(scope, "/repair-contents", {});
    expect(again.status).toBe("empty");
    expect(again.changed).toEqual([]);
    expect(again.head).toEqual(repaired.head);
    expect(await contentsAt(scope, "the_hall")).toHaveLength(2);

    room.close();
  });

  it("is add-only: a row whose member lives at another scope survives the repair", async () => {
    // This is why the repair cannot reuse the full rebuild. A row this scope
    // OWNS may describe a member anchored elsewhere (delivered by /net/relate),
    // and a local cell scan cannot see it — rebuilding would delete it.
    const room = netState(`scope-${ROOM}-addonly`);
    const scope = new NetScopeDO(room.state, { WOO_INTERNAL_SECRET: SECRET } as NetScopeEnv);
    const foreignRow = { relation: "contents", owner: "the_hall", member: "visitor_from_elsewhere" };
    await call(scope, "/seed", {
      scope: ROOM,
      catalog_epoch: EPOCH,
      cells: [lineage("the_hall", "$space"), lineage("task_1", "$task", "the_hall"), live("task_1", "the_hall")],
      relations: [foreignRow]
    });

    const repaired = await call<RepairReply>(scope, "/repair-contents", {});
    expect(repaired.changed).toEqual(["relation:contents:the_hall:task_1"]);
    expect(await contentsAt(scope, "the_hall")).toEqual(["task_1", "visitor_from_elsewhere"]);

    room.close();
  });

  it("delivers cross-scope membership over /net/relate, and reports an owner it cannot place", async () => {
    const room = netState(`scope-${ROOM}-cross`);
    const cluster = netState(`scope-${CLUSTER}-cross`);
    let roomDO: NetScopeDO;
    const resolve = (destination: string) => {
      if (destination === `scope:${ROOM}`) return roomDO;
      throw new Error(`unexpected destination ${destination}`);
    };
    const env: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve };
    roomDO = new NetScopeDO(room.state, env);
    const clusterDO = new NetScopeDO(cluster.state, env);

    await call(roomDO, "/seed", {
      scope: ROOM,
      catalog_epoch: EPOCH,
      cells: [lineage("the_hall", "$space")],
      relations: []
    });
    // alice's cluster holds the MEMBER's cells; the container is the room's.
    await call(clusterDO, "/seed", {
      scope: CLUSTER,
      catalog_epoch: EPOCH,
      cells: [lineage("alice", "$actor"), lineage("widget", "$thing", "alice"), live("widget", "the_hall")],
      relations: []
    });

    // Anchor topology is not scope knowledge. Without a mapping the owner is
    // REPORTED, never guessed — and nothing is written anywhere.
    const unmapped = await call<RepairReply>(clusterDO, "/repair-contents", {});
    expect(unmapped.unplaced).toEqual(["the_hall"]);
    expect(unmapped.changed).toEqual([]);
    expect(await contentsAt(roomDO, "the_hall")).toEqual([]);

    // With the mapping the row rides the ordinary /net/relate lane to its owner.
    const mapped = await call<RepairReply>(clusterDO, "/repair-contents", {
      owner_scopes: { the_hall: ROOM }
    });
    expect(mapped.unplaced).toEqual([]);
    expect(mapped.foreign).toBe(1);
    await cluster.settle();
    await clusterDO.alarm();
    await cluster.settle();

    expect(await contentsAt(roomDO, "the_hall")).toEqual(["widget"]);

    // The owner's receiver gate makes redelivery a no-op.
    const roomHead = (await call<{ head: ScopeHead }>(roomDO, "/head")).head;
    await call<RepairReply>(clusterDO, "/repair-contents", { owner_scopes: { the_hall: ROOM } });
    await cluster.settle();
    await clusterDO.alarm();
    await cluster.settle();
    expect((await call<{ head: ScopeHead }>(roomDO, "/head")).head).toEqual(roomHead);
    expect(await contentsAt(roomDO, "the_hall")).toHaveLength(1);

    room.close();
    cluster.close();
  });

  it("lands the same rows a create-time derivation would have produced", async () => {
    // The repair's contract is equivalence, not best effort: an aged scope
    // repaired from its cells must end up with exactly the contents family a
    // scope that had the create-time derivation all along would hold. Derive
    // the expected family from the same authority cells through the
    // derivation-side helper, and compare.
    const { rebuildContentsRelation } = await import("../../src/net/relations");
    const cells = [
      lineage("the_hall", "$space"),
      lineage("task_1", "$task", "the_hall"),
      live("task_1", "the_hall"),
      lineage("note_1", "$note", "the_hall"),
      live("note_1", "the_hall"),
      // An object in no container contributes no membership either way.
      lineage("loose", "$thing", "the_hall"),
      live("loose", null)
    ];
    const expected = [...rebuildContentsRelation(
      cells.map((cell) => ({ ...cell, stamp: { scope_head: "x", catalog_epoch: EPOCH } })) as never,
      ROOM
    ).values()]
      .filter((row) => row.owner === "the_hall")
      .map((row) => row.member)
      .sort();

    const room = netState(`scope-${ROOM}-equiv`);
    const scope = new NetScopeDO(room.state, { WOO_INTERNAL_SECRET: SECRET } as NetScopeEnv);
    await call(scope, "/seed", { scope: ROOM, catalog_epoch: EPOCH, cells, relations: [] });
    await call<RepairReply>(scope, "/repair-contents", {});

    expect(await contentsAt(scope, "the_hall")).toEqual(expected);
    expect(expected).toEqual(["note_1", "task_1"]);
    room.close();
  });

  it("a COLD gateway sees the repaired membership through its own pull", async () => {
    const room = netState(`scope-${ROOM}-cold`);
    const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET };
    const scope = new NetScopeDO(room.state, scopeEnv);
    await call(scope, "/seed", {
      scope: ROOM,
      catalog_epoch: EPOCH,
      cells: [lineage("the_hall", "$space"), lineage("task_1", "$task", "the_hall"), live("task_1", "the_hall")],
      relations: []
    });
    await call<RepairReply>(scope, "/repair-contents", {});

    // A gateway that has never seen this scope — no fanout was delivered to it,
    // so only its own closure pull can carry the repaired family.
    const gatewayState = netState("gateway-repair-contents-cold");
    const gatewayEnv: NetGatewayEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        if (destination === `scope:${ROOM}`) return scope;
        throw new Error(`unexpected destination ${destination}`);
      }
    };
    const gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);
    expect((await call<RelationRead>(gateway, "/relation?relation=contents&owner=the_hall")).members).toEqual([]);

    await call(gateway, "/pull", { scope: ROOM, destination: `scope:${ROOM}` });
    expect(
      (await call<RelationRead>(gateway, "/relation?relation=contents&owner=the_hall")).members.map((m) => m.member)
    ).toEqual(["task_1"]);

    gatewayState.close();
    room.close();
  });
});
