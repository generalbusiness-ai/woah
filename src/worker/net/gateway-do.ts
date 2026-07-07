/**
 * NetGatewayDO — the Durable Object shell for a gateway shard (Plan 002
 * Phase 3 step 2; coherence.md CO1 GATEWAY role, CO5 copy #2).
 *
 * Thin by design: planning lives in src/net/plan.ts, application in
 * src/net/{cells,outbox}.ts. This file provides
 *   - SQLite persistence for the derived view (copy #2: epoch-stamped
 *     cells) and the per-scope fanout high-water (CO2.5 receiver
 *     idempotency), hydrated lazily;
 *   - the internal-auth'd /net surface:
 *       POST /net/fanout  FanoutBody → install cells, advance seen seq,
 *                         mirror relation deltas (CO13) under the same
 *                         high-water
 *       GET  /net/relation ?relation=&owner= → the member rows of one
 *                         relation at one owner (the CO13 client-read
 *                         primitive for who/contents)
 *       POST /net/pull    {scope, destination} → CO7 state-transfer
 *                         cache-fill: KV seed first when HOST_SEED_KV is
 *                         bound (head-checked against the live scope;
 *                         CO5 copy #3), else the scope's lineage-closed
 *                         live closure — which then rewrites the seed
 *       POST /net/session-open  CO14 mint: build a session-cell commit via
 *                         mintSessionSubmit, submit it to the actor's
 *                         cluster scope (stale_head-only retry), install
 *                         the accepted cell in the view. POST
 *                         /net-api/session is the credentialed client
 *                         front; the internal route stays for lane/tests
 *       POST /net/plan-scheduled  CO16 planner execution: a scope's due
 *                         scheduled turn, delivered via its durable
 *                         outbox to this gateway (subscribed with role
 *                         "planner"), runs the NORMAL /net/turn
 *                         machinery under the stable idempotency key
 *                         `sched:<id>:<at_logical_time>` — at-least-once
 *                         delivery + the committing scope's reply cache
 *                         = fired exactly once. Cold views pull-on-miss
 *                         before planning (see planScheduled)
 *       POST /net/turn    the CO6-taxonomy repair loop: plan → submit,
 *                         with each retryable verdict mapped to its
 *                         defined recovery (refetch head / targeted
 *                         closure refresh / epoch reseed), bounded by
 *                         repair_budget_ms (CO10) and an attempt
 *                         ceiling; terminal verdicts and budget
 *                         exhaustion surface with the attempt trace
 *
 * plus the CLIENT-facing /net-api surface (Phase 4 item 2 — apikey
 * credentials instead of internal signing; see the clientApi block):
 *       POST /net-api/session, POST /net-api/turn,
 *       GET /net-api/relation, GET /net-api/cell
 *
 * Topology (Plan 002 Phase 3.5 item 2, CO15): the gateway derives its
 * classifier from the VIEW's lineage cells (topology.ts anchor walk) and
 * maps scope names to rpc destinations by convention (`scope:<name>` —
 * the DO namespace key IS the scope name). Request-supplied `anchors`/
 * `shared`/`scopes` remain as lane/test overrides only.
 *
 * This class sits beside the v2 DO classes and shares nothing with them;
 * nothing routes production traffic here until Phase 5.
 */
import { CellStore, cellKey, type Cell } from "../../net/cells";
import { budgetExhausted, isNetError, netError, type AttemptTraceEntry, type NetErrorCode } from "../../net/errors";
import { applyFanout, type FanoutBody } from "../../net/outbox";
import { relationKey, type RelationDelta, type RelationRow } from "../../net/relations";
import { mintSessionSubmit, sessionCellKey, validateSessionCell } from "../../net/sessions";
import { planTurn, type PlanTurnInput, type PlanTurnResult } from "../../net/plan";
import type { ScopeClassifier } from "../../net/route";
import { CATALOG_SCOPE, classifierFromLineage, type AnchorLineage } from "../../net/topology";
import type { CommitReply, CommitSubmit, RejectReason, ScheduledTurn, ScopeHead } from "../../net/scope";
import { netCellKeyFor, type EffectTranscript } from "../../net/transcript";
import type { CellTransfer } from "../../net/cells";
import { randomHex } from "../../core/source-hash";
import { verifyInternalRequest } from "../internal-auth";
import { ClientAuthError, parseClientCredential, verifyApiKeyCredential } from "./client-auth";
import { TokenBucketLimiter } from "./rate-limit";
import { resolveNetDestination, WorkerdHost, type NetBindingsEnv } from "./workerd-host";

export type NetGatewayDurableState = {
  id: unknown;
  waitUntil?: (promise: Promise<unknown>) => void;
  /** DO hibernation-friendly WebSocket surface (Phase 4 item 3): sockets
   * are accepted with their SESSION ID as the tag, so delivery is
   * `getWebSockets(session)` — the runtime IS the registry (in-memory /
   * hibernation only; no new durable copy, CO5 stays at five). Optional
   * because the structural fake-DO harness predates it: routes that need
   * it refuse namedly when the runtime lacks the surface. */
  acceptWebSocket?(ws: WebSocket, tags?: string[]): void;
  getWebSockets?(tag?: string): WebSocket[];
  storage: {
    sql: { exec(query: string, ...params: unknown[]): unknown };
    transactionSync<T>(callback: () => T): T;
    setAlarm(at: number): void | Promise<void>;
    deleteAlarm(): void | Promise<void>;
  };
};

/** Structural KV slice (CO5 copy #3) — satisfied by a real KVNamespace
 * binding and by a Map-backed test fake alike. */
export type NetSeedKV = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
};

/** The KV value at `net:seed:<scope>`: a full-closure snapshot of the
 * scope's cells (and relation rows — CO13: a pull advances the fanout
 * high-water, so the rows must ride the snapshot or the mirror starves;
 * see reseedFromScope) at a stated head. Consumers head-check before
 * trusting (CO7: the cold path is the normal path — a lagging seed falls
 * back to the live closure, which then overwrites the seed). */
type SeedRecord = {
  cells: Cell[];
  head: ScopeHead;
  catalog_epoch: string;
  relations?: RelationRow[];
};

const seedKey = (scope: string): string => `net:seed:${scope}`;

export type NetGatewayEnv = NetBindingsEnv & {
  /** KV seeds (CO5 copy #3). Optional: without the binding, /net/pull is
   * always the live-closure path. */
  HOST_SEED_KV?: NetSeedKV;
};

function sqlRows<T>(cursor: unknown): T[] {
  return (cursor as { toArray(): T[] }).toArray();
}

type ScopeRow = { seen_seq: number };

/** CO10: the ratified repair budget for one /net/turn. */
export const REPAIR_BUDGET_MS = 12_000;

/** Attempt ceiling inside the budget. Every defined recovery converges in
 * one round when its refresh succeeds; six rounds leaves room for a
 * recovery whose refresh itself fails transiently. More than that means
 * the recovery is not converging and burning budget will not help. */
export const MAX_TURN_ATTEMPTS = 6;

type TurnRequest = {
  call: PlanTurnInput["call"];
  planningScope: string;
  catalog_epoch: string;
  idempotency_key: string;
  /** DEPRECATED-FOR-PRODUCTION topology overrides (lane/test fixtures
   * only — CO15 forbids request-supplied topology on the production
   * path). When ALL THREE are absent the gateway derives everything:
   * the classifier from the view's lineage cells (topology.ts anchor
   * walk) and each scope's rpc destination by the `scope:<scopeName>`
   * convention — the DO namespace key IS the scope name
   * (resolveNetDestination is unchanged; it splits on the first ':').
   * Presence of `anchors` or `shared` switches the whole classifier to
   * the legacy request-supplied one — the two sources are never mixed,
   * so a fixture cannot half-override the derivation. */
  /** scope → rpc destination override (e.g. "scope:the_room"). Absent
   * entries fall back to the `scope:<scopeName>` convention. */
  scopes?: Record<string, string>;
  /** object → owning scope; objects absent here anchor to planningScope. */
  anchors?: Record<string, string>;
  /** which scopes are shared sequencers (rooms); others are clusters. */
  shared?: string[];
  counters?: PlanTurnInput["counters"];
};

/** /net/plan-scheduled body (CO16; see planScheduled): the wire shape
 * the scope's outbox drain delivers. */
type PlanScheduledRequest = {
  scheduled_turn: ScheduledTurn;
  scope: string;
  catalog_epoch: string;
};

/** /net/session-open body (CO14 mint; see sessionOpen). */
type SessionOpenRequest = {
  session: string;
  actor: string;
  ttl_ms: number;
  catalog_epoch: string;
  /** Optional rpc-destination override (lane fixtures); the scope name is
   * recovered from the `scope:<scopeName>` convention when it applies. */
  cluster_destination?: string;
};

/** /net/turn reply body. `trace` lists the failed rounds that preceded
 * the final verdict (empty on a first-try accept), so callers and tests
 * can see the convergence shape (CO6). */
type TurnResult = {
  reply: CommitReply;
  selection: { scope: string; riders: string[] };
  envelopeBytes: number;
  attempt: number;
  trace: AttemptTraceEntry[];
  /** Phase-4 item 1: the planned transcript's verb return value,
   * error, and observations, carried on an ACCEPTED reply (the gateway
   * holds the planned transcript — every transport needs the caller to
   * see what its turn did). Omitted on rejected replies (nothing
   * committed) and on detected idempotent replays (see `replayed`);
   * `result`/`error` are also omitted when the transcript lacks them.
   * `error` matters: a verb that THREW still commits its (complete,
   * effect-less or partial) transcript, so an accepted reply without
   * the error field would be indistinguishable from success. */
  result?: EffectTranscript["result"];
  error?: EffectTranscript["error"];
  observations?: EffectTranscript["observations"];
  /** Present (true) when the accepted reply is detectably the scope's
   * RECORDED reply for an earlier submit of the same idempotency key
   * (CO2.5): a fresh accept's post_state_version always equals this
   * round's plan (CO4 step 10 rejects otherwise), so a differing digest
   * proves the commit happened on a prior request. The re-planned
   * transcript then describes a DIFFERENT execution than the one that
   * committed, so result/observations are omitted rather than invented.
   * A replay whose re-plan converged on the identical post-state is
   * indistinguishable from (and equivalent to) a fresh accept, and
   * carries the re-planned result/observations without this flag. */
  replayed?: boolean;
  /** Present (true) when the commit was ACCEPTED but the post-accept
   * warm cache-fill (installTouched) failed (fix 5a): the commit is
   * durable at the scope; the view repairs itself on the next turn via
   * read_version_mismatch → targeted refresh. Never a 500. */
  install_degraded?: boolean;
};

/** Retryable verdict → the CO6 taxonomy code its round is recorded as.
 * `post_state_mismatch` has no code of its own; its defined recovery is
 * the E_READ_VERSION one (re-plan against refreshed cells). */
const VERDICT_CODE: Partial<Record<RejectReason, NetErrorCode>> = {
  stale_head: "E_STALE_HEAD",
  stale_epoch: "E_STALE_EPOCH",
  read_version_mismatch: "E_READ_VERSION",
  post_state_mismatch: "E_READ_VERSION"
};

/** `<kind>:<object>[:<name>]` → object (object ids never contain ':'). */
function objectOfCellKey(key: string): string {
  return key.split(":")[1] ?? "";
}

/** Session TTL bounds for the /net-api client surface: default 30 min,
 * clamped to [1 min, 24 h] — a client cannot mint an immortal session. */
const CLIENT_SESSION_TTL_DEFAULT_MS = 30 * 60_000;
const CLIENT_SESSION_TTL_MIN_MS = 60_000;
const CLIENT_SESSION_TTL_MAX_MS = 24 * 60 * 60_000;

function clampClientTtl(raw: unknown): number {
  const ttl = typeof raw === "number" && Number.isFinite(raw) ? raw : CLIENT_SESSION_TTL_DEFAULT_MS;
  return Math.min(CLIENT_SESSION_TTL_MAX_MS, Math.max(CLIENT_SESSION_TTL_MIN_MS, ttl));
}

