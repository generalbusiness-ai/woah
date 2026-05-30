import { describe, expect, it } from "vitest";
import { createWorld, createWorldFromSerialized } from "../src/core/bootstrap";
import { createShadowExecutionNode } from "../src/core/shadow-turn-exec";
import { runShadowTurnCall, type ShadowTurnCall } from "../src/core/shadow-turn-call";
import {
  buildShadowTurnExecAd,
  executeShadowTurnCallAcrossInProcessNetwork
} from "../src/core/shadow-turn-network";
import { shadowTurnKeyFromTranscript } from "../src/core/turn-key";
import type { SerializedWorld } from "../src/core/repository";

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
// NOTE (scope of this branch): §VTN10.1 makes the miss VISIBLE and
// REPAIRABLE. The durable commit may still be rejected with a cross-scope
// version conflict, because writing `contents` on two rooms touches two
// commit scopes — that is §VTN8.1 (movement-as-transaction) territory,
// staged separately. CASE B therefore asserts the materialization recovery
// (the property §VTN10.1 owns), not the cross-scope commit outcome.
// See notes/2026-05-30-v2-materialization-miss-and-movement-tx.md.

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

describe("scope-executor garden probe", () => {
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

    const planned = await runShadowTurnCall(fullSerialized, call);

    // Report the frame so we can see op + any error code/message.
    // eslint-disable-next-line no-console
    console.log("CASE A frame:", JSON.stringify(planned.frame));
    // eslint-disable-next-line no-console
    console.log(
      "CASE A transcript.scope:",
      planned.transcript.scope,
      "complete:",
      planned.transcript.complete
    );

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
    // eslint-disable-next-line no-console
    console.log("CASE A write objects:", JSON.stringify(writeObjects));
    // eslint-disable-next-line no-console
    console.log("CASE A moves:", JSON.stringify(moveObjects));

    const key = shadowTurnKeyFromTranscript(planned.transcript);
    // eslint-disable-next-line no-console
    console.log("CASE A key.scope:", key.scope);
    // eslint-disable-next-line no-console
    console.log("CASE A key.preimages:", JSON.stringify(key.preimages));

    // The move should have applied (it is a sequenced room turn).
    expect(planned.frame.op).toBe("applied");

    // The single turn must reference the_garden somewhere (move dest or a
    // contents write), proving this is inherently a cross-room turn.
    const referencesGarden =
      moveObjects.some((m) => m.to === "the_garden") ||
      writeObjects.includes("the_garden") ||
      key.preimages.some((p) => p.includes("the_garden"));
    // eslint-disable-next-line no-console
    console.log("CASE A references the_garden:", referencesGarden);
    expect(referencesGarden).toBe(true);

    // Verify post-state if we got a snapshot.
    if ("serializedAfter" in planned) {
      const after = createWorldFromSerialized(planned.serializedAfter, { persist: false });
      // eslint-disable-next-line no-console
      console.log(
        "CASE A actor post-location:",
        JSON.stringify(after.allLocationsForActor(actor))
      );
      expect(after.allLocationsForActor(actor)).toEqual(["the_garden"]);
    }
  });

  it("CASE B: sparse atom-guarded executor missing the_garden recovers the materialization via the §VTN10.1 lifecycle probe", async () => {
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
    const planned = await runShadowTurnCall(fullSerialized, call);
    const key = shadowTurnKeyFromTranscript(planned.transcript);
    const realScope = key.scope;
    // eslint-disable-next-line no-console
    console.log("CASE B planned key.scope:", realScope);

    // Build a SPARSE serialized world: full state minus the_garden object.
    const sparseSerialized: SerializedWorld = {
      ...fullSerialized,
      objects: fullSerialized.objects.filter((o) => o.id !== "the_garden")
    };
    expect(sparseSerialized.objects.some((o) => o.id === "the_garden")).toBe(false);
    expect(sparseSerialized.objects.some((o) => o.id === "the_deck")).toBe(true);
    expect(sparseSerialized.objects.some((o) => o.id === "exit_deck_south")).toBe(true);
    expect(sparseSerialized.objects.some((o) => o.id === actor)).toBe(true);

    // Non-authoritative node WITH the atom guard active (no authoritative_state).
    const node = createShadowExecutionNode({
      node: "deck-exec",
      scope: realScope,
      atom_hashes: key.atom_hashes,
      serialized: sparseSerialized
    });

    const result = await executeShadowTurnCallAcrossInProcessNetwork({
      request: { kind: "woo.turn.exec.request.shadow.v1" as const, call, key },
      nodes: [node],
      ads: [buildShadowTurnExecAd({ node: "deck-exec", scope: realScope, key, factor: 0.1 })],
      // Anchor HAS the_garden, so repair fetches it when the loop asks.
      anchor: { node: "anchor", serialized: fullSerialized },
      transferMode: "cell_pages"
    });

    // eslint-disable-next-line no-console
    console.log("CASE B transfers count:", result.transfers.length);
    // eslint-disable-next-line no-console
    console.log("CASE B first:", JSON.stringify({ ok: result.first.ok, reason: (result.first as { reason?: string }).reason }));
    // eslint-disable-next-line no-console
    console.log(
      "CASE B transfer preimages:",
      JSON.stringify(result.transfers.map((t) => (t as { preimages?: string[] }).preimages ?? []))
    );

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
    // eslint-disable-next-line no-console
    console.log("CASE B silent E_OBJNF present:", objnf !== undefined);
    expect(objnf).toBeUndefined();

    const enteredGarden = observations.some(
      (o) => o.type === "entered" && o.room === "the_garden"
    );
    // eslint-disable-next-line no-console
    console.log("CASE B executor frame shows entered the_garden:", enteredGarden);
    expect(enteredGarden).toBe(true);

    // ---- §VTN8.1 BOUNDARY (NOT asserted here) ----
    //
    // The durable commit may still be rejected: the move writes `contents` on
    // both the_deck and the_garden, touching two commit scopes whose cell
    // versions differ at the authority (the executor reconstructed the_garden
    // cells fresh at version 0; the anchor holds them at version 1+). That
    // cross-scope reconciliation is movement-as-transaction (§VTN8.1) and is
    // staged separately. We therefore allow EITHER outcome for the commit and
    // only document what happened, so this test stays green when §VTN8.1
    // lands and flips it to ok.
    // eslint-disable-next-line no-console
    console.log(
      "CASE B commit outcome:",
      JSON.stringify({ ok: result.result.ok, reason: (result.result as { reason?: string }).reason })
    );
    if (result.result.ok) {
      // If/when §VTN8.1 lands, the cross-scope commit succeeds and the actor
      // ends up in the_garden. Assert that stronger property when available.
      const after = createWorldFromSerialized(
        (result.result as { serializedAfter: SerializedWorld }).serializedAfter,
        { persist: false }
      );
      expect(after.allLocationsForActor(actor)).toEqual(["the_garden"]);
    } else {
      // Until §VTN8.1 lands, the only allowed non-ok outcome is a cross-scope
      // commit conflict — NOT a missing_state (that would mean repair never
      // healed the materialization) and NOT a silent applied frame.
      const rejected = result.result as { reason?: string; commit?: { errors?: string[] } };
      expect(rejected.reason).toBe("commit_rejected");

      // §VTN8.1 BOUNDARY — pinned to the EXACT cell-level cause, not a generic
      // commit_rejected. The MV-A implementer must know which conflict class
      // this is: it is stale STRUCTURAL VERSIONS on the freshly-paged
      // destination room (the executor rebuilt the_garden's cells at version 0
      // while the anchor holds them at version >=1), NOT placement-authority
      // denial, NOT a session/activeScope conflict, NOT a transfer/
      // reconstruction failure. If this set ever changes, MV-A's design
      // assumptions changed and this test must be revisited.
      const errors = rejected.commit?.errors ?? [];
      // eslint-disable-next-line no-console
      console.log("CASE B commit_rejected errors:", JSON.stringify(errors));
      expect(errors.length).toBeGreaterThan(0);

      // Every reported error is a the_garden read/write version-or-value/prior
      // mismatch — the destination-room structural staleness MV-A must fence.
      const gardenStructuralConflict =
        /^(read|write) (version|value|prior) mismatch the_garden\./;
      expect(errors.every((e) => gardenStructuralConflict.test(e))).toBe(true);

      // Specifically the destination room's contents/subscribers placement cell
      // is among the conflicts — this is the cell MV-A's transaction must own.
      expect(errors.some((e) => /the_garden\.subscribers/.test(e))).toBe(true);

      // Negative guards: the rejection is NOT any other conflict class. These
      // would each point MV-A at the wrong problem.
      expect(errors.some((e) => /stale_head/.test(e))).toBe(false);
      expect(errors.some((e) => /permission|E_PERM|authority|denied/i.test(e))).toBe(false);
      expect(errors.some((e) => /session|active_?scope/i.test(e))).toBe(false);
      expect(errors.some((e) => /missing|unavailable|not found|E_OBJNF|E_NEED_STATE|incomplete/i.test(e))).toBe(false);
      // The conflict is on the destination room, not the source room — the
      // source scope is the executor's own and its cells are current.
      expect(errors.some((e) => /the_deck\./.test(e))).toBe(false);
    }
  });
});
