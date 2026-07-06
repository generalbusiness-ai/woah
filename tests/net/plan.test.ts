// planTurn — plan → submit → accept, and the mini repair loop:
// stale view → read_version_mismatch → refresh exactly the mismatched
// cells → re-plan → accept (coherence.md CO2.3/CO2.4/CO4/CO7; kickoff
// step 8 harness). This loop is the foundation of the CO12.4
// differential gate.
import { describe, expect, it } from "vitest";
import { installVerb } from "../../src/core/authoring";
import { createWorld } from "../../src/core/bootstrap";
import { cellsFromSerialized, storeCells } from "../../src/net/bridge";
import { CellStore } from "../../src/net/cells";
import { planTurn, WARM_ENVELOPE_BYTE_LIMIT } from "../../src/net/plan";
import type { ScopeClassifier } from "../../src/net/route";
import { ScopeSequencer } from "../../src/net/scope";
import { netCellKeyFor } from "../../src/net/transcript";
import type { ShadowTurnCall } from "../../src/net/bridge";

const SCOPE = "home";
const EPOCH = "cat1";

// Phase-2 fixed assignment: every object anchors to the one shared scope
// the test sequencer owns (route.ts selection still runs for real).
const classifier: ScopeClassifier = {
  scopeOf: () => SCOPE,
  isShared: (scope) => scope === SCOPE
};

/** Bootstrap world + authored read-modify-write verb (the
 * tests/shadow-turn-exec.test.ts pattern), plus the authority sequencer
 * seeded from the exported world's cells. */
