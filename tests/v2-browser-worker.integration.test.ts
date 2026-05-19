import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeIndexedDBFactory } from "./helpers/fake-indexeddb";
import { encodeEnvelope, decodeEnvelope, type ShadowEnvelope } from "../src/core/shadow-envelope";
import {
  createShadowBrowserClient,
  createShadowBrowserRelayShim,
  handleShadowBrowserStateTransferEnvelope,
  handleShadowBrowserTurnExecEnvelope,
  openShadowBrowserScope,
  receiveShadowBrowserEnvelopeReceipt,
  shadowBrowserTransportHello
} from "../src/core/shadow-browser-node";
import { createWorld } from "../src/core/bootstrap";
import type { EffectTranscript } from "../src/core/effect-transcript";
import { createShadowCommitScope, type ShadowCommitAccepted } from "../src/core/shadow-commit-scope";

describe("v2 browser worker integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    FakeWebSocket.instances.length = 0;
  });

  it("waits for open executable state and submits the first durable turn as a browser-built exec request", async () => {
    const posted: unknown[] = [];
    const scope = new FakeWorkerScope();
    vi.stubGlobal("self", scope);
    vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
    vi.stubGlobal("indexedDB", new FakeIndexedDBFactory());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "woo.test" });

    await import("../src/client/v2-browser-worker");

    const world = createWorld();
    const session = world.auth("guest:v2-browser-worker");
    world.setProp("the_dubspace", "operators", [session.actor]);
    const relay = createShadowBrowserRelayShim({
      node: "relay:v2-worker",
      scope: "the_dubspace",
      serialized: world.exportWorld()
    });
    const browser = createShadowBrowserClient({
      node: "browser:v2-worker",
      scope: "the_dubspace",
      actor: session.actor,
      session: session.id,
      relay,
      token: "token:v2-worker"
    });
    const opened = await openShadowBrowserScope(browser);

    scope.dispatch({
      kind: "connect",
      token: "token:v2-worker",
      node: browser.node,
      scope: browser.scope,
      actor: browser.actor,
      session: session.id
    });
    const socket = await waitForSocket();
    socket.open();
    socket.receive(encodeEnvelope(relayEnvelope(browser, "hello-1", "woo.transport.hello.v1", shadowBrowserTransportHello(browser))));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "transfer-1", opened.transfer.kind, opened.transfer)));

    scope.dispatch({
      kind: "call",
      id: "cold-dubspace-control",
      route: "sequenced",
      scope: "the_dubspace",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.22],
      persistence: "durable"
    });
    await sleep(20);
    expect(socket.sent).toHaveLength(0);

    socket.receive(encodeEnvelope(relayEnvelope(browser, "exec-state-1", opened.executable_transfer.kind, opened.executable_transfer)));
    await sleep(20);
    expect(socket.sent).toHaveLength(0);

    socket.receive(encodeEnvelope(relayEnvelope(browser, "ad-1", "woo.exec_capability_ad.shadow.v1", opened.ads[0])));
    const coldRequest = await waitForBrowserBuiltExecRequest(browser, socket);
    expect(coldRequest).toMatchObject({
      type: "woo.turn.exec.request.shadow.v1",
      body: {
        kind: "woo.turn.exec.request.shadow.v1",
        id: "cold-dubspace-control",
        call: {
          target: "the_dubspace",
          verb: "set_control"
        }
      }
    });
    expect((coldRequest.body as { selected_ad?: unknown }).selected_ad).toBeUndefined();

    const coldReply = await relayReply(browser, encodeEnvelope(coldRequest));
    socket.receive(encodeEnvelope(coldReply));
    await waitForMessage(posted, (message) => isLocalTurnPlanned(message, "cold-dubspace-control"));
    await waitForMessage(posted, (message) => isKind(message, "applied_frame"));

    scope.dispatch({
      kind: "call",
      id: "warm-dubspace-control",
      route: "sequenced",
      scope: "the_dubspace",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.33],
      persistence: "durable"
    });

    const warmRequest = await waitForBrowserBuiltExecRequest(browser, socket);
    expect(warmRequest).toMatchObject({
      type: "woo.turn.exec.request.shadow.v1",
      body: {
        kind: "woo.turn.exec.request.shadow.v1",
        id: "warm-dubspace-control",
        call: {
          target: "the_dubspace",
          verb: "set_control"
        }
      }
    });
    expect((warmRequest.body as { selected_ad?: unknown }).selected_ad).toBeUndefined();
    await waitForMessage(posted, (message) => isLocalTurnPlanned(message, "warm-dubspace-control"));
  });

  it("plans a same-actor durable chain from the tentative journal without waiting for authority", async () => {
    const posted: unknown[] = [];
    const scope = new FakeWorkerScope();
    vi.stubGlobal("self", scope);
    vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
    vi.stubGlobal("indexedDB", new FakeIndexedDBFactory());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "woo.test" });

    await import("../src/client/v2-browser-worker");

    const world = createWorld();
    const session = world.auth("guest:v2-browser-worker-journal");
    const relay = createShadowBrowserRelayShim({
      node: "relay:v2-worker-journal",
      scope: "the_pinboard",
      serialized: world.exportWorld()
    });
    const browser = createShadowBrowserClient({
      node: "browser:v2-worker-journal",
      scope: "the_pinboard",
      actor: session.actor,
      session: session.id,
      relay,
      token: "token:v2-worker-journal"
    });
    const opened = await openShadowBrowserScope(browser);

    scope.dispatch({
      kind: "connect",
      token: "token:v2-worker-journal",
      node: browser.node,
      scope: browser.scope,
      actor: browser.actor,
      session: session.id
    });
    const socket = await waitForSocket();
    socket.open();
    socket.receive(encodeEnvelope(relayEnvelope(browser, "hello-journal", "woo.transport.hello.v1", shadowBrowserTransportHello(browser))));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "transfer-journal", opened.transfer.kind, opened.transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "exec-state-journal", opened.executable_transfer.kind, opened.executable_transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "ad-journal", "woo.exec_capability_ad.shadow.v1", opened.ads[0])));

    scope.dispatch({
      kind: "call",
      id: "pinboard-enter-journal",
      route: "sequenced",
      scope: "the_pinboard",
      target: "the_pinboard",
      verb: "enter",
      args: [],
      persistence: "durable"
    });
    const enterRequest = await waitForBrowserBuiltExecRequest(browser, socket, "enter");
    expect(enterRequest).toMatchObject({
      type: "woo.turn.exec.request.shadow.v1",
      body: { call: { verb: "enter" } }
    });

    scope.dispatch({
      kind: "call",
      id: "pinboard-add-journal",
      route: "sequenced",
      scope: "the_pinboard",
      target: "the_pinboard",
      verb: "add_note",
      args: ["journal worker note", "yellow", 48, 48, 180, 110],
      persistence: "durable"
    });
    const addRepairs = { stateTransferRequests: 0 };
    const addRequest = await waitForBrowserBuiltExecRequest(browser, socket, "add_note", addRepairs);
    expect(addRepairs.stateTransferRequests).toBeLessThanOrEqual(1);
    expect(addRequest).toMatchObject({
      type: "woo.turn.exec.request.shadow.v1",
      body: { call: { verb: "add_note" } }
    });
    await waitForMessage(posted, (message) => isLocalTurnPlanned(message, "pinboard-add-journal"));

    socket.receive(encodeEnvelope(await relayReply(browser, encodeEnvelope(enterRequest))));
    await waitForMessage(posted, (message) => isKind(message, "applied_frame"));
    await waitForMessage(posted, (message) => isLocalTurnCommitted(message, "pinboard-enter-journal"));
    socket.receive(encodeEnvelope(await relayReply(browser, encodeEnvelope(addRequest))));
    await waitForMessage(posted, (message) => isLocalTurnPlanned(message, "pinboard-enter-journal"));
    await waitForMessage(posted, (message) => isLocalTurnCommitted(message, "pinboard-add-journal"));
  });

  it("plans a cold outliner add from the tentative journal with one repair", async () => {
    const posted: unknown[] = [];
    const scope = new FakeWorkerScope();
    vi.stubGlobal("self", scope);
    vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
    vi.stubGlobal("indexedDB", new FakeIndexedDBFactory());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "woo.test" });

    await import("../src/client/v2-browser-worker");

    const world = createWorld();
    const session = world.auth("guest:v2-browser-worker-outline-journal");
    const relay = createShadowBrowserRelayShim({
      node: "relay:v2-worker-outline-journal",
      scope: "the_outline",
      serialized: world.exportWorld()
    });
    const browser = createShadowBrowserClient({
      node: "browser:v2-worker-outline-journal",
      scope: "the_outline",
      actor: session.actor,
      session: session.id,
      relay,
      token: "token:v2-worker-outline-journal"
    });
    const opened = await openShadowBrowserScope(browser);

    scope.dispatch({
      kind: "connect",
      token: "token:v2-worker-outline-journal",
      node: browser.node,
      scope: browser.scope,
      actor: browser.actor,
      session: session.id
    });
    const socket = await waitForSocket();
    socket.open();
    socket.receive(encodeEnvelope(relayEnvelope(browser, "hello-outline-journal", "woo.transport.hello.v1", shadowBrowserTransportHello(browser))));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "transfer-outline-journal", opened.transfer.kind, opened.transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "exec-state-outline-journal", opened.executable_transfer.kind, opened.executable_transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "ad-outline-journal", "woo.exec_capability_ad.shadow.v1", opened.ads[0])));

    scope.dispatch({
      kind: "call",
      id: "outline-enter-journal",
      route: "sequenced",
      scope: "the_outline",
      target: "the_outline",
      verb: "enter",
      args: [],
      persistence: "durable"
    });
    await waitForBrowserBuiltExecRequest(browser, socket, "enter");

    scope.dispatch({
      kind: "call",
      id: "outline-add-journal",
      route: "sequenced",
      scope: "the_outline",
      target: "the_outline",
      verb: "add",
      args: ["journal worker outline"],
      persistence: "durable"
    });
    const addRepairs = { stateTransferRequests: 0 };
    const addRequest = await waitForBrowserBuiltExecRequest(browser, socket, "add", addRepairs);
    expect(addRepairs.stateTransferRequests).toBeLessThanOrEqual(1);
    expect(addRequest).toMatchObject({
      type: "woo.turn.exec.request.shadow.v1",
      body: { call: { verb: "add" } }
    });
    await waitForMessage(posted, (message) => isLocalTurnPlanned(message, "outline-add-journal"));
  });

  it("routes read-only live turns to authority before publishing a canonical result", async () => {
    const posted: unknown[] = [];
    const scope = new FakeWorkerScope();
    vi.stubGlobal("self", scope);
    vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
    vi.stubGlobal("indexedDB", new FakeIndexedDBFactory());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "woo.test" });

    await import("../src/client/v2-browser-worker");

    const world = createWorld();
    const session = world.auth("guest:v2-browser-worker-live-read");
    const relay = createShadowBrowserRelayShim({
      node: "relay:v2-worker-live-read",
      scope: "the_pinboard",
      serialized: world.exportWorld()
    });
    const browser = createShadowBrowserClient({
      node: "browser:v2-worker-live-read",
      scope: "the_pinboard",
      actor: session.actor,
      session: session.id,
      relay,
      token: "token:v2-worker-live-read"
    });
    const opened = await openShadowBrowserScope(browser);

    scope.dispatch({
      kind: "connect",
      token: "token:v2-worker-live-read",
      node: browser.node,
      scope: browser.scope,
      actor: browser.actor,
      session: session.id
    });
    const socket = await waitForSocket();
    socket.open();
    socket.receive(encodeEnvelope(relayEnvelope(browser, "hello-live-read", "woo.transport.hello.v1", shadowBrowserTransportHello(browser))));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "transfer-live-read", opened.transfer.kind, opened.transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "exec-state-live-read", opened.executable_transfer.kind, opened.executable_transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "ad-live-read", "woo.exec_capability_ad.shadow.v1", opened.ads[0])));

    // The browser's executable seed was opened from the empty board above.
    // Advance authority afterwards so a local-only list would incorrectly
    // finalize as empty, while the relay can return the durable note.
    const authoritativeText = "authority-only pinboard note";
    const entered = await world.call("seed-live-read-enter", session.id, "the_pinboard", {
      actor: session.actor,
      target: "the_pinboard",
      verb: "enter",
      args: []
    });
    expect(entered.op).toBe("applied");
    const added = await world.call("seed-live-read-note", session.id, "the_pinboard", {
      actor: session.actor,
      target: "the_pinboard",
      verb: "add_note",
      args: [authoritativeText, "yellow", 48, 48, 180, 110]
    });
    expect(added.op).toBe("applied");
    relay.commit_scope = createShadowCommitScope({
      node: relay.node,
      scope: "the_pinboard",
      serialized: world.exportWorld()
    });
    relay.executors.length = 0;
    relay.live_session_serialized.clear();
    relay.serialized_generation++;

    scope.dispatch({
      kind: "call",
      id: "pinboard-enter-before-local-list",
      route: "sequenced",
      scope: "the_pinboard",
      target: "the_pinboard",
      verb: "enter",
      args: [],
      persistence: "durable"
    });
    await waitForBrowserBuiltExecRequest(browser, socket, "enter");
    const sentAfterEnter = socket.sent.length;

    scope.dispatch({
      kind: "call",
      id: "pinboard-authority-list",
      route: "direct",
      scope: "the_pinboard",
      target: "the_pinboard",
      verb: "list_notes",
      args: [],
      persistence: "live"
    });

    const listRequest = await waitForBrowserBuiltExecRequest(browser, socket, "list_notes");
    expect(socket.sent.length).toBeGreaterThan(sentAfterEnter);
    expect(listRequest).toMatchObject({
      type: "woo.turn.exec.request.shadow.v1",
      body: { persistence: "live", call: { verb: "list_notes" } }
    });
    const optimisticResult = await waitForMessage(posted, (message) => {
      return isKind(message, "turn_result") &&
        (message as { frame?: { id?: unknown } }).frame?.id === "pinboard-authority-list" &&
        (message as { optimistic?: unknown }).optimistic === true;
    });
    expect(optimisticResult).toMatchObject({
      kind: "turn_result",
      frame: { op: "result", id: "pinboard-authority-list", result: [] },
      optimistic: true
    });
    const planned = await waitForMessage(posted, (message) => isLocalTurnPlanned(message, "pinboard-authority-list"));
    expect(planned).toMatchObject({ result_known: true });
    expect((planned as { local_only?: unknown }).local_only).toBeUndefined();

    socket.receive(encodeEnvelope(await relayReply(browser, encodeEnvelope(listRequest))));
    const authoritativeResult = await waitForMessage(posted, (message) => {
      if (!isKind(message, "turn_result")) return false;
      const candidate = message as { optimistic?: unknown; frame?: { id?: unknown; result?: unknown } };
      return candidate.optimistic !== true &&
        candidate.frame?.id === "pinboard-authority-list" &&
        JSON.stringify(candidate.frame.result).includes(authoritativeText);
    });
    expect(authoritativeResult).toMatchObject({
      kind: "turn_result",
      frame: {
        op: "result",
        id: "pinboard-authority-list",
        result: [expect.objectContaining({ text: authoritativeText })]
      }
    });
  });

  it("keeps the verified executable seed across a full projection overlay reset", async () => {
    const posted: unknown[] = [];
    const scope = new FakeWorkerScope();
    vi.stubGlobal("self", scope);
    vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
    vi.stubGlobal("indexedDB", new FakeIndexedDBFactory());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "woo.test" });

    await import("../src/client/v2-browser-worker");

    const world = createWorld();
    const session = world.auth("guest:v2-browser-worker-overlay-reset");
    const relay = createShadowBrowserRelayShim({
      node: "relay:v2-worker-overlay-reset",
      scope: "the_pinboard",
      serialized: world.exportWorld()
    });
    const browser = createShadowBrowserClient({
      node: "browser:v2-worker-overlay-reset",
      scope: "the_pinboard",
      actor: session.actor,
      session: session.id,
      relay,
      token: "token:v2-worker-overlay-reset"
    });
    const opened = await openShadowBrowserScope(browser);

    scope.dispatch({
      kind: "connect",
      token: "token:v2-worker-overlay-reset",
      node: browser.node,
      scope: browser.scope,
      actor: browser.actor,
      session: session.id
    });
    const socket = await waitForSocket();
    socket.open();
    socket.receive(encodeEnvelope(relayEnvelope(browser, "hello-overlay-reset", "woo.transport.hello.v1", shadowBrowserTransportHello(browser))));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "transfer-overlay-reset-open", opened.transfer.kind, opened.transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "exec-state-overlay-reset-open", opened.executable_transfer.kind, opened.executable_transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "ad-overlay-reset-open", "woo.exec_capability_ad.shadow.v1", opened.ads[0])));
    await waitForMessage(posted, (message) => isReadyStatus(message));

    posted.length = 0;
    socket.receive(encodeEnvelope(relayEnvelope(browser, "transfer-overlay-reset-boundary", opened.transfer.kind, opened.transfer)));
    expect(await waitForMessage(posted, (message) => isStatusWithExecutionTransfers(message, 1))).toMatchObject({
      status: { execution_transfers: 1, local_execution_ready: true }
    });

    scope.dispatch({
      kind: "call",
      id: "overlay-reset-enter",
      route: "sequenced",
      scope: "the_pinboard",
      target: "the_pinboard",
      verb: "enter",
      args: [],
      persistence: "durable"
    });
    await waitForBrowserBuiltExecRequest(browser, socket, "enter");
    expect(await waitForMessage(posted, (message) => isLocalTurnPlanned(message, "overlay-reset-enter"))).toMatchObject({
      kind: "local_turn_planned"
    });
  });

  it("checkpoints accepted transcript replay and reports compose-view stats", async () => {
    const posted: unknown[] = [];
    const scope = new FakeWorkerScope();
    vi.stubGlobal("self", scope);
    vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
    vi.stubGlobal("indexedDB", new FakeIndexedDBFactory());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "woo.test" });

    await import("../src/client/v2-browser-worker");

    const world = createWorld();
    const session = world.auth("guest:v2-browser-worker-checkpoint");
    world.setProp("the_dubspace", "operators", [session.actor]);
    const relay = createShadowBrowserRelayShim({
      node: "relay:v2-worker-checkpoint",
      scope: "the_dubspace",
      serialized: world.exportWorld()
    });
    const browser = createShadowBrowserClient({
      node: "browser:v2-worker-checkpoint",
      scope: "the_dubspace",
      actor: session.actor,
      session: session.id,
      relay,
      token: "token:v2-worker-checkpoint"
    });
    const opened = await openShadowBrowserScope(browser);

    scope.dispatch({
      kind: "connect",
      token: "token:v2-worker-checkpoint",
      node: browser.node,
      scope: browser.scope,
      actor: browser.actor,
      session: session.id
    });
    const socket = await waitForSocket();
    socket.open();
    socket.receive(encodeEnvelope(relayEnvelope(browser, "hello-checkpoint", "woo.transport.hello.v1", shadowBrowserTransportHello(browser))));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "transfer-checkpoint", opened.transfer.kind, opened.transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "exec-state-checkpoint", opened.executable_transfer.kind, opened.executable_transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "ad-checkpoint", "woo.exec_capability_ad.shadow.v1", opened.ads[0])));
    await waitForMessage(posted, (message) => isReadyStatus(message));

    for (let seq = 1; seq <= 8; seq++) {
      const accepted = syntheticAccepted("the_dubspace", seq);
      const transcript = syntheticCheckpointTranscript("the_dubspace", session.actor, session.id, seq);
      socket.receive(encodeEnvelope(relayEnvelope(browser, `accepted-checkpoint-${seq}`, "woo.turn.exec.reply.shadow.v1", {
        kind: "woo.turn.exec.reply.shadow.v1",
        ok: true,
        id: transcript.id,
        outcome: { result: null },
        transcript,
        commit: accepted
      })));
    }

    const checkpoint = await waitForMessage(posted, (message) => isKind(message, "shadow_browser_execution_checkpoint") || isKind(message, "error"));
    expect(checkpoint).not.toMatchObject({ kind: "error" });
    expect(checkpoint).toMatchObject({
      kind: "shadow_browser_execution_checkpoint",
      scope: "the_dubspace",
      transcript_count: 8,
      pruned: 8
    });

    scope.dispatch({
      kind: "call",
      id: "checkpoint-control-after",
      route: "sequenced",
      scope: "the_dubspace",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.99],
      persistence: "durable"
    });
    await waitForBrowserBuiltExecRequest(browser, socket, "set_control");
    expect(await waitForMessage(posted, (message) => isComposeViewFor(message, "checkpoint-control-after"))).toMatchObject({
      kind: "shadow_browser_compose_view",
      checkpoint_seq: 8,
      committed_transcript_count: 0
    });
  });
});

