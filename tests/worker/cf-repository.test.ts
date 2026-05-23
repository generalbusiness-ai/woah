import { describe, expect, it, vi } from "vitest";
import { installVerb } from "../../src/core/authoring";
import { createWorld } from "../../src/core/bootstrap";
import { decodeEnvelope, encodeEnvelope } from "../../src/core/shadow-envelope";
import {
  createShadowBrowserNode,
  createShadowBrowserRelayShim,
  openShadowBrowserScope,
  setShadowBrowserSessionToken,
  shadowBrowserEnvelope
} from "../../src/core/shadow-browser-node";
import { runShadowTurnCall, type ShadowTurnCall } from "../../src/core/shadow-turn-call";
import { shadowTurnKeyFromTranscript } from "../../src/core/turn-key";
import type { ShadowScopeHead } from "../../src/core/shadow-commit-scope";
import type { Message, ObjRef, TinyBytecode, VerbDef, WooValue } from "../../src/core/types";
import type { CallContext, ExecutorContext, HostObjectSummary, MoveObjectResult, RoomSnapshot, ScopedObjectSummary, WooWorld } from "../../src/core/world";
import { CFObjectRepository } from "../../src/worker/cf-repository";
import { CommitScopeDO } from "../../src/worker/commit-scope-do";
import { DirectoryDO } from "../../src/worker/directory-do";
import worker from "../../src/worker/index";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { PersistentObjectDO, v2FanoutEnvelopesByNode, type Env } from "../../src/worker/persistent-object-do";
import { FakeDurableObjectNamespace, FakeDurableObjectState } from "./fake-do";

// These are production-shape Worker integration tests; under full-suite CPU
// contention they legitimately exceed Vitest's default 30s per-test timeout.
vi.setConfig({ testTimeout: 120_000 });

class FakeKVNamespace {
  readonly values = new Map<string, string>();

  async get(key: string, _type?: "text"): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

class WaitUntilDurableObjectState extends FakeDurableObjectState {
  readonly waitUntilPromises: Promise<unknown>[] = [];

  waitUntil(promise: Promise<unknown>): void {
    this.waitUntilPromises.push(Promise.resolve(promise));
  }

  async drainWaitUntil(): Promise<void> {
    await Promise.all(this.waitUntilPromises.splice(0));
  }
}

function hasJsonKey(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => hasJsonKey(item, key));
  return Object.entries(value).some(([name, child]) => name === key || hasJsonKey(child, key));
}

function metricEvents(logSpy: { mock: { calls: unknown[][] } }, kind: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const call of logSpy.mock.calls) {
    if (call[0] !== "woo.metric" || typeof call[1] !== "string") continue;
    const parsed = JSON.parse(call[1]) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as { kind?: unknown }).kind === kind) {
      events.push(parsed as Record<string, unknown>);
    }
  }
  return events;
}

function firstBytecodeVerb(world: WooWorld): VerbDef | null {
  for (const obj of world.objects.values()) {
    for (const verb of obj.verbs) {
      if (verb.kind === "bytecode") return verb;
    }
  }
  return null;
}

function injectMismatchedInlineBytecode(world: unknown, hashes: Array<Record<string, unknown>>): void {
  const first = hashes[0];
  if (!first || typeof first.object !== "string" || typeof first.verb !== "string") {
    throw new Error("expected at least one bytecode hash");
  }
  if (!world || typeof world !== "object" || Array.isArray(world)) throw new Error("expected serialized world");
  const objects = (world as { objects?: unknown }).objects;
  if (!Array.isArray(objects)) throw new Error("expected serialized objects");
  const mismatched: TinyBytecode = { ops: [], literals: [], num_locals: 0, max_stack: 0, version: 999 };
  for (const obj of objects) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    if ((obj as { id?: unknown }).id !== first.object) continue;
    const verbs = (obj as { verbs?: unknown }).verbs;
    if (!Array.isArray(verbs)) break;
    for (const verb of verbs) {
      if (!verb || typeof verb !== "object" || Array.isArray(verb)) continue;
      if ((verb as { name?: unknown }).name === first.verb) {
        (verb as Record<string, unknown>).bytecode = mismatched;
        return;
      }
    }
  }
  throw new Error("failed to inject mismatched bytecode");
}

function createHostSeedKvHarness() {
  const kv = new FakeKVNamespace();
  const directoryState = new FakeDurableObjectState("directory");
  const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
  const wooStates = new Map<string, WaitUntilDurableObjectState>();
  const wooObjects = new Map<string, PersistentObjectDO>();
  const hostSeedFetches: string[] = [];
  const mcpGatewayWorldFetches: string[] = [];
  let env: Env;
  const wooNamespace = new FakeDurableObjectNamespace((name) => {
    let object = wooObjects.get(name);
    if (!object) {
      const state = new WaitUntilDurableObjectState(name);
      wooStates.set(name, state);
      object = new PersistentObjectDO(state as unknown as DurableObjectState, env);
      wooObjects.set(name, object);
    }
    return {
      fetch: async (request: Request): Promise<Response> => {
        if (name === "world" && new URL(request.url).pathname === "/__internal/host-seed") {
          const body = await request.clone().json().catch(() => ({})) as Record<string, unknown>;
          hostSeedFetches.push(String(body.host ?? ""));
        }
        if (name === "world" && new URL(request.url).pathname === "/__internal/mcp-gateway-world") {
          const body = await request.clone().json().catch(() => ({})) as Record<string, unknown>;
          mcpGatewayWorldFetches.push(String(body.shard ?? ""));
        }
        return await object!.fetch(request);
      }
    };
  });
  env = {
    WOO_INITIAL_WIZARD_TOKEN: "cf-kv-seed-token",
    WOO_INTERNAL_SECRET: "cf-test-secret",
    WOO_AUTO_INSTALL_CATALOGS: "chat,demoworld,note,blocks-demo",
    DIRECTORY: new FakeDurableObjectNamespace((name) => {
      if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
      return directory;
    }),
    WOO: wooNamespace,
    HOST_SEED_KV: kv as unknown as KVNamespace
  } as unknown as Env;

  const drain = async (name: string): Promise<void> => {
    await wooStates.get(name)?.drainWaitUntil();
  };

  const publishHostSeed = async (host: string): Promise<{ pointer: string; bytesKey: string; payload: Record<string, unknown> }> => {
    const request = await signInternalRequest(env, new Request("https://woo.internal/__internal/host-seed", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-woo-host-key": "world"
      },
      body: JSON.stringify({ host })
    }));
    const response = await wooNamespace.get({ name: "world" }).fetch(request);
    if (!response.ok) throw new Error(`host seed publish failed: ${response.status} ${await response.text()}`);
    await drain("world");
    const pointer = await kv.get(`seed-current:${host}`, "text");
    expect(pointer).toBeTruthy();
    const bytesKey = `seed:${host}:${pointer}`;
    const raw = await kv.get(bytesKey, "text");
    expect(raw).toBeTruthy();
    return { pointer: pointer!, bytesKey, payload: JSON.parse(raw!) as Record<string, unknown> };
  };

  const publishMcpGatewayWorld = async (shard: string): Promise<{ pointer: string; bytesKey: string; payload: Record<string, unknown> }> => {
    const request = await signInternalRequest(env, new Request("https://woo.internal/__internal/mcp-gateway-world", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-woo-host-key": "world"
      },
      body: JSON.stringify({ shard })
    }));
    const response = await wooNamespace.get({ name: "world" }).fetch(request);
    if (!response.ok) throw new Error(`mcp gateway snapshot publish failed: ${response.status} ${await response.text()}`);
    await drain("world");
    const pointer = await kv.get("mcp-gateway-world-current", "text");
    expect(pointer).toBeTruthy();
    const bytesKey = `mcp-gateway-world:${pointer}`;
    const raw = await kv.get(bytesKey, "text");
    expect(raw).toBeTruthy();
    return { pointer: pointer!, bytesKey, payload: JSON.parse(raw!) as Record<string, unknown> };
  };

  const close = (): void => {
    directoryState.close();
    for (const state of wooStates.values()) state.close();
  };

  return { env, kv, wooNamespace, wooObjects, hostSeedFetches, mcpGatewayWorldFetches, drain, publishHostSeed, publishMcpGatewayWorld, close };
}

describe("v2 Worker fan-out helpers", () => {
  it("preserves multiple envelopes for the same recipient node", () => {
    const grouped = v2FanoutEnvelopesByNode([
      { node: "browser-a", envelope: "event-1" },
      { node: "browser-b", envelope: "event-2" },
      { node: "browser-a", envelope: "event-3" }
    ]);

    expect(grouped.get("browser-a")).toEqual(["event-1", "event-3"]);
    expect(grouped.get("browser-b")).toEqual(["event-2"]);
  });

  it("supplements live browser fan-out from gateway sockets when commit-scope memory lacks peer nodes", async () => {
    class SocketState extends FakeDurableObjectState {
      override getWebSockets(): WebSocket[] {
        return this.acceptedWebSockets;
      }
    }
    class FakeWebSocket {
      readonly sent: string[] = [];
      constructor(private readonly attachment: Record<string, unknown>) {}
      send(data: string): void { this.sent.push(data); }
      deserializeAttachment(): unknown { return this.attachment; }
    }

    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new SocketState("world");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    let gateway: PersistentObjectDO;
    const env = {
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: new FakeDurableObjectNamespace((name) => {
        if (name === "world") return gateway;
        throw new Error(`unexpected Woo DO ${name}`);
      })
    } as unknown as Env;
    gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);

    try {
      const world = createWorld();
      const alice = world.auth("guest:v2-live-alice");
      const bob = world.auth("guest:v2-live-bob");
      const aliceWs = new FakeWebSocket({
        protocol: "v2-turn-network",
        sessionId: alice.id,
        actor: alice.actor,
        socketId: "socket-alice",
        node: "browser:alice",
        scope: "the_chatroom",
        token: "guest:v2-live-alice"
      });
      const bobWs = new FakeWebSocket({
        protocol: "v2-turn-network",
        sessionId: bob.id,
        actor: bob.actor,
        socketId: "socket-bob",
        node: "browser:bob",
        scope: "the_chatroom",
        token: "guest:v2-live-bob"
      });
      gatewayState.acceptedWebSockets.push(aliceWs as unknown as WebSocket, bobWs as unknown as WebSocket);

      const transcript = {
        kind: "woo.effect_transcript.shadow.v1",
        route: "direct",
        scope: "the_chatroom",
        seq: -1,
        session: alice.id,
        call: { actor: alice.actor, target: "the_chatroom", verb: "say", args: ["hello bob"] },
        reads: [],
        writes: [],
        creates: [],
        moves: [],
        observations: [{ type: "said", source: "the_chatroom", actor: alice.actor, text: "hello bob", ts: 1 }],
        logicalInputs: [],
        untrackedEffects: [],
        result: true,
        complete: true,
        incompleteReasons: [],
        hash: "live-chat-transcript"
      };
      const reply = encodeEnvelope({
        v: 2,
        type: "woo.turn.exec.reply.shadow.v1",
        id: "reply-live-chat",
        from: "node:commit-scope:the_chatroom",
        to: "browser:alice",
        actor: alice.actor,
        session: alice.id,
        auth: { mode: "session", token: "guest:v2-live-alice" },
        body: {
          kind: "woo.turn.exec.reply.shadow.v1",
          ok: true,
          id: "turn-live-chat",
          outcome: { result: true },
          transcript
        }
      } as any);

      await (gateway as unknown as {
        deliverV2Fanout(
          world: WooWorld,
          scope: ObjRef,
          result: { reply: string | null; fanout: Array<{ node: string; envelope: string }> },
          originSessionId?: string | null,
          originNode?: string | null
        ): Promise<unknown>;
      }).deliverV2Fanout(world, "the_chatroom", { reply, fanout: [] }, alice.id, "browser:alice");

      expect(aliceWs.sent).toHaveLength(0);
      expect(bobWs.sent).toHaveLength(1);
      const delivered = decodeEnvelope(bobWs.sent[0]);
      expect(delivered).toMatchObject({
        type: "woo.live.event.shadow.v1",
        to: "browser:bob",
        body: {
          kind: "woo.live.event.shadow.v1",
          source: "the_chatroom",
          actor: alice.actor,
          observation: { type: "said", text: "hello bob" }
        }
      });
    } finally {
      directoryState.close();
      gatewayState.close();
    }
  });

  it("keeps private live transcript supplemental fan-out actor-scoped", async () => {
    class SocketState extends FakeDurableObjectState {
      override getWebSockets(): WebSocket[] {
        return this.acceptedWebSockets;
      }
    }
    class FakeWebSocket {
      readonly sent: string[] = [];
      constructor(private readonly attachment: Record<string, unknown>) {}
      send(data: string): void { this.sent.push(data); }
      deserializeAttachment(): unknown { return this.attachment; }
    }

    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new SocketState("world");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    let gateway: PersistentObjectDO;
    const env = {
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: new FakeDurableObjectNamespace((name) => {
        if (name === "world") return gateway;
        throw new Error(`unexpected Woo DO ${name}`);
      })
    } as unknown as Env;
    gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);

    try {
      const world = createWorld();
      const alice = world.auth("guest:v2-live-private-alice");
      const bob = world.auth("guest:v2-live-private-bob");
      const aliceOriginWs = new FakeWebSocket({
        protocol: "v2-turn-network",
        sessionId: alice.id,
        actor: alice.actor,
        socketId: "socket-alice-origin",
        node: "browser:alice-origin",
        scope: "the_chatroom",
        token: "guest:v2-live-private-alice"
      });
      const alicePeerWs = new FakeWebSocket({
        protocol: "v2-turn-network",
        sessionId: alice.id,
        actor: alice.actor,
        socketId: "socket-alice-peer",
        node: "browser:alice-peer",
        scope: "the_chatroom",
        token: "guest:v2-live-private-alice"
      });
      const bobWs = new FakeWebSocket({
        protocol: "v2-turn-network",
        sessionId: bob.id,
        actor: bob.actor,
        socketId: "socket-bob",
        node: "browser:bob",
        scope: "the_chatroom",
        token: "guest:v2-live-private-bob"
      });
      gatewayState.acceptedWebSockets.push(aliceOriginWs as unknown as WebSocket, alicePeerWs as unknown as WebSocket, bobWs as unknown as WebSocket);

      const transcript = {
        kind: "woo.effect_transcript.shadow.v1",
        route: "direct",
        scope: "the_chatroom",
        seq: -1,
        session: alice.id,
        call: { actor: alice.actor, target: "the_chatroom", verb: "command_plan", args: ["foo"] },
        reads: [],
        writes: [],
        creates: [],
        moves: [],
        observations: [{
          type: "huh",
          source: "the_chatroom",
          actor: alice.actor,
          text: "I don't understand that.",
          _audience_override: [alice.actor],
          ts: 1
        }],
        logicalInputs: [],
        untrackedEffects: [],
        result: true,
        complete: true,
        incompleteReasons: [],
        hash: "live-private-huh-transcript"
      };
      const reply = encodeEnvelope({
        v: 2,
        type: "woo.turn.exec.reply.shadow.v1",
        id: "reply-live-private-huh",
        from: "node:commit-scope:the_chatroom",
        to: "browser:alice-origin",
        actor: alice.actor,
        session: alice.id,
        auth: { mode: "session", token: "guest:v2-live-private-alice" },
        body: {
          kind: "woo.turn.exec.reply.shadow.v1",
          ok: true,
          id: "turn-live-private-huh",
          outcome: { result: true },
          transcript
        }
      } as any);

      await (gateway as unknown as {
        deliverV2Fanout(
          world: WooWorld,
          scope: ObjRef,
          result: { reply: string | null; fanout: Array<{ node: string; envelope: string }> },
          originSessionId?: string | null,
          originNode?: string | null
        ): Promise<unknown>;
      }).deliverV2Fanout(world, "the_chatroom", { reply, fanout: [] }, alice.id, "browser:alice-origin");

      expect(aliceOriginWs.sent).toHaveLength(0);
      expect(alicePeerWs.sent).toHaveLength(1);
      expect(bobWs.sent).toHaveLength(0);
      const delivered = decodeEnvelope(alicePeerWs.sent[0]);
      expect(delivered).toMatchObject({
        type: "woo.live.event.shadow.v1",
        to: "browser:alice-peer",
        body: {
          kind: "woo.live.event.shadow.v1",
          audience: { actors: [alice.actor] },
          observation: { type: "huh", text: "I don't understand that." }
        }
      });
      expect(((delivered as any).body.observation as Record<string, unknown>)._audience_override).toBeUndefined();
    } finally {
      directoryState.close();
      gatewayState.close();
    }
  });

  it("supplements durable same-scope browser fan-out from gateway sockets when commit-scope memory lacks peer nodes", async () => {
    class SocketState extends FakeDurableObjectState {
      override getWebSockets(): WebSocket[] {
        return this.acceptedWebSockets;
      }
    }
    class FakeWebSocket {
      readonly sent: string[] = [];
      constructor(private readonly attachment: Record<string, unknown>) {}
      send(data: string): void { this.sent.push(data); }
      deserializeAttachment(): unknown { return this.attachment; }
    }

    const gatewayState = new SocketState("world");
    const transferRequests: Array<{ commitScope: string; transferScope: string; node: string }> = [];
    const env = {
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      COMMIT_SCOPE: fakeProjectionCommitScopeNamespace(transferRequests),
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        throw new Error(`unexpected Directory DO ${name}`);
      }),
      WOO: new FakeDurableObjectNamespace((name) => {
        throw new Error(`unexpected Woo DO ${name}`);
      })
    } as unknown as Env;
    const gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);

    try {
      const world = createWorld();
      const alice = world.auth("guest:v2-durable-same-alice");
      const bob = world.auth("guest:v2-durable-same-bob");
      world.sessions.get(alice.id)!.activeScope = "the_chatroom";
      world.sessions.get(bob.id)!.activeScope = "the_chatroom";
      world.setActorPresence(alice.actor, "the_chatroom", true, alice.id);
      world.setSpaceSubscriber("the_chatroom", alice.actor, true, alice.id);
      world.setActorPresence(bob.actor, "the_chatroom", true, bob.id);
      world.setSpaceSubscriber("the_chatroom", bob.actor, true, bob.id);

      const aliceWs = new FakeWebSocket(v2SocketAttachment(alice.id, alice.actor, "browser:durable-same-alice", "the_chatroom"));
      const bobWs = new FakeWebSocket(v2SocketAttachment(bob.id, bob.actor, "browser:durable-same-bob", "the_chatroom"));
      gatewayState.acceptedWebSockets.push(aliceWs as unknown as WebSocket, bobWs as unknown as WebSocket);

      const transcript = durableTranscript("durable-same-note", "the_chatroom", alice.id, alice.actor, [
        { type: "note_added", source: "the_chatroom", board: "the_chatroom", actor: alice.actor, note: { id: "note_1", text: "hello" }, ts: 1 }
      ]);
      const replyEnvelope = durableReplyEnvelope("reply-durable-same", "the_chatroom", "browser:durable-same-alice", alice.id, alice.actor, transcript);

      await (gateway as unknown as {
        sendV2CommitTranscriptFanout(
          world: WooWorld,
          replyEnvelope: unknown,
          alreadyDeliveredNodes: ReadonlySet<string>,
          originNode: string | null
        ): Promise<void>;
      }).sendV2CommitTranscriptFanout(world, replyEnvelope, new Set(), "browser:durable-same-alice");

      expect(aliceWs.sent).toHaveLength(0);
      const bobEvents = bobWs.sent.map((item) => decodeEnvelope(item));
      expect(bobEvents.some((event) => event.type === "woo.state.transfer.shadow.v1")).toBe(true);
      expect(bobEvents).toContainEqual(expect.objectContaining({
        type: "woo.live.event.shadow.v1",
        to: "browser:durable-same-bob",
        body: expect.objectContaining({
          observation: expect.objectContaining({ type: "note_added", note: expect.objectContaining({ id: "note_1" }) })
        })
      }));
      expect(transferRequests).toContainEqual({
        commitScope: "the_chatroom",
        transferScope: "the_chatroom",
        node: "browser:durable-same-bob"
      });
    } finally {
      gatewayState.close();
    }
  });

  it("routes durable movement observations by per-observation audience across affected browser scopes", async () => {
    class SocketState extends FakeDurableObjectState {
      override getWebSockets(): WebSocket[] {
        return this.acceptedWebSockets;
      }
    }
    class FakeWebSocket {
      readonly sent: string[] = [];
      constructor(private readonly attachment: Record<string, unknown>) {}
      send(data: string): void { this.sent.push(data); }
      deserializeAttachment(): unknown { return this.attachment; }
    }

    const gatewayState = new SocketState("world");
    const transferRequests: Array<{ commitScope: string; transferScope: string; node: string }> = [];
    const env = {
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      COMMIT_SCOPE: fakeProjectionCommitScopeNamespace(transferRequests),
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        throw new Error(`unexpected Directory DO ${name}`);
      }),
      WOO: new FakeDurableObjectNamespace((name) => {
        throw new Error(`unexpected Woo DO ${name}`);
      })
    } as unknown as Env;
    const gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);

    try {
      const world = createWorld();
      const alice = world.auth("guest:v2-durable-move-alice");
      const bob = world.auth("guest:v2-durable-move-bob");
      const carol = world.auth("guest:v2-durable-move-carol");
      world.sessions.get(alice.id)!.activeScope = "the_chatroom";
      world.sessions.get(bob.id)!.activeScope = "the_chatroom";
      world.sessions.get(carol.id)!.activeScope = "the_deck";
      world.setActorPresence(alice.actor, "the_chatroom", true, alice.id);
      world.setSpaceSubscriber("the_chatroom", alice.actor, true, alice.id);
      world.setActorPresence(bob.actor, "the_chatroom", true, bob.id);
      world.setSpaceSubscriber("the_chatroom", bob.actor, true, bob.id);
      world.setActorPresence(carol.actor, "the_deck", true, carol.id);
      world.setSpaceSubscriber("the_deck", carol.actor, true, carol.id);

      const aliceWs = new FakeWebSocket(v2SocketAttachment(alice.id, alice.actor, "browser:durable-move-alice", "the_chatroom"));
      const bobWs = new FakeWebSocket(v2SocketAttachment(bob.id, bob.actor, "browser:durable-move-bob", "the_chatroom"));
      const carolWs = new FakeWebSocket(v2SocketAttachment(carol.id, carol.actor, "browser:durable-move-carol", "the_deck"));
      gatewayState.acceptedWebSockets.push(aliceWs as unknown as WebSocket, bobWs as unknown as WebSocket, carolWs as unknown as WebSocket);

      const transcript = {
        ...durableTranscript("durable-cross-scope-move", "the_chatroom", alice.id, alice.actor, [
          { type: "left", source: "the_chatroom", actor: alice.actor, destination: "the_deck", text: "Alice left.", ts: 1 },
          { type: "entered", source: "the_deck", actor: alice.actor, origin: "the_chatroom", text: "Alice entered.", ts: 2 }
        ]),
        moves: [{ object: alice.actor, from: "the_chatroom", to: "the_deck" }]
      };
      const replyEnvelope = durableReplyEnvelope("reply-durable-move", "the_chatroom", "browser:durable-move-alice", alice.id, alice.actor, transcript);

      await (gateway as unknown as {
        sendV2CommitTranscriptFanout(
          world: WooWorld,
          replyEnvelope: unknown,
          alreadyDeliveredNodes: ReadonlySet<string>,
          originNode: string | null
        ): Promise<void>;
      }).sendV2CommitTranscriptFanout(world, replyEnvelope, new Set(), "browser:durable-move-alice");

      expect(aliceWs.sent).toHaveLength(0);
      const bobLive = bobWs.sent.map((item) => decodeEnvelope(item)).filter((event) => event.type === "woo.live.event.shadow.v1");
      const carolLive = carolWs.sent.map((item) => decodeEnvelope(item)).filter((event) => event.type === "woo.live.event.shadow.v1");
      const carolStateTransfers = carolWs.sent.map((item) => decodeEnvelope(item)).filter((event) => event.type === "woo.state.transfer.shadow.v1");
      expect(bobLive.map((event) => (event as any).body.observation.type)).toEqual(["left"]);
      expect(carolLive.map((event) => (event as any).body.observation.type)).toEqual(["entered"]);
      expect(carolStateTransfers).toHaveLength(0);
      expect(transferRequests).toEqual([
        { commitScope: "the_chatroom", transferScope: "the_chatroom", node: "browser:durable-move-bob" }
      ]);
    } finally {
      gatewayState.close();
    }
  });

  it("rejects state transfers whose requested projection scope does not match the authority scope", async () => {
    const secret = "cf-test-secret";
    const state = new FakeDurableObjectState("the_chatroom");
    const target = new CommitScopeDO(state as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: secret });
    try {
      const request = await signInternalRequest({ WOO_INTERNAL_SECRET: secret }, new Request("https://woo.internal/v2/state-transfer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "the_chatroom",
          transfer_scope: "the_deck",
          node: "browser:deck",
          token: "token:deck",
          session: "session:deck",
          actor: "guest_deck",
          sessions: [],
          session_objects: []
        })
      }));
      await expect(target.fetch(request)).rejects.toThrow(/state transfer scope mismatch/);
    } finally {
      state.close();
    }
  });

  it("serves Worker state-transfer fan-out as a patch from the socket's last known head", async () => {
    const secret = "cf-test-secret";
    const state = new FakeDurableObjectState("the_dubspace");
    const target = new CommitScopeDO(state as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: secret });
    try {
      const world = createWorld();
      const session = world.auth("guest:cf-state-patch");
      await world.directCall("cf-state-patch-enter", session.actor, "the_dubspace", "enter", [], { sessionId: session.id });
      const serialized = world.exportWorld();
      const token = "token:cf-state-patch";
      const node = "browser:cf-state-patch";
      const openRequest = await signInternalRequest({ WOO_INTERNAL_SECRET: secret }, new Request("https://woo.internal/v2/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "the_dubspace",
          node,
          token,
          session: session.id,
          actor: session.actor,
          sessions: world.exportSessions(),
          session_objects: world.exportObjects([session.actor]),
          serialized
        })
      }));
      const opened = await target.fetch(openRequest);
      expect(opened.ok).toBe(true);
      const openedPayload = await opened.json() as { head: ShadowScopeHead };

      const localRelay = createShadowBrowserRelayShim({
        node: "cf-state-patch-local-relay",
        scope: "the_dubspace",
        serialized
      });
      const localBrowser = createShadowBrowserNode({
        node,
        scope: "the_dubspace",
        actor: session.actor,
        session: session.id,
        relay: localRelay
      });
      setShadowBrowserSessionToken(localBrowser, token);
      const call: ShadowTurnCall = {
        kind: "woo.turn_call.shadow.v1",
        id: "cf-state-patch-wet",
        route: "sequenced",
        scope: "the_dubspace",
        session: session.id,
        actor: session.actor,
        target: "the_dubspace",
        verb: "set_control",
        args: ["delay_1", "wet", 0.62]
      };
      const planned = await runShadowTurnCall(localRelay.commit_scope.serialized, call);
      const turnRequest = {
        kind: "woo.turn.exec.request.shadow.v1" as const,
        id: call.id,
        call,
        key: shadowTurnKeyFromTranscript(planned.transcript),
        expected: openedPayload.head,
        persistence: "durable" as const
      };
      const envelope = encodeEnvelope(shadowBrowserEnvelope(localBrowser, turnRequest.kind, turnRequest, "cf-state-patch-envelope"));
      const envelopeRequest = await signInternalRequest({ WOO_INTERNAL_SECRET: secret }, new Request("https://woo.internal/v2/envelope", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "the_dubspace",
          node,
          token,
          session: session.id,
          actor: session.actor,
          sessions: world.exportSessions(),
          session_objects: world.exportObjects([session.actor]),
          envelope
        })
      }));
      const envelopeResponse = await target.fetch(envelopeRequest);
      expect(envelopeResponse.ok).toBe(true);
      await expect(envelopeResponse.json()).resolves.toMatchObject({
        reply: expect.any(String),
        head: expect.objectContaining({ seq: openedPayload.head.seq + 1 })
      });

      const transferRequest = await signInternalRequest({ WOO_INTERNAL_SECRET: secret }, new Request("https://woo.internal/v2/state-transfer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "the_dubspace",
          transfer_scope: "the_dubspace",
          node,
          token,
          session: session.id,
          actor: session.actor,
          sessions: world.exportSessions(),
          session_objects: world.exportObjects([session.actor]),
          last_known_head: openedPayload.head
        })
      }));
      const transferResponse = await target.fetch(transferRequest);
      expect(transferResponse.ok).toBe(true);
      const transferPayload = await transferResponse.json() as Record<string, any>;
      expect(transferPayload.transfer).toMatchObject({
        mode: "delta",
        scope: "the_dubspace",
        projection_patch: {
          base: { seq: openedPayload.head.seq },
          to: { seq: openedPayload.head.seq + 1 }
        }
      });
      expect(transferPayload.transfer.projection).toBeUndefined();
      expect(transferPayload.transfer.projection_patch.objects.upsert.map((item: { id: string }) => item.id)).toEqual(["delay_1"]);
    } finally {
      state.close();
    }
  });

  it("does not reserve the removed legacy WebSocket endpoint at the Worker entry", async () => {
    const env = {
      ASSETS: {
        fetch: async (request: Request) => new Response(`asset:${new URL(request.url).pathname}`, { status: 404 })
      },
      WOO: new FakeDurableObjectNamespace((name) => {
        throw new Error(`legacy /ws should not route to Woo DO ${name}`);
      }),
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        throw new Error(`legacy /ws should not route to Directory DO ${name}`);
      })
    } as unknown as Env;

    const response = await worker.fetch(new Request("https://woo.test/ws", {
      headers: { upgrade: "websocket" }
    }), env, {});

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("asset:/ws");
  });
});

