// Phase 0 — the `load:net-dev` asymptotic gate (plan invariant).
//
// The ready-to-scale bar: a warm turn's cost must track the turn's
// READ-SET, not the resident view. This lane drives the SAME turn against
// two scopes — a small world and a large one padded with cells the turn
// never touches — and asserts the CO10 invariant that `plan_cells` (the
// exact array fed to planningWorldFromCells) stays flat as the view grows.
//
// STATUS: RED until Phase 1 (slice-based planning). Today planning clones
// the whole view (plan.ts), so plan_cells ~ view size and the delta below
// blows past the tolerance — that failure IS the documented baseline. This
// file is its own lane (`npm run load:net-dev`), NOT in the curated `npm
// test`, precisely so the red baseline does not break the inner loop.
// Phase 1 flips it green; only then does it join the pre-deploy gate.
//
// In-process is faithful for THIS invariant: plan cost is pure planner CPU,
// identical under fake-DO and workerd. Later phases extend the lane with
// workerd fidelity for the closure-bytes / outbox-drain invariants (which
// do depend on real RPC).
import { describe, expect, it } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { installVerb } from "../../src/core/authoring";
import { createWorld } from "../../src/core/bootstrap";
import { cellsFromSerialized, type ShadowTurnCall } from "../../src/net/bridge";
import type { CommitReply } from "../../src/net/scope";

const SECRET = "net-load-asymptote-secret";
const EPOCH = "cat-net-load-1";
const SCOPE = "flat";

