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
 *       POST /net-api/browser-metrics,
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
import {
  customerOfCellKey,
  normalizeCustomerAttribution,
  normalizePrincipal,
  type Principal
} from "../../net/attribution";
import { CellStore, cellKey, cellVersion, makeCell, type Cell } from "../../net/cells";
import { adoptOrMintTraceContext, normalizeTraceContext, parseTraceparent, type TraceContext } from "../../net/trace";
import { clampClientSessionTtl } from "../../net/client-session-policy";
import { budgetExhausted, isNetError, netError, nonconvergentRead, NetError, type AttemptTraceEntry, type NetErrorCode } from "../../net/errors";
import { applyFanout, type FanoutBody } from "../../net/outbox";
import { observationsForRelationOwners, relationKey, roomRosterRows, SESSION_PRESENCE_RELATION, type RelationDelta, type RelationRow, type RoomRosterRow } from "../../net/relations";
import { mintSessionSubmit, sessionCellKey, validateSessionCell } from "../../net/sessions";
import { sessionIdWithShardHint, ticketIdWithShardHint } from "../../net/session-id";
import {
  ORDERED_EDGE_RELATION,
  orderedNeighborsQueryKey,
  orderedProjectionKey,
  type OrderedNeighborsQuery,
  type OrderedNeighborsRequest,
  type OrderedProjectionKey
} from "../../net/ordered-edges";
import { planTurn, type PlanTurnInput, type PlanTurnResult } from "../../net/plan";
import type { ScopeClassifier } from "../../net/route";
import { CATALOG_SCOPE, classifierFromLineage, isEpochImmutableDefinition, type AnchorLineage } from "../../net/topology";
import type { CommitReply, CommitSubmit, RejectReason, ScheduledTurn, ScopeHead } from "../../net/scope";
import { netCellKeyFor, type EffectTranscript } from "../../net/transcript";
import type { CellTransfer } from "../../net/cells";
import { randomHex } from "../../core/source-hash";
import {
  GUEST_RESET_NATIVE,
  guestResetVerbPageFor,
  guestResetVerbSlot,
  isCurrentGuestResetVerbPageFor,
  isRecognizedGuestResetVerbPageFor
} from "../../core/bootstrap";
import { turnEchoId } from "../../net/turn-echo";
import type { ShadowTurnCall } from "../../core/shadow-turn-call";
import { provisionGuestSubmit, type GuestTemplate } from "../../net/guest";
import { verifyInternalRequest } from "../internal-auth";
import { emitMetric, type AnalyticsMetric } from "../metrics-sink";
import { ClientAuthError, MAX_EMAIL_BYTES, MAX_PASSWORD_BYTES, normalizeEmail, parseClientCredential, verifyApiKeyCredential, verifyPasswordCredential } from "./client-auth";
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
  /** H1: THIS gateway's own rpc destination (e.g. `gateway:net-api`) —
   * the name a scope fans out to. Set on the CLIENT-surface shard so a
   * client session auto-subscribes this gateway to the scopes it touches
   * (selfSubscribe); peer observation push then works without any
   * external /net/subscribe call. Unset on the internal /net/turn lane
   * path and on unit fixtures that wire subscribers by hand — where
   * self-subscribe is a no-op (backward compatible). */
  NET_GATEWAY_SELF?: string;
  /** Maximum time an admitted turn may wait behind its planning scope. */
  NET_TURN_QUEUE_WAIT_MS?: string;
  /** Bounded concurrent planning/submission lanes per scope on this shard. */
  NET_TURN_SCOPE_CONCURRENCY?: string;
};

function sqlRows<T>(cursor: unknown): T[] {
  return (cursor as { toArray(): T[] }).toArray();
}

type ScopeRow = { seen_seq: number };
const MAX_NET_BROWSER_METRICS_BATCH = 50;

/** One owner-computed ordered-children projection the gateway fetched for a
 * turn: the bounded rows plus the authority `version` (content address) the
 * plan attests so a concurrent same-parent insert makes the submit stale (P1.1). */
type OrderedChildrenProjection = { container: string; scope: string; parent: string | null; rows: readonly Record<string, unknown>[]; version: string };

/** One owner-answered bounded neighbour query (P2.4): the O(1)
 * {count, index, before, after, child_index} answer plus the same authority
 * ordering `version` a full projection carries, so the attestation is
 * identical — only the payload shrinks from O(width) to constant. */
type OrderedNeighborsProjection = { container: string; query: OrderedNeighborsQuery; scope: string; value: Record<string, unknown>; version: string };
type OrderingConflict = { scope: string; container: string; parent: string | null };

function validOrderedProjectionKey(value: unknown): value is OrderedProjectionKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { container?: unknown; parent?: unknown };
  return typeof candidate.container === "string" && candidate.container.length > 0
    && (candidate.parent === null || typeof candidate.parent === "string");
}

function validOrderedNeighborsRequest(value: unknown): value is OrderedNeighborsRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { container?: unknown; query?: unknown };
  if (typeof candidate.container !== "string" || !candidate.container || !candidate.query || typeof candidate.query !== "object" || Array.isArray(candidate.query)) return false;
  const query = candidate.query as Partial<OrderedNeighborsQuery>;
  return (query.parent === null || typeof query.parent === "string")
    && (query.index === null || typeof query.index === "number")
    && (query.exclude === null || typeof query.exclude === "string")
    && (query.child === null || typeof query.child === "string");
}

function validOrderingConflict(value: unknown): value is OrderingConflict {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { scope?: unknown; container?: unknown; parent?: unknown };
  return typeof candidate.scope === "string" && candidate.scope.length > 0
    && typeof candidate.container === "string" && candidate.container.length > 0
    && (candidate.parent === null || typeof candidate.parent === "string");
}

/** CO10: the ratified repair budget for one /net/turn. */
export const REPAIR_BUDGET_MS = 12_000;

/** Attempt ceiling inside the budget. Every defined recovery converges in
 * one round when its refresh succeeds; six rounds leaves room for a
 * recovery whose refresh itself fails transiently. More than that means
 * the recovery is not converging and burning budget will not help. */
export const MAX_TURN_ATTEMPTS = 6;

type TurnRequest = {
  call: PlanTurnInput["call"];
  /** AU3.2 principal, stamped by the gateway auth boundary — never from
   * client input. Folded into the transcript body by the planner. */
  principal?: Principal;
  /** AU2 trace context (adopted from the caller's traceparent or minted
   * here); folded into the transcript body alongside the principal. */
  trace?: TraceContext;
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
  /** Where the session starts (client-shell phase i — see
   * MintSessionInput.activeScope): the client path passes the actor's
   * live location so a fresh session is born PRESENT and receives
   * cross-actor observations before its first move; absent = the
   * pre-existing placeless mint. */
  active_scope?: string | null;
  /** Identity-door guest claim (see MintSessionInput.exclusive): refuse
   * `actor_occupied` at the cluster sequencer when another live session
   * binds the actor. */
  exclusive?: boolean;
  /** Retry-stable wall clock for a public guest claim. Internal callers that
   * omit it retain the gateway host's current time. */
  issued_at_ms?: number;
  /** Session close (finding 12 — see MintSessionInput.closing). */
  closing?: { priorActiveScope: string | null; ephemeralActor?: boolean };
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
  /** The commit is durable and its relation outbox remains authoritative, but
   * the synchronous presence-freshness expedite failed. */
  relation_expedite_degraded?: boolean;
  /** D2 / CO10: the turn's structural budget counts (CO12.3 "budget
   * gates"). Present on every settled TurnResult (accepted or terminal);
   * lets a unit lane assert the warm-turn structure directly rather than
   * scraping the emitted metric. */
  structure?: TurnStructureReport;
};

/**
 * D2 / CO10: per-turn structural budget counters (the CO12.3 "budget
 * gates": sync RPCs, scope-row writes, reconstructions per turn). Threaded
 * explicitly through the turn's RPC sites rather than kept on the DO
 * instance, so the count stays correct even when the runtime interleaves
 * another turn across an await — a shared instance counter could not tell
 * two concurrent turns apart. The shared RPC helpers take it as OPTIONAL:
 * a non-turn caller (/net/pull, session-open cache-fill) passes none and
 * nothing is counted, leaving their behaviour unchanged.
 */
/** NC8b hard per-turn budgets (spec/operations/net-cutover.md). The
 * attempt loop already bounds ROUNDS; these bound the work WITHIN a turn
 * — a pathological plan fanning to many owners (attest/refresh across K
 * scopes) must refuse with a named verdict instead of grinding. Generous
 * by design: a legitimate cold turn (head + several repair closures +
 * submit + install) sits far below both. */
const MAX_TURN_SYNC_RPC = 32;
const MAX_TURN_RPC_MS = 30_000;
// One room presentation read may expand only its direct membership. This is
// the same boundedness contract as the legacy sparse-MCP authority expansion:
// it is O(one room), never a recursive/world enumeration.
const MAX_ROOM_CONTENT_AUTHORITY_OBJECTS = 128;

// Exported for the NC8 unit lane (tests/worker/net-turn-structure.test.ts):
// the budget/parallelism mechanics are asserted directly, the integrated
// counts through full turns.
export class TurnStructure {
  /** Cross-host RPCs on the SYNCHRONOUS reply path (CO10 warm budget ≤ 3:
   * /head + /submit + the post-accept installTouched /closure). Post-reply
   * outbox fanout is excluded by construction — it is not on this path. */
  sync_rpc = 0;
  /** Authority reconstructions: the view rebuilt from a scope closure
   * (refreshCells targeted refresh / reseedFromScope full reseed). The
   * warm path never reconstructs. installTouched (the happy-path warm
   * cache-fill) is deliberately NOT counted here — it is not a repair. */
  reconstructions = 0;
  /** Phase 0 / CO10: cells fed to the planner (`PlanTurnResult.planCells`)
   * on the round that settled — the planner INPUT size. Slice planning
   * keeps it ~read-set regardless of view size; the load gate's plan
   * invariant asserts against this. Set per round so a settled turn
   * reports its final plan's input. */
  plan_cells = 0;
  /** Phase 0: cells in the settled attempt's fix-6 snapshot
   * (`PlanTurnResult.snapshotCells`). Under slice planning this is the
   * seed SLICE the whole turn (clone/scratch/rewrite/closure) operates on,
   * so it must stay flat as the view grows — the load gate's blocker-#1
   * invariant asserts it alongside plan_cells. */
  snapshot_cells = 0;
  /** NC8a: turn start (Date.now) for the report's wall_ms. */
  readonly started = Date.now();
  /** Finding 11: time spent WAITING in the per-scope turn queue before
   * this turn ran — the hot-scope serialization cost meter. */
  queue_ms = 0;
  /** NC8a timing: awaited RPC time on the turn path. While every RPC is
   * a serial await, rpc_ms IS the critical-path RPC time; a parallel
   * group (rpcGroup) adds its LONGEST member, keeping the critical-path
   * meaning as reads parallelize. Wall-clock (Date.now), metrics-grade. */
  rpc_ms = 0;
  rpc_max_ms = 0;
  /** NC8a critical-path depth: serial RPC STEPS. A single rpc() is one
   * step; an rpcGroup of K parallel calls is ALSO one step (they overlap),
   * while sync_rpc still counts all K. depth < sync_rpc therefore
   * measures how much of the fanout the turn paid in parallel. */
  rpc_depth = 0;
  /** Diagnostic attribution for budget refusals. Aggregate sync_rpc alone
   * cannot distinguish healthy fanout from a repair loop on real DOs. */
  private readonly rpcPhases = new Map<string, number>();
  countReconstruction(): void {
    this.reconstructions += 1;
  }
  /** NC8b: budget gate, checked BEFORE issuing work. `mandatory` skips
   * the gate for steps that must run regardless — the CO2.5 second
   * submit (disambiguation is not optional) and the post-accept warm
   * fill (the commit is already durable; refusing the fill would turn
   * an accepted turn into an error). */
  private assertBudget(adding: number, nextPhase: string): void {
    if (this.sync_rpc + adding > MAX_TURN_SYNC_RPC || this.rpc_ms > MAX_TURN_RPC_MS) {
      throw netError("E_BUDGET", "per-turn RPC budget exhausted", {
        sync_rpc: this.sync_rpc,
        rpc_ms: this.rpc_ms,
        next_phase: nextPhase,
        rpc_phases: Object.fromEntries([...this.rpcPhases].sort()),
        limit_rpc: MAX_TURN_SYNC_RPC,
        limit_rpc_ms: MAX_TURN_RPC_MS
      });
    }
  }
  /** One timed, counted, budgeted RPC step. */
  async rpc<T>(action: () => Promise<T>, options: { mandatory?: boolean; phase?: string } = {}): Promise<T> {
    const phase = options.phase ?? "unlabeled";
    if (!options.mandatory) this.assertBudget(1, phase);
    this.sync_rpc += 1;
    this.rpc_depth += 1;
    this.rpcPhases.set(phase, (this.rpcPhases.get(phase) ?? 0) + 1);
    const started = Date.now();
    try {
      return await action();
    } finally {
      const ms = Date.now() - started;
      this.rpc_ms += ms;
      this.rpc_max_ms = Math.max(this.rpc_max_ms, ms);
    }
  }
  /** One PARALLEL step of independent RPCs (NC8b "parallelize
   * independent reads"): all issued together, awaited together; counts K
   * toward sync_rpc but ONE step of depth and its longest member toward
   * rpc_ms. Rejections propagate after all settle (no orphaned writes
   * mid-group). */
  async rpcGroup<T>(actions: Array<() => Promise<T>>, options: { phase?: string } = {}): Promise<T[]> {
    if (actions.length === 0) return [];
    const phase = options.phase ?? "unlabeled_group";
    this.assertBudget(actions.length, phase);
    this.sync_rpc += actions.length;
    this.rpc_depth += 1;
    this.rpcPhases.set(phase, (this.rpcPhases.get(phase) ?? 0) + actions.length);
    const started = Date.now();
    try {
      const settled = await Promise.allSettled(actions.map((action) => action()));
      const failed = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
      if (failed) throw failed.reason;
      return (settled as Array<PromiseFulfilledResult<T>>).map((entry) => entry.value);
    } finally {
      const ms = Date.now() - started;
      this.rpc_ms += ms;
      this.rpc_max_ms = Math.max(this.rpc_max_ms, ms);
    }
  }
}

/** NC8a: the optional-structure adapter for shared helpers — a non-turn
 * caller (live /net/pull, session-open cache-fill) passes no structure
 * and the action just runs, uncounted and unbudgeted (their behavior is
 * unchanged; they are not on a turn's reply path). */
async function timedRpc<T>(
  structure: TurnStructure | undefined,
  action: () => Promise<T>,
  options: { mandatory?: boolean; phase?: string } = {}
): Promise<T> {
  return structure ? structure.rpc(action, options) : action();
}

/** Convention probes intentionally address scope names that may never have
 * existed. WorkerdHost preserves the signed peer's structured 404 in the
 * message; suppress only the exact empty-DO verdict, never auth, timeout, or a
 * populated scope's operational failure. */
function isAbsentScopeProbe(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const emptyDurableObject = message.includes("/closure failed: 404")
    && message.includes('"code":"E_MISSING_STATE"')
    && message.includes('"has_meta":false');
  // Structural fake namespaces enumerate only seeded DOs instead of modeling
  // Cloudflare's idFromName (which always resolves and then returns the empty
  // durable-state verdict above). Accept only their exact convention-probe
  // miss; a missing production binding says "cannot resolve" and still fails.
  const absentStructuralStub = /^unresolvable destination scope:(?:cluster|room):[^/]+$/.test(message);
  return emptyDurableObject || absentStructuralStub;
}

/** The per-turn CO10 structure attached to a TurnResult and emitted as the
 * `net_turn_structure` metric so the deployed profile emits the evidence
 * CO10 is measured against. */
type TurnStructureReport = {
  scope: string;
  attempt: number;
  envelope_bytes: number;
  sync_rpc: number;
  scope_row_writes: number;
  reconstructions: number;
  plan_cells: number;
  snapshot_cells: number;
  /** NC8a: total awaited RPC time on the turn's critical path (a
   * parallel group contributes its longest member). */
  rpc_ms: number;
  /** NC8a: the single slowest RPC step. */
  rpc_max_ms: number;
  /** NC8a: serial RPC steps (parallel groups count once) — how deep the
   * turn's cross-authority chain ran; depth < sync_rpc measures paid
   * parallelism. */
  rpc_depth: number;
  /** Finding 11: per-scope queue wait before the turn ran. */
  queue_ms: number;
  /** NC8a: whole-turn wall time at the gateway. */
  wall_ms: number;
};

/** Retryable verdict → the CO6 taxonomy code its round is recorded as.
 * `post_state_mismatch` has no code of its own; its defined recovery is
 * the E_READ_VERSION one (re-plan against refreshed cells). */
const VERDICT_CODE: Partial<Record<RejectReason, NetErrorCode>> = {
  stale_head: "E_STALE_HEAD",
  stale_epoch: "E_STALE_EPOCH",
  read_version_mismatch: "E_READ_VERSION",
  post_state_mismatch: "E_READ_VERSION",
  catalog_mutation: "E_CATALOG_MUTATION"
};

/** Capacity and transport refusals are retryable by the caller with the
 * same idempotency key; protocol/input failures remain request errors. */
function netErrorHttpStatus(error: NetError): number {
  return error.code === "E_BUDGET" || error.code === "E_RPC_TIMEOUT" ? 503 : 400;
}

/** Runtime object ids are opaque except for `:`, which the net protocol
 * reserves as its compound cell-key delimiter. Catalog aliases containing
 * that character must have resolved during installation, never at this
 * transport boundary. */
function isConcreteRuntimeObjectId(id: string): boolean {
  return id.length > 0 && !id.includes(":");
}

const OBJECT_ARGUMENT_NAMES = new Set([
  "actor", "actor?", "actor_obj", "child", "exit", "item", "location",
  "new_parent_id", "obj", "object", "objects", "origin?", "parent",
  "parent_id?", "pin", "recipient", "source", "source_ref", "target",
  "target_space", "thing"
]);

/** `<kind>:<object>[:<name>]` → object (object ids never contain ':'). */
function objectOfCellKey(key: string): string {
  return key.split(":")[1] ?? "";
}

/** Session TTL bounds for the /net-api client surface: default 30 min,
 * clamped to [1 min, 24 h] — a client cannot mint an immortal session. */
function clampClientTtl(raw: unknown): number {
  return clampClientSessionTtl(raw);
}

type GuestClaim = { id: string; issuedAt: number };

/** Parse the public guest idempotency bearer. Its timestamp freezes the mint
 * expiry across retries; UUID randomness makes guessing it equivalent to
 * guessing the resulting session bearer. */
function guestClaim(raw: unknown, now: number, ttlMs: number): GuestClaim | null {
  if (raw === undefined) return null; // additive compatibility for old clients
  if (typeof raw !== "string") throw new ClientAuthError("invalid guest claim", { reason: "guest_claim_invalid" }, "E_PERM", 400);
  const match = /^g1\.([0-9a-z]+)\.([0-9a-z]+)\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(raw);
  const issuedAt = match ? Number.parseInt(match[1], 36) : Number.NaN;
  const claimedTtl = match ? Number.parseInt(match[2], 36) : Number.NaN;
  if (
    !match ||
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(claimedTtl) ||
    claimedTtl !== ttlMs ||
    clampClientTtl(claimedTtl) !== claimedTtl ||
    issuedAt > now + 60_000
  ) {
    throw new ClientAuthError("invalid guest claim", { reason: "guest_claim_invalid" }, "E_PERM", 400);
  }
  if (issuedAt + ttlMs <= now) {
    throw new ClientAuthError("guest claim expired", { reason: "guest_claim_expired" }, "E_PERM", 409);
  }
  return { id: raw, issuedAt };
}

