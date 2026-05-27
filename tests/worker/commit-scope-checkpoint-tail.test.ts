import { describe, expect, it } from "vitest";
import { createWorld } from "../../src/core/bootstrap";
import { installVerb } from "../../src/core/authoring";
import type { EffectTranscript } from "../../src/core/effect-transcript";
import { executorAuthorityPayload } from "../../src/core/executor";
import type { ProjectionWrite } from "../../src/core/projection-delta";
import type { SerializedObject, SerializedSession, SerializedWorld } from "../../src/core/repository";
import type { ObjRef } from "../../src/core/types";
import type { ShadowCommitAccepted, ShadowScopeHead } from "../../src/core/shadow-commit-scope";
import { CommitScopeDO } from "../../src/worker/commit-scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { FakeDurableObjectState } from "./fake-do";

const SECRET = "test-secret";

class WaitUntilState extends FakeDurableObjectState {
  readonly waitUntilPromises: Promise<unknown>[] = [];

  waitUntil(promise: Promise<unknown>): void {
    this.waitUntilPromises.push(promise);
  }

  async drainWaitUntil(): Promise<void> {
    await Promise.all(this.waitUntilPromises);
  }
}

function head(scope: ObjRef, seq: number): ShadowScopeHead {
  return {
    kind: "woo.scope_head.shadow.v1",
    scope,
    epoch: 1,
    seq,
    hash: `h${seq}`
  };
}

function accepted(scope: ObjRef, seq: number, projectionWrites?: ProjectionWrite[]): ShadowCommitAccepted {
  return {
    kind: "woo.commit.accepted.shadow.v1",
    id: `commit-${seq}`,
    position: head(scope, seq),
    transcript_hash: `tx-${seq}`,
    post_state_hash: `post-${seq}`,
    observations: [],
    receipt: {
      kind: "woo.commit_receipt.shadow.v1",
      id: `commit-${seq}`,
      route: "sequenced",
      scope,
      seq,
      transcript_hash: `tx-${seq}`,
      pre_state_hash: `pre-${seq}`,
      post_state_hash: `post-${seq}`,
      accepted: true,
      errors: []
    },
    ...(projectionWrites ? {
      projection_delta: {
        objects: projectionWrites.filter((write) => write.table === "objects").map((write) => ({ key: write.key, op: write.op, bytes: write.bytes })),
        projection_bytes: projectionWrites.reduce((sum, write) => sum + write.bytes, 0)
      },
      projection_writes: projectionWrites
    } : {})
  };
}

function emptyTranscript(scope: ObjRef): EffectTranscript {
  return {
    kind: "woo.effect_transcript.shadow.v1",
    id: "empty",
    route: "sequenced",
    scope,
    seq: 0,
    session: null,
    call: { actor: "$wiz", target: scope, verb: "noop", args: [] },
    reads: [],
    writes: [],
    creates: [],
    moves: [],
    observations: [],
    logicalInputs: [],
    untrackedEffects: [],
    complete: true,
    incompleteReasons: [],
    hash: "empty"
  };
}

