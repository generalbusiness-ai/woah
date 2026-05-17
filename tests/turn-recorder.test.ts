import { describe, expect, it } from "vitest";
import { installVerb } from "../src/core/authoring";
import { createWorld } from "../src/core/bootstrap";
import { buildShadowCapabilityAd, capabilityAdProbablyCoversTurn, rankCapabilityAdsForTurn } from "../src/core/capability-ad";
import { effectTranscriptFromRecordedTurn, transcriptTouchedStateHash, validateTranscriptAgainstSerializedWorld } from "../src/core/effect-transcript";
import { remoteBridgeEffectName } from "../src/core/remote-bridge-transcript-policy";
import { shadowCommitReceipt } from "../src/core/turn-commit";
import { shadowTurnKeyFromTranscript } from "../src/core/turn-key";
import { comparableTurnEvents, replayRecordedTurn } from "../src/core/turn-replay";
import { InMemoryTurnRecorder } from "../src/core/turn-recorder";
import type { HostBridge } from "../src/core/world";
import { message, nativeVerb } from "./core-support";

describe("turn recorder", () => {
  it("records a direct VM turn's central reads, writes, observations, and logical inputs", async () => {
    const world = createWorld();
    const session = world.auth("guest:turn-recorder");
    const actor = session.actor;
    const recorder = new InMemoryTurnRecorder();
    world.setTurnRecorder(recorder);

    world.createObject({ id: "rec_box", name: "Recorder Box", parent: "$thing", owner: actor });
    world.defineProperty("rec_box", { name: "counter", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
    const installed = installVerb(
      world,
      "rec_box",
      "bump",
      `verb :bump() rxd {
        let before = this.counter;
        this.counter = before + 1;
        observe({ type: "bumped", source: this, actor: actor, value: this.counter, ts: now() });
        return this.counter;
      }`,
      null
    );
    expect(installed.ok).toBe(true);

    const result = await world.directCall("rec-bump", actor, "rec_box", "bump", []);

    expect(result.op).toBe("result");
    if (result.op === "result") expect(result.result).toBe(1);
    expect(recorder.turns).toHaveLength(1);
    const events = recorder.turns[0].events;
    expect(events).toContainEqual(expect.objectContaining({ kind: "turn_start" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "dispatch", target: "rec_box", verb: "bump", implementation: "bytecode" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "prop_read", object: "rec_box", name: "counter", value: 0, version: 1 }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "prop_write", object: "rec_box", name: "counter", after: 1, changed: true, beforeVersion: 1, afterVersion: 2 }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "logical_input", name: "now" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "observe", observation: expect.objectContaining({ type: "bumped", value: 1 }) }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "turn_finish", ok: true, result: 1 }));

    const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
    expect(transcript).toMatchObject({
      kind: "woo.effect_transcript.shadow.v1",
      route: "direct",
      scope: "#-1",
      complete: true,
      call: { actor, target: "rec_box", verb: "bump", args: [] },
      result: 1
    });
    expect(transcript.reads).toContainEqual(expect.objectContaining({ cell: { kind: "prop", object: "rec_box", name: "counter" }, version: "1", value: 0 }));
    expect(transcript.writes).toContainEqual(expect.objectContaining({ cell: { kind: "prop", object: "rec_box", name: "counter" }, prior: "1", next: "2", value: 1, op: "set" }));
    expect(transcript.observations).toContainEqual(expect.objectContaining({ type: "bumped", value: 1 }));
    expect(transcript.hash).toMatch(/^[a-f0-9]{64}$/);
    const turnKey = shadowTurnKeyFromTranscript(transcript);
    expect(turnKey).toMatchObject({ kind: "woo.turn_key.shadow.v1", scope: "#-1", actor, target: "rec_box", verb: "bump" });
    expect(turnKey.preimages).toEqual(expect.arrayContaining([
      `actor:${actor}`,
      "call:rec_box:bump",
      "read:cell:prop:rec_box.counter",
      "read:cell:verb:rec_box:bump",
      "write:cell:prop:rec_box.counter"
    ]));
    expect(turnKey.atom_hashes).toHaveLength(turnKey.preimages.length);
    expect(turnKey.atom_hashes.every((hash) => /^[a-f0-9]{64}$/.test(hash))).toBe(true);
    expect(turnKey.write_preimages).toContain("write:cell:prop:rec_box.counter");
    expect(turnKey.write_atom_hashes).toHaveLength(turnKey.write_preimages.length);
    expect(turnKey.accept_preimages).toEqual(expect.arrayContaining(["call:rec_box:bump", "scope:#-1", "target:rec_box"]));
    const ad = buildShadowCapabilityAd({ node: "node-a", scope: turnKey.scope, atom_hashes: turnKey.atom_hashes, factor: 0.75 });
    expect(ad).toMatchObject({ kind: "woo.exec_capability_ad.shadow.v1", node: "node-a", scope: "#-1", factor: 0.75 });
    expect(ad.covers.bits_hex).toMatch(/^[a-f0-9]+$/);
    expect(ad.accepts.bits_hex).toMatch(/^[a-f0-9]+$/);
    expect(capabilityAdProbablyCoversTurn(ad, turnKey)).toBe(true);
    expect(capabilityAdProbablyCoversTurn(buildShadowCapabilityAd({ node: "empty", scope: turnKey.scope, atom_hashes: [] }), turnKey)).toBe(false);
    const readOnly = buildShadowCapabilityAd({ node: "read-only", scope: turnKey.scope, atom_hashes: turnKey.atom_hashes, accepts_atom_hashes: [] });
    expect(capabilityAdProbablyCoversTurn(readOnly, turnKey)).toBe(false);
    const cheaper = buildShadowCapabilityAd({ node: "node-b", scope: turnKey.scope, atom_hashes: turnKey.atom_hashes, factor: 0.5 });
    expect(rankCapabilityAdsForTurn([ad, cheaper], turnKey).map((item) => item.node)).toEqual(["node-b", "node-a"]);
  });

  it("records sequenced turns at the applied-call boundary", async () => {
    const world = createWorld();
    const session = world.auth("guest:turn-recorder-seq");
    const actor = session.actor;
    const recorder = new InMemoryTurnRecorder();
    world.setTurnRecorder(recorder);

    const entered = await world.directCall("seq-enter", actor, "the_dubspace", "enter", [], { sessionId: session.id });
    expect(entered.op).toBe("result");
    recorder.turns.length = 0;

    const frame = await world.call(
      "seq-control",
      session.id,
      "the_dubspace",
      message(actor, "the_dubspace", "set_control", ["delay_1", "feedback", 0.37])
    );

    expect(frame.op).toBe("applied");
    expect(recorder.turns).toHaveLength(1);
    const turn = recorder.turns[0];
    expect(turn.start).toMatchObject({ id: "seq-control", route: "sequenced", scope: "the_dubspace", actor, target: "the_dubspace", verb: "set_control" });
    expect(turn.events).toContainEqual(expect.objectContaining({ kind: "prop_write", object: "delay_1", name: "feedback", after: 0.37, changed: true }));
    expect(turn.events).toContainEqual(expect.objectContaining({ kind: "observe", observation: expect.objectContaining({ type: "control_changed", target: "delay_1", name: "feedback", value: 0.37 }) }));
  });

  it("normalizes verb metadata, location, and contents reads into the effect transcript", async () => {
    const world = createWorld();
    const session = world.auth("guest:turn-recorder-cells");
    const actor = session.actor;

    world.createObject({ id: "cell_room", name: "Cell Room", parent: "$thing", owner: actor, location: "$nowhere" });
    world.createObject({ id: "cell_item", name: "Cell Item", parent: "$thing", owner: actor, location: "cell_room" });
    const installed = installVerb(
      world,
      "cell_room",
      "inspect_cells",
      `verb :inspect_cells() rxd {
        return { location: location(this), items: contents(this) };
      }`,
      null
    );
    expect(installed.ok).toBe(true);

    const before = world.exportWorld();
    const recorder = new InMemoryTurnRecorder();
    world.setTurnRecorder(recorder);

    const result = await world.directCall("cell-inspect", actor, "cell_room", "inspect_cells", []);

    expect(result.op).toBe("result");
    if (result.op === "result") expect(result.result).toEqual({ location: "$nowhere", items: ["cell_item"] });
    const turn = recorder.turns[0];
    expect(turn.events).toContainEqual(expect.objectContaining({ kind: "dispatch", target: "cell_room", verb: "inspect_cells", definer: "cell_room", implementation: "bytecode", version: 1 }));
    expect(turn.events).toContainEqual(expect.objectContaining({ kind: "cell_read", cell: { kind: "location", object: "cell_room" }, value: "$nowhere" }));
    expect(turn.events).toContainEqual(expect.objectContaining({ kind: "cell_read", cell: { kind: "contents", object: "cell_room" }, value: ["cell_item"] }));

    const transcript = effectTranscriptFromRecordedTurn(turn);
    expect(transcript.complete).toBe(true);
    expect(transcript.reads).toContainEqual(expect.objectContaining({
      cell: { kind: "verb", object: "cell_room", name: "inspect_cells" },
      version: "1",
      value: expect.objectContaining({ implementation: "bytecode", owner: actor, version: 1 })
    }));
    expect(transcript.reads).toContainEqual(expect.objectContaining({ cell: { kind: "location", object: "cell_room" }, value: "$nowhere" }));
    expect(transcript.reads).toContainEqual(expect.objectContaining({ cell: { kind: "contents", object: "cell_room" }, value: ["cell_item"] }));
    expect(validateTranscriptAgainstSerializedWorld(before, transcript)).toEqual({ ok: true, errors: [] });
  });

  it("keeps Tier 1 look and describe verbs in bytecode transcripts", async () => {
    const world = createWorld();
    const session = world.auth("guest:turn-recorder-tier1");
    const actor = session.actor;
    world.createObject({ id: "tier1_box", name: "Tier One Box", parent: "$thing", owner: actor });
    world.setProp("tier1_box", "description", "A box for transcript coverage.");

    const calls = [
      { id: "tier1-describe", target: "tier1_box", verb: "describe" },
      { id: "tier1-look-self", target: "tier1_box", verb: "look_self" },
      { id: "tier1-look", target: "tier1_box", verb: "look" },
      { id: "tier1-room-look-self", target: "the_chatroom", verb: "look_self" }
    ];
    for (const call of calls) {
      const before = world.exportWorld();
      const recorder = new InMemoryTurnRecorder();
      world.setTurnRecorder(recorder);

      const result = await world.directCall(call.id, actor, call.target, call.verb, []);

      expect(result.op).toBe("result");
      const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
      expect(transcript.complete, `${call.target}:${call.verb} incomplete: ${transcript.incompleteReasons.join(",")}`).toBe(true);
      expect(transcript.incompleteReasons).toEqual([]);
      expect(transcript.reads).toContainEqual(expect.objectContaining({
        cell: expect.objectContaining({ kind: "verb", name: call.verb }),
        value: expect.objectContaining({ implementation: "bytecode", native: null })
      }));
      expect(validateTranscriptAgainstSerializedWorld(before, transcript)).toEqual({ ok: true, errors: [] });
    }

    world.createObject({ id: "private_desc_box", name: "Private Desc Box", parent: "$thing", owner: "$wiz" });
    world.defineProperty("private_desc_box", { name: "description", defaultValue: "not for guests", owner: "$wiz", perms: "", typeHint: "str" });
    const privateLook = await world.directCall("tier1-private-look-self", actor, "private_desc_box", "look_self", []);
    expect(privateLook.op).toBe("result");
    if (privateLook.op === "result") {
      expect((privateLook.result as Record<string, unknown>).description).toBe(null);
    }
  });

  it("keeps Tier 2 read/output verbs in bytecode transcripts", async () => {
    const world = createWorld();
    const session = world.auth("guest:turn-recorder-tier2");
    const actor = session.actor;
    await world.directCall("tier2-enter", actor, "the_chatroom", "enter", [], { sessionId: session.id });

    const calls = [
      { id: "tier2-tell", target: actor, verb: "tell", args: ["hello"] },
      { id: "tier2-tell-lines", target: actor, verb: "tell_lines", args: [["one", "two"]] },
      { id: "tier2-who-all", target: actor, verb: "who_all", args: [] },
      { id: "tier2-help", target: actor, verb: "help", args: ["look"] },
      { id: "tier2-examine", target: actor, verb: "examine_detailed", args: ["the_chatroom"] },
      { id: "tier2-room-who", target: "the_chatroom", verb: "who", args: [] }
    ];
    for (const call of calls) {
      const before = world.exportWorld();
      const recorder = new InMemoryTurnRecorder();
      world.setTurnRecorder(recorder);

      const result = await world.directCall(call.id, actor, call.target, call.verb, call.args, { sessionId: session.id });

      expect(result.op).toBe("result");
      const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
      expect(transcript.complete, `${call.target}:${call.verb} incomplete: ${transcript.incompleteReasons.join(",")}`).toBe(true);
      expect(transcript.incompleteReasons).toEqual([]);
      expect(transcript.reads).toContainEqual(expect.objectContaining({
        cell: expect.objectContaining({ kind: "verb", name: call.verb }),
        value: expect.objectContaining({ implementation: "bytecode", native: null })
      }));
      expect(validateTranscriptAgainstSerializedWorld(before, transcript)).toEqual({ ok: true, errors: [] });
    }
  });

  it("marks native verb dispatch as incomplete while preserving dispatch metadata", async () => {
    const world = createWorld();
    const session = world.auth("guest:turn-recorder-native");
    const actor = session.actor;

    world.createObject({ id: "native_box", name: "Native Box", parent: "$thing", owner: actor });
    world.registerNativeHandler("test_untracked_native", () => true);
    world.addVerb("native_box", {
      ...nativeVerb("native_probe", "test_untracked_native", actor),
      perms: "rxd",
      direct_callable: true
    });
    const before = world.exportWorld();
    const recorder = new InMemoryTurnRecorder();
    world.setTurnRecorder(recorder);

    const result = await world.directCall("native-probe", actor, "native_box", "native_probe", []);

    expect(result.op).toBe("result");
    const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
    expect(transcript.complete).toBe(false);
    expect(transcript.incompleteReasons).toContain("native:native_box:native_probe");
    expect(transcript.reads).toContainEqual(expect.objectContaining({
      cell: { kind: "verb", object: "native_box", name: "native_probe" },
      value: expect.objectContaining({ implementation: "native", owner: actor, direct_callable: true, native_contract: null })
    }));
    expect(validateTranscriptAgainstSerializedWorld(before, transcript)).toEqual({ ok: true, errors: [] });
    const receipt = shadowCommitReceipt(before, world.exportWorld(), transcript);
    expect(receipt).toMatchObject({
      kind: "woo.commit_receipt.shadow.v1",
      accepted: false,
      transcript_hash: transcript.hash
    });
    expect(receipt.errors).toContain("incomplete:native:native_box:native_probe");
  });

  it("keeps contracted native primitive dispatches complete and records the contract", async () => {
    const world = createWorld();
    const actor = "$wiz";

    world.createObject({ id: "native_move_a", name: "Native Move A", parent: "$thing", owner: actor, location: "$nowhere" });
    world.createObject({ id: "native_move_b", name: "Native Move B", parent: "$thing", owner: actor, location: "$nowhere" });
    world.createObject({ id: "native_move_item", name: "Native Move Item", parent: "$thing", owner: actor, location: "native_move_a" });
    const installed = installVerb(
      world,
      "native_move_item",
      "relocate_via_native",
      `verb :relocate_via_native(target) rxd {
        this:moveto(target);
        return location(this);
      }`,
      null
    );
    expect(installed.ok).toBe(true);

    const before = world.exportWorld();
    const recorder = new InMemoryTurnRecorder();
    world.setTurnRecorder(recorder);

    const result = await world.directCall("native-move-item", actor, "native_move_item", "relocate_via_native", ["native_move_b"]);

    expect(result).toMatchObject({ op: "result", result: "native_move_b" });
    const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
    expect(transcript.complete).toBe(true);
    expect(transcript.incompleteReasons).toEqual([]);
    expect(transcript.reads).toContainEqual(expect.objectContaining({
      cell: { kind: "verb", object: "$thing", name: "moveto" },
      value: expect.objectContaining({
        implementation: "native",
        native: "thing_moveto",
        native_contract: expect.objectContaining({
          kind: "woo.native_primitive_contract.shadow.v1",
          handler: "thing_moveto",
          transcript: "tracked",
          deterministic: true,
          writes: expect.arrayContaining(["object.location", "container.contents"])
        })
      })
    }));
    expect(transcript.writes).toContainEqual(expect.objectContaining({ cell: { kind: "location", object: "native_move_item" }, value: "native_move_b", op: "move" }));
    expect(validateTranscriptAgainstSerializedWorld(before, transcript)).toEqual({ ok: true, errors: [] });
  });

  it("keeps create_api_key transcript complete and records the contract", async () => {
    // Regression: native create_api_key was missing from the primitive-contract
    // registry, so v2 shadow-commit envelopes (REST and MCP) rejected wizard
    // apikey minting with incomplete_transcript. Adding the contract entry
    // both authorizes the commit and surfaces the effect shape in the
    // recorded dispatch read.
    const world = createWorld();
    const actor = "$wiz";

    world.createObject({ id: "apikey_target_actor", name: "Apikey Target", parent: "$actor", owner: actor });

    const before = world.exportWorld();
    const recorder = new InMemoryTurnRecorder();
    world.setTurnRecorder(recorder);

    const result = await world.directCall("create-apikey", actor, "$system", "create_api_key", ["apikey_target_actor", "wizard-mint"]);

    expect(result.op).toBe("result");
    const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
    expect(transcript.complete).toBe(true);
    expect(transcript.incompleteReasons).toEqual([]);
    expect(transcript.reads).toContainEqual(expect.objectContaining({
      cell: { kind: "verb", object: "$system", name: "create_api_key" },
      value: expect.objectContaining({
        implementation: "native",
        native: "create_api_key",
        native_contract: expect.objectContaining({
          kind: "woo.native_primitive_contract.shadow.v1",
          handler: "create_api_key",
          transcript: "tracked",
          deterministic: true,
          writes: expect.arrayContaining(["$system.api_keys", "$system.wizard_actions"])
        })
      })
    }));
    expect(validateTranscriptAgainstSerializedWorld(before, transcript)).toEqual({ ok: true, errors: [] });
  });

  it("keeps create_api_key_for_owner transcript complete and records the contract", async () => {
    // Owner-mint is the path $block:mint_apikey uses. The bug also blocked
    // this path on woah, so any plug whose configuration starts with
    // `:mint_apikey` (weather, horoscope, dispenser-style blocks) could not
    // bootstrap until this fix landed.
    const world = createWorld();
    const wizard = "$wiz";

    world.createObject({ id: "apikey_block_owner", name: "Block Owner", parent: "$actor", owner: wizard });
    world.createObject({ id: "apikey_owned_block", name: "Owned Block", parent: "$actor", owner: "apikey_block_owner" });

    const before = world.exportWorld();
    const recorder = new InMemoryTurnRecorder();
    world.setTurnRecorder(recorder);

    const result = await world.directCall("owner-mint-apikey", "apikey_block_owner", "$system", "create_api_key_for_owner", ["apikey_owned_block", "owner-mint"]);

    expect(result.op).toBe("result");
    const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
    expect(transcript.complete).toBe(true);
    expect(transcript.incompleteReasons).toEqual([]);
    expect(transcript.reads).toContainEqual(expect.objectContaining({
      cell: { kind: "verb", object: "$system", name: "create_api_key_for_owner" },
      value: expect.objectContaining({
        implementation: "native",
        native: "create_api_key_for_owner",
        native_contract: expect.objectContaining({
          kind: "woo.native_primitive_contract.shadow.v1",
          handler: "create_api_key_for_owner",
          transcript: "tracked",
          deterministic: true,
          reads: expect.arrayContaining(["target actor ownership"]),
          writes: expect.arrayContaining(["$system.api_keys", "$system.wizard_actions"])
        })
      })
    }));
    expect(validateTranscriptAgainstSerializedWorld(before, transcript)).toEqual({ ok: true, errors: [] });
  });

  it("marks cross-host dispatch as explicit incomplete_transcript until remote sub-transcripts are implemented", async () => {
    const world = createWorld();
    const session = world.auth("guest:turn-recorder-remote");
    const actor = session.actor;

    world.createObject({ id: "remote_box", name: "Remote Box", parent: "$thing", owner: actor });
    const installed = installVerb(
      world,
      "remote_box",
      "ping",
      `verb :ping() rxd {
        return 0;
      }`,
      null
    );
    expect(installed.ok).toBe(true);
    world.setHostBridge({
      localHost: "local",
      hostForObject: (id: string) => id === "remote_box" ? "remote" : null,
      isDescendantOf: async () => false,
      dispatch: async () => 7
    } as unknown as HostBridge);
    const before = world.exportWorld();
    const recorder = new InMemoryTurnRecorder();
    world.setTurnRecorder(recorder);

    const result = await world.directCall("remote-ping", actor, "remote_box", "ping", []);

    expect(result).toMatchObject({ op: "result", result: 7 });
    const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
    expect(transcript.complete).toBe(false);
    expect(transcript.incompleteReasons).toContain(remoteBridgeEffectName("dispatch"));
    expect(transcript.untrackedEffects).toContainEqual({
      name: remoteBridgeEffectName("dispatch"),
      detail: expect.objectContaining({
        target: "remote_box",
        verb: "ping",
        start_at: null,
        transcript_policy: expect.objectContaining({
          kind: "woo.remote_bridge_transcript_policy.shadow.v1",
          boundary: "cross_host_bridge",
          operation: "dispatch",
          policy: "incomplete_transcript",
          subtranscripts: "deferred",
          commit_result: "reject"
        })
      })
    });
    const receipt = shadowCommitReceipt(before, world.exportWorld(), transcript);
    expect(receipt.accepted).toBe(false);
    expect(receipt.errors).toContain(`incomplete:${remoteBridgeEffectName("dispatch")}`);
  });

  it("records placement writes for authored moves", async () => {
    const world = createWorld();
    const actor = "$wiz";

    world.createObject({ id: "move_a", name: "Move A", parent: "$thing", owner: actor, location: "$nowhere" });
    world.createObject({ id: "move_b", name: "Move B", parent: "$thing", owner: actor, location: "$nowhere" });
    world.createObject({ id: "move_item", name: "Move Item", parent: "$thing", owner: actor, location: "move_a" });
    const installed = installVerb(
      world,
      "move_item",
      "relocate",
      `verb :relocate(target) rxd {
        move(this, target);
        return { location: location(this) };
      }`,
      null
    );
    expect(installed.ok).toBe(true);

    const before = world.exportWorld();
    const recorder = new InMemoryTurnRecorder();
    world.setTurnRecorder(recorder);

    const result = await world.directCall("move-item", actor, "move_item", "relocate", ["move_b"]);

    expect(result.op).toBe("result");
    if (result.op === "result") expect(result.result).toEqual({ location: "move_b" });
    const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
    expect(transcript.complete).toBe(true);
    expect(transcript.writes).toContainEqual(expect.objectContaining({ cell: { kind: "location", object: "move_item" }, value: "move_b", op: "move" }));
    expect(transcript.writes).toContainEqual(expect.objectContaining({ cell: { kind: "contents", object: "move_a" }, value: [], op: "remove" }));
    expect(transcript.writes).toContainEqual(expect.objectContaining({ cell: { kind: "contents", object: "move_b" }, value: ["move_item"], op: "add" }));
    expect(transcript.reads).toContainEqual(expect.objectContaining({ cell: { kind: "location", object: "move_item" }, value: "move_b" }));
    expect(validateTranscriptAgainstSerializedWorld(before, transcript)).toEqual({ ok: true, errors: [] });
    const replayA = await replayRecordedTurn(before, recorder.turns[0]);
    const replayB = await replayRecordedTurn(before, recorder.turns[0]);
    expect(effectTranscriptFromRecordedTurn(replayA.recorded)).toEqual(transcript);
    expect(effectTranscriptFromRecordedTurn(replayB.recorded)).toEqual(transcript);
    const receiptA = shadowCommitReceipt(before, replayA.serializedAfter, transcript);
    const receiptB = shadowCommitReceipt(before, replayB.serializedAfter, transcript);
    expect(receiptA.accepted).toBe(true);
    expect(receiptA.post_state_hash).toBe(receiptB.post_state_hash);
  });

  it("reports read and write-prior validation errors against stale state", async () => {
    const world = createWorld();
    const session = world.auth("guest:turn-recorder-stale");
    const actor = session.actor;

    world.createObject({ id: "stale_box", name: "Stale Box", parent: "$thing", owner: actor });
    world.defineProperty("stale_box", { name: "counter", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
    const installed = installVerb(
      world,
      "stale_box",
      "bump",
      `verb :bump() rxd {
        let before = this.counter;
        this.counter = before + 1;
        return this.counter;
      }`,
      null
    );
    expect(installed.ok).toBe(true);

    const recorder = new InMemoryTurnRecorder();
    world.setTurnRecorder(recorder);
    const result = await world.directCall("stale-bump", actor, "stale_box", "bump", []);
    expect(result.op).toBe("result");

    const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
    const staleSerializedState = world.exportWorld();
    const validation = validateTranscriptAgainstSerializedWorld(staleSerializedState, transcript);

    expect(validation.ok).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      "read version mismatch stale_box.counter: transcript=1 actual=2",
      "read value mismatch stale_box.counter",
      "write prior mismatch stale_box.counter: transcript=1 actual=2"
    ]));
  });

  it("validates owner reads with deterministic owner cell versions", async () => {
    const world = createWorld();
    const session = world.auth("guest:turn-recorder-owner");
    const actor = session.actor;

    world.createObject({ id: "owner_box", name: "Owner Box", parent: "$thing", owner: actor });
    const installed = installVerb(
      world,
      "owner_box",
      "read_owner",
      `verb :read_owner() rxd {
        return this.owner;
      }`,
      null
    );
    expect(installed.ok).toBe(true);

    const before = world.exportWorld();
    const recorder = new InMemoryTurnRecorder();
    world.setTurnRecorder(recorder);
    const result = await world.directCall("owner-read", actor, "owner_box", "read_owner", []);
    expect(result).toMatchObject({ op: "result", result: actor });

    const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
    const ownerRead = transcript.reads.find((read) => read.cell.kind === "prop" && read.cell.object === "owner_box" && read.cell.name === "owner");
    expect(ownerRead?.version).toMatch(/^[a-f0-9]{64}$/);
    expect(validateTranscriptAgainstSerializedWorld(before, transcript)).toEqual({ ok: true, errors: [] });

    const stale = structuredClone(before);
    const staleObject = stale.objects.find((obj) => obj.id === "owner_box");
    expect(staleObject).toBeDefined();
    staleObject!.owner = "$wiz";
    const validation = validateTranscriptAgainstSerializedWorld(stale, transcript);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^read version mismatch owner_box\.owner:/),
      "read value mismatch owner_box.owner"
    ]));
  });

  it("can replay a recorded deterministic turn against a serialized pre-turn world", async () => {
    const world = createWorld();
    const session = world.auth("guest:turn-replay");
    const actor = session.actor;

    world.createObject({ id: "replay_box", name: "Replay Box", parent: "$thing", owner: actor });
    world.defineProperty("replay_box", { name: "counter", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
    const installed = installVerb(
      world,
      "replay_box",
      "bump",
      `verb :bump() rxd {
        let before = this.counter;
        this.counter = before + 1;
        observe({ type: "bumped", source: this, actor: actor, value: this.counter, ts: now() });
        return this.counter;
      }`,
      null
    );
    expect(installed.ok).toBe(true);

    const before = world.exportWorld();
    const recorder = new InMemoryTurnRecorder();
    world.setTurnRecorder(recorder);
    const result = await world.directCall("replay-bump", actor, "replay_box", "bump", [], { sessionId: session.id });
    expect(result.op).toBe("result");

    const replay = await replayRecordedTurn(before, recorder.turns[0]);

    expect(replay.frame.op).toBe("result");
    expect(comparableTurnEvents(replay.recorded.events)).toEqual(comparableTurnEvents(recorder.turns[0].events));
    const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
    expect(effectTranscriptFromRecordedTurn(replay.recorded)).toEqual(transcript);
    expect(validateTranscriptAgainstSerializedWorld(before, transcript)).toEqual({ ok: true, errors: [] });
    const preStateHash = transcriptTouchedStateHash(before, transcript);
    const postStateHash = transcriptTouchedStateHash(replay.serializedAfter, transcript);
    expect(preStateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(postStateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(postStateHash).not.toBe(preStateHash);
    const receipt = shadowCommitReceipt(before, replay.serializedAfter, transcript);
    expect(receipt).toMatchObject({
      kind: "woo.commit_receipt.shadow.v1",
      accepted: true,
      transcript_hash: transcript.hash,
      pre_state_hash: preStateHash,
      post_state_hash: postStateHash
    });
  });
});
