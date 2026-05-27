import { describe, expect, it } from "vitest";
import { authoritySliceObjectIds } from "../../src/core/authority-slice";
import { createWorld } from "../../src/core/bootstrap";
import type { EffectTranscript } from "../../src/core/effect-transcript";
import type { ProjectionDeltaSummary, ProjectionWrite, SessionToolManifest } from "../../src/core/projection-delta";
import type { SerializedAuthoritySlice } from "../../src/core/repository";
import { encodeEnvelope } from "../../src/core/shadow-envelope";
import { wooError, type MetricEvent, type ObjRef, type RemoteToolDescriptor, type RemoteToolRequest } from "../../src/core/types";
import type { ShadowCommitAccepted, ShadowScopeHead } from "../../src/core/shadow-commit-scope";
import { PersistentObjectDO, type Env } from "../../src/worker/persistent-object-do";
import { FakeDurableObjectNamespace, FakeDurableObjectState } from "./fake-do";

function env(overrides: Partial<Env> = {}): Env {
  return {
    WOO_INITIAL_WIZARD_TOKEN: "test-wizard",
    WOO_INTERNAL_SECRET: "test-secret",
    WOO_GATEWAY_PROJECTION_CACHE: "1",
    WOO_TOOL_SURFACE_PROJECTION_ROWS: "1",
    WOO_V2_SAME_HOST_STALE_FALLBACK: "1",
    WOO: new FakeDurableObjectNamespace(() => ({ fetch: () => new Response(null, { status: 404 }) })) as unknown as DurableObjectNamespace,
    DIRECTORY: new FakeDurableObjectNamespace(() => ({ fetch: () => new Response(null, { status: 404 }) })) as unknown as DurableObjectNamespace,
    ...overrides
  };
}

function rows<T>(state: FakeDurableObjectState, query: string, ...params: unknown[]): T[] {
  return state.storage.sql.exec(query, ...params).toArray() as T[];
}

