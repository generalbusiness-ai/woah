import { describe, expect, it } from "vitest";
import { authoritySliceObjectIds, buildSerializedAuthorityCellSlice, serializedWorldFromAuthoritySlice, withAuthorityPageProvenance } from "../../src/core/authority-slice";
import { createWorld } from "../../src/core/bootstrap";
import type { EffectTranscript } from "../../src/core/effect-transcript";
import type { ProjectionDeltaSummary, ProjectionWrite, SessionToolManifest } from "../../src/core/projection-delta";
import type { SerializedAuthoritySlice, SerializedObject, SerializedSession } from "../../src/core/repository";
import { encodeEnvelope } from "../../src/core/shadow-envelope";
import { wooError, type MetricEvent, type ObjRef, type RemoteToolDescriptor, type RemoteToolRequest } from "../../src/core/types";
import type { ShadowCommitAccepted, ShadowScopeHead } from "../../src/core/shadow-commit-scope";
import { PersistentObjectDO, type Env } from "../../src/worker/persistent-object-do";
import { FakeDurableObjectNamespace, FakeDurableObjectState } from "./fake-do";

function env(overrides: Partial<Env> = {}): Env {
  return {
    WOO_INITIAL_WIZARD_TOKEN: "test-wizard",
    WOO_INTERNAL_SECRET: "test-secret",
    WOO: new FakeDurableObjectNamespace(() => ({ fetch: () => new Response(null, { status: 404 }) })) as unknown as DurableObjectNamespace,
    DIRECTORY: new FakeDurableObjectNamespace(() => ({ fetch: () => new Response(null, { status: 404 }) })) as unknown as DurableObjectNamespace,
    ...overrides
  };
}

function rows<T>(state: FakeDurableObjectState, query: string, ...params: unknown[]): T[] {
  return state.storage.sql.exec(query, ...params).toArray() as T[];
}

function cachedObject(state: FakeDurableObjectState, id: ObjRef): SerializedObject | null {
  const row = rows<{ body: string }>(state, "SELECT body FROM gateway_projection_object WHERE id = ? ORDER BY authority_scope LIMIT 1", id)[0];
  return row ? JSON.parse(row.body) as SerializedObject : null;
}

function authorityFromHost(world: ReturnType<typeof createWorld>, host: string, objects: readonly ObjRef[]): SerializedAuthoritySlice {
  return withAuthorityPageProvenance(
    world.exportAuthoritySlice([], objects),
    (ref) => ({
      source: world.objectHostKey(ref.object) === host ? "authoritative" : "cache",
      source_host: host
    })
  );
}

