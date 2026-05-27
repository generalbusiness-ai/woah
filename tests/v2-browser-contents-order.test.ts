// Regression for the dev-server "drop -> commit_rejected, retry succeeds"
// report. After a sequenced turn mutates a room's `contents` (e.g. `enter`
// appends the actor), the next locally-planned turn that READS `contents`
// (`take`/`drop` iterate the room to match an object) recorded the read in the
// browser's live insertion order, while the committed authority stores
// `contents` sorted. The cell *version* hashes contents as a set
// (shadow-cell-version.ts sorts before hashing), so the versions matched but
// the order-sensitive value comparison rejected the turn as
// `read_version_mismatch`. A retry "seconds later" worked because the browser
// had resynced `contents` in server order by then. This drives the REAL browser
// worker through enter -> take -> drop on the_deck via browser-built exec
// requests and asserts all three commit on the first attempt.
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

describe("v2 browser contents-order commit", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    FakeWebSocket.instances.length = 0;
  });

  it("commits enter -> take -> drop on the_deck without a spurious contents read_version_mismatch", async () => {
    const posted: unknown[] = [];
    const scope = new FakeWorkerScope();
    vi.stubGlobal("self", scope);
    vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
    vi.stubGlobal("indexedDB", new FakeIndexedDBFactory());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "woo.test" });

    await import("../src/client/v2-browser-worker");

    const world = createWorld();
    const session = world.auth("guest:contents-order");
    const relay = createShadowBrowserRelayShim({
      node: "relay:contents-order",
      scope: "the_deck",
      serialized: world.exportWorld()
    });
    const browser = createShadowBrowserClient({
      node: "browser:contents-order",
      scope: "the_deck",
      actor: session.actor,
      session: session.id,
      relay,
      token: "token:contents-order"
    });
    const opened = await openShadowBrowserScope(browser);

    scope.dispatch({
      kind: "connect",
      token: "token:contents-order",
      node: browser.node,
      scope: browser.scope,
      actor: browser.actor,
      session: session.id
    });
    const socket = await waitForSocket();
    socket.open();
    socket.receive(encodeEnvelope(relayEnvelope(browser, "hello", "woo.transport.hello.v1", shadowBrowserTransportHello(browser))));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "transfer", opened.transfer.kind, opened.transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "exec-state", opened.executable_transfer.kind, opened.executable_transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "ad", "woo.exec_capability_ad.shadow.v1", opened.ads[0])));

    const runTurn = async (id: string, verb: string, args: unknown[]): Promise<ShadowEnvelope> => {
      scope.dispatch({ kind: "call", id, route: "sequenced", scope: "the_deck", target: "the_deck", verb, args, persistence: "durable" });
      const request = await waitForBrowserBuiltExecRequest(browser, socket, verb);
      const reply = await relayReply(browser, encodeEnvelope(request));
      socket.receive(encodeEnvelope(reply));
      // Let the worker fold the reply/frame into its local state before the
      // next turn plans (steady-state, fully synced between turns).
      await sleep(30);
      return reply;
    };

    const enterReply = await runTurn("contents-enter", "enter", []);
    expect(enterReply.body).toMatchObject({ ok: true });

    // The take is the second durable turn and reads the_deck.contents (whose
    // membership just changed). Before the fix this rejected with
    // read_version_mismatch on the_deck.contents.
    const takeReply = await runTurn("contents-take", "take", ["towel"]);
    expect(takeReply.body).toMatchObject({ ok: true });

    const dropReply = await runTurn("contents-drop", "drop", ["towel"]);
    expect(dropReply.body).toMatchObject({ ok: true });
  });
});

async function waitForSocket(): Promise<FakeWebSocket> {
  return await waitFor(() => FakeWebSocket.instances[0]);
}

async function waitForBrowserBuiltExecRequest(
  browser: ReturnType<typeof createShadowBrowserClient>,
  socket: FakeWebSocket,
  verb?: string
): Promise<ShadowEnvelope> {
  let cursor = socket.sent.length;
  for (;;) {
    await waitFor(() => socket.sent[cursor] ? true : undefined);
    const encoded = socket.sent[cursor++];
    const envelope = decodeEnvelope(encoded);
    if (envelope.type === "woo.state.transfer.request.shadow.v1") {
      const reply = handleShadowBrowserStateTransferEnvelope(browser, receiveShadowBrowserEnvelopeReceipt(browser, encoded));
      if (!reply) throw new Error("expected state transfer reply");
      socket.receive(encodeEnvelope(reply));
      continue;
    }
    if (envelope.type !== "woo.turn.exec.request.shadow.v1" && envelope.type !== "woo.turn.intent.request.shadow.v1") continue;
    const body = envelope.body as { verb?: unknown; call?: { verb?: unknown } };
    // Exec requests nest the verb under `call`; intents carry it directly.
    const envVerb = body.call?.verb ?? body.verb;
    if (verb && envVerb !== verb) continue;
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

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for v2 browser contents-order condition");
    await sleep(5);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
