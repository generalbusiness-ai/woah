import { authoritativePlanningWorld } from "../src/core/planning-world";
import { describe, expect, it } from "vitest";
import { createWorld, createWorldFromSerialized } from "../src/core/bootstrap";
import { createShadowCommitScope } from "../src/core/shadow-commit-scope";
import { createShadowExecutionNode } from "../src/core/shadow-turn-exec";
import { runShadowTurnCall, runShadowTurnCallOnWorldTranscript, type ShadowTurnCall } from "../src/core/shadow-turn-call";
import {
  buildShadowTurnExecAd,
  executeShadowTurnCallAcrossInProcessNetwork
} from "../src/core/shadow-turn-network";
import { shadowTurnKeyFromTranscript } from "../src/core/turn-key";
import type { SerializedWorld } from "../src/core/repository";
import type { ShadowTurnKey } from "../src/core/turn-key";

// Architecture probe: can the existing v2 shadow atom-guard / missing_state
// repair loop recover when a *transitively-referenced* object (the move
// destination room) is absent from a sparse, atom-guarded executor slice?
//
// The deck->garden move is a genuine cross-room move: `the_deck:south`
// dispatches `exit_deck_south:move(actor)`, which reads `this.dest`
// (= the_garden) and calls `moveto(actor, the_garden)`. That writes
// the_garden.contents and the_deck.contents. So the executor must touch
// the_garden even though the turn's scope is the_deck.
//
// CASE A proves the move is inherently multi-scope (it touches the_garden).
//
// CASE B asserts the §VTN10.1 recovery: when the destination room
// (the_garden) is absent from the executor slice, WooWorld.object() emits a
// lifecycle materialization probe before throwing. Under the guard the probe
// is rejected as E_NEED_STATE, surfacing a missing `lifecycle:the_garden`
// atom; the repair loop pages it in via cell_pages and re-runs, so the
// cross-room move *materializes* in the executor (no silent E_OBJNF, the
// actor walks into the_garden in the executor's own frame).
//
// CASE B now runs through the cell-authority movement model: after the
// materialization repair, the move commits at the moved actor's location
// authority. Source/destination contents are derived projections of that
// accepted location write, not fenced room-membership writes.

// Build the post-deck serialized world once. Shared by all cases.
async function setupOnDeck(): Promise<{
  fullSerialized: SerializedWorld;
  actor: string;
  sessionId: string;
}> {
  const anchor = createWorld();
  const session = anchor.auth("guest:garden-probe");
  const actor = session.actor;

  const enter = await anchor.call("p-enter", session.id, "the_chatroom", {
    actor,
    target: "the_chatroom",
    verb: "enter",
    args: []
  });
  expect(enter.op).toBe("applied");

  const toDeck = await anchor.call("p-deck", session.id, "the_chatroom", {
    actor,
    target: "the_chatroom",
    verb: "southeast",
    args: []
  });
  expect(toDeck.op).toBe("applied");

  // Confirm the actor is actually on the deck before we probe the move.
  expect(anchor.allLocationsForActor(actor)).toEqual(["the_deck"]);

  return { fullSerialized: anchor.exportWorld(), actor, sessionId: session.id };
}

function shadowTurnKeyWithoutPreimages(
  key: ShadowTurnKey,
  omit: (preimage: string) => boolean
): ShadowTurnKey {
  const filterPaired = (preimages: string[], hashes: string[]): { preimages: string[]; hashes: string[] } => {
    const keptPreimages: string[] = [];
    const keptHashes: string[] = [];
    for (let i = 0; i < preimages.length; i += 1) {
      const preimage = preimages[i];
      if (omit(preimage)) continue;
      keptPreimages.push(preimage);
      keptHashes.push(hashes[i]);
    }
    return { preimages: keptPreimages, hashes: keptHashes };
  };
  const all = filterPaired(key.preimages, key.atom_hashes);
  const reads = filterPaired(key.read_preimages, key.read_atom_hashes);
  const writes = filterPaired(key.write_preimages, key.write_atom_hashes);
  return {
    ...key,
    preimages: all.preimages,
    atom_hashes: all.hashes,
    read_preimages: reads.preimages,
    read_atom_hashes: reads.hashes,
    write_preimages: writes.preimages,
    write_atom_hashes: writes.hashes
  };
}