async function guestClaimHex(claim: GuestClaim, purpose: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${purpose}\0${claim.id}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What a gateway WebSocket carries across hibernation (Phase 4 item 3):
 * the validated session id (also the socket's tag) and the apikey-
 * authenticated actor the session is bound to. */
type GatewaySocketAttachment = { session: string; actor: string; opened_at: number };

/** Echo-dedupe LRU bound (see recentClientTurns). */
const RECENT_CLIENT_TURN_CAP = 512;

/** H2c: selection-pin retention (see pinScope) — matches the scopes'
 * reply-cache bound (scope.ts REPLY_CACHE_CAP) so the pin never
 * outlives the reply it protects by more than the window. */
const GATEWAY_PIN_LIMIT = 1024;
/** Bounded per-isolate classification memo for offline room members. Losing an
 * entry costs one cold convention probe; lineage fanout invalidates it. */
const ROOM_PRESENTATION_ACTOR_CACHE_CAP = 256;

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
/** A broken/partitioned catalog authority must not turn anonymous admission
 * traffic into a multi-Hz repair loop. The next request may retry after this
 * bounded brake; success is cached naturally by the repaired view page. */
const GUEST_RESET_REPAIR_BACKOFF_MS = 5_000;

export class NetGatewayDO {
  private readonly host: WorkerdHost;
  private view: CellStore | null = null;
  private readonly seen = new Map<string, number>();
  /** Per-subscriber outbox continuity, distinct from authority `seen`.
   * A scope head may advance without emitting a row for this gateway. */
  private readonly deliverySeen = new Map<string, number>();
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
   * losing an entry (hibernation, cap overflow) sends ONE redundant frame
   * to the submitter, never a missed frame for anyone else. The frame carries
   * echo_id, so NetFeed buffers/drops that self echo even when it beats the
   * turn reply; the LRU remains the bandwidth optimization, not correctness.
   */
  private readonly recentClientTurns = new Map<string, string>();

  /** H1: scopes this gateway has self-subscribed this lifetime (avoids a
   * re-subscribe RPC + re-pull per turn). Per-isolate memory: after
   * eviction it starts empty and the first touch re-subscribes
   * (idempotent server-side) — a dropped entry costs one redundant
   * subscribe/pull, never a lost subscription. */
  private readonly selfSubscribed = new Set<string>();
  private readonly roomPresentationActors = new Map<string, true>();

  /** H4 token buckets, PER-ISOLATE by design (see rate-limit.ts header):
   * `clientRate` covers every authenticated /net-api operation (REST +
   * WS turn frames, one bucket per actor); `mintRate` is the tighter
   * bucket for the amplifier routes (session mint, ws-ticket). */
  private readonly clientRate = new TokenBucketLimiter({ ratePerSec: CLIENT_RATE_PER_SEC, burst: CLIENT_RATE_BURST });
  private readonly mintRate = new TokenBucketLimiter({
    ratePerSec: CLIENT_MINT_RATE_PER_SEC,
    burst: CLIENT_MINT_RATE_BURST
  });
  private guestResetDefinitionRepair: Promise<void> | null = null;
  private guestResetDefinitionRetryAt = 0;

  constructor(
    private readonly state: NetGatewayDurableState,
    private readonly env: NetGatewayEnv
  ) {
    // Wake visibility (2026-07-20 bake finding): stamp construction like
    // the scope DO so shard restarts are correlatable with latency
    // episodes in AE (net DOs previously emitted no wake signal at all).
    const constructedAt = Date.now();
    // CREATE IF NOT EXISTS on every construction — same idiom as
    // SqliteScopeStore: cheap, idempotent, no separate first-boot path.
    // Phase 5 durable-format stamp (mirrors net_scope_meta's row): the
    // gateway's one branch point for durable evolution + migration ledger.
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS net_gateway_meta (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
    state.storage.sql.exec(
      "INSERT OR IGNORE INTO net_gateway_meta (id, body) VALUES ('schema_version', ?)",
      JSON.stringify({ v: 1 })
    );
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS net_gateway_cell (key TEXT PRIMARY KEY, body TEXT NOT NULL)");
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS net_gateway_scope (scope TEXT PRIMARY KEY, seen_seq INTEGER NOT NULL, delivery_seen_seq INTEGER NOT NULL DEFAULT 0)");
    const scopeColumns = sqlRows<{ name: string }>(state.storage.sql.exec("PRAGMA table_info(net_gateway_scope)"));
    if (!scopeColumns.some((column) => column.name === "delivery_seen_seq")) {
      state.storage.sql.exec("ALTER TABLE net_gateway_scope ADD COLUMN delivery_seen_seq INTEGER NOT NULL DEFAULT 0");
    }
    // CO13 relation mirror: roster rows (contents, session_presence)
    // received via FanoutBody.relations — the client-read primitive for
    // who/contents (GET /net/relation). SQLite-only (no memory cache):
    // reads are per-request queries and writes are gated by the same
    // per-scope seen high-water as cells, so there is no hydrated state
    // to keep coherent. Columns denormalize the row for the
    // (relation, owner) query; `body` is the row's JSON body or NULL.
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS net_gateway_relation (key TEXT PRIMARY KEY, relation TEXT NOT NULL, owner TEXT NOT NULL, member TEXT NOT NULL, body TEXT, owner_scope TEXT)"
    );
    // Phase 2: `owner_scope` is the scope the owner belongs to, MATERIALIZED
    // at write time — a fanout carries a SCOPE name (`room:ws_annex`) but the
    // relation owner is an OBJECT id (`ws_annex`), so the presence fanout
    // filters on `owner_scope` to stay O(occupants), never scanning every
    // session_presence row and classifying each in JS. Additive-column
    // migration for a table created before it (before-data everywhere today;
    // idempotent). A legacy row's NULL owner_scope simply misses the indexed
    // filter until the next fanout/pull rewrites it — the same self-heal a
    // stale mirror row already has.
    const relationColumns = sqlRows<{ name: string }>(state.storage.sql.exec("PRAGMA table_info(net_gateway_relation)"));
    if (!relationColumns.some((column) => column.name === "owner_scope")) {
      state.storage.sql.exec("ALTER TABLE net_gateway_relation ADD COLUMN owner_scope TEXT");
    }
    if (!relationColumns.some((column) => column.name === "member_scope")) {
      // Additive mirror metadata: new relation producers attach the member's
      // immutable authority scope so cold contextual reads stay targeted.
      // Legacy NULL rows remain valid and use the bounded owner fallback.
      state.storage.sql.exec("ALTER TABLE net_gateway_relation ADD COLUMN member_scope TEXT");
    }
    state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS net_gateway_relation_scope ON net_gateway_relation (relation, owner_scope)"
    );
    // The authenticated read/auth query shapes (all O(matching rows), never
    // a table scan): presence-of-a-member (relation, member); the contents
    // membership check and the roster read (relation, owner, member — the
    // second also serves the owner-only ORDER BY member read as a prefix).
    state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS net_gateway_relation_member ON net_gateway_relation (relation, member)"
    );
    state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS net_gateway_relation_owner_member ON net_gateway_relation (relation, owner, member)"
    );
    // Selection pinning (fix 5c): idempotency_key → the scope the FIRST
    // submit for that key targeted. A re-plan (same key, refreshed view)
    // must never migrate the commit to a different scope — the pinned
    // scope may already hold the recorded reply, and a second scope would
    // double-commit the turn. Bounded (H2c): pinScope prunes to the most
    // recent GATEWAY_PIN_LIMIT rows — the same retention posture as the
    // scopes' reply cache, and the same documented consequence (see
    // pinScope).
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
      alarmStorage: state.storage,
      metric: (event) => this.metric(event)
    });
    this.metric({ kind: "do_constructor", class: "NetGatewayDO", ms: Date.now() - constructedAt });
  }

  /** Stable per-shard AE index. Named DO ids expose their name in workerd
   * and Cloudflare; the fallback remains bounded for structural fixtures. */
  private metric(event: AnalyticsMetric): void {
    emitMetric(event, `net-gateway:${this.shardName() ?? "unnamed"}`, this.env.METRICS);
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
        // `member_scope` only tells this gateway where to warm a contextual
        // object. It is not part of CO13's relation-read contract, even on
        // the signed lane probe.
        const members = this.relationMembers(relation, owner).map((row) => ({
          member: row.member,
          ...(row.body !== undefined ? { body: row.body } : {})
        }));
        return json({ relation, owner, members });
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
          netErrorHttpStatus(err)
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
              this.removeAbsentCatalogDefinitions(view, body.scope, seed.cells);
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
        this.metric({
          kind: "net_seed_lag",
          code: "E_SEED_LAG",
          scope: body.scope,
          seed_head: seed.head,
          live_head: live.head
        });
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
  /** NC8 hot-scope bounded lanes. Planning takes a synchronous detached
   * snapshot and the scope validates current authority reads, so
   * independent turns can overlap safely while true conflicts repair
   * through CO4. Four lanes avoid serializing unrelated 200ms turns into
   * a 1.5s queue while bounding conflict amplification. */
  private readonly turnQueues = new Map<string, Array<Promise<unknown> | undefined>>();
  private readonly turnQueueLaneDepth = new Map<string, number[]>();
  /** Finding 11: per-scope queue depth — admission control. Unbounded
   * promise chains under a hot scope are memory growth AND unbounded
   * client latency; past the cap the honest answer is a named refusal
   * the client backs off on. */
  private readonly turnQueueDepth = new Map<string, number>();
  private static readonly MAX_TURN_QUEUE_DEPTH = 32;
  /** V3 finding 8: the per-scope cap does not bound AGGREGATE queued
   * work across many scopes (a fan of stuck scopes each just under the
   * per-scope cap is still unbounded memory + latency when RPCs never
   * settle). This bounds the isolate's total in-flight queued turns. */
  private turnQueueTotal = 0;
  private static readonly MAX_TURN_QUEUE_TOTAL = 256;
  private turnQueueWaitMs(): number {
    const configured = Number(this.env.NET_TURN_QUEUE_WAIT_MS);
    if (!Number.isFinite(configured) || configured <= 0) return 1_500;
    return Math.min(30_000, Math.max(10, Math.floor(configured)));
  }

  private turnScopeConcurrency(): number {
    const configured = Number(this.env.NET_TURN_SCOPE_CONCURRENCY);
    if (!Number.isFinite(configured) || configured <= 0) return 12;
    return Math.min(16, Math.max(1, Math.floor(configured)));
  }

  private turn(request: TurnRequest): Promise<TurnResult> {
    const key = request.planningScope;
    const depth = this.turnQueueDepth.get(key) ?? 0;
    if (depth >= NetGatewayDO.MAX_TURN_QUEUE_DEPTH) {
      throw netError("E_BUDGET", "turn queue depth exceeded for this scope; back off and retry", {
        scope: key,
        queue_depth: depth,
        limit: NetGatewayDO.MAX_TURN_QUEUE_DEPTH
      });
    }
    if (this.turnQueueTotal >= NetGatewayDO.MAX_TURN_QUEUE_TOTAL) {
      throw netError("E_BUDGET", "gateway turn queue saturated across scopes; back off and retry", {
        aggregate_queue: this.turnQueueTotal,
        limit: NetGatewayDO.MAX_TURN_QUEUE_TOTAL
      });
    }
    this.turnQueueTotal += 1;
    this.turnQueueDepth.set(key, depth + 1);
    const queuedAt = Date.now();
    const concurrency = this.turnScopeConcurrency();
    const lanes = this.turnQueues.get(key) ?? new Array<Promise<unknown> | undefined>(concurrency);
    const laneDepths = this.turnQueueLaneDepth.get(key) ?? new Array<number>(concurrency).fill(0);
    let lane = 0;
    for (let i = 1; i < laneDepths.length; i += 1) {
      if (laneDepths[i] < laneDepths[lane]) lane = i;
    }
    laneDepths[lane] += 1;
    this.turnQueues.set(key, lanes);
    this.turnQueueLaneDepth.set(key, laneDepths);
    const tail = lanes[lane] ?? Promise.resolve();
    const maxWaitMs = this.turnQueueWaitMs();
    let started = false;
    let expired = false;
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    const queueTimeout = new Promise<never>((_resolve, reject) => {
      waitTimer = setTimeout(() => {
        if (started) return;
        expired = true;
        const queueMs = Date.now() - queuedAt;
        this.metric({ kind: "net_turn_queue_refused", scope: key, status: "error", error: "E_BUDGET", queue_ms: queueMs, limit_ms: maxWaitMs });
        reject(netError("E_BUDGET", "turn queue wait exceeded; retry with the same idempotency key", {
          scope: key,
          queue_ms: queueMs,
          limit_ms: maxWaitMs,
          reason: "queue_wait"
        }));
      }, maxWaitMs);
    });
    const execute = async (): Promise<TurnResult> => {
      if (expired) throw netError("E_BUDGET", "expired turn skipped before execution", { scope: key, reason: "queue_wait" });
      started = true;
      if (waitTimer !== undefined) clearTimeout(waitTimer);
      return this.turnUnqueued(request, Date.now() - queuedAt);
    };
    const execution = tail.then(
      execute,
      execute // a predecessor's failure never gates a successor
    );
    const run = Promise.race([execution, queueTimeout]);
    const release = () => {
      if (waitTimer !== undefined) clearTimeout(waitTimer);
      this.turnQueueTotal = Math.max(0, this.turnQueueTotal - 1);
      const remaining = (this.turnQueueDepth.get(key) ?? 1) - 1;
      if (remaining <= 0) this.turnQueueDepth.delete(key);
      else this.turnQueueDepth.set(key, remaining);
      const depths = this.turnQueueLaneDepth.get(key);
      if (depths) {
        depths[lane] = Math.max(0, depths[lane] - 1);
        if (depths.every((value) => value === 0)) this.turnQueueLaneDepth.delete(key);
      }
    };
    // Keep expired entries counted until their predecessor settles and
    // their no-op executes. Otherwise a wedged predecessor could admit an
    // unbounded series of timed-out closures behind the aggregate cap.
    void execution.then(release, release);
    // Park the settled marker (not the result) so a rejection is not
    // re-observed as unhandled from the queue's copy.
    const settled = execution.then(
      () => undefined,
      () => undefined
    );
    lanes[lane] = settled;
    void settled.finally(() => {
      if (lanes[lane] === settled) lanes[lane] = undefined;
      if (lanes.every((entry) => entry === undefined) && this.turnQueues.get(key) === lanes) {
        this.turnQueues.delete(key);
      }
    });
    return run;
  }

  private async turnUnqueued(request: TurnRequest, queueMs = 0): Promise<TurnResult> {
    const trace: AttemptTraceEntry[] = [];
    const structure = new TurnStructure();
    structure.queue_ms = queueMs;
    try {
      const result = await this.turnAttempts(request, trace, structure);
      // D2 / CO10: attach the structural budget to the result (so a unit
      // lane can assert it) and emit it as a metric (so staging emits the
      // evidence CO10 is measured against).
      const report = this.turnStructureReport(result, structure);
      this.emitTurnStructure(request, report, result.reply.status);
      return { ...result, structure: report };
    } catch (err) {
      // D2: a failed turn still emits its repair-path structure (no reply,
      // so scope-row writes are 0 and the scope is the planning scope) —
      // the sync-RPC and reconstruction counts of the exhausted budget are
      // exactly the evidence a CO10 investigation wants.
      this.emitTurnStructure(request, {
        scope: request.planningScope,
        attempt: trace.length + 1,
        envelope_bytes: 0,
        sync_rpc: structure.sync_rpc,
        scope_row_writes: 0,
        reconstructions: structure.reconstructions,
        plan_cells: structure.plan_cells,
        snapshot_cells: structure.snapshot_cells,
        rpc_ms: structure.rpc_ms,
        rpc_max_ms: structure.rpc_max_ms,
        rpc_depth: structure.rpc_depth,
        queue_ms: structure.queue_ms,
        wall_ms: Date.now() - structure.started
      }, "error", isNetError(err) ? err.code : "E_INTERNAL");
      // A budget gate can fire inside TurnStructure before turnAttempts reaches
      // its budgetExhausted() footer. Preserve the rounds already observed so
      // every turn-level E_BUDGET still satisfies CO6's trace contract.
      if (isNetError(err) && err.code === "E_BUDGET" && !err.attempts && trace.length > 0) {
        throw new NetError(
          "E_BUDGET",
          err.message.replace(/^E_BUDGET:\s*/, ""),
          err.detail,
          trace
        );
      }
      // Fix 5d: a plain-Error escape (misplan bug, double transport failure)
      // after failed rounds carries the same convergence context.
      if (!isNetError(err) && err instanceof Error && trace.length > 0) {
        (err as Error & { attempts?: AttemptTraceEntry[] }).attempts = trace;
      }
      throw err;
    }
  }

  /** D2: fold the counters + the settled reply into the CO10 report.
   * scope-row writes are the accepted commit's touched rows (0 on a
   * terminal reject, which committed nothing). */
  private turnStructureReport(result: TurnResult, structure: TurnStructure): TurnStructureReport {
    return {
      scope: result.reply.scope,
      attempt: result.attempt,
      envelope_bytes: result.envelopeBytes,
      sync_rpc: structure.sync_rpc,
      // Only an accepted reply wrote rows; a terminal reject committed
      // nothing (the rejected CommitReply variant has no `touched`).
      scope_row_writes: result.reply.status === "accepted" ? result.reply.touched.length : 0,
      reconstructions: structure.reconstructions,
      plan_cells: structure.plan_cells,
      snapshot_cells: structure.snapshot_cells,
      rpc_ms: structure.rpc_ms,
      rpc_max_ms: structure.rpc_max_ms,
      rpc_depth: structure.rpc_depth,
      queue_ms: structure.queue_ms,
      wall_ms: Date.now() - structure.started
    };
  }

  private emitTurnStructure(
    request: TurnRequest,
    report: TurnStructureReport,
    status: "accepted" | "rejected" | "error",
    error?: string
  ): void {
    // AU8 ops correlation: stamp the acting customer and the W3C trace
    // id onto the turn metric (blobs 19/20). AE stays SAMPLED — these
    // stamps are telemetry correlation, never the audit trail (AU6).
    const traceId = request.trace ? parseTraceparent(request.trace.traceparent)?.traceId : undefined;
    this.metric({
      kind: "net_turn_structure",
      idempotency_key: request.idempotency_key,
      status,
      ...(error ? { error } : {}),
      ...(request.principal?.customer ? { customer: request.principal.customer } : {}),
      ...(request.principal?.actor ? { actor: request.principal.actor } : {}),
      ...(traceId ? { trace_id: traceId } : {}),
      ...report
    });
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
   * The catalog scope's lineage keys held by the given store (CO15): the
   * shared substrate is universally receiver-known in transfers, so the
   * planner's read closure never reships class chains. An unclassifiable
   * lineage cell (mid-walk gap during a partial refresh) simply ships —
   * the known-set is an envelope optimization and must never fail a plan.
   * Under the legacy override classifier no scope is ever "catalog", so
   * the set is empty and legacy envelopes are unchanged.
   *
   * Called by the planner with the settled PLAN SLICE (blocker #1: the
   * closure can only reference slice lineage keys, so classifying just
   * those is equivalent to — and O(view) cheaper than — scanning the
   * whole resident view per turn).
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

  private async turnAttempts(request: TurnRequest, trace: AttemptTraceEntry[], structure: TurnStructure): Promise<TurnResult> {
    const startedAt = this.host.now();
    const deadline = startedAt + REPAIR_BUDGET_MS;
    // stale_head resubmit carry-over: when only the base was stale the
    // planned transcript is still valid — the next round submits it
    // against the fresh head instead of paying a re-plan.
    let resubmit: { planned: PlanTurnResult; base: ScopeHead } | null = null;
    // Objects this turn's recovery rounds have pulled (read-version
    // mismatch refresh or E_MISSING_STATE closure). They ride into every
    // subsequent plan's seed slice so a re-plan does not drop the repair
    // and re-default the same read — the fix for the two-level-retry
    // oscillation that grinds a sibling-property mismatch to E_BUDGET.
    const repairedObjects = new Set<string>();
    // By-construction non-convergence detector: per turn, the authority
    // version we last REFRESHED each mismatched key to. If a key mismatches
    // again AFTER a refresh to the SAME authority version, refreshing cannot
    // help — the plan records that read at a version the authority will
    // never hold (a planner/catalog bug). We surface E_NONCONVERGENT_READ
    // naming the key instead of grinding to an opaque E_BUDGET. Genuine
    // contention moves the authority version every round, so a contended key
    // never satisfies the "same version twice" condition and keeps repairing.
    const refreshedTo = new Map<string, string>();
    // Same detector for compact ordering reads. The key is
    // (authority scope, container, parent), because two container roots in one
    // cross-scope turn both use null.
    const refreshedOrderingTo = new Map<string, string>();
    // Owner-computed ordered-children projections fetched this turn, keyed by
    // (container,parent); null names only that container's roots. Seeded with the call target's
    // ordering, then GROWN by the ordered-children repair path as the verb
    // reads further parents (a nested add_item's parent_arg, a reparent's old
    // + new parent). The map only grows and is threaded into every re-plan, so
    // a fetched projection is STICKY: the same parent never re-misses, and a
    // turn reading several parents converges one repair round per new parent.
    const orderedChildrenByParent = new Map<string, OrderedChildrenProjection>();
    // Bounded neighbour answers fetched this turn (P2.4), keyed by the
    // canonical query key. Same lifecycle as the map above: grown by the
    // ordered-neighbours repair path, threaded into every re-plan (sticky),
    // and purged per-parent on an ordering conflict so the next attempt
    // re-fetches the CURRENT slot answer.
    const orderedNeighborsByKey = new Map<string, OrderedNeighborsProjection>();
    // A cold contents relation can name offline actors whose owner cells are
    // intentionally absent from this gateway. The first presentation probe
    // classifies those cluster roots from the generic host-placement marker;
    // retain that bounded answer across repair rounds so one look never
    // re-probes the same offline seats.
    const roomPresentationActors = new Set(this.roomPresentationActors.keys());

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
      const planningRoomRoster = await this.roomRosterProjection(request, view, classifier, structure, roomPresentationActors);
      // Seed the call target's ordering once (the generic "children of the
      // target" projection); repair rounds add any further parents the verb
      // reads. Idempotent: skipped once the target is already in the map.
      await this.seedTargetOrderedChildren(request, view, classifier, structure, orderedChildrenByParent, trace);
      const planningOrderedChildren = orderedChildrenByParent.size > 0
        ? [...orderedChildrenByParent.values()].map((projection) => ({ container: projection.container, parent: projection.parent, scope: projection.scope, rows: projection.rows, version: projection.version }))
        : undefined;
      const planningOrderedNeighbors = orderedNeighborsByKey.size > 0
        ? [...orderedNeighborsByKey.values()]
        : undefined;

      // ---- Plan (or adopt the stale_head resubmit).
      let planned: PlanTurnResult;
      let base: ScopeHead | null = null;
      // Planning-scope head prefetch (client-shell phase i): fetched
      // BEFORE planning so the authority's allocation counter reaches
      // the planner — a create must mint an id fresh at the authority.
      // Reused as the submit base when the commit scope IS the planning
      // scope (the warm common case), keeping the warm turn at the same
      // sync-RPC count as before; a cross-scope selection re-fetches
      // from its own destination below.
      let planningHead: Awaited<ReturnType<typeof this.scopeHead>> | null = null;
      if (resubmit) {
        planned = resubmit.planned;
        base = resubmit.base;
        resubmit = null;
      } else {
        try {
          planningHead = await structure.rpc(() => this.scopeHead(this.destinationFor(request, request.planningScope)), { phase: "planning_head" });
          this.assertTurnEpoch(planningHead, request.catalog_epoch, request.planningScope, trace);
          planned = await this.planOnce(request, view, classifier, planningHead.object_counter, planningRoomRoster, repairedObjects, planningOrderedChildren, planningOrderedNeighbors);
        } catch (err) {
          if (isNetError(err) && err.code === "E_MISSING_STATE") {
            // Ordered-children projection miss: fetch the named parent(s)'
            // owner projection and re-plan (the ordering analogue of a
            // targeted cell refresh). Handled BEFORE the cell path — its
            // detail carries `missing_ordered_children`, not `missing`.
            const missingOrdered = Array.isArray(err.detail.missing_ordered_children)
              ? (err.detail.missing_ordered_children as OrderedProjectionKey[]).filter(validOrderedProjectionKey)
              : [];
            if (missingOrdered.length > 0) {
              trace.push({ attempt, code: "E_MISSING_STATE", missing: missingOrdered.map((o) => `${o.container}:${o.parent ?? "<root>"}`), elapsed_ms: elapsed() });
              // Anti-loop (R2-corrected): only "EVERY named parent is already
              // resident yet the re-plan still missed it" is the terminal
              // planner/catalog-bug shape (installing again cannot cure a
              // re-miss) — surfaced as E_NONCONVERGENT_READ rather than
              // grinding to E_BUDGET. A FAILED fetch is transient transport
              // state, not non-convergence: it stays on the bounded attempt
              // loop (recovery_error in the trace; retried next round;
              // E_BUDGET explains a persistent outage).
              let allAlreadyResident = true;
              for (const ordering of missingOrdered) {
                const key = orderedProjectionKey(ordering.container, ordering.parent);
                if (orderedChildrenByParent.has(key)) continue;
                allAlreadyResident = false;
                const projection = await this.tryRecovery(trace, () => this.fetchOrderedChildren(request, classifier, structure, ordering));
                if (projection === undefined) continue; // fetch failed; recovery_error recorded
                orderedChildrenByParent.set(key, projection);
              }
              if (allAlreadyResident) {
                throw nonconvergentRead(
                  "ordered-children projection re-missed while resident (install cannot cure it)",
                  trace,
                  { missing_ordered_children: missingOrdered }
                );
              }
              continue;
            }
            // Ordered-neighbours miss (P2.4): answer the named bounded
            // query with ONE O(1) authority fetch and re-plan. Handled
            // before the cell path for the same reason as above — its
            // detail carries `missing_ordered_neighbors`, not `missing`.
            const missingNeighbors = Array.isArray(err.detail.missing_ordered_neighbors)
              ? (err.detail.missing_ordered_neighbors as OrderedNeighborsRequest[]).filter(validOrderedNeighborsRequest)
              : [];
            if (missingNeighbors.length > 0) {
              trace.push({ attempt, code: "E_MISSING_STATE", missing: missingNeighbors.map((r) => `neighbors:${r.container}:${r.query.parent ?? "<root>"}`), elapsed_ms: elapsed() });
              // Anti-loop (R2-corrected, mirror of the children branch): only
              // an already-resident re-miss is terminal non-convergence; a
              // failed fetch stays on the bounded attempt loop.
              let allAlreadyResident = true;
              for (const requestForNeighbors of missingNeighbors) {
                const key = orderedNeighborsQueryKey(requestForNeighbors.container, requestForNeighbors.query);
                if (orderedNeighborsByKey.has(key)) continue;
                allAlreadyResident = false;
                const projection = await this.tryRecovery(trace, () => this.fetchOrderedNeighbors(request, classifier, structure, requestForNeighbors));
                if (projection === undefined) continue; // fetch failed; recovery_error recorded
                orderedNeighborsByKey.set(key, projection);
              }
              if (allAlreadyResident) {
                throw nonconvergentRead(
                  "ordered-neighbours answer re-missed while resident (install cannot cure it)",
                  trace,
                  { missing_ordered_neighbors: missingNeighbors }
                );
              }
              continue;
            }
            const missing = Array.isArray(err.detail.missing) ? (err.detail.missing as string[]) : [];
            trace.push({ attempt, code: "E_MISSING_STATE", missing, elapsed_ms: elapsed() });
            await this.tryRecovery(trace, () => this.refreshCells(request, classifier, view, missing, structure));
            for (const key of missing) repairedObjects.add(objectOfCellKey(key));
            continue;
          }
          // Terminal NetError codes and plain Errors (misplan bugs,
          // transport failures on the submit path) surface as-is.
          throw err;
        }
      }
      // Phase 0: record the planner input size of THIS round's plan (the
      // resubmit branch reuses the prior plan's, already the settling one).
      structure.plan_cells = planned.planCells;
      structure.snapshot_cells = planned.snapshotCells;
      this.assertNoCatalogClassMutation(planned, view, classifier);

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
        this.metric({
          kind: "net_turn_selection_pin_override",
          idempotency_key: request.idempotency_key,
          planned: planned.selection.scope,
          pinned
        });
      }
      const destination = this.destinationFor(request, targetScope);
      if (base === null && planningHead !== null && targetScope === request.planningScope) {
        // Same-scope commit: the prefetched planning head IS the base —
        // no second head fetch (the warm-turn RPC budget).
        base = planningHead.head;
      }
      if (base === null) {
        // Phase 5: the head reply names the scope's durable epoch —
        // consume it. A turn stamped with another epoch can NEVER commit
        // (re-planning re-stamps the same epoch), so fail fast here
        // instead of grinding plan → submit → reseed to E_BUDGET.
        const live = await structure.rpc(() => this.scopeHead(destination), { phase: "selected_head" });
        this.assertTurnEpoch(live, request.catalog_epoch, targetScope, trace);
        base = live.head;
      }
      // CO2.3 rider integrity (rule 1): attest every FOREIGN read — a
      // read whose object anchors to a scope other than the committing
      // one — from its owner before submitting. Fetched fresh on EVERY
      // round (including stale_head resubmits), so a read_version_
      // mismatch repair — which refreshes the mismatched cells from
      // their owners (refreshCells routes by the classifier) and
      // re-plans — automatically re-attests the affected owners too.
      const attestations = await this.attestForeignReads(request, classifier, planned, view, targetScope, structure);
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
      const relateDestinations = this.relateDestinationsFor(request, classifier, planned, targetScope);
      const submitBody = {
        submit,
        rider_destinations: this.riderDestinationsFor(request, classifier, planned),
        relate_destinations: relateDestinations
      };
      let reply: CommitReply;
      try {
        reply = (await structure.rpc(() => this.host.rpc(destination, "/submit", submitBody), { phase: "submit" })) as CommitReply;
      } catch (err) {
        // NC8b: never re-submit after a BUDGET refusal — the first submit
        // was never issued, so there is nothing to disambiguate.
        if (isNetError(err) && err.code === "E_BUDGET") throw err;
        // CO2.5 recovery (fix 5b): the transport died in the reply
        // window (kill_after_commit shape) — the scope may or may not
        // have durably committed. ONE resubmit with the SAME idempotency
        // key disambiguates: a committed turn returns its recorded
        // reply; an uncommitted one validates fresh. Only a second
        // transport failure surfaces (with the trace via fix 5d).
        // MANDATORY: disambiguation must run even at the budget's edge.
        reply = (await structure.rpc(() => this.host.rpc(destination, "/submit", submitBody), { mandatory: true, phase: "submit_disambiguate" })) as CommitReply;
      }
      if (reply.status === "accepted") {
        // Make an accepted presence transition visible at its room authority
        // before the client can issue a dependent roster read. This delivers
        // the same idempotent fact as the committing scope's durable outbox;
        // the outbox remains crash recovery and later no-ops at the owner.
        let relationExpediteDegraded = false;
        try {
          await this.expediteForeignRelations(
            reply,
            relateDestinations,
            planned.transcript.observations,
            request.idempotency_key,
            structure
          );
        } catch (err) {
          // Acceptance is the durability boundary. The scope committed the
          // same relation fact to its outbox, so expedite failure may delay a
          // dependent roster read but must never rewrite success into a 500.
          relationExpediteDegraded = true;
          this.metric({ kind: "net_relation_expedite_degraded", scope: reply.scope, status: "error", error: String(err) });
        }
        let installDegraded = false;
        if (reply.touched.length > 0) {
          try {
            await this.installTouched(view, destination, reply.touched, structure);
          } catch (err) {
            // Fix 5a: the COMMIT is durable at the scope; a failed warm
            // cache-fill must never turn an accepted turn into a 500.
            // The stale view self-repairs next turn (read_version_
            // mismatch → targeted refresh). Named + counted.
            installDegraded = true;
            this.metric({
              kind: "net_turn_install_degraded",
              scope: reply.scope,
              status: "error",
              touched: reply.touched.length,
              error: String(err)
            });
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
          ...(installDegraded ? { install_degraded: true } : {}),
          ...(relationExpediteDegraded ? { relation_expedite_degraded: true } : {})
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
          const live = await this.tryRecovery(trace, () => structure.rpc(() => this.scopeHead(destination), { phase: "stale_head_refresh" }));
          // Phase 5: epoch check OUTSIDE tryRecovery (the M9 pattern) —
          // a genuine epoch disagreement is terminal and must escape the
          // retry loop, while a FAILED head fetch stays on the budget
          // path (recovery_error names it; a later round may converge).
          if (live !== undefined) this.assertTurnEpoch(live, request.catalog_epoch, targetScope, trace);
          const fresh = live?.head;
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
          // P1.1: an ordered-children ordering conflict — a concurrent
          // same-parent insert moved the ordering the plan attested. Drop the
          // named parents' cached projections so the next attempt re-fetches
          // the CURRENT ordering (and recomputes a distinct rank), then re-plan.
          const orderingConflicts = Array.isArray((reply.detail as { ordering_conflicts?: unknown } | undefined)?.ordering_conflicts)
            ? ((reply.detail as { ordering_conflicts: OrderingConflict[] }).ordering_conflicts).filter(validOrderingConflict)
            : [];
          if (orderingConflicts.length > 0) {
            const stuck: Array<{ scope: string; container: string; parent: string | null; authority_version: string }> = [];
            for (const ordering of orderingConflicts) {
              const orderingKey = `${ordering.scope}\0${orderedProjectionKey(ordering.container, ordering.parent)}`;
              const children = [...orderedChildrenByParent.values()].find((cached) =>
                cached.scope === ordering.scope && cached.container === ordering.container && cached.parent === ordering.parent
              );
              const neighbor = [...orderedNeighborsByKey.values()].find((cached) =>
                cached.scope === ordering.scope && cached.container === ordering.container && cached.query.parent === ordering.parent
              );
              const authorityVersion = children?.version ?? neighbor?.version;
              if (authorityVersion !== undefined) {
                if (refreshedOrderingTo.get(orderingKey) === authorityVersion) {
                  stuck.push({ ...ordering, authority_version: authorityVersion });
                } else {
                  refreshedOrderingTo.set(orderingKey, authorityVersion);
                }
              }
              for (const [key, cached] of orderedChildrenByParent) {
                if (cached.scope === ordering.scope && cached.container === ordering.container && cached.parent === ordering.parent) orderedChildrenByParent.delete(key);
              }
              // Neighbour answers derive from the same per-parent ordering:
              // drop every cached query under a conflicted parent too, or a
              // re-plan would re-attest the stale version forever.
              for (const [key, cached] of orderedNeighborsByKey) {
                if (cached.scope === ordering.scope && cached.container === ordering.container && cached.query.parent === ordering.parent) orderedNeighborsByKey.delete(key);
              }
            }
            if (stuck.length > 0) {
              throw nonconvergentRead(
                "an ordering read cannot converge: re-installed a stable authority version but the plan re-recorded a mismatching version",
                trace,
                { stuck, scope: targetScope }
              );
            }
            break; // re-plan next round with the refreshed ordering
          }
          // Refresh exactly the named cells (or, for a post_state
          // disagreement naming nothing, reseed the scope's closure)
          // and re-plan.
          const recovered = await this.tryRecovery(trace, async () => {
            if (mismatchKeys.length > 0) await this.refreshCells(request, classifier, view, mismatchKeys, structure);
            else await this.reseedFromScope(view, destination, undefined, structure);
            return true;
          });
          for (const key of mismatchKeys) repairedObjects.add(objectOfCellKey(key));
          // Non-convergence detector (see refreshedTo above). Only when the
          // refresh SUCCEEDED: a key we ALREADY refreshed to this exact
          // authority version — and that mismatched AGAIN — can never
          // converge, so fail fast and named. A FAILED recovery (e.g. a
          // downed closure lane) leaves the view unchanged, so "same version
          // twice" would misclassify a recovery outage as a planner bug —
          // that must stay on the E_BUDGET path (recovery_error explains it).
          if (recovered) {
            const stuck = mismatchKeys
              .map((key) => {
                const authorityVersion = view.get(key)?.version ?? "absent";
                if (refreshedTo.get(key) === authorityVersion) {
                  const plannedRead = submit.transcript.reads.find((read) => netCellKeyFor(read.cell) === key);
                  return { key, authority_version: authorityVersion, planned_version: String(plannedRead?.version ?? "absent") };
                }
                // First refresh to this authority version (or the version
                // moved — contention): record and keep repairing.
                refreshedTo.set(key, authorityVersion);
                return null;
              })
              .filter((entry): entry is { key: string; authority_version: string; planned_version: string } => entry !== null);
            if (stuck.length > 0) {
              throw nonconvergentRead(
                "a recorded read cannot converge: refreshed to a stable authority version twice but the plan re-recorded a mismatching version",
                trace,
                { stuck, scope: targetScope }
              );
            }
          }
          break;
        }
        case "stale_epoch": {
          const reseeded = await this.tryRecovery(trace, async () => {
            // CO8 named reseed: drop every cell stamped with another
            // epoch (mirrored into SQLite), pull the scope's full
            // closure back, re-plan. The drop mutates memory BEFORE the
            // persist transaction, so the whole block is discard-on-throw
            // (fix 3): a failed persist rehydrates instead of leaving the
            // view missing cells SQLite still holds.
            return await this.discardViewOnThrow(async () => {
              const stale = [...view.keys()].filter(
                (key) => view.get(key)?.stamp.catalog_epoch !== request.catalog_epoch
              );
              view.dropStaleEpoch({ catalog_epoch: request.catalog_epoch });
              this.state.storage.transactionSync(() => {
                for (const key of stale) this.persistCell(view, key);
              });
              return await this.reseedFromScope(view, destination, undefined, structure);
            });
          });
          // M9: the reseed is only a recovery when the STALENESS was the
          // view's. When the scope's DURABLE epoch still disagrees with
          // the turn's stamp after a successful reseed, no amount of
          // re-planning converges (the re-plan re-stamps the same epoch)
          // — the pre-M9 behavior ground the whole repair budget to
          // E_BUDGET. Surface the disagreement terminally instead: it is
          // a catalog-install state, not turn mechanics. (A FAILED reseed
          // stays on the budget path — the trace's recovery_error names
          // it and a later round may still converge.)
          if (reseeded !== undefined && reseeded.catalog_epoch !== request.catalog_epoch) {
            // Carries the attempt trace like E_BUDGET does, so the
            // terminal reply still explains its convergence shape (CO6).
            throw new NetError(
              "E_EPOCH_MISMATCH",
              "turn epoch disagrees with the scope's durable epoch after reseed",
              { scope: targetScope, turn_epoch: request.catalog_epoch, scope_epoch: reseeded.catalog_epoch },
              trace
            );
          }
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
    // Phase 4: the catalog pulls FULL (shared substrate, O(catalog) by
    // design); the sending scope and the actor's cluster pull TARGETED —
    // the turn's target and actor chains plus each scope's roster.
    await this.warmScopes(
      [
        { scope: body.scope, objects: [turn.call.target, turn.call.actor] },
        CATALOG_SCOPE,
        { scope: `cluster:${turn.call.actor}`, objects: [turn.call.actor] }
      ],
      "net_plan_scheduled_pull_miss_failed"
    );
    const key = `sched:${turn.id}:${turn.at_logical_time}`;
    // AU3.2/AU2: the scheduled row carried the scheduling turn's
    // principal and trace (captured at schedule time); thread them into
    // the dispatch so the eventual commit stays attributable and joins
    // the originating trace. Shape-guarded — a malformed carried value
    // degrades to absent, never rejects the dispatch.
    const scheduledPrincipal = normalizePrincipal(turn.principal);
    const scheduledTrace = normalizeTraceContext(turn.trace);
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
      ...(scheduledPrincipal ? { principal: scheduledPrincipal } : {}),
      ...(scheduledTrace ? { trace: scheduledTrace } : {}),
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
    relation_expedite_degraded?: boolean;
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

    const now = request.issued_at_ms ?? this.host.now();
    // Phase 5: the session mint stamps request.catalog_epoch; a cluster
    // scope at another durable epoch would reject every submit, so fail
    // fast at the head fetch (same rule as the turn path).
    const liveHead = await this.scopeHead(destination);
    this.assertTurnEpoch(liveHead, request.catalog_epoch, clusterScope, []);
    let base = liveHead.head;
    const actorLineage = view.get(cellKey("object_lineage", request.actor))?.value as { name?: unknown } | undefined;
    const { submit, value } = mintSessionSubmit({
      session: request.session,
      actor: request.actor,
      ...(typeof actorLineage?.name === "string" ? { actorName: actorLineage.name } : {}),
      ttl_ms: request.ttl_ms,
      now,
      base,
      epoch: request.catalog_epoch,
      clusterScope,
      ...(request.active_scope !== undefined ? { activeScope: request.active_scope } : {}),
      ...(request.exclusive ? { exclusive: true } : {}),
      ...(request.closing ? { closing: request.closing } : {})
    });
    // A placed mint carries a presence transition whose room usually
    // anchors at ANOTHER scope: ship the relate directions so the
    // cluster routes the presence delta to the room's owner (the same
    // sibling shape the turn path sends) instead of misclassifying it
    // local. Room scope == cluster scope needs no directions. A CLOSE's
    // transition retracts from the PRIOR room, so the directions target
    // that room instead.
    const relateDestinations: Record<string, { destination: string; objects: string[] }> = {};
    const presenceRoom = request.closing ? request.closing.priorActiveScope : request.active_scope;
    if (presenceRoom) {
      const roomScope = await this.clientPlanningScope(presenceRoom, request.actor);
      if (roomScope !== clusterScope) {
        relateDestinations[roomScope] = { destination: `scope:${roomScope}`, objects: [presenceRoom] };
      }
    }
    const withSibling = Object.keys(relateDestinations).length > 0;
    let reply: CommitReply;
    for (let attempt = 1; ; attempt += 1) {
      const bare = { ...submit, base };
      reply = await this.idempotentSubmit(
        destination,
        withSibling ? { submit: bare, relate_destinations: relateDestinations } : bare
      );
      if (reply.status === "accepted" || !reply.retryable || reply.reason !== "stale_head" || attempt >= 3) break;
      base = (await this.scopeHead(destination)).head;
    }
    if (reply.status !== "accepted") return { reply, scope: clusterScope, value };
    let relationExpediteDegraded = false;
    try {
      await this.expediteForeignRelations(reply, relateDestinations, []);
    } catch (err) {
      relationExpediteDegraded = true;
      this.metric({ kind: "net_relation_expedite_degraded", scope: reply.scope, status: "error", error: String(err) });
    }
    // Install the accepted session cell into the view (warm cache-fill,
    // CO7) — the same degrade rule as /net/turn (fix 5a): the commit is
    // durable; a failed fill self-repairs on the next turn's read check.
    let installDegraded = false;
    try {
      await this.installTouched(view, destination, reply.touched);
    } catch (err) {
      installDegraded = true;
      this.metric({ kind: "net_session_open_install_degraded", scope: clusterScope, status: "error", error: String(err) });
      this.installAcceptedSessionEcho(request.session, value, reply, request.catalog_epoch);
    }
    return {
      reply,
      scope: clusterScope,
      value,
      ...(installDegraded ? { install_degraded: true } : {}),
      ...(relationExpediteDegraded ? { relation_expedite_degraded: true } : {})
    };
  }

  /** CO2.5 for substrate commits outside the full turn loop (session
   * open/close and elastic guest provisioning): one same-body replay
   * disambiguates any transport failure in the commit reply window. */
  private async idempotentSubmit(destination: string, body: unknown): Promise<CommitReply> {
    try {
      return (await this.host.rpc(destination, "/submit", body)) as CommitReply;
    } catch {
      return (await this.host.rpc(destination, "/submit", body)) as CommitReply;
    }
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
  //     {type:"observations", scope, seq, echo_id?, observations} frames to
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

      // Client-shell phase i: the MCP surface (JSON-RPC over POST, bounded
      // GET/SSE server notifications, plus Streamable HTTP DELETE close). Its
      // auth model differs per method — `initialize` authenticates the
      // mcp-token (an apikey) and mints the net session that then acts
      // as the MCP bearer (mcp-session-id = the net session id, the same
      // trust shape v2's MCP surface uses; sessions expire) — so it
      // branches before the header-credential path below.
      if (url.pathname === "/net-api/mcp"
        && (request.method === "POST" || request.method === "GET" || request.method === "DELETE")) {
        const rejectedOrigin = rejectForeignMcpOrigin(request, url);
        if (rejectedOrigin) return rejectedOrigin;
      }
      if (request.method === "POST" && url.pathname === "/net-api/mcp") {
        return await this.clientMcp(request);
      }
      if (request.method === "GET" && url.pathname === "/net-api/mcp") {
        return this.clientMcpEvents(request);
      }
      if (request.method === "DELETE" && url.pathname === "/net-api/mcp") {
        return await this.clientMcpClose(request);
      }

      // The identity door: these two routes authenticate by their OWN
      // credentials (email/password, guest claim) and mint the session
      // that then acts as the bearer — they branch before the
      // header-credential gate exactly like the MCP initialize.
      if (request.method === "POST" && url.pathname === "/net-api/login") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        return await this.clientLogin(body);
      }
      if (request.method === "POST" && url.pathname === "/net-api/guest") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        return await this.clientGuest(body);
      }

      const credential = parseClientCredential(request.headers, null);
      const identity = await this.catalogIdentity();
      // Two credential classes (client-auth.ts): the apikey resolves its
      // actor from the identity map; a session bearer (minted by login/
      // guest/session) resolves from the session cell — the MCP adapter's
      // trust shape, generalized. The bearer session also becomes the
      // DEFAULT session param downstream, so a door client never has to
      // repeat it in bodies/queries.
      let actor: string;
      let bearerSession: string | null = null;
      if (credential.kind === "session") {
        actor = this.actorForSessionBearer(credential.session);
        bearerSession = credential.session;
      } else {
        actor = verifyApiKeyCredential(identity.map, credential).actor;
      }

      // H4: rate limiting runs AFTER authentication resolves the actor
      // (so buckets key on identity, never on spoofable request bytes)
      // and BEFORE any dispatch — a throttled client costs one map lookup.
      this.enforceClientRate(actor, url.pathname);

      if (request.method === "POST" && url.pathname === "/net-api/ws-ticket") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        if (bearerSession && body.session === undefined) body.session = bearerSession;
        return await this.mintWsTicket(actor, body);
      }
      if (request.method === "DELETE" && url.pathname === "/net-api/session") {
        // Finding 12: logout RELEASES the seat — the session cell is
        // rewritten with an immediate expiry and a presence retraction,
        // so a closed guest's seat frees for the next claim instead of
        // waiting out the TTL. The bearer session closes itself; an
        // apikey caller names the session in the body.
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const target = bearerSession ?? (typeof body.session === "string" ? body.session : null);
        if (!target) {
          return json({ error: { code: "E_INVARG", message: "close requires a session (bearer or body)" } }, 400);
        }
        return await this.clientSessionClose(actor, target, identity.epoch);
      }
      if (request.method === "POST" && url.pathname === "/net-api/session") {
        if (bearerSession) {
          // A session cannot mint further sessions: re-authentication is
          // the door's job (login/guest/apikey). Named, not silent.
          return json(
            { error: { code: "E_PERM", message: "a session bearer cannot mint sessions; authenticate at the door", detail: { reason: "session_bearer_mint" } } },
            403
          );
        }
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        return await this.clientSession(actor, body, identity.epoch);
      }
      if (request.method === "POST" && url.pathname === "/net-api/turn") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        if (bearerSession && body.session === undefined) body.session = bearerSession;
        return await this.clientTurn(actor, body, identity.epoch, {
          ...(credential.kind === "apikey" ? { credential: credential.id } : {}),
          trace: adoptOrMintTraceContext(
            request.headers.get("traceparent"),
            request.headers.get("tracestate")
          )
        });
      }
      if (request.method === "POST" && url.pathname === "/net-api/browser-metrics") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        if (bearerSession && body.session === undefined) body.session = bearerSession;
        return await this.clientBrowserMetrics(actor, body);
      }
      if (request.method === "GET" && url.pathname === "/net-api/catalogs") {
        // The installed-catalog ledger is the bootstrap registry's public
        // read surface (legacy `/api/catalogs` exposes the same records). It
        // is already present after catalogIdentity's authenticated full pull;
        // return only the property value, never its definition/stamp cell.
        this.readSession(url, actor, bearerSession);
        const key = cellKey("property_cell", "$catalog_registry", "installed_catalogs");
        const payload = this.ensureView().get(key)?.value as { value?: unknown } | undefined;
        return json({ catalogs: Array.isArray(payload?.value) ? payload.value : [] });
      }
      if (request.method === "GET" && url.pathname === "/net-api/relation") {
        const relation = url.searchParams.get("relation") ?? "";
        const owner = url.searchParams.get("owner") ?? "";
        if (!relation || !owner) {
          return json({ error: { code: "E_INVARG", message: "relation and owner query params are required" } }, 400);
        }
        // B1: reads require the caller's session (the presence anchor) and
        // are authorized against it — no global reads, no credential cells.
        const session = this.readSession(url, actor, bearerSession);
        this.authorizeRelationRead(actor, session, owner);
        // SECURITY: the client-facing projection strips session bearer ids
        // and session cell values from presence (clientRelationMembers) —
        // a co-present peer's session id IS their credential.
        return json({ relation, owner, members: this.clientRelationMembers(relation, owner) });
      }
      if (request.method === "GET" && url.pathname === "/net-api/cell") {
        const key = url.searchParams.get("key") ?? "";
        if (!key) return json({ error: { code: "E_INVARG", message: "key query param is required" } }, 400);
        const session = this.readSession(url, actor, bearerSession);
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
          netErrorHttpStatus(err)
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
      // pull surfaces rather than degrading to a misleading 401.
      try {
        await this.pull({ scope: CATALOG_SCOPE, destination: `scope:${CATALOG_SCOPE}` });
      } catch (err) {
        // Cutover item D: a FRESH namespace (catalog scope holds no
        // durable state — the pre-install condition every first deploy
        // sits in) must refuse with a NAMED verdict that clients and the
        // install pipeline's verification probes can interpret, never a
        // 500 E_INTERNAL wrapping the scope's miss. Any OTHER pull
        // failure (transport, auth) still surfaces as the internal error
        // it is.
        if (String(err).includes("E_MISSING_STATE")) {
          throw new ClientAuthError(
            "world not installed: the catalog scope holds no state (run the net install pipeline)",
            { reason: "not_installed", scope: CATALOG_SCOPE },
            "E_NOT_INSTALLED",
            503
          );
        }
        throw err;
      }
      cell = this.ensureView().get(key);
    }
    if (!cell) {
      throw new ClientAuthError("no apikey registry in the catalog scope", { reason: "no_registry" });
    }
    const payload = cell.value as { value?: unknown } | null | undefined;
    const map = payload && typeof payload === "object" ? payload.value : undefined;
    await this.assertNamespaceActive(cell.stamp.catalog_epoch);
    return { map, epoch: cell.stamp.catalog_epoch };
  }

  /** Reviewer finding 5: how stale a cached ACTIVE verdict may get
   * before the gateway re-verifies against the catalog authority.
   * Deactivation (the installer's failed-verification compensation, or
   * an operator epoch retirement) therefore reaches EVERY gateway —
   * including the one that served the activation — within this window,
   * not just freshly-constructed shards. Env-overridable so tests can
   * force per-request re-verification. */
  private activationVerifiedAt = 0;

  private activationTtlMs(): number {
    const raw = Number((this.env as { NET_ACTIVATION_TTL_MS?: string }).NET_ACTIVATION_TTL_MS);
    return Number.isFinite(raw) && raw >= 0 ? raw : 30_000;
  }

  /**
   * The activation barrier (spec/operations/net-cutover.md): identity
   * cells alone only prove the CATALOG scope is seeded — a namespace
   * mid-install can hold them while other scopes are absent or a mixed
   * epoch is being untangled. Client traffic is admitted only once the
   * catalog authority publishes the fully-verified install epoch in
   * `property_cell:$system:net_active_epoch` (the /net/activate operator
   * op). Enforced here because catalogIdentity is the one gate every
   * authenticated client request already passes.
   *
   * The verdict is re-verified against the AUTHORITY — a targeted
   * one-key closure — whenever the cell is absent OR the cached verdict
   * is older than the TTL (finding 5: a deactivation must revoke the
   * gateways that cached activation, not just future ones).
   */
  private async assertNamespaceActive(identityEpoch: string): Promise<void> {
    const key = cellKey("property_cell", "$system", "net_active_epoch");
    let cell = this.ensureView().get(key);
    const now = Date.now();
    if (!cell || now - this.activationVerifiedAt > this.activationTtlMs()) {
      try {
        const transfer = (await this.host.rpc(`scope:${CATALOG_SCOPE}`, "/closure", { keys: [key], known: [] })) as CellTransfer;
        const fresh = transfer.cells.find((entry) => entry.key === key);
        this.discardViewOnThrow(() =>
          this.state.storage.transactionSync(() => {
            const view = this.ensureView();
            if (fresh) view.install(fresh);
            else view.delete(key);
            this.persistCell(view, key);
          })
        );
        this.activationVerifiedAt = now;
      } catch {
        // Authority unreachable: the cached verdict keeps serving only
        // within the GRACE window checked below (availability for
        // transient blips, never an indefinite stale grant); with NO
        // cached cell the refusal below names the real condition.
      }
      cell = this.ensureView().get(key);
      // A cell that arrived via a full pull (not this re-verify path)
      // starts its grace clock at first observation — without this, a
      // pull-derived grant would never age.
      if (cell && this.activationVerifiedAt === 0) this.activationVerifiedAt = now;
      // V3 finding 2 (P0): an activation grant whose last SUCCESSFUL
      // re-verification is older than the grace window (3×TTL) FAILS
      // CLOSED — otherwise a deactivation is only "guaranteed within
      // the TTL" while the authority happens to stay reachable, and a
      // partitioned gateway would serve a revoked namespace forever.
      if (cell && this.activationVerifiedAt > 0 && now - this.activationVerifiedAt > this.activationTtlMs() * 3) {
        throw new ClientAuthError(
          "activation unverifiable: the catalog authority has not confirmed the active epoch within the grace window",
          {
            reason: "activation_unverifiable",
            scope: CATALOG_SCOPE,
            last_verified_ms_ago: now - this.activationVerifiedAt
          },
          "E_NOT_INSTALLED",
          503
        );
      }
    }
    const payload = cell?.value as { value?: unknown } | null | undefined;
    const active = payload && typeof payload === "object" ? payload.value : undefined;
    if (typeof active !== "string" || active.length === 0) {
      throw new ClientAuthError(
        "world not active: installation has not published a verified epoch (finish the net install pipeline)",
        { reason: "not_active", scope: CATALOG_SCOPE },
        "E_NOT_INSTALLED",
        503
      );
    }
    if (active !== identityEpoch) {
      // A mixed-epoch namespace (identity cells from one install, an
      // activation from another) is an operator error to surface, never
      // to serve through.
      throw new ClientAuthError(
        "world epoch mismatch: the active epoch disagrees with the catalog identity epoch",
        { reason: "epoch_mismatch", scope: CATALOG_SCOPE, active_epoch: active, identity_epoch: identityEpoch },
        "E_NOT_INSTALLED",
        503
      );
    }
  }

  /** This gateway shard's own name (Phase 6): the DO id's name when the
   * id came from idFromName (workerd exposes it; the fake harness sets
   * it), null when the runtime cannot name itself — the mint then falls
   * back to the hint-less legacy id form. */
  private shardName(): string | null {
    const name = (this.state.id as { name?: unknown } | null | undefined)?.name;
    return typeof name === "string" && name.length > 0 ? name : null;
  }

  /**
   * POST /net-api/login {email, password, ttl_ms?} — the identity door's
   * human half (§8 "humans re-authenticate by password"). Verifies the
   * password against the carried $account cells in the catalog-scope view
   * (the SAME closure the apikey gate reads identity from), resolves the
   * account's primary actor, and mints a session through the standard
   * machinery. Fail-closed v2 parity: unknown email, deactivated account,
   * bad password, and unresolvable actor all share ONE message.
   */
  /** Finding 10: PBKDF2 at 600k iterations is a CPU amplifier — bound the
   * CONCURRENCY globally (per-email buckets alone are evictable by
   * rotating cheap keys), and equalize the unknown-email path with a
   * dummy verification so account existence does not leak through
   * timing. */
  private pbkdf2InFlight = 0;
  private static readonly MAX_PBKDF2_CONCURRENCY = 4;
  /** V3 finding 7: a SUSTAINED derivation budget — a rolling 10s window
   * cap, so an attacker who keeps exactly 4 jobs in flight forever
   * cannot pin the isolate at 100% indefinitely (the concurrency cap
   * alone permits that). Past the window budget, login refuses 429
   * until the window rolls. */
  private pbkdf2WindowStart = 0;
  private pbkdf2WindowCount = 0;
  private static readonly PBKDF2_WINDOW_MS = 10_000;
  private static readonly MAX_PBKDF2_PER_WINDOW = 40;
  /** A structurally valid encoding that matches NO password: the unknown-
   * email/deactivated/hash-less paths verify against it so every login
   * attempt pays the same derivation. */
  private static readonly DUMMY_PASSWORD_HASH = `pbkdf2-sha256:600000:${"0".repeat(32)}:${"0".repeat(64)}`;

  private async clientLogin(body: Record<string, unknown>): Promise<Response> {
    const rawEmail = String(body.email ?? "");
    const password = String(body.password ?? "");
    // V3 finding 7: strict BYTE limits BEFORE the email becomes a
    // limiter key or scan input — an oversized credential is refused
    // without bloating the limiter map or paying any derivation.
    if (
      new TextEncoder().encode(rawEmail).length > MAX_EMAIL_BYTES ||
      new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES
    ) {
      throw new ClientAuthError("invalid email or password", { reason: "credential_too_large" });
    }
    const email = normalizeEmail(rawEmail);
    // Pre-auth rate key: the normalized email rides the tight amplifier
    // bucket; a missing email shares one bucket.
    this.enforceClientRate(`login:${email || "anonymous"}`, "/net-api/session");
    // Global admission: concurrency cap (a snapshot) AND a sustained
    // rolling-window budget — rotating emails can evict per-key limiter
    // entries, but neither the in-flight count nor the window budget can
    // be exceeded isolate-wide.
    const now = this.host.now();
    if (now - this.pbkdf2WindowStart > NetGatewayDO.PBKDF2_WINDOW_MS) {
      this.pbkdf2WindowStart = now;
      this.pbkdf2WindowCount = 0;
    }
    if (
      this.pbkdf2InFlight >= NetGatewayDO.MAX_PBKDF2_CONCURRENCY ||
      this.pbkdf2WindowCount >= NetGatewayDO.MAX_PBKDF2_PER_WINDOW
    ) {
      throw new ClientAuthError(
        "authentication is busy; retry after backoff",
        {
          reason: "rate_limited",
          limit: {
            pbkdf2_concurrency: NetGatewayDO.MAX_PBKDF2_CONCURRENCY,
            pbkdf2_per_window: NetGatewayDO.MAX_PBKDF2_PER_WINDOW,
            window_ms: NetGatewayDO.PBKDF2_WINDOW_MS
          }
        },
        "E_RATE",
        429
      );
    }
    this.pbkdf2WindowCount += 1;
    const identity = await this.catalogIdentity(); // warms catalog view + activation barrier
    if (!email || !password) {
      throw new ClientAuthError("invalid email or password", { reason: "password_rejected" });
    }
    const account = this.accountByEmail(email);
    const deactivated = account?.props.deactivated_at != null;
    // Timing equalization: EVERY attempt derives — a real hash when the
    // account is usable, the dummy otherwise (unknown email, deactivated,
    // hash-less record). Only a real-hash success can verify.
    const usable = account !== null && !deactivated && typeof account.props.password_hash === "string";
    const encoded = usable ? (account.props.password_hash as string) : NetGatewayDO.DUMMY_PASSWORD_HASH;
    this.pbkdf2InFlight += 1;
    let verified: boolean;
    try {
      verified = (await verifyPasswordCredential(password, encoded)) && usable;
    } finally {
      this.pbkdf2InFlight -= 1;
    }
    const actor = typeof account?.props.primary_actor === "string" ? account.props.primary_actor : "";
    if (!account || !verified || !actor) {
      // One message for every failure class (v2 authenticatePassword
      // parity) — but the METRIC names the real cause, because a carried
      // account with a missing primary_actor is an import bug to fix,
      // not a user typo.
      if (account && verified && !actor) {
        this.metric({ kind: "net_login_unbound_account", status: "error", error: "unbound_account", account: account.id });
      }
      throw new ClientAuthError("invalid email or password", { reason: "password_rejected" });
    }
    return await this.clientSession(actor, body, identity.epoch);
  }

  /**
   * POST /net-api/guest {ttl_ms?, claim_id?} — the identity door's
   * anonymous half. New clients send a high-entropy claim_id: edge routing
   * and deterministic identity derivation make response-lost retries replay
   * the exact same authority submit. It is a temporary bearer and expires
   * with the requested session TTL. Omission remains additive compatibility.
   * Claims a free actor from the install-seeded pool
   * (property_cell:$system:guest_pool — catalog DATA, so the gateway
   * never hardcodes world names) with an EXCLUSIVE mint: the cluster
   * sequencer refuses `actor_occupied` when a live session already binds
   * the actor, so concurrent claims serialize and two humans never share
   * one guest. The installed pool is the reuse-first tier; on exhaustion
   * a validated `$system.guest_template` provisions a fresh actor and its
   * first session in one commit at that actor's cluster owner.
   */
  private async clientGuest(body: Record<string, unknown>): Promise<Response> {
    // One shared pre-auth bucket: guest claims are session mints.
    this.enforceClientRate("guest:door", "/net-api/session");
    const ttlMs = clampClientTtl(body.ttl_ms);
    const claim = guestClaim(body.claim_id, this.host.now(), ttlMs);
    const identity = await this.catalogIdentity();
    const poolCell = this.ensureView().get(cellKey("property_cell", "$system", "guest_pool"));
    const payload = poolCell?.value as { value?: unknown } | undefined;
    const pool = Array.isArray(payload?.value) ? payload.value.filter((id): id is string => typeof id === "string") : [];
    const template = this.elasticGuestTemplate();
    if (template === null) {
      return json(
        {
          error: {
            code: "E_RETRY",
            message: "guest entry is unavailable until its reset template is repaired",
            detail: { reason: "guest_template_missing", pool_size: pool.length }
          }
        },
        503
      );
    }
    try {
      await this.ensureGuestResetDefinition(template);
    } catch (err) {
      this.metric({ kind: "net_guest_reset_definition", status: "error", error: String(err) });
      return json(
        {
          error: {
            code: "E_RETRY",
            message: "guest entry is unavailable until its reset definition is repaired",
            detail: { reason: "guest_reset_definition" }
          }
        },
        503
      );
    }
    const candidates: Array<{ actor: string; session?: string }> = [];
    for (const actor of pool) {
      const session = claim
        ? sessionIdWithShardHint(this.shardName(), await guestClaimHex(claim, `session:${actor}`))
        : undefined;
      candidates.push({ actor, ...(session ? { session } : {}) });
    }
    if (claim) {
      // A retry can arrive after an earlier occupied seat has become free. Find
      // the claim's already-accepted deterministic session first, or the same
      // human could claim that newly-free seat while its later pool seat remains
      // live. Accepted session echoes persist in this claim-routed gateway view.
      for (const { actor, session } of candidates) {
        if (!session) continue;
        if (validateSessionCell(this.ensureView().get(sessionCellKey(session)), this.host.now(), actor) !== "ok") continue;
        const response = await this.clientSession(actor, body, identity.epoch, {
          exclusive: true,
          session,
          issuedAt: claim.issuedAt,
          ttlMs
        });
        return await this.normalizePooledGuestEntry(actor, template, response, identity.epoch);
      }
    }
    for (const { actor, session } of candidates) {
      const response = await this.clientSession(actor, body, identity.epoch, {
        exclusive: true,
        ...(session ? { session, issuedAt: claim?.issuedAt, ttlMs } : {})
      });
      if (response.status === 409) continue; // occupied — try the next pool actor
      return await this.normalizePooledGuestEntry(actor, template, response, identity.epoch);
    }
    return await this.clientElasticGuest(identity.epoch, template, claim, ttlMs);
  }

  /**
   * Active net worlds retain bootstrap definition pages across runtime
   * deployments. Guest reset became direct-callable after some worlds were
   * installed, so anonymous admission verifies this security-critical page
   * before allocating a bearer. A recognized stale native is replaced by the
   * same signed, ordered catalog operation exposed to operators, then reread
   * from authority. Missing or unknown pages fail closed.
   */
  private async ensureGuestResetDefinition(template: GuestTemplate): Promise<void> {
    const definition = { verb: template.reset_verb, owner: template.maintenance_principal };
    const key = cellKey("verb_bytecode", template.reset_definer, template.reset_verb);
    if (isCurrentGuestResetVerbPageFor(this.ensureView().get(key)?.value, definition)) return;
    if (this.guestResetDefinitionRepair) return this.guestResetDefinitionRepair;
    const now = this.host.now();
    if (now < this.guestResetDefinitionRetryAt) {
      throw new Error(`guest reset definition repair is backing off until ${this.guestResetDefinitionRetryAt}`);
    }

    const repair = (async () => {
      // Recognition is made against a targeted authority read, not a possibly
      // stale gateway copy. Otherwise an old cache could overwrite an
      // operator's newer/unrecognized definition with no compare-and-swap.
      const beforeTransfer = await this.host.rpc(`scope:${CATALOG_SCOPE}`, "/closure", {
        keys: [key],
        known: []
      }) as CellTransfer;
      const authoritative = beforeTransfer.cells.find((cell) => cell.key === key);
      if (!authoritative || !isRecognizedGuestResetVerbPageFor(authoritative.value, definition)) {
        throw new Error(`refused unrecognized ${key}; expected native ${GUEST_RESET_NATIVE}`);
      }
      if (isCurrentGuestResetVerbPageFor(authoritative.value, definition)) {
        this.discardViewOnThrow(() =>
          this.state.storage.transactionSync(() => {
            const view = this.ensureView();
            view.install(authoritative);
            this.persistCell(view, key);
          })
        );
        this.guestResetDefinitionRetryAt = 0;
        return;
      }

      const existing = authoritative.value;
      const desired = guestResetVerbPageFor(definition, guestResetVerbSlot(existing));
      const result = await this.host.rpc(`scope:${CATALOG_SCOPE}`, "/repair-definitions", {
        cells: [{ kind: "verb_bytecode", object: template.reset_definer, name: template.reset_verb, value: desired }],
        remove: []
      }) as { status?: unknown };
      if (result.status !== "applied" && result.status !== "empty") {
        throw new Error(`guest reset definition repair returned ${JSON.stringify(result)}`);
      }

      // Fanout is asynchronous. Read the accepted page directly from catalog
      // authority before admitting the request, and persist that exact page in
      // the gateway view so subsequent claims pay no repair RPC.
      const transfer = await this.host.rpc(`scope:${CATALOG_SCOPE}`, "/closure", {
        keys: [key],
        known: []
      }) as CellTransfer;
      const fresh = transfer.cells.find((cell) => cell.key === key);
      if (!fresh || !isCurrentGuestResetVerbPageFor(fresh.value, definition)) {
        throw new Error(`catalog authority did not return the current ${key}`);
      }
      this.discardViewOnThrow(() =>
        this.state.storage.transactionSync(() => {
          const view = this.ensureView();
          view.install(fresh);
          this.persistCell(view, key);
        })
      );
      this.guestResetDefinitionRetryAt = 0;
      this.metric({ kind: "net_guest_reset_definition", status: result.status });
    })();
    this.guestResetDefinitionRepair = repair;
    try {
      await repair;
    } catch (err) {
      this.guestResetDefinitionRetryAt = this.host.now() + GUEST_RESET_REPAIR_BACKOFF_MS;
      throw err;
    } finally {
      if (this.guestResetDefinitionRepair === repair) this.guestResetDefinitionRepair = null;
    }
  }

  /**
   * Reused pool actors are durable objects, so their physical location can
   * outlive the session that moved them. Exclusive minting must happen first
   * (otherwise two claims could race one actor); once this caller owns the
   * seat, run the guest's tracked reset at actor authority to clear inventory
   * and mutable profile state and restore its declared initial room. A second,
   * sequenced no-op `moveto` is needed only when the newly minted session's
   * active scope was the stale room: that updates session presence after the
   * reset's physical move. Pulling through actor authority throughout keeps
   * location, contents projections, and presence convergent for seats left
   * stale by deployments that only retracted sessions.
   */
  private async normalizePooledGuestEntry(
    actor: string,
    template: GuestTemplate,
    response: Response,
    epoch: string
  ): Promise<Response> {
    if (response.status !== 200) return response;
    const payload = await response.clone().json() as {
      session?: unknown;
      active_scope?: unknown;
      [key: string]: unknown;
    };
    const session = typeof payload.session === "string" ? payload.session : null;
    if (!session) return response;
    const initialRoom = template.initial_room;

    try {
      const actorScope = await this.clientPlanningScope(actor, actor);
      const refreshActor = async (): Promise<string | null> => {
        await this.pullTargeted(actorScope, `scope:${actorScope}`, [actor]);
        const live = this.ensureView().get(cellKey("object_live", actor))?.value as
          | { location?: unknown }
          | undefined;
        return typeof live?.location === "string" ? live.location : null;
      };
      const initialRoomScope = await this.clientPlanningScope(initialRoom, actor);
      await this.pullTargeted(initialRoomScope, `scope:${initialRoomScope}`, [initialRoom]);
      // Pull the actor AFTER the destination so an old room projection cannot
      // overwrite its authoritative location in the planning image.
      const before = await refreshActor();
      if (!before) throw new Error("guest reset could not resolve the actor's authoritative location");
      // Always submit the deterministic reset, even when the actor is already
      // in the initial room: description, features, and inventory can still
      // leak. A response-lost retry replays the same reset idempotency key.
      const currentScope = await this.clientPlanningScope(before, actor);
      await this.pullTargeted(currentScope, `scope:${currentScope}`, [before]);
      await refreshActor();
      const resetKey = `guest-reset:${session}`;
      const reset = await this.turn({
        call: {
          kind: "woo.turn_call.shadow.v1",
          id: resetKey,
          route: "direct",
          scope: before,
          actor: template.maintenance_principal,
          target: actor,
          verb: template.reset_verb,
          args: [initialRoom]
        },
        planningScope: currentScope,
        catalog_epoch: epoch,
        idempotency_key: resetKey
      });
      if (reset.reply.status !== "accepted" || reset.error !== undefined) {
        throw new Error(`guest reset rejected: reply=${JSON.stringify(reset.reply)} error=${JSON.stringify(reset.error ?? null)}`);
      }
      const resetLocation = await refreshActor();
      if (resetLocation !== initialRoom) {
        throw new Error(`guest reset left actor at ${String(resetLocation)}`);
      }

      if (payload.active_scope === initialRoom) return json({ ...payload, active_scope: initialRoom });

      const key = `guest-entry:${session}:${initialRoom}`;
      const result = await this.turn({
        call: {
          kind: "woo.turn_call.shadow.v1",
          id: key,
          route: "sequenced",
          scope: initialRoom,
          session,
          actor,
          target: actor,
          verb: "moveto",
          args: [initialRoom]
        },
        planningScope: initialRoomScope,
        catalog_epoch: epoch,
        idempotency_key: key
      });
      if (result.reply.status === "accepted" && result.error === undefined) {
        const after = await refreshActor();
        if (after !== initialRoom) {
          throw new Error(`guest entry turn left actor at ${String(after)}: ${JSON.stringify(result.result ?? null)}`);
        }
        return json({ ...payload, active_scope: initialRoom });
      }
      throw new Error(
        `guest entry turn rejected: reply=${result.reply.status} error=${JSON.stringify(result.error ?? null)}`
      );
    } catch (err) {
      // Do not strand an exclusively claimed pool seat when its mandatory
      // reset fails. Closing is best-effort here; the named retry response
      // prevents the browser from entering with another user's room state.
      await this.clientSessionClose(actor, session, epoch).catch(() => undefined);
      this.metric({ kind: "net_guest_entry_normalize", actor, room: initialRoom, status: "error", error: String(err) });
      return json(
        { error: { code: "E_RETRY", message: "guest entry could not restore its initial room; retry", detail: { reason: "guest_entry_normalize" } } },
        503
      );
    }
  }

  /** Parse the install-owned template strictly. A malformed template makes
   * guest admission fail closed: catalog data must neither smuggle partial
   * identity into an authority commit nor bypass mandatory pooled-seat reset. */
  private elasticGuestTemplate(): GuestTemplate | null {
    const cell = this.ensureView().get(cellKey("property_cell", "$system", "guest_template"));
    const template = (cell?.value as { value?: unknown } | undefined)?.value;
    if (!template || typeof template !== "object" || Array.isArray(template)) return null;
    const row = template as Record<string, unknown>;
    if (
      typeof row.parent !== "string" ||
      typeof row.owner !== "string" ||
      typeof row.description !== "string" ||
      typeof row.home !== "string" ||
      typeof row.initial_room !== "string"
    ) return null;
    if (
      row.version === 2 &&
      typeof row.reset_definer === "string" && row.reset_definer.length > 0 &&
      typeof row.reset_verb === "string" && row.reset_verb.length > 0 &&
      typeof row.maintenance_principal === "string" && row.maintenance_principal.length > 0
    ) return row as GuestTemplate;
    if (row.version !== 1) return null;

    // Compatibility for active Net worlds installed before template v2. The
    // old row already carries parent/owner; discover the one matching reset
    // primitive on that parent's bounded own-cell index instead of restoring
    // the old $guest/$wiz/on_disfunc identity literals in the worker.
    const candidates = this.ensureView().cellsForObject(row.parent).filter((cell) => {
      if (cell.kind !== "verb_bytecode" || typeof cell.name !== "string") return false;
      const page = cell.value as { kind?: unknown; native?: unknown; owner?: unknown } | null;
      return page?.kind === "native" && page.native === GUEST_RESET_NATIVE && page.owner === row.owner;
    });
    if (candidates.length !== 1) return null;
    return {
      version: 2,
      parent: row.parent,
      owner: row.owner,
      description: row.description,
      home: row.home,
      initial_room: row.initial_room,
      reset_definer: row.parent,
      reset_verb: candidates[0].name!,
      maintenance_principal: row.owner
    };
  }

  /** Provision an anonymous actor and its first session in one commit at
   * the actor's fresh cluster owner. A claim-derived id is retry-stable; a
   * legacy random id still selects an empty DO. The scope's create-collision
   * check fails closed either way. */
  private async clientElasticGuest(
    epoch: string,
    template: GuestTemplate,
    claim: GuestClaim | null,
    ttlMs: number
  ): Promise<Response> {
    const actor = `guest_net_${claim ? await guestClaimHex(claim, "actor") : randomHex(16)}`;
    const session = sessionIdWithShardHint(
      this.shardName(),
      claim ? await guestClaimHex(claim, `session:${actor}`) : randomHex(16)
    );
    const planned = provisionGuestSubmit({
      actor,
      session,
      ttl_ms: ttlMs,
      now: claim?.issuedAt ?? this.host.now(),
      epoch,
      template
    });
    const roomScope = await this.clientPlanningScope(template.initial_room, actor);
    const destination = `scope:${planned.clusterScope}`;
    const relateDestinations = roomScope === planned.clusterScope
      ? undefined
      : { [roomScope]: { destination: `scope:${roomScope}`, objects: [template.initial_room] } };
    const submitBody = relateDestinations ? { submit: planned.submit, relate_destinations: relateDestinations } : planned.submit;
    const reply = await this.idempotentSubmit(destination, submitBody);
    if (reply.status !== "accepted") {
      return json(
        { error: { code: "E_RETRY", message: "guest provisioning did not commit; retry", detail: reply } },
        503
      );
    }
    let installDegraded = false;
    try {
      await this.installTouched(this.ensureView(), destination, reply.touched);
    } catch (err) {
      installDegraded = true;
      this.metric({ kind: "net_guest_provision_install_degraded", actor, status: "error", error: String(err) });
      this.installAcceptedSessionEcho(session, planned.value, reply, epoch);
    }
    await this.selfSubscribe(planned.clusterScope);
    await this.selfSubscribe(roomScope);
    this.metric({ kind: "net_guest_provisioned", actor, scope: planned.clusterScope, status: "ok" });
    return json({
      session,
      actor,
      expires_at: planned.value.expiresAt ?? null,
      scope: planned.clusterScope,
      active_scope: template.initial_room,
      elastic: true,
      ...(installDegraded ? { install_degraded: true } : {})
    });
  }

  /** Linear scan of the catalog-scope view for the $account instance
   * whose email prop matches (normalized) — v2 findAccountByEmail parity;
   * O(accounts) over in-memory cells, same asymptotics as core's scan.
   * Identifies accounts by their lineage parent chain reaching $account
   * (one hop: instances parent directly to the class). */
  private accountByEmail(email: string): { id: string; props: Record<string, unknown> } | null {
    const view = this.ensureView();
    for (const key of view.keys()) {
      if (!key.startsWith("object_lineage:")) continue;
      const object = key.slice("object_lineage:".length);
      const lineage = view.get(key)?.value as { parent?: string | null } | undefined;
      if (lineage?.parent !== "$account") continue;
      const emailCell = view.get(cellKey("property_cell", object, "email"))?.value as { value?: unknown } | undefined;
      if (typeof emailCell?.value !== "string" || normalizeEmail(emailCell.value) !== email) continue;
      const props: Record<string, unknown> = {};
      for (const name of ["password_hash", "password_salt", "primary_actor", "deactivated_at"]) {
        const cell = view.get(cellKey("property_cell", object, name))?.value as { value?: unknown } | undefined;
        if (cell && "value" in cell) props[name] = cell.value;
      }
      return { id: object, props };
    }
    return null;
  }

  /** DELETE /net-api/session — the identity door's release half
   * (finding 12): validate the caller's binding, then commit the close
   * (immediate expiry + presence retraction) at the cluster authority. */
  private async clientSessionClose(actor: string, session: string, epoch: string): Promise<Response> {
    await this.warmScopes(
      [CATALOG_SCOPE, { scope: `cluster:${actor}`, objects: [actor] }],
      "net_client_pull_miss_failed"
    );
    const cell = this.ensureView().get(sessionCellKey(session));
    const verdict = validateSessionCell(cell, this.host.now(), actor);
    if (verdict === "expired" || verdict === "missing") {
      // Already released (reaped, expired, or never here) — closing is
      // idempotent from the client's view.
      return json({ closed: true, already: verdict });
    }
    if (verdict !== "ok") {
      return json({ error: { code: "E_PERM", message: `session ${verdict}`, detail: { session_verdict: verdict } } }, 403);
    }
    const priorValue = cell?.value as { activeScope?: string | null; ephemeralActor?: boolean } | undefined;
    const prior = priorValue?.activeScope ?? null;
    const opened = await this.sessionOpen({
      session,
      actor,
      ttl_ms: 0, // ignored in closing mode
      catalog_epoch: epoch,
      closing: { priorActiveScope: prior, ...(priorValue?.ephemeralActor ? { ephemeralActor: true } : {}) }
    });
    if (opened.reply.status !== "accepted") {
      return json({ error: { code: "E_RETRY", message: "session close did not commit; retry", detail: opened.reply } }, 503);
    }
    return json({
      closed: true,
      ...(opened.install_degraded ? { install_degraded: true } : {}),
      ...(opened.relation_expedite_degraded ? { relation_expedite_degraded: true } : {})
    });
  }

  /** V3 finding 3 (P1): the net mirror of core `actorCanAuthenticate`.
   * Refuses `identity_deactivated` when the actor, its account (human),
   * or any owner in its agent chain is deactivated. Cells read from
   * cluster views (warmed on demand — an owner lives at its OWN
   * cluster); a bounded walk (agent chains are shallow, guarded against
   * cycles). A cell that cannot be pulled is treated as absent, matching
   * core's `objects.has` guard: an agent whose owner cannot resolve is
   * NOT eligible (fail closed). */
  private async assertActorEligible(actor: string, epoch: string): Promise<void> {
    void epoch; // reserved: cross-epoch warms use the identity epoch implicitly
    const prop = (object: string, name: string): unknown => {
      const cell = this.ensureView().get(cellKey("property_cell", object, name))?.value as { value?: unknown } | undefined;
      return cell && "value" in cell ? cell.value : undefined;
    };
    const lineage = (object: string): { parent?: string | null } | undefined =>
      this.ensureView().get(cellKey("object_lineage", object))?.value as { parent?: string | null } | undefined;
    const reachesClass = (object: string, cls: string): boolean => {
      let current: string | null | undefined = object;
      const guard = new Set<string>();
      while (current && !guard.has(current)) {
        if (current === cls) return true;
        guard.add(current);
        current = lineage(current)?.parent;
      }
      return false;
    };
    const refuse = (detail: Record<string, unknown>): never => {
      throw new ClientAuthError("identity deactivated", { reason: "identity_deactivated", ...detail }, "E_PERM", 403);
    };

    const guard = new Set<string>();
    let current: string | null = actor;
    while (current && !guard.has(current)) {
      guard.add(current);
      // The actor's OWN deactivation (core's first check).
      if (prop(current, "deactivated_at") != null) refuse({ actor: current });
      // ANY actor carrying an account binding is gated by that account's
      // deactivation — stricter than core (which gates only $human) and
      // the finding-2 rule: a deactivated account never authenticates
      // whatever the bound actor's class.
      const account = prop(current, "account");
      if (typeof account === "string" && account.length > 0 && prop(account, "deactivated_at") != null) {
        refuse({ actor: current, account });
      }
      // $agent: recurse up the owner chain (core's rule) — a deactivated
      // owner disqualifies its agents. $wiz-owned agents authenticate.
      if (reachesClass(current, "$agent")) {
        const owner = prop(current, "owner");
        if (owner === "$wiz") return;
        if (typeof owner !== "string" || owner.length === 0) refuse({ actor: current, reason_detail: "agent_owner_unresolved" });
        await this.warmScopes(
          [{ scope: `cluster:${owner}`, objects: [owner as string] }],
          "net_eligibility_owner_pull_failed"
        );
        if (!lineage(owner as string)) refuse({ actor: current, owner, reason_detail: "agent_owner_unresolved" });
        current = owner as string;
        continue;
      }
      return; // not an agent: the actor + account checks above suffice
    }
  }

  /** POST /net-api/session — see the clientApi header. */
  private async clientSession(
    actor: string,
    body: Record<string, unknown>,
    epoch: string,
    options: { exclusive?: boolean; session?: string; issuedAt?: number; ttlMs?: number } = {}
  ): Promise<Response> {
    // The mint needs the actor's lineage (cluster-scope derivation) in
    // view; the CO15 `cluster:<actor>` convention names the pull
    // destination without needing lineage first (the planScheduled
    // idiom). Best-effort: sessionOpen's own E_MISSING_STATE names the
    // failure when the pull could not land.
    await this.warmScopes(
      [CATALOG_SCOPE, { scope: `cluster:${actor}`, objects: [actor] }],
      "net_client_pull_miss_failed"
    );
    // Identity eligibility at EVERY mint (the one gate every credential
    // path passes). V3 finding 3 (P1): mirror core actorCanAuthenticate
    // in FULL — the actor's OWN deactivated_at, then for a $human its
    // account's, and for an $agent a recursive walk up the owner chain.
    // The prior check saw only actor.account, so a deactivated primary
    // actor or an apikey for a deactivated agent still minted.
    await this.assertActorEligible(actor, epoch);
    // Phase 6: the id carries THIS shard's name so a future multi-shard
    // /net-api router can resolve a live session to the gateway holding
    // its view — a routing change, never a data migration.
    const session = options.session ?? sessionIdWithShardHint(this.shardName(), randomHex(16));
    // Client-shell phase i: the session is born PRESENT at the actor's
    // live location (v2 parity — cross-actor delivery routes by session
    // presence, and a placeless session would miss everything until its
    // first move). The location cell is in view from the cluster warm
    // above; a location-less actor mints placeless as before.
    const liveRow = this.ensureView().get(cellKey("object_live", actor))?.value as { location?: string | null } | undefined;
    const bornAt = typeof liveRow?.location === "string" && liveRow.location !== "$nowhere" ? liveRow.location : null;
    const opened = await this.sessionOpen({
      session,
      actor,
      ttl_ms: options.ttlMs ?? clampClientTtl(body.ttl_ms),
      catalog_epoch: epoch,
      active_scope: bornAt,
      ...(options.issuedAt !== undefined ? { issued_at_ms: options.issuedAt } : {}),
      ...(options.exclusive ? { exclusive: true } : {})
    });
    if (opened.reply.status !== "accepted") {
      // Identity-door guest claim: the occupied verdict is the caller's
      // signal to try the next pool actor — a NAMED terminal refusal,
      // never a retry-me.
      const rejectDetail = (opened.reply as { detail?: Record<string, unknown> }).detail;
      if (rejectDetail?.session_verdict === "actor_occupied") {
        return json(
          { error: { code: "E_PERM", message: `actor ${actor} already has a live session`, detail: rejectDetail } },
          409
        );
      }
      // Otherwise a mint only rejects retryably (stale_head races, already
      // retried inside sessionOpen) or on epoch drift; either way the
      // client's recovery is simply to retry.
      return json({ error: { code: "E_RETRY", message: "session mint did not commit; retry", detail: opened.reply } }, 503);
    }
    // H1: subscribe this gateway to the actor's CLUSTER — the session's
    // authority scope, where its cell and any cluster-committed
    // observations live — and, for a born-present session (phase i), to
    // the BIRTH ROOM's scope: presence routing delivers there, and
    // without the subscription the fanout would never reach this shard's
    // sockets/queues until the session's first turn.
    await this.selfSubscribe(opened.scope);
    if (bornAt) await this.selfSubscribe(await this.clientPlanningScope(bornAt, actor));
    const value = opened.value as { expiresAt?: number } | null;
    return json({
      session,
      actor,
      expires_at: typeof value?.expiresAt === "number" ? value.expiresAt : null,
      scope: opened.scope,
      // Clients must not guess whether this owner-committed session was born
      // present. Exposing the routing fact also keeps canaries from creating
      // artificial same-room transition storms.
      active_scope: bornAt,
      ...(opened.install_degraded ? { install_degraded: true } : {}),
      ...(opened.relation_expedite_degraded ? { relation_expedite_degraded: true } : {})
    });
  }

  /** POST /net-api/turn — see the clientApi header. */
  private async clientTurn(
    actor: string,
    body: Record<string, unknown>,
    epoch: string,
    audit?: { credential?: string; trace?: TraceContext }
  ): Promise<Response> {
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
    await this.warmScopes(
      [CATALOG_SCOPE, { scope: `cluster:${actor}`, objects: [actor] }],
      "net_client_pull_miss_failed"
    );
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
    // Catalog-qualified names are manifest syntax, resolved by the catalog
    // installer before objects reach the runtime. Rejecting one here is also
    // required for key safety: every net cell-key parser treats `:` as a
    // delimiter and therefore cannot represent a colon-bearing object id.
    // Keep this after session validation so malformed input cannot bypass the
    // authenticated actor/session binding, but before target pull and repair
    // so a client typo cannot become a retry-budget failure.
    if (!isConcreteRuntimeObjectId(target)) {
      return json(
        {
          error: {
            code: "E_INVARG",
            message: "turn target is not a valid runtime object id",
            detail: { field: "target", reason: "invalid_object_id" }
          }
        },
        400
      );
    }
    if (!isConcreteRuntimeObjectId(verb)) {
      return json(
        {
          error: {
            code: "E_INVARG",
            message: "turn verb is not a valid runtime verb name",
            detail: { field: "verb", reason: "invalid_verb_name" }
          }
        },
        400
      );
    }
    const args = (Array.isArray(body.args) ? body.args : []) as PlanTurnInput["call"]["args"];

    // planningScope from the session cell (the CO14 Phase-4 refinement):
    // the anchor object is the session's activeScope when set (the CO13
    // presence scope), else the actor's live location from the view, else
    // the actor itself (a located-nowhere actor plans at its own cluster).
    const row = cell?.value as { activeScope?: string | null } | undefined;
    const anchorObject = this.clientAnchorObject(actor, row?.activeScope ?? null);
    const planningScope = await this.clientPlanningScope(anchorObject, actor);
    // Phase 4: warm the TURN'S TARGET (and its anchor) at the planning
    // scope. Under targeted cold-open the room's cells no longer arrive
    // wholesale, and a client-turn target the view never materialized is
    // exactly the case pull-on-miss cannot route (its owner is not
    // conventionally derivable from the object id — the Phase-1 smoke
    // blocker); naming it here pulls its chain from the scope that
    // anchors it before planning starts.
    await this.warmScopes(
      [{ scope: planningScope, objects: [target, anchorObject] }],
      "net_client_pull_miss_failed"
    );
    // `arg_spec.params` is compiler-owned metadata naming the positional
    // inputs. Parameters with object-role names denote refs; reject
    // manifest-qualified values in those
    // slots before the planner can turn a client typo into missing-state
    // repair. Text/value slots remain unrestricted (messages may contain ':').
    const validationCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "validate",
      route: "sequenced",
      scope: anchorObject,
      session,
      actor,
      target,
      verb,
      args
    } as const;
    let page = this.callVerbPage(this.ensureView(), validationCall);
    // A targeted room backfill can materialize an object's lineage without
    // every definition page. Only suspicious colon-bearing inputs pay for a
    // forced object closure; ordinary turns retain the warm zero-RPC path.
    // This also resolves inherited verb metadata through the returned chain.
    if (!page && args.some((value) =>
      (Array.isArray(value) ? value : [value]).some((part) => typeof part === "string" && part.includes(":"))
    )) {
      try {
        await this.pullTargeted(planningScope, `scope:${planningScope}`, [target]);
        page = this.callVerbPage(this.ensureView(), validationCall);
      } catch (err) {
        this.metric({ kind: "net_client_arg_validation_pull_failed", scope: planningScope, status: "error", error: String(err) });
      }
    }
    const declaredArgs = page?.arg_spec && typeof page.arg_spec === "object" && !Array.isArray(page.arg_spec)
      ? (page.arg_spec as { params?: unknown }).params
      : undefined;
    if (Array.isArray(declaredArgs)) {
      const invalidIndex = args.findIndex((value, index) => {
        const name = declaredArgs[index];
        if (typeof name !== "string" || !OBJECT_ARGUMENT_NAMES.has(name)) return false;
        const refs = Array.isArray(value) ? value : [value];
        return refs.some((ref) => typeof ref === "string" && ref.includes(":"));
      });
      if (invalidIndex >= 0) {
        return json(
          {
            error: {
              code: "E_INVARG",
              message: "turn object argument is not a valid runtime object id",
              detail: { field: `args[${invalidIndex}]`, reason: "invalid_object_id" }
            }
          },
          400
        );
      }
    }
    // Match the existing gateway contract in CA14: catalog metadata may name
    // deterministic authority roots/property paths.  Resolve those paths
    // generically before planning so a cold movement does not spend one repair
    // round each on the exit, destination, and destination lineage.
    await this.warmDeclaredAuthorityPrefetch({
      kind: "woo.turn_call.shadow.v1",
      id: "prefetch",
      route: "sequenced",
      scope: anchorObject,
      session,
      actor,
      target,
      verb,
      args
    }, planningScope);
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
    // AU3.2: the principal is stamped HERE, at the trust boundary — any
    // client-supplied `principal` in the body is ignored by construction
    // (it is never read). The customer comes from the actor's
    // customer_of cell, already in the view via the cluster warm above;
    // a missing cell is a named identity-pipeline gap (the turn still
    // commits, unattributed) — never a runtime graph walk.
    const attribution = normalizeCustomerAttribution(
      this.ensureView().get(customerOfCellKey(actor))?.value
    );
    if (!attribution) {
      this.metric({ kind: "net_turn_unattributed", scope: planningScope, actor, status: "warn" });
    }
    const principal: Principal | null = attribution
      ? {
          attribution: "authenticated",
          customer: attribution.customer,
          ...(attribution.team ? { team: attribution.team } : {}),
          actor,
          session,
          ...(audit?.credential ? { credential: audit.credential } : {})
        }
      : null;
    // AU2: adopt the caller's context (REST/MCP header via audit.trace,
    // WS frame `trace` field via the body) or mint — never reject.
    const bodyTrace =
      body.trace !== null && typeof body.trace === "object" && !Array.isArray(body.trace)
        ? (body.trace as Record<string, unknown>)
        : null;
    const trace =
      audit?.trace ??
      adoptOrMintTraceContext(
        typeof bodyTrace?.traceparent === "string" ? bodyTrace.traceparent : null,
        typeof bodyTrace?.tracestate === "string" ? bodyTrace.tracestate : null
      );
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
      ...(principal ? { principal } : {}),
      trace,
      planningScope,
      catalog_epoch: epoch,
      idempotency_key: key
    });
    // H1: keep this gateway subscribed to the scope the session is NOW
    // present in — its activeScope AFTER any transition this turn folded
    // (install-on-accept already refreshed the session cell in the view).
    // A room-entering turn plans at the OLD anchor but lands the session
    // in the NEW room, so subscribing to the post-turn active scope is
    // what makes the peer push for that room reach this shard's sockets.
    // Best-effort (selfSubscribe swallows failures); it must never turn a
    // committed turn into an error.
    if (result.reply.status === "accepted") {
      const settled = this.ensureView().get(sessionCellKey(session))?.value as
        | { activeScope?: string | null }
        | undefined;
      const settledScope = settled?.activeScope ?? null;
      if (settledScope) await this.selfSubscribe(await this.clientPlanningScope(settledScope, actor));
    }
    // Terminal rejections return as 200 TurnResults (same as /net/turn):
    // the reply names its verdict; thrown taxonomy errors (E_BUDGET etc.)
    // surface through the clientApi catch instead.
    return json(result);
  }

  /** Net-native browser telemetry. Authentication above establishes the
   * actor; the live session binding prevents a stale/revoked credential from
   * writing diagnostics, and payload actor fields are intentionally ignored.
   * Metrics are bounded diagnostics and never participate in world state. */
  private async clientBrowserMetrics(actor: string, body: Record<string, unknown>): Promise<Response> {
    const session = typeof body.session === "string" && body.session.length > 0 ? body.session : null;
    if (!session) {
      return json({ error: { code: "E_NOSESSION", message: "browser metrics require a live session" } }, 401);
    }
    await this.warmScopes([{ scope: `cluster:${actor}`, objects: [actor] }], "net_browser_metric_session_pull_failed");
    const verdict = validateSessionCell(this.ensureView().get(sessionCellKey(session)), this.host.now(), actor);
    if (verdict !== "ok") {
      return json({ error: { code: "E_NOSESSION", message: `session ${verdict}`, detail: { session_verdict: verdict } } }, 401);
    }
    const rawMetrics = Array.isArray(body.metrics) ? body.metrics : [];
    let accepted = 0;
    let sampled = Math.max(0, rawMetrics.length - MAX_NET_BROWSER_METRICS_BATCH);
    for (const raw of rawMetrics.slice(0, MAX_NET_BROWSER_METRICS_BATCH)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const input = raw as Record<string, unknown>;
      if (input.kind !== "browser_activity" || typeof input.phase !== "string" || input.phase.length === 0) continue;
      const ms = typeof input.ms === "number" && Number.isFinite(input.ms) && input.ms >= 0 ? input.ms : 0;
      this.metric({
        kind: "browser_activity",
        source: input.source === "v2_browser_worker" ? "v2_browser_worker" : "main",
        phase: input.phase.slice(0, 160),
        actor,
        ms,
        status: input.status === "error" ? "error" : "ok",
        ...(typeof input.error === "string" && input.error.length > 0 ? { error: input.error.slice(0, 512) } : {})
      });
      accepted += 1;
    }
    // Invalid entries are dropped rather than reflected: this is a lossy
    // diagnostic path, and callers must not gain a payload-validation oracle.
    sampled += rawMetrics.slice(0, MAX_NET_BROWSER_METRICS_BATCH).length - accepted;
    return json({ ok: true, accepted, sampled });
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
      await this.warmScopes(
        [{ scope: `room:${anchorObject}`, objects: [anchorObject] }],
        "net_client_pull_miss_failed"
      );
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

  // ---- /net-api/mcp: the MCP adapter (client-shell phase i) ---------------
  //
  // The agent/plug surface AND the §8 "prove" instrument: the deployed
  // walkthrough drives MCP, so this is what lets the ONE smoke scenario
  // run against the net path. Three stable controls plus the structural
  // dynamic projection are backed by the SAME machinery the HTTP client
  // surface uses (clientSession/clientTurn/the mirror), so MCP is an
  // ENVELOPE around the net path, never a second path.
  //
  // Auth: `initialize` authenticates an apikey from the `mcp-token`
  // header and mints a net session; the returned mcp-session-id IS that
  // net session id, and every later call validates the session cell
  // (expiry included) — bearer semantics identical to v2's MCP surface.
  //
  // Observations: woo_wait long-polls a per-session in-memory queue fed
  // by the SAME presence-routed fanout that feeds WebSocket pushes
  // (including server-side submitter echo dedupe). In-memory like v2's wait
  // queues: an eviction drops undelivered items; the client's next wait
  // simply re-arms (at-most-once live delivery — CO2.7's socket rule).

  /** Per-session observation queues, dynamic-list baseline, and bounded
   * GET/SSE listeners. This is live transport state: entries die with the DO,
   * and a reconnect after eviction receives a conservative re-list hint. */
  private readonly mcpQueues = new Map<string, NetMcpSessionState>();
  /** Backoff for dangling/stale contextual relation refs. A missing member
   * must not turn repeated tools/list calls into a multi-Hz closure storm. */
  private readonly mcpContextWarmFailures = new Map<string, { attempts: number; retryAt: number }>();
  /** A lineage row can arrive in a sparse room transfer without the object's
   * own verb pages. Record completed object pulls separately so per-instance
   * tools are neither missed nor re-pulled on every tools/list. */
  private readonly mcpContextWarmSuccesses = new Set<string>();

  private async clientMcp(request: Request): Promise<Response> {
    const rpc = (await request.json().catch(() => null)) as {
      jsonrpc?: string;
      id?: number | string | null;
      method?: string;
      params?: Record<string, unknown>;
    } | null;
    if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error: expected a JSON-RPC 2.0 request" } }, 400);
    }
    // Notifications (no id) acknowledge with 202 and no body — the MCP
    // handshake's notifications/initialized.
    if (rpc.id === undefined || rpc.id === null) {
      return new Response(null, { status: 202 });
    }
    if (rpc.method === "initialize") return await this.mcpInitialize(request, rpc.id, rpc.params ?? {});
    if (rpc.method === "tools/list") return await this.mcpToolsList(request, rpc.id, rpc.params ?? {});
    if (rpc.method === "tools/call") {
      return await this.mcpToolsCall(request, rpc.id, rpc.params ?? {});
    }
    return json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: `method not found: ${rpc.method}` } }, 200);
  }

  /** Streamable HTTP's optional standalone GET/SSE carrier. The listen is
   * deliberately bounded: an idle Durable Object request must not become a
   * permanent synchronous dependency. Standard clients reconnect after the
   * stream closes, while a not-yet-delivered hint remains pending in the
   * session state and is handed to exactly one later stream. */
  private clientMcpEvents(request: Request): Response {
    const accept = request.headers.get("accept") ?? "";
    if (!accept.toLowerCase().includes("text/event-stream")) {
      return json({ error: { code: "E_INVARG", message: "MCP GET requires Accept: text/event-stream" } }, 406);
    }
    const session = request.headers.get("mcp-session-id") ?? "";
    const cell = this.ensureView().get(sessionCellKey(session));
    const verdict = validateSessionCell(cell, this.host.now());
    if (verdict !== "ok") {
      return json({ error: { code: "E_NOSESSION", message: `session ${verdict}` } }, 404);
    }
    const actor = (cell?.value as { actor?: unknown }).actor;
    if (typeof actor !== "string" || !actor) {
      return json({ error: { code: "E_NOSESSION", message: "session actor is missing" } }, 404);
    }
    this.enforceClientRate(actor, "/net-api/mcp");
    const state = this.mcpSessionState(session, actor, true);
    const gateway = this;
    let waiter: NetMcpSseWaiter | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // A retry field flushes headers immediately and asks conforming clients
        // to reconnect gently after the bounded listen closes.
        controller.enqueue(MCP_SSE_CONNECTED);
        const detach = (): void => {
          if (timer !== null) clearTimeout(timer);
          timer = null;
          if (!waiter) return;
          const index = state.sseWaiters.indexOf(waiter);
          if (index >= 0) state.sseWaiters.splice(index, 1);
        };
        const close = (): void => {
          if (closed) return;
          closed = true;
          detach();
          try { controller.close(); } catch { /* a cancelled stream is already closed */ }
        };
        waiter = {
          close,
          deliver(message) {
            if (closed) return false;
            try {
              controller.enqueue(mcpSseMessage(message));
              close();
              return true;
            } catch {
              close();
              return false;
            }
          }
        };
        state.sseWaiters.push(waiter);
        timer = setTimeout(close, MCP_SSE_LISTEN_MS);
        gateway.mcpFlushListChanged(state);
      },
      cancel() {
        waiter?.close();
      }
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform"
      }
    });
  }

  /** Streamable HTTP session close. The MCP session id is the net session
   * bearer, so DELETE must commit the same owner-sequenced close as logout. */
  private async clientMcpClose(request: Request): Promise<Response> {
    const session = request.headers.get("mcp-session-id") ?? "";
    if (!session) return new Response(null, { status: 204 });
    const cell = this.ensureView().get(sessionCellKey(session));
    const verdict = validateSessionCell(cell, this.host.now());
    if (verdict === "missing" || verdict === "expired") {
      this.mcpDisposeSessionState(session);
      return new Response(null, { status: 204 });
    }
    if (verdict !== "ok") {
      return json({ error: { code: "E_PERM", message: `session ${verdict}` } }, 403);
    }
    const actor = (cell?.value as { actor?: string }).actor;
    if (typeof actor !== "string" || !actor) {
      return json({ error: { code: "E_NOSESSION", message: "session actor is missing" } }, 401);
    }
    const identity = await this.catalogIdentity();
    const closed = await this.clientSessionClose(actor, session, identity.epoch);
    if (!closed.ok) return closed;
    this.mcpDisposeSessionState(session);
    return new Response(null, { status: 204 });
  }

  private async mcpInitialize(request: Request, id: number | string, _params: Record<string, unknown>): Promise<Response> {
    const token = request.headers.get("mcp-token") ?? "";
    // Reuse the exact client-auth path: the token is an apikey credential
    // (the only client credential the net surface has).
    const synthetic = new Headers({ "x-woo-api-key": token });
    const credential = parseClientCredential(synthetic, null);
    const identity = await this.catalogIdentity();
    const { actor } = verifyApiKeyCredential(identity.map, credential);
    this.enforceClientRate(actor, "/net-api/session"); // the mint bucket (H4 amplifier rule)
    const opened = await this.clientSession(actor, {}, identity.epoch);
    const body = (await opened.json()) as { session?: string };
    if (!opened.ok || typeof body.session !== "string") {
      return json({ jsonrpc: "2.0", id, error: { code: -32000, message: `session mint failed: ${JSON.stringify(body)}` } }, 200);
    }
    this.mcpSessionState(body.session, actor);
    return json(
      {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "woo-net", version: "1" },
          instructions: `You are woo actor ${actor}. Dynamic tools track your current space, its contextual objects, and your inventory. Re-list tools when notifications/tools/list_changed arrives.`
        }
      },
      200,
      { "mcp-session-id": body.session }
    );
  }

  /** AU2: adopt the MCP request's traceparent for a tool-invoked turn. */
  private mcpTraceOf(request: Request): TraceContext {
    return adoptOrMintTraceContext(request.headers.get("traceparent"), request.headers.get("tracestate"));
  }

  private async mcpToolsCall(request: Request, id: number | string, params: Record<string, unknown>): Promise<Response> {
    const session = request.headers.get("mcp-session-id") ?? "";
    const cell = this.ensureView().get(sessionCellKey(session));
    const verdict = validateSessionCell(cell, this.host.now());
    if (verdict !== "ok") {
      return json({ jsonrpc: "2.0", id, error: { code: -32000, message: `session ${verdict}` } }, 200);
    }
    const actor = (cell?.value as { actor?: unknown }).actor;
    if (typeof actor !== "string" || !actor) {
      return json({ jsonrpc: "2.0", id, error: { code: -32000, message: "session actor is missing" } }, 200);
    }
    this.mcpSessionState(session, actor, true);
    this.enforceClientRate(actor, "/net-api/mcp");
    const name = typeof params.name === "string" ? params.name : "";
    const args = (params.arguments ?? {}) as Record<string, unknown>;

    if (name === "woo_wait") {
      const timeout = typeof args.timeout_ms === "number" ? Math.min(Math.max(args.timeout_ms, 0), 25_000) : 1000;
      const limit = typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0
        ? Math.min(Math.max(Math.floor(args.limit), 1), MCP_QUEUE_CAP)
        : 64;
      const observations = await this.mcpWait(session, timeout, limit);
      return this.mcpResult(id, { observations });
    }
    // The relation mirror can be newer than this gateway's object-cell view.
    // Materialize only the bounded structural context before discovery or
    // invocation so the advertised set and the accepted set remain equal.
    await this.warmMcpContext(actor, session);
    if (name === "woo_list_reachable_tools") {
      try {
        const page = this.mcpToolPage(actor, session, args);
        this.mcpMarkToolListSeen(session, actor);
        const includeSchema = args.include_schema === true;
        return this.mcpResult(id, {
          scope: page.scope,
          object: page.object,
          query: page.query,
          limit: page.limit,
          cursor: page.cursor,
          next_cursor: page.nextCursor,
          total: page.total,
          tools: page.tools.map((tool) => mcpToolSummary(tool, includeSchema))
        });
      } catch (err) {
        if (isNetError(err)) return this.mcpToolError(id, { code: err.code, message: err.message, detail: err.detail });
        return this.mcpToolError(id, { code: "E_INVARG", message: String(err) });
      }
    }
    if (name === "woo_call") {
      const object = typeof args.object === "string" ? args.object : "";
      const verb = typeof args.verb === "string" ? args.verb : "";
      if (!object || !verb) return this.mcpToolError(id, { code: "E_INVARG", message: "woo_call requires object and verb" });
      if (!isConcreteRuntimeObjectId(object)) {
        return this.mcpToolError(id, { code: "E_INVARG", message: "target must be a concrete runtime object id", detail: { field: "target", reason: "invalid_object_id", value: object } });
      }
      const tool = this.mcpContextTools(actor, session).find((candidate) =>
        candidate.object === object && (candidate.verb === verb || candidate.aliases.includes(verb))
      );
      if (!tool) return this.mcpToolError(id, { code: "E_PERM", message: `tool is not available in this session context: ${object}:${verb}` });
      return this.mcpInvokeTurn(id, actor, session, tool.object, tool.verb, Array.isArray(args.args) ? args.args : [], this.mcpTraceOf(request));
    }
    const dynamic = this.mcpContextTools(actor, session).find((tool) => tool.name === name);
    if (dynamic) return this.mcpInvokeTurn(id, actor, session, dynamic.object, dynamic.verb, mcpNamedArgs(dynamic, args), this.mcpTraceOf(request));
    return json({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${name}` } }, 200);
  }

  /** Standard MCP tools/list. Dynamic descriptors are computed from the same
   * bounded structural-context resolver used by woo_call, so listing and
   * invocation cannot disagree about reachability. */
  private async mcpToolsList(request: Request, id: number | string, params: Record<string, unknown>): Promise<Response> {
    const session = request.headers.get("mcp-session-id") ?? "";
    const cell = this.ensureView().get(sessionCellKey(session));
    const verdict = validateSessionCell(cell, this.host.now());
    if (verdict !== "ok") {
      return json({ jsonrpc: "2.0", id, error: { code: -32000, message: `session ${verdict}` } }, 200);
    }
    const actor = (cell?.value as { actor?: string }).actor;
    if (typeof actor !== "string" || !actor) {
      return json({ jsonrpc: "2.0", id, error: { code: -32000, message: "session actor is missing" } }, 200);
    }
    this.mcpSessionState(session, actor, true);
    this.enforceClientRate(actor, "/net-api/mcp");
    await this.warmMcpContext(actor, session);
    const cursor = mcpCursor(params.cursor);
    const context = this.mcpContextObjects(actor, session);
    const dynamic = this.mcpToolsForObjects(actor, context, this.mcpActiveCommandContext(actor, session));
    const all = [...MCP_TOOL_DEFS, ...dynamic.map(mcpProtocolTool)];
    this.mcpMarkToolListSeen(session, actor, this.mcpToolListDigest(actor, session, dynamic, context));
    const tools = all.slice(cursor, cursor + MCP_STANDARD_TOOL_PAGE);
    const next = cursor + tools.length;
    return json({
      jsonrpc: "2.0",
      id,
      result: {
        tools,
        ...(next < all.length ? { nextCursor: String(next) } : {})
      }
    });
  }

  private async mcpInvokeTurn(
    id: number | string,
    actor: string,
    session: string,
    object: string,
    verb: string,
    args: unknown[],
    trace?: TraceContext
  ): Promise<Response> {
    try {
      const identity = await this.catalogIdentity();
      const turnId = `mcp:${crypto.randomUUID()}`;
      const ownEchoIds = this.mcpQueues.get(session)?.ownEchoIds;
      if (ownEchoIds) {
        ownEchoIds.add(turnEchoId(turnId));
        while (ownEchoIds.size > MCP_QUEUE_CAP) {
          const oldest = ownEchoIds.values().next().value as string | undefined;
          if (oldest === undefined) break;
          ownEchoIds.delete(oldest);
        }
      }
      const turnResponse = await this.clientTurn(
        actor,
        { target: object, verb, args, session, idempotency_key: turnId },
        identity.epoch,
        // AU2 MCP carrier (threaded from mcpToolsCall, which holds the
        // request): an MCP agent framework that emits traceparent joins
        // its trace to this turn's commit.
        trace ? { trace } : undefined
      );
      const turn = (await turnResponse.json()) as {
        reply?: { status?: string; reason?: string; detail?: unknown };
        result?: unknown;
        error?: unknown;
        [key: string]: unknown;
      };
      if (!turnResponse.ok) return this.mcpToolError(id, turn.error ?? turn);
      if (turn.reply?.status !== "accepted") return this.mcpToolError(id, turn.reply ?? turn);
      if (turn.error !== undefined) return this.mcpToolError(id, turn.error);
      return this.mcpResult(id, turn.result ?? null);
    } catch (err) {
      // Taxonomy throws are tool failures on this surface. The JSON-RPC
      // request must receive a tool envelope, never an HTTP transport error.
      if (isNetError(err)) return this.mcpToolError(id, { code: err.code, message: err.message, detail: err.detail });
      return this.mcpToolError(id, { code: "E_INTERNAL", message: String(err) });
    }
  }

  /** The scenario's client contract: payloads ride
   * `result.structuredContent.result`; errors set `isError` with the
   * detail in structuredContent (unwrap() throws on it). */
  private mcpResult(id: number | string, payload: unknown): Response {
    return json({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: { result: payload },
        isError: false
      }
    });
  }

  private mcpToolError(id: number | string, detail: unknown): Response {
    return json({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(detail) }],
        structuredContent: { error: detail },
        isError: true
      }
    });
  }

  /** woo_wait: drain immediately when buffered, else park up to
   * `timeoutMs` for the next fanout enqueue. One waiter list per
   * session; every parked waiter wakes on the next delivery. Each wake drains
   * at most the caller's limit and leaves the remainder queued. Concurrent
   * waiters cannot duplicate a row because splice claims each prefix once. */
  private async mcpWait(session: string, timeoutMs: number, limit: number): Promise<unknown[]> {
    const queue = this.mcpQueues.get(session);
    if (!queue) return [];
    if (queue.buffer.length > 0) {
      const drained = queue.buffer.splice(0, limit);
      return drained;
    }
    if (timeoutMs === 0) return [];
    return await new Promise<unknown[]>((resolve) => {
      const timer = setTimeout(() => {
        const index = queue.waiters.indexOf(wake);
        if (index >= 0) queue.waiters.splice(index, 1);
        resolve(queue.buffer.splice(0, limit));
      }, timeoutMs);
      const wake = (): void => {
        clearTimeout(timer);
        resolve(queue.buffer.splice(0, limit));
      };
      queue.waiters.push(wake);
    });
  }

  /** Fanout-side feed (called from pushObservations, AFTER the same
   * server-side submitter echo dedupe the sockets get). Bounded buffer: overflow
   * drops oldest — at-most-once live delivery, the socket rule. */
  private mcpEnqueue(session: string, observations: unknown[]): void {
    const queue = this.mcpQueues.get(session);
    if (!queue || observations.length === 0) return;
    queue.buffer.push(...observations);
    if (queue.buffer.length > MCP_QUEUE_CAP) queue.buffer.splice(0, queue.buffer.length - MCP_QUEUE_CAP);
    const waiters = queue.waiters.splice(0, queue.waiters.length);
    for (const wake of waiters) wake();
  }

  /** Lazily reconstruct live MCP transport state after a DO eviction. A
   * reconnecting GET cannot recover the client's last descriptor baseline, so
   * it receives one conservative hint and re-lists. An ordinary first
   * initialize installs state explicitly and therefore emits no false change. */
  private mcpSessionState(session: string, actor: string, notifyOnRecover = false): NetMcpSessionState {
    const existing = this.mcpQueues.get(session);
    if (existing && existing.actor === actor) {
      // Map insertion order is the LRU: only authenticated client activity
      // touches an entry. Fanout delivery alone must not make an abandoned
      // session look active forever.
      this.mcpQueues.delete(session);
      this.mcpQueues.set(session, existing);
      return existing;
    }
    if (existing) this.mcpDisposeSessionState(session);
    this.mcpMakeRoomForSessionState();
    const created = mcpSessionState(actor);
    if (notifyOnRecover) {
      created.listChangedDirty = true;
      created.listChangedPending = true;
    }
    this.mcpQueues.set(session, created);
    return created;
  }

  /** Bound live transport memory independently of durable session authority.
   * New-state pressure first reaps entries whose mirrored bearer is already
   * unusable, then evicts the least-recently client-used live entry. The next
   * authenticated request for an evicted live session reconstructs state and
   * receives the conservative list-change hint. */
  private mcpMakeRoomForSessionState(): void {
    if (this.mcpQueues.size < MCP_SESSION_STATE_CAP) return;
    const view = this.ensureView();
    const now = this.host.now();
    for (const session of [...this.mcpQueues.keys()]) {
      if (validateSessionCell(view.get(sessionCellKey(session)), now) === "ok") continue;
      this.mcpDisposeSessionState(session);
    }
    while (this.mcpQueues.size >= MCP_SESSION_STATE_CAP) {
      const oldest = this.mcpQueues.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.mcpDisposeSessionState(oldest);
    }
  }

  /** Dispose every closure that can retain a session state. Parked waits wake
   * with the now-empty live buffer; SSE clients reconnect and, if their Net
   * session is still valid, lazily reconstruct through mcpSessionState. */
  private mcpDisposeSessionState(session: string): void {
    const state = this.mcpQueues.get(session);
    if (!state) return;
    this.mcpQueues.delete(session);
    state.buffer.length = 0;
    state.ownEchoIds.clear();
    state.toolListDigest = null;
    state.listChangedDirty = false;
    state.listChangedPending = false;
    const waiters = state.waiters.splice(0, state.waiters.length);
    for (const wake of waiters) wake();
    const streams = state.sseWaiters.splice(0, state.sseWaiters.length);
    for (const stream of streams) stream.close();
  }

  /** The exact standard-list digest: structural identity plus the complete
   * protocol descriptors produced by the invocation resolver. cellVersion's
   * canonical JSON hashing makes property order irrelevant. */
  private mcpToolListDigest(
    actor: string,
    session: string,
    tools?: NetMcpDynamicTool[],
    context?: Set<string>
  ): string {
    const contextualObjects = context ?? this.mcpContextObjects(actor, session);
    const descriptors = tools ?? this.mcpToolsForObjects(
      actor,
      contextualObjects,
      this.mcpActiveCommandContext(actor, session)
    );
    return cellVersion({
      active_space: this.mcpActiveScope(actor, session),
      // A cold contextual member may not have descriptors in this view yet.
      // Keeping the bounded object ids in the digest ensures its arrival still
      // asks the client to re-list, whose warmMcpContext then materializes it.
      contextual_objects: [...contextualObjects].sort((a, b) => a.localeCompare(b)),
      tools: descriptors.map(mcpProtocolTool)
    });
  }

  private mcpMarkToolListSeen(session: string, actor: string, digest?: string): void {
    const state = this.mcpSessionState(session, actor);
    state.toolListDigest = digest ?? this.mcpToolListDigest(actor, session);
    state.listChangedDirty = false;
    state.listChangedPending = false;
  }

  private mcpMaybeListChanged(session: string): void {
    const state = this.mcpQueues.get(session);
    if (!state || state.toolListDigest === null || state.listChangedDirty) return;
    const current = this.mcpToolListDigest(state.actor, session);
    if (current === state.toolListDigest) return;
    state.listChangedDirty = true;
    state.listChangedPending = true;
    this.mcpFlushListChanged(state);
  }

  private mcpFlushListChanged(state: NetMcpSessionState): void {
    if (!state.listChangedPending) return;
    while (state.sseWaiters.length > 0) {
      const waiter = state.sseWaiters.shift()!;
      if (!waiter.deliver(MCP_LIST_CHANGED_NOTIFICATION)) continue;
      state.listChangedPending = false;
      return;
    }
  }

  /** Compare only sessions plausibly affected by this applied fanout. Room
   * sessions come from the indexed presence projection; an actor-cluster
   * fanout also selects that actor's own sessions. Verb pages are inherited
   * across contexts, so rare definition changes conservatively select this
   * shard's live MCP sessions — never world objects or other gateways. */
  private mcpRefreshToolListHints(body: FanoutBody): void {
    if (this.mcpQueues.size === 0) return;
    const definitionChanged = [...body.cells.map((cell) => cell.key), ...(body.removed_cells ?? [])]
      .some((key) => key.startsWith("verb_bytecode:"));
    const candidates = new Set<string>();
    if (definitionChanged) {
      for (const session of this.mcpQueues.keys()) candidates.add(session);
    } else {
      const present = sqlRows<{ member: string }>(
        this.state.storage.sql.exec(
          "SELECT member FROM net_gateway_relation WHERE relation = ? AND owner_scope = ?",
          SESSION_PRESENCE_RELATION,
          body.scope
        )
      );
      for (const row of present) if (this.mcpQueues.has(row.member)) candidates.add(row.member);
      for (const [session, state] of this.mcpQueues) {
        if (body.scope === `cluster:${state.actor}`) candidates.add(session);
      }
    }
    for (const session of candidates) {
      try {
        this.mcpMaybeListChanged(session);
      } catch (error) {
        // The fanout is already committed and applied. A best-effort freshness
        // hint must never turn that delivery into a retry/failure loop.
        this.metric({
          kind: "net_mcp_list_changed_refresh_failed",
          scope: body.scope,
          status: "error",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  /** Resolve a paged discovery request against structural MCP context. The
   * scope vocabulary changes presentation only; it never grants reachability. */
  private mcpToolPage(actor: string, session: string, args: Record<string, unknown>): NetMcpToolPage {
    const scope = mcpToolScope(args.scope);
    const object = typeof args.object === "string" && args.object ? args.object : null;
    const query = typeof args.query === "string" && args.query.trim() ? args.query.trim() : null;
    const limit = mcpLimit(args.limit, MCP_DISCOVERY_DEFAULT_PAGE, MCP_DISCOVERY_MAX_PAGE);
    const cursor = mcpCursor(args.cursor);
    const context = this.mcpContextObjects(actor, session);
    let selected = context;
    let commandObjects = this.mcpActiveCommandContext(actor, session);

    if (scope === "here") {
      selected = new Set();
      commandObjects = new Set();
      const active = this.mcpActiveScope(actor, session);
      if (active) {
        selected.add(active);
        commandObjects.add(active);
        for (const id of this.mcpContentsContext(active, actor)) {
          selected.add(id);
          commandObjects.add(id);
        }
      }
    } else if (scope === "object") {
      selected = new Set();
      if (object && context.has(object)) selected.add(object);
      commandObjects = new Set(object && commandObjects.has(object) ? [object] : []);
    } else if (scope === "space") {
      selected = new Set();
      commandObjects = new Set();
      const active = this.mcpActiveScope(actor, session);
      const target = object ?? active;
      if (target && context.has(target)) {
        selected.add(target);
        commandObjects.add(target);
        for (const id of this.mcpContentsContext(target, actor)) {
          selected.add(id);
          commandObjects.add(id);
        }
      }
    }

    const normalized = query?.toLowerCase() ?? "";
    const all = this.mcpToolsForObjects(actor, selected, commandObjects).filter((tool) =>
      !normalized || tool.name.toLowerCase().includes(normalized) ||
      tool.object.toLowerCase().includes(normalized) ||
      tool.verb.toLowerCase().includes(normalized) ||
      tool.description.toLowerCase().includes(normalized) ||
      tool.aliases.some((alias) => alias.toLowerCase().includes(normalized))
    );
    const tools = all.slice(cursor, cursor + limit);
    const next = cursor + tools.length;
    return {
      scope,
      object,
      query,
      limit,
      cursor: args.cursor === undefined ? null : String(cursor),
      nextCursor: next < all.length ? String(next) : null,
      total: all.length,
      tools
    };
  }

  /** The exact dynamic set advertised by standard tools/list and accepted by
   * both dynamic-name calls and woo_call. Keep this one resolver authoritative. */
  private mcpContextTools(actor: string, session: string): NetMcpDynamicTool[] {
    return this.mcpToolsForObjects(
      actor,
      this.mcpContextObjects(actor, session),
      this.mcpActiveCommandContext(actor, session)
    );
  }

  /** The active command surface and its visible contents receive
   * command-shaped "obvious" affordances. Self and inventory require
   * explicit tool exposure. */
  private mcpActiveCommandContext(actor: string, session: string): Set<string> {
    const active = this.mcpActiveScope(actor, session);
    if (!active) return new Set();
    const out = this.mcpContentsContext(active, actor);
    out.add(active);
    return out;
  }

  private mcpContextObjects(actor: string, session: string): Set<string> {
    const out = new Set<string>();
    out.add(actor);
    const active = this.mcpActiveScope(actor, session);
    if (active) {
      out.add(active);
      for (const id of this.mcpContentsContext(active, actor)) out.add(id);
    }
    // Inventory is ordinary structural context and follows the actor across
    // spaces. Do not recursively expand inventory containers.
    for (const row of this.relationMembers("contents", actor)) out.add(row.member);
    return out;
  }

  /** Complete the cells behind structural context without enumerating a
   * scope. Relation rows carry each member's immutable authority scope; aged
   * rows without the additive hint fall back to the relation owner's scope,
   * which is exact for ordinary room fixtures and actor-owned inventory.
   *
   * The cap is shared with room-presentation hydration. Unresolved rows are
   * memoized with exponential backoff, so a dangling member costs bounded
   * probes rather than one retry per model tools/list call. */
  private async warmMcpContext(actor: string, session: string): Promise<void> {
    const active = this.mcpActiveScope(actor, session);
    const candidates: Array<{ object: string; scope: string }> = [];
    const addRows = (rows: ReturnType<NetGatewayDO["relationMembers"]>, fallbackScope: string): void => {
      for (const row of rows) {
        if (candidates.length >= MAX_ROOM_CONTENT_AUTHORITY_OBJECTS) break;
        const scope = row.member_scope ?? fallbackScope;
        if (this.mcpContextWarmSuccesses.has(`${scope}\0${row.member}`)) continue;
        candidates.push({ object: row.member, scope });
      }
    };
    if (active) addRows(this.relationMembers("contents", active), this.ownerScopeFor(active));
    addRows(this.relationMembers("contents", actor), this.ownerScopeFor(actor));
    if (candidates.length === 0) return;

    const now = this.host.now();
    const byScope = new Map<string, Set<string>>();
    for (const candidate of candidates) {
      const key = `${candidate.scope}\0${candidate.object}`;
      const failure = this.mcpContextWarmFailures.get(key);
      if (failure && failure.retryAt > now) continue;
      const objects = byScope.get(candidate.scope) ?? new Set<string>();
      objects.add(candidate.object);
      byScope.set(candidate.scope, objects);
    }
    if (byScope.size === 0) return;
    const pulledScopes = new Set<string>();
    for (const [scope, objects] of byScope) {
      try {
        // Do not use warmScopes here: its general sparse-planning fast path
        // deliberately skips objects whose lineage is present, while MCP
        // needs the full per-object verb surface at least once.
        await this.pullTargeted(scope, `scope:${scope}`, [...objects]);
        pulledScopes.add(scope);
      } catch (err) {
        this.metric({ kind: "net_mcp_context_warm_failed", scope, status: "error", error: String(err) });
      }
    }

    for (const [scope, objects] of byScope) {
      for (const object of objects) {
        const key = `${scope}\0${object}`;
        if (pulledScopes.has(scope) && this.ensureView().has(cellKey("object_lineage", object))) {
          this.mcpContextWarmFailures.delete(key);
          this.mcpContextWarmSuccesses.delete(key);
          this.mcpContextWarmSuccesses.add(key);
          continue;
        }
        const attempts = Math.min((this.mcpContextWarmFailures.get(key)?.attempts ?? 0) + 1, 8);
        const retryAt = now + Math.min(30_000, 250 * (2 ** (attempts - 1)));
        this.mcpContextWarmFailures.set(key, { attempts, retryAt });
      }
    }
    while (this.mcpContextWarmFailures.size > MCP_CONTEXT_WARM_FAILURE_CAP) {
      const oldest = this.mcpContextWarmFailures.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.mcpContextWarmFailures.delete(oldest);
    }
    while (this.mcpContextWarmSuccesses.size > MCP_CONTEXT_WARM_SUCCESS_CAP) {
      const oldest = this.mcpContextWarmSuccesses.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.mcpContextWarmSuccesses.delete(oldest);
    }
  }

  private mcpActiveScope(actor: string, session: string): string | null {
    const view = this.ensureView();
    const row = view.get(sessionCellKey(session))?.value as { activeScope?: unknown; active_scope?: unknown } | undefined;
    const scoped = typeof row?.activeScope === "string" ? row.activeScope : typeof row?.active_scope === "string" ? row.active_scope : null;
    if (scoped) return scoped;
    const live = view.get(cellKey("object_live", actor))?.value as { location?: unknown } | undefined;
    return typeof live?.location === "string" && live.location ? live.location : null;
  }

  /** Contents normally expose their full explicit tool surface. A different
   * live presence actor is social context, not an invocation target, so its
   * object surface is omitted; interaction still goes through the room's
   * say/tell verbs. `host_placement:self` is the
   * generic structural marker for an appliance/workspace that owns a session;
   * those objects retain their normal tool projection. */
  private mcpContentsContext(space: string, actor: string): Set<string> {
    const out = new Set<string>();
    const presenceActors = new Set(
      this.clientRelationMembers(SESSION_PRESENCE_RELATION, space)
        .map((row) => row.member)
        .filter((value): value is string => typeof value === "string")
    );
    for (const row of this.relationMembers("contents", space)) {
      const member = row.member;
      // Self is already the explicit actor category; do not reclassify it as
      // a visible-content object and accidentally broaden its tool surface.
      if (member === actor) continue;
      const placement = this.ensureView().get(cellKey("property_cell", member, "host_placement"))?.value as { value?: unknown } | undefined;
      const activeActorSession = this.ensureView().sessionCellsForActor(member).some((cell) => {
        const value = cell.value as { activeScope?: unknown; active_scope?: unknown };
        return value.activeScope === space || value.active_scope === space;
      });
      // Topology already distinguishes an actor cluster from a self-hosted
      // appliance: both are cluster roots, but only the latter declares the
      // generic host-placement marker. This also excludes offline players,
      // which have no session_presence row but must not become maintenance
      // tool targets merely because their body remains in the room.
      const authorityScope = row.member_scope ?? this.ownerScopeFor(member);
      const actorClusterRoot = authorityScope === `cluster:${member}`;
      const otherActor = member !== actor
        && (presenceActors.has(member) || activeActorSession || actorClusterRoot)
        && placement?.value !== "self";
      if (!otherActor) out.add(member);
    }
    return out;
  }

  private mcpToolsForObjects(
    actor: string,
    objects: Set<string>,
    commandObjects: Set<string>
  ): NetMcpDynamicTool[] {
    const drafts: NetMcpToolDraft[] = [];
    for (const object of [...objects].sort((a, b) => a.localeCompare(b))) {
      drafts.push(...this.mcpObjectToolDrafts(actor, object, commandObjects.has(object)));
    }
    drafts.sort((a, b) => a.object.localeCompare(b.object) || a.verb.localeCompare(b.verb));
    const used = new Set<string>();
    return drafts.map((draft) => {
      const base = `${mcpSanitizeId(draft.object)}__${mcpSanitizeId(draft.verb)}`;
      let name = base;
      let suffix = 2;
      while (used.has(name)) name = `${base}_${suffix++}`;
      used.add(name);
      return { ...draft, name };
    });
  }

  private mcpObjectToolDrafts(actor: string, object: string, allowCommandShaped: boolean): NetMcpToolDraft[] {
    const view = this.ensureView();
    const out: NetMcpToolDraft[] = [];
    const seenVerbs = new Set<string>();
    const chains: string[] = [object];
    const features = view.get(cellKey("property_cell", object, "features"))?.value as { value?: unknown } | undefined;
    if (Array.isArray(features?.value)) {
      for (const feature of features.value) if (typeof feature === "string") chains.push(feature);
    }
    const actorLineage = view.get(cellKey("object_lineage", actor))?.value as { flags?: { wizard?: boolean } } | undefined;
    const wizard = actorLineage?.flags?.wizard === true;

    for (const start of chains) {
      let current: string | null = start;
      const walked = new Set<string>();
      while (current && !walked.has(current)) {
        walked.add(current);
        const pages = view.cellsForObject(current)
          .filter((cell) => cell.kind === "verb_bytecode" && typeof cell.name === "string")
          .sort((a, b) => String(a.name).localeCompare(String(b.name)));
        for (const cell of pages) {
          const verb = cell.name as string;
          if (seenVerbs.has(verb)) continue;
          seenVerbs.add(verb); // an override hides every inherited page, exposed or not
          const page = cell.value as Record<string, unknown>;
          if (page.kind !== "bytecode") continue;
          const argSpec = mcpRecord(page.arg_spec);
          const command = mcpRecord(argSpec.command);
          const commandShaped = Object.keys(command).length > 0;
          const exposed = page.tool_exposed === true || (allowCommandShaped && commandShaped);
          if (!exposed) continue;
          const perms = typeof page.perms === "string" ? page.perms : "";
          const owner = typeof page.owner === "string" ? page.owner : "";
          if (!wizard && owner !== actor && !perms.includes("x")) continue;
          const aliases = Array.isArray(page.aliases) ? page.aliases.filter((value): value is string => typeof value === "string") : [];
          const source = typeof page.source === "string" ? page.source : "";
          const input = mcpInputSchema(argSpec);
          const callForm = `${object}:${verb}(${input.args.join(", ")})`;
          const paragraph = mcpFirstParagraph(source);
          out.push({
            object,
            verb,
            aliases,
            description: paragraph ? `${paragraph}\n\nCall: ${callForm}` : `Call: ${callForm}`,
            inputSchema: input.schema,
            argNames: input.args
          });
        }
        const lineage = view.get(cellKey("object_lineage", current))?.value as { parent?: unknown } | undefined;
        current = typeof lineage?.parent === "string" ? lineage.parent : null;
      }
    }
    return out;
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
    await this.warmScopes(
      [CATALOG_SCOPE, { scope: `cluster:${actor}`, objects: [actor] }],
      "net_client_pull_miss_failed"
    );
    const verdict = validateSessionCell(this.ensureView().get(sessionCellKey(session)), this.host.now(), actor);
    if (verdict !== "ok") {
      return json({ error: { code: "E_NOSESSION", message: `session ${verdict}`, detail: { session_verdict: verdict } } }, 401);
    }
    const now = this.host.now();
    // Reap expired tickets on mint — bounded cleanup, no separate reaper.
    this.state.storage.sql.exec("DELETE FROM net_gateway_ws_ticket WHERE expires_at <= ?", now);
    const ticket = ticketIdWithShardHint(this.shardName(), randomHex(24));
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
    await this.warmScopes(
      [CATALOG_SCOPE, { scope: `cluster:${actor}`, objects: [actor] }],
      "net_client_pull_miss_failed"
    );
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
   *   {type:"observations", scope, seq, echo_id?, observations} frame. Sessions on
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
    // No WS surface (structural fakes / MCP-only runtimes) still feeds
    // the MCP wait queues — delivery has two carriers, one audience.
    const getSockets = this.state.getWebSockets?.bind(this.state);
    if (!Array.isArray(body.observations) || body.observations.length === 0) return;
    // Phase 2: filter by the materialized owner_scope (indexed) so the scan
    // is O(occupants of body.scope), NOT O(all mirrored sessions). The
    // owner→scope classification happened once at write time (ownerScopeFor).
    // NC8a: member + body in ONE query — the previous per-member body
    // re-read was an N+1 that scaled fanout SQL with audience size.
    const rows = sqlRows<{ member: string; body: string | null }>(
      this.state.storage.sql.exec(
        "SELECT member, body FROM net_gateway_relation WHERE relation = ? AND owner_scope = ?",
        SESSION_PRESENCE_RELATION,
        body.scope
      )
    );
    // Load-gate evidence (CO10): rows scanned must track occupants, flat as
    // total off-scope sessions grow.
    this.metric({ kind: "net_presence_scan", scope: body.scope, presence_scan_rows: rows.length });
    if (rows.length === 0) return;
    // Session -> actor for the directed-observation filter below: the
    // presence row body carries the session's actor (CO13 applier).
    const actorOf = new Map<string, string | null>();
    for (const row of rows) {
      const parsed = row.body ? (JSON.parse(row.body) as { actor?: string }) : null;
      actorOf.set(row.member, typeof parsed?.actor === "string" ? parsed.actor : null);
    }
    // NC8a fanout-cost evidence: audience size and frames actually sent —
    // the "fanout cost as audience grows" dashboard series.
    let deliveredMembers = 0;
    let framesSent = 0;
    for (const row of rows) {
      if (
        body.submitter_turn_id !== undefined
        && this.recentClientTurns.get(body.submitter_turn_id) === row.member
      ) continue;
      // MCP has no client-side observation-frame carrier on which to apply
      // NetFeed's echo digest. Keep an independent per-session bounded guard
      // so eviction of the shard-wide bandwidth LRU cannot duplicate the
      // submitter's own turn into its later woo_wait response.
      if (
        body.echo_id !== undefined
        && this.mcpQueues.get(row.member)?.ownEchoIds.has(body.echo_id)
      ) continue;
      // v2 audience parity (client-shell phase i): a `to:`-directed
      // observation (looked/who — private views) reaches ONLY the session
      // whose actor it names; everything else is the room broadcast. The
      // engine's full audience model stays server-side — this filter only
      // honors the explicit direction the observation itself carries.
      const actor = actorOf.get(row.member) ?? null;
      const visible = (body.observations as Array<Record<string, unknown>>).filter(
        (obs) => typeof obs?.to !== "string" || obs.to === actor
      );
      if (visible.length === 0) continue;
      deliveredMembers += 1;
      // MCP wait queues ride the SAME audience + submitter dedupe as the
      // sockets (client-shell phase i).
      this.mcpEnqueue(row.member, visible);
      const frame = JSON.stringify({
        type: "observations",
        scope: body.scope,
        seq: body.seq,
        // SECURITY: never expose submitter_turn_id here. It is the scope's
        // idempotent-reply replay credential. echo_id is a one-way digest.
        ...(body.echo_id !== undefined ? { echo_id: body.echo_id } : {}),
        observations: visible
      });
      for (const ws of getSockets ? getSockets(row.member) : []) {
        try {
          ws.send(frame);
          framesSent += 1;
        } catch {
          // Dead socket: the runtime's close/error callback owns cleanup.
        }
      }
    }
    this.metric({
      kind: "net_push",
      scope: body.scope,
      seq: body.seq,
      audience: rows.length,
      delivered_members: deliveredMembers,
      frames: framesSent,
      observations: body.observations.length
    });
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
  /**
   * H1: subscribe THIS gateway to a scope's fanout so peer observation
   * push reaches its sockets — WITHOUT any external /net/subscribe call
   * (the lane doorway's manual subscribe, now retired for the client
   * shard). Idempotent server-side (`net_scope_subscribers` is
   * `ON CONFLICT DO NOTHING`); a no-op when `NET_GATEWAY_SELF` is unset
   * (internal /net/turn lane path and hand-wired unit fixtures).
   *
   * On the FIRST subscribe to a scope this lifetime a RELATION BACKFILL
   * follows: the scope's current relation rows (CO13) ride a TARGETED
   * closure (Phase 4 — no longer the full `["*"]` cell copy), so a
   * session subscribing AFTER peers are already present still sees their
   * presence rows in the mirror (a later commit's fanout carries only
   * ITS own deltas, never the standing roster — the backfill is what
   * carries it). Cells the session's turns need arrive targeted (the
   * warm paths) or by pull-on-miss; cold-open cost tracks the session,
   * not the scope. Best-effort: a failed subscribe/backfill is a named
   * metric, never a thrown turn error; the scope is dropped from the
   * memoized set so the next touch retries.
   *
   * Catalog is the bounded shared-substrate exception: its first
   * subscription is followed by a FULL pull. A gateway may already hold a
   * catalog high-water and stale verb page from before it subscribed; a
   * roster-only targeted closure would advance that high-water without
   * replacing the stale definition. Subscribe-then-pull closes both that
   * aged-shard case and the race with a definition repair committed just
   * before registration.
   */
  private async selfSubscribe(scope: string): Promise<void> {
    const shard = this.shardName();
    // Explicit override wins for fake harnesses and legacy one-shard
    // deployments whose DurableObjectId test label is not its route name.
    // Multi-shard deployments omit it and use the actual idFromName name.
    const self = this.env.NET_GATEWAY_SELF ?? (shard ? `gateway:${shard}` : undefined);
    if (!self || this.selfSubscribed.has(scope)) return;
    this.selfSubscribed.add(scope);
    try {
      await this.host.rpc(`scope:${scope}`, "/subscribe", { destination: self });
      if (scope === CATALOG_SCOPE) {
        await this.pull({ scope, destination: `scope:${scope}` });
      } else {
        await this.pullTargeted(scope, `scope:${scope}`, []);
      }
    } catch (err) {
      this.selfSubscribed.delete(scope);
      this.metric({ kind: "net_self_subscribe_failed", scope, status: "error", error: String(err) });
    }
  }

  /** Warm entries: a bare scope name means a FULL pull (reserved for the
   * catalog scope — the shared substrate the planner needs resident
   * wholesale, O(installed catalog) by design, never O(world)); an
   * `{scope, objects}` entry pulls targeted (Phase 4): the named
   * objects' chains plus the scope's relation roster, so a client
   * cold-open copies what the session needs, not the scope. */
  private async warmScopes(
    entries: Iterable<string | { scope: string; objects: string[] }>,
    metricKind: string
  ): Promise<void> {
    const view = this.ensureView(); // hydrates the `seen` high-water map alongside the view
    const visited = new Set<string>();
    for (const entry of entries) {
      const scope = typeof entry === "string" ? entry : entry.scope;
      if (visited.has(scope)) continue;
      visited.add(scope);
      try {
        if (typeof entry === "string") {
          // Subscription is independent of the cached fanout high-water: an
          // old gateway can have a catalog page without having registered for
          // later definition fanout. selfSubscribe performs the first full
          // catch-up after registration. When self-subscription is disabled
          // (the internal lane and hand-wired fixtures), the ordinary unseen
          // pull below still warms the catalog without doing a duplicate full
          // transfer on subscribed cold gateways.
          await this.selfSubscribe(scope);
          if (!this.seen.has(scope)) await this.pull({ scope, destination: `scope:${scope}` });
        } else {
          // Targeted: the guard is per OBJECT, not per scope — a scope
          // warmed for one object must still pull a LATER object's chain
          // (the high-water only proves the roster/backfill happened).
          // An object with lineage in view is materialized; any of its
          // still-missing cells are the repair loop's job.
          const missing = entry.objects.filter(
            (object) => object.length > 0 && !view.has(cellKey("object_lineage", object))
          );
          if (this.seen.has(scope) && missing.length === 0) continue;
          await this.pullTargeted(scope, `scope:${scope}`, missing);
        }
      } catch (err) {
        this.metric({ kind: metricKind, scope, status: "error", error: String(err) });
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
  /** The caller's session from `?session=` (or the bearer session when the
   * request authenticated by one — the door default), validated as a live
   * cell bound to the authenticated actor (B1: reads are presence-scoped,
   * so a valid session is the anchor). Throws ClientAuthError on a
   * missing/invalid/foreign session. */
  private readSession(url: URL, actor: string, bearerSession: string | null = null): string {
    const session = url.searchParams.get("session") || bearerSession || "";
    if (!session) {
      throw new ClientAuthError("reads require a session query param (B1: presence-scoped)", { reason: "session_required" });
    }
    const verdict = validateSessionCell(this.ensureView().get(sessionCellKey(session)), this.host.now(), actor);
    if (verdict !== "ok") {
      throw new ClientAuthError(`session ${verdict}`, { session_verdict: verdict });
    }
    return session;
  }

  /** Session-bearer authentication (client-auth.ts `session:` class): the
   * bearer's session cell must be live in this gateway's view — the MCP
   * adapter's mcp-session-id validation, generalized to the whole /net-api
   * surface. The named refusals mirror validateSessionCell's verdicts. */
  private actorForSessionBearer(session: string): string {
    const cell = this.ensureView().get(sessionCellKey(session));
    const verdict = validateSessionCell(cell, this.host.now());
    if (verdict !== "ok") {
      throw new ClientAuthError(`session ${verdict}`, { session_verdict: verdict, reason: "session_bearer_rejected" });
    }
    return (cell?.value as { actor?: string }).actor as string;
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
        "SELECT owner FROM net_gateway_relation WHERE relation = ? AND member = ?",
        SESSION_PRESENCE_RELATION,
        session
      )
    );
    for (const r of rows) scopes.add(r.owner);
    return scopes;
  }

  private denyProtectedCell(key: string): boolean {
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

  /**
   * Presence projections keyed by session contain bearer credentials even
   * when the property has a catalog-defined name. Authorization therefore
   * follows the property definition contract, never a bundled-name blacklist.
   */
  private isSessionKeyedPresenceCell(key: string): boolean {
    const cell = this.ensureView().get(key);
    if (cell?.kind !== "property_cell" || typeof cell.name !== "string") return false;
    let object: string | null = cell.object;
    const seen = new Set<string>();
    while (object && !seen.has(object)) {
      seen.add(object);
      const property = this.ensureView().get(cellKey("property_cell", object, cell.name));
      const value = property?.value;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const def = (value as { def?: unknown }).def;
        if (def && typeof def === "object" && !Array.isArray(def)) {
          const definition = def as {
            kind?: unknown;
            key?: unknown;
            presenceProjection?: unknown;
          };
          const rawPresence = definition.presenceProjection ?? definition;
          if (!rawPresence || typeof rawPresence !== "object" || Array.isArray(rawPresence)) return false;
          const presence = rawPresence as { kind?: unknown; key?: unknown };
          return presence.kind === "presence" && presence.key === "session";
        }
      }
      const lineage = this.ensureView().get(cellKey("object_lineage", object))?.value as
        | { parent?: unknown }
        | undefined;
      object = typeof lineage?.parent === "string" ? lineage.parent : null;
    }
    return false;
  }

  /** Authorize a cell read; throws ClientAuthError(403) on denial. */
  private authorizeCellRead(caller: string, session: string, key: string): void {
    if (this.denyProtectedCell(key) || this.isSessionKeyedPresenceCell(key)) {
      throw new ClientAuthError("cell not readable", { key }, "E_PERM", 403);
    }
    const parts = key.split(":");
    const kind = parts[0];
    const object = parts[1] ?? "";
    // Own identity is always readable: the caller's actor cells + its own
    // session cell.
    if (object === caller) return;
    if (kind === "session" && object === session) return;
    // SECURITY (session bearer-token leak, P0 defense-in-depth): a session id
    // IS a bearer credential. A session cell is readable ONLY by its own
    // session (handled just above) — NEVER via the co-presence path below.
    // Refuse any other session-cell read explicitly rather than relying on
    // the co-presence checks happening to fail for a session id.
    if (kind === "session") {
      throw new ClientAuthError("session cells are readable only by their owner", { key }, "E_PERM", 403);
    }
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

  private relationMembers(relation: string, owner: string): Array<{ member: string; member_scope?: string; body?: unknown }> {
    return sqlRows<{ member: string; member_scope: string | null; body: string | null }>(
      this.state.storage.sql.exec(
        "SELECT member, member_scope, body FROM net_gateway_relation WHERE relation = ? AND owner = ? ORDER BY member ASC",
        relation,
        owner
      )
    ).map((row) => ({
      member: row.member,
      ...(row.member_scope !== null ? { member_scope: row.member_scope } : {}),
      ...(row.body !== null ? { body: JSON.parse(row.body) as unknown } : {})
    }));
  }

  /**
   * SECURITY (session bearer-token leak, P0): the CLIENT-facing view of a
   * relation's members. A net session id IS the bearer credential
   * (`Authorization: Bearer session:<id>`), so it must NEVER reach any
   * actor other than that session's owner.
   *
   * The `session_presence` relation stores `member = <session id>` and
   * `body.session = <the session cell value>` — structurally required
   * server-side (roomRosterRows derives liveness from the cell;
   * pushObservations routes by it), but both are credentials. Serving the
   * raw `relationMembers` rows to a co-present peer therefore enumerates
   * every occupant's bearer token, and a leaked token authenticates as the
   * victim (account takeover).
   *
   * So presence is projected here to actor-level roster rows
   * (RoomRosterRow: player + name + presence + timings) with the session
   * id and cell stripped entirely. A caller learns WHO is present (the
   * same actor-level fact `who` already discloses), never HOW to
   * impersonate them. Every other relation names plain object ids as
   * members (contents, …) and passes through unchanged.
   */
  private clientRelationMembers(relation: string, owner: string): Array<{ member: string; body?: unknown }> {
    if (relation !== SESSION_PRESENCE_RELATION) {
      // `member_scope` is internal routing metadata, not part of the public
      // relation shape. Do not accidentally grow the client surface.
      return this.relationMembers(relation, owner).map((row) => ({
        member: row.member,
        ...(row.body !== undefined ? { body: row.body } : {})
      }));
    }
    const rows: RelationRow[] = sqlRows<{ member: string; body: string | null }>(
      this.state.storage.sql.exec(
        "SELECT member, body FROM net_gateway_relation WHERE relation = ? AND owner = ?",
        SESSION_PRESENCE_RELATION,
        owner
      )
    ).map((row) => ({
      relation: SESSION_PRESENCE_RELATION,
      owner,
      member: row.member,
      ...(row.body !== null ? { body: JSON.parse(row.body) as unknown } : {})
    }));
    // roomRosterRows consumes the (server-side) session cell in each body
    // for liveness/dedup and emits RoomRosterRow, which carries no session
    // id or cell. Member becomes the ACTOR id — the client-safe identity.
    const roster = roomRosterRows(rows, owner, this.roomDisplayName(owner), this.host.now());
    return roster.map((row) => ({ member: row.player, body: row }));
  }

  /** A room's cosmetic display name from the view (lineage, then a name
   * property), falling back to the object id. Used only to populate the
   * non-sensitive `location_name` of a client roster row. */
  private roomDisplayName(owner: string): string {
    const lineage = this.ensureView().get(cellKey("object_lineage", owner))?.value as { name?: unknown } | undefined;
    if (typeof lineage?.name === "string" && lineage.name) return lineage.name;
    const prop = this.ensureView().get(cellKey("property_cell", owner, "name"))?.value as { value?: unknown } | undefined;
    if (typeof prop?.value === "string" && prop.value) return prop.value;
    return owner;
  }

  /** Fetch one compact roster directly from the room authority. This is a
   * read barrier against asynchronous relation fanout: a gateway mirror may
   * be coherent at an older owner head immediately after concurrent enters,
   * but a roster-reading turn must not answer from that partial snapshot. */
  private async roomRosterProjection(
    request: TurnRequest,
    view: CellStore,
    classifier: ScopeClassifier,
    structure: TurnStructure,
    knownPresenceActors: Set<string>
  ): Promise<{ room: string; rows: readonly RoomRosterRow[] } | undefined> {
    const call = request.call;
    if (!this.callReadsRoomPresence(view, call)) return undefined;
    const session = typeof call.session === "string" ? view.get(cellKey("session", call.session)) : undefined;
    const activeScope = (session?.value as { activeScope?: unknown } | undefined)?.activeScope;
    const actorLive = view.get(cellKey("object_live", call.actor));
    const actorLocation = (actorLive?.value as { location?: unknown } | undefined)?.location;
    // Room verbs read the receiver's roster (enter must return the destination
    // roster); actor verbs such as who_all read the caller's active room. Use
    // topology rather than catalog names so this remains a generic substrate
    // rule for any shared scope supplied by an installed catalog.
    const targetScope = classifier.scopeOf(call.target);
    const receiverRoom = classifier.isShared(targetScope) ? call.target : null;
    const room = receiverRoom
      ?? (typeof activeScope === "string" && activeScope
        ? activeScope
        : typeof actorLocation === "string" && actorLocation
          ? actorLocation
          : null);
    if (!room) return undefined;
    const scope = classifier.scopeOf(room);
    const response = await structure.rpc(() => this.host.rpc(
      this.destinationFor(request, scope),
      "/room-roster",
      { room }
    ), { phase: "room_roster" }) as { room?: unknown; rows?: unknown };
    if (response.room !== room || !Array.isArray(response.rows)) {
      throw new Error(`room-roster authority returned malformed projection for ${room}`);
    }
    const rows = response.rows as RoomRosterRow[];
    await this.warmRoomPresentationContents(request, room, scope, rows, classifier, structure, knownPresenceActors);
    return { room, rows };
  }

  /** Materialize direct non-presence room members needed by presentation verbs.
   *
   * A targeted room closure deliberately carries only local member stubs. A
   * nested space (`room:<id>`) or self-hosted actor/block (`cluster:<id>`) is
   * therefore only a relation ref on a cold gateway. `visible_contents()`
   * cannot distinguish that sparse ref from a recycled object and omits it;
   * the catalog's defensive dangling-member catches then turn the omission
   * into a successful but incomplete `look`.
   *
   * `reads_room_presence` is the catalog declaration for the complete room
   * presentation path. Use its already-fetched compact roster to exclude live
   * actors, then probe the two topology naming conventions in parallel phases.
   * A cluster root without the substrate's `host_placement: "self"` marker is
   * another presence actor, not a room card; this generic structural marker
   * avoids teaching the gateway any catalog class name. The first successful
   * component/space closure installs the whole object and class/anchor chain.
   * Warm gateways pay zero RPCs because lineage remains in the derived view;
   * genuinely dangling refs remain absent and catalogs may skip them safely. */
  private async warmRoomPresentationContents(
    request: TurnRequest,
    room: string,
    roomScope: string,
    roster: readonly RoomRosterRow[],
    classifier: ScopeClassifier,
    structure: TurnStructure,
    knownPresenceActors: Set<string>
  ): Promise<void> {
    const liveActors = new Set(roster.map((row) => row.player));
    const direct = this.relationMembers("contents", room)
      .slice(0, MAX_ROOM_CONTENT_AUTHORITY_OBJECTS)
      .map((row) => row.member)
      .filter((member) => !liveActors.has(member) && !knownPresenceActors.has(member));
    let missing = direct.filter((member) => !this.ensureView().has(cellKey("object_lineage", member)));
    if (missing.length === 0) return;

    // The targeted entry closure intentionally seeded room-owned objects as
    // lineage stubs. Fill those known-local direct members in one owner RPC
    // while this is demonstrably a cold presentation. Besides completing
    // their cosmetic properties, this prevents the first plan from recording
    // stale stub versions and spending a second repair attempt.
    const localMembers = direct.filter((member) =>
      this.ensureView().has(cellKey("object_lineage", member)) && classifier.scopeOf(member) === roomScope
    );
    if (localMembers.length > 0) {
      const transfer = await structure.rpc(
        () => this.fetchTargeted(roomScope, this.destinationFor(request, roomScope), localMembers, false),
        { phase: "room_contents_local_owner" }
      );
      this.installTargeted(transfer, false);
    }

    let probes = 0;
    let classifiedPresenceActors = 0;
    const probe = async (scopeFor: (member: string) => string, phase: string): Promise<void> => {
      const candidates = missing.map((member) => ({ member, scope: scopeFor(member) }))
        .filter(({ scope }) => scope !== roomScope);
      const transfers = await structure.rpcGroup(
        candidates.map(({ member, scope }) => async () => {
          try {
            return await this.fetchTargeted(scope, this.destinationFor(request, scope), [member], false);
          } catch (error) {
            if (isAbsentScopeProbe(error)) return null;
            throw error;
          }
        }),
        { phase }
      );
      probes += candidates.length;
      for (let index = 0; index < transfers.length; index += 1) {
        const transfer = transfers[index];
        if (!transfer) continue;
        const member = candidates[index]!.member;
        // A populated convention scope can outlive a recycled object. Treat
        // that as a miss so a later owner convention still gets a chance;
        // property absence alone is not evidence that this object is an actor.
        if (!transfer.cells.some((cell) => cell.kind === "object_lineage" && cell.object === member)) continue;
        // A successful cluster:<member> probe identifies an actor-rooted
        // object. Self-hosted components are explicitly stamped by the
        // substrate installer and do render as room cards; an unstamped root
        // is an offline presence actor already represented by the roster when
        // live. Retain only that classification, avoiding one attestation per
        // offline seat and any catalog-specific class test in the gateway.
        if (phase === "room_contents_cluster_owner" && this.transferObjectProperty(transfer, member, "host_placement") !== "self") {
          knownPresenceActors.add(member);
          this.rememberRoomPresentationActor(member);
          classifiedPresenceActors += 1;
          continue;
        }
        this.installTargeted(transfer, false);
      }
      missing = missing.filter((member) => !this.ensureView().has(cellKey("object_lineage", member)));
      missing = missing.filter((member) => !knownPresenceActors.has(member));
    };

    // Actor-like objects (including the ordinarily numerous offline presence
    // seats and self-hosted blocks) are rooted at cluster:<id>; nested spaces
    // are self-sequenced at room:<id>. Probe clusters first so classification
    // removes offline actors before the smaller space-owner phase. A
    // room-owned ordinary item was already included as a stub by the target
    // room closure and is not in `missing`.
    await probe((member) => `cluster:${member}`, "room_contents_cluster_owner");
    if (missing.length > 0) await probe((member) => `room:${member}`, "room_contents_room_owner");

    this.metric({
      kind: "net_room_contents_warm",
      room,
      candidates: direct.length,
      probes,
      materialized: direct.length - missing.length - classifiedPresenceActors,
      presence_actors: classifiedPresenceActors,
      missing: missing.length,
      cap: MAX_ROOM_CONTENT_AUTHORITY_OBJECTS
    });
  }

  /** Read one structural instance property without installing the fetched
   * closure. `host_placement` is a substrate-owned routing marker stamped on
   * every self-hosted instance, so no inherited catalog default is needed. */
  private transferObjectProperty(transfer: CellTransfer, object: string, name: string): unknown {
    const cell = transfer.cells.find((candidate) =>
      candidate.kind === "property_cell" && candidate.object === object && candidate.key === cellKey("property_cell", object, name)
    );
    return (cell?.value as { value?: unknown } | undefined)?.value;
  }

  private rememberRoomPresentationActor(object: string): void {
    this.roomPresentationActors.delete(object);
    this.roomPresentationActors.set(object, true);
    while (this.roomPresentationActors.size > ROOM_PRESENTATION_ACTOR_CACHE_CAP) {
      const oldest = this.roomPresentationActors.keys().next().value;
      if (oldest === undefined) break;
      this.roomPresentationActors.delete(oldest);
    }
  }

  /** Classification depends on both object identity and the structural
   * self-hosting marker. Either page changing makes the memo stale. */
  private invalidateRoomPresentationActor(cell: Pick<Cell, "kind" | "object" | "name">): void {
    if (cell.kind === "object_lineage" || (cell.kind === "property_cell" && cell.name === "host_placement")) {
      this.roomPresentationActors.delete(cell.object);
    }
  }

  private invalidateRoomPresentationActorKey(key: string): void {
    if (key.startsWith("object_lineage:") || (key.startsWith("property_cell:") && key.endsWith(":host_placement"))) {
      this.roomPresentationActors.delete(objectOfCellKey(key));
    }
  }

  /** Fetch ONE bounded ordered-children projection from the container's scope
   * authority — the ordering analogue of `roomRosterProjection`. Computed
   * owner-side from write-time-sorted authored/relation indexes so a
   * listing/mutation reads sibling order as ONE value instead of dragging
   * every sibling's edge cell into the turn's read closure. The
   * root ordering (`parent === null`) resolves from the explicit container;
   * inferring it from the call target is wrong during cross-container hooks. */
  private async fetchOrderedChildren(
    request: TurnRequest,
    classifier: ScopeClassifier,
    structure: TurnStructure,
    ordering: OrderedProjectionKey
  ): Promise<OrderedChildrenProjection> {
    const { container, parent } = ordering;
    // The container owner holds the COMPLETE projection. A non-root parent can
    // retain an immutable anchor in another scope after a cross-container move;
    // routing by the parent would query that incomplete source index.
    const scope = classifier.scopeOf(container);
    const response = await structure.rpc(() => this.host.rpc(
      this.destinationFor(request, scope),
      "/ordered-children",
      { container, parent }
    ), { phase: "ordered_children" }) as { scope?: unknown; container?: unknown; parent?: unknown; rows?: unknown; version?: unknown };
    // Full reply validation (Adv-a): a wrong-scope echo or a versionless
    // reply must be a FAILED fetch (retried on the bounded attempt loop),
    // never an answer the plan attests.
    if (response.scope !== scope || response.container !== container || response.parent !== parent || !Array.isArray(response.rows)
      || typeof response.version !== "string" || response.version.length === 0) {
      throw new Error(`ordered-children authority returned a malformed projection for ${parent ?? "<root>"} at ${scope}`);
    }
    // The authority's content version of the ordering (P1.1): the plan attests
    // it so a concurrent same-parent insert makes the submit stale. The owning
    // scope rides along (R3) so cross-scope commits owner-attest the read.
    return { container, scope, parent, rows: response.rows as Record<string, unknown>[], version: response.version };
  }

  /** Answer ONE bounded neighbour query at the container's scope authority
   * (P2.4). The response is constant-size — two ranks, a count, and the
   * ordering's content version — so repairing a mutation's slot read under a
   * 10k-child parent costs the same bytes as under an empty one. Scope
   * resolution matches `fetchOrderedChildren`: a null parent names the
   * explicitly supplied container's roots. */
  private async fetchOrderedNeighbors(
    request: TurnRequest,
    classifier: ScopeClassifier,
    structure: TurnStructure,
    requested: OrderedNeighborsRequest
  ): Promise<OrderedNeighborsProjection> {
    const { container, query } = requested;
    const scope = classifier.scopeOf(container);
    const response = await structure.rpc(() => this.host.rpc(
      this.destinationFor(request, scope),
      "/ordered-neighbors",
      { container, parent: query.parent, index: query.index, exclude: query.exclude, child: query.child }
    ), { phase: "ordered_neighbors" }) as { scope?: unknown; container?: unknown; parent?: unknown; count?: unknown; index?: unknown; before?: unknown; after?: unknown; child_index?: unknown; version?: unknown };
    // Full reply validation (Adv-a): scope echo, a nonempty ordering version,
    // integral count/slot within range, rank fields consistent with the slot
    // (a slot with a live neighbour must carry its rank), and a sane
    // child_index. Anything else is a FAILED fetch — retried on the bounded
    // attempt loop — never an answer the plan computes a rank from.
    const count = response.count;
    const index = response.index;
    const malformed =
      response.scope !== scope
      || response.container !== container
      || response.parent !== query.parent
      || typeof response.version !== "string" || response.version.length === 0
      || typeof count !== "number" || !Number.isInteger(count) || count < 0
      || typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > count
      || (index > 0 ? typeof response.before !== "string" || response.before.length === 0 : response.before !== null)
      || (index < count ? typeof response.after !== "string" || response.after.length === 0 : response.after !== null)
      || (response.child_index !== null && (typeof response.child_index !== "number" || !Number.isInteger(response.child_index) || response.child_index < 0));
    if (malformed) {
      throw new Error(`ordered-neighbours authority returned a malformed answer for ${query.parent ?? "<root>"} at ${scope}`);
    }
    return {
      query,
      container,
      scope,
      value: {
        count,
        index,
        before: (response.before as string | null),
        after: (response.after as string | null),
        child_index: (response.child_index as number | null)
      },
      version: response.version as string
    };
  }

  /** Seed the call target's ordering into the per-turn projection map, once,
   * if the dispatched verb declares `reads_ordered_children`. This is the
   * bounded warm-path optimization: the common case (a verb whose parent IS
   * the target) needs no repair round. Further parents are filled on demand
   * by the ordered-children repair path in `turnAttempts`. */
  private async seedTargetOrderedChildren(
    request: TurnRequest,
    view: CellStore,
    classifier: ScopeClassifier,
    structure: TurnStructure,
    accumulated: Map<string, OrderedChildrenProjection>,
    trace: AttemptTraceEntry[]
  ): Promise<void> {
    const target = request.call.target;
    const key = orderedProjectionKey(target, target);
    if (accumulated.has(key) || !this.callReadsOrderedChildren(view, request.call)) return;
    // The pre-seed is a warm-path OPTIMIZATION, so its fetch failing must not
    // kill the turn (R2): skip it (recovery_error traced) and let the verb's
    // read miss into the repair path, which retries on the bounded attempt
    // loop and explains a persistent outage as E_BUDGET.
    const projection = await this.tryRecovery(trace, () => this.fetchOrderedChildren(request, classifier, structure, { container: target, parent: target }));
    if (projection !== undefined) accumulated.set(key, projection);
  }

  private async expediteForeignRelations(
    reply: Extract<CommitReply, { status: "accepted" }>,
    destinations: Record<string, { destination: string; objects: string[] }>,
    observations: readonly unknown[],
    turnId?: string,
    structure?: TurnStructure
  ): Promise<void> {
    for (const entry of reply.relations_foreign ?? []) {
      // Presence and ordered-container changes require the accepted-reply
      // freshness fence: after a move returns, peers must see the actor in the
      // room and the moved item in its destination ordering. Other foreign
      // projections retain the asynchronous durable path. If this owner batch
      // also contains contents deltas, send the whole batch:
      // receiver idempotency is per (from_scope, seq), not per relation row.
      if (!entry.deltas.some((delta) =>
        delta.row.relation === SESSION_PRESENCE_RELATION || delta.row.relation === ORDERED_EDGE_RELATION
      )) continue;
      const destination = destinations[entry.scope]?.destination ?? `scope:${entry.scope}`;
      const deliver = () => this.host.rpc(destination, "/relate", {
        from_scope: reply.scope,
        seq: reply.head.seq,
        deltas: entry.deltas,
        observations: observationsForRelationOwners(observations, entry.deltas),
        ...(turnId !== undefined
          ? { submitter_turn_id: turnId, echo_id: turnEchoId(turnId) }
          : {})
      });
      if (structure) await structure.rpc(deliver, { mandatory: true, phase: "presence_fence" });
      else await deliver();
    }
  }

  /** Resolve only enough verb metadata to read a boolean dispatch flag the
   * catalog declared on the target verb. Mirrors parent-first then
   * feature-chain dispatch without executing catalog code. */
  private callReadsVerbFlag(view: CellStore, call: ShadowTurnCall, flag: "reads_room_presence" | "reads_ordered_children"): boolean {
    const resolveChain = (start: string): boolean | null => {
      let object: string | null = start;
      const seen = new Set<string>();
      while (object && !seen.has(object)) {
        seen.add(object);
        for (const cell of view.cellsForObject(object)) {
          if (cell.kind !== "verb_bytecode") continue;
          const verb = cell.value as { name?: unknown; aliases?: unknown; [k: string]: unknown };
          const names = [verb.name, ...(Array.isArray(verb.aliases) ? verb.aliases : [])];
          if (names.includes(call.verb)) return verb[flag] === true;
        }
        const lineage = view.get(cellKey("object_lineage", object))?.value as { parent?: unknown } | undefined;
        object = typeof lineage?.parent === "string" ? lineage.parent : null;
      }
      return null;
    };
    const inherited = resolveChain(call.target);
    if (inherited !== null) return inherited;

    const featuresCell = view.get(cellKey("property_cell", call.target, "features"))?.value as { value?: unknown } | undefined;
    const features = Array.isArray(featuresCell?.value)
      ? featuresCell.value.filter((value): value is string => typeof value === "string")
      : [];
    for (const feature of features) {
      const resolved = resolveChain(feature);
      if (resolved !== null) return resolved;
    }
    return false;
  }

  /** Resolve the executable verb page in the same parent-first then feature-
   * chain order used by the projection metadata gates.  Metadata is catalog
   * data; callers interpret only generic fields. */
  private callVerbPage(view: CellStore, call: ShadowTurnCall): Record<string, unknown> | null {
    const resolveChain = (start: string): Record<string, unknown> | null => {
      let object: string | null = start;
      const seen = new Set<string>();
      while (object && !seen.has(object)) {
        seen.add(object);
        for (const cell of view.cellsForObject(object)) {
          if (cell.kind !== "verb_bytecode") continue;
          const verb = cell.value as Record<string, unknown>;
          const names = [verb.name, ...(Array.isArray(verb.aliases) ? verb.aliases : [])];
          if (names.includes(call.verb)) return verb;
        }
        const lineage = view.get(cellKey("object_lineage", object))?.value as { parent?: unknown } | undefined;
        object = typeof lineage?.parent === "string" ? lineage.parent : null;
      }
      return null;
    };
    const inherited = resolveChain(call.target);
    if (inherited) return inherited;
    const featuresCell = view.get(cellKey("property_cell", call.target, "features"))?.value as { value?: unknown } | undefined;
    const features = Array.isArray(featuresCell?.value)
      ? featuresCell.value.filter((value): value is string => typeof value === "string")
      : [];
    for (const feature of features) {
      const resolved = resolveChain(feature);
      if (resolved) return resolved;
    }
    return null;
  }

  /** CA14 deterministic owner prefetch for the deployed net client path.
   * The grammar deliberately matches the legacy gateway's generic
   * roots/path/first forms; no command word, room id, or catalog property is
   * embedded here. */
  private async warmDeclaredAuthorityPrefetch(call: ShadowTurnCall, planningScope: string): Promise<void> {
    const page = this.callVerbPage(this.ensureView(), call);
    const argSpec = page?.arg_spec;
    if (!argSpec || typeof argSpec !== "object" || Array.isArray(argSpec)) return;
    const authority = (argSpec as Record<string, unknown>).authority;
    if (!authority || typeof authority !== "object" || Array.isArray(authority)) return;
    const entries = (authority as Record<string, unknown>).prefetch;
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const resolved = await this.resolveNetAuthorityPrefetch(entry, call, planningScope);
      for (const object of resolved) await this.warmNetPrefetchObject(object, planningScope);
    }
  }

  private async resolveNetAuthorityPrefetch(
    value: unknown,
    call: ShadowTurnCall,
    planningScope: string
  ): Promise<string[]> {
    if (typeof value === "string") {
      const root = this.netAuthorityPrefetchRoot(value, call);
      return root ? [root] : [];
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const map = value as Record<string, unknown>;
    if (Array.isArray(map.first)) {
      for (const item of map.first) {
        const resolved = await this.resolveNetAuthorityPrefetch(item, call, planningScope);
        if (resolved.length > 0) return resolved;
      }
      return [];
    }
    if (!Array.isArray(map.path) || map.path.length === 0 || typeof map.path[0] !== "string") return [];
    let cursor: unknown = this.netAuthorityPrefetchRoot(map.path[0], call);
    for (const rawPart of map.path.slice(1)) {
      const part = this.netAuthorityPrefetchPathPart(rawPart, call);
      if (part === null) return [];
      if (typeof cursor === "string") {
        // Path traversal needs the explicit property page even when lineage
        // is already warm. An aged gateway may otherwise walk an inherited
        // default (for example `$room.exits = {}`) and mistake it for the
        // authoritative instance value forever.
        await this.refreshNetPrefetchPathCursor(cursor, part, planningScope);
        cursor = this.netObjectProperty(cursor, part);
      } else if (cursor && typeof cursor === "object" && !Array.isArray(cursor)) {
        cursor = (cursor as Record<string, unknown>)[part];
      } else {
        return [];
      }
    }
    return this.netAuthorityPrefetchRefs(cursor);
  }

  /** Collect object refs named by a terminal prefetch value. Maps represent
   * keyed structural indexes such as a room's exits, so only VALUES are
   * refs; keys are labels. The fixed cap prevents catalog metadata from
   * amplifying one turn into unbounded owner probes. */
  private netAuthorityPrefetchRefs(value: unknown, limit = 128): string[] {
    const refs = new Set<string>();
    const visit = (candidate: unknown): void => {
      if (refs.size >= limit) return;
      if (typeof candidate === "string") {
        if (candidate.length > 0) refs.add(candidate);
        return;
      }
      if (Array.isArray(candidate)) {
        for (const item of candidate) visit(item);
        return;
      }
      if (candidate && typeof candidate === "object") {
        for (const item of Object.values(candidate as Record<string, unknown>)) visit(item);
      }
    };
    visit(value);
    return [...refs];
  }

  /** Refresh a path cursor at the committing/planning owner even if its
   * lineage is cached. This is deliberately best-effort like the rest of
   * prefetch; a miss is named and normal E_MISSING_STATE repair takes over. */
  private async refreshNetPrefetchPathCursor(object: string, property: string, planningScope: string): Promise<void> {
    if (!object || object === "$nowhere") return;
    // An explicit instance page in the gateway view is kept coherent by the
    // normal scope fanout lane. Only absence is ambiguous with an inherited
    // default and requires an owner closure read. This keeps repeated command
    // and direction turns off the blocking cross-DO refresh path.
    if (this.ensureView().has(cellKey("property_cell", object, property))) return;
    // The planning owner is the common anchored-helper case. The derived
    // object owner covers roots such as `actor` whose property lives at its
    // cluster even while the turn itself commits in a room.
    const scopes = [...new Set([planningScope, this.ownerScopeFor(object)])];
    let pulled = false;
    for (const scope of scopes) {
      try {
        await this.pullTargeted(scope, `scope:${scope}`, [object]);
        pulled = true;
        // Stop once the authority supplied the instance page sought by this
        // path. This avoids probing a speculative classifier fallback after
        // the common planning-owner pull has already answered completely.
        if (this.ensureView().has(cellKey("property_cell", object, property))) return;
      } catch (err) {
        this.metric({ kind: "net_authority_prefetch_failed", scope, status: "error", error: String(err) });
      }
    }
    if (!pulled) await this.warmNetPrefetchObject(object, planningScope);
  }

  private netAuthorityPrefetchRoot(root: string, call: ShadowTurnCall): string | null {
    if (root === "scope") return call.scope;
    if (root === "target") return call.target;
    if (root === "actor") return call.actor;
    return null;
  }

  private netAuthorityPrefetchPathPart(raw: unknown, call: ShadowTurnCall): string | null {
    if (typeof raw === "string") return raw === "$verb" ? call.verb : raw;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const arg = (raw as { arg?: unknown }).arg;
    if (typeof arg !== "number" || !Number.isInteger(arg) || arg < 0) return null;
    const value = call.args[arg];
    return typeof value === "string" ? value.trim() : null;
  }

  /** Read an effective property from the derived view, walking inherited
   * defaults.  The property-cell payload's `value` slot is the only catalog
   * value exposed to the generic path interpreter. */
  private netObjectProperty(object: string, name: string): unknown {
    const view = this.ensureView();
    let current: string | null = object;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const payload = view.get(cellKey("property_cell", current, name))?.value as { value?: unknown } | undefined;
      if (payload && Object.prototype.hasOwnProperty.call(payload, "value")) return payload.value;
      const lineage = view.get(cellKey("object_lineage", current))?.value as { parent?: unknown } | undefined;
      current = typeof lineage?.parent === "string" ? lineage.parent : null;
    }
    return undefined;
  }

  /** Materialize one ref using topology-derived likely owners.  The current
   * planning scope is the strong first candidate for anchored helpers such as
   * exits; room/cluster naming conventions cover a terminal scope or actor.
   * Failed candidates are harmless closure misses and the normal repair loop
   * remains the correctness fallback. */
  private async warmNetPrefetchObject(object: string, planningScope: string): Promise<void> {
    if (!object || object === "$nowhere" || this.ensureView().has(cellKey("object_lineage", object))) return;
    for (const scope of [...new Set([planningScope, `room:${object}`, `cluster:${object}`])]) {
      await this.warmScopes([{ scope, objects: [object] }], "net_authority_prefetch_failed");
      if (this.ensureView().has(cellKey("object_lineage", object))) return;
    }
  }

  /** Whether the dispatched verb declared `reads_room_presence` (the gateway
   * then seeds the compact owner roster into planning). */
  private callReadsRoomPresence(view: CellStore, call: ShadowTurnCall): boolean {
    return this.callReadsVerbFlag(view, call, "reads_room_presence");
  }

  /** Whether the dispatched verb declared `reads_ordered_children` (the
   * gateway then seeds the ordered-children projection into planning). */
  private callReadsOrderedChildren(view: CellStore, call: ShadowTurnCall): boolean {
    return this.callReadsVerbFlag(view, call, "reads_ordered_children");
  }

  /** The scope pinned to an idempotency key, or null (fix 5c). */
  private pinnedScope(idempotencyKey: string): string | null {
    const rows = sqlRows<{ scope: string }>(
      this.state.storage.sql.exec("SELECT scope FROM net_gateway_pin WHERE idempotency_key = ?", idempotencyKey)
    );
    return rows.length > 0 ? rows[0].scope : null;
  }

  /** Persist the key → scope pin; first writer wins (fix 5c).
   *
   * H2c boundedness: the table keeps only the most recent
   * GATEWAY_PIN_LIMIT rows (rowid order — SQLite's insertion order),
   * pruned on insert. Consequence, documented (the reply-cache posture,
   * scope.ts pruneReplies): a replay arriving after its pin pruned may
   * re-plan to a different scope — but by the same retention window its
   * recorded reply at the original scope has pruned too, so the request
   * is a NEW turn by every observable measure: it validates fresh
   * against the current head and read versions. Idempotency is a
   * bounded-window guarantee, not an eternal one. */
  private pinScope(idempotencyKey: string, scope: string): void {
    this.state.storage.sql.exec(
      "INSERT INTO net_gateway_pin (idempotency_key, scope) VALUES (?, ?) ON CONFLICT(idempotency_key) DO NOTHING",
      idempotencyKey,
      scope
    );
    const count = sqlRows<{ n: number }>(this.state.storage.sql.exec("SELECT COUNT(*) AS n FROM net_gateway_pin"))[0];
    if (count && Number(count.n) > GATEWAY_PIN_LIMIT) {
      this.state.storage.sql.exec(
        "DELETE FROM net_gateway_pin WHERE rowid NOT IN (SELECT rowid FROM net_gateway_pin ORDER BY rowid DESC LIMIT ?)",
        GATEWAY_PIN_LIMIT
      );
    }
  }

  /**
   * Catalog ownership is broader than catalog-code immutability: it also
   * contains compatibility identities and any still-anchorless object. Cache
   * only cells whose OWN lineage carries the install-time immutable-definition
   * marker. Missing metadata fails safe to live owner attestation; class status
   * is never inferred from which children happen to be in this sparse view.
   */
  private epochImmutableCatalogKeys(request: TurnRequest, planned: PlanTurnResult, view: CellStore): Set<string> {
    const immutable = new Set<string>();
    for (const read of planned.transcript.reads) {
      if (!isEpochImmutableDefinition(view.get(cellKey("object_lineage", read.cell.object))?.value)) continue;
      const key = netCellKeyFor(read.cell);
      if (key === null) continue;
      // Class liveness/location is not dispatch metadata and sessions are
      // mutable authority. The epoch contract covers only these three class
      // definition cell families.
      if (
        key.startsWith("object_lineage:") ||
        key.startsWith("property_cell:") ||
        key.startsWith("verb_bytecode:")
      ) {
        // A copy from another epoch is never covered by this certificate.
        // It falls back to a live owner attestation below, so skew cannot be
        // laundered through a locally-derived version.
        if (view.get(key)?.stamp.catalog_epoch === request.catalog_epoch) immutable.add(key);
      }
    }
    return immutable;
  }

  /** CO15's active epoch is the authority certificate for installed class
   * definitions: these cells cannot change without an epoch-advancing install,
   * and their versions are content addresses. Build the CO2.3 proof from the
   * exact-epoch derived cells instead of sharing an I/O-backed promise between
   * concurrent DO invocations (which joins their Cloudflare request lineages). */
  private epochCatalogAttestation(
    request: TurnRequest,
    view: CellStore,
    keys: ReadonlySet<string>
  ): NonNullable<CommitSubmit["attestations"]>[string] {
    let ownerHead: ScopeHead | null = null;
    const cells = [...keys].sort().map((key) => {
      const cell = view.get(key);
      if (!cell || cell.stamp.catalog_epoch !== request.catalog_epoch) {
        throw netError("E_EPOCH_MISMATCH", "catalog definition cell is not stamped at the turn epoch", {
          key,
          turn_epoch: request.catalog_epoch,
          cell_epoch: cell?.stamp.catalog_epoch ?? null
        });
      }
      const separator = cell.stamp.scope_head.indexOf(":");
      const seq = Number(cell.stamp.scope_head.slice(0, separator));
      const hash = cell.stamp.scope_head.slice(separator + 1);
      if (separator < 1 || !Number.isSafeInteger(seq) || seq < 0 || !hash) {
        throw new Error(`catalog definition cell ${key} has malformed scope-head stamp`);
      }
      if (ownerHead === null || seq > ownerHead.seq) ownerHead = { seq, hash };
      else if (seq === ownerHead.seq && hash !== ownerHead.hash) {
        throw new Error(`catalog definition cells disagree at scope head ${seq}`);
      }
      return { key, version: cell.version };
    });
    if (ownerHead === null) throw new Error("catalog epoch attestation requires at least one cell");
    return { owner_head: ownerHead, cells };
  }

  /**
   * CO15's cache premise is also an authoring boundary: once an object is a
   * class in the installed catalog graph, ordinary turns cannot mutate its
   * lineage, property definitions/defaults, or bytecode under the same epoch.
   * Refuse before selection pinning or submission, including mixed turns whose
   * class write would otherwise ride along from a room commit.
   */
  private assertNoCatalogClassMutation(
    planned: PlanTurnResult,
    view: CellStore,
    classifier: ScopeClassifier
  ): void {
    const blockedWrites = new Map<string, string[]>();
    for (const write of planned.transcript.writes) {
      if (write.cell.kind !== "lifecycle" && write.cell.kind !== "prop" && write.cell.kind !== "verb") continue;
      if (classifier.scopeOf(write.cell.object) !== CATALOG_SCOPE) continue;
      const key = netCellKeyFor(write.cell);
      if (key === null) continue;
      const keys = blockedWrites.get(write.cell.object) ?? [];
      keys.push(key);
      blockedWrites.set(write.cell.object, keys);
    }
    const blocked = [...blockedWrites.keys()].sort();
    if (blocked.length === 0) return;
    throw netError(
      "E_CATALOG_MUTATION",
      "ordinary turns cannot mutate installed catalog class definitions",
      {
        objects: blocked,
        keys: blocked.flatMap((object) => blockedWrites.get(object) ?? []).sort()
      }
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
   * catalog sequencer like any other owner (CO15). Proven, exact-epoch class
   * definition cells are the one exception to owner IO: CO15 makes the active
   * epoch itself their authority certificate, and their versions are content
   * addresses. Catalog-owned identity, session, and compatibility-instance
   * cells stay live like every other mutable owner.
   */
  private async attestForeignReads(
    request: TurnRequest,
    classifier: ScopeClassifier,
    planned: PlanTurnResult,
    view: CellStore,
    targetScope: string,
    structure?: TurnStructure
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
    // R3: foreign ORDERING reads owner-attest exactly like foreign cell
    // reads — the same /net/attest reply reports the owner's CURRENT
    // ordering version per parent, so a foreign insert between plan and
    // attest makes the committing scope reject the stale read. An owner
    // with only ordering reads still gets its attest RPC.
    const orderingsByOwner = new Map<string, Map<string, { container: string; parent: string | null }>>();
    for (const read of planned.transcript.orderingReads ?? []) {
      if (read.scope === targetScope) continue; // validated locally
      const orderings = orderingsByOwner.get(read.scope) ?? new Map<string, { container: string; parent: string | null }>();
      orderings.set(orderedProjectionKey(read.container, read.parent), { container: read.container, parent: read.parent });
      orderingsByOwner.set(read.scope, orderings);
      if (!byOwner.has(read.scope)) byOwner.set(read.scope, new Set<string>());
    }
    if (byOwner.size === 0) return undefined;
    // NC8b: independent mutable owners attest in parallel. Immutable catalog
    // definitions add no RPC; their active-epoch certificate is folded below.
    const catalogKeys = byOwner.get(CATALOG_SCOPE);
    const immutableCatalogKeys = new Set<string>();
    if (catalogKeys) {
      const eligible = this.epochImmutableCatalogKeys(request, planned, view);
      for (const key of catalogKeys) {
        if (eligible.has(key)) immutableCatalogKeys.add(key);
      }
      const mutableCatalogKeys = new Set([...catalogKeys].filter((key) => !immutableCatalogKeys.has(key)));
      if (mutableCatalogKeys.size > 0) byOwner.set(CATALOG_SCOPE, mutableCatalogKeys);
      else byOwner.delete(CATALOG_SCOPE);
    }
    const owners = [...byOwner.entries()];
    const attest = async (owner: string, keys: Set<string>) => {
      const orderingParents = orderingsByOwner.get(owner);
      const reply = await this.host.rpc(this.destinationFor(request, owner), "/attest", {
        keys: [...keys].sort(),
        ...(orderingParents && orderingParents.size > 0
          ? { ordering_parents: [...orderingParents.values()].sort((a, b) => orderedProjectionKey(a.container, a.parent).localeCompare(orderedProjectionKey(b.container, b.parent))) }
          : {})
      }) as {
        catalog_epoch?: string;
        owner_head: ScopeHead;
        cells: Array<{ key: string; version: string }>;
        orderings?: Array<{ container: string; parent: string | null; version: string }>;
      };
      // Catalog compatibility cells are deliberately not cached, but their
      // authority must still agree with the turn epoch before its versions
      // can validate a read.
      if (owner === CATALOG_SCOPE && reply.catalog_epoch !== request.catalog_epoch) {
        throw netError("E_EPOCH_MISMATCH", "catalog attestation authority epoch differs from the turn epoch", {
          scope: CATALOG_SCOPE,
          turn_epoch: request.catalog_epoch,
          scope_epoch: reply.catalog_epoch ?? null
        });
      }
      const received = new Map<string, string>();
      for (const cell of reply.cells ?? []) {
        if (typeof cell?.key !== "string" || typeof cell.version !== "string") {
          throw new Error(`attestation from ${owner} returned a malformed cell version`);
        }
        received.set(cell.key, cell.version);
      }
      for (const key of keys) {
        if (!received.has(key)) throw new Error(`attestation from ${owner} omitted ${key}`);
      }
      if (orderingParents && orderingParents.size > 0) {
        const attestedParents = new Map<string, string>();
        for (const ordering of reply.orderings ?? []) {
          if (typeof ordering?.container !== "string" || !ordering.container
            || (ordering.parent !== null && typeof ordering.parent !== "string")
            || typeof ordering.version !== "string" || ordering.version.length === 0) {
            throw new Error(`attestation from ${owner} returned a malformed ordering version`);
          }
          attestedParents.set(orderedProjectionKey(ordering.container, ordering.parent), ordering.version);
        }
        for (const ordering of orderingParents.values()) {
          if (!attestedParents.has(orderedProjectionKey(ordering.container, ordering.parent))) {
            throw new Error(`attestation from ${owner} omitted ordering ${ordering.container}:${ordering.parent ?? "<root>"}`);
          }
        }
      }
      return reply;
    };
    const actions: Array<() => Promise<unknown>> = owners.map(([owner, keys]) => () => attest(owner, keys));
    const replies = structure
      ? await structure.rpcGroup(actions, { phase: "attest" })
      : await Promise.all(actions.map((action) => action()));
    const attestations: NonNullable<CommitSubmit["attestations"]> = {};
    owners.forEach(([owner], index) => {
      const reply = replies[index] as { owner_head: ScopeHead; cells: Array<{ key: string; version: string }>; orderings?: Array<{ container: string; parent: string | null; version: string }> };
      attestations[owner] = {
        owner_head: reply.owner_head,
        cells: reply.cells,
        ...(reply.orderings && reply.orderings.length > 0 ? { orderings: reply.orderings } : {})
      };
    });
    if (immutableCatalogKeys.size > 0) {
      const certified = this.epochCatalogAttestation(request, view, immutableCatalogKeys);
      const live = attestations[CATALOG_SCOPE];
      attestations[CATALOG_SCOPE] = live
        ? { owner_head: live.owner_head, cells: [...live.cells, ...certified.cells] }
        : certified;
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
  private async planOnce(
    request: TurnRequest,
    view: CellStore,
    classifier: ScopeClassifier,
    objectCounter?: number,
    planningRoomRoster?: { room: string; rows: readonly RoomRosterRow[] },
    seedObjects?: ReadonlySet<string>,
    planningOrderedChildren?: readonly OrderedChildrenProjection[],
    planningOrderedNeighbors?: readonly OrderedNeighborsProjection[]
  ): Promise<PlanTurnResult> {
    return planTurn({
      call: request.call,
      ...(request.principal ? { principal: request.principal } : {}),
      ...(request.trace ? { trace: request.trace } : {}),
      view,
      planningScope: request.planningScope,
      classifier,
      base: { seq: 0, hash: "provisional" },
      idempotencyKey: request.idempotency_key,
      stamp: { scope_head: "gateway", catalog_epoch: request.catalog_epoch },
      // Repaired objects ride into the seed slice so a re-plan keeps the
      // cells a prior round pulled (see PlanTurnInput.seedObjects).
      ...(seedObjects && seedObjects.size > 0 ? { seedObjects } : {}),
      // The callback form runs over the settled plan SLICE, not the whole
      // view — with slicePlanning below this keeps the entire warm turn
      // (snapshot clone, scratch, closure, catalog classification) at
      // O(read-set); load:net-dev asserts both plan_cells and
      // snapshot_cells stay flat as the view grows (blocker #1).
      receiverKnown: (planStore) => this.catalogKnownKeys(planStore, classifier),
      // Phase 1: the gateway turn path plans against the read-set SLICE
      // (built from the actor/session/target closure via the view's
      // object/session indexes, slice-cloned per attempt, grown on a
      // miss), so the planner world AND the fix-6 snapshot are
      // O(read-set), not O(view).
      slicePlanning: true,
      ...(planningRoomRoster ? { planningRoomRoster } : {}),
      ...(planningOrderedChildren && planningOrderedChildren.length > 0 ? { planningOrderedChildren } : {}),
      ...(planningOrderedNeighbors && planningOrderedNeighbors.length > 0 ? { planningOrderedNeighbors } : {}),
      // Creates over net (client-shell phase i): the planning-scope
      // authority's allocation floor, prefetched with its head, so a
      // planned create's id is fresh at the authority. A lane fixture's
      // explicit counters win (they built the world and know better).
      ...(request.counters !== undefined
        ? { counters: request.counters }
        : objectCounter !== undefined
          ? { counters: { objectCounter } }
          : {})
    });
  }

  /** The scope's /head reply, epoch included (Phase 5: the epoch was
   * previously discarded here — the one uniform place every turn path
   * already touches). */
  private async scopeHead(destination: string): Promise<{ head: ScopeHead; catalog_epoch?: string; object_counter?: number }> {
    return (await this.host.rpc(destination, "/head")) as { head: ScopeHead; catalog_epoch?: string };
  }

  /** Phase 5 fail-fast: a turn whose stamp disagrees with the scope's
   * DURABLE epoch can never commit — re-planning re-stamps the same
   * epoch — so surface the M9 terminal verdict at the head fetch instead
   * of grinding plan → submit → reseed rounds to E_BUDGET. Tolerates an
   * absent epoch field (a stubbed fixture head); such a turn still meets
   * the submit path's stale_epoch verdict and the M9 post-reseed check. */
  private assertTurnEpoch(
    live: { catalog_epoch?: string },
    turnEpoch: string,
    scope: string,
    trace: AttemptTraceEntry[]
  ): void {
    if (typeof live.catalog_epoch === "string" && live.catalog_epoch !== turnEpoch) {
      throw new NetError(
        "E_EPOCH_MISMATCH",
        "turn epoch disagrees with the scope's durable epoch at head fetch",
        { scope, turn_epoch: turnEpoch, scope_epoch: live.catalog_epoch },
        trace
      );
    }
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
  private async installTouched(view: CellStore, destination: string, touched: string[], structure?: TurnStructure): Promise<void> {
    // D2: on the SYNCHRONOUS reply path (post-accept), so it counts toward
    // the sync-RPC budget — but it is the happy-path warm fill, NOT an
    // authority reconstruction, so reconstructions stays 0 on a warm turn.
    // NC8b mandatory: the commit is already durable; a budget refusal here
    // would turn an accepted turn into an error.
    const transfer = (await timedRpc(
      structure,
      () => this.host.rpc(destination, "/closure", { keys: touched, known: [] }),
      { mandatory: true, phase: "install_touched" }
    )) as CellTransfer;
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

  /** A session bearer is unusable unless its minting gateway can authenticate
   * it. After an accepted exact-value session transcript, a failed closure
   * warm-fill may still install that one value as a derived accepted echo at
   * the returned authority head. This is CO2.1 cache fill, never a second
   * write path; all other touched cells remain repair-on-read. */
  private installAcceptedSessionEcho(
    session: string,
    value: unknown,
    reply: Extract<CommitReply, { status: "accepted" }>,
    catalogEpoch: string
  ): void {
    const view = this.ensureView();
    const cell = makeCell({
      kind: "session",
      object: session,
      value,
      provenance: "derived",
      stamp: {
        scope_head: `${reply.head.seq}:${reply.head.hash}`,
        catalog_epoch: catalogEpoch
      }
    });
    this.discardViewOnThrow(() => this.state.storage.transactionSync(() => {
      view.install(cell);
      this.persistCell(view, cell.key);
    }));
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
    keys: string[],
    structure?: TurnStructure
  ): Promise<void> {
    if (keys.length === 0) return;
    // D2: a targeted refresh IS an authority reconstruction (view rebuilt
    // from owner closures) — one per call, regardless of how many owner
    // closures it fans to; each of those closures counts as a sync RPC.
    structure?.countReconstruction();
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
    // Client-shell phase i: refresh by OBJECTS too, not bare keys. A
    // mismatch naming a cell of an object the view never materialized
    // (a room's exit read as class-default absence by a sparse plan)
    // would otherwise install just the named cells — no lineage — and
    // the re-plan's obj-ref expansion still could not seed the object,
    // looping the mismatch to the budget. The objects-mode closure
    // materializes each named object whole (chain + cells), so the
    // re-plan reads real values.
    //
    // NC8b: independent owner closures fetch in PARALLEL (one depth
    // step); installs run AFTER all resolve, serially inside the
    // transaction — a rejected group installs nothing.
    const destinations = [...byDestination.entries()];
    const fetchOne = ([destination, want]: [string, string[]]) => {
      const objects = [...new Set(want.filter((key) => !key.startsWith("session:")).map((key) => objectOfCellKey(key)))];
      return this.host.rpc(destination, "/closure", { keys: want, known, objects }) as Promise<CellTransfer>;
    };
    const transfers = structure
      ? await structure.rpcGroup(destinations.map((entry) => () => fetchOne(entry)), { phase: "refresh_known" })
      : await Promise.all(destinations.map(fetchOne));
    destinations.forEach(([, want], index) => {
      const transfer = transfers[index];
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
    });
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
      // Candidates probe SERIALLY by design — order encodes likelihood
      // (actor's room first) and a hit stops the cascade; parallel
      // probing would pay every candidate every time.
      for (const destination of [...new Set(candidates)]) {
        if (satisfied) break;
        try {
          // Objects mode here too (phase i): a convention hit must
          // materialize the object whole, not just the named keys.
          const transfer = (await timedRpc(
            structure,
            () => this.host.rpc(destination, "/closure", { keys: want, known, objects: [object] }),
            { phase: "refresh_unknown" }
          )) as CellTransfer;
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
        } catch (err) {
          // NC8b: a budget refusal is the TURN's verdict, not a probe miss.
          if (isNetError(err) && err.code === "E_BUDGET") throw err;
          // A candidate that is not a real scope (no durable state)
          // refuses — expected for convention probes; try the next.
        }
      }
    }
  }

  /** Full-closure install from the scope — the CO8 named reseed and the
   * /net/pull live path share this. */
  /**
   * Phase 4 targeted warming: pull ONLY the named objects' cells (each
   * with its class chain, expanded at the authority) plus the scope's
   * relation rows, and advance the fanout high-water to the returned
   * head. Advancing is safe for the same reason the full pull's fix-7
   * advance is: the relation mirror is coherent at that head (the rows
   * rode along), and a cell this pull did not carry is ABSENT from the
   * view — absent is never stale; pull-on-miss and read-version checks
   * own it. This is the client cold-open path: its cost tracks what the
   * session needs (objects' chains + roster), never the scope's size —
   * the Phase-0 `closure` invariant. Empty `objects` = roster-only
   * backfill (the selfSubscribe case).
   */
  private async pullTargeted(scope: string, destination: string, objects: string[]): Promise<void> {
    const transfer = await this.fetchTargeted(scope, destination, objects, true);
    this.installTargeted(transfer, true);
  }

  /** Fetch half of a targeted pull. Kept separate so independent sparse
   * presentation-owner probes can overlap, then install only after the whole
   * phase settles (no partially-mutated view when one peer RPC rejects). */
  private async fetchTargeted(
    _scope: string,
    destination: string,
    objects: string[],
    relations: boolean
  ): Promise<CellTransfer & { scope: string; head: ScopeHead; relations?: RelationRow[] }> {
    return (await this.host.rpc(destination, "/closure", {
      keys: [],
      known: [],
      objects,
      relations
    })) as CellTransfer & { scope: string; head: ScopeHead; relations?: RelationRow[] };
  }

  /** Install half of a targeted pull. Presentation-only object probes do not
   * request relation rows and therefore must not advance the scope high-water:
   * doing so could suppress a later subscribed relation backfill. */
  private installTargeted(
    transfer: CellTransfer & { scope: string; head: ScopeHead; relations?: RelationRow[] },
    advanceSeen: boolean
  ): void {
    const view = this.ensureView();
    this.discardViewOnThrow(() =>
      this.state.storage.transactionSync(() => {
        for (const cell of transfer.cells) {
          this.invalidateRoomPresentationActor(cell);
          view.install(cell);
          this.persistCell(view, cell.key);
        }
        for (const row of transfer.relations ?? []) {
          this.applyRelationDelta({ op: "add", row });
        }
        if (advanceSeen) this.advanceSeen(transfer.scope, transfer.head.seq);
      })
    );
  }

  private async reseedFromScope(
    view: CellStore,
    destination: string,
    known: string[] = [],
    structure?: TurnStructure
  ): Promise<CellTransfer & { scope: string; head: ScopeHead; catalog_epoch: string; relations?: RelationRow[] }> {
    // D2: a full reseed is an authority reconstruction and one sync RPC on
    // the turn path (the /net/pull live path passes no structure, unchanged).
    structure?.countReconstruction();
    const transfer = (await timedRpc(structure, () => this.host.rpc(destination, "/closure", { keys: ["*"], known }), { phase: "reseed" })) as CellTransfer & {
      scope: string;
      head: ScopeHead;
      catalog_epoch: string;
      relations?: RelationRow[];
    };
    this.discardViewOnThrow(() =>
      this.state.storage.transactionSync(() => {
        // `known` makes the transfer partial: absence then means "receiver
        // already knows it", not authoritative deletion. Exact catalog
        // cleanup is safe only for an unfiltered full closure.
        if (known.length === 0) this.removeAbsentCatalogDefinitions(view, transfer.scope, transfer.cells);
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

  /** A full catalog closure is authoritative for the complete bootstrap
   * definition set, not merely an upsert batch. Remove verb and property-
   * catalog-scoped definition pages absent from that closure before installing
   * it so an aged/offline gateway cannot resurrect a retired v1 definition
   * after missing the ordered removal fanout. Runtime-authored definitions on
   * ordinary objects are not members of the catalog image and retain their
   * existing upsert posture. */
  private removeAbsentCatalogDefinitions(view: CellStore, scope: string, cells: readonly Cell[]): void {
    if (scope !== CATALOG_SCOPE) return;
    const isDefinition = (cell: Cell): boolean => {
      if (cell.kind === "verb_bytecode") return true;
      if (cell.kind !== "property_cell" || !cell.value || typeof cell.value !== "object" || Array.isArray(cell.value)) {
        return false;
      }
      const def = (cell.value as { def?: unknown }).def;
      return Boolean(def && typeof def === "object" && !Array.isArray(def));
    };
    const present = new Set(cells.filter(isDefinition).map((cell) => cell.key));
    for (const key of [...view.keys()]) {
      const local = view.get(key);
      if (!local || !local.object.startsWith("$") || !isDefinition(local) || present.has(key)) continue;
      view.delete(key);
      this.persistCell(view, key);
    }
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
    // Delivery continuity is per subscriber lane, not per authority head:
    // an authority event can validly produce no row for this destination.
    // Unstamped bodies are accepted for rolling-upgrade compatibility.
    const lastDelivery = this.deliverySeen.get(body.scope) ?? 0;
    if (body.delivery_seq !== undefined && body.delivery_seq > lastDelivery + 1) {
      this.metric({
        kind: "net_fanout_gap",
        scope: body.scope,
        status: "error",
        error: "E_FANOUT_GAP",
        expected: lastDelivery + 1,
        got: body.delivery_seq,
        reason: `authority_seq:${body.seq}`
      });
    }
    const applied = this.discardViewOnThrow(() =>
      this.state.storage.transactionSync(() => {
        const advanced = applyFanout(view, this.seen, body);
        if (body.delivery_seq !== undefined && body.delivery_seq > lastDelivery) {
          this.deliverySeen.set(body.scope, body.delivery_seq);
        }
        if (advanced) {
          for (const cell of body.cells) {
            this.invalidateRoomPresentationActor(cell);
            this.persistCell(view, cell.key);
          }
          for (const key of body.removed_cells ?? []) {
            this.invalidateRoomPresentationActorKey(key);
            this.persistCell(view, key);
          }
          // CO13: relation deltas ride the same body and the same seq
          // gate — a redelivered body no-ops above (applyFanout), so the
          // mirror never double-applies. applyFanout itself stays
          // cell-only (relation rows are not cells); the shell owns the
          // mirror table.
          for (const delta of body.relations ?? []) this.applyRelationDelta(delta);
        }
        // A pull may already have superseded this row's authority state,
        // but receiving it still advances outbox continuity. Persist both
        // high-waters together so a crash cannot manufacture a later gap.
        this.state.storage.sql.exec(
          "INSERT INTO net_gateway_scope (scope, seen_seq, delivery_seen_seq) VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET seen_seq = MAX(seen_seq, excluded.seen_seq), delivery_seen_seq = MAX(delivery_seen_seq, excluded.delivery_seen_seq)",
          body.scope,
          this.seen.get(body.scope) ?? 0,
          this.deliverySeen.get(body.scope) ?? 0
        );
        return advanced;
      })
    );
    // Observation push (item 3 chunk 2) AFTER the mirror application, so
    // a presence transition riding this very body shapes its own
    // audience (an enter's add is visible; a leave's remove already
    // excludes the leaver). The seq gate above makes the push
    // at-most-once per socket per turn: redeliveries never reach here.
    if (applied) {
      // Descriptor freshness follows the same committed/fanout-coherent view
      // as invocation. Run before observation delivery so a movement's new
      // presence row can notify its own session even when echo dedupe suppresses
      // that session's observation frame.
      this.mcpRefreshToolListHints(body);
      this.pushObservations(body);
    }
    return applied;
  }

  /** One relation delta into the mirror table (add = upsert, remove =
   * delete; both idempotent, matching applyRelationDeltas' semantics at
   * the owning scope). */
  private applyRelationDelta(delta: RelationDelta): void {
    const key = relationKey(delta.row.relation, delta.row.owner, delta.row.member);
    if (delta.op === "add") {
      this.state.storage.sql.exec(
        "INSERT INTO net_gateway_relation (key, relation, owner, member, body, owner_scope, member_scope) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body, owner_scope = excluded.owner_scope, member_scope = excluded.member_scope",
        key,
        delta.row.relation,
        delta.row.owner,
        delta.row.member,
        delta.row.body !== undefined ? JSON.stringify(delta.row.body) : null,
        this.ownerScopeFor(delta.row.owner),
        delta.row.member_scope ?? null
      );
    } else {
      this.state.storage.sql.exec("DELETE FROM net_gateway_relation WHERE key = ?", key);
    }
  }

  /** Phase 2: the scope a relation owner belongs to, computed ONCE at write
   * time (the presence fanout then filters on it, O(occupants), instead of
   * classifying every session_presence row per fanout). The CO15
   * view-lineage classifier, with the `room:<owner>` naming convention as
   * the fallback for an owner whose lineage this view has not pulled — the
   * same owner→scope rule the fanout scan used inline. For a presence
   * owner (a $space) both coincide, so the stored value is stable across a
   * later lineage pull. */
  private ownerScopeFor(owner: string): string {
    const view = this.ensureView();
    const classifier = classifierFromLineage(
      (object) => (view.get(cellKey("object_lineage", object))?.value as AnchorLineage | undefined) ?? null
    );
    try {
      return classifier.scopeOf(owner);
    } catch {
      return `room:${owner}`;
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
      this.deliverySeen.clear();
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
    for (const row of sqlRows<{ scope: string; seen_seq: number; delivery_seen_seq: number } & ScopeRow>(
      this.state.storage.sql.exec("SELECT scope, seen_seq, delivery_seen_seq FROM net_gateway_scope")
    )) {
      this.seen.set(row.scope, row.seen_seq);
      this.deliverySeen.set(row.scope, row.delivery_seen_seq);
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

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** MCP adapter bounds (client-shell phase i). */
const MCP_QUEUE_CAP = 256;
const MCP_SESSION_STATE_CAP = 512;
const MCP_STANDARD_TOOL_PAGE = 128;
const MCP_DISCOVERY_DEFAULT_PAGE = 64;
const MCP_DISCOVERY_MAX_PAGE = 256;
const MCP_CONTEXT_WARM_FAILURE_CAP = 512;
const MCP_CONTEXT_WARM_SUCCESS_CAP = 512;
const MCP_SSE_LISTEN_MS = 25_000;
const MCP_SSE_CONNECTED = new TextEncoder().encode("retry: 1000\n\n");
const MCP_LIST_CHANGED_NOTIFICATION = {
  jsonrpc: "2.0",
  method: "notifications/tools/list_changed"
} as const;

type NetMcpSseWaiter = {
  deliver(message: unknown): boolean;
  close(): void;
};

type NetMcpSessionState = {
  actor: string;
  buffer: unknown[];
  waiters: Array<() => void>;
  ownEchoIds: Set<string>;
  toolListDigest: string | null;
  listChangedDirty: boolean;
  listChangedPending: boolean;
  sseWaiters: NetMcpSseWaiter[];
};

function mcpSessionState(actor: string): NetMcpSessionState {
  return {
    actor,
    buffer: [],
    waiters: [],
    ownEchoIds: new Set(),
    toolListDigest: null,
    listChangedDirty: false,
    listChangedPending: false,
    sseWaiters: []
  };
}

function mcpSseMessage(message: unknown): Uint8Array {
  return new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
}

/** Streamable HTTP accepts headless clients without an Origin header. Browser
 * requests do carry one, and must be same-origin to prevent a hostile page
 * from using a locally reachable MCP server as a DNS-rebinding target. */
function rejectForeignMcpOrigin(request: Request, target: URL): Response | null {
  const raw = request.headers.get("origin");
  if (raw === null) return null;
  try {
    if (new URL(raw).origin === target.origin) return null;
  } catch {
    // Malformed and opaque origins are not a trustworthy same-origin claim.
  }
  return json({ error: { code: "E_PERM", message: "foreign MCP Origin is not allowed" } }, 403);
}

type NetMcpToolScope = "active" | "here" | "object" | "space" | "all";

type NetMcpToolDraft = {
  object: string;
  verb: string;
  aliases: string[];
  description: string;
  inputSchema: Record<string, unknown>;
  argNames: string[];
};

type NetMcpDynamicTool = NetMcpToolDraft & { name: string };

type NetMcpToolPage = {
  scope: NetMcpToolScope;
  object: string | null;
  query: string | null;
  limit: number;
  cursor: string | null;
  nextCursor: string | null;
  total: number;
  tools: NetMcpDynamicTool[];
};

function mcpRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mcpToolScope(value: unknown): NetMcpToolScope {
  if (value === undefined || value === null || value === "") return "active";
  if (value === "active" || value === "here" || value === "object" || value === "space" || value === "all") return value;
  throw new Error("scope must be one of active, here, object, space, all");
}

function mcpLimit(value: unknown, fallback: number, cap: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), cap);
}

function mcpCursor(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value !== "string" && typeof value !== "number") return 0;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function mcpSanitizeId(value: string): string {
  return value.replace(/^\$/, "").replace(/[^a-zA-Z0-9_]/g, "_");
}

function mcpFirstParagraph(source: string): string {
  const block = /\/\*([\s\S]*?)\*\//.exec(source);
  if (block) return block[1].split(/\n\s*\n/)[0].replace(/^\s*\*?\s?/gm, "").trim();
  const line = /^\s*\/\/\s?(.*)$/m.exec(source);
  return line?.[1]?.trim() ?? "";
}

function mcpInputSchema(argSpec: Record<string, unknown>): { schema: Record<string, unknown>; args: string[] } {
  const raw = Array.isArray(argSpec.args) ? argSpec.args : Array.isArray(argSpec.params) ? argSpec.params : [];
  const declarations = raw.filter((value): value is string => typeof value === "string");
  const types = mcpRecord(argSpec.types);
  const command = mcpRecord(argSpec.command);
  const argumentSources = Array.isArray(command.args_from)
    ? command.args_from.filter((value): value is string => typeof value === "string")
    : [];
  const args: string[] = [];
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [index, declaration] of declarations.entries()) {
    const optional = declaration.endsWith("?");
    const name = optional ? declaration.slice(0, -1) : declaration;
    if (!name) continue;
    args.push(name);
    const explicitHint = typeof types[name] === "string" ? types[name] as string : "";
    properties[name] = explicitHint
      ? mcpSchemaForHint(explicitHint)
      : mcpSchemaForCommandSource(argumentSources[index]);
    if (!optional) required.push(name);
  }
  return {
    args,
    schema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {})
    }
  };
}

/** Command parsing metadata is also useful schema metadata. These sources
 * have stable runtime shapes (MA4.1), so preserve them when a catalog has not
 * supplied the optional `arg_spec.types` extension. */
function mcpSchemaForCommandSource(source: string | undefined): Record<string, unknown> {
  if (!source) return {};
  if (["text", "verb", "argstr", "prep", "dobjstr", "dobj_prefix_rest", "iobjstr"].includes(source)) {
    return { type: "string" };
  }
  if (["dobj", "dobj_prefix", "iobj"].includes(source)) return { type: "string" };
  if (source === "cmd") return { type: "object" };
  return {};
}

function mcpSchemaForHint(raw: string): Record<string, unknown> {
  const hint = raw.trim().toLowerCase();
  if (!hint) return {};
  if (hint.includes("|")) return { anyOf: hint.split("|").map((part) => mcpSchemaForHint(part)) };
  if (hint.startsWith("list")) return { type: "array", items: {} };
  if (hint === "int" || hint === "integer") return { type: "integer" };
  if (hint === "num" || hint === "number" || hint === "float") return { type: "number" };
  if (hint === "bool" || hint === "boolean") return { type: "boolean" };
  if (hint === "map" || hint === "object") return { type: "object" };
  if (hint === "str" || hint === "string" || hint === "obj") return { type: "string" };
  if (hint === "null") return { type: "null" };
  return {};
}

function mcpNamedArgs(tool: NetMcpDynamicTool, values: Record<string, unknown>): unknown[] {
  return tool.argNames.map((name) => values[name] ?? null);
}

function mcpProtocolTool(tool: NetMcpDynamicTool): { name: string; description: string; inputSchema: Record<string, unknown> } {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

function mcpToolSummary(tool: NetMcpDynamicTool, includeSchema: boolean): Record<string, unknown> {
  return {
    name: tool.name,
    object: tool.object,
    verb: tool.verb,
    aliases: tool.aliases,
    args: tool.argNames,
    description: tool.description,
    ...(includeSchema ? { input_schema: tool.inputSchema } : {})
  };
}

/** The tool set the walkthrough's client contract uses — an ENVELOPE
 * around the net client surface, never a second path. */
const MCP_TOOL_DEFS = [
  {
    name: "woo_call",
    description: "Call a verb on an object as the session's actor.",
    inputSchema: {
      type: "object",
      properties: { object: { type: "string" }, verb: { type: "string" }, args: { type: "array" } },
      required: ["object", "verb"]
    }
  },
  {
    name: "woo_wait",
    description: "Long-poll the session's observation queue.",
    inputSchema: { type: "object", properties: { timeout_ms: { type: "number" }, limit: { type: "number" } } }
  },
  {
    name: "woo_list_reachable_tools",
    description: "Page and filter dynamic tools in the session's structural context.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["active", "here", "object", "space", "all"] },
        object: { type: "string" },
        query: { type: "string" },
        limit: { type: "number" },
        cursor: { type: "string" },
        include_schema: { type: "boolean" }
      }
    }
  }
] as const;
