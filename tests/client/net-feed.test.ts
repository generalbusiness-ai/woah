// NetFeed — the client projection consumer + optimistic echo overlay
// (Plan 002 Phase 4 item 4 chunk 1; plan §3.6). Injected transports: a
// routed fake fetch and a fake WebSocket pair, so the tests exercise the
// real wire vocabulary (gateway-do.ts /net-api + WS frames) without a
// browser or server.
import { describe, expect, it } from "vitest";
import {
  NetFeed,
  NetFeedError,
  type NetFeedObservationEvent,
  type NetFeedState,
  type NetSocketLike
} from "../../src/client/net-feed";
import { turnEchoId } from "../../src/net/turn-echo";

const API_KEY = "apikey:k1:secret-1";
const BASE = "https://woo.test";

// ---------------------------------------------------------------------------
// Fakes.

type FetchCall = { method: string; path: string; headers: Record<string, string>; body: unknown };

/** Routed fake fetch: `routes` maps "METHOD path-prefix" to a responder. */
function fakeFetch(routes: Record<string, (call: FetchCall) => { status?: number; body: unknown }>) {
  const calls: FetchCall[] = [];
  const impl = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const parsed = new URL(url);
    const call: FetchCall = {
      method: init?.method ?? "GET",
      path: parsed.pathname + parsed.search,
      headers: init?.headers ?? {},
      body: init?.body !== undefined ? JSON.parse(init.body) : undefined
    };
    calls.push(call);
    for (const [route, responder] of Object.entries(routes)) {
      const [method, prefix] = route.split(" ", 2);
      if (call.method === method && parsed.pathname === prefix) {
        const out = responder(call);
        return { status: out.status ?? 200, json: async () => out.body };
      }
    }
    return { status: 404, json: async () => ({ error: { code: "E_OBJNF", message: `no route ${call.path}` } }) };
  };
  return { impl, calls };
}

/** Fake WebSocket: instances collected on the shared `sockets` list; the
 * test drives onopen/onmessage/onclose and inspects `sent`. */
class FakeSocket implements NetSocketLike {
  static instances: FakeSocket[] = [];
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
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

  close(): void {
    this.closed = true;
  }

  // Test drivers.
  open(): void {
    this.onopen?.();
  }
  frame(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop(): void {
    this.onclose?.();
  }
}

const SESSION_ROUTE = {
  "POST /net-api/session": () => ({
    body: { session: "s_1", actor: "#alice", expires_at: 999, scope: "cluster:#alice" }
  }),
  // B3: NetFeed mints a single-use WS ticket over HTTP before connecting.
  "POST /net-api/ws-ticket": () => ({ body: { ticket: "wst_test", expires_at: 999 } })
};

/** An accepted gateway TurnResult body (the /net-api/turn reply shape). */
function acceptedTurnResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reply: { kind: "woo.net.commit_reply.v1", status: "accepted", scope: "room:hall", head: { seq: 5, hash: "h5" }, touched: [], post_state_version: "psv" },
    selection: { scope: "room:hall", riders: [] },
    envelopeBytes: 100,
    attempt: 1,
    trace: [],
    result: "ok",
    observations: [{ type: "waved", actor: "#alice" }],
    ...overrides
  };
}

