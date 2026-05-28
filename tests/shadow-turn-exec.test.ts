import { describe, expect, it } from "vitest";
import { installVerb } from "../src/core/authoring";
import { createWorld, createWorldFromSerialized } from "../src/core/bootstrap";
import { capabilityAdProbablyCoversTurn } from "../src/core/capability-ad";
import { effectTranscriptFromRecordedTurn } from "../src/core/effect-transcript";
import { createShadowCommitScope, serializedFor, submitShadowCommit } from "../src/core/shadow-commit-scope";
import {
  buildShadowCellPageTransfer,
  buildShadowClosureTransfer,
  buildShadowObjectRecordTransfer,
  createShadowExecutionNode,
  executeAuthoritativeShadowTurnCall,
  executeShadowRecordedTurnOrNeedState,
  executeShadowTurnCallOrNeedState,
  installShadowStateTransfer,
  missingAtomsForShadowTurn,
  validateShadowExecutionCapsuleTransfer
} from "../src/core/shadow-turn-exec";
import { shadowObjectLivePage, shadowStatePageHash } from "../src/core/shadow-state-pages";
import { runShadowTurnCall, runShadowTurnCallTranscript, type ShadowTurnCall } from "../src/core/shadow-turn-call";
import { buildShadowTurnExecAd, buildShadowTurnExecAdFromNode, executeShadowTurnCallAcrossInProcessNetwork } from "../src/core/shadow-turn-network";
import { InMemoryTurnRecorder } from "../src/core/turn-recorder";
import { shadowTurnKeyFromTranscript, type ShadowTurnKey } from "../src/core/turn-key";
import type { MetricEvent } from "../src/core/types";

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

  it("executes a fresh TurnCall after state transfer for an existing dubspace catalog action", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:shadow-catalog-turn");
    const actor = session.actor;
    anchor.setProp("the_dubspace", "operators", [actor]);

    const serializedBefore = anchor.exportWorld();
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-catalog-set-control",
      route: "sequenced",
      scope: "the_dubspace",
      session: session.id,
      actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.66]
    };
    const planned = await runShadowTurnCall(serializedBefore, call);
    expect(planned.frame).toMatchObject({ op: "applied", space: "the_dubspace", seq: 1 });
    expect(planned.transcript.complete).toBe(true);
    const key = shadowTurnKeyFromTranscript(planned.transcript);
    const request = { kind: "woo.turn.exec.request.shadow.v1" as const, call, key };
    const actorNode = createShadowExecutionNode({ node: "actor-node", scope: key.scope });
    const routed = await executeShadowTurnCallAcrossInProcessNetwork({
      request,
      nodes: [actorNode],
      ads: [buildShadowTurnExecAd({ node: "actor-node", scope: key.scope, key, factor: 0.1 })],
      anchor: { node: "stable-anchor", serialized: serializedBefore }
    });

    expect(routed).toMatchObject({
      selected_node: "actor-node",
      first: { ok: false, reason: "missing_state", attempted: false },
      transfer: { kind: "woo.state.transfer.shadow.v1", mode: "cell_pages", scope: "the_dubspace" },
      result: { ok: true, attempted: true }
    });
    if (!routed.result.ok) throw new Error(`fresh call retry failed: ${routed.result.reason}`);
    expect(routed.result.frame).toMatchObject({ op: "applied", space: "the_dubspace", seq: 1 });
    expect(routed.result.transcript.hash).toBe(planned.transcript.hash);
    expect(routed.result.receipt).toMatchObject({ accepted: true, transcript_hash: planned.transcript.hash });
    expect(routed.result.transcript.observations).toContainEqual(expect.objectContaining({
      type: "control_changed",
      source: "the_dubspace",
      target: "delay_1",
      name: "wet",
      value: 0.66
    }));

    const warmed = createWorldFromSerialized(routed.result.serializedAfter, { persist: false });
    expect(warmed.getProp("delay_1", "wet")).toBe(0.66);
    expect(warmed.replay("the_dubspace", 1, 10)).toHaveLength(1);
  });

  it("accepts browser-planned hot tub entry after the sequencer was allocated before recording", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:shadow-hot-tub-enter");
    const actor = session.actor;

    const enterChatroom = await anchor.call("setup-enter-chatroom", session.id, "the_chatroom", {
      actor,
      target: "the_chatroom",
      verb: "enter",
      args: []
    });
    expect(enterChatroom.op).toBe("applied");
    const moveToDeck = await anchor.call("setup-move-deck", session.id, "the_chatroom", {
      actor,
      target: "the_chatroom",
      verb: "southeast",
      args: []
    });
    expect(moveToDeck.op).toBe("applied");
    expect(anchor.getProp("the_hot_tub", "next_seq")).toBe(1);

    const serializedBefore = anchor.exportWorld();
    const enterTub = await runShadowTurnCall(serializedBefore, {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-hot-tub-enter",
      route: "sequenced",
      scope: "the_hot_tub",
      session: session.id,
      actor,
      target: "the_hot_tub",
      verb: "enter",
      args: []
    });
    expect(enterTub.frame).toMatchObject({ op: "applied", space: "the_hot_tub", seq: 1 });
    // enrichScopedMoveResult builds a post-move room snapshot after applyCall
    // has allocated seq 1. The transcript therefore legitimately observes
    // scope.next_seq as 2 even though pre-commit authority state still has 1.
    expect(enterTub.transcript.reads).toContainEqual(expect.objectContaining({
      cell: { kind: "prop", object: "the_hot_tub", name: "next_seq" },
      value: 2
    }));
    expect(enterTub.transcript.writes).not.toContainEqual(expect.objectContaining({
      cell: { kind: "prop", object: "the_hot_tub", name: "next_seq" }
    }));

    const commitScope = createShadowCommitScope({ node: "stable-anchor", scope: "the_hot_tub", serialized: serializedBefore });
    const accepted = submitShadowCommit(commitScope, {
      kind: "woo.commit.submit.shadow.v1",
      id: "shadow-hot-tub-enter",
      scope: "the_hot_tub",
      expected: structuredClone(commitScope.head),
      transcript: enterTub.transcript
    });
    expect(accepted).toMatchObject({ kind: "woo.commit.accepted.shadow.v1" });

    const serializedAfterEnter = serializedFor(commitScope);
    const afterEnter = createWorldFromSerialized(serializedAfterEnter, { persist: false });
    expect(afterEnter.getProp("the_hot_tub", "next_seq")).toBe(2);
    expect(afterEnter.allLocationsForActor(actor)).toEqual(["the_hot_tub"]);

    const exitTub = await runShadowTurnCall(serializedAfterEnter, {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-hot-tub-out",
      route: "sequenced",
      scope: "the_hot_tub",
      session: session.id,
      actor,
      target: "the_hot_tub",
      verb: "out",
      args: []
    });
    expect(exitTub.frame).toMatchObject({ op: "applied", space: "the_hot_tub", seq: 2 });
    const acceptedExit = submitShadowCommit(commitScope, {
      kind: "woo.commit.submit.shadow.v1",
      id: "shadow-hot-tub-out",
      scope: "the_hot_tub",
      expected: structuredClone(commitScope.head),
      transcript: exitTub.transcript
    });
    expect(acceptedExit).toMatchObject({ kind: "woo.commit.accepted.shadow.v1" });
    expect(createWorldFromSerialized(serializedFor(commitScope), { persist: false }).getProp("the_hot_tub", "next_seq")).toBe(3);
  });

  it("uses granular transfer to fill a real inventory gap for a dubspace action", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:shadow-granular-turn");
    const actor = session.actor;
    await anchor.directCall("shadow-granular-enter", actor, "the_dubspace", "enter", [], { sessionId: session.id });

    const serializedBefore = anchor.exportWorld();
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-granular-set-control",
      route: "sequenced",
      scope: "the_dubspace",
      session: session.id,
      actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.72]
    };
    const planned = await runShadowTurnCall(serializedBefore, call);
    const key = shadowTurnKeyFromTranscript(planned.transcript);
    const request = { kind: "woo.turn.exec.request.shadow.v1" as const, call, key };
    const writeHash = key.write_atom_hashes[0];
    const preloadedHashes = key.atom_hashes.filter((hash) => hash !== writeHash);
    const partialNode = createShadowExecutionNode({ node: "partial-actor", scope: key.scope });
    installShadowStateTransfer(partialNode, buildShadowObjectRecordTransfer({
      serialized: serializedBefore,
      key,
      atom_hashes: preloadedHashes,
      session: session.id
    }));

    expect(missingAtomsForShadowTurn(partialNode, key).map((atom) => atom.preimage)).toEqual([
      "write:cell:prop:delay_1.wet"
    ]);
    expect(capabilityAdProbablyCoversTurn(buildShadowTurnExecAdFromNode({ node: partialNode, accepts: key, factor: 0.1 }), key)).toBe(false);
    const staleAd = buildShadowTurnExecAd({ node: "partial-actor", scope: key.scope, key, factor: 0.1 });
    expect(capabilityAdProbablyCoversTurn(staleAd, key)).toBe(true);

    const routed = await executeShadowTurnCallAcrossInProcessNetwork({
      request,
      nodes: [partialNode],
      // This intentionally models a stale Bloom ad: gossip claimed the old
      // executor covered the turn, but the node's exact inventory is missing
      // the write cell and must request granular state before execution.
      ads: [staleAd],
      anchor: { node: "stable-anchor", serialized: serializedBefore }
    });

    expect(routed.first).toMatchObject({ ok: false, reason: "missing_state", attempted: false });
    expect(routed.transfers).toHaveLength(1);
    expect(routed.transfer).toMatchObject({
      kind: "woo.state.transfer.shadow.v1",
      mode: "cell_pages",
      scope: "the_dubspace",
      atom_hashes: [writeHash],
      preimages: ["write:cell:prop:delay_1.wet"]
    });
    if (!routed.transfer || routed.transfer.mode !== "cell_pages") throw new Error("expected cell-page transfer");
    const transferredPageObjects = routed.transfer.page_refs.map((page) => page.object);
    expect(transferredPageObjects).toContain("delay_1");
    expect(transferredPageObjects).not.toContain("slot_1");
    expect(routed.transfer.page_refs.find((page) => page.object === "delay_1" && page.page === "property_cell" && page.name === "wet")).toMatchObject({
      inline: true
    });
    expect(routed.transfer.inline_pages.length).toBeLessThan(
      serializedBefore.objects.reduce((sum, obj) => sum + obj.properties.length + obj.verbs.length + 2, 0)
    );
    expect(Buffer.byteLength(JSON.stringify(routed.transfer), "utf8")).toBeLessThan(
      Buffer.byteLength(JSON.stringify(serializedBefore), "utf8")
    );

    expect(routed.result).toMatchObject({ ok: true, attempted: true });
    if (!routed.result.ok) throw new Error(`granular retry failed: ${routed.result.reason}`);
    expect(routed.result.transcript.hash).toBe(planned.transcript.hash);
    expect(routed.result.receipt.accepted).toBe(true);
    expect(createWorldFromSerialized(routed.result.serializedAfter, { persist: false }).getProp("delay_1", "wet")).toBe(0.72);
  });

  it("commits fresh network execution through a shadow commit scope and rejects stale heads", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:shadow-commit-scope");
    const actor = session.actor;
    await anchor.directCall("shadow-commit-scope-enter", actor, "the_dubspace", "enter", [], { sessionId: session.id });

    const serializedBefore = anchor.exportWorld();
    const commitScope = createShadowCommitScope({ node: "stable-anchor", scope: "the_dubspace", serialized: serializedBefore });
    const initialHead = structuredClone(commitScope.head);
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-commit-scope-wet",
      route: "sequenced",
      scope: "the_dubspace",
      session: session.id,
      actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.58]
    };
    const key = shadowTurnKeyFromTranscript((await runShadowTurnCall(serializedBefore, call)).transcript);
    const routed = await executeShadowTurnCallAcrossInProcessNetwork({
      request: { kind: "woo.turn.exec.request.shadow.v1" as const, call, key, expected: initialHead },
      nodes: [createShadowExecutionNode({ node: "actor-node", scope: key.scope })],
      ads: [buildShadowTurnExecAd({ node: "actor-node", scope: key.scope, key, factor: 0.1 })],
      anchor: { node: "stable-anchor", serialized: serializedBefore },
      commitScope
    });

    expect(routed.result).toMatchObject({
      ok: true,
      commit: { kind: "woo.commit.accepted.shadow.v1", position: { scope: "the_dubspace", seq: 1 } },
      reply: { kind: "woo.turn.exec.reply.shadow.v1", ok: true, commit: { kind: "woo.commit.accepted.shadow.v1" } }
    });
    if (!routed.result.ok) throw new Error(`commit-scope execution failed: ${routed.result.reason}`);
    expect(commitScope.head.seq).toBe(1);
    expect(createWorldFromSerialized(serializedFor(commitScope), { persist: false }).getProp("delay_1", "wet")).toBe(0.58);
    expect(serializedFor(commitScope).objects.length).toBe(serializedBefore.objects.length);

    const staleCall: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-commit-scope-stale",
      route: "sequenced",
      scope: "the_dubspace",
      session: session.id,
      actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.59]
    };
    const staleKey = shadowTurnKeyFromTranscript((await runShadowTurnCall(serializedBefore, staleCall)).transcript);
    const staleNode = createShadowExecutionNode({
      node: "stale-actor",
      scope: staleKey.scope,
      atom_hashes: staleKey.atom_hashes,
      serialized: serializedBefore
    });
    const stale = await executeShadowTurnCallOrNeedState(staleNode, {
      kind: "woo.turn.exec.request.shadow.v1",
      call: staleCall,
      key: staleKey,
      expected: initialHead
    }, { commitScope });

    expect(stale).toMatchObject({
      ok: false,
      reason: "commit_rejected",
      commit: { kind: "woo.commit.conflict.shadow.v1", reason: "stale_head" },
      reply: { kind: "woo.turn.exec.reply.shadow.v1", ok: false, reason: "commit_rejected" }
    });
    expect(createWorldFromSerialized(serializedFor(commitScope), { persist: false }).getProp("delay_1", "wet")).toBe(0.58);
    expect(createWorldFromSerialized(staleNode.serialized!, { persist: false }).getProp("delay_1", "wet")).not.toBe(0.59);
  });

  it("does not export executor post-state for durable commit-scope TurnCall execution", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:shadow-transcript-only-exec");
    const actor = session.actor;
    await anchor.directCall("shadow-transcript-only-enter", actor, "the_dubspace", "enter", [], { sessionId: session.id });

    const serializedBefore = anchor.exportWorld();
    const commitScope = createShadowCommitScope({ node: "stable-anchor", scope: "the_dubspace", serialized: serializedBefore });
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-transcript-only-wet",
      route: "sequenced",
      scope: "the_dubspace",
      session: session.id,
      actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.62]
    };
    const planned = await runShadowTurnCallTranscript(serializedBefore, call);
    expect("serializedAfter" in planned).toBe(false);
    const key = shadowTurnKeyFromTranscript(planned.transcript);
    const executorWorld = createWorldFromSerialized(serializedBefore, { persist: false });
    let postStateExports = 0;
    executorWorld.exportWorld = () => {
      postStateExports += 1;
      throw new Error("executor post-state export should not run for durable commit-scope execution");
    };
    const node = createShadowExecutionNode({
      node: "actor-node",
      scope: key.scope,
      atom_hashes: key.atom_hashes,
      serialized: serializedBefore
    });
    node.world = executorWorld;

    const result = await executeShadowTurnCallOrNeedState(node, {
      kind: "woo.turn.exec.request.shadow.v1",
      call,
      key,
      expected: commitScope.head
    }, { commitScope });

    expect(result).toMatchObject({ ok: true, attempted: true });
    if (!result.ok) throw new Error(`transcript-only commit failed: ${result.reason}`);
    expect(postStateExports).toBe(0);
    expect(result.transcript.hash).toBe(planned.transcript.hash);
    expect(result.receipt).toMatchObject({ accepted: true, transcript_hash: planned.transcript.hash });
    expect(createWorldFromSerialized(serializedFor(commitScope), { persist: false }).getProp("delay_1", "wet")).toBe(0.62);
    expect(createWorldFromSerialized(result.serializedAfter, { persist: false }).getProp("delay_1", "wet")).toBe(0.62);
  });

  it("does not require executor post-state when a transcript-only commit is rejected", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:shadow-transcript-only-rejected");
    const actor = session.actor;
    await anchor.directCall("shadow-transcript-only-rejected-enter", actor, "the_dubspace", "enter", [], { sessionId: session.id });

    const serializedBefore = anchor.exportWorld();
    const commitScope = createShadowCommitScope({ node: "stable-anchor", scope: "the_dubspace", serialized: serializedBefore });
    const initialHead = structuredClone(commitScope.head);
    const acceptedCall: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-transcript-only-accepted",
      route: "sequenced",
      scope: "the_dubspace",
      session: session.id,
      actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.64]
    };
    const acceptedPlan = await runShadowTurnCallTranscript(serializedBefore, acceptedCall);
    const acceptedKey = shadowTurnKeyFromTranscript(acceptedPlan.transcript);
    const acceptedNode = createShadowExecutionNode({
      node: "accepted-node",
      scope: acceptedKey.scope,
      atom_hashes: acceptedKey.atom_hashes,
      serialized: serializedBefore
    });
    const accepted = await executeShadowTurnCallOrNeedState(acceptedNode, {
      kind: "woo.turn.exec.request.shadow.v1",
      call: acceptedCall,
      key: acceptedKey,
      expected: initialHead
    }, { commitScope });
    expect(accepted).toMatchObject({ ok: true, attempted: true });
    if (!accepted.ok) throw new Error(`initial transcript-only commit failed: ${accepted.reason}`);

    const staleCall: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-transcript-only-rejected",
      route: "sequenced",
      scope: "the_dubspace",
      session: session.id,
      actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.65]
    };
    const stalePlan = await runShadowTurnCallTranscript(serializedBefore, staleCall);
    expect("serializedAfter" in stalePlan).toBe(false);
    const staleKey = shadowTurnKeyFromTranscript(stalePlan.transcript);
    const executorWorld = createWorldFromSerialized(serializedBefore, { persist: false });
    let postStateExports = 0;
    // A rejected durable commit should return on the transcript result alone.
    executorWorld.exportWorld = () => {
      postStateExports += 1;
      throw new Error("executor post-state export should not run for rejected durable commit-scope execution");
    };
    const staleNode = createShadowExecutionNode({
      node: "stale-node",
      scope: staleKey.scope,
      atom_hashes: staleKey.atom_hashes,
      serialized: serializedBefore
    });
    staleNode.world = executorWorld;

    const rejected = await executeShadowTurnCallOrNeedState(staleNode, {
      kind: "woo.turn.exec.request.shadow.v1",
      call: staleCall,
      key: staleKey,
      expected: initialHead
    }, { commitScope });

    expect(rejected).toMatchObject({
      ok: false,
      reason: "commit_rejected",
      commit: { kind: "woo.commit.conflict.shadow.v1", reason: "stale_head" },
      reply: { kind: "woo.turn.exec.reply.shadow.v1", ok: false, reason: "commit_rejected" }
    });
    if (rejected.ok || rejected.reason !== "commit_rejected") throw new Error("expected stale transcript-only commit rejection");
    expect(postStateExports).toBe(0);
    expect(rejected.transcript.hash).toBe(stalePlan.transcript.hash);
    expect(createWorldFromSerialized(serializedFor(commitScope), { persist: false }).getProp("delay_1", "wet")).toBe(0.64);
    expect(createWorldFromSerialized(staleNode.serialized!, { persist: false }).getProp("delay_1", "wet")).not.toBe(0.65);
  });

  it("runs authoritative relay intents against one VM pass and rejects stale expected heads", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:shadow-authoritative-stale");
    const actor = session.actor;
    await anchor.directCall("shadow-authoritative-stale-enter", actor, "the_dubspace", "enter", [], { sessionId: session.id });
    anchor.setProp("the_dubspace", "operators", [actor]);

    const serializedBefore = anchor.exportWorld();
    const commitScope = createShadowCommitScope({ node: "stable-anchor", scope: "the_dubspace", serialized: serializedBefore });
    const initialHead = structuredClone(commitScope.head);
    const acceptedNode = createShadowExecutionNode({
      node: "authoritative-accepted",
      scope: "the_dubspace",
      serialized: serializedFor(commitScope),
      authoritative_state: true
    });
    const acceptedCall: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-authoritative-accepted",
      route: "sequenced",
      scope: "the_dubspace",
      session: session.id,
      actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.71]
    };
    const accepted = await executeAuthoritativeShadowTurnCall(acceptedNode, {
      id: acceptedCall.id,
      call: acceptedCall,
      expected: initialHead,
      commitScope
    });
    expect(accepted).toMatchObject({ ok: true, attempted: true, commit: { position: { seq: 1 } } });

    const staleNode = createShadowExecutionNode({
      node: "authoritative-stale",
      scope: "the_dubspace",
      serialized: serializedBefore,
      authoritative_state: true
    });
    const staleCall: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-authoritative-stale",
      route: "sequenced",
      scope: "the_dubspace",
      session: session.id,
      actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.72]
    };
    const stale = await executeAuthoritativeShadowTurnCall(staleNode, {
      id: staleCall.id,
      call: staleCall,
      expected: initialHead,
      commitScope
    });

    expect(stale).toMatchObject({
      ok: false,
      reason: "commit_rejected",
      commit: { kind: "woo.commit.conflict.shadow.v1", reason: "stale_head" }
    });
    expect(staleNode.world).toBeUndefined();
    expect(createWorldFromSerialized(serializedFor(commitScope), { persist: false }).getProp("delay_1", "wet")).toBe(0.71);
  });

  it("refreshes authoritative executor caches only for moved objects and containers", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:shadow-authoritative-move");
    const actor = session.actor;
    await anchor.directCall("shadow-authoritative-move-enter", actor, "the_chatroom", "enter", [], { sessionId: session.id });

    const commitScope = createShadowCommitScope({ node: "stable-anchor", scope: "the_chatroom", serialized: anchor.exportWorld() });
    const node = createShadowExecutionNode({
      node: "authoritative-move",
      scope: "the_chatroom",
      serialized: serializedFor(commitScope),
      authoritative_state: true
    });
    expect(node.page_hashes.size).toBe(0);
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-authoritative-take",
      route: "sequenced",
      scope: "the_chatroom",
      session: session.id,
      actor,
      target: "the_chatroom",
      verb: "take",
      args: ["mug"]
    };

    const result = await executeAuthoritativeShadowTurnCall(node, {
      id: call.id,
      call,
      expected: commitScope.head,
      commitScope
    });

    expect(result).toMatchObject({ ok: true, attempted: true });
    if (!result.ok) throw new Error("expected authoritative move to commit");
    const moved = result.transcript.moves[0]?.object;
    if (!moved) throw new Error("expected take to record a move");
    const byId = new Map(serializedFor(commitScope).objects.map((obj) => [obj.id, obj] as const));
    const actorObj = byId.get(actor);
    const roomObj = byId.get("the_chatroom");
    const mugObj = byId.get(moved);
    if (!actorObj || !roomObj || !mugObj) throw new Error("expected actor, room, and mug serialized objects");
    expect(mugObj.location).toBe(actor);
    expect(actorObj.contents).toContain(moved);
    expect(roomObj.contents).not.toContain(moved);
    expect(node.page_hashes.has(shadowStatePageHash(shadowObjectLivePage(actorObj)))).toBe(true);
    expect(node.page_hashes.has(shadowStatePageHash(shadowObjectLivePage(roomObj)))).toBe(true);
    expect(node.page_hashes.has(shadowStatePageHash(shadowObjectLivePage(mugObj)))).toBe(true);
  });

  it("merges accepted commit state at cell granularity", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:shadow-cell-merge");
    const actor = session.actor;
    anchor.createObject({ id: "merge_box", name: "Merge Box", parent: "$thing", owner: actor });
    anchor.defineProperty("merge_box", { name: "wet", defaultValue: 0, owner: actor, perms: "rw", typeHint: "num" });
    anchor.defineProperty("merge_box", { name: "feedback", defaultValue: 0, owner: actor, perms: "rw", typeHint: "num" });
    expect(installVerb(anchor, "merge_box", "set_wet", `verb :set_wet(value) rxd {
      this.wet = value;
      return this.wet;
    }`, null).ok).toBe(true);
    expect(installVerb(anchor, "merge_box", "set_feedback", `verb :set_feedback(value) rxd {
      this.feedback = value;
      return this.feedback;
    }`, null).ok).toBe(true);

    const wetCall: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-cell-merge-wet",
      route: "direct",
      scope: "merge_box",
      session: session.id,
      actor,
      target: "merge_box",
      verb: "set_wet",
      args: [0.44]
    };
    const serializedBefore = anchor.exportWorld();
    const wetRun = await runShadowTurnCall(serializedBefore, wetCall);
    const commitScopeRef = wetRun.transcript.scope;
    const commitScope = createShadowCommitScope({ node: "stable-anchor", scope: commitScopeRef, serialized: serializedBefore });
    const wetAccepted = submitShadowCommit(commitScope, {
      kind: "woo.commit.submit.shadow.v1",
      id: "shadow-cell-merge-wet",
      scope: commitScopeRef,
      expected: structuredClone(commitScope.head),
      transcript: wetRun.transcript
    });
    expect(wetAccepted.kind).toBe("woo.commit.accepted.shadow.v1");
    expect(createWorldFromSerialized(serializedFor(commitScope), { persist: false }).getProp("merge_box", "wet")).toBe(0.44);

    const feedbackCall: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-cell-merge-feedback",
      route: "direct",
      scope: "merge_box",
      session: session.id,
      actor,
      target: "merge_box",
      verb: "set_feedback",
      args: [0.37]
    };
    const staleFeedbackRun = await runShadowTurnCall(serializedBefore, feedbackCall);
    expect(staleFeedbackRun.transcript.scope).toBe(commitScopeRef);
    const feedbackAccepted = submitShadowCommit(commitScope, {
      kind: "woo.commit.submit.shadow.v1",
      id: "shadow-cell-merge-feedback",
      scope: commitScopeRef,
      expected: structuredClone(commitScope.head),
      transcript: staleFeedbackRun.transcript
    });

    expect(feedbackAccepted.kind).toBe("woo.commit.accepted.shadow.v1");
    const committed = createWorldFromSerialized(serializedFor(commitScope), { persist: false });
    expect(committed.getProp("merge_box", "wet")).toBe(0.44);
    expect(committed.getProp("merge_box", "feedback")).toBe(0.37);
  });

  it("applies durable commits through indexed scope state without full array indexing phases", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:shadow-indexed-commit");
    const actor = session.actor;
    anchor.createObject({ id: "indexed_box", name: "Indexed Box", parent: "$thing", owner: actor });
    anchor.defineProperty("indexed_box", { name: "wet", defaultValue: 0, owner: actor, perms: "rw", typeHint: "num" });
    expect(installVerb(anchor, "indexed_box", "set_wet", `verb :set_wet(value) rxd {
      this.wet = value;
      return this.wet;
    }`, null).ok).toBe(true);
    for (let index = 0; index < 130; index += 1) {
      anchor.createObject({ id: `indexed_filler_${index}`, name: `Indexed Filler ${index}`, parent: "$thing", owner: actor });
    }

    const serializedBefore = anchor.exportWorld();
    serializedBefore.tombstones = [];
    expect(serializedBefore.objects.length).toBeGreaterThan(100);
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-indexed-commit-wet",
      route: "direct",
      scope: "indexed_box",
      session: session.id,
      actor,
      target: "indexed_box",
      verb: "set_wet",
      args: [0.41]
    };
    const run = await runShadowTurnCallTranscript(serializedBefore, call);
    const commitScope = createShadowCommitScope({ node: "stable-anchor", scope: run.transcript.scope, serialized: serializedBefore });
    const steps: Array<{ phase: string; objects: number }> = [];
    const metrics: MetricEvent[] = [];
    const accepted = submitShadowCommit(commitScope, {
      kind: "woo.commit.submit.shadow.v1",
      id: "shadow-indexed-commit-wet",
      scope: run.transcript.scope,
      expected: structuredClone(commitScope.head),
      transcript: run.transcript,
      profile: (event) => steps.push({ phase: event.phase, objects: event.objects }),
      metric: (event) => metrics.push(event)
    });

    expect(accepted.kind).toBe("woo.commit.accepted.shadow.v1");
    expect(steps.map((step) => step.phase)).toEqual([
      "apply_creates",
      "collect_writes",
      "apply_writes",
      "apply_session",
      "apply_log",
      "counters",
      "total"
    ]);
    expect(steps.map((step) => step.phase)).not.toEqual(expect.arrayContaining(["clone_world", "index_objects", "sort_objects"]));
    expect(steps.every((step) => step.objects === serializedBefore.objects.length)).toBe(true);
    expect(commitScope.state.objectsById.size).toBe(serializedBefore.objects.length);
    expect(commitScope.state.snapshots).not.toBe(serializedBefore.snapshots);
    expect(commitScope.state.parkedTasks).not.toBe(serializedBefore.parkedTasks);
    expect(commitScope.state.tombstones).not.toBe(serializedBefore.tombstones);
    expect(metrics.filter((event) => event.kind === "serialized_world_materialized")).toEqual([]);
    const materialized = serializedFor(commitScope, { reason: "test_boundary", metric: (event) => metrics.push(event) });
    expect(createWorldFromSerialized(materialized, { persist: false }).getProp("indexed_box", "wet")).toBe(0.41);
    expect(metrics.filter((event) => event.kind === "serialized_world_materialized")).toHaveLength(1);
    serializedFor(commitScope, { reason: "test_boundary", metric: (event) => metrics.push(event) });
    expect(metrics.filter((event) => event.kind === "serialized_world_materialized")).toHaveLength(1);
  });

  it("deduplicates submissions by intent id and transcript hash", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:shadow-submit-transcript-key");
    const actor = session.actor;
    anchor.createObject({ id: "submit_box", name: "Submit Box", parent: "$thing", owner: actor });
    anchor.defineProperty("submit_box", { name: "value", defaultValue: 0, owner: actor, perms: "rw", typeHint: "num" });
    expect(installVerb(anchor, "submit_box", "set_value", `verb :set_value(value) rxd {
      this.value = value;
      return this.value;
    }`, null).ok).toBe(true);

    const firstCall: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "same-user-action",
      route: "direct",
      scope: "submit_box",
      session: session.id,
      actor,
      target: "submit_box",
      verb: "set_value",
      args: [1]
    };
    const serializedBefore = anchor.exportWorld();
    const firstRun = await runShadowTurnCall(serializedBefore, firstCall);
    const commitScope = createShadowCommitScope({ node: "stable-anchor", scope: firstRun.transcript.scope, serialized: serializedBefore });
    const firstAccepted = submitShadowCommit(commitScope, {
      kind: "woo.commit.submit.shadow.v1",
      id: "same-user-action",
      scope: firstRun.transcript.scope,
      expected: structuredClone(commitScope.head),
      transcript: firstRun.transcript
    });
    expect(firstAccepted.kind).toBe("woo.commit.accepted.shadow.v1");
    expect(createWorldFromSerialized(serializedFor(commitScope), { persist: false }).getProp("submit_box", "value")).toBe(1);

    const replayedCall: ShadowTurnCall = {
      ...firstCall,
      args: [2]
    };
    const replayedRun = await runShadowTurnCall(serializedFor(commitScope), replayedCall);
    expect(replayedRun.transcript.hash).not.toBe(firstRun.transcript.hash);
    const replayedAccepted = submitShadowCommit(commitScope, {
      kind: "woo.commit.submit.shadow.v1",
      id: "same-user-action",
      scope: replayedRun.transcript.scope,
      expected: structuredClone(commitScope.head),
      transcript: replayedRun.transcript
    });

    expect(replayedAccepted.kind).toBe("woo.commit.accepted.shadow.v1");
    expect(createWorldFromSerialized(serializedFor(commitScope), { persist: false }).getProp("submit_box", "value")).toBe(2);
    const duplicate = submitShadowCommit(commitScope, {
      kind: "woo.commit.submit.shadow.v1",
      id: "same-user-action",
      scope: replayedRun.transcript.scope,
      expected: structuredClone(commitScope.head),
      transcript: replayedRun.transcript
    });
    expect(duplicate).toEqual(replayedAccepted);
  });

  it("rejects tampered writes that borrow authority from an unrelated verb read", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:shadow-write-authority");
    const actor = session.actor;
    anchor.createObject({ id: "actor_box", name: "Actor Box", parent: "$thing", owner: actor });
    anchor.defineProperty("actor_box", { name: "value", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
    anchor.createObject({ id: "admin_box", name: "Admin Box", parent: "$thing", owner: "$wiz" });
    anchor.defineProperty("admin_box", { name: "value", defaultValue: 0, owner: "$wiz", perms: "r", typeHint: "int" });
    expect(installVerb(anchor, "actor_box", "set_value", `verb :set_value(value) rxd {
      this.value = value;
      return this.value;
    }`, null).ok).toBe(true);
    expect(installVerb(anchor, "admin_box", "noop", `verb :noop() rxd {
      return 1;
    }`, null).ok).toBe(true);

    const serializedBefore = anchor.exportWorld();
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-write-authority",
      route: "direct",
      scope: "actor_box",
      session: session.id,
      actor,
      target: "actor_box",
      verb: "set_value",
      args: [1]
    };
    const planned = await runShadowTurnCall(serializedBefore, call);
    const tampered = structuredClone(planned.transcript);
    const adminVerb = serializedBefore.objects.find((obj) => obj.id === "admin_box")?.verbs.find((verb) => verb.name === "noop");
    expect(adminVerb).toBeDefined();
    tampered.reads.push({
      cell: { kind: "verb", object: "admin_box", name: "noop" },
      version: String(adminVerb!.version),
      value: {
        implementation: adminVerb!.kind,
        owner: adminVerb!.owner,
        source_hash: adminVerb!.source_hash,
        direct_callable: adminVerb!.direct_callable === true,
        native: adminVerb!.kind === "native" ? adminVerb!.native : null,
        version: adminVerb!.version
      }
    });
    for (const write of tampered.writes) {
      if (write.cell.kind === "prop" && write.cell.object === "actor_box" && write.cell.name === "value") {
        expect(write.writer?.progr).toBe(actor);
        write.cell = { kind: "prop", object: "admin_box", name: "value" };
      }
    }
    for (const read of tampered.reads) {
      if (read.cell.kind === "prop" && read.cell.object === "actor_box" && read.cell.name === "value") {
        read.cell = { kind: "prop", object: "admin_box", name: "value" };
      }
    }

    const commitScope = createShadowCommitScope({ node: "stable-anchor", scope: planned.transcript.scope, serialized: serializedBefore });
    const rejected = submitShadowCommit(commitScope, {
      kind: "woo.commit.submit.shadow.v1",
      id: "shadow-write-authority-tampered",
      scope: planned.transcript.scope,
      expected: structuredClone(commitScope.head),
      transcript: tampered
    });

    expect(rejected.kind).toBe("woo.commit.conflict.shadow.v1");
    if (rejected.kind !== "woo.commit.conflict.shadow.v1") throw new Error("expected tampered write to be rejected");
    expect(rejected.reason).toBe("permission_denied");
    expect(rejected.errors).toContain("permission_denied: no recorded authority can write admin_box.value");
    expect(createWorldFromSerialized(serializedFor(commitScope), { persist: false }).getProp("admin_box", "value")).toBe(0);
  });

  it("uses cached state pages so a second real dubspace turn transfers only newly missing pages", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:shadow-page-cache");
    const actor = session.actor;
    await anchor.directCall("shadow-page-cache-enter", actor, "the_dubspace", "enter", [], { sessionId: session.id });

    const firstSerializedBefore = anchor.exportWorld();
    const firstCall: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-page-cache-wet",
      route: "sequenced",
      scope: "the_dubspace",
      session: session.id,
      actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.81]
    };
    const firstPlanned = await runShadowTurnCall(firstSerializedBefore, firstCall);
    const firstKey = shadowTurnKeyFromTranscript(firstPlanned.transcript);
    const actorNode = createShadowExecutionNode({ node: "actor-node", scope: firstKey.scope });
    const firstRouted = await executeShadowTurnCallAcrossInProcessNetwork({
      request: { kind: "woo.turn.exec.request.shadow.v1" as const, call: firstCall, key: firstKey },
      nodes: [actorNode],
      ads: [buildShadowTurnExecAd({ node: "actor-node", scope: firstKey.scope, key: firstKey, factor: 0.1 })],
      anchor: { node: "stable-anchor", serialized: firstSerializedBefore }
    });
    if (!firstRouted.result.ok) throw new Error(`first cache warmup failed: ${firstRouted.result.reason}`);
    if (!firstRouted.transfer || firstRouted.transfer.mode !== "cell_pages") throw new Error("expected first cell-page transfer");
    expect(firstRouted.transfer.inline_pages.length).toBeGreaterThan(0);

    const secondSerializedBefore = firstRouted.result.serializedAfter;
    const secondCall: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-page-cache-feedback",
      route: "sequenced",
      scope: "the_dubspace",
      session: session.id,
      actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "feedback", 0.37]
    };
    const secondPlanned = await runShadowTurnCall(secondSerializedBefore, secondCall);
    const secondKey = shadowTurnKeyFromTranscript(secondPlanned.transcript);
    expect(missingAtomsForShadowTurn(actorNode, secondKey).map((atom) => atom.preimage)).toEqual([
      "write:cell:prop:delay_1.feedback"
    ]);

    const secondRouted = await executeShadowTurnCallAcrossInProcessNetwork({
      request: { kind: "woo.turn.exec.request.shadow.v1" as const, call: secondCall, key: secondKey },
      nodes: [actorNode],
      ads: [buildShadowTurnExecAd({ node: "actor-node", scope: secondKey.scope, key: secondKey, factor: 0.1 })],
      anchor: { node: "stable-anchor", serialized: secondSerializedBefore }
    });

    expect(secondRouted.first).toMatchObject({ ok: false, reason: "missing_state", attempted: false });
    if (!secondRouted.transfer || secondRouted.transfer.mode !== "cell_pages") throw new Error("expected cached cell-page transfer");
    expect(secondRouted.transfer.preimages).toEqual(["write:cell:prop:delay_1.feedback"]);
    expect(secondRouted.transfer.inline_pages).toEqual([
      expect.objectContaining({ object: "$delay", page: "property_cell", name: "feedback" })
    ]);
    expect(secondRouted.transfer.page_refs.length).toBeGreaterThan(0);
    expect(secondRouted.transfer.page_refs.filter((page) => page.inline === true)).toEqual([
      expect.objectContaining({ object: "$delay", page: "property_cell", name: "feedback" })
    ]);
    expect(Buffer.byteLength(JSON.stringify(secondRouted.transfer), "utf8")).toBeLessThan(
      Buffer.byteLength(JSON.stringify(firstRouted.transfer), "utf8") / 5
    );

    expect(secondRouted.result).toMatchObject({ ok: true, attempted: true });
    if (!secondRouted.result.ok) throw new Error(`second cached retry failed: ${secondRouted.result.reason}`);
    expect(secondRouted.result.transcript.hash).toBe(secondPlanned.transcript.hash);
    const warmed = createWorldFromSerialized(secondRouted.result.serializedAfter, { persist: false });
    expect(warmed.getProp("delay_1", "wet")).toBe(0.81);
    expect(warmed.getProp("delay_1", "feedback")).toBe(0.37);
  });

  it("uses a preseeded catalog page cache to avoid sending class lineage on the first dubspace turn", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:shadow-catalog-cache");
    const actor = session.actor;
    await anchor.directCall("shadow-catalog-cache-enter", actor, "the_dubspace", "enter", [], { sessionId: session.id });

    const serializedBefore = anchor.exportWorld();
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-catalog-cache-wet",
      route: "sequenced",
      scope: "the_dubspace",
      session: session.id,
      actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.49]
    };
    const planned = await runShadowTurnCall(serializedBefore, call);
    const key = shadowTurnKeyFromTranscript(planned.transcript);
    const fullTransfer = buildShadowCellPageTransfer({
      serialized: serializedBefore,
      key,
      atom_hashes: key.atom_hashes,
      session: session.id
    });
    const catalogCache = serializedBefore.objects.filter((obj) => obj.id.startsWith("$"));
    const cachedNode = createShadowExecutionNode({
      node: "catalog-cached-browser",
      scope: key.scope,
      cached_objects: catalogCache
    });

    const routed = await executeShadowTurnCallAcrossInProcessNetwork({
      request: { kind: "woo.turn.exec.request.shadow.v1" as const, call, key },
      nodes: [cachedNode],
      ads: [buildShadowTurnExecAd({ node: "catalog-cached-browser", scope: key.scope, key, factor: 0.1 })],
      anchor: { node: "stable-anchor", serialized: serializedBefore }
    });

    expect(routed.first).toMatchObject({ ok: false, reason: "missing_state", attempted: false });
    if (!routed.transfer || routed.transfer.mode !== "cell_pages") throw new Error("expected catalog-cache cell transfer");
    expect(new Set(routed.transfer.inline_pages.map((page) => page.object))).toEqual(new Set(["delay_1", "guest_1", "the_dubspace"]));
    expect(routed.transfer.page_refs.filter((page) => page.inline === false).map((page) => page.object)).toEqual(
      expect.arrayContaining(["$dubspace", "$space", "$sequenced_log", "$root", "$system", "$delay", "$control", "$guest", "$player", "$actor"])
    );
    expect(Buffer.byteLength(JSON.stringify(routed.transfer), "utf8")).toBeLessThan(
      Buffer.byteLength(JSON.stringify(fullTransfer), "utf8")
    );

    expect(routed.result).toMatchObject({ ok: true, attempted: true });
    if (!routed.result.ok) throw new Error(`catalog-cached retry failed: ${routed.result.reason}`);
    expect(routed.result.transcript.hash).toBe(planned.transcript.hash);
    expect(createWorldFromSerialized(routed.result.serializedAfter, { persist: false }).getProp("delay_1", "wet")).toBe(0.49);
  });

  it("includes feature object lineage in cell-page transfers", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:shadow-feature-transfer");
    const actor = session.actor;
    await anchor.directCall("shadow-feature-transfer-enter", actor, "the_chatroom", "enter", [], { sessionId: session.id });

    const serializedBefore = anchor.exportWorld();
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-feature-transfer-take",
      route: "sequenced",
      scope: "the_chatroom",
      session: session.id,
      actor,
      target: "the_chatroom",
      verb: "take",
      args: ["mug"]
    };
    const key = shadowTurnKeyFromTranscript((await runShadowTurnCall(serializedBefore, call)).transcript);
    const transfer = buildShadowCellPageTransfer({
      serialized: serializedBefore,
      key,
      atom_hashes: key.atom_hashes,
      session: session.id
    });

    expect(transfer.page_refs.map((page) => page.object)).toContain("$conversational");
  });

  it("rejects an inline object page whose content hash does not match", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:shadow-page-integrity");
    const actor = session.actor;
    await anchor.directCall("shadow-page-integrity-enter", actor, "the_dubspace", "enter", [], { sessionId: session.id });

    const serializedBefore = anchor.exportWorld();
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-page-integrity-wet",
      route: "sequenced",
      scope: "the_dubspace",
      session: session.id,
      actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.53]
    };
    const planned = await runShadowTurnCall(serializedBefore, call);
    const key = shadowTurnKeyFromTranscript(planned.transcript);
    const transfer = buildShadowObjectRecordTransfer({
      serialized: serializedBefore,
      key,
      atom_hashes: key.atom_hashes,
      session: session.id
    });
    const delayIndex = transfer.objects.findIndex((obj) => obj.id === "delay_1");
    expect(delayIndex).toBeGreaterThanOrEqual(0);
    transfer.objects[delayIndex] = { ...transfer.objects[delayIndex], name: "tampered delay" };

    const node = createShadowExecutionNode({ node: "actor-node", scope: key.scope });
    expect(() => installShadowStateTransfer(node, transfer)).toThrow(/hash mismatch/);
  });

  it("rejects an inline state page whose content hash does not match", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:shadow-cell-page-integrity");
    const actor = session.actor;
    await anchor.directCall("shadow-cell-page-integrity-enter", actor, "the_dubspace", "enter", [], { sessionId: session.id });

    const serializedBefore = anchor.exportWorld();
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-cell-page-integrity-wet",
      route: "sequenced",
      scope: "the_dubspace",
      session: session.id,
      actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.53]
    };
    const key = shadowTurnKeyFromTranscript((await runShadowTurnCall(serializedBefore, call)).transcript);
    const transfer = buildShadowCellPageTransfer({
      serialized: serializedBefore,
      key,
      atom_hashes: key.atom_hashes,
      session: session.id
    });
    const pageIndex = transfer.inline_pages.findIndex((page) => page.object === "delay_1" && page.page === "property_cell" && page.name === "wet");
    expect(pageIndex).toBeGreaterThanOrEqual(0);
    const page = transfer.inline_pages[pageIndex];
    if (page.page !== "property_cell") throw new Error("expected delay_1.wet property page");
    const originalHash = shadowStatePageHash(page);
    transfer.inline_pages[pageIndex] = { ...page, version: 999 };
    expect(shadowStatePageHash(transfer.inline_pages[pageIndex])).not.toBe(originalHash);

    const node = createShadowExecutionNode({ node: "actor-node", scope: key.scope });
    expect(() => installShadowStateTransfer(node, transfer)).toThrow(/root mismatch|inline shadow state page has no inline page ref/);
  });

  it("rejects state transfer proofs for the wrong recipient or authority secret", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:shadow-proof");
    const actor = session.actor;
    await anchor.directCall("shadow-proof-enter", actor, "the_dubspace", "enter", [], { sessionId: session.id });

    const serializedBefore = anchor.exportWorld();
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-proof-wet",
      route: "sequenced",
      scope: "the_dubspace",
      session: session.id,
      actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.57]
    };
    const key = shadowTurnKeyFromTranscript((await runShadowTurnCall(serializedBefore, call)).transcript);
    const wrongRecipient = buildShadowObjectRecordTransfer({
      serialized: serializedBefore,
      key,
      atom_hashes: key.atom_hashes,
      session: session.id,
      recipient: "some-other-node"
    });
    expect(() => installShadowStateTransfer(createShadowExecutionNode({ node: "actor-node", scope: key.scope }), wrongRecipient))
      .toThrow(/recipient mismatch/);

    const wrongSecret = buildShadowObjectRecordTransfer({
      serialized: serializedBefore,
      key,
      atom_hashes: key.atom_hashes,
      session: session.id,
      recipient: "actor-node",
      secret: "not-the-anchor-secret"
    });
    expect(() => installShadowStateTransfer(createShadowExecutionNode({ node: "actor-node", scope: key.scope }), wrongSecret))
      .toThrow(/signature mismatch/);
  });

  it("binds cell-page execution capsule metadata into the transfer proof", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:shadow-capsule-proof");
    const actor = session.actor;
    await anchor.directCall("shadow-capsule-enter", actor, "the_dubspace", "enter", [], { sessionId: session.id });

    const serializedBefore = anchor.exportWorld();
    const commitScope = createShadowCommitScope({ node: "anchor", scope: "the_dubspace", serialized: serializedBefore });
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-capsule-wet",
      route: "sequenced",
      scope: "the_dubspace",
      session: session.id,
      actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.57]
    };
    const key = shadowTurnKeyFromTranscript((await runShadowTurnCall(serializedBefore, call)).transcript);
    const transfer = buildShadowCellPageTransfer({
      serialized: serializedBefore,
      key,
      atom_hashes: key.atom_hashes,
      session: session.id,
      recipient: "actor-node",
      capsule: {
        head: commitScope.head,
        actor,
        session: session.id,
        target: key.target,
        verb: key.verb,
        recipient: "actor-node"
      }
    });

    validateShadowExecutionCapsuleTransfer({
      node: "actor-node",
      transfer,
      scope: key.scope,
      key,
      actor,
      session: session.id,
      target: key.target,
      verb: key.verb
    });
    installShadowStateTransfer(createShadowExecutionNode({ node: "actor-node", scope: key.scope }), transfer);

    const tamperedVerb = structuredClone(transfer);
    if (tamperedVerb.mode !== "cell_pages" || !tamperedVerb.capsule) throw new Error("expected capsule transfer");
    tamperedVerb.capsule.verb = "look";
    expect(() => installShadowStateTransfer(createShadowExecutionNode({ node: "actor-node", scope: key.scope }), tamperedVerb))
      .toThrow(/root mismatch/);

    const wrongKeyTransfer = buildShadowCellPageTransfer({
      serialized: serializedBefore,
      key,
      atom_hashes: key.atom_hashes,
      session: session.id,
      recipient: "actor-node",
      capsule: {
        head: commitScope.head,
        actor,
        session: session.id,
        target: key.target,
        verb: key.verb,
        recipient: "actor-node"
      }
    });
    const wrongKey = { ...key, verb: "look" };
    expect(() => validateShadowExecutionCapsuleTransfer({
      node: "actor-node",
      transfer: wrongKeyTransfer,
      scope: key.scope,
      key: wrongKey,
      actor,
      session: session.id,
      target: wrongKey.target,
      verb: wrongKey.verb
    })).toThrow(/call mismatch|turn key mismatch/);
  });

  it("aborts during execution when a real dubspace turn touches an unpredicted cell", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:shadow-need-state");
    const actor = session.actor;
    await anchor.directCall("shadow-need-state-enter", actor, "the_dubspace", "enter", [], { sessionId: session.id });

    const serializedBefore = anchor.exportWorld();
    const beforeWet = anchor.getProp("delay_1", "wet");
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-need-state-wet",
      route: "sequenced",
      scope: "the_dubspace",
      session: session.id,
      actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.63]
    };
    const planned = await runShadowTurnCall(serializedBefore, call);
    const fullKey = shadowTurnKeyFromTranscript(planned.transcript);
    const predictedKey = shadowTurnKeyWithoutPreimage(fullKey, "write:cell:prop:delay_1.wet");
    const node = createShadowExecutionNode({
      node: "actor-node",
      scope: fullKey.scope,
      atom_hashes: predictedKey.atom_hashes,
      serialized: serializedBefore
    });

    const result = await executeShadowTurnCallOrNeedState(node, {
      kind: "woo.turn.exec.request.shadow.v1",
      call,
      key: predictedKey
    });

    expect(result).toMatchObject({ ok: false, reason: "missing_state", attempted: true });
    if (result.ok || result.reason !== "missing_state") throw new Error("expected read-time missing_state");
    expect(result.missing_atoms).toEqual([
      expect.objectContaining({ preimage: "write:cell:prop:delay_1.wet" })
    ]);
    expect(result.transcript?.error).toMatchObject({ code: "E_NEED_STATE" });
    expect(createWorldFromSerialized(node.serialized!, { persist: false }).getProp("delay_1", "wet")).toBe(beforeWet);
  });

  it("transfers and retries after a read-time missing-state abort", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:shadow-need-state-retry");
    const actor = session.actor;
    await anchor.directCall("shadow-need-state-retry-enter", actor, "the_dubspace", "enter", [], { sessionId: session.id });

    const serializedBefore = anchor.exportWorld();
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-need-state-retry-wet",
      route: "sequenced",
      scope: "the_dubspace",
      session: session.id,
      actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.67]
    };
    const fullKey = shadowTurnKeyFromTranscript((await runShadowTurnCall(serializedBefore, call)).transcript);
    const predictedKey = shadowTurnKeyWithoutPreimage(fullKey, "write:cell:prop:delay_1.wet");
    const node = createShadowExecutionNode({
      node: "actor-node",
      scope: fullKey.scope,
      atom_hashes: predictedKey.atom_hashes,
      serialized: serializedBefore
    });

    const routed = await executeShadowTurnCallAcrossInProcessNetwork({
      request: { kind: "woo.turn.exec.request.shadow.v1" as const, call, key: predictedKey },
      nodes: [node],
      ads: [buildShadowTurnExecAd({ node: "actor-node", scope: predictedKey.scope, key: predictedKey, factor: 0.1 })],
      anchor: { node: "stable-anchor", serialized: serializedBefore }
    });

    expect(routed.first).toMatchObject({ ok: false, reason: "missing_state", attempted: true });
    if (routed.first.ok || routed.first.reason !== "missing_state") throw new Error("expected read-time miss");
    expect(routed.first.missing_atoms).toEqual([
      expect.objectContaining({ preimage: "write:cell:prop:delay_1.wet" })
    ]);
    expect(routed.transfer).toMatchObject({
      kind: "woo.state.transfer.shadow.v1",
      mode: "cell_pages",
      preimages: ["write:cell:prop:delay_1.wet"]
    });
    expect(routed.result).toMatchObject({ ok: true, attempted: true });
    if (!routed.result.ok) throw new Error(`read-time retry failed: ${routed.result.reason}`);
    expect(createWorldFromSerialized(routed.result.serializedAfter, { persist: false }).getProp("delay_1", "wet")).toBe(0.67);
  });

  it("forwards engine metrics from the ephemeral executor world when onMetric is supplied", async () => {
    // The v2 hot path runs verbs on an ephemeral world created from a
    // serialized snapshot. That world has no metrics hook by default,
    // so direct_call/applied/dispatch_resolved events are dropped
    // unless callers thread their host's metric sink into
    // ShadowTurnCallOptions.onMetric. /admin/ footprint-by-verb is
    // permanently empty without this forwarder.
    const anchor = createWorld();
    const session = anchor.auth("guest:shadow-metric-forward");
    const actor = session.actor;
    anchor.createObject({ id: "metric_box", name: "Metric Box", parent: "$thing", owner: actor });
    anchor.defineProperty("metric_box", { name: "n", defaultValue: 0, owner: actor, perms: "rw", typeHint: "num" });
    expect(installVerb(anchor, "metric_box", "bump", `verb :bump(value) rxd {
      this.n = value;
      return this.n;
    }`, null).ok).toBe(true);

    const serializedBefore = anchor.exportWorld();
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-metric-forward",
      route: "direct",
      scope: "metric_box",
      session: session.id,
      actor,
      target: "metric_box",
      verb: "bump",
      args: [0.5]
    };
    const events: Array<{ kind: string; verb?: string; target?: string }> = [];

    // Baseline: without onMetric, no events arrive. The frame op
    // depends on the route — direct routes produce a "result" frame
    // and emit `direct_call` via recordMetric; sequenced routes
    // produce an "applied" frame and emit `applied`. We use the
    // direct route here so the metric kind is unambiguous.
    const _without = await runShadowTurnCallTranscript(serializedBefore, call);
    expect(_without.frame.op).toBe("result");

    // With onMetric, the engine's direct_call event reaches the
    // forwarder. The test would silently regress (with no DOM coverage
    // of the dashboard either) if anyone removed the
    // world.setMetricsHook call from runShadowTurnCallTranscript.
    const run = await runShadowTurnCallTranscript(serializedBefore, call, {
      onMetric: (event) => events.push({ kind: event.kind, verb: (event as { verb?: string }).verb, target: (event as { target?: string }).target })
    });
    expect(run.frame.op).toBe("result");
    const directCall = events.find((e) => e.kind === "direct_call");
    expect(directCall, "expected a direct_call event from the executor world").toBeDefined();
    expect(directCall?.verb).toBe("bump");
    expect(directCall?.target).toBe("metric_box");
  });
});

function shadowTurnKeyWithoutPreimage(key: ShadowTurnKey, removed: string): ShadowTurnKey {
  const remove = (preimages: string[], hashes: string[]) => {
    const nextPreimages: string[] = [];
    const nextHashes: string[] = [];
    for (let i = 0; i < preimages.length; i++) {
      if (preimages[i] === removed) continue;
      nextPreimages.push(preimages[i]);
      nextHashes.push(hashes[i]);
    }
    return { preimages: nextPreimages, hashes: nextHashes };
  };
  const all = remove(key.preimages, key.atom_hashes);
  const reads = remove(key.read_preimages, key.read_atom_hashes);
  const writes = remove(key.write_preimages, key.write_atom_hashes);
  const accepts = remove(key.accept_preimages, key.accept_atom_hashes);
  return {
    ...key,
    preimages: all.preimages,
    atom_hashes: all.hashes,
    read_preimages: reads.preimages,
    read_atom_hashes: reads.hashes,
    write_preimages: writes.preimages,
    write_atom_hashes: writes.hashes,
    accept_preimages: accepts.preimages,
    accept_atom_hashes: accepts.hashes
  };
}