/** What a gateway WebSocket carries across hibernation (Phase 4 item 3):
 * the validated session id (also the socket's tag) and the apikey-
 * authenticated actor the session is bound to. */
type GatewaySocketAttachment = { session: string; actor: string; opened_at: number };

/** Echo-dedupe LRU bound (see recentClientTurns). */
const RECENT_CLIENT_TURN_CAP = 512;

/** H4 rate limits (wire.md inbound rule): the standard per-actor budget
 * for every /net-api operation — REST requests and WS turn frames share
 * ONE bucket per authenticated actor, so a client cannot double its
 * budget by splitting traffic across transports. */
const CLIENT_RATE_PER_SEC = 50;
const CLIENT_RATE_BURST = 100;
/** Tighter budget for the durable-commit / ticket AMPLIFIERS: a session
 * mint is a sequenced commit at the actor's cluster and a ws-ticket is a
 * durable row + a later upgrade — both cost far more than a read, so
 * they get their own small bucket (burst covers a client opening a few
 * tabs at once; sustained abuse throttles to 5/s). */
const CLIENT_MINT_RATE_PER_SEC = 5;
const CLIENT_MINT_RATE_BURST = 20;

export class NetGatewayDO {
  private readonly host: WorkerdHost;
  private view: CellStore | null = null;
  private readonly seen = new Map<string, number>();
  /**
   * Echo dedupe (Phase 4 item 3 chunk 2): turn id → the session that
   * submitted it through THIS shard's client surface. The submitting
   * session receives its turn's observations on the turn reply (item 1),
   * so pushObservations skips its sockets when the fanout announcing the
   * same turn arrives.
   *
   * Boundedness, documented: an insertion-ordered Map capped at
   * RECENT_CLIENT_TURN_CAP — plenty for the window between a submit and
   * its own fanout (same-scope, one commit). In-memory only, ON PURPOSE:
   * losing an entry (hibernation, cap overflow) degrades to ONE
   * duplicate frame for the submitter — never a missed frame for anyone
   * else — which matches the layer's at-most-once, no-durability
   * observation posture (kickoff rule).
   */
  private readonly recentClientTurns = new Map<string, string>();

  /** H4 token buckets, PER-ISOLATE by design (see rate-limit.ts header):
   * `clientRate` covers every authenticated /net-api operation (REST +
   * WS turn frames, one bucket per actor); `mintRate` is the tighter
   * bucket for the amplifier routes (session mint, ws-ticket). */
  private readonly clientRate = new TokenBucketLimiter({ ratePerSec: CLIENT_RATE_PER_SEC, burst: CLIENT_RATE_BURST });
  private readonly mintRate = new TokenBucketLimiter({
    ratePerSec: CLIENT_MINT_RATE_PER_SEC,
    burst: CLIENT_MINT_RATE_BURST
  });