function feedWith(
  routes: Record<string, (call: FetchCall) => { status?: number; body: unknown }>,
  options: { webSocket?: boolean } = {}
) {
  FakeSocket.instances = [];
  const { impl, calls } = fakeFetch(routes);
  const feed = new NetFeed({
    baseUrl: BASE,
    apiKey: API_KEY,
    fetchImpl: impl,
    ...(options.webSocket === false ? {} : { webSocketImpl: FakeSocket }),
    backoffMs: () => 0
  });
  return { feed, calls };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------

describe("NetFeed open()", () => {
  it("mints a session with the bearer credential and connects the socket", async () => {
    const { feed, calls } = feedWith(SESSION_ROUTE);
    const states: NetFeedState[] = [];
    feed.onState((state) => states.push(state));

    const opened = await feed.open();
    expect(opened).toEqual({ session: "s_1", actor: "#alice" });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.authorization).toBe(`Bearer ${API_KEY}`);

    // The socket carries session + token on the query (the one carrier a
    // browser WebSocket allows) and opens asynchronously.
    expect(FakeSocket.instances).toHaveLength(1);
    const socket = FakeSocket.instances[0];
    // B3: the socket connects with a single-use ticket, never the apikey.
    expect(socket.url).toBe("wss://woo.test/net-api/ws?ticket=wst_test");
    expect(feed.state().connection).toBe("opening");
    socket.open();
    expect(feed.state().connection).toBe("open");
    expect(states.some((state) => state.connection === "open")).toBe(true);
  });

  it("surfaces the gateway's named 401 refusal", async () => {
    const { feed } = feedWith({
      "POST /net-api/session": () => ({
        status: 401,
        body: { error: { code: "E_NOSESSION", message: "apikey secret rejected" } }
      })
    });
    await expect(feed.open()).rejects.toMatchObject({ code: "E_NOSESSION", status: 401 });
  });
});

describe("NetFeed turn() over WS", () => {
  it("places the intent on the echo overlay, sends the turn frame, settles on turn_result, and emits self observations", async () => {
    const { feed } = feedWith(SESSION_ROUTE);
    const events: NetFeedObservationEvent[] = [];
    feed.onObservation((event) => events.push(event));
    await feed.open();
    const socket = FakeSocket.instances[0];
    socket.open();

    const turn = feed.turn({ target: "#bob", verb: "wave", args: [] });
    await tick();
    // Echo overlay: the submitted INTENT is pending (not predicted cells
    // — the Phase-4 decision).
    expect(feed.state().pending).toMatchObject([{ target: "#bob", verb: "wave", args: [] }]);

    // Exactly the gateway's frame vocabulary, id doubling as the
    // idempotency key.
    expect(socket.sent).toHaveLength(1);
    const frame = socket.sent[0];
    expect(frame).toMatchObject({ type: "turn", target: "#bob", verb: "wave", args: [] });
    expect(frame.idempotency_key).toBe(frame.id);

    socket.frame({ type: "turn_result", id: frame.id, status: 200, ...acceptedTurnResult() });
    const outcome = await turn;
    expect(outcome.status).toBe("accepted");
    expect(outcome.result).toBe("ok");
    expect(outcome.observations).toEqual([{ type: "waved", actor: "#alice" }]);
    // Reply-settled: the overlay entry is gone and the observations were
    // emitted as source:"self" with the committed (scope, seq).
    expect(feed.state().pending).toHaveLength(0);
    expect(events).toEqual([
      {
        source: "self",
        scope: "room:hall",
        seq: 5,
        turn_id: String(frame.id),
        observation: { type: "waved", actor: "#alice" }
      }
    ]);
  });

  it("settles a terminal rejection without observations and drops the echo", async () => {
    const { feed } = feedWith(SESSION_ROUTE);
    await feed.open();
    const socket = FakeSocket.instances[0];
    socket.open();
    const turn = feed.turn({ target: "#bob", verb: "wave" });
    await tick();
    const id = socket.sent[0].id;
    socket.frame({
      type: "turn_result",
      id,
      status: 200,
      reply: { status: "rejected", scope: "room:hall", reason: "unauthorized", retryable: false, head: { seq: 5, hash: "h5" } },
      selection: { scope: "room:hall", riders: [] },
      attempt: 1,
      trace: []
    });
    const outcome = await turn;
    expect(outcome.status).toBe("rejected");
    expect(outcome.observations).toEqual([]);
    expect(feed.state().pending).toHaveLength(0);
  });

  it("omits observations on a detected replay (replayed:true)", async () => {
    const { feed } = feedWith(SESSION_ROUTE);
    const events: NetFeedObservationEvent[] = [];
    feed.onObservation((event) => events.push(event));
    await feed.open();
    const socket = FakeSocket.instances[0];
    socket.open();
    const turn = feed.turn({ target: "#bob", verb: "wave" });
    await tick();
    socket.frame({
      type: "turn_result",
      id: socket.sent[0].id,
      status: 200,
      ...acceptedTurnResult({ replayed: true, result: undefined, observations: undefined })
    });
    const outcome = await turn;
    expect(outcome.replayed).toBe(true);
    expect(outcome.observations).toEqual([]);
    expect(events).toHaveLength(0);
  });
});