function v2SocketAttachment(sessionId: string, actor: ObjRef, node: string, scope: ObjRef): Record<string, unknown> {
  return {
    protocol: "v2-turn-network",
    sessionId,
    actor,
    socketId: `${node}:socket`,
    node,
    scope,
    token: `token:${node}`
  };
}

function durableTranscript(hash: string, scope: ObjRef, session: string, actor: ObjRef, observations: any[]): any {
  return {
    kind: "woo.effect_transcript.shadow.v1",
    route: "sequenced",
    scope,
    seq: 1,
    session,
    call: { actor, target: scope, verb: "test", args: [] },
    reads: [],
    writes: [],
    creates: [],
    moves: [],
    observations,
    logicalInputs: [],
    untrackedEffects: [],
    result: true,
    complete: true,
    incompleteReasons: [],
    hash
  };
}

function durableReplyEnvelope(id: string, scope: ObjRef, to: string, session: string, actor: ObjRef, transcript: any): any {
  const position = {
    kind: "woo.scope_head.shadow.v1",
    scope,
    epoch: 1,
    seq: 1,
    hash: `${id}:head`
  };
  return {
    v: 2,
    type: "woo.turn.exec.reply.shadow.v1",
    id,
    from: `node:commit-scope:${scope}`,
    to,
    actor,
    session,
    auth: { mode: "session", token: `token:${to}` },
    body: {
      kind: "woo.turn.exec.reply.shadow.v1",
      ok: true,
      id: `${id}:turn`,
      outcome: { result: true },
      commit: {
        kind: "woo.commit.accepted.shadow.v1",
        id: `${id}:commit`,
        position,
        ts: 1,
        transcript_hash: transcript.hash,
        post_state_hash: `${id}:post`,
        observations: transcript.observations,
        receipt: {
          kind: "woo.commit_receipt.shadow.v1",
          id: `${id}:receipt`,
          route: transcript.route,
          scope,
          seq: 1,
          transcript_hash: transcript.hash,
          pre_state_hash: `${id}:pre`,
          post_state_hash: `${id}:post`,
          accepted: true,
          errors: []
        }
      },
      transcript
    }
  };
}

function fakeProjectionCommitScopeNamespace(requests: Array<{ commitScope: string; transferScope: string; node: string }>): FakeDurableObjectNamespace {
  return new FakeDurableObjectNamespace((name) => ({
    fetch: async (request: Request) => {
      const body = await request.json() as Record<string, unknown>;
      requests.push({
        commitScope: name,
        transferScope: String(body.transfer_scope ?? ""),
        node: String(body.node ?? "")
      });
      return new Response(JSON.stringify({
        ok: true,
        relay: `node:commit-scope:${name}`,
        transfer: fakeProjectionTransfer(String(body.transfer_scope ?? name), name, String(body.node ?? "browser:test"))
      }), { headers: { "content-type": "application/json" } });
    }
  }));
}

function fakeProjectionTransfer(scope: string, headScope: string, recipient: string): any {
  const to = {
    kind: "woo.scope_head.shadow.v1",
    scope: headScope,
    epoch: 1,
    seq: 1,
    hash: `${headScope}:head`
  };
  return {
    kind: "woo.state.transfer.shadow.v1",
    mode: "projection",
    scope,
    to,
    projection: {
      kind: "woo.scope_projection.shadow.v1",
      scope,
      title: scope,
      object_count: 0,
      contents: [],
      seq: 1,
      cursor: { spaces: {}, live: { resumable: false } },
      inventory: [],
      subject: null,
      objects: []
    },
    proof: {
      kind: "woo.state_proof.shadow.v1",
      scheme: "shadow.relay_mac.v1",
      authority: "test",
      key_id: "test",
      recipient,
      scope,
      mode: "projection",
      head: to,
      root: "test",
      signature: "test"
    }
  };
}

function sqlRows<T>(cursor: { toArray(): Record<string, unknown>[] }): T[] {
  return cursor.toArray() as T[];
}

type Harness = {
  world: WooWorld;
  restart: () => WooWorld;
  cleanup: () => void;
};

function makeCfHarness(): Harness {
  const state = new FakeDurableObjectState();
  let repo = new CFObjectRepository(state as unknown as DurableObjectState);
  let world = createWorld({ repository: repo });
  return {
    get world() {
      return world;
    },
    restart: () => {
      repo = new CFObjectRepository(state as unknown as DurableObjectState);
      world = createWorld({ repository: repo });
      return world;
    },
    cleanup: () => state.close()
  };
}

function fakeCommitScopeNamespace(
  secret = "cf-test-secret",
  record?: (scope: string, path: string, body: unknown) => Response | void | Promise<Response | void>
): DurableObjectNamespace {
  const states = new Map<string, FakeDurableObjectState>();
  return new FakeDurableObjectNamespace((name) => {
    let state = states.get(name);
    if (!state) {
      state = new FakeDurableObjectState(name);
      states.set(name, state);
    }
    const target = new CommitScopeDO(state as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: secret });
    return {
      fetch: async (request: Request): Promise<Response> => {
        if (record) {
          let body: unknown = null;
          try {
            body = await request.clone().json();
          } catch {
            body = null;
          }
          const override = await record(name, new URL(request.url).pathname, body);
          if (override) return override;
        }
        return await target.fetch(request);
      }
    };
  }) as unknown as DurableObjectNamespace;
}

function message(actor: string, target: string, verb: string, args: WooValue[] = []): Message {
  return { actor, target, verb, args };
}

async function callInDubspace(
  world: ReturnType<typeof createWorld>,
  sessionId: string,
  requestId: string,
  request: Message
): Promise<ReturnType<typeof world.call>> {
  const sessionActor = world.sessions.get(sessionId)?.actor;
  if (sessionActor === request.actor && !world.hasPresence(sessionActor, "the_dubspace")) {
    const entered = await world.directCall(`enter-${requestId}`, sessionActor, "the_dubspace", "enter", []);
    if (entered.op === "error") return entered;
  }
  return world.call(requestId, sessionId, "the_dubspace", request);
}

function bytecodeVerb(name: string, bytecode: TinyBytecode): VerbDef {
  return {
    kind: "bytecode",
    name,
    aliases: [],
    owner: "$wiz",
    perms: "rxd",
    arg_spec: {},
    source: `cf conformance ${name}`,
    source_hash: `cf-conformance-${name}`,
    version: 1,
    line_map: {},
    bytecode
  };
}

function installFailureFixture(world: WooWorld): void {
  world.addVerb(
    "delay_1",
    bytecodeVerb("cf_mutate_then_fail", {
      literals: ["cf_failed_value", "E_CF_FAIL"],
      num_locals: 0,
      max_stack: 3,
      version: 1,
      ops: [["PUSH_THIS"], ["PUSH_LIT", 0], ["PUSH_ARG", 0], ["SET_PROP"], ["PUSH_LIT", 1], ["RAISE"], ["PUSH_INT", 0], ["RETURN"]]
    })
  );
}

class FakeExecutorContext implements ExecutorContext {
  constructor(
    readonly localHost: string,
    private readonly worlds: Map<string, WooWorld>,
    private readonly routes: Map<ObjRef, string>
  ) {}

  hostForObject(id: ObjRef): string | null {
    return this.routes.get(id) ?? null;
  }

  async getPropChecked(progr: ObjRef, objRef: ObjRef, name: string): Promise<WooValue> {
    return await this.worldFor(objRef).getPropChecked(progr, objRef, name);
  }

  async setPropChecked(progr: ObjRef, objRef: ObjRef, name: string, value: WooValue): Promise<void> {
    await this.worldFor(objRef).setPropChecked(progr, objRef, name, value);
  }

  async objectSummary(readActor: ObjRef, objRef: ObjRef): Promise<ScopedObjectSummary> {
    return await this.worldFor(objRef).scopedObjectSummary(readActor, objRef);
  }

  async objectSummaries(readActor: ObjRef, objRefs: ObjRef[]): Promise<Record<ObjRef, ScopedObjectSummary>> {
    const out: Record<ObjRef, ScopedObjectSummary> = {};
    for (const objRef of objRefs) out[objRef] = await this.objectSummary(readActor, objRef);
    return out;
  }

  async roomSnapshot(readActor: ObjRef, room: ObjRef, sessionId?: string | null): Promise<RoomSnapshot> {
    return await this.worldFor(room).roomSnapshotForActor(readActor, room, sessionId ?? null);
  }

  async describeObject(_nameActor: ObjRef, readActor: ObjRef, objRef: ObjRef): Promise<HostObjectSummary> {
    const world = this.worldFor(objRef);
    return {
      name: world.object(objRef).name,
      description: world.propOrNullForActor(readActor, objRef, "description"),
      aliases: world.propOrNullForActor(readActor, objRef, "aliases"),
      owner: world.object(objRef).owner,
      obvious_verbs: world.obviousCommandSyntaxes(objRef, world.object(objRef).name || objRef)
    };
  }

  async resolveVerb(target: ObjRef, verbName: string): Promise<{ name: string; direct_callable: boolean; arg_spec: Record<string, WooValue> } | null> {
    const world = this.worldFor(target);
    try {
      const { verb } = world.resolveVerb(target, verbName);
      return { name: verb.name, direct_callable: verb.direct_callable === true, arg_spec: verb.arg_spec ?? {} };
    } catch {
      return null;
    }
  }

  async commandVerbCandidates(target: ObjRef, verbName: string): Promise<Array<{ name: string; direct_callable: boolean; arg_spec?: Record<string, WooValue> }>> {
    return this.worldFor(target).commandVerbCandidateSummaries(target, verbName);
  }

  async location(objRef: ObjRef): Promise<ObjRef | null> {
    return this.worldFor(objRef).object(objRef).location;
  }

  async isDescendantOf(objRef: ObjRef, ancestorRef: ObjRef): Promise<boolean> {
    return await this.worldFor(objRef).isDescendantOfChecked(objRef, ancestorRef);
  }

  async dispatch(ctx: CallContext, target: ObjRef, verbName: string, args: WooValue[], startAt?: ObjRef | null): Promise<WooValue> {
    const remote = this.worldFor(startAt ?? target);
    return await remote.hostDispatch({ ...ctx, world: remote }, target, verbName, args, startAt);
  }

  async moveObject(objRef: ObjRef, targetRef: ObjRef): Promise<MoveObjectResult> {
    return await this.worldFor(objRef).moveObjectChecked(objRef, targetRef, { suppressMirrorHost: this.localHost });
  }

  async mirrorContents(containerRef: ObjRef, objRef: ObjRef, present: boolean): Promise<void> {
    this.worldFor(containerRef).mirrorContents(containerRef, objRef, present);
  }

  async setActorPresence(actor: ObjRef, space: ObjRef, present: boolean, sessionId?: string): Promise<void> {
    this.worldFor(actor).setActorPresence(actor, space, present, sessionId);
  }

  async setSpaceSubscriber(space: ObjRef, actor: ObjRef, present: boolean, sessionId?: string): Promise<void> {
    this.worldFor(space).setSpaceSubscriber(space, actor, present, sessionId);
  }

  async spaceAudienceSessions(space: ObjRef, actors?: ObjRef[]): Promise<string[]> {
    return this.worldFor(space).presenceSessionIdsIn(space, actors);
  }

  async actorSessionLocations(actor: ObjRef): Promise<ObjRef[]> {
    return this.worldFor(actor).allLocationsForActor(actor);
  }

  async contents(objRef: ObjRef): Promise<ObjRef[]> {
    return this.worldFor(objRef).contentsOf(objRef);
  }

  private worldFor(id: ObjRef): WooWorld {
    const host = this.routes.get(id);
    if (!host) throw new Error(`no route for ${id}`);
    const world = this.worlds.get(host);
    if (!world) throw new Error(`no world for ${host}`);
    return world;
  }
}

