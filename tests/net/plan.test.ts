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

describe("compact room-roster planning", () => {
  it("renders 30 occupants from one transient value without per-actor closure cells", async () => {
    const world = createWorld();
    const session = world.auth("guest:compact-roster");
    const cells = cellsFromSerialized(world.exportWorld());
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seq.seed(cells);
    const view = derivedViewOf(seq.store);
    const now = Date.now();
    const room = (view.get(`object_live:${session.actor}`)?.value as { location?: string }).location ?? "$nowhere";
    const roomName = (view.get(`object_lineage:${room}`)?.value as { name?: string } | undefined)?.name ?? room;
    const rows = Array.from({ length: 30 }, (_, index) => ({
      player: `guest_${index}`,
      name: `Guest ${index}`,
      connected: true,
      connected_at: now - 5_000,
      connected_seconds: 5,
      idle_seconds: 0,
      last_login_at: now - 5_000,
      location: room,
      location_name: roomName,
      presence: "awake"
    }));
    const plan = await planTurn({
      call: {
        kind: "woo.turn_call.shadow.v1",
        id: "compact-roster-30",
        route: "direct",
        scope: SCOPE,
        session: session.id,
        actor: session.actor,
        target: session.actor,
        verb: "who_all",
        args: []
      },
      view,
      planningScope: SCOPE,
      classifier,
      base: seq.head(),
      idempotencyKey: "compact-roster-30",
      stamp: seq.stamp(),
      planningRoomRoster: { room, rows }
    });

    expect(plan.transcript.result).toHaveLength(30);
    expect(plan.transcript.result).toEqual(expect.arrayContaining([
      expect.objectContaining({ player: "guest_0", name: "Guest 0" }),
      expect.objectContaining({ player: "guest_29", name: "Guest 29" })
    ]));
    expect(plan.envelopeBytes).toBeLessThan(WARM_ENVELOPE_BYTE_LIMIT);
    expect(plan.transcript.reads.some((read) => read.cell.object.startsWith("guest_"))).toBe(false);

    // The chat catalog adapter used by enter/who/look preserves its stable
    // presentation shape while consuming the same one transient value.
    const roomRosterPlan = await planTurn({
      call: {
        kind: "woo.turn_call.shadow.v1",
        id: "compact-chat-roster-30",
        route: "direct",
        scope: SCOPE,
        session: session.id,
        actor: session.actor,
        target: room,
        verb: "room_roster",
        args: []
      },
      view,
      planningScope: SCOPE,
      classifier,
      base: seq.head(),
      idempotencyKey: "compact-chat-roster-30",
      stamp: seq.stamp(),
      planningRoomRoster: { room, rows }
    });
    expect(roomRosterPlan.transcript.result).toHaveLength(30);
    expect(roomRosterPlan.transcript.result).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "guest_0", name: "Guest 0", presence: "awake" }),
      expect.objectContaining({ id: "guest_29", name: "Guest 29", presence: "awake" })
    ]));
    expect(roomRosterPlan.envelopeBytes).toBeLessThan(WARM_ENVELOPE_BYTE_LIMIT);
    expect(roomRosterPlan.transcript.reads.some((read) => read.cell.object.startsWith("guest_"))).toBe(false);
  });

  it.each([
    ["pinboard", "the_pinboard"],
    ["outliner", "the_outline"],
    ["dubspace", "the_dubspace"]
  ])("renders the complete compact roster through the %s catalog adapter", async (_catalog, room) => {
    const world = createWorld();
    const session = world.auth(`guest:compact-${_catalog}`);
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seq.seed(cellsFromSerialized(world.exportWorld()));
    const view = derivedViewOf(seq.store);
    const rows = Array.from({ length: 30 }, (_, index) => ({
      player: `remote_${index}`,
      name: `Remote ${index}`,
      connected: true,
      connected_at: 1_000,
      connected_seconds: 5,
      idle_seconds: index,
      last_login_at: 1_000,
      location: room,
      location_name: room,
      presence: "awake"
    }));

    const plan = await planTurn({
      call: {
        kind: "woo.turn_call.shadow.v1",
        id: `compact-${_catalog}-roster`,
        route: "direct",
        scope: SCOPE,
        session: session.id,
        actor: session.actor,
        target: room,
        verb: "room_roster",
        args: []
      },
      view,
      planningScope: SCOPE,
      classifier,
      base: seq.head(),
      idempotencyKey: `compact-${_catalog}-roster`,
      stamp: seq.stamp(),
      planningRoomRoster: { room, rows }
    });

    expect(plan.transcript.result).toHaveLength(30);
    expect(plan.transcript.result).toEqual(expect.arrayContaining([
      { id: "remote_0", name: "Remote 0", presence: "awake", idle_seconds: 0 },
      { id: "remote_29", name: "Remote 29", presence: "awake", idle_seconds: 29 }
    ]));
    expect(plan.transcript.reads.some((read) => read.cell.object.startsWith("remote_"))).toBe(false);
  });

  it("fails loudly when sparse net planning reaches room_roster without its owner projection", async () => {
    const world = createWorld();
    const session = world.auth("guest:compact-roster-metadata-miss");
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seq.seed(cellsFromSerialized(world.exportWorld()));

    const plan = await planTurn({
      call: {
        kind: "woo.turn_call.shadow.v1",
        id: "compact-roster-metadata-miss",
        route: "direct",
        scope: SCOPE,
        session: session.id,
        actor: session.actor,
        target: "the_chatroom",
        verb: "room_roster",
        args: []
      },
      view: derivedViewOf(seq.store),
      planningScope: SCOPE,
      classifier,
      base: seq.head(),
      idempotencyKey: "compact-roster-metadata-miss",
      stamp: seq.stamp()
    });

    expect(plan.transcript.result).toBeUndefined();
    expect(plan.transcript.error).toMatchObject({
      code: "E_INTERNAL",
      message: "sparse planning room roster projection missing for the_chatroom"
    });
  });

  it("uses the complete compact roster when pruning outliner per-actor state", async () => {
    const world = createWorld();
    const session = world.auth("guest:compact-outliner-focus");
    world.sessions.get(session.id)!.activeScope = "the_outline";
    world.object(session.actor).location = "the_outline";
    world.object("the_outline").contents.add(session.actor);
    world.setProp("the_outline", "focus_by_actor", {
      remote_present: null,
      remote_stale: null
    });
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seq.seed(cellsFromSerialized(world.exportWorld()));
    const rows = [session.actor, "remote_present"].map((player) => ({
      player,
      name: player,
      connected: true,
      connected_at: 1_000,
      connected_seconds: 5,
      idle_seconds: 0,
      last_login_at: 1_000,
      location: "the_outline",
      location_name: "The Outline",
      presence: "awake"
    }));

    const plan = await planTurn({
      call: {
        kind: "woo.turn_call.shadow.v1",
        id: "compact-outliner-focus",
        route: "direct",
        scope: SCOPE,
        session: session.id,
        actor: session.actor,
        target: "the_outline",
        verb: "focus_on",
        args: [null]
      },
      view: derivedViewOf(seq.store),
      planningScope: SCOPE,
      classifier,
      base: seq.head(),
      idempotencyKey: "compact-outliner-focus",
      stamp: seq.stamp(),
      planningRoomRoster: { room: "the_outline", rows }
    });

    const focusWrite = plan.transcript.writes.find(
      (write) => write.cell.kind === "prop" && write.cell.object === "the_outline" && write.cell.name === "focus_by_actor"
    );
    expect(focusWrite?.value).toEqual({
      [session.actor]: null,
      remote_present: null
    });
  });

  it("plans room entry without reading legacy subscriber projection cells", async () => {
    const world = createWorld();
    world.createObject({ id: "home", name: "Home", parent: "$room", owner: "$wiz" });
    const stale = world.auth("guest:compact-enter-stale");
    world.endSession(stale.id); // physical player remains; live owner roster excludes it
    const session = world.auth("guest:compact-enter");
    await world.directCall("compact-enter-setup", session.actor, "the_chatroom", "leave", [], { sessionId: session.id });
    world.setProp("home", "session_subscribers", [{ session: session.id, actor: session.actor }]);
    world.setProp("home", "subscribers", [session.actor]);
    const destination = "the_chatroom";
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seq.seed(cellsFromSerialized(world.exportWorld()));
    const view = derivedViewOf(seq.store);
    const movementClassifier: ScopeClassifier = {
      scopeOf: (object) => object === session.actor ? `cluster:${session.actor}` : SCOPE,
      isShared: (scope) => scope === SCOPE
    };
    // Owner snapshot is fetched before the move commits: neither the moving
    // actor nor the disconnected physical player is present yet.
    const destinationRows: Array<Record<string, unknown>> = [];
    const plan = await planTurn({
      call: {
        kind: "woo.turn_call.shadow.v1",
        id: "compact-enter-deck",
        route: "sequenced",
        scope: SCOPE,
        session: session.id,
        actor: session.actor,
        target: destination,
        verb: "enter",
        args: []
      },
      view,
      planningScope: SCOPE,
      classifier: movementClassifier,
      base: seq.head(),
      idempotencyKey: "compact-enter-deck",
      stamp: seq.stamp(),
      slicePlanning: true,
      planningRoomRoster: { room: destination, rows: destinationRows }
    });

    expect(plan.transcript.sessionScopeTransition).toMatchObject({
      session: session.id,
      actor: session.actor,
      to: destination
    });
    expect(plan.transcript.result).toMatchObject({
      room: destination,
      roster: [expect.objectContaining({ id: session.actor, name: "Guest 1" })]
    });
    expect(plan.transcript.reads).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ cell: expect.objectContaining({ kind: "prop", name: "subscribers" }) }),
      expect.objectContaining({ cell: expect.objectContaining({ kind: "prop", name: "session_subscribers" }) })
    ]));
    expect(plan.transcript.reads.some((read) =>
      read.cell.object === stale.actor && read.cell.kind === "prop" &&
      (read.cell.name === "description" || read.cell.name === "home")
    )).toBe(false);
  });
});

