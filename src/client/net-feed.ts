/**
 * NetFeed — the client-side projection consumer + optimistic echo overlay
 * over the /net-api surface (Plan 002 Phase 4 item 4; plan §3.6, the B9
 * "narrow node" conclusion; kickoff notes/2026-07-07-net-phase4-kickoff.md).
 *
 * The client is a consumer of committed truth, not a parallel executor:
 * no VM, no divergent holder protocol. It holds
 *   - a session (POST /net-api/session) and a WebSocket (/net-api/ws)
 *     for observation push, with REST fallback for turns while the
 *     socket is down;
 *   - an ECHO overlay: the set of submitted-but-unsettled turn INTENTS,
 *     keyed by client turn id. **Phase-4 echo is intent-pending +
 *     reply-settled** — the overlay records what was asked (target/verb/
 *     args), never predicted cell writes. Plan §3.6's predicted-write
 *     overlay (applying the intent's predicted transcript writes via
 *     transcript.ts in-browser) is a documented LATER refinement: it
 *     needs the planner's view in the browser, and Phase 4's honest,
 *     simple contract is "the UI knows a turn is in flight; committed
 *     truth arrives on the reply". Rejection/settle both just drop the
 *     overlay entry.
 *   - a small TTL-less read cache over GET /net-api/cell and
 *     /net-api/relation.
 *
 * Wire contract (the shapes are defined by src/worker/net/gateway-do.ts —
 * the /net-api block and the WS frame vocabulary; this file redeclares
 * them minimally because src/client must not import src/worker):
 *
 *   POST /net-api/session {ttl_ms?}            → {session, actor, expires_at, scope}
 *   POST /net-api/turn {target,verb,args,session,idempotency_key} → TurnResult
 *   GET  /net-api/cell?key=                    → {key, cell}
 *   GET  /net-api/relation?relation=&owner=    → {relation, owner, members}
 *   GET  /net-api/ws?session=&token=           → WebSocket upgrade
 *     client→server frames: {type:"turn", id, target, verb, args, idempotency_key}
 *                           {type:"ping", id?}
 *     server→client frames: {type:"turn_result", id, status, ...TurnResult|{error}}
 *                           {type:"observations", scope, seq, observations}
 *                           {type:"pong", id} / {type:"error", id?, error}
 *   Errors everywhere: {error:{code, message, detail?}} — surfaced here
 *   as NetFeedError.
 *
 * Delivery/dedupe posture (matches the gateway's, kickoff item 3):
 *   - The submitting session receives its own turn's observations ON THE
 *     TURN REPLY (source:"self"); the gateway skips its sockets when the
 *     same turn's fanout arrives.
 *   - {type:"observations"} frames are peer traffic (source:"peer").
 *     Frames are per-scope ordered at the source (outbox FIFO lanes), so
 *     a frame at seq ≤ the scope's high-water is a redelivery — dropped.
 *   - Defensive self-echo guard: the gateway's echo dedupe is a bounded
 *     in-memory LRU that may lose entries (hibernation); if the fanout
 *     for OUR OWN committed turn does arrive as a frame, its (scope, seq)
 *     matches what the turn reply settled at, so a bounded set of
 *     self-settled (scope, seq) pairs drops it. The high-water alone
 *     cannot express this because the reply channel must never advance
 *     the FRAME high-water — that would drop an in-flight earlier peer
 *     frame on the ordered lane.
 *
 * Read-cache posture, documented per the kickoff: correctness comes from
 * RE-READ after change signals — the cache has no TTL and exists only to
 * collapse read bursts between changes. Invalidation is deliberately
 * COARSE: any applied observations frame and any settled own turn clears
 * the whole cache. (The client holds no anchor topology, so it cannot
 * attribute a cell key or relation owner to a scope; partial
 * invalidation by scope would risk silent staleness, and the cache's
 * only job is burst collapse.)
 *
 * Transports are constructor-injected so unit tests run without a
 * browser or server (tests/client/net-feed.test.ts).
 */

// ---------------------------------------------------------------------------
// Injectable transport surfaces (structural: satisfied by the browser
// globals and by test fakes alike).

export type NetFetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ status: number; json(): Promise<unknown> }>;

/** The subset of the WebSocket API the feed drives. Event-handler
 * properties (not addEventListener) so a fake is a plain object. */
export type NetSocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
};

export type NetWebSocketCtor = new (url: string) => NetSocketLike;