describe("CFObjectRepository production-shape coverage", () => {
  it("reserves the v2 session mint endpoint with shadow-local claims", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-v2-mint-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: new FakeDurableObjectNamespace((name) => {
        throw new Error(`unexpected Woo DO ${name}`);
      })
    } as unknown as Env;
    const gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);

    try {
      const response = await gateway.fetch(new Request("https://woo.test/v2/session/mint", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "wizard:cf-v2-mint-token" })
      }));

      expect(response.status).toBe(200);
      const body = await response.json() as { token: string; claims: Record<string, unknown> };
      expect(body.token).toMatch(/^shadow-session:/);
      expect(body.claims).toMatchObject({
        actor: "$wiz",
        deployment: "shadow-local",
        rev: 1
      });
    } finally {
      directoryState.close();
      gatewayState.close();
    }
  });

  it("accepts authenticated browser activity metric batches", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-browser-metrics-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: new FakeDurableObjectNamespace((name) => {
        throw new Error(`unexpected Woo DO ${name}`);
      })
    } as unknown as Env;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((label: unknown, payload: unknown) => {
      if (label === "woo.metric" && typeof payload === "string") logs.push(payload);
    });
    const gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);

    try {
      const auth = await gateway.fetch(new Request("https://woo.test/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "wizard:cf-browser-metrics-token" })
      }));
      expect(auth.ok).toBe(true);
      const authBody = await auth.json() as { session: string };
      const response = await gateway.fetch(new Request("https://woo.test/api/browser-metrics", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Session ${authBody.session}`
        },
        body: JSON.stringify({
          metrics: [
            {
              kind: "browser_activity",
              source: "v2_browser_worker",
              phase: "idb_tx",
              path: "indexeddb",
              method: "readwrite",
              what: "state_pages",
              scope: "the_outliner",
              node: "browser:metric-test",
              actor: "spoofed_actor",
              ms: 14,
              bytes: 2048,
              status: "ok"
            }
          ]
        })
      }));

      expect(response.ok).toBe(true);
      expect(await response.json()).toMatchObject({ ok: true, accepted: 1 });
      const metrics = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(metrics).toContainEqual(expect.objectContaining({
        kind: "browser_activity",
        source: "v2_browser_worker",
        phase: "idb_tx",
        path: "indexeddb",
        what: "state_pages",
        scope: "the_outliner",
        node: "browser:metric-test",
        actor: "$wiz",
        bytes: 2048,
        host_key: "browser"
      }));
    } finally {
      logSpy.mockRestore();
      directoryState.close();
      gatewayState.close();
    }
  });

  it("samples browser activity metrics when one session exceeds the per-window budget", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const analyticsCalls: Array<{ indexes?: string[]; blobs?: string[]; doubles?: number[] }> = [];
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-browser-metrics-sampling-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      METRICS: { writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }) { analyticsCalls.push(point); } },
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: new FakeDurableObjectNamespace((name) => {
        throw new Error(`unexpected Woo DO ${name}`);
      })
    } as unknown as Env;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);

    try {
      const auth = await gateway.fetch(new Request("https://woo.test/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "wizard:cf-browser-metrics-sampling-token" })
      }));
      expect(auth.ok).toBe(true);
      const authBody = await auth.json() as { session: string };
      const metricStart = analyticsCalls.length;
      const response = await gateway.fetch(new Request("https://woo.test/api/browser-metrics", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Session ${authBody.session}`
        },
        body: JSON.stringify({
          metrics: Array.from({ length: 70 }, (_, index) => ({
            kind: "browser_activity",
            source: "v2_browser_worker",
            phase: "frame_process",
            path: "live",
            scope: "the_outliner",
            node: "browser:metric-sampling-test",
            ms: index,
            status: "ok"
          }))
        })
      }));

      expect(response.ok).toBe(true);
      expect(await response.json()).toMatchObject({ ok: true, accepted: 61, sampled: 9 });
      const browserMetricWrites = analyticsCalls.slice(metricStart).filter((point) => point.blobs?.[0] === "browser_activity");
      expect(browserMetricWrites).toHaveLength(61);
    } finally {
      logSpy.mockRestore();
      directoryState.close();
      gatewayState.close();
    }
  });

  it("rejects v2 WebSocket upgrades without the required subprotocol", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-v2-subprotocol-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: new FakeDurableObjectNamespace((name) => {
        throw new Error(`unexpected Woo DO ${name}`);
      })
    } as unknown as Env;
    const gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);

    try {
      const response = await gateway.fetch(new Request("https://woo.test/v2/turn-network/ws?token=wizard:cf-v2-subprotocol-token", {
        headers: { upgrade: "websocket" }
      }));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "E_PROTOCOL" }
      });
    } finally {
      directoryState.close();
      gatewayState.close();
    }
  });

  it("accepts a v2 WebSocket upgrade and sends TransportHello first", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");
    const commitStates = new Map<string, FakeDurableObjectState>();
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const sent: string[] = [];
    class FakeServerWebSocket {
      attachment: unknown;
      readonly sent = sent;

      serializeAttachment(value: unknown): void {
        this.attachment = value;
      }

      send(data: string): void {
        this.sent.push(data);
      }

      close(): void {}
    }
    class FakeWebSocketPair {
      readonly 0 = {} as WebSocket;
      readonly 1 = new FakeServerWebSocket() as unknown as WebSocket;
    }
    class CloudflareUpgradeResponse {
      readonly body: BodyInit | null;
      readonly headers: Headers;
      readonly status: number;
      readonly statusText: string;
      readonly webSocket?: WebSocket;

      constructor(body: BodyInit | null = null, init: (ResponseInit & { webSocket?: WebSocket }) = {}) {
        this.body = body;
        this.headers = new Headers(init.headers);
        this.status = init.status ?? 200;
        this.statusText = init.statusText ?? "";
        this.webSocket = init.webSocket;
      }

      get ok(): boolean {
        return this.status >= 200 && this.status < 300;
      }

      async text(): Promise<string> {
        if (typeof this.body === "string") return this.body;
        if (this.body == null) return "";
        if (this.body instanceof ArrayBuffer) return new TextDecoder().decode(this.body);
        return String(this.body);
      }

      async json(): Promise<unknown> {
        return JSON.parse(await this.text());
      }
    }
    const previousPair = (globalThis as unknown as { WebSocketPair?: unknown }).WebSocketPair;
    const previousResponse = globalThis.Response;
    vi.stubGlobal("WebSocketPair", FakeWebSocketPair);
    vi.stubGlobal("Response", CloudflareUpgradeResponse);
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-v2-upgrade-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: new FakeDurableObjectNamespace((name) => {
        throw new Error(`unexpected Woo DO ${name}`);
      }),
      COMMIT_SCOPE: new FakeDurableObjectNamespace((name) => {
        let state = commitStates.get(name);
        if (!state) {
          state = new FakeDurableObjectState(name);
          commitStates.set(name, state);
        }
        return new CommitScopeDO(state as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
      })
    } as unknown as Env;
    const gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);

    try {
      const response = await gateway.fetch(new Request("https://woo.test/v2/turn-network/ws?token=wizard:cf-v2-upgrade-token&node=browser:upgrade-test", {
        headers: {
          upgrade: "websocket",
          "sec-websocket-protocol": "woo-v2.turn-network.json"
        }
      }));

      expect(response.status).toBe(101);
      expect(response.headers.get("sec-websocket-protocol")).toBe("woo-v2.turn-network.json");
      expect(gatewayState.acceptedWebSockets).toHaveLength(1);
      expect(sent).toHaveLength(4);
      expect(decodeEnvelope(sent[0])).toMatchObject({
        type: "woo.transport.hello.v1",
        to: "browser:upgrade-test",
        body: { kind: "woo.transport.hello.v1", actor: "$wiz" }
      });
      expect(decodeEnvelope(sent[1])).toMatchObject({
        type: "woo.state.transfer.shadow.v1",
        to: "browser:upgrade-test",
        body: {
          kind: "woo.state.transfer.shadow.v1",
          mode: "projection",
          scope: "$wiz"
        }
      });
      expect(decodeEnvelope(sent[2])).toMatchObject({
        type: "woo.state.transfer.shadow.v1",
        to: "browser:upgrade-test",
        body: {
          kind: "woo.state.transfer.shadow.v1",
          mode: "cell_pages",
          scope: "$wiz"
        }
      });
      expect(decodeEnvelope(sent[3])).toMatchObject({
        type: "woo.exec_capability_ad.shadow.v1",
        to: "browser:upgrade-test",
        auth: { mode: "anonymous_advisory" },
        body: {
          kind: "woo.exec_capability_ad.shadow.v1",
          node: "node:commit-scope:$wiz:executor",
          scope: "$wiz"
        }
      });
    } finally {
      if (previousPair === undefined) {
        Reflect.deleteProperty(globalThis as unknown as { WebSocketPair?: unknown }, "WebSocketPair");
      } else {
        vi.stubGlobal("WebSocketPair", previousPair);
      }
      vi.stubGlobal("Response", previousResponse);
      directoryState.close();
      gatewayState.close();
      for (const state of commitStates.values()) state.close();
    }
  });

  it("handles v2 turn requests through the Worker WebSocket message path", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");
    const commitStates = new Map<string, FakeDurableObjectState>();
    const envelopeBodies: Array<Record<string, unknown>> = [];
    const mcpFanoutHosts: string[] = [];
    const logs: string[] = [];
    const consoleLog = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    let gateway: PersistentObjectDO;
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-v2-message-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: new FakeDurableObjectNamespace((name) => {
        if (name.startsWith("mcp-gateway-")) {
          return {
            async fetch(request: Request): Promise<Response> {
              if (new URL(request.url).pathname === "/__internal/mcp-commit-fanout") mcpFanoutHosts.push(name);
              return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { "content-type": "application/json; charset=utf-8" }
              });
            }
          };
        }
        if (name === "world") return gateway;
        throw new Error(`unexpected Woo DO ${name}`);
      }),
      COMMIT_SCOPE: new FakeDurableObjectNamespace((name) => {
        let state = commitStates.get(name);
        if (!state) {
          state = new FakeDurableObjectState(name);
          commitStates.set(name, state);
        }
        const scope = new CommitScopeDO(state as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
        return {
          async fetch(request: Request): Promise<Response> {
            if (new URL(request.url).pathname === "/v2/envelope") {
              envelopeBodies.push(await request.clone().json() as Record<string, unknown>);
            }
            return await scope.fetch(request);
          }
        };
      })
    } as unknown as Env;
    gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);
    const internals = gateway as unknown as {
      webSocketV2TurnNetworkMessage: (world: WooWorld, ws: WebSocket, message: string | ArrayBuffer) => Promise<void>;
    };
    class FakeWebSocket {
      readonly sent: string[] = [];
      send(data: string): void { this.sent.push(data); }
      close(): void {}
      deserializeAttachment(): unknown {
        return {
          protocol: "v2-turn-network",
          sessionId: session.id,
          actor: session.actor,
          socketId: "v2-message-socket",
          node: "browser:worker-test",
          scope: "#-1",
          token: "guest:cf-v2-message"
        };
      }
    }
    let session: ReturnType<WooWorld["auth"]>;

    try {
      const world = createWorld();
      session = world.auth("guest:cf-v2-message");
      const registerMcpShard = await signInternalRequest(env, new Request("https://woo.internal/register-session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: "mcp-websocket-observer",
          actor: session.actor,
          expires_at: Date.now() + 60_000,
          token_class: "guest",
          active_scope: "#-1",
          current_location: "#-1",
          mcp_shard: "mcp-gateway-0"
        })
      }));
      expect(await env.DIRECTORY.get(env.DIRECTORY.idFromName("directory")).fetch(registerMcpShard).then((response) => response.ok)).toBe(true);
      world.createObject({ id: "cf_v2_message_box", name: "Worker V2 Box", parent: "$thing", owner: session.actor });
      world.defineProperty("cf_v2_message_box", { name: "value", defaultValue: 0, owner: session.actor, perms: "rw", typeHint: "int" });
      expect(installVerb(world, "cf_v2_message_box", "set_value", `verb :set_value(value) rxd {
        this.value = value;
        return this.value;
      }`, null).ok).toBe(true);
      const relay = createShadowBrowserRelayShim({
        node: "node:commit-scope:#-1",
        scope: "#-1",
        serialized: world.exportWorld()
      });
      const browser = createShadowBrowserNode({
        node: "browser:worker-test",
        scope: "#-1",
        actor: session.actor,
        session: session.id,
        relay
      });
      setShadowBrowserSessionToken(browser, "guest:cf-v2-message");
      await openShadowBrowserScope(browser, { preseed_catalog_pages: true });
      const call: ShadowTurnCall = {
        kind: "woo.turn_call.shadow.v1",
        id: "cf-v2-message-value",
        route: "direct",
        scope: "#-1",
        session: session.id,
        actor: session.actor,
        target: "cf_v2_message_box",
        verb: "set_value",
        args: [67]
      };
      const planned = await runShadowTurnCall(browser.relay.commit_scope.serialized, call);
      const request = {
        kind: "woo.turn.exec.request.shadow.v1" as const,
        id: call.id,
        call,
        key: shadowTurnKeyFromTranscript(planned.transcript),
        expected: browser.relay.commit_scope.head,
        persistence: "durable" as const
      };
      const encoded = encodeEnvelope(shadowBrowserEnvelope(browser, request.kind, request, "cf-v2-message-env"));
      const ws = new FakeWebSocket();
      const openRequest = await signInternalRequest(env, new Request("https://woo.internal/v2/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "#-1",
          node: "browser:worker-test",
          token: "guest:cf-v2-message",
          session: session.id,
          actor: session.actor,
          sessions: world.exportSessions(),
          serialized: world.exportWorld()
        })
      }));
      const commitScope = env.COMMIT_SCOPE;
      if (!commitScope) throw new Error("test env missing COMMIT_SCOPE");
      const opened = await commitScope.get(commitScope.idFromName("#-1")).fetch(openRequest);
      expect(opened.ok).toBe(true);
      const openedPayload = await opened.json() as Record<string, any>;
      expect(openedPayload.transfer).toMatchObject({ mode: "projection", scope: "#-1" });

      await internals.webSocketV2TurnNetworkMessage(world, ws as unknown as WebSocket, encoded);

      const replies = ws.sent.map((frame) => JSON.parse(frame) as Record<string, any>);
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({ type: "woo.turn.exec.reply.shadow.v1", reply_to: "cf-v2-message-env" });
      expect(replies[0].body).toMatchObject({ ok: true, id: "cf-v2-message-value" });
      expect(replies[0].body.commit.serialized_after).toBeUndefined();
      expect(envelopeBodies[0]?.sessions).toEqual(expect.arrayContaining([expect.objectContaining({ id: session.id, actor: session.actor })]));
      expect(envelopeBodies[0]).not.toHaveProperty("serialized");
      const scopeState = commitStates.get("#-1");
      expect(scopeState).toBeDefined();
      expect(sqlRows(scopeState!.storage.sql.exec("SELECT scope FROM v2_commit_scope_meta"))).toEqual([{ scope: "#-1" }]);
      expect(sqlRows(scopeState!.storage.sql.exec("SELECT seq FROM v2_commit_scope_accepted_frame"))).toEqual([{ seq: 1 }]);
      const acceptedRows = sqlRows<{ body: string }>(scopeState!.storage.sql.exec("SELECT body FROM v2_commit_scope_accepted_frame"));
      expect(JSON.parse(acceptedRows[0].body)).not.toHaveProperty("serialized_after");
      expect(sqlRows(scopeState!.storage.sql.exec("SELECT COUNT(*) AS n FROM v2_commit_scope_transcript_tail"))[0]).toMatchObject({ n: 1 });
      expect(sqlRows(scopeState!.storage.sql.exec("SELECT COUNT(*) AS n FROM v2_commit_scope_reply"))[0]).toMatchObject({ n: 1 });
      expect(mcpFanoutHosts).toEqual(["mcp-gateway-0"]);
      const metrics = logs
        .filter((line) => line.startsWith("woo.metric "))
        .map((line) => JSON.parse(line.slice("woo.metric ".length)) as Record<string, unknown>);
      expect(metrics).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "do_constructor", class: "PersistentObjectDO", host_key: "world" }),
        expect.objectContaining({ kind: "do_constructor", class: "CommitScopeDO", host_key: "#-1" }),
        expect.objectContaining({ kind: "do_handler", class: "CommitScopeDO", route: "/v2/open", status: "ok", host_key: "#-1" }),
        expect.objectContaining({ kind: "do_handler", class: "CommitScopeDO", route: "/v2/envelope", status: "ok", host_key: "#-1" }),
        expect.objectContaining({ kind: "shadow_apply_step", phase: "apply_writes", scope: "#-1", route: "direct", host_key: "#-1" }),
        expect.objectContaining({ kind: "shadow_apply_step", phase: "total", scope: "#-1", route: "direct", host_key: "#-1" }),
        expect.objectContaining({ kind: "v2_open", scope: "#-1", node: "browser:worker-test", status: "ok", host_key: "#-1" }),
        expect.objectContaining({ kind: "v2_envelope", scope: "#-1", node: "browser:worker-test", status: "ok", reply: "accepted", fanout: 0, host_key: "#-1" }),
        expect.objectContaining({ kind: "shadow_commit_accepted", scope: "#-1", seq: 1, node: "browser:worker-test", host_key: "#-1" })
      ]));
      const applySteps = metrics.filter((metric) => metric.kind === "shadow_apply_step" && metric.scope === "#-1");
      const phaseIndex = (phase: string) => applySteps.findIndex((metric) => metric.phase === phase);
      const applyWrites = applySteps[phaseIndex("apply_writes")];
      const total = applySteps[phaseIndex("total")];
      expect(applyWrites).toBeDefined();
      expect(total).toBeDefined();
      expect(typeof applyWrites?.ms).toBe("number");
      expect(typeof total?.ms).toBe("number");
      expect(applyWrites?.ms).toBeGreaterThanOrEqual(0);
      expect(total?.ms).toBeGreaterThanOrEqual(applyWrites?.ms as number);
      expect(phaseIndex("clone_world")).toBe(-1);
      expect(phaseIndex("index_objects")).toBe(-1);
      expect(phaseIndex("sort_objects")).toBe(-1);
      expect(phaseIndex("apply_writes")).toBeGreaterThanOrEqual(0);
      expect(phaseIndex("total")).toBeGreaterThan(phaseIndex("apply_writes"));
      const catchupRequest = await signInternalRequest(env, new Request("https://woo.internal/v2/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "#-1",
          node: "browser:worker-reconnect",
          token: "guest:cf-v2-message",
          session: session.id,
          actor: session.actor,
          sessions: world.exportSessions(),
          session_objects: world.exportObjects([session.actor]),
          serialized: world.exportWorld(),
          last_known_head: openedPayload.head
        })
      }));
      const caughtUp = await commitScope.get(commitScope.idFromName("#-1")).fetch(catchupRequest);
      expect(caughtUp.ok).toBe(true);
      await expect(caughtUp.json()).resolves.toMatchObject({
        transfer: {
          mode: "delta",
          scope: "#-1",
          applied: [expect.objectContaining({ position: expect.objectContaining({ seq: 1 }) })],
          transcript_tail: [expect.objectContaining({ scope: "#-1" })]
        }
      });

      const writesBeforeReplay = scopeState!.storage.sql.execLog.filter((entry) => /^(INSERT|DELETE|UPDATE)\b/i.test(entry.query.trim())).length;
      await internals.webSocketV2TurnNetworkMessage(world, ws as unknown as WebSocket, encoded);
      const replayed = ws.sent.map((frame) => JSON.parse(frame) as Record<string, any>);
      expect(replayed).toHaveLength(2);
      expect(replayed[1].body).toEqual(replayed[0].body);
      const writesAfterReplay = scopeState!.storage.sql.execLog.filter((entry) => /^(INSERT|DELETE|UPDATE)\b/i.test(entry.query.trim())).length;
      expect(writesAfterReplay).toBe(writesBeforeReplay);
    } finally {
      directoryState.close();
      gatewayState.close();
      for (const state of commitStates.values()) state.close();
      consoleLog.mockRestore();
    }
  });

  it("applies committed v2 transcripts back into the Worker gateway world", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");
    const commitStates = new Map<string, FakeDurableObjectState>();
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-v2-session-location-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: new FakeDurableObjectNamespace((name) => ({
        fetch: async (request: Request): Promise<Response> => {
          if (new URL(request.url).pathname === "/__internal/apply-v2-commit") {
            return new Response(JSON.stringify({ ok: true, host: name, objects: 0, properties: 0, logs: 0, sessions: 0, creates: 0, writes: 0 }), {
              headers: { "content-type": "application/json" }
            });
          }
          throw new Error(`unexpected Woo DO ${name}`);
        }
      })),
      COMMIT_SCOPE: new FakeDurableObjectNamespace((name) => {
        let state = commitStates.get(name);
        if (!state) {
          state = new FakeDurableObjectState(name);
          commitStates.set(name, state);
        }
        return new CommitScopeDO(state as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
      })
    } as unknown as Env;
    const gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);
    const internals = gateway as unknown as {
      webSocketV2TurnNetworkMessage: (world: WooWorld, ws: WebSocket, message: string | ArrayBuffer) => Promise<void>;
    };
    class FakeWebSocket {
      readonly sent: string[] = [];
      send(data: string): void { this.sent.push(data); }
      close(): void {}
      deserializeAttachment(): unknown {
        return {
          protocol: "v2-turn-network",
          sessionId: session.id,
          actor: session.actor,
          socketId: "v2-session-location-socket",
          node: "browser:session-location-test",
          scope: "the_chatroom",
          token: "guest:cf-v2-session-location"
        };
      }
    }
    let session: ReturnType<WooWorld["auth"]>;

    try {
      const world = createWorld();
      session = world.auth("guest:cf-v2-session-location");

      const relay = createShadowBrowserRelayShim({
        node: "node:commit-scope:the_chatroom",
        scope: "the_chatroom",
        serialized: world.exportWorld()
      });
      const browser = createShadowBrowserNode({
        node: "browser:session-location-test",
        scope: "the_chatroom",
        actor: session.actor,
        session: session.id,
        relay
      });
      setShadowBrowserSessionToken(browser, "guest:cf-v2-session-location");
      await openShadowBrowserScope(browser, { preseed_catalog_pages: true });
      const call: ShadowTurnCall = {
        kind: "woo.turn_call.shadow.v1",
        id: "cf-v2-session-location-move",
        route: "direct",
        scope: "the_chatroom",
        session: session.id,
        actor: session.actor,
        target: "the_chatroom",
        verb: "southeast",
        args: []
      };
      const planned = await runShadowTurnCall(browser.relay.commit_scope.serialized, call);
      const request = {
        kind: "woo.turn.exec.request.shadow.v1" as const,
        id: call.id,
        call,
        key: shadowTurnKeyFromTranscript(planned.transcript),
        expected: browser.relay.commit_scope.head,
        persistence: "durable" as const
      };
      const encoded = encodeEnvelope(shadowBrowserEnvelope(browser, request.kind, request, "cf-v2-session-location-env"));
      const openRequest = await signInternalRequest(env, new Request("https://woo.internal/v2/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "the_chatroom",
          node: "browser:session-location-test",
          token: "guest:cf-v2-session-location",
          session: session.id,
          actor: session.actor,
          sessions: world.exportSessions(),
          session_objects: world.exportObjects([session.actor]),
          serialized: world.exportWorld()
        })
      }));
      const commitScope = env.COMMIT_SCOPE;
      if (!commitScope) throw new Error("test env missing COMMIT_SCOPE");
      const opened = await commitScope.get(commitScope.idFromName("the_chatroom")).fetch(openRequest);
      expect(opened.ok).toBe(true);

      const ws = new FakeWebSocket();
      await internals.webSocketV2TurnNetworkMessage(world, ws as unknown as WebSocket, encoded);

      const replies = ws.sent.map((frame) => JSON.parse(frame) as Record<string, any>);
      expect(replies[0]?.body).toMatchObject({ ok: true, id: "cf-v2-session-location-move" });
      expect(world.activeScopeForSession(session.id)).toBe("the_deck");
      expect(world.exportSessions()).toContainEqual(expect.objectContaining({
        id: session.id,
        actor: session.actor,
        activeScope: "the_deck"
      }));
      const rows = sqlRows<{ current_location: string }>(directoryState.storage.sql.exec("SELECT current_location FROM session_route WHERE session_id = ?", session.id));
      expect(rows).toEqual([{ current_location: "the_deck" }]);
    } finally {
      directoryState.close();
      gatewayState.close();
      for (const state of commitStates.values()) state.close();
    }
  });

  it("reports malformed v2 envelopes through the CommitScopeDO path", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");
    const commitStates = new Map<string, FakeDurableObjectState>();
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-v2-reset-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: new FakeDurableObjectNamespace((name) => {
        throw new Error(`unexpected Woo DO ${name}`);
      }),
      COMMIT_SCOPE: new FakeDurableObjectNamespace((name) => {
        let state = commitStates.get(name);
        if (!state) {
          state = new FakeDurableObjectState(name);
          commitStates.set(name, state);
        }
        return new CommitScopeDO(state as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
      })
    } as unknown as Env;
    const gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);
    const internals = gateway as unknown as {
      getWorld: (host?: string) => Promise<WooWorld>;
      webSocketV2TurnNetworkMessage: (world: WooWorld, ws: WebSocket, message: string | ArrayBuffer) => Promise<void>;
    };
    class FakeWebSocket {
      readonly sent: string[] = [];
      send(data: string): void { this.sent.push(data); }
      close(): void {}
      deserializeAttachment(): unknown {
        return {
          protocol: "v2-turn-network",
          sessionId: session.id,
          actor: session.actor,
          socketId: "v2-reset-socket",
          node: "browser:reset-test",
          token: "guest:cf-v2-reset"
        };
      }
    }
    let session: ReturnType<WooWorld["auth"]>;

    try {
      const world = await internals.getWorld("world");
      session = world.auth("guest:cf-v2-reset");
      const ws = new FakeWebSocket();
      await internals.webSocketV2TurnNetworkMessage(world, ws as unknown as WebSocket, "{}");

      expect(ws.sent).toHaveLength(1);
      expect(JSON.parse(ws.sent[0])).toMatchObject({
        type: "woo.transport.error.v1",
        body: { code: "E_PROTOCOL" }
      });
    } finally {
      directoryState.close();
      gatewayState.close();
      for (const state of commitStates.values()) state.close();
    }
  });

  it("emits startup storage metrics before world init completes", async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");

    try {
      const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
      const env = {
        WOO_INITIAL_WIZARD_TOKEN: "cf-startup-metrics-token",
        WOO_INTERNAL_SECRET: "cf-test-secret",
        WOO_AUTO_INSTALL_CATALOGS: "",
        DIRECTORY: new FakeDurableObjectNamespace((name) => {
          if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
          return directory;
        }),
        WOO: new FakeDurableObjectNamespace((name) => {
          throw new Error(`unexpected Woo DO ${name}`);
        })
      } as unknown as Env;
      const gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);

      const response = await gateway.fetch(new Request("https://woo.test/healthz"));
      expect(response.ok).toBe(true);

      const metrics = logs
        .filter((line) => line.startsWith("woo.metric "))
        .map((line) => JSON.parse(line.slice("woo.metric ".length)) as Record<string, unknown>);
      expect(metrics).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "startup_storage", phase: "cf_repository_migrate", host_key: "world" }),
        expect.objectContaining({ kind: "startup_storage", phase: "cf_repository_load", host_key: "world", stored: false }),
        expect.objectContaining({ kind: "startup_storage", phase: "cf_repository_save", host_key: "world" }),
        expect.objectContaining({ kind: "startup_storage", phase: "directory_schema", host_key: "directory" }),
        expect.objectContaining({ kind: "startup_storage", phase: "directory_register_objects", host_key: "directory", writes: 23 })
      ]));

      logs.length = 0;
      const restartedGateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);
      const restarted = await restartedGateway.fetch(new Request("https://woo.test/healthz"));
      expect(restarted.ok).toBe(true);
      const restartMetrics = logs
        .filter((line) => line.startsWith("woo.metric "))
        .map((line) => JSON.parse(line.slice("woo.metric ".length)) as Record<string, unknown>);
      expect(restartMetrics).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "startup_storage", phase: "cf_repository_load", host_key: "world", stored: true })
      ]));
      expect(restartMetrics).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "startup_storage", phase: "cf_repository_save", host_key: "world" })
      ]));
      // Cold-restart fingerprint: the gateway hashed the world's route set
      // against the persisted publish digest, found a match, and skipped
      // the directory_register_objects RPC entirely. The skip metric is
      // the observable signal; the absence of a register_objects metric
      // is the actual win (no signed fetch, no Directory transaction).
      expect(restartMetrics).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "startup_storage", phase: "directory_register_objects_skip", host_key: "world", routes: 23 })
      ]));
      expect(restartMetrics).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "startup_storage", phase: "directory_register_objects" })
      ]));
    } finally {
      logSpy.mockRestore();
      directoryState.close();
      gatewayState.close();
    }
  });

  it("boots, persists, and reloads through the CF storage API shape", async () => {
    const harness = makeCfHarness();
    try {
      let world = harness.world;
      const session = world.auth("guest:cf-repo-reload");
      const applied = await callInDubspace(world, session.id, "cf-set-control", message(session.actor, "the_dubspace", "set_control", ["delay_1", "wet", 0.58]));
      expect(applied.op).toBe("applied");
      const snapshot = world.saveSnapshot("the_dubspace");

      world = harness.restart();
      expect(world.getProp("delay_1", "wet")).toBe(0.58);
      expect(world.getProp("the_dubspace", "next_seq")).toBe(2);
      expect(world.replay("the_dubspace", 1, 10).map((entry) => entry.message.verb)).toEqual(["set_control"]);
      expect(world.latestSnapshot("the_dubspace")?.hash).toBe(snapshot.hash);
      expect(world.verbInfo("the_chatroom", "enter").direct_callable).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it("uses CF nested transaction savepoints for behavior rollback", async () => {
    const harness = makeCfHarness();
    try {
      const world = harness.world;
      installFailureFixture(world);
      const session = world.auth("guest:cf-savepoint");
      const applied = await callInDubspace(world, session.id, "cf-fail", message(session.actor, "delay_1", "cf_mutate_then_fail", ["discarded"]));

      expect(applied.op).toBe("applied");
      if (applied.op === "applied") {
        expect(applied.seq).toBe(1);
        expect(applied.observations[0]).toMatchObject({ type: "$error", code: "E_CF_FAIL" });
      }
      expect(world.propOrNull("delay_1", "cf_failed_value")).toBeNull();
      expect(world.replay("the_dubspace", 1, 10)).toMatchObject([{ seq: 1, applied_ok: false, error: { code: "E_CF_FAIL" } }]);
    } finally {
      harness.cleanup();
    }
  });

  it("resolves commands against a remote current room with CF-backed hosts", async () => {
    const homeHarness = makeCfHarness();
    const roomHarness = makeCfHarness();
    try {
      const home = homeHarness.world;
      const roomHost = roomHarness.world;
      const session = home.auth("guest:cf-remote-command-match");
      const actor = session.actor;
      const worlds = new Map<string, WooWorld>([
        ["home", home],
        ["room", roomHost]
      ]);
      const routes = new Map<ObjRef, string>([
        [actor, "home"],
        ["cf_remote_room", "room"],
        ["cf_home_widget", "home"]
      ]);
      home.setExecutorContext(new FakeExecutorContext("home", worlds, routes));
      roomHost.setExecutorContext(new FakeExecutorContext("room", worlds, routes));

      roomHost.createObject({ id: "cf_remote_room", name: "Remote Room", parent: "$chatroom", owner: "$wiz" });
      roomHost.setProp("cf_remote_room", "subscribers", [actor]);
      roomHost.setProp("cf_remote_room", "features", ["$conversational"]);
      roomHost.setProp("cf_remote_room", "aliases", ["remote room"]);
      if (!roomHost.objects.has(actor)) roomHost.createObject({ id: actor, name: actor, parent: "$guest", owner: "$wiz" });
        roomHost.setActorPresence(actor, "cf_remote_room", true);

        home.object(actor).location = "cf_remote_room";
        home.sessions.get(session.id)!.activeScope = "cf_remote_room";
        home.setActorPresence(actor, "cf_remote_room", true);
        home.createObject({ id: "cf_home_widget", name: "Home Widget", parent: "$thing", owner: "$wiz" });
        home.object("cf_home_widget").location = "cf_remote_room";
      home.setProp("cf_home_widget", "aliases", ["widget"]);
      home.addVerb("cf_home_widget", {
        kind: "native",
        name: "ping",
        aliases: ["p*ing"],
        owner: "$wiz",
        perms: "rxd",
        arg_spec: {
          command: { dobj: "this", prep: "any", iobj: "any", args_from: [] }
        },
        source: "verb :ping() rxd { return \"pong\"; }",
        source_hash: "cf-remote-command-ping",
        version: 1,
        line_map: {},
        native: "player_on_disfunc",
        direct_callable: true
      });
      roomHost.mirrorContents("cf_remote_room", actor, true);
      roomHost.mirrorContents("cf_remote_room", "cf_home_widget", true);

      const parsedHere = await home.directCall("cf-parse-remote-here", actor, "$match", "parse_command", ["look here", actor]);
      expect(parsedHere.op).toBe("result");
      if (parsedHere.op === "result") expect(parsedHere.result).toMatchObject({ dobj: "cf_remote_room", dobjstr: "here" });

      const parsedWidget = await home.directCall("cf-parse-remote-widget", actor, "$match", "parse_command", ["look widget", actor]);
      expect(parsedWidget.op).toBe("result");
      if (parsedWidget.op === "result") expect(parsedWidget.result).toMatchObject({ dobj: "cf_home_widget", dobjstr: "widget" });

      const plan = await roomHost.directCall("cf-plan-cross-host-widget", actor, "cf_remote_room", "command_plan", ["ping widget"]);
      expect(plan.op).toBe("result");
      if (plan.op === "result") expect(plan.result).toMatchObject({ ok: true, route: "direct", target: "cf_home_widget", verb: "ping", args: [] });

      const remoteRoomLook = await home.planCommand("cf-plan-remote-room-look-widget", session.id, "cf_remote_room", "look widget");
      expect(remoteRoomLook.op).toBe("result");
      if (remoteRoomLook.op === "result") {
        expect(remoteRoomLook.result).toMatchObject({ ok: true, route: "direct", target: "cf_remote_room", verb: "look_at", args: ["cf_home_widget"] });
      }
    } finally {
      roomHarness.cleanup();
      homeHarness.cleanup();
    }
  });

  it("supports no-fallback object resolution for internal host lookups", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const env = { WOO_INTERNAL_SECRET: "cf-test-secret" };

    async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
      const request = await signInternalRequest(env, new Request(`https://woo.internal${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      }));
      const response = await directory.fetch(request);
      expect(response.ok).toBe(true);
      return await response.json() as Record<string, unknown>;
    }

    try {
      await post("/register-objects", { routes: [{ id: "the_hot_tub", host: "the_hot_tub", anchor: null }] });
      await expect(post("/resolve-object", { id: "the_hot_tub", fallback_host: "" }))
        .resolves.toMatchObject({ id: "the_hot_tub", host: "the_hot_tub" });
      await expect(post("/resolve-object", { id: "tub", fallback_host: "" }))
        .resolves.toMatchObject({ id: "tub", host: "" });
      await expect(post("/resolve-object", { id: "$space", fallback_host: "" }))
        .resolves.toMatchObject({ id: "$space", host: "world" });
    } finally {
      directoryState.close();
    }
  });

  it("accepts legacy internal current-location headers for routed REST sessions", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-legacy-current-location-header",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: new FakeDurableObjectNamespace((name) => {
        throw new Error(`unexpected Woo DO ${name}`);
      })
    } as unknown as Env;
    const gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);

    try {
      const response = await gateway.fetch(new Request("https://woo.test/api/me", {
        headers: {
          "x-woo-internal-session": "legacy-current-location-session",
          "x-woo-internal-actor": "$wiz",
          "x-woo-internal-expires-at": String(Date.now() + 60_000),
          "x-woo-internal-token-class": "bearer",
          "x-woo-internal-current-location": "the_deck"
        }
      }));

      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, any>;
      expect(body.session).toMatchObject({
        id: "legacy-current-location-session",
        actor: "$wiz",
        active_scope: "the_deck",
        current_location: "the_deck"
      });
    } finally {
      directoryState.close();
      gatewayState.close();
    }
  });

  it("plans enter commands on a routed room without treating aliases as object routes", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const wooStates = new Map<string, FakeDurableObjectState>();
    const wooObjects = new Map<string, PersistentObjectDO>();
    let env: Env;
    const wooNamespace = new FakeDurableObjectNamespace((name) => {
      let object = wooObjects.get(name);
      if (!object) {
        const state = new FakeDurableObjectState(name);
        wooStates.set(name, state);
        object = new PersistentObjectDO(state as unknown as DurableObjectState, env);
        wooObjects.set(name, object);
      }
      return object;
    });
    env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-command-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "chat,demoworld,pinboard",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: wooNamespace,
      COMMIT_SCOPE: fakeCommitScopeNamespace()
    } as unknown as Env;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    async function post(path: string, body: Record<string, unknown>, session?: string): Promise<{ status: number; body: Record<string, unknown> }> {
      const response = await worker.fetch(new Request(`https://woo.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(session ? { authorization: `Session ${session}` } : {})
        },
        body: JSON.stringify(body)
      }), env, {});
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    }

    try {
      const auth = await post("/api/auth", { token: "guest:cf-command-alias" });
      expect(auth.status).toBe(200);
      const session = String(auth.body.session);

      const firstEnter = await post("/api/objects/the_chatroom/calls/enter", { args: [] }, session);
      expect(firstEnter.status, JSON.stringify(firstEnter.body)).toBe(200);
      expect((await post("/api/objects/the_chatroom/calls/enter", { args: [] }, session)).status).toBe(200);
      expect((await post("/api/objects/the_chatroom/calls/southeast", { args: [] }, session)).status).toBe(200);

      const tubPlan = await post("/api/objects/the_deck/calls/command_plan", { args: ["enter tub"] }, session);
      expect(tubPlan.status).toBe(200);
      // chat:enter is sequenced (see catalogs/chat/manifest.json); cross-room
      // `enter <space>` must plan on the target's scope or the commit submits
      // on the caller's chatroom and rejects as scope_mismatch.
      expect(tubPlan.body.result).toMatchObject({ ok: true, route: "sequenced", space: "the_hot_tub", target: "the_hot_tub", verb: "enter", args: [] });

      const pinboardPlan = await post("/api/objects/the_deck/calls/command_plan", { args: ["enter pinboard"] }, session);
      expect(pinboardPlan.status).toBe(200);
      expect(pinboardPlan.body.result).toMatchObject({ ok: true, route: "sequenced", space: "the_pinboard", target: "the_pinboard", verb: "enter", args: [] });
    } finally {
      logSpy.mockRestore();
      directoryState.close();
      for (const state of wooStates.values()) state.close();
    }
  });

  it("routes established MCP sessions to a stable gateway shard", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const wooStates = new Map<string, FakeDurableObjectState>();
    const wooObjects = new Map<string, PersistentObjectDO>();
    const fetchedHosts: string[] = [];
    let env: Env;
    const wooNamespace = new FakeDurableObjectNamespace((name) => {
      fetchedHosts.push(name);
      let object = wooObjects.get(name);
      if (!object) {
        const state = new FakeDurableObjectState(name);
        wooStates.set(name, state);
        object = new PersistentObjectDO(state as unknown as DurableObjectState, env);
        wooObjects.set(name, object);
      }
      return object;
    });
    env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-mcp-shard-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "chat,demoworld,pinboard",
      WOO_MCP_GATEWAY_SHARDS: "4",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: wooNamespace,
      COMMIT_SCOPE: fakeCommitScopeNamespace()
    } as unknown as Env;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    function mcp(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
      return worker.fetch(new Request("https://woo.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers
        },
        body: JSON.stringify(body)
      }), env, {});
    }

    try {
      const init = await mcp({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "cf-mcp-shard", version: "0.0.0" }
        }
      }, { "mcp-token": "guest:cf-mcp-shard" });
      expect(init.ok).toBe(true);
      const sessionId = init.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();

      const notified = await mcp({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      }, { "mcp-session-id": sessionId! });
      expect(notified.status).toBe(202);

      const list = await mcp({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list"
      }, { "mcp-session-id": sessionId! });
      expect(list.status, await list.clone().text()).toBe(200);
      const body = await list.json() as Record<string, unknown>;
      expect(body.result).toBeTruthy();

      const shardHosts = fetchedHosts.filter((host) => host.startsWith("mcp-gateway-"));
      expect(new Set(shardHosts).size).toBe(1);
      expect(fetchedHosts[0]).toBe("world");
      expect(shardHosts.length).toBeGreaterThanOrEqual(2);
    } finally {
      logSpy.mockRestore();
      directoryState.close();
      for (const state of wooStates.values()) state.close();
    }
  });

  it("delivers MCP observations across gateway shards", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const wooStates = new Map<string, FakeDurableObjectState>();
    const wooObjects = new Map<string, PersistentObjectDO>();
    const fanoutHosts: string[] = [];
    const fanoutRequests: Array<{ host: string; request: Request }> = [];
    let env: Env;
    const wooNamespace = new FakeDurableObjectNamespace((name) => {
      let object = wooObjects.get(name);
      if (!object) {
        const state = new FakeDurableObjectState(name);
        wooStates.set(name, state);
        object = new PersistentObjectDO(state as unknown as DurableObjectState, env);
        wooObjects.set(name, object);
      }
      return {
        fetch: async (request: Request): Promise<Response> => {
          const pathname = new URL(request.url).pathname;
          if (pathname === "/__internal/mcp-commit-fanout" || pathname === "/__internal/mcp-live-fanout") {
            fanoutHosts.push(name);
            fanoutRequests.push({ host: name, request: request.clone() });
          }
          return await object.fetch(request);
        }
      };
    });
    env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-mcp-cross-shard-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "chat,demoworld,pinboard",
      WOO_MCP_GATEWAY_SHARDS: "8",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: wooNamespace,
      COMMIT_SCOPE: fakeCommitScopeNamespace()
    } as unknown as Env;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    async function mcp(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Record<string, any>> {
      const response = await worker.fetch(new Request("https://woo.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers
        },
        body: JSON.stringify(body)
      }), env, {});
      expect(response.ok, await response.clone().text()).toBe(true);
      return await response.json() as Record<string, any>;
    }

    async function initialize(token: string, id: number): Promise<string> {
      const initResponse = await worker.fetch(new Request("https://woo.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-token": token
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "cf-mcp-cross-shard", version: "0.0.0" }
          }
        })
      }), env, {});
      expect(initResponse.ok, await initResponse.clone().text()).toBe(true);
      const sessionId = initResponse.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();
      const notified = await worker.fetch(new Request("https://woo.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-session-id": sessionId!
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
      }), env, {});
      expect(notified.status).toBe(202);
      return sessionId!;
    }

    async function unregister(sessionId: string): Promise<void> {
      const request = await signInternalRequest(env, new Request("https://woo.internal/unregister-session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: sessionId })
      }));
      const response = await env.DIRECTORY.get(env.DIRECTORY.idFromName("directory")).fetch(request);
      expect(response.ok, await response.clone().text()).toBe(true);
    }

    try {
      const alice = await initialize("guest:cf-mcp-cross-shard-alice", 1);
      const aliceShard = testMcpShardHost(alice, 8);
      let bob = "";
      let bobShard = "";
      for (let i = 0; i < 12; i += 1) {
        const candidate = await initialize(`guest:cf-mcp-cross-shard-bob-${i}`, 10 + i);
        const shard = testMcpShardHost(candidate, 8);
        if (shard !== aliceShard) {
          bob = candidate;
          bobShard = shard;
          break;
        }
        await unregister(candidate);
      }
      expect(bob).toBeTruthy();

      let charlie = "";
      let charlieShard = "";
      for (let i = 0; i < 16; i += 1) {
        const candidate = await initialize(`guest:cf-mcp-cross-shard-charlie-${i}`, 40 + i);
        const shard = testMcpShardHost(candidate, 8);
        if (shard !== aliceShard && shard !== bobShard) {
          charlie = candidate;
          charlieShard = shard;
          break;
        }
        await unregister(candidate);
      }
      expect(charlie).toBeTruthy();

      const bobReady = await mcp({
        jsonrpc: "2.0",
        id: 30,
        method: "tools/call",
        params: {
          name: "woo_call",
          arguments: { object: "the_chatroom", verb: "enter", args: [] }
        }
      }, { "mcp-session-id": bob });
      expect(bobReady.result.isError, JSON.stringify(bobReady.result.structuredContent)).not.toBe(true);

      const charlieAway = await mcp({
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: {
          name: "woo_call",
          arguments: { object: "the_chatroom", verb: "southeast", args: [] }
        }
      }, { "mcp-session-id": charlie });
      expect(charlieAway.result.isError, JSON.stringify(charlieAway.result.structuredContent)).not.toBe(true);
      fanoutHosts.length = 0;
      fanoutRequests.length = 0;

      const said = await mcp({
        jsonrpc: "2.0",
        id: 32,
        method: "tools/call",
        params: {
          name: "woo_call",
          arguments: { object: "the_chatroom", verb: "say", args: ["hello across MCP shards"] }
        }
      }, { "mcp-session-id": alice });
      expect(said.result.isError, JSON.stringify(said.result.structuredContent)).not.toBe(true);
      expect(fanoutHosts, JSON.stringify({ aliceShard, bobShard, charlieShard, fanoutHosts })).toContain(bobShard);
      expect(fanoutHosts, JSON.stringify({ aliceShard, bobShard, charlieShard, fanoutHosts })).not.toContain(charlieShard);
      const bobWorld = (wooObjects.get(bobShard) as unknown as { world?: WooWorld }).world;
      expect(bobWorld?.sessions.get(bob)?.activeScope, JSON.stringify({ aliceShard, bobShard, fanoutHosts })).toBe("the_chatroom");

      const waited = await mcp({
        jsonrpc: "2.0",
        id: 33,
        method: "tools/call",
        params: {
          name: "woo_wait",
          arguments: { timeout_ms: 0, limit: 10 }
        }
      }, { "mcp-session-id": bob });
      expect(waited.result.isError, JSON.stringify(waited.result.structuredContent)).not.toBe(true);
      expect(waited.result.structuredContent.result.observations, JSON.stringify(waited)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "said", text: expect.stringContaining("hello across MCP shards") })
      ]));

      const replay = fanoutRequests.find((item) => item.host === bobShard);
      expect(replay).toBeTruthy();
      const replayResponse = await wooObjects.get(bobShard)!.fetch(replay!.request);
      expect(replayResponse.ok, await replayResponse.clone().text()).toBe(true);
      const replayWaited = await mcp({
        jsonrpc: "2.0",
        id: 34,
        method: "tools/call",
        params: {
          name: "woo_wait",
          arguments: { timeout_ms: 0, limit: 10 }
        }
      }, { "mcp-session-id": bob });
      expect(replayWaited.result.structuredContent.result.observations, JSON.stringify(replayWaited)).toEqual([]);
    } finally {
      logSpy.mockRestore();
      directoryState.close();
      for (const state of wooStates.values()) state.close();
    }
  });

  it("fans accepted cross-scope moves to MCP shards in the destination room", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const wooStates = new Map<string, FakeDurableObjectState>();
    const wooObjects = new Map<string, PersistentObjectDO>();
    const fanoutHosts: string[] = [];
    let env: Env;
    const wooNamespace = new FakeDurableObjectNamespace((name) => {
      let object = wooObjects.get(name);
      if (!object) {
        const state = new FakeDurableObjectState(name);
        wooStates.set(name, state);
        object = new PersistentObjectDO(state as unknown as DurableObjectState, env);
        wooObjects.set(name, object);
      }
      return {
        fetch: async (request: Request): Promise<Response> => {
          if (new URL(request.url).pathname === "/__internal/mcp-commit-fanout") {
            fanoutHosts.push(name);
          }
          return await object.fetch(request);
        }
      };
    });
    env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-mcp-presence-fanout-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "chat,demoworld,pinboard",
      WOO_MCP_GATEWAY_SHARDS: "4",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: wooNamespace,
      COMMIT_SCOPE: fakeCommitScopeNamespace()
    } as unknown as Env;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    async function mcp(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Record<string, any>> {
      const response = await worker.fetch(new Request("https://woo.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers
        },
        body: JSON.stringify(body)
      }), env, {});
      expect(response.ok, await response.clone().text()).toBe(true);
      return await response.json() as Record<string, any>;
    }

    async function initialize(token: string, id: number): Promise<string> {
      const initResponse = await worker.fetch(new Request("https://woo.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-token": token
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "cf-mcp-presence-fanout", version: "0.0.0" }
          }
        })
      }), env, {});
      expect(initResponse.ok, await initResponse.clone().text()).toBe(true);
      const sessionId = initResponse.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();
      const notified = await worker.fetch(new Request("https://woo.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-session-id": sessionId!
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
      }), env, {});
      expect(notified.status).toBe(202);
      return sessionId!;
    }

    try {
      const bob = await initialize("guest:cf-mcp-presence-bob", 1);
      const bobShard = testMcpShardHost(bob, 4);
      const bobReady = await mcp({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "woo_call",
          arguments: { object: "the_chatroom", verb: "enter", args: [] }
        }
      }, { "mcp-session-id": bob });
      expect(bobReady.result.isError, JSON.stringify(bobReady.result.structuredContent)).not.toBe(true);

      let alice = "";
      let aliceShard = "";
      for (let i = 0; i < 8; i += 1) {
        const candidate = await initialize(`guest:cf-mcp-presence-alice-${i}`, 10 + i);
        const shard = testMcpShardHost(candidate, 4);
        if (shard !== bobShard) {
          alice = candidate;
          aliceShard = shard;
          break;
        }
      }
      expect(alice).toBeTruthy();

      const aliceMove = await mcp({
        jsonrpc: "2.0",
        id: 30,
        method: "tools/call",
        params: {
          name: "woo_call",
          arguments: { object: "the_chatroom", verb: "southeast", args: [] }
        }
      }, { "mcp-session-id": alice });
      expect(aliceMove.result.isError, JSON.stringify(aliceMove.result.structuredContent)).not.toBe(true);

      const bobObject = wooObjects.get(bobShard)! as unknown as { world?: WooWorld };
      const aliceObject = wooObjects.get(aliceShard)! as unknown as { world?: WooWorld };
      const bobActor = bobObject.world?.sessions.get(bob)?.actor;
      const aliceActor = aliceObject.world?.sessions.get(alice)?.actor;
      expect(bobActor).toBeTruthy();
      expect(aliceActor).toBeTruthy();

      // Reset setup fanout; Bob's move must discover Alice's destination
      // shard from Directory's scoped session index.
      fanoutHosts.length = 0;
      const bobMove = await mcp({
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: {
          name: "woo_call",
          arguments: { object: "the_chatroom", verb: "southeast", args: [] }
        }
      }, { "mcp-session-id": bob });
      expect(bobMove.result.isError, JSON.stringify(bobMove.result.structuredContent)).not.toBe(true);
      expect(fanoutHosts, JSON.stringify({ aliceShard, bobShard, fanoutHosts })).toContain(aliceShard);

      const who = await mcp({
        jsonrpc: "2.0",
        id: 32,
        method: "tools/call",
        params: {
          name: "woo_call",
          arguments: { object: "the_deck", verb: "who", args: [] }
        }
      }, { "mcp-session-id": alice });
      expect(who.result.isError, JSON.stringify(who.result.structuredContent)).not.toBe(true);
      const rosterIds = (who.result.structuredContent.result as Array<{ id?: unknown }>).map((row) => row.id);
      expect(rosterIds, JSON.stringify(who.result.structuredContent)).toEqual(expect.arrayContaining([aliceActor, bobActor]));
    } finally {
      logSpy.mockRestore();
      directoryState.close();
      for (const state of wooStates.values()) state.close();
    }
  });

  it("persists v2 REST writes to the routed object host before reporting success", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const wooStates = new Map<string, FakeDurableObjectState>();
    const wooObjects = new Map<string, PersistentObjectDO>();
    const applyBodies: Record<string, unknown>[] = [];
    let env: Env;
    const wooNamespace = new FakeDurableObjectNamespace((name) => {
      let object = wooObjects.get(name);
      if (!object) {
        // Reuse the existing FakeDurableObjectState if any. The cold-host
        // simulation below works by deleting the DO instance from
        // wooObjects (mimicking a DO going cold); the SQL-backed state
        // in wooStates must survive that so the next DO instance loads
        // the persisted data. Previously this branch always created a
        // fresh state, which silently dropped persistence between
        // cold-restart simulations.
        let state = wooStates.get(name);
        if (!state) {
          state = new FakeDurableObjectState(name);
          wooStates.set(name, state);
        }
        object = new PersistentObjectDO(state as unknown as DurableObjectState, env);
        wooObjects.set(name, object);
      }
      return {
        fetch: async (request: Request): Promise<Response> => {
          if (new URL(request.url).pathname === "/__internal/apply-v2-commit") {
            applyBodies.push(await request.clone().json() as Record<string, unknown>);
          }
          return await object.fetch(request);
        }
      };
    });
    env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-weather-write-through-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "chat,demoworld,block,weather,blocks-demo",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: wooNamespace,
      COMMIT_SCOPE: fakeCommitScopeNamespace()
    } as unknown as Env;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    async function post(path: string, body: Record<string, unknown>, session?: string): Promise<{ status: number; body: Record<string, any> }> {
      const response = await worker.fetch(new Request(`https://woo.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(session ? { authorization: `Session ${session}` } : {})
        },
        body: JSON.stringify(body)
      }), env, {});
      return { status: response.status, body: await response.json() as Record<string, any> };
    }

    async function get(path: string, session: string): Promise<{ status: number; body: Record<string, any> }> {
      const response = await worker.fetch(new Request(`https://woo.test${path}`, {
        headers: { authorization: `Session ${session}` }
      }), env, {});
      return { status: response.status, body: await response.json() as Record<string, any> };
    }

    try {
      const auth = await post("/api/auth", { token: "wizard:cf-weather-write-through-token" });
      expect(auth.status).toBe(200);
      const session = String(auth.body.session);

      const single = await post("/api/objects/the_weather/calls/set_property", { args: ["last_error", "probe"] }, session);
      expect(single.status, JSON.stringify(single.body)).toBe(200);
      expect(single.body.result).toBe("probe");

      const readSingle = await get("/api/objects/the_weather/properties/last_error", session);
      expect(readSingle.status, JSON.stringify(readSingle.body)).toBe(200);
      expect(readSingle.body).toMatchObject({ has_value: true, value: "probe" });

      const bulk = await post("/api/objects/the_weather/calls/set_properties", {
        args: [{ current: { temperature: 72 }, daily: [{ day: "today" }] }]
      }, session);
      expect(bulk.status, JSON.stringify(bulk.body)).toBe(200);

      const readCurrent = await get("/api/objects/the_weather/properties/current", session);
      expect(readCurrent.status, JSON.stringify(readCurrent.body)).toBe(200);
      expect(readCurrent.body.value).toEqual({ temperature: 72 });
      const readDaily = await get("/api/objects/the_weather/properties/daily", session);
      expect(readDaily.status, JSON.stringify(readDaily.body)).toBe(200);
      expect(readDaily.body.value).toEqual([{ day: "today" }]);

      // Architectural note: pre-refactor (the WORLD-centric routing for
      // /api/objects/X/calls/Y) the REST call landed on WORLD, which
      // fanned the write to the_chatroom via apply-v2-commit. The
      // applyBodies capture + replay block here exercised that
      // write-through path.
      //
      // Post-refactor (worker/index.ts: route /calls/ to X's host's
      // DO), the call lands directly on the_chatroom and writes apply
      // to local SQL inside writeThroughV2CommitToObjectHosts'
      // localApplied branch. There is no apply-v2-commit fanout to
      // the_chatroom because the_chatroom IS the originating host.
      // applyBodies stays empty by design — the cold-host check below
      // is the durability assertion that remains meaningful.

      // Simulate a cold object-host DO: the value must be in the host's
      // repository, not just the warm gateway's in-memory v2 cache.
      wooObjects.delete("the_chatroom");
      const readAfterColdHost = await get("/api/objects/the_weather/properties/last_error", session);
      expect(readAfterColdHost.status, JSON.stringify(readAfterColdHost.body)).toBe(200);
      expect(readAfterColdHost.body).toMatchObject({ has_value: true, value: "probe" });
    } finally {
      logSpy.mockRestore();
      directoryState.close();
      for (const state of wooStates.values()) state.close();
    }
  });

  // Retired with the call-routing refactor (worker/index.ts: route
  // /api/objects/X/calls/Y to X's host's DO instead of WORLD).
  //
  // Pre-refactor: REST writes to the_weather landed on WORLD, which
  // fanned to the_chatroom via apply-v2-commit. If the_chatroom
  // rejected the apply, the originating WORLD returned 503 E_RETRY.
  // The test forced apply-v2-commit to fail to verify that path.
  //
  // Post-refactor: the call lands directly on the_chatroom. The
  // write to the_weather is local SQL inside
  // writeThroughV2CommitToObjectHosts' localApplied branch — there
  // is no apply-v2-commit fanout to intercept for in-host writes.
  //
  // The remote-touched-host apply failure surface still exists in
  // code: writeThroughV2CommitToObjectHosts (persistent-object-do.ts)
  // still fans /__internal/apply-v2-commit to non-local touched
  // hosts, and a failure there still throws E_RETRY back up the
  // REST path. Reproducing it in this test fixture requires a verb
  // whose transcript touches a host other than the originating one
  // (e.g., a chat verb that writes to both the room and the actor
  // when the actor's row is on a different DO). That test belongs
  // here once a cross-host fixture is wired up; tracked in #46
  // follow-ups.

  it("sends REST v2 relay snapshots only when CommitScopeDO asks for a seed", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const wooStates = new Map<string, FakeDurableObjectState>();
    const wooObjects = new Map<string, PersistentObjectDO>();
    const commitPosts: Array<{ scope: string; path: string; body: Record<string, unknown> }> = [];
    let env: Env;
    const wooNamespace = new FakeDurableObjectNamespace((name) => {
      let object = wooObjects.get(name);
      if (!object) {
        const state = new FakeDurableObjectState(name);
        wooStates.set(name, state);
        object = new PersistentObjectDO(state as unknown as DurableObjectState, env);
        wooObjects.set(name, object);
      }
      return object;
    });
    env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-command-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "chat,demoworld,pinboard",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: wooNamespace,
      COMMIT_SCOPE: fakeCommitScopeNamespace("cf-test-secret", (scope, path, body) => {
        if (path !== "/v2/open" && path !== "/v2/envelope") return;
        if (!body || typeof body !== "object" || Array.isArray(body)) return;
        commitPosts.push({ scope, path, body: body as Record<string, unknown> });
      })
    } as unknown as Env;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    async function post(path: string, body: Record<string, unknown>, session?: string): Promise<{ status: number; body: Record<string, unknown> }> {
      const response = await worker.fetch(new Request(`https://woo.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(session ? { authorization: `Session ${session}` } : {})
        },
        body: JSON.stringify(body)
      }), env, {});
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    }

    try {
      const auth = await post("/api/auth", { token: "guest:cf-rest-relay" });
      expect(auth.status).toBe(200);
      const session = String(auth.body.session);

      const firstEnter = await post("/api/objects/the_chatroom/calls/enter", { args: [] }, session);
      expect(firstEnter.status, JSON.stringify(firstEnter.body)).toBe(200);
      const secondEnter = await post("/api/objects/the_chatroom/calls/enter", { args: [] }, session);
      expect(secondEnter.status, JSON.stringify(secondEnter.body)).toBe(200);

      const chatOpens = commitPosts.filter((post) => post.scope === "the_chatroom" && post.path === "/v2/open");
      const chatEnvelopes = commitPosts.filter((post) => post.scope === "the_chatroom" && post.path === "/v2/envelope");
      expect(chatOpens).toHaveLength(1);
      expect(chatOpens[0].body).not.toHaveProperty("serialized");
      expect(chatOpens[0].body.session_objects).toEqual([]);
      expect((chatOpens[0].body.authority as { kind?: string } | undefined)?.kind).toBe("woo.authority_slice.cells.shadow.v1");
      expect(chatEnvelopes).toHaveLength(2);
      expect(chatEnvelopes.every((post) => !Object.prototype.hasOwnProperty.call(post.body, "serialized"))).toBe(true);
      expect(chatEnvelopes.every((post) => Array.isArray(post.body.session_objects) && post.body.session_objects.length === 0)).toBe(true);
    } finally {
      logSpy.mockRestore();
      directoryState.close();
      for (const state of wooStates.values()) state.close();
    }
  });

  it("reopens and retries REST v2 relays after a stale-head rejection", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const wooStates = new Map<string, FakeDurableObjectState>();
    const wooObjects = new Map<string, PersistentObjectDO>();
    const commitPosts: Array<{ scope: string; path: string; body: Record<string, unknown> }> = [];
    const staleEnvelopeIds = new Set<string>();
    let rejectNextChatEnvelope = false;
    let staleReplies = 0;
    let env: Env;
    const wooNamespace = new FakeDurableObjectNamespace((name) => {
      let object = wooObjects.get(name);
      if (!object) {
        const state = new FakeDurableObjectState(name);
        wooStates.set(name, state);
        object = new PersistentObjectDO(state as unknown as DurableObjectState, env);
        wooObjects.set(name, object);
      }
      return object;
    });
    const staleHeadResponse = (id: string): Response => new Response(JSON.stringify({
      ok: true,
      reply: encodeEnvelope({
        v: 2,
        type: "woo.turn.exec.reply.shadow.v1",
        id: `forced-stale:${id}`,
        from: "node:commit-scope:the_chatroom",
        auth: { mode: "same_deployment_mac", mac: "forced-test-reply" },
        body: {
          kind: "woo.turn.exec.reply.shadow.v1",
          ok: false,
          id: "rest-repair-explicit-id",
          reason: "commit_rejected",
          commit: {
            kind: "woo.commit.conflict.shadow.v1",
            scope: "the_chatroom",
            current: { kind: "woo.scope_head.shadow.v1", scope: "the_chatroom", epoch: 0, seq: 99, hash: "forced-stale" },
            reason: "stale_head",
            errors: ["forced stale head for REST relay repair test"],
            receipt: {}
          }
        }
      }),
      fanout: []
    }), { status: 200, headers: { "content-type": "application/json" } });
    env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-command-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "chat,demoworld,pinboard",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: wooNamespace,
      COMMIT_SCOPE: fakeCommitScopeNamespace("cf-test-secret", (scope, path, body) => {
        if (path !== "/v2/open" && path !== "/v2/envelope") return;
        if (!body || typeof body !== "object" || Array.isArray(body)) return;
        const post = { scope, path, body: body as Record<string, unknown> };
        commitPosts.push(post);
        if (scope !== "the_chatroom" || path !== "/v2/envelope" || typeof post.body.envelope !== "string") return;
        const envelope = decodeEnvelope(post.body.envelope);
        if (staleEnvelopeIds.has(envelope.id)) {
          staleReplies += 1;
          return staleHeadResponse(envelope.id);
        }
        if (rejectNextChatEnvelope) {
          rejectNextChatEnvelope = false;
          staleEnvelopeIds.add(envelope.id);
          staleReplies += 1;
          return staleHeadResponse(envelope.id);
        }
      })
    } as unknown as Env;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    async function post(path: string, body: Record<string, unknown>, session?: string): Promise<{ status: number; body: Record<string, unknown> }> {
      const response = await worker.fetch(new Request(`https://woo.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(session ? { authorization: `Session ${session}` } : {})
        },
        body: JSON.stringify(body)
      }), env, {});
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    }

    try {
      const auth = await post("/api/auth", { token: "guest:cf-rest-relay-repair" });
      expect(auth.status).toBe(200);
      const session = String(auth.body.session);

      const firstEnter = await post("/api/objects/the_chatroom/calls/enter", { args: [] }, session);
      expect(firstEnter.status, JSON.stringify(firstEnter.body)).toBe(200);

      rejectNextChatEnvelope = true;
      const repairedEnter = await post("/api/objects/the_chatroom/calls/enter", { id: "rest-repair-explicit-id", args: [] }, session);
      expect(repairedEnter.status, JSON.stringify(repairedEnter.body)).toBe(200);
      expect(staleReplies).toBe(1);

      const chatOpens = commitPosts.filter((post) => post.scope === "the_chatroom" && post.path === "/v2/open");
      const chatEnvelopes = commitPosts.filter((post) => post.scope === "the_chatroom" && post.path === "/v2/envelope");
      expect(chatOpens).toHaveLength(2);
      expect(chatOpens.filter((post) => Object.prototype.hasOwnProperty.call(post.body, "serialized"))).toHaveLength(0);
      expect(chatOpens[1].body).not.toHaveProperty("serialized");
      expect(chatEnvelopes).toHaveLength(3);
      expect(new Set(chatEnvelopes.map((post) => decodeEnvelope(String(post.body.envelope)).id)).size).toBe(3);
    } finally {
      logSpy.mockRestore();
      directoryState.close();
      for (const state of wooStates.values()) state.close();
    }
  });

  it("bounds read-only cross-host fan-out during routed command planning", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const wooStates = new Map<string, FakeDurableObjectState>();
    const wooObjects = new Map<string, PersistentObjectDO>();
    let env: Env;
    let stallHotTub = false;
    const stalledHost = {
      fetch: async () => await new Promise<Response>(() => undefined)
    };
    const wooNamespace = new FakeDurableObjectNamespace((name) => {
      if (name === "the_hot_tub" && stallHotTub) return stalledHost;
      let object = wooObjects.get(name);
      if (!object) {
        const state = new FakeDurableObjectState(name);
        wooStates.set(name, state);
        object = new PersistentObjectDO(state as unknown as DurableObjectState, env);
        wooObjects.set(name, object);
      }
      return object;
    });
    env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-command-timeout-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "chat,demoworld,pinboard",
      WOO_HOST_READ_TIMEOUT_MS: "5000",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: wooNamespace,
      COMMIT_SCOPE: fakeCommitScopeNamespace()
    } as unknown as Env;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    async function post(path: string, body: Record<string, unknown>, session?: string): Promise<{ status: number; body: Record<string, unknown> }> {
      const response = await worker.fetch(new Request(`https://woo.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(session ? { authorization: `Session ${session}` } : {})
        },
        body: JSON.stringify(body)
      }), env, {});
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    }

    try {
      const auth = await post("/api/auth", { token: "guest:cf-command-timeout" });
      expect(auth.status).toBe(200);
      const session = String(auth.body.session);
      expect((await post("/api/objects/the_chatroom/calls/enter", { args: [] }, session)).status).toBe(200);
      const goDeck = await post("/api/objects/the_chatroom/calls/southeast", { args: [] }, session);
      expect(goDeck.status, JSON.stringify(goDeck.body)).toBe(200);
      // The assertion below is about bounded read-only planning, not satellite
      // cold-start cost. Warm the routed deck host before stalling the nested
      // destination host so the 1s race measures only the planning fan-out.
      const warmDeck = await post("/api/objects/the_deck/calls/look", { args: [] }, session);
      expect(warmDeck.status, JSON.stringify(warmDeck.body)).toBe(200);
      stallHotTub = true;
      env.WOO_HOST_READ_TIMEOUT_MS = "25";

      const planned = await Promise.race([
        post("/api/objects/the_deck/calls/command_plan", { args: ["enter tub"] }, session),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1000))
      ]);
      if (planned === "timeout") throw new Error("command_plan timed out");
      expect(planned).toMatchObject({ status: 200 });
      expect(planned.body.result).toMatchObject({
        ok: true,
        route: "sequenced",
        target: expect.any(String),
        verb: "enter"
      });
    } finally {
      logSpy.mockRestore();
      directoryState.close();
      for (const state of wooStates.values()) state.close();
    }
  });

  it("smokes Worker-routed cross-host room, inventory, and pinboard calls", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const wooStates = new Map<string, FakeDurableObjectState>();
    const wooObjects = new Map<string, PersistentObjectDO>();
    let env: Env;
    const wooNamespace = new FakeDurableObjectNamespace((name) => {
      let object = wooObjects.get(name);
      if (!object) {
        const state = new FakeDurableObjectState(name);
        wooStates.set(name, state);
        object = new PersistentObjectDO(state as unknown as DurableObjectState, env);
        wooObjects.set(name, object);
      }
      return object;
    });
    env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-smoke-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "chat,demoworld,dubspace,help,note,pinboard,prog,tasks,blocks-demo",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: wooNamespace,
      COMMIT_SCOPE: fakeCommitScopeNamespace()
    } as unknown as Env;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    async function post(path: string, body: Record<string, unknown>, session?: string): Promise<{ status: number; body: Record<string, unknown> }> {
      const response = await worker.fetch(new Request(`https://woo.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(session ? { authorization: `Session ${session}` } : {})
        },
        body: JSON.stringify(body)
      }), env, {});
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    }

    try {
      const auth = await post("/api/auth", { token: "guest:cf-cross-host-smoke" });
      expect(auth.status).toBe(200);
      const session = String(auth.body.session);

      const enterChat = await post("/api/objects/the_chatroom/calls/enter", { args: [] }, session);
      expect(enterChat.status).toBe(200);
      expect(enterChat.body.observations).toContainEqual(expect.objectContaining({ type: "entered", room: "the_chatroom" }));
      const chatLook = await post("/api/objects/the_chatroom/calls/look", { args: [] }, session);
      expect(chatLook.status).toBe(200);
      expect(chatLook.body.result).toMatchObject({
        contents: expect.arrayContaining([expect.objectContaining({ id: "the_weather" })])
      });
      const weatherLookCommand = await post("/api/objects/the_chatroom/calls/command", { args: ["look weather"] }, session);
      expect(weatherLookCommand.status).toBe(200);
      expect(weatherLookCommand.body.result).toMatchObject({ id: "the_weather" });
      expect(weatherLookCommand.body.observations).toContainEqual(expect.objectContaining({
        type: "looked",
        room: "the_chatroom",
        target: "the_weather"
      }));

      const goDeck = await post("/api/objects/the_chatroom/calls/southeast", { args: [] }, session);
      expect(goDeck.status).toBe(200);
      expect(goDeck.body.result).toMatchObject({ room: "the_deck", from: "the_chatroom", look_deferred: true });
      expect(goDeck.body.observations).toContainEqual(expect.objectContaining({ type: "entered", room: "the_deck", origin: "the_chatroom" }));
      const deckLook = await post("/api/objects/the_deck/calls/look", { args: [] }, session);
      expect(deckLook.status).toBe(200);
      expect(deckLook.body.result).toMatchObject({
        contents: expect.arrayContaining([expect.objectContaining({ id: "the_horoscope" })])
      });

      const gateway = wooObjects.get("world") as any;
      expect(gateway).toBeTruthy();
      const gatewayWorld = await gateway.getWorld("world") as WooWorld;
      const horoscopeRoute = gatewayWorld.objectRoutes().find((route) => route.id === "the_horoscope");
      // Post-block-self-hosting: $block has host_placement: "self" so
      // every block instance hosts on its own DO. the_horoscope's route
      // is the_horoscope itself rather than its anchor the_deck.
      expect(horoscopeRoute).toMatchObject({ host: "the_horoscope" });
      gateway.routeCache.set("the_horoscope", "world");
      gateway.publishedRoutes.set("the_horoscope", "world");
      const repairedHost = await (gatewayWorld as any).executorContext.hostForObject("the_horoscope" as ObjRef);
      expect(repairedHost).toBe("the_horoscope");
      expect(gateway.routeCache.get("the_horoscope")).toBe("the_horoscope");
      expect(gateway.publishedRoutes.get("the_horoscope")).toBe("the_horoscope");
      gateway.routeCache.set("the_horoscope", "world");
      gateway.publishedRoutes.set("the_horoscope", "world");
      const bridgeHost = await (gatewayWorld as any).executorContext.hostForObject("the_horoscope" as ObjRef);
      expect(bridgeHost).toBe("the_horoscope");
      expect(gateway.routeCache.get("the_horoscope")).toBe("the_horoscope");
      expect(gateway.publishedRoutes.get("the_horoscope")).toBe("the_horoscope");
      const originalRegisterRoutes = gateway.registerRoutes.bind(gateway);
      gateway.routeCache.delete("the_horoscope");
      gateway.publishedRoutes.delete("the_horoscope");
      gateway.registerRoutes = async () => false;
      try {
        const localHost = await (gatewayWorld as any).executorContext.hostForObject("the_horoscope" as ObjRef);
        expect(localHost).toBe("the_horoscope");
        expect(gateway.routeCache.get("the_horoscope")).toBe("the_horoscope");
        expect(gateway.publishedRoutes.has("the_horoscope")).toBe(false);
      } finally {
        gateway.registerRoutes = originalRegisterRoutes;
      }

      const order = await post("/api/objects/the_horoscope/calls/order", { args: ["gemini"] }, session);
      expect(order.status).toBe(200);
      const orderId = String((order.body.result as { order_id: string }).order_id);
      const wizardAuth = await post("/api/auth", { token: "wizard:cf-smoke-token" });
      expect(wizardAuth.status).toBe(200);
      const wizardSession = String(wizardAuth.body.session);
      const deliver = await post("/api/objects/the_horoscope/calls/deliver", { args: [orderId, "Horoscope: Gemini", "The stars prefer bounded route tables."] }, wizardSession);
      expect(deliver.status).toBe(200);
      const deliveredNote = String((deliver.body.result as { note: string }).note);
      const lookDeliveredNote = await post("/api/objects/the_deck/calls/look_at", {
        id: "cf-look-delivered-note",
        space: "the_deck",
        args: [deliveredNote]
      }, session);
      expect(lookDeliveredNote.status).toBe(200);
      expect(lookDeliveredNote.body.result).toMatchObject({ id: deliveredNote });

      const deckState = await worker.fetch(new Request("https://woo.test/api/me", {
        headers: { authorization: `Session ${session}` }
      }), env, {});
      expect(deckState.ok).toBe(true);
      const deckStateBody = await deckState.json() as Record<string, any>;
      expect(deckStateBody.session?.active_scope).toBe("the_deck");
      expect(deckStateBody.session?.current_location).toBe("the_deck");

      const takeTowel = await post("/api/objects/the_deck/calls/take", { args: ["towel"] }, session);
      expect(takeTowel.status).toBe(200);
      expect(takeTowel.body.result).toMatchObject({ item: "the_towel" });
      expect(takeTowel.body.observations).toContainEqual(expect.objectContaining({ type: "taken", item: "the_towel" }));

      const enterTub = await post("/api/objects/the_hot_tub/calls/enter", { args: [] }, session);
      expect(enterTub.status).toBe(200);
      expect(enterTub.body.result).toMatchObject({ room: "the_hot_tub", look_deferred: true });
      expect(enterTub.body.observations).toContainEqual(expect.objectContaining({ type: "entered", room: "the_hot_tub", origin: "the_deck" }));
      const tubState = await worker.fetch(new Request("https://woo.test/api/me", {
        headers: { authorization: `Session ${session}` }
      }), env, {});
      expect(tubState.ok).toBe(true);
      const tubStateBody = await tubState.json() as Record<string, any>;
      expect(tubStateBody.session?.active_scope).toBe("the_hot_tub");
      expect(tubStateBody.session?.current_location).toBe("the_hot_tub");

      const dropTowel = await post("/api/objects/the_hot_tub/calls/drop", { args: ["towel"] }, session);
      expect(dropTowel.status, JSON.stringify(dropTowel.body)).toBe(200);
      expect(dropTowel.body.result).toMatchObject({ item: "the_towel", room: "the_hot_tub" });
      expect(dropTowel.body.observations).toContainEqual(expect.objectContaining({ type: "dropped", item: "the_towel", room: "the_hot_tub" }));

      const enterPinboard = await post("/api/objects/the_pinboard/calls/enter", { args: [] }, session);
      expect(enterPinboard.status).toBe(200);
      expect(enterPinboard.body.observations).toContainEqual(expect.objectContaining({ type: "pinboard_entered", board: "the_pinboard" }));

      const addNote = await post("/api/objects/the_pinboard/calls/add_note", {
        id: "cf-pinboard-add-smoke",
        space: "the_pinboard",
        args: ["CF smoke note", "blue", 12, 24, 160, 90]
      }, session);
      expect(addNote.status).toBe(200);
      expect(addNote.body).toMatchObject({ op: "applied", space: "the_pinboard" });
      const added = (addNote.body.observations as any[]).find((obs) => obs?.type === "note_added");
      expect(added).toMatchObject({ type: "note_added", board: "the_pinboard" });
      const pin = String(added.note.id);
      expect(added.note).toMatchObject({ id: pin, text: "CF smoke note", color: "blue", x: 12, y: 24, w: 160, h: 90 });

      const moveNote = await post("/api/objects/the_pinboard/calls/move_pin", {
        id: "cf-pinboard-move-smoke",
        space: "the_pinboard",
        args: [pin, 80, 96]
      }, session);
      expect(moveNote.status).toBe(200);
      expect(moveNote.body.observations).toContainEqual(expect.objectContaining({ type: "pin_moved", pin, x: 80, y: 96 }));

      const editNote = await post(`/api/objects/${encodeURIComponent(pin)}/calls/set_text`, {
        id: "cf-pinboard-edit-smoke",
        space: "the_pinboard",
        args: ["CF smoke edited"]
      }, session);
      expect(editNote.status).toBe(200);
      expect(editNote.body.observations).toContainEqual(expect.objectContaining({ type: "note_edited", note: pin, text: "CF smoke edited" }));

      const listed = await post("/api/objects/the_pinboard/calls/list_notes", { args: [] }, session);
      expect(listed.status).toBe(200);
      expect(listed.body.result).toContainEqual(expect.objectContaining({ id: pin, text: "CF smoke edited", color: "blue", x: 80, y: 96 }));

      const pinboardWorld = await (wooObjects.get("the_pinboard") as any).getWorld("the_pinboard") as WooWorld;
      const hostOnlyPin = pinboardWorld.createRuntimeObject("$pin", "$wiz", "the_pinboard", {
        progr: "$wiz",
        location: "the_pinboard",
        name: "sticky note",
        description: "A sticky note."
      });
      pinboardWorld.setProp(hostOnlyPin, "text", "host-only pinboard note");
      pinboardWorld.setProp(hostOnlyPin, "color", "green");
      pinboardWorld.setProp("the_pinboard", "layout", {
        ...(pinboardWorld.getProp("the_pinboard", "layout") as Record<string, WooValue>),
        [hostOnlyPin]: { x: 42, y: 84, w: 180, h: 110, z: 99 }
      });
      const listedAfterHostOnlyPin = await post("/api/objects/the_pinboard/calls/list_notes", { args: [] }, session);
      expect(listedAfterHostOnlyPin.status).toBe(200);
      expect(listedAfterHostOnlyPin.body.result).toContainEqual(expect.objectContaining({
        id: hostOnlyPin,
        text: "host-only pinboard note",
        color: "green",
        x: 42,
        y: 84
      }));

      await (env.WOO as unknown as FakeDurableObjectNamespace).get({ name: "the_outline" }).fetch(await signInternalRequest(env, new Request("https://woo.internal/healthz", {
        headers: { "x-woo-host-key": "the_outline" }
      })));
      const outlineWorld = await (wooObjects.get("the_outline") as any).getWorld("the_outline") as WooWorld;
      const hostOnlyItem = outlineWorld.createRuntimeObject("$outline_item", "$wiz", "the_outline", {
        progr: "$wiz",
        location: "the_outline",
        name: ""
      });
      outlineWorld.setProp(hostOnlyItem, "parent", null);
      outlineWorld.setProp(hostOnlyItem, "position", 1);
      outlineWorld.setProp(hostOnlyItem, "text", "host-only outline item");
      const listedOutline = await post("/api/objects/the_outline/calls/list_items", { args: [] }, session);
      expect(listedOutline.status).toBe(200);
      expect(listedOutline.body.result).toContainEqual(expect.objectContaining({
        id: hostOnlyItem,
        text: "host-only outline item",
        index: 0
      }));
    } finally {
      logSpy.mockRestore();
      directoryState.close();
      for (const state of wooStates.values()) state.close();
    }
  });

  it("refreshes live host-scoped support classes from the gateway seed", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const wooStates = new Map<string, FakeDurableObjectState>();
    const wooObjects = new Map<string, PersistentObjectDO>();
    let env: Env;
    const wooNamespace = new FakeDurableObjectNamespace((name) => {
      let object = wooObjects.get(name);
      if (!object) {
        const state = new FakeDurableObjectState(name);
        wooStates.set(name, state);
        object = new PersistentObjectDO(state as unknown as DurableObjectState, env);
        wooObjects.set(name, object);
      }
      return object;
    });
    env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-host-refresh-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "chat,demoworld,note,blocks-demo",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: wooNamespace,
      COMMIT_SCOPE: fakeCommitScopeNamespace()
    } as unknown as Env;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    async function post(path: string, body: Record<string, unknown>, session?: string): Promise<{ status: number; body: Record<string, unknown> }> {
      const response = await worker.fetch(new Request(`https://woo.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(session ? { authorization: `Session ${session}` } : {})
        },
        body: JSON.stringify(body)
      }), env, {});
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    }

    try {
      const guestAuth = await post("/api/auth", { token: "guest:cf-host-refresh" });
      expect(guestAuth.status).toBe(200);
      const guestSession = String(guestAuth.body.session);
      const enterChat = await post("/api/objects/the_chatroom/calls/enter", { args: [] }, guestSession);
      expect(enterChat.status).toBe(200);
      const goDeck = await post("/api/objects/the_chatroom/calls/southeast", { args: [] }, guestSession);
      expect(goDeck.status).toBe(200);
      await (env.WOO as unknown as FakeDurableObjectNamespace).get({ name: "the_deck" }).fetch(await signInternalRequest(env, new Request("https://woo.internal/healthz", {
        headers: { "x-woo-host-key": "the_deck" }
      })));

      const gatewayWorld = await (wooObjects.get("world") as any).getWorld("world") as WooWorld;
      const deckWorld = await (wooObjects.get("the_deck") as any).getWorld("the_deck") as WooWorld;
      expect(deckWorld.objects.has("$note")).toBe(true);
      expect(installVerb(deckWorld, "$note", "title", `verb :title() rxd {
  return this.name;
}`, deckWorld.ownVerb("$note", "title")?.version ?? null).ok).toBe(true);
      deckWorld.createObject({ id: "cf_live_deck_note", name: "Deck note", parent: "$note", owner: "$wiz", location: "$wiz", anchor: "the_deck" });
      deckWorld.setProp("cf_live_deck_note", "name", "Deck note");
      gatewayWorld.createObject({ id: "cf_live_deck_note", name: "Deck note", parent: "$note", owner: "$wiz", location: "$wiz", anchor: "the_deck" });
      gatewayWorld.setProp("cf_live_deck_note", "name", "Deck note");
      const staleTitle = await deckWorld.directCall("cf-live-note-stale", "$wiz", "cf_live_deck_note", "title", []);
      expect(staleTitle).toMatchObject({ op: "result", result: "Deck note" });

      expect(installVerb(gatewayWorld, "$note", "title", `verb :title() rxd {
  return "LIVE " + this.name;
}`, gatewayWorld.ownVerb("$note", "title")?.version ?? null).ok).toBe(true);
      const gatewaySeed = gatewayWorld.exportHostScopedWorld("the_deck");
      expect(gatewaySeed.objects.map((obj) => obj.id)).toContain("$note");
      expect(gatewaySeed.objects.find((obj) => obj.id === "$note")?.verbs.find((verb) => verb.name === "title")?.source).toContain("LIVE");

      const wizardAuth = await post("/api/auth", { token: "wizard:cf-host-refresh-token" });
      expect(wizardAuth.status).toBe(200);
      const refreshed = await post("/api/admin/refresh-host-seeds", { hosts: ["the_deck"] }, String(wizardAuth.body.session));
      expect(refreshed.status).toBe(200);
      expect(refreshed.body).toMatchObject({
        ok: true,
        refreshed: [expect.objectContaining({ host: "the_deck", changed: true })]
      });
      expect(deckWorld.objects.has("cf_live_deck_note")).toBe(true);
      expect(deckWorld.ownVerb("$note", "title")?.source).toContain("LIVE");
      const repairedTitle = await deckWorld.directCall("cf-live-note-repaired", "$wiz", "cf_live_deck_note", "title", []);
      expect(repairedTitle).toMatchObject({ op: "result", result: "LIVE Deck note" });

      const deckState = wooStates.get("the_deck");
      expect(deckState).toBeDefined();
      const reloadedDeck = new PersistentObjectDO(deckState as unknown as DurableObjectState, env);
      wooObjects.set("the_deck", reloadedDeck);
      const reloadedDeckWorld = await (reloadedDeck as any).getWorld("the_deck") as WooWorld;
      const reloadedTitle = await reloadedDeckWorld.directCall("cf-live-note-reloaded", "$wiz", "cf_live_deck_note", "title", []);
      expect(reloadedTitle).toMatchObject({ op: "result", result: "LIVE Deck note" });

      const second = await post("/api/admin/refresh-host-seeds", { hosts: ["missing_host", "the_deck"] }, String(wizardAuth.body.session));
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({
        ok: true,
        refreshed: [expect.objectContaining({ host: "the_deck", changed: false })],
        skipped: [expect.objectContaining({ host: "missing_host", reason: "unmatched_host" })]
      });
    } finally {
      logSpy.mockRestore();
      directoryState.close();
      for (const state of wooStates.values()) state.close();
    }
  });

  it("stores host-seed KV entries without bytecode and restores bytecode on satellite cold-load", async () => {
    const harness = createHostSeedKvHarness();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { payload } = await harness.publishHostSeed("the_chatroom");
      expect(payload).toMatchObject({
        kind: "woo.host_seed.kv.bytecode_free.v1",
        digest: expect.any(String),
        seed: expect.any(Object),
        bytecode_hashes: expect.any(Array)
      });
      expect(payload.bytecode_hashes as unknown[]).not.toHaveLength(0);
      expect(hasJsonKey(payload.seed, "bytecode")).toBe(false);
      expect(hasJsonKey(payload.seed, "line_map")).toBe(true);

      harness.hostSeedFetches.length = 0;
      const healthz = await harness.wooNamespace.get({ name: "the_chatroom" }).fetch(await signInternalRequest(harness.env, new Request("https://woo.internal/healthz", {
        headers: { "x-woo-host-key": "the_chatroom" }
      })));
      expect(healthz.ok).toBe(true);
      expect(harness.hostSeedFetches).toEqual([]);
      const chatroomWorld = await (harness.wooObjects.get("the_chatroom") as any).getWorld("the_chatroom") as WooWorld;
      const verb = firstBytecodeVerb(chatroomWorld);
      expect(verb?.kind).toBe("bytecode");
      if (verb?.kind === "bytecode") expect(verb.bytecode.ops.length).toBeGreaterThan(0);
      expect(metricEvents(logSpy, "kv_catalog_reservoir_build")).toEqual([
        expect.objectContaining({ status: "ok", verbs: expect.any(Number) })
      ]);
    } finally {
      logSpy.mockRestore();
      harness.close();
    }
  });

  it("falls back to the authoritative host seed when stripped KV bytecode hashes cannot be restored", async () => {
    const harness = createHostSeedKvHarness();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { bytesKey, payload } = await harness.publishHostSeed("the_chatroom");
      const hashes = payload.bytecode_hashes as Array<Record<string, unknown>>;
      expect(hashes.length).toBeGreaterThan(0);
      hashes[0].hash = "not-the-bytecode-hash";
      await harness.kv.put(bytesKey, JSON.stringify(payload));

      harness.hostSeedFetches.length = 0;
      const healthz = await harness.wooNamespace.get({ name: "the_chatroom" }).fetch(await signInternalRequest(harness.env, new Request("https://woo.internal/healthz", {
        headers: { "x-woo-host-key": "the_chatroom" }
      })));
      expect(healthz.ok).toBe(true);
      expect(harness.hostSeedFetches).toContain("the_chatroom");
      expect(metricEvents(logSpy, "host_seed_kv_restore_miss")).toContainEqual(
        expect.objectContaining({ cache: "host_seed", host: "the_chatroom", reason: "hash_mismatch" })
      );
    } finally {
      logSpy.mockRestore();
      harness.close();
    }
  });

  it("rejects inline bytecode in a bytecode-free host-seed KV payload when the hash does not match", async () => {
    const harness = createHostSeedKvHarness();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { bytesKey, payload } = await harness.publishHostSeed("the_chatroom");
      injectMismatchedInlineBytecode(payload.seed, payload.bytecode_hashes as Array<Record<string, unknown>>);
      await harness.kv.put(bytesKey, JSON.stringify(payload));

      harness.hostSeedFetches.length = 0;
      const healthz = await harness.wooNamespace.get({ name: "the_chatroom" }).fetch(await signInternalRequest(harness.env, new Request("https://woo.internal/healthz", {
        headers: { "x-woo-host-key": "the_chatroom" }
      })));
      expect(healthz.ok).toBe(true);
      expect(harness.hostSeedFetches).toContain("the_chatroom");
    } finally {
      logSpy.mockRestore();
      harness.close();
    }
  });

  it("stores MCP gateway snapshot KV entries without bytecode and restores from the local catalog reservoir", async () => {
    const harness = createHostSeedKvHarness();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { payload } = await harness.publishMcpGatewayWorld("mcp-gateway-0");
      expect(payload).toMatchObject({
        kind: "woo.mcp_gateway_world.kv.bytecode_free.v1",
        digest: expect.any(String),
        world: expect.any(Object),
        bytecode_hashes: expect.any(Array)
      });
      expect(payload.bytecode_hashes as unknown[]).not.toHaveLength(0);
      expect(hasJsonKey(payload.world, "bytecode")).toBe(false);

      harness.mcpGatewayWorldFetches.length = 0;
      const healthz = await harness.wooNamespace.get({ name: "mcp-gateway-0" }).fetch(await signInternalRequest(harness.env, new Request("https://woo.internal/healthz", {
        headers: { "x-woo-host-key": "mcp-gateway-0" }
      })));
      expect(healthz.ok).toBe(true);
      expect(harness.mcpGatewayWorldFetches).toEqual([]);
      const shardWorld = await (harness.wooObjects.get("mcp-gateway-0") as any).getWorld("mcp-gateway-0") as WooWorld;
      const verb = firstBytecodeVerb(shardWorld);
      expect(verb?.kind).toBe("bytecode");
      if (verb?.kind === "bytecode") expect(verb.bytecode.ops.length).toBeGreaterThan(0);
    } finally {
      logSpy.mockRestore();
      harness.close();
    }
  });

  it("persists cold-load host seed repairs before a later refresh can consume them", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    const wooStates = new Map<string, FakeDurableObjectState>();
    const wooObjects = new Map<string, PersistentObjectDO>();
    let env: Env;
    const wooNamespace = new FakeDurableObjectNamespace((name) => {
      let object = wooObjects.get(name);
      if (!object) {
        const state = new FakeDurableObjectState(name);
        wooStates.set(name, state);
        object = new PersistentObjectDO(state as unknown as DurableObjectState, env);
        wooObjects.set(name, object);
      }
      return object;
    });
    env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-cold-host-refresh-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "chat,demoworld,note,blocks-demo",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: wooNamespace,
      COMMIT_SCOPE: fakeCommitScopeNamespace()
    } as unknown as Env;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    async function post(path: string, body: Record<string, unknown>, session?: string): Promise<{ status: number; body: Record<string, unknown> }> {
      const response = await worker.fetch(new Request(`https://woo.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(session ? { authorization: `Session ${session}` } : {})
        },
        body: JSON.stringify(body)
      }), env, {});
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    }

    try {
      const guestAuth = await post("/api/auth", { token: "guest:cf-cold-host-refresh" });
      expect(guestAuth.status).toBe(200);
      const guestSession = String(guestAuth.body.session);
      expect((await post("/api/objects/the_chatroom/calls/enter", { args: [] }, guestSession)).status).toBe(200);
      expect((await post("/api/objects/the_chatroom/calls/southeast", { args: [] }, guestSession)).status).toBe(200);
      await (env.WOO as unknown as FakeDurableObjectNamespace).get({ name: "the_deck" }).fetch(await signInternalRequest(env, new Request("https://woo.internal/healthz", {
        headers: { "x-woo-host-key": "the_deck" }
      })));

      const gatewayWorld = await (wooObjects.get("world") as any).getWorld("world") as WooWorld;
      const deckWorld = await (wooObjects.get("the_deck") as any).getWorld("the_deck") as WooWorld;
      expect(installVerb(deckWorld, "$note", "title", `verb :title() rxd {
  return this.name;
}`, deckWorld.ownVerb("$note", "title")?.version ?? null).ok).toBe(true);
      deckWorld.createObject({ id: "cf_cold_deck_note", name: "Cold note", parent: "$note", owner: "$wiz", location: "$wiz", anchor: "the_deck" });
      deckWorld.setProp("cf_cold_deck_note", "name", "Cold note");
      gatewayWorld.createObject({ id: "cf_cold_deck_note", name: "Cold note", parent: "$note", owner: "$wiz", location: "$wiz", anchor: "the_deck" });
      gatewayWorld.setProp("cf_cold_deck_note", "name", "Cold note");
      expect(installVerb(gatewayWorld, "$note", "title", `verb :title() rxd {
  return "LIVE " + this.name;
}`, gatewayWorld.ownVerb("$note", "title")?.version ?? null).ok).toBe(true);

      const deckState = wooStates.get("the_deck");
      expect(deckState).toBeDefined();
      const coldDeck = new PersistentObjectDO(deckState as unknown as DurableObjectState, env);
      wooObjects.set("the_deck", coldDeck);
      const coldDeckWorld = await (coldDeck as any).getWorld("the_deck") as WooWorld;
      expect(coldDeckWorld.ownVerb("$note", "title")?.source).toContain("LIVE");
      const coldTitle = await coldDeckWorld.directCall("cf-cold-note-repaired", "$wiz", "cf_cold_deck_note", "title", []);
      expect(coldTitle).toMatchObject({ op: "result", result: "LIVE Cold note" });

      const reloadedDeck = new PersistentObjectDO(deckState as unknown as DurableObjectState, env);
      wooObjects.set("the_deck", reloadedDeck);
      const reloadedDeckWorld = await (reloadedDeck as any).getWorld("the_deck") as WooWorld;
      const reloadedTitle = await reloadedDeckWorld.directCall("cf-cold-note-reloaded", "$wiz", "cf_cold_deck_note", "title", []);
      expect(reloadedTitle).toMatchObject({ op: "result", result: "LIVE Cold note" });
    } finally {
      logSpy.mockRestore();
      directoryState.close();
      for (const state of wooStates.values()) state.close();
    }
  });

  it("ends REST sessions and removes Directory session routes", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-session-end-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      DIRECTORY: undefined,
      WOO: new FakeDurableObjectNamespace((name) => {
        throw new Error(`unexpected Woo DO ${name}`);
      })
    } as unknown as Env;
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, env);
    (env as any).DIRECTORY = new FakeDurableObjectNamespace((name) => {
      if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
      return directory;
    });
    const gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);
    const directoryHealth = async (): Promise<Record<string, unknown>> => {
      const request = await signInternalRequest(env, new Request("https://woo.internal/healthz"));
      const response = await directory.fetch(request);
      return await response.json() as Record<string, unknown>;
    };

    try {
      const auth = await gateway.fetch(new Request("https://woo.test/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "guest:cf-session-end" })
      }));
      expect(auth.ok).toBe(true);
      const { session } = await auth.json() as { session: string };
      expect(await directoryHealth()).toMatchObject({ sessions: 1 });

      const ended = await gateway.fetch(new Request("https://woo.test/api/session", {
        method: "DELETE",
        headers: { authorization: `Session ${session}` }
      }));
      expect(ended.ok).toBe(true);
      expect(await ended.json()).toMatchObject({ ok: true, session });
      expect(await directoryHealth()).toMatchObject({ sessions: 0 });

      const staleMe = await gateway.fetch(new Request("https://woo.test/api/me", {
        headers: { authorization: `Session ${session}` }
      }));
      expect(staleMe.status).toBe(401);
    } finally {
      directoryState.close();
      gatewayState.close();
    }
  });

  it("revoke_api_key removes Directory routes for sessions minted from that key", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-apikey-revoke-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      DIRECTORY: undefined,
      WOO: undefined,
      COMMIT_SCOPE: fakeCommitScopeNamespace()
    } as unknown as Env;
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, env);
    (env as any).DIRECTORY = new FakeDurableObjectNamespace((name) => {
      if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
      return directory;
    });
    const gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);
    (env as any).WOO = new FakeDurableObjectNamespace((name) => {
      if (name !== "world") throw new Error(`unexpected Woo DO ${name}`);
      return gateway;
    });

    async function post(path: string, body: Record<string, unknown>, session?: string): Promise<{ status: number; body: Record<string, any> }> {
      const response = await worker.fetch(new Request(`https://woo.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(session ? { authorization: `Session ${session}` } : {})
        },
        body: JSON.stringify(body)
      }), env, {});
      return { status: response.status, body: await response.json() as Record<string, any> };
    }

    try {
      const auth = await post("/api/auth", { token: "wizard:cf-apikey-revoke-token" });
      expect(auth.status).toBe(200);
      const wizardSession = String(auth.body.session);

      const gatewayWorld = await (gateway as any).getWorld("world") as WooWorld;
      const key = gatewayWorld.ensureApiKey("$wiz", "$wiz", "revoke-route-key", "revoke-route-secret", "revoke-route");

      const apiAuth = await post("/api/auth", { token: `apikey:${key.id}:${key.secret}` });
      expect(apiAuth.status).toBe(200);
      const apiSession = String(apiAuth.body.session);

      const before = await post("/api/objects/%24system/calls/list_api_keys", { args: [] }, apiSession);
      expect(before.status).toBe(200);

      const revoked = await post("/api/objects/%24system/calls/revoke_api_key", { args: [key.id] }, wizardSession);
      expect(revoked.status).toBe(200);
      expect(revoked.body.result).toBe(true);

      const stale = await post("/api/objects/%24system/calls/list_api_keys", { args: [] }, apiSession);
      expect(stale.status).toBe(401);
      expect(stale.body.error).toMatchObject({ code: "E_NOSESSION" });

      const resolveRequest = await signInternalRequest({ WOO_INTERNAL_SECRET: "cf-test-secret" }, new Request("https://woo.test/resolve-session", {
        method: "POST",
        headers: { "content-type": "application/json", "x-woo-host-key": "world" },
        body: JSON.stringify({ session_id: apiSession })
      }));
      const resolved = await directory.fetch(resolveRequest);
      expect(resolved.status).toBe(200);
      expect(await resolved.json()).toMatchObject({ session: null });
    } finally {
      directoryState.close();
      gatewayState.close();
    }
  });

  it("create_api_key mints through the v2 REST envelope and the minted key authenticates", async () => {
    // End-to-end regression for the missing native-primitive-contract bug:
    // before the fix, /api/objects/%24system/calls/create_api_key failed with
    // E_RETRY/incomplete_transcript on woah, blocking any wizard-initiated
    // apikey rotation through REST.
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-apikey-mint-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      DIRECTORY: undefined,
      WOO: undefined,
      COMMIT_SCOPE: fakeCommitScopeNamespace()
    } as unknown as Env;
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, env);
    (env as any).DIRECTORY = new FakeDurableObjectNamespace((name) => {
      if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
      return directory;
    });
    const gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);
    (env as any).WOO = new FakeDurableObjectNamespace((name) => {
      if (name !== "world") throw new Error(`unexpected Woo DO ${name}`);
      return gateway;
    });

    async function post(path: string, body: Record<string, unknown>, session?: string): Promise<{ status: number; body: Record<string, any> }> {
      const response = await worker.fetch(new Request(`https://woo.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(session ? { authorization: `Session ${session}` } : {})
        },
        body: JSON.stringify(body)
      }), env, {});
      return { status: response.status, body: await response.json() as Record<string, any> };
    }

    try {
      const auth = await post("/api/auth", { token: "wizard:cf-apikey-mint-token" });
      expect(auth.status).toBe(200);
      const wizardSession = String(auth.body.session);

      const minted = await post("/api/objects/%24system/calls/create_api_key", { args: ["$wiz", "mint-from-rest"] }, wizardSession);
      expect(minted.status).toBe(200);
      expect(minted.body.result).toMatchObject({ actor: "$wiz", label: "mint-from-rest" });
      const id = String(minted.body.result.id);
      const secret = String(minted.body.result.secret);
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      expect(secret).toMatch(/^[0-9a-f]{64}$/);

      const apiAuth = await post("/api/auth", { token: `apikey:${id}:${secret}` });
      expect(apiAuth.status).toBe(200);
      expect(apiAuth.body).toMatchObject({ actor: "$wiz", token_class: "apikey" });
    } finally {
      directoryState.close();
      gatewayState.close();
    }
  });

  it("create_api_key_for_owner mints through the v2 REST envelope when the caller owns the target", async () => {
    // The owner-mint path is what $block:mint_apikey ultimately invokes.
    // This test exercises the chain through the v2 envelope so the contract
    // entry is validated end-to-end alongside the wizard-mint path above.
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-apikey-owner-mint-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      DIRECTORY: undefined,
      WOO: undefined,
      COMMIT_SCOPE: fakeCommitScopeNamespace()
    } as unknown as Env;
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, env);
    (env as any).DIRECTORY = new FakeDurableObjectNamespace((name) => {
      if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
      return directory;
    });
    const gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);
    (env as any).WOO = new FakeDurableObjectNamespace((name) => {
      if (name !== "world") throw new Error(`unexpected Woo DO ${name}`);
      return gateway;
    });

    async function post(path: string, body: Record<string, unknown>, session?: string): Promise<{ status: number; body: Record<string, any> }> {
      const response = await worker.fetch(new Request(`https://woo.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(session ? { authorization: `Session ${session}` } : {})
        },
        body: JSON.stringify(body)
      }), env, {});
      return { status: response.status, body: await response.json() as Record<string, any> };
    }

    try {
      const auth = await post("/api/auth", { token: "wizard:cf-apikey-owner-mint-token" });
      expect(auth.status).toBe(200);

      // Seed an owner actor and a target actor owned by them. The wizard
      // creates both; afterwards the owner authenticates and mints a key
      // bound to the target using the owner-mint path.
      const gatewayWorld = await (gateway as any).getWorld("world") as WooWorld;
      gatewayWorld.createObject({ id: "rest_block_owner", name: "Block Owner", parent: "$actor", owner: "$wiz" });
      gatewayWorld.createObject({ id: "rest_owned_block", name: "Owned Block", parent: "$actor", owner: "rest_block_owner" });
      const ownerCredential = gatewayWorld.ensureApiKey("$wiz", "rest_block_owner", "owner-key-id", "owner-key-secret", "owner-bootstrap");

      const ownerAuth = await post("/api/auth", { token: `apikey:${ownerCredential.id}:${ownerCredential.secret}` });
      expect(ownerAuth.status).toBe(200);
      const ownerSession = String(ownerAuth.body.session);

      const minted = await post("/api/objects/%24system/calls/create_api_key_for_owner", { args: ["rest_owned_block", "owner-mint-from-rest"] }, ownerSession);
      expect(minted.status).toBe(200);
      expect(minted.body.result).toMatchObject({ actor: "rest_owned_block", label: "owner-mint-from-rest" });

      const blockAuth = await post("/api/auth", { token: `apikey:${minted.body.result.id}:${minted.body.result.secret}` });
      expect(blockAuth.status).toBe(200);
      expect(blockAuth.body).toMatchObject({ actor: "rest_owned_block", token_class: "apikey" });

      // Non-owner cannot mint: a stranger session against the block raises E_PERM.
      gatewayWorld.createObject({ id: "rest_stranger_actor", name: "Stranger", parent: "$actor", owner: "$wiz" });
      const strangerCredential = gatewayWorld.ensureApiKey("$wiz", "rest_stranger_actor", "stranger-key-id", "stranger-key-secret", "stranger");
      const strangerAuth = await post("/api/auth", { token: `apikey:${strangerCredential.id}:${strangerCredential.secret}` });
      const strangerSession = String(strangerAuth.body.session);
      const denied = await post("/api/objects/%24system/calls/create_api_key_for_owner", { args: ["rest_owned_block", "stranger-mint"] }, strangerSession);
      expect(denied.body.error).toMatchObject({ code: "E_PERM" });
    } finally {
      directoryState.close();
      gatewayState.close();
    }
  });

  it("publishes Worker-installed self-hosted tap objects before serving host seeds", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    let gateway: PersistentObjectDO;
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-tap-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: new FakeDurableObjectNamespace((name) => {
        if (name !== "world") throw new Error(`unexpected Woo DO ${name}`);
        return gateway;
      })
    } as unknown as Env;
    gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const sha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const manifest = {
        name: "cf-route-demo",
        version: "1.0.0",
        spec_version: "v1",
        license: "MIT",
        classes: [
          {
            local_name: "$cf_route_room",
            parent: "$space",
            description: "Self-hosted space class installed through the Worker tap path.",
            properties: []
          }
        ],
        seed_hooks: [
          {
            kind: "create_instance",
            class: "$cf_route_room",
            as: "cf_route_room_1",
            name: "CF Route Room",
            description: "A self-hosted room installed from a mocked GitHub tap.",
            properties: {
              next_seq: 1,
              subscribers: [],
              last_snapshot_seq: 0,
              host_placement: "self"
            }
          }
        ]
      };
      const readme = `---\nname: cf-route-demo\nversion: 1.0.0\nspec_version: v1\nlicense: MIT\n---\n\n# CF Route Demo\n`;
      if (url === "https://api.github.com/repos/hughpyle/woo-libs/commits/cf-route-demo-v1.0.0") {
        return new Response(JSON.stringify({ sha }), { headers: { "content-type": "application/json" } });
      }
      if (url === `https://raw.githubusercontent.com/hughpyle/woo-libs/${sha}/catalogs/cf-route-demo/manifest.json`) {
        return new Response(JSON.stringify(manifest), { headers: { "content-type": "application/json" } });
      }
      if (url === `https://raw.githubusercontent.com/hughpyle/woo-libs/${sha}/catalogs/cf-route-demo/README.md`) {
        return new Response(readme, { headers: { "content-type": "text/markdown" } });
      }
      return new Response("", { status: 404, statusText: "Not Found" });
    });

    try {
      const auth = await gateway.fetch(new Request("https://woo.test/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "wizard:cf-tap-token" })
      }));
      expect(auth.ok).toBe(true);
      const authBody = await auth.json() as { session: string };

      const install = await gateway.fetch(new Request("https://woo.test/api/tap/install", {
        method: "POST",
        headers: {
          "authorization": `Session ${authBody.session}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          tap: "hughpyle/woo-libs",
          catalog: "cf-route-demo",
          ref: "cf-route-demo-v1.0.0"
        })
      }));
      expect(install.ok).toBe(true);
      const installBody = await install.json() as { op?: string; seq?: number };
      expect(installBody).toMatchObject({ op: "applied", seq: 1 });
      expect(logs.some((line) => line.includes("woo.catalog") && line.includes("\"kind\":\"tap_install\""))).toBe(true);

      const routeRequest = await signInternalRequest(env, new Request("https://woo.internal/resolve-object", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "cf_route_room_1", fallback_host: "world" })
      }));
      const routeResponse = await directory.fetch(routeRequest);
      expect(routeResponse.ok).toBe(true);
      await expect(routeResponse.json()).resolves.toMatchObject({ id: "cf_route_room_1", host: "cf_route_room_1" });

      const seedRequest = await signInternalRequest(env, new Request("https://woo.internal/__internal/host-seed", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-woo-host-key": "world"
        },
        body: JSON.stringify({ host: "cf_route_room_1" })
      }));
      const seedResponse = await gateway.fetch(seedRequest);
      expect(seedResponse.ok).toBe(true);
      const seed = await seedResponse.json() as { objects?: Array<{ id: string }> };
      expect(seed.objects?.map((obj) => obj.id)).toContain("cf_route_room_1");
    } finally {
      logSpy.mockRestore();
      vi.unstubAllGlobals();
      directoryState.close();
      gatewayState.close();
    }
  });

  it("falls back to actor-keyed delivery when audience_sessions has only stale session ids", async () => {
    // Regression: production accumulated dozens of stale entries in
    // `<space>.session_subscribers` (old `session-N` ids from the counter
    // generator, kept alive by absent-logout client reuse). The audience
    // computation legitimately filled `audience_sessions` from the index, but
    // every id resolved to a missing socket on the live gateway, so room-wide
    // events (`said`, `entered`, `left`) reached zero clients even though
    // `audience_actors` had live participants reachable through
    // `socketsByActor`. broadcastLiveEvent must fall through to the actor map
    // when none of the session ids deliver, so a polluted index does not
    // black-hole the broadcast.
    const directoryState = new FakeDurableObjectState("directory");
    const gatewayState = new FakeDurableObjectState("world");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
    let gateway: PersistentObjectDO;
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "cf-broadcast-fallback-token",
      WOO_INTERNAL_SECRET: "cf-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      DIRECTORY: new FakeDurableObjectNamespace((name) => {
        if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
        return directory;
      }),
      WOO: new FakeDurableObjectNamespace((name) => {
        if (name !== "world") throw new Error(`unexpected Woo DO ${name}`);
        return gateway;
      })
    } as unknown as Env;
    gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);
    try {
      // Force world boot so internals (socketsByActor / socketsBySession) are
      // initialized before we reach into them. /healthz is the cheapest path.
      await gateway.fetch(new Request("https://woo.test/healthz"));

      type SentFrame = string;
      class FakeWebSocket { readyState = 1; readonly sent: SentFrame[] = []; send(data: string): void { this.sent.push(data); } }

      const liveActorWs = new FakeWebSocket();
      const internals = gateway as unknown as {
        socketsByActor: Map<ObjRef, Set<unknown>>;
        socketsBySession: Map<string, Set<unknown>>;
        broadcastLiveEvent: (
          world: WooWorld,
          frame: { op: "event"; observation: Record<string, unknown> },
          audience: ObjRef,
          audienceActors?: ObjRef[],
          audienceSessions?: string[],
          originator?: unknown
        ) => number;
        getWorld: (host?: string) => Promise<WooWorld>;
      };
      // Live participant has a socket on this DO, mapped only by actor.
      // No entry in socketsBySession for any of the stale ids the room's
      // session_subscribers would yield, mirroring the production state.
      internals.socketsByActor.set("guest_live_actor" as ObjRef, new Set([liveActorWs]));
      const world = await internals.getWorld("world");

      const observation = { type: "said", actor: "guest_live_actor", text: "hello", source: "the_chatroom", ts: Date.now() };
      const delivered = internals.broadcastLiveEvent(
        world,
        { op: "event", observation },
        "the_chatroom" as ObjRef,
        ["guest_live_actor" as ObjRef],
        ["session-stale-1", "session-stale-2", "session-stale-3"]
      );

      expect(delivered).toBe(1);
      expect(liveActorWs.sent).toHaveLength(1);
      expect(JSON.parse(liveActorWs.sent[0])).toEqual({ op: "event", observation });

      // Sanity check the positive case still works: when the session map
      // already covers the live participant, fallback isn't needed and the
      // session lookup delivers on its own (no double-send).
      liveActorWs.sent.length = 0;
      internals.socketsBySession.set("session-live", new Set([liveActorWs]));
      const deliveredViaSession = internals.broadcastLiveEvent(
        world,
        { op: "event", observation },
        "the_chatroom" as ObjRef,
        ["guest_live_actor" as ObjRef],
        ["session-live", "session-stale-1"]
      );
      expect(deliveredViaSession).toBe(1);
      expect(liveActorWs.sent).toHaveLength(1);
    } finally {
      directoryState.close();
      gatewayState.close();
    }
  });

  it("emits storage_direct_write metrics for log, snapshot, truncate, and tombstone writes", async () => {
    const state = new FakeDurableObjectState();
    const events: Array<{ kind: string; what?: string; rows?: number }> = [];
    try {
      const repo = new CFObjectRepository(state as unknown as DurableObjectState, (event) => {
        events.push({ kind: event.kind, what: (event as { what?: string }).what, rows: (event as { rows?: number }).rows });
      });
      const world = createWorld({ repository: repo });
      const session = world.auth("guest:cf-write-metrics");
      const applied = await callInDubspace(world, session.id, "cf-write-metric-frame",
        message(session.actor, "the_dubspace", "set_control", ["delay_1", "wet", 0.42]));
      expect(applied.op).toBe("applied");
      world.saveSnapshot("the_dubspace");
      const truncated = repo.truncateLog("the_dubspace", 1);
      expect(truncated).toBeGreaterThan(0);
      repo.saveTombstone("ulid_doomed", Date.now(), "test");

      const writes = events.filter((event) => event.kind === "storage_direct_write");
      const findWith = (what: string): { rows?: number } | undefined => writes.find((event) => event.what === what);
      const logAppend = findWith("log_append");
      expect(logAppend).toBeTruthy();
      expect(logAppend?.rows).toBe(4);
      const logOutcome = findWith("log_outcome");
      expect(logOutcome).toBeTruthy();
      expect(logOutcome?.rows).toBe(1);
      const snapshot = findWith("snapshot");
      expect(snapshot).toBeTruthy();
      expect(snapshot?.rows).toBe(1);
      const truncateMetric = findWith("log_truncate");
      expect(truncateMetric).toBeTruthy();
      expect(truncateMetric?.rows).toBe(truncated);
      const tombstone = findWith("tombstone");
      expect(tombstone).toBeTruthy();
      expect(tombstone?.rows).toBe(1);
    } finally {
      state.close();
    }
  });

  it("emits storage_full_save with non-zero rows when persistFullSnapshot rewrites the world", () => {
    const state = new FakeDurableObjectState();
    try {
      const repo = new CFObjectRepository(state as unknown as DurableObjectState);
      const fullSaves: Array<{ trigger?: string; rows?: number; objects?: number }> = [];
      const world = createWorld({
        repository: repo,
        metricsHook: (event) => {
          if (event.kind === "storage_full_save") {
            fullSaves.push({ trigger: event.trigger, rows: event.rows, objects: event.objects });
          }
        }
      });
      // Bootstrap fires the first save; ignore it. Importing the same snapshot
      // twice exercises both the explicit trigger label and the row-count path.
      fullSaves.length = 0;
      const snapshot = world.exportWorld();
      world.importWorld(snapshot);
      world.persistFullSnapshot();
      world.importWorld(snapshot);
      world.persistFullSnapshot("host_seed_apply");

      expect(fullSaves).toHaveLength(2);
      expect(fullSaves[0].trigger).toBe("persist_full_snapshot");
      expect(fullSaves[1].trigger).toBe("host_seed_apply");
      for (const event of fullSaves) {
        expect(event.rows ?? 0).toBeGreaterThan(0);
        expect(event.objects ?? 0).toBe(snapshot.objects.length);
      }
    } finally {
      state.close();
    }
  });
});

function testMcpShardHost(sessionId: string, shards: number): string {
  return `mcp-gateway-${testStableHash(sessionId) % shards}`;
}

function testStableHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// Focused regressions for the outbound-fetch limiter introduced to mitigate
// the Workers ~6-slot subrequest cap. These bypass routed worker.fetch() and
// poke the DO's private helpers directly via casts, so the invariants
// (cap, queue-abort, single-flight) are exercised in isolation rather than
// inferred from end-to-end behavior.
describe("PersistentObjectDO outbound-fetch limiter", () => {
  type Helper = {
    outFetchInFlight: number;
    outFetchQueue: Array<() => void>;
    outFetchInflight: Map<string, Promise<unknown>>;
    acquireOutFetchSlot(signal?: AbortSignal): Promise<void>;
    releaseOutFetchSlot(): void;
    outboundFetch(id: { name: string }, request: Request, signal?: AbortSignal): Promise<{ response: Response; queueMs: number }>;
    forwardInternal<T>(host: string, path: string, body: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<T>;
  };

  function defer<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
    let resolve!: (value: T) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  function buildDO(opts: {
    fetchHandler: (request: Request) => Promise<Response> | Response;
    concurrency?: string;
  }): { po: PersistentObjectDO; helper: Helper; cleanup: () => void } {
    const state = new FakeDurableObjectState("limiter-test");
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "limiter-test-token",
      WOO_INTERNAL_SECRET: "limiter-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      ...(opts.concurrency !== undefined ? { WOO_HOST_OUT_FETCH_CONCURRENCY: opts.concurrency } : {}),
      DIRECTORY: new FakeDurableObjectNamespace(() => ({ fetch: opts.fetchHandler })),
      WOO: new FakeDurableObjectNamespace(() => ({ fetch: opts.fetchHandler }))
    } as unknown as Env;
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env);
    return { po, helper: po as unknown as Helper, cleanup: () => state.close() };
  }

  function makeRequest(reqId?: number): Request {
    return new Request("https://woo.internal/__internal/probe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-woo-host-key": "probe",
        ...(reqId !== undefined ? { "x-test-req-id": String(reqId) } : {})
      },
      body: "{}"
    });
  }

  it("never exceeds the configured concurrency cap and processes the queue FIFO", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: number[] = [];
    const { helper, cleanup } = buildDO({
      concurrency: "2",
      fetchHandler: async (request) => {
        // Stamp the call-site's id (from the request header) into `order` at
        // dispatch time. If the queue were LIFO, the queued ids 2..5 would
        // arrive in reverse, even though the handler-assigned counter would
        // still appear monotonic — only call-site identity catches that.
        const reqId = Number(request.headers.get("x-test-req-id"));
        order.push(reqId);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return new Response(JSON.stringify({ ok: true, id: reqId }), { status: 200 });
      }
    });
    try {
      // Fire 6 concurrent fetches; cap=2 means at any moment ≤ 2 are in flight,
      // and the other 4 wait in the FIFO queue. Each call carries its own id
      // in the request header so we can verify the handler observed them in
      // call-site order.
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => helper.outboundFetch({ name: "h" }, makeRequest(i)))
      );
      expect(results).toHaveLength(6);
      expect(maxInFlight).toBe(2);
      // FIFO: handler observed the ids in registration order (0..5). LIFO
      // would have produced [0, 1, 5, 4, 3, 2].
      expect(order).toEqual([0, 1, 2, 3, 4, 5]);
      // Slot accounting back at zero, queue empty.
      expect(helper.outFetchInFlight).toBe(0);
      expect(helper.outFetchQueue).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("removes aborted queued waiters without firing their fetch and without leaking slots", async () => {
    let fetchCount = 0;
    const release = defer<void>();
    const { helper, cleanup } = buildDO({
      concurrency: "1",
      fetchHandler: async () => {
        fetchCount++;
        await release.promise;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    });
    try {
      // Saturate the slot: this fetch will block until release.
      const heldCall = helper.outboundFetch({ name: "h" }, makeRequest());

      // Two queued waiters with their own controllers; we'll abort both.
      const abortA = new AbortController();
      const abortB = new AbortController();
      const callA = helper.outboundFetch({ name: "h" }, makeRequest(), abortA.signal);
      const callB = helper.outboundFetch({ name: "h" }, makeRequest(), abortB.signal);
      // Eagerly attach a no-op catch so the rejection between abort() and the
      // explicit await isn't seen as an unhandled rejection by the runner.
      callA.catch(() => {});
      callB.catch(() => {});

      // One queued waiter that we DO let through.
      const callC = helper.outboundFetch({ name: "h" }, makeRequest());

      // Give acquire() time to enqueue all three.
      await new Promise((r) => setTimeout(r, 5));
      expect(helper.outFetchQueue).toHaveLength(3);
      expect(fetchCount).toBe(1); // only the held call has fetched

      // abort() with no reason sets signal.reason to a DOMException("AbortError"),
      // which is what callers naturally pass through when they cancel their own
      // request. Match on `name` rather than `code` (DOMException's code is a
      // number, not the string we use for wooError).
      abortA.abort();
      abortB.abort();
      await expect(callA).rejects.toMatchObject({ name: "AbortError" });
      await expect(callB).rejects.toMatchObject({ name: "AbortError" });
      // Aborted waiters are gone from the queue; only callC remains.
      expect(helper.outFetchQueue).toHaveLength(1);

      // Let the held fetch finish so callC can proceed.
      release.resolve();
      await heldCall;
      await callC;

      // Total fetches: held + callC = 2. Aborted A/B never fired.
      expect(fetchCount).toBe(2);
      // Slot accounting clean.
      expect(helper.outFetchInFlight).toBe(0);
      expect(helper.outFetchQueue).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("coalesces concurrent identical reads on a coalesceable path and clears the entry on settle", async () => {
    let fetchCount = 0;
    let nextSeq = 0;
    const { helper, cleanup } = buildDO({
      concurrency: "10", // generous; we want to prove coalesce, not the queue
      fetchHandler: async () => {
        fetchCount++;
        const seq = ++nextSeq;
        await new Promise((r) => setTimeout(r, 5));
        return new Response(JSON.stringify({ seq }), { status: 200 });
      }
    });
    try {
      // 5 concurrent identical reads to a coalesceable path → 1 underlying fetch,
      // all 5 callers see the same seq value.
      const reads = await Promise.all(
        Array.from({ length: 5 }, () => helper.forwardInternal<{ seq: number }>("hostA", "/__internal/object-summaries", { ids: ["x", "y"] }))
      );
      expect(fetchCount).toBe(1);
      expect(new Set(reads.map((r) => r.seq))).toEqual(new Set([1]));

      // After the in-flight Promise settled, the table should be cleared so a
      // subsequent identical call recomputes against fresh world state.
      expect(helper.outFetchInflight.size).toBe(0);
      const second = await helper.forwardInternal<{ seq: number }>("hostA", "/__internal/object-summaries", { ids: ["x", "y"] });
      expect(fetchCount).toBe(2);
      expect(second.seq).toBe(2);

      // Different host or different body should not coalesce with the previous key.
      const [a, b] = await Promise.all([
        helper.forwardInternal<{ seq: number }>("hostB", "/__internal/object-summaries", { ids: ["x", "y"] }),
        helper.forwardInternal<{ seq: number }>("hostA", "/__internal/object-summaries", { ids: ["different"] })
      ]);
      expect(fetchCount).toBe(4);
      expect(a.seq).not.toBe(b.seq);
    } finally {
      cleanup();
    }
  });

  it("times out a wedged mutating cross-host RPC under the write watchdog", async () => {
    // Mutating-route forever-hang protection: the comment-and-old-code path
    // had no deadline at all, so a wedged downstream parked the local slot
    // and the entire task chain forever. The write watchdog fires at
    // WOO_HOST_WRITE_TIMEOUT_MS and surfaces an E_TIMEOUT to the caller —
    // ambiguous remote state is preferable to indefinite hang.
    let aborted = false;
    let fetchSettled = false;
    const release = defer<void>();
    const state = new FakeDurableObjectState("write-watchdog-test");
    const env = {
      WOO_INITIAL_WIZARD_TOKEN: "limiter-test-token",
      WOO_INTERNAL_SECRET: "limiter-test-secret",
      WOO_AUTO_INSTALL_CATALOGS: "",
      WOO_HOST_WRITE_TIMEOUT_MS: "60",
      DIRECTORY: new FakeDurableObjectNamespace(() => ({ fetch: handler })),
      WOO: new FakeDurableObjectNamespace(() => ({ fetch: handler }))
    } as unknown as Env;
    async function handler(request: Request): Promise<Response> {
      request.signal.addEventListener("abort", () => { aborted = true; });
      try {
        await release.promise;
      } finally {
        fetchSettled = true;
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    const po = new PersistentObjectDO(state as unknown as DurableObjectState, env);
    const helper = po as unknown as Helper;
    try {
      await expect(
        helper.forwardInternal("hostA", "/__internal/remote-dispatch", { actor: "$wiz", verb: "say", args: ["hi"] })
      ).rejects.toMatchObject({ code: "E_TIMEOUT" });
      // The downstream fetch is aborted as part of the timeout, and the slot
      // is released so the next mutating call isn't blocked behind the wedge.
      expect(aborted).toBe(true);
      expect(helper.outFetchInFlight).toBe(0);
      expect(helper.outFetchQueue).toHaveLength(0);
    } finally {
      release.resolve();
      // Wait one microtask so the handler can settle without leaking warnings.
      await Promise.resolve();
      expect(fetchSettled).toBe(true);
      state.close();
    }
  });

  it("does not coalesce mutating routes even with byte-identical bodies", async () => {
    let fetchCount = 0;
    const { helper, cleanup } = buildDO({
      concurrency: "10",
      fetchHandler: async () => {
        fetchCount++;
        await new Promise((r) => setTimeout(r, 5));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    });
    try {
      // /__internal/remote-dispatch is a mutating route; coalescing would
      // silently drop intentional repeated writes.
      await Promise.all(
        Array.from({ length: 5 }, () => helper.forwardInternal("hostA", "/__internal/remote-dispatch", { actor: "$wiz", verb: "say", args: ["hi"] }))
      );
      expect(fetchCount).toBe(5);
      expect(helper.outFetchInflight.size).toBe(0);
    } finally {
      cleanup();
    }
  });
});
