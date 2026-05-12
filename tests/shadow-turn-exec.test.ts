import { describe, expect, it } from "vitest";
import { installVerb } from "../src/core/authoring";
import { createWorld, createWorldFromSerialized } from "../src/core/bootstrap";
import { effectTranscriptFromRecordedTurn } from "../src/core/effect-transcript";
import {
  buildShadowClosureTransfer,
  createShadowExecutionNode,
  executeShadowRecordedTurnOrNeedState,
  installShadowStateTransfer,
  missingAtomsForShadowTurn
} from "../src/core/shadow-turn-exec";
import { InMemoryTurnRecorder } from "../src/core/turn-recorder";
import { shadowTurnKeyFromTranscript } from "../src/core/turn-key";

describe("shadow turn execution", () => {
  it("refuses missing state, installs a closure transfer, and retries the whole turn", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:shadow-retry");
    const actor = session.actor;
    anchor.createObject({ id: "retry_box", name: "Retry Box", parent: "$thing", owner: actor });
    anchor.defineProperty("retry_box", { name: "counter", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
    const installed = installVerb(
      anchor,
      "retry_box",
      "bump",
      `verb :bump() rxd {
        let before = this.counter;
        this.counter = before + 1;
        return this.counter;
      }`,
      null
    );
    expect(installed.ok).toBe(true);

    const serializedBefore = anchor.exportWorld();
    const recorder = new InMemoryTurnRecorder();
    anchor.setTurnRecorder(recorder);
    const anchorResult = await anchor.directCall("shadow-retry-bump", actor, "retry_box", "bump", [], { sessionId: session.id });
    expect(anchorResult.op).toBe("result");
    const plannedTranscript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
    const turnKey = shadowTurnKeyFromTranscript(plannedTranscript);

    const actorNode = createShadowExecutionNode({ node: "actor-node", scope: turnKey.scope });
    const refused = await executeShadowRecordedTurnOrNeedState(actorNode, recorder.turns[0], turnKey);

    expect(refused).toMatchObject({ ok: false, reason: "missing_state", attempted: false });
    if (!refused.ok && refused.reason === "missing_state") expect(refused.missing_atoms.map((atom) => atom.preimage)).toEqual(turnKey.preimages);
    expect(actorNode.serialized).toBeUndefined();

    const transfer = buildShadowClosureTransfer({
      serialized: serializedBefore,
      key: turnKey,
      atom_hashes: missingAtomsForShadowTurn(actorNode, turnKey).map((atom) => atom.hash)
    });
    expect(transfer).toMatchObject({ kind: "woo.state.transfer.shadow.v1", mode: "closure", scope: turnKey.scope });
    expect(transfer.atom_hashes).toEqual(turnKey.atom_hashes);
    installShadowStateTransfer(actorNode, transfer);

    const retry = await executeShadowRecordedTurnOrNeedState(actorNode, recorder.turns[0], turnKey);

    expect(retry).toMatchObject({ ok: true, attempted: true });
    if (!retry.ok) throw new Error(`retry failed: ${retry.reason}`);
    expect(retry.transcript.hash).toBe(plannedTranscript.hash);
    expect(retry.receipt).toMatchObject({ accepted: true, transcript_hash: plannedTranscript.hash });
    expect(retry.receipt.post_state_hash).not.toBe(retry.receipt.pre_state_hash);
    expect(missingAtomsForShadowTurn(actorNode, turnKey)).toEqual([]);

    const warmed = createWorldFromSerialized(retry.serializedAfter, { persist: false });
    expect(warmed.getProp("retry_box", "counter")).toBe(1);
  });
});
