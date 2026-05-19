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

describe("v2 browser worker integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    FakeWebSocket.instances.length = 0;
  });

  it("waits for the open execution ad, delegates the cold turn, then submits the next turn as a browser-built exec request", async () => {
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

    socket.receive(encodeEnvelope(relayEnvelope(browser, "ad-1", "woo.exec_capability_ad.shadow.v1", opened.ads[0])));
    const coldIntent = await waitForSent(socket, 1);
    expect(coldIntent).toMatchObject({
      type: "woo.turn.intent.request.shadow.v1",
      body: {
        kind: "woo.turn.intent.request.shadow.v1",
        selected_ad: "relay:v2-worker:executor",
        target: "the_dubspace",
        verb: "set_control"
      }
    });

    const coldReply = await relayReply(browser, socket.sent[0]);
    socket.receive(encodeEnvelope(coldReply));
    await waitForMessage(posted, (message) => isLocalTurnDelegated(message, "cold-dubspace-control"));
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

async function waitForSent(socket: FakeWebSocket, count: number): Promise<ShadowEnvelope> {
  await waitFor(() => socket.sent.length >= count ? true : undefined);
  return decodeEnvelope(socket.sent[count - 1]);
}

async function waitForBrowserBuiltExecRequest(browser: ReturnType<typeof createShadowBrowserClient>, socket: FakeWebSocket): Promise<ShadowEnvelope> {
  for (;;) {
    const envelope = await waitForSent(socket, socket.sent.length + 1);
    if (envelope.type === "woo.state.transfer.request.shadow.v1") {
      const reply = handleShadowBrowserStateTransferEnvelope(browser, receiveShadowBrowserEnvelopeReceipt(browser, socket.sent[socket.sent.length - 1]));
      if (!reply) throw new Error("expected state transfer reply");
      socket.receive(encodeEnvelope(reply));
      continue;
    }
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

function isKind(message: unknown, kind: string): boolean {
  return Boolean(message && typeof message === "object" && (message as { kind?: unknown }).kind === kind);
}

function isLocalTurnDelegated(message: unknown, id: string): boolean {
  return isKind(message, "local_turn_delegated") && (message as { id?: unknown }).id === id;
}

function isLocalTurnPlanned(message: unknown, id: string): boolean {
  return isKind(message, "local_turn_planned") && (message as { id?: unknown }).id === id;
}

async function waitForMessage(messages: unknown[], predicate: (message: unknown) => boolean): Promise<unknown> {
  return await waitFor(() => messages.find(predicate));
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 1500): Promise<T> {
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
