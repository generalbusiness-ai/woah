// NetFeed → framework adapter (Phase 4 item 4 chunk 2): feed events must
// be INDISTINGUISHABLE to the reducers registerCoreObservationHandlers
// registers from the v2 applied-frame path's deliveries. There is no
// existing test driving registerCoreObservationHandlers directly, so this
// tests the reducer surface honestly: a real ClientProjection +
// ObservationRegistry with the core handlers, fed once through the
// adapter (from a real NetFeed over fake transports) and once through
// the v2 delivered shape, asserting the SAME projection state.
import { describe, expect, it } from "vitest";
import {
  ClientProjection,
  createWooClientFramework,
  ObservationRegistry,
  registerCoreObservationHandlers
} from "../../src/client/framework";
import { wireNetFeed } from "../../src/client/net-feed-adapter";
import { NetFeed, type NetSocketLike } from "../../src/client/net-feed";

const API_KEY = "apikey:k1:secret-1";

/** Same fake pair as net-feed.test.ts, trimmed to what this file drives. */
class FakeSocket implements NetSocketLike {
  static instances: FakeSocket[] = [];
  readonly sent: Record<string, unknown>[] = [];
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {}
}

/** A NetFeed over fake transports, wired into `target` (defaults to a
 * bare ClientProjection + core-handler registry — the same reducer
 * surface WooClientFramework's constructor builds, without the DOM
 * parts). WooClientFramework itself satisfies NetFeedReducerTarget
 * structurally; the framework-parity test passes one in. */
async function openWiredFeed(target?: Parameters<typeof wireNetFeed>[0]) {
  FakeSocket.instances = [];
  const projection = new ClientProjection();
  if (!target) {
    const registry = new ObservationRegistry(projection);
    registerCoreObservationHandlers(registry);
    target = { observations: registry };
  }
  const feed = new NetFeed({
    baseUrl: "https://woo.test",
    apiKey: API_KEY,
    webSocketImpl: FakeSocket,
    backoffMs: () => 0,
    fetchImpl: async () => ({
      status: 200,
      json: async () => ({ session: "s_1", actor: "#alice", expires_at: null, scope: "cluster:#alice" })
    })
  });
  const unwire = wireNetFeed(target, feed);
  await feed.open();
  const socket = FakeSocket.instances[0];
  socket.onopen?.();
  return { feed, projection, socket, unwire };
}

function peerFrame(socket: FakeSocket, scope: string, seq: number, observations: Record<string, unknown>[]) {
  socket.onmessage?.({ data: JSON.stringify({ type: "observations", scope, seq, observations }) });
}

describe("wireNetFeed → registerCoreObservationHandlers reducers", () => {
  it("a peer `taken` observation patches the item's location to the actor — identically to the v2 delivered shape", async () => {
    const { projection, socket } = await openWiredFeed();
    const observation = { type: "taken", item: "obj_note", actor: "#bob" };
    peerFrame(socket, "room:the_hall", 1, [observation]);
    expect(projection.observe("obj_note")?.location).toBe("#bob");

    // Indistinguishability: the SAME observation through the v2
    // applied-frame delivered shape (ingestAppliedFrame's construction)
    // yields the same state on a fresh projection.
    const v2Projection = new ClientProjection();
    const v2Registry = new ObservationRegistry(v2Projection);
    registerCoreObservationHandlers(v2Registry);
    v2Registry.deliver(observation, { route: "sequenced", seq: 1, space: "the_hall", receivedAt: Date.now() });
    expect(v2Projection.observe("obj_note")?.location).toBe(projection.observe("obj_note")?.location);
  });

  it("a peer `dropped` observation with no room/source falls back to delivered.space — the room ref recovered from the CO15 room:<space> scope", async () => {
    const { projection, socket } = await openWiredFeed();
    peerFrame(socket, "room:the_hall", 1, [{ type: "dropped", item: "obj_note" }]);
    // The reducer's chain is obs.room ?? obs.source ?? delivered.space;
    // only the adapter's scope→space translation makes this patch land.
    expect(projection.observe("obj_note")?.location).toBe("the_hall");
  });

  it("self observations from a settled turn reply reduce through the same wiring", async () => {
    const { feed, projection, socket } = await openWiredFeed();
    const turn = feed.turn({ target: "obj_note", verb: "take" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.onmessage?.({
      data: JSON.stringify({
        type: "turn_result",
        id: socket.sent[0].id,
        status: 200,
        reply: { status: "accepted", scope: "room:the_hall", head: { seq: 2, hash: "h2" }, touched: [], post_state_version: "p" },
        selection: { scope: "room:the_hall", riders: [] },
        attempt: 1,
        trace: [],
        observations: [{ type: "taken", item: "obj_note", actor: "#alice" }]
      })
    });
    await turn;
    expect(projection.observe("obj_note")?.location).toBe("#alice");
  });

  it("`property_changed` reaches the canonical props layer (route:'both' handler)", async () => {
    const { projection, socket } = await openWiredFeed();
    peerFrame(socket, "room:the_hall", 1, [{ type: "property_changed", target: "obj_note", name: "text", value: "hello" }]);
    expect(projection.observe("obj_note")?.props.text).toBe("hello");
  });

  it("the full WooClientFramework satisfies the adapter target: note_edited parity with ingestAppliedFrame (the client-framework.test.ts fixture)", async () => {
    // The v2 reference run — the same fixture tests/client-framework.test.ts
    // drives through ingestAppliedFrame (core handlers only; the pinboard
    // catalog overlay handler is out of scope here).
    const v2 = createWooClientFramework();
    v2.ingestAppliedFrame({
      op: "applied",
      seq: 14,
      space: "the_pinboard",
      observations: [{ type: "note_edited", note: "note_1", text: "new\ntext" }]
    });
    expect(v2.observe("note_1")?.props.text).toBe("new\ntext");

    // The feed run: the SAME observation arrives as a peer frame from the
    // pinboard room's scope, wired straight into a full framework instance
    // — WooClientFramework IS a NetFeedReducerTarget, no shim.
    const ui = createWooClientFramework();
    const { socket } = await openWiredFeed(ui);
    peerFrame(socket, "room:the_pinboard", 14, [{ type: "note_edited", note: "note_1", text: "new\ntext" }]);
    expect(ui.observe("note_1")?.props.text).toBe(v2.observe("note_1")?.props.text);
  });

  it("unwire() stops delivery", async () => {
    const { projection, socket, unwire } = await openWiredFeed();
    unwire();
    peerFrame(socket, "room:the_hall", 1, [{ type: "taken", item: "obj_note", actor: "#bob" }]);
    expect(projection.observe("obj_note")?.location).toBeUndefined();
  });
});