class FakeWorkerScope {
  private readonly listeners: Array<(event: MessageEvent) => void> = [];

  addEventListener(type: "message", listener: (event: MessageEvent) => void): void {
    if (type === "message") this.listeners.push(listener);
  }

  setTimeout(handler: () => void, timeout?: number): ReturnType<typeof setTimeout> {
    return setTimeout(handler, timeout);
  }

  clearTimeout(id: ReturnType<typeof setTimeout>): void {
    clearTimeout(id);
  }

  dispatch(data: unknown): void {
    for (const listener of this.listeners) listener({ data } as MessageEvent);
  }
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readyState = 0;
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  constructor(readonly url: string, readonly protocol: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(encoded: string): void {
    this.sent.push(encoded);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  receive(data: string): void {
    this.emit("message", { data });
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

async function waitForSocket(): Promise<FakeWebSocket> {
  return await waitFor(() => FakeWebSocket.instances[0]);
}

async function waitForBrowserBuiltExecRequest(
  browser: ReturnType<typeof createShadowBrowserClient>,
  socket: FakeWebSocket,
  verb?: string,
  stats?: { stateTransferRequests: number }
): Promise<ShadowEnvelope> {
  let cursor = socket.sent.length;
  for (;;) {
    await waitFor(() => socket.sent[cursor] ? true : undefined);
    const encoded = socket.sent[cursor++];
    const envelope = decodeEnvelope(encoded);
    if (envelope.type === "woo.state.transfer.request.shadow.v1") {
      if (stats) stats.stateTransferRequests++;
      const reply = handleShadowBrowserStateTransferEnvelope(browser, receiveShadowBrowserEnvelopeReceipt(browser, encoded));
      if (!reply) throw new Error("expected state transfer reply");
      socket.receive(encodeEnvelope(reply));
      continue;
    }
    if (verb && (envelope.body as { call?: { verb?: unknown } }).call?.verb !== verb) continue;
    return envelope;
  }
}

async function relayReply(browser: ReturnType<typeof createShadowBrowserClient>, encoded: string): Promise<ShadowEnvelope> {
  const receipt = receiveShadowBrowserEnvelopeReceipt(browser, encoded);
  const reply = await handleShadowBrowserTurnExecEnvelope(browser, receipt);
  if (!reply) throw new Error("expected relay turn reply");
  return reply;
}

function relayEnvelope<T>(
  browser: ReturnType<typeof createShadowBrowserClient>,
  id: string,
  type: string,
  body: T
): ShadowEnvelope<T> {
  return {
    v: 2,
    type,
    id,
    from: browser.relay.node,
    to: browser.node,
    actor: browser.actor,
    ...(browser.session ? { session: browser.session } : {}),
    auth: { mode: "session", token: browser.session_token ?? "" },
    body
  } as ShadowEnvelope<T>;
}

function syntheticAccepted(scope: string, seq: number): ShadowCommitAccepted {
  return {
    kind: "woo.commit.accepted.shadow.v1",
    id: `synthetic-checkpoint-${seq}`,
    position: {
      kind: "woo.scope_head.shadow.v1",
      scope,
      epoch: 1,
      seq,
      hash: `synthetic-head-${seq}`
    },
    receipt: {
      kind: "woo.commit_receipt.shadow.v1",
      id: `synthetic-checkpoint-${seq}`,
      route: "sequenced",
      scope,
      seq,
      transcript_hash: `synthetic-transcript-${seq}`,
      pre_state_hash: `synthetic-pre-${seq}`,
      post_state_hash: `synthetic-post-${seq}`,
      accepted: true,
      errors: []
    },
    transcript_hash: `synthetic-transcript-${seq}`,
    post_state_hash: `synthetic-post-${seq}`,
    observations: []
  };
}

function syntheticCheckpointTranscript(scope: string, actor: string, session: string, seq: number): EffectTranscript {
  const id = `synthetic-checkpoint-${seq}`;
  return {
    kind: "woo.effect_transcript.shadow.v1",
    id,
    route: "sequenced",
    scope,
    seq,
    session,
    call: {
      actor,
      target: scope,
      verb: "checkpoint_marker",
      args: [seq],
      body: undefined
    },
    reads: [],
    writes: [{
      cell: { kind: "prop", object: scope, name: "checkpoint_marker" },
      value: seq,
      op: "set",
      next: `checkpoint-marker:${seq}`
    }],
    creates: [],
    moves: [],
    observations: [],
    logicalInputs: [],
    untrackedEffects: [],
    complete: true,
    incompleteReasons: [],
    hash: `synthetic-transcript-${seq}`
  };
}

function isKind(message: unknown, kind: string): boolean {
  return Boolean(message && typeof message === "object" && (message as { kind?: unknown }).kind === kind);
}

function isLocalTurnDelegated(message: unknown, id: string): boolean {
  return isKind(message, "local_turn_delegated") && (message as { id?: unknown }).id === id;
}

function isLocalTurnPlanned(message: unknown, id: string): boolean {
  return isKind(message, "local_turn_planned") && (message as { id?: unknown }).id === id;
}

function isLocalTurnCommitted(message: unknown, id: string): boolean {
  return isKind(message, "local_turn_committed") &&
    Array.isArray((message as { ids?: unknown }).ids) &&
    ((message as { ids: unknown[] }).ids).includes(id);
}

function isComposeViewFor(message: unknown, id: string): boolean {
  return isKind(message, "shadow_browser_compose_view") && (message as { id?: unknown }).id === id;
}

function isReadyStatus(message: unknown): boolean {
  return isKind(message, "status") && (message as { status?: { local_execution_ready?: unknown } }).status?.local_execution_ready === true;
}

function isStatusWithExecutionTransfers(message: unknown, count: number): boolean {
  return isKind(message, "status") &&
    (message as { status?: { execution_transfers?: unknown } }).status?.execution_transfers === count;
}

async function waitForMessage(messages: unknown[], predicate: (message: unknown) => boolean): Promise<unknown> {
  return await waitFor(() => messages.find(predicate));
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for v2 browser worker integration condition");
    await sleep(5);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
