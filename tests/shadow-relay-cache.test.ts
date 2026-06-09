import { describe, expect, it } from "vitest";

import type { EffectTranscript } from "../src/core/effect-transcript";
import type { ProjectionWrite } from "../src/core/projection-delta";
import type { SerializedObject, SerializedWorld } from "../src/core/repository";
import { createShadowBrowserRelayShim } from "../src/core/shadow-browser-node";
import { serializedFor, type ShadowCommitAccepted, type ShadowCommitScopeState } from "../src/core/shadow-commit-scope";
import {
  applyAcceptedFrameToRelayCache,
  markShadowBrowserRelaySerializedChanged,
  type ShadowRelayCache
} from "../src/core/shadow-relay-cache";
import type { MetricEvent } from "../src/core/types";

describe("shadow relay cache invalidation", () => {
  it("does not rebuild commit-scope state after an accepted-frame sync keeps serialized clean", () => {
    const relay = createRelay();
    const assignments = trackCommitScopeStateAssignments(relay);
    const metrics: MetricEvent[] = [];

    applyAcceptedFrameToRelayCache(relay, acceptedFrameWithProjection(), emptyTranscript(), { advanceHead: true });

    expect(assignments).toHaveLength(1);
    expect(relay.commit_scope.serializedDirty).toBe(false);
    expect(relay.commit_scope.state.objectsById.get("remote_widget")?.name).toBe("Remote Widget");
    expect(
      serializedFor(relay.commit_scope, { reason: "accepted_frame_regression", metric: (event) => metrics.push(event) })
        .objects.some((obj) => obj.id === "remote_widget")
    ).toBe(true);
    expect(metrics).toEqual([]);
  });

  it("still rebuilds commit-scope state for in-place serialized row edits", () => {
    const relay = createRelay();
    const world = serializedFor(relay.commit_scope);
    const originalObjectsRef = world.objects;
    const assignments = trackCommitScopeStateAssignments(relay);

    world.objects.push(objectRecord("late_object", "Late Object", "room", []));
    world.objects.sort((a, b) => a.id.localeCompare(b.id));
    expect(relay.commit_scope.state.serializedRefs.objects).toBe(originalObjectsRef);

    markShadowBrowserRelaySerializedChanged(relay);

    expect(assignments).toHaveLength(1);
    expect(relay.commit_scope.state.objectsById.get("late_object")?.name).toBe("Late Object");
  });
});

function trackCommitScopeStateAssignments(relay: ShadowRelayCache): ShadowCommitScopeState[] {
  const assignments: ShadowCommitScopeState[] = [];
  let current = relay.commit_scope.state;
  Object.defineProperty(relay.commit_scope, "state", {
    configurable: true,
    get: () => current,
    set: (next: ShadowCommitScopeState) => {
      assignments.push(next);
      current = next;
    }
  });
  return assignments;
}

function createRelay(): ShadowRelayCache {
  return createShadowBrowserRelayShim({
    node: "relay:test",
    scope: "room",
    serialized: serializedWorld()
  });
}

function acceptedFrameWithProjection(): ShadowCommitAccepted {
  const row = objectRecord("remote_widget", "Remote Widget", "room", []);
  const projectionWrite: ProjectionWrite = { table: "objects", op: "upsert", key: row.id, row, bytes: 1 };
  return {
    kind: "woo.commit.accepted.shadow.v1",
    id: "accepted-frame-regression",
    position: { kind: "woo.scope_head.shadow.v1", scope: "room", epoch: 1, seq: 1, hash: "head:1" },
    ts: 1,
    transcript_hash: "transcript:empty",
    post_state_hash: "post:1",
    observations: [],
    receipt: {
      kind: "woo.commit_receipt.shadow.v1",
      id: "accepted-frame-regression",
      route: "sequenced",
      scope: "room",
      seq: 0,
      transcript_hash: "transcript:empty",
      pre_state_hash: "pre:1",
      post_state_hash: "post:1",
      accepted: true,
      errors: []
    },
    projection_writes: [projectionWrite]
  };
}

function emptyTranscript(): EffectTranscript {
  return {
    kind: "woo.effect_transcript.shadow.v1",
    id: "accepted-frame-regression",
    route: "sequenced",
    scope: "room",
    seq: 0,
    session: "session-1",
    call: { actor: "actor", target: "room", verb: "noop", args: [], body: undefined },
    reads: [],
    writes: [],
    creates: [],
    moves: [],
    observations: [],
    logicalInputs: [],
    untrackedEffects: [],
    complete: true,
    incompleteReasons: [],
    hash: "transcript:empty"
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
      objectRecord("room", "Room", null, ["actor"])
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
