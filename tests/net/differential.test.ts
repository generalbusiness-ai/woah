// The Phase-2 differential gate (coherence.md CO12.4) — COMMIT-LAYER
// scope, stated honestly: the same scripted turn sequence runs (A)
// natively on the v2 engine and (B) through the net pipeline
// (planTurn → ScopeSequencer → warm view refresh), comparing
//   - observation streams turn-by-turn (deep equality), and
//   - final authority state cell-by-cell (content-address equality —
//     the CO12.1-flavored conformance assertion).
// The FULL differential — scripts/smoke/scenario.ts through the v2 fake
// lane vs src/net on InProcessHost — needs the Phase-4 transports
// (session open, command routing, fanout delivery) and lands with them;
// this gate holds the commit-layer line until then.
//
// Determinism ground rules: the installed verbs avoid now()/random; the
// scripted turns run on the direct route (no sequenced-log seq/ts
// stamping); create ids are counter-derived (`obj_<scope>_<counter>`),
// so side B threads the same objectCounter side A allocates from.
import { describe, expect, it } from "vitest";
import { installVerb } from "../../src/core/authoring";
import { createWorld, createWorldFromSerialized } from "../../src/core/bootstrap";
import { effectTranscriptFromRecordedTurn } from "../../src/core/effect-transcript";
import { InMemoryTurnRecorder } from "../../src/core/turn-recorder";
import type { Observation } from "../../src/core/types";
import { cellsFromSerialized, storeCells, type ShadowTurnCall } from "../../src/net/bridge";
import { CellStore, cellKey, cellVersion } from "../../src/net/cells";
import { planTurn } from "../../src/net/plan";
import type { ScopeClassifier } from "../../src/net/route";
import { ScopeSequencer } from "../../src/net/scope";

const SCOPE = "home";
const EPOCH = "cat1";

// Phase-2 fixed assignment: one shared scope owns everything.
const classifier: ScopeClassifier = {
  scopeOf: () => SCOPE,
  isShared: (scope) => scope === SCOPE
};

/**
 * One genesis for both sides: bootstrap world + an authored object with
 * verbs exercising the prop-write/observation, create, and move paths.
 * The actor gets the programmer flag (test idiom, e.g.
 * tests/authoring.test.ts) so the `create` builtin's permission check
 * passes identically on both sides.
 */
