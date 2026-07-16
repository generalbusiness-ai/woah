import { turnEchoId } from "../net/turn-echo";

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
 *   POST /net-api/browser-metrics              → {ok, accepted, sampled}
 *   POST /net-api/ws-ticket {session}          → {ticket, expires_at}  (B3)
 *   GET  /net-api/ws?ticket=                   → WebSocket upgrade
 *     client→server frames: {type:"turn", id, target, verb, args, idempotency_key}
 *                           {type:"ping", id?}
 *     server→client frames: {type:"turn_result", id, status, ...TurnResult|{error}}
 *                           {type:"observations", scope, seq, echo_id?, observations}
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
 *     in-memory LRU that may lose entries (hibernation). Observation frames
 *     therefore carry a one-way echo_id derived from the committed turn's
 *     idempotency key. A frame matching one of our
 *     pending turns is buffered until its reply settles: the full reply wins,
 *     while a replay/transport-loss reply can fall back to the buffered
 *     visible observations. A bounded settled-turn set drops later echoes.
 *     The older (scope, seq) guard remains for rolling gateways that omit
 *     turn_id. Reply settlement never advances the FRAME high-water — that
 *     would drop an in-flight earlier peer frame on the ordered lane.
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
  /** The full woo client credential: `apikey:<id>:<secret>` OR
   * `session:<id>` (the two classes client-auth.ts parses). Sent as
   * `authorization: Bearer <apiKey>` on HTTP; the WS upgrade uses a
   * short-lived single-use TICKET minted over HTTP (B3) so this
   * credential never rides the WS URL. */
  apiKey: string;
  /** Identity-door session ADOPTION: the door routes (/net-api/login,
   * /net-api/guest) already minted the session — open() adopts it
   * instead of minting (a session bearer cannot mint: the gateway
   * refuses `session_bearer_mint` by design). When the adopted session
   * expires, the feed terminates with the named error rather than
   * re-minting — re-authentication is the door's job, and the shell's
   * cue to show the login again. */
  adoptSession?: { session: string; actor: string };
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
  /** M10: the terminal failure that stopped the feed, or null. Set when a
   * session re-mint fails (a revoked credential, not a recoverable
   * session/socket drop); cleared on any successful (re)mint and on
   * open(). A consumer that sees a non-null error knows the feed will not
   * reconnect on its own — it must fix the credential and open() again. */
  error: NetFeedError | null;
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
  /** The client turn id when the reply/fanout carrier provides it. */
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
  /** Suppresses the reconnect loop. Set by BOTH close() (user intent) and
   * terminate() (a terminal failure the user never asked for); the two are
   * told apart by `lastError` (null after close(), set after terminate()).
   * Do NOT read this to infer user intent — read `lastError` for that. */
  private reconnectSuppressed = false;

  /** M10: the terminal failure that stopped the feed (surfaced on state),
   * or null. Set by terminate(); cleared by a successful (re)mint. */
  private lastError: NetFeedError | null = null;
  /** M10: re-mints allowed between real progress signals. A live socket
   * (onopen) or a settled turn resets it to 0; each re-mint increments it.
   * A re-mint attempted at/past the cap without intervening progress is a
   * dead credential (not an expired session) — it throws terminally rather
   * than spinning the treadmill this whole item exists to kill. */
  private remintsWithoutProgress = 0;
  private static readonly MAX_REMINTS_WITHOUT_PROGRESS = 1;
  /** M10: coalesce concurrent re-mints (socket path + turn path) onto one
   * POST /net-api/session. */
  private remintInFlight: Promise<string> | null = null;

  /** The echo overlay (intent-pending; see the header). */
  private readonly pending = new Map<string, NetPendingTurn>();
  /** Public one-way echo id → private idempotency key for pending turns.
   * Avoids an O(pending turns) digest scan on every peer frame. */
  private readonly pendingEchoToTurn = new Map<string, string>();
  /** In-flight WS turn correlation: frame id → settle callbacks. */
  private readonly wsInFlight = new Map<
    string,
    { resolve: (body: Record<string, unknown>) => void; reject: (err: unknown) => void }
  >();

  /** Per-scope frame high-water: {type:"observations"} redelivery gate. */
  private readonly frameSeen = new Map<string, number>();
  /** Self-settled (scope:seq) pairs — the defensive self-echo guard. */
  private readonly selfSettled = new Set<string>();
  /** Settled public echo ids — cross-scope self-echo guard. These are
   * one-way digests, never the replay-capable idempotency keys. */
  private readonly settledEchoIds = new Set<string>();
  /** A self fanout can beat its turn_result after gateway hibernation loses
   * the server-side LRU. Buffer it rather than rendering it as peer traffic;
   * settlement chooses the full reply or this visible fallback exactly once. */
  private readonly pendingSelfFrames = new Map<
    string,
    Array<{ scope: string; seq: number; observations: Record<string, unknown>[] }>
  >();

  /** TTL-less read cache (see the header's read-cache posture). */
  private readonly readCache = new Map<string, unknown>();

  private readonly observationSubscribers = new Set<(event: NetFeedObservationEvent) => void>();
  private readonly stateSubscribers = new Set<(state: NetFeedState) => void>();

  private readonly adoptSession: { session: string; actor: string } | null;

  constructor(options: NetFeedOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.adoptSession = options.adoptSession ?? null;
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
      pending: [...this.pending.values()],
      error: this.lastError
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
    this.reconnectSuppressed = false;
    // M10: a fresh open() clears any prior terminal failure and the
    // re-mint bound — this is the consumer's deliberate restart.
    this.lastError = null;
    this.remintsWithoutProgress = 0;
    if (this.adoptSession) {
      this.session = this.adoptSession.session;
      this.actor = this.adoptSession.actor;
    } else {
      const body = this.ttlMs !== undefined ? { ttl_ms: this.ttlMs } : {};
      const reply = (await this.fetchJson("POST", "/net-api/session", body)) as SessionReply;
      this.session = reply.session;
      this.actor = reply.actor;
    }
    // Await the initial socket CONSTRUCTION (B3 ticket mint + connect) so
    // a caller that open()s then acts has a live socket; failures fall to
    // the background reconnect loop. Reconnects (below) stay fire-and-forget.
    await this.connectSocket();
    this.notifyState();
    return { session: this.session as string, actor: this.actor as string };
  }

  /** Finding 12: RELEASE the session server-side (DELETE /net-api/session
   * — immediate expiry + presence retraction, freeing a guest seat for
   * the next claim) before dropping the local state. Best-effort: a
   * failed release still expires by TTL. */
  async closeSession(): Promise<void> {
    if (!this.session) return;
    try {
      await this.fetchJson("DELETE", "/net-api/session", {});
    } catch {
      // TTL expiry still bounds a failed release.
    }
  }

  /** Stop reconnecting and close the socket. The session cell simply
   * expires server-side; there is no unregister call to make. */
  close(): void {
    this.reconnectSuppressed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    // Detaching first makes attachSocket.onclose's identity guard ignore the
    // event. Flush waiters here so every in-flight turn reaches its same-key
    // REST fallback instead of hanging forever after an intentional close.
    this.failInFlightTurns();
    this.socket = null;
    this.setConnection("closed");
    try {
      socket?.close();
    } catch {
      // A socket that never opened may throw on close; nothing to do.
    }
  }

  /**
   * M10: re-mint the session with the held apikey (a fresh session id),
   * updating session/actor. Coalesces concurrent callers onto one POST so
   * the socket path and a REST turn racing the same expiry mint once. The
   * streak bound is the treadmill guard: a re-mint attempted at/past the
   * cap with no intervening progress (a live socket or a settled turn)
   * throws a terminal NetFeedError — that is a revoked credential, not an
   * expired session, and retrying it forever is the exact loop this item
   * removes. A successful mint clears any surfaced error.
   */
  private async remintSession(): Promise<string> {
    if (this.adoptSession) {
      // A door-adopted session cannot re-mint (the gateway refuses
      // session-bearer mints); its expiry is terminal here and the
      // shell's cue to show the door again.
      throw new NetFeedError("E_NOSESSION", "adopted session expired — re-authenticate at the door", 401, {
        reason: "adopted_session_expired"
      });
    }
    if (this.remintInFlight) return this.remintInFlight;
    if (this.remintsWithoutProgress >= NetFeed.MAX_REMINTS_WITHOUT_PROGRESS) {
      throw new NetFeedError(
        "E_NOSESSION",
        "session re-mint made no progress — the credential is likely revoked",
        401
      );
    }
    this.remintsWithoutProgress += 1;
    const attempt = (async (): Promise<string> => {
      const body = this.ttlMs !== undefined ? { ttl_ms: this.ttlMs } : {};
      const reply = (await this.fetchJson("POST", "/net-api/session", body)) as SessionReply;
      this.session = reply.session;
      this.actor = reply.actor;
      this.lastError = null;
      this.notifyState();
      return reply.session;
    })();
    this.remintInFlight = attempt;
    try {
      return await attempt;
    } finally {
      this.remintInFlight = null;
    }
  }

  /**
   * M10: give up for good. Stop the reconnect loop, surface the error on
   * state (onState subscribers see a non-null `error`), and mark the
   * connection closed. Distinct from close() (user intent): the feed
   * failed and the error says why. A later open() clears it.
   */
  private terminate(error: NetFeedError): void {
    this.lastError = error;
    this.reconnectSuppressed = true; // stop the reconnect loop; lastError marks this as a failure, not a close()
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    // As in close(), the terminal path detaches the socket before closing it;
    // release WS waiters explicitly because onclose will intentionally no-op.
    this.failInFlightTurns();
    this.socket = null;
    // notifyState even if the connection value is unchanged: the error is
    // the news here, and setConnection would swallow a no-op transition.
    this.connection = "closed";
    this.notifyState();
    try {
      socket?.close();
    } catch {
      // A never-opened socket may throw on close.
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
    const echoId = turnEchoId(turnId);
    const args = input.args ?? [];
    this.pending.set(turnId, {
      turn_id: turnId,
      target: input.target,
      verb: input.verb,
      args,
      submitted_at: this.now()
    });
    this.pendingEchoToTurn.set(echoId, turnId);
    this.notifyState();
    let settled = false;
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
      const outcome = this.settleTurn(turnId, echoId, body);
      settled = true;
      return outcome;
    } finally {
      // A committed WS turn can fan out before the socket dies and the REST
      // replay attempt fails. The buffered frame is then the only surviving
      // observation carrier; release it rather than leaking or losing it.
      if (!settled) this.emitBufferedSelfFrames(turnId, echoId);
      // Settled OR failed: the intent is no longer pending either way
      // (a thrown transport/taxonomy error drops the echo — the caller
      // owns retry policy, and a retried call mints a fresh intent).
      this.pending.delete(turnId);
      this.pendingEchoToTurn.delete(echoId);
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
    try {
      return await this.postTurn(turnId, target, verb, args);
    } catch (err) {
      // M10: the session expired under an in-flight REST turn. Re-mint
      // once and retry with the SAME idempotency key — CO2.5 makes the
      // retry safe (if the first attempt somehow committed, the gateway
      // returns its recorded reply rather than re-executing). A re-mint
      // past the streak cap throws terminally, surfacing to the caller.
      if (err instanceof NetFeedError && err.code === "E_NOSESSION") {
        await this.remintSession();
        return await this.postTurn(turnId, target, verb, args);
      }
      throw err;
    }
  }

  /** One POST /net-api/turn with the current session (M10 wraps this with
   * a single re-mint+retry on E_NOSESSION). */
  private async postTurn(
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
  private settleTurn(turnId: string, echoId: string, body: Record<string, unknown>): NetTurnOutcome {
    // M10: a turn that reached the gateway and settled (accepted OR
    // rejected) proves the session is live — real progress, so the
    // re-mint bound resets.
    this.remintsWithoutProgress = 0;
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
    const buffered = this.takeBufferedSelfFrames(echoId);
    const bufferedObservations = buffered.flatMap((frame) => frame.observations);
    const deliveredObservations = accepted
      ? observations.length === 0 ? bufferedObservations : observations
      : bufferedObservations;

    if (accepted) {
      this.readCache.clear();
      this.recordSettledEchoId(echoId);
      if (scope && seq !== null) this.recordSelfSettled(scope, seq);
      if (observations.length > 0) {
        for (const observation of observations) {
          this.emitObservation({ source: "self", scope, seq, turn_id: turnId, observation });
        }
      } else {
        for (const frame of buffered) {
          for (const observation of frame.observations) {
            this.emitObservation({
              source: "self",
              scope: frame.scope,
              seq: frame.seq,
              turn_id: turnId,
              observation
            });
          }
        }
      }
    } else if (buffered.length > 0) {
      // A multi-scope committed fanout can arrive before a later conflict or
      // authorization rejection settles the submit scope. The fanout is still
      // an authoritative committed fact; rejecting the reply must not erase it.
      this.emitTakenBufferedSelfFrames(turnId, echoId, buffered);
    }
    return {
      status: accepted ? "accepted" : "rejected",
      ...(body.result !== undefined ? { result: body.result } : {}),
      ...(body.error !== undefined ? { error: body.error } : {}),
      observations: deliveredObservations,
      ...(body.replayed === true ? { replayed: true } : {}),
      raw: body
    };
  }

  private recordSelfSettled(scope: string, seq: number): void {
    const key = `${scope}\0${seq}`;
    this.selfSettled.delete(key);
    this.selfSettled.add(key);
    while (this.selfSettled.size > SELF_SETTLED_CAP) {
      const oldest = this.selfSettled.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.selfSettled.delete(oldest);
    }
  }

  private recordSettledEchoId(echoId: string): void {
    this.settledEchoIds.delete(echoId);
    this.settledEchoIds.add(echoId);
    while (this.settledEchoIds.size > SELF_SETTLED_CAP) {
      const oldest = this.settledEchoIds.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.settledEchoIds.delete(oldest);
    }
  }

  private takeBufferedSelfFrames(
    echoId: string
  ): Array<{ scope: string; seq: number; observations: Record<string, unknown>[] }> {
    const buffered = this.pendingSelfFrames.get(echoId) ?? [];
    this.pendingSelfFrames.delete(echoId);
    return buffered;
  }

  private emitBufferedSelfFrames(turnId: string, echoId: string): void {
    const buffered = this.takeBufferedSelfFrames(echoId);
    if (buffered.length === 0) return;
    this.emitTakenBufferedSelfFrames(turnId, echoId, buffered);
  }

  private emitTakenBufferedSelfFrames(
    turnId: string,
    echoId: string,
    buffered: Array<{ scope: string; seq: number; observations: Record<string, unknown>[] }>
  ): void {
    this.recordSettledEchoId(echoId);
    this.readCache.clear();
    for (const frame of buffered) {
      for (const observation of frame.observations) {
        this.emitObservation({
          source: "self",
          scope: frame.scope,
          seq: frame.seq,
          turn_id: turnId,
          observation
        });
      }
    }
  }

  // ---- Reads (cell / relation) -------------------------------------------

  /** The open session, or throw — reads are presence-scoped (B1), so a
   * read before open() is a client error surfaced named. */
  private requireSession(): string {
    if (!this.session) throw new NetFeedError("E_NOSESSION", "reads require an open session — call open() first", 0);
    return this.session;
  }

  /** GET /net-api/cell?key= — the cell body, or null. Cached (TTL-less;
   * invalidated by change signals — see the read-cache posture). */
  async cell(key: string): Promise<unknown> {
    const cacheKey = `cell\0${key}`;
    if (this.readCache.has(cacheKey)) return this.readCache.get(cacheKey);
    const reply = (await this.fetchJson("GET", `/net-api/cell?session=${encodeURIComponent(this.requireSession())}&key=${encodeURIComponent(key)}`)) as {
      cell: unknown;
    };
    this.readCache.set(cacheKey, reply.cell ?? null);
    return reply.cell ?? null;
  }

  /** GET /net-api/relation — the (relation, owner) member rows. Cached
   * like cell(). */
  async relation(relation: string, owner: string): Promise<Array<{ member: string; body?: unknown }>> {
    const cacheKey = `relation\0${relation}\0${owner}`;
    if (this.readCache.has(cacheKey)) {
      return this.readCache.get(cacheKey) as Array<{ member: string; body?: unknown }>;
    }
    const reply = (await this.fetchJson(
      "GET",
      `/net-api/relation?session=${encodeURIComponent(this.requireSession())}&relation=${encodeURIComponent(relation)}&owner=${encodeURIComponent(owner)}`
    )) as { members: Array<{ member: string; body?: unknown }> };
    const members = Array.isArray(reply.members) ? reply.members : [];
    this.readCache.set(cacheKey, members);
    return members;
  }

  /** Transport-neutral browser diagnostics. Keeping this on NetFeed makes
   * the client credential private to the transport and prevents net mode
   * from falling back to the legacy `/api/browser-metrics` namespace. */
  async reportBrowserMetrics(metrics: readonly unknown[]): Promise<void> {
    await this.fetchJson("POST", "/net-api/browser-metrics", {
      session: this.requireSession(),
      metrics
    });
  }

  // ---- Socket plumbing -----------------------------------------------------

  private async connectSocket(): Promise<void> {
    if (!this.webSocketImpl || !this.session || this.reconnectSuppressed) {
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
    // B3: mint a short-lived single-use ticket over authenticated HTTP,
    // then connect with `?ticket=` — the permanent apikey never rides the
    // WS URL (it would leak through history/logs/traces). A mint failure
    // (e.g. session expired) schedules a reconnect like any connect error.
    const session = this.session;
    let ticket: string;
    try {
      const reply = (await this.fetchJson("POST", "/net-api/ws-ticket", { session })) as { ticket: string };
      ticket = reply.ticket;
    } catch (err) {
      // Superseded by a re-open()/close() between the connect start and
      // the mint reply — abandon this attempt silently.
      if (this.session !== session || this.reconnectSuppressed) return;
      // M10: a ticket mint that fails because the SESSION is gone
      // (E_NOSESSION) is the treadmill this item kills — re-minting a
      // ticket for a dead session forever. Re-mint the SESSION once, then
      // retry the connect with the fresh id. A re-mint that throws (past
      // the streak cap → a revoked credential) is terminal: stop the loop
      // and surface it, rather than spin.
      if (err instanceof NetFeedError && err.code === "E_NOSESSION") {
        try {
          await this.remintSession();
        } catch (remintErr) {
          this.terminate(
            remintErr instanceof NetFeedError
              ? remintErr
              : new NetFeedError("E_NOSESSION", "session re-mint failed", 401)
          );
          return;
        }
        if (!this.reconnectSuppressed) void this.connectSocket();
        return;
      }
      // Any other failure (transient network): reconnect with backoff.
      this.scheduleReconnect();
      return;
    }
    // A re-open()/close between mint and connect supersedes this attempt.
    if (this.session !== session || this.reconnectSuppressed || !this.webSocketImpl) return;
    const wsBase = this.baseUrl.replace(/^http/, "ws");
    const url = `${wsBase}/net-api/ws?ticket=${encodeURIComponent(ticket)}`;
    let socket: NetSocketLike;
    try {
      socket = new this.webSocketImpl(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.attachSocket(socket, session);
  }

  /** Wire a freshly-constructed socket's handlers (extracted from
   * connectSocket for the async B3 ticket flow). */
  private attachSocket(socket: NetSocketLike, session: string): void {
    if (this.session !== session) {
      try {
        socket.close();
      } catch {
        /* never-opened */
      }
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return; // superseded by a newer connect
      this.reconnectAttempt = 0;
      this.remintsWithoutProgress = 0; // M10: a live socket is real progress
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
      if (!this.reconnectSuppressed) this.scheduleReconnect();
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
    if (this.reconnectSuppressed || this.reconnectTimer !== null) return;
    this.reconnectAttempt += 1;
    this.setConnection("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectSocket();
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
    const echoId = typeof frame.echo_id === "string" && frame.echo_id ? frame.echo_id : null;
    if (echoId && this.settledEchoIds.has(echoId)) return;
    const observations = Array.isArray(frame.observations)
      ? (frame.observations.filter(
          (item) => item && typeof item === "object" && !Array.isArray(item)
        ) as Record<string, unknown>[])
      : [];
    const pendingTurnId = echoId ? this.pendingEchoToTurn.get(echoId) ?? null : null;
    if (echoId && pendingTurnId) {
      this.recordSelfSettled(scope, seq);
      const buffered = this.pendingSelfFrames.get(echoId) ?? [];
      buffered.push({ scope, seq, observations });
      this.pendingSelfFrames.set(echoId, buffered);
      return;
    }
    if (this.selfSettled.has(`${scope}\0${seq}`)) {
      // Our own committed turn came back as a frame (gateway echo-dedupe
      // lost its LRU entry): the reply already emitted these as "self".
      return;
    }
    this.readCache.clear();
    for (const observation of observations) this.emitObservation({ source: "peer", scope, seq, observation });
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