describe("CommitScopeDO checkpoint/tail open", () => {
  it("does not prune tail rows until a complete checkpoint covers the pruned prefix", () => {
    const state = new FakeDurableObjectState("scope-a");
    const target = new CommitScopeDO(state as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: SECRET }) as unknown as {
      pruneAcceptedFramesByHorizon: (relay: { commit_scope: { scope: ObjRef } }, now: number) => number;
      pruneTranscriptTailByHorizon: (relay: { commit_scope: { scope: ObjRef } }, now: number) => number;
    };
    const scope = "scope-a";
    const now = Date.now();
    const relay = { commit_scope: { scope } };
    seedTailRows(state, scope, 1001, now);

    try {
      expect(target.pruneAcceptedFramesByHorizon(relay, now)).toBe(0);
      expect(target.pruneTranscriptTailByHorizon(relay, now)).toBe(0);
      expect(tailRowCount(state, "v2_commit_scope_accepted_frame")).toBe(1001);
      expect(tailRowCount(state, "v2_commit_scope_transcript_tail")).toBe(1001);

      seedCheckpointRow(state, scope, head(scope, 1), now);

      expect(target.pruneAcceptedFramesByHorizon(relay, now)).toBe(1);
      expect(target.pruneTranscriptTailByHorizon(relay, now)).toBe(1);
      expect(tailSeqs(state, "v2_commit_scope_accepted_frame")).not.toContain(1);
      expect(tailSeqs(state, "v2_commit_scope_transcript_tail")).not.toContain(1);
    } finally {
      state.close();
    }
  });

  it("returns row-body-complete frame transfers when known_head is retained", async () => {
    const state = new FakeDurableObjectState("scope-a");
    const target = new CommitScopeDO(state as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: SECRET });
    const objectRow = createWorld().exportObjects(["the_chatroom"])[0]!;
    const write: ProjectionWrite = {
      table: "objects",
      key: "the_chatroom",
      op: "upsert",
      row: objectRow,
      bytes: 101
    };
    const frame = accepted("scope-a", 1, [write]);
    seedScopeRows(state, "scope-a", head("scope-a", 1), { objects: [objectRow], frames: [frame] });

    try {
      const response = await target.fetch(await checkpointOpenRequest("scope-a", { known_head: head("scope-a", 0) }));
      expect(response.ok).toBe(true);
      const body = await response.json() as Record<string, any>;
      expect(body).toMatchObject({
        ok: true,
        open_protocol: "checkpoint_tail.v1",
        head: { seq: 1 },
        transfer: {
          kind: "frames",
          frames: [{ frame: { position: { seq: 1 } }, projection_writes: [write] }]
        }
      });
      expect(body.transfer.frames[0].frame.projection_writes).toBeUndefined();
    } finally {
      state.close();
    }
  });

  it("returns browser-profile frame transfers without authority object bodies", async () => {
    const state = new FakeDurableObjectState("scope-a");
    const target = new CommitScopeDO(state as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: SECRET });
    const objectRow = createWorld().exportObjects(["the_chatroom"])[0]!;
    const write: ProjectionWrite = {
      table: "objects",
      key: "the_chatroom",
      op: "upsert",
      row: objectRow,
      bytes: 101
    };
    const frame = accepted("scope-a", 1, [write]);
    seedScopeRows(state, "scope-a", head("scope-a", 1), { objects: [objectRow], frames: [frame] });

    try {
      const response = await target.fetch(await checkpointOpenRequest("scope-a", {
        known_head: head("scope-a", 0),
        receiver_profile: "browser"
      }));
      expect(response.ok).toBe(true);
      const body = await response.json() as Record<string, any>;
      const browserWrite = body.transfer.frames[0].projection_writes[0];
      expect(browserWrite).toMatchObject({
        table: "objects",
        key: "the_chatroom",
        op: "upsert",
        row: {
          kind: "woo.browser_object_row.v1",
          id: "the_chatroom",
          display: { id: "the_chatroom", name: expect.any(String) }
        }
      });
      expect(browserWrite.row.properties).toBeUndefined();
      expect(browserWrite.row.verbs).toBeUndefined();
      expect(browserWrite.row.propertyDefs).toBeUndefined();
    } finally {
      state.close();
    }
  });

  it("persists side-channel projection writes without waiting for the next full save", () => {
    const state = new FakeDurableObjectState("scope-a");
    const target = new CommitScopeDO(state as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: SECRET }) as unknown as {
      saveTranscriptDelta: (relay: unknown, transcript: EffectTranscript, now: number, projectionWrites: readonly ProjectionWrite[]) => void;
    };
    const now = Date.now();
    seedScopeRows(state, "scope-a", head("scope-a", 1), {});
    const snapshot = { space_id: "scope-a", seq: 1, ts: 1, state: { view: "side-channel" }, hash: "snapshot-side-channel" };
    const task = {
      id: "task-side-channel",
      parked_on: "scope-a",
      state: "suspended" as const,
      resume_at: null,
      awaiting_player: null,
      correlation_id: null,
      serialized: {},
      created: 1,
      origin: "scope-a"
    };
    const writes: ProjectionWrite[] = [
      { table: "snapshots", key: { space: "scope-a", seq: 1 }, op: "upsert", row: snapshot, bytes: 10 },
      { table: "parked_tasks", key: task.id, op: "upsert", row: task, bytes: 10 },
      { table: "tombstones", key: "recycled-side-channel", op: "upsert", row: { id: "recycled-side-channel" }, bytes: 10 }
    ];

    try {
      target.saveTranscriptDelta({ commit_scope: { scope: "scope-a" } }, emptyTranscript("scope-a"), now, writes);

      expect(rowCount(state, "v2_commit_scope_snapshot")).toBe(1);
      expect(rowCount(state, "v2_commit_scope_task")).toBe(1);
      expect(rowCount(state, "v2_commit_scope_tombstone")).toBe(1);
    } finally {
      state.close();
    }
  });

  it("returns pending instead of synchronously building a checkpoint, then serves the scheduled checkpoint", async () => {
    const state = new WaitUntilState("scope-a");
    const target = new CommitScopeDO(state as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: SECRET });
    const objectRow = createWorld().exportObjects(["the_chatroom"])[0]!;
    const frame = accepted("scope-a", 1);
    seedScopeRows(state, "scope-a", head("scope-a", 1), { objects: [objectRow], frames: [frame] });

    try {
      const pending = await target.fetch(await checkpointOpenRequest("scope-a", { known_head: head("scope-a", 0) }));
      expect(pending.status).toBe(425);
      expect(await pending.json()).toMatchObject({ error: { code: "E_CHECKPOINT_PENDING" } });
      expect(checkpointRows(state)).toBe(0);

      await state.drainWaitUntil();
      expect(checkpointRows(state)).toBe(1);
      expect(checkpointPageRows(state)).toBeGreaterThan(0);
      expect(checkpointFrameRows(state)).toBe(1);
      expect(JSON.parse(checkpointManifestBody(state) ?? "{}")).toMatchObject({
        kind: "woo.scope_checkpoint_manifest.v1",
        pages: expect.arrayContaining([expect.objectContaining({ kind: "woo.projection_page_ref.v1", table: "objects" })]),
        frame_tail: [expect.objectContaining({ seq: 1 })]
      });

      const checkpoint = await target.fetch(await checkpointOpenRequest("scope-a"));
      expect(checkpoint.ok).toBe(true);
      const body = await checkpoint.json() as Record<string, any>;
      expect(body).toMatchObject({
        ok: true,
        open_protocol: "checkpoint_tail.v1",
        head: { seq: 1 },
        transfer: {
          kind: "checkpoint",
          checkpoint: {
            scope: "scope-a",
            head: { seq: 1 },
            pages: expect.arrayContaining([expect.objectContaining({ table: "objects" })])
          }
        }
      });
      expect(body.transfer.checkpoint.frame_tail.map((item: ShadowCommitAccepted) => item.position.seq)).toEqual([1]);
    } finally {
      state.close();
    }
  });

  it("returns browser-profile checkpoint pages without authority object bodies", async () => {
    const state = new WaitUntilState("scope-a");
    const target = new CommitScopeDO(state as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: SECRET });
    const objectRow = createWorld().exportObjects(["the_chatroom"])[0]!;
    seedScopeRows(state, "scope-a", head("scope-a", 1), { objects: [objectRow], frames: [accepted("scope-a", 1)] });

    try {
      const pending = await target.fetch(await checkpointOpenRequest("scope-a", { receiver_profile: "browser" }));
      expect(pending.status).toBe(425);
      await state.drainWaitUntil();

      const response = await target.fetch(await checkpointOpenRequest("scope-a", { receiver_profile: "browser" }));
      expect(response.ok).toBe(true);
      const body = await response.json() as Record<string, any>;
      const objectPage = body.transfer.checkpoint.pages.find((page: any) => page.table === "objects");
      expect(objectPage.rows[0]).toMatchObject({
        kind: "woo.browser_object_row.v1",
        id: "the_chatroom"
      });
      expect(objectPage.rows[0].properties).toBeUndefined();
      expect(body.transfer.checkpoint.pages.some((page: any) => page.table === "snapshots" || page.table === "parked_tasks")).toBe(false);
    } finally {
      state.close();
    }
  });

  it("omits persisted session rows whose actor object row is absent", () => {
    const state = new WaitUntilState("scope-a");
    const world = createWorld();
    const live = world.auth("guest:commit-scope-live-session");
    const liveSession = world.exportSessions().find((session) => session.id === live.id)!;
    const liveActor = world.exportObjects([live.actor])[0]!;
    const scopeRow = world.exportObjects(["the_deck"])[0]!;
    const target = new CommitScopeDO(state as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: SECRET }) as unknown as {
      serializedProjectionWorld: () => SerializedWorld;
    };
    seedScopeRows(state, "scope-a", head("scope-a", 1), {
      objects: [scopeRow, liveActor],
      sessions: [
        liveSession,
        {
          id: "session-stale-actor",
          actor: "guest_missing_from_snapshot" as ObjRef,
          started: 1,
          expiresAt: Date.now() + 60_000,
          activeScope: "the_deck" as ObjRef
        }
      ]
    });

    try {
      const serialized = target.serializedProjectionWorld();

      expect(serialized.sessions.map((session) => session.id)).toEqual([live.id]);
    } finally {
      state.close();
    }
  });

  it("repairs bundled catalog verbs when loading a durable snapshot", async () => {
    const state = new WaitUntilState("the_deck");
    const currentWorld = createWorld();
    const staleWorld = createWorld();
    const session = currentWorld.auth("guest:commit-scope-snapshot-repair");
    const currentRoster = currentWorld.ownVerbExact("$conversational", "room_roster")!;
    const staleRoster = staleWorld.ownVerbExact("$conversational", "room_roster")!;
    installVerb(
      staleWorld,
      "$conversational",
      "room_roster",
      "verb :room_roster() rxd { return [\"stale\"]; }",
      staleRoster.version
    );
    const staleSeed = staleWorld.exportHostScopedWorld("the_deck");
    const target = new CommitScopeDO(state as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: SECRET });
    const authority = executorAuthorityPayload(currentWorld, ["the_deck", session.actor]);

    seedScopeRows(state, "the_deck", head("the_deck", 0), {
      objects: staleSeed.objects,
      sessions: authority.sessions
    });

    try {
      const request = await signInternalRequest({ WOO_INTERNAL_SECRET: SECRET }, new Request("https://woo.internal/v2/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "the_deck",
          node: "browser:commit-scope-snapshot-repair",
          token: "guest:commit-scope-snapshot-repair",
          session: session.id,
          actor: session.actor,
          ...authority
        })
      }));
      const response = await target.fetch(request);
      await state.drainWaitUntil();

      expect(response.ok).toBe(true);
      const repaired = objectRow(state, "$conversational");
      expect(repaired?.verbs.find((verb) => verb.name === "room_roster")?.source).toBe(currentRoster.source);
    } finally {
      state.close();
    }
  });

  it("pages checkpoints by byte budget and resumes the pinned export with a continuation", async () => {
    const state = new WaitUntilState("scope-a");
    const target = new CommitScopeDO(state as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: SECRET });
    const base = createWorld().exportObjects(["the_chatroom"])[0]!;
    const first = largeProjectionObject(base, "large_projection_one", 530 * 1024);
    const second = largeProjectionObject(base, "large_projection_two", 530 * 1024);
    seedScopeRows(state, "scope-a", head("scope-a", 1), { objects: [first, second] });

    try {
      const pending = await target.fetch(await checkpointOpenRequest("scope-a", { transfer_budget_bytes: 600 * 1024 }));
      expect(pending.status).toBe(425);
      await state.drainWaitUntil();
      const manifestBody = checkpointManifestBody(state) ?? "";
      expect(manifestBody.length).toBeLessThan(4096);
      expect(manifestBody).not.toContain("large_projection_one");
      expect(manifestBody).not.toContain("checkpoint_blob");
      expect(checkpointPageRows(state)).toBe(2);

      const firstPageResponse = await target.fetch(await checkpointOpenRequest("scope-a", { transfer_budget_bytes: 600 * 1024 }));
      expect(firstPageResponse.ok).toBe(true);
      const firstPage = await firstPageResponse.json() as Record<string, any>;
      expect(firstPage.transfer).toMatchObject({
        kind: "checkpoint",
        checkpoint: {
          checkpoint_hash: expect.any(String),
          pages: [
            expect.objectContaining({
              table: "objects",
              rows: [expect.objectContaining({ id: "large_projection_one" })]
            })
          ],
          frame_tail: []
        },
        continuation: {
          export_id: expect.any(String),
          checkpoint_hash: firstPage.transfer.checkpoint.checkpoint_hash,
          head: { seq: 1 }
        }
      });

      const finalPageResponse = await target.fetch(await checkpointOpenRequest("scope-a", {
        transfer_budget_bytes: 600 * 1024,
        continuation: firstPage.transfer.continuation
      }));
      expect(finalPageResponse.ok).toBe(true);
      const finalPage = await finalPageResponse.json() as Record<string, any>;
      expect(finalPage.transfer).toMatchObject({
        kind: "checkpoint",
        checkpoint: {
          checkpoint_hash: firstPage.transfer.checkpoint.checkpoint_hash,
          pages: [
            expect.objectContaining({
              table: "objects",
              rows: [expect.objectContaining({ id: "large_projection_two" })]
            })
          ]
        }
      });
      expect(finalPage.transfer.continuation).toBeUndefined();
    } finally {
      state.close();
    }
  });

  it("continues row-body-complete frame transfers by byte budget", async () => {
    const state = new FakeDurableObjectState("scope-a");
    const target = new CommitScopeDO(state as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: SECRET });
    const base = createWorld().exportObjects(["the_chatroom"])[0]!;
    const first = largeProjectionObject(base, "large_projection_one", 530 * 1024);
    const second = largeProjectionObject(base, "large_projection_two", 530 * 1024);
    seedScopeRows(state, "scope-a", head("scope-a", 2), {
      frames: [
        accepted("scope-a", 1, [{ table: "objects", key: first.id, op: "upsert", row: first, bytes: 530 * 1024 }]),
        accepted("scope-a", 2, [{ table: "objects", key: second.id, op: "upsert", row: second, bytes: 530 * 1024 }])
      ]
    });

    try {
      const firstFrameResponse = await target.fetch(await checkpointOpenRequest("scope-a", {
        known_head: head("scope-a", 0),
        transfer_budget_bytes: 600 * 1024
      }));
      expect(firstFrameResponse.ok).toBe(true);
      const firstFrame = await firstFrameResponse.json() as Record<string, any>;
      expect(firstFrame.transfer).toMatchObject({
        kind: "frames",
        from: { seq: 0 },
        to: { seq: 1 },
        frames: [
          { frame: { position: { seq: 1 } }, projection_writes: [expect.objectContaining({ key: "large_projection_one", row: expect.objectContaining({ id: "large_projection_one" }) })] }
        ],
        continuation: {
          export_id: expect.any(String),
          head: { seq: 2 }
        }
      });

      const finalFrameResponse = await target.fetch(await checkpointOpenRequest("scope-a", {
        transfer_budget_bytes: 600 * 1024,
        continuation: firstFrame.transfer.continuation
      }));
      expect(finalFrameResponse.ok).toBe(true);
      const finalFrame = await finalFrameResponse.json() as Record<string, any>;
      expect(finalFrame.transfer).toMatchObject({
        kind: "frames",
        from: { seq: 1 },
        to: { seq: 2 },
        frames: [
          { frame: { position: { seq: 2 } }, projection_writes: [expect.objectContaining({ key: "large_projection_two", row: expect.objectContaining({ id: "large_projection_two" }) })] }
        ]
      });
      expect(finalFrame.transfer.continuation).toBeUndefined();
    } finally {
      state.close();
    }
  });

  it("rejects a continuation whose public checkpoint hash no longer matches the pinned export", async () => {
    const state = new WaitUntilState("scope-a");
    const target = new CommitScopeDO(state as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: SECRET });
    const base = createWorld().exportObjects(["the_chatroom"])[0]!;
    seedScopeRows(state, "scope-a", head("scope-a", 1), {
      objects: [
        largeProjectionObject(base, "large_projection_one", 530 * 1024),
        largeProjectionObject(base, "large_projection_two", 530 * 1024)
      ]
    });

    try {
      await target.fetch(await checkpointOpenRequest("scope-a", { transfer_budget_bytes: 600 * 1024 }));
      await state.drainWaitUntil();
      const firstPageResponse = await target.fetch(await checkpointOpenRequest("scope-a", { transfer_budget_bytes: 600 * 1024 }));
      const firstPage = await firstPageResponse.json() as Record<string, any>;
      const stale = await target.fetch(await checkpointOpenRequest("scope-a", {
        transfer_budget_bytes: 600 * 1024,
        continuation: {
          ...firstPage.transfer.continuation,
          checkpoint_hash: "not-the-export-hash"
        }
      }));
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ error: { code: "E_CHECKPOINT_CONTINUATION_STALE" } });
    } finally {
      state.close();
    }
  });
});