describe("NetFeed turn() REST fallback", () => {
  it("uses POST /net-api/turn when the socket is down", async () => {
    const { feed, calls } = feedWith(
      { ...SESSION_ROUTE, "POST /net-api/turn": () => ({ body: acceptedTurnResult() }) },
      { webSocket: false }
    );
    const events: NetFeedObservationEvent[] = [];
    feed.onObservation((event) => events.push(event));
    await feed.open();
    const outcome = await feed.turn({ target: "#bob", verb: "wave", args: ["hi"] });
    expect(outcome.status).toBe("accepted");
    const turnCall = calls.find((call) => call.path === "/net-api/turn");
    expect(turnCall?.body).toMatchObject({ target: "#bob", verb: "wave", args: ["hi"], session: "s_1" });
    expect(typeof (turnCall?.body as Record<string, unknown>).idempotency_key).toBe("string");
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("self");
  });

  it("falls back to REST with the SAME idempotency key when the socket dies mid-turn", async () => {
    const { feed, calls } = feedWith({
      ...SESSION_ROUTE,
      "POST /net-api/turn": () => ({ body: acceptedTurnResult() })
    });
    await feed.open();
    const socket = FakeSocket.instances[0];
    socket.open();
    const turn = feed.turn({ target: "#bob", verb: "wave" });
    await tick();
    const wsKey = socket.sent[0].idempotency_key;
    socket.drop(); // no turn_result ever arrives
    const outcome = await turn;
    expect(outcome.status).toBe("accepted");
    const turnCall = calls.find((call) => call.path === "/net-api/turn");
    // CO2.5: the retry carries the same key, so a committed WS turn would
    // replay its recorded reply instead of double-committing.
    expect((turnCall?.body as Record<string, unknown>).idempotency_key).toBe(wsKey);
  });

  it("surfaces a named taxonomy error and drops the echo", async () => {
    const { feed } = feedWith(
      {
        ...SESSION_ROUTE,
        "POST /net-api/turn": () => ({
          status: 400,
          body: { error: { code: "E_BUDGET", message: "repair budget exhausted" } }
        })
      },
      { webSocket: false }
    );
    await feed.open();
    await expect(feed.turn({ target: "#bob", verb: "wave" })).rejects.toMatchObject({ code: "E_BUDGET" });
    expect(feed.state().pending).toHaveLength(0);
  });
});

