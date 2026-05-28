import { describe, expect, it } from "vitest";
import {
  installV2BrowserAcceptedFrameProjection,
  installV2BrowserCheckpointTailProjection,
  v2BrowserProjectionRowId,
  type V2BrowserCheckpointTailOpenTransfer,
  type V2BrowserHolderInstallStore,
  type V2BrowserProjectionRowRecord,
  type V2BrowserProjectionRowRecordInput
} from "../src/client/v2-browser-holder-install";
import type { AcceptedFrameTransfer, BrowserObjectRow, BrowserProfile, ProjectionWrite } from "../src/core/projection-delta";
import type { ShadowCommitAccepted, ShadowScopeHead } from "../src/core/shadow-commit-scope";
import type { ObjRef } from "../src/core/types";

describe("v2 browser holder projection install", () => {
  it("advances the accepted-frame head last so a failed head write retries from the prior head", async () => {
    const store = new FakeHolderStore();
    const frame = accepted("room", 1);
    const write = browserObjectWrite(browserObject("room", "Room after accept", frame.position, { contents: [] }));
    store.failNextPutMeta("head:room");

    await expect(installV2BrowserAcceptedFrameProjection({
      store,
      frame,
      writes: [write],
      viewer: { actor: "actor" }
    })).rejects.toThrow("injected putMeta failure");

    expect(store.head("room")).toBeUndefined();
    expect(store.row("room", "objects", "room")?.row).toMatchObject({ id: "room" });

    const result = await installV2BrowserAcceptedFrameProjection({
      store,
      frame,
      writes: [write],
      viewer: { actor: "actor" }
    });

    expect(store.head("room")).toEqual(frame.position);
    expect((result.projection as { title: string }).title).toBe("Room after accept");
    expect(store.ops.indexOf("putRow:objects:room")).toBeLessThan(store.ops.indexOf("putMeta:head:room"));
  });

  it("treats duplicate and stale accepted frames as idempotent no-ops", async () => {
    const store = new FakeHolderStore();
    const frame = accepted("room", 2);
    await installV2BrowserAcceptedFrameProjection({
      store,
      frame,
      writes: [browserObjectWrite(browserObject("room", "Current Room", frame.position))],
      viewer: { actor: "actor" }
    });

    store.ops.length = 0;
    const duplicate = await installV2BrowserAcceptedFrameProjection({
      store,
      frame,
      writes: [browserObjectWrite(browserObject("room", "Duplicate Should Not Rewrite", frame.position))],
      viewer: { actor: "actor" }
    });

    expect((duplicate.projection as { title: string }).title).toBe("Current Room");
    expect(store.row("room", "objects", "room")?.row).toMatchObject({ display: { name: "Current Room" } });
    expect(store.ops).not.toContain("putRow:objects:room");
    expect(store.ops).not.toContain("putMeta:head:room");

    const staleFrame = accepted("room", 1);
    const stale = await installV2BrowserAcceptedFrameProjection({
      store,
      frame: staleFrame,
      writes: [browserObjectWrite(browserObject("room", "Stale Should Not Regress", staleFrame.position))],
      viewer: { actor: "actor" }
    });

    expect(stale.head).toEqual(frame.position);
    expect((stale.projection as { title: string }).title).toBe("Current Room");
    expect(store.row("room", "objects", "room")?.row).toMatchObject({ display: { name: "Current Room" } });
  });

  it("treats stale checkpoint/tail transfers as idempotent no-ops", async () => {
    const store = new FakeHolderStore();
    const currentFrame = accepted("room", 4);
    await installV2BrowserAcceptedFrameProjection({
      store,
      frame: currentFrame,
      writes: [browserObjectWrite(browserObject("room", "Current Room", currentFrame.position))],
      viewer: { actor: "actor" }
    });

    store.ops.length = 0;
    const staleFrame = accepted("room", 3);
    const staleTail = await installV2BrowserCheckpointTailProjection({
      store,
      transfer: framesTransfer("room", head("room", 2), staleFrame.position, [{
        frame: staleFrame,
        projection_writes: [browserObjectWrite(browserObject("room", "Stale Tail Should Not Regress", staleFrame.position))]
      }])
    });

    expect(staleTail?.head).toEqual(currentFrame.position);
    expect((staleTail?.projection as { title: string }).title).toBe("Current Room");
    expect(store.row("room", "objects", "room")?.row).toMatchObject({ display: { name: "Current Room" } });
    expect(store.ops).not.toContain("putRow:objects:room");
    expect(store.ops).not.toContain("putMeta:head:room");

    store.ops.length = 0;
    store.clearCalls.length = 0;
    const staleCheckpoint = await installV2BrowserCheckpointTailProjection({
      store,
      transfer: checkpointTransfer("room", head("room", 1), "stale-checkpoint", "000001")
    });

    expect(staleCheckpoint?.head).toEqual(currentFrame.position);
    expect((staleCheckpoint?.projection as { title: string }).title).toBe("Current Room");
    expect(store.clearCalls).toEqual([]);
    expect(store.ops).not.toContain("clear:room");
    expect(store.ops).not.toContain("putMeta:head:room");
  });

  it("clears checkpoint rows at a new export boundary or checkpoint hash", async () => {
    const store = new FakeHolderStore();
    const frame = accepted("room", 3);

    await installV2BrowserCheckpointTailProjection({
      store,
      transfer: checkpointTransfer("room", frame.position, "checkpoint-a", "000002")
    });
    expect(store.clearCalls).toEqual(["room"]);

    store.clearCalls.length = 0;
    await installV2BrowserCheckpointTailProjection({
      store,
      transfer: checkpointTransfer("room", frame.position, "checkpoint-a", "000002")
    });
    expect(store.clearCalls).toEqual([]);

    await installV2BrowserCheckpointTailProjection({
      store,
      transfer: checkpointTransfer("room", frame.position, "checkpoint-b", "000002")
    });
    expect(store.clearCalls).toEqual(["room"]);

    store.clearCalls.length = 0;
    await installV2BrowserCheckpointTailProjection({
      store,
      transfer: checkpointTransfer("room", frame.position, "checkpoint-b", "000001")
    });
    expect(store.clearCalls).toEqual(["room"]);
  });

  it("derives browser-profile projections from browser rows", async () => {
    const browserStore = new FakeHolderStore();
    const browserFrame = accepted("room", 4);
    const browserProjection = await installV2BrowserAcceptedFrameProjection({
      store: browserStore,
      frame: browserFrame,
      writes: [
        browserObjectWrite(browserObject("room", "Browser Room", browserFrame.position, { contents: ["actor"] })),
        browserObjectWrite(browserObject("actor", "Browser Actor", browserFrame.position, { location: "room" }))
      ],
      viewer: { actor: "actor" }
    });

    expect((browserProjection.projection as { title: string }).title).toBe("Browser Room");
    expect((browserProjection.projection as { object_count: number }).object_count).toBe(2);
    expect((browserProjection.projection as { self: { name: string } | null }).self?.name).toBe("Browser Actor");
    expect(browserStore.ops).toContain("countRows:objects");
    expect(browserStore.ops).not.toContain("rows:room");
  });

  it("rejects authority-shaped checkpoint rows", async () => {
    const store = new FakeHolderStore();
    const checkpointHead = head("room", 6);
    const authorityShaped = {
      id: "room",
      name: "Authority Room",
      parent: null,
      owner: "actor",
      location: null,
      properties: [],
      contents: []
    };

    await expect(installV2BrowserCheckpointTailProjection({
      store,
      transfer: {
        kind: "woo.open.checkpoint_tail.v1",
        scope: "room",
        head: checkpointHead,
        viewer: { actor: "actor" },
        transfer: {
          kind: "checkpoint",
          checkpoint: {
            kind: "woo.scope_checkpoint.v1",
            scope: "room",
            head: checkpointHead,
            checkpoint_hash: "authority-shaped",
            pages: [{
              kind: "woo.projection_page.v1",
              table: "objects",
              page: "000001",
              hash: "authority-shaped-objects",
              rows: [authorityShaped]
            }],
            frame_tail: []
          }
        }
      } as unknown as V2BrowserCheckpointTailOpenTransfer
    })).rejects.toThrow("BrowserObjectRow");
  });
});