function largeProjectionObject(base: SerializedObject, id: ObjRef, bytes: number): SerializedObject {
  return {
    ...structuredClone(base),
    id,
    name: id,
    properties: [
      ...base.properties.filter(([name]) => name !== "checkpoint_blob"),
      ["checkpoint_blob", "x".repeat(bytes)]
    ]
  };
}

function seedTailRows(state: FakeDurableObjectState, scope: ObjRef, count: number, now: number): void {
  for (let seq = 1; seq <= count; seq += 1) {
    const frame = accepted(scope, seq);
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO v2_commit_scope_accepted_frame(scope, seq, id, position_hash, body, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      scope,
      seq,
      frame.id,
      frame.position.hash,
      JSON.stringify(frame),
      now
    );
    const transcript = {
      kind: "woo.effect_transcript.shadow.v1",
      id: `tx-${seq}`,
      route: "sequenced",
      scope,
      seq,
      session: null,
      call: { actor: "$wiz", target: scope, verb: "noop", args: [] },
      reads: [],
      writes: [],
      creates: [],
      moves: [],
      observations: [],
      logicalInputs: [],
      untrackedEffects: [],
      complete: true,
      incompleteReasons: [],
      hash: `tx-${seq}`
    };
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO v2_commit_scope_transcript_tail(scope, seq, hash, body, updated_at) VALUES (?, ?, ?, ?, ?)",
      scope,
      seq,
      transcript.hash,
      JSON.stringify(transcript),
      now
    );
  }
}