describe("gateway projection cache", () => {
  it("persists accepted object projection rows and evicts them on delete", () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    const objectRow = createWorld().exportObjects(["the_chatroom"])[0]!;
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env()) as unknown as {
      applyGatewayProjectionWrites: (head: ShadowScopeHead, writes: ProjectionWrite[], source: "fanout", delta?: ProjectionDeltaSummary) => { rows: number; bytes: number };
    };
    const head: ShadowScopeHead = {
      kind: "woo.scope_head.shadow.v1",
      scope: "the_chatroom",
      epoch: 1,
      seq: 3,
      hash: "h3"
    };

    const written = po.applyGatewayProjectionWrites(head, [{
      table: "objects",
      key: "the_chatroom",
      op: "upsert",
      row: objectRow,
      bytes: 123
    }], "fanout");

    expect(written).toMatchObject({ rows: 2, bytes: 123 });
    expect(rows<{ head_seq: number; head_hash: string }>(state, "SELECT head_seq, head_hash FROM gateway_projection_scope WHERE scope = ?", "the_chatroom")).toEqual([
      { head_seq: 3, head_hash: "h3" }
    ]);
    expect(rows<{ id: string; authority_scope: string }>(state, "SELECT id, authority_scope FROM gateway_projection_object")).toEqual([
      { id: "the_chatroom", authority_scope: "the_chatroom" }
    ]);

    po.applyGatewayProjectionWrites({ ...head, seq: 4, hash: "h4" }, [{
      table: "objects",
      key: "the_chatroom",
      op: "delete",
      bytes: 0
    }], "fanout");

    expect(rows(state, "SELECT id FROM gateway_projection_object")).toEqual([]);
  });

  it("rejects projection deltas whose materialized row writes are incomplete", () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env()) as unknown as {
      applyGatewayProjectionWrites: (head: ShadowScopeHead, writes: ProjectionWrite[], source: "fanout", delta?: ProjectionDeltaSummary) => { rows: number; bytes: number };
    };
    const head: ShadowScopeHead = {
      kind: "woo.scope_head.shadow.v1",
      scope: "the_chatroom",
      epoch: 1,
      seq: 3,
      hash: "h3"
    };

    expect(() => po.applyGatewayProjectionWrites(head, [], "fanout", {
      objects: [{ key: "the_chatroom", op: "upsert", bytes: 123 }],
      projection_bytes: 123
    })).toThrow(/projection_delta/);
    expect(rows(state, "SELECT scope FROM gateway_projection_scope")).toEqual([]);
  });

  it("does not replay host transcripts for empty projection deltas", async () => {
    const state = new FakeDurableObjectState("world");
    const world = createWorld();
    world.setProp("the_chatroom", "empty_projection_probe", "before");
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env()) as unknown as {
      writeThroughV2CommitToObjectHosts: (world: ReturnType<typeof createWorld>, scope: ObjRef, commit: ShadowCommitAccepted, transcript: EffectTranscript) => Promise<unknown>;
    };
    const transcript: EffectTranscript = {
      kind: "woo.effect_transcript.shadow.v1",
      id: "empty-projection-delta-transcript",
      route: "sequenced",
      scope: "the_chatroom",
      seq: 4,
      session: null,
      call: { actor: "$wiz", target: "the_chatroom", verb: "empty_projection_probe", args: [] },
      reads: [],
      writes: [{
        cell: { kind: "prop", object: "the_chatroom", name: "empty_projection_probe" },
        value: "fallback-applied",
        op: "set"
      }],
      creates: [],
      moves: [],
      observations: [],
      logicalInputs: [],
      untrackedEffects: [],
      complete: true,
      incompleteReasons: [],
      hash: "empty-projection-delta-transcript"
    };
    const commit: ShadowCommitAccepted = {
      kind: "woo.commit.accepted.shadow.v1",
      id: "empty-projection-delta-transcript",
      position: {
        kind: "woo.scope_head.shadow.v1",
        scope: "the_chatroom",
        epoch: 1,
        seq: 4,
        hash: "h4"
      },
      transcript_hash: transcript.hash,
      post_state_hash: "post",
      observations: [],
      receipt: {
        kind: "woo.commit_receipt.shadow.v1",
        id: transcript.id,
        route: transcript.route,
        scope: transcript.scope,
        seq: transcript.seq,
        transcript_hash: transcript.hash,
        pre_state_hash: "pre",
        post_state_hash: "post",
        accepted: true,
        errors: []
      },
      projection_delta: { projection_bytes: 0 },
      projection_writes: []
    };

    const materialized = await po.writeThroughV2CommitToObjectHosts(world, "the_chatroom", commit, transcript);

    expect(materialized).toBeNull();
    expect(world.getProp("the_chatroom", "empty_projection_probe")).toBe("before");
  });

  it("serves cached tool-surface descriptors without waking the owner", () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env()) as unknown as {
      storeGatewayToolSurfacesFromDescriptors: (scope: ObjRef, authorityScope: ObjRef, descriptors: RemoteToolDescriptor[]) => void;
      readGatewayToolSurfaceDescriptors: (requests: RemoteToolRequest[]) => RemoteToolDescriptor[];
    };
    const descriptor: RemoteToolDescriptor = {
      object: "remote_widget",
      verb: "ping",
      aliases: ["poke"],
      arg_spec: { args: ["message"], types: { message: "str" } },
      direct: true,
      source: "/* cached */",
      enclosingSpace: "remote_room"
    };

    po.storeGatewayToolSurfacesFromDescriptors("remote_room", "remote_room", [descriptor]);
    expect(po.readGatewayToolSurfaceDescriptors([{ id: "remote_room", projection: "tools", expandContents: true }])).toEqual([{
      ...descriptor,
      source_rows: [{ table: "objects", authority_scope: "remote_room", key: "remote_widget" }]
    }]);
  });

  it("does not expose tool-surface rows while their rollback flag is off", () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env({ WOO_TOOL_SURFACE_PROJECTION_ROWS: "0" })) as unknown as {
      storeGatewayToolSurfacesFromDescriptors: (scope: ObjRef, authorityScope: ObjRef, descriptors: RemoteToolDescriptor[]) => void;
      readGatewayToolSurfaceDescriptors: (requests: RemoteToolRequest[]) => RemoteToolDescriptor[];
    };
    const descriptor: RemoteToolDescriptor = {
      object: "remote_widget",
      verb: "ping",
      aliases: [],
      arg_spec: { args: [] },
      direct: true,
      source: "/* remote ping */",
      enclosingSpace: "remote_room"
    };

    po.storeGatewayToolSurfacesFromDescriptors("remote_room", "remote_room", [descriptor]);

    expect(po.readGatewayToolSurfaceDescriptors([{ id: "remote_room", projection: "tools", expandContents: true }])).toEqual([]);
    expect(rows(state, "SELECT scope, object FROM gateway_tool_surface")).toEqual([]);
  });

  it("keeps batched remote descriptor cache writes scoped to their request", () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env()) as unknown as {
      storeGatewayToolSurfacesForRequests: (requests: RemoteToolRequest[], descriptors: RemoteToolDescriptor[]) => void;
      readGatewayToolSurfaceDescriptors: (requests: RemoteToolRequest[]) => RemoteToolDescriptor[];
    };
    const roomADescriptor: RemoteToolDescriptor = {
      object: "remote_widget_a",
      verb: "ping",
      aliases: [],
      arg_spec: { args: [] },
      direct: true,
      source: "/* a */",
      enclosingSpace: "remote_room_a"
    };
    const roomBDescriptor: RemoteToolDescriptor = {
      object: "remote_widget_b",
      verb: "pong",
      aliases: [],
      arg_spec: { args: [] },
      direct: true,
      source: "/* b */",
      enclosingSpace: "remote_room_b"
    };

    po.storeGatewayToolSurfacesForRequests([
      { id: "remote_room_a", projection: "tools", expandContents: true },
      { id: "remote_room_b", projection: "tools", expandContents: true }
    ], [roomADescriptor, roomBDescriptor]);

    expect(po.readGatewayToolSurfaceDescriptors([{ id: "remote_room_a", projection: "tools", expandContents: true }])).toEqual([{
      ...roomADescriptor,
      source_rows: [{ table: "objects", authority_scope: "remote_room_a", key: "remote_widget_a" }]
    }]);
    expect(po.readGatewayToolSurfaceDescriptors([{ id: "remote_room_b", projection: "tools", expandContents: true }])).toEqual([{
      ...roomBDescriptor,
      source_rows: [{ table: "objects", authority_scope: "remote_room_b", key: "remote_widget_b" }]
    }]);
  });

  it("caps tool-surface reverse-index rows and withholds saturated cache rows", () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    const po = new PersistentObjectDO(
      state as unknown as DurableObjectState,
      env({ WOO_TOOL_SURFACE_SOURCE_INDEX_MAX_ROWS: "1" })
    ) as unknown as {
      storeGatewayToolSurfacesFromDescriptors: (scope: ObjRef, authorityScope: ObjRef, descriptors: RemoteToolDescriptor[]) => void;
      readGatewayToolSurfaceDescriptors: (requests: RemoteToolRequest[]) => RemoteToolDescriptor[];
    };
    const descriptor: RemoteToolDescriptor = {
      object: "remote_widget",
      verb: "ping",
      aliases: [],
      arg_spec: { args: [] },
      direct: true,
      source: "/* inherited */",
      enclosingSpace: "remote_room",
      source_rows: [
        { table: "objects", authority_scope: "remote_room", key: "remote_widget" },
        { table: "objects", authority_scope: "remote_room", key: "remote_parent" }
      ]
    };

    po.storeGatewayToolSurfacesFromDescriptors("remote_room", "remote_room", [descriptor]);

    expect(rows<{ stale: number; stale_reason: string }>(state, "SELECT stale, stale_reason FROM gateway_tool_surface")).toEqual([
      { stale: 1, stale_reason: "disabled" }
    ]);
    expect(rows<{ scope: string; saturated: number; saturated_reason: string }>(state, "SELECT scope, saturated, saturated_reason FROM gateway_tool_surface_scope")).toEqual([
      { scope: "remote_room", saturated: 1, saturated_reason: "scope" }
    ]);
    expect(rows(state, "SELECT * FROM gateway_tool_surface_source")).toEqual([]);
    expect(po.readGatewayToolSurfaceDescriptors([{ id: "remote_room", projection: "tools", expandContents: true }])).toEqual([]);

    po.storeGatewayToolSurfacesFromDescriptors("remote_room", "remote_room", [{
      object: "remote_button",
      verb: "press",
      aliases: [],
      arg_spec: { args: [] },
      direct: true,
      source: "/* inherited */",
      enclosingSpace: "remote_room",
      source_rows: [{ table: "objects", authority_scope: "remote_room", key: "remote_button" }]
    }]);

    expect(rows(state, "SELECT * FROM gateway_tool_surface_source")).toEqual([]);
    expect(po.readGatewayToolSurfaceDescriptors([{ id: "remote_room", projection: "tools", expandContents: true }])).toEqual([]);
  });

  it("recovers a saturated tool-surface scope after the disabled surface fits under the cap", () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    const po = new PersistentObjectDO(
      state as unknown as DurableObjectState,
      env({ WOO_TOOL_SURFACE_SOURCE_INDEX_MAX_ROWS: "1" })
    ) as unknown as {
      storeGatewayToolSurfacesFromDescriptors: (scope: ObjRef, authorityScope: ObjRef, descriptors: RemoteToolDescriptor[]) => void;
      readGatewayToolSurfaceDescriptors: (requests: RemoteToolRequest[]) => RemoteToolDescriptor[];
    };
    const oversized: RemoteToolDescriptor = {
      object: "remote_widget",
      verb: "ping",
      aliases: [],
      arg_spec: { args: [] },
      direct: true,
      source: "/* inherited */",
      enclosingSpace: "remote_room",
      source_rows: [
        { table: "objects", authority_scope: "remote_room", key: "remote_widget" },
        { table: "objects", authority_scope: "remote_room", key: "remote_parent" }
      ]
    };
    const resized: RemoteToolDescriptor = {
      ...oversized,
      source_rows: [{ table: "objects", authority_scope: "remote_room", key: "remote_widget" }]
    };

    po.storeGatewayToolSurfacesFromDescriptors("remote_room", "remote_room", [oversized]);
    expect(po.readGatewayToolSurfaceDescriptors([{ id: "remote_room", projection: "tools", expandContents: true }])).toEqual([]);

    po.storeGatewayToolSurfacesFromDescriptors("remote_room", "remote_room", [resized]);

    expect(rows<{ saturated: number; saturated_reason: string | null }>(state, "SELECT saturated, saturated_reason FROM gateway_tool_surface_scope")).toEqual([
      { saturated: 0, saturated_reason: null }
    ]);
    expect(rows<{ scope: string; object: string; source_key: string }>(
      state,
      "SELECT scope, object, source_key FROM gateway_tool_surface_source"
    )).toEqual([{ scope: "remote_room", object: "remote_widget", source_key: "remote_widget" }]);
    expect(po.readGatewayToolSurfaceDescriptors([{ id: "remote_room", projection: "tools", expandContents: true }])).toEqual([resized]);
  });

  it("caps tool-surface reverse-index rows across the gateway shard", () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    const po = new PersistentObjectDO(
      state as unknown as DurableObjectState,
      env({
        WOO_TOOL_SURFACE_SOURCE_INDEX_MAX_ROWS: "10",
        WOO_TOOL_SURFACE_SOURCE_INDEX_MAX_SHARD_ROWS: "1"
      })
    ) as unknown as {
      storeGatewayToolSurfacesFromDescriptors: (scope: ObjRef, authorityScope: ObjRef, descriptors: RemoteToolDescriptor[]) => void;
      readGatewayToolSurfaceDescriptors: (requests: RemoteToolRequest[]) => RemoteToolDescriptor[];
    };
    const roomA: RemoteToolDescriptor = {
      object: "remote_widget_a",
      verb: "ping",
      aliases: [],
      arg_spec: { args: [] },
      direct: true,
      source: "/* room a */",
      enclosingSpace: "room_a",
      source_rows: [{ table: "objects", authority_scope: "room_a", key: "remote_widget_a" }]
    };
    const roomB: RemoteToolDescriptor = {
      object: "remote_widget_b",
      verb: "ping",
      aliases: [],
      arg_spec: { args: [] },
      direct: true,
      source: "/* room b */",
      enclosingSpace: "room_b",
      source_rows: [{ table: "objects", authority_scope: "room_b", key: "remote_widget_b" }]
    };

    po.storeGatewayToolSurfacesFromDescriptors("room_a", "room_a", [roomA]);
    po.storeGatewayToolSurfacesFromDescriptors("room_b", "room_b", [roomB]);

    expect(rows<{ scope: string; object: string; source_key: string }>(
      state,
      "SELECT scope, object, source_key FROM gateway_tool_surface_source ORDER BY scope"
    )).toEqual([{ scope: "room_a", object: "remote_widget_a", source_key: "remote_widget_a" }]);
    expect(rows<{ scope: string; saturated: number; saturated_reason: string }>(state, "SELECT scope, saturated, saturated_reason FROM gateway_tool_surface_scope")).toEqual([
      { scope: "room_b", saturated: 1, saturated_reason: "shard" }
    ]);
    expect(po.readGatewayToolSurfaceDescriptors([{ id: "room_a", projection: "tools", expandContents: true }])).toEqual([roomA]);
    expect(po.readGatewayToolSurfaceDescriptors([{ id: "room_b", projection: "tools", expandContents: true }])).toEqual([]);
  });

  it("keeps the saved session manifest available when a tool-surface scope saturates", () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    const po = new PersistentObjectDO(
      state as unknown as DurableObjectState,
      env({ WOO_TOOL_SURFACE_SOURCE_INDEX_MAX_ROWS: "1" })
    ) as unknown as {
      storeGatewayToolSurfacesFromDescriptors: (scope: ObjRef, authorityScope: ObjRef, descriptors: RemoteToolDescriptor[]) => void;
      readGatewayToolSurfaceDescriptors: (requests: RemoteToolRequest[]) => RemoteToolDescriptor[];
      saveGatewaySessionToolManifest: (manifest: SessionToolManifest) => void;
      loadGatewaySessionToolManifest: (sessionId: string) => SessionToolManifest | null;
    };
    const descriptor: RemoteToolDescriptor = {
      object: "remote_widget",
      verb: "ping",
      aliases: [],
      arg_spec: { args: [] },
      direct: true,
      source: "/* manifest */",
      enclosingSpace: "remote_room",
      source_rows: [
        { table: "objects", authority_scope: "remote_room", key: "remote_widget" },
        { table: "objects", authority_scope: "remote_room", key: "remote_parent" }
      ]
    };
    const head: ShadowScopeHead = {
      kind: "woo.scope_head.shadow.v1",
      scope: "remote_room",
      epoch: 1,
      seq: 7,
      hash: "h7"
    };
    const manifest: SessionToolManifest = {
      kind: "woo.session_tool_manifest.v1",
      session_id: "session-1",
      actor: "actor-1",
      active_scope: "remote_room",
      tools: [descriptor],
      source_surfaces: [{ scope: "remote_room", object: "remote_widget", head }],
      last_apply_seq: 7,
      last_apply_hash: "h7",
      updated_at_ms: Date.now(),
      expires_at_ms: Date.now() + 60_000
    };

    po.saveGatewaySessionToolManifest(manifest);
    po.storeGatewayToolSurfacesFromDescriptors("remote_room", "remote_room", [descriptor]);

    expect(po.readGatewayToolSurfaceDescriptors([{ id: "remote_room", projection: "tools", expandContents: true }])).toEqual([]);
    expect(po.loadGatewaySessionToolManifest("session-1")?.tools).toEqual([descriptor]);
  });

  it("invalidates cached tool surfaces from descriptor source rows", () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    const objectRow = createWorld().exportObjects(["the_chatroom"])[0]!;
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env()) as unknown as {
      storeGatewayToolSurfacesFromDescriptors: (scope: ObjRef, authorityScope: ObjRef, descriptors: RemoteToolDescriptor[]) => void;
      readGatewayToolSurfaceDescriptors: (requests: RemoteToolRequest[]) => RemoteToolDescriptor[];
      applyGatewayProjectionWrites: (head: ShadowScopeHead, writes: ProjectionWrite[], source: "fanout", delta?: ProjectionDeltaSummary) => { rows: number; bytes: number };
    };
    const descriptor: RemoteToolDescriptor = {
      object: "remote_widget",
      verb: "ping",
      aliases: [],
      arg_spec: { args: [] },
      direct: true,
      source: "/* inherited ping */",
      enclosingSpace: "remote_room",
      source_rows: [{ table: "objects", authority_scope: "remote_room", key: "remote_parent" }]
    };
    const head: ShadowScopeHead = {
      kind: "woo.scope_head.shadow.v1",
      scope: "remote_room",
      epoch: 1,
      seq: 4,
      hash: "h4"
    };

    po.storeGatewayToolSurfacesFromDescriptors("remote_room", "remote_room", [descriptor]);
    expect(po.readGatewayToolSurfaceDescriptors([{ id: "remote_room", projection: "tools", expandContents: true }])).toHaveLength(1);

    po.applyGatewayProjectionWrites(head, [{
      table: "objects",
      key: "remote_parent",
      op: "upsert",
      row: { ...objectRow, id: "remote_parent", name: "Remote Parent" },
      bytes: 321
    }], "fanout");

    expect(po.readGatewayToolSurfaceDescriptors([{ id: "remote_room", projection: "tools", expandContents: true }])).toEqual([]);
  });

  it("invalidates a cached tool surface from its default object source row", () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    const objectRow = createWorld().exportObjects(["the_chatroom"])[0]!;
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env()) as unknown as {
      storeGatewayToolSurfacesFromDescriptors: (scope: ObjRef, authorityScope: ObjRef, descriptors: RemoteToolDescriptor[]) => void;
      readGatewayToolSurfaceDescriptors: (requests: RemoteToolRequest[]) => RemoteToolDescriptor[];
      applyGatewayProjectionWrites: (head: ShadowScopeHead, writes: ProjectionWrite[], source: "fanout", delta?: ProjectionDeltaSummary) => { rows: number; bytes: number };
    };
    const descriptor: RemoteToolDescriptor = {
      object: "remote_widget",
      verb: "ping",
      aliases: [],
      arg_spec: { args: [] },
      direct: true,
      source: "/* own ping */",
      enclosingSpace: "remote_room"
    };
    const head: ShadowScopeHead = {
      kind: "woo.scope_head.shadow.v1",
      scope: "remote_room",
      epoch: 1,
      seq: 4,
      hash: "h4"
    };

    po.storeGatewayToolSurfacesFromDescriptors("remote_room", "remote_room", [descriptor]);
    expect(po.readGatewayToolSurfaceDescriptors([{ id: "remote_room", projection: "tools", expandContents: true }])).toHaveLength(1);

    po.applyGatewayProjectionWrites(head, [{
      table: "objects",
      key: "remote_widget",
      op: "upsert",
      row: { ...objectRow, id: "remote_widget", name: "Remote Widget Edited" },
      bytes: 321
    }], "fanout");

    expect(po.readGatewayToolSurfaceDescriptors([{ id: "remote_room", projection: "tools", expandContents: true }])).toEqual([]);
  });

  it("keeps an overridden descendant surface when an unused parent source row changes", () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    const objectRow = createWorld().exportObjects(["the_chatroom"])[0]!;
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env()) as unknown as {
      storeGatewayToolSurfacesFromDescriptors: (scope: ObjRef, authorityScope: ObjRef, descriptors: RemoteToolDescriptor[]) => void;
      readGatewayToolSurfaceDescriptors: (requests: RemoteToolRequest[]) => RemoteToolDescriptor[];
      applyGatewayProjectionWrites: (head: ShadowScopeHead, writes: ProjectionWrite[], source: "fanout", delta?: ProjectionDeltaSummary) => { rows: number; bytes: number };
    };
    const descriptor: RemoteToolDescriptor = {
      object: "remote_child",
      verb: "ping",
      aliases: [],
      arg_spec: { args: [] },
      direct: true,
      source: "/* child override */",
      enclosingSpace: "remote_room",
      source_rows: [{ table: "objects", authority_scope: "remote_room", key: "remote_child" }]
    };
    const head: ShadowScopeHead = {
      kind: "woo.scope_head.shadow.v1",
      scope: "remote_room",
      epoch: 1,
      seq: 4,
      hash: "h4"
    };

    po.storeGatewayToolSurfacesFromDescriptors("remote_room", "remote_room", [descriptor]);
    po.applyGatewayProjectionWrites(head, [{
      table: "objects",
      key: "remote_parent",
      op: "upsert",
      row: { ...objectRow, id: "remote_parent", name: "Remote Parent Edited" },
      bytes: 321
    }], "fanout");

    expect(po.readGatewayToolSurfaceDescriptors([{ id: "remote_room", projection: "tools", expandContents: true }])).toEqual([descriptor]);
  });

  it("invalidates cached tool surfaces from delta source markers without projection rows", () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env()) as unknown as {
      storeGatewayToolSurfacesFromDescriptors: (scope: ObjRef, authorityScope: ObjRef, descriptors: RemoteToolDescriptor[]) => void;
      readGatewayToolSurfaceDescriptors: (requests: RemoteToolRequest[]) => RemoteToolDescriptor[];
      applyGatewayProjectionWrites: (head: ShadowScopeHead, writes: ProjectionWrite[], source: "fanout", delta?: ProjectionDeltaSummary) => { rows: number; bytes: number };
    };
    const descriptor: RemoteToolDescriptor = {
      object: "remote_widget",
      verb: "ping",
      aliases: [],
      arg_spec: { args: [] },
      direct: true,
      source: "/* inherited ping */",
      enclosingSpace: "remote_room",
      source_rows: [{ table: "objects", authority_scope: "remote_room", key: "remote_parent" }]
    };
    const head: ShadowScopeHead = {
      kind: "woo.scope_head.shadow.v1",
      scope: "remote_room",
      epoch: 1,
      seq: 5,
      hash: "h5"
    };

    po.storeGatewayToolSurfacesFromDescriptors("remote_room", "remote_room", [descriptor]);
    expect(po.readGatewayToolSurfaceDescriptors([{ id: "remote_room", projection: "tools", expandContents: true }])).toHaveLength(1);

    const written = po.applyGatewayProjectionWrites(head, [], "fanout", {
      projection_bytes: 0,
      tool_surface_sources: [{
        key: { table: "objects", authority_scope: "remote_room", key: "remote_parent" },
        op: "upsert",
        bytes: 0
      }]
    });

    expect(written).toEqual({ rows: 1, bytes: 0 });
    expect(rows(state, "SELECT * FROM gateway_tool_surface_source")).toEqual([]);
    expect(po.readGatewayToolSurfaceDescriptors([{ id: "remote_room", projection: "tools", expandContents: true }])).toEqual([]);
  });

  it("consumes marker-only turn replies into the gateway projection cache", () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env()) as unknown as {
      storeGatewayToolSurfacesFromDescriptors: (scope: ObjRef, authorityScope: ObjRef, descriptors: RemoteToolDescriptor[]) => void;
      readGatewayToolSurfaceDescriptors: (requests: RemoteToolRequest[]) => RemoteToolDescriptor[];
      applyGatewayProjectionCacheFromReply: (replyText: string | null, source: "fanout") => void;
    };
    const descriptor: RemoteToolDescriptor = {
      object: "remote_widget",
      verb: "ping",
      aliases: [],
      arg_spec: { args: [] },
      direct: true,
      source: "/* inherited ping */",
      enclosingSpace: "remote_room",
      source_rows: [{ table: "objects", authority_scope: "remote_room", key: "remote_parent" }]
    };
    const head: ShadowScopeHead = {
      kind: "woo.scope_head.shadow.v1",
      scope: "remote_room",
      epoch: 1,
      seq: 6,
      hash: "h6"
    };

    po.storeGatewayToolSurfacesFromDescriptors("remote_room", "remote_room", [descriptor]);
    expect(po.readGatewayToolSurfaceDescriptors([{ id: "remote_room", projection: "tools", expandContents: true }])).toHaveLength(1);

    po.applyGatewayProjectionCacheFromReply(encodeEnvelope({
      v: 2,
      type: "woo.turn.exec.reply.shadow.v1",
      id: "marker-only-reply",
      from: "remote_room",
      auth: { mode: "session", token: "test" },
      body: {
        kind: "woo.turn.exec.reply.shadow.v1",
        ok: true,
        outcome: {},
        transcript: {
          kind: "woo.effect_transcript.shadow.v1",
          id: "marker-only-transcript",
          route: "direct",
          scope: "remote_room",
          seq: 0,
          session: null,
          call: { actor: "actor", target: "remote_parent", verb: "edit", args: [] },
          reads: [],
          writes: [],
          creates: [],
          moves: [],
          observations: [],
          logicalInputs: [],
          untrackedEffects: [],
          complete: true,
          incompleteReasons: [],
          hash: "marker-only-transcript"
        },
        commit: {
          kind: "woo.commit.accepted.shadow.v1",
          position: head,
          transcript_hash: "marker-only-transcript",
          post_state_hash: "post",
          observations: [],
          receipt: {
            kind: "woo.commit_receipt.shadow.v1",
            route: "direct",
            scope: "remote_room",
            seq: 6,
            transcript_hash: "marker-only-transcript",
            pre_state_hash: "pre",
            post_state_hash: "post",
            accepted: true,
            errors: []
          },
          projection_delta: {
            projection_bytes: 0,
            tool_surface_sources: [{
              key: { table: "objects", authority_scope: "remote_room", key: "remote_parent" },
              op: "upsert",
              bytes: 0
            }]
          },
          projection_writes: []
        }
      }
    }), "fanout");

    expect(po.readGatewayToolSurfaceDescriptors([{ id: "remote_room", projection: "tools", expandContents: true }])).toEqual([]);
  });

  it("preserves explicit actor authority when tolerated owner refresh times out", async () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    const world = createWorld();
    const session = world.auth("guest:authority-actor-preserve");
    const actorParent = world.object(session.actor).parent;
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env()) as unknown as {
      v2GatewayAuthorityPayload: (
        world: ReturnType<typeof createWorld>,
        extraObjectIds: ObjRef[],
        options: { tolerateRemoteFailures?: boolean }
      ) => Promise<{ authority: SerializedAuthoritySlice }>;
      forwardInternalReadChecked: () => Promise<never>;
    };
    po.forwardInternalReadChecked = async () => {
      throw wooError("E_TIMEOUT", "owner refresh timeout");
    };

    const payload = await po.v2GatewayAuthorityPayload(world, ["the_chatroom", session.actor], { tolerateRemoteFailures: true });
    const ids = authoritySliceObjectIds(payload.authority);

    expect(ids.has(session.actor)).toBe(true);
    if (actorParent) expect(ids.has(actorParent)).toBe(true);
    expect(ids.has("the_chatroom")).toBe(false);
  });

  it("uses the commit-scope snapshot for MCP per-envelope remote authority refresh", async () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    const metrics: MetricEvent[] = [];
    const world = createWorld({ metricsHook: (event) => metrics.push(event) });
    const session = world.auth("guest:authority-snapshot-fallback");
    const actorParent = world.object(session.actor).parent;
    let ownerReads = 0;
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env()) as unknown as {
      v2GatewayAuthorityPayload: (
        world: ReturnType<typeof createWorld>,
        extraObjectIds: ObjRef[],
        options: { tolerateRemoteFailures?: boolean; useCommitScopeSnapshotForRemoteAuthority?: boolean }
      ) => Promise<{ authority: SerializedAuthoritySlice }>;
      forwardInternalReadChecked: () => Promise<never>;
    };
    po.forwardInternalReadChecked = async () => {
      ownerReads += 1;
      throw new Error("owner should not be read for snapshot fallback");
    };

    const payload = await po.v2GatewayAuthorityPayload(world, ["the_chatroom", session.actor], {
      tolerateRemoteFailures: true,
      useCommitScopeSnapshotForRemoteAuthority: true
    });
    const ids = authoritySliceObjectIds(payload.authority);

    expect(ownerReads).toBe(0);
    expect(ids.has(session.actor)).toBe(true);
    if (actorParent) expect(ids.has(actorParent)).toBe(true);
    expect(ids.has("the_chatroom")).toBe(false);
    expect(metrics).toContainEqual(expect.objectContaining({
      kind: "authority_slice_omitted",
      host: "the_chatroom",
      reason: "snapshot_fallback"
    }));
  });

  it("omits session rows whose actor row is absent from the authority slice", async () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    const world = createWorld();
    const live = world.auth("guest:authority-session-live");
    const stale = world.auth("guest:authority-session-stale");
    world.objects.delete(stale.actor);
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env()) as unknown as {
      v2GatewayAuthorityPayload: (
        world: ReturnType<typeof createWorld>,
        extraObjectIds: ObjRef[],
        options: { tolerateRemoteFailures?: boolean; useCommitScopeSnapshotForRemoteAuthority?: boolean }
      ) => Promise<{ authority: SerializedAuthoritySlice }>;
    };

    const payload = await po.v2GatewayAuthorityPayload(world, ["the_chatroom", live.actor], {
      tolerateRemoteFailures: true,
      useCommitScopeSnapshotForRemoteAuthority: true
    });
    const ids = authoritySliceObjectIds(payload.authority);

    expect(ids.has(live.actor)).toBe(true);
    expect(ids.has(stale.actor)).toBe(false);
    expect(payload.authority.sessions.map((session) => session.id)).toContain(live.id);
    expect(payload.authority.sessions.map((session) => session.id)).not.toContain(stale.id);
  });
});