export type NetFeedOptions = {
  /** HTTP origin of the worker, e.g. "https://woo.example.com" (no
   * trailing slash needed; one is tolerated). The WS URL is derived by
   * swapping the scheme (http→ws / https→wss). */
  baseUrl: string;
  /** The full woo client credential: `apikey:<id>:<secret>` (the form
   * client-auth.ts parses). Sent as `authorization: Bearer <apiKey>` on
   * HTTP and as `?token=` on the WS upgrade (the one carrier a browser
   * WebSocket allows). */
  apiKey: string;
  fetchImpl?: NetFetchLike;
  webSocketImpl?: NetWebSocketCtor;
  /** Reconnect backoff by attempt (1-based). Default: 250ms doubling,
   * capped at 10s. Tests inject () => 0. */
  backoffMs?: (attempt: number) => number;
  /** Session TTL request, forwarded to POST /net-api/session (the
   * gateway clamps it). */
  ttlMs?: number;
  now?: () => number;
};

// ---------------------------------------------------------------------------
// Public event/state shapes.

export type NetFeedConnection = "idle" | "opening" | "open" | "reconnecting" | "closed";

/** One echo-overlay entry: a submitted intent awaiting its reply. */
export type NetPendingTurn = {
  turn_id: string;
  target: string;
  verb: string;
  args: unknown[];
  submitted_at: number;
};

export type NetFeedState = {
  connection: NetFeedConnection;
  session: string | null;
  actor: string | null;
  /** The echo overlay, in submission order. */
  pending: readonly NetPendingTurn[];
};

/** One observation, as the feed emits it to subscribers.
 * source:"self" — from our own turn's reply (already committed);
 * source:"peer" — from a fanout {type:"observations"} frame. */
export type NetFeedObservationEvent = {
  source: "self" | "peer";
  /** The committing scope (reply.scope for self, frame.scope for peer). */
  scope: string;
  /** The scope's committed seq (reply.head.seq / frame.seq); null when
   * the reply did not carry a head (defensive — it always should). */
  seq: number | null;
  /** The client turn id, present on self events only. */
  turn_id?: string;
  observation: Record<string, unknown>;
};

/** The settled outcome of one turn() call. `raw` is the gateway's full
 * TurnResult body (see gateway-do.ts) for callers that need the trace,
 * envelope bytes, or the CommitReply itself. */
export type NetTurnOutcome = {
  status: "accepted" | "rejected";
  /** The verb's return value / thrown error (accepted replies only, and
   * only when the transcript carried them — an accepted turn whose verb
   * THREW still commits, so check `error` before trusting `result`). */
  result?: unknown;
  error?: unknown;
  /** The turn's observations (empty on rejected and on replayed — a
   * detected idempotent replay omits them rather than inventing a
   * re-planned execution; see gateway TurnResult.replayed). */
  observations: Record<string, unknown>[];
  replayed?: boolean;
  raw: Record<string, unknown>;
};

/** Named /net-api failure: the {error:{code,...}} vocabulary, thrown. */
export class NetFeedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly detail?: unknown
  ) {
    super(message);
    this.name = "NetFeedError";
  }
}

type SessionReply = { session: string; actor: string; expires_at: number | null; scope: string };

/** Bound of the self-settled (scope, seq) guard set (see the header). */
const SELF_SETTLED_CAP = 256;

/** Marker for a WS turn whose socket died before the turn_result frame:
 * the caller falls back to REST with the SAME idempotency key (CO2.5
 * makes the retry safe — a committed turn returns its recorded reply). */
const WS_INTERRUPTED = Symbol("ws-interrupted");

function defaultBackoff(attempt: number): number {
  return Math.min(10_000, 250 * 2 ** (attempt - 1));
}

function randomTurnId(): string {
  const uuid = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.();
  if (uuid) return `feed:${uuid}`;
  return `feed:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 12)}`;
}

export class NetFeed {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: NetFetchLike;
  private readonly webSocketImpl: NetWebSocketCtor | null;
  private readonly backoffMs: (attempt: number) => number;
  private readonly ttlMs: number | undefined;
  private readonly now: () => number;

  private session: string | null = null;
  private actor: string | null = null;
  private connection: NetFeedConnection = "idle";
  private socket: NetSocketLike | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;

  /** The echo overlay (intent-pending; see the header). */
  private readonly pending = new Map<string, NetPendingTurn>();
  /** In-flight WS turn correlation: frame id → settle callbacks. */
  private readonly wsInFlight = new Map<
    string,
    { resolve: (body: Record<string, unknown>) => void; reject: (err: unknown) => void }
  >();