function seedCheckpointRow(state: FakeDurableObjectState, scope: ObjRef, current: ShadowScopeHead, now: number): void {
  const checkpoint = {
    kind: "woo.scope_checkpoint.v1",
    scope,
    head: current,
    checkpoint_hash: `checkpoint-${current.seq}`,
    pages: [],
    frame_tail: []
  };
  state.storage.sql.exec(
    "INSERT OR REPLACE INTO v2_commit_scope_checkpoint(scope, head_seq, head_hash, head, checkpoint_hash, body, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    scope,
    current.seq,
    current.hash,
    JSON.stringify(current),
    checkpoint.checkpoint_hash,
    JSON.stringify(checkpoint),
    now
  );
}

function tailRowCount(
  state: FakeDurableObjectState,
  table: "v2_commit_scope_accepted_frame" | "v2_commit_scope_transcript_tail"
): number {
  return Number((state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0] as { n: number }).n);
}

function tailSeqs(
  state: FakeDurableObjectState,
  table: "v2_commit_scope_accepted_frame" | "v2_commit_scope_transcript_tail"
): number[] {
  return state.storage.sql.exec(`SELECT seq FROM ${table} ORDER BY seq`).toArray().map((row) => Number((row as { seq: number }).seq));
}

function objectRow(state: FakeDurableObjectState, id: ObjRef): SerializedObject | null {
  const row = state.storage.sql.exec("SELECT body FROM v2_commit_scope_object WHERE id = ? LIMIT 1", id).toArray()[0] as { body?: string } | undefined;
  return row?.body ? JSON.parse(row.body) as SerializedObject : null;
}

