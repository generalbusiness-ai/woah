import { describe, expect, it } from "vitest";

import type { EffectTranscript } from "../src/core/effect-transcript";
import type { SerializedObject, SerializedWorld } from "../src/core/repository";
import {
  applyShadowTranscriptToCommittedState,
  applyShadowTranscriptToCommitScopeCache,
  createShadowCommitScope,
  transcriptTouchedObjectIds
} from "../src/core/shadow-commit-scope";
import type { MetricEvent } from "../src/core/types";

describe("shadow commit scope", () => {
  it("applies content add/remove writes as deltas in committed materializers", () => {
    const before = serializedWorld();
    const transcript = addChildTranscript();

    const committed = applyShadowTranscriptToCommittedState(before, transcript);
    expect(committed.objects.find((obj) => obj.id === "room")?.contents).toEqual(["created_b", "existing_a", "third_party"]);

    const scope = createShadowCommitScope({ node: "scope:test", scope: "room", serialized: before });
    applyShadowTranscriptToCommitScopeCache(scope, transcript);
    expect(scope.serialized.objects.find((obj) => obj.id === "room")?.contents).toEqual(["created_b", "existing_a", "third_party"]);
  });

  it("does not replace contents for malformed remove writes without move records", () => {
    const metrics: MetricEvent[] = [];
    const before = serializedWorld();
    const transcript = {
      ...addChildTranscript(),
      id: "bad-remove",
      hash: "transcript:bad-remove",
      creates: [],
      writes: [{
        cell: { kind: "contents" as const, object: "room" },
        value: ["existing_a"],
        op: "remove" as const
      }]
    };

    const committed = applyShadowTranscriptToCommittedState(before, transcript, { metric: (event) => metrics.push(event) });

    expect(committed.objects.find((obj) => obj.id === "room")?.contents).toEqual(["existing_a", "third_party"]);
    expect(metrics).toContainEqual({
      kind: "shadow_transcript_anomaly",
      scope: "room",
      route: "sequenced",
      reason: "contents_remove_without_move",
      object: "room",
      id: "bad-remove"
    });
  });

  it("tracks every written cell's object as touched for projection dependency patches", () => {
    const transcript: EffectTranscript = {
      ...addChildTranscript(),
      id: "all-write-kinds",
      hash: "transcript:all-write-kinds",
      creates: [],
      writes: [
        { cell: { kind: "prop", object: "prop_source", name: "name" }, value: "Prop Source", op: "set" },
        { cell: { kind: "verb", object: "verb_source", name: "look" }, value: null, op: "set" },
        { cell: { kind: "location", object: "moved_object" }, value: "room", op: "move" },
        { cell: { kind: "contents", object: "container" }, value: ["moved_object"], op: "replace" },
        { cell: { kind: "lifecycle", object: "created_object" }, value: true, op: "create" }
      ]
    };

    expect([...transcriptTouchedObjectIds(transcript)].sort()).toEqual([
      "container",
      "created_object",
      "moved_object",
      "prop_source",
      "verb_source"
    ]);
  });
});

function addChildTranscript(): EffectTranscript {
  return {
    kind: "woo.effect_transcript.shadow.v1",
    id: "add-child",
    route: "sequenced",
    scope: "room",
    seq: 0,
    session: "session-1",
    call: {
      actor: "actor",
      target: "room",
      verb: "add_child",
      args: [],
      body: undefined
    },
    reads: [],
    writes: [{
      cell: { kind: "contents", object: "room" },
      value: ["existing_a", "created_b"],
      op: "add"
    }],
    creates: [{
      object: "created_b",
      name: "Created B",
      parent: "$thing",
      owner: "actor",
      anchor: null,
      location: "room",
      flags: {}
    }],
    moves: [],
    observations: [],
    logicalInputs: [],
    untrackedEffects: [],
    complete: true,
    incompleteReasons: [],
    hash: "transcript:add-child"
  };
}

function serializedWorld(): SerializedWorld {
  return {
    version: 1,
    objectCounter: 1,
    parkedTaskCounter: 1,
    sessionCounter: 1,
    objects: [
      objectRecord("$thing", "$thing", null, []),
      objectRecord("actor", "Actor", "room", []),
      objectRecord("existing_a", "Existing A", "room", []),
      objectRecord("third_party", "Third Party", "room", []),
      objectRecord("room", "Room", null, ["existing_a", "third_party"])
    ],
    sessions: [{ id: "session-1", actor: "actor", started: 1, activeScope: "room" }],
    logs: [],
    snapshots: [],
    parkedTasks: [],
    tombstones: []
  };
}

function objectRecord(id: string, name: string, location: string | null, contents: string[]): SerializedObject {
  return {
    id,
    name,
    parent: null,
    anchor: null,
    owner: "actor",
    location,
    flags: {},
    created: 0,
    modified: 0,
    propertyDefs: [],
    properties: [],
    propertyVersions: [],
    verbs: [],
    children: [],
    contents,
    eventSchemas: []
  };
}
