import { describe, expect, it } from "vitest";

import {
  effectTranscriptFromRecordedTurn,
  readTranscriptCellFromSerializedWorld,
  withFailureEffectsGeneration,
  type EffectTranscript
} from "../src/core/effect-transcript";
import {
  FAILED_TRANSCRIPT_EFFECTS_CLEAN_GENERATION,
  FAILED_TRANSCRIPT_FIELD_CLASSIFICATION,
  classifyFailedTranscriptEffects,
  type FailedTranscriptEffectsReport
} from "../src/core/failed-transcript-effects";
import { installVerb } from "../src/core/authoring";
import { createWorld } from "../src/core/bootstrap";
import type { SerializedObject, SerializedWorld } from "../src/core/repository";
import { runShadowTurnCallOnWorldTranscript } from "../src/core/shadow-turn-call";
import {
  createShadowCommitScope,
  submitShadowCommit
} from "../src/core/shadow-commit-scope";
import {
  createShadowExecutionNode,
  executeShadowRecordedTurnOrNeedState
} from "../src/core/shadow-turn-exec";
import { shadowTurnKeyFromTranscript } from "../src/core/turn-key";
import type { MetricEvent } from "../src/core/types";
import { cellsFromSerialized, storeCells } from "../src/net/bridge";
import { CellStore } from "../src/net/cells";
import { planTurn } from "../src/net/plan";
import type { ScopeClassifier } from "../src/net/route";
import { ScopeSequencer, type CommitSubmit } from "../src/net/scope";
import {
  NET_FAILED_TRANSCRIPT_FIELD_CLASSIFICATION,
  applyTranscript,
  type EffectTranscript as NetEffectTranscript
} from "../src/net/transcript";

const ERROR = { code: "E_TEST", message: "test failure", value: null, trace: [] };
const ERROR_OBSERVATION = {
  type: "$error",
  code: ERROR.code,
  message: ERROR.message,
  value: ERROR.value,
  trace: ERROR.trace
};