class FakeHolderStore implements V2BrowserHolderInstallStore {
  readonly meta = new Map<string, unknown>();
  readonly rows = new Map<string, V2BrowserProjectionRowRecord>();
  readonly ops: string[] = [];
  readonly clearCalls: string[] = [];
  private failMetaKey: string | null = null;

  failNextPutMeta(key: string): void {
    this.failMetaKey = key;
  }

  head(scope: string): ShadowScopeHead | undefined {
    return clone(this.meta.get(`head:${scope}`)) as ShadowScopeHead | undefined;
  }

  row(scope: string, table: V2BrowserProjectionRowRecord["table"], key: string): V2BrowserProjectionRowRecord | undefined {
    return clone(this.rows.get(v2BrowserProjectionRowId(scope, table, key))) as V2BrowserProjectionRowRecord | undefined;
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    this.ops.push(`getMeta:${key}`);
    return clone(this.meta.get(key)) as T | undefined;
  }

  async putMeta(key: string, value: unknown): Promise<void> {
    this.ops.push(`putMeta:${key}`);
    if (this.failMetaKey === key) {
      this.failMetaKey = null;
      throw new Error("injected putMeta failure");
    }
    this.meta.set(key, clone(value));
  }

  async projectionRowsForScope(scope: string): Promise<V2BrowserProjectionRowRecord[]> {
    this.ops.push(`rows:${scope}`);
    return Array.from(this.rows.values())
      .filter((row) => row.scope === scope)
      .map((row) => clone(row));
  }

