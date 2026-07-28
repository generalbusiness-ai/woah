import { describe, expect, it } from "vitest";

import {
  effectTranscriptFromRecordedTurn,
  readTranscriptCellFromSerializedWorld,
  withFailureEffectsGeneration,
  type EffectTranscript
} from "../src/core/effect-transcript";
import {
  FAILED_TRANSCRIPT_EFFECTS_CLEAN_GENERATION,
  classifyFailedTranscriptEffects,
  type FailedTranscriptEffectsReport
} from "../src/core/failed-transcript-effects";
import type { SerializedObject, SerializedWorld } from "../src/core/repository";
import {
  createShadowCommitScope,
  submitShadowCommit
} from "../src/core/shadow-commit-scope";
import type { MetricEvent } from "../src/core/types";
import { CellStore, cellVersion } from "../src/net/cells";
import { ScopeSequencer, type CommitSubmit } from "../src/net/scope";
import { applyTranscript, type EffectTranscript as NetEffectTranscript } from "../src/net/transcript";

const ERROR = { code: "E_TEST", message: "test failure", value: null, trace: [] };
const ERROR_OBSERVATION = {
  type: "$error",
  code: ERROR.code,
  message: ERROR.message,
  value: ERROR.value,
  trace: ERROR.trace
};

describe("failed transcript effect classifier", () => {
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

describe("failed transcript authority rollout", () => {
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