describe("NetFeed observation frames (the peer path)", () => {
  async function openFeed() {
    const { feed } = feedWith(SESSION_ROUTE);
    const events: NetFeedObservationEvent[] = [];
    feed.onObservation((event) => events.push(event));
    await feed.open();
    const socket = FakeSocket.instances[0];
    socket.open();
    return { feed, socket, events };
  }

  it("emits peer frames as source:'peer'", async () => {
    const { socket, events } = await openFeed();
    socket.frame({ type: "observations", scope: "room:hall", seq: 7, observations: [{ type: "entered", actor: "#bob" }] });
    expect(events).toEqual([
      { source: "peer", scope: "room:hall", seq: 7, observation: { type: "entered", actor: "#bob" } }
    ]);
  });

  it("dedupes by (scope, seq) high-water: redeliveries and stale frames drop; other scopes are independent", async () => {
    const { socket, events } = await openFeed();
    const body = { type: "observations", scope: "room:hall", seq: 7, observations: [{ type: "entered", actor: "#bob" }] };
    socket.frame(body);
    socket.frame(body); // outbox at-least-once redelivery
    socket.frame({ ...body, seq: 6 }); // stale (ordered lane)
    socket.frame({ ...body, scope: "room:den", seq: 1 }); // independent scope
    socket.frame({ ...body, seq: 8 }); // genuinely new
    expect(events.map((event) => `${event.scope}:${event.seq}`)).toEqual([
      "room:hall:7",
      "room:den:1",
      "room:hall:8"
    ]);
  });

  it("drops the fanout echo of our OWN settled turn (gateway echo-dedupe lost its entry)", async () => {
    const { feed, socket, events } = await openFeed();
    const turn = feed.turn({ target: "#bob", verb: "wave" });
    await tick();
    socket.frame({ type: "turn_result", id: socket.sent[0].id, status: 200, ...acceptedTurnResult() });
    await turn; // settled at room:hall seq 5, observations emitted as self
    socket.frame({ type: "observations", scope: "room:hall", seq: 5, observations: [{ type: "waved", actor: "#alice" }] });
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("self");
    // ...and the high-water still advanced, so a redelivery also drops.
    socket.frame({ type: "observations", scope: "room:hall", seq: 5, observations: [{ type: "waved", actor: "#alice" }] });
    expect(events).toHaveLength(1);
  });

  it("buffers a self fanout that beats turn_result and renders the reply exactly once", async () => {
    const { feed, socket, events } = await openFeed();
    const turn = feed.turn({ target: "#bob", verb: "wave" });
    await tick();
    const turnId = socket.sent[0].id as string;

    // Gateway hibernation can lose its in-memory recentClientTurns entry.
    // The ordered fanout may then beat the reply; echo_id lets the client
    // recognize and hold this as its own echo instead of rendering it as peer.
    socket.frame({
      type: "observations",
      scope: "room:hall",
      seq: 5,
      echo_id: turnEchoId(turnId),
      observations: [{ type: "waved", actor: "#alice" }]
    });
    expect(events).toEqual([]);

    socket.frame({ type: "turn_result", id: turnId, status: 200, ...acceptedTurnResult() });
    const outcome = await turn;
    expect(outcome.observations).toEqual([{ type: "waved", actor: "#alice" }]);
    expect(events).toEqual([
      {
        source: "self",
        scope: "room:hall",
        seq: 5,
        turn_id: turnId,
        observation: { type: "waved", actor: "#alice" }
      }
    ]);

    // The modern turn-id guard is cross-scope; reply scope alone cannot
    // describe every observation fanout a multi-scope turn may produce.
    socket.frame({
      type: "observations",
      scope: "room:annex",
      seq: 9,
      echo_id: turnEchoId(turnId),
      observations: [{ type: "waved", actor: "#alice" }]
    });
    expect(events).toHaveLength(1);
  });

  it("uses a buffered self fanout when an idempotent replay omits observations", async () => {
    const { feed, socket, events } = await openFeed();
    const turn = feed.turn({ target: "#bob", verb: "wave" });
    await tick();
    const turnId = socket.sent[0].id as string;
    socket.frame({
      type: "observations",
      scope: "room:hall",
      seq: 5,
      echo_id: turnEchoId(turnId),
      observations: [{ type: "waved", actor: "#alice" }]
    });
    socket.frame({
      type: "turn_result",
      id: turnId,
      status: 200,
      ...acceptedTurnResult({ replayed: true, result: undefined, observations: undefined })
    });
    const outcome = await turn;
    expect(outcome.replayed).toBe(true);
    expect(outcome.observations).toEqual([{ type: "waved", actor: "#alice" }]);
    expect(events).toEqual([
      {
        source: "self",
        scope: "room:hall",
        seq: 5,
        turn_id: turnId,
        observation: { type: "waved", actor: "#alice" }
      }
    ]);
  });
});