  async getProjectionRow(scope: string, table: V2BrowserProjectionRowRecord["table"], key: string): Promise<V2BrowserProjectionRowRecord | undefined> {
    this.ops.push(`getRow:${table}:${key}`);
    return clone(this.rows.get(v2BrowserProjectionRowId(scope, table, key)));
  }

  async projectionRowCountForScopeTable(scope: string, table: V2BrowserProjectionRowRecord["table"]): Promise<number> {
    this.ops.push(`countRows:${table}`);
    return Array.from(this.rows.values()).filter((row) => row.scope === scope && row.table === table).length;
  }

  async putProjectionRow(row: V2BrowserProjectionRowRecordInput): Promise<void> {
    this.ops.push(`putRow:${row.table}:${row.key}`);
    const id = v2BrowserProjectionRowId(row.scope, row.table, row.key);
    this.rows.set(id, clone({ ...row, id } as V2BrowserProjectionRowRecord));
  }

  async deleteProjectionRow(scope: string, table: V2BrowserProjectionRowRecord["table"], key: string): Promise<void> {
    this.ops.push(`deleteRow:${table}:${key}`);
    this.rows.delete(v2BrowserProjectionRowId(scope, table, key));
  }

  async clearProjectionRows(scope: string): Promise<void> {
    this.ops.push(`clear:${scope}`);
    this.clearCalls.push(scope);
    for (const [id, row] of this.rows) {
      if (row.scope === scope) this.rows.delete(id);
    }
  }
}

function accepted(scope: ObjRef, seq: number): ShadowCommitAccepted {
  return {
    kind: "woo.commit.accepted.shadow.v1",
    id: `turn-${seq}`,
    position: head(scope, seq),
    transcript_hash: `tx-${seq}`,
    post_state_hash: `post-${seq}`,
    observations: [],
    receipt: {
      kind: "woo.commit_receipt.shadow.v1",
      id: `turn-${seq}`,
      route: "sequenced",
      scope,
      seq,
      transcript_hash: `tx-${seq}`,
      pre_state_hash: `pre-${seq - 1}`,
      post_state_hash: `post-${seq}`,
      accepted: true,
      errors: []
    }
  };
}

function head(scope: ObjRef, seq: number): ShadowScopeHead {
  return { kind: "woo.scope_head.shadow.v1", scope, epoch: 1, seq, hash: `h${seq}` };
}

function browserObject(
  id: ObjRef,
  name: string,
  rowHead: ShadowScopeHead,
  options: { location?: ObjRef | null; contents?: ObjRef[] } = {}
): BrowserObjectRow {
  return {
    kind: "woo.browser_object_row.v1",
    id,
    scope: rowHead.scope,
    head: rowHead,
    display: { id, name, location: options.location ?? null },
    location: options.location ?? null,
    contents: options.contents ?? []
  };
}

function browserObjectWrite(row: BrowserObjectRow): ProjectionWrite<BrowserProfile> {
  return { table: "objects", key: row.id, op: "upsert", row, bytes: 1 };
}

function checkpointTransfer(
  scope: ObjRef,
  checkpointHead: ShadowScopeHead,
  checkpointHash: string,
  page: string
): V2BrowserCheckpointTailOpenTransfer {
  return {
    kind: "woo.open.checkpoint_tail.v1",
    scope,
    head: checkpointHead,
    viewer: { actor: "actor" },
    transfer: {
      kind: "checkpoint",
      checkpoint: {
        kind: "woo.scope_checkpoint.v1",
        scope,
        head: checkpointHead,
        checkpoint_hash: checkpointHash,
        pages: [{
          kind: "woo.projection_page.v1",
          table: "objects",
          page,
          hash: `${checkpointHash}:${page}`,
          rows: [browserObject(scope, `Checkpoint ${checkpointHash}`, checkpointHead)]
        }],
        frame_tail: []
      }
    }
  };
}

function framesTransfer(
  scope: ObjRef,
  from: ShadowScopeHead,
  to: ShadowScopeHead,
  frames: Array<AcceptedFrameTransfer<BrowserProfile>>
): V2BrowserCheckpointTailOpenTransfer {
  return {
    kind: "woo.open.checkpoint_tail.v1",
    scope,
    head: to,
    viewer: { actor: "actor" },
    transfer: {
      kind: "frames",
      from,
      to,
      frames
    }
  };
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