  /** Per-scope frame high-water: {type:"observations"} redelivery gate. */
  private readonly frameSeen = new Map<string, number>();
  /** Self-settled (scope:seq) pairs — the defensive self-echo guard. */
  private readonly selfSettled = new Set<string>();

  /** TTL-less read cache (see the header's read-cache posture). */
  private readonly readCache = new Map<string, unknown>();

  private readonly observationSubscribers = new Set<(event: NetFeedObservationEvent) => void>();
  private readonly stateSubscribers = new Set<(state: NetFeedState) => void>();

  constructor(options: NetFeedOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch?.bind(globalThis) as NetFetchLike);
    this.webSocketImpl =
      options.webSocketImpl ??
      ((globalThis as { WebSocket?: NetWebSocketCtor }).WebSocket ?? null);
    this.backoffMs = options.backoffMs ?? defaultBackoff;
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
  }

  // ---- Subscriber API (plain callbacks; no framework coupling) ----------

  onObservation(fn: (event: NetFeedObservationEvent) => void): () => void {
    this.observationSubscribers.add(fn);
    return () => this.observationSubscribers.delete(fn);
  }

  onState(fn: (state: NetFeedState) => void): () => void {
    this.stateSubscribers.add(fn);
    return () => this.stateSubscribers.delete(fn);
  }

  state(): NetFeedState {
    return {
      connection: this.connection,
      session: this.session,
      actor: this.actor,
      pending: [...this.pending.values()]
    };
  }

  // ---- Lifecycle ---------------------------------------------------------

  /**
   * Mint a session (POST /net-api/session) and start the WebSocket.
   * Resolves once the session is held — the socket connects in the
   * background (state observable via onState; turns fall back to REST
   * until it opens). Reconnect-with-backoff runs for the feed's
   * lifetime: the session CELL persists at the cluster scope, so a
   * re-register after a drop is just a new upgrade with the same
   * session id (kickoff rule — no durable socket registry anywhere).
   */
  async open(): Promise<{ session: string; actor: string }> {
    this.closedByUser = false;
    const body = this.ttlMs !== undefined ? { ttl_ms: this.ttlMs } : {};
    const reply = (await this.fetchJson("POST", "/net-api/session", body)) as SessionReply;
    this.session = reply.session;
    this.actor = reply.actor;
    this.connectSocket();
    this.notifyState();
    return { session: reply.session, actor: reply.actor };
  }

  /** Stop reconnecting and close the socket. The session cell simply
   * expires server-side; there is no unregister call to make. */
  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.setConnection("closed");
    try {
      socket?.close();
    } catch {
      // A socket that never opened may throw on close; nothing to do.
    }
  }

  // ---- Turns (the echo overlay) ------------------------------------------

  /**
   * Submit one turn. Assigns a client turn id (the idempotency key),
   * places the intent on the echo overlay, sends over WS when the
   * socket is open (REST otherwise, and as fallback when the socket
   * dies mid-turn — same key, so a committed turn replays its recorded
   * reply, CO2.5), and settles on turn_result: the overlay entry drops,
   * the outcome resolves, and the turn's observations emit to
   * subscribers as source:"self".
   */
  async turn(input: { target: string; verb: string; args?: unknown[] }): Promise<NetTurnOutcome> {
    if (!this.session) throw new NetFeedError("E_NOSESSION", "open() the feed before submitting turns", 0);
    const turnId = randomTurnId();
    const args = input.args ?? [];
    this.pending.set(turnId, {
      turn_id: turnId,
      target: input.target,
      verb: input.verb,
      args,
      submitted_at: this.now()
    });
    this.notifyState();
    try {
      let body: Record<string, unknown>;
      if (this.connection === "open" && this.socket) {
        const overWs = await this.turnOverSocket(turnId, input.target, input.verb, args);
        body =
          overWs === WS_INTERRUPTED
            ? await this.turnOverRest(turnId, input.target, input.verb, args)
            : overWs;
      } else {
        body = await this.turnOverRest(turnId, input.target, input.verb, args);
      }
      return this.settleTurn(turnId, body);
    } finally {
      // Settled OR failed: the intent is no longer pending either way
      // (a thrown transport/taxonomy error drops the echo — the caller
      // owns retry policy, and a retried call mints a fresh intent).
      this.pending.delete(turnId);
      this.notifyState();
    }
  }

  /** Send the turn frame and await its correlated turn_result. */
  private turnOverSocket(
    turnId: string,
    target: string,
    verb: string,
    args: unknown[]
  ): Promise<Record<string, unknown> | typeof WS_INTERRUPTED> {
    const socket = this.socket;
    if (!socket) return Promise.resolve(WS_INTERRUPTED);
    return new Promise((resolve) => {
      this.wsInFlight.set(turnId, {
        resolve: (body) => resolve(body),
        // Socket death before the reply: fall back to REST (same key).
        reject: () => resolve(WS_INTERRUPTED)
      });
      try {
        socket.send(
          JSON.stringify({ type: "turn", id: turnId, target, verb, args, idempotency_key: turnId })
        );
      } catch {
        this.wsInFlight.delete(turnId);
        resolve(WS_INTERRUPTED);
      }
    });
  }

  private async turnOverRest(
    turnId: string,
    target: string,
    verb: string,
    args: unknown[]
  ): Promise<Record<string, unknown>> {
    return (await this.fetchJson("POST", "/net-api/turn", {
      target,
      verb,
      args,
      session: this.session,
      idempotency_key: turnId
    })) as Record<string, unknown>;
  }

  /**
   * Reply-settled echo: derive the outcome from the gateway TurnResult
   * body, invalidate the read cache (the world changed under us), record
   * the self-settled (scope, seq) pair, and emit the turn's observations
   * as source:"self".
   */
  private settleTurn(turnId: string, body: Record<string, unknown>): NetTurnOutcome {
    // A WS turn_result that carried an error object (or a REST error
    // status that somehow reached here) is a thrown failure, not a
    // settled outcome.
    const error = body.error as { code?: string; message?: string } | undefined;
    if (error && typeof error === "object" && body.reply === undefined) {
      throw new NetFeedError(String(error.code ?? "E_INTERNAL"), String(error.message ?? "turn failed"), 0, error);
    }
    const reply = (body.reply ?? {}) as Record<string, unknown>;
    const accepted = reply.status === "accepted";
    const scope = typeof reply.scope === "string" ? reply.scope : "";
    const head = reply.head as { seq?: number } | undefined;
    const seq = typeof head?.seq === "number" ? head.seq : null;
    const observations = Array.isArray(body.observations)
      ? (body.observations.filter(
          (item) => item && typeof item === "object" && !Array.isArray(item)
        ) as Record<string, unknown>[])
      : [];

    if (accepted) {
      this.readCache.clear();
      if (scope && seq !== null) this.recordSelfSettled(scope, seq);
      for (const observation of observations) {
        this.emitObservation({ source: "self", scope, seq, turn_id: turnId, observation });
      }
    }
    return {
      status: accepted ? "accepted" : "rejected",
      ...(body.result !== undefined ? { result: body.result } : {}),
      ...(body.error !== undefined ? { error: body.error } : {}),
      observations,
      ...(body.replayed === true ? { replayed: true } : {}),
      raw: body
    };
  }

  private recordSelfSettled(scope: string, seq: number): void {
    const key = `${scope} ${seq}`;
    this.selfSettled.delete(key);
    this.selfSettled.add(key);
    while (this.selfSettled.size > SELF_SETTLED_CAP) {
      const oldest = this.selfSettled.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.selfSettled.delete(oldest);
    }
  }

  // ---- Reads (cell / relation) -------------------------------------------

  /** GET /net-api/cell?key= — the cell body, or null. Cached (TTL-less;
   * invalidated by change signals — see the read-cache posture). */
  async cell(key: string): Promise<unknown> {
    const cacheKey = `cell ${key}`;
    if (this.readCache.has(cacheKey)) return this.readCache.get(cacheKey);
    const reply = (await this.fetchJson("GET", `/net-api/cell?key=${encodeURIComponent(key)}`)) as {
      cell: unknown;
    };
    this.readCache.set(cacheKey, reply.cell ?? null);
    return reply.cell ?? null;
  }

  /** GET /net-api/relation — the (relation, owner) member rows. Cached
   * like cell(). */
  async relation(relation: string, owner: string): Promise<Array<{ member: string; body?: unknown }>> {
    const cacheKey = `relation ${relation} ${owner}`;
    if (this.readCache.has(cacheKey)) {
      return this.readCache.get(cacheKey) as Array<{ member: string; body?: unknown }>;
    }
    const reply = (await this.fetchJson(
      "GET",
      `/net-api/relation?relation=${encodeURIComponent(relation)}&owner=${encodeURIComponent(owner)}`
    )) as { members: Array<{ member: string; body?: unknown }> };
    const members = Array.isArray(reply.members) ? reply.members : [];
    this.readCache.set(cacheKey, members);
    return members;
  }

  // ---- Socket plumbing -----------------------------------------------------

  private connectSocket(): void {
    if (!this.webSocketImpl || !this.session || this.closedByUser) {
      // No WS runtime (or closed): REST-only operation, honestly stated.
      if (!this.webSocketImpl) this.setConnection("idle");
      return;
    }
    // A superseded socket (re-open() with a fresh session) is closed,
    // not leaked; its handlers no-op via the `this.socket !== socket`
    // identity guards below, so its in-flight turns are flushed HERE
    // (they fall back to REST with their same idempotency keys).
    if (this.socket) {
      const previous = this.socket;
      this.socket = null;
      this.failInFlightTurns();
      try {
        previous.close();
      } catch {
        // A never-opened socket may throw on close.
      }
    }
    this.setConnection(this.reconnectAttempt > 0 ? "reconnecting" : "opening");
    const wsBase = this.baseUrl.replace(/^http/, "ws");
    const url = `${wsBase}/net-api/ws?session=${encodeURIComponent(this.session)}&token=${encodeURIComponent(this.apiKey)}`;
    let socket: NetSocketLike;
    try {
      socket = new this.webSocketImpl(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return; // superseded by a newer connect
      this.reconnectAttempt = 0;
      this.setConnection("open");
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.handleFrame(event.data);
    };
    socket.onerror = () => {
      // onclose follows in every runtime; reconnect handled there.
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      // In-flight WS turns fall back to REST with their same keys.
      this.failInFlightTurns();
      if (!this.closedByUser) this.scheduleReconnect();
    };
  }

  /** Flush every awaited WS turn_result: each waiter's reject resolves
   * its turn to the REST-fallback path (see turnOverSocket). */
  private failInFlightTurns(): void {
    for (const [id, waiter] of [...this.wsInFlight]) {
      this.wsInFlight.delete(id);
      waiter.reject(new NetFeedError("E_RETRY", "socket closed before turn_result", 0));
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer !== null) return;
    this.reconnectAttempt += 1;
    this.setConnection("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectSocket();
    }, this.backoffMs(this.reconnectAttempt));
  }

  /** One inbound WS frame. Unknown types are ignored (forward compat). */
  private handleFrame(data: unknown): void {
    if (typeof data !== "string") return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (frame.type === "turn_result" && typeof frame.id === "string") {
      const waiter = this.wsInFlight.get(frame.id);
      if (waiter) {
        this.wsInFlight.delete(frame.id);
        waiter.resolve(frame);
      }
      return;
    }
    if (frame.type === "observations") {
      this.handleObservationsFrame(frame);
    }
  }

  /** The peer path: apply the (scope, seq) gates, invalidate reads, emit. */
  private handleObservationsFrame(frame: Record<string, unknown>): void {
    const scope = typeof frame.scope === "string" ? frame.scope : "";
    const seq = typeof frame.seq === "number" ? frame.seq : null;
    if (!scope || seq === null) return;
    const seen = this.frameSeen.get(scope) ?? 0;
    if (seq <= seen) return; // redelivery on the ordered lane
    this.frameSeen.set(scope, seq);
    if (this.selfSettled.has(`${scope} ${seq}`)) {
      // Our own committed turn came back as a frame (gateway echo-dedupe
      // lost its LRU entry): the reply already emitted these as "self".
      return;
    }
    this.readCache.clear();
    const observations = Array.isArray(frame.observations) ? frame.observations : [];
    for (const item of observations) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      this.emitObservation({ source: "peer", scope, seq, observation: item as Record<string, unknown> });
    }
  }

  // ---- Shared internals ----------------------------------------------------

  private emitObservation(event: NetFeedObservationEvent): void {
    for (const fn of [...this.observationSubscribers]) fn(event);
  }

  private setConnection(connection: NetFeedConnection): void {
    if (this.connection === connection) return;
    this.connection = connection;
    this.notifyState();
  }

  private notifyState(): void {
    const state = this.state();
    for (const fn of [...this.stateSubscribers]) fn(state);
  }

  private async fetchJson(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.status >= 200 && response.status < 300) return payload;
    const error = payload.error as { code?: string; message?: string; detail?: unknown } | undefined;
    throw new NetFeedError(
      String(error?.code ?? "E_INTERNAL"),
      String(error?.message ?? `HTTP ${response.status} on ${path}`),
      response.status,
      error?.detail ?? error
    );
  }
}