function serializedObject(id: ObjRef, parent: ObjRef | null, name = id): SerializedObject {
  return {
    id,
    name,
    parent,
    anchor: null,
    owner: "$wiz",
    location: null,
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

function transcriptWithMoves(id: string, scope: ObjRef, moves: EffectTranscript["moves"]): EffectTranscript {
  return {
    kind: "woo.effect_transcript.shadow.v1",
    id,
    route: "sequenced",
    scope,
    seq: 1,
    session: null,
    call: { actor: "$wiz", target: scope, verb: "test", args: [] },
    reads: [],
    writes: [],
    creates: [],
    moves,
    observations: [],
    logicalInputs: [],
    untrackedEffects: [],
    complete: true,
    incompleteReasons: [],
    hash: id
  };
}

describe("gateway projection cache", () => {
  it("creates a reverse lookup index for tool-surface source invalidation", () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    try {
      new PersistentObjectDO(state as unknown as DurableObjectState, env());

      const indexNames = rows<{ name: string }>(
        state,
        "PRAGMA index_list('gateway_tool_surface_source')"
      ).map((row) => row.name);
      expect(indexNames).toContain("gateway_tool_surface_source_lookup");
    } finally {
      state.close();
    }
  });

  it("clears derived gateway projection rows when the cache epoch changes", () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    try {
      const first = new PersistentObjectDO(state as unknown as DurableObjectState, env()) as unknown as {
        applyGatewayProjectionWrites: (head: ShadowScopeHead, writes: ProjectionWrite[], source: "fanout", delta?: ProjectionDeltaSummary) => { rows: number; bytes: number };
      };
      first.applyGatewayProjectionWrites({
        kind: "woo.scope_head.shadow.v1",
        scope: "the_chatroom",
        epoch: 1,
        seq: 1,
        hash: "h1"
      }, [{
        table: "objects",
        key: "the_chatroom",
        op: "upsert",
        row: createWorld().exportObjects(["the_chatroom"])[0]!,
        bytes: 123
      }], "fanout");
      expect(rows(state, "SELECT id FROM gateway_projection_object")).toHaveLength(1);

      state.storage.sql.exec(
        "UPDATE gateway_projection_cache_meta SET value = ? WHERE id = ?",
        "old-cache-epoch",
        "current"
      );
      new PersistentObjectDO(state as unknown as DurableObjectState, env());

      expect(rows(state, "SELECT id FROM gateway_projection_object")).toEqual([]);
      expect(rows(state, "SELECT scope FROM gateway_projection_scope")).toEqual([]);
      const meta = rows<{ value: string }>(state, "SELECT value FROM gateway_projection_cache_meta WHERE id = ?", "current")[0];
      expect(meta?.value).toBeTruthy();
      expect(meta?.value).not.toBe("old-cache-epoch");
    } finally {
      state.close();
    }
  });

  it("invalidates cached Directory session lookups when projected session rows move", async () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    const deckSession: SerializedSession = {
      id: "bob-session",
      actor: "guest_bob",
      started: 1,
      expiresAt: Date.now() + 60_000,
      tokenClass: "guest",
      activeScope: "the_deck",
      currentLocation: "the_deck"
    };
    let directorySessions: SerializedSession[] = [deckSession];
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env({
      DIRECTORY: new FakeDurableObjectNamespace(() => ({
        fetch: async (request: Request): Promise<Response> => {
          if (new URL(request.url).pathname !== "/sessions-for-scopes") {
            return Response.json({ error: { code: "E_OBJNF" } }, { status: 404 });
          }
          return Response.json({ sessions: directorySessions, next_after_session_id: null });
        }
      })) as unknown as DurableObjectNamespace
    })) as unknown as {
      loadDirectorySessionsForScopes: (scopes: ObjRef[], path: "mcp_fanout_audience") => Promise<SerializedSession[]>;
      applyGatewayProjectionWrites: (
        head: ShadowScopeHead,
        writes: ProjectionWrite[],
        source: "fanout",
        delta?: ProjectionDeltaSummary
      ) => { rows: number; bytes: number };
    };
    try {
      const first = await po.loadDirectorySessionsForScopes(["the_chatroom", "the_deck"], "mcp_fanout_audience");
      expect(first.map((session) => session.activeScope)).toEqual(["the_deck"]);

      const chatSession: SerializedSession = {
        ...deckSession,
        activeScope: "the_chatroom",
        currentLocation: "the_chatroom"
      };
      directorySessions = [chatSession];
      po.applyGatewayProjectionWrites({
        kind: "woo.scope_head.shadow.v1",
        scope: "guest_bob",
        epoch: 1,
        seq: 2,
        hash: "h2"
      }, [{
        table: "sessions",
        key: "bob-session",
        op: "upsert",
        row: chatSession,
        bytes: 128
      }], "fanout", { projection_bytes: 128 });

      const second = await po.loadDirectorySessionsForScopes(["the_chatroom", "the_deck"], "mcp_fanout_audience");
      expect(second.map((session) => session.activeScope)).toEqual(["the_chatroom"]);
    } finally {
      state.close();
    }
  });

  it("requires an explicit host list for admin derived-contents repair and forwards only those hosts", async () => {
    const state = new FakeDurableObjectState("world");
    const forwarded: Record<string, unknown> = {};
    let testEnv: Env;
    testEnv = env({
      WOO: new FakeDurableObjectNamespace((name) => ({
        fetch: async (request: Request) => {
          const body = await request.json() as Record<string, unknown>;
          forwarded.host = name;
          forwarded.path = new URL(request.url).pathname;
          forwarded.body = body;
          forwarded.hostHeader = request.headers.get("x-woo-host-key");
          return new Response(JSON.stringify({
            ok: true,
            host: name,
            inspected_containers: 2,
            repaired_containers: ["the_chatroom"],
            members_added: 1,
            members_removed: 50,
            missing_members_removed: 49
          }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
        }
      })) as unknown as DurableObjectNamespace
    });
    try {
      const po = new PersistentObjectDO(state as unknown as DurableObjectState, testEnv);
      const adminHeaders = {
        "content-type": "application/json; charset=utf-8",
        "x-woo-internal-session": "admin-repair",
        "x-woo-internal-actor": "$wiz",
        "x-woo-internal-expires-at": String(Date.now() + 60_000),
        "x-woo-internal-token-class": "apikey",
        "x-woo-internal-started": String(Date.now())
      };
      const rejected = await po.fetch(new Request("https://woah.example/api/admin/repair-derived-contents", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ hosts: [] })
      }));
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ error: { code: "E_INVARG" } });
      expect(forwarded).toEqual({});

      const request = new Request("https://woah.example/api/admin/repair-derived-contents", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ hosts: ["the_chatroom"] })
      });
      const response = await po.fetch(request);
      expect(response.status).toBe(200);
      const payload = await response.json() as { ok?: boolean; results?: Array<Record<string, unknown>> };
      expect(payload.ok).toBe(true);
      expect(payload.results).toEqual([
        expect.objectContaining({
          ok: true,
          host: "the_chatroom",
          repaired_containers: ["the_chatroom"]
        })
      ]);
      expect(forwarded).toMatchObject({
        host: "the_chatroom",
        path: "/__internal/repair-derived-contents",
        body: {},
        hostHeader: "the_chatroom"
      });
    } finally {
      state.close();
    }
  });

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

  it("repairs cached room contents from move transcripts even when no full room row is written", () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env()) as unknown as {
      storeGatewayToolSurfacesFromDescriptors: (scope: ObjRef, authorityScope: ObjRef, descriptors: RemoteToolDescriptor[]) => void;
      readGatewayToolSurfaceDescriptors: (requests: RemoteToolRequest[]) => RemoteToolDescriptor[];
      applyGatewayProjectionWrites: (
        head: ShadowScopeHead,
        writes: ProjectionWrite[],
        source: "fanout",
        delta?: ProjectionDeltaSummary,
        transcript?: EffectTranscript
      ) => { rows: number; bytes: number };
    };
    const room = {
      ...serializedObject("remote_room", "$space", "Remote Room"),
      contents: ["stale_guest"]
    };
    const head: ShadowScopeHead = {
      kind: "woo.scope_head.shadow.v1",
      scope: "remote_room",
      epoch: 1,
      seq: 1,
      hash: "h1"
    };

    po.applyGatewayProjectionWrites(head, [{
      table: "objects",
      key: "remote_room",
      op: "upsert",
      row: room,
      bytes: 123
    }], "fanout");
    po.storeGatewayToolSurfacesFromDescriptors("remote_room", "remote_room", [{
      object: "stale_guest",
      verb: "look",
      aliases: [],
      arg_spec: {},
      direct: false,
      source: "/* stale */",
      enclosingSpace: "remote_room"
    }]);
    expect(po.readGatewayToolSurfaceDescriptors([{ id: "remote_room", projection: "tools", expandContents: true }])).toHaveLength(1);

    const written = po.applyGatewayProjectionWrites(
      { ...head, seq: 2, hash: "h2" },
      [],
      "fanout",
      { projection_bytes: 0 },
      transcriptWithMoves("move-cache-repair", "remote_room", [
        { object: "stale_guest", from: "remote_room", to: "$nowhere" },
        { object: "the_mug", from: "$nowhere", to: "remote_room" }
      ])
    );

    expect(written.rows).toBeGreaterThanOrEqual(2);
    expect(cachedObject(state, "remote_room")?.contents).toEqual(["the_mug"]);
    expect(po.readGatewayToolSurfaceDescriptors([{ id: "remote_room", projection: "tools", expandContents: true }])).toEqual([]);
  });

  it("prunes a closed guest actor from cached room contents and descriptor coverage", () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env()) as unknown as {
      storeGatewayToolSurfacesFromDescriptors: (scope: ObjRef, authorityScope: ObjRef, descriptors: RemoteToolDescriptor[]) => void;
      readGatewayToolSurfaceDescriptors: (requests: RemoteToolRequest[]) => RemoteToolDescriptor[];
      applyGatewayProjectionWrites: (
        head: ShadowScopeHead,
        writes: ProjectionWrite[],
        source: "fanout",
        delta?: ProjectionDeltaSummary
      ) => { rows: number; bytes: number };
      deleteLocalGatewaySessionCache: (sessionId: string) => void;
    };
    const head: ShadowScopeHead = {
      kind: "woo.scope_head.shadow.v1",
      scope: "remote_room",
      epoch: 1,
      seq: 1,
      hash: "h1"
    };
    const room = {
      ...serializedObject("remote_room", "$space", "Remote Room"),
      contents: ["guest_999", "the_mug"]
    };
    const guest = {
      ...serializedObject("guest_999", "$guest", "Guest 999"),
      location: "remote_room"
    };
    const session: SerializedSession = {
      id: "guest-session",
      actor: "guest_999",
      started: 1,
      expiresAt: Date.now() + 60_000,
      tokenClass: "apikey",
      activeScope: "remote_room"
    };

    po.applyGatewayProjectionWrites(head, [
      { table: "objects", key: "remote_room", op: "upsert", row: room, bytes: 100 },
      { table: "objects", key: "guest_999", op: "upsert", row: guest, bytes: 100 },
      { table: "sessions", key: session.id, op: "upsert", row: session, bytes: 100 }
    ], "fanout");
    po.storeGatewayToolSurfacesFromDescriptors("remote_room", "remote_room", [{
      object: "guest_999",
      verb: "look",
      aliases: [],
      arg_spec: {},
      direct: false,
      source: "/* stale guest */",
      enclosingSpace: "remote_room"
    }]);

    po.deleteLocalGatewaySessionCache("guest-session");

    expect(rows(state, "SELECT session_id FROM gateway_projection_session")).toEqual([]);
    expect(rows(state, "SELECT id FROM gateway_scope_member WHERE id = ?", "guest_999")).toEqual([]);
    expect(rows(state, "SELECT id FROM gateway_projection_object WHERE id = ?", "guest_999")).toEqual([]);
    expect(cachedObject(state, "remote_room")?.contents).toEqual(["the_mug"]);
    expect(po.readGatewayToolSurfaceDescriptors([{ id: "remote_room", projection: "tools", expandContents: true }])).toEqual([]);
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

  it("treats a partial cache hit as incomplete so uncached scopes still refresh", () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env()) as unknown as {
      storeGatewayToolSurfacesFromDescriptors: (scope: ObjRef, authorityScope: ObjRef, descriptors: RemoteToolDescriptor[]) => void;
      readGatewayToolSurfaceDescriptors: (requests: RemoteToolRequest[]) => RemoteToolDescriptor[];
      gatewayToolSurfaceRequestCovered: (request: RemoteToolRequest) => boolean;
    };
    const descriptor: RemoteToolDescriptor = {
      object: "remote_widget",
      verb: "ping",
      aliases: [],
      arg_spec: { args: [] },
      direct: true,
      source: "/* cached */",
      enclosingSpace: "room_a"
    };
    // room_a is cached; room_b (same owning host) has never been refreshed.
    po.storeGatewayToolSurfacesFromDescriptors("room_a", "room_a", [descriptor]);
    const requestA: RemoteToolRequest = { id: "room_a", projection: "tools", expandContents: true };
    const requestB: RemoteToolRequest = { id: "room_b", projection: "tools", expandContents: true };

    // The mixed-batch cache read is non-empty (room_a's descriptor). The old
    // `cached.length > 0` short-circuit wrongly treated that as a complete
    // answer and suppressed room_b's owner refresh, so room_b's tools vanished.
    expect(po.readGatewayToolSurfaceDescriptors([requestA, requestB]).length).toBe(1);
    // Coverage is request-level: room_a is covered, room_b is not, so the batch
    // is NOT fully covered and enumerateRemoteTools must refresh from the owner.
    expect(po.gatewayToolSurfaceRequestCovered(requestA)).toBe(true);
    expect(po.gatewayToolSurfaceRequestCovered({ ...requestA, forceRefresh: true })).toBe(false);
    expect(po.gatewayToolSurfaceRequestCovered(requestB)).toBe(false);
    expect([requestA, requestB].every((request) => po.gatewayToolSurfaceRequestCovered(request))).toBe(false);
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
    const metrics: MetricEvent[] = [];
    const world = createWorld({ metricsHook: (event) => metrics.push(event) });
    const session = world.auth("guest:authority-actor-preserve");
    const actorParent = world.object(session.actor).parent;
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env()) as unknown as {
      v2GatewayAuthorityPayload: (
        world: ReturnType<typeof createWorld>,
        extraObjectIds: ObjRef[],
        options: { tolerateRemoteFailures?: boolean }
      ) => Promise<{ authority: SerializedAuthoritySlice }>;
      routeCache: Map<ObjRef, string>;
      forwardInternalReadChecked: () => Promise<never>;
    };
    po.routeCache.set("the_chatroom", "the_chatroom");
    po.forwardInternalReadChecked = async () => {
      throw wooError("E_TIMEOUT", "owner refresh timeout");
    };

    const payload = await po.v2GatewayAuthorityPayload(world, ["the_chatroom", session.actor], { tolerateRemoteFailures: true });
    const ids = authoritySliceObjectIds(payload.authority);

    expect(ids.has(session.actor)).toBe(true);
    if (actorParent) expect(ids.has(actorParent)).toBe(true);
    expect(ids.has("the_chatroom")).toBe(true);
    expect(metrics).toContainEqual(expect.objectContaining({
      kind: "authority_slice_stale_fallback",
      host: "the_chatroom",
      reason: "timeout"
    }));
  });

  it("uses local stale rows for MCP per-envelope remote authority refresh", async () => {
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
        options: { tolerateRemoteFailures?: boolean; useCommitScopeSnapshotForRemoteAuthority?: boolean; reconstructionReason?: "warm_turn_refresh"; reconstructionScope?: ObjRef }
      ) => Promise<{ authority: SerializedAuthoritySlice }>;
      routeCache: Map<ObjRef, string>;
      forwardInternalReadChecked: () => Promise<never>;
    };
    po.routeCache.set("the_chatroom", "the_chatroom");
    po.forwardInternalReadChecked = async () => {
      ownerReads += 1;
      throw new Error("owner should not be read for snapshot fallback");
    };

    const payload = await po.v2GatewayAuthorityPayload(world, ["the_chatroom", session.actor], {
      tolerateRemoteFailures: true,
      useCommitScopeSnapshotForRemoteAuthority: true,
      reconstructionReason: "warm_turn_refresh",
      reconstructionScope: "the_chatroom"
    });
    const ids = authoritySliceObjectIds(payload.authority);

    expect(ownerReads).toBe(0);
    expect(ids.has(session.actor)).toBe(true);
    if (actorParent) expect(ids.has(actorParent)).toBe(true);
    expect(ids.has("the_chatroom")).toBe(true);
    expect(metrics).toContainEqual(expect.objectContaining({
      kind: "authority_slice_stale_fallback",
      host: "the_chatroom",
      reason: "snapshot_fallback"
    }));
  });

  it("keeps transitive movement destinations when owner refresh falls back to stale rows", async () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    const metrics: MetricEvent[] = [];
    const world = createWorld({
      catalogs: ["chat", "demoworld", "tasks", "blocks-demo"],
      metricsHook: (event) => metrics.push(event)
    });
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env()) as unknown as {
      v2GatewayAuthorityPayload: (
        world: ReturnType<typeof createWorld>,
        extraObjectIds: ObjRef[],
        options: { tolerateRemoteFailures?: boolean; useCommitScopeSnapshotForRemoteAuthority?: boolean }
      ) => Promise<{ authority: SerializedAuthoritySlice }>;
      routeCache: Map<ObjRef, string>;
      forwardInternalReadChecked: () => Promise<never>;
    };
    po.routeCache.set("the_deck", "the_deck");
    po.forwardInternalReadChecked = async () => {
      throw new Error("owner should not be read for snapshot fallback");
    };

    const payload = await po.v2GatewayAuthorityPayload(world, ["the_deck"], {
      tolerateRemoteFailures: true,
      useCommitScopeSnapshotForRemoteAuthority: true
    });
    const ids = authoritySliceObjectIds(payload.authority);

    expect(ids.has("the_deck")).toBe(true);
    expect(ids.has("exit_deck_south")).toBe(true);
    expect(ids.has("the_garden")).toBe(true);
    expect(metrics).toContainEqual(expect.objectContaining({
      kind: "authority_slice_stale_fallback",
      host: "the_deck",
      reason: "snapshot_fallback"
    }));
  });

  it("fetches owner-current actor name cells on sparse MCP shards", async () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    const localWorld = createWorld();
    const ownerWorld = createWorld();
    const session = localWorld.auth("guest:authority-owner-current");
    const localActor = localWorld.object(session.actor);
    localActor.properties.set("name", "Stale Guest");
    localActor.propertyVersions.set("name", 0);
    ownerWorld.setProp(session.actor, "name", "Guest 1");
    const ownerName = ownerWorld.propOrNull(session.actor, "name");
    expect(ownerName).toBe("Guest 1");
    const reads: Array<{ host: string; objects: ObjRef[] }> = [];
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env({
      DIRECTORY: new FakeDurableObjectNamespace(() => ({
        fetch: async (request: Request) => {
          const body = await request.json() as { id?: string; fallback_host?: string };
          return new Response(JSON.stringify({
            id: body.id,
            host: body.id === session.actor ? "world" : body.fallback_host ?? "",
            anchor: null
          }), {
            headers: { "content-type": "application/json" }
          });
        }
      })) as unknown as DurableObjectNamespace
    })) as unknown as {
      v2GatewayAuthorityPayload: (
        world: ReturnType<typeof createWorld>,
        extraObjectIds: ObjRef[],
        options: { tolerateRemoteFailures?: boolean }
      ) => Promise<{ authority: SerializedAuthoritySlice }>;
      routeCache: Map<ObjRef, string>;
      forwardInternalReadChecked: (host: string, path: string, body: { objects?: ObjRef[] }) => Promise<{ authority: SerializedAuthoritySlice }>;
    };
    po.routeCache.set("the_chatroom", "the_chatroom");
    po.forwardInternalReadChecked = async (host, _path, body) => {
      const objects = body.objects ?? [];
      reads.push({ host, objects });
      return { authority: authorityFromHost(host === "world" ? ownerWorld : localWorld, host, objects) };
    };

    const payload = await po.v2GatewayAuthorityPayload(localWorld, ["the_chatroom", session.actor], { tolerateRemoteFailures: true });
    const actor = serializedWorldFromAuthoritySlice(payload.authority).objects.find((obj) => obj.id === session.actor);

    expect(reads).toEqual(expect.arrayContaining([
      expect.objectContaining({ host: "world", objects: expect.arrayContaining([session.actor]) })
    ]));
    expect(actor?.properties.find(([name]) => name === "name")?.[1]).toBe("Guest 1");
    expect(actor?.propertyVersions.find(([name]) => name === "name")?.[1]).toBe(1);
  });

  it("does not guess world for unresolved ids but follows actor owner routes on sparse MCP shards", async () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    const world = createWorld();
    const session = world.auth("guest:authority-no-world-guess");
    const reads: string[] = [];
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env({
      DIRECTORY: new FakeDurableObjectNamespace(() => ({
        fetch: async (request: Request) => {
          const body = await request.json() as { id?: string };
          return new Response(JSON.stringify({ id: body.id, host: body.id === session.actor ? "world" : "", anchor: null }), {
            headers: { "content-type": "application/json" }
          });
        }
      })) as unknown as DurableObjectNamespace
    })) as unknown as {
      v2GatewayAuthorityPayload: (
        world: ReturnType<typeof createWorld>,
        extraObjectIds: ObjRef[],
        options: { tolerateRemoteFailures?: boolean }
      ) => Promise<{ authority: SerializedAuthoritySlice }>;
      routeCache: Map<ObjRef, string>;
      forwardInternalReadChecked: (host: string, path: string, body: { objects?: ObjRef[] }) => Promise<{ authority: SerializedAuthoritySlice }>;
    };
    po.routeCache.set("the_chatroom", "the_chatroom");
    po.forwardInternalReadChecked = async (host, _path, body) => {
      reads.push(host);
      return { authority: authorityFromHost(world, host, body.objects ?? []) };
    };

    await po.v2GatewayAuthorityPayload(world, ["the_chatroom", session.actor], { tolerateRemoteFailures: true });

    expect(reads).toEqual(["the_chatroom", "world"]);
  });

  it("does not let a stale Directory world route override sparse self-host repair", async () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    const world = createWorld();
    const session = world.auth("guest:authority-stale-directory-world");
    const reads: Array<{ host: string; objects: ObjRef[] }> = [];
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env({
      DIRECTORY: new FakeDurableObjectNamespace(() => ({
        fetch: async (request: Request) => {
          const body = await request.json() as { id?: string };
          return new Response(JSON.stringify({ id: body.id, host: "world", anchor: null }), {
            headers: { "content-type": "application/json" }
          });
        }
      })) as unknown as DurableObjectNamespace
    })) as unknown as {
      v2GatewayAuthorityPayload: (
        world: ReturnType<typeof createWorld>,
        extraObjectIds: ObjRef[],
        options: {
          tolerateRemoteFailures?: boolean;
          reconstructionReason?: "warm_turn_refresh" | "cold_open" | "missing_state_repair" | "slice_served";
          reconstructionScope?: ObjRef;
          forceOwnerObjectIds?: readonly ObjRef[];
        }
      ) => Promise<{ authority: SerializedAuthoritySlice }>;
      forwardInternalReadChecked: (host: string, path: string, body: { objects?: ObjRef[] }) => Promise<{ authority: SerializedAuthoritySlice }>;
      routeCache: Map<ObjRef, string>;
    };
    po.forwardInternalReadChecked = async (host, _path, body) => {
      reads.push({ host, objects: [...(body.objects ?? [])] });
      return { authority: authorityFromHost(world, host, body.objects ?? []) };
    };

    const payload = await po.v2GatewayAuthorityPayload(world, ["the_chatroom", session.actor], {
      tolerateRemoteFailures: true,
      reconstructionReason: "missing_state_repair",
      reconstructionScope: "the_chatroom",
      forceOwnerObjectIds: ["the_chatroom"]
    });

    expect(reads).toEqual(expect.arrayContaining([
      expect.objectContaining({ host: "the_chatroom", objects: expect.arrayContaining(["the_chatroom"]) })
    ]));
    expect(reads.some((read) => read.host === "world" && read.objects.includes("the_chatroom"))).toBe(false);
    expect(po.routeCache.get("the_chatroom")).toBe("the_chatroom");
    if (payload.authority.kind === "woo.authority_slice.cells.shadow.v1") {
      expect(payload.authority.page_refs).toContainEqual(expect.objectContaining({
        object: "the_chatroom",
        page: "object_live",
        source: "authoritative",
        source_host: "the_chatroom"
      }));
    }
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

  it("does not project anonymous Directory guest session stubs into authority", async () => {
    const state = new FakeDurableObjectState("mcp-gateway-0");
    const world = createWorld();
    const live = world.auth("guest:authority-directory-live");
    const staleSessionId = "directory-stale-anonymous";
    const namedSessionId = "directory-named-peer";
    const directorySessions = [{
      session_id: staleSessionId,
      actor: "guest_999",
      started: 1,
      expires_at: Date.now() + 60_000,
      token_class: "guest",
      current_location: "the_chatroom",
      mcp_shard: "mcp-gateway-1",
      display_name: null,
      focus_list: "[]",
      actor_props: "[]",
      updated_at: Date.now()
    }, {
      session_id: namedSessionId,
      actor: "guest_998",
      started: 2,
      expires_at: Date.now() + 60_000,
      token_class: "guest",
      current_location: "the_chatroom",
      mcp_shard: "mcp-gateway-1",
      display_name: "Guest 998",
      focus_list: "[]",
      actor_props: "[]",
      updated_at: Date.now()
    }];
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env({
      DIRECTORY: new FakeDurableObjectNamespace(() => ({
        fetch: async (request: Request) => {
          const url = new URL(request.url);
          if (url.pathname === "/sessions-for-scopes") {
            return new Response(JSON.stringify({ sessions: directorySessions, next_after_session_id: null }), {
              headers: { "content-type": "application/json; charset=utf-8" }
            });
          }
          if (url.pathname === "/resolve-object") {
            const body = await request.json() as { id?: string; fallback_host?: string };
            return new Response(JSON.stringify({ id: body.id, host: body.fallback_host ?? "", anchor: null }), {
              headers: { "content-type": "application/json; charset=utf-8" }
            });
          }
          return new Response(JSON.stringify({ error: "unexpected directory path" }), { status: 404 });
        }
      })) as unknown as DurableObjectNamespace
    })) as unknown as {
      v2GatewayAuthorityPayload: (
        world: ReturnType<typeof createWorld>,
        extraObjectIds: ObjRef[],
        options: {
          tolerateRemoteFailures?: boolean;
          useCommitScopeSnapshotForRemoteAuthority?: boolean;
          directorySessionScopes?: readonly ObjRef[];
        }
      ) => Promise<{ authority: SerializedAuthoritySlice }>;
    };

    const payload = await po.v2GatewayAuthorityPayload(world, ["the_chatroom", live.actor], {
      tolerateRemoteFailures: true,
      useCommitScopeSnapshotForRemoteAuthority: true,
      directorySessionScopes: ["the_chatroom"]
    });
    const serialized = serializedWorldFromAuthoritySlice(payload.authority);
    const objectIds = new Set(serialized.objects.map((obj) => obj.id));
    const sessionIds = new Set(payload.authority.sessions.map((session) => session.id));

    expect(objectIds.has("guest_999" as ObjRef)).toBe(false);
    expect(sessionIds.has(staleSessionId)).toBe(false);
    expect(objectIds.has("guest_998" as ObjRef)).toBe(true);
    expect(serialized.objects.find((obj) => obj.id === "guest_998")?.name).toBe("Guest 998");
    expect(sessionIds.has(namedSessionId)).toBe(true);
    const chatroomLiveContents = payload.authority.kind === "woo.authority_slice.cells.shadow.v1"
      ? payload.authority.inline_pages.flatMap((page) =>
        page.page === "object_live" && page.object === "the_chatroom" ? page.contents : []
      )
      : [];
    expect(chatroomLiveContents).not.toContain("guest_999" as ObjRef);
    const chatroomLiveRefs = payload.authority.kind === "woo.authority_slice.cells.shadow.v1"
      ? payload.authority.page_refs.filter((ref) => ref.object === "the_chatroom" && ref.page === "object_live")
      : [];
    expect(chatroomLiveRefs.length).toBeGreaterThan(0);
    expect(chatroomLiveRefs.every((ref) => ref.source !== "authoritative")).toBe(true);
  });

});