function netState(name: string): { state: NetScopeDurableState & NetGatewayDurableState; close: () => void } {
  const fake = new FakeDurableObjectState(name);
  const state = {
    id: fake.id,
    waitUntil: (_p: Promise<unknown>) => {},
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
  attempt: number;
  sync_rpc: number;
  reconstructions: number;
  plan_cells: number;
  snapshot_cells: number;
};
type TurnBody = { reply: CommitReply; structure?: TurnStructureReport };

/** Build a one-scope world with `unrelated` extra objects the turn never
 * touches, flatten it into one scope, and run a single warm bump turn.
 * Returns the turn's CO10 structure. */
async function warmTurnStructure(unrelated: number): Promise<TurnStructureReport> {
  const world = createWorld();
  const session = world.auth("guest:net-load");
  const actor = session.actor;
  world.createObject({ id: "load_room", name: "Load Room", parent: "$space", owner: actor });
  world.createObject({ id: "load_box", name: "Load Box", parent: "$thing", owner: actor, anchor: "load_room", location: "load_room" });
  world.defineProperty("load_box", { name: "counter", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
  const installed = installVerb(
    world,
    "load_box",
    "bump",
    `verb :bump() rxd {
      this.counter = this.counter + 1;
      observe({ type: "bumped", counter: this.counter });
      return this.counter;
    }`,
    null
  );
  expect(installed.ok).toBe(true);
  // Padding: objects the bump turn never reads — pure view weight.
  for (let i = 0; i < unrelated; i++) {
    world.createObject({ id: `load_pad_${i}`, name: `Pad ${i}`, parent: "$thing", owner: actor, anchor: "load_room", location: "load_room" });
    world.defineProperty(`load_pad_${i}`, { name: "n", defaultValue: i, owner: actor, perms: "rw", typeHint: "int" });
  }
  const placed = await world.directCall("load-genesis", actor, actor, "moveto", ["load_room"], { sessionId: session.id });
  expect(placed.op).toBe("result");

  const cells = cellsFromSerialized(world.exportWorld());
  const scopeState = netState(`scope-${unrelated}`);
  const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET };
  const scopeDO = new NetScopeDO(scopeState.state, scopeEnv);
  await call(scopeDO, scopeEnv, "/seed", { scope: SCOPE, catalog_epoch: EPOCH, cells });

  const gatewayState = netState(`gateway-${unrelated}`);
  const gatewayEnv: NetGatewayEnv = {
    WOO_INTERNAL_SECRET: SECRET,
    NET_RESOLVE: (destination) => {
      if (destination !== `scope:${SCOPE}`) throw new Error(`unexpected destination ${destination}`);
      return scopeDO;
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
    target: "load_box",
    verb: "bump",
    args: []
  });
  const turnRequest = (key: string) => ({
    call: bump(key),
    planningScope: SCOPE,
    catalog_epoch: EPOCH,
    idempotency_key: key,
    shared: [SCOPE],
    scopes: { [SCOPE]: `scope:${SCOPE}` }
  });

  // Warm the view with one accepted turn, then measure the second.
  await call<TurnBody>(gateway, gatewayEnv, "/turn", turnRequest(`load-warm-${unrelated}`));
  const measured = await call<TurnBody>(gateway, gatewayEnv, "/turn", turnRequest(`load-measure-${unrelated}`));
  expect(measured.reply.status, JSON.stringify(measured.reply)).toBe("accepted");
  const structure = measured.structure;
  expect(structure, "TurnResult must carry the plan_cells structure").toBeTruthy();
  scopeState.close();
  gatewayState.close();
  return structure as TurnStructureReport;
}

describe("load:net-dev — plan-cost asymptotic invariant", () => {
  // How many extra unrelated cells the large world carries beyond the
  // small one. Each padding object contributes several cells (live,
  // lineage, property), so the large view is hundreds of cells heavier
  // while the bump turn's read-set is unchanged.
  const PAD = 300;
  // A warm turn plans against its read-set (a handful of cells) plus the
  // shared substrate seed; the padding must add ~nothing. Generous slack
  // over the fixed base; the point is FLAT vs view size, not an exact N.
  const FLAT_TOLERANCE = 32;

  it("plan_cells stays flat as the view grows (turn cost ~ read-set, not O(view))", async () => {
    const small = await warmTurnStructure(0);
    const large = await warmTurnStructure(PAD);

    // Both warm: 1 attempt, no reconstructions.
    expect(small.attempt).toBe(1);
    expect(large.attempt).toBe(1);
    expect(large.reconstructions).toBe(0);
    // Warm sync-RPC flat (CO10 ≤ 3), independent of view size.
    expect(large.sync_rpc).toBe(small.sync_rpc);

    // THE INVARIANT: the padding cells the turn never reads must not enter
    // the plan. RED until Phase 1 (today plan_cells ~ total view size, so
    // the delta ≈ PAD*cells-per-object and this fails — the baseline).
    const delta = large.plan_cells - small.plan_cells;
    expect(
      delta,
      `plan_cells grew by ${delta} when ${PAD} unrelated objects were added ` +
        `(small=${small.plan_cells}, large=${large.plan_cells}); a warm turn must plan ` +
        `against its read-set, not the resident view. RED until Phase 1 slice planning.`
    ).toBeLessThanOrEqual(FLAT_TOLERANCE);
  });

  // Blocker #1 (closed): plan_cells being flat proves the planner INPUT is
  // sliced; this asserts the fix-6 SNAPSHOT is flat too — the warm turn's
  // clone, scratch post-state, version rewrite, read closure and catalog
  // classification all operate on the seed slice (view-index-backed
  // slice-clone), so NO per-turn pass over the resident view remains. A
  // regression that reintroduces an O(view) snapshot (e.g. a full clone
  // sneaking back into the slice path) turns this red.
  it("snapshot_cells stays flat as the view grows (the whole warm turn is O(read-set), not just the planner input)", async () => {
    const small = await warmTurnStructure(0);
    const large = await warmTurnStructure(PAD);
    const delta = large.snapshot_cells - small.snapshot_cells;
    expect(
      delta,
      `snapshot_cells grew by ${delta} (small=${small.snapshot_cells}, large=${large.snapshot_cells}); ` +
        `the warm turn is cloning/scanning the whole view again (blocker #1 regression).`
    ).toBeLessThanOrEqual(FLAT_TOLERANCE);
  });
});