describe("failed transcript effect classifier", () => {
  it("classifies every EffectTranscript field into a closed semantic class", () => {
    expect(FAILED_TRANSCRIPT_FIELD_CLASSIFICATION).toEqual({
      kind: "envelope",
      failureEffectsGeneration: "integrity",
      id: "envelope",
      route: "envelope",
      scope: "envelope",
      space: "envelope",
      seq: "envelope",
      session: "envelope",
      call: "envelope",
      reads: "proof",
      stateProbes: "proof",
      writes: "effect",
      creates: "effect",
      moves: "effect",
      recycles: "effect",
      schedules: "effect",
      cancellations: "effect",
      sessionScopeTransition: "effect",
      projectionWrites: "effect",
      observations: "outcome",
      logicalInputs: "proof",
      untrackedEffects: "effect",
      result: "outcome",
      error: "outcome",
      complete: "integrity",
      incompleteReasons: "integrity",
      hash: "integrity"
    });
  });

  it("classifies every Net intersection field instead of bypassing the core vocabulary", () => {
    expect(NET_FAILED_TRANSCRIPT_FIELD_CLASSIFICATION).toEqual({
      ...FAILED_TRANSCRIPT_FIELD_CLASSIFICATION,
      exclusiveMint: "envelope",
      sessionClose: "envelope",
      orderingReads: "proof",
      replayReads: "proof",
      principal: "envelope",
      trace: "envelope"
    });
  });

  it("fails closed when a runtime or classified effect field lacks executable semantics", () => {
    const unknownRuntimeField = {
      ...failedTranscript({
        failureEffectsGeneration: FAILED_TRANSCRIPT_EFFECTS_CLEAN_GENERATION
      }),
      futureEffect: [{ secret: "must not leak" }],
      // A transcript map is data, not a JavaScript namespace. This own field
      // must not be mistaken for Object.prototype.toString.
      toString: [{ secret: "also must not leak" }]
    } as unknown as EffectTranscript;
    const runtimeDrift = classifyFailedTranscriptEffects(unknownRuntimeField, {
      ownsSequencingSpace: false
    });
    expect(runtimeDrift).toMatchObject({
      policy: "enforce",
      valid: false,
      counts: { unclassified_fields: 2 },
      reasons: ["unclassified_fields"]
    });
    expect(JSON.stringify(runtimeDrift)).not.toContain("futureEffect");
    expect(JSON.stringify(runtimeDrift)).not.toContain("must not leak");
    expect(JSON.stringify(runtimeDrift)).not.toContain("also must not leak");

    // A future author cannot silence the runtime guard by merely labelling a
    // new field "effect": it still needs executable counting/admission
    // semantics. Core fields additionally have a compile-time exact inspector
    // registry derived from FAILED_TRANSCRIPT_FIELD_CLASSIFICATION.
    const classifiedButUnimplemented = classifyFailedTranscriptEffects(
      unknownRuntimeField,
      {
        ownsSequencingSpace: false,
        fieldClassification: {
          ...FAILED_TRANSCRIPT_FIELD_CLASSIFICATION,
          futureEffect: "effect" as const,
          toString: "envelope" as const
        }
      }
    );
    expect(classifiedButUnimplemented).toMatchObject({
      policy: "enforce",
      valid: false,
      counts: { unclassified_fields: 1 },
      reasons: ["unclassified_fields"]
    });
  });

  it("allows proof material plus exactly one owner allocation and canonical error outcome", () => {
    const transcript = failedTranscript({
      route: "sequenced",
      scope: "room:hall",
      space: "hall",
      seq: 1,
      reads: [
        { cell: { kind: "prop", object: "hall", name: "next_seq" }, version: "v1", value: 1 },
        {
          cell: { kind: "verb", object: "$thing", name: "poke" },
          version: "verb-v1",
          value: { implementation: "bytecode" }
        }
      ],
      stateProbes: [{ kind: "prop", object: "actor", name: "optional" }],
      writes: [{
        cell: { kind: "prop", object: "hall", name: "next_seq" },
        value: 2,
        op: "set"
      }],
      observations: [ERROR_OBSERVATION],
      logicalInputs: [{ name: "now", value: 1234 }]
    });

    const report = classifyFailedTranscriptEffects(transcript, { ownsSequencingSpace: true });
    expect(report).toMatchObject({
      policy: "observe",
      valid: true,
      reasons: [],
      counts: {
        allocation_writes: 1,
        behavior_writes: 0,
        canonical_error_observations: 1,
        domain_observations: 0
      }
    });
    // The classifier is read-only: proof fields remain available to the
    // ordinary authority validation that follows this admission check.
    expect(transcript.reads).toHaveLength(2);
    expect(transcript.stateProbes).toHaveLength(1);
    expect(transcript.logicalInputs).toHaveLength(1);
  });

  it("refuses an allocation at a non-owner without exposing its object or value", () => {
    const transcript = failedTranscript({
      route: "sequenced",
      scope: "cluster:actor",
      space: "hall",
      seq: 1,
      reads: [{ cell: { kind: "prop", object: "hall", name: "next_seq" }, version: "v1", value: 1 }],
      writes: [{ cell: { kind: "prop", object: "hall", name: "next_seq" }, value: 2, op: "set" }],
      observations: [ERROR_OBSERVATION],
      failureEffectsGeneration: FAILED_TRANSCRIPT_EFFECTS_CLEAN_GENERATION
    });

    const report = classifyFailedTranscriptEffects(transcript, { ownsSequencingSpace: false });
    expect(report.policy).toBe("enforce");
    expect(report.valid).toBe(false);
    expect(report.reasons).toEqual(["allocation_at_non_owner"]);
    expect(JSON.stringify(report)).not.toContain("hall");
    expect(JSON.stringify(report)).not.toContain("test failure");
  });

  it("keeps unknown producer generations observe-only during rolling deployment", () => {
    const unknown = {
      ...failedTranscript({
        route: "direct",
        observations: [{ type: "said", text: "legacy-shaped payload" }]
      }),
      failureEffectsGeneration: 2
    } as unknown as EffectTranscript;

    expect(classifyFailedTranscriptEffects(unknown, { ownsSequencingSpace: false })).toMatchObject({
      policy: "observe",
      generation: 2,
      valid: false,
      reasons: ["domain_observations", "error_observation_count"]
    });
  });

  it("returns bounded category counts for every forbidden effect kind", () => {
    const transcript = failedTranscript({
      route: "direct",
      writes: [{ cell: { kind: "prop", object: "secret-object", name: "secret-property" }, value: "secret-value", op: "set" }],
      creates: [{
        object: "created-secret",
        name: "Created Secret",
        parent: null,
        owner: "actor",
        anchor: null,
        location: null,
        flags: {}
      }],
      moves: [{ object: "actor", from: "hall", to: "elsewhere" }],
      recycles: [{ object: "retired-secret" }],
      sessionScopeTransition: { session: "secret-session", actor: "actor", from: "hall", to: "elsewhere" },
      projectionWrites: [{ table: "tombstones", key: "secret", op: "upsert", row: { id: "secret" }, bytes: 1 }],
      schedules: [{
        id: "secret-timer",
        at: 10,
        idlePolicy: "while_active",
        call: { actor: "actor", target: "actor", verb: "poke", args: [] }
      }],
      cancellations: [{ id: "secret-cancel" }],
      observations: [{ type: "said", text: "secret observation" }],
      untrackedEffects: [{ name: "secret external effect", detail: "secret detail" }],
      result: "secret result",
      failureEffectsGeneration: FAILED_TRANSCRIPT_EFFECTS_CLEAN_GENERATION
    });

    const report = classifyFailedTranscriptEffects(transcript, { ownsSequencingSpace: false });
    expect(report.valid).toBe(false);
    expect(report.counts).toMatchObject({
      behavior_writes: 1,
      creates: 1,
      moves: 1,
      recycles: 1,
      session_scope_transitions: 1,
      projection_writes: 1,
      schedules: 1,
      cancellations: 1,
      domain_observations: 1,
      untracked_effects: 1,
      results: 1
    });
    expect(report.reasons).toEqual([
      "behavior_writes",
      "creates",
      "moves",
      "recycles",
      "session_scope_transition",
      "projection_writes",
      "schedules",
      "cancellations",
      "domain_observations",
      "untracked_effects",
      "result_present",
      "error_observation_count"
    ]);
    const serialized = JSON.stringify(report);
    for (const secret of ["secret-object", "secret-property", "secret-value", "secret observation", "secret result"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("includes the opt-in generation in canonical transcript hashing without stamping base producers", () => {
    const recorded = effectTranscriptFromRecordedTurn({
      start: {
        id: "hash-test",
        route: "direct",
        scope: "hall",
        seq: 0,
        actor: "actor",
        target: "actor",
        verb: "poke",
        args: []
      },
      events: [
        { kind: "turn_finish", ok: false, error: ERROR }
      ]
    });
    expect(recorded.failureEffectsGeneration).toBeUndefined();

    const marked = withFailureEffectsGeneration(recorded, FAILED_TRANSCRIPT_EFFECTS_CLEAN_GENERATION);
    const sameBodyDifferentPriorHash = withFailureEffectsGeneration(
      { ...recorded, hash: "not-the-recorded-hash" },
      FAILED_TRANSCRIPT_EFFECTS_CLEAN_GENERATION
    );
    expect(marked.failureEffectsGeneration).toBe(1);
    expect(marked.hash).not.toBe(recorded.hash);
    expect(marked.hash).toBe(sameBodyDifferentPriorHash.hash);
  });
});

describe("clean failed-transcript producers", () => {
  it("stamps fresh execution and deterministic replay without stamping the generic converter", async () => {
    const world = createWorld();
    const serializedBefore = world.exportWorld();
    const fresh = await runShadowTurnCallOnWorldTranscript(world, {
      kind: "woo.turn_call.shadow.v1",
      id: "clean-producer",
      route: "direct",
      scope: "$wiz",
      actor: "$wiz",
      target: "$wiz",
      verb: "eval",
      args: ["1 + 2", {}]
    });
    expect(fresh.transcript.failureEffectsGeneration).toBe(
      FAILED_TRANSCRIPT_EFFECTS_CLEAN_GENERATION
    );
    expect(
      effectTranscriptFromRecordedTurn(fresh.recorded).failureEffectsGeneration
    ).toBeUndefined();

    const key = shadowTurnKeyFromTranscript(fresh.transcript);
    const replay = await executeShadowRecordedTurnOrNeedState(
      createShadowExecutionNode({
        node: "clean-replay",
        scope: key.scope,
        atom_hashes: key.atom_hashes,
        serialized: serializedBefore
      }),
      fresh.recorded,
      key
    );
    if (!replay.ok) {
      throw new Error(`unexpected replay failure: ${JSON.stringify(replay)}`);
    }
    expect(replay.transcript.failureEffectsGeneration).toBe(
      FAILED_TRANSCRIPT_EFFECTS_CLEAN_GENERATION
    );
  });

  it("replays a failed generation-1 turn with only durable proofs and its canonical failure", async () => {
    const world = createWorld();
    world.createObject({ id: "failed_replay_probe", parent: "$thing", owner: "$wiz" });
    world.defineProperty("failed_replay_probe", {
      name: "counter",
      defaultValue: 1,
      owner: "$wiz",
      perms: "rw",
      typeHint: "int"
    });
    expect(installVerb(
      world,
      "failed_replay_probe",
      "write_read_raise",
      `verb :write_read_raise() rxd {
        this.counter = this.counter + 1;
        let transient = this.counter;
        raise({ code: "E_PROOF_REPLAY", message: "expected failed replay" });
      }`,
      null
    ).ok).toBe(true);
    const serializedBefore = world.exportWorld();
    const fresh = await runShadowTurnCallOnWorldTranscript(world, {
      kind: "woo.turn_call.shadow.v1",
      id: "failed-clean-producer",
      route: "direct",
      scope: "failed_replay_probe",
      actor: "$wiz",
      target: "failed_replay_probe",
      verb: "write_read_raise",
      args: []
    });

    expect(fresh.transcript).toMatchObject({
      failureEffectsGeneration: FAILED_TRANSCRIPT_EFFECTS_CLEAN_GENERATION,
      error: { code: "E_PROOF_REPLAY", message: "expected failed replay" },
      writes: [],
      creates: [],
      moves: [],
      observations: [],
      untrackedEffects: [],
      complete: true,
      incompleteReasons: []
    });
    expect(fresh.transcript.result).toBeUndefined();
    expect(fresh.transcript.reads.filter((read) =>
      read.cell.kind === "prop" &&
      read.cell.object === "failed_replay_probe" &&
      read.cell.name === "counter"
    )).toEqual([
      expect.objectContaining({ value: 1 })
    ]);
    expect(classifyFailedTranscriptEffects(fresh.transcript, {
      ownsSequencingSpace: false
    })).toMatchObject({ policy: "enforce", valid: true, reasons: [] });

    // Submit the producer's exact numeric-version proof to the shadow
    // authority. This is the reviewer repro boundary: retaining the transient
    // version-2 read made this otherwise legitimate failed turn retry forever.
    const commitScope = createShadowCommitScope({
      node: "scope:failed-clean-commit",
      scope: fresh.transcript.scope,
      serialized: serializedBefore
    });
    const commitReply = submitShadowCommit(commitScope, {
      kind: "woo.commit.submit.shadow.v1",
      id: "failed-clean-producer",
      scope: fresh.transcript.scope,
      expected: commitScope.head,
      transcript: fresh.transcript
    });
    expect(commitReply, JSON.stringify(commitReply)).toMatchObject({
      kind: "woo.commit.accepted.shadow.v1"
    });

    const key = shadowTurnKeyFromTranscript(fresh.transcript);
    const replay = await executeShadowRecordedTurnOrNeedState(
      createShadowExecutionNode({
        node: "failed-clean-replay",
        scope: key.scope,
        atom_hashes: key.atom_hashes,
        serialized: serializedBefore
      }),
      fresh.recorded,
      key
    );
    if (!replay.ok) {
      throw new Error(`unexpected failed-turn replay refusal: ${JSON.stringify(replay)}`);
    }
    expect(replay.transcript).toEqual(fresh.transcript);
    expect(world.getProp("failed_replay_probe", "counter")).toBe(1);
  });

  it("prunes an inherited property proof resolved after a rolled-back chparent", async () => {
    const world = createWorld();
    world.createObject({ id: "proof_parent_a", parent: "$thing", owner: "$wiz" });
    world.createObject({ id: "proof_parent_b", parent: "$thing", owner: "$wiz" });
    world.createObject({ id: "proof_child", parent: "proof_parent_a", owner: "$wiz" });
    world.defineProperty("proof_parent_a", {
      name: "p",
      defaultValue: 1,
      owner: "$wiz",
      perms: "rw",
      typeHint: "int"
    });
    world.defineProperty("proof_parent_b", {
      name: "p",
      defaultValue: 99,
      owner: "$wiz",
      perms: "rw",
      typeHint: "int"
    });
    expect(installVerb(
      world,
      "proof_child",
      "chparent_read_raise",
      `verb :chparent_read_raise(parent) rxd {
        chparent(this, parent);
        let transient = this.p;
        raise({ code: "E_DERIVED_PROPERTY_PROOF", message: "expected rollback" });
      }`,
      null
    ).ok).toBe(true);

    const fresh = await runShadowTurnCallOnWorldTranscript(world, {
      kind: "woo.turn_call.shadow.v1",
      id: "derived-property-proof",
      route: "direct",
      scope: "proof_child",
      actor: "$wiz",
      target: "proof_child",
      verb: "chparent_read_raise",
      args: ["proof_parent_b"]
    });

    expect(world.object("proof_child").parent).toBe("proof_parent_a");
    expect(world.getProp("proof_child", "p")).toBe(1);
    expect(fresh.transcript).toMatchObject({
      failureEffectsGeneration: FAILED_TRANSCRIPT_EFFECTS_CLEAN_GENERATION,
      error: { code: "E_DERIVED_PROPERTY_PROOF" },
      writes: [],
      complete: true
    });
    expect(fresh.transcript.reads.filter((read) =>
      read.cell.kind === "prop" &&
      read.cell.object === "proof_child" &&
      read.cell.name === "p"
    )).toEqual([]);
    expect(classifyFailedTranscriptEffects(fresh.transcript, {
      ownsSequencingSpace: false
    })).toMatchObject({ policy: "enforce", valid: true, reasons: [] });
  });

  it("keeps pre-mutation alias dispatch proof and prunes the transient alias", async () => {
    const world = createWorld();
    world.createObject({ id: "alias_definer", parent: "$thing", owner: "$wiz" });
    world.createObject({ id: "alias_receiver", parent: "alias_definer", owner: "$wiz" });
    world.createObject({ id: "alias_controller", parent: "$thing", owner: "$wiz" });
    expect(installVerb(
      world,
      "alias_definer",
      "canonical",
      `verb :canonical() rxd { return 7; }`,
      null
    ).ok).toBe(true);
    world.setVerbInfoForActor("$wiz", "alias_definer", "canonical", {
      aliases: ["durable_alias"]
    });
    expect(installVerb(
      world,
      "alias_controller",
      "replace_alias_then_raise",
      `verb :replace_alias_then_raise(definer, receiver) rxd {
        let durable = dispatch(receiver, "durable_alias", []);
        set_verb_info(definer, "canonical", { aliases: ["transient_alias"] });
        let transient = dispatch(receiver, "transient_alias", []);
        raise({ code: "E_DERIVED_ALIAS_PROOF", message: "expected rollback" });
      }`,
      null
    ).ok).toBe(true);
    world.setRecordAuthoringCellWrites(true);

    const fresh = await runShadowTurnCallOnWorldTranscript(world, {
      kind: "woo.turn_call.shadow.v1",
      id: "derived-alias-proof",
      route: "direct",
      scope: "alias_controller",
      actor: "$wiz",
      target: "alias_controller",
      verb: "replace_alias_then_raise",
      args: ["alias_definer", "alias_receiver"]
    });

    expect(world.resolveVerb("alias_receiver", "durable_alias").definer).toBe("alias_definer");
    expect(() => world.resolveVerb("alias_receiver", "transient_alias")).toThrow();
    expect(fresh.transcript.reads).toContainEqual(expect.objectContaining({
      cell: { kind: "verb", object: "alias_definer", name: "durable_alias" }
    }));
    expect(fresh.transcript.reads).not.toContainEqual(expect.objectContaining({
      cell: { kind: "verb", object: "alias_definer", name: "transient_alias" }
    }));
    expect(fresh.transcript.stateProbes).toContainEqual({
      kind: "verb",
      object: "alias_definer",
      name: "durable_alias"
    });
    expect(fresh.transcript.stateProbes).not.toContainEqual({
      kind: "verb",
      object: "alias_definer",
      name: "transient_alias"
    });
  });

  it("keeps pre-mutation descendant dispatch and prunes resolution through a transient ancestor parent", async () => {
    const world = createWorld();
    world.createObject({ id: "dispatch_root_a", parent: "$thing", owner: "$wiz" });
    world.createObject({ id: "dispatch_root_b", parent: "$thing", owner: "$wiz" });
    world.createObject({ id: "dispatch_ancestor", parent: "dispatch_root_a", owner: "$wiz" });
    world.createObject({ id: "dispatch_descendant", parent: "dispatch_ancestor", owner: "$wiz" });
    world.createObject({ id: "dispatch_controller", parent: "$thing", owner: "$wiz" });
    expect(installVerb(
      world,
      "dispatch_root_a",
      "answer",
      `verb :answer() rxd { return 1; }`,
      null
    ).ok).toBe(true);
    expect(installVerb(
      world,
      "dispatch_root_b",
      "answer",
      `verb :answer() rxd { return 99; }`,
      null
    ).ok).toBe(true);
    expect(installVerb(
      world,
      "dispatch_controller",
      "ancestor_chparent_then_raise",
      `verb :ancestor_chparent_then_raise(ancestor, descendant, parent) rxd {
        let durable = dispatch(descendant, "answer", []);
        chparent(ancestor, parent);
        let transient = dispatch(descendant, "answer", []);
        raise({ code: "E_DERIVED_DISPATCH_PROOF", message: "expected rollback" });
      }`,
      null
    ).ok).toBe(true);

    const fresh = await runShadowTurnCallOnWorldTranscript(world, {
      kind: "woo.turn_call.shadow.v1",
      id: "derived-dispatch-proof",
      route: "direct",
      scope: "dispatch_controller",
      actor: "$wiz",
      target: "dispatch_controller",
      verb: "ancestor_chparent_then_raise",
      args: ["dispatch_ancestor", "dispatch_descendant", "dispatch_root_b"]
    });

    expect(world.object("dispatch_ancestor").parent).toBe("dispatch_root_a");
    expect(world.resolveVerb("dispatch_descendant", "answer").definer).toBe("dispatch_root_a");
    expect(fresh.transcript.reads).toContainEqual(expect.objectContaining({
      cell: { kind: "verb", object: "dispatch_root_a", name: "answer" }
    }));
    expect(fresh.transcript.reads).not.toContainEqual(expect.objectContaining({
      cell: { kind: "verb", object: "dispatch_root_b", name: "answer" }
    }));
    expect(fresh.transcript.stateProbes).not.toContainEqual({
      kind: "verb",
      object: "dispatch_root_b",
      name: "answer"
    });
  });
});

describe("failed transcript authority rollout", () => {
  it("shadow and Net accept the exact planned write-read-raise transcript", async () => {
    const world = createWorld();
    world.createObject({ id: "authority_parity_probe", parent: "$thing", owner: "$wiz" });
    world.defineProperty("authority_parity_probe", {
      name: "counter",
      defaultValue: 1,
      owner: "$wiz",
      perms: "rw",
      typeHint: "int"
    });
    expect(installVerb(
      world,
      "authority_parity_probe",
      "write_read_raise",
      `verb :write_read_raise() rxd {
        this.counter = this.counter + 1;
        let transient = this.counter;
        raise({ code: "E_AUTHORITY_PARITY", message: "expected authority parity" });
      }`,
      null
    ).ok).toBe(true);
    const serialized = world.exportWorld();
    const net = new ScopeSequencer("hall", "epoch-1");
    net.seed(cellsFromSerialized(serialized));
    const view = new CellStore("derived");
    for (const cell of storeCells(net.store)) view.install(cell);
    const classifier: ScopeClassifier = {
      scopeOf: () => "hall",
      isShared: (scope) => scope === "hall"
    };
    const plan = await planTurn({
      call: {
        kind: "woo.turn_call.shadow.v1",
        id: "authority-parity",
        route: "direct",
        scope: "hall",
        actor: "$wiz",
        target: "authority_parity_probe",
        verb: "write_read_raise",
        args: []
      },
      view,
      planningScope: "hall",
      classifier,
      base: net.head(),
      idempotencyKey: "authority-parity",
      stamp: net.stamp(),
      // Same-scope reads are already covered by the base-head CAS. Compacting
      // them is the real gateway submission shape and also removes the two
      // authorities' intentionally different local version vocabularies.
      compactOwnedReads: { scope: "hall" }
    });
    expect(plan.transcript.reads.filter((read) =>
      read.cell.kind === "prop" &&
      read.cell.object === "authority_parity_probe" &&
      read.cell.name === "counter"
    )).toEqual([
      expect.objectContaining({ value: 1 })
    ]);
    // This turn has no Net-only session cells after same-scope compaction, so
    // the widened Net transcript is also a core shadow transcript without
    // cloning or reshaping it.
    const sharedTranscript = plan.submit.transcript as unknown as EffectTranscript;

    const shadow = createShadowCommitScope({
      node: "scope:authority-parity",
      scope: "hall",
      serialized
    });
    const shadowReply = submitShadowCommit(shadow, {
      kind: "woo.commit.submit.shadow.v1",
      id: "authority-parity",
      scope: "hall",
      expected: shadow.head,
      transcript: sharedTranscript
    });
    const netReply = net.submit(plan.submit);

    expect(plan.submit.transcript).toBe(sharedTranscript);
    expect(sharedTranscript).toMatchObject({
      failureEffectsGeneration: FAILED_TRANSCRIPT_EFFECTS_CLEAN_GENERATION,
      error: { code: "E_AUTHORITY_PARITY" },
      reads: [],
      writes: [],
      creates: [],
      moves: [],
      observations: []
    });
    expect(shadowReply, JSON.stringify(shadowReply)).toMatchObject({
      kind: "woo.commit.accepted.shadow.v1"
    });
    expect(netReply, JSON.stringify(netReply)).toMatchObject({ status: "accepted" });
  });

  it("shadow and Net prioritize incompleteness over failed-effect admission", () => {
    const transcript = failedTranscript({
      id: "authority-reason-parity",
      scope: "hall",
      failureEffectsGeneration: FAILED_TRANSCRIPT_EFFECTS_CLEAN_GENERATION,
      complete: false,
      incompleteReasons: ["native:escaped_effect"],
      untrackedEffects: [{ name: "escaped_effect", detail: null }],
      hash: "authority-reason-parity-hash"
    });
    const shadow = createShadowCommitScope({
      node: "scope:authority-reason-parity",
      scope: "hall",
      serialized: serializedWorld()
    });
    const shadowReply = submitShadowCommit(shadow, {
      kind: "woo.commit.submit.shadow.v1",
      id: "authority-reason-parity",
      scope: "hall",
      expected: shadow.head,
      transcript
    });

    const net = new ScopeSequencer("hall", "epoch-1");
    const netReply = net.submit(netSubmit(
      net,
      transcript as NetEffectTranscript,
      "authority-reason-parity"
    ));

    expect(shadowReply).toMatchObject({
      kind: "woo.commit.conflict.shadow.v1",
      reason: "incomplete_transcript"
    });
    expect(netReply).toMatchObject({
      status: "rejected",
      reason: "incomplete_transcript"
    });
  });

  it("Net scope observes legacy violations and enforces the marked clean generation", () => {
    const reports: FailedTranscriptEffectsReport[] = [];
    const sequencer = new ScopeSequencer("hall", "epoch-1", {
      failedTranscriptEffects: (report) => reports.push(report)
    });
    const legacy = failedTranscript({
      route: "direct",
      scope: "hall",
      observations: [{ type: "said", text: "discard me" }]
    }) as NetEffectTranscript;

    expect(sequencer.submit(netSubmit(sequencer, legacy, "legacy")).status).toBe("accepted");
    const clean = {
      ...legacy,
      id: "clean",
      hash: "clean-hash",
      failureEffectsGeneration: FAILED_TRANSCRIPT_EFFECTS_CLEAN_GENERATION
    } as NetEffectTranscript;
    expect(sequencer.submit(netSubmit(sequencer, clean, "clean"))).toMatchObject({
      status: "rejected",
      reason: "invalid_error_effects",
      retryable: false,
      detail: {
        failure_effects: {
          generation: 1,
          reasons: ["domain_observations", "error_observation_count"]
        }
      }
    });
    expect(reports.map((report) => ({ policy: report.policy, valid: report.valid }))).toEqual([
      { policy: "observe", valid: false },
      { policy: "enforce", valid: false }
    ]);
  });

  it("Net scope admits its classified intersection metadata on a clean failed turn", () => {
    const sequencer = new ScopeSequencer("hall", "epoch-1");
    const transcript = {
      ...failedTranscript({
        route: "direct",
        scope: "hall",
        failureEffectsGeneration: FAILED_TRANSCRIPT_EFFECTS_CLEAN_GENERATION
      }),
      sessionClose: true,
      orderingReads: [],
      replayReads: []
    } as NetEffectTranscript;

    expect(sequencer.submit(netSubmit(sequencer, transcript, "net-intersections")))
      .toMatchObject({ status: "accepted" });
  });

  it("Net scope accepts the marked owner allocation envelope and rejects it at a non-owner", () => {
    const owner = new ScopeSequencer("room:hall", "epoch-1", {
      owns: (object) => object === "hall"
    });
    owner.seed([{ kind: "property_cell", object: "hall", name: "next_seq", value: { value: 1 } }]);
    const version = owner.store.get("property_cell:hall:next_seq")?.version;
    expect(version).toBeTruthy();
    const transcript = failedTranscript({
      route: "sequenced",
      scope: "room:hall",
      space: "hall",
      seq: 1,
      reads: [{ cell: { kind: "prop", object: "hall", name: "next_seq" }, version, value: 1 }],
      writes: [{
        cell: { kind: "prop", object: "hall", name: "next_seq" },
        value: 2,
        op: "set",
        writer: {
          progr: "actor",
          thisObj: "hall",
          verb: "call",
          definer: "hall",
          caller: "#-1",
          callerPerms: "actor"
        }
      }],
      observations: [ERROR_OBSERVATION],
      failureEffectsGeneration: FAILED_TRANSCRIPT_EFFECTS_CLEAN_GENERATION
    }) as NetEffectTranscript;
    const ownerReply = owner.submit(netSubmit(owner, transcript, "owner"));
    expect(ownerReply, JSON.stringify(ownerReply)).toMatchObject({ status: "accepted" });

    const nonOwner = new ScopeSequencer("cluster:actor", "epoch-1", {
      owns: () => false
    });
    const retargeted = { ...transcript, scope: "cluster:actor", hash: "non-owner-hash" };
    expect(nonOwner.submit(netSubmit(nonOwner, retargeted, "non-owner"))).toMatchObject({
      status: "rejected",
      reason: "invalid_error_effects",
      retryable: false
    });
  });

  it("shadow scope observes legacy violations and enforces the marked clean generation", () => {
    const scope = createShadowCommitScope({
      node: "scope:test",
      scope: "hall",
      serialized: serializedWorld()
    });
    const metrics: MetricEvent[] = [];
    const legacy = failedTranscript({
      route: "direct",
      scope: "hall",
      observations: [{ type: "said", text: "discard me" }]
    });
    const legacyReply = submitShadowCommit(scope, {
      kind: "woo.commit.submit.shadow.v1",
      id: "legacy",
      scope: "hall",
      expected: scope.head,
      transcript: legacy,
      metric: (event) => metrics.push(event)
    });
    expect(legacyReply.kind).toBe("woo.commit.accepted.shadow.v1");

    const clean = {
      ...legacy,
      id: "clean",
      hash: "clean-hash",
      failureEffectsGeneration: FAILED_TRANSCRIPT_EFFECTS_CLEAN_GENERATION
    };
    const cleanReply = submitShadowCommit(scope, {
      kind: "woo.commit.submit.shadow.v1",
      id: "clean",
      scope: "hall",
      expected: scope.head,
      transcript: clean,
      metric: (event) => metrics.push(event)
    });
    expect(cleanReply).toMatchObject({
      kind: "woo.commit.conflict.shadow.v1",
      reason: "invalid_error_effects",
      errors: ["invalid_error_effects:domain_observations,error_observation_count"]
    });
    expect(metrics.filter((event) => event.kind === "failed_transcript_effects")).toEqual([
      expect.objectContaining({ policy: "observe", valid: false, reason: "domain_observations" }),
      expect.objectContaining({ policy: "enforce", valid: false, reason: "domain_observations" })
    ]);
  });

  it("shadow scope accepts the marked owner allocation envelope and rejects it at a non-owner", () => {
    const serialized = serializedWorld();
    const hall = serialized.objects.find((object) => object.id === "hall");
    if (!hall) throw new Error("missing hall fixture");
    hall.properties = [["next_seq", 1]];
    hall.propertyVersions = [["next_seq", 1]];
    const allocationCell = { kind: "prop" as const, object: "hall", name: "next_seq" };
    const current = readTranscriptCellFromSerializedWorld(serialized, allocationCell);
    if (!current.ok) throw new Error(current.error);

    const transcript = failedTranscript({
      route: "sequenced",
      scope: "hall",
      space: "hall",
      seq: 1,
      reads: [{ cell: allocationCell, version: current.version, value: 1 }],
      writes: [{ cell: allocationCell, value: 2, op: "set" }],
      observations: [ERROR_OBSERVATION],
      failureEffectsGeneration: FAILED_TRANSCRIPT_EFFECTS_CLEAN_GENERATION
    });
    const owner = createShadowCommitScope({
      node: "scope:owner",
      scope: "hall",
      serialized
    });
    expect(submitShadowCommit(owner, {
      kind: "woo.commit.submit.shadow.v1",
      id: "owner-allocation",
      scope: "hall",
      expected: owner.head,
      transcript
    })).toMatchObject({ kind: "woo.commit.accepted.shadow.v1" });

    const nonOwner = createShadowCommitScope({
      node: "scope:non-owner",
      scope: "actor",
      serialized
    });
    const retargeted = {
      ...transcript,
      id: "non-owner-allocation",
      scope: "actor",
      hash: "non-owner-shadow-hash"
    };
    expect(submitShadowCommit(nonOwner, {
      kind: "woo.commit.submit.shadow.v1",
      id: "non-owner-allocation",
      scope: "actor",
      expected: nonOwner.head,
      transcript: retargeted
    })).toMatchObject({
      kind: "woo.commit.conflict.shadow.v1",
      reason: "invalid_error_effects",
      errors: ["invalid_error_effects:allocation_at_non_owner"]
    });
  });
});

function failedTranscript(partial: Partial<EffectTranscript>): EffectTranscript {
  return {
    kind: "woo.effect_transcript.shadow.v1",
    id: "failed",
    route: "direct",
    scope: "hall",
    seq: 0,
    call: { actor: "actor", target: "actor", verb: "poke", args: [] },
    reads: [],
    writes: [],
    creates: [],
    moves: [],
    observations: [],
    logicalInputs: [],
    untrackedEffects: [],
    error: ERROR,
    complete: true,
    incompleteReasons: [],
    hash: "failed-hash",
    ...partial
  };
}

function netSubmit(
  sequencer: ScopeSequencer,
  transcript: NetEffectTranscript,
  idempotencyKey: string
): CommitSubmit {
  const applied = applyTranscript(
    sequencer.store as CellStore,
    transcript,
    { scope_head: "planner", catalog_epoch: "epoch-1" }
  );
  return {
    kind: "woo.net.commit_submit.v1",
    scope: sequencer.scope,
    base: sequencer.head(),
    idempotency_key: idempotencyKey,
    transcript,
    post_state_version: applied.postStateVersion,
    stamp: { scope_head: "planner", catalog_epoch: "epoch-1" }
  };
}

function serializedWorld(): SerializedWorld {
  return {
    version: 1,
    objectCounter: 1,
    sessionCounter: 1,
    objects: [
      objectRecord("actor"),
      objectRecord("hall")
    ],
    sessions: [],
    logs: [],
    snapshots: [],
    tombstones: []
  };
}

function objectRecord(id: string): SerializedObject {
  return {
    id,
    name: id,
    parent: null,
    owner: "actor",
    location: null,
    anchor: null,
    flags: {},
    created: 0,
    modified: 0,
    propertyDefs: [],
    properties: [],
    propertyVersions: [],
    verbs: [],
    children: [],
    contents: [],
    eventSchemas: []
  };
}
