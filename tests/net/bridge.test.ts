// bridge.ts — the engine-boundary views: SerializedWorld ↔ net cells
// (coherence.md CO7; kickoff step 8). The acceptance bar here is the
// round trip: a bootstrap world exported to cells, reassembled through
// serializedFromCells, must still run a verb through the real VM
// boundary (runShadowTurnCallTranscript + the admission gate).
import { describe, expect, it } from "vitest";
import { installVerb } from "../../src/core/authoring";
import { createWorld } from "../../src/core/bootstrap";
import {
  cellsFromSerialized,
  planningWorldFromCells,
  runShadowTurnCallTranscript,
  serializedFromCells,
  type NetCellInput,
  type ShadowTurnCall
} from "../../src/net/bridge";
import { isNetError } from "../../src/net/errors";

/** Bootstrap world + one authored object with a valued property, a
 * def-only property, and a simple read-modify-write verb — the same
 * authoring pattern as tests/shadow-turn-exec.test.ts. */
function worldWithVerb(tag: string) {
  const world = createWorld();
  const session = world.auth(`guest:bridge-${tag}`);
  const actor = session.actor;
  world.createObject({ id: "bridge_box", name: "Bridge Box", parent: "$thing", owner: actor });
  world.defineProperty("bridge_box", { name: "counter", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
  const installed = installVerb(
    world,
    "bridge_box",
    "bump",
    `verb :bump() rxd {
      let before = this.counter;
      this.counter = before + 1;
      return this.counter;
    }`,
    null
  );
  expect(installed.ok).toBe(true);
  return { world, session, actor };
}

function byKey(cells: NetCellInput[], kind: string, object: string, name?: string): NetCellInput | undefined {
  return cells.find((cell) => cell.kind === kind && cell.object === object && cell.name === name);
}

describe("cellsFromSerialized payload shapes (CO7)", () => {
  it("emits lineage/live/property/verb/session cells in the net shapes", () => {
    const { world, session, actor } = worldWithVerb("shapes");
    world.setProp("bridge_box", "counter", 3);
    const cells = cellsFromSerialized(world.exportWorld());

    // Lineage: identity only — no timestamps, no live state.
    const lineage = byKey(cells, "object_lineage", "bridge_box")?.value as Record<string, unknown>;
    expect(lineage).toEqual({ parent: "$thing", owner: actor, name: "Bridge Box", anchor: null, flags: {} });

    // Live: location only.
    expect(byKey(cells, "object_live", "bridge_box")?.value).toEqual({ location: null });

    // Property: {value, def} — the value slot plus the local definition.
    const counter = byKey(cells, "property_cell", "bridge_box", "counter")?.value as { value: unknown; def?: { defaultValue: unknown } };
    expect(counter.value).toBe(3);
    expect(counter.def?.defaultValue).toBe(0);

    // Verb page ships without line_map (CO7: debug info on demand).
    const verb = byKey(cells, "verb_bytecode", "bridge_box", "bump")?.value as Record<string, unknown>;
    expect(verb.name).toBe("bump");
    expect(verb.bytecode).toBeDefined();
    expect("line_map" in verb).toBe(false);

    // Session cells carry the SerializedSession row.
    const row = byKey(cells, "session", session.id)?.value as { id: string; actor: string };
    expect(row.actor).toBe(actor);
  });

  it("def-only properties omit the value slot ({def} payload)", () => {
    // A serialized object may carry a PropertyDef without a local value
    // (the slot introduction; instances inherit the default). The live
    // authoring path materializes values eagerly, so construct the
    // def-only row at the serialized level where it legitimately occurs.
    const { world } = worldWithVerb("def-only");
    const exported = world.exportWorld();
    const box = exported.objects.find((obj) => obj.id === "bridge_box") as (typeof exported.objects)[number];
    box.properties = box.properties.filter(([name]) => name !== "counter");
    const cells = cellsFromSerialized(exported);
    const counter = byKey(cells, "property_cell", "bridge_box", "counter")?.value as Record<string, unknown>;
    // No `value` key — the first write (applyTranscript's {value, def?}
    // merge) adds it while preserving the def.
    expect("value" in counter).toBe(false);
    expect(counter.def).toBeDefined();
  });
});

describe("serializedFromCells (the inverse)", () => {
  it("round-trips: exported world → cells → world the engine can run", async () => {
    const { world, session, actor } = worldWithVerb("roundtrip");
    const exported = world.exportWorld();
    const cells = cellsFromSerialized(exported);
    const rebuilt = serializedFromCells(cells, {
      objectCounter: exported.objectCounter,
      sessionCounter: exported.sessionCounter,
      parkedTaskCounter: exported.parkedTaskCounter
    });

    // Projections recompute from the cells: the actor stands in its room's
    // contents, the box under $thing's children.
    const actorRow = rebuilt.objects.find((obj) => obj.id === actor);
    expect(actorRow).toBeDefined();
    if (actorRow?.location) {
      const room = rebuilt.objects.find((obj) => obj.id === actorRow.location);
      expect(room?.contents).toContain(actor);
    }
    const thing = rebuilt.objects.find((obj) => obj.id === "$thing");
    expect(thing?.children).toContain("bridge_box");

    // The rebuilt image runs a direct verb through the real VM boundary.
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "bridge-roundtrip-bump",
      route: "direct",
      scope: "#-1",
      session: session.id,
      actor,
      target: "bridge_box",
      verb: "bump",
      args: []
    };
    const run = await runShadowTurnCallTranscript(planningWorldFromCells(cells, { objectCounter: exported.objectCounter }), call);
    expect(run.frame).toMatchObject({ op: "result", result: 1 });
    expect(run.transcript.complete).toBe(true);
    expect(run.transcript.writes).toContainEqual(expect.objectContaining({
      cell: { kind: "prop", object: "bridge_box", name: "counter" },
      value: 1
    }));
  });

  it("executes a native verb page after the net-cell round trip", async () => {
    const world = createWorld();
    const session = world.auth("guest:bridge-native");
    const cells = cellsFromSerialized(world.exportWorld());
    const nativePage = byKey(cells, "verb_bytecode", "$actor", "focus_list")?.value as Record<string, unknown>;
    expect(nativePage).toMatchObject({ kind: "native", native: "actor_focus_list" });

    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "bridge-native-focus-list",
      route: "direct",
      scope: "#-1",
      session: session.id,
      actor: session.actor,
      target: session.actor,
      verb: "focus_list",
      args: []
    };
    const run = await runShadowTurnCallTranscript(planningWorldFromCells(cells), call);
    expect(run.frame).toMatchObject({ op: "result", result: [] });
    expect(run.transcript.complete).toBe(true);
  });

  it("cells for an object without lineage are a closure violation (E_LINEAGE assert)", () => {
    try {
      serializedFromCells([{ kind: "object_live", object: "#ghost", value: { location: null } }]);
      expect.unreachable("must throw E_LINEAGE");
    } catch (err) {
      expect(isNetError(err) && err.code === "E_LINEAGE").toBe(true);
    }
  });

  it("log cells never assemble into a planning world (scope-local, CO5 copy #1)", () => {
    expect(() => serializedFromCells([{ kind: "log", object: "the_room", value: [] }]))
      .toThrow(/log cells do not bridge/);
  });
});
