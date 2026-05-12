import { describe, expect, it } from "vitest";
import { installVerb } from "../src/core/authoring";
import { createWorld, createWorldFromSerialized } from "../src/core/bootstrap";
import { capabilityAdProbablyCoversTurn } from "../src/core/capability-ad";
import { effectTranscriptFromRecordedTurn } from "../src/core/effect-transcript";
import { createShadowCommitScope } from "../src/core/shadow-commit-scope";
import {
  buildShadowClosureTransfer,
  buildShadowObjectRecordTransfer,
  createShadowExecutionNode,
  executeShadowRecordedTurnOrNeedState,
  executeShadowTurnCallOrNeedState,
  installShadowStateTransfer,
  missingAtomsForShadowTurn,
  shadowObjectRecordHash
} from "../src/core/shadow-turn-exec";
import { runShadowTurnCall, type ShadowTurnCall } from "../src/core/shadow-turn-call";
import { buildShadowTurnExecAd, buildShadowTurnExecAdFromNode, executeShadowTurnCallAcrossInProcessNetwork } from "../src/core/shadow-turn-network";
import { InMemoryTurnRecorder } from "../src/core/turn-recorder";
import { shadowTurnKeyFromTranscript, type ShadowTurnKey } from "../src/core/turn-key";

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
    const entered = await anchor.directCall("shadow-catalog-enter", actor, "the_dubspace", "enter", [], { sessionId: session.id });
    expect(entered.op).toBe("result");

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
    const request = { kind: "woo.turn_exec_request.shadow.v1" as const, call, key };
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
      transfer: { kind: "woo.state.transfer.shadow.v1", mode: "object_records", scope: "the_dubspace" },
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
    const request = { kind: "woo.turn_exec_request.shadow.v1" as const, call, key };
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
      mode: "object_records",
      scope: "the_dubspace",
      atom_hashes: [writeHash],
      preimages: ["write:cell:prop:delay_1.wet"]
    });
    if (!routed.transfer || routed.transfer.mode !== "object_records") throw new Error("expected object-record transfer");
    const transferredObjects = routed.transfer.objects.map((obj) => obj.id);
    expect(transferredObjects).toContain("delay_1");
    expect(transferredObjects).not.toContain("slot_1");
    expect(routed.transfer.object_pages.find((page) => page.id === "delay_1")).toMatchObject({
      hash: shadowObjectRecordHash(routed.transfer.objects.find((obj) => obj.id === "delay_1")!),
      inline: true
    });
    expect(routed.transfer.objects.length).toBeLessThan(serializedBefore.objects.length);
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
      request: { kind: "woo.turn_exec_request.shadow.v1" as const, call, key, expected: initialHead },
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
    expect(createWorldFromSerialized(commitScope.serialized, { persist: false }).getProp("delay_1", "wet")).toBe(0.58);
    expect(commitScope.serialized.objects.length).toBe(serializedBefore.objects.length);

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
      kind: "woo.turn_exec_request.shadow.v1",
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
    expect(createWorldFromSerialized(commitScope.serialized, { persist: false }).getProp("delay_1", "wet")).toBe(0.58);
    expect(createWorldFromSerialized(staleNode.serialized!, { persist: false }).getProp("delay_1", "wet")).not.toBe(0.59);
  });

  it("uses cached object pages so a second real dubspace turn transfers no lineage records", async () => {
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
      request: { kind: "woo.turn_exec_request.shadow.v1" as const, call: firstCall, key: firstKey },
      nodes: [actorNode],
      ads: [buildShadowTurnExecAd({ node: "actor-node", scope: firstKey.scope, key: firstKey, factor: 0.1 })],
      anchor: { node: "stable-anchor", serialized: firstSerializedBefore }
    });
    if (!firstRouted.result.ok) throw new Error(`first cache warmup failed: ${firstRouted.result.reason}`);
    if (!firstRouted.transfer || firstRouted.transfer.mode !== "object_records") throw new Error("expected first object-record transfer");
    expect(firstRouted.transfer.objects.length).toBeGreaterThan(0);

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
      request: { kind: "woo.turn_exec_request.shadow.v1" as const, call: secondCall, key: secondKey },
      nodes: [actorNode],
      ads: [buildShadowTurnExecAd({ node: "actor-node", scope: secondKey.scope, key: secondKey, factor: 0.1 })],
      anchor: { node: "stable-anchor", serialized: secondSerializedBefore }
    });

    expect(secondRouted.first).toMatchObject({ ok: false, reason: "missing_state", attempted: false });
    if (!secondRouted.transfer || secondRouted.transfer.mode !== "object_records") throw new Error("expected cached object-record transfer");
    expect(secondRouted.transfer.preimages).toEqual(["write:cell:prop:delay_1.feedback"]);
    expect(secondRouted.transfer.objects).toEqual([]);
    expect(secondRouted.transfer.object_pages.length).toBeGreaterThan(0);
    expect(secondRouted.transfer.object_pages.every((page) => page.inline === false)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(secondRouted.transfer), "utf8")).toBeLessThan(
      Buffer.byteLength(JSON.stringify(firstRouted.transfer), "utf8") / 10
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
    const fullTransfer = buildShadowObjectRecordTransfer({
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
      request: { kind: "woo.turn_exec_request.shadow.v1" as const, call, key },
      nodes: [cachedNode],
      ads: [buildShadowTurnExecAd({ node: "catalog-cached-browser", scope: key.scope, key, factor: 0.1 })],
      anchor: { node: "stable-anchor", serialized: serializedBefore }
    });

    expect(routed.first).toMatchObject({ ok: false, reason: "missing_state", attempted: false });
    if (!routed.transfer || routed.transfer.mode !== "object_records") throw new Error("expected catalog-cache object transfer");
    expect(new Set(routed.transfer.objects.map((obj) => obj.id))).toEqual(new Set(["delay_1", "guest_1", "the_dubspace"]));
    expect(routed.transfer.object_pages.filter((page) => page.inline === false).map((page) => page.id)).toEqual(
      expect.arrayContaining(["$dubspace", "$space", "$sequenced_log", "$root", "$system", "$delay", "$control", "$guest", "$player", "$actor"])
    );
    expect(Buffer.byteLength(JSON.stringify(routed.transfer), "utf8")).toBeLessThan(
      Buffer.byteLength(JSON.stringify(fullTransfer), "utf8") / 10
    );

    expect(routed.result).toMatchObject({ ok: true, attempted: true });
    if (!routed.result.ok) throw new Error(`catalog-cached retry failed: ${routed.result.reason}`);
    expect(routed.result.transcript.hash).toBe(planned.transcript.hash);
    expect(createWorldFromSerialized(routed.result.serializedAfter, { persist: false }).getProp("delay_1", "wet")).toBe(0.49);
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
      kind: "woo.turn_exec_request.shadow.v1",
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
      request: { kind: "woo.turn_exec_request.shadow.v1" as const, call, key: predictedKey },
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
      mode: "object_records",
      preimages: ["write:cell:prop:delay_1.wet"]
    });
    expect(routed.result).toMatchObject({ ok: true, attempted: true });
    if (!routed.result.ok) throw new Error(`read-time retry failed: ${routed.result.reason}`);
    expect(createWorldFromSerialized(routed.result.serializedAfter, { persist: false }).getProp("delay_1", "wet")).toBe(0.67);
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