  constructor(
    private readonly state: NetGatewayDurableState,
    private readonly env: NetGatewayEnv
  ) {
    // CREATE IF NOT EXISTS on every construction — same idiom as
    // SqliteScopeStore: cheap, idempotent, no separate first-boot path.
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS net_gateway_cell (key TEXT PRIMARY KEY, body TEXT NOT NULL)");
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS net_gateway_scope (scope TEXT PRIMARY KEY, seen_seq INTEGER NOT NULL)");
    // CO13 relation mirror: roster rows (contents, session_presence)
    // received via FanoutBody.relations — the client-read primitive for
    // who/contents (GET /net/relation). SQLite-only (no memory cache):
    // reads are per-request queries and writes are gated by the same
    // per-scope seen high-water as cells, so there is no hydrated state
    // to keep coherent. Columns denormalize the row for the
    // (relation, owner) query; `body` is the row's JSON body or NULL.
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS net_gateway_relation (key TEXT PRIMARY KEY, relation TEXT NOT NULL, owner TEXT NOT NULL, member TEXT NOT NULL, body TEXT)"
    );
    // Selection pinning (fix 5c): idempotency_key → the scope the FIRST
    // submit for that key targeted. A re-plan (same key, refreshed view)
    // must never migrate the commit to a different scope — the pinned
    // scope may already hold the recorded reply, and a second scope would
    // double-commit the turn. Rows are as durable and as unbounded as the
    // scopes' own reply cache (the same idempotency posture).
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS net_gateway_pin (idempotency_key TEXT PRIMARY KEY, scope TEXT NOT NULL)"
    );
    // B3: short-lived single-use WebSocket tickets. A ticket authenticates
    // one upgrade so the permanent apikey never rides the WS URL. Durable
    // (survives hibernation between mint and connect) but self-limiting:
    // TTL-reaped on every mint, and each ticket is deleted on use.
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS net_gateway_ws_ticket (ticket TEXT PRIMARY KEY, session TEXT NOT NULL, actor TEXT NOT NULL, expires_at INTEGER NOT NULL)"
    );
    this.host = new WorkerdHost({
      resolve: (destination) => resolveNetDestination(this.env, destination),
      env,
      waitUntil: state.waitUntil?.bind(state),
      alarmStorage: state.storage
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Phase-4 item 2: the /net-api client surface carries CLIENT
    // credentials (apikey verified against the catalog identity cell),
    // never internal signing — the worker entry forwards these requests
    // unsigned and this handler trusts nothing about the hop. Everything
    // else on this DO stays behind verifyInternalRequest.
    if (url.pathname.startsWith("/net-api/")) {
      return this.clientApi(request, url);
    }
    try {
      await verifyInternalRequest(this.env, request);
    } catch (err) {
      return json({ error: String(err) }, 401);
    }
    try {
      if (request.method === "POST" && url.pathname === "/net/fanout") {
        const body = (await request.json()) as FanoutBody;
        return json({ applied: this.receiveFanout(body) });
      }
      if (request.method === "POST" && url.pathname === "/net/pull") {
        const body = (await request.json()) as { scope: string; destination: string; known?: string[] };
        return json(await this.pull(body));
      }
      if (request.method === "POST" && url.pathname === "/net/turn") {
        return json(await this.turn((await request.json()) as TurnRequest));
      }
      if (request.method === "POST" && url.pathname === "/net/plan-scheduled") {
        return json(await this.planScheduled((await request.json()) as PlanScheduledRequest));
      }
      if (request.method === "POST" && url.pathname === "/net/session-open") {
        return json(await this.sessionOpen((await request.json()) as SessionOpenRequest));
      }
      if (request.method === "GET" && url.pathname === "/net/cell") {
        // Lane read surface (Phase-3 step 4b): expose one view cell so the
        // workerd smoke can assert fanout landed. Phase-4 transports carry
        // real client reads; until then this is also a useful operator
        // probe (a derived copy with provenance + stamp visible).
        const key = url.searchParams.get("key") ?? "";
        const cell = this.ensureView().get(key) ?? null;
        return json({ key, cell });
      }
      if (request.method === "GET" && url.pathname === "/net/relation") {
        // CO13 client-read primitive: the members of one relation at one
        // owner (who is in the room / what a container holds), served
        // from the fanout-fed mirror. Phase-4 transports wrap this for
        // real clients; until then it is the lane's roster probe.
        const relation = url.searchParams.get("relation") ?? "";
        const owner = url.searchParams.get("owner") ?? "";
        if (!relation || !owner) throw new Error("relation and owner query params are required");
        return json({ relation, owner, members: this.relationMembers(relation, owner) });
      }
      return json({ error: `no such route: ${request.method} ${url.pathname}` }, 404);
    } catch (err) {
      if (isNetError(err)) {
        // E_BUDGET carries the per-attempt taxonomy trail; surface it in
        // the error reply so the failure explains itself (CO6).
        return json(
          {
            error: {
              code: err.code,
              message: err.message,
              detail: err.detail,
              ...(err.attempts ? { attempts: err.attempts } : {})
            }
          },
          400
        );
      }
      // Plain-Error escapes after failed repair rounds carry the trace
      // as a structured field (fix 5d) — surface it so the 500 explains
      // its convergence shape too.
      const attempts = err instanceof Error ? (err as Error & { attempts?: AttemptTraceEntry[] }).attempts : undefined;
      return json({ error: String(err), ...(attempts !== undefined ? { attempts } : {}) }, 500);
    }
  }

  /**
   * /net/pull — cold cache-fill with KV seeds (CO5 copy #3, CO7).
   *
   * KV first when the binding exists: read `net:seed:<scope>`, then
   * HEAD-CHECK it against the live scope before trusting (the cold path
   * is the normal path run at higher latency, never a trust-me shortcut).
   * A seed at the live head installs with `seed` provenance — the honest
   * copy-#3 marking. A lagging seed (E_SEED_LAG — informational, the
   * consumer proceeds via the head check) falls back to the live closure,
   * which then OVERWRITES the seed. On any live pull the seed is written
   * back best-effort via defer — never on the reply path, and only for
   * full pulls (`known` non-empty would snapshot a partial closure).
   */
  private async pull(body: { scope: string; destination: string; known?: string[] }): Promise<{
    ok: true;
    installed: number;
    head: ScopeHead;
    source: "kv" | "live";
  }> {
    const view = this.ensureView();
    const known = body.known ?? [];
    const kv = this.env.HOST_SEED_KV;

    if (kv && known.length === 0) {
      const raw = await kv.get(seedKey(body.scope));
      if (raw !== null) {
        const seed = JSON.parse(raw) as SeedRecord;
        const live = (await this.host.rpc(body.destination, "/head")) as { head: ScopeHead };
        if (live.head.seq === seed.head.seq && live.head.hash === seed.head.hash) {
          this.discardViewOnThrow(() =>
            this.state.storage.transactionSync(() => {
              for (const cell of seed.cells) {
                // Copy #3 provenance: these cells came through KV, not the
                // authority — mark them honestly (planning treats derived
                // and seed copies identically; the stamp is provenance).
                view.install({ ...cell, provenance: "seed" });
                this.persistCell(view, cell.key);
              }
              // CO13: relation rows ride the seed for the same reason they
              // ride the live closure (see reseedFromScope's upsert note).
              for (const row of seed.relations ?? []) {
                this.applyRelationDelta({ op: "add", row });
              }
            })
          );
          // Fix 7: the seed IS the state at its head — stale pre-pull
          // fanout rows must no-op instead of regressing the view.
          this.advanceSeen(body.scope, seed.head.seq);
          return { ok: true, installed: seed.cells.length, head: seed.head, source: "kv" };
        }
        // Seed lags the live head: named, informational (CO6 E_SEED_LAG),
        // and self-healing — the live path below rewrites the seed.
        console.log(
          "woo.metric",
          JSON.stringify({
            kind: "net_seed_lag",
            code: "E_SEED_LAG",
            scope: body.scope,
            seed_head: seed.head,
            live_head: live.head,
            ts: Date.now()
          })
        );
      }
    }

    const transfer = await this.reseedFromScope(view, body.destination, known);
    if (kv && known.length === 0) {
      // Best-effort seed write-back (deferred — a KV outage must never
      // fail or slow the pull; the next pull just goes live again).
      const record: SeedRecord = {
        cells: transfer.cells,
        head: transfer.head,
        catalog_epoch: transfer.catalog_epoch,
        ...(transfer.relations !== undefined ? { relations: transfer.relations } : {})
      };
      this.host.defer(() => kv.put(seedKey(body.scope), JSON.stringify(record)));
    }
    return { ok: true, installed: transfer.cells.length, head: transfer.head, source: "live" };
  }

  /**
   * The CO6-taxonomy repair loop (Phase 3 step 3). Each round is one
   * plan → submit; every retryable failure is recorded as an
   * AttemptTraceEntry and mapped to its defined recovery:
   *
   * - planning E_MISSING_STATE (CO2.6 materialization miss) → fetch
   *   exactly the missing cell keys from their owning scopes, re-plan;
   * - stale_head → refetch the head; resubmit the SAME transcript only
   *   when the base was the whole story (head actually moved AND the
   *   scope reported no read mismatches) — otherwise re-plan;
   * - read_version_mismatch → refresh exactly `mismatched_reads`
   *   (mapped through netCellKeyFor) and RE-PLAN: a transcript planned
   *   against stale reads is never resubmitted;
   * - stale_epoch → drop stale-stamped view cells + full-closure reseed
   *   from the scope (the CO8 named reseed), re-plan;
   * - terminal verdicts return the reply immediately; terminal NetError
   *   codes and plain programming errors throw as-is.
   *
   * Bounded by repair_budget_ms (CO10) and MAX_TURN_ATTEMPTS; exhaustion
   * throws E_BUDGET carrying the trace, which the fetch handler surfaces
   * in the /net/turn error reply (CO6: the reply explains itself).
   *
   * The selected scope's CURRENT head is fetched after planning
   * (selection is a function of the write set) and stamped into the
   * submit — `base` is an envelope field, not part of the transcript
   * hash or the post-state digest, so patching it in is sound.
   */
  private async turn(request: TurnRequest): Promise<TurnResult> {
    const trace: AttemptTraceEntry[] = [];
    try {
      return await this.turnAttempts(request, trace);
    } catch (err) {
      // Fix 5d: a plain-Error escape (misplan bug, double transport
      // failure) after failed rounds must still explain the convergence
      // shape. NetErrors carry their own trace (E_BUDGET) or are
      // terminal-by-taxonomy; for plain Errors, attach the accumulated
      // trace as a structured field — the fetch handler surfaces it
      // beside the error string in the 500 reply.
      if (!isNetError(err) && err instanceof Error && trace.length > 0) {
        (err as Error & { attempts?: AttemptTraceEntry[] }).attempts = trace;
      }
      throw err;
    }
  }

  /**
   * The turn's ScopeClassifier (CO15). Production path: derived from the
   * VIEW's lineage cells via the topology.ts anchor walk — never from
   * request-supplied topology. The lookup reads the live view store, so
   * a classifier built after a refresh sees the refreshed lineage; the
   * fallback covers objects with no lineage cell yet (same-turn creates),
   * mirroring the legacy `?? planningScope` rule.
   *
   * Lane/test override: presence of `anchors` OR `shared` selects the
   * legacy request-supplied classifier wholesale (never mixed with the
   * derivation — a fixture cannot half-override CO15).
   */
  private classifierFor(request: TurnRequest, view: CellStore): ScopeClassifier {
    if (request.anchors !== undefined || request.shared !== undefined) {
      return {
        scopeOf: (object) => request.anchors?.[object] ?? request.planningScope,
        isShared: (scope) => (request.shared ?? [request.planningScope]).includes(scope)
      };
    }
    return classifierFromLineage(
      (object) => (view.get(cellKey("object_lineage", object))?.value as AnchorLineage | undefined) ?? null,
      { fallback: request.planningScope }
    );
  }

  /** Scope name → rpc destination. Convention: `scope:<scopeName>` (the
   * DO namespace key IS the scope name — CO15); a request `scopes` entry
   * overrides it (lane fixtures wiring fake stubs). */
  private destinationFor(request: TurnRequest, scope: string): string {
    return request.scopes?.[scope] ?? `scope:${scope}`;
  }

  /**
   * The catalog scope's lineage keys held by this view (CO15): the
   * shared substrate is universally receiver-known in transfers, so the
   * planner's read closure never reships class chains. An unclassifiable
   * lineage cell (mid-walk gap during a partial refresh) simply ships —
   * the known-set is an envelope optimization and must never fail a plan.
   * Under the legacy override classifier no scope is ever "catalog", so
   * the set is empty and legacy envelopes are unchanged.
   */
  private catalogKnownKeys(view: CellStore, classifier: ScopeClassifier): Set<string> {
    const known = new Set<string>();
    for (const key of view.keys()) {
      if (!key.startsWith("object_lineage:")) continue;
      try {
        if (classifier.scopeOf(objectOfCellKey(key)) === CATALOG_SCOPE) known.add(key);
      } catch {
        // Unclosed walk: leave the key out; the cell ships normally.
      }
    }
    return known;
  }

  private async turnAttempts(request: TurnRequest, trace: AttemptTraceEntry[]): Promise<TurnResult> {
    const startedAt = this.host.now();
    const deadline = startedAt + REPAIR_BUDGET_MS;
    // stale_head resubmit carry-over: when only the base was stale the
    // planned transcript is still valid — the next round submits it
    // against the fresh head instead of paying a re-plan.
    let resubmit: { planned: PlanTurnResult; base: ScopeHead } | null = null;

    for (let attempt = 1; attempt <= MAX_TURN_ATTEMPTS; attempt += 1) {
      // The budget bounds rounds two onward; the first attempt always
      // runs (a zero-attempt turn could never converge or explain itself).
      if (attempt > 1 && this.host.now() >= deadline) break;
      const elapsed = () => this.host.now() - startedAt;
      // Re-acquire the view per attempt (fix 3): a failed durable write in
      // a prior round discarded this.view; the loop must plan against the
      // rehydrated store, never a detached one. The classifier rebuilds
      // with it (CO15: it is a function of the view's lineage cells, and
      // a recovery may have refreshed them).
      const view = this.ensureView();
      const classifier = this.classifierFor(request, view);

      // ---- Plan (or adopt the stale_head resubmit).
      let planned: PlanTurnResult;
      let base: ScopeHead | null = null;
      if (resubmit) {
        planned = resubmit.planned;
        base = resubmit.base;
        resubmit = null;
      } else {
        try {
          planned = await this.planOnce(request, view, classifier);
        } catch (err) {
          if (isNetError(err) && err.code === "E_MISSING_STATE") {
            const missing = Array.isArray(err.detail.missing) ? (err.detail.missing as string[]) : [];
            trace.push({ attempt, code: "E_MISSING_STATE", missing, elapsed_ms: elapsed() });
            await this.tryRecovery(trace, () => this.refreshCells(request, classifier, view, missing));
            continue;
          }
          // Terminal NetError codes and plain Errors (misplan bugs,
          // transport failures on the submit path) surface as-is.
          throw err;
        }
      }

      // Selection pinning (fix 5c): the FIRST submit for this key pins
      // its scope durably BEFORE the rpc leaves. Any later round (or a
      // replayed request) whose re-plan selects a DIFFERENT scope is
      // overridden to the pinned one — the pinned scope may hold the
      // recorded reply; committing elsewhere would double-commit. The
      // overridden submit still carries its planned transcript scope, so
      // a genuinely migrated selection rejects terminal scope_mismatch
      // at the pinned scope and SURFACES (never commits elsewhere).
      const pinned = this.pinnedScope(request.idempotency_key);
      const targetScope = pinned ?? planned.selection.scope;
      if (pinned === null) {
        this.pinScope(request.idempotency_key, planned.selection.scope);
      } else if (pinned !== planned.selection.scope) {
        console.log(
          "woo.metric",
          JSON.stringify({
            kind: "net_turn_selection_pin_override",
            idempotency_key: request.idempotency_key,
            planned: planned.selection.scope,
            pinned,
            ts: Date.now()
          })
        );
      }
      const destination = this.destinationFor(request, targetScope);
      if (base === null) {
        base = ((await this.host.rpc(destination, "/head")) as { head: ScopeHead }).head;
      }
      // CO2.3 rider integrity (rule 1): attest every FOREIGN read — a
      // read whose object anchors to a scope other than the committing
      // one — from its owner before submitting. Fetched fresh on EVERY
      // round (including stale_head resubmits), so a read_version_
      // mismatch repair — which refreshes the mismatched cells from
      // their owners (refreshCells routes by the classifier) and
      // re-plans — automatically re-attests the affected owners too.
      const attestations = await this.attestForeignReads(request, classifier, planned, targetScope);
      const submit: CommitSubmit = {
        ...planned.submit,
        base,
        ...(attestations !== undefined ? { attestations } : {})
      };

      // The submit rides with its rider directions (CA3 forward) and its
      // relation-owner directions (CO13): the scope shell enqueues
      // /net/adopt rows for the accepted rider cells and /net/relate
      // rows for foreign relation deltas after commit. CommitSubmit
      // itself is unchanged — both are HTTP-body siblings, not sequencer
      // input.
      const submitBody = {
        submit,
        rider_destinations: this.riderDestinationsFor(request, classifier, planned),
        relate_destinations: this.relateDestinationsFor(request, classifier, planned, targetScope)
      };
      let reply: CommitReply;
      try {
        reply = (await this.host.rpc(destination, "/submit", submitBody)) as CommitReply;
      } catch (err) {
        // CO2.5 recovery (fix 5b): the transport died in the reply
        // window (kill_after_commit shape) — the scope may or may not
        // have durably committed. ONE resubmit with the SAME idempotency
        // key disambiguates: a committed turn returns its recorded
        // reply; an uncommitted one validates fresh. Only a second
        // transport failure surfaces (with the trace via fix 5d).
        reply = (await this.host.rpc(destination, "/submit", submitBody)) as CommitReply;
      }
      if (reply.status === "accepted") {
        let installDegraded = false;
        if (reply.touched.length > 0) {
          try {
            await this.installTouched(view, destination, reply.touched);
          } catch (err) {
            // Fix 5a: the COMMIT is durable at the scope; a failed warm
            // cache-fill must never turn an accepted turn into a 500.
            // The stale view self-repairs next turn (read_version_
            // mismatch → targeted refresh). Named + counted.
            installDegraded = true;
            console.log(
              "woo.metric",
              JSON.stringify({
                kind: "net_turn_install_degraded",
                scope: reply.scope,
                touched: reply.touched.length,
                error: String(err),
                ts: Date.now()
              })
            );
          }
        }
        // Phase-4 item 1 / B2 fix: replay is decided by the SCOPE, which
        // knows authoritatively (it looked the idempotency key up), not
        // guessed by digest here — a digest guess false-negatives on a
        // cell-touchless or same-post-state retry and would then present a
        // freshly-planned result/observations as the committed turn's
        // output (acute for now()/random() turns). A recorded reply
        // (CO2.5) committed nothing this round, so omit its re-planned
        // output. (`post_state_version` equality is the fallback for a
        // scope that predates the flag — belt and suspenders.)
        const replayed = reply.replayed === true || reply.post_state_version !== submit.post_state_version;
        return {
          reply,
          selection: planned.selection,
          envelopeBytes: planned.envelopeBytes,
          attempt,
          trace,
          ...(replayed
            ? { replayed: true }
            : {
                ...(planned.transcript.result !== undefined ? { result: planned.transcript.result } : {}),
                ...(planned.transcript.error !== undefined ? { error: planned.transcript.error } : {}),
                observations: planned.transcript.observations
              }),
          ...(installDegraded ? { install_degraded: true } : {})
        };
      }
      if (!reply.retryable) {
        // Terminal verdict: surface the scope's reply immediately (CO6).
        return { reply, selection: planned.selection, envelopeBytes: planned.envelopeBytes, attempt, trace };
      }

      // ---- Retryable verdict: record the round, run the defined recovery.
      const mismatchKeys = (reply.mismatched_reads ?? [])
        .map((cell) => netCellKeyFor(cell))
        .filter((key): key is string => key !== null);
      trace.push({
        attempt,
        code: VERDICT_CODE[reply.reason] ?? "E_READ_VERSION",
        ...(mismatchKeys.length > 0 ? { missing: mismatchKeys } : {}),
        elapsed_ms: elapsed()
      });

      switch (reply.reason) {
        case "stale_head": {
          const fresh = await this.tryRecovery(
            trace,
            async () => ((await this.host.rpc(destination, "/head")) as { head: ScopeHead }).head
          );
          const headMoved = fresh !== undefined && (fresh.seq !== submit.base.seq || fresh.hash !== submit.base.hash);
          if (fresh !== undefined && headMoved && !reply.mismatched_reads) {
            // The head moved and no reads were reported stale: the
            // transcript is still honest, resubmit it on the new base.
            resubmit = { planned, base: fresh };
          }
          // Otherwise re-plan next round: either the head did not
          // actually differ (something else is wrong) or reads were
          // flagged too (stale view — must re-plan).
          break;
        }
        case "read_version_mismatch":
        case "post_state_mismatch": {
          // Refresh exactly the named cells (or, for a post_state
          // disagreement naming nothing, reseed the scope's closure)
          // and re-plan.
          await this.tryRecovery(trace, async () => {
            if (mismatchKeys.length > 0) await this.refreshCells(request, classifier, view, mismatchKeys);
            else await this.reseedFromScope(view, destination);
          });
          break;
        }
        case "stale_epoch": {
          await this.tryRecovery(trace, async () => {
            // CO8 named reseed: drop every cell stamped with another
            // epoch (mirrored into SQLite), pull the scope's full
            // closure back, re-plan. The drop mutates memory BEFORE the
            // persist transaction, so the whole block is discard-on-throw
            // (fix 3): a failed persist rehydrates instead of leaving the
            // view missing cells SQLite still holds.
            await this.discardViewOnThrow(async () => {
              const stale = [...view.keys()].filter(
                (key) => view.get(key)?.stamp.catalog_epoch !== request.catalog_epoch
              );
              view.dropStaleEpoch({ catalog_epoch: request.catalog_epoch });
              this.state.storage.transactionSync(() => {
                for (const key of stale) this.persistCell(view, key);
              });
              await this.reseedFromScope(view, destination);
            });
          });
          break;
        }
        default:
          // Retryable but with no defined gateway recovery — unreachable
          // while the verdict set stays closed; re-plan and let the
          // budget bound the loop.
          break;
      }
    }

    throw budgetExhausted("repair budget exhausted for /net/turn", trace, {
      planning_scope: request.planningScope,
      budget_ms: REPAIR_BUDGET_MS,
      max_attempts: MAX_TURN_ATTEMPTS,
      elapsed_ms: this.host.now() - startedAt
    });
  }

  /**
   * /net/plan-scheduled — CO16 planner execution: run a scope's due
   * scheduled turn through the NORMAL turn machinery (the same repair
   * loop, pinning, attestation, and install-on-accept as /net/turn).
   *
   * - **Exactly once.** The idempotency key is the stable
   *   `sched:<id>:<at_logical_time>`: the scope's outbox delivers
   *   at-least-once, and every redelivery replans under the SAME key, so
   *   the committing scope's reply cache (CO2.5, checked before any
   *   validation) returns the recorded reply instead of re-committing.
   *   The 200 reply — accepted OR terminal-rejected TurnResult — is what
   *   deletes the sender's outbox row.
   * - **Sessions-absent rule (CO14).** ScheduledTurn.call carries
   *   actor/target/verb/args and no session, so scheduled turns run as
   *   actor-authority DIRECT-route turns (the lane/tooling allowance) —
   *   until VTN18.2's engine-side scheduling lands an authority field,
   *   this is the documented CO16 posture.
   * - **Pull-on-miss.** A planner may be woken with a COLD view (first
   *   dispatch after deployment/eviction). Scopes this gateway has never
   *   seen (no fanout/pull high-water) are pulled before planning: the
   *   SENDING scope, the catalog scope (class chains + verb bytecode —
   *   normally KV-seeded at install, CO15), and the call actor's cluster
   *   by the CO15 `cluster:<actor>` convention (best-effort: a
   *   non-cluster-rooted actor's pull fails as a named metric and the
   *   turn falls back to the standard E_MISSING_STATE recovery).
   *   Head-0 caveat: a scope whose head has never advanced records no
   *   high-water, so seed-only scopes re-pull per dispatch — redundant
   *   but harmless, and scheduled turns are rare by design.
   */
  private async planScheduled(body: PlanScheduledRequest): Promise<TurnResult> {
    const turn = body.scheduled_turn;
    await this.warmScopes([body.scope, CATALOG_SCOPE, `cluster:${turn.call.actor}`], "net_plan_scheduled_pull_miss_failed");
    const key = `sched:${turn.id}:${turn.at_logical_time}`;
    return this.turn({
      call: {
        kind: "woo.turn_call.shadow.v1",
        id: key,
        route: "direct",
        scope: body.scope,
        actor: turn.call.actor,
        target: turn.call.target,
        verb: turn.call.verb,
        args: turn.call.args as PlanTurnInput["call"]["args"]
      },
      planningScope: body.scope,
      catalog_epoch: body.catalog_epoch,
      idempotency_key: key
    });
  }

  /**
   * /net/session-open — CO14 minting. The credentialed client front is
   * POST /net-api/session (clientSession below); this internal route
   * remains for lanes/tests and trusted tooling (CO14: the gateway
   * authenticates, scopes authorize).
   *
   * Honest-path decision, documented: the mint is a DIRECT submit built by
   * mintSessionSubmit, not a /net/turn — a session mint is a substrate
   * commit with no verb to execute, so driving the planner would require
   * a phantom `session_mint` verb in every world. The repair loop is
   * correspondingly minimal: only `stale_head` can race a mint (the
   * transcript reads nothing), so refetch the head and resubmit the SAME
   * transcript — expiry is stamped once, before the loop, keeping the
   * idempotency key stable across attempts (CO2.5).
   *
   * The cluster scope is derived from the view's lineage (CO15 anchor
   * walk on the actor) when possible; `cluster_destination` overrides the
   * rpc destination (lane fixtures wiring fake stubs), with the scope
   * name recovered from the `scope:<scopeName>` convention.
   */
  private async sessionOpen(request: SessionOpenRequest): Promise<{
    reply: CommitReply;
    scope: string;
    value: unknown;
    install_degraded?: boolean;
  }> {
    const view = this.ensureView();
    let clusterScope: string;
    if (request.cluster_destination?.startsWith("scope:")) {
      clusterScope = request.cluster_destination.slice("scope:".length);
    } else {
      // CO15: derive from view lineage. An actor the view has never
      // pulled is a materialization miss (CO2.6) — the caller's recovery
      // is /net/pull then retry — not the assert-class E_LINEAGE the raw
      // walk throws for unclosed sets.
      if (!view.has(cellKey("object_lineage", request.actor))) {
        throw netError("E_MISSING_STATE", "session-open actor is not in the gateway view", {
          missing: [cellKey("object_lineage", request.actor)]
        });
      }
      const classifier = classifierFromLineage(
        (object) => (view.get(cellKey("object_lineage", object))?.value as AnchorLineage | undefined) ?? null
      );
      clusterScope = classifier.scopeOf(request.actor);
    }
    const destination = request.cluster_destination ?? `scope:${clusterScope}`;

    const now = this.host.now();
    let base = ((await this.host.rpc(destination, "/head")) as { head: ScopeHead }).head;
    const { submit, value } = mintSessionSubmit({
      session: request.session,
      actor: request.actor,
      ttl_ms: request.ttl_ms,
      now,
      base,
      epoch: request.catalog_epoch,
      clusterScope
    });
    let reply: CommitReply;
    for (let attempt = 1; ; attempt += 1) {
      reply = (await this.host.rpc(destination, "/submit", { ...submit, base })) as CommitReply;
      if (reply.status === "accepted" || !reply.retryable || reply.reason !== "stale_head" || attempt >= 3) break;
      base = ((await this.host.rpc(destination, "/head")) as { head: ScopeHead }).head;
    }
    if (reply.status !== "accepted") return { reply, scope: clusterScope, value };
    // Install the accepted session cell into the view (warm cache-fill,
    // CO7) — the same degrade rule as /net/turn (fix 5a): the commit is
    // durable; a failed fill self-repairs on the next turn's read check.
    let installDegraded = false;
    try {
      await this.installTouched(view, destination, reply.touched);
    } catch (err) {
      installDegraded = true;
      console.log(
        "woo.metric",
        JSON.stringify({ kind: "net_session_open_install_degraded", scope: clusterScope, error: String(err), ts: Date.now() })
      );
    }
    return { reply, scope: clusterScope, value, ...(installDegraded ? { install_degraded: true } : {}) };
  }

  // ---- /net-api: the Phase-4 client surface (kickoff item 2) -------------
  //
  // Client-facing, NO internal auth: every route authenticates the woo
  // apikey credential against the catalog identity cell
  // (property_cell:$system:api_keys — CO14/CO15), pull-on-miss from the
  // catalog scope. Named failures are 401 {error:{code:"E_NOSESSION"}}.
  //
  //   POST /net-api/session {ttl_ms?}
  //     → authenticate, derive the actor's cluster scope (CO15 topology),
  //       session-open through the existing mint machinery, reply
  //       {session, actor, expires_at, scope}.
  //   POST /net-api/turn {target, verb, args?, session, idempotency_key?}
  //     → REQUIRES a valid session (the CO14 Phase-4 rule: client-
  //       originated turns need sessions), validated from the session
  //       cell in the gateway view; builds a route:"sequenced"
  //       TurnRequest (the committing scope's authorize revalidates the
  //       session — the gateway authenticates, scopes authorize) and runs
  //       the normal /net/turn machinery; the reply is the TurnResult
  //       including item-1 result/observations.
  //   GET /net-api/relation?relation=&owner=   authenticated roster read
  //   GET /net-api/cell?key=                   authenticated cell probe
  //   GET /net-api/ws?session=                  WebSocket upgrade (Phase 4
  //     item 3): same apikey authentication, session REQUIRED and
  //     validated like /net-api/turn, then the socket is accepted with
  //     the session id as its hibernation tag. Frames (JSON, `id`
  //     echoed):
  //       {type:"turn", id?, target, verb, args?, idempotency_key?}
  //         → the clientTurn path on the SOCKET's session (a frame
  //           cannot speak for another session) →
  //           {type:"turn_result", id, status, ...TurnResult-or-error}
  //       {type:"ping", id?} → {type:"pong", id}
  //       anything else → {type:"error", id?, error:{code, message}}
  //     Observation push (item 3 chunk 2) delivers
  //     {type:"observations", scope, seq, observations} frames to
  //     sockets whose session is present (CO13 session_presence) in a
  //     fanout's scope — see pushObservations.

  private async clientApi(request: Request, url: URL): Promise<Response> {
    try {
      // B3: the WS upgrade authenticates by a short-lived single-use
      // TICKET (?ticket=), NOT the apikey. The WebSocket API cannot set
      // request headers, so the only alternative — the permanent apikey
      // in the URL — would leak through history/logs/traces. The ticket
      // is minted over authenticated HTTP (POST /net-api/ws-ticket) and
      // carries no long-lived secret. It is verified here, before the
      // apikey path, so an upgrade never needs a credential in its URL.
      if (request.method === "GET" && url.pathname === "/net-api/ws") {
        return await this.clientWebSocketByTicket(request, url);
      }

      const credential = parseClientCredential(request.headers, null);
      const identity = await this.catalogIdentity();
      const { actor } = verifyApiKeyCredential(identity.map, credential);

      // H4: rate limiting runs AFTER authentication resolves the actor
      // (so buckets key on identity, never on spoofable request bytes)
      // and BEFORE any dispatch — a throttled client costs one map lookup.
      this.enforceClientRate(actor, url.pathname);

      if (request.method === "POST" && url.pathname === "/net-api/ws-ticket") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        return await this.mintWsTicket(actor, body);
      }
      if (request.method === "POST" && url.pathname === "/net-api/session") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        return await this.clientSession(actor, body, identity.epoch);
      }
      if (request.method === "POST" && url.pathname === "/net-api/turn") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        return await this.clientTurn(actor, body, identity.epoch);
      }
      if (request.method === "GET" && url.pathname === "/net-api/relation") {
        const relation = url.searchParams.get("relation") ?? "";
        const owner = url.searchParams.get("owner") ?? "";
        if (!relation || !owner) {
          return json({ error: { code: "E_INVARG", message: "relation and owner query params are required" } }, 400);
        }
        // B1: reads require the caller's session (the presence anchor) and
        // are authorized against it — no global reads, no credential cells.
        const session = this.readSession(url, actor);
        this.authorizeRelationRead(actor, session, owner);
        return json({ relation, owner, members: this.relationMembers(relation, owner) });
      }
      if (request.method === "GET" && url.pathname === "/net-api/cell") {
        const key = url.searchParams.get("key") ?? "";
        if (!key) return json({ error: { code: "E_INVARG", message: "key query param is required" } }, 400);
        const session = this.readSession(url, actor);
        this.authorizeCellRead(actor, session, key);
        return json({ key, cell: this.ensureView().get(key) ?? null });
      }
      return json({ error: { code: "E_OBJNF", message: `no such route: ${request.method} ${url.pathname}` } }, 404);
    } catch (err) {
      if (err instanceof ClientAuthError) {
        return json({ error: { code: err.code, message: err.message, detail: err.detail } }, err.status);
      }
      if (isNetError(err)) {
        // Same taxonomy surfacing as the internal /net/turn handler
        // (E_BUDGET carries its attempt trace so the failure explains
        // itself — CO6), on the client status vocabulary.
        return json(
          {
            error: {
              code: err.code,
              message: err.message,
              detail: err.detail,
              ...(err.attempts ? { attempts: err.attempts } : {})
            }
          },
          400
        );
      }
      return json({ error: { code: "E_INTERNAL", message: String(err) } }, 500);
    }
  }

  /**
   * H4: one token per authenticated /net-api operation. The amplifier
   * routes (session mint, ws-ticket) consume from the tighter mint
   * bucket; everything else from the standard 50/s-burst-100 bucket
   * (wire.md). A refused take throws the named E_RATE as a
   * ClientAuthError so the clientApi catch maps it to 429 — recovery is
   * simply waiting for the refill (documented in the error detail).
   */
  private enforceClientRate(actor: string, pathname: string): void {
    const isAmplifier = pathname === "/net-api/session" || pathname === "/net-api/ws-ticket";
    const allowed = isAmplifier
      ? this.mintRate.take(actor, this.host.now())
      : this.clientRate.take(actor, this.host.now());
    if (!allowed) {
      throw new ClientAuthError(
        "rate limit exceeded; retry after backoff",
        {
          reason: "rate_limited",
          limit: isAmplifier
            ? { rate_per_sec: CLIENT_MINT_RATE_PER_SEC, burst: CLIENT_MINT_RATE_BURST }
            : { rate_per_sec: CLIENT_RATE_PER_SEC, burst: CLIENT_RATE_BURST }
        },
        "E_RATE",
        429
      );
    }
  }

  /**
   * The catalog identity cell (`property_cell:$system:api_keys`),
   * pull-on-miss from the catalog scope destination (CO15 convention).
   * Returns the api_keys map (the property payload's VALUE slot) and the
   * cell's catalog_epoch stamp — the honest epoch for everything this
   * client request plans against (clients never supply epochs).
   */
  private async catalogIdentity(): Promise<{ map: unknown; epoch: string }> {
    const key = cellKey("property_cell", "$system", "api_keys");
    let cell = this.ensureView().get(key);
    if (!cell) {
      // Unlike warmScopes this pull is a HARD requirement: without the
      // identity cell no client request can authenticate, so a failed
      // pull surfaces (500) rather than degrading to a misleading 401.
      await this.pull({ scope: CATALOG_SCOPE, destination: `scope:${CATALOG_SCOPE}` });
      cell = this.ensureView().get(key);
    }
    if (!cell) {
      throw new ClientAuthError("no apikey registry in the catalog scope", { reason: "no_registry" });
    }
    const payload = cell.value as { value?: unknown } | null | undefined;
    const map = payload && typeof payload === "object" ? payload.value : undefined;
    return { map, epoch: cell.stamp.catalog_epoch };
  }

  /** POST /net-api/session — see the clientApi header. */
  private async clientSession(actor: string, body: Record<string, unknown>, epoch: string): Promise<Response> {
    // The mint needs the actor's lineage (cluster-scope derivation) in
    // view; the CO15 `cluster:<actor>` convention names the pull
    // destination without needing lineage first (the planScheduled
    // idiom). Best-effort: sessionOpen's own E_MISSING_STATE names the
    // failure when the pull could not land.
    await this.warmScopes([CATALOG_SCOPE, `cluster:${actor}`], "net_client_pull_miss_failed");
    const session = `s_${randomHex(16)}`;
    const opened = await this.sessionOpen({
      session,
      actor,
      ttl_ms: clampClientTtl(body.ttl_ms),
      catalog_epoch: epoch
    });
    if (opened.reply.status !== "accepted") {
      // A mint only rejects retryably (stale_head races, already retried
      // inside sessionOpen) or on epoch drift; either way the client's
      // recovery is simply to retry.
      return json({ error: { code: "E_RETRY", message: "session mint did not commit; retry", detail: opened.reply } }, 503);
    }
    const value = opened.value as { expiresAt?: number } | null;
    return json({
      session,
      actor,
      expires_at: typeof value?.expiresAt === "number" ? value.expiresAt : null,
      scope: opened.scope
    });
  }

  /** POST /net-api/turn — see the clientApi header. */
  private async clientTurn(actor: string, body: Record<string, unknown>, epoch: string): Promise<Response> {
    // CO14 Phase-4 rule: client-originated turns REQUIRE a session. The
    // gateway refuses session-less turns up front (named), and the turn
    // still runs route:"sequenced" so the committing scope's authorize
    // revalidates the session end-to-end.
    const session = typeof body.session === "string" && body.session.length > 0 ? body.session : null;
    if (!session) {
      return json(
        {
          error: {
            code: "E_NOSESSION",
            message: "client-originated turns require a session (CO14): POST /net-api/session first",
            detail: { session_verdict: "session_required" }
          }
        },
        401
      );
    }
    await this.warmScopes([CATALOG_SCOPE, `cluster:${actor}`], "net_client_pull_miss_failed");
    const cell = this.ensureView().get(sessionCellKey(session));
    // The actor binding pins the session to the AUTHENTICATED apikey
    // actor: presenting another actor's session id is actor_mismatch.
    const verdict = validateSessionCell(cell, this.host.now(), actor);
    if (verdict !== "ok") {
      return json(
        { error: { code: "E_NOSESSION", message: `session ${verdict}`, detail: { session_verdict: verdict } } },
        401
      );
    }
    const target = typeof body.target === "string" ? body.target : "";
    const verb = typeof body.verb === "string" ? body.verb : "";
    if (!target || !verb) {
      return json({ error: { code: "E_INVARG", message: "turn body requires target and verb" } }, 400);
    }
    const args = (Array.isArray(body.args) ? body.args : []) as PlanTurnInput["call"]["args"];

    // planningScope from the session cell (the CO14 Phase-4 refinement):
    // the anchor object is the session's activeScope when set (the CO13
    // presence scope), else the actor's live location from the view, else
    // the actor itself (a located-nowhere actor plans at its own cluster).
    const row = cell?.value as { activeScope?: string | null } | undefined;
    const anchorObject = this.clientAnchorObject(actor, row?.activeScope ?? null);
    const planningScope = await this.clientPlanningScope(anchorObject, actor);
    // Client retries reuse their supplied idempotency key (CO2.5); an
    // unkeyed request gets a fresh turn identity.
    const key =
      typeof body.idempotency_key === "string" && body.idempotency_key.length > 0
        ? body.idempotency_key
        : `napi:${randomHex(12)}`;
    // Echo dedupe (item 3 chunk 2): recorded BEFORE the submit leaves —
    // the committing scope's outbox drain races the turn reply, so a
    // post-reply registration could let the fanout push arrive first and
    // duplicate the reply's observations at the submitter.
    this.noteClientTurn(key, session);
    const result = await this.turn({
      call: {
        kind: "woo.turn_call.shadow.v1",
        id: key,
        route: "sequenced",
        scope: anchorObject,
        session,
        actor,
        target,
        verb,
        args
      },
      planningScope,
      catalog_epoch: epoch,
      idempotency_key: key
    });
    // Terminal rejections return as 200 TurnResults (same as /net/turn):
    // the reply names its verdict; thrown taxonomy errors (E_BUDGET etc.)
    // surface through the clientApi catch instead.
    return json(result);
  }

  /** The space object a client turn anchors to — see clientTurn. */
  private clientAnchorObject(actor: string, activeScope: string | null): string {
    if (activeScope) return activeScope;
    const live = this.ensureView().get(cellKey("object_live", actor))?.value as
      | { location?: string | null }
      | undefined;
    return typeof live?.location === "string" && live.location.length > 0 ? live.location : actor;
  }

  /**
   * Classify the client turn's anchor object to its planning scope (CO15
   * anchor walk over view lineage). The anchor's lineage may live at a
   * scope this view has never pulled; the `room:<space>` naming
   * convention (CO15) lets the gateway attempt a best-effort convention
   * pull first — the same posture planScheduled takes with
   * `cluster:<actor>`. If the object still cannot classify, the actor's
   * cluster is the honest fallback: the session plans at its own
   * authority and the repair loop's E_MISSING_STATE recovery covers any
   * reads the plan then needs.
   */
  private async clientPlanningScope(anchorObject: string, actor: string): Promise<string> {
    if (!this.ensureView().has(cellKey("object_lineage", anchorObject))) {
      await this.warmScopes([`room:${anchorObject}`], "net_client_pull_miss_failed");
    }
    try {
      const view = this.ensureView();
      const classifier = classifierFromLineage(
        (object) => (view.get(cellKey("object_lineage", object))?.value as AnchorLineage | undefined) ?? null
      );
      return classifier.scopeOf(anchorObject);
    } catch {
      return `cluster:${actor}`;
    }
  }

  /**
   * GET /net-api/ws — the WebSocket upgrade (Phase 4 item 3; kickoff
   * "WS transport + observation push"). Credential authentication already
   * happened in clientApi (the same apikey path as every /net-api route);
   * this handler additionally REQUIRES a `?session=` bound to the
   * authenticated actor — validated exactly like /net-api/turn — because
   * the socket's tag IS its delivery address: an unvalidated session tag
   * would let one client subscribe to another session's observations.
   *
   * Registry decision (kickoff, documented): the runtime's hibernation
   * socket set is the WHOLE registry — `acceptWebSocket(ws, [session])`
   * tags the socket, `getWebSockets(session)` finds it, and the
   * attachment carries {session, actor} across hibernation. No durable
   * copy anywhere (CO5 stays at five): a dropped socket loses only
   * liveness; the session cell persists and a reconnect re-tags.
   */
  /** POST /net-api/ws-ticket {session} — mint a single-use ~60s ticket
   * bound to (session, actor) for a subsequent WS upgrade (B3). The
   * session must be the caller's own live session. */
  private async mintWsTicket(actor: string, body: Record<string, unknown>): Promise<Response> {
    const session = typeof body.session === "string" ? body.session : "";
    if (!session) {
      return json({ error: { code: "E_INVARG", message: "ws-ticket requires a session" } }, 400);
    }
    await this.warmScopes([CATALOG_SCOPE, `cluster:${actor}`], "net_client_pull_miss_failed");
    const verdict = validateSessionCell(this.ensureView().get(sessionCellKey(session)), this.host.now(), actor);
    if (verdict !== "ok") {
      return json({ error: { code: "E_NOSESSION", message: `session ${verdict}`, detail: { session_verdict: verdict } } }, 401);
    }
    const now = this.host.now();
    // Reap expired tickets on mint — bounded cleanup, no separate reaper.
    this.state.storage.sql.exec("DELETE FROM net_gateway_ws_ticket WHERE expires_at <= ?", now);
    const ticket = `wst_${randomHex(24)}`;
    const expiresAt = now + 60_000;
    this.state.storage.sql.exec(
      "INSERT INTO net_gateway_ws_ticket (ticket, session, actor, expires_at) VALUES (?, ?, ?, ?)",
      ticket,
      session,
      actor,
      expiresAt
    );
    return json({ ticket, expires_at: expiresAt });
  }

  /** GET /net-api/ws?ticket= — the WS upgrade, authenticated by a
   * single-use ticket (B3): consume it, validate the bound session, and
   * accept the socket. No apikey in the URL. */
  private async clientWebSocketByTicket(request: Request, url: URL): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: { code: "E_INVARG", message: "expected Upgrade: websocket" } }, 400);
    }
    const accept = this.state.acceptWebSocket?.bind(this.state);
    const PairCtor = (globalThis as { WebSocketPair?: new () => { 0: WebSocket; 1: WebSocket } }).WebSocketPair;
    if (!accept || !PairCtor) {
      return json({ error: { code: "E_INTERNAL", message: "runtime does not support WebSocket upgrades" } }, 500);
    }
    const ticket = url.searchParams.get("ticket") ?? "";
    if (!ticket) {
      return json({ error: { code: "E_NOSESSION", message: "WS upgrade requires a ticket (POST /net-api/ws-ticket)", detail: { reason: "ticket_required" } } }, 401);
    }
    // Consume the ticket single-use: read-then-delete in one transaction,
    // so a replayed ticket URL cannot open a second socket.
    const row = this.state.storage.transactionSync(() => {
      const found = sqlRows<{ session: string; actor: string; expires_at: number }>(
        this.state.storage.sql.exec("SELECT session, actor, expires_at FROM net_gateway_ws_ticket WHERE ticket = ?", ticket)
      )[0];
      if (found) this.state.storage.sql.exec("DELETE FROM net_gateway_ws_ticket WHERE ticket = ?", ticket);
      return found;
    });
    if (!row || row.expires_at <= this.host.now()) {
      return json({ error: { code: "E_NOSESSION", message: "ticket invalid or expired", detail: { reason: "ticket_invalid" } } }, 401);
    }
    const { session, actor } = row;
    await this.warmScopes([CATALOG_SCOPE, `cluster:${actor}`], "net_client_pull_miss_failed");
    const verdict = validateSessionCell(this.ensureView().get(sessionCellKey(session)), this.host.now(), actor);
    if (verdict !== "ok") {
      return json({ error: { code: "E_NOSESSION", message: `session ${verdict}`, detail: { session_verdict: verdict } } }, 401);
    }
    const pair = new PairCtor();
    const server = pair[1] as WebSocket & { serializeAttachment?(value: unknown): void };
    // The attachment survives hibernation; webSocketMessage reads it back
    // instead of re-authenticating per frame (the session cell is still
    // revalidated per turn inside clientTurn — expiry keeps its bite).
    server.serializeAttachment?.({ session, actor, opened_at: this.host.now() } satisfies GatewaySocketAttachment);
    accept(server, [session]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** The socket's hibernation attachment, or null for a socket this DO
   * never attached (defensive: workerd only routes accepted sockets). */
  private socketAttachment(ws: WebSocket): GatewaySocketAttachment | null {
    const readable = ws as WebSocket & { deserializeAttachment?(): unknown };
    if (typeof readable.deserializeAttachment !== "function") return null;
    const raw = readable.deserializeAttachment() as Partial<GatewaySocketAttachment> | null | undefined;
    return raw && typeof raw.session === "string" && typeof raw.actor === "string"
      ? (raw as GatewaySocketAttachment)
      : null;
  }

  /**
   * Inbound WS frames (the DO hibernation callback). Every reply is a
   * frame on the same socket — a transport error must never kill the
   * connection when it can be named instead. `id` (when the frame
   * carries one) is echoed for client correlation.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const send = (frame: Record<string, unknown>): void => {
      try {
        ws.send(JSON.stringify(frame));
      } catch {
        // Socket died mid-reply; webSocketClose owns the cleanup.
      }
    };
    if (typeof message !== "string") {
      send({ type: "error", error: { code: "E_INVARG", message: "frames must be JSON text" } });
      return;
    }
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(message) as Record<string, unknown>;
    } catch {
      send({ type: "error", error: { code: "E_INVARG", message: "frames must be JSON text" } });
      return;
    }
    const id = frame.id;
    const att = this.socketAttachment(ws);
    if (!att) {
      send({ type: "error", ...(id !== undefined ? { id } : {}), error: { code: "E_NOSESSION", message: "socket has no session attachment" } });
      return;
    }
    if (frame.type === "ping") {
      send({ type: "pong", ...(id !== undefined ? { id } : {}) });
      return;
    }
    if (frame.type === "turn") {
      // H4: inbound WS turn frames draw from the SAME per-actor bucket as
      // the REST surface (a socket is just another transport for the same
      // identity). Divergence from wire.md's "error frame with no id"
      // noted deliberately: this frame vocabulary correlates every reply
      // by id, and an uncorrelated drop would strand the client's
      // in-flight turn — so the refusal is a turn_result with status 429
      // and the named E_RATE, which settles the waiter.
      if (!this.clientRate.take(att.actor, this.host.now())) {
        send({
          type: "turn_result",
          ...(id !== undefined ? { id } : {}),
          status: 429,
          error: { code: "E_RATE", message: "rate limit exceeded; retry after backoff" }
        });
        return;
      }
      try {
        // The epoch is re-read per frame (pull-on-miss — the identity
        // cell's stamp, same honest source clientApi uses); the frame's
        // session is ALWAYS the socket's own (attachment), so one
        // authenticated socket cannot submit on another session.
        const identity = await this.catalogIdentity();
        const response = await this.clientTurn(att.actor, { ...frame, session: att.session }, identity.epoch);
        const payload = (await response.json()) as Record<string, unknown>;
        send({ type: "turn_result", ...(id !== undefined ? { id } : {}), status: response.status, ...payload });
      } catch (err) {
        send({
          type: "turn_result",
          ...(id !== undefined ? { id } : {}),
          status: 500,
          error: { code: isNetError(err) ? err.code : "E_INTERNAL", message: String(err) }
        });
      }
      return;
    }
    send({
      type: "error",
      ...(id !== undefined ? { id } : {}),
      error: { code: "E_INVARG", message: `unknown frame type ${JSON.stringify(frame.type)}` }
    });
  }

  /** Socket teardown is intentionally a no-op beyond the runtime's own
   * bookkeeping: the registry IS the hibernation socket set (a closed
   * socket leaves getWebSockets automatically) and the session CELL is
   * durable state that outlives any socket (kickoff rule). */
  async webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {}

  async webSocketError(_ws: WebSocket, _err: unknown): Promise<void> {}

  /** Record which session submitted a turn id (see recentClientTurns). */
  private noteClientTurn(turnId: string, session: string): void {
    this.recentClientTurns.delete(turnId); // refresh insertion order
    this.recentClientTurns.set(turnId, session);
    while (this.recentClientTurns.size > RECENT_CLIENT_TURN_CAP) {
      const oldest = this.recentClientTurns.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.recentClientTurns.delete(oldest);
    }
  }

  /**
   * Observation push (Phase 4 item 3 chunk 2): route an applied fanout's
   * observations to the sockets of sessions PRESENT in the fanout's
   * scope — CO13's session_presence relation gets its first consumer.
   *
   * - The audience is read from THIS shard's mirror
   *   (net_gateway_relation): a presence row whose owner space anchors
   *   to the fanout's scope names a member session; that session's
   *   tagged sockets (getWebSockets(session)) receive one
   *   {type:"observations", scope, seq, observations} frame. Sessions on
   *   other gateway shards are those shards' concern — they subscribe to
   *   the same scope and run this same routine.
   * - Owner→scope goes through the view-lineage classifier (CO15 walk),
   *   with the `room:<owner>` naming convention as the fallback for an
   *   owner whose lineage this view has not pulled.
   * - The SUBMITTING session is skipped via the turn-id echo dedupe
   *   (recentClientTurns): its observations arrived on the turn reply.
   * - Delivery is AT-MOST-ONCE and never durable (kickoff rule): the
   *   per-scope seq gate in receiveFanout drops redeliveries before this
   *   runs, a dead socket's send failure is swallowed (close cleanup is
   *   the runtime's), and a session with no socket is skipped silently.
   *   Missed-observation catch-up is deliberately NOT promised in
   *   Phase 4.
   */
  private pushObservations(body: FanoutBody): void {
    const getSockets = this.state.getWebSockets?.bind(this.state);
    if (!getSockets) return; // runtime without a WS surface (structural fakes)
    if (!Array.isArray(body.observations) || body.observations.length === 0) return;
    const rows = sqlRows<{ member: string; owner: string }>(
      this.state.storage.sql.exec("SELECT member, owner FROM net_gateway_relation WHERE relation = 'session_presence'")
    );
    if (rows.length === 0) return;
    const view = this.ensureView();
    const classifier = classifierFromLineage(
      (object) => (view.get(cellKey("object_lineage", object))?.value as AnchorLineage | undefined) ?? null
    );
    const frame = JSON.stringify({
      type: "observations",
      scope: body.scope,
      seq: body.seq,
      observations: body.observations
    });
    for (const row of rows) {
      let ownerScope: string | null;
      try {
        ownerScope = classifier.scopeOf(row.owner);
      } catch {
        ownerScope = null; // lineage not in view — the convention check decides
      }
      if (ownerScope !== body.scope && `room:${row.owner}` !== body.scope) continue;
      if (body.turn_id !== undefined && this.recentClientTurns.get(body.turn_id) === row.member) continue;
      for (const ws of getSockets(row.member)) {
        try {
          ws.send(frame);
        } catch {
          // Dead socket: the runtime's close/error callback owns cleanup.
        }
      }
    }
  }

  /**
   * Best-effort pulls for scopes this gateway holds no high-water for —
   * the cold-view warm-up shared by /net/plan-scheduled and the /net-api
   * surface. Failures are named metrics, never throws: the caller's
   * normal machinery (E_MISSING_STATE recovery, view/session checks) is
   * the fallback. Head-0 caveat (documented at planScheduled): a scope
   * whose head never advanced records no high-water and re-pulls per
   * request — redundant but harmless.
   */
  private async warmScopes(scopes: Iterable<string>, metricKind: string): Promise<void> {
    this.ensureView(); // hydrates the `seen` high-water map alongside the view
    for (const scope of new Set(scopes)) {
      if (this.seen.has(scope)) continue;
      try {
        await this.pull({ scope, destination: `scope:${scope}` });
      } catch (err) {
        console.log("woo.metric", JSON.stringify({ kind: metricKind, scope, error: String(err), ts: Date.now() }));
      }
    }
  }

  /** The (relation, owner) member rows from the fanout-fed mirror — the
   * CO13 client-read primitive, shared by /net/relation (internal) and
   * /net-api/relation (client). */
  /**
   * B1 read authorization (deny-by-default). Authentication proves WHO the
   * caller is; this proves WHAT they may see. Two hard rules plus a
   * presence scope:
   *
   * 1. **Credential/system/bytecode cells are never readable by clients.**
   *    The identity map (`property_cell:$system:api_keys`), bearer/pending
   *    credential props, any `$system` cell, and verb bytecode are denied
   *    outright — auth pulls the identity map into this very view, so
   *    without this rule any key could read the salted-hash records.
   * 2. **A caller sees its own identity + what it is co-present with.** The
   *    caller's own actor and session cells are always allowed. Otherwise
   *    a cell is readable only if its object is present in — or is — a
   *    scope the caller's session occupies (CO13 session_presence /
   *    contents in the mirror); a relation is readable only if its owner
   *    is such a scope (or the caller's own actor). No global reads.
   *
   * `caller` is the authenticated actor; `session` is the caller's
   * validated session id (required on reads — the presence anchor).
   */
  /** The caller's session from `?session=`, validated as a live cell bound
   * to the authenticated actor (B1: reads are presence-scoped, so a valid
   * session is the anchor). Throws ClientAuthError on a missing/invalid/
   * foreign session. */
  private readSession(url: URL, actor: string): string {
    const session = url.searchParams.get("session") ?? "";
    if (!session) {
      throw new ClientAuthError("reads require a session query param (B1: presence-scoped)", { reason: "session_required" });
    }
    const verdict = validateSessionCell(this.ensureView().get(sessionCellKey(session)), this.host.now(), actor);
    if (verdict !== "ok") {
      throw new ClientAuthError(`session ${verdict}`, { session_verdict: verdict });
    }
    return session;
  }

  private callerPresenceScopes(session: string, caller: string): Set<string> {
    // Where the caller is present. Three signals, all bounded to the
    // caller's own state (never a global scan):
    // 1. The caller's ACTOR's live location — you are present where your
    //    actor stands. This is the primary, always-correct signal (a
    //    freshly-minted session whose actor already occupies a room has a
    //    null activeScope but is plainly present there).
    // 2. The session cell's activeScope (the CO13 presence scope a
    //    transition set) — a session that moved elsewhere than its actor's
    //    static location.
    // 3. session_presence rows for this session.
    const scopes = new Set<string>();
    const actorLive = this.ensureView().get(cellKey("object_live", caller));
    const location = (actorLive?.value as { location?: unknown } | undefined)?.location;
    if (typeof location === "string" && location) scopes.add(location);
    const cell = this.ensureView().get(sessionCellKey(session));
    const active = (cell?.value as { activeScope?: unknown } | undefined)?.activeScope;
    if (typeof active === "string" && active) scopes.add(active);
    const rows = sqlRows<{ owner: string }>(
      this.state.storage.sql.exec(
        "SELECT owner FROM net_gateway_relation WHERE relation = 'session_presence' AND member = ?",
        session
      )
    );
    for (const r of rows) scopes.add(r.owner);
    return scopes;
  }

  private denyCredentialCell(key: string): boolean {
    // key = <kind>:<object>[:<name>]
    const parts = key.split(":");
    const kind = parts[0];
    const object = parts[1] ?? "";
    const name = parts[2] ?? "";
    if (kind === "verb_bytecode") return true; // clients never read bytecode
    if (object === "$system") return true; // the whole system object
    if (kind === "property_cell") {
      // Credential-shaped property names anywhere, defensively.
      if (name === "api_keys" || name === "bearer_tokens" || name === "pending_credentials") return true;
    }
    return false;
  }

  /** Authorize a cell read; throws ClientAuthError(403) on denial. */
  private authorizeCellRead(caller: string, session: string, key: string): void {
    if (this.denyCredentialCell(key)) {
      throw new ClientAuthError("cell not readable", { key }, "E_PERM", 403);
    }
    const parts = key.split(":");
    const kind = parts[0];
    const object = parts[1] ?? "";
    // Own identity is always readable: the caller's actor cells + its own
    // session cell.
    if (object === caller) return;
    if (kind === "session" && object === session) return;
    // Co-presence: the object IS one of the caller's rooms, or it LIVES in
    // one. The object's own live cell location is the authoritative,
    // lag-free membership signal (the contents relation mirror only
    // materializes on commit/rebuild; a freshly-pulled object has its live
    // cell but maybe not yet a roster row). Fall back to the contents
    // roster for objects whose live cell the view lacks.
    const scopes = this.callerPresenceScopes(session, caller);
    if (scopes.has(object)) return;
    const liveCell = this.ensureView().get(cellKey("object_live", object));
    const location = (liveCell?.value as { location?: unknown } | undefined)?.location;
    if (typeof location === "string" && scopes.has(location)) return;
    for (const scope of scopes) {
      const present = sqlRows<{ n: number }>(
        this.state.storage.sql.exec(
          "SELECT 1 AS n FROM net_gateway_relation WHERE relation = 'contents' AND owner = ? AND member = ? LIMIT 1",
          scope,
          object
        )
      );
      if (present.length > 0) return;
    }
    throw new ClientAuthError("cell not readable in the caller's presence", { key }, "E_PERM", 403);
  }

  /** Authorize a relation read; throws ClientAuthError(403) on denial. */
  private authorizeRelationRead(caller: string, session: string, owner: string): void {
    if (owner === caller) return; // the caller's own relations
    if (this.callerPresenceScopes(session, caller).has(owner)) return; // a room the caller is in
    throw new ClientAuthError("relation not readable in the caller's presence", { owner }, "E_PERM", 403);
  }

  private relationMembers(relation: string, owner: string): Array<{ member: string; body?: unknown }> {
    return sqlRows<{ member: string; body: string | null }>(
      this.state.storage.sql.exec(
        "SELECT member, body FROM net_gateway_relation WHERE relation = ? AND owner = ? ORDER BY member ASC",
        relation,
        owner
      )
    ).map((row) => ({
      member: row.member,
      ...(row.body !== null ? { body: JSON.parse(row.body) as unknown } : {})
    }));
  }

  /** The scope pinned to an idempotency key, or null (fix 5c). */
  private pinnedScope(idempotencyKey: string): string | null {
    const rows = sqlRows<{ scope: string }>(
      this.state.storage.sql.exec("SELECT scope FROM net_gateway_pin WHERE idempotency_key = ?", idempotencyKey)
    );
    return rows.length > 0 ? rows[0].scope : null;
  }

  /** Persist the key → scope pin; first writer wins (fix 5c). */
  private pinScope(idempotencyKey: string, scope: string): void {
    this.state.storage.sql.exec(
      "INSERT INTO net_gateway_pin (idempotency_key, scope) VALUES (?, ?) ON CONFLICT(idempotency_key) DO NOTHING",
      idempotencyKey,
      scope
    );
  }

  /**
   * Owner attestations for the planned transcript's foreign reads
   * (CO2.3 rider integrity, rule 1). Partition the reads by owning scope
   * — the classifier is the same routing refreshCells uses — and fetch
   * `POST /net/attest` from each owner whose scope is NOT the committing
   * one. The committing scope validates rider reads against these instead
   * of skipping them; a foreign read submitted without its attestation
   * rejects terminal `rider_unattested`. Returns undefined when every
   * read is local to the committing scope (the warm single-scope case
   * adds no RPC). Under the derived classifier, class-chain reads anchor
   * to the catalog scope, so a cross-class turn attests against the
   * catalog sequencer like any other owner (CO15).
   */
  private async attestForeignReads(
    request: TurnRequest,
    classifier: ScopeClassifier,
    planned: PlanTurnResult,
    targetScope: string
  ): Promise<CommitSubmit["attestations"]> {
    const byOwner = new Map<string, Set<string>>();
    for (const read of planned.transcript.reads) {
      const key = netCellKeyFor(read.cell);
      if (key === null) continue; // contents reads are projection reads (CA4)
      // CO14: session cells classify by the calling actor (sessions.ts
      // classification rule — session ids carry no lineage; their
      // authority is the actor's cluster). The folded session read of a
      // room-committed turn attests at the cluster like any rider read.
      const owner =
        read.cell.kind === "session"
          ? classifier.scopeOf(planned.transcript.call.actor)
          : classifier.scopeOf(read.cell.object);
      if (owner === targetScope) continue; // validated locally at the committing scope
      const keys = byOwner.get(owner) ?? new Set<string>();
      keys.add(key);
      byOwner.set(owner, keys);
    }
    if (byOwner.size === 0) return undefined;
    const attestations: NonNullable<CommitSubmit["attestations"]> = {};
    for (const [owner, keys] of byOwner) {
      const destination = this.destinationFor(request, owner);
      const reply = (await this.host.rpc(destination, "/attest", { keys: [...keys].sort() })) as {
        owner_head: ScopeHead;
        cells: Array<{ key: string; version: string }>;
      };
      attestations[owner] = { owner_head: reply.owner_head, cells: reply.cells };
    }
    return attestations;
  }

  /** Rider forwarding directions for the committing scope (CA3): for
   * each rider scope in the selection, its rpc destination plus the
   * objects the TRANSCRIPT writes there — writes/moves/creates
   * classified by the same walk route.ts selected the scope with. The
   * object list rides because the scope shell must know WHICH accepted
   * cells are the rider's, and the sequencer itself never learns rider
   * topology (src/net/scope.ts types stay unchanged). */
  private riderDestinationsFor(
    request: TurnRequest,
    classifier: ScopeClassifier,
    planned: PlanTurnResult
  ): Record<string, { destination: string; objects: string[] }> {
    const riders = new Set(planned.selection.riders);
    if (riders.size === 0) return {};
    const objectsByScope = new Map<string, Set<string>>();
    const put = (scope: string, object: string): void => {
      if (!riders.has(scope)) return;
      const set = objectsByScope.get(scope) ?? new Set<string>();
      set.add(object);
      objectsByScope.set(scope, set);
    };
    for (const write of planned.transcript.writes) {
      if (netCellKeyFor(write.cell) === null) continue; // contents → projection (CA4)
      // CO14: a folded session-cell write rides to the ACTOR's cluster
      // (the same classification route.ts selected the rider scope with);
      // the listed object is the session id, so the scope shell picks the
      // accepted session cell for the /adopt row.
      const owningScope =
        write.cell.kind === "session"
          ? classifier.scopeOf(planned.transcript.call.actor)
          : classifier.scopeOf(write.cell.object);
      put(owningScope, write.cell.object);
    }
    for (const move of planned.transcript.moves ?? []) {
      put(classifier.scopeOf(move.object), move.object);
    }
    for (const create of planned.transcript.creates ?? []) {
      // route.ts rule: a create's cells land at its anchor's scope when
      // declared, else with the planning scope.
      put(create.anchor ? classifier.scopeOf(create.anchor) : request.planningScope, create.object);
    }
    const out: Record<string, { destination: string; objects: string[] }> = {};
    for (const rider of planned.selection.riders) {
      out[rider] = {
        destination: this.destinationFor(request, rider),
        objects: [...(objectsByScope.get(rider) ?? new Set<string>())].sort()
      };
    }
    return out;
  }

  /** CO13 relation-owner directions for the committing scope: the
   * transcript's relation OWNER objects — move sources/destinations,
   * create locations, contents-write containers, session-transition
   * rooms — classified by the same walk route.ts selects scopes with,
   * keeping only owners anchored to a scope OTHER than the committing
   * one. The scope shell feeds these to the sequencer's delta partition
   * (`scopeOf`) and addresses the /net/relate outbox rows from them —
   * anchor topology stays gateway knowledge (the rider_destinations
   * rule). An owner the classifier cannot place falls back to the
   * planning scope inside `classifierFor`, so a same-turn-created
   * container classifies with the turn, never as a spurious foreign
   * owner. */
  private relateDestinationsFor(
    request: TurnRequest,
    classifier: ScopeClassifier,
    planned: PlanTurnResult,
    targetScope: string
  ): Record<string, { destination: string; objects: string[] }> {
    const owners = new Set<string>();
    for (const move of planned.transcript.moves ?? []) {
      if (move.from) owners.add(move.from);
      owners.add(move.to);
    }
    for (const create of planned.transcript.creates ?? []) {
      if (create.location) owners.add(create.location);
    }
    for (const write of planned.transcript.writes) {
      if (write.cell.kind === "contents") owners.add(write.cell.object);
    }
    const transition = planned.transcript.sessionScopeTransition;
    if (transition?.from) owners.add(transition.from);
    if (transition?.to) owners.add(transition.to);

    const objectsByScope = new Map<string, Set<string>>();
    for (const owner of owners) {
      const scope = classifier.scopeOf(owner);
      if (scope === targetScope) continue; // local owner: the commit applies its rows itself
      const set = objectsByScope.get(scope) ?? new Set<string>();
      set.add(owner);
      objectsByScope.set(scope, set);
    }
    const out: Record<string, { destination: string; objects: string[] }> = {};
    for (const [scope, objects] of objectsByScope) {
      out[scope] = { destination: this.destinationFor(request, scope), objects: [...objects].sort() };
    }
    return out;
  }

  /** One planning pass against the current view. The provisional base is
   * patched after the head fetch — `base` is an envelope field, not part
   * of the transcript hash. Catalog-scope lineage keys ride as the
   * receiver-known set (CO15: class chains never reship). */
  private async planOnce(request: TurnRequest, view: CellStore, classifier: ScopeClassifier): Promise<PlanTurnResult> {
    return planTurn({
      call: request.call,
      view,
      planningScope: request.planningScope,
      classifier,
      base: { seq: 0, hash: "provisional" },
      idempotencyKey: request.idempotency_key,
      stamp: { scope_head: "gateway", catalog_epoch: request.catalog_epoch },
      receiverKnown: this.catalogKnownKeys(view, classifier),
      ...(request.counters !== undefined ? { counters: request.counters } : {})
    });
  }

  /** Run a recovery action; a failure (e.g. the closure fetch itself
   * dying) is recorded on the round's trace entry (`recovery_error`) and
   * the loop simply retries — the budget and attempt ceiling bound how
   * long, which is exactly the E_BUDGET path the trace then explains.
   * Returns the action's value, or undefined when it failed. */
  private async tryRecovery<T>(trace: AttemptTraceEntry[], action: () => Promise<T>): Promise<T | undefined> {
    try {
      return await action();
    } catch (err) {
      const last = trace[trace.length - 1] as (AttemptTraceEntry & { recovery_error?: string }) | undefined;
      if (last) last.recovery_error = String(err);
      return undefined;
    }
  }

  /** Warm cache-fill (CO7): accepted cells become the view's derived
   * copies, so the next turn plans locally. A touched key with no cell
   * in the transfer was deleted at the authority; mirror the deletion. */
  private async installTouched(view: CellStore, destination: string, touched: string[]): Promise<void> {
    const transfer = (await this.host.rpc(destination, "/closure", { keys: touched, known: [] })) as CellTransfer;
    const wanted = new Set(touched);
    this.discardViewOnThrow(() =>
      this.state.storage.transactionSync(() => {
        for (const cell of transfer.cells) {
          view.install(cell);
          this.persistCell(view, cell.key);
          wanted.delete(cell.key);
        }
        for (const key of wanted) {
          view.delete(key);
          this.persistCell(view, key);
        }
      })
    );
  }

  /** Targeted view refresh (the E_READ_VERSION / E_MISSING_STATE
   * recovery): fetch exactly `keys`, lineage-closed, from each key's
   * owning scope — the classifier routes each object (its fallback
   * already covers objects the view cannot classify: they refresh from
   * the planning scope, the legacy behavior). `known` is the view's
   * lineage keys, so the transfer never reships the class chain (CO7).
   * A requested key that comes back absent was deleted at the
   * authority. */
  private async refreshCells(
    request: TurnRequest,
    classifier: ScopeClassifier,
    view: CellStore,
    keys: string[]
  ): Promise<void> {
    if (keys.length === 0) return;
    // Owner-KNOWN keys (the view holds the object's lineage, or the key
    // names the call's session — sessions.ts rule) route to their owner
    // and use authoritative-absence semantics: a key the owner does not
    // return was deleted there, so it deletes here. Owner-UNKNOWN keys
    // (no lineage in view — the classifier's scopeOf answer is only its
    // fallback) get pull-on-miss semantics instead: try the fallback,
    // then the CO15 naming-convention candidates (`room:<object>`,
    // `cluster:<object>` — the same convention the CO16 planner uses),
    // and NEVER delete on a miss — a misrouted fetch proves nothing
    // about the cell's existence. Still-missing keys stay missing; the
    // next repair round's trace names them (bounded by the budget).
    const byDestination = new Map<string, string[]>();
    const unknownOwner: string[] = [];
    for (const key of keys) {
      const object = objectOfCellKey(key);
      if (key.startsWith("session:")) {
        const destination = this.destinationFor(request, classifier.scopeOf(request.call.actor));
        byDestination.set(destination, [...(byDestination.get(destination) ?? []), key]);
      } else if (view.has(cellKey("object_lineage", object))) {
        const destination = this.destinationFor(request, classifier.scopeOf(object));
        byDestination.set(destination, [...(byDestination.get(destination) ?? []), key]);
      } else {
        unknownOwner.push(key);
      }
    }
    const known = [...view.keys()].filter((key) => key.startsWith("object_lineage:"));
    for (const [destination, want] of byDestination) {
      const transfer = (await this.host.rpc(destination, "/closure", { keys: want, known })) as CellTransfer;
      const wanted = new Set(want);
      this.discardViewOnThrow(() =>
        this.state.storage.transactionSync(() => {
          for (const cell of transfer.cells) {
            view.install(cell);
            this.persistCell(view, cell.key);
            wanted.delete(cell.key);
          }
          for (const key of wanted) {
            view.delete(key);
            this.persistCell(view, key);
          }
        })
      );
    }
    if (unknownOwner.length === 0) return;
    const byObject = new Map<string, string[]>();
    for (const key of unknownOwner) {
      const object = objectOfCellKey(key);
      byObject.set(object, [...(byObject.get(object) ?? []), key]);
    }
    // The actor's live location names the room the turn is happening in
    // — the strongest candidate for cells of objects addressed there.
    const actorLive = view.get(cellKey("object_live", request.call.actor))?.value as { location?: string | null } | undefined;
    const actorRoom = typeof actorLive?.location === "string" && actorLive.location ? `room:${actorLive.location}` : null;
    for (const [object, want] of byObject) {
      const candidates = [
        ...(actorRoom ? [this.destinationFor(request, actorRoom)] : []),
        this.destinationFor(request, classifier.scopeOf(object)),
        this.destinationFor(request, `room:${object}`),
        this.destinationFor(request, `cluster:${object}`)
      ];
      let satisfied = false;
      for (const destination of [...new Set(candidates)]) {
        if (satisfied) break;
        try {
          const transfer = (await this.host.rpc(destination, "/closure", { keys: want, known })) as CellTransfer;
          if (transfer.cells.length === 0) continue;
          this.discardViewOnThrow(() =>
            this.state.storage.transactionSync(() => {
              for (const cell of transfer.cells) {
                view.install(cell);
                this.persistCell(view, cell.key);
              }
            })
          );
          satisfied = true;
        } catch {
          // A candidate that is not a real scope (no durable state)
          // refuses — expected for convention probes; try the next.
        }
      }
    }
  }

  /** Full-closure install from the scope — the CO8 named reseed and the
   * /net/pull live path share this. */
  private async reseedFromScope(
    view: CellStore,
    destination: string,
    known: string[] = []
  ): Promise<CellTransfer & { scope: string; head: ScopeHead; catalog_epoch: string; relations?: RelationRow[] }> {
    const transfer = (await this.host.rpc(destination, "/closure", { keys: ["*"], known })) as CellTransfer & {
      scope: string;
      head: ScopeHead;
      catalog_epoch: string;
      relations?: RelationRow[];
    };
    this.discardViewOnThrow(() =>
      this.state.storage.transactionSync(() => {
        for (const cell of transfer.cells) {
          view.install(cell);
          this.persistCell(view, cell.key);
        }
        // CO13: the full closure carries the scope's relation rows —
        // upsert them into the mirror in the same transaction. Required
        // for coherence with fix 7 below: advancing the high-water
        // no-ops every earlier relation fanout/refan, so without this
        // the mirror would silently lose the rows those deliveries
        // carried. Upsert-only: a mirror row deleted at the authority
        // while this gateway was unsubscribed lingers until a later
        // remove delta (seq above the new high-water) heals it — a
        // fresh shard's mirror is exact, which is the pull-on-miss case
        // this exists for.
        for (const row of transfer.relations ?? []) {
          this.applyRelationDelta({ op: "add", row });
        }
        // Fix 7: the closure carries the scope's head — the view now IS
        // the state at that head, so the fanout high-water advances with
        // it (same transaction as the install). A stale pre-pull fanout
        // row then no-ops by seq instead of regressing the fresh view.
        this.advanceSeen(transfer.scope, transfer.head.seq);
      })
    );
    return transfer;
  }

  /** Raise a scope's fanout high-water to `seq` (never lowers) — memory
   * and SQLite together, matching how ensureView hydrates them (fix 7). */
  private advanceSeen(scope: string, seq: number): void {
    const last = this.seen.get(scope) ?? 0;
    if (seq <= last) return;
    // SQL first, memory second: if the durable write throws, memory has
    // not moved (memory-follows-durable, fix 3 discipline).
    this.state.storage.sql.exec(
      "INSERT INTO net_gateway_scope (scope, seen_seq) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET seen_seq = excluded.seen_seq",
      scope,
      seq
    );
    this.seen.set(scope, seq);
  }

  /** CO2.5 receiver idempotency + copy-#2 persistence, one transaction. */
  private receiveFanout(body: FanoutBody): boolean {
    const view = this.ensureView();
    // Receiver contiguity (fix 4c): applyFanout is idempotent by seq but
    // deliberately applies AHEAD of a hole (a sender's earlier row may
    // have abandoned). A skipped seq is a named divergence (CO6) — count
    // it before applying. Whether to reseed on a gap is Phase-3.5
    // policy; the metric is the discipline now.
    const last = this.seen.get(body.scope) ?? 0;
    if (body.seq > last + 1) {
      console.log(
        "woo.metric",
        JSON.stringify({ kind: "net_fanout_gap", scope: body.scope, expected: last + 1, got: body.seq, ts: Date.now() })
      );
    }
    const applied = this.discardViewOnThrow(() =>
      this.state.storage.transactionSync(() => {
        const advanced = applyFanout(view, this.seen, body);
        if (advanced) {
          for (const cell of body.cells) this.persistCell(view, cell.key);
          // CO13: relation deltas ride the same body and the same seq
          // gate — a redelivered body no-ops above (applyFanout), so the
          // mirror never double-applies. applyFanout itself stays
          // cell-only (relation rows are not cells); the shell owns the
          // mirror table.
          for (const delta of body.relations ?? []) this.applyRelationDelta(delta);
          this.state.storage.sql.exec(
            "INSERT INTO net_gateway_scope (scope, seen_seq) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET seen_seq = excluded.seen_seq",
            body.scope,
            body.seq
          );
        }
        return advanced;
      })
    );
    // Observation push (item 3 chunk 2) AFTER the mirror application, so
    // a presence transition riding this very body shapes its own
    // audience (an enter's add is visible; a leave's remove already
    // excludes the leaver). The seq gate above makes the push
    // at-most-once per socket per turn: redeliveries never reach here.
    if (applied) this.pushObservations(body);
    return applied;
  }

  /** One relation delta into the mirror table (add = upsert, remove =
   * delete; both idempotent, matching applyRelationDeltas' semantics at
   * the owning scope). */
  private applyRelationDelta(delta: RelationDelta): void {
    const key = relationKey(delta.row.relation, delta.row.owner, delta.row.member);
    if (delta.op === "add") {
      this.state.storage.sql.exec(
        "INSERT INTO net_gateway_relation (key, relation, owner, member, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body",
        key,
        delta.row.relation,
        delta.row.owner,
        delta.row.member,
        delta.row.body !== undefined ? JSON.stringify(delta.row.body) : null
      );
    } else {
      this.state.storage.sql.exec("DELETE FROM net_gateway_relation WHERE key = ?", key);
    }
  }

  /**
   * Memory-follows-durable (fix 3): applyFanout / view installs mutate
   * the in-memory view (and the `seen` high-water) inside the callback;
   * if the durable transaction then aborts, memory is ahead of SQLite —
   * a replayed delivery would no-op against a phantom high-water and the
   * write would be lost. On ANY throw, discard the view AND the seen map
   * (they hydrate together in ensureView) so the next request rehydrates
   * both from the rolled-back durable state, then rethrow. Handles sync
   * and async callbacks (the stale_epoch recovery block awaits inside).
   */
  private discardViewOnThrow<T>(fn: () => T): T {
    const discard = (): void => {
      this.view = null;
      this.seen.clear();
    };
    try {
      const result = fn();
      if (result instanceof Promise) {
        return result.catch((err: unknown) => {
          discard();
          throw err;
        }) as unknown as T;
      }
      return result;
    } catch (err) {
      discard();
      throw err;
    }
  }

  /** Lazy hydration of the derived view + per-scope high-water. */
  private ensureView(): CellStore {
    if (this.view) return this.view;
    const view = new CellStore("derived");
    for (const row of sqlRows<{ body: string }>(this.state.storage.sql.exec("SELECT body FROM net_gateway_cell"))) {
      view.install(JSON.parse(row.body) as Cell);
    }
    for (const row of sqlRows<{ scope: string; seen_seq: number } & ScopeRow>(
      this.state.storage.sql.exec("SELECT scope, seen_seq FROM net_gateway_scope")
    )) {
      this.seen.set(row.scope, row.seen_seq);
    }
    this.view = view;
    return view;
  }

  /** Write-through for one view cell (installed or deleted). */
  private persistCell(view: CellStore, key: string): void {
    const cell = view.get(key);
    if (cell) {
      this.state.storage.sql.exec(
        "INSERT INTO net_gateway_cell (key, body) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body",
        key,
        JSON.stringify(cell)
      );
    } else {
      this.state.storage.sql.exec("DELETE FROM net_gateway_cell WHERE key = ?", key);
    }
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