function genesis() {
  const world = createWorld();
  const session = world.auth("guest:differential");
  const actor = session.actor;
  world.object(actor).flags.programmer = true;
  world.createObject({ id: "diff_crate", name: "Crate", parent: "$thing", owner: actor });
  world.defineProperty("diff_crate", { name: "counter", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
  world.createObject({ id: "diff_widget_class", name: "Widget", parent: "$thing", owner: actor });

  // Prop write + observation (no now()/random — determinism ground rule).
  let installed = installVerb(
    world,
    "diff_crate",
    "poke",
    `verb :poke() rxd {
      this.counter = this.counter + 1;
      observe({ type: "poked", target: this, count: this.counter });
      return this.counter;
    }`,
    null
  );
  expect(installed.ok).toBe(true);
  // Create: counter-derived id, placed inside the crate.
  installed = installVerb(
    world,
    "diff_crate",
    "mint",
    `verb :mint() rxd {
      let obj = create("diff_widget_class", { owner: actor, name: "minted widget", location: this });
      observe({ type: "minted", target: this, item: obj });
      return obj;
    }`,
    null
  );
  expect(installed.ok).toBe(true);
  // Move: the crate (with its contents) into the actor — the CA3 O(1)
  // container move, through the full movetoChecked chain.
  installed = installVerb(
    world,
    "diff_crate",
    "stash",
    `verb :stash() rxd {
      moveto(this, actor);
      return location(this);
    }`,
    null
  );
  expect(installed.ok).toBe(true);

  return { serialized: world.exportWorld(), actor, session: session.id };
}

/** The scripted sequence both sides run: prop+observe, create, another
 * prop write (post-create state), move. */
const SCRIPT: Array<{ id: string; verb: string }> = [
  { id: "diff-turn-1", verb: "poke" },
  { id: "diff-turn-2", verb: "mint" },
  { id: "diff-turn-3", verb: "poke" },
  { id: "diff-turn-4", verb: "stash" }
];

describe("differential gate: v2-native vs net commit layer (CO12.4)", () => {
  it("same turns, equal observation streams, content-identical final state", async () => {
    const { serialized: genesisWorld, actor, session } = genesis();

    // ---- Side A: v2-native. Run the script directly on an engine world;
    // capture each turn's transcript via the recorder (the
    // tests/shadow-turn-exec.test.ts idiom) for the observation streams.
    const worldA = createWorldFromSerialized(structuredClone(genesisWorld), { persist: false });
    const observationsA: Observation[][] = [];
    for (const turn of SCRIPT) {
      const recorder = new InMemoryTurnRecorder();
      worldA.setTurnRecorder(recorder);
      const frame = await worldA.directCall(`${turn.id}-a`, actor, "diff_crate", turn.verb, [], { sessionId: session });
      expect(frame.op, `side A ${turn.id} (${turn.verb})`).toBe("result");
      const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
      expect(transcript.complete, `side A ${turn.id} incomplete: ${transcript.incompleteReasons.join(", ")}`).toBe(true);
      observationsA.push(transcript.observations);
    }
    // The reference cell map: the v2 world's final state in net cell shapes.
    const referenceVersions = new Map(
      cellsFromSerialized(worldA.exportWorld())
        .map((cell) => [cellKey(cell.kind, cell.object, cell.name), cellVersion(cell.value)] as const)
    );

    // ---- Side B: the net pipeline. Authority seeded from the same
    // genesis cells; the gateway plans on a derived view and refreshes it
    // from each accepted reply's touched set (warm cache-fill, CO7).
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seq.seed(cellsFromSerialized(genesisWorld));
    const view = new CellStore("derived");
    for (const cell of storeCells(seq.store)) view.install(cell);
    // Counters are host state, not cells: track create allocation so each
    // plan runs at the counter the authority's engine would be at.
    let objectCounter = genesisWorld.objectCounter;

    const observationsB: Observation[][] = [];
    for (const turn of SCRIPT) {
      const call: ShadowTurnCall = {
        kind: "woo.turn_call.shadow.v1",
        id: `${turn.id}-b`,
        route: "direct",
        scope: SCOPE,
        session,
        actor,
        target: "diff_crate",
        verb: turn.verb,
        args: []
      };
      const plan = await planTurn({
        call,
        view,
        planningScope: SCOPE,
        classifier,
        base: seq.head(),
        idempotencyKey: turn.id,
        stamp: seq.stamp(),
        counters: { objectCounter }
      });
      const reply = seq.submit(plan.submit);
      expect(reply.status, `side B ${turn.id} (${turn.verb}): ${JSON.stringify(reply)}`).toBe("accepted");
      if (reply.status !== "accepted") return;
      observationsB.push(plan.transcript.observations);
      for (const key of reply.touched) {
        const cell = seq.store.get(key);
        if (cell) view.install(cell);
        else view.delete(key);
      }
      objectCounter += plan.transcript.creates.length;
    }

    // ---- Turn-by-turn: observation streams must be deep-equal.
    for (let i = 0; i < SCRIPT.length; i += 1) {
      expect(observationsB[i], `observation stream diverged on ${SCRIPT[i].id} (${SCRIPT[i].verb})`).toEqual(observationsA[i]);
    }

    // ---- Final state: every cell net seeded or touched must
    // content-address identically to the v2 reference (version equality =
    // canonical value equality). Session cells are excluded: session rows
    // carry wall-derived presence fields (started/expiresAt/lastSeenAt —
    // delivery hints, CO5 copy #5 is a leased projection, never compared
    // authority state).
    const diffs: string[] = [];
    for (const cell of storeCells(seq.store)) {
      if (cell.kind === "session") continue;
      const reference = referenceVersions.get(cell.key);
      if (reference === undefined) diffs.push(`${cell.key}: present in net authority, absent from the v2 reference`);
      else if (reference !== cell.version) diffs.push(`${cell.key}: net=${cell.version} v2=${reference}`);
    }
    expect(diffs, `differential divergence (net authority vs v2 reference):\n${diffs.join("\n")}`).toEqual([]);

    // The interesting facts landed: counter bumped twice, the widget was
    // minted with the counter-derived id inside the crate, the crate moved
    // to the actor.
    expect(seq.store.get("property_cell:diff_crate:counter")?.value).toMatchObject({ value: 2 });
    expect((seq.store.get("object_live:diff_crate")?.value as { location: string }).location).toBe(actor);
    const minted = storeCells(seq.store).filter((cell) => cell.kind === "object_lineage" && cell.object.startsWith("obj_"));
    expect(minted).toHaveLength(1);
    expect((minted[0].value as { name: string }).name).toBe("minted widget");
  });
});