describe("slice-based planning (Phase 1 — the spine)", () => {
  /** The harness world plus `pad` unrelated objects the turn never reads,
   * seeded into both the authority and the derived view. */
  function paddedHarness(tag: string, pad: number) {
    const world = createWorld();
    const session = world.auth(`guest:slice-${tag}`);
    const actor = session.actor;
    world.createObject({ id: "slice_box", name: "Slice Box", parent: "$thing", owner: actor });
    world.defineProperty("slice_box", { name: "counter", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
    expect(
      installVerb(world, "slice_box", "bump", `verb :bump() rxd { this.counter = this.counter + 1; return this.counter; }`, null).ok
    ).toBe(true);
    for (let i = 0; i < pad; i++) {
      world.createObject({ id: `slice_pad_${i}`, name: `Pad ${i}`, parent: "$thing", owner: actor });
      world.defineProperty(`slice_pad_${i}`, { name: "n", defaultValue: i, owner: actor, perms: "rw", typeHint: "int" });
    }
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seq.seed(cellsFromSerialized(world.exportWorld()));
    const call = (id: string): ShadowTurnCall => ({
      kind: "woo.turn_call.shadow.v1",
      id,
      route: "direct",
      scope: SCOPE,
      session: session.id,
      actor,
      target: "slice_box",
      verb: "bump",
      args: []
    });
    return { seq, call };
  }

  it("plans against the read-set slice (plan_cells flat as the view grows) and commits identically to full-view planning", async () => {
    // Full-view plan of the SMALL world — the baseline commit.
    const small = paddedHarness("small", 0);
    const full = await planTurn({
      call: small.call("full"),
      view: derivedViewOf(small.seq.store),
      planningScope: SCOPE,
      classifier,
      base: small.seq.head(),
      idempotencyKey: "k-full",
      stamp: small.seq.stamp()
    });

    // Slice plan of a LARGE world (300 unrelated objects the turn never
    // reads). plan_cells must NOT grow with the padding.
    const large = paddedHarness("large", 300);
    const sliced = await planTurn({
      call: large.call("slice"),
      view: derivedViewOf(large.seq.store),
      planningScope: SCOPE,
      classifier,
      base: large.seq.head(),
      idempotencyKey: "k-slice",
      stamp: large.seq.stamp(),
      slicePlanning: true
    });

    // THE INVARIANT: the slice is far smaller than the padded view and
    // ~the same size as the small full-view plan (the padding never
    // enters planning).
    const fullViewOfLarge = await planTurn({
      call: large.call("full-large"),
      view: derivedViewOf(large.seq.store),
      planningScope: SCOPE,
      classifier,
      base: large.seq.head(),
      idempotencyKey: "k-full-large",
      stamp: large.seq.stamp()
    });
    expect(fullViewOfLarge.planCells).toBeGreaterThan(full.planCells + 300); // padding IS in the full view
    expect(sliced.planCells).toBeLessThan(fullViewOfLarge.planCells); // slice excludes it
    // Flat: the slice of the large world is no bigger than the small
    // world's full plan plus a small constant.
    expect(sliced.planCells).toBeLessThanOrEqual(full.planCells + 16);
    // Blocker #1: the fix-6 SNAPSHOT is the slice itself — the clone,
    // scratch, rewrite and closure never touch an O(view) copy. (The
    // default path keeps the full clone: snapshotCells ~ view.)
    expect(sliced.snapshotCells).toBe(sliced.planCells);
    expect(fullViewOfLarge.snapshotCells).toBeGreaterThan(sliced.snapshotCells + 300);

    // Correctness: the slice plan commits, and to the same post-state a
    // full-view plan of the same world would (identical execution).
    const sliceReply = large.seq.submit(sliced.submit);
    expect(sliceReply.status).toBe("accepted");
    if (sliceReply.status !== "accepted") return;
    expect(sliced.submit.post_state_version).toBe(fullViewOfLarge.submit.post_state_version);
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

  it("slice planning keeps the fix-6 property: the seed slice is cloned synchronously, so a mid-plan install cannot launder", async () => {
    // Blocker #1 moved the snapshot from a full view.clone() to a per-
    // attempt slice-clone; the clone is still synchronous, so a warm turn
    // (no growth rounds) records exactly the versions its execution saw.
    const { seq, call } = harness("slice-snapshot");
    const view = derivedViewOf(seq.store);
    const key = "property_cell:plan_box:counter";
    const snapshotVersion = view.get(key)?.version;
    expect(snapshotVersion).toBeDefined();

    const pending = planTurn({
      call: call("plan-slice-snap-1"),
      view,
      planningScope: SCOPE,
      classifier,
      base: seq.head(),
      idempotencyKey: "kslicesnap",
      stamp: seq.stamp(),
      slicePlanning: true
    });
    const midPlan = view.get(key) as NonNullable<ReturnType<typeof view.get>>;
    view.install({ ...midPlan, value: { value: 999 }, version: "laundered-version" });

    const plan = await pending;
    const counterReads = plan.transcript.reads.filter(
      (read) => read.cell.kind === "prop" && read.cell.object === "plan_box" && read.cell.name === "counter"
    );
    expect(counterReads.length).toBeGreaterThanOrEqual(1);
    for (const read of counterReads) {
      expect(read.version).toBe(snapshotVersion);
      expect(read.version).not.toBe("laundered-version");
    }
    expect(seq.submit(plan.submit).status).toBe("accepted");
  });
});