function seedScopeRows(
  state: FakeDurableObjectState,
  scope: ObjRef,
  current: ShadowScopeHead,
  input: { objects?: unknown[]; sessions?: SerializedSession[]; frames?: ShadowCommitAccepted[] }
): void {
  const now = Date.now();
  state.storage.sql.exec(
    "INSERT OR REPLACE INTO v2_commit_scope_meta(id, scope, relay_node, head, idempotency_window_ms, version, object_counter, parked_task_counter, session_counter, updated_at) VALUES ('current', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    scope,
    `node:commit-scope:${scope}`,
    JSON.stringify(current),
    60_000,
    1,
    1,
    1,
    1,
    now
  );
  for (const object of input.objects ?? []) {
    const id = typeof object === "object" && object && "id" in object ? String((object as { id: unknown }).id) : crypto.randomUUID();
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO v2_commit_scope_object(id, body, updated_at) VALUES (?, ?, ?)",
      id,
      JSON.stringify(object),
      now
    );
  }
  for (const session of input.sessions ?? []) {
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO v2_commit_scope_session(id, body, updated_at) VALUES (?, ?, ?)",
      session.id,
      JSON.stringify(session),
      now
    );
  }
  for (const frame of input.frames ?? []) {
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO v2_commit_scope_accepted_frame(scope, seq, id, position_hash, body, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      scope,
      frame.position.seq,
      frame.id,
      frame.position.hash,
      JSON.stringify(frame),
      now
    );
  }
}

