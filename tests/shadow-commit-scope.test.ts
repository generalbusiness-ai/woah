import { describe, expect, it } from "vitest";

import type { EffectTranscript } from "../src/core/effect-transcript";
import type { SerializedObject, SerializedWorld } from "../src/core/repository";
import {
  acceptedFrameTrackedObjectIds,
  applyAcceptedProjectionToCommitScopeCache,
  applyShadowTranscriptToCommitScopeCache,
  applyShadowTranscriptToIndexedState,
  createShadowCommitScope,
  recordAcceptedCommitScopeCellProvenance,
  serializedFor,
  transcriptTouchedObjectIds,
  type ShadowCommitAccepted
} from "../src/core/shadow-commit-scope";
import { planningCellKey } from "../src/core/planning-world";
import type { MetricEvent } from "../src/core/types";

describe("shadow commit scope", () => {
  it("applies content add/remove writes as deltas in committed materializers", () => {
    const before = serializedWorld();
    const transcript = addChildTranscript();

    const scope = createShadowCommitScope({ node: "scope:test", scope: "room", serialized: before });
    applyShadowTranscriptToCommitScopeCache(scope, transcript);
    expect(serializedFor(scope).objects.find((obj) => obj.id === "room")?.contents).toEqual(["created_b", "existing_a", "third_party"]);
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

    const scope = createShadowCommitScope({ node: "scope:test", scope: "room", serialized: before });
    applyShadowTranscriptToCommitScopeCache(scope, transcript, { metric: (event) => metrics.push(event) });

    expect(serializedFor(scope).objects.find((obj) => obj.id === "room")?.contents).toEqual(["existing_a", "third_party"]);
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

  it("includes source-row invalidation markers in indexed projection deltas", () => {
    const before = serializedWorld();
    const transcript = addChildTranscript();
    const scope = createShadowCommitScope({ node: "scope:test", scope: "room", serialized: before });

    const applied = applyShadowTranscriptToIndexedState(scope.state, transcript);

    const objectKeys = applied.projection_delta.objects?.map((op) => op.key).sort();
    expect(objectKeys).toEqual(["$thing", "created_b", "room"]);
    expect(applied.projection_delta.tool_surface_sources).toEqual(objectKeys?.map((key) => ({
      key: { table: "objects", authority_scope: "room", key },
      op: "upsert",
      bytes: 0
    })));
    expect(applied.projection_delta.projection_bytes).toBeGreaterThan(0);
  });

  it("does not scan side-channel tables to synthesize projection writes", () => {
    const before = {
      ...serializedWorld(),
      snapshots: [
        { space_id: "room", seq: 1, ts: 1, state: { before: true }, hash: "snapshot-before" }
      ],
      parkedTasks: [{
        id: "ptask_existing",
        parked_on: "room",
        state: "suspended" as const,
        resume_at: null,
        awaiting_player: null,
        correlation_id: null,
        serialized: {},
        created: 1,
        origin: "room"
      }],
      tombstones: ["recycled_existing"]
    };
    const transcript: EffectTranscript = {
      ...addChildTranscript(),
      id: "side-channel-no-scan",
      hash: "transcript:side-channel-no-scan",
      creates: [],
      writes: [{
        cell: { kind: "prop", object: "room", name: "summary" },
        value: "updated",
        op: "set"
      }]
    };
    const scope = createShadowCommitScope({ node: "scope:test", scope: "room", serialized: before });

    const applied = applyShadowTranscriptToIndexedState(scope.state, transcript);

    expect(applied.projection_delta).not.toHaveProperty("snapshots");
    expect(applied.projection_delta).not.toHaveProperty("parked_tasks");
    expect(applied.projection_delta).not.toHaveProperty("tombstones");
    const tables = applied.projection_writes.map((write) => write.table);
    expect(tables).toContain("objects");
    expect(tables).not.toContain("snapshots");
    expect(tables).not.toContain("parked_tasks");
    expect(tables).not.toContain("tombstones");
  });

  it("folds explicit side-channel projection writes without scanning side-channel tables", () => {
    const snapshot = { space_id: "room", seq: 2, ts: 2, state: { after: true }, hash: "snapshot-after" };
    const parkedTask = {
      id: "ptask_new",
      parked_on: "room",
      state: "suspended" as const,
      resume_at: 10,
      awaiting_player: null,
      correlation_id: null,
      serialized: {},
      created: 2,
      origin: "room"
    };
    const transcript: EffectTranscript = {
      ...addChildTranscript(),
      id: "side-channel-explicit",
      hash: "transcript:side-channel-explicit",
      creates: [],
      writes: [],
      projectionWrites: [
        { table: "snapshots", key: { space: "room", seq: 2 }, op: "upsert", row: snapshot, bytes: 10 },
        { table: "parked_tasks", key: "ptask_new", op: "upsert", row: parkedTask, bytes: 11 },
        { table: "tombstones", key: "recycled_new", op: "upsert", row: { id: "recycled_new" }, bytes: 12 }
      ]
    };
    const scope = createShadowCommitScope({ node: "scope:test", scope: "room", serialized: serializedWorld() });

    const applied = applyShadowTranscriptToIndexedState(scope.state, transcript);

    expect(applied.projection_delta.snapshots).toEqual([{ key: { space: "room", seq: 2 }, op: "upsert", bytes: 10 }]);
    expect(applied.projection_delta.parked_tasks).toEqual([{ key: "ptask_new", op: "upsert", bytes: 11 }]);
    expect(applied.projection_delta.tombstones).toEqual([{ key: "recycled_new", op: "upsert", bytes: 12 }]);
    expect(applied.state.snapshots).toContainEqual(snapshot);
    expect(applied.state.parkedTasks).toContainEqual(parkedTask);
    expect(applied.state.tombstones).toContain("recycled_new");
  });

  it("emits an authoritative object upsert for a move-only transcript (CA5 materialization)", () => {
    // Regression: a cross-scope move records only `moves` + a `live:location`
    // authority write; the moved object's own row is not otherwise touched. The
    // accepted commit MUST still carry an objects-projection upsert for the moved
    // object, with its REAL authoritative row (name "Mover", not a synthetic id
    // row), so a sparse destination shard materializes its lineage/name cell and
    // `who`/roster resolves a display name instead of the raw id.
    const before: SerializedWorld = {
      version: 1,
      objectCounter: 1,
      parkedTaskCounter: 1,
      sessionCounter: 1,
      objects: [
        objectRecord("mover", "Mover", "room", []),
        objectRecord("room", "Room", null, ["mover"]),
        objectRecord("dest", "Dest", null, [])
      ],
      sessions: [],
      logs: [],
      snapshots: [],
      parkedTasks: [],
      tombstones: []
    };
    const transcript: EffectTranscript = {
      kind: "woo.effect_transcript.shadow.v1",
      id: "move-only",
      route: "sequenced",
      scope: "mover",
      seq: 0,
      session: "session-mover",
      call: { actor: "mover", target: "room", verb: "go", args: [], body: undefined },
      reads: [],
      writes: [{ cell: { kind: "location", object: "mover" }, value: "dest", op: "move" }],
      creates: [],
      moves: [{ object: "mover", from: "room", to: "dest" }],
      observations: [],
      logicalInputs: [],
      untrackedEffects: [],
      complete: true,
      incompleteReasons: [],
      hash: "transcript:move-only"
    };

    const scope = createShadowCommitScope({ node: "scope:test", scope: "mover", serialized: before });
    const applied = applyShadowTranscriptToIndexedState(scope.state, transcript, { objectTimestamp: 1 });
    const moverUpsert = applied.projection_writes.find(
      (write) => write.table === "objects" && write.key === "mover" && write.op === "upsert"
    );
    expect(moverUpsert, JSON.stringify(applied.projection_writes.map((w) => ({ table: w.table, key: w.key, op: w.op })))).toBeTruthy();
    const row = (moverUpsert as { row?: SerializedObject }).row;
    expect(row?.name).toBe("Mover");
    expect(row?.location).toBe("dest");
  });

  // P1b (review): an accepted frame can materialize authority rows via
  // projection_writes that the transcript does not touch. The provenance-recording
  // set MUST include those object keys, or a relay caches a row with no provenance
  // and the admission gate flags it missing. acceptedFrameTrackedObjectIds (shared by
  // gateway + browser) covers transcript-touched ids PLUS projection_writes objects.
  it("tracks projection_writes object rows an accepted frame materializes, not just transcript-touched ids", () => {
    const emptyTranscript: EffectTranscript = {
      kind: "woo.effect_transcript.shadow.v1",
      id: "frame-only",
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
      hash: "transcript:frame-only"
    };
    const accepted = {
      projection_writes: [
        { table: "objects", op: "upsert", key: "remote_widget", row: objectRecord("remote_widget", "Remote Widget", "room", []) }
      ]
    } as unknown as ShadowCommitAccepted;

    // The transcript alone touches nothing; the helper must still surface the
    // projection_writes object row.
    expect(transcriptTouchedObjectIds(emptyTranscript).has("remote_widget")).toBe(false);
    expect(acceptedFrameTrackedObjectIds(emptyTranscript, accepted).has("remote_widget")).toBe(true);

    const scope = createShadowCommitScope({ node: "scope:test", scope: "room", serialized: serializedWorld() });
    recordAcceptedCommitScopeCellProvenance(scope, emptyTranscript, accepted, "cache");
    expect(scope.cellProvenance?.get(planningCellKey("remote_widget", "object_lineage"))).toEqual({ source: "cache" });
    expect(scope.cellProvenance?.get(planningCellKey("remote_widget", "object_live"))).toEqual({ source: "cache" });
  });

  // P1a (review): MCP/REST cross-relay parity. applyAcceptedProjectionToCommitScopeCache
  // materializes the authority projection_writes object rows (a moved object's real
  // lineage/live), which transcript-only replay (applyShadowTranscriptToCommitScopeCache)
  // does NOT — that drift left a relay with room.contents=["actor"] but no actor row.
  it("materializes authority projection_writes object rows (not just transcript replay)", () => {
    const accepted = {
      projection_writes: [
        { table: "objects", op: "upsert", key: "remote_widget", row: objectRecord("remote_widget", "Remote Widget", "room", []) }
      ]
    } as unknown as ShadowCommitAccepted;
    const emptyTranscript: EffectTranscript = {
      kind: "woo.effect_transcript.shadow.v1", id: "frame-only", route: "sequenced", scope: "room", seq: 0,
      session: "session-1", call: { actor: "actor", target: "room", verb: "noop", args: [], body: undefined },
      reads: [], writes: [], creates: [], moves: [], observations: [], logicalInputs: [], untrackedEffects: [],
      complete: true, incompleteReasons: [], hash: "transcript:frame-only"
    };

    // Transcript replay alone (no creates) does not materialize the row.
    const replayScope = createShadowCommitScope({ node: "scope:test", scope: "room", serialized: serializedWorld() });
    applyShadowTranscriptToCommitScopeCache(replayScope, emptyTranscript);
    expect(serializedFor(replayScope).objects.some((o) => o.id === "remote_widget")).toBe(false);

    // The MCP/REST projection apply materializes the authority row.
    const projScope = createShadowCommitScope({ node: "scope:test", scope: "room", serialized: serializedWorld() });
    expect(applyAcceptedProjectionToCommitScopeCache(projScope, accepted, emptyTranscript)).toBe(true);
    const widget = serializedFor(projScope).objects.find((o) => o.id === "remote_widget");
    expect(widget?.name).toBe("Remote Widget");
  });

  // record-if-stronger (review): a derived `cache` stamp never downgrades a stronger
  // recorded source (e.g. an owner authoritative row from a merge).
  it("does not downgrade a stronger recorded provenance with a cache stamp", () => {
    const scope = createShadowCommitScope({ node: "scope:test", scope: "room", serialized: serializedWorld() });
    // "room" is in addChildTranscript's touched set (its contents cell is written),
    // so the cache stamp would apply — but a recorded authoritative source must win.
    (scope.cellProvenance ??= new Map()).set(planningCellKey("room", "object_lineage"), { source: "authoritative" });
    recordAcceptedCommitScopeCellProvenance(scope, addChildTranscript(), undefined, "cache");
    expect(scope.cellProvenance?.get(planningCellKey("room", "object_lineage"))).toEqual({ source: "authoritative" });
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