function harness(tag: string) {
  const world = createWorld();
  const session = world.auth(`guest:plan-${tag}`);
  const actor = session.actor;
  world.createObject({ id: "plan_box", name: "Plan Box", parent: "$thing", owner: actor });
  world.defineProperty("plan_box", { name: "counter", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
  const installed = installVerb(
    world,
    "plan_box",
    "bump",
    `verb :bump() rxd {
      let before = this.counter;
      this.counter = before + 1;
      return this.counter;
    }`,
    null
  );
  expect(installed.ok).toBe(true);

  const seq = new ScopeSequencer(SCOPE, EPOCH);
  seq.seed(cellsFromSerialized(world.exportWorld()));

  const call = (id: string): ShadowTurnCall => ({
    kind: "woo.turn_call.shadow.v1",
    id,
    route: "direct",
    scope: SCOPE,
    session: session.id,
    actor,
    target: "plan_box",
    verb: "bump",
    args: []
  });
  return { seq, call, actor, session };
}

/** A gateway planning view: a derived read-through of current authority. */
function derivedViewOf(authority: CellStore): CellStore {
  const view = new CellStore("derived");
  for (const cell of storeCells(authority)) view.install(cell);
  return view;
}

describe("planTurn → submit → accept (CO4 happy path)", () => {
  it("plans on a fresh view, commits, and updates authority", async () => {
    const { seq, call } = harness("accept");
    const view = derivedViewOf(seq.store);

    const plan = await planTurn({
      call: call("plan-accept-1"),
      view,
      planningScope: SCOPE,
      classifier,
      base: seq.head(),
      idempotencyKey: "k1",
      stamp: seq.stamp()
    });

    // route.ts picked the single write scope; the submit targets it.
    expect(plan.selection).toEqual({ scope: SCOPE, riders: [] });
    expect(plan.submit.scope).toBe(SCOPE);
    expect(plan.transcript.scope).toBe(SCOPE);
    // Every validated read carries a view version, never an engine counter.
    for (const read of plan.transcript.reads) {
      if (netCellKeyFor(read.cell) === null) continue;
      expect(read.version === "absent" || typeof read.version === "string").toBe(true);
    }
    // CO7 warm envelope stays under the ceiling and is accounted.
    expect(plan.envelopeBytes).toBeGreaterThan(0);
    expect(plan.envelopeBytes).toBeLessThan(WARM_ENVELOPE_BYTE_LIMIT);

    const reply = seq.submit(plan.submit);
    expect(reply.status).toBe("accepted");
    if (reply.status !== "accepted") return;
    expect(reply.head.seq).toBe(1);
    expect(reply.post_state_version).toBe(plan.submit.post_state_version);
    // Authority holds the {value, def} payload the planner predicted.
    expect(seq.store.get("property_cell:plan_box:counter")?.value).toMatchObject({ value: 1 });
  });
});

describe("the mini repair loop (CO2.4 + CO6 E_READ_VERSION semantics)", () => {
  it("stale view rejects with mismatched_reads; refreshing exactly those cells converges", async () => {
    const { seq, call } = harness("repair");

    // The view under test, installed at head 0.
    const staleView = derivedViewOf(seq.store);

    // Turn 1 from this view: accepted (counter 0 → 1).
    const plan1 = await planTurn({
      call: call("plan-repair-1"), view: staleView, planningScope: SCOPE, classifier,
      base: seq.head(), idempotencyKey: "k1", stamp: seq.stamp()
    });
    expect(seq.submit(plan1.submit).status).toBe("accepted");

    // Turn 2 "from elsewhere": a fresh view of current authority moves
    // the world on (counter 1 → 2). staleView still holds counter 0.
    const elsewhere = derivedViewOf(seq.store);
    const plan2 = await planTurn({
      call: call("plan-repair-2"), view: elsewhere, planningScope: SCOPE, classifier,
      base: seq.head(), idempotencyKey: "k2", stamp: seq.stamp()
    });
    expect(seq.submit(plan2.submit).status).toBe("accepted");
    expect(seq.store.get("property_cell:plan_box:counter")?.value).toMatchObject({ value: 2 });

    // Turn 3 against the now-stale view: current base, stale read set →
    // retryable read_version_mismatch naming exactly the stale cells.
    const plan3 = await planTurn({
      call: call("plan-repair-3"), view: staleView, planningScope: SCOPE, classifier,
      base: seq.head(), idempotencyKey: "k3", stamp: seq.stamp()
    });
    const rejected = seq.submit(plan3.submit);
    expect(rejected.status).toBe("rejected");
    if (rejected.status !== "rejected") return;
    expect(rejected.reason).toBe("read_version_mismatch");
    expect(rejected.retryable).toBe(true);
    expect(rejected.mismatched_reads).toEqual([{ kind: "prop", object: "plan_box", name: "counter" }]);

    // Repair: refresh EXACTLY the mismatched cells from authority (the
    // structured repair input — never a whole-view reseed).
    for (const cell of rejected.mismatched_reads ?? []) {
      const key = netCellKeyFor(cell);
      expect(key).not.toBeNull();
      const fresh = seq.store.get(key as string);
      expect(fresh).toBeDefined();
      staleView.install(fresh as NonNullable<typeof fresh>);
    }

    // Re-plan the same turn (same idempotency key: the retryable
    // rejection was not recorded, so the retry validates fresh).
    const plan3b = await planTurn({
      call: call("plan-repair-3b"), view: staleView, planningScope: SCOPE, classifier,
      base: seq.head(), idempotencyKey: "k3", stamp: seq.stamp()
    });
    const accepted = seq.submit(plan3b.submit);
    expect(accepted.status).toBe("accepted");
    // The repaired plan executed against refreshed state: 2 → 3, not 0 → 1.
    expect(seq.store.get("property_cell:plan_box:counter")?.value).toMatchObject({ value: 3 });
  });
});

describe("envelope byte gates (CO7/CO10)", () => {
  it("an oversized warm read-closure is a plain misplan Error, not a NetError", async () => {
    const world = createWorld();
    const session = world.auth("guest:plan-bytes");
    const actor = session.actor;
    world.createObject({ id: "blob_box", name: "Blob Box", parent: "$thing", owner: actor });
    // A single property page bigger than the warm ceiling: any read
    // closure carrying it must trip the plan-time gate.
    world.defineProperty("blob_box", {
      name: "blob",
      defaultValue: "x".repeat(WARM_ENVELOPE_BYTE_LIMIT + 1024),
      owner: actor,
      perms: "rw",
      typeHint: "str"
    });
    const installed = installVerb(world, "blob_box", "read_blob", `verb :read_blob() rxd { return this.blob; }`, null);
    expect(installed.ok).toBe(true);

    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seq.seed(cellsFromSerialized(world.exportWorld()));
    const view = derivedViewOf(seq.store);

    await expect(planTurn({
      call: {
        kind: "woo.turn_call.shadow.v1",
        id: "plan-bytes-1",
        route: "direct",
        scope: SCOPE,
        session: session.id,
        actor,
        target: "blob_box",
        verb: "read_blob",
        args: []
      },
      view,
      planningScope: SCOPE,
      classifier,
      base: seq.head(),
      idempotencyKey: "kb",
      stamp: seq.stamp()
    })).rejects.toThrow(/oversized warm envelope/);
  });
});

describe("plan-time snapshot (fix 6: the version-laundering window)", () => {
  it("reads carry the versions the execution saw, not versions installed into the view mid-plan", async () => {
    const { seq, call } = harness("snapshot");
    const view = derivedViewOf(seq.store);
    const key = "property_cell:plan_box:counter";
    const snapshotVersion = view.get(key)?.version;
    expect(snapshotVersion).toBeDefined();

    // Start the plan. planTurn snapshots the view SYNCHRONOUSLY before
    // its first await, so a mutation right after the call lands inside
    // the await window — exactly where a concurrent fanout/refresh would
    // interleave on a real gateway.
    const pending = planTurn({
      call: call("plan-snap-1"),
      view,
      planningScope: SCOPE,
      classifier,
      base: seq.head(),
      idempotencyKey: "ksnap",
      stamp: seq.stamp()
    });
    const midPlan = view.get(key) as NonNullable<ReturnType<typeof view.get>>;
    view.install({ ...midPlan, value: { value: 999 }, version: "laundered-version" });

    const plan = await pending;
    const counterReads = plan.transcript.reads.filter(
      (read) => read.cell.kind === "prop" && read.cell.object === "plan_box" && read.cell.name === "counter"
    );
    expect(counterReads.length).toBeGreaterThanOrEqual(1);
    for (const read of counterReads) {
      // The snapshot version — NOT the mid-plan install. Were the live
      // view consulted here, a stale plan would sail past the scope's
      // read-version check wearing versions its execution never saw.
      expect(read.version).toBe(snapshotVersion);
      expect(read.version).not.toBe("laundered-version");
    }

    // The plan itself is still honest end-to-end: the authority (which
    // did NOT move) accepts it.
    expect(seq.submit(plan.submit).status).toBe("accepted");
  });
});