async function checkpointOpenRequest(scope: ObjRef, extra: Record<string, unknown> = {}): Promise<Request> {
  return await signInternalRequest({ WOO_INTERNAL_SECRET: SECRET }, new Request("https://woo.internal/v2/open", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scope,
      node: "browser:checkpoint-tail-test",
      token: "shadow-session:session-checkpoint-tail-test:guest_checkpoint_tail_test",
      session: "session-checkpoint-tail-test",
      actor: "guest_checkpoint_tail_test",
      sessions: [{
        id: "session-checkpoint-tail-test",
        actor: "guest_checkpoint_tail_test",
        started: 1,
        expiresAt: Date.now() + 60_000,
        activeScope: scope
      }],
      open_protocol: "checkpoint_tail.v1",
      ...extra
    })
  }));
}

function checkpointRows(state: FakeDurableObjectState): number {
  return Number((state.storage.sql.exec("SELECT COUNT(*) AS n FROM v2_commit_scope_checkpoint").toArray()[0] as { n: number }).n);
}

function checkpointPageRows(state: FakeDurableObjectState): number {
  return Number((state.storage.sql.exec("SELECT COUNT(*) AS n FROM v2_commit_scope_checkpoint_page").toArray()[0] as { n: number }).n);
}

function checkpointFrameRows(state: FakeDurableObjectState): number {
  return Number((state.storage.sql.exec("SELECT COUNT(*) AS n FROM v2_commit_scope_checkpoint_frame").toArray()[0] as { n: number }).n);
}

function checkpointManifestBody(state: FakeDurableObjectState): string | null {
  const row = state.storage.sql.exec("SELECT body FROM v2_commit_scope_checkpoint LIMIT 1").toArray()[0] as { body?: string } | undefined;
  return row?.body ?? null;
}

function rowCount(state: FakeDurableObjectState, table: "v2_commit_scope_snapshot" | "v2_commit_scope_task" | "v2_commit_scope_tombstone"): number {
  return Number((state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0] as { n: number }).n);
}