describe("scope-executor garden probe", () => {
  it("preserves pre-recording E_OBJNF as a structured repair signal", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:sparse-pre-recording-objnf");
    const serialized = anchor.exportWorld();
    const sparseSerialized: SerializedWorld = {
      ...serialized,
      objects: serialized.objects.filter((object) => object.id !== "the_chatroom")
    };
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "sparse-pre-recording-enter",
      route: "direct",
      scope: "the_chatroom",
      session: session.id,
      actor: session.actor,
      target: "the_chatroom",
      verb: "enter",
      args: []
    };

    await expect(runShadowTurnCallOnWorldTranscript(createWorldFromSerialized(sparseSerialized), call))
      .rejects.toMatchObject({ code: "E_OBJNF", value: "the_chatroom" });
  });

  it("CASE A: full-state single turn does the deck->garden move (records its scope + writes)", async () => {
    const { fullSerialized, actor, sessionId } = await setupOnDeck();

    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "garden-move",
      route: "sequenced",
      scope: "the_deck",
      session: sessionId,
      actor,
      target: "the_deck",
      verb: "south",
      args: []
    };

    const planned = await runShadowTurnCall(authoritativePlanningWorld(fullSerialized), call);

    const writeObjects = Array.from(
      new Set(
        planned.transcript.writes.map((w) =>
          w.cell.kind === "prop" || w.cell.kind === "verb" ? w.cell.object : "(other)"
        )
      )
    );
    const moveObjects = (planned.transcript.moves ?? []).map((m) => ({
      object: m.object,
      to: (m as { to?: string }).to,
      from: (m as { from?: string }).from
    }));

    const key = shadowTurnKeyFromTranscript(planned.transcript);

    // The move should have applied (it is a sequenced room turn).
    expect(planned.frame.op).toBe("applied");

    // The single turn must reference the_garden somewhere (move dest or a
    // contents write), proving this is inherently a cross-room turn.
    const referencesGarden =
      moveObjects.some((m) => m.to === "the_garden") ||
      writeObjects.includes("the_garden") ||
      key.preimages.some((p) => p.includes("the_garden"));
    expect(referencesGarden).toBe(true);

    // Verify post-state if we got a snapshot.
    if ("serializedAfter" in planned) {
      const after = createWorldFromSerialized(planned.serializedAfter, { persist: false });
      expect(after.allLocationsForActor(actor)).toEqual(["the_garden"]);
    }
  });

  it("CASE B: sparse atom-guarded executor missing the_garden repairs and commits at the actor location authority", async () => {
    const { fullSerialized, actor, sessionId } = await setupOnDeck();

    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "garden-move",
      route: "sequenced",
      scope: "the_deck",
      session: sessionId,
      actor,
      target: "the_deck",
      verb: "south",
      args: []
    };

    // Plan against full state to get the canonical key.
    const planned = await runShadowTurnCall(authoritativePlanningWorld(fullSerialized), call);
    const key = shadowTurnKeyFromTranscript(planned.transcript);
    const realScope = key.scope;

    // §VTN10.1 REDUCED-KEY CONVERGENCE:
    //
    // The earlier version of this test seeded the executor with the FULL key's
    // atom_hashes and only deleted the_garden's serialized object. That proved
    // the probe FIRES but NOT that repair CONVERGES from a reduced key — the
    // node already "claimed" the_garden's whole read/write closure in its
    // atom_hashes, so once the lifecycle page arrived the executor was done.
    //
    // The real prod sparse case is an executor that planned WITHOUT knowing
    // about the destination at all: neither the_garden's serialized object NOR
    // any the_garden atom is present. With a truly reduced key, a naive
    // `lifecycle:<id>`-grants-scaffold-only repair stalls one cell per round
    // (lifecycle, then contents, then each prop:the_garden.* in turn). The
    // VTN10.1 fix grants the FULL object closure for a bare-object
    // materialization miss in ONE round, so the move converges in a small
    // bounded number of rounds (one per distinct transitively-referenced
    // object the verb actually walks).
    //
    // Build the genuinely reduced atom set: every key atom whose preimage does
    // NOT reference the_garden (and its own exits, which the destination's
    // `here` snapshot walks transitively). This simulates an executor complete
    // for the_deck (the source scope) but with zero knowledge of the
    // destination subtree.
    const transitiveIds = ["the_garden", "exit_garden_north", "exit_garden_south"];
    const referencesTransitive = (preimage: string): boolean =>
      transitiveIds.some((id) => preimage.includes(id));
    const reducedKey = shadowTurnKeyWithoutPreimages(key, referencesTransitive);
    expect(reducedKey.atom_hashes.length).toBeLessThan(key.atom_hashes.length);
    // The reduced key must NOT contain any the_garden atom — that is what makes
    // this the real sparse case and forces the materialization repair.
    expect(reducedKey.preimages.some((p) => p.includes("the_garden"))).toBe(false);

    // Build a SPARSE serialized world: full state minus the_garden AND its own
    // exits. The executor genuinely has no destination-subtree state.
    const sparseSerialized: SerializedWorld = {
      ...fullSerialized,
      objects: fullSerialized.objects.filter((o) => !transitiveIds.includes(o.id))
    };
    expect(sparseSerialized.objects.some((o) => o.id === "the_garden")).toBe(false);
    expect(sparseSerialized.objects.some((o) => o.id === "exit_garden_north")).toBe(false);
    expect(sparseSerialized.objects.some((o) => o.id === "the_deck")).toBe(true);
    expect(sparseSerialized.objects.some((o) => o.id === "exit_deck_south")).toBe(true);
    expect(sparseSerialized.objects.some((o) => o.id === actor)).toBe(true);

    // Non-authoritative node WITH the atom guard active (no authoritative_state)
    // and a GENUINELY REDUCED atom set (no the_garden atoms at all).
    const node = createShadowExecutionNode({
      node: "deck-exec",
      scope: realScope,
      atom_hashes: reducedKey.atom_hashes,
      serialized: sparseSerialized
    });

    const result = await executeShadowTurnCallAcrossInProcessNetwork({
      request: { kind: "woo.turn.exec.request.shadow.v1" as const, call, key: reducedKey },
      nodes: [node],
      ads: [buildShadowTurnExecAd({ node: "deck-exec", scope: realScope, key: reducedKey, factor: 0.1 })],
      // Anchor HAS the_garden, so repair fetches it when the loop asks.
      anchor: { node: "anchor", serialized: fullSerialized },
      transferMode: "cell_pages",
      commitScope: createShadowCommitScope({
        node: "actor-location-authority",
        scope: actor,
        serialized: fullSerialized
      })
    });

    // ---- §VTN10.1 CONVERGENCE BUDGET ----
    //
    // With the full-object-closure grant, repair converges in a BOUNDED number
    // of rounds: one per distinct transitively-referenced object the verb walks.
    // The deck->garden move dereferences the_garden (the dest) and, building
    // the destination `here` snapshot, its own exits exit_garden_north /
    // exit_garden_south. The first lifecycle:the_garden grant also pulls the
    // garden's lineage+live+props in one round; the exits surface as their own
    // bare-object misses in subsequent rounds. Observed converged count is the
    // bound below; a regression that reintroduces per-CELL stalling (e.g.
    // dropping the property_cell read-preimage grant) would blow past it and
    // fail. If this number legitimately changes, update N and explain why.
    const N = 3;
    expect(result.transfers.length).toBeLessThanOrEqual(N);
    expect(result.transfers.length).toBeGreaterThanOrEqual(1);

    // ---- §VTN10.1 RECOVERY (the property this branch owns) ----

    // 1. The first pass no longer silently "succeeds": the absent-id lookup
    //    now becomes a repairable missing_state instead of a buried E_OBJNF.
    expect(result.first.ok).toBe(false);
    expect((result.first as { reason?: string }).reason).toBe("missing_state");

    // 2. At least one repair transfer happened (previously zero — the hole).
    expect(result.transfers.length).toBeGreaterThanOrEqual(1);

    // 3. A transfer was driven by the absent room's lifecycle atom — i.e. the
    //    materialization probe §VTN10.1 introduces, not some unrelated cell.
    const lifecycleTransfer = result.transfers.find((t) =>
      ((t as { preimages?: string[] }).preimages ?? []).some((p) => p.includes("lifecycle:the_garden"))
    );
    expect(lifecycleTransfer).toBeDefined();

    // 4. After repair, the move MATERIALIZES in the executor's own frame: the
    //    actor walks into the_garden and there is NO silent E_OBJNF buried in
    //    the frame's observations. (Previously: frame applied with the move
    //    dropped and an embedded {type:"$error", code:"E_OBJNF"}.)
    const frame = result.result.frame;
    expect(frame).toBeDefined();
    const observations: Array<Record<string, unknown>> =
      frame && frame.op === "applied"
        ? (frame.observations as Array<Record<string, unknown>>)
        : [];
    const objnf = observations.find((o) => o.type === "$error" && o.code === "E_OBJNF");
    expect(objnf).toBeUndefined();

    const enteredGarden = observations.some(
      (o) => o.type === "entered" && o.room === "the_garden"
    );
    expect(enteredGarden).toBe(true);

    // ---- CA3 ACTOR-ANCHORED MOVEMENT COMMIT ----
    //
    // The repaired cross-room move now commits at the actor's location
    // authority. Room contents are updated as projection state, not as a
    // fenced placement write.
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error(`expected accepted actor-location commit, got ${result.result.reason}`);
    expect(result.result.commit?.position.scope).toBe(actor);
    const after = createWorldFromSerialized(result.result.serializedAfter, { persist: false });
    expect(after.allLocationsForActor(actor)).toEqual(["the_garden"]);
  });

  it("CASE C: §VTN10.1 sparse guarded executor missing an object needed in the sequenced-call PREAMBLE returns missing_state, not a raw E_OBJNF / uncaught throw", async () => {
    const { fullSerialized, actor, sessionId } = await setupOnDeck();

    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "garden-move",
      route: "sequenced",
      scope: "the_deck",
      session: sessionId,
      actor,
      target: "the_deck",
      verb: "south",
      args: []
    };

    const planned = await runShadowTurnCall(authoritativePlanningWorld(fullSerialized), call);
    const key = shadowTurnKeyFromTranscript(planned.transcript);
    const realScope = key.scope;

    // The sequenced-call preamble in `applyCall` performs `this.object(spaceRef)`,
    // presence authorization, and a `next_seq` read on the SCOPE object BEFORE
    // `withTurnRecording` opens the recorder. If the scope object itself is
    // absent from a guarded executor's serialized slice, the §VTN10.1 in-run
    // probe cannot fire (activeTurnRecorder is null in the preamble).
    //
    // This is the preamble hole: before the fix, the preamble
    // `object(the_deck)` miss threw raw E_OBJNF, the call path swallowed it into
    // an error frame, and the executor surfaced an opaque "fresh turn produced
    // no recording" throw — never a repairable missing_state.
    //
    // To isolate the PREAMBLE path specifically, keep the executor's atom set
    // at the FULL key (so the pre-run `missingAtomsForShadowTurn` coverage check
    // passes and does NOT short-circuit to missing_state before execution) but
    // delete the_deck's serialized OBJECT. The only way the_deck can now miss is
    // the preamble lookup itself — which is exactly the code path VTN10.1
    // fixes. (CASE B already exercises reduced-key body convergence; CASE C
    // exercises the preamble entry point in isolation.)
    const sparseSerialized: SerializedWorld = {
      ...fullSerialized,
      objects: fullSerialized.objects.filter((o) => o.id !== "the_deck")
    };
    expect(sparseSerialized.objects.some((o) => o.id === "the_deck")).toBe(false);
    // Sanity: the executor still "claims" the full key, so any miss is a real
    // serialized-slice gap reached during execution, not a planning gap.
    expect(key.preimages.some((p) => p.includes("the_deck"))).toBe(true);

    const node = createShadowExecutionNode({
      node: "deck-exec-preamble",
      scope: realScope,
      atom_hashes: key.atom_hashes,
      serialized: sparseSerialized
    });

    // The executor must NOT throw an uncaught error; it must resolve to a clean
    // result the network repair loop can act on. (Anchor has the_deck, so once
    // repair pages it in the turn can proceed — though it may then surface a
    // FURTHER missing object or a downstream commit boundary; CASE C only owns
    // the preamble-miss property: the first pass is a repairable missing_state,
    // not a raw E_OBJNF and not an uncaught throw.)
    let result: Awaited<ReturnType<typeof executeShadowTurnCallAcrossInProcessNetwork>> | undefined;
    let threw: unknown;
    try {
      result = await executeShadowTurnCallAcrossInProcessNetwork({
        request: { kind: "woo.turn.exec.request.shadow.v1" as const, call, key },
        nodes: [node],
        ads: [buildShadowTurnExecAd({ node: "deck-exec-preamble", scope: realScope, key, factor: 0.1 })],
        anchor: { node: "anchor", serialized: fullSerialized },
        transferMode: "cell_pages"
        // Default maxTransfers (3) suffices: the preamble miss heals the_deck's
        // FULL object closure in one round (VTN10.1's full-object-closure
        // grant), and the re-run with the recorder open then proceeds to commit.
        // The retry budget is per-distinct-transitive-object and bounded; see
        // §VTN10.1.
      });
    } catch (err) {
      threw = err;
    }

    // The preamble miss must NOT propagate as an uncaught throw (that was the
    // bug: "fresh turn produced no recording" / raw E_OBJNF).
    expect(threw).toBeUndefined();
    expect(result).toBeDefined();

    // The FIRST pass — the preamble miss itself — must be a repairable
    // missing_state naming the_deck's lifecycle atom (what the in-run probe
    // would have produced had the recorder been open).
    expect(result!.first.ok).toBe(false);
    expect((result!.first as { reason?: string }).reason).toBe("missing_state");
    const firstMissing = (result!.first as { missing_atoms?: Array<{ preimage?: string }> }).missing_atoms ?? [];
    expect(firstMissing.some((a) => a.preimage === "read:cell:lifecycle:the_deck")).toBe(true);

    // At least one repair transfer was issued for the preamble-missed object —
    // i.e. the loop used the same lifecycle repair path rather than wedging on
    // the throw.
    expect(result!.transfers.length).toBeGreaterThanOrEqual(1);
    const deckTransfer = result!.transfers.find((t) =>
      ((t as { preimages?: string[] }).preimages ?? []).some((p) => p.includes("lifecycle:the_deck"))
    );
    expect(deckTransfer).toBeDefined();

    // CASE C OWNS the preamble-miss property only: a guarded preamble
    // materialization miss becomes a structured, repairable `missing_state`
    // (asserted above) instead of a raw E_OBJNF or an uncaught
    // "no recording" throw. It deliberately does NOT also assert full
    // end-to-end convergence — that is CASE B's job, on a body-reachable
    // reduced key.
    //
    // Why CASE C cannot cleanly assert full convergence here: to ISOLATE the
    // preamble path we keep the executor's atom set at the full key (so the
    // pre-run coverage check does not pre-empt execution) while deleting
    // the_deck's serialized object. After the preamble repair pages the_deck
    // back in, the re-run then walks the destination subtree (the_garden +
    // exits) AND, because the executor reconstructed the_deck's structural
    // cells fresh while the anchor advanced them, the move crosses the same
    // cross-scope §VTN8.1 commit boundary CASE B documents. Both outcomes are
    // structured results the caller handles — never the VTN10.1 preamble bug.
    // We therefore assert only the structured-outcome property here.
    const finalReason = result!.result.ok ? "ok" : (result!.result as { reason?: string }).reason;
    // The outcome must be a known structured result, not an opaque failure.
    expect(["ok", "missing_state", "commit_rejected"]).toContain(finalReason);
  });
});
