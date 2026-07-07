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
import { ScopeSequencer, type CommitSubmit } from "../../src/net/scope";
import { netCellKeyFor } from "../../src/net/transcript";

const SCOPE = "home";
const EPOCH = "cat1";

// Phase-2 fixed assignment: one shared scope owns everything.
const classifier: ScopeClassifier = {
  scopeOf: () => SCOPE,
  isShared: (scope) => scope === SCOPE
};

/**
 * One genesis for both sides: bootstrap world + an authored object with
 * verbs exercising the prop-write/observation, create, move, and
 * property-removal paths. The actor gets the programmer flag (test
 * idiom, e.g. tests/authoring.test.ts) so the `create` builtin's
 * permission check passes identically on both sides.
 */
function genesis() {
  const world = createWorld();
  const session = world.auth("guest:differential");
  const actor = session.actor;
  world.object(actor).flags.programmer = true;
  // MOO-faithful property shape for the removal leg: the def lives on the
  // CLASS, the instance carries only a local value override. clear_property
  // then reverts the instance to the class default — exactly the
  // op-"remove" semantics (a self-defined property cannot meaningfully be
  // cleared: nothing on the chain would satisfy the read afterwards).
  world.createObject({ id: "diff_crate_class", name: "Crate Class", parent: "$thing", owner: actor });
  world.defineProperty("diff_crate_class", { name: "counter", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
  world.createObject({ id: "diff_crate", name: "Crate", parent: "diff_crate_class", owner: actor });
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
  // Property removal: clear_property drops the local override so the
  // property reverts to the inherited default (the op-"remove" write
  // path — the emitter recorded in world.clearPropertyForActor, applied
  // by transcript.ts as a def-only/{deleted} cell).
  installed = installVerb(
    world,
    "diff_crate",
    "reset",
    `verb :reset() rxd {
      clear_property(this, "counter");
      observe({ type: "reset", target: this, count: this.counter });
      return this.counter;
    }`,
    null
  );
  expect(installed.ok).toBe(true);

  return { serialized: world.exportWorld(), actor, session: session.id };
}

/** The scripted sequence both sides run: prop+observe, create, another
 * prop write (post-create state), move, property removal. */
const SCRIPT: Array<{ id: string; verb: string }> = [
  { id: "diff-turn-1", verb: "poke" },
  { id: "diff-turn-2", verb: "mint" },
  { id: "diff-turn-3", verb: "poke" },
  { id: "diff-turn-4", verb: "stash" },
  { id: "diff-turn-5", verb: "reset" }
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

    // The interesting facts landed: the counter was bumped twice and then
    // CLEARED back to the class default — the instance's local override
    // cell is GONE (remove-without-local-def deletes the cell; the class
    // keeps its def cell), the widget was minted with the counter-derived
    // id inside the crate, the crate moved to the actor.
    expect(seq.store.has("property_cell:diff_crate:counter")).toBe(false);
    expect(seq.store.get("property_cell:diff_crate_class:counter")?.value).toMatchObject({ value: 0 });
    expect((seq.store.get("object_live:diff_crate")?.value as { location: string }).location).toBe(actor);
    const minted = storeCells(seq.store).filter((cell) => cell.kind === "object_lineage" && cell.object.startsWith("obj_"));
    expect(minted).toHaveLength(1);
    expect((minted[0].value as { name: string }).name).toBe("minted widget");
  });

  it("two scopes: retargeted actor move, CA3 rider adoption, cross-scope read closure", async () => {
    // The multi-scope commit paths the single-scope scenario cannot reach:
    // route.ts retargeting to a non-planning scope, ride-along writes
    // committed at the shared scope and adopted by the owner, and reads
    // validated only by the scope that owns them (scope.owns — CO2.4 is a
    // per-authority attestation; without `owns` the move turn below
    // rejects read_version_mismatch on the foreign $player:moveto verb
    // read, which is how this gap was demonstrated before fixing).
    //
    // Topology: the actor is its own anchor cluster ("cluster"); every
    // other object — rooms, classes — anchors to the one shared scope
    // ("world"). Rooms are $thing containers so the move chain runs
    // without $space presence/session machinery (presence rows are CO9
    // projections with no net applier until Phase 3, and $space
    // enter/exit hooks emit wall-clock `ts` observations that can never
    // compare deep-equal across two separately-timed executions).
    const world = createWorld();
    const session = world.auth("guest:differential-2");
    const actor = session.actor;
    world.object(actor).flags.programmer = true;
    world.createObject({ id: "diff2_room", name: "North Room", parent: "$thing", owner: actor });
    world.createObject({ id: "diff2_annex", name: "South Annex", parent: "$thing", owner: actor });
    world.defineProperty("diff2_room", { name: "visits", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
    // The rider property's def lives on the actor's CLASS: the actor's own
    // cell is value-only, so the shared scope's rider apply (which has no
    // prior actor cell) and the planner's scratch (whose prior is
    // value-only) produce the identical `{value}` payload. A def on the
    // actor itself would need the CO7 write-preimage transfer to reach
    // the committing scope — Phase-3 wiring.
    const actorClass = world.object(actor).parent as string;
    world.defineProperty(actorClass, { name: "greeted", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
    // Room verb: shared-scope write + actor-cell rider + a cross-scope
    // read (actor.greeted) in one turn — the CA3 ride-along shape.
    const installed = installVerb(
      world,
      "diff2_room",
      "greet",
      `verb :greet() rxd {
        this.visits = this.visits + 1;
        actor.greeted = actor.greeted + this.visits;
        observe({ type: "greeted", room: this, who: actor, visits: this.visits });
        return actor.greeted;
      }`,
      null
    );
    expect(installed.ok).toBe(true);
    // Start the actor in the north room (genesis state, shared by both
    // sides), so the scripted move is room → annex with no catalog-lobby
    // exit hooks in the compared turns.
    const placed = await world.directCall("diff2-genesis-place", actor, actor, "moveto", ["diff2_room"], { sessionId: session.id });
    expect(placed.op).toBe("result");
    const genesis2 = world.exportWorld();

    const CLUSTER_SCOPE = "cluster";
    const WORLD_SCOPE = "world";
    const classifier2: ScopeClassifier = {
      scopeOf: (object) => (object === actor ? CLUSTER_SCOPE : WORLD_SCOPE),
      isShared: (scope) => scope === WORLD_SCOPE
    };

    // The scripted turns with their expected commit routing.
    const script: Array<{ id: string; target: string; verb: string; args: unknown[]; scope: string; riders: string[] }> = [
      { id: "diff2-turn-1", target: "diff2_room", verb: "greet", args: [], scope: WORLD_SCOPE, riders: [CLUSTER_SCOPE] },
      { id: "diff2-turn-2", target: actor, verb: "moveto", args: ["diff2_annex"], scope: CLUSTER_SCOPE, riders: [] },
      { id: "diff2-turn-3", target: "diff2_room", verb: "greet", args: [], scope: WORLD_SCOPE, riders: [CLUSTER_SCOPE] }
    ];

    // ---- Side A: v2-native, same recorder capture as scenario 1.
    const worldA = createWorldFromSerialized(structuredClone(genesis2), { persist: false });
    const observationsA: Observation[][] = [];
    for (const turn of script) {
      const recorder = new InMemoryTurnRecorder();
      worldA.setTurnRecorder(recorder);
      const frame = await worldA.directCall(`${turn.id}-a`, actor, turn.target, turn.verb, turn.args as never[], { sessionId: session.id });
      expect(frame.op, `side A ${turn.id} (${turn.verb})`).toBe("result");
      const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
      expect(transcript.complete, `side A ${turn.id} incomplete: ${transcript.incompleteReasons.join(", ")}`).toBe(true);
      observationsA.push(transcript.observations);
    }
    const referenceVersions = new Map(
      cellsFromSerialized(worldA.exportWorld())
        .map((cell) => [cellKey(cell.kind, cell.object, cell.name), cellVersion(cell.value)] as const)
    );

    // ---- Side B: TWO sequencers, one per scope, each the single
    // authority for its partition of the genesis cells and validating
    // only the reads it owns (foreign reads are the other scope's
    // attestation — scope.owns).
    const sequencers = new Map<string, ScopeSequencer>([
      [WORLD_SCOPE, new ScopeSequencer(WORLD_SCOPE, EPOCH, { owns: (object) => classifier2.scopeOf(object) === WORLD_SCOPE })],
      [CLUSTER_SCOPE, new ScopeSequencer(CLUSTER_SCOPE, EPOCH, { owns: (object) => classifier2.scopeOf(object) === CLUSTER_SCOPE })]
    ]);
    for (const cell of cellsFromSerialized(genesis2)) {
      // Session cells key on session ids (no anchor); they ride with the
      // shared scope, and are excluded from comparison anyway.
      (sequencers.get(classifier2.scopeOf(cell.object)) as ScopeSequencer).seed([cell]);
    }
    // One gateway view spanning BOTH scopes (the cross-scope read closure
    // every turn plans against).
    const view = new CellStore("derived");
    for (const seq of sequencers.values()) for (const cell of storeCells(seq.store)) view.install(cell);

    // CO2.3 rider integrity (rule 1): the committing scope validates
    // FOREIGN reads against owner attestations instead of skipping them,
    // so the harness plays the gateway's part — partition the planned
    // transcript's foreign reads by owner and attest each key at the
    // owner's current store version (the /net/attest shape). A submit
    // with an uncovered foreign read rejects terminal rider_unattested.
    const attestForeignReads = (
      transcript: { reads: Array<{ cell: { kind: string; object: string; name?: string } }> },
      committingScope: string
    ): NonNullable<CommitSubmit["attestations"]> => {
      const byOwner = new Map<string, Set<string>>();
      for (const read of transcript.reads) {
        const key = netCellKeyFor(read.cell as never);
        if (key === null) continue; // contents reads are projection reads (CA4)
        const owner = classifier2.scopeOf(read.cell.object);
        if (owner === committingScope) continue;
        const keys = byOwner.get(owner) ?? new Set<string>();
        keys.add(key);
        byOwner.set(owner, keys);
      }
      const out: NonNullable<CommitSubmit["attestations"]> = {};
      for (const [owner, keys] of byOwner) {
        const seq = sequencers.get(owner) as ScopeSequencer;
        out[owner] = {
          owner_head: seq.head(),
          cells: [...keys].sort().map((key) => ({ key, version: seq.store.get(key)?.version ?? "absent" }))
        };
      }
      return out;
    };

    const observationsB: Observation[][] = [];
    for (const turn of script) {
      const target = sequencers.get(turn.scope) as ScopeSequencer;
      const plan = await planTurn({
        call: {
          kind: "woo.turn_call.shadow.v1",
          id: `${turn.id}-b`,
          route: "direct",
          scope: WORLD_SCOPE, // the session's planning scope; route.ts picks the commit scope
          session: session.id,
          actor,
          target: turn.target,
          verb: turn.verb,
          args: turn.args as never[]
        },
        view,
        planningScope: WORLD_SCOPE,
        classifier: classifier2,
        base: target.head(),
        idempotencyKey: turn.id,
        stamp: target.stamp()
      });
      // The routing under test: retarget (pure move → cluster) and CA3
      // ride-along (room write + actor rider → world, riders named).
      expect(plan.selection, `${turn.id} routing`).toEqual({ scope: turn.scope, riders: turn.riders });
      const attestations = attestForeignReads(plan.transcript, turn.scope);
      const reply = target.submit({ ...plan.submit, attestations });
      expect(reply.status, `side B ${turn.id} (${turn.verb}): ${JSON.stringify(reply)}`).toBe("accepted");
      if (reply.status !== "accepted") return;
      observationsB.push(plan.transcript.observations);
      const riderCellsByOwner = new Map<string, Array<NonNullable<ReturnType<CellStore["get"]>>>>();
      for (const key of reply.touched) {
        const cell = target.store.get(key);
        if (cell) view.install(cell);
        else view.delete(key);
        // Collect accepted rider cells for their owners (below).
        const ownerScope = cell ? classifier2.scopeOf(cell.object) : undefined;
        if (cell && ownerScope !== undefined && ownerScope !== turn.scope) {
          riderCellsByOwner.set(ownerScope, [...(riderCellsByOwner.get(ownerScope) ?? []), cell]);
        }
      }
      // Rider adoption: accepted rider cells committed at the shared
      // scope flow to their owning scope as an OWNER-SEQUENCED commit
      // (CO2.3 rule 2, seq.adopt) — per-cell prior CAS against the
      // version this turn observed (the attested version), ONE owner
      // head advance per batch, adopted cells stamped with the NEW owner
      // head. In the real system this forward is the scope DO's durable
      // outbox (CO2.7); the harness performs it inline.
      for (const [ownerScope, cells] of riderCellsByOwner) {
        const owner = sequencers.get(ownerScope) as ScopeSequencer;
        const priors: Record<string, string> = {};
        for (const cell of cells) {
          const attested = attestations[ownerScope]?.cells.find((entry) => entry.key === cell.key);
          if (attested) priors[cell.key] = attested.version;
        }
        const headBefore = owner.head().seq;
        const adopted = owner.adopt({ from_scope: turn.scope, seq: reply.head.seq, cells, priors });
        expect(adopted.status, `${turn.id} adoption at ${ownerScope}`).toBe("applied");
        expect(adopted.conflicts, `${turn.id} adoption conflicts at ${ownerScope}`).toEqual([]);
        // The owner's head ADVANCED on adoption, and the adopted cells
        // stamp the new head (an owner-ordered event, CO8).
        expect(owner.head().seq, `${turn.id} owner head advance`).toBe(headBefore + 1);
        for (const key of adopted.applied) {
          expect(owner.store.get(key)?.stamp.scope_head, `${turn.id} adopted stamp ${key}`).toBe(
            `${owner.head().seq}:${owner.head().hash}`
          );
        }
      }
    }

    // ---- Turn-by-turn observation streams.
    for (let i = 0; i < script.length; i += 1) {
      expect(observationsB[i], `observation stream diverged on ${script[i].id} (${script[i].verb})`).toEqual(observationsA[i]);
    }

    // ---- Final state: merge both authorities, owner wins per cell (the
    // shared scope retains its applied copy of rider cells — a harness
    // artifact of the inline forward; authority for those keys is the
    // owner). Compare against the v2 reference exactly as in scenario 1.
    const merged = new Map<string, ReturnType<CellStore["get"]>>();
    for (const seq of sequencers.values()) {
      for (const cell of storeCells(seq.store)) {
        if (classifier2.scopeOf(cell.object) === seq.scope || !merged.has(cell.key)) merged.set(cell.key, cell);
      }
    }
    const diffs: string[] = [];
    for (const cell of merged.values()) {
      if (!cell || cell.kind === "session") continue;
      const reference = referenceVersions.get(cell.key);
      if (reference === undefined) diffs.push(`${cell.key}: present in net authority, absent from the v2 reference`);
      else if (reference !== cell.version) diffs.push(`${cell.key}: net=${cell.version} v2=${reference}`);
    }
    expect(diffs, `two-scope differential divergence (net authority vs v2 reference):\n${diffs.join("\n")}`).toEqual([]);

    // The cross-scope facts landed where they belong: the actor moved at
    // its own sequencer (annex), the rider greeted count lives at the
    // cluster authority (adopted from the world commits: 1 then 1+2=3),
    // the room's visits at the world authority.
    const cluster = sequencers.get(CLUSTER_SCOPE) as ScopeSequencer;
    const shared = sequencers.get(WORLD_SCOPE) as ScopeSequencer;
    expect((cluster.store.get(`object_live:${actor}`)?.value as { location: string }).location).toBe("diff2_annex");
    expect(cluster.store.get(`property_cell:${actor}:greeted`)?.value).toMatchObject({ value: 3 });
    expect(cluster.store.get(`property_cell:${actor}:greeted`)?.provenance).toBe("authoritative");
    expect(shared.store.get("property_cell:diff2_room:visits")?.value).toMatchObject({ value: 2 });
    expect(shared.head().seq).toBe(2);
    // The cluster's head counts its OWN commits and the adoptions it
    // sequenced: adopt(greet 1) + moveto + adopt(greet 2) = 3 (CO2.3
    // rule 2 — adoption is an owner-sequenced commit).
    expect(cluster.head().seq).toBe(3);
    // The last adoption's cells carry the cluster's current head stamp.
    expect(cluster.store.get(`property_cell:${actor}:greeted`)?.stamp.scope_head).toBe(
      `${cluster.head().seq}:${cluster.head().hash}`
    );
  });
});