describe("NetFeed reconnect", () => {
  it("re-registers with the same session after a drop (backoff), and recovers to open", async () => {
    const { feed } = feedWith(SESSION_ROUTE);
    await feed.open();
    const first = FakeSocket.instances[0];
    first.open();
    expect(feed.state().connection).toBe("open");

    first.drop();
    expect(feed.state().connection).toBe("reconnecting");
    await tick(); // backoff timer (backoffMs: () => 0)
    await tick(); // B3: the reconnect mints a WS ticket (async) before connecting
    expect(FakeSocket.instances).toHaveLength(2);
    const second = FakeSocket.instances[1];
    // The session cell persists; re-register is a fresh single-use ticket
    // (minted for the SAME session id — kickoff rule; B3: no apikey in URL).
    expect(second.url).toContain("ticket=");
    expect(second.url).not.toContain("apikey");
    second.open();
    expect(feed.state().connection).toBe("open");
  });

  it("re-open() supersedes the old socket: closed (not leaked) and its in-flight turn falls back to REST with the same key", async () => {
    const { feed, calls } = feedWith({
      ...SESSION_ROUTE,
      "POST /net-api/turn": () => ({ body: acceptedTurnResult() })
    });
    await feed.open();
    const first = FakeSocket.instances[0];
    first.open();
    const turn = feed.turn({ target: "#bob", verb: "wave" });
    await tick();
    const wsKey = first.sent[0].idempotency_key;

    await feed.open(); // fresh mint + fresh socket
    expect(first.closed).toBe(true);
    expect(FakeSocket.instances).toHaveLength(2);
    const outcome = await turn;
    expect(outcome.status).toBe("accepted");
    const turnCall = calls.find((call) => call.path === "/net-api/turn");
    expect((turnCall?.body as Record<string, unknown>).idempotency_key).toBe(wsKey);
    // The dead socket's own close event must not clobber the new one.
    first.drop();
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("close() stops reconnecting", async () => {
    const { feed } = feedWith(SESSION_ROUTE);
    await feed.open();
    const socket = FakeSocket.instances[0];
    socket.open();
    feed.close();
    expect(socket.closed).toBe(true);
    expect(feed.state().connection).toBe("closed");
    await tick();
    expect(FakeSocket.instances).toHaveLength(1); // no reconnect
  });
});

describe("NetFeed session re-mint (M10)", () => {
  /** A session route that hands out s_1, s_2, … on each mint, and a
   * ws-ticket route whose behaviour is caller-controlled per session id. */
  function expiringSessionRoutes(ticketFor: (session: string) => { status?: number; body: unknown }) {
    const state = { sessionMints: 0 };
    return {
      state,
      routes: {
        "POST /net-api/session": () => {
          state.sessionMints += 1;
          return { body: { session: `s_${state.sessionMints}`, actor: "#alice", expires_at: 999, scope: "cluster:#alice" } };
        },
        "POST /net-api/ws-ticket": (call: FetchCall) => ticketFor(String((call.body as { session?: string }).session))
      } as Record<string, (call: FetchCall) => { status?: number; body: unknown }>
    };
  }

  it("re-mints ONCE when the ws-ticket mint 401s on an expired session, then recovers to open", async () => {
    // s_1's ticket mint fails as if the session expired; the fresh s_2
    // mints a ticket fine. The treadmill (re-ticketing a dead session
    // forever) is replaced by a single re-mint + retry.
    const { state, routes } = expiringSessionRoutes((session) =>
      session === "s_1"
        ? { status: 401, body: { error: { code: "E_NOSESSION", message: "session expired" } } }
        : { body: { ticket: "wst_ok", expires_at: 999 } }
    );
    const { feed } = feedWith(routes);
    await feed.open();
    await tick(); // the re-mint's recursive connectSocket mints the s_2 ticket
    expect(state.sessionMints).toBe(2); // re-minted exactly once
    expect(feed.state().session).toBe("s_2");
    expect(FakeSocket.instances).toHaveLength(1); // only the s_2 attempt built a socket
    FakeSocket.instances[0].open();
    expect(feed.state().connection).toBe("open");
    expect(feed.state().error).toBeNull();
  });

  it("gives up with a surfaced terminal error when the re-mint makes no progress (revoked credential)", async () => {
    // Every session's ticket mint 401s: s_1 → re-mint s_2 → still 401 →
    // a second re-mint would spin, so the feed terminates instead. The
    // credential, not the session, is dead.
    const { state, routes } = expiringSessionRoutes(() => ({
      status: 401,
      body: { error: { code: "E_NOSESSION", message: "session expired" } }
    }));
    const { feed } = feedWith(routes);
    await feed.open();
    await tick();
    await tick();
    expect(state.sessionMints).toBe(2); // one initial + exactly one re-mint, then stop
    expect(feed.state().connection).toBe("closed");
    expect(feed.state().error).toBeInstanceOf(NetFeedError);
    expect(feed.state().error?.code).toBe("E_NOSESSION");
    expect(FakeSocket.instances).toHaveLength(0); // never got past a ticket mint
  });

  it("re-mints once and retries a REST turn (same idempotency key) when the session expired mid-turn", async () => {
    let turnCalls = 0;
    const { state, routes } = expiringSessionRoutes(() => ({ body: { ticket: "wst", expires_at: 999 } }));
    routes["POST /net-api/turn"] = () => {
      turnCalls += 1;
      return turnCalls === 1
        ? { status: 401, body: { error: { code: "E_NOSESSION", message: "session expired" } } }
        : { body: acceptedTurnResult() };
    };
    const { feed, calls } = feedWith(routes, { webSocket: false });
    await feed.open();
    const outcome = await feed.turn({ target: "#bob", verb: "wave" });
    expect(outcome.status).toBe("accepted");
    expect(state.sessionMints).toBe(2); // re-minted once under the in-flight turn
    expect(feed.state().session).toBe("s_2");
    const turnKeys = calls.filter((c) => c.path === "/net-api/turn").map((c) => (c.body as Record<string, unknown>).idempotency_key);
    expect(turnKeys).toHaveLength(2);
    expect(turnKeys[0]).toBe(turnKeys[1]); // CO2.5: same key across the retry
  });
});

describe("NetFeed reads + cache", () => {
  it("caches relation reads and invalidates on an applied observations frame", async () => {
    const members = [{ member: "s_2", body: { actor: "#bob" } }];
    const { feed, calls } = feedWith({
      ...SESSION_ROUTE,
      "GET /net-api/relation": () => ({ body: { relation: "session_presence", owner: "the_hall", members } })
    });
    await feed.open();
    const socket = FakeSocket.instances[0];
    socket.open();

    expect(await feed.relation("session_presence", "the_hall")).toEqual(members);
    expect(await feed.relation("session_presence", "the_hall")).toEqual(members);
    const reads = () => calls.filter((call) => call.path.startsWith("/net-api/relation")).length;
    expect(reads()).toBe(1); // burst collapsed

    // Change signal → re-read (correctness comes from the re-read; the
    // cache never holds across a change).
    socket.frame({ type: "observations", scope: "room:the_hall", seq: 1, observations: [{ type: "entered" }] });
    await feed.relation("session_presence", "the_hall");
    expect(reads()).toBe(2);
  });

  it("caches cell reads and invalidates when our own turn settles", async () => {
    const { feed, calls } = feedWith(
      {
        ...SESSION_ROUTE,
        "GET /net-api/cell": () => ({ body: { key: "object_live:#alice", cell: { value: { location: "the_hall" } } } }),
        "POST /net-api/turn": () => ({ body: acceptedTurnResult() })
      },
      { webSocket: false }
    );
    await feed.open();
    expect(await feed.cell("object_live:#alice")).toEqual({ value: { location: "the_hall" } });
    await feed.cell("object_live:#alice");
    const reads = () => calls.filter((call) => call.path.startsWith("/net-api/cell")).length;
    expect(reads()).toBe(1);
    await feed.turn({ target: "#alice", verb: "go", args: ["den"] });
    await feed.cell("object_live:#alice");
    expect(reads()).toBe(2);
  });
});

describe("NetFeed guards", () => {
  it("refuses turns before open()", async () => {
    const { feed } = feedWith(SESSION_ROUTE, { webSocket: false });
    await expect(feed.turn({ target: "#bob", verb: "wave" })).rejects.toBeInstanceOf(NetFeedError);
  });
});
